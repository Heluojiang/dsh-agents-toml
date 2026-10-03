// Keyed scenario: does a real delegation through the project's own definitions
// behave the way the project rules describe?
//
// This runs the built `dsh` CLI against a real provider, so it needs credentials
// (`E2E_API_KEY`, optional `E2E_BASE_URL`). Every assertion reads the session log
// rather than the model's prose: the recorded request headers are what the model
// was actually offered.
//
// The project under test is never modified. `scripts/e2e.mjs` owns the guard that
// proves it.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Decode a DSH session log: concatenated zstd frames, one JSONL chunk each. */
export function readSession(dir) {
  const file = statSync(dir).isDirectory() ? join(dir, 'session.v4.jsonl.zstd') : dir
  const buffer = readFileSync(file)
  const offsets = []
  for (let at = 0; (at = buffer.indexOf(MAGIC, at)) !== -1; at += 1) offsets.push(at)
  offsets.push(buffer.length)
  const events = []
  for (let index = 0; index < offsets.length - 1; index += 1) {
    let text
    try {
      text = zstdDecompressSync(buffer.subarray(offsets[index], offsets[index + 1])).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        events.push(JSON.parse(line))
      } catch { /* a partial trailing line is not an event */ }
    }
  }
  return events
}

/**
 * The session directory DSH derives from a working directory.
 *
 * Runs of separators collapse into one `-`, characters outside `[A-Za-z0-9._-]`
 * become `~XXXX` code points, and the result is wrapped in `--…--`. Reproducing
 * this rule is what lets a scenario find the log without a session id.
 * @param home - the Harness home holding `sessions/`.
 * @param cwd - the session's working directory.
 * @returns the absolute session group directory.
 */
export function sessionGroup(home, cwd) {
  let readable = ''
  let separatorRun = false
  for (const ch of cwd) {
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const name = `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
  return join(home, 'sessions', name)
}

/** Definition names declared by a project's `.dsh/agents/*.toml` files, sorted. */
export function definitionNames(project) {
  const agents = join(project, '.dsh', 'agents')
  if (!existsSync(agents)) return []
  return readdirSync(agents)
    .filter(name => name.endsWith('.toml'))
    .map(name => /^\s*name\s*=\s*"([^"]+)"/m.exec(readFileSync(join(agents, name), 'utf8'))?.[1])
    .filter(name => name !== undefined)
    .sort()
}

/**
 * Pick the definition whose `[tools] deny` list is non-empty, so the scenario
 * can assert that the removal shows up in the child's recorded tool table.
 * @param project - the project holding `.dsh/agents`.
 * @returns the definition's name and deny list, or `undefined` when none denies anything.
 */
export function deniedDefinition(project) {
  const agents = join(project, '.dsh', 'agents')
  if (!existsSync(agents)) return undefined
  for (const file of readdirSync(agents).filter(name => name.endsWith('.toml')).sort()) {
    const source = readFileSync(join(agents, file), 'utf8')
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(source)?.[1]
    const block = /^\s*deny\s*=\s*\[([^\]]*)\]/m.exec(source)?.[1]
    if (name === undefined || block === undefined) continue
    const names = [...block.matchAll(/"([^"]+)"/g)].map(match => match[1])
    if (names.length > 0) return { name, denies: names }
  }
  return undefined
}

const textOf = event => (event.data?.message?.content ?? []).map(part => part?.text ?? '').join('')

/**
 * Run the keyed scenario.
 * @param options - `dshRoot` of the Harness installation, home, profile, project root,
 * provider credentials, the delegated definition whose `deny` list is under test, and
 * the prompt to send.
 * @returns the checks and their failures.
 */
