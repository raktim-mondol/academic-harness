#!/usr/bin/env node
/**
 * Decisions D26 and D28: a per-session spend cap and one spend ledger across
 * Modal, Runpod and Vast.ai, with an estimate shown before a paid run starts.
 *
 * The ledger is append-only JSONL under $DSH_HOME/compute-ledger/. A run writes
 * an intent (with its estimated ceiling) BEFORE anything is rented, under a
 * lock, so concurrent sub-agents cannot both pass a cap that only one fits
 * under; it writes a settlement when the run ends, whatever happened.
 */
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(homedir(), '.cache', 'ah-ledger-test-'))
process.env.DSH_HOME = scratch
delete process.env.COMPUTE_SESSION_CAP_USD

const ledger = await import('../compute-ledger.js')
const {
  DEFAULT_SESSION_CAP_USD, PROVISION_ALLOWANCE_S, beginPaidRun, endPaidRun, estimateRunUsd, ledgerFile, parseSessionCap, reserveSpend, sessionSpend, settleSpend,
} = ledger

let passed = 0
async function check(label, fn) {
  rmSync(join(scratch, 'compute-ledger'), { recursive: true, force: true })
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL  ${label}\n${error.stack}`)
    process.exitCode = 1
  }
}
const exec = (id, parent) => ({ agent: { session: { header: { id, ...(parent ? { parentSession: parent } : {}) } } } })
const rows = () => (existsSync(ledgerFile()) ? readFileSync(ledgerFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

await check('the cap setting: default 10, a number, or off; bad values fall back with a warning', () => {
  assert.deepEqual(parseSessionCap(undefined), { cap: DEFAULT_SESSION_CAP_USD })
  assert.equal(DEFAULT_SESSION_CAP_USD, 10)
  assert.deepEqual(parseSessionCap('25'), { cap: 25 })
  assert.deepEqual(parseSessionCap(' 2.5 '), { cap: 2.5 })
  assert.deepEqual(parseSessionCap('0'), { cap: 0 })
  for (const off of ['off', 'OFF', 'none', 'unlimited']) assert.deepEqual(parseSessionCap(off), { cap: null })
  for (const bad of ['abc', '-5', 'NaN', '1e999']) {
    const result = parseSessionCap(bad)
    assert.equal(result.cap, DEFAULT_SESSION_CAP_USD, bad)
    assert.match(result.warning, /COMPUTE_SESSION_CAP_USD/)
  }
})

await check('an estimate is price x (command time + a provisioning allowance), rounded up to the cent', () => {
  assert.equal(PROVISION_ALLOWANCE_S, 600)
  assert.equal(estimateRunUsd({ pricePerHour: 3.6, timeoutS: 3000 }), 3.6)           // 3.6 * 3600 s / 3600
  assert.equal(estimateRunUsd({ pricePerHour: 0.05, timeoutS: 60 }), 0.01)           // never rounds a real cost to zero
  assert.equal(estimateRunUsd({ pricePerHour: null, timeoutS: 600 }), null)         // unknown price: no estimate
  assert.equal(estimateRunUsd({ pricePerHour: 0, timeoutS: 600 }), 0)
})

await check('a reservation inside the cap is recorded before anything runs, and counts immediately', async () => {
  const r = await reserveSpend({ rootSession: 's1', tool: 'modal_run', provider: 'Modal', instance: 'h100', estUsd: 4, capUsd: 10 })
  assert.equal(r.ok, true)
  assert.equal(r.spentBefore, 0)
  assert.equal(rows().length, 1)
  assert.deepEqual({ kind: rows()[0].kind, session: rows()[0].root_session, est: rows()[0].est_usd, provider: rows()[0].provider }, { kind: 'intent', session: 's1', est: 4, provider: 'Modal' })
  assert.equal(sessionSpend('s1').spent, 4)
})

await check('a reservation that would pass the cap is refused and writes nothing', async () => {
  await reserveSpend({ rootSession: 's1', tool: 'modal_run', provider: 'Modal', instance: 'h100', estUsd: 8, capUsd: 10 })
  const refused = await reserveSpend({ rootSession: 's1', tool: 'runpod_run', provider: 'Runpod', instance: 'h100', estUsd: 3, capUsd: 10 })
  assert.equal(refused.ok, false)
  assert.deepEqual({ spent: refused.spent, cap: refused.cap, remaining: refused.remaining }, { spent: 8, cap: 10, remaining: 2 })
  assert.equal(rows().length, 1, 'a refused run must not be recorded as spend')
  const exact = await reserveSpend({ rootSession: 's1', tool: 'runpod_run', provider: 'Runpod', instance: 'a40', estUsd: 2, capUsd: 10 })
  assert.equal(exact.ok, true, 'spending exactly up to the cap is allowed')
})

await check('five concurrent reservations of $4 under a $10 cap: exactly two get through', async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => reserveSpend({ rootSession: 'race', tool: 'vastai_run', provider: 'Vast.ai', instance: 'rtx4090', estUsd: 4, capUsd: 10 })))
  assert.equal(results.filter((r) => r.ok).length, 2)
  assert.equal(sessionSpend('race').spent, 8)
})

await check('sessions are independent, and a sub-agent counts against its root session', async () => {
  await reserveSpend({ rootSession: 'a', tool: 'modal_run', provider: 'Modal', instance: 'cpu', estUsd: 9, capUsd: 10 })
  const other = await reserveSpend({ rootSession: 'b', tool: 'modal_run', provider: 'Modal', instance: 'cpu', estUsd: 9, capUsd: 10 })
  assert.equal(other.ok, true)
  const viaChild = await beginPaidRun(exec('child', 'a'), { tool: 'runpod_run', provider: 'Runpod', instance: 'h100', pricePerHour: 2.99, timeoutS: 1800, capUsd: 10, rootSession: 'a' })
  assert.ok(viaChild.refused, 'the child shares its root session\'s budget')
})

await check('settlement replaces the estimate with the actual cost', async () => {
  const r = await reserveSpend({ rootSession: 's', tool: 'modal_run', provider: 'Modal', instance: 'h100', estUsd: 4, capUsd: 10 })
  await settleSpend({ id: r.id, actualUsd: 0.76, status: 'ok', durationS: 600 })
  assert.equal(sessionSpend('s').spent, 0.76)
  const next = await reserveSpend({ rootSession: 's', tool: 'modal_run', provider: 'Modal', instance: 'h100', estUsd: 9, capUsd: 10 })
  assert.equal(next.ok, true, 'the freed headroom is usable')
})

await check('an unsettled run (a crash) keeps counting at its estimate; settling twice changes nothing more', async () => {
  const r = await reserveSpend({ rootSession: 'crash', tool: 'modal_run', provider: 'Modal', instance: 'h100', estUsd: 5, capUsd: 10 })
  assert.equal(sessionSpend('crash').spent, 5)
  await settleSpend({ id: r.id, actualUsd: 1, status: 'ok' })
  await settleSpend({ id: r.id, actualUsd: 9, status: 'ok' })
  assert.equal(sessionSpend('crash').spent, 1, 'the first settlement stands')
})

await check('an unpriced run (no known price) is recorded and never blocks, and is flagged', async () => {
  const r = await reserveSpend({ rootSession: 'u', tool: 'vastai_run', provider: 'Vast.ai', instance: 'rtx4090', estUsd: null, capUsd: 1 })
  assert.equal(r.ok, true)
  assert.equal(sessionSpend('u').spent, 0)
  assert.equal(sessionSpend('u').unpriced, 1)
  await settleSpend({ id: r.id, actualUsd: 0.4, status: 'ok' })
  assert.equal(sessionSpend('u').spent, 0.4)
  assert.equal(sessionSpend('u').unpriced, 0)
})

await check('no cap (null) records spend but never refuses', async () => {
  const r = await reserveSpend({ rootSession: 'free', tool: 'modal_run', provider: 'Modal', instance: 'h100', estUsd: 1000, capUsd: null })
  assert.equal(r.ok, true)
  assert.equal(sessionSpend('free').spent, 1000)
})

await check('a damaged ledger line is skipped, not fatal, and does not disable the cap', async () => {
  await reserveSpend({ rootSession: 'd', tool: 'modal_run', provider: 'Modal', instance: 'h100', estUsd: 6, capUsd: 10 })
  appendFileSync(ledgerFile(), '{this is not json\n')
  assert.equal(sessionSpend('d').spent, 6)
  assert.equal(sessionSpend('d').skipped, 1)
  assert.equal((await reserveSpend({ rootSession: 'd', tool: 'modal_run', provider: 'Modal', instance: 'h100', estUsd: 6, capUsd: 10 })).ok, false)
})

await check('the ledger holds every provider in one file', async () => {
  for (const [tool, provider] of [['modal_run', 'Modal'], ['runpod_run', 'Runpod'], ['vastai_run', 'Vast.ai']]) {
    await reserveSpend({ rootSession: 'all', tool, provider, instance: 'x', estUsd: 1, capUsd: 10 })
  }
  assert.deepEqual(rows().map((r) => r.provider), ['Modal', 'Runpod', 'Vast.ai'])
  assert.equal(sessionSpend('all').spent, 3)
  assert.ok(ledgerFile().startsWith(scratch))
})

await check('beginPaidRun refuses with the numbers and how to raise the cap; endPaidRun settles', async () => {
  const first = await beginPaidRun(exec('s9'), { tool: 'modal_run', provider: 'Modal', instance: 'h100', pricePerHour: 4.56, timeoutS: 3600, capUsd: 2 })
  assert.ok(first.refused)
  assert.equal(first.refused.error, 'spend_cap_exceeded')
  assert.match(first.refused.text, /\$2\.00/)
  assert.match(first.refused.text, /COMPUTE_SESSION_CAP_USD/)
  assert.deepEqual(rows(), [])
  const ok = await beginPaidRun(exec('s9'), { tool: 'modal_run', provider: 'Modal', instance: 'cpu', pricePerHour: 0.05, timeoutS: 600, capUsd: 2 })
  assert.ok(ok.reservation)
  assert.equal(ok.reservation.spend.session_cap_usd, 2)
  assert.ok(ok.reservation.spend.estimated_max_usd > 0)
  await endPaidRun(ok.reservation, { costUsd: 0.01, status: 'ok', durationMs: 12_000 })
  assert.equal(sessionSpend('s9').spent, 0.01)
  const settled = rows().at(-1)
  assert.deepEqual({ kind: settled.kind, status: settled.status, actual: settled.actual_usd, seconds: settled.duration_s }, { kind: 'settled', status: 'ok', actual: 0.01, seconds: 12 })
})

rmSync(scratch, { recursive: true, force: true })
if (process.exitCode) console.error('compute ledger: FAILED')
else console.log(`compute ledger: ${passed} checks passed`)
