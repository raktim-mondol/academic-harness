/**
 * Append-only hypothesis-tournament ledger under `<cwd>/.dsh/coscientist/<slug>/`.
 *
 * `events.jsonl` records every hypothesis transition and every scheduling
 * decision; `matches.jsonl` records judged pairs. Current state — including
 * every rating — is derived by replaying the logs, so `snapshot.json` is a
 * regenerable cache rather than a second source of truth, and a session can be
 * resumed, audited, or rebuilt from the log alone. No database, no server.
 *
 * Rating arithmetic, scheduling policy, duplicate gating, and the safety
 * decision live in `coscientist-models.js`. This module is storage, validation,
 * and sequencing only — one place for the math is what keeps a resumed
 * tournament from drifting from the one that produced the log.
 */
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { reviewSlug } from './review-store.js'
import { writeJsonAtomic, withLock } from './store-lock.js'
import {
  GLICKO2_DEFAULTS,
  SAFETY_SEVERITIES, applyFeedbackAsGlicko2Match, citationPenalty, combineSwappedVerdicts,
  computeGlicko2Update, computeWeights, decideSafety, evolvedSeedRating,
  extractRewardFromFeedback, feedbackSentiment, isNearDuplicate, mapPresentedVerdict, matchupKey,
  sampleNextTaskType, selectMatchup, similarityPairs, tokenOverlap,
  terminationCheck, verdictToMatchResult, seededRatingWithPenalty,
} from './coscientist-models.js'

const FILES = {
  protocol: 'protocol.json',
  events: 'events.jsonl',
  matches: 'matches.jsonl',
  snapshot: 'snapshot.json',
}

/** Review stages in the order they must be recorded (upstream `reflection.ts`). */
export const REVIEW_STAGES = ['initial', 'full', 'deep_verification', 'simulation', 'observation']

/** A `fail` vetoes only at these two stages. The nuanced later reviews feed the
 *  seed instead, so a hypothesis still reaches the debate that can rescue it. */
export const VETO_STAGES = ['initial', 'full']

export const VERDICTS = ['pass', 'fail', 'uncertain']
export const HYPOTHESIS_STATUSES = ['pending_review', 'active', 'rejected', 'quarantined']
export const MATCH_TYPES = ['simple', 'debate']

/**
 * A tournament defaults to five hypotheses — upstream's own cap, kept so a run
 * here stays comparable to a run there, and the smallest pool that survives
 * ordinary attrition. At three, one review veto plus one dual-use withholding
 * leaves a single candidate and nothing can be matched; at five, losing two
 * still leaves three competing, each pair meeting about three times. Past five
 * the per-pair count falls below two, so the extra ideas buy breadth while the
 * ranking degrades into a transitive chain of results.
 */
export const DEFAULT_MAX_HYPOTHESES = 5

/**
 * Dispatch rounds sized to finish a five-hypothesis pool: ~8 generations to land
 * five accepted ideas past the duplicate gate, 5 reflection rounds, then the 15
 * matches the cap rule requires (3 per active hypothesis), plus a little
 * meta-review and proximity overhead — about 31 rounds, so 36 leaves slack
 * without letting a stalled loop wander. It is also the smallest budget where
 * `elo_plateau` can fire at all, since that rule needs 20 dispatch samples and
 * at least 10 matches. Raise both defaults together: a bigger pool on this
 * budget stops on `budget_exhausted` instead of on converged rankings.
 */
export const DEFAULT_STEP_BUDGET = 36
export const TOP_ELO_WINDOW = 10

/** Rating a hypothesis is floored at once it has been penalized. */
const RATING_FLOOR = 1000

const withLedgerLock = (dir, fn) => withLock(dir, fn, { label: 'tournament ledger' })

function nowIso() {
  return new Date().toISOString()
}

