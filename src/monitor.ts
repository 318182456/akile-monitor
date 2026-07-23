import { Env, Settings, VpsRecord, StoreResponse, PushProduct, PushProductResponse, LineMeta } from "./types";

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

// 一条记录在 D1 中的“业务快照”：只包含会影响展示/推送的字段。
// 用于和数据库现有值比对，决定是否需要真正写入（省 D1 写入配额）。
interface ExistingRow {
  latency: number | null;
  updatedAt: string | null;
  fingerprint: string;
}

// 计算记录指纹：只纳入真正的业务字段。
// 刻意排除 updated_at（它是变化的“结果”而非“原因”）和 latency（派生的测速值），
// 否则会造成“每次都判定为变化 → 每次都写”的自循环。
function computeFingerprint(r: VpsRecord): string {
  return [
    r.type, r.area, r.name, r.price, r.stock, r.specs, r.link,
    r.cpu, r.memory, r.disk, r.bandwidth, r.flow, r.flowUsed, r.dueTime,
    r.nodeName, r.serverPrice, r.serverCycle, r.ipv4Num, r.ipv6Num,
    r.ipStatus, r.ipCheckDetail, r.resetPrice
  ].map(v => v === undefined || v === null ? "" : String(v)).join("|");
}

// 从传入的一批 DB 行构造同样口径的指纹，用于比对。
function fingerprintFromDbRow(row: any): string {
  return [
    row.type, row.area, row.name, row.price, row.stock, row.specs, row.link,
    row.cpu, row.memory, row.disk, row.bandwidth, row.flow, row.flow_used, row.due_time,
    row.node_name, row.server_price, row.server_cycle, row.ipv4_num, row.ipv6_num,
    row.ip_status, row.ip_check_detail, row.reset_price
  ].map(v => v === undefined || v === null ? "" : String(v)).join("|");
}

// 判断两个指纹字符串在指定字段位置（"|" 分隔）上的值是否不同。
// 指纹字段顺序见 computeFingerprint：index 3 = price。
function fingerprintFieldChanged(oldFp: string, newFp: string, fieldIndex: number): boolean {
  const oldVal = oldFp.split("|")[fieldIndex];
  const newVal = newFp.split("|")[fieldIndex];
  return oldVal !== newVal;
}

// 一次性把 D1 中的全部记录读进内存（读取行配额宽松：5M/天）。
// 后续每条记录都在内存里比对指纹，只有变化的才落库写入。
async function loadExistingRecords(env: Env): Promise<Map<string, ExistingRow>> {
  const map = new Map<string, ExistingRow>();
  try {
    const { results } = await env.DB.prepare(`
      SELECT id, type, area, name, price, stock, specs, link, latency, updated_at,
             cpu, memory, disk, bandwidth, flow, flow_used, due_time, node_name,
             server_price, server_cycle, ipv4_num, ipv6_num, ip_status, ip_check_detail, reset_price
      FROM vps_records
    `).all<any>();
    for (const row of results || []) {
      map.set(row.id, {
        latency: row.latency,
        updatedAt: row.updated_at,
        fingerprint: fingerprintFromDbRow(row)
      });
    }
  } catch (e) {
    console.error(`Failed to preload existing records: ${e}`);
  }
  return map;
}

// 规格键：用于把“同配置 + 同节点 + 同线路 + 同流量”的机器归到一组，
// 作为历史均价的聚合维度。字段顺序固定，缺失值以空串占位。
export function computeSpecKey(r: {
  cpu?: number; memory?: number; disk?: number; flow?: number;
  nodeName?: string; area?: string;
}): string {
  return [r.cpu, r.memory, r.disk, r.flow, r.nodeName, r.area]
    .map(v => v === undefined || v === null ? "" : String(v))
    .join("|");
}

// 每个规格组的历史价格统计。
interface SpecStat { avg: number; count: number; }

// 从 price_history 表一次性聚合出各规格组的历史均价（读取额度友好）。
async function loadPriceStats(env: Env): Promise<Map<string, SpecStat>> {
  const map = new Map<string, SpecStat>();
  try {
    const { results } = await env.DB.prepare(`
      SELECT spec_key, AVG(price) as avg_price, COUNT(*) as cnt
      FROM price_history
      GROUP BY spec_key
    `).all<{ spec_key: string; avg_price: number; cnt: number }>();
    for (const row of results || []) {
      map.set(row.spec_key, { avg: row.avg_price, count: row.cnt });
    }
  } catch (e) {
    console.error(`Failed to load price stats: ${e}`);
  }
  return map;
}

