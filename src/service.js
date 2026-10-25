/**
 * Application service: state machine, transactions, event log.
 *
 * The invariants implemented here are the ones the design treats as load-bearing:
 *  - epistemic state and lifecycle state are orthogonal (a refuted finding stays
 *    `current` as a documented dead end);
 *  - `refuted` and `superseded` cannot be reached through the generic state tool;
 *  - `supported` cannot be reached without at least one `supports` evidence row;
 *  - supersede/refute are single transactions that also record their event.
 */
import {
  EPISTEMIC_STATES,
  LIFECYCLE_STATES,
  CLAIM_KINDS,
  RETRIEVAL_POLICIES,
  SOURCE_KINDS,
  EVIDENCE_RELATIONS,
  FINDING_RELATIONS,
  LINK_TYPES,
  PROMOTION_STATES,
  nowIso,
  withTransaction,
} from './db.js';
import {
  invalidArgument,
  invalidTransition,
  evidenceRequired,
  relationCycle,
  notFound,
} from './errors.js';
import {
  countEvidenceForFinding,
  findReplacementFor,
  getFindingRow,
  getOrCreateProject,
  insertEventRow,
  insertEvidence,
  insertFinding,
  insertDocLinkRow,
  insertRelationRow,
  linkEvidenceRow,
  listEvidenceForFinding,
  listEventRows,
  listFindingRows,
  listDocLinks,
  listRelationsFrom,
  listRelationsTo,
  parseFindingRef,
  projectById,
  reachableSupersedes,
  requireFinding,
  requireFindingInProject,
  updateFinding,
} from './store.js';

const MAX_STATEMENT = 4000;
const MAX_DETAILS = 20000;
const MAX_EXCERPT = 8000;

/** Allowed epistemic moves through the generic state tool. */
const EPISTEMIC_TRANSITIONS = {
  unassessed: ['provisional', 'supported', 'contested', 'inconclusive', 'not_applicable'],
  provisional: ['supported', 'contested', 'inconclusive', 'unassessed', 'not_applicable'],
  supported: ['provisional', 'contested', 'inconclusive', 'not_applicable'],
  contested: ['provisional', 'supported', 'inconclusive', 'not_applicable'],
  refuted: ['inconclusive'],
  inconclusive: ['provisional', 'contested', 'supported', 'not_applicable'],
  not_applicable: ['unassessed', 'provisional', 'inconclusive'],
};

/** Allowed lifecycle moves; `superseded` is reachable only through supersede_finding. */
const LIFECYCLE_TRANSITIONS = {
  current: ['withdrawn', 'archived'],
  superseded: ['archived'],
  withdrawn: ['current', 'archived'],
  archived: ['current'],
};

const SECRET_PATTERNS = [
  /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"']{8,}/gi,
];

/** Replace secret-looking substrings before anything is persisted. */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text === '') return { text, redacted: 0 };
  let out = text;
  let redacted = 0;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      redacted += 1;
      return '[REDACTED]';
    });
  }
  return { text: out, redacted };
}

const trimTo = (text, max, warnings, label) => {
  if (typeof text !== 'string') return text;
  if (text.length <= max) return text;
  warnings.push(`${label} truncated from ${text.length} to ${max} characters`);
  return text.slice(0, max);
};

function requireString(value, name, { max = MAX_STATEMENT, allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw invalidArgument(`${name} must be a string`);
  const trimmed = value.trim();
  if (!allowEmpty && trimmed === '') throw invalidArgument(`${name} must not be empty`);
  if (trimmed.length > max) throw invalidArgument(`${name} exceeds the ${max}-character limit`);
  return trimmed;
}

function requireEnum(value, allowed, name) {
  if (!allowed.includes(value)) {
    throw invalidArgument(`${name} must be one of: ${allowed.join(', ')}`, { received: value });
  }
  return value;
}

function optionalEnum(value, allowed, name) {
  if (value === undefined || value === null) return undefined;
  return requireEnum(value, allowed, name);
}

function normalizeScope(scope) {
  if (scope === undefined || scope === null) return {};
  if (typeof scope !== 'object' || Array.isArray(scope)) throw invalidArgument('scope must be an object');
  const out = {};
  for (const key of ['match', 'context']) {
    if (scope[key] === undefined || scope[key] === null) continue;
    if (typeof scope[key] !== 'object' || Array.isArray(scope[key])) {
      throw invalidArgument(`scope.${key} must be an object`);
    }
    out[key] = { ...scope[key] };
  }
  if (scope.revalidate_on !== undefined && scope.revalidate_on !== null) {
    if (!Array.isArray(scope.revalidate_on)) throw invalidArgument('scope.revalidate_on must be an array of strings');
    out.revalidate_on = scope.revalidate_on.map((entry) => requireString(entry, 'scope.revalidate_on[]', { max: 120 }));
  }
  return out;
}

function normalizeTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw invalidArgument('tags must be an array of strings');
  return [...new Set(tags.map((tag) => requireString(tag, 'tags[]', { max: 64 })))].slice(0, 32);
}

