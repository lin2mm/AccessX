# GitHub 免费账户限额与本仓的"节配额"策略

> 版本 v1.0 · 2026-09-28 · 状态: active
> 适用对象: 本仓(private repo,arena 分支)。先纠正一个关键误解:**消耗限额的不是提交次数**。

## 1. 先看钱包:GitHub Free 实际给什么

| 项目 | Free 额度 | 超限代价 | 备注 |
|---|---|---|---|
| 仓库数量(public+private) | **无限** | — | 2020 年起私库也无限 [1] |
| 协作者数量 | **无限**(个人与组织账户均是)[1][2] | — | |
| 提交/Push 次数 | **不计量,免费** | — | **所以"省提交"省错了地方** |
| **Actions 分钟(私库,Linux 等效)** | **2,000 分钟/月** | $0.006/分钟 或 卡住至下月(可设 $0 预算硬停)[3] | Windows 按 ×2、macOS 按 ×10 倍率扣 [3] |
| Actions/Artifacts 存储 | 500 MB | 超限无法写入新 artifact [3] | artifact 默认保留期可改短 |
| Packages 存储 | 500 MB [1] | 按量付费 | |
| Codespaces(个人账户) | 120 核时/月 + 15 GB 存储 [4] | 付费或停用 | 不用=不耗 |
| 仓库体积 | 建议 <1 GB,硬限 5 GB [1] | 警告/推送受阻 | 大文件别入库 |
| 公库 Actions | **完全免费,不计分钟** [3] | — | 私库才有 2,000 上限 |
| 付费档独享(Free 私库没有) | 分支保护/必填评审/环境密钥/Advanced Security [2] | — | 目前用不上,无刚需 |

**真实风险面只有三处:Actions 分钟、Artifacts/Packages 存储、仓库体积。** 提交频率与它们无关——**每次 push 触发的 CI 运行才花钱**。

## 2. 本仓现状体检(2026-09-28 实测)

- ✅ **无 `.github/workflows/`目录** → 当前 CI 消耗为 0,天然满血额度
- ✅ `.git` 仅 332 KB,仓库体积健康
- ⚠️ 建议立刻做一次防御动作(见 §4-1 预算硬顶)

## 3. "优化提交"的正确姿势(按见效排序)

### 3.1 现在就要做(零成本)
1. **设 $0 花费上限**:Settings → Billing → Budgets → Actions/Packages/Codespaces 各建 budget,cap=$0。超免费额即停止计费,永远不会收到账单——比任何优化都可靠。
2. **不用 CI 就别碰**:M1 前无自动化测试需求时,不新增 workflows;若将来加,默认从"手动触发(`workflow_dispatch`)"起步。

### 3.2 将来上 CI 时的省分钟六式
| 招式 | 做法 | 省法 |
|---|---|---|
| ① 文档路径豁免 | `paths-ignore: ['growth-playbook/**','**.md']` | 本仓 80% 提交是 docs,直接 0 触发 |
| ② 手动批注跳过 | 提交信息含 `[skip ci]` | 顺手一跳 |
| ③ 并发取消 | `concurrency: {group: ci,cancel-in-progress: true}` | 连推 5 次只跑最新 1 次,**省 80%** |
| ④ 缓存依赖 | `actions/cache` 锁 node_modules | 每次省 1–3 分钟 |
| ⑤ 只用 Linux runner | 不跑 Windows/macOS 矩阵(除非发版夜) | 避开 ×2 / ×10 倍率 |
| ⑥ 只跑 PR+main | `on: {pull_request, push:{branches:[main]}}` | 功能分支自由推不扣费 |

### 3.3 提交习惯(与配额无关,但让历史干净)
本地随便 commit(不耗任何东西),**push 才触发 webhook**;合并用 squash(一次特性一条历史);`--amend`/rebase 修正笔误次性提交。别把 commit 次数当成本,把 "push 后自动跑了什么" 当成本。

### 3.4 体积纪律
`.gitignore` 守住 `node_modules/ dist/ .next/`;预渲染图/PDF 走 `data:`外链或发布产物;截图/设计稿传外部图床只在 md 里引用——growth-playbook 全文字库,天然轻。

## 4. 额度耗尽时的降级路径

1. 首选:$0 预算顶死,**绝不为超支买单**(团队 ≤3 人,2,000 分钟足够:每天 66 分钟 CI)。
2. 次选:自托管 runner(家里的旧电脑/免费 oracle/hetzner 小机)→ 私库跑自托管 runner **不消耗 Actions 分钟**,只付出机器钱。
3. 升级才考虑:Team $4/人/月(3,000 分钟)[3][4]——等 CI 真正跑满再说。

## 5. 数据来源

- [1] [GitHub Free: Private Repos, Actions Minutes, and Storage — appsdrift](https://appsdrift.com/github-free-private-repos/)
- [2] [GitHub Community — Free plans and private repository #152247](https://github.com/orgs/community/discussions/152247)
- [3] [Is GitHub Actions Free? Free Tier Limits 2026 — cicdcalculator](https://cicdcalculator.com/github-actions-free-tier)
- [4] [GitHub Pricing 2026: Free, Team & Enterprise Costs — capitalandcompute](https://capitalandcompute.net/blog/github-pricing-plans-cost/)
- [5] [WP Tavern — 2020 私库协作者无限化的官方变更回顾](https://wptavern.com/github-opens-free-plan-to-unlimited-collaborators-on-private-repositories)

> 注: Codespaces/LFS 具体额度以 GitHub 官方 Billing 页为准,上述为 2026Q3 桌面调研口径。
