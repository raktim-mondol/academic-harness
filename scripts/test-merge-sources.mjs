import assert from 'node:assert/strict'
import {
  arxivDoi, doiFromUrl, emptyPaper, fromConsensusResult, fromFirecrawlPaper, fromParallelResult,
  fromSciteHit, isPreprintDoi, isScholarlyUrl, mergePapers, mergeRanked, renderPapers,
} from '../search-normalize.js'
import { resetMcpHttpForTests } from '../mcp-http.js'
import { resetLimitersForTests } from '../search-http.js'
import { resetJevForTests } from '../jev-router.js'

const realFetch = globalThis.fetch
for (const key of ['TYPESAFE_API_KEY', 'ADS_API_TOKEN', 'CONSENSUS_API_KEY', 'SCITE_API_KEY', 'FIRECRAWL_API_KEY', 'PARALLEL_API_KEY']) delete process.env[key]
const mk = (source, fields) => ({ ...emptyPaper(source), ...fields })
const group = (source, ...papers) => ({ source, results: papers.map((p) => mk(source, p)) })
const LONG = 'Semaglutide and Cardiovascular Outcomes in Obesity without Diabetes'

/* ------------------------------------------------------------------ DOI helpers */
{
  assert.equal(doiFromUrl('https://www.nejm.org/doi/full/10.1056/NEJMoa2307563'), '10.1056/nejmoa2307563')
  assert.equal(doiFromUrl('https://www.jacc.org/doi/10.1016/S0735-1097%2825%2900862-9'), '10.1016/s0735-1097(25)00862-9', 'percent-encoded parentheses decode')
  assert.equal(doiFromUrl('https://www.aeaweb.org/articles?id=10.1257%2Fpol.20180578'), '10.1257/pol.20180578', 'query-string DOI with an encoded slash')
  assert.equal(doiFromUrl('https://doi.org/10.1038/s41586-021-03819-2.'), '10.1038/s41586-021-03819-2', 'trailing full stop dropped')
  assert.equal(doiFromUrl('https://link.springer.com/article/10.1007/s10115-025-02548-6'), '10.1007/s10115-025-02548-6')
  assert.equal(doiFromUrl('https://arxiv.org/abs/2405.01663'), null, 'no DOI is invented for an arXiv URL')
  assert.equal(doiFromUrl('https://www.nber.org/papers/w12663'), null)
  assert.equal(doiFromUrl(''), null)
  assert.equal(arxivDoi('2405.01663'), '10.48550/arxiv.2405.01663')
  assert.equal(arxivDoi('not an id'), null)
  assert.ok(isPreprintDoi('10.1101/2025.05.20.25327768') && isPreprintDoi('10.48550/arXiv.1706.03762') && !isPreprintDoi('10.1056/nejmoa2307563'))
  assert.ok(isScholarlyUrl('https://pubmed.ncbi.nlm.nih.gov/38907684/'))
  assert.ok(isScholarlyUrl('https://example.org/files/10.1234/abc'), 'a DOI in the URL is enough')
  assert.ok(!isScholarlyUrl('https://www.reuters.com/business/some-news') && !isScholarlyUrl('not a url'))
}

