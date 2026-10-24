/**
 * coscientist_verify: citation integrity and claim support for the hypothesis
 * tournament. Optional tool — mounted only when AH_ENABLE_OPTIONAL_TOOLS is set.
 *
 * This is the one part of the tournament that reaches the network, and it stays
 * inside the registry boundary: Crossref for existence, and `integrity_check`
 * (reused, not reimplemented) when retraction status is asked for. Deciding what
 * a paper *means* for a claim is a model judgement, so `claims` records what a
 * subagent already concluded rather than trying to conclude it here — the same
 * division `review` uses between the ledger and the search layer.
 *
 * Classification follows upstream (`tools/citationResolver.ts`) including where
 * upstream is deliberately conservative: a title that Crossref cannot match is
 * `unverified`, not fabricated. Absence of evidence is not evidence of
 * fabrication; a DOI that is not registered is.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { optionalToolsEnabled } from './optional-tools.js'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { canonicalDoi } from './search-normalize.js'
import { contentTokens } from './coscientist-models.js'
import { deriveState, recordProvenance } from './coscientist-store.js'
import { runIntegrityCheck } from './integrity-check.js'

const CROSSREF_WORKS = 'https://api.crossref.org/works'

/** Upstream `citationResolver.ts:32` — kept so a match here means the same thing. */
export const TITLE_MATCH_THRESHOLD = 0.7

/** Below this many shared significant tokens a "match" is coincidence, not identity. */
export const MIN_SHARED_TOKENS = 3

/** A citation list longer than this is refused rather than hammered at the registry. */
export const MAX_CITATIONS_PER_CALL = 30

export const CITATION_STATUSES = ['verified', 'unverified', 'fabricated']
export const CLAIM_SUPPORTS = ['supports', 'contradicts', 'unaddressed']

const ACTIONS = ['citations', 'claims', 'status']

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function requireSlug(args) {
  const slug = String(args.slug ?? '').trim()
  if (!slug) throw new Error('slug is required')
  return slug
}

function requireId(args) {
  const id = String(args.id ?? '').trim()
  if (!id) throw new Error('id is required (the hypothesis to check)')
  return id
}

/**
 * Pull a DOI out of free text. Generated citations arrive in every shape a
 * model can invent — `doi:10.…`, `https://doi.org/10.…`, or a bare suffix inside
 * a prose reference.
 */
export function extractDoi(value) {
  const text = String(value ?? '')
  const match = text.match(/\b10\.\d{4,9}\/[-._;()/:a-z0-9]+/i)
  return match ? canonicalDoi(match[0]) : null
}

/** Significant words of a title: lowercased, alphanumerics, no stopwords or years. */
export function titleTokens(value) {
  return contentTokens(value)
}

/**
 * Overlap coefficient rather than Jaccard: a citation is usually the title plus
 * author, year, and venue, so the candidate being a subset of the citation is
 * the normal case, not a disagreement. Requiring a few shared tokens stops a
 * two-word title from matching everything it brushes against.
 */
export function titleSimilarity(cited, candidate) {
  const wanted = new Set(titleTokens(cited))
  const found = new Set(titleTokens(candidate))
  if (!wanted.size || !found.size) return 0
  let shared = 0
  for (const token of wanted) if (found.has(token)) shared += 1
  if (shared < MIN_SHARED_TOKENS) return 0
  return shared / Math.min(wanted.size, found.size)
}

function crossrefMeta(item) {
  return {
    doi: canonicalDoi(item?.DOI),
    title: (Array.isArray(item?.title) ? item.title[0] : item?.title) || null,
    year: item?.issued?.['date-parts']?.[0]?.[0] ?? null,
    venue: (Array.isArray(item?.['container-title']) ? item['container-title'][0] : item?.['container-title']) || null,
  }
}

// The limiter is process-wide and keyed by name, so these are the exact
// intervals crossref-lookup.js and integrity-check.js use: one Crossref budget
// shared by all three tools rather than three competing ones.
async function crossrefGet(url, { signal, mailto, bucket, deps }) {
  const http = deps.fetchJson || fetchJson
  const minIntervalMs = bucket === 'crossref-single' ? (mailto ? 100 : 200) : (mailto ? 334 : 1000)
  const limiter = (deps.getLimiter || getLimiter)(bucket, { minIntervalMs })
  return limiter.run(() => http(url, {
    signal,
    headers: { 'User-Agent': searchUserAgent(mailto) },
  }))
}

