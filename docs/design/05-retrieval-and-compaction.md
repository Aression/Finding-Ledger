# 检索、适用性判断与上下文压缩恢复

## 1. 目标

检索层的任务不是把所有历史 findings 重新注入，而是为当前任务构建一个**短、相关、适用范围明确、证据可追溯**的上下文片段。

首版采用确定性规则。只有在基准测试证明关键词/标签检索的召回不足时，才增加 embedding 或 reranker；向量相似度本身不能决定结论是否适用或是否正确。

## 2. 触发时机

建议优先支持以下触发点：

1. **新会话/项目初始化：** 恢复高优先级约束和少量项目级关键结论。
2. **上下文压缩完成：** 在宿主提供对应事件时，注入短摘要，帮助 Agent 延续当前工作。
3. **显式查询：** Agent 或用户使用 query_findings/get_finding 获取具体发现和证据。
4. **任务切换：** 若宿主能提供新的任务目标，按新任务重新检索，不复用前一个任务的候选集。

README 当前方案提到监听 session/event 中的 compaction/end，并通过 system-prompt/assemble 注入。实际适配时必须先确认宿主的事件名称、调用时序和注入接口；若事件不可用，应提供显式查询或其他可靠回退，而不是假定钩子一定触发。

## 3. 检索流水线

### Step 1：建立任务上下文

最低输入：
- project_id；
- 当前任务目标或最近一条任务描述；
- 若可获得，当前 branch、commit、运行后端、dtype、配置版本；
- 剩余注入预算。

无法获取某项信息时标记为 unknown，不应让 Agent 自行脑补环境值。

### Step 2：硬过滤

先排除明显不适用记录：
- 不在当前项目范围且未显式允许共享；
- lifecycle_state 为 superseded、withdrawn 或 archived（历史查询除外）；
- retrieval_policy=never；
- scope 的硬匹配条件与当前任务明确冲突。

refuted 且 lifecycle_state=current 的 finding 不能在此阶段直接排除，因为它可能是防止重复排查的重要排除项。

### Step 3：适用性分类

对每条候选记录返回以下内部判定：
- **applicable：** 硬条件符合，关键适用条件可确认；
- **conditional：** 只在部分条件成立时适用，注入时需要写明条件；
- **needs_revalidation：** 来源或环境变化，当前适用性无法确认；
- **incompatible：** 硬条件明确冲突，不作为当前事实注入；
- **unknown：** 信息不足，不能决定是否适用。

V1 可以用简单的 JSON 字段比较与显式规则完成 scope matching。任何未知或不支持的条件都不能静默视为匹配成功。

### Step 4：建立候选集并排序

候选优先级建议依次考虑：
1. 适用性：applicable 高于 conditional；needs_revalidation 只在历史或重新验证场景中出现；
2. policy：always 在相关候选中优先，但仍受 scope 和 budget 约束；
3. 任务相关性：statement、tags、任务目标和显式关键词匹配；
4. 认知状态：supported 的结论可作为当前结论呈现；contested/refuted 需明确状态说明；
5. 实用价值：能避免昂贵探针、保留硬约束或说明当前根因路径的记录优先；
6. 记录简洁度与来源可追溯性。

不要把上述因素折算成模型自行填写的“0.94 置信度”。V1 可用可解释的排序规则；需要打分时应记录分项分数和规则版本，便于离线评估。

### Step 5：处理关系

- 对 superseded finding，默认不注入历史正文；若当前 finding 来源于它，可附加一句“此结论取代 finding ID”。
- 对 current/refuted finding，若任务相关，则以“已排除路径”呈现，并附带范围和反证摘要。
- 对 contested finding，明确标出证据冲突，不能用肯定语气表达。
- 对 contradicts 关系，必要时同时取回冲突结论与关联证据，避免仅看到其中一方。
- 对 duplicate_of，只注入规范记录，除非用户正在检查历史去重。

### Step 6：预算与格式化

每条注入记录优先包含：
- finding ID；
- 主张；
- epistemic_state 与 lifecycle_state；
- 适用条件或不适用条件；
- 一句证据摘要与来源定位符；
- 需要时的 related finding ID。

先注入对当前任务有直接影响的内容。超出预算时，优先删除低相关性历史细节，而不是截掉状态或适用条件。若 finding 被裁剪到无法正确解释，应整体省略并保留按 ID 查询的入口。

## 4. 注入格式示例

~~~text
## Finding Ledger：当前任务相关发现

### 当前有证据支持
- [F-123 | supported | applicable]
  结论：探针 A 不支持 off-by-one 是主要原因。
  依据：实验 run-4472；shift -1/0/+1 的指标近似。
  范围：commit 0862527，配置 config-A。
  细节：query finding F-123。

### 已排除路径
- [F-124 | refuted | applicable]
  路径：当前条件下不再优先排查 tokenizer shift。
  反证：4 个探针结果未支持该假设。
  注意：结论仅限于上述版本与配置。

### 用户约束
- [F-125 | not_applicable | applicable]
  本轮实验只能使用 GPU 0–3。
~~~

上述 ID 和实验值只用于展示格式，不代表本项目已验证的数据。

## 5. 查询默认值

- 当前项目是默认范围，但必须以稳定 project_id 解析。
- 普通查询默认 lifecycle_state=current。
- 不应默认只查询 supported，因为 provisional、contested 和 refuted 可能是当前任务的重要上下文。
- 历史 superseded 记录需通过 include_history 或明确的历史查询参数获取。
- 结果返回 finding ID、短文本、状态、scope 摘要和 evidence 数量；完整证据由 get_finding 再取。
- 查询结果必须区分“不存在”“权限/项目范围过滤”“适用性未知”，避免让 Agent 将检索不到理解为结论不存在。

## 6. 故障回退

若数据库读取失败、项目身份不确定或当前上下文无法获取：
- 不阻塞用户的主要工程任务；
- 不注入未经确认的历史结论；
- 通过宿主支持的方式报告记忆检索未成功；
- 允许显式 query/find 或本地诊断；
- 写操作失败时明确返回失败，不声称已保存。

## 7. 检索层验收

至少覆盖：
- 当前适用的 supported finding 能被检索；
- refuted 路径不会被错误地当成支持结论；
- scope 不匹配的旧结论不会作为当前事实注入；
- superseded 记录默认只以必要的关系摘要出现；
- token 超限时不丢失状态与关键适用条件；
- 项目边界和检索故障的回退行为可预测。
