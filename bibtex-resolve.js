/**
 * Canonical BibTeX resolution for one paper.
 *
 * Order: DOI content negotiation, arXiv, INSPIRE, the Semantic Scholar
 * citationStyles field, then deterministic synthesis from the normalized
 * record. The caller gets both the entry and which tier produced it.
 */
import { resolveEnv } from './credential-env.js'
import { fetchJson, fetchText, getLimiter, searchUserAgent } from './search-http.js'
import {
  canonicalArxivId,
  canonicalDoi,
  canonicalInspireId,
  identifierKind,
} from './search-normalize.js'
import { normalizeCsl, toBibtex } from './citation-format.js'

const DOI_RESOLVER = 'https://doi.org'
const CROSSREF = 'https://api.crossref.org/works'
const ARXIV = 'https://arxiv.org/bibtex'
const INSPIRE = 'https://inspirehep.net/api/literature'
const S2 = 'https://api.semanticscholar.org/graph/v1'

function cleanBibtex(body) {
  const text = String(body || '').trim()
  return text.startsWith('@') ? text : null
}

async function crossrefMailto() {
  return await resolveEnv('CROSSREF_MAILTO') || await resolveEnv('UNPAYWALL_EMAIL') || ''
}

async function fetchDoiBibtex(doi, signal) {
  const clean = canonicalDoi(doi)
  if (!clean) return null
  const limiter = getLimiter('doi-bibtex', { minIntervalMs: 200 })
  const negotiated = await limiter.run(() => fetchText(`${DOI_RESOLVER}/${clean}`, {
    signal,
    timeoutMs: 20_000,
    retries: 1,
    headers: {
      'User-Agent': searchUserAgent(),
      Accept: 'application/x-bibtex; charset=utf-8',
    },
  }))
  if (negotiated.ok) {
    const value = cleanBibtex(negotiated.data)
    if (value) return value
  }

  const mailto = await crossrefMailto()
  const params = new URLSearchParams()
  if (mailto) params.set('mailto', mailto)
  const query = params.toString()
  const fallback = await limiter.run(() => fetchText(
    `${CROSSREF}/${encodeURIComponent(clean)}/transform/application/x-bibtex${query ? `?${query}` : ''}`,
    {
      signal,
      timeoutMs: 20_000,
      retries: 1,
      headers: {
        'User-Agent': searchUserAgent(mailto),
        Accept: 'application/x-bibtex',
      },
    },
  ))
  return fallback.ok ? cleanBibtex(fallback.data) : null
}

async function fetchArxivBibtex(arxivId, signal) {
  const clean = canonicalArxivId(arxivId)
  if (!clean) return null
  const limiter = getLimiter('arxiv-bibtex', { minIntervalMs: 3000, maxConcurrent: 1 })
  const result = await limiter.run(() => fetchText(`${ARXIV}/${clean}`, {
    signal,
    timeoutMs: 20_000,
    retries: 1,
    headers: { 'User-Agent': searchUserAgent(), Accept: 'text/plain' },
  }))
  return result.ok ? cleanBibtex(result.data) : null
}

async function fetchInspireBibtex(inspireId, signal) {
  const clean = canonicalInspireId(`inspire:${inspireId}`) || String(inspireId || '').trim()
  if (!clean) return null
  const limiter = getLimiter('inspire-bibtex', { minIntervalMs: 334 })
  const result = await limiter.run(() => fetchText(`${INSPIRE}/${encodeURIComponent(clean)}?format=bibtex`, {
    signal,
    timeoutMs: 20_000,
    retries: 1,
    headers: { 'User-Agent': searchUserAgent(), Accept: 'text/plain' },
  }))
  return result.ok ? cleanBibtex(result.data) : null
}

async function fetchS2Bibtex(s2Id, signal) {
  const clean = String(s2Id || '').trim()
  if (!clean) return null
  const apiKey = await resolveEnv('S2_API_KEY')
  const headers = { 'User-Agent': searchUserAgent(), Accept: 'application/json' }
  if (apiKey) headers['x-api-key'] = apiKey
  const limiter = getLimiter('s2', { minIntervalMs: 1000 })
  const result = await limiter.run(() => fetchJson(
    `${S2}/paper/${encodeURIComponent(clean)}?fields=citationStyles`,
    { signal, headers },
  ))
  if (!result.ok) return null
  return cleanBibtex(result.data?.citationStyles?.bibtex)
}

