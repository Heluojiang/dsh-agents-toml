/**
 * Ambient declarations for the browser modules the client half consumes from
 * the Web shell's module table (`PLATFORM_MODULES` in
 * `@deepseek-ai/dsh-client-web/src/platform`). This package ships no runtime
 * dependency on them — the shell seeds React, React's JSX runtime,
 * `client/store`, and `ui-primitives` into the table the loader hands to a
 * client factory as `require` — so these declarations are the contract the
 * emitted artifact codes against.
 */

declare module 'react' {
  /** Stable identifier for accessibility wiring within one render. */
  export function useId(): string
}

declare module 'react/jsx-runtime' {
  /**
   * Create one element with a static children list.
   * @param type - component or intrinsic tag.
   * @param props - element properties.
   * @param key - optional reconciliation key.
   * @returns the element.
   */
  export function jsx(type: unknown, props: unknown, key?: unknown): unknown
  /**
   * Create one element with a dynamic children list.
   * @param type - component or intrinsic tag.
   * @param props - element properties.
   * @param key - optional reconciliation key.
   * @returns the element.
   */
  export function jsxs(type: unknown, props: unknown, key?: unknown): unknown
  export namespace JSX {
    /** One element produced by the runtime. */
    interface Element {}
    /** Intrinsic tags; a client plugin renders plain DOM around shared primitives. */
    interface IntrinsicElements {
      [name: string]: { children?: unknown; [prop: string]: unknown }
    }
  }
}

declare module '@deepseek-ai/dsh-client-store' {
  /** Observable projection a card reads through its bound hook. */
  export interface SnapshotStore<T> {
    /** @returns the current snapshot. */
    getSnapshot(): T
    /** Replace the snapshot and notify listeners. */
    set(snapshot: T): void
    /**
     * Observe snapshot replacements.
     * @param listener - invoked after each replacement.
     * @returns the disposer removing this listener.
     */
    subscribe(listener: () => void): () => void
  }

  /**
   * Create one bare observable the renderer can bind through an inject `hooks`
   * compartment member.
   * @param init - the initial snapshot.
   * @returns the store.
   */
  export function createSnapshotStore<T>(init: T): SnapshotStore<T>
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'

  /** What the model reads of one Host entry's form. */
  export interface SettingsFormScopeSnapshot<T> {
    status: 'loading' | 'ready' | 'unavailable'
    value: T | undefined
    base: unknown
    user: unknown
    writable: boolean
    revision: number | undefined
  }

  /** One path edit a save sends. */
  export type SettingsFormPathOp =
    | { op: 'set'; path: readonly string[]; value: unknown }
    | { op: 'unset'; path: readonly string[] }

  /** The entry form a card stages over. */
  export interface SettingsFormScope<T> {
    getSnapshot(): SettingsFormScopeSnapshot<T>
    subscribe(listener: () => void): () => void
    mutate(ops: readonly SettingsFormPathOp[], expectedRevision?: number): Promise<boolean>
  }

  /** The write one field's staged text performs. */
  export type SettingsFieldWrite = { kind: 'set'; value: unknown } | { kind: 'clear' }

  /** How one field converts between its stored value and its draft text. */
  export interface SettingsFieldSpec {
    field: string
    format: (value: unknown) => string
    parse: (text: string) => SettingsFieldWrite | undefined
  }

  /** One field as a card's control renders it. */
  export interface SettingsFieldState {
    text: string
    overridden: boolean
    invalid: boolean
  }

  /** Form state every plugin card shares. */
  export interface SettingsFormShell {
    available: boolean
    writable: boolean
    dirty: boolean
    invalid: boolean
    saving: boolean
    failed: boolean
  }

  /** The write actions every plugin card's slot entry injects. */
  export interface SettingsFormActions {
    edit: (field: string, text: string) => void
    resetField: (field: string) => void
    save: () => void
    discard: () => void
  }

  /** The frame's copy. */
  export interface SettingsFormLabels {
    unavailable: string
    readOnly: string
    saveFailed: string
    save: string
    saving: string
  }

  /** Form chrome shared by every settings page. */
  export interface SettingsFormProps {
    labels: SettingsFormLabels
    state: SettingsFormShell
    onSave: () => void
    onDiscard: () => void
    children: unknown
  }

  /**
   * A free-text field. An empty draft clears the field.
   * @param field - field name inside the namespace section.
   * @returns the field's conversion spec.
   */
  export function settingsTextField(field: string): SettingsFieldSpec

  /** Stages one card's edits over one settings namespace and writes them on save. */
  export class SettingsFormModel<T> {
    /**
     * @param scope - the shared configuration form for this card's entry.
     * @param specs - the section fields this card edits.
     */
    constructor(scope: SettingsFormScope<T>, specs: SettingsFieldSpec[])
    /**
     * Publish a projection of this form.
     * @param project - build the card's state from the form's current reads.
     * @returns the store the card's component reads.
     */
    bind<S>(project: () => S): SnapshotStore<S>
    /** @returns the form state every card shares. */
    shell(): SettingsFormShell
    /**
     * @param field - field name of a section field.
     * @returns the draft text, whether a save would leave an override, and whether it is invalid.
     */
    field(field: string): SettingsFieldState
    /** @returns the actions a card's slot entry injects. */
    actions(): SettingsFormActions
    /** Release accepted-value subscriptions. */
    dispose(): void
  }

  /**
   * Render one plugin's settings form.
   * @param props - the form's copy and state, its controls, and save and discard actions.
   * @returns the form element.
   */
  export function SettingsForm(props: SettingsFormProps): import('react/jsx-runtime').JSX.Element

  /**
   * Render one labelled value field with its reset and override affordances.
   * @param props - the field's state and the card's edit callbacks.
   * @returns the field element.
   */
  export function SettingsValueField(props: {
    id: string
    label: string
    help?: { label: string; content: unknown }
    overriddenLabel: string
    resetLabel: string
    invalidLabel: string
    numeric?: boolean
    disabled?: boolean
    text: string
    overridden: boolean
    invalid: boolean
    onEdit: (text: string) => void
    onReset: () => void
  }): import('react/jsx-runtime').JSX.Element

  /**
   * Render a toggle switch.
   * @param props.checked - the current state.
   * @param props.onChange - called with the state the click asks for.
   * @param props.label - localized accessible name.
   * @param props.disabled - whether the control refuses input.
   * @returns the switch element.
   */
  export function Switch(props: {
    checked: boolean
    onChange: (next: boolean) => void
    label: string
    disabled?: boolean
  }): import('react/jsx-runtime').JSX.Element
}
