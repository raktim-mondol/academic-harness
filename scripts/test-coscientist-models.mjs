import assert from 'node:assert/strict'
import {
  GLICKO2_DEFAULTS, GLICKO2_REVIEWED_RD, LEXICAL_DUPLICATE_THRESHOLD,
  MAX_PENALTY, MAX_RD_WIDEN, REWARD_WIN_THRESHOLD, SAFETY_SEVERITIES, TAU, VECTOR_DUPLICATE_THRESHOLD,
  applyFeedbackAsGlicko2Match, citationPenalty, combineSwappedVerdicts, computeGlicko2Update,
  computeWeights, cosineSimilarity, decideSafety, defaultThresholds, evolvedSeedRating, extractRewardFromFeedback,
  feedbackSentiment, isMatchResult, isNearDuplicate, jaccardSimilarity, makeRand, mapPresentedVerdict,
  mulberry32, normalizeSafetySeverity, pairMeasure, pairSimilarity, sampleNextTaskType, seededGlicko2Rating, seededRatingWithPenalty,
  selectEvolutionStrategy, selectGenerationStrategy, selectMatchup, similarityPairs,
  terminationCheck, textShingles, verdictToMatchResult,
} from '../coscientist-models.js'

const state = (rating, rd, extra = {}) => ({
  rating, rd, volatility: GLICKO2_DEFAULTS.volatility, matchesPlayed: 0, wins: 0, losses: 0, draws: 0, ...extra,
})

