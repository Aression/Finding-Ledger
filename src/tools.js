/**
 * The ten tools exposed to the agent.
 *
 * Descriptions carry the discipline the design asks for: say what the tool
 * guarantees, when to reach for it, and which shortcut it refuses, so the model
 * does not have to rediscover the rules from error messages.
 */
import { parametersSchema, scopeSpec, stringArray } from './schema.js';
import { envelope, invalidArgument } from './errors.js';
import { resolveProject, resolveProjectFromSelector } from './project.js';

const CLAIM_KIND_VALUES = ['observation', 'diagnosis', 'constraint', 'decision', 'procedure'];
const EPISTEMIC_VALUES = [
  'unassessed',
  'provisional',
  'supported',
  'contested',
  'refuted',
  'inconclusive',
  'not_applicable',
];
const LIFECYCLE_VALUES = ['current', 'superseded', 'withdrawn', 'archived'];
const RETRIEVAL_VALUES = ['always', 'relevant', 'on_demand', 'never'];
const SOURCE_VALUES = [
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
];
const RELATION_VALUES = ['supersedes', 'derived_from', 'contradicts', 'duplicate_of', 'related_to'];
const LINK_TYPE_VALUES = ['attribution', 'rule_source', 'supporting_doc'];

const textBlocks = (value) => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2) },
];

function tool({ name, description, parameters, execute, timeoutMs }) {
  return {
    name,
    description,
    parameters: parametersSchema(parameters),
    output: { schema: {}, render: (_args, value) => textBlocks(value ?? null) },
    ...(timeoutMs ? { timeoutMs } : {}),
    execute,
  };
}

const projectParam = {
  type: 'string',
  description:
    'Optional project selector: a directory path, "git:owner/repo", or "dir:/abs/path". Defaults to the session working directory.',
};

function cwdFromExec(exec) {
  const agent = exec?.agent;
  try {
    const cwd = agent?.session?.header?.cwd;
    if (typeof cwd === 'string' && cwd !== '') return cwd;
  } catch {
    /* fall through */
  }
  try {
    const workingDirectory = agent?.ctx?.get?.('workingDirectory');
    if (typeof workingDirectory?.defaultDirectory === 'string') return workingDirectory.defaultDirectory;
  } catch {
    /* fall through */
  }
  return process.cwd();
}

function contextFor(service, config, args, exec) {
  const selector = args?.project ?? config.defaultProject;
  let project = selector ? resolveProjectFromSelector(selector) : null;
  if (!project) {
    if (selector) throw invalidArgument(`could not resolve project selector: ${selector}`);
    project = resolveProject(cwdFromExec(exec));
  }
  const agentId = (() => {
    try {
      return typeof exec?.agent?.id === 'string' ? exec.agent.id : null;
    } catch {
      return null;
    }
  })();
  return {
    project,
    sessionId: agentId,
    seq: null,
    actor: 'agent',
  };
}

