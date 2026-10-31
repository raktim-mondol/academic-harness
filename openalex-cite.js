/**
 * Citation-graph traversal over OpenAlex: forward (works citing an ID) and
 * backward (works an ID references). Accepts any identifier that OpenAlex can
 * resolve (DOI, PMID, OpenAlex ID) via paper-resolve.js.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { canonicalDoi, emptyPaper, fromOpenAlexWork, renderPapers, yearOf } from './search-normalize.js'
import { fetchOpenAlexWork } from './paper-resolve.js'

const API = 'https://api.openalex.org'
const OPENCITATIONS = 'https://api.opencitations.net/index/v2'
const SELECT = 'id,doi,ids,title,publication_year,authorships,primary_location,best_oa_location,open_access,cited_by_count,type,topics'
const DIRECTIONS = ['citations', 'references', 'both']

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

async function openAlexCiting(id, options) {
  if (!id) return []
  return listWorks(`cites:${id}`, { ...options, sort: options.sort || 'cited_by_count:desc' })
}

async function openAlexReferences(id, options) {
  if (!id) return []
  const referenced = (await fetchReferencedIds(id, options)).slice(0, options.limit)
  const results = []
  for (let index = 0; index < referenced.length; index += 50) {
    const chunk = referenced.slice(index, index + 50)
    results.push(...await listWorks(`openalex_id:${chunk.join('|')}`, {
      ...options,
      limit: chunk.length,
    }))
  }
  return results
}

function openCitationsPaper(row, direction) {
  const raw = direction === 'citations' ? row.citing : row.cited
  const doi = canonicalDoi(raw)
  const paper = emptyPaper('opencitations')
  paper.doi = doi
  paper.title = direction === 'citations'
    ? `Citing work (${doi || raw || 'unknown DOI'})`
    : `Referenced work (${doi || raw || 'unknown DOI'})`
  paper.year = yearOf(String(row.creation || '').slice(0, 4))
  paper.url = doi ? `https://doi.org/${doi}` : null
  paper.type = 'citation-edge'
  paper.oci = row.oci || null
  paper.timespan = row.timespan || null
  paper.creation_date = row.creation || null
  return paper
}

async function fetchOpenCitations(doi, direction, { signal, limit }) {
  const clean = canonicalDoi(doi)
  if (!clean) return []
  const endpoint = direction === 'citations' ? 'citations' : 'references'
  const limiter = getLimiter('opencitations', { minIntervalMs: 1000 })
  const result = await limiter.run(() => fetchJson(
    `${OPENCITATIONS}/${endpoint}/doi:${encodeURIComponent(clean)}`,
    {
      signal,
      timeoutMs: 30_000,
      maxBytes: 64 * 1024 * 1024,
      headers: { 'User-Agent': searchUserAgent() },
    },
  ))
  if (!result.ok || !Array.isArray(result.data)) return []
  return result.data.slice(0, limit).map((row) => openCitationsPaper(row, direction)).filter(Boolean)
}

async function traceDirection(direction, id, doi, options) {
  let results = []
  let provider = null
  try {
    results = direction === 'citations'
      ? await openAlexCiting(id, options)
      : await openAlexReferences(id, options)
    if (results.length) provider = 'openalex'
  } catch {
    // fall through to OpenCitations
  }
  if (results.length || !doi) return { results, provider, fallback: false }
  const fallback = await fetchOpenCitations(doi, direction, options)
  if (fallback.length) return { results: fallback, provider: 'opencitations', fallback: true }
  return { results: [], provider: null, fallback: false }
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (value.direction === 'both') {
    const bits = [`Citation graph for ${value.id || value.doi}: providers ${value.providers.join(', ') || 'none'}`]
    bits.push(value.citing.results.length
      ? `Works citing (${value.citing.total}):\n${renderPapers(value.citing.results)}`
      : 'Works citing: none returned.')
    bits.push(value.references.results.length
      ? `References (${value.references.total}):\n${renderPapers(value.references.results)}`
      : 'References: none returned.')
    if (value.note) bits.push(value.note)
    return [{ type: 'text', text: bits.join('\n\n') }]
  }
  const label = value.direction === 'references' ? 'References in' : 'Works citing'
  const bits = [`${label} ${value.id || value.doi}: ${value.total ?? value.results.length} shown`]
  if (value.providers?.length) bits.push(`providers: ${value.providers.join(', ')}`)
  bits.push(renderPapers(value.results))
  if (value.note) bits.push(value.note)
  return [{ type: 'text', text: bits.join('\n\n') }]
}

export const name = 'academic-harness-openalex-cite'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'openalex_citations',
    description: [
      'Walk a paper\'s citation graph. direction="citations" returns works that cite it; "references" returns works it cites; "both" returns each side separately.',
      'Accepts a DOI, PMID, PMCID, arXiv ID, or OpenAlex ID. OpenAlex supplies rich records; when OpenAlex has no edges and a DOI exists, OpenCitations Index v2 is used as a DOI-level fallback. OpenCitations titles are explicit placeholders and its edges carry OCI/date metadata, not invented titles.',
      'Use paper_get or paper_resolve to enrich a DOI from the fallback before citing. OPENALEX_API_KEY only raises limits; no key is required.',
    ].join(' '),
    parameters: {
      id: { type: 'string', required: true, description: 'DOI, PMID, PMCID, arXiv ID, or OpenAlex ID to traverse from.' },
      direction: {
        type: 'string',
        enum: DIRECTIONS,
        description: 'citations = forward; references = backward; both = both sides. Default citations.',
      },
      limit: { type: 'number', description: 'Maximum works per direction, 1-100. Default 25.' },
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
      const options = { signal: exec.signal, apiKey, mailto, limit, sort: args.sort }
      try {
        let work = null
        try {
          work = await fetchOpenAlexWork(args.id, { signal: exec.signal, apiKey, email: mailto })
        } catch (error) {
          if (!canonicalDoi(args.id)) throw error
        }
        const id = openAlexId(work)
        const doi = canonicalDoi(work?.doi || args.id)
        if (!id && !doi) return { error: `could not resolve "${args.id}" in OpenAlex or as a DOI` }

        if (direction === 'both') {
          const [citing, references] = await Promise.all([
            traceDirection('citations', id, doi, options),
            traceDirection('references', id, doi, options),
          ])
          const providers = [...new Set([citing.provider, references.provider].filter(Boolean))]
          return {
            direction,
            id: id || null,
            doi,
            citing: { total: citing.results.length, results: citing.results },
            references: { total: references.results.length, results: references.results },
            providers,
            ...(citing.fallback || references.fallback
              ? { note: 'OpenCitations fallback returns DOI-level edges; titles are placeholders.' }
              : {}),
          }
        }

        const traced = await traceDirection(direction, id, doi, options)
        return {
          direction,
          id: id || null,
          doi,
          total: traced.results.length,
          results: traced.results,
          providers: traced.provider ? [traced.provider] : [],
          ...(traced.fallback ? { note: 'OpenCitations fallback returns DOI-level edges; titles are placeholders.' } : {}),
        }
      } catch (error) {
        return { error: error.message }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Citation graph (${args.direction || 'citations'}): ${args.id}`, kind: 'search' }
    },
  }))
}
