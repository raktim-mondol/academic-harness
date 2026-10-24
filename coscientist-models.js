/**
 * Deterministic core of the Co-Scientist hypothesis tournament: rating math,
 * scheduling policy, matchup selection, duplicate gating, feedback rewards, and
 * the safety gate. Every function here is pure and dependency-free, and the
 * constants are carried over from the upstream `co-scientist` implementation so
 * that a tournament run here stays comparable to one run there. Numbers are
 * quoted with their upstream source because changing one silently breaks that
 * comparability — see docs/CO-SCIENTIST-INTEGRATION-PLAN.md §6.
 *
 * The plan/prompt files, the LLM calls, and the ledger live elsewhere; nothing
 * in this module knows about the model, the filesystem, or the workspace.
 */

// ─── Glicko-2 ─────────────────────────────────────────────────────────────────

/** Scale factor between the public rating scale and the internal one. */
export const GLICKO2_SCALE = 173.7178

/** System constant τ, constraining volatility change (Glickman: 0.3–1.2). */
export const TAU = 0.5

/** Starting state for a hypothesis that has never competed. */
export const GLICKO2_DEFAULTS = { rating: 1200, rd: 350, volatility: 0.06 }

/** RD once a hypothesis has been through review — prior information, so tighter. */
export const GLICKO2_REVIEWED_RD = 200

/** Upstream caps RD at the unreviewed value; a rating never gets less certain than that. */
const RD_CAP = 350

/** Match outcomes, in A's terms. */
export const MATCH_RESULTS = ['A_wins', 'B_wins', 'draw']

export function isMatchResult(value) {
  return MATCH_RESULTS.includes(value)
}

function toMu(rating) {
  return (rating - 1500) / GLICKO2_SCALE
}

function toPhi(rd) {
  return rd / GLICKO2_SCALE
}

function fromMu(mu) {
  return mu * GLICKO2_SCALE + 1500
}

function fromPhi(phi) {
  return phi * GLICKO2_SCALE
}

/** g(φ) — damps the effect of a match against an uncertain opponent. */
function g(phi) {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI))
}

/** E(μ, μⱼ, φⱼ) — expected score. */
function eExpected(mu, muJ, phiJ) {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)))
}

/**
 * New volatility σ′ via the Illinois algorithm (Glickman 2012, step 5).
 * ε 1e-6 and the 1000-iteration bracket both come from upstream.
 */
function computeNewVolatility(phi, sigma, delta, v) {
  const a = Math.log(sigma * sigma)
  const eps = 1e-6

  const f = (x) => {
    const ex = Math.exp(x)
    const phiSqPlusVPlusEx = phi * phi + v + ex
    const num = ex * (delta * delta - phiSqPlusVPlusEx)
    const den = 2 * phiSqPlusVPlusEx * phiSqPlusVPlusEx
    return num / den - (x - a) / (TAU * TAU)
  }

  let A = a
  let B
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v)
  } else {
    let k = 1
    while (f(a - k * TAU) < 0 && k < 1000) k += 1
    B = a - k * TAU
  }

  let fA = f(A)
  let fB = f(B)

  for (let i = 0; i < 1000 && Math.abs(B - A) > eps; i += 1) {
    const C = A + ((A - B) * fA) / (fB - fA)
    const fC = f(C)
    if (fC * fB <= 0) {
      A = B
      fA = fB
    } else {
      fA = fA / 2
    }
    B = C
    fB = fC
  }

  return Math.exp(A / 2)
}

function coerceState(state) {
  return {
    rating: Number(state?.rating ?? GLICKO2_DEFAULTS.rating),
    rd: Number(state?.rd ?? GLICKO2_DEFAULTS.rd),
    volatility: Number(state?.volatility ?? GLICKO2_DEFAULTS.volatility),
    matchesPlayed: Number(state?.matchesPlayed ?? 0),
    wins: Number(state?.wins ?? 0),
    losses: Number(state?.losses ?? 0),
    draws: Number(state?.draws ?? 0),
  }
}

