/**
 * SQL data access. Every function here takes plain values and returns plain
 * objects; business rules live in service.js so that the storage layer stays
 * free of policy.
 */
import { createHash } from 'node:crypto';
import { nowIso } from './db.js';
import { notFound, invalidArgument } from './errors.js';

const parseJson = (text, fallback) => {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

const stringifyJson = (value, fallback) => {
  if (value === null || value === undefined) return JSON.stringify(fallback);
  return JSON.stringify(value);
};

export function rowToFinding(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    ref: `F-${Number(row.id)}`,
    projectId: Number(row.project_id),
    claimKind: row.claim_kind,
    statement: row.statement,
    details: row.details,
    epistemicState: row.epistemic_state,
    lifecycleState: row.lifecycle_state,
    scope: parseJson(row.scope_json, {}),
    tags: parseJson(row.tags_json, []),
    retrievalPolicy: row.retrieval_policy,
    createdSessionId: row.created_session_id,
    createdSeq: row.created_seq === null ? null : Number(row.created_seq),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastValidatedAt: row.last_validated_at,
  };
}

export function rowToEvidence(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    locator: row.locator,
    revision: row.revision,
    excerpt: row.excerpt,
    contentHash: row.content_hash,
    capturedAt: row.captured_at,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
  };
}

export function rowToRelation(row) {
  if (!row) return null;
  return {
    fromFindingId: Number(row.from_finding_id),
    relation: row.relation,
    toFindingId: Number(row.to_finding_id),
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export function rowToProject(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    identityKey: row.identity_key,
    displayName: row.display_name,
    gitRemote: row.git_remote,
    rootPathHint: row.root_path_hint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function contentHashOf(...parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part === null || part === undefined ? '\u0000' : String(part));
  return hash.digest('hex');
}

/** Parse `12` or `F-12` into a finding id. */
export function parseFindingRef(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== 'string') throw invalidArgument('finding id must be an integer or "F-<n>"');
  const match = /^\s*(?:[Ff]-)?(\d+)\s*$/.exec(value);
  if (!match) throw invalidArgument(`invalid finding id: ${value}`);
  return Number(match[1]);
}

export function getOrCreateProject(db, project) {
  const existing = db.prepare('SELECT * FROM projects WHERE identity_key = ?').get(project.identityKey);
  if (existing) {
    const changed =
      (project.displayName && project.displayName !== existing.display_name) ||
      (project.gitRemote && project.gitRemote !== existing.git_remote) ||
      (project.rootPathHint && project.rootPathHint !== existing.root_path_hint);
    if (changed) {
      db.prepare(
        'UPDATE projects SET display_name = ?, git_remote = ?, root_path_hint = ?, updated_at = ? WHERE id = ?',
      ).run(
        project.displayName ?? existing.display_name,
        project.gitRemote ?? existing.git_remote,
        project.rootPathHint ?? existing.root_path_hint,
        nowIso(),
        existing.id,
      );
      return rowToProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(existing.id));
    }
    return rowToProject(existing);
  }
  const timestamp = nowIso();
  const result = db
    .prepare(
      'INSERT INTO projects (identity_key, display_name, git_remote, root_path_hint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      project.identityKey,
      project.displayName ?? project.identityKey,
      project.gitRemote ?? null,
      project.rootPathHint ?? null,
      timestamp,
      timestamp,
    );
  return rowToProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(result.lastInsertRowid)));
}

