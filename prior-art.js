/**
 * prior_art: a prior-art triage report for ONE claim.
 *
 * The agent runs the searches (literature_search, source adapters, paper_resolve,
 * paper_get) and records what it ran and what it found. This tool does not
 * search and does not judge meaning. It assembles the record and keeps four
 * things apart that are easy to blur:
 *
 *   - what was searched, with providers, queries, access times, caps, and failures;
 *   - what each candidate was compared on: full text, abstract only, metadata
 *     only, or full text that could not be read;
 *   - the caller's claimed overlap and distinction, which stay assertions;
 *   - whether each quotation really is a verbatim span of the text supplied for
 *     that candidate. PaperMemory `quote_check` remains the authoritative
 *     verifier for ingested papers; this tool never says it ran.
 *
 * The strongest statement it can make is "no close overlap found in the searched
 * material", always with the coverage limits attached. It never says a claim is
 * novel. A lexical token-overlap reading (the same one coscientist_verify uses)
 * is shown as a cross-check on the caller's judgement, never as a verdict.
 */
import { join } from 'node:path'
import { defineTool } from 'ah-dsh-tools'
import { exportText, nowIso, sha256, shortHash, slug as slugify, stableStringify } from './ledger-kit.js'
import { extractDoi, referenceOverlap } from './coscientist-verify.js'
import { fenceUntrusted } from './untrusted-fence.js'
import { resolveWorkspacePath } from './workspace-path.js'

export const SEARCH_STATUSES = ['ok', 'partial', 'failed', 'not_run']
export const EVIDENCE_LEVELS = ['full_text', 'abstract', 'metadata_only', 'full_text_unavailable']
export const CLAIMED_OVERLAPS = ['none', 'partial', 'close', 'unknown']

/** Cross-check bands for the lexical reading; they only raise a flag for a human. */
export const LEXICAL_HIGH = 0.6
export const LEXICAL_LOW = 0.15

/** A verbatim span shorter than this proves nothing about overlap ("the", "we propose"). */
export const MIN_QUOTE_CHARS = 20
export const MIN_QUOTE_WORDS = 4

export const PRIOR_ART_LIMITS = { searches: 20, candidates: 50, quotesPerCandidate: 10, textChars: 200_000, queryChars: 500, claimChars: 4000 }

const text = (value) => (typeof value === 'string' ? value.trim() : '')

/** Whitespace is collapsed; case, punctuation, and quote glyphs must match exactly. */
function squash(value) {
  return String(value).normalize('NFC').replace(/\s+/gu, ' ').trim()
}

const SAFE_LABEL = /^[\w .:@/+-]{1,60}$/
const PMID = /^\d{1,9}$/
const ARXIV = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Za-z]{2})?\/\d{7})(?:v\d+)?$/i

/** Labels that reach the unfenced part of the rendering are restricted to a plain alphabet. */
function safeLabel(value, what, problems) {
  const v = text(value)
  if (!v) return ''
  if (SAFE_LABEL.test(v)) return v
  problems.push(`${what} is not a plain label (letters, digits, space and . : @ / + - only, up to 60 characters) and was dropped`)
  return ''
}

function normalizeSearch(raw, index, problems) {
  const provider = safeLabel(raw?.provider, `search ${index}: provider`, problems)
  const query = text(raw?.query)
  // A missing status is never read as success: the caller must say how the search went.
  const given = text(raw?.status)
  const before = problems.length
  if (!provider || !query) problems.push(`search ${index}: provider and query are both required`)
  if (!SEARCH_STATUSES.includes(given)) problems.push(`search ${index}: status is required and must be one of ${SEARCH_STATUSES.join(', ')}`)
  const status = problems.length > before ? 'invalid' : given
  if (query.length > PRIOR_ART_LIMITS.queryChars) problems.push(`search ${index}: query is longer than ${PRIOR_ART_LIMITS.queryChars} characters`)
  const num = (value) => (Number.isInteger(value) && value >= 0 ? value : null)
  const limit = num(raw?.limit)
  const count = num(raw?.result_count)
  const accessed = text(raw?.accessed_at)
  return {
    index,
    provider,
    query,
    status,
    accessed_at: accessed || null,
    limit,
    result_count: count,
    capped: limit != null && count != null && count >= limit,
    error: text(raw?.error) || null,
  }
}

