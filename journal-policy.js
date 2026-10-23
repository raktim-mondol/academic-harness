/**
 * journal_policy: open-access and self-archiving policy for a journal.
 *
 * DOAJ (keyless) supplies listing status, APC, license, and OA start year.
 * Sherpa Romeo supplies per-version self-archiving permissions and needs a
 * free SHERPA_ROMERO_API_KEY; without it the answer is DOAJ-only with an
 * explicit `key_not_set` note. This is compliance information, not legal
 * advice, and a missing source is reported, never guessed.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { normalizeTitle } from './search-normalize.js'

const DOAJ = 'https://doaj.org/api/search/journals'
const SHERPA = 'https://v2.sherpa.ac.uk/cgi/retrieve'

function normalizeIssn(value) {
  return String(value || '').replace(/\s+/g, '').toUpperCase()
}

function cap(value, chars = 400) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > chars ? `${text.slice(0, chars).trimEnd()}…` : text
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))]
}

export function normalizeDoaj(result) {
  const bibjson = result?.bibjson || {}
  const apc = bibjson.apc
  return {
    listed: true,
    title: bibjson.title || null,
    issns: unique([bibjson.issn, bibjson.eissn]),
    publisher: bibjson.publisher?.name || null,
    apc: apc
      ? {
        has_apc: Boolean(apc.has_apc),
        amounts: (apc.max || []).map((entry) => ({ price: entry.price ?? null, currency: entry.currency || null })),
        url: apc.url || null,
      }
      : { has_apc: null, amounts: [], url: null },
    licenses: unique((bibjson.license || []).map((license) => license.type)),
    oa_start: bibjson.oa_start ?? null,
    url: result?.id ? `https://doaj.org/toc/${result.id}` : null,
  }
}

function doajQuery(args) {
  if (String(args.issn || '').trim()) return `issn:${normalizeIssn(args.issn)}`
  if (String(args.title || '').trim()) return `bibjson.title:"${String(args.title).trim().replace(/"/g, '\\"')}"`
  throw new Error('give an issn or a title')
}

export function formatEmbargo(embargo) {
  if (!embargo) return null
  if (typeof embargo === 'string') return embargo.trim() || null
  if (typeof embargo === 'number') return `${embargo} months`
  const amount = embargo.amount ?? embargo.months ?? embargo.duration
  const period = embargo.period || embargo.unit || (embargo.months != null ? 'months' : (embargo.days != null ? 'days' : null))
  if (amount != null && period) return `${amount} ${period}`
  if (amount != null) return String(amount)
  return null
}

/** Sherpa's version objects vary by API revision; read both shapes. */
export function versionInfo(version) {
  if (!version) return null
  const permittedOa = version.permitted_oa || version.permittedOa
  const permissions = (Array.isArray(permittedOa) ? permittedOa : (permittedOa ? [permittedOa] : [])).filter(Boolean)
  const first = permissions[0] || {}
  const explicit = version.permitted ?? version.allowed
  const permitted = explicit === true || explicit === 'yes'
    ? 'yes'
    : (explicit === false || explicit === 'no' ? 'no' : (permissions.length ? 'yes' : null))
  return {
    permitted,
    embargo: formatEmbargo(version.embargo || first.embargo),
    license: unique([version.license, first.license, ...permissions.map((permission) => permission.license)]),
    location: cap(first.location || version.location, 200),
    conditions: cap(
      version.conditions
        ?? first.conditions
        ?? permissions.map((permission) => permission.conditions).filter(Boolean).join('; '),
      400,
    ),
  }
}

export function normalizeSherpa(item) {
  if (!item) return null
  const rawPolicies = item.publisherPolicies || item.publisher_policy || []
  const policies = (Array.isArray(rawPolicies) ? rawPolicies : Object.values(rawPolicies)).map((policy) => ({
    publisher: policy.publisher?.name || item.publisher?.name || null,
    preprint: versionInfo(policy.preprint),
    postprint: versionInfo(policy.postprint),
    published: versionInfo(policy.published),
  }))
  const sources = policies.length ? policies : [{
    publisher: item.publisher?.name || null,
    preprint: versionInfo(item.preprint),
    postprint: versionInfo(item.postprint),
    published: versionInfo(item.published),
  }]
  return {
    title: item.title || null,
    issns: unique(item.issns || []),
    publisher: item.publisher?.name || null,
    url: item.uri || null,
    policies: sources.filter((policy) => policy.preprint || policy.postprint || policy.published),
  }
}

