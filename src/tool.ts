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
import type { AgentLike, ContentBlock, JsonValue, SubagentService, ToolDefinition } from './host.ts'
import {
  buildContinuableRequest,
  buildRunRequest,
  capabilityFailure,
  describeResult,
  resolveHostDepth,
} from './mapping.ts'

/** Everything one installed tool instance needs. */
export interface DelegationToolOptions {
  readonly toolName: string
  /** Transport used by definitions that name none. */
  readonly defaultProvider: string
  /** Whether unavailable definitions are reported in the tool description. */
  readonly reportFailuresToModel: boolean
  readonly subagents: SubagentService
  /** Fresh discovery for the calling Agent, so edited files apply on the next call. */
  readonly load: (agent: AgentLike) => Promise<DiscoveryResult>
  /** Names available when this instance was installed; drives the schema enum. */
  readonly installedNames: readonly string[]
  /** Failures known when this instance was installed. */
  readonly installedFailures: readonly DefinitionFailure[]
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

function buildDescription(options: DelegationToolOptions): string {
  const parts = [
    'Delegate a self-contained task to one of the named subagents configured for this user or project, chosen with `agent_type`.',
    'The subagent works in its own context and returns only its result, so include everything it needs in `prompt`.',
  ]
  if (options.installedNames.length > 0) parts.push(`Configured subagents: ${options.installedNames.join(', ')}.`)
  if (options.reportFailuresToModel && options.installedFailures.length > 0) {
    const unavailable = options.installedFailures
      .map(failure => `${failure.name ?? failure.file} (${failure.reason})`)
      .join('; ')
    parts.push(`Unavailable definitions: ${unavailable}.`)
  }
  return parts.join(' ')
}

function buildParameters(names: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      agent_type: {
        type: 'string',
        description: 'Name of the configured subagent to delegate to.',
        ...names.length === 0 ? {} : { enum: [...names] },
      },
      description: {
        type: 'string',
        description: 'A short (3-5 word) label for this delegation, for display.',
      },
      prompt: {
        type: 'string',
        description: 'The complete, self-contained task for the subagent. It does not share this conversation\'s context.',
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
    parameters: buildParameters(options.installedNames),
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

      exec.signal.throwIfAborted()
      const maxDepth = definition.maxDepth ?? resolveHostDepth(subagents)
      const child = { definition, parent, maxDepth }

      if (definition.mode === 'continuable') {
        const started = await subagents.startContinuable({
          provider: providerName,
          label: description,
          request: buildContinuableRequest(child, prompt),
          signal: exec.signal,
        })
        return { text: `started subagent ${String(started.childId)}` }
      }

      const run = await subagents.start(
        providerName,
        buildRunRequest({ ...child, signal: exec.signal }, prompt, description),
      )
      try {
        const described = describeResult(await run.result)
        if (!described.ok) throw new Error(described.error)
        return { text: described.text }
      } finally {
        await run.dispose()
      }
    },
  }
}
