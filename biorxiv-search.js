/**
 * bioRxiv and medRxiv: keyword discovery through Europe PMC (bioRxiv has no
 * keyword-search API) plus date/category browse, DOI details, and the
 * published-version lookup from the bioRxiv API.
 */
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import {
  fromBiorxivRecord,
  fromEuropePmcResult,
  renderPapers,
} from './search-normalize.js'

const EUROPE_PMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search'
const BIORXIV = 'https://api.biorxiv.org'
const SERVERS = ['biorxiv', 'medrxiv']
const DATE = /^\d{4}-\d{2}-\d{2}$/

function serverOf(value) {
  const raw = String(value || '').trim().toLowerCase()
  return SERVERS.includes(raw) ? raw : 'biorxiv'
}

export function buildBiorxivQuery(query) {
  return `(${String(query || '').trim()}) AND SRC:PPR AND (PUBLISHER:"bioRxiv" OR PUBLISHER:"medRxiv")`
}

function withBiorxivSource(paper, publisher) {
  if (!paper) return null
  const server = /medrxiv/i.test(String(publisher || '')) ? 'medrxiv' : 'biorxiv'
  paper.source = 'biorxiv'
  paper.sources = ['biorxiv']
  paper.venue = server === 'medrxiv' ? 'medRxiv' : 'bioRxiv'
  paper.type = 'preprint'
  if (paper.doi) {
    paper.url = `${server === 'medrxiv' ? 'https://www.medrxiv.org' : 'https://www.biorxiv.org'}/content/${paper.doi}`
  }
  return paper
}

export async function runBiorxivSearch(args, exec) {
  const query = String(args.query || '').trim()
  if (!query) return { error: 'query is required' }
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
  const params = new URLSearchParams({
    query: buildBiorxivQuery(query),
    format: 'json',
    resultType: 'lite',
    pageSize: String(limit),
  })
  const email = await resolveEnv('UNPAYWALL_EMAIL')
  const limiter = getLimiter('europepmc', { minIntervalMs: 200 })
  const result = await limiter.run(() => fetchJson(`${EUROPE_PMC}?${params}`, {
    signal: exec?.signal,
    headers: { 'User-Agent': searchUserAgent(email) },
  }))
  if (!result.ok) {
    if (result.error === 'aborted') return { error: 'request cancelled' }
    return { error: `Europe PMC API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
  }
  const data = result.data || {}
  const results = (data.resultList?.result || [])
    .map((entry) => withBiorxivSource(
      fromEuropePmcResult(entry),
      entry.bookOrReportDetails?.publisher || entry.publisher || entry.journalTitle,
    ))
    .filter(Boolean)
  return {
    source: 'biorxiv',
    total: data.hitCount ?? results.length,
    results,
  }
}

async function biorxivDetails(server, interval, cursor, category, signal, email) {
  const params = new URLSearchParams()
  if (category) params.set('category', category)
  const suffix = params.toString() ? `?${params}` : ''
  const url = `${BIORXIV}/details/${server}/${interval}/${cursor}${suffix}`
  const limiter = getLimiter('biorxiv-api', { minIntervalMs: 1000 })
  return limiter.run(() => fetchJson(url, {
    signal,
    headers: { 'User-Agent': searchUserAgent(email) },
  }))
}

export async function runBiorxivDomain(args, exec) {
  const action = String(args.action || 'browse').toLowerCase()
  const server = serverOf(args.server)
  const email = await resolveEnv('UNPAYWALL_EMAIL')

  if (action === 'browse') {
    const end = String(args.end || new Date().toISOString().slice(0, 10))
    const start = String(args.start || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))
    if (!DATE.test(start) || !DATE.test(end)) return { error: 'start and end must be YYYY-MM-DD' }
    const cursor = Math.max(0, Number(args.cursor) || 0)
    const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100)
    const result = await biorxivDetails(server, `${start}/${end}`, cursor, args.category, exec?.signal, email)
    if (!result.ok) {
      if (result.error === 'aborted') return { error: 'request cancelled' }
      return { error: `bioRxiv API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
    }
    const messages = Array.isArray(result.data?.messages) ? result.data.messages : []
    const collection = Array.isArray(result.data?.collection) ? result.data.collection : []
    const results = collection.slice(0, limit).map((record) => fromBiorxivRecord(record, { server })).filter(Boolean)
    return {
      action,
      server,
      start,
      end,
      category: args.category || null,
      cursor,
      total: messages[0]?.total ?? results.length,
      results,
    }
  }

  if (action === 'doi') {
    const doi = String(args.doi || args.id || '').trim()
    if (!doi) return { error: 'doi or id is required' }
    const limiter = getLimiter('biorxiv-api', { minIntervalMs: 1000 })
    const result = await limiter.run(() => fetchJson(`${BIORXIV}/details/${server}/${doi}`, {
      signal: exec?.signal,
      headers: { 'User-Agent': searchUserAgent(email) },
    }))
    if (!result.ok) {
      if (result.error === 'aborted') return { error: 'request cancelled' }
      return { error: `bioRxiv API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
    }
    const collection = Array.isArray(result.data?.collection) ? result.data.collection : []
    return {
      action,
      server,
      doi,
      results: collection.map((record) => fromBiorxivRecord(record, { server })).filter(Boolean),
    }
  }

  if (action === 'published') {
    const doi = String(args.doi || args.id || '').trim()
    if (!doi) return { error: 'doi or id is required' }
    const limiter = getLimiter('biorxiv-api', { minIntervalMs: 1000 })
    const result = await limiter.run(() => fetchJson(`${BIORXIV}/pubs/${server}/${doi}`, {
      signal: exec?.signal,
      headers: { 'User-Agent': searchUserAgent(email) },
    }))
    if (!result.ok) {
      if (result.error === 'aborted') return { error: 'request cancelled' }
      return { error: `bioRxiv API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
    }
    const collection = Array.isArray(result.data?.collection) ? result.data.collection : []
    return { action, server, doi, published: collection }
  }

  return { error: 'action must be browse, doi, or published' }
}

export function renderBiorxivSearch(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const header = `bioRxiv/medRxiv: ${value.total ?? value.results.length} total · showing ${value.results.length}`
  return [{ type: 'text', text: `${header}\n\n${renderPapers(value.results || [])}` }]
}

export function renderBiorxivDomain(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (value.action === 'published') {
    const lines = (value.published || []).map((entry) => [
      `${entry.doi} → ${entry.published || '(no published version)'}`,
      entry.published_doi && entry.published_doi !== entry.published ? `DOI: ${entry.published_doi}` : null,
      entry.journal ? `Journal: ${entry.journal}` : null,
    ].filter(Boolean).join('\n'))
    return [{ type: 'text', text: [`Published versions for ${value.doi}`, ...lines].join('\n\n') || 'No published version found.' }]
  }
  const header = [
    `${value.server} ${value.action}`,
    value.start && value.end ? `${value.start} → ${value.end}` : value.doi,
    value.category ? `category: ${value.category}` : null,
    value.total != null ? `${value.total} total` : null,
  ].filter(Boolean).join(' · ')
  return [{ type: 'text', text: `${header}\n\n${renderPapers(value.results || [])}` }]
}

