#!/usr/bin/env node
/**
 * A minimal stdio MCP server that exposes the plugin's skill_search and
 * skill_load exactly as registered (same name, description, parameters, same
 * rendered text), so a Claude Code run sees what a DSH agent would see.
 */
import { createInterface } from 'node:readline'
import { apply } from '../../skill-on-demand.js'

const tools = new Map()
apply({ tools: { register: (definition) => tools.set(definition.name, definition) } })

function inputSchema(parameters = {}) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(parameters)) {
    const { required: isRequired, ...rest } = spec
    properties[key] = rest
    if (isRequired) required.push(key)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

createInterface({ input: process.stdin }).on('line', async (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = request
  if (id === undefined) return // notification
  const ok = (result) => send({ jsonrpc: '2.0', id, result })
  const fail = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })
  if (method === 'initialize') {
    return ok({ protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'skills', version: '1' } })
  }
  if (method === 'ping') return ok({})
  if (method === 'tools/list') {
    return ok({ tools: [...tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t.parameters) })) })
  }
  if (method === 'tools/call') {
    const tool = tools.get(params?.name)
    if (!tool) return fail(-32602, `unknown tool ${params?.name}`)
    try {
      const value = await tool.execute(params.arguments ?? {}, {})
      const text = tool.output.render(params.arguments ?? {}, value).map((block) => block.text).join('\n')
      return ok({ content: [{ type: 'text', text }] })
    } catch (error) {
      return ok({ isError: true, content: [{ type: 'text', text: `Error: ${error.message}` }] })
    }
  }
  return fail(-32601, `method not found: ${method}`)
})