/**
 * Glicko-2 update for one match (upstream `tournament.ts:177`). Each call is one
 * rating period for both players. Zero-sum to within rounding: the pair's total
 * rating is preserved by construction because both sides score against the same
 * expected-score term.
 */
export function computeGlicko2Update(playerA, playerB, result) {
  if (!isMatchResult(result)) throw new Error(`result must be one of ${MATCH_RESULTS.join(', ')}`)
  const a = coerceState(playerA)
  const b = coerceState(playerB)
  const scoreA = result === 'A_wins' ? 1 : result === 'B_wins' ? 0 : 0.5
  const scoreB = 1 - scoreA

  const update = (player, opponent, score) => {
    const mu = toMu(player.rating)
    const phi = toPhi(player.rd)
    const muJ = toMu(opponent.rating)
    const phiJ = toPhi(opponent.rd)

    const gPhiJ = g(phiJ)
    const eVal = Math.max(1e-10, Math.min(1 - 1e-10, eExpected(mu, muJ, phiJ)))
    const v = 1 / (gPhiJ * gPhiJ * eVal * (1 - eVal))
    const delta = v * gPhiJ * (score - eVal)
    const newSigma = computeNewVolatility(phi, player.volatility, delta, v)
    const phiStar = Math.sqrt(phi * phi + newSigma * newSigma)
    const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v)
    const newMu = mu + newPhi * newPhi * gPhiJ * (score - eVal)

    const won = score === 1
    const drew = score === 0.5
    return {
      rating: Math.round(fromMu(newMu)),
      rd: Math.min(RD_CAP, Math.round(fromPhi(newPhi))),
      volatility: Math.round(newSigma * 1e6) / 1e6,
      matchesPlayed: player.matchesPlayed + 1,
      wins: player.wins + (won ? 1 : 0),
      losses: player.losses + (!won && !drew ? 1 : 0),
      draws: player.draws + (drew ? 1 : 0),
    }
  }

  return { newA: update(a, b, scoreA), newB: update(b, a, scoreB) }
}

/**
 * Seed a rating from review scores (upstream `tournament.ts:250`):
 * `round(1000 + (mean/10) * 400)`, so a 5/10 average lands on the 1200 baseline
 * and an 8/10 gets a head start. Absent scores are ignored; no scores at all
 * leaves the state as unreviewed.
 */
export function seededGlicko2Rating(...scores) {
  const flat = scores.length === 1 && Array.isArray(scores[0]) ? scores[0] : scores
  const defined = flat
    .map((value) => (value === null || value === undefined || value === '' ? undefined : Number(value)))
    .filter((value) => Number.isFinite(value))
  const rating = defined.length === 0
    ? GLICKO2_DEFAULTS.rating
    : Math.round(1000 + (defined.reduce((sum, value) => sum + value, 0) / defined.length / 10) * 400)
  return {
    rating,
    rd: defined.length > 0 ? GLICKO2_REVIEWED_RD : GLICKO2_DEFAULTS.rd,
    volatility: GLICKO2_DEFAULTS.volatility,
  }
}

/** Floor applied to a seeded rating after the citation penalty (upstream `reflection.ts:175`). */
export const SEEDED_RATING_FLOOR = 1000

/**
 * Combine review scores and a citation-integrity penalty into the seed written
 * when a hypothesis enters the tournament. The penalty softens rather than
 * vetoes, and a penalized hypothesis also starts with a wider RD — the system is
 * less sure of it.
 */
export function seededRatingWithPenalty({ novelty, correctness, testability }, penalty = { ratingDelta: 0, rdDelta: 0 }) {
  const seed = seededGlicko2Rating(novelty, correctness, testability)
  return {
    rating: Math.max(SEEDED_RATING_FLOOR, seed.rating + (penalty.ratingDelta || 0)),
    rd: Math.min(RD_CAP, seed.rd + (penalty.rdDelta || 0)),
    volatility: seed.volatility,
  }
}

/**
 * Evolved children inherit 85 % of their best parent's rating (upstream
 * `evolution.ts:95-118`): lineage is rewarded, but the child still has to climb
 * through its own matches. RD resets to fully uncertain because it has not
 * competed.
 */
