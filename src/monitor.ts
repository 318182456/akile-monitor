import { Env, Settings, VpsRecord, StoreResponse, PushProductResponse } from "./types";

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
                INSERT OR REPLACE INTO vps_records (
                  id, type, area, name, price, stock, specs, link, latency, updated_at,
                  cpu, memory, disk, bandwidth, flow, node_name, ipv4_num, ipv6_num, ip_status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).bind(
                record.id, record.type, record.area, record.name, record.price, record.stock, record.specs, record.link, record.latency || null, record.updatedAt,
                record.cpu || null, record.memory || null, record.disk || null, record.bandwidth || null, record.flow || null, record.nodeName || null,
                record.ipv4Num || null, record.ipv6Num || null, record.ipStatus || null
              ).run();
            } catch (err) {
              console.error(`Failed to write store record to D1: ${err}`);
            }

            // 只有符合最大价格阈值且未推送过才触发通知
            if (price <= settings.maxPrice && !cached) {
              await notify(env, settings, {
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
    } catch (e) {
      console.error(`Store check error: ${e}`);
    }
  }
}

export async function checkMarket(env: Env, settings: Settings): Promise<void> {
  if (!settings.marketMonitorEnabled) return;

  if (!settings.akileAuthToken) {
    console.warn("Market monitor is enabled but Akile Authorization Token is not configured. Suppressing check to avoid 401 errors.");
    return;
  }

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

    headers["Authorization"] = settings.akileAuthToken.trim();

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        area_name: "",
        name: "",
        page_num: 1,
        page_size: 300
      })
    });
    if (res.status === 401) {
      console.error("Market pushshop API returned 401 Unauthorized. The Token has expired or is invalid.");
      return;
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

    for (const item of json.list) {
      const itemPrice = parseFloat(item.price);
      const id = `market_${item.id}`;
      const uniqueKey = `akile_market_vps_${item.id}_price_${item.price}`;
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
        updatedAt: new Date().toISOString(),

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
          INSERT OR REPLACE INTO vps_records (
            id, type, area, name, price, stock, specs, link, latency, updated_at,
            cpu, memory, disk, bandwidth, flow, flow_used, due_time, node_name,
            server_price, server_cycle, ipv4_num, ipv6_num, ip_status, ip_check_detail, reset_price
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          price: itemPrice,
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
    
    // 如果返回数据完整 (比如至少包含一定数量的商品)，说明获取接口数据正常。
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
  data: { type: string; title: string; planName: string; price: number; stock: number; specs: string; link: string }
): Promise<void> {
  // 1. TG 通道推送 (Markdown 格式)
  if (settings.tgBotToken && settings.tgChatId) {
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

  // 2. 企业微信 Webhook 通道推送 (根据用户要求，改成 text 文本格式)
  if (settings.wechatWebhook) {
    const textContent = `🔔 ${data.title}\n\n` +
      `📦 商品: ${data.planName}\n` +
      `💰 价格: ${data.price} JPY/CNY (库存: ${data.stock})\n` +
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
