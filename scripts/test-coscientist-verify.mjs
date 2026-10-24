import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CITATION_STATUSES, CLAIM_SUPPORTS, MAX_CITATIONS_PER_CALL, MIN_SHARED_TOKENS, TITLE_MATCH_THRESHOLD,
  apply, extractDoi, runCoscVerify, titleSimilarity, titleTokens, verifyCitation,
} from '../coscientist-verify.js'
import { addHypothesis, deriveState, recordReview, startTournament, leaderboard } from '../coscientist-store.js'
import { resetLimitersForTests } from '../search-http.js'

const cwd = mkdtempSync(join(tmpdir(), 'ah-cosc-verify-'))
const exec = { agent: { session: { header: { cwd } } } }
const slug = 'verify-demo'

const noPacing = () => ({ run: (fn) => fn() })

/** A Crossref/OpenAlex double that answers by decoded URL fragment. */
function fixture(routes) {
  return async (url) => {
    // URLSearchParams encodes spaces as '+', which decodeURIComponent leaves alone.
    const decoded = decodeURIComponent(url).replace(/\+/g, ' ')
    for (const [fragment, responder] of routes) {
      if (decoded.includes(fragment)) {
        const value = typeof responder === 'function' ? responder(decoded) : responder
        return value
      }
    }
    return { ok: false, status: 404, error: 'not-registered' }
  }
}

const crossrefWork = (doi, title, { venue = 'Journal X', year = 2021, relation } = {}) => ({
  ok: true,
  status: 200,
  data: { message: { DOI: doi, title: [title], issued: { 'date-parts': [[year]] }, 'container-title': [venue], ...(relation ? { relation } : {}) } },
})

const REAL_DOI = '10.1000/real'
const FAKE_DOI = '10.9999/invented'
const RETRACTED_DOI = '10.1000/pulled'

const baseRoutes = [
  [`works/${REAL_DOI}`, crossrefWork(REAL_DOI, 'Real paper on ribosomal stalling')],
  [`works/${RETRACTED_DOI}`, crossrefWork(RETRACTED_DOI, 'A study of cryptic exon inclusion that was withdrawn', {
    relation: { 'has-retraction': [{ DOI: '10.1000/notice', label: 'retraction of' }] },
  })],
  ['works/10.9999/invented', { ok: false, status: 404, error: 'not-registered' }],
  ['query.bibliographic=Phage display library design principles for low abundance targets', {
    ok: true,
    status: 200,
    data: { message: { items: [
      { DOI: '10.1000/matched', title: ['Phage display library design principles for low-abundance targets'], issued: { 'date-parts': [[2019]] }, 'container-title': ['Bioconjugate Research'] },
      { DOI: '10.1000/other', title: ['Unrelated review of microfluidic culture systems'], issued: { 'date-parts': [[2020]] }, 'container-title': ['Lab on a Chip'] },
    ] } },
  }],
  ['query.bibliographic=Soil microbiome responses to shading in field plots', {
    ok: true,
    status: 200,
    data: { message: { items: [
      { DOI: '10.1000/near', title: ['Soil microbiome responses to shading in a garden bed'], issued: { 'date-parts': [[2018]] }, 'container-title': ['Soil Ecology'] },
    ] } },
  }],
  ['query.bibliographic=A wholly unmatchable claim about quantum gardening', {
    ok: true,
    status: 200,
    data: { message: { items: [{ DOI: '10.1000/none', title: ['Cryogenic sample staging for soft x-rays'], issued: { 'date-parts': [[2017]] } }] } },
  }],
  ['query.bibliographic=Empty result citation about nothing at all', { ok: true, status: 200, data: { message: { items: [] } } }],
  ['query.bibliographic=Booming registry citation about service failure', { ok: false, status: 500, error: 'server', detail: 'boom' }],
  [`works/${FAKE_DOI}`, { ok: false, status: 404, error: 'not-registered' }],
  ['openalex.org/works/doi:10.1000/real', {
    ok: true, status: 200,
    data: { id: 'https://openalex.org/W1', doi: `https://doi.org/${REAL_DOI}`, display_name: 'Real paper on ribosomal stalling', is_retracted: false, is_paratext: false },
  }],
  ['openalex.org/works/doi:10.1000/pulled', {
    ok: true, status: 200,
    data: { id: 'https://openalex.org/W2', doi: `https://doi.org/${RETRACTED_DOI}`, display_name: 'A study of cryptic exon inclusion that was withdrawn', is_retracted: true, is_paratext: false },
  }],
]

