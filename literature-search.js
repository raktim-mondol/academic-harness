/**
 * literature_search: one-shot multi-source discovery.
 *
 * Auto mode runs OpenAlex + Semantic Scholar, adding PubMed for biomedical
 * queries and arXiv for preprint/CS/physics queries. Crossref is opt-in (its
 * relevance ranking is noisy). Results are deduplicated across sources and
 * fused with reciprocal-rank fusion, so a paper found high in two indexes
 * outranks a paper found once.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { capText, mergeRanked, renderPapers } from './search-normalize.js'
import { runOpenAlexSearch } from './openalex-search.js'
import { runS2Search } from './semantic-scholar-search.js'
import { runPubMedSearch } from './pubmed-search.js'
import { runArxivSearch } from './arxiv-search.js'
import { runCrossrefQuery } from './crossref-lookup.js'
import { libraryLaunch, libraryResolve } from './papermemory-library.js'

const ALLOWED = ['openalex', 's2', 'pubmed', 'arxiv', 'crossref', 'preprints']
const BIOMEDICAL = /\b(clinic|clinical|patient|patients|trial|trials|disease|therapy|therapies|treatment|cancer|tumou?r|gene|genes|genetic|protein|proteins|cell|cells|drug|drugs|medical|medicine|health|epidemi\w*|cohort|rct|surgery|surgical|diagnos\w*|psychiatr\w*|neuron\w*|biolog\w*|immun\w*|infect\w*|virus|viral|vaccine|malaria|diabetes|alzheimer|parkinson|cardio\w*|oncology)\b/i
const PREPRINT = /\b(arxiv|preprints?|neural|machine learning|deep learning|transformer|transformers|llm|llms|language model|computer vision|algorithm|algorithms|quantum|physics|astrophysic\w*|cosmolog\w*|particle|mathematic\w*|theorem|robot\w*|reinforcement learning|dataset|benchmark|computational)\b/i
const ASKS_FOR_PREPRINTS = /\b(preprints?|biorxiv|medrxiv)\b/i
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

export function chooseSources(query, requested) {
  const explicit = parseSources(requested)
  if (explicit) return explicit
  const sources = ['openalex', 's2']
  if (BIOMEDICAL.test(query)) sources.push('pubmed')
  if (PREPRINT.test(query)) sources.push('arxiv')
  if (BIOMEDICAL.test(query) && ASKS_FOR_PREPRINTS.test(query)) sources.push('preprints')
  return sources
}

async function runSource(source, { query, perSource, yearMin, yearMax, openAccessOnly, signal }) {
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
        query: openAccessOnly ? `(${query}) AND OPEN_ACCESS:y` : query,
        source: 'europepmc',
        preprints: true,
        max_results: Math.min(perSource, 100),
      }, { signal })
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
    default:
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

export const name = 'academic-harness-literature-search'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'literature_search',
    description: [
      'One-shot multi-source literature discovery. Auto mode runs OpenAlex + Semantic Scholar, adding PubMed for biomedical queries, arXiv for preprint/CS/physics queries, and Europe PMC preprints (SRC:PPR) when a biomedical query asks for preprints; Crossref and preprints are also available explicitly.',
      'Results are deduplicated and rank-fused across sources (reciprocal-rank fusion), so use this when you want one clean discovery list instead of issuing the same query to several tools. Coverage is the top-N relevance slice per source, not exhaustive; use source-specific tools for filters, citation trails, or pagination.',
      'Optional year range and open_access_only filters. source-specific keys (OPENALEX_API_KEY, S2_API_KEY, CROSSREF_MAILTO) only raise limits; no key is required for the default auto sources.',
    ].join(' '),
    parameters: {
      query: { type: 'string', required: true, description: 'Natural-language discovery query.' },
      sources: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
        description: 'auto (default), or one/more of openalex, s2, pubmed, arxiv, crossref, preprints. Accepts an array or comma-separated string.',
      },
      max_results: { type: 'number', description: 'Total unique results to return, 1-100. Default 20. This is a top-N slice, not exhaustive coverage.' },
      year_min: { type: 'number', description: 'Earliest publication year. Records with unknown years are kept.' },
      year_max: { type: 'number', description: 'Latest publication year. Records with unknown years are kept.' },
      open_access_only: { type: 'boolean', description: 'Only return records with an open-access link.' },
      include_abstracts: { type: 'boolean', description: 'Render abstract text in the result view. Default false.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      const query = String(args.query || '').trim()
      if (!query) return { error: 'query is required' }
      let sources
      try {
        sources = chooseSources(query, args.sources)
      } catch (error) {
        return { error: error.message }
      }
      const warnings = []
      if (args.open_access_only && sources.includes('crossref')) {
        if (sources.length === 1) {
          return { error: 'open_access_only cannot be applied to Crossref; add another source or drop the filter' }
        }
        sources = sources.filter((source) => source !== 'crossref')
        warnings.push('Crossref skipped: its records do not carry open-access status.')
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
      const settled = await Promise.allSettled(sources.map((source) => runSource(source, {
        query,
        perSource,
        yearMin,
        yearMax,
        openAccessOnly: Boolean(args.open_access_only),
        signal: exec.signal,
      })))

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
          failures.push({ source, error: value?.error || 'no result' })
          return
        }
        const results = (value.results || [])
          .filter((paper) => withinYears(paper, yearMin, yearMax))
          .filter((paper) => !args.open_access_only || isOpen(paper))
        counts[source] = results.length
        if (results.length) groups.push({ source, results })
      })

      const merged = mergeRanked(groups)
      const papers = merged.slice(0, maxResults).map((paper) => ({
        ...paper,
        rrf_score: Number(paper.rrf_score.toFixed(5)),
      }))
      const library = await markInLibrary(papers, exec)
      return {
        query,
        sources,
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