export function createToolDefinitions({ service, config = {} }) {
  const run = (args, exec, fn) =>
    envelope(() => {
      const context = contextFor(service, config, args, exec);
      return fn(args ?? {}, context);
    });

  return [
    tool({
      name: 'log_finding',
      description: [
        'Record one durable finding in the project finding ledger so it survives context compaction, session switches and handovers.',
        'Use it for claims worth re-reading later: an observed symptom, a diagnosis, a hard constraint, a decision with its reason, or a reproduction procedure.',
        'A new finding starts as `unassessed`/`provisional`; it cannot be created as `supported` (attach evidence first) or `refuted` (use refute_finding).',
        'Log evidence-shaped breadth as separate findings rather than one long paragraph: one claim per finding keeps later revalidation honest.',
      ].join(' '),
      parameters: {
        statement: { type: 'string', required: true, description: 'The single claim, stated so it can be checked later.' },
        claim_kind: { type: 'string', required: true, enum: CLAIM_KIND_VALUES, description: 'What kind of claim this is.' },
        details: { type: 'string', description: 'Reasoning, scope of applicability, or the reproduction recipe. Secrets are redacted.' },
        epistemic_state: {
          type: 'string',
          enum: EPISTEMIC_VALUES.filter((value) => value !== 'refuted'),
          description: 'Starting epistemic state; defaults to unassessed. `supported` requires evidence, so it is rejected here.',
        },
        retrieval_policy: {
          type: 'string',
          enum: RETRIEVAL_VALUES,
          description: 'How eagerly this finding should be injected later: always | relevant (default) | on_demand | never.',
        },
        scope: scopeSpec,
        tags: stringArray('Free-form labels used for task relevance and filtering.'),
        reason: { type: 'string', description: 'Why this is being recorded now (kept in the audit log).' },
        project: projectParam,
      },
      execute: (args, exec) => run(args, exec, (a, context) => service.logFinding(a, context)),
    }),

    tool({
      name: 'query_findings',
      description: [
        'List findings from the project ledger with filters. Defaults to lifecycle=current and excludes superseded/withdrawn/archived records.',
        'Use it at the start of a session or a new subtask to recover what is already known, and to check whether a suspicion was already refuted before spending turns re-testing it.',
      ].join(' '),
      parameters: {
        text: { type: 'string', description: 'Case-insensitive substring match on statement/details.' },
        claim_kind: { oneOf: [{ type: 'string', enum: CLAIM_KIND_VALUES }, { type: 'array', items: { type: 'string', enum: CLAIM_KIND_VALUES } }], description: 'Filter by one or more claim kinds.' },
        epistemic_state: {
          oneOf: [{ type: 'string', enum: EPISTEMIC_VALUES }, { type: 'array', items: { type: 'string', enum: EPISTEMIC_VALUES } }],
          description: 'Filter by epistemic state.',
        },
        lifecycle_state: {
          oneOf: [{ type: 'string', enum: LIFECYCLE_VALUES }, { type: 'array', items: { type: 'string', enum: LIFECYCLE_VALUES } }],
          description: 'Filter by lifecycle state; defaults to current only.',
        },
        include_evidence: { type: 'boolean', description: 'Attach the full evidence rows to every finding (verbose).' },
        limit: { type: 'integer', description: 'Max findings to return (default 50, max 500).', minimum: 1, maximum: 500 },
        offset: { type: 'integer', description: 'Pagination offset.', minimum: 0 },
        project: projectParam,
      },
      execute: (args, exec) => run(args, exec, (a, context) => service.queryFindings(a, context)),
    }),

    tool({
      name: 'get_finding',
      description:
        'Read one finding in full: both orthogonal states, scope, every evidence row with its relation, relations to other findings, doc links and the complete audit timeline.',
      parameters: {
        finding_id: { type: 'string', required: true, description: 'Finding reference, e.g. "F-12" or 12.' },
        project: projectParam,
      },
      execute: (args, exec) => run(args, exec, (a, context) => service.getFinding(a, context)),
    }),

    tool({
      name: 'add_evidence',
      description: [
        'Attach evidence to an existing finding and classify it as supports / contradicts / context.',
        'Prefer a small decisive excerpt plus an exact locator (path:line, command, commit, URL) over a long paste: the point is that a later session can re-check it.',
        'Adding evidence never changes the epistemic state on its own — promote explicitly with set_finding_state once the support is decisive.',
      ].join(' '),
      parameters: {
        finding_id: { type: 'string', required: true, description: 'Finding reference, e.g. "F-12".' },
        source_kind: { type: 'string', required: true, enum: SOURCE_VALUES, description: 'Where the evidence came from.' },
        source_ref: { type: 'string', required: true, description: 'Path, command, commit sha, URL, test name, etc.' },
        relation: { type: 'string', enum: ['supports', 'contradicts', 'context'], description: 'How this evidence bears on the claim; default supports.' },
        locator: { type: 'string', description: 'Precise position inside the source, e.g. "src/db.js:118" or "stdout line 42".' },
        revision: { type: 'string', description: 'Revision the evidence was captured at (commit sha, file hash, image tag).' },
        excerpt: { type: 'string', description: 'Short verbatim fragment that justifies the relation. Secrets are redacted.' },
        method: { type: 'string', description: 'How the evidence was obtained, e.g. "reproduced test", "read source", "log grep".' },
        rationale: { type: 'string', description: 'One sentence tying the excerpt to the claim.' },
        captured_at: { type: 'string', description: 'ISO timestamp of capture; defaults to now.' },
        project: projectParam,
      },
      execute: (args, exec) => run(args, exec, (a, context) => service.addEvidence(a, context)),
    }),

    tool({
      name: 'set_finding_state',
      description: [
        'Move a finding through the explicit epistemic/lifecycle state machine and audit the change.',
        'Refused shortcuts: `refuted` must go through refute_finding, `superseded` through supersede_finding, and `supported` needs at least one supporting evidence row.',
        'A refuted finding cannot be revived here — use revalidate_finding, which records why the refutation no longer holds.',
      ].join(' '),
      parameters: {
        finding_id: { type: 'string', required: true, description: 'Finding reference, e.g. "F-12".' },
        epistemic_state: { type: 'string', enum: EPISTEMIC_VALUES.filter((value) => value !== 'refuted'), description: 'Target epistemic state.' },
        lifecycle_state: {
          type: 'string',
          enum: LIFECYCLE_VALUES.filter((value) => value !== 'superseded'),
          description: 'Target lifecycle state.',
        },
        reason: { type: 'string', description: 'Why the state changed; required to keep the audit trail meaningful.' },
        expected_updated_at: { type: 'string', description: 'Optimistic concurrency guard: the updatedAt you read.' },
        project: projectParam,
      },
      execute: (args, exec) => run(args, exec, (a, context) => service.setFindingState(a, context)),
    }),

    tool({
      name: 'refute_finding',
      description: [
        'Retire a claim as false in one transaction: records contradicting evidence, links it, sets epistemic=refuted and keeps lifecycle=current so later sessions treat it as a documented dead end instead of a fresh idea.',
        'Use it the moment an experiment proves a hypothesis wrong; that is exactly the knowledge a compacted session loses first.',
      ].join(' '),
      parameters: {
        finding_id: { type: 'string', required: true, description: 'Finding reference, e.g. "F-12".' },
        reason: { type: 'string', required: true, description: 'What disproved it, in one or two sentences.' },
        source_kind: { type: 'string', required: true, enum: SOURCE_VALUES, description: 'Where the contradicting evidence came from.' },
        source_ref: { type: 'string', required: true, description: 'Path, command, commit, URL, test name.' },
        excerpt: { type: 'string', description: 'The decisive fragment. Secrets are redacted.' },
        locator: { type: 'string', description: 'Precise position inside the source.' },
        revision: { type: 'string', description: 'Revision the refutation was captured at.' },
        project: projectParam,
      },
      execute: (args, exec) => run(args, exec, (a, context) => service.refuteFinding(a, context)),
    }),

    tool({
      name: 'supersede_finding',
      description: [
        'Replace a finding with a corrected version in one transaction: creates the replacement, links supersedes (new -> old), retires the old record and logs both events.',
        'Use it when the claim itself changed (a narrower scope, a corrected mechanism), not when it turned out false — that is refute_finding, and the two are never interchangeable.',
      ].join(' '),
      parameters: {
        supersedes: { type: 'string', required: true, description: 'The finding being replaced, e.g. "F-12".' },
        reason: { type: 'string', required: true, description: 'What changed and why the old claim no longer holds in its old form.' },
        replacement: {
          type: 'object',
          description:
            'Fields for the new finding; omitted fields are inherited from the old one. statement/details should make the revision explicit.',
          properties: {
            statement: { type: 'string' },
            details: { type: 'string' },
            claim_kind: { type: 'string', enum: CLAIM_KIND_VALUES },
            epistemic_state: { type: 'string', enum: ['unassessed', 'provisional', 'contested', 'inconclusive', 'not_applicable'] },
            retrieval_policy: { type: 'string', enum: RETRIEVAL_VALUES },
            scope: scopeSpec,
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
        project: projectParam,
      },
      execute: (args, exec) => run(args, exec, (a, context) => service.supersedeFinding(a, context)),
    }),

    tool({
      name: 'revalidate_finding',
      description: [
        'Re-check a finding against the current environment and record the outcome: refreshes last_validated_at, may narrow/refresh its scope, and lifts a refutation when the conditions that caused it are gone.',
        'Use it after a branch switch, dependency upgrade, config change or environment change — anything the finding listed in scope.revalidate_on.',
      ].join(' '),
      parameters: {
        finding_id: { type: 'string', required: true, description: 'Finding reference, e.g. "F-12".' },
        reason: { type: 'string', required: true, description: 'What you re-checked and what you saw.' },
        epistemic_state: {
          type: 'string',
          enum: EPISTEMIC_VALUES.filter((value) => value !== 'refuted'),
          description: 'Target epistemic state; defaults to provisional (or inconclusive when lifting a refutation).',
        },
        scope: scopeSpec,
        source_kind: { type: 'string', enum: SOURCE_VALUES, description: 'Optional: record the re-check itself as context evidence.' },
        source_ref: { type: 'string', description: 'Source of the re-check evidence; required when source_kind is given.' },
        excerpt: { type: 'string', description: 'What the re-check showed.' },
        locator: { type: 'string', description: 'Precise position inside the source.' },
        revision: { type: 'string', description: 'Revision the re-check ran at.' },
        project: projectParam,
      },
      execute: (args, exec) => run(args, exec, (a, context) => service.revalidateFinding(a, context)),
    }),

    tool({
      name: 'link_finding',
      description: [
        'Relate two findings: supersedes / derived_from / contradicts / duplicate_of / related_to. Cycles are rejected and self-links refused.',
        'Links are what keep a multi-step investigation navigable after compaction: a derived conclusion can always be walked back to the observation it came from.',
      ].join(' '),
      parameters: {
        from: { type: 'string', required: true, description: 'Source finding reference, e.g. "F-12".' },
        relation: { type: 'string', required: true, enum: RELATION_VALUES, description: 'Relation kind, read as from -> to.' },
        to: { type: 'string', required: true, description: 'Target finding reference, e.g. "F-7".' },
        reason: { type: 'string', required: true, description: 'Why these two are related.' },
        project: projectParam,
      },
      execute: (args, exec) => run(args, exec, (a, context) => service.linkFinding(a, context)),
    }),

    tool({
      name: 'propose_rule',
      description: [
        'Propose promoting a supported/provisional finding into a project document (AGENTS.md, a runbook, a design note) by recording a pending doc link.',
        'This deliberately does NOT edit any document: promotion is a user-approved step, so the tool records intent, the anchor and the exact text to add, and returns applied=false.',
      ].join(' '),
      parameters: {
        finding_id: { type: 'string', required: true, description: 'Finding reference, e.g. "F-12".' },
        doc_path: { type: 'string', required: true, description: 'Target document path, relative to the project root.' },
        anchor: { type: 'string', description: 'Section or heading the rule belongs under.' },
        link_type: { type: 'string', enum: LINK_TYPE_VALUES, description: 'Why the document should reference this finding.' },
        proposed_text: { type: 'string', description: 'The exact sentence(s) to add; defaults to the finding statement.' },
        reason: { type: 'string', description: 'Why this belongs in the document.' },
        project: projectParam,
      },
      execute: (args, exec) => run(args, exec, (a, context) => service.proposeRule(a, context)),
    }),
  ];
}
