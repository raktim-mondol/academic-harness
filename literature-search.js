/**
 * literature_search: one-shot multi-source discovery.
 *
 * Auto mode runs OpenAlex + Semantic Scholar, adding PubMed for biomedical
 * queries and arXiv for preprint/CS/physics queries. Crossref is opt-in (its
 * relevance ranking is noisy). Results are deduplicated across sources and
 * fused with reciprocal-rank fusion, so a paper found high in two indexes
 * outranks a paper found once.
 */
import { defineTool } from 'ah-dsh-tools'
import { resolveEnv } from './credential-env.js'
import { capText, mergeRanked, renderPapers } from './search-normalize.js'
import { runOpenAlexSearch } from './openalex-search.js'
import { runS2Search } from './semantic-scholar-search.js'
import { runPubMedSearch } from './pubmed-search.js'
import { runArxivSearch } from './arxiv-search.js'
import { runCrossrefQuery } from './crossref-lookup.js'
import { runBiorxivSearch } from './biorxiv-search.js'
import { runInspireSearch } from './inspire-search.js'
import { runAdsSearch } from './ads-search.js'
import { runScopusSearch } from './scopus-search.js'
import { runWosSearch } from './wos-search.js'
import { runDoajArticles } from './journal-search.js'
import { normalizePublisherAliases, PUBLISHER_ALIASES, runPublisherSearch } from './publisher-members.js'
import { runIeeeSearch, runSpringerSearch } from './publisher-search.js'
import { libraryLaunch, libraryResolve } from './papermemory-library.js'
import { runConsensusPapers } from './consensus-search.js'
import { runFirecrawlPapers } from './firecrawl-papers.js'
import { runParallelPapers } from './parallel-search.js'
import { runSciteSearch } from './scite-search.js'
import { rankWithBm25 } from './bm25-rank.js'
import { rerankWithCohere } from './cohere-rerank.js'
import { askJev, borderlineSources, decideSources, gatingIntents, HINT_KEYS, orderByRelevance, RERANK_POOL, rerankWithJev, suggestTools } from './jev-router.js'

const ALLOWED = [
  'openalex', 's2', 'pubmed', 'arxiv', 'crossref', 'preprints', 'biorxiv',
  'inspire', 'ads', 'scopus', 'wos', 'doaj', 'publishers', 'springer', 'ieee',
  'consensus', 'scite', 'firecrawl', 'parallel',
]
const BIOMEDICAL = /\b(clinic|clinical|patient|patients|trial|trials|disease|therapy|therapies|treatment|cancer|tumou?r|gene|genes|genetic|protein|proteins|cell|cells|drug|drugs|medical|medicine|health|epidemi\w*|cohort|rct|surgery|surgical|diagnos\w*|psychiatr\w*|neuron\w*|biolog\w*|immun\w*|infect\w*|virus|viral|vaccine|malaria|diabetes|alzheimer|parkinson|cardio\w*|oncology)\b/i
const PREPRINT = /\b(arxiv|preprints?|neural|machine learning|deep learning|transformer|transformers|llm|llms|language model|computer vision|algorithm|algorithms|quantum|physics|astrophysic\w*|cosmolog\w*|particle|mathematic\w*|theorem|robot\w*|reinforcement learning|dataset|benchmark|computational)\b/i
const ASKS_FOR_PREPRINTS = /\b(preprints?|biorxiv|medrxiv)\b/i
const HEP_DOMAIN = /\b(high-energy physics|particle physics|nuclear physics|string theory|gravitation|quantum chromodynamics|qcd|collider|boson|fermion|supersymmetry|hep-th|hep-ph)\b/i
const ASTRO_DOMAIN = /\b(astro|astronomy|astrophysics|cosmology|cosmological|planetary|solar system|exoplanet|galaxy|galaxies|supernova|black hole)\b/i
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'and', 'or', 'in', 'on', 'to', 'with', 'by',
  'from', 'at', 'is', 'are', 'be', 'as', 'that', 'this', 'these', 'those',
  'using', 'via', 'into', 'over', 'under', 'between', 'about',
])