/* ------------------------------------------------------------------ normalisers */
{
  const c = fromConsensusResult({
    title: 'Semaglutide and Cardiovascular Outcomes in Obesity without Diabetes.', doi: 'https://doi.org/10.1056/NEJMoa2307563',
    authors: ['A M Lincoff', 'K Brown-Frandsen'], publish_year: 2023, journal_name: 'The New England journal of medicine',
    takeaway: 'Semaglutide cut major adverse cardiovascular events by 20%.', study_type: 'rct', citation_count: 3000,
    sjr_best_quartile: 1, is_preprint: false, url: 'https://consensus.app/x',
  })
  assert.equal(c.doi, '10.1056/nejmoa2307563')
  assert.equal(c.year, 2023)
  assert.equal(c.takeaway, 'Semaglutide cut major adverse cardiovascular events by 20%.')
  assert.equal(c.study_type, 'rct')
  assert.equal(c.journal_quartile, 'Q1')
  assert.deepEqual(c.authors.map((a) => a.name), ['A M Lincoff', 'K Brown-Frandsen'])
  assert.equal(c.source, 'consensus')

  const s = fromSciteHit({
    doi: '10.1056/nejmoa2307563', title: 'Semaglutide and Cardiovascular Outcomes in Obesity without Diabetes',
    authors: [{ authorName: 'Abraham Michael Lincoff' }], journal: 'new england journal of medicine', year: 2023,
    tally: { total: 2269, supporting: 62, contrasting: 7, mentioning: 2152, citingPublications: 3427 }, isOa: true, oaStatus: 'bronze',
  })
  assert.deepEqual(s.scite, { supporting: 62, contrasting: 7, mentioning: 2152, total: 2269, citing_publications: 3427 })
  assert.equal(s.citation_count, 3427)
  assert.equal(s.oa_status, 'bronze')
  assert.equal(fromSciteHit({ doi: '10.1/x', title: 'No tally here at all', authors: [] }).scite, undefined)

  const f = fromFirecrawlPaper({ primaryId: 'pmid:37952131', ids: { doi: ['10.1056/NEJMoa2307563'], pmid: ['37952131'] }, title: 'Semaglutide and Cardiovascular Outcomes in Obesity without Diabetes.', authors: ['A Lincoff'], createdDate: '2023-12-14', abstract: 'BACKGROUND: …' })
  assert.deepEqual([f.doi, f.pmid, f.year], ['10.1056/nejmoa2307563', '37952131', 2023])
  const arx = fromFirecrawlPaper({ primaryId: 'arxiv:2305.16102', ids: { arxiv: ['2305.16102'] }, title: 'Demystifying Oversmoothing in Attention-Based Graph Neural Networks', createdDate: '2023-05-25' })
  assert.equal(arx.doi, '10.48550/arxiv.2305.16102', 'an arXiv-only paper gets arXiv\'s own DOI')
  assert.equal(arx.arxiv_id, '2305.16102')
  assert.equal(arx.url, 'https://arxiv.org/abs/2305.16102')

  const pOk = fromParallelResult({ url: 'https://www.nejm.org/doi/full/10.1056/NEJMoa2307563', title: 'Semaglutide and Cardiovascular Outcomes', publish_date: '2023-11-11', excerpts: ['In patients with…', 'second excerpt'] })
  assert.equal(pOk.doi, '10.1056/nejmoa2307563')
  assert.equal(pOk.year, 2023)
  assert.match(pOk.abstract, /In patients with… second excerpt/)
  assert.equal(fromParallelResult({ url: 'https://arxiv.org/abs/2405.01663', title: 'A GNN paper' }).arxiv_id, '2405.01663')
  assert.equal(fromParallelResult({ url: 'https://pubmed.ncbi.nlm.nih.gov/38907684/', title: 'A PubMed paper' }).pmid, '38907684')
  assert.equal(fromParallelResult({ url: 'https://www.reuters.com/world/some-story', title: 'News' }), null, 'news is not a paper')
  assert.equal(fromParallelResult({ url: 'https://example.com/blog', title: 'Blog' }), null)
  // a DOI that only appears in the excerpt is a citation, not the page's own: never trusted
  const cited = fromParallelResult({ url: 'https://www.nature.com/articles/s41586-021-03819-2', title: 'Highly accurate protein structure prediction', excerpts: ['see doi 10.9999/other.paper for details'] })
  assert.equal(cited.doi, null)
}

