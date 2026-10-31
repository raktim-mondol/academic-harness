/**
 * Append-only meta-analysis ledger under `<cwd>/.dsh/meta/<slug>/`.
 *
 * `protocol.json` is write-once; studies and analyses are append-only JSONL.
 * The statistical work lives in python-helpers/meta_helper.py; this module
 * validates arguments, persists state, and writes plot/report artifacts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { withLock } from './store-lock.js'
import {
  appendJsonl, csvCell, exportText, nowIso, readJson, readJsonl, slug, writeOnceJson,
} from './ledger-kit.js'
import { runHelper } from './python-runtime.js'
import { deriveExtractionStatus, readProtocol as readReviewProtocol } from './review-store.js'

export const META_EFFECT_MEASURES = ['OR', 'RR', 'HR', 'IRR', 'MD', 'SMD', 'RD', 'ZR']
export const META_MODELS = ['fixed', 'random']
export const META_TAU2_METHODS = ['dl', 'pm', 'reml']
export const META_CI_METHODS = ['normal', 'hartung_knapp']
export const META_EXPORT_FORMATS = ['json', 'csv', 'report', 'forest', 'funnel', 'sroc']
const RATIO_LABELS = new Set(['OR', 'RR', 'HR', 'IRR'])

function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

export function metaSlug(value) {
  const result = slug(value, 80)
  if (!result) throw new Error('slug must contain at least one letter or digit')
  return result
}

export function metaDir(cwd, slugValue) {
  return join(resolve(cwd), '.dsh', 'meta', metaSlug(slugValue))
}

function files(cwd, slugValue) {
  const dir = metaDir(cwd, slugValue)
  return {
    dir,
    protocol: join(dir, 'protocol.json'),
    studies: join(dir, 'studies.jsonl'),
    analyses: join(dir, 'analyses.jsonl'),
    plots: join(dir, 'plots'),
    exports: join(dir, 'exports'),
  }
}

function ensureMeta(cwd, slugValue) {
  const f = files(cwd, slugValue)
  if (!existsSync(f.protocol)) throw new Error(`meta-analysis "${metaSlug(slugValue)}" has not been started`)
  mkdirSync(f.plots, { recursive: true })
  mkdirSync(f.exports, { recursive: true })
  return f
}

export function readMetaProtocol(cwd, slugValue) {
  const f = files(cwd, slugValue)
  if (!existsSync(f.protocol)) throw new Error(`meta-analysis "${metaSlug(slugValue)}" has not been started`)
  return readJson(f.protocol)
}

export function readMetaStudies(cwd, slugValue) {
  const f = files(cwd, slugValue)
  return readJsonl(f.studies)
}

export function readMetaAnalyses(cwd, slugValue) {
  const f = files(cwd, slugValue)
  return readJsonl(f.analyses)
}

function validateProtocol(input) {
  const effectMeasure = text(input.effect_measure).toUpperCase()
  if (!META_EFFECT_MEASURES.includes(effectMeasure)) {
    throw new Error(`effect_measure must be one of ${META_EFFECT_MEASURES.join(', ')}`)
  }
  const model = text(input.model || 'random').toLowerCase()
  if (!META_MODELS.includes(model)) throw new Error(`model must be one of ${META_MODELS.join(', ')}`)
  const tau2Method = text(input.tau2_method || 'reml').toLowerCase()
  if (!META_TAU2_METHODS.includes(tau2Method)) {
    throw new Error(`tau2_method must be one of ${META_TAU2_METHODS.join(', ')}`)
  }
  const ciMethod = text(input.ci_method || 'normal').toLowerCase()
  if (!META_CI_METHODS.includes(ciMethod)) {
    throw new Error(`ci_method must be one of ${META_CI_METHODS.join(', ')}`)
  }
  const alpha = input.alpha == null ? 0.05 : Number(input.alpha)
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) throw new Error('alpha must be between 0 and 1')
  return {
    question: text(input.question) || null,
    outcome: text(input.outcome) || null,
    effect_measure: effectMeasure,
    log_scale: RATIO_LABELS.has(effectMeasure),
    model,
    tau2_method: tau2Method,
    ci_method: ciMethod,
    alpha,
    notes: text(input.notes) || null,
  }
}

export async function startMetaAnalysis({ cwd, slug: slugValue, protocol = {}, resume = false }) {
  const f = files(cwd, slugValue)
  if (existsSync(f.protocol) && !resume) {
    throw new Error(`meta-analysis "${metaSlug(slugValue)}" already exists; pass resume: true to continue it`)
  }
  if (existsSync(f.protocol)) {
    return { slug: metaSlug(slugValue), dir: f.dir, protocol: readJson(f.protocol), resumed: true }
  }
  const validated = validateProtocol(protocol)
  const stored = { slug: metaSlug(slugValue), ...validated, created_at: nowIso() }
  mkdirSync(f.dir, { recursive: true })
  mkdirSync(f.plots, { recursive: true })
  mkdirSync(f.exports, { recursive: true })
  writeOnceJson(f.protocol, stored)
  for (const file of [f.studies, f.analyses]) if (!existsSync(file)) writeFileSync(file, '')
  return { slug: stored.slug, dir: f.dir, protocol: stored, resumed: false }
}

export async function addMetaStudies({ cwd, slug: slugValue, studies = [], helper = runHelper }) {
  const f = ensureMeta(cwd, slugValue)
  const protocol = readMetaProtocol(cwd, slugValue)
  if (!Array.isArray(studies) || studies.length === 0) throw new Error('studies must be a non-empty array')
  const prepared = helper('meta_helper.py', {
    action: 'prepare',
    measure: protocol.effect_measure,
    studies,
  })
  if (prepared?.error) throw new Error(`meta-analysis prepare failed: ${prepared.error}`)
  const rows = Array.isArray(prepared.prepared) ? prepared.prepared : []
  const skipped = Array.isArray(prepared.skipped) ? prepared.skipped : []
  return withLock(f.dir, () => {
    const existing = readJsonl(f.studies)
    const seen = new Set(existing.map((study) => study.id))
    const added = []
    for (const study of rows) {
      if (seen.has(study.id)) {
        skipped.push({ id: study.id, reason: 'duplicate study id' })
        continue
      }
      seen.add(study.id)
      added.push({ ...study, added_at: nowIso() })
    }
    appendJsonl(f.studies, added)
    return {
      added: added.length,
      skipped,
      total: existing.length + added.length,
      ids: added.map((study) => study.id),
    }
  }, { label: 'meta-analysis ledger' })
}

function effectiveParams(protocol, params = {}) {
  const model = text(params.model || protocol.model).toLowerCase()
  if (!META_MODELS.includes(model)) throw new Error(`model must be one of ${META_MODELS.join(', ')}`)
  const tau2Method = text(params.tau2_method || protocol.tau2_method).toLowerCase()
  if (!META_TAU2_METHODS.includes(tau2Method)) throw new Error(`tau2_method must be one of ${META_TAU2_METHODS.join(', ')}`)
  const ciMethod = text(params.ci_method || protocol.ci_method).toLowerCase()
  if (!META_CI_METHODS.includes(ciMethod)) throw new Error(`ci_method must be one of ${META_CI_METHODS.join(', ')}`)
  const alpha = params.alpha == null ? protocol.alpha : Number(params.alpha)
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) throw new Error('alpha must be between 0 and 1')
  return { model, tau2_method: tau2Method, ci_method: ciMethod, alpha }
}

function analysisId(analyses) {
  return `ma${String(analyses.length + 1).padStart(4, '0')}`
}

function diagnosticStudies(studies) {
  return studies.map((study) => {
    const meta = study.meta || {}
    return { ...meta, id: study.id, label: study.label }
  })
}

function writePlotFile({ cwd, slug: slugValue, kind, analysisId: id, payload, helper, overwrite = false }) {
  const f = ensureMeta(cwd, slugValue)
  const result = helper('meta_helper.py', { action: 'plot', kind, ...payload })
  if (result?.error) throw new Error(`meta-analysis plot failed: ${result.error}`)
  if (typeof result.svg !== 'string' || !result.svg.includes('<svg')) {
    throw new Error('meta-analysis plot helper returned no SVG')
  }
  const out = join(f.plots, `${kind}-${id}.svg`)
  if (existsSync(out) && !overwrite) throw new Error(`${relative(resolve(cwd), out)} already exists`)
  writeFileSync(out, result.svg)
  return relative(resolve(cwd), out)
}

export async function runMetaAction({ cwd, slug: slugValue, action, params = {}, helper = runHelper }) {
  const f = ensureMeta(cwd, slugValue)
  const protocol = readMetaProtocol(cwd, slugValue)
  const studies = readMetaStudies(cwd, slugValue)
  if (studies.length < 2) throw new Error('at least two studies are required for this analysis')
  if (action !== 'diagnostic') {
    const mismatched = studies.filter((study) => study.measure && study.measure !== protocol.effect_measure)
    if (mismatched.length) {
      throw new Error(`study measure ${mismatched[0].measure} does not match protocol ${protocol.effect_measure}; use the diagnostic action for diagnostic 2×2 studies`)
    }
  }
  const effective = effectiveParams(protocol, params)
  const request = {
    action,
    studies: action === 'diagnostic' ? diagnosticStudies(studies) : studies,
    model: effective.model,
    tau2_method: effective.tau2_method,
    ci_method: effective.ci_method,
    alpha: effective.alpha,
    effect_measure: protocol.effect_measure,
    log_scale: protocol.log_scale,
    field: params.field,
    covariates: params.covariates,
  }
  const result = helper('meta_helper.py', request)
  if (result?.error) throw new Error(`meta-analysis ${action} failed: ${result.error}`)
  return withLock(f.dir, () => {
    const analyses = readMetaAnalyses(cwd, slugValue)
    const id = analysisId(analyses)
    let plot = null
    if (action === 'pool') plot = writePlotFile({
      cwd, slug: slugValue, kind: 'forest', analysisId: id, payload: { pool: result }, helper,
    })
    if (action === 'publication_bias') plot = writePlotFile({
      cwd, slug: slugValue, kind: 'funnel', analysisId: id, payload: { pool: result }, helper,
    })
    if (action === 'diagnostic') plot = writePlotFile({
      cwd, slug: slugValue, kind: 'sroc', analysisId: id, payload: { diagnostic: result }, helper,
    })
    if (plot) result.plot = plot
    const event = {
      analysis_id: id,
      kind: action,
      ts: nowIso(),
      params: { ...effective, ...(params.field ? { field: params.field } : {}), ...(params.covariates ? { covariates: params.covariates } : {}) },
      result,
    }
    appendJsonl(f.analyses, [event])
    return event
  }, { label: 'meta-analysis ledger' })
}

export function deriveMetaStatus(cwd, slugValue) {
  const protocol = readMetaProtocol(cwd, slugValue)
  const studies = readMetaStudies(cwd, slugValue)
  const analyses = readMetaAnalyses(cwd, slugValue)
  const latest = analyses.at(-1) || null
  const latestPool = [...analyses].reverse().find((analysis) => analysis.kind === 'pool') || null
  return {
    slug: protocol.slug,
    question: protocol.question,
    outcome: protocol.outcome,
    effect_measure: protocol.effect_measure,
    log_scale: protocol.log_scale,
    model: protocol.model,
    tau2_method: protocol.tau2_method,
    ci_method: protocol.ci_method,
    alpha: protocol.alpha,
    studies: studies.length,
    analyses: analyses.length,
    latest: latest ? {
      analysis_id: latest.analysis_id,
      kind: latest.kind,
      ts: latest.ts,
      plot: latest.result?.plot || null,
    } : null,
    pooled: latestPool ? {
      analysis_id: latestPool.analysis_id,
      k: latestPool.result.k,
      pooled: latestPool.result.pooled,
      ci: latestPool.result.ci,
      display_pooled: latestPool.result.display_pooled,
      display_ci: latestPool.result.display_ci,
      i2: latestPool.result.heterogeneity.i2,
      tau2: latestPool.result.heterogeneity.tau2,
      plot: latestPool.result.plot || null,
    } : null,
  }
}

export function listMetaAnalyses(cwd, slugValue) {
  return readMetaAnalyses(cwd, slugValue).map((analysis) => ({
    analysis_id: analysis.analysis_id,
    kind: analysis.kind,
    ts: analysis.ts,
    k: analysis.result?.k ?? null,
    pooled: typeof analysis.result?.pooled === 'number'
      ? analysis.result.pooled
      : analysis.result?.pooled?.pooled ?? null,
    plot: analysis.result?.plot ?? null,
  }))
}

export function showMetaAnalysis(cwd, slugValue, analysisIdValue) {
  const id = text(analysisIdValue)
  if (!id) throw new Error('analysis_id is required')
  const analysis = readMetaAnalyses(cwd, slugValue).find((entry) => entry.analysis_id === id)
  if (!analysis) throw new Error(`analysis ${id} not found`)
  return analysis
}

export function plotMetaAnalysis({
  cwd, slug: slugValue, kind = 'forest', analysis_id: analysisIdValue = null,
  helper = runHelper, overwrite = false,
}) {
  const plotKind = text(kind).toLowerCase()
  if (!['forest', 'funnel', 'sroc'].includes(plotKind)) {
    throw new Error('kind must be forest, funnel, or sroc')
  }
  const analyses = readMetaAnalyses(cwd, slugValue)
  let target
  if (analysisIdValue) {
    target = analyses.find((analysis) => analysis.analysis_id === text(analysisIdValue))
  } else {
    const wanted = plotKind === 'sroc' ? 'diagnostic' : plotKind === 'funnel' ? 'publication_bias' : 'pool'
    target = [...analyses].reverse().find((analysis) => analysis.kind === wanted)
  }
  if (!target) throw new Error(`no ${plotKind} analysis is available yet`)
  const payload = plotKind === 'sroc'
    ? { diagnostic: target.result }
    : { pool: target.result }
  const path = writePlotFile({
    cwd,
    slug: slugValue,
    kind: plotKind,
    analysisId: target.analysis_id,
    payload,
    helper,
    overwrite,
  })
  return { analysis_id: target.analysis_id, kind: plotKind, path }
}

export function renderMetaReport({ cwd, slug: slugValue }) {
  const protocol = readMetaProtocol(cwd, slugValue)
  const studies = readMetaStudies(cwd, slugValue)
  const analyses = readMetaAnalyses(cwd, slugValue)
  return markdownReport(protocol, studies, analyses)
}

function poolWeightsById(analyses) {
  const pool = [...analyses].reverse().find((analysis) => analysis.kind === 'pool')
  return new Map((pool?.result?.weights || []).map((entry) => [String(entry.id), entry.weight_pct]))
}

function studiesCsv(protocol, studies, weights = new Map()) {
  const header = ['id', 'label', 'effect', 'se', 'variance', 'display_effect', 'display_ci_low', 'display_ci_high', 'weight_pct', 'n', 'raw_json']
  const lines = [header.map(csvCell).join(',')]
  for (const study of studies) {
    lines.push([
      study.id,
      study.label,
      study.effect,
      study.se,
      study.variance,
      study.display_effect ?? '',
      study.display_ci?.[0] ?? '',
      study.display_ci?.[1] ?? '',
      weights.get(String(study.id)) ?? study.weight_pct ?? '',
      study.n ?? '',
      JSON.stringify(study.meta || {}),
    ].map(csvCell).join(','))
  }
  return `${lines.join('\n')}\n`
}

function markdownReport(protocol, studies, analyses) {
  const pool = [...analyses].reverse().find((analysis) => analysis.kind === 'pool')
  const weights = poolWeightsById(analyses)
  const lines = [
    `# Meta-analysis: ${protocol.slug}`,
    '',
    `**Question:** ${protocol.question || '(not recorded)'}`,
    `**Outcome:** ${protocol.outcome || '(not recorded)'}`,
    `**Effect measure:** ${protocol.effect_measure}${protocol.log_scale ? ' (log scale internally)' : ''}`,
    `**Model:** ${protocol.model}; τ²: ${protocol.tau2_method}; CI: ${protocol.ci_method}; alpha: ${protocol.alpha}`,
    '',
    '## Studies',
    '',
    '| ID | Label | Effect | SE | 95% CI | Weight |',
    '|---|---|---:|---:|---|---:|',
  ]
  for (const study of studies) {
    const ci = study.display_ci || [study.effect - 1.96 * study.se, study.effect + 1.96 * study.se]
    const pct = weights.get(String(study.id)) ?? study.weight_pct
    lines.push(`| ${study.id} | ${study.label || ''} | ${study.display_effect ?? study.effect} | ${study.se.toFixed(4)} | ${ci[0].toFixed(4)} to ${ci[1].toFixed(4)} | ${pct == null ? '' : `${pct.toFixed(1)}%`} |`)
  }
  lines.push('', '## Pooled result', '')
  if (!pool) {
    lines.push('_No pooled analysis yet._')
  } else {
    const result = pool.result
    const ci = result.display_ci || result.ci
    lines.push(
      `- k = ${result.k}`,
      `- Pooled effect: ${result.display_pooled ?? result.pooled} (95% CI ${ci[0]} to ${ci[1]})`,
      `- Heterogeneity: Q = ${result.heterogeneity.q}, df = ${result.heterogeneity.df}, p = ${result.heterogeneity.p ?? 'n/a'}, I² = ${result.heterogeneity.i2.toFixed(1)}%, τ² = ${result.heterogeneity.tau2}`,
      `- Model: ${result.model}; τ² method: ${result.tau2_method}; CI method: ${result.ci_method}`,
    )
    if (result.prediction_interval) {
      const pi = result.display_prediction_interval || result.prediction_interval
      lines.push(`- Prediction interval: ${pi[0]} to ${pi[1]}`)
    }
    for (const warning of result.warnings || []) lines.push(`- Warning: ${warning}`)
  }
  lines.push('', '## Analysis log', '')
  if (!analyses.length) lines.push('_No analyses yet._')
  for (const analysis of analyses) {
    lines.push(`- ${analysis.analysis_id}: ${analysis.kind} at ${analysis.ts}`)
  }
  lines.push('', 'Recorded analysis output only. It is not a certainty, quality, or clinical recommendation.', '')
  return lines.join('\n')
}

export function exportMetaAnalysis({ cwd, slug: slugValue, format = 'json', overwrite = false, helper = runHelper }) {
  const f = ensureMeta(cwd, slugValue)
  const protocol = readMetaProtocol(cwd, slugValue)
  const studies = readMetaStudies(cwd, slugValue)
  const analyses = readMetaAnalyses(cwd, slugValue)
  const kind = text(format).toLowerCase()
  if (kind === 'forest' || kind === 'funnel' || kind === 'sroc') {
    const analysisIdValue = [...analyses].reverse().find((analysis) => (
      kind === 'sroc' ? analysis.kind === 'diagnostic' : kind === 'funnel' ? analysis.kind === 'publication_bias' : analysis.kind === 'pool'
    ))?.analysis_id
    if (!analysisIdValue) throw new Error(`no ${kind} analysis is available yet`)
    const path = writePlotFile({
      cwd,
      slug: slugValue,
      kind,
      analysisId: analysisIdValue,
      payload: kind === 'sroc'
        ? { diagnostic: showMetaAnalysis(cwd, slugValue, analysisIdValue).result }
        : { pool: showMetaAnalysis(cwd, slugValue, analysisIdValue).result },
      helper,
      overwrite,
    })
    return { format: kind, path, bytes: Buffer.byteLength(readFileSync(join(cwd, path))) }
  }
  let name
  let body
  if (kind === 'json') {
    name = 'meta-analysis.json'
    body = `${JSON.stringify({ protocol, studies, analyses }, null, 2)}\n`
  } else if (kind === 'csv') {
    name = 'studies.csv'
    body = studiesCsv(protocol, studies, poolWeightsById(analyses))
  } else if (kind === 'report') {
    name = 'report.md'
    body = markdownReport(protocol, studies, analyses)
  } else {
    throw new Error(`format must be one of ${META_EXPORT_FORMATS.join(', ')}`)
  }
  const out = join(f.exports, name)
  const exported = exportText(out, body, { overwrite })
  return { format: kind, path: relative(resolve(cwd), out), bytes: exported.bytes }
}

function pickField(row, fieldId) {
  if (!fieldId) return null
  const field = row.fields?.[fieldId]
  if (!field || field.value == null || field.state === 'conflict' || field.state === 'reopened') return null
  return field.value
}

/**
 * Import a review extraction table into the meta-analysis ledger. Defaults
 * match the built-in PICO template; pass mapping to adapt a custom template.
 */