/** One-line fields: titles, ids, categories, goals. */
function text(value) {
  if (value == null) return ''
  if (Array.isArray(value)) return text(value[0])
  return String(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

/** Multi-line fields: hypothesis prose must survive a round trip intact. */
function prose(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim()
}

function list(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean)
  const single = text(value)
  return single ? [single] : []
}

function number(value) {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function clampScore(value, label) {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number`)
  if (parsed < 0 || parsed > 10) throw new Error(`${label} must be between 0 and 10`)
  return parsed
}

export function tournamentSlug(value) {
  return reviewSlug(value)
}

export function tournamentDir(cwd, slug) {
  return join(resolve(cwd), '.dsh', 'coscientist', tournamentSlug(slug))
}

function fileOf(cwd, slug, key) {
  return join(tournamentDir(cwd, slug), FILES[key])
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'exports'), { recursive: true })
  for (const key of ['events', 'matches']) {
    const file = join(dir, FILES[key])
    if (!existsSync(file)) writeFileSync(file, '')
  }
}

function ensureSession(cwd, slug) {
  const protocol = fileOf(cwd, slug, 'protocol')
  if (!existsSync(protocol)) throw new Error(`tournament "${tournamentSlug(slug)}" has not been started`)
  return tournamentDir(cwd, slug)
}

function readJsonl(file, label) {
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split('\n')
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) continue
    try {
      rows.push(JSON.parse(line))
    } catch (error) {
      throw new Error(`${label} line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return rows
}

function appendEvents(dir, rows) {
  appendFileSync(join(dir, FILES.events), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
}

function appendMatches(dir, rows) {
  appendFileSync(join(dir, FILES.matches), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
}

export function readProtocol(cwd, slug) {
  ensureSession(cwd, slug)
  return JSON.parse(readFileSync(fileOf(cwd, slug, 'protocol'), 'utf8'))
}

// ─── Derived state ────────────────────────────────────────────────────────────

function newHypothesis(event) {
  return {
    id: event.hypothesisId,
    title: event.title || '',
    summary: event.summary || '',
    content: event.content || '',
    rationale: event.rationale || '',
    experimental_plan: event.experimental_plan || '',
    novelty_assessment: event.novelty_assessment || '',
    key_assumptions: event.key_assumptions || [],
    citations: event.citations || [],
    status: 'pending_review',
    rating: event.rating ?? GLICKO2_DEFAULTS.rating,
    rd: event.rd ?? GLICKO2_DEFAULTS.rd,
    volatility: event.volatility ?? GLICKO2_DEFAULTS.volatility,
    matchesPlayed: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    strategy: event.strategy || null,
    round: event.round ?? null,
    parentIds: event.parent_ids || [],
    text: event.text || `${event.title || ''}. ${event.summary || ''}`,
    vector: event.vector,
    createdAt: event.ts,
    updatedAt: event.ts,
    reviews: [],
    feedback: [],
    safety: null,
    citationCheck: null,
    penaltyApplied: null,
    protocolPlan: null,
    statusReason: '',
  }
}

/**
 * Replay the log into current state. `added` creates a hypothesis; `reviewed`,
 * `provenance`, `safety`, `status`, `feedback`, and `protocol` mutate it;
 * `dispatch` records one scheduling round together with the top-10 average Elo
 * observed at that moment, which is what lets plateau detection work after a
 * resume; `synthesis` holds the meta-review critique and the final overview.
 */
export function deriveState(cwd, slug) {
  const dir = ensureSession(cwd, slug)
  const protocol = JSON.parse(readFileSync(join(dir, FILES.protocol), 'utf8'))
  const events = readJsonl(join(dir, FILES.events), FILES.events)
  const matches = readJsonl(join(dir, FILES.matches), FILES.matches)

  const byId = new Map()
  const dispatches = []
  let critique = ''
  let overview = ''

  for (const event of events) {
    if (event.type === 'added') {
      byId.set(event.hypothesisId, newHypothesis(event))
      continue
    }
    if (event.type === 'dispatch') {
      dispatches.push(event)
      continue
    }
    if (event.type === 'synthesis') {
      if (event.critique) critique = event.critique
      if (event.overview) overview = event.overview
      continue
    }

    const hyp = byId.get(event.hypothesisId)
    if (!hyp) continue
    hyp.updatedAt = event.ts

    if (event.type === 'reviewed') {
      hyp.reviews = hyp.reviews.filter((review) => review.stage !== event.stage)
      hyp.reviews.push({
        stage: event.stage,
        verdict: event.verdict,
        novelty_score: event.novelty_score,
        correctness_score: event.correctness_score,
        testability_score: event.testability_score,
        safety_flag: Boolean(event.safety_flag),
        summary: event.summary || '',
        critique: event.critique || '',
        supporting_evidence: event.supporting_evidence || [],
        ts: event.ts,
      })
      if (event.status) hyp.status = event.status
      if (event.rating !== undefined) hyp.rating = event.rating
      if (event.rd !== undefined) hyp.rd = event.rd
      if (event.volatility !== undefined) hyp.volatility = event.volatility
      // A seed that already folded a citation penalty in has paid for it; the
      // bookkeeping below must not charge the same penalty a second time.
      if (event.penalty_applied) {
        hyp.penaltyApplied = { ...event.penalty_applied, foldedIntoSeed: true, ts: event.ts }
      }
      continue
    }

    if (event.type === 'provenance') {
      hyp.citationCheck = {
        total: event.total,
        verified: event.verified,
        unverified: event.unverified,
        fabricated: event.fabricated,
        reportedCounts: Boolean(event.reportedCounts),
        f: event.f,
        ratingDelta: event.ratingDelta,
        rdDelta: event.rdDelta,
        summary: event.summary,
        claims: event.claims || null,
        contradicted: (event.claims || []).filter((claim) => claim.support === 'contradicts').length,
        ts: event.ts,
      }
      continue
    }

    if (event.type === 'penalty') {
      hyp.penaltyApplied = {
        ratingDelta: event.ratingDelta,
        rdDelta: event.rdDelta,
        appliedRatingDelta: event.appliedRatingDelta,
        appliedRdDelta: event.appliedRdDelta,
        ts: event.ts,
      }
      hyp.rating = event.rating
      hyp.rd = event.rd
      hyp.volatility = event.volatility
      continue
    }

    if (event.type === 'safety') {
      hyp.safety = {
        severity: event.severity,
        category: event.category,
        reasoning: event.reasoning || '',
        decision: event.decision,
        threshold: event.threshold,
        released_by: event.overridden_by || null,
        release_reason: event.release_reason || null,
        ts: event.ts,
      }
      continue
    }

    if (event.type === 'feedback') {
      hyp.feedback.push({
        feedback_text: event.feedback_text,
        sentiment: event.sentiment,
        reward: event.reward,
        novelty: event.novelty,
        correctness: event.correctness,
        testability: event.testability,
        recorded_by: event.recorded_by,
        rating_before: event.rating_before,
        rating_after: event.rating_after,
        rd_after: event.rd_after,
        ts: event.ts,
      })
      hyp.rating = event.rating
      hyp.rd = event.rd
      hyp.volatility = event.volatility
      continue
    }

    if (event.type === 'embedded') {
      hyp.vector = event.vector
      continue
    }

    if (event.type === 'protocol') {
      hyp.protocolPlan = { steps: event.steps || [], ts: event.ts }
      continue
    }

    if (event.type === 'status') {
      hyp.status = event.status
      hyp.statusReason = event.reason || ''
      continue
    }
  }

  // Match records are the ledger for competition; ratings replay from them so a
  // rebuilt snapshot equals the one that was cached.
  for (const match of matches) {
    const hypA = byId.get(match.hypothesisAId)
    const hypB = byId.get(match.hypothesisBId)
    const tally = (hyp, won) => {
      if (!hyp) return
      hyp.matchesPlayed += 1
      if (won === 'win') hyp.wins += 1
      else if (won === 'draw') hyp.draws += 1
      else hyp.losses += 1
    }
    tally(hypA, match.result === 'A_wins' ? 'win' : match.result === 'draw' ? 'draw' : 'loss')
    tally(hypB, match.result === 'B_wins' ? 'win' : match.result === 'draw' ? 'draw' : 'loss')
    if (hypA && match.ratingAfterA !== undefined) {
      hypA.rating = match.ratingAfterA
      hypA.rd = match.rdAfterA ?? hypA.rd
    }
    if (hypB && match.ratingAfterB !== undefined) {
      hypB.rating = match.ratingAfterB
      hypB.rd = match.rdAfterB ?? hypB.rd
    }
  }

  const hypotheses = [...byId.values()]
  const counts = {
    total: hypotheses.length,
    active: hypotheses.filter((hyp) => hyp.status === 'active').length,
    pendingReview: hypotheses.filter((hyp) => hyp.status === 'pending_review').length,
    rejected: hypotheses.filter((hyp) => hyp.status === 'rejected').length,
    quarantined: hypotheses.filter((hyp) => hyp.status === 'quarantined').length,
    totalMatches: matches.length,
  }

  const ranked = hypotheses
    .filter((hyp) => hyp.status !== 'rejected')
    .sort((a, b) => b.rating - a.rating || String(a.id).localeCompare(String(b.id)))

  const topRatings = ranked.slice(0, TOP_ELO_WINDOW).map((hyp) => hyp.rating)
  const avgTopTenElo = topRatings.length
    ? topRatings.reduce((sum, value) => sum + value, 0) / topRatings.length
    : GLICKO2_DEFAULTS.rating

  return {
    protocol,
    hypotheses,
    byId: new Map(hypotheses.map((hyp) => [hyp.id, hyp])),
    ranked,
    matches,
    counts,
    rounds: dispatches.length,
    dispatches,
    eloHistory: dispatches.map((event) => event.avg_top_elo).filter((value) => typeof value === 'number'),
    avgTopTenElo,
    topEloRating: topRatings[0] ?? GLICKO2_DEFAULTS.rating,
    critique,
    overview,
    derivedAt: nowIso(),
  }
}

function refreshSnapshot(cwd, slug, state) {
  const snapshot = {
    slug: state.protocol.slug,
    snapshotAt: state.derivedAt,
    counts: state.counts,
    rounds: state.rounds,
    avgTopTenElo: Number(state.avgTopTenElo.toFixed(1)),
    hypotheses: state.ranked.concat(state.hypotheses.filter((hyp) => hyp.status === 'rejected')).map((hyp) => ({
      id: hyp.id,
      title: hyp.title,
      status: hyp.status,
      rating: hyp.rating,
      rd: hyp.rd,
      matchesPlayed: hyp.matchesPlayed,
      wins: hyp.wins,
      losses: hyp.losses,
      draws: hyp.draws,
      strategy: hyp.strategy,
      parentIds: hyp.parentIds,
      reviews: hyp.reviews.map((review) => review.stage),
    })),
  }
  writeJsonAtomic(fileOf(cwd, slug, 'snapshot'), snapshot)
  return snapshot
}

export function readSnapshot(cwd, slug) {
  const file = fileOf(cwd, slug, 'snapshot')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Public view of a hypothesis: internal similarity fields stay internal. */
export function publicHypothesis(hyp) {
  if (!hyp) return null
  return {
    id: hyp.id,
    title: hyp.title,
    summary: hyp.summary,
    content: hyp.content,
    rationale: hyp.rationale,
    experimental_plan: hyp.experimental_plan,
    novelty_assessment: hyp.novelty_assessment,
    key_assumptions: hyp.key_assumptions,
    citations: hyp.citations,
    status: hyp.status,
    status_reason: hyp.statusReason,
    rating: hyp.rating,
    rd: hyp.rd,
    volatility: hyp.volatility,
    matches_played: hyp.matchesPlayed,
    wins: hyp.wins,
    losses: hyp.losses,
    draws: hyp.draws,
    strategy: hyp.strategy,
    round: hyp.round,
    parent_ids: hyp.parentIds,
    reviews: hyp.reviews,
    feedback: hyp.feedback,
    safety: hyp.safety,
    citation_check: hyp.citationCheck,
    citation_penalty: hyp.penaltyApplied,
    experiment_protocol: hyp.protocolPlan,
    created_at: hyp.createdAt,
    updated_at: hyp.updatedAt,
  }
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

const GOAL_FIELDS = ['goal', 'parsed_title', 'domain', 'evaluation_rubric']
const LIST_PROTOCOL_FIELDS = ['constraints', 'keywords', 'hypothesis_attributes', 'search_queries', 'evaluation_criteria']
const NUMBER_PROTOCOL_FIELDS = ['max_hypotheses', 'step_budget', 'max_matches', 'dup_threshold', 'seed']

/**
 * Create a session, or amend an existing one under `resume`. On resume the goal
 * stays as written unless the caller supplies a new one, and the budgets move
 * only when explicitly given — a resumed tournament must not silently change
 * the rules it is being judged by.
 */
export async function startTournament({ cwd, slug, protocol = {}, resume = false }) {
  const dir = tournamentDir(cwd, slug)
  ensureDir(dir)
  const path = join(dir, FILES.protocol)
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  if (existing && !resume) {
    throw new Error(`tournament "${tournamentSlug(slug)}" already exists; pass resume: true to continue it`)
  }

  const goal = text(protocol.goal)
  if (!existing && !goal) throw new Error('protocol.goal is required')

  const stored = existing || {
    slug: tournamentSlug(slug),
    max_hypotheses: DEFAULT_MAX_HYPOTHESES,
    step_budget: DEFAULT_STEP_BUDGET,
    // null = auto by measure (cosine 0.92, lexical 0.70); 1 disables the gate.
    dup_threshold: null,
    hypothesis_attributes: ['Novel', 'Testable', 'Plausible', 'Impactful'],
    evaluation_rubric: 'Evaluate by novelty, correctness, and testability.',
    created_at: nowIso(),
  }

  if (goal) stored.goal = goal
  else if (!stored.goal) stored.goal = stored.parsed_title || tournamentSlug(slug)

  for (const field of GOAL_FIELDS) {
    if (text(protocol[field])) stored[field] = text(protocol[field])
  }
  if (text(protocol.background)) stored.background = prose(protocol.background)
  for (const field of LIST_PROTOCOL_FIELDS) {
    const values = list(protocol[field])
    if (values.length) stored[field] = values
  }
  for (const field of NUMBER_PROTOCOL_FIELDS) {
    const value = number(protocol[field])
    if (value !== undefined) stored[field] = value
  }

  if (!stored.parsed_title) stored.parsed_title = stored.goal.slice(0, 120)
  if (!stored.search_queries?.length) stored.search_queries = [stored.goal]

  writeJsonAtomic(path, stored)
  const state = deriveState(cwd, slug)
  refreshSnapshot(cwd, slug, state)
  return { protocol: stored, resumed: Boolean(existing), state }
}

// ─── Hypotheses ───────────────────────────────────────────────────────────────

function nextHypothesisId(hypotheses) {
  let max = 0
  for (const hyp of hypotheses) {
    const match = /^h(\d+)$/.exec(String(hyp.id || ''))
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `h${max + 1}`
}

/** Live comparables for the duplicate gate: this session, not rejected. */
function gateCandidates(state) {
  return state.hypotheses
    .filter((hyp) => hyp.status !== 'rejected')
    .map((hyp) => ({ id: hyp.id, text: hyp.text, vector: hyp.vector }))
}

/**
 * Save a hypothesis. Two upstream behaviours are kept as code rather than prose:
 * the cap is checked at save time (not just at dispatch), and the near-duplicate
 * gate discards a converging idea before it can cost review or debate budget.
 */
export async function addHypothesis({ cwd, slug, hypothesis = {}, strategy = 'generation:literature_exploration', round = null, parentIds = [] }) {
  const dir = ensureSession(cwd, slug)
  const title = text(hypothesis.title)
  const summary = text(hypothesis.summary)
  const content = prose(hypothesis.content)
  if (!title) throw new Error('hypothesis.title is required')
  if (!summary) throw new Error('hypothesis.summary is required')
  if (!content) throw new Error('hypothesis.content is required')

  const parents = list(parentIds)
  const candidateText = `${title}. ${summary}`
  const vector = Array.isArray(hypothesis.vector) ? hypothesis.vector : undefined

  return withLedgerLock(dir, async () => {
    const state = deriveState(cwd, slug)
    const protocol = state.protocol

    const cap = number(protocol.max_hypotheses)
    if (cap !== undefined && cap > 0 && state.counts.total >= cap) {
      return { discarded: { reason: 'hypothesis_cap', cap, existing: state.counts.total }, state }
    }

    const missing = parents.filter((id) => !state.byId.has(id))
    if (missing.length) throw new Error(`unknown parent hypothesis id(s): ${missing.join(', ')}`)
    // A withheld or rejected parent must not seed a child: its rating is not
    // something an idea should inherit, and evolving from it would launder an
    // idea the tournament already set aside.
    const unusable = parents
      .map((id) => state.byId.get(id))
      .filter((parent) => parent.status === 'rejected' || parent.status === 'quarantined')
    if (unusable.length) {
      throw new Error(`parent ${unusable.map((parent) => `${parent.id} (${parent.status})`).join(', ')} cannot seed a child; a rejected or withheld hypothesis is not lineage`)
    }

    // null means "decide by measure": 0.92 for cosine, 0.70 for lexical.
    const threshold = number(protocol.dup_threshold)
    if (threshold === undefined || threshold < 1) {
      const check = isNearDuplicate({ text: candidateText, vector }, gateCandidates(state), threshold)
      if (check.duplicate) {
        return {
          discarded: {
            reason: 'near_duplicate',
            score: Number(check.score.toFixed(3)),
            nearest_id: check.nearestId,
            measure: check.measure,
            threshold: Number(check.threshold.toFixed(3)),
          },
          state,
        }
      }
    }

    const seed = parents.length
      ? evolvedSeedRating(Math.max(...parents.map((id) => state.byId.get(id).rating)))
      : { ...GLICKO2_DEFAULTS }

    const id = nextHypothesisId(state.hypotheses)
    appendEvents(dir, [{
      id: `${id}:${Date.now()}:added`,
      ts: nowIso(),
      type: 'added',
      hypothesisId: id,
      title,
      summary,
      content,
      rationale: prose(hypothesis.rationale),
      experimental_plan: prose(hypothesis.experimental_plan),
      novelty_assessment: prose(hypothesis.novelty_assessment),
      key_assumptions: list(hypothesis.key_assumptions),
      citations: list(hypothesis.citations),
      strategy,
      round,
      parent_ids: parents,
      text: candidateText,
      vector,
      rating: seed.rating,
      rd: seed.rd,
      volatility: seed.volatility,
    }])

    const next = deriveState(cwd, slug)
    refreshSnapshot(cwd, slug, next)
    return { hypothesis: publicHypothesis(next.byId.get(id)), state: next }
  })
}

// ─── Reviews ──────────────────────────────────────────────────────────────────

const bestScore = (values) => {
  const defined = values.map(number).filter((value) => value !== undefined)
  return defined.length ? Math.max(...defined) : undefined
}

/**
 * Record one review stage. Stages are strictly ordered; a `fail` at a veto stage
 * rejects and closes the hypothesis; the final stage seeds the Glicko-2 rating
 * from the best score in each dimension (optimistic across stages, as upstream)
 * with the citation penalty folded in.
 */
export async function recordReview({ cwd, slug, id, stage, verdict, noveltyScore, correctnessScore, testabilityScore, safetyFlag, summary, critique, supportingEvidence }) {
  const dir = ensureSession(cwd, slug)
  if (!REVIEW_STAGES.includes(stage)) throw new Error(`stage must be one of ${REVIEW_STAGES.join(', ')}`)
  if (!VERDICTS.includes(verdict)) throw new Error(`verdict must be one of ${VERDICTS.join(', ')}`)
  const scores = {
    novelty_score: clampScore(noveltyScore, 'novelty_score'),
    correctness_score: clampScore(correctnessScore, 'correctness_score'),
    testability_score: clampScore(testabilityScore, 'testability_score'),
  }

  return withLedgerLock(dir, async () => {
    const state = deriveState(cwd, slug)
    const hyp = state.byId.get(id)
    if (!hyp) throw new Error(`unknown hypothesis id: ${id}`)
    if (hyp.status === 'rejected') throw new Error(`${id} was rejected and its reviews are closed`)
    if (hyp.status === 'quarantined') throw new Error(`${id} is quarantined; release it before reviewing`)

    const recorded = new Set(hyp.reviews.map((review) => review.stage))
    const index = REVIEW_STAGES.indexOf(stage)
    if (index > 0 && !recorded.has(REVIEW_STAGES[index - 1])) {
      throw new Error(`stage "${stage}" requires "${REVIEW_STAGES[index - 1]}" to be recorded first`)
    }
    if (recorded.has(stage)) throw new Error(`stage "${stage}" is already recorded for ${id}`)

    const event = {
      id: `${id}:${Date.now()}:reviewed:${stage}`,
      ts: nowIso(),
      type: 'reviewed',
      hypothesisId: id,
      stage,
      verdict,
      novelty_score: scores.novelty_score,
      correctness_score: scores.correctness_score,
      testability_score: scores.testability_score,
      safety_flag: Boolean(safetyFlag),
      summary: prose(summary),
      critique: prose(critique),
      supporting_evidence: list(supportingEvidence),
    }

    const outcome = { status: hyp.status, seed: null }
    if (verdict === 'fail' && VETO_STAGES.includes(stage)) {
      outcome.status = 'rejected'
      event.status = 'rejected'
    } else if (stage === REVIEW_STAGES[REVIEW_STAGES.length - 1]) {
      const reviews = [...hyp.reviews, event]
      const penalty = hyp.citationCheck
        ? { ratingDelta: hyp.citationCheck.ratingDelta, rdDelta: hyp.citationCheck.rdDelta }
        : { ratingDelta: 0, rdDelta: 0 }
      const seed = seededRatingWithPenalty(
        {
          novelty: bestScore(reviews.map((review) => review.novelty_score)),
          correctness: bestScore(reviews.map((review) => review.correctness_score)),
          testability: bestScore(reviews.map((review) => review.testability_score)),
        },
        penalty,
      )
      outcome.seed = { ...seed, floorApplied: seed.rating === RATING_FLOOR && penalty.ratingDelta < 0 }
      outcome.status = 'active'
      event.status = 'active'
      event.rating = seed.rating
      event.rd = seed.rd
      event.volatility = seed.volatility
      event.penalty_applied = { ratingDelta: penalty.ratingDelta, rdDelta: penalty.rdDelta }
    }

    appendEvents(dir, [event])
    const next = deriveState(cwd, slug)
    refreshSnapshot(cwd, slug, next)
    const updated = next.byId.get(id)
    return {
      hypothesis: publicHypothesis(updated),
      status: outcome.status,
      seeded: outcome.seed,
      stages_remaining: REVIEW_STAGES.filter((entry) => !updated.reviews.some((review) => review.stage === entry)),
      state: next,
    }
  })
}

// ─── Provenance and citation integrity ────────────────────────────────────────

/**
 * Record citation verification and/or claim support for a hypothesis. Either may
 * be supplied alone: counts and claims each fall back to what the ledger already
 * holds, so a later claims pass does not erase an earlier citation check. The
 * penalty is stored rather than applied here — it is folded into the seed when the
 * review sequence completes, or charged as a difference when the check arrives
 * after activation.
 */
export async function recordProvenance({ cwd, slug, id, total, verified, unverified, fabricated, claims, summary }) {
  const dir = ensureSession(cwd, slug)

  return withLedgerLock(dir, async () => {
    const state = deriveState(cwd, slug)
    const existing = state.byId.get(id)
    if (!existing) throw new Error(`unknown hypothesis id: ${id}`)
    const previous = existing.citationCheck || { total: 0, verified: 0, unverified: 0, fabricated: 0 }

    const counts = {
      total: number(total) ?? previous.total,
      verified: number(verified) ?? previous.verified,
      unverified: number(unverified) ?? previous.unverified,
      fabricated: number(fabricated) ?? previous.fabricated,
    }
    const reportedCounts = total !== undefined || verified !== undefined || unverified !== undefined || fabricated !== undefined
    const reportedClaims = Array.isArray(claims)
    if (counts.total < counts.verified + counts.unverified + counts.fabricated) {
      throw new Error('verified + unverified + fabricated cannot exceed total')
    }
    if (reportedClaims) {
      for (const claim of claims) {
        if (!claim || typeof claim !== 'object') throw new Error('each claim must be an object')
        if (!['supports', 'contradicts', 'unaddressed'].includes(claim.support)) {
          throw new Error(`claim support must be supports, contradicts, or unaddressed (got "${claim.support ?? ''}")`)
        }
      }
    }

    const penalty = citationPenalty(counts)
    const storedClaims = reportedClaims ? claims : existing.citationCheck?.claims || null
    appendEvents(dir, [{
      id: `${id}:${Date.now()}:provenance`,
      ts: nowIso(),
      type: 'provenance',
      hypothesisId: id,
      ...counts,
      reportedCounts,
      f: Number(penalty.f.toFixed(4)),
      ratingDelta: penalty.ratingDelta,
      rdDelta: penalty.rdDelta,
      summary: text(summary) || (reportedCounts
        ? `${counts.verified} verified · ${counts.unverified} unverified · ${counts.fabricated} fabricated`
        : existing.citationCheck?.summary || ''),
      claims: storedClaims,
    }])

    const next = deriveState(cwd, slug)
    refreshSnapshot(cwd, slug, next)
    const hyp = next.byId.get(id)
    // A check recorded after the hypothesis is already active still has to tell
    // on its rating. Applying only the difference against what was already
    // applied keeps re-verification idempotent — including a check whose counts
    // were folded into the seed before activation.
    let latePenalty = null
    if (hyp.status === 'active' && reportedCounts) {
      const applied = hyp.penaltyApplied || { ratingDelta: 0, rdDelta: 0 }
      const difference = {
        ratingDelta: penalty.ratingDelta - applied.ratingDelta,
        rdDelta: penalty.rdDelta - applied.rdDelta,
      }
      if (difference.ratingDelta || difference.rdDelta) {
        const rating = Math.max(RATING_FLOOR, hyp.rating + difference.ratingDelta)
        const rd = Math.min(350, hyp.rd + difference.rdDelta)
        appendEvents(dir, [{
          id: `${id}:${Date.now()}:penalty`,
          ts: nowIso(),
          type: 'penalty',
          hypothesisId: id,
          ratingDelta: penalty.ratingDelta,
          rdDelta: penalty.rdDelta,
          appliedRatingDelta: difference.ratingDelta,
          appliedRdDelta: difference.rdDelta,
          rating,
          rd,
          volatility: hyp.volatility,
        }])
        latePenalty = { rating, rd, appliedRatingDelta: difference.ratingDelta, appliedRdDelta: difference.rdDelta }
      }
    }
    const final = deriveState(cwd, slug)
    refreshSnapshot(cwd, slug, final)
    return { hypothesis: publicHypothesis(final.byId.get(id)), penalty, reported_counts: reportedCounts, late_penalty_applied: latePenalty }
  })
}

// ─── Safety gate ──────────────────────────────────────────────────────────────

/**
 * Record a dual-use classification and apply the gate. Quarantine withholds:
 * the hypothesis stays in the ledger, out of the tournament, and cannot be
 * activated without a named human release.
 */
export async function recordSafety({ cwd, slug, id, severity, category, reasoning, threshold }) {
  const dir = ensureSession(cwd, slug)
  const limit = String(threshold ?? 'high').trim().toLowerCase()
  if (!SAFETY_SEVERITIES.includes(limit)) {
    throw new Error(`threshold must be one of ${SAFETY_SEVERITIES.join(', ')} (got "${threshold ?? ''}")`)
  }

  return withLedgerLock(dir, async () => {
    const state = deriveState(cwd, slug)
    const hyp = state.byId.get(id)
    if (!hyp) throw new Error(`unknown hypothesis id: ${id}`)

    const assessment = decideSafety({ severity, priorSafetyFlag: hyp.reviews.some((review) => review.safety_flag) }, limit)
    const rows = [{
      id: `${id}:${Date.now()}:safety`,
      ts: nowIso(),
      type: 'safety',
      hypothesisId: id,
      severity: assessment.severity,
      category: text(category) || 'unspecified',
      reasoning: prose(reasoning),
      decision: assessment.decision,
      threshold: limit,
    }]
    if (assessment.decision === 'quarantined' && hyp.status !== 'rejected') {
      rows.push({
        id: `${id}:${Date.now()}:status`,
        ts: nowIso(),
        type: 'status',
        hypothesisId: id,
        status: 'quarantined',
        from: hyp.status,
        reason: `safety gate: ${assessment.severity} — ${rows[0].category}`,
      })
    }
    appendEvents(dir, rows)
    const next = deriveState(cwd, slug)
    refreshSnapshot(cwd, slug, next)
    return { assessment, hypothesis: publicHypothesis(next.byId.get(id)), state: next }
  })
}

// ─── Status transitions ───────────────────────────────────────────────────────

const LEGAL_TRANSITIONS = {
  pending_review: ['active', 'rejected', 'quarantined'],
  active: ['rejected', 'quarantined'],
  quarantined: ['active', 'rejected'],
  rejected: [],
}

/**
 * Explicit status change. Every transition needs a reason — a rejection or a
 * quarantine that cannot be argued from the ledger later is not recorded.
 */
export async function setStatus({ cwd, slug, id, status, reason, overriddenBy }) {
  const dir = ensureSession(cwd, slug)
  if (!HYPOTHESIS_STATUSES.includes(status)) throw new Error(`status must be one of ${HYPOTHESIS_STATUSES.join(', ')}`)
  const note = prose(reason)
  if (!note) throw new Error('reason is required for a status change')

  return withLedgerLock(dir, async () => {
    const state = deriveState(cwd, slug)
    const hyp = state.byId.get(id)
    if (!hyp) throw new Error(`unknown hypothesis id: ${id}`)
    if (hyp.status === status) return { hypothesis: publicHypothesis(hyp), unchanged: true, state }

    const allowed = LEGAL_TRANSITIONS[hyp.status] || []
    if (!allowed.includes(status)) {
      const hint = status === 'active' && hyp.status === 'rejected'
        ? ' — a rejected hypothesis does not re-enter the tournament; add it again as a new hypothesis'
        : ''
      throw new Error(`cannot move ${id} from ${hyp.status} to ${status}${hint}`)
    }
    if (status === 'active' && hyp.status === 'quarantined' && !text(overriddenBy)) {
      throw new Error('releasing a quarantined hypothesis requires overridden_by (who released it) and a reason')
    }

    const rows = [{
      id: `${id}:${Date.now()}:status`,
      ts: nowIso(),
      type: 'status',
      hypothesisId: id,
      status,
      from: hyp.status,
      reason: note,
    }]
    if (status === 'active' && hyp.safety) {
      rows.push({
        id: `${id}:${Date.now()}:safety-release`,
        ts: nowIso(),
        type: 'safety',
        hypothesisId: id,
        severity: hyp.safety.severity,
        category: hyp.safety.category,
        reasoning: hyp.safety.reasoning,
        decision: 'allowed',
        threshold: hyp.safety.threshold,
        overridden_by: text(overriddenBy),
        release_reason: note,
      })
    }
    appendEvents(dir, rows)
    const next = deriveState(cwd, slug)
    refreshSnapshot(cwd, slug, next)
    return { hypothesis: publicHypothesis(next.byId.get(id)), unchanged: false, state: next }
  })
}

// ─── Scheduling policy ────────────────────────────────────────────────────────

/**
 * Budget inputs for the ported policy. Upstream counted tokens from its own LLM
 * client; a tool here cannot see subagent spend, so dispatch rounds are counted
 * against `step_budget` instead. That is an honest substitution, not a token
 * figure — the plan (docs/CO-SCIENTIST-INTEGRATION-PLAN.md §9) records it as a
 * deliberate deviation.
 */
function policyStats(state) {
  const budget = number(state.protocol.step_budget) ?? DEFAULT_STEP_BUDGET
  const cap = number(state.protocol.max_hypotheses) ?? DEFAULT_MAX_HYPOTHESES
  const matchCap = number(state.protocol.max_matches)
  return {
    totalHypotheses: state.counts.total,
    activeHypotheses: state.counts.active,
    pendingReview: state.counts.pendingReview,
    totalMatches: state.counts.totalMatches,
    currentRound: state.rounds,
    tokensUsed: state.rounds,
    budgetTokens: budget,
    maxHypotheses: cap,
    maxMatches: matchCap,
  }
}

/**
 * Task types the current state can actually execute. The upstream weights are
 * phase heuristics, not feasibility checks: at the cap with no review backlog
 * they still put mass on `reflection` (nothing to review) and `evolution`
 * (an `add` would be discarded by the cap). Sampling those burns a dispatch on
 * a no-op and makes the caller override the policy, so they are zeroed here.
 */
function feasibleTaskTypes(state) {
  const cap = number(state.protocol.max_hypotheses) ?? DEFAULT_MAX_HYPOTHESES
  const total = state.counts.total
  const active = state.counts.active
  const live = state.hypotheses.filter((hyp) => hyp.status !== 'rejected').length
  const types = new Set()
  if (total < cap) {
    types.add('generation')
    if (active >= 1) types.add('evolution')
  }
  if (state.counts.pendingReview > 0) types.add('reflection')
  if (active >= 2) {
    types.add('ranking')
    types.add('proximity')
  } else if (live >= 2) {
    types.add('proximity')
  }
  if (total > 0) types.add('meta_review')
  return types
}

/** Live weights for the strategy view, without consuming a dispatch. */
export function peekWeights(cwd, slug) {
  const state = deriveState(cwd, slug)
  return computeWeights({ ...policyStats(state), currentRound: state.rounds + 1 })
}

/**
 * Ask the policy what to do next, and record that it was asked. Returns the
 * weights in force, the sampled task, and whether the tournament should stop;
 * the sampled round and observed top-10 average Elo go into the log so a
 * resumed session sees the same history.
 */
export async function nextTask({ cwd, slug, rand } = {}) {
  const dir = ensureSession(cwd, slug)
  return withLedgerLock(dir, async () => {
    const state = deriveState(cwd, slug)
    const stats = { ...policyStats(state), currentRound: state.rounds + 1 }
    const weights = computeWeights(stats)
    const feasible = feasibleTaskTypes(state)
    // The phase table may still put mass on a task the state cannot run. Zero
    // those entries, then sample; a zero-total table falls back to a feasible
    // task instead of the upstream 'generation' default.
    const effective = Object.fromEntries(
      Object.keys(weights).map((key) => [key, feasible.has(key) ? weights[key] : 0]),
    )
    const sampled = sampleNextTaskType(effective, dispatchRand({ rand, state, protocol: state.protocol }))
    const fallback = ['ranking', 'generation', 'proximity', 'meta_review', 'reflection', 'evolution']
      .find((type) => feasible.has(type))
    const task = feasible.has(sampled) ? sampled : fallback
    const termination = terminationCheck(policyStats(state), state.eloHistory)

    appendEvents(dir, [{
      id: `dispatch:${state.rounds + 1}:${Date.now()}`,
      ts: nowIso(),
      type: 'dispatch',
      round: state.rounds + 1,
      task,
      weights: effective,
      feasible: [...feasible],
      avg_top_elo: Number(state.avgTopTenElo.toFixed(1)),
      terminate: termination.terminate,
      reason: termination.reason,
    }])

    const next = deriveState(cwd, slug)
    refreshSnapshot(cwd, slug, next)
    const budget = number(next.protocol.step_budget) ?? DEFAULT_STEP_BUDGET
    return {
      task,
      weights: effective,
      round: next.rounds,
      steps_used: next.rounds,
      step_budget: budget,
      matches_used: next.counts.totalMatches,
      max_matches: number(next.protocol.max_matches),
      budget_warning: next.rounds >= budget * 0.8,
      terminate: termination.terminate,
      reason: termination.reason,
      stats: policyStats(next),
      state: next,
    }
  })
}

/**
 * A seeded session draws reproducibly, re-mixed per round so consecutive rounds
 * are not all the same sample. An explicit `rand` always wins.
 */
function dispatchRand({ rand, state, protocol }) {
  if (typeof rand === 'function') return rand
  const seed = number(protocol.seed)
  return Number.isFinite(seed) ? seededRand(seed, state.rounds + 1) : Math.random
}

const GOLDEN = 0x9e3779b9

function seededRand(seed, salt) {
  let a = (Number(seed) + Number(salt) * GOLDEN) >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─── Similarity and matchups ──────────────────────────────────────────────────

/**
 * Similarity neighbourhood over the live hypotheses of this session. Edges are
 * recomputed from the texts rather than stored: the population is a handful of
 * hypotheses, and a derived edge cannot go stale against a rejected or edited
 * member.
 */
export function similarityNeighbours(cwd, slug, { id = null, edge, duplicate } = {}) {
  const state = deriveState(cwd, slug)
  const items = state.hypotheses
    .filter((hyp) => hyp.status !== 'rejected')
    .map((hyp) => ({ id: hyp.id, text: hyp.text, vector: hyp.vector }))
  const { edges, duplicates } = similarityPairs(items, { edge, duplicate })
  if (!id) return { edges, duplicates }
  const neighbours = []
  for (const entry of edges) {
    if (entry.a !== id && entry.b !== id) continue
    neighbours.push({ id: entry.a === id ? entry.b : entry.a, score: Number(entry.score.toFixed(3)) })
  }
  neighbours.sort((a, b) => b.score - a.score)
  return {
    neighbours,
    duplicates: duplicates.filter((entry) => entry.a === id || entry.b === id),
  }
}

/**
 * Choose the next pair to debate: the most uncertain active hypothesis (high RD
 * per match played) first, ideally against a similar one, because a match
 * between nearby ideas converges an uncertain rating fastest.
 */
export function proposeMatch(cwd, slug, { rand } = {}) {
  const state = deriveState(cwd, slug)
  const active = state.hypotheses.filter((hyp) => hyp.status === 'active')
  if (active.length < 2) {
    return { error: `at least 2 active hypotheses are required (have ${active.length}); finish review first` }
  }
  const { edges } = similarityNeighbours(cwd, slug)
  const neighboursOf = (id) => edges
    .filter((edge) => edge.a === id || edge.b === id)
    .map((edge) => (edge.a === id ? edge.b : edge.a))
  const activeIds = new Set(active.map((hyp) => hyp.id))
  const playedPairs = state.matches
    .filter((match) => activeIds.has(match.hypothesisAId) && activeIds.has(match.hypothesisBId))
    .map((match) => matchupKey(match.hypothesisAId, match.hypothesisBId))
  const pick = selectMatchup(
    active.map((hyp) => ({ id: hyp.id, rating: hyp.rating, rd: hyp.rd, matchesPlayed: hyp.matchesPlayed })),
    neighboursOf,
    dispatchRand({ rand, state, protocol: state.protocol }),
    { playedPairs },
  )
  if (!pick) return { error: 'no legal matchup' }

  const pairKey = matchupKey(pick.primary.id, pick.opponent.id)
  const pairMatchesPlayed = state.matches
    .filter((match) => matchupKey(match.hypothesisAId, match.hypothesisBId) === pairKey)
    .length
  const activePairs = (active.length * (active.length - 1)) / 2

  return {
    a: publicHypothesis(state.byId.get(pick.primary.id)),
    b: publicHypothesis(state.byId.get(pick.opponent.id)),
    basis: pick.basis,
    // A fresh pair is preferred until every active pair has met, so a small
    // pool reaches a complete first ranking instead of replaying one matchup.
    pair_matches_played: pairMatchesPlayed,
    unplayed_pairs_remaining: Math.max(0, activePairs - new Set(playedPairs).size),
    // Both orientations must be judged: one ordering alone is position-biased.
    judge_as: [
      { presentation: 'A,B', first: pick.primary.id, second: pick.opponent.id },
      { presentation: 'B,A', first: pick.opponent.id, second: pick.primary.id },
    ],
  }
}

/**
 * Record a judged pair. Both orientations are mapped back to real terms and
 * reconciled, then one Glicko-2 period updates both ratings from the same
 * pre-match snapshot — the zero-sum invariant depends on that single read.
 */
export async function recordMatch({ cwd, slug, a, b, verdictAb, verdictBa, rationale, transcript = '', matchType = 'simple', round = null }) {
  const dir = ensureSession(cwd, slug)
  if (!MATCH_TYPES.includes(matchType)) throw new Error(`match_type must be one of ${MATCH_TYPES.join(', ')}`)

  const orientationAb = String(verdictAb || '').trim()
  const orientationBa = String(verdictBa || '').trim()
  for (const orientation of [orientationAb, orientationBa].filter(Boolean)) {
    if (!['A', 'B', 'draw'].includes(orientation)) throw new Error('verdict_ab and verdict_ba must each be A, B, or draw')
  }
  if (!orientationAb) throw new Error('verdict_ab is required (the A,B orientation)')

  return withLedgerLock(dir, async () => {
    const state = deriveState(cwd, slug)
    const hypA = state.byId.get(a)
    const hypB = state.byId.get(b)
    if (!hypA || !hypB) {
      const unknown = [a, b].filter((entry) => !state.byId.get(entry))
      throw new Error(`unknown hypothesis id(s): ${unknown.join(', ')}`)
    }
    if (hypA.id === hypB.id) throw new Error('a hypothesis cannot be matched against itself')
    for (const hyp of [hypA, hypB]) {
      if (hyp.status !== 'active') throw new Error(`${hyp.id} is ${hyp.status}; only active hypotheses compete`)
    }

    const swappedReal = orientationBa ? mapPresentedVerdict(orientationBa, true) : null
    const verdict = swappedReal ? combineSwappedVerdicts(orientationAb, swappedReal) : orientationAb
    const result = verdictToMatchResult(verdict)
    // Each orientation favoured a different real hypothesis: the verdict was
    // driven by presentation order, so it reconciles to a draw.
    const contradictory = Boolean(swappedReal)
      && ((orientationAb === 'A' && swappedReal === 'B') || (orientationAb === 'B' && swappedReal === 'A'))

    // The tally fields stay zero because match counts are derived from
    // matches.jsonl, not written back; only rating and RD come from this update.
    const { newA, newB } = computeGlicko2Update(
      { rating: hypA.rating, rd: hypA.rd, volatility: hypA.volatility, matchesPlayed: 0, wins: 0, losses: 0, draws: 0 },
      { rating: hypB.rating, rd: hypB.rd, volatility: hypB.volatility, matchesPlayed: 0, wins: 0, losses: 0, draws: 0 },
      result,
    )

    appendMatches(dir, [{
      id: `${a}|${b}:${Date.now()}`,
      ts: nowIso(),
      hypothesisAId: a,
      hypothesisBId: b,
      matchType,
      result,
      verdict,
      verdict_ab: orientationAb,
      verdict_ba: orientationBa || null,
      position_controlled: Boolean(orientationBa),
      contradictory_orientations: contradictory,
      rationale: prose(rationale),
      transcript_ref: text(transcript),
      round,
      ratingBeforeA: hypA.rating,
      ratingAfterA: newA.rating,
      rdBeforeA: hypA.rd,
      rdAfterA: newA.rd,
      ratingBeforeB: hypB.rating,
      ratingAfterB: newB.rating,
      rdBeforeB: hypB.rd,
      rdAfterB: newB.rd,
    }])

    const next = deriveState(cwd, slug)
    refreshSnapshot(cwd, slug, next)
    return {
      verdict,
      result,
      position_controlled: Boolean(orientationBa),
      contradictory_orientations: contradictory,
      rating_a: { before: hypA.rating, after: newA.rating, rd: newA.rd },
      rating_b: { before: hypB.rating, after: newB.rating, rd: newB.rd },
      state: next,
    }
  })
}

/** Match history for one hypothesis, or for the whole session. */
export function matchHistory(cwd, slug, id = null) {
  const state = deriveState(cwd, slug)
  const rows = id
    ? state.matches.filter((match) => match.hypothesisAId === id || match.hypothesisBId === id)
    : state.matches
  return rows.map((match) => ({
    id: match.id,
    ts: match.ts,
    a: match.hypothesisAId,
    b: match.hypothesisBId,
    result: match.result,
    verdict: match.verdict,
    match_type: match.matchType,
    position_controlled: match.position_controlled,
    rating_a: { before: match.ratingBeforeA, after: match.ratingAfterA },
    rating_b: { before: match.ratingBeforeB, after: match.ratingAfterB },
    rationale: match.rationale,
    transcript_ref: match.transcript_ref,
    round: match.round,
  }))
}

// ─── Experimental feedback ────────────────────────────────────────────────────

/** An empirical result moves a rating through a match against the baseline. */
export async function recordFeedback({ cwd, slug, id, feedbackText, novelty, correctness, testability, recordedBy }) {
  const dir = ensureSession(cwd, slug)
  const body = prose(feedbackText)
  if (!body) throw new Error('feedback_text is required')

  return withLedgerLock(dir, async () => {
    const state = deriveState(cwd, slug)
    const hyp = state.byId.get(id)
    if (!hyp) throw new Error(`unknown hypothesis id: ${id}`)
    if (hyp.status === 'rejected') throw new Error(`${id} is rejected; feedback does not revive it`)

    const scores = [number(novelty), number(correctness), number(testability)]
    const reward = extractRewardFromFeedback(body, scores[0], scores[1], scores[2])
    const updated = applyFeedbackAsGlicko2Match(
      { rating: hyp.rating, rd: hyp.rd, volatility: hyp.volatility, matchesPlayed: 0, wins: 0, losses: 0, draws: 0 },
      reward,
    )

    appendEvents(dir, [{
      id: `${id}:${Date.now()}:feedback`,
      ts: nowIso(),
      type: 'feedback',
      hypothesisId: id,
      feedback_text: body,
      sentiment: Number(feedbackSentiment(body).toFixed(3)),
      reward: Number(reward.toFixed(3)),
      novelty: scores[0],
      correctness: scores[1],
      testability: scores[2],
      recorded_by: text(recordedBy) || 'user',
      rating_before: hyp.rating,
      rating_after: updated.rating,
      rd_after: updated.rd,
      rating: updated.rating,
      rd: updated.rd,
      volatility: updated.volatility,
    }])

    const next = deriveState(cwd, slug)
    refreshSnapshot(cwd, slug, next)
    return {
      reward: Number(reward.toFixed(3)),
      rating_before: hyp.rating,
      rating_after: updated.rating,
      rd_after: updated.rd,
      hypothesis: publicHypothesis(next.byId.get(id)),
      state: next,
    }
  })
}

// ─── Protocol design and synthesis ────────────────────────────────────────────

export async function saveExperimentProtocol({ cwd, slug, id, steps }) {
  const dir = ensureSession(cwd, slug)
  const parsed = Array.isArray(steps) ? steps.map(prose).filter(Boolean) : []
  if (!parsed.length) throw new Error('steps must be a non-empty array')

  return withLedgerLock(dir, async () => {
    const state = deriveState(cwd, slug)
    if (!state.byId.get(id)) throw new Error(`unknown hypothesis id: ${id}`)
    appendEvents(dir, [{ id: `${id}:${Date.now()}:protocol`, ts: nowIso(), type: 'protocol', hypothesisId: id, steps: parsed }])
    const next = deriveState(cwd, slug)
    refreshSnapshot(cwd, slug, next)
    return { hypothesis: publicHypothesis(next.byId.get(id)), steps: parsed.length }
  })
}

/** Meta-review critique and final research overview (latest wins). */
export async function saveSynthesis({ cwd, slug, critique, overview }) {
  const dir = ensureSession(cwd, slug)
  const row = { id: `synthesis:${Date.now()}`, ts: nowIso(), type: 'synthesis', critique: prose(critique), overview: prose(overview) }
  if (!row.critique && !row.overview) throw new Error('provide critique or overview')

  return withLedgerLock(dir, async () => {
    appendEvents(dir, [row])
    const next = deriveState(cwd, slug)
    refreshSnapshot(cwd, slug, next)
    return { critique: next.critique, overview: next.overview }
  })
}

/**
 * Attach embeddings to hypotheses so the duplicate gate and the proximity graph
 * can use cosine instead of lexical overlap. All-or-nothing on dimensions: a
 * pool holding two different vector spaces would silently compare numbers that
 * mean different things, and no later reading of the ledger could tell.
 */
export async function attachVectors({ cwd, slug, vectors, model }) {
  const dir = ensureSession(cwd, slug)
  if (!vectors || typeof vectors !== 'object') throw new Error('vectors must be an object of hypothesis id → number[]')
  const entries = Object.entries(vectors)
  if (!entries.length) throw new Error('no vectors supplied')

  return withLedgerLock(dir, async () => {
    const state = deriveState(cwd, slug)
    const unknown = entries.filter(([id]) => !state.byId.get(id)).map(([id]) => id)
    if (unknown.length) throw new Error(`unknown hypothesis id(s): ${unknown.join(', ')}`)

    const widths = new Set()
    for (const [, vector] of entries) {
      if (!Array.isArray(vector) || !vector.length || vector.some((value) => !Number.isFinite(Number(value)))) {
        throw new Error('every vector must be a non-empty array of finite numbers')
      }
      widths.add(vector.length)
    }
    for (const hyp of state.hypotheses) {
      if (Array.isArray(hyp.vector)) widths.add(hyp.vector.length)
    }
    if (widths.size > 1) throw new Error(`mixed embedding dimensions: ${[...widths].join(' vs ')} — one model per tournament`)

    const rows = entries.map(([id, vector], index) => ({
      id: `${id}:${Date.now()}:embedded:${index}`,
      ts: nowIso(),
      type: 'embedded',
      hypothesisId: id,
      vector: vector.map(Number),
      model: text(model) || null,
    }))
    appendEvents(dir, rows)
    const next = deriveState(cwd, slug)
    refreshSnapshot(cwd, slug, next)
    const embedded = next.hypotheses.filter((hyp) => Array.isArray(hyp.vector)).length
    return { embedded, total: next.counts.total, dimensions: rows[0].vector.length }
  })
}

// ─── Knowledge graph ──────────────────────────────────────────────────────────

/** Mermaid label text: brackets and quotes would break the diagram, not just read badly. */
function mermaidLabel(value, max = 90) {
  return String(value ?? '')
    .replace(/["[\]{}<>|`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

const STATUS_CLASS = {
  active: 'active',
  pending_review: 'pending',
  rejected: 'rejected',
  quarantined: 'withheld',
}

/**
 * A concept-and-lineage graph built only from what the ledger already holds:
 * parentage, similarity edges, and the papers that recorded claim judgements
 * point at. No model call and no concept extraction — upstream mined concepts
 * with the LLM, and inventing that here would put unverified edges in a figure.
 */
export function knowledgeGraph(cwd, slug) {
  const state = deriveState(cwd, slug)
  const nodes = []
  const edges = []

  for (const hyp of state.ranked.concat(state.hypotheses.filter((entry) => entry.status === 'rejected'))) {
    nodes.push({
      id: hyp.id,
      kind: 'hypothesis',
      label: `${hyp.id} — ${hyp.title}`,
      detail: `${hyp.rating} ± ${hyp.rd} · ${hyp.matchesPlayed} matches`,
      status: hyp.status,
      rating: hyp.rating,
      rd: hyp.rd,
      strategy: hyp.strategy,
    })
    for (const parentId of hyp.parentIds) {
      edges.push({ from: parentId, to: hyp.id, kind: 'evolved', label: 'evolved from' })
    }
    const claims = hyp.citationCheck?.claims || []
    for (const claim of claims) {
      if (claim.support === 'unaddressed' || !claim.paper_title) continue
      const paperId = `p${nodes.length + edges.length}`
      const known = nodes.find((node) => node.kind === 'paper' && (node.doi === claim.paper_doi || node.title === claim.paper_title))
      if (!known) {
        nodes.push({ id: paperId, kind: 'paper', label: claim.paper_title, title: claim.paper_title, doi: claim.paper_doi || null })
      }
      edges.push({
        from: hyp.id,
        to: known ? known.id : paperId,
        kind: claim.support,
        label: claim.support,
        confidence: claim.confidence,
      })
    }
  }

  const { edges: related } = similarityNeighbours(cwd, slug)
  const seen = new Set(edges.map((edge) => [edge.from, edge.to].sort().join('|')))
  for (const edge of related) {
    const key = [edge.a, edge.b].sort().join('|')
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ from: edge.a, to: edge.b, kind: 'related', label: `related ${edge.score}`, measure: edge.measure })
  }

  return {
    slug: state.protocol.slug,
    goal: state.protocol.goal,
    nodes,
    edges,
    measures: [...new Set(related.map((edge) => edge.measure))],
    mermaid: mermaidDiagram(state, nodes, edges),
  }
}

function mermaidDiagram(state, nodes, edges) {
  const lines = []
  lines.push('%% Hypothesis tournament graph — generated from the ledger, not authored.')
  lines.push(`%% Goal: ${mermaidLabel(state.protocol.goal, 120)}`)
  lines.push(`%% ${state.counts.total} hypotheses · ${state.counts.totalMatches} matches · lineage + similarity + claim support`)
  lines.push('---')
  lines.push(`title: Hypothesis tournament — ${mermaidLabel(state.protocol.parsed_title || state.protocol.slug, 70)}`)
  lines.push('---')
  lines.push('flowchart TD')
  for (const node of nodes) {
    const text = node.kind === 'hypothesis' ? `${mermaidLabel(node.label)}<br/>${mermaidLabel(node.detail)}` : mermaidLabel(node.label)
    lines.push(`  ${node.id}["${text}"]`)
  }
  for (const edge of edges) {
    const arrow = edge.kind === 'evolved' ? '-->' : (edge.kind === 'related' ? '-.->' : '-->')
    lines.push(`  ${edge.from} ${arrow}|"${mermaidLabel(edge.label)}"| ${edge.to}`)
  }
  lines.push('  classDef active fill:#1f6f43,stroke:#0b3, color:#fff')
  lines.push('  classDef pending fill:#8a6d1f,stroke:#fc0, color:#fff')
  lines.push('  classDef rejected fill:#4a4a4a,stroke:#888, color:#fff,stroke-dasharray:3 3')
  lines.push('  classDef withheld fill:#7d2020,stroke:#f66, color:#fff')
  lines.push('  classDef paper fill:#274b6d,stroke:#69c, color:#fff')
  const byClass = new Map()
  for (const node of nodes) {
    const cls = node.kind === 'paper' ? 'paper' : STATUS_CLASS[node.status] || 'pending'
    if (!byClass.has(cls)) byClass.set(cls, [])
    byClass.get(cls).push(node.id)
  }
  for (const [cls, ids] of byClass) lines.push(`  class ${ids.join(',')} ${cls}`)
  return `${lines.join('\n')}\n`
}

// ─── Cross-session priors ─────────────────────────────────────────────────────

/**
 * What this workspace already learned about ideas like this one.
 *
 * Upstream kept priors in a `reward_memory` table; here they are recovered from
 * the sibling tournaments' own logs, which are the primary record anyway — so
 * nothing is duplicated and nothing can disagree with the ledger. A corrupt or
 * unreadable sibling is skipped rather than failing the call: an old experiment
 * must never block a new one.
 */
export function priorFeedback({ cwd, slug, query, limit = 5, minScore = 0.15 }) {
  const root = join(resolve(cwd), '.dsh', 'coscientist')
  const wanted = String(query ?? '').trim()
  if (!wanted) return { priors: [], scanned: 0, error: 'query is required' }
  if (!existsSync(root)) return { priors: [], scanned: 0 }

  const exclude = tournamentSlug(slug)
  const found = []
  let scanned = 0

  for (const name of readdirSync(root)) {
    if (name === exclude) continue
    const eventsFile = join(root, name, FILES.events)
    const protocolFile = join(root, name, FILES.protocol)
    if (!existsSync(eventsFile)) continue
    scanned += 1
    let events
    try {
      events = readJsonl(eventsFile, `${name}/${FILES.events}`)
    } catch {
      continue
    }
    let goal = name
    try {
      goal = JSON.parse(readFileSync(protocolFile, 'utf8')).goal || name
    } catch {
      // a sibling with no readable protocol still carries usable feedback
    }
    const titles = new Map(events.filter((event) => event.type === 'added').map((event) => [event.hypothesisId, event.title]))

    for (const event of events) {
      const title = titles.get(event.hypothesisId) || ''
      let prior = null
      if (event.type === 'feedback') {
        prior = { kind: 'feedback', text: event.feedback_text, reward: event.reward, hypothesis_id: event.hypothesisId }
      } else if (event.type === 'status' && (event.status === 'rejected' || event.status === 'quarantined')) {
        // A human withholding is as much a prior as a screen withholding: both
        // say this neighbourhood already cost a tournament something.
        prior = { kind: event.status === 'rejected' ? 'rejection' : 'withheld', text: event.reason, hypothesis_id: event.hypothesisId }
      } else if (event.type === 'safety' && event.decision === 'quarantined') {
        prior = { kind: 'withheld', text: `${event.category}: ${event.reasoning}`, hypothesis_id: event.hypothesisId }
      }
      if (!prior) continue
      // Order-free overlap: a short query should not be penalised for not
      // repeating every word of a long feedback paragraph.
      const score = tokenOverlap(wanted, `${title}. ${prior.text}`)
      if (score < minScore) continue
      found.push({
        session: name,
        session_goal: goal,
        score: Number(score.toFixed(3)),
        title,
        ...prior,
        ts: event.ts,
      })
    }
  }

  found.sort((a, b) => b.score - a.score || String(a.ts).localeCompare(String(b.ts)))
  const capped = Number.isFinite(limit) && limit > 0 ? found.slice(0, limit) : found
  return { priors: capped, scanned, matching: found.length }
}

// ─── Views ────────────────────────────────────────────────────────────────────

export function leaderboard(cwd, slug) {
  const state = deriveState(cwd, slug)
  const stats = policyStats(state)
  return {
    slug: state.protocol.slug,
    goal: state.protocol.goal,
    protocol: state.protocol,
    counts: state.counts,
    rounds: state.rounds,
    steps_used: state.rounds,
    step_budget: stats.budgetTokens,
    max_hypotheses: stats.maxHypotheses,
    max_matches: stats.maxMatches,
    avg_top_elo: Number(state.avgTopTenElo.toFixed(1)),
    top_elo: state.topEloRating,
    weights: computeWeights({ ...stats, currentRound: state.rounds + 1 }),
    termination: terminationCheck(stats, state.eloHistory),
    critique: state.critique,
    overview: state.overview,
    ranked: state.ranked.map((hyp, index) => ({
      rank: index + 1,
      id: hyp.id,
      title: hyp.title,
      status: hyp.status,
      rating: hyp.rating,
      rd: hyp.rd,
      matches_played: hyp.matchesPlayed,
      record: `${hyp.wins}-${hyp.losses}-${hyp.draws}`,
      strategy: hyp.strategy,
      reviews: hyp.reviews.map((review) => review.stage),
      citations: hyp.citations.length,
      embedded: Array.isArray(hyp.vector),
      citation_check: hyp.citationCheck ? hyp.citationCheck.summary : null,
      quarantined: hyp.status === 'quarantined',
      has_protocol: Boolean(hyp.protocolPlan),
    })),
  }
}

/** Parent/child tree plus a field-level diff against each parent. */
export function lineage(cwd, slug, id) {
  const state = deriveState(cwd, slug)
  const hyp = state.byId.get(id)
  if (!hyp) throw new Error(`unknown hypothesis id: ${id}`)

  const fields = ['title', 'summary', 'content', 'rationale', 'experimental_plan', 'key_assumptions', 'citations']
  return {
    id: hyp.id,
    title: hyp.title,
    rating: hyp.rating,
    rd: hyp.rd,
    status: hyp.status,
    strategy: hyp.strategy,
    parent_ids: hyp.parentIds,
    children: state.hypotheses.filter((entry) => entry.parentIds.includes(id)).map((entry) => entry.id),
    diffs: hyp.parentIds.map((parentId) => {
      const parent = state.byId.get(parentId)
      if (!parent) return { parent_id: parentId, missing: true }
      return {
        parent_id: parentId,
        parent_title: parent.title,
        changed_fields: fields.filter((field) => JSON.stringify(hyp[field]) !== JSON.stringify(parent[field])),
        rating_delta: hyp.rating - parent.rating,
      }
    }),
  }
}

/**
 * Ranked report of the tournament. Markdown is the deliverable a scientist
 * reads; JSON is the whole ledger. Both are written under `exports/` and never
 * overwrite an existing non-empty file unless `overwrite` is set.
 */
export function exportTournament({ cwd, slug, format = 'markdown', overwrite = false }) {
  const dir = ensureSession(cwd, slug)
  mkdirSync(join(dir, 'exports'), { recursive: true })
  const state = deriveState(cwd, slug)
  const kind = text(format).toLowerCase()

  let name
  let body
  if (kind === 'markdown' || kind === 'md') {
    name = 'tournament.md'
    body = markdownReport(state)
  } else if (kind === 'mermaid') {
    name = 'tournament.mmd'
    body = knowledgeGraph(cwd, slug).mermaid
  } else if (kind === 'json') {
    name = 'tournament.json'
    body = `${JSON.stringify({
      protocol: state.protocol,
      counts: state.counts,
      rounds: state.rounds,
      avgTopTenElo: state.avgTopTenElo,
      termination: terminationCheck(policyStats(state), state.eloHistory),
      hypotheses: state.ranked.map(publicHypothesis),
      matches: state.matches,
      critique: state.critique,
      overview: state.overview,
      events: readJsonl(join(dir, FILES.events), FILES.events),
    }, null, 2)}\n`
  } else {
    throw new Error('format must be markdown, json, or mermaid')
  }

  const out = join(dir, 'exports', name)
  if (existsSync(out) && !overwrite) {
    throw new Error(`${relative(resolve(cwd), out)} already exists; pass overwrite: true to replace it`)
  }
  writeFileSync(out, body)
  return { format: kind, path: relative(resolve(cwd), out), bytes: Buffer.byteLength(body), state }
}

const pipe = (value) => text(value).replace(/\|/g, '\\|')

function markdownReport(state) {
  const stats = policyStats(state)
  const termination = terminationCheck(stats, state.eloHistory)
  const lines = []
  const push = (...values) => lines.push(...values)

  push(`# Hypothesis tournament: ${state.protocol.parsed_title || state.protocol.slug}`, '')
  push(`**Goal.** ${state.protocol.goal}`, '')
  if (state.protocol.background) push(`**Background.** ${state.protocol.background}`, '')
  if (state.protocol.constraints?.length) push(`**Constraints.** ${state.protocol.constraints.join(' · ')}`, '')
  push(`Ledger \`${state.protocol.slug}\` — ${state.counts.total} hypotheses (${state.counts.active} active, `
    + `${state.counts.pendingReview} in review, ${state.counts.rejected} rejected, ${state.counts.quarantined} withheld), `
    + `${state.counts.totalMatches} judged matches, round ${state.rounds} of ${stats.budgetTokens} steps.`, '')
  push(`Termination: ${termination.terminate ? `stopped — ${termination.reason}` : 'not yet; rankings are still moving'}.`, '')
  push('> These hypotheses recombine published knowledge. Treat them as hypotheses, not as results.', '')

  push('## Leaderboard', '')
  push('| # | Rating | RD | W-L-D | Matches | Status | Hypothesis |')
  push('|---|---|---|---|---|---|---|')
  for (const [index, hyp] of state.ranked.entries()) {
    push(`| ${index + 1} | ${hyp.rating} | ${hyp.rd} | ${hyp.wins}-${hyp.losses}-${hyp.draws} | ${hyp.matchesPlayed} | ${hyp.status} | ${pipe(hyp.title)} |`)
  }
  push('')
  push(`Rating is tournament performance, not scientific merit — and ${state.counts.totalMatches} matches over `
    + `${state.counts.active} active hypotheses is `
    + `${state.counts.active ? (state.counts.totalMatches / state.counts.active).toFixed(1) : 0} per hypothesis, so read the `
    + 'ordering as preliminary. RD is the uncertainty in each rating (350 = never competed or reviewed, 200 = reviewed, '
    + 'lower as matches accumulate); a high rating with a high RD has not earned its position yet.', '')

  for (const [index, hyp] of state.ranked.entries()) {
    push(`## ${index + 1}. ${hyp.title} (\`${hyp.id}\`)`, '')
    push(`Rating ${hyp.rating} (RD ${hyp.rd}) · record ${hyp.wins}-${hyp.losses}-${hyp.draws} over ${hyp.matchesPlayed} matches · status \`${hyp.status}\` · from \`${hyp.strategy}\``, '')
    if (hyp.parentIds.length) push(`Evolved from ${hyp.parentIds.map((id) => `\`${id}\``).join(', ')}.`, '')
    if (hyp.summary) push(`**Summary.** ${hyp.summary}`, '')
    if (hyp.content) push(`**Claim.** ${hyp.content}`, '')
    if (hyp.rationale) push(`**Mechanism / rationale.** ${hyp.rationale}`, '')
    if (hyp.experimental_plan) push(`**Discriminating experiment.** ${hyp.experimental_plan}`, '')
    if (hyp.novelty_assessment) push(`**Novelty.** ${hyp.novelty_assessment}`, '')
    if (hyp.key_assumptions.length) {
      push('**Key assumptions.**', '')
      for (const assumption of hyp.key_assumptions) push(`- ${assumption}`)
      push('')
    }
    if (hyp.citations.length) {
      push('**Citations (as generated — verify before use).**', '')
      for (const citation of hyp.citations) push(`- ${citation}`)
      push('')
      if (hyp.citationCheck) push(`Citation integrity: ${hyp.citationCheck.summary} (weighted fabrication rate ${(hyp.citationCheck.f * 100).toFixed(0)} %; rating ${hyp.citationCheck.ratingDelta >= 0 ? '+' : ''}${hyp.citationCheck.ratingDelta}, RD +${hyp.citationCheck.rdDelta}).`, '')
      else push('Citation integrity: not checked.', '')
    }
    if (hyp.safety) {
      push(`**Safety screen.** severity \`${hyp.safety.severity}\` — ${hyp.safety.category} (${hyp.safety.decision === 'quarantined' ? 'withheld from the tournament' : 'allowed'}, threshold \`${hyp.safety.threshold}\`).`, '')
      if (hyp.safety.reasoning) push(hyp.safety.reasoning, '')
      if (hyp.safety.released_by) push(`Released by ${hyp.safety.released_by}: ${hyp.safety.release_reason}`, '')
    }
    if (hyp.statusReason) push(`**Status note.** ${hyp.statusReason}`, '')

    if (hyp.reviews.length) {
      push('| Review stage | Verdict | N | C | T | Summary |', '|---|---|---|---|---|---|')
      for (const review of hyp.reviews) {
        push(`| ${review.stage} | ${review.verdict} | ${review.novelty_score ?? '—'} | ${review.correctness_score ?? '—'} | ${review.testability_score ?? '—'} | ${pipe(review.summary)} |`)
      }
      push('')
      for (const review of hyp.reviews) {
        if (review.critique) push(`*${review.stage}:* ${review.critique.replace(/\n+/g, ' ')}`)
      }
      if (lines[lines.length - 1] !== '') push('')
    }
    if (hyp.feedback.length) {
      push('**Experimental feedback.**', '')
      for (const entry of hyp.feedback) {
        push(`- reward ${entry.reward} (sentiment ${entry.sentiment}) by ${entry.recorded_by}: ${entry.feedback_text.replace(/\n+/g, ' ')} — rating ${entry.rating_before} → ${entry.rating_after}`)
      }
      push('')
    }
    const played = state.matches.filter((match) => match.hypothesisAId === hyp.id || match.hypothesisBId === hyp.id)
    if (played.length) {
      push('**Matches.**', '')
      for (const match of played) {
        const opponent = match.hypothesisAId === hyp.id ? match.hypothesisBId : match.hypothesisAId
        const own = match.hypothesisAId === hyp.id ? match.ratingAfterA : match.ratingAfterB
        const note = match.position_controlled ? '' : ' *(single orientation — position bias not controlled)*'
        push(`- vs \`${opponent}\` → ${match.verdict} (${match.match_type})${note}; rating now ${own}. ${text(match.rationale)}`)
      }
      push('')
    }
    if (hyp.protocolPlan) {
      push('**Experiment protocol.**', '')
      for (const [step, entry] of hyp.protocolPlan.steps.entries()) push(`${step + 1}. ${entry}`)
      push('')
    }
  }

  if (state.critique) push('## Meta-review critique', '', state.critique, '')
  if (state.overview) push('## Research overview', '', state.overview, '')
  push(`Generated ${state.derivedAt}.`, '')
  return `${lines.join('\n')}\n`
}

