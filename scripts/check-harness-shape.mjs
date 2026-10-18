/**
 * Check the installed DeepSeek Harness for the declarations this plugin binds
 * to, so a rename or a removal shows up as one failing line instead of a
 * runtime surprise in a user's session.
 *
 * The plugin deliberately imports no `@deepseek-ai/dsh-*` package, so nothing
 * else in this repository compiles against the runtime. This is the check that
 * closes that gap: it reads the installed packages' emitted declarations and
 * proves each name the plugin depends on is still there.
 *
 * Usage:
 *   npm run check:harness                       # resolve @deepseek-ai/dsh, else beside node.exe
 *   DSH_SHAPE_ROOT=/path/to/node_modules npm run check:harness
 *
 * It is not part of `npm test`: the unit suite runs without a DSH installation
 * on purpose.
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/**
 * Locate the `@deepseek-ai` scope holding the installed packages.
 *
 * Three sources, in order: the explicit `DSH_SHAPE_ROOT` override, a `dsh`
 * package reachable from this checkout, and the node installation running this
 * script (a global install sits beside `node.exe`). Nothing found is reported
 * as its own failure: probing a nonexistent directory yields one drift per
 * declaration, which reads like the Harness changed rather than like the
 * Harness was never located.
 * @returns the scope to read, or `undefined` when the Harness is not installed.
 */
function resolveScope() {
  const override = process.env['DSH_SHAPE_ROOT']
  if (override !== undefined && override.length > 0) return override
  try {
    return dirname(require.resolve('@deepseek-ai/dsh/package.json'))
  } catch {
    // Not resolvable from here; fall through to the node installation.
  }
  const besideNode = join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh')
  return existsSync(besideNode) ? besideNode : undefined
}

const scope = resolveScope()

/** The `@deepseek-ai` scope directory the requirements are read from. */
function scopeDirOf(root) {
  const nested = join(root, 'node_modules', '@deepseek-ai')
  return existsSync(nested) ? nested : join(dirname(root), '@deepseek-ai')
}

if (scope === undefined) {
  console.error(
    'check:harness: no DeepSeek Harness installation found. Install it (`npm i -g @deepseek-ai/dsh`) '
    + 'or point DSH_SHAPE_ROOT at the @deepseek-ai/dsh package directory.',
  )
  process.exit(1)
}

const base = scopeDirOf(scope)

if (!existsSync(join(base, 'dsh-subagent'))) {
  console.error(
    `check:harness: ${base} holds no Harness packages. Point DSH_SHAPE_ROOT at the @deepseek-ai/dsh `
    + 'package directory (the one whose node_modules/@deepseek-ai holds the subpackages).',
  )
  process.exit(1)
}

/**
 * One declaration the plugin relies on.
 *
 * `optional` marks a client-side artifact that only a fuller installation
 * carries: a bare `@deepseek-ai/dsh` install ships the browser packages the Web
 * frontend bundles (they are platform modules), so their declarations may be
 * absent from disk. Absent is then reported as SKIP, while a present file that
 * lost the name is still drift.
 *
 * `contains` must be the longest literal that is still stable. A bare identifier
 * proves only that some name starts with it (`SettingsForm` also prefixes eight
 * sibling exports; `"name"` appears in every `package.json`), so a declaration
 * that can be renamed without the check noticing is worse than no check.
 * @typedef {{ file: string, contains: string, why: string, optional?: boolean }} Requirement
 */

