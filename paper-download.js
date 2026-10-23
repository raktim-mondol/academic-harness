/**
 * paper_download: resolve a DOI/arXiv ID to an open-access PDF and save it into
 * the workspace, or download a direct URL.
 *
 * Fallback order for a DOI: Unpaywall (needs UNPAYWALL_EMAIL) -> Europe PMC
 * open-access link -> CORE repository download -> arXiv (when the DOI is an
 * arXiv DOI). A direct `url` is tried first. The PDF magic-byte check and
 * PaperMemory ingest are unchanged.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { ingestDownloadedPaper } from './papermemory-cli.js'
import { canonicalArxivId, canonicalDoi } from './search-normalize.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'

const UNPAYWALL_URL = 'https://api.unpaywall.org/v2'
const OPENALEX_URL = 'https://api.openalex.org/works/doi:'
const EUROPE_PMC_URL = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search'
const CORE_URL = 'https://api.core.ac.uk/v3/search/works/'
const MAX_BYTES = 100 * 1024 * 1024
const PDF_MAGIC = Buffer.from('%PDF-')

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

export function resolveWorkspacePath(cwd, path) {
  const root = resolve(cwd)
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes the workspace: ${path}`)
  }
  mkdirSync(dirname(target), { recursive: true })
  const realRoot = realpathSync(root)
  const realParent = realpathSync(dirname(target))
  const parentRel = relative(realRoot, realParent)
  if (parentRel.startsWith('..') || isAbsolute(parentRel)) {
    throw new Error(`path escapes the workspace: ${path}`)
  }
  if (existsSync(target)) {
    const targetRel = relative(realRoot, realpathSync(target))
    if (targetRel.startsWith('..') || isAbsolute(targetRel)) {
      throw new Error(`path escapes the workspace: ${path}`)
    }
  }
  return target
}

export function isPrivateIp(address) {
  const family = isIP(address)
  if (family === 4) {
    const parts = address.split('.').map(Number)
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true
    if (parts[0] === 0 || parts[0] === 10 || parts[0] === 127) return true
    if (parts[0] === 169 && parts[1] === 254) return true
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
    if (parts[0] === 192 && parts[1] === 168) return true
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true
    if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true
    if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return true
    if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return true
    if (parts[0] >= 224) return true
    return false
  }
  if (family === 6) {
    const lower = address.toLowerCase()
    if (lower === '::' || lower === '::1') return true
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true
    if (/^ff[0-9a-f]{2}:/.test(lower)) return true
    if (lower.startsWith('::ffff:')) {
      const tail = lower.slice(7)
      if (isIP(tail) === 4) return isPrivateIp(tail)
      const mapped = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
      if (mapped) {
        const high = Number.parseInt(mapped[1], 16)
        const low = Number.parseInt(mapped[2], 16)
        return isPrivateIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
      }
      return true
    }
    return false
  }
  return true
}

export async function assertPublicUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`invalid URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only HTTP(S) URLs are allowed')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('localhost URLs are not allowed')
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`private/internal address is not allowed: ${host}`)
    return url
  }
  // Revalidate immediately before each hop to narrow the DNS-rebinding window.
  const addresses = await lookup(host, { all: true, verbatim: true })
  if (!addresses.length) throw new Error(`could not resolve host: ${host}`)
  const privateAddress = addresses.find((entry) => isPrivateIp(entry.address))
  if (privateAddress) {
    throw new Error(`host ${host} resolves to a private/internal address (${privateAddress.address})`)
  }
  return url
}

export function arxivIdFromDoi(doi) {
  const match = String(doi || '').match(/^10\.48550\/arxiv\.(.+)$/i)
  return match ? canonicalArxivId(match[1]) : null
}

/** Resolve a DOI to Unpaywall's best open-access location, if any. */
async function resolveOpenAccess(doi, email, signal) {
  const url = `${UNPAYWALL_URL}/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`
  const limiter = getLimiter('unpaywall', { minIntervalMs: 100 })
  const result = await limiter.run(() => fetchJson(url, {
    signal,
    headers: { 'User-Agent': searchUserAgent(email) },
  }))
  if (result.status === 404) {
    return { found: false, error: `DOI not found in Unpaywall's index: ${doi}` }
  }
  if (!result.ok) {
    return { found: false, error: `Unpaywall API error ${result.status}${result.detail ? `: ${result.detail}` : ''}` }
  }
  const body = result.data && typeof result.data === 'object' ? result.data : {}
  const loc = body.best_oa_location
  const pdfUrl = loc?.url_for_pdf || loc?.url
  if (!body.is_oa || !pdfUrl) {
    return {
      found: false,
      open_access: false,
      oa_status: body.oa_status,
      title: body.title,
      landing_page: body.doi_url ?? `https://doi.org/${doi}`,
      error: 'No open-access copy found via Unpaywall',
    }
  }
  return {
    found: true,
    pdfUrl,
    title: body.title,
    oa_status: body.oa_status,
    license: loc.license ?? null,
    host_type: loc.host_type ?? null,
    version: loc.version ?? null,
    landing_page: body.doi_url ?? `https://doi.org/${doi}`,
  }
}

