/**
 * Public surface of the dsh-watch plugin. The plugin is a function
 * plugin (named exports, no default) mounted from cordis.patch.yml.
 */
export declare const name: 'dsh-watch'
export declare const inject: readonly ['tools', 'systemPrompt', 'jobs']

/** Validated deployment bounds; see each field's JSDoc in lib/index.js. */
export declare const Config: unknown

/**
 * Mount the `watch` tool and its delivery plumbing onto a harness
 * context with `tools`, `systemPrompt`, and `jobs` available.
 */
export declare function apply(ctx: unknown, config: {
  pollIntervalMs: number
  maxNoticeBytes: number
  maxConsecutiveWakes: number
  defaultMaxEvents: number
  maxListenersPerOwner: number
  backlogBytes: number
}): void
