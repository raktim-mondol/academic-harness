/**
 * Exa Search API (POST https://api.exa.ai/search).
 *
 * Neural/entity web search with content extraction. `lite` serves cached index
 * snapshots and never fetches live pages. A general web tool, not a literature
 * index. Requires EXA_API_KEY.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { capText, fromExaResult, renderPapers } from './search-normalize.js'

const API = 'https://api.exa.ai/search'
const TYPES = ['auto', 'lite', 'deep-lite', 'deep']
const CATEGORIES = ['company', 'publication', 'research paper', 'news', 'personal site', 'financial report', 'people']

export function buildBody(args) {
  const query = String(args.query || '').trim()
  if (!query) throw new Error('query is required')
  const type = args.type || 'auto'
  if (!TYPES.includes(type)) throw new Error(`type must be one of ${TYPES.join(', ')}`)

  const body = { query, type }
  const numResults = Number(args.num_results)
  if (Number.isFinite(numResults) && numResults > 0) {
    body.numResults = Math.min(Math.max(Math.floor(numResults), 1), 100)
  }
  const include = (Array.isArray(args.include_domains) ? args.include_domains : [])
    .map((value) => String(value).trim()).filter(Boolean)
  if (include.length > 1200) throw new Error('include_domains accepts at most 1200 entries')
  if (include.length) body.includeDomains = include
  const exclude = (Array.isArray(args.exclude_domains) ? args.exclude_domains : [])
    .map((value) => String(value).trim()).filter(Boolean)
  if (exclude.length > 1200) throw new Error('exclude_domains accepts at most 1200 entries')
  if (exclude.length) body.excludeDomains = exclude
  if (args.category) {
    if (!CATEGORIES.includes(args.category)) throw new Error(`category must be one of ${CATEGORIES.join(', ')}`)
    body.category = args.category
  }
  if ((args.category === 'people' || args.category === 'company')
    && (args.start_published_date || args.end_published_date)) {
    throw new Error('people and company categories do not support publication-date filters')
  }
  if (args.start_published_date) body.startPublishedDate = String(args.start_published_date).trim()
  if (args.end_published_date) body.endPublishedDate = String(args.end_published_date).trim()
  const contents = {}
  if (args.include_text) contents.text = true
  if (args.include_highlights) contents.highlights = true
  if (args.include_summary) contents.summary = true
  if (Object.keys(contents).length) body.contents = contents
  return body
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const costValue = typeof value.cost === 'number' ? value.cost : value.cost?.total
  const header = [
    `Exa: ${value.results?.length ?? 0} result(s) for "${value.query}"`,
    typeof costValue === 'number' ? `cost: $${costValue}` : null,
  ].filter(Boolean).join(' · ')
  return [{ type: 'text', text: capText(`${header}\n\n${renderPapers(value.results || [], { abstractChars: 600 })}`) }]
}

export const name = 'academic-harness-exa-search'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'exa_search',
    description: [
      'Neural/entity web search via Exa. Good for finding companies, people, publications, news, and pages by meaning rather than keywords; optional text/highlights/summary extraction.',
      'A general web tool, not a literature index — use openalex_search/s2_search/consensus_search/parallel_search for papers. Requires EXA_API_KEY.',
      'type: lite (cached, never fetches live pages), auto (default), deep-lite, or deep (multi-step synthesis). people/company categories reject publication-date filters.',
    ].join(' '),
    parameters: {
      query: { type: 'string', required: true, description: 'Natural-language search query.' },
      type: { type: 'string', enum: TYPES, description: 'lite, auto (default), deep-lite, or deep.' },
      num_results: { type: 'number', description: 'Results to return, 1-100. Default 10.' },
      include_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only include these domains/paths (max 1200).',
      },
      exclude_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exclude these domains/paths (max 1200).',
      },
      start_published_date: { type: 'string', description: 'ISO 8601 lower bound, e.g. 2024-01-01.' },
      end_published_date: { type: 'string', description: 'ISO 8601 upper bound.' },
      category: { type: 'string', enum: CATEGORIES, description: 'Optional entity category filter.' },
      include_text: { type: 'boolean', description: 'Extract page text.' },
      include_highlights: { type: 'boolean', description: 'Extract relevant highlights.' },
      include_summary: { type: 'boolean', description: 'Extract an AI summary.' },
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
      const apiKey = await resolveEnv('EXA_API_KEY')
      if (!apiKey) return { error: 'EXA_API_KEY is not set (Settings -> Academic Harness API keys, or the matching env var).' }

      const limiter = getLimiter('exa', { minIntervalMs: 100 })
      const result = await limiter.run(() => fetchJson(API, {
        method: 'POST',
        retries: 0,
        signal: exec.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'User-Agent': searchUserAgent(),
        },
        body: JSON.stringify(body),
      }))
      if (!result.ok) {
        if (result.error === 'aborted') return { error: 'request cancelled' }
        return { error: `Exa API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
      }
      const data = result.data && typeof result.data === 'object' ? result.data : {}
      return {
        query: body.query,
        request_id: data.requestId || null,
        cost: data.costDollars ?? null,
        results: (data.results || []).map(fromExaResult).filter(Boolean),
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Exa (${args.type || 'auto'}): ${args.query || ''}`, kind: 'search' }
    },
  }))
}
