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
 *   npm run check:harness                       # resolve @deepseek-ai/dsh
 *   DSH_SHAPE_ROOT=/path/to/node_modules npm run check:harness
 *
 * It is not part of `npm test`: the unit suite runs without a DSH installation
 * on purpose.
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/** Locate the `@deepseek-ai` scope holding the installed packages. */
function resolveScope() {
  const override = process.env['DSH_SHAPE_ROOT']
  if (override !== undefined && override.length > 0) return override
  try {
    return dirname(require.resolve('@deepseek-ai/dsh/package.json'))
  } catch {
    // Not installed next to this checkout: fall back to the sibling scope a
    // global install creates, then report the miss through the first entry.
    return join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh')
  }
}

const scope = resolveScope()
const base = existsSync(join(scope, 'node_modules', '@deepseek-ai'))
  ? join(scope, 'node_modules', '@deepseek-ai')
  : join(dirname(scope), '@deepseek-ai')

/**
 * One declaration the plugin relies on.
 * @typedef {{ file: string, contains: string, why: string }} Requirement
 */

/** @type {readonly Requirement[]} */
const REQUIREMENTS = [
  // dsh-subagent: the service definition the plugin calls.
  { file: 'dsh-subagent/lib/types/index.d.ts', contains: 'start(name: string, request: SubagentStartRequest)', why: 'subagents.start' },
  { file: 'dsh-subagent/lib/types/index.d.ts', contains: 'startContinuable(spec: ContinuableStartSpec)', why: 'subagents.startContinuable' },
  { file: 'dsh-subagent/lib/types/index.d.ts', contains: 'getProvider(name: string)', why: 'subagents.getProvider' },
  { file: 'dsh-subagent/lib/types/index.d.ts', contains: 'resolveMaxDepth(', why: 'the shared delegation-depth policy' },
  { file: 'dsh-subagent/lib/types/types.d.ts', contains: 'readonly structured?:', why: 'a structured child result' },
  { file: 'dsh-subagent/lib/types/types.d.ts', contains: 'readonly depthLimit:', why: 'the depthLimit capability bit' },
  { file: 'dsh-subagent/lib/types/types.d.ts', contains: 'readonly inheritsParentContext:', why: 'the conversation-sharing descriptor' },
  { file: 'dsh-subagent/lib/types/types.d.ts', contains: 'prepareContinuable?', why: 'the continuable capability signal' },
  // dsh-skill: the registry the packaged authoring guide is published through.
  { file: 'dsh-skill/lib/types/index.d.ts', contains: 'registerProvider(', why: 'skills.registerProvider' },
  // dsh-api-remotes: the event the client half refreshes on.
  { file: 'dsh-api-remotes/lib/index.js', contains: 'plugin-manager/changed', why: 'the forwarded plugin-manager change event' },
  // dsh-api-gateway: how a Remote namespace becomes a service.
  { file: 'dsh-api-gateway/lib/client.js', contains: '`remote.${namespace}`', why: 'the remote.<namespace> service key' },
  // dsh-plugin-manager: the inventory the warning reads.
  { file: 'dsh-plugin-manager/lib/types/index.d.ts', contains: 'listBundles()', why: 'pluginManager.listBundles' },
  { file: 'dsh-plugin-manager/lib/types/index.d.ts', contains: 'listPlugins()', why: 'pluginManager.listPlugins' },
  // The Agent Teams packages the client half detects.
  { file: 'dsh-experimental-agent-team/package.json', contains: '"name"', why: 'the Agent Teams module name' },
  { file: 'dsh-experimental-tool-agent-team/package.json', contains: '"name"', why: 'the Agent Teams tool module name' },
]

const drifts = []
for (const requirement of REQUIREMENTS) {
  const path = join(base, requirement.file)
  if (!existsSync(path)) {
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

if (drifts.length > 0) {
  console.error(`\ncheck:harness: ${drifts.length} drift(s) against the installed Harness at ${base}`)
  for (const drift of drifts) console.error(`  DRIFT ${drift}`)
  console.error('\nUpdate src/host.ts, src/harness.ts, and the client half for the new declarations, then rerun.')
  process.exitCode = 1
} else {
  console.log(`\ncheck:harness: ${REQUIREMENTS.length} declarations match the installed Harness at ${base}`)
}