/** arXiv needs an operator query; a quoted phrase is too strict for discovery. */
export function arxivDiscoveryQuery(query) {
  const trimmed = String(query || '').trim()
  if (!trimmed) return trimmed
  if (/\b(AND|OR|ANDNOT)\b/.test(trimmed) || /(?:^|\s)(ti|au|abs|cat|all|co|jr|rn|id):/i.test(trimmed)) {
    return trimmed
  }
  const terms = (trimmed.match(/[A-Za-z0-9][A-Za-z0-9-]*/g) || [])
    .filter((term) => !STOPWORDS.has(term.toLowerCase()))
    .slice(0, 10)
  if (!terms.length) return trimmed
  return terms.map((term) => `all:${term}`).join(' AND ')
}

export function parseSources(value) {
  if (value == null || (typeof value === 'string' && !value.trim()) || value === 'auto') return null
  const raw = Array.isArray(value) ? value : String(value).split(',')
  const sources = raw.map((source) => String(source).trim().toLowerCase()).filter(Boolean)
  if (!sources.length || sources.includes('auto')) return null
  const invalid = sources.find((source) => !ALLOWED.includes(source))
  if (invalid) throw new Error(`unknown source "${invalid}"; use auto or ${ALLOWED.join(', ')}`)
  return [...new Set(sources)]
}

export function chooseSources(query, requested, { adsToken = false } = {}) {
  const explicit = parseSources(requested)
  if (explicit) return explicit
  const sources = ['openalex', 's2']
  if (BIOMEDICAL.test(query)) sources.push('pubmed')
  if (PREPRINT.test(query)) sources.push('arxiv')
  if (BIOMEDICAL.test(query) && ASKS_FOR_PREPRINTS.test(query)) sources.push('biorxiv')
  if (HEP_DOMAIN.test(query)) sources.push('inspire')
  if (ASTRO_DOMAIN.test(query) && adsToken) sources.push('ads')
  return sources
}

/**
 * Choose sources for a query. Explicit `requested` sources always win. In auto
 * mode, Jev (when TYPESAFE_API_KEY is set) picks the domain sources and flags
 * queries that really want another tool; with no key, or on any Jev failure, the
 * keyword rules in `chooseSources` decide and `routing.reason` says why.
 * Throws on an unknown source, exactly like `chooseSources`.
 */
export async function routeSources(query, requested, { adsToken = false, mode = 'auto', signal, hierarchy = true } = {}) {
  const explicit = parseSources(requested)
  if (explicit) return { sources: explicit, routing: { engine: 'manual' }, suggested_tools: [] }
  const rules = chooseSources(query, null, { adsToken })
  if (mode === 'rules') return { sources: rules, routing: { engine: 'rules', reason: 'rules_requested' }, suggested_tools: [] }
  const apiKey = await resolveEnv('TYPESAFE_API_KEY')
  const jev = await askJev(query, { apiKey, ads: Boolean(adsToken), signal })
  if (!jev.ok) {
    return {
      sources: rules,
      routing: { engine: 'rules', reason: jev.reason, ...(jev.ms != null ? { ms: jev.ms } : {}) },
      suggested_tools: [],
    }
  }
  const keys = new Set()
  for (const name of HINT_KEYS) if (await resolveEnv(name)) keys.add(name)
  const sourceP = Object.fromEntries(Object.entries(jev.p).filter(([k]) => !k.startsWith('intent::')).map(([k, v]) => [k, Number(v.toFixed(2))]))
  const borderline = borderlineSources(jev.p, { ads: Boolean(adsToken) })
  const flat = decideSources(jev.p, { ads: Boolean(adsToken) })
  // Hierarchy: if the query is really a non-paper ask (retraction, one named paper, trials,
  // news ...), search only the always-on core and let the hint do the work.
  const gatedBy = hierarchy ? gatingIntents(jev.p) : []
  const core = ['openalex', 's2']
  return {
    sources: gatedBy.length ? core : flat,
    routing: {
      engine: 'jev',
      ...(gatedBy.length ? { mode: 'hint_only', gated_by: gatedBy, skipped: flat.filter((source) => !core.includes(source)) } : {}),
      model: jev.model,
      ms: jev.ms,
      ...(jev.cached ? { cached: true } : {}),
      probabilities: sourceP,
      ...(borderline.length ? { borderline } : {}),
    },
    suggested_tools: suggestTools(jev.p, (name) => keys.has(name)),
  }
}

