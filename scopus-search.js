/**
 * Scopus search and author lookup. Requires SCOPUS_API_KEY; access follows the
 * institution's IP/VPN entitlement. Scopus returns 401/403 when the key is
 * valid but the network is not entitled, and 429 when the quota is exhausted.
 */
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { canonicalDoi, canonicalScopusId, fromScopusEntry, renderPapers } from './search-normalize.js'

const API = 'https://api.elsevier.com/content'
const ENTRY_FIELDS = [
  'dc:identifier', 'eid', 'dc:title', 'dc:creator', 'prism:publicationName',
  'prism:coverDate', 'citedby-count', 'prism:doi', 'subtypeDescription',
  'prism:url', 'link',
].join(',')

function limiter() {
  return getLimiter('scopus', { minIntervalMs: 1000 })
}

function keyMissing() {
  return {
    error: 'SCOPUS_API_KEY is required for Scopus search',
    code: 'key_missing',
    field: 'SCOPUS_API_KEY',
  }
}

function quotaFromHeaders(headers) {
  const raw = headers?.get?.('x-ratelimit-remaining') ?? headers?.get?.('x-els-resource-remaining')
  const remaining = raw == null || raw === '' ? NaN : Number(raw)
  return Number.isFinite(remaining) ? { quota_remaining: remaining } : {}
}

function providerError(result) {
  if (result.error === 'aborted') return { error: 'request cancelled' }
  if (result.status === 401 || result.status === 403) {
    return {
      error: `Scopus rejected the key or this network is not entitled (${result.status}); check SCOPUS_API_KEY and the institutional VPN`,
      status: result.status,
      code: 'not_entitled',
      detail: result.detail ?? result.error,
    }
  }
  if (result.status === 429) {
    return {
      error: 'Scopus quota or rate limit exceeded',
      status: result.status,
      code: 'quota',
      ...quotaFromHeaders(result.headers),
      detail: result.detail ?? result.error,
    }
  }
  return { error: `Scopus API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
}

async function scopusGet(path, params, exec) {
  const key = await resolveEnv('SCOPUS_API_KEY')
  if (!key) return { error: keyMissing() }
  const result = await limiter().run(() => fetchJson(`${API}/${path}?${params}`, {
    signal: exec?.signal,
    headers: {
      'X-ELS-APIKey': key,
      Accept: 'application/json',
      'User-Agent': searchUserAgent(),
    },
  }))
  if (!result.ok) return { error: providerError(result) }
  return { data: result.data, ...quotaFromHeaders(result.headers) }
}

export async function runScopusSearch(args, exec) {
  const query = String(args.query || '').trim()
  if (!query) return { error: 'query is required' }
  const params = new URLSearchParams({
    query,
    count: String(Math.min(Math.max(Number(args.limit) || 20, 1), 100)),
    start: String(Math.max(0, Number(args.offset) || 0)),
    field: ENTRY_FIELDS,
  })
  const result = await scopusGet('search/scopus', params, exec)
  if (result.error) return result.error
  const search = result.data?.['search-results'] || {}
  const entries = Array.isArray(search.entry) ? search.entry : (search.entry ? [search.entry] : [])
  const results = entries.map(fromScopusEntry).filter(Boolean)
  return {
    total: Number(search['opensearch:totalResults']) || results.length,
    offset: Math.max(0, Number(args.offset) || 0),
    ...(result.quota_remaining != null ? { quota_remaining: result.quota_remaining } : {}),
    results,
  }
}

function normalizeAuthor(entry) {
  return {
    author_id: String(entry['dc:identifier'] || '').replace(/^AUTHOR_ID:/i, '') || null,
    name: entry['preferred-name']?.['ce:indexed-name']
      || [entry['preferred-name']?.['given-name'], entry['preferred-name']?.['surname']].filter(Boolean).join(' ')
      || entry['dc:creator']
      || null,
    document_count: Number(entry['document-count']) || null,
    affiliation: entry['affiliation-current']?.['affiliation-name'] || null,
    url: entry['prism:url'] || null,
  }
}

export async function runScopusDomain(args, exec) {
  const action = String(args.action || 'record').toLowerCase()

  if (action === 'author') {
    const authorId = String(args.author_id || '').trim()
    const query = String(args.query || '').trim()
    if (!authorId && !query) return { error: 'give query or author_id' }
    const params = new URLSearchParams({
      count: String(Math.min(Math.max(Number(args.limit) || 10, 1), 50)),
    })
    const path = authorId
      ? `author/author_id/${encodeURIComponent(authorId)}`
      : 'search/author'
    if (query) params.set('query', query)
    const result = await scopusGet(path, params, exec)
    if (result.error) return result.error
    const search = result.data?.['search-results'] || result.data || {}
    const entries = Array.isArray(search.entry) ? search.entry : (search.entry ? [search.entry] : [])
    const authors = entries.map(normalizeAuthor).filter((author) => author.name)
    return {
      action,
      total: Number(search['opensearch:totalResults']) || authors.length,
      authors,
      ...(result.quota_remaining != null ? { quota_remaining: result.quota_remaining } : {}),
    }
  }

  const id = String(args.id || args.eid || '').trim()
  const doi = canonicalDoi(args.doi || (id && id.startsWith('10.') ? id : ''))
  if (action === 'record') {
    if (!id && !doi) return { error: 'give id, eid, or doi' }
    const scopusId = canonicalScopusId(id)
    const numericScopusId = scopusId?.replace(/^SCOPUS_ID:/, '')
    const query = doi
      ? `DOI("${doi.replace(/"/g, '\\"')}")`
      : (numericScopusId
          ? `SCOPUS_ID(${numericScopusId})`
          : `EID(${id})`)
    const value = await runScopusSearch({ query, limit: 1 }, exec)
    if (value.error) return value
    return { action, id: id || doi, record: value.results?.[0] || null, ...(value.quota_remaining != null ? { quota_remaining: value.quota_remaining } : {}) }
  }

  if (action === 'cited_by') {
    if (!id) return { error: 'give id or eid' }
    const value = await runScopusSearch({ query: `REF(${id})`, limit: args.limit }, exec)
    if (value.error) return value
    return { action, id, ...value }
  }

  return { error: 'action must be record, author, or cited_by' }
}

