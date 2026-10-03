# R23：GitHub → Cloudflare 自动部署（2026-09-27）

**一句话：** 你更正说仓库已经连接了 Cloudflare。
核对后发现：**合并到 `main` 就会自动部署，但按原来的配置，第一次部署会失败**。更要紧的是，如果它成功了，**生产环境会默认允许匿名读取**。
这一轮把仓库改成可以从 Git 安全部署：
- `npm run deploy` 按名字找到（或新建）D1、先迁移、再部署、最后查健康；
- 仓库里不再有占位数据库 id，也不再开匿名读取；
- 写了控制台操作清单 `13-CLOUDFLARE-GIT-DEPLOY.md`；
- 开了 **PR #1**。**合并这个 PR 就是上线**，所以合并前要先做完清单里的控制台设置。

- 时间：21:18–21:27（代码；文档提交在其后，见 `git log`）。开始时沙盒第 9 次重置，用 `support/agent-recover.sh` 一条命令恢复。
- 提交：`5a1227a`、`9cbca06`（代码）+ `44ede6c` 和本文档提交（文档）
- PR：<https://github.com/lin2mm/AccessX/pull/1>（`arena/01a0de29-accessx` → `main`，等你合并）

## 1. 更正：我上一轮说错了

R22 的 `92-AUTONOMY.md` 写着“从来没有真正部署过：沙盒里没有 Cloudflare 账号”。
后半句对（沙盒里确实没有凭据），但结论错了：**GitHub 仓库已经装了 Cloudflare Workers and Pages 应用**，我没有去查。

核对到的现状：
- 已安装的 GitHub 应用：`cloudflare-workers-and-pages`，另外还有 `cursor`、`supabase`。
- 每个提交（`main` 上 3 个，本分支上的也一样）都有 Cloudflare 的检查套件，**状态一直是 queued，里面没有任何运行**。
- 结论：Cloudflare 还一次都没构建过。最可能的原因：Worker 监听的分支还没有新提交，或者构建设置没保存。
- 查不到的：`gh api …/deployments` 返回 403，拿不到 Cloudflare 那边的设置。**Worker 实际叫什么名字、监听哪个分支，需要你在控制台看一眼**（13 号文档 §2 第 1 步）。

## 2. 原配置如果被 Git 构建部署，会出三个问题

| 问题 | 后果 | 修复 |
|---|---|---|
| `database_id` 是占位值 `"local-accessx-demo"` | 构建直接失败 | 删掉 id。部署脚本按 `database_name` 找数据库，没有就创建，再把真实 id 写进 `wrangler.deploy.jsonc`（被 gitignore） |
| 默认部署命令 `npx wrangler deploy` 不跑迁移（Worker 自己也不迁移） | 新代码配旧表结构，`/api/healthz` 返回 503 | `npm run deploy` 先迁移再部署。Wrangler 有个已知问题：配置里没有 id 时，远程迁移会被拒绝（#13632），所以由脚本先解析 id |
| `vars.AUTH_OPEN_READS = "1"` 写在仓库配置里 | **每次 Git 部署都会打开匿名读取**：没设 TTLock 凭据的试点，任何人都能看门列表和审计日志 | 从仓库配置里删掉，并加 `"keep_vars": true`，控制台设的变量不会被部署清掉。本地冒烟测试改由 `.dev.vars` 打开 |

第三条是**更正 R22 的自查结论**。R22 写的是“doctor 会报错，所以不改”，但 Git 部署根本不会跑 doctor。
现在 doctor 把它列为错误，而且 **CI 每次都检查 `wrangler.jsonc`**。

## 3. `npm run deploy`（`scripts/cf-deploy.js`）

1. 按名字找 D1 `accessx-demo`。第一次构建时创建（可用构建变量 `D1_LOCATION` 选区域）。
2. 写出 `wrangler.deploy.jsonc` = `wrangler.jsonc` + 真实 id。
3. `wrangler d1 migrations apply DB --remote`：**先迁移**。迁移只加不改，旧代码在新表结构上照样能跑。
4. `wrangler deploy`。
5. 访问 `https://accessx-demo.<账号>.workers.dev/api/healthz`，直到返回 200 且 `ok:true`；否则构建失败。

