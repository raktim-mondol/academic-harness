import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../experiment-log.js'
import { freezeAnalysisPlan, runAnalysis } from '../analysis-store.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const ws = makeWorkspace('ah-replicates-')
const cwd = ws.cwd
let tool
apply({ tools: { register(value) { tool = value } } })
const call = (args) => tool.execute(args, fakeExec(cwd))
const identity = { dataset: { id: 'd', version_or_hash: 'v1' }, split: { id: 'test', version_or_hash: 'v1' }, baseline_cohort_id: 'b', metric_definitions: { loss: { unit: 'unitless', implementation: 'loss-v1', parameters: {} } } }
try {
  ws.write('eval.py', 'print(1)\n')
  await call({ action: 'start', slug: 's', question: 'repeated?', experiment: { metrics: [{ name: 'loss', direction: 'lower' }], benchmark: { datasets: ['d'], splits: ['test'], baseline_arm: 'base', task_rules: ['fixed'] }, protocol: { eval_script: 'eval.py', metric_params: {} } } })
  const base = { action: 'log', slug: 's', role: 'baseline', baseline_ref: 'reproduced', stage: 'full', comparison_identity: identity, params: { method: 'base' } }
  const b1 = (await call({ ...base, seed: 1, metrics: { loss: 4 } })).run
  const scope = b1.comparison_identity.scope_id
  const b2 = (await call({ ...base, seed: 2, metrics: { loss: 6 } })).run
  const b3 = (await call({ ...base, seed: 3, metrics: { loss: 8 } })).run
  const variant = { ...base, role: 'variant', params: { method: 'variant' } }
  const v1 = (await call({ ...variant, seed: 1, baseline_run_id: b1.run_id, metrics: { loss: 5 } })).run
  const v2 = (await call({ ...variant, seed: 2, baseline_run_id: b2.run_id, metrics: { loss: 9 } })).run
  const v3 = (await call({ ...variant, seed: 3, baseline_run_id: b3.run_id, metrics: { loss: 10 } })).run
  const v3retry = (await call({ ...variant, seed: 3, baseline_run_id: b3.run_id, metrics: {} })).run
  const v4 = (await call({ ...variant, seed: 4, baseline_run_id: b1.run_id, metrics: { loss: -4 } })).run
  const v9 = (await call({ ...variant, seed: 9, baseline_run_id: b1.run_id, metrics: { loss: 100 } })).run
  await freezeAnalysisPlan({ cwd, slug: 'failed', plan: { question: 'failure?' } })
  const failure = await runAnalysis({ cwd, slug: 'failed', command: ['python3', '-c', 'raise SystemExit(1)'], notebookEntry: null })
  const v5 = (await call({ ...variant, seed: 5, baseline_run_id: b1.run_id, metrics: { loss: 12 } })).run
  await call({ action: 'link', slug: 's', run_id: v5.run_id, target_kind: 'analysis_run', target_id: `failed:${failure.run_id}` })
  const ungrouped = (await call({ ...base, params: {}, seed: 7, metrics: { loss: 7 } })).run
  const identity2 = { ...identity, dataset: { id: 'd', version_or_hash: 'v2' } }
  const other = (await call({ ...base, role: 'baseline', params: { method: 'variant' }, comparison_identity: identity2, seed: 10, metrics: { loss: 0 } })).run
  const args = { action: 'replicates', slug: 's', scope_id: scope, metric: 'loss', candidate_field: 'method', candidates: ['base', 'variant', 'absent'], baseline_candidate: 'base', replicate_unit: 'training run', expected_seeds: [5, 4, 3, 2, 1] }
  const beforeRuns = ws.read('.dsh/experiments/s/runs.jsonl')
  const beforeLinks = ws.read('.dsh/experiments/s/links.jsonl')
  const result = await call(args)
  assert.equal(result.error, undefined, JSON.stringify(result))
  const report = result.report
  assert.equal(report.direction, 'lower')
  assert.equal(report.selection_history.value, 'unknown')
  const baseline = report.groups.find((group) => group.candidate === 'base')
  const group = report.groups.find((entry) => entry.candidate === 'variant')
  const absent = report.groups.find((entry) => entry.candidate === 'absent')
  assert.deepEqual(baseline.seed_coverage.missing, [4, 5])
  assert.deepEqual(group.seed_coverage.expected, [1, 2, 3, 4, 5])
  assert.deepEqual(group.seed_coverage.missing, [3, 5])
  assert.deepEqual(group.seed_coverage.unexpected, [9])
  assert.deepEqual(group.seed_coverage.duplicates, [{ seed: 3, run_ids: [v3.run_id, v3retry.run_id] }])
  assert.deepEqual(group.included_run_ids, [v1.run_id, v2.run_id, v4.run_id])
  assert.equal(group.counts.included, 3)
  assert.equal(group.counts.duplicate_seed, 2)
  assert.equal(group.counts.missing_metric, 1)
  assert.equal(group.counts.unexpected_seed, 1)
  assert.equal(group.counts.linked_analysis_failed, 1)
  assert.equal(group.counts.eligibility.incompatible, 1)
  assert.equal(group.statistics.n, 3)
  assert.ok(Math.abs(group.statistics.mean - 10 / 3) < 1e-12)
  assert.ok(Math.abs(group.statistics.sample_sd - Math.sqrt(133 / 3)) < 1e-12)
  assert.deepEqual(group.paired.pairs.map((pair) => pair.difference), [1, 3])
  assert.equal(group.paired.statistics.mean, 2)
  assert.ok(Math.abs(group.paired.statistics.sample_sd - Math.SQRT2) < 1e-12)
  assert.equal(group.paired.unpaired.find((row) => row.run_id === v4.run_id).reason, 'seed_mismatch')
  assert.ok(group.paired.unpaired_baselines.some((row) => row.run_id === b3.run_id && row.reason === 'no_matched_variant'))
  assert.ok(group.runs.find((row) => row.run_id === v3retry.run_id).reasons.includes('metric_missing'))
  assert.ok(group.runs.find((row) => row.run_id === v9.run_id).reasons.includes('unexpected_seed'))
  assert.ok(group.runs.find((row) => row.run_id === v5.run_id).reasons.includes('linked_analysis_failed'))
  assert.ok(group.runs.find((row) => row.run_id === other.run_id).reasons.includes('different_scope'))
  assert.equal(absent.statistics.mean_state, 'not_checked')
  assert.equal(absent.statistics.sd_state, 'not_checked')
  assert.ok(report.ungrouped.some((row) => row.run_id === ungrouped.run_id))
  assert.equal(ws.read('.dsh/experiments/s/runs.jsonl'), beforeRuns)
  assert.equal(ws.read('.dsh/experiments/s/links.jsonl'), beforeLinks)
  assert.deepEqual((await call(args)).report, report, 'same records produce the same report')
  assert.ok(!JSON.stringify(report).includes('p_value'))
  const noBaseline = { ...args, candidates: ['variant'], coverage_unknown: true }
  delete noBaseline.expected_seeds
  delete noBaseline.baseline_candidate
  const unknown = (await call(noBaseline)).report.groups[0]
  assert.equal(unknown.seed_coverage.state, 'unknown')
  assert.equal(unknown.seed_coverage.missing, null)
  assert.equal(unknown.seed_coverage.unexpected, null)
  assert.equal(unknown.paired.reason, 'baseline_candidate not provided')
  assert.ok(unknown.included_run_ids.includes(v9.run_id), 'unexpected seed is only excluded when expected coverage is declared')
  const missing = { ...args }
  delete missing.expected_seeds
  assert.match((await call(missing)).error, /expected_seeds or set coverage_unknown/)
  assert.match((await call({ ...args, expected_seeds: [1, 1] })).error, /unique finite/)
  assert.match((await call({ ...args, baseline_candidate: 'missing' })).error, /must be listed/)
  assert.match((await call({ ...args, candidates: ['base', 'base'] })).error, /unique/)
  assert.match((await call({ ...args, coverage_unknown: true })).error, /not both/)
  assert.match((await call({ ...args, metric: 'other' })).error, /declared metric/)
  assert.match((await call({ ...args, scope_id: 'unknown' })).error, /not recorded/)
  const exploratory = (await call({ ...args, selection_history: 'exploratory' })).report
  assert.equal(exploratory.selection_history.value, 'exploratory')
  assert.match(exploratory.selection_history.note, /Exploratory/)
  await assert.rejects(async () => call({ ...args, selection_history: 'sometimes' }), /selection_history/)
  const output = tool.output.render(args, result)
  assert.match(output[0].text, /variant/)
  assert.match(output[0].text, /Runs: 8 · included 3 · excluded 5/)
  assert.match(output[0].text, /failed linked analysis: 1/)
  assert.match(output[0].text, /no confidence interval/)
  assert.equal(readFileSync(join(cwd, '.dsh/experiments/s/runs.jsonl'), 'utf8'), beforeRuns)
  const ledgerPath = join(cwd, '.dsh/experiments/s/runs.jsonl')
  writeFileSync(ledgerPath, `${beforeRuns.trim().split('\n').reverse().join('\n')}\n`)
  assert.deepEqual((await call(args)).report, report, 'run order does not change the report')
  writeFileSync(ledgerPath, beforeRuns)
  const single = (await call({ ...base, params: { method: 'single' }, seed: 1, metrics: { loss: 0 } })).run
  const singleReport = (await call({ ...args, candidates: ['single'], baseline_candidate: 'single', expected_seeds: [1] })).report.groups[0]
  assert.equal(singleReport.statistics.mean, 0)
  assert.equal(singleReport.statistics.sample_sd, null)
  assert.equal(singleReport.statistics.sd_state, 'not_checked')
  assert.deepEqual(singleReport.included_run_ids, [single.run_id])
  await call({ ...base, params: { method: 'mixed' }, seed: 1, metrics: { loss: 1 } })
  await call({ ...variant, params: { method: 'mixed' }, seed: 2, baseline_run_id: b2.run_id, metrics: { loss: 2 } })
  const mixed = (await call({ ...args, candidates: ['mixed'], baseline_candidate: 'mixed', expected_seeds: [1, 2] })).report.groups[0]
  assert.equal(mixed.statistics.n, 0)
  assert.ok(mixed.runs.every((row) => row.reasons.includes('mixed_candidate_roles')))
  await call({ action: 'start', slug: 'dec', question: 'decimal display?', experiment: { metrics: [{ name: 'accuracy', direction: 'higher' }], benchmark: { datasets: ['d'], splits: ['test'], baseline_arm: 'base', task_rules: ['fixed'] }, protocol: { eval_script: 'eval.py', metric_params: {} } } })
  const decimalIdentity = { ...identity, metric_definitions: { accuracy: { unit: 'fraction', implementation: 'accuracy-v1', parameters: {} } } }
  const decimalBaseline = (await call({ action: 'log', slug: 'dec', role: 'baseline', baseline_ref: 'reproduced', stage: 'full', comparison_identity: decimalIdentity, params: { method: 'base' }, seed: 1, metrics: { accuracy: 0.7 } })).run
  await call({ action: 'log', slug: 'dec', role: 'variant', baseline_ref: 'reproduced', stage: 'full', baseline_run_id: decimalBaseline.run_id, comparison_identity: decimalIdentity, params: { method: 'variant' }, seed: 1, metrics: { accuracy: 0.8 } })
  const decimalArgs = { action: 'replicates', slug: 'dec', scope_id: decimalBaseline.comparison_identity.scope_id, metric: 'accuracy', candidate_field: 'method', candidates: ['base', 'variant'], baseline_candidate: 'base', replicate_unit: 'run', expected_seeds: [1] }
  const decimalResult = await call(decimalArgs)
  const decimalText = tool.output.render(decimalArgs, decimalResult)[0].text
  assert.match(decimalText, /mean=0\.8,/)
  assert.match(decimalText, /= 0\.1\n/)
  assert.doesNotMatch(decimalText, /0\.79999|0\.10000000000000009|0\.8000000000000001/)
  console.log('experiment replicates OK')
} finally {
  ws.cleanup()
}
