import assert from 'node:assert/strict'
import { resetFutureHouseTokensForTests } from '../futurehouse-agent.js'
import { arxivDiscoveryQuery, chooseSources } from '../literature-search.js'
import {
  arxivIdFromDoi,
  assertPublicUrl,
  fetchPdf,
  isPrivateIp,
  resolvePdfCandidates,
  resolveWorkspacePath,
} from '../paper-download.js'
import { resetLimitersForTests } from '../search-http.js'

process.env.BRAVE_API_KEY = 'test-brave'
process.env.PARALLEL_API_KEY = 'test-parallel'
process.env.TAVILY_API_KEY = 'test-tavily'
process.env.EXA_API_KEY = 'test-exa'
process.env.PERPLEXITY_API_KEY = 'test-perplexity'
process.env.CORE_API_KEY = 'test-core'
process.env.ELICIT_API_KEY = 'test-elicit'
process.env.FUTUREHOUSE_API_KEY = 'test-futurehouse'
delete process.env.JINA_API_KEY

const originalFetch = globalThis.fetch
const calls = []

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function loadTool(name) {
  const tools = []
  const module = await import(new URL(`../${name}`, import.meta.url))
  module.apply({ tools: { register: (tool) => tools.push(tool) } })
  return tools[0]
}

const brave = await loadTool('brave-search.js')
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  return jsonResponse({
    web: {
      results: [{
        title: 'Brave Title',
        url: 'https://www.example.org/a',
        description: 'Brave description',
        profile: { long_name: 'Example' },
        extra_snippets: ['extra snippet'],
      }],
    },
  })
}
const braveValue = await brave.execute({ query: 'test', count: 1, extra_snippets: true }, {})
assert.equal(calls.length, 1)
assert.match(calls[0].url, /api\.search\.brave\.com/)
assert.equal(calls[0].init.headers['X-Subscription-Token'], 'test-brave')
assert.equal(braveValue.results[0].title, 'Brave Title')
assert.match(brave.output.render({ query: 'test' }, braveValue)[0].text, /Brave description/)

const search = await loadTool('parallel-search.js')
calls.length = 0
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  return jsonResponse({ results: [{ url: 'https://example.org', title: 'Result', excerpts: ['x'] }] })
}
const searchValue = await search.execute({ objective: 'find x', search_queries: ['x'], mode: 'fast' }, {})
assert.equal(searchValue.mode, 'fast')
assert.equal(calls[0].init.headers['x-api-key'], 'test-parallel')
assert.match(calls[0].url, /api\.parallel\.ai\/v1\/search/)

const extract = await loadTool('parallel-extract.js')
calls.length = 0
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  return jsonResponse({
    results: [{ url: 'https://example.org', title: 'Page', excerpts: ['excerpt'], full_content: 'full body' }],
  })
}
const extractValue = await extract.execute({ urls: ['https://example.org'], full_content: true }, {})
assert.equal(extractValue.results[0].full_content, 'full body')
assert.equal(calls[0].init.headers['x-api-key'], 'test-parallel')
const extractText = extract.output.render({}, extractValue)[0].text
assert.match(extractText, /Page/)
assert.match(extractText, /full body/)

const tavily = await loadTool('tavily-search.js')
calls.length = 0
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  return jsonResponse({
    answer: 'Because.',
    results: [{
      title: 'Tavily Title',
      url: 'https://www.example.org/t',
      content: 'Tavily content',
      published_date: '2024-01-02',
    }],
  })
}
const tavilyValue = await tavily.execute({ query: 'test', search_depth: 'basic' }, {})
assert.equal(calls[0].init.headers.Authorization, 'Bearer test-tavily')
assert.equal(JSON.parse(calls[0].init.body).search_depth, 'basic')
assert.equal(tavilyValue.results[0].title, 'Tavily Title')
assert.match(tavily.output.render({ query: 'test' }, tavilyValue)[0].text, /Because\./)

