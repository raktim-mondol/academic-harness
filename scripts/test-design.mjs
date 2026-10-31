import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { apply, runDesignAction } from '../design.js'
import { balanceReport, readSchedule } from '../design-store.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const workspace = makeWorkspace('ah-design-')
const cwd = workspace.cwd
const exec = fakeExec(cwd)
let tool
apply({ tools: { register: (registered) => { tool = registered } } })
const run = (args) => tool.execute(args, exec)
const countByArm = (rows) => rows.reduce((out, row) => { out[row.arm] = (out[row.arm] || 0) + 1; return out }, {})

try {
  // Deterministic simple randomization.
  let result = await run({ action: 'randomize', slug: 'simple', method: 'simple', seed: 42, n: 8 })
  assert.equal(result.schedule.schedule_id, 's0001')
  assert.deepEqual(result.schedule.counts, { control: 4, treatment: 4 })
  const firstRows = result.schedule.rows
  result = await run({ action: 'randomize', slug: 'simple', method: 'simple', seed: 42, n: 8 })
  assert.deepEqual(result.schedule.rows, firstRows)
  result = await run({ action: 'randomize', slug: 'simple', method: 'simple', seed: 43, n: 8 })
  assert.notDeepEqual(result.schedule.rows, firstRows)
  assert.equal(new Set(result.schedule.rows.map((row) => row.allocation_code)).size, 8)
  assert.equal(new Set(Object.values(result.schedule.blinding)).size, 2)

  // Blocked randomization.
  result = await run({ action: 'randomize', slug: 'block', method: 'block', seed: 7, n: 8, block_size: 4 })
  assert.equal(result.schedule.rows.length, 8)
  assert.deepEqual([...new Set(result.schedule.rows.map((row) => row.block))], [1, 2])
  for (const block of [1, 2]) {
    const rows = result.schedule.rows.filter((row) => row.block === block)
    assert.deepEqual(countByArm(rows), { control: 2, treatment: 2 })
  }

  // Stratified randomization with two strata of four.
  result = await run({
    action: 'randomize', slug: 'stratified', method: 'stratified', seed: 9, n: 8,
    block_size: 4, strata: [{ name: 'site A', n: 4 }, { name: 'site B', n: 4 }],
  })
  assert.deepEqual([...new Set(result.schedule.rows.map((row) => row.stratum))].sort(), ['site A', 'site B'])
  assert.equal(result.schedule.rows.length, 8)

  // Cluster randomization.
  result = await run({
    action: 'randomize', slug: 'cluster', method: 'cluster', seed: 11,
    clusters: [{ id: 'c1', size: 10 }, { id: 'c2', size: 12 }, { id: 'c3', size: 9 }, { id: 'c4', size: 11 }],
  })
  assert.equal(result.schedule.rows.length, 4)
  assert.deepEqual(countByArm(result.schedule.rows), { control: 2, treatment: 2 })
  assert.equal(new Set(result.schedule.rows.map((row) => row.allocation_code)).size, 4)

  // Crossover with two sequences.
  result = await run({
    action: 'randomize', slug: 'crossover', method: 'crossover', seed: 3, n: 4,
    arms: ['A', 'B'], sequences: ['AB', 'BA'], washout: '7 days',
  })
  assert.equal(result.schedule.rows.length, 8)
  assert.equal(result.schedule.design.periods, 2)
  assert.deepEqual(countByArm(result.schedule.rows), { A: 4, B: 4 })
  assert.ok(result.schedule.rows.every((row) => row.washout === '7 days'))

  // Minimization with two prognostic factors.
  const participants = [
    { id: 'm1', factors: { sex: 'F', severity: 'high' } },
    { id: 'm2', factors: { sex: 'M', severity: 'low' } },
    { id: 'm3', factors: { sex: 'F', severity: 'low' } },
    { id: 'm4', factors: { sex: 'M', severity: 'high' } },
    { id: 'm5', factors: { sex: 'F', severity: 'high' } },
    { id: 'm6', factors: { sex: 'M', severity: 'low' } },
  ]
  result = await run({ action: 'randomize', slug: 'minimization', method: 'minimization', seed: 5, participants })
  assert.equal(result.schedule.rows.length, 6)
  assert.ok(result.schedule.rows.every((row) => ['control', 'treatment'].includes(row.arm)))
  assert.ok(result.schedule.rows.every((row) => row.factors && row.minimization_score >= 0))

  // Balance reports realized counts and an extreme covariate imbalance.
  result = await run({
    action: 'randomize', slug: 'balance', method: 'simple', seed: 1, n: 4,
    participants: [
      { id: 'b1', covariates: { age: 20 } },
      { id: 'b2', covariates: { age: 22 } },
      { id: 'b3', covariates: { age: 60 } },
      { id: 'b4', covariates: { age: 62 } },
    ],
  })
  result = await run({ action: 'balance', slug: 'balance', schedule_id: result.schedule.schedule_id })
  assert.equal(result.report.units, 4)
  assert.equal(result.report.numeric.length, 1)
  assert.equal(result.report.numeric[0].covariate, 'age')

  // A synthetic imbalanced schedule, independent of chance.
  const synthetic = {
    schedule_id: 'synthetic', kind: 'randomization', method: 'simple', seed: 1,
    arms: ['control', 'treatment'], allocation: [1, 1],
    rows: [
      { participant_id: 'x1', arm: 'control', covariates: { age: 20 } },
      { participant_id: 'x2', arm: 'control', covariates: { age: 21 } },
      { participant_id: 'x3', arm: 'treatment', covariates: { age: 60 } },
      { participant_id: 'x4', arm: 'treatment', covariates: { age: 61 } },
    ],
  }
  const syntheticReport = balanceReport(synthetic)
  assert.ok(syntheticReport.flags.some((flag) => flag.kind === 'standardized_mean_difference' && flag.covariate === 'age'))

  // Full factorial design.
  result = await run({ action: 'doe', slug: 'full', method: 'full_factorial', seed: 12, factors: [{ name: 'temperature', levels: [20, 30] }, { name: 'time', levels: [1, 2] }] })
  assert.equal(result.schedule.matrix.length, 4)
  assert.equal(new Set(result.schedule.matrix.map((row) => row.run_order)).size, 4)
  assert.equal(result.schedule.aliasing.resolution, 'full')

  // Fractional factorial: I = ABCD, resolution IV.
  result = await run({
    action: 'doe', slug: 'fraction', method: 'fractional_factorial', seed: 12,
    factors: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }], generators: ['D=ABC'],
  })
  assert.equal(result.schedule.matrix.length, 8)
  assert.equal(result.schedule.aliasing.resolution, 4)
  assert.ok(result.schedule.aliasing.defining_relation.includes('A*B*C*D'))
  assert.ok(result.schedule.matrix.every((row) => row.D === row.A * row.B * row.C), 'D must be the A*B*C interaction column')

  // Plackett–Burman.
  result = await run({ action: 'doe', slug: 'pb', method: 'plackett_burman', seed: 12, runs: 8, factors: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] })
  assert.equal(result.schedule.matrix.length, 8)
  assert.equal(result.schedule.aliasing.resolution, 'III')
  assert.ok(result.schedule.matrix.every((row) => ['A', 'B', 'C'].every((name) => row[name] === 1 || row[name] === -1)))
  assert.doesNotThrow(() => tool.output.render({}, result))

  // Central composite and Box–Behnken.
  result = await run({ action: 'doe', slug: 'ccd', method: 'central_composite', seed: 12, factors: [{ name: 'A' }, { name: 'B' }], center_points: 4 })
  assert.equal(result.schedule.matrix.length, 12)
  assert.ok(Math.abs(result.schedule.design.alpha - Math.SQRT2) < 1e-12)
  result = await run({ action: 'doe', slug: 'bbd', method: 'box_behnken', seed: 12, factors: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], center_points: 3 })
  assert.equal(result.schedule.matrix.length, 15)

  // Exports and status.
  result = await run({ action: 'export', slug: 'block', format: 'csv', overwrite: true })
  assert.match(result.result.path, /s0001\.csv$/)
  const csv = workspace.read('.dsh/design/block/exports/s0001.csv')
  assert.match(csv, /participant_id/)
  assert.match(csv, /control|treatment/)
  result = await run({ action: 'export', slug: 'fraction', format: 'csv', overwrite: true })
  const fractionCsv = workspace.read(`.dsh/design/fraction/exports/${result.result.schedule_id}.csv`)
  assert.ok(!fractionCsv.includes("'-1"), 'numeric -1 must not be treated as a formula-like text cell')
  assert.match(fractionCsv, /,-1/)
  result = await run({ action: 'export', slug: 'full', format: 'markdown', overwrite: true })
  assert.match(workspace.read(`.dsh/design/full/exports/${result.result.schedule_id}.md`), /Design schedule/)
  result = await run({ action: 'export', slug: 'full', format: 'json', overwrite: true })
  const exported = JSON.parse(workspace.read(`.dsh/design/full/exports/${result.result.schedule_id}.json`))
  assert.equal(exported.kind, 'doe')
  result = await run({ action: 'status', slug: 'simple' })
  assert.equal(result.status.schedules.length, 3)
  result = await run({ action: 'list', slug: 'simple' })
  assert.equal(result.schedules.length, 3)

  result = await run({ action: 'randomize', slug: 'bad-crossover', method: 'crossover', seed: 1, n: 10, arms: ['A', 'B'], sequences: ['AB', 'BA'], n_per_sequence: 3 })
  assert.match(result.error, /sums to 6/)

  // Seed is required and the ledger is readable.
  result = await run({ action: 'randomize', slug: 'no-seed', method: 'simple', n: 4 })
  assert.match(result.error, /seed/)
  assert.ok(existsSync(workspace.path('.dsh/design/simple/schedules.jsonl')))
  assert.equal(readSchedule(cwd, 'simple').schedule_id, 's0003')

  console.log('design OK')
} finally {
  workspace.cleanup()
}
