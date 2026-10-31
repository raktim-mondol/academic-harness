/**
 * Keyless publisher-scoped search through Crossref member IDs.
 *
 * These are the publishers' public Crossref deposits, not their paid search
 * APIs. The same query can therefore run without a Scopus, WoS, or IEEE key.
 */
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { fromCrossrefWork } from './search-normalize.js'

export const PUBLISHER_MEMBERS = {
  wiley: { id: 311, name: 'Wiley' },
  elsevier: { id: 78, name: 'Elsevier' },
  scopus: { id: 78, name: 'Elsevier' },
  sciencedirect: { id: 78, name: 'Elsevier' },
  springer: { id: 297, name: 'Springer Nature' },
  springer_nature: { id: 297, name: 'Springer Nature' },
  nature: { id: 297, name: 'Springer Nature' },
  ieee: { id: 263, name: 'IEEE' },
  ieee_xplore: { id: 263, name: 'IEEE' },
  taylor_francis: { id: 301, name: 'Taylor & Francis' },
  sage: { id: 179, name: 'SAGE' },
  oup: { id: 286, name: 'Oxford University Press' },
  oxford: { id: 286, name: 'Oxford University Press' },
  cup: { id: 56, name: 'Cambridge University Press' },
  cambridge: { id: 56, name: 'Cambridge University Press' },
  acm: { id: 320, name: 'ACM' },
  acs: { id: 316, name: 'American Chemical Society' },
  aps: { id: 16, name: 'American Physical Society' },
  iop: { id: 266, name: 'IOP Publishing' },
  rsc: { id: 292, name: 'Royal Society of Chemistry' },
  mdpi: { id: 1968, name: 'MDPI' },
  frontiers: { id: 1965, name: 'Frontiers' },
  plos: { id: 340, name: 'PLOS' },
}

export const PUBLISHER_ALIASES = Object.keys(PUBLISHER_MEMBERS)

export function normalizePublisherAliases(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',')
  const aliases = []
  const unknown = []
  for (const entry of raw) {
    const alias = String(entry || '').trim().toLowerCase()
    if (!alias) continue
    if (!PUBLISHER_MEMBERS[alias]) {
      if (!unknown.includes(alias)) unknown.push(alias)
      continue
    }
    if (!aliases.includes(alias)) aliases.push(alias)
  }
  return { aliases, unknown }
}

async function crossrefMailto() {
  return await resolveEnv('CROSSREF_MAILTO') || await resolveEnv('UNPAYWALL_EMAIL') || ''
}

export async function runPublisherSearch(args, exec) {
  const alias = String(args.publisher || args.alias || '').trim().toLowerCase()
  const member = PUBLISHER_MEMBERS[alias]
  if (!member) return { error: `unknown publisher "${alias || '(missing)'}"; use one of ${PUBLISHER_ALIASES.join(', ')}` }
  const query = String(args.query || '').trim()
  if (!query) return { error: 'query is required' }

  const mailto = await crossrefMailto()
  const params = new URLSearchParams({
    'query.bibliographic': query,
    rows: String(Math.min(Math.max(Number(args.limit) || 20, 1), 100)),
  })
  if (mailto) params.set('mailto', mailto)
  const filters = []
  if (args.year_min != null) filters.push(`from-pub-date:${Math.trunc(Number(args.year_min))}`)
  if (args.year_max != null) filters.push(`until-pub-date:${Math.trunc(Number(args.year_max))}`)
  if (filters.length) params.set('filter', filters.join(','))

  const limiter = getLimiter('crossref-list', { minIntervalMs: mailto ? 334 : 1000 })
  const result = await limiter.run(() => fetchJson(`https://api.crossref.org/v1/members/${member.id}/works?${params}`, {
    signal: exec?.signal,
    headers: { 'User-Agent': searchUserAgent(mailto) },
  }))
  if (!result.ok) {
    return { error: `Crossref member search failed for ${member.name}`, status: result.status, detail: result.detail ?? result.error }
  }
  const message = result.data?.message || {}
  const results = (message.items || []).map((work) => {
    const paper = fromCrossrefWork(work)
    if (!paper) return null
    paper.publisher = work.publisher || member.name
    paper.sources = [alias]
    return paper
  }).filter(Boolean)
  return {
    publisher: alias,
    publisher_name: member.name,
    total: message['total-results'] ?? results.length,
    results,
  }
}
