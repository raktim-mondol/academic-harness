/**
 * NASA Astrophysics Data System (ADS): keyed literature search, citation and
 * reference trails, BibTeX export, and metrics. Requires ADS_API_TOKEN; ADS
 * applies a daily quota and can return 429 when it is exhausted.
 */
import { resolveEnv } from './credential-env.js'
import { fetchJson, fetchText, getLimiter, searchUserAgent } from './search-http.js'
import { canonicalBibcode, fromAdsDoc, renderPapers } from './search-normalize.js'

const API = 'https://api.adsabs.harvard.edu/v1'
const FIELDS = ['bibcode', 'title', 'author', 'year', 'doi', 'abstract', 'citation_count', 'pub', 'arxiv', 'doctype', 'keyword', 'identifier'].join(',')

function limiter() {
  return getLimiter('ads', { minIntervalMs: 1000 })
}

function quotaFromHeaders(headers) {
  const rawRemaining = headers?.get?.('x-ratelimit-remaining') ?? headers?.get?.('x-ads-ratelimit-remaining')
  const rawLimit = headers?.get?.('x-ratelimit-limit') ?? headers?.get?.('x-ads-ratelimit-limit')
  const remaining = rawRemaining == null || rawRemaining === '' ? NaN : Number(rawRemaining)
  const limit = rawLimit == null || rawLimit === '' ? NaN : Number(rawLimit)
  return {
    ...(Number.isFinite(remaining) ? { quota_remaining: remaining } : {}),
    ...(Number.isFinite(limit) ? { quota_limit: limit } : {}),
  }
}

function keyMissing() {
  return {
    error: 'ADS_API_TOKEN is required for ADS search',
    code: 'key_missing',
    field: 'ADS_API_TOKEN',
  }
}

function providerError(result) {
  if (result.error === 'aborted') return { error: 'request cancelled' }
  if (result.status === 401 || result.status === 403) {
    return {
      error: `NASA ADS rejected the token (${result.status}); check ADS_API_TOKEN`,
      status: result.status,
      code: 'not_entitled',
      detail: result.detail ?? result.error,
    }
  }
  if (result.status === 429) {
    return {
      error: 'NASA ADS quota or rate limit exceeded',
      status: result.status,
      code: 'quota',
      ...quotaFromHeaders(result.headers),
      detail: result.detail ?? result.error,
    }
  }
  return { error: `NASA ADS API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
}

function bibcodesOf(args) {
  const raw = args.bibcodes ?? args.bibcode ?? args.id
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',')
  return [...new Set(list.map(canonicalBibcode).filter(Boolean))]
}

export async function runAdsSearch(args, exec) {
  const token = await resolveEnv('ADS_API_TOKEN')
  if (!token) return keyMissing()
  const query = String(args.query || '').trim()
  if (!query) return { error: 'query is required' }
  const params = new URLSearchParams({
    q: query,
    fl: FIELDS,
    rows: String(Math.min(Math.max(Number(args.limit) || 20, 1), 100)),
    start: String(Math.max(0, Number(args.offset) || 0)),
  })
  if (args.sort) params.set('sort', String(args.sort))
  const result = await limiter().run(() => fetchJson(`${API}/search/query?${params}`, {
    signal: exec?.signal,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': searchUserAgent(),
    },
  }))
  if (!result.ok) return providerError(result)
  const response = result.data?.response || {}
  const results = (response.docs || []).map(fromAdsDoc).filter(Boolean)
  return {
    total: response.numFound ?? results.length,
    offset: Math.max(0, Number(args.offset) || 0),
    ...quotaFromHeaders(result.headers),
    results,
  }
}

async function adsRequest(path, bibcodes, exec, { text = false, bodyKey = 'bibcode' } = {}) {
  const token = await resolveEnv('ADS_API_TOKEN')
  if (!token) return { error: keyMissing() }
  const fn = text ? fetchText : fetchJson
  const result = await limiter().run(() => fn(`${API}/${path}`, {
    method: 'POST',
    signal: exec?.signal,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: text ? 'text/plain' : 'application/json',
      'User-Agent': searchUserAgent(),
    },
    body: JSON.stringify({ [bodyKey]: bibcodes }),
  }))
  if (!result.ok) return { error: providerError(result) }
  return { data: result.data, ...quotaFromHeaders(result.headers) }
}

export async function runAdsDomain(args, exec) {
  const action = String(args.action || 'record').toLowerCase()
  const bibcodes = bibcodesOf(args)
  if (!bibcodes.length) return { error: 'give bibcode, bibcodes, or id' }
  if (action === 'record') {
    const value = await runAdsSearch({ query: `bibcode:"${bibcodes[0]}"`, limit: 1 }, exec)
    if (value.error) return value
    return { action, bibcode: bibcodes[0], record: value.results?.[0] || null, ...(value.quota_remaining != null ? { quota_remaining: value.quota_remaining } : {}) }
  }
  if (action === 'citations' || action === 'references') {
    const value = await runAdsSearch({ query: `${action}(bibcode:"${bibcodes[0]}")`, limit: args.limit }, exec)
    if (value.error) return value
    return { action, bibcode: bibcodes[0], ...value }
  }
  if (action === 'export') {
    const value = await adsRequest('export/bibtex', bibcodes, exec, { text: true })
    if (value.error) return value.error
    return { action, bibcodes, bibtex: value.data, ...(value.quota_remaining != null ? { quota_remaining: value.quota_remaining } : {}) }
  }
  if (action === 'metrics') {
    const value = await adsRequest('metrics', bibcodes, exec, { bodyKey: 'bibcodes' })
    if (value.error) return value.error
    return { action, bibcodes, metrics: value.data, ...(value.quota_remaining != null ? { quota_remaining: value.quota_remaining } : {}) }
  }
  return { error: 'action must be record, citations, references, export, or metrics' }
}

export function renderAdsSearch(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}${value.code === 'key_missing' ? ' (set ADS_API_TOKEN in Settings)' : ''}` }]
  const header = [
    `NASA ADS: ${value.total ?? value.results.length} total`,
    value.quota_remaining != null ? `quota remaining ${value.quota_remaining}` : null,
  ].filter(Boolean).join(' · ')
  return [{ type: 'text', text: `${header}\n\n${renderPapers(value.results || [])}` }]
}

export function renderAdsDomain(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}${value.code === 'key_missing' ? ' (set ADS_API_TOKEN in Settings)' : ''}` }]
  if (value.bibtex != null) {
    return [{ type: 'text', text: `ADS BibTeX (${value.bibcodes.join(', ')})\n\n\`\`\`bibtex\n${String(value.bibtex).trim()}\n\`\`\`` }]
  }
  if (value.metrics) {
    return [{ type: 'text', text: `ADS metrics for ${value.bibcodes.join(', ')}\n\n\`\`\`json\n${JSON.stringify(value.metrics, null, 2)}\n\`\`\`` }]
  }
  if (value.record) {
    const paper = value.record
    return [{ type: 'text', text: `**${paper.title}**\n${paper.year || ''} · ${paper.venue || ''}\n${paper.doi ? `doi: ${paper.doi}` : ''}${paper.url ? `\n${paper.url}` : ''}` }]
  }
  if (value.results) {
    const header = `NASA ADS ${value.action || 'search'}: ${value.total ?? value.results.length}`
    return [{ type: 'text', text: `${header}\n\n${renderPapers(value.results)}` }]
  }
  return [{ type: 'text', text: 'No ADS result.' }]
}
