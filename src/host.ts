/**
 * Structural view of the Harness context this plugin consumes.
 *
 * The plugin deliberately imports no `@deepseek-ai/dsh-*` package. The tool
 * registry validates only a tool's output schema (arguments belong to the
 * tool), and every other capability below is a plain service method, so a
 * structural declaration keeps the plugin loadable across Harness releases
 * whose published package versions lag the runtime it boots on.
 * @module dsh-agents-toml/host
 */

/** Model-facing text block. */
export interface ContentBlock {
  readonly type: 'text'
  readonly text: string
}

/** JSON value accepted by tool arguments, results, and schemas. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue }

/** One pending tool call's execution identity. */
export interface ToolExecution {
  /** The Agent that called the tool; absent for non-agent callers. */
  readonly agent?: AgentLike | undefined
  /** Caller cancellation, forwarded to the delegated run. */
  readonly signal: AbortSignal
}

/** A registered tool: model-facing schema plus execution. */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: JsonValue): ContentBlock[]
  }
  isConcurrencySafe?(args: unknown): boolean
  execute(args: unknown, exec: ToolExecution): Promise<unknown>
}

/** Start-time features a subagent provider advertises. */
export interface SubagentCapabilities {
  readonly agentOptions: boolean
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}

/** Host-Agent route overrides for a child. */
export interface AgentOptions {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
}

/** Child tool scoping; unknown names are rejected by the service. */
export interface ToolRestriction {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}

/** One registered child-agent transport. */
export interface SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean
  prepareContinuable?(request: unknown): Promise<unknown>
}

/** One-shot delegation request. */
export interface SubagentStartRequest {
  readonly label?: string
  readonly prompt: readonly ContentBlock[]
  readonly parent: AgentLike
  readonly signal: AbortSignal
  readonly agentOptions?: AgentOptions
  readonly outputSchema?: Record<string, unknown>
  readonly maxDepth?: number
  readonly toolFilter?: ToolRestriction
  readonly persona?: string
}

/** Terminal outcome of a one-shot run. */
export interface SubagentResult {
  readonly output: readonly ContentBlock[]
  readonly structured?: unknown
  readonly diagnostic?: string
  readonly stopReason: string
}

/** Published one-shot child handle. */
export interface SubagentRun {
  readonly id: unknown
  readonly result: Promise<SubagentResult>
  dispose(): Promise<void>
}

/** Continuable-child creation request. */
export interface ContinuableStartSpec {
  readonly provider: string
  readonly label: string
  readonly request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>
  readonly signal: AbortSignal
}

/** `ctx.subagents`: named provider registry plus run and continuation entry points. */
export interface SubagentService {
  getProvider(name: string): SubagentProvider | undefined
  list(): string[]
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>
  startContinuable(spec: ContinuableStartSpec): Promise<{ readonly childId: unknown; readonly messageId: unknown }>
  /** Absent on Harness releases that predate the shared depth policy. */
  resolveMaxDepth?(configured?: number | 'provider-managed'): number | undefined
}

/** Cordis fiber returned by `ctx.inject`. */
export interface FiberLike {
  dispose(): Promise<void> | void
}

/** The Agent this plugin delegates from. */
export interface AgentLike {
  readonly session: { readonly header: { readonly cwd?: string | undefined } }
  readonly ctx: ContextLike
}

/** The subset of the Cordis context this plugin uses. */
export interface ContextLike {
  readonly tools: { register(definition: ToolDefinition): () => void }
  readonly subagents: SubagentService
  readonly logger: { warn(...args: readonly unknown[]): void; info(...args: readonly unknown[]): void }
  on(event: 'agent/created', listener: (payload: { agent: AgentLike }) => void | Promise<void>): () => void
  on(event: 'agent/disposed', listener: (payload: { agent: AgentLike }) => void): () => void
  inject(services: readonly string[], callback: (scoped: ContextLike) => void): FiberLike
  /** Read another service by name; used to reach the Agent registry. */
  get?(name: string): unknown
  /** Absent on foreign contexts; used to close watchers when the plugin unloads. */
  effect?(callback: () => (() => void) | void): void
}

/** The Agent registry, read to catch Agents created before this plugin activated. */
export interface AgentRegistryLike {
  list(): readonly AgentLike[]
}
