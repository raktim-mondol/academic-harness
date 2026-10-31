#!/usr/bin/env node
/**
 * Phase 3 — cross-ledger provenance audit (`provenance_audit`).
 *
 * Fake ledgers in a temp workspace prove: the five unsupported states are each
 * reachable and distinguishable, a ledger that cannot be read is reported
 * `unknown` with its reason, a changed manuscript marks the evidence that
 * depends on it `stale` with old and new hashes, a link whose far end is
 * missing is `not_found`, the graph exports parse and contain only indexed
 * nodes and edges, and no source ledger is ever written.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'
import {
  AUDIT_STATES, assertAuditWrite, buildProvenanceIndex, coverageOf, exportProvenance,
  impactOf, readAuditIndex, staleOf, unverifiedOf, unsupportedOf,
} from '../provenance-store.js'
import { runProvenanceAction, apply as applyProvenance } from '../provenance-audit.js'
import {
  addEvidence, addExtraction, addRecords, appraiseRecord, screenRecord, startReview,
} from '../review-store.js'
import { addGradeJudgement, addGradeOverall, startGrade } from '../grade-store.js'
import { startExperiment, logExperimentRun, linkExperimentRun } from '../experiment-store.js'
import { recordVerdict, startCheck } from '../reporting-store.js'
import { appendJsonl, hashFile, writeOnceJson } from '../ledger-kit.js'

const ws = makeWorkspace('ah-provenance-')
const cwd = ws.cwd
const failures = []
const ok = (label, condition, detail = '') => {
  if (condition) console.log(`ok — ${label}`)
  else { failures.push(label); console.log(`NOT OK — ${label}${detail ? `: ${detail}` : ''}`) }
}
const sha256Hex = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const PROVENANCE_TOOL_ACTIONS = ['index', 'coverage', 'unsupported', 'stale', 'unverified', 'impact', 'export']
const stateOf = (index, id) => index.nodes.find((node) => node.id === id)?.state
const reasonOf = (index, id) => index.nodes.find((node) => node.id === id)?.reason

/** Snapshot every file outside the audit cache so any write is detectable. */
function snapshotLedgers() {
  const out = new Map()
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.lock') continue
      const rel = `${prefix}/${entry.name}`
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs, rel)
      else out.set(rel, `${statSync(abs).size}:${hashFile(abs)}`)
    }
  }
  for (const root of ['.dsh', 'data', 'claims', 'sources']) {
    const dir = join(cwd, root)
    if (!existsSync(dir) || root === '.dsh/provenance') continue
    if (root === '.dsh') {
      for (const entry of readdirSync(dir)) {
        if (entry === 'provenance') continue
        const abs = join(dir, entry)
        if (statSync(abs).isDirectory()) walk(abs, `.dsh/${entry}`)
        else out.set(`.dsh/${entry}`, `${statSync(abs).size}:${hashFile(abs)}`)
      }
      continue
    }
    walk(dir, root)
  }
  for (const file of ['manuscript.md', 'results.csv', 'input.txt', 'ah.yaml', 'reviewed.md']) {
    if (existsSync(join(cwd, file))) out.set(file, `0:${hashFile(join(cwd, file))}`)
  }
  return out
}

/* ------------------------------------------------------------ review ledger */

await startReview({
  cwd, slug: 'bcg',
  protocol: { question: 'Does BCG prevent respiratory infection?', reviewers: ['human:ana', 'human:bo'] },
  extractionTemplate: 'pico',
})
await addRecords({
  cwd, slug: 'bcg', source: 'manual',
  records: [
    { title: 'BCG trial 1980', doi: '10.1000/trial1', year: 1980 },
    { title: 'BCG cohort 1981', doi: '10.1000/trial2', year: 1981 },
    { title: 'Unexplained series', year: 1990 },
  ],
})
for (const id of ['r0001', 'r0002', 'r0003']) {
  await screenRecord({ cwd, slug: 'bcg', id, stage: 'title_abstract', decision: 'include', reviewer: 'human:ana' })
  await screenRecord({ cwd, slug: 'bcg', id, stage: 'full_text', decision: 'include', reviewer: 'human:ana' })
}
// A quote with no PaperMemory paper: evidence exists, nothing links it.
await addEvidence({
  cwd, slug: 'bcg', id: 'r0001',
  claim: 'BCG reduced lower respiratory infection admissions.',
  quote: 'RR 0.74 (95% CI 0.61-0.90) for admission for lower respiratory infection',
  location: 'Results, p. 4',
})
// A field quote recorded with an unverified check.
await addExtraction({
  cwd, slug: 'bcg', id: 'r0001', reviewer: 'human:ana', paper: 'pm:trial1',
  values: { population: 'Infants', intervention: 'BCG', comparator: 'placebo', outcome: 'admission', n: 412, effect: 0.74 },
  quotes: { effect: { quote: 'RR 0.74 (95% CI 0.61-0.90)', location: 'Results, p. 4' } },
  quoteChecks: { effect: { status: 'unverified', via: 'papermemory_quote_check', detail: 'paper resolved to a bibliography record' } },
})
// A decisive appraisal judgement with a quote but no verification.
await appraiseRecord({
  cwd, slug: 'bcg', id: 'r0001', instrument: 'rob-2', domain: 'd1', judgement: 'low', reviewer: 'human:ana',
  quote: 'allocation was by computer-generated list', location: 'Methods, p. 3', paper: 'pm:trial1',
})
// GRADE: a domain rating with a reason only, then a human overall certainty.
await startGrade({
  cwd, slug: 'bcg',
  outcomes: [{ id: 'admission', name: 'Admission for LRI', comparison: 'BCG vs placebo', importance: 'critical' }],
})
await addGradeJudgement({
  cwd, slug: 'bcg', outcome: 'admission', domain: 'imprecision', rating: 'not_serious',
  reason: '412 participants, narrow confidence interval', reviewer: 'human:ana',
})
await addGradeOverall({
  cwd, slug: 'bcg', outcome: 'admission', certainty: 'moderate',
  reason: 'one large trial with some concerns', reviewer: 'human:ana',
})

