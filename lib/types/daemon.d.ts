/**
 * Public surface of the dsh-watch daemon host: a standing root session for a
 * watcher that runs with no human and no one-shot task.
 */
export declare const name: 'dsh-watch-daemon'
export declare const inject: readonly ['agentDefaultModel', 'agents', 'sessions']

/** Validated daemon config; see each field's JSDoc in lib/daemon.js. */
export declare const Config: unknown

/** The process stream the operator journal writes to; tests substitute a capture. */
export declare const internals: { stdout: { write(chunk: string): unknown } }

/** Mount the standing-agent host onto a context with the agent registry, default model, and sessions. */
export declare function apply(ctx: unknown, config: {
  brief: string
  flushIntervalMs: number
  journal: boolean
}): void