/** @type {readonly Requirement[]} */
const REQUIREMENTS = [
  // dsh-subagent: the service definition the plugin calls.
  { file: 'dsh-subagent/lib/types/index.d.ts', contains: 'startActivation(spec: SubagentActivationSpec)', why: 'subagents.startActivation' },
  { file: 'dsh-subagent/lib/types/index.d.ts', contains: 'getProvider(name: string)', why: 'subagents.getProvider' },
  { file: 'dsh-subagent/lib/types/index.d.ts', contains: 'resolveMaxDepth(', why: 'the shared delegation-depth policy' },
  { file: 'dsh-subagent/lib/types/types.d.ts', contains: 'readonly delivery:', why: 'the activation delivery mode' },
  { file: 'dsh-subagent/lib/types/types.d.ts', contains: 'readonly agentPreset?', why: 'an independent Agent Preset on a start request' },
  { file: 'dsh-subagent/lib/types/types.d.ts', contains: 'readonly structured?:', why: 'a structured child result' },
  { file: 'dsh-subagent/lib/types/types.d.ts', contains: 'readonly agentPreset:', why: 'the agentPreset capability bit' },
  { file: 'dsh-subagent/lib/types/types.d.ts', contains: 'readonly depthLimit:', why: 'the depthLimit capability bit' },
  { file: 'dsh-subagent/lib/types/types.d.ts', contains: 'readonly inheritsParentContext:', why: 'the conversation-sharing descriptor' },
  { file: 'dsh-subagent/lib/types/types.d.ts', contains: 'prepareContinuable?', why: 'the continuable capability signal' },
  // dsh-agent-preset-registry: the roster an `agent_preset` value is checked against.
  { file: 'dsh-agent-preset-registry/lib/types/index.d.ts', contains: 'list()', why: 'agentPresets.list' },
  // cordis-plugin-loader: the only signal a volatile settings write reaches the
  // plugin through, because such a write does not remount the row.
  { file: 'cordis-plugin-loader/lib/index.js', contains: 'loader/volatile-update', why: 'the volatile settings-write event' },
  // dsh-skill: the registry the packaged authoring guide is published through.
  { file: 'dsh-skill/lib/types/index.d.ts', contains: 'registerProvider(', why: 'skills.registerProvider' },
  // dsh-api-remotes: the event the client half refreshes on.
  { file: 'dsh-api-remotes/lib/index.js', contains: 'plugin-manager/changed', why: 'the forwarded plugin-manager change event' },
  // dsh-api-gateway: how a Remote namespace becomes a service. Since 0.2.1 the
  // client bundle is split by platform, so the browser artifact is the one to read.
  { file: 'dsh-api-gateway/lib/client.browser.js', contains: '`remote.${namespace}`', why: 'the remote.<namespace> service key' },
  // dsh-plugin-manager: the inventory the warning reads.
  { file: 'dsh-plugin-manager/lib/types/index.d.ts', contains: 'listBundles()', why: 'pluginManager.listBundles' },
  { file: 'dsh-plugin-manager/lib/types/index.d.ts', contains: 'listPlugins()', why: 'pluginManager.listPlugins' },
  // The Agent Teams packages the client half detects. The full scoped name is the
  // declaration that matters: `"name"` alone appears in every package.json, so it
  // would stay green through exactly the rename this check exists to catch.
  { file: 'dsh-experimental-agent-team/package.json', contains: '"@deepseek-ai/dsh-experimental-agent-team"', why: 'the Agent Teams module name' },
  { file: 'dsh-experimental-tool-agent-team/package.json', contains: '"@deepseek-ai/dsh-experimental-tool-agent-team"', why: 'the Agent Teams tool module name' },
  // The client half: hand-declared in src/client/shell-modules.d.ts, so nothing
  // else in this repository would notice these names moving. These packages are
  // platform modules the Web frontend bundles, so a bare install may not carry
  // them on disk — hence `optional`: present means checked, absent means SKIP.
  // Each literal is the exported binding itself, not a bare word that another
  // export happens to contain: `SettingsForm` alone is a prefix of eight sibling
  // names, so it would stay green after the component was removed. The others
  // (`SettingsValueField`, `SettingsFormModel`, `settingsTextField`) are complete
  // names, and no `contains` can be satisfied by a shorter one.
  { file: 'dsh-client-ui-primitives/lib/types/index.d.ts', contains: 'export { SettingsForm }', why: 'the settings card component', optional: true },
  { file: 'dsh-client-ui-primitives/lib/types/index.d.ts', contains: 'SettingsValueField', why: 'the settings card field', optional: true },
  { file: 'dsh-client-ui-primitives/lib/types/index.d.ts', contains: 'SettingsFormModel', why: 'the settings form model', optional: true },
  { file: 'dsh-client-ui-primitives/lib/types/index.d.ts', contains: 'settingsTextField', why: 'the text-field spec', optional: true },
  { file: 'dsh-client-ui-primitives/lib/types/index.d.ts', contains: 'export { Switch }', why: 'the boolean switch', optional: true },
  { file: 'dsh-client-store/lib/types/index.d.ts', contains: 'createSnapshotStore', why: 'the card snapshot store', optional: true },
  { file: 'dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts', contains: 'plugins.bundle.config', why: 'the bundle config slot the card registers', optional: true },
  // The rest of the client half's contract, read off the packages the Host serves.
  { file: 'dsh-client-ui-settings/lib/types/client/config-form.d.ts', contains: 'whileServed', why: 'configForms.whileServed', optional: true },
  // dsh-plugin-manager, client-facing: the field the Agent Teams warning reads.
  { file: 'dsh-plugin-manager/lib/types/types.d.ts', contains: 'moduleName', why: 'the plugin inventory module name' },
]

const drifts = []
let skipped = 0
for (const requirement of REQUIREMENTS) {
  const path = join(base, requirement.file)
  if (!existsSync(path)) {
    if (requirement.optional === true) {
      skipped += 1
      console.log(`SKIP ${requirement.file} :: ${requirement.why} (not installed in this tree)`)
      continue
    }
    drifts.push(`${requirement.file}: file is missing (needed for ${requirement.why})`)
    continue
  }
  const text = readFileSync(path, 'utf8')
  if (!text.includes(requirement.contains)) {
    drifts.push(`${requirement.file}: no longer contains ${JSON.stringify(requirement.contains)} (needed for ${requirement.why})`)
    continue
  }
  console.log(`OK   ${requirement.file} :: ${requirement.why}`)
}

const summary = `${REQUIREMENTS.length - skipped} declaration(s) match the installed Harness at ${base}`
  + (skipped === 0 ? '' : `; ${skipped} client-side declaration(s) skipped as not installed`)
if (drifts.length > 0) {
  console.error(`\ncheck:harness: ${drifts.length} drift(s) against the installed Harness at ${base}`)
  for (const drift of drifts) console.error(`  DRIFT ${drift}`)
  console.error('\nUpdate src/host.ts, src/harness.ts, and the client half for the new declarations, then rerun.')
  process.exitCode = 1
} else {
  console.log(`\ncheck:harness: ${summary}`)
}
