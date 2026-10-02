/**
 * Browser half of `dsh-agents-toml`: the plugin's configuration on its own page
 * in the Plugins list. The card registers into `plugins.bundle.config` keyed by
 * the bundle's package name, so it renders inside the installed bundle's page
 * (Plugins → Installed → this plugin) instead of as a standalone card in the
 * Official group, which `plugins.item` owns for official settings pages.
 *
 * The Host serves a form only for the fields it declares volatile, and the form
 * is addressed by the profile entry id (`dsh-agents-toml`), so this card edits
 * the same profile Cordis patch a user would edit by hand.
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
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Profile entry id whose configuration this card edits. */
export const ENTRY_ID = 'dsh-agents-toml'

/**
 * Package name of the bundle this client half belongs to: the key
 * `plugins.bundle.config` dispatches on. Spelled separately from
 * {@link ENTRY_ID} because one names a Host row's form and the other names the
 * installed bundle whose page carries it — and it **must equal the manifest's
 * `name`**, because the Plugins page dispatches the keyed slot by the package
 * name it read from `package.json`.
 */
export const BUNDLE_NAME = '@heluojiang/dsh-agents-toml'

/** Dictionary namespace owned by this plugin's client half. */
export const NS = 'settings.dsh-agents-toml'

/**
 * Services this card requires from the shell. The gateway installs each Remote
 * namespace as its own service (`remote.<namespace>`), so the inventory reads
 * need that name rather than a property on the gateway.
 */
export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.pluginManager']

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

/** Whether this profile runs Agent Teams, and whether the operator closed the warning. */
interface TeamWarningState {
  /** An Agent Teams bundle or one of its rows is enabled. */
  active: boolean
  /** The operator closed the warning in this browser. */
  dismissed: boolean
}

/** The unsupported-combination warning the card shows and can close. */
interface TeamWarningFace {
  hooks: {
    /** Warning projection the renderer binds to `useTeamWarning`. */
    teamWarning: SnapshotStore<TeamWarningState>
  }
  dismissTeamWarning: () => void
}

/** Data and callbacks the card's slot entry injects. */
interface CardFace extends SettingsFormActions, TeamWarningFace {
  hooks: {
    /** Card projection the renderer binds to `useCard`. */
    card: SnapshotStore<CardState>
    /** Warning projection the renderer binds to `useTeamWarning`. */
    teamWarning: SnapshotStore<TeamWarningState>
  }
}

/** Props the slot renderer derives for the card. */
interface CardProps extends SettingsFormActions, TeamWarningFace {
  /** `summary` renders the one-line description the Plugins list shows. */
  view?: string | undefined
  t: (key: LocaleKey) => string
  useCard: <S>(selector: (snapshot: CardState) => S) => S
  useTeamWarning: <S>(selector: (snapshot: TeamWarningState) => S) => S
}

/** Copy key of this plugin's dictionary. */
type LocaleKey =
  | 'description'
  | 'trustLabel' | 'trustHelp'
  | 'toolNameLabel' | 'toolNameHelp'
  | 'watchLabel' | 'watchHelp'
  | 'reportLabel' | 'reportHelp'
  | 'teamWarningTitle' | 'teamWarningBody' | 'teamWarningDismiss'
  | 'overridden' | 'reset' | 'invalid'
  | 'unavailable' | 'readOnly' | 'saveFailed' | 'save' | 'saving'

