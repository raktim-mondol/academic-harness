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
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import {
  appendJsonl, csvCell, ensureDir, exportText, hashFile, mdCell, nowIso,
  readJson, readJsonl, sha256, slug as slugify, stableStringify, writeOnceJson,
} from './ledger-kit.js'
import { withLock } from './store-lock.js'
import { resolveWorkspacePath } from './workspace-path.js'
import { excludedAnalysisRunIndex, hasAnalysisRun, listAnalysisRuns } from './analysis-store.js'

export const EXPERIMENT_DIRECTIONS = ['higher', 'lower']
export const EXPERIMENT_EXPORT_FORMATS = ['csv', 'json', 'markdown', 'mlflow']
export const EXPERIMENT_BRANCH_FORMATS = ['text', 'json', 'mermaid']
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

// Comparison identities are user declarations, not verification of the data.
// The hash covers the entire normalized identity, including protocol and metric
// definitions. Missing metadata is never inferred from the experiment name.
function comparisonIdentity(input, definition, { stage, sampling, protocol, baselineRef }) {
  if (input == null) return null
  const value = objectValue(input, 'comparison_identity')
  if (!stage || !protocol || !baselineRef) throw new Error('comparison_identity requires a staged run with protocol and baseline_ref')
  const declaredText = (value) => typeof value === 'string' ? value.trim() : ''
  const identityPart = (part, name) => {
    const obj = objectValue(part, `comparison_identity.${name}`)
    const id = declaredText(obj.id)
    const version = declaredText(obj.version_or_hash)
    if (!id || !version) throw new Error(`comparison_identity.${name} requires id and version_or_hash`)
    return { id, version_or_hash: version }
  }
  const dataset = identityPart(value.dataset, 'dataset')
  const split = identityPart(value.split, 'split')
  if (!definition.benchmark.datasets.includes(dataset.id) || !definition.benchmark.splits.includes(split.id)) {
    throw new Error('comparison_identity dataset and split must be declared in the benchmark')
  }
  const cohort = declaredText(value.baseline_cohort_id)
  if (!cohort) throw new Error('comparison_identity.baseline_cohort_id is required')
  const suppliedMetrics = objectValue(value.metric_definitions, 'comparison_identity.metric_definitions')
  const metricDefinitions = Object.create(null)
  for (const metric of definition.metrics) {
    const spec = objectValue(suppliedMetrics[metric.name], `metric_definitions.${metric.name}`)
    const unit = declaredText(spec.unit)
    const implementation = declaredText(spec.implementation)
    if (!unit || !implementation || spec.parameters == null) throw new Error(`metric_definitions.${metric.name} requires unit, implementation, and parameters`)
    metricDefinitions[metric.name] = { name: metric.name, direction: metric.direction, unit, implementation, parameters: objectValue(spec.parameters, `metric_definitions.${metric.name}.parameters`) }
  }
  const identity = {
    version: 1, dataset, split, stage,
    sampling: stage === 'full' ? { kind: 'full', rule: sampling } : { kind: stage, rule: sampling },
    protocol_digest: protocol.protocol_digest,
    baseline_ref: baselineRef, baseline_cohort_id: cohort,
    metric_definitions: metricDefinitions,
  }
  return { ...identity, scope_id: `sha256:${sha256(stableStringify(identity))}`, provenance: 'user_declared' }
}

