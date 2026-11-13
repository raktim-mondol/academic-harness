import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorkspace } from './helpers/test-workspace.mjs'
import { accounting, appendClaims, appendFindings, appendRecords, appendRetrieval, applyHunks, assertGospel, budgetState, displayHash, latestVerdict, listRuns, markFindingApplied, markStep, nextPendingStep, readArtifact, readCorpus, readFindings, readQuery, readRetrieval, readRun, recordSegment, recordUsage, recordVerdict, shipGate, startRun, stepView, supersedeFindings, writeArtifact } from '../deep-research-store.js'

const workspace = makeWorkspace('ah-deep-research-store-')
const cwd = workspace.cwd
const checks = []
const ok = (label, condition, detail) => {
  checks.push({ label, pass: Boolean(condition) })
  if (!condition) console.error(`FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const QUERY = 'Survey what is known about GLP-1 receptor agonists and cardiovascular outcomes in non-diabetic adults.'
const BRIEF = {
  topic: 'GLP-1 cardiovascular outcomes without diabetes',
  research_questions: [
    'Does randomised evidence support cardiovascular benefit in non-diabetic adults?',
    'What is the magnitude of the effect?',
    'Who is excluded from the trials that answer this?',
  ],
  angle: 'benefit claims outran the populations studied',
  reader: 'clinical investigator',
  register: 'analyze',
}
const PLAN = [
  { id: 'decompose', name: 'Decompose' },
  { id: 'sweep', name: 'Width sweep' },
  { id: 'digest', name: 'Evidence digest' },
  { id: 'draft', name: 'Draft' },
  { id: 'synthesize', name: 'Synthesize' },
  { id: 'critics', name: 'Adversarial critics' },
  { id: 'patcher', name: 'Patcher' },
  { id: 'cite_check', name: 'Cite check' },
  { id: 'polish', name: 'Polish' },
]

try {
  // ------------------------------------------------------------ the frozen query
  let threw = null
  try {
    await startRun({ cwd, query: 'CRISPR clinical progress', brief: { topic: 'CRISPR' }, plan: PLAN })
  } catch (error) { threw = error.message }
  ok('a topic without research questions is refused', /at least one research question/.test(threw ?? ''), threw)

  const manifest = await startRun({ cwd, query: QUERY, brief: BRIEF, tier: 'full', plan: PLAN })
  ok('run id follows the ledger convention', manifest.run_id === 'dr-0001', manifest.run_id)
  ok('query is stored verbatim', readQuery(cwd, manifest.run_id) === QUERY)
  ok('RQ ids are minted in order', manifest.brief.research_questions.map((rq) => rq.rq_id).join(',') === 'rq-0001,rq-0002,rq-0003')
  ok('the plan is frozen into the manifest', manifest.plan.length === PLAN.length && manifest.plan[0].order === 1)
  ok('query file is on disk', existsSync(join(cwd, '.dsh', 'deep-research', 'dr-0001', 'query.md')))
  ok('gospel accepts the run query', assertGospel(cwd, manifest.run_id, QUERY).ok === true)
  ok('gospel refuses a paraphrase', assertGospel(cwd, manifest.run_id, 'Survey GLP-1 and the heart.').code === 'query_drift')
  ok('display hash is 16 chars', displayHash(manifest.query.hash).length === 16)

  const second = await startRun({ cwd, query: 'Second topic', brief: { topic: 'b', research_questions: ['q?'] }, plan: PLAN })
  ok('the next run gets the next id', second.run_id === 'dr-0002', second.run_id)
  ok('listRuns returns newest first', listRuns(cwd)[0].run_id === 'dr-0002')
  ok('listRuns carries step state', listRuns(cwd)[0].steps.length === PLAN.length)

  // Two runs can share a millisecond; the tie must not fall back to readdir order.
  const sameStamp = '2026-01-01T00:00:00.000Z'
  for (const runId of ['dr-0001', 'dr-0002']) {
    const file = join(cwd, '.dsh', 'deep-research', runId, 'manifest.json')
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    manifest.created_at = sameStamp
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  ok('listRuns breaks an identical timestamp by run id', listRuns(cwd)[0].run_id === 'dr-0002')

  // ------------------------------------------------------------ step state, resume
  ok('every step starts pending', stepView(cwd, 'dr-0001').every((step) => step.status === 'pending'))
  ok('the first pending step is the resume point', nextPendingStep(cwd, 'dr-0001').step_id === 'decompose')

  threw = null
  try { await markStep({ cwd, runId: 'dr-0001', step: 'not_in_plan', status: 'done' }) } catch (error) { threw = error.message }
  ok('an off-plan step is refused', /not in the plan/.test(threw ?? ''), threw)

  threw = null
  try { await markStep({ cwd, runId: 'dr-0001', step: 'decompose', status: 'complete' }) } catch (error) { threw = error.message }
  ok('an unknown step status is refused', /step status must be one of/.test(threw ?? ''), threw)

  await markStep({ cwd, runId: 'dr-0001', step: 'decompose', status: 'done' })
  await markStep({ cwd, runId: 'dr-0001', step: 'sweep', status: 'done' })
  await markStep({ cwd, runId: 'dr-0001', step: 'digest', status: 'failed', detail: 'provider_blocked' })
  ok('resume lands on the failed step', nextPendingStep(cwd, 'dr-0001').step_id === 'digest')
  ok('resume names the remedy', /re-runs this step/.test(nextPendingStep(cwd, 'dr-0001').reason))
  await markStep({ cwd, runId: 'dr-0001', step: 'digest', status: 'running' })
  ok('a step left running is restarted, not skipped', /left running/.test(nextPendingStep(cwd, 'dr-0001').reason))
  await markStep({ cwd, runId: 'dr-0001', step: 'digest', status: 'blocked', detail: 'corpus too thin' })
  ok('blocked outranks everything else', nextPendingStep(cwd, 'dr-0001').step_id === 'digest')
  ok('the state log is append-only', readJsonlCount(join(cwd, '.dsh', 'deep-research', 'dr-0001', 'state.jsonl')) > PLAN.length)

  // ------------------------------------------------------------ corpus and independence
  const corpus = await appendRecords({
    cwd,
    runId: 'dr-0001',
    perspective: 'mainstream',
    records: [
      { source: 'openalex', doi: '10.1/lead', title: 'Cardiovascular outcomes with semaglutide', year: 2024, citation_count: 400, url: 'https://journal.example/a' },
      { source: 's2', doi: 'https://doi.org/10.1/LEAD', title: 'Cardiovascular outcomes with semaglutide', year: 2024, citation_count: 380, url: 'https://search.example/b' },
      { source: 'news', title: 'Press release: Cardiovascular outcomes with semaglutide', url: 'https://pr1.example/c' },
      { source: 'news', title: 'Press release: Cardiovascular outcomes with semaglutide', url: 'https://pr2.example/d' },
      { source: 'news', title: 'Press release: Cardiovascular outcomes with semaglutide', url: 'https://pr3.example/e' },
      { source: 'crossref', doi: '10.9/other', title: 'Trial design and exclusion criteria in obesity cardiovascular trials', year: 2023, url: 'https://journal.example/f' },
    ],
  })
  ok('records are minted with the src- prefix', corpus.records[0].record_id === 'src-0001')
  ok('six records entered the ledger', corpus.added === 6)
  ok('six records became three independent votes', corpus.independence.votes === 3, corpus.independence)
  ok('redundancy is counted, not hidden', corpus.independence.redundant_records === 3)
  ok('the singleton is independent', corpus.records[5].independent === true)
  ok('a syndicated copy is not', corpus.records[2].independent === false)
  ok('suggested_by defaults to seed', corpus.records[0].suggested_by === 'seed')
  ok('perspective is recorded per sweep', corpus.records[0].perspective === 'mainstream')

  const refetched = await appendRecords({
    cwd, runId: 'dr-0001', suggestedBy: 'src-0001',
    records: [{ source: 'pubmed', doi: '10.1/lead', title: 'Cardiovascular outcomes with semaglutide', year: 2024, citation_count: 401 }],
  })
  ok('a re-find gets a new record id', refetched.records[0].record_id === 'src-0007')
  ok('and joins the existing cluster', refetched.records[0].cluster_id === corpus.records[0].cluster_id)
  ok('provenance points at what surfaced it', refetched.records[0].suggested_by === 'src-0001')
  const reread = readCorpus(cwd, 'dr-0001')
  ok('clusters are recomputed on read', reread.clustered.clusters.find((c) => c.cluster_id === corpus.records[0].cluster_id).copies === 3)
  ok('votes rise only for genuinely new work', reread.independence.votes === 3)
  threw = null
  try { await appendRecords({ cwd, runId: 'dr-0001', records: [{ source: 'x' }] }) } catch (error) { threw = error.message }
  ok('a record with no title is refused', /record title is required/.test(threw ?? ''), threw)

  // ------------------------------------------------------------ claims and findings
  const claims = await appendClaims({
    cwd, runId: 'dr-0001',
    claims: [
      { rq_id: 'rq-0001', text: 'One large trial reports benefit.', record_ids: ['src-0001'], quote: 'reduced MACE by 20%' },
      { rq_id: 'rq-0002', text: 'Effect size is around 20% relative.', record_ids: ['src-0001'] },
    ],
  })
  ok('claims get cl- ids', claims[0].claim_id === 'cl-0001')
  ok('an unverified quote is not_checked, never assumed', claims[0].quote_status === 'not_checked')

  const findings = await appendFindings({
    cwd, runId: 'dr-0001', stepId: 'critics',
    findings: [
      { severity: 'High', title: 'Excluded population unstated', reason: 'section 3 claims benefit for all adults; the trial excluded diabetics', target: 'final_report#section-3', primary_check: 'coverage', verifier: 'read the trial eligibility box' },
      { severity: 'Medium', title: 'Valid finding two', reason: 'inspected and bounded', target: 'final_report#section-4', primary_check: 'calibration', verifier: 'compare wording to the CI' },
      { severity: 'Medium', title: 'Duplicate of two', reason: 'same target and check', target: 'final_report#section-4', primary_check: 'calibration', verifier: 'same again' },
      { severity: 'High', title: 'Unobserved gap', reason: 'nothing was checked', target: 'final_report#section-9', primary_check: 'citation', verifier: 'v', evidence_state: 'unobserved' },
      { severity: 'High', title: 'No verifier', reason: 'r', target: 't', primary_check: 'p' },
      { title: 'No severity', reason: 'r', target: 't2', primary_check: 'p2', verifier: 'v' },
    ],
  })
  ok('eligible findings are accepted', findings.accepted.length === 2, findings.accepted.length)
  ok('a duplicate on target+check is rejected', findings.rejected.some((row) => row.rejected_reason === 'duplicate_target_check'))
  ok('unobserved evidence never becomes a finding', findings.rejected.some((row) => row.rejected_reason === 'unobserved_evidence'))
  ok('a finding without a verifier is rejected', findings.rejected.some((row) => /missing:verifier/.test(row.rejected_reason)))
  ok('a finding without severity is rejected', findings.rejected.some((row) => /missing:severity/.test(row.rejected_reason)))
  ok('accepted findings carry the 9C shape', Boolean(findings.accepted[0].target && findings.accepted[0].primary_check && findings.accepted[0].verifier))
  ok('rejection reasons are recorded, not discarded', readFindings(cwd, 'dr-0001').length === 2)

  // Close the Medium finding only: the High one must stay open to prove the gate blocks.
  await markFindingApplied({ cwd, runId: 'dr-0001', findingId: findings.accepted[1].finding_id, patchId: 'p-0001' })
  ok('a finding moves to applied', readFindings(cwd, 'dr-0001').find((row) => row.finding_id === findings.accepted[1].finding_id).status === 'applied')

  // ------------------------------------------------------------ patch, never regenerate
  await writeArtifact({ cwd, runId: 'dr-0001', name: 'final_report', step: 'synthesize', body: '# Report\n\nBenefit is established in adults.\n\nThe trial showed reduced MACE by 20%.\n' })
  ok('artifact is written', readArtifact({ cwd, runId: 'dr-0001', name: 'final_report' }).chars > 0)

  const patch = await applyHunks({
    cwd, runId: 'dr-0001', artifact: 'final_report', findingId: 'f-0001',
    hunks: [{ find: 'Benefit is established in adults.', replace: 'Benefit is established in adults without diabetes.' }],
  })
  ok('a surgical hunk applies', patch.applied.length === 1 && patch.patch_id === 'p-0001')
  ok('the artifact changed on disk', readArtifact({ cwd, runId: 'dr-0001', name: 'final_report' }).text.includes('without diabetes'))
  ok('the patch records before and after hashes', patch.before !== patch.after)

  threw = null
  try {
    await writeArtifact({ cwd, runId: 'dr-0001', name: 'final_report', overwrite: true, body: '# Brand new report written from scratch\n' })
  } catch (error) { threw = error.message }
  ok('regeneration after patching is refused', /must be hunks, not a rewrite/.test(threw ?? ''), threw)

  const escalations = await applyHunks({
    cwd, runId: 'dr-0001', artifact: 'final_report',
    hunks: [
      { find: 'text that is not in the document', replace: 'x' },
      // A one-character hunk matches many places: it must be refused, not
      // silently applied to whichever occurrence the store happened to find.
      { find: 'a', replace: 'y' },
      { find: 'x'.repeat(5000), replace: 'y' },
    ],
  })
  ok('absent context escalates', escalations.escalated.some((entry) => entry.reason === 'context_not_found'))
  ok('ambiguous context escalates', escalations.escalated.some((entry) => entry.reason === 'context_ambiguous'))
  ok('an oversized hunk escalates', escalations.escalated.some((entry) => entry.reason === 'hunk_escalated'))
  ok('nothing applied means nothing patched', escalations.applied.length === 0 && escalations.changed === 0)
  const budgeted = await applyHunks({
    cwd, runId: 'dr-0001', artifact: 'final_report', maxHunks: 2,
    hunks: Array.from({ length: 9 }, () => ({ find: 'y', replace: 'z' })),
  })
  ok('a rewrite-shaped patch budget is refused outright', budgeted.escalated[0]?.reason === 'patch_budget', budgeted.escalated)

  // ------------------------------------------------------------ budget
  await recordUsage({ cwd, runId: 'dr-0001', llmCalls: 5, inputTokens: 1000, outputTokens: 200, step: 'sweep' })
  await recordUsage({ cwd, runId: 'dr-0001', llmCalls: 3, inputTokens: 500, outputTokens: 100, step: 'draft' })
  const spend = accounting(cwd, 'dr-0001')
  ok('spend accumulates across steps', spend.llm_calls === 8 && spend.input_tokens === 1500, spend)
  ok('accounting reports sources and votes', spend.sources === 7 && spend.votes === 3, spend)
  ok('open findings are counted', spend.open_findings === 1)

  const capped = await startRun({
    cwd, query: 'Capped run', brief: { topic: 'cap', research_questions: ['q?'] }, plan: PLAN,
    budget: { max_llm_calls: 3 },
  })
  await recordUsage({ cwd, runId: capped.run_id, llmCalls: 4 })
  ok('an exceeded call budget blocks', budgetState(cwd, capped.run_id).exceeded === true)
  await recordUsage({ cwd, runId: capped.run_id, llmCalls: 0 })
  ok('the budget check names which cap', budgetState(cwd, capped.run_id).checks[0].kind === 'llm_calls')
  ok('an uncapped run is never exceeded', budgetState(cwd, 'dr-0001').exceeded === false)

  {
    // Calendar time is not execution time: a resumed run must not inherit idle
    // hours spent blocked or with the host shut down.
    const timed = await startRun({
      cwd, query: 'Timed resume check.', brief: { topic: 'timed', research_questions: ['q?'] }, plan: PLAN,
      budget: { timeout_minutes: 1 },
    })
    ok('a fresh run has no active time', budgetState(cwd, timed.run_id).exceeded === false)
    await recordSegment({ cwd, runId: timed.run_id, startedAt: Date.now() - 150_000, endedAt: Date.now(), kind: 'run' })
    const timedState = budgetState(cwd, timed.run_id)
    const wall = timedState.checks.find((check) => check.kind === 'wall_minutes')
    ok('active execution time is counted in minutes, not tenths', wall?.used === 3 || wall?.used === 2, wall)
    ok('a run over its active-time cap is blocked', timedState.exceeded === true, timedState)
    ok('active time is reported from segments, not wall-clock creation time', accounting(cwd, timed.run_id).active_ms >= 150_000, accounting(cwd, timed.run_id))
    ok('elapsed calendar time is reported separately', typeof accounting(cwd, timed.run_id).elapsed_ms === 'number')
    const extra = budgetState(cwd, timed.run_id, { extraMs: 60_000 })
    ok('the current invocation time is added during a run', extra.checks.find((check) => check.kind === 'wall_minutes').used >= 3, extra)
  }


  {
    // A re-run must retire the findings it raised against the earlier text, or the
    // gate keeps blocking a report that has since been fixed.
    const rerun = await startRun({ cwd, query: 'Stale finding retirement check.', brief: { topic: 'stale', research_questions: ['q?'] }, plan: PLAN })
    const made = await appendFindings({
      cwd, runId: rerun.run_id, stepId: 'critics',
      findings: [
        { severity: 'High', title: 'Real problem', reason: 'inspected', target: 'final_report#a', primary_check: 'citation', verifier: 'v' },
        { severity: 'Medium', title: 'Smaller problem', reason: 'inspected', target: 'final_report#b', primary_check: 'calibration', verifier: 'v' },
      ],
    })
    ok('findings start open', readFindings(cwd, rerun.run_id).every((row) => row.status === 'open'))
    const retired = await supersedeFindings({ cwd, runId: rerun.run_id, stepId: 'critics' })
    ok('a re-run retires its own prior findings', retired.superseded === 2, retired)
    ok('and they are no longer open', readFindings(cwd, rerun.run_id).every((row) => row.status === 'superseded'))
    const gate = await shipGate({ cwd, runId: rerun.run_id, deps: { quoteStatus: undefined, retractionFor: () => ({ retracted: false }), consensusClaimed: () => false } })
    ok('superseded findings do not block the ship', !gate.blocked.includes('critical_findings_applied'), gate.blocked)
    ok('a second retirement is a no-op', (await supersedeFindings({ cwd, runId: rerun.run_id, stepId: 'critics' })).superseded === 0)
    ok('another step still owns its findings', (await supersedeFindings({ cwd, runId: rerun.run_id, stepId: 'digest' })).superseded === 0)
    const raisedAgain = await appendFindings({
      cwd, runId: rerun.run_id, stepId: 'critics',
      findings: [{ severity: 'High', title: 'Real problem again', reason: 'the same defect is still in the new text', target: 'final_report#a', primary_check: 'citation', verifier: 'v' }],
    })
    ok('a superseded issue can be raised again by a later review', raisedAgain.accepted.length === 1, raisedAgain)
  }

  {
    // A finding is tied to the report bytes it graded. A patched report must not
    // look current, and a rerun of the affected step must be required.
    const stale = await startRun({ cwd, query: 'Stale finding check.', brief: { topic: 'stale2', research_questions: ['q?'] }, plan: PLAN })
    await writeArtifact({ cwd, runId: stale.run_id, name: 'final_report', step: 'synthesize', body: '# Report\n\nBenefit is established.\n' })
    const first = await appendFindings({
      cwd, runId: stale.run_id, stepId: 'critics',
      findings: [{ severity: 'High', title: 'Benefit overstated', reason: 'inspection found no trial', target: 'final_report#benefit', primary_check: 'coverage', verifier: 'read the cited trial' }],
    })
    const beforePatch = await shipGate({ cwd, runId: stale.run_id, deps: { quoteStatus: undefined, retractionFor: () => ({ retracted: false }), consensusClaimed: () => false } })
    ok('a High finding blocks the report it was raised against', beforePatch.blocked.includes('critical_findings_applied'), beforePatch.blocked)
    await applyHunks({ cwd, runId: stale.run_id, artifact: 'final_report', findingId: first.accepted[0].finding_id, hunks: [{ find: 'Benefit is established.', replace: 'Benefit is not established in this report.' }] })
    const afterPatch = await shipGate({ cwd, runId: stale.run_id, deps: { quoteStatus: undefined, retractionFor: () => ({ retracted: false }), consensusClaimed: () => false } })
    ok('a patched report does not pass on the earlier report’s finding', afterPatch.blocked.includes('findings_current'), afterPatch.blocked)
    ok('and the stale finding is not relabelled as current', afterPatch.checks.find((check) => check.id === 'critical_findings_applied')?.state === 'pass', afterPatch.checks.find((check) => check.id === 'critical_findings_applied'))
    await markFindingApplied({ cwd, runId: stale.run_id, findingId: first.accepted[0].finding_id, patchId: 'p-test' })
    const closed = await shipGate({ cwd, runId: stale.run_id, deps: { quoteStatus: undefined, retractionFor: () => ({ retracted: false }), consensusClaimed: () => false } })
    ok('closing the finding clears the stale block', !closed.blocked.includes('findings_current') && !closed.blocked.includes('critical_findings_applied'), closed.blocked)
  }

  // ------------------------------------------------------------ gates and verdicts
  const verdict = await recordVerdict({ cwd, runId: 'dr-0001', gate: 'coverage', status: 'flagged', severity: 'MAJOR', reason: 'two sub-directions thin', route: 'targeted re-scout' })
  ok('verdict gets a v- id', verdict.verdict_id === 'v-0001')
  ok('latestVerdict reads the last word', latestVerdict(cwd, 'dr-0001', 'coverage').reason === 'two sub-directions thin')
  threw = null
  try { await recordVerdict({ cwd, runId: 'dr-0001', gate: 'angle', status: 'mostly_fine' }) } catch (error) { threw = error.message }
  ok('an invented gate state is refused', /gate status must be one of/.test(threw ?? ''), threw)

  // ------------------------------------------------------------ ship gate
  {
    // A bare not_checked is not good enough: the gate must say why nothing was verifiable.
    const gate = await shipGate({ cwd, runId: 'dr-0001' })
    const coverage = gate.checks.find((check) => check.id === 'full_text_coverage')
    ok('the gate reports full-text coverage', coverage?.state === 'not_checked', coverage)
    ok('and names the reason as an unrequested fetch', /fetch_full_text/.test(coverage?.detail ?? ''), coverage?.detail)
    await appendRetrieval({ cwd, runId: 'dr-0001', rows: [{ record_id: 'src-0001', ok: false, reason: 'no_open_access_copy' }, { record_id: 'src-0002', ok: false, reason: 'no_open_access_copy' }, { record_id: 'src-0006', ok: true, bytes: 4200 }] })
    const retried = await shipGate({ cwd, runId: 'dr-0001' })
    const covered = retried.checks.find((check) => check.id === 'full_text_coverage')
    ok('retrieval outcomes change the disclosure', covered?.state === 'pass', covered)
    ok('and the count is reported honestly', /1 of 3/.test(covered?.detail ?? ''), covered?.detail)
    const summary = readRetrieval(cwd, 'dr-0001')
    ok('failure reasons are aggregated for the operator', summary.reasons.join(',').includes('no_open_access_copy×2'), summary)
  }

  const bare = await shipGate({ cwd, runId: 'dr-0001' })
  ok('a run with no verifier is never a clean pass', bare.not_checked.length > 0, bare.not_checked)
  ok('a blocked run names blockers and unverified checks alike', bare.blocked.length > 0 && bare.not_checked.length > 0)
  ok('gospel passes on a healthy run', bare.checks.find((check) => check.id === 'query_is_gospel').state === 'pass')
  ok('RQ coverage blocks while rq-0003 is unanswered', bare.blocked.includes('research_questions_answered'), bare.blocked)
  ok('an open High finding blocks the ship', bare.blocked.includes('critical_findings_applied') || bare.blocked.includes('findings_current'), bare.blocked)
  ok('quotes block until something verifies them', bare.blocked.includes('quote_integrity') || bare.not_checked.includes('quote_integrity'))

  await appendClaims({ cwd, runId: 'dr-0001', claims: [{ rq_id: 'rq-0003', text: 'Exclusions are documented.', record_ids: ['src-0006'] }] })
  const highFinding = readFindings(cwd, 'dr-0001').find((row) => row.severity === 'High' && row.status === 'open')
  if (highFinding) await markFindingApplied({ cwd, runId: 'dr-0001', findingId: highFinding.finding_id, patchId: 'p-0001' })

  const verified = await shipGate({
    cwd, runId: 'dr-0001',
    deps: {
      quoteStatus: (quote, record) => (record.doi === '10.1/lead' && quote === 'reduced MACE by 20%' ? 'supported' : 'unsupported'),
      retractionFor: () => ({ retracted: false }),
      consensusClaimed: () => false,
      lociCoverage: () => ({ covered: 0, missing: [] }),
      numericCheck: () => ({ state: 'pass', detail: 'numbers traceable' }),
      hygieneCheck: () => ({ leaks: [] }),
    },
  })
  ok('a fully verified run passes', verified.status === 'pass', verified.checks.filter((c) => c.state !== 'pass'))
  ok('quote integrity passes when the span exists', verified.checks.find((c) => c.id === 'quote_integrity').state === 'pass')
  ok('patch_only is satisfied by the patch log', verified.checks.find((c) => c.id === 'patch_only').state === 'pass')

  const partial = await shipGate({
    cwd, runId: 'dr-0001',
    deps: {
      quoteStatus: (quote, record) => (record.doi === '10.1/lead' ? 'supported' : 'unsupported'),
      retractionFor: () => ({ retracted: false }),
      consensusClaimed: () => false,
    },
  })
  ok('a passing run still discloses what went unverified', partial.status === 'pass' && /could not be verified/.test(partial.caveat ?? ''), partial.caveat)
  ok('the disclosure counts the unverified checks', partial.not_checked.length >= 3, partial.not_checked)

  const lying = await shipGate({
    cwd, runId: 'dr-0001',
    deps: {
      quoteStatus: () => 'unsupported',
      retractionFor: () => ({ retracted: true, notice: 'retracted 2026' }),
      consensusClaimed: () => true,
      lociCoverage: () => ({ covered: 0, missing: ['loc-0002'] }),
      hygieneCheck: () => ({ leaks: ['scaffold section echoed'] }),
    },
  })
  ok('a hallucinated quote blocks the ship', lying.blocked.includes('quote_integrity'), lying.blocked)
  ok('an unacknowledged retraction blocks the ship', lying.blocked.includes('retracted_citations'))
  ok('syndication passed off as consensus blocks', lying.blocked.includes('independence_recorded'))
  ok('a missing interim note blocks', lying.blocked.includes('locus_coverage'))
  ok('a scaffold leak blocks', lying.blocked.includes('hygiene'))
  ok('the gate says blocked, not partially fine', lying.status === 'blocked')

  ok('the store never wrote outside .dsh', !existsSync(workspace.path('final_report.md')))
  ok('readRun reconstructs the whole ledger', readRun(cwd, 'dr-0001').records.length === 7)
  const reportArtifact = readArtifact({ cwd, runId: 'dr-0001', name: 'final_report' })
  ok('the report survived on disk exactly once', existsSync(reportArtifact.path) && readFileSync(reportArtifact.path, 'utf8').includes('without diabetes'))
  ok('the artifact name is slugified', reportArtifact.artifact === 'final-report', reportArtifact.artifact)
} catch (error) {
  console.error(`THREW ${error instanceof Error ? error.stack : error}`)
  checks.push({ label: 'uncaught error', pass: false })
} finally {
  workspace.cleanup()
}

function readJsonlCount(file) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).length
}

const failed = checks.filter((check) => !check.pass)
console.log(`${checks.length - failed.length}/${checks.length} ledger checks passed`)
if (failed.length) {
  console.error(failed.map((check) => ` - ${check.label}`).join('\n'))
  process.exit(1)
}
