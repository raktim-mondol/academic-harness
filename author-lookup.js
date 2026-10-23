/**
 * author_lookup: ORCID researcher search/records and ROR institution lookup.
 *
 * Optional tool: registers only with AH_ENABLE_OPTIONAL_TOOLS=1. ORCID reads
 * are public; ORCID_TOKEN only raises rate limits and unlocks limited fields.
 * ROR is keyless. Ambiguous names return ranked candidates — identities are
 * never merged automatically.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { optionalToolsEnabled } from './optional-tools.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'

const ORCID = 'https://pub.orcid.org/v3.0'
const ROR = 'https://api.ror.org/v2/organizations'
const ORCID_ID = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/

function errorOf(result, label) {
  if (result.error === 'aborted') return 'request cancelled'
  const hint = result.status === 401 || result.status === 403
    ? label === 'ORCID' ? ' (check ORCID_TOKEN)' : ''
    : ''
  return `${label} API error ${result.status}${hint}${result.detail ? `: ${result.detail}` : ''}`
}

function orcidHeaders(token) {
  const headers = { Accept: 'application/json', 'User-Agent': searchUserAgent() }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

export function normalizeOrcidSearch(entry) {
  const given = String(entry['given-names'] || '').trim()
  const family = String(entry['family-names'] || '').trim()
  return {
    orcid: entry['orcid-id'] || null,
    name: entry['credit-name'] || [given, family].filter(Boolean).join(' ') || null,
    institutions: (entry['institution-name'] || []).slice(0, 5),
    emails: (entry.email || []).slice(0, 2),
    url: entry['orcid-id'] ? `https://orcid.org/${entry['orcid-id']}` : null,
  }
}

export function normalizeOrcidRecord(record) {
  const person = record?.person || {}
  const name = person.name || {}
  const given = name['given-names']?.value || ''
  const family = name['family-name']?.value || ''
  const activities = record?.['activities-summary'] || {}
  const employments = []
  for (const group of activities.employments?.['affiliation-group'] || []) {
    for (const summary of group.summaries || []) {
      const employment = summary['employment-summary'] || {}
      const organization = employment.organization || {}
      if (!organization.name) continue
      const disambiguated = organization['disambiguated-organization'] || {}
      employments.push({
        name: organization.name,
        role: employment['role-title'] || employment.role_title || null,
        start: employment['start-date']?.year?.value || null,
        end: employment['end-date']?.year?.value || null,
        ror_id: (disambiguated['disambiguation-source'] || '').toUpperCase() === 'ROR'
          ? disambiguated['disambiguated-organization-identifier'] || null
          : null,
      })
    }
  }
  return {
    orcid: person.path || record?.orcid || null,
    name: [given, family].filter(Boolean).join(' ') || name['credit-name']?.value || null,
    other_names: (person['other-names']?.['other-name'] || []).map((other) => other.content).filter(Boolean).slice(0, 5),
    works_count: (activities.works?.group || []).length,
    employments: employments.slice(0, 8),
    url: person.path ? `https://orcid.org/${person.path}` : null,
  }
}

export function normalizeRor(item) {
  const names = Array.isArray(item?.names) ? item.names : []
  const display = names.find((entry) => entry.types?.includes('ror_display'))?.value
    || names.find((entry) => entry.types?.includes('label'))?.value
    || item?.name
    || null
  const geonames = item?.locations?.[0]?.geonames_details || {}
  return {
    ror_id: String(item?.id || '').replace(/^https?:\/\/ror\.org\//i, '') || null,
    name: display,
    aliases: names.filter((entry) => entry.value !== display).map((entry) => entry.value).slice(0, 8),
    types: item?.types || [],
    country: geonames.country_name || item?.country?.country_name || null,
    city: geonames.name || null,
    website: (item?.links || []).find((link) => link.type === 'website')?.value || null,
    url: item?.id || null,
  }
}

export async function runAuthorLookup(args, exec, deps = {}) {
  const http = deps.fetchJson || fetchJson
  const readEnv = deps.resolveEnv || resolveEnv
  const action = args.action || 'author'
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50)

  if (action === 'institution') {
    const rorId = String(args.ror_id || '').trim().replace(/^https?:\/\/ror\.org\//i, '')
    const query = String(args.query || '').trim()
    if (!rorId && !query) return { error: 'give a query or ror_id' }
    const limiter = getLimiter('ror', { minIntervalMs: 500 })
    if (rorId) {
      const result = await limiter.run(() => http(`${ROR}/${encodeURIComponent(rorId)}`, {
        signal: exec?.signal, headers: { 'User-Agent': searchUserAgent() },
      }))
      if (!result.ok) return { error: result.status === 404 ? `ROR institution not found: ${rorId}` : errorOf(result, 'ROR') }
      return { action, institution: normalizeRor(result.data) }
    }
    const result = await limiter.run(() => http(`${ROR}?query=${encodeURIComponent(query)}`, {
      signal: exec?.signal, headers: { 'User-Agent': searchUserAgent() },
    }))
    if (!result.ok) return { error: errorOf(result, 'ROR') }
    const institutions = (result.data?.items || []).slice(0, limit).map(normalizeRor)
    return { action, total: result.data?.number_of_results ?? institutions.length, institutions }
  }

  if (action !== 'author') return { error: 'action must be author or institution' }
  const token = await readEnv('ORCID_TOKEN')
  const limiter = getLimiter('orcid', { minIntervalMs: 500 })
  const orcid = String(args.orcid || '').trim()
  if (orcid && !ORCID_ID.test(orcid)) return { error: 'orcid must look like 0000-0002-1825-0097' }
  if (!orcid && !String(args.query || '').trim()) return { error: 'give a query or orcid' }

  if (orcid) {
    const result = await limiter.run(() => http(`${ORCID}/${encodeURIComponent(orcid)}/record`, {
      signal: exec?.signal, headers: orcidHeaders(token),
    }))
    if (!result.ok) return { error: result.status === 404 ? `ORCID record not found: ${orcid}` : errorOf(result, 'ORCID') }
    return { action, author: normalizeOrcidRecord(result.data) }
  }

  const url = `${ORCID}/expanded-search/?q=${encodeURIComponent(String(args.query).trim())}&rows=${limit}`
  const result = await limiter.run(() => http(url, { signal: exec?.signal, headers: orcidHeaders(token) }))
  if (!result.ok) return { error: errorOf(result, 'ORCID') }
  const authors = (result.data?.['expanded-result'] || []).slice(0, limit).map(normalizeOrcidSearch)
  return { action, total: result.data?.['num-found'] ?? authors.length, authors }
}

function renderAuthor(author) {
  const lines = [`**${author.name || '(unnamed)'}** — ${author.orcid || 'no ORCID'}${author.works_count != null ? ` · ${author.works_count} works` : ''}`]
  if (author.employments?.length) {
    for (const employment of author.employments) {
      const years = [employment.start, employment.end].filter(Boolean).join('–')
      lines.push(`   - ${employment.name}${employment.role ? `, ${employment.role}` : ''}${years ? ` (${years})` : ''}${employment.ror_id ? ` · ROR ${employment.ror_id}` : ''}`)
    }
  }
  if (author.institutions?.length) lines.push(`   Institutions: ${author.institutions.join('; ')}`)
  if (author.other_names?.length) lines.push(`   Other names: ${author.other_names.join(', ')}`)
  if (author.url) lines.push(`   ${author.url}`)
  return lines.join('\n')
}

function renderInstitution(institution) {
  const meta = [institution.country, institution.city, ...(institution.types || [])].filter(Boolean).join(' · ')
  return [
    `**${institution.name || '(unnamed)'}** — ${institution.ror_id || 'no ROR id'}`,
    meta ? `   ${meta}` : null,
    institution.aliases?.length ? `   Aliases: ${institution.aliases.join(', ')}` : null,
    institution.website ? `   ${institution.website}` : null,
    institution.url ? `   ${institution.url}` : null,
  ].filter(Boolean).join('\n')
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (value.institution) return [{ type: 'text', text: renderInstitution(value.institution) }]
  if (value.institutions) {
    const header = `${value.total ?? value.institutions.length} institution(s)`
    return [{ type: 'text', text: [header, ...value.institutions.map(renderInstitution)].join('\n\n') }]
  }
  if (value.author) return [{ type: 'text', text: renderAuthor(value.author) }]
  const header = `${value.total ?? value.authors.length} author(s)`
  return [{ type: 'text', text: [header, ...value.authors.map(renderAuthor)].join('\n\n') }]
}

export const name = 'academic-harness-author-lookup'
export const inject = ['tools']

export function apply(ctx) {
  if (!optionalToolsEnabled()) return
  ctx.tools.register(defineTool({
    name: 'author_lookup',
    description: [
      'Resolve researcher and institution identities: ORCID author search/records (name, works count, employment with ROR iDs) and ROR institution search/records (name, aliases, country, website).',
      '`author` takes a free-text `query` or an `orcid`; `institution` takes `query` or `ror_id`. Ambiguous names return ranked candidates — never merge identities or assume a candidate is the person you mean.',
      'Optional tool: present only when AH_ENABLE_OPTIONAL_TOOLS=1. ORCID reads are public (ORCID_TOKEN only raises limits); ROR is keyless.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ['author', 'institution'], description: 'author (default) or institution.' },
      query: { type: 'string', description: 'Author name query or institution name query.' },
      orcid: { type: 'string', description: 'ORCID iD for one author record, e.g. 0000-0002-1825-0097.' },
      ror_id: { type: 'string', description: 'ROR id for one institution, e.g. 052gg0110.' },
      limit: { type: 'number', description: 'Results, 1-50. Default 10.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      return runAuthorLookup(args, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `Author/institution: ${args.query || args.orcid || args.ror_id || ''}`, kind: 'search' }
    },
  }))
}
