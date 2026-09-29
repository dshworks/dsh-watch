import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../lib/index.js'

/**
 * Deployment bounds used by every test; validation is the loader's job.
 * `wakeRefillMs` is far longer than any test's simulated span, so the base
 * config reproduces the strict consecutive-wake rule; the tests that exercise
 * time refill lower it explicitly.
 */
const CONFIG = {
  pollIntervalMs: 100,
  maxNoticeBytes: 4096,
  maxConsecutiveWakes: 2,
  wakeRefillMs: 60_000,
  defaultMaxEvents: 50,
  maxListenersPerOwner: 2,
  autoArm: [],
}

/**
 * Live agents by session id — the registry `ctx.get('agents').get(id)` reads,
 * and the one dsh-jobs-local resolves a job owner through.
 * @type {Map<string, object>}
 */
const liveAgents = new Map()
/** Every message handed to an agent's followup/inject, checked after each test. */
let delivered = []
let agentSeq = 0

/**
 * The source rule dsh 0.1.7's session writer enforces on every durable
 * message (`assertV4SourceRowAdmission` in session-format-v3-to-v4): a
 * non-empty, producer-owned `kind`, and never the retired `kind: 'plugin'`
 * wrapper. Production does not refuse at `followup()`; the JSONL writer
 * refuses the row later, so the double checks after the test instead.
 * @param {object} message - a delivered user message.
 */
function assertV4Source(message) {
  const kind = message?.source?.kind
  if (typeof kind !== 'string' || kind.length === 0 || kind === 'plugin') {
    throw new Error(`format v4 message requires a producer-owned source kind (got ${JSON.stringify(message?.source)})`)
  }
}

/**
 * Build a stub harness context capturing registrations and job starts.
 *
 * The job registry models dsh-jobs 0.1.7: `start(spec)` takes a `JobSpec`
 * whose `owner` is a session id resolved through the agent registry (an Agent
 * object throws "has no live agent"), calls `run(job)` with a producer face
 * carrying the issued id and the output ring's `append`, and reads nothing
 * back from the hooks but `cancel` and `done`. `job_output` is a consuming
 * read of that ring, modeled by `read()`.
 */
function makeCtx({ shell, initiator, executeResult } = {}) {
  const captured = {
    tools: new Map(),
    sections: [],
    listeners: new Map(),
    effects: [],
    jobs: [],
    warnings: [],
    executed: [],
  }
  let jobSeq = 0
  const ctx = {
    tools: {
      register: (tool) => void captured.tools.set(tool.name, tool),
      execute: async (exec) => {
        captured.executed.push(exec)
        if (executeResult !== undefined) return executeResult
        const tool = captured.tools.get(exec.name)
        try {
          const value = await tool.execute(exec.arguments, { agent: exec.agent, signal: exec.signal })
          return { isError: false, value, content: [] }
        } catch (error) {
          return { isError: true, error: { code: 'TOOL_FAILED' }, content: [{ type: 'text', text: error.message }] }
        }
      },
    },
    systemPrompt: { section: (section) => void captured.sections.push(section) },
    jobs: {
      start: (spec) => {
        // Preflight, as jobs-local: nothing runs for a refused spec.
        if (spec.owner !== undefined && (typeof spec.owner !== 'string' || !liveAgents.has(spec.owner))) {
          throw new Error(`session "${String(spec.owner)}" has no live agent (background job owner must be live)`)
        }
        if (typeof spec.kind !== 'string' || spec.kind.length === 0) throw new Error('invalid job kind: expected a non-empty string')
        if (typeof spec.label !== 'string' || spec.label.length === 0) throw new Error('invalid job label: expected a non-empty string')
        const id = `${spec.kind}-${++jobSeq}`
        const ring = []
        let settled = false
        const handle = {
          id,
          // Writes after settlement log and drop instead of throwing.
          append: (text) => { if (!settled && text.length > 0) ring.push(text) },
          updateProgress: () => {},
        }
        const hooks = spec.run(handle)
        void hooks.done.then(() => { settled = true })
        captured.jobs.push({ id, spec, hooks, read: () => ring.splice(0).join('') })
        return id
      },
    },
    on: (event, handler) => void captured.listeners.set(event, handler),
    effect: (fn) => void captured.effects.push(fn()),
    get: (service) => {
      if (service === 'shell') return shell
      if (service === 'agents') return { currentInitiator: () => initiator, get: id => liveAgents.get(id) }
      return undefined
    },
    logger: { warn: (msg) => void captured.warnings.push(msg) },
  }
  return { ctx, captured }
}

