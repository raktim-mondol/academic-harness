/**
 * paper_backfill: give text-less PaperMemory papers their open-access full text.
 *
 * A paper added from a bibliography, a literature search or a DOI is a
 * bibliographic row (`cite_state: chunkless`): nothing can be searched, quoted or
 * cited from it. This walks those rows for a project and, for each one, tries in
 * order
 *   1. an open-access PDF (Unpaywall, OpenAlex, Europe PMC, CORE, arXiv) -> markdown
 *   2. an open-access landing page, read as markdown through Exa or Firecrawl
 * and ingests the result only when it passes a quality gate: long enough, shaped
 * like an article, the right paper (title match), not a paywall stub.
 *
 * Open access only. A paper OpenAlex does not list as open access is recorded as
 * `paywalled` and never scraped. A DOI-less, arXiv-less paper is skipped rather
 * than guessed at by title: attaching the wrong paper's text to a record is worse
 * than having none.
 *
 * Dry run is the default and makes only metadata calls. Every outcome goes to a
 * ledger so a paywalled paper is not retried for 30 days.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from 'ah-dsh-tools'
import { resolveEnv } from './credential-env.js'
import { assertPublicUrl, arxivIdFromDoi, fetchPdf, resolvePdfSources } from './paper-download.js'
import { convertPdfMarkdown } from './pdf-to-markdown.js'
import { callMcpTool } from './mcp-http.js'
import {
  LOG, cliArgs, dshHome, ingestConvertedMarkdown, papermemoryEnv, parseJsonOutput,
  projectSlugFromCwd, resolvePaperMemoryLaunch, run,
} from './papermemory-cli.js'
import { canonicalArxivId, canonicalDoi } from './search-normalize.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'

export const name = 'academic-harness-papermemory-backfill'
export const inject = ['tools']

// Days before a failed paper is retried. Ingested papers are no longer chunkless, so they never come back.
export const RETRY_AFTER_DAYS = { paywalled: 30, 'gate-failed': 30, 'no-identifier': 30, unreachable: 7, error: 1 }
const DAY = 86_400_000
const MAX_PDF_TRIES = 3
const SECTION = /^#{1,4}\s*(?:\d+\.?\s*)?(abstract|introduction|background|methods?|materials and methods|results?|discussion|conclusions?|references)\b/gim
const PAYWALL = /(access through your institution|purchase (?:this|the) (?:article|pdf)|subscribe to (?:read|continue|access)|log ?in to (?:view|read)|buy (?:this|the) article|rent (?:this|the) article|sign in to (?:view|access)|full text is not available|available to subscribers)/i

// ---- quality gate (pure) ---------------------------------------------------

function titleTokens(title) {
  return [...new Set(String(title || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((t) => t.length > 3))]
}

/** Fraction of the title's significant words found near the top of the text. */
export function titleOverlap(title, text) {
  const tokens = titleTokens(title)
  if (tokens.length < 3) return null // too short to judge
  const head = String(text || '').slice(0, 6000).toLowerCase()
  return tokens.filter((t) => head.includes(t)).length / tokens.length
}

