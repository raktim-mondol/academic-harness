#!/usr/bin/env node
/**
 * Decisions D26/D28 at the tools: modal_run, runpod_run and vastai_run run under
 * the session spend cap and write to the ledger, the approval prompt shows the
 * budget, and a run that cannot fit is refused before anything is rented.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fakeAgent, fakeHost } from './helpers/fake-host.mjs'

const scratch = mkdtempSync(join(homedir(), '.cache', 'ah-spend-test-'))
process.env.DSH_HOME = scratch
process.env.ACADEMIC_HARNESS_SKIP_INSTALL = '1'
for (const key of ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET', 'RUNPOD_API_KEY', 'VAST_API_KEY']) delete process.env[key]

const { applyModalRun } = await import('../modal-run.js')
const { applyRunpodRun } = await import('../runpod-run.js')
const { applyVastaiRun } = await import('../vastai-run.js')
const { guardSpend, ledgerFile, sessionSpend } = await import('../compute-ledger.js')
const hooks = await import('../academic-harness-hooks.js')
const { KEY_FIELDS } = await import('../settings-keys.js')

let passed = 0
async function check(label, fn) {
  rmSync(join(scratch, 'compute-ledger'), { recursive: true, force: true })
  delete process.env.COMPUTE_SESSION_CAP_USD
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL  ${label}\n${error.stack}`)
    process.exitCode = 1
  }
}
const rows = () => (existsSync(ledgerFile()) ? readFileSync(ledgerFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const exec = (id = 'sess-1', extra = {}) => ({ agent: { session: { header: { id, cwd: scratch } } }, signal: undefined, ...extra })

function toolsOf() {
  const tools = []
  const ctx = { tools: { register: (t) => tools.push(t) } }
  applyModalRun(ctx)
  applyRunpodRun(ctx)
  applyVastaiRun(ctx)
  return Object.fromEntries(tools.map((t) => [t.name, t]))
}
const tools = toolsOf()

await check('the cap is a Settings field', () => {
  assert.ok(KEY_FIELDS.includes('COMPUTE_SESSION_CAP_USD'))
})

await check('all three tools stay registered with their parameters and metadata', () => {
  assert.deepEqual(Object.keys(tools), ['modal_run', 'runpod_run', 'vastai_run'])
  for (const tool of Object.values(tools)) {
    assert.equal(typeof tool.execute, 'function')
    assert.ok(tool.parameters.properties.command)
    assert.ok(String(tool.description).length > 80)
  }
})

await check('a cap of $0 refuses every paid tool before anything is rented or configured', async () => {
  process.env.COMPUTE_SESSION_CAP_USD = '0'
  for (const [name, args] of [['modal_run', { command: 'x', instance: 'h100' }], ['runpod_run', { command: 'x', instance: 'h100' }], ['vastai_run', { command: 'x', instance: 'rtx4090', max_price_dph: 0.5 }]]) {
    const result = await tools[name].execute(args, exec())
    assert.equal(result.error, 'spend_cap_exceeded', name)
    assert.match(result.text, /Nothing was rented/)
    assert.match(result.text, /COMPUTE_SESSION_CAP_USD/)
  }
  assert.deepEqual(rows(), [], 'a refusal is not spend')
})

await check('a run that rents nothing (no credentials) costs $0 and is settled as not started', async () => {
  for (const [name, args] of [['modal_run', { command: 'x' }], ['runpod_run', { command: 'x' }], ['vastai_run', { command: 'x' }]]) {
    const result = await tools[name].execute(args, exec('sess-nc'))
    assert.equal(result.error, 'not_configured', name)
    assert.equal(result.spend.actual_usd, 0, name)
    assert.ok(result.spend.session_cap_usd === 10, 'the default cap applies')
  }
  assert.deepEqual(rows().map((r) => r.kind), ['intent', 'settled', 'intent', 'settled', 'intent', 'settled'])
  assert.deepEqual([...new Set(rows().filter((r) => r.kind === 'settled').map((r) => r.status))], ['not_started'])
  assert.equal(sessionSpend('sess-nc').spent, 0)
})

await check('guardSpend settles a successful run at its reported cost and attaches the spend block', async () => {
  const fake = guardSpend({ name: 'modal_run', execute: async () => ({ text: 'done', cost_usd: 0.3 }) }, 'Modal')
  const result = await fake.execute({ command: 'x', instance: 'h100', timeout_sec: 600 }, exec('sess-ok'))
  assert.equal(result.text, 'done')
  assert.equal(result.spend.actual_usd, 0.3)
  assert.ok(result.spend.estimated_max_usd >= 1.5, 'estimate comes from the catalog price')
  const settled = rows().at(-1)
  assert.deepEqual({ status: settled.status, actual: settled.actual_usd }, { status: 'ok', actual: 0.3 })
  assert.equal(sessionSpend('sess-ok').spent, 0.3)
})

await check('a run that fails after starting is charged for the time it ran, never more than its estimate', async () => {
  const fake = guardSpend({ name: 'runpod_run', execute: async () => { await new Promise((r) => setTimeout(r, 400)); return { error: 'runpod_failure', text: 'boom' } } }, 'Runpod')
  const result = await fake.execute({ command: 'x', instance: 'h100', timeout_sec: 600 }, exec('sess-fail'))
  assert.equal(result.error, 'runpod_failure')
  const settled = rows().at(-1)
  assert.equal(settled.status, 'failed')
  assert.ok(settled.actual_usd > 0 && settled.actual_usd < 0.01, `accrued ${settled.actual_usd}`)
})

await check('a thrown error still settles the ledger and is rethrown', async () => {
  const fake = guardSpend({ name: 'modal_run', execute: async () => { throw new Error('sdk exploded') } }, 'Modal')
  await assert.rejects(fake.execute({ command: 'x', instance: 'cpu' }, exec('sess-throw')), /sdk exploded/)
  assert.equal(rows().at(-1).kind, 'settled')
  assert.equal(rows().at(-1).status, 'failed')
})

await check('sequential runs add up against the cap, and the next one is refused once it would not fit', async () => {
  process.env.COMPUTE_SESSION_CAP_USD = '3'
  const fake = guardSpend({ name: 'modal_run', execute: async () => ({ text: 'ok', cost_usd: 1.4 }) }, 'Modal')
  const args = { command: 'x', instance: 'a100-40gb', timeout_sec: 600 } // ceiling about $0.93
  assert.equal((await fake.execute(args, exec('sess-seq'))).error, undefined)
  assert.equal((await fake.execute(args, exec('sess-seq'))).error, undefined)
  const third = await fake.execute(args, exec('sess-seq'))
  assert.equal(third.error, 'spend_cap_exceeded')
  assert.equal(third.spend.session_spent_usd, 2.8)
})

await check('a vast.ai run with no price ceiling is recorded as unpriced and not refused', async () => {
  process.env.COMPUTE_SESSION_CAP_USD = '1'
  const fake = guardSpend({ name: 'vastai_run', execute: async () => ({ text: 'ok', cost_usd: 0.4 }) }, 'Vast.ai')
  const result = await fake.execute({ command: 'x', instance: 'rtx4090' }, exec('sess-vast'))
  assert.equal(result.error, undefined)
  assert.equal(result.spend.price_known, false)
  assert.equal(rows()[0].est_usd, null)
  assert.equal(sessionSpend('sess-vast').spent, 0.4)
})

// ── the approval prompt ─────────────────────────────────────────────────────
process.env.ACADEMIC_HARNESS_SKIP_INSTALL = '1'
const host = fakeHost()
hooks.apply(host.ctx)
const agent = fakeAgent({ cwd: scratch, id: 'sess-ask' })
const allow = async () => ({ kind: 'allow' })
const pre = (name, args) => host.run('tools/pre-execute', { name, arguments: args, agent }, allow)

await check('the approval prompt shows what this session has spent against its cap', async () => {
  process.env.COMPUTE_SESSION_CAP_USD = '20'
  mkdirSync(join(scratch, 'compute-ledger'), { recursive: true })
  writeFileSync(ledgerFile(), `${JSON.stringify({ kind: 'intent', id: 'a', root_session: 'sess-ask', provider: 'Modal', est_usd: 6, tool: 'modal_run' })}\n${JSON.stringify({ kind: 'settled', id: 'a', actual_usd: 4.5, status: 'ok' })}\n`)
  const decision = await pre('modal_run', { command: 'x', instance: 'h100', timeout_sec: 600 })
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /\$4\.50 of a \$20\.00 session cap/)
  assert.match(decision.reason, /bring it to \$/)
})

await check('a run that cannot fit under the cap is denied in the listener, without asking the person', async () => {
  process.env.COMPUTE_SESSION_CAP_USD = '1'
  const decision = await pre('modal_run', { command: 'x', instance: 'h100', timeout_sec: 3600 })
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /Session spend cap reached/)
  assert.match(decision.reason, /Nothing was rented/)
})

await check('with the cap off, the prompt says so and still asks', async () => {
  process.env.COMPUTE_SESSION_CAP_USD = 'off'
  const decision = await pre('runpod_run', { command: 'x', instance: 'h100', timeout_sec: 3600 })
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /No session spend cap is set/)
})

rmSync(scratch, { recursive: true, force: true })
if (process.exitCode) console.error('compute spend guard: FAILED')
else console.log(`compute spend guard: ${passed} checks passed`)
