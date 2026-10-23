/**
 * grant_search: funded-project discovery across NIH RePORTER, NSF Award
 * Search, and Grants.gov. Informational only — not grant-writing or legal
 * advice, and not a substitute for a literature review.
 *
 * Optional tool: registers only with AH_ENABLE_OPTIONAL_TOOLS=1.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { optionalToolsEnabled } from './optional-tools.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'

const FUNDERS = ['nih', 'nsf', 'grantsgov']
const NIH = 'https://api.reporter.nih.gov/v2/projects/search'
const NSF = 'https://api.nsf.gov/services/v1/awards'
const GRANTS_GOV = 'https://api.grants.gov/v1/api'

function cap(value, chars = 600) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > chars ? `${text.slice(0, chars).trimEnd()}…` : text
}

function isoDate(value) {
  const text = String(value || '').trim()
  const us = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (us) return `${us[3]}-${us[1]}-${us[2]}`
  return text ? text.slice(0, 10) : null
}

function errorOf(result, label) {
  if (result.error === 'aborted') return 'request cancelled'
  return `${label} API error ${result.status}${result.detail ? `: ${result.detail}` : ''}`
}

function normalizeNih(project) {
  return {
    funder: 'nih',
    award_id: project.project_num || null,
    title: project.project_title || null,
    pi: project.contact_pi_name || null,
    organization: project.organization?.org_name || null,
    amount: project.award_amount ?? null,
    start_date: isoDate(project.project_start_date),
    end_date: isoDate(project.project_end_date),
    abstract: cap(project.abstract_text),
    institute: project.agency_ic_admin?.abbreviation || null,
    url: project.appl_id ? `https://reporter.nih.gov/project-details/${project.appl_id}` : null,
  }
}

export function normalizeNsf(award) {
  return {
    funder: 'nsf',
    award_id: award.id || null,
    title: award.title || null,
    pi: [award.piFirstName, award.piLastName].filter(Boolean).join(' ') || award.pdPIName || null,
    organization: award.awardeeName || null,
    amount: award.estimatedTotalAmt != null ? Number(award.estimatedTotalAmt) : null,
    start_date: isoDate(award.startDate),
    end_date: isoDate(award.expDate),
    abstract: cap(award.abstractText),
    program: award.fundProgramName || null,
    url: award.id ? `https://www.nsf.gov/awardsearch/showAward?AWD_ID=${award.id}` : null,
  }
}

export function normalizeGrantsGov(hit, detail = null) {
  const synopsis = detail?.synopsis || {}
  const agency = hit?.agency || detail?.agencyDetails?.agencyName || synopsis.agencyName || null
  const id = hit?.id || detail?.id || null
  return {
    funder: 'grantsgov',
    award_id: hit?.number || detail?.opportunityNumber || null,
    title: hit?.title || detail?.opportunityTitle || null,
    agency,
    status: hit?.oppStatus || null,
    open_date: isoDate(hit?.openDate || synopsis.postDate),
    close_date: isoDate(hit?.closeDate || synopsis.closeDate || synopsis.responseDate),
    amount_ceiling: synopsis.awardCeiling != null ? Number(synopsis.awardCeiling) : null,
    amount_floor: synopsis.awardFloor != null ? Number(synopsis.awardFloor) : null,
    abstract: cap(synopsis.synopsisDesc),
    url: id ? `https://www.grants.gov/search-results-detail/${id}` : null,
  }
}

async function searchNih(args, { signal, http, limit }) {
  const criteria = {}
  if (String(args.query || '').trim()) criteria.text_search = String(args.query).trim()
  if (String(args.pi || '').trim()) criteria.pi_names = [{ last_name: String(args.pi).trim() }]
  if (String(args.org || '').trim()) criteria.org_names = [String(args.org).trim()]
  if (args.fiscal_year) criteria.fiscal_years = [Number(args.fiscal_year)]
  const body = {
    criteria,
    include_fields: [
      'ProjectNum', 'ApplId', 'ProjectTitle', 'ContactPiName', 'Organization', 'AwardAmount',
      'ProjectStartDate', 'ProjectEndDate', 'AbstractText', 'AgencyIcAdmin',
    ],
    offset: 0,
    limit,
  }
  if (!Object.keys(criteria).length) return { error: 'give query, pi, org, or fiscal_year for an NIH search' }
  const result = await http(NIH, {
    signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': searchUserAgent() },
    body: JSON.stringify(body),
    timeoutMs: 30_000,
    retries: 1,
  })
  if (!result.ok) return { error: errorOf(result, 'NIH RePORTER') }
  const results = (result.data?.results || []).map(normalizeNih)
  return { total: result.data?.meta?.total ?? results.length, results }
}

async function searchNsf(args, { signal, http, limit }) {
  const params = new URLSearchParams({ rpp: String(limit) })
  if (String(args.query || '').trim()) params.set('keyword', `"${String(args.query).trim()}"`)
  if (String(args.pi || '').trim()) params.set('piLastName', String(args.pi).trim())
  if (String(args.org || '').trim()) params.set('awardeeName', String(args.org).trim())
  if (args.fiscal_year) {
    const year = Number(args.fiscal_year)
    params.set('startDateStart', `01/01/${year}`)
    params.set('startDateEnd', `12/31/${year}`)
  }
  if (![...params.keys()].some((key) => ['keyword', 'piLastName', 'awardeeName', 'startDateStart'].includes(key))) {
    return { error: 'give query, pi, org, or fiscal_year for an NSF search' }
  }
  const result = await http(`${NSF}.json?${params}`, { signal, headers: { 'User-Agent': searchUserAgent() }, timeoutMs: 30_000, retries: 1 })
  if (!result.ok) return { error: errorOf(result, 'NSF') }
  const awards = result.data?.response?.award || []
  const results = awards.map(normalizeNsf)
  return { total: results.length, results }
}

async function searchGrantsGov(args, { signal, http, limit }) {
  const keyword = String(args.query || '').trim()
  if (!keyword) return { error: 'Grants.gov search needs a query keyword (it indexes opportunities, not awards)' }
  const result = await http(`${GRANTS_GOV}/search2`, {
    signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': searchUserAgent() },
    body: JSON.stringify({ keyword, rows: limit, startRecordNum: 0, oppStatuses: 'forecasted|posted' }),
    timeoutMs: 30_000,
    retries: 1,
  })
  if (!result.ok) return { error: errorOf(result, 'Grants.gov') }
  if (result.data?.errorcode) return { error: `Grants.gov: ${result.data.msg || `error ${result.data.errorcode}`}` }
  const hits = result.data?.data?.oppHits || []
  let results = hits.map((hit) => normalizeGrantsGov(hit))
  if (args.fiscal_year) {
    const year = String(args.fiscal_year)
    results = results.filter((entry) => (entry.open_date || '').startsWith(year) || (entry.close_date || '').startsWith(year))
  }
  return { total: result.data?.data?.hitCount ?? results.length, results }
}

export async function runGrantSearch(args, exec, deps = {}) {
  const http = deps.fetchJson || fetchJson
  const action = args.action || 'search'
  const funder = String(args.funder || '').trim().toLowerCase()
  if (!FUNDERS.includes(funder)) return { error: `funder must be one of ${FUNDERS.join(', ')}` }
  if (!['search', 'get'].includes(action)) return { error: 'action must be search or get' }
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 100)
  const shared = { signal: exec?.signal, http, limit }

  if (action === 'get') {
    const awardId = String(args.award_id || '').trim()
    if (!awardId) return { error: 'award_id is required for get' }
    if (funder === 'nih') {
      const result = await http(NIH, {
        signal: exec?.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': searchUserAgent() },
        body: JSON.stringify({
          criteria: { project_nums: [awardId] },
          include_fields: ['ProjectNum', 'ApplId', 'ProjectTitle', 'ContactPiName', 'Organization', 'AwardAmount', 'ProjectStartDate', 'ProjectEndDate', 'AbstractText', 'AgencyIcAdmin'],
          limit: 1,
        }),
        timeoutMs: 30_000,
        retries: 1,
      })
      if (!result.ok) return { error: errorOf(result, 'NIH RePORTER') }
      const project = result.data?.results?.[0]
      return project ? { award: normalizeNih(project) } : { error: `NIH project not found: ${awardId}` }
    }
    if (funder === 'nsf') {
      const result = await http(`${NSF}/${encodeURIComponent(awardId)}.json`, { signal: exec?.signal, headers: { 'User-Agent': searchUserAgent() }, timeoutMs: 30_000, retries: 1 })
      if (!result.ok) return { error: errorOf(result, 'NSF') }
      const award = result.data?.response?.award?.[0]
      return award ? { award: normalizeNsf(award) } : { error: `NSF award not found: ${awardId}` }
    }
    const result = await http(`${GRANTS_GOV}/fetchOpportunity`, {
      signal: exec?.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': searchUserAgent() },
      body: JSON.stringify({ opportunityId: Number(awardId) }),
      timeoutMs: 30_000,
      retries: 1,
    })
    if (!result.ok) return { error: errorOf(result, 'Grants.gov') }
    if (result.data?.errorcode) return { error: `Grants.gov: ${result.data.msg || `error ${result.data.errorcode}`}` }
    const detail = result.data?.data
    return detail ? { award: normalizeGrantsGov(null, detail) } : { error: `Grants.gov opportunity not found: ${awardId}` }
  }

  const limiter = getLimiter(`grants-${funder}`, { minIntervalMs: 1000 })
  const result = await limiter.run(() => (
    funder === 'nih' ? searchNih(args, shared)
      : funder === 'nsf' ? searchNsf(args, shared)
        : searchGrantsGov(args, shared)
  ))
  return { action, funder, ...result }
}

function renderAward(award, index) {
  const lines = [`${index ? `${index}. ` : ''}**${award.title || '(untitled)'}**`]
  const meta = [
    award.award_id,
    award.funder?.toUpperCase(),
    award.organization || award.agency,
    award.pi ? `PI: ${award.pi}` : null,
    award.amount != null ? `$${Number(award.amount).toLocaleString('en-US')}` : null,
  ].filter(Boolean)
  if (meta.length) lines.push(`   ${meta.join(' · ')}`)
  const dates = [award.start_date || award.open_date, award.end_date || award.close_date].filter(Boolean)
  if (dates.length) lines.push(`   Dates: ${dates.join(' → ')}`)
  if (award.institute || award.program) lines.push(`   ${[award.institute, award.program].filter(Boolean).join(' · ')}`)
  if (award.status) lines.push(`   Status: ${award.status}`)
  if (award.abstract) lines.push(`   ${award.abstract}`)
  if (award.url) lines.push(`   ${award.url}`)
  return lines.join('\n')
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (value.award) {
    return [{ type: 'text', text: renderAward(value.award, 0) }]
  }
  const header = `${value.funder.toUpperCase()}: ${value.total ?? value.results.length} result(s)`
  const body = value.results.map((award, index) => renderAward(award, index + 1)).join('\n\n') || 'No awards/opportunities matched.'
  return [{ type: 'text', text: `${header}\n\n${body}` }]
}

export const name = 'academic-harness-grant-search'
export const inject = ['tools']

export function apply(ctx) {
  if (!optionalToolsEnabled()) return
  ctx.tools.register(defineTool({
    name: 'grant_search',
    description: [
      'Discover funded projects and open opportunities: NIH RePORTER (awards), NSF Award Search (awards), and Grants.gov (posted/forecast opportunities).',
      '`search` takes a `funder` and `query`, plus optional `pi`, `org`, and `fiscal_year`; `get` reads one award/opportunity by `award_id`. NIH and NSF return awards with amounts and dates; Grants.gov returns opportunities with open/close dates and award ceilings, not funded awards.',
      'Informational only: for funding discovery, prior-award context, and acknowledgment checks — not grant-writing advice, and not a literature review. Optional tool: present only when AH_ENABLE_OPTIONAL_TOOLS=1.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ['search', 'get'], description: 'search (default) or get one award.' },
      funder: { type: 'string', enum: FUNDERS, description: 'nih, nsf, or grantsgov.' },
      query: { type: 'string', description: 'Topic/keyword query (search).' },
      pi: { type: 'string', description: 'Principal investigator last name (NIH/NSF search).' },
      org: { type: 'string', description: 'Organization/awardee name (NIH/NSF search).' },
      fiscal_year: { type: 'number', description: 'Fiscal/start year filter (NIH/NSF; Grants.gov filters by open/close year).' },
      award_id: { type: 'string', description: 'NIH project number, NSF award id, or Grants.gov opportunity id (get).' },
      limit: { type: 'number', description: 'Results, 1-100. Default 10.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      return runGrantSearch(args, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `Grants (${args.funder || ''}): ${args.query || args.award_id || ''}`, kind: 'search' }
    },
  }))
}