/** Text before the reference list: an abstract page with 100 references is long, but it is not the paper. */
export function bodyLength(text) {
  const refs = [...String(text).matchAll(/^#{1,4}\s*references\b.*$|^references\s*$/gim)].pop()
  return refs && refs.index > 0 ? refs.index : String(text).length
}

export function qualityGate(markdown, { title, kind = 'pdf' } = {}) {
  const text = String(markdown || '')
  const chars = text.length
  const sections = new Set([...text.matchAll(SECTION)].map((m) => m[1].toLowerCase()))
  const body = bodyLength(text)
  const stats = { chars, body_chars: body, sections: sections.size }
  const minChars = kind === 'html' ? 8_000 : 6_000
  if (chars < minChars) return { ok: false, reason: `too-short:${chars}`, stats }
  if (kind === 'html' && PAYWALL.test(text.slice(0, 3000))) return { ok: false, reason: 'paywall-stub', stats }
  if (body < (kind === 'html' ? 5_000 : 4_000)) return { ok: false, reason: `abstract-or-stub:${body}-chars-before-references`, stats }
  const needSections = kind === 'html' ? 2 : (chars >= 20_000 ? 0 : 1)
  if (sections.size < needSections) return { ok: false, reason: `not-article-shaped:${sections.size}-sections`, stats }
  const overlap = titleOverlap(title, text)
  stats.title_overlap = overlap
  if (overlap !== null && overlap < (kind === 'html' ? 0.6 : 0.5)) return { ok: false, reason: `title-mismatch:${overlap.toFixed(2)}`, stats }
  return { ok: true, stats }
}

/**
 * Web markdown arrives wrapped in site chrome. Drop images and skip links, and cut
 * everything before the heading that is the paper's title, when there is one near the top.
 * What is stored is what is quoted from later, so this runs before ingest, never after.
 */
export function cleanWebMarkdown(markdown, title) {
  let text = String(markdown || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/^\[Skip to [^\]]*\]\([^)]*\)\s*$/gim, '')
  const tokens = titleTokens(title)
  if (tokens.length >= 3) {
    const head = text.slice(0, 8000)
    const re = /^#{1,2}\s+(.+)$/gm
    for (let m = re.exec(head); m; m = re.exec(head)) {
      const line = m[1].toLowerCase()
      if (tokens.filter((t) => line.includes(t)).length / tokens.length >= 0.6) { text = text.slice(m.index); break }
    }
  }
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

// ---- ledger -----------------------------------------------------------------

export function backfillDir() {
  return process.env.PAPERMEMORY_BACKFILL_DIR?.trim() || join(dshHome(), 'papermemory-backfill')
}

export function readLedger(dir = backfillDir()) {
  const latest = new Map()
  try {
    for (const line of readFileSync(join(dir, 'ledger.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { const row = JSON.parse(line); latest.set(row.paper_id, row) } catch { /* skip a torn line */ }
    }
  } catch { /* no ledger yet */ }
  return latest
}

export function shouldSkip(paperId, ledger, now = Date.now()) {
  const row = ledger.get(paperId)
  if (!row || row.outcome === 'ingested') return false
  const days = RETRY_AFTER_DAYS[row.outcome] ?? 1
  return now - Date.parse(row.at) < days * DAY
}

function record(dir, row) {
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'ledger.jsonl'), `${JSON.stringify(row)}\n`)
  } catch (error) {
    console.warn(`${LOG}: backfill ledger not written: ${error?.message || error}`)
  }
}

// ---- open-access metadata ---------------------------------------------------

const OPENALEX = 'https://api.openalex.org/works'