export function insertFinding(db, values) {
  const timestamp = nowIso();
  const result = db
    .prepare(
      `INSERT INTO findings (
        project_id, claim_kind, statement, details, epistemic_state, lifecycle_state,
        scope_json, tags_json, retrieval_policy, created_session_id, created_seq,
        created_at, updated_at, last_validated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      values.projectId,
      values.claimKind,
      values.statement,
      values.details ?? null,
      values.epistemicState ?? 'unassessed',
      values.lifecycleState ?? 'current',
      stringifyJson(values.scope, {}),
      stringifyJson(values.tags, []),
      values.retrievalPolicy ?? 'relevant',
      values.createdSessionId ?? null,
      values.createdSeq ?? null,
      timestamp,
      timestamp,
      values.lastValidatedAt ?? null,
    );
  return rowToFinding(db.prepare('SELECT * FROM findings WHERE id = ?').get(Number(result.lastInsertRowid)));
}

export function getFindingRow(db, id) {
  return rowToFinding(db.prepare('SELECT * FROM findings WHERE id = ?').get(id));
}

export function updateFinding(db, id, patch) {
  const columns = [];
  const params = [];
  const map = {
    claimKind: 'claim_kind',
    statement: 'statement',
    details: 'details',
    epistemicState: 'epistemic_state',
    lifecycleState: 'lifecycle_state',
    retrievalPolicy: 'retrieval_policy',
    lastValidatedAt: 'last_validated_at',
  };
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] !== undefined) {
      columns.push(`${column} = ?`);
      params.push(patch[key]);
    }
  }
  if (patch.scope !== undefined) {
    columns.push('scope_json = ?');
    params.push(stringifyJson(patch.scope, {}));
  }
  if (patch.tags !== undefined) {
    columns.push('tags_json = ?');
    params.push(stringifyJson(patch.tags, []));
  }
  columns.push('updated_at = ?');
  params.push(nowIso());
  params.push(id);
  db.prepare(`UPDATE findings SET ${columns.join(', ')} WHERE id = ?`).run(...params);
  return getFindingRow(db, id);
}

export function listFindingRows(db, projectId, filters = {}) {
  const where = ['project_id = ?'];
  const params = [projectId];
  if (filters.ids && filters.ids.length > 0) {
    where.push(`id IN (${filters.ids.map(() => '?').join(', ')})`);
    params.push(...filters.ids);
  }
  if (filters.lifecycleStates && filters.lifecycleStates.length > 0) {
    where.push(`lifecycle_state IN (${filters.lifecycleStates.map(() => '?').join(', ')})`);
    params.push(...filters.lifecycleStates);
  }
  if (filters.epistemicStates && filters.epistemicStates.length > 0) {
    where.push(`epistemic_state IN (${filters.epistemicStates.map(() => '?').join(', ')})`);
    params.push(...filters.epistemicStates);
  }
  if (filters.claimKinds && filters.claimKinds.length > 0) {
    where.push(`claim_kind IN (${filters.claimKinds.map(() => '?').join(', ')})`);
    params.push(...filters.claimKinds);
  }
  if (filters.text) {
    where.push('(statement LIKE ? OR details LIKE ?)');
    params.push(`%${filters.text}%`, `%${filters.text}%`);
  }
  const limit = Number.isInteger(filters.limit) ? Math.max(1, Math.min(filters.limit, 500)) : 50;
  const offset = Number.isInteger(filters.offset) ? Math.max(0, filters.offset) : 0;
  params.push(limit, offset);
  const rows = db
    .prepare(`SELECT * FROM findings WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params);
  return rows.map(rowToFinding);
}

export function countFindingRows(db, projectId, filters = {}) {
  const where = ['project_id = ?'];
  const params = [projectId];
  if (filters.lifecycleStates && filters.lifecycleStates.length > 0) {
    where.push(`lifecycle_state IN (${filters.lifecycleStates.map(() => '?').join(', ')})`);
    params.push(...filters.lifecycleStates);
  }
  if (filters.epistemicStates && filters.epistemicStates.length > 0) {
    where.push(`epistemic_state IN (${filters.epistemicStates.map(() => '?').join(', ')})`);
    params.push(...filters.epistemicStates);
  }
  const row = db.prepare(`SELECT COUNT(*) AS n FROM findings WHERE ${where.join(' AND ')}`).get(...params);
  return Number(row.n);
}

export function findExistingEvidence(db, { sourceKind, sourceRef, contentHash }) {
  return rowToEvidence(
    db
      .prepare('SELECT * FROM evidence WHERE source_kind = ? AND source_ref = ? AND content_hash IS ?')
      .get(sourceKind, sourceRef, contentHash ?? null),
  );
}

export function getEvidenceRow(db, id) {
  return rowToEvidence(db.prepare('SELECT * FROM evidence WHERE id = ?').get(id));
}