const zh: Record<LocaleKey, string> = {
  description: '在用户目录与项目目录的 TOML 文件里声明具名子代理。',
  trustLabel: '信任项目级定义',
  trustHelp: '开启后加载 <项目根>/.dsh/agents/*.toml。这些文件随仓库分发，请只对你自己信任的仓库开启。',
  toolNameLabel: '工具名',
  toolNameHelp: '模型看到的委派工具名。',
  watchLabel: '监听定义目录',
  watchHelp: '文件增删改后重装工具并刷新 agent_type 枚举。',
  reportLabel: '在工具描述里列出不可用定义',
  reportHelp: '让模型看到哪些定义被跳过以及原因。',
  teamWarningTitle: '检测到「智能体团队」已启用，本插件不与其组合使用',
  teamWarningBody: '官方团队组合包会禁用 tool-subagent-control 与 list_agents，并把官方委派工具换成队友工具（send_message 的参数是 target）。结果是 continuable 子代理无法追问、也取不回产出，同名工具的含义还会混淆。建议在「插件 → 官方」关闭「智能体团队」后再使用本插件。',
  teamWarningDismiss: '关闭提示',
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
  description: 'Declare named subagents in TOML files under the user and project directories.',
  trustLabel: 'Trust project definitions',
  trustHelp: 'Loads <projectRoot>/.dsh/agents/*.toml. Those files ship with a repository, so enable this only for repositories you trust.',
  toolNameLabel: 'Tool name',
  toolNameHelp: 'Delegation tool name the model sees.',
  watchLabel: 'Watch definition directories',
  watchHelp: 'Reinstall the tool and refresh the agent_type enum when files change.',
  reportLabel: 'List unavailable definitions in the tool description',
  reportHelp: 'Shows the model which definitions were skipped, and why.',
  teamWarningTitle: 'Agent Teams is enabled, and this plugin does not support that combination',
  teamWarningBody: 'The official Agent Teams bundle disables tool-subagent-control and list_agents, and replaces the official delegation tools with teammate tools (send_message then takes target). A continuable subagent can no longer be followed up or read back, and the overlapping tool names get confusing. Turn Agent Teams off under Plugins → Official before using this plugin.',
  teamWarningDismiss: 'Dismiss this warning',
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
   * @param team - the unsupported-combination warning this card shows.
   * @returns The card snapshot and staged write actions.
   */
  inject(team: TeamWarningFace): CardFace {
    return {
      hooks: { card: this.store, teamWarning: team.hooks.teamWarning },
      dismissTeamWarning: team.dismissTeamWarning,
      ...this.form.actions(),
    }
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
 * The unsupported-combination warning: Agent Teams replaces the delegation
 * control tools a continuable child needs, so the card says so in place and the
 * operator closes it. Colours come from the theme's error aliases, which is
 * what makes the strip red in both themes.
 * @param props - localized copy and the close callback.
 * @returns The warning strip.
 */
function TeamWarning(props: {
  title: string
  body: string
  dismissLabel: string
  onDismiss: () => void
}) {
  const edge = 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent)'
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        padding: '12px',
        borderRadius: '8px',
        border: `1px solid ${edge}`,
        background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 auto' }}>
        <strong style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{props.title}</strong>
        <p style={{ margin: '0' }}>{props.body}</p>
      </div>
      <button
        type="button"
        aria-label={props.dismissLabel}
        onClick={props.onDismiss}
        style={{ border: 'none', background: 'none', color: 'inherit', cursor: 'pointer', lineHeight: '1', padding: '2px' }}
      >
        ×
      </button>
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
  const warning = props.useTeamWarning(snapshot => snapshot)
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
        {warning.active && !warning.dismissed
          ? (
            <TeamWarning
              title={t('teamWarningTitle')}
              body={t('teamWarningBody')}
              dismissLabel={t('teamWarningDismiss')}
              onDismiss={props.dismissTeamWarning}
            />
          )
          : null}
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

/**
 * The one composition this plugin does not support: the official Agent Teams
 * bundle, which disables the delegation control tools a continuable child needs
 * and replaces the official delegation tools with teammate tools.
 *
 * The check lives in this file rather than a sibling module because a client
 * factory cannot require a sibling file: the shell hands one artifact to the
 * module table, and the build rejects a relative require.
 */

/** The optional bundle that turns Agent Teams on. */
const AGENT_TEAM_BUNDLE = '@deepseek-ai/dsh-experimental-agent-team-profile'

/**
 * Team rows that mean the same conflict when enabled: a profile can carry them
 * without the bundle, and any other bundle mounting these modules breaks the
 * control tools the same way.
 */
const AGENT_TEAM_MODULES: readonly string[] = [
  '@deepseek-ai/dsh-experimental-agent-team',
  '@deepseek-ai/dsh-experimental-tool-agent-team',
]

/** Bundle names that are an Agent Teams pack, first-party or not. */
const AGENT_TEAM_NAME = /(?:^|[/@-])agent-team(?:-profile)?$/u

/**
 * Browser-storage key remembering that the operator closed the warning. It
 * clears itself while Agent Teams is off, so turning the feature back on warns
 * again.
 */
const WARNING_KEY = 'dsh-agents-toml.agent-team-warning.v1'

/** One bundle as the plugin manager reports it. */
interface AgentTeamBundle {
  readonly name: string
  readonly enabled: boolean
}

/** One plugin row as the plugin manager reports it. */
interface AgentTeamPlugin {
  readonly moduleName: string
  readonly enabled: boolean
}

/**
 * Whether this profile runs Agent Teams.
 * @param bundles - bundles the Host reports.
 * @param plugins - plugin rows the Host reports.
 * @returns true when an Agent Teams bundle or one of its rows is enabled.
 */
function detectAgentTeam(
  bundles: readonly AgentTeamBundle[],
  plugins: readonly AgentTeamPlugin[],
): boolean {
  return bundles.some(bundle => bundle.enabled
    && (bundle.name === AGENT_TEAM_BUNDLE || AGENT_TEAM_NAME.test(bundle.name)))
    || plugins.some(plugin => plugin.enabled && AGENT_TEAM_MODULES.includes(plugin.moduleName))
}

/**
 * Reach the browser store without assuming it exists.
 * @returns the store, or undefined outside a browser that allows access.
 */
function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch (_blocked) {
    return undefined
  }
}

/**
 * Read the stored dismissal.
 * @returns whether the operator closed the warning in this browser.
 */
function readWarningDismissed(): boolean {
  return storage()?.getItem(WARNING_KEY) === '1'
}

/** Remember that the operator closed the warning in this browser. */
function writeWarningDismissed(): void {
  try {
    storage()?.setItem(WARNING_KEY, '1')
  } catch (_unavailable) {
    // A blocked or full store only costs one extra showing of the warning.
  }
}

/** Forget the dismissal, so a later Agent Teams enablement warns again. */
function clearWarningDismissed(): void {
  try {
    storage()?.removeItem(WARNING_KEY)
  } catch (_unavailable) {
    // A blocked store keeps the flag; the warning then stays closed.
  }
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
        /** Address of a keyed slot registration; list slots use `id` instead. */
        key?: string
        id?: string
        order?: number
        label?: () => string
        locale?: string
        inject?: () => CardFace
      },
      component: (props: CardProps) => unknown,
    ): () => void
  }
  /**
   * Gateway service. The plugin-manager namespace answers the same reads the
   * Plugins page performs, and is reached defensively: a deployment that
   * serves no settings card must not lose the card to a missing namespace.
   */
  remote?: {
    pluginManager?: {
      listBundles(): Promise<RemoteAnswer<readonly AgentTeamBundle[]>>
      listPlugins(): Promise<RemoteAnswer<readonly AgentTeamPlugin[]>>
    }
    $on?(event: string, listener: () => void): () => void
  }
}

