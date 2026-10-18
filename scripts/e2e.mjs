// Run the plugin's end-to-end scenarios against a real Harness.
//
//   node scripts/e2e.mjs                # the keyless Loader scenario
//   E2E_PROJECT=<dir> [E2E_API_KEY=...] # adds the delegation scenario
//   E2E_GUI=<url>                       # adds the browser scenarios
//
// Environment:
//   E2E_DSH_ROOT     Harness installation (defaults to the installed @deepseek-ai/dsh)
//   E2E_PLUGIN_ROOT  this checkout (defaults to the repository root)
//   E2E_HOME         a throwaway DSH home; the delegation scenario needs a profile there
//   E2E_PROFILE      profile inside that home for the headless run (default `plugin-dev`)
//   E2E_GUI_PROFILE  profile the browser instance runs, when it differs (default `plugin-gui`)
//   E2E_PROJECT      project whose `.dsh/agents` definitions are exercised
//   E2E_API_KEY      provider key; without it a scripted Messages stub stands in for the model
//   E2E_BASE_URL     provider base URL, when the key does not target the default endpoint
//   E2E_GUI          URL of a running Harness Web instance to drive over CDP
//   E2E_CDP_PORT     remote debugging port for that instance (default 9222)
//
// The delegation scenario needs a model that will delegate. With `E2E_API_KEY`
// that is the real provider; without one, `scripts/e2e-model-stub.mjs` speaks the
// same Messages wire protocol and decides to delegate deterministically, which
// keeps the whole chain below the model real (Loader, `subagent` service, Agent
// Preset registry, this plugin's tool) while costing no tokens.
//
// The project under test is only read and reverted: the guard below hashes every
// definition and `AGENTS.md` before the run and proves all of them unchanged
// after it.
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { definitionNames, presetDefinition, PRESET_MARKER } from './e2e-headless.mjs'

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

/**
 * Start the scripted model in its own process.
 *
 * It cannot live in this one: the delegation scenario drives the headless run
 * synchronously, so a stub sharing this event loop would deadlock against it.
 * @param options - the plugin root, the definition to delegate to, and the preset marker.
 * @returns the stub's base URL and a synchronous teardown.
 */
async function startStubModel({ pluginRoot: root, agentType, presetMarker }) {
  const script = join(root, 'scripts', 'e2e-model-stub.mjs')
  const child = spawn(process.execPath, [
    script, '--port', '0', '--agent-type', agentType, '--preset-marker', presetMarker,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  const baseUrl = await new Promise((resolve, reject) => {
    let buffered = ''
    const timer = setTimeout(() => reject(new Error('the model stub did not report a port in 10s')), 10_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      buffered += chunk
      const match = /stub listening (http:\/\/\S+)/.exec(buffered)
      if (match !== null) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`the model stub exited with ${String(code)}`)) })
  })
  return { baseUrl, close: () => { child.kill() } }
}

/**
 * Refuse to run against the operator's own DSH home.
 *
 * Both keyed tiers write into the home they are pointed at — the delegation tier
 * adds Agent Preset rows to a profile patch, and the browser tier saves the trust
 * switch into one and creates and deletes a file in the project — so
 * `E2E_HOME=~/.dsh` would silently rewrite a live installation and a real
 * project. The driver owns that decision rather than each tier, because the check
 * is about the environment the caller supplied, not about either scenario.
 * @param home - the `DSH_HOME` under test, when one was given.
 */
function refuseLiveHome(home) {
  if (home === undefined) return
  const real = resolve(homedir(), '.dsh')
  const target = resolve(home)
  if (target === real) {
    throw new Error(`refusing to write into the live DSH home at ${target}; point E2E_HOME at a throwaway directory`)
  }
}

const dshRoot = resolveDshRoot()
const home = process.env.E2E_HOME
const project = process.env.E2E_PROJECT
const apiKey = process.env.E2E_API_KEY
refuseLiveHome(home)
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

if (project !== undefined) {
  if (home === undefined) throw new Error('E2E_HOME is required for the delegation scenario')
  console.log(`\n== Delegation scenario (${apiKey === undefined ? 'scripted stub' : 'real provider'}) ==`)
  const profile = process.env.E2E_PROFILE ?? 'plugin-dev'
  const before = snapshotProject(project)
  const preset = presetDefinition(project)
  if (preset === undefined) {
    throw new Error(`${project} has no definition with an agent_preset, so the scenario cannot prove the preset reached the child`)
  }
  // `agent_preset` needs a composition that mounts the preset registry, and the
  // headless default profile does not; the scenario therefore has to declare both
  // the registry and an example preset in its own throwaway profile.
  const { ensurePresetProfile } = await import('./e2e-preset-profile.mjs')
  ensurePresetProfile({ home, profile, dshRoot })

  // Without a key, the model itself is scripted: the stub speaks the provider
  // protocol and decides to delegate, so everything below the model stays real.
  // It has to be its own process: the headless run is driven synchronously, and a
  // stub sharing this process's event loop could never answer it.
  let stub
  if (apiKey === undefined) {
    stub = await startStubModel({ pluginRoot, agentType: preset.name, presetMarker: PRESET_MARKER })
    console.log(`  stub model at ${stub.baseUrl}`)
  }
  try {
    const { runHeadlessScenario } = await import('./e2e-headless.mjs')
    const headless = runHeadlessScenario({
      dshRoot,
      home,
      profile,
      project,
      // One narrow delegation, naming the definition that selects a preset so the
      // child session can be checked for the preset's effect. A broader prompt only
      // spends tokens without adding evidence.
      prompt: `只做一件事：调用一次 subagent_custom，agent_type 必须是 "${preset.name}"，prompt 写"只回复一行：已确认"。`
        + '拿到子代理结果后直接结束本轮，不要做别的检索，也不要自己再委派。',
      // The stub accepts any bearer token; a real provider needs the real one.
      apiKey: apiKey ?? 'stub-key',
      baseUrl: process.env.E2E_BASE_URL ?? stub?.baseUrl,
      preset,
    })
    sections.push({ name: 'delegation', failures: headless.failures })
  } finally {
    stub?.close()
  }

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
  console.log('\n== Delegation scenario skipped: set E2E_PROJECT to run it ==')
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