/**
 * Preprint servers match keywords, so "recent preprints on H5N1 in dairy cattle"
 * finds nothing while "H5N1 dairy cattle" finds five. The request for preprints
 * already did its work by choosing the source; strip that wording for it.
 * Returns the original query if stripping would leave nothing.
 */
export function preprintTopic(query) {
  const text = String(query || '').trim()
  const lead = /^(?:(?:the\s+)?(?:most\s+)?(?:recent|new|latest)\s+)?(?:(?:bio|med)rxiv\s+)?preprints?\s+(?:on|about|regarding|of|for)\s+/i
  const tail = /\s+(?:(?:bio|med)rxiv\s+)?preprints?$/i
  const stripped = text.replace(lead, '').replace(tail, '').trim()
  return stripped || text
}

/** Run one source. Exported for `deep_research`, which sweeps many queries. */
export async function runSource(source, { query, perSource, yearMin, yearMax, openAccessOnly, signal }) {
  switch (source) {
    case 'openalex': {
      const filters = []
      if (yearMin != null && yearMax != null) filters.push(`publication_year:${yearMin}-${yearMax}`)
      else if (yearMin != null) filters.push(`from_publication_date:${yearMin}-01-01`)
      else if (yearMax != null) filters.push(`to_publication_date:${yearMax}-12-31`)
      if (openAccessOnly) filters.push('is_oa:true')
      return runOpenAlexSearch({
        query,
        per_page: perSource,
        filter: filters.length ? filters.join(',') : undefined,
      }, { signal })
    }
    case 's2':
      return runS2Search({
        query,
        limit: Math.min(perSource, 100),
        open_access_only: openAccessOnly,
        year: yearMin != null && yearMax != null ? `${yearMin}-${yearMax}` : undefined,
      }, { signal })
    case 'pubmed':
      return runPubMedSearch({
        query: openAccessOnly ? `(${query}) AND OPEN_ACCESS:y` : query,
        source: 'europepmc',
        max_results: Math.min(perSource, 100),
      }, { signal })
    case 'arxiv':
      return runArxivSearch({
        query: arxivDiscoveryQuery(query),
        field: 'all',
        max_results: Math.min(perSource, 200),
      }, { signal })
    case 'preprints':
      return runPubMedSearch({
        query: openAccessOnly ? `(${preprintTopic(query)}) AND OPEN_ACCESS:y` : preprintTopic(query),
        source: 'europepmc',
        preprints: true,
        max_results: Math.min(perSource, 100),
      }, { signal })
    case 'biorxiv':
      return runBiorxivSearch({
        query: openAccessOnly ? `(${preprintTopic(query)}) AND OPEN_ACCESS:y` : preprintTopic(query),
        limit: Math.min(perSource, 100),
      }, { signal })
    case 'inspire':
      return runInspireSearch({ query, limit: Math.min(perSource, 100) }, { signal })
    case 'ads':
      return runAdsSearch({ query, limit: Math.min(perSource, 100) }, { signal })
    case 'scopus':
      return runScopusSearch({ query, limit: Math.min(perSource, 100) }, { signal })
    case 'wos':
      return runWosSearch({ query, limit: Math.min(perSource, 50) }, { signal })
    case 'crossref': {
      const filters = []
      if (yearMin != null) filters.push(`from-pub-date:${yearMin}-01-01`)
      if (yearMax != null) filters.push(`until-pub-date:${yearMax}-12-31`)
      return runCrossrefQuery({
        query,
        rows: Math.min(perSource, 100),
        filter: filters.length ? filters.join(',') : undefined,
      }, { signal })
    }
    case 'consensus':
      return runConsensusPapers({ query, limit: Math.min(perSource, 50), yearMin, yearMax, openAccessOnly }, { signal })
    case 'scite':
      return runSciteSearch({ query, limit: Math.min(perSource, 50), yearMin, yearMax }, { signal })
    case 'firecrawl':
      return runFirecrawlPapers({ query, limit: Math.min(perSource, 100) }, { signal })
    case 'parallel':
      return runParallelPapers({ query, limit: Math.min(perSource, 20) }, { signal })
    case 'doaj':
      return runDoajArticles({ query, limit: Math.min(perSource, 50) }, { signal })
    case 'springer':
      return runSpringerSearch({ query, limit: Math.min(perSource, 50), year_min: yearMin, year_max: yearMax, open_access_only: openAccessOnly }, { signal })
    case 'ieee':
      return runIeeeSearch({ query, limit: Math.min(perSource, 50), year_min: yearMin, year_max: yearMax, open_access_only: openAccessOnly }, { signal })
    default:
      if (source.startsWith('publisher:')) {
        return runPublisherSearch({
          publisher: source.slice('publisher:'.length),
          query,
          limit: Math.min(perSource, 50),
          year_min: yearMin,
          year_max: yearMax,
        }, { signal })
      }
      throw new Error(`unknown source "${source}"`)
  }
}

