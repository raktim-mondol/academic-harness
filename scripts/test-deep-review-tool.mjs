import assert from 'node:assert/strict'
import {
  appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, startLlmBridge } from '../deep-review.js'

const FAKE_ENGINE = String.raw`
import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
writeFileSync(process.cwd() + '/.fake-argv.json', JSON.stringify(args))
writeFileSync(process.cwd() + '/.fake-env.json', JSON.stringify({
  deepreview: process.env.DEEPREVIEW_API_KEY ?? null,
  openai: process.env.OPENAI_API_KEY ?? null,
  genericSecret: process.env.GITHUB_TOKEN ?? null,
}))
const cmd = args[0]
const out = (value) => console.log(JSON.stringify(value))
const review = {
  name: 'documents/doc1234567890ab/reviews/rev-0001',
  state: 'SUCCEEDED',
  createTime: new Date().toISOString(),
  runConfig: { model: 'fake-model', baseUrl: 'https://example.invalid/v1', topology: 'MID' },
  result: {
    reviewMarkdown: '# Review\n\n' + 'A'.repeat(1200),
    anchoredComments: [
      {
        commentId: 'c1',
        severity: 'CRITICAL',
        summary: 'Unsupported causal claim',
        bodyMarkdown: 'The paper claims X causes Y without an intervention.',
        suggestedEdit: 'Soften to an association.',
        location: { pdf: { pageNumber: 3, quoteSelector: { exact: 'X causes Y' } } },
      },
      {
        commentId: 'c2',
        severity: 'MAJOR',
        summary: 'Missing baseline',
        bodyMarkdown: 'No comparison against the standard baseline.',
        location: { text: { firstLine: 12, lastLine: 14, quotedLinePreview: 'baseline missing' } },
      },
      { commentId: 'c3', severity: 'MINOR', summary: 'Typo in section 2', bodyMarkdown: 'Typo.' },
      {
        commentId: 'c4',
        severity: 'MAJOR',
        summary: 'Reference [4] not found',
        bodyMarkdown: 'The reference could not be located.',
        citationReport: {
          refNum: 4,
          rawReference: 'Doe et al. 2019',
          finalVerdict: 'NOT_FOUND',
          fieldComparisons: [{ fieldKey: 'title', match: false, detail: 'no match' }],
        },
      },
    ],
    contributionType: 'EMPIRICAL_ML',
    claimEvidenceMap: [{
      claimId: 'cl1',
      claim: 'The method improves accuracy',
      page: 5,
      evidenceLocation: 'Table 2',
      evidenceType: 'EXPERIMENT',
      status: 'SUPPORTED',
      gapAnalysis: 'No confidence interval.',
    }],
    reproducibilityChecklist: [
      { key: 'claims_match_evidence', label: 'Claims match evidence', status: 'PARTIAL', evidenceAndSuggestion: 'Add CIs.' },
      { key: 'code_and_data_availability', label: 'Code available', status: 'NO', evidenceAndSuggestion: 'No link.' },
    ],
    questionsForAuthors: [{
      questionNumber: 1,
      question: 'What is the baseline?',
      linkedIssueSummary: 'Missing baseline',
      howResponseChangesEvaluation: 'Would clarify the gains.',
    }],
    reviewQualityAudit: {
      actionabilityScorePct: 82,
      depthScoreNormalized: 0.7,
      factualAccuracyScore: 0.9,
      lazyHeuristicsRemoved: [],
      principlesPassed: { fidelity: true, clarity: true, fairness: true, proportionality: true, constructiveness: true },
    },
  },
}

if (cmd === 'review') {
  const save = args.indexOf('--save-markdown')
  if (save >= 0) writeFileSync(args[save + 1], '# Parsed paper\n')
  const response = await fetch(process.env.DEEPREVIEW_BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + process.env.DEEPREVIEW_API_KEY,
    },
    body: JSON.stringify({
      model: 'ignored-by-bridge',
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'You are a reviewer.' },
        { role: 'user', content: 'Return JSON.' },
      ],
    }),
  })
  const payload = await response.json()
  writeFileSync(process.cwd() + '/.fake-bridge.json', JSON.stringify(payload))
  if (!response.ok) {
    console.error('bridge failed: ' + JSON.stringify(payload))
    process.exit(4)
  }
  out(review)
} else if (cmd === 'estimate-cost') {
  out({
    lowCost: { currencyCode: 'USD', units: '1', nanos: 0 },
    medianCost: { currencyCode: 'USD', units: '2', nanos: 500000000 },
    highCost: { currencyCode: 'USD', units: '4', nanos: 0 },
    pastReviewCount: 3,
  })
} else if (cmd === 'pdf2md') {
  out({
    filename: 'scan.pdf',
    pdfType: 'TEXT',
    pageCount: 2,
    confidence: 0.99,
    markdown: '# Parsed\n',
    pages: [
      { pageNumber: 1, needsOcr: false },
      { pageNumber: 2, needsOcr: true, ocrReason: 'scanned' },
    ],
  })
} else if (cmd === 'verify-citations') {
  out([
    { refNum: 1, rawReference: 'Smith 2020', lookupVerdict: 'OK', finalVerdict: 'OK', fieldComparisons: [] },
    { refNum: 2, rawReference: 'Doe 2019', lookupVerdict: 'NOT_FOUND', finalVerdict: 'NOT_FOUND', fieldComparisons: [{ fieldKey: 'title', match: false, detail: 'not found' }] },
    { refNum: 3, rawReference: 'Roe 2021', lookupVerdict: 'MINOR_MISMATCH', finalVerdict: 'MINOR_MISMATCH', fieldComparisons: [{ fieldKey: 'year', match: false, detail: '2020 vs 2021' }] },
  ])
} else {
  console.error('unknown command: ' + cmd)
  process.exit(2)
}
`