export function evolvedSeedRating(bestParentRating) {
  const parent = Number.isFinite(bestParentRating) ? bestParentRating : null
  return {
    rating: parent === null ? GLICKO2_DEFAULTS.rating : Math.round(parent * 0.85),
    rd: GLICKO2_DEFAULTS.rd,
    volatility: GLICKO2_DEFAULTS.volatility,
  }
}

// ─── Citation integrity ───────────────────────────────────────────────────────

/** Maximum rating points subtracted at a 100 % weighted fabrication rate. */
export const MAX_PENALTY = 150

/** Maximum RD points added at a 100 % weighted fabrication rate. */
export const MAX_RD_WIDEN = 100

/**
 * Soft penalty from citation counts (upstream `citationIntegrity.ts:11-27`).
 * An unverified citation is half as damaging as a fabricated one, and nothing is
 * damaging when there are no citations at all.
 */
export function citationPenalty({ total = 0, fabricated = 0, unverified = 0 } = {}) {
  if (total <= 0) return { f: 0, ratingDelta: 0, rdDelta: 0 }
  const f = (fabricated + 0.5 * unverified) / total
  return {
    f,
    ratingDelta: f > 0 ? -Math.round(f * MAX_PENALTY) : 0,
    rdDelta: Math.round(f * MAX_RD_WIDEN),
  }
}

// ─── Judge debiasing ──────────────────────────────────────────────────────────

export const VERDICTS = ['A', 'B', 'draw']

/**
 * Translate a verdict stated in the presented layout back to real A/B terms
 * (upstream `judgeDebias.ts:18`). Draw is orientation-independent.
 */
export function mapPresentedVerdict(presented, swapped) {
  const verdict = String(presented || '').trim()
  if (!VERDICTS.includes(verdict)) throw new Error(`verdict must be one of ${VERDICTS.join(', ')}`)
  if (!swapped || verdict === 'draw') return verdict
  return verdict === 'A' ? 'B' : 'A'
}

/**
 * Reconcile real-terms verdicts from opposite presentation orders (upstream
 * `judgeDebias.ts:34`). Agreement wins; a decisive verdict beats a draw; a
 * verdict that flips with order was position-driven and becomes a draw.
 */
export function combineSwappedVerdicts(normal, swapped) {
  const hasA = normal === 'A' || swapped === 'A'
  const hasB = normal === 'B' || swapped === 'B'
  if (hasA && hasB) return 'draw'
  if (hasA) return 'A'
  if (hasB) return 'B'
  return 'draw'
}

/** Verdict in match-result terms, for the Glicko-2 update. */
export function verdictToMatchResult(verdict) {
  return verdict === 'A' ? 'A_wins' : verdict === 'B' ? 'B_wins' : 'draw'
}

// ─── Seeded RNG ───────────────────────────────────────────────────────────────

