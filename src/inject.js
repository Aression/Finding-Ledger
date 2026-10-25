/**
 * Host integration: decide *when* the ledger is re-injected and build the message.
 *
 * The design's trigger list is new session / project init, after context
 * compaction, explicit query, and task switch. The harness exposes the message
 * array at `agent/pre-step`, which is the only hook that carries both the agent
 * and the ability to add a message, so injection happens there:
 *
 *  - `agent/created` (startup/resume/clear/compact) marks the session dirty;
 *  - a `compaction/*` session event marks it dirty again;
 *  - any ledger mutation bumps `service.revision`, which also triggers a refresh
 *    on the next step so newly logged findings are visible immediately.
 *
 * Identical consecutive payloads are suppressed, so a quiet session pays nothing.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildInjection } from './retrieval.js';
import { resolveProject } from './project.js';

const INJECTION_MARKER = '## Finding Ledger：当前任务相关发现';
const MAX_TRACKED_SESSIONS = 64;

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && typeof block === 'object' && block.type === 'text' ? String(block.text ?? '') : ''))
    .filter((text) => text !== '')
    .join('\n');
}

function cwdOfAgent(agent) {
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

function latestUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'user') continue;
    const text = textOfContent(message.content);
    if (text.includes(INJECTION_MARKER)) continue;
    if (text.trim() !== '') return text.slice(0, 4000);
  }
  return '';
}

/**
 * Build a user message from the real message shape rather than guessing its fields.
 * The prototype is preserved on purpose: if the host hands us a class instance,
 * a plain spread would drop its methods and the harness would choke on it later.
 */
