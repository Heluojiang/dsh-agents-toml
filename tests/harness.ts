/**
 * Test doubles for the Harness surface the plugin consumes. Nothing here
 * imports a Harness package, so the suite runs without a DSH installation and
 * never touches a real `$DSH_HOME`.
 * @module dsh-agents-toml/tests/harness
 */
import { basename, dirname, resolve } from 'node:path'

import type { DiscoveryIo } from '../src/discovery.ts'
import type {
  AgentLike,
  ContextLike,
  SkillProviderLike,
  SkillRegistryLike,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentService,
  SubagentStartRequest,
  ToolDefinition,
} from '../src/host.ts'

/** Every start-time feature supported. */
export const FULL_CAPABILITIES: SubagentCapabilities = {
  agentOptions: true,
  outputSchema: true,
  depthLimit: true,
  toolFilter: true,
  persona: true,
}

/** Out-of-process transport: no start-time features at all. */
export const NO_CAPABILITIES: SubagentCapabilities = {
  agentOptions: false,
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
}

/** One provider to register on the fake service. */
export interface FakeProviderInit {
  readonly name: string
  readonly capabilities?: SubagentCapabilities
  readonly inheritsParentContext?: boolean
  readonly continuable?: boolean
}

/** One observed one-shot run. */
export interface StartedRun {
  readonly name: string
  readonly request: SubagentStartRequest
  disposed: boolean
}

/** Fake `ctx.subagents`. */
export interface FakeSubagents {
  readonly service: SubagentService
  readonly started: StartedRun[]
  readonly continuable: {
    readonly provider: string
    readonly label: string
    readonly request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>
    readonly signal: AbortSignal
  }[]
  /**
   * Read the service's shared depth policy the way the plugin's harness adapter
   * does, so a test can drop `resolveMaxDepth` and observe the older-runtime path.
   * @returns the configured depth, or `undefined` without a policy.
   */
  hostDepth(): number | undefined
}

/**
 * Build a fake subagent registry.
 * @param providers - providers to register.
 * @param options - terminal result for one-shot runs and the host depth setting.
 * @returns the service plus the runs it observed.
 */
export function createFakeSubagents(
  providers: readonly FakeProviderInit[],
  options: { readonly result?: SubagentResult; readonly depth?: number } = {},
): FakeSubagents {
  const started: StartedRun[] = []
  const continuable: FakeSubagents['continuable'][number][] = []
  const registry = new Map<string, SubagentProvider>()
  for (const init of providers) {
    registry.set(init.name, {
      name: init.name,
      capabilities: init.capabilities ?? FULL_CAPABILITIES,
      inheritsParentContext: init.inheritsParentContext ?? false,
      ...init.continuable === true ? { prepareContinuable: () => Promise.resolve({}) } : {},
    })
  }
  const result: SubagentResult = options.result ?? { output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }
  const service: SubagentService = {
    getProvider: name => registry.get(name),
    list: () => [...registry.keys()],
    start(name, request) {
      const entry: StartedRun = { name, request, disposed: false }
      started.push(entry)
      return Promise.resolve({
        id: `run-${started.length}`,
        result: Promise.resolve(result),
        dispose: () => {
          entry.disposed = true
          return Promise.resolve()
        },
      })
    },
    startContinuable(spec) {
      continuable.push(spec)
      return Promise.resolve({ childId: `child-${continuable.length}`, messageId: 'message-1' })
    },
    resolveMaxDepth: () => options.depth ?? 1,
  }
  return {
    service,
    started,
    continuable,
    hostDepth: () => (typeof service.resolveMaxDepth === 'function' ? service.resolveMaxDepth(undefined) : undefined),
  }
}

/** One tool registration observed on the fake context. */
export interface RegisteredTool {
  readonly definition: ToolDefinition
  disposed: boolean
}

/** Fake Cordis context. */
export interface FakeContext {
  readonly ctx: ContextLike
  readonly tools: RegisteredTool[]
  readonly logs: { readonly level: 'warn' | 'info' | 'error'; readonly message: string }[]
  readonly fibers: { readonly services: readonly string[]; disposed: boolean }[]
  readonly cleanups: (() => void)[]
  /** Providers registered through the fake skills service. */
  readonly skills: FakeSkillRegistration[]
  /** Agents the fake registry reports; add to it before the plugin activates. */
  readonly registry: AgentLike[]
  emitCreated(agent: AgentLike): Promise<void>
  emitDisposed(agent: AgentLike): void
  /**
   * Announce a settings write the way the Loader does when only volatile fields
   * changed: the row is not restarted, and the touched paths are reported.
   * @param paths - the configuration paths the write changed.
   * @returns settlement of every listener's reaction.
   */
  emitVolatileUpdate(paths: readonly (readonly string[])[]): Promise<void>
}

/** One provider registration observed on the fake skills service. */
export interface FakeSkillRegistration {
  readonly provider: SkillProviderLike
  disposed: boolean
}

/**
 * Build a fake context with a fake subagent registry.
 * @param subagents - fake service.
 * @returns the context plus everything it recorded.
 */
