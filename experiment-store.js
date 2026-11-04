/**
 * Experiment-log ledger: a structured run registry for sweeps, simulations,
 * pilots, and model comparisons under `<cwd>/.dsh/experiments/<slug>/`.
 *
 *   experiment.json  write-once definition (question, metric directions)
 *   runs.jsonl       append-only runs (params, metrics, artifacts, seed, env)
 *   links.jsonl      append-only links to notebook entries, results, papers
 *   exports/         csv/json/markdown/mlflow exports
 *
 * A rerun is a new run — nothing is deduplicated, and "best" is always by a
 * named metric with an explicit direction.
 */
import os from 'node:os'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import {
  appendJsonl, csvCell, ensureDir, exportText, hashFile, mdCell, nowIso,
  readJson, readJsonl, sha256, slug as slugify, stableStringify, writeOnceJson,
} from './ledger-kit.js'
import { withLock } from './store-lock.js'
import { resolveWorkspacePath } from './workspace-path.js'

export const EXPERIMENT_DIRECTIONS = ['higher', 'lower']
export const EXPERIMENT_EXPORT_FORMATS = ['csv', 'json', 'markdown', 'mlflow']
export const EXPERIMENT_ROLES = ['baseline', 'variant']
export const EXPERIMENT_BASELINE_REFS = ['reproduced', 'reported']
export const EXPERIMENT_STAGES = ['subset', 'slice', 'full']
export const EXPERIMENT_VERDICTS = ['good', 'engineer', 'bad']
export const LINK_TARGET_KINDS = ['notebook', 'scientific_result', 'analysis_run', 'experiment_run', 'paper', 'review']

function text(value) {
  return String(value ?? '').trim()
}

function files(cwd, slugValue) {
  const dir = join(cwd, '.dsh', 'experiments', slugify(slugValue))
  return {
    dir,
    experiment: join(dir, 'experiment.json'),
    runs: join(dir, 'runs.jsonl'),
    links: join(dir, 'links.jsonl'),
    verdicts: join(dir, 'verdicts.jsonl'),
    exports: join(dir, 'exports'),
  }
}

function objectValue(value, name) {
  if (value == null || value === '') return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}