/** mulberry32 (upstream `util/rng.ts:58`) — small, fast, 32-bit. */
export function mulberry32(seed) {
  let a = Number(seed) >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A rand function: seeded and reproducible when `seed` is finite, else Math.random. */
export function makeRand(seed) {
  const numeric = Number(seed)
  return Number.isFinite(numeric) ? mulberry32(numeric) : Math.random
}

// ─── Scheduling policy ────────────────────────────────────────────────────────

/** Task types the supervisor loop dispatches (upstream `models/agentTask.ts:3`). */
export const TASK_TYPES = ['generation', 'reflection', 'ranking', 'evolution', 'proximity', 'meta_review']

/** Weight keys, in the order upstream samples them. */
export const WEIGHT_KEYS = TASK_TYPES

/**
 * Dynamic weights by session phase (upstream `queue.ts:132-206`) — the paper's
 * resource-allocation strategy. Order of the branches matters: the review
 * backlog is checked before bootstrap so a pending-review spike is handled even
 * when few hypotheses are active.
 */
export function computeWeights(stats = {}) {
  const activeHypotheses = Number(stats.activeHypotheses ?? 0)
  const pendingReview = Number(stats.pendingReview ?? 0)
  const totalHypotheses = Number(stats.totalHypotheses ?? 0)
  const currentRound = Number(stats.currentRound ?? 0)
  const maxHypotheses = Number(stats.maxHypotheses ?? 0)

  const atCap = maxHypotheses > 0 && totalHypotheses >= maxHypotheses
  if (atCap) {
    return pendingReview > 0
      ? { generation: 0.0, reflection: 0.7, ranking: 0.15, evolution: 0.05, proximity: 0.05, meta_review: 0.05 }
      : { generation: 0.0, reflection: 0.1, ranking: 0.55, evolution: 0.25, proximity: 0.05, meta_review: 0.05 }
  }

  if (pendingReview > activeHypotheses * 0.5) {
    return { generation: 0.1, reflection: 0.55, ranking: 0.2, evolution: 0.08, proximity: 0.05, meta_review: 0.02 }
  }

  if (activeHypotheses < 3) {
    const canRank = activeHypotheses >= 2
    // Upstream's not-yet-rankable table sums to 1.03 rather than 1.0. Kept as
    // is: sampleNextTaskType renormalizes by the total, so only the ratios
    // matter, and changing them would break comparability with upstream runs.
    return canRank
      ? { generation: 0.5, reflection: 0.2, ranking: 0.2, evolution: 0.03, proximity: 0.04, meta_review: 0.03 }
      : { generation: 0.7, reflection: 0.22, ranking: 0.03, evolution: 0.03, proximity: 0.02, meta_review: 0.03 }
  }

  if (currentRound < 20) {
    return { generation: 0.3, reflection: 0.2, ranking: 0.3, evolution: 0.1, proximity: 0.07, meta_review: 0.03 }
  }

  return { generation: 0.15, reflection: 0.2, ranking: 0.3, evolution: 0.25, proximity: 0.05, meta_review: 0.05 }
}

/**
 * Weighted sample of the next task type (upstream `queue.ts:214`). `rand` is
 * injectable so a seeded session replays its schedule exactly.
 */
export function sampleNextTaskType(weights, rand = Math.random) {
  const entries = WEIGHT_KEYS.map((key) => [key, Number(weights[key] ?? 0)])
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0)
  if (total <= 0) return 'generation'
  let draw = rand() * total
  for (const [type, weight] of entries) {
    draw -= weight
    if (draw <= 0) return type
  }
  return 'generation'
}

/**
 * Termination check (upstream `queue.ts:240-280`, kept in priority order).
 * Returns the reason alongside the boolean because the leaderboard has to say
 * why a tournament stopped; upstream only logged it.
 */
export function terminationCheck(stats = {}, eloHistory = []) {
  const tokensUsed = Number(stats.tokensUsed ?? 0)
  const budgetTokens = Number(stats.budgetTokens ?? 0)
  const currentRound = Number(stats.currentRound ?? 0)
  const totalMatches = Number(stats.totalMatches ?? 0)
  const maxMatches = Number(stats.maxMatches ?? 0)
  const activeHypotheses = Number(stats.activeHypotheses ?? 0)
  const pendingReview = Number(stats.pendingReview ?? 0)
  const totalHypotheses = Number(stats.totalHypotheses ?? 0)
  const maxHypotheses = Number(stats.maxHypotheses ?? 0)

  if (budgetTokens > 0 && tokensUsed >= budgetTokens) {
    return { terminate: true, reason: 'budget_exhausted' }
  }

  // An explicit user stop bound wins over the phase rules below (including the
  // round-10 floor), because it is a request, not a policy inference.
  if (maxMatches > 0 && totalMatches >= maxMatches) {
    return { terminate: true, reason: 'match_cap_reached' }
  }

  const atCap = maxHypotheses > 0 && totalHypotheses >= maxHypotheses
  // A pool too small to field a match is finished, not waiting for one. Upstream
  // capped tournaments at 5–20 hypotheses so this rarely bit; with a small
  // default pool a single review veto can leave one candidate and nothing left
  // to generate, and every later round would then only burn the budget. Not
  // gated on currentRound for the same reason: there is no work for rounds to do.
  if (atCap && pendingReview === 0 && activeHypotheses < 2) {
    return { terminate: true, reason: 'no_competitors' }
  }

  // Upstream refuses to stop before round 10, so a lucky early plateau cannot
  // cut a tournament short.
  if (currentRound < 10) return { terminate: false, reason: null }

  if (eloHistory.length >= 20) {
    const recent = eloHistory.slice(-20)
    const change = Math.abs(recent[recent.length - 1] - recent[0])
    const maxEver = Math.max(...eloHistory)
    if (totalMatches >= 10 && maxEver > 1210 && change < 5) {
      return { terminate: true, reason: 'elo_plateau' }
    }
  }

  if (atCap && pendingReview === 0 && totalMatches >= activeHypotheses * 3) {
    return { terminate: true, reason: 'cap_reached_and_ranked' }
  }

  return { terminate: false, reason: null }
}

