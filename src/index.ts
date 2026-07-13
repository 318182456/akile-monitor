import { Env, Settings, VpsRecord } from "./types";
import { runChecks } from "./monitor";


// @ts-ignore - wrangler.toml matches *.html files via text loader
import DASHBOARD_HTML from "./index.html";
// @ts-ignore
import SETTINGS_HTML from "./settings.html";
// @ts-ignore
import LOGIN_HTML from "./login.html";

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/types';
import { LINE_META } from "./lines";

interface StoredPasskey {
  id: string;         // credential ID（base64url）
  publicKey: string;  // Uint8Array → base64url
  counter: number;
  transports?: string[];
  name: string;
  createdAt: string;
}

function u8ToB64url(u: Uint8Array): string {
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

function b64urlToU8(s: string): Uint8Array {
  const b = s.replace(/-/g,'+').replace(/_/g,'/').padEnd(s.length + (4 - s.length%4)%4, '=');
  return new Uint8Array(atob(b).split('').map(c => c.charCodeAt(0)));
}

function getOrigins(request: Request): string | string[] {
  const origin = new URL(request.url).origin;
  if (origin.includes('localhost') || origin.includes('127.0.0.1'))
    return [origin, 'http://localhost:3000', 'http://localhost:8787'];
  return origin;
}

function isAuthed(request: Request, env: Env): boolean {
  const pwd = env.ADMIN_PASSWORD || 'admin888';
  
  // Try Authorization header first
  const h = request.headers.get('Authorization') || '';
  if (h.startsWith('Bearer ') && h.slice(7) === pwd) {
    return true;
  }
  
  // Try Cookie next
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;)\s*admin_token\s*=\s*([^;]+)/);
  if (match && match[1] === pwd) {
    return true;
  }
  
  return false;
}