/**
 * Flag results already in the PaperMemory reference library (by DOI), so they are not added twice.
 * Best effort and local: when PaperMemory or its library is unavailable the field is simply absent,
 * which means "not checked", not "not in the library".
 */
export async function markInLibrary(papers, exec) {
  const dois = [...new Set(papers.map((paper) => paper.doi).filter(Boolean))]
  if (!dois.length || !libraryLaunch()) return undefined
  const resolved = await libraryResolve(dois, { cwd: exec?.agent?.session?.header?.cwd || process.cwd(), signal: exec?.signal })
  if (!resolved.ok) return undefined
  const byDoi = new Map(resolved.results.filter((entry) => entry.found).map((entry) => [entry.ref, entry.key]))
  let matched = 0
  for (const paper of papers) {
    const key = paper.doi ? byDoi.get(String(paper.doi).trim()) : undefined
    if (key) {
      paper.in_library = key
      matched += 1
    }
  }
  return { checked: dois.length, in_library: matched }
}

function withinYears(paper, min, max) {
  if (paper.year == null) return true
  if (min != null && paper.year < min) return false
  if (max != null && paper.year > max) return false
  return true
}

function isOpen(paper) {
  if (paper.oa_url) return true
  const status = String(paper.oa_status || '').toLowerCase()
  return Boolean(status) && !['closed', 'unknown'].includes(status)
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const bits = [
    `Literature search: "${value.query}" · sources: ${value.sources.join(', ')}`,
    `${value.total_unique} unique · showing ${value.papers.length}${value.truncated ? ' (truncated)' : ''}`,
  ]
  const counts = Object.entries(value.counts || {}).map(([source, count]) => `${source} ${count}`).join(', ')
  if (counts) bits.push(`per source: ${counts}`)
  if (value.routing && value.routing.engine !== 'manual') {
    const r = value.routing
    const detail = r.engine === 'jev'
      ? `jev ${r.model}${r.ms != null ? `, ${r.ms} ms` : ''}${r.mode === 'hint_only' ? `; hint mode, searched only OpenAlex and Semantic Scholar (skipped ${r.skipped.length ? r.skipped.join(', ') : 'nothing extra'}) because the query asks for ${r.gated_by.join(', ')}` : ''}${r.borderline?.length ? `; borderline ${r.borderline.map((b) => `${b.source} ${b.p}`).join(', ')}` : ''}`
      : `keyword rules (${r.reason})`
    bits.push(`routing: ${detail}`)
  }
  if (value.routing?.rerank) {
    const k = value.routing.rerank
    bits.push(k.engine !== 'rrf'
      ? `ranking: ${k.engine === 'bm25' ? 'local BM25 fused with the source order' : `${k.engine === 'cohere' ? 'Cohere' : 'Jev'} relevance`} over the top ${k.candidates} merged candidates (${k.ms} ms)${k.fallback_from ? `; ${Object.entries(k.fallback_from).map(([name, why]) => `${name} skipped: ${why}`).join(', ')}` : ''}`
      : `ranking: fused source ranking (rerank skipped: ${k.reason})`)
  }
  if (value.suggested_tools?.length) {
    bits.push(`this query may be better served by: ${value.suggested_tools.map((s) => `${s.tool} (${s.reason})`).join('; ')}`)
  }
  if (value.warnings?.length) bits.push(`warnings: ${value.warnings.join('; ')}`)
  if (value.failures?.length) {
    bits.push(`failed: ${value.failures.map((failure) => `${failure.source} (${failure.error})`).join('; ')}`)
  }
  if (value.library?.in_library) {
    const have = (value.papers || []).filter((paper) => paper.in_library).map((paper) => paper.in_library)
    bits.push(`already in your reference library: ${have.join(', ')}`)
  }
  bits.push(renderPapers(value.papers || [], {
    abstractChars: value.include_abstracts ? 500 : 0,
    showSources: true,
  }))
  return [{ type: 'text', text: capText(bits.join('\n\n')) }]
}