/** Generation-strategy rotation (upstream `generation.ts:363-370`). */
export function selectGenerationStrategy(activeCount, round) {
  if (activeCount < 3) return 'literature_exploration'
  const cycle = ['scientific_debate', 'assumption_chaining', 'research_expansion', 'literature_exploration']
  return cycle[round % 4]
}

const EVOLUTION_STRATEGIES = ['grounding', 'coherence', 'cross_pollination', 'combination', 'simplification', 'out_of_box']

/** Mutation rotation (upstream `evolution.ts:245-255`). */
export function selectEvolutionStrategy(round) {
  return EVOLUTION_STRATEGIES[Number(round) % EVOLUTION_STRATEGIES.length]
}

export { EVOLUTION_STRATEGIES }

// ─── Matchup selection ────────────────────────────────────────────────────────

/** Pair key independent of presentation order. */
export function matchupKey(a, b) {
  return [String(a), String(b)].sort().join('|')
}

/**
 * Pick the pair for the next match (upstream `ranking.ts:319-346`).
 *
 * When `playedPairs` is supplied, a pair that has never met is chosen before a
 * repeat, so every active pair meets at least once and a small pool yields a
 * complete first ranking instead of replaying one matchup. Inside that fresh set
 * the same uncertainty priority applies. Once every pair has met, selection is
 * the upstream uncertainty-first rule: an uncertain (high-RD) hypothesis against
 * a similar one from the proximity graph, then any high-RD hypothesis against a
 * random peer from the top-of-priority slice; never against itself.
 * `neighboursOf(id)` returns similar ids.
 */
export function selectMatchup(hypotheses = [], neighboursOf = () => [], rand = Math.random, { playedPairs = [] } = {}) {
  const active = hypotheses.filter((h) => h && h.id !== undefined)
  if (active.length < 2) return null

  const priorityOf = (hyp) => (Number(hyp.rd ?? GLICKO2_DEFAULTS.rd)) / (Number(hyp.matchesPlayed ?? 0) + 1)
  const played = new Set((playedPairs || []).map((pair) => {
    const [a, b] = Array.isArray(pair) ? pair : String(pair).split('|')
    return matchupKey(a, b)
  }))

  if (played.size > 0) {
    const fresh = []
    for (let i = 0; i < active.length; i += 1) {
      for (let j = i + 1; j < active.length; j += 1) {
        if (!played.has(matchupKey(active[i].id, active[j].id))) fresh.push([active[i], active[j]])
      }
    }
    if (fresh.length > 0) {
      const chosen = fresh
        .map(([a, b]) => ({ a, b, priority: Math.max(priorityOf(a), priorityOf(b)) }))
        .sort((x, y) => y.priority - x.priority || matchupKey(x.a.id, x.b.id).localeCompare(matchupKey(y.a.id, y.b.id)))[0]
      const [primary, opponent] = priorityOf(chosen.a) >= priorityOf(chosen.b)
        ? [chosen.a, chosen.b]
        : [chosen.b, chosen.a]
      return { primary, opponent, basis: 'unplayed_pair' }
    }
  }

  const scored = active
    .map((hyp) => ({ hyp, priority: priorityOf(hyp) }))
    .sort((a, b) => b.priority - a.priority)

  const primary = scored[0].hyp
  const similarIds = neighboursOf(primary.id) || []
  const similar = active.find((hyp) => similarIds.includes(hyp.id) && hyp.id !== primary.id)
  if (similar) return { primary, opponent: similar, basis: 'uncertain_and_similar' }

  const pool = scored.slice(1, Math.min(10, scored.length))
  if (pool.length === 0) return null
  const pick = pool[Math.floor(rand() * pool.length)] || pool[0]
  if (!pick || pick.hyp.id === primary.id) return null
  return { primary, opponent: pick.hyp, basis: 'uncertain_vs_pool' }
}