/** A live stub owning agent with observable delivery paths. */
function makeAgent(status = 'idle') {
  const id = `session-${++agentSeq}`
  const agent = {
    id,
    status,
    session: { id },
    followup: vi.fn(message => void delivered.push(message)),
    inject: vi.fn(message => void delivered.push(message)),
  }
  liveAgents.set(id, agent)
  return agent
}

/** Invoke the registered watch tool as the model would. */
async function callTool(captured, args, agent) {
  const tool = captured.tools.get('watch')
  return tool.execute(args, { agent, signal: new AbortController().signal })
}

let dir
beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'watch-'))
  liveAgents.clear()
  delivered = []
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
  // A notice the session writer would refuse is a notice nobody reads.
  for (const message of delivered) assertV4Source(message)
})

describe('registration', () => {
  it('exports the function-plugin surface', () => {
    expect(name).toBe('dsh-watch')
    expect(inject).toEqual(['tools', 'systemPrompt', 'jobs'])
  })

  it('registers the tool, prompt section, and a disposal effect', () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    expect(captured.tools.has('watch')).toBe(true)
    expect(captured.sections.map(s => s.name)).toContain('tool:watch')
    expect(captured.effects.length).toBeGreaterThan(0)
  })
})

describe('file listeners', () => {
  it('delivers appended lines from the current end, not the backlog', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    const path = join(dir, 'log')
    writeFileSync(path, 'old line\n')
    const result = await callTool(captured, { source: 'file', path, label: 'log' }, agent)
    expect(result.job_id).toBe('watch-1')
    appendFileSync(path, 'fresh line\n')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    expect(agent.followup).toHaveBeenCalledTimes(1)
    const text = agent.followup.mock.calls[0][0].content[0].text
    expect(text).toContain('fresh line')
    expect(text).not.toContain('old line')
    expect(text).toContain(result.job_id)
  })

  it('batches all lines from one tick into one notice', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await callTool(captured, { source: 'file', path }, agent)
    appendFileSync(path, 'a\nb\nc\n')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.followup.mock.calls[0][0].content[0].text).toContain('3 lines:')
  })

  it('applies the pattern filter and delivers nothing on silence', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await callTool(captured, { source: 'file', path, pattern: 'ERROR' }, agent)
    appendFileSync(path, 'all fine\nstill fine\n')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    expect(agent.followup).not.toHaveBeenCalled()
    appendFileSync(path, 'an ERROR appeared\n')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.followup.mock.calls[0][0].content[0].text).toContain('an ERROR appeared')
  })

  it('restarts from the top after truncation', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    const path = join(dir, 'log')
    writeFileSync(path, 'seed content longer than the replacement\n')
    await callTool(captured, { source: 'file', path }, agent)
    truncateSync(path, 0)
    appendFileSync(path, 'rotated\n')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.followup.mock.calls[0][0].content[0].text).toContain('rotated')
  })

  it('keeps listening while the file does not exist yet', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    const path = join(dir, 'later')
    await callTool(captured, { source: 'file', path }, agent)
    vi.advanceTimersByTime(CONFIG.pollIntervalMs * 3)
    expect(agent.followup).not.toHaveBeenCalled()
    writeFileSync(path, 'born\n')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    expect(agent.followup).toHaveBeenCalledTimes(1)
  })

  it('settles completed when the notice budget is spent', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await callTool(captured, { source: 'file', path, max_events: 1 }, agent)
    appendFileSync(path, 'the only notice\n')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    const outcome = await captured.jobs[0].hooks.done
    expect(outcome).toEqual({ status: 'completed', detail: 'event budget exhausted after 1 notice(s)' })
    // Disarmed: further appends deliver nothing.
    appendFileSync(path, 'unheard\n')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    expect(agent.followup).toHaveBeenCalledTimes(1)
  })

  it('cancel disarms and settles killed', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await callTool(captured, { source: 'file', path }, agent)
    captured.jobs[0].hooks.cancel()
    const outcome = await captured.jobs[0].hooks.done
    expect(outcome).toEqual({ status: 'killed', detail: 'watch disarmed' })
    appendFileSync(path, 'unheard\n')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('job_output reads the heard lines from the job ring, once', async () => {
    // dsh 0.1.7 removed the `readOutput` job hook: job_output reads the
    // registry's output ring, so a heard line that is not appended there is
    // invisible to job_output even though the notice went out.
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    const agent = makeAgent('busy')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await callTool(captured, { source: 'file', path, pattern: 'kept' }, agent)
    appendFileSync(path, 'kept for job_output\nfiltered out\nkept again\n')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    expect(captured.jobs[0].read()).toBe('kept for job_output\nkept again\n')
    expect(captured.jobs[0].read()).toBe('')
  })

  it('owns the job by session id and speaks as its own producer', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await callTool(captured, { source: 'file', path, label: 'log' }, agent)
    // dsh-jobs 0.1.7: the owner is a SessionId, not the Agent.
    expect(captured.jobs[0].spec.owner).toBe(agent.id)
    appendFileSync(path, 'heard\n')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    // Session format v4 refuses the retired `kind: 'plugin'` wrapper.
    expect(agent.followup.mock.calls[0][0].source).toEqual({ kind: 'dsh-watch', form: 'notice', summary: 'log: heard' })
  })

  it('an unowned call starts an unowned job', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await captured.tools.get('watch').execute({ source: 'file', path }, { signal: new AbortController().signal })
    expect(captured.jobs[0].spec).not.toHaveProperty('owner')
  })
})