/* ------------------------------------------------------------------ merge identity */
{
  // the defect that started this: distinct published DOIs sharing a title are NOT one paper
  const ed = mergeRanked([group('openalex', { title: 'Editorial', year: 2022, doi: '10.1000/a' }), group('s2', { title: 'Editorial', year: 2022, doi: '10.2000/b' })])
  assert.equal(ed.length, 2, 'two Editorials with different DOIs stay two papers')
  assert.deepEqual(ed.map((p) => p.doi).sort(), ['10.1000/a', '10.2000/b'])
  // long titles too, and they point at each other
  const t = 'A long identical title shared by two different articles'
  const twin = mergeRanked([group('a', { title: t, year: 2020, doi: '10.1000/a' }), group('b', { title: t, year: 2020, doi: '10.2000/b' })])
  assert.equal(twin.length, 2)
  assert.deepEqual(twin.find((p) => p.doi === '10.1000/a').same_title_dois, ['10.2000/b'])
  assert.match(renderPapers(twin), /same title, different DOI/)

  // a preprint and its published version are one work; the published DOI leads, nothing is lost
  for (const order of [['biorxiv', 'openalex'], ['openalex', 'biorxiv']]) {
    const docs = { biorxiv: { title: t, year: 2023, doi: '10.1101/2023.01.01.111' }, openalex: { title: t, year: 2023, doi: '10.1234/journal.42' } }
    const merged = mergeRanked(order.map((source) => group(source, docs[source])))
    assert.equal(merged.length, 1, `preprint + published merge (${order.join(' then ')})`)
    assert.equal(merged[0].doi, '10.1234/journal.42')
    assert.deepEqual(merged[0].preprint_dois, ['10.1101/2023.01.01.111'])
    assert.match(renderPapers(merged), /preprint: 10\.1101\/2023\.01\.01\.111/)
  }
  // a later record carrying only the preprint DOI still lands on the same paper
  const later = mergeRanked([
    group('openalex', { title: t, year: 2023, doi: '10.1234/journal.42' }),
    group('biorxiv', { title: t, year: 2023, doi: '10.1101/2023.01.01.111' }),
    group('europepmc', { title: 'Other title entirely about something else', year: 2023, doi: '10.1101/2023.01.01.111' }),
  ])
  assert.equal(later.length, 1, 'a shared preprint DOI is an identifier, not a title guess')

  // the same strong identifier merges even when titles differ (subtitle)
  const sub = mergeRanked([group('openalex', { title: 'Attention Is All You Need', doi: '10.5555/3295222', year: 2017 }), group('s2', { title: 'Attention Is All You Need: Transformers for sequence transduction', doi: '10.5555/3295222', year: 2017 })])
  assert.equal(sub.length, 1)

  // missing year: a long title still merges, a short one never does
  assert.equal(mergeRanked([group('openalex', { title: LONG, year: 2023, doi: '10.1056/nejmoa2307563' }), group('parallel', { title: LONG, year: null, doi: null })]).length, 1)
  assert.equal(mergeRanked([group('a', { title: 'Editorial', year: null }), group('b', { title: 'Editorial', year: null })]).length, 2)
  assert.equal(mergeRanked([group('a', { title: LONG, year: 2015 }), group('b', { title: LONG, year: 2023 })]).length, 2, 'years 8 apart are not one paper')
  assert.equal(mergePapers([mk('a', { title: 'Same Title', year: 2020 }), mk('b', { title: 'Same  title!', year: 2020 })]).length, 1, 'short title + same year still collapses')

  // a shared PMID with two published DOIs keeps both DOIs on one record
  const pm = mergePapers([mk('a', { title: 'X record one', pmid: '123456', doi: '10.1000/a' }), mk('b', { title: 'X record one', pmid: '123456', doi: '10.2000/b' })])
  assert.equal(pm.length, 1)
  assert.deepEqual([pm[0].doi, pm[0].other_dois], ['10.1000/a', ['10.2000/b']])

  // arXiv's DOI yields to a journal DOI, and the two records are one paper
  const ax = mergeRanked([
    group('firecrawl', { title: 'Demystifying Oversmoothing in Attention-Based Graph Neural Networks', year: 2023, arxiv_id: '2305.16102', doi: '10.48550/arxiv.2305.16102' }),
    group('openalex', { title: 'Demystifying Oversmoothing in Attention-Based Graph Neural Networks', year: 2024, arxiv_id: '2305.16102', doi: '10.1234/iclr.2024.1' }),
  ])
  assert.equal(ax.length, 1)
  assert.equal(ax[0].doi, '10.1234/iclr.2024.1')
  assert.deepEqual(ax[0].preprint_dois, ['10.48550/arxiv.2305.16102'])

  // many records: matching stays linear (a regression guard against an O(n^2) scan)
  const big = Array.from({ length: 4000 }, (_, i) => mk('openalex', { title: `Synthetic study number ${i} of widget dynamics`, year: 2000 + (i % 24), doi: `10.1/${i}` }))
  const started = Date.now()
  assert.equal(mergePapers(big).length, 4000)
  assert.ok(Date.now() - started < 3000, `4000-record merge took ${Date.now() - started} ms`)
}

