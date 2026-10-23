/**
 * CORE v3 search (https://api.core.ac.uk/v3/search/works).
 *
 * Aggregates open-access repositories and can return pre-extracted fullText
 * inline. CORE_API_KEY is optional: keyless works at 0.5 RPS; a registered
 * key gets ~10 requests/minute. Full text is only fetched when explicitly
 * requested because it is large.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { capText, fromCoreResult, renderPapers } from './search-normalize.js'

const API = 'https://api.core.ac.uk/v3/search/works/'
const MAX_FULLTEXT_RENDER = 3000

export function buildParams(args) {
  const query = String(args.query || '').trim()
  if (!query) throw new Error('query is required')
  const params = new URLSearchParams({ q: query })
  params.set('limit', String(Math.min(Math.max(Number(args.limit) || 10, 1), 100)))
  if (args.offset) params.set('offset', String(Math.max(0, Number(args.offset) || 0)))
  return params
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const bits = [
    `CORE: ${value.total ?? value.results.length} total · showing ${value.results.length}`,
    renderPapers(value.results, { abstractChars: 400 }),
  ]
  const excerpts = value.results
    .map((paper, i) => (paper.full_text
      ? `${i + 1}. ${paper.title}\n${paper.full_text.slice(0, MAX_FULLTEXT_RENDER).trimEnd()}${paper.full_text.length > MAX_FULLTEXT_RENDER ? '\n… [excerpt truncated]' : ''}`
      : null))
    .filter(Boolean)
  if (excerpts.length) bits.push(`Full text excerpts:\n\n${excerpts.join('\n\n')}`)
  return [{ type: 'text', text: capText(bits.join('\n\n')) }]
}

export const name = 'academic-harness-core-search'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'core_search',
    description: [
      'Search CORE\'s 450M+ open-access records across institutional and subject repositories. Set include_fulltext=true when you need the stored full text inline (large; use sparingly).',
      'CORE_API_KEY is optional: keyless access is limited to about 10 requests/minute, and include_fulltext requires a key (keyless responses contain a placeholder instead of full text). Results carry DOIs, PubMed IDs, repository download links, and citation counts.',
      'Use this for repository coverage and open full texts; pair with openalex_search/s2_search for breadth and paper_download for publisher OA copies.',
    ].join(' '),
    parameters: {
      query: { type: 'string', required: true, description: 'CORE query string (supports fielded/boolean syntax).' },
      limit: { type: 'number', description: 'Results to return, 1-100. Default 10.' },
      offset: { type: 'number', description: 'Result offset for paging. Default 0.' },
      include_fulltext: { type: 'boolean', description: 'Include CORE\'s stored full text inline. Default false; can be very large.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      let params
      try {
        params = buildParams(args)
      } catch (error) {
        return { error: error.message }
      }
      const [apiKey, email] = await Promise.all([
        resolveEnv('CORE_API_KEY'),
        resolveEnv('CROSSREF_MAILTO').then((value) => value || resolveEnv('UNPAYWALL_EMAIL')),
      ])
      if (args.include_fulltext && !apiKey) {
        return { error: 'CORE_API_KEY is required for include_fulltext; keyless CORE responses contain a placeholder instead of full text.' }
      }
      const headers = { 'User-Agent': searchUserAgent(email) }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`

      const limiter = getLimiter(apiKey ? 'core-keyed' : 'core-keyless', { minIntervalMs: 6000 })
      const result = await limiter.run(() => fetchJson(`${API}?${params}`, {
        retries: 0,
        signal: exec.signal,
        headers,
      }))
      if (!result.ok) {
        if (result.error === 'aborted') return { error: 'request cancelled' }
        const hint = result.status === 429
          ? ' — keyless CORE is limited to ~10 requests/minute; set CORE_API_KEY or retry later'
          : ''
        return { error: `CORE API error ${result.status}${hint}`, status: result.status, detail: result.detail ?? result.error }
      }
      const data = result.data && typeof result.data === 'object' ? result.data : {}
      const results = (data.results || [])
        .map((entry) => fromCoreResult(entry, { includeFullText: Boolean(args.include_fulltext) }))
        .filter(Boolean)
      return {
        total: data.totalHits ?? results.length,
        limit: Number(params.get('limit')),
        offset: Number(params.get('offset') || 0),
        results,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `CORE: ${args.query || ''}`, kind: 'search' }
    },
  }))
}