describe('wake budget', () => {
  it('wakes an idle owner until the budget is spent, then injects', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await callTool(captured, { source: 'file', path }, agent)
    for (let i = 0; i < 4; i++) {
      appendFileSync(path, `line ${i}\n`)
      vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    }
    expect(agent.followup).toHaveBeenCalledTimes(CONFIG.maxConsecutiveWakes)
    expect(agent.inject).toHaveBeenCalledTimes(4 - CONFIG.maxConsecutiveWakes)
  })

  it('a claimed user message refills the budget; a plugin notice does not', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await callTool(captured, { source: 'file', path }, agent)
    for (let i = 0; i < 3; i++) {
      appendFileSync(path, `line ${i}\n`)
      vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    }
    expect(agent.followup).toHaveBeenCalledTimes(2)
    const claimed = captured.listeners.get('agent/inbox/claimed')
    claimed({ agent, message: { source: { kind: 'plugin' } } })
    appendFileSync(path, 'still spent\n')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    expect(agent.followup).toHaveBeenCalledTimes(2)
    claimed({ agent, message: { source: { kind: 'user' } } })
    appendFileSync(path, 'refilled\n')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    expect(agent.followup).toHaveBeenCalledTimes(3)
  })

  it('a busy owner is injected, never woken', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    const agent = makeAgent('busy')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await callTool(captured, { source: 'file', path }, agent)
    appendFileSync(path, 'while busy\n')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    expect(agent.followup).not.toHaveBeenCalled()
    expect(agent.inject).toHaveBeenCalledTimes(1)
  })
})

