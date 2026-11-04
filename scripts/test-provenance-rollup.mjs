/**
 * Phase 9: the loop roll-up joins the ideation ledger with Phase 4–8 evidence.
 * It is a report (no store, no promotion) and it reports missing cost/time as
 * missing, never zero.
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'
import {
  addHypothesis, addLimitation, selectChampion, setStatus, startTournament, verifyLimitation,
} from '../coscientist-store.js'
import { logExperimentRun, linkExperimentRun, startExperiment, verdictExperiment } from '../experiment-store.js'
import { expectAnalysisScores, freezeAnalysisPlan, runAnalysis, verifyAnalysisScores } from '../analysis-store.js'
import { planAblation, recordAblation, startAblation, verdictAblation } from '../ablation-store.js'
import { buildProvenanceIndex, rollupOf } from '../provenance-store.js'
import { apply as applyProvenance, runProvenanceAction } from '../provenance-audit.js'

const workspace = makeWorkspace('ah-provenance-rollup-')
const runLines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
const cwd = workspace.cwd
const exec = fakeExec(cwd)

try {
  // Ideation: problem, two ideas, one limitation, a selection.
  await startTournament({ cwd, slug: 'cycle', protocol: { goal: 'Does the gate improve calibration?' } })
  const h1 = await addHypothesis({ cwd, slug: 'cycle', hypothesis: {
    title: 'Adaptive gate', summary: 'A gate tuned on the calibration split.',
    content: 'The method uses a fixed threshold. This ignores calibration drift.',
  } })
  const h2 = await addHypothesis({ cwd, slug: 'cycle', hypothesis: {
    title: 'Static gate', summary: 'A fixed threshold baseline.', content: 'A static threshold is simple.',
  } })
  await setStatus({ cwd, slug: 'cycle', id: h1.hypothesis.id, status: 'active', reason: 'reviewed' })
  await setStatus({ cwd, slug: 'cycle', id: h2.hypothesis.id, status: 'active', reason: 'reviewed' })
  const limitation = await addLimitation({ cwd, slug: 'cycle', flaw: 'The threshold ignores calibration drift.', why: 'It caps performance on shifted data.', opportunities: ['Recalibrate per split', 'Model the threshold'], quote: 'fixed threshold', source: h1.hypothesis.id })
  await verifyLimitation({ cwd, slug: 'cycle', id: limitation.limitation.id, verdict: 'sufficient', reason: 'addressed by the idea' })
  const selection = await selectChampion({ cwd, slug: 'cycle', id: h1.hypothesis.id, comparedIds: [h2.hypothesis.id], rationale: 'better calibration' })
  assert.match(selection.selection.evidence_digest, /^sha256:/)

  // Analysis: a reproduced baseline that verify_scores actually gates.
  mkdirSync(join(cwd, 'analysis'), { recursive: true })
  writeFileSync(join(cwd, 'analysis', 'run.py'), 'import json\nwith open("r.json", "w") as fh:\n    json.dump({"auroc": 0.8}, fh)\n')
  await freezeAnalysisPlan({ cwd, slug: 'analysis', plan: { question: 'Does the gate improve AUROC?', outputs: ['r.json'] } })
  const analysisRun = await runAnalysis({ cwd, slug: 'analysis', command: ['python3', 'analysis/run.py'], notebookEntry: null })
  await expectAnalysisScores({ cwd, slug: 'analysis', metrics: [{ name: 'AUROC', value: 0.8, path: 'r.json', format: 'json', key: 'auroc' }], reference: 'reproduced' })
  assert.equal((await verifyAnalysisScores({ cwd, slug: 'analysis' })).check.reproduction, true)
  // A deterministic re-execution touches its own output, so it is credited with
  // writing it; the baseline gate below is satisfied by this second run, not by
  // the run the expectation was declared from.
  const rerun = await runAnalysis({ cwd, slug: 'analysis', command: ['python3', 'analysis/run.py'], notebookEntry: null })
  assert.equal(rerun.outputs[0].written_by_run, true, 'a rerun that rewrites identical bytes is still the writer')
  assert.equal(rerun.outputs[0].write_status, 'rewritten_identical')
  assert.equal((await verifyAnalysisScores({ cwd, slug: 'analysis', run_id: rerun.run_id })).check.reproduction, true)

  // Experiment: a subset baseline and a full variant, both linked to the analysis.
  const protocol = { eval_script: 'analysis/run.py', metric_params: {} }
  await startExperiment({ cwd, slug: 'exp', experiment: {
    question: 'Which gate wins?', metrics: [{ name: 'auroc', direction: 'higher' }],
    benchmark: { datasets: ['d'], splits: ['val', 'test'], baseline_arm: 'static', task_rules: ['no test leakage'] }, protocol,
  } })
  await logExperimentRun({ cwd, slug: 'exp', metrics: { auroc: 0.78 }, params: { idea_id: 'h2' }, role: 'baseline', baselineRef: 'reproduced', stage: 'subset', sampling: { size: 100, seed: 7 }, protocol })
  await logExperimentRun({ cwd, slug: 'exp', metrics: { auroc: 0.84 }, params: { idea_id: 'h1' }, role: 'variant', baselineRef: 'reproduced', stage: 'full', sampling: { rule: 'all' }, protocol })
  await linkExperimentRun({ cwd, slug: 'exp', runId: 'x0001', targetKind: 'analysis_run', targetId: analysisRun.run_id })
  await linkExperimentRun({ cwd, slug: 'exp', runId: 'x0002', targetKind: 'analysis_run', targetId: analysisRun.run_id })
  await verdictExperiment({ cwd, slug: 'exp', runId: 'x0002', verdict: 'good', reason: 'improves AUROC' })

  // Ablation: the champion's component has a good human attribution verdict.
  await startAblation({ cwd, slug: 'ab', ideaId: 'h1', method: { name: 'gate' }, question: 'Does the gate help?' })
  await planAblation({ cwd, slug: 'ab', plan: {
    datasets: ['d'], metrics: [{ name: 'auroc', direction: 'higher' }], replicates: 1,
    arms: [{ id: 'full' }, { id: 'no-gate', component: 'gate', code_path: 'src/gate.py', expected: [{ metric: 'auroc', change: 'decrease' }] }],
  } })
  await recordAblation({ cwd, slug: 'ab', arm: 'full', dataset: 'd', experimentSlug: 'exp', experimentRunId: 'x0002' })
  await recordAblation({ cwd, slug: 'ab', arm: 'no-gate', dataset: 'd', experimentSlug: 'exp', experimentRunId: 'x0001' })
  await verdictAblation({ cwd, slug: 'ab', verdict: 'good', reason: 'the gate carries the gain' })

  // Two review rounds with evaluator kind and token tallies.
  writeFileSync(join(cwd, 'paper.md'), '# Paper\n')
  mkdirSync(join(cwd, '.dsh', 'deep-review', 'paper'), { recursive: true })
  writeFileSync(join(cwd, '.dsh', 'deep-review', 'paper', 'meta.json'), JSON.stringify({
    input: { path: 'paper.md' }, latest_round: 2, rounds: [
      { round: 1, run_id: 'r1', evaluator_kind: 'held_out', evaluator_kind_source: 'declared', duration_ms: 5000, usage: { calls: 2, prompt_tokens: 1000, completion_tokens: 500 }, counts: { comments: 3 } },
      { round: 2, run_id: 'r2', evaluator_kind: 'in_distribution', evaluator_kind_source: 'declared', duration_ms: 7000, usage: { calls: 3, prompt_tokens: 1200, completion_tokens: 600 }, counts: { comments: 5 } },
      { round: 3, run_id: 'r3', evaluator_kind: 'held_out' },
    ],
  }))
  writeFileSync(join(cwd, '.dsh', 'deep-review', 'paper', 'score.json'), JSON.stringify({ state: 'checked', overall: 7 }))

  const index = await buildProvenanceIndex({ cwd, slug: 'rollup', selection: { ah: false } })
  const before = {
    events: readFileSync(join(cwd, '.dsh', 'coscientist', 'cycle', 'events.jsonl'), 'utf8'),
    runs: readFileSync(join(cwd, '.dsh', 'experiments', 'exp', 'runs.jsonl'), 'utf8'),
    plan: readFileSync(join(cwd, '.dsh', 'analysis', 'analysis', 'plan.jsonl'), 'utf8'),
  }
  const rollup = rollupOf(index, { cwd, coscientist: 'cycle', manuscript: 'paper.md', limit: 20 })
  assert.equal(rollup.decision, 'report_only')
  const cycle = rollup.cycles[0]
  assert.equal(cycle.problem.goal, 'Does the gate improve calibration?')
  assert.equal(cycle.problem.analyses[0].question, 'Does the gate improve AUROC?')
  assert.equal(cycle.limitations.coverage.limitations, 1)
  assert.equal(cycle.limitations.coverage.sufficient, 1)
  assert.equal(cycle.ideas.counts.total, 2)
  assert.equal(cycle.ideas.champion_id, 'h1')
  assert.equal(cycle.stages.subset.run_count, 1)
  assert.equal(cycle.stages.scale_up.run_count, 1)
  assert.equal(cycle.stages.scale_up.verdicts.good, 1)
  assert.equal(cycle.selection.idea_id, 'h1')
  assert.match(cycle.selection.evidence_digest, /^sha256:/)
  assert.equal(cycle.ablation.rows.length, 1)
  assert.equal(cycle.ablation.rows[0].latest_verdict, 'good')
  assert.equal(cycle.reviews.totals.rounds, 3)
  assert.equal(cycle.reviews.totals.held_out, 2)
  assert.equal(cycle.reviews.totals.in_distribution, 1)
  assert.equal(cycle.reviews.totals.tokens, 3300)
  assert.equal(cycle.reviews.totals.duration_ms, 12000)
  assert.equal(cycle.reviews.cycle_linked, false, 'a manuscript match does not establish a cycle link')
  assert.equal(cycle.integrity.rows.length, 5,
    'the four read ledgers plus the AH source this selection skipped')
  assert.equal(cycle.integrity.rows.find((row) => row.artifact === 'ah:project').readiness, 'not_checked',
    'an AH source that was not read is a row of its own, never an omission')
  assert.equal(cycle.baseline_gate.state, 'verified')
  assert.equal(cycle.incumbent.state, 'selected')
  assert.equal(cycle.incumbent.promotion.state, 'not_recorded')
  assert.equal(rollup.decision, 'report_only')
  assert.match(rollup.notes.join(' '), /successful cases only/)

  const analysisDuration = Number(runLines(join(cwd, '.dsh', 'analysis', 'analysis', 'runs.jsonl'))[0].duration_ms)
  assert.equal(cycle.cost.recorded_ms, analysisDuration + 12000)
  assert.equal(cycle.cost.recorded_tokens, 3300)
  assert.equal(cycle.cost.model_calls, 5)
  assert.ok(cycle.cost.missing.some((entry) => /ablation/.test(entry)))
  assert.ok(cycle.cost.missing.some((entry) => /selection/.test(entry)))
  assert.ok(cycle.cost.missing.some((entry) => /ideation/.test(entry)))
  assert.ok(cycle.cost.missing.some((entry) => /review/.test(entry)), 'the round without duration/usage is listed, not zeroed')
  assert.match(cycle.cost.accounting, /33 of 107/)
  assert.equal(cycle.cost.recorded_ms === 0, false, 'missing time is not zero')
  const withoutManuscript = rollupOf(index, { cwd, coscientist: 'cycle', limit: 20 }).cycles[0]
  assert.equal(withoutManuscript.reviews.totals.rounds, 0, 'unselected workspace reviews are not attributed to a cycle')
  assert.equal(withoutManuscript.cost.coverage.review_rounds, 0)
  assert.equal(withoutManuscript.cost.recorded_tokens, null)
  assert.ok(!withoutManuscript.integrity.rows.some((row) => row.artifact.startsWith('deep_review:')))
  assert.ok(withoutManuscript.warnings.some((warning) => /Review rounds were not selected/.test(warning)))

  // Read-only.
  assert.equal(readFileSync(join(cwd, '.dsh', 'coscientist', 'cycle', 'events.jsonl'), 'utf8'), before.events)
  assert.equal(readFileSync(join(cwd, '.dsh', 'experiments', 'exp', 'runs.jsonl'), 'utf8'), before.runs)
  assert.equal(readFileSync(join(cwd, '.dsh', 'analysis', 'analysis', 'plan.jsonl'), 'utf8'), before.plan)

  const result = await runProvenanceAction({ action: 'rollup', audit: 'rollup', coscientist: 'cycle', manuscript: 'paper.md' }, exec)
  assert.equal(result.action, 'rollup')
  let tool
  applyProvenance({ tools: { register: (registered) => { tool = registered } } })
  const executed = await tool.execute({ action: 'rollup', audit: 'rollup', coscientist: 'cycle', manuscript: 'paper.md' }, exec)
  const rendered = tool.output.render({ action: 'rollup' }, executed)
  assert.match(rendered[0].text, /Loop roll-up \(report only\)/)
  assert.match(rendered[0].text, /Baseline gate: verified/)
  assert.match(rendered[0].text, /selected, not promoted/)

  // Cross-cycle: idea ids are a per-tournament counter, so a bare "h1" from a
  // second cycle must not be claimed by the first, and must say so.
  await startTournament({ cwd, slug: 'next', protocol: { goal: 'What improves on the gate?' } })
  const nextH1 = await addHypothesis({ cwd, slug: 'next', hypothesis: {
    title: 'Isotonic layer', summary: 'Fit the calibration inside the model.', content: 'The gate is post hoc.',
  } })
  await setStatus({ cwd, slug: 'next', id: nextH1.hypothesis.id, status: 'active', reason: 'reviewed' })
  await startExperiment({ cwd, slug: 'exp-next', experiment: {
    question: 'Does the layer win?', metrics: [{ name: 'auroc', direction: 'higher' }],
  } })
  await logExperimentRun({ cwd, slug: 'exp-next', metrics: { auroc: 0.9 }, params: { idea_id: 'h1' } })
  await startExperiment({ cwd, slug: 'shared', experiment: {
    question: 'Shared ledger', metrics: [{ name: 'auroc', direction: 'higher' }],
    benchmark: { datasets: ['d'], splits: ['val'], baseline_arm: 'static', task_rules: ['no leakage'] }, protocol,
  } })
  await logExperimentRun({ cwd, slug: 'shared', metrics: { auroc: 0.7 }, params: { idea_id: 'cycle#h1' }, role: 'baseline', baselineRef: 'reproduced', stage: 'subset', sampling: { size: 100, seed: 7 } })
  await logExperimentRun({ cwd, slug: 'shared', metrics: { auroc: 0.8 }, params: { idea_id: 'next#h1' }, role: 'baseline', baselineRef: 'reproduced', stage: 'subset', sampling: { size: 100, seed: 7 } })
  await logExperimentRun({ cwd, slug: 'shared', metrics: { auroc: 0.6 }, params: {}, role: 'baseline', baselineRef: 'reproduced', stage: 'subset', sampling: { size: 100, seed: 7 } })
  const crossIndex = await buildProvenanceIndex({ cwd, slug: 'rollup-cross', selection: { ah: false } })
  const cross = rollupOf(crossIndex, { cwd, manuscript: 'paper.md', limit: 20 })
  const cycleA = cross.cycles.find((entry) => entry.id === 'cycle')
  const cycleB = cross.cycles.find((entry) => entry.id === 'next')
  assert.equal(cycleA.stages.subset.run_count, 2, 'cycle A keeps its own run from the shared ledger')
  assert.deepEqual(cycleA.stages.subset.runs.filter((row) => row.experiment === 'shared').map((row) => row.run_id), ['x0001'])
  assert.deepEqual(cycleB.stages.subset.runs.filter((row) => row.experiment === 'shared').map((row) => row.run_id), ['x0002'])
  assert.ok(cycleA.warnings.some((entry) => /Ambiguous experiment runs.*shared\/x0003/.test(entry)))
  assert.ok(!cycleA.integrity.rows.some((row) => row.artifact === 'experiment:exp-next'),
    'cycle A does not claim cycle B experiment ledger')
  assert.ok(!cycleB.stages.scale_up.run_count && !cycleB.integrity.rows.some((row) => row.artifact === 'experiment:exp'),
  'cycle B does not claim cycle A evidence either')
  assert.ok(cycleB.warnings.some((entry) => /idea id "h1" is declared by/.test(entry)),
    `the contested id is reported: ${JSON.stringify(cycleB.warnings)}`)
  assert.ok(cycleB.warnings.some((entry) => /Reference it as "next#h1"/.test(entry)), 'and names the scoped form')

  // Workspace scope with no tournament, including an expectation verified against
  // the very run it was declared from.
  const flat = makeWorkspace('ah-provenance-rollup-flat-')
  try {
    const cwdFlat = flat.cwd
    mkdirSync(join(cwdFlat, 'analysis'), { recursive: true })
    writeFileSync(join(cwdFlat, 'analysis', 'run.py'), 'import json\nwith open("f.json", "w") as fh:\n    json.dump({"auroc": 0.6}, fh)\n')
    await freezeAnalysisPlan({ cwd: cwdFlat, slug: 'selfcheck', plan: { question: 'Self-check?', outputs: ['f.json'] } })
    const single = await runAnalysis({ cwd: cwdFlat, slug: 'selfcheck', command: ['python3', 'analysis/run.py'], notebookEntry: null })
    await expectAnalysisScores({ cwd: cwdFlat, slug: 'selfcheck', reference: 'reproduced', metrics: [{ name: 'AUROC', value: 0.6, path: 'f.json', format: 'json', key: 'auroc' }] })
    await verifyAnalysisScores({ cwd: cwdFlat, slug: 'selfcheck', run_id: single.run_id })
    writeFileSync(join(cwdFlat, 'paper.md'), '# Paper\n')
    mkdirSync(join(cwdFlat, '.dsh', 'deep-review', 'paper'), { recursive: true })
    writeFileSync(join(cwdFlat, '.dsh', 'deep-review', 'paper', 'meta.json'), JSON.stringify({ input: { path: 'paper.md' }, latest_round: 2, rounds: [{ round: 1, run_id: 'r1', duration_ms: 5000, usage: { calls: 2, prompt_tokens: 10, completion_tokens: 5 } }, { round: 2, run_id: 'r2', duration_ms: '  ' }] }))
    mkdirSync(join(cwdFlat, '.dsh', 'deep-review', 'other'), { recursive: true })
    writeFileSync(join(cwdFlat, '.dsh', 'deep-review', 'other', 'meta.json'), JSON.stringify({ input: { path: 'other.md' }, latest_round: 1, rounds: [{ round: 1, run_id: 'r9', duration_ms: 90000, usage: { calls: 9, prompt_tokens: 900, completion_tokens: 900 } }] }))
    const flatIndex = await buildProvenanceIndex({ cwd: cwdFlat, slug: 'rollup-flat', selection: { ah: false } })
    const flatRollup = rollupOf(flatIndex, { cwd: cwdFlat, manuscript: 'paper.md', limit: 20 })
    assert.equal(flatRollup.cycles[0].id, 'workspace')
    assert.equal(flatRollup.cycles[0].baseline_gate.rows[0].state, 'not_checked')
    assert.match(flatRollup.cycles[0].baseline_gate.rows[0].reason, /same run it was declared from/,
      'a self-check is not a re-execution')
    // The cost block must summarise exactly the review rows the report shows.
    assert.equal(flatRollup.cycles[0].cost.coverage.review_rounds, flatRollup.cycles[0].reviews.totals.rounds)
    assert.equal(flatRollup.cycles[0].cost.recorded_ms, flatRollup.cycles[0].reviews.totals.duration_ms)
    assert.equal(flatRollup.cycles[0].cost.recorded_tokens, flatRollup.cycles[0].reviews.totals.tokens)
    assert.equal(flatRollup.cycles[0].cost.coverage.review_rounds_with_duration, 1)
    assert.ok(flatRollup.cycles[0].cost.missing.some((entry) => /duration/.test(entry)))
    assert.match(flatRollup.cycles[0].cost.denominator, /2 review round/,
      'the denominator counts the manuscript-matched round only')

    await freezeAnalysisPlan({ cwd: cwdFlat, slug: 'no-reference', plan: { question: 'No reference run?', outputs: ['f.json'] } })
    await expectAnalysisScores({ cwd: cwdFlat, slug: 'no-reference', reference: 'reproduced', metrics: [{ name: 'AUROC', value: 0.6, path: 'f.json', format: 'json', key: 'auroc' }] })
    const firstRun = await runAnalysis({ cwd: cwdFlat, slug: 'no-reference', command: ['python3', 'analysis/run.py'], notebookEntry: null })
    assert.equal((await verifyAnalysisScores({ cwd: cwdFlat, slug: 'no-reference', run_id: firstRun.run_id })).check.reproduction, true)
    const noReferenceRollup = rollupOf(flatIndex, { cwd: cwdFlat, manuscript: 'paper.md' })
    const noReferenceRow = noReferenceRollup.cycles[0].baseline_gate.rows.find((row) => row.slug === 'no-reference')
    assert.equal(noReferenceRow.state, 'not_checked')
    assert.match(noReferenceRow.reason, /no reference run was recorded/)

    // The workspace branch must not reuse the cycle wording: nothing is linked
    // here because there is no cycle.
    const bare = makeWorkspace('ah-provenance-rollup-bare-')
    try {
      const cwdBare = bare.cwd
      mkdirSync(join(cwdBare, 'analysis'), { recursive: true })
      writeFileSync(join(cwdBare, 'analysis', 'run.py'), 'import json\nwith open("b.json", "w") as fh:\n    json.dump({"auroc": 0.5}, fh)\n')
      await freezeAnalysisPlan({ cwd: cwdBare, slug: 'ungated', plan: { question: 'Ungated?', outputs: ['b.json'] } })
      await runAnalysis({ cwd: cwdBare, slug: 'ungated', command: ['python3', 'analysis/run.py'], notebookEntry: null })
      const bareIndex = await buildProvenanceIndex({ cwd: cwdBare, slug: 'rollup-bare', selection: { ah: false } })
      const bareRollup = rollupOf(bareIndex, { cwd: cwdBare, limit: 20 })
      assert.equal(bareRollup.cycles[0].baseline_gate.state, 'not_checked')
      assert.match(bareRollup.cycles[0].baseline_gate.note, /in this workspace, but none declares/,
        `workspace wording, not cycle wording: ${bareRollup.cycles[0].baseline_gate.note}`)

      console.log('provenance rollup OK')
    } finally {
      bare.cleanup()
    }
  } finally {
    flat.cleanup()
  }
} finally {
  workspace.cleanup()
}
