/**
 * Keyed publisher full-text tiers (Wiley TDM, Elsevier ScienceDirect,
 * Springer Nature JATS). These are implemented for parity but intentionally
 * not automated-tested; they require institutional/publisher credentials.
 */
import { resolveEnv } from './credential-env.js'
import { NetGuardError, guardedDownload } from './net-guard.js'
import { fetchJson, fetchText, getLimiter, searchUserAgent } from './search-http.js'
import { canonicalDoi } from './search-normalize.js'
import { parseJatsXml, rankPassages } from './html-sections.js'

const PDF_MAGIC = Buffer.from('%PDF')
const MAX_PDF_BYTES = 25 * 1024 * 1024

function skipped(field) {
  return { skipped: true, reason: 'key_missing', field }
}

/**
 * Wiley TDM PDF. The API answers with a PDF or redirects to one, so the fetch goes
 * through the network guard: public hosts only at every hop, the token header
 * dropped if a redirect leaves api.wiley.com, a deadline that covers the body, and
 * the 25 MB cap counted on the bytes actually read. `fetch`, `lookup` and
 * `maxBytes` are injectable for tests.
 */
export async function fetchWileyPdf(doi, { signal, fetch: fetchImpl, lookup, maxBytes = MAX_PDF_BYTES } = {}) {
  const token = await resolveEnv('WILEY_TDM_TOKEN')
  if (!token) return skipped('WILEY_TDM_TOKEN')
  const clean = canonicalDoi(doi)
  if (!clean) return { error: 'invalid DOI' }
  const limiter = getLimiter('wiley-tdm', { minIntervalMs: 334 })
  return limiter.run(async () => {
    let download
    try {
      download = await guardedDownload(`https://api.wiley.com/onlinelibrary/tdm/v1/articles/${encodeURIComponent(clean)}`, {
        signal,
        fetch: fetchImpl,
        lookup,
        maxBytes,
        deadlineMs: 180_000,
        headers: {
          'Wiley-TDM-Client-Token': token,
          'User-Agent': searchUserAgent(),
          Accept: 'application/pdf',
        },
      })
    } catch (error) {
      if (!(error instanceof NetGuardError)) throw error
      if (error.code === 'http') return { error: `Wiley TDM returned HTTP ${error.status}` }
      if (error.code === 'size') return { error: `Wiley TDM PDF exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB limit` }
      return { error: `Wiley TDM request refused or failed: ${error.message}` }
    }
    const { buffer } = download
    if (!buffer.subarray(0, 4).equals(PDF_MAGIC)) return { error: 'Wiley TDM response was not a PDF (check entitlement)' }
    return { buffer }
  })
}

export async function fetchScienceDirectFull(doi, { signal } = {}) {
  const apiKey = await resolveEnv('SCOPUS_API_KEY')
  if (!apiKey) return skipped('SCOPUS_API_KEY')
  const insttoken = await resolveEnv('ELSEVIER_INSTTOKEN')
  const clean = canonicalDoi(doi)
  if (!clean) return { error: 'invalid DOI' }
  const headers = {
    'X-ELS-APIKey': apiKey,
    Accept: 'application/json',
    'User-Agent': searchUserAgent(),
  }
  if (insttoken) headers['X-ELS-Insttoken'] = insttoken
  const limiter = getLimiter('elsevier-article', { minIntervalMs: 500 })
  const result = await limiter.run(() => fetchJson(
    `https://api.elsevier.com/content/article/doi/${encodeURIComponent(clean)}?view=FULL`,
    { signal, headers },
  ))
  if (!result.ok) return { error: `ScienceDirect returned HTTP ${result.status}` }
  const full = result.data?.['full-text-retrieval-response'] || {}
  const text = String(full.originalText || '').replace(/\s+/g, ' ').trim()
  if (text.length < 100) return { error: 'ScienceDirect returned no full text for this DOI' }
  const sections = [{ heading: 'ScienceDirect Full Text', content: text.slice(0, 2000) }]
  return {
    sections,
    snippets: rankPassages(sections, '', { source: 'elsevier_sciencedirect_api' }),
    source: 'elsevier_sciencedirect_api',
  }
}

export async function fetchSpringerJats(doi, { signal } = {}) {
  const apiKey = await resolveEnv('SPRINGER_API_KEY')
  if (!apiKey) return skipped('SPRINGER_API_KEY')
  const clean = canonicalDoi(doi)
  if (!clean) return { error: 'invalid DOI' }
  const limiter = getLimiter('springer-jats', { minIntervalMs: 500 })
  for (const endpoint of ['https://api.springernature.com/openaccess/jats', 'https://api.springernature.com/xmldata/jats']) {
    const params = new URLSearchParams({ q: `doi:${clean}`, api_key: apiKey })
    const result = await limiter.run(() => fetchText(`${endpoint}?${params}`, {
      signal,
      headers: { 'User-Agent': searchUserAgent(), Accept: 'application/xml' },
    }))
    if (!result.ok || !String(result.data || '').includes('<body')) continue
    const sections = parseJatsXml(result.data)
    if (!sections.length) continue
    return {
      sections,
      snippets: rankPassages(sections, '', { source: 'springer_jats_xml' }),
      source: 'springer_jats_xml',
    }
  }
  return { error: 'Springer returned no JATS full text for this DOI' }
}
