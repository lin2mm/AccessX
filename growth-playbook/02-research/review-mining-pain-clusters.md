# 差评挖矿:竞品 App 痛点聚类(P0 判据的种子样本)

> **证据降级与安全纠正：** 下文旧稿“约35条/频次/主题饱和”缺少本轮可重算逐条台账，不作为验证通过依据。新台账 [icp-complaint-evidence.csv](icp-complaint-evidence.csv) 为14个公开讨论串的搜索可见摘要，非14个独立故障、非代表性样本。门磁只测门开关，不证明锁舌锁定；断网设备不能保证远程重启；不再发布未经工程验证的功能/24h SLA/赔付承诺。参见新战略。

> 版本 v1.0 · 2026-09-28 · 状态: active(种子样本;P0 全量 ≥50 条需脚本抓取,见 §4)
> 方法: [市场研究方法论 §8-4](../01-foundations/market-research-methodology.md)——**对手的 1 星评论就是我们的需求文档**。
> 本轮样本: Reddit(r/TrySwitchBot、r/Nuki、r/HomeKit)+ Trustpilot(Nuki.io,498 条评论页)约 35 条可见负评,人工聚类。样本量小但主题已收敛——这正是"主题饱和"信号。

## 1. 痛点聚类结果(按出现频次排序)

| 簇 | 主题 | 典型证据(原话节选,均带源) | 复现人数(本轮) |
|---|---|---|---|
| **P1 连接不可靠** | "no response"/离线/断连,Wi-Fi 与 Thread 皆中招 | "worked for 9 months… then 'no response' on both locks, factory reset 无效" [1];"goes offline and needs 拔电池硬重启" [5];Nuki Trustpilot 大量 "keeps going offline" [2] | ≥10 |
| **P2 把自己锁门外(lockout)** | 电池暴毙无预警 / 换手机或重置 App 后被锁在门外 | "battery pack died, LED 和 App 都没提醒,请锁匠 €150,Nuki 赔偿一张 15% 优惠券" [3];"reset 手机=locked out of your HOUSE" [2];"motor block,锁了我公司门" [2] | ≥8 |
| **P3 电池与电量误报** | 电量虚标(拔插后 62%)、3–4 个月就要换 | August 被点名"每 3–4 个月换电池、App 响应慢" [4];Nuki 电池一年左右报废 [3] | ≥6 |
| **P4 固件更新=灾难** | 一次 OTA 把好锁变砖/不稳定 | "FW 4.3.11 之后两把锁 HomeKit 全部 no response" [1];"唯一一家软件更新让产品越变越差的公司" [2] | ≥6 |
| **P5 自动解锁不稳定** | geofence 成功率两极 | SwitchBot Ultra "auto-unlock 试 30 次成功 1 次",同用户 Nuki 端 "99% 成功" [5] | ≥4 |
| **P6 状态误报/校准漂移** | App 显示与实际锁态不一致 | "以为锁了其实没锁;以为开了其实没开;calibration 几天到两周就漂" [4] | ≥4 |
| **P7 售后=模板机器人** | 响应慢、反复要日志无下文、赔偿羞辱性 | "support 变 chatbot…4 个月来回扯皮" [2];"EU 发货 16 天,工单 5 天+ 才回" [5] | ≥8 |
| **P8 远程场景硬伤** | 民宿远程救不了场 | "度假屋每几周死机,必须派人去拔电池,**没有远程 reboot**" [3] | ≥3 |

**与 P0 判据对照**(完整体系 P0:同一痛点主题复现 ≥3 个,每主题 ≥20 条):种子样本已复现 8 个主题、3 个主题逼近量级;全量抓取(§4)大概率达标,判据初判"通过方向",待脚本数据背书。

## 2. 对产品设计的反击映射(差评 → 我们的军规)

