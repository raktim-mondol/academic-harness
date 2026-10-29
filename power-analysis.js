/**
 * power_analysis: statistical power, sample size, effect sizes, multiplicity correction,
 * and simulation, for planning a study before data exist.
 *
 * Computation is local (python-helpers/power_helper.py, numpy + scipy). This module adds the
 * integrity rules the numbers depend on: an assumed effect size must say where it came from,
 * and a power calculation from the effect observed in the same study is refused.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runHelper } from './python-runtime.js'

export const EFFECT_SOURCES = ['pilot', 'literature', 'smallest_effect_of_interest', 'convention']
const POST_HOC = ['observed_in_this_study', 'post_hoc', 'observed']
const NEEDS_SOURCE = new Set(['power', 'simulate', 'diagnostic_precision'])

const SOURCE_LABEL = {
  pilot: 'a pilot study (pilot estimates are noisy; consider a lower bound)',
  literature: 'published literature',
  smallest_effect_of_interest: 'the smallest effect that would matter',
  convention: "convention (a rule-of-thumb effect size; it says nothing about this study)",
}

export function checkEffectSource(args) {
  const action = args.action || 'power'
  const solving = args.solve ?? (args.n == null ? 'n' : 'power')
  const effectIsInput = action === 'power' ? solving !== 'effect_size' : NEEDS_SOURCE.has(action)
  const declared = String(args.effect_source || '').trim().toLowerCase()
  if (args.post_hoc === true || POST_HOC.includes(declared)) {
    return {
      error: 'Power computed from the effect observed in the same study is not allowed: observed power is a direct function of the p-value and adds no information. '
        + 'Report the confidence interval of the effect instead, or use action "sensitivity" to state the smallest effect this sample could have detected.',
      code: 'post-hoc-power',
    }
  }
  if (!effectIsInput) return { ok: true }
  if (!declared) {
    return {
      error: `effect_source is required: say where the assumed effect size comes from (${EFFECT_SOURCES.join(', ')}). A bare "medium effect" is accepted only as "convention", and is labelled that way.`,
      code: 'effect-source-required',
    }
  }
  if (!EFFECT_SOURCES.includes(declared)) {
    return { error: `effect_source must be one of ${EFFECT_SOURCES.join(', ')}`, code: 'effect-source-invalid' }
  }
  if (declared === 'literature' && !String(args.source_ref || '').trim()) {
    return { error: 'effect_source "literature" needs source_ref: the DOI or PaperMemory id of the paper the effect size came from.', code: 'source-ref-required' }
  }
  return { ok: true, source: declared }
}

function helperRequest(args) {
  const action = args.action || 'power'
  const options = (args.options && typeof args.options === 'object') ? args.options : {}
  if (action === 'power') {
    return { action, test: args.test, solve: args.solve, effect_size: args.effect_size, n: args.n, power: args.power, alpha: args.alpha, tails: args.tails, ...options }
  }
  if (action === 'sensitivity') {
    return { action, test: args.test, n: args.n, power: args.power, alpha: args.alpha, tails: args.tails, curve: args.curve, ...options }
  }
  if (action === 'effect_size') return { action, from: args.from, inputs: args.inputs || {} }
  if (action === 'correct') return { action, p_values: args.p_values, method: args.method, alpha: args.alpha }
  if (action === 'simulate') return { action, design: args.design, params: args.design_params || {}, nsim: args.nsim, seed: args.seed }
  if (action === 'diagnostic_precision') {
    return { action, expected: args.expected, width: args.width, n: args.n, prevalence: args.prevalence, confidence: args.confidence }
  }
  return { action }
}

export async function runPowerAnalysis(args, deps = {}) {
  const action = args.action || 'power'
  if (!['power', 'effect_size', 'correct', 'sensitivity', 'simulate', 'diagnostic_precision'].includes(action)) {
    return { error: 'action must be power, effect_size, correct, sensitivity, simulate, or diagnostic_precision' }
  }
  const rule = checkEffectSource({ ...args, action })
  if (rule.error) return { error: rule.error, code: rule.code }
  const helper = deps.runHelper || runHelper
  const result = helper('power_helper.py', helperRequest({ ...args, action }))
  if (result?.error) return { error: result.error }
  if (rule.source) {
    result.effect_source = {
      source: rule.source,
      label: SOURCE_LABEL[rule.source],
      ...(args.source_ref ? { reference: String(args.source_ref) } : {}),
      ...(args.effect_note ? { note: String(args.effect_note) } : {}),
    }
    if (rule.source === 'convention') {
      result.notes = [...(result.notes || []), 'The effect size is a convention, not an estimate for this study; say so wherever the sample size is reported.']
    }
  }
  return result
}

const fmt = (value, digits = 3) => (typeof value === 'number' && !Number.isInteger(value) ? Number(value.toPrecision(digits + 1)) : value)

function renderPower(value) {
  const r = value.result
  const i = value.inputs || {}
  const lines = [`Power analysis (${value.action}): ${i.test || ''}`.trim()]
  const bits = []
  if (i.effect_size != null) bits.push(`${i.effect_symbol || 'effect'} = ${fmt(i.effect_size)}`)
  if (i.alpha != null) bits.push(`α = ${fmt(i.alpha, 4)}, ${i.tails === 1 ? 'one' : 'two'}-sided`)
  if (i.power_target != null) bits.push(`target power ${i.power_target}`)
  if (bits.length) lines.push(bits.join(' · '))
  lines.push('')
  if (r.n != null) lines.push(`n = ${r.n} ${i.n_unit || ''}${r.n_unrounded != null ? ` (unrounded ${r.n_unrounded})` : ''}`.trim())
  if (r.sample) lines.push(`sample: ${Object.entries(r.sample).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ')}`)
  if (r.power != null) lines.push(`power = ${fmt(r.power, 4)}`)
  if (r.effect_size != null && i.solve === 'effect_size') lines.push(`smallest detectable ${i.effect_symbol || 'effect'} = ${fmt(r.effect_size)}`)
  if (r.alpha != null && i.solve === 'alpha') lines.push(`α needed = ${fmt(r.alpha, 4)}`)
  if (r.design_effect) lines.push(`design effect (clustering) = ${r.design_effect}`)
  if (r.enrol) lines.push(`to enrol (after ${[r.design_effect ? 'clustering' : '', r.dropout ? `${Math.round(r.dropout * 100)}% dropout` : ''].filter(Boolean).join(' and ')}): ${Object.entries(r.enrol).filter(([k]) => k !== 'inflation_factor').map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ')}`)
  return lines
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  let lines
  if (value.action === 'power' || value.action === 'sensitivity') {
    lines = value.result.curve
      ? [
        'Power curve (rows: n; columns: effect size)',
        ...value.result.curve.map((row) => `n = ${row.n}: ${row.power.map((cell) => `${cell.effect_size} → ${cell.power}`).join('   ')}`),
      ]
      : renderPower(value)
  } else if (value.action === 'effect_size') {
    lines = [`Effect size conversions (from ${value.from})`, ...Object.entries(value.result).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.map((x) => fmt(x)).join(' to ') : fmt(v)}`)]
  } else if (value.action === 'correct') {
    const r = value.result
    lines = [
      `Multiple-comparison correction (${r.method}, α = ${r.alpha}): ${r.rejected} of ${r.adjusted_p.length} rejected`,
      `adjusted p: ${r.adjusted_p.map((p) => fmt(p, 4)).join(', ')}`,
      `reject:     ${r.reject.join(', ')}`,
      `per-test α to plan with (${r.planning_alpha_per_test.tests} tests): Bonferroni ${fmt(r.planning_alpha_per_test.bonferroni_alpha, 4)}, Šidák ${fmt(r.planning_alpha_per_test.sidak_alpha, 4)}`,
    ]
  } else if (value.action === 'simulate') {
    const r = value.result
    lines = [
      `Simulated power (${r.design}): ${fmt(r.power, 3)} ± ${fmt(r.monte_carlo_se, 2)} (95% CI ${fmt(r.ci95[0], 3)}–${fmt(r.ci95[1], 3)}), ${r.nsim} runs, seed ${r.seed}, α = ${r.alpha}`,
    ]
  } else {
    lines = [`Diagnostic accuracy precision`, ...Object.entries(value.result).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${fmt(v)}`)]
  }
  if (value.method) lines.push('', `method: ${value.method}`)
  if (value.effect_source) {
    lines.push(`effect size source: ${value.effect_source.label}${value.effect_source.reference ? ` [${value.effect_source.reference}]` : ''}${value.effect_source.note ? ` — ${value.effect_source.note}` : ''}`)
  }
  for (const note of value.notes || []) lines.push(`note: ${note}`)
  lines.push('', value.advisory || '')
  if (value.software) lines.push(`(${value.software})`)
  return [{ type: 'text', text: lines.join('\n').trim() }]
}

export const name = 'academic-harness-power-analysis'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'power_analysis',
    description: [
      'Plan a study before data exist: sample size, power, or the smallest detectable effect (`power`, `sensitivity`); convert and compute effect sizes (`effect_size`); adjust p-values or plan the per-test alpha for many tests (`correct`: Bonferroni, Holm, Hochberg, Benjamini–Hochberg, Benjamini–Yekutieli); Monte-Carlo power with a required seed (`simulate`); and sample size for estimating sensitivity or specificity (`diagnostic_precision`).',
      'Designs: one-sample, paired, and two-sample t (pooled or Welch), one- and two-proportion, one-way ANOVA, chi-square, correlation, multiple regression (f²), log-rank (events), equivalence (TOST) and non-inferiority for means; clustering and dropout inflation are reported separately from the analytic n.',
      'Every assumed effect size needs `effect_source` (pilot, literature with `source_ref`, smallest_effect_of_interest, or convention) and is labelled with it. Power computed from the effect observed in the same study (post-hoc power) is refused. Results echo their assumptions and method. It is a planning aid, not a substitute for a statistician on a complex design.',
      'Local: numpy and scipy only. No network.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ['power', 'effect_size', 'correct', 'sensitivity', 'simulate', 'diagnostic_precision'], description: 'Default power.' },
      test: {
        type: 'string',
        enum: ['t_one_sample', 't_paired', 't_two_sample', 'proportion_one', 'proportion_two', 'anova_oneway', 'chisq', 'correlation', 'regression', 'logrank', 'equivalence_means', 'noninferiority_means'],
        description: 'power / sensitivity: the test. n means subjects (one-sample, paired pairs), per group (two-sample, ANOVA), total (chisq, correlation, regression), or events (logrank).',
      },
      solve: { type: 'string', enum: ['n', 'power', 'effect_size', 'alpha'], description: 'power: what to solve for. Default n (or power if n is given).' },
      effect_size: { type: 'number', description: "power: the assumed effect on the test's own scale (d, h, f, w, r, f², or a hazard ratio; for equivalence/non-inferiority the true difference in sd units). For proportions give options.p1 and options.p2 instead." },
      n: { type: 'number', description: 'Sample size when solving for something else, or the fixed n for sensitivity / diagnostic_precision.' },
      power: { type: 'number', description: 'Target power (0–1), e.g. 0.8.' },
      alpha: { type: 'number', description: 'Significance level. Default 0.05.' },
      tails: { type: 'number', enum: [1, 2], description: 'Default 2.' },
      options: {
        type: 'object',
        additionalProperties: true,
        description: 'Test-specific numbers: ratio (n2/n1), variance ("equal"|"unequal") and sd_ratio, groups (ANOVA), df (chisq), predictors (regression), allocation (logrank, fraction in group 1) and event_prob (to convert events to participants), margin (equivalence / non-inferiority, in sd units), p1 / p2 / p0 (proportions), cluster_size and icc (design effect), dropout (0–0.95).',
      },
      effect_source: { type: 'string', enum: [...EFFECT_SOURCES, 'observed_in_this_study'], description: 'Required whenever an effect size is assumed. "observed_in_this_study" is refused (post-hoc power).' },
      source_ref: { type: 'string', description: 'DOI or PaperMemory id of the paper the effect size came from (required for effect_source "literature").' },
      effect_note: { type: 'string', description: 'Free text recorded with the result, e.g. which estimate and why.' },
      post_hoc: { type: 'boolean', description: 'Set true only to be told why post-hoc power is refused.' },
      from: { type: 'string', enum: ['d', 'r', 'f', 'f2', 'eta2', 'odds_ratio', 't_two_sample', 't_paired', 'F', 'means', 'proportions', 'chi2'], description: 'effect_size: what you are converting from.' },
      inputs: { type: 'object', additionalProperties: true, description: 'effect_size: the numbers for `from` (e.g. {d}, {t, n1, n2}, {m1, m2, sd1, sd2, n1, n2}, {p1, p2}, {chi2, N}).' },
      p_values: { type: 'array', items: { type: 'number' }, description: 'correct: the p-values.' },
      method: { type: 'string', enum: ['bonferroni', 'holm', 'hochberg', 'bh', 'by'], description: 'correct: default holm.' },
      curve: {
        type: 'object', additionalProperties: false,
        properties: { n_values: { type: 'array', items: { type: 'number' } }, effects: { type: 'array', items: { type: 'number' } } },
        description: 'sensitivity: a grid of n and effect sizes to tabulate power (at most 400 cells).',
      },
      design: { type: 'string', enum: ['two_group', 'paired', 'proportions', 'cluster_two_arm', 'correlation'], description: 'simulate: the design.' },
      design_params: { type: 'object', additionalProperties: true, description: 'simulate: e.g. two_group {n1, n2, diff, sd1, sd2, test: welch|student|mannwhitney, t_df}; paired {n, d, rho, test}; proportions {n1, n2, p1, p2, test}; cluster_two_arm {clusters_per_arm, cluster_size, icc, d}; correlation {n, r}.' },
      nsim: { type: 'number', description: 'simulate: runs (100–20000). Default 2000.' },
      seed: { type: 'number', description: 'simulate: required, so the run can be reproduced.' },
      expected: { type: 'number', description: 'diagnostic_precision: the expected sensitivity or specificity.' },
      width: { type: 'number', description: 'diagnostic_precision: the wanted confidence-interval half-width.' },
      prevalence: { type: 'number', description: 'diagnostic_precision: convert cases to total participants.' },
      confidence: { type: 'number', description: 'diagnostic_precision: default 0.95.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args) {
      return runPowerAnalysis(args)
    },
    presentCall(args) {
      return { card: 'generic', title: `Power analysis: ${args.action || 'power'}${args.test ? ` · ${args.test}` : ''}`, kind: 'other' }
    },
  }))
}