const exa = await loadTool('exa-search.js')
calls.length = 0
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  return jsonResponse({
    requestId: 'exa-request',
    costDollars: { total: 0.005 },
    results: [{
      id: 'exa-1',
      title: 'Exa Title',
      url: 'https://example.org/e',
      summary: 'Exa summary',
      author: 'Ada Lovelace',
      publishedDate: '2023-05-06',
      highlights: ['highlight'],
    }],
  })
}
const exaValue = await exa.execute({ query: 'test', type: 'auto', include_summary: true }, {})
assert.equal(calls[0].init.headers['x-api-key'], 'test-exa')
assert.equal(JSON.parse(calls[0].init.body).contents.summary, true)
assert.equal(exaValue.results[0].abstract, 'Exa summary')

const perplexity = await loadTool('perplexity-search.js')
calls.length = 0
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  return jsonResponse({
    id: 'pplx-request',
    results: [{ title: 'Perplexity Title', url: 'https://example.org/p', snippet: 'Perplexity snippet', date: '2024-02-03' }],
  })
}
const perplexityValue = await perplexity.execute({ query: 'test', search_type: 'fast' }, {})
assert.equal(calls[0].init.headers.Authorization, 'Bearer test-perplexity')
assert.equal(JSON.parse(calls[0].init.body).search_type, 'fast')
assert.equal(perplexityValue.results[0].title, 'Perplexity Title')

const jina = await loadTool('jina-reader.js')
calls.length = 0
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  return new Response('# Markdown body', { status: 200, headers: { 'content-type': 'text/plain' } })
}
const jinaValue = await jina.execute({ url: 'https://example.org/a' }, {})
assert.equal(calls[0].url, 'https://r.jina.ai/https://example.org/a')
assert.equal(calls[0].init.headers.Authorization, undefined)
assert.equal(jinaValue.content, '# Markdown body')
const jinaSearchError = await jina.execute({ mode: 'search', query: 'test' }, {})
assert.match(jinaSearchError.error, /JINA_API_KEY is required/)

const core = await loadTool('core-search.js')
calls.length = 0
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  return jsonResponse({
    totalHits: 1,
    results: [{
      id: 1,
      title: 'Core Title',
      doi: '10.1000/abc.1',
      authors: [{ name: 'Ada Lovelace' }],
      yearPublished: 2022,
      downloadUrl: 'https://core.ac.uk/download/1.pdf',
      links: [],
      fullText: 'Core full text body',
    }],
  })
}
const coreValue = await core.execute({ query: 'test', include_fulltext: true }, {})
assert.equal(calls[0].init.headers.Authorization, 'Bearer test-core')
assert.equal(coreValue.results[0].full_text, 'Core full text body')
assert.match(core.output.render({}, coreValue)[0].text, /Full text excerpts/)

const elicit = await loadTool('elicit-search.js')
calls.length = 0
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  return jsonResponse({
    papers: [{
      elicitId: 'elicit-1',
      title: 'Elicit Title',
      authors: ['Ada Lovelace'],
      year: 2024,
      abstract: 'Elicit abstract',
      urls: ['https://example.org/e'],
      studyTypeTags: ['RCT'],
    }],
    warnings: [],
  })
}
const elicitValue = await elicit.execute({ query: 'test', type_tags: ['RCT'] }, {})
assert.equal(calls[0].init.headers.Authorization, 'Bearer test-elicit')
assert.equal(JSON.parse(calls[0].init.body).filters.typeTags[0], 'RCT')
assert.equal(elicitValue.papers[0].title, 'Elicit Title')

calls.length = 0
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  return jsonResponse({
    trials: [{
      nctId: 'NCT123',
      title: 'Trial Title',
      summary: 'Trial summary',
      startDate: '2023-01-01',
      conditions: ['Obesity'],
      phase: ['PHASE2'],
      overallStatus: 'RECRUITING',
      url: 'https://clinicaltrials.gov/study/NCT123',
      studyType: 'INTERVENTIONAL',
      enrollmentCount: 10,
      interventions: ['Drug'],
      hasResults: false,
    }],
    warnings: [],
  })
}
const trialsValue = await elicit.execute({ kind: 'trials', query: 'trial', phase: ['PHASE2'] }, {})
assert.equal(trialsValue.kind, 'trials')
assert.equal(trialsValue.trials[0].trial.nct_id, 'NCT123')
assert.match(elicit.output.render({}, trialsValue)[0].text, /Trial Title/)

