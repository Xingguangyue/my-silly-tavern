const STORE_KEY = 'tavern.db.v1';
const DB = {
  sessions: [],                 //  有哪些窗口 [{id, name, createdAt}]
  messages: {},                 // 历史聊天记录 { sessionId: [消息对象, ...] }
  worldbook: { entries: [] },   // 世界书
  config: {
    apiBase: 'https://gcli.ggchan.dev/v1',  // OpenAI 兼容地址
    apiKey: '',
    model: 'gpt-4o-mini',
    stream: true,        // 流式输出
    mock: false,         // 模拟回复
    proxy: false,        
    depth: 3,            // 世界书扫描深度 N
    ctxLimit: 8000       // 上下文上限
  }
};

// 界面状态
let currentSessionId = null;  // 当前窗口的编号
let showHidden = false;       // 「显示已隐藏」开关
let inFlight = null;          // 正在生成的请求 {sid, msgId, controller}
let lastPreview = null;       // 快照

// 存储模块
function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(DB)); //转成字符串然后DB传入localstorage
}

// 加载模块
function load() {
  const raw = localStorage.getItem(STORE_KEY); //获取localstorage中的值
  if (raw) {
    try { //防崩溃
      const data = JSON.parse(raw); //翻译回json格式
      // 传回DB
      DB.sessions  = data.sessions  || []; 
      DB.messages  = data.messages  || {}; 
      DB.worldbook = data.worldbook || { entries: [] };
      // 新旧配置合并
      DB.config = Object.assign({}, DB.config, data.config || {});
    } catch (error) {
      console.error('sorry,存档损坏', error);
    }
  }


// 完善加载模块：防止中途退出session
  markInterrupted();

  if (!DB.sessions.length) createSession('新会话');
  if (!currentSessionId) currentSessionId = DB.sessions[0].id;
}

function markInterrupted() {
  let n = 0;
  for (const sid in DB.messages) {
    for (const m of DB.messages[sid]) {
      if (!m.complete) { m.complete = true; m.interrupted = true; n++; }
    }
  }
  if (n) { save(); console.log('已把 ' + n + ' 条未完成的生成标记为「已中断」'); }
}

// 1.======================================================
//创建uid
let uidCounter = 0;
function uid(prefix) {
  uidCounter++;
  return prefix + '_' + Date.now().toString(36) + '_' + uidCounter +
         Math.random().toString(36).slice(2, 5);
}

//初始化session
function msgs(sid) {
  if (!DB.messages[sid]) DB.messages[sid] = [];
  return DB.messages[sid];
}

// 找指定session
function findMsg(msgId) {
  for (const sid in DB.messages) {
    const m = DB.messages[sid].find(x => x.id === msgId);
    if (m) return m;
  }
  return null;
}

// 抓取选择器
function $(sel) { return document.querySelector(sel); }



//  2. 会话的增删改查 ============================================================ 

//创建新session
function createSession(name) {
  const s = { id: uid('session'), name: (name || '未命名会话'), createdAt: Date.now() };
  DB.sessions.push(s);
  // 角色开场白（题目 Level 1 明写要求「展示角色开场白」）
  DB.messages[s.id] = [{
    id: uid('m'), role: 'assistant',
    content: '（开场白）你好，我是这里的角色。想聊点什么？',
    createdAt: Date.now(),
    hidden: false, excluded: false, complete: true, interrupted: false
  }];
  currentSessionId = s.id;
  save(); renderAll();
  return s;
}

//切换session
function switchSession(sid) {
  currentSessionId = sid;
  renderAll();
}

//重命名
function renameSession(sid) {
  const s = DB.sessions.find(x => x.id === sid);
  if (!s) return;
  const n = prompt('重命名会话：', s.name);
  if (n && n.trim()) { s.name = n.trim(); save(); renderAll(); }
}

//删除session
function deleteSession(sid) {
  if (!confirm('删除这个会话？消息会一起删掉，不可恢复。')) return;
  DB.sessions = DB.sessions.filter(x => x.id !== sid);
  delete DB.messages[sid];
  if (currentSessionId === sid) {
    currentSessionId = DB.sessions.length ? DB.sessions[0].id : null;
    if (!currentSessionId) createSession('新会话');
  }
  save(); renderAll();
}



// 3. 消息的三个操作 =======================================================

function toggleHidden(msgId) {
  const m = findMsg(msgId); if (!m) return;
  m.hidden = !m.hidden;
  save(); //一会再补
}

function toggleExcluded(msgId) {
  const m = findMsg(msgId); if (!m) return;
  m.excluded = !m.excluded;
  save(); //一会再补
}

function removeMessage(msgId) {
  const sid = currentSessionId;
  if (!confirm('删除这条消息？不可恢复。')) return;
  DB.messages[sid] = msgs(sid).filter(m => m.id !== msgId);
  save();//一会再补
}

// 批量：把「最近 keep 条」之前的所有消息都设为不进上下文。
// 这就是上下文快满时提示里那个「可处理的消息入口」。
function batchExcludeOlder(keep) {
  const sid = currentSessionId;
  const list = msgs(sid);
  const cut = Math.max(0, list.length - keep);
  let n = 0;
  for (let i = 0; i < cut; i++) {
    if (!list[i].excluded) { list[i].excluded = true; n++; }
  }
  save(); //一会再补
  alert('已把 ' + n + ' 条较早的消息从上下文中移除');
}



