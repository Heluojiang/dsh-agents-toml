/** TOML definition parsing and validation. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseDefinition } from '../src/definitions.ts'

const SOURCE = { file: 'C:/defs/reviewer.toml', origin: 'user' } as const

function parse(text: string) {
  return parseDefinition(text, SOURCE)
}

describe('parseDefinition', () => {
  it('reads every supported field', () => {
    const outcome = parse(`
name = "reviewer"
description = "Read-only code review."
enabled = true
mode = "one-shot"
provider = "spawn"
llm_provider = "deepseek-official"
model = "deepseek-v4-flash"
reasoning_effort = "high"
max_tokens = 4096
persona = """
You review code and never edit it.
"""
max_depth = 1
output_schema = { type = "object", properties = { summary = { type = "string" } }, required = ["summary"] }

[tools]
deny = ["write", "edit"]
`)
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.deepEqual(outcome.definition, {
      name: 'reviewer',
      description: 'Read-only code review.',
      enabled: true,
      mode: 'one-shot',
      provider: 'spawn',
      llmProvider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      maxTokens: 4096,
      persona: 'You review code and never edit it.\n',
      maxDepth: 1,
      outputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
      tools: { deny: ['write', 'edit'] },
      file: 'C:/defs/reviewer.toml',
      origin: 'user',
    })
  })

  it('defaults mode, enabled, and origin when omitted', () => {
    const outcome = parse('name = "helper"\ndescription = "Helps."\n')
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.definition.mode, 'one-shot')
    assert.equal(outcome.definition.enabled, true)
    assert.equal(outcome.definition.provider, undefined)
  })

  it('accepts hyphenated keys', () => {
    const outcome = parse('name = "helper"\ndescription = "Helps."\nllm-provider = "deepseek-official"\nmax-depth = 2\n')
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.definition.llmProvider, 'deepseek-official')
    assert.equal(outcome.definition.maxDepth, 2)
  })

  it('rejects an unknown key instead of ignoring it', () => {
    const outcome = parse('name = "helper"\ndescription = "Helps."\npermissions = "full"\n')
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.match(outcome.failure.reason, /unknown key\(s\): permissions/)
  })

  it('requires name and description', () => {
    const outcome = parse('enabled = true\n')
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.match(outcome.failure.reason, /name is required/)
    assert.match(outcome.failure.reason, /description is required/)
  })

  it('rejects an invalid name', () => {
    const outcome = parse('name = "has space"\ndescription = "d"\n')
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.match(outcome.failure.reason, /name must start with a letter or digit/)
  })

  it('rejects an unknown mode', () => {
    const outcome = parse('name = "h"\ndescription = "d"\nmode = "background"\n')
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.match(outcome.failure.reason, /mode must be "one-shot" or "continuable"/)
  })

  it('rejects a negative depth and a fractional token cap', () => {
    const negative = parse('name = "h"\ndescription = "d"\nmax_depth = -1\n')
    assert.equal(negative.ok, false)
    if (!negative.ok) assert.match(negative.failure.reason, /max_depth must be a whole number/)
    const fractional = parse('name = "h"\ndescription = "d"\nmax_tokens = 1.5\n')
    assert.equal(fractional.ok, false)
    if (!fractional.ok) assert.match(fractional.failure.reason, /max_tokens must be a positive whole number/)
  })

  it('rejects max_depth 0, which can never allow the delegation', () => {
    const outcome = parse('name = "h"\ndescription = "d"\nmax_depth = 0\n')
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.match(outcome.failure.reason, /max_depth must be at least 1/)
  })

  it('rejects unknown keys inside the tools table', () => {
    const outcome = parse('name = "h"\ndescription = "d"\n\n[tools]\nallow = ["read"]\nmode = "deny"\n')
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.match(outcome.failure.reason, /tools has unknown key\(s\): mode/)
  })

  it('reports a TOML syntax error without throwing', () => {
    const outcome = parse('name = "unterminated\n')
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.match(outcome.failure.reason, /TOML parse error/)
    assert.equal(outcome.failure.file, 'C:/defs/reviewer.toml')
  })

  it('rejects a non-table document', () => {
    const outcome = parse('"just a string"\n')
    assert.equal(outcome.ok, false)
  })
})
