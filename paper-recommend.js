/**
 * paper_recommend: related papers for a seed paper (or a few), from Semantic
 * Scholar's recommendation model and OpenAlex's related works.
 *
 * Both sources are algorithmic. Semantic Scholar does not explain its picks, so
 * the "why" for those is only what can be measured locally (same venue, shared
 * fields); OpenAlex candidates also get a shared-reference count and shared
 * topics computed against the seed. Recommendations are leads, not evidence,
 * and citation counts are shown for orientation, not as a quality signal.
 * Nothing is ingested into PaperMemory.
 */
import { defineTool } from 'ah-dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { markInLibrary } from './literature-search.js'
import {
  fromOpenAlexWork, fromSemanticScholarPaper, identifierKind, mergePapers, normalizeTitle, renderPapers,
} from './search-normalize.js'

const OPENALEX = 'https://api.openalex.org'
const S2_RECS = 'https://api.semanticscholar.org/recommendations/v1/papers'
const S2_FIELDS = 'paperId,externalIds,title,year,venue,authors,citationCount,fieldsOfStudy,openAccessPdf,url,journal,publicationVenue'
const OA_FIELDS = 'id,doi,ids,title,publication_year,authorships,primary_location,best_oa_location,open_access,cited_by_count,type,topics,referenced_works,related_works'
export const RECOMMEND_SOURCES = ['s2', 'openalex']

function s2Id(identifier) {
  const parsed = identifierKind(identifier)
  switch (parsed.kind) {
    case 'doi': {
      const arxiv = parsed.value.match(/^10\.48550\/arxiv\.(.+)$/i)
      return arxiv ? `ARXIV:${arxiv[1]}` : `DOI:${parsed.value}`
    }
    case 'arxiv': return `ARXIV:${parsed.value}`
    case 'pmid': return `PMID:${parsed.value}`
    case 'pmcid': return `PMCID:${parsed.value}`
    case 's2': return parsed.value
    default: return null
  }
}

function openAlexPath(identifier) {
  const parsed = identifierKind(identifier)
  switch (parsed.kind) {
    case 'openalex': return `/works/${parsed.value}`
    case 'doi': return `/works/doi:${encodeURIComponent(parsed.value).replace(/%2F/gi, '/')}`
    case 'pmid': return `/works/pmid:${parsed.value}`
    case 'arxiv': return `/works/doi:10.48550/arXiv.${encodeURIComponent(parsed.value)}`
    default: return null
  }
}

const shortId = (value) => String(value || '').match(/W\d+/)?.[0] || null

async function recommendS2(seeds, { limit, signal, http, apiKey }) {
  const ids = seeds.map(s2Id).filter(Boolean)
  if (!ids.length) return { source: 's2', state: 'not_supported', error: 'no seed is a DOI, arXiv, PMID, PMCID, or Semantic Scholar id' }
  const headers = { 'User-Agent': searchUserAgent(), ...(apiKey ? { 'x-api-key': apiKey } : {}) }
  const limiter = getLimiter('s2', { minIntervalMs: 1000 })
  const result = await limiter.run(() => (ids.length === 1
    ? http(`${S2_RECS}/forpaper/${encodeURIComponent(ids[0]).replace(/%3A/gi, ':').replace(/%2F/gi, '/')}?fields=${encodeURIComponent(S2_FIELDS)}&limit=${limit}`, { signal, headers })
    : http(`${S2_RECS}?fields=${encodeURIComponent(S2_FIELDS)}&limit=${limit}`, {
      method: 'POST', signal, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ positivePaperIds: ids }),
    })))
  if (!result.ok) {
    const state = result.status === 404 ? 'not_found' : (result.status === 429 ? 'provider_blocked' : 'error')
    return { source: 's2', state, error: `Semantic Scholar recommendations ${result.error || result.status}` }
  }
  const papers = (result.data?.recommendedPapers || []).map(fromSemanticScholarPaper).filter(Boolean)
  return { source: 's2', papers }
}

