/**
 * clinicaltrials: ClinicalTrials.gov API v2 (https://clinicaltrials.gov/api/v2).
 *
 * Trials and posted results, not literature search: use it for protocols,
 * eligibility, endpoints, results, and adverse events. No key.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'

const API = 'https://clinicaltrials.gov/api/v2/studies'
const PHASES = ['EARLY_PHASE1', 'PHASE1', 'PHASE2', 'PHASE3', 'PHASE4', 'NA']
const STATUSES = [
  'RECRUITING', 'NOT_YET_RECRUITING', 'ENROLLING_BY_INVITATION', 'ACTIVE_NOT_RECRUITING',
  'SUSPENDED', 'TERMINATED', 'COMPLETED', 'WITHDRAWN', 'UNKNOWN',
]
const STUDY_TYPES = ['INTERVENTIONAL', 'OBSERVATIONAL', 'EXPANDED_ACCESS']
const FIELDS = [
  'NCTId', 'Acronym', 'BriefTitle', 'OfficialTitle', 'OverallStatus', 'Phase', 'StudyType',
  'EnrollmentInfo', 'StartDate', 'CompletionDate', 'LeadSponsor', 'Condition', 'Intervention',
  'PrimaryOutcomeMeasure', 'SecondaryOutcomeMeasure', 'Location', 'HasResults',
].join(',')

function stringList(value) {
  if (value == null) return []
  return (Array.isArray(value) ? value : [value]).map((item) => String(item).trim()).filter(Boolean)
}

function normalizeEnum(value, allowed, label) {
  const names = stringList(value).map((item) => item.toUpperCase().replace(/[\s-]+/g, '_'))
  const bad = names.filter((name) => !allowed.includes(name))
  if (bad.length) throw new Error(`${label} must be one of ${allowed.join(', ')} (got ${bad.join(', ')})`)
  return names
}

function outcomeList(list) {
  return (Array.isArray(list) ? list : []).map((outcome) => {
    const measure = String(outcome?.measure || '').trim()
    const frame = String(outcome?.timeFrame || '').trim()
    if (!measure) return null
    return frame ? `${measure} (${frame})` : measure
  }).filter(Boolean)
}

export function normalizeStudy(study, { includeResults = false } = {}) {
  const protocol = study?.protocolSection || {}
  const identification = protocol.identificationModule || {}
  const status = protocol.statusModule || {}
  const design = protocol.designModule || {}
  const sponsor = protocol.sponsorCollaboratorsModule?.leadSponsor || null
  const nctId = identification.nctId || null
  const locations = (protocol.contactsLocationsModule?.locations || []).slice(0, 10).map((location) => ({
    facility: location.facility || null,
    city: location.city || null,
    state: location.state || null,
    country: location.country || null,
  }))
  const normalized = {
    nct_id: nctId,
    title: identification.briefTitle || identification.officialTitle || null,
    acronym: identification.acronym || null,
    status: status.overallStatus || null,
    study_type: design.studyType || null,
    phase: stringList(design.phases),
    enrollment: design.enrollmentInfo
      ? { count: design.enrollmentInfo.count ?? null, type: design.enrollmentInfo.type || null }
      : null,
    start_date: status.startDateStruct?.date || null,
    completion_date: status.completionDateStruct?.date || null,
    sponsor: sponsor?.name || null,
    conditions: stringList(protocol.conditionsModule?.conditions),
    interventions: (protocol.armsInterventionsModule?.interventions || []).slice(0, 10).map((item) => ({
      type: item.type || null,
      name: item.name || null,
    })).filter((item) => item.name),
    primary_outcomes: outcomeList(protocol.outcomesModule?.primaryOutcomes),
    secondary_outcomes: outcomeList(protocol.outcomesModule?.secondaryOutcomes),
    locations,
    has_results: study?.hasResults === true,
    url: nctId ? `https://clinicaltrials.gov/study/${nctId}` : null,
  }
  if (includeResults) normalized.posted_results = summarizeResults(study?.resultsSection)
  return normalized
}

export function summarizeResults(section) {
  if (!section) return null
  const outcomes = (section.outcomeMeasuresModule?.outcomeMeasures || []).map((outcome) => ({
    type: outcome.type || null,
    title: outcome.title || null,
    unit: outcome.unitOfMeasure || null,
    time_frame: outcome.timeFrame || null,
    reporting_status: outcome.reportingStatus || null,
  }))
  const adverse = section.adverseEventsModule
  return {
    outcomes,
    adverse_events: adverse
      ? {
        frequency_threshold: adverse.frequencyThreshold || null,
        groups: (adverse.eventGroups || []).map((group) => group.title).filter(Boolean),
        serious_events: (adverse.seriousEvents || []).length,
        other_events: (adverse.otherEvents || []).length,
      }
      : null,
  }
}

function searchUrl(args) {
  const params = new URLSearchParams({ fields: FIELDS })
  if (args.query) params.set('query.term', String(args.query).trim())
  if (args.condition) params.set('query.cond', String(args.condition).trim())
  if (args.intervention) params.set('query.intr', String(args.intervention).trim())
  const phases = normalizeEnum(args.phase, PHASES, 'phase')
  const statuses = normalizeEnum(args.status, STATUSES, 'status')
  const studyTypes = normalizeEnum(args.study_type, STUDY_TYPES, 'study_type')
  // v2 has no filter.phase/filter.studyType; those live in Essie expressions.
  const advanced = []
  if (phases.length) advanced.push(`AREA[Phase](${phases.join(' OR ')})`)
  if (studyTypes.length) advanced.push(`AREA[StudyType](${studyTypes.join(' OR ')})`)
  if (advanced.length) params.set('filter.advanced', advanced.join(' AND '))
  if (statuses.length) params.set('filter.overallStatus', statuses.join(','))
  params.set('pageSize', String(Math.min(Math.max(Number(args.page_size) || 20, 1), 100)))
  if (args.page_token) params.set('pageToken', String(args.page_token).trim())
  return `${API}?${params}`
}

function errorOf(result, hint = '') {
  if (result.error === 'aborted') return 'request cancelled'
  return `ClinicalTrials.gov API error ${result.status}${hint}${result.detail ? `: ${result.detail}` : ''}`
}

export async function runClinicalTrials(args, exec, deps = {}) {
  const http = deps.fetchJson || fetchJson
  const limiter = getLimiter('clinicaltrials', { minIntervalMs: 500 })
  const action = args.action || 'search'
  if (!['search', 'get'].includes(action)) return { error: 'action must be search or get' }

  if (action === 'get') {
    const nctId = String(args.nct_id || '').trim().toUpperCase()
    if (!/^NCT\d{8}$/.test(nctId)) return { error: 'nct_id must look like NCT12345678' }
    const params = new URLSearchParams()
    if (!args.include_results) params.set('fields', FIELDS)
    const query = params.toString()
    const result = await limiter.run(() => http(`${API}/${nctId}${query ? `?${query}` : ''}`, {
      signal: exec?.signal,
      headers: { 'User-Agent': searchUserAgent() },
    }))
    if (!result.ok) {
      if (result.status === 404) return { error: `trial ${nctId} not found`, status: 404 }
      return { error: errorOf(result) }
    }
    return normalizeStudy(result.data, { includeResults: Boolean(args.include_results) })
  }

  if (!args.query && !args.condition && !args.intervention) {
    return { error: 'give a query, condition, or intervention for search' }
  }
  let url
  try {
    url = searchUrl(args)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  const result = await limiter.run(() => http(url, {
    signal: exec?.signal,
    headers: { 'User-Agent': searchUserAgent() },
  }))
  if (!result.ok) {
    const hint = result.status === 429 ? ' (rate limited; wait and retry)' : ''
    return { error: errorOf(result, hint) }
  }
  const studies = (result.data?.studies || []).map((study) => normalizeStudy(study))
  return {
    total_returned: studies.length,
    next_page_token: result.data?.nextPageToken || null,
    results: studies,
  }
}

function renderTrial(trial, index) {
  const meta = [
    trial.status,
    trial.phase?.length ? trial.phase.join('/') : null,
    trial.study_type,
    trial.enrollment?.count != null ? `${trial.enrollment.count} enrolled` : null,
  ].filter(Boolean).join(' · ')
  const lines = [`${index ? `${index}. ` : ''}**${trial.nct_id || 'NCT?'} — ${trial.title || '(untitled)'}**`]
  if (meta) lines.push(`   ${meta}`)
  if (trial.sponsor) lines.push(`   Sponsor: ${trial.sponsor}`)
  if (trial.conditions.length) lines.push(`   Conditions: ${trial.conditions.join('; ')}`)
  if (trial.url) lines.push(`   ${trial.url}`)
  return lines.join('\n')
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (value.results) {
    const header = `${value.total_returned} trial(s)${value.next_page_token ? ` · next_page_token: ${value.next_page_token}` : ''}`
    const body = value.results.map((trial, index) => renderTrial(trial, index + 1)).join('\n\n') || 'No trials matched.'
    return [{ type: 'text', text: `${header}\n\n${body}` }]
  }
  const lines = [renderTrial(value, 0)]
  if (value.primary_outcomes.length) lines.push(`   Primary outcomes: ${value.primary_outcomes.join(' | ')}`)
  if (value.secondary_outcomes.length) lines.push(`   Secondary outcomes: ${value.secondary_outcomes.join(' | ')}`)
  if (value.interventions.length) {
    lines.push(`   Interventions: ${value.interventions.map((item) => `${item.type ? `${item.type}: ` : ''}${item.name}`).join('; ')}`)
  }
  if (value.locations.length) {
    const first = value.locations[0]
    const more = value.locations.length > 1 ? ` (+${value.locations.length - 1} more)` : ''
    lines.push(`   Locations: ${[first.facility, first.city, first.country].filter(Boolean).join(', ')}${more}`)
  }
  if (value.has_results) lines.push('   Results: posted')
  if (value.posted_results) {
    if (value.posted_results.outcomes.length) {
      lines.push('', 'Posted results:')
      for (const outcome of value.posted_results.outcomes) {
        lines.push(`- ${outcome.type || 'OUTCOME'} · ${outcome.title || '(untitled)'}${outcome.unit ? ` (${outcome.unit})` : ''}${outcome.reporting_status ? ` · ${outcome.reporting_status}` : ''}`)
      }
    }
    if (value.posted_results.adverse_events) {
      const adverse = value.posted_results.adverse_events
      lines.push(`- Adverse events: ${adverse.serious_events} serious, ${adverse.other_events} other${adverse.frequency_threshold ? ` (threshold ${adverse.frequency_threshold})` : ''}`)
    }
  } else if (value.has_results) {
    lines.push('   (pass include_results: true to read the posted outcome measures)')
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

export const name = 'academic-harness-clinicaltrials'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'clinicaltrials',
    description: [
      'Search ClinicalTrials.gov (API v2) for trials and read posted results: status, phase, enrollment, sponsor, conditions, interventions, endpoints, locations, and outcome measures.',
      '`search` filters by free text (`query`), `condition`, `intervention`, `phase`, `status`, and `study_type`, and returns a `next_page_token`. `get` reads one trial by NCT id; set `include_results: true` for posted outcome measures and adverse-event counts.',
      'Free and keyless. Use trial records and NCT ids as evidence for protocols, eligibility, endpoints, and safety — not as a substitute for a literature review. Informational only: it is not medical advice.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ['search', 'get'], description: 'search (default) or get one trial.' },
      query: { type: 'string', description: 'Free-text search (query.term), e.g. "semaglutide cardiovascular".' },
      condition: { type: 'string', description: 'Condition/disease filter (query.cond).' },
      intervention: { type: 'string', description: 'Intervention/drug filter (query.intr).' },
      phase: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: `Trial phase(s): ${PHASES.join(', ')}.`,
      },
      status: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: `Overall status filter: ${STATUSES.join(', ')}.`,
      },
      study_type: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: `Study type: ${STUDY_TYPES.join(', ')}.`,
      },
      page_size: { type: 'number', description: 'Results per page, 1-100. Default 20.' },
      page_token: { type: 'string', description: 'next_page_token from a previous response.' },
      nct_id: { type: 'string', description: 'NCT id such as NCT12345678 (get).' },
      include_results: { type: 'boolean', description: 'Include posted results (outcome measures, adverse events) on get.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      return runClinicalTrials(args, exec)
    },
    presentCall(args) {
      const label = args.nct_id || args.query || args.condition || args.intervention || ''
      return { card: 'generic', title: `ClinicalTrials: ${label}`, kind: 'search' }
    },
  }))
}