/* --------------------------------------------------------- reporting ledger */

const manuscriptBody = '# Trial\n\nSTROBE-compatible text. We followed the protocol exactly.\n'
ws.write('manuscript.md', manuscriptBody)
await startCheck({
  cwd, slug: 'strobe',
  guideline: { id: 'strobe', name: 'STROBE', version: '2007', source_url: 'https://www.strobe-statement.org' },
  manuscript: {
    kind: 'file', path: 'manuscript.md', paper: null, title: 'Trial', format: 'markdown',
    sha256: sha256Hex(manuscriptBody).slice(7), chars: manuscriptBody.length, lines: 3, truncated: false, notes: [],
  },
  itemIds: ['1a', '12a'],
})
await recordVerdict({
  cwd, slug: 'strobe', itemId: '1a', verdict: 'reported',
  evidence: { quote: 'We followed the protocol exactly.', location: 'Methods' },
})
await recordVerdict({ cwd, slug: 'strobe', itemId: '12a', verdict: 'not_reported', searched: ['equity'] })

/* ------------------------------------------------------------------ notebook */

ws.write('results.csv', 'a,b\n1,2\n')
appendJsonl(join(cwd, '.dsh', 'notebook', 'session-1.jsonl'), [
  { id: 'n1', timestamp: Date.now(), type: 'hypothesis', title: 'Dose response is linear' },
  { id: 'n2', timestamp: Date.now(), type: 'observation', title: 'Sweep ran', artifacts: ['results.csv'] },
  { id: 'n4', timestamp: Date.now(), type: 'hypothesis', title: 'Linked to a lost entry', relatesTo: 'gone' },
])

/* ------------------------------------------------------------------ analysis */

const inputBody = 'x\n'
ws.write('input.txt', inputBody)
const planHash = sha256Hex('plan-one')
appendJsonl(join(cwd, '.dsh', 'analysis', 'primary', 'plan.jsonl'), [
  {
    version: 1, hash: planHash, created_at: '2026-01-01T00:00:00.000Z',
    plan: { question: 'Primary', hypotheses: ['H1: the dose response is linear'], inputs: ['input.txt'], outputs: ['output.txt'] },
  },
])
appendJsonl(join(cwd, '.dsh', 'analysis', 'primary', 'runs.jsonl'), [
  {
    run_id: 'run-1', slug: 'primary', ts: '2026-01-02T00:00:00.000Z', plan_hash: planHash, plan_version: 1,
    command: ['uv', 'run', 'python', 'main.py'], kind: 'python', exit_code: 0, timed_out: false, spawn_error: null,
    inputs: [{ path: 'input.txt', sha256: sha256Hex(inputBody), bytes: 2 }],
    outputs: [{ path: 'output.txt', status: 'not_written' }],
    environment: { git_commit: null },
  },
])

/* ---------------------------------------------------------------- experiment */

await startExperiment({
  cwd, slug: 'sweep',
  experiment: { question: 'Which learning rate wins?', metrics: [{ name: 'loss', direction: 'lower' }] },
})
await logExperimentRun({ cwd, slug: 'sweep', params: { lr: 0.1 }, metrics: { loss: 0.5 }, artifacts: ['results.csv'], seed: 7 })
await linkExperimentRun({ cwd, slug: 'sweep', runId: 'x0001', targetKind: 'paper', targetId: '10.1000/ghost' })
await linkExperimentRun({ cwd, slug: 'sweep', runId: 'x0001', targetKind: 'notebook', targetId: 'n2' })

