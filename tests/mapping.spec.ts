/** Definition-to-request mapping and capability checks. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AgentDefinition } from '../src/definitions.ts'
import type { AgentLike, SubagentProvider } from '../src/host.ts'
import {
  buildAgentOptions,
  buildContinuableRequest,
  buildRunRequest,
  CAPABILITY_RULES,
  capabilityFailure,
  depthFor,
  describeResult,
  outputText,
} from '../src/mapping.ts'
import { createAgent, createFakeContext, createFakeSubagents, FORK_CAPABILITIES, FULL_CAPABILITIES, NO_CAPABILITIES } from './harness.ts'

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'reviewer',
    description: 'Reviews code.',
    enabled: true,
    mode: 'one-shot',
    file: 'C:/defs/reviewer.toml',
    origin: 'user',
    ...overrides,
  }
}

function provider(overrides: Partial<SubagentProvider> = {}): SubagentProvider {
  return { name: 'spawn', capabilities: FULL_CAPABILITIES, inheritsParentContext: false, ...overrides }
}

function agent(): AgentLike {
  const { service } = createFakeSubagents([])
  return createAgent(createFakeContext(service).ctx, 'C:/work')
}

describe('capabilityFailure', () => {
  it('accepts a definition the provider fully supports', () => {
    const full = definition({
      agentPreset: 'reviewer', maxDepth: 1, llmProvider: 'deepseek-official', model: 'm',
      outputSchema: { type: 'object' },
    })
    assert.equal(capabilityFailure(full, provider()), undefined)
  })

  it('names the unsupported feature for an out-of-process transport', () => {
    const outOfProcess = provider({ name: 'codex', capabilities: NO_CAPABILITIES })
    assert.match(capabilityFailure(definition({ model: 'm' }), outOfProcess) ?? '', /child LLM routing/)
    assert.match(capabilityFailure(definition({ agentPreset: 'p' }), outOfProcess) ?? '', /agent preset/)
    assert.match(capabilityFailure(definition({ maxDepth: 1 }), outOfProcess) ?? '', /depth cap/)
    assert.match(capabilityFailure(definition({ outputSchema: { type: 'object' } }), outOfProcess) ?? '', /structured output/)
  })

  it('rejects an independent preset on a provider that inherits the parent context', () => {
    // The Harness rejects `agentPreset` whenever the provider inherits the
    // parent's context, so `fork` cannot select one even though it supports the
    // other start-time features.
    const fork = provider({ name: 'fork', capabilities: FORK_CAPABILITIES, inheritsParentContext: true })
    assert.match(capabilityFailure(definition({ agentPreset: 'p' }), fork) ?? '', /agent preset/)
    assert.equal(capabilityFailure(definition({ model: 'm' }), fork), undefined)
  })

  it('rejects continuable mode without a continuable-capable provider', () => {
    assert.match(capabilityFailure(definition({ mode: 'continuable' }), provider()) ?? '', /continuable mode/)
    assert.equal(capabilityFailure(definition({ mode: 'continuable' }), provider({ prepareContinuable: () => Promise.resolve({}) })), undefined)
  })

  it('rejects an output schema on a continuable definition', () => {
    const reason = capabilityFailure(
      definition({ mode: 'continuable', outputSchema: { type: 'object' } }),
      provider({ prepareContinuable: () => Promise.resolve({}) }),
    )
    assert.match(reason ?? '', /one-shot runs only/)
  })
})

describe('buildAgentOptions', () => {
  it('returns undefined when the definition sets no route', () => {
    assert.equal(buildAgentOptions(definition()), undefined)
  })

  it('keeps only the route fields the definition sets', () => {
    assert.deepEqual(
      buildAgentOptions(definition({ model: 'm', maxTokens: 128 })),
      { model: 'm', maxTokens: 128 },
    )
  })
})

describe('buildRunRequest', () => {
  it('carries prompt, parent, and the resolved depth', () => {
    const parent = agent()
    const request = buildRunRequest(
      { definition: definition(), parent, maxDepth: 1 },
      'review the diff',
    )
    assert.deepEqual(request.prompt, [{ type: 'text', text: 'review the diff' }])
    assert.equal(request.parent, parent)
    assert.equal(request.maxDepth, 1)
    assert.equal(request.outputSchema, undefined)
  })

  it('passes the agent preset and output schema through', () => {
    const request = buildRunRequest(
      {
        definition: definition({ agentPreset: 'reviewer', outputSchema: { type: 'object' } }),
        parent: agent(),
        maxDepth: undefined,
      },
      'p',
    )
    assert.equal(request.agentPreset, 'reviewer')
    assert.deepEqual(request.outputSchema, { type: 'object' })
    assert.equal(request.maxDepth, undefined)
  })
})

describe('buildContinuableRequest', () => {
  it('omits the label, signal, and output schema the service owns', () => {
    const request = buildContinuableRequest(
      { definition: definition({ outputSchema: { type: 'object' } }), parent: agent(), maxDepth: 2 },
      'go',
    )
    assert.deepEqual(request.prompt, [{ type: 'text', text: 'go' }])
    assert.equal(request.maxDepth, 2)
    assert.equal('label' in request, false)
    assert.equal('signal' in request, false)
    assert.equal('outputSchema' in request, false)
  })

  it('carries an agent preset, which a continuable child may select', () => {
    const request = buildContinuableRequest(
      { definition: definition({ mode: 'continuable', agentPreset: 'explorer' }), parent: agent(), maxDepth: undefined },
      'go',
    )
    assert.equal(request.agentPreset, 'explorer')
  })
})

describe('depthFor', () => {
  it('reads the host setting for a provider that can enforce a cap', () => {
    assert.equal(depthFor(definition(), provider(), 3), 3)
  })

  it('sends no implicit cap to a provider that cannot enforce one', () => {
    // The Harness rejects any request carrying `maxDepth` on a provider without
    // the capability, so an implicit cap must not be sent at all.
    const outOfProcess = provider({ name: 'codex', capabilities: NO_CAPABILITIES })
    assert.equal(depthFor(definition(), outOfProcess, 1), undefined)
  })

  it('keeps an explicit cap, which stays a definition failure on such a provider', () => {
    const outOfProcess = provider({ name: 'codex', capabilities: NO_CAPABILITIES })
    const explicit = definition({ maxDepth: 2 })
    assert.equal(depthFor(explicit, outOfProcess, 1), 2)
    assert.match(capabilityFailure(explicit, outOfProcess) ?? '', /depth cap/)
  })

  it('returns undefined on a runtime without the shared depth policy', () => {
    assert.equal(depthFor(definition(), provider(), undefined), undefined)
  })
})

describe('CAPABILITY_RULES', () => {
  it('reports the first failing rule in table order', () => {
    const both = definition({ model: 'm', agentPreset: 'p' })
    assert.match(capabilityFailure(both, provider({ name: 'codex', capabilities: NO_CAPABILITIES })) ?? '', /child LLM routing/)
  })

  it('lists every rule id the documentation table repeats', () => {
    assert.deepEqual(CAPABILITY_RULES.map(rule => rule.id), [
      'agentOptions', 'agentPreset', 'depthLimit', 'outputSchema', 'outputSchemaOneShot', 'continuable',
    ])
  })
})

describe('outputText and describeResult', () => {
  it('joins non-empty text blocks', () => {
    assert.equal(outputText([{ type: 'text', text: 'a' }, { type: 'text', text: '' }, { type: 'text', text: 'b' }]), 'a\nb')
  })

  it('returns the child answer on completion', () => {
    const described = describeResult({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' })
    assert.deepEqual(described, { ok: true, text: 'ok' })
  })

  it('explains an empty completion', () => {
    const described = describeResult({ output: [], stopReason: 'completed' })
    assert.equal(described.ok, true)
    if (described.ok) assert.match(described.text, /without a text answer/)
  })

  it('keeps the diagnostic and partial output of a failed run', () => {
    const described = describeResult({
      output: [{ type: 'text', text: 'half' }],
      diagnostic: 'provider said no',
      stopReason: 'error',
    })
    assert.equal(described.ok, false)
    if (!described.ok) {
      assert.match(described.error, /did not complete: error/)
      assert.match(described.error, /provider said no/)
      assert.match(described.error, /Partial output:\nhalf/)
    }
  })
})