function identityWithoutProtocol(identity) {
  if (!identity) return null
  const { scope_id, protocol_digest, provenance, ...rest } = identity
  return rest
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
  comparison = null,
  baselineRunId = null,
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
  const identity = comparisonIdentity(comparison, definition, { stage: stageValue, sampling: samplingValue, protocol: proto, baselineRef: baselineRefValue })

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
      const baselineId = text(baselineRunId)
      if (!baselineId) throw new Error('a staged variant requires an explicit baseline_run_id')
      baseline = runs.find((run) => run.run_id === baselineId)
      if (!baseline || baseline.role !== 'baseline' || baseline.baseline_ref !== baselineRefValue || !baseline.protocol_digest) {
        throw new Error(`baseline_run_id "${baselineId}" must name a baseline with baseline_ref "${baselineRefValue}" and a protocol_digest`)
      }
      if (baseline.stage !== stageValue || stableStringify(baseline.sampling ?? null) !== stableStringify(samplingValue)) {
        throw new Error('baseline_run_id must have the same stage and sampling rule as the variant')
      }
      if (identity && (!baseline.comparison_identity || stableStringify(identityWithoutProtocol(identity)) !== stableStringify(identityWithoutProtocol(baseline.comparison_identity)))) {
        throw new Error('baseline_run_id has missing or incompatible comparison_identity')
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
      comparison_identity: identity,
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

/** One eligibility policy for comparisons, rankings and exports. */
export function experimentEligibility(cwd, slugValue, scopeId = null) {
  const definition = readExperiment(cwd, slugValue)
  const runs = listExperimentRuns(cwd, slugValue)
  const compliance = experimentCompliance(cwd, slugValue)
  const unresolved = new Set(compliance.unresolved.map((entry) => entry.run_id))
  const badExecution = new Set()
  for (const link of listExperimentLinks(cwd, slugValue)) {
    const target = linkedAnalysisRun(link)
    if (!target) continue
    const root = join(cwd, '.dsh', 'analysis')
    const slugs = target.slug ? [target.slug] : existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : []
    const matches = slugs.flatMap((slug) => listAnalysisRuns(cwd, slug).filter((run) => run.run_id === target.run_id))
    if (matches.length !== 1) unresolved.add(link.run_id)
    else if (matches[0].exit_code !== 0 || matches[0].timed_out || matches[0].spawn_error) badExecution.add(link.run_id)
  }
  const byId = new Map(runs.map((run) => [run.run_id, run]))
  const assessments = runs.map((run) => {
    const identity = run.comparison_identity
    const reasons = []
    let state = 'comparable'
    if (compliance.excluded.has(run.run_id)) {
      state = 'excluded'
      reasons.push('compliance_violation')
    } else if (unresolved.has(run.run_id)) {
      state = 'not_checked'
      reasons.push('unresolved_analysis_link')
    } else if (badExecution.has(run.run_id)) {
      state = 'not_checked'
      reasons.push('linked_analysis_failed')
    } else if (!identity || identity.version !== 1 || !identity.scope_id) {
      state = 'not_checked'
      reasons.push('comparison_identity_missing_or_unsupported')
    } else {
      const { scope_id, provenance, ...body } = identity
      const validIdentity = identity.dataset?.id && identity.dataset?.version_or_hash && identity.split?.id && identity.split?.version_or_hash && identity.baseline_cohort_id && identity.sampling && definition.metrics.length && definition.metrics.every((metric) => {
        const item = identity.metric_definitions?.[metric.name]
        return item?.name === metric.name && item.direction === metric.direction && item.unit && item.implementation && item.parameters && typeof item.parameters === 'object' && !Array.isArray(item.parameters)
      })
      if (!validIdentity || !['baseline', 'variant'].includes(run.role) || !['subset', 'slice', 'full'].includes(run.stage) || scope_id !== `sha256:${sha256(stableStringify(body))}` || identity.stage !== run.stage || identity.protocol_digest !== run.protocol_digest || identity.baseline_ref !== run.baseline_ref || stableStringify(identity.sampling.rule) !== stableStringify(run.sampling ?? null)) {
        state = 'not_checked'
        reasons.push('comparison_identity_invalid')
      } else if (run.spec_drift?.state === 'drift') {
        state = 'incompatible'
        reasons.push('protocol_drift')
      } else if (run.role === 'variant' && (!byId.has(run.baseline_run_id) || byId.get(run.baseline_run_id).role !== 'baseline' || byId.get(run.baseline_run_id).comparison_identity?.scope_id !== scope_id || compliance.excluded.has(run.baseline_run_id) || unresolved.has(run.baseline_run_id) || badExecution.has(run.baseline_run_id))) {
        state = 'not_checked'
        reasons.push('baseline_identity_unresolved')
      } else if (scopeId && scope_id !== scopeId) {
        state = 'incompatible'
        reasons.push('different_scope')
      }
    }
    return { run_id: run.run_id, scope_id: identity?.scope_id ?? null, state, reasons }
  })
  // A variant cannot be ranked when its named baseline itself failed identity
  // validation, even if the stale scope_id strings happen to match.
  const assessmentById = new Map(assessments.map((entry) => [entry.run_id, entry]))
  for (const run of runs) {
    const assessment = assessmentById.get(run.run_id)
    if (run.role === 'variant' && assessment?.state === 'comparable' && assessmentById.get(run.baseline_run_id)?.state !== 'comparable') {
      assessment.state = 'not_checked'
      assessment.reasons.push('baseline_not_comparable')
    }
  }
  const scopes = [...new Set(assessments.filter((a) => a.state === 'comparable').map((a) => a.scope_id))].sort()
  const includedIds = new Set(assessments.filter((a) => a.state === 'comparable').map((a) => a.run_id))
  return { scope_id: scopeId || null, scopes, assessments, compliance, included: scopeId ? runs.filter((run) => includedIds.has(run.run_id)) : [] }
}

export function compareExperiments(cwd, slugValue, { field = null, scopeId = null } = {}) {
  const definition = readExperiment(cwd, slugValue)
  const runs = listExperimentRuns(cwd, slugValue)
  if (!runs.length) return { experiment: definition, runs: [], metrics: [], best: {}, note: 'No runs logged yet.' }
  const latest = latestVerdicts(cwd, slugValue)
  const eligibility = experimentEligibility(cwd, slugValue, scopeId)
  const { compliance } = eligibility
  const eligible = eligibility.included
  const metrics = metricNames(definition, runs)
  const directions = Object.fromEntries(definition.metrics.map((entry) => [entry.name, entry.direction || 'higher']))
  const best = {}
  for (const name of definition.metrics.map((metric) => metric.name)) {
    const winner = bestRun(eligible, name, directions[name])
    if (winner) best[name] = { run_id: winner.run_id, value: winner.metrics[name], direction: directions[name] || 'higher' }
  }
  let grouped = null
  if (field) {
    const groups = new Map()
    for (const run of eligible) {
      const key = run.params?.[field]
      const label = key == null ? '(missing)' : String(key)
      if (!groups.has(label)) groups.set(label, [])
      groups.get(label).push(run)
    }
    grouped = [...groups.entries()].map(([label, members]) => ({
      value: label,
      runs: members.length,
      best: Object.fromEntries(definition.metrics.map((metric) => metric.name).flatMap((name) => {
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
      comparison_identity: run.comparison_identity ?? null,
      spec_drift: run.spec_drift ?? null,
      verdict: latest.get(run.run_id) ?? null,
      artifact_count: run.artifacts.length,
      excluded: compliance.excluded.get(run.run_id) ?? null,
    })),
    best,
    grouped,
    comparison_scope: { scope_id: scopeId || null, available_scopes: eligibility.scopes, scope_details: eligibility.scopes.map((id) => runs.find((run) => run.comparison_identity?.scope_id === id)?.comparison_identity), assessments: eligibility.assessments, note: scopeId ? 'Matching declared identities are not scientific verification.' : 'No ranking without an explicit scope_id; legacy runs remain visible.' },
    compliance: {
      excluded_run_ids: compliance.excluded_run_ids,
      details: compliance.details,
      note: 'Runs linked to a compliance-violating analysis_run are excluded from best and grouping; they remain listed with their exclusion.',
    },
  }
}

/** Descriptive only: no inference or automatic selection. */
function replicateStatistics(values) {
  const n = values.length
  if (!n) return { n, mean: null, mean_state: 'not_checked', mean_reason: 'no eligible values', sample_sd: null, sd_state: 'not_checked', sd_reason: 'at least two values are required' }
  // Scaling keeps intermediate sums finite for most extreme but valid numbers.
  const scale = values.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0)
  const normalized = scale === 0 ? values.map(() => 0) : values.map((value) => value / scale)
  const center = normalized.reduce((sum, value) => sum + value, 0) / n
  const mean = center * scale
  const sd = n < 2 ? null : Math.sqrt(normalized.reduce((sum, value) => sum + (value - center) ** 2, 0) / (n - 1)) * scale
  return {
    n,
    mean: Number.isFinite(mean) ? mean : null,
    mean_state: Number.isFinite(mean) ? 'computed' : 'not_checked',
    mean_reason: Number.isFinite(mean) ? null : 'numeric overflow',
    sample_sd: sd != null && Number.isFinite(sd) ? sd : null,
    sd_state: sd != null && Number.isFinite(sd) ? 'computed' : 'not_checked',
    sd_reason: n < 2 ? 'at least two values are required' : Number.isFinite(sd) ? null : 'numeric overflow',
  }
}

/** Read-only repeated-run and paired-seed summary over a declared scope. */
export function summarizeExperimentReplicates(cwd, slugValue, options = {}) {
  const definition = readExperiment(cwd, slugValue)
  const scopeId = text(options.scopeId)
  const metricName = text(options.metric)
  const field = text(options.candidateField)
  const unit = text(options.replicateUnit)
  if (!scopeId) throw new Error('replicates requires scope_id')
  if (!metricName) throw new Error('replicates requires metric')
  const metric = definition.metrics.find((entry) => entry.name === metricName)
  if (!metric?.direction) throw new Error('replicates requires a declared metric with a direction')
  if (!field) throw new Error('replicates requires candidate_field')
  if (!unit) throw new Error('replicates requires replicate_unit describing the independent unit')
  const candidates = stringList(options.candidates, 'candidates', { required: true })
  if (new Set(options.candidates).size !== options.candidates.length || candidates.length !== options.candidates.length) throw new Error('candidates must contain unique non-empty strings')
  const baseline = text(options.baselineCandidate) || null
  if (baseline && !candidates.includes(baseline)) throw new Error('baseline_candidate must be listed in candidates')
  const expectedInput = options.expectedSeeds
  const unknown = options.coverageUnknown === true
  if (unknown === (expectedInput != null)) throw new Error('provide expected_seeds or set coverage_unknown: true, but not both')
  let expected = null
  if (expectedInput != null) {
    if (!Array.isArray(expectedInput) || !expectedInput.length || expectedInput.some((seed) => typeof seed !== 'number' || !Number.isFinite(seed)) || new Set(expectedInput).size !== expectedInput.length) {
      throw new Error('expected_seeds must be a non-empty array of unique finite numbers')
    }
    expected = [...expectedInput].sort((a, b) => a - b)
  }
  const history = text(options.selectionHistory) || 'unknown'
  if (!['unknown', 'exploratory', 'declared_preplanned'].includes(history)) throw new Error('selection_history must be unknown, exploratory, or declared_preplanned')
  const runs = listExperimentRuns(cwd, slugValue)
  if (!runs.some((run) => run.comparison_identity?.scope_id === scopeId)) throw new Error('scope_id is not recorded in this experiment')
  const eligibility = experimentEligibility(cwd, slugValue, scopeId)
  const assessmentById = new Map(eligibility.assessments.map((entry) => [entry.run_id, entry]))
  const expectedSet = expected ? new Set(expected) : null
  const groups = candidates.map((candidate) => {
    const members = runs.filter((run) => run.params?.[field] === candidate).sort((a, b) => a.run_id.localeCompare(b.run_id))
    const scoped = members.filter((run) => run.comparison_identity?.scope_id === scopeId)
    const roleValues = new Set(scoped.map((run) => run.role ?? null))
    const roles = [...roleValues].filter(Boolean).sort()
    const seedCounts = new Map()
    for (const run of scoped) {
      if (typeof run.seed === 'number' && Number.isFinite(run.seed)) seedCounts.set(run.seed, (seedCounts.get(run.seed) || 0) + 1)
    }
    const duplicates = [...seedCounts.entries()].filter(([, count]) => count > 1).map(([seed]) => ({ seed, run_ids: scoped.filter((run) => run.seed === seed).map((run) => run.run_id) })).sort((a, b) => a.seed - b.seed)
    const rows = members.map((run) => {
      const assessment = assessmentById.get(run.run_id)
      const reasons = [...(assessment?.reasons || [])]
      const seed = typeof run.seed === 'number' && Number.isFinite(run.seed) ? run.seed : null
      const raw = run.metrics?.[metricName]
      const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
      if (roleValues.size > 1 && run.comparison_identity?.scope_id === scopeId) reasons.push('mixed_candidate_roles')
      if (seed == null) reasons.push('seed_missing_or_invalid')
      if (seed != null && (seedCounts.get(seed) || 0) > 1 && run.comparison_identity?.scope_id === scopeId) reasons.push('duplicate_seed')
      if (seed != null && expectedSet && !expectedSet.has(seed) && run.comparison_identity?.scope_id === scopeId) reasons.push('unexpected_seed')
      if (raw == null) reasons.push('metric_missing')
      else if (value == null) reasons.push('metric_nonfinite_or_invalid')
      const included = assessment?.state === 'comparable' && reasons.length === 0
      return { run_id: run.run_id, role: run.role ?? null, seed, value, baseline_run_id: run.baseline_run_id ?? null, params: run.params || {}, scope_id: run.comparison_identity?.scope_id ?? null, eligibility: assessment?.state || 'not_checked', included, reasons }
    })
    const included = rows.filter((row) => row.included)
    const observed = [...seedCounts.keys()].sort((a, b) => a - b)
    const eligibleSeeds = new Set(included.map((row) => row.seed))
    const countReason = (reason) => rows.filter((row) => row.reasons.includes(reason)).length
    const eligibilityCounts = {}
    for (const row of rows) eligibilityCounts[row.eligibility] = (eligibilityCounts[row.eligibility] || 0) + 1
    return {
      candidate, roles, runs: rows,
      counts: {
        runs: rows.length, included: included.length, excluded: rows.length - included.length,
        eligibility: eligibilityCounts,
        missing_metric: countReason('metric_missing'), nonfinite_metric: countReason('metric_nonfinite_or_invalid'),
        missing_or_invalid_seed: countReason('seed_missing_or_invalid'), duplicate_seed: countReason('duplicate_seed'), unexpected_seed: countReason('unexpected_seed'),
        linked_analysis_failed: countReason('linked_analysis_failed'),
      },
      seed_coverage: { state: expected ? 'declared' : 'unknown', expected, observed, missing: expected ? expected.filter((seed) => !eligibleSeeds.has(seed)) : null, unexpected: expected ? observed.filter((seed) => !expectedSet.has(seed)) : null, duplicates },
      included_run_ids: included.map((row) => row.run_id),
      excluded_run_ids: rows.filter((row) => !row.included).map((row) => row.run_id),
      statistics: replicateStatistics(included.map((row) => row.value)),
    }
  })
  const baseGroup = groups.find((group) => group.candidate === baseline)
  for (const group of groups) {
    if (!baseline || group.candidate === baseline) {
      group.paired = { state: 'not_checked', reason: baseline ? 'baseline group' : 'baseline_candidate not provided', pairs: [], unpaired: [], unpaired_baselines: [], statistics: replicateStatistics([]) }
      continue
    }
    if (baseGroup.roles.length !== 1 || baseGroup.roles[0] !== 'baseline' || group.roles.length !== 1 || group.roles[0] !== 'variant') {
      group.paired = { state: 'not_checked', reason: 'pairing requires one baseline role and one variant role', pairs: [], unpaired: group.runs.map((row) => ({ run_id: row.run_id, reason: 'candidate roles missing or ambiguous' })), unpaired_baselines: (baseGroup?.runs || []).map((row) => ({ run_id: row.run_id, reason: 'candidate roles missing or ambiguous' })), statistics: replicateStatistics([]) }
      continue
    }
    const baselineById = new Map(baseGroup.runs.map((row) => [row.run_id, row]))
    const pairs = []
    const unpaired = []
    for (const row of group.runs) {
      const reference = baselineById.get(row.baseline_run_id)
      if (!row.included || !reference?.included || row.seed !== reference.seed) {
        unpaired.push({ run_id: row.run_id, baseline_run_id: row.baseline_run_id, reason: !row.included ? 'variant_not_included' : !reference ? 'declared_baseline_not_in_candidate' : !reference.included ? 'baseline_not_included' : 'seed_mismatch' })
        continue
      }
      const delta = row.value - reference.value
      if (!Number.isFinite(delta)) {
        unpaired.push({ run_id: row.run_id, baseline_run_id: reference.run_id, reason: 'difference_overflow' })
        continue
      }
      pairs.push({ seed: row.seed, variant_run_id: row.run_id, baseline_run_id: reference.run_id, variant_value: row.value, baseline_value: reference.value, difference: delta })
    }
    pairs.sort((a, b) => a.seed - b.seed || a.variant_run_id.localeCompare(b.variant_run_id))
    const pairedBaselineIds = new Set(pairs.map((pair) => pair.baseline_run_id))
    const unpairedBaselines = baseGroup.runs.filter((row) => !pairedBaselineIds.has(row.run_id)).map((row) => ({ run_id: row.run_id, reason: row.included ? 'no_matched_variant' : 'baseline_not_included' }))
    group.paired = { state: pairs.length ? 'computed' : 'not_checked', reason: pairs.length ? null : 'no unambiguous eligible pairs', pairs, unpaired, unpaired_baselines: unpairedBaselines, statistics: replicateStatistics(pairs.map((pair) => pair.difference)) }
  }
  const ungrouped = runs.filter((run) => run.comparison_identity?.scope_id === scopeId && !candidates.includes(run.params?.[field])).map((run) => ({ run_id: run.run_id, candidate_value: run.params?.[field] ?? null, reason: 'candidate_not_selected_or_missing' })).sort((a, b) => a.run_id.localeCompare(b.run_id))
  return {
    experiment: definition.slug, scope_id: scopeId, comparison_identity: (eligibility.included[0] || runs.find((run) => run.comparison_identity?.scope_id === scopeId))?.comparison_identity ?? null, metric: metricName, direction: metric.direction,
    candidate_field: field, candidates, baseline_candidate: baseline, replicate_unit: unit,
    selection_history: { value: history, provenance: 'user_declared', note: history === 'unknown' ? 'Selection history is unknown.' : history === 'exploratory' ? 'Exploratory selection; these summaries are descriptive.' : 'Preplanned status is user-declared, not verified.' },
    groups, ungrouped,
    notes: ['Candidate grouping, scope, independent unit, and selection history are user declarations, not verification.', 'Repeated seeds are not necessarily independent, and equal seeds do not prove identical random streams.', 'Duplicate seeds, failed or excluded runs, missing metrics, and unexpected seeds are not silently averaged.', 'Differences are variant minus its explicitly linked baseline; no confidence interval, p-value, or winner is computed.'],
  }
}

export function bestExperimentRun(cwd, slugValue, { metric, direction = null, scopeId = null } = {}) {
  const definition = readExperiment(cwd, slugValue)
  const name = text(metric)
  if (!name) throw new Error('best requires a named metric (there is no implicit best model)')
  const declared = definition.metrics.find((entry) => entry.name === name)
  if (!scopeId) throw new Error('best requires an explicit scope_id; use compare to inspect available scopes')
  if (!declared) throw new Error(`metric "${name}" must be declared in the experiment`)
  if (direction && declared.direction && text(direction).toLowerCase() !== declared.direction) throw new Error('direction cannot override the declared metric direction')
  const wanted = text(direction).toLowerCase() || declared?.direction
  if (!wanted) {
    throw new Error(`metric "${name}" has no direction; pass direction: higher|lower explicitly`)
  }
  if (!EXPERIMENT_DIRECTIONS.includes(wanted)) throw new Error(`direction must be one of ${EXPERIMENT_DIRECTIONS.join(', ')}`)
  const runs = listExperimentRuns(cwd, slugValue)
  const eligibility = experimentEligibility(cwd, slugValue, scopeId)
  const { compliance } = eligibility
  const eligible = eligibility.included
  const winner = bestRun(eligible, name, wanted)
  if (!winner) {
    const excludedCount = runs.filter((run) => compliance.excluded.has(run.run_id) && run.metrics[name] != null).length
    throw new Error(`no run records metric "${name}" among eligible runs${excludedCount ? ` (${excludedCount} excluded by compliance)` : ''}`)
  }
  const tied = eligible.filter((run) => run.metrics[name] === winner.metrics[name])
  return {
    metric: name,
    direction: wanted,
    comparison_scope: { scope_id: scopeId, assessments: eligibility.assessments },
    run: winner,
    tied_runs: tied.map((run) => run.run_id),
    excluded_run_ids: compliance.excluded_run_ids.filter((runId) => runs.some((run) => run.run_id === runId && run.metrics[name] != null)),
  }
}

/**
 * Pareto dominance over the declared metrics. A run is complete only when every
 * declared metric is present; a run with a missing metric is listed as
 * incomplete rather than guessed. Ties are not dominance, so both stay on the
 * front. This is the plugin's specification of the paper's undefined
 * "preferred" gate, not a scientific claim.
 */
export function dominanceExperiment(cwd, slugValue, { scopeId = null } = {}) {
  const definition = readExperiment(cwd, slugValue)
  const runs = listExperimentRuns(cwd, slugValue)
  if (!definition.metrics.length) throw new Error('dominance needs at least one declared metric')
  const missingDirection = definition.metrics.filter((metric) => !metric.direction)
  if (missingDirection.length) {
    throw new Error(`dominance needs a direction for every metric; missing: ${missingDirection.map((metric) => metric.name).join(', ')}`)
  }
  if (!scopeId) throw new Error('dominance requires an explicit scope_id; use compare to inspect available scopes')
  const eligibility = experimentEligibility(cwd, slugValue, scopeId)
  const { compliance } = eligibility
  const eligible = eligibility.included
  const complete = []
  const incomplete = []
  for (const run of eligible) {
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
    comparison_scope: { scope_id: scopeId, assessments: eligibility.assessments },
    front: front.map((run) => ({
      run_id: run.run_id,
      role: run.role ?? null,
      stage: run.stage ?? null,
      metrics: run.metrics,
      dominated_run_ids: complete.filter((other) => other.run_id !== run.run_id && dominates(run, other)).map((other) => other.run_id),
    })),
    dominated: dominated.map((run) => run.run_id),
    incomplete,
    excluded: compliance.details,
    relations: relations.slice(0, 100),
    note: 'Pareto front over declared metrics and directions: a run dominates only when it is at least as good on every declared metric and strictly better on one. Runs missing a declared metric are incomplete and not ranked; runs linked to a compliance-violating analysis are excluded. No run here is a scientific claim.',
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

function linkedAnalysisRun(link) {
  if (link?.target?.kind !== 'analysis_run') return null
  const raw = text(link.target.id)
  if (!raw) return null
  const parts = raw.split(/[:/]/).filter(Boolean)
  const run_id = parts.at(-1) || null
  if (!run_id) return null
  // `slug:run_id` and `.dsh/analysis/<slug>/runs/<id>` both name the owning
  // ledger; a bare run id does not, and is matched across slugs.
  const marker = parts.lastIndexOf('analysis')
  const slug = marker >= 0 && parts[marker + 1] && parts[marker + 2] === 'runs'
    ? parts[marker + 1]
    : parts.length > 1 && parts[0] !== run_id && parts[0] !== 'analysis' ? parts[0] : null
  return { slug, run_id }
}

/**
 * An experiment run inherits a compliance exclusion from any analysis_run it
 * links to. The analysis ledger owns the rule evaluation; this is a ledger join,
 * not a second compliance implementation.
 *
 * The violation is cited from the violating reading, and every violated link is
 * kept: a run tied to two bad analyses does not lose one of them. The exclusion
 * index is only read when a link exists, so an experiment with no analysis link
 * never depends on any other ledger. A link naming a run that does not exist is
 * reported instead of silently granting eligibility.
 */
export function experimentCompliance(cwd, slugValue) {
  const excluded = new Map()
  const unresolved = []
  const links = []
  for (const link of listExperimentLinks(cwd, slugValue)) {
    const analysis = linkedAnalysisRun(link)
    if (analysis) links.push({ experiment_run_id: link.run_id, slug: analysis.slug, analysis_run_id: analysis.run_id })
  }
  if (!links.length) return { excluded, excluded_run_ids: [], details: [], unresolved, analysis_links: 0 }
  const index = excludedAnalysisRunIndex(cwd, { targets: links })
  for (const link of links) {
    const hit = index.by_run.get(link.analysis_run_id)
    const entry = hit && (!link.slug || hit.slug === link.slug) ? hit : null
    if (entry) {
      const violated = (entry.compliance?.rules || []).filter((rule) => rule.status === 'violated').map((rule) => rule.rule_id)
      const prior = excluded.get(link.experiment_run_id)
      if (prior) {
        prior.violated = [...new Set([...prior.violated, ...violated])]
        prior.analysis_run_ids.push(link.analysis_run_id)
        prior.compliance_ids.push(entry.compliance?.compliance_id ?? null)
      } else {
        excluded.set(link.experiment_run_id, {
          analysis_slug: entry.slug,
          analysis_run_id: link.analysis_run_id,
          analysis_run_ids: [link.analysis_run_id],
          compliance_id: entry.compliance?.compliance_id ?? null,
          compliance_ids: [entry.compliance?.compliance_id ?? null],
          violated,
        })
      }
      continue
    }
    if (!hasAnalysisRun(cwd, link.slug, link.analysis_run_id)) {
      unresolved.push({
        run_id: link.experiment_run_id,
        analysis_slug: link.slug ?? null,
        analysis_run_id: link.analysis_run_id,
        reason: 'no such analysis run, so no compliance exclusion can apply',
      })
    }
  }
  return {
    excluded,
    excluded_run_ids: [...excluded.keys()],
    details: [...excluded.entries()].map(([runId, entry]) => ({ run_id: runId, ...entry })),
    unresolved,
    analysis_links: links.length,
  }
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

/* --------------------------------------------------------------- branch view */

const BRANCH_DEFAULTS = { maxNodes: 500, maxEdges: 1000, maxLinksPerRun: 50 }
const BRANCH_MAX = { maxNodes: 5000, maxEdges: 10000, maxLinksPerRun: 500 }
const BRANCH_SCAN_FILES = 200
const BRANCH_SCAN_LINES = 5000

function boundedInteger(value, name, fallback, maximum) {
  if (value == null || value === '') return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`)
  }
  return number
}

function relativePath(cwd, file) {
  return file.startsWith(cwd) ? file.slice(cwd.length).replace(/^[/\\]/, '') : file
}

function readFileSnapshot(file) {
  if (!existsSync(file)) return { exists: false, sha256: null, bytes: 0, text: null }
  const raw = readFileSync(file, 'utf8')
  return { exists: true, sha256: `sha256:${sha256(raw)}`, bytes: Buffer.byteLength(raw), text: raw }
}

/** Parse JSONL without hiding a corrupt line; the branch view reports it. */
function readJsonlSnapshot(file) {
  const snapshot = readFileSnapshot(file)
  const rows = []
  const corrupt = []
  if (snapshot.exists) {
    snapshot.text.split('\n').forEach((line, index) => {
      if (!line.trim()) return
      try {
        const value = JSON.parse(line)
        if (value && typeof value === 'object' && !Array.isArray(value)) rows.push(value)
        else corrupt.push({ line: index + 1, reason: 'line is not a JSON object' })
      } catch (error) {
        corrupt.push({ line: index + 1, reason: error instanceof Error ? error.message : String(error) })
      }
    })
  }
  return { ...snapshot, rows, corrupt }
}

function snapshotEntry(cwd, file, snapshot) {
  return {
    path: relativePath(cwd, file),
    exists: snapshot.exists,
    sha256: snapshot.sha256,
    bytes: snapshot.bytes,
    corrupt_lines: snapshot.corrupt?.length ?? 0,
  }
}

function scanJsonlId(file, id, maxLines = BRANCH_SCAN_LINES) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { state: 'unreadable' }
  }
  const lines = raw.split('\n')
  for (let index = 0; index < lines.length && index < maxLines; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row === 'object' && String(row.id ?? '') === id) return { state: 'found', row, line: index + 1 }
    } catch {
      // A corrupt line does not hide a later matching entry.
    }
  }
  return { state: lines.length > maxLines ? 'truncated' : 'not_found' }
}

function analysisResolution(cwd, slug, run) {
  const manifest = join(cwd, '.dsh', 'analysis', slug, 'runs', run.run_id, 'manifest.json')
  return {
    state: 'resolved',
    reason: 'the linked analysis run exists',
    analysis_slug: slug,
    analysis_run_id: run.run_id,
    exit_code: run.exit_code ?? null,
    timed_out: Boolean(run.timed_out),
    spawn_error: run.spawn_error ?? null,
    signal: run.signal ?? null,
    duration_ms: run.duration_ms ?? null,
    ts: run.ts ?? null,
    plan_hash: run.plan_hash ?? null,
    plan_version: run.plan_version ?? null,
    manifest_path: relativePath(cwd, manifest),
    manifest_state: existsSync(manifest) ? 'present' : 'missing',
  }
}

function findAnalysisRun(cwd, targetId) {
  const parsed = linkedAnalysisRun({ target: { kind: 'analysis_run', id: targetId } })
  if (!parsed?.run_id) return { state: 'invalid', reason: 'the link target does not name an analysis run id' }
  if (parsed.slug) {
    let runs
    try {
      runs = listAnalysisRuns(cwd, parsed.slug)
    } catch (error) {
      return { state: 'unknown', reason: `cannot read analysis ledger "${parsed.slug}": ${error instanceof Error ? error.message : String(error)}`, analysis_slug: parsed.slug, analysis_run_id: parsed.run_id }
    }
    const hit = runs.find((run) => run.run_id === parsed.run_id)
    if (!hit) return { state: 'not_found', reason: `no analysis run "${parsed.run_id}" in analysis "${parsed.slug}"`, analysis_slug: parsed.slug, analysis_run_id: parsed.run_id }
    return analysisResolution(cwd, parsed.slug, hit)
  }
  const root = join(cwd, '.dsh', 'analysis')
  if (!existsSync(root)) return { state: 'not_found', reason: 'no analysis ledger exists in this workspace', analysis_run_id: parsed.run_id }
  let dirs
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch (error) {
    return { state: 'unknown', reason: `cannot list the analysis ledgers: ${error instanceof Error ? error.message : String(error)}`, analysis_run_id: parsed.run_id }
  }
  const matches = []
  for (const slug of dirs) {
    let runs
    try {
      runs = listAnalysisRuns(cwd, slug)
    } catch (error) {
      return { state: 'unknown', reason: `cannot read analysis ledger "${slug}": ${error instanceof Error ? error.message : String(error)}`, analysis_run_id: parsed.run_id }
    }
    const hit = runs.find((run) => run.run_id === parsed.run_id)
    if (hit) matches.push({ slug, run: hit })
  }
  if (matches.length === 1) return analysisResolution(cwd, matches[0].slug, matches[0].run)
  if (!matches.length) return { state: 'not_found', reason: `no analysis run "${parsed.run_id}" exists in this workspace`, analysis_run_id: parsed.run_id }
  return {
    state: 'ambiguous',
    reason: `analysis run "${parsed.run_id}" exists in ${matches.length} analysis ledgers; record the owning slug in the link id`,
    analysis_run_id: parsed.run_id,
    analysis_slugs: matches.map((match) => match.slug),
  }
}

function findNotebookEntry(cwd, id) {
  const root = join(cwd, '.dsh', 'notebook')
  if (!existsSync(root)) return { state: 'not_found', reason: 'no notebook ledger exists in this workspace' }
  let names
  try {
    names = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => entry.name).sort()
  } catch (error) {
    return { state: 'unknown', reason: `cannot list the notebook ledgers: ${error instanceof Error ? error.message : String(error)}` }
  }
  const matches = []
  let truncated = false
  for (const name of names.slice(0, BRANCH_SCAN_FILES)) {
    const result = scanJsonlId(join(root, name), id)
    if (result.state === 'found') matches.push({ file: relativePath(cwd, join(root, name)), row: result.row })
    if (result.state === 'truncated') truncated = true
  }
  if (matches.length === 1) {
    return {
      state: 'resolved',
      reason: 'the notebook entry exists',
      notebook_file: matches[0].file,
      entry_id: id,
      entry_type: text(matches[0].row.type) || null,
    }
  }
  if (matches.length > 1) return { state: 'ambiguous', reason: `notebook id "${id}" exists in ${matches.length} session notebooks` }
  if (truncated) return { state: 'not_checked', reason: 'the notebook scan limit was reached before the entry was found' }
  return { state: 'not_found', reason: `no notebook entry with id "${id}" exists in this workspace` }
}

function findReviewRecord(cwd, rawId) {
  const parts = rawId.split(/[:/]/).filter(Boolean)
  const id = parts.at(-1) || rawId
  const slugHint = parts.length > 1 ? parts[0] : null
  const root = join(cwd, '.dsh', 'review')
  if (!existsSync(root)) return { state: 'not_found', reason: 'no review ledger exists in this workspace' }
  let slugs
  try {
    slugs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch (error) {
    return { state: 'unknown', reason: `cannot list the review ledgers: ${error instanceof Error ? error.message : String(error)}` }
  }
  const wanted = slugHint ? slugs.filter((slug) => slug === slugHint) : slugs
  const matches = []
  for (const slug of wanted.slice(0, BRANCH_SCAN_FILES)) {
    const file = join(root, slug, 'records.jsonl')
    if (!existsSync(file)) continue
    const result = scanJsonlId(file, id)
    if (result.state === 'found') matches.push({ slug })
  }
  if (matches.length === 1) return { state: 'resolved', reason: 'the review record exists', review_slug: matches[0].slug, record_id: id }
  if (matches.length > 1) return { state: 'ambiguous', reason: `review record "${id}" exists in ${matches.length} review ledgers; record the review slug in the link id` }
  return { state: 'not_found', reason: `no review record with id "${id}" exists in this workspace${slugHint ? ` under review "${slugHint}"` : ''}` }
}

function findExperimentRun(cwd, rawId, currentSlug, byId) {
  const value = text(rawId)
  if (!value) return { state: 'invalid', reason: 'the link target does not name an experiment run id' }
  if (byId.has(value)) return { state: 'resolved', reason: 'the run exists in this experiment ledger', experiment_slug: currentSlug, run_id: value }
  const parts = value.split(/[:/]/).filter(Boolean)
  const runId = parts.at(-1) || value
  const marker = parts.lastIndexOf('experiments')
  const slug = marker >= 0 && parts[marker + 1] ? parts[marker + 1] : parts.length > 1 ? parts[0] : null
  if (slug && slug !== currentSlug) {
    let runs
    try {
      runs = listExperimentRuns(cwd, slug)
    } catch (error) {
      return { state: 'unknown', reason: `cannot read experiment ledger "${slug}": ${error instanceof Error ? error.message : String(error)}`, experiment_slug: slug, run_id: runId }
    }
    if (runs.some((run) => run.run_id === runId)) return { state: 'resolved', reason: 'the run exists in the named experiment ledger', experiment_slug: slug, run_id: runId }
    return { state: 'not_found', reason: `no experiment run "${runId}" in experiment "${slug}"`, experiment_slug: slug, run_id: runId }
  }
  if (byId.has(runId)) return { state: 'resolved', reason: 'the run exists in this experiment ledger', experiment_slug: currentSlug, run_id: runId }
  return {
    state: 'not_found',
    reason: `no experiment run "${value}" exists in experiment "${currentSlug}"; a cross-ledger link must name the owning slug`,
    experiment_slug: currentSlug,
    run_id: runId,
  }
}

function makeLinkResolver(cwd, currentSlug, byId) {
  const cache = new Map()
  return (kind, targetId) => {
    const key = `${kind}\0${targetId}\0${kind === 'experiment_run' ? currentSlug : ''}`
    if (cache.has(key)) return cache.get(key)
    let resolution
    switch (kind) {
      case 'analysis_run':
        resolution = findAnalysisRun(cwd, targetId)
        break
      case 'experiment_run':
        resolution = findExperimentRun(cwd, targetId, currentSlug, byId)
        break
      case 'notebook':
        resolution = findNotebookEntry(cwd, targetId)
        break
      case 'review':
        resolution = findReviewRecord(cwd, targetId)
        break
      case 'paper':
        resolution = { state: 'not_checked', reason: 'PaperMemory is not opened by this read-only view; the link is recorded but not resolved here' }
        break
      case 'scientific_result':
        resolution = { state: 'unknown', reason: 'scientific_result cards are not persisted, so this link has no ledger end' }
        break
      default:
        resolution = { state: 'unknown', reason: `link target kind "${kind}" is not resolvable here` }
        break
    }
    cache.set(key, resolution)
    return resolution
  }
}

function branchStatus(verdict, analysisLinks) {
  const resolved = analysisLinks.filter((link) => link.resolution.state === 'resolved')
  const failed = resolved.filter((link) => link.resolution.timed_out || link.resolution.spawn_error || (link.resolution.exit_code != null && link.resolution.exit_code !== 0))
  const unresolved = analysisLinks.filter((link) => link.resolution.state !== 'resolved')
  let executionState
  if (!analysisLinks.length) executionState = 'not_recorded'
  else if (failed.length) executionState = 'failed'
  else if (unresolved.length) executionState = 'unknown'
  else executionState = 'succeeded'
  let status
  let source
  let reason
  if (verdict?.verdict === 'bad') {
    status = 'pruned'
    source = 'verdict'
    reason = 'the latest recorded human verdict is bad'
  } else if (verdict?.verdict === 'engineer') {
    status = 'engineering'
    source = 'verdict'
    reason = 'the latest recorded human verdict is engineer'
  } else if (verdict?.verdict === 'good') {
    status = 'good'
    source = 'verdict'
    reason = 'the latest recorded human verdict is good'
  } else if (failed.length) {
    status = 'failed'
    source = 'linked_analysis_run'
    const details = failed.map((link) => {
      if (link.resolution.timed_out) return `${link.resolution.analysis_run_id} timed out`
      if (link.resolution.spawn_error) return `${link.resolution.analysis_run_id} failed to start`
      return `${link.resolution.analysis_run_id} exited ${link.resolution.exit_code ?? 'unknown'}`
    })
    reason = `linked analysis run recorded failure: ${details.join('; ')}`
  } else if (unresolved.length) {
    status = 'unknown'
    source = 'unresolved_link'
    reason = 'a linked analysis run could not be resolved, so execution status is unknown'
  } else {
    status = 'not_recorded'
    source = 'not_recorded'
    reason = 'no human verdict or linked execution failure is recorded'
  }
  return {
    status,
    status_source: source,
    status_reason: reason,
    execution: {
      state: executionState,
      analysis_run_ids: analysisLinks.map((link) => link.resolution.analysis_run_id ?? link.target.id),
      failed_run_ids: failed.map((link) => link.resolution.analysis_run_id ?? link.target.id),
      unresolved_run_ids: unresolved.map((link) => link.resolution.analysis_run_id ?? link.target.id),
      details: resolved.map((link) => ({
        analysis_slug: link.resolution.analysis_slug,
        analysis_run_id: link.resolution.analysis_run_id,
        exit_code: link.resolution.exit_code,
        timed_out: link.resolution.timed_out,
        spawn_error: link.resolution.spawn_error,
        manifest_path: link.resolution.manifest_path,
        manifest_state: link.resolution.manifest_state,
      })),
    },
  }
}

function mermaidLabel(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '<br/>')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .slice(0, 400)
}

function shortDigest(value) {
  const raw = String(value ?? '')
  return raw.length > 20 ? `${raw.slice(0, 18)}…` : raw
}

function branchNodeLabel(node) {
  const parts = [node.run_id]
  const staging = [node.role || 'unstaged', node.stage].filter(Boolean).join('/')
  if (staging) parts.push(staging)
  if (node.seed != null) parts.push(`seed ${node.seed}`)
  parts.push(`status: ${node.status}`)
  const metrics = Object.entries(node.metrics || {}).slice(0, 3).map(([name, value]) => `${name}=${value}`)
  if (metrics.length) parts.push(metrics.join(', '))
  if (node.scope_id) parts.push(`scope ${shortDigest(node.scope_id)}`)
  if (node.excluded) parts.push('EXCLUDED')
  if (node.spec_drift_state === 'drift') parts.push('SPEC DRIFT')
  if (node.verdict) parts.push(`verdict ${node.verdict.verdict}`)
  if (node.parent_state === 'missing') parts.push(`parent ${node.parent} missing`)
  else if (node.parent_state === 'self') parts.push('self-parent')
  else if (node.parent_state === 'invalid') parts.push('invalid parent')
  else if (node.parent_state === 'cycle') parts.push('parent cycle')
  else if (node.parent_state === 'truncated') parts.push(`parent ${node.parent} not shown`)
  return parts.join('\n')
}

function branchClass(node) {
  if (node.status === 'failed') return 'failed'
  if (node.status === 'pruned') return 'pruned'
  if (node.status === 'unknown') return 'unknown'
  if (node.status === 'engineering') return 'engineering'
  if (node.status === 'good') return 'good'
  return 'not_recorded'
}

/**
 * Read-only experiment branch view: parent ancestry plus recorded links,
 * verdicts, compliance exclusions, and linked analysis-run manifests.
 *
 * The view never executes anything and never writes unless `write: true` is
 * explicitly requested with Mermaid output. Source ledgers are read once into a
 * snapshot and hashed so a later ledger change is distinguishable.
 */
export function experimentBranches(cwd, slugValue, options = {}) {
  const f = files(cwd, slugValue)
  const definition = readExperiment(cwd, slugValue)
  const maxNodes = boundedInteger(options.maxNodes, 'max_nodes', BRANCH_DEFAULTS.maxNodes, BRANCH_MAX.maxNodes)
  const maxEdges = boundedInteger(options.maxEdges, 'max_edges', BRANCH_DEFAULTS.maxEdges, BRANCH_MAX.maxEdges)
  const maxLinksPerRun = boundedInteger(options.maxLinksPerRun, 'max_links_per_run', BRANCH_DEFAULTS.maxLinksPerRun, BRANCH_MAX.maxLinksPerRun)
  const wantedFormat = text(options.format).toLowerCase() || 'json'
  if (!EXPERIMENT_BRANCH_FORMATS.includes(wantedFormat)) {
    throw new Error(`branches format must be one of ${EXPERIMENT_BRANCH_FORMATS.join(', ')}`)
  }
  if (options.write === true && wantedFormat !== 'mermaid') {
    throw new Error('branches write is only supported with format: mermaid')
  }

  const experimentSnapshot = readFileSnapshot(f.experiment)
  const runsSnapshot = readJsonlSnapshot(f.runs)
  const linksSnapshot = readJsonlSnapshot(f.links)
  const verdictsSnapshot = readJsonlSnapshot(f.verdicts)
  const anomalies = []
  const anomaly = (kind, details = {}) => anomalies.push({ kind, ...details })

  for (const [key, snapshot] of [['runs', runsSnapshot], ['links', linksSnapshot], ['verdicts', verdictsSnapshot]]) {
    for (const entry of snapshot.corrupt) anomaly(`${key}_line_corrupt`, { line: entry.line, reason: entry.reason })
  }

  const runById = new Map()
  const duplicateRunIds = new Map()
  for (const run of runsSnapshot.rows) {
    const id = text(run.run_id)
    if (!id) {
      anomaly('run_record_missing_id', {})
      continue
    }
    if (runById.has(id)) {
      duplicateRunIds.set(id, (duplicateRunIds.get(id) || 1) + 1)
      continue
    }
    runById.set(id, run)
  }
  for (const [id, count] of duplicateRunIds) anomaly('duplicate_run_id', { run_id: id, occurrences: count, kept: 'first' })

  const sortedIds = [...runById.keys()].sort()
  const includedIds = sortedIds.slice(0, maxNodes)
  const includedSet = new Set(includedIds)
  const omittedRunCount = sortedIds.length - includedIds.length

  let eligibility = null
  let eligibilityError = null
  try {
    eligibility = experimentEligibility(cwd, slugValue)
  } catch (error) {
    eligibilityError = error instanceof Error ? error.message : String(error)
    anomaly('comparison_eligibility_unavailable', { reason: eligibilityError })
  }
  let compliance = eligibility?.compliance ?? null
  if (!compliance) {
    try {
      compliance = experimentCompliance(cwd, slugValue)
    } catch (error) {
      anomaly('compliance_unavailable', { reason: error instanceof Error ? error.message : String(error) })
    }
  }
  const assessmentById = new Map((eligibility?.assessments ?? []).map((entry) => [entry.run_id, entry]))

  const latestVerdictById = new Map()
  for (const verdict of verdictsSnapshot.rows) {
    const runId = text(verdict.run_id)
    if (!runId) {
      anomaly('verdict_record_missing_run_id', {})
      continue
    }
    if (!runById.has(runId)) {
      anomaly('verdict_for_unknown_run', { run_id: runId })
      continue
    }
    latestVerdictById.set(runId, verdict)
  }

  const parentStates = new Map()
  for (const id of sortedIds) {
    const run = runById.get(id)
    const raw = run.parent
    if (raw == null || raw === '') {
      parentStates.set(id, { state: 'root', parent: null, reason: 'no parent recorded' })
      continue
    }
    if (typeof raw !== 'string') {
      parentStates.set(id, { state: 'invalid', parent: String(raw), reason: 'the recorded parent is not a string' })
      anomaly('parent_invalid', { run_id: id, parent: String(raw) })
      continue
    }
    const parent = raw.trim()
    if (!parent) {
      parentStates.set(id, { state: 'root', parent: null, reason: 'no parent recorded' })
    } else if (parent === id) {
      parentStates.set(id, { state: 'self', parent, reason: 'the run names itself as its parent' })
      anomaly('parent_self', { run_id: id })
    } else if (!runById.has(parent)) {
      parentStates.set(id, { state: 'missing', parent, reason: `parent run "${parent}" is not in this ledger` })
      anomaly('parent_missing', { run_id: id, parent })
    } else {
      parentStates.set(id, { state: 'resolved', parent, reason: 'parent run exists in this ledger' })
    }
  }

  const cycles = []
  const cycleNodes = new Set()
  for (const start of sortedIds) {
    if (cycleNodes.has(start)) continue
    const path = []
    const indexById = new Map()
    let current = start
    while (current != null && !cycleNodes.has(current)) {
      if (indexById.has(current)) {
        const cycle = path.slice(indexById.get(current)).sort()
        cycles.push(cycle)
        for (const id of cycle) {
          cycleNodes.add(id)
          const state = parentStates.get(id)
          if (state) state.state = 'cycle'
        }
        break
      }
      const state = parentStates.get(current)
      if (!state || state.state !== 'resolved') break
      indexById.set(current, path.length)
      path.push(current)
      current = state.parent
    }
  }
  cycles.sort((a, b) => a[0].localeCompare(b[0]))
  for (const cycle of cycles) anomaly('parent_cycle', { run_ids: cycle })

  const childrenByParent = new Map()
  for (const [id, state] of parentStates) {
    if (state.state !== 'resolved' && state.state !== 'cycle') continue
    if (!childrenByParent.has(state.parent)) childrenByParent.set(state.parent, [])
    childrenByParent.get(state.parent).push(id)
  }
  for (const children of childrenByParent.values()) children.sort()

  const resolveLink = makeLinkResolver(cwd, definition.slug, runById)
  const linksByRun = new Map()
  const seenLinks = new Set()
  let linksTotal = 0
  for (const [index, link] of linksSnapshot.rows.entries()) {
    const runId = text(link.run_id)
    const kind = text(link.target?.kind)
    const targetId = text(link.target?.id)
    if (!runId) {
      anomaly('link_record_missing_run_id', { link_index: index })
      continue
    }
    if (!runById.has(runId)) {
      anomaly('link_for_unknown_run', { link_index: index, run_id: runId })
      continue
    }
    if (!kind || !targetId) {
      anomaly('link_target_missing', { link_index: index, run_id: runId })
      continue
    }
    linksTotal += 1
    const duplicateKey = `${runId}\0${kind}\0${targetId}`
    const duplicate = seenLinks.has(duplicateKey)
    seenLinks.add(duplicateKey)
    if (duplicate) anomaly('duplicate_link', { run_id: runId, target_kind: kind, target_id: targetId })
    if (!includedSet.has(runId)) continue
    const entry = {
      target: { kind, id: targetId },
      recorded_at: link.ts ?? null,
      provenance: { ledger: relativePath(cwd, f.links), index },
      resolution: resolveLink(kind, targetId),
      duplicate,
    }
    if (!linksByRun.has(runId)) linksByRun.set(runId, [])
    linksByRun.get(runId).push(entry)
  }
  for (const links of linksByRun.values()) {
    links.sort((a, b) => a.target.kind.localeCompare(b.target.kind)
      || a.target.id.localeCompare(b.target.id)
      || String(a.recorded_at ?? '').localeCompare(String(b.recorded_at ?? ''))
      || a.provenance.index - b.provenance.index)
  }

  const allEdges = []
  for (const id of sortedIds) {
    const state = parentStates.get(id)
    if (!state || state.state === 'root') continue
    const edgeState = state.state === 'resolved' && !includedSet.has(state.parent) ? 'truncated' : state.state
    allEdges.push({ from: state.parent ?? null, to: id, kind: 'parent', state: edgeState })
  }
  const includedEdges = allEdges.filter((edge) => includedSet.has(edge.to))
  const boundedEdges = includedEdges.slice(0, maxEdges)
  const edgesTruncated = includedEdges.length > maxEdges
  if (edgesTruncated) anomaly('edge_limit_reached', { max_edges: maxEdges, omitted: includedEdges.length - maxEdges })

  const nodes = includedIds.map((id) => {
    const run = runById.get(id)
    const parentState = parentStates.get(id) ?? { state: 'root', parent: null, reason: 'not assessed' }
    const parentIncluded = parentState.state === 'resolved' && includedSet.has(parentState.parent)
    const nodeParentState = parentState.state === 'resolved' && !parentIncluded ? 'truncated' : parentState.state
    const allLinks = linksByRun.get(id) ?? []
    const links = allLinks.slice(0, maxLinksPerRun)
    const analysisLinks = links.filter((link) => link.target.kind === 'analysis_run')
    const verdict = latestVerdictById.get(id) ?? null
    const assessment = assessmentById.get(id)
    const excluded = compliance?.excluded?.get(id) ?? null
    const unresolvedAnalysisLinks = analysisLinks.filter((link) => link.resolution.state !== 'resolved')
    let complianceState
    if (eligibilityError || !compliance) complianceState = 'unknown'
    else if (excluded) complianceState = 'excluded'
    else if (unresolvedAnalysisLinks.length) complianceState = 'unknown'
    else complianceState = 'not_excluded'
    const status = branchStatus(verdict, analysisLinks)
    const children = (childrenByParent.get(id) ?? []).filter((child) => includedSet.has(child))
    const metrics = run.metrics && typeof run.metrics === 'object' && !Array.isArray(run.metrics) ? run.metrics : {}
    return {
      run_id: id,
      ts: run.ts ?? null,
      parent: parentState.parent ?? null,
      parent_state: nodeParentState,
      parent_included: parentIncluded,
      parent_reason: parentState.reason,
      root: parentState.state === 'root',
      orphan: ['missing', 'self', 'invalid'].includes(parentState.state),
      cycle: parentState.state === 'cycle',
      children,
      child_count: children.length,
      role: run.role ?? null,
      stage: run.stage ?? null,
      seed: run.seed ?? null,
      scope_id: run.comparison_identity?.scope_id ?? null,
      comparison_state: eligibilityError ? 'unknown' : assessment?.state ?? 'not_checked',
      comparison_reasons: eligibilityError ? ['comparison_eligibility_unavailable'] : assessment?.reasons ?? ['not_assessed'],
      metrics,
      metrics_state: Object.keys(metrics).length ? 'recorded' : 'not_recorded',
      protocol_digest: run.protocol_digest ?? null,
      spec_drift: run.spec_drift ?? null,
      spec_drift_state: run.spec_drift?.state ?? 'not_recorded',
      verdict: verdict ? {
        verdict_id: verdict.verdict_id ?? null,
        ts: verdict.ts ?? null,
        verdict: verdict.verdict ?? null,
        requested_verdict: verdict.requested_verdict ?? null,
        forced: Boolean(verdict.forced),
        engineering_round: verdict.engineering_round ?? null,
        budget: verdict.budget ?? null,
        reason: verdict.reason ?? null,
      } : null,
      verdict_state: verdict ? 'recorded' : 'not_recorded',
      status: status.status,
      status_source: status.status_source,
      status_reason: status.status_reason,
      execution: status.execution,
      excluded: Boolean(excluded),
      compliance: {
        state: complianceState,
        detail: excluded,
        unresolved_link_count: unresolvedAnalysisLinks.length,
        reason: complianceState === 'unknown'
          ? eligibilityError ? 'comparison and compliance eligibility could not be read' : unresolvedAnalysisLinks.length ? 'a linked analysis run is unresolved, so a compliance exclusion cannot be ruled out' : 'the compliance ledger could not be read'
          : null,
      },
      artifacts: (Array.isArray(run.artifacts) ? run.artifacts : []).filter((artifact) => artifact && typeof artifact.path === 'string').map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 ?? null })),
      artifact_count: (Array.isArray(run.artifacts) ? run.artifacts : []).filter((artifact) => artifact && typeof artifact.path === 'string').length,
      links,
      link_count: allLinks.length,
      links_truncated: allLinks.length > maxLinksPerRun,
    }
  })
  if (nodes.some((node) => node.links_truncated)) anomaly('link_limit_reached', { max_links_per_run: maxLinksPerRun })

  const roots = nodes.filter((node) => node.root).map((node) => node.run_id)
  const orphans = nodes.filter((node) => node.orphan).map((node) => ({ run_id: node.run_id, parent: node.parent, reason: node.parent_reason }))
  const visibleCycles = cycles.map((cycle) => cycle.filter((id) => includedSet.has(id))).filter((cycle) => cycle.length > 0)
  const linksIncluded = nodes.reduce((sum, node) => sum + node.links.length, 0)
  const sourceFiles = [
    snapshotEntry(cwd, f.experiment, experimentSnapshot),
    snapshotEntry(cwd, f.runs, runsSnapshot),
    snapshotEntry(cwd, f.links, linksSnapshot),
    snapshotEntry(cwd, f.verdicts, verdictsSnapshot),
  ]
  const sourceDigest = `sha256:${sha256(sourceFiles.map((file) => `${file.path}\0${file.sha256 ?? 'missing'}`).join('\n'))}`
  const changedDuringRead = sourceFiles.some((file) => readFileSnapshot(join(cwd, file.path)).sha256 !== file.sha256)
  if (changedDuringRead) anomaly('source_changed_during_read', { reason: 'a source ledger changed while the view was being computed; re-run to read the new state' })
  const truncated = omittedRunCount > 0 || edgesTruncated || nodes.some((node) => node.links_truncated)
  if (omittedRunCount > 0) anomaly('node_limit_reached', { max_nodes: maxNodes, omitted: omittedRunCount })

  const report = {
    experiment: definition.slug,
    question: definition.question,
    read_only: true,
    generated_at: nowIso(),
    source_snapshot: {
      files: sourceFiles,
      digest: sourceDigest,
      changed_during_read: changedDuringRead,
      note: 'These hashes identify the exact ledger bytes this view was read from; a later read may differ.',
    },
    counts: {
      runs_total: sortedIds.length,
      runs_included: nodes.length,
      runs_omitted: omittedRunCount,
      edges_total: allEdges.length,
      edges_included: boundedEdges.length,
      edges_omitted: allEdges.length - includedEdges.length + (includedEdges.length - boundedEdges.length),
      links_total: linksTotal,
      links_included: linksIncluded,
      links_omitted: linksTotal - linksIncluded,
      roots: roots.length,
      orphans: orphans.length,
      cycles: visibleCycles.length,
      duplicate_run_ids: duplicateRunIds.size,
    },
    limits: { max_nodes: maxNodes, max_edges: maxEdges, max_links_per_run: maxLinksPerRun },
    truncated,
    roots,
    orphans,
    cycles: visibleCycles,
    nodes,
    edges: boundedEdges,
    anomalies,
    notes: [
      'A parent link is recorded ancestry, not proof of scientific causality.',
      'Status is derived only from recorded verdicts and linked analysis manifests; a run without metrics is not called failed.',
      'Paper and scientific_result links may remain unresolved by design; the link record is kept and labelled.',
      'This view is read-only unless Mermaid output was explicitly written to the exports directory.',
    ],
  }
  if (wantedFormat !== 'mermaid') return report
  const mermaid = renderExperimentBranchesMermaid(report)
  if (options.write !== true) return { ...report, mermaid }
  const written = exportText(join(f.exports, 'branches.mmd'), mermaid, { overwrite: Boolean(options.overwrite) })
  return { ...report, mermaid, export: { format: 'mermaid', path: relativePath(cwd, written.path), bytes: written.bytes } }
}

/** Render the structured branch report as escaped Mermaid source. */
export function renderExperimentBranchesMermaid(report) {
  const lines = ['flowchart TD']
  const ids = new Map()
  report.nodes.forEach((node, index) => ids.set(node.run_id, `n${index}`))
  for (const node of report.nodes) {
    lines.push(`  ${ids.get(node.run_id)}["${mermaidLabel(branchNodeLabel(node))}"]`)
  }
  let ghostIndex = 0
  for (const edge of report.edges) {
    const from = edge.from == null ? null : ids.get(edge.from)
    const to = ids.get(edge.to)
    if (!to) continue
    if (edge.state === 'resolved' || edge.state === 'cycle') {
      if (from) lines.push(`  ${from} --> ${to}`)
    } else if (edge.state === 'self') {
      lines.push(`  ${to} --> ${to}`)
    } else if (edge.state === 'missing' || edge.state === 'truncated') {
      const ghost = `m${ghostIndex}`
      ghostIndex += 1
      const label = edge.state === 'missing' ? `missing parent: ${edge.from}` : `parent not shown: ${edge.from}`
      lines.push(`  ${ghost}["${mermaidLabel(label)}"]`)
      lines.push(`  ${to} -.-> ${ghost}`)
    }
  }
  lines.push('', '  classDef good fill:#dcfce7,stroke:#15803d,color:#14532d;')
  lines.push('  classDef failed fill:#fee2e2,stroke:#b91c1c,color:#7f1d1d;')
  lines.push('  classDef pruned fill:#f3f4f6,stroke:#6b7280,color:#374151;')
  lines.push('  classDef engineering fill:#fef3c7,stroke:#b45309,color:#78350f;')
  lines.push('  classDef unknown fill:#fef3c7,stroke:#b45309,color:#78350f;')
  lines.push('  classDef not_recorded fill:#ffffff,stroke:#9ca3af,color:#374151;')
  for (const node of report.nodes) lines.push(`  class ${ids.get(node.run_id)} ${branchClass(node)};`)
  if (report.truncated) {
    lines.push(`  t0["… ${report.counts.runs_omitted} run(s) and ${report.counts.edges_omitted} edge(s) omitted from this view"]`)
  }
  return `${lines.join('\n')}\n`
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
  if (kind === 'analysis_run') {
    const analysis = linkedAnalysisRun({ target: { kind, id } })
    if (!analysis) throw new Error(`target_id "${id}" does not name an analysis run`)
    // A dangling link is not merely untidy: an exclusion joined on it would
    // silently never apply, so the target must exist when the link is recorded.
    if (!hasAnalysisRun(cwd, analysis.slug, analysis.run_id)) {
      throw new Error(`no analysis run "${analysis.run_id}"${analysis.slug ? ` in analysis "${analysis.slug}"` : ' in this workspace'}; link the run that produced the number`)
    }
  }
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
  const compliance = experimentCompliance(cwd, slugValue)
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
    compliance: {
      excluded_run_ids: compliance.excluded_run_ids,
      details: compliance.details,
    },
  }
}

function runsCsv(definition, runs, verdicts = [], compliance = null, eligibility = null) {
  const metrics = metricNames(definition, runs)
  const params = [...new Set(runs.flatMap((run) => Object.keys(run.params || {})))]
  const latest = new Map(verdicts.map((verdict) => [verdict.run_id, verdict]))
  const header = ['run_id', 'ts', 'seed', 'parent', 'role', 'baseline_ref', 'stage', 'protocol_digest', 'spec_drift', ...params, ...metrics, 'verdict', 'compliance', 'artifacts', 'notes', 'scope_id', 'comparison_state', 'comparison_reasons', 'selected_scope_id', 'baseline_run_id', 'comparison_identity']
  const lines = [header.map(csvCell).join(',')]
  for (const run of runs) {
    lines.push([
      run.run_id, run.ts, run.seed ?? '', run.parent ?? '',
      run.role ?? '', run.baseline_ref ?? '', run.stage ?? '', run.protocol_digest ?? '', run.spec_drift?.state ?? '',
      ...params.map((name) => run.params?.[name] ?? ''),
      ...metrics.map((name) => run.metrics?.[name] ?? ''),
      latest.get(run.run_id)?.verdict ?? '',
      compliance?.excluded.has(run.run_id) ? 'excluded' : '',
      run.artifacts.map((entry) => entry.path).join('; '),
      run.notes ?? '',
      run.comparison_identity?.scope_id ?? '',
      eligibility?.assessments.find((entry) => entry.run_id === run.run_id)?.state ?? 'not_checked',
      (eligibility?.assessments.find((entry) => entry.run_id === run.run_id)?.reasons ?? []).join('; '),
      eligibility?.scope_id ?? '',
      run.baseline_run_id ?? '',
      run.comparison_identity ? stableStringify(run.comparison_identity) : '',
    ].map(csvCell).join(','))
  }
  return `${lines.join('\n')}\n`
}

function runsMarkdown(definition, runs, links, verdicts = [], compliance = null, eligibility = null) {
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
  const bestLines = definition.metrics.filter((metric) => metric.direction).map((metric) => metric.name).flatMap((name) => {
    const eligible = eligibility?.included ?? []
    const winner = bestRun(eligible, name, directions[name] || 'higher')
    return winner ? [`- ${name} (${directions[name] || 'higher'}): ${winner.run_id} = ${winner.metrics[name]}`] : []
  })
  if (bestLines.length) lines.push('', '## Best per named metric', '', ...bestLines)
  lines.push('', '## Comparison scope', '', eligibility?.scope_id ? `Scope: ${eligibility.scope_id}` : 'No ranking: an explicit scope_id is required.', ...((eligibility?.assessments || []).map((entry) => `- ${entry.run_id}: ${entry.state}${entry.reasons.length ? ` (${entry.reasons.join(', ')})` : ''}; scope ${entry.scope_id || 'not recorded'}`)), 'Matching user-declared identities are not scientific verification.')
  for (const run of runs.filter((entry) => entry.comparison_identity)) {
    lines.push(`- ${run.run_id} identity: ${mdCell(stableStringify(run.comparison_identity))}; baseline run: ${mdCell(run.baseline_run_id || 'not applicable')}`)
  }
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
  if (compliance?.details.length) {
    lines.push('', '## Compliance exclusions', '', ...compliance.details.map((entry) => `- ${entry.run_id}: excluded because analysis_run ${entry.analysis_run_ids.join(', ')} (${entry.analysis_slug}) violated ${(entry.violated || []).join(', ') || 'a declared task rule'} in ${entry.compliance_ids.filter(Boolean).join(', ') || 'a recorded reading'}`))
  }
  if (compliance?.unresolved.length) {
    lines.push('', '## Unresolved analysis links', '', ...compliance.unresolved.map((entry) => `- ${entry.run_id} → analysis_run ${entry.analysis_run_id}${entry.analysis_slug ? ` (${entry.analysis_slug})` : ''}: ${entry.reason}`))
  }
  lines.push('', 'Logged runs and metrics as recorded. No metric here is a scientific claim, and missing values stay blank.', '')
  return lines.join('\n')
}

function runsMlflow(definition, runs, verdicts = [], compliance = null, eligibility = null) {
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
          ...(compliance?.excluded.has(run.run_id) ? { compliance: 'excluded' } : {}),
          comparison_scope_id: run.comparison_identity?.scope_id ?? '',
          comparison_state: eligibility?.assessments.find((entry) => entry.run_id === run.run_id)?.state ?? 'not_checked',
          comparison_reasons: (eligibility?.assessments.find((entry) => entry.run_id === run.run_id)?.reasons ?? []).join('; '),
          comparison_identity: run.comparison_identity ? stableStringify(run.comparison_identity) : '',
          baseline_run_id: run.baseline_run_id ?? '',
        },
        params: Object.fromEntries(Object.entries(run.params || {}).map(([key, value]) => [key, String(value)])),
        metrics: Object.entries(run.metrics || {}).map(([key, value]) => ({ key, value, timestamp: new Date(run.ts).getTime() * 1000 })),
        artifacts: (run.artifacts || []).map((entry) => ({ path: entry.path, tags: [] })),
      },
    })),
  }
}

export function exportExperiment({ cwd, slug: slugValue, format = 'markdown', overwrite = false, scopeId = null }) {
  const f = files(cwd, slugValue)
  const definition = readExperiment(cwd, slugValue)
  const runs = readJsonl(f.runs)
  const links = readJsonl(f.links)
  const verdicts = readJsonl(f.verdicts)
  const compliance = experimentCompliance(cwd, slugValue)
  const eligibility = experimentEligibility(cwd, slugValue, scopeId)
  const comparison = { scope_id: scopeId || null, assessments: eligibility.assessments, note: 'Identity is user-declared. MLflow and other consumers do not enforce eligibility after import.' }
  const wanted = text(format).toLowerCase()
  if (!EXPERIMENT_EXPORT_FORMATS.includes(wanted)) {
    throw new Error(`format must be one of ${EXPERIMENT_EXPORT_FORMATS.join(', ')}`)
  }
  let name
  let body
  if (wanted === 'csv') {
    name = 'runs.csv'
    body = runsCsv(definition, runs, verdicts, compliance, eligibility)
  } else if (wanted === 'json') {
    name = 'experiment.json'
    body = `${JSON.stringify({ experiment: definition, runs, links, verdicts, compliance: compliance.details, comparison }, null, 2)}\n`
  } else if (wanted === 'mlflow') {
    name = 'mlflow.json'
    body = `${JSON.stringify({ ...runsMlflow(definition, runs, verdicts, compliance, eligibility), comparison }, null, 2)}\n`
  } else {
    name = 'report.md'
    body = runsMarkdown(definition, runs, links, verdicts, compliance, eligibility)
  }
  const written = exportText(join(f.exports, name), body, { overwrite })
  return { format: wanted, path: written.path.slice(cwd.length + 1), bytes: written.bytes }
}
