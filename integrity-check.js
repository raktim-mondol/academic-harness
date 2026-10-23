/**
 * integrity_check: publication-status lookup for a DOI (or a title).
 *
 * Evidence comes from the two registries that publish it for free: Crossref
 * relationship metadata and OpenAlex retraction flags. A registry that could
 * not be queried yields `unknown`, never `clean`. PubPeer has no stable public
 * API, so it is returned as a URL rather than scraped.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { canonicalDoi, normalizeTitle } from './search-normalize.js'

const CROSSREF_WORKS = 'https://api.crossref.org/works'
const OPENALEX_WORKS = 'https://api.openalex.org/works'
const OA_SELECT = 'id,doi,title,display_name,is_retracted,is_paratext,updated_date'

function registryError(result, label) {
  if (result.error === 'aborted') return 'request cancelled'
  return `${label} API error ${result.status}${result.detail ? `: ${result.detail}` : ''}`
}

/** Crossref relationships that describe the status of the work itself. */
async function fetchCrossrefWork(doi, { signal, mailto, deps }) {
  const http = deps.fetchJson || fetchJson
  const params = new URLSearchParams()
  if (mailto) params.set('mailto', mailto)
  const limiter = getLimiter('crossref-single', { minIntervalMs: mailto ? 100 : 200 })
  const result = await limiter.run(() => fetchJsonUrl(`${CROSSREF_WORKS}/${encodeURIComponent(doi)}`, params, {
    signal,
    headers: { 'User-Agent': searchUserAgent(mailto) },
  }, http))
  if (result.ok) return { work: result.data?.message || null }
  if (result.status === 404) return { work: null, missing: true }
  return { error: registryError(result, 'Crossref') }
}

/** OpenAlex mirrors Crossref's own relationships plus its computed flags. */
async function fetchOpenAlexWork(doi, { signal, apiKey, mailto, deps }) {
  const http = deps.fetchJson || fetchJson
  const params = new URLSearchParams({ select: OA_SELECT })
  if (apiKey) params.set('api_key', apiKey)
  if (mailto) params.set('mailto', mailto)
  const limiter = getLimiter('openalex', { minIntervalMs: apiKey ? 34 : 100 })
  const result = await limiter.run(() => fetchJsonUrl(`${OPENALEX_WORKS}/doi:${encodeURIComponent(doi).replace(/%2F/gi, '/')}`, params, {
    signal,
    headers: { 'User-Agent': searchUserAgent(mailto) },
  }, http))
  if (result.ok) return { work: result.data || null }
  if (result.status === 404) return { work: null, missing: true }
  return { error: registryError(result, 'OpenAlex') }
}

function fetchJsonUrl(base, params, options, http) {
  const query = params.toString()
  return http(`${base}${query ? `?${query}` : ''}`, options)
}

/* ---------------------------------------------------------------- classify */

const SIGNAL_TYPES = [
  ['retraction', /retract/i],
  ['expression_of_concern', /expression.of.concern|concern/i],
  ['correction', /correct|erratum|errata/i],
]

function signalTypeOf(key) {
  for (const [type, pattern] of SIGNAL_TYPES) {
    if (pattern.test(String(key))) return type
  }
  return null
}

/**
 * `has-retraction` and `is-retracted-by` describe the queried work;
 * `is-retraction-of` means the queried work *is* someone else's notice.
 */
function appliesToSelf(key) {
  const value = String(key)
  return /^has-/i.test(value) || /-by$/i.test(value)
}

function noticeId(entry) {
  if (!entry) return null
  if (typeof entry === 'string') return entry
  return entry.DOI || entry.doi || entry.id || entry.document_id || null
}

function collectFromRelation(relation, out) {
  for (const [key, entries] of Object.entries(relation || {})) {
    const type = signalTypeOf(key)
    if (!type || !appliesToSelf(key)) continue
    const list = Array.isArray(entries) ? entries : [entries]
    for (const entry of list) {
      const id = noticeId(entry)
      out.push({
        source: 'crossref',
        type,
        relation: key,
        notice_doi: id,
        detail: `${key}${type === 'retraction' ? ' — the work itself is retracted' : ''}`.trim(),
      })
    }
  }
}

const UPDATE_FIELDS = ['update-to', 'updated-by', 'update-policy']

function collectFromUpdates(work, out) {
  for (const field of UPDATE_FIELDS) {
    for (const entry of Array.isArray(work?.[field]) ? work[field] : []) {
      const key = entry?.Label || entry?.label || entry?.type || ''
      const type = signalTypeOf(key)
      if (!type) continue
      out.push({
        source: 'crossref',
        type,
        relation: field,
        notice_doi: noticeId(entry),
        detail: `${field}: ${key}`,
      })
    }
  }
}