export function paperToCsl(paper, { citationKey } = {}) {
  const source = paper || {}
  const author = (source.authors || [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
    .filter(Boolean)
  const record = {
    type: source.type === 'preprint' ? 'article' : 'article-journal',
    title: source.title || undefined,
    author: author.length ? author : undefined,
    issued: source.year ? { 'date-parts': [[source.year]] } : undefined,
    'container-title': source.journal?.name || source.venue || undefined,
    publisher: source.journal?.publisher || source.publisher || undefined,
    volume: source.volume || undefined,
    issue: source.issue || undefined,
    page: source.pages || undefined,
    DOI: source.doi || undefined,
    URL: source.url || source.html_url || source.pdf_url || (source.doi ? `https://doi.org/${source.doi}` : undefined),
    abstract: source.abstract || undefined,
  }
  if (citationKey) record['citation-key'] = citationKey
  return normalizeCsl([record])[0]
}

export function synthesizeBibtex(paper) {
  return toBibtex([paperToCsl(paper)])
}

/**
 * Resolve the best available BibTeX for a normalized paper.
 * Returns { bibtex, source } or { bibtex: null, source: null }.
 */
export async function resolveBibtexForPaper(paper, { signal } = {}) {
  if (!paper) return { bibtex: null, source: null }

  if (paper.doi) {
    const bibtex = await fetchDoiBibtex(paper.doi, signal)
    if (bibtex) return { bibtex, source: 'doi' }
  }
  if (paper.arxiv_id) {
    const bibtex = await fetchArxivBibtex(paper.arxiv_id, signal)
    if (bibtex) return { bibtex, source: 'arxiv' }
  }
  if (paper.inspire_id) {
    const bibtex = await fetchInspireBibtex(paper.inspire_id, signal)
    if (bibtex) return { bibtex, source: 'inspire' }
  }
  if (paper.bibtex) {
    const bibtex = cleanBibtex(paper.bibtex)
    if (bibtex) return { bibtex, source: paper.s2_id ? 's2' : 'provided' }
  }
  if (paper.s2_id) {
    const bibtex = await fetchS2Bibtex(paper.s2_id, signal)
    if (bibtex) return { bibtex, source: 's2' }
  }
  return { bibtex: synthesizeBibtex(paper), source: 'synthesized' }
}

/** Resolve BibTeX for a bare identifier; unknown/title identifiers use paper_get. */
export async function resolveBibtexForIdentifier(identifier, { signal, allowPaperGet = true } = {}) {
  const raw = String(identifier || '').trim()
  if (!raw) return { bibtex: null, source: null }
  const parsed = identifierKind(raw)

  if (parsed.kind === 'doi') {
    const bibtex = await fetchDoiBibtex(parsed.value, signal)
    if (bibtex) return { bibtex, source: 'doi' }
  }
  if (parsed.kind === 'arxiv') {
    const bibtex = await fetchArxivBibtex(parsed.value, signal)
    if (bibtex) return { bibtex, source: 'arxiv' }
  }
  if (parsed.kind === 'inspire') {
    const bibtex = await fetchInspireBibtex(parsed.value, signal)
    if (bibtex) return { bibtex, source: 'inspire' }
  }
  if (parsed.kind === 's2') {
    const bibtex = await fetchS2Bibtex(parsed.value, signal)
    if (bibtex) return { bibtex, source: 's2' }
  }
  if (!allowPaperGet) return { bibtex: null, source: null }

  const { runPaperGet } = await import('./paper-get.js')
  const value = await runPaperGet({ identifier: raw, include_bibtex: true, include_oa: false }, { signal })
  if (value?.bibtex) return { bibtex: value.bibtex, source: value.bibtex_source || 'paper_get' }
  return { bibtex: null, source: null }
}
