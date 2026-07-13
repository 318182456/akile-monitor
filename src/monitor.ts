import { Env, Settings, VpsRecord, StoreResponse, PushProductResponse, LineMeta } from "./types";

// 对应 Looking Glass 的延迟测量目标
export const LATENCY_TARGETS: Record<string, string> = {
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
export async function testLatency(url: string): Promise<number> {
  const start = performance.now();
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 2500);
    await fetch(url, { method: "HEAD", signal: controller.signal });
    clearTimeout(id);
    return Math.round(performance.now() - start);
  } catch (e) {
    return 999;
  }
}

export function parseTestTime(detail: string | undefined | null, fallbackTime?: string): string {
  const fallback = fallbackTime || new Date().toISOString();
  if (!detail) return fallback;
  const match = detail.match(/测试时间:\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
  if (match) {
    // 假设 API 返回的是北京时间 (UTC+8)
    const localTimeStr = match[1].replace(" ", "T") + "+08:00";
    try {
      return new Date(localTimeStr).toISOString();
    } catch (e) {
      // fallback
    }
  }
  return fallback;
}

export function getPriceInCNY(price: number, area?: string): number {
  let val = price;
  if (Number.isInteger(val) && val > 100) {
    val = val / 100;
  }
  if (area && (area.includes("日本") || area.toLowerCase().includes("jp"))) {
    return val * 0.047;
  }
  return val;
}

export async function runChecks(env: Env, settings: Settings): Promise<void> {
  await Promise.all([
    checkStore(env, settings),
    checkMarket(env, settings)
  ]);
}

export async function checkStore(env: Env, settings: Settings): Promise<void> {
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
            const id = `store_${plan.id}`;
            const uniqueKey = `akile_store_vps_${plan.id}_price_${price}`;
            const cached = await env.KV.get(uniqueKey);

            let latency: number | undefined = undefined;
            if (cached) {
              try {
                const existing = await env.DB.prepare("SELECT latency FROM vps_records WHERE id = ?").bind(id).first<{ latency: number | null }>();
                if (existing && existing.latency !== null) {
                  latency = existing.latency;
                }
              } catch (e) {}
            } else {
              const lgUrl = LATENCY_TARGETS[area.area_name] || LATENCY_TARGETS[node.group_name];
              latency = lgUrl ? await testLatency(lgUrl) : undefined;
            }

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
              updatedAt: new Date().toISOString(),

              // 拆分细节属性
              cpu: plan.cpu,
              memory: plan.memory,
              disk: plan.disk,
              bandwidth: plan.bandwidth,
              flow: plan.flow,
              nodeName: node.group_name,
              ipv4Num: 1,
              ipv6Num: 1,
              ipStatus: "[IP正常]"
            };

            // 写入 D1 数据库 (不管价格多少，一律写入)
            try {
              await env.DB.prepare(`
                INSERT INTO vps_records (
                  id, type, area, name, price, stock, specs, link, latency, updated_at,
                  cpu, memory, disk, bandwidth, flow, node_name, ipv4_num, ipv6_num, ip_status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  price = excluded.price,
                  stock = excluded.stock,
                  specs = excluded.specs,
                  link = excluded.link,
                  latency = COALESCE(excluded.latency, vps_records.latency),
                  updated_at = CASE 
                    WHEN vps_records.stock <= 0 AND excluded.stock > 0 THEN excluded.updated_at
                    WHEN vps_records.price != excluded.price THEN excluded.updated_at
                    ELSE vps_records.updated_at
                  END,
                  cpu = excluded.cpu,
                  memory = excluded.memory,
                  disk = excluded.disk,
                  bandwidth = excluded.bandwidth,
                  flow = excluded.flow,
                  node_name = excluded.node_name,
                  ipv4_num = excluded.ipv4_num,
                  ipv6_num = excluded.ipv6_num,
                  ip_status = excluded.ip_status
              `).bind(
                record.id, record.type, record.area, record.name, record.price, record.stock, record.specs, record.link, record.latency || null, record.updatedAt,
                record.cpu || null, record.memory || null, record.disk || null, record.bandwidth || null, record.flow || null, record.nodeName || null,
                record.ipv4Num || null, record.ipv6Num || null, record.ipStatus || null
              ).run();
            } catch (err) {
              console.error(`Failed to write store record to D1: ${err}`);
            }

            // 按照人民币价格过滤
            const priceInCNY = getPriceInCNY(price, area.area_name);

            // 只有符合最大价格阈值且未推送过才触发通知
            if (priceInCNY <= settings.maxPrice && !cached) {
              await notify(env, settings, {
                type: "store",
                title: `[商店上新] ${area.area_name} - ${node.group_name}`,
                planName: plan.plan_name,
                price: `¥${priceInCNY.toFixed(2)} (${price} JPY)`,
                stock: plan.stock,
                specs: record.specs + (latency ? ` | 测速: ${latency}ms` : ""),
                link: record.link
              });
              await env.KV.put(uniqueKey, "true", { expirationTtl: 172800 });
            }
          }
        }
      }
    } catch (e) {
      console.error(`Store check error: ${e}`);
    }
  }
}

