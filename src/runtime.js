/**
 * Runtime assembly: open the database, build the service, register the tools,
 * attach the injector. `createRuntime` returns a disposer so the plugin unloads
 * cleanly.
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { openLedgerDatabase } from './db.js';
import { LedgerService } from './service.js';
import { LedgerInjector } from './inject.js';
import { createToolDefinitions } from './tools.js';
import { storageError } from './errors.js';

const DEFAULT_DIR = '.dsh/finding-ledger';

export function defaultDatabasePath() {
  return join(homedir(), DEFAULT_DIR, 'ledger.db');
}

export function createRuntime(ctx, config = {}) {
  const log = (...args) => {
    if (config.debug) console.warn('[finding-ledger]', ...args);
  };
  const dbPath = typeof config.dbPath === 'string' && config.dbPath !== '' ? config.dbPath : defaultDatabasePath();
  const db = openLedgerDatabase(dbPath);
  const service = new LedgerService(db, config);
  const disposers = [];
  const toolNames = [];

  if (config.tools !== false) {
    for (const definition of createToolDefinitions({ service, config })) {
      const dispose = ctx.tools.register(definition);
      toolNames.push(definition.name);
      if (typeof dispose === 'function') disposers.push(dispose);
    }
  }

  const injectLogPath =
    config.injectLog === false
      ? null
      : typeof config.injectLog === 'string' && config.injectLog !== ''
        ? config.injectLog
        : dbPath === ':memory:'
          ? null
          : join(dirname(dbPath), 'injections.jsonl');

  const injector = new LedgerInjector({ service, config, log, injectLogPath });
  injector.attach(ctx);

  /** Read-only diagnostics: "is the ledger healthy, and why did nothing get injected?" */
  const statusDefinition = {
    name: 'ledger_status',
    description:
      'Report Finding Ledger diagnostics: database path, record counts, current revision, which injection triggers fired, the last injection and the last injection error. Read-only. Use it when findings do not appear in the conversation.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }],
    },
    async execute() {
      const count = (sql) => db.prepare(sql).get().n;
      return {
        ok: true,
        data: {
          dbPath,
          revision: service.revision,
          tools: toolNames,
          counts: {
            projects: count('SELECT COUNT(*) AS n FROM projects'),
            findings: count('SELECT COUNT(*) AS n FROM findings'),
            currentFindings: count("SELECT COUNT(*) AS n FROM findings WHERE lifecycle_state = 'current'"),
            evidence: count('SELECT COUNT(*) AS n FROM evidence'),
            events: count('SELECT COUNT(*) AS n FROM finding_events'),
          },
          injection: injector.status(),
        },
        warnings: [],
        error: null,
      };
    },
  };
  const statusDispose = ctx.tools.register(statusDefinition);
  toolNames.push(statusDefinition.name);
  if (typeof statusDispose === 'function') disposers.push(statusDispose);

  const runtime = {
    db,
    dbPath,
    service,
    injector,
    toolNames,
    get revision() {
      return service.revision;
    },
    dispose() {
      injector.dispose();
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch (error) {
          log('tool dispose failed:', error);
        }
      }
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };

  log(`ready at ${dbPath} with ${toolNames.length} tools`);
  return runtime;
}

export { storageError };
