const STORE_KEY = 'tavern.db.v1';
const DB = {
  sessions: [],                 //  有哪些窗口 [{id, name, createdAt}]
  messages: {},                 // 历史聊天记录 { sessionId: [消息对象, ...] }
  worldbook: { entries: [] },   // 世界书
  presets: [],                  // 提示词预设（等级3）—— 一组提示词模块
  activePresetId: null,         // 当前在用哪个预设
  card: null,                   // 当前导入的角色卡（等级3），null = 还没有
  // ⭐ 已发送的请求快照。题目第 986 行：「修改历史消息会影响后续请求，
  //    但不能改写已经发出的请求快照。」所以这个数组只增不改 ——
  //    全项目只有 generate() 里那一处会 push，别的地方一律不许动它。
  snapshots: [],
  config: {
    apiBase: 'https://gcli.ggchan.dev/v1',  // OpenAI 兼容地址
    apiKey: '',
    model: 'gemini-3.8-flash',
    stream: true,        // 流式输出
    mock: true,          // 模拟回复（默认开着，先保证不联网也能演示）
    proxy: false,        // 走本地 serve.py 代理（遇到 CORS 时勾上）
    depth: 3,            // 世界书扫描深度 N
    ctxLimit: 8000       // 上下文上限
  }
};

// 界面状态
let currentSessionId = null;  // 当前窗口的编号
let showHidden = false;       // 「显示已隐藏」开关
let inFlight = null;          // 正在生成的请求 {sid, msgId, controller}
let mockRound = 0;            // 模拟回复的轮次（用来轮流演示正常/损坏的面板）
// 注意：这里【没有】「当前预览」这种变量 —— 发送前预览是每次现算的（见 renderPreview），
//       「已发送的快照」则存在 DB.snapshots 里只增不改。两者刻意分开，见题目第 986 行。

/* 存储模块
 *
 * ⚠️ localStorage 不是永远可用：无痕模式、某些浏览器打开 file:// 时、
 *    或者用户在浏览器设置里禁用了网站数据 —— 访问它都会【直接抛异常】。
 *
 * 而 save() 在 load() → createSession() 这条启动链上，一抛异常就是【整个页面白屏】。
 * 别人的电脑上什么情况都有，所以这里必须兜住：
 * 存不上最多是「刷新后数据没了」，但页面一定要能跑起来。
 */
let storageOK = true;

function save() {
  if (!storageOK) return;                 // 已经知道用不了，就别每次都抛一次
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(DB)); //转成字符串然后DB传入localstorage
  } catch (e) {
    storageOK = false;
    console.warn('localStorage 用不了，改成只在内存里跑（刷新会丢数据）：', e && e.message);
  }
}

