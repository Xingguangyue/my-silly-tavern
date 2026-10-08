const STORE_KEY = 'tavern.db.v1';
const DB = {
  sessions: [],                 //  对话内容 [{id, name, createdAt}]
  messages: {},                 // 历史记录 { sessionId: [消息对象, ...] }
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
      console.error('存档损坏，已忽略：', error);
    }
  }
}