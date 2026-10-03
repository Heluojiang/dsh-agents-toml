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

/** Invocation controls a skill advertises to discovery consumers. */
export interface SkillInvocationPolicy {
  /** Whether the model-facing `skill` tool may load this skill. */
  readonly modelInvocable: boolean
  /** Whether human-facing command catalogs include this skill. */
  readonly userInvocable: boolean
}

/** Discovery source recorded on a candidate; `bundled` marks a packaged skill. */
export type SkillSourceLike =
  | 'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents' | 'custom' | 'bundled'
  | (string & {})

/** Provider-to-registry skill entry: summary fields plus the provider's own handle. */
export interface SkillCandidateLike {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicy
  readonly source: SkillSourceLike
  /** Must equal the registering provider's name. */
  readonly provider: string
  /** Base relative references in the body resolve against. */
  readonly resourceBase?: { readonly kind: 'directory'; readonly path: string }
  /** Lower ranks win duplicate names within one registry layer. */
  readonly rank: number
  /** Opaque provider state handed back to `get`. */
  readonly locator: unknown
}

/** Complete skill body returned by a provider's `get`. */
export interface SkillDefinitionLike extends Omit<SkillCandidateLike, 'rank' | 'locator'> {
  readonly content: string
}

/** One source of skills. */
export interface SkillProviderLike {
  /** Unique provider name inside the registry layer. */
  readonly name: string
  list(options: { readonly cwd?: string | undefined; readonly signal: AbortSignal }): Promise<readonly SkillCandidateLike[]>
  get(
    candidate: SkillCandidateLike,
    options: { readonly cwd?: string | undefined; readonly signal: AbortSignal },
  ): Promise<SkillDefinitionLike | undefined>
}

/** `ctx.skills`: the provider registry skills are contributed to. */
export interface SkillRegistryLike {
  /**
   * Register one provider.
   * @param create - factory receiving the registration-scoped control.
   * @returns the disposer removing the provider.
   */
  registerProvider(create: (control: unknown) => SkillProviderLike): () => void
}

/** The Agent this plugin delegates from. */
export interface AgentLike {
  readonly session: { readonly header: { readonly cwd?: string | undefined } }
  readonly ctx: ContextLike
}

/** The subset of the Cordis logger this plugin writes through. */
export interface LoggerLike {
  warn(...args: readonly unknown[]): void
  info(...args: readonly unknown[]): void
  error(...args: readonly unknown[]): void
}

/** The subset of the Cordis context this plugin uses. */
export interface ContextLike {
  readonly tools: { register(definition: ToolDefinition): () => void }
  readonly subagents: SubagentService
  readonly logger: LoggerLike
  on(event: 'agent/created', listener: (payload: { agent: AgentLike }) => void | Promise<void>): () => void
  on(event: 'agent/disposed', listener: (payload: { agent: AgentLike }) => void): () => void
  inject(services: readonly string[], callback: (scoped: ContextLike) => void): FiberLike
  /** Read another service by name; used to reach the Agent registry. */
  get(name: string): unknown
  /** Run a contribution for this plugin's lifetime. */
  effect(callback: () => (() => void) | void): void
  /** Present on a context that injected `skills`; the optional skill contribution. */
  readonly skills?: SkillRegistryLike
}

/** The Agent registry, read to catch Agents created before this plugin activated. */
export interface AgentRegistryLike {
  list(): readonly AgentLike[]
}
