/**
 * Consensus's `GET /v1/search` REST API (https://docs.consensus.app/api-reference/query-for-relevant-papers) —
 * `x-api-key` auth, no OAuth. Registered as a preset row (not global) since
 * it's specifically an academic-search capability, alongside the Parallel/
 * Firecrawl/Scite MCP connectors in mcp-connectors.js. Resolves the key via
 * resolveEnv() per call (like image_generate/modal_run/runpod_run), so a key
 * saved in Settings takes effect on the very next call — no restart needed.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'

const STUDY_TYPES = [
  'bench experiment', 'case report', 'case study', 'case-control study', 'cohort study',
  'commentary or perspective', 'cross-sectional study', 'field study',
  'historical or archival analysis', 'interview study', 'literature review',
  'longitudinal / panel data study', 'meta-analysis', 'mixed methods study',
  'non-randomized experimental study', 'non-rct in vitro', 'other', 'rct',
  'systematic review', 'theoretical, modeling, or simulation study',
  'non-rct experimental', 'non-rct observational study', 'animal',
]

const DOMAINS = [
  'med', 'bio', 'cs', 'chem', 'psych', 'phys', 'mat', 'eng', 'env', 'bus', 'econ',
  'math', 'poli', 'agri', 'edu', 'soc', 'geol', 'geog', 'hist', 'art', 'philo', 'law', 'ling',
]

const API_URL = 'https://api.consensus.app/v1/search'

function buildQuery(args) {
  const params = new URLSearchParams()
  params.set('query', args.query)
  const scalar = [
    'year_min', 'year_max', 'month_min', 'month_max', 'human', 'controlled',
    'sample_size_min', 'sjr_min', 'sjr_max', 'citation_min', 'duration_min',
    'duration_max', 'exclude_preprints', 'open_access', 'journal_name',
    'clinical_guideline', 'medical_mode', 'page', 'page_size',
  ]
  for (const key of scalar) {
    if (args[key] !== undefined && args[key] !== null) params.set(key, String(args[key]))
  }
  if (Array.isArray(args.study_types)) {
    for (const t of args.study_types) params.append('study_types', t)
  }
  for (const key of ['domain', 'country', 'publisher_name']) {
    const value = args[key]
    if (Array.isArray(value) && value.length) params.set(key, value.join(','))
    else if (typeof value === 'string' && value.trim()) params.set(key, value.trim())
  }
  return params
}

function renderResult(r) {
  const bits = [`**${r.title}**`]
  const meta = [r.journal_name, r.publish_year, r.study_type].filter(Boolean).join(' · ')
  if (meta) bits.push(meta)
  if (r.takeaway) bits.push(r.takeaway)
  if (r.citation_count !== undefined) bits.push(`${r.citation_count} citations`)
  if (r.doi) bits.push(`doi: ${r.doi}`)
  if (r.url) bits.push(r.url)
  return bits.join('\n')
}

function render(value) {
  if (value.error) {
    return [{ type: 'text', text: `Error: ${value.error}` }]
  }
  if (!Array.isArray(value.results) || value.results.length === 0) {
    return [{ type: 'text', text: 'No results.' }]
  }
  const lines = value.results.map((r, i) => `${i + 1}. ${renderResult(r)}`)
  if (!value.is_end) lines.push(`_(more results available — page ${value.page + 1})_`)
  return [{ type: 'text', text: lines.join('\n\n') }]
}

export const name = 'academic-harness-consensus-search'
export const inject = ['tools']

/** Register the Consensus literature-search tool. */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'consensus_search',
    description: [
      'Search 220M+ peer-reviewed papers via the Consensus API — evidence-backed answers over the academic literature,',
      'with real filters (study type, year, sample size, journal quartile, domain, human/controlled/open-access, …).',
      'Requires CONSENSUS_API_KEY (Settings -> Academic Harness API keys, or env). For peer-reviewed literature, use this',
      'alongside parallel_search with mode basic or advanced (not instead of it, and not mcp__parallel__web_search unless',
      'parallel_search failed) — this tool is the filterable structured paper index with per-paper takeaways;',
      'parallel_search covers multi-hop web + literature excerpts. Prefer both over built-in web_search / mcp__firecrawl__*',
      'for finding papers.',
    ].join(' '),
    parameters: {
      query: { type: 'string', required: true, description: 'Search query for research papers.' },
      year_min: { type: 'number', description: 'Exclude papers before this year.' },
      year_max: { type: 'number', description: 'Exclude papers after this year.' },
      month_min: { type: 'number', description: 'Exclude papers before this month within year_min (1-12). Requires year_min.' },
      month_max: { type: 'number', description: 'Exclude papers after this month within year_max (1-12). Requires year_max.' },
      study_types: {
        type: 'array',
        items: { type: 'string', enum: STUDY_TYPES },
        description: 'Only include these study types.',
      },
      human: { type: 'boolean', description: 'Only include human studies.' },
      controlled: { type: 'boolean', description: 'Only include controlled studies.' },
      sample_size_min: { type: 'number', description: 'Exclude studies with smaller sample sizes.' },
      sjr_min: { type: 'number', description: 'Journal quartile floor, 1 (best) to 4.' },
      sjr_max: { type: 'number', description: 'Journal quartile ceiling, 1 (best) to 4.' },
      citation_min: { type: 'number', description: 'Exclude papers with fewer citations.' },
      duration_min: { type: 'number', description: 'Minimum study duration in days.' },
      duration_max: { type: 'number', description: 'Maximum study duration in days.' },
      exclude_preprints: { type: 'boolean', description: 'Only include peer-reviewed papers.' },
      open_access: { type: 'boolean', description: 'Only include open-access papers.' },
      publisher_name: { type: 'string', description: 'Comma-separated publisher display names to filter by.' },
      domain: {
        type: 'array',
        items: { type: 'string', enum: DOMAINS },
        description: 'Academic field short codes to filter by.',
      },
      country: { type: 'string', description: 'Comma-separated ISO 3166-1 alpha-2 country codes to filter to those countries of study.' },
      journal_name: { type: 'string', description: 'Preferred journal (e.g. "Nature") — boosts ranking, does not exclude others.' },
      clinical_guideline: { type: 'boolean', description: 'Filter to papers classified as clinical guidelines.' },
      medical_mode: { type: 'boolean', description: 'Filter to top medical journals and guidelines.' },
      page: { type: 'number', description: 'Zero-indexed result page (0-49). Default 0.' },
      page_size: { type: 'number', description: 'Results per page. Default 20, capped by plan.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args) {
      const key = await resolveEnv('CONSENSUS_API_KEY')
      if (!key) {
        return { error: 'CONSENSUS_API_KEY is not set (Settings -> Academic Harness API keys, or the matching env var).' }
      }
      const params = buildQuery(args)
      const res = await fetch(`${API_URL}?${params}`, { headers: { 'x-api-key': key } })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        return { error: `Consensus API error ${res.status}`, status: res.status, detail: body.detail ?? body }
      }
      return body
    },
    presentCall(args) {
      return { card: 'generic', title: `Consensus: ${args.query ?? ''}`, kind: 'search' }
    },
  }))
}
