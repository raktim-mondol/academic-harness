import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../meta-analysis.js'
import { runReview } from '../review.js'
import { runHelper } from '../python-runtime.js'
import { fakeExec, makeWorkspace } from './helpers/test-workspace.mjs'

const probe = runHelper('meta_helper.py', {
  action: 'effect_size',
  measure: 'MD',
  input: { type: 'continuous', m1: 10, sd1: 2, n1: 50, m2: 12, sd2: 3, n2: 50 },
})
if (probe.error) {
  console.log(`meta-analysis helper skipped: ${probe.error}`)
  process.exit(0)
}

const workspace = makeWorkspace('ah-meta-')
const cwd = workspace.cwd
const exec = fakeExec(cwd)
let tool
apply({ tools: { register: (registered) => { tool = registered } } })
const run = (args) => tool.execute(args, exec)

function near(actual, expected, tolerance, label) {
  assert.ok(
    Number.isFinite(Number(actual)) && Math.abs(Number(actual) - expected) <= tolerance,
    `${label}: expected ${expected}, got ${actual}`,
  )
}

const y = [-0.8893, -1.5854, -1.3481, -1.4416, -0.2175, -0.7861, -1.6209, 0.0120, -0.4694, -1.3713, -0.3394, 0.4459, -0.0173]
const v = [0.3256, 0.1946, 0.4154, 0.0200, 0.0512, 0.0069, 0.2230, 0.0040, 0.0564, 0.0730, 0.0124, 0.5325, 0.0714]
const alloc = ['random', 'random', 'random', 'random', 'other', 'other', 'random', 'random', 'random', 'other', 'other', 'other', 'other']
const ablat = [44, 55, 42, 52, 13, 44, 19, 13, 27, 42, 18, 33, 33]
const bcg = y.map((effect, index) => ({
  id: `S${index + 1}`,
  label: `Study ${index + 1}`,
  effect,
  se: Math.sqrt(v[index]),
  variance: v[index],
  log_scale: true,
  alloc: alloc[index],
  ablat: ablat[index],
}))