function checkQuote(raw, body, level, squashedBody) {
  const quote = text(raw?.quote)
  const base = { quote, location: text(raw?.location) || null, papermemory: 'not_checked_by_this_tool' }
  if (!quote) return { ...base, state: 'not_checked', reason: 'empty quote' }
  if (!body) return { ...base, state: 'not_checked', reason: 'no text was supplied for this candidate, so the quote cannot be compared' }
  const found = squashedBody.includes(squash(quote))
  if (found && (squash(quote).length < MIN_QUOTE_CHARS || squash(quote).split(' ').length < MIN_QUOTE_WORDS)) {
    return { ...base, state: 'verbatim_but_too_short', reason: `a verbatim span of fewer than ${MIN_QUOTE_WORDS} words or ${MIN_QUOTE_CHARS} characters shows nothing about overlap, so it is not counted as support` }
  }
  if (!found) return { ...base, state: 'not_verbatim', reason: 'not a verbatim span of the supplied text (paraphrases, reordering, and changed punctuation do not match; a line-break hyphen is not repaired)' }
  return { ...base, state: level === 'full_text' ? 'verified_in_full_text' : 'verified_in_abstract', reason: null, ...(base.location ? {} : { location_missing: true }) }
}

function normalizeCandidate(raw, index, claim) {
  const ref = raw?.ref && typeof raw.ref === 'object' ? raw.ref : {}
  const doi = extractDoi(ref.doi) || null
  const problems = []
  const pmidRaw = text(String(ref.pmid ?? ''))
  const arxivRaw = text(ref.arxiv)
  if (pmidRaw && !PMID.test(pmidRaw)) problems.push('pmid is not a numeric identifier and was dropped')
  if (arxivRaw && !ARXIV.test(arxivRaw)) problems.push('arxiv is not an arXiv identifier and was dropped')
  const pmid = PMID.test(pmidRaw) ? pmidRaw : null
  const arxiv = ARXIV.test(arxivRaw) ? arxivRaw : null
  const title = text(ref.title)
  const level = text(raw?.evidence_level) || 'metadata_only'
  if (!title && !doi && !pmid && !arxiv) problems.push('candidate has no title or identifier')
  if (!EVIDENCE_LEVELS.includes(level)) problems.push(`evidence_level must be one of ${EVIDENCE_LEVELS.join(', ')}`)
  const body = typeof raw?.text === 'string' ? raw.text.slice(0, PRIOR_ART_LIMITS.textChars) : ''
  const textTruncated = typeof raw?.text === 'string' && raw.text.length > PRIOR_ART_LIMITS.textChars

  let basis
  let basisReason = null
  if (!EVIDENCE_LEVELS.includes(level)) basis = 'not_checked'
  else if (level === 'full_text_unavailable') { basis = 'full_text_not_checked'; basisReason = 'full text could not be read' }
  else if (level === 'metadata_only') basis = 'metadata_only'
  else if (!body.trim()) { basis = 'not_checked'; basisReason = `${level} was declared but no text was supplied` } else basis = level === 'full_text' ? 'full_text' : 'abstract_only'

  const quotesIn = Array.isArray(raw?.quotes) ? raw.quotes.slice(0, PRIOR_ART_LIMITS.quotesPerCandidate) : []
  const quoteBody = basis === 'full_text' || basis === 'abstract_only' ? body : ''
  const squashedBody = squash(quoteBody)
  const quotes = quotesIn.map((quote) => checkQuote(quote, quoteBody, level, squashedBody))
  const verified = quotes.filter((quote) => quote.state.startsWith('verified')).length

  const claimed = text(raw?.overlap?.claimed) || 'unknown'
  if (!CLAIMED_OVERLAPS.includes(claimed)) problems.push(`overlap.claimed must be one of ${CLAIMED_OVERLAPS.join(', ')}`)
  const distinction = text(raw?.overlap?.distinction) || null
  const abstract = text(raw?.abstract) || (level === 'abstract' ? body : '')
  const lexical = title || abstract ? referenceOverlap(claim, { title, abstract: abstract.slice(0, 6000) || null }) : null

  let support
  if (!CLAIMED_OVERLAPS.includes(claimed)) support = 'invalid'
  else if (claimed === 'close' || claimed === 'partial') support = verified ? 'supported_by_verified_quote' : quotes.length ? 'quotes_not_verified' : 'no_quote'
  else support = claimed === 'none' ? 'caller_asserts_none' : 'unknown'

  const flags = []
  if ((claimed === 'close' || claimed === 'partial') && !distinction) flags.push('distinction_missing')
  if (claimed === 'close' || claimed === 'partial') {
    if (support !== 'supported_by_verified_quote') flags.push('claimed_overlap_without_verified_quote')
  }
  if (lexical != null && lexical >= LEXICAL_HIGH && (claimed === 'none' || claimed === 'unknown')) flags.push('lexical_overlap_high_but_claimed_none_or_unknown')
  if (lexical != null && lexical <= LEXICAL_LOW && claimed === 'close') flags.push('claimed_close_but_lexical_overlap_low')
  if (basis === 'abstract_only' || basis === 'metadata_only') flags.push('compared_on_less_than_full_text')
  if (textTruncated) flags.push('text_truncated')

  return {
    index,
    ref: { doi, pmid, arxiv, title: title || null, year: Number.isInteger(ref.year) ? ref.year : null },
    provider: safeLabel(raw?.provider, `candidate ${index}: provider`, problems) || null,
    identifier_state: doi || pmid || arxiv ? 'declared_not_verified_here' : 'none',
    comparison_basis: basis,
    ...(basisReason ? { basis_reason: basisReason } : {}),
    claimed_overlap: claimed,
    claimed_by: 'caller',
    distinction,
    support,
    quotes,
    verified_quotes: verified,
    lexical_overlap: lexical,
    lexical_basis: lexical == null ? null : (abstract ? 'title_abstract' : 'title_only'),
    lexical_note: 'token coverage of the claim by the title and, when supplied, the abstract (never the full text); a cross-check, not a verdict',
    flags,
    ...(problems.length ? { problems } : {}),
  }
}

