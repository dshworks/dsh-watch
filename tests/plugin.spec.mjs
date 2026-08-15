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
  backlogBytes: 65536,
  autoArm: [],
}

/** Build a stub harness context capturing registrations and job starts. */
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
        const hooks = spec.run()
        const id = `watch-${++jobSeq}`
        captured.jobs.push({ id, spec, hooks })
        return id
      },
    },
    on: (event, handler) => void captured.listeners.set(event, handler),
    effect: (fn) => void captured.effects.push(fn()),
    get: (service) => {
      if (service === 'shell') return shell
      if (service === 'agents') return { currentInitiator: () => initiator }
      return undefined
    },
    logger: { warn: (msg) => void captured.warnings.push(msg) },
  }
  return { ctx, captured }
}

/** A stub owning agent with observable delivery paths. */
function makeAgent(status = 'idle') {
  return {
    status,
    session: { id: 'session-1' },
    followup: vi.fn(),
    inject: vi.fn(),
  }
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
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
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

  it('readOutput drains the heard-line backlog once', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    const agent = makeAgent('busy')
    const path = join(dir, 'log')
    writeFileSync(path, '')
    await callTool(captured, { source: 'file', path }, agent)
    appendFileSync(path, 'kept for job_output\n')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    expect(captured.jobs[0].hooks.readOutput()).toBe('kept for job_output')
    expect(captured.jobs[0].hooks.readOutput()).toBe('')
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
    expect(captured.listeners.has('agent/session-start')).toBe(false)
    expect(captured.sections.map(s => s.name)).not.toContain('tool:watch:standing')
  })

  it('arms configured watches for a root session through the tool registry', async () => {
    const path = join(dir, 'standing.log')
    writeFileSync(path, '')
    const { ctx, captured } = makeCtx()
    apply(ctx, standing([{ source: 'file', path, pattern: 'NEW', label: 'ecosystem' }]))
    const agent = makeAgent('idle')
    await captured.listeners.get('agent/session-start')({ agent, source: 'fresh' })
    await vi.waitFor(() => expect(captured.jobs.length).toBe(1))
    // Routed through ctx.tools.execute, so guards, approval, sandbox policy and
    // the shell environment apply exactly as they would to a model-issued call.
    expect(captured.executed[0].name).toBe('watch')
    expect(captured.executed[0].agent).toBe(agent)
    expect(captured.jobs[0].spec.owner).toBe(agent)
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
    await captured.listeners.get('agent/session-start')({ agent: makeAgent('idle'), source: 'fresh' })
    await Promise.resolve()
    expect(captured.executed).toEqual([])
  })

  it('arms once per agent, so a second session-start does not double-arm', async () => {
    const path = join(dir, 'once.log')
    writeFileSync(path, '')
    const { ctx, captured } = makeCtx()
    apply(ctx, standing([{ source: 'file', path, label: 'ecosystem' }]))
    const agent = makeAgent('idle')
    const start = captured.listeners.get('agent/session-start')
    await start({ agent, source: 'fresh' })
    await start({ agent, source: 'resume' })
    await vi.waitFor(() => expect(captured.executed.length).toBe(1))
  })

  it('logs a rejected standing watch instead of failing the session', async () => {
    const { ctx, captured } = makeCtx({ executeResult: { isError: true, error: { code: 'DENIED' }, content: [{ type: 'text', text: 'guard said no' }] } })
    apply(ctx, standing([{ source: 'command', command: 'tail -f /var/log/x', label: 'ecosystem' }]))
    await captured.listeners.get('agent/session-start')({ agent: makeAgent('idle'), source: 'fresh' })
    await vi.waitFor(() => expect(captured.warnings.length).toBe(1))
    expect(captured.warnings[0]).toContain('guard said no')
    expect(captured.jobs).toEqual([])
  })
})

describe('command listeners', () => {
  /** A stub shell whose process the test scripts. */
  function makeShell() {
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
      kill: vi.fn(() => true),
    }
    const shell = {
      resolved: [],
      resolve(request) {
        this.resolved.push(request)
        return request
      },
      start: () => proc,
    }
    return { shell, proc, exit: (code) => {
      proc.exitCode = code
      settleDone()
    } }
  }

  it('streams process output lines as notices', async () => {
    const { shell, proc } = makeShell()
    const { ctx, captured } = makeCtx({ shell })
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    await callTool(captured, { source: 'command', command: 'npm run dev', label: 'dev' }, agent)
    proc.deltas.push('Ready in 120ms\n')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.followup.mock.calls[0][0].content[0].text).toContain('Ready in 120ms')
  })

  it('carries a partial line across ticks', async () => {
    const { shell, proc } = makeShell()
    const { ctx, captured } = makeCtx({ shell })
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    await callTool(captured, { source: 'command', command: 'svc' }, agent)
    proc.deltas.push('half a ')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    expect(agent.followup).not.toHaveBeenCalled()
    proc.deltas.push('line\n')
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
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
    vi.advanceTimersByTime(CONFIG.pollIntervalMs)
    expect(agent.followup.mock.calls[0][0].content[0].text).toContain('some lines were lost')
  })

  it('flushes the tail and maps a clean exit to completed', async () => {
    const { shell, proc, exit } = makeShell()
    const { ctx, captured } = makeCtx({ shell })
    apply(ctx, CONFIG)
    const agent = makeAgent('idle')
    await callTool(captured, { source: 'command', command: 'svc' }, agent)
    proc.deltas.push('final words')
    exit(0)
    const outcome = await captured.jobs[0].hooks.done
    expect(outcome).toEqual({ status: 'completed', detail: 'stream ended (exit code: 0)' })
    expect(agent.followup.mock.calls[0][0].content[0].text).toContain('final words')
  })

  it('maps a nonzero exit to failed', async () => {
    const { shell, exit } = makeShell()
    const { ctx, captured } = makeCtx({ shell })
    apply(ctx, CONFIG)
    await callTool(captured, { source: 'command', command: 'svc' }, makeAgent('idle'))
    exit(3)
    const outcome = await captured.jobs[0].hooks.done
    expect(outcome).toEqual({ status: 'failed', detail: 'stream died (exit code: 3)' })
  })

  it('cancel kills the process and settles killed', async () => {
    const { shell, proc, exit } = makeShell()
    const { ctx, captured } = makeCtx({ shell })
    apply(ctx, CONFIG)
    await callTool(captured, { source: 'command', command: 'svc' }, makeAgent('idle'))
    captured.jobs[0].hooks.cancel()
    expect(proc.kill).toHaveBeenCalled()
    exit(null)
    const outcome = await captured.jobs[0].hooks.done
    expect(outcome).toEqual({ status: 'killed', detail: 'watch disarmed' })
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

  it('tears the armed poller down when the registry rejects the job after run()', async () => {
    const { ctx, captured } = makeCtx()
    // A registry that runs the producer, then refuses the job.
    ctx.jobs = { start: (spec) => { spec.run(); throw new Error('job limit reached') } }
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