export function renderScopusSearch(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}${value.code === 'key_missing' ? ' (set SCOPUS_API_KEY in Settings)' : ''}` }]
  const header = [
    `Scopus: ${value.total ?? value.results.length} total`,
    value.quota_remaining != null ? `quota remaining ${value.quota_remaining}` : null,
    'metadata-only records',
  ].filter(Boolean).join(' · ')
  return [{ type: 'text', text: `${header}\n\n${renderPapers(value.results || [])}` }]
}

export function renderScopusDomain(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}${value.code === 'key_missing' ? ' (set SCOPUS_API_KEY in Settings)' : ''}` }]
  if (value.authors) {
    const lines = value.authors.map((author) => [
      `**${author.name}**${author.author_id ? ` — ${author.author_id}` : ''}`,
      author.affiliation,
      author.document_count != null ? `${author.document_count} documents` : null,
      author.url,
    ].filter(Boolean).join('\n'))
    return [{ type: 'text', text: [`Scopus authors: ${value.total ?? value.authors.length}`, ...lines].join('\n\n') }]
  }
  if (value.record) {
    const paper = value.record
    return [{ type: 'text', text: `**${paper.title}**\n${paper.year || ''} · ${paper.venue || ''}\n${paper.doi ? `doi: ${paper.doi}` : ''}${paper.scopus_id ? `\nScopus: ${paper.scopus_id}` : ''}${paper.citation_count != null ? `\n${paper.citation_count} citations` : ''}` }]
  }
  if (value.results) return renderScopusSearch(value)
  return [{ type: 'text', text: 'No Scopus result.' }]
}
