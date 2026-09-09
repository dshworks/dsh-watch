// Does this plugin still get the SAME harness the host is running?
//
// Not "does `npm i` succeed" — that is the weaker question, and it passes while
// broken. dsh ships prereleases only, and npm semver never lets a prerelease
// satisfy a caret with a different version tuple: `^0.1.0-rc.6` matches
// 0.1.0-rc.8 and nothing after it. So a stale peer range fails two ways.
//
// Loudly, when two plugins disagree: `npm i` stops with ERESOLVE.
//
// Quietly, and this is the one that matters, when a plugin is installed alone:
// npm is happy to satisfy `^0.1.0-rc.6` by HOISTING `@deepseek-ai/dsh-llm`
// 0.1.0-rc.8 to the root and pushing dsh's own 0.1.2-rc.1 copy down into a
// nested `node_modules`. 691 packages instead of 528, zero warnings, and the
// plugin now imports a four-release-old harness while the host imports the
// current one. Instances do not match, types do not match, and nothing throws.
//
// So the assertion is single-version resolution, checked on a real install.
// Twice, because they fail separately: this tree (did we fix it?) and the
// PUBLISHED package (did the fix ship? — this org has published off an
// unmerged branch before, and a fix users cannot install is not a fix).
//
// Exit 0 clean, 1 drift, 2 could not check.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `--tree-only`: check what this branch would publish, and nothing else.
const PR_ONLY = process.argv.includes('--tree-only')
const ROOT = new URL('..', import.meta.url).pathname
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const report = []
let failed = false

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** Every `@deepseek-ai/dsh*` copy under a tree, as name -> set of versions. */
function harnessVersions(dir) {
  const seen = new Map()
  const walk = (nm) => {
    if (!existsSync(nm)) return
    for (const entry of readdirSync(nm, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name === '@deepseek-ai') {
        const scope = join(nm, entry.name)
        for (const p of readdirSync(scope)) {
          if (!p.startsWith('dsh')) continue
          const manifest = join(scope, p, 'package.json')
          if (!existsSync(manifest)) continue
          const { version } = JSON.parse(readFileSync(manifest, 'utf8'))
          if (!seen.has(p)) seen.set(p, new Set())
          seen.get(p).add(version)
          walk(join(scope, p, 'node_modules'))
        }
        continue
      }
      walk(join(nm, entry.name, 'node_modules'))
    }
  }
  walk(join(dir, 'node_modules'))
  return seen
}

/**
 * Install `specs` together and assert one version of every harness package.
 *
 * `advisory` reports without failing: the ahead-of-the-tag look below is a
 * forecast, and a repo cannot act on it today (see the note there), so turning
 * it red would only teach people to ignore a red check.
 */
function check(specs, label, advisory = false) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-release-'))
  try {
    run('npm', ['init', '-y'], dir)
    run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', ...specs], dir)
  } catch (error) {
    failed = failed || !advisory
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}`
    const why = out.split('\n').filter((l) => /npm error/.test(l)).slice(0, 8).join('\n')
    report.push(`- FAIL  ${label} — install refused\n\n\`\`\`\n${why}\n\`\`\`\n`)
    return
  }
  const split = [...harnessVersions(dir)].filter(([, versions]) => versions.size > 1)
  if (split.length === 0) {
    report.push(`- ok    ${label} — one version of every harness package`)
    return
  }
  failed = failed || !advisory
  const lines = split.map(([name, versions]) => `    @deepseek-ai/${name}: ${[...versions].sort().join(', ')}`)
  report.push(
    `- FAIL  ${label} — the plugin and the host resolve different copies:\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`,
  )
}

// DSH_VERSION proves the tree against a version that is published but not
// tagged. npm ships new tuples on `alpha` for days before `latest` moves, and
// the day it moves every range written against the old tuple stops resolving
// at once — so the only way to widen a range BEFORE the outage is to install
// against the version that is coming. Unset, this checks what users get.
let latest
try {
  latest = process.env.DSH_VERSION?.trim()
    || run('npm', ['view', '@deepseek-ai/dsh', 'dist-tags.latest'], ROOT).trim()
  const how = process.env.DSH_VERSION ? 'DSH_VERSION' : '`latest` on npm'
  report.push(`dsh ${how}: **${latest}**\n`)
} catch (error) {
  console.error(`could not read dsh dist-tags: ${error.message}`)
  process.exit(2)
}

// Into a temp dir, not the repo root. `npm pack` leaves the tarball where you
// point it, and a stray .tgz beside package.json is one `git add -A` away from
// being committed — which is how these sweeps stage everything.
let tarball
const packDir = mkdtempSync(join(tmpdir(), 'dsh-release-pack-'))
try {
  tarball = join(packDir, run('npm', ['pack', '--silent', '--ignore-scripts', '--pack-destination', packDir], ROOT).trim().split('\n').pop())
} catch (error) {
  console.error(`could not pack this tree: ${error.message}`)
  console.log(report.join('\n'))
  process.exit(2)
}

check([`@deepseek-ai/dsh@${latest}`, tarball], `this tree beside dsh ${latest}`)
const treeFailed = failed

// On a pull request only THIS TREE can be green: the published package is by
// definition still the broken one on the very PR that fixes it, and a check
// that is red on its own fix is a check people switch off. The published half
// belongs to the scheduled run, which is also the only place it can clear.
if (!PR_ONLY) {
  check([`@deepseek-ai/dsh@${latest}`, `${pkg.name}@latest`], `published ${pkg.name} beside dsh ${latest}`)
}

// Ahead of the tag.
//
// npm serves new tuples on `alpha` for days before `latest` moves, and the day
// it moves every range written against the old tuple stops resolving at once.
// This asks that question early so the bump is scheduled rather than
// discovered -- but only reports, because the answer cannot be acted on yet:
// these are peerDependencies, npm installs the HIGHEST satisfying version, and
// simply OR-ing the coming line in makes the plugin pull 0.1.5 beside a 0.1.2
// host. Measured, not assumed: widening the range turned this very check red
// against `latest`. The range has to move WITH the tag, so what this buys is
// the warning, not the fix.
if (!PR_ONLY) {
  let ahead
  try {
    ahead = JSON.parse(run('npm', ['view', '@deepseek-ai/dsh', 'versions', '--json'], ROOT)).at(-1)
  } catch { ahead = null }
  if (ahead && ahead !== latest) {
    report.push(`\nnpm is also serving **${ahead}**, ahead of the tag:\n`)
    check([`@deepseek-ai/dsh@${ahead}`, tarball], `this tree beside dsh ${ahead} (advisory)`, true)
    report.push(
      `\nAdvisory only. Do not widen the range to fix it -- these are peerDependencies and npm`
      + ` installs the highest satisfying version, so adding ${ahead}'s line makes this plugin pull`
      + ` it beside a ${latest} host. Bump when the tag moves.\n`,
    )
  }
}

console.log(report.join('\n'))
process.exit((PR_ONLY ? treeFailed : failed) ? 1 : 0)
