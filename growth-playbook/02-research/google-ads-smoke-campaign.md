纯自传播 12 个月 100 万无可靠先例

> **状态：历史停用 / 不执行。** 当前唯一决策入口：[主决策板](../05-system/strategy-master-summary.md)。本文件保留历史假设与出处；正文旧active、ready、唯一口径或自动上线措辞均失效。不外发、不收款、不部署。

# Google Ads $300 烟雾测试投放作战表(P0 判据用)

> **状态：paused。** 当前$0验证不投广告。每日预算/自动暂停规则不保证严格总额封顶，手动预付款也并非所有账号可用。恢复需预算明确批准及新单位经济验证。

> 版本 v1.0 · 2026-09-28 · 状态: active
> 对应: [smoke-test-landing-pages.md](smoke-test-landing-pages.md) §3–4 · 预算 $300 / 14 天 / $21.5/日
> 目标: 验证三变体的"点击→邮箱"转化(着陆页判据 >15%)与 CPL(目标 <$5);**不是**验证 ROI。

## 1. 账户与 Campaign 结构

```
Campaign: P0-Smoke-Search(Search 系列,仅搜索网络,关掉展示网络)
  地区: 美国(排除 AK/HI 降低 CPC 波动可选) · 语言: English
  出价: 手动 CPC 起步(上限 $1.50)或 Max Clicks 设 CPC 上限 $1.50
  预算: $21.5/日 × 14 天
  ├─ Ad Group A: Compatibility → lp-v1
  ├─ Ad Group B: Renter        → lp-v2
  └─ Ad Group C: Host          → lp-v3
```

## 2. 关键词(词表出自 [seo-aso-keyword-matrix.md](seo-aso-keyword-matrix.md),先用精确+词组匹配)

| 组 | 关键词( [exact] / "phrase" ) | 意图 |
|---|---|---|
| A Compatibility | [will a smart lock fit my door] · "smart lock compatibility" · [smart lock compatibility checker] · "what smart lock fits my door" · [smart lock for my door] | 最高意图 |
| B Renter | [smart lock for renters] · "renter friendly smart lock" · [apartment smart lock no drilling] · "no drill smart lock" · [smart lock apartment door] | 高意图 |
| C Host | [airbnb self check in] · "airbnb smart lock" · [airbnb check in instructions template] · "digital guidebook airbnb" · [airbnb keyless entry] | 高意图 |

**否定关键词(账户级,Day 1 就加,省钱大头):** `free download, jobs, salary, wholesale, pdf, programming, hotel system, locksmith near me, diy lock pick, car, door handle replacement`(+品牌词:august/yale/schlage 广告政策——会比较烧钱,烟雾期先否定)

## 3. 广告文案(每组 1 条 RSA;15 标题选 8–10 填入)

**A 组(→ lp-v1)**
- 标题: Does a Smart Lock Fit Your Door? | Free 30-Second Check | Snap 2 Photos, Get Your Report | No Drilling Verdict Included | Renter-Safe Answers | AccessX Door Checker
- 描述1: Take 2 photos of your lock. Get an instant compatibility report — drilling, damage, landlord, all covered. Free.
- 描述2: Most US doors already fit a retrofit smart lock. Check yours in 30 seconds — nothing to buy.

**B 组(→ lp-v2)**
- 标题: Keyless Entry for Renters | No Drilling. Landlord-Friendly | $11.9/mo, Lock Included | Move Out? Take It With You | Your Old Key Still Works | Reserve for $1
- 描述1: A smart lock that installs inside your door with adhesive. No drilling, no damage, no deposit risk.
- 描述2: From $11.9/month including the lock. Cancel options anytime — after 12 payments it's yours.

**C 组(→ lp-v3)**
- 标题: Stop Texting Keys to Guests | Free Airbnb Check-In Passes | Guests Need No App | Syncs With Your Bookings | Guides + Keyless, Free | AccessX for Hosts
- 描述1: Free digital guidebooks and guest passes that open in any browser. Set up your first one in minutes.
- 描述2: Listings with smart locks average a 4.95 check-in rating. Start free — add the lock when you're ready.

**附加链接(sitelinks):** Compatibility Checker(→v1) / For Renters(→v2) / For Hosts(→v3) / How it works(锚点)

## 4. 跟踪与判读

- 转化事件:邮箱提交(表单 POST 200)/ `deposit_click`(V2)。Plausible 已有事件;Google Ads 侧用"导入离线转化"太复杂,烟雾期**直接在 Ads 后台看 CTR,在 Plausible 看后端**,用 UTM 对表(`utm_campaign=p0-smoke`,已内置于 HTML)。
- 判读节奏:
  - Day 3:各组 CTR <2% → 换标题(动标题不动出价);
  - Day 7:按组累计 ≥60 点击开始读后端:L→邮箱 >15% 的组保留,<8% 的组关;
  - Day 14:按 [判据表](smoke-test-landing-pages.md) §4 交卷;胜出的变体进"保留投放($10/日常态)",同时其主张锁定为 [presale-campaign-copy.md](../03-design/presale-campaign-copy.md) 的主 Hero。
- **防烧钱保险丝:** 账户设置每日预算硬上限 + 每周三人工对账;否定关键词每周补一次搜索词报告里的垃圾词。

## 5. 常见问题预案

| 状况 | 对策 |
|---|---|
| 关键词"低搜索量"不展示 | 改词组匹配;或并入邻近大词组 |
| 点得起但全不转化(CPL>$15) | 先换着陆页 Hero(把 V1 扫描器 CTA 换成表单),再怀疑流量 |
| 某组 CPC>$2.5 | 该组转纯精确匹配,并降出价上限 |
| 邮箱填表率高但$1订金点击<20% | 订金按钮文案改"Reserve—$1 refundable"(强调可退,已内置) |
