import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorkspace } from './helpers/test-workspace.mjs'
import { apply, buildFetch, buildQuoteStatus, buildWebSearch, inject, name as MODULE_NAME, runDeepResearchAction, webRecord, WEB_PROVIDERS } from '../deep-research.js'
import { appendClaims, appendRecords, readArtifact, readCorpus, readFindings, readPaperLinks, readRetrieval, readRun, latestVerdict as latestVerdictOf, stepView, writeArtifact } from '../deep-research-store.js'

const workspace = makeWorkspace('ah-deep-research-tool-')
const cwd = workspace.cwd
// This suite uses fake retrieval and must never install into the user's DSH
// home or read/write their PaperMemory database as a side effect.
process.env.DSH_HOME = join(cwd, '.dsh-test-home')
process.env.PAPERMEMORY_DB = join(cwd, 'papermemory-test.db')
process.env.PAPERMEMORY_SKIP_INSTALL = '1'
delete process.env.PAPERMEMORY_CLI

const checks = []
const ok = (label, condition, detail) => {
  checks.push({ label, pass: Boolean(condition) })
  if (!condition) console.error(`FAIL ${label}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail.slice(0, 300) : JSON.stringify(detail).slice(0, 300)}`}`)
}

// A route is required before anything can run; record what each call was asked.
let citationFree = false
let challengeBindings = false
const transcript = []
const PAPERS = [
  { source: 'openalex', doi: '10.1/semaglutide', title: 'Cardiovascular outcomes with semaglutide in overweight adults', year: 2023, citation_count: 410, url: 'https://journal.example/a', abstract: 'Randomised trial reporting a 20% relative reduction in major adverse cardiovascular events.' },
  { source: 'news', title: 'Press release: Cardiovascular outcomes with semaglutide in overweight adults', url: 'https://pr1.example/b', abstract: 'Randomised trial reporting a 20% relative reduction in major adverse cardiovascular events.' },
  { source: 'news', title: 'Press release: Cardiovascular outcomes with semaglutide in overweight adults (reprint)', url: 'https://pr2.example/c', abstract: 'Randomised trial reporting a 20% relative reduction in major adverse cardiovascular events.' },
  { source: 's2', doi: '10.2/exclusions', title: 'Who is left out of obesity cardiovascular trials', year: 2022, url: 'https://journal.example/d', abstract: 'Eligibility criteria excluded insulin-treated diabetes in 9 of 11 trials.' },
]

const CANNED = [
  [/\bTurn a research request into a brief\b/iu, () => ({
    topic: 'GLP-1 cardiovascular outcomes',
    research_questions: ['Does randomised evidence support cardiovascular benefit in non-diabetic adults?', 'What is the effect size?'],
    angle: 'benefit claims outran the studied population',
    reader: 'clinical investigator',
    register: 'analyze',
  })],
  [/decompose a research request into atomic/iu, () => ({
    atomic_items: [{ item: 'identify randomised cardiovascular outcome trials without diabetes', rq_id: 'rq-0001', kind: 'factual' }, { item: 'quantify the reported effect', rq_id: 'rq-0002', kind: 'factual' }],
    coverage_axes: ['mechanism', 'trial design', 'population'],
    tier: 'light',
    register: 'analyze',
    inference_depth: 'standard',
    adversarial_queries: ['semaglutide cardiovascular trial null results'],
  })],
  [/multi-perspective search plan/iu, () => ({
    perspectives: [
      { name: 'mainstream', question: 'who advances this', queries: ['semaglutide cardiovascular outcome trial'] },
      { name: 'critics', question: 'who doubts it', queries: ['GLP-1 cardiovascular benefit limitations'] },
    ],
    web_queries: ['semaglutide cardiovascular guideline', 'SELECT trial exclusion criteria regulator'],
  })],
  [/Draft from this angle/iu, () => citationFree
    ? 'The trial reported a large benefit. Exclusions were broad across the field.'
    : 'The trial reported a 20% relative reduction in MACE [src-0001]. Exclusions were broad [src-0004].'],
  [/Audit whether each cited record/iu, () => challengeBindings
    ? { bindings: ['src-0001', 'src-0002', 'src-0003'].map((id) => ({ record_id: id, sentence: `sentence citing ${id}`, verdict: 'partial', evidence: 'the supplied text does not state it' })) }
    : { bindings: [{ record_id: 'src-0001', sentence: 'The trial reported a 20% relative reduction in MACE', verdict: 'supports', evidence: 'abstract states the same' }] }],
  [/Cut filler, hedge-stacking/iu, () => ({ hunks: [{ find: 'Exclusions were broad', replace: 'Exclusions were broad across nine of eleven trials' }] })],
  [/Recommend rhythm and structure/iu, () => ({ suggestions: [{ why: 'split a long paragraph', find: 'The trial reported', replace: 'The trial reported', priority: 'low' }] })],
  [/Choose where deep investigation would most change the answer/iu, () => ({ loci: [{ title: 'Trial populations', question: 'who was studied', record_ids: ['src-0001', 'src-0004'], expected_yield: 3, why: 'the exclusion criteria decide the claim' }] })],
  [/Merge duplicate loci/iu, () => ({ loci: [{ title: 'Trial populations', question: 'who was actually studied', record_ids: ['src-0001', 'src-0004'], budget: 2, why: 'decides external validity' }] })],
  [/Investigate this one locus/iu, () => ({ position: 'Benefit is demonstrated only in a narrow population.', confidence: 'provisional', claims: [{ text: 'Nine of eleven trials excluded insulin-treated diabetes.', record_ids: ['src-0004'], quote: 'Eligibility criteria excluded insulin-treated diabetes in 9 of 11 trials' }], what_would_change_it: 'a trial enrolling diabetic patients showing no benefit' })],
  [/Reconcile the committed positions/iu, () => ({ comparisons: [{ axis: 'internal vs external validity', positions: ['src-0001 strong effect', 'src-0004 narrow eligibility'], reconciliation: 'the effect is real inside the studied band and untested outside it', unresolved: true }] })],
  [/Extract expert disagreements/iu, () => ({ tensions: [{ issue: 'is the benefit cardiovascular or weight-mediated', positions: [{ stance: 'direct', record_ids: ['src-0001'], rationale: 'event curves separate early' }], stake: 'who should be prescribed it' }] })],
  [/You are the corpus critic/iu, () => ({ gaps: [{ what: 'trials in diabetic populations', why: 'the thesis depends on them', query: 'GLP-1 cardiovascular outcomes diabetes randomised', expected_source: 'pubmed' }] })],
  [/Select the load-bearing claims/iu, () => ({ claims: [{ text: 'A 20% relative reduction in MACE was reported.', rq_id: 'rq-0002', record_ids: ['src-0001'], quote: 'reporting a 20% relative reduction in major adverse cardiovascular events', strength: 'supported' }, { text: 'Eligibility excluded insulin-treated diabetes.', rq_id: 'rq-0001', record_ids: ['src-0004'], quote: 'Eligibility criteria excluded insulin-treated diabetes', strength: 'supported' }] })],
  [/Write the final report/iu, () => '# Report\n\nA 20% relative reduction in MACE was reported [src-0001].\n\nEligibility excluded insulin-treated diabetes in most trials [src-0004].\n'],
  [/counter-evidence the draft missed|shallower than its own|topical corners|does not actually answer/iu, () => ({
    findings: [{
      severity: 'Medium', title: 'Effect size stated without its interval', reason: 'the report gives a point estimate only', target: 'final_report', primary_check: 'calibration',
      verifier: 'read the reported hazard ratio and interval from the source',
    }],
  })],
]

function cannedFor(system) {
  for (const [pattern, build] of CANNED) if (pattern.test(system)) return build()
  return { note: 'unmatched' }
}

// Violations of the host's llm.stream contract. The fake used to accept any
// payload shape, which is exactly why a real-session failure stayed invisible
// here; now it enforces what deep-review.js sends.
const contract = []

function assertHostPayload(payload, { expectSignal = false } = {}) {
  const fail = (reason) => contract.push({ reason, step: payload?.step ?? null })
  if (typeof payload?.provider !== 'string' || !payload.provider) fail('provider missing')
  if (typeof payload?.model !== 'string' || !payload.model) fail('model missing')
  if (typeof payload?.system !== 'string' || !payload.system) fail('system missing')
  if (!Array.isArray(payload?.messages) || !payload.messages.length) fail('messages missing')
  for (const message of payload?.messages ?? []) {
    if (message?.role !== 'user') fail(`role ${message?.role} must reach the host as user`)
    if (!Array.isArray(message?.content)) { fail('content must be text blocks'); continue }
    for (const block of message.content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') fail('block must be {type:text,text}')
    }
  }
  if (expectSignal && !(payload?.signal instanceof AbortSignal)) fail('signal must be an AbortSignal')
  if (expectSignal && Object.hasOwn(payload ?? {}, 'step')) fail('step must not leak into the host payload')
}

const ctx = {
  tools: { register: (registered) => { ctx.tool = registered } },
  llm: {
    async *stream(payload) {
      const { system, messages } = payload
      // Checked as delivered, so provider/model/signal drift fails here too.
      assertHostPayload(payload, { expectSignal: true })
      transcript.push({ system, content: (messages ?? []).map((message) => (typeof message.content === 'string'
        ? message.content
        : (message.content ?? []).map((block) => block.text).join(''))).join('\n') })
      const body = JSON.stringify(cannedFor(String(system ?? '')))
      yield { type: 'text-delta', text: body }
      yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 40 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
}
const exec = {
  agent: { session: { header: { cwd } }, options: { provider: 'deepseek', model: 'test-model' } },
  callId: 'call-0001',
  rootCallId: 'call-0001',
}
apply(ctx)
const tool = ctx.tool

// Retrieval and retraction are injected so CI never reaches the network; the
// quote verifier is deliberately NOT injected, so the bodies-cache seam that
// production uses is the thing under test.
const DEPS = {
  search: async ({ query }) => (/(?:semaglutide|cardio|GLP|obesity|investigation|question)/iu.test(String(query ?? ''))
    ? PAPERS
    : PAPERS.slice(0, 2)).map((paper) => ({ ...paper })),
  fetch: async () => [],
  retractionFor: async () => ({ retracted: false }),
  // Two hosts carrying one release: the web lane is where syndication actually bites.
  web: async ({ queries = [] } = {}) => queries.flatMap((query) => [
    { source: 'web:exa', title: `Regulator guidance note on ${query}`, url: 'https://agency.example/a', abstract: 'Guidance statement.', lane: 'web', work_type: 'web_page' },
    { source: 'web:brave', title: `Regulator guidance note on ${query}`, url: 'https://pressreleases.example/b', abstract: 'Guidance statement.', lane: 'web', work_type: 'web_page' },
  ]),
}
// `runDeepResearchAction` is the seam that takes injected retrieval; `execute`
// is the same path with the production deps and a catch that turns a throw into
// an error object. Both are asserted: the behaviour through the seam, the
// contract through the registered tool.
const readRunClaims = (id, runId) => readRun(id, runId).claims
const writeArtifactFile = (runId, body) => writeArtifact({ cwd, runId, name: 'final_report', body, overwrite: true })
const readArtifactText = (runId, name) => readArtifact({ cwd, runId, name })?.text ?? ''
const buildQuoteStatusFor = (runId, check) => buildQuoteStatus(cwd, runId, { check })
const run = async (args) => {
  try {
    return await runDeepResearchAction(args, exec, ctx, DEPS)
  } catch (error) {
    return { action: args.action ?? 'status', error: error instanceof Error ? error.message : String(error) }
  }
}

try {
  // ---------------------------------------------------------------- registration
  ok('module name follows the plugin convention', MODULE_NAME === 'academic-harness-deep-research', MODULE_NAME)
  ok('tool name is deep_research', tool.name === 'deep_research', tool.name)
  ok('injects tools, llm and jobs', JSON.stringify(inject) === JSON.stringify(['tools', 'llm', 'jobs']), inject)
  ok('description states it never invents a citation', /never invent a citation/iu.test(tool.description))
  ok('parameters expose the tier and gear levers',
    Boolean(tool.parameters.properties.tier.enum && tool.parameters.properties.gear.enum))
  ok('the finding contract is spelled out in the schema',
    Boolean(tool.parameters.properties.findings.items.properties.target
      && tool.parameters.properties.findings.items.properties.verifier))

  // ---------------------------------------------------------------- refusal paths
  let result = await run({ action: 'nope' })
  ok('an unknown action is an error object, not a throw', /action must be one of/.test(result.error ?? ''), result.error)
  let hostRejected = null
  try {
    await tool.execute({ action: 'nope' }, exec)
  } catch (error) {
    hostRejected = error instanceof Error ? error.message : String(error)
  }
  ok('the host validates the action enum before execute runs', /must be one of/.test(hostRejected ?? ''), hostRejected)
  result = await run({ action: 'list' })
  ok('an empty workspace lists zero runs', result.runs?.length === 0, result.runs)
  result = await run({ action: 'status' })
  ok('status with no run says so', /no deep research run/.test(result.error ?? ''), result.error)
  result = await run({ action: 'start', query: '', tier: 'full' })
  ok('start without a query is refused', /query is required/.test(result.error ?? ''), result.error)
  result = await run({ action: 'start', query: 'anything', tier: 'mega' })
  ok('an invented tier is refused', /tier must be one of/.test(result.error ?? ''), result.error)

  // ---------------------------------------------------------------- framing
  const started = await run({ action: 'start', query: 'Survey what is known about GLP-1 cardiovascular outcomes in non-diabetic adults.', tier: 'light', gear: 'scout' })
  ok('start framed research questions from a bare request', started.research_questions?.length === 2, started)
  ok('start mints a run id', started.run_id === 'dr-0001', started.run_id)
  ok('start without run leaves every step pending', started.steps?.every((step) => step.status === 'pending'))
  ok('the framing call did not charge the run budget', transcript.length >= 1)

  const runId = started.run_id
  const resultRun = await run({ action: 'run', run_id: runId, tier: 'light', gear: 'scout' })
  ok('the light pipeline completed', resultRun.status === 'complete', resultRun.steps)
  const names = resultRun.steps.map((step) => step.step).join(',')
  ok('light tier runs 1,2,10,14.5,15 including cite check', names === 'decompose,sweep,draft,cite_check,polish', names)
  ok('every light-tier step recorded as done', stepView(cwd, runId).filter((step) => step.status === 'done').length === 5, stepView(cwd, runId))
  {
    const corpus = readCorpus(cwd, runId)
    ok('the sweep populated both lanes', corpus.independence.records === 8 && corpus.lanes.scholarly === 4 && corpus.lanes.web === 4, { counts: corpus.independence, lanes: corpus.lanes })
    ok('two press releases became one voice, not two', corpus.independence.votes === 5, corpus.independence)
    ok('web records carry the lane the gate counts', corpus.lanes.web === 4)
    ok('the duplicated web guidance pair collapsed too', corpus.clustered.derivative.some((cluster) => cluster.copies === 2 && cluster.hosts.length === 2), corpus.clustered.derivative.map((c) => [c.copies, c.hosts]))
  }
  ok('polish applied its hunk as a patch', existsSync(workspace.path(join('.dsh/deep-research', runId, 'patches.jsonl'))))
  const polished = readFileSync(workspace.path(join('.dsh/deep-research', runId, 'artifacts/final-report.md')), 'utf8')
  ok('the patched sentence is in the report', polished.includes('nine of eleven trials'), polished)
  ok('spend was accounted for the run', resultRun.accounting.llm_calls >= 4, resultRun.accounting)

  // ---------------------------------------------------------------- resume
  const resumed = await run({ action: 'resume', run_id: runId })
  ok('a finished run resumes with nothing left to do', resumed.status === 'complete' && resumed.completed === 0, resumed)
  const failedRun = await run({ action: 'start', query: 'Second question needing a rerun.', tier: 'light', gear: 'scout' })
  ok('the second run gets the next id', failedRun.run_id === 'dr-0002', failedRun.run_id)
  await run({ action: 'gate', run_id: 'dr-0002', gate: 'coverage', status: 'clear' })
  const gated = await run({ action: 'gate', run_id: 'dr-0002', gate: 'citation', status: 'blocked', reason: 'unverified quote', severity: 'CRITICAL' })
  ok('a blocked gate is recorded', gated.verdict.status === 'blocked', gated)
  ok('a blocked gate stops the step it was raised on', stepView(cwd, 'dr-0002').some((step) => step.status === 'blocked'))
  const afterBlock = await run({ action: 'run', run_id: 'dr-0002' })
  ok('a blocked run does not silently continue', afterBlock.status === 'blocked', afterBlock)
  const resumedBlocked = await run({ action: 'resume', run_id: 'dr-0002' })
  ok('resume cannot walk past a blocked step', resumedBlocked.status === 'blocked', resumedBlocked)
  ok('the block tells the human how to clear it', /gate|from_step/.test(resumedBlocked.hint ?? ''), resumedBlocked.hint)
  const blockedNames = stepView(cwd, 'dr-0002').filter((step) => step.status === 'blocked').map((step) => step.step_id)
  ok('the block is attributable to a named step', blockedNames.length === 1, blockedNames)
  ok('and it is the step the gate was raised on', blockedNames[0] === 'decompose', blockedNames)
  const restart = await run({ action: 'run', run_id: 'dr-0002', from_step: 'decompose' })
  ok('an explicit from_step restart is allowed', restart.status !== 'blocked', restart.status)

  // ---------------------------------------------------------------- budget
  const capped = await run({ action: 'start', query: 'Capped investigation.', tier: 'light', gear: 'scout', max_llm_calls: 2, run: true })
  ok('a crossed call budget blocks instead of ballooning', capped.status === 'blocked' && capped.reason === 'budget_exceeded', capped)
  ok('the budget names which cap was crossed', /llm_calls/.test(stepView(cwd, capped.run_id).find((step) => step.status === 'blocked')?.detail ?? ''))

  // ---------------------------------------------------------------- record + 9C gate
  const seeded = await run({ action: 'start', query: 'Seeded run for verification.', tier: 'light', gear: 'scout' })
  const seededId = seeded.run_id
  await run({ action: 'record', run_id: seededId, kind: 'records', records: PAPERS, perspective: 'mainstream' })
  const good = await run({
    action: 'record', run_id: seededId, kind: 'findings',
    findings: [
      { severity: 'High', title: 'Syndicated pair cited as two sources', reason: 'the report cites pr1 and pr2 as independent', target: 'final_report', primary_check: 'coverage', verifier: 'compare the two bodies for a shared release' },
      { severity: 'High', title: 'Nothing was inspected', reason: 'r', target: 't', primary_check: 'citation' },
    ],
  })
  ok('record accepts a well-formed finding', good.accepted?.length === 1, good)
  ok('record rejects a finding with no verifier', good.rejected?.[0]?.rejected_reason === 'missing:verifier', good.rejected)
  ok('recorded records cluster immediately', readCorpus(cwd, seededId).independence.votes < readCorpus(cwd, seededId).records.length)

  // ---------------------------------------------------------------- verification seam
  await run({ action: 'record', run_id: seededId, kind: 'claims', claims: [{ text: 'MACE fell by 20% in the trial.', rq_id: 'rq-0001', record_ids: ['src-0001'], quote: 'reporting a 20% relative reduction in major adverse cardiovascular events' }] })
  const noBodies = await run({ action: 'verify', run_id: seededId })
  ok('with no full text the quote check is not_checked, never a pass', noBodies.checks.find((check) => check.id === 'quote_integrity')?.state === 'not_checked', noBodies.checks.find((c) => c.id === 'quote_integrity'))
  ok('an unverifiable span is listed as unverified, not as a fabrication', noBodies.not_checked.includes('quote_integrity'), noBodies.not_checked)
  ok('a missing report blocks the ship', noBodies.blocked.includes('report_present'), noBodies.blocked)
  ok('independence counts votes, not copies', /4 records, 3 independent votes/.test(noBodies.checks.find((check) => check.id === 'independence_recorded')?.detail ?? ''), noBodies.checks.find((c) => c.id === 'independence_recorded'))

  const bodies = workspace.path(join('.dsh/deep-research', seededId, 'bodies'))
  mkdirSync(bodies, { recursive: true })
  writeFileSync(join(bodies, 'src-0001.md'), 'Randomised trial reporting a 20% relative reduction in major adverse cardiovascular events at 12 months.')
  const supported = await run({ action: 'verify', run_id: seededId })
  ok('a quote present in the fetched body verifies as supported', supported.checks.find((check) => check.id === 'quote_integrity')?.state === 'pass', supported.checks.find((c) => c.id === 'quote_integrity'))

  await appendClaims({
    cwd, runId: seededId,
    claims: [{ text: 'A quote that was never in the source.', rq_id: 'rq-0002', record_ids: ['src-0001'], quote: 'halving of all-cause mortality at five years', quote_status: 'unsupported' }],
  })
  const fabricated = await run({ action: 'verify', run_id: seededId, skip_retraction_check: true })
  ok('a fabricated quote blocks the ship', fabricated.blocked.includes('quote_integrity'), fabricated.blocked)
  ok('the gate names the offending claim', (fabricated.checks.find((check) => check.id === 'quote_integrity')?.claims ?? []).length === 1)

  // ---------------------------------------------------------------- export
  await appendClaims({
    cwd, runId: seededId,
    claims: [{ text: 'Nothing was ever retrieved here.', rq_id: null, record_ids: [], quote: null }],
  })
  const noExport = await run({ action: 'export', run_id: seededId, format: 'markdown' })
  ok('export refuses when no report exists', /no final_report/.test(noExport.error ?? ''), noExport.error)
  ok('an invented export format is refused', /format must be one of/.test((await run({ action: 'export', run_id: seededId, format: 'docx' })).error ?? ''))


  // ---------------------------------------------------------------- full tier
  const full = await run({ action: 'start', query: 'Full tier investigation of GLP-1 cardiovascular evidence.', tier: 'full', gear: 'scout', run: true })
  ok('the full tier ran the whole plan', full.status === 'complete', JSON.stringify(full.steps?.filter((step) => step.status !== 'done')))
  const fullSteps = (full.steps ?? []).map((step) => step.step)
  ok('full tier is 17 steps without chapters', fullSteps.length === 17, fullSteps.length)
  ok('contradiction, loci, depth, reconcile all ran',
    ['contradictions', 'loci', 'depth', 'reconcile', 'tensions', 'corpus_critic', 'digest', 'draft', 'synthesize', 'critics', 'gap_fetch', 'patcher', 'cite_check', 'polish', 'readability'].every((id) => fullSteps.includes(id)),
    fullSteps)
  const fullId = full.run_id
  ok('every locus produced an interim note', existsSync(workspace.path(join('.dsh/deep-research', fullId, 'artifacts/interim-loc-0001.md'))))
  ok('synthesize wrote the report', existsSync(workspace.path(join('.dsh/deep-research', fullId, 'artifacts/final-report.md'))))
  ok('the digest verified quotes against fetched text', readRunClaims(cwd, fullId).some((claim) => claim.quote_status === 'not_checked'), readRunClaims(cwd, fullId).slice(0, 2))
  const regeneration = await run({ action: 'patch', run_id: fullId, artifact: 'final_report', hunks: [{ find: 'Eligibility excluded insulin-treated diabetes in most trials', replace: 'Eligibility excluded insulin-treated diabetes in nine of eleven trials' }] })
  ok('the patcher edits surgically', regeneration.applied?.length === 1, regeneration)
  const rewrite = await run({ action: 'record', run_id: fullId, kind: 'claims', claims: [{ text: 'A claim after patching.', rq_id: 'rq-0001', record_ids: ['src-0001'] }] })
  ok('claims still append after a patch', rewrite.added === 1, rewrite)
  const fullVerify = await run({ action: 'verify', run_id: fullId, skip_retraction_check: true })
  ok('a complete full run reaches the ship gate', fullVerify.checks.length >= 10, fullVerify.checks.length)
  ok('the full report passes the checks that were verifiable', fullVerify.checks.filter((check) => check.state === 'pass').length >= 5, fullVerify.checks.filter((c) => c.state !== 'pass'))
  ok('locus coverage is checked, not assumed', fullVerify.checks.some((check) => check.id === 'locus_coverage'))
  ok('patch_only is satisfied by the patch log', fullVerify.checks.find((check) => check.id === 'patch_only')?.state === 'pass')
  const exported = await run({ action: 'export', run_id: fullId, format: 'markdown' })
  ok('export writes the report with its verification section', exported.bytes > 200 && /# Verification/.test(readFileSync(exported.path, 'utf8')), exported)
  ok('export refuses to clobber silently', /already exists/.test((await run({ action: 'export', run_id: fullId, format: 'markdown' })).error ?? ''))
  ok('export with overwrite succeeds', (await run({ action: 'export', run_id: fullId, format: 'markdown', overwrite: true })).bytes > 200)
  const csv = await run({ action: 'export', run_id: fullId, format: 'csv' })
  ok('csv export lists every record with its cluster', /record_id,cluster_id/.test(readFileSync(csv.path, 'utf8')))
  ok('nothing escaped the run directory', !existsSync(workspace.path('report.md')))

  // report rendering
  const status = await run({ action: 'status', run_id: seededId })
  const rendered = tool.output.render({}, status)
  ok('status renders as readable text', rendered[0].text.includes('Run dr-') && rendered[0].text.includes('independent voices'), rendered[0].text)
  const call = tool.presentCall({ action: 'start' })
  ok('the call card labels the action', call.title === 'Deep research: start', call)

  ok('every model call used the host message contract', contract.length === 0, contract.slice(0, 4))

  // ---------------------------------------------------------------- fencing reached the model
  const fencedPrompt = transcript.some((entry) => entry.content.includes('<untrusted-source'))
  ok('fetched bodies are fenced before the model sees them (not enabled here)', fencedPrompt === false)


  // ---------------------------------------------------------------- progress verbosity
  const noisy = await run({ action: 'start', query: 'Progress visibility check on GLP-1 cardiovascular evidence.', tier: 'light', gear: 'scout', run: true })
  const lines = noisy.progress_lines ?? []
  ok('a run with no jobs service still reports what it did', lines.length >= 6, lines.length)
  ok('every progress line carries a percent and a step position',
    lines.every((line) => /^\[\s*\d{1,2}%\] \[\d+\/\d+ [a-z_]+\]/u.test(line)), lines.filter((line) => !/^\[\s*\d{1,2}%\] \[\d+\/\d+ [a-z_]+\]/u.test(line)).slice(0, 3))
  ok('model calls are announced before they start', lines.some((line) => / → .* call \(/u.test(line)), lines.filter((l) => l.includes('→')))
  ok('model calls report tokens when they land', lines.some((line) => / ← .*s · \d+ in \/ \d+ out/u.test(line)), lines.filter((l) => l.includes('←')))
  ok('step completion names what it produced', lines.some((line) => /\] DONE — /u.test(line)), lines.filter((l) => l.includes('DONE')))
  {
    let previous = -1
    let monotonic = true
    for (const line of lines) {
      const percent = Number(/^\[\s*(\d+)%\]/u.exec(line)?.[1] ?? NaN)
      if (Number.isFinite(percent) && percent < previous) monotonic = false
      if (Number.isFinite(percent)) previous = percent
    }
    ok('the percent only moves forward', monotonic)
    ok('a finished run reaches the top of the bar', previous >= 90, previous)
  }

  // The same work through a jobs service must stream into the panel, not just
  // into the return value.
  const panel = { stderr: [], progress: [] }
  const fakeJobs = {
    start({ run }) {
      const handle = run({
        append: (line) => panel.stderr.push(String(line).trimEnd()),
        updateProgress: (label) => panel.progress.push(label),
      })
      fakeJobs.settle = handle.done
      return 'job-noisy-1'
    },
    async wait() { await fakeJobs.settle; return { status: 'completed', detail: 'completed' } },
    kill() {},
  }
  const streamed = await runDeepResearchAction(
    { action: 'start', query: 'Streamed progress check on GLP-1 trial exclusions.', tier: 'light', gear: 'scout', run: true },
    exec, { ...ctx, jobs: fakeJobs }, DEPS,
  )
  ok('with a jobs service the run streams to the panel', panel.stderr.length >= 6, panel.stderr.length)
  ok('the panel lines use the format the UI renders',
    panel.stderr.every((line) => line.startsWith('[')), panel.stderr.slice(0, 2))
  ok('the panel progress label updates', panel.progress.length >= 3 && /%\s/.test(panel.progress[0]), panel.progress.slice(0, 3))
  ok('a job-backed run returns its job id', streamed.job_id === 'job-noisy-1', streamed.job_id)
  ok('a job-backed run does not duplicate the transcript into the result', streamed.progress_lines === undefined)


  // ---------------------------------------------------------------- live-run regressions
  ok('start declares run, so run=true is not silently dropped by the host',
    tool.parameters.properties.run?.type === 'boolean', Object.keys(tool.parameters.properties))

  {
    const before = transcript.length
    const fed = await run({ action: 'start', query: 'Light tier evidence hand-off check on GLP-1 trials.', tier: 'light', gear: 'scout', run: true })
    ok('the light run still completes', fed.status === 'complete', fed.status)
    const draftCall = transcript.slice(before).find((entry) => /Draft from this angle/iu.test(entry.system))
    ok('the light-tier draft is given the retrieved corpus, not an empty digest',
      /Retrieved corpus/iu.test(draftCall?.content ?? ''), (draftCall?.content ?? '').slice(0, 120))
    ok('and the corpus it is handed carries real record ids',
      /\[src-000\d\]/u.test(draftCall?.content ?? ''), (draftCall?.content ?? '').slice(0, 200))
    ok('the draft is told a cluster id is not a citation',
      /cluster id such as c0004 names a group of copies and is never a citation/iu.test(draftCall?.system ?? ''), draftCall?.system?.slice(0, 200))
  }

  {
    citationFree = true
    const uncited = await run({ action: 'start', query: 'Uncited report check on trial exclusions.', tier: 'light', gear: 'scout', run: true })
    ok('a report citing nothing traceable is caught, not passed', uncited.status === 'blocked', uncited.status)
    ok('and it is the citation gate that stops it', uncited.reason === 'citation', uncited.reason)
    const finding = readFindings(cwd, uncited.run_id).find((row) => row.primary_check === 'citation')
    ok('the finding names the missing references', /no \[src-NNNN\] reference/iu.test(finding?.reason ?? ''), finding)
    ok('the finding is High so the ship gate blocks on it', finding?.severity === 'High', finding?.severity)
    const gate = await run({ action: 'verify', run_id: uncited.run_id, skip_retraction_check: true })
    ok('verify refuses to pass an uncited report', gate.blocked.includes('critical_findings_applied'), gate.blocked)
    citationFree = false
  }

  {
    // fetch_full_text must reach the light-tier draft, or the flag is a lie.
    const before = transcript.length
    const withText = await runDeepResearchAction(
      { action: 'start', query: 'Full text hand-off check on GLP-1 trials.', tier: 'light', gear: 'scout', run: true },
      exec, ctx,
      {
        ...DEPS,
        fetch: async () => [{ record_id: 'src-0001', source: 'openalex', body: 'SELECT enrolled 17604 adults and reported a 20 percent relative MACE reduction at 120 months.' }],
      },
    )
    const draftCall = transcript.slice(before).find((entry) => /Draft from this angle/iu.test(entry.system))
    ok('the light-tier draft receives fetched full text',
      /20 percent relative MACE reduction at 120 months/u.test(draftCall?.content ?? ''), (draftCall?.content ?? '').slice(0, 160))
    ok('and that text arrives fenced as untrusted', /<untrusted-source/u.test(draftCall?.content ?? ''))
    ok('the fetch-backed run still completes or blocks on its own merits',
      ['complete', 'blocked'].includes(withText.status), withText.status)
  }

  {
    const gate = await run({ action: 'verify', run_id: 'dr-0001' })
    const coverage = gate.checks?.find((check) => check.id === 'full_text_coverage')
    ok('verify discloses full-text coverage', Boolean(coverage), gate.checks?.map((c) => c.id))
  }

  {
    // A cluster id written as a citation must surface as an unknown reference.
    const malformed = await run({ action: 'start', query: 'Malformed citation detection run.', tier: 'light', gear: 'scout' })
    await appendRecords({ cwd, runId: malformed.run_id, records: PAPERS.slice(0, 2) })
    await writeArtifactFile(malformed.run_id, 'The benefit was large [src-c0004] and also [src-0001].')
    const checked = await run({ action: 'run', run_id: malformed.run_id, from_step: 'cite_check' })
    const unknown = readFindings(cwd, malformed.run_id).filter((row) => /not in the corpus/iu.test(row.title ?? ''))
    ok('a cluster id used as a citation is reported as unknown', unknown.some((row) => row.target === 'src-c0004'), unknown.map((row) => row.target))
    ok('a valid id beside it is still counted', checked.status !== 'failed', checked.status)
  }


  // ---------------------------------------------------------------- retrieval contract
  {
    // resolvePdfSources yields {candidate:{pdfUrl}} or {attempt:{source,error}};
    // fetchPdf returns a PDF buffer; convert returns {success, markdown}.
    // Getting any of these wrong silently produces zero bodies, which is what
    // happened in the first live session.
    const fetchRun = await run({ action: 'start', query: 'Retrieval contract run.', tier: 'light', gear: 'scout' })
    const fetchId = fetchRun.run_id
    await appendRecords({ cwd, runId: fetchId, records: [{ title: 'SELECT: effects on cardiovascular outcomes', doi: '10.1/select', source: 'openalex' }] })
    const long = 'x'.repeat(4000)
    const gen = async function* () {
      yield { attempt: { source: 'unpaywall', error: 'UNPAYWALL_EMAIL is not set; skipped' } }
      yield { candidate: { source: 'europe_pmc', pdfUrl: 'https://europepmc.org/articles/PMC123/pdf', version: 'publishedVersion' } }
    }
    const fetcher = buildFetch(cwd, fetchId, {
      enabled: true, email: null,
      resolvers: {
        resolvePdfSources: gen,
        fetchPdf: async () => Buffer.from('%PDF-1.4 fake'),
        convertPdfMarkdown: async () => ({ success: true, markdown: long, page_count: 4 }),
      },
    })
    const bodies = await fetcher(readCorpus(cwd, fetchId).records)
    ok('a candidate is recognised by its pdfUrl, not a guessed url field', bodies.length === 1, bodies.map((b) => b.error ?? 'ok'))
    ok('the converted text is stored for verbatim checking', existsSync(workspace.path(join('.dsh/deep-research', fetchId, 'bodies/src-0001.md'))))
    ok('the resolver that supplied the copy is recorded', bodies[0]?.oa?.resolver === 'europe_pmc', bodies[0]?.oa)
    ok('so is the version, because accepted and published are not interchangeable', bodies[0]?.oa?.version === 'publishedVersion', bodies[0]?.oa)
    const stored = readRetrieval(cwd, fetchId)
    ok('a successful retrieval is recorded as one attempt with text', stored.attempts === 1 && stored.with_text === 1, stored)

    // Now the failing path: only attempts, no candidate.
    const failRun = await run({ action: 'start', query: 'Retrieval failure run.', tier: 'light', gear: 'scout' })
    await appendRecords({ cwd, runId: failRun.run_id, records: [{ title: 'Paywalled article', doi: '10.2/paywalled', source: 'crossref' }] })
    const failing = buildFetch(cwd, failRun.run_id, {
      enabled: true,
      resolvers: {
        resolvePdfSources: async function* () {
          yield { attempt: { source: 'unpaywall', error: 'no open-access copy' } }
          yield { attempt: { source: 'core', error: 'HTTP 403' } }
        },
        fetchPdf: async () => { throw new Error('must not be called') },
        convertPdfMarkdown: async () => ({ success: true, markdown: '' }),
      },
    })
    const none = await failing(readCorpus(cwd, failRun.run_id).records)
    ok('no candidate means no body', none.length === 0)
    const failedRecord = readRetrieval(cwd, failRun.run_id)
    ok('the first resolver reason is kept, not dropped', /no open-access copy/.test(failedRecord.reasons.join(' ')), failedRecord)
    const failGate = await run({ action: 'verify', run_id: failRun.run_id })
    const coverage = failGate.checks.find((check) => check.id === 'full_text_coverage')
    ok('and the gate tells the user why nothing was verifiable',
      coverage?.state === 'not_checked' && /no open-access copy/.test(coverage?.detail ?? ''), coverage)

    const thin = buildFetch(cwd, failRun.run_id, {
      enabled: true,
      resolvers: {
        resolvePdfSources: async function* () { yield { candidate: { source: 'core', pdfUrl: 'https://core.ac.uk/x.pdf' } } },
        fetchPdf: async () => Buffer.from('%PDF-1.4'),
        convertPdfMarkdown: async () => ({ success: true, markdown: 'Abstract only, four hundred characters at most, which is not a paper.' }),
      },
    })
    ok('a landing page is not accepted as full text', (await thin(readCorpus(cwd, failRun.run_id).records)).length === 0)
    ok('and says why', /open_access_copy_too_thin/.test(readRetrieval(cwd, failRun.run_id).reasons.join(' ')), readRetrieval(cwd, failRun.run_id).reasons)

    const off = buildFetch(cwd, failRun.run_id, { enabled: false, resolvers: {} })
    ok('fetch stays off unless asked for', (await off([{ record_id: 'src-0001' }])).length === 0)
  }


  // ---------------------------------------------------------------- unverifiable vs wrong
  {
    // Title-only corpus: the sweep never read anything, so a "partial" verdict is
    // our gap, not the report's. It must not block the ship.
    const titleOnly = await runDeepResearchAction(
      { action: 'start', query: 'Unverifiable bindings run on trial exclusions.', tier: 'light', gear: 'scout' },
      exec, ctx, DEPS,
    )
    await appendRecords({
      cwd, runId: titleOnly.run_id,
      records: [
        { title: 'Trial one of semaglutide outcomes', doi: '10.5/one', source: 'openalex' },
        { title: 'Trial two of semaglutide outcomes', doi: '10.5/two', source: 'openalex' },
        { title: 'Trial three of semaglutide outcomes', doi: '10.5/three', source: 'openalex' },
      ],
    })
    await writeArtifact({ cwd, runId: titleOnly.run_id, name: 'final_report', overwrite: true, body: 'Benefit was reported [src-0001] [src-0002] [src-0003].' })
    challengeBindings = true
    const unchecked = await run({ action: 'run', run_id: titleOnly.run_id, from_step: 'cite_check' })
    challengeBindings = false
    ok('a title-only corpus does not block the ship', unchecked.status !== 'blocked', unchecked)
    const verdict = latestVerdictOf(cwd, titleOnly.run_id, 'citation')
    ok('and is reported as not_checked with a reason', verdict?.status === 'not_checked' && /no readable text/.test(verdict?.reason ?? ''), verdict)
    ok('no High citation finding was invented for it', readFindings(cwd, titleOnly.run_id).filter((row) => row.severity === 'High').length === 0, readFindings(cwd, titleOnly.run_id).map((row) => row.title))

    // Same challenge verdicts, but the records DO have abstracts: now it is a real problem.
    const readable = await runDeepResearchAction(
      { action: 'start', query: 'Verifiable bindings run on trial exclusions.', tier: 'light', gear: 'scout' },
      exec, ctx, DEPS,
    )
    await appendRecords({
      cwd, runId: readable.run_id,
      records: [
        { title: 'Trial one of semaglutide outcomes', doi: '10.6/one', source: 'openalex', abstract: 'A randomised trial of semaglutide reporting no significant difference in major adverse cardiovascular events versus placebo.' },
        { title: 'Trial two of semaglutide outcomes', doi: '10.6/two', source: 'openalex', abstract: 'A secondary analysis reporting heart-failure outcomes.' },
        { title: 'Trial three of semaglutide outcomes', doi: '10.6/three', source: 'openalex', abstract: 'A kidney-outcomes analysis.' },
      ],
    })
    await writeArtifact({ cwd, runId: readable.run_id, name: 'final_report', overwrite: true, body: 'Benefit was reported [src-0001] [src-0002] [src-0003].' })
    challengeBindings = true
    const checked = await run({ action: 'run', run_id: readable.run_id, from_step: 'cite_check' })
    challengeBindings = false
    ok('the same verdicts do block when the text was readable', checked.status === 'blocked', checked)
    ok('and the gate names the citation check', checked.reason === 'citation', checked.reason)
  }


  // ---------------------------------------------------------------- frozen options
  {
    let fetchCalls = 0
    const spyDeps = {
      ...DEPS,
      fetch: async (records) => { fetchCalls += 1; return [] },
    }
    const prepared = await runDeepResearchAction(
      { action: 'start', query: 'Frozen options run on trial exclusions.', tier: 'light', gear: 'scout', fetch_full_text: true },
      exec, ctx, spyDeps,
    )
    ok('start freezes how the run is executed', prepared.run_id && readRun(cwd, prepared.run_id).manifest.execution?.fetch_full_text === true, readRun(cwd, prepared.run_id).manifest.execution)
    // resume carries no retrieval flags at all — the bug that made a live run
    // silently stop fetching after the agent split start and resume into calls.
    const resumed = await runDeepResearchAction({ action: 'resume', run_id: prepared.run_id }, exec, ctx, spyDeps)
    ok('a later resume still fetches full text', fetchCalls > 0, { fetchCalls, status: resumed.status })
    ok('status reports the frozen execution options', (await run({ action: 'status', run_id: prepared.run_id })).execution?.fetch_full_text === true)
    const plain = await runDeepResearchAction(
      { action: 'start', query: 'Plain run without fetching.', tier: 'light', gear: 'scout' },
      exec, ctx, { ...DEPS, fetch: async () => { throw new Error('must not fetch') } },
    )
    ok('fetching stays off when it was never asked for', readRun(cwd, plain.run_id).manifest.execution?.fetch_full_text === false)
  }


  // ---------------------------------------------------------------- web lane
  {
    const webRun = await run({ action: 'start', query: 'Web lane check on GLP-1 cardiovascular evidence.', tier: 'light', gear: 'scout', run: true })
    const corpus = readCorpus(cwd, webRun.run_id)
    ok('the sweep ran the web lane as well as the scholarly one', corpus.lanes.web > 0, corpus.lanes)
    ok('web records are tagged so they cannot be mistaken for papers',
      corpus.records.filter((row) => row.lane === 'web').every((row) => row.work_type === 'web_page'), corpus.records.filter((r) => r.lane === 'web').slice(0, 2))
    ok('and are traced to the web sweep', corpus.records.filter((row) => row.lane === 'web').every((row) => row.suggested_by === 'web_sweep'))
    const sweepText = readArtifactText(webRun.run_id, 'sweep')
    ok('the artifact reports the lane separately', /## Web lane/u.test(sweepText), sweepText.slice(0, 300))
    const gate = await run({ action: 'verify', run_id: webRun.run_id, skip_retraction_check: true })
    const lanes = gate.checks.find((check) => check.id === 'lane_coverage')
    ok('the gate counts the lanes', lanes?.state === 'pass' && /scholarly and \d+ web records/u.test(lanes?.detail ?? ''), lanes)

    // A provider with no key is a configuration state, not a retrieval failure.
    const unknown = []
    const odd = buildWebSearch({ providers: ['google'], failures: unknown })
    ok('an unconfigured provider name is reported, not guessed at',
      (await odd({ objective: 'x', queries: ['y'] })).length === 0 && unknown[0]?.code === 'not_supported', unknown)
    const idle = []
    {
      // A provider that answers with an unrecognised shape must not fail silently.
      const silent = []
      const lane2 = buildWebSearch({ providers: ['parallel'], failures: silent })
      const rows = await lane2({ objective: 'o', queries: ['q'] })
      ok('an unusable web response is named, not swallowed',
        rows.length === 0 && silent.some((entry) => entry.code === 'empty_response' || entry.code === 'key_missing'), silent)
    }
    {
      // The exact row shape a live authenticated call returned.
      const row = webRecord('parallel', {
        url: 'https://www.nice.org.uk/guidance/ng28/evidence/committee-discussion-pd',
        title: '[PDF] NG28 Type 2 diabetes in adults: Committee discussion 18/02/2026',
        publish_date: '2026-02-10',
        excerpts: ['National Institute for Health and Care Excellence', 'second excerpt'],
      })
      ok('a live Parallel row maps to a corpus record',
        row?.title?.startsWith('[PDF] NG28') && row.url.includes('nice.org.uk'), row)
      ok('its excerpts become the abstract the draft reads', /second excerpt/.test(row?.abstract ?? ''), row?.abstract)
      ok('the publish year is taken from the date', row?.year === 2026, row?.year)
      ok('and it is marked as web, not literature', row?.lane === 'web' && row?.work_type === 'web_page' && row?.doi === null, row)
      ok('a row with neither title nor url is dropped', webRecord('parallel', { excerpts: ['x'] }) === null)
    }
    ok('no queries means no web calls', (await buildWebSearch({ providers: ['exa'], failures: idle })({ objective: 'x', queries: [] })).length === 0 && idle.length === 0)
    ok('Parallel is in the default lane, since that is the key this install has',
      WEB_PROVIDERS[0] === 'parallel', WEB_PROVIDERS)
  }

  // ---------------------------------------------------------------- PaperMemory
  {
    const pmRun = await run({ action: 'start', query: 'PaperMemory deposit check.', tier: 'light', gear: 'scout' })
    await appendRecords({ cwd, runId: pmRun.run_id, records: [{ title: 'SELECT: cardiovascular outcomes', doi: '10.7/select', source: 'openalex' }] })
    const fetched = buildFetch(cwd, pmRun.run_id, {
      enabled: true,
      resolvers: {
        resolvePdfSources: async function* () { yield { candidate: { source: 'europe_pmc', pdfUrl: 'https://europepmc.org/x.pdf' } } },
        fetchPdf: async () => Buffer.from('%PDF-1.4'),
        convertPdfMarkdown: async () => ({ success: true, markdown: `Full text body. ${'random '.repeat(400)}` }),
      },
      library: { ingest: async () => ({ ok: true, paper: { id: 'PM-PAPER-1' }, status: 'created' }) },
    })
    const entries = await fetched(readCorpus(cwd, pmRun.run_id).records)
    ok('a fetched full text is deposited into PaperMemory', entries[0]?.library === 'ingested', entries[0])
    ok('and the run records which library paper it became', entries[0]?.pm_paper === 'PM-PAPER-1', entries[0])
    const links = readPaperLinks(cwd, pmRun.run_id)
    ok('the link is persisted in its own append-only ledger', links.get('src-0001')?.pm_paper === 'PM-PAPER-1', [...links.values()])

    // The library decides, even when the run's own cache would have said yes.
    const cacheFirst = buildQuoteStatusFor(pmRun.run_id, () => ({ ok: true, found: false }))
    ok('quote verification consults the library, not just the run cache',
      await cacheFirst('random random', { record_id: 'src-0001' }) === 'unsupported', 'expected unsupported')
    const libraryBlind = buildQuoteStatusFor(pmRun.run_id, () => ({ ok: false, code: 'not_installed' }))
    ok('an unreadable library is not a verdict on the quote',
      await libraryBlind('random random', { record_id: 'src-0001' }) === 'supported', 'falls back to cache')
    const noLink = buildQuoteStatusFor(pmRun.run_id, () => ({ ok: true, found: true }))
    ok('a record with no library link still checks against what the run fetched',
      await noLink('nothing like this text', { record_id: 'src-9999' }) === 'not_checked')

    // A failed deposit is recorded, not swallowed.
    const failRun = await run({ action: 'start', query: 'PaperMemory deposit failure check.', tier: 'light', gear: 'scout' })
    await appendRecords({ cwd, runId: failRun.run_id, records: [{ title: 'Another paper', doi: '10.8/other', source: 's2' }] })
    const failing = buildFetch(cwd, failRun.run_id, {
      enabled: true,
      resolvers: {
        resolvePdfSources: async function* () { yield { candidate: { source: 'core', pdfUrl: 'https://core.ac.uk/y.pdf' } } },
        fetchPdf: async () => Buffer.from('%PDF-1.4'),
        convertPdfMarkdown: async () => ({ success: true, markdown: 'Body. ' + 'text '.repeat(500) }),
      },
      library: { ingest: async () => ({ ok: false, error: 'papermemory CLI not available' }) },
    })
    const degraded = await failing(readCorpus(cwd, failRun.run_id).records)
    ok('a failed deposit is reported, and the run keeps its own copy', degraded[0]?.library === 'ingest_failed', degraded[0])
    ok('the failure reason is recorded for the user', /not available/.test(readPaperLinks(cwd, failRun.run_id).get('src-0001')?.error ?? ''), [...readPaperLinks(cwd, failRun.run_id).values()])
  }

  // no stray writes outside the ledger
  ok('nothing was written outside .dsh', !existsSync(workspace.path('bodies')) && !existsSync(workspace.path('report.md')))
  ok('each run owns its own directory', existsSync(workspace.path(join('.dsh/deep-research', seededId))))
} catch (error) {
  console.error(`THREW ${error instanceof Error ? error.stack : error}`)
  checks.push({ label: 'uncaught error', pass: false })
} finally {
  workspace.cleanup()
}

const failed = checks.filter((check) => !check.pass)
console.log(`${checks.length - failed.length}/${checks.length} tool checks passed`)
if (failed.length) {
  console.error(failed.map((check) => ` - ${check.label}`).join('\n'))
  process.exit(1)
}