/** One batched OpenAlex call: who is open access, and where. Metadata only. */
export async function openAccessBatch(dois, { signal, fetchImpl = fetchJson } = {}) {
  const [apiKey, mailto] = await Promise.all([
    resolveEnv('OPENALEX_API_KEY'),
    resolveEnv('CROSSREF_MAILTO').then((v) => v || resolveEnv('UNPAYWALL_EMAIL')),
  ])
  const out = new Map()
  const limiter = getLimiter('openalex', { minIntervalMs: apiKey ? 34 : 100 })
  for (let i = 0; i < dois.length; i += 40) {
    const params = new URLSearchParams({
      filter: `doi:${dois.slice(i, i + 40).map((d) => `https://doi.org/${d}`).join('|')}`,
      'per-page': '50',
      select: 'doi,title,open_access,best_oa_location,locations',
    })
    if (apiKey) params.set('api_key', apiKey)
    if (mailto) params.set('mailto', mailto)
    const res = await limiter.run(() => fetchImpl(`${OPENALEX}?${params}`, { signal, headers: { 'User-Agent': searchUserAgent(mailto) } }))
    if (!res.ok) return { error: `OpenAlex API error ${res.status}`, rate_limited: res.status === 429, results: out }
    for (const work of res.data?.results || []) {
      const doi = canonicalDoi(work.doi)
      if (!doi) continue
      const oaLocs = (work.locations || []).filter((l) => l?.is_oa)
      const pages = [work.best_oa_location, ...oaLocs].map((l) => l?.landing_page_url).filter(Boolean)
      out.set(doi, {
        is_oa: Boolean(work.open_access?.is_oa),
        oa_status: work.open_access?.oa_status || null,
        has_pdf: Boolean(work.best_oa_location?.pdf_url || oaLocs.some((l) => l.pdf_url)),
        landing_urls: [...new Set(pages)].filter((u) => !/^https?:\/\/(dx\.)?doi\.org\//i.test(u)).slice(0, 3),
        title: work.title || null,
      })
    }
  }
  return { results: out }
}

// ---- reading an open-access page as markdown ---------------------------------

const EXA_CONTENTS = 'https://api.exa.ai/contents'

export async function fetchPageMarkdown(url, { signal, exaKey, firecrawlKey, accept = () => true, fetchImpl = fetchJson, mcpImpl = callMcpTool } = {}) {
  await assertPublicUrl(url)
  const tried = []
  if (exaKey) {
    const limiter = getLimiter('exa-contents', { minIntervalMs: 150 })
    const res = await limiter.run(() => fetchImpl(EXA_CONTENTS, {
      method: 'POST', retries: 0, signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': exaKey, 'User-Agent': searchUserAgent() },
      body: JSON.stringify({ urls: [url], text: { maxCharacters: 250_000 } }),
    }))
    const text = res.ok ? res.data?.results?.[0]?.text : null
    if (text && accept(text)) return { markdown: text, source: 'exa', tried }
    tried.push({ source: 'exa', error: !res.ok ? `Exa API error ${res.status}` : text ? 'text rejected by the quality gate' : 'no text returned' })
  }
  if (firecrawlKey) {
    const limiter = getLimiter('firecrawl-scrape', { minIntervalMs: 200, maxConcurrent: 2 })
    const reply = await limiter.run(() => mcpImpl({
      endpoint: `https://mcp.firecrawl.dev/${encodeURIComponent(firecrawlKey)}/v2/mcp`,
      tool: 'firecrawl_scrape',
      args: { url, formats: ['markdown'], onlyMainContent: true },
      signal, timeoutMs: 60_000,
    }))
    const text = reply.ok ? (reply.structured?.markdown || reply.structured?.data?.markdown || reply.text) : null
    if (text && accept(text)) return { markdown: text, source: 'firecrawl', tried }
    tried.push({ source: 'firecrawl', error: !reply.ok ? reply.error : text ? 'text rejected by the quality gate' : 'no text returned' })
  }
  return { markdown: null, source: null, tried }
}

// ---- identity: a title and a year are not an identifier, but a strict match can be ----------

export function titleKey(title) {
  return String(title || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '')
}

/**
 * Find a DOI for a DOI-less paper from OpenAlex, only on an exact normalized-title match
 * with a publication year within one of the stored year (a preprint and its published
 * version often differ by one). Several matches are accepted only when exactly one is an
 * arXiv DOI (same title, same years: the same paper, and arXiv is always readable).
 * Never a fuzzy match: the wrong paper's text under a record is worse than no text.
 */
export async function resolveDoiByTitle(paper, { signal, fetchImpl = fetchJson } = {}) {
  const title = String(paper.title || '').trim()
  const key = titleKey(title)
  if (title.split(/\s+/).length < 3 || key.length < 15 || title === 'Untitled' || /^[\w.-]+\.[a-z]{2,}$/i.test(title)) return { reason: 'title too short or not a title' }
  const [apiKey, mailto] = await Promise.all([resolveEnv('OPENALEX_API_KEY'), resolveEnv('CROSSREF_MAILTO').then((v) => v || resolveEnv('UNPAYWALL_EMAIL'))])
  const params = new URLSearchParams({ filter: `title.search:${title.replace(/[,|:]/g, ' ')}`, 'per-page': '8', select: 'doi,title,publication_year' })
  if (apiKey) params.set('api_key', apiKey)
  if (mailto) params.set('mailto', mailto)
  const limiter = getLimiter('openalex', { minIntervalMs: apiKey ? 34 : 100 })
  const res = await limiter.run(() => fetchImpl(`${OPENALEX}?${params}`, { signal, headers: { 'User-Agent': searchUserAgent(mailto) } }))
  if (!res.ok) return { reason: `OpenAlex API error ${res.status}`, rate_limited: res.status === 429 }
  const year = Number(paper.year) || null
  const hits = (res.data?.results || []).filter((w) => {
    const doi = canonicalDoi(w.doi)
    if (!doi || titleKey(w.title) !== key) return false
    return year === null || Math.abs((w.publication_year || 0) - year) <= 1
  }).map((w) => ({ doi: canonicalDoi(w.doi), year: w.publication_year }))
  const unique = [...new Map(hits.map((h) => [h.doi, h])).values()]
  if (unique.length === 1) return { doi: unique[0].doi, via: 'openalex-title', year: unique[0].year }
  if (unique.length === 0) return { reason: 'no exact title match' }
  const arxiv = unique.filter((h) => arxivIdFromDoi(h.doi))
  if (arxiv.length === 1) return { doi: arxiv[0].doi, via: 'openalex-title (arXiv of several)', year: arxiv[0].year }
  return { reason: `ambiguous: ${unique.length} exact title matches` }
}

/** Move a record's identity to a DOI (old identity kept as an alias). Refuses if another record owns it. */
export async function promoteIdentity(paperId, doi, { launch = resolvePaperMemoryLaunch(), signal } = {}) {
  if (!launch || launch.readOnly) return { ok: false, error: 'papermemory write unavailable' }
  const res = await run(launch.command, cliArgs(launch, ['promote', paperId, 'doi', doi, '--json']), { timeoutMs: 30_000, env: papermemoryEnv(), signal, silent: true })
  if (res.code !== 0) return { ok: false, error: (res.err || res.out || `promote exited ${res.code}`).trim().replace(/\s+/g, ' ').slice(0, 160) }
  return { ok: true }
}

// ---- one paper ----------------------------------------------------------------

function slug(value) {
  return String(value || 'paper').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'paper'
}

function frontmatter(paper, doi) {
  const clean = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim()
  const lines = ['---']
  if (doi) lines.push(`doi: ${doi}`)
  if (paper.arxiv_id && !doi) lines.push(`arxiv_id: ${clean(paper.arxiv_id)}`)
  if (paper.title && paper.title !== 'Untitled') lines.push(`title: ${clean(paper.title)}`)
  if (paper.year) lines.push(`year: ${clean(paper.year)}`)
  lines.push('---', '')
  return lines.join('\n')
}

/**
 * Try to give one chunkless paper its text. Never throws.
 * Returns { outcome: 'ingested'|'paywalled'|'gate-failed'|'no-identifier'|'error', source?, reason?, attempts }.
 * Dependencies are injectable so the flow can be tested without a network.
 */
export async function backfillOne(paper, {
  dir = backfillDir(), project, signal, email, exaKey, firecrawlKey, oa,
  deps = {},
} = {}) {
  const d = {
    resolveSources: resolvePdfSources, fetchPdf, convert: convertPdfMarkdown,
    fetchPage: fetchPageMarkdown, ingest: ingestConvertedMarkdown, write: writeFileSync,
    resolveIdentity: resolveDoiByTitle, promote: promoteIdentity, ...deps,
  }
  let doi = paper.doi ? canonicalDoi(paper.doi) : null
  let arxivId = canonicalArxivId(paper.arxiv_id) || (doi ? arxivIdFromDoi(doi) : null)
  const attempts = []
  let identity = null
  if (!doi && !arxivId) {
    const found = await d.resolveIdentity(paper, { signal })
    if (!found.doi && (found.rate_limited || /API error/.test(found.reason || ''))) {
      // A failed lookup is not an answer: record it as a transient error (retried tomorrow), never as "no identifier".
      return { outcome: 'error', reason: `title lookup failed (${found.reason})`, attempts: [{ source: 'openalex', error: found.reason }] }
    }
    if (!found.doi) return { outcome: 'no-identifier', reason: `no DOI or arXiv id; ${found.reason || 'not resolved'}`, attempts }
    const moved = await d.promote(paper.id, found.doi, { signal })
    if (!moved.ok) return { outcome: 'no-identifier', reason: `title matched ${found.doi} but it could not be attached (${moved.error})`, attempts }
    doi = found.doi
    arxivId = arxivIdFromDoi(doi)
    identity = { doi, via: found.via }
    attempts.push({ source: 'identity', error: `resolved ${doi} (${found.via}); not an error` })
    // The OpenAlex answer for this DOI is not in the batch map; ask for it now so the open-access route is known.
    if (oa && !oa.has(doi)) {
      const one = await (d.openAccessBatch || openAccessBatch)([doi], { signal })
      for (const [k, v] of one.results) oa.set(k, v)
    }
  }
  const base = join(dir, slug(project || 'all'))
  mkdirSync(base, { recursive: true })
  const stem = join(base, slug(doi || arxivId))
  let gateFailed = false

  // Read an open-access URL through Exa/Firecrawl, clean it, gate it, ingest it. Null when nothing usable.
  const readPage = async (url, kind = 'html') => {
    let page
    try {
      page = await d.fetchPage(url, {
        signal, exaKey, firecrawlKey,
        accept: (t) => qualityGate(cleanWebMarkdown(t, paper.title), { title: paper.title, kind }).ok,
      })
    } catch (e) { attempts.push({ source: 'page', url, error: e instanceof Error ? e.message : String(e) }); return null }
    attempts.push(...page.tried.map((t) => ({ ...t, url })))
    if (page.tried.some((t) => /quality gate/.test(t.error))) gateFailed = true
    if (!page.markdown) return null
    const cleaned = cleanWebMarkdown(page.markdown, paper.title)
    const gate = qualityGate(cleaned, { title: paper.title, kind })
    if (!gate.ok) {
      gateFailed = true
      attempts.push({ source: page.source, url, error: `quality gate: ${gate.reason}` })
      return null
    }
    const done = await finish(cleaned, { source: page.source, kind: 'html', converter: { name: page.source, kind: 'web-markdown', url } })
    if (done.ok) return { outcome: 'ingested', ...done, chars: gate.stats.chars, identity, attempts }
    attempts.push({ source: page.source, error: `ingest: ${done.error}` })
    return null
  }

  const finish = async (markdown, { source, kind, pdfPath, converter }) => {
    const mdPath = `${stem}.md`
    d.write(mdPath, frontmatter(paper, doi) + markdown)
    const res = await d.ingest({
      path: mdPath, pdfPath, doi: doi || undefined, project, signal, converter,
      originChannel: kind === 'html' ? 'oa-html' : 'oa-pdf',
    })
    if (!res.ok) return { error: res.error }
    return { ok: true, cite_state: res.cite_state, bibtex_key: res.bibtex_key, source, kind }
  }

  // 1. open-access PDF
  let pdfTries = 0
  try {
    for await (const step of d.resolveSources({ doi: doi || undefined, arxivId: arxivId || undefined, email, signal })) {
      if (step.attempt) { attempts.push(step.attempt); continue }
      if (pdfTries >= MAX_PDF_TRIES) break
      pdfTries += 1
      const cand = step.candidate
      let buffer
      try { buffer = await d.fetchPdf(cand.pdfUrl, email, signal) } catch (e) {
        attempts.push({ source: cand.source, error: e instanceof Error ? e.message : String(e) })
        // Publishers often refuse a bot's direct PDF fetch (HTTP 403) but the open-access file is
        // still readable through Exa or Firecrawl, which parse PDFs themselves.
        if ((exaKey || firecrawlKey) && cand.source !== 'arxiv') {
          const read = await readPage(cand.pdfUrl, 'pdf')
          if (read) return read
        }
        continue
      }
      const conv = await d.convert(buffer)
      if (!conv.success) { attempts.push({ source: cand.source, error: conv.error }); continue }
      const gate = qualityGate(conv.markdown, { title: paper.title, kind: 'pdf' })
      if (!gate.ok) { gateFailed = true; attempts.push({ source: cand.source, error: `quality gate: ${gate.reason}` }); continue }
      const pdfPath = `${stem}.pdf`
      d.write(pdfPath, buffer)
      const degraded = (conv.pages_needing_ocr || []).length > 0
      const done = await finish(conv.markdown, {
        source: cand.source, kind: 'pdf', pdfPath,
        converter: { name: 'pdf-inspector', pdf_type: conv.pdf_type, page_count: conv.page_count, pages_needing_ocr: conv.pages_needing_ocr || [], ocr_degraded: degraded },
      })
      if (done.ok) return { outcome: 'ingested', ...done, chars: gate.stats.chars, identity, attempts }
      attempts.push({ source: cand.source, error: `ingest: ${done.error}` })
    }
  } catch (error) {
    if (signal?.aborted) return { outcome: 'error', reason: 'cancelled', attempts }
    attempts.push({ source: 'fallback', error: error instanceof Error ? error.message : String(error) })
  }

  // 2. open-access landing page (never a paywalled one)
  const info = doi ? oa?.get(doi) : null
  if (info && !info.is_oa) return { outcome: 'paywalled', reason: 'OpenAlex lists no open-access copy', attempts }
  if (info?.is_oa && (exaKey || firecrawlKey)) {
    for (const url of info.landing_urls) {
      const read = await readPage(url)
      if (read) return read
    }
  }
  if (!info) return { outcome: 'error', reason: 'open-access status unknown (OpenAlex had no answer)', attempts }
  if (gateFailed) return { outcome: 'gate-failed', reason: 'text found but failed the quality gate', attempts }
  if (info?.is_oa) return { outcome: 'unreachable', reason: 'an open-access copy exists but could not be retrieved (blocked or unreadable)', attempts }
  return { outcome: 'paywalled', reason: 'no usable open-access text', attempts }
}

// ---- the batch ------------------------------------------------------------------

export async function listTextless(project, { limit = 200, launch = resolvePaperMemoryLaunch(), signal } = {}) {
  if (!launch) return { error: 'papermemory CLI not available' }
  const res = await run(launch.command, cliArgs(launch, [
    'list', '--kind', 'papers', '--cite-state', 'chunkless', '--page-size', String(Math.min(200, Math.max(1, limit))), '--json',
    ...(project ? ['--project', project] : []),
  ]), { timeoutMs: 60_000, env: papermemoryEnv(), signal, silent: true })
  const parsed = parseJsonOutput(res.out)
  if (res.code !== 0 || !parsed) return { error: (res.err || res.out || `list exited ${res.code}`).trim().slice(0, 200) }
  return { rows: parsed.rows || [], total: parsed.total_count ?? (parsed.rows || []).length }
}

export async function backfillText({
  project, limit = 10, dryRun = true, retry = false, concurrency = 3, signal, now = Date.now(),
  dir = backfillDir(), deps = {},
} = {}) {
  const listed = await (deps.listTextless || listTextless)(project, { limit: 200, signal })
  if (listed.error) return { error: listed.error }
  const ledger = readLedger(dir)
  const candidates = listed.rows.filter((p) => retry || !shouldSkip(p.id, ledger, now))
  const skipped = listed.rows.length - candidates.length
  const batch = candidates.slice(0, Math.max(1, Math.min(limit, 100)))
  const dois = batch.map((p) => (p.doi ? canonicalDoi(p.doi) : null)).filter(Boolean)
  const oaRes = dois.length ? await (deps.openAccessBatch || openAccessBatch)(dois, { signal }) : { results: new Map() }
  const oa = oaRes.results

  const summary = {
    project: project || null, dry_run: dryRun, textless_total: listed.total, considered: batch.length,
    skipped_recently_failed: skipped, ...(oaRes.error ? { openalex_error: oaRes.error } : {}),
  }
  const noId = batch.filter((p) => !p.doi && !p.arxiv_id)
  const resolved = new Map()
  for (const p of noId) {
    const found = await (deps.resolveIdentity || resolveDoiByTitle)(p, { signal })
    resolved.set(p.id, found)
    if (found.rate_limited) break
  }
  const plan = batch.map((p) => {
    if (!p.doi && !p.arxiv_id) {
      const f = resolved.get(p.id)
      return { id: p.id, doi: null, title: (p.title || '').slice(0, 90), route: f?.doi ? 'resolve-by-title' : 'no-identifier', ...(f?.doi ? { would_use: f.doi } : { why: f?.reason }) }
    }
    const info = p.doi ? oa.get(canonicalDoi(p.doi)) : null
    const route = !p.doi && !p.arxiv_id ? 'no-identifier' : p.arxiv_id && !p.doi ? 'arxiv' : !info ? 'unknown' : !info.is_oa ? 'paywalled' : info.has_pdf ? 'pdf' : info.landing_urls.length ? 'html' : 'oa-no-link'
    return { id: p.id, doi: p.doi || null, title: (p.title || '').slice(0, 90), route }
  })
  summary.expected = plan.reduce((acc, p) => { acc[p.route] = (acc[p.route] || 0) + 1; return acc }, {})
  if (dryRun) return { ...summary, plan }
  if (oaRes.rate_limited) return { ...summary, stopped: 'rate_limited', results: [] }

  const [email, exaKey, firecrawlKey] = await Promise.all([resolveEnv('UNPAYWALL_EMAIL'), resolveEnv('EXA_API_KEY'), resolveEnv('FIRECRAWL_API_KEY')])
  const results = []
  let consecutive429 = 0
  let cursor = 0
  const worker = async () => {
    while (cursor < batch.length && consecutive429 < 3 && !signal?.aborted) {
      const paper = batch[cursor++]
      const r = await backfillOne(paper, { dir, project, signal, email, exaKey, firecrawlKey, oa, deps })
      if (r.attempts?.some((a) => / 429\b|rate_limited/.test(String(a.error)))) {
        consecutive429 += 1
        await (deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(3000) // back off before the next paper
      } else consecutive429 = 0
      results.push({ id: paper.id, doi: paper.doi || null, title: (paper.title || '').slice(0, 90), ...r })
      record(dir, { at: new Date(now).toISOString(), paper_id: paper.id, doi: paper.doi || null, outcome: r.outcome, source: r.source || null, reason: r.reason || null, chars: r.chars || null, cite_state: r.cite_state || null, identity: r.identity || null })
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  const count = (o) => results.filter((r) => r.outcome === o).length
  return {
    ...summary,
    ingested: count('ingested'), paywalled: count('paywalled'), gate_failed: count('gate-failed'),
    no_identifier: count('no-identifier'), unreachable: count('unreachable'), errors: count('error'),
    citable_now: results.filter((r) => r.outcome === 'ingested' && r.cite_state === 'citable').length,
    ...(consecutive429 >= 3 ? { stopped: 'rate_limited' } : {}),
    results,
  }
}

// ---- tool ---------------------------------------------------------------------------

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'paper_backfill',
    description: [
      'Give text-less papers in PaperMemory their open-access full text, so they can be searched, quoted and cited.',
      'A paper added from a bibliography or a search is only a bibliographic row (cite_state chunkless); this fetches an open-access PDF, or an open-access page read as markdown, checks it is the right paper and long enough, and ingests it.',
      'Dry run by default: it reports how many are open access and by which route, using metadata only. Set dry_run to false to download and ingest. Paywalled papers are never scraped and are not retried for 30 days.',
    ].join(' '),
    parameters: {
      project: { type: 'string', description: 'PaperMemory project slug. Defaults to the one resolved from the workspace.' },
      limit: { type: 'integer', description: 'How many papers to process (default 10, max 100).' },
      dry_run: { type: 'boolean', description: 'Default true. false downloads and ingests.' },
      retry: { type: 'boolean', description: 'Also retry papers that failed or were paywalled recently.' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        if (value.error) return [{ type: 'text', text: `paper_backfill: ${value.error}` }]
        const lines = [`${value.dry_run ? 'Dry run' : 'Backfill'} for ${value.project ?? 'all projects'}: ${value.textless_total} papers have no text; ${value.considered} considered${value.skipped_recently_failed ? `, ${value.skipped_recently_failed} skipped (failed recently)` : ''}.`]
        if (value.expected) lines.push(`Expected routes: ${Object.entries(value.expected).map(([k, v]) => `${k} ${v}`).join(', ')}.`)
        if (!value.dry_run) {
          lines.push(`Ingested ${value.ingested} (${value.citable_now} citable), paywalled ${value.paywalled}, open access but unreachable ${value.unreachable}, failed quality gate ${value.gate_failed}, no identifier ${value.no_identifier}, errors ${value.errors}.`)
          for (const r of (value.results || []).filter((x) => x.outcome !== 'ingested').slice(0, 8)) lines.push(`- ${r.doi || r.id}: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`)
        }
        if (value.stopped) lines.push(`Stopped early: ${value.stopped}. Run again later.`)
        if (value.dry_run) lines.push('Nothing was downloaded. Call again with dry_run false to ingest.')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const cwd = exec.agent?.session?.header?.cwd
      const project = args.project || process.env.PAPERMEMORY_PROJECT?.trim() || projectSlugFromCwd(cwd)
      return backfillText({ project, limit: Number(args.limit) || 10, dryRun: args.dry_run !== false, retry: args.retry === true, signal: exec.signal })
    },
    presentCall(args) {
      return { card: 'generic', title: `Backfill paper text${args.dry_run === false ? '' : ' (dry run)'}`, kind: 'other' }
    },
  }))
}

