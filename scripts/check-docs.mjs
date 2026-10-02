/**
 * Verify that every relative link in the user-facing documents resolves.
 *
 * The documentation tree is small but cross-linked (README ↔ guide/*), and a
 * renamed section or file used to break links silently. Absolute URLs, bare
 * anchors, and mail links are out of scope: only links that point at a path in
 * this repository are checked.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const documents = [join(root, 'README.md')]
const guideDir = join(root, 'guide')
for (const entry of readdirSync(guideDir)) {
  if (entry.endsWith('.md')) documents.push(join(guideDir, entry))
}

const link = /\[[^\]]*\]\(([^)\s]+)\)/g
const problems = []

for (const document of documents) {
  const text = readFileSync(document, 'utf8')
  for (const match of text.matchAll(link)) {
    const target = match[1]
    if (target === undefined) continue
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue
    const path = target.split('#')[0]
    if (path === undefined || path.length === 0) continue
    const resolved = resolve(dirname(document), decodeURI(path))
    if (!existsSync(resolved)) {
      problems.push(`${relative(root, document)} -> ${target}`)
      continue
    }
    // A directory link must land on a file this repository actually tracks;
    // every documentation link in this package points at a file.
    if (statSync(resolved).isDirectory()) problems.push(`${relative(root, document)} -> ${target} (directory)`)
  }
}

if (problems.length > 0) {
  console.error('check-docs: broken relative links:')
  for (const problem of problems) console.error(`  ${problem}`)
  process.exitCode = 1
} else {
  console.log(`check-docs: ${documents.length} documents, all relative links resolve`)
}
