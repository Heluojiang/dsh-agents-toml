// Run the plugin's end-to-end scenarios against a real Harness.
//
//   node scripts/e2e.mjs                # the keyless Loader scenario
//   E2E_PROJECT=<dir> E2E_API_KEY=...   # adds the keyed delegation scenario
//   E2E_GUI=<url>                       # adds the browser scenarios
//
// Environment:
//   E2E_DSH_ROOT     Harness installation (defaults to the installed @deepseek-ai/dsh)
//   E2E_PLUGIN_ROOT  this checkout (defaults to the repository root)
//   E2E_HOME         a throwaway DSH home; the keyed scenario needs a profile there
//   E2E_PROFILE      profile inside that home for the headless run (default `plugin-dev`)
//   E2E_GUI_PROFILE  profile the browser instance runs, when it differs (default `plugin-gui`)
//   E2E_PROJECT      project whose `.dsh/agents` definitions are exercised
//   E2E_BASE_URL     provider base URL, when the key does not target the default endpoint
//   E2E_API_KEY      provider key; without it the keyed scenario is skipped, not failed
//   E2E_GUI          URL of a running Harness Web instance to drive over CDP
//   E2E_CDP_PORT     remote debugging port for that instance (default 9222)
//
// The project under test is only read and reverted: the guard below hashes every
// definition and `AGENTS.md` before the run and proves all of them unchanged
// after it.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { definitionNames, deniedDefinition } from './e2e-headless.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(process.env.E2E_PLUGIN_ROOT ?? join(here, '..'))

/** Locate the Harness installation, or fail loud rather than skip silently. */
function resolveDshRoot() {
  if (process.env.E2E_DSH_ROOT !== undefined) return process.env.E2E_DSH_ROOT
  try {
    return dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
  } catch {
    const beside = join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh')
    if (existsSync(beside)) return beside
    throw new Error('cannot locate @deepseek-ai/dsh; set E2E_DSH_ROOT to its directory')
  }
}

/** Git-visible state plus a hash of every definition, so a run can prove what it left behind. */
function snapshotProject(project) {
  const files = []
  const agents = join(project, '.dsh', 'agents')
  if (existsSync(agents)) {
    for (const name of readdirSync(agents).sort()) files.push(join(agents, name))
  }
  const instructions = join(project, 'AGENTS.md')
  if (existsSync(instructions)) files.push(instructions)
  const hashes = {}
  for (const file of files) {
    hashes[file] = createHash('sha256').update(readFileSync(file)).digest('hex')
  }
  const status = runGitStatus(project)
  return { hashes, status }
}

/** `git status --porcelain` for the project, or a marker when it is not a checkout. */
function runGitStatus(project) {
  if (!existsSync(join(project, '.git'))) return 'not-a-git-checkout'
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8' })
  return result.status === 0 ? result.stdout : `git failed: ${String(result.stderr).slice(0, 200)}`
}

const dshRoot = resolveDshRoot()
const home = process.env.E2E_HOME
const project = process.env.E2E_PROJECT
const apiKey = process.env.E2E_API_KEY
const guiUrl = process.env.E2E_GUI

console.log(`dsh:    ${dshRoot}`)
console.log(`plugin: ${pluginRoot}`)
if (home !== undefined) console.log(`home:   ${home}`)
if (project !== undefined) console.log(`project:${project}`)

const sections = []

console.log('\n== Loader scenario (keyless) ==')
const { runLoaderScenario } = await import('./e2e-loader.mjs')
const loader = await runLoaderScenario({ dshRoot, pluginRoot })
sections.push({ name: 'loader', failures: loader.failures })

if (apiKey !== undefined && project !== undefined) {
  if (home === undefined) throw new Error('E2E_HOME is required for the keyed scenario')
  console.log('\n== Delegation scenario (keyed) ==')
  const before = snapshotProject(project)
  const denied = deniedDefinition(project)
  if (denied === undefined) {
    throw new Error(`${project} has no definition with a non-empty [tools] deny list, so the scenario cannot prove a removal`)
  }
  const { runHeadlessScenario } = await import('./e2e-headless.mjs')
  const headless = runHeadlessScenario({
    dshRoot,
    home,
    profile: process.env.E2E_PROFILE ?? 'plugin-dev',
    project,
    // One narrow delegation, naming the definition that denies tools so the
    // recorded child tool table can be compared against its deny list. A broader
    // prompt only spends tokens without adding evidence.
    prompt: `只做一件事：调用一次 subagent_custom，agent_type 必须是 "${denied.name}"，prompt 写"只回复一行：已确认"。`
      + '拿到子代理结果后直接结束本轮，不要做别的检索，也不要自己再委派。',
    apiKey,
    baseUrl: process.env.E2E_BASE_URL,
    denied,
  })
  sections.push({ name: 'delegation', failures: headless.failures })

  const after = snapshotProject(project)
  const changed = Object.keys({ ...before.hashes, ...after.hashes })
    .filter(file => before.hashes[file] !== after.hashes[file])
  console.log(`  ${changed.length === 0 ? 'PASS' : 'FAIL'}  the project was left untouched  `
    + `${changed.length === 0 ? `${Object.keys(after.hashes).length} definition file(s) unchanged` : `changed: ${changed.join(', ')}`}`)
  if (changed.length > 0) sections.push({ name: 'guard', failures: [{ id: 'project-untouched' }] })
  if (before.status !== after.status) {
    console.log(`  FAIL  git status moved\n    before: ${before.status}\n    after:  ${after.status}`)
    sections.push({ name: 'guard', failures: [{ id: 'git-status-stable' }] })
  }
} else {
  console.log('\n== Delegation scenario skipped: set E2E_PROJECT and E2E_API_KEY to run it ==')
}

if (guiUrl !== undefined) {
  if (home === undefined || project === undefined) {
    throw new Error('E2E_HOME and E2E_PROJECT are required for the browser scenarios')
  }
  console.log('\n== Browser scenarios (keyed) ==')
  const { runGuiScenarios } = await import('./e2e-gui.mjs')
  const gui = await runGuiScenarios({
    url: guiUrl,
    port: Number(process.env.E2E_CDP_PORT ?? 9222),
    project,
    home,
    profile: process.env.E2E_GUI_PROFILE ?? 'plugin-gui',
    projectNames: definitionNames(project),
  })
  for (const entry of gui) sections.push({ name: entry.name, failures: entry.failures })
} else {
  console.log('\n== Browser scenarios skipped: set E2E_GUI to the Harness Web URL to run them ==')
}

const failed = sections.filter(section => section.failures.length > 0)
console.log('\n== summary ==')
for (const section of sections) {
  console.log(`  ${section.failures.length === 0 ? 'PASS' : `FAIL (${section.failures.length})`}  ${section.name}`)
}
process.exit(failed.length === 0 ? 0 : 1)
