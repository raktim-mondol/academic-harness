import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addHypothesis, deriveState, exportTournament, leaderboard, lineage, matchHistory,
  nextTask, proposeMatch, recordFeedback, recordMatch, recordProvenance, recordReview,
  recordSafety, setStatus, similarityNeighbours, startTournament, saveExperimentProtocol,
  saveSynthesis,
} from '../coscientist-store.js'
import { GLICKO2_DEFAULTS, seededGlicko2Rating } from '../coscientist-models.js'

const cwd = mkdtempSync(join(tmpdir(), 'ah-cosc-store-'))
const slug = 'als-epigenetics'

const hypothesis = (index) => ({
  title: `Distinct hypothesis number ${index} about cryptic exon inclusion`,
  summary: `Summary ${index} proposing a mechanism unique to variant ${index} in ALS motor neurons.`,
  content: `Claim ${index}: the mechanism differs from every other variant in a testable way.`,
  rationale: `Rationale ${index}.`,
  experimental_plan: `Plan ${index}.`,
  key_assumptions: ['Assumption A', 'Assumption B'],
  citations: ['Smith 2021 Cell', 'Jones 2020 Nature'],
})

try {
  // ── session lifecycle ───────────────────────────────────────────────────────
  const started = await startTournament({
    cwd,
    slug,
    protocol: {
      goal: 'What are novel epigenetic mechanisms underlying ALS pathogenesis?',
      constraints: ['approved drugs only', 'no primate work'],
      max_hypotheses: 8,
      step_budget: 30,
      seed: 7,
    },
  })
  assert.equal(started.resumed, false)
  assert.equal(started.protocol.max_hypotheses, 8)
  assert.deepEqual(started.protocol.constraints, ['approved drugs only', 'no primate work'])
  assert.equal(started.protocol.search_queries.length, 1)
  await assert.rejects(() => startTournament({ cwd, slug, protocol: { goal: 'x' } }), /already exists/)

  // Defaults: a shortlist, a budget sized to finish it, and a threshold that
  // follows whatever measure the pool ends up using.
  const defaults = await startTournament({ cwd, slug: 'defaults', protocol: { goal: 'default budgets' } })
  assert.equal(defaults.protocol.max_hypotheses, 5, 'five is the smallest pool that survives two losses')
  assert.equal(defaults.protocol.step_budget, 36, 'enough to finish a 5-pool and to let the plateau rule fire')
  assert.equal(defaults.protocol.dup_threshold, null)
  assert.equal(defaults.protocol.seed, undefined, 'an unseeded tournament stays non-deterministic')
  const raised = await startTournament({ cwd, slug: 'raised', protocol: { goal: 'bigger', max_hypotheses: 12, step_budget: 90 } })
  assert.equal(raised.protocol.max_hypotheses, 12)
  assert.equal(raised.protocol.step_budget, 90)
  const resumed = await startTournament({ cwd, slug, resume: true, protocol: { step_budget: 30 } })
  assert.equal(resumed.resumed, true)
  assert.equal(resumed.protocol.goal, started.protocol.goal, 'resume must not rewrite the goal')
  await assert.rejects(
    () => startTournament({ cwd, slug: 'never-started', resume: true }),
    /goal is required/,
  )

  // ── add + duplicate gate + cap ──────────────────────────────────────────────
  const first = await addHypothesis({ cwd, slug, hypothesis: hypothesis(1), strategy: 'generation:literature_exploration', round: 1 })
  assert.equal(first.hypothesis.id, 'h1')
  assert.equal(first.hypothesis.status, 'pending_review')
  assert.deepEqual(first.hypothesis.key_assumptions, ['Assumption A', 'Assumption B'])
  assert.equal(first.hypothesis.rating, GLICKO2_DEFAULTS.rating)
  assert.equal(first.hypothesis.rd, GLICKO2_DEFAULTS.rd)

  const dupe = await addHypothesis({ cwd, slug, hypothesis: hypothesis(1) })
  assert.equal(dupe.discarded.reason, 'near_duplicate')
  assert.ok(dupe.discarded.score >= 0.7, `expected a high duplicate score, got ${dupe.discarded.score}`)
  assert.equal(dupe.discarded.nearest_id, 'h1')

  const second = await addHypothesis({ cwd, slug, hypothesis: hypothesis(2), parentIds: ['h1'] })
  assert.equal(second.hypothesis.id, 'h2', 'a discarded duplicate consumes no id')
  assert.deepEqual(second.hypothesis.parent_ids, ['h1'])
  assert.equal(second.hypothesis.rating, Math.round(GLICKO2_DEFAULTS.rating * 0.85), 'child seeded at 85% of parent')
  await assert.rejects(() => addHypothesis({ cwd, slug, hypothesis: hypothesis(9), parentIds: ['h404'] }), /unknown parent/)
  await assert.rejects(() => addHypothesis({ cwd, slug, hypothesis: { title: 'only a title' } }), /summary is required/)

  const capped = await startTournament({ cwd, slug: 'tiny', protocol: { goal: 'cap check', max_hypotheses: 1 } })
  assert.equal(capped.protocol.max_hypotheses, 1)
  await addHypothesis({ cwd, slug: 'tiny', hypothesis: hypothesis(1) })
  const overCap = await addHypothesis({ cwd, slug: 'tiny', hypothesis: hypothesis(4) })
  assert.equal(overCap.discarded.reason, 'hypothesis_cap')

  // dup_threshold 1 turns the gate off entirely — the documented escape hatch.
  await startTournament({ cwd, slug: 'ungated', protocol: { goal: 'gate off', dup_threshold: 1, max_hypotheses: 4 } })
  await addHypothesis({ cwd, slug: 'ungated', hypothesis: hypothesis(1) })
  const twin = await addHypothesis({ cwd, slug: 'ungated', hypothesis: hypothesis(1) })
  assert.equal(twin.discarded, undefined, 'a disabled gate must let a verbatim restatement through')
  assert.equal(twin.hypothesis.id, 'h2')

  // ── review sequencing and seeding ───────────────────────────────────────────
  await assert.rejects(
    () => recordReview({ cwd, slug, id: 'h1', stage: 'full', verdict: 'pass' }),
    /requires "initial"/,
  )

  const initial = await recordReview({
    cwd, slug, id: 'h1', stage: 'initial', verdict: 'pass',
    noveltyScore: 6, correctnessScore: 7, testabilityScore: 5, summary: 'plausible', critique: 'thin evidence cited',
  })
  assert.equal(initial.status, 'pending_review')
  assert.deepEqual(initial.stages_remaining, ['full', 'deep_verification', 'simulation', 'observation'])
  await assert.rejects(() => recordReview({ cwd, slug, id: 'h1', stage: 'initial', verdict: 'pass' }), /already recorded/)
  await assert.rejects(() => recordReview({ cwd, slug, id: 'h1', stage: 'novelty', verdict: 'pass' }), /stage must be one of/)
  await assert.rejects(() => recordReview({ cwd, slug, id: 'h1', stage: 'full', verdict: 'meh' }), /verdict must be one of/)
  await assert.rejects(() => recordReview({ cwd, slug, id: 'h1', stage: 'full', verdict: 'pass', noveltyScore: 11 }), /between 0 and 10/)

  await recordReview({ cwd, slug, id: 'h1', stage: 'full', verdict: 'pass', noveltyScore: 8, correctnessScore: 7, testabilityScore: 6, supportingEvidence: ['https://doi.org/10.1000/xyz'] })
  await recordReview({ cwd, slug, id: 'h1', stage: 'deep_verification', verdict: 'pass', noveltyScore: null, correctnessScore: 9, testabilityScore: null })
  await recordReview({ cwd, slug, id: 'h1', stage: 'simulation', verdict: 'pass', noveltyScore: 7, correctnessScore: 8, testabilityScore: 9 })

  const reviewed = await recordReview({ cwd, slug, id: 'h1', stage: 'observation', verdict: 'pass', noveltyScore: 8, correctnessScore: 9, testabilityScore: 9 })
  assert.equal(reviewed.status, 'active')
  // Best score in each dimension across all five stages: N 8, C 9, T 9 → mean 8.66…
  const expected = seededGlicko2Rating(8, 9, 9)
  assert.equal(reviewed.seeded.rating, expected.rating)
  assert.equal(reviewed.hypothesis.rating, expected.rating)
  assert.equal(reviewed.hypothesis.rd, 200, 'reviewed RD tightens to 200')
  assert.equal(reviewed.stages_remaining.length, 0)
  assert.deepEqual(reviewed.hypothesis.reviews.map((r) => r.stage), ['initial', 'full', 'deep_verification', 'simulation', 'observation'])
  assert.equal(reviewed.hypothesis.reviews[2].novelty_score, undefined, 'a null score stays absent, not zero')

  // A veto at an early stage rejects and closes the hypothesis.
  const doomed = await addHypothesis({ cwd, slug, hypothesis: hypothesis(5) })
  const rejected = await recordReview({ cwd, slug, id: doomed.hypothesis.id, stage: 'initial', verdict: 'fail', critique: 'restates a published result' })
  assert.equal(rejected.status, 'rejected')
  await assert.rejects(() => recordReview({ cwd, slug, id: doomed.hypothesis.id, stage: 'full', verdict: 'pass' }), /reviews are closed/)
  await assert.rejects(
    () => addHypothesis({ cwd, slug, hypothesis: hypothesis(6), parentIds: [doomed.hypothesis.id] }),
    /cannot seed a child/,
  )

  // ── late citation penalty is idempotent ─────────────────────────────────────
  const penalized = await recordProvenance({ cwd, slug, id: 'h1', total: 10, verified: 8, unverified: 1, fabricated: 1 })
  assert.equal(penalized.penalty.ratingDelta, -23, `expected -23, got ${penalized.penalty.ratingDelta}`)
  const beforeRepeat = penalized.hypothesis.rating
  const repeated = await recordProvenance({ cwd, slug, id: 'h1', total: 10, verified: 8, unverified: 1, fabricated: 1 })
  assert.equal(repeated.late_penalty_applied, null, 're-verifying must not double-apply the penalty')
  assert.equal(repeated.hypothesis.rating, beforeRepeat)

  // The other order — verified during review, then re-verified after activation
  // — must not charge the penalty the seed already folded in.
  const seededSlug = 'seed-order'
  await startTournament({ cwd, slug: seededSlug, protocol: { goal: 'seed order', max_hypotheses: 2 } })
  const seededId = (await addHypothesis({
    cwd, slug: seededSlug,
    hypothesis: { ...hypothesis(1), title: 'Seed-order claim about periastrin calcium buffering', summary: 'Proximal axon buffering fails before mitochondrial fragmentation.' },
  })).hypothesis.id
  await recordProvenance({ cwd, slug: seededSlug, id: seededId, total: 10, verified: 8, unverified: 1, fabricated: 1 })
  for (const stage of ['initial', 'full', 'deep_verification', 'simulation', 'observation']) {
    await recordReview({ cwd, slug: seededSlug, id: seededId, stage, verdict: 'pass', noveltyScore: 5, correctnessScore: 5, testabilityScore: 5 })
  }
  const seededActive = deriveState(cwd, seededSlug).byId.get(seededId)
  assert.equal(seededActive.status, 'active')
  assert.equal(seededActive.rating, 1200 - 23, 'the seed folds the penalty in once')
  assert.equal(seededActive.rd, 215, 'and widens RD once')
  const reverified = await recordProvenance({ cwd, slug: seededSlug, id: seededId, total: 10, verified: 8, unverified: 1, fabricated: 1 })
  assert.equal(reverified.late_penalty_applied, null, 'a penalty already in the seed is not applied again')
  assert.equal(reverified.hypothesis.rating, seededActive.rating)
  const worse = await recordProvenance({ cwd, slug: seededSlug, id: seededId, total: 10, verified: 5, unverified: 3, fabricated: 2 })
  assert.ok(worse.late_penalty_applied, 'a worse report still has to cost more')
  assert.ok(worse.hypothesis.rating < seededActive.rating)

  // ── safety gate ─────────────────────────────────────────────────────────────
  const risky = await addHypothesis({ cwd, slug, hypothesis: hypothesis(7) })
  const quarantined = await recordSafety({
    cwd, slug, id: risky.hypothesis.id, severity: 'high', category: 'dual_use',
    reasoning: 'Gain-of-function protocol for a vertebrate pathogen.', threshold: 'high',
  })
  assert.equal(quarantined.assessment.decision, 'quarantined')
  assert.equal(quarantined.hypothesis.status, 'quarantined')
  await assert.rejects(() => recordReview({ cwd, slug, id: risky.hypothesis.id, stage: 'initial', verdict: 'pass' }), /quarantined; release it/)

  const harmless = await recordSafety({ cwd, slug, id: 'h1', severity: 'none', category: 'none' })
  assert.equal(harmless.assessment.decision, 'allowed')
  await assert.rejects(() => setStatus({ cwd, slug, id: risky.hypothesis.id, status: 'active', reason: 'looks fine' }), /requires overridden_by/)
  const released = await setStatus({
    cwd, slug, id: risky.hypothesis.id, status: 'active',
    reason: 'Institutional biosafety review cleared the protocol', overriddenBy: 'biosafety-committee',
  })
  assert.equal(released.hypothesis.status, 'active')
  assert.equal(released.hypothesis.safety.released_by, 'biosafety-committee')
  const noop = await setStatus({ cwd, slug, id: 'h1', status: 'active', reason: 'already active' })
  assert.equal(noop.unchanged, true, 'an idempotent status change is accepted, not recorded twice')
  assert.equal(noop.state.hypotheses.filter((h) => h.id === 'h1').length, 1)
  await assert.rejects(() => setStatus({ cwd, slug, id: risky.hypothesis.id, status: 'quarantined', reason: '' }), /reason is required/)

  // ── matchups and debiased judging ──────────────────────────────────────────
  const PASS = { noveltyScore: 6, correctnessScore: 6, testabilityScore: 6 }
  const activate = async (targetSlug, hyp, options = {}) => {
    const added = await addHypothesis({ cwd, slug: targetSlug, hypothesis: hyp, ...options })
    let latest = added.hypothesis
    for (const stage of ['initial', 'full', 'deep_verification', 'simulation', 'observation']) {
      const record = await recordReview({ cwd, slug: targetSlug, id: added.hypothesis.id, stage, verdict: 'pass', ...PASS })
      latest = record.hypothesis
    }
    return latest
  }

  const rivalOne = await activate(slug, hypothesis(8))
  const rivalTwo = await activate(slug, hypothesis(9))

  const proposed = proposeMatch(cwd, slug)
  assert.ok(proposed.a && proposed.b, 'a matchup must be offered')
  assert.notEqual(proposed.a.id, proposed.b.id, 'the pair must be distinct')
  assert.equal(proposed.judge_as.length, 2, 'both orientations must be judged')
  assert.notEqual(proposed.judge_as[0].first, proposed.judge_as[1].first)
  assert.deepEqual([rivalOne.status, rivalTwo.status], ['active', 'active'])

  const matchSlug = 'pairwise'
  await startTournament({ cwd, slug: matchSlug, protocol: { goal: 'pairwise judging', max_hypotheses: 4 } })
  const idA = (await activate(matchSlug, { ...hypothesis(1), title: 'Pair one: distinct mechanism claim' })).id
  const idB = (await activate(matchSlug, { ...hypothesis(2), title: 'Pair two: distinct mechanism claim' })).id
  const before = deriveState(cwd, matchSlug)
  const sumBefore = before.byId.get(idA).rating + before.byId.get(idB).rating

  // verdict_ab is the A,B presentation's winner; verdict_ba is the B,A
  // presentation's winner. Agreement in real terms is therefore 'A' + 'B'.
  const decisive = await recordMatch({
    cwd, slug: matchSlug, a: idA, b: idB,
    verdictAb: 'A', verdictBa: 'B', rationale: 'A is novel and testable; B restates Smith 2021.',
    matchType: 'simple', round: 1,
  })
  assert.equal(decisive.verdict, 'A', 'both orientations pointing at A means A really won')
  assert.equal(decisive.contradictory_orientations, false)
  assert.equal(decisive.position_controlled, true)
  assert.ok(Math.abs(decisive.rating_a.after + decisive.rating_b.after - sumBefore) <= 1, 'zero-sum invariant')
  assert.ok(decisive.rating_a.after > decisive.rating_a.before, 'the winner rises')
  assert.ok(decisive.rating_b.after < decisive.rating_b.before, 'the loser falls')
  assert.ok(decisive.rating_a.rd < before.byId.get(idA).rd, 'a match tightens RD')

  const flipped = await recordMatch({
    cwd, slug: matchSlug, a: idA, b: idB, verdictAb: 'A', verdictBa: 'A', rationale: 'Order-dependent verdict.',
  })
  assert.equal(flipped.verdict, 'draw', 'a verdict that flips with presentation order is a draw')
  assert.equal(flipped.contradictory_orientations, true)

  const singleOrientation = await recordMatch({ cwd, slug: matchSlug, a: idA, b: idB, verdictAb: 'B', rationale: 'lazy judging' })
  assert.equal(singleOrientation.position_controlled, false, 'one orientation is flagged as uncontrolled')
  assert.equal(singleOrientation.verdict, 'B')

  await assert.rejects(() => recordMatch({ cwd, slug: matchSlug, a: idA, b: idA, verdictAb: 'A' }), /itself/)
  await assert.rejects(() => recordMatch({ cwd, slug: matchSlug, a: idA, b: 'h404', verdictAb: 'A' }), /unknown hypothesis/)
  await assert.rejects(() => recordMatch({ cwd, slug: matchSlug, a: idA, b: idB, verdictAb: 'maybe' }), /must each be A, B, or draw/)
  await assert.rejects(() => recordMatch({ cwd, slug: matchSlug, a: idA, b: idB, rationale: 'no verdict' }), /verdict_ab is required/)
  const rejectedSide = await setStatus({ cwd, slug: matchSlug, id: idB, status: 'rejected', reason: 'reviewer veto' })
  assert.equal(rejectedSide.hypothesis.status, 'rejected')
  await assert.rejects(() => recordMatch({ cwd, slug: matchSlug, a: idA, b: idB, verdictAb: 'A' }), /is rejected; only active hypotheses compete/)
  assert.equal(matchHistory(cwd, matchSlug, idA).length, 3)
  assert.equal(matchHistory(cwd, matchSlug).length, 3, 'session-wide history matches')

  const thin = proposeMatch(cwd, 'tiny')
  assert.match(thin.error, /at least 2 active hypotheses/)

  // ── similarity and lineage ──────────────────────────────────────────────────
  const neighbours = similarityNeighbours(cwd, slug, { id: 'h1' })
  assert.ok(Array.isArray(neighbours.neighbours))
  const family = await startTournament({ cwd, slug: 'lineage', protocol: { goal: 'lineage', max_hypotheses: 5 } })
  const parent = await activate('lineage', hypothesis(1))
  const child = await addHypothesis({
    cwd, slug: 'lineage', parentIds: [parent.id], strategy: 'evolution:coherence',
    hypothesis: { ...hypothesis(2), title: 'Refined mechanism after coherence edit', content: 'Rewritten claim with the assumption made explicit.' },
  })
  assert.equal(child.hypothesis.rating, Math.round(parent.rating * 0.85), 'a child inherits 85% of the parent, post-review')
  assert.equal(child.hypothesis.rd, 350, 'a child has not competed, so it starts fully uncertain')
  const tree = lineage(cwd, 'lineage', child.hypothesis.id)
  assert.deepEqual(tree.parent_ids, [parent.id])
  assert.deepEqual(tree.children, [])
  assert.deepEqual(lineage(cwd, 'lineage', parent.id).children, [child.hypothesis.id])
  assert.ok(tree.diffs[0].changed_fields.includes('title'))
  assert.ok(tree.diffs[0].changed_fields.includes('content'))
  assert.ok(!tree.diffs[0].changed_fields.includes('citations'), 'unchanged fields are not reported')
  assert.ok(tree.diffs[0].rating_delta < 0)
  assert.equal(family.protocol.slug, 'lineage')

  // ── feedback moves the rating ───────────────────────────────────────────────
  const fed = await recordFeedback({
    cwd, slug: 'lineage', id: child.hypothesis.id,
    feedbackText: 'The experiment confirmed the prediction and the result was robust and reproducible.',
    novelty: 10, correctness: 10, testability: 10, recordedBy: 'wet-lab',
  })
  assert.ok(fed.reward > 0.33, `expected a winning reward, got ${fed.reward}`)
  assert.ok(fed.rating_after > fed.rating_before, 'a validated hypothesis rises')
  assert.equal(fed.hypothesis.feedback.length, 1)
  assert.equal(fed.hypothesis.feedback[0].recorded_by, 'wet-lab')
  const refuted = await recordFeedback({
    cwd, slug: 'lineage', id: child.hypothesis.id,
    feedbackText: 'The assay failed; the effect did not replicate and we could not detect any signal.',
    recordedBy: 'wet-lab',
  })
  assert.ok(refuted.reward < -0.33, `expected a losing reward, got ${refuted.reward}`)
  assert.ok(refuted.rating_after < refuted.rating_before, 'a refuted hypothesis falls')
  await assert.rejects(() => recordFeedback({ cwd, slug: 'lineage', id: child.hypothesis.id, feedbackText: '' }), /feedback_text is required/)

  // ── protocol design and synthesis ───────────────────────────────────────────
  const protocolSaved = await saveExperimentProtocol({
    cwd, slug: 'lineage', id: child.hypothesis.id,
    steps: ['Seed motor neurons', 'Perturb the candidate locus', 'Read cryptic exon inclusion by long-read RNA-seq'],
  })
  assert.equal(protocolSaved.steps, 3)
  assert.equal(protocolSaved.hypothesis.experiment_protocol.steps.length, 3)
  await assert.rejects(() => saveExperimentProtocol({ cwd, slug: 'lineage', id: child.hypothesis.id, steps: [] }), /non-empty/)
  const synthesized = await saveSynthesis({ cwd, slug: 'lineage', critique: 'Every candidate assumes intact RNA surveillance.', overview: 'Three mechanisms, one discriminator.' })
  assert.match(synthesized.critique, /RNA surveillance/)
  assert.equal(leaderboard(cwd, 'lineage').overview, 'Three mechanisms, one discriminator.')

  // ── scheduling policy ───────────────────────────────────────────────────────
  const scheduling = await startTournament({ cwd, slug: 'schedule', protocol: { goal: 'weights', max_hypotheses: 6, step_budget: 12, seed: 11 } })
  assert.equal(scheduling.state.rounds, 0)
  const bootstrap = await nextTask({ cwd, slug: 'schedule' })
  assert.equal(bootstrap.round, 1)
  assert.equal(bootstrap.weights.generation, 0.7, 'a bootstrap session must be generation-heavy')
  assert.equal(bootstrap.terminate, false, 'termination is refused before round 10')
  const bootstrapTasks = new Set()
  for (let i = 0; i < 11; i += 1) bootstrapTasks.add((await nextTask({ cwd, slug: 'schedule' })).task)
  assert.deepEqual([...bootstrapTasks], ['generation'], 'with no hypotheses, generation is the only executable task')
  const drained = await nextTask({ cwd, slug: 'schedule' })
  assert.equal(drained.steps_used, 13)
  assert.equal(drained.terminate, true, 'the step budget must stop the loop')
  assert.equal(drained.reason, 'budget_exhausted')

  // At the cap with nothing pending, the phase table still puts mass on
  // reflection and evolution, but neither task can run. Dispatch must zero the
  // impossible entries instead of sampling a no-op the caller has to override.
  const cappedSession = await startTournament({ cwd, slug: 'capped', protocol: { goal: 'capped pool', max_hypotheses: 2, step_budget: 20, seed: 3 } })
  assert.equal(cappedSession.protocol.max_hypotheses, 2)
  const capA = await activate('capped', hypothesis(11))
  const capB = await activate('capped', { ...hypothesis(12), title: 'Capped hypothesis two with a different mechanism' })
  assert.deepEqual([capA.status, capB.status], ['active', 'active'])
  const capDispatch = await nextTask({ cwd, slug: 'capped', rand: () => 0.999999 })
  assert.equal(capDispatch.weights.generation, 0, 'the hypothesis cap blocks generation')
  assert.equal(capDispatch.weights.reflection, 0, 'nothing is pending review')
  assert.equal(capDispatch.weights.evolution, 0, 'an add at the cap would be discarded')
  assert.ok(['ranking', 'proximity', 'meta_review'].includes(capDispatch.task), `unexpected task ${capDispatch.task}`)

  // The first ranking is a complete round-robin: with two active hypotheses the
  // only pair plays once and only then becomes eligible for a repeat.
  const firstProposal = proposeMatch(cwd, 'capped')
  assert.equal(firstProposal.pair_matches_played, 0)
  assert.equal(firstProposal.unplayed_pairs_remaining, 1)
  await recordMatch({
    cwd, slug: 'capped', a: firstProposal.a.id, b: firstProposal.b.id,
    verdictAb: 'A', verdictBa: 'B', rationale: 'A wins both presentation orders.',
  })
  const replayProposal = proposeMatch(cwd, 'capped')
  assert.equal(replayProposal.pair_matches_played, 1, 'only a completed round-robin repeats a pair')
  assert.equal(replayProposal.unplayed_pairs_remaining, 0)
  const resumedWithCap = await startTournament({ cwd, slug: 'capped', resume: true, protocol: { max_matches: 1 } })
  assert.equal(resumedWithCap.protocol.max_matches, 1)
  const stopped = await nextTask({ cwd, slug: 'capped' })
  assert.equal(stopped.terminate, true)
  assert.equal(stopped.reason, 'match_cap_reached')
  assert.equal(stopped.matches_used, 1)
  assert.equal(stopped.max_matches, 1)

  const twinA = await startTournament({ cwd, slug: 'repro-a', protocol: { goal: 'a', seed: 99 } })
  const twinB = await startTournament({ cwd, slug: 'repro-b', protocol: { goal: 'b', seed: 99 } })
  const sequenceA = []
  const sequenceB = []
  for (let i = 0; i < 12; i += 1) {
    sequenceA.push((await nextTask({ cwd, slug: 'repro-a' })).task)
    sequenceB.push((await nextTask({ cwd, slug: 'repro-b' })).task)
  }
  assert.deepEqual(sequenceA, sequenceB, 'a seeded schedule must replay identically')
  assert.equal(twinA.protocol.seed, 99)
  assert.equal(twinB.protocol.seed, 99)

  // ── concurrency: every parallel write lands exactly once ────────────────────
  const busy = await startTournament({ cwd, slug: 'busy', protocol: { goal: 'concurrency', max_hypotheses: 200 } })
  assert.equal(busy.state.counts.total, 0)
  await Promise.all(Array.from({ length: 40 }, (_, i) => addHypothesis({
    cwd, slug: 'busy',
    hypothesis: {
      title: `Parallel hypothesis ${i} with a distinct mechanism`,
      summary: `Variant ${i} claims a different observable consequence than any other variant here.`,
      content: `Claim ${i}.`,
    },
    round: i,
  })))
  const afterBurst = deriveState(cwd, 'busy')
  assert.equal(afterBurst.counts.total, 40, 'no write may be lost or duplicated')
  assert.equal(new Set(afterBurst.hypotheses.map((h) => h.id)).size, 40)
  await Promise.all([
    nextTask({ cwd, slug: 'busy' }),
    nextTask({ cwd, slug: 'busy' }),
    nextTask({ cwd, slug: 'busy' }),
  ])
  assert.equal(deriveState(cwd, 'busy').rounds, 3, 'concurrent dispatches each consume one round')

  // ── views and export ────────────────────────────────────────────────────────
  const board = leaderboard(cwd, 'lineage')
  assert.equal(board.counts.total, 2)
  assert.equal(board.ranked[0].id, parent.id, 'the parent still outranks its 85 %-seeded child')
  assert.match(board.ranked[0].record, /^\d+-\d+-\d+$/)
  assert.equal(board.weights.generation, 0.1, 'a review backlog keeps generation throttled while reflection leads')
  assert.ok(board.weights.reflection > board.weights.generation, 'a backlog must favour reflection')
  assert.equal(leaderboard(cwd, 'tiny').weights.generation, 0, 'at cap, generation must be switched off')
  assert.equal(leaderboard(cwd, slug).counts.quarantined, 0, 'a released hypothesis is no longer withheld')

  // A withheld hypothesis stays out of the tournament until a human releases it.
  const withheldSlug = 'withheld'
  await startTournament({ cwd, slug: withheldSlug, protocol: { goal: 'withheld', max_hypotheses: 3 } })
  const withheld = await addHypothesis({
    cwd, slug: withheldSlug,
    hypothesis: { ...hypothesis(1), title: 'Withheld claim about enhancing a vertebrate pathogen', summary: 'A protocol that raises the transmissibility of an existing agent.' },
  })
  await recordSafety({
    cwd, slug: withheldSlug, id: withheld.hypothesis.id, severity: 'high',
    category: 'bioweapon', reasoning: 'Gain-of-function enhancement of a vertebrate pathogen.',
  })
  const withheldBoard = leaderboard(cwd, withheldSlug)
  assert.equal(withheldBoard.counts.quarantined, 1)
  assert.equal(withheldBoard.ranked[0].quarantined, true)
  assert.match(withheldBoard.ranked[0].status, /quarantined/)
  assert.match(proposeMatch(cwd, withheldSlug).error, /at least 2 active hypotheses/)
  const withheldReport = exportTournament({ cwd, slug: withheldSlug, format: 'markdown' })
  assert.match(readFileSync(join(cwd, withheldReport.path), 'utf8'), /withheld from the tournament/)

  const report = exportTournament({ cwd, slug: 'lineage', format: 'markdown' })
  const markdown = readFileSync(join(cwd, report.path), 'utf8')
  assert.match(markdown, /# Hypothesis tournament: /)
  assert.match(markdown, /\| # \| Rating \| RD \| W-L-D \| Matches \| Status \| Hypothesis \|/)
  assert.match(markdown, /recombine published knowledge/)
  assert.match(markdown, /The experiment confirmed the prediction/)
  assert.match(markdown, /Seed motor neurons/)
  assert.throws(() => exportTournament({ cwd, slug: 'lineage', format: 'markdown' }), /already exists/)
  const replaced = exportTournament({ cwd, slug: 'lineage', format: 'markdown', overwrite: true })
  assert.equal(replaced.format, 'markdown')
  const asJson = exportTournament({ cwd, slug: 'lineage', format: 'json' })
  const parsed = JSON.parse(readFileSync(join(cwd, asJson.path), 'utf8'))
  assert.equal(parsed.hypotheses.length, 2)
  assert.ok(parsed.events.some((event) => event.type === 'feedback'))
  assert.throws(() => exportTournament({ cwd, slug: 'lineage', format: 'csv' }), /markdown, json, or mermaid/)

  const asMermaid = exportTournament({ cwd, slug: 'lineage', format: 'mermaid' })
  assert.match(asMermaid.path, /exports\/tournament\.mmd$/)
  const diagram = readFileSync(join(cwd, asMermaid.path), 'utf8')
  assert.match(diagram, /^flowchart TD$/m)
  assert.match(diagram, /-->\|"evolved from"\|/)
  assert.ok(diagram.split('\n').some((line) => line.trim().startsWith('class ') && line.includes('active')))

  assert.ok(existsSync(join(cwd, '.dsh', 'coscientist', 'lineage', 'snapshot.json')))

  // A rebuilt snapshot from the log must equal the cached one — the cache is a
  // cache, not a second source of truth.
  const cached = JSON.parse(readFileSync(join(cwd, '.dsh', 'coscientist', 'lineage', 'snapshot.json'), 'utf8'))
  const rebuilt = deriveState(cwd, 'lineage')
  assert.equal(cached.counts.total, rebuilt.counts.total)
  assert.deepEqual(cached.hypotheses.map((h) => `${h.id}:${h.rating}`).sort(), rebuilt.ranked.map((h) => `${h.id}:${h.rating}`).sort())

  console.log('coscientist-store OK')
} finally {
  rmSync(cwd, { recursive: true, force: true })
}
