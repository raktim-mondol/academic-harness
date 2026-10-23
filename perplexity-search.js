/**
 * Perplexity Search API (POST https://api.perplexity.ai/search).
 *
 * Raw ranked web results, not a synthesized answer (that is the Agent/Sonar
 * API). Requires PERPLEXITY_API_KEY. A general web tool, not a literature index.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { capText, fromPerplexityResult, renderPapers } from './search-normalize.js'

const API = 'https://api.perplexity.ai/search'
const SEARCH_TYPES = ['web', 'fast', 'people']
const RECENCY = ['hour', 'day', 'week', 'month', 'year']
const DATE_FILTERS = [
  'last_updated_after_filter',
  'last_updated_before_filter',
  'search_after_date_filter',
  'search_before_date_filter',
]

export function buildBody(args) {
  const query = String(args.query || '').trim()
  if (!query) throw new Error('query is required')
  const searchType = args.search_type || 'web'
  if (!SEARCH_TYPES.includes(searchType)) throw new Error(`search_type must be one of ${SEARCH_TYPES.join(', ')}`)

  const body = { query, search_type: searchType }
  const maxResults = Number(args.max_results)
  if (Number.isFinite(maxResults) && maxResults > 0) {
    const capped = Math.min(Math.max(Math.floor(maxResults), 1), 50)
    if (capped > 20 && searchType !== 'people') {
      throw new Error('max_results above 20 requires search_type=people')
    }
    body.max_results = capped
  }
  if (args.country) {
    const country = String(args.country).trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(country)) throw new Error('country must be a two-letter ISO 3166-1 code')
    body.country = country
  }
  const domains = (Array.isArray(args.search_domain_filter) ? args.search_domain_filter : [])
    .map((value) => String(value).trim()).filter(Boolean)
  if (domains.length > 20) throw new Error('search_domain_filter accepts at most 20 domains')
  if (domains.length) body.search_domain_filter = domains
  const languages = (Array.isArray(args.search_language_filter) ? args.search_language_filter : [])
    .map((value) => String(value).trim()).filter(Boolean)
  if (languages.length > 20) throw new Error('search_language_filter accepts at most 20 languages')
  if (languages.some((code) => !/^[A-Za-z]{2}$/.test(code))) {
    throw new Error('search_language_filter entries must be two-letter ISO 639-1 codes')
  }
  if (languages.length) body.search_language_filter = languages.map((code) => code.toLowerCase())
  for (const key of ['max_tokens', 'max_tokens_per_page']) {
    const value = Number(args[key])
    if (Number.isFinite(value) && value > 0) body[key] = Math.floor(value)
  }
  for (const key of DATE_FILTERS) {
    if (args[key]) body[key] = String(args[key]).trim()
  }
  if (args.search_recency_filter) {
    if (!RECENCY.includes(args.search_recency_filter)) {
      throw new Error(`search_recency_filter must be one of ${RECENCY.join(', ')}`)
    }
    body.search_recency_filter = args.search_recency_filter
  }
  return body
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  return [{ type: 'text', text: capText(`Perplexity: ${value.results?.length ?? 0} result(s) for "${value.query}"\n\n${renderPapers(value.results || [], { abstractChars: 500 })}`) }]
}

export const name = 'academic-harness-perplexity-search'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'perplexity_search',
    description: [
      'Raw ranked web results from Perplexity Search: title, URL, snippet, publication date, and last-updated date. This is not a synthesized answer and not a literature index.',
      'Use it for current web coverage, domain/language/date-filtered search, or as an alternative to parallel_search when you want Perplexity\'s index. For generated answers use a model, not this tool. Requires PERPLEXITY_API_KEY.',
      'search_type: web (default), fast (lower latency/cost), or people (allows up to 50 results). For papers use openalex_search/s2_search/consensus_search/parallel_search.',
    ].join(' '),
    parameters: {
      query: { type: 'string', required: true, description: 'Search query.' },
      max_results: { type: 'number', description: 'Results, 1-20 for web/fast, up to 50 for people. Default 10.' },
      search_type: { type: 'string', enum: SEARCH_TYPES, description: 'web (default), fast, or people.' },
      country: { type: 'string', description: 'Two-letter ISO 3166-1 country code.' },
      search_domain_filter: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restrict to these domains (max 20).',
      },
      search_language_filter: {
        type: 'array',
        items: { type: 'string' },
        description: 'Two-letter ISO 639-1 language codes (max 20).',
      },
      search_recency_filter: { type: 'string', enum: RECENCY, description: 'hour, day, week, month, or year.' },
      search_after_date_filter: { type: 'string', description: 'Published after this date (MM/DD/YYYY).' },
      search_before_date_filter: { type: 'string', description: 'Published before this date (MM/DD/YYYY).' },
      last_updated_after_filter: { type: 'string', description: 'Last updated after this date (MM/DD/YYYY).' },
      last_updated_before_filter: { type: 'string', description: 'Last updated before this date (MM/DD/YYYY).' },
      max_tokens: { type: 'number', description: 'Total content-token budget across results.' },
      max_tokens_per_page: { type: 'number', description: 'Content-token budget per result.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      let body
      try {
        body = buildBody(args)
      } catch (error) {
        return { error: error.message }
      }
      const apiKey = await resolveEnv('PERPLEXITY_API_KEY')
      if (!apiKey) return { error: 'PERPLEXITY_API_KEY is not set (Settings -> Academic Harness API keys, or the matching env var).' }

      const limiter = getLimiter('perplexity', { minIntervalMs: 100 })
      const result = await limiter.run(() => fetchJson(API, {
        method: 'POST',
        retries: 0,
        signal: exec.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': searchUserAgent(),
        },
        body: JSON.stringify(body),
      }))
      if (!result.ok) {
        if (result.error === 'aborted') return { error: 'request cancelled' }
        return { error: `Perplexity API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
      }
      const data = result.data && typeof result.data === 'object' ? result.data : {}
      return {
        query: body.query,
        id: data.id || null,
        server_time: data.server_time || null,
        results: (data.results || []).map(fromPerplexityResult).filter(Boolean),
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Perplexity (${args.search_type || 'web'}): ${args.query || ''}`, kind: 'search' }
    },
  }))
}
