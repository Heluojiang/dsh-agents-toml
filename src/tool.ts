/**
 * The single delegation tool: one tool, one `agent_type` parameter.
 *
 * The tool's schema is built per Agent from that Agent's own definition set, so
 * two Agents working in different projects see different `agent_type` values
 * while the Harness carries one tool definition per Agent scope. Arguments are
 * validated here because the tool registry validates only a tool's output.
 * @module dsh-agents-toml/tool
 */
import type { DefinitionFailure } from './definitions.ts'
import type { DiscoveryResult } from './discovery.ts'
import type {
  AgentLike,
  AgentPresetRosterLike,
  ContentBlock,
  JsonValue,
  SubagentService,
  ToolDefinition,
} from './host.ts'
import {
  buildContinuableRequest,
  buildRunRequest,
  capabilityFailure,
  depthFor,
  describeResult,
} from './mapping.ts'

/**
 * One definition as the install-time snapshot saw it.
 *
 * A single entry per definition keeps every model-facing list derived from one
 * source: the `agent_type` enum, the routing hints, the background-answer
 * warning, and the inheriting-transport warning all read this array.
 */
export interface InstalledSubagent {
  /** The `agent_type` value. */
  readonly name: string
  /** The definition's routing hint, shown to the model beside its name. */
  readonly description: string
  /**
   * Whether this definition starts its child in the background.
   */
  readonly continuable: boolean
  /**
   * The Agent Preset this definition composes its child from, when it names one.
   */
  readonly agentPreset?: string | undefined
  /**
   * Whether this definition's transport seeds the child with the parent's
   * completed turns. The provider registry is read at install time; a
   * definition whose provider is not registered yet counts as not inheriting,
   * and the call reports the missing provider.
   */
  readonly inherits: boolean
}

/** Everything one installed tool instance needs. */
export interface DelegationToolOptions {
  readonly toolName: string
  /** Transport used by definitions that name none. */
  readonly defaultProvider: string
  /** Whether unavailable definitions are reported in the tool description. */
  readonly reportFailuresToModel: boolean
  readonly subagents: SubagentService
  /**
   * The Agent Preset roster, read at call time to check an `agent_preset`
   * value; `undefined` on a composition that mounts no `agent-presets` service.
   */
  readonly presets?: AgentPresetRosterLike | undefined
  /**
   * The Host's configured delegation depth, read at call time.
   * @returns the depth, or `undefined` on a runtime without a shared policy.
   */
  readonly hostDepth: () => number | undefined
  /** Fresh discovery for the calling Agent, so edited files apply on the next call. */
  readonly load: (agent: AgentLike) => Promise<DiscoveryResult>
  /** Definitions available when this instance was installed. */
  readonly installed: readonly InstalledSubagent[]
  /** Failures known when this instance was installed. */
  readonly installedFailures: readonly DefinitionFailure[]
  /**
   * Agent Preset ids the roster reported at install time, when any installed
   * definition selects one; an empty list means the roster answered with none.
   */
  readonly installedPresets?: readonly string[] | undefined
}

/** Validated tool arguments. */
interface DelegationArgs {
  readonly agentType: string
  readonly description: string
  readonly prompt: string
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`"${field}" must be a non-empty string`)
  }
  return value
}

function readDelegationArgs(args: unknown): DelegationArgs {
  const record = asRecord(args, 'arguments')
  return {
    agentType: requireString(record, 'agent_type'),
    description: requireString(record, 'description'),
    prompt: requireString(record, 'prompt'),
  }
}

function readText(value: JsonValue): string {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const text = value['text']
    if (typeof text === 'string') return text
  }
  return ''
}

function unknownAgentTypeMessage(requested: string, discovery: DiscoveryResult): string {
  const failed = discovery.failures.find(failure => failure.name === requested)
  if (failed !== undefined) {
    return `subagent "${requested}" is unavailable: ${failed.reason} (${failed.file})`
  }
  const available = discovery.definitions.filter(definition => definition.enabled).map(definition => definition.name)
  return available.length === 0
    ? `no subagent named "${requested}" is configured`
    : `unknown subagent "${requested}"; configured subagents: ${available.join(', ')}`
}

