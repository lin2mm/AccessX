纯自传播 12 个月 100 万无可靠先例

# 资料分类、合并与瘦身结果

日期：2026-09-28。范围为本会话生成的`growth-playbook`和三个相关GitHub仓库的只读目录元数据；没有检查所有分支、Git历史对象、Actions产物、LFS或Release。因此不是整个GitHub账号的全历史清理完成声明。

## 1. 盘点结论

整理前本地策略产物：**108个文件，756,352字节（约739KiB）**，磁盘块占用约992KiB。SHA-256逐文件比较：**没有字节完全相同的重复文件**。问题主要是内容重叠、多个“当前总纲”和旧ready标签，不是大文件爆仓。

整理盘点时`growth-playbook/`为未跟踪，`git ls-files growth-playbook`为空。此为整理前快照；随后用户授权仅向工作分支发布，最新发布状态见README与Git提交记录。

本轮读取的GitHub树均未截断：

|仓库/检查提交|当前树文件数|树内文件字节合计|API仓库size（KiB）|结论|
|---|---:|---:|---:|---|
|AccessX / b74185b4056c4fa4448537792547633386a2da39（检查时main）|25|189,370|1,391|该树没有growth-playbook，不应在远端清理“重复策略版本”|
|RetrofitLock / deee8771173e636db118ac03f8d9043fd37d9ed0|93|481,169|1,151|原销售资产和索引，保留为独立来源|
|product-launch-pad / c39431b33df8b429af3a5870ff96408e666b582e|93|372,441|159|网站工程来源，不合并为免费软件潜客库|

API size是服务报告的仓库指标，树字节是当前提交文件内容之和；两者不等价，不拿差值推断垃圾或可回收空间。没有远端删除、改名、提交或推送。要整理源仓库内容需另行明确范围；本轮只提出复用边界，不修改它们。

## 2. 已执行的合并与分类

|操作|结果|保留边界|
|---|---|---|
|重写README|删除多轮重复追加与互相冲突的“当前优先”；缩成三份入口|详细文档仍在，不需要保存冗余导航副本|
|收敛主决策板|主计划、当前阶段、准备门、后续路线合并到strategy-master-summary|免费软件实验细节仍只维护free-software-growth-plan，不复制另一份日历|
|保留原综合总结|转为hardware-strategy-reference|原来源、数字和跨线分析不丢；明确不是当前软件执行入口|
|停用13份旧策略/上线/捆绑/推广稿|原位添加历史停用标记，覆盖正文active/ready声明|不移动脚本/CSV或破坏相对依赖，不擅自重写历史实验数据|
|建立完整文件登记|每个文件都有类别、执行状态、处理方式及体积；不再手工维护重复长目录|这是本地生成文件盘点，不是重建Drive索引|

**瘦身主要是减少当前阅读与维护范围，不以删掉独有资料换空间。** 本轮没有二进制下载可清理；保留硬件参考与文件登记会增加少量文件，不能把入口变短宣传成仓库大幅减容。首次整理后实测110文件、772,246字节（约754KiB），比整理前增加15,894字节，主要是保留旧综合参考和新增分类台账；后续写入本统计说明会使字节数略变。逻辑分类为：7个当前入口/规则/表格、50个硬件参考、27个证据/模型/参考、26个历史停用。此次是执行面和阅读面的瘦身，不是磁盘减容。

## 3. 四类资料的使用边界

### A 当前免费软件执行

- [主决策板](05-system/strategy-master-summary.md)：唯一当前范围/进度入口。
- [免费软件计划](05-system/free-software-growth-plan.md)：任务/渠道/实验唯一细节入口。
- [软件潜客登记](05-system/free-software-prospect-register.csv)：仅有表头，不混入硬件名单。
- [会话规则](05-system/session-working-rules.md)：来源、空间及授权。

### B 硬件独立参考，按需再启用

- [预付出口](05-system/prepaid-export-channel-plan.md)、[下一单验证](05-system/next-order-validation-plan.md)、[样品与已有入口](05-system/first-order-contact-pack.md)。
- [软件公司硬件伙伴研究](02-research/software-partner-first-wave.md)、[TTLock接口证据](02-research/ttlock-diagnostics-api-evidence.md)。
- [历史ICP增量核查](02-research/existing-icp-delta-review.md)、[跨仓来源审计](02-research/cross-repo-icp-source-audit.md)。
- [Troublemaker路线](05-system/troublemaker-locker-storage-strategy.md)、[Seam研究](04-case-studies/seam-360-analysis.md)。

硬件原表与私信的source ID、原始语境不得被软件分类覆盖。实际产品能力仍依据用户事实和授权验证，不从这些文件推断。

### C 证据、案例、模型与参考需求

案例研究保留来源、日期和统计口径。模型脚本、输入、输出视为一组；不是因为都叫CSV就合并。14条投诉摘要不是14个软件潜客。四类用户的旧功能假设只作参考，须经过新计划筛选。

代表入口：[证据复核](04-case-studies/software-hardware-evidence-review.md)、[软件功能参考](03-design/free-app-commercial-operations-plan.md)、[订单经济模型](05-system/partner-order-economics-guide.md)、[规模情景](05-system/revenue-scale-strategy.md)。均不是当前实现或实绩。

### D 历史停用，不执行

旧百万增长、5000用户年度预测、旧完整体系/双主线总纲、预售/广告/收费招募、捆绑赠锁和自动上线流程。其HTML/collector/邮件稿一并标入登记为停用，未发布、未运行。历史模型与对应情景保留比较，不替换当前软件计划。

## 4. 哪些能进一步合并/删除？

- **可安全压缩：** 重复导航、重复决策说明、已被明确取代的执行入口，本轮已做。
- **可以以后删除：** 可重获下载、可重算模型输出，但先核源文件/依赖/重算一致性，并记录清理对象。现在未证明所有输出可完全重现，故本轮不批量删CSV。
- **不能直接合并：** 不同54实例、不同国家池、语言版本、硬件与软件潜客、假设与真实记录、不同公司财务口径。
- **暂不做物理搬家：** 当前不到1MiB策略文本，移动上百个文件收益很低，却易破坏路径。采用逻辑分类与明确停用标记；需要发布某类资料时再按清单导出。
- **Git历史清理：** 从当前树删除文件不等于缩小历史。没有证据和授权，不执行历史重写、force-push、远端删除或跨仓合并。

## 5. 后续维护只用一个规则

先查[file-register.csv](file-register.csv)再建文件。同一任务只更新已有入口；新增外部证据进入原证据表；真实参与者进入软件潜客表。每轮只更新改变决策的证据，不再生成另一个“全盘总计划”。