/* ------------------------------------------------------------------ ranking */
{
  const one = 1 / 61
  // Crossref and its publisher-member searches are one index: one vote
  const cr = mergeRanked([group('crossref', { title: LONG, doi: '10.1/x' }), group('publisher:wiley', { title: LONG, doi: '10.1/x' })])
  assert.ok(Math.abs(cr[0].rrf_score - one) < 1e-12)
  assert.deepEqual(cr[0].sources.sort(), ['crossref', 'publisher:wiley'], 'both sources are still listed')
  // independent sources add up
  const three = mergeRanked([group('openalex', { title: LONG, doi: '10.1/x' }), group('consensus', { title: LONG, doi: '10.1/x' }), group('scite', { title: LONG, doi: '10.1/x' })])
  assert.ok(Math.abs(three[0].rrf_score - 3 * one) < 1e-12)
  // a paper found by two sources outranks one found by one, even if the lone one is first
  const order = mergeRanked([
    group('openalex', { title: 'Lonely paper that only one source knows about', doi: '10.1/lonely' }, { title: 'Shared paper that two sources both found today', doi: '10.1/shared' }),
    group('scite', { title: 'Shared paper that two sources both found today', doi: '10.1/shared' }),
  ])
  assert.equal(order[0].doi, '10.1/shared')
}

/* ------------------------------------------------------------------ one paper, five sources */
{
  const merged = mergeRanked([
    group('openalex', { title: LONG, year: 2023, doi: '10.1056/nejmoa2307563', citation_count: 100, authors: [{ name: 'A Lincoff' }] }),
    { source: 'consensus', results: [fromConsensusResult({ title: LONG, doi: '10.1056/NEJMoa2307563', publish_year: 2023, takeaway: 'Reduced MACE by 20%.', study_type: 'rct', citation_count: 3000, authors: ['A M Lincoff', 'K Brown-Frandsen'] })] },
    { source: 'scite', results: [fromSciteHit({ doi: '10.1056/nejmoa2307563', title: LONG, year: 2023, tally: { total: 2269, supporting: 62, contrasting: 7, mentioning: 2152, citingPublications: 3427 } })] },
    { source: 'firecrawl', results: [fromFirecrawlPaper({ primaryId: 'pmid:37952131', ids: { doi: ['10.1056/NEJMoa2307563'], pmid: ['37952131'] }, title: LONG + '.', createdDate: '2023-12-14' })] },
    { source: 'parallel', results: [fromParallelResult({ url: 'https://www.nejm.org/doi/full/10.1056/NEJMoa2307563', title: LONG })] },
  ])
  assert.equal(merged.length, 1, 'five sources, one paper')
  const p = merged[0]
  assert.deepEqual(p.sources.sort(), ['consensus', 'firecrawl', 'openalex', 'parallel', 'scite'])
  assert.equal(p.doi, '10.1056/nejmoa2307563')
  assert.equal(p.pmid, '37952131', 'Firecrawl contributes the PMID')
  assert.equal(p.citation_count, 3427, 'highest citation count wins')
  assert.equal(p.authors.length, 2, 'longest author list wins')
  assert.equal(p.takeaway, 'Reduced MACE by 20%.')
  assert.equal(p.scite.supporting, 62)
  assert.ok(Math.abs(p.rrf_score - 5 / 61) < 1e-12)
  const text = renderPapers(merged, { showSources: true })
  assert.match(text, /scite: 62 supporting · 7 contrasting · 2152 mentioning/)
  assert.match(text, /takeaway: Reduced MACE by 20%\./)
}

