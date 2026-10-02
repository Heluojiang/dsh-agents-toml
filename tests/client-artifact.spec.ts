/**
 * Artifact-level checks for the client half: the emitted `lib/client.js` must
 * register through the Web shell's module-table handoff, stay self-contained,
 * and wire the settings card to the served form. The spec evaluates the real
 * artifact against a stub module table, so it needs no browser and no React.
 *
 * Run `npm test`, whose `pretest` rebuilds `lib/client.js`; the spec self-skips
 * while the artifact is absent (a clean checkout that has not built yet).
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const artifactUrl = new URL('../lib/client.js', import.meta.url)
const artifact = existsSync(artifactUrl) ? readFileSync(artifactUrl, 'utf8') : undefined

/** The manifest name: the module-table id and the `plugins.bundle.config` key. */
const PACKAGE_NAME = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string }).name

const ENTRY_ID = 'dsh-agents-toml'
const BUNDLE_NAME = PACKAGE_NAME
const NS = 'settings.dsh-agents-toml'
const FIELDS = ['trustProjectAgents', 'toolName', 'watchDefinitions', 'reportFailuresToModel']

/** One field spec recorded from the card's form model. */
interface RecordedSpec {
  field: string
  format: (value: unknown) => string
  parse: (text: string) => unknown
}

/** Minimal stand-in for `SettingsFormModel` that records what the card stages. */
class RecordingFormModel {
  static latest: RecordingFormModel | undefined
  readonly specs: RecordedSpec[]
  readonly scope: RecordingScope
  edits: [string, string][] = []
  resets: string[] = []
  saves = 0
  discards = 0
  disposed = false

  constructor(scope: RecordingScope, specs: RecordedSpec[]) {
    this.scope = scope
    this.specs = specs
    RecordingFormModel.latest = this
  }

  bind<S>(project: () => S): { getSnapshot: () => S } {
    return { getSnapshot: project }
  }

  shell(): Record<string, boolean> {
    return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
  }

  field(field: string): { text: string; overridden: boolean; invalid: boolean } {
    const spec = this.specs.find(candidate => candidate.field === field)
    assert.ok(spec !== undefined, `card asked for an undeclared field: ${field}`)
    return { text: spec.format(this.scope.value[field]), overridden: false, invalid: false }
  }

  actions(): Record<string, unknown> {
    return {
      edit: (field: string, text: string) => { this.edits.push([field, text]) },
      resetField: (field: string) => { this.resets.push(field) },
      save: () => { this.saves += 1 },
      discard: () => { this.discards += 1 },
    }
  }

  dispose(): void {
    this.disposed = true
  }
}

/** Form scope the Host would serve for this entry. */
interface RecordingScope {
  value: Record<string, unknown>
  mutate: (ops: unknown[]) => Promise<boolean>
}

/** Element produced by the stubbed JSX runtime. */
interface Element {
  type: unknown
  props: Record<string, unknown>
}

/** Registry of what the stubbed shell observed while the plugin applied. */
interface Observed {
  handoffId?: string
  module: Record<string, unknown>
  scope: RecordingScope
  dictionaries: Record<string, { zh: Record<string, string>; en: Record<string, string> }>
  effects: string[]
  slotInjections: string[]
  served: string[][]
  registrations: { entry: Record<string, unknown>; component: (props: never) => unknown }[]
  /** Events the artifact subscribed to on the gateway service. */
  remoteEvents: string[]
}

/** Fixtures for the plugin-manager reads the card performs. */
interface TeamFixtures {
  /** Bundles the stubbed Host reports. */
  readonly bundles?: readonly { name: string; enabled: boolean }[]
  /** Plugin rows the stubbed Host reports. */
  readonly plugins?: readonly { moduleName: string; enabled: boolean }[]
  /** Answer both reads with a gateway failure instead of a value. */
  readonly failReads?: boolean
}

/** Bundles that mean Agent Teams is on, and its off state. */
const TEAM_ON: TeamFixtures = { bundles: [{ name: '@deepseek-ai/dsh-experimental-agent-team-profile', enabled: true }] }
const TEAM_OFF: TeamFixtures = { bundles: [{ name: '@deepseek-ai/dsh-experimental-agent-team-profile', enabled: false }] }

/**
 * Evaluate the artifact exactly as the shell does: one loader call, whose
 * factory receives the shared module table as `require`.
 * @param fixtures - plugin-manager answers the card's warning reads.
 * @returns What the stubbed shell observed, plus the plugin's module exports.
 */