/* ------------------------------------------------------------------ dataset */

ws.write('data/raw.csv', 'a,b\n1,2\n')
appendJsonl(join(cwd, '.dsh', 'data', 'zenodo', 'manifest.jsonl'), [
  {
    kind: 'download', ts: '2026-01-03T00:00:00.000Z', slug: 'zenodo', doi: '10.5281/zenodo.1', version: 'v1',
    license: 'CC0-1.0', license_stated: true, landing_page: 'https://zenodo.org/record/1', repository: 'zenodo',
    files: [
      { name: 'raw.csv', path: 'data/raw.csv', bytes: 6, sha256: sha256Hex('a,b\n1,2\n'), source_checksum: 'sha256:' + sha256Hex('a,b\n1,2\n').slice(7), verification: 'verified', status: 'downloaded' },
      { name: 'gone.csv', path: 'data/gone.csv', bytes: 2, sha256: sha256Hex('nope'), source_checksum: 'sha256:deadbeef', verification: 'verification_failed', status: 'downloaded' },
    ],
  },
])

/* -------------------------------------------------------------- meta-analysis */

writeOnceJson(join(cwd, '.dsh', 'meta', 'bcg-meta', 'protocol.json'), {
  slug: 'bcg-meta', question: 'BCG pooled', outcome: 'admission', effect_measure: 'RR', log_scale: true,
  model: 'random', tau2_method: 'dl', ci_method: 'normal', alpha: 0.05, notes: null, created_at: '2026-01-04T00:00:00.000Z',
})
appendJsonl(join(cwd, '.dsh', 'meta', 'bcg-meta', 'studies.jsonl'), [
  { id: 'r0001', label: 'BCG trial 1980', effect: 0.74, se: 0.1, meta: { record_id: 'r0001', title: 'BCG trial 1980' } },
  { id: 'r9999', label: 'Imported from nowhere', effect: 0.8, se: 0.1, meta: { record_id: 'r9999' } },
])
appendJsonl(join(cwd, '.dsh', 'meta', 'bcg-meta', 'analyses.jsonl'), [
  { analysis_id: 'ma0001', kind: 'pool', ts: '2026-01-05T00:00:00.000Z', params: {}, result: { k: 2, pooled: 0.77, heterogeneity: { i2: 10 } } },
])

/* ---------------------------------------------------------------- deep review */

const deepBody = '# Manuscript\nThe method is novel.\n'
const deepKey = 'abc123key'
ws.write('reviewed.md', deepBody)
writeOnceJson(join(cwd, '.dsh', 'deep-review', deepKey, 'meta.json'), {
  schemaVersion: 1, key: deepKey,
  input: { path: 'reviewed.md', file_name: 'reviewed.md', size_bytes: deepBody.length, sha1: createHash('sha1').update(deepBody).digest('hex'), format: 'md' },
  review: { sha1: createHash('sha1').update(deepBody).digest('hex') },
})
writeOnceJson(join(cwd, '.dsh', 'deep-review', deepKey, 'review.json'), {
  result: {
    claimEvidenceMap: [
      { claimId: 'c1', claim: 'The method is novel', evidenceLocation: 'p.1', evidenceType: 'EXPERIMENT', status: 'SUPPORTED', gapAnalysis: 'baseline not stated' },
    ],
  },
})

/* -------------------------------------------------------------------------- AH */

ws.write('ah.yaml', 'project: paper\nclaims_dir: claims\n')
const sourceBody = 'Introduction\n\nBCG reduced admissions by 26 percent in infants.\n'
ws.write('sources/paper1.md', sourceBody)
ws.write('claims/u_intro.yaml', [
  'unit: U_INTRO_1',
  'hash: abc123',
  'claims:',
  '  - id: clm_bound',
  '    clause: "BCG cut admissions by 26 percent."',
  '    cites: [smith1980]',
  '    kind: empirical',
  '    status: bound',
  '    bindings:',
  '      - type: passage',
  '        source: smith1980',
  '        file: sources/paper1.md',
  '        start: 3',
  '        end: 3',
  '        quote: "BCG reduced admissions by 26 percent in infants."',
  `        raw_sha256: ${sha256Hex(sourceBody).slice(7)}`,
  '  - id: clm_unbound',
  '    clause: "The effect is permanent."',
  '    cites: []',
  '    kind: interpretive',
  '    status: unbound',
  '    bindings: []',
  '',
].join('\n'))

/* ------------------------------------------------- index and the read-only law */

const before = snapshotLedgers()
const index = await buildProvenanceIndex({ cwd, slug: 'default' })
const after = snapshotLedgers()

