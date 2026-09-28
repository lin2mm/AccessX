纯自传播 12 个月 100 万无可靠先例

> **状态：历史停用 / 不执行。** 当前唯一决策入口：[主决策板](../05-system/strategy-master-summary.md)。本文件保留历史假设与出处；正文旧active、ready、唯一口径或自动上线措辞均失效。不外发、不收款、不部署。

# 烟雾测试计划:3 个落地页变体 + 投放方案(P0 阶段 · 需求验证第 2 级)

> 版本 v1.0 · 2026-09-28 · 状态: active
> 对应体系: P0 出门条件「落地页转化 >15%」 · 方法: [market-research-methodology.md](../01-foundations/market-research-methodology.md) §7 五级火箭第 2 级
> 预算: ≤$800 · 周期: 14 天

## 1. 实验设计

**三变体并行,测的是"钩子角度",不是布局**(三页同一模板,只换主张与主图,控制变量):

| 变体 | 主张角度 | 对应假设 | 主要流量 |
|---|---|---|---|
| V1 **Scanner** | "你的门能装智能锁吗?"——扫描器 | H3 扫描即钩子 | Google 搜索广告(高意图词) |
| V2 **Renter** | 租客:不打孔无损升级,搬走带走 | H1 租客痛点 + H4 | Reddit/兴趣定向 |
| V3 **Host** | 房东:停止给客人发短信送钥匙 | H2 | r/AirBnBHosts、房东 FB 群 |

两级漏斗(越往后证据越硬):
```
广告/帖 → 落地页 → [第1级] 留邮箱进 waitlist(目标 >15%)
                  → [第2级] 假门:$1 VIP 订金(锁价 $99 预留位)(目标 >2% / 8% 之邮箱转化)
```
$1 订金按钮点击后显示"预售未开启,留下邮箱第一时间通知并获 $20 抵扣"——**必须诚实**,假门≠诈骗;所有款项原路可退(见 §6 伦理)。

## 2. 落地页文案(英文为准上线,中文为注释)

### V1 — Scanner 变体
**Hero**
> # Does a smart lock fit your door?
> ## Snap 2 photos. Get your answer in 30 seconds — free.
> [Upload photos →] (注释: 假门,点了收集邮箱)
> ✅ No signup needed · No drilling required · Works on rental doors

**三论点**
1. **Instant compatibility report** — Deadbolt, euro cylinder, mortise, rim… our checker knows them all.(我们的答案覆盖你的锁型)
2. **Renter-safe verdict** — Find out if you can upgrade without touching the outside of your door.(不动门外=押金安全)
3. **Your options, mapped** — If it fits: see the no-drill lock that ships to you. If not: free alternatives.(无论结果都有下一步)

**FAQ(节选)**
- Is this a real product? — We're launching the checker in the AccessX app soon. Leave your email, be first in line.(诚实声明)
- Do I have to buy anything? — No. The check is free.

### V2 — Renter 变体
**Hero**
> # Your landlord said no? Your door didn't.
> ## Upgrade to keyless entry without drilling. $11.9/mo, lock included. Move out? Take it with you.
> [Reserve for $1 →]

**三论点** ① No drill, no damage, no deposit risk ② Your old key still works(实体钥匙永不失效) ③ Cancel anytime — the lock is yours after 12 payments.

**社会证明位**:访谈金句授权后填入("I asked my landlord with their template letter — got approved in a day.")(先用占位,访谈产出后替换)

### V3 — Host 变体
**Hero**
> # Stop texting keys to strangers.
> ## Guest guidebooks + check-in passes — free. Keyless codes — when you're ready for the lock.
> [Create my free guide →]

**三论点** ① Free digital guidebook & guest pass, no app for guests(客人免装 App) ② Auto-send with your booking calendar(接 iCal 自动发) ③ Add the lock later — listings with smart locks average a 4.95 check-in rating([Airbnb](https://www.airbnb.com/resources/hosting-homes/a/connect-a-smart-lock-to-airbnb-for-smoother-check-ins-667))

## 3. 流量计划($600 投放 + 免费渠道)

| 渠道 | 预算 | 定向 | 测什么 |
|---|---|---|---|
| Google Search | $300 | `will a smart lock fit my door` / `smart lock compatibility` / `renter friendly smart lock`(词表见 [seo-aso-keyword-matrix.md](seo-aso-keyword-matrix.md)) | V1/V2 CTR 与转化 |
| Reddit(付费+有机) | $150 | r/Renters、r/homeautomation | V2 |
| FB/房东群(有机为主+小量投放) | $150 | STR host 兴趣 | V3 |

统一 UTM:`utm_source={google|reddit|fb}&utm_medium={cpc|organic}&utm_campaign=p0-smoke&utm_content={v1|v2|v3}`

## 4. 度量与判据(14 天后交卷)

| 指标 | 工具 | 通过线 | 解读 |
|---|---|---|---|
| 落地页→邮箱 | Plausible + 表单事件 | **>15%** | 主张成立 |
| 邮箱→$1 订金点击(假门) | 按钮事件 | >20% | 付费意愿初步 |
| $1 实际支付 | Stripe | **>2% of LTV UV** | 第 3 级证据,可直接开预售页(五级火箭第 4 级) |
| 每变体 CPL | — | <$5 邮箱线索 | 角度效率高下 |

**处置规则**:三变体全 <10% → 主张/人群重审;任一变体 >15% 且 $1 >2% → 该角度定为首发主张,其余两页保留为分人群落地页。

## 5. 执行清单

- [x] 三套落地页 HTML 成品:[lp-v1](lp-v1-scanner.html)/[lp-v2](lp-v2-renter.html)/[lp-v3](lp-v3-host.html)(自托管,内联 CSS,UTM+事件埋点内置)
- [x] 线索收集后端:[collector-worker.js](collector-worker.js)(Cloudflare Workers 免费层,KV 存储、去重、honeypot、回跳 ?ok=1)
- [ ] 部署 Worker(5 分钟,步骤见 collector-worker.js 头部)→ 把 HTML 中 `collector.YOUR-SUB.workers.dev` 换成真实地址
- [ ] Stripe Payment Link($1,可退)替换 lp-v2 中 `STRIPE_PAYMENT_LINK` 占位;开"自动退款若 30 日未预售"日历提醒
- [ ] Plausible 替换 data-domain;事件已埋:cta_click / email_submit / deposit_click / paid
- [ ] 素材:三变体各 1 张主图(门+手机示意)+ 15s 录屏(扫描演示)
- [ ] 投放启动:按 §3 渠道表,先 $300 Google Search 高意图词(词表见 [seo-aso-keyword-matrix.md](seo-aso-keyword-matrix.md))

## 6. 伦理与合规

1. 页面 FAQ 必须说明"产品未发布,你在候补名单"(防止误导性预售指控)。
2. $1 一律明示 refundable;收集后 30 天内未开预售→主动全额退+送 $20 上线抵扣券。
3. 邮箱收集带双重确认(double opt-in),供 [presale-campaign-copy.md](../03-design/presale-campaign-copy.md) 复用前须确认同意书。
4. 广告文案不使用竞对商标(Google Ads 政策)。