任何一步失败，线上都保持上一个版本。另外几种用法：
- `--dry-run`：不连 Cloudflare，只打包（CI 每次都跑）。
- `--migrate-only`：只做 1–3 步，`npm run cf:db:migrate:remote` 改用它。
- `--resolve-only`：只做 1–2 步，`npm run backup -- d1` 远程导出前先用它解析 id。
- `npm run cf:deploy` 也指向同一个脚本：**不再有跳过迁移的部署方式**。

**发现的控制台坑：** Cloudflare 为 Workers Builds 自动生成的 API 令牌**没有 D1 权限**（只有 Workers Scripts / KV / R2 等），所以第一次构建会在“列出 D1 数据库”这一步失败。
这一步只能你来做：给这个令牌加 **Account · D1 · Edit**。脚本遇到这个错误时，会在构建日志里直接给出这句修复说明。

## 4. 13 号文档：`docs/13-CLOUDFLARE-GIT-DEPLOY.md`

- §1 推送之后发生什么
- §2 控制台一次性设置（7 步，约 20 分钟）
- §3 运行时变量和密钥表
- §4 构建失败对照表
- §5 回滚
- §6 手动部署 / 以后加 staging

同时更新了 `12-GO-LIVE.md`（第 1、2、3、8 步改为自动或指向 13；Time Travel 命令里的库名改成 `accessx-demo`）、`10-PILOT.md`、README、`00-INDEX.md`。

## 5. `v1.0-pilot` 标签：改成合并后在 `main` 上建

你说“都按建议”，本来这一轮就要推标签。但现在有了 Git 部署，**线上跑的是 `main`，不是这个分支**。
标签应该标在“生产实际运行的那个提交”上，也就是合并提交，而它要你合并之后才存在。
所以 PR 说明里请你用 **Create a merge commit**（不要 squash，否则各轮提交在 `main` 上看不到，文档里引用的提交号也会失效）。
合并后，在 GitHub 上对 `main` 建 Release `v1.0-pilot`，或者回复“建 release”，我执行 `gh release create v1.0-pilot --target main`。

## 验证

| 检查 | 结果 |
|---|---|
| `npm test`（`TZ=UTC`，开快照守卫） | **302 个全部通过**（新增 9 个部署测试；doctor 测试改写） |
| 变异验证 | 把“迁移”挪到“部署”之后 → **5 个测试失败**。旧配置（占位 id + 匿名读取 + 没有 `keep_vars`）→ doctor 报 2 个错误 1 个警告 |
| 跨租户隔离门 / 站点范围门 | 3,502 个请求 128 条路由 0 泄漏 / 1,980 个请求 0 越界 |
| Worker 冒烟测试（`smoke-fresh.sh`，全新 D1，**没有 `database_id`**） | **36/36** |
| 本地迁移（没有 `database_id`） | 0001–0025 全部应用 |
| `npm run deploy -- --dry-run`（真 wrangler） | 685 KiB；绑定里已经没有 `AUTH_OPEN_READS` |
| CI | `5a1227a`、`9cbca06` 通过（后者已包含新增的“Worker 打包 + wrangler.jsonc 检查”两步），PR #1 上也会跑 |

**没验证的（需要真账号）：** 真实的 `d1 list/create` 输出格式（按 wrangler 文档写，解析时能容忍前面有横幅文字）、Workers Builds 里的实际构建、workers.dev 地址的解析。第一次构建时请把日志发给我（去掉任何密钥），有问题我当场修。

## 下一步（部署周，09-28 起）

1. **你（约 20 分钟）：** 按 13 号文档 §2 做完控制台设置：Worker 名、构建命令、**令牌加 D1 Edit**、关掉非生产分支构建、`D1_LOCATION`。
2. **你：** 在自己电脑上生成密钥，填进 Variables & Secrets（§3）。
3. **你：** 合并 PR #1（Create a merge commit）→ 看构建日志里有没有 `[deploy] healthy:`。
4. **我：** 构建失败就看日志修；成功后陪你跑 `npm run doctor -- --url …`、外部监控、备份恢复演练，然后在真 R2 桶上做 SSE-C。
5. 合并后建 `v1.0-pilot` Release。
