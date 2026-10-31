import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildFigureRequest, buildRobSummary, buildRobTable, deriveOverall, domainCells,
  evaluateInstrument, fingerprint, loadInstruments, normaliseJudgement, resolveInstrument, scaleValues,
} from '../appraisal.js'
import {
  addRecords, appraiseRecord, deriveAppraisalStatus, exportReview, frozenInstrument, readInstruments,
  readJsonl, reconcileRecord, screenRecord, startReview,
} from '../review-store.js'
import { runReview } from '../review.js'
import { runHelper } from '../python-runtime.js'

const instruments = loadInstruments()
assert.equal(instruments.length, 11)
const byId = Object.fromEntries(instruments.map((item) => [item.id, item]))
assert.deepEqual(Object.keys(byId).sort(), [
  'amstar-2', 'casp-case-control', 'casp-cohort', 'casp-qualitative', 'newcastle-ottawa',
  'probast', 'quadas-2', 'quips', 'rob-2', 'robins-i', 'syrcle',
])
assert.equal(byId['rob-2'].domains.length, 5)
assert.equal(byId['robins-i'].domains.length, 7)
assert.equal(byId['quadas-2'].domains.length, 4)
assert.equal(byId['newcastle-ottawa'].domains.length, 3)
assert.equal(byId['amstar-2'].domains.length, 16)
assert.equal(byId['probast'].domains.length, 4)
assert.equal(byId['quips'].domains.length, 6)
assert.equal(byId['syrcle'].domains.length, 6)
assert.equal(byId['casp-cohort'].domains.length, 9)
assert.equal(byId['casp-case-control'].domains.length, 9)
assert.equal(byId['casp-qualitative'].domains.length, 9)
assert.equal(domainCells(byId['quadas-2']).length, 7, 'QUADAS-2 has four risk-of-bias cells and three applicability cells')
assert.equal(domainCells(byId['probast']).length, 7, 'PROBAST has four risk-of-bias cells and three applicability cells')
assert.deepEqual(byId['newcastle-ottawa'].domains.map((domain) => domain.max_stars), [4, 2, 3])
for (const instrument of instruments) {
  assert.match(instrument.source_url, /^https:\/\//)
  assert.ok(fingerprint(instrument).length === 64)
}
assert.match(byId['rob-2'].notes, /overall is derived/i)
assert.match(byId['robins-i'].notes, /overall is derived/i)
assert.match(byId['quadas-2'].notes, /does not define a derived overall/i)
assert.match(byId['amstar-2'].notes, /critical item/i)
assert.match(byId['probast'].notes, /no overall judgement is derived/i)

assert.equal(resolveInstrument('rob2').id, 'rob-2')
assert.equal(resolveInstrument('RoB-2@2019').id, 'rob-2')
assert.equal(resolveInstrument('robins').id, 'robins-i')
assert.equal(resolveInstrument('quadas').id, 'quadas-2')
assert.equal(resolveInstrument('nos').id, 'newcastle-ottawa')
assert.equal(resolveInstrument('amstar2').id, 'amstar-2')
assert.equal(resolveInstrument('amstar').id, 'amstar-2')
assert.equal(resolveInstrument('amstar-2@2017').version, '2017')
assert.equal(resolveInstrument('probast').id, 'probast')
assert.equal(resolveInstrument('syrcle').id, 'syrc' + 'le')
assert.equal(resolveInstrument('casp-cohort').id, 'casp-cohort')
assert.throws(() => resolveInstrument('casp'), /not bundled/)
assert.throws(() => resolveInstrument('rob-2', '2005'), /not bundled/)

// Overall derivation truth tables
const rob2 = byId['rob-2']
const rob2Values = (values) => Object.fromEntries(rob2.domains.map((domain, index) => [domain.id, values[index]]))
assert.equal(deriveOverall(rob2, rob2Values(['low', 'low', 'low', 'low', 'low'])).judgement, 'low')
assert.equal(deriveOverall(rob2, rob2Values(['low', 'some_concerns', 'low', 'low', 'low'])).judgement, 'some_concerns')
assert.equal(deriveOverall(rob2, rob2Values(['low', 'some_concerns', 'high', 'low', 'low'])).judgement, 'high')
assert.equal(deriveOverall(rob2, rob2Values(['high', 'low', 'low', 'low', 'low'])).judgement, 'high')
assert.equal(deriveOverall(rob2, rob2Values(['low', 'low', null, 'low', 'low'])), null)

const robins = byId['robins-i']
const robinsValues = (values) => Object.fromEntries(robins.domains.map((domain, index) => [domain.id, values[index]]))
assert.equal(deriveOverall(robins, robinsValues(['low', 'low', 'low', 'low', 'low', 'low', 'low'])).judgement, 'low')
assert.equal(deriveOverall(robins, robinsValues(['low', 'moderate', 'low', 'low', 'low', 'low', 'low'])).judgement, 'moderate')
assert.equal(deriveOverall(robins, robinsValues(['low', 'low', 'serious', 'low', 'low', 'low', 'low'])).judgement, 'serious')
assert.equal(deriveOverall(robins, robinsValues(['low', 'critical', 'low', 'low', 'low', 'low', 'low'])).judgement, 'critical')
assert.equal(deriveOverall(robins, robinsValues(['low', 'low', 'low', 'low', 'no_information', 'low', 'low'])).judgement, 'no_information')
assert.equal(deriveOverall(robins, robinsValues(['low', 'low', 'serious', 'low', 'no_information', 'low', 'low'])).judgement, 'serious')
assert.equal(deriveOverall(byId['quadas-2'], { d1: 'low' }), null)
for (const id of ['amstar-2', 'probast', 'quips', 'syrcle', 'casp-cohort', 'casp-case-control', 'casp-qualitative']) {
  assert.equal(byId[id].overall, undefined, `${id} defines no overall`)
  assert.equal(deriveOverall(byId[id], Object.fromEntries(byId[id].domains.map((domain) => [domain.id, 'low']))), null)
}
assert.equal(normaliseJudgement(byId['amstar-2'], byId['amstar-2'].domains[1], 'Partial yes'), 'partial_yes')
assert.equal(normaliseJudgement(byId['casp-cohort'], byId['casp-cohort'].domains[0], "can't tell"), 'cannot_tell')
assert.equal(normaliseJudgement(byId['quips'], byId['quips'].domains[0], 'Moderate risk'), 'moderate')
assert.throws(() => normaliseJudgement(byId['probast'], byId['probast'].domains[0], 'moderate'), /must be one of/)

// Judgement normalization
assert.equal(normaliseJudgement(rob2, rob2.domains[0], 'Some concerns'), 'some_concerns')
assert.equal(normaliseJudgement(byId['newcastle-ottawa'], byId['newcastle-ottawa'].domains[0], '3'), 3)
assert.throws(() => normaliseJudgement(byId['newcastle-ottawa'], byId['newcastle-ottawa'].domains[0], '5'), /0 to 4/)
assert.equal(scaleValues(byId['newcastle-ottawa'], byId['newcastle-ottawa'].domains[0]).length, 5)

const records = [{ id: 'r0001', title: 'Alpha trial', year: 2024, doi: '10.1000/a' }]
const instrumentRef = { id: 'rob-2', version: '2019' }
const event = (domain, judgement, reviewer = 'alice', extra = {}) => ({
  kind: 'appraise',
  ts: new Date().toISOString(),
  record_id: 'r0001',
  instrument: instrumentRef,
  domain,
  axis: domain === 'overall' ? null : 'risk_of_bias',
  judgement,
  reviewer,
  ...extra,
})
const rob2Domains = rob2.domains.map((domain) => domain.id)
const allLow = rob2Domains.map((domain) => event(domain, 'low'))

// Single reviewer: all domains, derived overall
let evaluation = evaluateInstrument({
  template: rob2, records, events: allLow, includedIds: ['r0001'],
})
assert.equal(evaluation.records.length, 1)
assert.equal(evaluation.records[0].status, 'complete')
assert.equal(evaluation.complete_records, 1)
assert.equal(evaluation.records[0].overall.value, 'low')
assert.equal(evaluation.records[0].overall.derived, true)
let table = buildRobTable(evaluation)
assert.equal(table.columns.length, 6)
assert.equal(table.rows[0].values.overall, 'low')
assert.equal(table.rows[0].overall_basis, 'derived')
let summary = buildRobSummary(evaluation)
assert.equal(summary.rows.length, 6)
assert.equal(summary.rows[0].counts.low, 1)
assert.equal(summary.rows[0].total, 1)

// Missing domain: overall pending
evaluation = evaluateInstrument({
  template: rob2, records, events: allLow.slice(0, 4), includedIds: ['r0001'],
})
assert.equal(evaluation.records[0].status, 'pending')
assert.equal(evaluation.records[0].overall.value, null)
assert.equal(evaluation.records[0].overall.state, 'pending')

// Conflict and reconciliation
const conflictEvents = [
  ...rob2Domains.slice(1).map((domain) => event(domain, 'low')),
  ...rob2Domains.slice(1).map((domain) => event(domain, 'low', 'bob')),
  event(rob2Domains[0], 'low', 'alice'),
  event(rob2Domains[0], 'high', 'bob'),
]
evaluation = evaluateInstrument({
  template: rob2, records, events: conflictEvents, includedIds: ['r0001'],
})
assert.equal(evaluation.records[0].status, 'conflict')
assert.equal(evaluation.records[0].overall.state, 'conflict')
assert.equal(evaluation.conflicts.length, 1, 'the domain conflict propagates to the overall')
summary = buildRobSummary(evaluation)
assert.equal(summary.rows[0].conflict, 1)
table = buildRobTable(evaluation)
assert.equal(table.rows[0].values[`${rob2Domains[0]}:risk_of_bias`], 'conflict')

const reconciled = [
  ...conflictEvents,
  {
    kind: 'reconcile', ts: new Date().toISOString(), record_id: 'r0001', instrument: instrumentRef,
    domain: rob2Domains[0], axis: 'risk_of_bias', judgement: 'low', reviewer: 'carol', reason: 'consensus',
  },
]
evaluation = evaluateInstrument({
  template: rob2, records, events: reconciled, includedIds: ['r0001'],
})
assert.equal(evaluation.records[0].status, 'complete')
assert.equal(evaluation.records[0].overall.value, 'low')
assert.equal(evaluation.conflicts.length, 0)
assert.equal(evaluation.records[0].cells[0].resolution.state, 'reconciled')

const reopened = [...reconciled, event(rob2Domains[0], 'high', 'bob')]
evaluation = evaluateInstrument({
  template: rob2, records, events: reopened, includedIds: ['r0001'],
})
assert.equal(evaluation.records[0].cells[0].resolution.state, 'reopened')
assert.equal(evaluation.records[0].status, 'conflict')
assert.equal(
  buildFigureRequest(evaluation).studies[0].cells[`${rob2Domains[0]}:risk_of_bias`].value,
  'conflict',
)

// Explicit overall overrides derivation and needs its own resolution
evaluation = evaluateInstrument({
  template: rob2, records, events: [...allLow, event('overall', 'high', 'alice')], includedIds: ['r0001'],
})
assert.equal(evaluation.records[0].overall.value, 'high')
assert.equal(evaluation.records[0].overall.derived, false)
assert.equal(evaluation.records[0].overall.source, 'explicit')

evaluation = evaluateInstrument({
  template: rob2, records, events: [...allLow, event('overall', 'high', 'alice'), event('overall', 'low', 'bob')], includedIds: ['r0001'],
})
assert.equal(evaluation.records[0].overall.state, 'conflict')

// Newcastle-Ottawa stars and total
const nos = byId['newcastle-ottawa']
const nosEvents = [
  { ...event('selection', 3), instrument: { id: 'newcastle-ottawa', version: '1' } },
  { ...event('comparability', 2), instrument: { id: 'newcastle-ottawa', version: '1' } },
  { ...event('outcome', 2), instrument: { id: 'newcastle-ottawa', version: '1' } },
]
evaluation = evaluateInstrument({
  template: nos, records, events: nosEvents, includedIds: ['r0001'],
})
assert.equal(evaluation.records[0].total_stars, 7)
assert.equal(evaluation.records[0].overall, null)
summary = buildRobSummary(evaluation)
assert.equal(summary.rows.at(-1).key, 'total_stars')
assert.equal(summary.rows.at(-1).counts['7'], 1)

// Figure request shape and caps
const request = buildFigureRequest(evaluation)
assert.equal(request.domains.length, 3)
assert.equal(request.studies.length, 1)
assert.ok(request.scale.some((value) => value.id === 'pending'))
assert.throws(() => buildFigureRequest(evaluation, nos, { maxStudies: 0 }), /at most 0 studies/)

// Persistence, reconciliation, status, and rob exports
const cwd = mkdtempSync(join(tmpdir(), 'ah-appraisal-'))
const slug = 'appraisal-review'
try {
  const started = await startReview({
    cwd,
    slug,
    protocol: { question: 'Is X better than Y?' },
    reviewers: ['alice', 'bob'],
    instruments: ['rob-2'],
  })
  assert.deepEqual(started.protocol.reviewers, ['human:alice', 'human:bob'])
  assert.deepEqual(started.protocol.instruments, [{ id: 'rob-2', version: '2019' }])
  assert.ok(existsSync(join(cwd, '.dsh', 'review', slug, 'instruments.json')))
  const registry = readInstruments(cwd, slug)
  assert.equal(registry.instruments.length, 1)
  assert.equal(registry.instruments[0].definition.domains.length, 5)
  await assert.rejects(
    () => startReview({ cwd, slug, instruments: ['quadas-2'], resume: true }),
    /instruments cannot be changed/,
  )

  await addRecords({
    cwd, slug, records: [{ title: 'Alpha trial', year: 2024 }, { title: 'Beta trial', year: 2023 }],
  })
  const includeBoth = async (id) => {
    for (const reviewer of ['alice', 'bob']) {
      await screenRecord({ cwd, slug, id, stage: 'title_abstract', decision: 'include', reviewer })
      await screenRecord({ cwd, slug, id, stage: 'full_text', decision: 'include', reviewer })
    }
  }
  await includeBoth('r0001')
  await includeBoth('r0002')

  const quote = 'Participants were randomised and allocation was concealed.'
  const appraise = (id, domain, judgement, reviewer, extra = {}) => appraiseRecord({
    cwd, slug, id, instrument: 'rob-2', domain, judgement, reviewer,
    quote, location: 'Methods, p. 1', ...extra,
  })
  await assert.rejects(
    () => appraiseRecord({
      cwd, slug, id: 'r0001', instrument: 'rob-2', domain: rob2Domains[0], judgement: 'low', reviewer: 'alice',
    }),
    /verbatim quote/,
  )
  for (const reviewer of ['alice', 'bob']) {
    for (const domain of rob2Domains) await appraise('r0001', domain, 'low', reviewer)
  }
  const firstAppraisal = await appraise('r0001', rob2Domains[0], 'low', 'alice', {
    override: true, reason: 're-read the methods', quoteCheck: { status: 'verified', via: 'papermemory_quote_check', detail: 'found' },
  })
  assert.equal(firstAppraisal.quote_check.status, 'verified')
  assert.ok(firstAppraisal.supersedes)
  await assert.rejects(
    () => appraise('r0001', rob2Domains[0], 'high', 'alice', { override: true }),
    /requires a reason/,
  )
  await assert.rejects(
    () => appraiseRecord({
      cwd, slug, id: 'r0001', instrument: 'rob-2', domain: 'overall', judgement: 'high', reviewer: 'alice', reason: '',
    }),
    /overall judgement requires a reason/,
  )
  await appraiseRecord({
    cwd, slug, id: 'r0001', instrument: 'rob-2', domain: 'overall', judgement: 'high', reviewer: 'alice', reason: 'small trial',
  })

  for (const domain of rob2Domains.slice(1)) await appraise('r0002', domain, 'low', 'alice')
  for (const domain of rob2Domains.slice(1)) await appraise('r0002', domain, 'low', 'bob')
  await appraise('r0002', rob2Domains[0], 'low', 'alice')
  await appraise('r0002', rob2Domains[0], 'high', 'bob')

  let status = deriveAppraisalStatus(cwd, slug)
  assert.equal(status.population, 2)
  assert.equal(status.instruments.length, 1)
  assert.equal(status.instruments[0].reviewers.length, 2)
  assert.equal(status.instruments[0].complete_records, 1)
  assert.equal(status.instruments[0].outstanding.conflicts.length, 1)
  assert.equal(status.instruments[0].outstanding.conflicts[0].record_id, 'r0002')

  let reconciled = await reconcileRecord({
    cwd, slug, scope: 'appraisal', id: 'r0002', instrument: 'rob-2', domain: rob2Domains[0], judgement: 'low',
    reviewer: 'carol', reason: 'consensus after discussion',
  })
  assert.equal(reconciled.resolution.state, 'reconciled')
  assert.equal(reconciled.resolution.value, 'low')
  assert.equal(reconciled.event.basis, 'third_reviewer')
  assert.equal(reconciled.event.supersedes.length, 2)
  status = deriveAppraisalStatus(cwd, slug)
  assert.equal(status.instruments[0].complete_records, 2)
  assert.equal(status.instruments[0].outstanding.conflicts.length, 0)

  await appraise('r0002', rob2Domains[0], 'high', 'bob', { override: true, reason: 'new information' })
  status = deriveAppraisalStatus(cwd, slug)
  assert.equal(status.instruments[0].outstanding.conflicts[0].state, 'reopened')
  reconciled = await reconcileRecord({
    cwd, slug, scope: 'appraisal', id: 'r0002', instrument: 'rob-2', domain: rob2Domains[0], judgement: 'high',
    reviewer: 'carol', reason: 'final consensus',
  })
  assert.equal(reconciled.resolution.value, 'high')

  const filtered = deriveAppraisalStatus(cwd, slug, { id: 'r0002' })
  assert.equal(filtered.population, 1)
  assert.equal(filtered.instruments[0].records[0].overall.value, 'high')
  assert.equal(filtered.instruments[0].records[0].overall.derived, true)
  const d1Cell = filtered.instruments[0].records[0].cells.find((cell) => cell.key === 'd1:risk_of_bias')
  assert.equal(d1Cell.reconcile.reviewer, 'human:carol')
  assert.equal(d1Cell.reconcile.value, 'high')

  const table = exportReview({ cwd, slug, format: 'rob-table' })
  const tableBody = readFileSync(join(cwd, table.path), 'utf8')
  assert.match(tableBody, /Risk-of-bias table — RoB 2 2019/)
  assert.match(tableBody, /high \(derived\)/)
  assert.match(tableBody, /\| Reviewers \| Reconciled by \| Unverified \| Status \|/)
  assert.match(tableBody, /human:alice/)
  assert.match(tableBody, /human:carol/)
  assert.doesNotMatch(tableBody, /compliant|low risk|high quality|ready for submission|guarantee/i)
  const tableCsv = exportReview({ cwd, slug, format: 'rob-table', table_format: 'csv' })
  const tableCsvBody = readFileSync(join(cwd, tableCsv.path), 'utf8')
  assert.match(tableCsvBody.split('\n')[0], /record_id,title,year,doi,d1:risk_of_bias/)
  assert.match(tableCsvBody.split('\n')[0], /reviewers,reconciled_by,unverified_quotes,status/)

  const summary = exportReview({ cwd, slug, format: 'rob-summary' })
  const summaryBody = readFileSync(join(cwd, summary.path), 'utf8')
  assert.match(summaryBody, /Overall risk of bias/)
  assert.doesNotMatch(summaryBody, /compliant|low risk|high quality|ready for submission|guarantee/i)
  const summaryCsv = exportReview({ cwd, slug, format: 'rob-summary', table_format: 'csv' })
  assert.match(readFileSync(join(cwd, summaryCsv.path), 'utf8'), /^key,label,domain,axis,/m)
  assert.throws(() => exportReview({ cwd, slug, format: 'rob-table' }), /already exists/)
  assert.throws(
    () => exportReview({ cwd, slug, format: 'rob-table', table_format: 'xlsx' }),
    /table_format/,
  )

  // Newcastle-Ottawa star total
  const nosSlug = 'nos-review'
  await startReview({
    cwd, slug: nosSlug, protocol: { question: 'Prognosis?' }, instruments: ['nos'],
  })
  await addRecords({ cwd, slug: nosSlug, records: [{ title: 'Cohort study', year: 2020 }] })
  await screenRecord({ cwd, slug: nosSlug, id: 'r0001', stage: 'title_abstract', decision: 'include' })
  await screenRecord({ cwd, slug: nosSlug, id: 'r0001', stage: 'full_text', decision: 'include' })
  for (const [domain, value] of [['selection', 3], ['comparability', 2], ['outcome', 2]]) {
    await appraiseRecord({
      cwd, slug: nosSlug, id: 'r0001', instrument: 'nos', domain, judgement: value, reviewer: 'alice',
    })
  }
  const nosStatus = deriveAppraisalStatus(cwd, nosSlug)
  assert.equal(nosStatus.instruments[0].records[0].total_stars, 7)
  const nosTable = exportReview({ cwd, slug: nosSlug, format: 'rob-table', table_format: 'csv' })
  const nosBody = readFileSync(join(cwd, nosTable.path), 'utf8')
  assert.match(nosBody.split('\n')[0], /total_stars/)
  assert.match(nosBody.split('\n')[1], /,7$/)
  const nosMarkdown = exportReview({ cwd, slug: nosSlug, format: 'rob-table' })
  assert.match(
    readFileSync(join(cwd, nosMarkdown.path), 'utf8'),
    /\| Total stars \| Reviewers \| Reconciled by \| Unverified \| Status \|/,
  )

  const zeroEvents = [
    { ...event('selection', 0), instrument: { id: 'newcastle-ottawa', version: '1' } },
    { ...event('comparability', 2), instrument: { id: 'newcastle-ottawa', version: '1' } },
    { ...event('outcome', 2), instrument: { id: 'newcastle-ottawa', version: '1' } },
  ]
  const zeroEvaluation = evaluateInstrument({
    template: nos, records, events: zeroEvents, includedIds: ['r0001'],
  })
  const zeroRequest = buildFigureRequest(zeroEvaluation)
  assert.equal(zeroRequest.studies[0].cells['selection:risk_of_bias'].value, 0)
  assert.match(zeroRequest.note, /Reviewers: human:alice/)

  // Phase 1E checklists: yes/no need a quote, can't tell does not; no overall.
  const caspSlug = 'casp-review'
  await startReview({ cwd, slug: caspSlug, protocol: { question: 'Cohort evidence?' }, instruments: ['casp-cohort'] })
  await addRecords({ cwd, slug: caspSlug, records: [{ title: 'Prospective cohort', year: 2019 }] })
  await screenRecord({ cwd, slug: caspSlug, id: 'r0001', stage: 'title_abstract', decision: 'include' })
  await screenRecord({ cwd, slug: caspSlug, id: 'r0001', stage: 'full_text', decision: 'include' })
  await assert.rejects(
    () => appraiseRecord({
      cwd, slug: caspSlug, id: 'r0001', instrument: 'casp-cohort', domain: 'focused_issue', judgement: 'yes', reviewer: 'alice',
    }),
    /verbatim quote/,
  )
  const caspDomains = byId['casp-cohort'].domains.map((domain) => domain.id)
  await appraiseRecord({
    cwd, slug: caspSlug, id: 'r0001', instrument: 'casp-cohort', domain: caspDomains[0], judgement: 'yes',
    reviewer: 'alice', quote, location: 'Methods',
  })
  await appraiseRecord({
    cwd, slug: caspSlug, id: 'r0001', instrument: 'casp-cohort', domain: caspDomains[1], judgement: "can't tell", reviewer: 'alice',
  })
  for (const domain of caspDomains.slice(2)) {
    await appraiseRecord({
      cwd, slug: caspSlug, id: 'r0001', instrument: 'casp-cohort', domain, judgement: 'no',
      reviewer: 'alice', quote, location: 'Methods',
    })
  }
  const caspStatus = deriveAppraisalStatus(cwd, caspSlug)
  assert.equal(caspStatus.instruments[0].complete_records, 1)
  assert.equal(caspStatus.instruments[0].records[0].cells.length, 9)
  assert.equal(caspStatus.instruments[0].records[0].overall, null)

  // PROBAST carries risk-of-bias and applicability cells like QUADAS-2.
  const probastSlug = 'probast-review'
  await startReview({ cwd, slug: probastSlug, protocol: { question: 'Prediction model?' }, instruments: ['probast'] })
  await addRecords({ cwd, slug: probastSlug, records: [{ title: 'Model study', year: 2021 }] })
  await screenRecord({ cwd, slug: probastSlug, id: 'r0001', stage: 'title_abstract', decision: 'include' })
  await screenRecord({ cwd, slug: probastSlug, id: 'r0001', stage: 'full_text', decision: 'include' })
  await appraiseRecord({
    cwd, slug: probastSlug, id: 'r0001', instrument: 'probast', domain: 'patient_selection',
    axis: 'risk_of_bias', judgement: 'low', reviewer: 'alice', quote, location: 'Methods',
  })
  await appraiseRecord({
    cwd, slug: probastSlug, id: 'r0001', instrument: 'probast', domain: 'patient_selection',
    axis: 'applicability', judgement: 'high', reviewer: 'alice', quote, location: 'Methods',
  })
  const probastStatus = deriveAppraisalStatus(cwd, probastSlug)
  assert.equal(probastStatus.instruments[0].records[0].cells.length, 7)
  const probastApplicability = probastStatus.instruments[0].records[0].cells
    .find((cell) => cell.key === 'patient_selection:applicability')
  assert.equal(probastApplicability.state, 'single')
  assert.equal(probastApplicability.value, 'high')

  // A declared roster is the appraisal panel: a single appraiser is incomplete.
  const rosterSlug = 'roster-review'
  await startReview({
    cwd,
    slug: rosterSlug,
    protocol: { question: 'Roster completeness?' },
    reviewers: ['alice', 'bob'],
    instruments: ['rob-2'],
  })
  await addRecords({ cwd, slug: rosterSlug, records: [{ title: 'Roster trial', year: 2021 }] })
  for (const reviewer of ['alice', 'bob']) {
    await screenRecord({ cwd, slug: rosterSlug, id: 'r0001', stage: 'title_abstract', decision: 'include', reviewer })
    await screenRecord({ cwd, slug: rosterSlug, id: 'r0001', stage: 'full_text', decision: 'include', reviewer })
  }
  for (const domain of rob2Domains) {
    await appraiseRecord({
      cwd, slug: rosterSlug, id: 'r0001', instrument: 'rob-2', domain, judgement: 'low', reviewer: 'alice', quote, location: 'Methods, p. 1',
    })
  }
  let rosterStatus = deriveAppraisalStatus(cwd, rosterSlug)
  assert.equal(rosterStatus.instruments[0].complete_records, 0)
  assert.ok(rosterStatus.instruments[0].outstanding.missing.some(
    (row) => row.missing_reviewers.includes('human:bob'),
  ))
  for (const domain of rob2Domains) {
    await appraiseRecord({
      cwd, slug: rosterSlug, id: 'r0001', instrument: 'rob-2', domain, judgement: 'low', reviewer: 'bob', quote, location: 'Methods, p. 1',
    })
  }
  rosterStatus = deriveAppraisalStatus(cwd, rosterSlug)
  assert.equal(rosterStatus.instruments[0].complete_records, 1)

  // The frozen definition is authoritative even if the bundled template changes.
  const frozenSlug = 'frozen-review'
  await startReview({ cwd, slug: frozenSlug, protocol: { question: 'Frozen?' }, instruments: ['rob-2'] })
  const frozenFile = join(cwd, '.dsh', 'review', frozenSlug, 'instruments.json')
  const frozenRegistry = JSON.parse(readFileSync(frozenFile, 'utf8'))
  frozenRegistry.instruments[0].definition.domains = frozenRegistry.instruments[0].definition.domains
    .filter((domain) => domain.id !== 'd5')
  writeFileSync(frozenFile, JSON.stringify(frozenRegistry))
  assert.equal(frozenInstrument(cwd, frozenSlug, 'rob-2').domains.length, 4)
  await addRecords({ cwd, slug: frozenSlug, records: [{ title: 'Frozen trial', year: 2022 }] })
  await screenRecord({ cwd, slug: frozenSlug, id: 'r0001', stage: 'title_abstract', decision: 'include' })
  await screenRecord({ cwd, slug: frozenSlug, id: 'r0001', stage: 'full_text', decision: 'include' })
  await assert.rejects(
    () => appraiseRecord({
      cwd, slug: frozenSlug, id: 'r0001', instrument: 'rob-2', domain: 'd5', judgement: 'low', reviewer: 'alice', quote, location: 'Methods',
    }),
    /domain "d5" is not in RoB 2/,
  )

  // Tool-level quote verification and figure export
  const exec = { agent: { session: { header: { cwd } } } }
  await assert.rejects(
    () => runReview({
      action: 'appraise', slug, id: 'r0001', instrument: 'rob-2', domain: 'd1', judgement: 'low', reviewer: '',
    }, exec),
    /reviewer is required/,
  )
  const beforeReject = readJsonl(cwd, slug, 'appraisal').length
  const rejected = await runReview({
    action: 'appraise', slug, id: 'r0001', instrument: 'rob-2', domain: 'd4', judgement: 'high',
    reviewer: 'alice', quote: 'not in the paper', location: 'Results', paper: 'paper-1',
  }, exec, { verifyQuote: async () => ({ found: false, reason: 'no-match', checked_against: { sha256: 'abc' } }) })
  assert.match(rejected.error, /not found in PaperMemory/)
  assert.equal(readJsonl(cwd, slug, 'appraisal').length, beforeReject)

  const unresolvedPaper = await runReview({
    action: 'appraise', slug, id: 'r0001', instrument: 'rob-2', domain: 'd4', judgement: 'high',
    reviewer: 'alice', quote: 'A real quote from the paper.', location: 'Results', paper: 'missing-paper',
    override: true, reason: 're-read',
  }, exec, { verifyQuote: async () => ({ found: false, reason: 'no-match', checked_against: { sha256: null } }) })
  assert.equal(unresolvedPaper.event.quote_check.status, 'unverified')
  assert.match(unresolvedPaper.event.quote_check.detail, /could not resolve/)

  const oddResult = await runReview({
    action: 'appraise', slug, id: 'r0001', instrument: 'rob-2', domain: 'd4', judgement: 'high',
    reviewer: 'alice', quote: 'A real quote from the paper.', location: 'Results', paper: 'paper-1',
    override: true, reason: 're-read',
  }, exec, { verifyQuote: async () => ({ error: 'schema drift' }) })
  assert.equal(oddResult.event.quote_check.status, 'unverified')
  assert.match(oddResult.event.quote_check.detail, /unexpected result/)

  const verified = await runReview({
    action: 'appraise', slug, id: 'r0001', instrument: 'rob-2', domain: 'd4', judgement: 'high',
    reviewer: 'alice', quote: 'A real quote from the paper.', location: 'Results', paper: 'paper-1',
    override: true, reason: 're-read',
  }, exec, {
    verifyQuote: async () => ({
      found: true, occurrences: [{ is_bibliography: 0 }], checked_against: { sha256: 'abc' },
    }),
  })
  assert.equal(verified.event.quote_check.status, 'verified')

  const bibliography = await runReview({
    action: 'appraise', slug, id: 'r0001', instrument: 'rob-2', domain: 'd4', judgement: 'high',
    reviewer: 'alice', quote: 'A reference title.', location: 'References', paper: 'paper-1',
  }, exec, {
    verifyQuote: async () => ({
      found: true, reason: 'bibliography-only', occurrences: [{ is_bibliography: 1 }], checked_against: { sha256: 'abc' },
    }),
  })
  assert.match(bibliography.error, /only occurs in the bibliography/)

  const unverified = await runReview({
    action: 'appraise', slug, id: 'r0001', instrument: 'rob-2', domain: 'd4', judgement: 'high',
    reviewer: 'alice', quote: 'A real quote from the paper.', location: 'Results', paper: 'paper-1',
    override: true, reason: 're-read',
  }, exec, { verifyQuote: async () => { throw new Error('PaperMemory exited 1') } })
  assert.equal(unverified.event.quote_check.status, 'unverified')
  assert.match(unverified.event.quote_check.detail, /quote check failed/)

  const fakeHelper = (script, request) => {
    assert.equal(script, 'rob_figure.py')
    assert.equal(request.studies.length, 2)
    assert.ok(request.domains.length >= 6)
    assert.match(request.note, /Reviewers:/)
    assert.match(request.note, /Unverified quotes:/)
    return {
      svg: {
        traffic: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        summary: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      },
      studies: request.studies.length,
      domains: request.domains.length,
      warnings: [],
    }
  }
  const figure = await runReview({ action: 'export', slug, format: 'rob-figure' }, exec, { runHelper: fakeHelper })
  assert.equal(figure.files.length, 2)
  for (const file of figure.files) assert.ok(existsSync(join(cwd, file.path)))
  rmSync(join(cwd, figure.files[0].path))
  await assert.rejects(
    () => runReview({ action: 'export', slug, format: 'rob-figure' }, exec, { runHelper: fakeHelper }),
    /already exists/,
  )
  assert.ok(existsSync(join(cwd, figure.files[1].path)), 'one existing target blocks both writes')
  assert.equal(existsSync(join(cwd, figure.files[0].path)), false, 'the missing target is not written when the other exists')
  await assert.rejects(
    () => runReview({ action: 'export', slug, format: 'rob-figure', overwrite: true }, exec, {
      runHelper: () => ({ error: 'matplotlib is not installed', code: 'matplotlib_missing' }),
    }),
    /needs matplotlib/,
  )
  await assert.rejects(
    () => runReview({ action: 'export', slug, format: 'rob-figure', overwrite: true }, exec, {
      runHelper: () => ({ svg: { traffic: `<svg>${'x'.repeat(9 * 1024 * 1024)}</svg>`, summary: '<svg></svg>' } }),
    }),
    /larger than 8MB/,
  )

  const probe = runHelper('rob_figure.py', {
    title: 'probe',
    panels: ['traffic'],
    domains: [{ id: 'd1', label: 'D1' }],
    scale: [{ id: 'low', label: 'Low', color: '#2e7d32', symbol: '+' }],
    studies: [{ id: 'r1', label: 'S', cells: { d1: { value: 'low' } } }],
  })
  if (probe?.error || probe?.code) console.log(`skip: rob_figure helper unavailable (${probe.error || probe.code})`)
  else assert.ok(probe.svg.traffic.includes('<svg'))
} finally {
  rmSync(cwd, { recursive: true, force: true })
}

console.log('appraisal OK')
