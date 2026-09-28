# 门神对标:Cloudflare(虚拟世界)vs AccessX(物理世界)

> **指标纠正：** Q4 2025 DBNR为120%，119%为前季。GAAP、non-GAAP及现金流口径不可混用，参见 [证据复核](software-hardware-evidence-review.md)。

> 版本 v1.0 · 2026-09-28 · 状态: active
> 任务来源: 用户指令——学习 Cloudflare 的盈利策略/免费与收费服务,作为"虚拟世界的门神",与我们"物理世界的门神"做比对学习清单。
> 本质洞察先行: **两家公司的生意都是"站在必经之路上,决定谁能通过"。门神的第一资产不是门,是信任;第一融资方式不是收费,是流量过境。**

## 1. Cloudflare 财务快照(FY2025,全部财报口径)

| 指标 | 值 | 学习点 |
|---|---|---|
| 营收 | **$2.168B(+29.8%)**,Q4 $614.5M(+33.6%,再加速)[1] | 免费分发+企业变现的复合飞轮成立 |
| GAAP 毛利率 | 74.5%(长期目标区间 75–77%)[1] | 他们给毛利定**上下限**:太高=投入不足,太低=模型坏 |
| GAAP 净亏 | -$102.3M(亏率 4.7%)[2] | 用非GAAP+现金流口径管理经营 |
| Non-GAAP 运营利润 | $303.9M(14.0%)[2] | |
| 自由现金流 | $260.6M(**占收入 12%**)[1] | 亏损换增长但现金已转正——纪律样板 |
| 大客户(>$100k/年) | 4,009 家(+23%),**贡献 73% 收入** [3] | land-and-expand:免费/自助层养鱼,企业层收网 |
| 美元净留存 DBNR | 119% [3] | 老客户自己长大,增长引擎内置 |
| 现金储备 | $41 亿 [1] | 免费层烧得起的前提 |

## 2. 盈利方式拆解:免费怎么变成 21 亿美元

### 2.1 收费阶梯(自助→企业)
```
Free $0(全功能 CDN+DNS+WAF 基础,数百万站点)
  → Pro ~$20/月(个人/小站)
  → Business ~$200/月(小公司)
  → Enterprise 定制(大客户,均单 >$100k/年,占收入 73% [3])
并行: Workers/R2/Zero Trust 等用量计费产品(开发者平台税)
```
### 2.2 免费层的五个赚钱机理(每一招都能映射到我们)
1. **过境流量=免费的情报网**:免费用户贡献全网威胁视角,反哺付费安全产品——**用户既是被服务者也是传感器**。
2. **免费层逼迫网络扩张**:为服务免费用户建的 330+ 节点,恰是企业客户花钱买的"全球加速"本体——免费与付费**共用一份基础设施**。
3. **结构性定价攻击改写类别经济学**:R2 "零出口流量费" 不是促销,是结构——"AWS 靠数据过境收费,Cloudflare 靠请求过境赚钱;零出口费是让 S3 用户流进自己生态的漏斗" [4]。证书收费时代被免费 SSL 终结同理。
4. **成本价引流品**:域名注册零加价(at-cost)——用一个不赚钱品类把用户引进门 [5]。
5. **信任即广告位**:1.1.1.1 隐私 DNS(24h 删日志、外部审计)+ Project Galileo(免费保护新闻机构/弱势群体)——**门神的中立性是品牌资产**,直接降低企业销售摩擦 [6]。

### 2.3 它的免费层设计军规(对 freemium 的终极启示)
- 免费层必须**比对手付费层更强**(否则不是获客层,是劝退层)
- 栅栏只加在**规模、合规、支持、高级防护**上,基础可用性永不付费
- 每一项免费服务同时是数据回流器/生态入口(见机理 1/3)

## 3. 对照学习清单(核心交付)

