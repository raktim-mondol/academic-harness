import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, startLlmBridge } from '../deep-review.js'

const FAKE_ENGINE = String.raw`
import { existsSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
writeFileSync(process.cwd() + '/.fake-argv.json', JSON.stringify(args))
writeFileSync(process.cwd() + '/.fake-env.json', JSON.stringify({
  deepreview: process.env.DEEPREVIEW_API_KEY ?? null,
  model: process.env.DEEPREVIEW_MODEL ?? null,
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

// Round two of the same manuscript: comment ids are deliberately re-issued, and
// one criticism keeps its wording while dropping in severity, so the round
// ladder must match it by text rather than by id.
const review2 = {
  name: 'documents/doc1234567890ab/reviews/rev-0002',
  state: 'SUCCEEDED',
  createTime: new Date().toISOString(),
  runConfig: { model: 'fake-model', baseUrl: 'https://example.invalid/v1', topology: 'MID' },
  result: {
    reviewMarkdown: '# Second review\n\n' + 'B'.repeat(900),
    anchoredComments: [
      {
        commentId: 'x1',
        severity: 'CRITICAL',
        summary: 'Unsupported causal claim',
        bodyMarkdown: 'Still no intervention identified.',
        suggestedEdit: 'Soften to an association.',
        location: { pdf: { pageNumber: 3, quoteSelector: { exact: 'X causes Y' } } },
      },
      {
        commentId: 'x2',
        severity: 'MINOR',
        summary: 'Missing baseline',
        bodyMarkdown: 'A weak baseline was added in the appendix.',
        location: { text: { firstLine: 20, lastLine: 21, quotedLinePreview: 'baseline missing' } },
      },
      {
        commentId: 'x3',
        severity: 'MAJOR',
        summary: 'No uncertainty quantification',
        bodyMarkdown: 'The headline table reports no intervals.',
        location: { text: { firstLine: 30, lastLine: 31, quotedLinePreview: 'Table 3' } },
      },
      {
        // Same MINOR finding as round one, reworded: exact wording fails, so the
        // similarity tier must pair it instead of reporting one closed and one new.
        commentId: 'x4',
        severity: 'MINOR',
        summary: 'Typo in section 2 remains',
        bodyMarkdown: 'The typo is still there.',
        location: { text: { firstLine: 4, lastLine: 4, quotedLinePreview: 'Section 2' } },
      },
    ],
    contributionType: 'EMPIRICAL_ML',
    claimEvidenceMap: [
      { claimId: 'k1', claim: 'The method improves accuracy', page: 5, evidenceLocation: 'Table 2', evidenceType: 'EXPERIMENT', status: 'SUPPORTED', gapAnalysis: 'Interval still missing.' },
      { claimId: 'k2', claim: 'Attention weights are humanly aligned', page: 7, evidenceLocation: 'none', evidenceType: 'NONE', status: 'UNSUPPORTED', gapAnalysis: 'No evidence.' },
    ],
    reproducibilityChecklist: [
      { key: 'claims_match_evidence', label: 'Claims match evidence', status: 'YES', evidenceAndSuggestion: 'Now stated as an association.' },
      { key: 'code_and_data_availability', label: 'Code available', status: 'NO', evidenceAndSuggestion: 'No link.' },
    ],
    questionsForAuthors: [
      { questionNumber: 1, question: 'What is the baseline?', linkedIssueSummary: 'Missing baseline', howResponseChangesEvaluation: 'Would clarify the gains.' },
      { questionNumber: 2, question: 'How were the intervals estimated?', linkedIssueSummary: 'No uncertainty quantification', howResponseChangesEvaluation: 'Would support the headline claim.' },
    ],
    reviewQualityAudit: {
      actionabilityScorePct: 88,
      depthScoreNormalized: 0.75,
      factualAccuracyScore: 0.9,
      lazyHeuristicsRemoved: [],
      principlesPassed: { fidelity: true, clarity: true, fairness: true, proportionality: true, constructiveness: true },
    },
  },
}

if (cmd === 'review') {
  const save = args.indexOf('--save-markdown')
  if (save >= 0) writeFileSync(args[save + 1], '# Parsed paper\n')
  console.error('[ 42%] [REVIEW] halfway through the fixture')
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
  out(existsSync(process.cwd() + '/.phase2') ? review2 : review)
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
let llmReply = '{"ok":true}'
const jobEvents = []
let jobSpec
let jobHooks
const fakeJobs = {
  start(spec) {
    jobSpec = spec
    const job = {
      append: (text, options) => jobEvents.push({ text, channel: options?.channel }),
      updateProgress: (line) => jobEvents.push({ progress: line }),
    }
    jobHooks = spec.run(job)
    return 'deep-review-test'
  },
  async wait() {
    const outcome = await jobHooks.done
    return { status: outcome.status, detail: outcome.detail }
  },
  kill(_id, _owner, reason) {
    jobHooks.cancel(reason)
    return 'requested'
  },
  remove() {},
}
const ctx = {
  tools: { register: (registered) => { tool = registered } },
  llm: {
    async *stream(options) {
      llmCalls.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: llmReply }
      yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
  jobs: fakeJobs,
}
const exec = {
  agent: {
    id: 'agent-test',
    options: { provider: 'deepseek-official', model: 'deepseek-flash' },
    session: { header: { cwd } },
  },
  callId: 'call-test',
  rootCallId: 'call-test',
}
const saved = {
  engine: process.env.DEEPREVIEW_ENGINE,
  openai: process.env.OPENAI_API_KEY,
  github: process.env.GITHUB_TOKEN,
  rubric: process.env.DEEP_REVIEW_DEFAULT_RUBRIC,
  maxRounds: process.env.DEEP_REVIEW_MAX_ROUNDS,
  ceiling: process.env.DEEP_REVIEW_COST_CEILING_USD,
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
  assert.equal(r.job_id, 'deep-review-test')
  assert.equal(jobSpec.kind, 'deep-review')
  assert.equal(jobSpec.owner, 'agent-test')
  assert.equal(jobSpec.toolCall.callId, 'call-test')
  assert.match(jobSpec.label, /paper\.pdf/)
  assert.ok(jobEvents.some((event) => event.progress?.includes('42%')), 'engine progress reaches the job')
  assert.ok(jobEvents.some((event) => event.channel === 'stderr' && event.text.includes('42%')), 'engine stderr reaches the job ring')
  assert.ok(jobEvents.some((event) => event.channel === 'log' && event.text.includes('[bridge] call 1')), 'bridge request reaches the job log')
  assert.ok(jobEvents.some((event) => event.channel === 'log' && event.text.includes('done in')), 'bridge response reaches the job log')

  const argv = JSON.parse(readFileSync(join(cwd, '.fake-argv.json'), 'utf8'))
  assert.equal(argv[0], 'review')
  assert.ok(argv.includes('--topology') && argv.includes('HIGH'))
  assert.ok(argv.includes('--thinking-level') && argv.includes('HIGH'))
  assert.ok(argv.includes('--prompt') && argv.includes('focus on the causal claims'))
  assert.ok(argv.includes('--save-markdown'))
  const childEnv = JSON.parse(readFileSync(join(cwd, '.fake-env.json'), 'utf8'))
  assert.match(childEnv.deepreview, /^[0-9a-f-]{36}$/, 'the engine receives a per-run bridge token')
  assert.equal(childEnv.model, 'deepseek-flash', 'the engine log names the session model')
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

  // 15. rounds: a second review adds a round instead of erasing the first
  writeFileSync(join(cwd, 'ladder.md'), '# Ladder\n\nFirst manuscript.\n')
  const l1 = await call({ action: 'review', path: 'ladder.md' })
  assert.equal(l1.round, 1)
  assert.equal(l1.rounds, 1)
  assert.equal(l1.seeded_prior_round, null)
  assert.equal(l1.evaluator_kind, 'held_out', 'the first review is held out by default')
  assert.equal(l1.usage.calls, 1, 'a round records the bridge token tally')
  assert.equal(l1.usage.prompt_tokens, 120)
  const ldir = storeDir(l1)
  assert.ok(existsSync(join(cwd, l1.artifacts.round.json)), 'round one keeps its digest')
  const legacyReview = JSON.parse(readFileSync(join(cwd, l1.artifacts.review), 'utf8'))
  const ladderMeta = () => JSON.parse(readFileSync(join(ldir, 'meta.json'), 'utf8'))
  assert.equal(ladderMeta().schemaVersion, 2)
  const runId1 = ladderMeta().rounds[0].run_id

  writeFileSync(join(cwd, '.phase2'), 'second fixture')
  const l2 = await call({ action: 'review', path: 'ladder.md', rubric_round: '1' })
  assert.equal(l2.round, 2)
  assert.equal(l2.rounds, 2)
  assert.equal(l2.evaluator_kind, 'in_distribution', 'a declared rubric round marks the next review in-distribution')
  assert.deepEqual(l2.rubric_round, { round: 1, run_id: runId1 })
  assert.equal(ladderMeta().rounds[1].evaluator_kind, 'in_distribution')
  assert.equal(ladderMeta().review.evaluator_kind, 'in_distribution')
  assert.ok(existsSync(join(cwd, l2.artifacts.round.markdown)), 'round two keeps its own report')
  assert.equal(ladderMeta().rounds.length, 2)
  assert.equal(readFileSync(join(cwd, l2.artifacts.review), 'utf8').includes('rev-0002'), true)

  const cmp = await call({ action: 'compare', path: 'ladder.md' })
  assert.equal(cmp.action, 'compare')
  assert.equal(cmp.from.round, 1)
  assert.equal(cmp.to.round, 2)
  assert.equal(cmp.input_changed, false, 'same bytes: this ladder is reviewer variance, not a revision')
  assert.equal(cmp.comments.total_from, 4)
  assert.equal(cmp.comments.total_to, 4)
  assert.equal(cmp.comments.closed_total, 1, 'only the citation finding actually disappeared')
  assert.equal(cmp.comments.opened_total, 1)
  assert.equal(cmp.comments.persisting_total, 3)
  assert.equal(cmp.comments.severity_changed, 1)
  assert.equal(cmp.comments.matched_by.summary, 2, 're-issued comment ids must not read as closed plus opened')
  assert.equal(cmp.comments.matched_by.similar, 1, 'a reworded finding pairs by wording similarity, not as closed plus new')
  assert.equal(cmp.comments.matched_by.id, 0)
  assert.ok(!cmp.comments.closed.some((item) => /typo/i.test(item.summary)), 'the reworded typo must not read as closed')
  assert.ok(cmp.comments.opened.every((item) => /uncertainty/.test(item.summary)))
  assert.ok(cmp.comments.moved.some((item) => item.from_severity === 'MAJOR' && item.severity === 'MINOR'))
  const rendered = tool.output.render({}, cmp)
  assert.match(rendered[0].text, /Matched by: id 0, summary 2, quote 0, similar 1/, 'the render names which rule paired findings')
  assert.match(rendered[0].text, /re-issues comment ids per run/, 'the note names the engine behaviour that makes ids useless')
  assert.equal(cmp.citations.fixed_total, 1)
  assert.equal(cmp.citations.still_flagged_total, 0)
  assert.equal(cmp.checklist.changed_total, 1)
  assert.ok(cmp.checklist.transitions.some((item) => item.key === 'claims_match_evidence' && item.from_status === 'PARTIAL' && item.to_status === 'YES'))
  assert.equal(cmp.claims.raised_total, 1)
  assert.equal(cmp.claims.resolved_total, 0)
  assert.equal(cmp.questions.total_from, 1)
  assert.equal(cmp.questions.total_to, 2)
  assert.equal(cmp.questions.added_total, 1)
  assert.match(cmp.note, /advisory/i)

  const explicit = await call({ action: 'compare', path: 'ladder.md', from: '1', to: '2' })
  assert.equal(explicit.from.run_id, runId1)
  const twice = await call({ action: 'compare', path: 'ladder.md', from: '2', to: '2' })
  assert.match(twice.error, /same round/)
  const unknown = await call({ action: 'compare', path: 'ladder.md', from: '9' })
  assert.match(unknown.error, /no stored round/)

  s = await call({ action: 'show', path: 'ladder.md', section: 'rounds' })
  assert.equal(s.total, 2)
  assert.equal(s.latest_round, 2)
  assert.equal(s.rounds[0].comments, 4)
  assert.equal(s.rounds[0].model, 'deepseek-flash', 'each round records the reviewer model that produced it')
  assert.equal(s.rounds[0].evaluator_kind, 'held_out')
  assert.equal(s.rounds[1].evaluator_kind, 'in_distribution')
  assert.equal(s.rounds[1].reviewed_this_input, true)
  s = await call({ action: 'status', path: 'ladder.md' })
  assert.equal(s.rounds.total, 2)
  assert.equal(s.rounds.totals.model_calls, 2)
  assert.equal(s.rounds.totals.prompt_tokens, 240)

  // 16. score: advisory dimensions cite stored comment ids, with evaluator provenance
  process.env.DEEP_REVIEW_DEFAULT_RUBRIC = 'Score each dimension on a 1–5 scale.'
  llmReply = JSON.stringify({
    dimensions: {
      soundness: { score: 4, reading: 'The causal claim is weakened by the missing intervention.', comment_ids: ['x1'] },
      originality: { score: 3, reading: 'The contribution is incremental.', comment_ids: ['x2'] },
      clarity: { score: 4, reading: 'The report is clear.', comment_ids: ['x3'] },
      significance: { score: 3, reading: 'The result matters modestly.', comment_ids: ['x4'] },
    },
    overall: { score: 3.5, reading: 'A promising but incomplete study.' },
    confidence: 'medium',
    limitations: ['No external validation.'],
  })
  const scoreCalls = llmCalls.length
  const score = await call({ action: 'score', path: 'ladder.md' })
  assert.equal(llmCalls.length, scoreCalls + 1, 'score makes exactly one model call')
  assert.equal(score.action, 'score')
  assert.equal(score.round, 2)
  assert.equal(score.evaluator_kind, 'in_distribution')
  assert.equal(score.evaluator_kind_source, 'declared')
  assert.deepEqual(score.scale, { min: 1, max: 5, label: '1–5' })
  assert.equal(score.rubric_source, 'setting')
  assert.equal(score.state, 'ok')
  assert.equal(score.dimensions.soundness.score, 4)
  assert.deepEqual(score.dimensions.soundness.comment_ids, ['x1'])
  assert.equal(score.dimensions.clarity.score, 4)
  assert.equal(score.overall.score, 3.5)
  assert.equal(score.overall.source, 'model')
  assert.equal(score.confidence, 'medium')
  assert.deepEqual(score.limitations, ['No external validation.'])
  assert.equal(score.usage.completion_tokens, 40)
  const scoreFile = join(ldir, 'score.json')
  assert.ok(existsSync(scoreFile), 'score.json is stored')
  const scoreMeta = ladderMeta().score
  assert.equal(scoreMeta.evaluator_kind, 'in_distribution')
  assert.equal(scoreMeta.overall, 3.5)
  assert.equal(scoreMeta.round, 2)
  const shownScore = await call({ action: 'show', path: 'ladder.md', section: 'score' })
  assert.equal(shownScore.section, 'score')
  assert.equal(shownScore.dimensions.soundness.score, 4)
  assert.equal(shownScore.review.evaluator_kind, 'in_distribution')
  const statusScore = await call({ action: 'status', path: 'ladder.md' })
  assert.equal(statusScore.score.overall, 3.5)
  assert.equal(statusScore.score.current, true)
  const renderedScore = tool.output.render({}, score)
  assert.match(renderedScore[0].text, /Advisory score/)
  assert.match(renderedScore[0].text, /not an acceptance decision/)
  assert.match(renderedScore[0].text, /soundness: 4\/5/)
  assert.match(renderedScore[0].text, /x1/)

  // A dimension with no valid stored comment id is not_checked; no dimension
  // can carry an unsupported score.
  llmReply = JSON.stringify({
    dimensions: {
      soundness: { score: 5, reading: 'No citation.', comment_ids: ['missing'] },
      originality: { score: 5, reading: 'No citation.', comment_ids: ['missing'] },
      clarity: { score: 5, reading: 'No citation.', comment_ids: ['missing'] },
      significance: { score: 5, reading: 'No citation.', comment_ids: ['missing'] },
    },
    overall: { score: 5, reading: 'Unsupported.' },
  })
  const uncited = await call({ action: 'score', path: 'ladder.md' })
  assert.equal(uncited.state, 'not_checked')
  assert.equal(uncited.dimensions.soundness.state, 'not_checked')
  assert.equal(uncited.overall.state, 'not_checked')

  // A null score is an abstention, not a zero.
  llmReply = JSON.stringify({
    dimensions: {
      soundness: { score: null, reading: 'No numeric reading.', comment_ids: ['x1'] },
      originality: { score: 3, reading: 'Incremental.', comment_ids: ['x2'] },
      clarity: { score: 4, reading: 'Clear.', comment_ids: ['x3'] },
      significance: { score: 3, reading: 'Modest.', comment_ids: ['x4'] },
    },
    overall: { score: 3, reading: 'Mixed.' },
  })
  const nullScore = await call({ action: 'score', path: 'ladder.md' })
  assert.equal(nullScore.dimensions.soundness.state, 'not_checked')
  assert.equal(nullScore.state, 'ok')
  assert.equal(nullScore.overall.score, 3)

  // No host llm route: the score is not_checked, not an error or a silent pass.
  const savedLlm = ctx.llm
  ctx.llm = null
  const noLlmScore = await call({ action: 'score', path: 'ladder.md' })
  assert.equal(noLlmScore.state, 'not_checked')
  assert.match(noLlmScore.reason, /host llm service/)
  ctx.llm = savedLlm

  // The setting can declare a different scale; the artifact names the source.
  process.env.DEEP_REVIEW_DEFAULT_RUBRIC = 'Score each dimension on a 1–10 scale.'
  llmReply = JSON.stringify({
    dimensions: {
      soundness: { score: 7, reading: 'Solid.', comment_ids: ['x1'] },
      originality: { score: 7, reading: 'New enough.', comment_ids: ['x2'] },
      clarity: { score: 7, reading: 'Clear.', comment_ids: ['x3'] },
      significance: { score: 7, reading: 'Relevant.', comment_ids: ['x4'] },
    },
    overall: { score: 7, reading: 'Strong.' },
    confidence: 'high',
    limitations: [],
  })
  const scaled = await call({ action: 'score', path: 'ladder.md' })
  assert.deepEqual(scaled.scale, { min: 1, max: 10, label: '1–10' })
  assert.equal(scaled.rubric_source, 'setting')
  assert.equal(scaled.overall.score, 7)
  delete process.env.DEEP_REVIEW_DEFAULT_RUBRIC
  llmReply = '{"ok":true}'

  // 17. the round limit setting refuses a review before spending the engine run
  writeFileSync(join(cwd, 'limit.md'), '# Limit\n')
  process.env.DEEP_REVIEW_MAX_ROUNDS = '1'
  const limitOne = await call({ action: 'review', path: 'limit.md' })
  assert.equal(limitOne.round, 1)
  const limitTwo = await call({ action: 'review', path: 'limit.md' })
  assert.match(limitTwo.error, /review round limit reached/)
  delete process.env.DEEP_REVIEW_MAX_ROUNDS

  // 18. the per-review cost ceiling blocks before the review job is created
  writeFileSync(join(cwd, 'ceiling.md'), '# Ceiling\n')
  process.env.DEEP_REVIEW_COST_CEILING_USD = '1'
  const blocked = await call({ action: 'review', path: 'ceiling.md' })
  assert.match(blocked.error, /exceeds DEEP_REVIEW_COST_CEILING_USD/)
  delete process.env.DEEP_REVIEW_COST_CEILING_USD

  // 19. a store written before rounds is read as round 1, then kept on upgrade
  writeFileSync(join(cwd, 'legacy.md'), '# Legacy\n\nOld store.\n')
  const legacyDir = join(cwd, '.dsh', 'deep-review', createHash('sha1').update('legacy.md').digest('hex').slice(0, 16))
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(join(legacyDir, 'review.json'), JSON.stringify(legacyReview))
  writeFileSync(join(legacyDir, 'review.md'), '# Legacy review\n')
  writeFileSync(join(legacyDir, 'meta.json'), JSON.stringify({
    schemaVersion: 1,
    key: legacyDir.split('/').pop(),
    input: {
      path: 'legacy.md',
      file_name: 'legacy.md',
      size_bytes: statSync(join(cwd, 'legacy.md')).size,
      sha1: createHash('sha1').update(readFileSync(join(cwd, 'legacy.md'))).digest('hex'),
      format: 'md',
    },
    engine: { provider: 'deepseek-official', model: 'deepseek-flash', route: 'session-model' },
    params: {},
    last_run: {
      action: 'review', run_id: 'legacy-run-1', started_at: '2026-01-01T00:00:00.000Z',
      finished_at: '2026-01-01T00:04:00.000Z', duration_ms: 240000, exit_code: 0, state: 'SUCCEEDED',
      review_id: 'rev-0001', document_id: 'doc1234567890ab', error: null,
    },
    summary: null,
    artifacts: {},
    review: {
      sha1: createHash('sha1').update(readFileSync(join(cwd, 'legacy.md'))).digest('hex'),
      review_id: 'rev-0001', document_id: 'doc1234567890ab',
      finished_at: '2026-01-01T00:04:00.000Z', params: { topology: null, thinking_level: null },
    },
  }))

  const single = await call({ action: 'compare', path: 'legacy.md' })
  assert.match(single.error, /only 1 review round stored/)
  s = await call({ action: 'status', path: 'legacy.md' })
  assert.equal(s.rounds.total, 1, 'a v1 store reads as one round without being rewritten')
  assert.equal(JSON.parse(readFileSync(join(legacyDir, 'meta.json'), 'utf8')).schemaVersion, 1, 'reading must not migrate the store')

  appendFileSync(join(cwd, 'legacy.md'), '\nrevised\n')
  const upgraded = await call({ action: 'review', path: 'legacy.md' })
  assert.equal(upgraded.round, 2)
  assert.equal(upgraded.seeded_prior_round, 1, 'the overwritten v1 review survives as round 1')
  const upgradedMeta = JSON.parse(readFileSync(join(legacyDir, 'meta.json'), 'utf8'))
  assert.equal(upgradedMeta.schemaVersion, 2)
  assert.equal(upgradedMeta.rounds[0].run_id, 'legacy-run-1')
  assert.ok(existsSync(join(legacyDir, 'rounds', 'legacy-run-1.json')))
  assert.ok(existsSync(join(legacyDir, 'rounds', 'legacy-run-1.md')))
  const cmpLegacy = await call({ action: 'compare', path: 'legacy.md' })
  assert.equal(cmpLegacy.input_changed, true, 'the revision changed the manuscript bytes')
  assert.equal(cmpLegacy.comments.closed_total, 1)
  assert.equal(cmpLegacy.comments.matched_by.similar, 1)
  rmSync(join(cwd, '.phase2'), { force: true })

  console.log('test-deep-review-tool: ok')
} finally {
  if (saved.engine == null) delete process.env.DEEPREVIEW_ENGINE
  else process.env.DEEPREVIEW_ENGINE = saved.engine
  if (saved.openai == null) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = saved.openai
  if (saved.github == null) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = saved.github
  for (const [name, value] of [
    ['DEEP_REVIEW_DEFAULT_RUBRIC', saved.rubric],
    ['DEEP_REVIEW_MAX_ROUNDS', saved.maxRounds],
    ['DEEP_REVIEW_COST_CEILING_USD', saved.ceiling],
  ]) {
    if (value == null) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(cwd, { recursive: true, force: true })
}
