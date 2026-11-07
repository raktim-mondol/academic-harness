/**
 * Cohere Rerank as a relevance reranker for `literature_search`.
 *
 * Same contract as `rerankWithJev`: score the merged candidates against the query in
 * one request and return `{ ok: true, scores }` (one number per candidate, input order)
 * or `{ ok: false, reason }`. Never throws. Needs COHERE_API_KEY, read per call.
 *
 * Cohere's relevance scores order candidates but are not calibrated probabilities
 * (a clearly relevant paper can score 0.4), so callers use them for ordering only.
 * The query and public title/abstract text go to api.cohere.com.
 */
import { fetchJson } from './search-http.js'

export const COHERE_RERANK_URL = 'https://api.cohere.com/v2/rerank'
export const COHERE_RERANK_MODEL = 'rerank-v3.5'
export const COHERE_TIMEOUT_MS = 6000
const ABSTRACT_CHARS = 1200
const BREAK_MS = 60_000
const BREAK_AUTH_MS = 10 * 60_000

const breaker = new Map()

export function resetCohereForTests() {
  breaker.clear()
}

function reasonFor(result) {
  if (result.status === 401 || result.status === 403) return 'auth_failed'
  if (result.status === 429) return 'rate_limited'
  if (/timed out/i.test(result.error || '')) return 'timeout'
  if (result.error === 'aborted') return 'aborted'
  return result.status ? `http_${result.status}` : 'network_error'
}

export async function rerankWithCohere(query, candidates, { apiKey, signal, timeoutMs = COHERE_TIMEOUT_MS, now = Date.now } = {}) {
  if (!apiKey) return { ok: false, reason: 'no_key' }
  const text = String(query || '').trim()
  if (!text || !candidates?.length) return { ok: false, reason: 'nothing_to_rank' }
  const until = breaker.get(apiKey)
  if (until && now() < until.at) return { ok: false, reason: `skipped_after_${until.reason}` }

  const documents = candidates.map((paper) => {
    const abstract = String(paper.abstract || '').slice(0, ABSTRACT_CHARS)
    return `${paper.title || ''}${abstract ? `\n${abstract}` : ''}`
  })
  const started = Date.now()
  const result = await fetchJson(COHERE_RERANK_URL, {
    method: 'POST',
    headers: { authorization: `bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: COHERE_RERANK_MODEL, query: text, documents, top_n: documents.length }),
    timeoutMs,
    retries: 0,
    signal,
  })
  const ms = Date.now() - started
  if (!result.ok) {
    const reason = reasonFor(result)
    if (reason !== 'aborted') breaker.set(apiKey, { at: now() + (reason === 'auth_failed' ? BREAK_AUTH_MS : BREAK_MS), reason })
    return { ok: false, reason, ms }
  }
  const scores = new Array(candidates.length).fill(null)
  for (const entry of result.data?.results || []) {
    if (Number.isInteger(entry?.index) && entry.index >= 0 && entry.index < scores.length) scores[entry.index] = entry.relevance_score
  }
  if (scores.some((value) => !Number.isFinite(value))) return { ok: false, reason: 'malformed_response', ms }
  return { ok: true, scores, model: COHERE_RERANK_MODEL, ms, usage: result.data?.meta?.billed_units ?? null }
}
