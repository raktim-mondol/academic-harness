import assert from 'node:assert/strict'
import {
  cohenKappa, normalizeReviewer, resolveSeries, reviewerKey, reviewerType, summarizeAgreement,
} from '../agreement.js'

const near = (actual, expected, message, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} != ${expected}`)
}
const codes = (result) => result.caveats.map((item) => item.code)

// Reviewer identity
assert.equal(normalizeReviewer(null), null)
assert.equal(normalizeReviewer('   '), null)
assert.equal(normalizeReviewer(' alice '), 'human:alice')
assert.equal(normalizeReviewer('AI: GPT-X '), 'ai:GPT-X')
assert.equal(normalizeReviewer('human:Bob'), 'human:Bob')
assert.equal(normalizeReviewer('default'), null)
assert.throws(() => normalizeReviewer('human:default'))
assert.throws(() => normalizeReviewer('ai:'))
assert.equal(reviewerKey('Alice'), 'human:alice')
assert.equal(reviewerKey('AI:GPT'), 'ai:gpt')
assert.equal(reviewerKey(null), 'default')
assert.equal(reviewerType('default'), 'human')
assert.equal(reviewerType('ai:gpt'), 'ai')

// Cohen's kappa: nominal 5-unit fixture
const nominal = cohenKappa([
  ['include', 'include'],
  ['include', 'exclude'],
  ['exclude', 'exclude'],
  ['maybe', 'maybe'],
  ['exclude', 'exclude'],
], { categories: ['include', 'exclude', 'maybe'] })
near(nominal.percent_agreement, 0.8, 'nominal Po')
near(nominal.expected_agreement, 0.36, 'nominal Pe')
near(nominal.kappa, 0.6875, 'nominal kappa')
near(nominal.se, 0.2795084971874737, 'nominal SE')
near(nominal.ci[0], 0.13966334551255155, 'nominal CI low')
assert.equal(nominal.ci[1], 1)
assert.equal(nominal.ci_clipped, true)
assert.equal(nominal.undefined_reason, null)

// Weighted kappa: ordinal 4-unit fixture
const ordinalPairs = [['low', 'low'], ['low', 'some'], ['some', 'some'], ['high', 'high']]
const quadratic = cohenKappa(ordinalPairs, { categories: ['low', 'some', 'high'], weighting: 'quadratic' })
near(quadratic.percent_agreement, 0.75, 'quadratic Po')
near(quadratic.weighted_agreement, 0.9375, 'quadratic Po_w')
near(quadratic.expected_agreement, 0.6875, 'quadratic Pe_w')
near(quadratic.kappa, 0.8, 'quadratic kappa')
const linear = cohenKappa(ordinalPairs, { categories: ['low', 'some', 'high'], weighting: 'linear' })
near(linear.weighted_agreement, 0.875, 'linear Po_w')
near(linear.expected_agreement, 0.5625, 'linear Pe_w')
near(linear.kappa, 0.7142857142857143, 'linear kappa')
near(quadratic.se, 0.3872983346207417, 'quadratic SE')
near(quadratic.ci[0], 0.04089526414334632, 'quadratic CI low')
assert.equal(quadratic.ci[1], 1)
assert.equal(quadratic.ci_clipped, true)
near(linear.se, 0.3779644730092272, 'linear SE')
near(linear.ci[0], -0.02652465281237153, 'linear CI low')
near(linear.ci[1], 1, 'linear CI high')
assert.equal(linear.ci_clipped, true)
assert.throws(() => cohenKappa([['a', 'a']], { categories: ['a', 'b'], weighting: 'cubic' }), /weighting must be one of/)
assert.throws(() => summarizeAgreement({ ratings: [], categories: ['a', 'b'], weighting: 'cubic' }), /weighting must be one of/)

// Unused category keeps K for weighting
const unused = cohenKappa([
  ['include', 'include'],
  ['include', 'exclude'],
  ['exclude', 'exclude'],
  ['include', 'include'],
], { categories: ['include', 'exclude', 'maybe'] })
near(unused.percent_agreement, 0.75, 'unused Po')
near(unused.expected_agreement, 0.5, 'unused Pe')
near(unused.kappa, 0.5, 'unused kappa')

// Degenerate cases
const allLow = cohenKappa(Array.from({ length: 10 }, () => ['low', 'low']), { categories: ['low', 'some', 'high'] })
near(allLow.percent_agreement, 1, 'all-low Po')
near(allLow.expected_agreement, 1, 'all-low Pe')
assert.equal(allLow.kappa, null)
assert.equal(allLow.undefined_reason, 'expected_agreement_one')
const allDifferent = cohenKappa(Array.from({ length: 10 }, () => ['low', 'high']), { categories: ['low', 'some', 'high'] })
near(allDifferent.expected_agreement, 0, 'all-different Pe')
near(allDifferent.kappa, 0, 'all-different kappa')
assert.equal(cohenKappa([], { categories: ['a', 'b'] }).undefined_reason, 'no_common_units')
assert.equal(cohenKappa([['a', 'a']], { categories: ['a'] }).undefined_reason, 'single_category')

// Series resolution
const valueOf = (event) => event.decision
const pending = resolveSeries([], { valueOf })
assert.equal(pending.state, 'pending')
const single = resolveSeries([{ reviewer: 'alice', decision: 'include' }], { valueOf })
assert.equal(single.state, 'single')
assert.equal(single.value, 'include')
assert.equal(single.by_reviewer[0].reviewer_key, 'human:alice')
const legacy = resolveSeries([{ decision: 'include' }], { valueOf })
assert.equal(legacy.by_reviewer[0].reviewer_key, 'default')
const unanimous = resolveSeries([
  { reviewer: 'alice', decision: 'include' },
  { reviewer: 'bob', decision: 'include' },
], { valueOf })
assert.equal(unanimous.state, 'unanimous')
const conflict = resolveSeries([
  { reviewer: 'alice', decision: 'include' },
  { reviewer: 'bob', decision: 'exclude' },
], { valueOf })
assert.equal(conflict.state, 'conflict')
assert.equal(conflict.conflict.by_reviewer.length, 2)
const incomplete = resolveSeries([
  { reviewer: 'alice', decision: 'include' },
  { reviewer: 'bob', decision: 'include' },
], { valueOf, expectedReviewers: ['alice', 'bob', 'carol'] })
assert.equal(incomplete.state, 'incomplete')
assert.deepEqual(incomplete.missing_reviewers, ['human:carol'])
const reconciled = resolveSeries([
  { reviewer: 'alice', decision: 'include' },
  { reviewer: 'bob', decision: 'exclude' },
  { kind: 'reconcile', reviewer: 'carol', decision: 'include', reason: 'consensus' },
], { valueOf })
assert.equal(reconciled.state, 'reconciled')
assert.equal(reconciled.value, 'include')
const reopened = resolveSeries([
  { reviewer: 'alice', decision: 'include' },
  { reviewer: 'bob', decision: 'exclude' },
  { kind: 'reconcile', reviewer: 'carol', decision: 'include', reason: 'consensus' },
  { reviewer: 'bob', decision: 'exclude' },
], { valueOf })
assert.equal(reopened.state, 'reopened')
assert.equal(reopened.value, null)
const reReconciled = resolveSeries([
  { reviewer: 'alice', decision: 'include' },
  { reviewer: 'bob', decision: 'exclude' },
  { kind: 'reconcile', reviewer: 'carol', decision: 'include', reason: 'consensus' },
  { reviewer: 'bob', decision: 'exclude' },
  { kind: 'reconcile', reviewer: 'carol', decision: 'exclude', reason: 'second consensus' },
], { valueOf })
assert.equal(reReconciled.state, 'reconciled')
assert.equal(reReconciled.value, 'exclude')
const reconciledMissing = resolveSeries([
  { reviewer: 'alice', decision: 'include' },
  { reviewer: 'bob', decision: 'exclude' },
  { kind: 'reconcile', reviewer: 'carol', decision: 'include', reason: 'consensus' },
], { valueOf, expectedReviewers: ['alice', 'bob', 'dave'] })
assert.equal(reconciledMissing.state, 'incomplete')
assert.deepEqual(reconciledMissing.missing_reviewers, ['human:dave'])

// Pairwise, AI separation, caveats
const rows = []
const add = (unit, reviewer, value) => rows.push({ unit, reviewer, value })
const alice = ['include', 'include', 'exclude', 'exclude']
const bob = ['include', 'exclude', 'exclude', 'exclude']
const gpt = ['exclude', 'include', 'exclude', 'include']
for (let i = 0; i < 4; i += 1) {
  add(`u${i + 1}`, 'human:alice', alice[i])
  add(`u${i + 1}`, 'human:bob', bob[i])
  add(`u${i + 1}`, 'ai:gpt-x', gpt[i])
}
const summary = summarizeAgreement({ ratings: rows, categories: ['include', 'exclude', 'maybe'] })
near(summary.human.primary.kappa, 0.5, 'human-only kappa')
assert.equal(summary.ai_vs_human.pairs.length, 2)
assert.equal(summary.ai_vs_ai.pairs.length, 0)
assert.ok(summary.human.pairs.every((pair) => pair.raters.every((name) => !name.startsWith('ai:'))))
assert.deepEqual(summary.raters.human, ['human:alice', 'human:bob'])
assert.deepEqual(summary.raters.ai, ['ai:gpt-x'])
assert.ok(codes(summary).includes('ai_separated'))

const threeHumans = []
for (const [reviewer, values] of [
  ['human:alice', alice], ['human:bob', bob], ['human:carol', ['include', 'include', 'include', 'exclude']],
]) {
  values.forEach((value, index) => threeHumans.push({ unit: `u${index + 1}`, reviewer, value }))
}
const triple = summarizeAgreement({ ratings: threeHumans, categories: ['include', 'exclude', 'maybe'] })
assert.equal(triple.human.pairs.length, 3)
assert.equal(triple.human.primary, null)
assert.ok(codes(triple).includes('pairwise_only'))

const skewed = []
for (let i = 1; i <= 10; i += 1) {
  skewed.push({ unit: `s${i}`, reviewer: 'human:a', value: i <= 9 ? 'include' : 'exclude' })
  skewed.push({ unit: `s${i}`, reviewer: 'human:b', value: i <= 8 ? 'include' : i === 9 ? 'exclude' : 'include' })
}
const skewedSummary = summarizeAgreement({ ratings: skewed, categories: ['include', 'exclude', 'maybe'] })
assert.ok(skewedSummary.human.primary.percent_agreement >= 0.8)
assert.ok(skewedSummary.human.primary.kappa < 0.4)
assert.ok(codes(skewedSummary).includes('high_agreement_low_kappa'))

const biased = []
for (let i = 1; i <= 10; i += 1) {
  biased.push({ unit: `b${i}`, reviewer: 'human:a', value: 'include' })
  biased.push({ unit: `b${i}`, reviewer: 'human:b', value: i <= 7 ? 'include' : 'exclude' })
}
const biasedSummary = summarizeAgreement({ ratings: biased, categories: ['include', 'exclude', 'maybe'] })
assert.ok(codes(biasedSummary).includes('rater_bias_possible'))

const invalidRows = [{ unit: 'x1', reviewer: 'human:a', value: 'bogus' }, { unit: 'x1', reviewer: 'human:b', value: 'include' }]
const invalidSummary = summarizeAgreement({ ratings: invalidRows, categories: ['include', 'exclude'] })
assert.equal(invalidSummary.dropped.invalid, 1)
assert.equal(invalidSummary.human.pairs.length, 0)
assert.equal(invalidSummary.human.primary, null)

const duplicateRatings = summarizeAgreement({
  ratings: [
    { unit: 'u1', reviewer: 'human:a', value: 'include' },
    { unit: 'u1', reviewer: 'human:a', value: 'exclude' },
    { unit: 'u1', reviewer: 'human:b', value: 'exclude' },
  ],
  categories: ['include', 'exclude'],
})
assert.equal(duplicateRatings.human.primary.percent_agreement, 1, 'the last per-reviewer rating wins')

console.log('agreement OK')