export async function importReviewStudies({
  cwd, slug: slugValue, review, mapping = {}, helper = runHelper,
}) {
  const reviewSlugValue = text(review)
  if (!reviewSlugValue) throw new Error('review slug is required')
  readReviewProtocol(cwd, reviewSlugValue)
  const protocol = readMetaProtocol(cwd, slugValue)
  const map = {
    effect: 'effect',
    se: 'se',
    ci_low: 'ci_low',
    ci_high: 'ci_high',
    n: 'n',
    label: 'label',
    outcome: 'outcome',
    effect_measure: 'effect_measure',
    rob: 'rob',
    ...mapping,
  }
  const extraction = deriveExtractionStatus(cwd, reviewSlugValue)
  if (!extraction.template) throw new Error(`review "${reviewSlugValue}" has no extraction template`)
  const fields = new Set((extraction.template.fields || []).map((field) => field.id))
  const hasOutcomeField = fields.has(map.outcome)
  const hasMeasureField = fields.has(map.effect_measure)
  const studies = []
  const skipped = []
  for (const row of extraction.rows) {
    const rowLabel = `${row.record_id}${row.row_id === 'main' ? '' : `:${row.row_id}`}`
    if (row.status !== 'complete') {
      skipped.push({ id: rowLabel, reason: `extraction row is ${row.status}` })
      continue
    }
    const outcome = pickField(row, map.outcome)
    if (protocol.outcome && hasOutcomeField) {
      if (outcome == null) {
        skipped.push({ id: rowLabel, reason: `outcome is not recorded (expected ${protocol.outcome})` })
        continue
      }
      if (text(outcome) !== text(protocol.outcome)) {
        skipped.push({ id: rowLabel, reason: `outcome ${text(outcome)} does not match ${protocol.outcome}` })
        continue
      }
    }
    const measure = pickField(row, map.effect_measure)
    if (hasMeasureField) {
      if (measure == null) {
        skipped.push({ id: rowLabel, reason: `effect measure is not recorded (expected ${protocol.effect_measure})` })
        continue
      }
      if (text(measure).toUpperCase() !== protocol.effect_measure) {
        skipped.push({ id: rowLabel, reason: `effect measure ${text(measure)} does not match ${protocol.effect_measure}` })
        continue
      }
    }
    const effect = pickField(row, map.effect)
    if (effect == null || !Number.isFinite(Number(effect))) {
      skipped.push({ id: rowLabel, reason: 'no numeric effect value' })
      continue
    }
    const se = pickField(row, map.se)
    const ciLow = pickField(row, map.ci_low)
    const ciHigh = pickField(row, map.ci_high)
    if (se == null && (ciLow == null || ciHigh == null)) {
      skipped.push({ id: rowLabel, reason: 'no standard error or complete confidence interval' })
      continue
    }
    if (protocol.effect_measure !== 'MD' && protocol.effect_measure !== 'SMD'
      && protocol.effect_measure !== 'ZR' && ciLow == null && se != null) {
      skipped.push({ id: rowLabel, reason: 'ratio measures need a confidence interval or an explicit log-scale SE' })
      continue
    }
    const meta = {}
    for (const [fieldId, field] of Object.entries(row.fields || {})) {
      if (field.value != null) meta[fieldId] = field.value
    }
    meta.record_id = row.record_id
    meta.row_id = row.row_id
    meta.title = row.title
    const study = {
      id: rowLabel,
      label: pickField(row, map.label) || row.title || rowLabel,
      type: 'generic',
      effect: Number(effect),
      ...(se == null ? {} : { se: Number(se) }),
      ...(ciLow == null ? {} : { ci_low: Number(ciLow) }),
      ...(ciHigh == null ? {} : { ci_high: Number(ciHigh) }),
      ...(pickField(row, map.n) == null ? {} : { n: Number(pickField(row, map.n)) }),
      ...(pickField(row, map.rob) == null ? {} : { rob: pickField(row, map.rob) }),
      ...(protocol.log_scale ? { log_scale: false } : {}),
      meta,
    }
    studies.push(study)
  }
  if (!studies.length) {
    return { added: 0, skipped, total: readMetaStudies(cwd, slugValue).length, ids: [] }
  }
  const added = await addMetaStudies({ cwd, slug: slugValue, studies, helper })
  return { ...added, skipped: [...skipped, ...(added.skipped || [])] }
}
