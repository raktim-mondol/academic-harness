import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply, runExperimentAction } from '../experiment-log.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'
import { freezeAnalysisPlan, runAnalysis } from '../analysis-store.js'

const workspace = makeWorkspace('ah-experiment-')
const cwd = workspace.cwd
const exec = fakeExec(cwd)
let tool
apply({ tools: { register: (registered) => { tool = registered } } })
const run = (args) => tool.execute(args, exec)

try {
  // Start and write-once.
  let result = await run({ action: 'start', slug: 'sweep', question: 'Which learning rate wins?', experiment: { name: 'LR sweep', metrics: [{ name: 'accuracy', direction: 'higher' }, { name: 'loss', direction: 'lower' }], notes: 'grid' } })
  assert.equal(result.experiment.slug, 'sweep')
  assert.equal(result.resumed, false)
  result = await run({ action: 'start', slug: 'sweep', question: 'Different?' })
  assert.match(result.error, /already exists/)
  result = await run({ action: 'start', slug: 'sweep', question: 'Different?', resume: true })
  assert.equal(result.resumed, true)
  assert.equal(result.experiment.question, 'Which learning rate wins?', 'resume keeps the frozen question')
  result = await run({ action: 'start', slug: 'bad', question: 'Bad metrics?', experiment: { metrics: [{ name: 'auc', direction: 'sideways' }] } })
  assert.match(result.error, /direction must be one of/)

  // Logging runs, artifacts, and parents.
  workspace.write('out/run1.json', '{"ok": true}')
  result = await run({ action: 'log', slug: 'sweep', params: { lr: 0.1, epochs: 5 }, metrics: { accuracy: 0.81, loss: 0.42 }, artifacts: ['out/run1.json'], seed: 1 })
  assert.equal(result.run.run_id, 'x0001')
  assert.match(result.run.artifacts[0].sha256, /^sha256:/)
  assert.ok(result.run.environment.node)
  result = await run({ action: 'log', slug: 'sweep', params: { lr: 0.01, epochs: 5 }, metrics: { accuracy: 0.9, loss: 0.3 }, seed: 2, parent: 'x0001' })
  assert.equal(result.run.run_id, 'x0002')
  assert.equal(result.run.parent, 'x0001')
  result = await run({ action: 'log', slug: 'sweep', params: { lr: 0.001 }, metrics: { accuracy: 0.5, f1: 0.44 }, seed: 3 })
  assert.deepEqual(result.undeclared_metrics, ['f1'])
  // A rerun is a new run — nothing is deduplicated.
  result = await run({ action: 'log', slug: 'sweep', params: { lr: 0.01, epochs: 5 }, metrics: { accuracy: 0.9, loss: 0.3 }, seed: 2 })
  assert.equal(result.run.run_id, 'x0004')
  result = await run({ action: 'log', slug: 'sweep', params: { lr: 0.2 }, metrics: { accuracy: 'not-a-number' } })
  assert.match(result.error, /finite number/)
  result = await run({ action: 'log', slug: 'sweep', params: { lr: 0.2 }, metrics: { accuracy: 0.7 }, artifacts: ['missing.json'] })
  assert.match(result.error, /ENOENT|no such file/)
  result = await run({ action: 'log', slug: 'sweep', params: {}, metrics: {}, artifacts: ['../outside.json'] })
  assert.match(result.error, /escapes the workspace/)
  result = await run({ action: 'log', slug: 'sweep', params: {}, metrics: {}, parent: 'x9999' })
  assert.match(result.error, /parent run "x9999" not found/)

  // Compare, best, and named-metric discipline.
  result = await run({ action: 'compare', slug: 'sweep' })
  assert.equal(result.comparison.runs.length, 4)
  assert.deepEqual(result.comparison.best, {}, 'legacy records are visible but never ranked without scope')
  assert.ok(result.comparison.comparison_scope.assessments.every((entry) => entry.state === 'not_checked'))
  assert.equal(result.comparison.runs.find((entry) => entry.run_id === 'x0003').metrics.loss, undefined, 'missing metrics stay blank')
  result = await run({ action: 'compare', slug: 'sweep', field: 'lr' })
  assert.deepEqual(result.comparison.grouped, [])
  result = await run({ action: 'best', slug: 'sweep', metric: 'accuracy' })
  assert.match(result.error, /requires an explicit scope_id/)
  result = await run({ action: 'best', slug: 'sweep', metric: 'f1' })
  assert.match(result.error, /requires an explicit scope_id/)
  result = await run({ action: 'best', slug: 'sweep', metric: 'f1', direction: 'higher' })
  assert.match(result.error, /requires an explicit scope_id/)
  result = await run({ action: 'best', slug: 'sweep' })
  assert.match(result.error, /named metric or dominance/)
  result = await run({ action: 'best', slug: 'sweep', metric: 'nonexistent', direction: 'higher' })
  assert.match(result.error, /requires an explicit scope_id/)

  // Links, status, list, show. An analysis_run link must name a real run: a
  // dangling one would silently disable the compliance exclusion it claims to carry.
  await freezeAnalysisPlan({ cwd, slug: 'primary', plan: { question: 'Baseline check?', outputs: ['out/primary.json'] } })
  const analysisRun = await runAnalysis({ cwd, slug: 'primary', command: ['python3', '-c', 'open("out/primary.json","w").write("{\\"x\\": 1}")'], notebookEntry: null })
  assert.equal(analysisRun.exit_code, 0)
  result = await run({ action: 'link', slug: 'sweep', run_id: 'x0002', target_kind: 'analysis_run', target_id: analysisRun.run_id, note: 'confirmation' })
  assert.equal(result.link.target.kind, 'analysis_run')
  assert.equal(result.link.target.id, analysisRun.run_id)
  result = await run({ action: 'link', slug: 'sweep', run_id: 'x0002', target_kind: 'analysis_run', target_id: 'run-2026-nope' })
  assert.match(result.error, /no analysis run "run-2026-nope"/, 'a dangling analysis link is refused, not recorded')
  await assert.rejects(
    run({ action: 'link', slug: 'sweep', run_id: 'x0002', target_kind: 'wiki', target_id: 'x' }),
    /must be one of/,
  )
  result = await run({ action: 'status', slug: 'sweep' })
  assert.equal(result.status.runs, 4)
  assert.equal(result.status.links, 1)
  result = await run({ action: 'list', slug: 'sweep' })
  assert.equal(result.runs.length, 4)
  result = await run({ action: 'show', slug: 'sweep', run_id: 'x0002' })
  assert.equal(result.run.seed, 2)
  assert.equal(result.links.length, 1)
  result = await run({ action: 'show', slug: 'sweep', run_id: 'x9999' })
  assert.match(result.error, /not found/)
  result = await run({ action: 'status', slug: 'nope' })
  assert.match(result.error, /not found/)

  // Exports.
  result = await run({ action: 'export', slug: 'sweep' })
  assert.equal(result.format, 'markdown')
  const report = readFileSync(join(cwd, result.path), 'utf8')
  assert.match(report, /# Experiment: LR sweep/)
  assert.match(report, /x0002/)
  assert.match(report, /No ranking: an explicit scope_id is required/)
  assert.match(report, /missing values stay blank/)
  result = await run({ action: 'export', slug: 'sweep' })
  assert.match(result.error, /already exists/)
  result = await run({ action: 'export', slug: 'sweep', format: 'csv', overwrite: false })
  const csv = readFileSync(join(cwd, result.path), 'utf8')
  assert.match(csv.split('\n')[0], /run_id,ts,seed,parent,role,baseline_ref,stage,protocol_digest,spec_drift,lr,epochs,accuracy,loss,f1,verdict,compliance,artifacts,notes/)
  assert.match(csv, /x0001,.*out\/run1\.json/)
  result = await run({ action: 'export', slug: 'sweep', format: 'json' })
  const json = JSON.parse(readFileSync(join(cwd, result.path), 'utf8'))
  assert.equal(json.runs.length, 4)
  assert.equal(json.links.length, 1)
  result = await run({ action: 'export', slug: 'sweep', format: 'mlflow' })
  const mlflow = JSON.parse(readFileSync(join(cwd, result.path), 'utf8'))
  assert.equal(mlflow.runs.length, 4)
  assert.ok(mlflow.runs[0].data.metrics.some((entry) => entry.key === 'accuracy'))
  await assert.rejects(
    run({ action: 'export', slug: 'sweep', format: 'xlsx' }),
    /must be one of/,
  )

  // Phase 4: benchmark spec, staged runs, protocol digest, verdicts, dominance.
  const benchMetrics = [
    { name: 'accuracy', direction: 'higher' },
    { name: 'latency', direction: 'lower' },
  ]
  const validBench = {
    datasets: ['D1', 'D2'],
    splits: ['val', 'test'],
    baseline_arm: 'baseline',
    task_rules: ['no test leakage', 'fixed split'],
  }
  workspace.write('eval.py', 'print("v1")\n')
  result = await run({
    action: 'start', slug: 'bad-bench', question: 'Bad benchmark?',
    experiment: { metrics: benchMetrics, benchmark: { datasets: ['D1'], splits: ['test'], baseline_arm: 'baseline' } },
  })
  assert.match(result.error, /benchmark\.task_rules is required/)
  result = await run({
    action: 'start', slug: 'bad-bench2', question: 'No direction?',
    experiment: { metrics: [{ name: 'accuracy' }], benchmark: validBench },
  })
  assert.match(result.error, /need a direction/)
  result = await run({
    action: 'start', slug: 'bad-bench3', question: 'No eval?',
    experiment: { metrics: benchMetrics, benchmark: validBench, protocol: { eval_script: 'missing.py', metric_params: {} } },
  })
  assert.match(result.error, /protocol\.eval_script not found/)

  result = await run({
    action: 'start', slug: 'bench', question: 'Does the mechanism beat the reference across stages?',
    experiment: {
      metrics: benchMetrics,
      benchmark: validBench,
      protocol: { eval_script: 'eval.py', metric_params: { threshold: 0.5 } },
    },
  })
  assert.equal(result.experiment.benchmark.baseline_arm, 'baseline')
  assert.equal(result.experiment.protocol.eval_script, 'eval.py')
  assert.equal(result.experiment.metrics[0].direction, 'higher')

  result = await run({
    action: 'log', slug: 'bench', role: 'baseline', baseline_ref: 'reproduced', stage: 'full',
    sampling: { seed: 7, size: 32, stratification: 'by dataset' },
    params: { lr: 0.1 }, metrics: { accuracy: 0.8, latency: 100 },
  })
  assert.equal(result.run.run_id, 'x0001')
  assert.equal(result.run.role, 'baseline')
  assert.equal(result.run.stage, 'full')
  assert.equal(result.run.sampling.size, 32)
  assert.match(result.run.protocol_digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(result.run.spec_drift.state, 'baseline')

  result = await run({
    action: 'log', slug: 'bench', role: 'variant', baseline_ref: 'reproduced', stage: 'full', baseline_run_id: 'x0001', sampling: { seed: 7, size: 32, stratification: 'by dataset' },
    params: { lr: 0.05 }, metrics: { accuracy: 0.85, latency: 90 },
  })
  assert.equal(result.run.run_id, 'x0002')
  assert.equal(result.run.baseline_run_id, 'x0001')
  assert.equal(result.run.spec_drift.state, 'match')

  result = await run({
    action: 'log', slug: 'bench', role: 'variant', baseline_ref: 'reproduced', stage: 'full', baseline_run_id: 'x0001', sampling: { seed: 7, size: 32, stratification: 'by dataset' },
    protocol: { eval_script: 'eval.py', metric_params: { threshold: 0.6 } },
    params: { lr: 0.05 }, metrics: { accuracy: 0.82, latency: 80 },
  })
  assert.equal(result.run.run_id, 'x0003')
  assert.equal(result.run.spec_drift.state, 'drift')
  assert.deepEqual(result.run.spec_drift.changed, ['metric_params'])

  workspace.write('eval.py', 'print("v2")\n')
  result = await run({
    action: 'log', slug: 'bench', role: 'variant', baseline_ref: 'reproduced', stage: 'full', baseline_run_id: 'x0001', sampling: { seed: 7, size: 32, stratification: 'by dataset' },
    params: { lr: 0.02 }, metrics: { accuracy: 0.88, latency: 95 },
  })
  assert.equal(result.run.run_id, 'x0004')
  assert.equal(result.run.spec_drift.state, 'drift')
  assert.deepEqual(result.run.spec_drift.changed, ['eval_script'])

  result = await run({ action: 'log', slug: 'bench', metrics: { accuracy: 0.9 } })
  assert.equal(result.run.run_id, 'x0005')

  result = await run({
    action: 'log', slug: 'bench', role: 'variant', baseline_ref: 'reported', stage: 'full',
    metrics: { accuracy: 0.8, latency: 90 },
  })
  assert.match(result.error, /explicit baseline_run_id/)
  result = await run({
    action: 'log', slug: 'bench', role: 'variant', baseline_ref: 'reproduced',
    metrics: { accuracy: 0.8, latency: 90 },
  })
  assert.match(result.error, /needs stage/)
  result = await run({
    action: 'log', slug: 'bench', role: 'variant', stage: 'full',
    metrics: { accuracy: 0.8, latency: 90 },
  })
  assert.match(result.error, /needs baseline_ref/)
  result = await run({
    action: 'log', slug: 'bench', role: 'baseline', baseline_ref: 'reproduced', stage: 'subset',
    metrics: { accuracy: 0.8, latency: 90 },
  })
  assert.match(result.error, /needs a sampling rule/)
  await run({ action: 'start', slug: 'plain', question: 'No benchmark?', experiment: { metrics: benchMetrics } })
  result = await run({
    action: 'log', slug: 'plain', role: 'baseline', baseline_ref: 'reproduced', stage: 'full',
    metrics: { accuracy: 0.8, latency: 90 },
  })
  assert.match(result.error, /no benchmark spec/)
  await run({
    action: 'start', slug: 'noproto', question: 'No protocol?',
    experiment: { metrics: benchMetrics, benchmark: validBench },
  })
  result = await run({
    action: 'log', slug: 'noproto', role: 'baseline', baseline_ref: 'reproduced', stage: 'full',
    metrics: { accuracy: 0.8, latency: 90 },
  })
  assert.match(result.error, /needs a protocol/)

  result = await run({ action: 'verdict', slug: 'bench', run_id: 'x0002', verdict: 'good', reason: 'clear gain' })
  assert.equal(result.verdict.verdict, 'good')
  assert.equal(result.verdict.forced, false)
  result = await run({
    action: 'verdict', slug: 'bench', run_id: 'x0003', verdict: 'engineer',
    reason: 'try a wider slice', engineering_round: 2, budget: { max_rounds: 2, used: 2 },
  })
  assert.equal(result.verdict.requested_verdict, 'engineer')
  assert.equal(result.verdict.verdict, 'bad')
  assert.equal(result.verdict.forced, true)
  assert.match(result.verdict.reason, /forced bad: engineering budget exhausted/)
  result = await run({
    action: 'verdict', slug: 'bench', run_id: 'x0002', verdict: 'engineer',
    reason: 'one more round', engineering_round: 2, budget: { max_rounds: 3, used: 1 },
  })
  assert.equal(result.verdict.verdict, 'engineer')
  assert.equal(result.verdict.forced, false)
  result = await run({ action: 'verdict', slug: 'bench', run_id: 'x0002', verdict: 'engineer', reason: 'no round' })
  assert.match(result.error, /engineering_round is required/)
  result = await run({ action: 'verdict', slug: 'bench', run_id: 'x9999', verdict: 'good', reason: 'missing' })
  assert.match(result.error, /not found/)

  result = await run({ action: 'status', slug: 'bench' })
  assert.equal(result.status.benchmark.baseline_arm, 'baseline')
  assert.equal(result.status.baseline_runs[0].run_id, 'x0001')
  assert.deepEqual(result.status.spec_drift_runs.map((entry) => entry.run_id), ['x0003', 'x0004'])
  assert.equal(result.status.verdicts, 3)
  result = await run({ action: 'show', slug: 'bench', run_id: 'x0002' })
  assert.equal(result.verdicts.length, 2)
  assert.equal(result.verdicts.at(-1).verdict, 'engineer')
  result = await run({ action: 'compare', slug: 'bench' })
  assert.equal(result.comparison.runs.length, 5)
  assert.equal(result.comparison.runs.find((entry) => entry.run_id === 'x0002').spec_drift.state, 'match')
  assert.equal(result.comparison.runs.find((entry) => entry.run_id === 'x0003').spec_drift.state, 'drift')
  assert.equal(result.comparison.runs.find((entry) => entry.run_id === 'x0002').verdict.verdict, 'engineer')

  result = await run({ action: 'best', slug: 'bench', dominance: true })
  assert.match(result.error, /requires an explicit scope_id/)
  result = await run({ action: 'best', slug: 'bench', metric: 'accuracy', dominance: true })
  assert.match(result.error, /requires an explicit scope_id/)
  result = await run({ action: 'best', slug: 'bench', metric: 'accuracy' })
  assert.match(result.error, /requires an explicit scope_id/)

  result = await run({ action: 'export', slug: 'bench', format: 'markdown' })
  const benchReport = readFileSync(join(cwd, result.path), 'utf8')
  assert.match(benchReport, /## Staged contract/)
  assert.match(benchReport, /## Verdicts/)
  assert.match(benchReport, /spec_drift|drift/)
  result = await run({ action: 'export', slug: 'bench', format: 'csv' })
  const benchCsv = readFileSync(join(cwd, result.path), 'utf8')
  assert.match(benchCsv.split('\n')[0], /role,baseline_ref,stage,protocol_digest,spec_drift/)
  result = await run({ action: 'export', slug: 'bench', format: 'json' })
  const benchJson = JSON.parse(readFileSync(join(cwd, result.path), 'utf8'))
  assert.equal(benchJson.verdicts.length, 3)
  assert.equal(benchJson.runs.length, 5)

  // Direct runner throws.
  await assert.rejects(() => runExperimentAction({ action: 'best', slug: 'sweep' }, exec), /named metric or dominance/)

  console.log('experiment_log OK')
} finally {
  workspace.cleanup()
}
