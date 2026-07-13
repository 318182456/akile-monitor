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

export const LINE_META: Record<string, LineMeta> = {
  "JPIIJ": {
    name: "JPIIJ",
    area: "日本 (Japan)",
    emoji: "🇯🇵",
    tags: ["日本直连", "联通神线"],
    stability: "良好",
    stabilityClass: "status-good",
    desc: "日本IIJ线路，三网回程走IIJ优化直连（对联通网络最为友好，电信/移动次之）。",
    pros: "延迟低（江浙沪一般在35-50ms），对联通宽带用户体验极佳，价格公道且带宽充裕。",
    cons: "电信晚高峰期间可能因骨干网拥堵导致延迟抖动及部分丢包现象。",
    nightStatus: "晚高峰（20:00 - 23:00）会有约10%左右的偶发丢包，整体不掉线，联通用户基本无感。",
    nightClass: "",
    telecom: "★★★☆☆",
    unicom: "★★★★★",
    mobile: "★★★★☆",
    label: "日本IIJ直连",
    hint: "联通神线，电信晚高峰微丢包，不掉线",
    color: "#60a5fa"
  },
  "HKS": {
    name: "HKS",
    area: "中国香港 (Hong Kong)",
    emoji: "🇨🇳",
    tags: ["香港标准", "大带宽落地"],
    stability: "一般",
    stabilityClass: "status-warning",
    desc: "香港Standard线路，通常为国际BGP互联，不承诺对国内方向直连优化。",
    pros: "价格极低，香港原生/解锁IP，国际方向互联极佳，大带宽，非常适合做流媒体落地机。",
    cons: "回国线路未优化，电信绕路严重延迟极高，移动/联通网络也可能绕路。",
    nightStatus: "晚高峰直连回国丢包严重，极易卡顿、降速。虽不会掉线，但必须搭配国内中转/拉跨使用。",
    nightClass: "warn",
    telecom: "★☆☆☆☆",
    unicom: "★★☆☆☆",
    mobile: "★★★☆☆",
    label: "香港国际BGP",
    hint: "大带宽落地，直连丢包严重，建议中转",
    color: "#fbbf24"
  },
  "UKLITE": {
    name: "UKLite",
    area: "英国 (United Kingdom)",
    emoji: "🇬🇧",
    tags: ["欧洲落地", "廉价大带宽"],
    stability: "一般",
    stabilityClass: "status-warning",
    desc: "英国Lite系列，纯国际BGP线路，无回国优化，物理距离遥远。",
    pros: "价格便宜，提供英国本土IP，解锁英国流媒体及各种欧洲本地服务，带宽超大。",
    cons: "国内直连延迟通常在260-350ms+，晚高峰直连丢包非常高。",
    nightStatus: "晚上直连极其卡顿，丢包率可能高达30%以上。适合配合中转落地使用，直连极易连接超时。",
    nightClass: "danger",
    telecom: "★☆☆☆☆",
    unicom: "★☆☆☆☆",
    mobile: "★★☆☆☆",
    label: "英国国际BGP",
    hint: "欧洲落地，晚上直连极其卡顿，需中转",
    color: "#f87171"
  },
  "LAX4837": {
    name: "LAX4837",
    area: "美国洛杉矶 (Los Angeles)",
    emoji: "🇺🇸",
    tags: ["联通回国优化", "性价比神线"],
    stability: "极佳",
    stabilityClass: "status-excellent",
    desc: "美西洛杉矶机房，回程强制三网走联通 AS4837 优化线路直连回国。",
    pros: "三网直连延迟相对稳定（140-180ms），晚高峰回国带宽吞吐强悍，性价比奇高，适合建站及日常使用。",
    cons: "在晚高峰骨干网极度拥堵时，电信和移动用户的延迟会有小幅升高或抖动。",
    nightStatus: "晚上表现稳定，极少掉线。晚高峰会有极轻微延迟抖动，但基本不影响日常使用和速度体验。",
    nightClass: "",
    telecom: "★★★★☆",
    unicom: "★★★★★",
    mobile: "★★★★☆",
    label: "联通4837直连",
    hint: "三网回程直连，晚上稳定不掉线",
    color: "#34d399"
  },
  "TWLITE": {
    name: "TWLite",
    area: "中国台湾 (Taiwan)",
    emoji: "🇨🇳",
    tags: ["台湾解锁", "看剧落地"],
    stability: "一般",
    stabilityClass: "status-warning",
    desc: "台湾Lite轻量系列，主要使用台湾本土BGP或HiNet等国际网络，无大陆直连优化。",
    pros: "台湾IP解锁神机，完美解锁巴哈姆特动画疯、Netflix台区等台湾流媒体。",
    cons: "国内直连极其绕路（常见绕香港、日本甚至美国），延迟通常在180-250ms+。",
    nightStatus: "晚高峰期间直连丢包非常严重，速度断崖式下跌，虽然很少彻底断网掉线，但直连使用极卡，强烈建议搭配中转。",
    nightClass: "warn",
    telecom: "★☆☆☆☆",
    unicom: "★★☆☆☆",
    mobile: "★★☆☆☆",
    label: "台湾国际BGP",
    hint: "解锁神机，晚上直连极卡，建议中转",
    color: "#fbbf24"
  },
  "HINET NAT": {
    name: "HINET NAT",
    area: "中国台湾 (Taiwan)",
    emoji: "🇨🇳",
    tags: ["台湾Hinet", "动态NAT", "流媒体解锁强"],
    stability: "一般",
    stabilityClass: "status-warning",
    desc: "台湾Hinet动态NAT共享IP节点（通常提供端口映射 and 动态DDNS）。",
    pros: "台湾本土原生IP，流媒体解锁能力强，适合作为台湾本土应用或流媒体落地。",
    cons: "共享端口/IP，不适合需要固定端口和公网IP的建站；国内直连绕路且高延迟。",
    nightStatus: "晚高峰直连受限于骨干网 and 海缆，丢包率非常高（延迟大幅飙升并可能卡顿），极少彻底中断掉线，但强烈推荐搭配中转拉跨使用。",
    nightClass: "warn",
    telecom: "★☆☆☆☆",
    unicom: "★★☆☆☆",
    mobile: "★★☆☆☆",
    label: "台湾Hinet NAT",
    hint: "动态IP共享端口，流媒体解锁强，直连极卡建议中转",
    color: "#fbbf24"
  },
  "HKLITE": {
    name: "HKLite",
    area: "中国香港 (Hong Kong)",
    emoji: "🇨🇳",
    tags: ["超低价格", "纯落地机"],
    stability: "较差",
    stabilityClass: "status-poor",
    desc: "香港Lite轻量版，纯国际BGP网络（NTT/Cogent/PCCW等混合），无任何直连优化。",
    pros: "极具竞争力的低廉价格，大带宽，常用于解锁港区流媒体及作为国际数据节点。",
    cons: "国内直连几乎全部绕路（如绕美/绕日），延迟常常达到200ms以上甚至更高。",
    nightStatus: "晚上直连由于国际出口和绕路拥堵，会有严重的丢包和极高延迟（丢包率达30%-50%），几乎无法直接连通，不推荐直连。",
    nightClass: "danger",
    telecom: "★☆☆☆☆",
    unicom: "★☆☆☆☆",
    mobile: "★★☆☆☆",
    label: "香港国际BGP",
    hint: "大带宽纯落地，晚上直连严重丢包需中转",
    color: "#f87171"
  },
  "NL BGP": {
    name: "NL BGP",
    area: "荷兰 (Netherlands)",
    emoji: "🇳🇱",
    tags: ["欧洲BGP", "抗投诉/大流量"],
    stability: "一般",
    stabilityClass: "status-warning",
    desc: "荷兰BGP大带宽线路，未作国内回程直连优化，距离中国较远。",
    pros: "价格便宜，对欧洲本地网络互联好，适合BT/PT下载及欧洲本土流媒体落地或特定抗投诉业务。",
    cons: "延迟高达260-320ms，国内方向直接连接性能一般。",
    nightStatus: "晚高峰时受限于海缆拥堵，容易出现较大的丢包和降速，偶尔会有短暂连不上情况，直连不稳。",
    nightClass: "warn",
    telecom: "★☆☆☆☆",
    unicom: "★★☆☆☆",
    mobile: "★★☆☆☆",
    label: "荷兰国际BGP",
    hint: "欧洲落地，晚上直连极不稳易瞬断",
    color: "#fbbf24"
  },
  "JPHYPER": {
    name: "JPHyper",
    area: "日本 (Japan)",
    emoji: "🇯🇵",
    tags: ["高性能日本", "日区解锁"],
    stability: "良好",
    stabilityClass: "status-good",
    desc: "日本Hyper系列，主打高性能或更充沛的日本BGP带宽（部分路由可能包含IIJ/KB/SB优化）。",
    pros: "机器硬件性能较好，国际互联极强，解锁日区流媒体（Netflix/木偶/Niconico）稳定。",
    cons: "不承诺长期的国内直连，路由可能随着上游网络调整而变化。",
    nightStatus: "晚上直连稳定性较好，偶尔会有轻微的晚高峰波动或少许丢包，通常不会掉线，配合中转极香。",
    nightClass: "",
    telecom: "★★★☆☆",
    unicom: "★★★★☆",
    mobile: "★★★★☆",
    label: "日本BGP",
    hint: "高性能日区解锁，晚高峰偶有微丢包不掉线",
    color: "#60a5fa"
  },
  "HKL-TW": {
    name: "HKL-TW",
    area: "香港-台湾 (HK to TW)",
    emoji: "🌐",
    tags: ["港台互拉", "极低延迟互联"],
    stability: "良好",
    stabilityClass: "status-good",
    desc: "香港到台湾方向的传输或对拉线路，专为港台两地内网/互联数据流设计。",
    pros: "香港与台湾两地之间的互联延迟极低（通常仅10-25ms左右），特别适合把流量从香港拉往台湾落地使用。",
    cons: "回国方向的网络仍然等同于普通的香港Lite，直连表现同样差强人意。",
    nightStatus: "晚上港台之间互拉稳定性极佳，不会掉线；但如果国内直接连接该节点，晚上会有高丢包 and 高延迟。",
    nightClass: "warn",
    telecom: "★☆☆☆☆",
    unicom: "★★☆☆☆",
    mobile: "★★★☆☆",
    label: "港台优化互拉",
    hint: "港台互连极稳，晚上直连回国丢包严重",
    color: "#fbbf24"
  },
  "IT BGP": {
    name: "IT BGP",
    area: "意大利 (Italy)",
    emoji: "🇮🇹",
    tags: ["意大利BGP", "极速欧洲"],
    stability: "一般",
    stabilityClass: "status-warning",
    desc: "意大利BGP网络，主打国际大带宽，未对国内回程进行特流优化。",
    pros: "适合做欧洲意大利特定落地业务、小语种外贸及欧洲本土代理使用，价格低廉。",
    cons: "国内直连延迟高，绕行较远。",
    nightStatus: "晚高峰容易随欧洲至亚洲骨干光缆拥堵而丢包，直连表现较差，偶尔会出现连接超时或短暂无法连接，建站不宜直连。",
    nightClass: "warn",
    telecom: "★☆☆☆☆",
    unicom: "★☆☆☆☆",
    mobile: "★★☆☆☆",
    label: "意大利BGP",
    hint: "海外落地，晚高峰丢包高，直连不宜",
    color: "#fbbf24"
  },
  "HKBASE": {
    name: "HKBase",
    area: "中国香港 (Hong Kong)",
    emoji: "🇨🇳",
    tags: ["直连基础版", "性价比均衡"],
    stability: "良好",
    stabilityClass: "status-good",
    desc: "香港基础直连网络，包含了比Lite系列更好的三网直连路由（部分包含CMI/移动直连优化）。",
    pros: "延迟相对较低，价格适中，不经过中转也能获得相对可以接受的直连体验。",
    cons: "晚高峰期间电信用户可能会有间歇性拥堵，总体稳定度低于高端Pro系列。",
    nightStatus: "晚上表现较稳，极少掉线。晚高峰会有10%以内的轻微丢包，日常浏览及看视频能基本保持连通。",
    nightClass: "",
    telecom: "★★★☆☆",
    unicom: "★★★★☆",
    mobile: "★★★★☆",
    label: "香港直连基础版",
    hint: "较稳，晚高峰电信轻微丢包，极少掉线",
    color: "#60a5fa"
  },
  "HKPRO": {
    name: "HKPro",
    area: "中国香港 (Hong Kong)",
    emoji: "🇨🇳",
    tags: ["高端直连", "低延迟建站首选"],
    stability: "极佳",
    stabilityClass: "status-excellent",
    desc: "香港专业高端直连线路，通常接入 CN2 GIA / 联通9929 / 移动CMI高端直连通道。",
    pros: "三网均走顶级优化直连，延迟极低（江浙粤约8-35ms），晚高峰拥堵期依旧丝滑，极其稳定，建站与游戏极佳。",
    cons: "价格昂贵，且商家给的带宽通常较小（例如10-50M），流量相对较少。",
    nightStatus: "全天候极其稳定，晚上也绝对不会掉线，丢包率趋近于0%，即使在深夜黄金时段依然速度拉满。",
    nightClass: "",
    telecom: "★★★★★",
    unicom: "★★★★★",
    mobile: "★★★★★",
    label: "三网高端直连",
    hint: "CN2 GIA/9929/CMI，晚上极其稳定不掉线",
    color: "#34d399"
  }
};

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

