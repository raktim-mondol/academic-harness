/**
 * power_analysis: closed-form results against published reference values, self-consistency of every
 * solve mode, the integrity rules (effect source, no post-hoc power), reproducible simulation, and
 * registration. Needs scipy; skips the numerical part (and says so) when it is missing.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pythonBin } from '../python-runtime.js'
import { checkEffectSource, runPowerAnalysis } from '../power-analysis.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
const pkg = JSON.parse(read('package.json'))

// ---- registration
assert.ok(pkg.exports?.['./power-analysis'], 'package exports missing ./power-analysis')
for (const file of ['power-analysis.js', 'python-helpers/power_helper.py']) {
  assert.ok(existsSync(join(root, file)), `missing ${file}`)
}
assert.ok(pkg.files.includes('power-analysis.js') && pkg.files.includes('python-helpers'), 'package files missing power analysis')
assert.match(read('power-analysis.js'), /name: 'power_analysis'/)
assert.match(read('power-analysis.js'), /export const inject = \['tools'\]/, 'a tool module must declare inject: [tools]')
assert.match(read('presets/academic-harness/agent.cordis.yml'), /- id: power-analysis\n  name: academic-harness\/power-analysis/)
assert.match(read('cordis.patch.yml'), /academic-harness\/power-analysis/, 'cordis.patch.yml was not regenerated')
assert.match(read('prompt.js'), /## Study planning/)
assert.match(read('prompt.js'), /effect_source/)
assert.ok(existsSync(join(root, 'skills/power-and-sample-size/SKILL.md')), 'power-and-sample-size skill missing')
assert.ok(!pkg.dependencies?.statsmodels, 'statsmodels must not become a dependency')
assert.ok(!/statsmodels/.test(read('python-helpers/pyproject.toml')), 'statsmodels must not be added to the helper dependencies')

// ---- integrity rules (no numerics needed)
const code = (args) => checkEffectSource(args).code
assert.equal(code({ action: 'power', effect_size: 0.5, power: 0.8 }), 'effect-source-required')
assert.equal(code({ action: 'power', effect_size: 0.5, power: 0.8, effect_source: 'vibes' }), 'effect-source-invalid')
assert.equal(code({ action: 'power', effect_size: 0.5, power: 0.8, effect_source: 'literature' }), 'source-ref-required')
assert.equal(code({ action: 'power', effect_size: 0.5, n: 30, effect_source: 'observed_in_this_study' }), 'post-hoc-power')
assert.equal(code({ action: 'sensitivity', n: 30, post_hoc: true }), 'post-hoc-power')
assert.equal(checkEffectSource({ action: 'power', effect_size: 0.5, power: 0.8, effect_source: 'literature', source_ref: '10.1000/xyz' }).ok, true)
assert.equal(checkEffectSource({ action: 'power', n: 30, power: 0.8, solve: 'effect_size' }).ok, true, 'solving for the effect size assumes none')
assert.equal(checkEffectSource({ action: 'sensitivity', n: 30, power: 0.8 }).ok, true)
assert.equal(checkEffectSource({ action: 'effect_size', from: 'd' }).ok, true)
assert.equal(checkEffectSource({ action: 'correct' }).ok, true)
assert.equal(code({ action: 'simulate', design: 'two_group' }), 'effect-source-required')
assert.equal(code({ action: 'diagnostic_precision', expected: 0.9 }), 'effect-source-required')
const refused = await runPowerAnalysis({ action: 'power', test: 't_two_sample', effect_size: 0.4, n: 40, effect_source: 'observed_in_this_study' })
assert.match(refused.error, /observed power is a direct function of the p-value/)

const scipy = spawnSync(pythonBin(), ['-c', 'import scipy, numpy'], { encoding: 'utf8' })
if (scipy.status !== 0) {
  console.log('power_analysis: scipy not available; numerical tests skipped')
  process.exit(0)
}

const fixtures = JSON.parse(read('scripts/fixtures/power/reference.json'))
const base = { action: 'power', effect_source: 'convention' }
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} vs ${expected} (±${tol})`)

// ---- closed-form results against published values
for (const f of fixtures.solve_n) {
  const out = await runPowerAnalysis({ ...base, ...f.request })
  assert.ok(!out.error, `${f.name}: ${out.error}`)
  assert.equal(out.result.n, f.n, `${f.name}: integer n`)
  near(out.result.n_unrounded, f.unrounded, f.tolerance, `${f.name}: unrounded n`)
  assert.ok(out.result.power >= (f.request.power ?? 0.8) - 1e-9, `${f.name}: rounded n must reach the target power`)
  assert.equal(out.effect_source.source, 'convention')
  assert.match(out.notes.join(' '), /convention/)
}
for (const f of fixtures.solve_effect) {
  const out = await runPowerAnalysis({ ...f.request, solve: 'effect_size' })
  near(out.result.effect_size, f.effect_size, f.tolerance, f.name)
  assert.equal(out.effect_source, undefined, 'solving for the effect size records no assumed source')
}
for (const f of fixtures.correct) {
  const out = await runPowerAnalysis({ action: 'correct', p_values: f.p, method: f.method })
  out.result.adjusted_p.forEach((value, i) => near(value, f.adjusted[i], 1e-9, `${f.name} p[${i}]`))
}
for (const f of fixtures.effect_size) {
  const out = await runPowerAnalysis({ action: 'effect_size', ...f.request })
  near(out.result[f.field], f.value, f.tolerance, f.name)
}
for (const f of fixtures.diagnostic) {
  const out = await runPowerAnalysis({ action: 'diagnostic_precision', effect_source: 'smallest_effect_of_interest', ...f.request })
  assert.equal(out.result.cases_needed, f.cases_needed)
  assert.equal(out.result.total_participants, f.total_participants)
}
const corr = await runPowerAnalysis({ ...base, test: 'correlation', effect_size: 0.3, power: 0.8 })
assert.ok([84, 85].includes(corr.result.n), `correlation n=${corr.result.n}; G*Power's exact test gives 84, the Fisher-z approximation may give 85`)

// ---- every solve mode is the inverse of the others
const tests = [
  { test: 't_two_sample', effect_size: 0.4 }, { test: 't_paired', effect_size: 0.35 },
  { test: 'anova_oneway', effect_size: 0.3, options: { groups: 4 } }, { test: 'chisq', effect_size: 0.2, options: { df: 3 } },
  { test: 'proportion_two', options: { p1: 0.5, p2: 0.35 } }, { test: 'regression', effect_size: 0.1, options: { predictors: 5 } },
  { test: 'logrank', effect_size: 0.7 },
]
for (const spec of tests) {
  const solved = await runPowerAnalysis({ ...base, ...spec, power: 0.9 })
  assert.ok(!solved.error, `${spec.test}: ${solved.error}`)
  const n = solved.result.n
  const back = await runPowerAnalysis({ ...base, ...spec, solve: 'power', n })
  assert.ok(back.result.power >= 0.9 - 1e-9, `${spec.test}: n=${n} must give at least the target power`)
  const lower = await runPowerAnalysis({ ...base, ...spec, solve: 'power', n: n - 1 })
  assert.ok(lower.result.power < 0.9, `${spec.test}: n-1 must fall short, so n is the smallest`)
  const effectOf = solved.inputs.effect_size
  const eff = await runPowerAnalysis({ ...spec, effect_size: undefined, options: spec.options, solve: 'effect_size', n, power: 0.9 })
  if (spec.test !== 'logrank') assert.ok(eff.result.effect_size <= effectOf + 1e-6, `${spec.test}: the smallest detectable effect at n cannot exceed the planned one`)
  const alpha = await runPowerAnalysis({ ...base, ...spec, solve: 'alpha', n, power: 0.9 })
  assert.ok(alpha.result.alpha <= 0.05 + 1e-9, `${spec.test}: the alpha that just reaches 90% at the planned n is at most 0.05`)
}

// ---- inflation is reported separately from the analytic n
const inflated = await runPowerAnalysis({ ...base, test: 't_two_sample', effect_size: 0.5, power: 0.8, options: { dropout: 0.15, cluster_size: 10, icc: 0.05 } })
assert.equal(inflated.result.n, 64)
assert.equal(inflated.result.design_effect, 1.45)
assert.equal(inflated.result.enrol.group_1, 110)
assert.equal(inflated.result.enrol.total, 219)
const logrank = await runPowerAnalysis({ ...base, test: 'logrank', effect_size: 0.5, power: 0.8, options: { event_prob: 0.4 } })
assert.equal(logrank.result.sample.participants_needed, 165) // ceil(66 events / 0.4)
assert.match((await runPowerAnalysis({ ...base, test: 'logrank', effect_size: 0.5, power: 0.8 })).notes.join(' '), /number of events, not participants/)

// ---- refusals and honest failures
for (const [args, pattern] of [
  [{ ...base, test: 't_two_sample', effect_size: 0, power: 0.8 }, /effect size of 0/],
  [{ ...base, test: 'logrank', effect_size: 1, power: 0.8 }, /exactly 1/],
  [{ ...base, test: 'bogus' }, /test must be one of/],
  [{ ...base, test: 't_two_sample', effect_size: 0.5 }, /give: power/],
  [{ ...base, test: 't_two_sample', effect_size: 0.5, power: 0.8, options: { cluster_size: 10 } }, /both cluster_size and icc/],
  [{ ...base, test: 'equivalence_means', effect_size: 0, power: 0.8 }, /margin/],
  [{ ...base, test: 't_two_sample', effect_size: 1e-7, power: 0.99 }, /cannot be reached|very large/],
  [{ action: 'correct', p_values: [0.5, 1.5] }, /between 0 and 1/],
  [{ action: 'correct', p_values: [0.1], method: 'magic' }, /method must be/],
]) {
  const out = await runPowerAnalysis(args)
  assert.match(out.error || '', pattern, JSON.stringify(args))
}

// ---- simulation: reproducible, seeded, and consistent with the closed form
assert.match((await runPowerAnalysis({ action: 'simulate', design: 'two_group', effect_source: 'convention', design_params: { n1: 64, diff: 0.5 } })).error, /seed is required/)
const sim = (seed) => runPowerAnalysis({ action: 'simulate', design: 'two_group', effect_source: 'convention', seed, nsim: 4000, design_params: { n1: 64, diff: 0.5, sd1: 1 } })
const a = await sim(11)
const b = await sim(11)
const c = await sim(12)
assert.equal(a.result.power, b.result.power, 'the same seed must give the same estimate')
assert.notEqual(a.result.power, c.result.power, 'a different seed should differ')
near(a.result.power, 0.8015, 4 * a.result.monte_carlo_se, 'simulated power vs the closed-form 0.8015')
assert.ok(a.result.ci95[0] < a.result.power && a.result.power < a.result.ci95[1])
const clustered = await runPowerAnalysis({ action: 'simulate', design: 'cluster_two_arm', effect_source: 'convention', seed: 3, nsim: 1500, design_params: { clusters_per_arm: 12, cluster_size: 20, icc: 0.05, d: 0.5 } })
// 12 clusters of 20 per arm at icc 0.05: design effect 1.95, about 123 effective subjects per arm, so power is high
assert.ok(clustered.result.power > 0.9, `clustered power ${clustered.result.power}`)
const fewer = await runPowerAnalysis({ action: 'simulate', design: 'cluster_two_arm', effect_source: 'convention', seed: 3, nsim: 1500, design_params: { clusters_per_arm: 4, cluster_size: 20, icc: 0.2, d: 0.5 } })
assert.ok(fewer.result.power < clustered.result.power - 0.3, 'few clusters with a high icc lose most of the power')
assert.match((await runPowerAnalysis({ action: 'simulate', design: 'nope', effect_source: 'convention', seed: 1 })).error, /design must be/)

// ---- a curve and a sensitivity statement
const curve = await runPowerAnalysis({ action: 'sensitivity', test: 't_two_sample', curve: { n_values: [20, 50], effects: [0.3, 0.5] } })
assert.equal(curve.result.curve.length, 2)
assert.ok(curve.result.curve[1].power[1].power > curve.result.curve[0].power[1].power, 'power rises with n')
const sens = await runPowerAnalysis({ action: 'sensitivity', test: 't_two_sample', n: 50, power: 0.8 })
near(sens.result.effect_size, 0.5659, 0.002, 'smallest detectable d at n=50')
assert.match(sens.notes.join(' '), /not an estimate of the true effect/)
assert.match(sens.advisory, /planning aid/)

console.log('power_analysis ok')
