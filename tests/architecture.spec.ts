/**
 * Architecture guards for this package: the promises the plugin makes about
 * itself, checked against the tree rather than trusted.
 *
 * 1. **The host half imports no `@deepseek-ai/dsh-*` package.** It talks to the
 *    Harness through the structural declarations in `src/host.ts` so it stays
 *    loadable across releases whose published types lag the runtime. A real
 *    import would turn that into a version pin.
 * 2. **The client half imports only modules the Web shell seeds into its module
 *    table**, and depends on none of them as packages: the loader hands the
 *    factory the table, so an npm dependency would be a second, unused copy.
 * 3. **One identity for the plugin.** The manifest name, the bundle patch row,
 *    the client bundle key, and the profile entry id must agree, because the
 *    Plugins page dispatches the card by package name and writes the form by
 *    entry id.
 * 4. **Exactly four served settings.** The Host serves a form for volatile
 *    fields only, so a fifth `.volatile()` would offer an edit the card does not
 *    render and the documentation does not describe.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { Config } from '../src/index.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

/** @param dir - directory to walk. @returns every `.ts`/`.tsx` file under it. */
function sources(dir: string): readonly string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) found.push(...sources(path))
    else if (/\.tsx?$/u.test(entry)) found.push(path)
  }
  return found
}

/**
 * @param file - TypeScript source.
 * @returns every module specifier it imports from.
 */
function imports(file: string): readonly string[] {
  const text = readFileSync(file, 'utf8')
  return [...text.matchAll(/^\s*(?:import|export)[^'\n]*from\s+'([^']+)'/gmu)].map(match => match[1] ?? '')
}

/** Module-table names the Web shell seeds for client plugins. */
const SHELL_MODULES: readonly string[] = [
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
  'react',
  'react/jsx-runtime',
]

describe('architecture', () => {
  it('imports no Harness package from the host half, so the structural host view stays the only binding', () => {
    const offenders: string[] = []
    for (const file of sources(join(root, 'src'))) {
      if (file.includes(`${join('src', 'client')}`)) continue
      for (const specifier of imports(file)) {
        if (specifier.startsWith('@deepseek-ai/dsh-')) offenders.push(`${relative(root, file)} -> ${specifier}`)
      }
    }
    assert.deepEqual(offenders, [])
  })

  it('resolves the client half only through the shell module table, and depends on none of it', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ])

    const offenders: string[] = []
    for (const file of sources(join(root, 'src/client'))) {
      if (file.endsWith('.d.ts')) continue
      for (const specifier of imports(file)) {
        if (specifier.startsWith('.')) continue
        if (!SHELL_MODULES.includes(specifier)) offenders.push(`${relative(root, file)} -> ${specifier}`)
        if (declared.has(specifier)) offenders.push(`${relative(root, file)} -> ${specifier} (declared dependency)`)
      }
    }
    assert.deepEqual(offenders, [])
  })

  it('names the plugin identically in the manifest, the patch, the client, and the entry id', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    const client = readFileSync(join(root, 'src/client/index.tsx'), 'utf8')

    assert.match(patch, new RegExp(`id: dsh-agents-toml\\n\\s+name: '${manifest.name.replace('/', '\\/')}'`, 'u'))
    assert.match(client, new RegExp(`export const BUNDLE_NAME = '${manifest.name.replace('/', '\\/')}'`, 'u'))
    assert.match(client, /export const ENTRY_ID = 'dsh-agents-toml'/u)
  })

  it('serves exactly the four settings the client card renders', () => {
    // `volatile` is the marker the Host reads to decide whether to serve a form
    // for a field, so this list is the set of edits the settings card can make.
    const fields: Record<string, { meta?: { volatile?: boolean } }> = Config.dict ?? {}
    const volatile = Object.entries(fields)
      .filter(([, field]) => field.meta?.volatile === true)
      .map(([field]) => field)
      .sort()
    assert.deepEqual(volatile, [
      'reportFailuresToModel',
      'toolName',
      'trustProjectAgents',
      'watchDefinitions',
    ])

    const client = readFileSync(join(root, 'src/client/index.tsx'), 'utf8')
    const list = /export const SETTINGS_FIELDS = \[([\s\S]*?)\] as const/u.exec(client)?.[1] ?? ''
    const rendered = [...list.matchAll(/'([A-Za-z]+)'/gu)].map(match => match[1] ?? '').sort()
    assert.deepEqual(rendered, volatile)
  })
})
