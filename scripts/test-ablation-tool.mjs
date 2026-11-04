// Offline tests for the ablation tool surface: action dispatch, linked records,
// report rendering, verdicts, pruning, status/show, and export.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'
import { logExperimentRun, startExperiment } from '../experiment-store.js'
import { apply } from '../ablation.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(pkg.exports['./ablation'], './ablation.js', 'the preset row academic-harness/ablation needs this export')
assert.equal(pkg.exports['./ablation-store'], './ablation-store.js')
assert.ok(pkg.files.includes('ablation.js') && pkg.files.includes('ablation-store.js'))

const ws = makeWorkspace('ah-ablation-tool-')
const cwd = ws.cwd
const exec = fakeExec(cwd)
let tool
apply({ tools: { register: (registered) => { tool = registered } } })
const run = (args) => tool.execute(args, exec)
const render = (value) => tool.output.render({}, value)[0].text

try {
  await startExperiment({
    cwd, slug: 'bench',
    experiment: { question: 'Ablation source', metrics: [{ name: 'accuracy', direction: 'higher' }, { name: 'latency', direction: 'lower' }] },
  })
  const { run: full } = await logExperimentRun({ cwd, slug: 'bench', params: { arm: 'full' }, metrics: { accuracy: 0.9, latency: 100 } })
  const { run: removed } = await logExperimentRun({ cwd, slug: 'bench', params: { arm: 'no-warm' }, metrics: { accuracy: 0.9, latency: 118 } })

  let result = await run({ action: 'start', slug: 'warm', idea_id: 'idea-1', method: { name: 'Warm start' }, question: 'Is the gain attributable?' })
  assert.equal(result.action, 'start')
  assert.equal(result.ablation.idea_id, 'idea-1')
  assert.match(render(result), /champion idea idea-1/)

  result = await run({
    action: 'plan', slug: 'warm',
    plan: {
      reference_arm: 'full',
      datasets: ['D1'],
      metrics: [{ name: 'accuracy', direction: 'higher' }, { name: 'latency', direction: 'lower' }],
      replicates: 1,
      arms: [
        { id: 'full' },
        { id: 'no-warm', component: 'warm_start', code_path: 'solver.py:init', expected: [{ metric: 'latency', change: 'increase' }] },
      ],
    },
  })
  assert.equal(result.plan.arms.length, 2)
  assert.match(render(result), /reference full/)

  result = await run({ action: 'record', slug: 'warm', arm: 'full', dataset: 'D1', replicate: 1, experiment_slug: 'bench', experiment_run_id: full.run_id })
  assert.equal(result.record.metrics.latency, 100)
  assert.equal(result.record.source.ledger, 'experiment')
  assert.match(render(result), /Recorded r0001/)
  result = await run({ action: 'record', slug: 'warm', arm: 'no-warm', dataset: 'D1', replicate: 1, experiment_slug: 'bench', experiment_run_id: removed.run_id })
  assert.equal(result.record.missing_metrics.length, 0)

  result = await run({ action: 'report', slug: 'warm' })
  assert.equal(result.report.attribution.attributed[0], 'no-warm')
  assert.equal(result.report.rows.find((row) => row.metric === 'latency').delta, 18)
  const reportText = render(result)
  assert.match(reportText, /Attribution reading/)
  assert.match(reportText, /no-warm/)
  assert.match(reportText, /advisory/i)

  result = await run({ action: 'verdict', slug: 'warm', verdict: 'good', reason: 'removal costs latency', arm: 'no-warm' })
  assert.equal(result.verdict.verdict, 'good')
  assert.match(render(result), /Verdict v0001/)
  result = await run({ action: 'status', slug: 'warm' })
  assert.equal(result.status.records, 2)
  assert.equal(result.status.verdicts, 1)
  assert.match(render(result), /attributed no-warm/)

  result = await run({ action: 'show', slug: 'warm', record_id: 'r0002' })
  assert.equal(result.record.arm, 'no-warm')
  assert.match(render(result), /r0002/)
  result = await run({ action: 'show', slug: 'warm' })
  assert.equal(result.report.attribution.attributed[0], 'no-warm')
  assert.match(render(result), /Ablation "warm"/)

  result = await run({ action: 'prune', slug: 'warm', arm: 'no-warm', reason: 'confirm with a second dataset later' })
  assert.equal(result.prune.arm, 'no-warm')
  result = await run({ action: 'report', slug: 'warm' })
  assert.deepEqual(result.report.attribution.pruned, ['no-warm'])
  assert.equal(result.report.attribution.components[0].reading, 'pruned')

  result = await run({ action: 'export', slug: 'warm', format: 'json' })
  const exported = JSON.parse(readFileSync(join(cwd, result.path), 'utf8'))
  assert.equal(exported.report.attribution.pruned[0], 'no-warm')
  assert.equal(exported.records.length, 2)

  result = await run({ action: 'start', slug: 'bad', method: { name: 'M' } })
  assert.match(result.error, /idea_id is required/)
  result = await run({ action: 'plan', slug: 'missing', plan: {} })
  assert.match(result.error, /not found/)
  result = await run({ action: 'record', slug: 'warm', arm: 'no-warm', dataset: 'D1', replicate: 1 })
  assert.match(result.error, /record needs experiment_slug/)
  await assert.rejects(
    () => run({ action: 'verdict', slug: 'warm', verdict: 'sideways', reason: 'x' }),
    /must be one of/,
  )
  result = await run({ action: 'prune', slug: 'warm', arm: 'full', reason: 'x' })
  assert.match(result.error, /reference arm cannot be pruned/)
  await assert.rejects(() => run({ action: 'nope', slug: 'warm' }), /must be one of/)

  console.log('ablation tool OK')
} finally {
  ws.cleanup()
}