export async function checkMarket(env: Env, settings: Settings): Promise<void> {
  if (!settings.marketMonitorEnabled) return;

  if (!settings.akileAuthToken) {
    if (settings.akileEmail && settings.akilePassword && settings.akileTotpSecret) {
      console.log("[Market Monitor] Token not found. Attempting initial login...");
      await refreshAkileToken(env, settings);
    }
    
    if (!settings.akileAuthToken) {
      console.warn("Market monitor is enabled but Akile Authorization Token is not configured. Suppressing check to avoid 401 errors.");
      return;
    }
  }

  console.log("[Market Monitor] Starting check for Akile market products...");

  try {
    const url = "https://api.akile.ai/api/v1/pushshop/GetPushProductList";
    const headers: Record<string, string> = {
      "Content-Type": "application/json;charset=UTF-8",
      "Referer": "https://akile.ai/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/149.0.0.0",
      "Accept": "application/json, text/plain, */*",
      "sec-ch-ua-platform": '"Windows"',
      "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
      "sec-ch-ua-mobile": "?0"
    };

    let token = settings.akileAuthToken.trim();
    headers["Authorization"] = token;

    let res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        page_num: 1,
        page_size: 300
      })
    });

    if (res.status === 401) {
      console.warn("Market pushshop API returned 401 Unauthorized. Attempting token refresh...");
      const refreshedToken = await refreshAkileToken(env, settings);
      if (refreshedToken) {
        console.log("Token refreshed. Retrying market product list fetch...");
        headers["Authorization"] = refreshedToken.trim();
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            page_num: 1,
            page_size: 300
          })
        });
      }
    }

    if (!res.ok) {
      console.error(`Market pushshop API error. HTTP Status: ${res.status}`);
      return;
    }
    const json = await res.json() as PushProductResponse;
    if (json.status_code !== 0 || !json.list) {
      console.warn(`Market pushshop API returned code: ${json.status_code}`);
      return;
    }

    console.log(`[Market Monitor] Successfully fetched ${json.list.length} market products from pushshop API.`);

    for (const item of json.list) {
      const itemPrice = parseFloat(item.price);
      const id = `market_${item.id}`;
      const uniqueKey = `akile_market_vps_${item.id}_price_${item.price}`;
      const cached = await env.KV.get(uniqueKey);

      let latency: number | undefined = undefined;
      let existingUpdatedAt: string | undefined = undefined;
      if (cached) {
        try {
          const existing = await env.DB.prepare("SELECT latency, updated_at as updatedAt FROM vps_records WHERE id = ?").bind(id).first<{ latency: number | null, updatedAt: string | null }>();
          if (existing) {
            if (existing.latency !== null) latency = existing.latency;
            if (existing.updatedAt) existingUpdatedAt = existing.updatedAt;
          }
        } catch (e) {}
      } else {
        const matches = Object.keys(LATENCY_TARGETS).filter(k => item.name.includes(k) || item.area_name.includes(k));
        const lgUrl = matches.length > 0 ? LATENCY_TARGETS[matches[0]] : undefined;
        latency = lgUrl ? await testLatency(lgUrl) : undefined;
      }

      const record: VpsRecord = {
        id,
        type: "market",
        area: item.area_name || (Object.keys(LATENCY_TARGETS).filter(k => item.name.includes(k) || item.area_name.includes(k))[0] || "交易市场"),
        name: item.name,
        price: itemPrice,
        stock: 1,
        specs: `${item.cpu}核 / ${item.memory}M / ${item.disk}G | ${item.flow}G流量 | ${item.bandwidth}M带宽`,
        link: "https://akile.ai/",
        latency,
        updatedAt: parseTestTime(item.ip_check_detail, existingUpdatedAt),

        // 细化字段
        cpu: item.cpu,
        memory: item.memory,
        disk: item.disk,
        bandwidth: item.bandwidth,
        flow: item.flow,
        flowUsed: item.flow_used,
        dueTime: item.due_time,
        nodeName: item.node_name,
        serverPrice: item.server_price,
        serverCycle: item.server_cycle,
        ipv4Num: item.ipv4_num,
        ipv6Num: item.ipv6_num,
        ipStatus: item.detail,
        ipCheckDetail: item.ip_check_detail,
        resetPrice: item.reset_price
      };

      // 写入 D1 数据库 (不管价格多少，一律写入)
      try {
        await env.DB.prepare(`
          INSERT INTO vps_records (
            id, type, area, name, price, stock, specs, link, latency, updated_at,
            cpu, memory, disk, bandwidth, flow, flow_used, due_time, node_name,
            server_price, server_cycle, ipv4_num, ipv6_num, ip_status, ip_check_detail, reset_price
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            price = excluded.price,
            stock = excluded.stock,
            specs = excluded.specs,
            link = excluded.link,
            latency = COALESCE(excluded.latency, vps_records.latency),
            updated_at = excluded.updated_at,
            cpu = excluded.cpu,
            memory = excluded.memory,
            disk = excluded.disk,
            bandwidth = excluded.bandwidth,
            flow = excluded.flow,
            flow_used = excluded.flow_used,
            due_time = excluded.due_time,
            node_name = excluded.node_name,
            server_price = excluded.server_price,
            server_cycle = excluded.server_cycle,
            ipv4_num = excluded.ipv4_num,
            ipv6_num = excluded.ipv6_num,
            ip_status = excluded.ip_status,
            ip_check_detail = excluded.ip_check_detail,
            reset_price = excluded.reset_price
        `).bind(
          record.id, record.type, record.area, record.name, record.price, record.stock, record.specs, record.link, record.latency || null, record.updatedAt,
          record.cpu || null, record.memory || null, record.disk || null, record.bandwidth || null, record.flow || null, record.flowUsed || null,
          record.dueTime || null, record.nodeName || null, record.serverPrice || null, record.serverCycle || null, record.ipv4Num || null,
          record.ipv6Num || null, record.ipStatus || null, record.ipCheckDetail || null, record.resetPrice || null
        ).run();
      } catch (err) {
        console.error(`Failed to write market record to D1: ${err}`);
      }

      // 只有符合最大价格阈值且未推送过才触发通知
      if (itemPrice <= settings.maxPrice && !cached) {
        await notify(env, settings, {
          type: "market",
          title: `[市场低价] 二手机上架`,
          planName: item.name,
          price: `¥${itemPrice.toFixed(2)}`,
          stock: 1,
          specs: record.specs + (latency ? ` | 测速: ${latency}ms` : ""),
          link: record.link
        });
        await env.KV.put(uniqueKey, "true", { expirationTtl: 172800 });
      }
    }

    // --- 下架同步逻辑 ---
    // 获取本次拉取到的所有二手机 ID 集合
    const currentMarketIds = json.list.map(item => `market_${item.id}`);
    
    // 如果返回数据完整 (比如至少包含一定数量 of 商品)，说明获取接口数据正常。
    // 我们将 D1 中所有 type='market' 且 id 不在 currentMarketIds 集合里的记录，其 stock 标记为 0 (下架隐藏)。
    if (currentMarketIds.length > 0) {
      try {
        // SQLite 不支持直接绑定动态长度数组，我们可以通过在 JS 中构建占位符来安全执行
        const placeholders = currentMarketIds.map(() => "?").join(",");
        await env.DB.prepare(`
          UPDATE vps_records 
          SET stock = 0 
          WHERE type = 'market' AND id NOT IN (${placeholders})
        `).bind(...currentMarketIds).run();
      } catch (err) {
        console.error(`Failed to update sold/delisted market products: ${err}`);
      }
    }
  } catch (e) {
    console.error(`Market check error: ${e}`);
  }
}