describe('unattended operation', () => {
  const UNATTENDED = { ...CONFIG, wakeRefillMs: 5_000 }

  it('time restores spent credits, so an owner no human feeds is never permanently deaf', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, UNATTENDED)
    const agent = makeAgent('idle')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await callTool(captured, { source: 'file', path }, agent)
    for (let i = 0; i < 3; i++) {
      appendFileSync(path, `burst ${i}\n`)
      vi.advanceTimersByTime(UNATTENDED.pollIntervalMs)
    }
    // Burst capacity spent, no user in sight.
    expect(agent.followup).toHaveBeenCalledTimes(UNATTENDED.maxConsecutiveWakes)
    // A slow source over a long run: the owner keeps being woken, one turn per
    // refill period, instead of going deaf after the burst.
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(UNATTENDED.wakeRefillMs)
      appendFileSync(path, `hour ${i}\n`)
      vi.advanceTimersByTime(UNATTENDED.pollIntervalMs)
    }
    expect(agent.followup).toHaveBeenCalledTimes(UNATTENDED.maxConsecutiveWakes + 3)
    // Everything heard reached the agent — as a wake or as input attached to one.
    const seen = [...agent.followup.mock.calls, ...agent.inject.mock.calls].map(call => call[0].content[0].text).join('\n')
    for (let i = 0; i < 3; i++) expect(seen).toContain(`hour ${i}`)
  })

  it('credits accrue at one per refill period, not all at once', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, { ...UNATTENDED, maxConsecutiveWakes: 3 })
    const agent = makeAgent('idle')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await callTool(captured, { source: 'file', path }, agent)
    for (let i = 0; i < 3; i++) {
      appendFileSync(path, `burst ${i}\n`)
      vi.advanceTimersByTime(UNATTENDED.pollIntervalMs)
    }
    expect(agent.followup).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(UNATTENDED.wakeRefillMs * 2)
    // Two credits back; a third line finds the bucket empty again.
    for (let i = 0; i < 3; i++) {
      appendFileSync(path, `later ${i}\n`)
      vi.advanceTimersByTime(UNATTENDED.pollIntervalMs)
    }
    expect(agent.followup).toHaveBeenCalledTimes(5)
  })

  it('a notice queued while starved gets a catch-up wake once a credit returns', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, UNATTENDED)
    const agent = makeAgent('idle')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await callTool(captured, { source: 'file', path }, agent)
    for (let i = 0; i < 3; i++) {
      appendFileSync(path, `burst ${i}\n`)
      vi.advanceTimersByTime(UNATTENDED.pollIntervalMs)
    }
    expect(agent.inject).toHaveBeenCalledTimes(1)
    expect(agent.followup).toHaveBeenCalledTimes(2)
    // The source now goes quiet forever. Without a catch-up wake the queued
    // notice would never be read.
    vi.advanceTimersByTime(UNATTENDED.wakeRefillMs)
    expect(agent.followup).toHaveBeenCalledTimes(3)
    expect(agent.followup.mock.lastCall[0].content[0].text).toContain('1 notice(s) arrived while the wake budget was spent')
    // One catch-up covers the whole queue; it does not fire again.
    vi.advanceTimersByTime(UNATTENDED.wakeRefillMs * 2)
    expect(agent.followup).toHaveBeenCalledTimes(3)
  })

  it('does not catch up on a busy owner, which will read the queue at its next step', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, UNATTENDED)
    const agent = makeAgent('busy')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await callTool(captured, { source: 'file', path }, agent)
    appendFileSync(path, 'while busy\n')
    vi.advanceTimersByTime(UNATTENDED.pollIntervalMs)
    vi.advanceTimersByTime(UNATTENDED.wakeRefillMs * 2)
    expect(agent.followup).not.toHaveBeenCalled()
    expect(agent.inject).toHaveBeenCalledTimes(1)
  })

  it('does not wake an owner about notices it already claimed', async () => {
    // Regression: a busy owner reads injected notices at its next step. Left
    // on the owed-a-catch-up list, they earned a wake whose whole content was
    // "you have queued notices" — for notices already answered. Seen live.
    const { ctx, captured } = makeCtx()
    apply(ctx, UNATTENDED)
    const agent = makeAgent('busy')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await callTool(captured, { source: 'file', path }, agent)
    appendFileSync(path, 'heard while working\n')
    vi.advanceTimersByTime(UNATTENDED.pollIntervalMs)
    expect(agent.inject).toHaveBeenCalledTimes(1)
    // The owner steps, claims the notice, finishes, and goes idle.
    captured.listeners.get('agent/inbox/claimed')({ agent, message: { source: { kind: 'plugin' } } })
    agent.status = 'idle'
    vi.advanceTimersByTime(UNATTENDED.wakeRefillMs * 2)
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('wakeRefillMs: 0 keeps the strict dsh-tool-jobs rule', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, { ...CONFIG, wakeRefillMs: 0 })
    const agent = makeAgent('idle')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await callTool(captured, { source: 'file', path }, agent)
    for (let i = 0; i < 3; i++) {
      appendFileSync(path, `line ${i}\n`)
      vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    }
    vi.advanceTimersByTime(3_600_000)
    expect(agent.followup).toHaveBeenCalledTimes(CONFIG.maxConsecutiveWakes)
  })

  it('max_events: 0 listens past the default budget', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, { ...CONFIG, defaultMaxEvents: 2, maxConsecutiveWakes: 0 })
    const agent = makeAgent('idle')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await callTool(captured, { source: 'file', path, max_events: 0 }, agent)
    for (let i = 0; i < 5; i++) {
      appendFileSync(path, `line ${i}\n`)
      vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    }
    expect(agent.inject).toHaveBeenCalledTimes(5)
    expect(captured.jobs[0].hooks.done).toBeInstanceOf(Promise)
  })

  it('the default event budget still settles the job when spent', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, { ...CONFIG, defaultMaxEvents: 2, maxConsecutiveWakes: 0 })
    const agent = makeAgent('idle')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await callTool(captured, { source: 'file', path }, agent)
    for (let i = 0; i < 3; i++) {
      appendFileSync(path, `line ${i}\n`)
      vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    }
    expect(agent.inject).toHaveBeenCalledTimes(2)
    await expect(captured.jobs[0].hooks.done).resolves.toEqual({
      status: 'completed',
      detail: 'event budget exhausted after 2 notice(s)',
    })
  })
})

