/**
 * Wrap the client half's CommonJS emit in the Web shell's module-table handoff.
 *
 * The shell serves one artifact per package (`lib/client.js`) and evaluates it
 * expecting a single registration — `window.__ModuleLoader__.load({ id, factory })`
 * — whose factory receives the shared module table as `require`. `tsc` emits the
 * CommonJS body (see `tsconfig.client.json`); this script adds the registration
 * and asserts the artifact stays self-contained, because a client factory cannot
 * load a sibling chunk synchronously.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const built = join(root, 'lib', 'client-build', 'index.js')
const target = join(root, 'lib', 'client.js')

const { name } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const sourceMapTrailer = /\n?\/\/# sourceMappingURL=[^\n]*\n?$/
const body = readFileSync(built, 'utf8').replace(sourceMapTrailer, '').trimEnd()

const relativeRequire = /require\((["'])\.\.?\//
if (relativeRequire.test(body)) {
  throw new Error('client bundle: the factory emitted a relative require; a client factory cannot load a sibling chunk synchronously')
}
if (body.includes('__ModuleLoader__')) {
  throw new Error('client bundle: the compiled body already registers with the module loader')
}

const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {`
const intro = 'var module = { exports: {} }; var exports = module.exports;'
const footer = 'return module.exports; } });'

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, `${banner}\n${intro}\n${body}\n${footer}\n`)
rmSync(join(root, 'lib', 'client-build'), { recursive: true, force: true })
