#!/usr/bin/env node
// Exercise preset mounting and a non-secret settings write in an ISOLATED
// throwaway profile, not just web-server startup. Never print the bootstrap
// URL, cookie, or raw boot log: they contain a credential.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const logPath = process.argv[2]
if (!logPath) throw new Error('usage: node scripts/check-dsh-session.mjs <boot-log> [workspace]')
const log = await readFile(logPath, 'utf8')
const match = log.match(/dsh web:\s+(http:\/\/\S+)/)
if (!match) throw new Error('DSH did not report a bootstrap URL')
const url = new URL(match[1])
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('refusing a non-loopback DSH URL')

const bootstrap = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0]
if (bootstrap.status !== 303 || !cookie) throw new Error(`DSH bootstrap did not establish a session (HTTP ${bootstrap.status})`)

async function rpc(method, args) {
  const response = await fetch(new URL(`/api/${method}`, url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: url.origin, cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'academic-harness-compat', method, payload: { args } }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`${method} failed (HTTP ${response.status})`)
  const result = (await response.json()).result
  if (!result?.ok) throw new Error(`${method} failed: ${result?.error?.message || 'unexpected response'}`)
  return result.value
}

const session = await rpc('session/create', { request: { cwd: resolve(process.argv[3] || process.cwd()), agentPreset: 'academic-harness' } })
if (session?.agentPreset !== 'academic-harness' || !session.sessionId) {
  throw new Error('Academic Harness session creation returned an unexpected response')
}
const settings = await rpc('settings/describe', {})
const entry = settings?.namespaces?.find((item) => item.ns === 'academic-harness')
if (!entry) throw new Error('Academic Harness settings namespace not found')
await rpc('settings/mutate', {
  ns: 'academic-harness',
  ops: [{ op: 'set', path: ['IMAGE_MODEL'], value: 'dsh-compat-test-model' }],
  expectedRevision: entry.revision,
})
if (process.env.DSH_COMPAT_RECEIPT) {
  await rpc('session/prompt', { request: {
    sessionId: session.sessionId, requestId: randomUUID(), mode: 'queue',
    content: [{ type: 'text', text: 'Run the local compatibility check.' }],
  } })
  const deadline = Date.now() + 30_000
  let receipt
  while (Date.now() < deadline) {
    try { receipt = JSON.parse(await readFile(process.env.DSH_COMPAT_RECEIPT, 'utf8')); break } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await delay(250)
    }
  }
  if (!receipt) throw new Error('mock provider did not receive tool results within 30 seconds')
  const missing = Object.entries(receipt.declared || {}).filter(([, present]) => !present).map(([name]) => name)
  if (missing.length || !receipt.template || !receipt.agents || !receipt.imageGuard || !receipt.delegation) {
    throw new Error(`tool compatibility failed: ${JSON.stringify({ missing, template: receipt.template, agents: receipt.agents, imageGuard: receipt.imageGuard, delegation: receipt.delegation })}`)
  }
}
console.log(`Academic Harness preset session and settings write succeeded${process.env.DSH_COMPAT_RECEIPT ? '; tool calls and image guard verified' : ''}`)
