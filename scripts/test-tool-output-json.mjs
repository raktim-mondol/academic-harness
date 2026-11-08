/**
 * The DSH host rejects a tool result that is not lossless JSON ("returned invalid
 * output: value is not lossless JSON"). An `undefined` property value is enough.
 * Plain tool tests call execute() directly and never see that check, which is how
 * experiment_log action=branches shipped broken. This runs every action added in
 * plan phases 1-5 and applies the host's own isJsonValue to the result.
 */
import assert from 'node:assert/strict'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import { apply as applyExperiment } from '../experiment-log.js'
import { apply as applyFigure } from '../figure-audit.js'
import { apply as applyPriorArt } from '../prior-art.js'
import { applyWorkflows } from '../workflows.js'
import { freezeAnalysisPlan, runAnalysis } from '../analysis-store.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const ws = makeWorkspace('ah-json-')
const cwd = ws.cwd
const tools = {}
for (const [name, register] of [['experiment', applyExperiment], ['figure', applyFigure], ['prior', applyPriorArt]]) register({ tools: { register(t) { tools[name] = t } } })
applyWorkflows({ tools: { register(t) { tools.template = t } } })
const exec = fakeExec(cwd)

const offenders = (value, path = '') => {
  if (value === undefined) return [`${path || '(root)'} is undefined`]
  if (typeof value === 'number' && !Number.isFinite(value)) return [`${path} is ${value}`]
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return [`${path} is a ${typeof value}`]
  if (value === null || typeof value !== 'object') return []
  if (value instanceof Date || value instanceof Map || value instanceof Set) return [`${path} is a ${value.constructor.name}`]
  return Object.entries(value).flatMap(([key, entry]) => offenders(entry, `${path}.${key}`))
}
let checked = 0
async function ok(label, promise) {
  const out = await promise
  checked += 1
  assert.ok(isJsonValue(out), `${label}: the host would reject this result as not lossless JSON: ${offenders(out).slice(0, 5).join('; ') || 'unknown cause'}`)
  return out
}