// 加载模块
function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORE_KEY); //获取localstorage中的值
  } catch (e) {
    storageOK = false;
    console.warn('localStorage 用不了，从空数据开始跑：', e && e.message);
  }
  if (raw) {
    try { //防崩溃
      const data = JSON.parse(raw); //翻译回json格式
      // 传回DB
      DB.sessions  = data.sessions  || []; 
      DB.messages  = data.messages  || {}; 
      DB.worldbook = data.worldbook || { entries: [] };
      // 等级3：预设和角色卡也要一起恢复，否则刷新后设置面板是空的
      DB.presets        = data.presets        || [];
      DB.activePresetId = data.activePresetId || null;
      DB.card           = data.card           || null;
      DB.snapshots      = data.snapshots      || [];   // 已发送的快照，刷新也要留着
      // 新旧配置合并
      DB.config = Object.assign({}, DB.config, data.config || {});
    } catch (error) {
      console.error('sorry,存档损坏', error);
    }
  }

  // 至少要有一个预设，否则 buildRequest 里那段就是空的（等级3）
  if (!DB.presets.length) DB.presets = [defaultPreset()];
  if (!DB.activePresetId || !DB.presets.some(p => p.id === DB.activePresetId)) {
    DB.activePresetId = DB.presets[0].id;
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
  // ⭐ 等级 3：导入过角色卡时，新会话默认用【角色名】和【角色卡的开场白】
  const card = DB.card;

  const s = {
    id: uid('session'),
    name: name || (card && card.name) || '未命名会话',
    createdAt: Date.now()
  };
  DB.sessions.push(s);

  // 角色开场白（题目 Level 1 明写要求「展示角色开场白」）
  DB.messages[s.id] = [{
    id: uid('m'),
    sessionId: s.id,   // ⭐ 必须有：选项按钮靠它判断「这条消息属于哪个会话」
    role: 'assistant',
    content: (card && card.firstMes) || '（开场白）你好，我是这里的角色。想聊点什么？',
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
//
// ⚠️ 这三个函数都必须「改完数据 + 重新渲染」，缺重画的话界面上什么都不变，
//    用户会以为按钮坏了。而且预览面板也要跟着变 —— 因为这三个操作
//    对「这次要发什么」的影响各不相同：
//      hidden   → 预览里出现，但标注「已隐藏（AI 仍能读到）」
//      excluded → 从「发送列表」挪到「没有发送的内容」，并写明原因

function toggleHidden(msgId) {
  const m = findMsg(msgId); if (!m) return;
  m.hidden = !m.hidden;
  save();
  renderMessages();          // 勾了框才显示／不勾就消失，都靠这一句
  refreshPreview();     // 它在预览里的说明文字要跟着变
}

function toggleExcluded(msgId) {
  const m = findMsg(msgId); if (!m) return;
  m.excluded = !m.excluded;
  save();
  renderMessages();          // 红色边框 / 「不发送」标签要靠这一句
  refreshPreview();     // 它会从发送列表挪到「没有发送的内容」
}

function removeMessage(msgId) {
  const sid = currentSessionId;
  if (!confirm('删除这条消息？不可恢复。')) return;
  DB.messages[sid] = msgs(sid).filter(m => m.id !== msgId);
  save();
  renderAll();               // 消息数变了，左栏会话后面那个计数也要跟着变
  refreshPreview();
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
  save();
  renderAll();
  refreshPreview();     // 先重画再弹提示，关掉提示时界面已经是新的了
  alert('已把 ' + n + ' 条较早的消息从上下文中移除');
}



// 4. 上下文 ==========================================================================


// 判断是否参与上下文
function isInContext(m) {
  if (m.excluded) return false;   // 用户显式排除
  if (!m.complete) return false;  // 未完成的默认不进上下文
  return true;
}

// 未发送原因的枚举。
// 题目第 24 页要求预览能回答「某条内容为什么没有发送：
// 禁用、未命中、未完成、关闭上下文，还是什么别的原因」——
// 注意「禁用」和「未命中」说的是【世界书条目】，不只是消息，所以下面五条都要有。
const REASON_TEXT = {
  excluded:    '已被设为「不发送」',
  incomplete:  '生成未完成',
  empty:       '内容为空',
  wb_disabled: '世界书条目已禁用：始终排除',
  wb_nomatch:  '关键词未命中：没出现在被扫描的那几条消息里'
};

/**
 * 构造这次请求要发的内容，同时生成一份「请求快照」。
 *
 * 注意「快照」和「预览」是两个东西：
 *   · 这个函数返回的 snapshot 是【发出去那一刻】的事实，
 *     由 generate() 存进 DB.snapshots 之后就不再改写；
 *   · 界面上那个「发送前预览」是每次现算的，所以会随着你改消息而变化。
 * 题目第 986 行明写「修改历史消息会影响后续请求，但不能改写已经发出的请求快照」。
 */
function buildRequest(sid, extraText) {
  const list = msgs(sid);
  const sent = [];      // 会被发送的消息
  const notSent = [];   // 不会被发送的内容 + 原因

  // 统一的显示名：消息写「用户消息 · 3_x8k」，世界书条目写「世界书条目：柳洞寺」
  const msgLabel = (m) => (m.role === 'user' ? '用户消息' : 'AI 消息') + ' · ' + m.id.slice(-6);

  for (const m of list) {
    if (m.excluded)   { notSent.push({ id: m.id, reason: 'excluded',   label: msgLabel(m) }); continue; }
    if (!m.complete)  { notSent.push({ id: m.id, reason: 'incomplete', label: msgLabel(m) }); continue; }
    if (!m.content)   { notSent.push({ id: m.id, reason: 'empty',      label: msgLabel(m) }); continue; }
    sent.push({ id: m.id, role: m.role, content: m.content, hidden: !!m.hidden });
  }

  // 世界书候选（详见第 5 节）
  // 注意：matchWorldbook 只扫消息正文，所以下面第 ①② 段（预设、角色设定）
  //      不会被卷进关键词匹配 —— 这正是世界书规则 4「不递归扫描」的要求。
  const hits = matchWorldbook(sid, extraText);

  // ⭐ 没被选中的世界书条目也要给出原因。
  //    题目举的例子是「禁用、未命中、未完成、关闭上下文」——
  //    前两个说的就是这里。没有这一段，预览就只能回答消息为什么没发。
  const hitIds = new Set(hits.map(h => h.entry.id));
  for (const e of DB.worldbook.entries) {
    if (hitIds.has(e.id)) continue;      // 进了 hits 的会在「发送列表」里出现，不在这里重复
    notSent.push({
      id: e.id,
      reason: e.enabled ? 'wb_nomatch' : 'wb_disabled',
      label: '世界书条目：' + e.name
    });
  }

  /* ---------------------------------------------------------------
   * ⭐ 等级 3：请求内容的顺序 = ① 预设 → ② 角色设定 → ③ 世界书 → ④ 历史消息
   *
   * 前三段都是 system。system 越靠前，模型越把它当「设定」而不是「对话」，
   * 所以所有设定类内容必须排在真实聊天记录前面。
   * parts 数组和 finalMessages 严格同序 —— 预览面板要能回答
   * 「实际发送了哪些内容、顺序是什么、每段从哪来」。
   * --------------------------------------------------------------- */
  const finalMessages = [];
  const parts = [];     // 「按发送顺序」的来源清单，给预览面板用

  // ① 提示词预设：只取【启用】的模块，按 order 从小到大
  const preset = activePreset();
  const mods = preset
    ? preset.modules.filter(x => x.enabled).sort((a, b) => a.order - b.order)
    : [];
  for (const mod of mods) {
    finalMessages.push({ role: mod.role || 'system', content: mod.content });
    parts.push({
      kind: 'preset',
      label: '预设模块：' + mod.name,
      which: mod.id + '（顺序 ' + mod.order + '）',
      content: mod.content
    });
  }

  // ② 角色设定：角色卡的 description（导入过角色卡才有）
  if (DB.card && DB.card.description) {
    const cardText = '【角色设定·' + DB.card.name + '】\n' + DB.card.description;
    finalMessages.push({ role: 'system', content: cardText });
    parts.push({
      kind: 'card',
      label: '角色设定：' + DB.card.name,
      which: '导入的角色卡，取 data.description',
      content: cardText
    });
  }

  // ③ 世界书命中条目（详见第 5 节）
  for (const h of hits) {
    finalMessages.push({ role: 'system', content: '【' + h.entry.name + '】\n' + h.entry.content });
    parts.push({
      kind: 'worldbook',
      label: '世界书：' + h.entry.name,
      which: h.keyword ? ('命中关键词「' + h.keyword + '」') : '常驻条目，直接入选',
      content: h.entry.content
    });
  }

  // ④ 历史消息。注意：m.hidden 的照发不误 —— 界面隐藏 ≠ 不进上下文
  for (const s of sent) {
    finalMessages.push({ role: s.role, content: s.content });
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



// 6. 快满了 提醒 ==========================================================


function estimateTokens(messages) {
  let total = 0;
  for (const m of messages) {
    const t = m.content || '';

    // 估算规则（只是估算，不是真的分词器）：
    //   · 汉字和全角标点 → 大约 1 个字符算 1 个 token
    //   · 其余（英文、数字、半角符号）→ 大约 4 个字符算 1 个 token
    //   · 每条消息再固定加 4，当作 role、角色名这些固定开销
    // 正则三段分别是：\u4e00-\u9fff 汉字、\u3000-\u303f 日式标点、\uff00-\uffef 全角字符
    const cjk = (t.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
    total += cjk + Math.ceil((t.length - cjk) / 4) + 4;
  }
  return total;
}

// 7. 调模型 ==================================

async function streamChat(messages, onDelta, signal) {
  const cfg = DB.config;

  // ---- 模拟模式：不联网，用来演示界面、世界书逻辑和等级 3 的面板 ----
  if (cfg.mock) {
    mockRound++;
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const sysCount = messages.filter(m => m.role === 'system').length;

    let text = '（模拟回复）我收到了你的消息：「' +
      (lastUser ? lastUser.content.slice(0, 40) : '') +
      '」。\n\n' +
      '这次请求里有 ' + sysCount + ' 段 system 内容（预设模块 + 角色设定 + 世界书），' +
      '总共 ' + messages.length + ' 条内容会发给模型。\n\n';

    // ① 状态面板：模拟模型按「预设里的格式说明」输出
    //    ⚠️ location 故意用一个不含关键词的地名。如果这里写「柳洞寺」，
    //       它就会落进消息正文、被世界书扫到，演示「扫描深度」时会看不出变化。
    const hp = Math.max(1, 20 - (mockRound % 4) * 3);
    text += '<tavern-panel type="status">\n' +
      '{"hp":' + hp + ',"hpMax":20,"令咒":3,"location":"未名之地","回合":' + mockRound + '}\n' +
      '</tavern-panel>\n\n';

    // ② 选项面板
    text += '<tavern-panel type="choices">\n' +
      '{"options":[' +
        '{"label":"上前一步","text":"我向前一步，直视对方。"},' +
        '{"label":"后退观察","text":"我退后半步，先观察周围。"},' +
        '{"label":"开口询问","text":"「你为什么会在这里？」"}' +
      ']}\n</tavern-panel>';

    /* ③ 每 4 轮里有 3 轮额外吐一个「坏面板」，用来演示题目那三条硬要求：
     *    JSON 不合法 / 类型不支持 / 标签没闭合 → 都必须保留原文 + 说清问题。
     *    故意和正常面板放在同一条消息里，证明坏的那段不会连累好的那段。
     *    variant: 1=正常  2=JSON 坏  3=类型不支持  0=标签没闭合  */
    const variant = mockRound % 4;
    if (variant === 2) {
      text += '\n\n<tavern-panel type="status">\n{ "hp": 18, "location": }\n</tavern-panel>' +
        '\n\n（上面这一段是故意写坏的 JSON，用来演示解析失败时不会丢掉原文。）';
    } else if (variant === 3) {
      text += '\n\n<tavern-panel type="map">\n{"x":1,"y":2}\n</tavern-panel>' +
        '\n\n（上面这一段用了本应用不支持的 type="map"。）';
    } else if (variant === 0) {
      text += '\n\n<tavern-panel type="choices">\n{"options":[{"label":"这一段的结束标签被我忘了"}]}' +
        '\n\n（上面这一段没有闭合标签。）';
    }

    text += '\n\n（以上都是模拟回复的样子，用来演示流式输出。）';

    // 分块吐字：既看得见流式效果，又不用等太久
    const step = Math.max(1, Math.ceil(text.length / 240));
    for (let i = 0; i < text.length; i += step) {
      if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
      onDelta(text.slice(i, i + step));
      await new Promise(r => setTimeout(r, 10));
    }
    return;
  }

  if (!cfg.apiKey) throw new Error('还没填 API Key —— 去右边「设置」里填，或勾上「模拟回复」先演示界面。');

  // 两种情况：
  //   直连  → 浏览器直接请求模型服务。最简单，但服务端必须允许跨域(CORS)，
  //           否则浏览器会把响应拦掉（从 file:// 打开时 Origin 是 null，更容易被拒）。
  //   代理  → 先打本地 serve.py 的 /api/chat，由它转发。因为本地和页面同源，
  //           不存在跨域问题。真正的请求是 Python 发出去的，不看 CORS。
  const base = cfg.apiBase.replace(/\/+$/, '');
  const url = cfg.proxy ? '/api/chat' : (base + '/chat/completions');

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + cfg.apiKey
  };
  if (cfg.proxy) headers['X-Upstream-Base'] = base;   // 告诉代理要转发到哪

  const res = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      model: cfg.model,
      messages: messages,
      stream: !!cfg.stream
    }),
    signal: signal
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error('HTTP ' + res.status + ':' + body.slice(0, 300));
  }

  // ---- 非流式：一次性拿到全部内容 ----
  if (!cfg.stream) {
    const data = await res.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message
                  && data.choices[0].message.content) || '';
    onDelta(text);
    return;
  }

  // ---- 流式：逐块读 SSE ----
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });

    // 按行切，最后一行可能是不完整的 JSON，留在 buf 里等下一块
    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const j = JSON.parse(payload);
        const d = j.choices && j.choices[0] && j.choices[0].delta
                  && j.choices[0].delta.content;
        if (d) onDelta(d);
      } catch (e) {
        // 半截 JSON，忽略（下一轮会补全）
      }
    }
  }
}


/* ============================================================
 * 8. 发送 / 生成 / 重试 / 中止
 * ============================================================ */

async function sendMessage() {
  const sid = currentSessionId;
  const box = $('#input'); //存储文本框的内容
  const text = box.value.trim();
  if (!text) return;
  if (inFlight) { alert('还在生成中。先点「中止」，或等它结束。'); return; }

  // 插入用户消息。这一句只在「新发送」时执行，重试走不到这里 ——
  // 所以重试不会重复插入同一条用户消息（Level 1 要求）。
  msgs(sid).push({
    id: uid('m'), sessionId: sid, role: 'user', content: text, createdAt: Date.now(),
    hidden: false, excluded: false, complete: true, interrupted: false
  });
  box.value = '';
  save(); renderMessages(); scrollToBottom();

  await generate(sid);
}

