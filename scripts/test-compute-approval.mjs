#!/usr/bin/env node
/**
 * Paid-compute approval: the tools/pre-execute listener must answer `ask` for
 * modal_run, runpod_run and vastai_run on every call (review A2, decisions
 * D11/D12), with a reason that shows what is being rented and the cost ceiling.
 * ah_author keeps asking, and ordinary tools are left alone.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeAgent, fakeHost } from './helpers/fake-host.mjs'
import { makeWorkspace } from './helpers/test-workspace.mjs'

process.env.ACADEMIC_HARNESS_SKIP_INSTALL = '1'
const hooks = await import('../academic-harness-hooks.js')
const { computeApprovalReason, describeComputeCall, PAID_COMPUTE_TOOLS } = await import('../compute-approval.js')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ws = makeWorkspace('ah-compute-approval-')
const host = fakeHost()
hooks.apply(host.ctx)
const agent = fakeAgent({ cwd: ws.cwd })
const allow = async () => ({ kind: 'allow' })
const preExecute = (name, args) => host.run('tools/pre-execute', { name, arguments: args, agent }, allow)

let passed = 0
function check(label, fn) {
  return Promise.resolve(fn()).then(() => { passed += 1 }, (error) => {
    console.error(`FAIL  ${label}\n${error.stack}`)
    process.exitCode = 1
  })
}

await check('the three paid tools are exactly the approval list', () => {
  assert.deepEqual([...PAID_COMPUTE_TOOLS].sort(), ['modal_run', 'runpod_run', 'vastai_run'])
})

for (const name of PAID_COMPUTE_TOOLS) {
  await check(`${name} asks, and asks again on a second call`, async () => {
    for (let i = 0; i < 2; i += 1) {
      const decision = await preExecute(name, { command: 'python train.py', timeout_sec: 120 })
      assert.equal(decision.kind, 'ask', `${name} call ${i + 1} should ask`)
      assert.match(decision.reason, /python train\.py/)
      assert.match(decision.reason, /Confirm/)
    }
  })
}

await check('modal H100 reason shows provider, instance and a ceiling from the catalog', () => {
  const reason = computeApprovalReason('modal_run', { instance: 'h100', timeout_sec: 3600, command: 'nvidia-smi' })
  assert.match(reason, /Modal/)
  assert.match(reason, /"h100"/)
  assert.match(reason, /\$4\.56/)
})

await check('timeout is clamped the same way the tool clamps it', () => {
  const huge = describeComputeCall('runpod_run', { instance: 'h100', timeout_sec: 999999 })
  assert.equal(huge.timeoutS, 3600)
  assert.ok(Math.abs(huge.maxUsd - 2.99) < 1e-9)
  const tiny = describeComputeCall('runpod_run', { instance: 'h100', timeout_sec: -5 })
  assert.equal(tiny.timeoutS, 1)
  const missing = describeComputeCall('modal_run', {})
  assert.equal(missing.timeoutS, 600)
  assert.equal(missing.instance, 'cpu')
})

await check('vast.ai with no ceiling says the price is unknown', () => {
  const info = describeComputeCall('vastai_run', { instance: 'rtx4090' })
  assert.equal(info.pricePerHour, null)
  assert.equal(info.maxUsd, null)
  assert.match(computeApprovalReason('vastai_run', { instance: 'rtx4090' }), /cannot be estimated/)
})

await check('vast.ai ceiling and bid give a ceiling, a pinned offer does not', () => {
  assert.equal(describeComputeCall('vastai_run', { max_price_dph: 0.5, timeout_sec: 3600 }).maxUsd, 0.5)
  assert.equal(describeComputeCall('vastai_run', { bid_price: 0.2, timeout_sec: 1800 }).maxUsd, 0.1)
  const pinned = describeComputeCall('vastai_run', { offer_id: 77, max_price_dph: 0.5 })
  assert.equal(pinned.maxUsd, null)
  assert.match(pinned.priceNote, /pinned offer 77/)
})

await check('an unknown modal instance does not throw and flags the price', () => {
  const reason = computeApprovalReason('modal_run', { instance: 'warp-drive' })
  assert.match(reason, /cannot be estimated/)
})

await check('long commands are previewed, not dumped', () => {
  const reason = computeApprovalReason('modal_run', { command: `echo ${'x'.repeat(2000)}` })
  assert.ok(reason.length < 900, `reason too long: ${reason.length}`)
})

await check('ah_author still asks', async () => {
  const decision = await preExecute('ah_author', {})
  assert.equal(decision.kind, 'ask')
})

await check('ordinary tools pass through to the next handler', async () => {
  const decision = await preExecute('read', { file_path: join(ws.cwd, 'x.txt') })
  assert.deepEqual(decision, { kind: 'allow' })
  assert.deepEqual(await preExecute('analysis_run', { action: 'status' }), { kind: 'allow' })
})

await check('the new module ships in the npm package', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.files.includes('compute-approval.js'))
})

ws.cleanup()
if (process.exitCode) {
  console.error('compute approval: FAILED')
} else {
  console.log(`compute approval: ${passed} checks passed`)
}
