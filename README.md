## Finding Ledger:实证结论账本

### 核心定位

**不是文档系统(timeline.md 管归因),不是规则系统(AGENTS.md 管流程),而是"会话中通过实验/排查/验证得出的结论"的持久账本。**

一句话:模型每次得出"我们验证了X""排除了Y""根因是Z",立即记一条;压缩后自动注入回上下文。

### 证据强度分级(核心)

| 强度 | 含义 | 注入策略 | 你的会话里的例子 |
|---|---|---|---|
| `verified` | 实验验证,有数据支撑 | **必注入** | "4 探针排除 off-by-1,shift 匹配率<15%" |
| `confirmed` | 代码阅读确认,有文件/行号 | **必注入** | "PolicyLossRegistry.get 在 FSDP worker 中执行" |
| `user-confirmed` | 用户明确确认 | **必注入** | "GPU 只用 0-3""子模块不能改" |
| `suspected` | 有线索,未充分验证 | 摘要注入 | "可能是 LoRA 同步路径不等价" |
| `hypothesized` | 假设,待验证 | 不主动注入 | "可能是温度不匹配" |
| **`refuted`** | **已推翻** | **必注入(防重走)** | "20× 膨胀是指标定义假象(已排除,非真实问题)" |
| **`superseded`** | **被新结论取代** | **必注入(指向新)** | "correction≈0→SC 退化(被取代:实际是 recompute 使 q≡p)" |

> `refuted` 和 `superseded` **也要注入** —— 这正是你的核心诉求:防止模型重走已排除的路径。

### 数据模型(SQLite)

```sql
-- findings: 实证发现
CREATE TABLE findings (
  id            TEXT PRIMARY KEY,           -- UUID
  project       TEXT NOT NULL,              -- 项目路径(cwd),核心索引
  conclusion    TEXT NOT NULL,              -- 结论(一句话)
  evidence_type TEXT NOT NULL,              -- verified|confirmed|user-confirmed|suspected|hypothesized|refuted|superseded
  evidence_detail TEXT,                     -- 怎么验证的(1-2句)
  status        TEXT DEFAULT 'active',      -- active|refuted|superseded
  superseded_by TEXT,                       -- 被哪个 finding 取代
  tags          TEXT,                        -- JSON: [bug, root-cause, excluded, architecture, performance, stability]
  session_id    TEXT,                       -- 创建会话
  created_seq   INTEGER,                    -- 创建时 seq(可回溯)
  created_at    TEXT,                       -- ISO 时间
  promoted_to_rule INTEGER DEFAULT 0,       -- 是否已沉淀为 AGENTS.md 规则
  FOREIGN KEY (superseded_by) REFERENCES findings(id)
);

-- evidence: 证据来源(一个 finding 多个证据)
CREATE TABLE evidence (
  id          TEXT PRIMARY KEY,
  finding_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,                -- experiment|code-read|user-confirm|log|git-commit|file|doc
  ref         TEXT NOT NULL,                -- 来源: seq:123 / file:sc_worker_hook.py:262 / commit:0862527 / log:sc_p0b_200
  detail      TEXT,                         -- 证据详情
  supports    INTEGER DEFAULT 1,           -- 1=支撑, 0=反驳
  FOREIGN KEY (finding_id) REFERENCES findings(id) ON DELETE CASCADE
);

-- doc_links: 连接到工作文档
CREATE TABLE doc_links (
  finding_id  TEXT NOT NULL,
  doc_path    TEXT NOT NULL,               -- 相对路径: timeline.md / AGENTS.md / docs/xxx.md
  anchor      TEXT,                         -- 锚点: 行号 / 段落标题 / wikilink
  link_type   TEXT,                         -- attribution(归因) | rule-source(规则来源) | supporting-doc(支撑文档)
  FOREIGN KEY (finding_id) REFERENCES findings(id) ON DELETE CASCADE
);

-- resources: 资源索引
CREATE TABLE resources (
  finding_id    TEXT NOT NULL,
  resource_type TEXT NOT NULL,             -- git-commit | file | log | screenshot | url | remote-path
  path          TEXT NOT NULL,             -- 路径/URL/commit hash
  description   TEXT,
  FOREIGN KEY (finding_id) REFERENCES findings(id) ON DELETE CASCADE
);

CREATE INDEX idx_findings_project_status ON findings(project, status);
CREATE INDEX idx_findings_project_type ON findings(project, evidence_type);
CREATE INDEX idx_evidence_finding ON evidence(finding_id);
```

