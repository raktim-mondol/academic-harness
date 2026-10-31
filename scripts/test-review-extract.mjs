import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addExtraction, addRecords, deriveExtractionStatus, exportReview, freezeExtractionTemplate,
  normalizeExtractionTemplate, readExtractionTemplate, readJsonl, readProtocol, screenRecord,
  startReview,
} from '../review-store.js'
import { apply, runReview as runReviewDirect } from '../review.js'
import { fakeExec, makeWorkspace } from './helpers/test-workspace.mjs'

const workspace = makeWorkspace('ah-review-extract-')
const cwd = workspace.cwd
const exec = fakeExec(cwd)
let tool
apply({ tools: { register: (registered) => { tool = registered } } })
const run = (args) => tool.execute(args, exec)
const verified = async () => ({
  found: true,
  occurrences: [{ is_bibliography: 0 }],
  checked_against: { sha256: 'abc123' },
})
const absent = async () => ({
  found: false,
  checked_against: { sha256: 'abc123' },
  reason: 'not-found',
})

async function includeRecord(slug, id, reviewers) {
  for (const reviewer of reviewers) {
    await screenRecord({ cwd, slug, id, stage: 'title_abstract', decision: 'include', reviewer })
    await screenRecord({ cwd, slug, id, stage: 'full_text', decision: 'include', reviewer })
  }
}

