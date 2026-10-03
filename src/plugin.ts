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
import { createHarness, type Harness } from './harness.ts'
import type { AgentLike, ContextLike } from './host.ts'
import { Installations, type InstallationOutcome } from './installation.ts'
import { buildDelegationTool } from './tool.ts'

/**
 * Resolved plugin configuration.
 *
 * The four `.volatile()` settings are accessors rather than values: the Host
 * keeps one stable reference per field and updates it in place when a settings
 * form writes, so a captured value would stay stale for the life of the row.
 */
export interface PluginConfig {
  /** Whether `<projectRoot>/.dsh/agents` may contribute definitions; read per discovery. */
  readonly trustProjectAgents: () => boolean
  /** Model-facing tool name; read at each tool install. */
  readonly toolName: () => string
  /** Transport used by definitions that name none. */
  readonly defaultProvider: string
  /** Project-relative definition directory. */
  readonly projectAgentsDir: string
  /** Whether definition directories are watched; read whenever a watch is opened. */
  readonly watchDefinitions: () => boolean
  /** Whether unavailable definitions are listed in the tool description; read at each install. */
  readonly reportFailuresToModel: () => boolean
  /** Absolute override for the user definition directory. */
  readonly userAgentsDir?: string | undefined
}

/** Test seams. */
export interface PluginDependencies {
  readonly io?: DiscoveryIo
  /**
   * Opens one directory watch.
   * @param dir - absolute directory to observe.
   * @param onChange - called after a change.
   * @returns the close function, or `undefined` when the directory cannot be watched yet.
   */
  readonly watchDirectory?: (dir: string, onChange: () => void) => (() => void) | undefined
  readonly debounceMs?: number
  /** Harness home override; tests must set it instead of the ambient environment. */
  readonly homeDir?: string
}

/** Expand the tilde prefixes the Harness home resolution accepts. */
function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Resolve `$DSH_HOME` the way the Harness does: a configured home wins over the
 * environment, a blank environment value counts as unset, tilde prefixes expand
 * against the OS home, and the result is absolute.
 * @returns the absolute Harness home.
 */
export function resolveHomeDir(): string {
  const configured = process.env['DSH_HOME']
  const base = configured !== undefined && configured.trim().length > 0
    ? expandHome(configured)
    : join(homedir(), '.dsh')
  return resolve(base)
}

/**
 * Open one directory watch.
 * @param dir - absolute directory to observe.
 * @param onChange - called after a change.
 * @returns the close function, or `undefined` while the directory does not exist.
 */
