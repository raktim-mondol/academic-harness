/**
 * Minimal MCP bridge for PaperMemory tool calls. Shared by reporting_check and
 * review so quote verification uses one transport.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { papermemoryEnv } from './papermemory-cli.js'

const VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'),
).version

export function mcpText(result) {
  const part = result?.content?.find((item) => item?.type === 'text')
  if (!part?.text) throw new Error('PaperMemory returned no text content')
  try {
    return JSON.parse(part.text)
  } catch {
    throw new Error('PaperMemory returned output that is not JSON')
  }
}

export function paperMemoryCall(launch, name, args, { timeoutMs = 90_000, clientName = 'academic-harness' } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(launch.command, [...(launch.args || []), 'mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: papermemoryEnv(),
    })
    let buffer = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => finish(new Error(`PaperMemory did not answer within ${timeoutMs}ms`)), timeoutMs)

    function finish(error, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGTERM')
      if (error) reject(error)
      else resolvePromise(value)
    }

    function send(message) {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`)
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.id === 1 && message.error) {
          finish(new Error(message.error.message || 'PaperMemory initialize failed'))
        } else if (message.id === 1 && message.result) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })
        } else if (message.id === 2) {
          if (message.error) finish(new Error(message.error.message || 'PaperMemory tool call failed'))
          else finish(null, message.result)
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => finish(new Error(`PaperMemory failed to start: ${error.message}`)))
    child.on('exit', (code) => {
      if (!settled) finish(new Error(`PaperMemory exited ${code}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`))
    })
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: clientName, version: VERSION },
      },
    })
  })
}