/**
 * Longest a source may take before the search carries on without it. One stalled provider
 * (a throttled arXiv answers 429 only after ~15 s) must not hold back the rest. Tests may
 * lower these. The metered semantic APIs get longer because they are slower when healthy.
 */
export const SOURCE_DEADLINES_MS = { default: 12_000, s2: 20_000, firecrawl: 30_000, parallel: 30_000, scite: 30_000, consensus: 20_000 }

async function runWithDeadline(source, parentSignal, run) {
  const ms = SOURCE_DEADLINES_MS[source] ?? SOURCE_DEADLINES_MS.default
  const timer = AbortSignal.timeout(ms)
  const signal = parentSignal ? AbortSignal.any([parentSignal, timer]) : timer
  let outcome
  try {
    outcome = await run(signal)
  } catch (error) {
    if (!(timer.aborted && !parentSignal?.aborted)) throw error
    outcome = { error: 'aborted' }
  }
  if (timer.aborted && !parentSignal?.aborted && (!outcome || outcome.error)) {
    return { error: `${source} did not answer within ${Math.round(ms / 1000)} s; the search continued without it`, code: 'timeout' }
  }
  return outcome
}

/**
 * What `rerank: "auto"` may use: Jev when a TypeSafe key is set. With no key, or if Jev fails, the
 * local fallback (BM25 fused with the source order, no network) runs instead. Cohere is opt-in only
 * (`rerank: "cohere"`), never an automatic fallback.
 */
export const RERANK_PREFERENCE = ['jev']
const RRF_K = 60

/**
 * Local fallback: rank the candidates with BM25 over title + abstract, then fuse that ranking with
 * the existing source order by reciprocal rank (k = 60). On 36 live merged lists rated blind this
 * beat the plain source order; BM25 on its own did not, so the fusion is the whole point.
 * Returns `{ ok, ordered }` (candidates in the new order) or `{ ok: false, reason }`.
 */
export function orderLocally(query, pool) {
  const started = Date.now()
  const lexical = rankWithBm25(query, pool)
  if (!lexical.ok) return { ok: false, reason: lexical.reason }
  const byBm25 = pool.map((_, i) => i).sort((a, b) => lexical.scores[b] - lexical.scores[a] || a - b)
  const bm25Rank = new Map(byBm25.map((index, rank) => [index, rank]))
  const fused = pool.map((paper, index) => ({ paper, index, score: 1 / (RRF_K + index) + 1 / (RRF_K + bm25Rank.get(index)) }))
  fused.sort((a, b) => b.score - a.score || a.index - b.index)
  return { ok: true, ordered: fused.map((entry) => entry.paper), ms: Date.now() - started }
}
const RERANK_KEYS = { jev: 'TYPESAFE_API_KEY', cohere: 'COHERE_API_KEY' }