describe('standing watches', () => {
  const standing = (autoArm) => ({ ...CONFIG, autoArm })

  it('arms nothing and adds no prompt section when none are configured', () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    expect(captured.listeners.has('agent/created')).toBe(false)
    expect(captured.sections.map(s => s.name)).not.toContain('tool:watch:standing')
  })

  it('arms configured watches for a root session through the tool registry', async () => {
    const path = join(dir, 'standing.log')
    writeFileSync(path, '')
    const { ctx, captured } = makeCtx()
    apply(ctx, standing([{ source: 'file', path, pattern: 'NEW', label: 'ecosystem' }]))
    const agent = makeAgent('idle')
    await captured.listeners.get('agent/created')({ agent, source: 'startup' })
    await vi.waitFor(() => expect(captured.jobs.length).toBe(1))
    // Routed through ctx.tools.execute, so guards, approval, sandbox policy and
    // the shell environment apply exactly as they would to a model-issued call.
    expect(captured.executed[0].name).toBe('watch')
    expect(captured.executed[0].agent).toBe(agent)
    expect(captured.jobs[0].spec.owner).toBe(agent.id)
    appendFileSync(path, 'NEW plugin: dsh-something\nunrelated\n')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    expect(agent.followup).toHaveBeenCalledTimes(1)
    const text = agent.followup.mock.calls[0][0].content[0].text
    expect(text).toContain('dsh-something')
    expect(text).not.toContain('unrelated')
  })

  it('tells the model about the watches it did not arm', () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, standing([{ source: 'file', path: '/tmp/a', label: 'ecosystem' }]))
    const section = captured.sections.find(s => s.name === 'tool:watch:standing')
    expect(section.text).toContain('ecosystem')
    expect(section.order).toBeGreaterThan(captured.sections.find(s => s.name === 'tool:watch').order)
  })

  it('skips a subagent, whose setup runs inside its parent initiator boundary', async () => {
    const { ctx, captured } = makeCtx({ initiator: makeAgent('busy') })
    apply(ctx, standing([{ source: 'file', path: join(dir, 'x'), label: 'ecosystem' }]))
    await captured.listeners.get('agent/created')({ agent: makeAgent('idle'), source: 'startup' })
    await Promise.resolve()
    expect(captured.executed).toEqual([])
  })

  it('arms once per agent, so a second session-start does not double-arm', async () => {
    const path = join(dir, 'once.log')
    writeFileSync(path, '')
    const { ctx, captured } = makeCtx()
    apply(ctx, standing([{ source: 'file', path, label: 'ecosystem' }]))
    const agent = makeAgent('idle')
    const start = captured.listeners.get('agent/created')
    await start({ agent, source: 'startup' })
    await start({ agent, source: 'resume' })
    await vi.waitFor(() => expect(captured.executed.length).toBe(1))
  })

  it('logs a rejected standing watch instead of failing the session', async () => {
    const { ctx, captured } = makeCtx({ executeResult: { isError: true, error: { code: 'DENIED' }, content: [{ type: 'text', text: 'guard said no' }] } })
    apply(ctx, standing([{ source: 'command', command: 'tail -f /var/log/x', label: 'ecosystem' }]))
    await captured.listeners.get('agent/created')({ agent: makeAgent('idle'), source: 'startup' })
    await vi.waitFor(() => expect(captured.warnings.length).toBe(1))
    expect(captured.warnings[0]).toContain('guard said no')
    expect(captured.jobs).toEqual([])
  })
})

