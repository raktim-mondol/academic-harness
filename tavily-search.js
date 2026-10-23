/**
 * Tavily Search API (POST https://api.tavily.com/search).
 *
 * AI-native web search with pre-chunked results, topic modes, and domain
 * filters. A general web tool, not a literature index. Requires TAVILY_API_KEY.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { capText, fromTavilyResult, renderPapers } from './search-normalize.js'

const API = 'https://api.tavily.com/search'
const DEPTHS = ['ultra-fast', 'fast', 'basic', 'advanced']
const TOPICS = ['general', 'news', 'finance']
const TIME_RANGES = ['day', 'week', 'month', 'year']

export function buildBody(args) {
  const query = String(args.query || '').trim()
  if (!query) throw new Error('query is required')
  const depth = args.search_depth || 'basic'
  if (!DEPTHS.includes(depth)) throw new Error(`search_depth must be one of ${DEPTHS.join(', ')}`)

  const body = { query, search_depth: depth }
  const maxResults = Number(args.max_results)
  if (Number.isFinite(maxResults) && maxResults > 0) {
    body.max_results = Math.min(Math.max(Math.floor(maxResults), 1), 20)
  }
  if (args.chunks_per_source != null) {
    if (depth === 'ultra-fast') throw new Error('chunks_per_source is not supported with search_depth=ultra-fast')
    const chunks = Number(args.chunks_per_source)
    if (Number.isFinite(chunks) && chunks > 0) body.chunks_per_source = Math.min(Math.max(Math.floor(chunks), 1), 3)
  }
  if (args.topic) {
    if (!TOPICS.includes(args.topic)) throw new Error(`topic must be one of ${TOPICS.join(', ')}`)
    body.topic = args.topic
  }
  if (args.time_range) {
    if (!TIME_RANGES.includes(args.time_range)) throw new Error(`time_range must be one of ${TIME_RANGES.join(', ')}`)
    body.time_range = args.time_range
  }
  const include = (Array.isArray(args.include_domains) ? args.include_domains : [])
    .map((value) => String(value).trim()).filter(Boolean)
  if (include.length > 300) throw new Error('include_domains accepts at most 300 domains')
  if (include.length) body.include_domains = include
  const exclude = (Array.isArray(args.exclude_domains) ? args.exclude_domains : [])
    .map((value) => String(value).trim()).filter(Boolean)
  if (exclude.length > 150) throw new Error('exclude_domains accepts at most 150 domains')
  if (exclude.length) body.exclude_domains = exclude
  if (args.include_answer) body.include_answer = 'basic'
  if (args.include_raw_content) body.include_raw_content = 'markdown'
  if (args.country) body.country = String(args.country).trim().toLowerCase()
  if (args.language) body.language = String(args.language).trim()
  if (args.start_date) body.start_date = String(args.start_date).trim()
  if (args.end_date) body.end_date = String(args.end_date).trim()
  return body
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const bits = [`Tavily: ${value.results?.length ?? 0} result(s) for "${value.query}"`]
  if (value.answer) bits.push(`Answer: ${value.answer}`)
  bits.push(renderPapers(value.results || [], { abstractChars: 500 }))
  return [{ type: 'text', text: capText(bits.join('\n\n')) }]
}

export const name = 'academic-harness-tavily-search'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'tavily_search',
    description: [
      'AI-native web search via Tavily: ranked pages with pre-chunked content, optional synthesized answer, topic modes (general/news/finance), and domain/time filters.',
      'A general web tool, not a literature index — use openalex_search/s2_search/consensus_search/parallel_search for papers. Requires TAVILY_API_KEY.',
      'search_depth trades latency for depth: ultra-fast (no chunks_per_source), fast, basic (default), advanced (2 credits). Use advanced for multi-hop web research, basic/fast for ordinary lookups.',
    ].join(' '),
    parameters: {
      query: { type: 'string', required: true, description: 'Search query.' },
      search_depth: { type: 'string', enum: DEPTHS, description: 'ultra-fast, fast, basic (default), or advanced.' },
      max_results: { type: 'number', description: 'Results to return, 1-20. Default 10.' },
      chunks_per_source: { type: 'number', description: 'Chunks per source, 1-3 (not with ultra-fast).' },
      topic: { type: 'string', enum: TOPICS, description: 'general (default), news, or finance.' },
      time_range: { type: 'string', enum: TIME_RANGES, description: 'Restrict results to day/week/month/year.' },
      include_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only include these domains (max 300).',
      },
      exclude_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exclude these domains (max 150).',
      },
      include_answer: { type: 'boolean', description: 'Include Tavily\'s short synthesized answer.' },
      include_raw_content: { type: 'boolean', description: 'Include raw page content as Markdown.' },
      country: { type: 'string', description: 'Country boost, e.g. "us" or "united states".' },
      language: { type: 'string', description: 'Language preference, e.g. "en".' },
      start_date: { type: 'string', description: 'YYYY-MM-DD lower bound (with topic=general).' },
      end_date: { type: 'string', description: 'YYYY-MM-DD upper bound (with topic=general).' },
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
      const apiKey = await resolveEnv('TAVILY_API_KEY')
      if (!apiKey) return { error: 'TAVILY_API_KEY is not set (Settings -> Academic Harness API keys, or the matching env var).' }

      const limiter = getLimiter('tavily', { minIntervalMs: 100 })
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
        return { error: `Tavily API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
      }
      const data = result.data && typeof result.data === 'object' ? result.data : {}
      return {
        query: body.query,
        answer: data.answer || null,
        results: (data.results || []).map(fromTavilyResult).filter(Boolean),
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Tavily (${args.search_depth || 'basic'}): ${args.query || ''}`, kind: 'search' }
    },
  }))
}
