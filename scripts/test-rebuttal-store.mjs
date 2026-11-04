// Offline tests for the rebuttal coverage ledger store: the three source
// readers, import dedupe/drift, the capped plan, digest-pinned links,
// respond/decline rules, coverage math, closing pairing, draft/export
// renderers, and status. Foreign ledgers (deep_review, ah reviews,
// experiment_log, analysis_run, manuscript-diff) are seeded directly —
// nothing here touches the network, runs an experiment, or edits a manuscript.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorkspace } from './helpers/test-workspace.mjs'
import { appendJsonl, hashFile, readJsonl } from '../ledger-kit.js'
import { logExperimentRun, startExperiment, verdictExperiment } from '../experiment-store.js'
import {
  REBUTTAL_SOURCES, REBUTTAL_POINT_KINDS, REBUTTAL_EXPECTED_EVIDENCE, REBUTTAL_REPLICATES_BASIS,
  REBUTTAL_COVERAGE_STATES, REBUTTAL_EXPORT_FORMATS, REBUTTAL_LETTER_FORMATS,
  REBUTTAL_DEFAULT_MAX_TASKS, EXPERIMENT_BASELINE_REFS,
  rebuttalSlug, files, sourceDigest, readRebuttal,
  listRebuttalPoints, listRebuttalTasks, listRebuttalLinks, listRebuttalAnswers,
  listRebuttalDeclines, listRebuttalImports,
  readDeepReviewRound, readAhReview, importRebuttalPoints, planRebuttalTask,
  linkRebuttalTask, recordRebuttalAnswer, recordRebuttalDecline, rebuttalCoverage,
  draftRebuttalLetter, exportRebuttal, statusRebuttal,
} from '../rebuttal-store.js'

const ws = makeWorkspace('ah-rebuttal-store-')
const cwd = ws.cwd
const aw = makeWorkspace('ah-rebuttal-store-noah-')
const sha1 = (value) => createHash('sha1').update(value).digest('hex')