| # | Cloudflare(虚拟门神) | AccessX(物理门神) | 学什么 |
|---|---|---|---|
| 1 | 免费 CDN/DNS 比友商付费还强 | 免费 App:扫描器/指南/通行证——对手 App 无锁即空壳 | **免费层当旗舰做**,不是试用装 |
| 2 | R2 零出口费:结构性定价攻击 [4] | "锁控永不订阅,锁永不变砖":对 Ring/Nest 订阅结构的正面攻击 [案例库](monetization-case-studies.md) | 定价宣言要能**改写类别经济学**,而不只是便宜 |
| 3 | at-cost 域名注册(亏本引流品) [5] | 兼容性扫描器/指南=我们的 at-cost 引流品(服务成本≈0,引流价值高) | 选一个"对手当生意、我们当入口"的品类白送 |
| 4 | 过境流量→威胁情报(免费用户是传感器) | 门锁照片→兼容性数据库→SEO 矩阵+推荐引擎 | **每个免费动作都要留下可复用数据资产** |
| 5 | 1.1.1.1 删日志+外部审计;Galileo 公益 [6] | 位置不出手机;绝不替房东监视租客(Latch 案红线) | 门神中立性写成条款+第三方可验证承诺 |
| 6 | 75–77% 毛利上下限自律 [3] | 软件 80%+ / 硬件 ≥50% 红线双侧限 | 给毛利定目标区间,每季对表 |
| 7 | 大客户占收入 73%、DBNR 119%(自助养鱼,企业收网) [3] | C 端自助免费/Pro 养鱼池 → Business per-door 收网;先 iCal/集成占位,做大客户零开发迁移 | land-and-expand 节奏表 |
| 8 | 可用性=命(事故即行业头条) | Lock-out=品牌死刑(评论挖矿已实证 [review-mining](../02-research/review-mining-pain-clusters.md)) | **可靠性预算列入营销预算**:灰度固件、自校准、远程 reboot、SLA 24h |
| 9 | Workers:让别人在门上建设(平台税) | 远期:开放 API/PMS 集成市场(B 端) | V2 再平台化,先窄后宽 |
| 10 | 12% FCF 率:GAAP 亏但现金转正 [1] | 订阅毛利补贴硬件(Pro+Lock),硬件预售 C2M 不压库存 | 现金纪律>会计利润表 |
| 11 | 品类教育:"互联网该有门神" | 品类教育"租房/进门该有更好的门神"(67% 想要 vs 13% 拥有) | 教育市场=教育自己的入口 |
| 12 | 全球扩张跟着流量走(APAC +43%) [3] | 区域顺序跟扫描数据走(哪里扫描多,去哪里卖锁) | **让免费层数据决定硬件落地顺序** |

## 4. 明确不抄的三处

1. **不抄"巨额 GAAP 亏损换增长"**:Cloudflare 有 $4.1B 现金与公开市场融资通道,我们没有;我们的亏损上限必须锁在"订阅毛利可回补"以内。
2. **不抄重资产自建网络**:330+ 节点是它的护城河也是它的成本中心;我们坚持 OEM 轻资产+现金正向。
3. **不抄"入口极宽"**:Cloudflare 服务所有网站,我们只做"门与进出"——门神要专业,不当保安公司什么都干。

## 5. 落地行动(并入既有体系)

- [ ] 把"75% 毛利目标带"改为双侧限写进 [iot-gtm](../01-foundations/iot-gtm-methodology.md) §1(软件 80±5%,硬件 50–55%)
- [ ] 预售页口号对照定价攻击:"No subscription. No egress. No brick."——三段式对齐 R2 话术结构(见 [presale-campaign-copy.md](../90-archive/README.md#item-14))
- [ ] 扫描数据库季度《锁型兼容白皮书》发布——Cloudflare 银河报告式的数据公关(喂 [seo 矩阵](../02-research/seo-aso-keyword-matrix.md))
- [ ] 隐私立场做成"一页人话+可验证条款"(对照 1.1.1.1 审计),进 FAQ 与 B 标书

## 6. 数据来源

1. [Cloudflare FY2025 财报新闻稿](https://www.cloudflare.com/press/press-releases/2026/cloudflare-announces-fourth-quarter-and-fiscal-year-2025-financial-results/)
2. [Cloudflare Q4/FY2025 8-K 附件(PDF)](https://cloudflare.net/files/doc_financials/2025/q4/Q4-25-Exhibit-99-1_FINAL.pdf) · [Yahoo 转发全文](https://finance.yahoo.com/news/cloudflare-announces-fourth-quarter-fiscal-211500209.html)
3. [Motley Fool — NET Q3 2025 电话会(大客户 4,009/73%收入/DBNR 119%/毛利目标带)](https://www.fool.com/earnings/call-transcripts/2025/10/31/cloudflare-net-q3-2025-earnings-call-transcript/)
4. [Architecting on Cloudflare — Ch.13 R2 零出口费的商业结构解读](https://architectingoncloudflare.com/chapter-13/) · [Cloudflare R2 产品页](https://www.cloudflare.com/en-in/developer-platform/products/r2/) · [R2 免费层明细](https://r2drop.com/blog/cloudflare-r2-free-tier-guide)
5. 注: Cloudflare Registrar"成本价注册域名"为官方长期公开声明的引流策略(其定价页常述为 at-cost),本轮未单独取证新闻源,标记为待核条目。
6. 注: 1.1.1.1 隐私承诺(24h 删日志/外部审计)与 Project Galileo 公益保护计划均为官方公开项目页资料,本轮用作品牌信任资产定性引用,同上标记待核。

---

*姊妹篇: [monetization-case-studies.md](monetization-case-studies.md)(软件⇄硬件双流向案例) · [competitor-360-analysis.md](competitor-360-analysis.md)(门锁竞品 360°)*