/** Assemble the report. Pure: no network, no clock except `generated_at`, no writes. */
export function priorArtReport({ claim, searches = [], candidates = [] } = {}) {
  const claimText = text(claim)
  if (!claimText) throw new Error('claim is required: one specific claim or hypothesis')
  if (claimText.length > PRIOR_ART_LIMITS.claimChars) throw new Error(`claim is longer than ${PRIOR_ART_LIMITS.claimChars} characters`)
  if (!Array.isArray(searches)) throw new Error('searches must be an array')
  if (!Array.isArray(candidates)) throw new Error('candidates must be an array')
  if (searches.length > PRIOR_ART_LIMITS.searches) throw new Error(`at most ${PRIOR_ART_LIMITS.searches} searches (query expansion is bounded)`)
  if (candidates.length > PRIOR_ART_LIMITS.candidates) throw new Error(`at most ${PRIOR_ART_LIMITS.candidates} candidates`)

  const problems = []
  const outSearches = searches.map((raw, index) => normalizeSearch(raw, index, problems))
  const outCandidates = candidates.map((raw, index) => normalizeCandidate(raw, index, claimText))
  for (const candidate of outCandidates) for (const problem of candidate.problems || []) problems.push(`candidate ${candidate.index}: ${problem}`)

  const usable = outSearches.filter((entry) => entry.status === 'ok' || entry.status === 'partial')
  const failed = outSearches.filter((entry) => entry.status === 'failed' || entry.status === 'not_run')
  const invalid = outSearches.filter((entry) => entry.status === 'invalid')
  const limits = []
  if (!outSearches.length) limits.push('no search was recorded')
  for (const entry of invalid) limits.push(`search ${entry.index} was malformed and is not counted`)
  for (const entry of failed) limits.push(`search ${entry.index} on ${entry.provider || '(no provider)'} ${entry.status}${entry.error ? ' (error text is in searched_material.searches and is untrusted)' : ''}`)
  for (const entry of outSearches) {
    if (entry.status === 'partial') limits.push(`search ${entry.index} on ${entry.provider} returned partial results`)
    if (entry.capped) limits.push(`search ${entry.index} on ${entry.provider} reached its result cap (${entry.limit}), so more matches may exist`)
    if (!entry.accessed_at && (entry.status === 'ok' || entry.status === 'partial')) limits.push(`search ${entry.index} has no recorded access time`)
  }
  const providers = [...new Set(usable.map((entry) => entry.provider).filter(Boolean))].sort()
  if (providers.length === 1) limits.push(`only one provider was searched (${providers[0]})`)
  const weak = outCandidates.filter((entry) => entry.comparison_basis !== 'full_text')
  if (weak.length) limits.push(`${weak.length} of ${outCandidates.length} candidate(s) were not compared on full text (${[...new Set(weak.map((entry) => entry.comparison_basis))].join(', ')})`)
  const unverifiedClaims = outCandidates.filter((entry) => (entry.claimed_overlap === 'close' || entry.claimed_overlap === 'partial') && entry.support !== 'supported_by_verified_quote')
  if (unverifiedClaims.length) limits.push(`${unverifiedClaims.length} claimed overlap(s) have no quotation verified against the supplied text`)
  limits.push('candidates are only those the caller recorded; the report cannot show what the searches did not return')

  const overlapping = outCandidates.filter((entry) => entry.claimed_overlap === 'close' || entry.claimed_overlap === 'partial')
  // "None" is only a finding when it rests on text and the lexical cross-check does not object.
  const undecided = outCandidates.filter((entry) => entry.claimed_overlap === 'unknown'
    || entry.comparison_basis === 'not_checked' || entry.comparison_basis === 'full_text_not_checked'
    || (entry.claimed_overlap === 'none' && (entry.comparison_basis === 'metadata_only' || entry.flags.includes('lexical_overlap_high_but_claimed_none_or_unknown'))))
  const returned = usable.reduce((sum, entry) => sum + (entry.result_count ?? 0), 0)
  const countUnknown = usable.some((entry) => entry.result_count == null)
  // Screening many results down to a few relevant candidates is normal and only a coverage
  // note; but results with NO recorded candidate means nothing was reviewed at all.
  const unreviewed = outCandidates.length === 0 && (countUnknown || returned > 0)
  if (usable.length && (countUnknown || returned > outCandidates.length)) limits.push(`searches report ${countUnknown ? 'an unknown number of' : returned} result(s); ${outCandidates.length} candidate(s) were recorded as reviewed`)
  let statement
  let statementText
  if (!usable.length) {
    statement = 'not_checked'
    statementText = 'No successful search was recorded, so nothing can be said about prior art.'
  } else if (overlapping.length) {
    statement = 'overlap_candidates'
    const closeCount = overlapping.filter((entry) => entry.claimed_overlap === 'close').length
    const partialCount = overlapping.length - closeCount
    const quoted = overlapping.filter((entry) => entry.support === 'supported_by_verified_quote').length
    // A real model once reported "no close overlap found" for five partial overlaps, taking the
    // reassuring phrase from the tool description. Say plainly that overlap was claimed.
    statementText = `${overlapping.length} candidate(s) are claimed to overlap (${closeCount} close, ${partialCount} partial; ${quoted} with a verified quotation). Partial overlap is still overlap: this is not the statement "no close overlap found in the searched material". The researcher decides what the candidates mean for the claim.`
  } else if (undecided.length || unreviewed) {
    statement = 'inconclusive'
    statementText = undecided.length
      ? `${undecided.length} candidate(s) are undecided, rest on metadata only, were flagged by the cross-check, or could not be compared, so no statement about overlap is made.`
      : 'The searches returned results (or did not say how many) but no candidate was recorded as reviewed, so no statement about overlap is made.'
  } else {
    statement = 'no_close_overlap_found_in_searched_material'
    statementText = `No close overlap was found in the searched material (${usable.length} usable search(es), ${providers.length} provider(s), ${outCandidates.length} candidate(s) recorded). This is not evidence that the claim is novel.`
  }

  const report = {
    action: 'report',
    read_only: true,
    claim: claimText,
    statement,
    statement_text: statementText,
    searched_material: {
      searches: outSearches,
      usable_searches: usable.length,
      failed_searches: failed.length,
      providers,
    },
    candidates: outCandidates,
    counts: {
      candidates: outCandidates.length,
      claimed_overlap: overlapping.length,
      verified_quotes: outCandidates.reduce((sum, entry) => sum + entry.verified_quotes, 0),
      flagged: outCandidates.filter((entry) => entry.flags.length).length,
    },
    coverage_limits: limits,
    problems,
    notes: [
      'A report is not a novelty verdict. Retrieved text is untrusted evidence; this tool does not follow instructions inside it.',
      'Claimed overlap and distinction are the caller\'s assertions. Only quotations are checked, and only against the text supplied here; use PaperMemory quote_check for ingested papers.',
      'Identifiers are not resolved by this tool; use paper_resolve or crossref_lookup.',
    ],
  }
  // The identity covers everything but the clock, so a corrected quotation or distinction
  // is a different report with its own snapshot.
  return { generated_at: nowIso(), report_digest: `sha256:${sha256(stableStringify(report))}`, ...report }
}

