export interface Env {
  AKILE_KV: KVNamespace;
  TG_BOT_TOKEN?: string;
  TG_CHAT_ID?: string;
  MAX_PRICE?: string;
  MARKET_MONITOR_ENABLED?: string;
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

// 二手交易所订单结构
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

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(this.runChecks(env));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      await this.runChecks(env);
      return new Response(JSON.stringify({ success: true, message: "Manual check completed." }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response("Akile VPS Monitor is running. Access /run to trigger check manually.");
  },

  async runChecks(env: Env): Promise<void> {
    const maxPrice = parseFloat(env.MAX_PRICE || "20");
    await Promise.all([
      this.checkStore(env, maxPrice),
      this.checkMarket(env, maxPrice)
    ]);
  },

  // 监控官方商店新上架机器
  async checkStore(env: Env, maxPrice: number): Promise<void> {
    const shopCodes = ["HOT", "SJS"]; // 常用商店代码
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

              if (price <= maxPrice) {
                const uniqueKey = `akile_store_vps_${plan.id}_price_${price}`;
                const cached = await env.AKILE_KV.get(uniqueKey);
                if (!cached) {
                  await this.notify(env, {
                    type: "store",
                    title: `[商店上新] ${area.area_name} - ${node.group_name}`,
                    planName: plan.plan_name,
                    price,
                    stock: plan.stock,
                    specs: `${plan.cpu}核/${plan.memory}M/${plan.disk}G | ${plan.flow}G流量 | ${plan.bandwidth}M带宽`,
                    link: "https://akile.io/store"
                  });
                  await env.AKILE_KV.put(uniqueKey, "true", { expirationTtl: 172800 }); // Cache 2 days
                }
              }
            }
          }
        }
      } catch (e) {
        console.error(`Store check error for ${code}:`, e);
      }
    }
  },

  // 监控二手交易市场
  async checkMarket(env: Env, maxPrice: number): Promise<void> {
    if (env.MARKET_MONITOR_ENABLED !== "true") return;

    try {
      // 交易所公开接口通常接收 POST 请求进行查询与分页
      const url = "https://api.akile.io/api/v1/market/GetMarketList";
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        },
        body: JSON.stringify({
          page_num: 1,
          page_size: 20
        })
      });
      if (!res.ok) return;
      const json = await res.json() as MarketResponse;
      if (json.status_code !== 0 || !json.list) return;

      for (const item of json.list) {
        if (item.price <= maxPrice) {
          const uniqueKey = `akile_market_vps_${item.id}_price_${item.price}`;
          const cached = await env.AKILE_KV.get(uniqueKey);
          if (!cached) {
            await this.notify(env, {
              type: "market",
              title: `[市场低价] 二手机上架`,
              planName: item.name,
              price: item.price,
              stock: 1,
              specs: `${item.cpu}核/${item.memory}M/${item.disk}G | ${item.flow}G流量 | ${item.bandwidth}M带宽`,
              link: "https://akile.io/exchange"
            });
            await env.AKILE_KV.put(uniqueKey, "true", { expirationTtl: 172800 });
          }
        }
      }
    } catch (e) {
      console.error("Market check error:", e);
    }
  },

  async notify(env: Env, data: { type: string; title: string; planName: string; price: number; stock: number; specs: string; link: string }): Promise<void> {
    if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) {
      console.log("TG credentials not set, notification message:", data);
      return;
    }

    const message = `🔔 *${data.title}*\n\n` +
      `📦 *商品:* ${data.planName}\n` +
      `💰 *价格:* ${data.price} JPY/CNY (库存: ${data.stock})\n` +
      `💻 *配置:* ${data.specs}\n\n` +
      `🔗 [立即购买](${data.link})`;

    try {
      const url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`;
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TG_CHAT_ID,
          text: message,
          parse_mode: "Markdown",
          disable_web_page_preview: true
        })
      });
    } catch (e) {
      console.error("Failed to dispatch telegram notification:", e);
    }
  }
};