export async function notify(
  env: Env,
  settings: Settings,
  data: { type: string; title: string; planName: string; price: string | number; stock: number; specs: string; link: string }
): Promise<void> {
  // 1. TG 通道推送 (Markdown 格式)
  if (settings.tgBotToken && settings.tgChatId) {
    const message = `🔔 *${data.title}*\n\n` +
      `📦 *商品:* ${data.planName}\n` +
      `💰 *价格:* ${data.price} (库存: ${data.stock})\n` +
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

  // 2. 企业微信 Webhook 通道推送 (根据用户要求，改成 text 文本格式)
  if (settings.wechatWebhook) {
    const textContent = `🔔 ${data.title}\n\n` +
      `📦 商品: ${data.planName}\n` +
      `💰 价格: ${data.price} (库存: ${data.stock})\n` +
      `💻 配置: ${data.specs}\n\n` +
      `🔗 链接: ${data.link}`;

    try {
      await fetch(settings.wechatWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          msgtype: "text",
          text: {
            content: textContent
          }
        })
      });
    } catch (e) {
      console.error("Failed to send WeChat Work Webhook notification:", e);
    }
  }

  if (!settings.tgBotToken && !settings.wechatWebhook) {
    console.log("No notification channels configured. Outputting alert to console:", data);
  }
}