// 「生成助手回复」。send 和 retry 都走这里。
async function generate(sid) {
  const { finalMessages, snapshot } = buildRequest(sid);

  /* ⭐ 发送后的请求快照 —— 全项目唯一往 DB.snapshots 里写的地方。
   *
   * 题目第 986 行：「修改历史消息会影响后续请求，但不能改写已经发出的请求快照。」
   * 所以：这里 push 进去之后，任何地方都不许再改它。
   * 你在界面上改消息状态、改世界书，动的只是「发送前预览」，
   * 这个数组纹丝不动 —— 这就是两个东西必须分开的原因。
   */
  DB.snapshots.push(snapshot);
  // 每条快照都带着完整的上下文正文，所以它会随对话变长而变胖。
  // 只留最近 12 条，避免把 localStorage 撑爆（这是取舍，不是最优解）。
  if (DB.snapshots.length > 12) DB.snapshots = DB.snapshots.slice(-12);
  save();
  renderPreview();     // 预览重算 + 快照列表多一条

  // 建一条占位的消息
  const reply = {
    id: uid('m'), sessionId: sid, role: 'assistant', content: '', createdAt: Date.now(),
    hidden: false, excluded: false, complete: false, interrupted: false
  };
  msgs(sid).push(reply);
  save(); renderMessages(); scrollToBottom();

  const controller = new AbortController();
  inFlight = { sid: sid, msgId: reply.id, controller: controller };
  renderControls();

  try {
    await streamChat(finalMessages, (delta) => {
      reply.content += delta;
      updateStreamingText(reply.id, sid); //用的是sid(闭包)，不是currentSessionID,防止串台（level 1)
    }, controller.signal);

    reply.complete = true;
  } catch (e) {
    reply.complete = true;
    if (e && e.name === 'AbortError') {
      reply.interrupted = true;                     // 手动中止 = 中断
    } else {
      reply.content += '\n\n[出错] ' + (e && e.message ? e.message : String(e));
    }
  } finally {
    inFlight = null;
    save();
    renderMessages(); renderControls(); scrollToBottom();
  }
}

// 重新生成上一条回答
async function retryLast() {
  const sid = currentSessionId;
  if (inFlight) { alert('还在生成中。先点「中止」。'); return; }

  const list = msgs(sid);
  // 从后往前删掉最后一条助手消息 —— 注意：不重新插入用户消息
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'assistant') { list.splice(i, 1); break; }
  }
  save(); renderMessages();

  await generate(sid);
}

// 停止生成
function stopGenerating() {
  if (inFlight) inFlight.controller.abort();
}

/* ============================================================
 * 9. 渲染
 * ============================================================ */

function renderAll() {
  renderSessions();
  renderMessages();
  renderWorldbook();
  renderPresets();
  renderCard();
  renderConfig();
  renderPreview();
  renderControls();
}

function renderSessions() {
  const ul = $('#session-list');
  ul.textContent = '';
  for (const s of DB.sessions) {
    const li = document.createElement('li');
    if (s.id === currentSessionId) li.classList.add('is-current');

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.name;

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = msgs(s.id).length;

    li.appendChild(name);
    li.appendChild(count);
    li.addEventListener('click', () => switchSession(s.id));  // 点一下就切换

    ul.appendChild(li);
  }

  const cur = DB.sessions.find(x => x.id === currentSessionId);
  $('#session-title').textContent = cur ? cur.name : '（没有会话）';
}

function renderMessages() {
  const box = $('#message-list');
  box.textContent = '';

  // ⭐ 顺带刷左栏的会话列表。听起来多余，其实是为了「不可能漏」：
  //    发消息 / 删消息 / 重新生成改的都是消息条数，左栏那个数字也要跟着变。
  //    如果只在 renderAll() 里刷，聊天时那个数字就会一直是旧的。
  renderSessions();

  const list = msgs(currentSessionId);
  for (const m of list) {
    // 【界面隐藏】的过滤：不勾「显示已隐藏」就看不到它。
    // 注意这只影响显示，跟「不进上下文」完全是两回事。
    if (m.hidden && !showHidden) continue;

    const el = document.createElement('div');
    el.className = 'msg ' + m.role;
    el.dataset.msgId = m.id;
    if (m.hidden) el.classList.add('is-hidden');
    if (m.excluded) el.classList.add('is-excluded');
    if (m.interrupted) el.classList.add('is-interrupted');
    if (!m.complete) el.classList.add('is-generating');

    // 头部：角色 + 状态标记
    const meta = document.createElement('div');
    meta.className = 'meta';
    const who = document.createElement('strong');
    who.textContent = m.role === 'user' ? '我' : '角色';
    meta.appendChild(who);
    const tags = [];
    if (m.hidden) tags.push('已隐藏');
    if (m.excluded) tags.push('不发送');
    if (tags.length) {
      const t = document.createElement('span');
      t.textContent = '· ' + tags.join(' / ');
      meta.appendChild(t);
    }

    // 正文：必须用 DOM API / textContent，绝不能用 innerHTML ——
    // 模型输出是不可信内容，直接塞 HTML 会中 XSS。
    // 这一句里会把 <tavern-panel> 解析出来渲染成小界面（等级 3）。
    renderMessageBody(el, m);

    // 操作按钮
    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    const bHide = document.createElement('button');
    bHide.type = 'button';
    bHide.className = 'small';
    bHide.textContent = m.hidden ? '取消隐藏' : '隐藏显示';
    bHide.addEventListener('click', () => toggleHidden(m.id));

    const bExcl = document.createElement('button');
    bExcl.type = 'button';
    bExcl.className = 'small';
    bExcl.textContent = m.excluded ? '加入上下文' : '不发送';
    bExcl.addEventListener('click', () => toggleExcluded(m.id));

    const bDel = document.createElement('button');
    bDel.type = 'button';
    bDel.className = 'small danger';
    bDel.textContent = '删除';
    bDel.addEventListener('click', () => removeMessage(m.id));

    actions.appendChild(bHide);
    actions.appendChild(bExcl);
    actions.appendChild(bDel);

    el.appendChild(meta);
    el.appendChild(actions);
    box.appendChild(el);
  }
}

// 流式输出时只更新那一条的正文，避免整个列表重画（会丢滚动位置）
function updateStreamingText(msgId, sid) {
  const m = msgs(sid).find(x => x.id === msgId);
  if (!m) return;
  const wrap = document.querySelector('[data-msg-id="' + msgId + '"]');
  const el = wrap ? wrap.querySelector('.body') : null;
  if (el) {
    el.textContent = m.content;
    scrollToBottom();
  } else if (sid === currentSessionId) {
    renderMessages();
  }
}

/* ============================================================
 * 10. <tavern-panel> 解析与渲染 ⭐（等级 3-B）
 *
 * 模型会在正文里输出这种标签：
 *   <tavern-panel type="status">{"hp":10,"令咒":3}</tavern-panel>
 *   <tavern-panel type="choices">{"options":[{"label":"…","text":"…"}]}</tavern-panel>
 *
 * 题目三条硬要求：
 *   - JSON 不合法         → 保留原文 + 提示具体问题
 *   - 标签没有闭合        → 保留原文 + 提示具体问题
 *   - 使用了不支持的类型  → 保留原文 + 提示具体问题
 *   ⚠️ 「不能直接丢掉这段内容」
 * ============================================================ */

const PANEL_TYPES = ['status', 'choices'];

function parseMessageContent(content) {
  const segments = [];
  let last = 0;
  let m;

  // 只匹配「开标签 + 闭标签」都齐全的块；不闭合的留给下面单独报错
  const re = /<tavern-panel\s+type\s*=\s*"([^"]*)"\s*>([\s\S]*?)<\/tavern-panel\s*>/g;

  while ((m = re.exec(content)) !== null) {
    if (m.index > last) segments.push({ kind: 'text', text: content.slice(last, m.index) });

    const type = m[1];
    const raw = m[2];
    const seg = { kind: 'panel', panelType: type, raw: m[0], inner: raw };

    if (PANEL_TYPES.indexOf(type) < 0) {
      seg.error = '不支持的面板类型「' + type + '」（本应用支持：' + PANEL_TYPES.join(' / ') + '）';
    } else {
      try {
        const data = JSON.parse(raw.trim());
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          throw new Error('面板内容必须是一个 JSON 对象');
        }
        if (type === 'choices' && !Array.isArray(data.options)) {
          throw new Error('type="choices" 的面板必须有 options 数组');
        }
        seg.data = data;
      } catch (e) {
        seg.error = 'JSON 解析失败：' + e.message;
      }
    }

    segments.push(seg);
    last = m.index + m[0].length;
  }

  if (last < content.length) {
    const rest = content.slice(last);
    const seg = { kind: 'text', text: rest };
    // 剩下的文字里还有开标签 → 说明它没闭合
    if (/<tavern-panel\b/.test(rest)) {
      seg.error = '有一个 <tavern-panel> 标签没有闭合（缺少 </tavern-panel>）';
    }
    segments.push(seg);
  }

  return segments;
}