async function loadArtifact(fixtures: TeamFixtures = TEAM_OFF): Promise<Observed> {
  assert.ok(artifact !== undefined, 'client artifact is absent')
  const observed: Observed = {
    module: {},
    scope: {
      value: {
        trustProjectAgents: true,
        toolName: 'subagent_custom',
        watchDefinitions: true,
        reportFailuresToModel: false,
      },
      mutate: async () => true,
    },
    dictionaries: {},
    effects: [],
    slotInjections: [],
    served: [],
    registrations: [],
    remoteEvents: [],
  }
  const moduleTable: Record<string, unknown> = {
    'react': { useId: () => 'id-1' },
    'react/jsx-runtime': {
      jsx: (type: unknown, props: Record<string, unknown>): Element => ({ type, props }),
      jsxs: (type: unknown, props: Record<string, unknown>): Element => ({ type, props }),
    },
    '@deepseek-ai/dsh-client-store': {
      createSnapshotStore: <T>(init: T): { getSnapshot: () => T; set: (next: T) => void } => {
        let current = init
        return { getSnapshot: () => current, set: (next: T) => { current = next } }
      },
    },
    '@deepseek-ai/dsh-client-ui-primitives': {
      SettingsFormModel: RecordingFormModel,
      SettingsForm: (props: Record<string, unknown>): Element => ({ type: 'SettingsForm', props }),
      SettingsValueField: (props: Record<string, unknown>): Element => ({ type: 'SettingsValueField', props }),
      Switch: (props: Record<string, unknown>): Element => ({ type: 'Switch', props }),
      settingsTextField: (field: string): RecordedSpec => ({
        field,
        format: value => (typeof value === 'string' ? value : ''),
        parse: (text: string) => (text.trim() === '' ? { kind: 'clear' } : { kind: 'set', value: text.trim() }),
      }),
    },
  }
  const windowStub = {
    __ModuleLoader__: {
      load: (handoff: { id: string; factory: (require: (specifier: string) => unknown) => Record<string, unknown> }) => {
        observed.handoffId = handoff.id
        observed.module = handoff.factory((specifier) => {
          const entry = moduleTable[specifier]
          assert.ok(entry !== undefined, `client bundle requested a non-baseline module: ${specifier}`)
          return entry
        })
      },
    },
  }
  const ctx = {
    effect: (callback: () => (() => void) | void, description: string) => {
      observed.effects.push(description)
      callback()
    },
    locale: {
      bind: () => (key: string) => `t:${key}`,
      register: (namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }) => {
        observed.dictionaries[namespace] = dictionaries
        return () => {}
      },
    },
    configForms: {
      get: () => observed.scope,
      whileServed: (namespaces: readonly string[], register: (served: ReadonlySet<string>) => (() => void) | void) => {
        observed.served.push([...namespaces])
        register(new Set(namespaces))
        return () => {}
      },
    },
    slots: {
      inject: (name: string, register: () => () => void) => {
        observed.slotInjections.push(name)
        return register()
      },
      register: (entry: Record<string, unknown>, component: (props: never) => unknown) => {
        observed.registrations.push({ entry, component })
        return () => {}
      },
    },
    remote: {
      // The gateway answers with a `RemoteResult` envelope, not a bare array.
      pluginManager: {
        listBundles: async () => fixtures.failReads === true
          ? { ok: false as const, error: { code: 'unavailable', message: 'no host' } }
          : { ok: true as const, value: fixtures.bundles ?? [] },
        listPlugins: async () => fixtures.failReads === true
          ? { ok: false as const, error: { code: 'unavailable', message: 'no host' } }
          : { ok: true as const, value: fixtures.plugins ?? [] },
      },
      $on: (event: string, _listener: () => void) => {
        observed.remoteEvents.push(event)
        return () => {}
      },
    },
  }
  const run = new Function('window', artifact as string) as (window: unknown) => void
  run(windowStub)
  ;(observed.module.apply as (ctx: unknown) => void)(ctx)
  // The warning read is asynchronous; let the artifact publish its answer.
  await new Promise(resolve => setTimeout(resolve, 0))
  return observed
}

/**
 * Collect every element of one type from a rendered tree.
 * @param node - element, array, or scalar child.
 * @param type - `type` identity to collect.
 * @returns the matching elements.
 */