/** OpenAlex's best open-access publisher PDF, free and without an email. */
export async function resolveOpenAlex(doi, { signal } = {}) {
  const [apiKey, mailto] = await Promise.all([
    resolveEnv('OPENALEX_API_KEY'),
    resolveEnv('CROSSREF_MAILTO').then((value) => value || resolveEnv('UNPAYWALL_EMAIL')),
  ])
  const params = new URLSearchParams({
    select: 'id,doi,title,open_access,best_oa_location,primary_location',
  })
  if (apiKey) params.set('api_key', apiKey)
  if (mailto) params.set('mailto', mailto)
  const limiter = getLimiter('openalex', { minIntervalMs: apiKey ? 34 : 100 })
  const result = await limiter.run(() => fetchJson(`${OPENALEX_URL}${encodeURIComponent(doi)}?${params}`, {
    signal,
    headers: { 'User-Agent': searchUserAgent(mailto) },
  }))
  if (!result.ok) return { found: false, error: `OpenAlex API error ${result.status}` }
  const work = result.data && typeof result.data === 'object' ? result.data : {}
  const pdfUrl = work.best_oa_location?.pdf_url
    || work.primary_location?.pdf_url
    || (work.open_access?.is_oa ? work.open_access.oa_url : null)
  if (!pdfUrl) return { found: false, error: 'OpenAlex has no open-access PDF URL' }
  return {
    found: true,
    pdfUrl,
    title: work.title,
    oa_status: work.open_access?.oa_status || 'open',
    license: work.best_oa_location?.license || null,
    landing_page: work.best_oa_location?.landing_page_url
      || work.primary_location?.landing_page_url
      || `https://doi.org/${doi}`,
  }
}

/** Europe PMC open-access PDF, preferring an explicit PDF link then PMC render. */
export async function resolveEuropePmc(doi, { signal } = {}) {
  const params = new URLSearchParams({
    query: `DOI:"${doi}"`,
    format: 'json',
    resultType: 'core',
    pageSize: '5',
  })
  const limiter = getLimiter('europepmc', { minIntervalMs: 200 })
  const result = await limiter.run(() => fetchJson(`${EUROPE_PMC_URL}?${params}`, {
    signal,
    retries: 1,
    headers: { 'User-Agent': searchUserAgent() },
  }))
  if (!result.ok) return { found: false, error: `Europe PMC API error ${result.status}` }
  const records = result.data?.resultList?.result || []
  const candidates = records.map((record) => {
    const urls = Array.isArray(record.fullTextUrlList?.fullTextUrl) ? record.fullTextUrlList.fullTextUrl : []
    const open = urls.filter((entry) => /open access|free/i.test(entry.availability || ''))
    return {
      record,
      open,
      pdf: open.find((entry) => /pdf/i.test(entry.documentStyle || '') || /pdf/i.test(entry.url || '')),
      landing: `https://europepmc.org/article/${record.source || 'MED'}/${record.id}`,
    }
  })
  for (const candidate of candidates) {
    if (candidate.pdf?.url) {
      return {
        found: true,
        pdfUrl: candidate.pdf.url,
        title: candidate.record.title,
        oa_status: 'open',
        landing_page: candidate.landing,
      }
    }
  }
  for (const candidate of candidates) {
    if (candidate.open[0]?.url) {
      return {
        found: true,
        pdfUrl: candidate.open[0].url,
        title: candidate.record.title,
        oa_status: 'open',
        landing_page: candidate.landing,
      }
    }
  }
  for (const candidate of candidates) {
    if (candidate.record.pmcid) {
      return {
        found: true,
        pdfUrl: `https://europepmc.org/articles/${candidate.record.pmcid}?pdf=render`,
        title: candidate.record.title,
        oa_status: 'open',
        landing_page: candidate.landing,
      }
    }
  }
  return { found: false, error: 'no open-access PDF in Europe PMC' }
}

