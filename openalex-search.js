/**
 * OpenAlex search (https://api.openalex.org) — 300M+ CC0 scholarly works.
 *
 * Keyless works at 10 RPS; OPENALEX_API_KEY raises the daily budget and the
 * rate to 30 RPS and enables cursor paging beyond the first page. Semantic
 * `search` queries are capped at 1 RPS, so they use their own limiter.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { fromOpenAlexWork, renderPapers } from './search-normalize.js'

const API = 'https://api.openalex.org'
const ENTITIES = ['works', 'authors', 'sources', 'topics']
const DEFAULT_SELECT = 'id,doi,ids,title,publication_year,authorships,primary_location,best_oa_location,open_access,cited_by_count,type,topics'

export function buildParams(args, apiKey, mailto) {
  const params = new URLSearchParams()
  if (args.query) params.set('search', String(args.query).trim())
  if (args.filter) {
    const filter = Array.isArray(args.filter) ? args.filter.join(',') : String(args.filter)
    if (filter.trim()) params.set('filter', filter.trim())
  }
  if (args.sort) params.set('sort', String(args.sort).trim())
  if (args.group_by) params.set('group_by', String(args.group_by).trim())
  // OpenAlex rejects `select` alongside `group_by`.
  if (!args.group_by) {
    const select = Array.isArray(args.select) ? args.select.join(',') : args.select
    if (select) params.set('select', select)
    else if (args.entity === 'works') params.set('select', DEFAULT_SELECT)
  }
  params.set('per_page', String(Math.min(Math.max(Number(args.per_page) || 25, 1), 100)))
  if (args.cursor) params.set('cursor', String(args.cursor).trim())
  else if (args.page) params.set('page', String(Math.min(Math.max(1, Number(args.page) || 1), 10_000)))
  if (apiKey) params.set('api_key', apiKey)
  if (mailto) params.set('mailto', mailto)
  return params
}

function renderEntities(entity, results) {
  return results.map((item, i) => {
    const title = item.display_name || item.title || item.id || '(unnamed)'
    const meta = [
      item.works_count != null ? `${item.works_count} works` : null,
      item.cited_by_count != null ? `${item.cited_by_count} citations` : null,
      item.orcid || null,
      item.issn_l || null,
    ].filter(Boolean).join(' · ')
    const bits = [`${i + 1}. **${title}**`]
    if (meta) bits.push(meta)
    if (item.id) bits.push(item.id)
    return bits.join('\n')
  }).join('\n\n')
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const meta = value.meta || {}
  const header = `${value.entity || 'works'}: ${meta.count ?? '?'} total${meta.cost_usd != null ? ` · $${meta.cost_usd}` : ''}`
  if (value.groups) {
    const lines = value.groups.map((group) => `- ${group.key_display_name || group.key}: ${group.count}`)
    return [{ type: 'text', text: [header, ...lines].join('\n') }]
  }
  const body = value.entity === 'works'
    ? renderPapers(value.results || [])
    : renderEntities(value.entity, value.results || [])
  return [{ type: 'text', text: `${header}\n\n${body}` }]
}

export const name = 'academic-harness-openalex-search'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'openalex_search',
    description: [
      'Search OpenAlex, the 300M+ CC0 scholarly graph (works, authors, sources, topics).',
      'The best default for structured discovery: pass `filter` for exact constraints (e.g. "publication_year:2020-2026,is_oa:true,type:article"), `query` for full-text relevance, and `group_by` for facet counts.',
      'Works keyless at 10 RPS; OPENALEX_API_KEY raises the budget/rate and enables cursor paging past page 1. Semantic `query` searches are capped at 1 RPS.',
      'For literature discovery, pair this with s2_search; add pubmed_search for biomedical and arxiv_search for preprints. Resolve mixed identifiers with paper_resolve before citing.',
    ].join(' '),
    parameters: {
      query: {
        type: 'string',
        description: 'Full-text relevance search (semantic, 1 RPS). Prefer `filter` when you know exact facets.',
      },
      filter: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'OpenAlex filter expression, e.g. "publication_year:2022-2026,is_oa:true". Arrays are comma-joined.',
      },
      sort: { type: 'string', description: 'OpenAlex sort, e.g. "cited_by_count:desc" or "publication_date:desc".' },
      entity: {
        type: 'string',
        enum: ENTITIES,
        description: 'Which OpenAlex entity to query. Default works. Non-work entities return their raw records.',
      },
      per_page: { type: 'number', description: 'Results per page, 1-100. Default 25.' },
      page: { type: 'number', description: 'Page number (starts at 1). Cursor paging past page 1 needs an API key.' },
      cursor: { type: 'string', description: 'Opaque next_cursor from a previous response; takes precedence over page.' },
      select: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'Optional OpenAlex field projection. Defaults to a compact work record.',
      },
      group_by: { type: 'string', description: 'Facet field, e.g. "publication_year" or "open_access.oa_status". Returns counts instead of records.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      const entity = ENTITIES.includes(args.entity) ? args.entity : 'works'
      if (args.entity && !ENTITIES.includes(args.entity)) {
        return { error: `entity must be one of ${ENTITIES.join(', ')}` }
      }
      const [apiKey, mailto] = await Promise.all([
        resolveEnv('OPENALEX_API_KEY'),
        resolveEnv('CROSSREF_MAILTO').then((value) => value || resolveEnv('UNPAYWALL_EMAIL')),
      ])
      const params = buildParams({ ...args, entity }, apiKey, mailto)
      const semantic = Boolean(args.query)
      const limiter = getLimiter(semantic ? 'openalex-semantic' : 'openalex', {
        minIntervalMs: semantic ? 1000 : (apiKey ? 34 : 100),
      })
      const url = `${API}/${entity}?${params}`
      const result = await limiter.run(() => fetchJson(url, {
        signal: exec.signal,
        headers: { 'User-Agent': searchUserAgent(mailto) },
      }))
      if (!result.ok) {
        return { error: `OpenAlex API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
      }
      const data = result.data || {}
      const meta = {
        count: data.meta?.count ?? null,
        page: data.meta?.page ?? null,
        per_page: data.meta?.per_page ?? null,
        cost_usd: data.meta?.cost_usd ?? null,
        next_cursor: data.meta?.next_cursor ?? null,
      }
      if (args.group_by) {
        return { entity, meta, groups: data.group_by || [], results: [] }
      }
      const results = entity === 'works'
        ? (data.results || []).map(fromOpenAlexWork).filter(Boolean)
        : (data.results || [])
      return { entity, meta, results, next_cursor: meta.next_cursor }
    },
    presentCall(args) {
      const label = args.query || args.filter || args.group_by || args.entity || 'works'
      return { card: 'generic', title: `OpenAlex: ${label}`, kind: 'search' }
    },
  }))
}