async function getPasskeys(kv: KVNamespace): Promise<StoredPasskey[]> {
  const raw = await kv.get('passkeys');
  return raw ? JSON.parse(raw) : [];
}

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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const jsonResponse = (data: any, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    };

    // 页面路由
    if (url.pathname === "/") {
      return new Response(DASHBOARD_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    if (url.pathname === "/login") {
      return new Response(LOGIN_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    if (url.pathname === "/settings") {
      if (!isAuthed(request, env)) {
        return Response.redirect(`${url.origin}/login?redirect=${encodeURIComponent(url.pathname)}`, 302);
      }
      return new Response(SETTINGS_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // API 路由: 获取当前记录
    if (url.pathname === "/api/vps") {
      const records = await this.getRecords(env);
      return jsonResponse(records);
    }

    // API 路由: 获取线路元数据
    if (url.pathname === "/api/lines") {
      return jsonResponse(LINE_META);
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

        return jsonResponse(results || []);
      } catch (e) {
        return jsonResponse({ error: String(e) }, 500);
      }
    }

    // ---------- Passkey 状态 (公共) ----------
    if (url.pathname === "/api/auth/passkey/status" && method === "GET") {
      const list = await getPasskeys(env.KV);
      return jsonResponse({ count: list.length });
    }

    // ---------- Passkey 登录 (公共) ----------
    if (url.pathname === "/api/auth/passkey/login/begin" && method === "POST") {
      const stored = await getPasskeys(env.KV);
      const rpID = url.hostname;

      const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: stored.map(p => ({
          id: p.id,
          transports: (p.transports ?? []) as AuthenticatorTransportFuture[],
        })),
        userVerification: 'preferred',
      });

      await env.KV.put('passkey:auth_challenge', options.challenge, { expirationTtl: 300 });
      return jsonResponse(options);
    }

    if (url.pathname === "/api/auth/passkey/login/finish" && method === "POST") {
      const expectedChallenge = await env.KV.get('passkey:auth_challenge');
      if (!expectedChallenge) return jsonResponse({ error: 'Challenge 已过期' }, 400);

      const body = await request.json<AuthenticationResponseJSON>();
      const stored = await getPasskeys(env.KV);
      const passkey = stored.find(p => p.id === body.id);
      if (!passkey) return jsonResponse({ error: '未找到对应的 Passkey' }, 404);

      const rpID = url.hostname;
      const authenticator = {
        credentialID:        passkey.id,
        credentialPublicKey: b64urlToU8(passkey.publicKey) as any,
        counter:             passkey.counter,
        transports:          (passkey.transports ?? []) as AuthenticatorTransportFuture[],
      };

      let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
      try {
        verification = await verifyAuthenticationResponse({
          response: body,
          expectedChallenge,
          expectedOrigin: getOrigins(request),
          expectedRPID: rpID,
          authenticator,
        } as any);
      } catch (e) {
        return jsonResponse({ error: String(e) }, 400);
      }

      if (!verification.verified) return jsonResponse({ error: 'Passkey 验证失败' }, 401);

      // 更新计数器防重放
      passkey.counter = verification.authenticationInfo.newCounter;
      await env.KV.put('passkeys', JSON.stringify(stored));
      await env.KV.delete('passkey:auth_challenge');

      const pwd = env.ADMIN_PASSWORD || 'admin888';
      return jsonResponse({ token: pwd });
    }

    // ---------- 需要认证的接口 ----------
    if (!isAuthed(request, env)) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    // Passkey 列表
    if (url.pathname === "/api/auth/passkey/list" && method === "GET") {
      const list = await getPasskeys(env.KV);
      return jsonResponse(list.map(p => ({ id: p.id, name: p.name, createdAt: p.createdAt })));
    }

    // Passkey 删除
    if (url.pathname.startsWith("/api/auth/passkey/delete/") && method === "DELETE") {
      const credId = url.pathname.slice("/api/auth/passkey/delete/".length);
      const list = await getPasskeys(env.KV);
      await env.KV.put('passkeys', JSON.stringify(list.filter(p => p.id !== credId)));
      return jsonResponse({ ok: true });
    }

    // Passkey 注册
    if (url.pathname === "/api/auth/passkey/register/begin" && method === "POST") {
      const stored = await getPasskeys(env.KV);
      const rpID = url.hostname;

      const options = await generateRegistrationOptions({
        rpName: 'Akile Monitor',
        rpID,
        userID: new TextEncoder().encode('admin') as any,
        userName: 'admin',
        userDisplayName: 'Akile Monitor Admin',
        excludeCredentials: stored.map(p => ({
          id: p.id,
          transports: (p.transports ?? []) as AuthenticatorTransportFuture[],
        })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      });

      await env.KV.put('passkey:reg_challenge', options.challenge, { expirationTtl: 300 });
      return jsonResponse(options);
    }

    if (url.pathname === "/api/auth/passkey/register/finish" && method === "POST") {
      const expectedChallenge = await env.KV.get('passkey:reg_challenge');
      if (!expectedChallenge) return jsonResponse({ error: 'Challenge 已过期，请重新开始' }, 400);

      const body = await request.json<RegistrationResponseJSON>();
      const rpID = url.hostname;

      let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try {
        verification = await verifyRegistrationResponse({
          response: body,
          expectedChallenge,
          expectedOrigin: getOrigins(request),
          expectedRPID: rpID,
        });
      } catch (e) {
        return jsonResponse({ error: String(e) }, 400);
      }

      if (!verification.verified || !verification.registrationInfo)
        return jsonResponse({ error: '注册验证失败' }, 400);

      const { registrationInfo } = verification;
      const credentialID        = (registrationInfo as any).credentialID        ?? (registrationInfo as any).credential?.id;
      const credentialPublicKey = (registrationInfo as any).credentialPublicKey ?? (registrationInfo as any).credential?.publicKey;
      const counter             = (registrationInfo as any).counter              ?? (registrationInfo as any).credential?.counter ?? 0;
      const credential = { id: credentialID as string, publicKey: credentialPublicKey as Uint8Array, counter: counter as number };
      const stored = await getPasskeys(env.KV);
      const newKey: StoredPasskey = {
        id: credential.id,
        publicKey: u8ToB64url(credential.publicKey),
        counter: credential.counter,
        transports: body.response.transports ?? [],
        name: `Passkey ${stored.length + 1}`,
        createdAt: new Date().toISOString(),
      };
      stored.push(newKey);
      await env.KV.put('passkeys', JSON.stringify(stored));
      await env.KV.delete('passkey:reg_challenge');
      return jsonResponse({ ok: true, name: newKey.name });
    }

    // API 路由: 手动刷新
    if (url.pathname === "/api/refresh" && method === "POST") {
      await this.runChecks(env);
      const records = await this.getRecords(env);
      return jsonResponse({ success: true, list: records });
    }

    // API 路由: 获取配置
    if (url.pathname === "/api/settings" && method === "GET") {
      const settings = await this.getSettings(env);
      return jsonResponse(settings);
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
      if (body.akileEmail !== undefined) settings.akileEmail = body.akileEmail;
      if (body.akilePassword !== undefined) settings.akilePassword = body.akilePassword;
      if (body.akileTotpSecret !== undefined) settings.akileTotpSecret = body.akileTotpSecret;

      await env.KV.put("config:settings", JSON.stringify(settings));
      return jsonResponse({ success: true, settings });
    }

    return new Response("Not Found", { status: 404 });
  },

  async getSettings(env: Env): Promise<Settings> {
    const raw = await env.KV.get("config:settings");
    let settings: Settings;
    if (raw) {
      settings = JSON.parse(raw) as Settings;
    } else {
      settings = {
        tgBotToken: env.TG_BOT_TOKEN || "",
        tgChatId: env.TG_CHAT_ID || "",
        maxPrice: parseFloat(env.MAX_PRICE || "20"),
        marketMonitorEnabled: env.MARKET_MONITOR_ENABLED === "true",
        akileAuthToken: env.AKILE_AUTH_TOKEN || "",
        wechatWebhook: env.WECHAT_WEBHOOK || "",
        akileEmail: "",
        akilePassword: "",
        akileTotpSecret: ""
      };
    }

    if (!settings.akileEmail && env.AKILE_EMAIL) settings.akileEmail = env.AKILE_EMAIL;
    if (!settings.akilePassword && env.AKILE_PASSWORD) settings.akilePassword = env.AKILE_PASSWORD;
    if (!settings.akileTotpSecret && env.AKILE_TOTP_SECRET) settings.akileTotpSecret = env.AKILE_TOTP_SECRET;

    return settings;
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