function stringList(value, name, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw new Error(`${name} is required`)
    return []
  }
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of non-empty strings`)
  const out = []
  const seen = new Set()
  for (const entry of value) {
    const item = text(entry)
    if (!item) throw new Error(`${name} must be an array of non-empty strings`)
    if (!seen.has(item)) {
      seen.add(item)
      out.push(item)
    }
  }
  if (required && !out.length) throw new Error(`${name} needs at least one entry`)
  return out
}

function normalizeMetrics(input) {
  if (input == null || input === '') return []
  if (!Array.isArray(input)) throw new Error('metrics must be an array')
  const out = []
  const seen = new Set()
  for (const entry of input) {
    const name = typeof entry === 'string' ? entry.trim() : text(entry?.name)
    if (!name) throw new Error('every metric needs a name')
    if (seen.has(name)) throw new Error(`duplicate metric ${name}`)
    seen.add(name)
    const direction = typeof entry === 'string' ? null : text(entry?.direction).toLowerCase()
    if (direction && !EXPERIMENT_DIRECTIONS.includes(direction)) {
      throw new Error(`metric ${name} direction must be one of ${EXPERIMENT_DIRECTIONS.join(', ')}`)
    }
    out.push({ name, direction: direction || null })
  }
  return out
}

/** The benchmark contract: datasets, splits, a baseline arm, and task rules. */
function normalizeBenchmark(input, metrics) {
  if (input == null || input === '') return null
  const value = objectValue(input, 'benchmark')
  const datasets = stringList(value.datasets, 'benchmark.datasets', { required: true })
  const splits = stringList(value.splits, 'benchmark.splits', { required: true })
  const baselineArm = text(value.baseline_arm ?? value.baselineArm)
  if (!baselineArm) throw new Error('benchmark.baseline_arm is required')
  const taskRules = stringList(value.task_rules ?? value.taskRules, 'benchmark.task_rules', { required: true })
  if (!metrics.length) throw new Error('a benchmark needs at least one metric with a direction')
  const missing = metrics.filter((metric) => !metric.direction).map((metric) => metric.name)
  if (missing.length) throw new Error(`benchmark metrics need a direction (higher|lower): ${missing.join(', ')}`)
  return { datasets, splits, baseline_arm: baselineArm, task_rules: taskRules }
}

/** The eval script and metric parameters whose hash defines the protocol. */
function normalizeProtocol(cwd, input) {
  if (input == null || input === '') return null
  const value = objectValue(input, 'protocol')
  const evalScript = text(value.eval_script ?? value.evalScript)
  if (!evalScript) throw new Error('protocol.eval_script is required')
  const abs = resolveWorkspacePath(cwd, evalScript)
  if (!existsSync(abs)) throw new Error(`protocol.eval_script not found: ${evalScript}`)
  const metricParams = objectValue(value.metric_params ?? value.metricParams, 'protocol.metric_params')
  return { eval_script: evalScript, metric_params: metricParams }
}

/** SHA-256 of the eval script hash plus the canonical metric parameters. */
function protocolDigest(cwd, protocol) {
  const abs = resolveWorkspacePath(cwd, protocol.eval_script)
  if (!existsSync(abs)) throw new Error(`protocol.eval_script not found: ${protocol.eval_script}`)
  const evalScriptHash = `sha256:${hashFile(abs)}`
  const metricParams = objectValue(protocol.metric_params, 'protocol.metric_params')
  const digest = `sha256:${sha256(`${evalScriptHash}\n${stableStringify(metricParams)}`)}`
  return { ...protocol, eval_script_hash: evalScriptHash, protocol_digest: digest }
}

function normalizeSampling(input, stage) {
  const required = stage === 'subset' || stage === 'slice'
  if (input == null || input === '') {
    if (required) throw new Error(`stage "${stage}" needs a sampling rule (rule, size, or stratification)`)
    return null
  }
  const value = typeof input === 'string' ? { rule: input } : objectValue(input, 'sampling')
  const rule = text(value.rule ?? value.note)
  const sizeRaw = value.size
  const size = sizeRaw == null || sizeRaw === '' ? null : Number(sizeRaw)
  if (size != null && (!Number.isInteger(size) || size <= 0)) throw new Error('sampling.size must be a positive integer')
  const seedRaw = value.seed
  const seed = seedRaw == null || seedRaw === '' ? null : Number(seedRaw)
  if (seed != null && !Number.isFinite(seed)) throw new Error('sampling.seed must be a number')
  const stratification = value.stratification == null
    ? null
    : Array.isArray(value.stratification)
      ? stringList(value.stratification, 'sampling.stratification')
      : text(value.stratification) || null
  if (required && !rule && size == null && !stratification) {
    throw new Error(`stage "${stage}" needs a sampling rule (rule, size, or stratification)`)
  }
  return { rule: rule || null, size, seed, stratification }
}

export async function startExperiment({ cwd, slug: slugValue, experiment = {} }) {
  const f = files(cwd, slugValue)
  const question = text(experiment.question)
  if (!question) throw new Error('experiment.question is required')
  const metrics = normalizeMetrics(experiment.metrics)
  const benchmark = normalizeBenchmark(experiment.benchmark, metrics)
  const protocol = normalizeProtocol(cwd, experiment.protocol)
  const stored = {
    slug: slugify(slugValue),
    name: text(experiment.name) || slugify(slugValue),
    question,
    metrics,
    ...(benchmark ? { benchmark } : {}),
    ...(protocol ? { protocol } : {}),
    notes: text(experiment.notes) || null,
    created_at: nowIso(),
  }
  ensureDir(f.dir)
  return withLock(f.dir, () => {
    if (readJson(f.experiment)) {
      if (!experiment.resume) {
        throw new Error(`experiment "${stored.slug}" already exists; pass resume: true to continue it`)
      }
      return { experiment: readJson(f.experiment), resumed: true }
    }
    writeOnceJson(f.experiment, stored)
    return { experiment: stored, resumed: false }
  }, { label: 'experiment ledger' })
}

export function readExperiment(cwd, slugValue) {
  const f = files(cwd, slugValue)
  const stored = readJson(f.experiment)
  if (!stored) throw new Error(`experiment "${slugify(slugValue)}" not found under ${f.dir.slice(cwd.length + 1)}`)
  return stored
}

function gitCommit(cwd) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 10_000, shell: false })
  if (result.status !== 0) return null
  return text(result.stdout) || null
}

function hashArtifacts(cwd, artifacts) {
  if (artifacts == null || artifacts === '') return []
  if (!Array.isArray(artifacts)) throw new Error('artifacts must be an array of workspace-relative paths')
  return artifacts.map((rel) => {
    if (typeof rel !== 'string' || !rel.trim()) throw new Error('artifact paths must be non-empty strings')
    const abs = resolveWorkspacePath(cwd, rel)
    return { path: rel, sha256: `sha256:${hashFile(abs)}` }
  })
}

function metricValues(input, definition) {
  const metrics = objectValue(input, 'metrics')
  const out = {}
  for (const [name, value] of Object.entries(metrics)) {
    if (value == null) continue
    const number = Number(value)
    if (!Number.isFinite(number)) throw new Error(`metric ${name} must be a finite number (missing metrics should be omitted, not zeroed)`)
    out[name] = number
  }
  const declared = new Set((definition?.metrics || []).map((entry) => entry.name))
  const undeclared = Object.keys(out).filter((name) => !declared.has(name))
  return { values: out, undeclared }
}

export async function logExperimentRun({
  cwd,
  slug: slugValue,
  params,
  metrics,
  artifacts,
  seed = null,
  parent = null,
  notes = null,
  environment = null,
  role = null,
  baselineRef = null,
  stage = null,
  sampling = null,
  protocol = null,
}) {
  const f = files(cwd, slugValue)
  const definition = readExperiment(cwd, slugValue)
  const paramsObject = objectValue(params, 'params')
  const { values, undeclared } = metricValues(metrics, definition)
  const hashed = hashArtifacts(cwd, artifacts)
  const seedNumber = seed == null || seed === '' ? null : Number(seed)
  if (seedNumber != null && !Number.isFinite(seedNumber)) throw new Error('seed must be a number')
  const parentRun = text(parent)

  const roleValue = text(role).toLowerCase() || null
  if (roleValue && !EXPERIMENT_ROLES.includes(roleValue)) throw new Error(`role must be one of ${EXPERIMENT_ROLES.join(', ')}`)
  const baselineRefValue = text(baselineRef).toLowerCase() || null
  if (baselineRefValue && !EXPERIMENT_BASELINE_REFS.includes(baselineRefValue)) {
    throw new Error(`baseline_ref must be one of ${EXPERIMENT_BASELINE_REFS.join(', ')}`)
  }
  const stageValue = text(stage).toLowerCase() || null
  if (stageValue && !EXPERIMENT_STAGES.includes(stageValue)) throw new Error(`stage must be one of ${EXPERIMENT_STAGES.join(', ')}`)
  if (!roleValue && (baselineRefValue || stageValue || sampling != null)) {
    throw new Error('role: baseline|variant is required for baseline_ref, stage, or sampling')
  }
  if (roleValue) {
    if (!definition.benchmark) {
      throw new Error('this experiment has no benchmark spec; start it with benchmark: {datasets, splits, baseline_arm, task_rules} before logging a staged run')
    }
    if (!baselineRefValue) throw new Error('a staged run needs baseline_ref: reproduced|reported')
    if (!stageValue) throw new Error('a staged run needs stage: subset|slice|full')
  }
  const samplingValue = normalizeSampling(sampling, stageValue)

  const protocolInput = protocol == null ? definition.protocol : protocol
  const normalizedProtocol = protocolInput ? normalizeProtocol(cwd, protocolInput) : null
  if (roleValue && !normalizedProtocol) {
    throw new Error('a staged run needs a protocol (eval_script + metric_params); declare it at start or pass protocol on this run')
  }
  const proto = normalizedProtocol ? protocolDigest(cwd, normalizedProtocol) : null

  return withLock(f.dir, () => {
    const runs = readJsonl(f.runs)
    if (parentRun && !runs.some((run) => run.run_id === parentRun)) {
      throw new Error(`parent run "${parentRun}" not found`)
    }
    let baseline = null
    let specDrift = null
    if (roleValue === 'baseline') {
      specDrift = {
        state: 'baseline',
        expected_digest: null,
        actual_digest: proto.protocol_digest,
        changed: [],
        baseline_run_id: null,
      }
    } else if (roleValue === 'variant') {
      baseline = runs.find((run) => run.role === 'baseline'
        && run.baseline_ref === baselineRefValue
        && run.protocol_digest)
      if (!baseline) {
        throw new Error(`no baseline run with baseline_ref "${baselineRefValue}" and a protocol_digest; log the baseline first`)
      }
      const changed = []
      if (proto.eval_script_hash !== baseline.protocol?.eval_script_hash) changed.push('eval_script')
      if (stableStringify(proto.metric_params) !== stableStringify(baseline.protocol?.metric_params)) changed.push('metric_params')
      specDrift = {
        state: proto.protocol_digest === baseline.protocol_digest ? 'match' : 'drift',
        expected_digest: baseline.protocol_digest,
        actual_digest: proto.protocol_digest,
        changed,
        baseline_run_id: baseline.run_id,
      }
    }
    const runId = `x${String(runs.length + 1).padStart(4, '0')}`
    const event = {
      run_id: runId,
      ts: nowIso(),
      experiment: definition.slug,
      params: paramsObject,
      metrics: values,
      artifacts: hashed,
      seed: seedNumber,
      parent: parentRun || null,
      notes: text(notes) || null,
      role: roleValue,
      baseline_ref: baselineRefValue,
      stage: stageValue,
      sampling: samplingValue,
      protocol: proto,
      protocol_digest: proto?.protocol_digest ?? null,
      baseline_run_id: baseline?.run_id ?? null,
      spec_drift: specDrift,
      environment: {
        node: process.version,
        os: `${os.type()} ${os.release()}`,
        git_commit: gitCommit(cwd),
        ...objectValue(environment, 'environment'),
      },
    }
    appendJsonl(f.runs, [event])
    return { run: event, undeclared_metrics: undeclared }
  }, { label: 'experiment ledger' })
}

export function listExperimentRuns(cwd, slugValue) {
  return readJsonl(files(cwd, slugValue).runs)
}

export function listExperimentLinks(cwd, slugValue) {
  return readJsonl(files(cwd, slugValue).links)
}

function metricNames(definition, runs) {
  const names = new Set(definition.metrics.map((entry) => entry.name))
  for (const run of runs) for (const name of Object.keys(run.metrics)) names.add(name)
  return [...names]
}

function bestRun(runs, name, direction) {
  const scored = runs.filter((run) => run.metrics[name] != null)
  if (!scored.length) return null
  const better = direction === 'lower'
    ? (a, b) => a.metrics[name] < b.metrics[name]
    : (a, b) => a.metrics[name] > b.metrics[name]
  return scored.reduce((best, run) => (better(run, best) ? run : best))
}

export function compareExperiments(cwd, slugValue, { field = null } = {}) {
  const definition = readExperiment(cwd, slugValue)
  const runs = listExperimentRuns(cwd, slugValue)
  if (!runs.length) return { experiment: definition, runs: [], metrics: [], best: {}, note: 'No runs logged yet.' }
  const latest = latestVerdicts(cwd, slugValue)
  const metrics = metricNames(definition, runs)
  const directions = Object.fromEntries(definition.metrics.map((entry) => [entry.name, entry.direction || 'higher']))
  const best = {}
  for (const name of metrics) {
    const winner = bestRun(runs, name, directions[name])
    if (winner) best[name] = { run_id: winner.run_id, value: winner.metrics[name], direction: directions[name] || 'higher' }
  }
  let grouped = null
  if (field) {
    const groups = new Map()
    for (const run of runs) {
      const key = run.params?.[field]
      const label = key == null ? '(missing)' : String(key)
      if (!groups.has(label)) groups.set(label, [])
      groups.get(label).push(run)
    }
    grouped = [...groups.entries()].map(([label, members]) => ({
      value: label,
      runs: members.length,
      best: Object.fromEntries(metrics.flatMap((name) => {
        const winner = bestRun(members, name, directions[name] || 'higher')
        return winner ? [[name, { run_id: winner.run_id, value: winner.metrics[name] }]] : []
      })),
    }))
  }
  return {
    experiment: definition,
    metrics,
    directions,
    runs: runs.map((run) => ({
      run_id: run.run_id,
      ts: run.ts,
      seed: run.seed,
      params: run.params,
      metrics: run.metrics,
      role: run.role ?? null,
      baseline_ref: run.baseline_ref ?? null,
      stage: run.stage ?? null,
      protocol_digest: run.protocol_digest ?? null,
      spec_drift: run.spec_drift ?? null,
      verdict: latest.get(run.run_id) ?? null,
      artifact_count: run.artifacts.length,
    })),
    best,
    grouped,
  }
}

export function bestExperimentRun(cwd, slugValue, { metric, direction = null } = {}) {
  const definition = readExperiment(cwd, slugValue)
  const name = text(metric)
  if (!name) throw new Error('best requires a named metric (there is no implicit best model)')
  const declared = definition.metrics.find((entry) => entry.name === name)
  const wanted = text(direction).toLowerCase() || declared?.direction
  if (!wanted) {
    throw new Error(`metric "${name}" has no direction; pass direction: higher|lower explicitly`)
  }
  if (!EXPERIMENT_DIRECTIONS.includes(wanted)) throw new Error(`direction must be one of ${EXPERIMENT_DIRECTIONS.join(', ')}`)
  const runs = listExperimentRuns(cwd, slugValue)
  const winner = bestRun(runs, name, wanted)
  if (!winner) throw new Error(`no run records metric "${name}"`)
  const tied = runs.filter((run) => run.metrics[name] === winner.metrics[name])
  return { metric: name, direction: wanted, run: winner, tied_runs: tied.map((run) => run.run_id) }
}

/**
 * Pareto dominance over the declared metrics. A run is complete only when every
 * declared metric is present; a run with a missing metric is listed as
 * incomplete rather than guessed. Ties are not dominance, so both stay on the
 * front. This is the plugin's specification of the paper's undefined
 * "preferred" gate, not a scientific claim.
 */
export function dominanceExperiment(cwd, slugValue) {
  const definition = readExperiment(cwd, slugValue)
  const runs = listExperimentRuns(cwd, slugValue)
  if (!definition.metrics.length) throw new Error('dominance needs at least one declared metric')
  const missingDirection = definition.metrics.filter((metric) => !metric.direction)
  if (missingDirection.length) {
    throw new Error(`dominance needs a direction for every metric; missing: ${missingDirection.map((metric) => metric.name).join(', ')}`)
  }
  const complete = []
  const incomplete = []
  for (const run of runs) {
    const missing = definition.metrics.filter((metric) => run.metrics[metric.name] == null).map((metric) => metric.name)
    if (missing.length) incomplete.push({ run_id: run.run_id, missing })
    else complete.push(run)
  }
  const dominates = (a, b) => {
    let strict = false
    for (const metric of definition.metrics) {
      const av = a.metrics[metric.name]
      const bv = b.metrics[metric.name]
      if (metric.direction === 'lower') {
        if (av > bv) return false
        if (av < bv) strict = true
      } else {
        if (av < bv) return false
        if (av > bv) strict = true
      }
    }
    return strict
  }
  const front = complete.filter((run) => !complete.some((other) => other.run_id !== run.run_id && dominates(other, run)))
  const dominated = complete.filter((run) => !front.some((entry) => entry.run_id === run.run_id))
  const relations = []
  for (const a of complete) {
    for (const b of complete) {
      if (a.run_id !== b.run_id && dominates(a, b)) relations.push({ dominates: a.run_id, dominated: b.run_id })
    }
  }
  return {
    metrics: definition.metrics.map((metric) => ({ name: metric.name, direction: metric.direction })),
    front: front.map((run) => ({
      run_id: run.run_id,
      role: run.role ?? null,
      stage: run.stage ?? null,
      metrics: run.metrics,
      dominated_run_ids: complete.filter((other) => other.run_id !== run.run_id && dominates(run, other)).map((other) => other.run_id),
    })),
    dominated: dominated.map((run) => run.run_id),
    incomplete,
    relations: relations.slice(0, 100),
    note: 'Pareto front over declared metrics and directions: a run dominates only when it is at least as good on every declared metric and strictly better on one. Runs missing a declared metric are incomplete and not ranked. No run here is a scientific claim.',
  }
}

export function listExperimentVerdicts(cwd, slugValue) {
  return readJsonl(files(cwd, slugValue).verdicts)
}

export function latestVerdicts(cwd, slugValue) {
  const map = new Map()
  for (const verdict of listExperimentVerdicts(cwd, slugValue)) map.set(verdict.run_id, verdict)
  return map
}

function normalizeBudget(input) {
  if (input == null || input === '') return null
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) throw new Error('budget must be a positive number of rounds')
    return { max_rounds: input, used: null, exhausted: false }
  }
  const value = objectValue(input, 'budget')
  const maxRaw = value.max_rounds ?? value.maxRounds
  const usedRaw = value.used
  const max = maxRaw == null || maxRaw === '' ? null : Number(maxRaw)
  const used = usedRaw == null || usedRaw === '' ? null : Number(usedRaw)
  if (max != null && (!Number.isInteger(max) || max <= 0)) throw new Error('budget.max_rounds must be a positive integer')
  if (used != null && (!Number.isInteger(used) || used < 0)) throw new Error('budget.used must be a non-negative integer')
  if (value.exhausted != null && typeof value.exhausted !== 'boolean') throw new Error('budget.exhausted must be a boolean')
  return { max_rounds: max, used, exhausted: value.exhausted === true }
}

/**
 * Advisory record of a human decision. Engineer is not a terminal state: when
 * its budget is exhausted, the recorded verdict is force-bad.
 */
export async function verdictExperiment({
  cwd,
  slug: slugValue,
  runId,
  verdict,
  reason,
  engineeringRound = null,
  budget = null,
}) {
  const f = files(cwd, slugValue)
  const run = listExperimentRuns(cwd, slugValue).find((entry) => entry.run_id === text(runId))
  if (!run) throw new Error(`run "${runId}" not found`)
  const requested = text(verdict).toLowerCase()
  if (!EXPERIMENT_VERDICTS.includes(requested)) throw new Error(`verdict must be one of ${EXPERIMENT_VERDICTS.join(', ')}`)
  const why = text(reason)
  if (!why) throw new Error('reason is required')
  const round = engineeringRound == null || engineeringRound === '' ? null : Number(engineeringRound)
  if (round != null && (!Number.isInteger(round) || round < 1)) throw new Error('engineering_round must be a positive integer')
  const budgetValue = normalizeBudget(budget)
  if (requested === 'engineer') {
    if (round == null) throw new Error('engineering_round is required for verdict "engineer"')
    if (!budgetValue) throw new Error('a budget is required for verdict "engineer"')
  }
  const exhausted = requested === 'engineer' && Boolean(budgetValue) && (
    budgetValue.exhausted === true
    || (budgetValue.max_rounds != null && budgetValue.used != null && budgetValue.used >= budgetValue.max_rounds)
    || (budgetValue.max_rounds != null && round != null && round > budgetValue.max_rounds)
  )
  const finalVerdict = requested === 'engineer' && exhausted ? 'bad' : requested
  return withLock(f.dir, () => {
    const verdicts = readJsonl(f.verdicts)
    const event = {
      verdict_id: `v${String(verdicts.length + 1).padStart(4, '0')}`,
      ts: nowIso(),
      run_id: run.run_id,
      requested_verdict: requested,
      verdict: finalVerdict,
      forced: requested === 'engineer' && exhausted,
      reason: requested === 'engineer' && exhausted ? `${why} (forced bad: engineering budget exhausted)` : why,
      engineering_round: round,
      budget: budgetValue,
    }
    appendJsonl(f.verdicts, [event])
    return { verdict: event }
  }, { label: 'experiment ledger' })
}

export async function linkExperimentRun({ cwd, slug: slugValue, runId, targetKind, targetId, note = null }) {
  const f = files(cwd, slugValue)
  const run = listExperimentRuns(cwd, slugValue).find((entry) => entry.run_id === text(runId))
  if (!run) throw new Error(`run "${runId}" not found`)
  const kind = text(targetKind)
  if (!LINK_TARGET_KINDS.includes(kind)) throw new Error(`target_kind must be one of ${LINK_TARGET_KINDS.join(', ')}`)
  const id = text(targetId)
  if (!id) throw new Error('target_id is required')
  return withLock(f.dir, () => {
    const event = { run_id: run.run_id, ts: nowIso(), target: { kind, id }, note: text(note) || null }
    appendJsonl(f.links, [event])
    return { link: event }
  }, { label: 'experiment ledger' })
}

export function experimentStatus(cwd, slugValue) {
  const f = files(cwd, slugValue)
  const definition = readExperiment(cwd, slugValue)
  const runs = readJsonl(f.runs)
  const links = readJsonl(f.links)
  const verdicts = readJsonl(f.verdicts)
  const baselines = runs.filter((run) => run.role === 'baseline')
  const drift = runs.filter((run) => run.spec_drift?.state === 'drift')
  return {
    slug: definition.slug,
    name: definition.name,
    question: definition.question,
    dir: f.dir.slice(cwd.length + 1),
    metrics: definition.metrics,
    benchmark: definition.benchmark ?? null,
    protocol: definition.protocol ?? null,
    baseline_runs: baselines.map((run) => ({ run_id: run.run_id, baseline_ref: run.baseline_ref ?? null, protocol_digest: run.protocol_digest ?? null })),
    spec_drift_runs: drift.map((run) => ({ run_id: run.run_id, changed: run.spec_drift.changed ?? [], baseline_run_id: run.spec_drift.baseline_run_id ?? null })),
    runs: runs.length,
    last_run: runs.at(-1)?.run_id ?? null,
    links: links.length,
    verdicts: verdicts.length,
    latest_verdict: verdicts.at(-1) ?? null,
  }
}

function runsCsv(definition, runs, verdicts = []) {
  const metrics = metricNames(definition, runs)
  const params = [...new Set(runs.flatMap((run) => Object.keys(run.params || {})))]
  const latest = new Map(verdicts.map((verdict) => [verdict.run_id, verdict]))
  const header = ['run_id', 'ts', 'seed', 'parent', 'role', 'baseline_ref', 'stage', 'protocol_digest', 'spec_drift', ...params, ...metrics, 'verdict', 'artifacts', 'notes']
  const lines = [header.map(csvCell).join(',')]
  for (const run of runs) {
    lines.push([
      run.run_id, run.ts, run.seed ?? '', run.parent ?? '',
      run.role ?? '', run.baseline_ref ?? '', run.stage ?? '', run.protocol_digest ?? '', run.spec_drift?.state ?? '',
      ...params.map((name) => run.params?.[name] ?? ''),
      ...metrics.map((name) => run.metrics?.[name] ?? ''),
      latest.get(run.run_id)?.verdict ?? '',
      run.artifacts.map((entry) => entry.path).join('; '),
      run.notes ?? '',
    ].map(csvCell).join(','))
  }
  return `${lines.join('\n')}\n`
}

function runsMarkdown(definition, runs, links, verdicts = []) {
  const latest = new Map(verdicts.map((verdict) => [verdict.run_id, verdict]))
  const metrics = metricNames(definition, runs)
  const directions = Object.fromEntries(definition.metrics.map((entry) => [entry.name, entry.direction || 'higher']))
  const lines = [
    `# Experiment: ${definition.name}`,
    '',
    `**Question:** ${definition.question}`,
    definition.notes ? `**Notes:** ${definition.notes}` : null,
    '',
    '## Runs',
    '',
    `| Run | ${['ts', ...metrics.map((name) => `${name} (${directions[name] || 'higher'})`), 'artifacts', 'notes'].join(' | ')} |`,
    `|---|${Array(metrics.length + 4).fill('---').join('|')}|`,
  ].filter((entry) => entry !== null)
  for (const run of runs) {
    lines.push(`| ${run.run_id} | ${run.ts} | ${metrics.map((name) => (run.metrics[name] == null ? '' : mdCell(run.metrics[name]))).join(' | ')} | ${run.artifacts.length} | ${mdCell(run.notes || '')} |`)
  }
  const bestLines = metrics.flatMap((name) => {
    const winner = bestRun(runs, name, directions[name] || 'higher')
    return winner ? [`- ${name} (${directions[name] || 'higher'}): ${winner.run_id} = ${winner.metrics[name]}`] : []
  })
  if (bestLines.length) lines.push('', '## Best per named metric', '', ...bestLines)
  if (definition.benchmark || runs.some((run) => run.role || run.spec_drift)) {
    lines.push('', '## Staged contract', '')
    if (definition.benchmark) {
      lines.push(`- datasets: ${definition.benchmark.datasets.join(', ')}`)
      lines.push(`- splits: ${definition.benchmark.splits.join(', ')}`)
      lines.push(`- baseline arm: ${definition.benchmark.baseline_arm}`)
      lines.push(`- task rules: ${definition.benchmark.task_rules.join('; ')}`)
    }
    if (definition.protocol) lines.push(`- protocol: ${definition.protocol.eval_script} + metric parameters`)
    for (const run of runs.filter((entry) => entry.role || entry.spec_drift)) {
      lines.push(`- ${run.run_id}: ${run.role || 'unstaged'}${run.baseline_ref ? ` / ${run.baseline_ref}` : ''}${run.stage ? ` / ${run.stage}` : ''}${run.protocol_digest ? ` · ${run.protocol_digest.slice(0, 18)}…` : ''}${run.spec_drift?.state ? ` · ${run.spec_drift.state}${run.spec_drift.changed?.length ? ` (${run.spec_drift.changed.join(', ')})` : ''}` : ''}`)
    }
  }
  if (verdicts.length) {
    lines.push('', '## Verdicts', '', ...verdicts.map((verdict) => `- ${verdict.run_id}: ${verdict.verdict}${verdict.forced ? ` (requested ${verdict.requested_verdict}, forced)` : ''} — ${verdict.reason}`))
  }
  if (links.length) {
    lines.push('', '## Links', '', ...links.map((link) => `- ${link.run_id} → ${link.target.kind}:${link.target.id}${link.note ? ` (${link.note})` : ''}`))
  }
  lines.push('', 'Logged runs and metrics as recorded. No metric here is a scientific claim, and missing values stay blank.', '')
  return lines.join('\n')
}