/** CORE repository download URL for a DOI. The key is optional. */
export async function resolveCore(doi, { signal } = {}) {
  const [apiKey, email] = await Promise.all([
    resolveEnv('CORE_API_KEY'),
    resolveEnv('CROSSREF_MAILTO').then((value) => value || resolveEnv('UNPAYWALL_EMAIL')),
  ])
  const params = new URLSearchParams({ q: `doi:"${doi}"`, limit: '1' })
  const headers = { 'User-Agent': searchUserAgent(email) }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const limiter = getLimiter(apiKey ? 'core-keyed' : 'core-keyless', { minIntervalMs: 6000 })
  const result = await limiter.run(() => fetchJson(`${CORE_URL}?${params}`, {
    signal,
    retries: 0,
    headers,
  }))
  if (!result.ok) return { found: false, error: `CORE API error ${result.status}` }
  const record = result.data?.results?.[0]
  if (!record) return { found: false, error: 'DOI not found in CORE' }
  const links = Array.isArray(record.links) ? record.links : []
  const pdfUrl = record.downloadUrl
    || links.find((link) => link?.type === 'download')?.url
    || (Array.isArray(record.sourceFulltextUrls) ? record.sourceFulltextUrls[0] : null)
  if (!pdfUrl) {
    return {
      found: false,
      error: record.fullText
        ? 'CORE has inline full text but no downloadable PDF; use core_search with include_fulltext'
        : 'CORE record has no downloadable PDF',
    }
  }
  return {
    found: true,
    pdfUrl,
    title: record.title,
    oa_status: 'open',
    landing_page: `https://core.ac.uk/works/${record.id}`,
  }
}

/**
 * Yield fallback candidates lazily so resolving stops as soon as one PDF
 * downloads. Each step is `{ candidate }` or `{ attempt }`.
 */
export async function* resolvePdfSources({ doi, arxivId, email, signal } = {}) {
  const seen = new Set()
  const candidate = (entry) => {
    if (!entry?.pdfUrl || seen.has(entry.pdfUrl)) return null
    seen.add(entry.pdfUrl)
    return { candidate: entry }
  }

  if (doi && email) {
    const unpaywall = await resolveOpenAccess(doi, email, signal)
    if (unpaywall.found) {
      const step = candidate({ source: 'unpaywall', ...unpaywall })
      if (step) yield step
    } else {
      yield { attempt: { source: 'unpaywall', error: unpaywall.error || 'no open-access copy' } }
    }
  } else if (doi) {
    yield { attempt: { source: 'unpaywall', error: 'UNPAYWALL_EMAIL is not set; skipped' } }
  }

  if (doi) {
    const openalex = await resolveOpenAlex(doi, { signal })
    if (openalex.found) {
      const step = candidate({ source: 'openalex', ...openalex })
      if (step) yield step
    } else {
      yield { attempt: { source: 'openalex', error: openalex.error || 'no open-access PDF' } }
    }
  }

  if (doi) {
    const europePmc = await resolveEuropePmc(doi, { signal })
    if (europePmc.found) {
      const step = candidate({ source: 'europepmc', ...europePmc })
      if (step) yield step
    } else {
      yield { attempt: { source: 'europepmc', error: europePmc.error || 'no open-access PDF' } }
    }
  }

  if (doi) {
    const core = await resolveCore(doi, { signal })
    if (core.found) {
      const step = candidate({ source: 'core', ...core })
      if (step) yield step
    } else {
      yield { attempt: { source: 'core', error: core.error || 'no downloadable PDF' } }
    }
  }

  if (arxivId) {
    const step = candidate({
      source: 'arxiv',
      pdfUrl: `https://arxiv.org/pdf/${arxivId}`,
      oa_status: 'green',
      landing_page: `https://arxiv.org/abs/${arxivId}`,
    })
    if (step) yield step
  }
}

