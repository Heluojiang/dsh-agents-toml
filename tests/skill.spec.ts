/**
 * The packaged skill: registering the authoring guide with the skills service
 * and serving it through the provider contract. Registration is optional — a
 * composition without `skills`, or a package whose asset is missing, still
 * serves delegation.
 *
 * These specs drive `contributeSkill` directly: going through `apply` would run
 * the definition discovery against the machine's real `$DSH_HOME`.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { contributeSkill } from '../src/index.ts'
import {
  createSkillProvider, parseSkillAsset, readSkillAsset,
  DEFAULT_SKILL_ASSETS, SKILL_NAME, SKILL_PROVIDER, SKILL_RANK,
} from '../src/skill.ts'
import { createFakeContext, createFakeSubagents, FULL_CAPABILITIES } from './harness.ts'

/** A fake context with a skills service, without touching the filesystem. */
function bench(): ReturnType<typeof createFakeContext> {
  return createFakeContext(createFakeSubagents([{ name: 'spawn', capabilities: FULL_CAPABILITIES }]).service)
}

const signal = (): AbortSignal => new AbortController().signal

test('the packaged asset parses into a described body without its frontmatter', () => {
  const asset = readSkillAsset()
  assert.equal(asset.description.length > 0, true)
  assert.equal(asset.name, SKILL_NAME)
  assert.equal(asset.content.startsWith('---'), false)
  assert.match(asset.content, /agent_type/)
  assert.match(asset.content, /max_depth/)
})

test('the asset states how a continuable run reports back, since that decides the persona', () => {
  const { content } = readSkillAsset()
  // The settlement notice is what the parent actually receives, so the authoring
  // guide must say so where it describes the mode and where it tells the model
  // how to write the persona.
  assert.match(content, /settlement notice/)
  assert.match(content, /closing message/)
  assert.match(content, /## 4b\. Writing the `persona` for the mode you chose/)
})

test('a frontmatter name that disagrees with the registered one is rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-toml-skill-'))
  try {
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: some-other-skill\ndescription: hint\n---\nBody\n',
      'utf8',
    )
    assert.throws(
      () => readSkillAsset({ instructionFile: join(dir, 'SKILL.md'), resourceRoot: dir }),
      /declares skill name "some-other-skill"/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('frontmatter parsing reads quoted values and rejects what it cannot serve', () => {
  assert.throws(() => parseSkillAsset('---\nname: x\n---\nbody\n', 'x.md'), /has no description/)
  assert.throws(() => parseSkillAsset('body only\n', 'x.md'), /has no YAML frontmatter/)
  const asset = parseSkillAsset(
    '---\nname: x\ndescription: "Quoted routing hint."\nwhenToUse: use it\n---\nBody\n',
    'x.md',
  )
  assert.equal(asset.description, 'Quoted routing hint.')
  assert.equal(asset.whenToUse, 'use it')
  assert.equal(asset.content, 'Body')
})

test('the plugin registers one bundled provider in a context that injected skills', () => {
  const fake = bench()
  contributeSkill(fake.ctx)
  assert.equal(fake.skills.length, 1)
  assert.equal(fake.skills[0]?.provider.name, SKILL_PROVIDER)
  assert.equal(fake.fibers.some(fiber => fiber.services.includes('skills')), true)
})

test('the candidate carries every field the registry validates', async () => {
  const provider = createSkillProvider(DEFAULT_SKILL_ASSETS, readSkillAsset())
  const candidates = await provider.list({ signal: signal() })
  assert.equal(candidates.length, 1)
  const candidate = candidates[0]
  assert.ok(candidate !== undefined)
  assert.equal(candidate.name, SKILL_NAME)
  assert.match(candidate.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.equal(candidate.description, readSkillAsset().description)
  assert.equal(candidate.provider, SKILL_PROVIDER)
  assert.equal(candidate.source, 'bundled')
  assert.equal(candidate.rank, SKILL_RANK)
  assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
  assert.deepEqual(candidate.resourceBase, { kind: 'directory', path: DEFAULT_SKILL_ASSETS.resourceRoot })
})

test('loading the skill returns the body and never the frontmatter', async () => {
  const provider = createSkillProvider(DEFAULT_SKILL_ASSETS, readSkillAsset())
  const candidate = (await provider.list({ signal: signal() }))[0]
  assert.ok(candidate !== undefined)
  const loaded = await provider.get(candidate, { signal: signal() })
  assert.ok(loaded !== undefined)
  assert.equal(loaded.name, SKILL_NAME)
  assert.equal(loaded.description, candidate.description)
  assert.equal(loaded.content.includes('description:'), false)
  assert.match(loaded.content, /## 2\. Choose the directory/)
})

test('a missing asset is reported and contributes no skill', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-toml-skill-'))
  try {
    const fake = bench()
    contributeSkill(fake.ctx, { instructionFile: join(dir, 'SKILL.md'), resourceRoot: dir })
    assert.equal(fake.skills.length, 0)
    const errors = fake.logs.filter(entry => entry.level === 'error')
    assert.equal(errors.length, 1)
    assert.match(String(errors[0]?.message), /skill "dsh-agents-toml" is unavailable/)
    assert.match(String(errors[0]?.message), /ENOENT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an asset without frontmatter is reported instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-toml-skill-'))
  try {
    writeFileSync(join(dir, 'SKILL.md'), 'no frontmatter here\n', 'utf8')
    const fake = bench()
    contributeSkill(fake.ctx, { instructionFile: join(dir, 'SKILL.md'), resourceRoot: dir })
    assert.equal(fake.skills.length, 0)
    assert.match(String(fake.logs.at(-1)?.message), /no YAML frontmatter/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a context without the skills service still gets delegation wiring', () => {
  const fake = bench()
  const withoutSkills = { ...fake.ctx, inject: (services: readonly string[], callback: (scoped: typeof fake.ctx) => void) => {
    // The real context hands a scope every requested service it can satisfy;
    // this one satisfies none of them, so the callback never sees `skills`.
    callback(services.includes('skills') ? { ...fake.ctx, skills: undefined } : fake.ctx)
    return { dispose() {} }
  } }
  contributeSkill(withoutSkills)
  assert.equal(fake.skills.length, 0)
  assert.equal(fake.logs.length, 0)
})

test('the skill registration is disposed with the plugin', () => {
  const fake = bench()
  contributeSkill(fake.ctx)
  for (const cleanup of fake.cleanups) cleanup()
  assert.equal(fake.skills[0]?.disposed, true)
})
