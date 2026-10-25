/**
 * dsh-finding-ledger — evidence-backed findings for long-horizon troubleshooting.
 *
 * Cordis plugin entry point. The harness loads this package because
 * `cordis.patch.yml` inserts it into the composition; `inject` declares the
 * service this plugin needs before `apply` runs.
 *
 * A broken ledger must never take the host down with it, so `apply` catches
 * every startup failure, logs it, and leaves the harness untouched: the worst
 * case is a session without the ledger, never a session that cannot start.
 */
import { createRuntime } from './src/runtime.js';

export const name = 'dsh-finding-ledger';

export const inject = ['tools'];

export function apply(ctx, config = {}) {
  let runtime;
  try {
    runtime = createRuntime(ctx, config ?? {});
  } catch (error) {
    console.error('[finding-ledger] failed to start, ledger disabled for this session:', error);
    return;
  }
  if (!runtime) return;
  const dispose = () => {
    try {
      runtime.dispose();
    } catch (error) {
      console.error('[finding-ledger] dispose failed:', error);
    }
  };
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => dispose, 'dsh-finding-ledger');
  }
  return dispose;
}
