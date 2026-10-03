/** The single delegation tool: schema, argument validation, and run mapping. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AgentDefinition, DefinitionFailure } from '../src/definitions.ts'
import type { DiscoveryResult } from '../src/discovery.ts'
import type { AgentLike, SubagentResult, SubagentStartRequest, ToolDefinition } from '../src/host.ts'
import { buildDelegationTool } from '../src/tool.ts'
import { createAgent, createFakeContext, createFakeSubagents, FULL_CAPABILITIES, NO_CAPABILITIES } from './harness.ts'

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

function discovery(definitions: readonly AgentDefinition[], failures: readonly DefinitionFailure[] = []): DiscoveryResult {
  return { definitions, failures, userDir: 'C:/home/.dsh/agents', projectRoot: undefined, watchedDirs: [] }
}

interface Bench {
  readonly tool: ToolDefinition
  readonly started: ReturnType<typeof createFakeSubagents>['started']
  readonly continuable: ReturnType<typeof createFakeSubagents>['continuable']
  readonly parent: AgentLike
  readonly exec: { agent: AgentLike; signal: AbortSignal }
}

function bench(
  definitions: readonly AgentDefinition[],
  options: {
    readonly failures?: readonly DefinitionFailure[]
    readonly providers?: Parameters<typeof createFakeSubagents>[0]
    readonly result?: SubagentResult
    readonly abort?: boolean
    readonly toolName?: string
    readonly defaultProvider?: string
    /** Definition names the install-time snapshot marked as inheriting the conversation. */
    readonly inheriting?: readonly string[]
    /** Host depth the installed tool reads at call time; omit for the runtime default. */
    readonly hostDepth?: () => number | undefined
  } = {},
): Bench {
  const fake = createFakeSubagents(
    options.providers ?? [{ name: 'spawn', capabilities: FULL_CAPABILITIES, continuable: true }],
    options.result === undefined ? {} : { result: options.result },
  )
  const context = createFakeContext(fake.service)
  const parent = createAgent(context.ctx, 'C:/work')
  const controller = new AbortController()
  if (options.abort === true) controller.abort()
  const tool = buildDelegationTool({
    toolName: options.toolName ?? 'subagent_custom',
    defaultProvider: options.defaultProvider ?? 'spawn',
    reportFailuresToModel: true,
    subagents: fake.service,
    hostDepth: options.hostDepth ?? (() => fake.hostDepth()),
    load: () => Promise.resolve(discovery(definitions, options.failures ?? [])),
    installedNames: definitions.filter(entry => entry.enabled).map(entry => entry.name),
    installedContinuable: definitions
      .filter(entry => entry.enabled && entry.mode === 'continuable')
      .map(entry => entry.name),
    installedInheriting: options.inheriting ?? [],
    installedFailures: options.failures ?? [],
  })
  return { tool, started: fake.started, continuable: fake.continuable, parent, exec: { agent: parent, signal: controller.signal } }
}

const ARGS = { agent_type: 'reviewer', description: 'review diff', prompt: 'review the diff' }

