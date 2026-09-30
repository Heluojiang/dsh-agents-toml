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

/** Configuration accepted from `cordis.yml`. */
export interface Config {
  /** Allow `<projectRoot>/.dsh/agents/*.toml`, which arrives with a git clone. */
  trustProjectAgents: boolean
  /** Model-facing tool name. */
  toolName: string
  /** Transport used by definitions that name none. */
  defaultProvider: string
  /** Project-relative definition directory. */
  projectAgentsDir: string
  /** Re-install the tool when definition files change. */
  watchDefinitions: boolean
  /** List unavailable definitions in the tool description. */
  reportFailuresToModel: boolean
  /** Absolute override for the user definition directory. */
  userAgentsDir?: string
}

/** Configuration schema; invalid values fail the load with an actionable error. */
export const Config: Schema<Config> = Schema.object({
  trustProjectAgents: Schema.boolean().default(false),
  toolName: Schema.string().default('subagent_custom'),
  defaultProvider: Schema.string().default('spawn'),
  projectAgentsDir: Schema.string().default('.dsh/agents'),
  watchDefinitions: Schema.boolean().default(true),
  reportFailuresToModel: Schema.boolean().default(true),
  userAgentsDir: Schema.string(),
})

/**
 * Mount the plugin.
 * @param ctx - the Harness context.
 * @param config - validated row configuration.
 */
export function apply(ctx: ContextLike, config: Config): void {
  createPlugin(ctx, {
    trustProjectAgents: config.trustProjectAgents,
    toolName: config.toolName,
    defaultProvider: config.defaultProvider,
    projectAgentsDir: config.projectAgentsDir,
    watchDefinitions: config.watchDefinitions,
    reportFailuresToModel: config.reportFailuresToModel,
    userAgentsDir: config.userAgentsDir,
  })
}
