export interface Env {
  KV: KVNamespace;
  DB: D1Database;
  TG_BOT_TOKEN?: string;
  TG_CHAT_ID?: string;
  MAX_PRICE?: string;
  MARKET_MONITOR_ENABLED?: string;
  AKILE_AUTH_TOKEN?: string;
  WECHAT_WEBHOOK?: string;
}

export interface Settings {
  tgBotToken: string;
  tgChatId: string;
  maxPrice: number;
  marketMonitorEnabled: boolean;
  akileAuthToken: string;
  wechatWebhook: string;
}

export interface VpsRecord {
  id: string;
  type: "store" | "market";
  area: string;
  name: string;
  price: number;
  stock: number;
  specs: string;
  link: string;
  latency?: number; // 保存整体测试得到的 CF to LookingGlass 延迟
  updatedAt: string;

  // 细化字段用于高保真卡片展示
  cpu?: number;
  memory?: number;
  disk?: number;
  bandwidth?: number;
  flow?: number;
  flowUsed?: number;
  dueTime?: number;
  nodeName?: string;
  serverPrice?: number;
  serverCycle?: number;
  ipv4Num?: number;
  ipv6Num?: number;
  ipStatus?: string; // e.g. "[IP正常]" 或 "[IP被墙]"
  ipCheckDetail?: string; // 包含三网测速信息的字符串，如 "广州移动/13ms\n长沙联通/293ms..."
  resetPrice?: number;
}

export interface PriceData {
  cycle: number;
  price: number;
}

export interface PlanShow {
  id: number;
  plan_name: string;
  stock: number;
  price_datas: PriceData[];
  bandwidth: number;
  cpu: number;
  memory: number;
  disk: number;
  flow: number;
}

export interface NodeGroupShow {
  group_name: string;
  plans: PlanShow[];
}

export interface AreaShow {
  area_name: string;
  nodes: NodeGroupShow[];
}

export interface StoreResponse {
  status_code: number;
  status_msg: string;
  data: {
    areas: AreaShow[];
  };
}

export interface PushProduct {
  id: string;
  server_id: number;
  price: string;
  detail: string;
  name: string;
  cpu: number;
  memory: number;
  disk: number;
  bandwidth: number;
  flow: number;
  area_name: string;
  due_time?: number;
  plan_name?: string;
  node_name?: string;
  reset_price?: number;
  ip_check_detail?: string;

  // 新增缺少的三网、到期及原厂参数
  flow_used?: number;
  server_price?: number;
  server_cycle?: number;
  ipv4_num?: number;
  ipv6_num?: number;
}

export interface PushProductResponse {
  status_code: number;
  status_msg: string;
  list?: PushProduct[];
  total?: number;
}