try {
  const inline = normalizeExtractionTemplate({
    id: 'custom',
    name: 'Custom extraction',
    fields: [
      { id: 'exposure', label: 'Exposure', type: 'text', required: true },
      { id: 'n', label: 'N', type: 'integer', required: true },
    ],
  })
  assert.equal(inline.id, 'custom')
  assert.equal(inline.fields[0].id, 'exposure')
  assert.equal(inline.fields[0].required, true)
  assert.match(inline.fingerprint, /^[0-9a-f]{64}$/)
  assert.throws(
    () => normalizeExtractionTemplate({ id: 'bad', fields: [] }),
    /non-empty fields/,
  )
  assert.throws(
    () => normalizeExtractionTemplate({ id: 'bad', fields: [{ id: 'choice', type: 'enum' }] }),
    /has no options/,
  )

  const toolStart = await run({
    action: 'start',
    slug: 'extract-tool-start',
    question: 'Tool start with a template?',
    extraction_template: 'generic',
  })
  assert.equal(toolStart.action, 'start')
  assert.equal(toolStart.protocol.extraction_template.id, 'generic')
  const inlineStart = await run({
    action: 'start',
    slug: 'extract-inline-start',
    question: 'Inline template?',
    extraction_template: {
      id: 'inline-demo',
      name: 'Inline demo',
      fields: [{ id: 'exposure', label: 'Exposure', type: 'text', required: true }],
    },
  })
  assert.equal(inlineStart.protocol.extraction_template.id, 'inline-demo')

  // Dual-review extraction with a built-in PICO template.
  const slug = 'extract-dual'
  const started = await startReview({
    cwd,
    slug,
    protocol: { question: 'Does X improve Y?' },
    reviewers: ['alice', 'bob'],
    extractionTemplate: 'pico',
  })
  assert.equal(started.protocol.extraction_template.id, 'pico')
  const template = readExtractionTemplate(cwd, slug)
  assert.equal(template.source, 'builtin:pico')
  assert.ok(template.fields.some((field) => field.id === 'effect_measure'), 'field ids preserve underscores')
  assert.ok(template.fingerprint)
  assert.ok(existsSync(join(cwd, '.dsh', 'review', slug, 'extraction_template.json')))

  await addRecords({
    cwd,
    slug,
    records: [
      { doi: '10.1000/extract-a', title: 'Alpha extraction trial', year: 2024 },
      { doi: '10.1000/extract-b', title: 'Beta extraction trial', year: 2023 },
    ],
  })
  await includeRecord(slug, 'r0001', ['alice', 'bob'])
  await screenRecord({
    cwd, slug, id: 'r0002', stage: 'title_abstract', decision: 'exclude', reason: 'wrong population', reviewer: 'alice',
  })
  await screenRecord({
    cwd, slug, id: 'r0002', stage: 'title_abstract', decision: 'exclude', reason: 'wrong population', reviewer: 'bob',
  })

  await assert.rejects(
    () => startReview({ cwd, slug, extractionTemplate: 'generic', resume: true }),
    /already frozen/,
  )
  assert.throws(
    () => freezeExtractionTemplate(cwd, slug, { id: 'custom', fields: [{ id: 'x', label: 'X', type: 'text' }] }),
    /already frozen/,
  )

  let result = await run({
    action: 'extract',
    slug,
    id: 'r0001',
    reviewer: 'carol',
    values: { population: 'Adults' },
  })
  assert.match(result.error, /not in the declared list/)

  result = await run({
    action: 'extract',
    slug,
    id: 'r0002',
    reviewer: 'alice',
    values: { population: 'Adults', n: 10 },
  })
  assert.match(result.error, /full_text include/)

  result = await run({
    action: 'extract',
    slug,
    id: 'r0001',
    reviewer: 'alice',
    values: { population: 'Adults', n: 10, nonsense: 'x' },
  })
  assert.match(result.error, /unknown extraction field/)

  result = await run({
    action: 'extract',
    slug,
    id: 'r0001',
    reviewer: 'alice',
    values: { population: 'Adults', design: 'not-a-design' },
  })
  assert.match(result.error, /must be one of RCT/)

  await assert.rejects(
    () => run({
      action: 'extract',
      slug,
      id: 'r0001',
      reviewer: 'alice',
      values: { population: 'Adults' },
      quotes: [],
    }),
    /"quotes" must be an object/,
  )

  result = await run({
    action: 'extract',
    slug,
    id: 'r0001',
    reviewer: 'alice',
    values: { population: 'Adults', n: 'not-a-number' },
  })
  assert.match(result.error, /must be a finite number/)

  // Use the direct runner with an injected verifier; the tool wrapper does not
  // forward deps, so this is the same path the appraise tests use.
  const direct = (args, deps = {}) => runReviewDirect(args, exec, deps)
  let event = await direct({
    action: 'extract',
    slug,
    id: 'r0001',
    reviewer: 'alice',
    values: {
      population: 'Adults', intervention: 'X', comparator: 'Placebo', outcome: 'Y',
      design: 'RCT', n: 100, effect: 0.5, effect_measure: 'MD',
    },
    quotes: { effect: { quote: 'MD 0.50', location: 'Results, p. 4' } },
    paper: 'pm:alpha',
  }, { verifyQuote: verified })
  assert.equal(event.extraction_id, 'x0001')
  assert.equal(event.event_id, 'x0001')
  assert.equal(event.row_id, 'main')
  assert.equal(event.reviewer, 'human:alice')
  assert.equal(event.quote_check.status, 'verified')
  assert.equal(event.quote_check.verified, 1)
  assert.equal(event.quote_checks.effect.status, 'verified')

  let status = deriveExtractionStatus(cwd, slug)
  assert.equal(status.population, 1)
  assert.equal(status.rows.length, 1)
  assert.equal(status.rows[0].status, 'incomplete')
  assert.deepEqual(status.rows[0].missing_required, [])
  assert.deepEqual(status.rows[0].missing_reviewers, ['human:bob'])
  assert.equal(status.summary.quote_checks.verified, 1)

  event = await direct({
    action: 'extract',
    slug,
    id: 'r0001',
    reviewer: 'bob',
    values: {
      population: 'Adults', intervention: 'X', comparator: 'Placebo', outcome: 'Y',
      design: 'RCT', n: 120, effect: 0.7, effect_measure: 'MD',
    },
    quotes: { effect: { quote: 'MD 0.70', location: 'Results, p. 5' } },
    paper: 'pm:alpha',
  }, { verifyQuote: verified })
  assert.equal(event.extraction_id, 'x0002')

  status = deriveExtractionStatus(cwd, slug)
  assert.equal(status.rows[0].status, 'conflict')
  assert.ok(status.conflicts.some((conflict) => conflict.field === 'n'))
  assert.ok(status.conflicts.some((conflict) => conflict.field === 'effect'))
  assert.equal(status.rows[0].fields.n.state, 'conflict')

  await assert.rejects(
    () => direct({
      action: 'reconcile', slug, scope: 'extraction', id: 'r0001', field: 'n', value: 110, reviewer: 'alice',
    }),
    /reconcile requires a reason/,
  )
  await assert.rejects(
    () => direct({
      action: 'reconcile', slug, scope: 'extraction', id: 'r0001', field: 'missing_field', value: 110,
      reviewer: 'alice', reason: 'consensus',
    }),
    /not in the extraction template/,
  )

  result = await direct({
    action: 'reconcile', slug, scope: 'extraction', id: 'r0001', field: 'n', value: 110,
    reviewer: 'alice', reason: 'consensus after discussion',
  })
  assert.equal(result.scope, 'extraction')
  assert.equal(result.resolution.state, 'reconciled')
  assert.equal(result.resolution.value, 110)
  assert.equal(result.event.basis, 'consensus')
  assert.ok(result.event.supersedes.length >= 2)

  result = await direct({
    action: 'reconcile', slug, scope: 'extraction', id: 'r0001', field: 'effect', value: 0.6,
    reviewer: 'bob', reason: 'converted to the common MD scale',
  })
  assert.equal(result.resolution.state, 'reconciled')
  assert.equal(result.resolution.value, 0.6)

  status = deriveExtractionStatus(cwd, slug)
  assert.equal(status.rows[0].status, 'complete')
  assert.equal(status.summary.complete_rows, 1)
  assert.equal(status.conflicts.length, 0)

  // Multiple outcomes/arms are separate rows, not overwrites.
  for (const reviewer of ['alice', 'bob']) {
    event = await direct({
      action: 'extract',
      slug,
      id: 'r0001',
      reviewer,
      row_id: 'outcome-2',
      values: {
        population: 'Adults', intervention: 'X', comparator: 'Placebo', outcome: 'Y at 12 months',
        design: 'RCT', n: 110, effect: 0.4, effect_measure: 'MD',
      },
    })
    assert.equal(event.row_id, 'outcome-2')
  }
  status = deriveExtractionStatus(cwd, slug)
  assert.equal(status.rows.length, 2)
  assert.deepEqual(status.rows.map((row) => row.row_id).sort(), ['main', 'outcome-2'])
  assert.equal(status.summary.complete_rows, 2)

  // Override semantics: a repeat by the same reviewer needs a reason and keeps the original.
  result = await run({
    action: 'extract', slug, id: 'r0001', reviewer: 'alice',
    values: { population: 'Adults', n: 111 },
  })
  assert.match(result.error, /already has an extraction/)
  const before = readJsonl(cwd, slug, 'extractions').length
  result = await direct({
    action: 'extract', slug, id: 'r0001', reviewer: 'alice', override: true,
    values: { population: 'Adults', n: 111 }, reason: 'corrected after re-reading the table',
  })
  assert.equal(result.override, true)
  assert.equal(readJsonl(cwd, slug, 'extractions').length, before + 1)

  // Quote rejection and unverified quote handling.
  const quoteSlug = 'extract-quotes'
  await startReview({
    cwd, slug: quoteSlug, protocol: { question: 'Quote handling?' }, extractionTemplate: 'pico',
  })
  await addRecords({ cwd, slug: quoteSlug, records: [{ title: 'Quote study', year: 2024 }] })
  await screenRecord({
    cwd, slug: quoteSlug, id: 'r0001', stage: 'title_abstract', decision: 'include', reviewer: 'alice',
  })
  await screenRecord({
    cwd, slug: quoteSlug, id: 'r0001', stage: 'full_text', decision: 'include', reviewer: 'alice',
  })
  result = await direct({
    action: 'extract', slug: quoteSlug, id: 'r0001', reviewer: 'alice',
    values: { population: 'Adults', intervention: 'X', comparator: 'P', outcome: 'Y', design: 'RCT', n: 50 },
    quotes: { effect: { quote: 'absent quote', location: 'Results' } },
    paper: 'pm:absent',
  }, { verifyQuote: absent })
  assert.match(result.error, /not found in PaperMemory paper/)

  result = await direct({
    action: 'extract', slug: quoteSlug, id: 'r0001', reviewer: 'alice',
    values: { population: 'Adults', intervention: 'X', comparator: 'P', outcome: 'Y', design: 'RCT', n: 50 },
    quotes: { effect: { quote: 'MD 0.2', location: 'Results' } },
  })
  assert.equal(result.quote_check.status, 'unverified')
  assert.equal(readJsonl(cwd, quoteSlug, 'extractions').length, 1)

  // A review started without a template can freeze one on first extract.
  const lateSlug = 'extract-late'
  await startReview({ cwd, slug: lateSlug, protocol: { question: 'Late template?' } })
  await addRecords({ cwd, slug: lateSlug, records: [{ title: 'Late study', year: 2024 }] })
  await screenRecord({
    cwd, slug: lateSlug, id: 'r0001', stage: 'title_abstract', decision: 'include', reviewer: 'alice',
  })
  await screenRecord({
    cwd, slug: lateSlug, id: 'r0001', stage: 'full_text', decision: 'include', reviewer: 'alice',
  })
  result = await run({
    action: 'extract', slug: lateSlug, id: 'r0001', reviewer: 'alice',
    values: { population: 'Adults' },
  })
  assert.match(result.error, /no extraction template/)
  result = await direct({
    action: 'extract', slug: lateSlug, id: 'r0001', reviewer: 'alice', extraction_template: 'generic',
    values: {
      study_design: 'RCT', population: 'Adults', intervention_or_exposure: 'X',
      outcomes: 'Y', n: 30,
    },
  })
  assert.equal(result.template.id, 'generic')
  assert.equal(readProtocol(cwd, lateSlug).extraction_template.id, 'generic')
  status = deriveExtractionStatus(cwd, lateSlug)
  assert.equal(status.template.id, 'generic')
  assert.equal(status.rows[0].status, 'complete')

  // A single-reviewer extraction missing required fields lists exactly those fields.
  const partialSlug = 'extract-partial'
  await startReview({ cwd, slug: partialSlug, protocol: { question: 'Partial?' }, extractionTemplate: 'pico' })
  await addRecords({ cwd, slug: partialSlug, records: [{ title: 'Partial study', year: 2024 }] })
  await screenRecord({ cwd, slug: partialSlug, id: 'r0001', stage: 'title_abstract', decision: 'include', reviewer: 'alice' })
  await screenRecord({ cwd, slug: partialSlug, id: 'r0001', stage: 'full_text', decision: 'include', reviewer: 'alice' })
  await direct({
    action: 'extract', slug: partialSlug, id: 'r0001', reviewer: 'alice', values: { population: 'Adults' },
  })
  status = deriveExtractionStatus(cwd, partialSlug)
  assert.equal(status.rows[0].status, 'incomplete')
  assert.deepEqual(status.rows[0].missing_required.sort(), ['comparator', 'design', 'intervention', 'n', 'outcome'])
  assert.deepEqual(status.rows[0].missing_reviewers, [])

  // Exports.
  const table = exportReview({ cwd, slug, format: 'extraction-table', table_format: 'markdown' })
  assert.match(table.path, /extraction-table\.md$/)
  const tableBody = readFileSync(join(cwd, table.path), 'utf8')
  assert.match(tableBody, /Extracted data/)
  assert.match(tableBody, /Adults/)
  assert.match(tableBody, /outcome-2/)
  assert.throws(
    () => exportReview({ cwd, slug, format: 'extraction-table' }),
    /already exists/,
  )
  const csv = exportReview({ cwd, slug, format: 'extraction-table', table_format: 'csv' })
  assert.match(readFileSync(join(cwd, csv.path), 'utf8'), /record_id,title,year,doi,row_id,population/)
  const matrix = exportReview({ cwd, slug, format: 'extraction-matrix', table_format: 'markdown' })
  assert.match(matrix.path, /extraction-matrix\.md$/)
  const extractedJson = exportReview({ cwd, slug, format: 'extraction-json' })
  const parsed = JSON.parse(readFileSync(join(cwd, extractedJson.path), 'utf8'))
  assert.equal(parsed.template.id, 'pico')
  assert.equal(parsed.status.summary.complete_rows, 1)
  assert.ok(parsed.status.summary.conflict_rows >= 1)
  assert.ok(parsed.events.length >= 6)
  const markdown = exportReview({ cwd, slug, format: 'markdown' })
  assert.match(readFileSync(join(cwd, markdown.path), 'utf8'), /## Extracted data/)
  const json = exportReview({ cwd, slug, format: 'json' })
  const reviewJson = JSON.parse(readFileSync(join(cwd, json.path), 'utf8'))
  assert.equal(reviewJson.extraction.template.id, 'pico')
  assert.ok(reviewJson.extraction.events.length >= 6)

  // A review with no template reports a useful status rather than failing.
  const noTemplate = 'extract-none'
  await startReview({ cwd, slug: noTemplate, protocol: { question: 'No template yet?' } })
  const none = deriveExtractionStatus(cwd, noTemplate)
  assert.equal(none.template, null)
  assert.match(none.note, /No extraction template/)

  console.log('review extraction OK')
} finally {
  workspace.cleanup()
}