/**
 * Verify one citation string.
 *
 * A DOI that Crossref does not list is the only case called `fabricated` — the
 * model asserted a registered identifier and it is not registered. Everything
 * inconclusive (a title nobody matched, a registry that errored or rate-limited)
 * is `unverified`, and the reason travels with it.
 */
export async function verifyCitation(citation, { signal, mailto } = {}, deps = {}) {
  const raw = String(citation ?? '').trim()
  const doi = extractDoi(raw)

  if (doi) {
    const params = new URLSearchParams()
    if (mailto) params.set('mailto', mailto)
    const result = await crossrefGet(`${CROSSREF_WORKS}/${encodeURIComponent(doi)}?${params}`, {
      signal, mailto, bucket: 'crossref-single', deps,
    })
    if (result.status === 404) {
      return { raw, doi, status: 'fabricated', matchScore: 0, source: 'crossref', reason: 'DOI is not registered with Crossref' }
    }
    if (!result.ok) {
      if (result.error === 'aborted') return { raw, doi, status: 'unverified', matchScore: 0, source: 'none', reason: 'request cancelled' }
      return { raw, doi, status: 'unverified', matchScore: 0, source: 'none', reason: `Crossref API error ${result.status}` }
    }
    const meta = crossrefMeta(result.data?.message)
    return { raw, doi: meta.doi || doi, status: 'verified', matchScore: 1, source: 'crossref', ...meta }
  }

  const params = new URLSearchParams({
    'query.bibliographic': raw,
    rows: '5',
    select: 'DOI,title,issued,container-title',
  })
  if (mailto) params.set('mailto', mailto)
  const result = await crossrefGet(`${CROSSREF_WORKS}?${params}`, { signal, mailto, bucket: 'crossref-list', deps })
  if (!result.ok) {
    if (result.error === 'aborted') return { raw, status: 'unverified', matchScore: 0, source: 'none', reason: 'request cancelled' }
    return { raw, status: 'unverified', matchScore: 0, source: 'none', reason: `Crossref API error ${result.status}` }
  }
  const items = result.data?.message?.items || []
  let best = null
  let bestScore = 0
  for (const item of items) {
    const score = titleSimilarity(raw, item?.title?.[0] || '')
    if (score > bestScore) {
      bestScore = score
      best = item
    }
  }
  if (best && bestScore >= TITLE_MATCH_THRESHOLD) {
    return { raw, status: 'verified', matchScore: Number(bestScore.toFixed(3)), source: 'crossref', ...crossrefMeta(best) }
  }
  const candidates = items.length
  return {
    raw,
    status: 'unverified',
    matchScore: Number(bestScore.toFixed(3)),
    source: 'none',
    // Three different failures, said differently: nothing came back, the
    // closest title shared no identity, or it shared some but not enough.
    reason: !candidates
      ? 'no Crossref candidate returned'
      : (best
        ? `closest Crossref title matched at ${bestScore.toFixed(2)}, below ${TITLE_MATCH_THRESHOLD}`
        : `no Crossref candidate shared ${MIN_SHARED_TOKENS} significant title tokens`),
    best_match: best || candidates ? crossrefMeta(best || items[0]) : null,
  }
}

function normalizeClaim(input) {
  if (!input || typeof input !== 'object') throw new Error('each claim must be an object')
  const claim = String(input.claim ?? '').trim()
  if (!claim) throw new Error('each claim needs its claim text')
  const support = String(input.support ?? '').trim()
  if (!CLAIM_SUPPORTS.includes(support)) {
    throw new Error(`claim support must be one of ${CLAIM_SUPPORTS.join(', ')} (got "${support}")`)
  }
  const confidence = Number(input.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('claim confidence is required and must be between 0 and 1')
  }
  return {
    claim,
    support,
    confidence: Number(confidence.toFixed(2)),
    paper_title: String(input.paper_title ?? '').trim() || null,
    paper_doi: extractDoi(input.paper_doi ?? '') || null,
    note: String(input.note ?? '').trim() || null,
  }
}

