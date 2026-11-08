#!/usr/bin/env node
// Create a preset session in the throwaway DSH and send one prompt, then wait for the
// scripted provider to finish. The bootstrap URL carries a credential: it is read from
// the boot log, never printed, and saved only to a mode-600 file for the browser step.
//   node drive.mjs <boot-log> <workspace> <receipt.json> <session-out.json>
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const [logPath, workspace, receiptPath, outPath] = process.argv.slice(2)
if (!outPath) throw new Error('usage: node drive.mjs <boot-log> <workspace> <receipt.json> <session-out.json>')
const log = await readFile(logPath, 'utf8')
const match = log.match(/dsh web:\s+(http:\/\/\S+)/)
if (!match) throw new Error('DSH did not report a bootstrap URL')
const url = new URL(match[1])
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('refusing a non-loopback DSH URL')
if (url.port === '3080') throw new Error('refusing port 3080: that is the user\'s own DSH')

const bootstrap = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0]
if (bootstrap.status !== 303 || !cookie) throw new Error(`bootstrap failed (HTTP ${bootstrap.status})`)

async function rpc(method, args) {
  const response = await fetch(new URL(`/api/${method}`, url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: url.origin, cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'live-e2e', method, payload: { args } }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`${method} failed (HTTP ${response.status})`)
  const result = (await response.json()).result
  if (!result?.ok) throw new Error(`${method} failed: ${result?.error?.message || 'unexpected response'}`)
  return result.value
}

const session = await rpc('session/create', { request: { cwd: resolve(workspace), agentPreset: 'academic-harness' } })
if (session?.agentPreset !== 'academic-harness' || !session.sessionId) throw new Error('unexpected session/create response')
await rpc('session/prompt', { request: { sessionId: session.sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Run the Phase 1-5 live end-to-end script.' }] } })

const deadline = Date.now() + 240_000
let receipt = null
while (Date.now() < deadline) {
  try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')) } catch { /* not there yet */ }
  if (receipt?.finished) break
  await delay(1000)
}
await writeFile(outPath, JSON.stringify({ sessionId: session.sessionId, origin: url.origin, bootstrap: match[1], finished: Boolean(receipt?.finished), steps_done: receipt?.history?.length ?? 0, total_steps: receipt?.total_steps ?? null }), { mode: 0o600 })
console.log(`session ${session.sessionId.slice(0, 8)}… ${receipt?.finished ? 'finished' : 'DID NOT FINISH'}: ${receipt?.history?.length ?? 0}/${receipt?.total_steps ?? '?'} steps`)
process.exit(receipt?.finished ? 0 : 1)
