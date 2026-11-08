#!/usr/bin/env node
// Deterministic loopback-only Messages endpoint for the throwaway DSH canary.
// It returns fixed tool calls; it never forwards prompts or uses real keys.
import { createServer } from 'node:http'
import { renameSync, writeFileSync } from 'node:fs'

const [portFile, receiptFile] = process.argv.slice(2)
if (!portFile || !receiptFile) throw new Error('usage: node dsh-compat-provider.mjs <port-file> <receipt-file>')
const expectedTools = ['research_template', 'literature_search', 'list_agents', 'subagent', 'subagent_pro', 'subagent_vision']
const calls = [
  { id: 'toolu_compat_template', name: 'research_template', input: { action: 'list' } },
  { id: 'toolu_compat_agents', name: 'list_agents', input: { scope: 'children' } },
  { id: 'toolu_compat_image', name: 'read_image', input: { file_path: '/nonexistent/compat.png' } },
  { id: 'toolu_compat_delegate', name: 'subagent_pro', input: { description: 'Check delegation route', prompt: 'Return a short compatibility acknowledgement.' } },
]
let declared
let sentCalls = false

const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/v1/messages')) {
    res.writeHead(404).end()
    return
  }
  try {
    let body = ''
    for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
    const tools = (request.tools || []).map((tool) => tool.name)
    const results = (request.messages || []).flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((block) => block.type === 'tool_result')
    const hasOurResults = results.some((result) => result.tool_use_id === calls[0].id)
    const isAgentRequest = tools.includes('research_template')

    if (isAgentRequest && !hasOurResults && !declared) declared = tools
    if (hasOurResults) {
      const byId = Object.fromEntries(results.map((result) => [result.tool_use_id, result]))
      const image = byId[calls[2].id]
      const imageText = JSON.stringify(image?.content || '')
      const receipt = {
        declared: Object.fromEntries(expectedTools.map((name) => [name, declared?.includes(name) === true])),
        template: byId[calls[0].id]?.is_error === false,
        agents: byId[calls[1].id]?.is_error === false,
        // The file may be absent or the route may reject images; either is a
        // normal tool error. The regression this pins is the old plugin-level
        // denial, which must never appear now that native read_image is allowed.
        nativeImage: image !== undefined && !imageText.includes('Direct read_image is disabled') && !/unknown tool/i.test(imageText),
        delegation: byId[calls[3].id]?.is_error === false,
      }
      writeFileSync(`${receiptFile}.tmp`, JSON.stringify(receipt))
      renameSync(`${receiptFile}.tmp`, receiptFile)
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const events = [{ type: 'message_start', message: { id: 'msg_compat', type: 'message', role: 'assistant', content: [], model: request.model, usage: { input_tokens: 1, output_tokens: 1 } } }]
    if (isAgentRequest && !hasOurResults && !sentCalls) {
      sentCalls = true
      for (const [index, call] of calls.entries()) {
        events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', ...call } })
        events.push({ type: 'content_block_stop', index })
      }
      events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } })
    } else {
      events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Compatibility check complete.' } })
      events.push({ type: 'content_block_stop', index: 0 })
      events.push({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
    }
    events.push({ type: 'message_stop' })
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  } catch {
    if (!res.headersSent) res.writeHead(500)
    res.end()
  }
})
server.listen(0, '127.0.0.1', () => writeFileSync(portFile, String(server.address().port)))