export async function runCoscVerify(args = {}, exec = {}, deps = {}) {
  const cwd = workspaceRoot(exec)
  const action = String(args.action ?? 'status').trim().toLowerCase()
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  const slug = requireSlug(args)
  const readEnv = deps.resolveEnv || resolveEnv
  const state = deriveState(cwd, slug)
  const id = requireId(args)
  const hyp = state.byId.get(id)
  if (!hyp) throw new Error(`unknown hypothesis id: ${id}`)

  if (action === 'status') {
    const check = hyp.citationCheck
    const claims = check?.claims || []
    return {
      action,
      slug,
      id,
      citations: hyp.citations.length,
      checked: Boolean(check?.reportedCounts),
      checked_at: check?.ts || null,
      counts: check ? { total: check.total, verified: check.verified, unverified: check.unverified, fabricated: check.fabricated } : null,
      penalty: check ? { ratingDelta: check.ratingDelta, rdDelta: check.rdDelta } : null,
      claims: { recorded: claims.length, supports: claims.filter((c) => c.support === 'supports').length, contradicts: claims.filter((c) => c.support === 'contradicts').length, unaddressed: claims.filter((c) => c.support === 'unaddressed').length },
    }
  }

  if (action === 'claims') {
    const input = Array.isArray(args.claims) ? args.claims : []
    if (!input.length) throw new Error('claims must be a non-empty array of { claim, support, confidence, paper_title, paper_doi }')
    if (input.length > 20) throw new Error('record at most 20 claims per call')
    const claims = input.map(normalizeClaim)
    const stored = await recordProvenance({ cwd, slug, id: hyp.id, claims })
    return {
      action,
      slug,
      id: hyp.id,
      claims,
      contradicted: claims.filter((claim) => claim.support === 'contradicts').length,
      penalty: stored.penalty,
      hypothesis: stored.hypothesis,
    }
  }

  // action === 'citations'
  const citations = hyp.citations
  if (!citations.length) {
    const stored = await recordProvenance({ cwd, slug, id: hyp.id, total: 0, verified: 0, unverified: 0, fabricated: 0 })
    return { action, slug, id: hyp.id, rows: [], counts: { total: 0, verified: 0, unverified: 0, fabricated: 0 }, penalty: stored.penalty, note: 'this hypothesis cites nothing, so there is nothing to verify and no penalty either', hypothesis: stored.hypothesis }
  }
  if (citations.length > MAX_CITATIONS_PER_CALL) {
    throw new Error(`${citations.length} citations exceeds the ${MAX_CITATIONS_PER_CALL}-per-call limit; trim the reference list`)
  }

  const mailto = await readEnv('CROSSREF_MAILTO') || await readEnv('UNPAYWALL_EMAIL')
  const checkIntegrity = Boolean(args.check_integrity)
  const rows = []
  const retracted = []
  for (const citation of citations) {
    // Sequential on purpose: the polite pool is per-caller, and a burst of
    // parallel registry hits is how a verification run gets rate-limited away.
    const row = await verifyCitation(citation, { signal: exec.signal, mailto }, deps)
    if (checkIntegrity && row.status === 'verified' && row.doi) {
      const integrity = await runIntegrityCheck({ doi: row.doi }, exec, deps)
      row.integrity = integrity.verdict || null
      if (['retracted', 'expression_of_concern'].includes(integrity.verdict)) retracted.push({ doi: row.doi, verdict: integrity.verdict, title: row.title })
    }
    rows.push(row)
  }

  const counts = {
    total: rows.length,
    verified: rows.filter((row) => row.status === 'verified').length,
    unverified: rows.filter((row) => row.status === 'unverified').length,
    fabricated: rows.filter((row) => row.status === 'fabricated').length,
  }
  const stored = await recordProvenance({
    cwd,
    slug,
    id: hyp.id,
    total: counts.total,
    verified: counts.verified,
    unverified: counts.unverified,
    fabricated: counts.fabricated,
    summary: `${counts.verified} verified · ${counts.unverified} unverified · ${counts.fabricated} fabricated`,
  })

  return {
    action,
    slug,
    id: hyp.id,
    rows,
    counts,
    retracted,
    penalty: stored.penalty,
    late_penalty_applied: stored.late_penalty_applied,
    hypothesis: stored.hypothesis,
  }
}

