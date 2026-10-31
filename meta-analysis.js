/**
 * meta_analysis: action-multiplexed pairwise meta-analysis ledger.
 *
 * State lives under `<cwd>/.dsh/meta/<slug>/` (meta-analysis-store.js).
 * Statistical work is in python-helpers/meta_helper.py. This tool validates
 * arguments, renders compact results, and never interprets the estimate as a
 * recommendation.
 */
import { relative } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  META_CI_METHODS, META_EFFECT_MEASURES, META_EXPORT_FORMATS, META_MODELS,
  META_TAU2_METHODS, addMetaStudies, deriveMetaStatus, exportMetaAnalysis,
  importReviewStudies, listMetaAnalyses, plotMetaAnalysis, readMetaProtocol,
  renderMetaReport, runMetaAction, showMetaAnalysis, startMetaAnalysis,
} from './meta-analysis-store.js'
import { runHelper } from './python-runtime.js'

const ACTIONS = [
  'start', 'add', 'effect_size', 'pool', 'subgroup', 'meta_regression',
  'leave_one_out', 'publication_bias', 'diagnostic', 'plot', 'report',
  'import_review', 'status', 'list', 'show', 'export',
]

function text(value) {
  return String(value ?? '').trim()
}

function requireString(value, name) {
  const result = text(value)
  if (!result) throw new Error(`${name} is required`)
  return result
}

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

const fmt = (value, digits = 3) => (value != null && value !== '' && Number.isFinite(Number(value))
  ? Number(value).toFixed(digits)
  : 'n/a')

function ciOf(result) {
  return result.display_ci || result.ci || []
}

function renderEffectSize(result) {
  const r = result.result
  const ci = r.display_ci || []
  const bits = [
    `${r.measure}: ${fmt(r.display_effect)}${ci.length === 2 ? ` (95% CI ${fmt(ci[0])}–${fmt(ci[1])})` : ''}`,
    `analysis scale: ${fmt(r.effect)} (SE ${fmt(r.se)})`,
    `formula: ${r.formula}`,
  ]
  if (r.correction) bits.push(`correction: ${r.correction}`)
  return [{ type: 'text', text: bits.join('\n') }]
}

