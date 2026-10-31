import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { addRecords, screenRecord, startReview } from '../review-store.js'
import { runReview } from '../review.js'
import { runHelper } from '../python-runtime.js'
import { fakeExec, makeWorkspace } from './helpers/test-workspace.mjs'

const workspace = makeWorkspace('ah-prisma-flow-')
const cwd = workspace.cwd
const exec = fakeExec(cwd)
const slug = 'prisma-demo'

try {
  await startReview({
    cwd,
    slug,
    protocol: { question: 'Does X improve Y?', databases: ['OpenAlex', 'PubMed'] },
  })
  await addRecords({
    cwd,
    slug,
    records: [
      { title: 'Alpha trial', year: 2024 },
      { title: 'Beta trial', year: 2023 },
      { title: 'Alpha trial', year: 2024 },
    ],
  })
  await screenRecord({ cwd, slug, id: 'r0001', stage: 'title_abstract', decision: 'include', reviewer: 'alice' })
  await screenRecord({ cwd, slug, id: 'r0001', stage: 'full_text', decision: 'include', reviewer: 'alice' })
  await screenRecord({
    cwd, slug, id: 'r0002', stage: 'title_abstract', decision: 'exclude', reason: 'wrong population', reviewer: 'alice',
  })

  let seenRequest = null
  const fakeHelper = (script, request) => {
    assert.equal(script, 'prisma_flow.py')
    seenRequest = request
    assert.equal(request.records_total, 2)
    assert.equal(request.search.added, 2)
    assert.equal(request.search.skipped, 1)
    assert.deepEqual(request.databases, ['OpenAlex', 'PubMed'])
    assert.equal(request.screening.title_abstract.include, 1)
    assert.equal(request.screening.title_abstract.exclude, 1)
    assert.equal(request.screening.full_text.include, 1)
    assert.equal(request.included.length, 1)
    assert.match(request.ledger_hash, /^sha256:[0-9a-f]{64}$/)
    return {
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>PRISMA</text></svg>',
      counts: {
        identified: 3,
        duplicates_removed: 1,
        screened: 2,
        title_excluded: 1,
        full_text_assessed: 1,
        full_text_excluded: 0,
        included: 1,
        maybe_pending: 0,
        conflicts: 0,
      },
      warnings: ['test warning'],
    }
  }

  const exported = await runReview(
    { action: 'export', slug, format: 'prisma-flow' },
    exec,
    { runHelper: fakeHelper },
  )
  assert.equal(exported.action, 'export')
  assert.equal(exported.format, 'prisma-flow')
  assert.equal(exported.files.length, 2)
  assert.equal(exported.counts.included, 1)
  assert.deepEqual(exported.warnings, ['test warning'])
  assert.ok(seenRequest)

  const svgFile = join(cwd, '.dsh', 'review', slug, 'exports', 'prisma-flow.svg')
  const jsonFile = join(cwd, '.dsh', 'review', slug, 'exports', 'prisma-flow.json')
  assert.ok(existsSync(svgFile))
  assert.ok(existsSync(jsonFile))
  assert.match(readFileSync(svgFile, 'utf8'), /<svg/)
  const sidecar = JSON.parse(readFileSync(jsonFile, 'utf8'))
  assert.equal(sidecar.counts.included, 1)
  assert.deepEqual(sidecar.warnings, ['test warning'])
  assert.match(sidecar.svg_sha256, /^sha256:[0-9a-f]{64}$/)
  assert.equal(sidecar.records_total, 2)

  await assert.rejects(
    () => runReview({ action: 'export', slug, format: 'prisma-flow' }, exec, { runHelper: fakeHelper }),
    /already exists/,
  )

  // The real helper is stdlib-only; exercise it when Python is available.
  const request = {
    slug: 'helper-demo',
    question: 'Does X improve Y?',
    generated_at: '2026-01-01T00:00:00Z',
    databases: ['OpenAlex'],
    search: { queries: 1, added: 3, skipped: 1 },
    records_total: 2,
    screening: {
      title_abstract: { include: 1, exclude: 1, maybe: 0, pending: 0, conflict: 0 },
      full_text: { include: 1, exclude: 0, maybe: 0, pending: 0, conflict: 0, not_eligible: 0 },
    },
    included: ['r0001'],
    exclusion_reasons: [{ stage: 'title_abstract', reason: 'wrong population', count: 1 }],
    ledger_hash: 'sha256:abc',
  }
  const actual = runHelper('prisma_flow.py', request)
  if (actual.error) {
    console.log(`prisma-flow helper skipped: ${actual.error}`)
  } else {
    assert.match(actual.svg, /<svg/)
    assert.match(actual.svg, /Records identified \(n = 4\)/)
    assert.match(actual.svg, /Studies included \(n = 1\)/)
    assert.match(actual.svg, /wrong population/)
    assert.equal(actual.counts.identified, 4)
    assert.equal(actual.counts.duplicates_removed, 1)
    assert.equal(actual.counts.screened, 2)
    assert.equal(actual.counts.title_excluded, 1)
    assert.equal(actual.counts.full_text_assessed, 1)
    assert.equal(actual.counts.included, 1)
    assert.deepEqual(actual.warnings, [])
  }

  const missing = runHelper('prisma_flow.py', {
    slug: 'missing-demo',
    question: '',
    databases: [],
    search: {},
    records_total: null,
    screening: { title_abstract: {}, full_text: {} },
    included: [],
    exclusion_reasons: [],
  })
  if (!missing.error) {
    assert.match(missing.svg, /not recorded/)
    assert.ok(missing.warnings.some((warning) => /records identified is not recorded/.test(warning)))
    assert.ok(missing.warnings.some((warning) => /no databases are recorded/.test(warning)))
  }

  console.log('prisma-flow OK')
} finally {
  workspace.cleanup()
}