const futurehouse = await loadTool('futurehouse-agent.js')
const TASK_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
resetFutureHouseTokensForTests()
calls.length = 0
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  if (String(url).endsWith('/auth/login')) return jsonResponse({ access_token: 'fh-token' })
  if (String(url).endsWith('/v0.1/crows')) return jsonResponse({ trajectory_id: TASK_ID })
  return jsonResponse({
    status: 'success',
    task: 'why?',
    crow: 'job-futurehouse-paperqa3',
    environment_frame: {
      state: { state: { response: { answer: { answer: 'Because.', formatted_answer: 'Because reasons.' } } } },
    },
  })
}
const startValue = await futurehouse.execute({ action: 'start', agent: 'quick_search', query: 'why?' }, {})
assert.equal(startValue.task_id, TASK_ID)
assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
const statusValue = await futurehouse.execute({ action: 'status', task_id: TASK_ID }, {})
assert.equal(statusValue.status, 'success')
assert.equal(statusValue.answer, 'Because.')
assert.equal(calls[2].init.headers.Authorization, 'Bearer fh-token')
assert.match(futurehouse.output.render({}, statusValue)[0].text, /Because reasons\./)
assert.equal(calls.length, 3, 'status should reuse the cached FutureHouse token')

const badTaskId = await futurehouse.execute({ action: 'status', task_id: '../etc' }, {})
assert.match(badTaskId.error, /UUID/)

resetFutureHouseTokensForTests()
calls.length = 0
let authCalls = 0
let createCalls = 0
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  if (String(url).endsWith('/auth/login')) {
    authCalls += 1
    return jsonResponse({ access_token: `token-${authCalls}` })
  }
  if (String(url).endsWith('/v0.1/crows')) {
    createCalls += 1
    if (createCalls === 1) return jsonResponse({ error: 'expired' }, 401)
    return jsonResponse({ trajectory_id: TASK_ID })
  }
  return jsonResponse({ status: 'queued' })
}
const refreshed = await futurehouse.execute({ action: 'start', agent: 'quick_search', query: 'x' }, {})
assert.equal(refreshed.task_id, TASK_ID)
assert.equal(authCalls, 2, 'a 401 must trigger a fresh token exchange')
assert.equal(calls[3].init.headers.Authorization, 'Bearer token-2')

resetFutureHouseTokensForTests()
calls.length = 0
let statusCalls = 0
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  if (String(url).endsWith('/auth/login')) return jsonResponse({ access_token: 'fh-token' })
  if (String(url).includes('/cancel')) return jsonResponse({ ok: true })
  statusCalls += 1
  return jsonResponse({
    status: statusCalls === 1 ? 'in progress' : 'cancelled',
    task: 'q',
    crow: 'job-futurehouse-paperqa3',
  })
}
const cancelled = await futurehouse.execute({ action: 'cancel', task_id: TASK_ID }, {})
assert.equal(cancelled.status, 'cancelled')
assert.equal(statusCalls, 2, 'cancel should poll status before and after')

resetFutureHouseTokensForTests()
globalThis.fetch = async () => jsonResponse({ error: 'bad key' }, 401)
const authFailure = await futurehouse.execute({ action: 'start', agent: 'quick_search', query: 'x' }, {})
assert.match(authFailure.error, /authentication failed \(401\)/)

