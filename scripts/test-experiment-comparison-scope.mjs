import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../experiment-log.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'
import { freezeAnalysisPlan, runAnalysis } from '../analysis-store.js'

const ws = makeWorkspace('ah-scope-')
const cwd = ws.cwd
let tool
apply({ tools: { register(value) { tool = value } } })
const call = (args) => tool.execute(args, fakeExec(cwd))
const identity = (dataset = 'd', version = 'v1') => ({
  dataset: { id: dataset, version_or_hash: version },
  split: { id: 'test', version_or_hash: 'v1' },
  baseline_cohort_id: 'reference-v1',
  metric_definitions: { acc: { unit: 'fraction', implementation: 'accuracy-v1', parameters: {} }, latency: { unit: 'ms', implementation: 'timer-v1', parameters: {} } },
})
try {
  ws.write('eval.py', 'print(1)\n')
  await call({ action: 'start', slug: 's', question: 'scope?', experiment: {
    metrics: [{ name: 'acc', direction: 'higher' }, { name: 'latency', direction: 'lower' }],
    benchmark: { datasets: ['d', 'other'], splits: ['test'], baseline_arm: 'base', task_rules: ['fixed'] },
    protocol: { eval_script: 'eval.py', metric_params: {} },
  } })
  const baseArgs = { action: 'log', slug: 's', role: 'baseline', baseline_ref: 'reproduced', stage: 'full' }
  let result = await call({ ...baseArgs, comparison_identity: identity(), metrics: { acc: 0.7, latency: 5 } })
  const scope = result.run.comparison_identity.scope_id
  assert.match(scope, /^sha256:[a-f0-9]{64}$/)
  const variant = { ...baseArgs, role: 'variant', baseline_run_id: 'x0001', comparison_identity: identity() }
  result = await call({ ...variant, metrics: { acc: 0.8, latency: 4 } })
  assert.equal(result.run.comparison_identity.scope_id, scope)
  assert.equal(result.run.baseline_run_id, 'x0001')
  const { baseline_run_id: omittedBaseline, ...variantWithoutBaseline } = variant
  result = await call({ ...variantWithoutBaseline, metrics: { acc: 0.9 } })
  assert.match(result.error, /explicit baseline_run_id/)
  result = await call({ ...variant, baseline_run_id: 'x0002', metrics: { acc: 0.9 } })
  assert.match(result.error, /must name a baseline/)
  result = await call({ ...variant, comparison_identity: identity('other'), metrics: { acc: 0.9 } })
  assert.match(result.error, /incompatible comparison_identity/)
  result = await call({ ...variant, stage: 'subset', sampling: { size: 1 }, metrics: { acc: 0.9 } })
  assert.match(result.error, /same stage and sampling/)
  result = await call({ ...baseArgs, comparison_identity: identity('other'), metrics: { acc: 0.99, latency: 1 } })
  const otherScope = result.run.comparison_identity.scope_id
  assert.notEqual(otherScope, scope)
  result = await call({ ...baseArgs, comparison_identity: identity('d', 'v2'), metrics: { acc: 0.98, latency: 1 } })
  assert.notEqual(result.run.comparison_identity.scope_id, scope)
  result = await call({ ...variant, protocol: { eval_script: 'eval.py', metric_params: { changed: true } }, metrics: { acc: 1, latency: 0 } })
  assert.equal(result.run.spec_drift.state, 'drift')
  await call({ action: 'log', slug: 's', metrics: { acc: 1.1 } })
  result = await call({ action: 'compare', slug: 's' })
  assert.deepEqual(result.comparison.best, {})
  assert.ok(result.comparison.comparison_scope.available_scopes.includes(scope))
  assert.ok(result.comparison.comparison_scope.available_scopes.includes(otherScope))
  result = await call({ action: 'compare', slug: 's', scope_id: scope, field: 'missing' })
  assert.equal(result.comparison.best.acc.run_id, 'x0002')
  assert.equal(result.comparison.comparison_scope.assessments.find((a) => a.run_id === 'x0003').state, 'incompatible')
  assert.equal(result.comparison.comparison_scope.assessments.find((a) => a.run_id === 'x0005').reasons[0], 'protocol_drift')
  assert.equal(result.comparison.comparison_scope.assessments.find((a) => a.run_id === 'x0006').state, 'not_checked')
  result = await call({ action: 'best', slug: 's', metric: 'acc', scope_id: scope, dominance: true })
  assert.equal(result.best.run.run_id, 'x0002')
  assert.deepEqual(result.dominance.front.map((r) => r.run_id), ['x0002'])
  result = await call({ action: 'best', slug: 's', metric: 'acc', scope_id: scope, direction: 'lower' })
  assert.match(result.error, /cannot override/)
  const before = ws.read('.dsh/experiments/s/runs.jsonl')
  for (const format of ['markdown', 'json', 'csv', 'mlflow']) {
    const out = await call({ action: 'export', slug: 's', scope_id: scope, format })
    const content = readFileSync(join(cwd, out.path), 'utf8')
    assert.match(content, /x0006/)
    assert.match(content, /not_checked/)
    assert.match(content, /protocol_drift/)
    if (format === 'markdown') assert.match(content, /acc \(higher\): x0002/)
  }
  assert.equal(ws.read('.dsh/experiments/s/runs.jsonl'), before, 'views do not rewrite history')
  const duplicate = await Promise.all([1, 2].map(() => call({ ...variant, metrics: { acc: 0.8, latency: 4 } })))
  assert.equal(new Set(duplicate.map((r) => r.run.run_id)).size, 2)
  await freezeAnalysisPlan({ cwd, slug: 'failed', plan: { question: 'failure?' } })
  const failed = await runAnalysis({ cwd, slug: 'failed', command: ['python3', '-c', 'raise SystemExit(1)'], notebookEntry: null })
  assert.equal(failed.exit_code, 1)
  await call({ action: 'link', slug: 's', run_id: duplicate[0].run.run_id, target_kind: 'analysis_run', target_id: `failed:${failed.run_id}` })
  result = await call({ action: 'compare', slug: 's', scope_id: scope })
  assert.deepEqual(result.comparison.comparison_scope.assessments.find((a) => a.run_id === duplicate[0].run.run_id).reasons, ['linked_analysis_failed'])
  const splitIdentity = identity()
  splitIdentity.split.version_or_hash = 'v2'
  const metricIdentity = identity()
  metricIdentity.metric_definitions.acc.parameters = { threshold: 0.5 }
  const cohortIdentity = identity()
  cohortIdentity.baseline_cohort_id = 'other-cohort'
  for (const altered of [splitIdentity, metricIdentity, cohortIdentity]) {
    const logged = await call({ ...baseArgs, comparison_identity: altered, metrics: { acc: 0.9 } })
    assert.notEqual(logged.run.comparison_identity.scope_id, scope)
  }
  const slice = await call({ ...baseArgs, stage: 'slice', sampling: { size: 3, seed: 1 }, comparison_identity: identity(), metrics: { acc: 0.9 } })
  assert.notEqual(slice.run.comparison_identity.scope_id, scope)
  const missingMetric = identity()
  delete missingMetric.metric_definitions.latency
  result = await call({ ...baseArgs, comparison_identity: missingMetric, metrics: { acc: 0.9 } })
  assert.match(result.error, /requires unit, implementation, and parameters/)
  result = await call({ ...variantWithoutBaseline, metrics: { acc: 0.9 } })
  assert.match(result.error, /explicit baseline_run_id/, 'multiple baselines cannot trigger a first-match fallback')
  const ledgerPath = join(cwd, '.dsh/experiments/s/runs.jsonl')
  const originalLedger = readFileSync(ledgerPath, 'utf8')
  const rows = originalLedger.trim().split('\n').map(JSON.parse)
  rows[0].comparison_identity.dataset.id = 'tampered'
  writeFileSync(ledgerPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  result = await call({ action: 'compare', slug: 's', scope_id: scope })
  assert.deepEqual(result.comparison.comparison_scope.assessments.find((a) => a.run_id === 'x0001').reasons, ['comparison_identity_invalid'])
  assert.deepEqual(result.comparison.comparison_scope.assessments.find((a) => a.run_id === 'x0002').reasons, ['baseline_not_comparable'])
  writeFileSync(ledgerPath, originalLedger)
  console.log('experiment comparison scope OK')
} finally {
  ws.cleanup()
}
