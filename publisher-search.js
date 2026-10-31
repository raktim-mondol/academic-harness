/**
 * Keyed publisher search APIs (Springer Nature, IEEE Xplore).
 *
 * These complement the keyless `publishers` source, which searches the same
 * publishers through their Crossref deposits. They are implemented for parity
 * but intentionally not covered by the automated or live test suite; the user
 * will exercise them with their own keys.
 */
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { canonicalDoi, emptyPaper, yearOf } from './search-normalize.js'

function keyMissing(field, source) {
  return {
    error: `${field} is required for ${source} search`,
    code: 'key_missing',
    field,
  }
}

function providerError(source, result) {
  if (result.error === 'aborted') return { error: 'request cancelled' }
  if (result.status === 401 || result.status === 403) {
    return { error: `${source} rejected the key or this network is not entitled`, status: result.status, code: 'not_entitled', detail: result.detail ?? result.error }
  }
  if (result.status === 429) {
    return { error: `${source} quota or rate limit exceeded`, status: result.status, code: 'quota', detail: result.detail ?? result.error }
  }
  return { error: `${source} API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
}

export async function runSpringerSearch(args, exec) {
  const key = await resolveEnv('SPRINGER_API_KEY')
  if (!key) return keyMissing('SPRINGER_API_KEY', 'Springer Nature')
  const query = String(args.query || '').trim()
  if (!query) return { error: 'query is required' }

  const openAccess = Boolean(args.open_access_only)
  const endpoint = openAccess
    ? 'https://api.springernature.com/openaccess/json'
    : 'https://api.springernature.com/meta/v2/json'
  const parts = [query]
  if (args.year_min != null) parts.push(`onlinedatefrom:${Math.trunc(Number(args.year_min))}-01-01`)
  if (args.year_max != null) parts.push(`onlinedateto:${Math.trunc(Number(args.year_max))}-12-31`)
  if (args.issn) parts.push(`issn:${args.issn}`)
  const params = new URLSearchParams({
    q: parts.join(' '),
    p: String(Math.min(Math.max(Number(args.limit) || 20, 1), 50)),
    api_key: key,
  })

  const limiter = getLimiter('springer', { minIntervalMs: 1000 })
  const result = await limiter.run(() => fetchJson(`${endpoint}?${params}`, {
    signal: exec?.signal,
    headers: { 'User-Agent': searchUserAgent() },
  }))
  if (!result.ok) return providerError('Springer Nature', result)

  const results = (result.data?.records || []).map((record) => {
    const paper = emptyPaper('springer')
    paper.doi = canonicalDoi(record.doi)
    paper.title = record.title || ''
    paper.authors = (record.creators || []).map((creator) => ({ name: creator.creator })).filter((author) => author.name)
    paper.year = yearOf(String(record.publicationDate || '').slice(0, 4))
    paper.venue = record.publicationName || null
    paper.journal = paper.venue ? {
      name: paper.venue,
      issn_l: record.issn || record.eIssn || null,
      issns: [record.issn, record.eIssn].filter(Boolean),
      publisher: record.publisher || null,
    } : null
    paper.publisher = record.publisher || null
    paper.volume = record.volume || null
    paper.issue = record.number || null
    paper.pages = [record.startingPage, record.endingPage].filter(Boolean).join('-') || null
    paper.abstract = record.abstract || null
    paper.url = paper.doi ? `https://doi.org/${paper.doi}` : null
    paper.type = record.contentType || null
    paper.sources = ['springer']
    paper.source = 'springer'
    return paper
  }).filter((paper) => paper.title)
  return { source: 'springer', total: results.length, results }
}

export async function runIeeeSearch(args, exec) {
  const key = await resolveEnv('IEEE_API_KEY')
  if (!key) return keyMissing('IEEE_API_KEY', 'IEEE Xplore')
  const query = String(args.query || '').trim()
  if (!query) return { error: 'query is required' }

  const params = new URLSearchParams({
    querytext: query,
    max_records: String(Math.min(Math.max(Number(args.limit) || 20, 1), 200)),
    apikey: key,
  })
  if (args.year_min != null) params.set('start_year', String(Math.trunc(Number(args.year_min))))
  if (args.year_max != null) params.set('end_year', String(Math.trunc(Number(args.year_max))))
  if (args.issn) params.set('issn', args.issn)
  if (args.open_access_only) params.set('open_access', 'True')

  const limiter = getLimiter('ieee', { minIntervalMs: 200 })
  const result = await limiter.run(() => fetchJson(`https://ieeexploreapi.ieee.org/api/v1/search/articles?${params}`, {
    signal: exec?.signal,
    headers: { 'User-Agent': searchUserAgent() },
  }))
  if (!result.ok) return providerError('IEEE Xplore', result)

  const results = (result.data?.articles || []).map((article) => {
    const paper = emptyPaper('ieee')
    paper.doi = canonicalDoi(article.doi)
    paper.title = article.title || ''
    paper.authors = (article.authors?.authors || []).map((author) => ({ name: author.full_name })).filter((author) => author.name)
    paper.year = yearOf(article.publication_year)
    paper.venue = article.publication_title || null
    paper.journal = paper.venue ? {
      name: paper.venue,
      issn_l: article.issn || null,
      issns: article.issn ? [article.issn] : [],
      publisher: article.publisher || 'IEEE',
    } : null
    paper.publisher = article.publisher || 'IEEE'
    paper.volume = article.volume || null
    paper.issue = article.issue || null
    paper.pages = [article.start_page, article.end_page].filter(Boolean).join('-') || null
    paper.abstract = article.abstract || null
    paper.citation_count = Number.isFinite(article.citing_paper_count) ? article.citing_paper_count : null
    paper.oa_url = article.pdf_url || null
    paper.pdf_url = article.pdf_url || null
    paper.html_url = article.html_url || null
    paper.url = article.abstract_url || (paper.doi ? `https://doi.org/${paper.doi}` : null)
    paper.type = article.content_type || null
    paper.sources = ['ieee']
    paper.source = 'ieee'
    return paper
  }).filter((paper) => paper.title)
  return { source: 'ieee', total: results.length, results }
}
