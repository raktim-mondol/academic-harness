/**
 * Citation-graph traversal over OpenAlex: forward (works citing an ID) and
 * backward (works an ID references). Accepts any identifier that OpenAlex can
 * resolve (DOI, PMID, OpenAlex ID) via paper-resolve.js.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { fromOpenAlexWork, renderPapers } from './search-normalize.js'
import { fetchOpenAlexWork } from './paper-resolve.js'

const API = 'https://api.openalex.org'
const SELECT = 'id,doi,ids,title,publication_year,authorships,primary_location,best_oa_location,open_access,cited_by_count,type,topics'
const DIRECTIONS = ['citations', 'references']

function openAlexId(work) {
  const match = String(work?.id || '').match(/(W\d+)/)
  return match ? match[1] : null
}

function authParams(apiKey, mailto) {
  const params = new URLSearchParams()
  if (apiKey) params.set('api_key', apiKey)
  if (mailto) params.set('mailto', mailto)
  return params
}

async function listWorks(filter, { signal, apiKey, mailto, limit, sort }) {
  const params = authParams(apiKey, mailto)
  params.set('filter', filter)
  params.set('per_page', String(Math.min(Math.max(limit, 1), 100)))
  params.set('select', SELECT)
  if (sort) params.set('sort', sort)
  const limiter = getLimiter('openalex', { minIntervalMs: apiKey ? 34 : 100 })
  const result = await limiter.run(() => fetchJson(`${API}/works?${params}`, {
    signal,
    headers: { 'User-Agent': searchUserAgent(mailto) },
  }))
  if (!result.ok) throw new Error(`OpenAlex API error ${result.status}${result.detail ? `: ${result.detail}` : ''}`)
  return (result.data?.results || []).map(fromOpenAlexWork).filter(Boolean)
}

async function fetchReferencedIds(id, { signal, apiKey, mailto }) {
  const params = authParams(apiKey, mailto)
  params.set('select', 'id,referenced_works')
  const limiter = getLimiter('openalex', { minIntervalMs: apiKey ? 34 : 100 })
  const result = await limiter.run(() => fetchJson(`${API}/works/${id}?${params}`, {
    signal,
    headers: { 'User-Agent': searchUserAgent(mailto) },
  }))
  if (!result.ok) throw new Error(`OpenAlex API error ${result.status}${result.detail ? `: ${result.detail}` : ''}`)
  return (result.data?.referenced_works || [])
    .map((value) => String(value).match(/(W\d+)/)?.[1])
    .filter(Boolean)
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const label = value.direction === 'references' ? 'References in' : 'Works citing'
  return [{ type: 'text', text: `${label} ${value.id}: ${value.total ?? value.results.length} shown\n\n${renderPapers(value.results)}` }]
}

export const name = 'academic-harness-openalex-cite'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'openalex_citations',
    description: [
      'Walk the OpenAlex citation graph for a paper. direction="citations" returns works that cite it; direction="references" returns works it cites.',
      'Accepts a DOI, PMID, or OpenAlex ID. Use this for related-work expansion, finding follow-up studies, or checking whether a claim has been cited since publication.',
      'Free; OPENALEX_API_KEY only raises limits. Pair with paper_resolve when you need the other identifiers for the returned works.',
    ].join(' '),
    parameters: {
      id: { type: 'string', required: true, description: 'DOI, PMID, or OpenAlex ID to traverse from.' },
      direction: {
        type: 'string',
        enum: DIRECTIONS,
        description: 'citations = forward (works citing this paper); references = backward (works this paper cites). Default citations.',
      },
      limit: { type: 'number', description: 'Maximum works to return, 1-100. Default 25.' },
      sort: { type: 'string', description: 'OpenAlex sort for forward traversal, e.g. "cited_by_count:desc" (default) or "publication_date:desc".' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      const direction = DIRECTIONS.includes(args.direction) ? args.direction : 'citations'
      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100)
      const [apiKey, mailto] = await Promise.all([
        resolveEnv('OPENALEX_API_KEY'),
        resolveEnv('CROSSREF_MAILTO').then((value) => value || resolveEnv('UNPAYWALL_EMAIL')),
      ])
      try {
        const work = await fetchOpenAlexWork(args.id, { signal: exec.signal, apiKey, email: mailto })
        if (!work) return { error: `could not resolve "${args.id}" in OpenAlex` }
        const id = openAlexId(work)
        if (!id) return { error: 'OpenAlex returned a work without an OpenAlex ID' }

        if (direction === 'citations') {
          const results = await listWorks(`cites:${id}`, {
            signal: exec.signal,
            apiKey,
            mailto,
            limit,
            sort: args.sort || 'cited_by_count:desc',
          })
          return { direction, id, total: results.length, results }
        }

        const referenced = (await fetchReferencedIds(id, { signal: exec.signal, apiKey, mailto })).slice(0, limit)
        const results = []
        for (let i = 0; i < referenced.length; i += 50) {
          const chunk = referenced.slice(i, i + 50)
          const papers = await listWorks(`openalex_id:${chunk.join('|')}`, {
            signal: exec.signal,
            apiKey,
            mailto,
            limit: chunk.length,
            sort: args.sort,
          })
          results.push(...papers)
        }
        return { direction, id, total: results.length, results }
      } catch (error) {
        return { error: error.message }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `OpenAlex ${args.direction || 'citations'}: ${args.id}`, kind: 'search' }
    },
  }))
}
