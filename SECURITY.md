# Security

## What this plugin touches

`dsh-watch` makes no network call and needs no credential. It reads two
kinds of local thing:

- **A file you name**, tailed from its current end via `fs` in the dsh host
  process, with the host's own permissions.
- **A command you name**, started once through the harness shell capability
  — the same path `bash` takes, so it inherits the session's sandbox policy
  and its trusted `DSH_*` environment. dsh-watch adds no privilege and
  removes no check.

Heard lines go to the owning agent as bounded notices and into that watch's
`job_output` backlog. They are not written anywhere else, and nothing
leaves the machine.

## The two things worth thinking about

**`autoArm` runs at boot with no model in the loop.** A watch declared in
profile config starts as soon as a root session does. It is routed through
`ctx.tools.execute()`, so approval policy and guards still apply — but a
profile patch is deployment-owned configuration, at the same trust level as
the profile itself. Treat `~/.dsh/profiles/*/cordis.patch.yml` as code.

**A watch is a channel into the agent's context.** Whatever the stream says
becomes model input. If the source is attacker-influenced (a public
webhook log, a shared CI feed), it can attempt prompt injection like any
other untrusted content. Pattern-filter narrowly, and do not point a watch
at something a stranger can write to unless the agent's brief accounts for
it.

## Reporting

Open a [private security advisory](https://github.com/dshworks/dsh-watch/security/advisories/new),
or a normal issue if the problem is not sensitive. Expect a reply within a
few days; this is a small volunteer-maintained plugin, not a product with
an on-call rotation.

Please do not include an API key, a session log, or a `.env` file in a
report — a redacted description of the behavior is enough.
