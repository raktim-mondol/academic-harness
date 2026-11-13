#!/usr/bin/env node
/**
 * Review B6 (decision D24): the experimental-feedback reward was a keyword count, so
 * "did not improve survival; no significant effect" scored 0 (a draw, rating
 * unchanged) while "Replication failed. No significant effect" lost 175 points,
 * and "It does not fail under load." scored -1. The caller now states the outcome
 * (supports / refutes / inconclusive); the keyword reading is a fallback that says
 * it is one.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const {
  FEEDBACK_OUTCOMES, REWARD_WIN_THRESHOLD, extractRewardFromFeedback, extractRewardFromOutcome, feedbackSentiment,
} = await import('../coscientist-models.js')
const { addHypothesis, deriveState, recordFeedback, startTournament } = await import('../coscientist-store.js')
const rankModule = await import('../coscientist-rank.js')

let passed = 0
async function check(label, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL  ${label}\n${error.stack}`)
    process.exitCode = 1
  }
}

const NEGATED = 'The treatment did not improve survival; no significant effect was observed.'
const PLAIN_FAIL = 'Replication failed. No significant effect was observed.'
const DOUBLE_NEGATIVE = 'It does not fail under load.'

// ── the reward from a stated outcome ─────────────────────────────────────────
await check('the outcomes are exactly supports, refutes and inconclusive', () => {
  assert.deepEqual(FEEDBACK_OUTCOMES, ['supports', 'refutes', 'inconclusive'])
})

await check('with no scores, the outcome alone sets the reward: +1, -1, 0', () => {
  assert.equal(extractRewardFromOutcome('supports'), 1)
  assert.equal(extractRewardFromOutcome('refutes'), -1)
  assert.equal(extractRewardFromOutcome('inconclusive'), 0)
})

await check('with scores, the outcome sets the direction and the scores moderate it (0.4 / 0.6, as before)', () => {
  assert.ok(Math.abs(extractRewardFromOutcome('refutes', 5, 5, 5) - (0.4 * -1 + 0.6 * (15 / 30 - 1))) < 1e-12)
  assert.ok(extractRewardFromOutcome('refutes', 5, 5, 5) < -REWARD_WIN_THRESHOLD, 'a refutation with middling scores is a loss')
  assert.ok(extractRewardFromOutcome('refutes', 10, 10, 10) < -REWARD_WIN_THRESHOLD, 'even perfect scores cannot turn a refutation into a draw')
  assert.ok(extractRewardFromOutcome('supports', 10, 10, 10) > REWARD_WIN_THRESHOLD)
  assert.equal(extractRewardFromOutcome('inconclusive', 10, 10, 10), 0)
})

await check('the wording of the text no longer matters once an outcome is given', () => {
  for (const text of [NEGATED, PLAIN_FAIL, DOUBLE_NEGATIVE]) {
    // the old reading disagrees with itself across these; the outcome form does not take the text at all
    assert.equal(extractRewardFromOutcome('refutes', 5, 5, 5), extractRewardFromOutcome('refutes', 5, 5, 5), text)
  }
  assert.notEqual(extractRewardFromFeedback(NEGATED, 5, 5, 5), extractRewardFromFeedback(PLAIN_FAIL, 5, 5, 5), 'documenting the defect the outcome removes')
})

await check('an unknown outcome is an error, not a silent zero', () => {
  assert.throws(() => extractRewardFromOutcome('maybe'), /outcome must be one of supports, refutes, inconclusive/)
  assert.throws(() => extractRewardFromOutcome(undefined), /outcome must be one of/)
})

// ── the store ────────────────────────────────────────────────────────────────
const scratch = mkdtempSync(join(homedir(), '.cache', 'ah-cosc-outcome-'))
const hypothesis = (n) => ({
  title: `Distinct hypothesis number ${n} about cryptic exon inclusion`,
  summary: `Summary ${n} proposing a mechanism unique to variant ${n} in ALS motor neurons.`,
  content: `Claim ${n}: the mechanism differs from every other variant in a testable way.`,
  rationale: `Rationale ${n}.`,
  experimental_plan: `Plan ${n}.`,
  key_assumptions: ['A', 'B'],
  citations: ['Smith 2021 Cell'],
})
let counter = 0
async function fresh() {
  counter += 1
  const slug = `t${counter}`
  await startTournament({ cwd: scratch, slug, protocol: { goal: 'What explains the survival effect?', max_hypotheses: 8, step_budget: 30, seed: 7 } })
  const added = await addHypothesis({ cwd: scratch, slug, hypothesis: hypothesis(counter) })
  return { slug, id: added.hypothesis.id }
}

try {
  await check('the two phrasings of one negative finding now move a fresh rating identically (they were 175 points apart)', async () => {
    const a = await fresh()
    const b = await fresh()
    const one = await recordFeedback({ cwd: scratch, ...a, feedbackText: NEGATED, outcome: 'refutes', novelty: 5, correctness: 5, testability: 5 })
    const two = await recordFeedback({ cwd: scratch, ...b, feedbackText: PLAIN_FAIL, outcome: 'refutes', novelty: 5, correctness: 5, testability: 5 })
    assert.equal(one.rating_after, two.rating_after)
    assert.ok(one.rating_after < one.rating_before, 'a refutation lowers the rating')
    assert.equal(one.reward_basis, 'outcome')
    assert.equal(one.warning, undefined)
  })

  await check('the old behaviour, reproduced without an outcome: the negated phrasing is a draw, and the result says so', async () => {
    const a = await fresh()
    const b = await fresh()
    const negated = await recordFeedback({ cwd: scratch, ...a, feedbackText: NEGATED, novelty: 5, correctness: 5, testability: 5 })
    const plain = await recordFeedback({ cwd: scratch, ...b, feedbackText: PLAIN_FAIL, novelty: 5, correctness: 5, testability: 5 })
    assert.equal(negated.rating_after, negated.rating_before, 'the keyword reading scores this refutation as a draw')
    assert.ok(plain.rating_after < plain.rating_before)
    for (const result of [negated, plain]) {
      assert.equal(result.reward_basis, 'keywords')
      assert.match(result.warning, /keyword/i)
      assert.match(result.warning, /outcome/)
    }
  })

  await check('"It does not fail under load" with outcome=supports is a win, not a loss', async () => {
    const a = await fresh()
    const viaKeywords = await recordFeedback({ cwd: scratch, ...a, feedbackText: DOUBLE_NEGATIVE })
    assert.equal(viaKeywords.reward, -1, 'the keyword reading gets the sign wrong')
    const b = await fresh()
    const stated = await recordFeedback({ cwd: scratch, ...b, feedbackText: DOUBLE_NEGATIVE, outcome: 'supports' })
    assert.equal(stated.reward, 1)
    assert.ok(stated.rating_after > stated.rating_before)
  })

  await check('inconclusive is a draw whatever the text says', async () => {
    const a = await fresh()
    const result = await recordFeedback({ cwd: scratch, ...a, feedbackText: 'The assay failed, the readout was noisy and no conclusion is possible.', outcome: 'inconclusive' })
    assert.equal(result.reward, 0)
    assert.equal(result.rating_after, result.rating_before)
  })

  await check('the outcome and its basis are stored on the event and replayed into the hypothesis', async () => {
    const a = await fresh()
    await recordFeedback({ cwd: scratch, ...a, feedbackText: NEGATED, outcome: 'Refutes', recordedBy: 'wet-lab' })
    const event = readFileSync(join(scratch, '.dsh', 'coscientist', a.slug, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'feedback')
    assert.equal(event.outcome, 'refutes', 'normalised to lower case')
    assert.equal(event.reward_basis, 'outcome')
    assert.equal(typeof event.sentiment, 'number', 'the keyword reading is still recorded for audit')
    const entry = deriveState(scratch, a.slug).byId.get(a.id).feedback[0]
    assert.deepEqual({ outcome: entry.outcome, basis: entry.reward_basis }, { outcome: 'refutes', basis: 'outcome' })
  })

  await check('old events with no outcome still replay, as keyword-based', async () => {
    const a = await fresh()
    await recordFeedback({ cwd: scratch, ...a, feedbackText: PLAIN_FAIL })
    const entry = deriveState(scratch, a.slug).byId.get(a.id).feedback[0]
    assert.equal(entry.outcome ?? null, null)
    assert.equal(entry.reward_basis, 'keywords')
  })

  await check('a text that reads the opposite way to the stated outcome gets a note, and the outcome wins', async () => {
    const a = await fresh()
    const result = await recordFeedback({ cwd: scratch, ...a, feedbackText: 'Confirmed: the effect was robust and replicated in every line.', outcome: 'refutes' })
    assert.ok(result.reward < 0, 'the stated outcome decides')
    assert.match(result.note, /reads as positive.*outcome=refutes/i)
  })

  await check('an invalid outcome is rejected before anything is written', async () => {
    const a = await fresh()
    await assert.rejects(recordFeedback({ cwd: scratch, ...a, feedbackText: NEGATED, outcome: 'kind of' }), /outcome must be one of supports, refutes, inconclusive/)
    assert.equal(deriveState(scratch, a.slug).byId.get(a.id).feedback.length, 0)
  })

  // ── the tool ───────────────────────────────────────────────────────────────
  const tools = []
  rankModule.apply({ tools: { register: (t) => tools.push(t) } })
  const rank = tools.find((t) => t.name === 'coscientist_rank')
  const exec = { agent: { session: { header: { cwd: scratch } } } }
  const render = (value) => rank.output.render({}, value).map((part) => part.text).join('\n')

  await check('the tool schema offers outcome as an enum and the description asks for it', () => {
    assert.deepEqual(rank.parameters.properties.outcome.enum, ['supports', 'refutes', 'inconclusive'])
    assert.match(rank.description, /outcome/)
    assert.match(rank.parameters.properties.feedback_text.description + rank.parameters.properties.outcome.description, /supports|refutes/)
  })

  await check('the tool passes the outcome through and renders its basis', async () => {
    const a = await fresh()
    const value = await rank.execute({ action: 'feedback', slug: a.slug, id: a.id, feedback_text: NEGATED, outcome: 'refutes', novelty: 5, correctness: 5, testability: 5 }, exec)
    assert.equal(value.outcome, 'refutes')
    assert.equal(value.reward_basis, 'outcome')
    assert.ok(value.rating_after < value.rating_before)
    const shown = render(value)
    assert.match(shown, /outcome: refutes/)
    assert.match(shown, /refuted/)
  })

  await check('without an outcome the tool result carries the warning and the render shows it', async () => {
    const a = await fresh()
    const value = await rank.execute({ action: 'feedback', slug: a.slug, id: a.id, feedback_text: NEGATED, novelty: 5, correctness: 5, testability: 5 }, exec)
    assert.equal(value.reward_basis, 'keywords')
    assert.match(value.warning, /keyword/i)
    assert.match(render(value), /Warning: .*keyword/i)
  })

  await check('the tool rejects a bad outcome with a readable error', async () => {
    const a = await fresh()
    await assert.rejects(rank.execute({ action: 'feedback', slug: a.slug, id: a.id, feedback_text: NEGATED, outcome: 'meh' }, exec), /outcome.*must be one of.*supports.*refutes.*inconclusive/)
  })
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (process.exitCode) console.error('coscientist outcome: FAILED')
else console.log(`coscientist outcome: ${passed} checks passed`)