/* ------------------------------------------------------------------ adapters against mocked servers */
const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
const calls = []

function mcpServer({ name, onCall, sse = false, strictSession = false }) {
  let sessions = 0
  return async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ name, method: body.method, tool: body.params?.name, session: init.headers['mcp-session-id'], url: String(url) })
    const reply = (result, headers = {}) => {
      const payload = { jsonrpc: '2.0', id: body.id, result }
      return sse
        ? new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } })
        : json(payload, { headers: { 'content-type': 'application/json', ...headers } })
    }
    if (body.method === 'initialize') { sessions += 1; return reply({ serverInfo: { name }, capabilities: {} }, { 'mcp-session-id': `${name}-sess-${sessions}` }) }
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    if (body.method === 'tools/call') {
      if (strictSession && init.headers['mcp-session-id'] !== `${name}-sess-${sessions}`) return new Response('unknown session', { status: 404 })
      return reply(await onCall(body.params))
    }
    return new Response('?', { status: 400 })
  }
}

const sciteBody = { total: 3732040, count: 1, hits: [{ doi: '10.1056/nejmoa2307563', title: LONG, authors: [{ authorName: 'A Lincoff' }], journal: 'nejm', year: 2023, tally: { total: 10, supporting: 6, contrasting: 1, mentioning: 3, citingPublications: 9 }, isOa: false }] }
const fcBody = { results: [{ primaryId: 'pmid:37952131', ids: { doi: ['10.1056/NEJMoa2307563'], pmid: ['37952131'] }, title: LONG + '.', createdDate: '2023-12-14', authors: ['A Lincoff'] }] }

