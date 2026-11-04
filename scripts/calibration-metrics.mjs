/**
 * Small, dependency-free metrics for the Phase 0 calibration harness.
 *
 * The score is an advisory automated reading; correlating it with real decisions
 * is a check on the reading, not a claim that it predicts a venue outcome.
 */

export function mean(values) {
  const list = Array.isArray(values) ? values.map(Number).filter(Number.isFinite) : []
  return list.length ? Number((list.reduce((sum, value) => sum + value, 0) / list.length).toFixed(3)) : null
}

/** Pearson correlation with a binary predictor; the point-biserial form. */
export function pointBiserial(xs, ys) {
  const x = Array.isArray(xs) ? xs.map(Number) : []
  const y = Array.isArray(ys) ? ys.map(Number) : []
  if (x.length !== y.length || x.length < 3) return null
  if (!x.every(Number.isFinite) || !y.every(Number.isFinite)) return null
  const mx = mean(x)
  const my = mean(y)
  if (mx == null || my == null) return null
  let cov = 0
  let vx = 0
  let vy = 0
  for (let index = 0; index < x.length; index += 1) {
    const dx = x[index] - mx
    const dy = y[index] - my
    cov += dx * dy
    vx += dx * dx
    vy += dy * dy
  }
  if (!vx || !vy) return null
  return Number((cov / Math.sqrt(vx * vy)).toFixed(3))
}

/** Probability a random accepted score exceeds a random rejected score; ties 0.5. */
export function auc(positives, negatives) {
  const pos = Array.isArray(positives) ? positives.map(Number).filter(Number.isFinite) : []
  const neg = Array.isArray(negatives) ? negatives.map(Number).filter(Number.isFinite) : []
  if (!pos.length || !neg.length) return null
  let wins = 0
  for (const p of pos) {
    for (const n of neg) {
      if (p > n) wins += 1
      else if (p === n) wins += 0.5
    }
  }
  return Number((wins / (pos.length * neg.length)).toFixed(3))
}

/**
 * Join scored reviews to binary decisions. The floor is deliberate: below it the
 * harness reports not_checked instead of a correlation the sample cannot carry.
 */
export function scoreCorrelation(rows, { min = 6 } = {}) {
  const scored = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && (row.bucket === 'accept' || row.bucket === 'reject') && Number.isFinite(Number(row.score)))
    .map((row) => ({ ...row, bucket: row.bucket, score: Number(row.score) }))
  const accepts = scored.filter((row) => row.bucket === 'accept')
  const rejects = scored.filter((row) => row.bucket === 'reject')
  const enough = scored.length >= min && accepts.length > 0 && rejects.length > 0
  const heldOut = scored.filter((row) => row.evaluator_kind === 'held_out').length
  const inDistribution = scored.filter((row) => row.evaluator_kind === 'in_distribution').length
  return {
    scored: scored.length,
    min_rows_for_a_number: min,
    accepts: accepts.length,
    rejects: rejects.length,
    held_out: heldOut,
    in_distribution: inDistribution,
    mean_accept: mean(accepts.map((row) => row.score)),
    mean_reject: mean(rejects.map((row) => row.score)),
    point_biserial_r: enough ? pointBiserial(scored.map((row) => (row.bucket === 'accept' ? 1 : 0)), scored.map((row) => row.score)) : null,
    auc: enough ? auc(accepts.map((row) => row.score), rejects.map((row) => row.score)) : null,
    detail: scored.slice(0, 20),
    verdict: enough
      ? 'measured — a positive r/AUC means the advisory score separates accepted from rejected in this sample; it is not a decision predictor'
      : `not_checked (${scored.length} scored review(s) joined to a decided sample; need ${min} with both classes present)`,
  }
}