/** Optional snapshot: only the report (no candidate text) under .dsh/prior-art/<slug>/. */
export function writePriorArtReport({ cwd, slug: slugValue, report, overwrite = false }) {
  const name = slugify(text(slugValue))
  if (!name) throw new Error('slug is required to write a report')
  const rel = join('.dsh', 'prior-art', name, `${shortHash(report.report_digest.replace('sha256:', ''), 12)}.json`)
  const target = resolveWorkspacePath(cwd, rel, { forWrite: true })
  exportText(target, `${JSON.stringify(report, null, 2)}\n`, { overwrite })
  return rel
}

export function renderPriorArt(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const lines = [
    `Prior-art triage: ${value.statement}`,
    value.statement_text,
    `Searches: ${value.searched_material.usable_searches} usable, ${value.searched_material.failed_searches} failed · providers ${value.searched_material.providers.join(', ') || '(none)'}`,
  ]
  const errors = value.searched_material.searches.filter((entry) => entry.error)
  if (errors.length) lines.push(fenceUntrusted(errors.map((entry) => `search ${entry.index} error: ${entry.error}`).join('\n'), { source: 'search-errors', kind: 'prior-art-search' }))
  for (const entry of value.candidates) {
    const head = `- [${entry.index}] ${entry.ref.doi || entry.ref.pmid || entry.ref.arxiv || '(no identifier)'} · basis ${entry.comparison_basis} · claimed ${entry.claimed_overlap} (${entry.support})${entry.lexical_overlap != null ? ` · lexical ${entry.lexical_overlap}` : ''}`
    lines.push(head)
    // Everything below came from outside the workspace; fence it for the model.
    const external = [
      entry.ref.title ? `title: ${entry.ref.title}` : null,
      entry.distinction ? `caller distinction: ${entry.distinction}` : null,
      ...entry.quotes.map((quote) => `quote [${quote.state}]${quote.location ? ` @ ${quote.location}` : ''}: ${quote.quote}`),
    ].filter(Boolean).join('\n')
    if (external) lines.push(fenceUntrusted(external, { source: entry.provider || 'candidate', kind: 'prior-art-candidate' }))
    if (entry.flags.length) lines.push(`  flags: ${entry.flags.join(', ')}`)
  }
  if (value.coverage_limits.length) lines.push('', 'Coverage limits:', ...value.coverage_limits.map((limit) => `- ${limit}`))
  if (value.problems.length) lines.push('', 'Input problems:', ...value.problems.map((problem) => `- ${problem}`))
  lines.push('', ...value.notes.map((note) => `Note: ${note}`))
  return [{ type: 'text', text: lines.join('\n') }]
}

