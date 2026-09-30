/** Definition discovery across the user and project directories. */
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'

import { discoverAgents, findProjectRoot } from '../src/discovery.ts'
import { createMemoryIo } from './harness.ts'

const ROOT = resolve('fake-root')
const HOME = join(ROOT, 'home')
const USER_DIR = join(HOME, 'agents')
const PROJECT = join(ROOT, 'project')
const GIT_DIR = join(PROJECT, '.git')
const PROJECT_DIR = join(PROJECT, '.dsh', 'agents')
const NESTED = join(PROJECT, 'packages', 'app')

const USER_FILE = join(USER_DIR, 'reviewer.toml')
const PROJECT_FILE = join(PROJECT_DIR, 'reviewer.toml')
const PROJECT_ONLY = join(PROJECT_DIR, 'explorer.toml')

function definition(name: string, description = `${name} description`): string {
  return `name = "${name}"\ndescription = "${description}"\n`
}

describe('findProjectRoot', () => {
  it('walks up to the nearest ancestor holding .git', async () => {
    const io = createMemoryIo([], [NESTED, PROJECT, GIT_DIR])
    assert.equal(await findProjectRoot(NESTED, io), PROJECT)
  })

  it('falls back to the working directory when no marker exists', async () => {
    const io = createMemoryIo([], [NESTED])
    assert.equal(await findProjectRoot(NESTED, io), NESTED)
  })
})

describe('discoverAgents', () => {
  it('loads user definitions and ignores the project directory by default', async () => {
    const io = createMemoryIo(
      [[USER_FILE, definition('reviewer', 'from user')], [PROJECT_FILE, definition('reviewer', 'from project')]],
      [USER_DIR, PROJECT_DIR, GIT_DIR, NESTED],
    )
    const result = await discoverAgents({
      cwd: NESTED, homeDir: HOME, projectAgentsDir: '.dsh/agents', trustProjectAgents: false, io,
    })
    assert.equal(result.definitions.length, 1)
    assert.equal(result.definitions[0]?.description, 'from user')
    assert.equal(result.userDir, USER_DIR)
    assert.equal(result.projectRoot, PROJECT)
    assert.equal(result.projectDir, undefined)
    assert.deepEqual(result.watchedDirs, [USER_DIR])
  })

  it('lets a project definition override the user definition of the same name', async () => {
    const io = createMemoryIo(
      [
        [USER_FILE, definition('reviewer', 'from user')],
        [PROJECT_FILE, definition('reviewer', 'from project')],
        [PROJECT_ONLY, definition('explorer')],
      ],
      [USER_DIR, PROJECT_DIR, GIT_DIR, NESTED],
    )
    const result = await discoverAgents({
      cwd: NESTED, homeDir: HOME, projectAgentsDir: '.dsh/agents', trustProjectAgents: true, io,
    })
    assert.deepEqual(result.definitions.map(entry => [entry.name, entry.description, entry.origin]), [
      ['reviewer', 'from project', 'project'],
      ['explorer', 'explorer description', 'project'],
    ])
    assert.deepEqual(result.watchedDirs, [USER_DIR, PROJECT_DIR])
  })

  it('fails both definitions when one directory declares the same name twice', async () => {
    const first = join(PROJECT_DIR, 'a.toml')
    const second = join(PROJECT_DIR, 'b.toml')
    const io = createMemoryIo(
      [[first, definition('reviewer', 'first')], [second, definition('reviewer', 'second')]],
      [PROJECT_DIR, GIT_DIR, PROJECT],
    )
    const result = await discoverAgents({
      cwd: PROJECT, homeDir: HOME, projectAgentsDir: '.dsh/agents', trustProjectAgents: true, io,
    })
    assert.deepEqual(result.definitions, [])
    assert.equal(result.failures.length, 2)
    assert.match(result.failures[0]?.reason ?? '', /duplicate definition "reviewer"/)
  })

  it('reports an unreadable file and keeps the readable ones', async () => {
    const io = createMemoryIo([[USER_FILE, definition('reviewer')]], [USER_DIR])
    const broken = { ...io, readFile: () => Promise.reject(new Error('EACCES')) }
    const result = await discoverAgents({
      cwd: undefined, homeDir: HOME, projectAgentsDir: '.dsh/agents', trustProjectAgents: true, io: broken,
    })
    assert.deepEqual(result.definitions, [])
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0]?.reason ?? '', /cannot read file/)
  })

  it('returns nothing when neither directory exists', async () => {
    const io = createMemoryIo([], [])
    const result = await discoverAgents({
      cwd: NESTED, homeDir: HOME, projectAgentsDir: '.dsh/agents', trustProjectAgents: true, io,
    })
    assert.deepEqual(result.definitions, [])
    assert.deepEqual(result.failures, [])
  })

  it('honours an explicit user directory', async () => {
    const custom = join(ROOT, 'custom-agents')
    const io = createMemoryIo([[join(custom, 'x.toml'), definition('x')]], [custom])
    const result = await discoverAgents({
      cwd: undefined, homeDir: HOME, projectAgentsDir: '.dsh/agents', trustProjectAgents: false,
      userAgentsDir: custom, io,
    })
    assert.deepEqual(result.definitions.map(entry => entry.name), ['x'])
    assert.equal(result.userDir, custom)
  })
})
