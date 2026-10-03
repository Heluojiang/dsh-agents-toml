/** Plugin orchestration: per-Agent installation, failure visibility, watching. */
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import type { AgentLike, ToolDefinition } from '../src/host.ts'
import { createPlugin, resolveHomeDir, type PluginConfig } from '../src/plugin.ts'
import {
  createAgent,
  createFakeContext,
  createFakeSubagents,
  FULL_CAPABILITIES,
  MemoryIo,
  type FakeContext,
} from './harness.ts'

const ROOT = resolve('fake-plugin-root')
const HOME = join(ROOT, 'home')
const USER_DIR = join(HOME, 'agents')
const PROJECT = join(ROOT, 'project')
const GIT_DIR = join(PROJECT, '.git')
const PROJECT_DIR = join(PROJECT, '.dsh', 'agents')

const delay = (ms: number): Promise<void> => new Promise(resolveTimer => { setTimeout(resolveTimer, ms) })

/**
 * Wrap an in-memory filesystem so every read yields to the event loop, which is
 * what lets two installs for one Agent overlap.
 * @param io - the filesystem to delay.
 * @returns the yielding delegate.
 */
function slowIo(io: MemoryIo): MemoryIo {
  const yieldTurn = async <T>(work: () => Promise<T>): Promise<T> => {
    await Promise.resolve()
    return work()
  }
  return {
    files: io.files,
    dirs: io.dirs,
    mkdir: path => { io.mkdir(path) },
    write: (path, text) => { io.write(path, text) },
    remove: path => { io.remove(path) },
    listDefinitionFiles: dir => yieldTurn(() => io.listDefinitionFiles(dir)),
    readFile: file => yieldTurn(() => io.readFile(file)),
    isDirectory: path => yieldTurn(() => io.isDirectory(path)),
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
  readonly refused: string[]
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
  const refused: string[] = []
  createPlugin(fake.ctx, config(overrides), {
    io,
    homeDir: HOME,
    debounceMs,
    watchDirectory(dir, onChange) {
      // A directory that is not there yet has no watch to open, exactly as
      // `fs.watch` reports: the caller retries on the next install.
      if (!io.dirs.has(resolve(dir))) {
        refused.push(dir)
        return undefined
      }
      const entry: Watch = { dir, change: onChange, closed: false }
      watches.push(entry)
      return () => { entry.closed = true }
    },
  })
  return { io, fake, watches, refused }
}

function definition(name: string, extra = ''): string {
  return `name = "${name}"\ndescription = "${name} description"\n${extra}`
}

function enumOf(tool: ToolDefinition): readonly string[] | undefined {
  const parameters = tool.parameters as { properties: { agent_type: { enum?: string[] } } }
  return parameters.properties.agent_type.enum
}

describe('resolveHomeDir', () => {
  const original = process.env['DSH_HOME']
  afterEach(() => {
    if (original === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = original
  })

  /** @param value - the `DSH_HOME` value to install, or nothing to unset it. */
  function setHome(value?: string): void {
    if (value === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = value
  }

  it('falls back to ~/.dsh when the variable is absent or blank', () => {
    setHome(undefined)
    assert.equal(resolveHomeDir(), resolve(join(homedir(), '.dsh')))
    // A blank override must never resolve the home to the working directory.
    setHome('   ')
    assert.equal(resolveHomeDir(), resolve(join(homedir(), '.dsh')))
  })

  it('expands a tilde prefix against the OS home', () => {
    setHome('~/custom-agents')
    assert.equal(resolveHomeDir(), resolve(join(homedir(), 'custom-agents')))
  })

  it('resolves a relative path against the working directory', () => {
    setHome('relative-home')
    assert.equal(resolveHomeDir(), resolve('relative-home'))
  })

  it('keeps an absolute path, trailing separator included', () => {
    setHome('C:/harness-home/')
    assert.equal(resolveHomeDir(), resolve('C:/harness-home'))
  })
})

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

  it('closes watchers already open when watching is turned off', async () => {
    // The setting is read whenever a watch is opened, and turning it off must
    // release the watches that are already open rather than wait for a restart.
    let watching = true
    const b = bench({ watchDefinitions: () => watching })
    b.io.mkdir(USER_DIR)
    b.io.write(join(USER_DIR, 'reviewer.toml'), definition('reviewer'))
    await created(b.fake)
    assert.equal(b.watches.length, 1)

    watching = false
    await created(b.fake)
    assert.equal(b.watches[0]?.closed, true)
  })

  it('applies a settings write that reaches the row without restarting it', async () => {
    // A write touching only volatile fields does not remount the row: the Loader
    // commits the new value into the reference the plugin reads and announces the
    // change. Acting on that event is the only way a running session sees it; no
    // further Agent is created and no file changes.
    let watching = true
    const b = bench({ watchDefinitions: () => watching })
    b.io.mkdir(USER_DIR)
    b.io.write(join(USER_DIR, 'reviewer.toml'), definition('reviewer'))
    await created(b.fake)
    assert.equal(b.watches.length, 1)
    assert.equal(b.watches[0]?.closed, false)

    watching = false
    b.fake.emitVolatileUpdate([['watchDefinitions']])

    assert.equal(b.watches[0]?.closed, true)

    watching = true
    b.fake.emitVolatileUpdate([['watchDefinitions']])
    assert.equal(b.watches.length, 2)
    assert.equal(b.watches[1]?.closed, false)
  })

  it('leaves the watches alone when the write did not change what to watch', async () => {
    const b = bench()
    b.io.mkdir(USER_DIR)
    b.io.write(join(USER_DIR, 'reviewer.toml'), definition('reviewer'))
    await created(b.fake)

    b.fake.emitVolatileUpdate([['toolName'], ['reportFailuresToModel']])

    assert.equal(b.watches.length, 1)
    assert.equal(b.watches[0]?.closed, false)
  })

  it('opens the watch once a missing definition directory appears', async () => {
    // `fs.watch` reports ENOENT for a directory that does not exist yet, and
    // caching that attempt as if it were a watch would never observe the
    // directory that is created next.
    const b = bench()
    await created(b.fake)
    assert.deepEqual(b.refused, [USER_DIR])
    assert.equal(b.watches.length, 0)

    b.io.mkdir(USER_DIR)
    b.io.write(join(USER_DIR, 'reviewer.toml'), definition('reviewer'))
    await created(b.fake)
    assert.equal(b.watches.length, 1)
    assert.equal(b.watches[0]?.dir, USER_DIR)
    assert.equal(b.fake.tools.length, 1)
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

  it('serializes overlapping installs so one registration stays live', async () => {
    // Agent creation, the watcher, and the activation sweep can all ask for the
    // same Agent's install at once. Registering twice would be rejected as a
    // duplicate while the first registration leaked.
    const io = new MemoryIo()
    io.mkdir(USER_DIR)
    io.write(join(USER_DIR, 'reviewer.toml'), definition('reviewer'))
    const fake = createFakeContext(createFakeSubagents([{ name: 'spawn', capabilities: FULL_CAPABILITIES }]).service)
    createPlugin(fake.ctx, config(), { io: slowIo(io), homeDir: HOME, debounceMs: 0 })
    const agent = createAgent(fake.ctx, PROJECT)

    await Promise.all([fake.emitCreated(agent), fake.emitCreated(agent), fake.emitCreated(agent)])

    assert.equal(fake.tools.filter(entry => !entry.disposed).length, 1)
    assert.equal(fake.tools.filter(entry => entry.disposed).length, fake.tools.length - 1)
    assert.equal(
      fake.logs.some(entry => /already registered/.test(entry.message)),
      false,
      'a serialized install never collides with itself',
    )
  })

  it('registers nothing for an install that resolves after its Agent is disposed', async () => {
    const io = new MemoryIo()
    io.mkdir(USER_DIR)
    io.write(join(USER_DIR, 'reviewer.toml'), definition('reviewer'))
    const fake = createFakeContext(createFakeSubagents([{ name: 'spawn', capabilities: FULL_CAPABILITIES }]).service)
    createPlugin(fake.ctx, config(), { io: slowIo(io), homeDir: HOME, debounceMs: 0 })
    const agent = createAgent(fake.ctx, PROJECT)

    const creating = fake.emitCreated(agent)
    fake.emitDisposed(agent)
    await creating
    await delay(5)

    assert.deepEqual(fake.tools.filter(entry => !entry.disposed), [])
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
