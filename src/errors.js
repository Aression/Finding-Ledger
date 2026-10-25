/** Stable error codes shared by every tool response. */
export const ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  NOT_FOUND: 'NOT_FOUND',
  PROJECT_SCOPE_MISMATCH: 'PROJECT_SCOPE_MISMATCH',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  EVIDENCE_REQUIRED: 'EVIDENCE_REQUIRED',
  RELATION_CYCLE: 'RELATION_CYCLE',
  CONCURRENT_MODIFICATION: 'CONCURRENT_MODIFICATION',
  STORAGE_ERROR: 'STORAGE_ERROR',
});

export class LedgerError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export const invalidArgument = (message, details) => new LedgerError(ERROR_CODES.INVALID_ARGUMENT, message, details);
export const notFound = (message, details) => new LedgerError(ERROR_CODES.NOT_FOUND, message, details);
export const scopeMismatch = (message, details) => new LedgerError(ERROR_CODES.PROJECT_SCOPE_MISMATCH, message, details);
export const invalidTransition = (message, details) =>
  new LedgerError(ERROR_CODES.INVALID_STATE_TRANSITION, message, details);
export const evidenceRequired = (message, details) => new LedgerError(ERROR_CODES.EVIDENCE_REQUIRED, message, details);
export const relationCycle = (message, details) => new LedgerError(ERROR_CODES.RELATION_CYCLE, message, details);
export const concurrentModification = (message, details) =>
  new LedgerError(ERROR_CODES.CONCURRENT_MODIFICATION, message, details);
export const storageError = (message, details) => new LedgerError(ERROR_CODES.STORAGE_ERROR, message, details);

/** Normalize any thrown value into the `error` half of a tool response. */
export function toErrorPayload(error) {
  if (error instanceof LedgerError) return error.toJSON();
  if (error && typeof error === 'object' && typeof error.code === 'string') {
    return { code: error.code, message: String(error.message ?? error.code), details: error.details ?? null };
  }
  return {
    code: ERROR_CODES.STORAGE_ERROR,
    message: error instanceof Error ? error.message : String(error),
    details: null,
  };
}

/** Run `fn` and convert the outcome into the uniform `{ ok, data, warnings, error }` envelope. */
export function envelope(fn) {
  try {
    const { data, warnings } = fn() ?? {};
    return { ok: true, data: data ?? null, warnings: warnings ?? [], error: null };
  } catch (error) {
    return { ok: false, data: null, warnings: [], error: toErrorPayload(error) };
  }
}
