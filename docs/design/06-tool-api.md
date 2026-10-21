# Finding Ledger 工具 API 契约

本文定义 Agent 与 ledger 交互的逻辑 API。它可以映射到宿主的 MCP 工具或其他插件工具，但不绑定未确认的具体 SDK。所有写操作都由应用服务验证并落库；工具返回成功前必须确认事务已经提交。

## 1. API 原则

- 工具名表达有明确业务语义的操作，而非只暴露通用 CRUD。
- 证据写入、认知状态变更和生命周期关系变更分别处理。
- 改变主张含义时创建新 finding；不要用 update 覆盖历史含义。
- 错误输入返回可操作的错误，不应静默纠正为另一个状态。
- 状态变更操作需要 reason；反证或 supported 状态应关联相应证据，除非使用显式且可审计的人工例外。
- 写操作在 SQLite 事务中完成。宿主若支持 retry，应设计幂等行为。

## 2. 核心工具列表

| 工具 | 用途 | 是否改变数据 |
|---|---|---|
| log_finding | 新建 finding，可同时添加初始证据关联 | 是 |
| query_findings | 按项目、关键词、标签、状态与适用范围检索 | 否 |
| get_finding | 读取单条 finding、完整证据和关系 | 否 |
| add_evidence | 新增证据来源并关联到已有 finding | 是 |
| set_finding_state | 在允许的状态转换内变更认知状态 | 是 |
| refute_finding | 将 finding 标记为 refuted 并关联反证依据 | 是 |
| supersede_finding | 新建替代 finding 并关闭旧记录的当前生命周期 | 是 |
| revalidate_finding | 追加重新验证证据、更新时间与状态 | 是 |
| link_finding | 关联项目文档或规则来源 | 是 |
| propose_rule | 提议将 finding 沉淀为项目规则 | 是，提议阶段 |

工具数量可随实现合并，但语义边界应保留。例如，refute_finding 可以内部调用通用状态服务，却不应只是一个没有证据验证的 set_state 别名。

## 3. 关键参数约定

### log_finding

输入建议：

~~~json
{
  "project": "current",
  "claim_kind": "diagnosis",
  "statement": "当前探针结果不支持 off-by-one 是该差异的主因",
  "details": "shift -1/0/+1 的指标近似，尚需其他来源佐证",
  "epistemic_state": "provisional",
  "scope": {
    "match": {
      "runtime.backend": "vLLM"
    },
    "context": {
      "commit": "0862527"
    },
    "revalidate_on": ["code_change", "config_change"]
  },
  "tags": ["excluded-candidate", "debugging"],
  "retrieval_policy": "relevant",
  "evidence": [
    {
      "source_kind": "experiment_run",
      "source_ref": "run:4472",
      "locator": "probe:shift-verify",
      "revision": "0862527",
      "excerpt": "shift -1/0/+1 的均值指标近似",
      "relation": "supports",
      "method": "experiment",
      "rationale": "当前结果没有显示明显的 shift 差异"
    }
  ]
}
~~~

规范：
- 默认 epistemic_state 为 unassessed，而非 supported。
- statement、claim_kind 是必填字段。
- 如果选择 supported，应有可验证的支持证据关联；用户陈述不能被误认为独立的实验验证。
- 若 evidence 提交失败，整个 log_finding 不应留下只有半条证据关系的记录。
- 返回 finding ID、最终状态、证据数量和需补充信息。

### query_findings

输入建议：
- project：默认当前项目；
- keyword、tags：可选；
- epistemic_state、lifecycle_state：可选过滤；
- task_context / scope_context：当前任务与环境；
- include_history：是否包含 superseded、withdrawn 或 archived 记录；
- limit：默认 20，需设置上限。

查询返回适用性结果，如 applicable、conditional、needs_revalidation、incompatible 或 unknown。它们是检索时计算的结果，不写入 epistemic_state。

### get_finding

以 ID 查询单条记录，返回：
- finding 本体与所有状态；
- scope 和最近验证时间；
- 证据来源与 finding_evidence 关系；
- 相关 findings 及其关系；
- 最近的关键 finding_events；
- 文档链接。

默认返回短证据摘要；完整 excerpt 或更多事件可通过参数显式请求。

### add_evidence

输入为 finding ID、证据对象和 relation。若同一个 source_ref 已存在，应用服务可以复用 evidence ID，但必须核对 source_kind、revision 与内容摘要，不能仅按 URL 无条件合并。新增 contradicts 证据后不自动反证 finding；需要状态评估步骤，以防单条弱证据直接覆盖已有判断。

### set_finding_state

输入包含 finding ID、目标 epistemic_state、reason 和可选 evidence IDs。应用层检查状态转换；supported 需要支持依据，refuted 应优先使用 refute_finding，涉及 contested 时应能呈现冲突证据。

### refute_finding

输入包含 finding ID、refutation reason 和一条或多条反证。事务内写入证据关联、变更 epistemic_state 并追加事件。不删除记录，也不自动把 lifecycle_state 设置成 archived。

### supersede_finding

输入包含旧 finding ID、新 finding 的 statement / kind / scope / evidence，以及 reason。服务端在一个事务内创建新记录，建立 from=new、relation=supersedes、to=old 的关系，并将旧记录标记 superseded。若创建中任一步失败，整笔操作回滚。

### revalidate_finding

输入包含 finding ID、当前 scope context、最新证据与 revalidation result。结果可以是仍支持、反证、冲突或证据不足。若结论主张未变化，更新现有记录和最近验证时间；若主张或范围发生实质变化，则创建新 finding 并连接关系。

### propose_rule

输入包含 finding ID、建议规则文本、目标文档路径和理由。该工具只创建 proposed 状态，实际文件变更必须由经过授权的流程在用户批准后执行，并将最终状态记录为 applied 或 rejected。

## 4. 通用响应结构

建议统一返回：

~~~json
{
  "ok": true,
  "data": {
    "finding_id": "F-123"
  },
  "warnings": [
    "scope 未包含代码版本；其他版本需要重新验证"
  ],
  "error": null
}
~~~

失败时 ok=false，并返回稳定的错误码：
- INVALID_ARGUMENT；
- NOT_FOUND；
- PROJECT_SCOPE_MISMATCH；
- INVALID_STATE_TRANSITION；
- EVIDENCE_REQUIRED；
- RELATION_CYCLE；
- CONCURRENT_MODIFICATION；
- STORAGE_ERROR。

错误消息可包含定位建议，但不应把内部路径、敏感 excerpt 或未授权项目数据泄露给当前 Agent。

## 5. 幂等性与并发

- 所有记录生成稳定 ID；外部重试需避免生成重复 finding。
- 对 supersede、refute、state change 使用事务。
- 可通过 request_id 或调用方提供的 idempotency_key 处理重试；若 V1 不实现，必须在工具文档明确说明重试可能创建重复内容，并提供去重策略。
- update 类操作建议携带 expected_updated_at 或版本号，避免两个会话互相覆盖状态。
- 冲突时重新读取记录并重试业务判断，不可强制覆盖。

## 6. 工具不应做的事

- 不允许模型仅通过一次自然语言描述就自动把 provisional 升级为 supported。
- 不允许 update_finding 静默改写核心 statement 而不保留事件或取代关系。
- 不允许 refute_finding 删除原结论。
- 不允许 supersede_finding 在两次独立写入中留下半完成关系。
- 不允许 query_findings 将不可适用的记录伪装成当前有效事实。
- 不允许 propose_rule 绕过用户批准直接修改项目规则文件。
