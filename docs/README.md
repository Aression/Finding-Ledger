# Finding Ledger 设计文档

本文档集定义 Finding Ledger 的目标行为、数据模型与实施边界。当前仓库仍处于概念设计阶段；除非某项能力在代码中实现并通过测试，不应把文档描述当作已交付功能。

## 文档地图

| 文档 | 回答的问题 |
|---|---|
| [01 产品目标与用户故事](design/01-product-and-requirements.md) | 为谁解决什么问题，如何判断功能有用 |
| [02 领域模型](design/02-domain-model.md) | finding、evidence、scope、关系之间的语义边界 |
| [03 数据模型与迁移](design/03-storage-schema-and-migration.md) | SQLite 表结构、约束和旧模型迁移 |
| [04 证据与状态机](design/04-evidence-state-and-lifecycle.md) | 结论如何获得支持、反证、取代和恢复 |
| [05 检索与压缩恢复](design/05-retrieval-and-compaction.md) | 何时检索、如何判断适用性、如何控制注入预算 |
| [06 工具 API](design/06-tool-api.md) | Agent 如何创建、查询、纠正和关联发现 |
| [07 安全、评测与路线图](design/07-security-evaluation-roadmap.md) | 风险边界、测试指标和分阶段交付 |

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

建议按边界分层：

- **工具接口层：** 将模型意图转换为明确、可验证的操作参数。
- **应用服务层：** 执行状态转换、证据关联、去重和事务约束。
- **存储层：** 保存结论、证据、关系与事件，不承担模型推理。
- **检索层：** 根据项目、适用范围、任务相关性和 token 预算选择候选记录。
- **宿主适配层：** 订阅会话开始、上下文压缩完成等实际可用事件，并将结果注入上下文。

## 核心架构决策

1. **epistemic_state 与 lifecycle_state 分离。** refuted 是认知状态；superseded 是生命周期状态。它们不可放在一个枚举中。
2. **证据是独立实体。** evidence 表示来源，finding_evidence 表示某份证据对某项结论的作用。同一来源可复用。
3. **范围先于排序。** 不适用的结论不应因“已验证”而进入当前事实集。
4. **反证与取代的呈现不同。** 反证结论可作为已排除路径注入；被取代版本默认只在解释演化历史时呈现。
5. **状态变更必须留痕。** 认知状态、生命周期或适用范围变更需要写入事件日志。
6. **第一版采用确定性筛选。** 先使用项目、scope、状态、标签与关键词；只有评测证明必要时再加入 embedding 检索。

## 术语速查

- **Finding：** 一项可独立理解的发现、解释、约束、决策或操作方法。
- **Evidence：** 可定位、可追溯的证据来源。
- **Epistemic state：** 当前证据对 finding 的支持情况。
- **Lifecycle state：** finding 是否为当前记录版本。
- **Scope：** finding 可以直接复用的条件。
- **Injection：** 将选定的 findings 编排进 Agent 当前上下文。

## 版本与实现原则

文档中的 schema 和 API 是 V1 设计基线，可以在实现时通过 PR 修订。任何修改都应保持语义边界明确、迁移可执行并补上测试。不要为了让模型更方便填写而引入无法校验的字段，也不要把推断出来的状态伪装为实验事实。
