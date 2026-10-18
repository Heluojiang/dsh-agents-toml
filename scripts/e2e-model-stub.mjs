// A scripted Messages-protocol model for the keyed scenario.
//
// The delegation scenario needs a model that reliably decides to delegate, and a
// real provider makes that a coin flip that also costs money. This stub speaks
// the same wire protocol the shipping adapter speaks, so everything below the
// model — the real Loader, the real `subagent` service, the real Agent Preset
// registry, the plugin's own tool — runs unmodified; only the token-by-token
// decision of *what to say* is scripted.
//
// The script is a function of the request:
//
//   parent + no tool result yet  -> call `subagent_custom` once
//   child (its system prompt carries the preset persona marker) -> answer in text
//   parent + tool result present -> finish with text
//
// Running it is `node scripts/e2e-model-stub.mjs --port <port>`; `--log` prints
// each request's system-prompt head so a failed run can be diagnosed.
import { createServer } from 'node:http'

/** Read the whole request body. */
async function body(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/** One SSE frame in the shape the DeepSeek Messages adapter decodes. */
function frame(payload) {
  return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`
}

/** Emit a complete assistant turn made of `blocks`, then settle the stream. */
function respond(response, blocks) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  response.write(frame({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } }))
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'text') {
      response.write(frame({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }))
      response.write(frame({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }))
    } else {
      response.write(frame({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: `stub-call-${index}`, name: block.name, input: {} },
      }))
      response.write(frame({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      }))
    }
    response.write(frame({ type: 'content_block_stop', index }))
  }
  response.write(frame({
    type: 'message_delta',
    delta: { stop_reason: blocks.some(block => block.type === 'tool') ? 'tool_use' : 'end_turn' },
    usage: { output_tokens: 1 },
  }))
  response.write(frame({ type: 'message_stop' }))
  response.end()
}

/** Whether this request is the session-title call rather than a conversation turn. */
function isTitleRequest(value) {
  return texts(value.system ?? []).some(text => text.includes('Create a concise title'))
    || texts(value.system ?? []).some(text => text.includes('为 AI 编程助手会话'))
}

/**
 * Answer a session-title request the way a provider would: with a short title
 * taken from the first human message.
 *
 * The browser tier finds a session in the sidebar by its title text, so a stub
 * that answered with its usual closing line would make every session look alike.
 * The request embeds the human messages as a JSON array, so the first `text`
 * field in it is the title the operator expects to see.
 * @param value - the decoded request body.
 * @returns the title to return.
 */
function titleFor(value) {
  const prompt = texts(value.messages ?? []).find(text => text.includes('"text"')) ?? ''
  const embedded = /\[[\s\S]*\]/u.exec(prompt)?.[0]
  if (embedded !== undefined) {
    try {
      const first = JSON.parse(embedded).find(entry => typeof entry?.text === 'string')
      if (first !== undefined) return String(first.text).replace(/\s+/gu, ' ').trim().slice(0, 24)
    } catch { /* the shape changed; fall through to the prompt itself */ }
  }
  return (texts(value.messages ?? [])[0] ?? 'stub session').replace(/\s+/gu, ' ').trim().slice(0, 24)
}

/** Strings anywhere in a JSON value, so a marker can be looked for in any field. */
function texts(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) texts(item, out)
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) texts(item, out)
  return out
}

/**
 * Whether this request already carries a tool result.
 *
 * The Messages protocol shapes it as a `tool_result` content block, which is what
 * tells the parent's second turn apart from its first.
 * @param value - a decoded request body.
 * @returns true when a tool result block is present.
 */
function hasToolResult(value) {
  if (Array.isArray(value)) return value.some(hasToolResult)
  if (value === null || typeof value !== 'object') return false
  if (value.type === 'tool_result') return true
  return Object.values(value).some(hasToolResult)
}

/**
 * Build the HTTP handler.
 * @param options - the delegation to script and whether to narrate requests.
 * @returns a Node request listener.
 */
export function createModelStub(options) {
  const {
    agentType,
    presetMarker,
    toolName = 'subagent_custom',
    childText = '已确认',
    finalText = '委派已完成。',
    log = () => {},
  } = options
  let parentTurns = 0
  let childTurns = 0
  return (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(404).end()
      return
    }
    void (async () => {
      const raw = await body(request)
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        response.writeHead(400).end('not JSON')
        return
      }
      // The session-title call is not a conversation turn: answering it with the
      // delegation/closing script would leave every session with the same sidebar
      // title, and the browser tier finds a session by its title.
      if (isTitleRequest(parsed)) {
        const title = titleFor(parsed)
        log(`  stub: title request -> ${JSON.stringify(title)}`)
        respond(response, [{ type: 'text', text: title }])
        return
      }
      // Only the conversation is searched for the delegate instruction: the tools
      // array names every tool, so including it would make *every* turn look like
      // a request to delegate.
      const conversation = [...texts(parsed.system ?? []), ...texts(parsed.messages ?? [])]
      const isChild = presetMarker !== undefined && conversation.some(text => text.includes(presetMarker))
      const gotToolResult = hasToolResult(parsed.messages ?? parsed)
      const offered = (parsed.tools ?? []).some(tool => tool.name === toolName)
      const askedForTool = conversation.some(text => text.includes(toolName))

      if (isChild) {
        childTurns += 1
        log(`  stub: child turn ${childTurns} -> text`)
        respond(response, [{ type: 'text', text: childText }])
        return
      }
      parentTurns += 1
      if (askedForTool && !gotToolResult && offered) {
        log(`  stub: parent turn ${parentTurns} -> ${toolName}(agent_type="${agentType}")`)
        respond(response, [{
          type: 'tool',
          name: toolName,
          input: { agent_type: agentType, description: 'stub delegation', prompt: '只回复一行：已确认' },
        }])
        return
      }
      log(`  stub: parent turn ${parentTurns} -> text`)
      respond(response, [{ type: 'text', text: finalText }])
    })().catch(error => {
      log(`  stub: error ${String(error)}`)
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  }
}

/** Command-line entry: `node scripts/e2e-model-stub.mjs --port N [--log]`. */
function main(argv) {
  const arg = name => {
    const at = argv.indexOf(name)
    return at === -1 ? undefined : argv[at + 1]
  }
  const port = Number(arg('--port') ?? 0)
  const useLog = argv.includes('--log')
  const server = createServer(createModelStub({
    agentType: arg('--agent-type') ?? 'reviewer',
    presetMarker: arg('--preset-marker'),
    childText: arg('--child-text'),
    log: useLog ? message => process.stdout.write(`${message}\n`) : () => {},
  }))
  server.listen(port, '127.0.0.1', () => {
    const address = server.address()
    // The scenario reads this line to learn which port to point the adapter at.
    process.stdout.write(`stub listening http://127.0.0.1:${address.port}/v1\n`)
  })
  process.on('SIGTERM', () => { server.close(() => process.exit(0)) })
  process.on('SIGINT', () => { server.close(() => process.exit(0)) })
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/e2e-model-stub.mjs')) main(process.argv.slice(2))
