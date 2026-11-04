/**
 * Read-only traces from experiment_log ledgers, for the hypothesis tournament.
 *
 * Nothing is written here and nothing is executed. An experiment ledger is the
 * primary record of a run; this module joins those records back into ideation so
 * an evolution mutation can see what already failed instead of proposing it
 * again. A missing or corrupt ledger is skipped, never fatal: an old experiment
 * must not block a new tournament.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { slug as slugify } from './ledger-kit.js'
import { latestVerdicts, listExperimentRuns, readExperiment } from './experiment-store.js'

/** A run's params identify the idea it tested when a value or *_id key does. */
export function paramsReference(params, id) {
  if (!params || typeof params !== 'object' || !id) return false
  const wanted = String(id)
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue
    if (String(value) === wanted) return true
    if (/(^|_)(hypothesis|idea|hyp)(_id)?$/.test(key) && String(value) === wanted) return true
  }
  return false
}

function runState(run, verdict) {
  if (verdict?.verdict === 'bad') return 'pruned'
  if (verdict?.verdict === 'engineer') return 'engineering'
  if (verdict?.verdict === 'good') return 'good'
  const metrics = run.metrics && typeof run.metrics === 'object' ? Object.keys(run.metrics) : []
  const artifacts = Array.isArray(run.artifacts) ? run.artifacts : []
  return !metrics.length && !artifacts.length ? 'failed' : 'unrated'
}

function compactRun(experiment, run, verdict) {
  const state = runState(run, verdict)
  return {
    experiment,
    run_id: run.run_id,
    ts: run.ts || null,
    params: run.params || {},
    metrics: run.metrics || {},
    role: run.role || null,
    stage: run.stage || null,
    seed: run.seed ?? null,
    parent: run.parent || null,
    notes: run.notes || null,
    artifacts: Array.isArray(run.artifacts) ? run.artifacts.length : 0,
    protocol_digest: run.protocol_digest || null,
    spec_drift: run.spec_drift?.state || null,
    verdict: verdict
      ? { verdict: verdict.verdict, requested: verdict.requested_verdict, reason: verdict.reason, forced: Boolean(verdict.forced), ts: verdict.ts }
      : null,
    state,
    failed: state === 'pruned' || state === 'failed',
  }
}

/**
 * Traces across experiment ledgers in this workspace.
 *
 * `experiment` narrows to one ledger. `hypothesisId` keeps only runs whose params
 * name that id. Failed and pruned runs are returned first so a caller that reads
 * only the head of the list cannot miss them; counts cover the whole filtered set
 * even when `limit` trims the rows.
 */
export function traceExperiments({ cwd, experiment = null, hypothesisId = null, limit = 50 } = {}) {
  const root = join(resolve(cwd), '.dsh', 'experiments')
  if (!existsSync(root)) {
    return { experiments: [], runs: [], failed: [], notes: [], scanned: 0, total_runs: 0, failed_total: 0, pruned_total: 0, unreadable: [] }
  }

  const wanted = String(experiment ?? '').trim()
  const names = wanted
    ? [slugify(wanted)]
    : readdirSync(root).sort()
  const experiments = []
  const runs = []
  const unreadable = []
  let scanned = 0

  for (const name of names) {
    const dir = join(root, name)
    if (!existsSync(join(dir, 'experiment.json'))) continue
    scanned += 1
    let definition
    let ledgerRuns
    let verdicts
    try {
      definition = readExperiment(resolve(cwd), name)
      ledgerRuns = listExperimentRuns(resolve(cwd), name)
      verdicts = latestVerdicts(resolve(cwd), name)
    } catch (error) {
      unreadable.push({ experiment: name, error: error instanceof Error ? error.message : String(error) })
      continue
    }
    const rows = ledgerRuns
      .map((run) => compactRun(name, run, verdicts.get(run.run_id)))
      .filter((run) => !hypothesisId || paramsReference(run.params, hypothesisId))
    const failed = rows.filter((run) => run.failed)
    experiments.push({
      experiment: name,
      question: definition.question,
      metrics: definition.metrics || [],
      runs: rows.length,
      failed: failed.length,
      pruned: rows.filter((run) => run.state === 'pruned').length,
    })
    runs.push(...rows)
  }

  const failed = runs.filter((run) => run.failed)
  const totalRuns = runs.length
  const ordered = [...failed, ...runs.filter((run) => !run.failed)]
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50
  return {
    experiments,
    runs: ordered.slice(0, cap),
    failed: failed.slice(0, cap),
    notes: failed.map((run) => `${run.experiment}/${run.run_id}: ${run.verdict?.reason || (run.state === 'failed' ? 'no metrics or artifacts recorded' : 'pruned')}`),
    scanned,
    total_runs: totalRuns,
    failed_total: failed.length,
    pruned_total: failed.filter((run) => run.state === 'pruned').length,
    unreadable,
  }
}
