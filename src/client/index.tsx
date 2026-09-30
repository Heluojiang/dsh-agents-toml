/**
 * Browser half of `dsh-agents-toml`: the plugin's settings card on the Plugins
 * page. The Host serves a form only for the fields it declares volatile, and
 * the form is addressed by the profile entry id (`dsh-agents-toml`), so this
 * card edits the same profile Cordis patch a user would edit by hand.
 *
 * One file on purpose: the shell serves one artifact per package
 * (`lib/client.js`), a client factory resolves shared modules through the
 * module table and cannot load a sibling chunk synchronously, and this package
 * builds with `tsc` alone — so the whole browser half compiles to exactly one
 * CommonJS file, which `scripts/build-client.mjs` wraps in the loader handoff.
 */

import { useId } from 'react'
import {
  SettingsForm, SettingsFormModel, SettingsValueField, Switch, settingsTextField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions,
  type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Profile entry id whose configuration this card edits. */
export const ENTRY_ID = 'dsh-agents-toml'

/** Dictionary namespace owned by this plugin's client half. */
export const NS = 'settings.dsh-agents-toml'

/** Services this card requires from the shell. */
export const inject = ['slots', 'locale', 'configForms']

/** Settings the Host serves for this entry. */
interface AgentTomlSettings {
  trustProjectAgents: boolean
  toolName: string
  watchDefinitions: boolean
  reportFailuresToModel: boolean
}

/** Effective values and drafts the card renders. */
interface CardState extends SettingsFormShell {
  trustProjectAgents: SettingsFieldState
  toolName: SettingsFieldState
  watchDefinitions: SettingsFieldState
  reportFailuresToModel: SettingsFieldState
}

/** Data and callbacks the card's slot entry injects. */
interface CardFace extends SettingsFormActions {
  hooks: {
    /** Card projection the renderer binds to `useCard`. */
    card: SnapshotStore<CardState>
  }
}

/** Props the slot renderer derives for the card. */
interface CardProps extends SettingsFormActions {
  /** `summary` renders the one-line description the Plugins list shows. */
  view?: string | undefined
  t: (key: LocaleKey) => string
  useCard: <S>(selector: (snapshot: CardState) => S) => S
}

/** Copy key of this plugin's dictionary. */
type LocaleKey =
  | 'title' | 'description'
  | 'trustLabel' | 'trustHelp'
  | 'toolNameLabel' | 'toolNameHelp'
  | 'watchLabel' | 'watchHelp'
  | 'reportLabel' | 'reportHelp'
  | 'overridden' | 'reset' | 'invalid'
  | 'unavailable' | 'readOnly' | 'saveFailed' | 'save' | 'saving'

const zh: Record<LocaleKey, string> = {
  title: '子代理定义（TOML）',
  description: '在用户目录与项目目录的 TOML 文件里声明具名子代理。',
  trustLabel: '信任项目级定义',
  trustHelp: '开启后加载 <项目根>/.dsh/agents/*.toml。这些文件随仓库分发，请只对你自己信任的仓库开启。',
  toolNameLabel: '工具名',
  toolNameHelp: '模型看到的委派工具名。',
  watchLabel: '监听定义目录',
  watchHelp: '文件增删改后重装工具并刷新 agent_type 枚举。',
  reportLabel: '在工具描述里列出不可用定义',
  reportHelp: '让模型看到哪些定义被跳过以及原因。',
  overridden: '已修改',
  reset: '恢复默认',
  invalid: '值无效',
  unavailable: '当前部署没有提供本插件的设置。',
  readOnly: '当前部署的设置为只读。',
  saveFailed: '保存未生效，请重试。',
  save: '保存',
  saving: '保存中…',
}

const en: Record<LocaleKey, string> = {
  title: 'Subagent definitions (TOML)',
  description: 'Declare named subagents in TOML files under the user and project directories.',
  trustLabel: 'Trust project definitions',
  trustHelp: 'Loads <projectRoot>/.dsh/agents/*.toml. Those files ship with a repository, so enable this only for repositories you trust.',
  toolNameLabel: 'Tool name',
  toolNameHelp: 'Delegation tool name the model sees.',
  watchLabel: 'Watch definition directories',
  watchHelp: 'Reinstall the tool and refresh the agent_type enum when files change.',
  reportLabel: 'List unavailable definitions in the tool description',
  reportHelp: 'Shows the model which definitions were skipped, and why.',
  overridden: 'Overridden',
  reset: 'Reset',
  invalid: 'Invalid value',
  unavailable: 'This deployment does not serve settings for this plugin.',
  readOnly: 'Settings are read-only in this deployment.',
  saveFailed: 'The save did not land; try again.',
  save: 'Save',
  saving: 'Saving…',
}

/**
 * A switch field: the Host resolves the schema default, so an absent stored
 * value still renders as the value the plugin runs with.
 * @param field - field name inside the entry's section.
 * @returns the field's conversion spec.
 */
function booleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: value => (value === true ? 'true' : 'false'),
    parse: (text) => {
      if (text === 'true') return { kind: 'set', value: true }
      if (text === 'false') return { kind: 'set', value: false }
      return undefined
    },
  }
}

