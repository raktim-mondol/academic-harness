#!/usr/bin/env node
/**
 * Scripted stand-in for the `ah` engine CLI, for tests that drive the real
 * hook listeners in academic-harness-hooks.js.
 *
 * The plugin spawns `<ACADEMIC_HARNESS_CLI> hook <event>` with the payload on
 * stdin. Point ACADEMIC_HARNESS_CLI at `node <this file>` and set:
 *
 *   FAKE_AH_SCRIPT  JSON file: { "<event>": [reply, reply, ...] }
 *                   A key may be mode-specific, "<event>:<AH_T3_MODE>" (for example
 *                   "stop:defer"); that list is used when AH_T3_MODE has that value,
 *                   otherwise the plain "<event>" list.
 *                   A reply is an object (printed as JSON), a string (printed
 *                   verbatim) or null (nothing printed). Replies are consumed
 *                   in order; the last one repeats once the list runs out.
 *   FAKE_AH_LOG     JSONL file: one line per call, { event, payload }
 *   FAKE_AH_STATE   JSON file where per-event call counts are kept
 *
 * It exits 0 for every call, like the real engine does for a normal hook.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const [, , verb, event] = process.argv
if (verb !== 'hook' || !event) {
  console.error(`fake engine: expected "hook <event>", got "${process.argv.slice(2).join(' ')}"`)
  process.exit(2)
}

let stdin = ''
for await (const chunk of process.stdin) stdin += chunk
let payload = null
try {
  payload = JSON.parse(stdin)
} catch {
  payload = stdin
}

const { FAKE_AH_SCRIPT, FAKE_AH_LOG, FAKE_AH_STATE } = process.env
const mode = process.env.AH_T3_MODE || null
if (FAKE_AH_LOG) appendFileSync(FAKE_AH_LOG, `${JSON.stringify({ event, mode, payload })}\n`)

const script = FAKE_AH_SCRIPT && existsSync(FAKE_AH_SCRIPT) ? JSON.parse(readFileSync(FAKE_AH_SCRIPT, 'utf8')) : {}
const state = FAKE_AH_STATE && existsSync(FAKE_AH_STATE) ? JSON.parse(readFileSync(FAKE_AH_STATE, 'utf8')) : {}
const key = mode && script[`${event}:${mode}`] ? `${event}:${mode}` : event
const replies = script[key] ?? []
const index = state[key] ?? 0
state[key] = index + 1
if (FAKE_AH_STATE) writeFileSync(FAKE_AH_STATE, JSON.stringify(state))

if (replies.length === 0) process.exit(0)
const reply = replies[Math.min(index, replies.length - 1)]
if (reply == null) process.exit(0)
process.stdout.write(typeof reply === 'string' ? reply : JSON.stringify(reply))
process.stdout.write('\n')
