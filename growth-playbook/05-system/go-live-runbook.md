纯自传播 12 个月 100 万无可靠先例

> **状态：历史停用 / 不执行。** 当前唯一决策入口：[主决策板](strategy-master-summary.md)。本文件保留历史假设与出处；正文旧active、ready、唯一口径或自动上线措辞均失效。不外发、不收款、不部署。

# Go-Live 作战手册:从今天到 $300 投放判读,一条链按分钟执行

> **暂停旧付费上线链。当前执行约束：$0新增支出、不绑卡、不投Ads、不收预售款。** GitHub $0预算不是通用扣费保证；Ads日预算/自动规则不是绝对总额硬上限；域名未确认可买，现有HTML只是历史草稿不可直接上线收款。参见 [双主线战略](dual-engine-growth-strategy.md) §12。下列旧清单保留备查。

> 版本 v1.0 · 2026-09-28 · 状态: active ·  playbook 运营脊柱
> 本册是唯一执行入口——其余 20 份文档是它的备查附件。勾完 §1 的 12 步,烟雾测试即处于"烧钱中"状态,之后只需执行 §2 的日循环。
> 全册预算红线:**任何平台不得存在"无上限"支出**;GitHub/Stripe/Cloudflare/Google 四处都有 $0 或硬顶保险丝。

## 0. 只有您本人能做的两件事(合计 <10 分钟,先做)

| # | 动作 | 步骤 | 为什么必须您来 |
|---|---|---|---|
| 0.1 | GitHub 账户消费顶 $0 | GitHub → 头像 → Settings → Billing and licensing → Budgets and alerts → New budget → Product 选 Actions+Packages → Amount 填 **$0** → 勾选 "Stop usage when budget is reached" | 防学生演示/CI 循环意外烧钱;账户级设置,Agent 无权触碰 |
| 0.2 | Cloudflare 登录授权 | 终端跑 `npm i -g wrangler && wrangler login`(浏览器弹窗点 Allow) | 您的 Cloudflare 账号,sandbox 里没有也无法代持凭证 |

## 1. T-0 上线清单(12 步,约 90 分钟,全在本机完成)

> 工作目录一律 `growth-playbook/02-research/`。每步附验收标准,✅ 才算过。

**① 部署线索收集器(5 分钟)** —— 步骤见 [collector-worker.js](../02-research/collector-worker.js) 头注释:
```bash
wrangler kv namespace create LEADS        # 记下返回的 id
# 按 collector-worker.js 底部模板新建 wrangler.toml,填入 KV id;ADMIN_TOKEN 换长随机串
wrangler deploy                           # ✅ 得到 https://collector.<你的sub>.workers.dev
```

**② 端点写入 4 个页面(2 分钟)**:
```bash
sed -i '' 's#https://collector.YOUR-SUB.workers.dev#https://collector.<你的sub>.workers.dev#g' lp-v1-scanner.html lp-v2-renter.html lp-v3-host.html lp-presale.html
grep -c "collector\." lp-*.html   # ✅ 每文件 ≥2,且无 YOUR-SUB 残留
```

**③ 端到端漏斗自测(5 分钟)**: 四页各提交一次自己的邮箱(+测试变体)→ 页面应弹 ?ok=1 绿色 toast → `curl "https://collector.<sub>.workers.dev/count"` ✅ 返回 count ≥ 4。

**④ Stripe $1 支付链接(10 分钟)**: Stripe Dashboard → Payment links → New → Product "AccessX Lock Reservation" → **$1.00 一次性** → 开启"收集邮箱" → 确认页文案 "$1 fully refundable anytime"。拿到 `buy.stripe.com/live_xxx` 后:
```bash
sed -i '' 's#https://buy.stripe.com/STRIPE_PAYMENT_LINK#https://buy.stripe.com/live_xxx#g' lp-v2-renter.html lp-presale.html
grep -c "buy.stripe.com/live" lp-v2-renter.html lp-presale.html   # ✅ 各 1
```
不要开 Stripe 订阅商品——$1 是一次性押金,订阅是 Pro+Lock 合约,两回事(见 [presale-campaign-copy](../03-design/presale-campaign-copy.md)、[growth-system](accessx-complete-growth-system.md) §2)。

**⑤ Plausible 分析(10 分钟)**: plausible.io 注册(免费试用即可)→ Add website `getaccessx.com` → 4 个 HTML 里解开 `<script defer data-domain=...` 注释 → Goals 添加:`email_submit`、`deposit_click`、`lead_confirmed`(custom events)。✅ 自测提交后 Dashboard Realtime 有事件。

**⑥ 托管静态页(10 分钟)**: Cloudflare Pages(与 Worker 同账号,免费)→ 直接拖 `02-research/` 文件夹拖拉部署,或 `wrangler pages deploy . --project-name=accessx-lp` → 绑定 `getaccessx.com`(后续 Kickstarter 期统一域名)。✅ 用无痕窗口访问四页 + 提一次表单确认走通生产链路。

**⑦ Google Ads 开户 + 三重保险丝(15 分钟)**:
- 新建账户→**专家模式**(非智能模式)→ 建"暂停状态"的搜索系列,照 [google-ads-smoke-campaign.md](../02-research/google-ads-smoke-campaign.md) 录入 3 广告组/关键词/否定词/RSA 文案
- 保险丝 1:系列共享预算 **$21.5/天**
- 保险丝 2:Tools → Rules → 建自动规则"Cost > $290 → 暂停所有 campaign"(频率每日,邮件通知)
- 保险丝 3:Billing 侧预付费充值 $300 而非绑信用卡自动扣(物理上无法超烧)
- ✅ 确认账户顶部无"智能模式"提示、 campaign 仍 paused

