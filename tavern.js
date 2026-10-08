const STORE_KEY = 'tavern.db.v1';
const DB = {
  sessions: [],                 // [{id, name, createdAt}]
  messages: {},                 // { sessionId: [消息对象, ...] }
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