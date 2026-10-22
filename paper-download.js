/**
 * paper_download: resolve a DOI to an open-access PDF via Unpaywall
 * (https://unpaywall.org/products/api) and save it into the workspace, or
 * download a direct URL the caller already knows about. Kept in this preset
 * alongside consensus-search.js rather than global, since it's specifically
 * an academic-search capability that needs its own credential (a contact
 * email Unpaywall's terms ask API callers to identify themselves with).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { ingestDownloadedPaper } from './papermemory-cli.js'

const UNPAYWALL_URL = 'https://api.unpaywall.org/v2'
const MAX_BYTES = 100 * 1024 * 1024
const PDF_MAGIC = Buffer.from('%PDF-')

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function resolveWorkspacePath(cwd, path) {
  const target = isAbsolute(path) ? path : resolve(cwd, path)
  if (!target.startsWith(resolve(cwd))) {
    throw new Error(`path escapes the workspace: ${path}`)
  }
  return target
}

function normalizeDoi(doi) {
  return doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '')
}

/** Resolve a DOI to Unpaywall's best open-access location, if any. */
async function resolveOpenAccess(doi, email, signal) {
  const url = `${UNPAYWALL_URL}/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`
  const res = await fetch(url, { signal })
  if (res.status === 404) {
    return { found: false, error: `DOI not found in Unpaywall's index: ${doi}` }
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    return { found: false, error: `Unpaywall API error ${res.status}: ${body.message ?? ''}`.trim() }
  }
  const loc = body.best_oa_location
  const pdfUrl = loc?.url_for_pdf || loc?.url
  if (!body.is_oa || !pdfUrl) {
    return {
      found: false,
      open_access: false,
      oa_status: body.oa_status,
      title: body.title,
      landing_page: body.doi_url ?? `https://doi.org/${doi}`,
      error: 'No open-access copy found via Unpaywall — this paper appears to be paywalled.',
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

/** Fetch a URL, capping size and verifying the response is actually a PDF before returning its bytes. */
async function fetchPdf(url, email, signal) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal,
    headers: {
      'User-Agent': `Academic Harness/1.0 (open-access paper downloader${email ? `; mailto:${email}` : ''})`,
      Accept: 'application/pdf,*/*;q=0.8',
    },
  })
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status} for ${url}`)

  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BYTES) {
      await reader.cancel()
      throw new Error(`download exceeded the ${MAX_BYTES / (1024 * 1024)}MB limit: ${url}`)
    }
    chunks.push(value)
  }
  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)))
  if (!buffer.subarray(0, 5).equals(PDF_MAGIC)) {
    const snippet = buffer.subarray(0, 200).toString('utf8').replace(/\s+/g, ' ').trim()
    throw new Error(
      `response from ${url} is not a PDF (got ${res.headers.get('content-type') ?? 'unknown content-type'}). `
      + `This usually means a paywall, login page, or CAPTCHA was returned instead. First bytes: ${snippet.slice(0, 150)}`,
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
      'Download a paper PDF into the workspace so it can be read in full with pdf_to_markdown, instead of relying',
      'on an abstract or a search snippet. Give either doi (resolved to an open-access copy via the Unpaywall API,',
      'https://unpaywall.org) or url (a direct link you already have, e.g. from search results or an arXiv page).',
      'Requires UNPAYWALL_EMAIL (Settings -> Academic Harness API keys, or env) when using doi — Unpaywall asks API',
      'callers to identify themselves with a real contact email; it does not require url. When a DOI has no',
      'open-access copy, this returns a clear "paywalled" result (not an error) with the landing-page URL so you',
      'can tell the user rather than guessing at the content or fabricating what the paper says.',
      'On success the PDF is also ingested into PaperMemory (mcp__papermemory__*) so later cite/get/recap',
      'calls can use it — ingest failure does not fail the download.',
    ].join(' '),
    parameters: {
      doi: { type: 'string', description: 'DOI to resolve via Unpaywall, e.g. "10.1371/journal.pone.0130140" (bare or as a doi.org URL). Also used to tag PaperMemory ingest when url is given.' },
      url: { type: 'string', description: 'Direct URL to a PDF to download. When set with doi, the URL is fetched and the DOI is still stored on the PaperMemory record.' },
      path: { type: 'string', required: true, description: 'Workspace-relative output path, e.g. papers/lang-2023-masai.pdf' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        if (!value.success) {
          const bits = [value.error ?? 'download failed']
          if (value.landing_page) bits.push(`Landing page: ${value.landing_page}`)
          return [{ type: 'text', text: bits.join('\n') }]
        }
        const bits = [`saved ${value.path} (${(value.bytes / 1024).toFixed(0)} KB)`]
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
      if (!args.doi && !args.url) return { success: false, error: 'give either doi or url' }

      const doi = args.doi ? normalizeDoi(args.doi) : undefined
      let pdfUrl = args.url
      let meta = {}
      if (doi) {
        const email = await resolveEnv('UNPAYWALL_EMAIL')
        if (!email && !pdfUrl) {
          return { success: false, error: 'UNPAYWALL_EMAIL is not set (Settings -> Academic Harness API keys, or the matching env var).' }
        }
        if (email) {
          const resolved = await resolveOpenAccess(doi, email, exec.signal)
          if (resolved.title) meta = { ...meta, ...resolved }
          if (!pdfUrl) {
            if (!resolved.found) {
              return { success: false, ...resolved }
            }
            pdfUrl = resolved.pdfUrl
            meta = resolved
          }
        }
      }

      const cwd = workspaceRoot(exec)
      let out
      try {
        out = resolveWorkspacePath(cwd, args.path)
      } catch (error) {
        return { success: false, error: error.message }
      }

      const email = await resolveEnv('UNPAYWALL_EMAIL')
      let buffer
      try {
        buffer = await fetchPdf(pdfUrl, email, exec.signal)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error), source_url: pdfUrl }
      }

      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, buffer)

      let papermemory
      try {
        papermemory = await ingestDownloadedPaper({
          path: out,
          doi,
          title: meta.title,
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
        source_url: pdfUrl,
        bytes: buffer.length,
        title: meta.title,
        oa_status: meta.oa_status,
        license: meta.license,
        papermemory,
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `Download paper: ${args.doi ?? args.url ?? ''}`,
        kind: 'other',
        locations: args.path ? [{ path: args.path }] : undefined,
      }
    },
  }))
}