function collect(node: unknown, type: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(child => collect(child, type))
  if (typeof node !== 'object' || node === null) return []
  const element = node as Element
  if (element.type === type) return [element]
  // The stub runtime does not render function components; call them so the
  // walk reaches the tree a real renderer would produce.
  if (typeof element.type === 'function') {
    const rendered = (element.type as (props: Record<string, unknown>) => unknown)(element.props)
    return collect(rendered, type)
  }
  return collect(element.props?.['children'], type)
}

/**
 * Collect every element a predicate accepts, descending through function
 * components and matched elements alike. `collect` stops at the first element
 * of a requested type, which cannot reach a node nested inside a `div`.
 * @param node - element, array, or scalar child.
 * @param match - predicate over one element.
 * @returns the matching elements, outermost first.
 */
function collectWhere(node: unknown, match: (element: Element) => boolean): Element[] {
  if (Array.isArray(node)) return node.flatMap(child => collectWhere(child, match))
  if (typeof node !== 'object' || node === null) return []
  const element = node as Element
  if (typeof element.type === 'function') {
    return collectWhere((element.type as (props: Record<string, unknown>) => unknown)(element.props), match)
  }
  const found = match(element) ? [element] : []
  return [...found, ...collectWhere(element.props?.['children'], match)]
}

/** Props a real renderer derives for the card, bound to one loaded artifact. */
function cardProps(observed: Observed, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const registration = observed.registrations[0]
  assert.ok(registration !== undefined, 'the card registered no slot entry')
  const face = (registration.entry['inject'] as () => {
    hooks: {
      card: { getSnapshot: () => unknown }
      teamWarning: { getSnapshot: () => unknown }
    }
    edit: (field: string, text: string) => void
    resetField: (field: string) => void
    save: () => void
    discard: () => void
    dismissTeamWarning: () => void
  })()
  return {
    t: (key: string) => key,
    useCard: (selector: (snapshot: unknown) => unknown) => selector(face.hooks.card.getSnapshot()),
    useTeamWarning: (selector: (snapshot: unknown) => unknown) => selector(face.hooks.teamWarning.getSnapshot()),
    ...face,
    ...overrides,
  }
}

/**
 * Render the card the way the slot renderer would.
 * @param observed - one loaded artifact.
 * @param overrides - props replacing the derived ones (e.g. `view`).
 * @returns the rendered tree.
 */
function renderCard(observed: Observed, overrides: Record<string, unknown> = {}): unknown {
  const registration = observed.registrations[0]
  assert.ok(registration !== undefined)
  return (registration.component as unknown as (props: Record<string, unknown>) => unknown)(cardProps(observed, overrides))
}

/**
 * Count the Agent Teams warnings in one rendered tree.
 * @param rendered - the tree.
 * @returns how many alert strips the card rendered.
 */
function alertCount(rendered: unknown): number {
  return collectWhere(rendered, element => element.props['role'] === 'alert').length
}

/** Browser storage a test installs so the dismissal can persist. */
interface StubStorage {
  readonly items: Map<string, string>
}

/**
 * Install a `localStorage` the artifact can read and write.
 * @returns the storage handle to inspect.
 */
function installStorage(): StubStorage {
  const items = new Map<string, string>()
  const stub = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value) },
    removeItem: (key: string) => { items.delete(key) },
  }
  ;(globalThis as { localStorage?: unknown }).localStorage = stub
  return { items }
}

/** Remove the installed storage, restoring the no-storage path. */
function removeStorage(): void {
  delete (globalThis as { localStorage?: unknown }).localStorage
}

/** Key the artifact persists a closed warning under. */
const WARNING_KEY = 'dsh-agents-toml.agent-team-warning.v1'

