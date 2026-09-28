纯自传播 12 个月 100 万无可靠先例

> **状态：历史停用 / 不执行。** 当前唯一决策入口：[主决策板](../05-system/strategy-master-summary.md)。本文件保留历史假设与出处；正文旧active、ready、唯一口径或自动上线措辞均失效。不外发、不收款、不部署。

# 线索培育邮件序列:留资 → $1 订金 → 众筹转化

> **状态：待重审，不自动导入发送。** 目前不收订金，暂停VIP轨及排队跃迁承诺；只向主动同意用户提供有价值更新。事务与营销分开，以任务完成而非打开率衡量。见 [双主线战略](../05-system/dual-engine-growth-strategy.md) §10。

> 版本 v1.0 · 2026-09-28 · 状态: ready(ESP 开户即可导入)
> 上游: 落地页/collector Worker ([collector-worker.js](../02-research/collector-worker.js)) · 下游: 预售页 ([lp-presale.html](../02-research/lp-presale.html)) 与 Kickstarter([presale-campaign-copy.md](presale-campaign-copy.md))
> 语言: 邮件正文英文上线,中文为注释。

## 0. 发送基建(选型已定)

| 项 | 决定 | 理由 |
|---|---|---|
| ESP | **Resend 免费层**(3,000 封/月、100 封/日) | Cloudflare 官方推荐路径——MailChannels × Workers 免费集成 **2024-06-30 已停服**,Cloudflare 文档现已改指 Resend;烟雾测试期线索量 <300 条,免费层绰绰有余 |
| Worker 职责 | 只收不发 | Worker 保持最小面;发信走 Resend API(`RESEND_API_KEY` 以 `wrangler secret put` 注入,随时可升级自动欢迎信) |
| 首月操作 | CSV 导出 KV(wrangler)→ 导入 Resend Audience → 手动排期 | <300 条自动化性价比低,先把文案跑出手感 |
| 域名认证 | 发信域 `mail.getaccessx.com`,SPF/DKIM/DMARC 三条 DNS | 没 DMARC 进不了 Gmail 主收件箱(2024 新规) |
| 合规 | 每封必带退订链接 + 实体邮寄地址(CAN-SPAM);一键退订 header(Gmail 批量发信强制) | Resend 内置一键退订 header,勾上即可 |

## 1. 序列总览

**A 轨:等待名单线索**(落地页/预售页 waitlist,未付 $1)
| 封 | 时点 | 目标 | KPI |
|---|---|---|---|
| A0 | 留资后 ≤5 分钟 | 立刻交付价值 + 设定预期 | 打开率 >45% |
| A1 | D3 | 品牌主张(为什么永久免订阅) | 打开 >35% |
| A2 | D7 | 异议逐个拆掉(租客/兼容/锁门外) | CTR >6% |
| A3 | D14 | 社会证明 + 预售开启日预告 | 点击预售页 >8% |
| A4 | 预售开启日 | 转 $1 订金 | waitlist→订金 ≥15% |

**B 轨:$1 订金 VIP**(已转化,保活防退款)
| 封 | 时点 | 目标 | KPI |
|---|---|---|---|
| B0 | 付款后即时 | 确认 + 病毒回路(分享跳队) | 分享率 >10% |
| B1 | D7 | 工程进展(信任资产) | 打开 >50% |
| B2 | D21 | 功能深潜(客人通行证全流程) | CTR >8% |
| B3 | 众筹开跑前 48h | VIP 提前链接 | 打开 >60% · 首 24h 转化 ≥30% |

**写作铁律**:每封 <120 字正文、单一 CTA、纯文本优先(不发重图 HTML)、P.S. 必有钩子。UTM 统一 `?utm_source=email&utm_medium=nurture&utm_campaign={ax_a0…b3}`。

## 2. A 轨正文

### A0 · 欢迎(留资后 5 分钟内)——最重要的一封
- **Subject A**: You're in. Here's your 30-second door check ✅
- **Subject B**: Your door, checked in 30 seconds (no hardware needed)
- **Preview**: Two photos. That's all it takes to know.