describe('command listeners', () => {
  /**
   * A stub shell modeled on dsh-shell 0.1.7. `resolve()` fills defaults the
   * way bash-local does — `onExpiry` defaults to `'kill'` at a 120 s
   * `timeoutMs` — and `execute(spec)` is async: the handle is published after
   * preparation, the deadline is armed unless `onExpiry` is `'none'`, and the
   * spec's signal kills the process. There is no `start()` any more.
   * @param {{ failPreparation?: string, prepare?: Promise<void> }} [options]
   */
  function makeShell({ failPreparation, prepare } = {}) {
    let settleDone = () => {}
    const proc = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: new Promise((res) => {
        settleDone = res
      }),
      deltas: [],
      readOutput() {
        const delta = this.deltas.splice(0).join('')
        return { delta, lossy: this.lossyOnce === true ? ((this.lossyOnce = false), true) : false }
      },
      observed: { stdout: {}, stderr: {} },
      kill: vi.fn(() => {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        proc.signal = 'SIGTERM'
        settleDone()
        return true
      }),
    }
    const shell = {
      resolved: [],
      executed: 0,
      resolve(request) {
        const spec = {
          ...request,
          workdir: request.workdir ?? '/work',
          timeoutMs: request.timeoutMs ?? 120_000,
          onExpiry: request.onExpiry ?? 'kill',
        }
        this.resolved.push(spec)
        return spec
      },
      async execute(spec) {
        if (prepare !== undefined) await prepare
        if (failPreparation !== undefined) throw new Error(failPreparation)
        // "@throws on ... caller cancellation before process publication"
        spec.signal?.throwIfAborted()
        this.executed++
        spec.signal?.addEventListener('abort', () => proc.kill(), { once: true })
        if (spec.onExpiry === 'kill') setTimeout(() => proc.kill(), spec.timeoutMs)
        return proc
      },
    }
    return { shell, proc, exit: (code) => {
      if (proc.status !== 'running') return
      proc.status = 'completed'
      proc.exitCode = code
      settleDone()
    } }
  }

  /** Let preparation publish the process, then run one poll tick. */
  const tick = () => vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs)

  it('streams process output lines as notices and into the job ring', async () => {
    const { shell, proc } = makeShell()
    const { ctx, captured } = makeCtx({ shell })
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    await callTool(captured, { source: 'command', command: 'npm run dev', label: 'dev' }, agent)
    proc.deltas.push('Ready in 120ms\n')
    await tick()
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.followup.mock.calls[0][0].content[0].text).toContain('Ready in 120ms')
    expect(captured.jobs[0].read()).toBe('Ready in 120ms\n')
  })

  it('runs the command with no deadline, so a watch outlives the executor timeout', async () => {
    // dsh 0.1.7's execute() kills at `timeoutMs` (120 s by default) unless the
    // request says `onExpiry: 'none'`; 0.1.5's background start() ignored it.
    const { shell, proc } = makeShell()
    const { ctx, captured } = makeCtx({ shell })
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    await callTool(captured, { source: 'command', command: 'tail -f /var/log/app.log' }, agent)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(shell.resolved[0].onExpiry).toBe('none')
    expect(proc.kill).not.toHaveBeenCalled()
    proc.deltas.push('half an hour later\n')
    await tick()
    expect(agent.followup.mock.lastCall[0].content[0].text).toContain('half an hour later')
  })

  it('does not hand the tool call its own signal: a stopped turn leaves the watch armed', async () => {
    const { shell, proc } = makeShell()
    const { ctx, captured } = makeCtx({ shell })
    apply(ctx, CONFIG)
    const call = new AbortController()
    await captured.tools.get('watch').execute({ source: 'command', command: 'svc' }, { agent: makeAgent('idle'), signal: call.signal })
    await tick()
    call.abort()
    await tick()
    expect(proc.kill).not.toHaveBeenCalled()
  })

  it('carries a partial line across ticks', async () => {
    const { shell, proc } = makeShell()
    const { ctx, captured } = makeCtx({ shell })
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    await callTool(captured, { source: 'command', command: 'svc' }, agent)
    proc.deltas.push('half a ')
    await tick()
    expect(agent.followup).not.toHaveBeenCalled()
    proc.deltas.push('line\n')
    await tick()
    expect(agent.followup.mock.calls[0][0].content[0].text).toContain('half a line')
  })

  it('surfaces upstream truncation instead of staying silent', async () => {
    const { shell, proc } = makeShell()
    const { ctx, captured } = makeCtx({ shell })
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    await callTool(captured, { source: 'command', command: 'svc' }, agent)
    proc.lossyOnce = true
    proc.deltas.push('survivor\n')
    await tick()
    expect(agent.followup.mock.calls[0][0].content[0].text).toContain('some lines were lost')
  })

  it('flushes the tail and maps a clean exit to completed', async () => {
    const { shell, proc, exit } = makeShell()
    const { ctx, captured } = makeCtx({ shell })
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    await callTool(captured, { source: 'command', command: 'svc' }, agent)
    await tick()
    proc.deltas.push('final words')
    exit(0)
    const outcome = await captured.jobs[0].hooks.done
    expect(outcome).toEqual({ status: 'completed', detail: 'stream ended (exit code: 0)' })
    expect(agent.followup.mock.calls[0][0].content[0].text).toContain('final words')
    expect(captured.jobs[0].read()).toBe('final words\n')
  })

  it('maps a nonzero exit to failed', async () => {
    const { shell, exit } = makeShell()
    const { ctx, captured } = makeCtx({ shell })
    apply(ctx, CONFIG)
    await callTool(captured, { source: 'command', command: 'svc' }, makeAgent('idle'))
    await tick()
    exit(3)
    const outcome = await captured.jobs[0].hooks.done
    expect(outcome).toEqual({ status: 'failed', detail: 'stream died (exit code: 3)' })
  })

  it('cancel kills the process and settles killed', async () => {
    const { shell, proc } = makeShell()
    const { ctx, captured } = makeCtx({ shell })
    apply(ctx, CONFIG)
    await callTool(captured, { source: 'command', command: 'svc' }, makeAgent('idle'))
    await tick()
    captured.jobs[0].hooks.cancel()
    expect(proc.kill).toHaveBeenCalled()
    const outcome = await captured.jobs[0].hooks.done
    expect(outcome).toEqual({ status: 'killed', detail: 'watch disarmed' })
  })

  it('cancel during preparation settles killed and never spawns', async () => {
    let release = () => {}
    const { shell } = makeShell({ prepare: new Promise((res) => { release = res }) })
    const { ctx, captured } = makeCtx({ shell })
    apply(ctx, CONFIG)
    await callTool(captured, { source: 'command', command: 'svc' }, makeAgent('idle'))
    captured.jobs[0].hooks.cancel()
    release()
    const outcome = await captured.jobs[0].hooks.done
    expect(outcome).toEqual({ status: 'killed', detail: 'watch disarmed' })
    expect(shell.executed).toBe(0)
  })

  it('a command that cannot start settles failed with the reason', async () => {
    const { shell } = makeShell({ failPreparation: 'sandbox runner unavailable' })
    const { ctx, captured } = makeCtx({ shell })
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    await callTool(captured, { source: 'command', command: 'svc' }, agent)
    const outcome = await captured.jobs[0].hooks.done
    expect(outcome).toEqual({ status: 'failed', detail: 'stream failed to start: sandbox runner unavailable' })
    // The poller went down with it.
    await tick()
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('fails loud without the shell capability', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    await expect(callTool(captured, { source: 'command', command: 'svc' }, makeAgent('idle')))
      .rejects.toThrow(/shell capability/)
  })
})

