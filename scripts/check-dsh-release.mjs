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

/** Install `specs` together and assert one version of every harness package. */
function check(specs, label) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-release-'))
  try {
    run('npm', ['init', '-y'], dir)
    run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', ...specs], dir)
  } catch (error) {
    failed = true
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
  failed = true
  const lines = split.map(([name, versions]) => `    @deepseek-ai/${name}: ${[...versions].sort().join(', ')}`)
  report.push(
    `- FAIL  ${label} — the plugin and the host resolve different copies:\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`,
  )
}

let latest
try {
  latest = run('npm', ['view', '@deepseek-ai/dsh', 'dist-tags.latest'], ROOT).trim()
  report.push(`dsh \`latest\` on npm: **${latest}**\n`)
} catch (error) {
  console.error(`could not read dsh dist-tags: ${error.message}`)
  process.exit(2)
}

let tarball
try {
  tarball = join(ROOT, run('npm', ['pack', '--silent', '--ignore-scripts'], ROOT).trim().split('\n').pop())
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

console.log(report.join('\n'))
process.exit((PR_ONLY ? treeFailed : failed) ? 1 : 0)