### 工具设计(CRUD)

| 工具 | 作用 | 关键参数 |
|---|---|---|
| **`log_finding`** | 创建实证发现 | conclusion(必填), evidence_type(必填), evidence_detail, tags, supporting_refs[], doc_links[], resources[] |
| **`query_findings`** | 查询发现 | project(默认当前cwd), status(默认active), evidence_type, tags[], keyword, limit(默认20) |
| **`update_finding`** | 更新(强度变化/追加证据) | id, new_evidence_type, append_evidence[], new_tags[] |
| **`refute_finding`** | 推翻 | id, refutation(推翻理由), refutation_refs[] |
| **`supersede_finding`** | 取代(旧→新) | old_id, new_conclusion, reason, ...新finding参数 |
| **`promote_to_rule`** | 提议沉淀为AGENTS.md规则 | id, rule_text, target_doc(默认AGENTS.md) |
| **`link_finding`** | 连接到工作文档 | id, doc_path, anchor, link_type |

### `log_finding` 参数示例

```
log_finding(
  conclusion: "P0-B 不是 off-by-1 位移错位,4 探针已排除",
  evidence_type: "verified",
  evidence_detail: "shift -1/0/+1 的 mean_abs_diff 几乎相等(42.49/42.29/42.46),ROOT_CAUSE 探针 argmax 匹配仅 5.6%,SHIFT_VERIFY 所有 shift 匹配率<15%",
  tags: ["excluded", "root-cause", "p0-b"],
  supporting_refs: [
    {kind: "experiment", ref: "seq:4472", detail: "4 探针注入 score_centering_loss"},
    {kind: "file", ref: "sc_worker_hook.py:262", detail: "探针注入点"}
  ],
  doc_links: [
    {doc_path: "docs/2026-10-17_P0-B假设验证与根因定位报告.md", anchor: "§四 SHIFT_VERIFY"}
  ],
  resources: [
    {type: "git-commit", path: "0862527", description: "探针注入 commit"}
  ]
)
```

### 自动注入机制

监听 `session/event`,当 `event.type === 'compaction/end'` 时:

1. 读取当前 cwd 的 findings:`status = 'active'` AND `evidence_type IN ('verified','confirmed','user-confirmed','refuted','superseded')`
2. 按强度排序:verified > confirmed > user-confirmed > refuted > superseded
3. 通过 `system-prompt/assemble` waterfall 注入一个 prompt section:

```
## 实证结论账本(压缩后恢复)

你刚经历过压缩。以下是你本项目中已验证/已排除的实证发现,
不要重新排查已验证的结论,不要重走已排除的路径:

### 已验证(verified)
• [verified] P0-B 不是 off-by-1 位移(4 探针排除,匹配率<15%) → 根因是 vLLM colocate 权重不同步
• [verified] 20× 膨胀是指标定义假象(mean vs max reduction) → 非真实问题

### 已排除(refuted / superseded)
• [refuted] correction≈0 = SC 退化 ← 已推翻:实际是 recompute 使 q≡p,correction 恒为 0 是正确行为
• [refuted] entropy 爆炸 = SC 算法缺陷 ← 已推翻:根因是实现 bug(P0-B 位移),修复后 entropy 恢复 42×

### 用户确认的约束
• [user-confirmed] GPU 只用 0-3
• [user-confirmed] 只能改 patch,不能动 codebase

查询更多: query_findings(project="当前cwd")
```

### 其他功能

| 功能 | 说明 |
|---|---|
| **跨会话查询** | 新会话开始时,`query_findings(project=cwd)` 可查历史所有 findings |
| **supersede 链** | A→B→C 取代链可追溯一个结论的演进 |
| **refute 留痕** | refuted 不删除,保留!防止模型重走(注入时明确标注"已排除") |
| **promote_to_rule** | verified 的 finding 可提议沉淀为 AGENTS.md 规则(半自动:模型提议,用户确认) |
| **项目隔离** | 按 cwd 索引,不同项目(findings.db 单文件,可放 `$DSH_HOME/findings.db`) |