try {
  // Published BCG example: fixed, DL, PM, and REML reference values.
  const base = {
    action: 'pool',
    studies: bcg,
    effect_measure: 'RR',
    log_scale: true,
    alpha: 0.05,
  }
  let pooled = runHelper('meta_helper.py', { ...base, model: 'fixed' })
  near(pooled.pooled, -0.43213724006628795, 1e-9, 'fixed pooled')
  near(pooled.se, 0.04057143246183216, 1e-9, 'fixed SE')
  assert.equal(pooled.heterogeneity.df, 12)
  near(pooled.heterogeneity.i2, 92.09563850498803, 1e-8, 'I2')

  pooled = runHelper('meta_helper.py', { ...base, model: 'random', tau2_method: 'dl' })
  near(pooled.pooled, -0.7140842183837549, 1e-8, 'DL pooled')
  near(pooled.se, 0.17865632856326288, 1e-8, 'DL SE')
  near(pooled.heterogeneity.tau2, 0.3083955708583142, 1e-10, 'DL tau2')

  pooled = runHelper('meta_helper.py', { ...base, model: 'random', tau2_method: 'pm' })
  near(pooled.pooled, -0.7149703054400063, 1e-8, 'PM pooled')
  near(pooled.se, 0.18089453337123543, 1e-8, 'PM SE')
  near(pooled.heterogeneity.tau2, 0.3180824398739576, 1e-10, 'PM tau2')

  pooled = runHelper('meta_helper.py', { ...base, model: 'random', tau2_method: 'reml' })
  near(pooled.pooled, -0.7145342669531645, 1e-8, 'REML pooled')
  near(pooled.se, 0.17978284276673126, 1e-8, 'REML SE')
  near(pooled.heterogeneity.tau2, 0.31325277882649116, 1e-10, 'REML tau2')
  near(pooled.display_pooled, 0.4893, 0.001, 'REML display RR')
  assert.ok(Array.isArray(pooled.prediction_interval))
  assert.equal(pooled.warnings.length, 0)

  const hk = runHelper('meta_helper.py', {
    ...base, model: 'random', tau2_method: 'reml', ci_method: 'hartung_knapp',
  })
  assert.equal(hk.ci_method, 'hartung_knapp')
  assert.ok(hk.ci[1] - hk.ci[0] > pooled.ci[1] - pooled.ci[0], 'HK CI should be wider than normal')

  const subgroup = runHelper('meta_helper.py', { ...base, action: 'subgroup', field: 'alloc' })
  near(subgroup.q_between, 1.9459882106587507, 1e-8, 'subgroup Q-between')
  near(subgroup.p, 0.16301981596190865, 1e-8, 'subgroup p')
  assert.deepEqual(subgroup.groups.map((group) => group.group), ['other', 'random'])
  near(subgroup.groups.find((group) => group.group === 'random').pooled, -0.971, 0.002, 'random subgroup')
  near(subgroup.groups.find((group) => group.group === 'other').pooled, -0.481, 0.002, 'other subgroup')

  const regression = runHelper('meta_helper.py', {
    ...base, action: 'meta_regression', covariates: ['ablat'],
  })
  const slope = regression.coefficients.find((coefficient) => coefficient.name === 'ablat')
  near(slope.estimate, -0.0292, 0.001, 'meta-regression slope')
  assert.ok(slope.p < 1e-4, `meta-regression p should be small, got ${slope.p}`)
  near(regression.tau2, 0.06334, 0.002, 'meta-regression tau2')
  near(regression.r2, 0.798, 0.02, 'meta-regression R2')

  const loo = runHelper('meta_helper.py', { ...base, action: 'leave_one_out' })
  assert.equal(loo.rows.length, 13)
  assert.ok(loo.rows.every((row) => Number.isFinite(row.delta)))

  const bias = runHelper('meta_helper.py', { ...base, action: 'publication_bias' })
  near(bias.egger.p, 0.19143968245430246, 1e-8, 'Egger p')
  assert.equal(bias.trimfill.implemented, false)
  assert.match(bias.warnings.join(' '), /not proof of publication bias/i)

  // Effect-size conversions.
  const or = runHelper('meta_helper.py', { action: 'effect_size', measure: 'OR', input: { type: 'binary', a: 10, b: 20, c: 15, d: 25 } })
  near(or.effect, -0.1823215567939546, 1e-9, 'OR log effect')
  near(or.se, 0.5066228051190221, 1e-9, 'OR SE')
  near(or.display_effect, 0.8333333333333333, 1e-9, 'OR display')
  const md = runHelper('meta_helper.py', { action: 'effect_size', measure: 'MD', input: { type: 'continuous', m1: 10, sd1: 2, n1: 50, m2: 12, sd2: 3, n2: 50 } })
  near(md.effect, -2, 1e-12, 'MD effect')
  near(md.se, 0.5099019513592785, 1e-9, 'MD SE')
  const smd = runHelper('meta_helper.py', { action: 'effect_size', measure: 'SMD', input: { type: 'continuous', m1: 10, sd1: 2, n1: 50, m2: 12, sd2: 3, n2: 50 } })
  near(smd.effect, -0.7784456310344288, 1e-9, 'SMD effect')
  near(smd.se, 0.2074364673879281, 1e-9, 'SMD SE')
  const zr = runHelper('meta_helper.py', { action: 'effect_size', measure: 'ZR', input: { type: 'correlation', r: 0.5, n: 50 } })
  near(zr.effect, 0.5493061443340549, 1e-9, 'Fisher z')
  near(zr.se, 0.14586499149789456, 1e-9, 'Fisher z SE')

  // Plots are deterministic SVG strings.
  const forest = runHelper('meta_helper.py', { action: 'plot', kind: 'forest', pool: pooled })
  assert.match(forest.svg, /<svg/)
  assert.match(forest.svg, /Pooled/)
  const funnel = runHelper('meta_helper.py', { action: 'plot', kind: 'funnel', pool: bias })
  assert.match(funnel.svg, /<svg/)
  assert.match(funnel.svg, /Funnel plot/)

  const diagnosticDirect = runHelper('meta_helper.py', {
    action: 'diagnostic',
    studies: [
      { id: 'D1', label: 'D1', tp: 40, fp: 10, fn: 20, tn: 70 },
      { id: 'D2', label: 'D2', tp: 30, fp: 15, fn: 10, tn: 80 },
      { id: 'D3', label: 'D3', tp: 50, fp: 20, fn: 5, tn: 60 },
    ],
    model: 'random',
    tau2_method: 'reml',
    ci_method: 'normal',
    alpha: 0.05,
  })
  near(diagnosticDirect.sensitivity.pooled, 0.7866270894917581, 1e-8, 'pooled sensitivity')
  near(diagnosticDirect.specificity.pooled, 0.823565129788889, 1e-8, 'pooled specificity')
  near(diagnosticDirect.dor.pooled, 17.866906766574466, 1e-7, 'pooled DOR')
  const sroc = runHelper('meta_helper.py', { action: 'plot', kind: 'sroc', diagnostic: diagnosticDirect })
  assert.match(sroc.svg, /SROC plot/)

  // Tool-level ledger flow.
  let result = await run({
    action: 'start',
    slug: 'bcg',
    question: 'BCG vaccine effectiveness',
    outcome: 'tuberculosis',
    effect_measure: 'RR',
    model: 'random',
    tau2_method: 'reml',
    ci_method: 'normal',
  })
  assert.equal(result.action, 'start')
  assert.equal(result.protocol.effect_measure, 'RR')
  assert.equal(result.resumed, false)

  result = await run({ action: 'start', slug: 'bcg', effect_measure: 'RR' })
  assert.match(result.error, /already exists/)
  result = await run({ action: 'start', slug: 'bcg', resume: true })
  assert.equal(result.resumed, true)

  result = await run({ action: 'add', slug: 'bcg', studies: bcg })
  assert.equal(result.added, 13)
  assert.equal(result.total, 13)
  result = await run({ action: 'add', slug: 'bcg', studies: bcg })
  assert.equal(result.added, 0)
  assert.equal(result.skipped.length, 13)

  result = await run({ action: 'pool', slug: 'bcg' })
  assert.equal(result.action, 'pool')
  near(result.result.pooled, -0.7145342669531645, 1e-6, 'tool REML pooled')
  assert.ok(result.result.plot)
  assert.ok(existsSync(join(cwd, result.result.plot)))

  result = await run({ action: 'subgroup', slug: 'bcg', field: 'alloc' })
  near(result.result.p, 0.16301981596190865, 1e-6, 'tool subgroup p')
  result = await run({ action: 'meta_regression', slug: 'bcg', covariates: ['ablat'] })
  assert.ok(result.result.coefficients.some((coefficient) => coefficient.name === 'ablat'))
  result = await run({ action: 'leave_one_out', slug: 'bcg' })
  assert.equal(result.result.rows.length, 13)
  result = await run({ action: 'publication_bias', slug: 'bcg' })
  assert.ok(result.result.plot)
  assert.match(result.result.plot, /funnel-/)
  assert.ok(existsSync(join(cwd, result.result.plot)))

  result = await run({ action: 'status', slug: 'bcg' })
  assert.equal(result.status.studies, 13)
  assert.equal(result.status.analyses, 5)
  assert.ok(result.status.pooled)
  result = await run({ action: 'list', slug: 'bcg' })
  assert.equal(result.analyses.length, 5)
  const poolAnalysis = result.analyses.find((analysis) => analysis.kind === 'pool')
  result = await run({ action: 'show', slug: 'bcg', analysis_id: poolAnalysis.analysis_id })
  assert.equal(result.analysis.kind, 'pool')

  result = await run({ action: 'plot', slug: 'bcg', kind: 'forest', analysis_id: poolAnalysis.analysis_id, overwrite: true })
  assert.match(result.path, /forest-/)
  assert.ok(existsSync(join(cwd, result.path)))
  result = await run({ action: 'report', slug: 'bcg' })
  assert.match(result.markdown, /## Pooled result/)
  assert.match(result.markdown, /REML|reml/i)
  assert.match(result.markdown, /\|\s*\d+\.\d%\s*\|/, 'report shows pool weights per study')

  result = await run({ action: 'export', slug: 'bcg', format: 'json' })
  assert.match(result.path, /meta-analysis\.json$/)
  result = await run({ action: 'export', slug: 'bcg', format: 'csv' })
  assert.match(result.path, /studies\.csv$/)
  result = await run({ action: 'export', slug: 'bcg', format: 'report' })
  assert.match(result.path, /report\.md$/)
  result = await run({ action: 'export', slug: 'bcg', format: 'forest', overwrite: true })
  assert.match(result.path, /forest-/)
  result = await run({ action: 'export', slug: 'bcg', format: 'funnel', overwrite: true })
  assert.match(result.path, /funnel-/)

  result = await run({ action: 'effect_size', effect_measure: 'OR', input: { type: 'binary', a: 10, b: 20, c: 15, d: 25 } })
  near(result.result.display_effect, 0.8333333333333333, 1e-9, 'tool effect_size')

  result = await run({ action: 'start', slug: 'empty', effect_measure: 'RR' })
  assert.equal(result.action, 'start')
  result = await run({ action: 'pool', slug: 'empty' })
  assert.match(result.error, /at least two studies/)
  await assert.rejects(
    () => run({ action: 'start', slug: 'bad', effect_measure: 'NOPE' }),
    /"effect_measure" must be one of/,
  )

  // The e2e UI run passed a protocol object; it is now accepted, with flat args winning.
  result = await run({
    action: 'start', slug: 'protocol-object',
    protocol: { effect_measure: 'RR', model: 'fixed', question: 'Protocol object?' },
  })
  assert.equal(result.protocol.effect_measure, 'RR')
  assert.equal(result.protocol.model, 'fixed')
  assert.equal(result.protocol.question, 'Protocol object?')
  result = await run({ action: 'start', slug: 'protocol-flat', protocol: { effect_measure: 'RR' }, effect_measure: 'OR' })
  assert.equal(result.protocol.effect_measure, 'OR')

  // Diagnostic ledger flow.
  result = await run({ action: 'start', slug: 'diag', effect_measure: 'OR', model: 'random', tau2_method: 'reml' })
  assert.equal(result.action, 'start')
  result = await run({
    action: 'add',
    slug: 'diag',
    studies: [
      { id: 'D1', label: 'D1', type: 'diagnostic', tp: 40, fp: 10, fn: 20, tn: 70 },
      { id: 'D2', label: 'D2', type: 'diagnostic', tp: 30, fp: 15, fn: 10, tn: 80 },
      { id: 'D3', label: 'D3', type: 'diagnostic', tp: 50, fp: 20, fn: 5, tn: 60 },
    ],
  })
  assert.equal(result.added, 3)
  result = await run({ action: 'pool', slug: 'diag' })
  assert.match(result.error, /does not match protocol/)
  result = await run({ action: 'diagnostic', slug: 'diag' })
  near(result.result.sensitivity.pooled, 0.7866270894917581, 1e-6, 'tool sensitivity')
  near(result.result.specificity.pooled, 0.823565129788889, 1e-6, 'tool specificity')
  assert.ok(result.result.plot)
  assert.match(result.result.plot, /sroc-/)
  assert.ok(existsSync(join(cwd, result.result.plot)))
  result = await run({ action: 'export', slug: 'diag', format: 'sroc', overwrite: true })
  assert.match(result.path, /sroc-/)

  // Import a completed review extraction table.
  await runReview({
    action: 'start', slug: 'review-import', question: 'Import?', extraction_template: 'pico',
  }, exec)
  await runReview({
    action: 'add', slug: 'review-import', records: [{ title: 'Study A', year: 2024 }, { title: 'Study B', year: 2023 }],
  }, exec)
  for (const id of ['r0001', 'r0002']) {
    await runReview({
      action: 'screen', slug: 'review-import', id, stage: 'title_abstract', decision: 'include', reviewer: 'alice',
    }, exec)
    await runReview({
      action: 'screen', slug: 'review-import', id, stage: 'full_text', decision: 'include', reviewer: 'alice',
    }, exec)
  }
  await runReview({
    action: 'extract', slug: 'review-import', id: 'r0001', reviewer: 'alice',
    values: {
      population: 'Adults', intervention: 'X', comparator: 'P', outcome: 'Y', design: 'RCT',
      n: 100, effect: 0.8, effect_measure: 'RR', ci_low: 0.6, ci_high: 0.95,
    },
  }, exec)
  await runReview({
    action: 'extract', slug: 'review-import', id: 'r0002', reviewer: 'alice',
    values: {
      population: 'Adults', intervention: 'X', comparator: 'P', outcome: 'Y', design: 'RCT',
      n: 120, effect: 0.7, effect_measure: 'RR', ci_low: 0.55, ci_high: 0.9,
    },
  }, exec)
  result = await run({
    action: 'start', slug: 'imported', question: 'Imported', outcome: 'Y', effect_measure: 'RR',
  })
  assert.equal(result.action, 'start')
  result = await run({ action: 'import_review', slug: 'imported', review: 'review-import' })
  assert.equal(result.added, 2)
  assert.equal(result.total, 2)
  result = await run({ action: 'pool', slug: 'imported' })
  near(result.result.display_pooled, 0.7517932427834575, 1e-6, 'imported pooled RR')

  console.log('meta-analysis OK')
} finally {
  workspace.cleanup()
}
