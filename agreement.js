/**
 * Reviewer identity, per-reviewer series resolution, and inter-rater
 * agreement statistics. Pure functions; no file or network access.
 */

export const WEIGHTINGS = ['none', 'linear', 'quadratic']

const MAX_REVIEWER_NAME = 80

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

export function normalizeReviewer(value) {
  const raw = clean(value)
  if (!raw) return null
  const typed = raw.match(/^(human|ai)\s*:\s*(.*)$/i)
  const type = typed ? typed[1].toLowerCase() : 'human'
  const name = clean(typed ? typed[2] : raw)
  if (!name) throw new Error('a reviewer name is required after human:/ai:')
  if (name.toLowerCase() === 'default') {
    if (typed) throw new Error('"human:default" and "ai:default" are reserved')
    return null
  }
  if (name.length > MAX_REVIEWER_NAME) {
    throw new Error(`reviewer name is longer than ${MAX_REVIEWER_NAME} characters`)
  }
  return `${type}:${name}`
}

export function reviewerKey(value) {
  const normalized = normalizeReviewer(value)
  return normalized ? normalized.toLowerCase() : 'default'
}

export function reviewerLabel(value) {
  return normalizeReviewer(value) || 'default'
}

export function reviewerType(value) {
  const key = reviewerKey(value)
  return key.startsWith('ai:') ? 'ai' : 'human'
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function publicEntry(entry) {
  return {
    reviewer: entry.reviewer,
    reviewer_key: entry.key,
    value: entry.value,
    ts: entry.event?.ts ?? null,
    event_id: entry.event?.event_id ?? entry.event?.appraisal_id ?? null,
    quote_status: entry.event?.quote_check?.status ?? null,
    index: entry.index,
  }
}

function publicReconcile(reconcile) {
  return {
    event_id: reconcile.event?.event_id ?? reconcile.event?.appraisal_id ?? null,
    reviewer: reconcile.reviewer,
    value: reconcile.value,
    ts: reconcile.event?.ts ?? null,
    basis: reconcile.event?.basis ?? null,
    reason: reconcile.event?.reason ?? null,
  }
}

/**
 * Resolve one (record, stage) or (record, instrument, domain, axis) series.
 * `events` is in log order. Values come from `valueOf`; reconcile events are
 * recognized by `kindOf(event) === 'reconcile'`.
 */
export function resolveSeries(events = [], {
  valueOf = (event) => event?.value,
  kindOf = (event) => (event?.kind === 'reconcile' ? 'reconcile' : 'value'),
  reviewerOf = (event) => event?.reviewer,
  expectedReviewers = null,
} = {}) {
  const byReviewer = new Map()
  let lastReconcile = null

  events.forEach((event, index) => {
    const value = valueOf(event)
    if (value == null) return
    if (kindOf(event) === 'reconcile') {
      lastReconcile = {
        event,
        value,
        index,
        reviewer: reviewerLabel(reviewerOf(event)),
      }
      return
    }
    const key = reviewerKey(reviewerOf(event))
    byReviewer.set(key, {
      key,
      reviewer: reviewerLabel(reviewerOf(event)),
      value,
      index,
      event,
    })
  })

  const entries = [...byReviewer.values()]
  const base = {
    by_reviewer: entries.map(publicEntry),
    missing_reviewers: [],
    conflict: null,
    reconcile: null,
    value_event: null,
  }

  if (lastReconcile) {
    const late = entries.filter((entry) => entry.index > lastReconcile.index)
    const reconcile = publicReconcile(lastReconcile)
    if (late.some((entry) => !sameValue(entry.value, lastReconcile.value))) {
      return {
        ...base,
        state: 'reopened',
        value: null,
        reconcile,
        conflict: { by_reviewer: late.map(publicEntry), reconcile },
      }
    }
    const expected = (expectedReviewers || []).map(reviewerKey)
    const missing = expected.filter((key) => !byReviewer.has(key))
    if (missing.length) {
      return {
        ...base,
        state: 'incomplete',
        value: null,
        missing_reviewers: missing,
        reconcile,
      }
    }
    return {
      ...base,
      state: 'reconciled',
      value: lastReconcile.value,
      reconcile,
      value_event: lastReconcile.event,
    }
  }

  if (!entries.length) {
    return {
      ...base,
      state: 'pending',
      value: null,
      missing_reviewers: (expectedReviewers || []).map(reviewerKey),
    }
  }

  const distinct = new Set(entries.map((entry) => JSON.stringify(entry.value)))
  if (distinct.size > 1) {
    return {
      ...base,
      state: 'conflict',
      value: null,
      conflict: { by_reviewer: entries.map(publicEntry), reconcile: null },
    }
  }

  const missing = (expectedReviewers || []).map(reviewerKey).filter((key) => !byReviewer.has(key))
  if (missing.length) {
    return { ...base, state: 'incomplete', value: null, missing_reviewers: missing }
  }

  const latest = entries.reduce((best, entry) => (entry.index > best.index ? entry : best), entries[0])
  return {
    ...base,
    state: entries.length === 1 ? 'single' : 'unanimous',
    value: entries[0].value,
    value_event: latest.event,
  }
}

function weightMatrix(size, weighting) {
  const weights = Array.from({ length: size }, () => Array(size).fill(1))
  if (weighting === 'none') return weights
  const power = weighting === 'quadratic' ? 2 : 1
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j < size; j += 1) {
      weights[i][j] = 1 - (Math.abs(i - j) / (size - 1)) ** power
    }
  }
  return weights
}

