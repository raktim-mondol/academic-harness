/**
 * Firecrawl's paper index as a `literature_search` source.
 *
 * `firecrawl_research_search_papers` is a semantic search over PubMed, PubMed Central,
 * bioRxiv, medRxiv and arXiv abstracts. It is called through the same remote MCP
 * server the agent-facing `mcp__firecrawl__*` tools use, via mcp-http.js, and read from
 * the tool's `structuredContent` (schema'd JSON with DOI, PMID, PMCID and arXiv ids),
 * not from its markdown rendering.
 *
 * Needs FIRECRAWL_API_KEY. Unlike the agent-facing connector this is read per call, so
 * a key saved in Settings works without a restart.
 */
import { resolveEnv } from './credential-env.js'
import { callMcpTool } from './mcp-http.js'
import { getLimiter } from './search-http.js'
import { fromFirecrawlPaper } from './search-normalize.js'

export async function runFirecrawlPapers({ query, limit = 10 } = {}, { signal } = {}) {
  const key = await resolveEnv('FIRECRAWL_API_KEY')
  if (!key) {
    return { error: 'FIRECRAWL_API_KEY is not set (Settings -> Academic Harness API keys, or the matching env var).', code: 'key_missing' }
  }
  const text = String(query || '').trim()
  if (!text) return { error: 'query is required' }
  const limiter = getLimiter('firecrawl-papers', { minIntervalMs: 150, maxConcurrent: 2 })
  const reply = await limiter.run(() => callMcpTool({
    endpoint: `https://mcp.firecrawl.dev/${encodeURIComponent(key)}/v2/mcp`,
    tool: 'firecrawl_research_search_papers',
    args: { query: text, k: Math.max(1, Math.min(Number(limit) || 10, 100)) },
    signal,
  }))
  if (!reply.ok) {
    return { error: `Firecrawl paper search failed: ${reply.error}`, ...(reply.status ? { status: reply.status } : {}), ...(reply.error === 'auth_failed' ? { code: 'auth_failed' } : {}) }
  }
  const rows = reply.structured?.results
  if (!Array.isArray(rows)) return { error: 'Firecrawl paper search returned an unexpected response', code: 'malformed_response' }
  return { results: rows.map(fromFirecrawlPaper).filter((paper) => paper && paper.title) }
}