assert.deepEqual(chooseSources('malaria treatment outcomes', 'auto'), ['openalex', 's2', 'pubmed'])
assert.deepEqual(chooseSources('transformer language model benchmark', 'auto'), ['openalex', 's2', 'arxiv'])
assert.deepEqual(chooseSources('anything', 'crossref,s2'), ['crossref', 's2'])
assert.deepEqual(chooseSources('anything', []), ['openalex', 's2'])
assert.deepEqual(chooseSources('anything', ['auto']), ['openalex', 's2'])
assert.throws(() => chooseSources('x', 'nope'), /unknown source/)
assert.equal(
  arxivDiscoveryQuery('transformer language model benchmark'),
  'all:transformer AND all:language AND all:model AND all:benchmark',
)
assert.equal(arxivDiscoveryQuery('ti:retrieval AND abs:agents'), 'ti:retrieval AND abs:agents')

const literature = await loadTool('literature-search.js')
calls.length = 0
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  const target = String(url)
  if (target.includes('api.openalex.org')) {
    return jsonResponse({
      meta: { count: 2 },
      results: [
        {
          id: 'https://openalex.org/W1',
          doi: 'https://doi.org/10.1000/shared',
          title: 'Shared Paper',
          publication_year: 2024,
          authorships: [{ author: { display_name: 'Ada Lovelace' } }],
          primary_location: { source: { display_name: 'Journal' }, landing_page_url: 'https://example.org/shared' },
          open_access: { oa_status: 'gold' },
          best_oa_location: { pdf_url: 'https://example.org/shared.pdf' },
          cited_by_count: 5,
          type: 'article',
          topics: [],
        },
        {
          id: 'https://openalex.org/W2',
          doi: 'https://doi.org/10.1000/other',
          title: 'Other Paper',
          publication_year: 2023,
          authorships: [],
          primary_location: { source: { display_name: 'Other Journal' } },
          open_access: { oa_status: 'closed' },
          cited_by_count: 1,
          type: 'article',
          topics: [],
        },
      ],
    })
  }
  if (target.includes('api.semanticscholar.org')) {
    return jsonResponse({
      total: 1,
      data: [{
        paperId: 's2-1',
        externalIds: { DOI: '10.1000/shared' },
        title: 'Shared Paper',
        year: 2024,
        venue: 'Journal',
        authors: [{ name: 'Ada Lovelace' }],
        citationCount: 8,
        openAccessPdf: { url: 'https://example.org/shared.pdf' },
        fieldsOfStudy: [],
        publicationTypes: ['JournalArticle'],
      }],
    })
  }
  throw new Error(`unexpected URL ${target}`)
}
const literatureValue = await literature.execute({ query: 'shared paper', sources: ['openalex', 's2'], max_results: 10 }, {})
assert.equal(literatureValue.papers.length, 2, 'the shared DOI must dedupe across sources')
assert.equal(literatureValue.papers[0].doi, '10.1000/shared')
assert.deepEqual(literatureValue.papers[0].sources.sort(), ['openalex', 's2'])
assert.equal(literatureValue.failures.length, 0)
assert.ok(literatureValue.papers[0].rrf_score > 0)
assert.match(literature.output.render({}, literatureValue)[0].text, /Literature search/)

calls.length = 0
globalThis.fetch = async (url) => {
  const target = String(url)
  if (target.includes('api.openalex.org')) return jsonResponse({ error: 'down' }, 404)
  return jsonResponse({
    total: 1,
    data: [{
      paperId: 's2-2',
      externalIds: { DOI: '10.1000/s2-only' },
      title: 'S2 Only',
      year: 2024,
      venue: 'Journal',
      authors: [],
      citationCount: 1,
    }],
  })
}
const partial = await literature.execute({ query: 's2 only', sources: ['openalex', 's2'] }, {})
assert.equal(partial.failures[0].source, 'openalex')
assert.equal(partial.papers[0].doi, '10.1000/s2-only')

