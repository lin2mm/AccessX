# AccessX Repository Index Tree

**Branch**: `arena/01a0de29-accessx`  
**Generated**: 2026-10-03  
**Total Files**: 200+  
**Main Languages**: JavaScript (79.1%), HTML (20.9%)

---

## Directory Structure

```
AccessX/
├── 📋 配置和元数据
│   ├── .github/workflows/ci.yml          # GitHub Actions CI/CD 流程
│   ├── .gitignore
│   ├── package.json
│   ├── package-lock.json
│   ├── wrangler.jsonc                    # Cloudflare Workers 配置
│   ├── README.md
│   └── CHANGELOG.md                      # 更新日志
│
├── 🔐 核心业务模块 (共45+ 个 JS 文件)
│   ├── 认证和授权
│   │   ├── auth-core.js                  # 认证核心
│   │   ├── auth.test.js
│   │   ├── oidc-core.js                  # OpenID Connect
│   │   └── rbac-core.js                  # 基于角色的访问控制
│   │       └── rbac-core.test.js
│   │
│   ├── 访问控制 (ACL)
│   │   ├── acl.js                        # 访问控制列表
│   │   ├── policy-core.js                # 权限策略引擎
│   │   └── policy-core.test.js
│   │
│   ├── 审计和日志
│   │   ├── audit-core.js                 # 审计日志核心
│   │   ├── audit-core.test.js
│   │   ├── audit-ops.js                  # 审计操作
│   │   ├── audit-anchor-core.js          # 审计锚点（不可篡改日志）
│   │   └── reports-core.js               # 报表生成
│   │
│   ├── 访问点/门禁管理
│   │   ├── kiosk-core.js                 # 自助终端/访客机
│   │   ├── visitors-core.js              # 访客管理
│   │   ├── lock-events-core.js           # 门锁事件
│   │   ├── lock-health-core.js           # 门锁健康状态
│   │   └── lock-alarms.test.js
│   │
│   ├── 日程和预订
│   │   ├── calendar-core.js              # 日历/预订
│   │   └── calendar.test.js
│   │
│   ├── 邀请和访客
│   │   ├── onboarding-core.js            # 入职流程
│   │   └── invites.test.js
│   │
│   ├── 数据同步和镜像
│   │   ├── mirror.js                     # 数据镜像
│   │   ├── reconcile-core.js             # 数据对账
│   │   └── reconcile.test.js
│   │
│   ├── 编译和编码
│   │   ├── compiler-core.js              # 编译器 (ACL 编译)
│   │   ├── compiler-core.test.js
│   │   ├── validate-core.js              # 验证器
│   │   └── validate-core.test.js
│   │
│   ├── 凭证和机密
│   │   ├── credentials-core.js           # 凭证管理
│   │   ├── credentials-core.test.js
│   │   ├── secrets-core.js               # 机密管理
│   │   ├── secrets-rotation.js           # 机密轮转
│   │   └── secrets-rotation.api.test.js
│   │
│   ├── 账单和订阅
│   │   ├── billing-core.js               # 计费核心
│   │   └── billing.test.js
│   │
│   ├── 注册和登录
│   │   ├── signup-core.js                # 注册流程
│   │   └── signup.test.js
│   │
│   ├── 告警和通知
│   │   ├── alerts-core.js                # 告警
│   │   ├── alerts.api.test.js
│   │   └── rate-limit-core.js            # 速率限制
│   │
│   ├── 高级功能
│   │   ├── review-core.js                # 访问审查
│   │   ├── scim-core.js                  # SCIM (身份供应)
│   │   ├── dns-core.js                   # DNS 管理
│   │   ├── dns-core.test.js
│   │   ├── api-core.js                   # API 核心
│   │   ├── backup-export-core.js         # 备份导出
│   │   ├── doctor-core.js                # 诊断工具
│   │   ├── sms-core.js                   # 短信
│   │   └── security-txt.js               # Security.txt
│   │
│   └── 租户和队列
│       ├── tenant-queue.js               # 租户队列
│       ├── vendor-accounts.js            # 供应商账户
│       ├── vendor-demo.js
│       ├── vendor-nuki-core.js
│       ├── vendor-ttlock.js
│       └── vendor-ttlock-core.js
│
├── 🌐 硬件驱动 (drivers/)
│   ├── index.js                          # 驱动加载器
│   ├── base.js                           # 驱动基类
│   ├── demo.driver.js                    # 演示驱动
│   ├── ttlock.driver.js                  # TTLock 智能锁驱动
│   ├── ttlock.js                         # TTLock 集成
│   └── nuki.js                           # Nuki 门锁集成
│
├── 💾 数据层 (store/ + data/)
│   ├── store/
│   │   ├── sql.js                        # SQL 查询生成器
│   │   ├── sqlite-node.js                # SQLite 驱动
│   │   ├── repo.js                       # 数据仓库/ORM
│   │   ├── bootstrap.js                  # 初始化
│   │   ├── snapshot-cache.js             # 快照缓存
│   │   ├── shared-wait.js                # 共享等待机制
│   │   └── store.test.js
│   │
│   ├── data/
│   │   ├── acl.json                      # ACL 配置数据
│   │   └── mirror.json                   # 镜像数据
│   │
│   └── 数据库迁移脚本 (migrations/ - 共25个SQL文件)
│       ├── 0001_app_state.sql
│       ├── 0002_audit_log.sql
│       ├── 0003_multitenant.sql
│       ├── 0004_identity.sql
│       ├── 0005_vendor_accounts.sql
│       ├── 0006_audit_anchors_retention.sql
│       ├── 0007_break_glass.sql          # 应急访问
│       ├── 0008_approvals.sql            # 批准流程
│       ├── 0009_approval_code.sql
│       ├── 0010_alert_outbox.sql
│       ├── 0011_snapshot_versions.sql
│       ├── 0012_visits.sql               # 访问记录
│       ├── 0013_visit_arrivals.sql
│       ├── 0014_visitor_phone.sql
│       ├── 0015_lock_alarms.sql
│       ├── 0016_visit_checkout.sql
│       ├── 0017_usage_counters.sql
│       ├── 0018_visit_invites.sql
│       ├── 0019_lock_health.sql
│       ├── 0020_billing.sql
│       ├── 0021_billing_ops.sql
│       ├── 0022_signups.sql
│       ├── 0023_kiosk.sql
│       ├── 0024_calendar.sql
│       └── 0025_access_review.sql
│
├── 🎨 前端 (public/ - 完整 PWA 应用)
│   ├── index.html                        # 主应用
│   ├── app.js                            # 主应用逻辑
│   ├── 子页面
│   │   ├── calendar.html / calendar.js   # 日历模块
│   │   ├── kiosk.html / kiosk.js         # 访客自助机
│   │   ├── signup.html / signup.js       # 注册页面
│   │   ├── invite.html / invite.js       # 邀请页面
│   │   ├── checkout.html / checkout.js   # 结账 (访客)
│   │   ├── evidence.html / evidence.js   # 证据/日志查看
│   │   ├── visitors-print.html / visitors-print.js  # 访客打印
│   │   └── review.js                     # 审查模块
│   ├── 国际化
│   │   ├── i18n.js                       # 英文
│   │   └── i18n-zh.js                    # 中文
│   ├── 工具库
│   │   ├── qr.js                         # 二维码
│   │   ├── sw.js                         # Service Worker
│   │   ├── manifest.json                 # PWA 清单
│   │   ├── icon.svg                      # 应用图标
│   │   └── _headers                      # HTTP 响应头配置
│
├── 🔧 脚本和工具 (scripts/)
│   ├── doctor.js                         # 系统诊断
│   ├── audit-keygen.js                   # 审计密钥生成
│   ├── backup.js                         # 备份脚本
│   ├── cf-deploy.js                      # Cloudflare 部署
│   ├── new-operator.js                   # 创建操作员
│   ├── ttlock-check.js                   # TTLock 检查
│   ├── nuki-check.js                     # Nuki 检查
│   └── verify-audit-export.js            # 审计导出验证
│
├── 🧪 测试套件 (test/ - 共50+ 个测试文件)
│   ├── API 测试
│   │   ├── audit.api.test.js
│   │   ├── rbac.api.test.js
│   │   ├── scim.api.test.js
│   │   ├── alerts.api.test.js
│   │   ├── approvals.api.test.js
│   │   └── ... (20+ 个 API 测试)
│   ├── 单元测试
│   │   ├── billing.test.js
│   │   ├── calendar.test.js
│   │   ├── nuki.test.js
│   │   ├── ttlock.test.js
│   │   └── ... (30+ 个单元测试)
│   └── 模糊和安全测试
│       ├── isolation.fuzz.test.js
│       ├── scope.fuzz.test.js
│       └── ssrf.test.js
│
├── 📚 文档 (docs/)
│   ├── 00-INDEX.md                       # 文档索引
│   ├── 01-ARCHITECTURE.md                # 架构文档
│   ├── 部署指南
│   │   ├── 10-PILOT.md
│   │   ├── 11-OFFICE-SETUP.md
│   │   ├── 12-GO-LIVE.md
│   │   └── 13-CLOUDFLARE-GIT-DEPLOY.md
│   ├── 功能文档
│   │   ├── 20-PREREGISTRATION.md
│   │   ├── 21-SIGNUP.md
│   │   ├── 22-KIOSK.md
│   │   ├── 23-CALENDAR.md
│   │   ├── 24-ACCESS-REVIEW.md
│   │   ├── 25-NUKI.md
│   │   ├── 26-I18N.md
│   │   ├── 40-BILLING.md
│   │   └── 30-SECURITY-TESTING.md
│   ├── 规划文档
│   │   ├── 90-ROUNDS.md
│   │   ├── 91-ROADMAP.md
│   │   └── 92-AUTONOMY.md
│   │
│   └── rounds/ (开发轮次文档 - 24 个轮次)
│       ├── R13-2026-09-27-billing-ops-scope-gate.md
│       ├── R14-2026-09-27-go-live.md
│       ├── R15-2026-09-27-signup.md
│       ├── R16-2026-09-27-kiosk.md
│       ├── R17-2026-09-27-calendar.md
│       ├── R18-2026-09-27-access-review.md
│       ├── R19-2026-09-27-nuki.md
│       ├── R20-2026-09-27-scale-cost.md
│       ├── R21-2026-09-27-i18n.md
│       ├── R22-2026-09-27-pilot-freeze.md
│       ├── R23-2026-09-27-cf-git-deploy.md
│       └── ... (24 个轮次)
│
├── 🛠️ 支持工具 (support/ - 开发/测试辅助)
│   ├── boot.js                           # 启动脚本
│   ├── dev-vars.js                       # 开发变量
│   ├── fake-*.js                         # Mock 服务
│   │   ├── fake-nuki.js
│   │   ├── fake-stripe.js
│   │   └── fake-ttlock.js
│   ├── 负载和性能测试
│   │   ├── load-test.js
│   │   ├── snapshot-bench.js
│   │   └── worker-smoke.js
│   ├── 工具脚本
│   │   ├── i18n-coverage.js              # 国际化覆盖检查
│   │   ├── i18n-keep.js
│   │   ├── mock-idp.js                   # 模拟 OIDC IDP
│   │   ├── scim-load.js
│   │   └── smoke-fresh.sh
│   └── agent-recover.sh
│
├── 🖥️ 服务器入口
│   ├── server.js                         # HTTP 服务器
│   ├── worker.js                         # Cloudflare Worker
│   ├── cookies.js                        # Cookie 管理
│   ├── md5.js                            # MD5 工具
│   └── wrangler.jsonc                    # Worker 配置
│
└── 📄 INDEX_TREE.md                      # 本文件（仓库索引）
```