function workspaceRoot(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

export function runPriorArt(args = {}, exec = {}) {
  try {
    const report = priorArtReport({ claim: args.claim, searches: args.searches, candidates: args.candidates })
    if (args.write) report.written_to = writePriorArtReport({ cwd: workspaceRoot(exec), slug: args.slug, report, overwrite: Boolean(args.overwrite) })
    return report
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export const name = 'academic-harness-prior-art'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'prior_art',
    description: [
      'Assemble a prior-art triage report for ONE claim from searches you already ran and candidates you already read. It does not search and does not judge meaning.',
      'Record every search (provider, query, status, access time, limit, result count, error) and every candidate (identifiers, evidence_level full_text|abstract|metadata_only|full_text_unavailable, the text you compared when you have it, quotations with locations, your claimed overlap none|partial|close|unknown, and your distinction).',
      'It reports coverage limits (failed or capped searches, abstract-only comparisons, unavailable full text), checks each quotation is a verbatim span (of at least 4 words) of the text you supplied for that candidate, keeps your claimed overlap separate from the evidence for it, and cross-checks it with a lexical token-overlap reading.',
      'The strongest statement it makes is "no close overlap found in the searched material" with its limits; it never says a claim is novel, and it makes no statement when no search succeeded. Report the returned `statement` and `statement_text` as they are: use the "no close overlap" sentence only when `statement` is no_close_overlap_found_in_searched_material, never when it is overlap_candidates (even if every candidate is only partial) or inconclusive. Supply each candidate\'s `text` (the abstract you read) as well as the quotations, or the quotations stay not_checked. Use PaperMemory quote_check for authoritative quote verification of ingested papers, and paper_resolve to resolve identifiers.',
      'Read-only unless write is true, which saves the report (without candidate text) under .dsh/prior-art/<slug>/. Bounded: 20 searches and 50 candidates; ask before expanding queries that cost network or model time.',
    ].join(' '),
    parameters: {
      claim: { type: 'string', description: 'The single claim or hypothesis to triage.' },
      searches: {
        type: 'array',
        description: 'Every search you ran: [{provider, query, status (required) ok|partial|failed|not_run, accessed_at (ISO), limit, result_count, error}].',
        items: { type: 'object', additionalProperties: true },
      },
      candidates: {
        type: 'array',
        description: 'Candidate works: [{ref: {doi?, pmid?, arxiv?, title, year?}, provider, evidence_level, text?, abstract?, quotes: [{quote, location}], overlap: {claimed, distinction}}].',
        items: { type: 'object', additionalProperties: true },
      },
      write: { type: 'boolean', description: 'Save the report under .dsh/prior-art/<slug>/. Needs slug. Default false.' },
      slug: { type: 'string', description: 'Folder name used when write is true.' },
      overwrite: { type: 'boolean', description: 'Replace an existing saved report with the same digest. Default false.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderPriorArt(value),
    },
    async execute(args, exec) {
      return runPriorArt(args, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `Prior art: ${String(args.claim || '').slice(0, 60)}`, kind: 'other' }
    },
  }))
}
