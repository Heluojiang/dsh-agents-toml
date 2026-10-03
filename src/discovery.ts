/**
 * Definition discovery: the user directory and the project directory.
 *
 * User definitions (`<DSH_HOME>/agents/*.toml`) always load. Project
 * definitions (`<projectRoot>/.dsh/agents/*.toml`) load only when the
 * deployment opts in, because those files arrive with a `git clone`. A project
 * definition overrides a user definition of the same name; two definitions of
 * the same name inside one directory both fail, because there is no defensible
 * winner.
 * @module dsh-agents-toml/discovery
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { parseDefinition, type AgentDefinition, type DefinitionFailure, type DefinitionOrigin } from './definitions.ts'

/** Filesystem operations discovery needs; injectable for tests. */
export interface DiscoveryIo {
  listDefinitionFiles(dir: string): Promise<readonly string[]>
  readFile(file: string): Promise<string>
  isDirectory(path: string): Promise<boolean>
}

/** Filesystem-backed {@link DiscoveryIo}. */
export const nodeDiscoveryIo: DiscoveryIo = {
  async listDefinitionFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.toml'))
      .map(entry => entry.name)
      .sort()
  },
  readFile: file => readFile(file, 'utf8'),
  async isDirectory(path) {
    try {
      return (await stat(path)).isDirectory()
    } catch (error) {
      // Absence and "not a directory" are ordinary answers; a permission or I/O
      // failure is not, and must reach the caller as a failure record rather
      // than reading as an empty directory.
      if (isAbsence(error)) return false
      throw error
    }
  },
}

/** Whether a filesystem error means the path is simply not a directory here. */
function isAbsence(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** What discovery needs to locate definition directories. */
export interface DiscoveryRequest {
  /** Session working directory; absent when the Agent has none. */
  readonly cwd: string | undefined
  /** Harness home (`$DSH_HOME`, default `~/.dsh`). */
  readonly homeDir: string
  /** Project-relative definition directory, e.g. `.dsh/agents`. */
  readonly projectAgentsDir: string
  /** Whether project definitions may load at all. */
  readonly trustProjectAgents: boolean
  /** Absolute override for the user definition directory. */
  readonly userAgentsDir?: string | undefined
  readonly io?: DiscoveryIo
}

/** One discovery pass over the applicable directories. */
export interface DiscoveryResult {
  readonly definitions: readonly AgentDefinition[]
  readonly failures: readonly DefinitionFailure[]
  /** Absolute user definition directory. */
  readonly userDir: string
  /** Absolute project root, when a working directory exists. */
  readonly projectRoot: string | undefined
  /** Directories a watcher must observe for this result to stay current. */
  readonly watchedDirs: readonly string[]
}

interface LoadedDirectory {
  readonly definitions: readonly AgentDefinition[]
  readonly failures: readonly DefinitionFailure[]
}

async function loadDirectory(dir: string, origin: DefinitionOrigin, io: DiscoveryIo): Promise<LoadedDirectory> {
  try {
    if (!(await io.isDirectory(dir))) return { definitions: [], failures: [] }
  } catch (error) {
    return {
      definitions: [],
      failures: [{ file: dir, origin, reason: `cannot inspect directory: ${String(error)}` }],
    }
  }

  const definitions: AgentDefinition[] = []
  const failures: DefinitionFailure[] = []
  const byName = new Map<string, number[]>()

  let files: readonly string[]
  try {
    files = await io.listDefinitionFiles(dir)
  } catch (error) {
    return {
      definitions: [],
      failures: [{ file: dir, origin, reason: `cannot list definitions: ${String(error)}` }],
    }
  }

  for (const name of files) {
    const file = join(dir, name)
    let text: string
    try {
      text = await io.readFile(file)
    } catch (error) {
      failures.push({ file, origin, reason: `cannot read file: ${String(error)}` })
      continue
    }
    const outcome = parseDefinition(text, { file, origin })
    if (!outcome.ok) {
      failures.push(outcome.failure)
      continue
    }
    const indexes = byName.get(outcome.definition.name)
    if (indexes === undefined) byName.set(outcome.definition.name, [definitions.length])
    else indexes.push(definitions.length)
    definitions.push(outcome.definition)
  }

  // Only two VALID definitions of one name are a duplicate. A rejected file
  // that happens to declare the same name names no winner, so it must not
  // remove the valid definition the user can actually delegate to.
  const duplicated = new Set<string>()
  for (const [name, indexes] of byName) {
    if (indexes.length < 2) continue
    duplicated.add(name)
    const files = indexes.map(index => definitions[index]?.file ?? '')
    for (const index of indexes) {
      failures.push({
        file: files[index] ?? dir,
        origin,
        name,
        reason: `duplicate definition "${name}" in ${files.join(', ')}`,
      })
    }
  }
  return {
    definitions: definitions.filter(definition => !duplicated.has(definition.name)),
    failures,
  }
}

/**
 * Find the project root above `cwd`: the nearest ancestor holding `.git`,
 * falling back to `cwd` itself, which mirrors the Harness skill discovery.
 * @param cwd - absolute session working directory.
 * @param io - filesystem probe.
 * @returns the absolute project root.
 */
export async function findProjectRoot(cwd: string, io: DiscoveryIo = nodeDiscoveryIo): Promise<string> {
  let current = resolve(cwd)
  for (;;) {
    if (await io.isDirectory(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/**
 * Load every applicable definition, project overriding user by name.
 * @param request - directories, trust switch, and working directory.
 * @returns definitions, per-file failures, and the directories to watch.
 */
export async function discoverAgents(request: DiscoveryRequest): Promise<DiscoveryResult> {
  const io = request.io ?? nodeDiscoveryIo
  const userDir = resolve(request.userAgentsDir ?? join(request.homeDir, 'agents'))

  let projectRoot: string | undefined
  let rootFailure: DefinitionFailure | undefined
  if (request.cwd !== undefined) {
    try {
      projectRoot = await findProjectRoot(request.cwd, io)
    } catch (error) {
      rootFailure = { file: request.cwd, origin: 'project', reason: `cannot locate project root: ${String(error)}` }
    }
  }
  const projectDir = request.trustProjectAgents && projectRoot !== undefined
    ? resolve(projectRoot, request.projectAgentsDir)
    : undefined

  const user = await loadDirectory(userDir, 'user', io)
  const project = projectDir === undefined ? { definitions: [], failures: [] } : await loadDirectory(projectDir, 'project', io)

  const merged = new Map<string, AgentDefinition>()
  for (const definition of [...user.definitions, ...project.definitions]) merged.set(definition.name, definition)

  return {
    definitions: [...merged.values()],
    failures: [...rootFailure === undefined ? [] : [rootFailure], ...user.failures, ...project.failures],
    userDir,
    projectRoot,
    watchedDirs: [userDir, ...projectDir === undefined ? [] : [projectDir]],
  }
}