// 渲染一条消息的正文（可能包含多个片段）
function renderMessageBody(wrap, m) {
  // 流式进行中：先按纯文本渲染，避免每来一个字就重新解析一遍
  if (!m.complete) {
    const body = document.createElement('p');
    body.className = 'body';
    body.textContent = m.content;
    wrap.appendChild(body);
    return;
  }

  const segments = parseMessageContent(m.content);
  for (const seg of segments) {

    if (seg.kind === 'text') {
      if (seg.text.trim()) {
        const body = document.createElement('p');
        body.className = 'body';
        body.textContent = seg.text;
        wrap.appendChild(body);
      }
      if (seg.error) wrap.appendChild(buildProblem(seg.error, seg.text));

    } else if (seg.error) {
      // ⭐ 解析失败：保留原文，并说清是哪一种问题
      wrap.appendChild(buildProblem(seg.error, seg.raw));

    } else if (seg.panelType === 'status') {
      wrap.appendChild(buildStatusPanel(seg.data));

    } else if (seg.panelType === 'choices') {
      wrap.appendChild(buildChoicesPanel(seg.data, m.sessionId));
    }
  }
}

// 解析失败时的提示卡片 —— 原文一字不少地留在下面
function buildProblem(reason, rawText) {
  const box = document.createElement('div');
  box.className = 'tp-problem';

  const head = document.createElement('div');
  head.className = 'tp-problem-head';
  head.textContent = ' 面板没有渲染：' + reason;

  const pre = document.createElement('pre');
  pre.className = 'tp-problem-raw';
  pre.textContent = rawText;      // 原文保留，不丢

  box.appendChild(head);
  box.appendChild(pre);
  return box;
}

// 画进度条的约定：任意「X」和「XMax」成对出现就画一条。
// 这样 hp/hpMax 固然能画，模型自己发挥出来的 durability/durabilityMax、
// 耐久/耐久Max 也一样能画 —— 模型不一定严格按预设的格式来，界面对此要稳。
// 配不成对的字段就全部按 键 → 值 展示。
function buildStatusPanel(data) {
  const card = document.createElement('div');
  card.className = 'tpanel';

  const title = document.createElement('div');
  title.className = 'tpanel-title';
  title.textContent = '状态';
  card.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'tp-grid';

  const drawn = {};   // 已经画成条的字段，下面不再重复列一行

  for (const maxKey of Object.keys(data)) {
    if (!/Max$/.test(maxKey)) continue;
    const baseKey = maxKey.slice(0, -3);
    if (!Object.prototype.hasOwnProperty.call(data, baseKey)) continue;

    const cur = Number(data[baseKey]);
    const max = Number(data[maxKey]);
    if (isNaN(cur) || isNaN(max) || max <= 0) continue;

    drawn[baseKey] = true;
    drawn[maxKey] = true;

    const bar = document.createElement('div');
    bar.className = 'hp-bar';
    const fill = document.createElement('div');
    fill.className = 'hp-fill';
    fill.style.width = Math.max(0, Math.min(100, (cur / max) * 100)) + '%';
    bar.appendChild(fill);

    const lbl = document.createElement('div');
    lbl.className = 'hp-label';
    lbl.textContent = String(baseKey).toUpperCase() + ' ' + cur + ' / ' + max;

    grid.appendChild(lbl);
    grid.appendChild(bar);
  }

  for (const key of Object.keys(data)) {
    if (drawn[key]) continue;
    const cell = document.createElement('div');
    cell.className = 'tp-cell';
    const k = document.createElement('span');
    k.className = 'tp-key';
    k.textContent = key;
    const v = document.createElement('span');
    v.className = 'tp-val';
    const raw = data[key];
    v.textContent = (raw && typeof raw === 'object') ? JSON.stringify(raw) : String(raw);
    cell.appendChild(k);
    cell.appendChild(v);
    grid.appendChild(cell);
  }

  card.appendChild(grid);
  return card;
}

// 选项按钮：点了只把文字填进【这条消息所属会话】的输入框，由用户决定是否发送
function buildChoicesPanel(data, sid) {
  const card = document.createElement('div');
  card.className = 'tpanel';

  const title = document.createElement('div');
  title.className = 'tpanel-title';
  title.textContent = '可选行动';
  card.appendChild(title);

  const box = document.createElement('div');
  box.className = 'tp-choices';

  for (const opt of data.options) {
    const label = opt && (opt.label != null ? String(opt.label) : String(opt.text || ''));
    const sendText = opt && (opt.text != null ? String(opt.text) : label);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tp-choice';
    btn.textContent = label;
    btn.title = '填入输入框：' + sendText;
    btn.addEventListener('click', () => {
      // 边界：如果这条消息不属于当前会话，先切过去（否则用户看不见输入框）
      if (sid && sid !== currentSessionId) switchSession(sid);
      const input = $('#input');
      input.value = sendText;
      input.focus();
      // ⚠️ 只填入，不自动发送 —— 由用户决定
    });
    box.appendChild(btn);
  }

  card.appendChild(box);
  return card;
}

function renderWorldbook() {
  const box = $('#worldbook-list');
  box.textContent = '';

  if (!DB.worldbook.entries.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '还没有条目。点上面的「＋ 新增」加一条，关键词用逗号分隔。';
    box.appendChild(p);
  }

  for (const e of DB.worldbook.entries) {
    const card = document.createElement('div');
    card.className = 'wb-entry' + (e.enabled ? '' : ' is-off');

    // ID + 名称
    const row1 = document.createElement('div');
    row1.className = 'row';
    const idLbl = document.createElement('span');
    idLbl.className = 'mini-label';
    idLbl.textContent = e.id;
    const nameIn = document.createElement('input');
    nameIn.type = 'text';
    nameIn.value = e.name;
    nameIn.placeholder = '条目名称';
    nameIn.setAttribute('aria-label', '条目名称');
    nameIn.addEventListener('input', () => { e.name = nameIn.value; save(); });
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'small danger';
    delBtn.textContent = '删';
    delBtn.addEventListener('click', () => {
      DB.worldbook.entries = DB.worldbook.entries.filter(x => x.id !== e.id);
      save(); renderWorldbook(); refreshPreview();
    });
    row1.appendChild(idLbl); row1.appendChild(nameIn); row1.appendChild(delBtn);

    // 关键词
    const row2 = document.createElement('div');
    row2.className = 'row';
    const kwLbl = document.createElement('span');
    kwLbl.className = 'mini-label';
    kwLbl.textContent = '关键词';
    const kwIn = document.createElement('input');
    kwIn.type = 'text';
    kwIn.value = (e.keywords || []).join(',');
    kwIn.placeholder = '柳洞寺,圣杯';
    kwIn.setAttribute('aria-label', '关键词，逗号分隔');
    kwIn.addEventListener('input', () => {
      e.keywords = kwIn.value.split(',').map(s => s.trim()).filter(Boolean);
      save();
    });
    row2.appendChild(kwLbl); row2.appendChild(kwIn);

    // 正文
    const row3 = document.createElement('div');
    row3.className = 'row';
    const ta = document.createElement('textarea');
    ta.value = e.content;
    ta.placeholder = '命中时会作为 system 内容插入到请求最前面';
    ta.setAttribute('aria-label', '条目正文');
    ta.addEventListener('input', () => { e.content = ta.value; save(); });
    row3.appendChild(ta);

    // 开关：启用 / 常驻 / 优先级
    const row4 = document.createElement('div');
    row4.className = 'row';

    const lblOn = document.createElement('label');
    lblOn.className = 'switch';
    const chkOn = document.createElement('input');
    chkOn.type = 'checkbox';
    chkOn.checked = e.enabled;
    chkOn.addEventListener('change', () => {
      e.enabled = chkOn.checked; save(); renderWorldbook(); refreshPreview();
    });
    const spOn = document.createElement('span');
    spOn.textContent = '启用';
    lblOn.appendChild(chkOn); lblOn.appendChild(spOn);

    const lblConst = document.createElement('label');
    lblConst.className = 'switch';
    const chkConst = document.createElement('input');
    chkConst.type = 'checkbox';
    chkConst.checked = e.constant;
    chkConst.addEventListener('change', () => {
      e.constant = chkConst.checked; save(); refreshPreview();
    });
    const spConst = document.createElement('span');
    spConst.textContent = '常驻';
    lblConst.appendChild(chkConst); lblConst.appendChild(spConst);

    const prioWrap = document.createElement('span');
    prioWrap.className = 'row';
    prioWrap.style.marginBottom = '0';
    const prioLbl = document.createElement('span');
    prioLbl.className = 'mini-label';
    prioLbl.textContent = '优先级';
    const prioIn = document.createElement('input');
    prioIn.type = 'number';
    prioIn.style.width = '62px';
    prioIn.value = e.priority;
    prioIn.setAttribute('aria-label', '优先级');
    prioIn.addEventListener('input', () => {
      e.priority = Number(prioIn.value) || 0; save(); refreshPreview();
    });
    prioWrap.appendChild(prioLbl); prioWrap.appendChild(prioIn);

    row4.appendChild(lblOn); row4.appendChild(lblConst); row4.appendChild(prioWrap);

    card.appendChild(row1); card.appendChild(row2); card.appendChild(row3); card.appendChild(row4);
    box.appendChild(card);
  }

  $('#cfg-depth-wb').value = DB.config.depth;
}

