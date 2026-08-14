/**
 * dsh-watch — background stream listeners that wake the agent.
 *
 * The `watch` tool drops a listener on a long-running command or a
 * growing file. New (optionally pattern-matched) lines are batched per poll
 * tick and delivered into the owning session as plugin notices: an idle owner
 * is woken (`followup`, bounded by a consecutive-wake budget the way
 * `dsh-tool-jobs` bounds completion notices), a busy owner has the notice
 * queued into its next step (`inject`).
 *
 * Every listener is a first-class background job (kind `watch`) started
 * through `ctx.jobs`, so the standard job surface applies unchanged:
 * `job_list` shows armed listeners, `job_output` drains a listener's heard-line
 * backlog, `job_kill` disarms, ownership is session-fenced, and settlement
 * rides the ordinary completion notice. This plugin adds only the listening.
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { chopFileWindow, compileFilter, createBacklog, createLineBuffer, formatNotice } from './core.js'

export const name = 'dsh-watch'
export const inject = ['tools', 'systemPrompt', 'jobs']

/**
 * Deployment-tunable bounds. Everything that varies by deployment is a
 * validated Config field; the only fixed constant is the per-tick file read
 * window, an implementation bound rather than a policy choice.
 */
export const Config = z.object({
  /** Poll cadence for every listener (ms). The tick is also the batch window: all lines heard in one tick share one notice. */
  pollIntervalMs: z.number().min(50).default(300),
  /** UTF-8 byte cap for one complete wake-up notice, header included. */
  maxNoticeBytes: z.number().min(256).default(4096),
  /** Consecutive idle wake-ups per owner before notices queue instead; a claimed user message refills the budget. */
  maxConsecutiveWakes: z.number().min(0).default(3),
  /** Default notice budget per listener; the listener settles `completed` when spent. The tool's `max_events` overrides per call. */
  defaultMaxEvents: z.number().min(1).default(50),
  /** Armed-listener cap per owning agent; arming beyond it fails the tool call. */
  maxListenersPerOwner: z.number().min(1).default(8),
  /** Retained-bytes budget for each listener's `job_output` backlog. */
  backlogBytes: z.number().min(1024).default(65536),
})

/** Per-tick file read window (bytes). One oversized line cannot stall the tail: a full window with no newline is consumed as one line. */
const READ_WINDOW = 1 << 20

/**
 * Mount the `watch` tool and its delivery plumbing.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context with `tools`, `systemPrompt`, and `jobs` injected.
 * @param {ReturnType<typeof Config>} config - validated deployment bounds.
 */
