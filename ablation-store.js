/**
 * Ablation/attribution ledger under `<cwd>/.dsh/ablation/<slug>/`.
 *
 *   ablation.json  write-once method spec and champion idea id
 *   plan.json      write-once component x arm x dataset x metric plan
 *   records.jsonl  append-only links from plan cells to experiment/analysis runs
 *   verdicts.jsonl append-only human verdicts
 *   pruned.jsonl   append-only arm pruning events
 *   exports/       markdown/json/csv
 *
 * The tool never runs an experiment. A record points at a run that already
 * exists; experiment runs supply their metrics directly, analysis runs must have
 * hashed outputs and the caller supplies the metric reading. Attribution is an
 * advisory reading of removal deltas, never a scientific claim.
 */
import { join } from 'node:path'
import {
  appendJsonl, csvCell, ensureDir, exportText, mdCell, nowIso, readJson, readJsonl,
  sha256, slug as slugify, stableStringify, writeOnceJson,
} from './ledger-kit.js'
import { withLock } from './store-lock.js'
import { listExperimentRuns } from './experiment-store.js'
import { listAnalysisRuns } from './analysis-store.js'

export const ABLATION_VERDICTS = ['good', 'refine', 'unattributed']
export const ABLATION_EXPECTED_CHANGES = ['increase', 'decrease', 'tie', 'any']
export const ABLATION_EXPORT_FORMATS = ['markdown', 'json', 'csv']
const MAX_REPORT_ROWS = 500
const MAX_REPORT_MISSING = 200

function text(value) {
  return String(value ?? '').trim()
}

