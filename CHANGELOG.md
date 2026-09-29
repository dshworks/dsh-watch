# Changelog

## 0.2.3 — 2026-09-29

Runs on dsh 0.1.7 and 0.2.0. 0.2.2 installs on a 0.1.7 host without a
word (dsh's gate reads `^0.1.5-rc.1` as `>=0.1.5-rc.1 <0.2.0-0`) and then
does nothing useful: no standing watch arms, and a model-issued `watch`
fails.

- **Six breaks in the dsh 0.1.7 API, all fixed.**
  - A job's owner is now a session id. Passing the Agent made every
    `watch` call throw `session "[object Object]" has no live agent`.
  - `shell.start()` is gone. Commands now run through `shell.execute()`.
  - `execute()` kills at `timeoutMs` (two minutes by default) unless the
    request says `onExpiry: 'none'`, which a watch now always does. A
    real command watch spoke 150 s after arming and was heard.
  - The `readOutput` job hook is gone, so `job_output` read nothing. Heard
    lines now go into the job's output ring via `job.append()`.
  - `agent/session-start` is gone, so `autoArm` never fired. Standing
    watches now arm at `agent/created`, still without holding up creation.
  - The v4 session writer refuses the retired
    `{ kind: 'plugin', plugin }` message source. Notices now carry
    `{ kind: 'dsh-watch', form: 'notice', summary }`. With the old wrapper
    a live run showed the failure is silent: the watch arms, the notice
    never produces a turn or a log row, and nothing reaches stderr.
- **Peer range `^0.1.7-alpha.1 || ^0.2.0-rc.1`.** 0.1.7-alpha.1 is the
  first dsh with every API above. The 0.2.0 line went in only after the
  whole surface ran on a 0.2.0-rc.1 host. The range no longer claims
  0.1.0–0.1.5, which this code cannot run on.
- **`@deepseek-ai/schemastery` moved from `dependencies` to
  `peerDependencies`.** As a dependency, `dsh plugin add` installed it,
  with cosmokit, into the profile as a second copy that shadowed the
  host's for every plugin there.
- **Removed `backlogBytes` and `createBacklog`** (from
  `@dshworks/dsh-watch/core`). The job registry's ring holds the output
  and bounds it. A leftover `backlogBytes` in profile config is ignored.
- **The release check now measures the real install path.**
  `scripts/check-dsh-release.mjs` installs with `dsh plugin add` into a
  scratch `DSH_HOME` beside dsh `latest` (and `next`, as an advisory). It
  fails when dsh's compatibility gate refuses the plugin, or when the
  profile ends up holding a package the host supplies. The old check
  installed plugin and host into one npm tree, a path no user takes. The
  harness splits it reported were measured in that tree, not in a dsh
  profile. That includes the "15 harness packages" in the 0.2.2 entry
  below and both reports in #8. It also never saw the one split the real
  path has: schemastery in `dependencies`.
- Tests: 91. The doubles now model dsh 0.1.7: the job registry, the shell
  executor, `agent/created`, v4 source admission, and v4 log events. Each
  fix above is mutation-checked: putting the 0.2.2 call back turns the
  suite red. The doubles written for 0.1.5 had stayed green on 0.1.7
  through all six breaks.

## 0.2.2 — 2026-09-17

Installs beside dsh 0.1.5 again.

- **Peer ranges add `^0.1.5-rc.1`.** dsh `latest` moved to 0.1.5-rc.2 on
  2026-09-10, and npm never lets a prerelease satisfy a caret with a
  different version tuple, so 0.2.1 resolved its own 0.1.2-rc.1 copy of 15
  harness packages beside the host's 0.1.5 ones: no error, two harnesses.
  No 0.1.6 line — peer deps resolve to the highest match, so naming the
  alpha line would pull it in beside a 0.1.5 host.
- **Checked against the 0.1.5 API, not only the suite.** Every harness
  surface the plugin and daemon touch is unchanged in the 0.1.5 type defs.
  The session log is format v3: the journal test double now carries
  `system/message` heads and `assistant/attempt` records (no
  `data.message`), and the journal ignores both. Mutation-checked.
- The lockfile had tested against dsh 0.1.0-rc.6 all along (CI installs
  without it); it now pins 0.1.5-rc.2.

## 0.2.1 — 2026-09-04

- Peer ranges accept dsh 0.1.2-rc.1.
- The daemon journal reads `Session.snapshotEvents()`; dsh 0.1.2-alpha.4
  removed the `events` array, which had left the journal silent.
- `scripts/check-dsh-release.mjs` and a daily workflow that opens an issue
  when a dsh release no longer resolves beside this plugin.

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
