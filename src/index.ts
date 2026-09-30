/**
 * dsh-agents-toml — declare named subagents in TOML files.
 *
 * User definitions live in `<DSH_HOME>/agents/*.toml`; project definitions live
 * in `<projectRoot>/.dsh/agents/*.toml` and load only when this row sets
 * `trustProjectAgents: true`. One tool with an `agent_type` parameter exposes
 * them to the model, and every definition delegates through the Harness
 * `ctx.subagents` providers that the profile already mounts.
 * @module dsh-agents-toml
 */
import Schema from '@deepseek-ai/schemastery'

import type { ContextLike } from './host.ts'
import { createPlugin } from './plugin.ts'

/** Plugin row name. */
export const name = 'dsh-agents-toml'

/** The services this plugin needs before it can serve delegation. */
export const inject = ['tools', 'subagents']

/**
 * A configuration field the Host samples at runtime: the Loader hands plugins a
 * stable reference rather than a copy, so a consumer reads it with `get()`.
 * Structural twin of the Harness `Volatile<T>` the schema builder produces.
 */
interface VolatileField<T> {
  /** @returns the current value, after schema defaults are resolved. */
  get(): T
}

/** Configuration accepted from `cordis.yml`. */
export interface Config {
  /** Allow `<projectRoot>/.dsh/agents/*.toml`, which arrives with a git clone. */
  trustProjectAgents: VolatileField<boolean>
  /** Model-facing tool name. */
  toolName: VolatileField<string>
  /** Transport used by definitions that name none. */
  defaultProvider: string
  /** Project-relative definition directory. */
  projectAgentsDir: string
  /** Re-install the tool when definition files change. */
  watchDefinitions: VolatileField<boolean>
  /** List unavailable definitions in the tool description. */
  reportFailuresToModel: VolatileField<boolean>
  /** Absolute override for the user definition directory. */
  userAgentsDir: VolatileField<string | undefined>
}

/**
 * Configuration schema; invalid values fail the load with an actionable error.
 *
 * The four fields the client settings card edits are `.volatile()`: the Host
 * serves a form only for volatile fields, the card addresses this profile entry
 * by id (`dsh-agents-toml`), and a write persists into the active profile's
 * Cordis patch, which reloads this row. The remaining fields stay patch-only
 * because they address deployment layout rather than a per-user preference.
 */
export const Config = Schema.object({
  trustProjectAgents: Schema.boolean().default(false).volatile(),
  toolName: Schema.string().default('subagent_custom').volatile(),
  defaultProvider: Schema.string().default('spawn'),
  projectAgentsDir: Schema.string().default('.dsh/agents'),
  watchDefinitions: Schema.boolean().default(true).volatile(),
  reportFailuresToModel: Schema.boolean().default(true).volatile(),
  userAgentsDir: Schema.string().volatile(),
})

/**
 * Mount the plugin.
 * @param ctx - the Harness context.
 * @param config - validated row configuration.
 */
export function apply(ctx: ContextLike, config: Config): void {
  createPlugin(ctx, {
    trustProjectAgents: () => config.trustProjectAgents.get(),
    toolName: () => config.toolName.get(),
    defaultProvider: config.defaultProvider,
    projectAgentsDir: config.projectAgentsDir,
    watchDefinitions: () => config.watchDefinitions.get(),
    reportFailuresToModel: () => config.reportFailuresToModel.get(),
    userAgentsDir: config.userAgentsDir.get(),
  })
}
