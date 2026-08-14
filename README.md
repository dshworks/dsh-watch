# dsh-watch

[![ci](https://github.com/dshworks/dsh-watch/actions/workflows/ci.yml/badge.svg)](https://github.com/dshworks/dsh-watch/actions/workflows/ci.yml)
[![powered by dsh](https://img.shields.io/badge/powered__by-dsh-4D6BFE?logo=deepseek)](https://github.com/deepseek-ai/deepseek-harness)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Put a watch on a stream. The agent gets woken by what it says — even while idle.**

`dsh-watch` gives DeepSeek Harness the missing half of background work: not "tell me when it *finishes*" (the stock jobs subsystem already does that) but "tell me when it *says something*". Arm a watch on a long-running command or a growing file; new lines — optionally filtered by a pattern — are batched per poll tick and delivered into the owning session as notices. An idle agent is woken; a busy one finds the notice queued into its next step. It is the harness analog of Claude Code's `Monitor` tool.

Every watch is a **first-class background job** (kind `watch`), so the standard surface applies unchanged: `job_list` shows armed watches, `job_output` drains a watch's line backlog, `job_kill` disarms one, ownership is session-fenced, and settlement arrives as an ordinary completion notice. This plugin adds only the watching — no parallel lifecycle, no second registry.

## 60-second start

`dsh plugin` forwards to pnpm, so pnpm must be on PATH.

```sh
dsh plugin --profile web add github:dshworks/dsh-watch
dsh --profile web
```

Then, in a session:

```text
watch(source: "command", command: "npm run dev", pattern: "error|warn|Ready", label: "dev")
→ Watch armed (watch-1) on command: npm run dev.

# …the agent keeps working; when the dev server logs "Ready in 130ms",
# a notice wakes it:
[watch dev · watch-1] 1 line:
Ready in 130ms
```

Tail a file instead:

```text
watch(source: "file", path: "/var/log/app.log", pattern: "ERROR|FATAL")
```

## What it does, precisely

| Behavior | Detail |
|---|---|
| Sources | `command` (spawned once via the shell capability, inheriting the session's sandbox policy and env) · `file` (tailed from its current end; pre-existing content is never delivered; truncation restarts from the top; a not-yet-existing file is watched for) |
| Batching | All lines heard in one poll tick share one notice — a bursty source costs one wake, not one per line |
| Filtering | Optional JavaScript regex; only matching lines are delivered. Cover failure signatures too — silence is not success |
| Wake budget | Consecutive idle wakes per owner are bounded (default 3, same mechanism and refill rule as `dsh-tool-jobs` completion notices); beyond it, notices queue into the next step |
| Event budget | Each watch disarms itself after `max_events` notices (default 50) and settles `completed` — a chatty source cannot flood a session forever |
| Byte bounds | Each complete notice is capped (default 4096 bytes) UTF-8-safely, wrapper included; `job_output` holds the bounded backlog with an explicit trim marker when lines were dropped |
| Truncation honesty | Upstream output loss (`lossy` reads) is surfaced as a marker line, never swallowed |
| Lifecycle | Process exit flushes the tail, then settles `completed` (exit 0), `failed` (nonzero — a dead watch is a finding, not a silence), or `killed` (signal/disarm). Plugin disposal tears every watch down |
| Caps | Per-owner armed-watch cap (default 8) fails the arming call loudly |

Everything above is a validated `Config` field, not a constant — `pollIntervalMs`, `maxNoticeBytes`, `maxConsecutiveWakes`, `defaultMaxEvents`, `maxListenersPerOwner`, `backlogBytes`.

## Model Experience

### System prompt

One section (order 107, after the background-jobs guidance):

```markdown
You can arm a watch on a stream with the watch tool: it listens in the background and wakes you when new matching lines arrive, so never busy-poll a source you already listen to. Listeners are background jobs — job_list shows them, job_output reads a listener's heard-line backlog, job_kill disarms one.
```

### Tools

One tool, `watch` (source, command/path, workdir, pattern, max_events, label). Disarm, list, and read ride the stock `job_kill` / `job_list` / `job_output`.

### Token effects

A silent source costs zero tokens — polling happens host-side. Each notice costs one bounded message (≤ `maxNoticeBytes`); an idle wake additionally costs the model request it opens, which is why consecutive wakes are budgeted.

## Requirements

- The jobs subsystem: `@deepseek-ai/dsh-jobs`, `dsh-jobs-local`, and `dsh-tool-jobs` (present in stock web/headless profiles). Arming fails loudly without an attached job controller.
- For `source: command`: the shell capability (`@deepseek-ai/dsh-shell` + a provider). File sources work without it.

## Relation to neighbors

- **Stock `dsh-tool-jobs`** notifies on job *completion*; dsh-watch notifies on *output while running*. Same wake mechanism, same budget discipline, complementary moments.
- **[yoke233/dsh-tool-monitor](https://github.com/yoke233/dsh-tool-monitor)** subscribes to *already-running* bash/pwsh jobs by teeing their output. Use it to watch a job you already started; use dsh-watch to arm a dedicated watch (or tail a file) with batching and budgets.
- **[AbnerAI/dsh-monitor](https://github.com/AbnerAI/dsh-monitor)** polls a re-run command or an NDJSON inbox and wakes the agent per line. dsh-watch differs in running the command once as a stream, batching per tick, budgeting wakes and events, bounding every notice, and living inside the jobs subsystem.

## Testing

```sh
pnpm install && pnpm test    # 50 tests: line assembly, multibyte byte caps,
                             # batching, filters, budgets, truncation, teardown
```

Beyond the suite, the full lifecycle is verified against a live `dsh --profile web` session on `0.1.0-rc.6` with DeepSeek-V4-Pro (2026-08-14): arm → silence on non-matching lines → wake-on-match while idle → disarm via stock `job_kill` → silence after disarm.

Plain ESM JavaScript in `lib/` — nothing builds at install time, so a git install has no `allowBuilds` surface.

## Known Limitations and Deferred Work

- Polling, not `inotify`/`kqueue`: sub-`pollIntervalMs` latency is out of scope; the default 300 ms tick is the batch window by design.
- One regex per watch; alternation covers the multi-signature case (`error|Traceback|FAILED`).
- `stderr` of command sources arrives inside the shell provider's marked sections, not as a separate filterable channel.
- No re-arm-on-restart persistence: watches live with their session, like every background job.

## License

MIT. Not affiliated with DeepSeek. Registered in [awesome-dsh-plugins](https://github.com/dshworks/awesome-dsh-plugins).