async function recommendOpenAlex(seeds, { limit, signal, http, apiKey, mailto }) {
  const headers = { 'User-Agent': searchUserAgent(mailto) }
  const auth = new URLSearchParams()
  if (apiKey) auth.set('api_key', apiKey)
  if (mailto) auth.set('mailto', mailto)
  const limiter = getLimiter('openalex', { minIntervalMs: apiKey ? 34 : 100 })
  const seedWorks = []
  for (const seed of seeds) {
    const path = openAlexPath(seed)
    if (!path) continue
    const params = new URLSearchParams(auth)
    params.set('select', OA_FIELDS)
    const res = await limiter.run(() => http(`${OPENALEX}${path}?${params}`, { signal, headers }))
    if (res.ok && res.data) seedWorks.push(res.data)
  }
  if (!seedWorks.length) return { source: 'openalex', state: 'not_found', error: 'no seed resolved in OpenAlex' }
  const seedIds = new Set(seedWorks.map((w) => shortId(w.id)))
  const related = [...new Set(seedWorks.flatMap((w) => (w.related_works || []).map(shortId).filter(Boolean)))]
    .filter((id) => !seedIds.has(id)).slice(0, limit)
  if (!related.length) return { source: 'openalex', papers: [], note: 'OpenAlex lists no related works for the seed' }
  const params = new URLSearchParams(auth)
  params.set('filter', `openalex_id:${related.join('|')}`)
  params.set('per_page', String(Math.min(related.length, 100)))
  params.set('select', OA_FIELDS)
  const res = await limiter.run(() => http(`${OPENALEX}/works?${params}`, { signal, headers }))
  if (!res.ok) return { source: 'openalex', state: 'error', error: `OpenAlex ${res.error || res.status}` }
  const seedRefs = new Set(seedWorks.flatMap((w) => (w.referenced_works || []).map(shortId)))
  const seedTopics = new Set(seedWorks.flatMap((w) => (w.topics || []).map((t) => t.display_name)))
  const papers = (res.data?.results || []).map((work) => {
    const paper = fromOpenAlexWork(work)
    if (!paper) return null
    paper.shared_references = (work.referenced_works || []).map(shortId).filter((id) => seedRefs.has(id)).length
    paper.shared_topics = (work.topics || []).map((t) => t.display_name).filter((t) => seedTopics.has(t))
    paper.cites_seed = seedIds.size ? [...seedIds].some((id) => (work.referenced_works || []).map(shortId).includes(id)) : false
    return paper
  }).filter(Boolean)
  return { source: 'openalex', papers, seedVenues: seedWorks.map((w) => w.primary_location?.source?.display_name).filter(Boolean), seedTopics: [...seedTopics] }
}

function explain(paper, context) {
  const why = []
  if (paper.shared_references > 0) why.push(`shares ${paper.shared_references} reference(s) with the seed`)
  if (paper.cites_seed) why.push('cites the seed')
  if (paper.shared_topics?.length) why.push(`shared topics: ${paper.shared_topics.slice(0, 3).join(', ')}`)
  if (paper.venue && context.seedVenues.some((v) => v && v.toLowerCase() === String(paper.venue).toLowerCase())) why.push(`same venue (${paper.venue})`)
  const via = (paper.sources || []).map((s) => (s === 's2' ? 'Semantic Scholar model' : 'OpenAlex related works')).join(' + ')
  why.push(`suggested by ${via}${paper.sources?.includes('s2') && !paper.shared_references ? ' (no explanation from the provider)' : ''}`)
  return why
}