**⑧ UTM 规范(5 分钟)**: Final URL suffix `utm_source=google&utm_medium=cpc&utm_campaign=smoke-{variant}&utm_content={creative}`(用 ValueTrack);LP 的 sessionStorage 会把 UTM 带进线索记录 → 事后可按关键词归因。✅ 提交一条带测试 UTM 的线索,`wrangler kv key get` 验证字段已入库。

**⑨ 诚实红线复检(5 分钟)**: 四页均无虚构评价(placeholder 标注未删)、FAQ 含"产品未发布"声明、$1 退款承诺与 Stripe 设置一致、预售页计数显示的是真实 /count(不虚构——本 playbook 全域红线)。✅ grep `placeholder` 4 页仅剩"待访谈回填"标注。

**⑩ 邮件序列进 ESP(20 分钟)**: 按 [lead-nurture-email-sequence.md](../03-design/lead-nurture-email-sequence.md) §0 开 Resend、验 DNS、导入 A0/A1/A2 三封(其余随排期)。A0 挂"新线索即时发"。✅ 用自己邮箱走一遍 A0 并回复测试送达。

**⑪ 投放上线(2 分钟)**: 选**周二至周四美东早 9 点**(避开周末低意图流量与周一波峰)→ campaign Enable → Plausible Realtime 开着看。✅ 首小时有 impression,无 impression=关键词/出价问题,先查不要加钱。

**⑫ 日历钉 3 个判读会(1 分钟)**: Day 3 / Day 7 / Day 14 各 30 分钟,议程=照 campaign sheet 判读规则执行,**判读会结论只有三种:换文案 / 砍组 / 停投**,不存在"再看看"。

## 2. 投放中日循环(每天 10 分钟)

| 分钟 | 动作 | 看哪里 |
|---|---|---|
| 0–3 | 花费 vs 预算、CPC vs $1.50 顶 | Google Ads Campaigns 页 |
| 3–5 | 搜索词报告:新无关词 → 加否定(黑名单表见 campaign sheet) | Search terms |
| 5–7 | 线索数与变体分布、?ok 转化 | `curl .../count` + Plausible Goals |
| 7–10 | 异常决策:CPC 超顶→降价 10%;CTR<2% 满 3 天→换头条(候选在 campaign sheet RSA 备用池);某组 LP 转化<8% 满 7 天→砍组 | 判读规则原样执行,不即兴 |

**停线(任意命中立即停投,不等判读会)**: 单日花费 >$26 · 账户总花费 >$290 · 单日 0 转化且点击 >40 · Stripe/Worker 任一故障 >4 小时。

## 3. 常用操作卡

**3.1 导出线索 → Resend**:
```bash
wrangler kv key list --namespace-id=<KV_ID> --prefix="lead:" > keys.json
# 逐条 get 洗出 email/variant/utm → CSV → Resend Audience 导入,按 variant 打 tag
```
**3.2 看谁在哪个变体转化最好**: 导出后按 `variant` 透视;与 Plausible 的 `email_submit {variant}` 目标交叉。
**3.3 预售页计数**: `/count` 已对公网返回聚合数,lp-presale.html 自动显示;数字为真,文案 "P.S. real counter" 才可保留。
**3.4 推荐跳队码(B0 病毒回路,烟雾期轻量替代)**: 无后端时先用"转发此邮件并在主题写 SKIP"人工处理;量 >50/日再在后端加 REF_CODE(Worker 加 20 行即可,届时交由 Agent 实现)。
**3.5 每周工程进展邮件(B1)**: 硬件周会产 3 条事实(测了什么/挂了什么/下一步),照 B1 模板 120 字发出——信任资产,雷打不动。

## 4. 判读会之后的衔接(赢在 Day 14 之前就想好)

| 判读结论 | 下一步动作 | 去哪份文档 |
|---|---|---|
| 某变体 LP 转化 ≥12% 且 CPL ≤$25 | 该主张锁定为预售页 Hero:`lp-presale.html` 的 `<h1>/.sub` 换成赢家文案(10 分钟) | campaign sheet §判读规则 |
| 三组均 <8% | 停投,回炉定位——重开 4 人群优先级辩论,不追加预算 | [accessx-complete-growth-system](accessx-complete-growth-system.md) §1 |
| 订金转化($1)≥15% of 线索 | 预售漏斗健康,启动 Kickstarter 页面制作(6–8 周节奏) | [presale-campaign-copy](../03-design/presale-campaign-copy.md) §2 |
| 订金数 ≥900(首月 3,000 台的 30%) | 达成出门条件,硬件进入 EVT 排期 | [growth-plan-1m-10k](growth-plan-1m-10k.md) |

## 5. 风险与回滚总表

| 风险 | 保险丝 | 触发后 |
|---|---|---|
| Google 超烧 | 日预算 $21.5 + 规则 $290 停投 + 预付费 $300 | 三重任一触发即物理停 |
| GitHub 意外计费 | 预算 $0 硬顶(§0.1) | 用量冻结,不受影响 |
| Stripe 退款潮 | $1 随时退 + 30 天未发货自动全退(预售页承诺) | 信誉优先,退款 SLA ≤48h |
| Worker/KV 挂 | Cloudflare 免费层 SLA;表单降级方案=直接把 action 换回 Formspree(5 分钟 sed) | 切换后侧录通知 |
| 隐私合规 | 仅收 email+variant+utm+ip;隐私页一句话人话版;"数据不出手机"主张不得在邮件/广告里夸大 | 法务话术=预售页 FAQ 原文 |

> 勾完本册 = AccessX 增长机器从"图纸"进入"烧钱验证"状态。之后的每一步(众筹、ASO、PR 波次、转介绍)都已在 [growth-plan-1m-10k.md](growth-plan-1m-10k.md) 有排期与预算,等烟雾测试数据回填后再启动。
