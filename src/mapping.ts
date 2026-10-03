/**
 * Mapping one validated definition onto a subagent start request, plus the
 * capability checks that decide whether that definition can run at all.
 *
 * Every mismatch is reported as a reason string. The Harness rejects a request
 * that needs a capability its provider lacks rather than ignoring the field, so
 * the plugin performs the same check itself and turns it into a definition
 * failure the operator can see.
 * @module dsh-agents-toml/mapping
 */
import type { AgentDefinition } from './definitions.ts'
import type {
  AgentLike,
  AgentOptions,
  ContentBlock,
  SubagentProvider,
  SubagentResult,
  SubagentStartRequest,
} from './host.ts'

/**
 * Every way a definition can ask for something its provider lacks, in check
 * order. The reasons are the model- and operator-facing text, and
 * `guide/technical.md` reproduces them in this order.
 */
export const CAPABILITY_RULES: readonly {
  /** Stable id, also used by the documentation table. */
  readonly id: string
  /** Reason reported when the definition asks for it and the provider lacks it. */
  readonly reason: string
  /** Whether the definition asks for it at all. */
  asks(definition: AgentDefinition): boolean
  /** Whether the provider supports what it asks for. */
  supports(provider: SubagentProvider): boolean
}[] = [
  {
    id: 'agentOptions',
    reason: 'child LLM routing is unsupported by this provider',
    asks: definition => definition.llmProvider !== undefined
      || definition.model !== undefined
      || definition.reasoningEffort !== undefined
      || definition.maxTokens !== undefined,
    supports: provider => provider.capabilities.agentOptions,
  },
  {
    id: 'persona',
    reason: 'persona is unsupported by this provider',
    asks: definition => definition.persona !== undefined,
    supports: provider => provider.capabilities.persona,
  },
  {
    id: 'toolFilter',
    reason: 'tool filtering is unsupported by this provider',
    asks: definition => definition.tools !== undefined,
    supports: provider => provider.capabilities.toolFilter,
  },
  {
    id: 'depthLimit',
    reason: 'an explicit depth cap is unsupported by this provider',
    asks: definition => definition.maxDepth !== undefined,
    supports: provider => provider.capabilities.depthLimit,
  },
  {
    id: 'outputSchema',
    reason: 'a structured output schema is unsupported by this provider',
    asks: definition => definition.outputSchema !== undefined,
    supports: provider => provider.capabilities.outputSchema,
  },
  {
    // Not a capability bit: a structured result belongs to a one-shot run, so
    // no provider can serve this combination.
    id: 'outputSchemaOneShot',
    reason: 'a structured output schema applies to one-shot runs only',
    asks: definition => definition.outputSchema !== undefined && definition.mode === 'continuable',
    supports: () => false,
  },
  {
    // Method presence on the provider IS the continuable capability.
    id: 'continuable',
    reason: 'continuable mode is unsupported by this provider',
    asks: definition => definition.mode === 'continuable',
    supports: provider => provider.prepareContinuable !== undefined,
  },
]

/**
 * Why this definition cannot run on this provider, or `undefined` when it can.
 * @param definition - validated definition.
 * @param provider - the named transport it would use.
 * @returns a model- and operator-readable reason.
 */
export function capabilityFailure(definition: AgentDefinition, provider: SubagentProvider): string | undefined {
  return CAPABILITY_RULES.find(rule => rule.asks(definition) && !rule.supports(provider))?.reason
}

/**
 * Resolve the delegation depth cap for one child.
 *
 * A definition that names `max_depth` always sends it, and an explicit cap on a
 * provider without `depthLimit` stays a definition failure. Otherwise the cap
 * is sent only to a provider that can enforce it, because the Harness rejects
 * any request carrying `maxDepth` on a provider without that capability — the
 * same reason the official tool offers `maxDepth: 'provider-managed'`.
 * @param definition - validated definition.
 * @param provider - the transport the child would use.
 * @param hostDepth - the Host's configured depth, read at call time; `undefined`
 * on a runtime that exposes no shared depth policy.
 * @returns the cap to send, or `undefined` to leave enforcement to the provider.
 */
export function depthFor(
  definition: AgentDefinition,
  provider: SubagentProvider,
  hostDepth: number | undefined,
): number | undefined {
  if (definition.maxDepth !== undefined) return definition.maxDepth
  if (!provider.capabilities.depthLimit) return undefined
  return hostDepth
}

/**
 * Build the child route overrides this definition asks for.
 * @param definition - validated definition.
 * @returns route overrides, or `undefined` when the definition sets none.
 */