/** Bind this plugin's four served fields to one staged settings form. */
class AgentTomlCardController {
  private readonly form: SettingsFormModel<AgentTomlSettings>
  private readonly store: SnapshotStore<CardState>

  /** @param scope - the Host's form for this profile entry. */
  constructor(scope: SettingsFormScope<AgentTomlSettings>) {
    this.form = new SettingsFormModel(scope, [
      booleanField('trustProjectAgents'),
      settingsTextField('toolName'),
      booleanField('watchDefinitions'),
      booleanField('reportFailuresToModel'),
    ])
    this.store = this.form.bind(() => ({
      ...this.form.shell(),
      trustProjectAgents: this.form.field('trustProjectAgents'),
      toolName: this.form.field('toolName'),
      watchDefinitions: this.form.field('watchDefinitions'),
      reportFailuresToModel: this.form.field('reportFailuresToModel'),
    }))
  }

  /**
   * Bind the card to the slot renderer.
   * @returns The card snapshot and staged write actions.
   */
  inject(): CardFace {
    return { hooks: { card: this.store }, ...this.form.actions() }
  }

  /** Release accepted-value subscriptions. */
  dispose(): void {
    this.form.dispose()
  }
}

/** One switch row: visible label, the control, and the sentence explaining it. */
function SwitchRow(props: {
  id: string
  label: string
  help: string
  checked: boolean
  disabled: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
        <span id={props.id}>{props.label}</span>
        <Switch checked={props.checked} onChange={props.onChange} label={props.label} disabled={props.disabled} />
      </div>
      <p style={{ margin: '0', opacity: '0.7' }}>{props.help}</p>
    </div>
  )
}

/**
 * Render the plugin's settings: what definitions load, the tool name the model
 * sees, and how failures reach it.
 * @param props - Locale, the card snapshot, and the staged write actions.
 * @returns The summary line, or the settings form.
 */
function AgentTomlCard(props: CardProps) {
  const { t } = props
  const state = props.useCard(snapshot => snapshot)
  const sectionId = useId()
  if (props.view === 'summary') return <>{t('description')}</>
  const disabled = !state.writable || state.saving
  return (
    <SettingsForm
      labels={{
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <SwitchRow id={`${sectionId}-trust`} label={t('trustLabel')} help={t('trustHelp')}
          checked={state.trustProjectAgents.text === 'true'} disabled={disabled}
          onChange={next => { props.edit('trustProjectAgents', next ? 'true' : 'false') }} />
        <SettingsValueField id={`${sectionId}-tool-name`} label={t('toolNameLabel')}
          help={{ label: t('toolNameLabel'), content: <p>{t('toolNameHelp')}</p> }}
          overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalid')}
          disabled={disabled} text={state.toolName.text} overridden={state.toolName.overridden}
          invalid={state.toolName.invalid}
          onEdit={text => { props.edit('toolName', text) }}
          onReset={() => { props.resetField('toolName') }} />
        <SwitchRow id={`${sectionId}-watch`} label={t('watchLabel')} help={t('watchHelp')}
          checked={state.watchDefinitions.text === 'true'} disabled={disabled}
          onChange={next => { props.edit('watchDefinitions', next ? 'true' : 'false') }} />
        <SwitchRow id={`${sectionId}-report`} label={t('reportLabel')} help={t('reportHelp')}
          checked={state.reportFailuresToModel.text === 'true'} disabled={disabled}
          onChange={next => { props.edit('reportFailuresToModel', next ? 'true' : 'false') }} />
      </div>
    </SettingsForm>
  )
}

/** Shell services this half reaches; the browser context is structural here. */
interface ClientContext {
  /**
   * Run a contribution for the plugin's lifetime.
   * @param callback - installs the contribution and returns its disposer.
   * @param description - effect label used by diagnostics.
   */
  effect(callback: () => (() => void) | void, description: string): void
  locale: {
    bind(namespace: string): (key: LocaleKey) => string
    register(namespace: string, dictionaries: { zh: Record<LocaleKey, string>; en: Record<LocaleKey, string> }): () => void
  }
  configForms: {
    get<T>(entryId: string): SettingsFormScope<T>
    whileServed(
      namespaces: readonly string[],
      register: (served: ReadonlySet<string>) => (() => void) | void,
    ): () => void
  }
  slots: {
    inject(name: string, register: () => () => void): () => void
    register(
      entry: {
        name: string
        id: string
        order: number
        label: () => string
        locale: string
        inject: () => CardFace
      },
      component: (props: CardProps) => unknown,
    ): () => void
  }
}

/**
 * Mount the settings card while the Host serves this plugin's form.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-agents-toml: dictionaries')
  const controller = new AgentTomlCardController(ctx.configForms.get<AgentTomlSettings>(ENTRY_ID))
  ctx.effect(() => () => { controller.dispose() }, 'dsh-agents-toml: form subscription')
  const face = controller.inject()
  ctx.effect(
    () => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
      name: 'plugins.item',
      id: ENTRY_ID,
      order: 60,
      label: () => t('title'),
      locale: NS,
      inject: () => face,
    }, AgentTomlCard))),
    'dsh-agents-toml: settings page',
  )
}
