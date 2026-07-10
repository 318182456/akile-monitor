import { Env, Settings, VpsRecord } from "./types";
import { runChecks } from "./monitor";

// @ts-ignore - wrangler.toml matches *.html files via text loader
import DASHBOARD_HTML from "./index.html";
// @ts-ignore
import SETTINGS_HTML from "./settings.html";

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(this.initializeDb(env).then(() => this.runChecks(env)));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 自动初始化/检查表是否存在
    await this.initializeDb(env);

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

    if (url.pathname === "/settings") {
      return new Response(SETTINGS_HTML, {
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

    // API 路由: 获取指定主机的历史成交走势
    if (url.pathname === "/api/vps/history" && method === "GET") {
      const name = url.searchParams.get("name") || "";
      const nodeName = url.searchParams.get("nodeName") || "";
      try {
        const { results } = await env.DB.prepare(`
          SELECT price, updated_at as updatedAt
          FROM vps_records
          WHERE name = ? AND node_name = ?
          ORDER BY updated_at ASC
          LIMIT 100
        `).bind(name, nodeName).all<{ price: number; updatedAt: string }>();

        return new Response(JSON.stringify(results || []), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
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
      if (body.akileAuthToken !== undefined) settings.akileAuthToken = body.akileAuthToken;
      if (body.wechatWebhook !== undefined) settings.wechatWebhook = body.wechatWebhook;

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
      marketMonitorEnabled: env.MARKET_MONITOR_ENABLED === "true",
      akileAuthToken: env.AKILE_AUTH_TOKEN || "",
      wechatWebhook: env.WECHAT_WEBHOOK || ""
    };
  },

  async getRecords(env: Env): Promise<VpsRecord[]> {
    try {
      const { results } = await env.DB.prepare(`
        SELECT 
          id, type, area, name, price, stock, specs, link, latency, updated_at as updatedAt,
          cpu, memory, disk, bandwidth, flow, flow_used as flowUsed, due_time as dueTime, node_name as nodeName,
          server_price as serverPrice, server_cycle as serverCycle, ipv4_num as ipv4Num, ipv6_num as ipv6Num,
          ip_status as ipStatus, ip_check_detail as ipCheckDetail, reset_price as resetPrice
        FROM vps_records
        WHERE stock > 0
      `).all<any>();

      if (!results) return [];

      return results.map(row => ({
        id: row.id,
        type: row.type as "store" | "market",
        area: row.area,
        name: row.name,
        price: row.price,
        stock: row.stock,
        specs: row.specs,
        link: row.link,
        latency: row.latency !== null ? row.latency : undefined,
        updatedAt: row.updatedAt,
        cpu: row.cpu !== null ? row.cpu : undefined,
        memory: row.memory !== null ? row.memory : undefined,
        disk: row.disk !== null ? row.disk : undefined,
        bandwidth: row.bandwidth !== null ? row.bandwidth : undefined,
        flow: row.flow !== null ? row.flow : undefined,
        flowUsed: row.flowUsed !== null ? row.flowUsed : undefined,
        dueTime: row.dueTime !== null ? row.dueTime : undefined,
        nodeName: row.nodeName !== null ? row.nodeName : undefined,
        serverPrice: row.serverPrice !== null ? row.serverPrice : undefined,
        serverCycle: row.serverCycle !== null ? row.serverCycle : undefined,
        ipv4Num: row.ipv4Num !== null ? row.ipv4Num : undefined,
        ipv6Num: row.ipv6Num !== null ? row.ipv6Num : undefined,
        ipStatus: row.ipStatus !== null ? row.ipStatus : undefined,
        ipCheckDetail: row.ipCheckDetail !== null ? row.ipCheckDetail : undefined,
        resetPrice: row.resetPrice !== null ? row.resetPrice : undefined
      }));
    } catch (e) {
      console.error(`Failed to query VPS records from D1: ${e}`);
      return [];
    }
  },

  async runChecks(env: Env): Promise<void> {
    const settings = await this.getSettings(env);
    await runChecks(env, settings);
  },

  async initializeDb(env: Env): Promise<void> {
    try {
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS vps_records (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          area TEXT NOT NULL,
          name TEXT NOT NULL,
          price REAL NOT NULL,
          stock INTEGER NOT NULL,
          specs TEXT NOT NULL,
          link TEXT NOT NULL,
          latency INTEGER,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          cpu INTEGER,
          memory INTEGER,
          disk INTEGER,
          bandwidth INTEGER,
          flow INTEGER,
          flow_used INTEGER,
          due_time INTEGER,
          node_name TEXT,
          server_price REAL,
          server_cycle INTEGER,
          ipv4_num INTEGER,
          ipv6_num INTEGER,
          ip_status TEXT,
          ip_check_detail TEXT,
          reset_price REAL
        )
      `).run();

      // 创建索引提高性能
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_vps_price ON vps_records(price)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_vps_updated ON vps_records(updated_at)`).run();
    } catch (e) {
      console.error(`Failed to initialize D1 database schema: ${e}`);
    }
  }
};