async function rerankCandidates(query, pool, { mode, signal, localOnly = false }) {
  if (mode === 'bm25') return localOutcome(query, pool, {}, false)
  const engines = localOnly ? [] : RERANK_KEYS[mode] ? [mode] : RERANK_PREFERENCE
  const skipped = {}
  let attempted = false
  for (const engine of engines) {
    const apiKey = await resolveEnv(RERANK_KEYS[engine])
    if (!apiKey) {
      // an explicitly requested engine without a key is worth reporting; in auto it is just not available
      if (RERANK_KEYS[mode]) return { ok: false, attempted: true, reason: 'no_key', skipped }
      continue
    }
    attempted = true
    const ranked = engine === 'jev'
      ? await rerankWithJev(query, pool, { apiKey, signal })
      : await rerankWithCohere(query, pool, { apiKey, signal })
    if (ranked.ok) return { ok: true, engine, ranked, skipped }
    skipped[engine] = ranked.reason
  }
  // a forced engine never swaps; only auto falls back to the local ranking
  if (RERANK_KEYS[mode]) return { ok: false, attempted, reason: Object.values(skipped).at(-1), skipped }
  return localOutcome(query, pool, skipped, attempted)
}

function localOutcome(query, pool, skipped, attempted) {
  const local = orderLocally(query, pool)
  if (local.ok) return { ok: true, engine: 'bm25', ordered: local.ordered, ms: local.ms, skipped }
  return { ok: false, attempted, reason: Object.values(skipped).at(-1) ?? local.reason, skipped }
}

/** Below this many merged candidates there is nothing worth reordering. */
const MIN_RERANK = 5

