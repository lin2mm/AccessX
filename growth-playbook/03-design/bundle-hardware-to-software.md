纯自传播 12 个月 100 万无可靠先例

> **状态：历史停用 / 不执行。** 当前唯一决策入口：[主决策板](../05-system/strategy-master-summary.md)。本文件保留历史假设与出处；正文旧active、ready、唯一口径或自动上线措辞均失效。不外发、不收款、不部署。

# 买锁送软件设计(任务 8):单独购买门锁 → 反向获得软件功能升级

> 版本 v1.0 · 2026-09-28 · 状态: active
> 模式本质: **Hardware-unlocked Software**——硬件是软件高级功能的"实体钥匙"。
> 案例依据: [案例库](../04-case-studies/monetization-case-studies.md) §流向 D(Ring/Nest/Oura/Peloton/Apple/GoPro)

## 1. 为什么必须设计这条反向链路

- 不是所有人都吃订阅(订阅疲劳真实存在,[leios](https://www.leios.consulting/guides/no-subscription-smart-home-guide/):美国家庭年均智能家居订阅支出 $200–600,抵触情绪增长)。**买断用户是客单价最高、口碑最真的群体,不能把他们晾在"基础版"**。
- 从免费软件买锁的用户(任务 7 链路之外),以及 Amazon/零售渠道直接买硬件的新客,需要一个**把他拉回 App 生态**的机制——硬件盒内的一张兑换卡就是桥。
- 对渠道的意义:"买锁送 Pro"让 $119 的标价带上可感知的软件价值($3.99×12 = $48 心理价值),打折不降价。

## 2. 核心机制:Device Pro(设备版高级功能)

**规则:每一把被激活的 AccessX 锁,为其绑定住所永久解锁"设备维度"的高级功能。**

| 维度 | 免费(无锁) | Device Pro(有锁即得,锁活着就有) | 仍留给全局 Pro($3.99/月) |
|---|---|---|---|
| 住所数量 | 1 | 1(锁所在住所) | 无限 |
| 出入日志 | 30 天 | **无限历史(该门)** | 无限+跨住所导出 |
| 访客通行证 | ✅ | ✅ + **自动生成门锁限时码直接进通行证** | +品牌化/域名 |
| 日历自动发送 | ✗ | ✅(该住所 Airbnb/iCal) | ✅ 多房源 |
| 家人提醒 | 1 人 | 家庭组(门口事件驱动,手机没电也记录) | +任意 geofence 地点 |
| 协作席位 | 1 | 5(家庭/室友) | 无限 |
| 扫描器报告 | 基础 | 深度报告 | 深度+PDF |

设计要点:
- **"送"的不是订阅时长,是设备身份**——只要锁在线,Device Pro 就在。用户的感知是"买锁 = 永久完整版",而不是"送 12 个月 Pro 然后收租"(后者是 Oura/Ring 挨骂的结构,见案例库规律 2)。
- 全局 Pro 与 Device Pro 的差距收窄到**只有一个变量:规模**(多个住所/房源/导出/白标)。个人买断用户几乎不损失任何东西——这正是军规"免费/买断层必须独立成立"的延伸。

## 3. 硬件盒内桥接:实体兑换卡

```
开箱 → 快速指引卡(大号 QR)→ 扫码 →
  情形 A:已有 App 用户  → 直接绑定锁 → 该住所亮 Device Pro 徽章
  情形 B:纯硬件新客    → 下载 App → 30 秒绑定 → "您的永久权益已激活"庆祝页 →
                        再引导体验 1 个无硬件 Pro 功能(给他看"全局 Pro"的风景)
```

- 兑换卡同时是**渠道客户的数据回收口**:Amazon 买完锁的用户,扫码这一刻才第一次进入我们的 CRM,此前他对我们是隐形人。
- 盒内附第二张卡:"把这套指南/通行证发给下一位访客"→ 病毒回路接入(见 [系统文档](../05-system/accessx-complete-growth-system.md) §6)。

## 4. 到期与升级路径(软着陆,不惩罚)

| 用户状态 | 发生什么 | 设计意图 |
|---|---|---|
| 锁正常在线 | Device Pro 持续有效 | 硬件=会员锚点 |
| 锁离线/断电 >30 天 | 提醒;权益保留(不惩罚性收回),仅该住所功能回到"30 天日志" | 避免制造敌意 |
| 买第二把锁 | 两住所自动升 Device Pro×2;弹窗提示"再加 $1.9/月合并为全局 Pro" | **多锁=全局 Pro 的最佳推手** |
| 从买断想转订阅(任务 7 方向) | 已购锁折 $59 信用点抵首期 | 双向链路互通,用户永不吃亏 |

## 5. 对标与教训校准

| 案例 | 事实 | 我们抄/避什么 |
|---|---|---|
| Ring Protect | 硬件买断,但录像回看 $4.99–10/月起([pocket-lint](https://www.pocket-lint.com/ring-protect-vs-arlo-secure-vs-nest-aware/)) | 警惕:把"回看历史"放订阅是 Ring 最大骂点之一——我们 Device Pro 直接给无限历史,差异化卖点 |
| Nest Aware | $10–20/月,2025 年 8 月涨价 25% 引发哗然([leios](https://www.leios.consulting/guides/no-subscription-smart-home-guide/)) | 涨价本身没错,**无价值感的涨价**才是;我们的订阅必须每期交付新功能(发布日志讲话术) |
| Oura 环 | 先买断 $299+,完整体验仍需 $5.99/月,用户普遍感觉"被二次收费"([whoop 对比](https://www.runnerspicks.com/blog/whoop-pricing-2026-membership-explained/)) | 反面教材:买断+订阅双剥皮。我们买断即完整,"二次付费"只发生在**扩容**而非"解锁已有" |
| Peloton | 器材 $1,400+ 仍须 All-Access $49.99/月才能完整用([CNBC](https://www.cnbc.com/2025/10/01/peloton-revamps-equipment-raises-prices-ahead-of-holidays-.html)) | 极端强制订阅=增长天花板;我们只做"轻强制"(多房源才需要 Pro) |
| Whoop(反向) | 订阅含硬件、12 月会员免费换新([trackervs](https://trackervs.com/pricing/whoop-pricing/)) | 用于任务 7 合约设计;换代赠品移植到 Pro+Lock 续期 |
| August | App 基础功能终身免费、无强制云订阅([战略文档竞品表](../01-foundations/software-first-gtm-strategy.md)) | 正面锚点:买锁用户的"基础完整感"是口碑护城河,我们对齐 |

## 6. 渠道营销话术(这条链路对外怎么说)

- Amazon 详情页/包装正面:**"Free App. No subscription required. Ever."**——在 Ring/Nest 订阅疲劳的市场情绪里,这句话就是差异化武器(同时为 Device Pro 铺垫)。
- 官网对比页:做一张"5 年总成本对比表"(我们 vs Ring/Nest/August 结构差异),用对手的订阅费替我们讲故事(数据可用 [leios 5 年对比](https://www.leios.consulting/guides/no-subscription-smart-home-guide/))。
- 私域:老用户买锁 → "您的 Pro 试用期自动转为 Device Pro 永久版" 的个性化推送——把"反向升级"当面锣对面鼓地告知,制造超预期时刻(delighter)。

---

*正向流向见: [bundle-software-to-hardware.md](bundle-software-to-hardware.md)(任务 7) · 两链路合流: [../05-system/accessx-complete-growth-system.md](../05-system/accessx-complete-growth-system.md) §3「双向转化引擎」*