test('the artifact registers one module through the loader handoff', { skip: artifact === undefined }, () => {
  assert.ok(artifact !== undefined)
  assert.match(artifact, new RegExp(`window\\.__ModuleLoader__\\.load\\(\\{ id: ${JSON.stringify(PACKAGE_NAME)}, factory: \\(require\\) => \\{`))
  assert.doesNotMatch(artifact, /require\((["'])\.\.?\//)
})

test('the served bundle addresses exactly one slot, keyed by its bundle', { skip: artifact === undefined }, () => {
  assert.ok(artifact !== undefined)
  // `plugins.item` would list this plugin in the Official group beside the
  // official settings pages; the contract sends a bundle's own configuration to
  // `plugins.bundle.config`, keyed by the bundle's package name.
  assert.match(artifact, /["']plugins\.bundle\.config["']/)
  assert.doesNotMatch(artifact, /plugins\.item/)
  assert.doesNotMatch(artifact, /plugins\.row\.config/)
  assert.doesNotMatch(artifact, /plugins\.detail\./)
})

test('the module exports the plugin protocol the shell loads', { skip: artifact === undefined }, async () => {
  const observed = await loadArtifact()
  assert.equal(observed.handoffId, PACKAGE_NAME)
  assert.deepEqual(observed.module.inject, ['slots', 'locale', 'configForms', 'remote', 'remote.pluginManager'])
  assert.equal(observed.module.NS, NS)
  assert.equal(observed.module.ENTRY_ID, ENTRY_ID)
  // The manifest name is the module-table id: a rename that misses here would
  // make the shell load the artifact under a name nothing requested.
  assert.equal(observed.module.BUNDLE_NAME, PACKAGE_NAME)
  assert.equal(typeof observed.module.apply, 'function')
})

test('the manifest name is the row name, the loader id, and the config key', { skip: artifact === undefined }, () => {
  assert.ok(artifact !== undefined)
  const row = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  // A row naming a package the manifest does not declare fails to import, and a
  // keyed config registration that disagrees with the package name never
  // renders on the bundle's page.
  assert.match(row, new RegExp(`name: '${PACKAGE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`))
  assert.match(artifact, new RegExp(`window\\.__ModuleLoader__\\.load\\(\\{ id: ${JSON.stringify(PACKAGE_NAME)}, factory:`))
})

test('apply registers dictionaries, the served form, and one bundle-page section', { skip: artifact === undefined }, async () => {
  const observed = await loadArtifact()
  const dictionary = observed.dictionaries[NS]
  assert.ok(dictionary !== undefined, 'the plugin registered no dictionary for its namespace')
  for (const key of [
    'description', 'trustLabel', 'trustHelp', 'save',
    'teamWarningTitle', 'teamWarningBody', 'teamWarningDismiss',
  ]) {
    assert.ok(dictionary.zh[key] !== undefined && dictionary.en[key] !== undefined, `dictionary is missing ${key}`)
  }
  assert.deepEqual(observed.served, [[ENTRY_ID]])
  // The Official group belongs to the official settings pages; this plugin's
  // configuration rides its own installed bundle page instead.
  assert.deepEqual(observed.slotInjections, ['plugins.bundle.config'])
  assert.equal(observed.registrations.length, 1)
  const entry = observed.registrations[0]?.entry
  assert.equal(entry?.['name'], 'plugins.bundle.config')
  assert.equal(entry?.['key'], BUNDLE_NAME)
  assert.equal(entry?.['id'], undefined)
  assert.equal(entry?.['locale'], NS)
  // The warning re-reads the inventory when the Plugins page changes a switch.
  assert.deepEqual(observed.remoteEvents, ['plugin-manager/changed'])
})

test('the card stages the four served fields as typed writes', { skip: artifact === undefined }, async () => {
  const observed = await loadArtifact()
  const model = RecordingFormModel.latest
  assert.ok(model !== undefined, 'the card built no form model')
  assert.deepEqual(model.specs.map(spec => spec.field), FIELDS)

  const trust = model.specs.find(spec => spec.field === 'trustProjectAgents')
  assert.ok(trust !== undefined)
  assert.deepEqual(trust.parse('true'), { kind: 'set', value: true })
  assert.deepEqual(trust.parse('false'), { kind: 'set', value: false })
  assert.equal(trust.parse('on'), undefined)
  assert.equal(trust.format(true), 'true')
  assert.equal(trust.format(undefined), 'false')

  const toolName = model.specs.find(spec => spec.field === 'toolName')
  assert.ok(toolName !== undefined)
  assert.deepEqual(toolName.parse(' reviewer '), { kind: 'set', value: 'reviewer' })
  assert.deepEqual(toolName.parse('  '), { kind: 'clear' })

  const face = cardProps(observed) as {
    hooks: { card: { getSnapshot: () => Record<string, { text: string }> } }
  }
  assert.equal(face.hooks.card.getSnapshot()['trustProjectAgents']?.text, 'true')
  assert.equal(face.hooks.card.getSnapshot()['reportFailuresToModel']?.text, 'false')
})

test('the rendered card reflects the served values and stages switch edits', { skip: artifact === undefined }, async () => {
  const observed = await loadArtifact()
  const rendered = renderCard(observed)
  const switches = collect(rendered, 'Switch')
  assert.equal(switches.length, 3, 'the card renders three switches')
  assert.equal(switches[0]?.props['checked'], true)
  assert.equal(switches[2]?.props['checked'], false)
  ;(switches[0]?.props['onChange'] as (next: boolean) => void)(false)
  assert.deepEqual(RecordingFormModel.latest?.edits, [['trustProjectAgents', 'false']])
  const valueFields = collect(rendered, 'SettingsValueField')
  assert.equal(valueFields.length, 1)
  assert.equal(valueFields[0]?.props['text'], 'subagent_custom')
})

test('the card warns while Agent Teams is enabled and stops once closed', { skip: artifact === undefined }, async () => {
  const observed = await loadArtifact(TEAM_ON)
  const rendered = renderCard(observed)
  assert.equal(alertCount(rendered), 1, 'an enabled Agent Teams bundle must raise one warning')
  const alert = collectWhere(rendered, element => element.props['role'] === 'alert')[0]
  assert.ok(alert !== undefined)
  const text = JSON.stringify(alert)
  assert.match(text, /teamWarningTitle/)
  assert.match(text, /teamWarningBody/)

  const close = collect(rendered, 'button')[0]
  assert.ok(close !== undefined, 'the warning renders no close control')
  assert.equal(close.props['aria-label'], 'teamWarningDismiss')
  ;(close.props['onClick'] as () => void)()
  assert.equal(alertCount(renderCard(observed)), 0, 'closing the warning hides it')
})

test('a team row or a third-party team pack is the same conflict', { skip: artifact === undefined }, async () => {
  const byRow = await loadArtifact({
    plugins: [{ moduleName: '@deepseek-ai/dsh-experimental-tool-agent-team', enabled: true }],
  })
  assert.equal(alertCount(renderCard(byRow)), 1)

  const thirdParty = await loadArtifact({ bundles: [{ name: '@acme/agent-team-profile', enabled: true }] })
  assert.equal(alertCount(renderCard(thirdParty)), 1)

  const disabledRow = await loadArtifact({
    plugins: [{ moduleName: '@deepseek-ai/dsh-experimental-tool-agent-team', enabled: false }],
  })
  assert.equal(alertCount(renderCard(disabledRow)), 0)
})

test('Agent Teams off leaves the card silent and intact', { skip: artifact === undefined }, async () => {
  const observed = await loadArtifact(TEAM_OFF)
  const rendered = renderCard(observed)
  assert.equal(alertCount(rendered), 0)
  assert.equal(collect(rendered, 'Switch').length, 3)
  assert.equal(collect(rendered, 'SettingsValueField').length, 1)
})

test('the list summary stays one line and carries no warning', { skip: artifact === undefined }, async () => {
  const observed = await loadArtifact(TEAM_ON)
  assert.equal(alertCount(renderCard(observed, { view: 'summary' })), 0)
})

test('closing persists, and turning Agent Teams off re-arms the warning', { skip: artifact === undefined }, async () => {
  const storage = installStorage()
  try {
    const first = await loadArtifact(TEAM_ON)
    const close = collect(renderCard(first), 'button')[0]
    assert.ok(close !== undefined)
    ;(close.props['onClick'] as () => void)()
    assert.equal(storage.items.get(WARNING_KEY), '1')

    // A later visit in the same browser stays quiet.
    assert.equal(alertCount(renderCard(await loadArtifact(TEAM_ON))), 0)

    // Turning Agent Teams off clears the choice, so enabling it again warns.
    assert.equal(alertCount(renderCard(await loadArtifact(TEAM_OFF))), 0)
    assert.equal(storage.items.has(WARNING_KEY), false)
    assert.equal(alertCount(renderCard(await loadArtifact(TEAM_ON))), 1)
  } finally {
    removeStorage()
  }
})

test('the warning works without browser storage and survives a failed read', { skip: artifact === undefined }, async () => {
  // No storage is installed here: closing still hides the strip for this visit.
  const observed = await loadArtifact(TEAM_ON)
  const close = collect(renderCard(observed), 'button')[0]
  assert.ok(close !== undefined)
  ;(close.props['onClick'] as () => void)()
  assert.equal(alertCount(renderCard(observed)), 0)
})

test('a failed gateway read raises no warning and no unhandled rejection', { skip: artifact === undefined }, async () => {
  const rejections: unknown[] = []
  const onRejection = (reason: unknown): void => { rejections.push(reason) }
  process.on('unhandledRejection', onRejection)
  try {
    const observed = await loadArtifact({ ...TEAM_ON, failReads: true })
    assert.equal(alertCount(renderCard(observed)), 0)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(rejections, [], 'an unreadable inventory must stay inside the plugin')
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})
