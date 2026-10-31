/**
 * Semantic Scholar Academic Graph search (https://api.semanticscholar.org).
 *
 * Three modes: relevance (default), bulk (boolean queries, up to 1,000 per
 * call), and snippet (~500-word full-text excerpts). Free; S2_API_KEY gets a
 * dedicated 1 RPS bucket, so every request is serialized at 1 RPS.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import {
  fromSemanticScholarPaper,
  fromSemanticScholarSnippet,
  renderPapers,
} from './search-normalize.js'

const API = 'https://api.semanticscholar.org/graph/v1'
const MODES = ['relevance', 'bulk', 'snippet']
const DEFAULT_FIELDS = 'paperId,externalIds,title,abstract,year,venue,authors,citationCount,influentialCitationCount,openAccessPdf,tldr,publicationTypes,fieldsOfStudy,url'

function buildUrl(args, mode) {
  const params = new URLSearchParams({ query: String(args.query).trim() })
  if (mode === 'snippet') {
    params.set('limit', String(Math.min(Math.max(Number(args.limit) || 10, 1), 10)))
    const paperIds = Array.isArray(args.paper_ids)
      ? args.paper_ids
      : String(args.paper_ids || '').split(',')
    const ids = paperIds.map((value) => String(value).trim()).filter(Boolean).slice(0, 50)
    if (ids.length) params.set('paperIds', ids.join(','))
    return `${API}/snippet/search?${params}`
  }
  const fields = Array.isArray(args.fields) ? args.fields.join(',') : args.fields
  params.set('fields', fields || DEFAULT_FIELDS)
  if (mode === 'bulk') {
    if (args.token) params.set('token', String(args.token))
  } else {
    params.set('limit', String(Math.min(Math.max(Number(args.limit) || 20, 1), 100)))
  }
  if (args.year) params.set('year', String(args.year).trim())
  if (Array.isArray(args.publication_types) && args.publication_types.length) {
    params.set('publicationTypes', args.publication_types.join(','))
  }
  if (Array.isArray(args.fields_of_study) && args.fields_of_study.length) {
    params.set('fieldsOfStudy', args.fields_of_study.join(','))
  }
  if (args.open_access_only) params.set('openAccessPdf', 'true')
  if (args.min_citation_count != null) params.set('minCitationCount', String(args.min_citation_count))
  const path = mode === 'bulk' ? 'paper/search/bulk' : 'paper/search'
  return `${API}/${path}?${params}`
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const header = [
    `Semantic Scholar (${value.mode})`,
    value.total != null ? `${value.total} total` : null,
    value.token ? 'more results available via token' : null,
  ].filter(Boolean).join(' · ')
  return [{ type: 'text', text: `${header}\n\n${renderPapers(value.results || [])}` }]
}

/**
 * Structured snippet search for paper_context. Unlike the normalized
 * `s2_search` view, this preserves the section and relevance score.
 */
export async function searchSnippets({ query, paperIds, limit = 6, signal } = {}) {
  const text = String(query || '').trim()
  if (!text) return []
  const params = new URLSearchParams({
    query: text,
    limit: String(Math.min(Math.max(Number(limit) || 6, 1), 10)),
  })
  const ids = (Array.isArray(paperIds) ? paperIds : [paperIds])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .slice(0, 50)
  if (ids.length) params.set('paperIds', ids.join(','))
  const apiKey = await resolveEnv('S2_API_KEY')
  const headers = { 'User-Agent': searchUserAgent() }
  if (apiKey) headers['x-api-key'] = apiKey
  const limiter = getLimiter('s2', { minIntervalMs: 1000 })
  const result = await limiter.run(() => fetchJson(`${API}/snippet/search?${params}`, { signal, headers }))
  if (!result.ok) return []
  return (result.data?.data || []).map((entry) => {
    const snippet = entry?.snippet || {}
    const body = String(snippet.text || '').trim()
    if (!body) return null
    return {
      paper: entry?.paper || null,
      section: snippet.section || snippet.snippetKind || null,
      text: body,
      score: Number.isFinite(entry?.score) ? entry.score : null,
      source: 'semantic_scholar_snippet',
    }
  }).filter(Boolean)
}

