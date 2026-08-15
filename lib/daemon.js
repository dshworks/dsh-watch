/**
 * dsh-watch/daemon — a body for the ear.
 *
 * The stock surfaces do not host a standing agent: `dsh --profile headless`
 * drives one task to quiescence and exits, and `dsh --profile web` stays up but
 * waits for a human to open a session. An unattended watcher needs neither a
 * task nor a browser — it needs a root session that exists, holds a standing
 * brief, and then sits idle until a watch wakes it.
 *
 * This runner is that host, and nothing more: it creates one agent, seeds the
 * brief, keeps the process alive, and writes each active period's closing text
 * to stdout as an operator journal. Watches are armed by `dsh-watch`'s own
 * `autoArm` config; the daemon does not know what is being listened to.
 *
 * @module dsh-watch/daemon
 */
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-watch-daemon'
export const inject = ['agentDefaultModel', 'agents', 'sessions']

export const Config = z.object({
  /** The standing instruction the watcher boots with — its whole job description, delivered once as a user message. */
  brief: z.string().required(),
  /** Flush the session log this often (ms); a daemon can run for weeks between natural flush points. */
  flushIntervalMs: z.number().min(1000).default(300_000),
  /** Write each active period's closing assistant text to stdout, prefixed with an ISO timestamp. */
  journal: z.boolean().default(true),
})

/** The process stream the journal writes to; tests substitute a capture. */
export const internals = { stdout: process.stdout }

/**
 * Write one operator-journal entry. Continuation lines are indented so a
 * multi-line report stays one visually scannable record in a tailed log.
 * @param {string} text - the entry body.
 */
function journal(text) {
  internals.stdout.write(`${new Date().toISOString()} ${text.replace(/\n/g, '\n  ')}\n`)
}

/**
 * Last non-empty assistant text in a session-event range.
 * @param {readonly object[]} events - the session's event log.
 * @param {number} fromSeq - first sequence number to consider.
 * @returns {string} the closing text, or '' when the period produced none.
 */
function closingText(events, fromSeq) {
  let text = ''
  for (const event of events) {
    if (event.seq < fromSeq || event.type !== 'assistant/message') continue
    const joined = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    if (joined !== '') text = joined
  }
  return text
}

/**
 * Mount the standing-agent host.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context with the agent registry, default model, and sessions.
 * @param {ReturnType<typeof Config>} config - validated daemon config.
 */
export function apply(ctx, config) {
  // Nothing in this composition binds a port, and an idle agent schedules no
  // work, so the event loop would drain and take the daemon with it. Watches
  // hold their own poll timers, but the daemon must outlive the last one.
  const keepAlive = setInterval(() => {}, 1 << 30)
  ctx.effect(() => () => clearInterval(keepAlive))

  void start(ctx, config).catch((error) => {
    ctx.logger.error(`dsh-watch-daemon: ${error instanceof Error ? error.message : String(error)}`)
  })
}

/**
 * Create the root session, seed the brief, and journal every active period.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {ReturnType<typeof Config>} config - validated daemon config.
 */
async function start(ctx, config) {
  // Loader siblings mount concurrently; a watcher created before dsh-watch is
  // composed would start its session with no ear attached.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const selection = defaultModel.currentSelection()
  const { agent } = await agents.create({
    sessionId: `session-${randomUUID()}`,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
  })
  await agent.whenIdle()

  if (config.journal) {
    // An operator tailing stdout needs to see the watcher come up. Without
    // this, a first turn that takes minutes is indistinguishable from a
    // daemon that died during boot.
    journal(`up — session ${agent.session.header?.id ?? agent.session.id ?? 'unknown'}`)
    let periodStart = agent.session.seq
    ctx.on('agent/status', (payload) => {
      if (payload.agent !== agent) return
      if (payload.status !== 'idle') return
      const text = closingText(agent.session.events, periodStart)
      periodStart = agent.session.seq
      if (text !== '') journal(text)
    })
  }

  // A session that only ever wakes for plugin notices reaches no natural flush
  // point, so its log would live in memory until the process died.
  const flush = setInterval(() => void sessions.flush(agent.session).catch(() => {}), config.flushIntervalMs)
  ctx.effect(() => () => {
    clearInterval(flush)
    void sessions.flush(agent.session).catch(() => {})
  })

  agent.followup(createUserMessage({
    content: [{ type: 'text', text: config.brief }],
    source: { kind: 'user' },
  }))
}