function runsMlflow(definition, runs, verdicts = []) {
  const latest = new Map(verdicts.map((verdict) => [verdict.run_id, verdict]))
  return {
    experiment: { experiment_id: definition.slug, name: definition.name, tags: { question: definition.question } },
    runs: runs.map((run) => ({
      info: {
        run_id: run.run_id,
        run_uuid: run.run_id,
        experiment_id: definition.slug,
        start_time: new Date(run.ts).getTime() * 1000,
        status: 'FINISHED',
      },
      data: {
        tags: {
          ...Object.fromEntries(Object.entries(run.params || {}).map(([key, value]) => [`param:${key}`, String(value)])),
          ...(run.seed != null ? { seed: String(run.seed) } : {}),
          ...(run.role ? { role: run.role, baseline_ref: run.baseline_ref ?? '', stage: run.stage ?? '', protocol_digest: run.protocol_digest ?? '' } : {}),
          ...(run.spec_drift?.state ? { spec_drift: run.spec_drift.state } : {}),
          ...(latest.get(run.run_id) ? { verdict: latest.get(run.run_id).verdict } : {}),
        },
        params: Object.fromEntries(Object.entries(run.params || {}).map(([key, value]) => [key, String(value)])),
        metrics: Object.entries(run.metrics || {}).map(([key, value]) => ({ key, value, timestamp: new Date(run.ts).getTime() * 1000 })),
        artifacts: (run.artifacts || []).map((entry) => ({ path: entry.path, tags: [] })),
      },
    })),
  }
}

