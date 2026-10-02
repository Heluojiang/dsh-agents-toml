/** Plugin orchestration: per-Agent installation, failure visibility, watching. */
import assert from 'node:assert/strict'
import { basename, dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'

import type { DiscoveryIo } from '../src/discovery.ts'
import type { AgentLike, ToolDefinition } from '../src/host.ts'
import { createPlugin, type PluginConfig } from '../src/plugin.ts'
import { createAgent, createFakeContext, createFakeSubagents, FULL_CAPABILITIES, type FakeContext } from './harness.ts'

const ROOT = resolve('fake-plugin-root')
const HOME = join(ROOT, 'home')
const USER_DIR = join(HOME, 'agents')
const PROJECT = join(ROOT, 'project')
const GIT_DIR = join(PROJECT, '.git')
const PROJECT_DIR = join(PROJECT, '.dsh', 'agents')

const delay = (ms: number): Promise<void> => new Promise(resolveTimer => { setTimeout(resolveTimer, ms) })

/** Mutable in-memory filesystem, so a test can add files while the plugin runs. */
class MemoryIo implements DiscoveryIo {
  readonly files = new Map<string, string>()
  readonly dirs = new Set<string>()

  mkdir(path: string): void {
    this.dirs.add(resolve(path))
  }

  write(path: string, text: string): void {
    const absolute = resolve(path)
    this.files.set(absolute, text)
    this.dirs.add(dirname(absolute))
  }

  listDefinitionFiles(dir: string): Promise<readonly string[]> {
    const root = resolve(dir)
    return Promise.resolve(
      [...this.files.keys()].filter(path => dirname(path) === root).map(path => basename(path)).sort(),
    )
  }

  readFile(file: string): Promise<string> {
    const text = this.files.get(resolve(file))
    return text === undefined ? Promise.reject(new Error(`ENOENT: ${file}`)) : Promise.resolve(text)
  }

  isDirectory(path: string): Promise<boolean> {
    return Promise.resolve(this.dirs.has(resolve(path)))
  }
}

interface Watch {
  readonly dir: string
  readonly change: () => void
  closed: boolean
}

interface Bench {
  readonly io: MemoryIo
  readonly fake: FakeContext
  readonly watches: Watch[]
}

/** Test-side configuration: a volatile setting may be given as a value or as its accessor. */
interface ConfigOverrides {
  trustProjectAgents?: boolean | (() => boolean)
  toolName?: string | (() => string)
  defaultProvider?: string
  projectAgentsDir?: string
  watchDefinitions?: boolean | (() => boolean)
  reportFailuresToModel?: boolean | (() => boolean)
  userAgentsDir?: string
}

/**
 * Normalize one setting for the plugin, which reads volatile settings through
 * the stable reference the Host updates in place.
 * @param value - plain value, accessor, or nothing.
 * @param fallback - value used when the test supplies neither.
 * @returns the accessor the plugin reads.
 */
function setting<T>(value: T | (() => T) | undefined, fallback: T): () => T {
  if (typeof value === 'function') return value as () => T
  return () => (value === undefined ? fallback : value)
}

function config(overrides: ConfigOverrides = {}): PluginConfig {
  return {
    trustProjectAgents: setting(overrides.trustProjectAgents, false),
    toolName: setting(overrides.toolName, 'subagent_custom'),
    defaultProvider: overrides.defaultProvider ?? 'spawn',
    projectAgentsDir: overrides.projectAgentsDir ?? '.dsh/agents',
    watchDefinitions: setting(overrides.watchDefinitions, true),
    reportFailuresToModel: setting(overrides.reportFailuresToModel, true),
    ...(overrides.userAgentsDir === undefined ? {} : { userAgentsDir: overrides.userAgentsDir }),
  }
}

function bench(overrides: ConfigOverrides = {}, debounceMs = 0): Bench {
  const io = new MemoryIo()
  const fake = createFakeContext(createFakeSubagents([{ name: 'spawn', capabilities: FULL_CAPABILITIES }]).service)
  const watches: Watch[] = []
  createPlugin(fake.ctx, config(overrides), {
    io,
    homeDir: HOME,
    debounceMs,
    watchDirectory(dir, onChange) {
      const entry: Watch = { dir, change: onChange, closed: false }
      watches.push(entry)
      return () => { entry.closed = true }
    },
  })
  return { io, fake, watches }
}

function definition(name: string, extra = ''): string {
  return `name = "${name}"\ndescription = "${name} description"\n${extra}`
}

function enumOf(tool: ToolDefinition): readonly string[] | undefined {
  const parameters = tool.parameters as { properties: { agent_type: { enum?: string[] } } }
  return parameters.properties.agent_type.enum
}

async function created(fake: FakeContext, cwd = PROJECT): Promise<AgentLike> {
  const agent = createAgent(fake.ctx, cwd)
  await fake.emitCreated(agent)
  return agent
}

describe('createPlugin', () => {
  it('installs one tool for an Agent whose user definitions exist', async () => {
    const b = bench()
    b.io.mkdir(USER_DIR)
    b.io.write(join(USER_DIR, 'reviewer.toml'), definition('reviewer'))
    await created(b.fake)
    assert.equal(b.fake.tools.length, 1)
    assert.equal(b.fake.tools[0]?.definition.name, 'subagent_custom')
    assert.deepEqual(enumOf(b.fake.tools[0]!.definition), ['reviewer'])
    assert.ok(b.fake.logs.some(entry => entry.level === 'info' && /installed 1 subagent definition\(s\)/.test(entry.message)))
  })

  it('installs for an Agent that already existed when the plugin activated', async () => {
    // A one-shot runner creates its Agent while it activates, so the row can be
    // mounted after that Agent's `agent/created` already fired.
    const io = new MemoryIo()
    io.mkdir(USER_DIR)
    io.write(join(USER_DIR, 'reviewer.toml'), definition('reviewer'))
    const fake = createFakeContext(createFakeSubagents([{ name: 'spawn', capabilities: FULL_CAPABILITIES }]).service)
    const agent = createAgent(fake.ctx, PROJECT)
    fake.registry.push(agent)

    createPlugin(fake.ctx, config(), { io, homeDir: HOME, debounceMs: 0 })
    await delay(0)

    assert.equal(fake.tools.length, 1)
    assert.deepEqual(enumOf(fake.tools[0]!.definition), ['reviewer'])
  })

  it('registers nothing when no definition exists', async () => {
    const b = bench()
    await created(b.fake)
    assert.equal(b.fake.tools.length, 0)
  })

  it('ignores project definitions and says so when trust is off', async () => {
    const b = bench()
    b.io.mkdir(GIT_DIR)
    b.io.mkdir(PROJECT_DIR)
    b.io.write(join(PROJECT_DIR, 'explorer.toml'), definition('explorer'))
    await created(b.fake)
    assert.equal(b.fake.tools.length, 0)
    assert.ok(b.fake.logs.some(entry => entry.level === 'info' && /ignoring project definitions/.test(entry.message)))
  })

  it('uses trusted project definitions, overriding the user definition by name', async () => {
    const b = bench({ trustProjectAgents: true })
    b.io.mkdir(USER_DIR)
    b.io.mkdir(GIT_DIR)
    b.io.mkdir(PROJECT_DIR)
    b.io.write(join(USER_DIR, 'reviewer.toml'), definition('reviewer', 'provider = "spawn"\n'))
    b.io.write(join(PROJECT_DIR, 'reviewer.toml'), definition('reviewer', 'mode = "continuable"\n'))
    b.io.write(join(PROJECT_DIR, 'explorer.toml'), definition('explorer'))
    await created(b.fake)
    assert.equal(b.fake.tools.length, 1)
    assert.deepEqual(enumOf(b.fake.tools[0]!.definition), ['reviewer', 'explorer'])
    // The continuable project definition overrode the one-shot user definition,
    // so the installed description must carry the background-answer warning.
    assert.match(b.fake.tools[0]!.definition.description, /Background subagents \(reviewer\)/)
  })

  it('logs a broken definition without failing Agent creation or the other definitions', async () => {
    const b = bench()
    b.io.mkdir(USER_DIR)
    b.io.write(join(USER_DIR, 'reviewer.toml'), definition('reviewer'))
    b.io.write(join(USER_DIR, 'broken.toml'), 'name = "broken"\n')
    await created(b.fake)
    assert.equal(b.fake.tools.length, 1)
    assert.deepEqual(enumOf(b.fake.tools[0]!.definition), ['reviewer'])
    assert.ok(b.fake.logs.some(entry => entry.level === 'warn' && /broken\.toml.*description is required/.test(entry.message)))
  })

  it('disposes the Agent tool registration when the Agent is disposed', async () => {
    const b = bench()
    b.io.mkdir(USER_DIR)
    b.io.write(join(USER_DIR, 'reviewer.toml'), definition('reviewer'))
    const agent = await created(b.fake)
    b.fake.emitDisposed(agent)
    await delay(0)
    assert.equal(b.fake.fibers[0]?.disposed, true)
    assert.equal(b.fake.tools[0]?.disposed, true)
  })

  it('re-installs with the new definition set when a file appears', async () => {
    const b = bench({}, 1)
    b.io.mkdir(USER_DIR)
    b.io.write(join(USER_DIR, 'reviewer.toml'), definition('reviewer'))
    await created(b.fake)
    assert.equal(b.fake.tools.length, 1)
    assert.equal(b.watches[0]?.dir, USER_DIR)

    b.io.write(join(USER_DIR, 'explorer.toml'), definition('explorer'))
    b.watches[0]!.change()
    await delay(20)

    assert.equal(b.fake.tools.length, 2)
    assert.deepEqual(enumOf(b.fake.tools[1]!.definition), ['explorer', 'reviewer'])
    assert.equal(b.fake.tools[0]?.disposed, true)
  })

  it('does not watch when watching is disabled', async () => {
    const b = bench({ watchDefinitions: false })
    b.io.mkdir(USER_DIR)
    b.io.write(join(USER_DIR, 'reviewer.toml'), definition('reviewer'))
    await created(b.fake)
    assert.equal(b.fake.tools.length, 1)
    assert.equal(b.watches.length, 0)
  })

  it('re-reads the trust setting on every discovery, so a settings write applies without a remount', async () => {
    // The Host keeps one volatile reference per setting and updates it in place
    // when a settings form writes; nothing disposes and re-applies this row.
    let trusted = false
    const io = new MemoryIo()
    const fake = createFakeContext(createFakeSubagents([{ name: 'spawn', capabilities: FULL_CAPABILITIES }]).service)
    io.mkdir(USER_DIR)
    io.mkdir(GIT_DIR)
    io.mkdir(PROJECT_DIR)
    io.write(join(USER_DIR, 'reviewer.toml'), definition('reviewer'))
    io.write(join(PROJECT_DIR, 'explorer.toml'), definition('explorer'))
    createPlugin(fake.ctx, config({ trustProjectAgents: () => trusted }), { io, homeDir: HOME, debounceMs: 0 })

    await created(fake)
    assert.deepEqual(enumOf(fake.tools[0]!.definition), ['reviewer'])

    trusted = true
    await created(fake)
    assert.equal(fake.tools.length, 2)
    assert.deepEqual(enumOf(fake.tools[1]!.definition), ['reviewer', 'explorer'])
  })

  it('closes watchers when the plugin unloads', async () => {
    const b = bench()
    b.io.mkdir(USER_DIR)
    b.io.write(join(USER_DIR, 'reviewer.toml'), definition('reviewer'))
    await created(b.fake)
    assert.equal(b.watches.length, 1)
    for (const cleanup of b.fake.cleanups) cleanup()
    assert.equal(b.watches[0]?.closed, true)
  })

  it('serves each Agent from its own working directory', async () => {
    const b = bench({ trustProjectAgents: true })
    const otherProject = join(ROOT, 'other')
    const otherProjectDir = join(otherProject, '.dsh', 'agents')
    b.io.mkdir(USER_DIR)
    b.io.mkdir(GIT_DIR)
    b.io.mkdir(PROJECT_DIR)
    b.io.mkdir(join(otherProject, '.git'))
    b.io.mkdir(otherProjectDir)
    b.io.write(join(PROJECT_DIR, 'explorer.toml'), definition('explorer'))
    b.io.write(join(otherProjectDir, 'writer.toml'), definition('writer'))

    await created(b.fake, PROJECT)
    await created(b.fake, otherProject)

    assert.equal(b.fake.tools.length, 2)
    assert.deepEqual(enumOf(b.fake.tools[0]!.definition), ['explorer'])
    assert.deepEqual(enumOf(b.fake.tools[1]!.definition), ['writer'])
  })
})
