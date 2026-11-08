#!/usr/bin/env node
// Drive an ISOLATED DSH that talks to a REAL model (the key comes from the caller's
// environment and is never read or printed here). Sends prompts one turn at a time,
// waits for each turn to end, and dumps every tool call/result and assistant text.
//   node real-model.mjs <dsh-home> <boot-log> <workspace> <prompts.json> <out.json>
// prompts.json: ["turn 1 prompt", "turn 2 prompt", ...]
// RESUME_SESSION=<id> reuses a live session: a turn already started is only waited on.
// When the model calls ask_user_question the run answers it with the FIRST listed option
// of every question (the model's own recommendation); that policy is the researcher's
// decision in this harness, it is logged in the output, and capped per run.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const [dshHome, bootLog, workspace, promptsFile, outFile] = process.argv.slice(2)
if (!outFile) throw new Error('usage: node real-model.mjs <dsh-home> <boot-log> <workspace> <prompts.json> <out.json>')
const url = new URL(readFileSync(bootLog, 'utf8').match(/dsh web:\s+(http:\/\/\S+)/)[1])
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '3080') throw new Error('refusing this DSH URL')
const boot = await fetch(url, { redirect: 'manual' })
const cookie = boot.headers.get('set-cookie')?.split(';', 1)[0]
if (!cookie) throw new Error('bootstrap failed')
async function rpc(method, args) {
  const response = await fetch(new URL(`/api/${method}`, url), { method: 'POST', headers: { 'content-type': 'application/json', origin: url.origin, cookie }, body: JSON.stringify({ type: 'client-request', rpcId: 'real-model', method, payload: { args } }) })
  const body = await response.json()
  if (!body.result?.ok) throw new Error(`${method}: ${JSON.stringify(body.result?.error)}`)
  return body.result.value
}
const prompts = JSON.parse(readFileSync(promptsFile, 'utf8'))
const id = process.env.RESUME_SESSION || (await rpc('session/create', { request: { cwd: resolve(workspace), agentPreset: 'academic-harness' } })).sessionId
const MAX_ANSWERS = 12
const answered = []

function events() {
  const root = join(dshHome, 'sessions')
  for (const dir of readdirSync(root)) {
    const file = join(root, dir, id, 'session.v4.jsonl.zstd')
    if (existsSync(file)) {
      try { return execFileSync('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
    }
  }
  return []
}
const flat = (c) => (Array.isArray(c) ? c.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n') : String(c ?? ''))

async function answerPending(log) {
  const resolved = new Set(log.filter((e) => e.type === 'tool/result').map((e) => e.data?.toolCallId))
  const done = new Set(answered.map((a) => a.callId))
  for (const e of log) {
    if (e.type !== 'tool/call' || e.data?.name !== 'ask_user_question' || resolved.has(e.data.callId) || done.has(e.data.callId)) continue
    if (answered.length >= MAX_ANSWERS) return
    const questions = JSON.parse(e.data.arguments).questions || []
    const answers = questions.map((q) => ({ id: q.id, selected: [q.options[0].label] }))
    const accepted = await rpc('userQuestions/answer', { agentId: id, callId: e.data.callId, answer: { answers } })
    // The host returned false for these calls in testing (no pending question registered under
    // the tool call id); the web UI path works. Do not claim an answer that was not accepted.
    answered.push({ callId: e.data.callId, turn: e.data.turn, accepted, answers: questions.map((q, i) => ({ question: q.question, chose: answers[i].selected[0] })) })
    console.log(accepted ? `answered ask_user_question (${questions.length} question(s)) with the first option each` : `NEEDS UI ANSWER: the host did not accept the RPC answer for ${e.data.callId}; answer it in the web UI`)
  }
}

for (let turn = 1; turn <= prompts.length; turn += 1) {
  const started = events().filter((e) => e.type === 'turn/start').length
  if (turn > started) await rpc('session/prompt', { request: { sessionId: id, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: prompts[turn - 1] }] } })
  const deadline = Date.now() + 12 * 60_000
  let ended = false
  while (Date.now() < deadline) {
    await delay(4000)
    const log = events()
    if (log.filter((e) => e.type === 'turn/end').length >= turn) { ended = true; break }
    await answerPending(log)
  }
  console.log(`turn ${turn}: ${ended ? 'ended' : 'TIMED OUT'}`)
  if (!ended) break
}

const log = events()
const calls = []
const byId = new Map()
for (const e of log) {
  const d = e.data || {}
  const content = d.message?.content
  if (e.type === 'assistant/message' && Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'tool_use' || block.type === 'tool-call') { const c = { turn: d.turn, id: block.id ?? block.toolCallId, name: block.name ?? block.toolName, input: block.input ?? block.args, result: null }; calls.push(c); byId.set(c.id, c) }
    }
  }
}
const types = {}
for (const e of log) types[e.type] = (types[e.type] || 0) + 1
writeFileSync(outFile, JSON.stringify({ sessionId: id, turns_requested: prompts.length, event_types: types, auto_answers: answered, calls, log }, null, 1), { mode: 0o600 })
console.log(`session ${id.slice(0, 8)}…: ${log.length} events, ${calls.length} tool calls found; event types: ${Object.keys(types).filter((t) => /tool|approval|permission/.test(t)).join(', ')}`)
