/**
 * paper_resolve: convert between DOI, PMID, arXiv ID, OpenAlex ID, and
 * Semantic Scholar ID.
 *
 * OpenAlex resolves DOI/PMID/OpenAlex IDs directly; Semantic Scholar is the
 * fallback for DOI/PMID and the only path for arXiv IDs. Citation keys drift
 * when the same paper is fetched from different providers — resolve before
 * citing instead of treating two identifiers as two papers.
 *
 * Exports `fetchOpenAlexWork` for openalex-cite.js so both tools share the
 * same identifier-to-work path.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import {
  identifierKind,
  fromOpenAlexWork,
  fromSemanticScholarPaper,
} from './search-normalize.js'

const OPENALEX = 'https://api.openalex.org'
const S2 = 'https://api.semanticscholar.org/graph/v1'
const OA_SELECT = 'id,doi,ids,title,publication_year,authorships,primary_location,best_oa_location,open_access,cited_by_count,type,topics,abstract_inverted_index'
const S2_FIELDS = 'paperId,externalIds,title,abstract,year,venue,authors,citationCount,influentialCitationCount,openAccessPdf,tldr,publicationTypes,fieldsOfStudy,url'

function encodeDoiPath(doi) {
  return encodeURIComponent(doi).replace(/%2F/gi, '/')
}

function encodeS2Id(identifier) {
  return encodeURIComponent(identifier).replace(/%3A/gi, ':').replace(/%2F/gi, '/')
}

function openalexUrl(path, key, email) {
  const params = new URLSearchParams({ select: OA_SELECT })
  if (key) params.set('api_key', key)
  if (email) params.set('mailto', email)
  return `${OPENALEX}${path}?${params}`
}

export async function fetchOpenAlexWork(identifier, { signal, apiKey, email } = {}) {
  const parsed = identifierKind(identifier)
  let path
  if (parsed.kind === 'openalex') path = `/works/${parsed.value}`
  else if (parsed.kind === 'doi') path = `/works/doi:${encodeDoiPath(parsed.value)}`
  else if (parsed.kind === 'pmid') path = `/works/pmid:${parsed.value}`
  else return null

  const limiter = getLimiter('openalex', { minIntervalMs: apiKey ? 34 : 100 })
  const result = await limiter.run(() => fetchJson(openalexUrl(path, apiKey, email), {
    signal,
    headers: { 'User-Agent': searchUserAgent(email) },
  }))
  if (result.ok) return result.data
  if (result.status === 404) return null
  throw new Error(`OpenAlex API error ${result.status}${result.detail ? `: ${result.detail}` : ''}`)
}

export async function fetchSemanticScholarPaper(identifier, { signal, apiKey } = {}) {
  const limiter = getLimiter('s2', { minIntervalMs: 1000 })
  const headers = { 'User-Agent': searchUserAgent() }
  if (apiKey) headers['x-api-key'] = apiKey
  const result = await limiter.run(() => fetchJson(
    `${S2}/paper/${encodeS2Id(identifier)}?fields=${encodeURIComponent(S2_FIELDS)}`,
    { signal, headers },
  ))
  if (result.ok) return result.data
  if (result.status === 404) return null
  const hint = result.status === 429 ? ' (rate limited; set S2_API_KEY for a dedicated bucket)' : ''
  throw new Error(`Semantic Scholar API error ${result.status}${hint}${result.detail ? `: ${result.detail}` : ''}`)
}

export async function resolveIdentifier(identifier, options = {}) {
  const parsed = identifierKind(identifier)
  if (parsed.kind === 'unknown') return { resolved: false, reason: 'unrecognized identifier' }
  const s2Options = { signal: options.signal, apiKey: options.s2Key }
  let openalexError = null

  if (parsed.kind === 'openalex' || parsed.kind === 'doi' || parsed.kind === 'pmid') {
    try {
      const work = await fetchOpenAlexWork(identifier, options)
      if (work) return { resolved: true, paper: fromOpenAlexWork(work) }
    } catch (error) {
      openalexError = error
    }
  }

  if (parsed.kind === 'doi' || parsed.kind === 'pmid') {
    const prefix = parsed.kind === 'doi' ? 'DOI' : 'PMID'
    const raw = await fetchSemanticScholarPaper(`${prefix}:${parsed.value}`, s2Options)
    if (raw) return { resolved: true, paper: fromSemanticScholarPaper(raw) }
  }

  if (parsed.kind === 'arxiv') {
    const raw = await fetchSemanticScholarPaper(`ARXIV:${parsed.value}`, s2Options)
    if (raw) return { resolved: true, paper: fromSemanticScholarPaper(raw) }
  }

  if (parsed.kind === 's2') {
    const raw = await fetchSemanticScholarPaper(parsed.value, s2Options)
    if (raw) return { resolved: true, paper: fromSemanticScholarPaper(raw) }
  }

  if (openalexError) throw openalexError

  return {
    resolved: false,
    reason: parsed.kind === 'arxiv'
      ? 'not found in Semantic Scholar'
      : 'not found in OpenAlex or Semantic Scholar',
  }
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const lines = value.results.map((entry) => {
    if (!entry.resolved) return `✗ ${entry.input} — ${entry.reason || 'not found'}`
    const paper = entry.paper
    const ids = [
      paper.doi && `doi: ${paper.doi}`,
      paper.pmid && `pmid: ${paper.pmid}`,
      paper.arxiv_id && `arXiv: ${paper.arxiv_id}`,
      paper.openalex_id && `openalex: ${paper.openalex_id}`,
      paper.s2_id && `s2: ${paper.s2_id}`,
    ].filter(Boolean)
    const meta = [paper.year, paper.venue].filter(Boolean).join(' · ')
    return [
      `✓ ${entry.input} → **${paper.title || '(untitled)'}**${meta ? ` (${meta})` : ''}`,
      ids.length ? `  ${ids.join(' · ')}` : '  (no cross-identifiers returned)',
    ].join('\n')
  })
  return [{ type: 'text', text: lines.join('\n') }]
}

export const name = 'academic-harness-paper-resolve'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'paper_resolve',
    description: [
      'Resolve a paper identifier to its other identifiers: DOI, PMID, arXiv ID, OpenAlex ID, or Semantic Scholar ID.',
      'Use this before citing whenever results came from more than one database, so the same paper is not cited twice under different IDs.',
      'OpenAlex resolves DOI/PMID/OpenAlex IDs; Semantic Scholar resolves arXiv IDs and the rest as a fallback. Both are free; OPENALEX_API_KEY and S2_API_KEY only raise limits.',
      'Accepts one `id` or up to 10 `ids`. Returns `resolved: false` with a reason when neither database knows the identifier.',
    ].join(' '),
    parameters: {
      id: {
        type: 'string',
        description: 'One identifier: DOI (bare or doi.org URL), PMID, arXiv ID, OpenAlex ID (W…), or Semantic Scholar paperId.',
      },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Up to 10 identifiers to resolve in one call. Combined with `id` when both are given.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      const inputs = [...(args.ids || []), args.id].filter((value) => typeof value === 'string' && value.trim())
      if (!inputs.length) return { error: 'give id or ids' }
      if (inputs.length > 10) return { error: 'resolve at most 10 identifiers per call' }

      const [apiKey, email, s2Key] = await Promise.all([
        resolveEnv('OPENALEX_API_KEY'),
        resolveEnv('CROSSREF_MAILTO').then((value) => value || resolveEnv('UNPAYWALL_EMAIL')),
        resolveEnv('S2_API_KEY'),
      ])

      const results = []
      for (const input of inputs) {
        try {
          const outcome = await resolveIdentifier(input.trim(), {
            signal: exec.signal,
            apiKey,
            email,
            s2Key,
          })
          results.push({ input, ...outcome })
        } catch (error) {
          results.push({ input, resolved: false, reason: error.message })
        }
      }
      return { results }
    },
    presentCall(args) {
      const first = args.id || (Array.isArray(args.ids) ? args.ids[0] : '')
      return { card: 'generic', title: `Resolve identifier: ${first || ''}`, kind: 'search' }
    },
  }))
}
