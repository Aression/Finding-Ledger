# Finding Ledger 设计总览

本文档集定义 Finding Ledger 的目标行为、核心数据模型、接口与验收标准。当前内容是设计契约；实现状态应以实际代码和测试为准。

## 文档索引

| 文档 | 范围 |
|---|---|
| [01 产品目标与用户故事](design/01-product-and-requirements.md) | 产品目标、用户故事、验收标准和成功指标 |
| [02 领域模型](design/02-domain-model.md) | finding、evidence、scope 和关系的语义边界 |
| [03 SQLite 数据模型](design/03-storage-schema.md) | 表结构、索引、约束和事务边界 |
| [04 证据与状态机](design/04-evidence-state-and-lifecycle.md) | 证据关系、状态变更、反证与取代 |
| [05 检索与上下文恢复](design/05-retrieval-and-compaction.md) | 适用性判定、检索排序、预算和注入 |
| [06 工具 API](design/06-tool-api.md) | 创建、查询、纠错、重新验证和规则提议 |
| [07 安全、评测与路线图](design/07-security-evaluation-roadmap.md) | 风险、测试、效果指标和交付顺序 |

## 总体架构

~~~text
Agent / Harness events
        |
        v
Finding tools -----> Application service / validation
        |                        |
        |                        v
        |                 SQLite repository
        |                        |
        v                        v
Task context --------> Retrieval & scope matcher
                                 |
                                 v
                       Budgeted prompt section
                                 |
                                 v
                         Agent continuation
~~~

架构划分：

- **工具接口层：** 将模型意图转化为可验证的业务操作。
- **应用服务层：** 执行输入校验、状态机规则、事务和审计。
- **存储层：** 保存 findings、evidence、关系和事件。
- **检索层：** 根据项目、适用范围、任务相关性和 token 预算选择记录。
- **宿主适配层：** 接收会话事件并将检索结果注入上下文。

## 核心设计决策

1. epistemic_state、lifecycle_state 和当前 scope 适用性是三个独立判断。
2. Evidence 是可复用的来源对象；finding_evidence 记录它对某条主张的作用。
3. 检索先判定项目隔离与适用性，再计算任务相关性和优先级。
4. 被反证的 finding 可以继续作为已排除路径；被取代的 finding 默认仅作为历史引用。
5. 状态、适用范围和关系的关键变更必须留有理由与事件记录。
6. 首期采用可解释的确定性检索规则，依据评测结果再决定是否引入语义检索。

## 术语

- **Finding：** 可独立理解的工程发现、解释、约束、决策或操作方法。
- **Evidence：** 可定位、可追溯的来源对象。
- **Epistemic state：** 当前证据对 finding 的支持情况。
- **Lifecycle state：** finding 在账本中的生命周期位置。
- **Scope：** finding 可以直接应用的条件。
- **Injection：** 将筛选后的 findings 组织成当前 Agent 上下文的一部分。

## 实施约束

任何实现均应保持语义边界清晰、状态转换可验证、写操作具备事务一致性，并由测试覆盖正常路径与拒绝路径。模型生成的描述不能替代应用层校验；证据不足时应保留不确定性。
