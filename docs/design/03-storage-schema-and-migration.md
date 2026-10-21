# SQLite 数据模型与迁移方案

本文定义 V1 的建议存储结构。它是实现目标，不表示现有仓库已经包含相应代码。所有创建、状态变更和关系维护应由应用服务完成，并在必要时使用同一 SQLite 事务。

## 1. 设计约束

- 使用稳定 ID；记录 ID 不应依赖文件路径、会话序号或模型生成文本。
- Finding、Evidence 和两者之间的证据关系分别存储。
- 认知状态与生命周期分列。
- 主张的含义被修改时，优先创建新 finding 并建立关系，不对历史主张做无痕重写。
- 所有时间使用 UTC ISO 8601，统一由应用层生成。
- SQLite 的外键必须启用；应用层负责 JSON 校验、状态迁移和审计事件。
- 首版不强依赖 FTS、向量扩展或外部数据库。

## 2. 建议 DDL

~~~sql
PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
    version     INTEGER PRIMARY KEY,
    checksum    TEXT NOT NULL,
    applied_at  TEXT NOT NULL
);

CREATE TABLE projects (
    id              TEXT PRIMARY KEY,
    identity_key    TEXT NOT NULL UNIQUE,
    display_name    TEXT NOT NULL,
    git_remote      TEXT,
    root_path_hint  TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE findings (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT REFERENCES projects(id)
                            ON DELETE RESTRICT,
    claim_kind          TEXT NOT NULL CHECK (
        claim_kind IN (
            'observation', 'diagnosis', 'constraint',
            'decision', 'procedure'
        )
    ),
    statement           TEXT NOT NULL,
    details             TEXT,
    epistemic_state     TEXT NOT NULL DEFAULT 'unassessed'
                            CHECK (epistemic_state IN (
                                'unassessed', 'provisional',
                                'supported', 'contested',
                                'refuted', 'inconclusive',
                                'not_applicable'
                            )),
    lifecycle_state     TEXT NOT NULL DEFAULT 'current'
                            CHECK (lifecycle_state IN (
                                'current', 'superseded',
                                'withdrawn', 'archived'
                            )),
    scope_json          TEXT NOT NULL DEFAULT '{}',
    tags_json           TEXT NOT NULL DEFAULT '[]',
    retrieval_policy    TEXT NOT NULL DEFAULT 'relevant'
                            CHECK (retrieval_policy IN (
                                'always', 'relevant',
                                'on_demand', 'never'
                            )),
    created_session_id  TEXT,
    created_seq         INTEGER,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    last_validated_at   TEXT
);

CREATE TABLE evidence (
    id              TEXT PRIMARY KEY,
    source_kind     TEXT NOT NULL CHECK (source_kind IN (
        'session_message', 'file', 'log', 'experiment_run',
        'git_commit', 'url', 'user_statement',
        'test_result', 'document', 'screenshot',
        'remote_path', 'other'
    )),
    source_ref      TEXT NOT NULL,
    locator         TEXT,
    revision        TEXT,
    excerpt         TEXT,
    content_hash    TEXT,
    captured_at     TEXT,
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL
);

CREATE TABLE finding_evidence (
    finding_id      TEXT NOT NULL REFERENCES findings(id)
                        ON DELETE RESTRICT,
    evidence_id     TEXT NOT NULL REFERENCES evidence(id)
                        ON DELETE RESTRICT,
    relation        TEXT NOT NULL CHECK (
        relation IN ('supports', 'contradicts', 'context')
    ),
    method          TEXT CHECK (
        method IS NULL OR method IN (
            'experiment', 'code_inspection',
            'runtime_observation', 'user_assertion',
            'external_reference', 'manual_review', 'other'
        )
    ),
    rationale       TEXT,
    created_at      TEXT NOT NULL,
    PRIMARY KEY (finding_id, evidence_id, relation)
);

CREATE TABLE finding_relations (
    from_finding_id TEXT NOT NULL REFERENCES findings(id)
                        ON DELETE RESTRICT,
    relation        TEXT NOT NULL CHECK (
        relation IN (
            'supersedes', 'derived_from',
            'contradicts', 'duplicate_of', 'related_to'
        )
    ),
    to_finding_id   TEXT NOT NULL REFERENCES findings(id)
                        ON DELETE RESTRICT,
    reason          TEXT,
    created_at      TEXT NOT NULL,
    PRIMARY KEY (from_finding_id, relation, to_finding_id),
    CHECK (from_finding_id <> to_finding_id)
);

CREATE TABLE finding_events (
    id              TEXT PRIMARY KEY,
    finding_id      TEXT NOT NULL REFERENCES findings(id)
                        ON DELETE RESTRICT,
    event_type      TEXT NOT NULL,
    actor_type      TEXT NOT NULL CHECK (
        actor_type IN ('user', 'agent', 'system')
    ),
    before_json     TEXT,
    after_json      TEXT,
    reason          TEXT,
    session_id      TEXT,
    seq             INTEGER,
    created_at      TEXT NOT NULL
);

CREATE TABLE doc_links (
    id              TEXT PRIMARY KEY,
    finding_id      TEXT NOT NULL REFERENCES findings(id)
                        ON DELETE RESTRICT,
    doc_path        TEXT NOT NULL,
    anchor          TEXT,
    link_type       TEXT NOT NULL CHECK (
        link_type IN (
            'attribution', 'rule_source', 'supporting_doc'
        )
    ),
    promotion_state TEXT NOT NULL DEFAULT 'not_applicable'
                        CHECK (promotion_state IN (
                            'not_applicable', 'proposed',
                            'approved', 'rejected', 'applied'
                        )),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (finding_id, doc_path, anchor, link_type)
);

CREATE INDEX idx_findings_project_lifecycle
    ON findings(project_id, lifecycle_state);

CREATE INDEX idx_findings_project_epistemic
    ON findings(project_id, epistemic_state);

CREATE INDEX idx_findings_project_updated
    ON findings(project_id, updated_at);

CREATE INDEX idx_evidence_source
    ON evidence(source_kind, source_ref);

CREATE INDEX idx_finding_evidence_reverse
    ON finding_evidence(evidence_id, relation);

CREATE INDEX idx_relations_target
    ON finding_relations(to_finding_id, relation);

CREATE INDEX idx_doc_links_finding
    ON doc_links(finding_id, link_type);
~~~

## 3. 表职责与关键约束

### projects
identity_key 是项目隔离主键。优先使用规范化后的 Git remote；对于无 remote 的项目，使用规范化路径作为回退。root_path_hint 只是提示，不应作为唯一身份依据。不要默认把本地绝对路径注入给模型或同步到远端。

### findings
statement 应简洁、可单独理解；details 用于补充上下文。scope_json 的结构约定见领域模型与检索文档。tags_json 只承载轻量标签，不替代结构化字段。

应用层应校验 state 与 claim_kind 的组合。例如 constraint 或 decision 通常使用 not_applicable；若把诊断标记为 supported，应存在支持证据或明确的、可审计的例外政策。SQLite CHECK 不足以表达跨表条件，所以这类约束必须由服务层验证。

### evidence 与 finding_evidence
evidence 描述源材料本身。finding_evidence 描述证据对某条结论的作用及其取得/分析方法。同一个来源可与多条 findings 关联，且对不同结论可以有不同 relation。

source_ref 是定位符，不一定是 URL。对于代码，建议保存仓库身份、commit、路径和行号；对于实验，建议保存 run ID、配置、代码版本和结果工件位置；对于会话，使用稳定 session ID 与序号。source_ref 不应是唯一能判断证据内容的字段。

### finding_relations
supersedes 的方向固定为“新结论指向旧结论”。关系插入和旧记录 lifecycle_state 更新必须在同一事务完成。V1 暂不要求复杂图算法，但禁止自指；应用层应检测 supersedes 环。

### finding_events
事件表记录影响后续推理的关键变化，不要求成为完整的事件溯源系统。对状态、scope、关系、关键证据集合的变化必须记事件；普通只读查询无需记录。

### doc_links
该表只管理 finding 与工作文档/规则的关联。资源路径和日志源应进入 evidence，不再单独维护 resources 表。promotion_state 用于区分提议、批准和落地，避免用一个 promoted_to_rule 布尔值表达多个阶段。

## 4. JSON 约定

scope_json 建议遵循以下形状：

~~~json
{
  "match": {
    "task": "Spider text-to-SQL",
    "runtime.backend": "vLLM",
    "runtime.dtype": "bf16"
  },
  "context": {
    "branch": "main",
    "commit": "0862527"
  },
  "revalidate_on": [
    "code_change",
    "config_change",
    "runtime_change"
  ]
}
~~~

- match 表示判断直接适用性所需的条件。
- context 表示结论形成时的追溯背景，不自动构成硬约束。
- revalidate_on 表示需要重新验证的变更类别。

上述示例仅演示结构，不代表任何实际实验结论。应用层必须校验 JSON，并定义缺失字段、未知字段和不支持的匹配条件如何处理。

## 5. 旧 schema 迁移

旧版本含有 findings.evidence_type、findings.status、superseded_by、evidence.kind/ref/supports、resources 和 promoted_to_rule。建议通过版本化迁移脚本转换，不要手工直接改数据库。

| 旧值/字段 | 新模型转换 |
|---|---|
| conclusion | statement |
| project 路径 | 查询或创建 projects，再写入 project_id；保留 root_path_hint |
| evidence_type=verified | 有实验结果及有效引用时可映射 supported；证据缺失时转 provisional 或 unassessed，并标记待审查 |
| evidence_type=confirmed | 若有可定位的代码证据，可映射 supported；只有文字说明时应进入待审查队列 |
| evidence_type=user-confirmed | 迁移为 user_statement 来源证据；约束/决策类可使用 not_applicable，实证性主张不能仅凭该值自动成为 supported |
| evidence_type=suspected/hypothesized | 通常映射 provisional |
| evidence_type=refuted | epistemic_state=refuted；生命周期仍需根据旧 status 判断 |
| evidence_type=superseded 或 status=superseded | lifecycle_state=superseded；能定位替代记录时创建 supersedes 关系 |
| status=refuted | epistemic_state 至少需要人工核对；保留原始值并记录迁移决策 |
| status=active | lifecycle_state=current |
| superseded_by | 创建“新 finding → 旧 finding”的 supersedes 关系，校验目标存在 |
| evidence.supports=1/0 | 分别转换为 supports/contradicts |
| resources | 转换为 evidence，原始 path 进入 source_ref，description 进入 excerpt 或 metadata |
| promoted_to_rule=1 | 若能找到具体文档，迁移到 doc_links；无法定位目标时标记待审查，不猜测落地状态 |

当旧 evidence_type 与 status 矛盾时，例如 evidence_type=verified 但 status=refuted，不能用其中一列静默覆盖另一列。迁移器应保存原值、写入迁移事件，并将该记录放入人工核对队列。

## 6. 迁移执行顺序

1. 备份数据库并记录 schema 版本与行数。
2. 创建新表，不删除旧表。
3. 建立 projects 映射，再迁移 findings。
4. 迁移 evidence 与资源记录，并重建关联关系。
5. 重建 supersedes 关系，检查缺失目标、自环和环路。
6. 对冲突状态和缺失证据的记录生成审查报告。
7. 对项目隔离、外键、计数和抽样内容执行校验。
8. 通过后再切换读写路径；保留可回滚备份。

迁移必须幂等或有明确版本检查。schema_migrations 记录脚本版本与 checksum，避免同一迁移被重复执行。