/* ============================================================
 * 发送前预览 vs 已发送快照 —— 这是两个东西，故意分开
 *
 * 题目第 986 行：「修改历史消息会影响后续请求，但不能改写已经发出的请求快照。」
 * 题目第 1004 行：「提供发送前预览，并保存发送后的请求快照。」
 *
 *   · 发送前预览（本函数上半部分）—— 每次现算。你改消息、改世界书、改深度，
 *     它立刻跟着变。它回答「我如果现在发出去，会发什么」。
 *   · 已发送快照（renderSnapshots）—— 发出去那一刻存进 DB.snapshots 之后
 *     就【只读】。它回答「上次实际发的是什么」。改历史不会动它。
 *
 * 如果只用一个变量在两种含义之间来回覆盖，就会踩题目的红线。所以这里刻意不省。
 * ============================================================ */

function renderPreview() {
  const olSent = $('#preview-sent');
  const ulNot = $('#preview-notsent');
  olSent.textContent = '';
  ulNot.textContent = '';

  const fill = $('#usage-fill');

  // 现算一份「如果现在发出去」的内容
  const { snapshot: p } = buildRequest(currentSessionId, null);

  // 「将按此顺序发送」
  p.parts.forEach((part, i) => {
    const li = document.createElement('li');

    const src = document.createElement('span');
    src.className = 'src';
    src.textContent = (i + 1) + '. ' + part.label;

    const why = document.createElement('span');
    why.className = 'why';
    why.textContent = part.which;

    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = part.content;

    li.appendChild(src); li.appendChild(why); li.appendChild(txt);
    olSent.appendChild(li);
  });

  if (!p.parts.length) {
    const li = document.createElement('li');
    li.textContent = '（没有内容会被发送）';
    olSent.appendChild(li);
  }

  // 「没有发送的内容」+ 原因 —— 这一段是题目明写的检查项。
  // 既包括消息（不发送 / 未完成 / 空），也包括世界书条目（禁用 / 未命中）。
  p.notSent.forEach(ns => {
    const li = document.createElement('li');
    const tag = document.createElement('span');
    tag.className = 'reason-tag';
    tag.textContent = REASON_TEXT[ns.reason] || ns.reason;
    const who = document.createElement('span');
    who.textContent = ns.label || ((ns.role === 'user' ? '用户消息' : 'AI 消息') + ' · ' + ns.id.slice(-6));
    li.appendChild(tag); li.appendChild(who);
    ulNot.appendChild(li);
  });

  if (!p.notSent.length) {
    const li = document.createElement('li');
    li.textContent = '（没有内容被排除）';
    ulNot.appendChild(li);
  }

  // 用量 + 「快满了」提醒（题目要求 80% 时提醒，并给出可处理的消息入口）
  const ratio = Math.min(1.5, p.usage / p.limit);
  fill.style.width = Math.min(100, ratio * 100) + '%';
  fill.className = ratio >= 1 ? 'is-over' : (ratio >= 0.8 ? 'is-warn' : '');

  let txt = '估算用量 ' + p.usage + ' / 上限 ' + p.limit +
            '（' + Math.round(ratio * 100) + '%）· 扫描深度 ' + p.depth;
  if (ratio >= 1) txt += '\n⚠️ 已经超过上限了！';
  else if (ratio >= 0.8) txt += '\n⚠️ 上下文快满了，可以排除较早的消息。';
  $('#usage-text').textContent = txt;

  // 底下那个只读的「已发送快照」列表
  renderSnapshots();
}

/**
 * 已发送的请求快照列表 —— 只读。
 * 数据来自 DB.snapshots，只有 generate() 会往里写，别的地方一律不改它。
 * 这就是题目说的「保存发送后的请求快照」，也是能被追问的底气：
 * 你改历史消息，这个列表纹丝不动。
 */
function renderSnapshots() {
  const box = $('#snapshot-list');
  if (!box) return;
  box.textContent = '';

  const mine = DB.snapshots.filter(s => s.sessionId === currentSessionId);
  if (!mine.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '这个会话还没发送过请求。发一条之后，这里会存下那一刻实际发出去的内容——' +
                    '之后你再改历史消息，它也不会变。';
    box.appendChild(p);
    return;
  }

  // 新的排在上面
  for (let i = mine.length - 1; i >= 0; i--) {
    const s = mine[i];
    const d = document.createElement('details');
    d.className = 'snap';

    const t = new Date(s.createdAt);
    const two = (n) => String(n).padStart(2, '0');
    const sum = document.createElement('summary');
    sum.textContent = '快照 #' + (i + 1) + ' · ' +
                      two(t.getHours()) + ':' + two(t.getMinutes()) + ':' + two(t.getSeconds()) +
                      ' · ' + s.parts.length + ' 段 · 约 ' + s.usage + ' token';
    d.appendChild(sum);

    const ol = document.createElement('ol');
    ol.className = 'preview-list';
    s.parts.forEach((part, k) => {
      const li = document.createElement('li');
      const src = document.createElement('span');
      src.className = 'src';
      src.textContent = (k + 1) + '. ' + part.label;
      const why = document.createElement('span');
      why.className = 'why';
      why.textContent = part.which;
      const txt = document.createElement('span');
      txt.className = 'txt';
      txt.textContent = part.content;
      li.appendChild(src); li.appendChild(why); li.appendChild(txt);
      ol.appendChild(li);
    });
    d.appendChild(ol);
    box.appendChild(d);
  }
}

function renderConfig() {
  const c = DB.config;
  $('#cfg-apiBase').value = c.apiBase;
  $('#cfg-apiKey').value = c.apiKey;
  $('#cfg-model').value = c.model;
  $('#cfg-stream').checked = !!c.stream;
  $('#cfg-mock').checked = !!c.mock;
  $('#cfg-proxy').checked = !!c.proxy;
  $('#cfg-ctxLimit').value = c.ctxLimit;
}

function renderControls() {
  const busy = !!inFlight;
  $('#btn-send').disabled = busy;
  $('#btn-stop').hidden = !busy;
}

function scrollToBottom() {
  const box = $('#message-list');
  box.scrollTop = box.scrollHeight;
}

// 改了消息状态或世界书之后，如果已经有快照了，重算一遍让预览跟着变
function refreshPreview() {
  renderPreview();
}

/* ============================================================
 * 11. 导入 / 导出（题目要求：明确区分「覆盖」与「创建副本」）
 * ============================================================ */

function exportCurrentSession() {
  const sid = currentSessionId;
  const s = DB.sessions.find(x => x.id === sid);
  if (!s) return;
  const payload = {
    format: 'my-tavern-session',
    version: 1,
    session: s,
    messages: msgs(sid)          // 注意：messages 里带着 hidden / excluded，导回来能恢复
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = s.name + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importSessionFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch (e) {
      alert('导入失败：这个文件不是合法的 JSON。（' + e.message + '）');
      return;
    }
    if (!data || !data.session || !Array.isArray(data.messages)) {
      alert('导入失败：缺少 session 或 messages 字段。');
      return;
    }
    const incoming = data.session;
    const exists = DB.sessions.some(x => x.id === incoming.id);

    // ⭐ 同 ID 时必须让用户选：覆盖 / 创建副本 / 取消，不能默默处理
    if (exists) {
      const choice = prompt(
        '已存在同 ID 的会话「' + incoming.id + '」。\n' +
        '输入 1 = 覆盖它\n' +
        '输入 2 = 创建副本\n' +
        '其它 = 取消',
        '2'
      );
      if (choice === '1') {
        const old = DB.sessions.find(x => x.id === incoming.id);
        Object.assign(old, incoming);
        DB.messages[incoming.id] = data.messages;
        currentSessionId = incoming.id;
      } else if (choice === '2') {
        const newId = uid('ses');
        DB.sessions.push({ id: newId, name: incoming.name + '（副本）', createdAt: Date.now() });
        DB.messages[newId] = data.messages;
        currentSessionId = newId;
      } else {
        return;   // 取消
      }
    } else {
      DB.sessions.push(incoming);
      DB.messages[incoming.id] = data.messages;
      currentSessionId = incoming.id;
    }

    save(); renderAll();
    alert('导入完成。');
  };
  reader.readAsText(file);
}

/* ============================================================
 * 12. 事件绑定 + 启动
 * ============================================================ */