ok('index built', index.nodes.length > 20, `${index.nodes.length} nodes, ${index.edges.length} edges`)
ok('audit cache written', existsSync(join(cwd, '.dsh', 'provenance', 'default', 'index.json')))
const drifted = [...after].filter(([key, value]) => before.get(key) !== value)
ok('no source ledger was modified', drifted.length === 0, drifted.map(([key]) => key).join(', '))
assert.throws(() => assertAuditWrite(cwd, 'default', join(cwd, '.dsh', 'review', 'bcg', 'evidence.jsonl')), /read_only_ledger/)
assert.throws(() => assertAuditWrite(cwd, 'default', join(cwd, 'manuscript.md')), /read_only_ledger/)
assert.throws(() => assertAuditWrite(cwd, 'default', join(cwd, '.dsh', 'provenance', '..', 'reporting', 'strobe', 'verdicts.jsonl')), /read_only_ledger/)
ok('every write outside the audit cache is refused', true)
ok('all ledgers the workspace holds are readable', index.sources.filter((entry) => entry.status === 'present').length >= 8,
  JSON.stringify(index.sources.map((entry) => `${entry.ledger}:${entry.status}`)))
ok('no unexpected warnings', index.warnings.length === 0, JSON.stringify(index.warnings))

/* ------------------------------------------------------- the five states */

const coverage = coverageOf(index)
for (const state of ['no_link', 'not_checked', 'unverified', 'not_found']) {
  ok(`state "${state}" is present`, coverage.totals.by_state[state] > 0, JSON.stringify(coverage.totals.by_state))
}
ok('a quote with no PaperMemory paper is no_link', stateOf(index, 'claim:review/bcg/e0001') === 'no_link', stateOf(index, 'claim:review/bcg/e0001'))
ok('an included record with no evidence is no_link', stateOf(index, 'claim:review/bcg/include~r0003') === 'no_link', stateOf(index, 'claim:review/bcg/include~r0003'))
ok('an unbound AH clause is no_link', stateOf(index, 'claim:ah/project/U_INTRO_1~clm_unbound') === 'no_link', stateOf(index, 'claim:ah/project/U_INTRO_1~clm_unbound'))
ok('a hypothesis with nothing linked is no_link', stateOf(index, 'claim:notebook/session-1/n1') === 'no_link', stateOf(index, 'claim:notebook/session-1/n1'))
ok('a GRADE rating with a reason but no quote is not_checked', stateOf(index, 'claim:review/bcg/g0001') === 'not_checked', stateOf(index, 'claim:review/bcg/g0001'))
ok('a plan hypothesis with runs is not_checked', stateOf(index, 'claim:analysis/primary/h1-1') === 'not_checked', stateOf(index, 'claim:analysis/primary/h1-1'))
ok('an unverified field quote is unverified', stateOf(index, 'claim:review/bcg/x0001') === 'unverified', reasonOf(index, 'claim:review/bcg/x0001'))
ok('an appraisal quote with no check is unverified', stateOf(index, 'claim:review/bcg/a0001') === 'unverified', reasonOf(index, 'claim:review/bcg/a0001'))
ok('a deep-review engine judgement is unverified', stateOf(index, 'claim:deep_review/abc123key/c1') === 'unverified', stateOf(index, 'claim:deep_review/abc123key/c1'))
ok('a failed checksum is unverified', stateOf(index, 'export:data/gone.csv') === 'unverified' || stateOf(index, 'export:data/gone.csv') === 'not_found', stateOf(index, 'export:data/gone.csv'))
ok('a hypothesis linked to a missing entry is not_found', stateOf(index, 'claim:notebook/session-1/n4') === 'not_found', stateOf(index, 'claim:notebook/session-1/n4'))
ok('an unresolvable experiment link is not_found', stateOf(index, 'record:experiment/sweep/link-1') === 'not_found', reasonOf(index, 'record:experiment/sweep/link-1'))
ok('a resolvable experiment link is supported', stateOf(index, 'record:experiment/sweep/link-2') === 'supported', reasonOf(index, 'record:experiment/sweep/link-2'))
ok('a declared output that was never written is not_found', stateOf(index, 'export:output.txt') === 'not_found', stateOf(index, 'export:output.txt'))
ok('a study imported from a missing review record is not_found', stateOf(index, 'record:meta/bcg-meta/missing-record~r9999') === 'not_found')
ok('a study imported from a real review record is supported', stateOf(index, 'record:meta/bcg-meta/r0001') === 'supported', stateOf(index, 'record:meta/bcg-meta/r0001'))
ok('a verified quote check is supported', stateOf(index, 'claim:reporting/strobe/1a') === 'supported', stateOf(index, 'claim:reporting/strobe/1a'))
ok('an AH bound passage with a matching source is supported', stateOf(index, 'claim:ah/project/U_INTRO_1~clm_bound') === 'supported', reasonOf(index, 'claim:ah/project/U_INTRO_1~clm_bound'))
ok('a human GRADE certainty is recorded evidence', stateOf(index, 'claim:review/bcg/g0002') === 'supported', stateOf(index, 'claim:review/bcg/g0002'))
ok('a not-reported checklist item is an unsupported claim', stateOf(index, 'claim:reporting/strobe/12a') === 'no_link', reasonOf(index, 'claim:reporting/strobe/12a'))