export function apply(ctx, config) {
  /** @type {WeakMap<object, number>} consecutive idle wakes spent per owner. */
  const spentWakes = new WeakMap()
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    // Claiming is the point the human's input enters a step; a notice this
    // plugin queued must not refill the budget it just spent.
    if (message.source.kind === 'user') spentWakes.delete(agent)
  })

  /** @type {Map<string, { teardown(): void, owner: object | undefined }>} live listeners by job id, for capacity checks and plugin-disposal teardown. */
  const active = new Map()
  ctx.effect(() => () => {
    for (const listener of active.values()) listener.teardown()
    active.clear()
  })

  ctx.systemPrompt.section({
    name: 'tool:watch',
    order: 107,
    text: 'You can arm a watch on a stream with the watch tool: it listens in the background and wakes you when new matching lines arrive, so never busy-poll a source you already listen to. Listeners are background jobs — job_list shows them, job_output reads a listener\'s heard-line backlog, job_kill disarms one.',
  })

  /**
   * Deliver one batch of heard lines to the listener's owner.
   * @param {object} listener - the armed listener record.
   * @param {string[]} lines - matched lines heard this tick, arrival order.
   */
  function deliver(listener, lines) {
    const owner = listener.owner
    if (owner === undefined || lines.length === 0) return
    const { text, summary } = formatNotice(listener.label, listener.jobId, lines, config.maxNoticeBytes)
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: name, form: 'notice', summary: boundContextSummary(summary) },
    })
    const spent = spentWakes.get(owner) ?? 0
    if (owner.status === 'idle' && spent < config.maxConsecutiveWakes) {
      spentWakes.set(owner, spent + 1)
      owner.followup(message)
      return
    }
    owner.inject(message)
  }

  /**
   * Filter, log, and deliver one tick's lines; spend the notice budget.
   * @param {object} listener - the armed listener record.
   * @param {string[]} lines - complete lines heard this tick.
   * @param {boolean} [final] - deliver even though the listener already
   *   stopped (the settling flush of a naturally ended stream).
   */
  function emit(listener, lines, final = false) {
    if ((listener.stopped && !final) || lines.length === 0) return
    const heard = listener.filter === undefined ? lines : lines.filter(line => listener.filter.test(line))
    if (heard.length === 0) return
    for (const line of heard) listener.backlog.push(line)
    deliver(listener, heard)
    listener.notices += 1
    if (!final && listener.notices >= listener.maxEvents) listener.exhaust()
  }

  /**
   * The listener created by the most recent `run()`, captured so `execute`
   * can stamp the registry-issued job id after `jobs.start` returns.
   * `jobs.start` calls `run()` synchronously, so this never crosses calls.
   * @type {object | undefined}
   */
  let lastArmed

  /**
   * Shared listener scaffolding: state, poll timer, and teardown.
   * @param {object} spec - label, filter, maxEvents, owner, and the per-source `tick`.
   */
  function createListener(spec) {
    const listener = {
      jobId: '(arming)',
      label: spec.label,
      owner: spec.owner,
      filter: spec.filter,
      maxEvents: spec.maxEvents,
      backlog: createBacklog(config.backlogBytes),
      notices: 0,
      stopped: false,
      budgetExhausted: false,
      disarmed: false,
      timer: /** @type {ReturnType<typeof setInterval> | undefined} */ (undefined),
      stop() {
        if (listener.stopped) return
        listener.stopped = true
        if (listener.timer !== undefined) clearInterval(listener.timer)
        active.delete(listener.jobId)
      },
      teardown() {
        listener.disarmed = true
        listener.stop()
        spec.onTeardown?.()
      },
      exhaust() {
        listener.budgetExhausted = true
        listener.stop()
        spec.onExhaust?.(listener)
      },
    }
    lastArmed = listener
    // Global timers with disposal registered on the listener are the harness
    // convention for plugin-armed schedules; the timer-service mixin resolves
    // only from the host context, not tool-execution contexts.
    listener.timer = setInterval(() => {
      try {
        spec.tick(listener)
      } catch (error) {
        ctx.logger.warn(`dsh-watch ${listener.jobId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, config.pollIntervalMs)
    return listener
  }

  /**
   * Arm a listener on a long-running command via the shell capability, as an
   * owned background job.
   */
  function armCommand(args, exec, label, filter, maxEvents) {
    const shell = ctx.get('shell')
    if (shell === undefined) {
      throw new Error('watch: command sources need the shell capability (load @deepseek-ai/dsh-shell and a provider)')
    }
    const dshEnv = ctx.get('shellEnv')?.collect(exec)
    const sandboxPolicy = ctx.get('sandboxPolicy')?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
    const request = {
      command: args.command,
      ...args.workdir !== undefined ? { workdir: args.workdir } : {},
      ...dshEnv !== undefined ? { dshEnv } : {},
      ...sandboxPolicy !== undefined ? { sandboxPolicy } : {},
    }
    return ctx.jobs.start({
      kind: 'watch',
      label: `watch: ${args.command}`,
      outputLimitBytes: config.maxNoticeBytes,
      ...exec.agent !== undefined ? { owner: exec.agent } : {},
      run: () => {
        const proc = shell.start(shell.resolve(request))
        const lineBuffer = createLineBuffer()
        const listener = createListener({
          label,
          owner: exec.agent,
          filter,
          maxEvents,
          onTeardown: () => void proc.kill(),
          // The kill settles `done`, whose chain reports the spent budget.
          onExhaust: () => void proc.kill(),
          tick: (self) => {
            const read = proc.readOutput()
            const lines = lineBuffer.feed(read.delta)
            if (read.lossy) lines.push('[watch: upstream output was truncated; some lines were lost]')
            emit(self, lines)
          },
        })
        return {
          cancel: () => {
            listener.disarmed = true
            listener.stop()
            void proc.kill()
          },
          done: proc.done.then(() => {
            // Hear everything the process said before it closed, then settle.
            const finalRead = proc.readOutput()
            const lines = lineBuffer.feed(finalRead.delta)
            lines.push(...lineBuffer.flush())
            if (finalRead.lossy) lines.push('[watch: upstream output was truncated; some lines were lost]')
            if (!listener.disarmed && !listener.budgetExhausted) emit(listener, lines, true)
            listener.stop()
            return commandOutcome(listener, proc)
          }),
          readOutput: () => listener.backlog.drain(),
        }
      },
    })
  }

  /** Map a settled listener process to its job outcome. */
  function commandOutcome(listener, proc) {
    if (listener.budgetExhausted) {
      return { status: 'completed', detail: `event budget exhausted after ${listener.notices} notice(s)` }
    }
    if (listener.disarmed) return { status: 'killed', detail: 'watch disarmed' }
    if (proc.signal !== null) return { status: 'killed', detail: `signal: ${proc.signal}` }
    if (proc.exitCode === 0) return { status: 'completed', detail: 'stream ended (exit code: 0)' }
    return { status: 'failed', detail: `stream died (exit code: ${proc.exitCode})` }
  }

  /**
   * Arm a listener tailing a file from its current end, as an owned virtual
   * job (no process; cancellation settles it directly).
   */
  function armFile(args, exec, label, filter, maxEvents) {
    const path = isAbsolute(args.path) ? args.path : resolvePath(process.cwd(), args.path)
    return ctx.jobs.start({
      kind: 'watch',
      label: `watch: ${path}`,
      outputLimitBytes: config.maxNoticeBytes,
      ...exec.agent !== undefined ? { owner: exec.agent } : {},
      run: () => {
        // Tail from the current end: pre-existing content is never delivered.
        let cursor = 0
        try {
          cursor = statSync(path).size
        } catch {
          // Absent file: start at 0 so content is heard from its first byte
          // once the file appears.
        }
        /** @type {(outcome: { status: string, detail: string }) => void} */
        let settle = () => {}
        let settled = false
        const done = new Promise((res) => {
          settle = (outcome) => {
            if (settled) return
            settled = true
            res(outcome)
          }
        })
        const listener = createListener({
          label,
          owner: exec.agent,
          filter,
          maxEvents,
          onTeardown: () => settle({ status: 'killed', detail: 'watch disarmed' }),
          onExhaust: self => settle({ status: 'completed', detail: `event budget exhausted after ${self.notices} notice(s)` }),
          tick: (self) => {
            let size
            try {
              size = statSync(path).size
            } catch {
              return // file absent (yet); keep listening
            }
            if (size < cursor) cursor = 0 // truncated or rotated: restart from the top
            if (size === cursor) return
            const len = Math.min(size - cursor, READ_WINDOW)
            const buf = Buffer.alloc(len)
            const fd = openSync(path, 'r')
            let read
            try {
              read = readSync(fd, buf, 0, len, cursor)
            } finally {
              closeSync(fd)
            }
            const { lines, consumedBytes } = chopFileWindow(buf.subarray(0, read), read === READ_WINDOW)
            cursor += consumedBytes
            emit(self, lines)
          },
        })
        return {
          cancel: () => {
            listener.disarmed = true
            listener.stop()
            settle({ status: 'killed', detail: 'watch disarmed' })
          },
          done,
          readOutput: () => listener.backlog.drain(),
        }
      },
    })
  }

  ctx.tools.register(defineTool({
    name: 'watch',
    description: 'Drop a background listener on a stream. `source: command` runs a long-lived shell command and listens to its output; '
      + '`source: file` tails a file from its current end. New lines (matching `pattern`, when given) are batched per poll tick and '
      + 'delivered into this session as notices — you are woken even while idle, so never busy-poll a source you already listen to. '
      + 'The listener is a background job: job_list shows it, job_output reads its heard-line backlog, job_kill disarms it. '
      + 'It settles on its own when the command exits or the notice budget is spent.',
    parameters: {
      source: {
        type: 'string',
        required: true,
        enum: ['command', 'file'],
        description: 'command = listen to a long-running shell command; file = tail a growing file from its current end.',
      },
      command: {
        type: 'string',
        description: 'The long-running command to listen to (required for source: command). It is spawned once, not re-run.',
      },
      path: {
        type: 'string',
        description: 'The file to tail (required for source: file). Pre-existing content is not delivered; truncation restarts from the top.',
      },
      workdir: {
        type: 'string',
        description: 'Working directory for the command (source: command only).',
      },
      pattern: {
        type: 'string',
        description: 'Optional JavaScript regular expression; only matching lines are delivered. Cover failure signatures too — silence is not success.',
      },
      max_events: {
        type: 'number',
        description: 'Disarm automatically after this many notices (defaults to the configured budget).',
      },
      label: {
        type: 'string',
        description: 'Short name shown in notices and job_list.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          job_id: { type: 'string', required: true },
          source: { type: 'string', required: true },
          description: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Watch armed (${value.job_id}) on ${value.source}: ${value.description}. `
          + 'You will be woken when it hears new matching lines; disarm with job_kill.',
      }],
    },
    async execute(args, exec) {
      if (args.source === 'command' && (args.command === undefined || args.command === '')) {
        throw new Error('watch: source "command" requires a non-empty command')
      }
      if (args.source === 'file' && (args.path === undefined || args.path === '')) {
        throw new Error('watch: source "file" requires a non-empty path')
      }
      if (args.workdir !== undefined && args.source !== 'command') {
        throw new Error('watch: workdir applies only to source "command"')
      }
      if (args.max_events !== undefined && (!Number.isSafeInteger(args.max_events) || args.max_events < 1)) {
        throw new Error(`watch: max_events (${args.max_events}) must be a whole number of notices, at least 1`)
      }
      const filter = compileFilter(args.pattern)
      if (exec.signal.aborted) throw new Error('watch: tool call aborted')
      if (exec.agent !== undefined) {
        let owned = 0
        for (const listener of active.values()) if (listener.owner === exec.agent) owned++
        if (owned >= config.maxListenersPerOwner) {
          throw new Error(`watch: listener cap reached (${config.maxListenersPerOwner}); disarm one with job_kill first`)
        }
      }
      const maxEvents = args.max_events ?? config.defaultMaxEvents
      const description = args.source === 'command' ? args.command : args.path
      const label = args.label ?? (args.source === 'command' ? args.command.split(/\s+/, 1)[0] : args.path)
      lastArmed = undefined
      const jobId = args.source === 'command'
        ? armCommand(args, exec, label, filter, maxEvents)
        : armFile(args, exec, label, filter, maxEvents)
      // The registry issues the id after run() returns; stamp it onto the
      // listener before its first tick can fire (ticks are >= pollIntervalMs away).
      if (lastArmed !== undefined) {
        lastArmed.jobId = jobId
        active.set(jobId, lastArmed)
        lastArmed = undefined
      }
      return { job_id: jobId, source: args.source, description }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.source === 'command'
        ? `Listen to command ${args.command}`
        : `Listen to file ${args.path}`,
      kind: 'execute',
    }),
  }))
}