function undefinedKappa({
  reason, n = 0, invalid = 0, categories, weighting, po = null, expected = null,
  weighted = null, observed = null, row = null, col = null,
}) {
  return {
    n,
    invalid,
    categories,
    weighting,
    percent_agreement: po,
    weighted_agreement: weighted,
    expected_agreement: expected,
    kappa: null,
    se: null,
    ci: null,
    ci_method: 'normal_approximation',
    undefined_reason: reason,
    ci_clipped: false,
    observed,
    row,
    col,
  }
}

export function cohenKappa(pairs = [], { categories = [], weighting = 'none' } = {}) {
  if (!WEIGHTINGS.includes(weighting)) {
    throw new Error(`weighting must be one of ${WEIGHTINGS.join(', ')}`)
  }
  if (!Array.isArray(categories) || categories.length < 2) {
    return undefinedKappa({ reason: 'single_category', n: 0, categories, weighting })
  }
  const index = new Map(categories.map((id, i) => [String(id), i]))
  const usable = []
  let invalid = 0
  for (const pair of pairs) {
    const [a, b] = pair || []
    if (index.has(String(a)) && index.has(String(b))) {
      usable.push([index.get(String(a)), index.get(String(b))])
    } else {
      invalid += 1
    }
  }
  const n = usable.length
  if (!n) {
    return undefinedKappa({ reason: 'no_common_units', n: 0, invalid, categories, weighting })
  }

  const size = categories.length
  const observed = Array.from({ length: size }, () => Array(size).fill(0))
  const row = Array(size).fill(0)
  const col = Array(size).fill(0)
  for (const [a, b] of usable) {
    observed[a][b] += 1
    row[a] += 1
    col[b] += 1
  }

  let diagonal = 0
  let poWeighted = 0
  let peWeighted = 0
  const weights = weightMatrix(size, weighting)
  for (let i = 0; i < size; i += 1) {
    diagonal += observed[i][i]
    for (let j = 0; j < size; j += 1) {
      poWeighted += weights[i][j] * observed[i][j] / n
      peWeighted += weights[i][j] * row[i] * col[j] / (n * n)
    }
  }
  const po = diagonal / n
  const pe = row.reduce((sum, value, i) => sum + value * col[i], 0) / (n * n)
  const usedPo = weighting === 'none' ? po : poWeighted
  const usedPe = weighting === 'none' ? pe : peWeighted
  const denominator = 1 - usedPe

  if (denominator <= 1e-12) {
    return undefinedKappa({
      reason: 'expected_agreement_one',
      n,
      invalid,
      categories,
      weighting,
      po,
      expected: usedPe,
      weighted: weighting === 'none' ? null : poWeighted,
      observed,
      row,
      col,
    })
  }

  const kappa = (usedPo - usedPe) / denominator
  const se = Math.sqrt(Math.max(0, usedPo * (1 - usedPo)) / (n * denominator * denominator))
  const low = kappa - 1.96 * se
  const high = kappa + 1.96 * se
  const ci = [Math.max(-1, low), Math.min(1, high)]

  return {
    n,
    invalid,
    categories,
    weighting,
    percent_agreement: po,
    weighted_agreement: weighting === 'none' ? null : poWeighted,
    expected_agreement: usedPe,
    kappa,
    se,
    ci,
    ci_method: 'normal_approximation',
    undefined_reason: null,
    ci_clipped: ci[0] !== low || ci[1] !== high,
    observed,
    row,
    col,
  }
}

function combinations(values) {
  const out = []
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) out.push([values[i], values[j]])
  }
  return out
}