> Hi there,
>
> Thanks for joining the AccessX waitlist — you're one step ahead of launch day.
>
> While you're here: our free compatibility check works today, no lock required. Two photos of your door, 30 seconds, and you'll know exactly which smart lock class fits (yours probably fits).
>
> **[Check my door — 30 seconds, free](https://getaccessx.com/app?utm_source=email&utm_medium=nurture&utm_campaign=ax_a0)**
>
> No account wall, no credit card. If it doesn't fit, we'll tell you that too.
>
> — The AccessX team
>
> P.S. You joined with {variant} — we read every reply. Hit reply and tell us what's broken about your door situation today.

(注释: 唯一的 CTA 拉去扫描器=种下 App 里重度功能的第一颗种子;P.S. 邀请回复=送 Gmail 信任信号+访谈线索。)

### A1 · D3 品牌主张
- **Subject A**: Why we'll never charge you a monthly fee for your own lock
- **Subject B**: Your lock should never become a brick
- **Preview**: A decision we made before we designed the hardware.

> Two years ago we watched a roommate drama play out on Reddit: a "smart" lock bricked after the company shut its servers. Physical key long lost.
>
> So we wrote one line into our spec before anything else: **basic lock control is free forever, and works locally.** Guest codes, auto-lock, app unlock — no subscription, ever. Optional Pro adds multi-property automation, but your door will never owe us rent.
>
> That's the whole email. Back to building.
>
> — The AccessX team
>
> P.S. First 3,000 locks get Pro free for the life of the lock. Details when reservations open.

### A2 · D7 异议门诊
- **Subject A**: "But my landlord…" (and 4 other honest answers)
- **Subject B**: The 5 questions everyone asks before reserving
- **Preview**: Renters, batteries, lockouts — no marketing answers.

> Five questions, straight answers:
>
> 1. **Renters?** Mounts inside with adhesive. Zero drilling, exterior untouched, removes without a trace. Landlord letter template included.
> 2. **Door fit?** Free 30-second check in the app. Doesn't fit → any payment refunded in full, no reason needed.
> 3. **Locked out?** Your physical key always works. Plus our First-Lockout Promise: we cover a locksmith up to $100 if our lock ever fails you.
> 4. **Wi-Fi down?** Bluetooth works locally. Your door doesn't care about your router.
> 5. **Battery?** ~10 months, triple warnings, USB-C emergency power.
>
> Reservations open soon — $1, fully refundable.
>
> — The AccessX team

(注释: §2 FAQ 原文回用;此封意在把"还没想到的担忧"提前清零,为 A4 转化铺路。)

### A3 · D14 预告
- **Subject A**: Doors are lining up. Yours in?
- **Subject B**: Reservations open {DATE} — here's what $1 gets you
- **Preview**: $89 + free sensor, before anyone else sees it.

> Quick numbers: {COUNT} renters and hosts are already in line for the first batch. When reservations open on **{DATE}**, $1 locks in:
>
> ✅ The $99 launch price (retail $119)
> ✅ A free door sensor
> ✅ Lifetime Pro — genesis batch only, first 3,000 locks
> ✅ VIP early link 48h before the public campaign
>
> $1 is refundable anytime, no questions. That's the deal.
>
> **[See the reservation page](https://getaccessx.com/presale?utm_source=email&utm_medium=nurture&utm_campaign=ax_a3)**
>
> P.S. {COUNT} is a real counter from our waitlist, not marketing math.

### A4 · 预售开启日(转化封)
- **Subject A**: It's open. $1 reserves your lock 🚪
- **Subject B**: Your early-bird price is live (48h head start)
- **Preview**: Refundable anytime. Genesis perks are not unlimited.

> It's live. Reserve your AccessX Lock for **$1**, fully refundable:
>
> **[Reserve my lock — $1](https://getaccessx.com/presale?utm_source=email&utm_medium=nurture&utm_campaign=ax_a4)**
>
> You get: the $99 price lock, a free door sensor, priority shipping, lifetime Pro (first 3,000), and the VIP link 48h before the public launch.
>
> Refund anytime with one email. No questions.
>
> — The AccessX team

## 3. B 轨正文($1 订金已付)

### B0 · 即时确认 + 病毒回路
- **Subject**: Lock reserved ✅ — want to skip 10 spots?
- **Preview**: One forward = 10 places up the queue.

> Done — your AccessX Lock is reserved. Genesis perks are locked to {EMAIL}.
>
> **Skip the line**: forward your personal link to a friend who rents or hosts. Each confirmed reservation bumps you **10 spots** toward the front of the first batch.
>
> Your link: https://getaccessx.com/r/{REF_CODE}
>
> Questions? Reply to this email — a human reads it.
>
> P.S. Your $1 is refundable anytime. It earns you nothing but your place — and your price.

(注释: 病毒回路直接抄 Dropbox 跳队机制;REF_CODE 生成见 go-live-runbook §3.4,烟雾期可先用 prefilled 转发文案代替真实追踪链接。)

### B1 · D7 工程进展
- **Subject**: From the bench: what we tightened this week
- **Preview**: Adhesive tested to 40 door slams. Video inside.

(注释: 每周一封真实工程记录——测试数据/失败/返工都写,信任资产打法,与 [iot-gtm](../01-foundations/iot-gtm-methodology.md) §4 "预售期间信任内容"一致。**留出每周模板,内容由硬件团队周会产出**。)

### B2 · D21 功能深潜
- **Subject**: Watch a guest let themselves in (3 taps)
- **Preview**: Parking → elevator → door. No keys, no texts.

(注释: 客人通行证全流程动图 + 落地页 V3 房东主张回用;目的=把订金客变成产品宣讲者,为 B3 的分享预热。)

### B3 · 众筹前 48h
- **Subject**: Your VIP link works in 48 hours
- **Preview**: Super Early Bird ($89 + sensor) is 300 units. Deposit-holders first.

> In 48 hours the campaign opens to the public. Your link opens **24 hours earlier**:
>
> https://getaccessx.com/vip?utm_source=email&utm_medium=nurture&utm_campaign=ax_b3
>
> Super Early Bird — **$89 with the free door sensor — is capped at 300 units.** Deposit-holders see it first; your $1 converts into the order in one tap.
>
> Set a reminder. These go in hours, not days.
>
> — The AccessX team

## 4. 执行清单(导入 ESP 前)

- [ ] Resend 开户 + `mail.getaccessx.com` 三条 DNS(SPF/DKIM/DMARC)验证通过
- [ ] 导入 Audience:从 Worker KV 导出(`wrangler kv:key list/get`,见 go-live-runbook §3.2),按 `variant` 分组打 tag(airbnb-host / renter / scanner / presale-waitlist)
- [ ] 8.js 封邮件按本文档粘贴,UTM 与 Plausible 目标核对一遍
- [ ] {COUNT} 手工填真实 KV 计数(A3 社交证明,绝不虚构——与 [google-ads-smoke-campaign](../02-research/google-ads-smoke-campaign.md) 诚实红线一致)
- [ ] 自测:Gmail/Outlook/Apple 邮件客户端各收一遍,确认进主收件箱、一键退订可见
- [ ] A0 上线后每周看一次打开率;<30% 则先换 Subject 再动正文
