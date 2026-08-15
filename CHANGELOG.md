# Changelog

## 0.2.0 — 2026-08-15

The watcher grows a body. First npm release, as `@dshworks/dsh-watch`.

- **An unattended agent no longer goes deaf.** The wake budget was a
  counter of consecutive wakes, refilled by the next user message — the
  `dsh-tool-jobs` rule, correct for a conversation and a one-way door for
  a session nobody is in. Past the last credit, every notice was injected
  into an idle agent that nothing would ever wake again. It is now a token
  bucket: burst `maxConsecutiveWakes`, then one credit back per the new
  `wakeRefillMs` (default 60 s). A user message still refills it fully, and
  `wakeRefillMs: 0` reproduces 0.1.1 exactly.
- **Notices queued while starved earn a catch-up wake.** Injection alone
  never wakes the driver, so the last notice before a quiet spell used to
  sit unread forever. The poll tick now sweeps for it; one credit recovers
  the whole queue, because opening a turn claims all pending input.
- **`max_events: 0` listens indefinitely.** A watcher that disarms itself
  after 50 finds is not a watcher. `defaultMaxEvents` accepts 0 too.
- **`autoArm`: watches the deployment arms for itself.** Standing watches
  declared in profile config, armed for the root session at
  `agent/session-start` through `ctx.tools.execute()` — so a configured
  watch passes the same guards, approval policy, sandbox, and shell
  environment a model-issued one would, and no caller mints an execution
  token. Subagents are skipped. A second prompt section names the standing
  watches so the model does not re-arm them.
- **New export `@dshworks/dsh-watch/daemon`.** A ~90-line host for an agent
  that has no task and no browser: it creates one agent, seeds a standing
  brief, holds the process open, flushes the session on an interval, and
  writes each active period's closing text to stdout as a timestamped
  operator journal — including a boot line, so a slow first turn is not
  mistaken for a dead daemon.
- **Fix: no spurious wake about notices already answered.** Notices
  injected into a *busy* owner are claimed at its next step, but they were
  still counted as owed a catch-up wake — producing a wake whose entire
  content was "you have queued notices", for notices already handled. Found
  in a live unattended run; the count now clears on `agent/inbox/claimed`.
- **Fix: `pnpm install` failed on pnpm ≥ 11.** Build approval moved out of
  `package.json`'s `pnpm` field, which is now silently ignored, and was
  renamed; `pnpm-workspace.yaml` carries `allowBuilds: {esbuild: true}`.
- `recipes/ecosystem-watcher/` — a runnable feed that polls GitHub topics
  by creation date and emits one NDJSON line per unseen repository, plus
  the profile patch that wires it to the daemon.
- 83 tests, up from 50.

## 0.1.1 — 2026-08-14

- Leak-proof arming: a listener whose job the registry rejects after
  `run()` is torn down instead of polling forever.
- CI, and live verification of the full lifecycle against a real
  `dsh --profile web` session.

## 0.1.0 — 2026-08-14

First release, as `dsh-hydrophone`, renamed to `dsh-watch` the same day —
the name should say what it does. Background stream listeners that wake the
agent, as first-class jobs.