function bindEvents() {
  $('#btn-new-session').addEventListener('click', () => createSession());
  $('#btn-rename').addEventListener('click', () => renameSession(currentSessionId));
  $('#btn-delete-session').addEventListener('click', () => deleteSession(currentSessionId));

  $('#chk-show-hidden').addEventListener('change', (e) => {
    showHidden = e.target.checked;
    renderMessages();
  });

  $('#btn-send').addEventListener('click', sendMessage);
  $('#btn-stop').addEventListener('click', stopGenerating);
  $('#btn-retry').addEventListener('click', retryLast);

  // Ctrl / Cmd + Enter 发送
  $('#input').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      sendMessage();
    }
  });

  // 右栏 tab 切换
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('is-active'));
      tab.classList.add('is-active');
      $('[data-pane="' + tab.dataset.tab + '"]').classList.add('is-active');
    });
  });

  // 世界书
  $('#btn-add-entry').addEventListener('click', () => {
    DB.worldbook.entries.push({
      id: nextEntryId(),
      name: '新条目',
      keywords: [],
      content: '',
      enabled: true,
      constant: false,
      priority: 10
    });
    save(); renderWorldbook(); refreshPreview();
  });

  $('#cfg-depth-wb').addEventListener('input', (e) => {
    DB.config.depth = Math.max(0, Number(e.target.value) || 0);
    save(); refreshPreview();
  });

  // 设置
  $('#btn-save-config').addEventListener('click', () => {
    DB.config.apiBase  = $('#cfg-apiBase').value.trim();
    DB.config.apiKey   = $('#cfg-apiKey').value.trim();
    DB.config.model    = $('#cfg-model').value.trim();
    DB.config.stream   = $('#cfg-stream').checked;
    DB.config.mock     = $('#cfg-mock').checked;
    DB.config.proxy    = $('#cfg-proxy').checked;
    DB.config.ctxLimit = Math.max(500, Number($('#cfg-ctxLimit').value) || 8000);
    save(); alert('设置已保存。');
  });

  // 导入导出
  $('#btn-export').addEventListener('click', exportCurrentSession);
  $('#btn-import').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) importSessionFromFile(f);
    e.target.value = '';   // 清空，这样同一个文件能再选一次
  });

  // 上下文快满了 → 「可处理的消息入口」
  $('#btn-clean-context').addEventListener('click', () => {
    const keep = prompt('保留最近多少条消息参与上下文？（更早的会被设为「不发送」）', '10');
    if (keep === null) return;
    const n = Number(keep);
    if (!isNaN(n) && n >= 0) batchExcludeOlder(n);
  });

  // ---------- 提示词预设（等级 3） ----------
  $('#cfg-active-preset').addEventListener('change', (e) => {
    DB.activePresetId = e.target.value;
    save(); renderPresets();
  });

  $('#btn-add-module').addEventListener('click', () => {
    const preset = activePreset();
    if (!preset) return;
    const maxOrder = preset.modules.reduce((mx, m) => Math.max(mx, m.order || 0), 0);
    preset.modules.push({
      id: nextModuleId(preset),
      name: '新模块',
      order: maxOrder + 1,
      enabled: true,
      role: 'system',
      content: ''
    });
    save(); renderPresets();
  });

  $('#btn-export-preset').addEventListener('click', exportPreset);
  $('#btn-import-preset').addEventListener('click', () => $('#file-preset').click());
  $('#file-preset').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) importPresetFile(f);
    e.target.value = '';
  });

  // ---------- 角色卡（等级 3） ----------
  $('#btn-import-card').addEventListener('click', () => $('#file-card').click());
  $('#btn-export-card').addEventListener('click', exportCard);

  $('#file-card').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';                 // 清空，同一个文件能再选一次
    if (!f) return;

    // PNG：角色卡内嵌在 tEXt 块里
    if (/\.png$/i.test(f.name) || f.type === 'image/png') {
      try {
        const raw = await readCardFromPng(f);
        importCardObject(raw, f.name);
      } catch (err) {
        alert('从 PNG 读角色卡失败：' + err.message);
      }
      return;
    }

    // JSON
    const reader = new FileReader();
    reader.onload = () => {
      let raw;
      try {
        raw = JSON.parse(reader.result);
      } catch (err) {
        alert('角色卡导入失败：这不是合法的 JSON。（' + err.message + '）');
        return;
      }
      importCardObject(raw, f.name);
    };
    reader.readAsText(f);
  });
}

// 世界书 ID：wb_001、wb_002 ……
// 用零填充是为了让「ASCII ID 升序」有意义（否则 "wb_10" < "wb_2" 就错了）
function nextEntryId() {
  let max = 0;
  for (const e of DB.worldbook.entries) {
    const n = parseInt(String(e.id).replace(/^wb_/, ''), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return 'wb_' + String(max + 1).padStart(3, '0');
}

/* ============================================================
 * 13. 提示词预设 ⭐（等级 3-A）
 *
 * 预设 = 一组「提示词模块」。每个模块有 名称 / 正文 / 启用状态 / 顺序。
 * 启用的模块按 order 从小到大拼到请求最前面（在 buildRequest 的第 ① 步）。
 *
 * 题目要求：「新预设符合已有格式时，不修改业务代码即可使用」
 *   → 所以加一个预设只是加一份 JSON，代码一行都不用动。
 * ============================================================ */

const PRESET_FORMAT  = 'my-tavern-preset';
const PRESET_VERSION = 1;

function defaultPreset() {
  return {
    format: PRESET_FORMAT,
    version: PRESET_VERSION,
    id: 'preset_default',
    name: '默认预设',
    // 上下文配置（题目要求预设里包含这部分）
    context: { depth: 3, includeWorldbook: true },
    modules: [
      {
        id: 'mod_001', name: '角色扮演基础', order: 1, enabled: true, role: 'system',
        content: '你正在与用户进行角色扮演对话。始终保持角色一致性，用第一人称描写角色的言行与心理。'
      },
      {
        id: 'mod_002', name: '状态面板格式（等级3）', order: 2, enabled: true, role: 'system',
        content: [
          '回复中如果出现状态数值或可选行动，请使用下面两种标签，让界面能渲染成小卡片：',
          '',
          '<tavern-panel type="status">',
          '{"hp":10,"hpMax":20,"令咒":3,"location":"柳洞寺"}',
          '</tavern-panel>',
          '',
          '<tavern-panel type="choices">',
          '{"options":[{"label":"按钮上显示的字","text":"点下去填进输入框的字"}]}',
          '</tavern-panel>',
          '',
          '注意：标签必须正确闭合；内容必须是合法 JSON；type 只支持 status 和 choices。',
          '没有状态或选项时可以不输出这两个标签。'
        ].join('\n')
      },
      {
        id: 'mod_003', name: '（示例）简短回复', order: 9, enabled: false, role: 'system',
        content: '保持回复简短，每轮不超过三句话。'
      }
    ]
  };
}

function activePreset() {
  return DB.presets.find(p => p.id === DB.activePresetId) || DB.presets[0] || null;
}

function nextModuleId(preset) {
  let max = 0;
  for (const m of preset.modules) {
    const n = parseInt(String(m.id).replace(/^mod_/, ''), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return 'mod_' + String(max + 1).padStart(3, '0');
}

/**
 * 校验一份预设。
 * 要处理的错误（题目明写）：字段类型错误、重复 ID、不支持的格式版本。
 * 返回 { ok:true, preset } 或 { ok:false, error:"说清哪里不对" }
 */
function validatePreset(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: '顶层必须是一个 JSON 对象' };
  }
  if (obj.format !== PRESET_FORMAT) {
    return { ok: false, error: '格式标识不对：期望 "' + PRESET_FORMAT + '"，实际是 "' + obj.format + '"' };
  }
  if (typeof obj.version !== 'number') {
    return { ok: false, error: 'version 字段必须是数字' };
  }
  if (obj.version > PRESET_VERSION) {
    return { ok: false, error: '不支持的格式版本：' + obj.version + '（本应用最高支持 ' + PRESET_VERSION + '）' };
  }
  if (typeof obj.id !== 'string' || !obj.id) {
    return { ok: false, error: 'id 必须是非空字符串' };
  }
  if (typeof obj.name !== 'string' || !obj.name) {
    return { ok: false, error: 'name 必须是非空字符串' };
  }
  if (!Array.isArray(obj.modules)) {
    return { ok: false, error: 'modules 必须是数组' };
  }

  const seen = new Set();
  for (let i = 0; i < obj.modules.length; i++) {
    const m = obj.modules[i];
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      return { ok: false, error: '第 ' + (i + 1) + ' 个模块不是一个对象' };
    }
    if (typeof m.id !== 'string' || !m.id) {
      return { ok: false, error: '第 ' + (i + 1) + ' 个模块缺少 id' };
    }
    if (seen.has(m.id)) {
      return { ok: false, error: '模块 id 重复：「' + m.id + '」' };
    }
    seen.add(m.id);
    if (typeof m.content !== 'string') {
      return { ok: false, error: '模块「' + m.id + '」的 content 必须是字符串' };
    }
    // 可选字段补默认值
    if (typeof m.name !== 'string') m.name = m.id;
    if (typeof m.order !== 'number') m.order = i + 1;
    if (typeof m.enabled !== 'boolean') m.enabled = true;
    if (['system', 'user', 'assistant'].indexOf(m.role) < 0) m.role = 'system';
  }
  if (obj.context !== undefined && (typeof obj.context !== 'object' || obj.context === null || Array.isArray(obj.context))) {
    return { ok: false, error: 'context 必须是对象' };
  }
  return { ok: true, preset: obj };
}

function exportPreset() {
  const preset = activePreset();
  if (!preset) return;
  const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = preset.name + '.preset.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importPresetFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let obj;
    try {
      obj = JSON.parse(reader.result);
    } catch (e) {
      alert('导入失败：这不是合法的 JSON。（' + e.message + '）');
      return;
    }
    const res = validatePreset(obj);
    if (!res.ok) {
      alert('导入失败：' + res.error);
      return;
    }
    const preset = res.preset;
    const exists = DB.presets.some(p => p.id === preset.id);

    // 同 ID → 覆盖 / 创建副本 / 取消
    if (exists) {
      const choice = prompt(
        '已存在同 ID 的预设「' + preset.id + '」。\n输入 1 = 覆盖\n输入 2 = 创建副本\n其它 = 取消',
        '2'
      );
      if (choice === '1') {
        const idx = DB.presets.findIndex(p => p.id === preset.id);
        DB.presets[idx] = preset;
      } else if (choice === '2') {
        preset.id = preset.id + '_copy' + Date.now().toString(36).slice(-4);
        preset.name = preset.name + '（副本）';
        DB.presets.push(preset);
      } else {
        return;
      }
    } else {
      DB.presets.push(preset);
    }

    DB.activePresetId = preset.id;
    save(); renderAll();
    alert('预设「' + preset.name + '」已导入并启用，包含 ' + preset.modules.length + ' 个模块。');
  };
  reader.readAsText(file);
}

