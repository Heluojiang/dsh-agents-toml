/**
 * The one adapter between this plugin and the Harness.
 *
 * Every other module talks to the Harness through the declarations in
 * `./host.ts`, which import no `@deepseek-ai/dsh-*` package so the plugin stays
 * loadable across releases whose published types lag the runtime. This module is
 * the single place that probes for the parts a composition may omit, so a
 * renamed or removed service has one adapter to change and a missing one is
 * reported as an explicit degradation instead of disabling a feature silently.
 * @module dsh-agents-toml/harness
 */
import type {
  AgentLike,
  AgentRegistryLike,
  ContextLike,
  FiberLike,
  LoggerLike,
  SkillProviderLike,
  SubagentService,
} from './host.ts'

/** The services a delegation tool registration needs, in one place. */
export const DELEGATION_SERVICES: readonly string[] = ['tools', 'subagents']

/** What the plugin asks of the Harness, with the optional parts resolved once. */
export interface Harness {
  /** @returns every Agent the composition currently holds. */
  agents(): readonly AgentLike[]
  /**
   * @returns the Host's configured delegation depth, or `undefined` when this
   * runtime exposes no such policy.
   */
  hostDepth(): number | undefined
  /**
   * Register a tool in one Agent's scope. Registration goes through the Agent's
   * own context, so every Agent gets its own scope while sharing this row.
   * @param agent - the Agent whose scope receives the registration.
   * @param build - receives the scope carrying `tools` and `subagents`.
   * @returns the registration's fiber, which owns the tool until disposed.
   */
  registerToolIn(agent: AgentLike, build: (scoped: ContextLike) => void): FiberLike
  /**
   * Contribute a skill provider when the composition serves a skill registry.
   * The wait runs in a child fiber of its own, so a composition without the
   * registry still gets delegation.
   * @param create - the provider factory.
   * @returns the registry's disposer, or `undefined` without a skill registry.
   */
  registerSkillProvider(create: () => SkillProviderLike): (() => void) | undefined
}

/**
 * Read the Agent registry off a context, when the composition exposes one.
 * @param ctx - the plugin context.
 * @returns the registry, or `undefined` on a context without one.
 */
function readAgentRegistry(ctx: ContextLike): AgentRegistryLike | undefined {
  const registry = ctx.get('agents')
  if (typeof registry !== 'object' || registry === null) return undefined
  const candidate = registry as { list?: unknown }
  return typeof candidate.list === 'function' ? registry as AgentRegistryLike : undefined
}

/**
 * Read the shared delegation-depth policy, when this runtime has one.
 * @param subagents - the subagent service.
 * @returns a reader for the Host's configured depth, or `undefined` without one.
 */
function readDepthPolicy(subagents: SubagentService): (() => number | undefined) | undefined {
  const resolve = subagents.resolveMaxDepth
  return typeof resolve === 'function' ? () => resolve.call(subagents, undefined) : undefined
}

/**
 * Build the adapter for one plugin context.
 *
 * A missing capability is announced once, at load, together with what stops
 * working — never at the moment a user needed it.
 * @param ctx - the plugin context.
 * @param logger - the logger degradation is reported through.
 * @returns the resolved Harness surface.
 */
export function createHarness(ctx: ContextLike, logger: LoggerLike): Harness {
  const registry = readAgentRegistry(ctx)
  const depth = readDepthPolicy(ctx.subagents)

  if (registry === undefined) {
    logger.info(
      'dsh-agents-toml: this composition exposes no Agent registry; definitions are installed only for '
      + 'Agents created while this row is active',
    )
  }
  if (depth === undefined) {
    logger.warn(
      'dsh-agents-toml: this runtime exposes no shared delegation-depth policy; a definition that omits '
      + '`max_depth` runs without a depth cap, and a definition that sets one is unavailable',
    )
  }

  const registerSkillProvider = (create: () => SkillProviderLike): (() => void) | undefined => {
    let dispose: (() => void) | undefined
    ctx.inject(['skills'], scoped => {
      const skills = scoped.skills
      if (skills === undefined) return
      dispose = skills.registerProvider(() => create())
    })
    return dispose
  }

  return {
    agents: () => registry?.list() ?? [],
    hostDepth: () => depth?.(),
    registerToolIn: (agent, build) => agent.ctx.inject([...DELEGATION_SERVICES], scoped => { build(scoped) }),
    registerSkillProvider,
  }
}