export function exportExperiment({ cwd, slug: slugValue, format = 'markdown', overwrite = false }) {
  const f = files(cwd, slugValue)
  const definition = readExperiment(cwd, slugValue)
  const runs = readJsonl(f.runs)
  const links = readJsonl(f.links)
  const verdicts = readJsonl(f.verdicts)
  const wanted = text(format).toLowerCase()
  if (!EXPERIMENT_EXPORT_FORMATS.includes(wanted)) {
    throw new Error(`format must be one of ${EXPERIMENT_EXPORT_FORMATS.join(', ')}`)
  }
  let name
  let body
  if (wanted === 'csv') {
    name = 'runs.csv'
    body = runsCsv(definition, runs, verdicts)
  } else if (wanted === 'json') {
    name = 'experiment.json'
    body = `${JSON.stringify({ experiment: definition, runs, links, verdicts }, null, 2)}\n`
  } else if (wanted === 'mlflow') {
    name = 'mlflow.json'
    body = `${JSON.stringify(runsMlflow(definition, runs, verdicts), null, 2)}\n`
  } else {
    name = 'report.md'
    body = runsMarkdown(definition, runs, links, verdicts)
  }
  const written = exportText(join(f.exports, name), body, { overwrite })
  return { format: wanted, path: written.path.slice(cwd.length + 1), bytes: written.bytes }
}
