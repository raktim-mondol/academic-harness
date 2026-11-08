#!/usr/bin/env node
// Scripted, loopback-only Anthropic-Messages endpoint for a LIVE end-to-end run of
// the plugin in a throwaway DSH profile. It plays a fixed sequence of tool calls
// (see steps.mjs); it never forwards prompts and uses no real key.
//
// It is stateless: its position is the number of its own tool results already in
// the request, so a retry or a second request cannot desynchronise it. After every
// request it rewrites the receipt with the full history so a verifier can read it.
//
//   node provider.mjs <steps.mjs> <port-file> <receipt.json>
//
// What this is NOT: a model. It exercises the host, the plugin, the real tools,
// and the UI; it says nothing about how a model would choose or phrase anything.
import { createServer } from 'node:http'
import { renameSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const [stepsFile, portFile, receiptFile] = process.argv.slice(2)
if (!stepsFile || !portFile || !receiptFile) throw new Error('usage: node provider.mjs <steps.mjs> <port-file> <receipt.json>')
const { steps, finalText = 'Live end-to-end script complete.' } = await import(pathToFileURL(resolve(stepsFile)).href)
const PREFIX = 'toolu_e2e_'

const flatten = (content) => (Array.isArray(content) ? content.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n') : String(content ?? ''))

function historyOf(request) {
  const uses = new Map()
  const results = new Map()
  for (const message of request.messages || []) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool_use' && String(block.id).startsWith(PREFIX)) uses.set(block.id, block)
      if (block.type === 'tool_result' && String(block.tool_use_id).startsWith(PREFIX)) results.set(block.tool_use_id, block)
    }
  }
  const done = []
  for (let i = 0; results.has(`${PREFIX}${i}`); i += 1) {
    const use = uses.get(`${PREFIX}${i}`)
    const result = results.get(`${PREFIX}${i}`)
    done.push({ step: i, name: use?.name ?? null, input: use?.input ?? null, is_error: result.is_error === true, text: flatten(result.content) })
  }
  return done
}

let declaredTools = null
const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/v1/messages')) { res.writeHead(404).end(); return }
  try {
    let body = ''
    for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
    const tools = (request.tools || []).map((tool) => tool.name)
    const isAgentRequest = tools.includes('research_template')
    const history = historyOf(request)
    if (isAgentRequest) {
      declaredTools = tools
      const finished = history.length >= steps.length
      const tmp = `${receiptFile}.tmp`
      writeFileSync(tmp, JSON.stringify({ declared_tools: declaredTools, total_steps: steps.length, finished, history }, null, 1))
      renameSync(tmp, receiptFile)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const events = [{ type: 'message_start', message: { id: `msg_e2e_${history.length}`, type: 'message', role: 'assistant', content: [], model: request.model, usage: { input_tokens: 1, output_tokens: 1 } } }]
      if (!finished) {
        const next = steps[history.length](history)
        events.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `${PREFIX}${history.length}`, name: next.name, input: {} } })
        events.push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(next.input) } })
        events.push({ type: 'content_block_stop', index: 0 })
        events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } })
      } else {
        events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        events.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: finalText } })
        events.push({ type: 'content_block_stop', index: 0 })
        events.push({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
      }
      events.push({ type: 'message_stop' })
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end()
      return
    }
    // Any other request (titles, summaries): a short plain answer.
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const events = [
      { type: 'message_start', message: { id: 'msg_e2e_aux', type: 'message', role: 'assistant', content: [], model: request.model, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Live end-to-end check' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  } catch (error) {
    if (!res.headersSent) res.writeHead(500)
    res.end(String(error instanceof Error ? error.message : error))
  }
})
server.listen(0, '127.0.0.1', () => writeFileSync(portFile, String(server.address().port)))