export function buildAgentOptions(definition: AgentDefinition): AgentOptions | undefined {
  const options: AgentOptions = {
    ...definition.llmProvider === undefined ? {} : { provider: definition.llmProvider },
    ...definition.model === undefined ? {} : { model: definition.model },
    ...definition.reasoningEffort === undefined ? {} : { reasoningEffort: definition.reasoningEffort },
    ...definition.maxTokens === undefined ? {} : { maxTokens: definition.maxTokens },
  }
  return Object.keys(options).length === 0 ? undefined : options
}

/** Definition, calling Agent, and the depth cap resolved once per call. */
interface ChildInput {
  readonly definition: AgentDefinition
  readonly parent: AgentLike
  readonly maxDepth: number | undefined
}

/** {@link ChildInput} plus the cancellation channel a one-shot run owns. */
interface RunInput extends ChildInput {
  readonly signal: AbortSignal
}

/** Fields shared by one-shot and continuable requests. */
type ChildRequestFields = Omit<SubagentStartRequest, 'label' | 'prompt' | 'parent' | 'signal' | 'outputSchema'>

function requestFields(input: ChildInput): ChildRequestFields {
  const { definition, maxDepth } = input
  const agentOptions = buildAgentOptions(definition)
  return {
    ...agentOptions === undefined ? {} : { agentOptions },
    ...definition.persona === undefined ? {} : { persona: definition.persona },
    ...definition.tools === undefined ? {} : { toolFilter: definition.tools },
    ...maxDepth === undefined ? {} : { maxDepth },
  }
}

/**
 * Build the one-shot request for a definition.
 * @param input - definition, calling Agent, cancellation, and resolved depth cap.
 * @param prompt - the model's delegation prompt.
 * @param label - the model's short delegation label.
 * @returns the provider-facing start request.
 */
export function buildRunRequest(input: RunInput, prompt: string, label: string): SubagentStartRequest {
  const { definition } = input
  return {
    label,
    prompt: [{ type: 'text', text: prompt }],
    parent: input.parent,
    signal: input.signal,
    ...requestFields(input),
    ...definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema },
  }
}

/**
 * Build the continuable creation request for a definition. The service owns a
 * continuable child's label and cancellation, and such a child carries no
 * output schema, so those fields are absent here.
 * @param input - definition, calling Agent, and resolved depth cap.
 * @param prompt - the model's delegation prompt.
 * @returns the request portion of a continuable start spec.
 */
export function buildContinuableRequest(
  input: ChildInput,
  prompt: string,
): Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'> {
  return { prompt: [{ type: 'text', text: prompt }], parent: input.parent, ...requestFields(input) }
}

/**
 * Join a child's text blocks into the result the parent model reads.
 *
 * Blocks are newline-joined, unlike the official tool's empty-string join: a
 * child that splits its answer across messages stays readable here.
 * @param blocks - child output blocks.
 * @returns newline-joined text, ignoring empty ones.
 */
export function outputText(blocks: readonly ContentBlock[]): string {
  return blocks.filter(block => block.type === 'text' && block.text.length > 0).map(block => block.text).join('\n')
}

/** Either the child's answer or the failure the parent model must read. */
export type DescribedResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string }

/** Whether the definition asked the child for a structured result. */
export interface DescribeOptions {
  /** True when the definition set `output_schema`. */
  readonly expectStructured?: boolean
}

/**
 * Turn a terminal run result into either the child's answer or a failure text.
 *
 * A structured value that the child successfully captured is the answer: the
 * Harness instructs such a child not to finish with prose, so its text output is
 * usually empty and the placeholder sentence would otherwise hide the result.
 * No size cap is applied here; retaining and truncating large results belongs to
 * the tool-result and session machinery that owns them.
 * @param result - the settled subagent result.
 * @param options - whether the definition asked for a structured result.
 * @returns the success text, or the failure text preserving partial output.
 */
export function describeResult(result: SubagentResult, options: DescribeOptions = {}): DescribedResult {
  const text = outputText(result.output)
  if (result.stopReason === 'completed') {
    if (result.structured !== undefined) {
      const json = JSON.stringify(result.structured, null, 2)
      return { ok: true, text: text.length === 0 ? json : `${json}\n\n${text}` }
    }
    return { ok: true, text: text.length === 0 ? '(the subagent finished without a text answer)' : text }
  }
  const parts = [`the subagent did not complete: ${result.stopReason}`]
  if (result.diagnostic !== undefined && result.diagnostic.length > 0) parts.push(result.diagnostic)
  if (options.expectStructured === true && result.structured === undefined) {
    parts.push('the child did not produce a value for output_schema')
  }
  if (text.length > 0) parts.push(`Partial output:\n${text}`)
  return { ok: false, error: parts.join('\n') }
}
