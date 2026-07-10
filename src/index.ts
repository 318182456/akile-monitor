export interface Env {
  KV: KVNamespace;
  TG_BOT_TOKEN?: string;
  TG_CHAT_ID?: string;
  MAX_PRICE?: string;
  MARKET_MONITOR_ENABLED?: string;
}

// 对应 Looking Glass 的延迟测量目标
const LATENCY_TARGETS: Record<string, string> = {
  "中国香港": "https://lg.hkl.akile.io",
  "香港": "https://lg.hkl.akile.io",
  "日本": "https://lg.jpl.akile.io",
  "台湾": "https://lg.twl.akile.io",
  "中国台湾": "https://lg.twl.akile.io",
  "新加坡": "https://lg.sgb.akile.io",
  "美国": "https://lg.laxp.akile.io",
  "洛杉矶": "https://lg.laxp.akile.io",
  "圣何塞": "https://lg.sjc.akile.io",
  "德国": "https://lg.de.akile.io",
  "英国": "https://lg.lon.akile.io",
  "伦敦": "https://lg.lon.akile.io"
};

// 延迟测试辅助函数：由于 Worker 限制，我们使用 fetch 测试 TCP 握手时延
async function testLatency(url: string): Promise<number> {
  const start = performance.now();
  try {
    // 使用 HEAD 请求并设置较短的超时
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 2500);
    await fetch(url, { method: "HEAD", signal: controller.signal });
    clearTimeout(id);
    return Math.round(performance.now() - start);
  } catch (e) {
    return 999; // 超时或无法连接
  }
}

interface PriceData {
  cycle: number;
  price: number;
}

