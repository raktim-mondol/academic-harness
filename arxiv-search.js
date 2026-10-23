/**
 * arXiv API search (https://export.arxiv.org/api/query) — Atom 1.0 XML, no key.
 *
 * arXiv's terms allow one request every three seconds and one concurrent
 * connection, enforced by the shared limiter. The Atom parser is intentionally
 * small: arXiv's schema is stable and adding an XML dependency for four fields
 * is not worth the install footprint.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchText, getLimiter, searchUserAgent } from './search-http.js'
import { fromArxivEntry, renderPapers } from './search-normalize.js'

const API = 'https://export.arxiv.org/api/query'
const FIELDS = ['all', 'title', 'author', 'abstract', 'category']
const FIELD_PREFIX = { all: 'all', title: 'ti', author: 'au', abstract: 'abs', category: 'cat' }
const SORTS = ['relevance', 'lastUpdatedDate', 'submittedDate']
const ORDERS = ['ascending', 'descending']
const PREFIXED_QUERY = /^(ti|au|abs|cat|co|jr|rn|id|all):/i

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

function tagText(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))
  return match ? decodeXml(match[1]).replace(/\s+/g, ' ').trim() : null
}

function linkAttrs(block) {
  return [...block.matchAll(/<link\b([^>]*?)\/?>/g)].map((match) => {
    const attrs = match[1]
    const href = attrs.match(/href="([^"]*)"/)?.[1]
    const title = attrs.match(/title="([^"]*)"/)?.[1]
    const rel = attrs.match(/rel="([^"]*)"/)?.[1]
    return { href: href ? decodeXml(href) : null, title, rel }
  })
}

export function parseAtom(xml) {
  const totalMatch = xml.match(/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/)
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => match[1])
  const parsed = entries.map((block) => {
    const links = linkAttrs(block)
    const authors = [...block.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)]
      .map((match) => decodeXml(match[1]).replace(/\s+/g, ' ').trim())
    const categories = [...block.matchAll(/<category\b[^>]*term="([^"]+)"/g)].map((match) => match[1])
    const primary = block.match(/<arxiv:primary_category\b[^>]*term="([^"]+)"/)?.[1]
    return {
      id: tagText(block, 'id'),
      title: tagText(block, 'title'),
      summary: tagText(block, 'summary'),
      published: tagText(block, 'published'),
      updated: tagText(block, 'updated'),
      authors,
      doi: tagText(block, 'arxiv:doi'),
      journalRef: tagText(block, 'arxiv:journal_ref'),
      primaryCategory: primary || categories[0] || null,
      categories,
      pdfUrl: links.find((link) => link.title === 'pdf')?.href || null,
      absUrl: links.find((link) => link.rel === 'alternate')?.href || tagText(block, 'id'),
    }
  })
  return {
    total: totalMatch ? Number(totalMatch[1]) : parsed.length,
    entries: parsed,
  }
}

export function buildSearchQuery(query, field) {
  const trimmed = String(query).trim()
  if (PREFIXED_QUERY.test(trimmed)) return trimmed
  const prefix = FIELD_PREFIX[field] || 'all'
  if (prefix === 'all' && /\b(AND|OR|ANDNOT)\b/.test(trimmed)) return trimmed
  return /\s/.test(trimmed) ? `${prefix}:"${trimmed}"` : `${prefix}:${trimmed}`
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  return [{ type: 'text', text: `arXiv: ${value.total ?? value.results.length} total · showing ${value.results.length}\n\n${renderPapers(value.results || [], { abstractChars: 700 })}` }]
}

export async function runArxivSearch(args, exec) {
  const ids = (args.ids || []).map((id) => String(id).trim()).filter(Boolean)
  if (ids.length && String(args.query || '').trim()) {
    return { error: 'give query or ids, not both' }
  }
  if (!ids.length && !String(args.query || '').trim()) return { error: 'give a query or ids' }
  if (ids.length > 100) return { error: 'pass at most 100 arXiv IDs per call' }

  const params = new URLSearchParams()
  if (ids.length) params.set('id_list', ids.join(','))
  else params.set('search_query', buildSearchQuery(args.query, args.field))
  params.set('start', String(Math.max(0, Number(args.start) || 0)))
  const fallbackMax = ids.length ? ids.length : 25
  params.set('max_results', String(Math.min(Math.max(Number(args.max_results) || fallbackMax, 1), 200)))
  params.set('sortBy', SORTS.includes(args.sort_by) ? args.sort_by : 'relevance')
  params.set('sortOrder', ORDERS.includes(args.sort_order) ? args.sort_order : 'descending')

  const email = await resolveEnv('UNPAYWALL_EMAIL')
  const limiter = getLimiter('arxiv', { minIntervalMs: 3000, maxConcurrent: 1 })
  const result = await limiter.run(() => fetchText(`${API}?${params}`, {
    signal: exec?.signal,
    headers: { 'User-Agent': searchUserAgent(email) },
  }))
  if (!result.ok) {
    if (result.error === 'aborted') return { error: 'request cancelled' }
    return { error: `arXiv API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
  }
  const parsed = parseAtom(result.data || '')
  const results = parsed.entries.map(fromArxivEntry).filter(Boolean)
  return { total: parsed.total, start: Number(params.get('start')), results }
}

export const name = 'academic-harness-arxiv-search'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'arxiv_search',
    description: [
      'Search arXiv preprints in physics, mathematics, computer science, quantitative biology, and statistics.',
      'Use fielded queries (`ti:`, `au:`, `abs:`, `cat:`, e.g. "cat:cs.CL AND abs:retrieval") or pass `ids` for exact arXiv IDs. Returns the abstract, authors, categories, and a PDF link.',
      'No key. arXiv allows one request every 3 seconds, so this tool serializes calls; avoid issuing many arxiv_search calls in one round.',
      'Use this for preprints, and pubmed_search/openalex_search/s2_search for published literature.',
    ].join(' '),
    parameters: {
      query: { type: 'string', description: 'Query text, or a fielded arXiv query (ti:/au:/abs:/cat:/all: with AND/OR/ANDNOT).' },
      field: {
        type: 'string',
        enum: FIELDS,
        description: 'Field to search when `query` has no prefix. Default all. Multi-word queries become a quoted phrase.',
      },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exact arXiv IDs (e.g. ["2301.12345"]), up to 100. Do not combine with query.',
      },
      max_results: { type: 'number', description: 'Results per request, 1-200. Default 25.' },
      start: { type: 'number', description: 'Zero-based result offset for paging. Default 0.' },
      sort_by: { type: 'string', enum: SORTS, description: 'relevance (default), lastUpdatedDate, or submittedDate.' },
      sort_order: { type: 'string', enum: ORDERS, description: 'ascending or descending. Default descending.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      return runArxivSearch(args, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `arXiv: ${args.query || (args.ids || []).join(', ')}`, kind: 'search' }
    },
  }))
}
