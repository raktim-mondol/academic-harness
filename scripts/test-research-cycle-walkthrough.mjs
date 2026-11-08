/**
 * Scripted walkthrough of the `research-cycle` guide (plan phase 4's fixture
 * walkthrough). A small driver follows the guide's steps against the REAL
 * experiment, analysis, and figure tools in a temporary workspace and stops
 * where the guide says to stop.
 *
 * What this is: a check that the ledgers report the states the guide relies on
 * (missing, unknown, failed, unpaired, unranked) and that a declined action
 * leaves every ledger untouched.
 *
 * What this is not: a test of a model. The approval gate below is test-side
 * driver logic that stands in for `ask_user_question`; it shows that the tools
 * support stopping honestly, not that a model will. A run with a real model is
 * separate and is not covered here.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { apply as applyExperiment } from '../experiment-log.js'
import { apply as applyFigure } from '../figure-audit.js'
import { freezeAnalysisPlan, runAnalysis } from '../analysis-store.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const ws = makeWorkspace('ah-walkthrough-')
const cwd = ws.cwd
let experiment
let figure
applyExperiment({ tools: { register(value) { experiment = value } } })
applyFigure({ tools: { register(value) { figure = value } } })
const exp = (args) => experiment.execute(args, fakeExec(cwd))
const fig = (args) => figure.execute({ action: 'handoff', ...args }, fakeExec(cwd))

/** Hash the whole workspace so "nothing changed" is a checked fact. */
function snapshot(dir = cwd, out = {}) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) snapshot(full, out)
    else out[full.slice(cwd.length)] = createHash('sha256').update(readFileSync(full)).digest('hex')
  }
  return out
}

/** The guide's rule, as test-side driver logic: consequential actions need an explicit yes. */
const CONSEQUENTIAL = new Set(['analysis_run:run', 'runpod_run', 'modal_run', 'vastai_run', 'deep_review:review', 'repro_package:deposit'])
const log = []
async function attempt(label, approved, action) {
  if (CONSEQUENTIAL.has(label) && !approved) {
    log.push({ label, outcome: 'stopped_for_approval' })
    return { stopped: true }
  }
  log.push({ label, outcome: 'ran' })
  return { stopped: false, value: await action() }
}

const identity = { dataset: { id: 'd', version_or_hash: 'v1' }, split: { id: 'test', version_or_hash: 's1' }, baseline_cohort_id: 'ref', metric_definitions: { acc: { unit: 'fraction', implementation: 'acc-v1', parameters: {} } } }
const benchmark = { datasets: ['d'], splits: ['test'], baseline_arm: 'base', task_rules: ['fixed'] }