const sharedResult = {
  id: 'https://openalex.org/W1',
  doi: 'https://doi.org/10.1000/shared',
  title: 'Shared Paper',
  publication_year: 2024,
  authorships: [],
  primary_location: { source: { display_name: 'Journal' }, landing_page_url: 'https://example.org/shared' },
  open_access: { oa_status: 'gold' },
  best_oa_location: { pdf_url: 'https://example.org/shared.pdf' },
  cited_by_count: 5,
  type: 'article',
  topics: [],
}
const closedResult = {
  id: 'https://openalex.org/W2',
  doi: 'https://doi.org/10.1000/closed',
  title: 'Closed Paper',
  publication_year: 2023,
  authorships: [],
  primary_location: { source: { display_name: 'Other Journal' } },
  open_access: { oa_status: 'closed' },
  cited_by_count: 1,
  type: 'article',
  topics: [],
}
function installOpenAlexOnlyMock() {
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return jsonResponse({ meta: { count: 2 }, results: [sharedResult, closedResult] })
  }
}

installOpenAlexOnlyMock()
const capped = await literature.execute({ query: 'shared paper', sources: ['openalex'], max_results: 100 }, {})
assert.equal(capped.papers.length, 2)
assert.match(calls[0].url, /per_page=100/)
assert.equal(capped.truncated, false)

installOpenAlexOnlyMock()
const short = await literature.execute({ query: 'shared paper', sources: ['openalex'], max_results: 1 }, {})
assert.equal(short.papers.length, 1)
assert.equal(short.truncated, true)

installOpenAlexOnlyMock()
const filtered = await literature.execute({ query: 'shared paper', sources: ['openalex'], open_access_only: true, year_min: 2024 }, {})
assert.equal(filtered.papers.length, 1)
assert.equal(filtered.papers[0].doi, '10.1000/shared')

const crossrefOnly = await literature.execute({ query: 'x', sources: ['crossref'], open_access_only: true }, {})
assert.match(crossrefOnly.error, /cannot be applied to Crossref/)

assert.equal(arxivIdFromDoi('10.48550/arXiv.2301.12345'), '2301.12345')
assert.equal(arxivIdFromDoi('10.1000/not-arxiv'), null)
assert.throws(() => resolveWorkspacePath('/tmp/ah-project', '../ah-project-evil/x.pdf'), /path escapes/)
assert.equal(isPrivateIp('127.0.0.1'), true)
assert.equal(isPrivateIp('169.254.169.254'), true)
assert.equal(isPrivateIp('10.1.2.3'), true)
assert.equal(isPrivateIp('8.8.8.8'), false)
assert.equal(isPrivateIp('::1'), true)
assert.equal(isPrivateIp('fe80::1'), true)
assert.equal(isPrivateIp('2001:4860:4860::8888'), false)
await assert.rejects(assertPublicUrl('http://127.0.0.1/admin'), /private\/internal/)
await assert.rejects(assertPublicUrl('http://169.254.169.254/latest/meta-data'), /private\/internal/)
await assert.rejects(assertPublicUrl('file:///etc/passwd'), /HTTP\(S\)/)

calls.length = 0
globalThis.fetch = async (url) => {
  const target = String(url)
  if (target.includes('api.unpaywall.org')) return jsonResponse({ is_oa: false, oa_status: 'closed' })
  if (target.includes('europepmc')) {
    return jsonResponse({
      resultList: {
        result: [{
          id: '1',
          source: 'MED',
          title: 'Europe PMC Paper',
          fullTextUrlList: {
            fullTextUrl: [{ availability: 'Open access', documentStyle: 'pdf', url: 'https://europepmc.org/paper.pdf' }],
          },
        }],
      },
    })
  }
  if (target.includes('api.core.ac.uk')) {
    return jsonResponse({
      results: [{ id: 2, title: 'CORE Paper', downloadUrl: 'https://core.ac.uk/download/2.pdf' }],
    })
  }
  throw new Error(`unexpected URL ${target}`)
}
resetLimitersForTests()
const fallbacks = await resolvePdfCandidates({ doi: '10.1000/test', email: 'test@example.org' })
assert.deepEqual(fallbacks.candidates.map((candidate) => candidate.source), ['europepmc', 'core'])
assert.equal(fallbacks.attempts[0].source, 'unpaywall')