function renderPool(result) {
  const ci = ciOf(result)
  const lines = [
    `Pooled effect — k = ${result.k} · ${result.model} model · ${result.tau2_method} τ² · ${result.ci_method} CI`,
    '',
    `${fmt(result.display_pooled ?? result.pooled)} (95% CI ${fmt(ci[0])}–${fmt(ci[1])})`,
    `analysis scale ${fmt(result.pooled)} (SE ${fmt(result.se)}); p = ${fmt(result.p, 4)}`,
    `Heterogeneity: Q = ${fmt(result.heterogeneity.q)}, df = ${result.heterogeneity.df}, p = ${result.heterogeneity.p == null ? 'n/a' : fmt(result.heterogeneity.p, 4)}, I² = ${fmt(result.heterogeneity.i2, 1)}%, τ² = ${fmt(result.heterogeneity.tau2, 4)}`,
  ]
  if (result.prediction_interval) {
    const pi = result.display_prediction_interval || result.prediction_interval
    lines.push(`Prediction interval: ${fmt(pi[0])}–${fmt(pi[1])}`)
  }
  for (const warning of result.warnings || []) lines.push(`Warning: ${warning}`)
  if (result.plot) lines.push(`Plot: ${result.plot}`)
  lines.push('', 'Reported analysis output only; it is not a certainty or clinical recommendation.')
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderSubgroup(result) {
  const lines = [
    `Subgroup analysis — field: ${result.field} · Q_between = ${fmt(result.q_between)}, df = ${result.df}, p = ${result.p == null ? 'n/a' : fmt(result.p, 4)}`,
    '',
    '| Group | k | Pooled | 95% CI | I² | τ² |',
    '|---|---:|---|---|---:|---:|',
  ]
  for (const group of result.groups) {
    const ci = ciOf(group)
    const het = group.heterogeneity
    lines.push(`| ${group.group} | ${group.k} | ${fmt(group.display_pooled ?? group.pooled)} | ${fmt(ci[0])}–${fmt(ci[1])} | ${het ? `${fmt(het.i2, 1)}%` : 'n/a'} | ${het ? fmt(het.tau2, 4) : 'n/a'} |`)
  }
  for (const warning of result.warnings || []) lines.push(`Warning: ${warning}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderMetaRegression(result) {
  const lines = [
    `Meta-regression — k = ${result.k} · covariates: ${result.covariates.join(', ')} · ${result.ci_method} CI`,
    '',
    '| Term | Estimate | SE | 95% CI | p |',
    '|---|---:|---:|---|---:|',
  ]
  for (const coefficient of result.coefficients) {
    lines.push(`| ${coefficient.name} | ${fmt(coefficient.estimate, 4)} | ${fmt(coefficient.se, 4)} | ${fmt(coefficient.ci[0], 4)}–${fmt(coefficient.ci[1], 4)} | ${fmt(coefficient.p, 4)} |`)
  }
  lines.push(
    '',
    `Residual τ² = ${fmt(result.tau2, 4)}; Q_E = ${fmt(result.q_e)}, df = ${result.df}, p = ${fmt(result.p_qe, 4)}; pseudo-R² = ${result.r2 == null ? 'n/a' : `${fmt(result.r2 * 100, 1)}%`}.`,
  )
  for (const dropped of result.dropped || []) lines.push(`Dropped ${dropped.id}: ${dropped.reason}`)
  for (const warning of result.warnings || []) lines.push(`Warning: ${warning}`)
  lines.push('', 'Covariate coding and model assumptions are the author’s responsibility; this is not a causal estimate.')
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderLeaveOneOut(result) {
  const lines = [
    `Leave-one-out — full pooled effect ${fmt(result.full.display_pooled ?? result.full.pooled)} (95% CI ${ciOf(result.full).map((value) => fmt(value)).join('–')})`,
    '',
    '| Omitted | Pooled | 95% CI | I² | τ² | Δ vs full |',
    '|---|---|---|---:|---:|---:|',
  ]
  for (const row of result.rows) {
    const ci = row.display_ci || row.ci
    lines.push(`| ${row.omitted} | ${fmt(row.display_pooled ?? row.pooled)} | ${fmt(ci[0])}–${fmt(ci[1])} | ${fmt(row.i2, 1)}% | ${fmt(row.tau2, 4)} | ${fmt(row.delta, 4)} |`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderPublicationBias(result) {
  const lines = [
    `Publication-bias diagnostics — k = ${result.pooled.k}`,
    '',
    `Egger: intercept ${fmt(result.egger?.intercept, 4)}, SE ${fmt(result.egger?.se, 4)}, t = ${fmt(result.egger?.t, 3)}, p = ${fmt(result.egger?.p, 4)}`,
    `Begg: Kendall τ = ${fmt(result.begg?.tau, 3)}, p = ${fmt(result.begg?.p, 4)}`,
    `Trim-and-fill: ${result.trimfill?.implemented ? 'implemented' : 'not implemented in this release'}`,
  ]
  for (const warning of result.warnings || []) lines.push(`Warning: ${warning}`)
  if (result.plot) lines.push(`Funnel plot: ${result.plot}`)
  lines.push('', 'Funnel-plot asymmetry is not proof of publication bias; small-study effects and heterogeneity can produce it.')
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderDiagnostic(result) {
  const lines = [
    `Diagnostic accuracy — k = ${result.k} · ${result.model} model · ${result.tau2_method} τ²`,
    '',
    `Sensitivity: ${fmt(result.sensitivity.pooled)} (95% CI ${fmt(result.sensitivity.ci[0])}–${fmt(result.sensitivity.ci[1])})`,
    `Specificity: ${fmt(result.specificity.pooled)} (95% CI ${fmt(result.specificity.ci[0])}–${fmt(result.specificity.ci[1])})`,
    `DOR: ${fmt(result.dor.pooled)} (95% CI ${fmt(result.dor.ci[0])}–${fmt(result.dor.ci[1])})`,
  ]
  for (const warning of result.warnings || []) lines.push(`Warning: ${warning}`)
  if (result.plot) lines.push(`SROC plot: ${result.plot}`)
  lines.push('', 'Univariate logit pooling; a full bivariate/HSROC model is not implemented in this release.')
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderAnalysis(analysis) {
  if (!analysis) return [{ type: 'text', text: 'No analysis found.' }]
  const result = analysis.result
  if (analysis.kind === 'pool') return renderPool(result)
  if (analysis.kind === 'subgroup') return renderSubgroup(result)
  if (analysis.kind === 'meta_regression') return renderMetaRegression(result)
  if (analysis.kind === 'leave_one_out') return renderLeaveOneOut(result)
  if (analysis.kind === 'publication_bias') return renderPublicationBias(result)
  if (analysis.kind === 'diagnostic') return renderDiagnostic(result)
  return [{ type: 'text', text: JSON.stringify(result, null, 2) }]
}

function renderStatus(status) {
  const lines = [
    `Meta-analysis "${status.slug}" — ${status.question || '(no question)'}`,
    '',
    `Outcome: ${status.outcome || '(not recorded)'} · effect: ${status.effect_measure} · model: ${status.model} (τ² ${status.tau2_method}, CI ${status.ci_method}, α ${status.alpha})`,
    `Studies: ${status.studies} · analyses: ${status.analyses}`,
  ]
  if (status.pooled) {
    const pooled = status.pooled
    lines.push(
      '',
      `Latest pooled result ${pooled.analysis_id}: ${fmt(pooled.display_pooled ?? pooled.pooled)} (95% CI ${fmt(ciOf(pooled)[0])}–${fmt(ciOf(pooled)[1])}); k = ${pooled.k}, I² = ${fmt(pooled.i2, 1)}%, τ² = ${fmt(pooled.tau2, 4)}.`,
    )
    if (pooled.plot) lines.push(`Plot: ${pooled.plot}`)
  } else {
    lines.push('', 'No pooled analysis yet.')
  }
  if (status.latest) lines.push(`Latest analysis: ${status.latest.analysis_id} (${status.latest.kind}).`)
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderList(rows) {
  if (!rows.length) return [{ type: 'text', text: 'No analyses yet.' }]
  const lines = ['| Analysis | Kind | k | Pooled | Plot |', '|---|---|---:|---|---|']
  for (const row of rows) {
    lines.push(`| ${row.analysis_id} | ${row.kind} | ${row.k ?? ''} | ${row.pooled == null ? '' : fmt(row.pooled)} | ${row.plot || ''} |`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderReport(result) {
  return [{ type: 'text', text: result.markdown }]
}

function renderExport(result) {
  return [{ type: 'text', text: `Wrote ${result.path} (${result.bytes} bytes).` }]
}

function renderReview(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (value.action === 'effect_size') return renderEffectSize(value)
  if (value.action === 'start') {
    const protocol = value.protocol
    return [{
      type: 'text',
      text: `Meta-analysis "${value.slug}" ${value.resumed ? 'resumed' : 'started'} at ${value.dir}.\nEffect: ${protocol.effect_measure} · model: ${protocol.model} · τ²: ${protocol.tau2_method} · CI: ${protocol.ci_method} · α: ${protocol.alpha}${protocol.question ? `\nQuestion: ${protocol.question}` : ''}`,
    }]
  }
  if (value.action === 'add') {
    const skipped = value.skipped?.length
      ? `\nSkipped: ${value.skipped.map((entry) => `${entry.id || '?'} (${entry.reason})`).join('; ')}`
      : ''
    return [{ type: 'text', text: `Added ${value.added} study/studies; total ${value.total}.${skipped}` }]
  }
  if (['pool', 'subgroup', 'meta_regression', 'leave_one_out', 'publication_bias', 'diagnostic'].includes(value.action)) {
    return renderAnalysis({ kind: value.action, result: value.result })
  }
  if (value.action === 'plot') return [{ type: 'text', text: `Wrote ${value.path} for ${value.analysis_id} (${value.kind}).` }]
  if (value.action === 'report') return renderReport(value)
  if (value.action === 'import_review') {
    const skipped = value.skipped?.length
      ? `\nSkipped: ${value.skipped.map((entry) => `${entry.id || '?'} (${entry.reason})`).join('; ')}`
      : ''
    return [{ type: 'text', text: `Imported ${value.added} study/studies from review; total ${value.total}.${skipped}` }]
  }
  if (value.action === 'status') return renderStatus(value.status)
  if (value.action === 'list') return renderList(value.analyses)
  if (value.action === 'show') return renderAnalysis(value.analysis)
  if (value.action === 'export') return renderExport(value)
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

export async function runMetaAnalysis(args, exec, deps = {}) {
  const action = args.action || 'status'
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  const helper = deps.runHelper || runHelper

  if (action === 'effect_size') {
    const measure = requireString(args.effect_measure || args.measure, 'effect_measure').toUpperCase()
    if (!args.input || typeof args.input !== 'object' || Array.isArray(args.input)) {
      throw new Error('input must be an object describing the study data')
    }
    const result = helper('meta_helper.py', { action: 'effect_size', measure, input: args.input })
    if (result?.error) throw new Error(`effect-size conversion failed: ${result.error}`)
    return { action, result }
  }

  const slug = requireString(args.slug, 'slug')

  if (action === 'start') {
    const given = args.protocol && typeof args.protocol === 'object' && !Array.isArray(args.protocol) ? args.protocol : {}
    const started = await startMetaAnalysis({
      cwd,
      slug,
      resume: Boolean(args.resume),
      protocol: {
        question: args.question ?? given.question,
        outcome: args.outcome ?? given.outcome,
        effect_measure: args.effect_measure ?? given.effect_measure,
        model: args.model ?? given.model,
        tau2_method: args.tau2_method ?? given.tau2_method,
        ci_method: args.ci_method ?? given.ci_method,
        alpha: args.alpha ?? given.alpha,
        notes: args.notes ?? given.notes,
      },
    })
    return { action, ...started, dir: relative(cwd, started.dir) }
  }

  if (action === 'add') {
    if (!Array.isArray(args.studies) || !args.studies.length) throw new Error('studies must be a non-empty array')
    return { action, ...await addMetaStudies({ cwd, slug, studies: args.studies, helper }) }
  }

  if (['pool', 'subgroup', 'meta_regression', 'leave_one_out', 'publication_bias', 'diagnostic'].includes(action)) {
    const event = await runMetaAction({
      cwd,
      slug,
      action,
      params: {
        model: args.model,
        tau2_method: args.tau2_method,
        ci_method: args.ci_method,
        alpha: args.alpha,
        field: args.field,
        covariates: args.covariates,
      },
      helper,
    })
    return { action, ...event }
  }

  if (action === 'plot') {
    return {
      action,
      ...plotMetaAnalysis({
        cwd, slug, kind: args.kind || 'forest', analysis_id: args.analysis_id,
        helper, overwrite: Boolean(args.overwrite),
      }),
    }
  }

  if (action === 'report') {
    return { action, markdown: renderMetaReport({ cwd, slug }) }
  }

  if (action === 'import_review') {
    return {
      action,
      ...await importReviewStudies({
        cwd,
        slug,
        review: requireString(args.review, 'review'),
        mapping: args.mapping || {},
        helper,
      }),
    }
  }

  if (action === 'status') {
    readMetaProtocol(cwd, slug)
    return { action, status: deriveMetaStatus(cwd, slug) }
  }

  if (action === 'list') {
    readMetaProtocol(cwd, slug)
    return { action, analyses: listMetaAnalyses(cwd, slug) }
  }

  if (action === 'show') {
    return { action, analysis: showMetaAnalysis(cwd, slug, requireString(args.analysis_id, 'analysis_id')) }
  }

  if (action === 'export') {
    return {
      action,
      ...exportMetaAnalysis({
        cwd, slug, format: args.format || 'json', overwrite: Boolean(args.overwrite), helper,
      }),
    }
  }

  throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
}

export const name = 'academic-harness-meta-analysis'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'meta_analysis',
    description: [
      'Maintain a pairwise meta-analysis ledger and compute pooled effects under `.dsh/meta/<slug>/`.',
      'Actions: `start` (freeze effect measure, model, τ² method, CI method, alpha; refuses overwrite unless resume: true), `add` (compute and append studies; raw 2×2, continuous, correlation, HR, or effect+CI/SE), `effect_size` (stateless conversion), `pool` (fixed or random; DL/PM/REML τ²; normal or Hartung–Knapp CI; Q/I²/τ²/prediction interval), `subgroup`, `meta_regression` (numeric covariates), `leave_one_out`, `publication_bias` (Egger, Begg, funnel; trim-and-fill not implemented), `diagnostic` (2×2 counts; univariate logit pooled sensitivity/specificity and SROC points), `plot` (forest/funnel/SROC SVG), `report` (Markdown skeleton), `import_review` (read a review extraction table), `status`, `list`, `show`, `export`.',
      'This tool reports computed estimates and warnings; it never declares an effect significant, effective, certain, or clinically recommended. At least two studies are required; few-study and publication-bias warnings are surfaced. The model and τ²/CI methods are echoed in every result, and overrides are recorded in the analysis log. Use `import_review` only after the review extraction rows are complete; conflicted or incomplete rows are skipped and reported. Diagnostic accuracy pooling is univariate logit pooling in this release, not a full bivariate/HSROC model. Load the `meta-analysis` skill for the workflow.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'start, add, effect_size, pool, subgroup, meta_regression, leave_one_out, publication_bias, diagnostic, plot, report, import_review, status, list, show, or export. Default status.',
      },
      slug: { type: 'string', description: 'Meta-analysis slug (stable short name).' },
      question: { type: 'string', description: 'Review/analysis question (start).' },
      outcome: { type: 'string', description: 'Outcome label (start/import_review filter).' },
      effect_measure: {
        type: 'string',
        enum: META_EFFECT_MEASURES,
        description: 'Effect measure (start/effect_size): OR, RR, HR, IRR, MD, SMD, RD, or ZR.',
      },
      model: { type: 'string', enum: META_MODELS, description: 'fixed or random (start/pool). Default random.' },
      tau2_method: { type: 'string', enum: META_TAU2_METHODS, description: 'dl, pm, or reml (random model). Default reml.' },
      ci_method: { type: 'string', enum: META_CI_METHODS, description: 'normal or hartung_knapp. Default normal.' },
      alpha: { type: 'number', description: 'Two-sided alpha (default 0.05).' },
      notes: { type: 'string', description: 'Protocol notes (start).' },
      resume: { type: 'boolean', description: 'Continue an existing meta-analysis instead of failing (start).' },
      protocol: { type: 'object', additionalProperties: true, description: 'Optional object of the start fields (question, outcome, effect_measure, model, tau2_method, ci_method, alpha, notes); flat arguments win.' },
      studies: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'Studies (add). Common: id, label, effect+se/ci_low/ci_high, or type=binary/continuous/correlation/hr with raw fields. Metadata (alloc, dose, rob, design, …) is preserved for subgroup/meta_regression.',
      },
      input: { type: 'object', additionalProperties: true, description: 'effect_size input, e.g. {type:"binary",a,b,c,d} or {type:"continuous",m1,sd1,n1,m2,sd2,n2}.' },
      measure: { type: 'string', enum: META_EFFECT_MEASURES, description: 'Alias for effect_measure on effect_size.' },
      field: { type: 'string', description: 'Metadata field for subgroup (e.g. alloc, design, rob).' },
      covariates: { type: 'array', items: { type: 'string' }, description: 'Numeric metadata fields for meta_regression.' },
      analysis_id: { type: 'string', description: 'Analysis id (show/plot). Defaults to the latest relevant analysis for plot.' },
      kind: { type: 'string', enum: ['forest', 'funnel', 'sroc'], description: 'Plot kind (plot).' },
      review: { type: 'string', description: 'Review slug to import (import_review).' },
      mapping: {
        type: 'object',
        additionalProperties: true,
        description: 'import_review field mapping, e.g. {effect, se, ci_low, ci_high, n, label, outcome, effect_measure, rob}. Defaults match the PICO template.',
      },
      format: { type: 'string', enum: META_EXPORT_FORMATS, description: 'Export format: json, csv, report, forest, funnel, or sroc. Default json.' },
      overwrite: { type: 'boolean', description: 'Replace an existing export/plot (default false).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderReview(value),
    },
    async execute(args, exec) {
      try {
        return await runMetaAnalysis(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Meta-analysis: ${args.slug || ''} (${args.action || 'status'})`, kind: 'other' }
    },
  }))
}
