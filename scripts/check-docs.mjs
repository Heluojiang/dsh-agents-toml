/**
 * Verify that every relative link in the user-facing documents resolves, and
 * that every same-document anchor names a heading that exists.
 *
 * The documentation tree is small but cross-linked (README ↔ guide/*), and a
 * renamed section or file used to break links silently. Absolute URLs and mail
 * links are out of scope: only links that point at a path in this repository are
 * checked. A bare `#anchor` is checked against this document's own headings —
 * those broke the same way (a retitled section leaves its nav entry pointing at
 * nothing) and a reader clicking one lands at the top of the page with no hint
 * that the link is stale.
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

/**
 * The anchor GitHub generates for a heading: lower-cased, spaces to hyphens, and
 * every character that is not a letter, digit, hyphen or underscore dropped.
 * @param heading - the heading text, without its `#` markers.
 * @returns the anchor slug.
 */
function slug(heading) {
  return heading.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/gu, '-')
}

/**
 * Every anchor a document defines, from its ATX headings.
 * @param text - the document.
 * @returns the anchor set.
 */
function anchorsOf(text) {
  const found = new Set()
  for (const match of text.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*$/gmu)) {
    if (match[1] !== undefined) found.add(slug(match[1]))
  }
  return found
}

const problems = []

for (const document of documents) {
  const text = readFileSync(document, 'utf8')
  const anchors = anchorsOf(text)
  for (const match of text.matchAll(link)) {
    const target = match[1]
    if (target === undefined) continue
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
    if (target.startsWith('#')) {
      // A bare anchor points inside this document, so it has to name a heading.
      const wanted = decodeURI(target.slice(1))
      if (!anchors.has(wanted)) problems.push(`${relative(root, document)} -> ${target} (no such heading)`)
      continue
    }
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
  console.error('check-docs: broken documentation links:')
  for (const problem of problems) console.error(`  ${problem}`)
  process.exitCode = 1
} else {
  console.log(`check-docs: ${documents.length} documents, all relative links and anchors resolve`)
}