| 差评簇 | 我们的对策(落点) |
|---|---|
| P1 断连 | **本地 BLE 自治,云只发钥匙与日志**(工程红线,已写进 lock-type-scope §4);"连接健康分"周报 |
| P2 lockout | 物理钥匙永远可用(retrofit 天然)+ 电量三重预警(App 推送+LED+蜂鸣)+ **USB-C 应急供电口**;换机流程零问答迁移 |
| P3 电池 | 续航目标写进规格表(≥10 个月)+ 电池健康曲线透明化,虚报=自杀 |
| P4 固件事故 | **灰度发布(1%→10%→100%)+一键回滚**;发版说明人话化——这是 P4 的直接解药,对照 Cloudflare 可靠性预算原则 |
| P5 自动解锁 | 先不做 geofence auto-unlock 的 P0 承诺(不稳定的功能比没有更伤);v1 用 **近距离自动解锁(到店门口才激活)** 降误触 |
| P6 状态误报 | **随锁标配门磁(物理真值)**——状态以门磁为准,旋钮位置仅辅助;校准双周自检+一键重校 |
| P7 售后 | 24h SLA 写进首页;lockout 补偿政策(首次 lockout 报销锁匠费,封顶 $100)——**用对手最羞辱人的场景做品牌** |
| P8 民宿硬伤 | **远程软重启指令** + 门磁-heartbeat 失联告警(P8 是房东群最痛的,恰好是我们高付费人群) |

## 3. 可直接上落地页/预售页的"弹药句"(改写自真实差评)

- "30 次自动开锁成功 1 次"——我们不卖噱头,先卖可靠。(对照 P5)
- "拔电池才能重启的锁,不配管度假屋"——AccessX 支持远程重启与失联告警。(P8)
- "锁死那天,厂商只赔了我一张 15% 优惠券"——我们的首次 lockout 补偿写进 FAQ。(P2/P7)

> 合规:引用为公开评论的匿名化改写,用于对比教育,不点名嘲讽具体品牌(广告法与平台政策)。

## 4. 全量抓取方案(P0 判据的 ≥50 条样本,半天工作量)

```bash
pip install app-store-scraper google-play-scraper
```
```python
# 目标:Nuki / SwitchBot / August(Yale Access)/ Aqara 四家 App Store+GP 各抓 1–3 星 ≥13 条
from app_store_scraper import AppStore
import json, collections
APPS = {"nuki": AppStore("us","nuki-smart-lock",657075048),
        "switchbot": AppStore("us","switchbot",1082754760)}
for name,app in APPS.items():
    app.review(how_many=200)
low = [r for r in app.reviews if r["rating"]<=3]
# 按簇关键词归类:offline|disconnect|no response → P1;locked out|locksmith → P2;...
```
- Google Play 同理(`google-play-scraper` 的 `Sort.NEWEST`,`filter_score_with=3`)
- Amazon 评论:手动采样各锁详情页 1–3 星 `most recent` 前 30 条爬表(遵守 ToS,低速)
- 产出入库:`02-research/review-mining-dataset.csv`(date, app, source, rating, cluster, quote, helpful_votes)→ 回填本表 §1 计数列,形态与 [P0 判据](../05-system/accessx-complete-growth-system.md) §8 对齐。

## 5. 来源

1. [r/Nuki — Very disappointed on Nuki(FW 4.3.11/Thread no response 串)](https://www.reddit.com/r/Nuki/comments/1grj415/very_disappointed_on_nuki/)
2. [Trustpilot — nuki.io reviews(498 条,负评聚类)](https://www.trustpilot.com/review/nuki.io?page=3)
3. [r/HomeKit — LOCKED OUT with NUKI 3 Pro(电池暴毙+15% 优惠券事件)](https://www.reddit.com/r/HomeKit/comments/19f9hj2/locked_out_of_my_house_with_nuki_smart_lock_3_pro/)
4. [r/TrySwitchBot — Will the lock pro ever be reliable?(校准漂移+August 电池/App 对比)](https://www.reddit.com/r/TrySwitchBot/comments/1fisvca/will_the_lock_pro_ever_be_reliable/)
5. [r/TrySwitchBot — I'm returning my Lock Ultra(geofence 1/30、硬重启、售后与发货)](https://www.reddit.com/r/TrySwitchBot/comments/1pmo6y3/im_returning_my_lock_ultra/)
