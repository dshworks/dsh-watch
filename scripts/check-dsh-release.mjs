// Does this plugin install the way users install it, and share the host's harness?
//
// Users install plugins with `dsh plugin --profile <p> add <spec>`. That runs
// pnpm inside `$DSH_HOME/profiles/<p>` with `nodeLinker: hoisted` and
// `autoInstallPeers: false`, after a compatibility gate that checks every
// `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer range against the running dsh
// with prereleases included (dsh >= 0.1.7-rc.1, app-boot
// plugin-compatibility.ts). At load, any harness import not physically present
// in the profile's node_modules resolves to the HOST installation's copy.
//
// So two things can go wrong, and this checks both on a real install:
//
// 1. The gate refuses the plugin: `dsh plugin add` exits nonzero and rolls
//    back. A peer range that stops short of the host's line does this.
// 2. The plugin drags a package the host already supplies into the profile —
//    through `dependencies`, never peers, since peers are not auto-installed.
//    That physical copy shadows the host's for EVERY plugin in the profile:
//    two schemastery instances, two cosmokits, no warning.
//
// What this replaced: `npm install @deepseek-ai/dsh <plugin>` into one fresh
// tree, asserting one version of each harness package. No user installs that
// way. In that tree npm installs the plugin's peers itself, so a stale peer
// range showed up as harness packages "at two versions"; on the real path
// peers are never installed into the profile and the host's copy is the one
// loaded. The "13 harness packages at two versions" this repo used to cite
// (dsh-watch 0.2.0 beside dsh 0.1.2-rc.1) was measured in that proxy tree,
// and so was the rule "never OR the next dsh line into the peer range": on
// the real path a wider range changes only what the gate admits. The proxy
// also missed the split the real path does have — a host-supplied package in
// `dependencies` (dsh-watch <= 0.2.2 hoisted schemastery and cosmokit into
// the profile).
//
// Checked for this tree (`--tree-only`, what a PR would publish) and, by
// default, for the PUBLISHED package too — a fix users cannot install is not a
// fix. The host is dsh `latest` (or DSH_VERSION); `next`, when npm serves it
// ahead of `latest`, is checked as an advisory and never fails the run.
//
// Needs node, npm and pnpm (>= 10) on PATH; dsh itself calls pnpm.
// Exit 0 clean, 1 drift, 2 could not check.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

