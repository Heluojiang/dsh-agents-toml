/**
 * The TOML definition format for one named subagent, and its validation.
 *
 * Every problem is reported as a failure record instead of a throw: one broken
 * file must not remove the other definitions, and the caller decides how the
 * failure becomes visible. Unknown keys and mistyped values fail loud rather
 * than being ignored.
 * @module dsh-agents-toml/definitions
 */
import { parse as parseToml } from 'smol-toml'

import type { ToolRestriction } from './host.ts'

/** Where a definition file was found. */
export type DefinitionOrigin = 'user' | 'project'

/** How the delegated child ends. */
export type DelegationMode = 'one-shot' | 'continuable'

/** One validated subagent definition. */
export interface AgentDefinition {
  /** `agent_type` value the model passes. */
  readonly name: string
  /** Model-facing selection hint. */
  readonly description: string
  /** Whether this definition may be delegated to. */
  readonly enabled: boolean
  readonly mode: DelegationMode
  /** Subagent transport name on `ctx.subagents`. */
  readonly provider?: string
  /** Child LLM route provider (`agentOptions.provider`). */
  readonly llmProvider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
  /** Per-child persona, shadowing the deployment persona for this child. */
  readonly persona?: string
  /** Absolute delegation-depth cap for the child this definition creates. */
  readonly maxDepth?: number
  /** Object-rooted JSON Schema returned as the child's structured result. */
  readonly outputSchema?: Record<string, unknown>
  readonly tools?: ToolRestriction
  /** Absolute path of the definition file. */
  readonly file: string
  readonly origin: DefinitionOrigin
}

/** One rejected definition file, kept for logs and call-time diagnostics. */
export interface DefinitionFailure {
  readonly file: string
  readonly origin: DefinitionOrigin
  /** Declared name, when the file got far enough to read one. */
  readonly name?: string
  readonly reason: string
}

/** Identity of the file a definition came from. */
export interface DefinitionSource {
  readonly file: string
  readonly origin: DefinitionOrigin
}

/** Result of parsing one definition file. */
export type ParseOutcome =
  | { readonly ok: true; readonly definition: AgentDefinition }
  | { readonly ok: false; readonly failure: DefinitionFailure }

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i

/**
 * Every key this format accepts, after hyphen normalization.
 *
 * This list is the accepted-key set AND the narrowed type of the table the
 * parser reads from, so a read of an unlisted key does not compile, and
 * `tests/definitions.spec.ts` proves each listed key reaches the definition.
 */
export const CANONICAL_KEYS = [
  'name',
  'description',
  'enabled',
  'mode',
  'provider',
  'llm_provider',
  'model',
  'reasoning_effort',
  'max_tokens',
  'persona',
  'max_depth',
  'output_schema',
  'tools',
] as const

/** One accepted key, spelled the way TOML spells it. */
export type CanonicalKey = typeof CANONICAL_KEYS[number]

const KNOWN_KEYS: ReadonlySet<string> = new Set<string>(CANONICAL_KEYS)

function isCanonicalKey(key: string): key is CanonicalKey {
  return KNOWN_KEYS.has(key)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Rebuild a parsed TOML value with plain prototypes.
 *
 * The parser returns null-prototype objects. The output schema is handed to the
 * Harness, whose lossless-JSON checks compare own properties and prototypes, so
 * a null-prototype table is normalized here rather than at the call site.
 * @param value - parsed TOML value.
 * @returns the same value built from `Object` and `Array`.
 */
function toPlain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toPlain)
  if (isRecord(value)) {
    const plain: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) plain[key] = toPlain(item)
    return plain
  }
  return value
}

function readString(value: unknown, field: string, problems: string[]): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    problems.push(`${field} must be a non-empty string`)
    return undefined
  }
  return value
}

function readPositiveInteger(value: unknown, field: string, problems: string[]): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    problems.push(`${field} must be a positive whole number`)
    return undefined
  }
  return value
}

function readDepth(value: unknown, field: string, problems: string[]): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    problems.push(`${field} must be a whole number of zero or more`)
    return undefined
  }
  if (value === 0) {
    problems.push(
      `${field} must be at least 1: the cap applies to the child being created, whose depth is at least 1, `
      + 'so 0 forbids the delegation itself',
    )
    return undefined
  }
  return value
}

