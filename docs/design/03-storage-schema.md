# SQLite 数据模型

本文定义 Finding Ledger 的目标数据库结构。数据层负责保存主张、来源、关联关系与审计事件；状态校验、适用性判断和检索策略由应用服务负责。

## 1. 数据模型原则

- 使用稳定 ID，避免以文本内容、路径或会话序号作为主键。
- 分开存储 finding、evidence 和两者的关系。
- 将认知状态与生命周期分开。
- 资源定位符归入 evidence，工作文档关联归入 doc_links。
- 关键状态变化与关系操作必须在事务内写入事件。
- 外键开启，时间戳统一使用 UTC ISO 8601。
- JSON 字段由应用层验证；未知或不支持的 scope 条件不得默认匹配。

## 2. DDL

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

## 3. 表职责

### projects

identity_key 是项目隔离主键。优先使用规范化 Git remote；没有 remote 时可使用规范化本地路径作为项目身份。root_path_hint 仅用于定位，不承担唯一身份职责。

### findings

- claim_kind 描述内容性质：observation、diagnosis、constraint、decision 或 procedure。
- epistemic_state 描述证据状态。
- lifecycle_state 描述记录生命周期。
- scope_json 描述适用条件。
- retrieval_policy 描述自动检索策略。

应用层应检查跨字段约束。例如，诊断标记为 supported 时必须有关联的支持证据；约束和操作方法可以使用 not_applicable。SQL CHECK 无法检查跨表证据条件，因此必须由服务层验证。

### evidence

source_ref 是定位符，可以是会话序号、代码位置、commit、实验 run ID、日志 ID 或 URL。来源类型并不自动决定证据可靠性。可获得时，应记录 revision 和 content_hash，以识别来源变化。

### finding_evidence

该表将证据关联到具体主张，并指定支持、反驳或补充关系。一个来源可以关联多条 findings，对不同 finding 的作用也可以不同。

### finding_relations

supersedes 方向固定为“新 finding 指向被取代的 finding”。应用层必须拒绝自指和取代环。关系插入、被取代记录的生命周期更新和事件写入必须处于同一事务。

### finding_events

用于追踪会影响后续推理的关键变化，包括创建、证据添加、状态变更、scope 变更、关系创建、重新验证和规则沉淀状态改变。无需记录每次只读查询。

### doc_links

只负责 finding 与工作文档之间的关联。promotion_state 明确区分提议、批准、拒绝和落地完成，避免用单一布尔值描述整个流程。

## 4. Scope JSON 约定

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

- match 是判断直接适用性所需的条件。
- context 是结论产生时的背景，用于追溯，不自动构成硬约束。
- revalidate_on 描述哪些变化会触发重新验证。

这个 JSON 只是结构示例。应用服务必须定义字段比较、缺失值和未知条件的行为；条件不明时不得默认判定为 applicable。

## 5. 应用层一致性要求

1. 写入 finding、关联初始证据和创建事件时应保持原子性。
2. supported 需要支持证据，或经过定义且可审计的例外策略。
3. refuted 应记录反证理由，不能仅修改状态字段。
4. supersede_finding 必须在一个事务中创建新记录、关联关系、更新生命周期并记录事件。
5. 任何关键状态变更都应写入 finding_events，包含 actor、理由和必要的 before/after 摘要。
6. 物理删除不是默认的纠错方式；撤回、反证和归档应保留审计信息。隐私清理需要通过受控删除流程单独处理。
7. schema_migrations 用于追踪当前应用版本所需的数据库 schema 版本、校验和及执行时间。