function defaultWatchDirectory(dir: string, onChange: () => void): (() => void) | undefined {
  try {
    const watcher = watchFs(dir, { persistent: false }, () => { onChange() })
    watcher.on('error', () => {})
    return () => { watcher.close() }
  } catch {
    // A missing directory reports ENOENT: nothing is watched, and the caller
    // retries on the next install instead of caching a watcher that is not one.
    return undefined
  }
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
  const harness: Harness = createHarness(ctx, ctx.logger)

  const installations = new Installations({
    installFailed: (agent, error) => {
      ctx.logger.warn(
        `dsh-agents-toml: could not install definitions for ${describe(agent)}: ${String(error)}`,
      )
    },
    disposeFailed: (agent, error) => {
      ctx.logger.warn(`dsh-agents-toml: failed to remove definitions for ${describe(agent)}: ${String(error)}`)
    },
  })

  /** Live directory watches, and the directories that could not be watched yet. */
  const watchers = new Map<string, () => void>()
  const unwatchable = new Set<string>()
  const reportedFailures = new Set<string>()
  const reportedUntrusted = new Set<string>()
  const reportedDepthless = new Set<string>()
  let debounce: NodeJS.Timeout | undefined

  function describe(agent: AgentLike): string {
    return agent.session.header.cwd ?? '(no working directory)'
  }

  const load = (agent: AgentLike | undefined): Promise<DiscoveryResult> => discoverAgents({
    cwd: agent?.session.header.cwd,
    homeDir,
    projectAgentsDir: config.projectAgentsDir,
    trustProjectAgents: config.trustProjectAgents(),
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
    if (!config.trustProjectAgents() && discovery.projectRoot !== undefined) {
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

  /**
   * Close one watch and forget it.
   * @param directory - the watched directory.
   */
  function closeWatch(directory: string): void {
    const close = watchers.get(directory)
    if (close === undefined) return
    watchers.delete(directory)
    close()
  }

  /**
   * Make the open watches match what the live installations need.
   *
   * A directory no longer needed is closed here rather than at the next Agent
   * creation, which is what makes turning `watchDefinitions` off take effect.
   */
  function syncWatchers(): void {
    if (!config.watchDefinitions()) {
      for (const directory of [...watchers.keys()]) closeWatch(directory)
      return
    }
    const wanted = new Set(installations.watchedDirs())
    for (const directory of [...watchers.keys()]) if (!wanted.has(directory)) closeWatch(directory)
    for (const directory of wanted) {
      if (watchers.has(directory)) continue
      const close = openWatch(directory, scheduleReinstall)
      if (close === undefined) {
        if (!unwatchable.has(directory)) {
          unwatchable.add(directory)
          ctx.logger.warn(
            `dsh-agents-toml: cannot watch ${directory} yet; the agent_type list refreshes on the next install`,
          )
        }
        continue
      }
      unwatchable.delete(directory)
      watchers.set(directory, close)
    }
  }

  /**
   * React to a settings write reaching this row.
   *
   * A write that changes only volatile fields does not restart the row: the
   * Loader commits the new value into the reference this plugin reads and
   * announces the change, so this event is the only chance to act on a setting
   * before the next install. The reconciliation is derived from the config
   * accessor — already updated — instead of from the announced paths, so a
   * runtime that reports them differently still gets the same result; a write
   * that changes an ordinary field remounts the row instead and arrives here
   * through the effect's cleanup.
   */
  function settingsChanged(): void {
    syncWatchers()
  }

  /** Report each provider that cannot enforce a depth cap, once per process. */
  const reportDepthless = (provider: string): void => {
    if (reportedDepthless.has(provider)) return
    reportedDepthless.add(provider)
    ctx.logger.warn(
      `dsh-agents-toml: the subagent provider "${provider}" cannot enforce a depth cap; delegations through it `
      + 'run without one. Set `max_depth` on a definition to require a cap.',
    )
  }

  const installFor = async (agent: AgentLike): Promise<InstallationOutcome> => {
    const discovery = await load(agent)
    reportFailures(discovery)
    const available = discovery.definitions.filter(definition => definition.enabled)
    if (available.length === 0) return { watchedDirs: discovery.watchedDirs }
    const inheriting = new Set<string>()
    for (const definition of available) {
      const provider = ctx.subagents.getProvider(definition.provider ?? config.defaultProvider)
      // A provider that is not registered yet is reported at call time; until
      // then its definitions are described as non-inheriting.
      if (provider === undefined) continue
      if (provider.inheritsParentContext) inheriting.add(definition.name)
      if (!provider.capabilities.depthLimit && definition.maxDepth === undefined) {
        reportDepthless(provider.name)
      }
    }
    const fiber = harness.registerToolIn(agent, scoped => {
      scoped.tools.register(buildDelegationTool({
        toolName: config.toolName(),
        defaultProvider: config.defaultProvider,
        reportFailuresToModel: config.reportFailuresToModel(),
        subagents: scoped.subagents,
        hostDepth: () => harness.hostDepth(),
        load: (caller: AgentLike) => load(caller),
        installedNames: available.map(definition => definition.name),
        installedContinuable: available
          .filter(definition => definition.mode === 'continuable')
          .map(definition => definition.name),
        installedInheriting: [...inheriting],
        installedFailures: discovery.failures,
      }))
    })
    ctx.logger.info(
      `dsh-agents-toml: installed ${available.length} subagent definition(s) for `
      + `${describe(agent)} as "${config.toolName()}"`,
    )
    return { fiber, watchedDirs: discovery.watchedDirs }
  }

  const install = async (agent: AgentLike): Promise<void> => {
    await installations.sync(agent, () => installFor(agent))
    syncWatchers()
  }

  const remove = async (agent: AgentLike): Promise<void> => {
    await installations.forget(agent)
    syncWatchers()
  }

  const reinstallAll = async (): Promise<void> => {
    for (const agent of [...installations.agents()]) await install(agent)
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
    await install(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    void remove(agent)
  })
  ctx.on('loader/volatile-update', settingsChanged)

  // Catch Agents that already exist: a one-shot runner creates its Agent while
  // it activates, which can precede this row's activation.
  for (const agent of harness.agents()) void install(agent)

  ctx.effect(() => () => {
    for (const directory of [...watchers.keys()]) closeWatch(directory)
    unwatchable.clear()
    if (debounce !== undefined) clearTimeout(debounce)
    void installations.dispose()
  })

  // Surface user-directory problems at load, before any Agent exists.
  void load(undefined).then(reportFailures, (error: unknown) => {
    ctx.logger.warn(`dsh-agents-toml: could not read user definitions: ${String(error)}`)
  })
}