function readStringArray(value: unknown, field: string, problems: string[]): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    problems.push(`${field} must be an array of non-empty tool names`)
    return undefined
  }
  const entries: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      problems.push(`${field} must be an array of non-empty tool names`)
      return undefined
    }
    entries.push(entry)
  }
  return entries
}

function readToolRestriction(value: unknown, problems: string[]): ToolRestriction | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    problems.push('tools must be a table with optional allow and deny arrays')
    return undefined
  }
  const unknown = Object.keys(value).filter(key => key !== 'allow' && key !== 'deny')
  if (unknown.length > 0) problems.push(`tools has unknown key(s): ${unknown.join(', ')}`)
  const allow = readStringArray(value['allow'], 'tools.allow', problems)
  const deny = readStringArray(value['deny'], 'tools.deny', problems)
  if (allow === undefined && deny === undefined) return undefined
  return {
    ...allow === undefined ? {} : { allow },
    ...deny === undefined ? {} : { deny },
  }
}

/**
 * Parse and validate one TOML definition file.
 * @param text - raw file content.
 * @param source - absolute path and origin of the file.
 * @returns the definition, or the single failure that rejected the file.
 */
export function parseDefinition(text: string, source: DefinitionSource): ParseOutcome {
  const fail = (reason: string, name?: string): ParseOutcome => ({
    ok: false,
    failure: { file: source.file, origin: source.origin, reason, ...name === undefined ? {} : { name } },
  })

  let parsed: unknown
  try {
    parsed = toPlain(parseToml(text))
  } catch (error) {
    return fail(`TOML parse error: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(parsed)) return fail('the file must contain a TOML table')

  const normalized = new Map<CanonicalKey, unknown>()
  const unknown: string[] = []
  for (const [key, value] of Object.entries(parsed)) {
    // Hyphens and underscores name the same key, so both spellings normalize
    // before the accepted-key check.
    const canonical = key.replaceAll('-', '_')
    if (isCanonicalKey(canonical)) normalized.set(canonical, value)
    else unknown.push(key)
  }
  if (unknown.length > 0) return fail(`unknown key(s): ${unknown.join(', ')}`)

  const problems: string[] = []
  const name = readString(normalized.get('name'), 'name', problems)
  if (name !== undefined && !NAME_PATTERN.test(name)) {
    problems.push('name must start with a letter or digit and contain only letters, digits, "_" or "-"')
  }
  const description = readString(normalized.get('description'), 'description', problems)
  if (name === undefined) problems.push('name is required')
  if (description === undefined) problems.push('description is required')

  const enabledValue = normalized.get('enabled')
  if (enabledValue !== undefined && typeof enabledValue !== 'boolean') problems.push('enabled must be a boolean')

  const modeValue = normalized.get('mode')
  if (modeValue !== undefined && modeValue !== 'one-shot' && modeValue !== 'continuable') {
    problems.push('mode must be "one-shot" or "continuable"')
  }

  const provider = readString(normalized.get('provider'), 'provider', problems)
  const llmProvider = readString(normalized.get('llm_provider'), 'llm_provider', problems)
  const model = readString(normalized.get('model'), 'model', problems)
  const reasoningEffort = readString(normalized.get('reasoning_effort'), 'reasoning_effort', problems)
  const maxTokens = readPositiveInteger(normalized.get('max_tokens'), 'max_tokens', problems)
  const persona = readString(normalized.get('persona'), 'persona', problems)
  const maxDepth = readDepth(normalized.get('max_depth'), 'max_depth', problems)
  const tools = readToolRestriction(normalized.get('tools'), problems)

  const outputSchema = normalized.get('output_schema')
  if (outputSchema !== undefined && !isRecord(outputSchema)) {
    problems.push('output_schema must be a TOML table holding an object-rooted JSON Schema')
  }

  if (problems.length > 0) return fail(problems.join('; '), name)

  return {
    ok: true,
    definition: {
      name: name as string,
      description: description as string,
      enabled: enabledValue === undefined ? true : enabledValue === true,
      mode: modeValue === 'continuable' ? 'continuable' : 'one-shot',
      ...provider === undefined ? {} : { provider },
      ...llmProvider === undefined ? {} : { llmProvider },
      ...model === undefined ? {} : { model },
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...persona === undefined ? {} : { persona },
      ...maxDepth === undefined ? {} : { maxDepth },
      ...isRecord(outputSchema) ? { outputSchema } : {},
      ...tools === undefined ? {} : { tools },
      file: source.file,
      origin: source.origin,
    },
  }
}