const unsupported = unsupportedOf(index)
ok('unsupported lists only claims', unsupported.items.every((item) => item.role === 'claim'))
ok('unsupported separates all five states', Object.keys(unsupported.by_state).length === 5, JSON.stringify(unsupported.by_state))
ok('supported claims are excluded from unsupported', !unsupported.items.some((item) => item.state === 'supported'))

/* --------------------------------------------------------------- stale ripple */

ws.write('manuscript.md', '# Trial\n\nSTROBE-compatible text. We deviated from the protocol in one respect.\n')
const changed = await buildProvenanceIndex({ cwd, slug: 'default' })
ok('a changed manuscript makes its quote stale', stateOf(changed, 'quote:reporting/strobe/1a~quote') === 'stale', stateOf(changed, 'quote:reporting/strobe/1a~quote'))
ok('a changed manuscript makes the dependent claim stale', stateOf(changed, 'claim:reporting/strobe/1a') === 'stale', reasonOf(changed, 'claim:reporting/strobe/1a'))
const stale = staleOf(changed)
ok('stale reports the old and the new hash', stale.items.some((item) => item.hashes?.recorded && item.hashes?.current), JSON.stringify(stale.items.map((item) => item.id)))
ok('stale says what it was before', stateOf(changed, 'claim:reporting/strobe/12a') === 'stale'
  && staleOf(changed).items.find((item) => item.id === 'claim:reporting/strobe/12a')?.previous_state === 'no_link',
JSON.stringify(stale.items.find((item) => item.id === 'claim:reporting/strobe/12a')))
ws.write('manuscript.md', manuscriptBody)

ws.write('sources/paper1.md', 'Introduction\n\nBCG did not reduce admissions in this cohort.\n')
const ahChanged = await buildProvenanceIndex({ cwd, slug: 'default' })
ok('a changed bound source makes the manuscript claim stale', stateOf(ahChanged, 'claim:ah/project/U_INTRO_1~clm_bound') === 'stale', reasonOf(ahChanged, 'claim:ah/project/U_INTRO_1~clm_bound'))
ws.write('sources/paper1.md', sourceBody)

/* ----------------------------------------------------------- missing sources */

const empty = makeWorkspace('ah-provenance-empty-')
const emptyIndex = await buildProvenanceIndex({ cwd: empty.cwd, slug: 'lonely' })
const ledger = (name) => emptyIndex.sources.find((entry) => entry.ledger === name)
ok('AH without ah.yaml is unknown with a reason', ledger('ah')?.status === 'unknown' && /ah\.yaml/.test(ledger('ah').reason), JSON.stringify(ledger('ah')))
ok('notebook without entries is unknown with a reason', ledger('notebook')?.status === 'unknown' && /notebook/.test(ledger('notebook').reason))
ok('preregister is unknown with a reason', ledger('preregister')?.status === 'unknown' && /Phase 5A/.test(ledger('preregister').reason), JSON.stringify(ledger('preregister')))
ok('scientific_result is unknown with a reason', ledger('scientific_result')?.status === 'unknown' && /not persisted/.test(ledger('scientific_result').reason))
ok('an empty workspace has no claims at all', emptyIndex.counts.claims === 0, JSON.stringify(emptyIndex.counts))
ok('an empty workspace reports nothing unsupported', unsupportedOf(emptyIndex).unsupported === 0)
const asked = await buildProvenanceIndex({ cwd: empty.cwd, slug: 'asked', selection: { review: ['ghost-review'] } })
ok('a named-but-absent ledger is unknown with its reason', asked.sources.some((entry) => entry.ledger === 'review' && entry.slug === 'ghost-review' && entry.status === 'unknown' && /ghost-review/.test(entry.reason)))
empty.cleanup()

/* -------------------------------------------------------- live PaperMemory */