export function runHeadlessScenario(options) {
  const { dshRoot, home, profile, project, prompt, apiKey, baseUrl, denied, log = console.log } = options
  const results = []
  const check = (id, ok, detail) => {
    results.push({ id, ok, detail })
    log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`)
  }

  const group = sessionGroup(home, project)
  const before = existsSync(group) ? new Set(readdirSync(group)) : new Set()

  const env = { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: apiKey }
  if (baseUrl !== undefined) env.DEEPSEEK_BASE_URL = baseUrl
  // Run the installation's own entry point with this Node, so no shell and no
  // command-name lookup is involved.
  const run = spawnSync(process.execPath, [join(dshRoot, 'lib', 'bin.js'), '--profile', profile, '--json', prompt], {
    cwd: project,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (run.status !== 0) {
    check('the headless run completed', false, `exit ${run.status}: ${(run.stderr ?? '').slice(0, 300)}`)
    return { results, failures: results.filter(entry => !entry.ok), session: undefined }
  }

  const created = existsSync(group)
    ? readdirSync(group).filter(name => !before.has(name)).map(name => ({ name, dir: join(group, name) }))
    : []
  // The parent is the log that records the delegation; a continuable child writes
  // its own log and may be newer, so directory order cannot identify the parent.
  const logs = created.map(entry => ({ ...entry, events: readSession(entry.dir) }))
  const parent = logs.find(entry => entry.events.some(event => event.type === 'subagent/catalog'))
    ?? logs.find(entry => entry.events.some(event => event.type === 'request/header'))
  if (parent === undefined) {
    check('the run produced a session log', false, `no new session under ${group} recorded a request`)
    return { results, failures: results.filter(entry => !entry.ok), session: undefined }
  }
  const events = parent.events

  const headerOf = candidate => (candidate.data?.header?.tools ?? [])
  const header = events.find(event => event.type === 'request/header')
  const tools = header === undefined ? [] : headerOf(header)
  const delegation = tools.find(tool => tool.name === 'subagent_custom')
  const projectNames = definitionNames(project)

  check('the delegation tool is registered',
    delegation !== undefined,
    `subagent_custom ${delegation === undefined ? 'ABSENT' : 'present'} among ${tools.length} tools`)
  check('agent_type lists exactly the project definitions',
    delegation !== undefined
    && JSON.stringify([...delegation.parameters.properties.agent_type.enum].sort()) === JSON.stringify(projectNames),
    `enum=${JSON.stringify(delegation?.parameters?.properties?.agent_type?.enum)} expected=${JSON.stringify(projectNames)}`)
  check('the model-facing enumeration carries each description',
    projectNames.every(name => (delegation?.parameters?.properties?.agent_type?.description ?? '').includes(name)),
    'every definition name appears in the agent_type hint')

  const catalog = events.filter(event => event.type === 'subagent/catalog')
  check('the delegation was recorded with a child and a mode',
    catalog.length > 0 && typeof catalog[0].data?.childId === 'string',
    `subagent/catalog=${JSON.stringify(catalog.map(event => ({ mode: event.data?.mode, childId: event.data?.childId })))}`)

  const childId = catalog[0]?.data?.childId
  const child = childId === undefined
    ? undefined
    : logs.find(entry => entry.name.includes(childId))
  if (child !== undefined) {
    const childEvents = child.events
    const childHeader = childEvents.find(event => event.type === 'request/header')
    const childTools = childHeader === undefined ? [] : headerOf(childHeader)
    const present = (denied?.denies ?? []).filter(name => childTools.some(tool => tool.name === name))
    check(`the child's tool table omits the denied tools of "${denied?.name ?? 'the delegated definition'}"`,
      denied !== undefined && present.length === 0,
      denied === undefined
        ? 'no project definition denies any tool, so nothing to prove'
        : `child offers ${childTools.length} tools; ${denied.denies.join('/')} ${present.length === 0 ? 'absent' : `present: ${present.join(', ')}`}`)
    const injected = childEvents.some(event => event.type === 'system/message' && textOf(event).includes('AGENTS.md'))
    check('the project AGENTS.md reaches the child',
      injected,
      injected ? 'a system/message in the child log carries the workspace instructions' : 'no workspace-instruction event')
  } else {
    check('the child session log is readable', false, `no log for child ${String(childId)}`)
  }

  return { results, failures: results.filter(entry => !entry.ok), session: parent.name }
}
