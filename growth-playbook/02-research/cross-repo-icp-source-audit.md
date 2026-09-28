纯自传播 12 个月 100 万无可靠先例

# 两仓库只读核查：ICP原表在哪里，哪些数字不能合并

核查日：2026-09-28。两个仓库当前均可公开读取。本轮未修改源仓库、切换工作分支、运行其脚本、发送消息或读取AccessX应用实现。其他项目的产品描述/网站内容不成为本项目产品真相。

> 更新：用户已提供两个Drive入口，本轮已成功读取原表部分公司行及F02/H08/68正文。下文第2–4节保留初次GitHub审计快照，其中“未读原表/待提供入口”不再代表当前状态；覆盖范围、同名54表头修正及三家核查队列见[增量核查](existing-icp-delta-review.md)。无需再上传名单或提供入口。

## 1. 固定来源，不追着移动分支混版本

|来源ID|仓库|读取分支|固定提交|用途|
|---|---|---|---|---|
|RL|lin2mm/RetrofitLock|arena/01a0cc8f-retrofitlock|deee8771173e636db118ac03f8d9043fd37d9ed0|销售资产/历史资料索引；找到外部线索表的文件名与池边界|
|PLP|lin2mm/product-launch-pad|main|c39431b33df8b429af3a5870ff96408e666b582e|产品网站工程目录；未见公司级名单文件|

两个提交的递归文件树均未截断。本轮只说明上述提交的情况，不证明Git历史或别的工作区从来没有名单。没有读取网站组件/产品数据来推断样品型号或能力。

## 2. RetrofitLock：找到了导航，不等于读到了名单

直接读到的关键索引：

