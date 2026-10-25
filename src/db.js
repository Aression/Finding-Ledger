/**
 * SQLite storage: connection, PRAGMAs, versioned migrations.
 *
 * Node 24 ships SQLite in core through `node:sqlite`, so the plugin has zero
 * native compilation steps — a user installs a plain ESM package and it works.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { storageError } from './errors.js';

/** UTC ISO 8601, the single timestamp format stored in the database. */
export const nowIso = () => new Date().toISOString();

export const EPISTEMIC_STATES = Object.freeze([
  'unassessed',
  'provisional',
  'supported',
  'contested',
  'refuted',
  'inconclusive',
  'not_applicable',
]);

export const LIFECYCLE_STATES = Object.freeze(['current', 'superseded', 'withdrawn', 'archived']);

export const CLAIM_KINDS = Object.freeze(['observation', 'diagnosis', 'constraint', 'decision', 'procedure']);

export const RETRIEVAL_POLICIES = Object.freeze(['always', 'relevant', 'on_demand', 'never']);

export const SOURCE_KINDS = Object.freeze([
  'session_message',
  'file',
  'log',
  'experiment_run',
  'git_commit',
  'url',
  'user_statement',
  'test_result',
  'document',
  'screenshot',
  'remote_path',
  'other',
]);

export const EVIDENCE_RELATIONS = Object.freeze(['supports', 'contradicts', 'context']);

export const FINDING_RELATIONS = Object.freeze([
  'supersedes',
  'derived_from',
  'contradicts',
  'duplicate_of',
  'related_to',
]);

export const LINK_TYPES = Object.freeze(['attribution', 'rule_source', 'supporting_doc']);
export const PROMOTION_STATES = Object.freeze(['not_applicable', 'proposed', 'approved', 'rejected', 'applied']);

const inList = (values) => values.map((value) => `'${value}'`).join(', ');

/** Immutable, checksummed migrations. Never edit an applied migration; add a new one. */
const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        identity_key TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        git_remote TEXT,
        root_path_hint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        claim_kind TEXT NOT NULL CHECK (claim_kind IN (${inList(CLAIM_KINDS)})),
        statement TEXT NOT NULL,
        details TEXT,
        epistemic_state TEXT NOT NULL DEFAULT 'unassessed'
          CHECK (epistemic_state IN (${inList(EPISTEMIC_STATES)})),
        lifecycle_state TEXT NOT NULL DEFAULT 'current'
          CHECK (lifecycle_state IN (${inList(LIFECYCLE_STATES)})),
        scope_json TEXT NOT NULL DEFAULT '{}',
        tags_json TEXT NOT NULL DEFAULT '[]',
        retrieval_policy TEXT NOT NULL DEFAULT 'relevant'
          CHECK (retrieval_policy IN (${inList(RETRIEVAL_POLICIES)})),
        created_session_id TEXT,
        created_seq INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_validated_at TEXT
      )`,
      `CREATE TABLE evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_kind TEXT NOT NULL CHECK (source_kind IN (${inList(SOURCE_KINDS)})),
        source_ref TEXT NOT NULL,
        locator TEXT,
        revision TEXT,
        excerpt TEXT,
        content_hash TEXT,
        captured_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE finding_evidence (
        finding_id INTEGER NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
        evidence_id INTEGER NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
        relation TEXT NOT NULL CHECK (relation IN (${inList(EVIDENCE_RELATIONS)})),
        method TEXT,
        rationale TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (finding_id, evidence_id, relation)
      )`,
      `CREATE TABLE finding_relations (
        from_finding_id INTEGER NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
        relation TEXT NOT NULL CHECK (relation IN (${inList(FINDING_RELATIONS)})),
        to_finding_id INTEGER NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
        reason TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (from_finding_id, relation, to_finding_id),
        CHECK (from_finding_id <> to_finding_id)
      )`,
      `CREATE TABLE finding_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        finding_id INTEGER NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
        before_json TEXT,
        after_json TEXT,
        reason TEXT,
        session_id TEXT,
        seq INTEGER,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE doc_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        finding_id INTEGER NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
        doc_path TEXT NOT NULL,
        anchor TEXT,
        link_type TEXT NOT NULL CHECK (link_type IN (${inList(LINK_TYPES)})),
        promotion_state TEXT NOT NULL DEFAULT 'not_applicable'
          CHECK (promotion_state IN (${inList(PROMOTION_STATES)})),
        UNIQUE (finding_id, doc_path, anchor, link_type)
      )`,
      'CREATE INDEX idx_findings_project_lifecycle ON findings(project_id, lifecycle_state)',
      'CREATE INDEX idx_findings_project_epistemic ON findings(project_id, epistemic_state)',
      'CREATE INDEX idx_findings_project_updated ON findings(project_id, updated_at DESC)',
      'CREATE INDEX idx_evidence_source ON evidence(source_kind, source_ref)',
      'CREATE INDEX idx_finding_evidence_reverse ON finding_evidence(evidence_id)',
      'CREATE INDEX idx_relations_target ON finding_relations(to_finding_id)',
      'CREATE INDEX idx_doc_links_finding ON doc_links(finding_id)',
    ],
  },
];

function checksumOf(statements) {
  return createHash('sha256').update(statements.join(';\n')).digest('hex');
}

function applyMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Map(
    db
      .prepare('SELECT version, checksum FROM schema_migrations')
      .all()
      .map((row) => [Number(row.version), String(row.checksum)]),
  );
  for (const migration of MIGRATIONS) {
    const checksum = checksumOf(migration.statements);
    const recorded = applied.get(migration.version);
    if (recorded !== undefined) {
      if (recorded !== checksum) {
        throw storageError(
          `migration ${migration.version} checksum mismatch: the on-disk schema was created by a different build`,
          { expected: recorded, actual: checksum },
        );
      }
      continue;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of migration.statements) db.exec(statement);
      db.prepare('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        checksum,
        nowIso(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw storageError(`failed to apply migration ${migration.version}: ${error.message}`);
    }
  }
}

/**
 * Open (and migrate) a ledger database file. `:memory:` is supported and is
 * what the test-suite uses.
 */
export function openLedgerDatabase(file) {
  try {
    if (file && file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    const db = new DatabaseSync(file ?? ':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    if (file && file !== ':memory:') {
      try {
        db.exec('PRAGMA journal_mode = WAL');
      } catch {
        /* WAL is an optimization, not a requirement */
      }
    }
    applyMigrations(db);
    return db;
  } catch (error) {
    if (error?.code === 'STORAGE_ERROR' || error?.name === 'LedgerError') throw error;
    throw storageError(`failed to open ledger database at ${file}: ${error.message}`);
  }
}

/** Run `fn` inside one write transaction, rolling back on any throw. */
export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the original error matters more */
    }
    throw error;
  }
}