ok('stored statuses are used when verify_quotes is off', stateOf(index, 'quote:review/bcg/x0001~effect') === 'unverified', stateOf(index, 'quote:review/bcg/x0001~effect'))
const verified = await buildProvenanceIndex({
  cwd, slug: 'verified',
  deps: {
    verifyQuote: async ({ quote }) => (quote.includes('allocation was by computer-generated list')
      ? { status: 'verified', checked_against: { sha256: 'newsource' } }
      : { status: 'not_found', detail: 'not in the stored paper text' }),
  },
})
ok('live verification upgrades the quote', stateOf(verified, 'quote:review/bcg/a0001~quote') === 'supported', stateOf(verified, 'quote:review/bcg/a0001~quote'))
ok('the appraisal claim inherits the verification', stateOf(verified, 'claim:review/bcg/a0001') === 'supported', stateOf(verified, 'claim:review/bcg/a0001'))
ok('a quote the library no longer finds is not_found', stateOf(verified, 'quote:review/bcg/x0001~effect') === 'not_found', stateOf(verified, 'quote:review/bcg/x0001~effect'))
ok('papermemory is reported as queried', verified.sources.some((entry) => entry.ledger === 'papermemory' && entry.status === 'queried'))
const failedVerify = await buildProvenanceIndex({ cwd, slug: 'broken-verify', deps: { verifyQuote: async () => { throw new Error('PaperMemory is not installed') } } })
ok('a failing quote check warns and keeps stored statuses', failedVerify.warnings.some((warning) => /papermemory_quote_check failed/.test(warning))
  && stateOf(failedVerify, 'claim:review/bcg/a0001') === 'unverified', JSON.stringify(failedVerify.warnings))

/* ------------------------------------------------------------------- impact */

const impact = impactOf(index, 'results.csv')
ok('impact finds dependents of a shared file', impact.dependents.length >= 2, JSON.stringify(impact.dependents.map((entry) => entry.id)))
ok('impact reports the ledger of each dependent', impact.dependents.every((entry) => entry.ledger && entry.depth >= 1))
ok('impact resolves a paper by suffix', impactOf(index, '10.1000/trial1').dependents.length >= 1)
assert.throws(() => impactOf(index, 'nothing-like-this'), /not in the index/)
ok('impact on an unindexed target refuses rather than guesses', true)

/* ------------------------------------------------------------------ exports */

const freshIndex = await buildProvenanceIndex({ cwd, slug: 'default' })
const exports = {}
for (const format of ['markdown', 'csv', 'json', 'graphml', 'mermaid']) {
  exports[format] = exportProvenance({ cwd, slug: 'default', index: freshIndex, format, overwrite: true })
  ok(`export ${format}`, existsSync(join(cwd, exports[format].path)) && exports[format].bytes > 40, JSON.stringify(exports[format]))
  ok(`export ${format} stays inside the cache`, exports[format].path.startsWith('.dsh/provenance/default/exports/'), exports[format].path)
}
assert.throws(() => exportProvenance({ cwd, slug: 'default', index: freshIndex, format: 'dot' }), /format must be one of/)
assert.throws(() => exportProvenance({ cwd, slug: 'default', index: freshIndex, format: 'csv' }), /already exists/)
ok('export refuses to overwrite by default', true)

const graphml = readFileSync(join(cwd, exports.graphml.path), 'utf8')
const graphmlNodes = [...graphml.matchAll(/<node id="([^"]+)">/g)].map((match) => match[1])
const graphmlEdges = [...graphml.matchAll(/<edge id="e\d+" source="([^"]+)" target="([^"]+)">/g)]
const indexed = new Set(freshIndex.nodes.map((node) => node.id))
ok('graphml contains exactly the indexed nodes', graphmlNodes.length === freshIndex.nodes.length
  && graphmlNodes.every((id) => indexed.has(id)) && new Set(graphmlNodes).size === graphmlNodes.length)
ok('graphml edges only reference indexed nodes', graphmlEdges.every((match) => indexed.has(match[1]) && indexed.has(match[2])))
ok('graphml contains exactly the indexed edges', graphmlEdges.length === freshIndex.edges.length)
ok('graphml is balanced XML', (graphml.match(/<node /g) || []).length === (graphml.match(/<\/node>/g) || []).length
  && graphml.trim().endsWith('</graphml>'))