/**
 * Reject a definition whose `agent_preset` this composition cannot serve.
 *
 * A missing roster and an unknown id are different problems with different
 * fixes — the first is a deployment that does not mount the preset service (the
 * packaged headless bundle does not), the second is a mistyped or undeclared
 * preset — so they get different text. The check runs here rather than at load
 * because the roster is a runtime fact, and because presets may be registered
 * by rows that activate after this one.
 * @param agentType - the definition's name, for the message.
 * @param wanted - the preset id the definition names.
 * @param presets - the roster, or `undefined` when the composition mounts none.
 */
async function assertPreset(
  agentType: string,
  wanted: string,
  presets: AgentPresetRosterLike | undefined,
): Promise<void> {
  if (presets === undefined) {
    throw new Error(
      `subagent "${agentType}" sets agent_preset = "${wanted}", but this composition mounts no agent-presets `
      + 'service; the packaged web bundle mounts it and the headless bundle does not',
    )
  }
  const rows = await presets.list()
  if (rows.some(row => row.id === wanted)) return
  const ids = rows.map(row => row.id)
  throw new Error(
    `subagent "${agentType}" names agent preset "${wanted}", which is not registered; available agent presets: `
    + (ids.length === 0 ? '(none)' : ids.join(', ')),
  )
}

function buildDescription(options: DelegationToolOptions): string {
  const names = options.installed.map(entry => entry.name)
  const parts = [
    'Delegate a self-contained task to one of the named subagents configured for this user or project, chosen with `agent_type`.',
  ]
  const inheriting = options.installed.filter(entry => entry.inherits).map(entry => entry.name)
  if (inheriting.length > 0) {
    // A forking transport seeds the child with the parent's completed turns, so
    // telling the model the child never sees this conversation would be wrong.
    parts.push(
      `A subagent on an inheriting transport (${inheriting.join(', ')}) already sees this conversation's completed turns; `
      + 'every other subagent works in its own context, so include everything it needs in `prompt`.',
    )
  } else {
    parts.push('The subagent works in its own context and returns only its result, so include everything it needs in `prompt`.')
  }
  const continuable = options.installed.filter(entry => entry.continuable).map(entry => entry.name)
  if (continuable.length > 0) {
    // A background child answers through the parent's inbox, so the generic
    // "returns only its result" above would promise an answer this call never
    // carries.
    parts.push(
      `Background subagents (${continuable.join(', ')}) return only a child id; `
      + 'the child\'s answer does not come back with this call.',
    )
  }
  if (names.length > 0) parts.push(`Configured subagents: ${names.join(', ')}.`)
  if (options.installed.some(entry => entry.agentPreset !== undefined)) {
    // The ids are the only legal `agent_preset` values a definition can name, so
    // the model's own view of this tool lists them rather than letting a typo in
    // a definition surface as one failed delegation.
    const presets = options.installedPresets ?? []
    parts.push(
      `Agent presets available in this composition: ${presets.length === 0 ? '(none)' : presets.join(', ')}.`,
    )
  }
  if (options.reportFailuresToModel && options.installedFailures.length > 0) {
    const unavailable = options.installedFailures
      .map(failure => `${failure.name ?? failure.file} (${failure.reason})`)
      .join('; ')
    parts.push(`Unavailable definitions: ${unavailable}.`)
  }
  return parts.join(' ')
}

/**
 * Render the `agent_type` parameter description.
 *
 * Each definition's own `description` is its routing hint, so it belongs where
 * the model chooses a value; a JSON Schema enum carries names only.
 * @param installed - the install-time snapshot.
 * @returns the parameter description, hinting every name it lists.
 */