const deps = (routes = baseRoutes, env = {}) => ({
  fetchJson: fixture(routes),
  getLimiter: noPacing,
  resolveEnv: async (field) => env[field] ?? '',
})

const text = (blocks) => blocks.map((block) => block.text).join('\n')

try {
  resetLimitersForTests()

  // ── pure helpers ───────────────────────────────────────────────────────────
  assert.equal(TITLE_MATCH_THRESHOLD, 0.7, 'the match threshold stays upstream\'s')
  assert.deepEqual(CITATION_STATUSES, ['verified', 'unverified', 'fabricated'])
  assert.deepEqual(CLAIM_SUPPORTS, ['supports', 'contradicts', 'unaddressed'])
  assert.equal(extractDoi('https://doi.org/10.1000/Real'), '10.1000/real')
  assert.equal(extractDoi('doi: 10.1000/abc'), '10.1000/abc')
  assert.equal(extractDoi('Bosco 2020 eLife, 10.7554/eLife.52358.'), '10.7554/elife.52358')
  assert.equal(extractDoi('Smith 2021 Cell'), null, 'a prose citation carries no DOI')
  assert.equal(extractDoi(''), null)
  assert.deepEqual(titleTokens('The Role of p53 in 2019 Studies'), ['role', 'p53'], 'stopwords, boilerplate nouns, and bare years are not identity')
  assert.equal(titleSimilarity('Phage display library design principles for low-abundance targets', 'Phage display library design principles'), 1, 'a subset of the cited title is a match')
  assert.ok(titleSimilarity('Phage display library design principles for low-abundance targets', 'Soil microbiome responses to shading') < TITLE_MATCH_THRESHOLD)
  assert.equal(titleSimilarity('alpha beta', 'alpha beta gamma delta'), 0, 'two shared tokens is coincidence, not identity')
  assert.ok(MIN_SHARED_TOKENS >= 3)
  assert.equal(titleSimilarity('', 'anything'), 0)

  // ── verifyCitation classification ──────────────────────────────────────────
  const real = await verifyCitation(`https://doi.org/${REAL_DOI}`, {}, deps())
  assert.equal(real.status, 'verified')
  assert.equal(real.doi, REAL_DOI)
  assert.equal(real.matchScore, 1)
  assert.match(real.title, /ribosomal stalling/)
  assert.equal(real.year, 2021)
  assert.equal(real.venue, 'Journal X')

  const fake = await verifyCitation('Bosco 2020 eLife 10.9999/invented', {}, deps())
  assert.equal(fake.status, 'fabricated', 'an asserted DOI that is not registered is the only fabrication case')
  assert.match(fake.reason, /not registered/)

  const errored = await verifyCitation('Booming registry citation about service failure', {}, deps())
  assert.equal(errored.status, 'unverified', 'a failing registry is never reported as verified')
  assert.notEqual(errored.status, 'fabricated', 'a registry outage must not accuse the model of inventing')
  assert.match(errored.reason, /API error 500/)

  const matched = await verifyCitation('Phage display library design principles for low abundance targets', {}, deps())
  assert.equal(matched.status, 'verified')
  assert.equal(matched.doi, '10.1000/matched')
  assert.ok(matched.matchScore >= TITLE_MATCH_THRESHOLD)

  const weak = await verifyCitation('Soil microbiome responses to shading in field plots', {}, deps())
  assert.equal(weak.status, 'unverified', 'a partial title match is unverified, not fabricated')
  assert.ok(weak.matchScore > 0, 'the overlap it did find is reported')
  assert.ok(weak.matchScore < TITLE_MATCH_THRESHOLD)
  assert.equal(weak.best_match.doi, '10.1000/near', 'the near miss is reported so a scientist can judge it')
  assert.match(weak.reason, /below 0.7/)

  const distant = await verifyCitation('A wholly unmatchable claim about quantum gardening', {}, deps())
  assert.equal(distant.status, 'unverified')
  assert.equal(distant.matchScore, 0, 'a candidate with no title overlap is not a match')
  assert.match(distant.reason, /shared 3 significant title tokens/)
  assert.equal(distant.best_match.doi, '10.1000/none', 'the closest returned record is still shown')

  const nothing = await verifyCitation('Empty result citation about nothing at all', {}, deps())
  assert.equal(nothing.status, 'unverified')
  assert.match(nothing.reason, /no Crossref candidate/)

  const proseOnly = await verifyCitation('Smith 2021 Cell', {}, deps([['query.bibliographic=Smith 2021 Cell', {
    ok: true, status: 200, data: { message: { items: [{ DOI: '10.1000/x', title: ['Cell'] }] } },
  }]]))
  assert.equal(proseOnly.status, 'unverified', 'an author-year-venue pointer cannot be title-matched')

  const cancelled = await verifyCitation('see 10.5555/whatever', {}, deps([['works/10.5555/whatever', { ok: false, status: 0, error: 'aborted' }]]))
  assert.equal(cancelled.status, 'unverified')
  assert.equal(cancelled.reason, 'request cancelled')

  const polite = []
  const withMailto = await verifyCitation(`https://doi.org/${REAL_DOI}`, {}, {
    fetchJson: async (url) => { polite.push(url); return crossrefWork(REAL_DOI, 'Real paper on ribosomal stalling') },
    getLimiter: noPacing,
  })
  assert.equal(withMailto.status, 'verified')
  assert.ok(!polite[0].includes('mailto='), 'no mailto is invented when none is configured')

  const politeUrl = []
  await verifyCitation('Phage display library design principles for low abundance targets', { mailto: 'sci@example.org' }, {
    fetchJson: async (url) => { const d = decodeURIComponent(url).replace(/\+/g, ' '); politeUrl.push(d); return baseRoutes.find(([frag]) => d.includes(frag))[1] },
    getLimiter: noPacing,
  })
  assert.match(politeUrl[0], /mailto=sci@example\.org/, 'a configured contact joins the polite pool')

  // ── the tool drives the ledger ─────────────────────────────────────────────
  await startTournament({ cwd, slug, protocol: { goal: 'verify pipeline', max_hypotheses: 6 } })

  const mixed = await addHypothesis({
    cwd, slug, strategy: 'generation:literature_exploration',
    hypothesis: {
      title: 'Ribosomal stalling gates the stress-granule response',
      summary: 'Stalling at a short uORF limits granule assembly under arsenite stress.',
      content: 'Predicts that relieving stalling restores granule dynamics.',
      citations: [`https://doi.org/${REAL_DOI}`, 'Phage display library design principles for low abundance targets', 'Bosco 2020 eLife 10.9999/invented', 'A wholly unmatchable claim about quantum gardening'],
    },
  })
  const id = mixed.hypothesis.id

  const beforeCheck = await runCoscVerify({ action: 'status', slug, id }, exec, deps())
  assert.equal(beforeCheck.checked, false)
  assert.equal(beforeCheck.citations, 4)

  const checked = await runCoscVerify({ action: 'citations', slug, id }, exec, deps())
  assert.deepEqual(checked.counts, { total: 4, verified: 2, unverified: 1, fabricated: 1 })
  assert.equal(checked.penalty.f, Number(((1 + 0.5 * 1) / 4).toFixed(4)))
  assert.equal(checked.penalty.ratingDelta, -Math.round(0.375 * 150))
  assert.equal(checked.late_penalty_applied, null, 'a pending_review hypothesis is not active yet, so the seed will absorb the penalty')
  const recorded = deriveState(cwd, slug).byId.get(id).citationCheck
  assert.equal(recorded.total, 4)
  assert.equal(recorded.reportedCounts, true)
  assert.equal(recorded.claims, null, 'a citation check must not invent claim judgements')

  const rechecked = await runCoscVerify({ action: 'citations', slug, id }, exec, deps())
  assert.equal(rechecked.late_penalty_applied, null)
  assert.equal(deriveState(cwd, slug).byId.get(id).rating, mixed.hypothesis.rating, 'nothing has been seeded yet, so no penalty has been charged')

  // The review sequence now completes and folds the recorded penalty into the seed once.
  for (const stage of ['initial', 'full', 'deep_verification', 'simulation', 'observation']) {
    await recordReview({ cwd, slug, id, stage, verdict: 'pass', noveltyScore: 6, correctnessScore: 6, testabilityScore: 6 })
  }
  const seeded = deriveState(cwd, slug).byId.get(id)
  assert.equal(seeded.status, 'active')
  // 6/6/6 review scores seed at 1240; the recorded penalty is −56.
  assert.equal(seeded.rating, 1240 - 56, 'the seed carries the citation penalty exactly once')
  assert.equal(seeded.rd, 238)

  const afterSeed = await runCoscVerify({ action: 'citations', slug, id }, exec, deps())
  assert.equal(afterSeed.late_penalty_applied, null, 're-verifying identical counts must not charge twice')
  assert.equal(deriveState(cwd, slug).byId.get(id).rating, seeded.rating)

  const statusAfter = await runCoscVerify({ action: 'status', slug, id }, exec, deps())
  assert.equal(statusAfter.checked, true)
  assert.deepEqual(statusAfter.counts, { total: 4, verified: 2, unverified: 1, fabricated: 1 })
  assert.equal(statusAfter.penalty.ratingDelta, -56)
  assert.match(text([{ type: 'text', text: JSON.stringify(statusAfter) }]), /verified/)

  // A worse report still costs more, and only the difference.
  const worse = await runCoscVerify({ action: 'citations', slug, id: (await addHypothesis({
    cwd, slug, hypothesis: { title: 'Second idea with one shaky reference', summary: 'Somatic mosaicism in CNS myeloid cells sets disease tempo.', content: 'Predicts clone size tracks progression rate.', citations: ['Bosco 2020 eLife 10.9999/invented'] },
  })).hypothesis.id }, exec, deps())
  assert.deepEqual(worse.counts, { total: 1, verified: 0, unverified: 0, fabricated: 1 })
  assert.equal(worse.penalty.ratingDelta, -150, 'a single fabricated DOI is a 100 % fabrication rate')

  // ── claim judgements are recorded, never invented ──────────────────────────
  const claims = await runCoscVerify({
    action: 'claims', slug, id,
    claims: [
      { claim: 'Stalling occurs at a short uORF in the target gene', support: 'supports', confidence: 0.8, paper_title: 'Real paper on ribosomal stalling', paper_doi: REAL_DOI },
      { claim: 'Relieving stalling restores granule dynamics', support: 'contradicts', confidence: 0.6, paper_title: 'Granule dynamics are buffering-driven', paper_doi: '10.1000/contradicting' },
      { claim: 'The effect is specific to motor neurons', support: 'unaddressed', confidence: 0.3 },
    ],
  }, exec, deps())
  assert.equal(claims.contradicted, 1)
  assert.equal(claims.claims.length, 3)
  assert.equal(claims.penalty.ratingDelta, -56, 'the claims pass reports the counts already on the ledger')
  const stored = deriveState(cwd, slug).byId.get(id).citationCheck
  assert.equal(stored.claims.length, 3)
  assert.equal(stored.total, 4, 'recording claims must not erase the citation counts')
  assert.equal(stored.contradicted, 1)
  const claimsStatus = await runCoscVerify({ action: 'status', slug, id }, exec, deps())
  assert.deepEqual(claimsStatus.claims, { recorded: 3, supports: 1, contradicts: 1, unaddressed: 1 })

  await assert.rejects(
    () => runCoscVerify({ action: 'claims', slug, id, claims: [{ claim: 'x', support: 'maybe', confidence: 0.5 }] }, exec, deps()),
    /claim support must be one of/,
  )
  await assert.rejects(
    () => runCoscVerify({ action: 'claims', slug, id, claims: [{ claim: 'x', support: 'supports' }] }, exec, deps()),
    /confidence is required/,
  )
  await assert.rejects(() => runCoscVerify({ action: 'claims', slug, id, claims: [] }, exec, deps()), /non-empty/)
  await assert.rejects(() => runCoscVerify({ action: 'claims', slug, id, claims: Array.from({ length: 21 }, () => ({ claim: 'c', support: 'supports', confidence: 0.5 })) }, exec, deps()), /at most 20/)

  // ── retraction status is reported, and never changes the penalty ───────────
  const withIntegrity = await runCoscVerify({
    action: 'citations', slug,
    id: (await addHypothesis({
      cwd, slug, hypothesis: { title: 'Third idea citing a withdrawn paper', summary: 'Withdrawn evidence about splicing fidelity is reused here.', content: 'Predicts nothing, deliberately.', citations: [`https://doi.org/${RETRACTED_DOI}`, `https://doi.org/${REAL_DOI}`] },
    })).hypothesis.id,
    check_integrity: true,
  }, exec, deps())
  assert.equal(withIntegrity.counts.verified, 2, 'a retracted paper still exists, so it is verified')
  assert.equal(withIntegrity.counts.fabricated, 0)
  assert.equal(withIntegrity.penalty.ratingDelta, 0, 'existence is what the penalty measures')
  assert.equal(withIntegrity.rows[0].integrity, 'retracted')
  assert.equal(withIntegrity.retracted.length, 1)
  assert.equal(withIntegrity.retracted[0].doi, RETRACTED_DOI)
  assert.match(text([{ type: 'text', text: JSON.stringify(withIntegrity.retracted[0]) }]), /pulled/)

  // ── argument handling ──────────────────────────────────────────────────────
  await assert.rejects(() => runCoscVerify({ action: 'citations', id }, exec, deps()), /slug is required/)
  await assert.rejects(() => runCoscVerify({ action: 'citations', slug }, exec, deps()), /id is required/)
  await assert.rejects(() => runCoscVerify({ action: 'citations', slug, id: 'h404' }, exec, deps()), /unknown hypothesis id: h404/)
  await assert.rejects(() => runCoscVerify({ action: 'nonsense', slug, id }, exec, deps()), /action must be one of/)
  await assert.rejects(
    () => runCoscVerify({ action: 'status', slug: 'not-a-tournament', id: 'h1' }, exec, deps()),
    /has not been started/,
  )

  const empty = await runCoscVerify({
    action: 'citations', slug,
    id: (await addHypothesis({
      cwd, slug, hypothesis: { title: 'Fourth idea that cites nothing at all', summary: 'A claim offered without any reference.', content: 'Prediction: nothing is cited here.', citations: [] },
    })).hypothesis.id,
  }, exec, deps())
  assert.equal(empty.counts.total, 0)
  assert.equal(empty.penalty.ratingDelta, 0)
  assert.match(empty.note, /cites nothing/)

  const tooMany = await addHypothesis({
    cwd, slug,
    hypothesis: {
      title: 'Fifth idea with an absurd reference list',
      summary: 'Cites more works than one call should hammer the registry for.',
      content: 'Refused before any request is made.',
      citations: Array.from({ length: MAX_CITATIONS_PER_CALL + 1 }, (_, i) => `10.1000/many${i}`),
    },
  })
  await assert.rejects(
    () => runCoscVerify({ action: 'citations', slug, id: tooMany.hypothesis.id }, exec, deps()),
    /exceeds the 30-per-call limit/,
  )

  // ── the leaderboard surfaces what verification found ───────────────────────
  const board = leaderboard(cwd, slug)
  const row = board.ranked.find((entry) => entry.id === id)
  assert.match(row.citation_check, /2 verified · 1 unverified · 1 fabricated/)

  // ── the tool is absent unless the optional gate is open ────────────────────
  const registered = []
  const ctx = { tools: { register: (tool) => registered.push(tool) } }
  const previous = process.env.AH_ENABLE_OPTIONAL_TOOLS
  delete process.env.AH_ENABLE_OPTIONAL_TOOLS
  apply(ctx)
  assert.deepEqual(registered, [], 'a gated tool must register nothing by default')
  process.env.AH_ENABLE_OPTIONAL_TOOLS = '1'
  apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'coscientist_verify')
  assert.equal(registered[0].parameters.properties.action.enum.length, 3)
  assert.deepEqual(registered[0].parameters.properties.claims.items.type, 'object')
  if (previous === undefined) delete process.env.AH_ENABLE_OPTIONAL_TOOLS
  else process.env.AH_ENABLE_OPTIONAL_TOOLS = previous

  console.log('coscientist-verify OK')
} finally {
  resetLimitersForTests()
  rmSync(cwd, { recursive: true, force: true })
}