export function insertEvidence(db, values) {
  const timestamp = nowIso();
  const contentHash =
    values.contentHash ?? (values.excerpt ? contentHashOf(values.sourceKind, values.sourceRef, values.excerpt) : null);
  const result = db
    .prepare(
      `INSERT INTO evidence (source_kind, source_ref, locator, revision, excerpt, content_hash, captured_at, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      values.sourceKind,
      values.sourceRef,
      values.locator ?? null,
      values.revision ?? null,
      values.excerpt ?? null,
      contentHash,
      values.capturedAt ?? timestamp,
      stringifyJson(values.metadata, {}),
      timestamp,
    );
  return getEvidenceRow(db, Number(result.lastInsertRowid));
}

export function linkEvidenceRow(db, { findingId, evidenceId, relation, method, rationale }) {
  db.prepare(
    `INSERT INTO finding_evidence (finding_id, evidence_id, relation, method, rationale, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (finding_id, evidence_id, relation) DO UPDATE SET method = excluded.method, rationale = excluded.rationale`,
  ).run(findingId, evidenceId, relation, method ?? null, rationale ?? null, nowIso());
}

export function listEvidenceForFinding(db, findingId) {
  const rows = db
    .prepare(
      `SELECT e.*, fe.relation AS link_relation, fe.method AS link_method, fe.rationale AS link_rationale
       FROM finding_evidence fe JOIN evidence e ON e.id = fe.evidence_id
       WHERE fe.finding_id = ? ORDER BY e.id ASC`,
    )
    .all(findingId);
  return rows.map((row) => ({
    ...rowToEvidence(row),
    relation: row.link_relation,
    method: row.link_method,
    rationale: row.link_rationale,
  }));
}

export function countEvidenceForFinding(db, findingId, relation = null) {
  const sql =
    relation === null
      ? 'SELECT COUNT(*) AS n FROM finding_evidence WHERE finding_id = ?'
      : 'SELECT COUNT(*) AS n FROM finding_evidence WHERE finding_id = ? AND relation = ?';
  const row = relation === null ? db.prepare(sql).get(findingId) : db.prepare(sql).get(findingId, relation);
  return Number(row.n);
}

export function listRelationsFrom(db, findingId) {
  return db
    .prepare('SELECT * FROM finding_relations WHERE from_finding_id = ?')
    .all(findingId)
    .map(rowToRelation);
}

export function listRelationsTo(db, findingId) {
  return db
    .prepare('SELECT * FROM finding_relations WHERE to_finding_id = ?')
    .all(findingId)
    .map(rowToRelation);
}

export function insertRelationRow(db, { fromFindingId, relation, toFindingId, reason }) {
  db.prepare(
    `INSERT INTO finding_relations (from_finding_id, relation, to_finding_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (from_finding_id, relation, to_finding_id) DO UPDATE SET reason = excluded.reason`,
  ).run(fromFindingId, relation, toFindingId, reason ?? null, nowIso());
}

/** Walk `supersedes` edges forward, returning every reachable finding id. */
export function reachableSupersedes(db, startId) {
  const seen = new Set();
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift();
    const rows = db
      .prepare("SELECT to_finding_id FROM finding_relations WHERE from_finding_id = ? AND relation = 'supersedes'")
      .all(current);
    for (const row of rows) {
      const id = Number(row.to_finding_id);
      if (!seen.has(id)) {
        seen.add(id);
        queue.push(id);
      }
    }
  }
  return [...seen];
}

export function findReplacementFor(db, findingId) {
  const row = db
    .prepare(
      `SELECT f.* FROM finding_relations r JOIN findings f ON f.id = r.from_finding_id
       WHERE r.to_finding_id = ? AND r.relation = 'supersedes'
       ORDER BY r.created_at DESC LIMIT 1`,
    )
    .get(findingId);
  return rowToFinding(row);
}

export function insertEventRow(db, values) {
  db.prepare(
    `INSERT INTO finding_events (finding_id, event_type, actor_type, before_json, after_json, reason, session_id, seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    values.findingId,
    values.eventType,
    values.actorType ?? 'agent',
    values.before === undefined ? null : JSON.stringify(values.before),
    values.after === undefined ? null : JSON.stringify(values.after),
    values.reason ?? null,
    values.sessionId ?? null,
    values.seq ?? null,
    nowIso(),
  );
}

export function listEventRows(db, findingId) {
  return db
    .prepare('SELECT * FROM finding_events WHERE finding_id = ? ORDER BY id ASC')
    .all(findingId)
    .map((row) => ({
      id: Number(row.id),
      findingId: Number(row.finding_id),
      eventType: row.event_type,
      actorType: row.actor_type,
      before: parseJson(row.before_json, null),
      after: parseJson(row.after_json, null),
      reason: row.reason,
      sessionId: row.session_id,
      seq: row.seq === null ? null : Number(row.seq),
      createdAt: row.created_at,
    }));
}

export function insertDocLinkRow(db, values) {
  db.prepare(
    `INSERT INTO doc_links (finding_id, doc_path, anchor, link_type, promotion_state)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (finding_id, doc_path, anchor, link_type)
     DO UPDATE SET promotion_state = excluded.promotion_state`,
  ).run(values.findingId, values.docPath, values.anchor ?? null, values.linkType, values.promotionState);
}

export function listDocLinks(db, findingId) {
  return db
    .prepare('SELECT * FROM doc_links WHERE finding_id = ?')
    .all(findingId)
    .map((row) => ({
      id: Number(row.id),
      findingId: Number(row.finding_id),
      docPath: row.doc_path,
      anchor: row.anchor,
      linkType: row.link_type,
      promotionState: row.promotion_state,
    }));
}

export function requireFinding(db, id) {
  const finding = getFindingRow(db, id);
  if (!finding) throw notFound(`finding ${`F-${id}`} does not exist`, { findingId: id });
  return finding;
}

export function requireFindingInProject(db, id, projectId) {
  const finding = requireFinding(db, id);
  if (finding.projectId !== projectId) {
    throw notFound(`finding F-${id} does not exist in this project`, {
      findingId: id,
      projectId,
      actualProjectId: finding.projectId,
    });
  }
  return finding;
}

export function projectById(db, id) {
  return rowToProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
}
