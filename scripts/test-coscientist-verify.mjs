import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CITATION_STATUSES, CLAIM_SUPPORTS, MAX_CITATIONS_PER_CALL, MIN_SHARED_TOKENS, NOVELTY_DEFAULT_REFERENCES,
  NOVELTY_MAX_REFERENCES, NOVELTY_METHOD, TITLE_MATCH_THRESHOLD,
  apply, bestQuoteSpan, cleanAbstract, extractDoi, referenceFromCrossref, referenceOverlap, runCoscVerify,
  titleSimilarity, titleTokens, verifyCitation,
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
  ['query.bibliographic=Ribosomal stalling gates the stress-granule response', {
    ok: true,
    status: 200,
    data: { message: { items: [
      {
        DOI: '10.1000/near-stall',
        title: ['Ribosomal stalling at short uORFs gates stress-granule assembly'],
        issued: { 'date-parts': [[2021]] },
        'container-title': ['Molecular Cell'],
        abstract: '<jats:p>Stalling at a short uORF limits granule assembly after arsenite exposure. The effect is specific to the uORF and not a general translation block.</jats:p>',
      },
      {
        DOI: '10.1000/far-stall',
        title: ['Stress granules are buffering-driven assemblies'],
        issued: { 'date-parts': [[2019]] },
        'container-title': ['Cell Reports'],
        abstract: '<jats:p>Granule assembly follows a buffering threshold rather than ribosomal stalling.</jats:p>',
      },
    ] } },
  }],
  ['query.bibliographic=Booming novelty retrieval', { ok: false, status: 500, error: 'server' }],
  ['query.bibliographic=Tagged title novelty retrieval', {
    ok: true,
    status: 200,
    data: { message: { items: [{
      DOI: '10.1000/tagged',
      title: ['EASYSTIFF\n                  <sup>®</sup>\n                  , a portable device able to separately analyze each compartment'],
      issued: { 'date-parts': [[2023]] },
      'container-title': ['Skin Mechanics'],
      abstract: '<jats:p>This device measures each compartment separately and reports stiffness.</jats:p>',
    }] } },
  }],
  ['query.bibliographic=Empty novelty retrieval', {
    ok: true,
    status: 200,
    data: { message: { items: [{ DOI: '10.1000/untitled', title: [], issued: { 'date-parts': [[2020]] } }] } },
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

  // ── grounded novelty helpers ───────────────────────────────────────────────
  assert.equal(NOVELTY_DEFAULT_REFERENCES, 2, 'the paper retrieves two references; that is the default, not a formula')
  assert.equal(NOVELTY_MAX_REFERENCES, 10)
  assert.match(NOVELTY_METHOD, /not a formula from the paper/)
  assert.equal(cleanAbstract('<jats:p>A &amp; B</jats:p>'), 'A & B')
  const parsedReference = referenceFromCrossref({
    DOI: '10.1000/alpha', title: ['Alpha beta gamma'], abstract: '<jats:p>Delta epsilon.</jats:p>',
  })
  assert.equal(parsedReference.doi, '10.1000/alpha')
  assert.equal(parsedReference.text_basis, 'title_abstract')
  assert.equal(parsedReference.abstract, 'Delta epsilon.')
  const taggedReference = referenceFromCrossref({
    DOI: '10.1000/tagged',
    title: ['EASYSTIFF\n                  <sup>®</sup>\n                  , a portable device'],
    abstract: '<jats:p>Stiffness is read per compartment.</jats:p>',
  })
  assert.equal(taggedReference.title, 'EASYSTIFF ® , a portable device', 'a tagged title is normalized before it can anchor a quote')
  assert.equal(referenceFromCrossref({ DOI: '10.1000/none', title: [] }), null, 'an untitled record is not prior art')
  assert.equal(referenceOverlap('alpha beta gamma', { title: 'alpha beta', abstract: null }), 0.667)
  const span = bestQuoteSpan('alpha beta gamma', { title: 'T', abstract: 'delta epsilon. alpha beta gamma theta.' })
  assert.equal(span.quote, 'alpha beta gamma theta.', 'the quote is the best-overlapping sentence, verbatim')

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

  // ── grounded novelty: retrieval, documented score, verbatim quotes ─────────
  const novelty = await runCoscVerify({ action: 'novelty', slug, id }, exec, deps())
  assert.equal(novelty.state, 'checked')
  assert.equal(novelty.references.length, 2)
  assert.ok(novelty.references[0].overlap >= novelty.references[1].overlap, 'nearest prior art is listed first')
  assert.equal(novelty.score_source, 'lexical_overlap')
  assert.equal(novelty.score, novelty.computed_score)
  assert.ok(novelty.score >= 0 && novelty.score <= 10)
  assert.equal(novelty.quotes.length, 2)
  for (const quote of novelty.quotes) {
    const reference = novelty.references.find((entry) => entry.doi === quote.reference_doi)
    assert.ok(reference, `quote names a retrieved reference: ${quote.reference_doi}`)
    assert.ok(`${reference.title}. ${reference.abstract}`.includes(quote.quote), 'the stored quote is verbatim')
  }
  const storedNovelty = deriveState(cwd, slug).byId.get(id).noveltyCheck
  assert.equal(storedNovelty.state, 'checked')
  assert.equal(storedNovelty.references.length, 2)
  assert.equal(storedNovelty.method, NOVELTY_METHOD)
  const statusWithNovelty = await runCoscVerify({ action: 'status', slug, id }, exec, deps())
  assert.equal(statusWithNovelty.novelty.state, 'checked')
  assert.equal(statusWithNovelty.novelty.references, 2)
  assert.equal(statusWithNovelty.novelty.quotes, 2)
  assert.match(text([{ type: 'text', text: JSON.stringify(statusWithNovelty) }]), /lexical_overlap/)

  const pinned = await runCoscVerify({
    action: 'novelty', slug, id, novelty_score: 3.5,
    quotes: [{ quote: 'Stalling at a short uORF limits granule assembly after arsenite exposure.', reference_doi: '10.1000/near-stall', note: 'closest prior art' }],
  }, exec, deps())
  assert.equal(pinned.score, 3.5, 'a caller reading is pinned, not recomputed')
  assert.equal(pinned.score_source, 'caller')
  assert.equal(pinned.quotes.length, 1)
  assert.equal(pinned.quotes[0].note, 'closest prior art')
  assert.ok(pinned.computed_score >= 0 && pinned.computed_score <= 10, 'the lexical reading is still recorded beside it')

  await assert.rejects(
    () => runCoscVerify({ action: 'novelty', slug, id, novelty_score: 11 }, exec, deps()),
    /between 0 and 10/,
  )
  await assert.rejects(
    () => runCoscVerify({ action: 'novelty', slug, id, quotes: [{ quote: 'a sentence no retrieved reference contains' }] }, exec, deps()),
    /not a verbatim span/,
  )

  const taggedNovelty = await runCoscVerify({ action: 'novelty', slug, id, query: 'Tagged title novelty retrieval' }, exec, deps())
  assert.equal(taggedNovelty.state, 'checked', 'a tagged title must not break the quote it anchors')
  assert.equal(taggedNovelty.references[0].title, 'EASYSTIFF ® , a portable device able to separately analyze each compartment')
  assert.equal(taggedNovelty.quotes.length, 1)
  assert.ok(`${taggedNovelty.references[0].title}. ${taggedNovelty.references[0].abstract}`.includes(taggedNovelty.quotes[0].quote))

  const failedNovelty = await runCoscVerify({ action: 'novelty', slug, id, query: 'Booming novelty retrieval' }, exec, deps())
  assert.equal(failedNovelty.state, 'not_checked')
  assert.match(failedNovelty.reason, /failed/)
  assert.equal(failedNovelty.score, undefined, 'a failed retrieval records no score')
  assert.match(text([{ type: 'text', text: `Novelty evidence: ${failedNovelty.reason}` }]), /failed/)
  const untitledNovelty = await runCoscVerify({ action: 'novelty', slug, id, query: 'Empty novelty retrieval' }, exec, deps())
  assert.equal(untitledNovelty.state, 'not_checked')
  assert.match(untitledNovelty.reason, /usable title/)
  const finalStatus = await runCoscVerify({ action: 'status', slug, id }, exec, deps())
  assert.equal(finalStatus.novelty.state, 'not_checked')
  assert.match(finalStatus.novelty.reason, /usable title/)

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

  // ── the tool registers without any flag ────────────────────────────────────
  const registered = []
  const ctx = { tools: { register: (tool) => registered.push(tool) } }
  apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'coscientist_verify')
  assert.equal(registered[0].parameters.properties.action.enum.length, 4)
  assert.match(registered[0].description, /grounded novelty/)
  assert.match(registered[0].parameters.properties.novelty_score.description, /0-10/)
  assert.deepEqual(registered[0].parameters.properties.claims.items.type, 'object')
  assert.deepEqual(registered[0].parameters.properties.quotes.items.type, 'object')

  console.log('coscientist-verify OK')
} finally {
  resetLimitersForTests()
  rmSync(cwd, { recursive: true, force: true })
}