function pickDoaj(results, args) {
  if (!results.length) return { record: null }
  if (String(args.issn || '').trim()) return { record: results[0] }
  const wanted = normalizeTitle(args.title)
  const exact = results.filter((result) => normalizeTitle(result?.bibjson?.title || '') === wanted)
  if (exact.length === 1) return { record: exact[0] }
  if (!exact.length && results.length === 1) return { record: results[0] }
  return {
    record: null,
    candidates: results.slice(0, 5).map((result) => ({
      title: result?.bibjson?.title || null,
      issns: unique([result?.bibjson?.issn, result?.bibjson?.eissn]),
      url: result?.id ? `https://doaj.org/toc/${result.id}` : null,
    })),
  }
}

async function fetchDoaj(args, { signal, http }) {
  const limiter = getLimiter('doaj', { minIntervalMs: 500 })
  const url = `${DOAJ}/${encodeURIComponent(doajQuery(args))}?pageSize=5`
  const result = await limiter.run(() => http(url, { signal, headers: { 'User-Agent': searchUserAgent() } }))
  if (!result.ok) return { error: `DOAJ API error ${result.status}${result.detail ? `: ${result.detail}` : ''}`, url }
  return { results: result.data?.results || [], url }
}

async function fetchSherpa(args, { signal, key, http }) {
  const filter = String(args.issn || '').trim()
    ? [['issn', 'equals', normalizeIssn(args.issn)]]
    : [['title', 'contains', String(args.title).trim()]]
  const params = new URLSearchParams({
    'item-type': 'publication',
    format: 'Json',
    'api-key': key,
    filter: JSON.stringify(filter),
  })
  const limiter = getLimiter('sherpa-romeo', { minIntervalMs: 1000 })
  const result = await limiter.run(() => http(`${SHERPA}?${params}`, { signal, headers: { 'User-Agent': searchUserAgent() } }))
  const sourceUrl = `${SHERPA}?item-type=publication&format=Json&filter=${encodeURIComponent(JSON.stringify(filter))}`
  if (!result.ok) {
    const hint = result.status === 401 || result.status === 403 ? ' (check SHERPA_ROMERO_API_KEY)' : ''
    return { error: `Sherpa Romeo API error ${result.status}${hint}${result.detail ? `: ${result.detail}` : ''}`, url: sourceUrl }
  }
  const items = result.data?.items || result.data?.results || []
  return { policy: normalizeSherpa(items[0]), total: result.data?.total ?? items.length, url: sourceUrl }
}

export async function runJournalPolicy(args, exec, deps = {}) {
  const http = deps.fetchJson || fetchJson
  const readEnv = deps.resolveEnv || resolveEnv
  const issn = normalizeIssn(args.issn)
  const title = String(args.title || '').trim()
  if (!issn && !title) return { error: 'give an issn or a title' }
  if (issn && !/^\d{4}-?\d{3}[\dX]$/.test(issn)) return { error: 'issn must look like 1234-5678' }

  const key = await readEnv('SHERPA_ROMERO_API_KEY')
  const [doaj, sherpa] = await Promise.all([
    fetchDoaj({ ...args, issn: issn || undefined }, { signal: exec?.signal, http }),
    key
      ? fetchSherpa({ ...args, issn: issn || undefined }, { signal: exec?.signal, key, http })
      : Promise.resolve({ skipped: 'key_not_set' }),
  ])

  const picked = doaj.results ? pickDoaj(doaj.results, args) : { record: null }
  if (picked.candidates) {
    return {
      status: 'ambiguous',
      title_query: title || null,
      issn: issn || null,
      candidates: picked.candidates,
      sherpa: sherpa.skipped ? { skipped: sherpa.skipped } : (sherpa.policy ? { policies: sherpa.policy.policies, url: sherpa.url } : { error: sherpa.error, url: sherpa.url }),
    }
  }

  const doajFailed = Boolean(doaj.error)
  const doajRecord = doajFailed
    ? { listed: null, error: doaj.error }
    : (picked.record ? normalizeDoaj(picked.record) : { listed: false })
  const sherpaValue = sherpa.skipped
    ? { skipped: sherpa.skipped }
    : (sherpa.policy
      ? { policies: sherpa.policy.policies, publisher: sherpa.policy.publisher, issns: sherpa.policy.issns, url: sherpa.url }
      : { error: sherpa.error, url: sherpa.url })
  const sherpaFound = Boolean(sherpa.policy)
  const found = doajRecord.listed === true || sherpaFound
  // A failed lookup is `unknown`, never `not_found`.
  const status = found ? 'found' : ((doajFailed || sherpa.error) ? 'unknown' : 'not_found')
  const journalTitle = doajRecord.title || sherpa.policy?.title || title || null
  return {
    status,
    issn: issn || doajRecord.issns?.[0] || sherpa.policy?.issns?.[0] || null,
    title_query: title || null,
    journal: {
      title: journalTitle,
      issns: doajRecord.issns?.length ? doajRecord.issns : (sherpa.policy?.issns || (issn ? [issn] : [])),
      publisher: doajRecord.publisher || sherpa.policy?.publisher || null,
    },
    doaj: doajRecord,
    sherpa: sherpaValue,
    retrieved_at: new Date().toISOString(),
    sources: [doaj.url, sherpa.url].filter(Boolean),
  }
}

