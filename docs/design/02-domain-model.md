# 领域模型与核心语义

## 1. 实体关系

~~~text
Project 1 -------- * Finding
Finding * -------- * Evidence (through FindingEvidence)
Finding * -------- * Finding (through FindingRelation)
Finding 1 -------- * FindingEvent
Finding 1 -------- * DocLink
~~~

- **Project**：稳定的项目身份，不等同于单次运行的工作目录。
- **Finding**：一个可独立理解并可被后续任务引用的主张或工程发现。
- **Evidence**：一个可定位的来源对象，如日志、代码版本、实验结果或用户陈述。
- **FindingEvidence**：某项证据对某条 finding 的支持、反驳或补充作用。
- **FindingRelation**：两个 findings 之间的语义关系，例如取代或矛盾。
- **FindingEvent**：影响后续推理的状态和关系变更记录。
- **DocLink**：finding 与项目文档、规则来源或归因资料之间的关联。

## 2. Finding 的字段语义

### claim_kind：记录内容属于什么类型

建议枚举：
- **observation**：直接观测，如“该探针输出的 shift -1/0/+1 指标近似相同”；
- **diagnosis**：对现象的解释，如“异常来自权重同步路径”；
- **constraint**：任务约束，如“本轮实验只能使用 GPU 0–3”；
- **decision**：已选择的方案或设计决定；
- **procedure**：可重复执行的操作方法。

这个字段描述内容性质，不表示证据强度。观测和诊断应特别注意区分：观测可能直接来自日志，诊断通常需要一条或多条证据支持。

### epistemic_state：目前证据如何支持这条主张

- **unassessed**：尚未完成证据评估；
- **provisional**：暂定，证据不足或仍需验证；
- **supported**：现有证据支持该主张；
- **contested**：存在尚未解决的冲突证据；
- **refuted**：当前证据已反驳该主张；
- **inconclusive**：已检查现有证据，但不足以支持或反驳；
- **not_applicable**：适用于无需作真伪判断的约束、决策或程序性记录。

不要在该枚举中加入 **verified**、**user-confirmed** 或 **superseded**。前两者混合了证据强度与来源性质；最后一个属于生命周期。用户陈述需要作为 evidence 来源单独保留。

### lifecycle_state：这条记录在历史中的位置

- **current**：当前仍作为候选记录；
- **superseded**：已被后续 finding 取代；
- **withdrawn**：由用户或负责 Agent 明确撤回；
- **archived**：从日常检索中退出，但为审计保留。

**refuted** 不等于 **superseded**。反证记录可以仍处于 **current** 生命周期，因为它需要作为相关任务中的已排除路径出现。被取代的结论也不一定是错误的，它可能只适用于旧版本。

### retrieval_policy：普通检索中的优先级

- **always**：在适用范围成立时进入高优先级候选；
- **relevant**：只有与当前任务相关时才注入；
- **on_demand**：显式查询时返回，平时不自动注入；
- **never**：不进入自动注入，但仍可通过显式管理接口检索。

**always** 不是无条件全局广播。所有策略都受项目隔离、适用范围和 token 预算约束。

## 3. Evidence 与 FindingEvidence 的分工

**evidence** 描述来源本身：
- source_kind：来源类型，如 log、file、experiment_run、git_commit、user_statement；
- source_ref：可访问的标识或定位符；
- locator：行号、会话序号、实验轮次或日志片段；
- revision：代码、数据或文档的版本；
- excerpt：关键观测的短摘录；
- content_hash：来源内容可获取时计算的摘要哈希；
- metadata_json：实验配置等可变细节。

**finding_evidence** 描述证据与某个结论之间的关系：
- relation=supports：证据支持该结论；
- relation=contradicts：证据反驳该结论；
- relation=context：证据提供背景，但本身不判断真伪；
- method：如何获得或分析这份证据，例如 experiment、code_inspection、runtime_observation、user_assertion。

同一 evidence 可以支持一条 finding，同时反驳另一条 finding，因此不能只在 evidence 表里用一个全局 supports 布尔值。

## 4. 适用范围 Scope

scope_json 至少要区分：
- **match**：适用性判断所需的硬条件；
- **context**：结论产生时的背景信息；
- **revalidate_on**：哪些变化应触发重新验证。

建议支持的维度包括项目、任务类型、分支、commit、模型/依赖版本、推理后端、dtype、配置和数据版本。V1 不需要将所有维度都做成独立 SQL 列；只有频繁查询并确实需要索引的维度才适合提升为独立列。

若条件无法判断，返回 unknown 或 needs_revalidation 的检索判定，不要默认为适用。

## 5. FindingRelation

V1 支持：
- **supersedes**：新 finding 取代旧 finding，方向定义为新 finding → 旧 finding；
- **derived_from**：一条 finding 的推导来源；
- **contradicts**：两个 findings 的结论相互冲突；
- **duplicate_of**：发现重复记录，指向规范记录；
- **related_to**：弱关联。

不要混淆两个 contradicts：FindingEvidence.relation=contradicts 表示证据反驳结论；FindingRelation.relation=contradicts 表示两个结论彼此冲突。关系表本身不自动决定哪个结论正确。

## 6. 一条 Finding 的最小质量要求

每次写入前，应用服务或轻量校验至少应检查：
1. statement 是单一、可独立理解的主张；
2. 有明确 claim_kind；
3. 如果标记 supported，至少存在一条有效的支持证据，或有经过定义的例外规则；
4. 用户陈述被标记为用户来源，不被误写成实验事实；
5. scope 不明时明确记录，而不是由模型猜测；
6. 变更既有主张的含义时，优先创建新 finding 并建立演化关系，不静默改写历史结论。
