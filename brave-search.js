/**
 * Brave Search API (https://api.search.brave.com/res/v1/web/search).
 *
 * An independent web index, not a literature database: use it as a general
 * web-search fallback or for independent coverage, never as a paper index.
 * Requires BRAVE_API_KEY (x-subscription-token).
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { capText, fromBraveResult, renderPapers } from './search-normalize.js'

const API = 'https://api.search.brave.com/res/v1/web/search'
const FRESHNESS = ['pd', 'pw', 'pm', 'py']
const DATE_RANGE = /^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/
const SAFESEARCH = ['off', 'moderate', 'strict']

export function buildParams(args) {
  const params = new URLSearchParams()
  params.set('q', String(args.query).trim())
  params.set('count', String(Math.min(Math.max(Number(args.count) || 10, 1), 20)))
  if (args.country) params.set('country', String(args.country).trim().toUpperCase())
  if (args.search_lang) params.set('search_lang', String(args.search_lang).trim())
  if (args.freshness) params.set('freshness', String(args.freshness).trim())
  if (args.extra_snippets) params.set('extra_snippets', 'true')
  if (args.result_filter) params.set('result_filter', String(args.result_filter).trim())
  if (args.safesearch) params.set('safesearch', String(args.safesearch).trim())
  if (args.offset) params.set('offset', String(Math.min(Math.max(0, Number(args.offset) || 0), 9)))
  return params
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  return [{ type: 'text', text: capText(`Brave: ${value.results?.length ?? 0} result(s) for "${value.query}"\n\n${renderPapers(value.results || [], { abstractChars: 400 })}`) }]
}

export const name = 'academic-harness-brave-search'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'brave_search',
    description: [
      'Independent web search via Brave (40B+ page index, no Google/Bing dependency). Returns ranked web results with descriptions and optional extra snippets.',
      'This is a general web tool, not a literature index: for papers use openalex_search, s2_search, pubmed_search, arxiv_search, consensus_search, or parallel_search.',
      'Requires BRAVE_API_KEY. Use it as a fallback when parallel_search is unavailable or when you specifically want independent index coverage. Do not start a literature search here.',
    ].join(' '),
    parameters: {
      query: { type: 'string', required: true, description: 'Search query (max 600 chars / 75 words).' },
      count: { type: 'number', description: 'Results to return, 1-20. Default 10.' },
      country: { type: 'string', description: 'ISO country code, e.g. "US", "GB". Default US.' },
      search_lang: { type: 'string', description: 'Search language, e.g. "en".' },
      freshness: {
        type: 'string',
        description: 'Time filter: pd (24h), pw (7d), pm (31d), py (1y), or "YYYY-MM-DDtoYYYY-MM-DD".',
      },
      extra_snippets: { type: 'boolean', description: 'Include additional excerpts from each page.' },
      result_filter: { type: 'string', description: 'Comma-separated result types, e.g. "web,news" or "web,faq".' },
      safesearch: { type: 'string', enum: SAFESEARCH, description: 'Safe-search level. Default moderate.' },
      offset: { type: 'number', description: 'Zero-based result offset (0-9).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      if (!String(args.query || '').trim()) return { error: 'query is required' }
      if (args.freshness && !FRESHNESS.includes(args.freshness) && !DATE_RANGE.test(args.freshness)) {
        return { error: 'freshness must be pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD' }
      }
      if (args.safesearch && !SAFESEARCH.includes(args.safesearch)) {
        return { error: `safesearch must be one of ${SAFESEARCH.join(', ')}` }
      }

      const apiKey = await resolveEnv('BRAVE_API_KEY')
      if (!apiKey) return { error: 'BRAVE_API_KEY is not set (Settings -> Academic Harness API keys, or the matching env var).' }

      const limiter = getLimiter('brave', { minIntervalMs: 100 })
      const result = await limiter.run(() => fetchJson(`${API}?${buildParams(args)}`, {
        signal: exec.signal,
        headers: {
          'X-Subscription-Token': apiKey,
          'User-Agent': searchUserAgent(),
        },
      }))
      if (!result.ok) {
        if (result.error === 'aborted') return { error: 'request cancelled' }
        return { error: `Brave Search API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
      }
      const results = (result.data?.web?.results || []).map(fromBraveResult).filter(Boolean)
      return { query: String(args.query).trim(), results }
    },
    presentCall(args) {
      return { card: 'generic', title: `Brave: ${args.query || ''}`, kind: 'search' }
    },
  }))
}
