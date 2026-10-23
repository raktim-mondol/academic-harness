/**
 * Elicit API v2 search (https://elicit.com/api/v2/search/{papers,trials}).
 *
 * Searches 138M+ papers or ClinicalTrials.gov records with study-type, year,
 * journal-quartile, and retraction filters. Requires ELICIT_API_KEY (Pro or
 * above). The API allows 100 requests/minute per IP, then blocks the IP for
 * five minutes, so calls are serialized and never retried automatically.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import {
  capText,
  fromElicitPaper,
  fromElicitTrial,
  renderPapers,
} from './search-normalize.js'

const API = 'https://elicit.com/api/v2/search'
const KINDS = ['papers', 'trials']
const SEARCH_MODES = ['semantic', 'keyword']
const CORPORA = ['elicit', 'pubmed']
const RETRACTED = ['exclude_retracted', 'include_retracted', 'only_retracted']
const TYPE_TAGS = ['Review', 'Meta-Analysis', 'Systematic Review', 'RCT', 'Longitudinal']
const PHASES = ['NA', 'EARLY_PHASE1', 'PHASE1', 'PHASE2', 'PHASE3', 'PHASE4']
const RECRUITMENT = [
  'ACTIVE_NOT_RECRUITING', 'COMPLETED', 'ENROLLING_BY_INVITATION', 'NOT_YET_RECRUITING',
  'RECRUITING', 'SUSPENDED', 'TERMINATED', 'WITHDRAWN', 'AVAILABLE',
]

function list(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry).trim()).filter(Boolean) : []
}

export function buildBody(args) {
  const kind = args.kind || 'papers'
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`)
  const query = String(args.query || '').trim()
  if (!query) throw new Error('query is required')
  const searchMode = args.search_mode || 'semantic'
  if (!SEARCH_MODES.includes(searchMode)) throw new Error(`search_mode must be one of ${SEARCH_MODES.join(', ')}`)

  const body = { query, searchMode }
  if (args.max_results != null) {
    const maxResults = Number(args.max_results)
    if (!Number.isFinite(maxResults) || maxResults < 1) throw new Error('max_results must be at least 1')
    if (maxResults > 1000) throw new Error('max_results accepts at most 1000 in this tool')
    body.maxResults = Math.floor(maxResults)
  }
  const integerArg = (value, name) => {
    const number = Number(value)
    if (!Number.isFinite(number)) throw new Error(`${name} must be a number`)
    return Math.floor(number)
  }

  if (kind === 'papers') {
    if (args.corpus) {
      if (!CORPORA.includes(args.corpus)) throw new Error(`corpus must be one of ${CORPORA.join(', ')}`)
      body.corpus = args.corpus
    }
    const filters = {}
    const include = list(args.include_keywords)
    if (include.length) filters.includeKeywords = include
    const exclude = list(args.exclude_keywords)
    if (exclude.length) filters.excludeKeywords = exclude
    if (args.has_pdf != null) filters.hasPdf = Boolean(args.has_pdf)
    if (args.pubmed_only != null) filters.pubmedOnly = Boolean(args.pubmed_only)
    if (args.min_year != null) filters.minYear = integerArg(args.min_year, 'min_year')
    if (args.max_year != null) filters.maxYear = integerArg(args.max_year, 'max_year')
    if (args.max_quartile != null) {
      const quartile = Math.floor(Number(args.max_quartile))
      if (!(quartile >= 1 && quartile <= 4)) throw new Error('max_quartile must be 1-4')
      filters.maxQuartile = quartile
    }
    if (args.retracted) {
      if (!RETRACTED.includes(args.retracted)) throw new Error(`retracted must be one of ${RETRACTED.join(', ')}`)
      filters.retracted = args.retracted
    }
    const tags = list(args.type_tags)
    if (tags.length) {
      const invalid = tags.find((tag) => !TYPE_TAGS.includes(tag))
      if (invalid) throw new Error(`unknown type tag "${invalid}"; use ${TYPE_TAGS.join(', ')}`)
      filters.typeTags = tags
    }
    if (Object.keys(filters).length) {
      if (searchMode === 'keyword') throw new Error('filters are not allowed with search_mode=keyword; put them in the query')
      body.filters = filters
    }
    return { endpoint: 'papers', body }
  }

  const trialFilters = {}
  if (args.has_results != null) trialFilters.hasResults = Boolean(args.has_results)
  const phases = list(args.phase)
  if (phases.length) {
    const invalid = phases.find((phase) => !PHASES.includes(phase))
    if (invalid) throw new Error(`unknown phase "${invalid}"; use ${PHASES.join(', ')}`)
    trialFilters.phase = phases
  }
  const statuses = list(args.recruitment_status)
  if (statuses.length) {
    const invalid = statuses.find((status) => !RECRUITMENT.includes(status))
    if (invalid) throw new Error(`unknown recruitment status "${invalid}"`)
    trialFilters.recruitmentStatus = statuses
  }
  if (Object.keys(trialFilters).length) {
    if (searchMode === 'keyword') throw new Error('trialFilters are not allowed with search_mode=keyword; put them in the query')
    body.trialFilters = trialFilters
  }
  return { endpoint: 'trials', body }
}

function renderWarnings(warnings) {
  if (!Array.isArray(warnings) || !warnings.length) return null
  const lines = warnings.slice(0, 5).map((warning) => `- ${warning.message || warning.warningDetails?.type || 'warning'}`)
  return `Warnings:\n${lines.join('\n')}`
}

function renderTrials(trials) {
  return trials.map((paper, i) => {
    const trial = paper.trial || {}
    const meta = [
      trial.nct_id,
      trial.overall_status,
      Array.isArray(trial.phase) && trial.phase.length ? trial.phase.join('/') : null,
      trial.enrollment_count != null ? `n=${trial.enrollment_count}` : null,
    ].filter(Boolean).join(' · ')
    const bits = [`${i + 1}. **${paper.title}**`]
    if (meta) bits.push(meta)
    if (paper.venue) bits.push(`Sponsor: ${paper.venue}`)
    if (paper.fields?.length) bits.push(`Conditions: ${paper.fields.join(', ')}`)
    if (trial.interventions?.length) bits.push(`Interventions: ${trial.interventions.join(', ')}`)
    if (paper.url) bits.push(paper.url)
    if (paper.abstract) bits.push(String(paper.abstract).slice(0, 500))
    return bits.join('\n')
  }).join('\n\n')
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const bits = []
  if (value.kind === 'trials') {
    bits.push(`Elicit trials: ${value.trials?.length ?? 0} result(s) for "${value.query}"`)
    bits.push(renderTrials(value.trials || []))
  } else {
    bits.push(`Elicit papers: ${value.papers?.length ?? 0} result(s) for "${value.query}"`)
    bits.push(renderPapers(value.papers || [], { abstractChars: 500 }))
  }
  const warningText = renderWarnings(value.warnings)
  if (warningText) bits.push(warningText)
  return [{ type: 'text', text: capText(bits.join('\n\n')) }]
}

export const name = 'academic-harness-elicit-search'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'elicit_search',
    description: [
      'Search Elicit\'s 138M+ paper index or ClinicalTrials.gov (kind=trials) with semantic or corpus-native keyword search.',
      'Paper filters: year range, journal quartile, study type tags (RCT, Meta-Analysis, Systematic Review, Review, Longitudinal), include/exclude keywords, PDF only, PubMed only, and retraction handling (excluded by default). Trial filters: phase, recruitment status, has results.',
      'Requires ELICIT_API_KEY (Pro or above). The API allows 100 requests/minute per IP and then blocks the IP for five minutes, so calls are serialized and not retried; do not fan out. filters and trialFilters are mutually exclusive with search_mode=keyword.',
    ].join(' '),
    parameters: {
      query: { type: 'string', required: true, description: 'Natural-language query, or corpus-native syntax in keyword mode.' },
      kind: { type: 'string', enum: KINDS, description: 'papers (default) or trials.' },
      search_mode: { type: 'string', enum: SEARCH_MODES, description: 'semantic (default) or keyword.' },
      max_results: { type: 'number', description: 'Results, 1-1000. Default 10; your plan caps this (Pro 300, Scale 500).' },
      corpus: { type: 'string', enum: CORPORA, description: 'Paper corpus: elicit (default) or pubmed.' },
      include_keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords that must appear.' },
      exclude_keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to exclude.' },
      has_pdf: { type: 'boolean', description: 'Only papers with an available PDF.' },
      pubmed_only: { type: 'boolean', description: 'Only papers from PubMed.' },
      min_year: { type: 'number', description: 'Earliest publication year.' },
      max_year: { type: 'number', description: 'Latest publication year.' },
      max_quartile: { type: 'number', description: 'Maximum journal quartile, 1 (best) to 4.' },
      retracted: { type: 'string', enum: RETRACTED, description: 'Retraction handling. Defaults to exclude_retracted.' },
      type_tags: { type: 'array', items: { type: 'string', enum: TYPE_TAGS }, description: 'Study-type filters.' },
      phase: { type: 'array', items: { type: 'string', enum: PHASES }, description: 'Trial phases (kind=trials).' },
      recruitment_status: { type: 'array', items: { type: 'string', enum: RECRUITMENT }, description: 'Trial recruitment statuses (kind=trials).' },
      has_results: { type: 'boolean', description: 'Only trials with posted results (kind=trials).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      let request
      try {
        request = buildBody(args)
      } catch (error) {
        return { error: error.message }
      }
      const apiKey = await resolveEnv('ELICIT_API_KEY')
      if (!apiKey) return { error: 'ELICIT_API_KEY is not set (Settings -> Academic Harness API keys, or the matching env var). ELICIT requires a Pro plan or above.' }

      const limiter = getLimiter('elicit', { minIntervalMs: 1000 })
      const result = await limiter.run(() => fetchJson(`${API}/${request.endpoint}`, {
        method: 'POST',
        retries: 0,
        signal: exec.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': searchUserAgent(),
        },
        body: JSON.stringify(request.body),
      }))
      if (!result.ok) {
        if (result.error === 'aborted') return { error: 'request cancelled' }
        const hint = result.status === 429
          ? ' — 100 requests/minute exceeded; the IP is blocked for 5 minutes'
          : ''
        return { error: `Elicit API error ${result.status}${hint}`, status: result.status, detail: result.detail ?? result.error }
      }
      const data = result.data && typeof result.data === 'object' ? result.data : {}
      const warnings = Array.isArray(data.warnings) ? data.warnings : []
      if (request.endpoint === 'trials') {
        const trials = (data.trials || []).map(fromElicitTrial).filter(Boolean)
        return { kind: 'trials', query: request.body.query, trials, warnings }
      }
      const papers = (data.papers || []).map(fromElicitPaper).filter(Boolean)
      return { kind: 'papers', query: request.body.query, papers, warnings }
    },
    presentCall(args) {
      return { card: 'generic', title: `Elicit (${args.kind || 'papers'}): ${args.query || ''}`, kind: 'search' }
    },
  }))
}
