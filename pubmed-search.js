/**
 * Biomedical literature search: Europe PMC by default, NCBI E-utilities on
 * request.
 *
 * Europe PMC returns JSON, needs no key, supports MeSH terms, and includes
 * open-access full-text links. The NCBI path is two-step (esearch then
 * esummary) and honors NCBI_API_KEY (10 RPS vs 3 RPS).
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import {
  fromEuropePmcResult,
  fromNcbiSummary,
  renderPapers,
} from './search-normalize.js'

const EUROPE_PMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search'
const NCBI = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
const SOURCES = ['europepmc', 'ncbi']
const RESULT_TYPES = ['lite', 'core']

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const header = [
    value.source === 'ncbi' ? 'PubMed (NCBI)' : 'Europe PMC',
    `${value.hit_count ?? value.results.length} total`,
    value.next_cursor_mark ? 'more results available via cursor_mark' : null,
  ].filter(Boolean).join(' · ')
  return [{ type: 'text', text: `${header}\n\n${renderPapers(value.results || [])}` }]
}

async function searchEuropePmc(args, exec) {
  const params = new URLSearchParams({
    query: String(args.query).trim(),
    format: 'json',
    resultType: RESULT_TYPES.includes(args.result_type) ? args.result_type : 'lite',
    pageSize: String(Math.min(Math.max(Number(args.max_results) || 25, 1), 100)),
  })
  if (args.cursor_mark) params.set('cursorMark', String(args.cursor_mark))
  if (args.sort) params.set('sort', String(args.sort).trim())

  const limiter = getLimiter('europepmc', { minIntervalMs: 200 })
  const result = await limiter.run(() => fetchJson(`${EUROPE_PMC}?${params}`, {
    signal: exec.signal,
    headers: { 'User-Agent': searchUserAgent() },
  }))
  if (!result.ok) {
    return { error: `Europe PMC API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
  }
  const data = result.data || {}
  const results = (data.resultList?.result || []).map(fromEuropePmcResult).filter(Boolean)
  return {
    source: 'europepmc',
    hit_count: data.hitCount ?? results.length,
    next_cursor_mark: data.nextCursorMark || null,
    results,
  }
}

async function searchNcbi(args, exec) {
  const [apiKey, email] = await Promise.all([
    resolveEnv('NCBI_API_KEY'),
    resolveEnv('NCBI_EMAIL').then((value) => value || resolveEnv('UNPAYWALL_EMAIL')),
  ])
  const common = { tool: 'academic-harness' }
  if (apiKey) common.api_key = apiKey
  if (email) common.email = email
  const userAgent = { 'User-Agent': searchUserAgent(email) }
  const limiter = getLimiter('ncbi', { minIntervalMs: apiKey ? 100 : 334 })

  const esearchParams = new URLSearchParams({
    db: 'pubmed',
    retmode: 'json',
    term: String(args.query).trim(),
    retmax: String(Math.min(Math.max(Number(args.max_results) || 25, 1), 100)),
    sort: args.sort === 'pub_date' ? 'pub_date' : 'relevance',
    ...common,
  })
  const search = await limiter.run(() => fetchJson(`${NCBI}/esearch.fcgi?${esearchParams}`, {
    signal: exec.signal,
    headers: userAgent,
  }))
  if (!search.ok) {
    return { error: `NCBI E-utilities error ${search.status}`, status: search.status, detail: search.detail ?? search.error }
  }
  const searchData = search.data?.esearchresult || {}
  if (searchData.ERROR) return { error: `NCBI E-utilities: ${searchData.ERROR}` }
  const ids = searchData.idlist || []
  if (!ids.length) return { source: 'ncbi', hit_count: 0, results: [] }

  const summaryParams = new URLSearchParams({
    db: 'pubmed',
    retmode: 'json',
    id: ids.join(','),
    ...common,
  })
  const summary = await limiter.run(() => fetchJson(`${NCBI}/esummary.fcgi?${summaryParams}`, {
    signal: exec.signal,
    headers: userAgent,
  }))
  if (!summary.ok) {
    return { error: `NCBI E-utilities error ${summary.status}`, status: summary.status, detail: summary.detail ?? summary.error }
  }
  const summaryData = summary.data?.result || {}
  const results = (summaryData.uids || ids)
    .map((uid) => fromNcbiSummary(summaryData[uid]))
    .filter(Boolean)
  return {
    source: 'ncbi',
    hit_count: Number(searchData.count) || results.length,
    results,
  }
}

export async function runPubMedSearch(args, exec) {
  if (!String(args.query || '').trim()) return { error: 'query is required' }
  const source = SOURCES.includes(args.source) ? args.source : 'europepmc'
  if (args.source && !SOURCES.includes(args.source)) {
    return { error: `source must be one of ${SOURCES.join(', ')}` }
  }
  return source === 'ncbi' ? searchNcbi(args, exec) : searchEuropePmc(args, exec)
}

export const name = 'academic-harness-pubmed-search'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'pubmed_search',
    description: [
      'Search biomedical and life-sciences literature in Europe PMC (default) or PubMed via NCBI E-utilities.',
      'Europe PMC needs no key, returns JSON, supports MeSH queries, and includes open-access full-text links. Use source="ncbi" when you specifically need PubMed/NCBI records; NCBI_API_KEY raises the limit from 3 to 10 RPS.',
      'Use this for clinical/biomedical questions; pair with openalex_search and s2_search for broader coverage, and consensus_search for study-design filters.',
    ].join(' '),
    parameters: {
      query: { type: 'string', required: true, description: 'Europe PMC or PubMed query, including MeSH terms.' },
      source: { type: 'string', enum: SOURCES, description: 'europepmc (default, no key) or ncbi (PubMed E-utilities).' },
      result_type: { type: 'string', enum: RESULT_TYPES, description: 'Europe PMC result detail: lite (default) or core.' },
      max_results: { type: 'number', description: 'Max results, 1-100. Default 25.' },
      cursor_mark: { type: 'string', description: 'Europe PMC cursorMark from a previous response, for paging.' },
      sort: { type: 'string', description: 'Europe PMC sort (e.g. "CITED desc") or NCBI sort ("relevance" or "pub_date").' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      return runPubMedSearch(args, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `PubMed (${args.source || 'europepmc'}): ${args.query || ''}`, kind: 'search' }
    },
  }))
}
