# 跨品牌免费 App：接入可行性与商业边界

> **优先级更新：**TTLock作为唯一当前硬件合作谈判候选；Tuya/Nuki及其他生态暂停/待定，保留以下调研，不代表继续实施。见 [TTLock合作提案](../03-design/ttlock-partnership-proposal.md)。

> 状态: active · 2026-09-28 · 桌面核查，不是集成完成证明；未读取或测试 AccessX App。

## 核心结论

任何品牌用户都可以使用不控制硬件的免费工具；**不等于任何品牌、型号、地区、账号都能免费控制设备**。免费给用户 ≠ 平台免收费 ≠ 我们零成本。

| 平台 | 官方依据 | 限制 | 决策 |
|---|---|---|---|
| TTLock | 官方提供蓝牙 SDK；云端 token 文档为账号授权流 [4](https://github.com/ttlock/Android_SDK_Demo) [3](https://euopen.ttlock.com/doc/oauth2) | 蓝牙与云远程不同；取决于型号、固件、网关、管理员权限、账号区域及商业条款。文档存在密码授权，不应把用户密码发进普通表单或日志 | 第一优先技术/商务验证候选；不承诺所有锁、不宣称已批准免费商用 |
| Tuya | 官方 Smart Life App SDK 当前页面：开发版免费，100 注册用户、每月100万云请求，不适合商业发布；商用首年 $5,000、次年 $2,000 [2](https://www.tuya.com/platform/appdev/app-sdk) | 其他官方帮助页仍写20用户试用额度，存在版本差异 [3](https://support.tuya.com/en/help/_detail/Kby68pusjwgsl)。Smart Life、OEM、SDK App 账号/项目不能假定互通；锁功能看 DP/方案；云到云可能是另一报价路线 | $0 阶段只研究，不购买商业 SDK。要求书面确认授权、数据中心、设备迁移/共享、商用报价 |
| Nuki | REST API 要真实设备连接 Nuki Web；Advanced API 用 OAuth2；短租用途要求 Smart Hosting [2](https://docs.nuki.io/guide/overview/) | API 条款要求短租有效合同，不能绕成“个人免费模式”；订阅不是 AccessX 能免除的 [3](https://nuki.io/en-us/legal/nukis-terms-of-use-apis) | 个人与短租分开评估；本地路线也需核对设备及条款，不能许诺无成本 |

Tuya 官方也明确不同锁支持不同接口，视频转发等另有付费服务。[5](https://developer.tuya.com/en/docs/cloud/doorlock-api-refer?id=Kbe2mbiqn5mik)

## 上线前每个型号的验收卡

记录品牌/型号/固件/地区/授权途径/合同版本/每活跃设备成本/网关需求/并发限额/测试日期。逐项验证：

1. 用户自愿授权、最小权限、撤销授权和删除数据；不借用他人 developer key。
2. 不要求危险重置正在使用的门锁；迁移/恢复原厂 App 路径明确。
3. 本地开锁、远程开锁、PIN创建、PIN撤销、状态读取、日志读取分别标为 supported / unsupported / untested。
4. 断网、过期 token、低电、DST、重复 webhook、设备无回执、第三方故障时表现明确。
5. 命令已发送不等于门已打开；门磁只证明门开/关，不证明锁舌上锁。
6. 任何无法确认的物理状态显示“未知/最后确认时间”，不能显示虚假成功。
7. 不绕过厂商权限、不抓取账号、不把房东管理员权限授予租客；租客隐私与进入住所的授权独立处理。
8. 不把离线 PIN 说成可即时远程撤销：以设备能力与确认回执为准。

## 给厂商的英文询问信（未发送）

Subject: Commercial integration and end-user authorization inquiry

We are evaluating an independent access-management app. Could you confirm the supported commercial integration route, licensing and recurring fees, eligible device models and regions, end-user authorization and revocation flow, account/OEM restrictions, rate limits, gateway requirements, and support policy? We need to distinguish personal residential use from short-term rental and property-management use. We will not advertise compatibility before authorization and device-level testing.

## 适合对外的文案（功能上线后才可使用）

“Free home and guest-planning tools. Device control is available only for supported models after authorization. A compatible gateway or a third-party subscription may be required.”

中文：基础家居与访客规划工具免费。设备控制需兼容型号及授权，可能需要网关或第三方订阅。

当前阶段用：“Join our free pilot waitlist. Tell us your lock model so we can evaluate support.” 不说“Works with every TTLock, Tuya and Nuki lock”。

## 免费层成本闸门（内部建议）

- 无设备工具优先规则/本地计算，不默认每次调用付费视觉 AI。
- 集成固定费分摊、云调用、通知、存储、客服均进软件线成本，不能全扔到硬件部门。
- 若每免费活跃户每月全变量成本 $0.10，10,000 户就是 $1,000/月；这只是算例，不是已取得报价。
- 在免费配额用完前停止新增高成本功能；明确公平使用政策，不给“无限云端、无限视频、永久 API”承诺。
- 更多平台机会：Matter / Home Assistant / Yale / Schlage / igloohome / SwitchBot / Aqara / Seam 等列入下一轮候选，**尚未核验、尚未集成**；标准协议存在也不等于全型号功能一致。
