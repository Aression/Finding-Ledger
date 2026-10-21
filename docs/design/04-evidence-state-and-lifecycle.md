# 证据、认知状态与生命周期

本设计的关键，是不把“证据是否支持结论”“记录是否还在使用”“是否适用于当前环境”混成同一个状态。

## 1. 三个独立判断

对每条 finding，系统分别判断：

1. **认知状态（epistemic_state）：** 现有证据支持、反驳还是无法判断该主张？
2. **生命周期（lifecycle_state）：** 该记录是否仍是当前记录，是否已被取代或撤回？
3. **适用性（scope match）：** 在当前项目、代码版本和任务条件下，该结论是否可直接复用？

这三个维度不互相替代。例如：

| 场景 | 认知状态 | 生命周期 | 当前任务适用性 |
|---|---|---|---|
| 旧版本实验已证实某现象 | supported | current | 若版本不同则 needs_revalidation |
| 已经排除某种根因 | refuted | current | 只对匹配的实验条件有效 |
| 旧根因分析被新分析取代 | 可能仍 supported 或被 refuted | superseded | 作为历史记录，不作为当前主结论 |
| 用户明确要求限制 GPU | not_applicable | current | 在约束作用范围内适用 |
| 两组证据互相冲突 | contested | current | 不应作为无争议事实注入 |

## 2. 状态解释

### Epistemic state

- **unassessed → provisional：** 初次记录但证据评估尚不充分。
- **provisional → supported：** 增加充分且相关的支持证据。
- **provisional → refuted：** 有证据反驳该主张。
- **supported → contested：** 后续出现相关冲突证据，且冲突未解决。
- **contested → supported/refuted/inconclusive：** 通过进一步实验、检查或人工审查解决冲突。
- **任意状态 → inconclusive：** 已进行针对性检查，但现有证据不足以作出支持或反驳判断。
- **refuted → supported 或 provisional：** 允许纠正，但必须明确说明新证据为何改变原判断，并记录事件；不能直接静默改值。
- **not_applicable：** 通常用于约束、决策和程序性记录。若修改 claim_kind，应重新评估该状态。

状态机用于规范操作，不声称现实证据始终单调增强。新证据可以改变之前的判断。

### Lifecycle state

- **current → superseded：** 新 finding 取代旧 finding。
- **current → withdrawn：** 明确撤回该记录，例如记录内容错误或用户要求撤销。
- **current → archived：** 停止日常使用，但保留审计记录。
- **archived → current：** 在显式恢复并记录理由后，重新纳入候选集。
- **superseded/withdrawn → current：** 原则上不直接恢复旧记录；若确需恢复，应记录原因，并检查关联的新结论与状态是否仍成立。

被反证的 finding 可以保持 lifecycle_state=current，因为它作为“已排除路径”仍有用途。只有当该记录同时被取代、撤回或归档时，生命周期才变化。

## 3. 证据质量与记录规则

证据来源不是自动的真值评级。一个 log 来源可能很可靠，也可能是不完整或采集错误的；一段代码可以被读错；一次实验也可能存在混杂因素。因此，工具应保存来源和方法，不让 source_kind 自动决定结论状态。

对 evidence 建议遵循以下规则：
- 优先使用稳定、可重新定位的 source_ref，而非只写一段口头描述；
- 代码证据尽量绑定仓库、commit、文件路径和行号；
- 实验证据尽量绑定代码版本、配置、输入/数据版本、run ID 和结果工件；
- 用户表达保存为 user_statement，清楚地区分用户约束、用户观察和用户提出的根因假设；
- 摘要 excerpt 只保留必要片段，完整内容留在原始日志或资源中；
- 若内容哈希与当前源不一致，标记为 source_changed 或待核验，不自动判定原结论错误。

如果一个 finding 的支持证据全部不可访问，系统应暴露“来源不可验证”的问题，不要伪造为仍能重新核验。是否降低 epistemic_state，应通过明确的重新评估操作完成。

## 4. 关系变化的事务规则

### Refute
在一个事务中：
1. 检查目标 finding 存在；
2. 创建/关联反证 evidence；
3. 将 finding_evidence.relation 写为 contradicts；
4. 将 epistemic_state 更新为 refuted；
5. 写入 finding_events；
6. 提交事务。

必须保存 refutation reason。若没有可定位证据，允许显式记录“人工判定/用户撤回”等特殊情形，但不能伪装为实验反证。

### Supersede
在一个事务中：
1. 创建新的 finding；
2. 建立 from=new, relation=supersedes, to=old 的关系；
3. 将旧 finding 的 lifecycle_state 更新为 superseded；
4. 写入新旧双方的事件或至少写入足以追溯的事件；
5. 提交事务。

应用层应拒绝自环和会形成取代环的关系。取代关系不代表旧结论为假。

### Revalidate
重新验证并不一定创建新的 finding。若主张本身没变，可追加当前条件下的证据、更新 last_validated_at 和 scope 检查结果；若主张或适用条件发生实质变化，创建新的 finding 并使用 supersedes 或 derived_from 关系。

## 5. 冲突处理

当两条 current findings 互相矛盾时，系统不应仅按创建时间或“证据等级”自动删除一条。推荐流程：
1. 创建 finding_relations.relation=contradicts；
2. 展示各自的 scope、证据来源和最近验证时间；
3. 判断二者是否其实适用于不同版本或条件；
4. 若范围不同，则保留两条并完善 scope；
5. 若范围相同且证据冲突，则将相关结论设为 contested；
6. 只有在有充分理由时才明确反证或建立取代关系。

## 6. 审计事件

至少记录以下事件：created、evidence_added、epistemic_state_changed、lifecycle_changed、scope_changed、relation_added、revalidated、withdrawn、rule_promotion_updated。

事件保存 actor、理由、关联会话，以及关键字段的 before/after 摘要。事件日志的目的是解释重大认知变化，不是记录每次读取和纯展示操作。
