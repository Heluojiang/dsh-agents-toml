// Browser scenarios: drive a running Harness Web instance over CDP and prove the
// behaviours that only exist in a live session.
//
// C1  a settings write reaches a session that is ALREADY open
// C3  a continuable child's closing text arrives as a settlement notice
// C4  adding and deleting a definition file refreshes a running session
//
// Every assertion reads the recorded session log or the profile's patch file.
// The scenarios talk to the instance the caller started, and never touch another.
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readSession, sessionGroup } from './e2e-headless.mjs'
import {
  Cdp,
  newSession,
  openPluginCard,
  openPluginManager,
  readSwitches,
  saveCard,
  selectSession,
  sendMessage,
  setSwitch,
  sleep,
} from './e2e-cdp.mjs'

const PACKAGE_NAME = '@heluojiang/dsh-agents-toml'
const TRUST_SWITCH = '信任项目级定义'

/**
 * Poll until `probe` returns a truthy value or `timeoutMs` passes.
 *
 * A continuable child finishes on its own schedule, so its notice cannot be
 * awaited with a fixed sleep: reading the log too early observes a parent that
 * has simply not been told yet.
 * @param probe - reads the current state; returning anything truthy ends the wait.
 * @param timeoutMs - how long to keep polling.
 * @param stepMs - delay between attempts.
 * @returns the last value `probe` produced.
 */
async function waitFor(probe, timeoutMs, stepMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let value = await probe()
  while (!value && Date.now() < deadline) {
    await sleep(stepMs)
    value = await probe()
  }
  return value
}