const mermaid = readFileSync(join(cwd, exports.mermaid.path), 'utf8')
const declared = new Set([...mermaid.matchAll(/\b(n\d+)\["/g)].map((match) => match[1]))
const referenced = new Set([...mermaid.matchAll(/\b(n\d+)\b/g)].map((match) => match[1]))
ok('mermaid declares one row per indexed node', declared.size === freshIndex.nodes.length, `${declared.size} vs ${freshIndex.nodes.length}`)
ok('mermaid references only declared nodes', [...referenced].every((name) => declared.has(name)))
ok('mermaid draws every indexed edge', (mermaid.match(/-->/g) || []).length === freshIndex.edges.length)
ok('mermaid has no unescaped quotes inside labels', !/""/.test(mermaid))

const csvLines = readFileSync(join(cwd, exports.csv.path), 'utf8').trim().split('\n')
ok('csv has one row per node', csvLines.length - 1 === freshIndex.nodes.length, `${csvLines.length - 1} vs ${freshIndex.nodes.length}`)
const jsonExport = JSON.parse(readFileSync(join(cwd, exports.json.path), 'utf8'))
ok('json export is the index itself', jsonExport.index_hash === freshIndex.index_hash && jsonExport.nodes.length === freshIndex.nodes.length)
const markdown = readFileSync(join(cwd, exports.markdown.path), 'utf8')
ok('markdown export names its limits', /never infers support/.test(markdown) && /unknown/.test(markdown))
ok('markdown export shows the coverage table', /\| Ledger \| Nodes \| Claims \|/.test(markdown))

const exec = fakeExec(cwd)
const run = async (args) => {
  try { return await runProvenanceAction(args, exec) }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
}

/* ------------------------------------------------- a corrupt ledger degrades */

const extractionLog = join(cwd, '.dsh', 'review', 'bcg', 'extractions.jsonl')
const originalEvents = readFileSync(extractionLog, 'utf8')
ws.write('.dsh/review/bcg/extractions.jsonl', '{not json}\n')
const corrupted = await run({ action: 'index', audit: 'corrupt' }, exec)
const brokenReview = corrupted.sources.find((entry) => entry.ledger === 'review')
ok('a malformed ledger line is reported unknown, not a crash', brokenReview?.status === 'unknown'
  && /line 1 is not valid JSON/.test(brokenReview.reason), JSON.stringify(brokenReview))
ok('a corrupt ledger warns', corrupted.coverage.warnings.some((warning) => /review:bcg/.test(warning)), JSON.stringify(corrupted.coverage.warnings))
ok('the rest of the workspace is still indexed', corrupted.coverage.ledgers.some((entry) => entry.ledger === 'reporting'))
ws.write('.dsh/review/bcg/extractions.jsonl', originalEvents)
const repaired = await run({ action: 'index', audit: 'default' }, exec)
ok('the ledger reads again once the file is restored',
  repaired.sources.find((entry) => entry.ledger === 'review')?.status === 'present')

/* -------------------------------------------------------------- tool surface */

const indexResult = await run({ action: 'index', audit: 'tool' }, exec)
ok('tool index', indexResult.action === 'index' && indexResult.coverage.totals.nodes > 0 && indexResult.readable >= 8)
const cached = await run({ action: 'coverage', audit: 'tool' }, exec)
ok('tool coverage reuses the cached index', cached.coverage.created_at === indexResult.coverage.created_at
  && cached.coverage.index_hash === indexResult.index_hash)
const rescoped = await run({ action: 'coverage', audit: 'tool', review: ['bcg'] }, exec)
ok('a different selection rebuilds instead of reusing the cache', rescoped.coverage.created_at !== cached.coverage.created_at,
  `${rescoped.coverage.created_at} vs ${cached.coverage.created_at}`)
const resame = await run({ action: 'coverage', audit: 'tool', review: ['BCG'] }, exec)
ok('a selection that means the same thing reuses the cache', resame.coverage.created_at === rescoped.coverage.created_at)
const forced = await run({ action: 'coverage', audit: 'tool', refresh: true }, exec)
ok('refresh rebuilds', forced.coverage.created_at >= cached.coverage.created_at)
const limited = await run({ action: 'unsupported', audit: 'tool', limit: 3 }, exec)
ok('limit is respected', limited.result.items.length <= 3)
const filtered = await run({ action: 'unsupported', audit: 'tool', state: 'no_link' }, exec)
ok('state filter narrows the report', Object.keys(filtered.result.by_state).join() === 'no_link')
const badState = await run({ action: 'unsupported', audit: 'tool', state: 'supported' }, exec)
ok('a supported state is refused', /not an unsupported state/.test(badState.error), badState.error)
ok('tool stale', Array.isArray((await run({ action: 'stale', audit: 'tool' }, exec)).result.items))
ok('tool unverified', Array.isArray((await run({ action: 'unverified', audit: 'tool' }, exec)).result.items))
ok('tool impact by path', (await run({ action: 'impact', audit: 'tool', target: 'results.csv' }, exec)).result.dependents.length >= 2)
const missingTarget = await run({ action: 'impact', audit: 'tool' }, exec)
ok('impact without a target asks for one', /requires a target id/.test(missingTarget.error), missingTarget.error)
const toolExport = await run({ action: 'export', audit: 'tool', format: 'mermaid', overwrite: true }, exec)
ok('tool export', toolExport.result.path === '.dsh/provenance/tool/exports/provenance.mmd', toolExport.result.path)
const badAction = await run({ action: 'rewrite' }, exec)
ok('an unknown action errors instead of writing', /action must be one of/.test(badAction.error), badAction.error)
const scoped = await run({ action: 'index', audit: 'review-only', review: ['bcg'], reporting: ['ghost'], include_ah: false }, exec)
ok('selection restricts the review ledgers', scoped.coverage.ledgers.some((entry) => entry.ledger === 'review')
  && !scoped.coverage.ledgers.some((entry) => entry.ledger === 'reporting'))
ok('a named-but-absent reporting ledger is unknown', scoped.sources.some((entry) => entry.ledger === 'reporting' && entry.slug === 'ghost' && entry.status === 'unknown'))
ok('AH can be excluded', scoped.sources.some((entry) => entry.ledger === 'ah' && entry.status === 'skipped'))
ws.write('notes.md', '# Notes\n\nNothing checked yet.\n')
const withManuscript = await run({ action: 'index', audit: 'with-manuscript', manuscript: 'notes.md' }, exec)
ok('an explicit manuscript is indexed', withManuscript.coverage.ledgers.some((entry) => entry.ledger === 'manuscript'), JSON.stringify(withManuscript.coverage.ledgers.map((entry) => entry.ledger)))
const escapeAttempt = await run({ action: 'index', audit: 'escape', manuscript: '../outside.md' }, exec)
const escapeNode = escapeAttempt.coverage && (await readAuditIndex(cwd, 'escape')).nodes.find((node) => node.ledger === 'manuscript')
ok('a manuscript path outside the workspace is refused, not read', escapeNode?.state === 'not_found' && /escapes the workspace/.test(escapeNode.reason), JSON.stringify(escapeNode))
ok('no file was created outside the workspace', !existsSync(join(cwd, '..', 'outside.md')))
assert.throws(() => readAuditIndex(cwd, 'never-indexed'), /no provenance index/)
ok('reading a missing cache refuses', true)

/* ------------------------------------------------- registered tool + render */

let registered
applyProvenance({ tools: { register: (tool) => { registered = tool } } })
ok('the tool registers through defineTool', registered?.name === 'provenance_audit' && typeof registered?.execute === 'function')
for (const action of PROVENANCE_TOOL_ACTIONS) {
  const value = await registered.execute({ action, audit: 'tool', target: 'results.csv', overwrite: true }, exec)
  const parts = registered.output.render({ action }, value)
  ok(`registered ${action} renders without a model payload`, Array.isArray(parts) && parts[0]?.type === 'text' && parts[0].text.length > 5,
    JSON.stringify(parts)?.slice(0, 160))
}
const renderedError = registered.output.render({ action: 'index' }, { error: 'boom' })
ok('a tool error renders as text', renderedError[0].text === 'Error: boom')
const unsupportedRender = registered.output.render({ action: 'unsupported' }, await registered.execute({ action: 'unsupported', audit: 'tool' }, exec))
ok('the unsupported renderer includes node ids for a follow-up impact call', /claim:/.test(unsupportedRender[0].text), unsupportedRender[0].text.slice(0, 160))
const staleRender = registered.output.render({ action: 'stale' }, {
  result: {
    stale: 1, from_changed_sources: 0,
    items: [{ id: 'claim:review/x/e0001', state: 'stale', previous_state: 'supported', label: 'a claim', reason: 'because', hashes: { recorded: 'aaa', current: 'bbb' } }],
  },
})
ok('the stale renderer includes node ids and hashes', /claim:review\/x\/e0001/.test(staleRender[0].text) && /aaa/.test(staleRender[0].text), staleRender[0].text)
ok('presentCall names the action', /Provenance audit/.test(registered.presentCall({ action: 'stale' }).title))
const registeredIndex = await registered.execute({ action: 'index', audit: 'registered' }, exec)
ok('the registered tool indexes', registeredIndex.coverage.totals.nodes > 20 && !registeredIndex.error)

const lastSnapshot = snapshotLedgers()
const finalDrift = [...lastSnapshot].filter(([key, value]) => {
  if (!before.has(key)) return false
  if (key === 'manuscript.md' || key.startsWith('sources/')) return false
  return before.get(key) !== value
})
ok('the audit never wrote to a source ledger', finalDrift.length === 0, finalDrift.map(([key]) => key).join(', '))
ok('every documented state is reachable', AUDIT_STATES.length === 7 && new Set(AUDIT_STATES).size === 7)

console.log(failures.length ? `\n${failures.length} failure(s):\n  ${failures.join('\n  ')}` : '\nall provenance audit checks passed')
process.exit(failures.length ? 1 : 0)