{
  const { runSource } = await import('../literature-search.js')
  process.env.SCITE_API_KEY = 'scite-secret-key'
  process.env.FIRECRAWL_API_KEY = 'fc-secret-key'
  process.env.CONSENSUS_API_KEY = 'consensus-secret-key'
  process.env.PARALLEL_API_KEY = 'parallel-secret-key'

  // Scite over plain JSON, session reused across calls
  resetMcpHttpForTests(); resetLimitersForTests(); calls.length = 0
  globalThis.fetch = mcpServer({ name: 'scite', onCall: (params) => ({ content: [{ type: 'text', text: JSON.stringify(sciteBody) }], _tool: params.name }) })
  const a = await runSource('scite', { query: 'semaglutide', perSource: 10, yearMin: 2020, yearMax: 2024 })
  assert.equal(a.results.length, 1)
  assert.equal(a.results[0].scite.supporting, 6)
  const callArgs = calls.filter((c) => c.method === 'tools/call')
  assert.equal(callArgs[0].tool, 'search_literature')
  await runSource('scite', { query: 'again', perSource: 10 })
  assert.equal(calls.filter((c) => c.method === 'initialize').length, 1, 'the MCP session is opened once and reused')
  assert.ok(calls.filter((c) => c.method === 'tools/call').every((c) => c.session === 'scite-sess-1'), 'every tool call carries the session id')

  // Firecrawl over SSE with structuredContent; the key lives in the URL and must not leak
  resetMcpHttpForTests(); resetLimitersForTests(); calls.length = 0
  globalThis.fetch = mcpServer({ name: 'fc', sse: true, onCall: () => ({ content: [{ type: 'text', text: '## [pmid:37952131] md rendering' }], structuredContent: fcBody }) })
  const f = await runSource('firecrawl', { query: 'semaglutide', perSource: 10 })
  assert.equal(f.results[0].doi, '10.1056/nejmoa2307563')
  assert.equal(f.results[0].pmid, '37952131')
  assert.match(calls[0].url, /mcp\.firecrawl\.dev\/fc-secret-key\/v2\/mcp/)
  assert.equal(calls.find((c) => c.method === 'tools/call').tool, 'firecrawl_research_search_papers')

  // a server that forgets the session: one transparent re-initialise
  resetMcpHttpForTests(); resetLimitersForTests(); calls.length = 0
  let wipe = false
  const inner = mcpServer({ name: 'fc2', strictSession: true, onCall: () => ({ content: [], structuredContent: fcBody }) })
  globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); if (wipe && b.method === 'tools/call' && b.id < 200 && init.headers['mcp-session-id'] === 'fc2-sess-1') { wipe = false; return new Response('gone', { status: 404 }) } return inner(url, init) }
  await runSource('firecrawl', { query: 'one', perSource: 5 })
  wipe = true
  const recovered = await runSource('firecrawl', { query: 'two', perSource: 5 })
  assert.equal(recovered.results.length, 1, 'recovered after the session was dropped')
  assert.equal(calls.filter((c) => c.method === 'initialize').length, 2)

  // failures are reported, keyed errors never contain a secret
  for (const [status, expected] of [[401, 'auth_failed'], [429, 'rate_limited'], [500, 'http_500']]) {
    resetMcpHttpForTests(); resetLimitersForTests()
    globalThis.fetch = async (url, init) => (JSON.parse(init.body).method === 'initialize' ? json({ jsonrpc: '2.0', id: 1, result: {} }, { headers: { 'content-type': 'application/json', 'mcp-session-id': 's' } }) : new Response('nope', { status }))
    const failed = await runSource('firecrawl', { query: 'x', perSource: 5 })
    assert.match(failed.error, new RegExp(expected), `status ${status} -> ${expected}`)
    assert.ok(!JSON.stringify(failed).includes('fc-secret-key'), 'the secret never appears in an error')
  }
  resetMcpHttpForTests(); resetLimitersForTests()
  globalThis.fetch = async () => { throw new TypeError('fetch failed: https://mcp.firecrawl.dev/fc-secret-key/v2/mcp') }
  const net = await runSource('firecrawl', { query: 'x', perSource: 5 })
  assert.match(net.error, /network_error/)
  assert.ok(!JSON.stringify(net).includes('fc-secret-key'), 'a network error that quotes the URL is not passed on')

  // missing keys: no request at all
  delete process.env.SCITE_API_KEY; delete process.env.FIRECRAWL_API_KEY; delete process.env.CONSENSUS_API_KEY; delete process.env.PARALLEL_API_KEY
  resetMcpHttpForTests(); resetLimitersForTests(); calls.length = 0
  globalThis.fetch = async () => { throw new Error('must not fetch without a key') }
  for (const source of ['scite', 'firecrawl', 'consensus', 'parallel']) {
    const r = await runSource(source, { query: 'x', perSource: 5 })
    assert.equal(r.code, 'key_missing', `${source} without a key`)
  }
}