/** Newest session directories under a group, by mtime. */
function latestSessions(root, count) {
  return readdirSync(root)
    .map(name => ({ name, dir: join(root, name), mtime: statSync(join(root, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, count)
}

/** The `agent_type` enum the `index`-th request of a session offered the model. */
function enumOf(dir, index) {
  const headers = readSession(dir).filter(event => event.type === 'request/header')
  const header = headers.at(index)
  const tools = header?.data?.header?.tools ?? []
  const delegation = tools.find(tool => tool.name === 'subagent_custom')
  return delegation?.parameters?.properties?.agent_type?.enum ?? null
}

/** One scenario's checks, reported in order. */
function scenario(name, log) {
  const results = []
  return {
    name,
    results,
    check(id, ok, detail) {
      results.push({ id, ok, detail })
      log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`)
    },
    settled: () => ({ name, failures: results.filter(entry => !entry.ok) }),
  }
}

/**
 * Run the browser scenarios.
 * @param options - `url` of the running instance, CDP `port`, the `project` under test,
 * its `home`, the `profile` the settings card writes to, and the project's
 * definition `projectNames`.
 * @returns one entry per scenario, each with its failures.
 */
export async function runGuiScenarios(options) {
  const { url, port, project, home, profile, projectNames, log = console.log } = options
  const patchPath = join(home, 'profiles', profile, 'cordis.patch.yml')
  const group = sessionGroup(home, project)
  const readTrust = () => /trustProjectAgents:\s*(\w+)/.exec(readFileSync(patchPath, 'utf8'))?.[1]

  const cdp = await Cdp.attach(port)
  await cdp.goto(url, 6000)
  const openCard = async () => {
    await openPluginManager(cdp)
    return openPluginCard(cdp, PACKAGE_NAME)
  }
  const scenarios = []

  try {
    // ---- C1 -----------------------------------------------------------------
    const c1 = scenario('gui-settings-write', log)
    log('\n== C1 a settings write reaches an already-open session ==')
    c1.check('the installed plugin row expands into its settings card', await openCard(), `clicked ${PACKAGE_NAME}`)
    const switches = await readSwitches(cdp)
    c1.check('the card offers the trust switch',
      switches[TRUST_SWITCH] !== undefined, `aria-checked=${switches[TRUST_SWITCH]}`)
    if (switches[TRUST_SWITCH] !== 'false') {
      log(`  flipping off: ${JSON.stringify(await setSwitch(cdp, TRUST_SWITCH, false))}`)
      await saveCard(cdp)
    }
    c1.check('the profile patch holds trust off',
      readTrust() === 'false', `patch trustProjectAgents=${readTrust()}`)

    await newSession(cdp)
    const first = await sendMessage(cdp, '只回复两个字：收到C1', 32000)
    c1.check('the first message was sent', first.sent === true, `typed ${JSON.stringify(first.typed)}`)
    const session = latestSessions(group, 1)[0]
    c1.check('the first request lists no project definitions',
      (enumOf(session.dir, 0) ?? null) === null, `enum=${JSON.stringify(enumOf(session.dir, 0))}`)

    await openCard()
    const flipped = await setSwitch(cdp, TRUST_SWITCH, true)
    await saveCard(cdp)
    c1.check('saving writes trustProjectAgents into the profile patch',
      readTrust() === 'true', `switch ${JSON.stringify(flipped)}; patch trustProjectAgents=${readTrust()}`)

    c1.check('the session can be reselected', await selectSession(cdp, '收到C1'), 'composer is available again')
    const second = await sendMessage(cdp, '只回复两个字：好的', 32000)
    c1.check('the second message was sent', second.sent === true, `typed ${JSON.stringify(second.typed)}`)

    const requests = readSession(session.dir).filter(event => event.type === 'request/header').length
    c1.check('the same session issued two requests', requests >= 2, `${requests} request/header events`)
    const after = enumOf(session.dir, -1)
    c1.check('the settings write reaches the already-open session',
      (after ?? []).length === projectNames.length && projectNames.every(name => after.includes(name)),
      `enum=${JSON.stringify(after)}`)
    scenarios.push(c1.settled())

    // ---- C4 -----------------------------------------------------------------
    const c4 = scenario('gui-definition-refresh', log)
    log('\n== C4 a definition file edit refreshes a running session ==')
    const added = join(project, '.dsh', 'agents', 'e2e_ephemeral.toml')
    try {
      await newSession(cdp)
      await sendMessage(cdp, '只回复两个字：收到C4', 32000)
      const target = latestSessions(group, 1)[0]
      c4.check('the first request lists only the project definitions',
        (enumOf(target.dir, 0) ?? []).length === projectNames.length,
        `enum=${JSON.stringify(enumOf(target.dir, 0))}`)

      writeFileSync(added, 'name = "e2e_ephemeral"\ndescription = "added while a session is open"\nmode = "one-shot"\n')
      await sleep(3000)
      await selectSession(cdp, '收到C4')
      await sendMessage(cdp, '只回复两个字：好的', 32000)
      const seen = enumOf(target.dir, -1)
      c4.check('the new file reaches the already-open session',
        (seen ?? []).includes('e2e_ephemeral'), `enum=${JSON.stringify(seen)}`)

      rmSync(added)
      await sleep(3000)
      await selectSession(cdp, '收到C4')
      await sendMessage(cdp, '只回复两个字：明白', 32000)
      const gone = enumOf(target.dir, -1)
      c4.check('deleting the file removes the definition again',
        (gone ?? []).length === projectNames.length && !(gone ?? []).includes('e2e_ephemeral'),
        `enum=${JSON.stringify(gone)}`)
    } finally {
      rmSync(added, { force: true })
    }
    scenarios.push(c4.settled())

    // ---- C3 -----------------------------------------------------------------
    const c3 = scenario('gui-continuable-settlement', log)
    log('\n== C3 a continuable child reports its closing text back ==')
    await newSession(cdp)
    await sendMessage(cdp, [
      '委派 explorer 子代理做一次只读核对，然后留在这一轮等待它回传结论。',
      '委派方式：调用 subagent_custom，agent_type = "explorer"，prompt 只要一句：',
      `"用 grep 在 ${project} 下搜索 class RabbitConstants，把命中数与文件路径写在最后一条消息里。"`,
      '如果 subagent_custom 返回的是 started subagent <id>，请直接说明你已委派并结束本轮，不要自己再搜索。',
    ].join('\n'), 90000)
    await sleep(45000)

    const logs = latestSessions(group, 24).map(entry => ({ ...entry, events: readSession(entry.dir) }))
    // A continuable child writes its own log, so the parent is identified by the
    // catalogue entry that names the child, not by directory order.
    const parent = logs.find(entry => entry.events.some(event => event.type === 'subagent/catalog'))
    if (parent === undefined) {
      c3.check('the parent log records a delegation', false, 'no session log holds a subagent/catalog event')
    } else {
      const catalog = parent.events.filter(event => event.type === 'subagent/catalog')
      const childId = catalog.at(-1)?.data?.childId
      const child = logs.find(entry => entry.name.includes(childId))
      const closingNow = () => (child === undefined
        ? ''
        : readSession(child.dir).filter(event => event.type === 'assistant/message')
          .map(event => (event.data?.message?.content ?? []).map(part => part?.text ?? '').join(''))
          .filter(text => text.length > 0).at(-1) ?? '')
      // The notice lands on `next-turn` when the parent is idle at that moment and
      // on `next-step` when it is still mid-turn, so both targets carry it.
      const noticeText = event => (event.data?.inserted ?? []).flatMap(part => part?.content ?? [])
        .map(part => part?.text ?? '').join('\n')
      const noticeOf = events => events
        .filter(event => event.type === 'agent/inbox/spliced'
          && (event.data?.target === 'next-turn' || event.data?.target === 'next-step'))
        .map(noticeText)
        .find(text => text.includes('Its closing message:'))
      // The notice lands whenever the child settles, so poll both logs until the
      // notice appears and the child has a closing message to compare it with.
      const notice = await waitFor(() => {
        const found = noticeOf(readSession(parent.dir))
        return found !== undefined && closingNow().length > 40 ? found : undefined
      }, 240000)
      const closing = closingNow()
      const turns = readSession(parent.dir).filter(event => event.type === 'turn/start').length

      c3.check('the delegation is recorded as a continuable child',
        catalog.at(-1)?.data?.mode === 'continuable' && typeof childId === 'string',
        `mode=${catalog.at(-1)?.data?.mode}, child=${String(childId)}`)
      c3.check('the parent received a settlement notice naming the child',
        notice !== undefined && notice.includes(String(childId)),
        notice === undefined ? 'no notice spliced into the parent inbox' : `notice mentions ${childId}`)
      c3.check('the notice carries the child\'s closing text verbatim',
        notice !== undefined && closing.length > 40
        && (notice.split('Its closing message:\n')[1] ?? '').trim() === closing.trim(),
        `closing message ${closing.length} chars`)
      c3.check('the notice woke the idle parent for another turn',
        turns >= 2, `${turns} turn/start events in the parent log`)
    }
    scenarios.push(c3.settled())
  } finally {
    cdp.close()
  }

  return scenarios
}