function files(cwd, slugValue) {
  const dir = join(cwd, '.dsh', 'ablation', slugify(slugValue))
  return {
    dir,
    definition: join(dir, 'ablation.json'),
    plan: join(dir, 'plan.json'),
    records: join(dir, 'records.jsonl'),
    verdicts: join(dir, 'verdicts.jsonl'),
    pruned: join(dir, 'pruned.jsonl'),
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
  if (!Array.isArray(input) || !input.length) throw new Error('plan.metrics needs at least one metric')
  const out = []
  const seen = new Set()
  for (const entry of input) {
    const value = objectValue(entry, 'plan.metric')
    const name = text(value.name)
    if (!name) throw new Error('every plan metric needs a name')
    if (seen.has(name)) throw new Error(`duplicate metric ${name}`)
    seen.add(name)
    const direction = text(value.direction).toLowerCase()
    if (!['higher', 'lower'].includes(direction)) throw new Error(`metric ${name} needs direction higher|lower`)
    out.push({ name, direction })
  }
  return out
}

function normalizeExpected(input, metrics, armId) {
  if (input == null || input === '') {
    throw new Error(`arm "${armId}" needs at least one expected metric`)
  }
  if (!Array.isArray(input)) throw new Error(`arm "${armId}" expected must be an array`)
  const declared = new Set(metrics.map((metric) => metric.name))
  const out = []
  const seen = new Set()
  for (const entry of input) {
    const value = typeof entry === 'string' ? { metric: entry } : objectValue(entry, `arm ${armId} expected entry`)
    const metric = text(value.metric ?? value.name)
    if (!metric) throw new Error(`arm "${armId}" expected entry needs a metric`)
    if (!declared.has(metric)) throw new Error(`arm "${armId}" expects undeclared metric "${metric}"`)
    if (seen.has(metric)) throw new Error(`arm "${armId}" repeats expected metric "${metric}"`)
    seen.add(metric)
    const change = text(value.change ?? value.direction).toLowerCase() || 'any'
    if (!ABLATION_EXPECTED_CHANGES.includes(change)) {
      throw new Error(`arm "${armId}" expected change must be one of ${ABLATION_EXPECTED_CHANGES.join(', ')}`)
    }
    out.push({ metric, change })
  }
  return out
}

function normalizePlan(input) {
  const value = objectValue(input, 'plan')
  const datasets = stringList(value.datasets, 'plan.datasets', { required: true })
  const metrics = normalizeMetrics(value.metrics)
  const metricsByName = new Map(metrics.map((metric) => [metric.name, metric]))
  const replicatesRaw = value.replicates == null || value.replicates === '' ? 1 : Number(value.replicates)
  if (!Number.isInteger(replicatesRaw) || replicatesRaw < 1 || replicatesRaw > 100) {
    throw new Error('plan.replicates must be an integer from 1 to 100')
  }
  if (!Array.isArray(value.arms) || !value.arms.length) throw new Error('plan.arms needs at least one arm')
  const arms = []
  const seenArms = new Set()
  for (const entry of value.arms) {
    const arm = objectValue(entry, 'plan.arm')
    const id = text(arm.id ?? arm.name)
    if (!id) throw new Error('every plan arm needs an id')
    if (seenArms.has(id)) throw new Error(`duplicate arm ${id}`)
    seenArms.add(id)
    const component = text(arm.component)
    const codePath = text(arm.code_path ?? arm.codePath)
    const expectedInput = arm.expected ?? arm.expected_metrics
    const expected = expectedInput == null || (Array.isArray(expectedInput) && expectedInput.length === 0)
      ? []
      : normalizeExpected(expectedInput, metrics, id)
    arms.push({
      id,
      component: component || null,
      code_path: codePath || null,
      removal: text(arm.removal) || null,
      expected,
    })
  }
  const noComponentArms = arms.filter((arm) => !arm.component)
  const referenceArm = text(value.reference_arm ?? value.referenceArm)
    || arms.find((arm) => arm.id === 'full')?.id
    || (noComponentArms.length === 1 ? noComponentArms[0].id : null)
  if (!referenceArm && noComponentArms.length > 1) {
    throw new Error('plan.reference_arm is required when more than one arm removes no component')
  }
  if (!referenceArm) throw new Error('plan.reference_arm is required (or include exactly one arm with no component)')
  const reference = arms.find((arm) => arm.id === referenceArm)
  if (!reference) throw new Error(`reference_arm "${referenceArm}" is not one of the plan arms`)
  if (reference.component) throw new Error(`reference_arm "${referenceArm}" must not remove a component`)
  if (reference.expected.length) throw new Error(`reference_arm "${referenceArm}" must not declare expected changes`)
  for (const arm of arms) {
    if (arm.id === referenceArm) continue
    if (!arm.component) throw new Error(`arm "${arm.id}" must name the component it removes or be the reference arm`)
    if (!arm.code_path) throw new Error(`arm "${arm.id}" must name the code path or module it removes`)
    if (!arm.expected.length) throw new Error(`arm "${arm.id}" must declare at least one expected metric change`)
    for (const expected of arm.expected) {
      if (!metricsByName.has(expected.metric)) throw new Error(`arm "${arm.id}" expects undeclared metric "${expected.metric}"`)
    }
  }
  return {
    schemaVersion: 1,
    arms,
    datasets,
    metrics,
    replicates: replicatesRaw,
    reference_arm: referenceArm,
    notes: text(value.notes) || null,
    created_at: nowIso(),
  }
}

export async function startAblation({ cwd, slug: slugValue, ideaId, ideaSource = null, method, name = null, question = null }) {
  const f = files(cwd, slugValue)
  const champion = text(ideaId)
  if (!champion) throw new Error('idea_id is required (the champion idea id from coscientist)')
  const methodSpec = objectValue(method, 'method')
  if (!Object.keys(methodSpec).length) throw new Error('method is required (the method/mechanism spec being ablated)')
  const stored = {
    schemaVersion: 1,
    slug: slugify(slugValue),
    name: text(name) || slugify(slugValue),
    question: text(question) || null,
    idea_id: champion,
    idea_source: text(ideaSource) || null,
    method: methodSpec,
    created_at: nowIso(),
  }
  ensureDir(f.dir)
  return withLock(f.dir, () => {
    if (readJson(f.definition)) throw new Error(`ablation "${stored.slug}" already exists; choose another slug`)
    writeOnceJson(f.definition, stored)
    return { ablation: stored }
  }, { label: 'ablation ledger' })
}

export function readAblation(cwd, slugValue) {
  const definition = readJson(files(cwd, slugValue).definition)
  if (!definition) throw new Error(`ablation "${slugify(slugValue)}" not found under .dsh/ablation/${slugify(slugValue)}`)
  return definition
}

export function readAblationPlan(cwd, slugValue) {
  const plan = readJson(files(cwd, slugValue).plan)
  if (!plan) throw new Error(`ablation "${slugify(slugValue)}" has no plan; run action "plan" first`)
  return plan
}

export async function planAblation({ cwd, slug: slugValue, plan }) {
  const f = files(cwd, slugValue)
  readAblation(cwd, slugValue)
  const normalized = normalizePlan(plan)
  return withLock(f.dir, () => {
    if (readJson(f.plan)) throw new Error('the ablation plan is already frozen; an ablation is planned once (refine a separate arm instead of rewriting the grid)')
    writeOnceJson(f.plan, normalized)
    return { plan: normalized }
  }, { label: 'ablation ledger' })
}

function findArm(plan, armId) {
  const id = text(armId)
  if (!id) throw new Error('arm is required')
  const arm = plan.arms.find((entry) => entry.id === id)
  if (!arm) throw new Error(`arm "${id}" is not in the plan`)
  return arm
}

function sourceDigest(run) {
  return `sha256:${sha256(stableStringify(run))}`
}

function experimentSource(cwd, slugValue, runId) {
  const slug = text(slugValue)
  const id = text(runId)
  if (!slug || !id) throw new Error('experiment_slug and experiment_run_id are both required')
  const run = listExperimentRuns(cwd, slug).find((entry) => entry.run_id === id)
  if (!run) throw new Error(`experiment run "${id}" not found in experiment "${slug}"`)
  return {
    source: {
      ledger: 'experiment',
      slug,
      run_id: id,
      digest: sourceDigest(run),
      artifacts: (run.artifacts || []).map((entry) => ({ path: entry.path, sha256: entry.sha256 ?? null })),
      metrics_source: 'linked experiment run',
    },
    metrics: run.metrics || {},
  }
}

function analysisSource(cwd, slugValue, runId, metrics) {
  const slug = text(slugValue)
  const id = text(runId)
  if (!slug || !id) throw new Error('analysis_slug and analysis_run_id are both required')
  const run = listAnalysisRuns(cwd, slug).find((entry) => entry.run_id === id)
  if (!run) throw new Error(`analysis run "${id}" not found in analysis "${slug}"`)
  const hashed = (run.outputs || []).filter((entry) => entry.sha256).length
    + (run.artifacts || []).length
  if (!hashed) throw new Error('the analysis run has no hashed outputs or artifacts; link an experiment run or a run with hashed evidence')
  const values = objectValue(metrics, 'metrics')
  const reading = {}
  for (const [name, value] of Object.entries(values)) {
    if (value == null) continue
    const number = Number(value)
    if (!Number.isFinite(number)) throw new Error(`metric ${name} must be a finite number`)
    reading[name] = number
  }
  if (!Object.keys(reading).length) throw new Error('metrics is required for an analysis_run record (the values read from its hashed outputs)')
  return {
    source: {
      ledger: 'analysis',
      slug,
      run_id: id,
      digest: sourceDigest(run),
      artifacts: [
        ...(run.outputs || []).filter((entry) => entry.sha256).map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
        ...(run.artifacts || []).map((path) => ({ path, sha256: null })),
      ],
      metrics_source: 'caller reading of hashed outputs',
    },
    metrics: reading,
  }
}

export async function recordAblation({
  cwd,
  slug: slugValue,
  arm,
  dataset,
  replicate = 1,
  experimentSlug = null,
  experimentRunId = null,
  analysisSlug = null,
  analysisRunId = null,
  metrics = null,
}) {
  const f = files(cwd, slugValue)
  const plan = readAblationPlan(cwd, slugValue)
  const armEntry = findArm(plan, arm)
  const datasetValue = text(dataset)
  if (!plan.datasets.includes(datasetValue)) throw new Error(`dataset "${datasetValue}" is not in the plan`)
  const replicateValue = replicate == null || replicate === '' ? 1 : Number(replicate)
  if (!Number.isInteger(replicateValue) || replicateValue < 1 || replicateValue > plan.replicates) {
    throw new Error(`replicate must be an integer from 1 to ${plan.replicates}`)
  }
  const hasExperiment = experimentSlug != null || experimentRunId != null
  const hasAnalysis = analysisSlug != null || analysisRunId != null
  if (hasExperiment && hasAnalysis) throw new Error('record one source: experiment or analysis, not both')
  if (!hasExperiment && !hasAnalysis) throw new Error('record needs experiment_slug + experiment_run_id or analysis_slug + analysis_run_id')
  if (hasExperiment && metrics != null) throw new Error('experiment records take metrics from the linked run; omit metrics')
  const resolved = hasExperiment
    ? experimentSource(cwd, experimentSlug, experimentRunId)
    : analysisSource(cwd, analysisSlug, analysisRunId, metrics)
  const declared = new Set(plan.metrics.map((metric) => metric.name))
  const missingMetrics = [...declared].filter((name) => resolved.metrics[name] == null)
  return withLock(f.dir, () => {
    const records = readJsonl(f.records)
    if (records.some((entry) => entry.arm === armEntry.id && entry.dataset === datasetValue && entry.replicate === replicateValue)) {
      throw new Error(`arm "${armEntry.id}", dataset "${datasetValue}", replicate ${replicateValue} is already recorded; log another replicate or prune the arm`)
    }
    const event = {
      record_id: `r${String(records.length + 1).padStart(4, '0')}`,
      ts: nowIso(),
      arm: armEntry.id,
      component: armEntry.component,
      code_path: armEntry.code_path,
      dataset: datasetValue,
      replicate: replicateValue,
      source: resolved.source,
      metrics: resolved.metrics,
      missing_metrics: missingMetrics,
    }
    appendJsonl(f.records, [event])
    return { record: event }
  }, { label: 'ablation ledger' })
}

export function listAblationRecords(cwd, slugValue) {
  return readJsonl(files(cwd, slugValue).records)
}

export function listAblationVerdicts(cwd, slugValue) {
  return readJsonl(files(cwd, slugValue).verdicts)
}

export function listAblationPrunes(cwd, slugValue) {
  return readJsonl(files(cwd, slugValue).pruned)
}

function changeOf(delta) {
  if (delta > 0) return 'increase'
  if (delta < 0) return 'decrease'
  return 'tie'
}

function matchesExpected(change, expected) {
  if (!expected) return null
  if (expected === 'any') return change !== 'tie'
  return change === expected
}

/**
 * Paired removal deltas against the reference arm. Ties and missing cells are
 * listed rather than dropped; a component is read as attributed only when every
 * paired observation matches its declared expected change.
 */
export function reportAblation(cwd, slugValue) {
  const definition = readAblation(cwd, slugValue)
  const plan = readAblationPlan(cwd, slugValue)
  const records = listAblationRecords(cwd, slugValue)
  const verdicts = listAblationVerdicts(cwd, slugValue)
  const prunes = listAblationPrunes(cwd, slugValue)
  const prunedArms = [...new Set(prunes.map((entry) => entry.arm))]
  const recordMap = new Map(records.map((record) => [`${record.arm}|${record.dataset}|${record.replicate}`, record]))
  const reference = plan.reference_arm
  const rows = []
  const ties = []
  const missing = []
  for (const arm of plan.arms) {
    if (arm.id === reference) continue
    for (const dataset of plan.datasets) {
      for (let replicate = 1; replicate <= plan.replicates; replicate += 1) {
        const referenceRecord = recordMap.get(`${reference}|${dataset}|${replicate}`) ?? null
        const armRecord = recordMap.get(`${arm.id}|${dataset}|${replicate}`) ?? null
        for (const metric of plan.metrics) {
          const expected = arm.expected.find((entry) => entry.metric === metric.name)?.change ?? null
          if (!referenceRecord) {
            missing.push({ arm: arm.id, dataset, replicate, metric: metric.name, reason: `no ${reference} reference record` })
            continue
          }
          if (!armRecord) {
            missing.push({ arm: arm.id, dataset, replicate, metric: metric.name, reason: 'no arm record' })
            continue
          }
          const referenceValue = referenceRecord.metrics?.[metric.name]
          const armValue = armRecord.metrics?.[metric.name]
          if (referenceValue == null || armValue == null) {
            missing.push({ arm: arm.id, dataset, replicate, metric: metric.name, reason: referenceValue == null ? 'reference metric missing' : 'arm metric missing' })
            continue
          }
          const delta = Number(armValue) - Number(referenceValue)
          const deltaPct = referenceValue === 0 ? null : Number(((delta / Math.abs(referenceValue)) * 100).toFixed(2))
          const change = changeOf(delta)
          const matches = matchesExpected(change, expected)
          const row = {
            arm: arm.id,
            component: arm.component,
            code_path: arm.code_path,
            dataset,
            replicate,
            metric: metric.name,
            direction: metric.direction,
            reference_arm: reference,
            reference: referenceValue,
            value: armValue,
            delta: Number(delta.toFixed(6)),
            delta_pct: deltaPct,
            change,
            expected_change: expected,
            matches_expectation: matches,
            source: { ledger: armRecord.source?.ledger ?? null, slug: armRecord.source?.slug ?? null, run_id: armRecord.source?.run_id ?? null },
          }
          rows.push(row)
          if (change === 'tie') ties.push(row)
        }
      }
    }
  }
  const byArm = {}
  for (const arm of plan.arms) {
    if (arm.id === reference) continue
    const expectedMetrics = arm.expected.map((entry) => entry.metric)
    const armRows = rows.filter((row) => row.arm === arm.id)
    const expectedRows = armRows.filter((row) => expectedMetrics.includes(row.metric))
    const metrics = {}
    for (const metric of expectedMetrics) {
      const metricRows = expectedRows.filter((row) => row.metric === metric)
      const expected = arm.expected.find((entry) => entry.metric === metric)?.change ?? null
      metrics[metric] = {
        expected_change: expected,
        n: metricRows.length,
        ties: metricRows.filter((row) => row.change === 'tie').length,
        matched: metricRows.filter((row) => row.matches_expectation === true).length,
        mean_delta: metricRows.length ? Number((metricRows.reduce((sum, row) => sum + row.delta, 0) / metricRows.length).toFixed(6)) : null,
        changes: [...new Set(metricRows.map((row) => row.change))],
      }
    }
    byArm[arm.id] = {
      arm: arm.id,
      component: arm.component,
      code_path: arm.code_path,
      removed: arm.removal,
      pruned: prunedArms.includes(arm.id),
      expected: arm.expected,
      metrics,
    }
  }
  const attribution = {
    reference_arm: reference,
    attributed: [],
    unattributed: [],
    partial: [],
    not_checked: [],
    pruned: [...prunedArms].filter((arm) => plan.arms.some((entry) => entry.id === arm)),
    components: [],
    note: 'Advisory reading only: a component is attributed when removing it changes every paired expected metric in the declared direction. Missing or tied cells are not evidence; the human verdict remains separate.',
  }
  for (const arm of plan.arms) {
    if (arm.id === reference) continue
    const summary = byArm[arm.id]
    if (summary.pruned) {
      attribution.components.push({ arm: arm.id, component: arm.component, reading: 'pruned', metrics: summary.metrics })
      continue
    }
    const expected = arm.expected
    const observations = expected.map((entry) => summary.metrics[entry.metric])
    const withData = observations.filter((entry) => entry.n > 0)
    const armMissing = missing.some((entry) => entry.arm === arm.id)
    let reading = 'not_checked'
    if (armMissing && withData.length) {
      reading = 'partial'
    } else if (withData.length === expected.length && expected.length) {
      if (observations.every((entry) => entry.matched === entry.n)) reading = 'attributed'
      else if (observations.every((entry) => entry.matched === 0)) reading = 'unattributed'
      else reading = 'partial'
    } else if (withData.length) {
      reading = 'partial'
    }
    if (reading === 'attributed') attribution.attributed.push(arm.id)
    else if (reading === 'unattributed') attribution.unattributed.push(arm.id)
    else if (reading === 'partial') attribution.partial.push(arm.id)
    else attribution.not_checked.push(arm.id)
    attribution.components.push({ arm: arm.id, component: arm.component, reading, metrics: summary.metrics })
  }
  return {
    definition,
    plan,
    records: records.length,
    rows: rows.slice(0, MAX_REPORT_ROWS),
    ties: ties.slice(0, MAX_REPORT_MISSING),
    missing: missing.slice(0, MAX_REPORT_MISSING),
    by_arm: byArm,
    attribution,
    pruned_arms: prunedArms,
    verdicts,
    latest_verdict: verdicts.at(-1) ?? null,
    row_total: rows.length,
    tie_total: ties.length,
    missing_total: missing.length,
    note: 'Logged removal deltas, missing cells, and ties; no value here is a scientific claim. Attribution is advisory and remains a human verdict.',
  }
}

export async function verdictAblation({ cwd, slug: slugValue, verdict, reason, arm = null, component = null }) {
  const f = files(cwd, slugValue)
  readAblationPlan(cwd, slugValue)
  const value = text(verdict).toLowerCase()
  if (!ABLATION_VERDICTS.includes(value)) throw new Error(`verdict must be one of ${ABLATION_VERDICTS.join(', ')}`)
  const why = text(reason)
  if (!why) throw new Error('reason is required')
  const armId = text(arm)
  if (armId) findArm(readAblationPlan(cwd, slugValue), armId)
  return withLock(f.dir, () => {
    const verdicts = listAblationVerdicts(cwd, slugValue)
    const event = {
      verdict_id: `v${String(verdicts.length + 1).padStart(4, '0')}`,
      ts: nowIso(),
      verdict: value,
      reason: why,
      arm: armId || null,
      component: text(component) || null,
    }
    appendJsonl(f.verdicts, [event])
    return { verdict: event }
  }, { label: 'ablation ledger' })
}

export async function pruneAblation({ cwd, slug: slugValue, arm, reason }) {
  const f = files(cwd, slugValue)
  const plan = readAblationPlan(cwd, slugValue)
  const armEntry = findArm(plan, arm)
  if (armEntry.id === plan.reference_arm) throw new Error('the reference arm cannot be pruned')
  const why = text(reason)
  if (!why) throw new Error('reason is required')
  return withLock(f.dir, () => {
    const pruned = listAblationPrunes(cwd, slugValue)
    const event = {
      prune_id: `p${String(pruned.length + 1).padStart(4, '0')}`,
      ts: nowIso(),
      arm: armEntry.id,
      component: armEntry.component,
      reason: why,
    }
    appendJsonl(f.pruned, [event])
    return { prune: event }
  }, { label: 'ablation ledger' })
}

export function statusAblation(cwd, slugValue) {
  const definition = readAblation(cwd, slugValue)
  const plan = readJson(files(cwd, slugValue).plan)
  const records = listAblationRecords(cwd, slugValue)
  const verdicts = listAblationVerdicts(cwd, slugValue)
  const prunes = listAblationPrunes(cwd, slugValue)
  if (!plan) {
    return {
      slug: definition.slug,
      name: definition.name,
      question: definition.question,
      idea_id: definition.idea_id,
      plan: null,
      records: records.length,
      verdicts: verdicts.length,
      pruned: [...new Set(prunes.map((entry) => entry.arm))],
      latest_verdict: verdicts.at(-1) ?? null,
      state: 'started',
    }
  }
  const report = reportAblation(cwd, slugValue)
  return {
    slug: definition.slug,
    name: definition.name,
    question: definition.question,
    idea_id: definition.idea_id,
    plan: {
      arms: plan.arms.length,
      removal_arms: plan.arms.length - 1,
      datasets: plan.datasets.length,
      metrics: plan.metrics.length,
      replicates: plan.replicates,
      reference_arm: plan.reference_arm,
    },
    records: records.length,
    rows: report.row_total,
    ties: report.tie_total,
    missing: report.missing_total,
    pruned: [...new Set(prunes.map((entry) => entry.arm))],
    verdicts: verdicts.length,
    latest_verdict: verdicts.at(-1) ?? null,
    attribution: {
      attributed: report.attribution.attributed,
      unattributed: report.attribution.unattributed,
      partial: report.attribution.partial,
      not_checked: report.attribution.not_checked,
    },
  }
}

export function showAblation(cwd, slugValue, { recordId = null, arm = null } = {}) {
  const definition = readAblation(cwd, slugValue)
  const plan = readJson(files(cwd, slugValue).plan)
  const records = listAblationRecords(cwd, slugValue)
  const verdicts = listAblationVerdicts(cwd, slugValue)
  const prunes = listAblationPrunes(cwd, slugValue)
  if (recordId) {
    const record = records.find((entry) => entry.record_id === text(recordId))
    if (!record) throw new Error(`record "${recordId}" not found`)
    return { definition, plan, record, verdicts: verdicts.filter((entry) => entry.arm === record.arm), prunes: prunes.filter((entry) => entry.arm === record.arm) }
  }
  if (arm) {
    const armId = text(arm)
    if (!plan) throw new Error(`ablation "${slugify(slugValue)}" has no plan`)
    findArm(plan, armId)
    return {
      definition,
      plan,
      records: records.filter((entry) => entry.arm === armId),
      verdicts: verdicts.filter((entry) => entry.arm === armId),
      prunes: prunes.filter((entry) => entry.arm === armId),
    }
  }
  return { definition, plan, records, verdicts, prunes, report: plan ? reportAblation(cwd, slugValue) : null }
}

function renderMarkdown(report) {
  const { definition, plan, attribution } = report
  const lines = [
    `# Ablation: ${definition.name}`,
    '',
    `**Question:** ${definition.question || '(not stated)'}`,
    `**Champion idea:** ${definition.idea_id}${definition.idea_source ? ` (${definition.idea_source})` : ''}`,
    '',
    '## Plan',
    '',
    `- reference arm: ${plan.reference_arm}`,
    `- datasets: ${plan.datasets.join(', ')}`,
    `- metrics: ${plan.metrics.map((metric) => `${metric.name} (${metric.direction})`).join(', ')}`,
    `- replicates: ${plan.replicates}`,
    '',
    '| arm | component | code path | expected |',
    '|---|---|---|---|',
    ...plan.arms.filter((arm) => arm.id !== plan.reference_arm).map((arm) => `| ${mdCell(arm.id)} | ${mdCell(arm.component || '')} | ${mdCell(arm.code_path || '')} | ${mdCell(arm.expected.map((entry) => `${entry.metric}:${entry.change}`).join(', '))} |`),
    '',
    '## Paired removal deltas',
    '',
    '| arm | dataset | rep | metric | reference | arm | delta | change | expected | match |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...report.rows.map((row) => `| ${mdCell(row.arm)} | ${mdCell(row.dataset)} | ${row.replicate} | ${mdCell(row.metric)} | ${row.reference} | ${row.value} | ${row.delta} | ${row.change} | ${row.expected_change || 'any'} | ${row.matches_expectation === null ? '—' : row.matches_expectation ? 'yes' : 'no'} |`),
    '',
    '## Attribution reading',
    '',
    `- attributed: ${attribution.attributed.join(', ') || 'none'}`,
    `- unattributed: ${attribution.unattributed.join(', ') || 'none'}`,
    `- partial: ${attribution.partial.join(', ') || 'none'}`,
    `- not_checked: ${attribution.not_checked.join(', ') || 'none'}`,
    `- pruned: ${attribution.pruned.join(', ') || 'none'}`,
    `- ${attribution.note}`,
    '',
    '## Ties and missing cells',
    '',
    `- ties: ${report.tie_total}`,
    `- missing: ${report.missing_total}`,
    ...report.missing.slice(0, 20).map((entry) => `- missing ${entry.arm}/${entry.dataset}/rep ${entry.replicate}/${entry.metric}: ${entry.reason}`),
    '',
    '## Verdicts',
    '',
    ...(report.verdicts.length
      ? report.verdicts.map((verdict) => `- ${verdict.verdict}${verdict.arm ? ` on ${verdict.arm}` : ''} — ${verdict.reason}`)
      : ['- none recorded']),
    '',
    report.note,
    '',
  ]
  return `${lines.join('\n')}\n`
}

function renderCsv(report) {
  const header = ['arm', 'component', 'code_path', 'dataset', 'replicate', 'metric', 'direction', 'reference_arm', 'reference', 'value', 'delta', 'delta_pct', 'change', 'expected_change', 'matches_expectation', 'source_ledger', 'source_slug', 'source_run_id']
  const lines = [header.map(csvCell).join(',')]
  for (const row of report.rows) {
    lines.push([
      row.arm, row.component || '', row.code_path || '', row.dataset, row.replicate, row.metric, row.direction,
      row.reference_arm, row.reference, row.value, row.delta, row.delta_pct ?? '',
      row.change, row.expected_change || '', row.matches_expectation === null ? '' : row.matches_expectation ? 'yes' : 'no',
      row.source.ledger || '', row.source.slug || '', row.source.run_id || '',
    ].map(csvCell).join(','))
  }
  return `${lines.join('\n')}\n`
}

export function exportAblation({ cwd, slug: slugValue, format = 'markdown', overwrite = false }) {
  const f = files(cwd, slugValue)
  readAblation(cwd, slugValue)
  const wanted = text(format).toLowerCase() || 'markdown'
  if (!ABLATION_EXPORT_FORMATS.includes(wanted)) throw new Error(`format must be one of ${ABLATION_EXPORT_FORMATS.join(', ')}`)
  const report = reportAblation(cwd, slugValue)
  const body = wanted === 'json'
    ? `${JSON.stringify({
        definition: report.definition,
        plan: report.plan,
        records: listAblationRecords(cwd, slugValue),
        pruned: listAblationPrunes(cwd, slugValue),
        verdicts: report.verdicts,
        report,
      }, null, 2)}\n`
    : wanted === 'csv'
      ? renderCsv(report)
      : renderMarkdown(report)
  const name = wanted === 'json' ? 'ablation.json' : wanted === 'csv' ? 'deltas.csv' : 'report.md'
  const written = exportText(join(f.exports, name), body, { overwrite })
  return { format: wanted, path: written.path.slice(cwd.length + 1), bytes: written.bytes }
}
