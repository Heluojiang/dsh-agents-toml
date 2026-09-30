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
  SubagentService,
  SubagentStartRequest,
} from './host.ts'

/**
 * Why this definition cannot run on this provider, or `undefined` when it can.
 * @param definition - validated definition.
 * @param provider - the named transport it would use.
 * @returns a model- and operator-readable reason.
 */
export function capabilityFailure(definition: AgentDefinition, provider: SubagentProvider): string | undefined {
  const { capabilities } = provider
  const routed = definition.llmProvider !== undefined
    || definition.model !== undefined
    || definition.reasoningEffort !== undefined
    || definition.maxTokens !== undefined
  if (routed && !capabilities.agentOptions) return 'child LLM routing is unsupported by this provider'
  if (definition.persona !== undefined && !capabilities.persona) return 'persona is unsupported by this provider'
  if (definition.tools !== undefined && !capabilities.toolFilter) return 'tool filtering is unsupported by this provider'
  if (definition.maxDepth !== undefined && !capabilities.depthLimit) return 'an explicit depth cap is unsupported by this provider'
  if (definition.outputSchema !== undefined && !capabilities.outputSchema) return 'a structured output schema is unsupported by this provider'
  if (definition.outputSchema !== undefined && definition.mode === 'continuable') {
    return 'a structured output schema applies to one-shot runs only'
  }
  if (definition.mode === 'continuable' && provider.prepareContinuable === undefined) {
    return 'continuable mode is unsupported by this provider'
  }
  return undefined
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
 * Resolve the delegation depth the Host setting provides.
 * @param subagents - the subagent service.
 * @returns the host-configured absolute depth, or `undefined` on older runtimes.
 */
export function resolveHostDepth(subagents: SubagentService): number | undefined {
  if (typeof subagents.resolveMaxDepth !== 'function') return undefined
  return subagents.resolveMaxDepth(undefined)
}

/**
 * Join a child's text blocks into the result the parent model reads.
 * @param blocks - child output blocks.
 * @returns newline-joined non-empty text.
 */
export function outputText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text' && typeof block.text === 'string' && block.text.length > 0)
    .map(block => block.text)
    .join('\n')
}

/** Either the child's answer or the failure the parent model must read. */
export type DescribedResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string }

/**
 * Turn a terminal run result into either the child's answer or a failure text.
 * @param result - the settled subagent result.
 * @returns the success text, or the failure text preserving partial output.
 */
export function describeResult(result: SubagentResult): DescribedResult {
  const text = outputText(result.output)
  if (result.stopReason === 'completed') {
    return { ok: true, text: text.length === 0 ? '(the subagent finished without a text answer)' : text }
  }
  const parts = [`the subagent did not complete: ${result.stopReason}`]
  if (result.diagnostic !== undefined && result.diagnostic.length > 0) parts.push(result.diagnostic)
  if (text.length > 0) parts.push(`Partial output:\n${text}`)
  return { ok: false, error: parts.join('\n') }
}