/* ============================================================
 * 14. 角色卡 ⭐（等级 3-A）
 *
 * 支持 Character Card V2 的明确子集：名称 / 描述 / 开场白 / 内嵌世界书。
 * 三条容易被忽略但题目明写的要求：
 *   ① 暂不支持的字段及未知 extensions，导出时必须保留
 *   ② 世界书转换到本题规则时，要展示字段映射和被忽略的运行规则
 *   ③ 仅实现子集时，要如实说明兼容范围
 * ============================================================ */

// 字段映射表（会显示在界面上，也在 README 里）
const CARD_FIELD_MAP = [
  ['data.name',        'card.name',        '角色名 → 新建会话时的默认名字'],
  ['data.description', 'card.description', '角色描述 → 作为 system 内容参与请求'],
  ['data.first_mes',   'card.firstMes',    '开场白 → 新会话的第一条消息'],
  ['…entries[].keys',      'worldbook.keywords',  '关键词数组'],
  ['…entries[].content',   'worldbook.content',   '条目正文'],
  ['…entries[].enabled',   'worldbook.enabled',   '启用状态'],
  ['…entries[].constant',  'worldbook.constant',  '常驻状态'],
  ['…entries[].insertion_order', 'worldbook.priority', '优先级']
];

// 被忽略的运行规则 —— 题目要求「应展示字段映射和被忽略的运行规则」
const CARD_IGNORED = [
  ['selective',        '需要主/次关键词同时命中才触发。本题规则只用 keys 做单条包含匹配'],
  ['secondary_keys',   '次关键词。同上，不参与匹配'],
  ['recursive',        '递归扫描世界书正文。本题规则明确「不递归扫描世界书正文」'],
  ['position / depth', '把条目插到上下文的指定位置/深度。本应用统一插在历史消息之前'],
  ['probability',      '按概率随机决定是否触发。本应用不做随机，保证可复现'],
  ['case_sensitive',   '大小写敏感匹配。本应用一律按字面包含匹配'],
  ['extensions.*',     '第三方扩展字段。本应用不识别，但导入导出时原样保留']
];

/**
 * 把一份角色卡 JSON 规范化成内部结构。
 * 要处理的错误：字段类型错误、不支持的格式版本。
 * 抛异常，由调用方 alert 出来。
 */
function normalizeCard(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('角色卡顶层必须是一个 JSON 对象');
  }

  let data = raw;
  const spec = raw.spec;

  if (spec !== undefined) {
    if (spec !== 'chara_card_v2') {
      throw new Error('不支持的角色卡格式：「' + spec + '」。本应用只支持 chara_card_v2，以及没有 spec 字段的平铺格式');
    }
    if (typeof raw.spec_version !== 'string') {
      throw new Error('spec 是 chara_card_v2，但缺少 spec_version 字段');
    }
    const major = Number(String(raw.spec_version).split('.')[0]);
    if (!isNaN(major) && major > 2) {
      throw new Error('不支持的格式版本：' + raw.spec_version + '（本应用支持 2.x）');
    }
    if (!raw.data || typeof raw.data !== 'object' || Array.isArray(raw.data)) {
      throw new Error('角色卡缺少 data 字段，或 data 不是对象');
    }
    data = raw.data;
  }

  // 字段类型错误要报出来，而不是默默当成空字符串
  const pick = (key) => {
    const v = data[key];
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') {
      throw new Error('字段 ' + key + ' 的类型不对：应该是字符串，实际是 ' + (Array.isArray(v) ? 'array' : typeof v));
    }
    return v;
  };

  return {
    spec: spec || '（平铺格式）',
    specVersion: raw.spec_version || '（无）',
    name: pick('name') || '未命名角色',
    description: pick('description'),
    firstMes: pick('first_mes'),
    raw: raw,                     // ⭐ 原始 JSON 整份留着，导出时以它为底，未知字段全保留
    entryIds: [],                 // 这张卡带来的世界书条目 id
    importedAt: Date.now()
  };
}

// 把角色卡里的 character_book 转成本应用的世界书条目
function worldbookFromCard(raw) {
  const data = (raw.spec && raw.data && typeof raw.data === 'object') ? raw.data : raw;
  const book = data && data.character_book;
  if (!book || typeof book !== 'object') return [];
  const entries = Array.isArray(book.entries) ? book.entries : [];

  const out = [];
  entries.forEach((e, i) => {
    if (!e || typeof e !== 'object') return;
    const keys = Array.isArray(e.keys) ? e.keys.filter(k => typeof k === 'string' && k) : [];
    out.push({
      id: 'wb_' + String(i + 1).padStart(3, '0'),
      name: (typeof e.comment === 'string' && e.comment) ||
            (typeof e.name === 'string' && e.name) || ('条目 ' + (i + 1)),
      keywords: keys,
      content: typeof e.content === 'string' ? e.content : '',
      enabled: e.enabled !== false,
      constant: e.constant === true,
      priority: (typeof e.insertion_order === 'number') ? e.insertion_order
              : (typeof e.priority === 'number' ? e.priority : 10)
    });
  });
  return out;
}

// 导入世界书条目 —— 同 ID 时让用户选：覆盖 / 创建副本 / 取消
function mergeWorldbookEntries(incoming) {
  if (!incoming.length) return '这张卡里没有内嵌世界书';
  const existing = new Set(DB.worldbook.entries.map(e => e.id));
  const collide = incoming.filter(e => existing.has(e.id));

  if (!collide.length) {
    DB.worldbook.entries = DB.worldbook.entries.concat(incoming);
    return '新增 ' + incoming.length + ' 条世界书';
  }

  const choice = prompt(
    '有 ' + collide.length + ' 条世界书条目和已有条目同 ID。\n' +
    '输入 1 = 覆盖同 ID 的条目\n' +
    '输入 2 = 全部创建为副本（ID 加后缀）\n' +
    '其它 = 不导入世界书',
    '2'
  );

  if (choice === '1') {
    for (const e of incoming) {
      const idx = DB.worldbook.entries.findIndex(x => x.id === e.id);
      if (idx >= 0) DB.worldbook.entries[idx] = e; else DB.worldbook.entries.push(e);
    }
    return '覆盖 ' + collide.length + ' 条、新增 ' + (incoming.length - collide.length) + ' 条世界书';
  }

  if (choice === '2') {
    let n = 0;
    for (const e of incoming) {
      let id = e.id;
      while (DB.worldbook.entries.some(x => x.id === id)) { n++; id = e.id + '_' + n; }
      DB.worldbook.entries.push(Object.assign({}, e, { id: id }));
    }
    return '新增 ' + incoming.length + ' 条世界书（副本 ID）';
  }

  return '已跳过世界书导入';
}

function importCardObject(raw, sourceLabel) {
  let card;
  try {
    card = normalizeCard(raw);
  } catch (e) {
    alert('角色卡导入失败：' + e.message);
    return;
  }

  if (DB.card) {
    const ok = confirm(
      '已经有一张角色卡「' + DB.card.name + '」。\n' +
      '确定要覆盖它吗？（取消 = 放弃本次导入）'
    );
    if (!ok) return;
  }

  const wb = worldbookFromCard(raw);
  const msg = mergeWorldbookEntries(wb);
  card.entryIds = wb.map(e => e.id);

  // 副本模式下 id 被改过，重新收集一遍实际用到的 id
  if (wb.length) {
    const names = wb.map(e => e.name);
    card.entryIds = DB.worldbook.entries.filter(e => names.indexOf(e.name) >= 0).map(e => e.id);
  }

  DB.card = card;
  save(); renderAll();
  alert(
    '角色卡「' + card.name + '」已导入' + (sourceLabel ? '（来源：' + sourceLabel + '）' : '') + '。\n' +
    msg + '。\n\n' +
    '接下来新建的会话会用它作为默认名字和开场白。'
  );
}