// ─── Similarity and duplicate gating ──────────────────────────────────────────

/** Cosine thresholds carried over from upstream (`proximity.ts:10-11`, `diversity.ts`). */
export const VECTOR_DUPLICATE_THRESHOLD = 0.92
export const VECTOR_EDGE_THRESHOLD = 0.7

/**
 * Jaccard threshold for the lexical gate. Lexical shingle overlap and unit-norm
 * cosine are not the same measure, so this is calibrated to be roughly as strict
 * as upstream's 0.92 cosine: it fires on near-verbatim restatements, not on two
 * hypotheses that share a mechanism but differ in claim.
 */
export const LEXICAL_DUPLICATE_THRESHOLD = 0.7
export const LEXICAL_EDGE_THRESHOLD = 0.5

/** Pure cosine similarity; 0 on a length mismatch or a zero vector. */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

function normalizeWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
}

/**
 * Words worth matching on. Order-free, so it is the measure for "does this text
 * concern the same thing" (retrieval, title identity) rather than "is this the
 * same sentence" — which is what `textShingles` above is for.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have',
  'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'them',
  'then', 'there', 'these', 'this', 'to', 'via', 'was', 'were', 'which', 'with',
  'without', 'study', 'studies', 'paper', 'novel', 'effect', 'using', 'based',
])

/** Significant words of a phrase: lowercased, alphanumerics, no stopwords or bare years. */
export function contentTokens(value) {
  return normalizeWords(value).filter((token) => !STOPWORDS.has(token) && !/^\d{4}$/.test(token))
}

/**
 * Overlap coefficient: shared tokens over the *smaller* side. Jaccard would
 * punish a short query for not repeating every word of a long document, which is
 * backwards for retrieval — a subset should read as a strong match.
 */
export function tokenOverlap(one, other) {
  const a = new Set(contentTokens(one))
  const b = new Set(contentTokens(other))
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / Math.min(a.size, b.size)
}

/** Word-level shingles: every run of `n` consecutive words. */
export function textShingles(text, n = 5) {
  const words = normalizeWords(text)
  const shingles = new Set()
  if (words.length === 0) return shingles
  if (words.length < n) {
    shingles.add(words.join(' '))
    return shingles
  }
  for (let i = 0; i + n <= words.length; i += 1) shingles.add(words.slice(i, i + n).join(' '))
  return shingles
}

export function jaccardSimilarity(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const item of a) if (b.has(item)) shared += 1
  return shared / (a.size + b.size - shared)
}

/**
 * Compare two `{ text, vector }` items.
 *
 * Cosine only when **both** sides are embedded; otherwise lexical. Silently
 * comparing an embedding against a string is worse than either measure:
 * `String([0.1, 0.2, …])` shingles into digit tokens and can score high by
 * accident, so a partially embedded pool must degrade to the honest measure.
 */
export function pairSimilarity(one, other) {
  const embedded = Array.isArray(one?.vector) && Array.isArray(other?.vector) && one.vector.length === other.vector.length
  if (embedded) return cosineSimilarity(one.vector, other.vector)
  return jaccardSimilarity(textShingles(one?.text), textShingles(other?.text))
}

/** Which measure scored a pair, so 0.92 is never read as a 0.70-scale number. */
export function pairMeasure(one, other) {
  const embedded = Array.isArray(one?.vector) && Array.isArray(other?.vector) && one.vector.length === other.vector.length
  return embedded ? 'vector' : 'lexical'
}