// 把一条新价格并入内存中的规格均价（增量更新，保证同批后续记录看到最新均价）。
function updateStatInMemory(stats: Map<string, SpecStat>, specKey: string, price: number): void {
  const s = stats.get(specKey);
  if (!s) {
    stats.set(specKey, { avg: price, count: 1 });
  } else {
    const newCount = s.count + 1;
    s.avg = (s.avg * s.count + price) / newCount;
    s.count = newCount;
  }
}

// 追加一条历史价格记录。只在价格真正变化时调用，避免历史表膨胀。
async function appendPriceHistory(env: Env, recordId: string, specKey: string, price: number): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO price_history (record_id, spec_key, price) VALUES (?, ?, ?)`
    ).bind(recordId, specKey, price).run();
  } catch (e) {
    console.error(`Failed to append price history: ${e}`);
  }
}

export async function runChecks(env: Env, settings: Settings): Promise<void> {
  // 预加载现有记录 + 历史均价，供两个检查共享，避免每条记录单独查询。
  const existing = await loadExistingRecords(env);
  const priceStats = await loadPriceStats(env);
  await Promise.all([
    checkStore(env, settings, existing, priceStats),
    checkMarket(env, settings, existing, priceStats)
  ]);

  // 清理 90 天前的历史价格，防止表无限膨胀、也让均价更贴近近期行情。
  // 通常删 0 行（不产生写入），仅在确有过期数据时才写。
  try {
    await env.DB.prepare(
      `DELETE FROM price_history WHERE recorded_at < datetime('now', '-90 days')`
    ).run();
  } catch (e) {
    console.error(`Failed to prune price history: ${e}`);
  }
}

export async function checkStore(env: Env, settings: Settings, existing: Map<string, ExistingRow>, priceStats: Map<string, SpecStat>): Promise<void> {
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
            const prev = existing.get(id);

            let latency: number | undefined = undefined;
            if (cached) {
              // 已推送过：沿用内存中现有的测速值，不再单独查库、不再重测
              if (prev && prev.latency !== null) {
                latency = prev.latency;
              }
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

            // 只有业务数据真正变化时才写 D1（省写入配额）。
            // updated_at 语义保持不变：仅在价格变动或“缺货→有货”时刷新为当前时间，
            // 其余变化（如库存数量、配置文案）沿用旧时间，避免污染历史走势。
            const fp = computeFingerprint(record);
            if (!prev || prev.fingerprint !== fp) {
              // 价格变动（index 3）或“缺货→有货”（旧 stock 为 0 而现在 >0）才刷新时间戳；
              // 其余变化沿用旧时间，避免污染历史走势。
              const priceChanged = !prev || fingerprintFieldChanged(prev.fingerprint, fp, 3);
              const restocked = !!prev && prev.fingerprint.split("|")[4] === "0";
              record.updatedAt = (priceChanged || restocked || !prev?.updatedAt)
                ? record.updatedAt
                : prev.updatedAt;

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
                    updated_at = excluded.updated_at,
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
                // 更新内存快照，保持后续（同批）比对一致
                existing.set(id, { latency: record.latency ?? null, updatedAt: record.updatedAt, fingerprint: fp });
              } catch (err) {
                console.error(`Failed to write store record to D1: ${err}`);
              }
            }

            // 按照人民币价格过滤（历史均价与通知均以人民币口径比较）
            const priceInCNY = getPriceInCNY(price, area.area_name);

            // 规格键 + 该规格历史均价（下面通知判断和历史追加都用）
            const specKey = computeSpecKey({
              cpu: plan.cpu, memory: plan.memory, disk: plan.disk, flow: plan.flow,
              nodeName: node.group_name, area: area.area_name
            });
            // 取“并入本条之前”的历史均价快照，作为通知基准（不能拿自己和含自己的均价比）
            const stat = priceStats.get(specKey);
            const baselineAvg = stat ? stat.avg : null;
            const baselineCount = stat ? stat.count : 0;

            // 价格变化时追加一条历史价格（用于后续均价计算），并同步内存里的均价
            const priceChangedForHistory = !prev || fingerprintFieldChanged(prev.fingerprint, fp, 3);
            if (priceChangedForHistory) {
              await appendPriceHistory(env, id, specKey, priceInCNY);
              updateStatInMemory(priceStats, specKey, priceInCNY);
            }

            // 通知条件：上架价 < 同规格历史均价（且已有历史样本），
            // 且不超过绝对上限 maxPrice，且本条未推送过。无历史均价（新规格）时不通知。
            if (baselineAvg !== null && baselineCount > 0 && priceInCNY < baselineAvg && priceInCNY <= settings.maxPrice && !cached) {
              await notify(env, settings, {
                type: "store",
                title: `[商店低价] ${area.area_name} - ${node.group_name}`,
                planName: plan.plan_name,
                price: `¥${priceInCNY.toFixed(2)} (${price} JPY) | 低于均价 ¥${baselineAvg.toFixed(2)}`,
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

export async function checkMarket(env: Env, settings: Settings, existing: Map<string, ExistingRow>, priceStats: Map<string, SpecStat>): Promise<void> {
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

    headers["Authorization"] = settings.akileAuthToken.trim();

    // 拉取单页；遇到 401 自动刷新 token 后重试一次。
    // 注意：服务端固定每页返回 30 条，page_size 参数会被忽略，必须靠翻页取全量。
    const PAGE_SIZE = 30;
    const fetchPage = async (pageNum: number): Promise<PushProductResponse | null> => {
      const doFetch = () => fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ page_num: pageNum, page_size: PAGE_SIZE })
      });

      let res = await doFetch();
      if (res.status === 401 && pageNum === 1) {
        console.warn("Market pushshop API returned 401 Unauthorized. Attempting token refresh...");
        const refreshedToken = await refreshAkileToken(env, settings);
        if (refreshedToken) {
          console.log("Token refreshed. Retrying market product list fetch...");
          headers["Authorization"] = refreshedToken.trim();
          res = await doFetch();
        }
      }
      if (!res.ok) {
        console.error(`Market pushshop API error on page ${pageNum}. HTTP Status: ${res.status}`);
        return null;
      }
      const body = await res.json() as PushProductResponse;
      if (body.status_code !== 0 || !body.list) {
        console.warn(`Market pushshop API page ${pageNum} returned code: ${body.status_code}`);
        return null;
      }
      return body;
    };

    // 第一页拿到 total 作为参考，但不完全依赖它：
    // 采用“满页续探”——只要某页返回满 PAGE_SIZE 条就继续翻下一页，
    // 直到出现不满页（说明到最后一页）或拉取失败，这样即使 total 不准也能取全。
    const first = await fetchPage(1);
    if (!first) return;

    const total = first.total ?? first.list!.length;
    const allItems: PushProduct[] = [...first.list!];
    let fetchAborted = false; // 中途某页失败 → 数据不完整

    // 安全上限：以 total 估算的页数上浮一倍，兜底防止 API 异常导致无限翻页。
    const MAX_PAGES = Math.max(10, Math.ceil((total || PAGE_SIZE) / PAGE_SIZE) * 2);

    let lastPageCount = first.list!.length;
    let page = 1;
    // 第一页若已不满，说明只有一页，不进入循环。
    while (lastPageCount >= PAGE_SIZE && page < MAX_PAGES) {
      page++;
      const pageData = await fetchPage(page);
      if (!pageData || !pageData.list) {
        // 拉取失败：标记不完整，停止翻页（后续会跳过下架同步）
        fetchAborted = true;
        break;
      }
      if (pageData.list.length === 0) break; // 正常翻到末尾
      allItems.push(...pageData.list);
      lastPageCount = pageData.list.length;
    }

    // 翻页期间商品可能上下架导致跨页出现重复 id，按 id 去重（后出现的覆盖先出现的）。
    const dedupMap = new Map<string, PushProduct>();
    for (const it of allItems) dedupMap.set(String(it.id), it);
    const uniqueItems = [...dedupMap.values()];

    // 用聚合后的完整列表覆盖后续处理逻辑所依赖的 json 结构。
    const json: PushProductResponse = {
      status_code: first.status_code,
      status_msg: first.status_msg,
      list: uniqueItems,
      total
    };

    // 数据完整性判定：只要没有中途失败，且拿到的条数不少于 total，即视为完整。
    // 不完整时跳过“下架同步”，避免把正常在售记录误标为 stock=0。
    const listComplete = !fetchAborted && allItems.length >= total;
    if (!listComplete) {
      console.warn(`[Market Monitor] Incomplete fetch: got ${allItems.length}/${total} (aborted=${fetchAborted}). Will skip delist sync to avoid false stock=0.`);
    }

    console.log(`[Market Monitor] Successfully fetched ${json.list!.length}/${total} market products across ${page} page(s).`);

    for (const item of uniqueItems) {
      const itemPrice = parseFloat(item.price);
      const id = `market_${item.id}`;
      const uniqueKey = `akile_market_vps_${item.id}_price_${item.price}`;
      const cached = await env.KV.get(uniqueKey);

      const prev = existing.get(id);
      let latency: number | undefined = undefined;
      let existingUpdatedAt: string | undefined = undefined;
      if (cached) {
        // 已推送过：从内存快照取现有测速与时间，不再逐条查库
        if (prev) {
          if (prev.latency !== null) latency = prev.latency;
          if (prev.updatedAt) existingUpdatedAt = prev.updatedAt;
        }
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

      // 只有业务数据真正变化时才写 D1（省写入配额）。
      // 注意：从有货变回有货、仅 updated_at 因测试时间刷新的场景不计入指纹，
      // 避免每轮 cron 因时间戳变化而无意义写入。
      const fp = computeFingerprint(record);
      if (!prev || prev.fingerprint !== fp) {
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
          // 同步内存快照
          existing.set(id, { latency: record.latency ?? null, updatedAt: record.updatedAt, fingerprint: fp });
        } catch (err) {
          console.error(`Failed to write market record to D1: ${err}`);
        }
      }

      // 规格键 + 并入本条之前的历史均价快照
      const specKey = computeSpecKey({
        cpu: item.cpu, memory: item.memory, disk: item.disk, flow: item.flow,
        nodeName: item.node_name, area: record.area
      });
      const stat = priceStats.get(specKey);
      const baselineAvg = stat ? stat.avg : null;
      const baselineCount = stat ? stat.count : 0;

      // 价格变化时追加历史价格，并同步内存均价
      const priceChangedForHistory = !prev || fingerprintFieldChanged(prev.fingerprint, fp, 3);
      if (priceChangedForHistory) {
        await appendPriceHistory(env, id, specKey, itemPrice);
        updateStatInMemory(priceStats, specKey, itemPrice);
      }

      // 通知条件：上架价 < 同规格历史均价（且已有历史样本），
      // 且不超过绝对上限 maxPrice，且本条未推送过。无历史均价（新规格）时不通知。
      if (baselineAvg !== null && baselineCount > 0 && itemPrice < baselineAvg && itemPrice <= settings.maxPrice && !cached) {
        await notify(env, settings, {
          type: "market",
          title: `[市场低价] 二手机上架`,
          planName: item.name,
          price: `¥${itemPrice.toFixed(2)} | 低于均价 ¥${baselineAvg.toFixed(2)}`,
          stock: 1,
          specs: record.specs + (latency ? ` | 测速: ${latency}ms` : ""),
          link: record.link
        });
        await env.KV.put(uniqueKey, "true", { expirationTtl: 172800 });
      }
    }

    // --- 下架同步逻辑 ---
    // 获取本次拉取到的所有二手机 ID 集合
    const currentMarketIds = uniqueItems.map(item => `market_${item.id}`);

    // 仅当本轮完整拉取了全部分页（listComplete）时才执行下架同步，
    // 否则（某页失败导致列表不全）会把大量正常在售记录误标为 stock=0，
    // 这正是此前“API 有 124 条、页面只显示 ~30 条”的根因。
    if (listComplete && currentMarketIds.length > 0) {
      try {
        // SQLite 不支持直接绑定动态长度数组，我们可以通过在 JS 中构建占位符来安全执行
        const placeholders = currentMarketIds.map(() => "?").join(",");
        // 追加 stock != 0：只把“仍标记为有货、但本次已不在列表”的记录置 0，
        // 避免每轮 cron 重复写入早已下架（stock 已为 0）的历史记录。
        await env.DB.prepare(`
          UPDATE vps_records
          SET stock = 0
          WHERE type = 'market' AND stock != 0 AND id NOT IN (${placeholders})
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