export class LedgerService {
  /** @param {import('node:sqlite').DatabaseSync} db */
  constructor(db, options = {}) {
    this.db = db;
    this.options = options;
    /** Bumped on every successful mutation so the injector knows to refresh. */
    this.revision = 0;
    this.projectCache = new Map();
  }

  bump() {
    this.revision += 1;
    return this.revision;
  }

  ensureProject(project) {
    if (!project || typeof project.identityKey !== 'string') {
      throw invalidArgument('a project identity is required');
    }
    const cached = this.projectCache.get(project.identityKey);
    if (cached) return cached;
    const row = getOrCreateProject(this.db, project);
    this.projectCache.set(project.identityKey, row);
    return row;
  }

  /** Internal helper: resolve a finding that must belong to `projectId`. */
  #findingInProject(findingRef, projectId) {
    return requireFindingInProject(this.db, parseFindingRef(findingRef), projectId);
  }

  #event(findingId, eventType, { actor = 'agent', before, after, reason, sessionId, seq }) {
    insertEventRow(this.db, {
      findingId,
      eventType,
      actorType: actor,
      before,
      after,
      reason,
      sessionId: sessionId ?? null,
      seq: seq ?? null,
    });
  }

  // ---------------------------------------------------------------- log_finding
  logFinding(input, context = {}) {
    const warnings = [];
    const project = this.ensureProject(context.project);
    const claimKind = requireEnum(input.claim_kind, CLAIM_KINDS, 'claim_kind');
    const statementRaw = requireString(input.statement, 'statement');
    const statement = redactSecrets(statementRaw);
    if (statement.redacted > 0) warnings.push(`${statement.redacted} secret-like fragment(s) redacted from statement`);
    let details = null;
    if (input.details !== undefined && input.details !== null) {
      const redacted = redactSecrets(trimTo(requireString(input.details, 'details', { max: MAX_DETAILS }), MAX_DETAILS, warnings, 'details'));
      if (redacted.redacted > 0) warnings.push(`${redacted.redacted} secret-like fragment(s) redacted from details`);
      details = redacted.text;
    }
    const epistemicState = optionalEnum(input.epistemic_state, EPISTEMIC_STATES, 'epistemic_state') ?? 'unassessed';
    if (epistemicState === 'refuted') {
      throw invalidTransition('a new finding cannot start as refuted; use refute_finding on an existing finding');
    }
    if (epistemicState === 'supported') {
      throw evidenceRequired('a finding cannot start as supported; log it first, attach evidence, then set_finding_state');
    }
    const retrievalPolicy = optionalEnum(input.retrieval_policy, RETRIEVAL_POLICIES, 'retrieval_policy') ?? 'relevant';
    const scope = normalizeScope(input.scope);
    const tags = normalizeTags(input.tags);

    const finding = withTransaction(this.db, () => {
      const created = insertFinding(this.db, {
        projectId: project.id,
        claimKind,
        statement: statement.text,
        details,
        epistemicState,
        lifecycleState: 'current',
        scope,
        tags,
        retrievalPolicy,
        createdSessionId: context.sessionId ?? null,
        createdSeq: context.seq ?? null,
      });
      this.#event(created.id, 'finding_created', {
        actor: context.actor ?? 'agent',
        after: snapshot(created),
        reason: input.reason ?? null,
        sessionId: context.sessionId,
        seq: context.seq,
      });
      return created;
    });
    this.bump();
    if (Object.keys(scope).length === 0) {
      warnings.push('no scope recorded: the finding will be treated as globally applicable until a scope is added');
    }
    return { data: { finding: presentFinding(finding) }, warnings };
  }

  // ------------------------------------------------------------- add_evidence
  addEvidence(input, context = {}) {
    const warnings = [];
    const project = this.ensureProject(context.project);
    const finding = this.#findingInProject(input.finding_id, project.id);
    const sourceKind = requireEnum(input.source_kind, SOURCE_KINDS, 'source_kind');
    const sourceRef = requireString(input.source_ref, 'source_ref', { max: 2000 });
    const relation = optionalEnum(input.relation, EVIDENCE_RELATIONS, 'relation') ?? 'supports';
    let excerpt = null;
    if (input.excerpt !== undefined && input.excerpt !== null) {
      const redacted = redactSecrets(trimTo(requireString(input.excerpt, 'excerpt', { max: MAX_EXCERPT }), MAX_EXCERPT, warnings, 'excerpt'));
      if (redacted.redacted > 0) warnings.push(`${redacted.redacted} secret-like fragment(s) redacted from excerpt`);
      excerpt = redacted.text;
    }
    if (relation === 'supports' && !excerpt && !input.locator) {
      warnings.push('supports without an excerpt or locator: prefer quoting the smallest decisive fragment');
    }
    const capturedAt = input.captured_at ? requireString(input.captured_at, 'captured_at', { max: 64 }) : nowIso();

    const result = withTransaction(this.db, () => {
      const evidence = insertEvidence(this.db, {
        sourceKind,
        sourceRef,
        locator: input.locator === undefined ? null : requireString(input.locator, 'locator', { max: 2000, allowEmpty: true }),
        revision: input.revision === undefined ? null : requireString(input.revision, 'revision', { max: 200, allowEmpty: true }),
        excerpt,
        capturedAt,
        metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
      });
      linkEvidenceRow(this.db, {
        findingId: finding.id,
        evidenceId: evidence.id,
        relation,
        method: input.method === undefined ? null : requireString(input.method, 'method', { max: 200, allowEmpty: true }),
        rationale:
          input.rationale === undefined ? null : requireString(input.rationale, 'rationale', { max: 2000, allowEmpty: true }),
      });
      const supports = countEvidenceForFinding(this.db, finding.id, 'supports');
      const contradicts = countEvidenceForFinding(this.db, finding.id, 'contradicts');
      this.#event(finding.id, 'evidence_added', {
        actor: context.actor ?? 'agent',
        after: { evidenceId: evidence.id, relation, sourceKind, sourceRef },
        reason: input.rationale ?? null,
        sessionId: context.sessionId,
        seq: context.seq,
      });
      let stateWarning = null;
      if (relation === 'supports' && finding.epistemicState !== 'supported') {
        stateWarning =
          'evidence recorded, but the epistemic state was not changed automatically: call set_finding_state with supported once the support is decisive';
      }
      if (relation === 'contradicts' && finding.epistemicState === 'supported') {
        stateWarning =
          'conflicting evidence recorded against a supported finding: consider set_finding_state to contested so the conflict stays visible';
      }
      return { evidence, supports, contradicts, stateWarning };
    });
    this.bump();
    if (result.stateWarning) warnings.push(result.stateWarning);
    return {
      data: {
        finding: presentFinding(getFindingRow(this.db, finding.id)),
        evidence: result.evidence,
        evidenceSummary: { supports: result.supports, contradicts: result.contradicts },
        stateChanged: false,
      },
      warnings,
    };
  }

  // --------------------------------------------------------- set_finding_state
  setFindingState(input, context = {}) {
    const warnings = [];
    const project = this.ensureProject(context.project);
    const finding = this.#findingInProject(input.finding_id, project.id);
    const targetEpistemic =
      input.epistemic_state === undefined ? undefined : optionalEnum(input.epistemic_state, EPISTEMIC_STATES, 'epistemic_state');
    let targetLifecycle =
      input.lifecycle_state === undefined ? undefined : optionalEnum(input.lifecycle_state, LIFECYCLE_STATES, 'lifecycle_state');
    if (targetEpistemic === undefined && targetLifecycle === undefined) {
      throw invalidArgument('provide epistemic_state, lifecycle_state, or both');
    }
    if (input.expected_updated_at && input.expected_updated_at !== finding.updatedAt) {
      throw Object.assign(new Error('finding changed since it was read'), {
        code: 'CONCURRENT_MODIFICATION',
        details: { expected: input.expected_updated_at, actual: finding.updatedAt },
      });
    }

    if (targetEpistemic !== undefined) {
      if (targetEpistemic === 'refuted') {
        throw invalidTransition('refuted is only reachable through refute_finding, which requires contradicting evidence');
      }
      if (finding.epistemicState === 'refuted' && targetEpistemic !== 'refuted') {
        throw invalidTransition(
          'a refuted finding can only be revived through revalidate_finding, which records why the refutation no longer holds',
        );
      }
      const allowed = EPISTEMIC_TRANSITIONS[finding.epistemicState] ?? [];
      if (!allowed.includes(targetEpistemic)) {
        throw invalidTransition(`epistemic transition ${finding.epistemicState} -> ${targetEpistemic} is not allowed`, {
          allowed,
        });
      }
      if (targetEpistemic === 'supported') {
        const supports = countEvidenceForFinding(this.db, finding.id, 'supports');
        if (supports === 0) {
          throw evidenceRequired('supported requires at least one supporting evidence row; add evidence first', {
            findingId: finding.id,
          });
        }
      }
    }

    if (targetLifecycle !== undefined && targetLifecycle !== finding.lifecycleState) {
      if (targetLifecycle === 'superseded') {
        throw invalidTransition('superseded is only reachable through supersede_finding, which names the replacement');
      }
      const allowed = LIFECYCLE_TRANSITIONS[finding.lifecycleState] ?? [];
      if (!allowed.includes(targetLifecycle)) {
        throw invalidTransition(`lifecycle transition ${finding.lifecycleState} -> ${targetLifecycle} is not allowed`, {
          allowed,
          hint: finding.lifecycleState === 'superseded' ? 'a superseded finding is a closed record' : undefined,
        });
      }
      if (finding.lifecycleState === 'withdrawn' && targetLifecycle === 'current') {
        warnings.push('restored a withdrawn finding to current: keep the withdrawal reason in the new details');
      }
    }

    const updated = withTransaction(this.db, () => {
      const next = updateFinding(this.db, finding.id, {
        epistemicState: targetEpistemic,
        lifecycleState: targetLifecycle,
        lastValidatedAt: targetEpistemic !== undefined || targetLifecycle !== undefined ? nowIso() : undefined,
      });
      this.#event(finding.id, 'state_changed', {
        actor: context.actor ?? 'agent',
        before: { epistemicState: finding.epistemicState, lifecycleState: finding.lifecycleState },
        after: { epistemicState: next.epistemicState, lifecycleState: next.lifecycleState },
        reason: input.reason ?? null,
        sessionId: context.sessionId,
        seq: context.seq,
      });
      return next;
    });
    this.bump();
    if (targetEpistemic === 'supported') {
      const last = listEvidenceForFinding(this.db, finding.id).filter((entry) => entry.relation === 'supports');
      if (!last.some((entry) => entry.excerpt || entry.locator)) {
        warnings.push('supported with no excerpt or locator: cite the decisive artifact so a future session can re-check it');
      }
    }
    return { data: { finding: presentFinding(updated) }, warnings };
  }

  // ------------------------------------------------------------- refute_finding
  refuteFinding(input, context = {}) {
    const warnings = [];
    const project = this.ensureProject(context.project);
    const finding = this.#findingInProject(input.finding_id, project.id);
    if (finding.lifecycleState === 'superseded' || finding.lifecycleState === 'archived') {
      throw invalidTransition(`cannot refute a ${finding.lifecycleState} finding`, {
        lifecycleState: finding.lifecycleState,
      });
    }
    const sourceKind = requireEnum(input.source_kind, SOURCE_KINDS, 'source_kind');
    const sourceRef = requireString(input.source_ref, 'source_ref', { max: 2000 });
    const rationale = requireString(input.reason ?? input.rationale, 'reason', { max: 4000 });
    let excerpt = null;
    if (input.excerpt !== undefined && input.excerpt !== null) {
      const redacted = redactSecrets(trimTo(requireString(input.excerpt, 'excerpt', { max: MAX_EXCERPT }), MAX_EXCERPT, warnings, 'excerpt'));
      if (redacted.redacted > 0) warnings.push(`${redacted.redacted} secret-like fragment(s) redacted from excerpt`);
      excerpt = redacted.text;
    }

    const result = withTransaction(this.db, () => {
      const evidence = insertEvidence(this.db, {
        sourceKind,
        sourceRef,
        locator: input.locator ?? null,
        revision: input.revision ?? null,
        excerpt,
        capturedAt: nowIso(),
        metadata: { purpose: 'refutation' },
      });
      linkEvidenceRow(this.db, {
        findingId: finding.id,
        evidenceId: evidence.id,
        relation: 'contradicts',
        method: 'refute_finding',
        rationale,
      });
      const next = updateFinding(this.db, finding.id, { epistemicState: 'refuted', lastValidatedAt: nowIso() });
      this.#event(finding.id, 'refuted', {
        actor: context.actor ?? 'agent',
        before: { epistemicState: finding.epistemicState },
        after: { epistemicState: 'refuted', evidenceId: evidence.id },
        reason: rationale,
        sessionId: context.sessionId,
        seq: context.seq,
      });
      return { evidence, next };
    });
    this.bump();
    if (finding.epistemicState === 'supported') {
      warnings.push('a supported finding was refuted: the contradicting evidence is now the authoritative record');
    }
    return {
      data: {
        finding: presentFinding(result.next),
        evidence: result.evidence,
        note: 'lifecycle_state stays current: a refuted finding remains an excluded path that later sessions should not re-try',
      },
      warnings,
    };
  }

  // ----------------------------------------------------------- supersede_finding
  supersedeFinding(input, context = {}) {
    const warnings = [];
    const project = this.ensureProject(context.project);
    const oldFinding = this.#findingInProject(input.supersedes, project.id);
    if (oldFinding.lifecycleState === 'superseded') {
      const replacement = findReplacementFor(this.db, oldFinding.id);
      throw invalidTransition(`F-${oldFinding.id} is already superseded`, {
        replacement: replacement ? replacement.ref : null,
      });
    }
    if (oldFinding.lifecycleState === 'archived') {
      throw invalidTransition('an archived finding cannot be superseded; log the correction as a new finding instead');
    }
    const replacementInput = input.replacement ?? {};
    const claimKind = replacementInput.claim_kind
      ? requireEnum(replacementInput.claim_kind, CLAIM_KINDS, 'replacement.claim_kind')
      : oldFinding.claimKind;
    const statementSource =
      replacementInput.statement === undefined || replacementInput.statement === null
        ? oldFinding.statement
        : requireString(replacementInput.statement, 'replacement.statement');
    const statement = redactSecrets(statementSource);
    if (statement.redacted > 0) warnings.push(`${statement.redacted} secret-like fragment(s) redacted from statement`);
    const details =
      replacementInput.details === undefined || replacementInput.details === null ? oldFinding.details : String(replacementInput.details);
    const scope = replacementInput.scope === undefined ? oldFinding.scope : normalizeScope(replacementInput.scope);
    const tags = replacementInput.tags === undefined ? oldFinding.tags : normalizeTags(replacementInput.tags);
    const retrievalPolicy = replacementInput.retrieval_policy
      ? requireEnum(replacementInput.retrieval_policy, RETRIEVAL_POLICIES, 'replacement.retrieval_policy')
      : oldFinding.retrievalPolicy;
    const epistemicState = optionalEnum(replacementInput.epistemic_state, EPISTEMIC_STATES, 'replacement.epistemic_state') ?? 'provisional';
    if (epistemicState === 'refuted' || epistemicState === 'supported') {
      throw invalidTransition(`replacement cannot start as ${epistemicState}`, {
        hint: 'start it as provisional or unassessed, then attach evidence and promote it',
      });
    }
    if (statementSource === oldFinding.statement && epistemicState === oldFinding.epistemicState) {
      warnings.push('replacement restates the superseded claim without a new state: make the revision explicit in the statement or details');
    }
    const reason = requireString(input.reason, 'reason', { max: 4000 });

    const created = withTransaction(this.db, () => {
      const next = insertFinding(this.db, {
        projectId: project.id,
        claimKind,
        statement: statement.text,
        details,
        epistemicState,
        lifecycleState: 'current',
        scope,
        tags,
        retrievalPolicy,
        createdSessionId: context.sessionId ?? null,
        createdSeq: context.seq ?? null,
      });
      insertRelationRow(this.db, {
        fromFindingId: next.id,
        relation: 'supersedes',
        toFindingId: oldFinding.id,
        reason,
      });
      const retired = updateFinding(this.db, oldFinding.id, { lifecycleState: 'superseded' });
      this.#event(oldFinding.id, 'superseded', {
        actor: context.actor ?? 'agent',
        before: { lifecycleState: oldFinding.lifecycleState },
        after: { lifecycleState: 'superseded', supersededBy: `F-${next.id}` },
        reason,
        sessionId: context.sessionId,
        seq: context.seq,
      });
      this.#event(next.id, 'finding_created', {
        actor: context.actor ?? 'agent',
        after: { ...snapshot(next), supersedes: `F-${oldFinding.id}` },
        reason,
        sessionId: context.sessionId,
        seq: context.seq,
      });
      return { next, retired };
    });
    this.bump();
    return {
      data: {
        finding: presentFinding(created.next),
        superseded: presentFinding(created.retired),
        relation: { from: `F-${created.next.id}`, relation: 'supersedes', to: `F-${oldFinding.id}` },
      },
      warnings,
    };
  }

  // ---------------------------------------------------------- revalidate_finding
  revalidateFinding(input, context = {}) {
    const warnings = [];
    const project = this.ensureProject(context.project);
    const finding = this.#findingInProject(input.finding_id, project.id);
    if (finding.lifecycleState === 'superseded' || finding.lifecycleState === 'archived') {
      throw invalidTransition(`cannot revalidate a ${finding.lifecycleState} finding`);
    }
    const targetEpistemic =
      input.epistemic_state === undefined
        ? finding.epistemicState === 'refuted'
          ? 'inconclusive'
          : 'provisional'
        : optionalEnum(input.epistemic_state, EPISTEMIC_STATES, 'epistemic_state');
    if (targetEpistemic === 'supported') {
      const supports = countEvidenceForFinding(this.db, finding.id, 'supports');
      if (supports === 0) throw evidenceRequired('revalidating into supported requires supporting evidence');
    }
    const scope = input.scope === undefined ? finding.scope : normalizeScope(input.scope);
    const reason = requireString(input.reason, 'reason', { max: 4000 });
    let evidenceId = null;

    const updated = withTransaction(this.db, () => {
      if (input.source_kind !== undefined) {
        const sourceKind = requireEnum(input.source_kind, SOURCE_KINDS, 'source_kind');
        const sourceRef = requireString(input.source_ref, 'source_ref', { max: 2000 });
        const evidence = insertEvidence(this.db, {
          sourceKind,
          sourceRef,
          locator: input.locator ?? null,
          revision: input.revision ?? null,
          excerpt: input.excerpt ?? null,
          capturedAt: nowIso(),
          metadata: { purpose: 'revalidation' },
        });
        evidenceId = evidence.id;
        linkEvidenceRow(this.db, {
          findingId: finding.id,
          evidenceId: evidence.id,
          relation: 'context',
          method: 'revalidate_finding',
          rationale: reason,
        });
      }
      const next = updateFinding(this.db, finding.id, {
        epistemicState: targetEpistemic,
        scope,
        lastValidatedAt: nowIso(),
      });
      this.#event(finding.id, 'revalidated', {
        actor: context.actor ?? 'agent',
        before: { epistemicState: finding.epistemicState, scope: finding.scope },
        after: { epistemicState: next.epistemicState, scope: next.scope, evidenceId },
        reason,
        sessionId: context.sessionId,
        seq: context.seq,
      });
      return next;
    });
    this.bump();
    if (finding.epistemicState === 'refuted') {
      warnings.push('refutation lifted: the old contradicting evidence is retained in history for audit');
    }
    return { data: { finding: presentFinding(updated), evidenceId }, warnings };
  }

  // --------------------------------------------------------------- link_finding
  linkFinding(input, context = {}) {
    const project = this.ensureProject(context.project);
    const from = this.#findingInProject(input.from, project.id);
    const to = this.#findingInProject(input.to, project.id);
    const relation = requireEnum(input.relation, FINDING_RELATIONS, 'relation');
    if (from.id === to.id) throw invalidArgument('a finding cannot be related to itself');
    const reason = requireString(input.reason, 'reason', { max: 4000 });

    if (relation === 'supersedes' || relation === 'derived_from') {
      const reachable = new Set(reachableSupersedes(this.db, to.id));
      if (reachable.has(from.id)) {
        throw relationCycle(`${relation} would create a cycle`, { from: `F-${from.id}`, to: `F-${to.id}` });
      }
    }

    withTransaction(this.db, () => {
      insertRelationRow(this.db, { fromFindingId: from.id, relation, toFindingId: to.id, reason });
      this.#event(from.id, 'relation_added', {
        actor: context.actor ?? 'agent',
        after: { relation, to: `F-${to.id}` },
        reason,
        sessionId: context.sessionId,
        seq: context.seq,
      });
    });
    this.bump();
    const warnings = [];
    if (relation === 'contradicts' && from.epistemicState === 'supported') {
      warnings.push('contradiction recorded: set from.epistemic_state to contested so the conflict is visible at retrieval time');
    }
    return {
      data: {
        relation: { from: `F-${from.id}`, relation, to: `F-${to.id}` },
        from: presentFinding(from),
        to: presentFinding(to),
      },
      warnings,
    };
  }

  // --------------------------------------------------------------- propose_rule
  proposeRule(input, context = {}) {
    const project = this.ensureProject(context.project);
    const finding = this.#findingInProject(input.finding_id, project.id);
    const docPath = requireString(input.doc_path, 'doc_path', { max: 500 });
    const linkType = optionalEnum(input.link_type, LINK_TYPES, 'link_type') ?? 'rule_source';
    const promotionState = optionalEnum(input.promotion_state, PROMOTION_STATES, 'promotion_state') ?? 'proposed';
    const proposedText =
      input.proposed_text === undefined || input.proposed_text === null
        ? finding.statement
        : requireString(input.proposed_text, 'proposed_text', { max: 4000 });
    if (finding.epistemicState !== 'supported' && finding.epistemicState !== 'provisional') {
      throw evidenceRequired(
        `only supported or provisional findings can be proposed as rules (current: ${finding.epistemicState})`,
        { findingId: finding.id },
      );
    }
    const warnings = ['propose_rule records intent only: no document was modified; promotion requires user approval'];
    withTransaction(this.db, () => {
      insertDocLinkRow(this.db, {
        findingId: finding.id,
        docPath,
        anchor: input.anchor ?? null,
        linkType,
        promotionState,
      });
      this.#event(finding.id, 'rule_proposed', {
        actor: context.actor ?? 'agent',
        after: { docPath, anchor: input.anchor ?? null, linkType, promotionState, proposedText },
        reason: input.reason ?? null,
        sessionId: context.sessionId,
        seq: context.seq,
      });
    });
    this.bump();
    if (finding.epistemicState === 'provisional') {
      warnings.push('the source finding is provisional: a rule promoted from it may need revalidation later');
    }
    return {
      data: {
        finding: presentFinding(finding),
        proposal: { docPath, anchor: input.anchor ?? null, linkType, promotionState, proposedText },
        applied: false,
      },
      warnings,
    };
  }

  // ---------------------------------------------------------------- get_finding
  getFinding(input, context = {}) {
    const project = this.ensureProject(context.project);
    const finding = this.#findingInProject(input.finding_id, project.id);
    const evidence = listEvidenceForFinding(this.db, finding.id);
    const relationsFrom = listRelationsFrom(this.db, finding.id).map((relation) => ({
      ...relation,
      from: `F-${relation.fromFindingId}`,
      to: `F-${relation.toFindingId}`,
    }));
    const relationsTo = listRelationsTo(this.db, finding.id).map((relation) => ({
      ...relation,
      from: `F-${relation.fromFindingId}`,
      to: `F-${relation.toFindingId}`,
    }));
    const warnings = [];
    if (finding.epistemicState === 'supported' && !evidence.some((entry) => entry.relation === 'supports')) {
      warnings.push('state says supported but no supporting evidence row is linked: the record is inconsistent');
    }
    if (finding.lifecycleState === 'superseded') {
      const replacement = findReplacementFor(this.db, finding.id);
      if (replacement) warnings.push(`this finding is superseded by ${replacement.ref}`);
    }
    const needsRevalidation = finding.scope?.revalidate_on?.length > 0;
    if (needsRevalidation) {
      warnings.push(`revalidate on: ${finding.scope.revalidate_on.join(', ')}`);
    }
    return {
      data: {
        finding: presentFinding(finding),
        evidence,
        relationsFrom,
        relationsTo,
        events: listEventRows(this.db, finding.id),
        docLinks: listDocLinks(this.db, finding.id),
      },
      warnings,
    };
  }

  // -------------------------------------------------------------- query_findings
  queryFindings(input, context = {}) {
    const project = this.ensureProject(context.project);
    const lifecycleStates =
      input.lifecycle_state === undefined
        ? ['current']
        : Array.isArray(input.lifecycle_state)
          ? input.lifecycle_state.map((value) => requireEnum(value, LIFECYCLE_STATES, 'lifecycle_state'))
          : [requireEnum(input.lifecycle_state, LIFECYCLE_STATES, 'lifecycle_state')];
    const epistemicStates =
      input.epistemic_state === undefined
        ? undefined
        : Array.isArray(input.epistemic_state)
          ? input.epistemic_state.map((value) => requireEnum(value, EPISTEMIC_STATES, 'epistemic_state'))
          : [requireEnum(input.epistemic_state, EPISTEMIC_STATES, 'epistemic_state')];
    const claimKinds =
      input.claim_kind === undefined
        ? undefined
        : Array.isArray(input.claim_kind)
          ? input.claim_kind.map((value) => requireEnum(value, CLAIM_KINDS, 'claim_kind'))
          : [requireEnum(input.claim_kind, CLAIM_KINDS, 'claim_kind')];
    const rows = listFindingRows(this.db, project.id, {
      lifecycleStates,
      epistemicStates,
      claimKinds,
      text: input.text === undefined ? null : requireString(input.text, 'text', { max: 200, allowEmpty: true }),
      limit: input.limit,
      offset: input.offset,
    });
    const includeEvidence = input.include_evidence === true;
    const findings = rows.map((finding) => {
      const entry = presentFinding(finding);
      if (includeEvidence) {
        entry.evidence = listEvidenceForFinding(this.db, finding.id);
      }
      return entry;
    });
    const warnings = [];
    if (findings.length === 0) {
      warnings.push(`no findings matched in project ${project.displayName}`);
    }
    return {
      data: {
        project: { identityKey: project.identityKey, displayName: project.displayName },
        count: findings.length,
        findings,
      },
      warnings,
    };
  }

  // ------------------------------------------------------------------- helpers
  projectSummary(project) {
    const row = projectById(this.db, project.id);
    return row ? { id: row.id, identityKey: row.identityKey, displayName: row.displayName } : null;
  }
}

function snapshot(finding) {
  return {
    claimKind: finding.claimKind,
    statement: finding.statement,
    epistemicState: finding.epistemicState,
    lifecycleState: finding.lifecycleState,
    retrievalPolicy: finding.retrievalPolicy,
    scope: finding.scope,
    tags: finding.tags,
  };
}

/** Compact projection returned by write endpoints and query results. */
export function presentFinding(finding) {
  return {
    ref: finding.ref,
    id: finding.id,
    claimKind: finding.claimKind,
    statement: finding.statement,
    details: finding.details,
    epistemicState: finding.epistemicState,
    lifecycleState: finding.lifecycleState,
    scope: finding.scope,
    tags: finding.tags,
    retrievalPolicy: finding.retrievalPolicy,
    createdAt: finding.createdAt,
    updatedAt: finding.updatedAt,
    lastValidatedAt: finding.lastValidatedAt,
  };
}

export { requireFinding };
