/**
 * Artifact-level checks for the client half: the emitted `lib/client.js` must
 * register through the Web shell's module-table handoff, stay self-contained,
 * and wire the settings card to the served form. The spec evaluates the real
 * artifact against a stub module table, so it needs no browser and no React.
 *
 * Run `npm run build:client` first; the spec self-skips while the artifact is
 * absent (a clean checkout has not built yet).
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const artifactUrl = new URL('../lib/client.js', import.meta.url)
const artifact = existsSync(artifactUrl) ? readFileSync(artifactUrl, 'utf8') : undefined

const ENTRY_ID = 'dsh-agents-toml'
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
}

/**
 * Evaluate the artifact exactly as the shell does: one loader call, whose
 * factory receives the shared module table as `require`.
 * @returns What the stubbed shell observed, plus the plugin's module exports.
 */
function loadArtifact(): Observed {
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
  }
  const moduleTable: Record<string, unknown> = {
    'react': { useId: () => 'id-1' },
    'react/jsx-runtime': {
      jsx: (type: unknown, props: Record<string, unknown>): Element => ({ type, props }),
      jsxs: (type: unknown, props: Record<string, unknown>): Element => ({ type, props }),
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
  }
  const run = new Function('window', artifact as string) as (window: unknown) => void
  run(windowStub)
  ;(observed.module.apply as (ctx: unknown) => void)(ctx)
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

test('the artifact registers one module through the loader handoff', { skip: artifact === undefined }, () => {
  assert.ok(artifact !== undefined)
  assert.match(artifact, /window\.__ModuleLoader__\.load\(\{ id: "dsh-agents-toml", factory: \(require\) => \{/)
  assert.doesNotMatch(artifact, /require\((["'])\.\.?\//)
})

test('the module exports the plugin protocol the shell loads', { skip: artifact === undefined }, () => {
  const observed = loadArtifact()
  assert.equal(observed.handoffId, ENTRY_ID)
  assert.deepEqual(observed.module.inject, ['slots', 'locale', 'configForms'])
  assert.equal(observed.module.NS, NS)
  assert.equal(observed.module.ENTRY_ID, ENTRY_ID)
  assert.equal(typeof observed.module.apply, 'function')
})

test('apply registers dictionaries, the served form, and one Plugins-page card', { skip: artifact === undefined }, () => {
  const observed = loadArtifact()
  const dictionary = observed.dictionaries[NS]
  assert.ok(dictionary !== undefined, 'the plugin registered no dictionary for its namespace')
  for (const key of ['title', 'trustLabel', 'trustHelp', 'save']) {
    assert.ok(dictionary.zh[key] !== undefined && dictionary.en[key] !== undefined, `dictionary is missing ${key}`)
  }
  assert.deepEqual(observed.served, [[ENTRY_ID]])
  assert.deepEqual(observed.slotInjections, ['plugins.item'])
  assert.equal(observed.registrations.length, 1)
  const entry = observed.registrations[0]?.entry
  assert.equal(entry?.['name'], 'plugins.item')
  assert.equal(entry?.['id'], ENTRY_ID)
  assert.equal(entry?.['locale'], NS)
  assert.equal((entry?.['label'] as () => string)(), 't:title')
})

test('the card stages the four served fields as typed writes', { skip: artifact === undefined }, () => {
  const observed = loadArtifact()
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

  const face = observed.registrations[0]?.entry['inject'] as () => {
    hooks: { card: { getSnapshot: () => Record<string, { text: string }> } }
    edit: (field: string, text: string) => void
    save: () => void
  }
  const bound = face()
  assert.equal(bound.hooks.card.getSnapshot()['trustProjectAgents']?.text, 'true')
  assert.equal(bound.hooks.card.getSnapshot()['reportFailuresToModel']?.text, 'false')
})

test('the rendered card reflects the served values and stages switch edits', { skip: artifact === undefined }, () => {
  const observed = loadArtifact()
  const registration = observed.registrations[0]
  assert.ok(registration !== undefined)
  const face = (registration.entry['inject'] as () => {
    hooks: { card: { getSnapshot: () => unknown } }
    edit: (field: string, text: string) => void
  })()
  const rendered = (registration.component as unknown as (props: Record<string, unknown>) => unknown)({
    t: (key: string) => key,
    useCard: (selector: (snapshot: unknown) => unknown) => selector(face.hooks.card.getSnapshot()),
    edit: face.edit,
    resetField: () => {},
    save: () => {},
    discard: () => {},
  })
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