const FAIL_ENGINE = String.raw`
import { writeFileSync } from 'node:fs'
writeFileSync(process.cwd() + '/.fake-fail-env.json', JSON.stringify({
  deepreview: process.env.DEEPREVIEW_API_KEY ?? null,
}))
console.error('boom: ' + (process.env.DEEPREVIEW_API_KEY || ''))
process.exit(3)
`

const cwd = mkdtempSync(join(tmpdir(), 'ah-deep-review-'))
const llmCalls = []
const ctx = {
  tools: { register: (registered) => { tool = registered } },
  llm: {
    async *stream(options) {
      llmCalls.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '{"ok":true}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
}
const exec = {
  agent: {
    options: { provider: 'deepseek-official', model: 'deepseek-flash' },
    session: { header: { cwd } },
  },
}
const saved = {
  engine: process.env.DEEPREVIEW_ENGINE,
  openai: process.env.OPENAI_API_KEY,
  github: process.env.GITHUB_TOKEN,
}

let tool
apply(ctx)
const call = (args) => tool.execute(args, exec)

function storeDir(result) {
  assert.ok(result.dir, 'result should include the store dir')
  return join(cwd, result.dir)
}

function runs(dir) {
  const file = join(dir, 'runs.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

try {
  const engine = join(cwd, 'fake-engine.mjs')
  writeFileSync(engine, FAKE_ENGINE)
  const failing = join(cwd, 'fail-engine.mjs')
  writeFileSync(failing, FAIL_ENGINE)
  process.env.DEEPREVIEW_ENGINE = engine
  process.env.OPENAI_API_KEY = 'ambient-openai-key'
  process.env.GITHUB_TOKEN = 'ambient-github-token'

  writeFileSync(join(cwd, 'paper.pdf'), 'not-a-real-pdf')
  writeFileSync(join(cwd, 'paper.md'), '# Manuscript\n\nSome text.\n')
  writeFileSync(join(cwd, 'other.md'), '# Other\n')

  // 1. review: compact summary, artifacts, parsed paper markdown
  let r = await call({
    action: 'review',
    path: 'paper.pdf',
    topology: 'HIGH',
    thinking_level: 'HIGH',
    focus: 'focus on the causal claims',
  })
  assert.equal(r.action, 'review')
  assert.equal(r.state, 'SUCCEEDED')
  assert.equal(r.document_id, 'doc1234567890ab')
  assert.equal(r.review_id, 'rev-0001')
  assert.equal(r.comments.total, 4)
  assert.equal(r.comments.by_severity.CRITICAL, 1)
  assert.equal(r.comments.by_severity.MAJOR, 2)
  assert.equal(r.comments.top.length, 4)
  assert.equal(r.comments.top[0].severity, 'CRITICAL')
  assert.equal(r.comments.top[0].location, 'page 3')
  assert.equal(r.questions, 1)
  assert.equal(r.checklist.by_status.PARTIAL, 1)
  assert.equal(r.claims.by_status.SUPPORTED, 1)
  assert.equal(r.flagged_citations.total, 1)
  assert.equal(r.flagged_citations.by_verdict.NOT_FOUND, 1)
  assert.equal(r.quality.actionability_score_pct, 82)
  assert.equal(r.reviewMarkdown, undefined, 'full markdown must not leak into review output')
  assert.equal(r.comments.top[0].body, undefined, 'comment bodies must not leak into review output')

  const argv = JSON.parse(readFileSync(join(cwd, '.fake-argv.json'), 'utf8'))
  assert.equal(argv[0], 'review')
  assert.ok(argv.includes('--topology') && argv.includes('HIGH'))
  assert.ok(argv.includes('--thinking-level') && argv.includes('HIGH'))
  assert.ok(argv.includes('--prompt') && argv.includes('focus on the causal claims'))
  assert.ok(argv.includes('--save-markdown'))
  const childEnv = JSON.parse(readFileSync(join(cwd, '.fake-env.json'), 'utf8'))
  assert.match(childEnv.deepreview, /^[0-9a-f-]{36}$/, 'the engine receives a per-run bridge token')
  assert.ok(!JSON.stringify(argv).includes(childEnv.deepreview), 'the bridge token must never be passed in argv')
  assert.equal(childEnv.openai, null, 'ambient provider keys must not be forwarded')
  assert.equal(childEnv.genericSecret, null, 'unrelated ambient secrets must not be forwarded')

  const bridgePayload = JSON.parse(readFileSync(join(cwd, '.fake-bridge.json'), 'utf8'))
  assert.equal(bridgePayload.choices[0].message.content, '{"ok":true}')
  assert.equal(bridgePayload.model, 'deepseek-flash')
  assert.equal(llmCalls.length, 1)
  assert.equal(llmCalls[0].provider, 'deepseek-official')
  assert.equal(llmCalls[0].model, 'deepseek-flash')
  assert.equal(llmCalls[0].system, 'You are a reviewer.')
  assert.deepEqual(llmCalls[0].messages, [{ role: 'user', content: [{ type: 'text', text: 'Return JSON.' }] }])
  assert.equal(llmCalls[0].temperature, 0.2)

  const dir = storeDir(r)
  assert.ok(existsSync(join(dir, 'review.json')))
  assert.ok(existsSync(join(dir, 'review.md')))
  assert.ok(existsSync(join(dir, 'paper.md')))
  assert.ok(existsSync(join(dir, 'meta.json')))
  assert.equal(runs(dir).length, 1)
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  assert.equal(meta.input.sha1.length, 40)
  assert.equal(meta.last_run.review_id, 'rev-0001')
  assert.equal(meta.engine.route, 'session-model')
  assert.equal(meta.engine.provider, 'deepseek-official')
  assert.equal(meta.engine.model, 'deepseek-flash')
  assert.ok(!JSON.stringify(meta).includes(childEnv.deepreview), 'meta must not store the bridge token')

  // 2. rerun: latest artifacts win, run history grows
  r = await call({ action: 'review', path: 'paper.pdf' })
  assert.equal(runs(dir).length, 2)

  // 3. show summary reflects the stored review and is not stale
  let s = await call({ action: 'show', path: 'paper.pdf' })
  assert.equal(s.section, 'summary')
  assert.equal(s.stale, false)
  assert.equal(s.summary.comments.total, 4)

  // 4. comments: severity filter, paging, bodies only on request
  s = await call({ action: 'show', path: 'paper.pdf', section: 'comments', severity: 'MAJOR', limit: 1 })
  assert.equal(s.total, 2)
  assert.equal(s.comments.length, 1)
  assert.equal(s.comments[0].body, undefined)
  assert.match(s.comments[0].summary, /Missing baseline/)
  s = await call({ action: 'show', path: 'paper.pdf', section: 'comments', include_body: true, limit: 1, offset: 1 })
  assert.equal(s.comments.length, 1)
  assert.ok(s.comments[0].body, 'include_body should expose the body')
  assert.ok(s.comments[0].suggested_edit !== undefined)

  // 5. other sections and the markdown cap
  s = await call({ action: 'show', path: 'paper.pdf', section: 'questions' })
  assert.equal(s.questions.length, 1)
  s = await call({ action: 'show', path: 'paper.pdf', section: 'checklist' })
  assert.equal(s.checklist.length, 2)
  s = await call({ action: 'show', path: 'paper.pdf', section: 'claims' })
  assert.equal(s.claims.length, 1)
  s = await call({ action: 'show', path: 'paper.pdf', section: 'citations' })
  assert.equal(s.total, 1)
  assert.equal(s.citations[0].verdict, 'NOT_FOUND')
  s = await call({ action: 'show', path: 'paper.pdf', section: 'markdown', max_chars: 500 })
  assert.equal(s.truncated, true)
  assert.equal(s.markdown.length, 500)
  s = await call({ action: 'show', path: 'paper.pdf', section: 'markdown' })
  assert.equal(s.truncated, false)

  // 6. estimate: no review artifacts and no model call
  const callsBeforeEstimate = llmCalls.length
  let e = await call({ action: 'estimate', path: 'other.md', topology: 'HIGH' })
  assert.equal(llmCalls.length, callsBeforeEstimate, 'estimate must not call the model')
  assert.equal(e.action, 'estimate')
  assert.equal(e.formatted.median, '$2.50')
  assert.ok(existsSync(join(storeDir(e), 'estimate.json')))
  assert.ok(!existsSync(join(storeDir(e), 'review.json')))

  // 7. pdf2md: metadata and parsed markdown
  let p = await call({ action: 'pdf2md', path: 'paper.pdf' })
  assert.equal(p.action, 'pdf2md')
  assert.equal(p.page_count, 2)
  assert.equal(p.pages_needing_ocr, 1)
  assert.ok(existsSync(join(storeDir(p), 'paper.md')))
  assert.ok(existsSync(join(storeDir(p), 'pdf-meta.json')))
  p = await call({ action: 'pdf2md', path: 'paper.md' })
  assert.match(p.error, /needs a PDF/)

  // 8. verify_citations reports verdict counts on the session model
  const v = await call({ action: 'verify_citations', path: 'paper.md' })
  assert.equal(v.total, 3)
  assert.equal(v.by_verdict.OK, 1)
  assert.equal(v.by_verdict.NOT_FOUND, 1)
  assert.equal(v.flagged.length, 2)
  assert.ok(existsSync(join(storeDir(v), 'citations.json')))

  // 9. show citations prefers the standalone report, no review required
  s = await call({ action: 'show', path: 'paper.md', section: 'citations' })
  assert.equal(s.total, 3)
  assert.equal(s.by_verdict.OK, 1)
  assert.equal(s.citations.length, 2)
  assert.match(s.source, /citations\.json$/)

  // 10. status: current, then stale after the manuscript changes; later
  // estimate/pdf2md/failed-review runs must not clear the stale flag
  s = await call({ action: 'status', path: 'paper.pdf' })
  assert.equal(s.stale, false)
  assert.equal(s.last_run.action, 'pdf2md')
  appendFileSync(join(cwd, 'paper.pdf'), '\nnew content\n')
  s = await call({ action: 'status', path: 'paper.pdf' })
  assert.equal(s.stale, true)
  await call({ action: 'estimate', path: 'paper.pdf' })
  s = await call({ action: 'status', path: 'paper.pdf' })
  assert.equal(s.stale, true, 'estimate must not refresh the reviewed hash')

  // 11. path confinement, missing stored results, and a missing session route
  let bad = await call({ action: 'status', path: '../../etc/passwd' })
  assert.match(bad.error, /escapes the workspace/)
  bad = await call({ action: 'show', path: 'other.md' })
  assert.match(bad.error, /run action "review"/)
  const noRouteExec = { agent: { session: { header: { cwd } } } }
  bad = await tool.execute({ action: 'review', path: 'paper.md' }, noRouteExec)
  assert.match(bad.error, /session model route/)

  // 12. engine failure: nonzero exit, redacted stderr, failed run recorded
  process.env.DEEPREVIEW_ENGINE = failing
  const before = runs(dir).length
  bad = await call({ action: 'review', path: 'paper.pdf' })
  assert.match(bad.error, /exited with code 3/)
  assert.match(bad.error, /boom/)
  const failEnv = JSON.parse(readFileSync(join(cwd, '.fake-fail-env.json'), 'utf8'))
  assert.match(failEnv.deepreview, /^[0-9a-f-]{36}$/)
  assert.ok(!bad.error.includes(failEnv.deepreview), 'the bridge token must be redacted from errors')
  assert.equal(runs(dir).length, before + 1)
  assert.equal(runs(dir).at(-1).state, 'FAILED')
  s = await call({ action: 'status', path: 'paper.pdf' })
  assert.equal(s.stale, true, 'a failed review must not refresh the reviewed hash')

  // 13. the bridge rejects a wrong bearer token
  const bridge = await startLlmBridge(ctx, exec)
  try {
    let res = await fetch(`${bridge.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' },
      body: '{}',
    })
    assert.equal(res.status, 401)
    res = await fetch(`${bridge.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    const payload = await res.json()
    assert.equal(payload.choices[0].message.content, '{"ok":true}')
  } finally {
    await bridge.close()
  }

  // 14. list: newest storage entries with compact metadata
  process.env.DEEPREVIEW_ENGINE = engine
  const listed = await call({ action: 'list' })
  assert.equal(listed.action, 'list')
  assert.ok(listed.total >= 3)
  assert.ok(listed.reviews.some((entry) => entry.file_name === 'paper.pdf'))
  assert.ok(listed.reviews.every((entry) => typeof entry.stored === 'string'))

  console.log('test-deep-review-tool: ok')
} finally {
  if (saved.engine == null) delete process.env.DEEPREVIEW_ENGINE
  else process.env.DEEPREVIEW_ENGINE = saved.engine
  if (saved.openai == null) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = saved.openai
  if (saved.github == null) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = saved.github
  rmSync(cwd, { recursive: true, force: true })
}
