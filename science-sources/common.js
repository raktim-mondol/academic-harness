/**
 * Shared pieces for science_source adapters: the normalized record shape and
 * the mapping from an HTTP outcome to an explicit state. Adapters never invent
 * a value; a missing field is null and a failed call is a named state.
 */
import { fetchJson, getLimiter } from '../search-http.js'

export function cap(value, chars = 400) {
  const out = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!out) return null
  return out.length > chars ? `${out.slice(0, chars).trimEnd()}…` : out
}

/** One normalized record. `fields` carries the source-specific facts. */
export function makeRecord(adapter, { id, url, title, summary = null, fields = {}, endpoint, query = null }, now) {
  return {
    source: adapter.id,
    id: String(id),
    url,
    title: cap(title, 300),
    summary: cap(summary, 600),
    fields,
    retrieved_at: now,
    license: adapter.license,
    provenance: { endpoint, query, adapter: adapter.id, adapter_version: adapter.version },
  }
}

/** Run one request through the adapter's limiter and map failures to states. */
export async function call(adapter, url, options, deps) {
  const doFetch = deps.fetchJson || fetchJson
  const limiter = getLimiter(`science:${adapter.id}`, adapter.limiter)
  const headers = { accept: 'application/json', 'user-agent': 'Academic Harness/1.0 (science_source)', ...(options.headers || {}) }
  const result = await limiter.run(() => doFetch(url, { signal: deps.signal, ...options, headers }))
  if (result.ok) return { ok: true, data: result.data }
  if (result.status === 404) return { ok: false, state: 'not_found', error: `${adapter.name}: not found` }
  if (result.status === 400) return { ok: false, state: 'bad_request', error: `${adapter.name}: ${result.detail || 'request rejected'}` }
  if (result.status === 401 || result.status === 403) return { ok: false, state: 'provider_blocked', error: `${adapter.name}: HTTP ${result.status}` }
  if (result.status === 429) return { ok: false, state: 'rate_limited', error: `${adapter.name}: rate limited` }
  return { ok: false, state: 'unavailable', error: `${adapter.name}: ${result.error || 'request failed'}` }
}