export const name = 'academic-harness-literature-search'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'literature_search',
    description: [
      'One-shot multi-source literature discovery. Auto mode runs OpenAlex + Semantic Scholar and adds domain sources: with a TypeSafe key (TYPESAFE_API_KEY) Jev picks them from the query (non-English queries work) and the result lists `routing` and, when the query really asks for trials, datasets, patents, grants, a venue, one specific paper, news/product/regulation material, whether a claim is supported, or a retraction check, `suggested_tools`; without a key, or if Jev is slow or down, keyword rules pick them. The rules add PubMed for biomedical queries, arXiv for preprint/CS/physics queries, INSPIRE-HEP for high-energy physics, bioRxiv/medRxiv when a biomedical query asks for preprints, and ADS for astronomy only when ADS_API_TOKEN is set; Crossref, preprints, bioRxiv, DOAJ, publisher Crossref members, Scopus, Web of Science, Springer, and IEEE are also available explicitly, as are the keyed `consensus` (CONSENSUS_API_KEY), `scite` (SCITE_API_KEY; adds supporting/contrasting citation counts), `firecrawl` (FIRECRAWL_API_KEY; semantic search over PubMed, bioRxiv, medRxiv and arXiv) and `parallel` (PARALLEL_API_KEY; web results filtered to papers, with the DOI read from the URL when it has one). Results from every source are merged by identifier, so a paper found by several appears once. With a TypeSafe key (Jev) the top 30 merged candidates are then scored for relevance to the query in one request and listed in that order (each paper carries `relevance`); without a key, or if Jev is down, a local BM25 ranking fused with the source order is used instead (no key, no network). `rerank: "off"` keeps the plain fused order; `rerank: "cohere"` uses Cohere Rerank instead (COHERE_API_KEY).',
      'Results are deduplicated and rank-fused across sources (reciprocal-rank fusion), so use this when you want one clean discovery list instead of issuing the same query to several tools. Coverage is the top-N relevance slice per source, not exhaustive; use source-specific tools for filters, citation trails, or pagination.',
      'The `publishers` source searches publisher Crossref deposits keylessly; pass `publishers` aliases such as wiley, elsevier, springer, ieee, taylor_francis, sage, oup, cup, acm, acs, aps, iop, rsc, mdpi, frontiers, or plos. The keyed `springer`/`ieee` sources need SPRINGER_API_KEY/IEEE_API_KEY. Scopus and Web of Science are never auto-selected and need SCOPUS_API_KEY/WOS_API_KEY; without a key they return key_missing and make no request. Scopus/WoS records are metadata-only. Source-specific keys (OPENALEX_API_KEY, S2_API_KEY, CROSSREF_MAILTO) only raise limits; no key is required for the default auto sources.',
    ].join(' '),
    parameters: {
      query: { type: 'string', required: true, description: 'Natural-language discovery query.' },
      sources: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
        description: 'auto (default), or one/more of openalex, s2, pubmed, arxiv, crossref, preprints, biorxiv, inspire, ads, scopus, wos, doaj, publishers, springer, ieee, consensus, scite, firecrawl, parallel. Accepts an array or comma-separated string. Scopus/WoS/Springer/IEEE/consensus/scite/firecrawl/parallel are explicit-only and keyed; publishers is keyless.',
      },
      publishers: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'Publisher aliases for sources=publishers, e.g. ["plos","mdpi"] or "wiley,elsevier". Uses keyless Crossref member deposits.',
      },
      max_results: { type: 'number', description: 'Total unique results to return, 1-100. Default 20. This is a top-N slice, not exhaustive coverage.' },
      year_min: { type: 'number', description: 'Earliest publication year. Records with unknown years are kept.' },
      year_max: { type: 'number', description: 'Latest publication year. Records with unknown years are kept.' },
      open_access_only: { type: 'boolean', description: 'Only return records with an open-access link.' },
      include_abstracts: { type: 'boolean', description: 'Render abstract text in the result view. Default false.' },
      rerank: { type: 'string', description: 'auto (default), off, jev, cohere or bm25. Reorders the top merged candidates by relevance to the query. auto uses Jev when TYPESAFE_API_KEY is set and otherwise (or if Jev is slow or down) a local BM25 ranking fused with the source order, which needs no key and sends nothing anywhere; jev, cohere (COHERE_API_KEY) or bm25 forces that engine and never swaps silently; off keeps the plain fused order. Skipped in hint mode; with routing=rules only the local ranking runs. Jev and Cohere results carry `relevance` (comparable only within one search); the local ranking does not.' },
      routing: { type: 'string', description: 'auto (default) or rules. With sources=auto and a TypeSafe key, auto lets Jev choose the domain sources; rules forces the keyword rules and sends nothing to TypeSafe (no rerank either). Source routing is ignored when sources are listed explicitly.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      const query = String(args.query || '').trim()
      if (!query) return { error: 'query is required' }
      if (args.routing != null && !['auto', 'rules'].includes(args.routing)) {
        return { error: 'routing must be "auto" or "rules"' }
      }
      if (args.rerank != null && !['auto', 'off', 'jev', 'cohere', 'bm25'].includes(args.rerank)) {
        return { error: 'rerank must be "auto", "off", "jev", "cohere" or "bm25"' }
      }
      let sources
      let routing
      let suggestedTools
      try {
        const adsToken = await resolveEnv('ADS_API_TOKEN')
        const routed = await routeSources(query, args.sources, {
          adsToken: Boolean(adsToken),
          mode: args.routing || 'auto',
          signal: exec.signal,
        })
        ;({ sources, routing } = routed)
        suggestedTools = routed.suggested_tools
      } catch (error) {
        return { error: error.message }
      }
      if (sources.includes('publishers')) {
        const requested = normalizePublisherAliases(args.publishers)
        if (requested.unknown.length) {
          return { error: `unknown publisher(s): ${requested.unknown.join(', ')}; use ${PUBLISHER_ALIASES.join(', ')}` }
        }
        if (!requested.aliases.length) {
          return { error: 'publishers source needs a publishers array (or comma-separated list)' }
        }
        sources = sources.flatMap((source) => (
          source === 'publishers' ? requested.aliases.map((alias) => `publisher:${alias}`) : [source]
        ))
      }
      const warnings = []
      if (args.open_access_only && sources.includes('crossref')) {
        if (sources.length === 1) {
          return { error: 'open_access_only cannot be applied to Crossref; add another source or drop the filter' }
        }
        sources = sources.filter((source) => source !== 'crossref')
        warnings.push('Crossref skipped: its records do not carry open-access status.')
      }
      if (args.open_access_only) {
        const noOaInfo = sources.filter((source) => source === 'parallel' || source === 'firecrawl')
        if (noOaInfo.length === sources.length) {
          return { error: `open_access_only cannot be applied to ${noOaInfo.join(' or ')}; add another source or drop the filter` }
        }
        if (noOaInfo.length) {
          sources = sources.filter((source) => !noOaInfo.includes(source))
          warnings.push(`${noOaInfo.join(', ')} skipped: their records do not carry open-access status.`)
        }
      }
      const maxResults = Math.min(Math.max(Number(args.max_results) || 20, 1), 100)
      const yearMin = args.year_min != null && Number.isFinite(Number(args.year_min))
        ? Math.trunc(Number(args.year_min))
        : null
      const yearMax = args.year_max != null && Number.isFinite(Number(args.year_max))
        ? Math.trunc(Number(args.year_max))
        : null
      if (args.year_min != null && yearMin == null) return { error: 'year_min must be a number' }
      if (args.year_max != null && yearMax == null) return { error: 'year_max must be a number' }
      if (yearMin != null && yearMax != null && yearMin > yearMax) {
        return { error: 'year_min must not exceed year_max' }
      }

      const perSource = Math.min(maxResults, Math.max(10, Math.ceil(maxResults / sources.length) + 5))
      const settled = await Promise.allSettled(sources.map((source) => runWithDeadline(source, exec.signal, (signal) => runSource(source, {
        query,
        perSource,
        yearMin,
        yearMax,
        openAccessOnly: Boolean(args.open_access_only),
        signal,
      }))))

      const groups = []
      const failures = []
      const counts = {}
      settled.forEach((entry, index) => {
        const source = sources[index]
        if (entry.status === 'rejected') {
          failures.push({ source, error: entry.reason?.message || String(entry.reason) })
          return
        }
        const value = entry.value
        if (!value || value.error) {
          failures.push({
            source,
            error: value?.error || 'no result',
            ...(value?.code ? { code: value.code } : {}),
            ...(value?.field ? { field: value.field } : {}),
            ...(value?.retry_after_s != null ? { retry_after_s: value.retry_after_s } : {}),
          })
          return
        }
        const results = (value.results || [])
          .filter((paper) => withinYears(paper, yearMin, yearMax))
          .filter((paper) => !args.open_access_only || isOpen(paper))
        counts[source] = results.length
        if (results.length) groups.push({ source, results })
      })

      let merged = mergeRanked(groups)
      let rerank
      const rerankMode = args.rerank || 'auto'
      // routing=rules sends nothing to TypeSafe or Cohere: only the local ranking may run then
      const networkEngineUnderRules = args.routing === 'rules' && RERANK_KEYS[rerankMode]
      if (rerankMode !== 'off' && !networkEngineUnderRules && routing?.mode !== 'hint_only' && merged.length >= MIN_RERANK) {
        const pool = merged.slice(0, RERANK_POOL)
        const outcome = await rerankCandidates(query, pool, { mode: rerankMode, signal: exec.signal, localOnly: args.routing === 'rules' })
        if (outcome.ok) {
          const local = outcome.engine === 'bm25'
          // BM25 + RRF scores are not probabilities, so only Jev/Cohere results carry `relevance`
          const ordered = local ? outcome.ordered : orderByRelevance(pool, outcome.ranked.scores).map(({ paper, score }) => ({ ...paper, relevance: Number(score.toFixed(2)) }))
          merged = [...ordered, ...merged.slice(RERANK_POOL)]
          rerank = {
            engine: outcome.engine,
            model: local ? 'bm25+fused' : outcome.ranked.model,
            ms: local ? outcome.ms : outcome.ranked.ms,
            candidates: pool.length,
            ...(Object.keys(outcome.skipped).length ? { fallback_from: outcome.skipped } : {}),
          }
        } else if (outcome.attempted) {
          rerank = { engine: 'rrf', reason: outcome.reason }
        }
      }
      const papers = merged.slice(0, maxResults).map((paper) => ({
        ...paper,
        rrf_score: Number(paper.rrf_score.toFixed(5)),
      }))
      if (papers.some((paper) => paper.licence === 'restricted')) {
        warnings.push('Scopus/Web of Science records are metadata-only; abstracts and full text are not stored.')
      }
      const library = await markInLibrary(papers, exec)
      return {
        query,
        sources,
        routing: rerank ? { ...routing, rerank } : routing,
        ...(suggestedTools?.length ? { suggested_tools: suggestedTools } : {}),
        counts,
        warnings,
        failures,
        total_unique: merged.length,
        truncated: merged.length > papers.length,
        include_abstracts: Boolean(args.include_abstracts),
        ...(library ? { library } : {}),
        papers,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Literature search: ${args.query || ''}`, kind: 'search' }
    },
  }))
}
