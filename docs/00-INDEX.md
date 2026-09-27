# 文档索引与命名规则 / Docs index and naming scheme

## 1. 文档编号规则

所有文档放在 `docs/`，文件名 = **两位编号 + 大写主题 + `.md`**，例如
`30-SECURITY-TESTING.md`。十位数表示类别：

| 编号段 | 类别 | 放什么 |
|---|---|---|
| `00–09` | 总览 | 本索引、架构 |
| `10–19` | 部署与运维 | 试点、安装、上线清单、备份恢复 |
| `20–29` | 功能设计 | 单个功能的设计说明（为什么这样做、边界） |
| `30–39` | 安全 | 测试范围、威胁模型、漏洞记录 |
| `40–49` | 商业 | 计费、定价、条款 |
| `90–99` | 项目管理 | 轮次记录、路线图 |
| `rounds/` | 每轮报告 | `RNN-YYYY-MM-DD-主题.md`，例如 `R13-2026-09-27-billing-ops-scope-gate.md` |

规则：

1. **编号不复用。** 新文档取该段中下一个空号（例如下一个运维文档是 `13-…`）。
2. **不删除，只标记。** 过时的文档保留编号，第一行写 `Status: superseded by NN-…`。
3. **轮次号 `RNN` 贯穿三处：** 提交信息以 `RNN:` 开头（从 R13 起），
   `docs/90-ROUNDS.md` 有一行，`docs/rounds/RNN-…md` 是该轮的完整报告。
   用 `git log --grep '^R13:'` 可以找到某一轮的全部提交。
4. **代码里已有的命名继续沿用：** `migrations/NNNN_名称.sql`（四位序号，永不改动已发布的文件），
   `*-core.js` = 两个运行时共用的纯逻辑，`test/*.test.js` = 测试，
   `support/` = 测试与本地工具（不会被当成测试运行），`scripts/` = 运维命令（`npm run …`）。

## 2. 文档列表

| 文件 | 内容 | 读者 |
|---|---|---|
| [00-INDEX.md](00-INDEX.md) | 本页：索引与命名规则 | 所有人 |
| [01-ARCHITECTURE.md](01-ARCHITECTURE.md) | 架构：共享 API 核心、多租户、数据、审计链、限制 | 开发 |
| [10-PILOT.md](10-PILOT.md) | 用真实锁试点的步骤与检查 | 实施 |
| [11-OFFICE-SETUP.md](11-OFFICE-SETUP.md) | 办公室 45 分钟安装指南 | 实施、客户 |
| [12-GO-LIVE.md](12-GO-LIVE.md) | 上线清单、`npm run doctor`、健康检查与监控、日志、备份与恢复演练 | 部署与运维 |
| [20-PREREGISTRATION.md](20-PREREGISTRATION.md) | 访客预登记设计 | 产品、开发 |
| [21-SIGNUP.md](21-SIGNUP.md) | 自助开通（注册 → 邮件确认 → 新租户 + 所有者）、防滥用规则、演示租户一键重置 | 产品、开发、平台运维 |
| [22-KIOSK.md](22-KIOSK.md) | 前台平板：访客自助签到 / 临时访客 / 签退、手机二维码、到访须知、打印名单；注册页 Turnstile 人机验证 | 前台、产品、开发 |
| [23-CALENDAR.md](23-CALENDAR.md) | 日历邀请 → 访客预登记：Cloudflare Email Routing 设置、组织者确认、改期/取消、安全模型 | 管理员、前台、开发 |
| [24-ACCESS-REVIEW.md](24-ACCESS-REVIEW.md) | 访问复核（经理季度确认、一键移除、到期处理）、锁上密码对账、数据保留一览、批量访客邀请 | 管理员、审计、开发 |
| [25-NUKI.md](25-NUKI.md) | 第二家锁厂 Nuki：用 API 令牌连接、与 TTLock 的对应关系、Nuki 做不到的事（界面上也会显示）、第一家真实 Nuki 站点前的检查 | 管理员、实施、开发 |
| [26-I18N.md](26-I18N.md) | 中英文界面：怎么切换语言、翻译层的原理、术语对照表、怎么加新文字（测试和覆盖率工具）、限制 | 产品、开发、翻译 |
| [30-SECURITY-TESTING.md](30-SECURITY-TESTING.md) | 自动化安全门、外部渗透测试范围、限流 | 安全、测试方 |
| [40-BILLING.md](40-BILLING.md) | Stripe 计费：计划、实现、运维 | 商业、开发 |
| [90-ROUNDS.md](90-ROUNDS.md) | 每轮做了什么（总表） | 所有人 |
| [91-ROADMAP.md](91-ROADMAP.md) | 后续路线图：轮次、用时、结束时间、结论 | 所有人 |
| [rounds/](rounds/) | 每轮报告（从 R13 起） | 所有人 |

## 3. 旧文件名对照（R13 改名）

| 旧 | 新 |
|---|---|
| `docs/ARCHITECTURE.md` | `docs/01-ARCHITECTURE.md` |
| `docs/PILOT.md` | `docs/10-PILOT.md` |
| `docs/OFFICE-SETUP.md` | `docs/11-OFFICE-SETUP.md` |
| `docs/PREREGISTRATION.md` | `docs/20-PREREGISTRATION.md` |
| `docs/SECURITY-TESTING.md` | `docs/30-SECURITY-TESTING.md` |
| `docs/BILLING.md` | `docs/40-BILLING.md` |

已发布的迁移文件（`migrations/0003`、`0018`、`0020`）注释里仍是旧文件名：
迁移文件发布后不再修改。
