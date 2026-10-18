/**
 * The bundled examples are documentation people copy, so they must stay valid
 * definitions rather than drifting into prose that no longer parses. This spec
 * parses `guide/*.toml` with the real parser and checks the capabilities each
 * example depends on.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { parseDefinition, type AgentDefinition } from '../src/definitions.ts'
import type { SubagentProvider } from '../src/host.ts'
import { capabilityFailure } from '../src/mapping.ts'
import { FORK_CAPABILITIES, FULL_CAPABILITIES, NO_CAPABILITIES } from './harness.ts'

/**
 * Parse one bundled example with the real parser.
 * @param file - file name inside `guide/`.
 * @returns the validated definition.
 */
function example(file: string): AgentDefinition {
  const path = fileURLToPath(new URL(`../guide/${file}`, import.meta.url))
  const outcome = parseDefinition(readFileSync(path, 'utf8'), { file: path, origin: 'user' })
  assert.ok(outcome.ok, `${file} must stay a valid definition: ${outcome.ok ? '' : outcome.failure.reason}`)
  return outcome.definition
}

/** A spawn-like provider: every start capability plus continuable support. */
function spawnLike(): SubagentProvider {
  return {
    name: 'spawn',
    capabilities: FULL_CAPABILITIES,
    inheritsParentContext: false,
    prepareContinuable: () => Promise.resolve({}),
  }
}

/** An out-of-process provider with no start capabilities, like codex or acp. */
function outOfProcess(): SubagentProvider {
  return { name: 'codex', capabilities: NO_CAPABILITIES, inheritsParentContext: false }
}

/** The `fork` transport: inherits the parent context, so it accepts no preset. */
function forking(): SubagentProvider {
  return {
    name: 'fork',
    capabilities: FORK_CAPABILITIES,
    inheritsParentContext: true,
    prepareContinuable: () => Promise.resolve({}),
  }
}

test('guide/explorer.toml stays a valid continuable definition on a routed model', () => {
  const definition = example('explorer.toml')
  assert.equal(definition.name, 'explorer')
  assert.equal(definition.mode, 'continuable')
  assert.equal(definition.model, 'deepseek-v4-flash')
  assert.equal(definition.llmProvider, 'deepseek-official')
  assert.equal(definition.maxDepth, 1)
  assert.equal(definition.agentPreset, 'explorer')
  // The commented-out keys must stay commented: continuable cannot carry a schema.
  assert.equal(definition.outputSchema, undefined)
  assert.equal(capabilityFailure(definition, spawnLike()), undefined)
})

test('guide/explorer.toml rejects a provider without start capabilities', () => {
  const definition = example('explorer.toml')
  const provider = outOfProcess()
  // The routing fields are checked first, so that is the reason this provider sees.
  assert.match(
    String(capabilityFailure(definition, provider)),
    /child LLM routing is unsupported by this provider/,
  )
})

test('guide/explorer.toml rejects an inheriting transport, which cannot select a preset', () => {
  const definition = example('explorer.toml')
  assert.match(
    String(capabilityFailure(definition, forking())),
    /independent agent preset selection is unsupported by this provider/,
  )
})

test('guide/reviewer.toml stays a valid one-shot definition with a structured result', () => {
  const definition = example('reviewer.toml')
  assert.equal(definition.name, 'reviewer')
  assert.equal(definition.mode, 'one-shot')
  assert.equal(definition.agentPreset, 'reviewer')
  assert.deepEqual(definition.outputSchema?.['required'], ['summary'])
  assert.equal(capabilityFailure(definition, spawnLike()), undefined)
})

test('guide/reviewer.toml rejects a provider that cannot select a preset', () => {
  const definition = example('reviewer.toml')
  const provider = outOfProcess()
  assert.match(
    String(capabilityFailure(definition, provider)),
    /independent agent preset selection is unsupported by this provider/,
  )
})

