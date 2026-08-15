#!/usr/bin/env node
/**
 * A long-lived feed of newly published GitHub repositories, one NDJSON line
 * each, for a `dsh-watch` listener to hear.
 *
 * This is deliberately a *source*, not an agent: it decides only what is new,
 * never what is interesting. The watcher reads its lines and does the judging.
 *
 * Usage:
 *   node feed.mjs --topic dsh-plugin --topic dsh-theme [--interval 900]
 *
 * Environment:
 *   GITHUB_TOKEN  optional; raises the search limit from 10/min to 30/min
 *   FEED_STATE    path to the seen-repo state file (default ./.feed-state.json)
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs'

const args = process.argv.slice(2)
const topics = args.flatMap((arg, i) => (arg === '--topic' ? [args[i + 1]] : []))
const intervalSec = Number(args[args.indexOf('--interval') + 1]) || 900
const statePath = process.env.FEED_STATE ?? './.feed-state.json'
const token = process.env.GITHUB_TOKEN

if (topics.length === 0) {
  process.stderr.write('feed: at least one --topic is required\n')
  process.exit(2)
}

/** Repos already announced. Persisted so a restart does not replay the world. */
const seen = new Set(load())

function load() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')).seen ?? []
  } catch {
    return []
  }
}

function save() {
  // Write-then-rename: a feed killed mid-write must not lose its whole memory
  // and replay hundreds of repos as "new" on the next boot.
  const tmp = `${statePath}.tmp`
  writeFileSync(tmp, JSON.stringify({ seen: [...seen], updated: new Date().toISOString() }))
  renameSync(tmp, statePath)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * One GitHub API call with rate-limit patience.
 * @param {string} path - API path including query string.
 * @returns {Promise<object|undefined>} parsed body, or undefined when the call
 *   could not be completed — a failed poll is skipped, never treated as "no new repos".
 */
async function gh(path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let res
    try {
      res = await fetch(`https://api.github.com${path}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'dsh-watch-ecosystem-feed',
          ...token ? { authorization: `Bearer ${token}` } : {},
        },
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      await sleep(2000 * (attempt + 1))
      continue
    }
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000
      await sleep(Math.min(Math.max(5000, reset - Date.now() + 2000), 70_000))
      continue
    }
    if (!res.ok) return undefined
    return await res.json()
  }
  return undefined
}

/**
 * The most recently created repositories in one topic.
 *
 * Sorted by creation date, not stars: a repo published an hour ago has zero
 * stars and would sit thousands of rows below a star-sorted window, which is
 * exactly how a registry sweep goes blind to everything new.
 * @param {string} topic - GitHub topic to poll.
 * @returns {Promise<object[]>} newest-first repositories, at most 50.
 */
async function newest(topic) {
  const query = encodeURIComponent(`topic:${topic}`)
  const body = await gh(`/search/repositories?q=${query}&sort=created&order=desc&per_page=50`)
  return body?.items ?? []
}

/** Emit one repo as a feed line. Flushed per line so a listener hears it immediately. */
function announce(topic, repo) {
  process.stdout.write(`${JSON.stringify({
    kind: 'new-repo',
    topic,
    repo: repo.full_name,
    url: repo.html_url,
    description: repo.description ?? '',
    stars: repo.stargazers_count,
    createdAt: repo.created_at,
    seenAt: new Date().toISOString(),
  })}\n`)
}

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true
    save()
    process.exit(0)
  })
}

// The first pass only learns the current world. Announcing 50 repos per topic
// at boot would burn a watcher's whole event budget on history.
let priming = seen.size === 0
process.stderr.write(`feed: watching ${topics.join(', ')} every ${intervalSec}s${priming ? ' (priming: this pass is silent)' : ''}\n`)

while (!stopping) {
  for (const topic of topics) {
    for (const repo of (await newest(topic)).reverse()) {
      if (seen.has(repo.full_name)) continue
      seen.add(repo.full_name)
      if (!priming) announce(topic, repo)
    }
  }
  save()
  priming = false
  await sleep(intervalSec * 1000)
}