// `--tree-only`: check what this branch would publish, and nothing else.
const PR_ONLY = process.argv.includes('--tree-only')
const ROOT = new URL('..', import.meta.url).pathname
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const WORK = mkdtempSync(join(tmpdir(), 'dsh-release-'))
// Every dsh host below is a full install (about 500 MB); never leave one
// behind. An exit handler rather than `finally`: the early failures below
// leave through process.exit(), which skips `finally` blocks.
process.on('exit', () => rmSync(WORK, { recursive: true, force: true }))
const report = []
let drift = false
let unchecked = false

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** Every `@deepseek-ai/*` package directory under a node_modules tree, as name -> [{ dir, version }]. */
function scopePackages(nodeModules) {
  const found = new Map()
  const walk = (nm) => {
    if (!existsSync(nm)) return
    for (const entry of readdirSync(nm, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.bin' || entry.name === '.pnpm') continue
      const dirs = entry.name.startsWith('@')
        ? readdirSync(join(nm, entry.name), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(entry.name, d.name))
        : [entry.name]
      for (const name of dirs) {
        const dir = join(nm, name)
        const manifest = join(dir, 'package.json')
        if (name.startsWith('@deepseek-ai/') && existsSync(manifest)) {
          const { version } = JSON.parse(readFileSync(manifest, 'utf8'))
          if (!found.has(name)) found.set(name, [])
          found.get(name).push({ dir, version })
        }
        walk(join(dir, 'node_modules'))
      }
    }
  }
  walk(nodeModules)
  return found
}

/** Install one dsh host into a scratch prefix, once per version. */
const hosts = new Map()
function host(version) {
  if (hosts.has(version)) return hosts.get(version)
  const dir = join(WORK, `host-${version}`)
  run('mkdir', ['-p', dir], WORK)
  run('npm', ['init', '-y'], dir)
  run('npm', ['install', '--no-audit', '--no-fund', `@deepseek-ai/dsh@${version}`], dir)
  const entry = { bin: join(dir, 'node_modules', '.bin', 'dsh'), supplies: scopePackages(join(dir, 'node_modules')) }
  hosts.set(version, entry)
  return entry
}

let checks = 0
/**
 * `dsh plugin --profile web add <spec>` on a scratch DSH_HOME beside dsh
 * `version`, then look for host-supplied packages inside the profile.
 * `advisory` reports without failing: a host ahead of `latest` is a forecast.
 */
function check(spec, version, label, advisory = false) {
  let hostInstall
  try {
    hostInstall = host(version)
  } catch (error) {
    unchecked = unchecked || !advisory
    const why = String(error.stderr ?? error.message).split('\n').filter(l => /npm error/.test(l)).slice(0, 6).join('\n')
    report.push(`- ????  ${label} — could not install dsh ${version}:\n\n\`\`\`\n${why || String(error.message).split('\n')[0]}\n\`\`\`\n`)
    return
  }
  const home = join(WORK, `home-${++checks}`)
  const add = spawnSync(hostInstall.bin, ['plugin', '--profile', 'web', 'add', spec], {
    cwd: WORK,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
  })
  const out = `${add.stdout ?? ''}${add.stderr ?? ''}`
  if (add.status !== 0) {
    if (add.status === 127 || /pnpm was not found/.test(out)) {
      unchecked = unchecked || !advisory
      report.push(`- ????  ${label} — pnpm is not on PATH, so dsh cannot install plugins here`)
      return
    }
    drift = drift || !advisory
    const why = [...new Set(out.split('\n').filter(l => /rejected|incompatible|ERR|error/i.test(l)))].slice(0, 6).join('\n')
    report.push(`- FAIL  ${label} — \`dsh plugin add\` exited ${add.status}:\n\n\`\`\`\n${why || out.slice(-1500)}\n\`\`\`\n`)
    return
  }
  const profileModules = join(home, 'profiles', 'web', 'node_modules')
  const shadows = [...scopePackages(profileModules)]
    .filter(([name]) => hostInstall.supplies.has(name))
    .flatMap(([name, copies]) => copies.map(({ dir, version: v }) =>
      `    ${name}@${v} (host ships ${hostInstall.supplies.get(name).map(c => c.version).join(', ')}) at ${relative(home, dir)}`))
  if (shadows.length === 0) {
    report.push(`- ok    ${label} — installed; the profile holds no package the host supplies`)
    return
  }
  drift = drift || !advisory
  report.push(
    `- FAIL  ${label} — installed, but the profile now carries its own copy of packages the host supplies,\n`
    + `  which shadow the host's for every plugin in the profile (move them from dependencies to peerDependencies):\n\n`
    + `\`\`\`\n${shadows.join('\n')}\n\`\`\`\n`,
  )
}

// Which hosts: DSH_VERSION, else `latest`; `next` only when npm serves it ahead.
let latest
let next
try {
  const view = JSON.parse(run('npm', ['view', '@deepseek-ai/dsh', 'dist-tags', 'versions', '--json'], ROOT))
  const versions = view.versions ?? []
  latest = process.env.DSH_VERSION?.trim() || view['dist-tags'].latest
  const tagged = view['dist-tags'].next
  if (tagged && tagged !== latest && versions.indexOf(tagged) > versions.indexOf(latest)) next = tagged
  report.push(`dsh ${process.env.DSH_VERSION ? 'DSH_VERSION' : '`latest` on npm'}: **${latest}**${next ? ` (\`next\`: ${next}, advisory)` : ''}\n`)
} catch (error) {
  console.error(`could not read dsh dist-tags: ${error.message}`)
  process.exit(2)
}

// Pack into the scratch dir, not the repo root: a stray .tgz beside
// package.json is one `git add -A` away from being committed.
let tarball
try {
  tarball = join(WORK, run('npm', ['pack', '--silent', '--ignore-scripts', '--pack-destination', WORK], ROOT).trim().split('\n').pop())
} catch (error) {
  console.error(`could not pack this tree: ${error.message}`)
  process.exit(2)
}

check(tarball, latest, `this tree on dsh ${latest}`)
// On a pull request only THIS TREE can be green: the published package is by
// definition still the old one on the very PR that fixes it.
if (!PR_ONLY) check(`${pkg.name}@latest`, latest, `published ${pkg.name} on dsh ${latest}`)
if (next) {
  check(tarball, next, `this tree on dsh ${next} (advisory)`, true)
  if (!PR_ONLY) check(`${pkg.name}@latest`, next, `published ${pkg.name} on dsh ${next} (advisory)`, true)
}

console.log(report.join('\n'))
process.exit(drift ? 1 : unchecked ? 2 : 0)