/* ------------------------------------------------------------------ literature_search end to end */
{
  process.env.SCITE_API_KEY = 'scite-secret-key'
  process.env.FIRECRAWL_API_KEY = 'fc-secret-key'
  process.env.CONSENSUS_API_KEY = 'consensus-secret-key'
  process.env.PARALLEL_API_KEY = 'parallel-secret-key'
  resetMcpHttpForTests(); resetLimitersForTests(); resetJevForTests()
  const sci = mcpServer({ name: 'scite', onCall: () => ({ content: [{ type: 'text', text: JSON.stringify(sciteBody) }] }) })
  const fc = mcpServer({ name: 'fc', onCall: () => ({ content: [], structuredContent: fcBody }) })
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.includes('api.scite.ai')) return sci(url, init)
    if (target.includes('mcp.firecrawl.dev')) return fc(url, init)
    if (target.includes('api.consensus.app')) return json({ results: [{ title: LONG + '.', doi: '10.1056/NEJMoa2307563', authors: ['A M Lincoff', 'K Brown-Frandsen'], publish_year: 2023, takeaway: 'Reduced MACE by 20%.', study_type: 'rct', citation_count: 3000 }], page: 0, page_size: 5, is_end: true })
    if (target.includes('api.parallel.ai')) return json({ results: [
      { url: 'https://www.nejm.org/doi/full/10.1056/NEJMoa2307563', title: LONG, publish_date: '2023-11-11', excerpts: ['In patients with overweight…'] },
      { url: 'https://www.reuters.com/business/novo-nordisk-shares', title: 'Novo shares jump', excerpts: ['news'] },
    ] })
    if (target.includes('api.openalex.org')) return json({ meta: { count: 1 }, results: [{ id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1056/nejmoa2307563', title: LONG, publication_year: 2023, authorships: [], primary_location: { source: { display_name: 'NEJM' } }, open_access: { oa_status: 'bronze' }, cited_by_count: 100, type: 'article', topics: [] }] })
    throw new Error(`unexpected URL ${target.replace(/fc-secret-key/, '***')}`)
  }
  const tools = []
  ;(await import('../literature-search.js')).apply({ tools: { register: (t) => tools.push(t) } })
  const tool = tools[0]
  const value = await tool.execute({ query: 'semaglutide cardiovascular outcomes', sources: ['openalex', 'consensus', 'scite', 'firecrawl', 'parallel'], max_results: 10 }, {})
  assert.equal(value.failures.length, 0, JSON.stringify(value.failures))
  assert.equal(value.total_unique, 1, 'five sources returned the same paper once each; Parallel\'s news row was dropped')
  const paper = value.papers[0]
  assert.deepEqual(paper.sources.sort(), ['consensus', 'firecrawl', 'openalex', 'parallel', 'scite'])
  assert.equal(paper.doi, '10.1056/nejmoa2307563')
  assert.equal(paper.scite.supporting, 6)
  assert.equal(paper.takeaway, 'Reduced MACE by 20%.')
  assert.equal(paper.pmid, '37952131')
  assert.ok(Math.abs(paper.rrf_score - Number((5 / 61).toFixed(5))) < 1e-9)
  assert.equal(value.routing.engine, 'manual')
  assert.match(tool.output.render({}, value)[0].text, /sources: .*scite/)

  // open_access_only: Parallel and Firecrawl cannot say, so they are skipped with a warning
  const oa = await tool.execute({ query: 'semaglutide', sources: ['openalex', 'firecrawl', 'parallel'], open_access_only: true }, {})
  assert.deepEqual(oa.sources, ['openalex'])
  assert.match(oa.warnings.join(' '), /firecrawl, parallel skipped/)
  const oaOnly = await tool.execute({ query: 'semaglutide', sources: ['parallel'], open_access_only: true }, {})
  assert.match(oaOnly.error, /open_access_only cannot be applied to parallel/)

  // the four are explicit-only: auto never picks them
  const auto = await tool.execute({ query: 'semaglutide cardiovascular outcomes', routing: 'rules' }, {})
  for (const name of ['consensus', 'scite', 'firecrawl', 'parallel']) assert.ok(!auto.sources.includes(name), `${name} is not auto-selected`)
  for (const key of ['SCITE_API_KEY', 'FIRECRAWL_API_KEY', 'CONSENSUS_API_KEY', 'PARALLEL_API_KEY']) delete process.env[key]
}

/* ------------------------------------------------------------------ packaging */
{
  const { readFileSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  for (const file of ['mcp-http.js', 'firecrawl-papers.js', 'scite-search.js']) assert.ok(pkg.files.includes(file), `${file} must ship: literature-search.js imports it`)
}

globalThis.fetch = realFetch
console.log('merge and sources OK')