try {
  // ── constants are the upstream ones ────────────────────────────────────────
  assert.equal(GLICKO2_DEFAULTS.rating, 1200)
  assert.equal(GLICKO2_DEFAULTS.rd, 350)
  assert.equal(GLICKO2_DEFAULTS.volatility, 0.06)
  assert.equal(GLICKO2_REVIEWED_RD, 200)
  assert.equal(TAU, 0.5)
  assert.equal(MAX_PENALTY, 150)
  assert.equal(MAX_RD_WIDEN, 100)
  assert.equal(VECTOR_DUPLICATE_THRESHOLD, 0.92)
  assert.equal(LEXICAL_DUPLICATE_THRESHOLD, 0.7)
  assert.equal(REWARD_WIN_THRESHOLD, 0.33)

  // ── Glicko-2 ───────────────────────────────────────────────────────────────
  const one = computeGlicko2Update(state(1200, 350), state(1200, 350), 'A_wins')
  assert.ok(one.newA.rating > 1200 && one.newB.rating < 1200, 'a win must separate the pair')
  assert.equal(one.newA.matchesPlayed, 1)
  assert.equal(one.newA.wins, 1)
  assert.equal(one.newB.losses, 1)
  assert.ok(Math.abs(one.newA.rating + one.newB.rating - 2400) <= 1, 'one match is zero-sum to rounding')
  assert.ok(one.newA.rd < 350, 'a match tightens RD')

  const symmetric = computeGlicko2Update(state(1200, 200), state(1200, 200), 'draw')
  assert.equal(symmetric.newA.rating, symmetric.newB.rating, 'equal players drawing stay equal')
  assert.equal(symmetric.newA.rd, symmetric.newB.rd)
  assert.equal(symmetric.newA.draws, 1)

  const vsUncertain = computeGlicko2Update(state(1200, 200), state(1200, 350), 'A_wins')
  const vsCertain = computeGlicko2Update(state(1200, 200), state(1200, 60), 'A_wins')
  const uncertainGain = vsUncertain.newA.rating - 1200
  const certainGain = vsCertain.newA.rating - 1200
  assert.ok(
    uncertainGain < certainGain,
    `g(φ) damping: beating an uncertain opponent (+${uncertainGain}) must earn less than beating a certain one (+${certainGain})`,
  )

  // 200 simulated matches must not let the pair total drift.
  let a = state(1200, 350)
  let b = state(1200, 350)
  const rand = makeRand(20261024)
  let sumBefore = a.rating + b.rating
  for (let i = 0; i < 200; i += 1) {
    const result = rand() < 0.5 ? 'A_wins' : 'B_wins'
    const updated = computeGlicko2Update(a, b, result)
    a = updated.newA
    b = updated.newB
    assert.ok(Math.abs(a.rating + b.rating - sumBefore) <= 200, 'a long tournament stays near zero-sum')
    assert.ok(a.rd <= 350 && b.rd <= 350, 'RD never exceeds the unplayed value')
    assert.ok(a.volatility > 0 && Number.isFinite(a.volatility))
    sumBefore = a.rating + b.rating
  }
  assert.equal(a.matchesPlayed, 200)
  assert.equal(a.wins + a.losses + a.draws, 200)
  assert.ok([a.rating, b.rating].every((rating) => Number.isInteger(rating)))
  assert.ok(a.volatility === Math.round(a.volatility * 1e6) / 1e6, 'volatility keeps 6 decimals')

  assert.throws(() => computeGlicko2Update(state(1200, 350), state(1200, 350), 'maybe'), /result must be one of/)
  assert.equal(isMatchResult('draw'), true)
  assert.equal(isMatchResult('A wins'), false)
  // Missing fields fall back to defaults rather than producing NaN.
  const sloppy = computeGlicko2Update({ rating: 1200 }, {}, 'A_wins')
  assert.ok(Number.isFinite(sloppy.newA.rating) && Number.isFinite(sloppy.newB.rating))

  // ── review-score seed ───────────────────────────────────────────────────────
  assert.equal(seededGlicko2Rating(5, 5, 5).rating, 1200, 'a neutral review lands on the baseline')
  assert.equal(seededGlicko2Rating(8, 8, 8).rating, 1320)
  assert.equal(seededGlicko2Rating(3, 3, 3).rating, 1120)
  assert.equal(seededGlicko2Rating(8, 9, 9).rating, Math.round(1000 + (8.6666666667 / 10) * 400))
  assert.equal(seededGlicko2Rating(10, 10, 10).rating, 1400)
  assert.equal(seededGlicko2Rating(2, 2, 2).rating, 1080)
  assert.equal(seededGlicko2Rating(undefined, null, '').rating, 1200, 'no scores stay unreviewed')
  assert.equal(seededGlicko2Rating(undefined, null, '').rd, GLICKO2_DEFAULTS.rd)
  assert.equal(seededGlicko2Rating(6).rd, GLICKO2_REVIEWED_RD)
  assert.ok(seededGlicko2Rating(9, 9, 9).rating > seededGlicko2Rating(7, 7, 7).rating, 'monotone in score')
  assert.deepEqual([seededGlicko2Rating([7, 7, 7]).rating], [Math.round(1000 + (7 / 10) * 400)], 'array form agrees with varargs')
  assert.equal(seededGlicko2Rating(7, undefined, undefined).rating, 1280, 'absent dimensions are ignored')

  // A penalty softens a seed; it never eliminates it, and RD widens instead.
  const penalized = seededRatingWithPenalty({ novelty: 5, correctness: 5, testability: 5 }, citationPenalty({ total: 1, fabricated: 1 }))
  assert.equal(penalized.rating, 1200 - MAX_PENALTY)
  assert.equal(penalized.rd, Math.min(350, GLICKO2_REVIEWED_RD + MAX_RD_WIDEN))
  assert.equal(seededRatingWithPenalty({ novelty: 1, correctness: 1, testability: 1 }, citationPenalty({ total: 1, fabricated: 1 })).rating, 1000, 'the seed floors at 1000')
  assert.deepEqual(seededRatingWithPenalty({ novelty: 5, correctness: 5, testability: 5 }), { rating: 1200, rd: 200, volatility: 0.06 }, 'no penalty leaves the seed alone')

  // ── citation penalty ────────────────────────────────────────────────────────
  assert.deepEqual(citationPenalty({ total: 0, fabricated: 0, unverified: 0 }), { f: 0, ratingDelta: 0, rdDelta: 0 })
  assert.deepEqual(citationPenalty(), { f: 0, ratingDelta: 0, rdDelta: 0 })
  assert.equal(citationPenalty({ total: 1, fabricated: 1 }).ratingDelta, -MAX_PENALTY)
  assert.equal(citationPenalty({ total: 1, unverified: 1 }).f, 0.5, 'an unverified citation is half as damaging')
  assert.equal(citationPenalty({ total: 10, unverified: 1 }).ratingDelta, -Math.round(0.05 * MAX_PENALTY))
  const oneOfTen = citationPenalty({ total: 10, fabricated: 1 })
  assert.ok(Math.abs(oneOfTen.ratingDelta) < 30, 'one bad citation among ten must not sink a hypothesis')
  assert.ok(oneOfTen.rdDelta > 0, 'uncertainty about citations widens RD')

  // ── judge debias ────────────────────────────────────────────────────────────
  assert.equal(mapPresentedVerdict('A', false), 'A')
  assert.equal(mapPresentedVerdict('A', true), 'B', 'a presented-A win in the swapped layout is a real B win')
  assert.equal(mapPresentedVerdict('draw', true), 'draw', 'a draw is orientation-independent')
  assert.throws(() => mapPresentedVerdict('maybe', true), /verdict must be one of/)
  assert.equal(combineSwappedVerdicts('A', 'A'), 'A')
  assert.equal(combineSwappedVerdicts('B', 'B'), 'B')
  assert.equal(combineSwappedVerdicts('A', 'draw'), 'A', 'a decisive verdict beats a draw')
  assert.equal(combineSwappedVerdicts('draw', 'B'), 'B')
  assert.equal(combineSwappedVerdicts('A', 'B'), 'draw', 'contradictory verdicts were order-driven')
  assert.equal(combineSwappedVerdicts('draw', 'draw'), 'draw')
  assert.equal(verdictToMatchResult('A'), 'A_wins')
  assert.equal(verdictToMatchResult('B'), 'B_wins')
  assert.equal(verdictToMatchResult('draw'), 'draw')

  // ── scheduler weights ───────────────────────────────────────────────────────
  const keys = ['generation', 'reflection', 'ranking', 'evolution', 'proximity', 'meta_review']
  const sum = (weights) => keys.reduce((total, key) => total + weights[key], 0)
  const phases = {
    bootstrapOne: { totalHypotheses: 1, activeHypotheses: 1, pendingReview: 0, totalMatches: 0, currentRound: 1, maxHypotheses: 6 },
    bootstrapTwo: { totalHypotheses: 2, activeHypotheses: 2, pendingReview: 0, totalMatches: 0, currentRound: 1, maxHypotheses: 6 },
    backlog: { totalHypotheses: 5, activeHypotheses: 2, pendingReview: 3, totalMatches: 2, currentRound: 12, maxHypotheses: 6 },
    midRun: { totalHypotheses: 4, activeHypotheses: 4, pendingReview: 0, totalMatches: 6, currentRound: 12, maxHypotheses: 6 },
    lateRun: { totalHypotheses: 4, activeHypotheses: 4, pendingReview: 0, totalMatches: 30, currentRound: 25, maxHypotheses: 6 },
    atCapReviewing: { totalHypotheses: 6, activeHypotheses: 4, pendingReview: 2, totalMatches: 10, currentRound: 22, maxHypotheses: 6 },
    atCapDrained: { totalHypotheses: 6, activeHypotheses: 6, pendingReview: 0, totalMatches: 10, currentRound: 22, maxHypotheses: 6 },
  }
  assert.equal(computeWeights(phases.bootstrapOne).generation, 0.7, 'one active hypothesis must generate')
  assert.equal(computeWeights(phases.bootstrapTwo).ranking, 0.2, 'two active hypotheses can rank')
  assert.ok(computeWeights(phases.backlog).reflection > 0.5, 'a review backlog must be cleared before more generation')
  assert.ok(computeWeights(phases.backlog).generation < 0.2, 'a backlog throttles generation')
  assert.equal(computeWeights(phases.midRun).generation, 0.3)
  assert.equal(computeWeights(phases.lateRun).evolution, 0.25, 'late in the run, evolution takes over')
  assert.equal(computeWeights(phases.atCapReviewing).generation, 0, 'at cap, generation is off')
  assert.equal(computeWeights(phases.atCapReviewing).reflection, 0.7, 'at cap, drain reviews first')
  assert.equal(computeWeights(phases.atCapDrained).ranking, 0.55, 'at cap and drained, rank')
  for (const [name, stats] of Object.entries(phases)) {
    const weights = computeWeights(stats)
    assert.deepEqual(Object.keys(weights).sort(), [...keys].sort(), `${name} must cover every task type`)
    for (const [key, value] of Object.entries(weights)) {
      assert.ok(value >= 0 && value <= 1, `${name}.${key} out of range: ${value}`)
    }
    if (name === 'bootstrapOne') {
      // Upstream's table sums to 1.03; sampling renormalizes, so the ratios are
      // what count. Pinned here so a future "fix" is a deliberate change.
      assert.ok(Math.abs(sum(weights) - 1.03) < 1e-9, `bootstrapOne must stay at upstream's sum, got ${sum(weights)}`)
      continue
    }
    assert.ok(Math.abs(sum(weights) - 1) < 1e-9, `${name} weights must sum to 1 (got ${sum(weights)})`)
  }

  // ── sampling ────────────────────────────────────────────────────────────────
  const noGeneration = computeWeights(phases.atCapDrained)
  for (let i = 0; i < 200; i += 1) {
    assert.notEqual(sampleNextTaskType(noGeneration, makeRand(i)), 'generation', 'a zero weight must never be sampled')
  }
  assert.equal(sampleNextTaskType({ generation: 1, reflection: 0, ranking: 0, evolution: 0, proximity: 0, meta_review: 0 }), 'generation')
  assert.equal(sampleNextTaskType({ generation: 0, reflection: 0, ranking: 0, evolution: 0, proximity: 0, meta_review: 0 }), 'generation', 'an all-zero table falls back to generation')

  const distribution = new Map()
  const seeded = makeRand(42)
  const mid = computeWeights(phases.midRun)
  for (let i = 0; i < 6000; i += 1) {
    const task = sampleNextTaskType(mid, seeded)
    distribution.set(task, (distribution.get(task) || 0) + 1)
  }
  assert.ok(Math.abs((distribution.get('generation') || 0) / 6000 - 0.3) < 0.05, 'samples follow the weights')
  assert.equal(distribution.get('reflection') / 6000 > 0.15, true)

  // ── termination ─────────────────────────────────────────────────────────────
  const flat = new Array(20).fill(1300)
  assert.equal(terminationCheck({ ...phases.lateRun, currentRound: 5 }, flat).terminate, false, 'never before round 10')
  assert.equal(terminationCheck({ ...phases.lateRun, currentRound: 12, tokensUsed: 40, budgetTokens: 40 }, []).terminate, true)
  assert.equal(terminationCheck({ ...phases.lateRun, currentRound: 12, tokensUsed: 41, budgetTokens: 40 }, []).reason, 'budget_exhausted')
  assert.equal(terminationCheck({ ...phases.lateRun, currentRound: 12, totalMatches: 30 }, flat).reason, 'elo_plateau')
  assert.equal(terminationCheck({ ...phases.lateRun, currentRound: 12, totalMatches: 9 }, flat).terminate, false, 'a plateau needs real tournament activity')
  assert.equal(terminationCheck({ ...phases.lateRun, currentRound: 12, totalMatches: 30 }, new Array(20).fill(1200)).terminate, false, 'a plateau needs ratings that actually moved')
  assert.equal(terminationCheck({ ...phases.lateRun, currentRound: 12, totalMatches: 30 }, new Array(19).fill(1300)).terminate, false, 'a plateau needs 20 samples')
  const moving = Array.from({ length: 20 }, (_, i) => 1250 + i * 10)
  assert.equal(terminationCheck({ ...phases.lateRun, currentRound: 12, totalMatches: 30 }, moving).terminate, false, 'ratings still climbing is not a plateau')
  assert.equal(terminationCheck({ ...phases.atCapDrained, currentRound: 22, totalMatches: 18 }, new Array(10).fill(1300)).reason, 'cap_reached_and_ranked')
  assert.equal(terminationCheck({ ...phases.atCapDrained, currentRound: 22, totalMatches: 10, pendingReview: 1 }, new Array(10).fill(1300)).terminate, false, 'work still pending is not termination')
  assert.equal(
    terminationCheck({ ...phases.atCapDrained, currentRound: 3, totalMatches: 3, maxMatches: 3 }, []).reason,
    'match_cap_reached',
    'an explicit match cap stops even before round 10',
  )
  assert.equal(
    terminationCheck({ ...phases.atCapDrained, currentRound: 3, totalMatches: 2, maxMatches: 3 }, []).terminate,
    false,
    'the match cap only fires when reached',
  )
  assert.equal(terminationCheck({ ...phases.atCapDrained, currentRound: 22, totalMatches: 10 }, new Array(10).fill(1300)).terminate, false, 'ten matches over six hypotheses is not enough')
  assert.equal(terminationCheck({ maxHypotheses: 0, currentRound: 30, activeHypotheses: 3, pendingReview: 0, totalHypotheses: 3, totalMatches: 4 }, []).terminate, false, 'an unset cap must not terminate')

  // A pool too small to field a match ends the tournament immediately, even
  // before round 10 — waiting cannot make a third hypothesis appear.
  const stalled = { maxHypotheses: 3, totalHypotheses: 3, pendingReview: 0, activeHypotheses: 1, totalMatches: 0, currentRound: 3 }
  assert.equal(terminationCheck(stalled, []).reason, 'no_competitors')
  assert.equal(terminationCheck({ ...stalled, activeHypotheses: 0 }, []).reason, 'no_competitors')
  assert.equal(terminationCheck({ ...stalled, currentRound: 40 }, []).reason, 'no_competitors', 'not gated on the round floor')
  assert.equal(terminationCheck({ ...stalled, pendingReview: 1 }, []).terminate, false, 'a hypothesis still in review can become a competitor')
  assert.equal(terminationCheck({ ...stalled, totalHypotheses: 2 }, []).terminate, false, 'below the cap, generation can still supply an opponent')
  assert.equal(terminationCheck({ ...stalled, activeHypotheses: 2 }, []).terminate, false, 'two active hypotheses can still be matched')
  assert.equal(terminationCheck({ ...stalled, budgetTokens: 5, tokensUsed: 9 }, []).reason, 'budget_exhausted', 'budget still outranks it')

  // ── rotation ────────────────────────────────────────────────────────────────
  assert.equal(selectGenerationStrategy(1, 0), 'literature_exploration', 'a thin pool must explore literature first')
  assert.equal(selectGenerationStrategy(2, 7), 'literature_exploration')
  assert.deepEqual([0, 1, 2, 3].map((round) => selectGenerationStrategy(5, round)), ['scientific_debate', 'assumption_chaining', 'research_expansion', 'literature_exploration'])
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(selectEvolutionStrategy), [
    'grounding', 'coherence', 'cross_pollination', 'combination', 'simplification', 'out_of_box', 'grounding',
  ])

  // ── matchup ─────────────────────────────────────────────────────────────────
  assert.equal(selectMatchup([{ id: 'h1', rd: 350, matchesPlayed: 0 }], () => []), null, 'one hypothesis cannot be matched')
  const uncertainFirst = selectMatchup([
    { id: 'h-certain', rd: 60, matchesPlayed: 1 },
    { id: 'h-uncertain', rd: 340, matchesPlayed: 1 },
  ], () => [])
  assert.equal(uncertainFirst.primary.id, 'h-uncertain', 'the most uncertain hypothesis plays first')
  const similarPair = selectMatchup([
    { id: 'h1', rd: 340, matchesPlayed: 0 },
    { id: 'h2', rd: 60, matchesPlayed: 4 },
    { id: 'h3', rd: 60, matchesPlayed: 4 },
  ], (id) => (id === 'h1' ? ['h3'] : []))
  assert.equal(similarPair.opponent.id, 'h3', 'an uncertain hypothesis is paired with a similar one')
  assert.equal(similarPair.basis, 'uncertain_and_similar')
  assert.equal(similarPair.primary.id, 'h1')
  const played = selectMatchup([
    { id: 'h1', rd: 340, matchesPlayed: 10 },
    { id: 'h2', rd: 340, matchesPlayed: 0 },
    { id: 'h3', rd: 100, matchesPlayed: 0 },
  ], () => [])
  assert.equal(played.primary.id, 'h2', 'matches played divide the priority')
  const neverSelf = selectMatchup([{ id: 'h1', rd: 350, matchesPlayed: 0 }, { id: 'h2', rd: 350, matchesPlayed: 0 }], () => ['h1'])
  assert.notEqual(neverSelf.opponent.id, neverSelf.primary.id, 'a hypothesis is never its own opponent')

  // A fresh pair is preferred until every active pair has met once. The order of
  // ids inside a recorded pair must not matter.
  const freshPair = selectMatchup([
    { id: 'h1', rd: 340, matchesPlayed: 1 },
    { id: 'h2', rd: 60, matchesPlayed: 1 },
    { id: 'h3', rd: 60, matchesPlayed: 1 },
  ], () => [], Math.random, { playedPairs: ['h1|h3', ['h3', 'h2']] })
  assert.deepEqual([freshPair.primary.id, freshPair.opponent.id].sort(), ['h1', 'h2'], 'the unplayed pair must play')
  assert.equal(freshPair.basis, 'unplayed_pair')
  const replayPair = selectMatchup([
    { id: 'h1', rd: 340, matchesPlayed: 1 },
    { id: 'h2', rd: 60, matchesPlayed: 1 },
  ], () => [], makeRand(1), { playedPairs: [['h2', 'h1']] })
  assert.notEqual(replayPair.basis, 'unplayed_pair', 'a finished round-robin falls back to uncertainty-first')

  // ── similarity and duplicates ───────────────────────────────────────────────
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  assert.equal(cosineSimilarity([1, 0], [1]), 0, 'a length mismatch is not similarity')
  assert.equal(cosineSimilarity([0, 0], [0, 0]), 0, 'a zero vector has no direction')
  assert.equal(jaccardSimilarity(textShingles('alpha beta gamma'), textShingles('alpha beta gamma')), 1)
  assert.equal(jaccardSimilarity(textShingles('alpha beta gamma'), textShingles('delta epsilon zeta')), 0)
  assert.equal(jaccardSimilarity(textShingles(''), textShingles('alpha')), 0)

  const restated = { id: 'h9', text: 'Cryptic exon inclusion in STMN2 drives axonal degeneration in ALS.' }
  const sameMechanismDifferentClaim = { id: 'h10', text: 'STMN2 cryptic exons are irrelevant; the degeneration is mitochondrial.' }
  const gate = isNearDuplicate(restated, [restated], 0.7)
  assert.equal(gate.duplicate, true)
  assert.equal(gate.score, 1)
  assert.equal(gate.nearestId, 'h9')
  assert.equal(gate.measure, 'lexical', 'text-only items are scored lexically')
  assert.equal(isNearDuplicate(sameMechanismDifferentClaim, [restated], 0.7).duplicate, false, 'a rival explanation is not a duplicate')
  assert.equal(isNearDuplicate(restated, [], 0.7).duplicate, false, 'nothing to compare against is not a duplicate')
  assert.equal(isNearDuplicate(restated, [restated], 1).duplicate, true, 'the gate is inclusive; disabling it is the caller’s job (dup_threshold 1)')

  // An omitted threshold follows the measure, which is the whole point of
  // reporting the measure: cosine and Jaccard are not the same scale.
  assert.deepEqual(defaultThresholds('lexical'), { duplicate: 0.7, edge: 0.5 })
  assert.deepEqual(defaultThresholds('vector'), { duplicate: 0.92, edge: 0.7 })
  assert.equal(isNearDuplicate(restated, [restated]).threshold, 0.7)
  const autoVector = isNearDuplicate(
    { id: 'c', text: restated.text, vector: [1, 0, 0] },
    [{ id: 'n', text: restated.text, vector: [0.99, 0.01, 0] }],
  )
  assert.equal(autoVector.measure, 'vector')
  assert.equal(autoVector.threshold, 0.92, 'an embedded pool gets the cosine threshold without reconfiguring')
  assert.equal(autoVector.duplicate, true)

  const vectors = isNearDuplicate(
    { id: 'c', text: 'some claim', vector: [1, 0, 0] },
    [{ id: 'v-near', text: 'a', vector: [0.8, 0.6, 0] }, { id: 'v-ortho', text: 'b', vector: [0, 1, 0] }],
    VECTOR_DUPLICATE_THRESHOLD,
  )
  assert.equal(Number(vectors.score.toFixed(3)), 0.8)
  assert.equal(vectors.nearestId, 'v-near', 'the closest neighbour is reported even when it is not a duplicate')
  assert.equal(vectors.duplicate, false, 'cosine 0.8 stays below the 0.92 vector threshold')

  // A mixed pool is the bug this API change exists to prevent: comparing one
  // side's embedding against the other side's stringified digits would invent a
  // score on a scale that neither item is on.
  const mixed = isNearDuplicate(
    { id: 'embedded', text: 'Mitochondrial fission asymmetry starves the distal axon.', vector: [0.9, 0.1, 0] },
    [{ id: 'plain', text: 'Mitochondrial fission asymmetry starves the distal axon.' }],
    0.7,
  )
  assert.equal(mixed.measure, 'lexical', 'one embedded side is not a vector comparison')
  assert.equal(pairMeasure({ text: 'a', vector: [1, 0] }, { text: 'b' }), 'lexical')
  assert.equal(pairMeasure({ text: 'a', vector: [1, 0] }, { text: 'b', vector: [1, 0] }), 'vector')
  assert.equal(pairMeasure({ text: 'a', vector: [1, 0] }, { text: 'b', vector: [1, 0, 0] }), 'lexical', 'different dimensions are not comparable')
  assert.equal(pairSimilarity({ text: 'alpha beta gamma delta epsilon zeta' }, { text: 'alpha beta gamma delta epsilon zeta' }), 1)
  assert.equal(pairSimilarity({ text: 'alpha beta gamma delta epsilon zeta', vector: [1, 0] }, { text: 'alpha beta gamma delta epsilon eta', vector: [1, 0] }), 1, 'vectors win when both sides have them')
  assert.ok(pairSimilarity({ text: 'alpha beta gamma delta epsilon zeta' }, { text: 'alpha beta gamma delta epsilon eta' }) < 1)

  const pairs = similarityPairs([
    { id: 'h1', text: 'R-loop accumulation at TDP-43 loci impairs transcription.' },
    { id: 'h2', text: 'R-loop accumulation at TDP-43 loci impairs transcription.' },
    { id: 'h3', text: 'Phase separation of FUS condensates alters splicing fidelity.' },
  ])
  assert.equal(pairs.duplicates.length, 1)
  assert.deepEqual([pairs.duplicates[0].a, pairs.duplicates[0].b], ['h1', 'h2'])
  assert.equal(pairs.edges.length, 0, 'unrelated pairs produce no edge')
  const related = similarityPairs(
    [
      { id: 'h1', text: 'Cryptic exon inclusion in STMN2 drives axonal degeneration in ALS motor neurons via loss of STMN2 protein.' },
      { id: 'h2', text: 'Cryptic exon inclusion in STMN2 drives axonal degeneration in ALS motor neurons through impaired axonal repair.' },
    ],
    { edge: 0.2 },
  )
  assert.equal(related.edges.length, 1, 'a shared mechanism below the duplicate threshold is an edge')
  assert.ok(related.edges[0].score < LEXICAL_DUPLICATE_THRESHOLD)

  // ── safety gate ─────────────────────────────────────────────────────────────
  assert.deepEqual(SAFETY_SEVERITIES, ['none', 'low', 'moderate', 'high'])
  assert.equal(normalizeSafetySeverity('HIGH'), 'high')
  assert.equal(normalizeSafetySeverity('catastrophic'), 'none', 'an unknown severity is not a risk')
  assert.equal(normalizeSafetySeverity(null), 'none')
  assert.equal(decideSafety({ severity: 'high' }, 'high').decision, 'quarantined')
  assert.equal(decideSafety({ severity: 'moderate' }, 'high').decision, 'allowed')
  assert.equal(decideSafety({ severity: 'moderate' }, 'moderate').decision, 'quarantined', 'the threshold is inclusive')
  assert.equal(decideSafety({ severity: 'high' }, 'bogus').decision, 'quarantined', 'an invalid threshold falls back to high')
  const raised = decideSafety({ severity: 'none', priorSafetyFlag: true }, 'high')
  assert.equal(raised.severity, 'low', 'a prior review flag is never silently dropped')
  assert.equal(raised.decision, 'allowed')

  // ── feedback reward ─────────────────────────────────────────────────────────
  assert.equal(feedbackSentiment('the result was confirmed and robust'), 1)
  assert.equal(feedbackSentiment('the assay failed'), -1)
  assert.equal(feedbackSentiment('the sample was 30 microlitres'), 0, 'neutral prose carries no sentiment')
  assert.equal(feedbackSentiment('the results are inconsistent'), -1, 'inconsistent must not count as consistent')
  // Keyword counting cannot see negation: "replicate" is a positive term, so
  // "did not replicate" scores 2 negatives against 1 positive. Kept as upstream
  // implements it — which is why a reward is a signal, not a verdict.
  assert.equal(feedbackSentiment('the assay failed and the effect did not replicate'), -1 / 3)
  assert.equal(extractRewardFromFeedback('confirmed'), 1, 'absent scores shift all weight to sentiment')
  assert.equal(extractRewardFromFeedback('confirmed', 10, 10, 10), 0.4, 'perfect 0-10 scores normalize to zero, as upstream')
  assert.ok(extractRewardFromFeedback('confirmed', 10, 10, 10) > REWARD_WIN_THRESHOLD)
  assert.ok(extractRewardFromFeedback('refuted', 0, 0, 0) < -REWARD_WIN_THRESHOLD)
  const middling = extractRewardFromFeedback('mixed', 5, 5, 5)
  assert.equal(middling, -0.3, 'a flat 5/10 profile sits below neutral on the [-1,1] mapping')
  assert.ok(Math.abs(middling) < REWARD_WIN_THRESHOLD, 'and still scores as a draw')
  assert.ok(Math.abs(extractRewardFromFeedback('no sentiment here', 10, 10, 0) - 0.6 * (20 / 30 - 1)) < 1e-12)

  const boosted = applyFeedbackAsGlicko2Match(state(1200, 200), 1)
  assert.ok(boosted.rating > 1200, 'a validated hypothesis rises')
  assert.ok(boosted.rd < 200, 'and becomes more certain')
  const demoted = applyFeedbackAsGlicko2Match(state(1200, 200), -1)
  assert.ok(demoted.rating < 1200)
  const neutral = applyFeedbackAsGlicko2Match(state(1200, 200), 0)
  assert.equal(neutral.rating, 1200, 'a neutral reward is a draw against the baseline')
  assert.ok(neutral.rd < 200, 'even a draw tightens RD')

  // ── evolution seeding ───────────────────────────────────────────────────────
  assert.equal(evolvedSeedRating(1400).rating, 1190)
  assert.equal(evolvedSeedRating(1400).rd, GLICKO2_DEFAULTS.rd, 'a child has not competed')
  assert.equal(evolvedSeedRating(null).rating, 1200)
  assert.equal(evolvedSeedRating(undefined).rating, 1200)
  assert.equal(evolvedSeedRating('1400').rating, GLICKO2_DEFAULTS.rating, 'a non-number is not a rating, so the child starts at baseline')

  // ── seeded RNG ──────────────────────────────────────────────────────────────
  const replay = mulberry32(1234)
  const sequence = Array.from({ length: 12 }, () => replay())
  const replayed = mulberry32(1234)
  for (const value of sequence) assert.equal(value, replayed(), 'the same seed replays the same sequence')
  const drawRange = mulberry32(7)
  const range = Array.from({ length: 2000 }, () => drawRange())
  assert.ok(range.every((value) => value >= 0 && value < 1), 'mulberry32 stays in [0,1)')
  assert.ok(new Set(range.map((value) => value.toFixed(6))).size > 1500, 'the generator must not stall')
  assert.notEqual(mulberry32(1)(), mulberry32(2)(), 'different seeds differ')
  assert.equal(typeof makeRand(5)(), 'number')
  assert.equal(makeRand(undefined), Math.random, 'an unseeded session uses the platform source')
  assert.equal(makeRand('not-a-number'), Math.random, 'a garbage seed degrades rather than fixing the stream')
  const seededStreamA = makeRand(9)
  const seededStreamB = makeRand(9)
  assert.equal(seededStreamA(), seededStreamB(), 'makeRand is seeded too')
} catch (error) {
  console.error('coscientist-models FAILED')
  throw error
}

console.log('coscientist-models OK')
