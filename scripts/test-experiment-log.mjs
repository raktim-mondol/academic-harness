import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply, runExperimentAction } from '../experiment-log.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

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
  assert.equal(result.comparison.best.accuracy.run_id, 'x0002')
  assert.equal(result.comparison.best.accuracy.direction, 'higher')
  assert.equal(result.comparison.best.loss.run_id, 'x0002')
  assert.equal(result.comparison.best.loss.direction, 'lower')
  assert.equal(result.comparison.runs.find((entry) => entry.run_id === 'x0003').metrics.loss, undefined, 'missing metrics stay blank')
  result = await run({ action: 'compare', slug: 'sweep', field: 'lr' })
  assert.ok(result.comparison.grouped.some((group) => group.value === '0.01' && group.runs === 2))
  result = await run({ action: 'best', slug: 'sweep', metric: 'accuracy' })
  assert.equal(result.best.run.run_id, 'x0002')
  assert.deepEqual(result.best.tied_runs, ['x0002', 'x0004'])
  result = await run({ action: 'best', slug: 'sweep', metric: 'f1' })
  assert.match(result.error, /no direction/)
  result = await run({ action: 'best', slug: 'sweep', metric: 'f1', direction: 'higher' })
  assert.equal(result.best.run.run_id, 'x0003')
  result = await run({ action: 'best', slug: 'sweep' })
  assert.match(result.error, /metric is required/)
  result = await run({ action: 'best', slug: 'sweep', metric: 'nonexistent', direction: 'higher' })
  assert.match(result.error, /no run records metric/)

  // Links, status, list, show.
  result = await run({ action: 'link', slug: 'sweep', run_id: 'x0002', target_kind: 'analysis_run', target_id: 'run-2026-primary', note: 'confirmation' })
  assert.equal(result.link.target.kind, 'analysis_run')
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
  assert.match(report, /Best per named metric/)
  assert.match(report, /missing values stay blank/)
  result = await run({ action: 'export', slug: 'sweep' })
  assert.match(result.error, /already exists/)
  result = await run({ action: 'export', slug: 'sweep', format: 'csv', overwrite: false })
  const csv = readFileSync(join(cwd, result.path), 'utf8')
  assert.match(csv.split('\n')[0], /run_id,ts,seed,parent,lr,epochs,accuracy,loss,f1,artifacts,notes/)
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

  // Direct runner throws.
  await assert.rejects(() => runExperimentAction({ action: 'best', slug: 'sweep' }, exec), /metric is required/)

  console.log('experiment_log OK')
} finally {
  workspace.cleanup()
}
