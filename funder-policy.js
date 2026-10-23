/**
 * funder_policy: funder identity and open-access policy.
 *
 * OpenAlex (keyless) resolves the funder and its alternate names. Sherpa
 * Juliet (via cgi/retrieve, item-type=funder) supplies per-version OA policy
 * and needs SHERPA_ROMERO_API_KEY; without it the answer is OpenAlex-only with
 * an explicit `key_not_set` note. Compliance information, not legal advice.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { versionInfo } from './journal-policy.js'

const OPENALEX = 'https://api.openalex.org/funders'
const JULIET = 'https://v2.sherpa.ac.uk/cgi/retrieve'

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

export function normalizeFunder(item) {
  return {
    openalex_id: String(item?.id || '').replace(/^https?:\/\/openalex\.org\//i, '') || null,
    name: item?.display_name || null,
    alternate_titles: (item?.alternate_titles || []).slice(0, 8),
    country: item?.country_code || null,
    homepage: item?.homepage_url || null,
    awards_count: item?.awards_count ?? null,
    works_count: item?.works_count ?? null,
    url: item?.id || null,
  }
}

export function normalizeJuliet(item) {
  const raw = item?.policies || item?.publisher_policies || item?.publisherPolicies || []
  const list = Array.isArray(raw) ? raw : Object.values(raw)
  const policies = list.map((policy) => ({
    preprint: versionInfo(policy?.preprint),
    postprint: versionInfo(policy?.postprint),
    published: versionInfo(policy?.published),
  })).filter((policy) => policy.preprint || policy.postprint || policy.published)
  return {
    funder_name: item?.name || item?.title || null,
    acronym: item?.acronym || null,
    country: item?.country?.name || (typeof item?.country === 'string' ? item.country : null),
    url: item?.uri || item?.url || null,
    policies,
  }
}

function matchPolicy(funder, policies) {
  if (!funder) return null
  const names = [funder.name, ...funder.alternate_titles].map(normalizeName).filter(Boolean)
  return policies.find((policy) => {
    const candidate = normalizeName(policy.funder_name)
    return candidate && names.some((name) => name === candidate || name.includes(candidate) || candidate.includes(name))
  }) || null
}

export async function runFunderPolicy(args, exec, deps = {}) {
  const http = deps.fetchJson || fetchJson
  const readEnv = deps.resolveEnv || resolveEnv
  const query = String(args.funder || args.query || '').trim()
  if (!query) return { error: 'give a funder name' }
  const mailto = await readEnv('CROSSREF_MAILTO') || await readEnv('UNPAYWALL_EMAIL')
  const key = await readEnv('SHERPA_ROMERO_API_KEY')
  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20)

  const params = new URLSearchParams({ search: query, per_page: String(limit) })
  if (mailto) params.set('mailto', mailto)
  const openalexLimiter = getLimiter('openalex', { minIntervalMs: 100 })
  const sources = [`${OPENALEX}?${params}`]

  const openalexPromise = openalexLimiter.run(() => http(`${OPENALEX}?${params}`, {
    signal: exec?.signal,
    headers: { 'User-Agent': searchUserAgent(mailto) },
  })).catch((error) => ({ ok: false, status: 0, error: error.message }))

  let julietPromise = Promise.resolve({ skipped: 'key_not_set' })
  if (key) {
    const filter = JSON.stringify([['name', 'contains', query]])
    const julietParams = new URLSearchParams({
      'item-type': 'funder', format: 'Json', 'api-key': key, filter,
    })
    const sourceUrl = `${JULIET}?item-type=funder&format=Json&filter=${encodeURIComponent(filter)}`
    sources.push(sourceUrl)
    const julietLimiter = getLimiter('sherpa-romeo', { minIntervalMs: 1000 })
    julietPromise = julietLimiter.run(() => http(`${JULIET}?${julietParams}`, {
      signal: exec?.signal,
      headers: { 'User-Agent': searchUserAgent() },
    })).then((result) => {
      if (!result.ok) {
        const hint = result.status === 401 || result.status === 403 ? ' (check SHERPA_ROMERO_API_KEY)' : ''
        return { error: `Sherpa Juliet API error ${result.status}${hint}${result.detail ? `: ${result.detail}` : ''}`, url: sourceUrl }
      }
      const items = result.data?.items || result.data?.results || []
      return { policies: items.map(normalizeJuliet), url: sourceUrl, total: result.data?.total ?? items.length }
    }).catch((error) => ({ error: `Sherpa Juliet request failed: ${error.message}`, url: sourceUrl }))
  }

  const [openalex, juliet] = await Promise.all([openalexPromise, julietPromise])
  if (!openalex.ok && juliet.skipped) {
    return { error: `OpenAlex API error ${openalex.status}${openalex.detail ? `: ${openalex.detail}` : ''}` }
  }

  const funders = openalex.ok
    ? (openalex.data?.results || []).map(normalizeFunder)
    : []
  const policies = juliet.policies || []
  for (const funder of funders) {
    const matched = matchPolicy(funder, policies)
    if (matched) funder.policy = matched
  }
  const primary = funders[0] || null
  return {
    query,
    funder: primary,
    other_funders: funders.slice(1),
    policies,
    sherpa: juliet.skipped
      ? { skipped: juliet.skipped }
      : (juliet.error ? { error: juliet.error, url: juliet.url } : { url: juliet.url, matches: policies.length }),
    openalex_error: openalex.ok ? null : `OpenAlex API error ${openalex.status}${openalex.detail ? `: ${openalex.detail}` : ''}`,
    retrieved_at: new Date().toISOString(),
    sources,
    notes: [
      'Compliance information only, not legal advice.',
      ...(policies.length ? ['Sherpa Juliet policy wording is summarized (version, embargo, license, conditions); check the linked policy before relying on it.'] : []),
    ],
  }
}

function renderPolicyVersion(name, version) {
  if (!version) return null
  const bits = [
    version.permitted ? `permitted: ${version.permitted}` : null,
    version.embargo ? `embargo: ${version.embargo}` : null,
    version.license?.length ? `license: ${version.license.join(', ')}` : null,
    version.location ? `location: ${version.location}` : null,
    version.conditions ? `conditions: ${version.conditions}` : null,
  ].filter(Boolean)
  return `   - ${name}: ${bits.length ? bits.join(' · ') : 'no policy fields returned'}`
}

function renderFunder(funder) {
  const meta = [funder.country, funder.awards_count != null ? `${funder.awards_count} awards` : null].filter(Boolean).join(' · ')
  return [
    `**${funder.name || '(unnamed)'}**${funder.openalex_id ? ` — ${funder.openalex_id}` : ''}`,
    meta ? `   ${meta}` : null,
    funder.homepage ? `   ${funder.homepage}` : null,
  ].filter(Boolean).join('\n')
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const lines = [`Funder policy: ${value.funder?.name || value.query}`]
  if (value.funder) lines.push(renderFunder(value.funder))
  if (value.openalex_error) lines.push('', `OpenAlex: ${value.openalex_error}`)
  if (value.sherpa.skipped) {
    lines.push('', `Sherpa Juliet: not checked (${value.sherpa.skipped}; set SHERPA_ROMERO_API_KEY for funder OA policy)`)
  } else if (value.sherpa.error) {
    lines.push('', `Sherpa Juliet: unavailable — ${value.sherpa.error}`)
  } else if (!value.policies.length) {
    lines.push('', 'Sherpa Juliet: no funder policy record returned')
  } else {
    lines.push('', 'Sherpa Juliet policies:')
    for (const entry of value.policies) {
      lines.push(`- ${entry.funder_name || '(unnamed)'}${entry.acronym ? ` (${entry.acronym})` : ''}${entry.url ? ` · ${entry.url}` : ''}`)
      entry.policies.forEach((policy, index) => {
        if (entry.policies.length > 1) lines.push(`   row ${index + 1}:`)
        for (const version of ['preprint', 'postprint', 'published']) {
          const line = renderPolicyVersion(version, policy[version])
          if (line) lines.push(line)
        }
      })
    }
  }
  if (value.other_funders.length) {
    lines.push('', 'Other OpenAlex matches:')
    for (const funder of value.other_funders) lines.push(`- ${funder.name}${funder.country ? ` (${funder.country})` : ''}${funder.openalex_id ? ` · ${funder.openalex_id}` : ''}`)
  }
  if (value.sources.length) lines.push('', `Sources: ${value.sources.join(' · ')}`)
  for (const note of value.notes) lines.push('', note)
  return [{ type: 'text', text: lines.join('\n') }]
}

export const name = 'academic-harness-funder-policy'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'funder_policy',
    description: [
      'Look up a research funder: OpenAlex identity (canonical name, alternate titles, country, award/works counts) and, with SHERPA_ROMERO_API_KEY, Sherpa Juliet open-access policy per article version (embargo, license, conditions).',
      'Pass a `funder` name. Without the Sherpa key the result is the OpenAlex identity plus an explicit `key_not_set` note — never a guessed policy. Use it for funder acknowledgment checks and OA compliance before submission; pair with `journal_policy` for the venue half.',
      'Compliance information only, not legal advice, and not a grant search (use grant_search for awards).',
    ].join(' '),
    parameters: {
      funder: { type: 'string', description: 'Funder name, e.g. "National Institutes of Health" or "Wellcome Trust".' },
      limit: { type: 'number', description: 'OpenAlex matches, 1-20. Default 5.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      return runFunderPolicy(args, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `Funder policy: ${args.funder || ''}`, kind: 'search' }
    },
  }))
}
