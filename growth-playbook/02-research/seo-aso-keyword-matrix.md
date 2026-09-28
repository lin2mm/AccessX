# SEO / ASO 关键词矩阵(90 天内容作战图)

> 版本 v1.0 · 2026-09-28 · 状态: active
> 角色:网站 = 获客机器([体系文档](../05-system/accessx-complete-growth-system.md) §5);本文是网站全部内容的单一关键词索引。
> 维护规则:每季度用 Search Console 实际数据回刷"实测难度/排名"列。访谈原话库([jtbd-interview-guide.md](jtbd-interview-guide.md) §5)产出后优先回填。

## 1. 关键词分组总览(五大内容集群)

意图标注:**I**=信息型(引流)·**C**=比较型(拔草竞对)·**T**=交易型(收割)。难度为 0–10 定性估计。

### 集群 A:兼容性(我们的护城河,扫描器的网页化)
> 页面形态:程序化页面矩阵——每锁型一页,文末嵌扫描器 CTA。这是别人拿不走的数据资产型 SEO。

| 关键词 | 意图 | 难度 | 目标页 | 优先级 |
|---|---|---|---|---|
| will a smart lock fit my door | I | 4 | `/checker/` 主落地页 | P0 |
| smart lock compatibility checker | T | 3 | `/checker/` | P0 |
| smart lock for [deadbolt / euro cylinder / mortise / rim cylinder / multipoint / uPVC / night latch] | I | 2–4 | `/doors/{type}/` ×7 | P0(程序化) |
| smart lock without replacing deadbolt | T | 3 | `/doors/deadbolt/` | P0 |
| can you put a smart lock on an apartment door | I | 3 | `/renters/` | P0 |

### 集群 B:租客(最大蓄水池)
| 关键词 | 意图 | 难度 | 目标页 |
|---|---|---|---|
| best smart locks for renters no drill | C | 5 | `/renters/best/`(客观榜文,含竞对,转扫描器) |
| renter friendly smart lock | C | 4 | `/renters/` |
| apartment smart lock no drilling / adhesive smart lock | T | 3 | `/renters/` |
| how to ask landlord for smart lock (letter template) | I | 2 | `/renters/landlord-letter/`(工具包引流) ★ |
| smart lock security deposit / move out remove smart lock | I | 2 | `/renters/deposit/` |

### 集群 C:短租房东(付费意愿最高)
| 关键词 | 意图 | 难度 | 目标页 |
|---|---|---|---|
| airbnb self check in (ideas/setup) | I | 5 | `/hosts/self-check-in/` |
| best smart lock for airbnb 2026 | C | 6 | `/hosts/best/` ★ |
| airbnb check in instructions template (free) | I | 3 | `/templates/check-in/`(模板下载→注册) ★ |
| lockbox vs smart lock airbnb | C | 2 | `/hosts/lockbox-vs-lock/` |
| digital guidebook airbnb (free) | T | 3 | `/guidebook/` ★ |
| airbnb guest welcome message template | I | 3 | `/templates/welcome/` |

### 集群 D:家庭(情感场景)
| 关键词 | 意图 | 难度 | 目标页 |
|---|---|---|---|
| know when kids get home (app) | T | 2 | `/family/arrival-alerts/` ★ |
| did my kids get home safe notification | I | 1 | 同上 |
| alternative to life360 for arrival alerts | C | 3 | `/family/compare/`(谨慎:仅事实对比) |

### 集群 E:比较型/竞品围城(客观内容抢竞对需求)
| 关键词 | 意图 | 难度 | 目标页 |
|---|---|---|---|
| august vs switchbot lock | C | 5 | `/compare/august-vs-switchbot/` |
| nuki alternative (us/uk) | C | 3 | `/compare/nuki-alternative/` |
| retrofit smart lock no subscription | C | 2 | `/no-subscription/` ★(情绪差位页,"永不强制订阅"主张) |
| smart lock subscription fatigue | I | 2 | 同上(借 Ring/Nest 涨价舆情,[leios](https://www.leios.consulting/guides/no-subscription-smart-home-guide/)) |

★ = 带"工具/模板/情绪"属性的高转化钩子页,首批必做(共 8 页)。

## 2. 九十日内容日历(每周 2 篇/页)

| 周 | 发布 | 产出形态 |
|---|---|---|
| W1–2 | `/checker/` 主页 + `/doors/deadbolt/` + `/renters/landlord-letter/` | 程序化页 ×1 + 钩子页 ×2 |
| W3–4 | `/renters/best/` + `/hosts/self-check-in/` | 榜单文 + 指南文 |
| W5–6 | `/hosts/best/` + `/templates/check-in/` | 榜单文 + 模板页 |
| W7–8 | `/guidebook/` + `/no-subscription/` | 产品页 + 情绪差位页 |
| W9–10 | `/family/arrival-alerts/` + `/hosts/lockbox-vs-lock/` | 场景页 + 对比页 |
| W11–12 | `/compare/august-vs-switchbot/` + `/doors/` 剩余 6 锁型页 | 对比页 + 程序化页收尾 |
| W13–14 | **《租屋智能锁白皮书》首发版**:`/research/renter-lock-report/`(扫描数据库匿名统计:"N 扇门中 X% 可无损升级"+锁型地图)+ 媒体通稿 + 可嵌入图表 | 数据公关页(Cloudflare Radar 式)——同时为 M4 白皮书 PR 波弹药,见 [growth-plan-1m-10k.md](../05-system/growth-plan-1m-10k.md) §6 |

之后进入"一月一锁型国家版本 + 每月一篇数据洞察"(用扫描数据库匿名统计做 PR 稿,"我们扫描了 N 扇门,发现 X% 其实能无损升级")。

## 3. ASO 矩阵(应用商店)

**iOS**
- App 名(30 字符,权重最高): `AccessX: Guest Pass & Lock`
- 副标题(30 字符): `Smart entry, no hardware req.`→(注释: "no hardware required"是最大差异文案)
- 关键词字段(100 字符,逗号分隔无空格):
  `smart,lock,checker,renter,airbnb,guest,pass,guidebook,arrival,alert,keyless,door,access,host,checkin`

**Google Play**
- 短描述(80 字符): `Guest passes, check-in guides & arrival alerts. Add the lock later/no rush.`
- 长描述首屏(前 167 字符决定展开前信息): `No smart lock? No problem. AccessX works from day one: check your door's compatibility, send guests a check-in pass, and know when family gets home.`

**商店素材纪律**(见 [app-marketing-gtm-methodology.md](../01-foundations/app-marketing-gtm-methodology.md) §6):截图第 1 张=扫描报告页 + 文案 "Snap your door. Know in 30 seconds.";预览视频复用 [presale-campaign-copy.md](../03-design/presale-campaign-copy.md) §2 开场视频 8–20s 段落。

**本地化波次**:EN(首发) → ES(美国西语裔,低成本高增量) → DE/FR(欧洲期与硬件欧洲上市同步,[iot-gtm](../01-foundations/iot-gtm-methodology.md) §6)。

## 4. 测量

- SEO:Search Console 周更——各集群曝光/点击/排名;**核心资产指标:`/doors/` 矩阵页进入扫描器的过桥率(目标 >12%)**
- ASO:商店页转化率(iOS App Analytics,目标 >25%)、关键词排名周追踪、`smart lock` 大词不进 Top 50 不加大投入,长尾词 Top 5 达标数
- 归因:网站→App 商店用带参 smartlink(UTM 贯通到 [smoke-test-landing-pages.md](smoke-test-landing-pages.md) §4 同一套命名)
