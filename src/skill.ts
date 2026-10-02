/**
 * The packaged skill: a model-facing authoring guide for this plugin's TOML
 * definitions.
 *
 * The guide ships inside the package (`assets/skill/SKILL.md`) and is published
 * through `ctx.skills`, so after installation the model finds it in the session
 * skill catalog, loads it with the `skill` tool, and follows it to write a
 * definition the user asked for in natural language. The contribution is
 * optional: a composition without the skills service, or a package whose asset
 * is missing, must leave delegation untouched.
 * @module dsh-agents-toml/skill
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import type { SkillCandidateLike, SkillDefinitionLike, SkillProviderLike } from './host.ts'

/** Provider name this plugin registers its skill under. */
export const SKILL_PROVIDER = 'dsh-agents-toml'

/** Skill name the catalog lists, and the name `skill` loads. */
export const SKILL_NAME = 'dsh-agents-toml'

/**
 * Rank of a packaged skill. The Harness orders its own bundled skills at
 * `BUNDLED_SKILL_RANK = 600`, and a local skill with a lower rank outranks a
 * packaged one; duplicate names inside one layer order by rank first.
 */
export const SKILL_RANK = 600

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u

/** Absolute asset locations, derivable from either the source or the built module. */
export interface SkillAssets {
  /** Absolute path of the instruction file. */
  readonly instructionFile: string
  /** Absolute directory the body's relative references resolve against. */
  readonly resourceRoot: string
}

/**
 * Default asset location: `assets/skill/SKILL.md`, resolved relative to this
 * module. Both `src/skill.ts` and the emitted `lib/skill.js` sit one level
 * below the package root, so the same expression holds for a source run, a
 * built run, and a package installed from git.
 */
export const DEFAULT_SKILL_ASSETS: SkillAssets = {
  instructionFile: fileURLToPath(new URL('../assets/skill/SKILL.md', import.meta.url)),
  resourceRoot: fileURLToPath(new URL('..', import.meta.url)),
}

/** The instruction file's frontmatter plus its body, without the delimiters. */
export interface SkillAsset {
  /** Declared skill name, when the file carries one. */
  readonly name?: string
  /** Short routing description shown by the catalog. */
  readonly description: string
  /** Optional extra routing guidance carried in the summary. */
  readonly whenToUse?: string
  /** Markdown body the model receives. */
  readonly content: string
}

/**
 * Read one `key: value` frontmatter field.
 * @param frontmatter - the block between the `---` delimiters.
 * @param key - field name to read.
 * @returns the unquoted value, or `undefined` when the field is absent or empty.
 */
function frontmatterValue(frontmatter: string, key: string): string | undefined {
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/.exec(line)
    if (match?.[1] !== key) continue
    const raw = match[2]?.trim() ?? ''
    const unquoted = /^(['"])(.*)\1$/.exec(raw)?.[2] ?? raw
    return unquoted.length === 0 ? undefined : unquoted
  }
  return undefined
}

/**
 * Split one instruction file into its frontmatter fields and body.
 * @param raw - file content.
 * @param path - path used in diagnostics.
 * @returns the parsed asset.
 */
export function parseSkillAsset(raw: string, path: string): SkillAsset {
  const frontmatter = FRONTMATTER.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`dsh-agents-toml: ${path} has no YAML frontmatter`)
  const description = frontmatterValue(frontmatter[1], 'description')
  if (description === undefined) throw new Error(`dsh-agents-toml: ${path} has no description`)
  const whenToUse = frontmatterValue(frontmatter[1], 'whenToUse')
  const declaredName = frontmatterValue(frontmatter[1], 'name')
  return {
    ...declaredName === undefined ? {} : { name: declaredName },
    description,
    ...whenToUse === undefined ? {} : { whenToUse },
    content: raw.slice(frontmatter[0].length).trim(),
  }
}

/**
 * Read the packaged asset synchronously, so the provider registers during
 * `apply` (registry registration is synchronous).
 *
 * A `name` in the frontmatter must match {@link SKILL_NAME}: the registry takes
 * the name from here, so a file that disagrees with it would list under a name
 * the file does not claim.
 * @param assets - absolute asset locations.
 * @returns the parsed asset.
 */
export function readSkillAsset(assets: SkillAssets = DEFAULT_SKILL_ASSETS): SkillAsset {
  const asset = parseSkillAsset(readFileSync(assets.instructionFile, 'utf8'), assets.instructionFile)
  if (asset.name !== undefined && asset.name !== SKILL_NAME) {
    throw new Error(
      `dsh-agents-toml: ${assets.instructionFile} declares skill name "${asset.name}", `
      + `but this build registers "${SKILL_NAME}"`,
    )
  }
  return asset
}

function candidateOf(asset: SkillAsset, assets: SkillAssets): SkillCandidateLike {
  return {
    name: SKILL_NAME,
    description: asset.description,
    ...asset.whenToUse === undefined ? {} : { whenToUse: asset.whenToUse },
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: SKILL_PROVIDER,
    resourceBase: { kind: 'directory', path: assets.resourceRoot },
    rank: SKILL_RANK,
    locator: assets.instructionFile,
  }
}

/**
 * Build the provider that serves the packaged guide.
 * @param assets - absolute asset locations.
 * @param asset - already parsed asset, used to keep listing free of disk reads.
 * @returns the provider.
 */
export function createSkillProvider(assets: SkillAssets, asset: SkillAsset): SkillProviderLike {
  return {
    name: SKILL_PROVIDER,
    list: () => Promise.resolve([candidateOf(asset, assets)]),
    async get(candidate, options) {
      // Re-read the body so an edited asset is served without re-registering,
      // and so the frontmatter never reaches the model twice.
      const raw = await readFile(String(candidate.locator), { encoding: 'utf8', signal: options.signal })
      const parsed = parseSkillAsset(raw, String(candidate.locator))
      const { rank: _rank, locator: _locator, ...summary } = candidate
      const loaded: SkillDefinitionLike = { ...summary, content: parsed.content }
      return loaded
    },
  }
}
