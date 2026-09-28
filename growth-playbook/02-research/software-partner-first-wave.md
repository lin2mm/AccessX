纯自传播 12 个月 100 万无可靠先例

# 软件伙伴第一轮筛选：先复用已有 TTLock 路径，再验证硬件增量

2026-09-28｜公开资料案头研究。没有联系任何公司，没有确认采购意愿/预付款意愿/无安装团队，没有账户登录或实际接入。以下优先级是**研究顺序**，不是合作成功概率。不能将这些公司全部计入30,000台销售漏斗。

关联：[总体伙伴计划](../03-design/software-partner-hardware-program.md)、[访谈与试点包](../05-system/software-partner-validation-kit.md)。

## 1. 本轮改变判断的证据

1. **已有TTLock入口的软件平台不少。**Beds24、Hostaway、Uplisting、Chekin均有官方资料支持，首选问题应是“我们的具体SKU是否符合现有路径”，不是要求它们重新开发开锁功能。各平台路径、支持型号及收费不同，不能等同即插即用。[1](https://wiki.beds24.com/index.php?title=TTLock) [2](https://support.hostaway.com/hc/en-us/articles/18631403820571-Hostaway-Smart-Locks-FAQs) [3](https://www.uplisting.io/integrations/ttlock) [4](https://chekin.com/en/faq/)
2. **运营异常也不是无人做。**Breezeway已公布任务时间窗授权、低电量/离线触发任务，2026年3月还增加代码生成失败通知。我们的差异不能仅是“有任务、有告警”。[5](https://help.breezeway.io/en/articles/12732899-release-notes-november-2025) [6](https://help.breezeway.io/en/articles/14021697-release-notes-march-2026)
3. **同一TTLock生态不代表同一能力。**Beds24文档区分在线与离线密码，描述定期同步约12小时、可手动Export；离线密码在该集成路径下不能更新/删除。Hostaway帮助页要求0–9完整键盘，其TTLock路径需要网关。必须按平台×SKU×固件×网关×密码模式验证。[1](https://wiki.beds24.com/index.php?title=TTLock) [2](https://support.hostaway.com/hc/en-us/articles/18631403820571-Hostaway-Smart-Locks-FAQs)

公开文档可能更新或滞后；这些是需复核的文档行为，不是实测故障，也不应外推成所有TTLock产品的永久限制。

## 2. 十家候选：已有方案、切入点、反证

### A组：优先做SKU/商业模式验证（不必然是采购商）

| 候选 | 可核实的既有能力 | 我们应提出的假设 | 首要未知与停止条件 |
|---|---|---|---|
| Beds24 | 官方TTLock设置、在线/离线PIN、房间映射与自动消息[1](https://wiki.beds24.com/index.php?title=TTLock) | 不改PMS，供应经过验证的低改造SKU与安装包 | 是否有硬件推荐入口；同步/撤权能否满足场景；若需平台新特性才能安全工作则不作为首发路径 |
| Uplisting | TTLock集成页及Smart Locks帮助页，已有预订码和同步告警[3](https://www.uplisting.io/integrations/ttlock)[7](https://support.uplisting.io/docs/automate-guest-access-with-smartlocks) | 客户使用已有Smart Locks，减少硬件采购/设置门槛 | 支持的具体SKU/网关、供应商上架政策、附加费；若其现有硬件已解决全部问题则不做定制 |
| Hostaway | TTLock市场页；帮助页限定网关与完整数字键盘[2](https://support.hostaway.com/hc/en-us/articles/18631403820571-Hostaway-Smart-Locks-FAQs)[8](https://www.hostaway.com/marketplace/ttlock/) | 作为现有路径下的新增硬件选择，而非另售连接器 | 型号允许清单、测试流程、账户/费用与支持分工；未知SKU不能直接宣称兼容 |
| Chekin | 官方FAQ列TTLock；官方目录有伙伴入口[4](https://chekin.com/en/faq/)[9](https://chekin.com/en/integrations/) | 已有登记/入住流程下推荐合格硬件 | FAQ部分“即将上线”信息可能陈旧；须核实当前路由/供应商政策，不能把网上目录当已获授权 |

**建议先做Beds24与Uplisting两条桌面能力表，再以Hostaway验证网关/键盘成本是否改变报价。**这是文档清晰度与复用路径驱动，不是认为它们更愿意预付买锁。

### B组：已有成熟方案，以替换成本/联合供货验证为主

| 候选 | 已有证据 | 建议方式 | 为什么不是第一波重集成 |
|---|---|---|---|
| Smoobu | 官方支持Nuki，已有多个门锁合作[10](https://support.smoobu.com/hc/en-us/articles/360016950740-Partner-Nuki-Smart-lock-solution)[11](https://support.smoobu.com/hc/en-us/articles/4412545420562-Smart-locks-and-Smoobu-an-Introduction) | 仅在现有TTLock/RemoteLock路径核实后谈补充SKU/推荐 | 已有retrofit选择，“不用打孔”本身不独特 |
| Lodgify | Smart Locks和Nuki合作已在2025公告[12](https://www.lodgify.com/blog/product-updates-february-2025/) | 验证具体门型或总交付成本缺口 | 不重新造其门锁管理台；该公告优惠已过期，不用作报价 |
| OwnerRez | RemoteLock集成；明示功能取决于软件、接口与硬件三层[13](https://www.ownerrez.com/support/articles/integration-remotelock-door-locks)[14](https://www.ownerrez.com/support/articles/door-locks-technical-functional-differences) | 经RemoteLock路径验证SKU，提供硬件/安装资料 | 是间接路径，额外订阅与认证成本必须加入 |
| Breezeway | 已有任务授权、设备健康与失败通知[5](https://help.breezeway.io/en/articles/12732899-release-notes-november-2025)[6](https://help.breezeway.io/en/articles/14021697-release-notes-march-2026) | 只有可证明的机械诊断/安装数据增量才深入 | 与拟议运营功能重叠明显；TTLock具体支持本轮未核实，不自动纳入执行 |

### C组：只验证需求，暂不分配工程预算

| 候选 | 当前公开证据 | 不能得出的结论 | 下一问 |
|---|---|---|---|
| RentRedi | 官方文章讨论房东智能设备[15](https://rentredi.com/blog/smart-home-devices-for-landlords/) | 文章不证明它有TTLock集成，也不证明它没有，更不证明愿意转售 | 是否存在获授权的硬件推荐/合作路径？维修授权与租客许可痛点有多大？ |
| Nexudus | 有Custom ACS接口与多种门禁集成[16](https://developers.nexudus.com/reference/connect-your-own-access-control-system)[17](https://nexudus.com/blog/coworking-access-control/) | 开放接口不等于接受未知硬件；公共门禁不能随意retrofit | 是否存在普通室内门的低风险子场景？若需要公共出口工程则暂停 |

RemoteLock作为上游合作路线单列在既有竞品/伙伴文件，不在此重复算第11个独立终端渠道。经其触达OwnerRez等平台的终端不可重复计数。以上均未证明“没有安装团队”，这是访谈问题而非标签。

## 3. 四类终端仍然分开

- **家庭：**基础通行与交接免费；本轮没有证据支持按门订阅转化，不拿PMS名单代表家庭分发。
- **租客/合租：**先验证房东许可、搬出恢复、设备归属；RentRedi只作长租需求访谈候选，租客不必然是付款人。
- **短租运营：**本轮证据最强、已有接入最多，但竞争也最强；首选做硬件交付增量，而非再卖发码功能。
- **长租物业/多点经营：**评估TTRenting、既有物业软件和公共门禁边界；不以短租预订逻辑替代租住权与员工授权。

TTLock官网明确列出TTRenting、TTHotel Pro、TTDorm、TTology与Aptring等方案。我们不能称长租、酒店、学校、园区皆为空白；真实差异需要版本/地区/场景逐项对照。[18](https://ttlock.com/)

## 4. 本轮不再扩充800家名单

十家中已有方案高度重叠。先确认“是否有真实未解决的适配/交付问题”，比批量收集名字更有价值。进入量化评分前必须得到：适配门数、决策人、进口/收款角色、渠道入口、支持责任、价格接受范围。缺值记unknown，不补0或虚构分数。

建议工作队列：
1. 我方填写SKU资料表；不知道的项保持空白，不能从仓库代码猜。
2. 准备Beds24/Uplisting/Hostaway的平台能力核验表；Chekin为替补。
3. TTLock确认接口与许可范围，特别是遥测、权限撤销和SKU适配。
4. 获准外联后再做20次分组访谈；每组5次，只是探索，不代表市场统计。
5. 只有同时通过商业、安全和机械门型关卡，才进入2–3家试点；合同与付费各自另批。

## 5. 来源索引

访问日期均为2026-09-28；部分为官方搜索摘录，关键约束已读取帮助页正文。未付费、未登录。

- [1](https://wiki.beds24.com/index.php?title=TTLock) Beds24 TTLock帮助正文。
- [2](https://support.hostaway.com/hc/en-us/articles/18631403820571-Hostaway-Smart-Locks-FAQs) Hostaway Smart Locks FAQ；网关条目来自官方搜索摘录，其余关键项核对正文。
- [3](https://www.uplisting.io/integrations/ttlock) Uplisting TTLock页。
- [4](https://chekin.com/en/faq/) Chekin FAQ。
- [5](https://help.breezeway.io/en/articles/12732899-release-notes-november-2025) Breezeway 2025-11更新正文。
- [6](https://help.breezeway.io/en/articles/14021697-release-notes-march-2026) Breezeway 2026-03更新。
- [7](https://support.uplisting.io/docs/automate-guest-access-with-smartlocks) Uplisting Smart Locks帮助。
- [8](https://www.hostaway.com/marketplace/ttlock/) Hostaway TTLock目录。
- [9](https://chekin.com/en/integrations/) Chekin集成目录，自动解析有重复条目，不据此计算集成数量。
- [10](https://support.smoobu.com/hc/en-us/articles/360016950740-Partner-Nuki-Smart-lock-solution) Smoobu/Nuki设置。
- [11](https://support.smoobu.com/hc/en-us/articles/4412545420562-Smart-locks-and-Smoobu-an-Introduction) Smoobu锁集成说明。
- [12](https://www.lodgify.com/blog/product-updates-february-2025/) Lodgify产品更新。
- [13](https://www.ownerrez.com/support/articles/integration-remotelock-door-locks) OwnerRez RemoteLock帮助。
- [14](https://www.ownerrez.com/support/articles/door-locks-technical-functional-differences) OwnerRez能力边界表。
- [15](https://rentredi.com/blog/smart-home-devices-for-landlords/) RentRedi智能设备文章，仅视为内容信号，不采纳其中绝不锁在门外等营销保证。
- [16](https://developers.nexudus.com/reference/connect-your-own-access-control-system) Nexudus自定义ACS。
- [17](https://nexudus.com/blog/coworking-access-control/) Nexudus既有门禁方案。
- [18](https://ttlock.com/) TTLock官方产品与行业方案正文。
