// Give a throwaway profile the pieces `agent_preset` needs.
//
// Since 0.2.1 a child's persona and tool set come from an Agent Preset, and the
// preset registry is not in every composition: the web bundle mounts it (with the
// four shipped presets), the packaged headless bundle does not. The delegation
// scenario has to prove the preset actually reached the child, so it needs a
// profile that offers every preset the project's definitions name — hence the
// ids are read off the project rather than assumed.
//
// Only the rows the composition is actually missing are written, and that is
// decided by asking the Harness itself (`--dump-config`) when a `dshRoot` is
// given: inserting a second `agent-preset-registry` row into a profile whose
// bundle already mounts one would leave two providers for the same service.
//
// The profile is expected to be a throwaway one (`E2E_HOME`). The guard in
// `ensurePresetProfile` refuses to touch anything that looks like the operator's
// real home, because silently rewriting a live profile would be a much worse bug
// than a failed test.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { PRESET_MARKER } from './e2e-headless.mjs'

/**
 * Id of the example preset written when the project names none.
 *
 * A project whose definitions all omit `agent_preset` still exercises the
 * delegation path, so the scenario keeps its own preset for the registry row's
 * `default` — there is nothing to compose from otherwise.
 */
export const E2E_PRESET_ID = 'e2e-preset'

/** Marker comment, so a re-run can tell "already set up" from "patch written by hand". */
const MANAGED = '# ── dsh-agents-toml e2e: agent-presets for the delegation scenario ──'

/**
 * Every Agent Preset id the project's definitions select.
 *
 * A definition that names a preset fails at call time unless this profile
 * declares it, so the scenario has to look at the project instead of assuming a
 * fixed id: the sample project names one preset per role, and a hard-coded id
 * would fail on "not registered" instead of proving the 0.2.2 contract.
 * @param project - the project holding `.dsh/agents`, when one was given.
 * @returns the ids in stable order, deduplicated; empty when none is named.
 */
export function projectPresetIds(project) {
  if (project === undefined) return []
  const agents = join(project, '.dsh', 'agents')
  if (!existsSync(agents)) return []
  const ids = new Set()
  for (const file of readdirSync(agents).filter(name => name.endsWith('.toml')).sort()) {
    const source = readFileSync(join(agents, file), 'utf8')
    const preset = /^\s*agent[_-]preset\s*=\s*"([^"]+)"/m.exec(source)?.[1]
    if (preset !== undefined) ids.add(preset)
  }
  return [...ids].sort()
}

/**
 * The composed configuration, as one searchable string.
 * @param options - the throwaway home, its profile name, and the Harness install.
 * @returns stdout plus stderr, or `undefined` when no `dshRoot` was given.
 */
function composedText({ home, profile, dshRoot }) {
  if (dshRoot === undefined) return undefined
  const run = spawnSync(process.execPath, [
    join(dshRoot, 'lib', 'bin.js'), '--profile', profile, '--dump-config',
  ], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return `${run.stdout ?? ''}\n${run.stderr ?? ''}`
}

/**
 * Decide which rows this composition still needs.
 *
 * Reading the *composed* tree is the only reliable answer: the registry row may
 * come from a bundle layer (invisible in the profile patch) or from this script's
 * own earlier run. Without a `dshRoot` the script falls back to reading the patch
 * it may have written before.
 * @param options - the throwaway home, its profile, the Harness install, and the wanted ids.
 * @returns the rows to write.
 */
function missingRows({ home, profile, dshRoot, ids }) {
  const composed = composedText({ home, profile, dshRoot })
  const patch = join(home, 'profiles', profile, 'cordis.patch.yml')
  const text = existsSync(patch) ? readFileSync(patch, 'utf8') : ''
  const source = composed ?? text
  return {
    registry: !source.includes('@deepseek-ai/dsh-agent-preset-registry'),
    // A preset row is declared exactly once; matching the id line keeps a
    // definition's own `.toml` out of the comparison because only the composed
    // profile and this patch are searched.
    presets: ids.filter(id => !source.includes(`id: ${id}`)),
  }
}

/**
 * Append the missing Agent Preset rows to a profile patch.
 *
 * Idempotent by construction: a row that the composed tree already provides is
 * not written again, so running this twice, or against the web profile (whose
 * bundle already mounts the registry and its shipped presets), is safe.
 * @param options - the throwaway home, the profile inside it, the Harness
 * install, the project whose definitions name the presets, and a logger.
 * @returns whether this call wrote anything.
 */
export function ensurePresetProfile({ home, profile, dshRoot, project, log = console.log }) {
  const real = resolve(homedir(), '.dsh')
  const target = resolve(home)
  if (target === real) {
    throw new Error(`refusing to rewrite the live DSH home at ${target}; point E2E_HOME at a throwaway directory`)
  }
  const patch = join(home, 'profiles', profile, 'cordis.patch.yml')
  if (!existsSync(patch)) throw new Error(`no profile patch at ${patch}; create the profile first (see guide/technical.md §16)`)

  const wanted = projectPresetIds(project)
  const ids = wanted.length === 0 ? [E2E_PRESET_ID] : wanted
  const need = missingRows({ home, profile, dshRoot, ids })
  if (!need.registry && need.presets.length === 0) {
    log(`  SKIP  ${patch} already offers preset(s) ${ids.join(', ')} in a composition that mounts the registry`)
    return false
  }

  const rows = []
  if (need.registry) {
    rows.push(
      '    - id: agent-preset-registry',
      "      name: '@deepseek-ai/dsh-agent-preset-registry'",
      '      config:',
      `        default: ${ids[0]}`,
    )
  }
  // One row per preset id the project names: a definition selecting a preset
  // this profile does not declare fails at call time, so the sample project's
  // five roles each need their own declaration.
  for (const id of need.presets) {
    rows.push(
      `    - id: agent-preset-${id}`,
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      `        id: ${id}`,
      `        name: ${id}`,
      '        plugins:',
      '          - id: persona',
      "            name: '@deepseek-ai/dsh-persona'",
      '            config:',
      `              prefix: ${PRESET_MARKER} You are the e2e verification child for preset "${id}". Answer in one short line.`,
    )
  }

  const block = [
    '',
    MANAGED,
    '# Added by scripts/e2e-preset-profile.mjs so the delegation scenario can prove that',
    '# `agent_preset` reaches the child it composes.',
    '- insert:',
    ...rows,
    '',
  ]

  // The default patch is a flow-style empty sequence (`[]`), and appending a block
  // sequence after it makes the YAML invalid — replace it instead.
  const text = readFileSync(patch, 'utf8')
  const lines = text.split(/\r?\n/)
  const code = lines.filter(line => line.trim() !== '' && !line.trimStart().startsWith('#'))
  const next = code.length === 1 && code[0].trim() === '[]'
    ? [...lines.filter(line => line.trim() !== '[]'), ...block]
    : [...lines, ...block]
  writeFileSync(patch, next.join('\n'), 'utf8')
  const wrote = [need.registry ? 'registry' : '', ...need.presets.map(id => `preset "${id}"`)].filter(Boolean)
  log(`  WROTE ${patch} (${wrote.join(' + ')})`)
  return true
}