/**
 * Thresholds per measure. Cosine and Jaccard are different scales: upstream's
 * 0.92 cosine is roughly as strict as 0.70 Jaccard over 5-word shingles, while
 * 0.70 cosine would wave unrelated ideas through as "similar".
 */
export function defaultThresholds(measure) {
  return measure === 'vector'
    ? { duplicate: VECTOR_DUPLICATE_THRESHOLD, edge: VECTOR_EDGE_THRESHOLD }
    : { duplicate: LEXICAL_DUPLICATE_THRESHOLD, edge: LEXICAL_EDGE_THRESHOLD }
}

/**
 * Save-time near-duplicate gate (upstream `diversity.ts:30`). An explicit
 * threshold wins; omitted means "whatever this measure's scale implies", so a
 * session that starts embedding its hypotheses gets 0.92 without reconfiguring.
 * A threshold ≥ 1 disables the gate. The nearest neighbour, the measure, and the
 * limit in force are reported either way, so a discard can be argued with rather
 * than merely obeyed.
 */
export function isNearDuplicate(candidate, neighbours = [], threshold) {
  let best = 0
  let nearestId
  let measure = 'lexical'
  for (const neighbour of neighbours) {
    const value = pairSimilarity(candidate, neighbour)
    if (value > best) {
      best = value
      nearestId = neighbour.id
      measure = pairMeasure(candidate, neighbour)
    }
  }
  const limit = threshold ?? defaultThresholds(measure).duplicate
  return { duplicate: nearestId !== undefined && best >= limit, nearestId, score: best, measure, threshold: limit }
}

/**
 * Similarity edges over a set (upstream `proximity.ts:56-105`). Above the
 * duplicate threshold a pair is a duplicate rather than an edge; the caller
 * decides which member to withhold, and upstream keeps the higher-rated one.
 */
export function similarityPairs(items = [], overrides = {}) {
  const edges = []
  const duplicates = []
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const measure = pairMeasure(items[i], items[j])
      const limits = defaultThresholds(measure)
      const duplicate = overrides.duplicate ?? limits.duplicate
      const edge = overrides.edge ?? limits.edge
      const score = pairSimilarity(items[i], items[j])
      const pair = { a: items[i].id, b: items[j].id, score: Number(score.toFixed(4)), measure }
      if (score >= duplicate) duplicates.push({ ...pair, threshold: duplicate })
      else if (score >= edge) edges.push({ ...pair, threshold: edge })
    }
  }
  return { edges, duplicates }
}

// ─── Safety gate ──────────────────────────────────────────────────────────────

export const SAFETY_SEVERITIES = ['none', 'low', 'moderate', 'high']

const SEVERITY_RANK = { none: 0, low: 1, moderate: 2, high: 3 }

/** Coerce arbitrary classifier output into a valid severity (`safety.ts:33`). */
export function normalizeSafetySeverity(raw) {
  const value = String(raw ?? '').trim().toLowerCase()
  return SAFETY_SEVERITIES.includes(value) ? value : 'none'
}

/**
 * Rank a severity. An unrecognised *threshold* defaults to the strictest level:
 * falling back to `none` would quarantine every hypothesis, which is the
 * opposite of what a malformed setting should do.
 */
function safetyRank(value, fallback) {
  const normalized = String(value ?? '').trim().toLowerCase()
  return SAFETY_SEVERITIES.includes(normalized) ? SEVERITY_RANK[normalized] : SEVERITY_RANK[fallback]
}

/**
 * Pure quarantine decision (upstream `safety.ts:44-56`). Quarantine is withheld,
 * not deleted, and an earlier review-stage flag raises a `none` classification to
 * `low` so a prior concern is never silently dropped.
 */
export function decideSafety({ severity, priorSafetyFlag = false }, threshold = 'high') {
  let adjusted = normalizeSafetySeverity(severity)
  if (priorSafetyFlag && SEVERITY_RANK[adjusted] < SEVERITY_RANK.low) adjusted = 'low'
  const limit = safetyRank(threshold, 'high')
  return { severity: adjusted, decision: safetyRank(adjusted, 'none') >= limit ? 'quarantined' : 'allowed' }
}

