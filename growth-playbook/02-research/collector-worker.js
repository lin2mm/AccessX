// collector-worker.js — AccessX 烟雾测试线索收集器(Cloudflare Workers 免费层)
// 用途: 替代三个落地页中的 FORMSPREE_ENDPOINT 占位;免费额度 100k 请求/日,烟雾测试绰绰有余。
// 部署(5 分钟):
//   npm i -g wrangler && wrangler login
//   wrangler kv namespace create LEADS            # 记下返回的 id
//   新建同目录 wrangler.toml(内容见文件底部注释)   # 填入 KV id
//   wrangler deploy                               # 得到 https://collector.<sub>.workers.dev
//   把三个 lp-v*.html 中 COLLECTOR_URL 替换为该地址
// 与管理: GET /count 看线索总数(公开,仅聚合数);导出用 wrangler kv key list/bulk(或加 D1 换 SQL)。
// 估算成本: 免费层内 $0;KV 免费 100k 读/日 + 1k 写/日(超过约 $0.5/百万)。

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    // 接收线索
    if (req.method === "POST" && url.pathname === "/lead") {
      const ct = req.headers.get("content-type") || "";
      let data = {};
      try {
        data = ct.includes("form")
          ? Object.fromEntries(await req.formData())
          : await req.json();
      } catch (_) {}
      const email = String(data.email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return Response.json({ ok: false, error: "invalid email" }, { status: 400, headers: cors });
      }
      const rec = {
        email,
        variant: String(data.variant || "unknown"),
        utm_source: String(data.utm_source || ""),
        utm_medium: String(data.utm_medium || ""),
        utm_campaign: String(data.utm_campaign || ""),
        utm_content: String(data.utm_content || ""),
        ts: Date.now(),
        ip: req.headers.get("cf-connecting-ip") || "",
      };
      // Honeypot: 表单隐藏字段 company 有值=机器人,静默丢弃但回 200
      if (data.company) return respond(req, url, cors);
      // 去重: 同邮箱同变体只记一次
      const dedupeKey = `seen:${email}:${rec.variant}`;
      if (!(await env.LEADS.get(dedupeKey))) {
        await env.LEADS.put(dedupeKey, "1", { expirationTtl: 31536000 });
        await env.LEADS.put(`lead:${crypto.randomUUID()}`, JSON.stringify(rec), { expirationTtl: 31536000 });
      }
      return respond(req, url, cors);
    }

    // 线索计数(公开,仅聚合数、无任何个人信息;lp-presale.html 实时排队人数即调此端点)
    // 管理后台若要细分可到 Cloudflare 控制台查 KV,或临时加回 token 校验
    if (req.method === "GET" && url.pathname === "/count") {
      const list = await env.LEADS.list({ prefix: "lead:" });
      return Response.json({ count: list.keys.length, leads: list.keys.length }, { headers: cors });
    }

    return new Response("ok", { headers: cors });
  },
};

function respond(req, url, cors) {
  // 表单直提(非 fetch)时 302 回原页面并带 ?ok=1,前端可弹"已加入候补"提示
  const back = url.searchParams.get("next") || req.headers.get("referer");
  if (back) {
    const u = new URL(back);
    u.searchParams.set("ok", "1");
    return new Response(null, { status: 302, headers: { ...cors, Location: u.toString() } });
  }
  return Response.json({ ok: true }, { headers: cors });
}

/* wrangler.toml 模板:
name = "collector"
main = "collector-worker.js"
compatibility_date = "2026-09-28"

[[kv_namespaces]]
binding = "LEADS"
id = "YOUR_KV_NAMESPACE_ID"

[vars]
ADMIN_TOKEN = "换成长随机串"
*/