// 4. 上下文 ==========================================================================


// 判断是否参与上下文
function isInContext(m) {
  if (m.excluded) return false;   // 用户显式排除
  if (!m.complete) return false;  // 未完成的默认不进上下文
  return true;
}

// 未发送原因的枚举 —— 题目要求预览能回答「某条内容为什么没有发送」
const REASON_TEXT = {
  excluded:   '已被设为「不发送」',
  incomplete: '生成未完成',
  empty:      '内容为空'
};

/**
 * 构造这次请求要发的内容，同时生成一份「请求快照」。
 * 快照是发出去那一刻的事实，之后改历史消息也不会改写它。
 */
function buildRequest(sid, extraText) {
  const list = msgs(sid);
  const sent = [];      // 会被发送的消息
  const notSent = [];   // 不会被发送的消息 + 原因

  for (const m of list) {
    if (m.excluded)   { notSent.push({ id: m.id, role: m.role, reason: 'excluded' });   continue; }
    if (!m.complete)  { notSent.push({ id: m.id, role: m.role, reason: 'incomplete' }); continue; }
    if (!m.content)   { notSent.push({ id: m.id, role: m.role, reason: 'empty' });      continue; }
    sent.push({ id: m.id, role: m.role, content: m.content, hidden: !!m.hidden });
  }

  // 世界书候选（详见第 5 节）
  const hits = matchWorldbook(sid, extraText);

  // ⚠️ 注意看顺序：世界书在前（作为 system），历史消息在后
  const finalMessages = [];
  for (const h of hits) {
    finalMessages.push({ role: 'system', content: '【' + h.entry.name + '】\n' + h.entry.content });
  }
  for (const s of sent) {
    finalMessages.push({ role: s.role, content: s.content });
  }

  // 「按发送顺序」的来源清单，给预览面板用
  const parts = [];
  for (const h of hits) {
    parts.push({
      kind: 'worldbook',
      label: '世界书：' + h.entry.name,
      which: h.keyword ? ('命中关键词「' + h.keyword + '」') : '常驻条目，直接入选',
      content: h.entry.content
    });
  }
  for (const s of sent) {
    parts.push({
      kind: 'message',
      label: (s.role === 'user' ? '用户消息' : 'AI 消息') + ' · ' + s.id.slice(-6),
      which: s.hidden ? '已发送（界面已隐藏，但 AI 仍能读到）' : '已发送',
      content: s.content
    });
  }

  const used = estimateTokens(finalMessages);
  const snapshot = {
    sessionId: sid,
    createdAt: Date.now(),
    parts: parts,
    notSent: notSent,
    mode: parts.length ? '正常发送' : '无内容可发',
    usage: used,
    limit: DB.config.ctxLimit,
    depth: DB.config.depth
  };

  return { finalMessages, snapshot };
}

// 5. 世界书匹配=========================================================

function matchWorldbook(sid, extraText) {
  const depth = Math.max(0, Number(DB.config.depth) || 0); //防止depth为0

  // 规则 1：扫描范围 = 最近 N 条符合条件的消息+本次待发送的消息
  let scanPool = msgs(sid).filter(isInContext); //扫描时只考虑上下文中的
  scanPool = scanPool.slice(-depth);
  if (extraText) { //本次待发送的消息
    scanPool = scanPool.concat([{ id: '__pending__', content: extraText }]);
  }

  const hits = [];//命中的条目
  const usedIds = new Set();  // 储存命中过的条目，避免重复加入hits。规则 5：同一个条目最多插入一次

  for (const e of DB.worldbook.entries) { // 遍历世界数中的元素

    // 规则 3：禁用的条目 始终排除
    if (!e.enabled) continue;

    // 规则 3：常驻的条目 直接加入到hits中，不需要关键词触发
    if (e.constant) {
      if (!usedIds.has(e.id)) {
        usedIds.add(e.id);
        hits.push({ entry: e, keyword: null, fromId: null });
      }
      continue;
    }

    // 规则 2：在单条消息正文内进行关键词包含匹配；任意关键词命中即可成为候选，不跨消息拼接匹配。
    let found = null;
    for (const m of scanPool) { // 在扫描池中再进行遍历，找包含世界树元素的语句
      const kw = (e.keywords || []).find(k => k && m.content.includes(k));
      if (kw) { found = { keyword: kw, fromId: m.id }; break; }
    }

    // 规则 4：不递归扫描世界书正文，也不扫描角色设定和提示词模块。
    //         ↑ 上面只碰了 m.content（消息正文），从没碰过 e.content，这就是规则 4。

    if (found && !usedIds.has(e.id)) { //如果找到关键词而且没被命中过
      usedIds.add(e.id);
      hits.push({ entry: e, keyword: found.keyword, fromId: found.fromId });
    }
  }

  // 规则 5：候选按优先级从高到低处理；优先级相同时按 ASCII ID 升序
  hits.sort((a, b) => {
    if (b.entry.priority !== a.entry.priority) return b.entry.priority - a.entry.priority;
    if (a.entry.id < b.entry.id) return -1;   // 条目 ID 用 wb_001 这种零填充形式，
    if (a.entry.id > b.entry.id) return 1;    // 这样字符串比较就等于 ASCII 升序
    return 0;
  });

  return hits;
}