export async function runPaperRecommend(args, exec, deps = {}) {
  const seeds = [...new Set([args.seed, ...(Array.isArray(args.seeds) ? args.seeds : [])].map((s) => String(s || '').trim()).filter(Boolean))]
  if (!seeds.length) throw new Error('give a seed (DOI, arXiv id, PMID, OpenAlex id, or Semantic Scholar id) or seeds')
  const sources = args.sources ? [].concat(args.sources).flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean) : RECOMMEND_SOURCES
  const bad = sources.find((s) => !RECOMMEND_SOURCES.includes(s))
  if (bad) throw new Error(`unknown source "${bad}"; use ${RECOMMEND_SOURCES.join(', ')}`)
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
  const http = deps.fetchJson || fetchJson
  const [s2Key, oaKey, mailto] = await Promise.all([
    resolveEnv('S2_API_KEY'), resolveEnv('OPENALEX_API_KEY'),
    resolveEnv('CROSSREF_MAILTO').then((v) => v || resolveEnv('UNPAYWALL_EMAIL')),
  ])
  const options = { limit, signal: exec?.signal, http }
  const settled = await Promise.allSettled(sources.map((source) => (source === 's2'
    ? recommendS2(seeds, { ...options, apiKey: s2Key })
    : recommendOpenAlex(seeds, { ...options, apiKey: oaKey, mailto }))))
  const failures = []
  const papers = []
  const context = { seedVenues: [] }
  settled.forEach((entry, index) => {
    const source = sources[index]
    if (entry.status === 'rejected') return failures.push({ source, state: 'error', error: entry.reason?.message || String(entry.reason) })
    if (entry.value.error) failures.push({ source, state: entry.value.state, error: entry.value.error })
    for (const venue of entry.value.seedVenues || []) context.seedVenues.push(venue)
    papers.push(...(entry.value.papers || []))
  })
  const seedKeys = new Set(seeds.map((s) => identifierKind(s).value.toLowerCase()))
  // mergePapers keeps the first record's fields, so carry the measured overlap across by identity.
  const noteKey = (p) => (p.doi ? `doi:${String(p.doi).toLowerCase()}` : `title:${normalizeTitle(p.title)}`)
  const measured = new Map(papers.filter((p) => p.shared_references !== undefined).map((p) => [noteKey(p), p]))
  let merged = mergePapers(papers).filter((p) => !seedKeys.has(String(p.doi || '').toLowerCase()) && !seedKeys.has(String(p.arxiv_id || '').toLowerCase()))
  merged = merged.map((paper) => {
    const note = measured.get(noteKey(paper))
    const enriched = note ? { ...paper, shared_references: note.shared_references, shared_topics: note.shared_topics, cites_seed: note.cites_seed } : paper
    return { ...enriched, why: explain(enriched, context) }
  })
  // Two providers agreeing is a mild signal worth ranking on; citation count is not.
  merged.sort((a, b) => (b.sources.length - a.sources.length) || ((b.shared_references || 0) - (a.shared_references || 0)))
  let library = null
  if (args.exclude_library !== false) {
    library = await (deps.markInLibrary || markInLibrary)(merged, exec)
    if (library) merged = merged.filter((p) => !p.in_library)
  }
  const shown = merged.slice(0, limit)
  return {
    seeds,
    sources,
    retrieved_at: new Date().toISOString(),
    total_unique: merged.length,
    papers: shown,
    failures,
    library: library ? { checked: library.checked, excluded: library.in_library } : { checked: false, note: 'reference library unavailable or empty of DOIs; duplicates against it were not removed' },
    caveats: ['Recommendations are algorithmic leads, not evidence.', 'Citation counts are shown for orientation only and are not a quality signal.'],
  }
}

function render(value) {
  if (value?.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const lines = [`Recommendations for ${value.seeds.join(', ')} · sources: ${value.sources.join(', ')} · ${value.papers.length} of ${value.total_unique} shown`]
  if (value.failures.length) lines.push(`failed: ${value.failures.map((f) => `${f.source} (${f.state || 'error'}: ${f.error})`).join('; ')}`)
  if (value.library?.excluded) lines.push(`${value.library.excluded} already in your reference library were left out.`)
  else if (value.library?.checked === false) lines.push(value.library.note)
  value.papers.forEach((paper, index) => {
    lines.push(renderPapers([paper]).replace(/^/, `${index + 1}. `))
    lines.push(`   why: ${paper.why.join('; ')}`)
  })
  lines.push(...value.caveats.map((c) => `Note: ${c}`))
  return [{ type: 'text', text: lines.join('\n') }]
}

/** The host requires lossless JSON: no `undefined` fields, no non-finite numbers. */
function plain(value) {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)))
}

export const name = 'academic-harness-paper-recommend'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'paper_recommend',
    description: [
      'Recommend related papers from a seed (or a few): Semantic Scholar recommendations plus OpenAlex related works, merged and de-duplicated, with papers already in your PaperMemory library left out when the library is reachable.',
      'Each result says why it was suggested: shared references, shared topics, same venue, or only "suggested by the provider" when the provider gives no reason. Recommendations are algorithmic leads, not evidence, and citation counts are not a quality signal. Nothing is ingested; use paper_get / papermemory to bring a paper in. Seeds are DOI, arXiv id, PMID, OpenAlex id (OpenAlex only), or Semantic Scholar id.',
    ].join(' '),
    parameters: {
      seed: { type: 'string', description: 'Seed paper identifier.' },
      seeds: { type: 'array', items: { type: 'string' }, description: 'Several seeds (Semantic Scholar then recommends from all of them together).' },
      sources: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 's2, openalex, or both (default).' },
      limit: { type: 'number', description: 'Results to return, 1-100. Default 20.' },
      exclude_library: { type: 'boolean', description: 'Leave out papers already in the PaperMemory library (default true; skipped when the library is unavailable).' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => render(value) },
    async execute(args, exec) {
      try {
        return plain(await runPaperRecommend(args, exec))
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Recommend: ${args.seed || (args.seeds || [])[0] || ''}`, kind: 'other' }
    },
  }))
}