---

## 核心模块关系图

### 访问控制链路
```
auth-core.js (认证) 
    ↓
rbac-core.js (基于角色的访问控制)
    ↓
policy-core.js (权限策略引擎)
    ↓
acl.js (访问控制列表)
    ↓
drivers/ (具体实现)
    ├── ttlock.driver.js (TTLock 门锁)
    ├── nuki.js (Nuki 门锁)
    └── demo.driver.js (演示)
```

### 数据流架构
```
前端 (public/) 
    ↓
server.js (HTTP 服务) / worker.js (Cloudflare Workers)
    ↓
业务逻辑层 (*-core.js)
    ├── auth / rbac / policy
    ├── audit / reports
    ├── calendar / kiosk
    └── billing / signup
    ↓
数据层 (store/)
    ├── repo.js (ORM)
    ├── sql.js (查询生成)
    └── sqlite-node.js (SQLite 驱动)
    ↓
数据库 (migrations/)
    └── 25 个演进脚本
```

### 审计和合规链路
```
任何操作
    ↓
audit-core.js (记录)
    ↓
audit-anchor-core.js (不可篡改锚点)
    ↓
reports-core.js (生成报表)
    ↓
backup-export-core.js (导出和备份)
```

---

## 项目规模统计

| 指标 | 数值 |
|------|------|
| 总文件数 | 200+ |
| JavaScript 文件 | ~150 |
| HTML 文件 | ~10 |
| 测试文件 | 50+ |
| 数据库迁移 | 25 个 |
| 文档文件 | 15+ |
| 开发轮次 | 24 个 |
| 核心业务模块 | 45+ |
| 前端页面 | 8+ |

