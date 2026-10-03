// Minimal Chrome DevTools Protocol driver.
//
// `chrome-devtools-mcp --autoConnect` reads `DevToolsActivePort` from Chrome's
// default user-data directory, which Chrome 136+ refuses to open for remote
// debugging, so browser scenarios talk to an explicitly started browser over this
// port instead of editing the user's MCP configuration.
//
// The client clicks through the page's own `click()`. Raw `Input.dispatchMouseEvent`
// reaches the browser but did not activate this client's React handlers in testing.
export class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.nextId = 1
    this.pending = new Map()
  }

  /** Attach to the first page target on `port`. */
  static async attach(port) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = targets.find(target => target.type === 'page')
    if (page === undefined) throw new Error(`no page target on port ${port}`)
    const cdp = new Cdp(page.webSocketDebuggerUrl)
    await cdp.open()
    return cdp
  }

  async open() {
    this.socket = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true })
      this.socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true })
    })
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.id === undefined) return
      const entry = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (entry === undefined) return
      if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    })
  }

  /** Issue one protocol command; a silent browser must fail the run, not hang it. */
  send(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} did not answer within ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluate a function in the page and return its JSON value. */
  async evaluate(fn, ...args) {
    const expression = `(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(',')})`
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails !== undefined) {
      throw new Error(`page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    }
    return result.result.value
  }

  async goto(url, waitMs = 5000) {
    await this.send('Page.enable')
    await this.send('Page.navigate', { url })
    await new Promise(done => setTimeout(done, waitMs))
  }

  close() {
    this.socket.close()
  }
}

/** Wait for `ms` milliseconds. */
export const sleep = ms => new Promise(done => setTimeout(done, ms))

/** Click the first visible clickable whose text is exactly `label`. */
export async function clickText(cdp, label) {
  const hit = await cdp.evaluate((wanted) => {
    for (const el of document.querySelectorAll('button,a,[role=button],[role=tab]')) {
      if (el.getAttribute('role') === 'switch' || el.hasAttribute('aria-checked')) continue
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if ((el.innerText ?? '').trim() !== wanted) continue
      el.click()
      return true
    }
    return false
  }, label)
  await sleep(1500)
  return hit
}

/** Read every switch on the current settings card. */
export async function readSwitches(cdp) {
  return cdp.evaluate(() => {
    const out = {}
    for (const el of document.querySelectorAll('[role=switch],[aria-checked]')) {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      out[(el.getAttribute('aria-label') ?? '').trim()] = el.getAttribute('aria-checked')
    }
    return out
  })
}

/** Flip one labelled switch to `desired`. */
export async function setSwitch(cdp, label, desired) {
  const before = await cdp.evaluate((wanted, target) => {
    for (const el of document.querySelectorAll('[role=switch],[aria-checked]')) {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if ((el.getAttribute('aria-label') ?? '').trim() !== wanted) continue
      const value = el.getAttribute('aria-checked')
      if (value === target) return value
      el.click()
      return value
    }
    return null
  }, label, String(desired))
  await sleep(700)
  return { before, after: (await readSwitches(cdp))[label] }
}

/** Open the sidebar's plugin manager. */
export async function openPluginManager(cdp) {
  const clicked = await cdp.evaluate(() => {
    for (const el of document.querySelectorAll('button,a,[role=button]')) {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if ((el.innerText ?? '').trim() === '插件' && rect.y < 300) { el.click(); return true }
    }
    return false
  })
  await sleep(2200)
  return clicked
}

/** Expand the installed plugin's settings card.
 *
 * Switch buttons carry an aria-label that also names the package, and clicking
 * one disables the plugin, so they are excluded. */
export async function openPluginCard(cdp, packageName) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const clicked = await cdp.evaluate((wanted) => {
      for (const el of document.querySelectorAll('button,[role=button]')) {
        if (el.getAttribute('role') === 'switch' || el.hasAttribute('aria-checked')) continue
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) continue
        if ((el.innerText ?? '').trim() !== wanted) continue
        el.click()
        return true
      }
      return false
    }, packageName)
    await sleep(2200)
    if (clicked) return true
  }
  return false
}

/** Click the settings card's 保存 button. */
export async function saveCard(cdp) {
  const clicked = await cdp.evaluate(() => {
    for (const el of document.querySelectorAll('button')) {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if ((el.innerText ?? '').trim() === '保存') { el.click(); return true }
    }
    return false
  })
  await sleep(3500)
  return clicked
}

/** Start a fresh session from the sidebar. */
export async function newSession(cdp) {
  const clicked = await cdp.evaluate(() => {
    for (const el of document.querySelectorAll('button')) {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if (!(el.innerText ?? '').startsWith('新会话')) continue
      el.click()
      return true
    }
    return false
  })
  await sleep(2500)
  return clicked
}

/** Select the sidebar session whose text contains `marker`. */
export async function selectSession(cdp, marker = '') {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const clicked = await cdp.evaluate((wanted) => {
      for (const el of document.querySelectorAll('div[data-row-key]')) {
        if (!(el.dataset.rowKey ?? '').startsWith('session:')) continue
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) continue
        if (wanted.length > 0 && !(el.innerText ?? '').includes(wanted)) continue
        el.click()
        return true
      }
      return false
    }, marker)
    await sleep(2000)
    if (!clicked) continue
    const ready = await cdp.evaluate(() => {
      for (const el of document.querySelectorAll('div[role=textbox][contenteditable=true]')) {
        if (el.getBoundingClientRect().width > 0) return true
      }
      return false
    })
    if (ready) return true
  }
  return false
}

/** Replace the composer's content and send it. Returns the text that was typed. */
export async function sendMessage(cdp, body, waitMs) {
  const focused = await cdp.evaluate(() => {
    for (const el of document.querySelectorAll('div[role=textbox][contenteditable=true]')) {
      if (el.getBoundingClientRect().width === 0) continue
      el.focus()
      return true
    }
    return false
  })
  if (!focused) throw new Error('no composer')
  // A real Ctrl+A reaches the composer's own model; `document.execCommand` does not.
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      modifiers: 2,
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
    })
  }
  await sleep(250)
  await cdp.send('Input.insertText', { text: body })
  await sleep(900)
  const typed = await cdp.evaluate(() => document.querySelector('div[role=textbox][contenteditable=true]')?.innerText ?? '')
  const sent = await cdp.evaluate(() => {
    for (const el of document.querySelectorAll('button[aria-label="发送消息"]')) { el.click(); return true }
    return false
  })
  await sleep(waitMs)
  return { typed, sent }
}