export function summarizeAgreement({ ratings = [], categories = [], weighting = 'none' } = {}) {
  if (!WEIGHTINGS.includes(weighting)) {
    throw new Error(`weighting must be one of ${WEIGHTINGS.join(', ')}`)
  }
  if (!Array.isArray(categories) || categories.length < 2) {
    throw new Error('agreement needs at least two categories')
  }
  const index = new Set(categories.map((id) => String(id)))

  const units = new Map()
  const raters = new Map()
  let invalid = 0
  for (const row of ratings) {
    const unit = clean(row?.unit)
    if (!unit) continue
    if (!index.has(String(row.value))) {
      invalid += 1
      continue
    }
    const key = reviewerKey(row.reviewer)
    if (!units.has(unit)) units.set(unit, new Map())
    units.get(unit).set(key, { value: row.value })
    if (!raters.has(key)) {
      raters.set(key, { key, reviewer: reviewerLabel(row.reviewer), type: reviewerType(row.reviewer) })
    }
  }

  const humanKeys = [...raters.values()].filter((rater) => rater.type === 'human').map((rater) => rater.key).sort()
  const aiKeys = [...raters.values()].filter((rater) => rater.type === 'ai').map((rater) => rater.key).sort()
  const display = (key) => raters.get(key)?.reviewer || key

  function compare(left, right) {
    const pairs = []
    let dropped = 0
    for (const target of units.values()) {
      const a = target.get(left)
      const b = target.get(right)
      if (!a || !b) {
        dropped += 1
        continue
      }
      pairs.push([a.value, b.value])
    }
    return {
      raters: [display(left), display(right)],
      units: pairs.length,
      dropped_units: dropped,
      ...cohenKappa(pairs, { categories, weighting }),
    }
  }

  const humanPairs = combinations(humanKeys).map(([a, b]) => compare(a, b))
  const aiHumanPairs = []
  for (const ai of aiKeys) for (const human of humanKeys) aiHumanPairs.push(compare(ai, human))
  const aiPairs = combinations(aiKeys).map(([a, b]) => compare(a, b))

  const incompleteUnits = [...units.values()].filter((target) => target.size < 2).length
  const caveats = []
  const addCaveat = (code, detail, pair = null) => {
    if (caveats.some((item) => item.code === code && item.detail === detail
      && JSON.stringify(item.raters) === JSON.stringify(pair))) return
    caveats.push({ code, detail, ...(pair ? { raters: pair } : {}) })
  }

  for (const result of [...humanPairs, ...aiHumanPairs, ...aiPairs]) {
    const label = result.raters
    if (result.undefined_reason) {
      addCaveat('kappa_undefined', `kappa is undefined (${result.undefined_reason}); report percent agreement only`, label)
    }
    if (result.ci_clipped) addCaveat('ci_clipped', 'the 95% CI was clipped to the [-1, 1] range', label)
    if (result.n > 0 && result.n < 20) addCaveat('small_sample', `only ${result.n} shared unit(s)`, label)
    if (result.kappa != null && result.percent_agreement >= 0.8 && result.kappa < 0.4) {
      addCaveat('high_agreement_low_kappa', 'high percent agreement but low kappa: the marginals are skewed', label)
    }
    if (result.n > 0 && result.row && result.col) {
      const bias = result.row.reduce((sum, value, i) => sum + Math.abs(value - result.col[i]), 0) / (2 * result.n)
      if (bias > 0.2) addCaveat('rater_bias_possible', 'the raters use the categories at different rates', label)
    }
    if (result.kappa != null) {
      addCaveat('prevalence_marginals', 'kappa depends on the category marginals; low prevalence can lower it even with high agreement')
    }
  }
  if (humanKeys.length > 2) {
    addCaveat('pairwise_only', 'more than two human raters: agreement is reported pairwise; Fleiss\' kappa is not implemented')
  }
  if (!humanKeys.length) {
    addCaveat('no_human_rater', 'no human rater is available for a human kappa')
  }
  if (aiKeys.length) {
    addCaveat('ai_separated', 'AI judgements are reported separately and are never folded into the human kappa')
  }

  const notes = []
  if (aiKeys.length) notes.push('Human-vs-human agreement is primary; AI-vs-human and AI-vs-AI pairs are separate.')
  if (humanKeys.length > 2) notes.push('Pairwise kappa only for more than two human raters; Fleiss\' kappa is a later addition.')
  if (!humanPairs.length) notes.push(`No human pair is available; ${aiHumanPairs.length + aiPairs.length} AI pair(s) are reported separately.`)

  return {
    categories,
    weighting,
    raters: {
      human: humanKeys.map(display),
      ai: aiKeys.map(display),
    },
    human: {
      pairs: humanPairs,
      primary: humanKeys.length === 2 ? humanPairs[0] : null,
    },
    ai_vs_human: { pairs: aiHumanPairs },
    ai_vs_ai: { pairs: aiPairs },
    n_units: units.size,
    dropped: { invalid, incomplete_units: incompleteUnits },
    caveats,
    notes,
  }
}