---

## 关键技术栈

### 后端
- **运行环境**: Node.js / Cloudflare Workers
- **数据库**: SQLite + 数据库迁移
- **认证**: OAuth2, OIDC, SAML
- **架构**: 模块化核心层 + 插件驱动

### 前端
- **框架**: 原生 JavaScript PWA
- **特性**: Service Worker, 离线支持, 响应式设计
- **国际化**: 英文和中文
- **功能**: 日历, 访客管理, 二维码, 打印

### 集成
- **TTLock**: 智能门锁集成
- **Nuki**: 欧洲门锁品牌
- **SCIM**: 身份供应标准
- **Stripe**: 支付处理 (mock)

### 测试和质量
- **单元测试**: 50+ 测试文件
- **模糊测试**: 隔离和作用域测试
- **安全测试**: SSRF 检查
- **性能测试**: 快照基准, 负载测试

---

## 快速导航

### 新手入门
1. 阅读 `docs/01-ARCHITECTURE.md` - 了解系统架构
2. 查看 `docs/00-INDEX.md` - 浏览所有文档
3. 查看 `public/index.html` - 前端入口
4. 运行 `scripts/doctor.js` - 系统诊断

### 开发人员
1. **认证**: `auth-core.js`, `auth.test.js`
2. **权限**: `policy-core.js`, `rbac-core.js`
3. **审计**: `audit-core.js`, `audit-anchor-core.js`
4. **API**: `api-core.js`, `test/` 中的 API 测试

