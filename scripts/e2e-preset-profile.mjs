// Give a throwaway profile the pieces `agent_preset` needs.
//
// Since 0.2.1 a child's persona and tool set come from an Agent Preset, and the
// preset registry is not in every composition: the web bundle mounts it (with the
// four shipped presets), the packaged headless bundle does not. The delegation
// scenario has to prove the preset actually reached the child, so it needs a
// profile that offers an example preset this script can recognise in the child
// log — hence the marker persona below.
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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { PRESET_MARKER } from './e2e-headless.mjs'

/** Id of the example preset this script declares, and what a definition must name. */
export const E2E_PRESET_ID = 'e2e-preset'

/** Marker comment, so a re-run can tell "already set up" from "patch written by hand". */
const MANAGED = '# ── dsh-agents-toml e2e: agent-presets for the delegation scenario ──'

/**
 * The rows this composition still needs.
 *
 * Reading the *composed* tree is the only reliable answer: the registry row may
 * come from a bundle layer (invisible in the profile patch) or from this script's
 * own earlier run. Without a `dshRoot` the script falls back to its own marker.
 * @param options - the throwaway home, its profile, and the Harness install.
 * @returns which rows to write.
 */
function missingRows({ home, profile, dshRoot }) {
  if (dshRoot === undefined) return { registry: true, preset: true }
  const run = spawnSync(process.execPath, [
    join(dshRoot, 'lib', 'bin.js'), '--profile', profile, '--dump-config',
  ], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const composed = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
  return {
    registry: !composed.includes('@deepseek-ai/dsh-agent-preset-registry'),
    preset: !composed.includes(`id: ${E2E_PRESET_ID}`),
  }
}

/**
 * Append the missing Agent Preset rows to a profile patch.
 *
 * Idempotent by construction: a row that the composed tree already provides is
 * not written again, so running this twice, or against the web profile (whose
 * bundle already mounts the registry), is safe.
 * @param options - the throwaway home, the profile inside it, the Harness install, and a logger.
 * @returns whether this call wrote anything.
 */
export function ensurePresetProfile({ home, profile, dshRoot, log = console.log }) {
  const real = resolve(homedir(), '.dsh')
  const target = resolve(home)
  if (target === real) {
    throw new Error(`refusing to rewrite the live DSH home at ${target}; point E2E_HOME at a throwaway directory`)
  }
  const patch = join(home, 'profiles', profile, 'cordis.patch.yml')
  if (!existsSync(patch)) throw new Error(`no profile patch at ${patch}; create the profile first (see guide/technical.md §16)`)

  const text = readFileSync(patch, 'utf8')
  const need = text.includes(MANAGED) ? { registry: false, preset: false } : missingRows({ home, profile, dshRoot })
  if (!need.registry && !need.preset) {
    log(`  SKIP  ${patch} already offers preset "${E2E_PRESET_ID}" in a composition that mounts the registry`)
    return false
  }

  const rows = []
  if (need.registry) {
    rows.push(
      '    - id: agent-preset-registry',
      "      name: '@deepseek-ai/dsh-agent-preset-registry'",
      '      config:',
      `        default: ${E2E_PRESET_ID}`,
    )
  }
  if (need.preset) {
    rows.push(
      '    - id: agent-preset-e2e',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      `        id: ${E2E_PRESET_ID}`,
      '        name: E2E preset',
      '        plugins:',
      '          - id: persona',
      "            name: '@deepseek-ai/dsh-persona'",
      '            config:',
      `              prefix: ${PRESET_MARKER} You are the e2e verification child. Answer in one short line.`,
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
  const lines = text.split(/\r?\n/)
  const code = lines.filter(line => line.trim() !== '' && !line.trimStart().startsWith('#'))
  const next = code.length === 1 && code[0].trim() === '[]'
    ? [...lines.filter(line => line.trim() !== '[]'), ...block]
    : [...lines, ...block]
  writeFileSync(patch, next.join('\n'), 'utf8')
  log(`  WROTE ${patch} (${[need.registry ? 'registry' : '', need.preset ? `preset "${E2E_PRESET_ID}"` : ''].filter(Boolean).join(' + ')})`)
  return true
}
