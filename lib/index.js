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
import { chopFileWindow, compileFilter, createBacklog, createLineBuffer, createWakeBudget, formatNotice } from './core.js'

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
  /** Idle wake-ups an owner may burst through before notices queue instead; a claimed user message refills the budget. */
  maxConsecutiveWakes: z.number().min(0).default(3),
  /** Milliseconds that restore one spent wake credit, so an unattended agent never goes permanently deaf. 0 keeps the strict `dsh-tool-jobs` rule: only a user message refills. */
  wakeRefillMs: z.number().min(0).default(60_000),
  /** Default notice budget per listener; the listener settles `completed` when spent. 0 means unbounded. The tool's `max_events` overrides per call. */
  defaultMaxEvents: z.number().min(0).default(50),
  /** Armed-listener cap per owning agent; arming beyond it fails the tool call. */
  maxListenersPerOwner: z.number().min(1).default(8),
  /** Retained-bytes budget for each listener's `job_output` backlog. */
  backlogBytes: z.number().min(1024).default(65536),
  /** Watches armed automatically when a root session starts — the deployment's own standing listeners, for an agent that runs unattended. Same fields as the tool. */
  autoArm: z.array(z.object({
    source: z.union(['command', 'file']),
    command: z.string(),
    path: z.string(),
    workdir: z.string(),
    pattern: z.string(),
    max_events: z.number().min(0),
    label: z.string(),
  })).default([]),
})

/** Per-tick file read window (bytes). One oversized line cannot stall the tail: a full window with no newline is consumed as one line. */
const READ_WINDOW = 1 << 20

/**
 * Mount the `watch` tool and its delivery plumbing.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context with `tools`, `systemPrompt`, and `jobs` injected.
 * @param {ReturnType<typeof Config>} config - validated deployment bounds.
 */
export function apply(ctx, config) {
  const wakeBudget = createWakeBudget({ capacity: config.maxConsecutiveWakes, refillMs: config.wakeRefillMs })
  /** @type {WeakMap<object, number>} notices queued into an owner since it was last woken. */
  const queuedNotices = new WeakMap()
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    // Claiming drains the pending batch, so nothing is left owed a catch-up
    // wake — including notices injected into an owner that was busy and read
    // them at its next step. Without this the sweep wakes an agent to tell it
    // about notices it has already answered.
    queuedNotices.delete(agent)
    // Claiming is the point the human's input enters a step; a notice this
    // plugin queued must not refill the budget it just spent.
    if (message.source.kind === 'user') wakeBudget.refill(agent)
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
    if (owner.status === 'idle' && wakeBudget.take(owner, Date.now())) {
      queuedNotices.delete(owner)
      owner.followup(message)
      return
    }
    // A busy owner reads this at its next step and needs no help. Only an
    // out-of-credit idle owner is owed a catch-up wake, because injection
    // alone never wakes the driver.
    if (owner.status === 'idle') queuedNotices.set(owner, (queuedNotices.get(owner) ?? 0) + 1)
    owner.inject(message)
  }

  /**
   * Open a turn for notices that were queued into an idle owner while its wake
   * budget was spent. Injection alone never wakes the driver, so without this
   * the last notice before a quiet spell would sit unread indefinitely — the
   * exact failure an unattended watcher hits. The turn claims the whole pending
   * batch, so one credit recovers all of them.
   */
  function sweepQueued() {
    /** @type {Set<object>} */
    const seen = new Set()
    for (const listener of active.values()) {
      const owner = listener.owner
      if (owner === undefined || seen.has(owner)) continue
      seen.add(owner)
      const queued = queuedNotices.get(owner) ?? 0
      if (queued === 0 || owner.status !== 'idle') continue
      if (!wakeBudget.take(owner, Date.now())) continue
      queuedNotices.delete(owner)
      owner.followup(createUserMessage({
        content: [{ type: 'text', text: `[watch] ${queued} notice(s) arrived while the wake budget was spent; they are attached to this turn.` }],
        source: { kind: 'plugin', plugin: name, form: 'notice', summary: boundContextSummary(`watch: ${queued} queued notice(s)`) },
      }))
    }
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
    if (!final && listener.maxEvents > 0 && listener.notices >= listener.maxEvents) listener.exhaust()
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
      sweepQueued()
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
        description: 'Disarm automatically after this many notices (defaults to the configured budget). 0 listens indefinitely — use it only for a source you mean to keep listening to for the whole session.',
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
      if (args.max_events !== undefined && (!Number.isSafeInteger(args.max_events) || args.max_events < 0)) {
        throw new Error(`watch: max_events (${args.max_events}) must be a whole number of notices, or 0 for no limit`)
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
      let jobId
      try {
        jobId = args.source === 'command'
          ? armCommand(args, exec, label, filter, maxEvents)
          : armFile(args, exec, label, filter, maxEvents)
      } catch (error) {
        // The producer owns cleanup of partially started resources: if the
        // registry rejected the job after run() armed the poller, tear the
        // orphaned listener down before surfacing the error.
        lastArmed?.teardown()
        lastArmed = undefined
        throw error
      }
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
        ? `Watch command ${args.command}`
        : `Tail file ${args.path}`,
      kind: 'execute',
    }),
  }))

  if (config.autoArm.length === 0) return

  const autoArmAbort = new AbortController()
  ctx.effect(() => () => autoArmAbort.abort())
  /** @type {WeakSet<object>} sessions already served, so a resume does not double-arm. */
  const autoArmed = new WeakSet()
  let autoArmSeq = 0

  ctx.systemPrompt.section({
    name: 'tool:watch:standing',
    order: 108,
    text: `This deployment arms ${config.autoArm.length} standing watch(es) for you at session start: `
      + `${config.autoArm.map(spec => spec.label ?? spec.command ?? spec.path).join(', ')}. `
      + 'You did not call for them and you do not need to re-arm them; they appear in job_list like any other watch.',
  })

  // The deployment's own watches, armed without a model in the loop. They go
  // through `ctx.tools.execute` rather than the internal arming helpers so a
  // configured watch is subject to exactly the guards, approval policy,
  // sandbox, and shell environment a model-issued one would be — the registry
  // owns the execution token, which callers must never mint themselves.
  ctx.on('agent/session-start', ({ agent }) => {
    // A subagent's setup runs inside its parent's initiator boundary; standing
    // watches belong to the root session, not to every delegated child.
    if (ctx.get('agents')?.currentInitiator() !== undefined) return
    if (autoArmed.has(agent)) return
    autoArmed.add(agent)
    void armStanding(agent)
  })

  /**
   * Arm every configured watch for one root agent, in order.
   * @param {object} agent - the root agent that owns the standing watches.
   */
  async function armStanding(agent) {
    for (const spec of config.autoArm) {
      if (autoArmAbort.signal.aborted) return
      const callId = `dsh-watch-standing-${++autoArmSeq}`
      try {
        const result = await ctx.tools.execute({
          name: 'watch',
          callId,
          arguments: { ...spec },
          signal: autoArmAbort.signal,
          agent,
        })
        // `execute` materializes a tool failure as an error result rather than
        // throwing, so a rejected standing watch has to be read off the result.
        if (result?.isError === true) {
          const reason = result.content?.find(block => block.type === 'text')?.text ?? result.error?.code ?? 'unknown reason'
          ctx.logger.warn(`dsh-watch: standing watch ${JSON.stringify(spec.label ?? spec.command ?? spec.path)} was rejected: ${reason}`)
        }
      } catch (error) {
        ctx.logger.warn(`dsh-watch: standing watch ${JSON.stringify(spec.label ?? spec.command ?? spec.path)} failed to arm: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}
