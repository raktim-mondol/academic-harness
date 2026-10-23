/**
 * Crossref lookup (https://api.crossref.org) — canonical DOI metadata.
 *
 * Single-DOI lookups use the faster budget; list queries are slower by policy.
 * Supplying CROSSREF_MAILTO (or UNPAYWALL_EMAIL) moves requests into the polite
 * pool and raises both budgets.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { canonicalDoi, fromCrossrefWork, renderPapers } from './search-normalize.js'

const API = 'https://api.crossref.org/works'

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const header = value.doi
    ? `Crossref DOI: ${value.doi}`
    : `Crossref: ${value.total ?? value.results.length} result(s)`
  return [{ type: 'text', text: `${header}\n\n${renderPapers(value.results || [])}` }]
}

export async function runCrossrefQuery(args, exec) {
  const doi = canonicalDoi(args.doi)
  if (!doi && !String(args.query || '').trim()) return { error: 'give a doi or a query' }

  const mailto = await resolveEnv('CROSSREF_MAILTO') || await resolveEnv('UNPAYWALL_EMAIL')
  const params = new URLSearchParams()
  if (mailto) params.set('mailto', mailto)
  if (doi) {
    const limiter = getLimiter('crossref-single', { minIntervalMs: mailto ? 100 : 200 })
    const result = await limiter.run(() => fetchJson(`${API}/${encodeURIComponent(doi)}?${params}`, {
      signal: exec?.signal,
      headers: { 'User-Agent': searchUserAgent(mailto) },
    }))
    if (!result.ok) {
      if (result.error === 'aborted') return { error: 'request cancelled' }
      return { error: `Crossref API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
    }
    const paper = fromCrossrefWork(result.data?.message)
    return { doi, total: paper ? 1 : 0, results: paper ? [paper] : [] }
  }

  params.set('query.bibliographic', String(args.query).trim())
  params.set('rows', String(Math.min(Math.max(Number(args.rows) || 20, 1), 100)))
  if (args.offset) params.set('offset', String(Math.max(0, Number(args.offset))))
  if (args.filter) params.set('filter', String(args.filter).trim())
  if (args.sort) params.set('sort', String(args.sort).trim())
  if (args.order) params.set('order', args.order === 'asc' ? 'asc' : 'desc')
  const select = Array.isArray(args.select) ? args.select.join(',') : args.select
  if (select) params.set('select', select)

  const limiter = getLimiter('crossref-list', { minIntervalMs: mailto ? 334 : 1000 })
  const result = await limiter.run(() => fetchJson(`${API}?${params}`, {
    signal: exec?.signal,
    headers: { 'User-Agent': searchUserAgent(mailto) },
  }))
  if (!result.ok) {
    if (result.error === 'aborted') return { error: 'request cancelled' }
    return { error: `Crossref API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
  }
  const message = result.data?.message || {}
  const results = (message.items || []).map(fromCrossrefWork).filter(Boolean)
  return { total: message['total-results'] ?? results.length, results }
}

export const name = 'academic-harness-crossref-lookup'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'crossref_lookup',
    description: [
      'Look up canonical DOI metadata in Crossref (~180M records): authors, venue, year, license, citation count, and links.',
      'Use a single `doi` for identity/metadata verification, or `query` for a bibliographic search. Crossref is the registration authority for DOIs, so prefer it over other sources when the DOI record itself matters.',
      'Free. Set CROSSREF_MAILTO (or UNPAYWALL_EMAIL) to join the polite pool and raise rate limits.',
    ].join(' '),
    parameters: {
      doi: { type: 'string', description: 'Single DOI to fetch (bare or doi.org URL). Takes precedence over query.' },
      query: { type: 'string', description: 'Bibliographic query (Crossref query.bibliographic).' },
      filter: { type: 'string', description: 'Crossref filter expression, e.g. "from-pub-date:2020-01-01,gte-citation:10".' },
      rows: { type: 'number', description: 'Results per page for a query, 1-100. Default 20.' },
      offset: { type: 'number', description: 'Result offset for a query.' },
      sort: { type: 'string', description: 'Crossref sort field, e.g. "relevance" (default) or "published".' },
      order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction when `sort` is set.' },
      select: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'Optional field projection, e.g. ["DOI","title","author","issued"].',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      return runCrossrefQuery(args, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `Crossref: ${args.doi || args.query || ''}`, kind: 'search' }
    },
  }))
}