function buildAgentTypeDescription(installed: readonly InstalledSubagent[]): string {
  const lead = 'Name of the configured subagent to delegate to.'
  if (installed.length === 0) return lead
  const hints = installed.map(entry => `${entry.name} — ${entry.description}`)
  return `${lead} Each is declared for a different job: ${hints.join(' | ')}`
}

function buildParameters(installed: readonly InstalledSubagent[]): Record<string, unknown> {
  const names = installed.map(entry => entry.name)
  return {
    type: 'object',
    properties: {
      agent_type: {
        type: 'string',
        description: buildAgentTypeDescription(installed),
        ...names.length === 0 ? {} : { enum: [...names] },
      },
      description: {
        type: 'string',
        description: 'A short (3-5 word) label for this delegation, for display.',
      },
      prompt: {
        type: 'string',
        description: 'The complete, self-contained task for the subagent. It works in its own context unless its transport inherits this one.',
      },
    },
    required: ['agent_type', 'description', 'prompt'],
  }
}

/**
 * Build the delegation tool for one Agent scope.
 * @param options - tool name, providers, discovery loader, and install-time snapshot.
 * @returns a registry-ready tool definition.
 */
export function buildDelegationTool(options: DelegationToolOptions): ToolDefinition {
  const { toolName, subagents } = options
  return {
    name: toolName,
    description: buildDescription(options),
    parameters: buildParameters(options.installed),
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The subagent result returned to the caller.' } },
        required: ['text'],
      },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: readText(value) }],
    },
    // Delegation never mutates the parent session.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { agentType, description, prompt } = readDelegationArgs(args)
      const parent = exec.agent
      if (parent === undefined) throw new Error(`"${toolName}" requires a calling agent`)

      const discovery = await options.load(parent)
      const definition = discovery.definitions.find(candidate => candidate.name === agentType)
      if (definition === undefined) throw new Error(unknownAgentTypeMessage(agentType, discovery))
      if (!definition.enabled) throw new Error(`subagent "${agentType}" is disabled in ${definition.file}`)

      const providerName = definition.provider ?? options.defaultProvider
      const provider = subagents.getProvider(providerName)
      if (provider === undefined) {
        const registered = subagents.list()
        throw new Error(
          `subagent "${agentType}" names provider "${providerName}", which is not registered; registered providers: `
          + (registered.length === 0 ? '(none)' : registered.join(', ')),
        )
      }
      const reason = capabilityFailure(definition, provider)
      if (reason !== undefined) {
        throw new Error(`subagent "${agentType}" cannot run on provider "${providerName}": ${reason}`)
      }
      if (definition.agentPreset !== undefined) await assertPreset(agentType, definition.agentPreset, options.presets)

      exec.signal.throwIfAborted()
      const maxDepth = depthFor(definition, provider, options.hostDepth())
      const child = { definition, parent, maxDepth }

      if (definition.mode === 'continuable') {
        // `delivery: 'parent'` is the activation that keeps running in the
        // background and notifies the parent when it settles; the caller's own
        // result carries the child id and nothing else.
        const activation = await subagents.startActivation({
          provider: providerName,
          label: description,
          request: buildContinuableRequest(child, prompt),
          signal: exec.signal,
          delivery: 'parent',
        })
        return { text: `started subagent ${String(activation.childId)}` }
      }

      // `delivery: 'caller'` resolves the child's result to this call only, which
      // is exactly the one-shot contract; the activation is disposed afterwards.
      const activation = await subagents.startActivation({
        provider: providerName,
        label: description,
        request: buildRunRequest(child, prompt),
        signal: exec.signal,
        delivery: 'caller',
      })
      try {
        const described = describeResult(
          await activation.result,
          { expectStructured: definition.outputSchema !== undefined },
        )
        if (!described.ok) throw new Error(described.error)
        return { text: described.text }
      } finally {
        await activation.dispose()
      }
    },
  }
}
