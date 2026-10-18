// Delegation scenario: does a real delegation through the project's own
// definitions behave the way the project rules describe?
//
// This runs the built `dsh` CLI against whatever provider the caller points it
// at. `scripts/e2e.mjs` supplies either a real key (`E2E_API_KEY`, optional
// `E2E_BASE_URL`) or its own scripted model stub; this module only needs a base
// URL and a token. Every assertion reads the session log rather than the model's
// prose: the recorded request headers are what the model was actually offered.
//
// The project under test is never modified. `scripts/e2e.mjs` owns the guard that
// proves it.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * The marker the throwaway profile's example preset puts in its persona prefix.
 *
 * Asserting on a marker rather than on prose keeps the check independent of what
 * the model says: the marker can only reach the child's system prompt if the
 * Agent Preset was actually mounted for that child.
 */
export const PRESET_MARKER = 'E2E-PRESET-PERSONA'

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
 * Pick the definition that selects an Agent Preset, so the scenario can assert
 * that this child really was composed from it.
 *
 * 0.4.0 replaced the per-child `persona` and `[tools]` fields with
 * `agent_preset`, so "the composition reached the child" is now proven by the
 * preset's own persona text showing up in the child's system prompt.
 * @param project - the project holding `.dsh/agents`.
 * @returns the definition's name, its `mode`, and the preset it selects, or `undefined`.
 */
export function presetDefinition(project) {
  const agents = join(project, '.dsh', 'agents')
  if (!existsSync(agents)) return undefined
  for (const file of readdirSync(agents).filter(name => name.endsWith('.toml')).sort()) {
    const source = readFileSync(join(agents, file), 'utf8')
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(source)?.[1]
    const preset = /^\s*agent[_-]preset\s*=\s*"([^"]+)"/m.exec(source)?.[1]
    if (name === undefined || preset === undefined) continue
    // `mode` decides which activation the tool must use, so the scenario checks
    // the recorded mode against the definition that was delegated to.
    return { name, preset, mode: /^\s*mode\s*=\s*"([^"]+)"/m.exec(source)?.[1] ?? 'one-shot' }
  }
  return undefined
}

const textOf = event => (event.data?.message?.content ?? []).map(part => part?.text ?? '').join('')

/**
 * Every text part of a message event, whichever envelope carries it.
 *
 * A `system/message` nests its content under `message`; a `user/message` — which
 * is how the workspace instructions are injected — puts `content` on the event
 * data directly. Reading only one shape makes a real injection look absent.
 * @param event - a persisted session event.
 * @returns the concatenated text parts.
 */
const messageText = event => [
  ...(event.data?.message?.content ?? []),
  ...(event.data?.content ?? []),
].map(part => part?.text ?? '').join('')

/**
 * Run the keyed scenario.
 * @param options - `dshRoot` of the Harness installation, home, profile, project root,
 * provider credentials, the delegated definition whose Agent Preset is under test, and
 * the prompt to send.
 * @returns the checks and their failures.
 */
export function runHeadlessScenario(options) {
  const { dshRoot, home, profile, project, prompt, apiKey, baseUrl, preset, log = console.log } = options
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
  check('the delegation was recorded with a child',
    catalog.length > 0 && typeof catalog[0].data?.childId === 'string',
    `subagent/catalog=${JSON.stringify(catalog.map(event => ({ mode: event.data?.mode, childId: event.data?.childId })))}`)

  // The definition's `mode` does NOT reach `subagent/catalog`: that field reports
  // whether the *transport* can cold-resume (the local `spawn` provider always
  // can, so it always says `continuable`). What the definition's `mode` decides is
  // `delivery`, and the only place that becomes visible is the tool's own result:
  // `parent` delivery hands back a child id, `caller` delivery hands back the
  // child's answer. Asserting on this text is what proves the right branch ran.
  // The Messages shapes a tool result as `{ message: { toolCallId, content } }`,
  // so the call id lives one level down rather than beside the turn numbers.
  const call = events.find(event => event.type === 'tool/call' && event.data?.name === 'subagent_custom')
  const callId = call?.data?.callId
  const toolResult = events
    .filter(event => event.type === 'tool/result' && event.data?.message?.toolCallId === callId)
    .map(event => (event.data?.message?.content ?? []).map(part => part?.text ?? '').join(''))
    .at(-1) ?? ''
  const continuable = preset?.mode === 'continuable'
  check(`${continuable ? 'a continuable' : 'a one-shot'} definition returns `
    + `${continuable ? 'only a child id' : 'the child\'s answer, not a child id'}`,
  continuable
    ? /^started subagent \S+$/u.test(toolResult.trim())
    : toolResult.trim().length > 0 && !toolResult.includes('started subagent'),
  `tool/result of ${String(callId)}=${JSON.stringify(toolResult.slice(0, 160))}`)

  const childId = catalog[0]?.data?.childId
  const child = childId === undefined
    ? undefined
    : logs.find(entry => entry.name.includes(childId))
  if (child !== undefined) {
    const childEvents = child.events
    // Independent selection: a creation-time preset is recorded before the child's
    // own descriptor, which is exactly the rule the Harness itself uses to tell an
    // independent selection from a resumed historical one.
    const descriptorAt = childEvents.findIndex(event => event.type === 'subagent/descriptor')
    const selectedAt = childEvents.findIndex(event => event.type === 'agent-preset/selected')
    const selected = selectedAt === -1 ? undefined : childEvents[selectedAt]
    check(`the child was composed from Agent Preset "${preset?.preset ?? '?'}"`,
      selected !== undefined
      && selected.data?.agentPreset === preset?.preset
      && (descriptorAt === -1 || selectedAt < descriptorAt),
      selected === undefined
        ? 'the child log records no agent-preset/selected event'
        : `agent-preset/selected=${JSON.stringify(selected.data?.agentPreset)} at ${selectedAt}, `
          + `subagent/descriptor at ${descriptorAt}`)
    const renderedPrompt = childEvents.filter(event => event.type === 'system/message').map(textOf).join('\n')
    check('the preset persona reaches the child system prompt',
      renderedPrompt.includes(PRESET_MARKER),
      renderedPrompt.includes(PRESET_MARKER)
        ? `the child prompt carries "${PRESET_MARKER}"`
        : `no system/message carries "${PRESET_MARKER}"; the profile's example preset must put that marker `
          + 'in its persona `prefix`')
    // The workspace instructions arrive as an `agent-instructions` user message
    // (`<system-reminder>… Instructions from: AGENTS.md …`), not as a system
    // message, so both surfaces are searched rather than assuming one.
    const instructionEvent = childEvents.find(event =>
      (event.type === 'system/message' || event.type === 'user/message')
      && messageText(event).includes('AGENTS.md'))
    check('the project AGENTS.md reaches the child',
      instructionEvent !== undefined,
      instructionEvent === undefined
        ? 'no message in the child log carries the workspace instructions'
        : `a ${instructionEvent.type} at seq ${instructionEvent.seq} carries the workspace instructions`)
  } else {
    check('the child session log is readable', false, `no log for child ${String(childId)}`)
  }

  return { results, failures: results.filter(entry => !entry.ok), session: parent.name }
}