function buildContextMessage(template, text) {
  const isObject = template !== null && typeof template === 'object';
  const prototype = (isObject && Object.getPrototypeOf(template)) || Object.prototype;
  const base = isObject ? { ...template } : {};
  const message = Object.assign(Object.create(prototype), base, {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
  if (isObject && 'id' in base) {
    message.id = globalThis.crypto?.randomUUID?.() ?? `fl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return message;
}

export class LedgerInjector {
  constructor({ service, config = {}, log = () => {}, injectLogPath = null }) {
    this.service = service;
    this.config = config;
    this.log = log;
    this.injectLogPath = typeof injectLogPath === 'string' && injectLogPath !== '' ? injectLogPath : null;
    if (this.injectLogPath) {
      try {
        mkdirSync(dirname(this.injectLogPath), { recursive: true });
      } catch (error) {
        this.log('could not prepare injection log:', error);
        this.injectLogPath = null;
      }
    }
    this.sessions = new Map();
    this.disposers = [];
    this.lastError = null;
    this.lastInjection = null;
    this.stats = {};
  }

  /**
   * Append one line to the injection audit log. The ledger's whole value rests
   * on being able to answer "what did the model actually see, and when?", and
   * an in-memory record dies with the process.
   */
  #audit(entry) {
    if (!this.injectLogPath) return;
    try {
      appendFileSync(this.injectLogPath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      this.log('could not write injection log:', error);
    }
  }

  attach(ctx) {
    const on = (event, handler) => {
      try {
        const disposer = ctx.on(event, handler);
        if (typeof disposer === 'function') this.disposers.push(disposer);
      } catch (error) {
        // One unavailable event must not cost us the other injection triggers.
        this.lastError = error;
        this.log(`could not listen to ${event}:`, error);
      }
    };

    const count = (name) => {
      this.stats[name] = (this.stats[name] ?? 0) + 1;
    };

    on('agent/created', (payload) => {
      count('agentCreated');
      const id = sessionIdOf(payload);
      if (!id) return;
      this.#touch(id).dirty = true;
    });

    on('agent/disposed', (payload) => {
      count('agentDisposed');
      const id = sessionIdOf(payload);
      if (id) this.sessions.delete(id);
    });

    on('session/event', (session, event) => {
      count('sessionEvents');
      const type = typeof event?.type === 'string' ? event.type : '';
      if (!type) return;
      if (type.includes('compact') || type.startsWith('compaction/')) {
        count('compactionEvents');
        const id = session?.id;
        if (typeof id === 'string' && id !== '') this.#touch(id).dirty = true;
      }
    });

    on('agent/pre-step', async (payload, next) => {
      // `agent/pre-step` is a waterfall: a listener that never calls `next()`
      // (or returns the wrong shape) breaks the turn, so bail out loudly but
      // harmlessly if the host ever hands us a plain emit-style call.
      count('preSteps');
      this.stats.lastPreStepAt = new Date().toISOString();
      if (typeof next !== 'function') {
        this.lastError = new Error('agent/pre-step listener was invoked without a waterfall next()');
        this.log('agent/pre-step: missing next(), skipping injection');
        return undefined;
      }
      let decision;
      try {
        decision = await next();
      } catch (error) {
        this.lastError = error;
        throw error;
      }
      try {
        if (!decision || decision.kind !== 'enter') return decision;
        count('preStepEnter');
        this.stats.lastPreStepMessageCount = Array.isArray(decision.messages) ? decision.messages.length : -1;
        this.#sampleShapes(payload, decision);
        const injected = this.#maybeBuildMessage(payload, decision);
        if (!injected) return decision;
        return { ...decision, messages: [...decision.messages, injected] };
      } catch (error) {
        // Never break the turn because the ledger is unavailable.
        this.lastError = error;
        this.log('injection failed:', error);
        return decision;
      }
    });
  }

  /**
   * Record what the host actually hands us, without mutating it. The exact
   * UserMessage shape is not part of the published plugin contract, so the
   * first real sample is the only reliable template for a synthetic message.
   */
  #sampleShapes(payload, decision) {
    if (this.stats.lastMessageSample !== undefined) return;
    const messages = Array.isArray(decision.messages) ? decision.messages : [];
    const message = messages.find((entry) => entry && typeof entry === 'object');
    if (!message) return;
    const sample = { keys: Object.keys(message), decisionKeys: Object.keys(decision) };
    try {
      sample.json = JSON.stringify(message).slice(0, 1200);
    } catch (error) {
      sample.json = `unserializable: ${String(error && error.message ? error.message : error)}`;
    }
    sample.proto = Object.getPrototypeOf(message) === Object.prototype ? 'Object.prototype' : 'class';
    sample.payloadMessageCount = Array.isArray(payload?.messages) ? payload.messages.length : -1;
    this.stats.lastMessageSample = sample;
  }

  /** Compute the injection message for this step, or null when nothing is due. */
  #maybeBuildMessage(payload, decision) {
    if (this.config.inject === false) return null;
    const agent = payload?.agent;
    const sessionId = sessionIdOf(payload) ?? 'unknown';
    const state = this.#touch(sessionId);
    if (state.stepKey === `${payload.turn}:${payload.step}`) return null;

    const messages = Array.isArray(decision.messages) ? decision.messages : [];
    const revisionChanged = state.revision !== this.service.revision;
    const forced = state.dirty === true;
    if (!forced && !(revisionChanged && messages.length > 0)) return null;
    // Remember a real host message: the plugin contract does not publish the
    // UserMessage shape, so a captured instance is the only safe template when
    // a later step (e.g. the one right after compaction) carries no message.
    if (messages.length > 0) state.template = messages[messages.length - 1];

    const cwd = cwdOfAgent(agent);
    const project = resolveProject(cwd);
    const projectRow = this.service.ensureProject(project);
    const taskContext = {
      goal: latestUserText(messages),
      tags: [],
      files: [],
      events: [],
    };
    const budgetTokens = Number.isFinite(this.config.injectBudgetTokens) ? this.config.injectBudgetTokens : 700;
    const result = buildInjection(this.service, { projectId: projectRow.id, taskContext, budgetTokens });

    state.revision = this.service.revision;
    state.dirty = false;
    state.stepKey = `${payload.turn}:${payload.step}`;
    state.injected += 1;
    this.lastInjection = {
      at: new Date().toISOString(),
      sessionId,
      project: project.identityKey,
      included: result.included,
      dropped: result.dropped.length,
      estimatedTokens: result.estimatedTokens,
    };

    if (!result.text) return null;
    const fingerprint = createHash('sha256').update(result.text).digest('hex');
    if (state.fingerprint === fingerprint) return null;
    state.fingerprint = fingerprint;

    const template =
      messages[0] ??
      state.template ??
      messages[messages.length - 1] ?? {
        id: globalThis.crypto?.randomUUID?.() ?? 'fl-message',
        role: 'user',
        content: [],
        source: { kind: 'user' },
      };
    const message = buildContextMessage(template, result.text);
    this.#audit({
      at: this.lastInjection.at,
      sessionId,
      project: this.lastInjection.project,
      turn: payload?.turn ?? null,
      step: payload?.step ?? null,
      included: result.included,
      dropped: result.dropped.length,
      estimatedTokens: result.estimatedTokens,
      fingerprint,
    });
    return message;
  }

  #touch(sessionId) {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        dirty: false,
        revision: -1,
        stepKey: null,
        fingerprint: null,
        template: null,
        injected: 0,
        touchedAt: Date.now(),
      };
      this.sessions.set(sessionId, state);
      if (this.sessions.size > MAX_TRACKED_SESSIONS) {
        let oldestKey = null;
        let oldestAt = Infinity;
        for (const [key, value] of this.sessions) {
          if (value.touchedAt < oldestAt) {
            oldestAt = value.touchedAt;
            oldestKey = key;
          }
        }
        if (oldestKey !== null && oldestKey !== sessionId) this.sessions.delete(oldestKey);
      }
    }
    state.touchedAt = Date.now();
    return state;
  }

  /** Diagnostics for the `ledger_status` tool: why did (or didn't) we inject? */
  status() {
    const sessions = [];
    for (const [sessionId, state] of this.sessions) {
      sessions.push({
        sessionId,
        dirty: state.dirty,
        injected: state.injected,
        behindRevision: state.revision !== this.service.revision,
        touchedAt: new Date(state.touchedAt).toISOString(),
      });
    }
    return {
      enabled: this.config.inject !== false,
      budgetTokens: Number.isFinite(this.config.injectBudgetTokens) ? this.config.injectBudgetTokens : 700,
      listenerCount: this.disposers.length,
      eventCounts: { ...this.stats },
      injectLogPath: this.injectLogPath,
      lastInjection: this.lastInjection,
      lastError: this.lastError ? String(this.lastError.message ?? this.lastError) : null,
      sessions,
    };
  }

  dispose() {
    for (const disposer of this.disposers.splice(0)) {
      try {
        disposer();
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
  }
}

function sessionIdOf(payload) {
  const candidate = payload?.agent?.id ?? payload?.session?.id ?? payload?.id;
  return typeof candidate === 'string' && candidate !== '' ? candidate : null;
}
