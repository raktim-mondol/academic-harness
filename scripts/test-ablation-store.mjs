// Offline tests for the ablation ledger: plan validation, linked runs, paired
// deltas, attribution reading, verdicts, pruning, and exports.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorkspace } from './helpers/test-workspace.mjs'
import { appendJsonl } from '../ledger-kit.js'
import { logExperimentRun, startExperiment } from '../experiment-store.js'
import {
  exportAblation, planAblation, pruneAblation, recordAblation, reportAblation,
  showAblation, startAblation, statusAblation, verdictAblation,
} from '../ablation-store.js'

const ws = makeWorkspace('ah-ablation-store-')
const cwd = ws.cwd

try {
  await assert.rejects(
    () => startAblation({ cwd, slug: 'x', method: { name: 'M' } }),
    /idea_id is required/,
  )
  await assert.rejects(
    () => startAblation({ cwd, slug: 'x', ideaId: 'idea-1' }),
    /method is required/,
  )
  await startAblation({
    cwd, slug: 'warm', ideaId: 'idea-1', ideaSource: 'coscientist/lr',
    method: { name: 'Warm-start solver', description: 'reuse the warm cache' },
    question: 'Does warm start carry the gain?',
  })
  await assert.rejects(
    () => startAblation({ cwd, slug: 'warm', ideaId: 'idea-2', method: { name: 'M' } }),
    /already exists/,
  )
  await assert.rejects(() => planAblation({ cwd, slug: 'warm', plan: {} }), /plan\.datasets/)
  await assert.rejects(() => planAblation({ cwd, slug: 'missing', plan: {} }), /not found/)

  const planInput = {
    reference_arm: 'full',
    datasets: ['D1', 'D2'],
    metrics: [{ name: 'accuracy', direction: 'higher' }, { name: 'latency', direction: 'lower' }],
    replicates: 2,
    arms: [
      { id: 'full' },
      { id: 'no-warm', component: 'warm_start', code_path: 'solver.py:init', removal: 'skip warm start', expected: [{ metric: 'latency', change: 'increase' }] },
      { id: 'no-cache', component: 'cache', code_path: 'solver.py:cache', removal: 'disable cache', expected: [{ metric: 'latency', change: 'increase' }] },
      { id: 'no-fusion', component: 'fusion', code_path: 'model.py:fusion', removal: 'remove fusion', expected: [{ metric: 'accuracy', change: 'decrease' }] },
    ],
  }
  await assert.rejects(
    () => planAblation({
      cwd, slug: 'warm',
      plan: { ...planInput, arms: planInput.arms.map((arm) => (arm.id === 'no-warm' ? { ...arm, expected: [] } : arm)) },
    }),
    /must declare at least one expected metric/,
  )
  await assert.rejects(
    () => planAblation({
      cwd, slug: 'warm',
      plan: { ...planInput, arms: planInput.arms.map((arm) => (arm.id === 'no-warm' ? { ...arm, expected: [{ metric: 'f1', change: 'any' }] } : arm)) },
    }),
    /undeclared metric/,
  )
  await assert.rejects(
    () => planAblation({
      cwd, slug: 'warm',
      plan: { ...planInput, arms: planInput.arms.map((arm) => (arm.id === 'full' ? { ...arm, component: 'x', code_path: 'a' } : arm)) },
    }),
    /reference_arm "full" must not remove a component/,
  )
  const { plan } = await planAblation({ cwd, slug: 'warm', plan: planInput })
  assert.equal(plan.reference_arm, 'full')
  assert.equal(plan.arms[1].expected[0].metric, 'latency')
  await assert.rejects(() => planAblation({ cwd, slug: 'warm', plan: planInput }), /already frozen/)

  // Seed real experiment runs and link the cells.
  await startExperiment({
    cwd, slug: 'bench',
    experiment: { question: 'Ablation source', metrics: [{ name: 'accuracy', direction: 'higher' }, { name: 'latency', direction: 'lower' }] },
  })
  const values = {
    full: { accuracy: 0.9, latency: 100 },
    'no-warm': { accuracy: 0.9, latency: 120 },
    'no-cache': { accuracy: 0.9, latency: 100 },
  }
  const runFor = new Map()
  for (const arm of ['full', 'no-warm', 'no-cache']) {
    for (const dataset of ['D1', 'D2']) {
      for (const replicate of [1, 2]) {
        const base = values[arm]
        const { run } = await logExperimentRun({
          cwd, slug: 'bench',
          params: { arm, dataset, replicate },
          metrics: { accuracy: base.accuracy, latency: base.latency + (replicate === 2 ? 2 : 0) },
        })
        runFor.set(`${arm}|${dataset}|${replicate}`, run.run_id)
      }
    }
  }
  // A hashed analysis run supplies the one no-fusion cell through the other source.
  appendJsonl(join(cwd, '.dsh', 'analysis', 'ar', 'runs.jsonl'), [{
    run_id: 'a0001',
    outputs: [{ path: 'out.csv', sha256: 'sha256:' + 'a'.repeat(64) }],
    artifacts: ['out.csv'],
  }])
  for (const arm of ['full', 'no-warm', 'no-cache']) {
    for (const dataset of ['D1', 'D2']) {
      for (const replicate of [1, 2]) {
        await recordAblation({
          cwd, slug: 'warm', arm, dataset, replicate,
          experimentSlug: 'bench', experimentRunId: runFor.get(`${arm}|${dataset}|${replicate}`),
        })
      }
    }
  }
  await recordAblation({
    cwd, slug: 'warm', arm: 'no-fusion', dataset: 'D1', replicate: 1,
    analysisSlug: 'ar', analysisRunId: 'a0001', metrics: { accuracy: 0.88, latency: 100 },
  })
  await assert.rejects(
    () => recordAblation({
      cwd, slug: 'warm', arm: 'no-warm', dataset: 'D1', replicate: 1,
      experimentSlug: 'bench', experimentRunId: runFor.get('full|D1|1'),
    }),
    /already recorded/,
  )
  await assert.rejects(
    () => recordAblation({ cwd, slug: 'warm', arm: 'no-warm', dataset: 'D3', replicate: 1, experimentSlug: 'bench', experimentRunId: runFor.get('no-warm|D1|1') }),
    /dataset "D3" is not in the plan/,
  )
  await assert.rejects(
    () => recordAblation({ cwd, slug: 'warm', arm: 'no-warm', dataset: 'D1', replicate: 3, experimentSlug: 'bench', experimentRunId: runFor.get('no-warm|D1|1') }),
    /replicate must be an integer/,
  )
  await assert.rejects(
    () => recordAblation({ cwd, slug: 'warm', arm: 'no-warm', dataset: 'D1', replicate: 2 }),
    /record needs experiment_slug/,
  )
  await assert.rejects(
    () => recordAblation({
      cwd, slug: 'warm', arm: 'no-warm', dataset: 'D1', replicate: 2,
      experimentSlug: 'bench', experimentRunId: runFor.get('no-warm|D1|2'), metrics: { latency: 120 },
    }),
    /omit metrics/,
  )

  const report = reportAblation(cwd, 'warm')
  assert.equal(report.records, 13)
  assert.equal(report.row_total, 18, 'three removal arms × 2 datasets × 2 reps × 2 metrics, minus the six unrecorded no-fusion metrics')
  assert.equal(report.missing_total, 6, 'the no-fusion arm has only one of six cells')
  assert.equal(report.ties.length > 0, true)
  assert.deepEqual(report.attribution.attributed, ['no-warm'])
  assert.deepEqual(report.attribution.unattributed, ['no-cache'])
  assert.deepEqual(report.attribution.partial, ['no-fusion'])
  assert.equal(report.by_arm['no-warm'].metrics.latency.mean_delta, 20)
  assert.equal(report.by_arm['no-warm'].metrics.latency.matched, 4)
  assert.equal(report.by_arm['no-cache'].metrics.latency.matched, 0)
  assert.equal(report.rows[0].source.ledger, 'experiment')
  assert.equal(report.rows.find((row) => row.arm === 'no-fusion').source.ledger, 'analysis')
  assert.match(report.note, /advisory/i)

  await verdictAblation({ cwd, slug: 'warm', verdict: 'good', reason: 'removal degrades latency', arm: 'no-warm' })
  await verdictAblation({ cwd, slug: 'warm', verdict: 'unattributed', reason: 'cache removal is a tie', arm: 'no-cache' })
  await assert.rejects(() => verdictAblation({ cwd, slug: 'warm', verdict: 'sideways', reason: 'x' }), /verdict must be one of/)
  await assert.rejects(() => verdictAblation({ cwd, slug: 'warm', verdict: 'good', reason: '' }), /reason is required/)
  let status = statusAblation(cwd, 'warm')
  assert.equal(status.records, 13)
  assert.equal(status.verdicts, 2)
  assert.deepEqual(status.attribution.attributed, ['no-warm'])
  assert.equal(status.latest_verdict.verdict, 'unattributed')

  const shown = showAblation(cwd, 'warm', { recordId: 'r0001' })
  assert.equal(shown.record.arm, 'full')
  assert.ok(shown.verdicts)
  const fullShow = showAblation(cwd, 'warm')
  assert.equal(fullShow.report.attribution.attributed[0], 'no-warm')

  await pruneAblation({ cwd, slug: 'warm', arm: 'no-cache', reason: 'tie, not worth another replicate' })
  await assert.rejects(() => pruneAblation({ cwd, slug: 'warm', arm: 'full', reason: 'x' }), /reference arm cannot be pruned/)
  const pruned = reportAblation(cwd, 'warm')
  assert.deepEqual(pruned.attribution.pruned, ['no-cache'])
  assert.equal(pruned.attribution.components.find((entry) => entry.arm === 'no-cache').reading, 'pruned')
  status = statusAblation(cwd, 'warm')
  assert.deepEqual(status.pruned, ['no-cache'])

  const md = exportAblation({ cwd, slug: 'warm', format: 'markdown' })
  assert.ok(existsSync(join(cwd, md.path)))
  const markdown = readFileSync(join(cwd, md.path), 'utf8')
  assert.match(markdown, /# Ablation: warm/)
  assert.match(markdown, /Attribution reading/)
  assert.match(markdown, /no-warm/)
  const csv = exportAblation({ cwd, slug: 'warm', format: 'csv' })
  assert.match(readFileSync(join(cwd, csv.path), 'utf8').split('\n')[0], /arm,component,code_path,dataset,replicate,metric/)
  const json = exportAblation({ cwd, slug: 'warm', format: 'json' })
  const exported = JSON.parse(readFileSync(join(cwd, json.path), 'utf8'))
  assert.equal(exported.report.attribution.attributed[0], 'no-warm')
  assert.equal(exported.records.length, 13)
  assert.throws(() => exportAblation({ cwd, slug: 'warm', format: 'xlsx' }), /format must be one of/)

  console.log('ablation store OK')
} finally {
  ws.cleanup()
}
