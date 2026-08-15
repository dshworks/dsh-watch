import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, internals, name } from '../lib/daemon.js'

const CONFIG = { brief: 'You are the ecosystem watcher.', flushIntervalMs: 300_000, journal: true }

/** Build a stub host context with the three services the daemon injects. */
function makeCtx({ services = {} } = {}) {
  const captured = { effects: [], listeners: new Map(), created: [], flushes: 0, errors: [] }
  const session = { seq: 0, events: [], header: { id: 'session-test' } }
  const agent = {
    session,
    whenIdle: async () => {},
    followup: vi.fn(),
  }
  const provided = {
    loader: { await: async () => {} },
    agents: {
      create: async (spec) => {
        captured.created.push(spec)
        return { agent }
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4-pro' }) },
    sessions: { flush: async () => void captured.flushes++ },
    ...services,
  }
  const ctx = {
    get: service => provided[service],
    on: (event, handler) => void captured.listeners.set(event, handler),
    effect: fn => void captured.effects.push(fn()),
    logger: { error: msg => void captured.errors.push(msg) },
  }
  return { ctx, captured, agent, session }
}

/** Append one assistant message to the stub session log. */
function say(session, text) {
  session.events.push({ seq: session.seq++, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
}

let written
beforeEach(() => {
  vi.useFakeTimers()
  written = []
  internals.stdout = { write: chunk => void written.push(chunk) }
})
afterEach(() => {
  vi.useRealTimers()
  internals.stdout = process.stdout
})

describe('registration', () => {
  it('exports the function-plugin surface', () => {
    expect(name).toBe('dsh-watch-daemon')
    expect(inject).toEqual(['agentDefaultModel', 'agents', 'sessions'])
  })

  it('holds the event loop open and releases it on disposal', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    await vi.waitFor(() => expect(captured.created.length).toBe(1))
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    for (const dispose of captured.effects) dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the standing session', () => {
  it('creates one agent on the default model and seeds the brief as user input', async () => {
    const { ctx, captured, agent } = makeCtx()
    apply(ctx, CONFIG)
    await vi.waitFor(() => expect(agent.followup).toHaveBeenCalledTimes(1))
    expect(captured.created[0].agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' })
    expect(captured.created[0].sessionId).toMatch(/^session-/)
    const message = agent.followup.mock.calls[0][0]
    expect(message.content[0].text).toBe(CONFIG.brief)
    // A user-authored brief, so it refills the watch wake budget like any
    // human turn would; a plugin-sourced one would not.
    expect(message.source.kind).toBe('user')
  })

  it('waits for the loader before creating the agent, so the ear is mounted first', async () => {
    let released
    const gate = new Promise((res) => { released = res })
    const { ctx, captured } = makeCtx({ services: { loader: { await: () => gate } } })
    apply(ctx, CONFIG)
    await Promise.resolve()
    expect(captured.created).toEqual([])
    released()
    await vi.waitFor(() => expect(captured.created.length).toBe(1))
  })

  it('flushes the session on its interval and once more on disposal', async () => {
    const { ctx, captured } = makeCtx()
    apply(ctx, CONFIG)
    await vi.waitFor(() => expect(captured.created.length).toBe(1))
    expect(captured.flushes).toBe(0)
    await vi.advanceTimersByTimeAsync(CONFIG.flushIntervalMs * 2)
    expect(captured.flushes).toBe(2)
    for (const dispose of captured.effects) dispose()
    await vi.waitFor(() => expect(captured.flushes).toBe(3))
  })
})

describe('the operator journal', () => {
  it('writes one timestamped line per active period, not per message', async () => {
    const { ctx, captured, agent, session } = makeCtx()
    apply(ctx, CONFIG)
    await vi.waitFor(() => expect(agent.followup).toHaveBeenCalledTimes(1))
    const status = captured.listeners.get('agent/status')
    // Boot line first: an operator must be able to tell a slow first turn
    // from a daemon that died during startup.
    expect(written).toHaveLength(1)
    expect(written[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z up — session /)
    say(session, 'thinking out loud')
    say(session, 'Standing by.')
    status({ agent, status: 'idle' })
    expect(written).toHaveLength(2)
    expect(written[1]).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z Standing by\.\n$/)
    // The next period reports only its own closing text.
    say(session, 'HEARD acme/dsh-radar')
    status({ agent, status: 'idle' })
    expect(written).toHaveLength(3)
    expect(written[2]).toContain('HEARD acme/dsh-radar')
    expect(written[2]).not.toContain('Standing by')
  })

  it('stays quiet for a period that produced no text, and for other agents', async () => {
    const { ctx, captured, agent, session } = makeCtx()
    apply(ctx, CONFIG)
    await vi.waitFor(() => expect(agent.followup).toHaveBeenCalledTimes(1))
    const status = captured.listeners.get('agent/status')
    status({ agent, status: 'idle' })
    status({ agent, status: 'running' })
    say(session, 'from a subagent')
    status({ agent: { session }, status: 'idle' })
    expect(written.filter(line => !line.includes(' up — session '))).toEqual([])
  })

  it('indents continuation lines so a multi-line report stays one journal entry', async () => {
    const { ctx, captured, agent, session } = makeCtx()
    apply(ctx, CONFIG)
    await vi.waitFor(() => expect(agent.followup).toHaveBeenCalledTimes(1))
    say(session, 'HEARD two:\nacme/dsh-radar\nbeta/dsh-lantern')
    captured.listeners.get('agent/status')({ agent, status: 'idle' })
    expect(written[1]).toContain('HEARD two:\n  acme/dsh-radar\n  beta/dsh-lantern')
  })

  it('registers no status listener when journalling is off', async () => {
    const { ctx, captured, agent } = makeCtx()
    apply(ctx, { ...CONFIG, journal: false })
    await vi.waitFor(() => expect(agent.followup).toHaveBeenCalledTimes(1))
    expect(captured.listeners.has('agent/status')).toBe(false)
  })
})

describe('degraded hosts', () => {
  it('mounts without starting a session when a core service is missing', async () => {
    const { ctx, captured, agent } = makeCtx({ services: { agents: undefined } })
    apply(ctx, CONFIG)
    await Promise.resolve()
    await Promise.resolve()
    expect(agent.followup).not.toHaveBeenCalled()
    expect(captured.errors).toEqual([])
  })

  it('logs a failed startup instead of taking the process down', async () => {
    const { ctx, captured } = makeCtx({ services: { agents: { create: async () => { throw new Error('no model configured') } } } })
    apply(ctx, CONFIG)
    await vi.waitFor(() => expect(captured.errors.length).toBe(1))
    expect(captured.errors[0]).toContain('no model configured')
  })
})
