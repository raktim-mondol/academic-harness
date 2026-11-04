// Offline tests for the rebuttal tool surface: wiring pins (package exports,
// preset row + cordis patch, settings key, CONFIGURATION, the deliberate
// no-UI-row decision), every action end-to-end through tool.execute +
// render, the schema-reject vs business-{error} split, the REBUTTAL_MAX_TASKS
// cap through process.env (including the parallel-plan crossed-cap case),
// and offline-seeded foreign ledgers. No network, no experiments executed.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'
import { appendJsonl } from '../ledger-kit.js'
import { logExperimentRun, startExperiment } from '../experiment-store.js'
import { apply, name as moduleExportName, inject } from '../rebuttal.js'
import { readJsonl } from '../ledger-kit.js'

const root = new URL('..', import.meta.url).pathname

/* ------------------------------------------------------------- wiring pins */

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.equal(pkg.exports['./rebuttal'], './rebuttal.js', 'the preset row academic-harness/rebuttal needs this export')
assert.equal(pkg.exports['./rebuttal-store'], './rebuttal-store.js')
assert.ok(pkg.files.includes('rebuttal.js') && pkg.files.includes('rebuttal-store.js'), 'package files must ship both modules')
assert.equal(pkg.scripts['test:rebuttal'], 'node scripts/test-rebuttal-store.mjs && node scripts/test-rebuttal-tool.mjs')

const preset = readFileSync(join(root, 'presets', 'academic-harness', 'agent.cordis.yml'), 'utf8')
assert.match(preset, /- id: rebuttal\n {2}name: academic-harness\/rebuttal/, 'preset row missing rebuttal')
assert.match(preset, /Reviewer-response coverage ledger \(Phase 7\)/, 'preset must carry the Phase 7 comment block')
assert.match(preset, /only ah_check blocks/, 'the preset comment must state that nothing here gates a turn')
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
assert.match(patch, /- id: rebuttal\n {12}name: academic-harness\/rebuttal/, 'cordis.patch.yml was not regenerated for rebuttal')

const settings = readFileSync(join(root, 'settings-keys.js'), 'utf8')
assert.ok(settings.includes("'REBUTTAL_MAX_TASKS'"), 'settings-keys.js missing REBUTTAL_MAX_TASKS')
const configuration = readFileSync(join(root, 'docs', 'CONFIGURATION.md'), 'utf8')
assert.ok(configuration.includes('REBUTTAL_MAX_TASKS'), 'docs/CONFIGURATION.md missing REBUTTAL_MAX_TASKS')
// the deliberate decision: env/Config-editable like CO_SCIENTIST_LIMITATION_ROUNDS, no Settings UI row
const apiKeys = readFileSync(join(root, 'client', 'ApiKeysSection.jsx'), 'utf8')
assert.ok(!apiKeys.includes('REBUTTAL_MAX_TASKS'), 'REBUTTAL_MAX_TASKS must NOT have a Settings UI row (it would break the client build gate)')

/* ---------------------------------------------------------- registration */

assert.equal(moduleExportName, 'academic-harness-rebuttal')
assert.deepEqual(inject, ['tools'])

const ws = makeWorkspace('ah-rebuttal-tool-')
const cwd = ws.cwd
const exec = fakeExec(cwd)
let tool
apply({ tools: { register: (registered) => { tool = registered } } })
const run = (args) => tool.execute(args, exec)
const render = (value) => tool.output.render({}, value)[0].text

const ACTIONS = ['import', 'plan', 'link', 'respond', 'decline', 'coverage', 'draft', 'export', 'status']
assert.equal(tool.name, 'rebuttal')
assert.deepEqual(tool.parameters.properties.action.enum, ACTIONS)
assert.deepEqual(tool.parameters.properties.source.enum, ['deep_review', 'ah_review', 'openreview'])
assert.deepEqual(tool.parameters.properties.baseline_ref.enum, ['reproduced', 'reported'], 'baseline_ref has one owner: EXPERIMENT_BASELINE_REFS')
assert.deepEqual(tool.parameters.properties.evidence.enum, ['metric_table', 'additional_baseline', 'ablation', 'statistical_evidence', 'reproducibility_detail', 'text_revision', 'citation_fix', 'no_experiment_expected'])
assert.deepEqual(tool.parameters.properties.format.enum, ['markdown', 'json', 'csv', 'latex'], 'the shared format parameter carries the union')
assert.ok(!('forum_id' in tool.parameters.properties), 'importing must never fetch: no forum_id parameter exists')
assert.ok(tool.description.includes('only `ah_check` blocks'), 'the description must carry the advisory posture')
assert.ok(tool.description.includes('never fetches, never executes'), 'the no-execution posture is in the description')
assert.ok(tool.description.includes('ah_author action=decline'), 'both decline paths are stated, not just the verifiable one')
assert.ok(tool.description.includes('REBUTTAL_MAX_TASKS') && tool.description.includes('N_t'), 'the cap replaces N_t and says so')
assert.deepEqual(tool.presentCall({ slug: 'x', action: 'plan' }), { card: 'generic', title: 'Rebuttal: x (plan)', kind: 'other' })
assert.equal(tool.presentCall({ slug: 'x' }).title, 'Rebuttal: x (status)', 'action defaults to status')

