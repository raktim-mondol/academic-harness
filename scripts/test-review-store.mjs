import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addEvidence, addRecords, deriveStatus, exportReview, readJsonl, screenRecord, startReview,
} from '../review-store.js'
import { runReview } from '../review.js'

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
  assert.equal(status.multi_reviewer, undefined)
  assert.equal(status.reviewers, undefined)
  assert.equal(status.conflicts, undefined)
  assert.equal(status.screening.title_abstract.conflict, undefined)
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

  // Dual-reviewer screening
  const dual = 'dual-review'
  const startedDual = await startReview({
    cwd, slug: dual, protocol: { question: 'Does X improve Y under dual review?' }, reviewers: ['alice', 'bob'],
  })
  assert.deepEqual(startedDual.protocol.reviewers, ['human:alice', 'human:bob'])
  const resumedDual = await startReview({ cwd, slug: dual, reviewers: ['human:alice', 'human:bob'], resume: true })
  assert.equal(resumedDual.resumed, true)
  await assert.rejects(
    () => startReview({ cwd, slug: dual, reviewers: ['alice', 'carol'], resume: true }),
    /cannot be changed/,
  )
  await addRecords({
    cwd, slug: dual, records: [{ title: 'Gamma trial', year: 2024 }, { title: 'Delta trial', year: 2023 }],
  })
  await assert.rejects(
    () => screenRecord({ cwd, slug: dual, id: 'r0001', stage: 'title_abstract', decision: 'include' }),
    /reviewer is required/,
  )
  await assert.rejects(
    () => screenRecord({
      cwd, slug: dual, id: 'r0001', stage: 'title_abstract', decision: 'include', reviewer: 'carol',
    }),
    /not in the declared list/,
  )
  for (const reviewer of ['alice', 'bob']) {
    await screenRecord({ cwd, slug: dual, id: 'r0001', stage: 'title_abstract', decision: 'include', reviewer })
    await screenRecord({ cwd, slug: dual, id: 'r0001', stage: 'full_text', decision: 'include', reviewer })
  }
  await screenRecord({ cwd, slug: dual, id: 'r0002', stage: 'title_abstract', decision: 'include', reviewer: 'alice' })
  await screenRecord({
    cwd, slug: dual, id: 'r0002', stage: 'title_abstract', decision: 'exclude', reason: 'wrong population', reviewer: 'bob',
  })

  let dualStatus = deriveStatus(cwd, dual)
  assert.equal(dualStatus.multi_reviewer, true)
  assert.equal(dualStatus.screening.title_abstract.include, 1)
  assert.equal(dualStatus.screening.title_abstract.conflict, 1)
  assert.equal(dualStatus.screening.title_abstract.pending, 0)
  assert.equal(dualStatus.screening.full_text.include, 1)
  assert.equal(dualStatus.screening.full_text.not_eligible, 1)
  assert.equal(dualStatus.conflicts.length, 1)
  assert.equal(dualStatus.conflicts[0].stage, 'title_abstract')
  assert.equal(dualStatus.conflicts[0].state, 'conflict')
  assert.equal(dualStatus.conflicts[0].by_reviewer.length, 2)
  assert.deepEqual(dualStatus.included, ['r0001'])
  assert.equal(dualStatus.reviewers.length, 2)
  const dualExport = exportReview({ cwd, slug: dual, format: 'markdown' })
  assert.match(
    readFileSync(join(cwd, dualExport.path), 'utf8'),
    /\| Stage \| Include \| Exclude \| Maybe \| Conflict \| Pending \|/,
  )

  await assert.rejects(
    () => addEvidence({ cwd, slug: dual, id: 'r0002', claim: 'x', quote: 'y', location: 'Results' }),
    /title_abstract disagreement/,
  )
  await assert.rejects(
    () => screenRecord({
      cwd, slug: dual, id: 'r0002', stage: 'title_abstract', decision: 'include', reviewer: 'alice', override: true,
    }),
    /multi-reviewer review requires a reason/,
  )
  await assert.rejects(
    () => screenRecord({
      cwd, slug: dual, id: 'r0002', stage: 'title_abstract', decision: 'maybe', reason: 'x', reviewer: 'alice',
    }),
    /already has a title_abstract decision/,
  )
  await screenRecord({
    cwd, slug: dual, id: 'r0002', stage: 'title_abstract', decision: 'maybe', reason: 'needs discussion',
    reviewer: 'alice', override: true,
  })
  dualStatus = deriveStatus(cwd, dual)
  assert.equal(dualStatus.conflicts.length, 1, 'one override does not resolve the conflict')
  await screenRecord({
    cwd, slug: dual, id: 'r0002', stage: 'title_abstract', decision: 'maybe', reason: 'consensus maybe',
    reviewer: 'bob', override: true,
  })
  dualStatus = deriveStatus(cwd, dual)
  assert.equal(dualStatus.screening.title_abstract.conflict, 0)
  assert.equal(dualStatus.screening.title_abstract.maybe, 1)
  assert.equal(dualStatus.conflicts.length, 0)
  const aliceSummary = dualStatus.reviewers.find((row) => row.reviewer === 'human:alice')
  assert.equal(aliceSummary.title_abstract.include, 1)
  assert.equal(aliceSummary.title_abstract.maybe, 1)
  assert.equal(aliceSummary.full_text.include, 1)
  assert.equal(aliceSummary.full_text.not_eligible, 1)

  const dualEvents = readJsonl(cwd, dual, 'screening')
  assert.equal(dualEvents[0].event_id, 's0001')
  assert.equal(dualEvents[0].kind, 'screen')
  assert.equal(dualEvents[1].supersedes, null)
  assert.equal(dualEvents.at(-1).supersedes, 's0006')

  // A v0.29-shaped ledger may carry free-text reviewer names; derivation must
  // still treat it as one series until a reviewer roster or a new event exists.
  const legacy = 'legacy-reviewer'
  await startReview({ cwd, slug: legacy, protocol: { question: 'Legacy reviewer field?' } })
  await addRecords({ cwd, slug: legacy, records: [{ title: 'Legacy record', year: 2020 }] })
  const legacyEvents = [
    {
      ts: new Date().toISOString(), record_id: 'r0001', stage: 'title_abstract', decision: 'include', reason: null, reviewer: null, override: false,
    },
    {
      ts: new Date().toISOString(), record_id: 'r0001', stage: 'title_abstract', decision: 'exclude', reason: 'legacy override', reviewer: 'bob', override: true,
    },
  ]
  writeFileSync(
    join(cwd, '.dsh', 'review', legacy, 'screening.jsonl'),
    `${legacyEvents.map((row) => JSON.stringify(row)).join('\n')}\n`,
  )
  const legacyStatus = deriveStatus(cwd, legacy)
  assert.equal(legacyStatus.screening.title_abstract.exclude, 1)
  assert.equal(legacyStatus.screening.title_abstract.pending, 0)
  assert.equal(legacyStatus.screening.title_abstract.conflict, undefined)
  assert.equal(legacyStatus.screening.full_text.not_eligible, 1)
  assert.equal(legacyStatus.multi_reviewer, undefined)
  assert.equal(legacyStatus.conflicts, undefined)
  const legacyExport = exportReview({ cwd, slug: legacy, format: 'markdown' })
  assert.doesNotMatch(readFileSync(join(cwd, legacyExport.path), 'utf8'), /\| Conflict \|/)
  const legacyAgreement = await runReview(
    { action: 'agreement', slug: legacy, scope: 'screening' },
    { agent: { session: { header: { cwd } } } },
  )
  assert.ok(legacyAgreement.analyses.every((analysis) => analysis.human.pairs.length === 0))
  const resumedLegacy = await startReview({ cwd, slug: legacy, reviewers: ['bob'], resume: true })
  assert.deepEqual(resumedLegacy.protocol.reviewers, ['human:bob'])

  const named = 'named-review'
  await startReview({ cwd, slug: named, protocol: { question: 'Named reviewer?' } })
  await addRecords({ cwd, slug: named, records: [{ title: 'Named record', year: 2020 }] })
  await screenRecord({ cwd, slug: named, id: 'r0001', stage: 'title_abstract', decision: 'include', reviewer: 'alice' })
  await assert.rejects(
    () => screenRecord({ cwd, slug: named, id: 'r0001', stage: 'full_text', decision: 'include' }),
    /reviewer is required/,
  )
  await screenRecord({ cwd, slug: named, id: 'r0001', stage: 'full_text', decision: 'include', reviewer: 'alice' })

  console.log('review-store OK')
} finally {
  rmSync(cwd, { recursive: true, force: true })
}