describe('guardrails', () => {
  it('rejects source-specific argument gaps and misuse', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    await expect(callTool(captured, { source: 'command' }, agent)).rejects.toThrow(/non-empty command/)
    await expect(callTool(captured, { source: 'file' }, agent)).rejects.toThrow(/non-empty path/)
    await expect(callTool(captured, { source: 'file', path: '/tmp/x', workdir: '/tmp' }, agent)).rejects.toThrow(/workdir/)
    await expect(callTool(captured, { source: 'file', path: '/tmp/x', max_events: -1 }, agent)).rejects.toThrow(/max_events/)
    await expect(callTool(captured, { source: 'file', path: '/tmp/x', max_events: 1.5 }, agent)).rejects.toThrow(/max_events/)
    await expect(callTool(captured, { source: 'file', path: '/tmp/x', pattern: '(bad' }, agent)).rejects.toThrow(/invalid pattern/)
  })

  it('enforces the per-owner listener cap', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await callTool(captured, { source: 'file', path }, agent)
    await callTool(captured, { source: 'file', path }, agent)
    await expect(callTool(captured, { source: 'file', path }, agent)).rejects.toThrow(/listener cap/)
    // Disarming frees a slot.
    captured.jobs[0].hooks.cancel()
    await expect(callTool(captured, { source: 'file', path }, agent)).resolves.toBeTruthy()
  })

  it('arms nothing when the registry refuses the job at preflight', async () => {
    // dsh-jobs 0.1.7: admission runs before run(), and once run() returns
    // registration cannot fail — so a refusal never strands a poller.
    const { ctx, captured } = makeCtx()
    ctx.jobs = { start: () => { throw new Error('background job limit reached for this owner (limit: 8)') } }
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await expect(callTool(captured, { source: 'file', path }, agent)).rejects.toThrow(/job limit/)
    appendFileSync(path, 'must stay unheard\n')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs * 2)
    expect(agent.followup).not.toHaveBeenCalled()
    expect(agent.inject).not.toHaveBeenCalled()
  })

  it('plugin disposal tears every listener down', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await callTool(captured, { source: 'file', path }, agent)
    for (const dispose of captured.effects) dispose()
    const outcome = await captured.jobs[0].hooks.done
    expect(outcome.status).toBe('killed')
    appendFileSync(path, 'after disposal\n')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('a tick error is logged and does not kill the listener', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await callTool(captured, { source: 'file', path }, agent)
    // Replace the file with a directory of the same name: statSync succeeds,
    // openSync-and-read throws — the listener must survive it.
    rmSync(path)
    appendFileSync(join(dir, 'other'), 'noise\n')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(path)
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    rmSync(path, { recursive: true })
    writeFileSync(path, 'recovered\n')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.followup.mock.calls[0][0].content[0].text).toContain('recovered')
  })
})