// Base32 decode helper for TOTP
function base32tohex(base32: string): string {
  const base32chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  let hex = "";
  
  const cleaned = base32.replace(/=+$/, "").toUpperCase().trim();
  for (let i = 0; i < cleaned.length; i++) {
    const val = base32chars.indexOf(cleaned.charAt(i));
    if (val === -1) throw new Error("Invalid base32 character");
    bits += val.toString(2).padStart(5, "0");
  }
  
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    const chunk = bits.substr(i, 4);
    hex = hex + parseInt(chunk, 2).toString(16);
  }
  return hex;
}

// Generate Google Authenticator TOTP Code
export async function generateTOTP(secret: string): Promise<string> {
  const hexSecret = base32tohex(secret);
  const epoch = Math.round(new Date().getTime() / 1000.0);
  const time = Math.floor(epoch / 30);
  const hexTime = time.toString(16).padStart(16, "0");
  
  const keyBytes = new Uint8Array(hexSecret.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
  const msgBytes = new Uint8Array(hexTime.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
  
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: { name: "SHA-1" } },
    false,
    ["sign"]
  );
  
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    msgBytes
  );
  
  const hmac = new Uint8Array(signature);
  const offset = hmac[hmac.length - 1] & 0xf;
  const otp = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  );
  
  return (otp % 1000000).toString().padStart(6, "0");
}

// Automatically log in and refresh token
export async function refreshAkileToken(env: Env, settings: Settings): Promise<string | null> {
  if (!settings.akileEmail || !settings.akilePassword || !settings.akileTotpSecret) {
    console.warn("[Auth] Cannot refresh token: Email, password, or TOTP secret is not configured.");
    return null;
  }

  console.log("[Auth] Attempting automatic token refresh via email/password + TOTP...");

  try {
    const totpCode = await generateTOTP(settings.akileTotpSecret);
    const loginUrl = "https://api.akile.ai/api/v1/user/login";
    
    const res = await fetch(loginUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "Referer": "https://akile.ai/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/149.0.0.0"
      },
      body: JSON.stringify({
        email: settings.akileEmail.trim(),
        password: settings.akilePassword.trim(),
        token: totpCode,
        verifyCode: ""
      })
    });

    if (!res.ok) {
      console.error(`[Auth] Login request failed with status: ${res.status}`);
      return null;
    }

    const json = await res.json() as any;
    if (json.status_code !== 200 && json.status_code !== 0) {
      console.error(`[Auth] Login API returned non-zero code: ${json.status_code}, msg: ${json.status_msg}`);
      return null;
    }

    const newToken = json.data?.token || json.token || (typeof json.data === "string" ? json.data : null);
    if (newToken) {
      console.log("[Auth] Successfully logged in and obtained a new Token.");
      settings.akileAuthToken = newToken;
      await env.KV.put("config:settings", JSON.stringify(settings));
      return newToken;
    } else {
      console.error("[Auth] Login succeeded but no token was found in the response payload:", JSON.stringify(json));
      return null;
    }
  } catch (e) {
    console.error(`[Auth] Automatic login error: ${e}`);
    return null;
  }
}