- [DRIVE_NAME_TREE.md](https://github.com/lin2mm/RetrofitLock/blob/deee8771173e636db118ac03f8d9043fd37d9ed0/00_meta/DRIVE_NAME_TREE.md)：外部目录相对路径、文件名与读取边界；父目录名为`forArena-PublicSharing`，入口只存于旧工作区忽略文件，不在该索引中。
- [DRIVE_INDEX_SUMMARY.md](https://github.com/lin2mm/RetrofitLock/blob/deee8771173e636db118ac03f8d9043fd37d9ed0/00_meta/DRIVE_INDEX_SUMMARY.md)：区分不同位置的同名名单与历史计数。
- [COUNTRY_POOL.md](https://github.com/lin2mm/RetrofitLock/blob/deee8771173e636db118ac03f8d9043fd37d9ed0/00_meta/COUNTRY_POOL.md)：国家/渠道池及评分规则的历史摘要。
- [OLD_SUMMARY_INDEX.md](https://github.com/lin2mm/RetrofitLock/blob/deee8771173e636db118ac03f8d9043fd37d9ed0/00_meta/OLD_SUMMARY_INDEX.md)：F02等渠道资料的定位。
- [20_audience/ICP.md](https://github.com/lin2mm/RetrofitLock/blob/deee8771173e636db118ac03f8d9043fd37d9ed0/20_audience/ICP.md)：仍是“待导入”模板，不是公司名单。不能拿此空模板否认外部已有资产。

旧`DRIVE_INDEX.md`还列有历史共享目录入口，但不是已确认的目标名单父目录。本轮不复制其Drive标识到新报告，也不为寻找名单而遍历无关CAD/图片/应用资料。

## 3. 四个池分别登记，计数全部是历史来源陈述

|池ID|历史文件/位置|摘要中的数值|本轮证据级别|不能解释成|
|---|---|---|---|---|
|POOL-A|J07/H02引用的旧模组名单；原始文件关系待核|A级536、B227、C425；另列85/20/16及“约1293待去重”|读到摘要，未读原表|536个独立活跃买方、确定适配或已成交|
|POOL-B|`20260923-Session10/54_qualified_leads.xlsx`，历史界面25KB|A级129，摘要称定义为有邮箱且商用分≥25；旧记录仅解析过1/6|读到摘要，未读原表|POOL-A的最新版、全表公司总数|
|POOL-C|Session2线索目录的16国地图名单，67/69系列关系待核|13,299行；A225、B307、双A137、有邮箱2063|读到摘要，未读原表|13,299家去重公司、可发送名单或订单|
|POOL-D|`20260923-Session10/03_SL-F02_ChannelRanking_Retrofit_SiemensMidMarket_CN_v1.md`及同名xlsx|作者自报去重候选749、可行动作524、北美181；NO_SEND|读到摘要，未读原文件|749家本轮已核验渠道、524家愿意预付|

POOL-A算术提示：536+227+425=1188；加85和20为1293，再加16为1309。原摘要未充分说明16是否包含/重叠，故不自行修成一个新总数。国家A级子项相加为536，只能证明摘要内部该项算术吻合，不能证明公司去重。

POOL-C的A/B/双A/有邮箱可能重叠，不能相加。美国未包含在该16国覆盖中，不能据此判断美国没有商机。

另有同名实例：`20260909-Session2/11_线索与集成商/54_qualified_leads.xlsx`历史界面79KB。它与Session10的25KB文件分开保留；大小不是当前下载核验值，原始字节/哈希均未取得。不能按文件名覆盖、认定新版或将其直接归入POOL-A。

## 4. 原表定位已经足够具体，不需重新爬名单

优先取得这些文件的只读入口或去标识导出，不要求开放整个云盘：

|优先|相对路径/文件|理由|
|---|---|---|
|1|`20260923-Session10/03_SL-F02_ChannelRanking_Retrofit_SiemensMidMarket_CN_v1.md` 或 xlsx|已有渠道排序，可核查是否匹配当前预付款和标准套装条件|
|2|`20260923-Session10/07_SL-H08_Outreach_Status_Feedback_Log_NoSend_CN_v1.md`的公司级脱敏摘要|历史索引称有一次索取catalogue回复；优先核查真实较温暖线索，不复制私人对话|
|3|两个位置各自的`54_qualified_leads.xlsx`|辨认版本、计分、重复和实际条数|
|4|`20260909-Session2/11_线索与集成商/69_final_leads_16countries.xlsx`与EN版本|先判断语言版是否同一批；保留来源映射，防翻译双算|
|备查|`55_master_opportunity_ranking`、`58_commercial_icp_and_overnight`、`68_crawler_audit.xlsx`|理解旧规则和脏数据，不直接采用历史预测概率|

只需要公司、官网、国家、渠道类别、证据URL、历史阶段和匿名化最近沟通结果。联系方式/凭据/完整私人消息可剔除。若不能读完整表，可先提供前两项中的20–50家公司级记录。

## 5. 对当前策略的有条件修正

1. 之前本会话提出软件公司渠道优先，是新经营假设。旧F02顺序为OEM/白牌/中型进口分销→安装商集成商→物业短租小酒店，是历史筛选逻辑。二者不互相覆盖；实际是否优先取决于预付款、兼容、职责与真实需求。
2. 若旧H08确有仍有效的目录索取，应先核实该线索及历史承诺，不能要求对方重新回答重复问题。但索取目录不是采购意向证明，更不是订单。
3. 旧A级含邮箱/商用分，不代表当前七项硬门槛通过。不得把高分直接导入本轮合格客户字段。
4. 当前只选择最多5家首批候选，不为了软件渠道主张而排除更接近付款的合格中小经销商；也不因为旧渠道排名就停止软件渠道验证。
5. 柜子与仓储仍是独立假设；旧目录中的特定产品描述不证明用户现有样品适配这些场景。

## 6. 网站来源也分开

|网站/仓库资产|直接证据|本轮结论|
|---|---|---|
|RetrofitLock `60_website/`|[README](https://github.com/lin2mm/RetrofitLock/blob/deee8771173e636db118ac03f8d9043fd37d9ed0/60_website/README.md)自述无品牌安装商页面草稿，包含首页/市场/目录/买家问题|仓库页面存在，不等于已部署销售站、已认证或当前样品规格|
|product-launch-pad|[README](https://github.com/lin2mm/product-launch-pad/blob/c39431b33df8b429af3a5870ff96408e666b582e/README.md)描述Lovable建站；文件树有网站路由和产品目录代码|未见ICP公司表；README的Lovable编辑项目链接不是已核实公网成品网址|
|GlobalLockSummary|来自此前单独核查|工程知识库，不能和商业销售站或未来消费者公益站混为一体|
|AccessX|本会话策略文件及用户描述|应用实现未读取；不以其他项目描述替代产品事实|

两个仓库GitHub metadata的homepage均为空。本轮没有核实公网部署，不编造网站地址。

## 7. 证据纪律与隐私

- 新记录字段固定：repo、branch、commit、source_path、source_pool、original_claim、current_check、unresolved、read_date。
- 原始名单每行保留来源池与原行ID；同公司跨池关联但不删除出处。相同域名只作重复候选，集团/品牌/分店需进一步辨别。
- 本轮计数必须从实际读取行计算；历史计数单列。空白不填0、未联系不填拒绝、邮箱存在不填可发送。
- 本会话未执行外联，与别的会话历史外联是两个字段；以前“未发送/未联系”只能用于本会话活动，不作全项目断言。
- 仓库当前公开可读，意味着历史索引中的外链也可能被外部发现。本轮不复制Drive标识、私人联系人或消息；用户宜自行检查公开范围。本轮不进行凭据扫描或修改可见性。

## 8. 当前结果与剩余工作（已更新）

已完成：复用固定提交索引和读取方法；读取用户提供的两个入口；取得两个XLSX版54的首块公司行、新Sheets54首块、F02/H08/68正文；抽取三家公司级核查卡并进行有限官网核查。没有重建全盘索引或重新批量爬名单。

尚未完成：三个54实例的全表比较、原件字节/哈希校验、全局去重、67/69正文读取，以及当前样品/采购/预付款资格验证。536和129是原表表头自报值，不是本轮去重计数。

**Drive入口阻塞已解除，不再要求用户提供相同链接或重传原表。** 当前结论见[原表增量核查](existing-icp-delta-review.md)。

配套：[来源登记](cross-repo-icp-source-register.csv) · [下一单验证](../05-system/next-order-validation-plan.md)。