export async function runS2Search(args, exec) {
  if (!String(args.query || '').trim()) return { error: 'query is required' }
  const mode = MODES.includes(args.mode) ? args.mode : 'relevance'
  if (args.mode && !MODES.includes(args.mode)) return { error: `mode must be one of ${MODES.join(', ')}` }

  const apiKey = await resolveEnv('S2_API_KEY')
  const headers = { 'User-Agent': searchUserAgent() }
  if (apiKey) headers['x-api-key'] = apiKey

  const limiter = getLimiter('s2', { minIntervalMs: 1000 })
  const result = await limiter.run(() => fetchJson(buildUrl(args, mode), {
    signal: exec?.signal,
    headers,
  }))
  if (!result.ok) {
    if (result.error === 'aborted') return { error: 'request cancelled' }
    const hint = result.status === 429
      ? ' — keyless requests share a throttled pool; set S2_API_KEY for a dedicated 1 RPS bucket'
      : ''
    return { error: `Semantic Scholar API error ${result.status}${hint}`, status: result.status, detail: result.detail ?? result.error }
  }

  const data = result.data || {}
  const results = mode === 'snippet'
    ? (data.data || []).map(fromSemanticScholarSnippet).filter(Boolean)
    : (data.data || []).map(fromSemanticScholarPaper).filter(Boolean)
  return {
    mode,
    total: data.total ?? null,
    token: data.token ?? null,
    results,
  }
}

export const name = 'academic-harness-semantic-scholar-search'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 's2_search',
    description: [
      'Search Semantic Scholar\'s 214M-paper graph. mode="relevance" (default) for ranked discovery, "bulk" for boolean queries returning up to 1,000 per page, and "snippet" for ~500-word full-text excerpts.',
      'Results include TLDR summaries, citation and influential-citation counts, and open-access PDF links. Free; S2_API_KEY is optional and adds a dedicated 1 RPS bucket.',
      'Pair with openalex_search for discovery, pubmed_search for biomedical coverage, and arxiv_search for preprints. Resolve identifiers with paper_resolve before citing.',
    ].join(' '),
    parameters: {
      query: { type: 'string', required: true, description: 'Natural-language query, or a boolean query in bulk mode.' },
      mode: { type: 'string', enum: MODES, description: 'relevance (default), bulk (boolean; 1,000/page), or snippet (full-text excerpts).' },
      paper_ids: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'Snippet mode only: restrict excerpts to these Semantic Scholar paper IDs (up to 50).',
      },
      limit: { type: 'number', description: 'Max results: 1-100 for relevance, 1-10 for snippet. Bulk returns up to 1,000 per page.' },
      year: { type: 'string', description: 'Year or range, e.g. "2020-2026" or "2024".' },
      publication_types: {
        type: 'array',
        items: { type: 'string' },
        description: 'Semantic Scholar publication types, e.g. ["JournalArticle", "Conference", "Review"].',
      },
      fields_of_study: {
        type: 'array',
        items: { type: 'string' },
        description: 'Field-of-study filters, e.g. ["Computer Science", "Medicine"].',
      },
      open_access_only: { type: 'boolean', description: 'Only papers with an open-access PDF.' },
      min_citation_count: { type: 'number', description: 'Exclude papers below this citation count.' },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional Semantic Scholar field projection for relevance/bulk modes.',
      },
      token: { type: 'string', description: 'Bulk-mode continuation token from a previous response.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      return runS2Search(args, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `Semantic Scholar (${args.mode || 'relevance'}): ${args.query || ''}`, kind: 'search' }
    },
  }))
}
