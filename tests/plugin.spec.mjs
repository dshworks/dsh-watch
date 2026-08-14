import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../lib/index.js'

/** Deployment bounds used by every test; validation is the loader's job. */
const CONFIG = {
  pollIntervalMs: 100,
  maxNoticeBytes: 4096,
  maxConsecutiveWakes: 2,
  defaultMaxEvents: 50,
  maxListenersPerOwner: 2,
  backlogBytes: 65536,
}

/** Build a stub harness context capturing registrations and job starts. */
function makeCtx({ shell } = {}) {
  const captured = {
    tools: new Map(),
    sections: [],
    listeners: new Map(),
    effects: [],
    jobs: [],
    warnings: [],
  }
  let jobSeq = 0
  const ctx = {
    tools: { register: (tool) => void captured.tools.set(tool.name, tool) },
    systemPrompt: { section: (section) => void captured.sections.push(section) },
    jobs: {
      start: (spec) => {
        const hooks = spec.run()
        const id = `hydrophone-${++jobSeq}`
        captured.jobs.push({ id, spec, hooks })
        return id
      },
    },
    on: (event, handler) => void captured.listeners.set(event, handler),
    effect: (fn) => void captured.effects.push(fn()),
    get: (service) => (service === 'shell' ? shell : undefined),
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

/** Invoke the registered hydrophone tool as the model would. */
async function callTool(captured, args, agent) {
  const tool = captured.tools.get('hydrophone')
  return tool.execute(args, { agent, signal: new AbortController().signal })
}

let dir
beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'hydrophone-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('registration', () => {
  it('exports the function-plugin surface', () => {
    expect(name).toBe('dsh-hydrophone')
    expect(inject).toEqual(['tools', 'systemPrompt', 'jobs'])
  })

  it('registers the tool, prompt section, and a disposal effect', () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    expect(captured.tools.has('hydrophone')).toBe(true)
    expect(captured.sections.map(s => s.name)).toContain('tool:hydrophone')
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
    expect(result.job_id).toBe('hydrophone-1')
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
    expect(outcome).toEqual({ status: 'killed', detail: 'hydrophone disarmed' })
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
    expect(outcome).toEqual({ status: 'killed', detail: 'hydrophone disarmed' })
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
    await expect(callTool(captured, { source: 'file', path: '/tmp/x', max_events: 0 }, agent)).rejects.toThrow(/max_events/)
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