/** One gateway answer: the value, or the failure the Host reported. */
type RemoteAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/**
 * Read one inventory from the gateway.
 * @param call - the namespace method to invoke.
 * @returns the value, or undefined when the answer failed or could not be read.
 */
async function readInventory<T>(
  call: () => Promise<RemoteAnswer<readonly T[]>>,
): Promise<readonly T[] | undefined> {
  try {
    const answer = await call()
    return answer.ok ? answer.value : undefined
  } catch (error) {
    // A rejected call is a transport problem, not an empty inventory.
    void error
    return undefined
  }
}

/**
 * Read the Host's bundle and row inventory and publish whether Agent Teams runs.
 *
 * A failed or unreadable read leaves the warning as it was instead of guessing;
 * turning Agent Teams off re-arms the dismissal so enabling it again warns
 * again.
 * @param ctx - the browser plugin context.
 * @param store - the warning projection the card reads.
 */
async function loadTeamConflict(ctx: ClientContext, store: SnapshotStore<TeamWarningState>): Promise<void> {
  const manager = ctx.remote?.pluginManager
  if (manager === undefined) return
  try {
    const bundles = await readInventory(() => manager.listBundles())
    const plugins = await readInventory(() => manager.listPlugins())
    if (bundles === undefined && plugins === undefined) return
    const active = detectAgentTeam(bundles ?? [], plugins ?? [])
    // Only an observed inventory can prove Agent Teams is off, and that is what
    // re-arms the warning.
    if (bundles !== undefined && !active) clearWarningDismissed()
    store.set({ active, dismissed: active ? readWarningDismissed() : false })
  } catch (error) {
    // An answer this build cannot read must not become an unhandled rejection.
    void error
  }
}

/**
 * Mount this plugin's configuration on its own bundle page while the Host
 * serves the entry's form, with a warning when the profile also runs Agent
 * Teams.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-agents-toml: dictionaries')
  const controller = new AgentTomlCardController(ctx.configForms.get<AgentTomlSettings>(ENTRY_ID))
  ctx.effect(() => () => { controller.dispose() }, 'dsh-agents-toml: form subscription')
  const teamWarning = createSnapshotStore<TeamWarningState>({ active: false, dismissed: readWarningDismissed() })
  const refresh = (): void => { void loadTeamConflict(ctx, teamWarning) }
  ctx.effect(() => {
    refresh()
    const stop = ctx.remote?.$on?.('plugin-manager/changed', refresh)
    return () => { stop?.() }
  }, 'dsh-agents-toml: agent team watch')
  const face = controller.inject({
    hooks: { teamWarning },
    dismissTeamWarning: () => {
      writeWarningDismissed()
      teamWarning.set({ active: teamWarning.getSnapshot().active, dismissed: true })
    },
  })
  ctx.effect(
    () => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: BUNDLE_NAME,
      locale: NS,
      inject: () => face,
    }, AgentTomlCard))),
    'dsh-agents-toml: bundle configuration page',
  )
}