try {
  ws.write('eval.py', 'print(1)\n')

  // ---- Scenario 1: no data declared. Step 3 reports what is missing; nothing is ranked. ----
  await exp({ action: 'start', slug: 'nodata', question: 'Does X beat Y?', experiment: { metrics: [{ name: 'acc', direction: 'higher' }] } })
  await exp({ action: 'log', slug: 'nodata', metrics: { acc: 0.7 }, seed: 1 })
  await exp({ action: 'log', slug: 'nodata', metrics: { acc: 0.9 }, seed: 2 })
  const noData = (await exp({ action: 'compare', slug: 'nodata' })).comparison
  assert.deepEqual(noData.comparison_scope.available_scopes, [], 'no dataset or split declared, so there is no scope')
  assert.match(noData.comparison_scope.note, /No ranking without an explicit scope_id/)
  assert.equal(noData.runs.length, 2, 'the raw runs stay visible')
  assert.ok(noData.comparison_scope.assessments.every((a) => a.state === 'not_checked'), 'unknown, not matched')
  const noDataBest = await exp({ action: 'best', slug: 'nodata', metric: 'acc' })
  assert.match(noDataBest.error, /best requires an explicit scope_id/, 'best refuses to name a winner without a scope')

  // ---- Scenario 2: missing baseline. A staged variant is refused, not silently attached. ----
  await exp({ action: 'start', slug: 'bench', question: 'Does the variant beat the baseline?', experiment: { metrics: [{ name: 'acc', direction: 'higher' }], benchmark, protocol: { eval_script: 'eval.py', metric_params: { k: 1 } } } })
  const staged = { action: 'log', slug: 'bench', stage: 'slice', baseline_ref: 'reproduced', comparison_identity: identity, sampling: { rule: 'first 100 per class', size: 100, seed: 7 } }
  const noBase = await exp({ ...staged, role: 'variant', seed: 1, params: { method: 'variant' }, metrics: { acc: 0.8 } })
  assert.match(noBase.error, /baseline_run_id/, 'a variant with no explicit baseline is refused')
  const badBase = await exp({ ...staged, role: 'variant', seed: 1, params: { method: 'variant' }, baseline_run_id: 'x9999', metrics: { acc: 0.8 } })
  assert.ok(badBase.error, 'a baseline that does not exist is refused')
  assert.equal((await exp({ action: 'list', slug: 'bench' })).runs.length, 0, 'nothing was recorded by the refused calls')

  // ---- Scenario 3: pilot slice with an unpaired seed. Replicates shows the gap. ----
  const b1 = (await exp({ ...staged, role: 'baseline', seed: 1, params: { method: 'base' }, metrics: { acc: 0.6 } })).run
  const b2 = (await exp({ ...staged, role: 'baseline', seed: 2, params: { method: 'base' }, metrics: { acc: 0.62 } })).run
  assert.equal(b1.error, undefined)
  const v1 = (await exp({ ...staged, role: 'variant', seed: 1, params: { method: 'variant' }, baseline_run_id: b1.run_id, metrics: { acc: 0.7 } })).run
  const v3 = (await exp({ ...staged, role: 'variant', seed: 3, params: { method: 'variant' }, baseline_run_id: b1.run_id, metrics: { acc: 0.74 } })).run
  const scope = b1.comparison_identity.scope_id
  const reps = await exp({ action: 'replicates', slug: 'bench', scope_id: scope, metric: 'acc', candidate_field: 'method', candidates: ['base', 'variant'], baseline_candidate: 'base', replicate_unit: 'one training run', expected_seeds: [1, 2, 3] })
  assert.equal(reps.error, undefined, JSON.stringify(reps))
  const variant = reps.report.groups.find((g) => g.candidate === 'variant')
  const base = reps.report.groups.find((g) => g.candidate === 'base')
  assert.deepEqual(variant.seed_coverage.missing, [2], 'seed 2 was planned for the variant and is missing')
  assert.deepEqual(base.seed_coverage.missing, [3], 'seed 3 has no baseline run')
  assert.equal(variant.paired.pairs.length, 1, 'only the seed-1 pair is complete')
  assert.ok(variant.paired.unpaired.some((row) => row.run_id === v3.run_id), 'the unpaired variant run is listed, not dropped')
  assert.ok(variant.paired.unpaired_baselines.some((row) => row.run_id === b2.run_id), 'and so is the unpaired baseline')
  assert.ok(!('winner' in reps.report) && !JSON.stringify(reps.report).includes('p_value'), 'no winner and no p-value')

  // ---- Scenario 4: declined full run. The guide proposes it, the researcher declines, nothing changes. ----
  const beforeDecline = snapshot()
  const proposed = await attempt('analysis_run:run', false, async () => { throw new Error('must not run') })
  assert.equal(proposed.stopped, true)
  assert.deepEqual(snapshot(), beforeDecline, 'a declined full run leaves every file and ledger untouched')
  const afterDecline = (await exp({ action: 'compare', slug: 'bench' })).comparison
  assert.deepEqual(afterDecline.comparison_scope.available_scopes, [scope], 'only the slice scope exists; no full-stage run was invented')
  assert.equal(afterDecline.comparison_scope.scope_id, null, 'and no scope was chosen implicitly')
  const ranked = await exp({ action: 'best', slug: 'bench', metric: 'acc', scope_id: scope })
  assert.equal(ranked.error, undefined, JSON.stringify(ranked))
  assert.ok(JSON.stringify(ranked).includes(v3.run_id), 'within the one declared scope the ranking works')

  // ---- Scenario 5: a failed run. Its status is evidence-only and it reaches the figure report. ----
  ws.write('make.py', 'open("fig.png","wb").write(b"png")\n')
  await freezeAnalysisPlan({ cwd, slug: 'pilot', plan: { question: 'Does the pilot run?', outputs: ['fig.png'] } })
  const failedRun = await runAnalysis({ cwd, slug: 'pilot', command: ['python3', '-c', 'raise SystemExit(4)'], notebookEntry: null })
  assert.equal(failedRun.exit_code, 4)
  await exp({ action: 'link', slug: 'bench', run_id: v3.run_id, target_kind: 'analysis_run', target_id: `pilot:${failedRun.run_id}` })
  const branches = (await exp({ action: 'branches', slug: 'bench', format: 'json' })).branches
  const node = branches.nodes.find((n) => n.run_id === v3.run_id)
  assert.equal(node.status, 'failed', 'failed because a linked execution failed, nothing else')
  const noMetricNode = branches.nodes.find((n) => n.run_id === b2.run_id)
  assert.notEqual(noMetricNode.status, 'failed', 'a run is never called failed just because of its state')
  ws.write('fig.png', 'png')
  const handoff = await fig({ figure: 'fig.png', sources: [{ kind: 'analysis_run', slug: 'pilot', run_id: failedRun.run_id }, { kind: 'experiment_run', slug: 'bench', run_id: v3.run_id }] })
  assert.equal(handoff.sources[0].execution.status, 'failed')
  assert.equal(handoff.sources[1].execution.status, 'failed', 'the experiment run inherits the failure through its link')
  assert.ok(handoff.gaps.some((gap) => /execution status is failed/.test(gap)))
  assert.ok(handoff.gaps.some((gap) => /not_recorded|figure is/.test(gap)), 'the figure is not credited to a run that failed')

  // ---- The guide never started anything on its own. ----
  assert.deepEqual(log, [{ label: 'analysis_run:run', outcome: 'stopped_for_approval' }])

  console.log('research-cycle walkthrough OK')
} finally {
  ws.cleanup()
}