const sha1 = (value) => createHash('sha1').update(value).digest('hex')

try {
  /* -------------------------------------------------- offline foreign seeds */

  // deep_review store (one round, review.json artifact) keyed like deep-review keys it.
  ws.write('paper/main.tex', '% rebuttal harness fixture\n')
  const S1 = sha1('% rebuttal harness fixture\n')
  const K1 = sha1('paper/main.tex').slice(0, 16)
  ws.write(`.dsh/deep-review/${K1}/meta.json`, JSON.stringify({
    schemaVersion: 2,
    key: K1,
    input: { path: 'paper/main.tex', file_name: 'main.tex', sha1: S1, format: 'tex' },
    params: {},
    last_run: { action: 'review', run_id: 'rev-0001' },
    rounds: [{ round: 1, run_id: 'rev-0001', input_sha1: S1, evaluator_kind: 'held_out', evaluator_kind_source: 'declared', rubric_round: null, model: 'model-x' }],
    latest_round: 1,
  }))
  ws.write(`.dsh/deep-review/${K1}/review.json`, JSON.stringify({
    result: {
      anchoredComments: [
        { commentId: 'section-2', severity: 'MAJOR', summary: 'Narrative.' },
        { commentId: 'c-9-aaaa', severity: 'MAJOR', summary: 'Baselines are thin.', bodyMarkdown: 'Only one baseline was run.', location: { pdf: { pageNumber: 2, quoteSelector: { exact: 'we run one baseline' } } } },
      ],
      questionsForAuthors: [{ questionNumber: 1, question: 'Will you add a second baseline?' }],
      claimEvidenceMap: [],
      reproducibilityChecklist: [{ key: 'seeds', label: 'Seeds reported', status: 'NO', evidenceAndSuggestion: 'none' }],
    },
  }))

  await startExperiment({
    cwd, slug: 'bench',
    experiment: {
      question: 'Rebuttal evidence source',
      metrics: [{ name: 'accuracy', direction: 'higher' }],
      benchmark: { datasets: ['D1'], splits: ['test'], baseline_arm: 'full', task_rules: ['report mean'] },
    },
  })
  ws.write('out/metrics.json', '{"accuracy":0.9}\n')
  const { run: expRun } = await logExperimentRun({ cwd, slug: 'bench', params: { arm: 'full' }, metrics: { accuracy: 0.9 }, artifacts: ['out/metrics.json'] })
  appendJsonl(join(cwd, '.dsh', 'analysis', 'ar', 'runs.jsonl'), [{
    run_id: 'a0001', plan_hash: 'sha256:' + 'b'.repeat(64), exit_code: 0,
    outputs: [{ path: 'r.csv', sha256: `sha256:${'a'.repeat(64)}` }], artifacts: ['r.csv'],
  }])
  // manuscript-diff recorded hunks for the respond pin
  const oldSha = `sha256:${sha1('old')}`
  const newSha = `sha256:${sha1('new')}`
  ws.write('.dsh/manuscript-diff/revision-1/changes.json', JSON.stringify({
    slug: 'revision-1', old: 'paper/main.tex', new: 'paper/main_v2.tex',
    old_sha256: oldSha, new_sha256: newSha, created_at: '2026-02-01T00:00:00.000Z',
    changes: [{ id: 'ch-001', kind: 'modify', old_start: 3, new_start: 3, old_lines: 1, new_lines: 1, removed: ['old line'], added: ['new line'], context: [] }],
  }, null, 2))

  const orvReviews = [
    {
      id: 'n1', forum: 'f1', invitation: 'ICLR.cc/2027/Conference/Submission1/-/Official_Review',
      signatures: ['ICLR.cc/2027/Conference/Submission1/Reviewer_Ab12'],
      rating: 6, confidence: 4, summary: 'Good', strengths: 'Clear', weaknesses: 'Thin baselines', questions: 'Add seeds?',
    },
    { id: 'n2', forum: 'f1', invitation: 'ICLR.cc/2027/Conference/Submission1/-/Rebuttal', content: { comment: { value: 'ours' } } },
  ]

  /* ------------------------------------------------------------ status first */

  let result = await run({ action: 'status', slug: 'rt' })
  assert.equal(result.action, 'status')
  assert.equal(result.exists, false)
  assert.equal(result.state, 'empty')
  assert.match(render(result), /run action "import" first/, 'render of the no-ledger branch')

  /* ------------------------------------------------------------------ import */

  result = await run({ action: 'import', slug: 'rt', source: 'openreview', reviews: orvReviews, name: 'Round one', venue: 'ICLR 2027', manuscript: 'paper/main.tex' })
  assert.equal(result.action, 'import')
  assert.equal(result.slug, 'rt')
  assert.equal(result.dir, '.dsh/rebuttal/rt')
  assert.equal(result.imported.total, 3)
  assert.deepEqual(result.envelope.counts, {
    point_total_in_source: 3, imported: 3, skipped_duplicates: 0, drifted_total: 0,
    excluded_section_comments: 0, skipped_rebuttal_notes: 1, skipped_checklist_yes_na: 0,
    non_review_notes: 0, strength_fields_seen: 1, new_round_points_total: 0, truncated_by_source_cap: 0,
  })
  assert.match(render(result), /Imported 3 point\(s\) into rebuttal "rt" from openreview/)
  assert.match(render(result), /Skipped 0 duplicate\(s\), reported 0 drift\(s\)/)
  assert.match(render(result), /Next: plan supplementary task stubs per point/)
  const rtPoints = readJsonl(join(cwd, '.dsh/rebuttal/rt/points.jsonl'))
  const [pWeak, pSummary, pQuestion] = rtPoints

  // re-import is visibly idempotent
  result = await run({ action: 'import', slug: 'rt', source: 'openreview', reviews: orvReviews })
  assert.equal(result.imported.total, 0)
  assert.equal(result.skipped_duplicates.length, 3)
  assert.match(render(result), /Skipped 3 duplicate\(s\)/)
  assert.ok(result.warnings.includes('the rebuttal definition is write-once; name/question/venue/manuscript on this call were not stored'))

  // deep_review import through the tool keeps reviewer identity + evaluator_kind
  result = await run({ action: 'import', slug: 'rt', source: 'deep_review', deep_review_key: K1 })
  assert.equal(result.imported.total, 3, 'weakness + question + checklist-NO; the section pseudo-comment is excluded')
  assert.equal(result.envelope.counts.excluded_section_comments, 1)
  assert.match(render(result), /By kind: question 1, weakness 1, checklist 1/)
  const drPoint = readJsonl(join(cwd, '.dsh/rebuttal/rt/points.jsonl')).find((p) => p.native_id === 'rev-0001:c-9-aaaa')
  assert.equal(drPoint.reviewer.id, 'ai:deep-review:model-x')
  assert.equal(drPoint.evaluator_kind, 'held_out')

  /* -------------------------------------------- schema rejects vs business errors */

  // wire-level enum violations are rejected by defineTool before the plugin catch
  await assert.rejects(() => run({ action: 'nope', slug: 'rt' }), /must be one of/)
  await assert.rejects(() => run({ action: 'import', slug: 'rt', source: 'gitlog', reviews: orvReviews }), /must be one of/)
  await assert.rejects(() => run({ action: 'plan', slug: 'rt', point_id: pWeak.point_id, dataset: 'D1', baseline_ref: 'reused', metric: 'accuracy', evidence: 'metric_table', replicates: 2, replicates_basis: 'pilot' }), /must be one of/)
  await assert.rejects(() => run({ action: 'plan', slug: 'rt', point_id: pWeak.point_id, dataset: 'D1', baseline_ref: 'reproduced', metric: 'accuracy', evidence: 'gold_standard', replicates: 2, replicates_basis: 'pilot' }), /must be one of/)
  await assert.rejects(() => run({ action: 'plan', slug: 'rt', point_id: pWeak.point_id, dataset: 'D1', baseline_ref: 'reproduced', metric: 'accuracy', metric_direction: 'up', evidence: 'metric_table', replicates: 2, replicates_basis: 'pilot' }), /must be one of/)
  await assert.rejects(() => run({ action: 'plan', slug: 'rt', point_id: pWeak.point_id, dataset: 'D1', baseline_ref: 'reproduced', metric: 'accuracy', evidence: 'metric_table', replicates: 2, replicates_basis: 'guess' }), /must be one of/)
  await assert.rejects(() => run({ action: 'draft', slug: 'rt', format: 'pdf' }), /must be one of/, 'format outside the union is a schema reject')

  // per-action format restrictions and business rules come back in band
  result = await run({ action: 'draft', slug: 'rt', format: 'csv' })
  assert.match(result.error, /draft format must be one of markdown, latex \(json and csv are export formats\)/)
  result = await run({ action: 'export', slug: 'rt', format: 'latex' })
  assert.match(result.error, /export format must be one of markdown, json, csv \(latex is a draft format only\)/)
  result = await run({ action: 'import', slug: 'rt', source: 'openreview', reviews: orvReviews, forum_id: 'abc' })
  assert.match(result.error, /rebuttal does not call openreview: run the openreview tool yourself/, 'the tool refuses a forum_id: importing never fetches')
  result = await run({ action: 'import', slug: 'rt', source: 'openreview' })
  assert.match(result.error, /rebuttal import never fetches: pass reviews/)
  result = await run({ action: 'status' })
  assert.match(result.error, /slug is required/)
  assert.match(render(result), /^Error: slug is required$/)
  result = await run({ action: 'plan', slug: 'rt', point_id: 'p9999', dataset: 'D1', baseline_ref: 'reproduced', metric: 'accuracy', evidence: 'metric_table', replicates: 2, replicates_basis: 'pilot' })
  assert.match(result.error, /point "p9999" not found in rebuttal "rt"/)
  result = await run({ action: 'plan', slug: 'nothing', point_id: 'p0001', dataset: 'D1', baseline_ref: 'reproduced', metric: 'accuracy', evidence: 'metric_table', replicates: 2, replicatesBasis: 'pilot' })
  assert.match(result.error, /rebuttal "nothing" not found under \.dsh\/rebuttal\/nothing; run action "import" first/)
  result = await run({ action: 'import', slug: 'rt', source: 'deep_review' })
  assert.match(result.error, /import from deep_review needs deep_review_key/)

  /* -------------------------------------------------------------------- plan */

  result = await run({
    action: 'plan', slug: 'rt', point_id: pWeak.point_id, dataset: 'D1', baseline_ref: 'reproduced',
    metric: 'accuracy', metric_direction: 'higher', evidence: 'metric_table', experiment_slug: 'bench',
    power: { action: 'power', result: { n: 8, n_unrounded: 6.3, power: 0.8 }, inputs: { test: 'paired t', alpha: 0.05 }, effect_source: { source: 'literature' } },
  })
  assert.equal(result.action, 'plan')
  assert.equal(result.task.task_id, 't0001')
  assert.equal(result.task.replicates, 8, 'a supplied power_analysis result supplies the count; the tool never computes N_t')
  assert.equal(result.task.power.basis, 'power_analysis')
  assert.equal(result.task.cap_at_plan, 20)
  assert.deepEqual(result.cap, { max_tasks: 20, source: 'default', tasks_total: 1, remaining: 19 })
  assert.match(render(result), /Planned t0001 for point p0001: D1\/accuracy \(higher\)\/reproduced × 8 \(power_analysis\), evidence metric_table; cap 1\/20 \(REBUTTAL_MAX_TASKS, default\), 19 remaining/)

  // whole-review coverage: the question point gets a stub even though no reviewer called it a weakness
  result = await run({
    action: 'plan', slug: 'rt', point_id: pQuestion.point_id, dataset: 'D9', baseline_ref: 'reported',
    metric: 'accuracy', metric_direction: 'higher', replicates: 3, replicates_basis: 'pilot',
    evidence: 'additional_baseline', experiment_slug: 'bench',
  })
  assert.equal(result.task.task_id, 't0002')
  assert.equal(result.task.validated.dataset_in_benchmark, false, 'benchmark mismatches are recorded, not refused')
  assert.ok(result.task.validated.notes.some((n) => n.includes('dataset "D9" is not in the benchmark spec')))
  assert.match(render(result), /note: dataset "D9" is not in the benchmark spec/)

  // power misuse is refused in band
  result = await run({
    action: 'plan', slug: 'rt', point_id: pQuestion.point_id, dataset: 'D2', baseline_ref: 'reported',
    metric: 'accuracy', metric_direction: 'higher', evidence: 'metric_table',
    power: { error: 'no test selected', code: 'E_TEST' },
  })
  assert.match(result.error, /power_analysis returned an error \("no test selected", code E_TEST\)/)
  result = await run({
    action: 'plan', slug: 'rt', point_id: pQuestion.point_id, dataset: 'D2', baseline_ref: 'reported',
    metric: 'accuracy', metric_direction: 'higher', evidence: 'metric_table', power: { result: { n: 4 } }, replicates: 9,
  })
  assert.match(result.error, /replicates may not exceed the powered n \(4\)/)
  result = await run({
    action: 'plan', slug: 'rt', point_id: pQuestion.point_id, dataset: 'D9', baseline_ref: 'reported',
    metric: 'accuracy', metric_direction: 'higher', evidence: 'additional_baseline', replicates: 3, replicates_basis: 'pilot', experiment_slug: 'bench',
  })
  assert.match(result.error, /already has that stub \(t0002\); link another run or plan a different arm/)

  /* ------------------------------------------------------------------- cap */

  process.env.REBUTTAL_MAX_TASKS = '2'
  try {
    result = await run({
      action: 'plan', slug: 'rt', point_id: pSummary.point_id, dataset: 'D3', baseline_ref: 'reported',
      metric: 'accuracy', metric_direction: 'higher', replicates: 2, replicates_basis: 'budget', evidence: 'metric_table',
    })
    assert.match(result.error, /plan cap reached: rebuttal "rt" keeps at most 2 supplementary task\(s\) \(REBUTTAL_MAX_TASKS, setting\); 2 are already planned — consolidate stubs, answer the remaining points without a supplementary experiment \(action "respond"\), or raise the setting/)

    // parallel-plan crossed-cap concurrency: with one task planned and the
    // cap at 2, two SIMULTANEOUS plans must land exactly one new row. A
    // pre-lock cap check would write two and cross the cap that replaces N_t.
    await run({ action: 'import', slug: 'rtpar', source: 'openreview', reviews: orvReviews })
    const parPoints = readJsonl(join(cwd, '.dsh/rebuttal/rtpar/points.jsonl'))
    await run({
      action: 'plan', slug: 'rtpar', point_id: parPoints[0].point_id, dataset: 'D1', baseline_ref: 'reproduced',
      metric: 'a', evidence: 'metric_table', replicates: 1, replicates_basis: 'budget',
    })
    const raced = await Promise.all([
      run({ action: 'plan', slug: 'rtpar', point_id: parPoints[1].point_id, dataset: 'D2', baseline_ref: 'reproduced', metric: 'b', evidence: 'metric_table', replicates: 1, replicates_basis: 'budget' }),
      run({ action: 'plan', slug: 'rtpar', point_id: parPoints[2].point_id, dataset: 'D3', baseline_ref: 'reproduced', metric: 'c', evidence: 'metric_table', replicates: 1, replicates_basis: 'budget' }),
    ])
    const ok = raced.filter((r) => r.task)
    const capped = raced.filter((r) => r.error && /plan cap reached/.test(r.error))
    assert.equal(ok.length, 1, 'exactly one concurrent plan gets through')
    assert.equal(capped.length, 1, 'the other sees the cap, computed inside the lock')
    assert.equal(readJsonl(join(cwd, '.dsh/rebuttal/rtpar/tasks.jsonl')).length, 2, 'the ledger holds exactly cap rows')
    assert.notEqual(ok[0].task.task_id, 't0001')

    // zero planned, cap 1, two simultaneous: one success, one cap refusal
    await run({ action: 'import', slug: 'rtpar0', source: 'openreview', reviews: orvReviews })
    const zeroPoints = readJsonl(join(cwd, '.dsh/rebuttal/rtpar0/points.jsonl'))
    process.env.REBUTTAL_MAX_TASKS = '1'
    const raced0 = await Promise.all([
      run({ action: 'plan', slug: 'rtpar0', point_id: zeroPoints[0].point_id, dataset: 'D1', baseline_ref: 'reproduced', metric: 'a', evidence: 'metric_table', replicates: 1, replicates_basis: 'budget' }),
      run({ action: 'plan', slug: 'rtpar0', point_id: zeroPoints[1].point_id, dataset: 'D2', baseline_ref: 'reproduced', metric: 'b', evidence: 'metric_table', replicates: 1, replicates_basis: 'budget' }),
    ])
    assert.equal(raced0.filter((r) => r.task).length, 1)
    assert.equal(raced0.filter((r) => r.error && /plan cap reached/.test(r.error)).length, 1)
    assert.equal(readJsonl(join(cwd, '.dsh/rebuttal/rtpar0/tasks.jsonl')).length, 1)

    // an invalid setting falls back to 20 and SAYS SO through warnings
    process.env.REBUTTAL_MAX_TASKS = '1000000'
    result = await run({
      action: 'plan', slug: 'rt', point_id: pSummary.point_id, dataset: 'D3', baseline_ref: 'reported',
      metric: 'accuracy', metric_direction: 'higher', replicates: 2, replicates_basis: 'budget', evidence: 'metric_table',
    })
    assert.equal(result.cap.source, 'invalid_setting')
    assert.equal(result.cap.max_tasks, 20)
    assert.ok(result.warnings.includes('REBUTTAL_MAX_TASKS must be an integer 1..200; using 20'))
    let cov = await run({ action: 'coverage', slug: 'rt' })
    assert.ok(cov.warnings.includes('REBUTTAL_MAX_TASKS must be an integer 1..200; using 20'), 'the fallback is observable through coverage')
    let st = await run({ action: 'status', slug: 'rt' })
    assert.ok(st.warnings.includes('REBUTTAL_MAX_TASKS must be an integer 1..200; using 20'), 'and through status')
    assert.equal(st.tasks.cap.source, 'invalid_setting')
    // respond used to drop the cap warning because its result had no warnings array
    await run({ action: 'import', slug: 'rtcap', source: 'openreview', reviews: [{ id: 'cap1', invitation: 'X/-/Official_Review', weaknesses: 'cap warning point' }] })
    const capPoint = readJsonl(join(cwd, '.dsh/rebuttal/rtcap/points.jsonl'))[0]
    const capRespond = await run({ action: 'respond', slug: 'rtcap', point_id: capPoint.point_id, response: 'A response recorded while the cap setting was invalid.' })
    assert.ok(capRespond.warnings.includes('REBUTTAL_MAX_TASKS must be an integer 1..200; using 20'))
    assert.match(render(capRespond), /warning: REBUTTAL_MAX_TASKS must be an integer 1\.\.200; using 20/)
    delete process.env.REBUTTAL_MAX_TASKS
  } finally {
    delete process.env.REBUTTAL_MAX_TASKS
  }

  /* -------------------------------------------------------------------- link */

  result = await run({ action: 'link', slug: 'rt', task_id: 't0001', experiment_slug: 'bench', experiment_run_id: expRun.run_id })
  assert.equal(result.action, 'link')
  assert.equal(result.link.link_id, 'l0001')
  assert.equal(result.point_id, pWeak.point_id)
  assert.match(result.link.source.digest, /^sha256:[0-9a-f]{64}$/, 'the link pins a stable-stringify SHA-256 of the whole run event')
  assert.match(render(result), /Linked l0001: task → experiment bench\/x0001 \(digest pinned, 1 artifact\(s\)\) for point/)
  result = await run({ action: 'link', slug: 'rt', task_id: 't0001', experiment_slug: 'bench', experiment_run_id: expRun.run_id, reading: { accuracy: 1 } })
  assert.match(result.error, /experiment links take metrics from the linked run; omit reading/)
  result = await run({ action: 'link', slug: 'rt', task_id: 't0001', experiment_slug: 'bench' })
  assert.match(result.error, /link needs experiment_slug \+ experiment_run_id/)
  result = await run({ action: 'link', slug: 'rt', task_id: 't0001', analysis_slug: 'ar', analysis_run_id: 'a0001', experiment_slug: 'bench', experiment_run_id: 'x0001' })
  assert.match(result.error, /link one source: experiment_log or analysis_run, not both/)
  result = await run({ action: 'link', slug: 'rt', task_id: 't0002', analysis_slug: 'ar', analysis_run_id: 'a0001' })
  assert.match(result.error, /reading is required for an analysis_run link; the run carries no metrics/)
  result = await run({ action: 'link', slug: 'rt', task_id: 't0002', analysis_slug: 'ar', analysis_run_id: 'a9999', reading: { accuracy: 1 } })
  assert.match(result.error, /analysis run "a9999" not found in analysis "ar"/)
  result = await run({ action: 'link', slug: 'rt', task_id: 't0002', experiment_slug: 'bench', experiment_run_id: 'x9999' })
  assert.match(result.error, /experiment run "x9999" not found in experiment "bench"/)
  result = await run({ action: 'link', slug: 'rt', task_id: 't0002', analysis_slug: 'ar', analysis_run_id: 'a0001', reading: { accuracy: 0.42 } })
  assert.equal(result.link.link_id, 'l0002')
  assert.match(render(result), /Linked l0002: task → analysis ar\/a0001/)
  result = await run({ action: 'link', slug: 'rt', task_id: 't0001', experiment_slug: 'bench', experiment_run_id: expRun.run_id })
  assert.match(result.error, /task t0001 is already linked to experiment bench\/x0001 \(l0001\); a rerun is a new run id — link that one instead/)
  // concurrent link appends never reuse an id
  const parallelLinks = await Promise.all([
    run({ action: 'link', slug: 'rt', task_id: 't0001', experiment_slug: 'bench', experiment_run_id: 'x0001', note: 'race a' }),
    run({ action: 'link', slug: 'rt', task_id: 't0002', experiment_slug: 'bench', experiment_run_id: 'x0001', note: 'race b' }),
  ])
  assert.deepEqual(parallelLinks.map((r) => r.link && r.link.link_id).filter(Boolean).sort(), ['l0003'], 'the duplicate-vs-task rule keeps race a refused; race b appends one new id')

  /* ---------------------------------------------------------------- respond */

  result = await run({ action: 'respond', slug: 'rt', point_id: pWeak.point_id, response: 'We added a reproduced second baseline (l0001, l0002).' })
  assert.equal(result.action, 'respond')
  assert.equal(result.answer.answer_id, 'a0001')
  assert.equal(result.answer.evidence, 'none_cited', 'a bare answer is recorded honestly as none_cited')
  assert.match(render(result), /Recorded a0001 for point .* \(revision 1, evidence none_cited\)/)
  result = await run({ action: 'respond', slug: 'rt', point_id: pWeak.point_id, response: ' ' })
  assert.match(result.error, /response is required \(this tool never writes reviewer prose\)/)
  result = await run({ action: 'respond', slug: 'rt', point_id: pWeak.point_id, response: 'x', link_ids: ['l9999'] })
  assert.match(result.error, /link "l9999" not found in rebuttal "rt"/)
  result = await run({ action: 'respond', slug: 'rt', point_id: pQuestion.point_id, response: 'x', link_ids: ['l0001'] })
  assert.match(result.error, new RegExp(`link "l0001" belongs to point "${pWeak.point_id}", not "${pQuestion.point_id}"`))
  result = await run({ action: 'respond', slug: 'rt', point_id: pQuestion.point_id, response: 'We add three seeds per run.', change_ids: ['ch-001'] })
  assert.match(result.error, /change_ids need change_slug/)
  // the raw cased/spaced form resolves through manuscript-diff's own sanitizer
  result = await run({ action: 'respond', slug: 'rt', point_id: pQuestion.point_id, response: 'We add three seeds per run (hunk ch-001).', change_slug: 'Revision 1', change_ids: ['ch-001'] })
  assert.equal(result.answer.change_pin.slug, 'revision-1')
  assert.equal(result.answer.revision, 1)
  assert.equal(result.answer.evidence, 'recorded_hunks')
  assert.match(render(result), /Recorded a0002 for point p0003 \(revision 1, evidence recorded_hunks\)/)
  result = await run({ action: 'respond', slug: 'rt', point_id: pQuestion.point_id, response: 'We add three seeds per run (hunk ch-001).' })
  assert.match(result.error, /already has this answer \(a0002\); append a revision with different text/)
  result = await run({ action: 'respond', slug: 'rt', point_id: pQuestion.point_id, response: 'Three seeds, now in Appendix C, citing l0002 and the recorded hunk.', link_ids: ['l0002'], change_slug: 'revision-1', change_ids: ['ch-001'] })
  assert.equal(result.answer.revision, 2)
  assert.equal(result.answer.supersedes, 'a0002')
  assert.equal(result.answer.evidence, 'both')

  /* ---------------------------------------------------------------- decline */

  result = await run({ action: 'decline', slug: 'rt', point_id: pSummary.point_id, reason: 'Scope of the venue format page limit.' })
  assert.match(result.error, /decline needs declined_by/)
  result = await run({ action: 'decline', slug: 'rt', point_id: pSummary.point_id, reason: 'Page limit; declined by the author.', declined_by: 'the author' })
  assert.equal(result.action, 'decline')
  assert.equal(result.decline.verified, false)
  assert.match(render(result), /author-recorded decline \(not verified against the engine ledger\)/)
  // an ah-sourced decline is verified against the engine, never invented
  result = await run({ action: 'decline', slug: 'rt', point_id: pSummary.point_id, reason: 'x', ah_item: 'R1.1' })
  assert.match(result.error, /decline names ah item "R1\.1" but point .* was imported from openreview/)

  /* --------------------------------------------------------------- coverage */

  result = await run({ action: 'coverage', slug: 'rt' })
  assert.equal(result.action, 'coverage')
  assert.match(result.outcome_note, /does not reduce coverage\. Advisory only; nothing here gates a turn — only ah_check blocks\./)
  assert.equal(result.totals.answered + result.totals.answered_asserted + result.totals.declined_verified + result.totals.declined_recorded + result.totals.unaddressed, result.totals.points)
  assert.equal(result.totals.declined_recorded, 1)
  assert.equal(result.totals.answered, 1, 'the revision citing l0002 and a resolving hunk is answered')
  assert.equal(result.totals.answered_asserted, 1, 'the bare first answer on pWeak is argument-only')
  assert.ok(result.warnings.some((w) => w.includes("is declined on the author's recorded word only")))
  assert.match(render(result), /answered 1, answered_asserted 1, declined_verified 0, declined_recorded 1, unaddressed 3/)
  assert.match(render(result), /only ah_check blocks/)

  // closing the loop through the tool: comparing the round we just imported
  // (identical bytes) forbids a closed reading
  result = await run({ action: 'coverage', slug: 'rt', deep_review_key: K1 })
  assert.equal(result.closing.compared_round.run_id, 'rev-0001')
  assert.equal(result.closing.closed_total, 0, 'identical bytes ⇒ no row may read closed')
  assert.equal(result.closing.variance_only_total, 0, 'every point pairs when the compared round is the imported round')
  assert.equal(result.rows.find((r) => r.source === 'deep_review' && r.kind === 'checklist').closed.state, 'still_present', 'the checklist item pairs by its stable key')
  assert.equal(result.rows.find((r) => r.source === 'deep_review' && r.kind === 'weakness').closed.state, 'still_present')
  assert.match(result.closing.note, /no row may read closed/)

  /* ------------------------------------------------------------------ draft */

  result = await run({ action: 'draft', slug: 'rt' })
  assert.equal(result.action, 'draft')
  assert.equal(result.written, null, 'nothing is written without out')
  assert.match(result.letter, /\[Author response required — this tool does not write it\.\]/)
  assert.match(result.letter, /\*\*Declined by the author\*\* \(not verified against the engine ledger\)/)
  assert.match(result.letter, /- l0002: analysis ar\/a0001 \(digest verified\)/)
  assert.ok(!result.letter.includes('- l0001'), 'only answer-cited links are printed')
  assert.deepEqual(result.change_slugs, ['revision-1'])
  assert.ok(Array.isArray(result.manuscript_diff_items))
  assert.equal(result.manuscript_diff_items.find((i) => i.id === pQuestion.point_id).status, 'addressed')
  assert.ok(result.ah_handoff.every((h) => h.tool === 'ah_review_respond'))
  assert.match(render(result), /Draft response letter \(markdown\)/)
  assert.match(render(result), /returned; nothing written without out/)
  result = await run({ action: 'draft', slug: 'rt', out: 'letters/letter.md' })
  assert.equal(result.written.path, 'letters/letter.md')
  assert.match(render(result), /wrote letters\/letter\.md/)
  result = await run({ action: 'draft', slug: 'rt', out: 'letters/letter.md' })
  assert.match(result.error, /letters\/letter\.md already exists; pass overwrite: true to replace it/)
  result = await run({ action: 'draft', slug: 'rt', out: 'letters/letter.tex', format: 'latex', overwrite: true })
  assert.match(result.letter, /\\section\*{Response to reviewers: Round one\}/)

  /* ----------------------------------------------------------------- export */

  result = await run({ action: 'export', slug: 'rt', format: 'markdown' })
  assert.equal(result.action, 'export')
  assert.equal(result.path, '.dsh/rebuttal/rt/exports/report.md')
  assert.ok(result.bytes > 0)
  assert.match(render(result), /Wrote \.dsh\/rebuttal\/rt\/exports\/report\.md \(\d+ bytes, markdown\)/)
  assert.match(readFileSync(join(cwd, result.path), 'utf8'), /only ah_check blocks/, 'the advisory wording is in the exported report')
  result = await run({ action: 'export', slug: 'rt', format: 'markdown' })
  assert.match(result.error, /report\.md already exists; pass overwrite: true to replace it/)
  result = await run({ action: 'export', slug: 'rt', format: 'json', overwrite: true })
  assert.equal(result.path, '.dsh/rebuttal/rt/exports/rebuttal.json')
  const exported = JSON.parse(readFileSync(join(cwd, result.path), 'utf8'))
  assert.deepEqual(Object.keys(exported).sort(), ['answers', 'coverage', 'declines', 'definition', 'imports', 'links', 'points', 'tasks'])
  result = await run({ action: 'export', slug: 'rt', format: 'csv' })
  assert.equal(result.path, '.dsh/rebuttal/rt/exports/coverage.csv')
  assert.equal(readFileSync(join(cwd, result.path), 'utf8').split('\n')[0], 'point_id,source,kind,severity,source_label,reviewer,evaluator_kind,evaluator_kind_source,status,tasks,links,answers,declined_by,change_ids,closed_state,matched_by,note')

  /* ----------------------------------------------------------------- status */

  result = await run({ action: 'status', slug: 'rt' })
  assert.equal(result.state, 'draftable')
  assert.equal(result.tasks.total, 3, 'including the one that escaped the invalid-setting fallback to 20')
  assert.deepEqual(result.tasks.cap, { max_tasks: 20, source: 'default' })
  assert.equal(result.links.total, 3)
  assert.equal(result.declines.recorded, 1)
  assert.ok(result.sources.openreview.forum_ids.includes('f1'))
  assert.equal(result.sources.deep_review.key, K1)
  assert.equal(result.sources.deep_review.manuscript_sha1_match, true, 'the definition pointer hashes to the imported round')
  assert.match(render(result), /state draftable/)
  assert.match(render(result), /Tasks 3\/20 cap \(REBUTTAL_MAX_TASKS, default\)/)
  assert.match(render(result), /only ah_check blocks/)

  /* ------------------------------------------------------------ render all */

  assert.match(render(await run({ action: 'status', slug: 'brand-new' })), /run action "import" first/)
  assert.match(render({ error: 'boom' }), /^Error: boom$/)
  assert.match(render(await run({ action: 'coverage', slug: 'rt', limit: 1 })), /point\(s\) — answered/)

  console.log('rebuttal tool OK')
} finally {
  delete process.env.REBUTTAL_MAX_TASKS
  ws.cleanup()
}