/** Collect the same ordered candidates eagerly. Exported for tests. */
export async function resolvePdfCandidates(args = {}) {
  const candidates = []
  const attempts = []
  for await (const step of resolvePdfSources(args)) {
    if (step.candidate) candidates.push(step.candidate)
    else if (step.attempt) attempts.push(step.attempt)
  }
  return { candidates, attempts }
}

/** Fetch a URL, capping size, validating every hop, and verifying the bytes are a PDF. */
export async function fetchPdf(url, email, signal) {
  let current = url
  let res = null
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    await assertPublicUrl(current)
    const timeout = AbortSignal.timeout(120_000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    res = await fetch(current, {
      redirect: 'manual',
      signal: combined,
      headers: {
        'User-Agent': searchUserAgent(email),
        Accept: 'application/pdf,*/*;q=0.8',
      },
    })
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location')
      try {
        await res.body?.cancel()
      } catch {
        // body may already be closed
      }
      if (!location) throw new Error(`redirect without Location from ${current}`)
      current = new URL(location, current).href
      continue
    }
    break
  }
  if (!res || [301, 302, 303, 307, 308].includes(res.status)) {
    throw new Error(`too many redirects starting at ${url}`)
  }
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status} for ${current}`)

  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    try {
      await res.body?.cancel()
    } catch {
      // body may already be closed
    }
    throw new Error(`download exceeds the ${MAX_BYTES / (1024 * 1024)}MB limit: ${current}`)
  }

  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BYTES) {
      await reader.cancel()
      throw new Error(`download exceeded the ${MAX_BYTES / (1024 * 1024)}MB limit: ${current}`)
    }
    chunks.push(value)
  }
  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)))
  if (!buffer.subarray(0, 5).equals(PDF_MAGIC)) {
    throw new Error(
      `response from ${current} is not a PDF (got ${res.headers.get('content-type') ?? 'unknown content-type'}). `
      + 'This usually means a paywall, login page, or CAPTCHA was returned instead.',
    )
  }
  return buffer
}

export const name = 'academic-harness-paper-download'
export const inject = ['tools']

/** Register the open-access paper download tool. */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'paper_download',
    description: [
      'Download a paper PDF into the workspace so it can be read in full with pdf_to_markdown, instead of relying on an abstract or a search snippet.',
      'Give doi, arxiv_id, or url. With a DOI it tries, in order: Unpaywall (needs UNPAYWALL_EMAIL, but other fallbacks still run without it), OpenAlex\'s publisher open-access PDF, Europe PMC open-access links, CORE repository downloads, and arXiv when the DOI is an arXiv DOI. A direct `url` is tried first.',
      'When no open-access PDF is found, this returns a clear "paywalled" result with every attempted source (not an error) so you can tell the user rather than fabricating content. On success the PDF is checked for PDF magic bytes and ingested into PaperMemory (mcp__papermemory__*); ingest failure does not fail the download.',
    ].join(' '),
    parameters: {
      doi: { type: 'string', description: 'DOI to resolve, e.g. "10.1371/journal.pone.0130140" (bare or as a doi.org URL).' },
      arxiv_id: { type: 'string', description: 'arXiv ID, e.g. "2301.12345". Also inferred from a 10.48550/arXiv.* DOI.' },
      url: { type: 'string', description: 'Direct URL to a PDF. Tried before DOI fallbacks; with doi, the DOI is still stored on the PaperMemory record.' },
      path: { type: 'string', required: true, description: 'Workspace-relative output path, e.g. papers/lang-2023-masai.pdf' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        if (!value.success) {
          const bits = [value.error ?? 'download failed']
          if (value.attempts?.length) {
            bits.push(...value.attempts.map((attempt) => `- ${attempt.source}: ${attempt.error}`))
          }
          if (value.landing_page) bits.push(`Landing page: ${value.landing_page}`)
          return [{ type: 'text', text: bits.join('\n') }]
        }
        const bits = [`saved ${value.path} (${(value.bytes / 1024).toFixed(0)} KB) via ${value.source}`]
        if (value.title) bits.push(`title: ${value.title}`)
        if (value.oa_status) bits.push(`oa_status: ${value.oa_status}${value.license ? `, license: ${value.license}` : ''}`)
        bits.push(`source: ${value.source_url}`)
        if (value.papermemory?.ok) {
          const key = value.papermemory.bibtex_key
          const status = value.papermemory.status || 'ingested'
          const citeState = value.papermemory.cite_state ? ` (${value.papermemory.cite_state})` : ''
          bits.push(`PaperMemory: ${status}${citeState}${key ? ` as ${key}` : ''}${value.papermemory.verified ? ' (verified)' : ' (UNVERIFIED until DOI/arXiv lookup)'}.`)
          const degraded = value.papermemory.degradation?.pages_needing_ocr_count
          if (degraded) bits.push(`OCR: ${degraded} page(s) flagged; claims from this source stay capped below verified.`)
        } else if (value.papermemory?.error) {
          bits.push(`PaperMemory ingest skipped: ${value.papermemory.error}`)
        }
        bits.push('Next: call pdf_to_markdown on this path to read it; use mcp__papermemory__papermemory_get / mcp__papermemory__papermemory_cite for stored claims and citations.')
        return [{ type: 'text', text: bits.join('\n') }]
      },
    },
    async execute(args, exec) {
      const doi = args.doi ? canonicalDoi(args.doi) : null
      if (args.doi && !doi) return { success: false, error: `invalid DOI: ${args.doi}` }
      const arxivId = canonicalArxivId(args.arxiv_id) || (doi ? arxivIdFromDoi(doi) : null)
      if (args.arxiv_id && !arxivId) return { success: false, error: `invalid arXiv ID: ${args.arxiv_id}` }
      if (!doi && !arxivId && !args.url) return { success: false, error: 'give doi, arxiv_id, or url' }

      const cwd = workspaceRoot(exec)
      let out
      try {
        out = resolveWorkspacePath(cwd, args.path)
      } catch (error) {
        return { success: false, error: error.message }
      }

      const email = await resolveEnv('UNPAYWALL_EMAIL')
      const attempts = []
      let winner = null
      let buffer = null

      if (args.url) {
        try {
          buffer = await fetchPdf(args.url, email, exec.signal)
          winner = { source: 'url', pdfUrl: args.url }
        } catch (error) {
          attempts.push({ source: 'url', url: args.url, error: error instanceof Error ? error.message : String(error) })
        }
      }
      if (exec.signal?.aborted) return { success: false, error: 'request cancelled', attempts }

      if (!buffer) {
        try {
          for await (const step of resolvePdfSources({
            doi: doi || undefined,
            arxivId: arxivId || undefined,
            email,
            signal: exec.signal,
          })) {
            if (exec.signal?.aborted) return { success: false, error: 'request cancelled', attempts }
            if (step.attempt) {
              attempts.push(step.attempt)
              continue
            }
            try {
              buffer = await fetchPdf(step.candidate.pdfUrl, email, exec.signal)
              winner = step.candidate
              break
            } catch (error) {
              attempts.push({
                source: step.candidate.source,
                url: step.candidate.pdfUrl,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }
        } catch (error) {
          if (exec.signal?.aborted) return { success: false, error: 'request cancelled', attempts }
          attempts.push({ source: 'fallback', error: error instanceof Error ? error.message : String(error) })
        }
      }

      const landingPage = winner?.landing_page || (doi ? `https://doi.org/${doi}` : (arxivId ? `https://arxiv.org/abs/${arxivId}` : args.url))
      if (!winner || !buffer) {
        return {
          success: false,
          error: 'no downloadable open-access PDF found',
          attempts,
          landing_page: landingPage,
        }
      }

      try {
        writeFileSync(out, buffer)
      } catch (error) {
        return {
          success: false,
          error: `failed to write ${args.path}: ${error instanceof Error ? error.message : String(error)}`,
          attempts,
        }
      }

      let papermemory
      try {
        papermemory = await ingestDownloadedPaper({
          path: out,
          doi: doi || undefined,
          title: winner.title,
          project: process.env.PAPERMEMORY_PROJECT?.trim(),
          cwd,
          signal: exec.signal,
        })
      } catch (error) {
        papermemory = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }

      return {
        success: true,
        path: args.path,
        source_url: winner.pdfUrl,
        source: winner.source,
        bytes: buffer.length,
        title: winner.title,
        oa_status: winner.oa_status,
        license: winner.license,
        attempts,
        landing_page: landingPage,
        papermemory,
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `Download paper: ${args.doi ?? args.arxiv_id ?? args.url ?? ''}`,
        kind: 'other',
        locations: args.path ? [{ path: args.path }] : undefined,
      }
    },
  }))
}
