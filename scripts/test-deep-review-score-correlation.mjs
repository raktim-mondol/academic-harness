// Offline tests for the Phase 0 score-correlation metrics. No store, no network.
import assert from 'node:assert/strict'
import { auc, mean, pointBiserial, scoreCorrelation } from './calibration-metrics.mjs'

assert.equal(mean([1, 2, 3]), 2)
assert.equal(mean([]), null)

// Perfect separation: accepted scores above rejected scores.
const perfectX = [1, 1, 0, 0]
const perfectY = [5, 4, 2, 1]
assert.equal(pointBiserial(perfectX, perfectY), 0.949)
assert.equal(auc([5, 4], [2, 1]), 1)

// Reversed separation.
assert.equal(pointBiserial(perfectX, [1, 2, 4, 5]), -0.949)
assert.equal(auc([1, 2], [4, 5]), 0)

// Ties count as half a win and make a flat predictor uninformative.
assert.equal(auc([3], [3]), 0.5)
assert.equal(pointBiserial([1, 1, 0, 0], [3, 3, 3, 3]), null)
assert.equal(pointBiserial([1, 1], [4, 5]), null, 'constant predictor is undefined')

const rows = [
  { bucket: 'accept', score: 4, evaluator_kind: 'held_out' },
  { bucket: 'accept', score: 5, evaluator_kind: 'in_distribution' },
  { bucket: 'reject', score: 2, evaluator_kind: 'held_out' },
  { bucket: 'reject', score: 1, evaluator_kind: 'held_out' },
  { bucket: 'reject', score: 2, evaluator_kind: 'in_distribution' },
  { bucket: 'accept', score: 4, evaluator_kind: 'held_out' },
]
const measured = scoreCorrelation(rows, { min: 6 })
assert.equal(measured.verdict.startsWith('measured'), true)
assert.equal(measured.scored, 6)
assert.equal(measured.accepts, 3)
assert.equal(measured.rejects, 3)
assert.equal(measured.held_out, 4)
assert.equal(measured.in_distribution, 2)
assert.equal(measured.auc, 1)
assert.ok(measured.point_biserial_r > 0.9)

const tooSmall = scoreCorrelation(rows.slice(0, 3), { min: 6 })
assert.match(tooSmall.verdict, /^not_checked/)
assert.equal(tooSmall.auc, null)

const oneClass = scoreCorrelation([
  { bucket: 'accept', score: 4 },
  { bucket: 'accept', score: 3 },
  { bucket: 'accept', score: 5 },
  { bucket: 'accept', score: 4 },
  { bucket: 'accept', score: 3 },
  { bucket: 'accept', score: 5 },
], { min: 6 })
assert.match(oneClass.verdict, /^not_checked/)
assert.equal(oneClass.auc, null)

console.log('deep-review score correlation tests passed')
