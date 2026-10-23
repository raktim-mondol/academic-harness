/**
 * patent_search: PatentsView prior-art/assignee lookup. Requires
 * PATENTSVIEW_API_KEY on every call (a clear error, not a disabled tool).
 *
 * Optional tool: registers only with AH_ENABLE_OPTIONAL_TOOLS=1. Informational
 * only — no legal-status, validity, or freedom-to-operate conclusions.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { optionalToolsEnabled } from './optional-tools.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'

const API = 'https://search.patentsview.org/api/v1/patent/'
const FIELDS = [
  'patent_id', 'patent_title', 'patent_date', 'patent_earliest_priority_date',
  'assignees.assignee_organization', 'inventors.inventor_name_first', 'inventors.inventor_name_last',
]

function cap(value, chars = 800) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > chars ? `${text.slice(0, chars).trimEnd()}…` : text
}

function isoDate(value, name) {
  const text = String(value || '').trim()
  if (!text) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${name} must look like YYYY-MM-DD`)
  return text
}

export function buildPatentQuery(args) {
  const clauses = []
  const query = String(args.query || '').trim()
  if (query) {
    clauses.push({
      _or: [
        { _text_any: { patent_title: query } },
        { _text_any: { patent_abstract: query } },
      ],
    })
  }
  if (String(args.assignee || '').trim()) {
    clauses.push({ _text_any: { 'assignees.assignee_organization': String(args.assignee).trim() } })
  }
  if (String(args.inventor || '').trim()) {
    clauses.push({
      _or: [
        { _text_any: { 'inventors.inventor_name_last': String(args.inventor).trim() } },
        { _text_any: { 'inventors.inventor_name_first': String(args.inventor).trim() } },
      ],
    })
  }
  const from = isoDate(args.date_from, 'date_from')
  const to = isoDate(args.date_to, 'date_to')
  if (from) clauses.push({ _gte: { patent_date: from } })
  if (to) clauses.push({ _lte: { patent_date: to } })
  if (!clauses.length) return null
  return clauses.length === 1 ? clauses[0] : { _and: clauses }
}

export function normalizePatent(patent) {
  const inventors = (patent.inventors || [])
    .map((inventor) => [inventor.inventor_name_first, inventor.inventor_name_last].filter(Boolean).join(' '))
    .filter(Boolean)
  const assignees = (patent.assignees || []).map((assignee) => assignee.assignee_organization).filter(Boolean)
  return {
    patent_id: patent.patent_id || null,
    title: patent.patent_title || null,
    assignees: [...new Set(assignees)],
    inventors: [...new Set(inventors)],
    grant_date: patent.patent_date || null,
    priority_date: patent.patent_earliest_priority_date || null,
    abstract: cap(patent.patent_abstract),
    url: patent.patent_id ? `https://patents.google.com/patent/US${patent.patent_id}` : null,
  }
}

export async function runPatentSearch(args, exec, deps = {}) {
  const http = deps.fetchJson || fetchJson
  const readEnv = deps.resolveEnv || resolveEnv
  const key = await readEnv('PATENTSVIEW_API_KEY')
  if (!key) {
    return { error: 'PATENTSVIEW_API_KEY is not set; add a free PatentsView API key in Settings to use patent_search' }
  }
  let query
  try {
    query = buildPatentQuery(args)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  if (!query) return { error: 'give query, assignee, inventor, or a date range' }
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 100)
  const fields = args.include_abstract ? [...FIELDS, 'patent_abstract'] : FIELDS
  const params = new URLSearchParams({
    q: JSON.stringify(query),
    f: JSON.stringify(fields),
    o: JSON.stringify({ size: limit }),
  })
  const limiter = getLimiter('patentsview', { minIntervalMs: 1000 })
  const result = await limiter.run(() => http(`${API}?${params}`, {
    signal: exec?.signal,
    headers: { 'X-Api-Key': key, 'User-Agent': searchUserAgent() },
    timeoutMs: 30_000,
    retries: 1,
  }))
  if (!result.ok) {
    if (result.error === 'aborted') return { error: 'request cancelled' }
    const hint = result.status === 401 || result.status === 403 ? ' (check PATENTSVIEW_API_KEY)' : (result.status === 429 ? ' (rate limited; wait and retry)' : '')
    return { error: `PatentsView API error ${result.status}${hint}${result.detail ? `: ${result.detail}` : ''}` }
  }
  if (result.data?.error) {
    return { error: `PatentsView: ${Array.isArray(result.data.error) ? result.data.error.join('; ') : result.data.error}` }
  }
  const patents = (result.data?.patents || []).map(normalizePatent)
  return { total: result.data?.total_hits ?? patents.length, results: patents }
}

function renderPatent(patent, index) {
  const lines = [`${index ? `${index}. ` : ''}**${patent.title || '(untitled)'}** — US${patent.patent_id || '?'}`]
  if (patent.assignees.length) lines.push(`   Assignees: ${patent.assignees.join('; ')}`)
  if (patent.inventors.length) lines.push(`   Inventors: ${patent.inventors.join('; ')}`)
  const dates = [
    patent.grant_date ? `granted ${patent.grant_date}` : null,
    patent.priority_date ? `priority ${patent.priority_date}` : null,
  ].filter(Boolean)
  if (dates.length) lines.push(`   ${dates.join(' · ')}`)
  if (patent.abstract) lines.push(`   ${patent.abstract}`)
  if (patent.url) lines.push(`   ${patent.url}`)
  return lines.join('\n')
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const header = `PatentsView: ${value.total ?? value.results.length} result(s)`
  const body = value.results.map((patent, index) => renderPatent(patent, index + 1)).join('\n\n') || 'No patents matched.'
  return [{ type: 'text', text: `${header}\n\n${body}` }]
}

export const name = 'academic-harness-patent-search'
export const inject = ['tools']

export function apply(ctx) {
  if (!optionalToolsEnabled()) return
  ctx.tools.register(defineTool({
    name: 'patent_search',
    description: [
      'Search US patents through PatentsView for prior-art context and assignee/inventor lookup: patent id, title, assignees, inventors, grant/priority dates, and optionally the abstract.',
      'Requires PATENTSVIEW_API_KEY on every call (free key); without it the call returns a clear error. Filters: `query` (title/abstract text), `assignee`, `inventor`, and a `date_from`/`date_to` grant-date range.',
      'Informational only: no legal-status, validity, infringement, or freedom-to-operate conclusion. Optional tool: present only when AH_ENABLE_OPTIONAL_TOOLS=1.',
    ].join(' '),
    parameters: {
      query: { type: 'string', description: 'Text query over patent title and abstract.' },
      assignee: { type: 'string', description: 'Assignee organization text, e.g. "University of California".' },
      inventor: { type: 'string', description: 'Inventor first or last name.' },
      date_from: { type: 'string', description: 'Earliest grant date, YYYY-MM-DD.' },
      date_to: { type: 'string', description: 'Latest grant date, YYYY-MM-DD.' },
      limit: { type: 'number', description: 'Results, 1-100. Default 10.' },
      include_abstract: { type: 'boolean', description: 'Include the patent abstract. Default false.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      return runPatentSearch(args, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `Patents: ${args.query || args.assignee || args.inventor || ''}`, kind: 'search' }
    },
  }))
}