function exportCard() {
  if (!DB.card) { alert('还没有导入角色卡，没有可导出的内容。'); return; }

  // ⭐ 以原始 JSON 为底 —— 这样不支持的字段和未知 extensions 全部原样保留
  const out = JSON.parse(JSON.stringify(DB.card.raw));
  const target = (out.spec === 'chara_card_v2' && out.data && typeof out.data === 'object') ? out.data : out;

  // 把界面上当前的值写回去（只写我支持的字段）
  target.name = DB.card.name;
  target.description = DB.card.description;
  target.first_mes = DB.card.firstMes;

  // 世界书按位置合并：以原条目为底，覆盖我支持的字段，未知字段照样保留
  const ids = DB.card.entryIds || [];
  const mine = DB.worldbook.entries.filter(e => ids.indexOf(e.id) >= 0);
  if (mine.length) {
    const orig = (target.character_book && Array.isArray(target.character_book.entries))
      ? target.character_book.entries : [];
    const merged = mine.map((e, i) => {
      const base = (orig[i] && typeof orig[i] === 'object') ? Object.assign({}, orig[i]) : {};
      base.keys = e.keywords;
      base.content = e.content;
      base.enabled = e.enabled;
      base.constant = e.constant;
      base.insertion_order = e.priority;
      return base;
    });
    if (!target.character_book || typeof target.character_book !== 'object') target.character_book = {};
    target.character_book.entries = merged;
    if (typeof target.character_book.name !== 'string') target.character_book.name = DB.card.name + ' 的世界书';
  }

  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = DB.card.name + '.card.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---- PNG 角色卡（扩展功能）：角色卡通常存在 PNG 的 tEXt 块里，键名 chara ---- */

function bytesToAscii(bytes) {
  // 分块拼接，避免 String.fromCharCode.apply 参数过多爆栈
  let s = '';
  for (let i = 0; i < bytes.length; i += 4096) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
  }
  return s;
}

function readCardFromPng(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.onload = () => {
      const buf = new Uint8Array(reader.result);

      // PNG 固定 8 字节签名
      const sig = [137, 80, 78, 71, 13, 10, 26, 10];
      for (let i = 0; i < 8; i++) {
        if (buf[i] !== sig[i]) { reject(new Error('这不是一个 PNG 文件')); return; }
      }

      let off = 8;
      const texts = {};
      while (off + 8 <= buf.length) {
        const len = ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
        const type = bytesToAscii(buf.subarray(off + 4, off + 8));
        const start = off + 8;

        if (type === 'tEXt' && start + len <= buf.length) {
          const chunk = buf.subarray(start, start + len);
          const zero = chunk.indexOf(0);
          if (zero >= 0) {
            texts[bytesToAscii(chunk.subarray(0, zero))] = bytesToAscii(chunk.subarray(zero + 1));
          }
        }
        if (type === 'IEND') break;
        off = start + len + 4;   // 4 字节 CRC
      }

      const b64 = texts['chara'] || texts['ccv3'] || texts['CHARACTER'];
      if (!b64) {
        reject(new Error('这个 PNG 里没有角色卡数据（没找到 chara / ccv3 文本块）'));
        return;
      }

      let bytes;
      try {
        bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      } catch (e) {
        reject(new Error('PNG 里的角色卡不是合法的 base64'));
        return;
      }

      try {
        resolve(JSON.parse(new TextDecoder('utf-8').decode(bytes)));
      } catch (e) {
        reject(new Error('PNG 里的角色卡不是合法 JSON：' + e.message));
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

/* ---- 渲染：预设 / 角色卡 ---- */

function renderPresets() {
  const preset = activePreset();

  // 预设下拉
  const sel = $('#cfg-active-preset');
  sel.textContent = '';
  for (const p of DB.presets) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  if (preset) sel.value = preset.id;

  // 模块列表
  const box = $('#module-list');
  box.textContent = '';
  if (!preset) return;

  const sorted = preset.modules.slice().sort((a, b) => a.order - b.order);
  for (const mod of sorted) {
    const card = document.createElement('div');
    card.className = 'wb-entry' + (mod.enabled ? '' : ' is-off');

    const row1 = document.createElement('div');
    row1.className = 'row';
    const idLbl = document.createElement('span');
    idLbl.className = 'mini-label';
    idLbl.textContent = mod.id;

    const nameIn = document.createElement('input');
    nameIn.type = 'text';
    nameIn.value = mod.name;
    nameIn.setAttribute('aria-label', '模块名称');
    nameIn.addEventListener('input', () => { mod.name = nameIn.value; save(); });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'small danger';
    delBtn.textContent = '删';
    delBtn.addEventListener('click', () => {
      preset.modules = preset.modules.filter(x => x.id !== mod.id);
      save(); renderPresets();
    });

    row1.appendChild(idLbl); row1.appendChild(nameIn); row1.appendChild(delBtn);

    const row2 = document.createElement('div');
    row2.className = 'row';

    const lblOn = document.createElement('label');
    lblOn.className = 'switch';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = mod.enabled;
    chk.addEventListener('change', () => { mod.enabled = chk.checked; save(); renderPresets(); });
    const spOn = document.createElement('span');
    spOn.textContent = '启用';
    lblOn.appendChild(chk); lblOn.appendChild(spOn);

    const orderLbl = document.createElement('span');
    orderLbl.className = 'mini-label';
    orderLbl.textContent = '顺序';
    const orderIn = document.createElement('input');
    orderIn.type = 'number';
    orderIn.style.width = '62px';
    orderIn.value = mod.order;
    orderIn.setAttribute('aria-label', '顺序');
    orderIn.addEventListener('input', () => {
      mod.order = Number(orderIn.value) || 0;
      save(); renderPresets();      // 重新排序显示
    });

    row2.appendChild(lblOn); row2.appendChild(orderLbl); row2.appendChild(orderIn);

    const row3 = document.createElement('div');
    row3.className = 'row';
    const ta = document.createElement('textarea');
    ta.value = mod.content;
    ta.setAttribute('aria-label', '模块正文');
    ta.addEventListener('input', () => { mod.content = ta.value; save(); });
    row3.appendChild(ta);

    card.appendChild(row1); card.appendChild(row2); card.appendChild(row3);
    box.appendChild(card);
  }
}

function renderCard() {
  const info = $('#card-info');
  info.textContent = '';

  if (!DB.card) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '还没有导入角色卡。导入后，新建的会话会用它作为默认名字和开场白。';
    info.appendChild(p);
  } else {
    const c = DB.card;
    const rows = [
      ['名称', c.name],
      ['格式', c.spec + ' / ' + c.specVersion],
      ['描述', c.description ? c.description.slice(0, 120) + (c.description.length > 120 ? '…' : '') : '（空）'],
      ['开场白', c.firstMes ? c.firstMes.slice(0, 80) + (c.firstMes.length > 80 ? '…' : '') : '（空）'],
      ['内嵌世界书', (c.entryIds || []).length + ' 条'],
      ['原始字段', Object.keys((c.raw && c.raw.data) ? c.raw.data : (c.raw || {})).length + ' 个（导出时全部保留）']
    ];
    for (const [k, v] of rows) {
      const cell = document.createElement('div');
      cell.className = 'tp-cell';
      const kk = document.createElement('span');
      kk.className = 'tp-key';
      kk.textContent = k;
      const vv = document.createElement('span');
      vv.className = 'tp-val';
      vv.textContent = v;
      cell.appendChild(kk); cell.appendChild(vv);
      info.appendChild(cell);
    }
  }

  // 字段映射表
  const mapBox = $('#card-map');
  mapBox.textContent = '';
  for (const [from, to, note] of CARD_FIELD_MAP) {
    const row = document.createElement('div');
    row.className = 'map-row';
    const a = document.createElement('code'); a.textContent = from;
    const arrow = document.createElement('span'); arrow.className = 'map-arrow'; arrow.textContent = '→';
    const b = document.createElement('code'); b.textContent = to;
    const n = document.createElement('span'); n.className = 'map-note'; n.textContent = note;
    row.appendChild(a); row.appendChild(arrow); row.appendChild(b); row.appendChild(n);
    mapBox.appendChild(row);
  }

  // 被忽略的运行规则
  const ignBox = $('#card-ignored');
  ignBox.textContent = '';
  for (const [field, why] of CARD_IGNORED) {
    const row = document.createElement('div');
    row.className = 'map-row';
    const a = document.createElement('code'); a.textContent = field;
    const n = document.createElement('span'); n.className = 'map-note'; n.textContent = why;
    row.appendChild(a); row.appendChild(n);
    ignBox.appendChild(row);
  }
}

function init() {
  load();
  bindEvents();
  renderAll();
  scrollToBottom();
  console.log('我的酒馆已启动。会话数：' + DB.sessions.length);
}

init();


