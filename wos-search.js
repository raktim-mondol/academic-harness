/**
 * Web of Science Starter API: document search and cited-by metadata. Requires
 * WOS_API_KEY. The Starter plan has a low daily quota and may not expose full
 * citation lists; this module only surfaces the fields the plan returns.
 */
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { canonicalDoi, canonicalWosUid, fromWosHit, renderPapers } from './search-normalize.js'

const API = 'https://api.clarivate.com/apis/wos-starter/v1'

function limiter() {
  return getLimiter('wos', { minIntervalMs: 1000 })
}

function keyMissing() {
  return {
    error: 'WOS_API_KEY is required for Web of Science search',
    code: 'key_missing',
    field: 'WOS_API_KEY',
  }
}

function quotaFromHeaders(headers) {
  const raw = headers?.get?.('x-ratelimit-remaining')
  const remaining = raw == null || raw === '' ? NaN : Number(raw)
  return Number.isFinite(remaining) ? { quota_remaining: remaining } : {}
}

function providerError(result) {
  if (result.error === 'aborted') return { error: 'request cancelled' }
  if (result.status === 401 || result.status === 403) {
    return {
      error: `Web of Science rejected the key (${result.status}); check WOS_API_KEY and the plan's access`,
      status: result.status,
      code: 'not_entitled',
      detail: result.detail ?? result.error,
    }
  }
  if (result.status === 429) {
    return {
      error: 'Web of Science quota or rate limit exceeded',
      status: result.status,
      code: 'quota',
      ...quotaFromHeaders(result.headers),
      detail: result.detail ?? result.error,
    }
  }
  return { error: `Web of Science API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
}

async function wosGet(params, exec) {
  const key = await resolveEnv('WOS_API_KEY')
  if (!key) return { error: keyMissing() }
  const result = await limiter().run(() => fetchJson(`${API}/documents?${params}`, {
    signal: exec?.signal,
    headers: {
      'X-ApiKey': key,
      Accept: 'application/json',
      'User-Agent': searchUserAgent(),
    },
  }))
  if (!result.ok) return { error: providerError(result) }
  return { data: result.data || {}, ...quotaFromHeaders(result.headers) }
}

export async function runWosSearch(args, exec) {
  const query = String(args.query || '').trim()
  if (!query) return { error: 'query is required' }
  const params = new URLSearchParams({
    q: query,
    limit: String(Math.min(Math.max(Number(args.limit) || 20, 1), 50)),
    page: String(Math.max(1, Number(args.page) || 1)),
  })
  if (args.sort) params.set('sortField', String(args.sort))
  const result = await wosGet(params, exec)
  if (result.error) return result.error
  const hits = Array.isArray(result.data.hits) ? result.data.hits : []
  const results = hits.map(fromWosHit).filter(Boolean)
  return {
    total: result.data.metadata?.total ?? results.length,
    page: Math.max(1, Number(args.page) || 1),
    ...(result.quota_remaining != null ? { quota_remaining: result.quota_remaining } : {}),
    results,
  }
}

export async function runWosDomain(args, exec) {
  const action = String(args.action || 'record').toLowerCase()
  const uid = canonicalWosUid(args.uid || args.id || '')
  const doi = canonicalDoi(args.doi || (args.id && args.id.startsWith('10.') ? args.id : ''))
  if (!uid && !doi) return { error: 'give uid, id, or doi' }
  const query = uid ? `UT=${uid}` : `DO=("${doi.replace(/"/g, '\\"')}")`
  const value = await runWosSearch({ query, limit: 1 }, exec)
  if (value.error) return value
  const record = value.results?.[0] || null
  if (action === 'record') {
    return { action, uid: uid || record?.wos_uid || null, doi: doi || record?.doi || null, record, ...(value.quota_remaining != null ? { quota_remaining: value.quota_remaining } : {}) }
  }
  if (action === 'cited_by') {
    return {
      action,
      uid: uid || record?.wos_uid || null,
      citation_count: record?.citation_count ?? null,
      record,
      ...(value.quota_remaining != null ? { quota_remaining: value.quota_remaining } : {}),
      note: 'The Starter API may return only a citation count, not the citing records.',
    }
  }
  return { error: 'action must be record or cited_by' }
}

export function renderWosSearch(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}${value.code === 'key_missing' ? ' (set WOS_API_KEY in Settings)' : ''}` }]
  const header = [
    `Web of Science: ${value.total ?? value.results.length} total`,
    value.quota_remaining != null ? `quota remaining ${value.quota_remaining}` : null,
    'metadata-only records',
  ].filter(Boolean).join(' · ')
  return [{ type: 'text', text: `${header}\n\n${renderPapers(value.results || [])}` }]
}

export function renderWosDomain(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}${value.code === 'key_missing' ? ' (set WOS_API_KEY in Settings)' : ''}` }]
  if (value.action === 'cited_by') {
    const paper = value.record
    return [{ type: 'text', text: [
      `**${paper?.title || value.uid || value.doi}**`,
      value.citation_count != null ? `${value.citation_count} citations` : 'Citation count not returned by this plan.',
      value.note,
    ].filter(Boolean).join('\n') }]
  }
  if (value.record) {
    const paper = value.record
    return [{ type: 'text', text: `**${paper.title}**\n${paper.year || ''} · ${paper.venue || ''}\n${paper.doi ? `doi: ${paper.doi}` : ''}${paper.wos_uid ? `\n${paper.wos_uid}` : ''}` }]
  }
  return [{ type: 'text', text: 'No Web of Science result.' }]
}
