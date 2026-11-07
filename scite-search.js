/**
 * Scite's literature search as a `literature_search` source.
 *
 * Calls `search_literature` on Scite's hosted MCP server (https://api.scite.ai/mcp)
 * with the same `mcp`-scoped bearer key the agent-facing connector uses, via
 * mcp-http.js. The tool returns JSON text (no structured schema), parsed here.
 *
 * Every hit carries a DOI and Scite's citation tally: how many citing statements
 * support, contrast, or merely mention the paper. That tally rides along on the merged
 * record as `scite`. Needs SCITE_API_KEY, read per call.
 */
import { resolveEnv } from './credential-env.js'
import { callMcpTool } from './mcp-http.js'
import { getLimiter } from './search-http.js'
import { fromSciteHit } from './search-normalize.js'

const ENDPOINT = 'https://api.scite.ai/mcp'

export async function runSciteSearch({ query, limit = 10, yearMin, yearMax } = {}, { signal } = {}) {
  const key = await resolveEnv('SCITE_API_KEY')
  if (!key) {
    return { error: 'SCITE_API_KEY is not set (Settings -> Academic Harness API keys, or the matching env var).', code: 'key_missing' }
  }
  const term = String(query || '').trim()
  if (!term) return { error: 'query is required' }
  const args = { term, limit: Math.max(1, Math.min(Number(limit) || 10, 50)) }
  if (yearMin != null) args.date_from = `${yearMin}-01-01`
  if (yearMax != null) args.date_to = `${yearMax}-12-31`
  const limiter = getLimiter('scite-search', { minIntervalMs: 200, maxConcurrent: 2 })
  const reply = await limiter.run(() => callMcpTool({
    endpoint: ENDPOINT,
    headers: { authorization: `Bearer ${key}` },
    tool: 'search_literature',
    args,
    signal,
  }))
  if (!reply.ok) {
    return { error: `Scite search failed: ${reply.error}`, ...(reply.status ? { status: reply.status } : {}), ...(reply.error === 'auth_failed' ? { code: 'auth_failed' } : {}) }
  }
  let body = reply.structured
  if (!body) {
    try { body = JSON.parse(reply.text) } catch { body = null }
  }
  if (!body || !Array.isArray(body.hits)) {
    return { error: 'Scite search returned an unexpected response', code: 'malformed_response' }
  }
  return { results: body.hits.map(fromSciteHit).filter((paper) => paper && paper.title) }
}
