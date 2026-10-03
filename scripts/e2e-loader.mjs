// Keyless scenario: does a real Cordis Loader row behave the way the plugin
// claims, with no model in the loop?
//
// The plugin's settings are volatile fields, which the Loader commits in place
// instead of remounting the row. Nothing about that path is reachable from a
// plain unit test, so this scenario drives a genuine loader: it creates the row,
// creates an Agent, writes settings through `entry.update`, and inspects the
// tool definitions that reach `tools.register`.
//
// Exits 0 only when every check passes. Requires no credentials and no network.
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Run every check and return the failures. */
export async function runLoaderScenario({ dshRoot, pluginRoot, log = console.log }) {
  const dshRequire = createRequire(join(dshRoot, 'package.json'))
  const { Context } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/cordis')).href)
  const loaderPlugin = (await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/cordis-plugin-loader')).href)).default
  const pluginEntry = pathToFileURL(resolve(pluginRoot, 'lib/index.js')).href

  const results = []
  const check = (id, ok, detail) => {
    results.push({ id, ok, detail })
    log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`)
  }
  const settle = (ms = 300) => new Promise(done => setTimeout(done, ms))

  const sandbox = mkdtempSync(join(tmpdir(), 'dsh-agents-toml-e2e-'))
  const project = join(sandbox, 'project')
  const projectAgents = join(project, '.dsh', 'agents')
  mkdirSync(projectAgents, { recursive: true })
  // A project root is recognised by its marker directory, so the sandbox needs one.
  mkdirSync(join(project, '.git'), { recursive: true })
  writeFileSync(join(projectAgents, 'alpha.toml'), 'name = "alpha"\ndescription = "first role"\nmode = "one-shot"\n')
  writeFileSync(join(projectAgents, 'beta.toml'), 'name = "beta"\ndescription = "second role"\nmode = "continuable"\n')

  const ctx = new Context()
  await ctx.plugin(loaderPlugin)

  // Every tool definition the plugin handed to `tools.register`, in order. Later
  // entries are later installs, so the last one is what the model would see.
  const registrations = []
  ctx.provide('tools', {
    register: (definition) => {
      registrations.push(definition)
      return () => {}
    },
  })
  ctx.provide('subagents', {
    getProvider: name => (name === 'spawn'
      ? {
        name: 'spawn',
        capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
        inheritsParentContext: false,
      }
      : undefined),
    list: () => ['spawn'],
    start: () => Promise.resolve({ result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: () => Promise.resolve() }),
    startContinuable: () => Promise.resolve({ childId: 'child', messageId: 'message' }),
    resolveMaxDepth: () => 1,
  })
  ctx.provide('logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })

  const agent = { session: { header: { cwd: project } }, get ctx() { return ctx } }
  ctx.provide('agents', { list: () => [agent] })

  // A tool is released by disposing the fiber `ctx.inject` created for it, not by
  // calling the disposer `tools.register` returned, so a removal only shows on
  // that fiber. Without counting them, "the tool was removed" and "the tool was
  // never re-installed" look identical.
  let released = 0
  const inject = ctx.inject.bind(ctx)
  ctx.inject = (...args) => {
    const fiber = inject(...args)
    if (typeof fiber?.dispose === 'function') {
      const dispose = fiber.dispose.bind(fiber)
      fiber.dispose = async (...rest) => {
        released += 1
        return dispose(...rest)
      }
    }
    return fiber
  }

  const base = {
    trustProjectAgents: true,
    toolName: 'subagent_custom',
    defaultProvider: 'spawn',
    projectAgentsDir: '.dsh/agents',
    watchDefinitions: true,
    reportFailuresToModel: true,
    userAgentsDir: join(sandbox, 'home', 'agents'),
  }

  try {
    await ctx.loader.create({ id: 'e2e-row', name: pluginEntry, config: { ...base } })
    await ctx.loader.await()
    const entry = ctx.loader.resolve('e2e-row')
    ctx.emit('agent/created', { agent })
    await settle()

    const last = () => registrations.at(-1)
    const enumOf = () => last()?.parameters?.properties?.agent_type?.enum ?? null
    const hintOf = () => last()?.parameters?.properties?.agent_type?.description ?? ''

    check('project definitions install without a restart',
      enumOf()?.length === 2,
      `enum=${JSON.stringify(enumOf())}`)
    check('each definition description reaches the parameter hint',
      hintOf().includes('alpha — first role') && hintOf().includes('beta — second role'),
      'both descriptions appear in the agent_type hint')

    const before = registrations.length
    await entry.update({ config: { ...base, toolName: 'delegate_now' } })
    await ctx.loader.await()
    await settle()
    check('a volatile settings write re-installs the live Agent',
      registrations.length > before && last()?.name === 'delegate_now',
      `registrations ${before} -> ${registrations.length}, name=${last()?.name}`)
    check('the row is not remounted by a volatile-only write',
      entry.fiber?.state === 2,
      `fiber.state=${entry.fiber?.state} (2 = ACTIVE, the same fiber)`)

    const releasedBeforeOff = released
    const beforeOff = registrations.length
    await entry.update({ config: { ...base, toolName: 'delegate_now', trustProjectAgents: false } })
    await ctx.loader.await()
    await settle()
    check('turning trust off releases the tool immediately',
      released > releasedBeforeOff && registrations.length === beforeOff,
      `released ${releasedBeforeOff} -> ${released}, registrations stayed at ${beforeOff}`)

    await entry.update({ config: { ...base, toolName: 'delegate_now', trustProjectAgents: true } })
    await ctx.loader.await()
    await settle()
    check('turning trust back on installs from the empty state',
      registrations.length > beforeOff && enumOf()?.length === 2 && last()?.name === 'delegate_now',
      `registrations ${beforeOff} -> ${registrations.length}, enum=${JSON.stringify(enumOf())}`)

    // Two valid definitions of one name inside one directory name no winner, so
    // both are dropped and the reason reaches the model through the description.
    const beforeDuplicate = registrations.length
    writeFileSync(join(projectAgents, 'gamma.toml'), 'name = "alpha"\ndescription = "duplicate of alpha"\n')
    await entry.update({ config: { ...base, toolName: 'delegate_now' } })
    await ctx.loader.await()
    await settle(800)
    const afterDuplicate = registrations.length > beforeDuplicate ? last() : undefined
    check('a duplicate name drops both sides and states the reason',
      afterDuplicate !== undefined
      && afterDuplicate.parameters?.properties?.agent_type?.enum?.includes('alpha') !== true
      && afterDuplicate.description.includes('duplicate definition "alpha"'),
      `enum=${JSON.stringify(afterDuplicate?.parameters?.properties?.agent_type?.enum)}`)
    rmSync(join(projectAgents, 'gamma.toml'))

    await entry.update({ config: { ...base, toolName: 'delegate_now', watchDefinitions: false } })
    await ctx.loader.await()
    await settle()
    const withWatchOff = registrations.length
    writeFileSync(join(projectAgents, 'delta.toml'), 'name = "delta"\ndescription = "third role"\n')
    await settle(900)
    check('watchDefinitions off stops file-driven re-installs',
      registrations.length === withWatchOff,
      `registrations stayed at ${withWatchOff}`)

    await entry.update({ config: { ...base, toolName: 'delegate_now', watchDefinitions: true } })
    await ctx.loader.await()
    await settle(900)
    check('turning the watch back on picks the new file up',
      enumOf()?.includes('delta') === true,
      `enum=${JSON.stringify(enumOf())}`)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }

  return { results, failures: results.filter(entry => !entry.ok) }
}
