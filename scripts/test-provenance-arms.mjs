/**
 * Phase 8: the provenance arms roll-up and the three new unsupported states
 * (no_attribution, rerun_mismatch, verdict_missing) over real Phase 4–8 ledgers.
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'
import {
  complianceAnalysisRun, expectAnalysisScores, freezeAnalysisPlan, runAnalysis, verifyAnalysisScores,
} from '../analysis-store.js'
import { logExperimentRun, startExperiment, verdictExperiment } from '../experiment-store.js'
import { planAblation, recordAblation, startAblation, verdictAblation } from '../ablation-store.js'
import { armsOf, buildProvenanceIndex, unsupportedOf } from '../provenance-store.js'
import { runProvenanceAction } from '../provenance-audit.js'
import { hashFile } from '../ledger-kit.js'

const workspace = makeWorkspace('ah-provenance-arms-')
const cwd = workspace.cwd
const exec = fakeExec(cwd)

try {
  // Two analyses: one reproduces, one does not.
  workspace.write('analysis/clean.py', 'import json\nwith open("clean.json", "w") as fh:\n    json.dump({"score": 0.8}, fh)\n')
  workspace.write('analysis/repro.py', 'import json\nwith open("repro.json", "w") as fh:\n    json.dump({"score": 0.7}, fh)\n')
  await freezeAnalysisPlan({ cwd, slug: 'clean', plan: {
    question: 'Does clean reproduce?', outputs: ['clean.json'],
    task_rules: [{ id: 'score', statement: 'score is 0.8', check: { path: 'clean.json', format: 'json', key: 'score', op: 'equals', value: 0.8 } }],
  } })
  const cleanRun = await runAnalysis({ cwd, slug: 'clean', command: ['python3', 'analysis/clean.py'], notebookEntry: null })
  assert.equal(cleanRun.exit_code, 0)
  await expectAnalysisScores({ cwd, slug: 'clean', metrics: [{ name: 'score', value: 0.8, path: 'clean.json', format: 'json', key: 'score' }] })
  assert.equal((await verifyAnalysisScores({ cwd, slug: 'clean' })).check.reproduction, true)
  await complianceAnalysisRun({ cwd, slug: 'clean' })

  await freezeAnalysisPlan({ cwd, slug: 'repro', plan: { question: 'Does repro reproduce?', outputs: ['repro.json'] } })
  const reproRun = await runAnalysis({ cwd, slug: 'repro', command: ['python3', 'analysis/repro.py'], notebookEntry: null })
  assert.equal(reproRun.exit_code, 0)
  await expectAnalysisScores({ cwd, slug: 'repro', metrics: [{ name: 'score', value: 0.9, path: 'repro.json', format: 'json', key: 'score' }] })
  assert.equal((await verifyAnalysisScores({ cwd, slug: 'repro' })).check.reproduction, false)

  // A staged experiment with runs but no verdict.
  const protocol = { eval_script: 'analysis/clean.py', metric_params: {} }
  await startExperiment({ cwd, slug: 'exp', experiment: {
    question: 'Which arm is better?', metrics: [{ name: 'acc', direction: 'higher' }],
    benchmark: { datasets: ['d'], splits: ['test'], baseline_arm: 'base', task_rules: ['no leakage'] }, protocol,
  } })
  await logExperimentRun({ cwd, slug: 'exp', metrics: { acc: 0.8 }, role: 'baseline', baselineRef: 'reproduced', stage: 'full', sampling: { rule: 'all' }, protocol })
  await logExperimentRun({ cwd, slug: 'exp', metrics: { acc: 0.9 }, role: 'variant', baselineRef: 'reproduced', stage: 'full', sampling: { rule: 'all' }, baselineRunId: 'x0001', protocol })

  // Two ablations: one without a verdict, one explicitly unattributed.
  await startExperiment({ cwd, slug: 'runs', experiment: { question: 'runs', metrics: [{ name: 'acc', direction: 'higher' }] } })
  await logExperimentRun({ cwd, slug: 'runs', metrics: { acc: 0.8 } })
  await logExperimentRun({ cwd, slug: 'runs', metrics: { acc: 0.9 } })
  for (const slug of ['ab1', 'ab2']) {
    await startAblation({ cwd, slug, ideaId: `idea-${slug}`, method: { name: 'm' }, question: 'Does the component help?' })
    await planAblation({ cwd, slug, plan: {
      datasets: ['d'], metrics: [{ name: 'acc', direction: 'higher' }], replicates: 1,
      arms: [{ id: 'full' }, { id: 'no-x', component: 'x', code_path: 'src/x.py', expected: [{ metric: 'acc', change: 'decrease' }] }],
    } })
    await recordAblation({ cwd, slug, arm: 'full', dataset: 'd', experimentSlug: 'runs', experimentRunId: 'x0001' })
    await recordAblation({ cwd, slug, arm: 'no-x', dataset: 'd', experimentSlug: 'runs', experimentRunId: 'x0002' })
  }
  await verdictAblation({ cwd, slug: 'ab2', verdict: 'unattributed', reason: 'gain survives removal' })

  // A deep review with one verified and one flagged citation, and a validity flag.
  workspace.write('paper.md', '# Paper\n')
  mkdirSync(join(cwd, '.dsh', 'deep-review', 'paper'), { recursive: true })
  workspace.write('.dsh/deep-review/paper/meta.json', JSON.stringify({ input: { path: 'paper.md' } }))
  workspace.write('.dsh/deep-review/paper/citations.json', JSON.stringify([
    { finalVerdict: 'OK', rawReference: 'A' },
    { finalVerdict: 'HALLUCINATED', rawReference: 'B', refNum: 2 },
  ]))
  workspace.write('.dsh/deep-review/paper/extra_checks.json', JSON.stringify({ checks: [
    { id: 'attribution', label: 'Attribution', state: 'flagged', reason: 'no removal arm' },
    { id: 'benchmark_coverage', label: 'Coverage', state: 'clear' },
  ] }))

  // A code-bound AH claim for the method–code column.
  workspace.write('code/model.py', 'THRESHOLD = 0.05\n')
  const modelHash = `sha256:${hashFile(join(cwd, 'code', 'model.py'))}`
  workspace.write('ah.yaml', 'claims_dir: claims\n')
  workspace.write('claims/intro.yaml', [
    'unit: introduction',
    'claims:',
    '  - id: c1',
    '    clause: We use a threshold of 0.05.',
    '    kind: method',
    '    status: bound',
    '    bindings:',
    '      - type: passage',
    '        file: code/model.py',
    '        start: 1',
    '        end: 1',
    `        raw_sha256: ${modelHash}`,
    '        quote: THRESHOLD = 0.05',
    '',
  ].join('\n'))

  const before = {
    plan: readFileSync(join(cwd, '.dsh', 'analysis', 'clean', 'plan.jsonl'), 'utf8'),
    runs: readFileSync(join(cwd, '.dsh', 'experiments', 'exp', 'runs.jsonl'), 'utf8'),
  }
  const index = await buildProvenanceIndex({ cwd, slug: 'phase8', selection: {} })
  const unsupported = unsupportedOf(index)
  assert.equal(unsupported.by_state.rerun_mismatch, 1)
  assert.equal(unsupported.by_state.no_attribution, 1)
  assert.equal(unsupported.by_state.verdict_missing, 2, 'one staged experiment and one ablation lack a verdict')

  const arms = armsOf(index)
  assert.equal(arms.rows.length, 8)
  assert.deepEqual(arms.unsupported, { no_attribution: 1, rerun_mismatch: 1, verdict_missing: 2 })
  const row = (artifact) => arms.rows.find((entry) => entry.artifact === artifact)
  assert.equal(row('analysis:clean').cells.reported_vs_recomputed.state, 'matched')
  assert.equal(row('analysis:clean').readiness, 'ready')
  assert.equal(row('analysis:repro').cells.reported_vs_recomputed.state, 'mismatch')
  assert.equal(row('analysis:repro').readiness, 'not_ready')
  assert.equal(row('experiment:exp').cells.protocol_digest.state, 'verified')
  assert.equal(row('experiment:exp').readiness, 'partial', 'a staged experiment without a verdict is not ready')
  assert.equal(row('ablation:ab1').readiness, 'not_ready')
  assert.equal(row('ablation:ab2').readiness, 'not_ready')
  assert.match(row('ablation:ab2').notes, /no_attribution/)
  assert.equal(row('deep_review:paper').cells.references.state, 'flagged')
  assert.match(row('deep_review:paper').notes, /validity flag/)
  assert.equal(row('ah:project').cells.method_code.state, 'verified')
  assert.equal(row('ah:project').readiness, 'ready')
  assert.equal(arms.totals.not_ready, 4)
  assert.equal(arms.totals.ready, 2)
  assert.equal(arms.totals.partial, 2)
  assert.deepEqual(index.discovered.deep_review, ['paper'])

  // A baseline verdict does not cover the unverdicted variant.
  await verdictExperiment({ cwd, slug: 'exp', runId: 'x0001', verdict: 'good', reason: 'baseline accepted' })
  const reindexed = await buildProvenanceIndex({ cwd, slug: 'phase8', selection: {} })
  assert.equal(unsupportedOf(reindexed).by_state.verdict_missing, 2, 'the variant still lacks a verdict')

  // A code binding whose source is missing is not silently dropped.
  workspace.write('claims/missing.yaml', [
    'unit: methods',
    'claims:',
    '  - id: c-missing',
    '    clause: The missing module implements the gate.',
    '    kind: method',
    '    status: bound',
    '    bindings:',
    '      - type: passage',
    '        file: code/missing.py',
    '        start: 1',
    '        end: 1',
    '        raw_sha256: sha256:deadbeef',
    '        quote: def gate',
    '  - id: c-escape',
    '    clause: An escaping source is not read.',
    '    kind: method',
    '    status: bound',
    '    bindings:',
    '      - type: passage',
    '        file: ../../etc/passwd',
    '        start: 1',
    '        end: 1',
    '        raw_sha256: sha256:deadbeef',
    '        quote: root',
    '',
  ].join('\n'))
  const withMissing = armsOf(await buildProvenanceIndex({ cwd, slug: 'phase8', selection: {} }))
  const ahRow = withMissing.rows.find((entry) => entry.artifact === 'ah:project')
  assert.equal(ahRow.cells.method_code.state, 'missing')
  assert.equal(ahRow.readiness, 'not_ready')
  const escaped = (await buildProvenanceIndex({ cwd, slug: 'phase8', selection: {} })).nodes
    .find((node) => node.type === 'manuscript_claim' && node.id.endsWith('c-escape'))
  assert.equal(escaped.state, 'not_found')
  assert.match(escaped.reason, /escapes the workspace/)

  // arms is a reading over the ledgers, never a write.
  const result = await runProvenanceAction({ action: 'arms', audit: 'phase8' }, exec)
  assert.equal(result.action, 'arms')
  assert.equal(result.arms.totals.rows, 8)
  assert.equal(readFileSync(join(cwd, '.dsh', 'analysis', 'clean', 'plan.jsonl'), 'utf8'), before.plan)
  assert.equal(readFileSync(join(cwd, '.dsh', 'experiments', 'exp', 'runs.jsonl'), 'utf8'), before.runs)

  console.log('provenance arms OK')
} finally {
  workspace.cleanup()
}
