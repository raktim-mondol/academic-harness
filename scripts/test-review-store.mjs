import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addEvidence, addRecords, deriveStatus, exportReview, readJsonl, screenRecord, startReview,
} from '../review-store.js'

const cwd = mkdtempSync(join(tmpdir(), 'ah-review-'))
const slug = 'test-review'

try {
  const started = await startReview({
    cwd,
    slug,
    protocol: {
      question: 'Does X improve Y?',
      databases: ['OpenAlex', 'PubMed'],
      inclusion: ['randomized trial'],
      exclusion: ['animal study'],
    },
  })
  assert.equal(started.resumed, false)
  assert.equal(started.protocol.question, 'Does X improve Y?')

  const resumed = await startReview({ cwd, slug, resume: true })
  assert.equal(resumed.resumed, true)
  await assert.rejects(() => startReview({ cwd, slug }), /already exists/)

  const first = await addRecords({
    cwd,
    slug,
    source: 'openalex',
    query: 'X Y',
    records: [
      { doi: '10.1000/a', title: 'Alpha study', authors: [{ name: 'Ada Lovelace' }], year: 2024, venue: 'Journal A' },
      { title: 'Beta study', year: 2023, authors: ['Alan Turing'] },
      { title: 'Beta Study', year: 2023, authors: ['Alan Turing'] },
    ],
  })
  assert.equal(first.added, 2)
  assert.equal(first.skipped, 1)
  assert.deepEqual(first.ids, ['r0001', 'r0002'])

  const second = await addRecords({
    cwd, slug, source: 'crossref', records: [{ doi: 'https://doi.org/10.1000/A', title: 'Alpha again', year: 2024 }],
  })
  assert.equal(second.added, 0)
  assert.equal(second.skipped, 1)

  let status = deriveStatus(cwd, slug)
  assert.equal(status.records_total, 2)
  assert.equal(status.screening.title_abstract.pending, 2)
  assert.equal(status.search.queries, 2)
  assert.equal(status.search.added, 2)
  assert.equal(status.search.skipped, 2)

  await assert.rejects(
    () => screenRecord({ cwd, slug, id: 'r0001', stage: 'full_text', decision: 'include' }),
    /title_abstract include/,
  )
  await screenRecord({ cwd, slug, id: 'r0001', stage: 'title_abstract', decision: 'include' })
  await assert.rejects(
    () => screenRecord({ cwd, slug, id: 'r0002', stage: 'title_abstract', decision: 'exclude' }),
    /reason is required/,
  )
  await screenRecord({
    cwd, slug, id: 'r0002', stage: 'title_abstract', decision: 'exclude', reason: 'animal study',
  })
  await screenRecord({ cwd, slug, id: 'r0001', stage: 'full_text', decision: 'include' })
  await assert.rejects(
    () => screenRecord({ cwd, slug, id: 'r0001', stage: 'full_text', decision: 'include' }),
    /already has a full_text decision/,
  )

  await assert.rejects(
    () => addEvidence({ cwd, slug, id: 'r0001', claim: 'X improves Y', quote: '', location: 'Results' }),
    /quote is required/,
  )
  const evidence = await addEvidence({
    cwd, slug, id: 'r0001', claim: 'X improves Y', quote: 'X improved Y by 20%.', location: 'Results, p. 4', page: '4',
  })
  assert.equal(evidence.evidence_id, 'e0001')

  status = deriveStatus(cwd, slug)
  assert.equal(status.screening.title_abstract.include, 1)
  assert.equal(status.screening.title_abstract.exclude, 1)
  assert.equal(status.screening.full_text.include, 1)
  assert.equal(status.evidence.rows, 1)
  assert.deepEqual(status.included, ['r0001'])
  assert.deepEqual(status.evidence.included_without_evidence, [])
  assert.equal(status.exclusion_reasons[0].reason, 'animal study')

  await screenRecord({
    cwd, slug, id: 'r0001', stage: 'full_text', decision: 'exclude', reason: 'wrong population', override: true,
  })
  status = deriveStatus(cwd, slug)
  assert.equal(status.screening.full_text.include, 0)
  assert.equal(status.screening.full_text.exclude, 1)
  assert.equal(readJsonl(cwd, slug, 'screening').length, 4, 'override must append, not replace, events')

  const markdown = exportReview({ cwd, slug, format: 'markdown' })
  assert.ok(existsSync(join(cwd, markdown.path)))
  assert.match(readFileSync(join(cwd, markdown.path), 'utf8'), /PRISMA-style counts/)
  const csv = exportReview({ cwd, slug, format: 'csv' })
  assert.match(readFileSync(join(cwd, csv.path), 'utf8'), /record_id,title,doi,claim,quote,location,page,section/)
  const json = exportReview({ cwd, slug, format: 'json' })
  assert.match(readFileSync(join(cwd, json.path), 'utf8'), /"records_total": 2/)

  assert.throws(() => exportReview({ cwd, slug, format: 'markdown' }), /already exists/)
  const replaced = exportReview({ cwd, slug, format: 'markdown', overwrite: true })
  assert.equal(replaced.format, 'markdown')

  console.log('review-store OK')
} finally {
  rmSync(cwd, { recursive: true, force: true })
}