// ─── Experimental feedback (RLEF) ─────────────────────────────────────────────

const POSITIVE_TERMS = [
  'confirm', 'confirmed', 'confirms', 'validate', 'validated', 'validates',
  'support', 'supports', 'supported', 'replicate', 'replicated', 'replicates',
  'success', 'successful', 'effective', 'efficacious', 'significant',
  'improve', 'improved', 'improvement', 'increase', 'increased',
  'reduce', 'reduced', 'reduction', 'inhibit', 'inhibited', 'inhibition',
  'positive', 'promising', 'excellent', 'strong', 'robust', 'consistent',
  'works', 'worked', 'correct', 'accurate', 'novel', 'breakthrough',
]

const NEGATIVE_TERMS = [
  'refute', 'refuted', 'refutes', 'reject', 'rejected', 'rejects',
  'fail', 'failed', 'fails', 'failure', 'ineffective', 'inefficacious',
  'contradict', 'contradicts', 'contradicted', 'disprove', 'disproved',
  'negative', 'poor', 'weak', 'inconsistent', 'unreliable', 'incorrect',
  'no effect', 'no significant', 'not significant', 'not effective',
  'does not', 'did not', 'cannot', 'could not', 'unable',
  'toxic', 'harmful', 'dangerous', 'unsafe',
]

/**
 * Keyword sentiment in [-1, 1]. Multi-word terms match as substrings, single
 * words as whole tokens — token matching is what keeps "inconsistent" from
 * also counting as the positive term "consistent".
 */
export function feedbackSentiment(text) {
  const lower = String(text || '').toLowerCase()
  const words = new Set(lower.split(/\W+/))
  let positive = 0
  let negative = 0
  for (const term of POSITIVE_TERMS) {
    if (term.includes(' ') ? lower.includes(term) : words.has(term)) positive += 1
  }
  for (const term of NEGATIVE_TERMS) {
    if (term.includes(' ') ? lower.includes(term) : words.has(term)) negative += 1
  }
  const total = positive + negative
  if (total === 0) return 0
  return Math.max(-1, Math.min(1, (positive - negative) / total))
}

/**
 * Reward in [-1, 1] from feedback text and optional 0–10 scores (upstream
 * `reward-signal.ts:65-82`). Scores are averaged and normalized to [-1, 1]
 * (sum/30 − 1), then weighted 0.6 against a 0.4 sentiment. Absent scores shift
 * the whole weight onto sentiment rather than treating them as zero.
 */
export function extractRewardFromFeedback(feedbackText, novelty, correctness, testability) {
  const sentiment = feedbackSentiment(feedbackText)
  const scores = [novelty, correctness, testability].map((v) => (v === null || v === undefined || v === '' ? undefined : Number(v)))
  if (scores.some((v) => !Number.isFinite(v))) return sentiment
  const scoreAvg = scores.reduce((sum, v) => sum + v, 0) / 30 - 1
  return Math.max(-1, Math.min(1, 0.4 * sentiment + 0.6 * scoreAvg))
}

/**
 * The empirical baseline as a Glicko-2 opponent (upstream `reward-signal.ts:90`).
 * A low RD means the baseline is confident, which tightens the hypothesis's own
 * RD faster than a match against an uncertain peer would.
 */
export const VIRTUAL_OPPONENT = { ...GLICKO2_DEFAULTS, rd: 50, matchesPlayed: 0, wins: 0, losses: 0, draws: 0 }

/** Rewards inside ±0.33 are neutral and score as a draw (`reward-signal.ts:101`). */
export const REWARD_WIN_THRESHOLD = 0.33

/** Feedback applied as a Glicko-2 match against the virtual opponent. */
export function applyFeedbackAsGlicko2Match(state, reward) {
  const result = reward > REWARD_WIN_THRESHOLD ? 'A_wins' : reward < -REWARD_WIN_THRESHOLD ? 'B_wins' : 'draw'
  return computeGlicko2Update(state, VIRTUAL_OPPONENT, result).newA
}