### 部署人员
1. 阅读 `docs/12-GO-LIVE.md` - 生产部署指南
2. 查看 `docs/13-CLOUDFLARE-GIT-DEPLOY.md` - 部署配置
3. 运行 `scripts/cf-deploy.js` - Cloudflare 部署

### 安全审计
1. 查看 `audit-core.js` 和 `audit-anchor-core.js`
2. 阅读 `docs/30-SECURITY-TESTING.md`
3. 运行 `test/ssrf.test.js` 等安全测试

---

## 分支对比

| 特性 | main | arena/01a0de29-accessx |
|------|------|------------------------|
| 核心模块 | 10+ | **45+** ✓ |
| 数据库迁移 | 1 | **25** ✓ |
| 测试覆盖 | 3 | **50+** ✓ |
| 文档完整性 | 无 | **完整** ✓ |
| 前端功能 | 基础 | **生产级** ✓ |
| 国际化 | 无 | **有 (中英)** ✓ |
| 生产就绪 | ❌ | **✓** |

---

## 重要提示

- 此索引对应 commit: `a50e7ec0d651a370e1a6e91d3bb6cf5ace4cece3`
- 分支 `arena/01a0de29-accessx` 是完整的生产级应用原型
- 定期参考 `docs/rounds/` 了解开发进度
- 所有关键操作都有审计日志支持

---

**最后更新**: 2026-10-03  
**维护者**: lin2mm