resetLimitersForTests()
const noEmail = await resolvePdfCandidates({ doi: '10.1000/test' })
assert.equal(noEmail.attempts[0].source, 'unpaywall')
assert.match(noEmail.attempts[0].error, /UNPAYWALL_EMAIL is not set/)
assert.deepEqual(noEmail.candidates.map((candidate) => candidate.source), ['europepmc', 'core'])

let pdfCalls = 0
globalThis.fetch = async () => {
  pdfCalls += 1
  return new Response(Buffer.from('%PDF-1.4 test'), {
    status: 200,
    headers: { 'content-type': 'application/pdf' },
  })
}
const pdf = await fetchPdf('https://93.184.216.34/paper.pdf')
assert.ok(pdf.subarray(0, 5).equals(Buffer.from('%PDF-')))

pdfCalls = 0
globalThis.fetch = async () => {
  pdfCalls += 1
  if (pdfCalls === 1) {
    return new Response(null, { status: 302, headers: { location: 'https://93.184.216.34/final.pdf' } })
  }
  return new Response(Buffer.from('%PDF-1.4 test'), { status: 200 })
}
const redirectedPdf = await fetchPdf('https://93.184.216.34/start.pdf')
assert.ok(redirectedPdf.subarray(0, 5).equals(Buffer.from('%PDF-')))
assert.equal(pdfCalls, 2)

globalThis.fetch = async () => new Response(null, {
  status: 302,
  headers: { location: 'http://127.0.0.1/admin' },
})
await assert.rejects(fetchPdf('https://93.184.216.34/start.pdf'), /private\/internal/)

globalThis.fetch = async () => new Response('<html>paywall secret</html>', {
  status: 200,
  headers: { 'content-type': 'text/html' },
})
await assert.rejects(fetchPdf('https://93.184.216.34/x.pdf'), (error) => (
  /not a PDF/.test(error.message) && !/paywall secret/.test(error.message)
))

delete process.env.CORE_API_KEY
calls.length = 0
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  return jsonResponse({ totalHits: 0, results: [] })
}
const coreKeyless = await core.execute({ query: 'test' }, {})
assert.equal(coreKeyless.total, 0)
assert.equal(calls[0].init.headers.Authorization, undefined)
const coreFulltextKeyless = await core.execute({ query: 'test', include_fulltext: true }, {})
assert.match(coreFulltextKeyless.error, /CORE_API_KEY is required for include_fulltext/)

delete process.env.BRAVE_API_KEY
assert.match((await brave.execute({ query: 'x' }, {})).error, /BRAVE_API_KEY is not set/)
delete process.env.TAVILY_API_KEY
assert.match((await tavily.execute({ query: 'x' }, {})).error, /TAVILY_API_KEY is not set/)
delete process.env.EXA_API_KEY
assert.match((await exa.execute({ query: 'x' }, {})).error, /EXA_API_KEY is not set/)
delete process.env.PERPLEXITY_API_KEY
assert.match((await perplexity.execute({ query: 'x' }, {})).error, /PERPLEXITY_API_KEY is not set/)
delete process.env.ELICIT_API_KEY
assert.match((await elicit.execute({ query: 'x' }, {})).error, /ELICIT_API_KEY is not set/)
delete process.env.FUTUREHOUSE_API_KEY
assert.match((await futurehouse.execute({ action: 'start', agent: 'quick_search', query: 'x' }, {})).error, /FUTUREHOUSE_API_KEY is not set/)
delete process.env.PARALLEL_API_KEY
assert.match((await extract.execute({ urls: ['https://example.org'] }, {})).error, /PARALLEL_API_KEY is not set/)
assert.match((await search.execute({ objective: 'x', search_queries: ['x'], mode: 'fast' }, {})).error, /PARALLEL_API_KEY is not set/)

globalThis.fetch = originalFetch
console.log('Search tool execution OK')
