/**
 * Plugin orchestration: resolve definitions per Agent and install the tool
 * into that Agent's own scope.
 *
 * Definitions are re-read on every delegation, so editing a TOML file takes
 * effect on the next call with no restart. A directory watcher re-installs the
 * tool when files change so the schema's `agent_type` values stay current for
 * Agents that are already running. Nothing here may reject Agent creation: a
 * broken definition is reported and skipped, never fatal.
 * @module dsh-agents-toml/plugin
 */
import { watch as watchFs } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { discoverAgents, nodeDiscoveryIo, type DiscoveryIo, type DiscoveryResult } from './discovery.ts'
import type { AgentLike, AgentRegistryLike, ContextLike, FiberLike } from './host.ts'
import { buildDelegationTool } from './tool.ts'

/** Resolved plugin configuration. */
export interface PluginConfig {
  /** Whether `<projectRoot>/.dsh/agents` may contribute definitions. */
  readonly trustProjectAgents: boolean
  /** Model-facing tool name. */
  readonly toolName: string
  /** Transport used by definitions that name none. */
  readonly defaultProvider: string
  /** Project-relative definition directory. */
  readonly projectAgentsDir: string
  /** Whether definition directories are watched for live schema updates. */
  readonly watchDefinitions: boolean
  /** Whether unavailable definitions are listed in the tool description. */
  readonly reportFailuresToModel: boolean
  /** Absolute override for the user definition directory. */
  readonly userAgentsDir?: string | undefined
}

/** Test seams. */
export interface PluginDependencies {
  readonly io?: DiscoveryIo
  /** Opens one directory watch; returns its close function. */
  readonly watchDirectory?: (dir: string, onChange: () => void) => () => void
  readonly debounceMs?: number
  /** Harness home override; tests must set it instead of the ambient environment. */
  readonly homeDir?: string
}

/** Resolve `$DSH_HOME`, mirroring the Harness default for an unset or blank value. */
function resolveHomeDir(): string {
  const configured = process.env['DSH_HOME']?.trim()
  return configured === undefined || configured.length === 0 ? join(homedir(), '.dsh') : configured
}

function defaultWatchDirectory(dir: string, onChange: () => void): () => void {
  try {
    const watcher = watchFs(dir, { persistent: false }, () => { onChange() })
    watcher.on('error', () => {})
    return () => { watcher.close() }
  } catch {
    // A missing directory is not an error: the next install opens its watch.
    return () => {}
  }
}

/**
 * Read the Agent registry, when the composition exposes it.
 *
 * A one-shot runner creates its Agent while it activates, so this plugin — whose
 * row may be mounted later — would otherwise miss that Agent's `agent/created`.
 * @param ctx - the plugin context.
 * @returns the registry, or `undefined` on a context without one.
 */
function readAgentRegistry(ctx: ContextLike): AgentRegistryLike | undefined {
  const registry = ctx.get?.('agents')
  if (typeof registry !== 'object' || registry === null) return undefined
  const candidate = registry as { list?: unknown }
  return typeof candidate.list === 'function' ? registry as AgentRegistryLike : undefined
}

/**
 * Install the delegation tool for every Agent that has definitions.
 * @param ctx - the plugin context.
 * @param config - resolved configuration.
 * @param deps - optional filesystem, watcher, and timing seams.
 */