try {
  /* ------------------------------------------------------------ vocabularies */

  assert.deepEqual(REBUTTAL_SOURCES, ['deep_review', 'ah_review', 'openreview'])
  assert.deepEqual(REBUTTAL_POINT_KINDS, ['question', 'weakness', 'comment', 'checklist', 'claim'])
  assert.deepEqual(REBUTTAL_EXPECTED_EVIDENCE, ['metric_table', 'additional_baseline', 'ablation',
    'statistical_evidence', 'reproducibility_detail', 'text_revision', 'citation_fix', 'no_experiment_expected'])
  assert.deepEqual(REBUTTAL_REPLICATES_BASIS, ['power_analysis', 'pilot', 'literature', 'budget', 'venue_requirement', 'author_judgement'])
  assert.deepEqual(REBUTTAL_COVERAGE_STATES, ['answered', 'answered_asserted', 'declined_verified', 'declined_recorded', 'unaddressed'])
  assert.deepEqual(REBUTTAL_EXPORT_FORMATS, ['markdown', 'json', 'csv'])
  assert.deepEqual(REBUTTAL_LETTER_FORMATS, ['markdown', 'latex'])
  assert.equal(REBUTTAL_DEFAULT_MAX_TASKS, 20)
  assert.deepEqual(EXPERIMENT_BASELINE_REFS, ['reproduced', 'reported'])

  /* ------------------------------------------------------------------- slug */

  assert.equal(rebuttalSlug('  ICLR 2027 Round 1!! '), 'iclr-2027-round-1')
  assert.equal(rebuttalSlug('x'.repeat(120)).length, 80)
  assert.throws(() => rebuttalSlug('---'), /slug must contain at least one letter or digit/)
  assert.throws(() => rebuttalSlug(''), /slug must contain at least one letter or digit/)
  const f1 = files(cwd, 'ICLR 2027')
  assert.equal(f1.dir, join(cwd, '.dsh', 'rebuttal', 'iclr-2027'))
  assert.equal(f1.definition, join(f1.dir, 'rebuttal.json'))
  assert.equal(f1.imports, join(f1.dir, 'imports.jsonl'))
  assert.equal(f1.exports, join(f1.dir, 'exports'))
  assert.throws(() => files(cwd, '##'), /slug must contain at least one letter or digit/)

  assert.throws(() => readRebuttal(cwd, 'never'),
    /rebuttal "never" not found under \.dsh\/rebuttal\/never; run action "import" first/)

  /* --------------------------------------------------- deep_review fixtures */

  // Two-round store keyed the way deep-review keys it: sha1 of the workspace-relative path.
  ws.write('paper/main.tex', '% rebuttal fixture v1\n')
  const S1 = sha1('% rebuttal fixture v1\n')
  const S0 = sha1('% rebuttal fixture v0\n')
  const K1 = sha1('paper/main.tex').slice(0, 16)

  const round1Digest = {
    run_id: 'rev-0001',
    input_sha1: S0,
    counts: { comments: 203, questions: 1, checklist_by_status: { NO: 1, YES: 1 }, claims_by_status: { UNSUPPORTED: 1 } },
    comments: [
      { comment_id: 'section-3', severity: 'MAJOR', summary: 'Section narrative.', keys: [] },
      {
        comment_id: 'c-1-aaaa', severity: 'MAJOR', summary: 'Baseline coverage is thin on D2.',
        location: 'page 3', quote: 'We only evaluated D1.', citation_ref: 4, citation_verdict: 'retracted',
        keys: ['id:c-1-aaaa', 'summary:baseline coverage is thin on d2', 'quote:we only evaluated d1'],
      },
      { comment_id: 'c-1-bbbb', severity: 'MINOR', summary: 'Recurrent style issue.', quote: '', keys: ['id:c-1-bbbb', 'summary:recurrent style issue'] },
    ],
    questions: [{ number: 1, question: 'Will seeds be reported?', keys: ['question:will seeds be reported'] }],
    claims: [{ claim_id: 'cl1', claim: 'Method X is universal', status: 'UNSUPPORTED', evidence_type: 'none', keys: ['claim:method x is universal'] }],
    checklist: [
      { key: 'one', label: 'One run per claim', status: 'NO' },
      { key: 'two', label: 'Seeds pinned', status: 'YES' },
    ],
  }
  const reviewJson = {
    result: {
      anchoredComments: [
        { commentId: 'section-1', severity: 'MAJOR', summary: 'Narrative paragraph.', bodyMarkdown: 'irrelevant narrative' },
        {
          commentId: 'c-2-cccc', severity: 'CRITICAL', summary: 'Baseline coverage is thin on D2.',
          bodyMarkdown: 'The evaluation never leaves D1.', suggestedEdit: 'Add a D2 column.',
          location: { pdf: { pageNumber: 3, quoteSelector: { exact: 'We only evaluated D1.' } } },
          citationReport: { refNum: 4, finalVerdict: 'retracted' },
        },
        {
          commentId: 'c-2-dddd', severity: 'MINOR', summary: 'Different minor point.',
          bodyMarkdown: 'Formatting drifts.', location: { text: { firstLine: 10, lastLine: 12 } },
        },
      ],
      questionsForAuthors: [
        { questionNumber: 1, question: 'How robust is the gain across seeds?', linkedIssueSummary: 'Seed variance.', howResponseChangesEvaluation: 'Raises confidence.' },
        { questionNumber: 2, question: 'Will seeds be reported?' },
        { questionNumber: 3, question: 'Is the compute budget reproducible?' },
      ],
      claimEvidenceMap: [
        { claimId: '1', claim: 'Method X is universal', status: 'OVERCLAIMED', gapAnalysis: 'No cross-domain data.', evidenceType: 'partial' },
        { claimId: '2', claim: 'Everything else holds', status: 'SUPPORTED' },
      ],
      reproducibilityChecklist: [
        { key: 'c1', label: 'Seeds reported', status: 'NO', evidenceAndSuggestion: 'No seed list anywhere.' },
        { key: 'c2', label: 'Splits pinned', status: 'PARTIAL', evidenceAndSuggestion: 'Only the dev split is named.' },
        { key: 'c3', label: 'Code promised', status: 'YES' },
        { key: 'c4', label: 'Data described', status: 'YES' },
        { key: 'c5', label: 'Metrics described', status: 'YES' },
        { key: 'c6', label: 'Compute described', status: 'YES' },
        { key: 'c7', label: 'Baselines described', status: 'YES' },
        { key: 'c8', label: 'Errors reported', status: 'YES' },
        { key: 'c9', label: 'Hyperparameters listed', status: 'YES' },
      ],
    },
  }
  const meta2 = {
    schemaVersion: 2,
    key: K1,
    input: { path: 'paper/main.tex', file_name: 'main.tex', size_bytes: 24, sha1: S1, format: 'tex' },
    params: {},
    last_run: { action: 'review', run_id: 'rev-0002', model: 'm-b' },
    rounds: [
      { round: 1, run_id: 'rev-0001', input_sha1: S0, evaluator_kind: 'in_distribution', evaluator_kind_source: 'declared', rubric_round: 1, model: 'm-a' },
      { round: 2, run_id: 'rev-0002', input_sha1: S1, evaluator_kind: 'held_out', evaluator_kind_source: 'declared', rubric_round: null, model: 'm-b' },
    ],
    latest_round: 2,
  }
  ws.write(`.dsh/deep-review/${K1}/meta.json`, JSON.stringify(meta2, null, 2))
  ws.write(`.dsh/deep-review/${K1}/review.json`, JSON.stringify(reviewJson, null, 2))
  ws.write(`.dsh/deep-review/${K1}/rounds/rev-0001.json`, JSON.stringify(round1Digest, null, 2))
  ws.write(`.dsh/deep-review/${K1}/rounds/rev-0002.json`, JSON.stringify({ ...round1Digest, run_id: 'rev-0002' }, null, 2))

  // A legacy schemaVersion 1 store: no rounds ladder, review.json only.
  const K3 = 'cd'.repeat(8)
  const legacyMetaRaw = JSON.stringify({
    schemaVersion: 1,
    key: K3,
    input: { path: 'paper/legacy.tex', file_name: 'legacy.tex', sha1: S1, format: 'tex' },
    params: {},
    review: { finished_at: '2026-01-01T00:00:00.000Z' },
    last_run: { action: 'review', run_id: 'legacy-0001', model: 'm-legacy' },
    latest_round: null,
  }, null, 2)
  ws.write(`.dsh/deep-review/${K3}/meta.json`, legacyMetaRaw)
  ws.write(`.dsh/deep-review/${K3}/review.json`, JSON.stringify({
    result: {
      anchoredComments: [{ commentId: 'c-l-1', severity: 'MAJOR', summary: 'Legacy finding.', bodyMarkdown: 'Body', location: { pdf: { pageNumber: 1, quoteSelector: { exact: 'quote' } } } }],
      questionsForAuthors: [], claimEvidenceMap: [], reproducibilityChecklist: [],
    },
  }, null, 2))
  // Ambiguous basename fixture: two stores whose input.file_name collides.
  for (const key of ['ab'.repeat(8), 'ef'.repeat(8)]) {
    ws.write(`.dsh/deep-review/${key}/meta.json`, JSON.stringify({
      schemaVersion: 2, key, input: { path: `dir-${key}/dup.tex`, file_name: 'dup.tex', sha1: S0 },
      rounds: [], latest_round: null, last_run: null, params: {},
    }))
  }
  // Single-hit basename match: a legacy store reachable by a fresh basename.
  const KS = '12'.repeat(8)
  ws.write(`.dsh/deep-review/${KS}/meta.json`, JSON.stringify({
    schemaVersion: 1, key: KS, input: { path: 'x/y/solo.tex', file_name: 'solo.tex', sha1: S0 },
    params: {}, review: { finished_at: '2026-01-01T00:00:00.000Z' }, last_run: { action: 'review', run_id: 'legacy-solo' },
  }))
  ws.write(`.dsh/deep-review/${KS}/review.json`, JSON.stringify({
    result: { anchoredComments: [{ commentId: 'c-s-1', severity: 'MINOR', summary: 'Solo finding.' }], questionsForAuthors: [], claimEvidenceMap: [], reproducibilityChecklist: [] },
  }))

  const roundRead = readDeepReviewRound(cwd, K1)
  assert.equal(roundRead.ref.key_resolution, 'exact')
  assert.equal(roundRead.ref.artifact, 'review.json', 'the latest round prefers review.json full arrays over the capped digest')
  assert.equal(roundRead.ref.available_rounds, 2)
  assert.equal(roundRead.ref.legacy_round, null)
  assert.equal(roundRead.counts.point_total_in_source, 3 + 3 + 2 + 9, 'the whole review: full result arrays, not the capped digest')
  assert.equal(roundRead.counts.excluded_section_comments, 1)
  assert.equal(roundRead.counts.skipped_checklist_yes_na, 7)
  assert.equal(roundRead.ref.source_truncated, false)
  assert.equal(roundRead.warnings.length, 0)
  assert.equal(readDeepReviewRound(cwd, K1, 2).ref.artifact, 'review.json')

  const round1Read = readDeepReviewRound(cwd, K1, 1)
  assert.equal(round1Read.ref.artifact, 'rounds/rev-0001.json')
  assert.equal(round1Read.ref.source_truncated, true, 'the digest counts 203 comments but stores 200 after the cap')
  assert.equal(round1Read.counts.truncated_by_source_cap, 200)
  assert.match(round1Read.warnings[0], /the stored round keeps at most 200 comments \/ 60 questions \/ 200 claims; 200 points were never stored — re-run deep_review on the manuscript, or accept the shortfall and say so in the letter/)
  assert.equal(round1Read.ref.evaluator_kind, 'in_distribution')
  assert.equal(round1Read.ref.rubric_round, 1, 'an in-distribution round says which round fed it')
  assert.equal(readDeepReviewRound(cwd, K1, 'rev-0001').ref.round, 1, 'run_id round selection')
  assert.throws(() => readDeepReviewRound(cwd, K1, 9), /no stored round "9" for deep review .*rounds 1–2 exist; pass a round number or run_id/)
  assert.equal(readDeepReviewRound(cwd, 'paper/main.tex').ref.key_resolution, 'path')
  assert.throws(() => readDeepReviewRound(cwd, 'dir-anything/dup.tex'), /is ambiguous .*pass the 16-character store key/)
  assert.equal(readDeepReviewRound(cwd, 'notes/solo.tex').ref.key_resolution, 'basename_match')
  assert.throws(() => readDeepReviewRound(cwd, 'ghost.tex'), /no stored deep review for "ghost\.tex" under \.dsh\/deep-review\/; run deep_review action="review" on the manuscript first, or pass the 16-character store key/)

  const legacyRead = readDeepReviewRound(cwd, K3)
  assert.equal(legacyRead.ref.legacy_round, true)
  assert.equal(legacyRead.ref.artifact, 'review.json')
  assert.equal(legacyRead.ref.evaluator_kind, 'held_out')
  assert.equal(legacyRead.ref.evaluator_kind_source, 'inferred')
  assert.deepEqual(legacyRead.items[0].keys, ['id:legacy-0001:c-l-1', 'summary:legacy finding', 'quote:quote'])
  assert.equal(readFileSync(join(cwd, `.dsh/deep-review/${K3}/meta.json`), 'utf8'), legacyMetaRaw, 'reads never migrate the deep-review store')

  // A corrupt meta throws (readJson semantics) — never reads as "no points".
  const K9 = 'fe'.repeat(8)
  ws.write(`.dsh/deep-review/${K9}/meta.json`, '{oops')
  assert.throws(() => readDeepReviewRound(cwd, K9), /is not valid JSON/)

  /* ------------------------------------------------------ ah_review fixture */

  ws.write('ah.yaml', 'name: fixture\nreviews: "ah-reviews"\n')
  const ahYaml = (r11Status, r11Response) => [
    'source: reviews.txt',
    'snapshot: review-R1-start',
    'manuscript: paper/main.tex',
    'items:',
    '  - id: R1.1',
    '    kind: major',
    '    text: Baselines are thin.',
    `    status: ${r11Status}`,
    '    units: []',
    `    response: '${r11Response}'`,
    '  - id: R1.2',
    '    kind: minor',
    '    text: Typo in section 3.',
    '    status: declined',
    '    units: [u1]',
    "    response: 'Fixed in the revision.'",
    '  - id: R1.3',
    '    kind: major',
    '    text: No ablation of the sampler.',
    '    status: declined',
    '    units: [u2, u3]',
    "    response: ''",
  ].join('\n')
  ws.write('ah-reviews/R1.yaml', ahYaml('open', ''))
  const ahRead = await readAhReview(cwd, 'R1')
  assert.equal(ahRead.ref.rid, 'R1')
  assert.equal(ahRead.ref.file, 'ah-reviews/R1.yaml', 'reviews dir comes from ah.yaml, quotes stripped')
  assert.equal(ahRead.ref.item_total, 3)
  assert.equal(ahRead.ref.snapshot, 'review-R1-start')
  assert.deepEqual(ahRead.items[0].keys, ['id:R1.1', 'summary:baselines are thin'], 'ah points get id+summary tiers, no quote')
  assert.equal(ahRead.items[0].kind, 'weakness')
  assert.equal(ahRead.items[1].kind, 'comment', 'minor maps to comment; the engine has no question kind')
  assert.equal(ahRead.items[0].reviewer.kind, 'unattributed')
  assert.equal(ahRead.items[0].reviewer.identity_source, 'review_not_person')
  assert.equal(ahRead.items[0].source_ref.response_at_import, false)
  assert.equal(ahRead.items[1].source_ref.response_at_import, true)
  assert.equal(ahRead.items[0].evaluator_kind, null)
  assert.equal(ahRead.items[0].evaluator_kind_source, 'not_applicable')
  // Default reviews dir inside a nested project without the key.
  ws.write('proj/ah.yaml', 'name: nested\n')
  ws.write('proj/reviews/R1.yaml', 'source: r.txt\nitems:\n  - id: R1.1\n    kind: minor\n    text: one\n    status: open\n')
  assert.equal((await readAhReview(join(cwd, 'proj'), 'R1')).ref.file, 'reviews/R1.yaml')
  // A corrupt review throws, never reads as zero items.
  ws.write('ah-reviews/R9.yaml', 'items: not-a-list\n')
  await assert.rejects(() => readAhReview(cwd, 'R9'), /is not an ah review file with an items list/)
  await assert.rejects(() => readAhReview(cwd, 'R7'), /no ah review "R7" at ah-reviews\/R7\.yaml/)
  await assert.rejects(
    () => importRebuttalPoints({ cwd: aw.cwd, slug: 'x', source: 'ah_review', ahReview: 'R1' }),
    /ah_review items can only be imported inside an Academic Harness project \(no ah\.yaml above/,
  )
  await assert.rejects(() => readAhReview(cwd, 'R 1'), /must be a plain id/)

  /* ----------------------------------------------------- openreview fixture */

  const orvBatch = [
    {
      id: 'n1', forum: 'f1', invitation: 'ICLR.cc/2027/Conference/Submission1/-/Official_Review',
      signatures: ['ICLR.cc/2027/Conference/Submission1/Reviewer_Ab12'],
      rating: 6, confidence: 4, summary: 'Good paper', strengths: 'Clear writing',
      weaknesses: 'Thin baselines', questions: 'Will seeds be reported?', url: 'https://openreview.net/forum?id=f1&noteId=n1',
    },
    { id: 'n2', forum: 'f1', invitation: 'ICLR.cc/2027/Conference/Submission1/-/Official_Comment', content: { comment: { value: 'thanks' } } },
    { id: 'n3', forum: 'f1', invitation: 'ICLR.cc/2027/Conference/Submission1/-/Rebuttal', content: { comment: { value: 'author rebuttal text' } } },
    { id: 'n4', forum: 'f1', invitation: 'ICLR.cc/2027/Conference/-/Meta_Review', content: { decision: { value: 'Accept (Poster)' } } },
    {
      id: 'n5', forum: 'f1',
      invitations: ['ICLR.cc/2027/Conference/Submission1/-/Official_Review'],
      signatures: { value: ['ICLR.cc/2027/Conference/Submission1/Reviewer_Cd34'] },
      content: {
        rating: { value: 5 },
        summary: { value: 'Solid but narrow' },
        strengths: { value: 'Nice ablation' },
        weaknesses: { value: 'Single dataset' },
      },
    },
  ]

  /* ------------------------------------------------------ manuscript fixture */

  ws.write('paper/main_v2.tex', '% rebuttal fixture v2\n')
  const oldSha = `sha256:${hashFile(join(cwd, 'paper/main.tex'))}`
  const newSha = `sha256:${hashFile(join(cwd, 'paper/main_v2.tex'))}`
  const changesRecord = (slugName, pairNew, ids) => ({
    slug: slugName,
    old: 'paper/main.tex',
    new: 'paper/main_v2.tex',
    old_sha256: oldSha,
    new_sha256: pairNew,
    created_at: '2026-02-01T00:00:00.000Z',
    changes: ids.map((id, index) => ({
      id, kind: 'modify', old_start: 3 + index, new_start: 3 + index, old_lines: 1, new_lines: 1,
      removed: ['old line'], added: ['new line'], context: [],
    })),
  })
  const writeChanges = (slugName, pairNew, ids) =>
    ws.write(`.dsh/manuscript-diff/${slugName}/changes.json`, JSON.stringify(changesRecord(slugName, pairNew, ids), null, 2))
  writeChanges('revision-1', newSha, ['ch-001'])
  writeChanges('revision-2', newSha, ['ch-001'])
  // a record whose own slug field disagrees with its directory is refused
  ws.write('.dsh/manuscript-diff/revision-3/changes.json', JSON.stringify({ ...changesRecord('other', newSha, ['ch-001']), slug: 'other' }, null, 2))

  /* ------------------------------------------------------- experiment fixture */

  await startExperiment({
    cwd, slug: 'bench',
    experiment: {
      question: 'Rebuttal source',
      metrics: [{ name: 'accuracy', direction: 'higher' }, { name: 'latency', direction: 'lower' }],
      benchmark: { datasets: ['D1'], splits: ['test'], baseline_arm: 'full', task_rules: ['report mean'] },
    },
  })
  ws.write('out/metrics.json', '{"accuracy":0.91}\n')
  const { run: expRun } = await logExperimentRun({
    cwd, slug: 'bench', params: { arm: 'full' }, metrics: { accuracy: 0.91, latency: 100 }, artifacts: ['out/metrics.json'],
  })
  // A second run carrying a spec_drift reading (the reviewer asked for exactly
  // an arm the frozen benchmark does not contain) plus a bad verdict.
  const driftRun = {
    run_id: 'x0002', ts: '2026-02-02T00:00:00.000Z', experiment: 'bench', params: { arm: 'extra' },
    metrics: { accuracy: 0.7, latency: 130 }, artifacts: [], seed: null, parent: null, notes: null,
    role: 'variant', baseline_ref: 'reproduced', stage: 'full', sampling: null,
    protocol: null, protocol_digest: null, baseline_run_id: 'x0001',
    spec_drift: { state: 'drift', expected_digest: null, actual_digest: null, changed: ['metric_params'], baseline_run_id: 'x0001' },
    environment: {},
  }
  const benchRuns = join(cwd, '.dsh', 'experiments', 'bench', 'runs.jsonl')
  appendJsonl(benchRuns, [driftRun])
  const benchRunsPristine = readFileSync(benchRuns, 'utf8')
  await verdictExperiment({ cwd, slug: 'bench', runId: 'x0002', verdict: 'bad', reason: 'the extra arm underperforms' })
  await startExperiment({
    cwd, slug: 'plain',
    experiment: { question: 'No benchmark', metrics: [{ name: 'score', direction: null }, { name: 'accuracy', direction: 'higher' }] },
  })
  const { run: plainRun } = await logExperimentRun({ cwd, slug: 'plain', params: { arm: 'a' }, metrics: { accuracy: 0.5, score: 1 } })

  // A hashed analysis run with a failing exit, and one without any hashed evidence.
  appendJsonl(join(cwd, '.dsh', 'analysis', 'ar', 'runs.jsonl'), [
    {
      run_id: 'a0001', ts: '2026-02-02T00:00:00.000Z', plan_hash: `sha256:${'b'.repeat(64)}`, exit_code: 1,
      outputs: [{ path: 'r.csv', sha256: `sha256:${'a'.repeat(64)}` }], artifacts: ['r.csv'],
    },
    {
      run_id: 'a0002', ts: '2026-02-02T00:00:00.000Z', plan_hash: `sha256:${'b'.repeat(64)}`, exit_code: 0,
      outputs: [{ path: 'none.csv', status: 'not_written' }], artifacts: [],
    },
  ])

  /* ====================================================== import: deep_review */

  const OUTCOME_NOTE = 'Coverage counts whether a point was answered with cited evidence, never whether it helped: a linked run with verdict bad or engineer, a spec_drift state, a drifted digest, or a non-zero exit stays recorded and reportable and does not reduce coverage. Advisory only; nothing here gates a turn — only ah_check blocks.'

  // 'rich': the latest round, read from review.json.
  let res = await importRebuttalPoints({
    cwd, slug: 'rich', source: 'deep_review', deepReviewKey: K1,
    name: 'ICLR round 1', question: 'Which points does the revision close?', venue: 'ICLR 2027', manuscript: 'paper/main.tex',
  })
  assert.equal(res.definition.schemaVersion, 1)
  assert.equal(res.definition.slug, 'rich')
  assert.equal(res.definition.name, 'ICLR round 1')
  assert.equal(res.definition.created_by_import, 'i0001')
  assert.equal(res.envelope.import_id, 'i0001')
  assert.equal(res.imported.total, 8)
  assert.deepEqual(res.envelope.counts, {
    point_total_in_source: 17, imported: 8, skipped_duplicates: 0, drifted_total: 0,
    excluded_section_comments: 1, skipped_rebuttal_notes: 0, skipped_checklist_yes_na: 7,
    non_review_notes: 0, strength_fields_seen: 0, new_round_points_total: 0, truncated_by_source_cap: 0,
  })
  assert.deepEqual(Object.keys(res.envelope.ref.deep_review).sort(), [
    'artifact', 'available_rounds', 'dir', 'evaluator_kind', 'evaluator_kind_source', 'input_sha1',
    'key', 'key_resolution', 'legacy_round', 'manuscript', 'model', 'round', 'rubric_round', 'run_id', 'source_truncated',
  ])
  assert.equal(res.envelope.ref.deep_review.key_resolution, 'exact')
  assert.equal(res.envelope.ref.deep_review.manuscript, 'paper/main.tex')
  assert.equal(res.envelope.ref.deep_review.input_sha1, S1)
  assert.match(res.envelope.batch_sha256, /^sha256:[0-9a-f]{64}$/)

  const richDeep = listRebuttalPoints(cwd, 'rich')
  const wp = richDeep.find((p) => p.native_id === 'rev-0002:c-2-cccc')
  const qp = richDeep.find((p) => p.native_id === 'rev-0002:q-3')
  const ddd = richDeep.find((p) => p.native_id === 'rev-0002:c-2-dddd')
  const claim = richDeep.find((p) => p.kind === 'claim')
  assert.equal(wp.point_id, 'p0004')
  assert.equal(wp.kind, 'weakness')
  assert.equal(wp.severity, 'CRITICAL')
  assert.equal(wp.source_label, 'CRITICAL')
  assert.equal(wp.location, 'page 3', 'the structured location flattens the way the wrapper does')
  assert.equal(wp.quote, 'We only evaluated D1.')
  assert.match(wp.detail, /The evaluation never leaves D1\./)
  assert.match(wp.detail, /Suggested edit: Add a D2 column\./)
  assert.equal(wp.source_ref.citation_ref, 4)
  assert.equal(wp.source_ref.citation_verdict, 'retracted')
  assert.equal(wp.reviewer.id, 'ai:deep-review:m-b')
  assert.equal(wp.reviewer.identity_source, 'round_model')
  assert.equal(wp.evaluator_kind, 'held_out')
  assert.equal(wp.evaluator_kind_source, 'declared')
  assert.deepEqual(wp.keys, ['id:rev-0002:c-2-cccc', 'summary:baseline coverage is thin on d2', 'quote:we only evaluated d1'])
  assert.match(wp.payload_sha256, /^sha256:[0-9a-f]{64}$/)
  assert.equal(ddd.kind, 'comment', 'MINOR maps to comment, not weakness')
  assert.equal(ddd.location, 'lines 10-12')
  const q1 = richDeep.find((p) => p.native_id === 'rev-0002:q-1')
  assert.deepEqual(q1.keys, ['question:how robust is the gain across seeds'], 'questions get no id: tier — positional ids would fake cross-round pairs')
  assert.match(q1.detail, /Seed variance\./)
  assert.match(q1.detail, /How a response changes the evaluation: Raises confidence\./)
  assert.equal(qp.detail, null, 'a question with no linked issue stores null, never inferred text')
  assert.equal(claim.native_id, 'rev-0002:claim-1')
  assert.equal(claim.source_label, 'OVERCLAIMED')
  assert.equal(claim.detail, 'No cross-domain data.')
  assert.equal(richDeep.find((p) => p.native_id === 'rev-0002:claim-2'), undefined, 'SUPPORTED claims are not imported')
  assert.equal(richDeep.filter((p) => p.kind === 'checklist').length, 2, 'only NO/PARTIAL checklist items')
  const checkNo = richDeep.find((p) => p.native_id === 'rev-0002:checklist-c1')
  assert.equal(checkNo.detail, 'No seed list anywhere.')
  assert.deepEqual(checkNo.keys, ['id:checklist:c1'], 'checklist items pair by their stable engine key across rounds')
  assert.equal(richDeep.find((p) => p.native_id === 'rev-0002:section-1'), undefined, 'engine section pseudo-comments are excluded from the ledger')

  // clipping
  const longText = 'x'.repeat(3000)
  res = await importRebuttalPoints({ cwd, slug: 'clip', source: 'openreview', reviews: [{ id: 'nq', forum: 'fq', invitation: 'X/-/Official_Review', weaknesses: longText, summary: 'ok' }] })
  const clippedPoint = listRebuttalPoints(cwd, 'clip').find((p) => p.native_id === 'nq#weaknesses')
  assert.equal(clippedPoint.text.length, 2000)
  assert.ok(clippedPoint.text.endsWith('…'))

  // Re-import of the same round is idempotent and says so.
  res = await importRebuttalPoints({ cwd, slug: 'rich', source: 'deep_review', deepReviewKey: K1 })
  assert.equal(res.imported.total, 0)
  assert.equal(res.skipped_duplicates.length, 8)
  assert.equal(res.drifted.length, 0)
  assert.equal(res.definition.created_by_import, 'i0001', 'the write-once definition is returned, not rewritten')
  assert.ok(res.warnings.includes('the rebuttal definition is write-once; name/question/venue/manuscript on this call were not stored'))

  // A second source naming a different manuscript warns but is never refused.
  res = await importRebuttalPoints({ cwd, slug: 'rich', source: 'openreview', reviews: [orvBatch[0]], manuscript: 'paper/other.tex' })
  assert.equal(res.imported.total, 3)
  assert.ok(res.warnings.some((w) => w.includes('imported points name paper/other.tex, but rebuttal "rich" was created for paper/main.tex; coverage totals mix the two')))

  // kinds narrowing + a zero-point import still appends an envelope.
  await assert.rejects(() => importRebuttalPoints({ cwd, slug: 'x', source: 'deep_review', deepReviewKey: K1, kinds: ['nope'] }), /kinds must be a subset of question, weakness, comment, checklist, claim/)
  res = await importRebuttalPoints({ cwd, slug: 'rich', source: 'openreview', reviews: [orvBatch[1]], kinds: ['checklist'] })
  assert.equal(res.imported.total, 0)
  assert.equal(res.envelope.import_id, 'i0004')
  assert.equal(listRebuttalImports(cwd, 'rich').length, 4)

  // per-call point cap.
  const flood = Array.from({ length: 170 }, (_v, i) => ({ id: `f${i}`, forum: 'ff', invitation: 'X/-/Official_Review', weaknesses: `w${i}`, summary: `s${i}`, questions: `q${i}` }))
  await assert.rejects(() => importRebuttalPoints({ cwd, slug: 'flood', source: 'openreview', reviews: flood }), /this import carries 510 points; a single import takes at most 500 — narrow with kinds/)

  // a corrupt source artifact propagates the reader's throw at import — never zero points.
  await assert.rejects(
    () => importRebuttalPoints({ cwd, slug: 'corrupt', source: 'deep_review', deepReviewKey: K9 }),
    /is not valid JSON/,
  )

  /* ============================================ drift / multi-round pairing */

  // 'pair': the round-1 digest first (truncated, persisted keys), then round 2.
  res = await importRebuttalPoints({ cwd, slug: 'pair', source: 'deep_review', deepReviewKey: K1, deepReviewRound: 1 })
  assert.equal(res.imported.total, 5)
  assert.equal(res.envelope.counts.truncated_by_source_cap, 200)
  assert.equal(res.envelope.ref.deep_review.source_truncated, true)
  const pairAaaa = listRebuttalPoints(cwd, 'pair').find((p) => p.native_id === 'rev-0001:c-1-aaaa')
  assert.deepEqual(pairAaaa.keys, ['id:c-1-aaaa', 'summary:baseline coverage is thin on d2', 'quote:we only evaluated d1'], 'persisted digest keys are reused verbatim (the quote tier stays clamped at the digest depth)')
  assert.equal(pairAaaa.evaluator_kind, 'in_distribution', 'evaluator_kind copies the round verbatim, never defaults to held_out')
  assert.equal(pairAaaa.source_ref.rubric_round, 1)
  assert.equal(pairAaaa.kind, 'weakness')
  assert.equal(listRebuttalPoints(cwd, 'pair').find((p) => p.native_id === 'rev-0001:section-3'), undefined)

  // Mutate the stored digest under the SAME comment_id: in-place drift, never an overwrite.
  const mutated = JSON.parse(JSON.stringify(round1Digest))
  mutated.comments[1].summary = 'Baseline coverage is thin on D2 and D3.'
  ws.write(`.dsh/deep-review/${K1}/rounds/rev-0001.json`, JSON.stringify(mutated, null, 2))
  res = await importRebuttalPoints({ cwd, slug: 'pair', source: 'deep_review', deepReviewKey: K1, deepReviewRound: 1 })
  assert.equal(res.imported.total, 0)
  assert.equal(res.drifted.length, 1)
  assert.equal(res.drifted[0].native_id, 'rev-0001:c-1-aaaa')
  assert.equal(res.drifted[0].point_id, pairAaaa.point_id)
  assert.notEqual(res.drifted[0].stored_sha256, res.drifted[0].incoming_sha256)
  assert.equal(res.drifted[0].source_ref.run_id, 'rev-0001')
  assert.equal(res.envelope.counts.drifted_total, 1)
  assert.equal(listRebuttalPoints(cwd, 'pair').find((p) => p.point_id === pairAaaa.point_id).text, 'Baseline coverage is thin on D2.', 'a drift report never rewrites history')

  // A reworded comment arrives with a NEW content-seeded id: a new point, not drift.
  const reworded = JSON.parse(JSON.stringify(mutated))
  reworded.comments.push({ comment_id: 'c-1-eeee', severity: 'MAJOR', summary: 'Completely new wording of the ask.', quote: '', keys: ['id:c-1-eeee', 'summary:completely new wording of the ask'] })
  ws.write(`.dsh/deep-review/${K1}/rounds/rev-0001.json`, JSON.stringify(reworded, null, 2))
  res = await importRebuttalPoints({ cwd, slug: 'pair', source: 'deep_review', deepReviewKey: K1, deepReviewRound: 1 })
  assert.equal(res.imported.total, 1)
  assert.equal(listRebuttalPoints(cwd, 'pair').filter((p) => p.native_id === 'rev-0001:c-1-eeee').length, 1)

  // A later round adds separate rows paired at read time, not dedupe against the first import.
  res = await importRebuttalPoints({ cwd, slug: 'pair', source: 'deep_review', deepReviewKey: K1 })
  assert.equal(res.envelope.counts.new_round_points_total, res.imported.total)
  assert.ok(res.imported.total >= 7)
  assert.equal(res.envelope.note, 'points from a later round are separate rows and are paired at read time by the closing reading, not deduped against the first import')

  /* ========================================================= legacy store */

  res = await importRebuttalPoints({ cwd, slug: 'legacy', source: 'deep_review', deepReviewKey: K3 })
  assert.equal(res.imported.total, 1)
  assert.equal(res.envelope.ref.deep_review.legacy_round, true)
  assert.equal(res.envelope.ref.deep_review.evaluator_kind_source, 'inferred')
  assert.equal(readFileSync(join(cwd, `.dsh/deep-review/${K3}/meta.json`), 'utf8'), legacyMetaRaw, 'importing a legacy round must not bump its schema')
  res = await importRebuttalPoints({ cwd, slug: 'solo', source: 'deep_review', deepReviewKey: 'z/solo.tex' })
  assert.equal(res.envelope.ref.deep_review.key_resolution, 'basename_match')

  /* ============================================================ import: AH */

  res = await importRebuttalPoints({ cwd, slug: 'ah', source: 'ah_review', ahReview: 'R1' })
  assert.equal(res.imported.total, 3)
  assert.equal(res.envelope.ref.ah_review.file, 'ah-reviews/R1.yaml')
  assert.equal(res.envelope.ref.ah_review.item_total, 3)
  assert.deepEqual(Object.keys(res.envelope.ref.ah_review).sort(), ['file', 'item_total', 'manuscript', 'rid', 'root', 'snapshot', 'source_basename'])
  const ahPoints = listRebuttalPoints(cwd, 'ah')
  const ahR11 = ahPoints.find((p) => p.native_id === 'R1.1')
  const ahR12 = ahPoints.find((p) => p.native_id === 'R1.2')
  const ahR13 = ahPoints.find((p) => p.native_id === 'R1.3')
  assert.equal(ahR11.reviewer.kind, 'unattributed')
  assert.equal(ahR11.reviewer.label, 'reviews.txt')
  assert.equal(ahR11.source_ref.status_at_import, 'open')
  assert.equal(ahR11.source_ref.snapshot, 'review-R1-start')
  assert.equal(ahR12.source_ref.status_at_import, 'declined')
  assert.equal(res.imported.by_evaluator_kind.not_applicable, 3)
  await assert.rejects(() => importRebuttalPoints({ cwd, slug: 'ah', source: 'ah_review' }), /import from ah_review needs ah_review \(the review id, e\.g\. R1\)/)
  await assert.rejects(() => importRebuttalPoints({ cwd, slug: 'x', source: 'deep_review' }), /import from deep_review needs deep_review_key \(the store key or the manuscript path\)/)
  await assert.rejects(() => importRebuttalPoints({ cwd, slug: 'x', source: 'nope' }), /source must be one of deep_review, ah_review, openreview/)

  /* ============================================================= import: ORV */

  res = await importRebuttalPoints({ cwd, slug: 'orv', source: 'openreview', reviews: orvBatch, reviewsFetchedAt: '2026-02-02T09:00:00Z' })
  assert.equal(res.imported.total, 5, 'n1 weaknesses/summary/questions + n5 weaknesses/summary')
  assert.deepEqual(res.envelope.counts, {
    point_total_in_source: 5, imported: 5, skipped_duplicates: 0, drifted_total: 0,
    excluded_section_comments: 0, skipped_rebuttal_notes: 1, skipped_checklist_yes_na: 0,
    non_review_notes: 2, strength_fields_seen: 2, new_round_points_total: 0, truncated_by_source_cap: 0,
  })
  assert.deepEqual(Object.keys(res.envelope.ref.openreview).sort(), ['decision', 'fetched_at', 'forum_id', 'input', 'input_sha256', 'note_total', 'reviewers'])
  assert.equal(res.envelope.ref.openreview.forum_id, 'f1', 'the additive forum passthrough populates the envelope')
  assert.equal(res.envelope.ref.openreview.note_total, 5)
  assert.equal(res.envelope.ref.openreview.decision, 'Accept (Poster)', 'the meta-review decision is recorded, never imported as a point')
  assert.equal(res.envelope.ref.openreview.fetched_at, '2026-02-02T09:00:00Z')
  assert.match(res.envelope.ref.openreview.input_sha256, /^sha256:[0-9a-f]{64}$/)
  assert.deepEqual(res.envelope.ref.openreview.reviewers, [
    { id: 'openreview:Reviewer_Ab12', rating: 6, confidence: 4 },
    { id: 'openreview:Reviewer_Cd34', rating: 5, confidence: null },
  ])
  const orvPoints = listRebuttalPoints(cwd, 'orv')
  const orvWeak = orvPoints.find((p) => p.native_id === 'n1#weaknesses')
  assert.equal(orvWeak.kind, 'weakness')
  assert.equal(orvWeak.severity, null, 'openreview carries no severity — never comparable across sources')
  assert.equal(orvWeak.source_label, 'ICLR.cc/2027/Conference/Submission1/-/Official_Review')
  assert.deepEqual(orvWeak.keys, ['id:n1#weaknesses', 'summary:thin baselines'])
  assert.equal(orvWeak.reviewer.kind, 'human')
  assert.equal(orvWeak.reviewer.identity_source, 'signature')
  assert.equal(orvWeak.reviewer.id, 'openreview:Reviewer_Ab12')
  assert.equal(orvWeak.evaluator_kind, null)
  assert.equal(orvWeak.source_ref.note_id, 'n1')
  assert.equal(orvWeak.source_ref.field, 'weaknesses')
  assert.ok(orvPoints.find((p) => p.native_id === 'n1#questions'), 'the additive questions passthrough imports')
  assert.equal(orvPoints.find((p) => p.native_id === 'n5#questions'), undefined, 'a missing questions field is never backfilled')
  assert.ok(!orvPoints.some((p) => p.source_ref?.field === 'strengths'), 'strengths are never imported')
  assert.equal(orvPoints.find((p) => p.native_id === 'n3#comment'), undefined, 'author rebuttal notes are skipped')
  const wrapped = orvPoints.find((p) => p.native_id === 'n5#weaknesses')
  assert.equal(wrapped.reviewer.identity_source, 'signature', 'a wrapped {value:[...]} signatures field is tolerated')
  assert.equal(wrapped.reviewer.id, 'openreview:Reviewer_Cd34')
  assert.equal(wrapped.text, 'Single dataset', '{value} unwraps with the openreview tool rule, missing stays missing')

  // note_id → invitation identity ladder; raw note shape without signatures.
  res = await importRebuttalPoints({ cwd, slug: 'orv', source: 'openreview', reviews: [{ id: 'n6', forum: 'f1', invitations: ['X/-/Official_Review'], content: { weaknesses: { value: 'raw note weakness' }, rating: { value: 3 } } }] })
  assert.equal(listRebuttalPoints(cwd, 'orv').find((p) => p.native_id === 'n6#weaknesses').reviewer.identity_source, 'note_id')
  await importRebuttalPoints({ cwd, slug: 'orv', source: 'openreview', reviews: [{ invitations: ['X/-/Official_Review'], weaknesses: 'no id note' }] })
  assert.equal(listRebuttalPoints(cwd, 'orv').find((p) => p.native_id === 'idx-1#weaknesses').reviewer.identity_source, 'invitation')
  // Two id-less notes must not collapse onto one native id and drop a reviewer.
  const idless = await importRebuttalPoints({
    cwd, slug: 'orv-idless', source: 'openreview',
    reviews: [
      { invitations: ['X/-/Official_Review'], weaknesses: 'first id-less weakness' },
      { invitations: ['X/-/Official_Review'], weaknesses: 'second id-less weakness' },
    ],
  })
  assert.equal(idless.imported.total, 2, 'each id-less note keeps its own point')
  assert.deepEqual(idless.points.map((p) => p.native_id).sort(), ['idx-1#weaknesses', 'idx-2#weaknesses'])
  // forum_id degrades to a recorded null, never a guess.
  res = await importRebuttalPoints({ cwd, slug: 'orvnull', source: 'openreview', reviews: [{ invitations: ['X/-/Official_Review'], weaknesses: 'no forum' }] })
  assert.equal(res.envelope.ref.openreview.forum_id, null)
  // accepted wrapper shapes
  for (const shape of ['reviews', 'results', 'records', 'notes']) {
    const r = await importRebuttalPoints({ cwd, slug: `orv-${shape}`, source: 'openreview', reviews: { [shape]: [{ id: `w-${shape}`, forum: 'f1', invitation: 'X/-/Official_Review', weaknesses: 'w' }] } })
    assert.equal(r.imported.total, 1, `accepted shape {${shape}}`)
  }
  // file import through reviews_path keeps the hashFile convention (explicit prefix)
  ws.write('orv/fetch.json', JSON.stringify({ notes: [{ id: 'nf', forum: 'f9', invitations: ['X/-/Official_Review'], content: { weaknesses: { value: 'file weakness' } } }] }))
  res = await importRebuttalPoints({ cwd, slug: 'orv-file', source: 'openreview', reviewsPath: 'orv/fetch.json' })
  assert.equal(res.imported.total, 1)
  assert.equal(res.envelope.ref.openreview.input, 'reviews_path')
  assert.equal(res.envelope.ref.openreview.input_sha256, `sha256:${hashFile(join(cwd, 'orv/fetch.json'))}`)
  ws.write('orv/bad.json', '{oops')
  await assert.rejects(() => importRebuttalPoints({ cwd, slug: 'orv-bad', source: 'openreview', reviewsPath: 'orv/bad.json' }), /is not valid JSON/)
  await assert.rejects(() => importRebuttalPoints({ cwd, slug: 'orv-empty', source: 'openreview', reviews: [] }), /the supplied openreview batch is empty/)
  await assert.rejects(() => importRebuttalPoints({ cwd, slug: 'orv-x', source: 'openreview' }), /rebuttal import never fetches: pass reviews \(the openreview action="reviews" output this session already has\) or reviews_path to a workspace file containing it/)
  await assert.rejects(
    () => importRebuttalPoints({ cwd, slug: 'orv-fetch', source: 'openreview', reviews: orvBatch, forumId: 'abc' }),
    /rebuttal does not call openreview: run the openreview tool yourself, then pass its reviews array to import/,
  )

  /* ================================================================ plan */

  await assert.rejects(() => planRebuttalTask({ cwd, slug: 'nope', pointId: 'p0001', dataset: 'D1', baselineRef: 'reproduced', metric: 'accuracy', evidence: 'metric_table' }), /rebuttal "nope" not found under \.dsh\/rebuttal\/nope; run action "import" first/)
  await assert.rejects(() => planRebuttalTask({ cwd, slug: 'legacy', pointId: 'p9999', dataset: 'D1', baselineRef: 'reproduced', metric: 'accuracy', evidence: 'metric_table' }), /point "p9999" not found in rebuttal "legacy"/)
  await importRebuttalPoints({ cwd, slug: 'zero', source: 'openreview', reviews: [orvBatch[1]], kinds: ['checklist'] })
  await assert.rejects(() => planRebuttalTask({ cwd, slug: 'zero', pointId: 'p0001', dataset: 'D1', baselineRef: 'reproduced', metric: 'accuracy', evidence: 'metric_table' }), /rebuttal "zero" has no points; run action "import" first/)

  // A question with no weakness still plans — the ledger covers the whole review.
  let planned = await planRebuttalTask({
    cwd, slug: 'rich', pointId: qp.point_id, dataset: 'D1', baselineRef: 'reported', metric: 'accuracy',
    metricDirection: 'higher', replicates: 4, replicatesBasis: 'pilot', evidence: 'metric_table',
    experimentSlug: 'bench', rationale: 'pilot spread',
  })
  assert.equal(planned.task.task_id, 't0001')
  assert.equal(planned.task.point_id, qp.point_id)
  assert.equal(planned.task.source, 'deep_review')
  assert.equal(planned.task.cap_at_plan, 20)
  assert.equal(planned.task.validated.benchmark_state, 'validated')
  assert.equal(planned.task.validated.dataset_in_benchmark, true)
  assert.equal(planned.task.validated.metric_declared, true)
  assert.equal(planned.task.replicates_basis, 'pilot')
  assert.equal(planned.task.power, null)
  assert.equal(planned.task.rationale, 'pilot spread')

  // Benchmark mismatches are RECORDED, never refused: the reviewer asked for
  // exactly a dataset/arm the frozen spec does not contain.
  planned = await planRebuttalTask({
    cwd, slug: 'rich', pointId: wp.point_id, dataset: 'D9', baselineRef: 'reproduced', metric: 'f1',
    metricDirection: 'lower', replicates: 3, replicatesBasis: 'literature', evidence: 'additional_baseline',
    experimentSlug: 'bench',
  })
  assert.equal(planned.task.validated.dataset_in_benchmark, false)
  assert.equal(planned.task.validated.metric_declared, false)
  assert.ok(planned.task.validated.notes.some((n) => n.includes('dataset "D9" is not in the benchmark spec of experiment "bench" (known: D1)')))
  assert.ok(planned.task.validated.notes.some((n) => n.includes('metric "f1" is not declared by experiment "bench" (declared: accuracy, latency)')))
  // direction contradiction: declared higher, restated lower — a note, not a throw
  planned = await planRebuttalTask({
    cwd, slug: 'rich', pointId: wp.point_id, dataset: 'D1', baselineRef: 'reproduced', metric: 'accuracy',
    metricDirection: 'lower', replicates: 3, replicatesBasis: 'budget', evidence: 'metric_table', experimentSlug: 'bench',
  })
  assert.ok(planned.task.validated.notes.some((n) => n.includes('metric "accuracy" is declared higher in experiment "bench"; the stub restates it as lower')))
  // no-benchmark-spec path: the dataset reading is recorded unvalidated
  planned = await planRebuttalTask({
    cwd, slug: 'rich', pointId: wp.point_id, dataset: 'D5', baselineRef: 'reported', metric: 'accuracy',
    metricDirection: 'higher', replicates: 2, replicatesBasis: 'author_judgement', evidence: 'ablation', experimentSlug: 'plain',
  })
  assert.equal(planned.task.validated.benchmark_state, 'no_benchmark_spec')
  assert.equal(planned.task.validated.dataset_in_benchmark, null)
  // …and the declared-direction-null branch is reachable exactly there
  await assert.rejects(
    () => planRebuttalTask({ cwd, slug: 'rich', pointId: wp.point_id, dataset: 'D5', baselineRef: 'reported', metric: 'score', replicates: 2, replicatesBasis: 'author_judgement', evidence: 'text_revision', experimentSlug: 'plain' }),
    /metric "score" has no declared direction; pass metric_direction higher\|lower/,
  )
  await assert.rejects(() => planRebuttalTask({ cwd, slug: 'rich', pointId: wp.point_id, dataset: 'D1', baselineRef: 'reproduced', metric: 'accuracy', evidence: 'metric_table', replicates: 2, replicatesBasis: 'pilot', experimentSlug: 'ghost' }), /experiment "ghost" not found under \.dsh\/experiments\/ghost/)
  await assert.rejects(
    () => planRebuttalTask({ cwd, slug: 'rich', pointId: wp.point_id, dataset: 'D1', baselineRef: 'reproduced', metric: 'accuracy', evidence: 'metric_table', experimentSlug: 'bench' }),
    /replicates needs replicates_basis \(power_analysis\|pilot\|literature\|budget\|venue_requirement\|author_judgement\); the ledger records where a replicate count came from/,
  )
  await assert.rejects(
    () => planRebuttalTask({ cwd, slug: 'rich', pointId: wp.point_id, dataset: 'D1', baselineRef: 'reused', metric: 'accuracy', evidence: 'metric_table', replicates: 2, replicatesBasis: 'pilot' }),
    /baseline_ref must be one of reproduced, reported/,
  )
  await assert.rejects(
    () => planRebuttalTask({ cwd, slug: 'rich', pointId: wp.point_id, dataset: 'D1', baselineRef: 'reproduced', metric: 'accuracy', evidence: 'gold_standard', replicates: 2, replicatesBasis: 'pilot' }),
    /evidence must be one of/,
  )
  await assert.rejects(
    () => planRebuttalTask({ cwd, slug: 'rich', pointId: wp.point_id, dataset: 'D1', baselineRef: 'reproduced', metric: 'accuracy', evidence: 'metric_table', replicates: 0, replicatesBasis: 'pilot' }),
    /replicates must be an integer from 1 to 100/,
  )
  await assert.rejects(
    () => planRebuttalTask({ cwd, slug: 'rich', pointId: wp.point_id, dataset: 'D1', baselineRef: 'reproduced', metric: 'accuracy', evidence: 'metric_table', replicates: 2, replicatesBasis: 'guess' }),
    /replicates_basis must be one of/,
  )

  // The exact stub is refused; a different arm is not.
  await assert.rejects(
    () => planRebuttalTask({ cwd, slug: 'rich', pointId: qp.point_id, dataset: 'D1', baselineRef: 'reported', metric: 'accuracy', metricDirection: 'higher', replicates: 4, replicatesBasis: 'pilot', evidence: 'metric_table', experimentSlug: 'bench' }),
    /point p0003 already has that stub \(t0001\); link another run or plan a different arm/,
  )

  /* ------------------------------------------------------------- power */

  const nestedPower = {
    action: 'power',
    result: { n: 8, n_unrounded: 6.31, power: 0.81 },
    inputs: { test: 'two-sample t', alpha: 0.05, tails: 2, n_unit: 'participant', effect_metric: 'cohens_d', effect_size: 0.8 },
    method: 'simulation', software: 'R pwr 2.1', notes: ['balanced arms'], effect_source: { source: 'literature' },
  }
  planned = await planRebuttalTask({
    cwd, slug: 'rich', pointId: wp.point_id, dataset: 'D2', baselineRef: 'reproduced', metric: 'accuracy',
    metricDirection: 'higher', evidence: 'statistical_evidence', power: nestedPower,
  })
  assert.deepEqual(planned.task.power, {
    ...nestedPower, basis: 'power_analysis',
    source_note: 'power_analysis is stateless; these numbers come from the result object supplied in this call',
  }, 'the supplied power_analysis result is stored VERBATIM plus exactly the two rebuttal-owned keys')
  assert.equal(planned.task.replicates, 8, 'replicates defaults to the powered n')
  assert.equal(planned.task.replicates_basis, 'power_analysis')
  await assert.rejects(
    () => planRebuttalTask({
      cwd, slug: 'rich', pointId: wp.point_id, dataset: 'D2', baselineRef: 'reproduced', metric: 'latency',
      metricDirection: 'lower', evidence: 'statistical_evidence', replicates: 9, power: nestedPower,
    }),
    /replicates may not exceed the powered n \(8\) — plan fewer replicates and record the shortfall, or supply a power result that supports 9/,
  )
  planned = await planRebuttalTask({
    cwd, slug: 'rich', pointId: wp.point_id, dataset: 'D2', baselineRef: 'reproduced', metric: 'latency',
    metricDirection: 'lower', evidence: 'reproducibility_detail', replicates: 6, power: nestedPower,
  })
  assert.ok(planned.task.validated.notes.includes('replicates <powered n by 2>'))
  await assert.rejects(
    () => planRebuttalTask({
      cwd, slug: 'rich', pointId: wp.point_id, dataset: 'D2', baselineRef: 'reproduced', metric: 'accuracy',
      metricDirection: 'higher', evidence: 'metric_table', power: { error: 'test is not supported', code: 'E_POWER' },
    }),
    /power_analysis returned an error \("test is not supported", code E_POWER\); a replicate count cannot come from it/,
  )
  // a flat preregister-style object is accepted as-is through the same accessors
  planned = await planRebuttalTask({
    cwd, slug: 'rich', pointId: qp.point_id, dataset: 'D3', baselineRef: 'reported', metric: 'accuracy',
    metricDirection: 'higher', evidence: 'ablation', power: { n: 5, effect_size: 0.9 },
  })
  assert.equal(planned.task.replicates, 5)
  assert.ok(planned.task.validated.notes.includes('the power result carries no effect_source; the sample size is unattributed'))
  // convention effect source passthrough
  planned = await planRebuttalTask({
    cwd, slug: 'rich', pointId: qp.point_id, dataset: 'D3', baselineRef: 'reported', metric: 'latency',
    metricDirection: 'lower', evidence: 'citation_fix',
    power: { result: { n: 4 }, effect_source: { source: 'convention', note: 'd = 0.8 is the field default' } },
  })
  assert.ok(planned.task.validated.notes.includes('d = 0.8 is the field default'))
  assert.ok(planned.task.validated.notes.includes('sample size rests on a convention, not measured effect'))
  await assert.rejects(
    () => planRebuttalTask({ cwd, slug: 'rich', pointId: wp.point_id, dataset: 'D7', baselineRef: 'reported', metric: 'accuracy', metricDirection: 'higher', evidence: 'metric_table', power: { note: 'no n anywhere' } }),
    /power\.n must be a positive whole number/,
  )

  /* ------------------------------------------------------------ plan cap */

  const cap1 = await importRebuttalPoints({ cwd, slug: 'cap1', source: 'openreview', reviews: [orvBatch[0]] })
  await planRebuttalTask({ cwd, slug: 'cap1', pointId: cap1.points[0].point_id, dataset: 'D1', baselineRef: 'reproduced', metric: 'x', evidence: 'metric_table', replicates: 1, replicatesBasis: 'budget', cap: { max_tasks: 1, source: 'setting' } })
  await assert.rejects(
    () => planRebuttalTask({ cwd, slug: 'cap1', pointId: cap1.points[1].point_id, dataset: 'D2', baselineRef: 'reproduced', metric: 'y', evidence: 'metric_table', replicates: 1, replicatesBasis: 'budget', cap: { max_tasks: 1, source: 'setting' } }),
    /plan cap reached: rebuttal "cap1" keeps at most 1 supplementary task\(s\) \(REBUTTAL_MAX_TASKS, setting\); 1 are already planned — consolidate stubs, answer the remaining points without a supplementary experiment \(action "respond"\), or raise the setting/,
  )
  // crossed cap under concurrency: the in-lock read is what makes two
  // simultaneous plans at cap 2 land exactly two rows, never three.
  const cap2 = await importRebuttalPoints({ cwd, slug: 'cap2', source: 'openreview', reviews: [orvBatch[0]] })
  await planRebuttalTask({ cwd, slug: 'cap2', pointId: cap2.points[0].point_id, dataset: 'D1', baselineRef: 'reproduced', metric: 'x', evidence: 'metric_table', replicates: 1, replicatesBasis: 'budget' })
  const raced = await Promise.allSettled([
    planRebuttalTask({ cwd, slug: 'cap2', pointId: cap2.points[0].point_id, dataset: 'D2', baselineRef: 'reproduced', metric: 'y', evidence: 'metric_table', replicates: 1, replicatesBasis: 'budget', cap: { max_tasks: 2, source: 'setting' } }),
    planRebuttalTask({ cwd, slug: 'cap2', pointId: cap2.points[1].point_id, dataset: 'D3', baselineRef: 'reproduced', metric: 'z', evidence: 'metric_table', replicates: 1, replicatesBasis: 'budget', cap: { max_tasks: 2, source: 'setting' } }),
  ])
  assert.equal(raced.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(raced.filter((r) => r.status === 'rejected' && /plan cap reached/.test(String(r.reason))).length, 1)
  assert.equal(listRebuttalTasks(cwd, 'cap2').length, 2)
  // and the cap with a zero-task ledger still lets exactly one through
  const cap0 = await importRebuttalPoints({ cwd, slug: 'cap0', source: 'openreview', reviews: [orvBatch[0]] })
  const raced0 = await Promise.allSettled([
    planRebuttalTask({ cwd, slug: 'cap0', pointId: cap0.points[0].point_id, dataset: 'D1', baselineRef: 'reproduced', metric: 'x', evidence: 'metric_table', replicates: 1, replicatesBasis: 'budget', cap: { max_tasks: 1, source: 'setting' } }),
    planRebuttalTask({ cwd, slug: 'cap0', pointId: cap0.points[1].point_id, dataset: 'D2', baselineRef: 'reproduced', metric: 'y', evidence: 'metric_table', replicates: 1, replicatesBasis: 'budget', cap: { max_tasks: 1, source: 'setting' } }),
  ])
  assert.equal(raced0.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(raced0.filter((r) => r.status === 'rejected' && /plan cap reached/.test(String(r.reason))).length, 1)
  assert.equal(listRebuttalTasks(cwd, 'cap0').length, 1)

  /* --------------------------------------------------------------- link */

  const richTasks = listRebuttalTasks(cwd, 'rich')
  const tQ = richTasks.find((t) => t.task_id === 't0001') // qp's task
  const tW = richTasks.find((t) => t.task_id === 't0002') // wp's D9 task
  let linked = await linkRebuttalTask({ cwd, slug: 'rich', taskId: tQ.task_id, experimentSlug: 'bench', experimentRunId: expRun.run_id, note: 'full arm' })
  assert.equal(linked.link.link_id, 'l0001')
  assert.equal(linked.link.task_id, 't0001')
  assert.equal(linked.link.point_id, qp.point_id)
  assert.equal(linked.link.source.ledger, 'experiment')
  assert.match(linked.link.source.digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(linked.link.source.digest, sourceDigest(expRun), 'the digest pins the whole linked run event')
  assert.deepEqual(linked.link.source.artifacts, [{ path: 'out/metrics.json', sha256: `sha256:${hashFile(join(cwd, 'out/metrics.json'))}` }])
  assert.equal(linked.link.source.artifact_total, 1)
  assert.equal(linked.link.source.metrics_source, 'linked experiment run (read live by id)')
  assert.equal(linked.link.reading, null)
  linked = await linkRebuttalTask({ cwd, slug: 'rich', taskId: tW.task_id, analysisSlug: 'ar', analysisRunId: 'a0001', reading: { accuracy: '0.42' } })
  assert.equal(linked.link.link_id, 'l0002')
  assert.equal(linked.link.source.ledger, 'analysis')
  assert.equal(linked.link.reading.accuracy, 0.42, 'caller readings coerce with Number and are labelled as such')
  assert.equal(linked.link.source.metrics_source, 'caller reading of hashed outputs')
  assert.deepEqual(linked.link.source.artifacts, [{ path: 'r.csv', sha256: `sha256:${'a'.repeat(64)}` }, { path: 'r.csv', sha256: null }])
  assert.equal(linked.link.source.artifact_total, 2)
  await assert.rejects(() => linkRebuttalTask({ cwd, slug: 'rich', taskId: tQ.task_id, experimentSlug: 'bench', experimentRunId: expRun.run_id, analysisSlug: 'ar', analysisRunId: 'a0001' }), /link one source: experiment_log or analysis_run, not both/)
  await assert.rejects(() => linkRebuttalTask({ cwd, slug: 'rich', taskId: tQ.task_id }), /link needs experiment_slug \+ experiment_run_id or analysis_slug \+ analysis_run_id/)
  await assert.rejects(() => linkRebuttalTask({ cwd, slug: 'rich', taskId: tQ.task_id, experimentSlug: 'bench', experimentRunId: expRun.run_id, reading: { accuracy: 1 } }), /experiment links take metrics from the linked run; omit reading \(rebuttal stores no numbers of its own\)/)
  await assert.rejects(() => linkRebuttalTask({ cwd, slug: 'rich', taskId: tQ.task_id, experimentSlug: 'ghost', experimentRunId: 'x0001' }), /experiment "ghost" not found/)
  await assert.rejects(() => linkRebuttalTask({ cwd, slug: 'rich', taskId: tQ.task_id, experimentSlug: 'bench', experimentRunId: 'x9999' }), /experiment run "x9999" not found in experiment "bench"/)
  await assert.rejects(() => linkRebuttalTask({ cwd, slug: 'rich', taskId: tQ.task_id, analysisSlug: 'ghost', analysisRunId: 'a0001' }), /analysis "ghost" has no plan under \.dsh\/analysis\/ghost; run analysis_run action="plan" first/)
  await assert.rejects(() => linkRebuttalTask({ cwd, slug: 'rich', taskId: tQ.task_id, analysisSlug: 'ar', analysisRunId: 'a9999' }), /analysis run "a9999" not found in analysis "ar"/)
  await assert.rejects(() => linkRebuttalTask({ cwd, slug: 'rich', taskId: tW.task_id, analysisSlug: 'ar', analysisRunId: 'a0002' }), /analysis run "a0002" has no hashed outputs or artifacts; link an experiment run or an analysis run with hashed evidence/, 'a {status:not_written} output entry is not evidence')
  await assert.rejects(() => linkRebuttalTask({ cwd, slug: 'rich', taskId: tW.task_id, analysisSlug: 'ar', analysisRunId: 'a0001' }), /reading is required for an analysis_run link; the run carries no metrics/)
  await assert.rejects(() => linkRebuttalTask({ cwd, slug: 'rich', taskId: tW.task_id, analysisSlug: 'ar', analysisRunId: 'a0001', reading: { accuracy: 'lots' } }), /metric accuracy must be a finite number/)
  await assert.rejects(
    () => linkRebuttalTask({ cwd, slug: 'rich', taskId: tQ.task_id, experimentSlug: 'bench', experimentRunId: expRun.run_id }),
    /task t0001 is already linked to experiment bench\/x0001 \(l0001\); a rerun is a new run id — link that one instead/,
  )
  // linking the drifted, bad-verdict spec_drift run is allowed: the gate is coverage, not outcome
  const tDrift = await planRebuttalTask({ cwd, slug: 'rich', pointId: wp.point_id, dataset: 'D6', baselineRef: 'reproduced', metric: 'accuracy', metricDirection: 'higher', replicates: 2, replicatesBasis: 'pilot', evidence: 'metric_table' })
  linked = await linkRebuttalTask({ cwd, slug: 'rich', taskId: tDrift.task.task_id, experimentSlug: 'bench', experimentRunId: 'x0002' })
  assert.equal(linked.link.link_id, 'l0003')
  assert.equal(listRebuttalLinks(cwd, 'rich').length, 3)

  /* ------------------------------------------------------------- respond */

  await assert.rejects(() => recordRebuttalAnswer({ cwd, slug: 'rich', pointId: wp.point_id, response: '  ' }), /response is required \(this tool never writes reviewer prose\)/)
  await assert.rejects(() => recordRebuttalAnswer({ cwd, slug: 'rich', pointId: wp.point_id, response: 'ok', linkIds: ['l9999'] }), /link "l9999" not found in rebuttal "rich"/)
  await assert.rejects(
    () => recordRebuttalAnswer({ cwd, slug: 'rich', pointId: wp.point_id, response: 'ok', linkIds: ['l0001'] }),
    new RegExp(`link "l0001" belongs to point "${qp.point_id}", not "${wp.point_id}"; link a task planned for that point`),
  )
  await assert.rejects(() => recordRebuttalAnswer({ cwd, slug: 'rich', pointId: wp.point_id, response: 'ok', changeIds: ['ch-001'] }), /change_ids need change_slug \(the manuscript_diff slug holding the recorded hunks\)/)
  await assert.rejects(() => recordRebuttalAnswer({ cwd, slug: 'rich', pointId: wp.point_id, response: 'ok', changeSlug: 'ghost', changeIds: ['ch-001'] }), /no recorded changes for "ghost" under \.dsh\/manuscript-diff\/; run manuscript_diff action=changes first/)
  await assert.rejects(() => recordRebuttalAnswer({ cwd, slug: 'rich', pointId: wp.point_id, response: 'ok', changeSlug: '../../../../etc/passwd', changeIds: ['ch-001'] }), /no recorded changes for "etc-passwd"/, 'the raw value is normalized through manuscript-diff\u2019s own sanitizer — nothing reaches outside .dsh/manuscript-diff/')
  await assert.rejects(() => recordRebuttalAnswer({ cwd, slug: 'rich', pointId: wp.point_id, response: 'ok', changeSlug: 'revision-3', changeIds: ['ch-001'] }), /no recorded changes for "revision-3"/, 'a record whose own slug field disagrees with its directory is refused')
  await assert.rejects(() => recordRebuttalAnswer({ cwd, slug: 'rich', pointId: wp.point_id, response: 'ok', changeSlug: 'revision-1', changeIds: ['ch-999'] }), /change "ch-999" is not in the recorded changes for "revision-1"/)

  // 'Revision 1' (raw cased/spaced form) resolves the directory manuscript-diff actually wrote.
  let answered = await recordRebuttalAnswer({
    cwd, slug: 'rich', pointId: wp.point_id, response: 'We added D2 with a reproduced baseline; see l0002 and the recorded hunk.',
    linkIds: ['l0002'], changeSlug: 'Revision 1', changeIds: ['ch-001'],
  })
  assert.equal(answered.answer.answer_id, 'a0001')
  assert.equal(answered.answer.revision, 1)
  assert.equal(answered.answer.evidence, 'both')
  assert.equal(answered.answer.change_pin.slug, 'revision-1', 'the pin stores the normalized slug')
  assert.equal(answered.answer.change_pin.old_sha256, oldSha)
  assert.equal(answered.answer.change_pin.new_sha256, newSha)
  assert.deepEqual(answered.answer.change_pin.ids, ['ch-001'])
  answered = await recordRebuttalAnswer({ cwd, slug: 'rich', pointId: qp.point_id, response: 'Seeds are now reported; see the pinned run.', linkIds: ['l0001'] })
  assert.equal(answered.answer.answer_id, 'a0002')
  assert.equal(answered.answer.evidence, 'linked_artifact')
  const bareAnswer = await recordRebuttalAnswer({ cwd, slug: 'rich', pointId: ddd.point_id, response: 'Reformatted; argument only.' })
  assert.equal(bareAnswer.answer.evidence, 'none_cited')
  await assert.rejects(
    () => recordRebuttalAnswer({ cwd, slug: 'rich', pointId: ddd.point_id, response: 'Reformatted; argument only.' }),
    new RegExp(`point ${ddd.point_id} already has this answer \\(a0003\\); append a revision with different text`),
  )
  // revision increments over the point's max, never resets
  const revised = await recordRebuttalAnswer({ cwd, slug: 'rich', pointId: ddd.point_id, response: 'Reformatted again with a citation to Table 4.' })
  assert.equal(revised.answer.revision, 2)
  assert.equal(revised.answer.supersedes, 'a0003')
  // a 9000-char author answer clips at 8000
  const longAnswer = await recordRebuttalAnswer({ cwd, slug: 'rich', pointId: claim.point_id, response: 'y'.repeat(9000), changeSlug: 'revision-2', changeIds: ['ch-001'] })
  assert.equal(longAnswer.answer.response.length, 8000)
  assert.equal(longAnswer.answer.evidence, 'recorded_hunks')

  /* ------------------------------------------------------------- decline */

  // an ah decline is only recognized when the engine records it
  await assert.rejects(
    () => recordRebuttalDecline({ cwd, slug: 'ah', pointId: ahR11.point_id, reason: 'out of scope', ahItem: 'R1.1' }),
    /ah item "R1\.1" has status "open", not "declined"; declining a reviewer's point is the author's decision — run ah_author action=decline R1\.1 first, then record it here/,
  )
  await assert.rejects(
    () => recordRebuttalDecline({ cwd, slug: 'ah', pointId: ahR12.point_id, reason: 'no', ahItem: 'R1.1' }),
    /decline names ah item "R1\.1" but point .* was imported from ah_review/,
  )
  let declined = await recordRebuttalDecline({ cwd, slug: 'ah', pointId: ahR12.point_id, reason: 'Fixed in the revision.', ahItem: 'R1.2' })
  assert.equal(declined.decline.verified, true)
  assert.equal(declined.decline.decline_source, 'ah_author_decline')
  assert.equal(declined.decline.ah_status, 'declined')
  assert.equal(declined.decline.ah_response_present, true)
  assert.equal(declined.decline.ah_review, 'R1')
  assert.deepEqual(declined.warnings, [])
  declined = await recordRebuttalDecline({ cwd, slug: 'ah', pointId: ahR13.point_id, reason: 'Sampler ablation is out of scope for this round.', ahItem: 'R1.3' })
  assert.equal(declined.decline.verified, true)
  assert.equal(declined.warnings.length, 1)
  assert.match(declined.warnings[0], /ah item R1\.3 is declined with no response text; the engine reports REV-04 \(major\) and ah_check will block/)
  assert.deepEqual(declined.decline.warnings, declined.warnings)
  await assert.rejects(
    () => recordRebuttalDecline({ cwd, slug: 'ah', pointId: ahR12.point_id, reason: 'again', ahItem: 'R1.2' }),
    new RegExp(`point ${ahR12.point_id} is already declined \\(d0001\\); declines are append-only history`),
  )
  // a non-ah decline is author-recorded, never invisible, never invented by the tool
  await assert.rejects(
    () => recordRebuttalDecline({ cwd, slug: 'rich', pointId: qp.point_id, reason: 'no' }),
    /decline needs declined_by \(who declined\) for a point with no ah item, or ah_item to verify against the engine ledger/,
  )
  await assert.rejects(
    () => recordRebuttalDecline({ cwd, slug: 'rich', pointId: qp.point_id, reason: 'budget', declinedBy: 'the author' }),
    new RegExp(`point ${qp.point_id} is answered \\(a0002\\); pass supersedes naming that answer to decline over it`),
  )
  declined = await recordRebuttalDecline({ cwd, slug: 'rich', pointId: qp.point_id, reason: 'Seed sweep exceeds the compute budget.', declinedBy: 'the author', supersedes: 'a0002' })
  assert.equal(declined.decline.verified, false)
  assert.equal(declined.decline.decline_source, 'author_recorded')
  assert.equal(declined.decline.declined_by, 'the author')
  assert.equal(declined.decline.supersedes, 'a0002')
  const ahDeclines = listRebuttalDeclines(cwd, 'ah')
  assert.equal(ahDeclines.length, 2)

  // answering a declined point needs supersedes naming the decline, and the
  // revision still increments over the point's answers (never resets to 1).
  await assert.rejects(
    () => recordRebuttalAnswer({ cwd, slug: 'rich', pointId: qp.point_id, response: 'Actually the sweep fit in the end.' }),
    new RegExp(`point ${qp.point_id} is declined \\(d0001\\); pass supersedes to answer a point the author declined`),
  )
  // the ah ledger gives the same rule a deterministically ordered point
  await assert.rejects(
    () => recordRebuttalAnswer({ cwd, slug: 'ah', pointId: ahR13.point_id, response: 'We ran the sampler ablation after all.' }),
    new RegExp(`point ${ahR13.point_id} is declined \\(d0002\\); pass supersedes to answer a point the author declined`),
  )
  const overDecline = await recordRebuttalAnswer({ cwd, slug: 'ah', pointId: ahR13.point_id, response: 'We ran the sampler ablation after all.', supersedes: 'd0002' })
  assert.equal(overDecline.answer.supersedes, 'd0002')
  assert.equal(overDecline.answer.revision, 1, 'revision is 1 + the point\u2019s max answer revision (none yet), independent of the decline')

  // Same-millisecond tie: the monotonic event_seq, not the id prefix, decides
  // which of a decline and its superseding answer is the active record.
  const sameMs = await importRebuttalPoints({
    cwd, slug: 'same-ms', source: 'openreview',
    reviews: [{ id: 'sm1', invitation: 'X/-/Official_Review', weaknesses: 'same-millisecond point' }],
  })
  const smPoint = sameMs.points[0]
  const smDecline = await recordRebuttalDecline({ cwd, slug: 'same-ms', pointId: smPoint.point_id, reason: 'declined first', declinedBy: 'the author' })
  await recordRebuttalAnswer({ cwd, slug: 'same-ms', pointId: smPoint.point_id, response: 'answered after the decline', supersedes: smDecline.decline.decline_id })
  const sameStamp = '2026-05-05T00:00:00.000Z'
  const smDeclineRow = readJsonl(join(cwd, '.dsh', 'rebuttal', 'same-ms', 'declines.jsonl'))[0]
  const smAnswerRow = readJsonl(join(cwd, '.dsh', 'rebuttal', 'same-ms', 'answers.jsonl'))[0]
  ws.write('.dsh/rebuttal/same-ms/declines.jsonl', `${JSON.stringify({ ...smDeclineRow, ts: sameStamp })}\n`)
  ws.write('.dsh/rebuttal/same-ms/answers.jsonl', `${JSON.stringify({ ...smAnswerRow, ts: sameStamp })}\n`)
  const sameMsCoverage = await rebuttalCoverage(cwd, 'same-ms', {})
  assert.equal(sameMsCoverage.rows[0].status, 'answered_asserted', 'the answer appended after the decline stays active even at the same timestamp')

  /* ----------------------------------------------------------- coverage */

  let coverage = await rebuttalCoverage(cwd, 'rich', { cap: { max_tasks: 20, source: 'default' } })
  const richAll = listRebuttalPoints(cwd, 'rich')
  assert.equal(coverage.outcome_note, OUTCOME_NOTE)
  assert.equal(coverage.slug, 'rich')
  assert.equal(coverage.dir, '.dsh/rebuttal/rich')
  assert.equal(coverage.note.includes('engine remains authoritative'), true)
  assert.equal(coverage.totals.points, richAll.length)
  assert.equal(coverage.totals.points, coverage.totals.answered + coverage.totals.answered_asserted + coverage.totals.declined_verified + coverage.totals.declined_recorded + coverage.totals.unaddressed)
  const rowOf = (id) => coverage.rows.find((r) => r.point_id === id)
  assert.equal(rowOf(qp.point_id).status, 'declined_recorded')
  assert.ok(coverage.warnings.includes(`point ${qp.point_id} is declined on the author's recorded word only (no engine item to verify)`))
  assert.equal(rowOf(qp.point_id).declined_via, 'author recorded')
  assert.equal(rowOf(wp.point_id).status, 'answered', 'a cited link that resolves is answered, whatever the verdict says')
  assert.equal(rowOf(wp.point_id).outcome.worst_verdict, 'bad', 'a bad verdict is reportable beside the point and does NOT reduce coverage')
  assert.equal(rowOf(wp.point_id).links.find((l) => l.link_id === 'l0002').ledger, 'analysis')
  assert.equal(rowOf(wp.point_id).links.find((l) => l.link_id === 'l0002').exit_code, 1, 'a non-zero exit is recorded, not suppressed')
  assert.equal(rowOf(wp.point_id).links.find((l) => l.link_id === 'l0002').reading.accuracy, 0.42)
  const driftLink = rowOf(wp.point_id).links.find((l) => l.link_id === 'l0003')
  assert.equal(driftLink.spec_drift_state, 'drift')
  assert.equal(driftLink.verdict.verdict, 'bad')
  assert.equal(driftLink.run_metrics.accuracy, 0.7, 'experiment metrics are read live by id, never copied')
  assert.equal(rowOf(ddd.point_id).status, 'answered_asserted', 'argument-only answers are kept out of answered')
  assert.equal(rowOf(claim.point_id).status, 'answered', 'a change id that resolves in its pinned record is evidence')
  assert.equal(rowOf(claim.point_id).hunks[0].resolved, true)
  assert.equal(rowOf(claim.point_id).hunks[0].change_slug, 'revision-2')
  assert.equal(rowOf(wp.point_id).hunks[0].version_pair_matches, true)
  assert.equal(rowOf(wp.point_id).tasks.length, 6)
  assert.equal(rowOf(wp.point_id).tasks.find((t) => t.task_id === 't0005').powered_n, 8)
  assert.equal(rowOf(qp.point_id).closed.state, 'not_compared', 'no closing round supplied → nothing is claimed')
  assert.ok(coverage.planning_gaps.points_without_tasks.includes(claim.point_id))
  assert.equal(coverage.planning_gaps.points_without_tasks.includes(qp.point_id), false)
  assert.equal(coverage.planning_gaps.cap.max_tasks, 20)
  assert.equal(coverage.by_source.deep_review.evaluator_kind.held_out, 8)
  assert.equal(coverage.by_source.deep_review.evaluator_kind_source.declared, 8)
  assert.equal(coverage.by_source.openreview.evaluator_kind.not_applicable, 3)
  assert.deepEqual(coverage.unaddressed, coverage.rows.filter((r) => r.status === 'unaddressed').map((r) => r.point_id))

  // closing pairing on 'pair': round-1 rows and round-2 rows vs the live
  // round-2 reading (bytes differ from the round-1 import → closed allowed)
  coverage = await rebuttalCoverage(cwd, 'pair', { closing: { deepReviewKey: K1 } })
  assert.equal(coverage.closing.compared_round.run_id, 'rev-0002')
  assert.equal(coverage.closing.compared_round.input_sha1, S1)
  assert.equal(coverage.closing.matched_by.id, 4, 'same-round rows pair by the id tier, including both checklist keys')
  assert.equal(coverage.closing.matched_by.question, 3)
  assert.equal(coverage.closing.matched_by.claim, 1)
  assert.equal(coverage.closing.matched_by.similar, 0)
  const pairQ1 = coverage.rows.find((r) => r.point_id === 'p0001')
  assert.equal(pairQ1.closed.matched_by, 'question', 'the headline feature pairs across rounds via the question tier — NEVER by the positional q-1 id, even though round 2 also has a q-1')
  assert.equal(pairQ1.closed.state, 'still_present')
  assert.equal(coverage.closing.closed_total, 0, 'this ledger imported round 2 itself — identical bytes forbid any closed reading')
  assert.equal(coverage.closing.variance_only_total, 6)
  assert.equal(coverage.closing.still_present_total, 8)
  const pairChecklistPoint = listRebuttalPoints(cwd, 'pair').find((p) => p.native_id === 'rev-0002:checklist-c1')
  const pairChecklist = coverage.rows.find((r) => r.point_id === pairChecklistPoint.point_id)
  assert.equal(pairChecklist.closed.state, 'still_present', 'a still-NO checklist item pairs by its stable key instead of reading closed')
  assert.equal(pairChecklist.closed.matched_by, 'id')
  const roundOneOnlyChecklist = listRebuttalPoints(cwd, 'pair').find((p) => p.native_id === 'rev-0001:checklist-one')
  assert.equal(coverage.rows.find((r) => r.point_id === roundOneOnlyChecklist.point_id).closed.state, 'variance_only', 'a checklist item that did not recur is variance, not closure')
  assert.ok(coverage.closing.note.includes('the compared round has the same input_sha1 as an imported round, so no row may read closed'))

  // round-1-only ledger paired against round 2: the summary tier does the work,
  // and the id tier never fires across content-seeded ids.
  await importRebuttalPoints({ cwd, slug: 'sum', source: 'deep_review', deepReviewKey: K1, deepReviewRound: 1 })
  coverage = await rebuttalCoverage(cwd, 'sum', { closing: { deepReviewKey: K1 } })
  assert.equal(coverage.closing.matched_by.id, 0, 'different content-seeded comment ids never pair by id across rounds')
  assert.equal(coverage.closing.matched_by.summary, 1)
  assert.equal(coverage.closing.matched_by.question, 1)
  assert.equal(coverage.closing.matched_by.claim, 1)
  assert.equal(coverage.closing.still_present_total, 3)
  assert.equal(coverage.closing.closed_total, 3)
  const sumAaaa = coverage.rows.find((r) => r.source === 'deep_review' && r.kind === 'weakness')
  assert.equal(sumAaaa.closed.matched_by, 'summary')
  assert.match(coverage.closing.note, /a closed finding is a lead, not proof the criticism was resolved; when input_sha1 matches the imported round the movement is reviewer variance, not revision/)
  assert.equal(coverage.rows.find((r) => r.kind === 'checklist').closed.state, 'closed', 'with a different input_sha1 a finding that did not recur may read closed')

  // identical bytes: no row may read closed; unmatched rows are variance_only
  await importRebuttalPoints({ cwd, slug: 'same', source: 'deep_review', deepReviewKey: K1 })
  coverage = await rebuttalCoverage(cwd, 'same', { closing: { deepReviewKey: K1 } })
  assert.equal(coverage.closing.closed_total, 0)
  assert.ok(coverage.rows.every((r) => r.closed.state !== 'closed'))
  const sameChecklist = coverage.rows.find((r) => r.kind === 'checklist')
  assert.equal(sameChecklist.closed.state, 'still_present', 'checklist items pair by their stable key even when the compared round is the imported round')
  assert.equal(coverage.closing.variance_only_total, 0)
  assert.ok(coverage.closing.note.includes('the compared round has the same input_sha1 as an imported round, so no row may read closed'))
  assert.equal(coverage.rows.find((r) => r.kind === 'weakness').closed.state, 'still_present')
  assert.equal(coverage.closing.matched_by.id >= 1, true)

  // ah engine-authority: a live engine response on an unaddressed ledger point diverges loudly
  coverage = await rebuttalCoverage(cwd, 'ah', {})
  const ahRow = coverage.rows.find((r) => r.point_id === ahR11.point_id)
  assert.equal(ahRow.ah.state, 'live')
  assert.equal(ahRow.ah.status, 'open')
  assert.equal(ahRow.ah.response_present, false)
  assert.equal(coverage.rows.find((r) => r.point_id === ahR12.point_id).status, 'declined_verified')
  assert.equal(coverage.rows.find((r) => r.point_id === ahR13.point_id).ah.units_total, 2)
  ws.write('ah-reviews/R1.yaml', ahYaml('addressed', 'Covered in Section 4.'))
  coverage = await rebuttalCoverage(cwd, 'ah', {})
  const diverged = coverage.rows.find((r) => r.point_id === ahR11.point_id)
  assert.equal(diverged.status, 'unaddressed', 'the engine stays authoritative for its own status; this ledger never auto-syncs')
  assert.equal(diverged.ah.status, 'addressed')
  assert.equal(diverged.ah.response_present, true)
  assert.ok(coverage.warnings.some((w) => w.includes(`ah item R1.1 is addressed with response text in the engine, but point ${ahR11.point_id} is unaddressed in this ledger; record the author's answer here or treat the engine as the source of truth`)))

  // limit truncation keeps full totals; the point filter
  coverage = await rebuttalCoverage(cwd, 'rich', { limit: 2 })
  assert.equal(coverage.rows.length, 2)
  assert.equal(coverage.row_total, richAll.length)
  assert.equal(coverage.totals.points, richAll.length)
  await assert.rejects(() => rebuttalCoverage(cwd, 'rich', { limit: 0 }), /limit must be an integer from 1 to 2000/)
  const single = await rebuttalCoverage(cwd, 'rich', { pointId: wp.point_id })
  assert.equal(single.rows.length, 1)
  await assert.rejects(() => rebuttalCoverage(cwd, 'rich', { pointId: 'p9999' }), /point "p9999" not found in rebuttal "rich"/)

  // digest drift: rewriting the foreign ledger out of band flips verified → drifted
  const runsNow = readJsonl(benchRuns)
  ws.write('.dsh/experiments/bench/runs.jsonl', `${runsNow.map((run) => JSON.stringify(run.run_id === 'x0001' ? { ...run, ts: '2099-01-01T00:00:00.000Z' } : run)).join('\n')}\n`)
  coverage = await rebuttalCoverage(cwd, 'rich', {})
  assert.equal(coverage.rows.find((r) => r.point_id === qp.point_id).links.find((l) => l.link_id === 'l0001').digest_state, 'drifted')
  assert.equal(coverage.rows.find((r) => r.point_id === qp.point_id).outcome.drifted_links, 1)
  // a malformed foreign line degrades to unreadable — never aborts the whole coverage call
  appendFileSync(benchRuns, '{broken\n')
  coverage = await rebuttalCoverage(cwd, 'rich', {})
  assert.equal(coverage.rows.find((r) => r.point_id === qp.point_id).links.find((l) => l.link_id === 'l0001').digest_state, 'unreadable')
  assert.ok(coverage.unreadable.some((u) => u.slug === 'bench' && /is not valid JSON/.test(u.reason)))
  assert.equal(coverage.totals.points, richAll.length, 'the unreadable reading still completes')
  // a corrupt closing round degrades too: compared_round null + unreadable, no abort
  coverage = await rebuttalCoverage(cwd, 'rich', { closing: { deepReviewKey: K9 } })
  assert.equal(coverage.closing.compared_round, null)
  assert.match(coverage.closing.note, /is unreadable, so no point could be compared/)
  assert.ok(coverage.unreadable.some((u) => u.ledger === 'deep_review'))
  // restore the pristine foreign ledger
  ws.write('.dsh/experiments/bench/runs.jsonl', benchRunsPristine)

  // version_pair_matches re-reads changes.json fresh: an overwrite with a
  // re-bound version pair flips it even though the ids still resolve.
  writeChanges('revision-1', `sha256:${'c'.repeat(64)}`, ['ch-001'])
  coverage = await rebuttalCoverage(cwd, 'rich', {})
  const hunkRow = coverage.rows.find((r) => r.point_id === wp.point_id)
  assert.equal(hunkRow.hunks[0].resolved, true)
  assert.equal(hunkRow.hunks[0].version_pair_matches, false, 'manuscript_diff re-binds ch-NNN ids by diff order on overwrite; the pinned pair is what must match')
  assert.equal(hunkRow.status, 'answered', 'stale evidence is flagged, never demoted')

  /* --------------------------------------------------------------- draft */

  await assert.rejects(() => draftRebuttalLetter(cwd, 'rich', { format: 'csv' }), /draft format must be one of markdown, latex \(json and csv are export formats\)/)
  await assert.rejects(() => draftRebuttalLetter(cwd, 'rich', { format: 'pdf' }), /draft format must be one of markdown, latex/)
  await assert.rejects(() => draftRebuttalLetter(cwd, 'rich', { points: ['p9999'] }), /point "p9999" not found in rebuttal "rich"/)

  // restore the clean pinned pair so the letter assertions are unambiguous
  writeChanges('revision-1', newSha, ['ch-001'])
  const manuscriptBytesBefore = readFileSync(join(cwd, 'paper/main.tex'), 'utf8')
  let draft = await draftRebuttalLetter(cwd, 'rich', {})
  assert.equal(draft.written, null, 'nothing is written without out')
  assert.ok(draft.retained && existsSync(join(cwd, draft.retained.path)), 'the ledger keeps a full copy even without out')
  const retainedPreview = readFileSync(join(cwd, draft.retained.path), 'utf8')
  assert.ok(retainedPreview.includes('Response to reviewers'))
  assert.ok(retainedPreview.length >= draft.letter.length)
  assert.equal(draft.format, 'markdown')
  assert.match(draft.letter, /\*\*Response\.\*\* We added D2 with a reproduced baseline; see l0002 and the recorded hunk\./)
  assert.match(draft.letter, /\*\*Response\.\*\* \[Author response required — this tool does not write it\.\]/)
  assert.match(draft.letter, /\*\*Declined by the author\*\* \(not verified against the engine ledger\): Seed sweep exceeds the compute budget\./, 'declined_recorded is always labelled')
  assert.match(draft.letter, /- l0002: analysis ar\/a0001 \(digest verified\), 2 hashed artifact\(s\), metrics read live: accuracy=0\.42 \(caller reading of hashed outputs\)/)
  assert.ok(!draft.letter.includes('l0001'), 'the letter cites only the links the answer itself cites')
  assert.ok(!draft.letter.includes('x0002'), 'a linked-but-useless run stays in coverage, not the letter')
  assert.match(draft.letter, /```diff\n-old line\n\+new line\n```/)
  assert.deepEqual(draft.unresolved, [])
  assert.deepEqual(draft.evidence_stale, [])
  assert.deepEqual(draft.change_slugs, ['revision-1', 'revision-2'])
  assert.equal(draft.outcome_note, OUTCOME_NOTE)
  assert.equal(draft.coverage_totals.points, richAll.length)
  assert.match(draft.letter, /This is a draft skeleton/)

  // manuscript_diff_items status mapping: 'addressed' only when a cited hunk
  // resolves AND its pinned version pair still matches.
  // (two slugs are cited here, so items arrive grouped — see below)

  // stale evidence line: same id, different version pair
  writeChanges('revision-1', `sha256:${'c'.repeat(64)}`, ['ch-001'])
  draft = await draftRebuttalLetter(cwd, 'rich', {})
  assert.deepEqual(draft.evidence_stale, ['ch-001'])
  assert.match(draft.letter, /EVIDENCE STALE: change `ch-001` no longer matches its pinned version pair/)
  assert.match(draft.letter, /-old line\n\+new line/, 'a stale hunk still prints its recorded hunks — the ledger never substitutes different evidence')
  // unresolved line: the id was re-bound away by an overwrite
  writeChanges('revision-1', newSha, ['ch-777'])
  draft = await draftRebuttalLetter(cwd, 'rich', {})
  assert.deepEqual(draft.unresolved, ['ch-001'])
  assert.match(draft.letter, /UNRESOLVED: change `ch-001` is not in the recorded changes for "revision-1"/)
  assert.ok(!draft.letter.includes('change `ch-001` (modify), old line 3'), 'no hunk block is emitted for an id missing from changes.json')
  writeChanges('revision-1', newSha, ['ch-001'])

  // grouping across slugs: ch-001 exists in BOTH records — the group-per-slug
  // items never print a cross-slug UNRESOLVED false positive.
  draft = await draftRebuttalLetter(cwd, 'rich', {})
  assert.equal(draft.note, 'run manuscript_diff action=letter once per revision slug (items and change_ids resolve against that slug only); never pass a mixed items array')
  assert.ok(!Array.isArray(draft.manuscript_diff_items))
  assert.deepEqual(Object.keys(draft.manuscript_diff_items).sort(), ['revision-1', 'revision-2'])
  assert.ok(draft.manuscript_diff_items['revision-1'].some((i) => i.id === wp.point_id))
  assert.ok(draft.manuscript_diff_items['revision-2'].some((i) => i.id === claim.point_id))
  assert.deepEqual(draft.unresolved, [], 'a hunk that exists in a second revision slug must not print UNRESOLVED')
  const wpItem = draft.manuscript_diff_items['revision-1'].find((i) => i.id === wp.point_id)
  assert.equal(wpItem.status, 'addressed')
  assert.equal(wpItem.change_ids.join(','), 'ch-001')
  assert.equal(draft.manuscript_diff_items['revision-1'].find((i) => i.id === ddd.point_id).status, 'rebuttal', 'an answer with no hunk is a rebuttal, not addressed')
  const singleSlugDraft = await draftRebuttalLetter(cwd, 'rich', { points: [wp.point_id] })
  assert.ok(Array.isArray(singleSlugDraft.manuscript_diff_items), 'one slug → the flat items array manuscript_diff consumes directly')
  assert.equal(singleSlugDraft.manuscript_diff_items.find((i) => i.id === wp.point_id).status, 'addressed')

  // declined/placeholder rendering on the ah ledger + handoff
  const ahDraft = await draftRebuttalLetter(cwd, 'ah', {})
  assert.match(ahDraft.letter, /\*\*Declined by the author\*\* \(verified against the engine ledger\)/)
  assert.ok(ahDraft.ah_handoff.length >= 1)
  assert.deepEqual(ahDraft.ah_handoff.find((h) => h.item === 'R1.1'), {
    review: 'R1', item: 'R1.1', tool: 'ah_review_respond', format: 'md',
    note: 'the engine builds the letter from the review snapshot diff; record the response text with ah_review_set and decline only with ah_author action=decline',
  })

  // out writes workspace-confined with the overwrite refusal; latex escapes
  const written = await draftRebuttalLetter(cwd, 'rich', { out: 'letters/letter.md' })
  assert.equal(written.written.path, 'letters/letter.md')
  assert.ok(existsSync(join(cwd, 'letters/letter.md')))
  assert.equal(readFileSync(join(cwd, 'letters/letter.md'), 'utf8'), readFileSync(join(cwd, written.retained.path), 'utf8'), 'out receives the full text, matching the ledger copy')
  await assert.rejects(() => draftRebuttalLetter(cwd, 'rich', { out: 'letters/letter.md' }), /letters\/letter\.md already exists; pass overwrite: true to replace it/)
  const latexDraft = await draftRebuttalLetter(cwd, 'rich', { format: 'latex', out: 'letters/letter.tex', overwrite: true })
  assert.match(latexDraft.letter, /\\section\*\{Response to reviewers: ICLR round 1\}/)
  assert.match(latexDraft.letter, /\\subsection\*\{p0004 \(deep\\_review, weakness, CRITICAL\)\}/, 'latex output escapes through the manuscript-diff helper semantics')
  const latexFile = readFileSync(join(cwd, 'letters/letter.tex'), 'utf8')
  assert.ok(latexFile.includes('\\begin{quote}'))
  assert.ok(latexFile.includes('\\begin{verbatim}'))
  // LaTeX escaping follows manuscript-diff's helper semantics
  await recordRebuttalAnswer({ cwd, slug: 'clip', pointId: 'p0001', response: 'Costs $100 & \\% and {braces} ~tilde ^caret.' })
  const texEsc = await draftRebuttalLetter(cwd, 'clip', { format: 'latex' })
  assert.ok(texEsc.letter.includes('Costs \\$100 \\& \\textbackslash{}\\% and \\{braces\\} \\textasciitilde{}tilde \\textasciicircum{}caret.'), texEsc.letter)
  // only_unanswered keeps the placeholder points
  const richNow = await rebuttalCoverage(cwd, 'rich', {})
  const only = await draftRebuttalLetter(cwd, 'rich', { onlyUnanswered: true })
  assert.deepEqual(only.manuscript_diff_items.map((i) => i.status), only.manuscript_diff_items.map(() => 'open'))
  assert.equal(only.manuscript_diff_items.length, richNow.totals.unaddressed)
  assert.equal(only.coverage_totals.answered, richNow.totals.answered)
  // manuscript untouched by every draft/export path
  assert.equal(readFileSync(join(cwd, 'paper/main.tex'), 'utf8'), manuscriptBytesBefore, 'draft never mutates a manuscript')

  /* --------------------------------------------------------------- export */

  await assert.rejects(() => exportRebuttal({ cwd, slug: 'rich', format: 'latex' }), /export format must be one of markdown, json, csv \(latex is a draft format only\)/)
  const md = await exportRebuttal({ cwd, slug: 'rich', format: 'markdown' })
  assert.equal(md.path, '.dsh/rebuttal/rich/exports/report.md')
  assert.ok(md.bytes > 0)
  const mdBody = readFileSync(join(cwd, md.path), 'utf8')
  assert.match(mdBody, /^# Rebuttal coverage: ICLR round 1/)
  assert.match(mdBody, /## By source/)
  assert.match(mdBody, /evaluator_kind held_out 8 \/ in_distribution 0 \/ not_applicable 0/)
  assert.match(mdBody, /openreview: 3 point\(s\).*not_applicable 3/)
  assert.match(mdBody, /only ah_check blocks/)
  assert.match(mdBody, /## Closing reading/)
  const jsonExport = await exportRebuttal({ cwd, slug: 'rich', format: 'json' })
  assert.equal(jsonExport.path, '.dsh/rebuttal/rich/exports/rebuttal.json')
  const body = JSON.parse(readFileSync(join(cwd, jsonExport.path), 'utf8'))
  assert.deepEqual(Object.keys(body).sort(), ['answers', 'coverage', 'declines', 'definition', 'imports', 'links', 'points', 'tasks'])
  assert.ok(body.coverage.totals.points > 0)
  const csvExport = await exportRebuttal({ cwd, slug: 'rich', format: 'csv' })
  assert.equal(csvExport.path, '.dsh/rebuttal/rich/exports/coverage.csv')
  const csvLines = readFileSync(join(cwd, csvExport.path), 'utf8').trimEnd().split('\n')
  assert.equal(csvLines[0], 'point_id,source,kind,severity,source_label,reviewer,evaluator_kind,evaluator_kind_source,status,tasks,links,answers,declined_by,change_ids,closed_state,matched_by,note')
  assert.equal(csvLines.length - 1, richAll.length)
  assert.ok(csvLines.some((line) => line.includes('declined_recorded')))
  await assert.rejects(() => exportRebuttal({ cwd, slug: 'rich', format: 'markdown' }), /report\.md already exists; pass overwrite: true to replace it/)
  await exportRebuttal({ cwd, slug: 'rich', format: 'markdown', overwrite: true })
  assert.equal(readFileSync(join(cwd, 'paper/main.tex'), 'utf8'), manuscriptBytesBefore, 'export never mutates a manuscript')

  /* --------------------------------------------------------------- status */

  let status = await statusRebuttal(cwd, 'nope', { cap: { max_tasks: 20, source: 'default' } })
  assert.equal(status.exists, false)
  assert.equal(status.state, 'empty')
  assert.equal(status.note, 'no rebuttal under .dsh/rebuttal/nope; run action "import" first')

  await importRebuttalPoints({ cwd, slug: 'zero', source: 'openreview', reviews: [orvBatch[1]], kinds: ['checklist'] })
  status = await statusRebuttal(cwd, 'zero', { cap: { max_tasks: 20, source: 'default' } })
  assert.equal(status.state, 'imported', 'definition but no points')
  status = await statusRebuttal(cwd, 'cap1', { cap: { max_tasks: 2, source: 'setting' } })
  assert.equal(status.state, 'planned')
  assert.deepEqual(status.tasks.cap, { max_tasks: 2, source: 'setting' })
  assert.equal(status.tasks.remaining, 1)
  assert.deepEqual(status.tasks.without_links, ['t0001'])
  assert.deepEqual(status.tasks.replicates_basis, { budget: 1 })

  status = await statusRebuttal(cwd, 'orv', { cap: { max_tasks: 20, source: 'default' } })
  assert.equal(status.state, 'imported')
  assert.ok(status.sources.openreview.forum_ids.includes('f1'))
  assert.ok(status.sources.openreview.forum_ids.includes(null), 'nulls are recorded where the forum was not derivable')

  status = await statusRebuttal(cwd, 'ah', { cap: { max_tasks: 20, source: 'default' } })
  assert.equal(status.state, 'draftable')
  assert.equal(status.declines.verified, 2)
  assert.equal(status.declines.recorded, 0)
  assert.deepEqual(status.sources.ah_review.map((a) => a.status), ['readable'])
  assert.equal(status.sources.ah_review[0].file, 'ah-reviews/R1.yaml')

  status = await statusRebuttal(cwd, 'rich', { cap: { max_tasks: 20, source: 'default' } })
  assert.equal(status.state, 'draftable')
  assert.equal(status.tasks.total, 9)
  assert.equal(status.links.total, 3)
  assert.equal(status.links.digest_verified, 3, 'the pristine ledgers re-verify')
  assert.equal(status.links.digest_drifted, 0)
  assert.equal(status.answers.total, 5)
  assert.ok(status.points.by_source.deep_review === 8 && status.points.by_source.openreview === 3)
  assert.deepEqual(status.points.by_evaluator_kind_source, { declared: 8, inferred: 0, not_applicable: 3 })
  assert.equal(status.sources.deep_review.key, K1)
  assert.equal(status.sources.deep_review.artifact, 'review.json')
  assert.equal(status.sources.deep_review.available_rounds, 2)
  assert.deepEqual(status.sources.deep_review.manuscripts, ['paper/main.tex'])
  assert.equal(status.sources.deep_review.manuscript_sha1_match, true, 'the definition pointer hashes to the imported round')
  ws.write('paper/main.tex', '% rebuttal fixture v1 EDITED\n')
  status = await statusRebuttal(cwd, 'rich', {})
  assert.equal(status.sources.deep_review.manuscript_sha1_match, false)
  ws.write('paper/main.tex', '% rebuttal fixture v1\n')
  status = await statusRebuttal(cwd, 'rich', {})
  assert.equal(status.sources.deep_review.manuscript_sha1_match, true)
  assert.equal(status.imports.length, 4, 'at most MAX_ENVELOPES_SHOWN (5) envelopes, and every import call recorded one')
  assert.ok(status.artifacts.points.exists && status.artifacts.exports.includes('coverage.csv'))
  assert.ok(status.manuscript_diff.some((m) => m.slug === 'revision-1' && m.version_pair_matches === true))
  assert.equal(status.outcome_note, OUTCOME_NOTE)
  assert.deepEqual(status.answers.latest_per_point[qp.point_id].answer_id, 'a0002', 'the last answer per point wins by ts then id')

  /* ------------------------------------------------------- append-only ids */

  const chain = await importRebuttalPoints({ cwd, slug: 'chain', source: 'openreview', reviews: [orvBatch[0], orvBatch[4]] })
  const chainTasks = []
  for (const point of chain.points.slice(0, 2)) {
    const t = await planRebuttalTask({ cwd, slug: 'chain', pointId: point.point_id, dataset: 'D1', baselineRef: 'reproduced', metric: 'accuracy', metricDirection: 'higher', replicates: 1, replicatesBasis: 'pilot', evidence: 'metric_table', experimentSlug: 'plain' })
    chainTasks.push(t.task)
  }
  const concLinks = await Promise.all([
    linkRebuttalTask({ cwd, slug: 'chain', taskId: chainTasks[0].task_id, experimentSlug: 'plain', experimentRunId: plainRun.run_id }),
    linkRebuttalTask({ cwd, slug: 'chain', taskId: chainTasks[1].task_id, experimentSlug: 'plain', experimentRunId: plainRun.run_id }),
  ])
  assert.deepEqual(concLinks.map((l) => l.link.link_id).sort(), ['l0001', 'l0002'], 'concurrent link appends allocate distinct ids')
  const chainStatus = await statusRebuttal(cwd, 'chain', { cap: { max_tasks: 20, source: 'default' } })
  assert.equal(chainStatus.state, 'linked', 'the status ladder climbs empty → imported → planned → linked → draftable')
  assert.deepEqual(chainStatus.links.by_ledger, { experiment: 2 })
  assert.equal(chainStatus.links.digest_verified, 2)
  assert.deepEqual(listRebuttalTasks(cwd, 'chain').map((t) => t.task_id), ['t0001', 't0002'], 'ids are append order, never reused or rewritten')
  const pointsBefore = JSON.parse(JSON.stringify(listRebuttalPoints(cwd, 'chain')))
  await importRebuttalPoints({ cwd, slug: 'chain', source: 'openreview', reviews: [orvBatch[0], orvBatch[4]] })
  assert.deepEqual(listRebuttalPoints(cwd, 'chain'), pointsBefore, 'a re-import replays to the identical ledger')

  console.log('rebuttal store OK')
} finally {
  ws.cleanup()
  aw.cleanup()
}
