# Contributing

Issues and pull requests are welcome. The bar is small and specific:

## Run it

```sh
pnpm install && pnpm test
```

91 tests, ~1 s. `pnpm-workspace.yaml` approves esbuild's postinstall (pnpm
≥ 11 reads build settings there, not from `package.json`).

## Shape of the code

- `lib/core.js` — pure logic: line assembly, UTF-8 byte capping, notice
  formatting, the wake budget. No harness imports, so it is unit-testable alone.
  New logic goes here by default.
- `lib/index.js` — the plugin: the `watch` tool, job wiring, delivery,
  `autoArm`.
- `lib/daemon.js` — the optional standing-agent host. Separate export,
  separate concern: the ear and the body compose independently.
- `recipes/` — runnable examples, not library code.

Plain ESM JavaScript with JSDoc types. Nothing builds at install time and
nothing should start to — a git install must stay free of an `allowBuilds`
surface.

## What a good change looks like

- **Every bound is config, not a constant.** If you add a number, add a
  validated `Config` field with a JSDoc line explaining what it trades.
- **Tests describe the behavior, not the implementation.** `it('does not
  wake an owner about notices it already claimed')` beats `it('clears the
  map')`.
- **Silence is never success.** If something is dropped, truncated, or
  lost upstream, say so in the stream the model reads.
- **Comments explain why.** The what is in the code.

## Verifying against a real harness

Unit tests use a stub context, which cannot tell you whether a call shape
is real. When dsh moves, raise the doubles in `tests/` to the new API first
(read the real types, not the old tests), then mutation-check them: put the
old call back and watch the suite go red. On 0.1.7 the doubles written for
0.1.5 stayed green through six real breaks.

Anything touching the harness surface — a new event, a service, a registry
call — should also be exercised in a live session before it ships, installed
the way users install it, in a scratch home:

```sh
npm pack --pack-destination /tmp
export DSH_HOME=$(mktemp -d)
dsh plugin --profile watcher add /tmp/dshworks-dsh-watch-<version>.tgz
dsh --profile watcher | tee -a watcher.log
```

Both bugs fixed in 0.2.0, and the silent `kind: 'plugin'` notice refusal
on 0.1.7, were found that way, not by the suite.

`node scripts/check-dsh-release.mjs --tree-only` checks the install half on
its own: this tree through `dsh plugin add` beside dsh `latest` (and `next`
as an advisory). It fails if dsh's compatibility gate refuses the plugin or
if the profile ends up holding a package the host already supplies, so keep
every host-supplied package in `peerDependencies`, never `dependencies`.