describe('tool schema', () => {
  it('exposes one tool with an agent_type enum and the three required fields', () => {
    const { tool } = bench([definition(), definition({ name: 'explorer' })])
    assert.equal(tool.name, 'subagent_custom')
    const parameters = tool.parameters as {
      properties: { agent_type: { enum: string[] } }
      required: string[]
    }
    assert.deepEqual(parameters.properties.agent_type.enum, ['reviewer', 'explorer'])
    assert.deepEqual(parameters.required, ['agent_type', 'description', 'prompt'])
    assert.match(tool.description, /Configured subagents: reviewer, explorer\./)
  })

  it('lists unavailable definitions only when asked to', () => {
    const failures: DefinitionFailure[] = [
      { file: 'C:/defs/x.toml', origin: 'user', name: 'writer', reason: 'child LLM routing is unsupported by this provider' },
    ]
    const reporting = bench([definition()], { failures }).tool
    assert.match(reporting.description, /Unavailable definitions: writer \(child LLM routing is unsupported by this provider\)/)
  })

  it('warns that a continuable subagent answers later than this call', () => {
    const oneShot = bench([definition()]).tool
    assert.doesNotMatch(oneShot.description, /Background subagents/)

    const mixed = bench([definition(), definition({ name: 'explorer', mode: 'continuable' })]).tool
    assert.match(mixed.description, /Background subagents \(explorer\) return only a child id/)
    assert.match(mixed.description, /the child's answer does not come back with this call\./)
  })

  it('describes an inheriting transport as one that already sees the conversation', () => {
    const ownContext = bench([definition()]).tool
    assert.match(ownContext.description, /works in its own context/)
    assert.doesNotMatch(ownContext.description, /already sees this conversation/)

    const inheriting = bench([definition()], { inheriting: ['reviewer'] }).tool
    assert.match(inheriting.description, /inheriting transport \(reviewer\) already sees this conversation's completed turns/)
    assert.match(inheriting.description, /works in its own context/)
  })

  it('renders the canonical text value', () => {
    const { tool } = bench([definition()])
    assert.deepEqual(tool.output.render({}, { text: 'hi' }), [{ type: 'text', text: 'hi' }])
    assert.deepEqual(tool.output.render({}, null), [{ type: 'text', text: '' }])
  })
})

describe('argument validation', () => {
  it('rejects missing or empty fields', async () => {
    const { tool, exec } = bench([definition()])
    await assert.rejects(() => tool.execute({ description: 'd', prompt: 'p' }, exec), /"agent_type" must be a non-empty string/)
    await assert.rejects(() => tool.execute({ agent_type: 'reviewer', description: '', prompt: 'p' }, exec), /"description" must be a non-empty string/)
    await assert.rejects(() => tool.execute('nope', exec), /arguments must be an object/)
  })
})

describe('delegation', () => {
  it('runs a one-shot child and disposes the run', async () => {
    const { tool, started, exec, parent } = bench([definition()])
    const value = await tool.execute(ARGS, exec)
    assert.deepEqual(value, { text: 'done' })
    assert.equal(started.length, 1)
    assert.equal(started[0]?.name, 'spawn')
    assert.equal(started[0]?.disposed, true)
    const request = started[0]?.request as SubagentStartRequest | undefined
    assert.equal(request?.label, 'review diff')
    assert.deepEqual(request.prompt, [{ type: 'text', text: 'review the diff' }])
    assert.equal(request.parent, parent)
    assert.equal(request.maxDepth, 1)
  })

  it('prefers the definition depth cap over the host setting', async () => {
    const { tool, started, exec } = bench([definition({ maxDepth: 0 })])
    await tool.execute(ARGS, exec)
    assert.equal(started[0]?.request.maxDepth, 0)
  })

  it('starts a continuable child and returns its id', async () => {
    const { tool, started, continuable, exec } = bench([definition({ mode: 'continuable' })])
    const value = await tool.execute(ARGS, exec)
    assert.deepEqual(value, { text: 'started subagent child-1' })
    assert.equal(started.length, 0)
    assert.equal(continuable.length, 1)
    assert.equal(continuable[0]?.provider, 'spawn')
    assert.equal(continuable[0]?.label, 'review diff')
    assert.equal('signal' in (continuable[0]?.request ?? {}), false)
  })

  it('reports a non-completed run as a tool error', async () => {
    const { tool, exec } = bench([definition()], {
      result: { output: [{ type: 'text', text: 'partial' }], diagnostic: 'boom', stopReason: 'error' },
    })
    await assert.rejects(() => tool.execute(ARGS, exec), /did not complete: error[\s\S]*boom[\s\S]*partial/)
  })

  it('names the configured subagents when the type is unknown', async () => {
    const { tool, exec } = bench([definition()])
    await assert.rejects(
      () => tool.execute({ ...ARGS, agent_type: 'nope' }, exec),
      /unknown subagent "nope"; configured subagents: reviewer/,
    )
  })

  it('explains why a failed definition is unavailable', async () => {
    const failures: DefinitionFailure[] = [
      { file: 'C:/defs/writer.toml', origin: 'project', name: 'writer', reason: 'persona is unsupported by this provider' },
    ]
    const { tool, exec } = bench([definition()], { failures })
    await assert.rejects(
      () => tool.execute({ ...ARGS, agent_type: 'writer' }, exec),
      /subagent "writer" is unavailable: persona is unsupported by this provider \(C:\/defs\/writer\.toml\)/,
    )
  })

  it('refuses a disabled definition', async () => {
    const { tool, exec } = bench([definition({ enabled: false })])
    await assert.rejects(() => tool.execute(ARGS, exec), /subagent "reviewer" is disabled/)
  })

  it('lists registered providers when the named one is absent', async () => {
    const { tool, exec } = bench([definition({ provider: 'codex' })], { providers: [{ name: 'spawn' }] })
    await assert.rejects(
      () => tool.execute(ARGS, exec),
      /names provider "codex", which is not registered; registered providers: spawn/,
    )
  })

  it('refuses a definition the transport cannot serve', async () => {
    const { tool, exec } = bench([definition({ provider: 'codex', model: 'm' })], {
      providers: [{ name: 'codex', capabilities: NO_CAPABILITIES }],
    })
    await assert.rejects(
      () => tool.execute(ARGS, exec),
      /cannot run on provider "codex": child LLM routing is unsupported by this provider/,
    )
  })

  it('runs an out-of-process definition that asks for no capability, sending no depth cap', async () => {
    // The Harness rejects any request carrying `maxDepth` on a provider without
    // `depthLimit`, so a plain definition must not carry the Host's default.
    const { tool, started, exec } = bench([definition({ provider: 'acp' })], {
      providers: [{ name: 'acp', capabilities: NO_CAPABILITIES }],
    })
    const value = await tool.execute(ARGS, exec)
    assert.deepEqual(value, { text: 'done' })
    assert.equal(started.length, 1)
    assert.equal(started[0]?.request.maxDepth, undefined)
  })

  it('returns a captured structured result as JSON text', async () => {
    const { tool, exec } = bench([definition({ outputSchema: { type: 'object' } })], {
      result: { output: [], structured: { summary: 'ok' }, stopReason: 'completed' },
    })
    const value = await tool.execute(ARGS, exec)
    assert.deepEqual(value, { text: '{\n  "summary": "ok"\n}' })
  })

  it('says so when a definition asked for a schema and the child produced none', async () => {
    const { tool, exec } = bench([definition({ outputSchema: { type: 'object' } })], {
      result: { output: [], structured: undefined, stopReason: 'error' },
    })
    await assert.rejects(
      () => tool.execute(ARGS, exec),
      /did not complete: error[\s\S]*did not produce a value for output_schema/,
    )
  })

  it('keeps the child text when it completed with both a schema value and prose', async () => {
    const { tool, exec } = bench([definition({ outputSchema: { type: 'object' } })], {
      result: { output: [{ type: 'text', text: 'note' }], structured: { summary: 'ok' }, stopReason: 'completed' },
    })
    const value = await tool.execute(ARGS, exec)
    assert.deepEqual(value, { text: '{\n  "summary": "ok"\n}\n\nnote' })
  })

  it('honours cancellation before starting a child', async () => {
    const { tool, started, exec } = bench([definition()], { abort: true })
    await assert.rejects(() => tool.execute(ARGS, exec))
    assert.equal(started.length, 0)
  })

  it('requires a calling agent', async () => {
    const { tool } = bench([definition()])
    await assert.rejects(
      () => tool.execute(ARGS, { signal: new AbortController().signal }),
      /requires a calling agent/,
    )
  })
})
