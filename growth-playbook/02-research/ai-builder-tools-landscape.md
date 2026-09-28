纯自传播 12 个月 100 万无可靠先例

# AI startups / builders 互联网工具全景与配套入口

2026-09-28｜公开研究与选型建议，不是全市场排名。没有任何名单能覆盖“所有创业者”；本报告用生命周期分类，区分采用证据与代表性产品。未注册服务、购买额度或部署产品。

## 1. “Top”的证据与限制

2025 Stack Overflow调查中，84%受访者正在使用或计划使用AI开发工具，51%专业开发者每天使用。这里的84%包含计划使用，不是全部已使用；样本是开发者调查，不是AI创业公司普查，更不是2026市场份额。该调查还指出agent并未全面普及，所以不能把所有builders当成agent开发者。[1](https://survey.stackoverflow.co/2025/ai)

采用标记：
- **A：**有本轮调查支持的方向/产品，不把调查外推为所有创业者排名。
- **B：**代表性候选，下面的分类是用途/选型建议，不宣称采用率、市场第一或性价比第一。
- **C：**与我们业务的合作机会假设，尚无客户付费或厂商合作证据。

调查中的ChatGPT、GitHub Copilot有采用数据；GitHub、PostgreSQL有开发者生态证据。具体份额不跨题目分母拼接。Cursor等工具也不因声量大就当成所有创业公司的默认选择。[1](https://survey.stackoverflow.co/2025/ai) [2](https://survey.stackoverflow.co/2025/technology)

## 2. 全生命周期工具地图

除明确A外均是B；每格是候选，不要求全部采购。官方链接用于后续核验功能/条款，未逐一审计价格与免卡条件。开源本地工具也列入，因为builders的互联网业务并非只用在线SaaS。

| 环节 | 优先了解的代表工具（官方入口） | 解决的工作 | 我们应如何配套，而非重造 |
|---|---|---|---|
| 通用AI研究/写作 | [ChatGPT](https://chatgpt.com/) A；[Claude](https://claude.ai/)；[Gemini](https://gemini.google.com/) | 需求梳理、分析、草稿 | 机器可读的真实兼容资料；不卖泛用提示词 |
| AI编程 | [GitHub Copilot](https://github.com/features/copilot) A；[Cursor](https://cursor.com/)；[Claude Code](https://code.claude.com/)；[Codex](https://openai.com/codex/) | 编码与工程辅助 | 小范围可验证示例、测试夹具，不写夸大能力的agent指令 |
| 快速生成应用 | [Lovable](https://lovable.dev/)；[Bolt](https://bolt.new/)；[Replit](https://replit.com/)；[v0](https://v0.app/) | 原型到Web应用 | 可嵌入的适配/交付模块，不能默认生成代码生产安全 |
| 代码与CI | [GitHub](https://github.com/) A；[GitLab](https://gitlab.com/)；[GitHub Actions](https://github.com/features/actions) | 版本、协作、自动测试 | 有版本的API契约、错误/取消/离线测试样例 |
| 设计/前端 | [Figma](https://www.figma.com/)；[Framer](https://www.framer.com/)；[Next.js](https://nextjs.org/)；[shadcn/ui](https://ui.shadcn.com/) | 界面与落地页 | 安装/应急/权限状态的设计组件与文案，未来验证后再发布 |
| 部署/边缘 | [Vercel](https://vercel.com/)；[Cloudflare](https://www.cloudflare.com/)；[Render](https://render.com/)；[Railway](https://railway.com/) | 托管与运行 | 标准Webhooks/HTTP边界，不绑定一个主机商 |
| 云与算力 | [AWS](https://aws.amazon.com/)；[Google Cloud](https://cloud.google.com/)；[Azure](https://azure.microsoft.com/)；[Modal](https://modal.com/)；[Runpod](https://www.runpod.io/) | 云资源和推理任务 | 仅提供自己的业务层，不转售未经许可的云额度 |
| 数据库/后端 | [PostgreSQL](https://www.postgresql.org/) A；[Supabase](https://supabase.com/)；[Neon](https://neon.com/)；[Firebase](https://firebase.google.com/) | 数据、身份、存储 | 可选数据模型、租户隔离示例；不重复造通用BaaS |
| 登录/企业身份 | [Clerk](https://clerk.com/)；[Auth0](https://auth0.com/)；[WorkOS](https://workos.com/) | 登录、企业SSO | 映射业务角色到设备授权，登录成功不等于有开门权限 |
| 模型/API | [OpenAI API](https://platform.openai.com/)；[Anthropic API](https://platform.claude.com/)；[Gemini API](https://ai.google.dev/)；[OpenRouter](https://openrouter.ai/) | 产品中的模型调用 | 模型不直接持有设备管理密钥；BYOK也不等于免费 |
| 模型/本地运行 | [Hugging Face](https://huggingface.co/)；[Ollama](https://ollama.com/) | 模型分发与本地实验 | 提供脱敏故障数据格式；模型许可证逐项检查 |
| Agent框架 | [LangGraph](https://www.langchain.com/langgraph)；[OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)；[Vercel AI SDK](https://ai-sdk.dev/) | 多步骤AI工作流 | 有范围的工具契约与可重复模拟，不保证agent行为正确 |
| AI评估/追踪 | [LangSmith](https://www.langchain.com/langsmith)；[Langfuse](https://langfuse.com/)；[Braintrust](https://www.braintrust.dev/) | 质量、成本、执行轨迹 | 物理访问成功/未知/失败真值，区别于模型自评 |
| 搜索/数据提取 | [Tavily](https://www.tavily.com/)；[Exa](https://exa.ai/)；[Firecrawl](https://www.firecrawl.dev/)；[Apify](https://apify.com/) | 外部检索与网页数据 | 带来源日期的兼容知识；遵守网站/隐私条款 |
| RAG/检索存储 | [pgvector](https://github.com/pgvector/pgvector)；[Pinecone](https://www.pinecone.io/)；[Qdrant](https://qdrant.tech/) | 向量检索 | 先少量结构化资料，没需求不部署向量数据库 |
| 自动化 | [n8n](https://n8n.io/)；[Make](https://www.make.com/)；[Zapier](https://zapier.com/) | 应用间业务流 | 入住/维修/交接模板；先核对嵌入/转售许可 |
| 后台任务 | [Inngest](https://www.inngest.com/)；[Trigger.dev](https://trigger.dev/)；[Temporal](https://temporal.io/) | 重试、长任务、调度 | 幂等、时间窗、撤权优先级，不能无限重试物理动作 |
| 支付/订阅 | [Stripe](https://stripe.com/)；[Paddle](https://www.paddle.com/)；[Lemon Squeezy](https://www.lemonsqueezy.com/) | 收费、订阅、部分MoR方案 | 软件/硬件分账；MoR是否接受实体硬件须单独核实 |
| 通知/邮件 | [Resend](https://resend.com/)；[Postmark](https://postmarkapp.com/)；[Twilio](https://www.twilio.com/) | 邮件、短信、消息 | 状态通知/异常升级；不把门码发入无授权群聊 |
| 分析/可观测性 | [PostHog](https://posthog.com/)；[Sentry](https://sentry.io/)；[Grafana](https://grafana.com/) | 产品转化、错误、运行指标 | 安装成功/异常率/支持分钟事件；禁止收集完整门码 |
| 客服/反馈 | [Intercom](https://www.intercom.com/)；[Crisp](https://crisp.chat/)；[Canny](https://canny.io/) | 客服、反馈管理 | 脱敏设备诊断包、工单归因和RMA路径 |
| 团队/项目 | [Notion](https://www.notion.so/)；[Linear](https://linear.app/)；[Slack](https://slack.com/)；[Discord](https://discord.com/) | 协作、项目、社区 | 标准试点表、变更记录，不索取生产凭据 |
| 线索/销售 | [HubSpot](https://www.hubspot.com/)；[Attio](https://attio.com/)；[Tally](https://tally.so/)；[Cal.com](https://cal.com/) | CRM、表单、预约 | 兼容筛选→合格线索，而非批量抓联系人轰炸 |
| 内容/分发 | [Product Hunt](https://www.producthunt.com/)；[Hacker News](https://news.ycombinator.com/)；[Indie Hackers](https://www.indiehackers.com/)；[LinkedIn](https://www.linkedin.com/)；[YouTube](https://www.youtube.com/) | 发布、讨论、演示 | 实际测试故事和可复现资料，不刷榜/假评论 |
| 搜索获客 | [Search Console](https://search.google.com/search-console/)；[Ahrefs](https://ahrefs.com/)；[Semrush](https://www.semrush.com/) | 搜索需求、内容效果 | 长尾适配/安装问题内容，流量≠有效买家 |
| 安全/秘密管理 | [1Password](https://1password.com/)；[Doppler](https://www.doppler.com/)；[Snyk](https://snyk.io/) | 凭据与代码风险 | 设备权限最小化，支持账号不能等同超级管理员 |
| 协议/设备连接 | [MCP](https://modelcontextprotocol.io/)；[Seam](https://www.seam.co/)；[TTLock](https://ttlock.com/) | 工具协议、设备API、锁生态 | TTLock-first的交付证据与安全业务流程；不声称通用API无人做 |

MCP是协议，不是权限系统、市场或自动获客渠道。安装一个MCP server不会自动带来客户；与工具厂商“技术上可连接”也不等于获准成为合作伙伴。

## 3. 最小组合：不同builder不应买同一大礼包

| 人群 | 起步组合建议（不代表已采购/集成） | 暂不加什么 |
|---|---|---|
| 个人/小团队原型 | 一个AI助手/编码工具＋GitHub＋一种部署＋一种后端＋表单 | 多模型网关、独立向量库、Kubernetes、复杂CRM |
| AI SaaS创业公司 | 上述＋一种模型API＋收款＋通知＋分析/错误追踪 | 同时买三套身份/分析/客服系统 |
| Agent/自动化工作室 | 上述＋一个工作流/任务运行方案＋评估＋最小权限连接 | 未授权的工具写操作、面向所有行业的模板承诺 |
| AI硬件团队 | 上述＋硬件设计/嵌入式工具＋设备管理/诊断＋交付/RMA | 用Web错误日志替代固件/物理可靠性验证 |

这些是采购压缩建议；不要求本项目开发或接入这些栈。真正需要我们服务的只是其中与实体场景、设备交付或访问流程有关的子集。

## 4. 免费、免卡、商用是三个不同问题

| 产品/模式 | 本轮可核实事实 | 对$0预算的处理 |
|---|---|---|
| Vercel Hobby | 官方限定非商业个人用途[3] | 不将它写成商用SaaS免费部署方案 |
| Supabase Free | 定价页$0、2个活跃项目、闲置一周暂停、数据库500MB等[4] | 可评估原型；本轮未验证免卡注册及完整条款，不承诺生产SLA |
| Cloudflare Workers Free | 文档列每天100,000请求、每次10ms CPU等限制[5] | 适合轻工作负载评估，不等于免费GPU/模型；免卡和实际服务另核 |
| PostHog Free | 定价页明确无需卡、不是试用、到免费限额停止使用[6] | 可列为候选；仍需数据最小化，不在本轮实际启用 |
| n8n/self-host | 免费源码可见不等于可任意托管/白标转售 | 官方许可证页面本轮返回404，嵌入/商业分发须重新确认；不凭博客作法律结论 |
| 模型API/短信/邮件 | 多数存在用量、账号、地区及发送限制 | 不以免费ChatGPT订阅推导API免费；BYOK也有客户账单 |
| Startup credits | 常有资格、期限与范围限制 | 不记作现金收入、永久免费或已获批准 |

来源：[3](https://vercel.com/docs/plans/hobby) [4](https://supabase.com/pricing) [5](https://developers.cloudflare.com/workers/platform/pricing/) [6](https://posthog.com/pricing)。本轮没有逐个完成免卡开户测试，因此当前真正承诺的$0方案是离线模板、合成案例、静态文档和手工访谈准备，而非全栈上线。

## 5. 从地图推导我们的角色

**不是工具商城，也不是再做一个全能builder。**软件工具已经覆盖了大部分编码/部署/收费功能。可能值得付费的剩余问题是：把生成的应用放到真实设备和经营现场后，怎样处理适配、授权、撤销、离线、安装、交付与售后。

推荐以“Free Builder Pack → 付费部署评审/接入 → 可选预付硬件 → 有验证价值的运营订阅”形成路径。所有付费层都是提案，不是现有产品或已成交业务。详情见[机会与执行计划](../05-system/ai-builder-hardware-opportunity-plan.md)。
