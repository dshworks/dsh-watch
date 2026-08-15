# ecosystem-watcher

A standing dsh agent that watches a slice of GitHub and writes down what is
worth keeping. This is the reference deployment for
[`@dshworks/dsh-watch`](../../README.md) running unattended.

```
feed.mjs ──NDJSON──▶ watch "ecosystem" ──notice──▶ agent ──▶ data/ideas.ndjson
 (a source)            (the ear)                  (the judgment)
```

Three parts, deliberately separate: the feed decides only what is *new*,
the watch decides only *when to wake*, and the agent decides what is
*interesting*. Swap the feed for any line-emitting process — a CI tail, a
webhook log, a queue drain — and the rest is unchanged.

## Run it

```sh
dsh plugin --profile watcher add @dshworks/dsh-watch
cp cordis.patch.yml ~/.dsh/profiles/watcher/cordis.patch.yml
# edit the --topic list and the brief, then:
dsh --profile watcher | tee -a watcher.log
```

`feed.mjs` needs `node` and, optionally, `GITHUB_TOKEN` — unauthenticated
search is 10 requests/minute, authenticated is 30. It writes its
seen-repository set to `.feed-state.json` beside the working directory.

## The feed

```sh
node feed.mjs --topic dsh-plugin --topic dsh-theme --interval 900
```

- **Sorted by creation date, not stars.** A repository published an hour
  ago has zero stars and sits thousands of rows below a star-sorted window.
  That single default is how a discovery sweep goes quietly blind to
  everything new.
- **The first pass is silent.** With no state file, it learns the current
  world and announces nothing — otherwise a watcher's first wake is fifty
  repositories of history.
- **State is written through a temp file and renamed**, so a feed killed
  mid-write does not replay the world on its next boot.
- **A failed poll is skipped, never reported as "nothing new."**

## Operating notes

- `max_events: 0` on the watch. A watcher that disarms itself after 50
  finds is not a watcher.
- `wakeRefillMs: 300000` gives one wake per five minutes sustained after
  the initial burst. A watcher is judged on not missing things, not on
  latency.
- The journal on stdout is the operator surface: one ISO-timestamped line
  per active period, plus a boot line. `tee -a` it and you have history.
- The agent's output is an append-only log, not a pull request. Keeping a
  human between "an idea was noticed" and "a repository changed" is the
  point, not a limitation.

## A real run

2026-08-15, DeepSeek-V4-Pro, no human in the session. The feed found 53
newly published dsh repositories; the watcher kept 11 and named why it
dropped the other 42 — gag or single-skin repos, duplicates of a keep,
alternative runtimes that are not dshworks infrastructure, and niche skills
with no home in the org.

```json
{"repo":"omdsh-dev/DSH-better-sidebar","why":"A sidebar workbench that lets third-party
 plugins register their own pages establishes a reusable sidebar extension point.",
 "for":"awesome-dsh-plugins"}
```