interface PlanShow {
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

interface NodeGroupShow {
  group_name: string;
  plans: PlanShow[];
}

interface AreaShow {
  area_name: string;
  nodes: NodeGroupShow[];
}

interface StoreResponse {
  status_code: number;
  status_msg: string;
  data: {
    areas: AreaShow[];
  };
}

interface MarketItem {
  id: number;
  name: string;
  price: number;
  cycle: number;
  cpu: number;
  memory: number;
  disk: number;
  bandwidth: number;
  flow: number;
}

interface MarketResponse {
  status_code: number;
  status_msg: string;
  list?: MarketItem[];
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
  latency?: number;
  updatedAt: string;
}

export interface Settings {
  tgBotToken: string;
  tgChatId: string;
  maxPrice: number;
  marketMonitorEnabled: boolean;
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(this.runChecks(env));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    // 跨域处理
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 页面路由
    if (url.pathname === "/") {
      return new Response(DASHBOARD_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // API 路由: 获取当前记录
    if (url.pathname === "/api/vps") {
      const records = await this.getRecords(env);
      return new Response(JSON.stringify(records), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // API 路由: 手动刷新
    if (url.pathname === "/api/refresh" && method === "POST") {
      await this.runChecks(env);
      const records = await this.getRecords(env);
      return new Response(JSON.stringify({ success: true, list: records }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // API 路由: 获取配置
    if (url.pathname === "/api/settings" && method === "GET") {
      const settings = await this.getSettings(env);
      return new Response(JSON.stringify(settings), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // API 路由: 更改配置
    if (url.pathname === "/api/settings" && method === "POST") {
      const body = await request.json() as Partial<Settings>;
      const settings = await this.getSettings(env);
      if (body.tgBotToken !== undefined) settings.tgBotToken = body.tgBotToken;
      if (body.tgChatId !== undefined) settings.tgChatId = body.tgChatId;
      if (body.maxPrice !== undefined) settings.maxPrice = body.maxPrice;
      if (body.marketMonitorEnabled !== undefined) settings.marketMonitorEnabled = body.marketMonitorEnabled;

      await env.KV.put("config:settings", JSON.stringify(settings));
      return new Response(JSON.stringify({ success: true, settings }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    return new Response("Not Found", { status: 404 });
  },

  async getSettings(env: Env): Promise<Settings> {
    const raw = await env.KV.get("config:settings");
    if (raw) {
      return JSON.parse(raw) as Settings;
    }
    return {
      tgBotToken: env.TG_BOT_TOKEN || "",
      tgChatId: env.TG_CHAT_ID || "",
      maxPrice: parseFloat(env.MAX_PRICE || "20"),
      marketMonitorEnabled: env.MARKET_MONITOR_ENABLED === "true"
    };
  },

  async getRecords(env: Env): Promise<VpsRecord[]> {
    const list = await env.KV.list({ prefix: "vps_record_" });
    const records: VpsRecord[] = [];
    for (const key of list.keys) {
      const val = await env.KV.get(key.name);
      if (val) {
        records.push(JSON.parse(val) as VpsRecord);
      }
    }
    // 按价格从低到高排序
    return records.sort((a, b) => a.price - b.price);
  },

  async runChecks(env: Env): Promise<void> {
    const settings = await this.getSettings(env);
    await Promise.all([
      this.checkStore(env, settings),
      this.checkMarket(env, settings)
    ]);
  },

  async checkStore(env: Env, settings: Settings): Promise<void> {
    const shopCodes = ["HOT", "SJS"];
    for (const code of shopCodes) {
      try {
        const url = `https://api.akile.io/api/v1/store/GetVpsStore?shop_code=${code}`;
        const res = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          }
        });
        if (!res.ok) continue;
        const json = await res.json() as StoreResponse;
        if (json.status_code !== 200 || !json.data?.areas) continue;

        for (const area of json.data.areas) {
          for (const node of area.nodes) {
            for (const plan of node.plans) {
              if (plan.stock <= 0) continue;
              const minPriceData = plan.price_datas?.reduce((min, curr) => curr.price < min.price ? curr : min, plan.price_datas[0]);
              if (!minPriceData) continue;
              const price = minPriceData.price;

              if (price <= settings.maxPrice) {
                // 测试当前区域三网的连通时延 (由于 CF 节点测试到各个 LG 的用时能大概率反应国内链路情况)
                const lgUrl = LATENCY_TARGETS[area.area_name] || LATENCY_TARGETS[node.group_name];
                const latency = lgUrl ? await testLatency(lgUrl) : undefined;

                const id = `store_${plan.id}`;
                const record: VpsRecord = {
                  id,
                  type: "store",
                  area: area.area_name,
                  name: plan.plan_name,
                  price,
                  stock: plan.stock,
                  specs: `${plan.cpu}核 / ${plan.memory}M / ${plan.disk}G | ${plan.flow}G流量 | ${plan.bandwidth}M带宽`,
                  link: "https://akile.io/store",
                  latency,
                  updatedAt: new Date().toISOString()
                };

                // 缓存最新发现的 vps 记录
                await env.KV.put(`vps_record_${id}`, JSON.stringify(record), { expirationTtl: 86400 });

                // 差分去重推送通知
                const uniqueKey = `akile_store_vps_${plan.id}_price_${price}`;
                const cached = await env.KV.get(uniqueKey);
                if (!cached) {
                  await this.notify(env, settings, {
                    type: "store",
                    title: `[商店上新] ${area.area_name} - ${node.group_name}`,
                    planName: plan.plan_name,
                    price,
                    stock: plan.stock,
                    specs: record.specs + (latency ? ` | 测速: ${latency}ms` : ""),
                    link: record.link
                  });
                  await env.KV.put(uniqueKey, "true", { expirationTtl: 172800 });
                }
              }
            }
          }
        }
      } catch (e) {
        console.error(`Store check error: ${e}`);
      }
    }
  },

  async checkMarket(env: Env, settings: Settings): Promise<void> {
    if (!settings.marketMonitorEnabled) return;

    try {
      const url = "https://api.akile.io/api/v1/market/GetMarketList";
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        },
        body: JSON.stringify({ page_num: 1, page_size: 20 })
      });
      if (!res.ok) return;
      const json = await res.json() as MarketResponse;
      if (json.status_code !== 0 || !json.list) return;

      for (const item of json.list) {
        if (item.price <= settings.maxPrice) {
          // 延迟测速
          const matches = Object.keys(LATENCY_TARGETS).filter(k => item.name.includes(k));
          const lgUrl = matches.length > 0 ? LATENCY_TARGETS[matches[0]] : undefined;
          const latency = lgUrl ? await testLatency(lgUrl) : undefined;

          const id = `market_${item.id}`;
          const record: VpsRecord = {
            id,
            type: "market",
            area: matches.length > 0 ? matches[0] : "交易市场",
            name: item.name,
            price: item.price,
            stock: 1,
            specs: `${item.cpu}核 / ${item.memory}M / ${item.disk}G | ${item.flow}G流量 | ${item.bandwidth}M带宽`,
            link: "https://akile.io/exchange",
            latency,
            updatedAt: new Date().toISOString()
          };

          await env.KV.put(`vps_record_${id}`, JSON.stringify(record), { expirationTtl: 86400 });

          const uniqueKey = `akile_market_vps_${item.id}_price_${item.price}`;
          const cached = await env.KV.get(uniqueKey);
          if (!cached) {
            await this.notify(env, settings, {
              type: "market",
              title: `[市场低价] 二手机上架`,
              planName: item.name,
              price: item.price,
              stock: 1,
              specs: record.specs + (latency ? ` | 测速: ${latency}ms` : ""),
              link: record.link
            });
            await env.KV.put(uniqueKey, "true", { expirationTtl: 172800 });
          }
        }
      }
    } catch (e) {
      console.error(`Market check error: ${e}`);
    }
  },

  async notify(env: Env, settings: Settings, data: { type: string; title: string; planName: string; price: number; stock: number; specs: string; link: string }): Promise<void> {
    if (!settings.tgBotToken || !settings.tgChatId) {
      console.log("Notification credentials missing. Outputting log:", data);
      return;
    }

    const message = `🔔 *${data.title}*\n\n` +
      `📦 *商品:* ${data.planName}\n` +
      `💰 *价格:* ${data.price} JPY/CNY (库存: ${data.stock})\n` +
      `💻 *配置:* ${data.specs}\n\n` +
      `🔗 [立即购买](${data.link})`;

    try {
      const url = `https://api.telegram.org/bot${settings.tgBotToken}/sendMessage`;
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: settings.tgChatId,
          text: message,
          parse_mode: "Markdown",
          disable_web_page_preview: true
        })
      });
    } catch (e) {
      console.error("Failed to send telegram notification:", e);
    }
  }
};

// HTML 控制面板模板：前沿科技感，Dark Mode，Glassmorphism，微动画与交互
const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Akile VPS 交易监控中心</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #030712;
      --card-bg: rgba(17, 24, 39, 0.7);
      --border: rgba(255, 255, 255, 0.08);
      --primary: #8b5cf6;
      --primary-hover: #a78bfa;
      --accent: #06b6d4;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      background-image: radial-gradient(circle at 10% 20%, rgba(139, 92, 246, 0.15) 0%, transparent 40%),
                        radial-gradient(circle at 90% 80%, rgba(6, 182, 212, 0.15) 0%, transparent 40%);
      background-attachment: fixed;
    }
    header {
      padding: 2rem;
      border-bottom: 1px solid var(--border);
      backdrop-filter: blur(12px);
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    header h1 {
      font-size: 1.5rem;
      font-weight: 800;
      background: linear-gradient(to right, #a78bfa, #06b6d4);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .badge {
      font-size: 0.75rem;
      padding: 0.25rem 0.5rem;
      border-radius: 9999px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .badge-store { background: rgba(139, 92, 246, 0.2); color: #c084fc; border: 1px solid rgba(139, 92, 246, 0.3); }
    .badge-market { background: rgba(6, 182, 212, 0.2); color: #22d3ee; border: 1px solid rgba(6, 182, 212, 0.3); }
    
    .btn {
      background: var(--primary);
      color: white;
      border: none;
      padding: 0.75rem 1.5rem;
      border-radius: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      align-items: center;
      gap: 0.5rem;
      box-shadow: 0 4px 14px 0 rgba(139, 92, 246, 0.3);
    }
    .btn:hover {
      background: var(--primary-hover);
      transform: translateY(-2px);
      box-shadow: 0 6px 20px 0 rgba(139, 92, 246, 0.4);
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }
    .container {
      max-width: 1200px;
      margin: 2rem auto;
      padding: 0 1.5rem;
      width: 100%;
      flex-grow: 1;
      display: grid;
      grid-template-columns: 1fr 380px;
      gap: 2rem;
    }
    @media (max-width: 968px) {
      .container {
        grid-template-columns: 1fr;
      }
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 2rem;
      backdrop-filter: blur(16px);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    }
    .card-title {
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 1.5rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .vps-list {
      display: grid;
      gap: 1rem;
    }
    .vps-item {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      transition: all 0.3s ease;
      position: relative;
      overflow: hidden;
    }
    .vps-item:hover {
      border-color: rgba(139, 92, 246, 0.3);
      background: rgba(255, 255, 255, 0.04);
      transform: scale(1.01);
    }
    .vps-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
    }
    .vps-name-area {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    .vps-area {
      font-size: 0.85rem;
      color: var(--text-muted);
      font-weight: 600;
    }
    .vps-name {
      font-size: 1.1rem;
      font-weight: 600;
    }
    .vps-price {
      font-size: 1.25rem;
      font-weight: 800;
      color: #34d399;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
    }
    .vps-price span {
      font-size: 0.75rem;
      color: var(--text-muted);
      font-weight: 400;
    }
    .vps-details {
      font-size: 0.9rem;
      color: var(--text-muted);
      line-height: 1.4;
    }
    .vps-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 0.25rem;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      padding-top: 0.75rem;
    }
    .vps-latency {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.85rem;
      font-weight: 600;
    }
    .latency-indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .latency-green { background: #10b981; color: #34d399; }
    .latency-yellow { background: #f59e0b; color: #fbbf24; }
    .latency-red { background: #ef4444; color: #f87171; }
    
    .buy-link {
      font-size: 0.85rem;
      color: var(--primary-hover);
      text-decoration: none;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.25rem;
      transition: color 0.2s;
    }
    .buy-link:hover {
      color: white;
    }

    /* 表单设置页 */
    .form-group {
      margin-bottom: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .form-group label {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .form-group input, .form-group select {
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 0.75rem 1rem;
      color: white;
      font-family: inherit;
      font-size: 0.95rem;
      transition: border-color 0.2s;
    }
    .form-group input:focus {
      outline: none;
      border-color: var(--primary);
    }
    .switch-container {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.5rem 0;
    }
    .switch {
      position: relative;
      display: inline-block;
      width: 48px;
      height: 24px;
    }
    .switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .slider {
      position: absolute;
      cursor: pointer;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-color: rgba(255, 255, 255, 0.1);
      transition: .4s;
      border-radius: 34px;
      border: 1px solid var(--border);
    }
    .slider:before {
      position: absolute;
      content: "";
      height: 16px;
      width: 16px;
      left: 3px;
      bottom: 3px;
      background-color: white;
      transition: .4s;
      border-radius: 50%;
    }
    input:checked + .slider {
      background-color: var(--primary);
    }
    input:checked + .slider:before {
      transform: translateX(24px);
    }
    .empty-state {
      text-align: center;
      padding: 4rem 2rem;
      color: var(--text-muted);
    }
    .empty-state svg {
      width: 48px;
      height: 48px;
      stroke: var(--text-muted);
      margin-bottom: 1rem;
    }
    .toast {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      background: rgba(16, 185, 129, 0.9);
      color: white;
      padding: 1rem 1.5rem;
      border-radius: 12px;
      font-weight: 600;
      backdrop-filter: blur(8px);
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
      transform: translateY(150%);
      transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      z-index: 100;
    }
    .toast.show {
      transform: translateY(0);
    }
  </style>
</head>
<body>
  <header>
    <h1>⚡ Akile VPS 监控控制台</h1>
    <button class="btn" id="refreshBtn" onclick="triggerRefresh()">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
      <span>手动刷新 & 测速</span>
    </button>
  </header>

  <div class="container">
    <!-- 监听到的便宜VPS -->
    <div class="card">
      <div class="card-title">
        <span>当前监听到的廉价 VPS 列表 (已在 KV 差分归档)</span>
        <span style="font-size: 0.85rem; font-weight: 400; color: var(--text-muted);" id="lastUpdate">未更新</span>
      </div>
      <div class="vps-list" id="vpsList">
        <!-- 载入时显示 Spinner -->
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-loader"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>
          <p>正在获取 VPS 列表与连通时延数据...</p>
        </div>
      </div>
    </div>

    <!-- 监控配置表单 -->
    <div class="card" style="align-self: start;">
      <div class="card-title">监控策略与通知配置</div>
      <form id="settingsForm" onsubmit="saveSettings(event)">
        <div class="form-group">
          <label for="tgBotToken">Telegram Bot Token</label>
          <input type="password" id="tgBotToken" placeholder="输入 TG 机器人 Token" required>
        </div>
        <div class="form-group">
          <label for="tgChatId">Telegram Chat ID</label>
          <input type="text" id="tgChatId" placeholder="输入接收通知的 Chat ID" required>
        </div>
        <div class="form-group">
          <label for="maxPrice">最大通知价格阈值 (JPY/CNY)</label>
          <input type="number" id="maxPrice" placeholder="如 20" required>
        </div>
        <div class="form-group switch-container">
          <label for="marketMonitor">监控二手交易市场 (Exchange)</label>
          <label class="switch">
            <input type="checkbox" id="marketMonitor">
            <span class="slider"></span>
          </label>
        </div>
        <button type="submit" class="btn" style="width: 100%; margin-top: 1rem; justify-content: center;">保存配置</button>
      </form>
    </div>
  </div>

  <div class="toast" id="toast">配置保存成功！</div>

  <script>
    async function fetchVpsList() {
      try {
        const res = await fetch("/api/vps");
        const list = await res.json();
        const listContainer = document.getElementById("vpsList");
        
        if (list.length === 0) {
          listContainer.innerHTML = \`
            <div class="empty-state">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <p>暂无符合价格阈值的便宜 VPS，系统正在监控中...</p>
            </div>\`;
          return;
        }

        listContainer.innerHTML = list.map(item => {
          let latencyClass = 'latency-green';
          let latencyText = '未测试';
          if (item.latency !== undefined) {
            latencyText = item.latency + ' ms';
            if (item.latency > 300) latencyClass = 'latency-red';
            else if (item.latency > 150) latencyClass = 'latency-yellow';
          }

          return \`
            <div class="vps-item">
              <div class="vps-header">
                <div class="vps-name-area">
                  <span class="vps-area">\${item.area}</span>
                  <span class="vps-name">\${item.name}</span>
                </div>
                <div class="vps-price">
                  ￥\${item.price}
                  <span>\${item.type === 'store' ? '官方商店' : '二手交易'}</span>
                </div>
              </div>
              <div class="vps-details">\${item.specs}</div>
              <div class="vps-footer">
                <div class="vps-latency \${latencyClass}">
                  <span class="latency-indicator \${latencyClass}"></span>
                  三网握手时延: \${latencyText}
                </div>
                <a href="\${item.link}" target="_blank" class="buy-link">
                  立即抢购
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                </a>
              </div>
            </div>
          \`;
        }).join("");
        
        document.getElementById("lastUpdate").innerText = "已更新: " + new Date().toLocaleTimeString();
      } catch (e) {
        console.error(e);
      }
    }

    async function fetchSettings() {
      try {
        const res = await fetch("/api/settings");
        const settings = await res.json();
        document.getElementById("tgBotToken").value = settings.tgBotToken || "";
        document.getElementById("tgChatId").value = settings.tgChatId || "";
        document.getElementById("maxPrice").value = settings.maxPrice || 20;
        document.getElementById("marketMonitor").checked = settings.marketMonitorEnabled;
      } catch (e) {
        console.error(e);
      }
    }

    async function saveSettings(e) {
      e.preventDefault();
      const tgBotToken = document.getElementById("tgBotToken").value;
      const tgChatId = document.getElementById("tgChatId").value;
      const maxPrice = parseFloat(document.getElementById("maxPrice").value);
      const marketMonitorEnabled = document.getElementById("marketMonitor").checked;

      try {
        const res = await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tgBotToken, tgChatId, maxPrice, marketMonitorEnabled })
        });
        if (res.ok) {
          showToast("配置保存成功！");
          fetchVpsList();
        }
      } catch (e) {
        showToast("配置保存失败，请检查网络", true);
      }
    }

    async function triggerRefresh() {
      const btn = document.getElementById("refreshBtn");
      btn.disabled = true;
      btn.querySelector("span").innerText = "刷新测速中...";
      
      try {
        const res = await fetch("/api/refresh", { method: "POST" });
        if (res.ok) {
          showToast("抓取与延迟测试完成！");
          await fetchVpsList();
        }
      } catch (e) {
        showToast("手动刷新失败", true);
      } finally {
        btn.disabled = false;
        btn.querySelector("span").innerText = "手动刷新 & 测速";
      }
    }

    function showToast(msg, isError = false) {
      const t = document.getElementById("toast");
      t.innerText = msg;
      t.style.background = isError ? "rgba(239, 68, 68, 0.9)" : "rgba(16, 185, 129, 0.9)";
      t.classList.add("show");
      setTimeout(() => t.classList.remove("show"), 3000);
    }

    // 初始化
    fetchSettings();
    fetchVpsList();
  </script>
</body>
</html>
`;
