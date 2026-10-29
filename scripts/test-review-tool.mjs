import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, runReview as runReviewDirect } from '../review.js'

const cwd = mkdtempSync(join(tmpdir(), 'ah-review-tool-'))
const exec = { agent: { session: { header: { cwd } } } }
const slug = 'phase-3-smoke'

let tool
apply({ tools: { register: (registered) => { tool = registered } } })
const runReview = (args) => tool.execute(args, exec)

try {
  let r = await runReview({ action: 'status', slug })
  assert.match(r.error, /has not been started/)

  r = await runReview({ action: 'start', slug })
  assert.match(r.error, /question is required/)

  r = await runReview({
    action: 'start',
    slug,
    question: 'Does X improve Y in adults?',
    databases: ['OpenAlex', 'PubMed'],
    inclusion: ['randomized trial', 'adults'],
    exclusion: ['animal study'],
    date_range: '2015-2026',
  })
  assert.equal(r.action, 'start')
  assert.equal(r.resumed, false)
  assert.equal(r.dir, join('.dsh', 'review', slug))
  assert.equal(r.records_total, 0)

  r = await runReview({ action: 'start', slug, question: 'again' })
  assert.match(r.error, /already exists/)

  r = await runReview({ action: 'start', slug, resume: true })
  assert.equal(r.resumed, true)
  assert.equal(r.records_total, 0)

  const jsonl = [
    { doi: '10.1000/a', title: 'Alpha trial', authors: [{ name: 'Ada Lovelace' }], year: 2024, venue: 'Journal A', source: 'openalex' },
    { doi: '10.1000/b', title: 'Beta trial', authors: ['Alan Turing'], year: 2023 },
  ].map((row) => JSON.stringify(row)).join('\n')
  writeFileSync(join(cwd, 'results.jsonl'), jsonl)

  r = await runReview({ action: 'add', slug, path: 'results.jsonl', source: 'literature_search', query: 'X Y' })
  assert.equal(r.added, 2)
  assert.deepEqual(r.ids, ['r0001', 'r0002'])
  assert.equal(r.total, 2)

  r = await runReview({ action: 'add', slug, records: [{ doi: 'https://doi.org/10.1000/A', title: 'Alpha again' }] })
  assert.equal(r.added, 0)
  assert.equal(r.skipped, 1)

  r = await runReview({ action: 'add', slug, path: '../../etc/passwd' })
  assert.match(r.error, /escapes the workspace/)

  r = await runReview({ action: 'screen', slug, id: 'r0001', stage: 'full_text', decision: 'include' })
  assert.match(r.error, /title_abstract include/)

  r = await runReview({ action: 'screen', slug, id: 'r0001', stage: 'title_abstract', decision: 'exclude' })
  assert.match(r.error, /reason is required/)

  r = await runReview({ action: 'screen', slug, id: 'r0001', stage: 'title_abstract', decision: 'include' })
  assert.equal(r.decision, 'include')

  r = await runReview({ action: 'screen', slug, id: 'r0002', stage: 'title_abstract', decision: 'exclude', reason: 'animal study' })
  assert.equal(r.reason, 'animal study')

  r = await runReview({ action: 'screen', slug, id: 'r0001', stage: 'full_text', decision: 'include' })
  assert.equal(r.stage, 'full_text')

  r = await runReview({ action: 'evidence', slug, id: 'r0002', claim: 'nope', quote: 'q', location: 'Results' })
  assert.match(r.error, /full_text include/)

  r = await runReview({ action: 'evidence', slug, id: 'r0001', claim: 'X improves Y', quote: '', location: 'Results' })
  assert.match(r.error, /quote is required/)

  r = await runReview({
    action: 'evidence', slug, id: 'r0001', claim: 'X improves Y', quote: 'X improved Y by 20%.', location: 'Results, p. 4',
  })
  assert.equal(r.evidence_id, 'e0001')

  r = await runReview({ action: 'status', slug })
  assert.equal(r.status.records_total, 2)
  assert.equal(r.status.screening.full_text.include, 1)
  assert.deepEqual(r.status.included, ['r0001'])
  assert.deepEqual(r.status.evidence.included_without_evidence, [])
  const rendered = r.status
  assert.equal(rendered.title_abstract ?? undefined, undefined, 'status is a structured object, not a rendered report')

  const exported = await runReview({ action: 'export', slug, format: 'csv' })
  assert.match(exported.path, /\.dsh\/review\/phase-3-smoke\/exports\/evidence\.csv$/)
  assert.match(readFileSync(join(cwd, exported.path), 'utf8'), /X improved Y by 20%/)

  const again = await runReview({ action: 'export', slug, format: 'csv' })
  assert.match(again.error, /already exists/)

  const md = await runReview({ action: 'export', slug, format: 'markdown', overwrite: true })
  assert.equal(md.format, 'markdown')

  await assert.rejects(() => runReview({ action: 'nope', slug }), /must be one of/, 'the schema rejects unknown actions')

  r = await runReview({ action: 'screen', slug, id: 'r0001', stage: 'title_abstract', decision: 'maybe', reason: 'needs full text' })
  assert.match(r.error, /already has a title_abstract decision/)
  r = await runReview({ action: 'screen', slug, id: 'r0001', stage: 'title_abstract', decision: 'include', override: true })
  assert.equal(r.override, true)

  // Phase 4 actions
  r = await runReview({ action: 'appraisal_status', slug })
  assert.equal(r.action, 'appraisal_status')
  assert.match(r.status.note, /No appraisal instrument/)
  r = await runReview({ action: 'appraise', slug, id: 'r0001', instrument: 'rob-2', domain: 'd1', judgement: 'low' })
  assert.match(r.error, /reviewer is required/)
  r = await runReview({
    action: 'appraise', slug, id: 'r0001', instrument: 'rob-2', domain: 'd1', judgement: 'low',
    reviewer: 'alice', quote: 'X improved Y by 20%.', location: 'Results, p. 4',
  })
  assert.equal(r.event.judgement, 'low')
  assert.equal(r.event.quote_check.status, 'unverified')
  r = await runReview({ action: 'appraisal_status', slug })
  assert.equal(r.status.instruments.length, 1)
  assert.equal(r.status.instruments[0].complete_records, 0)
  r = await runReview({ action: 'agreement', slug, scope: 'appraisal', instrument: 'rob-2' })
  assert.equal(r.analyses.length, 1)
  assert.equal(r.analyses[0].human.pairs.length, 0)
  r = await runReview({ action: 'agreement', slug, scope: 'screening' })
  assert.equal(r.analyses.length, 2)
  r = await runReview({ action: 'agreement', slug, scope: 'screening', weighting: 'quadratic' })
  assert.match(r.error, /weighting applies/)
  r = await runReview({ action: 'export', slug, format: 'rob-table' })
  assert.match(r.path, /rob-table\.md$/)
  r = await runReview({ action: 'export', slug, format: 'rob-table' })
  assert.match(r.error, /already exists/)
  r = await runReview({ action: 'reconcile', slug, scope: 'appraisal', id: 'r0001', instrument: 'rob-2', domain: 'd1', judgement: 'low', reviewer: 'bob', reason: 'no conflict' })
  assert.match(r.error, /no d1 appraisal disagreement/)

  await assert.rejects(
    () => runReviewDirect({ action: 'agreement', slug, scope: 'nope' }, exec),
    /scope must be one of/,
  )
  await assert.rejects(
    () => runReviewDirect({ action: 'agreement', slug, scope: 'appraisal', instrument: 'rob-2', weighting: 'quartic' }, exec),
    /weighting must be one of/,
  )

  console.log('review tool OK')
} finally {
  rmSync(cwd, { recursive: true, force: true })
}