export function createFakeContext(subagents: SubagentService): FakeContext {
  const tools: RegisteredTool[] = []
  const logs: FakeContext['logs'][number][] = []
  const fibers: FakeContext['fibers'][number][] = []
  const cleanups: (() => void)[] = []
  const registry: AgentLike[] = []
  const skillRegistrations: FakeSkillRegistration[] = []
  type Payload = { agent: AgentLike }
  type VolatileListener = (paths: readonly (readonly string[])[]) => unknown
  const listeners = new Map<'agent/created' | 'agent/disposed', ((payload: Payload) => unknown)[]>()
  const volatileListeners: VolatileListener[] = []

  const skills: SkillRegistryLike = {
    registerProvider(create) {
      const entry: FakeSkillRegistration = { provider: create(undefined), disposed: false }
      skillRegistrations.push(entry)
      return () => { entry.disposed = true }
    },
  }

  const ctx: ContextLike = {
    tools: {
      register(definition) {
        const entry: RegisteredTool = { definition, disposed: false }
        tools.push(entry)
        return () => { entry.disposed = true }
      },
    },
    subagents,
    logger: {
      warn: (...args) => { logs.push({ level: 'warn', message: args.map(String).join(' ') }) },
      info: (...args) => { logs.push({ level: 'info', message: args.map(String).join(' ') }) },
      error: (...args) => { logs.push({ level: 'error', message: args.map(String).join(' ') }) },
    },
    on(event, listener) {
      if (event === 'loader/volatile-update') {
        const volatile = listener as VolatileListener
        volatileListeners.push(volatile)
        return () => {
          const index = volatileListeners.indexOf(volatile)
          if (index >= 0) volatileListeners.splice(index, 1)
        }
      }
      const list = listeners.get(event) ?? []
      list.push(listener as (payload: Payload) => unknown)
      listeners.set(event, list)
      return () => {
        const index = list.indexOf(listener as (payload: Payload) => unknown)
        if (index >= 0) list.splice(index, 1)
      }
    },
    get(name) {
      return name === 'agents' ? { list: () => [...registry] } : undefined
    },
    inject(services, callback) {
      const first = tools.length
      const fiber = { services, disposed: false }
      fibers.push(fiber)
      // Only a scope that asked for `skills` carries the service, mirroring the
      // real context where the property appears through the injected fiber.
      callback(services.includes('skills') ? { ...ctx, skills } : ctx)
      const owned = tools.slice(first)
      return {
        dispose() {
          fiber.disposed = true
          for (const entry of owned) entry.disposed = true
        },
      }
    },
    effect(callback) {
      const cleanup = callback()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
  }

  return {
    ctx,
    tools,
    logs,
    fibers,
    cleanups,
    skills: skillRegistrations,
    registry,
    async emitCreated(agent) {
      for (const listener of [...listeners.get('agent/created') ?? []]) await listener({ agent })
    },
    emitDisposed(agent) {
      for (const listener of [...listeners.get('agent/disposed') ?? []]) listener({ agent })
    },
    async emitVolatileUpdate(paths) {
      for (const listener of [...volatileListeners]) await listener(paths)
    },
  }
}

/**
 * Build an Agent with a working directory.
 * @param ctx - context the Agent runs in.
 * @param cwd - session working directory.
 * @returns the Agent.
 */
export function createAgent(ctx: ContextLike, cwd?: string): AgentLike {
  return { session: { header: { cwd } }, ctx }
}

/**
 * In-memory discovery IO, so discovery tests write nothing to disk.
 * @param files - definition file contents keyed by path.
 * @param directories - directories that exist.
 * @returns the fake IO.
 */
export function createMemoryIo(
  files: readonly (readonly [string, string])[],
  directories: readonly string[],
): DiscoveryIo {
  const contents = new Map(files.map(([path, text]) => [resolve(path), text]))
  const existing = new Set(directories.map(path => resolve(path)))
  return {
    listDefinitionFiles(dir) {
      const root = resolve(dir)
      return Promise.resolve(
        [...contents.keys()]
          .filter(path => dirname(path) === root)
          .map(path => basename(path))
          .sort(),
      )
    },
    readFile(file) {
      const text = contents.get(resolve(file))
      return text === undefined ? Promise.reject(new Error(`ENOENT: ${file}`)) : Promise.resolve(text)
    },
    isDirectory(path) {
      return Promise.resolve(existing.has(resolve(path)))
    },
  }
}

/**
 * A mutable in-memory filesystem: discovery IO that a test can keep changing
 * while the plugin runs, which is what the watcher cases need.
 */
export class MemoryIo implements DiscoveryIo {
  readonly files = new Map<string, string>()
  readonly dirs = new Set<string>()

  /** @param path - directory that exists. */
  mkdir(path: string): void {
    this.dirs.add(resolve(path))
  }

  /**
   * @param path - file path to create or replace.
   * @param text - file content.
   */
  write(path: string, text: string): void {
    const absolute = resolve(path)
    this.files.set(absolute, text)
    this.dirs.add(dirname(absolute))
  }

  /**
   * @param path - file to delete.
   */
  remove(path: string): void {
    this.files.delete(resolve(path))
  }

  listDefinitionFiles(dir: string): Promise<readonly string[]> {
    const root = resolve(dir)
    return Promise.resolve(
      [...this.files.keys()].filter(path => dirname(path) === root).map(path => basename(path)).sort(),
    )
  }

  readFile(file: string): Promise<string> {
    const text = this.files.get(resolve(file))
    return text === undefined ? Promise.reject(new Error(`ENOENT: ${file}`)) : Promise.resolve(text)
  }

  isDirectory(path: string): Promise<boolean> {
    return Promise.resolve(this.dirs.has(resolve(path)))
  }
}
