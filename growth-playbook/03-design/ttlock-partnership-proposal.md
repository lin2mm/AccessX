# TTLock合作提案：租住运营增值与专业交付试点

> 2026-09-28 更新：硬件主路线已改为中国供货、多国分散买家、预付款＋出货前付清，不以账期大客户为主。[新版预付出口与软件渠道计划](../05-system/prepaid-export-channel-plan.md)优先于本文冲突内容；旧现金表仅作历史比较。竞品实际财务、RemoteLock 已接入 TTLock 和工程自诊断边界见新版关联文档。

> **本轮增补优先：**见 [免改造锁合作利弊与交付物](ttlock-retrofit-partnership-addendum.md)。3万台是条件式目标，不是可向TTLock宣称的已有订单；当前能交付研究和试点方案，产品/渠道能力待建设。

> 状态: draft / 待对方讨论 · 2026-09-28 · 未联系、未授权、未签约。AccessX为工作名。
> 仅TTLock作为当前设备合作候选；Tuya、Nuki和其他硬件生态暂停。合作可降低门槛，但不得预设免费或已获批准。

## 1. TTLock 360°已知与未知

**业务底座**：官网说明提供锁的硬件与软件解决方案、App/Web/Windows以及酒店/公寓垂直方案；Sciener官网还有TTHotel Pro、宿舍、社区/园区相关产品。[3](https://ttlock.com/) [1](https://www.sciener.com/)

**开发生态**：官方GitHub SDK支持手机与锁通过蓝牙通信，不等于所有型号和云端权限都相同。[4](https://github.com/ttlock/Android_SDK_Demo)

**垂直功能重叠**：TTLock产品页面介绍房态、发卡、员工角色、租客和账单管理等。[3](https://ttlock.app/work-with/) 具体平台/区域/商务提供主体仍需TTLock确认，不能拿经销商页面代替合同。

**未知，不能补造**：集团营收/净利润/ROE、各国活跃锁数、B2B付费数、API利润/价格、客户流失、OEM集中度、海外支持成本、安全事件频率、现有渠道独家义务。软件评分只代表某平台样本，不代表整体产品质量。

### 战略层面“急缺什么”不能靠外部猜定

以下是**待访谈验证的合作假设**，不是TTLock已确认短板：

| 假设 | 我们可能补足 | 对方为什么可能愿意 | 如何证伪 |
|---|---|---|---|
| 想增加海外有效设备激活 | Scanner+免费租住工具筛选兼容升级需求 | 有质量的OEM/锁销售线索 | 对方无需新线索或不允许转介 |
| 想减少重复支持/安装误用 | 型号化指引、授权自检、诊断包、工单分流 | 降低双方每门支持成本 | 支持成本主要是硬件，流程帮助有限 |
| 想让存量小房东升级运营 | 入住异常/维护/交接，不复制基础发码 | 设备价值和留存提高，可能共同分成 | 其现有产品覆盖充分、用户不愿额外付费 |
| 想建立专业安装交付 | 安装商工具、验收、员工培训和回归测试 | OEM降低安装返工与退货 | 无法要求OEM执行标准 |
| 想连接更多当地PMS/伙伴 | 一个市场一个工作流的本地化 | 获得新分销入口 | 平台已有伙伴更优或合同禁止 |

**合作姿态：不说“你们不会做软件，我们替代你们”。**承认TTLock已有垂直系统，证明我们的增量细分市场、客户获取和服务能力；没有证据就先不谈独家。

## 2. 提议的互补分工

| 方 | 责任 | 盈利路径（提议） |
|---|---|---|
| TTLock | 平台/SDK、型号能力、接口与固件协作、L3故障支持 | 设备/模块生态增量；商定平台费或净收入分成 |
| AccessX | 免费租住协作、Scanner、运营自动化、PMS连接、L1/L2分流 | 软件订阅；经批准硬件净贡献；实施费独立 |
| OEM/品牌 | 整锁机械/电子质量、证书、供货、质保 | 整锁与配件收入，不默认TTLock就是整锁生产商 |
| 安装/渠道伙伴 | 现场适配、安装、维护、交付培训 | 安装与维保、透明推荐佣金 |

支持第三方TTLock OEM和自有未来硬件，避免“收编用户只卖自家锁”引发渠道冲突。共同推广不共享原始门码、精确出入轨迹用于营销；匿名统计也需合法依据和最小化。

## 3. 商业条款谈判顺序

先要一个**有上限、可退出的验证协议**，不是大订单：

1. 正式确认商业使用许可、开发主体、品牌名称/商标使用、区域、API权限、账号/OEM归属和授权撤销。
2. 请求90天开发/试点配额或优惠与样机借测（是请求，不是假定免费）；如需付费先回到预算审批，不能刷卡继续。
3. 非独家，试点无销量/采购保底；扩张后再谈按量阶梯和最低承诺。
4. 报价要列固定授权费、每活跃门/月费、调用/并发费、网关/私有化费、支持费、税费。
5. 数据驻留、子处理者、日志保留、删除/导出、事件通知、密钥管理、安全漏洞报告与故障责任。
6. 版本兼容/废弃提前通知（建议至少90天，可谈）、停服迁移、账号解绑；不承诺我们有权绕过停服或复制专有协议。
7. 售后：客户单一工单入口、紧急事件分派、各方响应时段，故障状态公开；SLA需资源与合同支持。
8. 非独家项目登记、共同线索归属、佣金结算、退款追回、终止后服务和品牌移除。

### 三种可谈收费模式（互斥或明确组合）

A. 固定可控的每活跃设备费：有预测性，但免费设备也可能产生成本。
B. 软件实际净收入分成：早期现金友好；“净收入”先定义退款、税、支付费，不能双方各自解释。
C. OEM/渠道采购配套：由品牌购买增值服务给最终客户；避免把服务成本藏在一次硬件销售后无限承担。

不建议初期无上限按API调用收费。必要时调用预算警告/超额授权，但不能因为超额自动剥夺住户合法入门权。

### 双方经济算例（非报价）

一个5房源Ops账户付$19/月：其他交付变量成本$3；若平台费$0.5/门则$2.5；渠道净收入分成按示例10%=$1.9；获客前贡献$11.6（61.1%），未计固定研发。
若平台费$2/门，贡献降到$4.1（21.6%），不适合按原价扩张。应提高实际价值与售价、重谈费率或停止，不能用未来硬件利润掩盖。未填预算前不许诺免费集成规模。

## 4. “更专业、更高档”联合工作包

1. **能力矩阵**：指定型号/固件/地区/网关，逐项锁态、门态、PIN创建/撤销/离线行为，unsupported明确展示。
2. **状态契约**：命令创建、平台接受、设备确认、物理状态是不同事件；不把超时写成成功；门磁不代表锁舌。
3. **安全**：多租户隔离、最小权限、密钥轮换、审计、授权退出；第三方凭据不进普通表单/分析系统。
4. **故障试验**：网络断开、网关离线、低电、DST、token失效、重复事件、改期/取消、人员撤权、型号变更。
5. **硬件专业化**：OEM提供机械耐久、环境、电池、安装和适用证书；认证按型号与地区验证，不替整个生态背书。
6. **服务专业化**：安装验收、故障诊断包、备件/RMA分工、升级窗口、支持终止规则。需要外部安全评审，不以内部测试替代。
7. **用户权益**：长租欠费不自动撤权、住户可用备用方式；消防/逃生与紧急访问遵守所在地要求，不由运营自动化擅自决定。

## 5. 90天有条件试点

起算条件：书面许可、费用边界、授权设备/测试环境、安全责任人、单一地区。

| 阶段 | 范围 | 输出/闸门 |
|---|---|---|
| D1–15 | 双方产品与接口评估，不控真实住户门 | 2个候选型号能力表、报价、数据流、退出机制；不通过就停连接器 |
| D16–30 | 获授权的测试台；样机借测或预算批准采购 | 模拟改期/离线/撤权/权限隔离；所有严重安全问题关闭 |
| D31–60 | 建议5–10家运营者、20–50门受监督试点 | 先人工确认再受控自动化，100%记录尝试/失败/回执；不宣称大规模可靠性 |
| D61–90 | 同一批扩大任务覆盖，不急扩新型号 | 对照人工时间、救场次数、支持成本、重复使用与付费意愿 |

商业目标建议：中位操作时间降低30%、至少5个愿付费账户、模型贡献毛利≥60%。这是待验证阈值，不是销售承诺。自动化权限越界、未知物理状态被显示成功等严重缺陷一票否决。关键场景需100%规定用例通过，但100%用例通过也不代表现实永不失败。

## 6. 待发送英文商务邮件

Subject: Proposal: a scoped rental-operations pilot with TTLock

Hello TTLock Partnership Team,

We are planning an independent rental-operations product, currently using AccessX as a working name. The free tools would help residents and operators coordinate handovers, arrival instructions and maintenance before purchasing any smart lock. We would like to explore adding supported TTLock devices to those workflows.

We recognize that TTLock already offers hotel and rental solutions. Our proposed pilot would focus on complementary customer acquisition, localized operational workflows and installation/support quality, not on replacing your platform.

Could we discuss commercial authorization, supported models and regions, end-user consent, OEM account boundaries, predictable integration costs, security responsibilities and a non-exclusive, time-limited pilot? We propose starting with two models and a small supervised operator cohort, subject to agreement and safety review.

We have not advertised an approved integration. We would welcome an initial product and partnership discussion before committing resources or making compatibility claims.

Best regards,
The project team

中文谈判底线：不承诺现成用户规模、不展示假合作Logo、不以未发生营收换独家、不隐瞒自有硬件路线。本文件仅供讨论，邮件尚未发送。