export function createPlugin(ctx: ContextLike, config: PluginConfig, deps: PluginDependencies = {}): void {
  const io = deps.io ?? nodeDiscoveryIo
  const openWatch = deps.watchDirectory ?? defaultWatchDirectory
  const homeDir = deps.homeDir ?? resolveHomeDir()

  /** Every Agent this plugin has seen, whether or not it got a tool. */
  const agents = new Set<AgentLike>()
  /** Live tool installation per Agent. */
  const installs = new Map<AgentLike, FiberLike>()
  const watchers = new Map<string, () => void>()
  const reportedFailures = new Set<string>()
  const reportedUntrusted = new Set<string>()
  let debounce: NodeJS.Timeout | undefined

  const load = (agent: AgentLike | undefined): Promise<DiscoveryResult> => discoverAgents({
    cwd: agent?.session.header.cwd,
    homeDir,
    projectAgentsDir: config.projectAgentsDir,
    trustProjectAgents: config.trustProjectAgents,
    userAgentsDir: config.userAgentsDir,
    io,
  })

  const reportFailures = (discovery: DiscoveryResult): void => {
    for (const failure of discovery.failures) {
      const key = `${failure.file}|${failure.reason}`
      if (reportedFailures.has(key)) continue
      reportedFailures.add(key)
      ctx.logger.warn(`dsh-agents-toml: ${failure.file}: ${failure.reason}`)
    }
    if (!config.trustProjectAgents && discovery.projectRoot !== undefined) {
      const directory = resolve(discovery.projectRoot, config.projectAgentsDir)
      if (!reportedUntrusted.has(directory)) {
        reportedUntrusted.add(directory)
        ctx.logger.info(
          `dsh-agents-toml: ignoring project definitions in ${directory}; `
          + 'set `trustProjectAgents: true` on this plugin row to enable them',
        )
      }
    }
  }

  const ensureWatchers = (directories: readonly string[]): void => {
    if (!config.watchDefinitions) return
    for (const directory of directories) {
      if (watchers.has(directory)) continue
      watchers.set(directory, openWatch(directory, scheduleReinstall))
    }
  }

  const removeFor = async (agent: AgentLike): Promise<void> => {
    const fiber = installs.get(agent)
    if (fiber === undefined) return
    installs.delete(agent)
    try {
      await fiber.dispose()
    } catch (error) {
      ctx.logger.warn(`dsh-agents-toml: failed to remove definitions for one agent: ${String(error)}`)
    }
  }

  const installFor = async (agent: AgentLike): Promise<void> => {
    const discovery = await load(agent)
    reportFailures(discovery)
    ensureWatchers(discovery.watchedDirs)
    const available = discovery.definitions.filter(definition => definition.enabled)
    if (available.length === 0) return
    const fiber = agent.ctx.inject(['tools', 'subagents'], (scoped) => {
      scoped.tools.register(buildDelegationTool({
        toolName: config.toolName,
        defaultProvider: config.defaultProvider,
        reportFailuresToModel: config.reportFailuresToModel,
        subagents: scoped.subagents,
        load,
        installedNames: available.map(definition => definition.name),
        installedFailures: discovery.failures,
      }))
    })
    installs.set(agent, fiber)
    ctx.logger.info(
      `dsh-agents-toml: installed ${available.length} subagent definition(s) for `
      + `${agent.session.header.cwd ?? '(no working directory)'} as "${config.toolName}"`,
    )
  }

  const installForSafe = async (agent: AgentLike): Promise<void> => {
    await removeFor(agent)
    try {
      await installFor(agent)
    } catch (error) {
      // A definition problem must never reject Agent creation.
      ctx.logger.warn(`dsh-agents-toml: could not install definitions for one agent: ${String(error)}`)
    }
  }

  const reinstallAll = async (): Promise<void> => {
    for (const agent of [...agents]) await installForSafe(agent)
  }

  function scheduleReinstall(): void {
    if (debounce !== undefined) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = undefined
      void reinstallAll()
    }, deps.debounceMs ?? 200)
    debounce.unref?.()
  }

  ctx.on('agent/created', async ({ agent }) => {
    agents.add(agent)
    await installForSafe(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    agents.delete(agent)
    void removeFor(agent)
  })

  // Catch Agents that already exist: a one-shot runner creates its Agent while
  // it activates, which can precede this row's activation.
  const registry = readAgentRegistry(ctx)
  if (registry !== undefined) {
    for (const agent of registry.list()) {
      agents.add(agent)
      void installForSafe(agent)
    }
  }

  ctx.effect?.(() => () => {
    for (const close of watchers.values()) close()
    watchers.clear()
    for (const fiber of installs.values()) void fiber.dispose()
    installs.clear()
    agents.clear()
    if (debounce !== undefined) clearTimeout(debounce)
  })

  // Surface user-directory problems at load, before any Agent exists.
  void load(undefined).then(reportFailures, (error: unknown) => {
    ctx.logger.warn(`dsh-agents-toml: could not read user definitions: ${String(error)}`)
  })
}