function integritySignals(work) {
  const out = []
  if (!work) return out
  collectFromRelation(work.relation, out)
  collectFromUpdates(work, out)
  return dedupeSignals(out)
}

function openAlexSignals(work) {
  const out = []
  if (!work) return out
  if (work.is_retracted) {
    out.push({
      source: 'openalex',
      type: 'retraction',
      relation: 'is_retracted',
      detail: 'OpenAlex flags the work as retracted',
    })
  }
  if (work.is_paratext) {
    out.push({
      source: 'openalex',
      type: 'paratext',
      relation: 'is_paratext',
      detail: 'OpenAlex classifies this record as editorial paratext, not a research article',
    })
  }
  return dedupeSignals(out)
}

function dedupeSignals(signals) {
  const seen = new Set()
  return signals.filter((signal) => {
    const key = [signal.source, signal.type, signal.relation, signal.notice_doi || ''].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function hasType(signals, type) {
  return signals.some((signal) => signal.type === type)
}

/**
 * Retraction is the only claim where both registries must agree: one silent
 * source is not evidence that a paper stands. Corrections and concerns are
 * reported from whichever registry saw them.
 */
export function classifyIntegrity({ crossrefSignals: cr, openalexSignals: oa, crossrefError, openalexError }) {
  const both = [cr, oa]
  const flagged = both.filter((list) => hasType(list, 'retraction')).length
  const available = [crossrefError, openalexError].filter((error) => !error).length
  if (flagged === 2) return 'retracted'
  if (flagged === 1 && available === 2) return 'unknown'
  if (flagged === 1) return 'retracted'
  if (crossrefError || openalexError) return 'unknown'
  if (hasType(cr, 'expression_of_concern') || hasType(oa, 'expression_of_concern')) return 'expression_of_concern'
  if (hasType(cr, 'correction') || hasType(oa, 'correction')) return 'corrected'
  return 'clean'
}

/* ----------------------------------------------------------------- looking */

function linksFor(doi, signals, work) {
  const links = []
  if (doi) links.push({ label: 'DOI', url: `https://doi.org/${doi}` })
  for (const signal of signals) {
    if (!signal.notice_doi) continue
    links.push({ label: `${signal.source}: ${signal.relation}`, url: `https://doi.org/${signal.notice_doi}` })
  }
  if (work?.id) links.push({ label: 'OpenAlex record', url: work.id })
  const seen = new Set()
  return links.filter((link) => {
    if (seen.has(link.url)) return false
    seen.add(link.url)
    return true
  })
}

async function checkOne(doi, { signal, mailto, openalexKey, deps }) {
  const [cr, oa] = await Promise.all([
    fetchCrossrefWork(doi, { signal, mailto, deps }),
    fetchOpenAlexWork(doi, { signal, apiKey: openalexKey, mailto, deps }),
  ])

  const crossref = integritySignals(cr.work)
  const openalex = openAlexSignals(oa.work)
  const allSignals = dedupeSignals([...crossref, ...openalex])

  const notFound = cr.missing && oa.missing
  const verdict = notFound ? 'not_found' : classifyIntegrity({
    crossrefSignals: crossref,
    openalexSignals: openalex,
    crossrefError: cr.missing ? null : cr.error,
    openalexError: oa.missing ? null : oa.error,
  })

  const unavailable = []
  if (cr.error) unavailable.push(`crossref: ${cr.error}`)
  if (oa.error) unavailable.push(`openalex: ${oa.error}`)
  if (cr.missing) unavailable.push('crossref: DOI not registered')
  if (oa.missing) unavailable.push('openalex: DOI not indexed')

  return {
    checked_at: new Date().toISOString(),
    doi,
    title: cr.work?.title?.[0] || oa.work?.display_name || null,
    verdict,
    crossref_ok: Boolean(cr.work) || Boolean(cr.missing),
    openalex_ok: Boolean(oa.work) || Boolean(oa.missing),
    unavailable,
    signals: allSignals,
    links: linksFor(doi, allSignals, oa.work),
    pubpeer_url: `https://pubpeer.com/publications/${doi}`,
  }
}

/** Crossref bibliographic search, used only to turn a title into candidate DOIs. */
async function resolveTitle(title, { signal, mailto, deps }) {
  const http = deps.fetchJson || fetchJson
  const params = new URLSearchParams({
    'query.bibliographic': title,
    rows: '5',
    select: 'DOI,title,author,issued,container-title',
  })
  if (mailto) params.set('mailto', mailto)
  const limiter = getLimiter('crossref-list', { minIntervalMs: mailto ? 334 : 1000 })
  const result = await limiter.run(() => fetchJsonUrl(CROSSREF_WORKS, params, {
    signal,
    headers: { 'User-Agent': searchUserAgent(mailto) },
  }, http))
  if (!result.ok) return { error: registryError(result, 'Crossref') }
  const wanted = normalizeTitle(title)
  const items = (result.data?.message?.items || []).map((item) => ({
    doi: canonicalDoi(item.DOI),
    title: item.title?.[0] || null,
    year: item.issued?.['date-parts']?.[0]?.[0] || null,
    venue: item['container-title']?.[0] || null,
  })).filter((item) => item.doi)
  // Crossref search is fuzzy, so only a title that matches verbatim counts as
  // one answer. Everything else stays a candidate list for the caller.
  const exact = items.filter((item) => normalizeTitle(item.title || '') === wanted)
  return { items: exact.length === 1 ? exact : items, exact: exact.length === 1 }
}

/* ------------------------------------------------------------------- tool */

function renderResult(result) {
  const lines = [`DOI: ${result.doi}`, `Verdict: ${result.verdict}`, `Checked: ${result.checked_at}`]
  if (result.title) lines.push(`Title: ${result.title}`)
  if (result.signals.length) {
    lines.push('', 'Signals:')
    for (const signal of result.signals) {
      lines.push(`- ${signal.source} · ${signal.type} · ${signal.relation}${signal.notice_doi ? ` → ${signal.notice_doi}` : ''}`)
    }
  }
  if (result.unavailable.length) {
    lines.push('', 'Unavailable sources:')
    for (const item of result.unavailable) lines.push(`- ${item}`)
  }
  if (result.links.length) {
    lines.push('', 'Links:')
    for (const link of result.links) lines.push(`- ${link.label}: ${link.url}`)
  }
  lines.push(`- PubPeer (no public API; open in a browser): ${result.pubpeer_url}`)
  return lines.join('\n')
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (value.verdict === 'ambiguous') {
    const lines = [
      `Title match is ambiguous for: ${value.title}`,
      '',
      'Candidates (re-run with `doi` set to the one you mean):',
      ...value.candidates.map((c, i) => `${i + 1}. ${c.doi} — ${c.title || '(untitled)'}${c.year ? ` (${c.year})` : ''}${c.venue ? ` ${c.venue}` : ''}`),
    ]
    return [{ type: 'text', text: lines.join('\n') }]
  }
  return [{ type: 'text', text: renderResult(value) }]
}

export async function runIntegrityCheck(args, exec, deps = {}) {
  const readEnv = deps.resolveEnv || resolveEnv
  const mailto = await readEnv('CROSSREF_MAILTO') || await readEnv('UNPAYWALL_EMAIL')
  const openalexKey = await readEnv('OPENALEX_API_KEY')

  const explicit = canonicalDoi(args.doi)
  const title = String(args.title || '').trim()
  const shared = { signal: exec?.signal, mailto, openalexKey, deps }

  if (explicit) return checkOne(explicit, shared)
  if (title) {
    const found = await resolveTitle(title, shared)
    if (found.error) return { error: found.error, title }
    if (!found.items.length) return { error: 'no Crossref match for that title', title, verdict: 'not_found' }
    if (!found.exact) {
      return { verdict: 'ambiguous', title, candidates: found.items }
    }
    return checkOne(found.items[0].doi, shared)
  }
  return { error: 'give a doi or a title' }
}

export const name = 'academic-harness-integrity-check'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'integrity_check',
    description: [
      'Check a paper for retraction, expression of concern, or correction against Crossref relationship metadata and OpenAlex retraction flags.',
      'Pass a `doi` (bare or doi.org URL) or a `title` — a title is resolved through Crossref; more than one match comes back as candidates for you to choose, never auto-picked.',
      'Run it for every DOI you intend to cite in a manuscript, rebuttal, or review. A `retracted`, `unknown`, or `not_found` verdict must be surfaced to the user; never present such a paper as current evidence.',
      'Free and keyless (OPENALEX_API_KEY and CROSSREF_MAILTO only raise rate limits). This is publication status, not claim support — verifying that a paper backs a statement stays with PaperMemory quote checks and scite. PubPeer has no public API, so only its URL is returned.',
    ].join(' '),
    parameters: {
      doi: { type: 'string', description: 'DOI to check (bare or doi.org URL). Takes precedence over title.' },
      title: { type: 'string', description: 'Paper title to resolve via Crossref when no DOI is known.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      return runIntegrityCheck(args, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `Integrity: ${args.doi || args.title || ''}`, kind: 'search' }
    },
  }))
}