function renderVersion(name, version) {
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

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (value.status === 'ambiguous') {
    const lines = [
      `Title match is ambiguous for: ${value.title_query}`,
      '',
      'Candidates (re-run with `issn`):',
      ...value.candidates.map((candidate, index) => `${index + 1}. ${candidate.title || '(untitled)'}${candidate.issns.length ? ` — ${candidate.issns.join(', ')}` : ''}${candidate.url ? ` (${candidate.url})` : ''}`),
    ]
    return [{ type: 'text', text: lines.join('\n') }]
  }
  const lines = [
    `${value.journal.title || '(unknown journal)'}${value.journal.issns.length ? ` — ${value.journal.issns.join(', ')}` : ''}`,
    value.journal.publisher ? `Publisher: ${value.journal.publisher}` : null,
    `Status: ${{
      found: 'found',
      not_found: 'not found in the queried sources',
      unknown: 'unknown — a source could not be queried',
      ambiguous: 'ambiguous title match',
    }[value.status] || value.status}`,
    '',
  ].filter((line) => line != null)
  if (value.doaj.listed === true) {
    lines.push('DOAJ:')
    lines.push(`   - listed (OA start ${value.doaj.oa_start ?? 'unknown'})${value.doaj.url ? ` · ${value.doaj.url}` : ''}`)
    lines.push(`   - APC: ${value.doaj.apc.has_apc == null ? 'not stated' : (value.doaj.apc.has_apc ? value.doaj.apc.amounts.map((amount) => `${amount.price ?? '?'} ${amount.currency || ''}`.trim()).join(', ') || 'yes (amount not stated)' : 'none')}`)
    if (value.doaj.licenses.length) lines.push(`   - License: ${value.doaj.licenses.join(', ')}`)
  } else if (value.doaj.listed === false) {
    lines.push('DOAJ: not listed')
  } else {
    lines.push(`DOAJ: unavailable — ${value.doaj.error}`)
  }
  if (value.sherpa.skipped) {
    lines.push('', `Sherpa Romeo: not checked (${value.sherpa.skipped}; set SHERPA_ROMERO_API_KEY for self-archiving policy)`)
  } else if (value.sherpa.error) {
    lines.push('', `Sherpa Romeo: unavailable — ${value.sherpa.error}`)
  } else if (value.sherpa.policies?.length) {
    lines.push('', 'Sherpa Romeo:')
    for (const policy of value.sherpa.policies) {
      if (policy.publisher) lines.push(`   Publisher: ${policy.publisher}`)
      for (const name of ['preprint', 'postprint', 'published']) {
        const line = renderVersion(name, policy[name])
        if (line) lines.push(line)
      }
    }
  } else {
    lines.push('', 'Sherpa Romeo: no policy record returned')
  }
  if (value.sources?.length) lines.push('', `Sources: ${value.sources.join(' · ')}`)
  lines.push('', 'Compliance information only, not legal advice.')
  return [{ type: 'text', text: lines.join('\n') }]
}

export const name = 'academic-harness-journal-policy'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'journal_policy',
    description: [
      'Look up a journal\'s open-access and self-archiving policy: DOAJ listing status, APC, license, OA start year, and — with SHERPA_ROMERO_API_KEY — Sherpa Romeo permissions for preprint, postprint, and published versions including embargo and conditions.',
      'Pass an `issn` (preferred) or a `title`. Without the Sherpa key the result is DOAJ-only with an explicit note; an unknown journal returns `not_found`, an ambiguous title returns candidate ISSNs. Never invent an APC, license, or embargo.',
      'This is compliance information for venue selection and data-availability/OA checks, not legal advice. It does not submit anything or check a specific manuscript.',
    ].join(' '),
    parameters: {
      issn: { type: 'string', description: 'Journal ISSN or eISSN, e.g. 1932-6203.' },
      title: { type: 'string', description: 'Journal title, used when no ISSN is known.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      try {
        return await runJournalPolicy(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Journal policy: ${args.issn || args.title || ''}`, kind: 'search' }
    },
  }))
}
