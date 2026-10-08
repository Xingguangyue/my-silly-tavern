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