try {
  const identity = { dataset: { id: 'd', version_or_hash: 'v1' }, split: { id: 'test', version_or_hash: 's1' }, baseline_cohort_id: 'ref', metric_definitions: { acc: { unit: 'fraction', implementation: 'acc-v1', parameters: {} } } }
  ws.write('eval.py', 'print(1)\n')
  ws.write('out/metrics.json', '{"metrics": {"acc": 0.8}}')
  ws.write('out/fig.png', 'png bytes')
  const exp = (args) => ok(`experiment_log ${args.action}${args.format ? ` ${args.format}` : ''}`, tools.experiment.execute(args, exec))

  await exp({ action: 'start', slug: 'b', question: 'q', experiment: { metrics: [{ name: 'acc', direction: 'higher' }], benchmark: { datasets: ['d'], splits: ['test'], baseline_arm: 'base', task_rules: ['fixed'] }, protocol: { eval_script: 'eval.py', metric_params: { k: 1 } } } })
  const staged = { action: 'log', slug: 'b', stage: 'slice', baseline_ref: 'reproduced', comparison_identity: identity, sampling: { rule: 'first 100', size: 100, seed: 7 } }
  const b1 = (await exp({ ...staged, role: 'baseline', seed: 1, params: { method: 'base' }, metrics: { acc: 0.6 } })).run
  const v1 = (await exp({ ...staged, role: 'variant', seed: 1, params: { method: 'variant' }, baseline_run_id: b1.run_id, metrics: { acc: 0.7 }, artifacts: ['out/fig.png'] })).run
  await exp({ action: 'log', slug: 'b', params: {}, metrics: { acc: 0.1 } })
  const scope = b1.comparison_identity.scope_id
  await exp({ action: 'compare', slug: 'b' })
  await exp({ action: 'compare', slug: 'b', scope_id: scope })
  await exp({ action: 'best', slug: 'b', metric: 'acc', scope_id: scope })
  await exp({ action: 'best', slug: 'b', metric: 'acc' })
  await exp({ action: 'replicates', slug: 'b', scope_id: scope, metric: 'acc', candidate_field: 'method', candidates: ['base', 'variant'], baseline_candidate: 'base', replicate_unit: 'run', expected_seeds: [1, 2] })
  await exp({ action: 'replicates', slug: 'b', scope_id: scope, metric: 'acc', candidate_field: 'method', candidates: ['base'], replicate_unit: 'run', coverage_unknown: true })
  for (const format of ['text', 'json', 'mermaid']) await exp({ action: 'branches', slug: 'b', format })
  await exp({ action: 'branches', slug: 'b', format: 'mermaid', write: true })
  await exp({ action: 'branches', slug: 'b', format: 'mermaid', write: true, overwrite: true })
  await exp({ action: 'verdict', slug: 'b', run_id: v1.run_id, verdict: 'good', reason: 'ok' })
  await freezeAnalysisPlan({ cwd, slug: 'g', plan: { question: 'g?', outputs: ['out/metrics.json', 'out/fig.png'] } })
  const run = await runAnalysis({ cwd, slug: 'g', command: ['python3', '-c', 'pass'], notebookEntry: null })
  await exp({ action: 'link', slug: 'b', run_id: v1.run_id, target_kind: 'analysis_run', target_id: `g:${run.run_id}` })
  await exp({ action: 'branches', slug: 'b', format: 'json' })
  for (const action of ['status', 'list']) await exp({ action, slug: 'b' })
  await exp({ action: 'show', slug: 'b', run_id: v1.run_id })
  for (const format of ['json', 'csv', 'markdown', 'mlflow']) await exp({ action: 'export', slug: 'b', format, scope_id: scope, overwrite: true })

  const fig = (args, label = 'figure_audit handoff') => ok(label, tools.figure.execute({ action: 'handoff', ...args }, exec))
  await fig({ figure: 'out/fig.png', reference: 'Figure 1', caption: 'Accuracy 0.8 (n = 3).', sources: [{ kind: 'analysis_run', slug: 'g', run_id: run.run_id, path: 'out/metrics.json' }, { kind: 'experiment_run', slug: 'b', run_id: v1.run_id }, { kind: 'analysis_run', slug: 'g', run_id: 'nope' }, { kind: 'bad' }], values: [{ path: 'out/metrics.json', format: 'json', field: 'metrics.acc' }, { path: 'out/metrics.json', format: 'json', field: 'missing' }], vision_review: { summary: 'a picture', reviewer: 'x' } })
  await fig({ figure: 'out/fig.png' }, 'figure_audit handoff (no sources)')
  await fig({ figure: 'out/missing.png' }, 'figure_audit handoff (missing figure)')
  await fig({ figure: '../escape.png' }, 'figure_audit handoff (escaping path)')
  await fig({}, 'figure_audit handoff (error)')

  const claim = 'Contrastive pretraining of graph encoders improves low-data property prediction.'
  const search = { provider: 'p', query: 'q', status: 'ok', accessed_at: '2026-11-08T00:00:00Z', limit: 10, result_count: 2 }
  const pa = (args, label) => ok(label, tools.prior.execute(args, exec))
  await pa({ claim, searches: [search], candidates: [{ ref: { title: 'A paper', doi: '10.1000/x.1' }, evidence_level: 'abstract', text: 'Contrastive pretraining of graph encoders improves low-data property prediction.', quotes: [{ quote: 'Contrastive pretraining of graph encoders improves', location: 'abstract' }], overlap: { claimed: 'close', distinction: 'x' } }, { ref: { title: 'B' }, evidence_level: 'full_text_unavailable', overlap: { claimed: 'unknown' } }] }, 'prior_art report')
  await pa({ claim, searches: [{ provider: 'p', query: 'q', status: 'failed', error: 'down' }] }, 'prior_art (failed search)')
  await pa({ claim, searches: [{ provider: 'p', query: 'q', status: 'weird' }], candidates: [{ evidence_level: 'bogus', overlap: { claimed: 'huge' } }] }, 'prior_art (invalid input)')
  await pa({ claim, searches: [search], write: true, slug: 'json check' }, 'prior_art write')
  await pa({}, 'prior_art (error)')

  await ok('research_template get', tools.template.execute({ action: 'get', id: 'research-cycle', values: { slug: 's', question: 'q' } }, exec))
  await ok('research_template list', tools.template.execute({ action: 'list', category: 'data' }, exec))
  await ok('research_template unknown', tools.template.execute({ action: 'get', id: 'nope' }, exec))

  assert.ok(checked >= 35, `ran ${checked} checks`)
  console.log(`tool output JSON OK (${checked} results checked with the host's isJsonValue)`)
} finally {
  ws.cleanup()
}