function render(value) {
  if (value?.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  switch (value.action) {
    case 'citations': {
      const lines = [`Citation integrity for \`${value.id}\`: ${value.counts.verified} verified · ${value.counts.unverified} unverified · ${value.counts.fabricated} fabricated`]
      if (value.note) return [{ type: 'text', text: `${lines[0]}. ${value.note}` }]
      lines.push(`Penalty: rating ${value.penalty.ratingDelta}, RD +${value.penalty.rdDelta} (weighted fabrication rate ${(value.penalty.f * 100).toFixed(0)} %)`)
      if (value.late_penalty_applied) lines.push('Applied now: the hypothesis was already active, so its rating took the difference.')
      lines.push('')
      for (const row of value.rows) {
        const mark = row.status === 'verified' ? 'OK' : row.status === 'fabricated' ? 'FABRICATED' : 'UNVERIFIED'
        const identity = row.title ? `${row.title}${row.year ? ` (${row.year})` : ''}${row.doi ? ` · ${row.doi}` : ''}` : row.doi || '(no match)'
        lines.push(`- ${mark}: ${row.raw.slice(0, 90)} → ${identity}${row.matchScore < 1 ? ` [${row.matchScore}]` : ''}${row.reason ? ` — ${row.reason}` : ''}${row.integrity ? ` — publication status: ${row.integrity}` : ''}`)
      }
      if (value.retracted?.length) {
        lines.push('', 'Retracted or under expression of concern — a real paper that no longer supports anything:')
        for (const item of value.retracted) lines.push(`- ${item.doi}: ${item.title || ''} (${item.verdict})`)
      }
      if (value.counts.fabricated) lines.push('', 'Do not keep an invented reference in the hypothesis. Remove it or replace it with a source that exists.')
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'claims': {
      const lines = [`Recorded ${value.claims.length} claim-support judgements for \`${value.id}\` (${value.contradicted} contradicted).`]
      for (const claim of value.claims) {
        lines.push(`- ${claim.support} (${claim.confidence}): ${claim.claim}${claim.paper_title ? ` — ${claim.paper_title}` : ''}`)
      }
      if (value.contradicted) lines.push('', 'Contradicted claims are a weakness the debate should see; brief the judges with this line.')
      return [{ type: 'text', text: lines.join('\n') }]
    }
    default: {
      const lines = [value.checked
        ? `\`${value.id}\`: ${value.citations} citations, checked ${value.checked_at}${value.counts ? ` — ${value.counts.verified} verified / ${value.counts.unverified} unverified / ${value.counts.fabricated} fabricated` : ''}`
        : `\`${value.id}\`: ${value.citations} citations, not yet checked.`]
      if (value.penalty && (value.penalty.ratingDelta || value.penalty.rdDelta)) lines.push(`Penalty on record: rating ${value.penalty.ratingDelta}, RD +${value.penalty.rdDelta}.`)
      if (value.claims.recorded) lines.push(`Claims: ${value.claims.supports} supported, ${value.claims.contradicts} contradicted, ${value.claims.unaddressed} unaddressed.`)
      return [{ type: 'text', text: lines.join('\n') }]
    }
  }
}

export const name = 'academic-harness-coscientist-verify'
export const inject = ['tools']

export function apply(ctx) {
  if (!optionalToolsEnabled()) return
  ctx.tools.register(defineTool({
    name: 'coscientist_verify',
    description: [
      'Citation integrity and claim support for the Co-Scientist hypothesis tournament (optional tool; set AH_ENABLE_OPTIONAL_TOOLS=1 and restart). Actions: `citations` (check that every work a hypothesis cites actually exists, via Crossref, and record the result so the rating penalty applies), `claims` (record the supports/contradicts/unaddressed judgements a subagent reached about each load-bearing claim), `status` (whether this hypothesis has been checked, and what the ledger holds).',
      'Classifications: `verified` — a DOI that resolves, or a title Crossref matches at 0.7 token overlap; `fabricated` — a DOI the caller asserted that Crossref does not list, and nothing else; `unverified` — everything inconclusive, including a title nobody matched and any registry error. A registry that could not be queried is never reported as verified.',
      'Counts drive a soft penalty (up to −150 rating, +100 RD at a 100% weighted fabrication rate), never a veto. This tool does not judge whether a paper supports a claim — that is a subagent reading real sources; `claims` only records those judgements so the ledger, not the transcript, holds them.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ACTIONS, description: 'citations, claims, or status. Default status.' },
      slug: { type: 'string', description: 'Tournament slug. Required.' },
      id: { type: 'string', description: 'Hypothesis id such as h1. Required.' },
      check_integrity: { type: 'boolean', description: 'Also report retraction / expression-of-concern status for verified DOIs (citations). Costs one more registry round per citation.' },
      claims: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'Per-claim judgements (claims): [{ claim, support: supports|contradicts|unaddressed, confidence: 0-1, paper_title, paper_doi }].',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      try {
        return await runCoscVerify(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Verify ${args.action || 'status'}: ${args.id || args.slug || ''}`, kind: 'search' }
    },
  }))
}
