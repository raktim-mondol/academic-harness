/**
 * journal_search: journal and venue discovery with open metrics.
 *
 * Free sources are OpenAlex /sources, DOAJ v4 journals, and Crossref journals.
 * Elsevier Serial Title and WoS JCR enrichments are keyed and implemented but
 * not exercised by the automated test suite; they are skipped silently when
 * their key is unset.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { canonicalDoi, emptyPaper, normalizeTitle, yearOf } from './search-normalize.js'

const OPENALEX = 'https://api.openalex.org'
const DOAJ = 'https://doaj.org/api/v4'
const CROSSREF = 'https://api.crossref.org/v1'
const SOURCE_SELECT = [
  'id', 'display_name', 'issn_l', 'issn', 'host_organization_name', 'is_oa', 'is_in_doaj',
  'apc_usd', 'homepage_url', 'summary_stats', 'works_count', 'cited_by_count', 'topics',
  'counts_by_year', 'type', 'country_code',
].join(',')
const PROVIDERS = ['openalex', 'doaj', 'crossref']

function emptyJournal(source) {
  return {
    id: null,
    title: '',
    issn_l: null,
    issns: [],
    publisher: null,
    host_organization: null,
    country_code: null,
    type: 'journal',
    is_oa: null,
    is_in_doaj: null,
    apc_usd: null,
    oa_license: null,
    homepage_url: null,
    metrics: {},
    topics: [],
    counts_by_year: [],
    sources: [source],
  }
}

function unique(values) {
  return [...new Set((values || []).filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))]
}

export function fromOpenAlexSource(item) {
  if (!item || typeof item !== 'object') return null
  const stats = item.summary_stats || {}
  const journal = emptyJournal('openalex')
  journal.id = item.id ? `openalex:${String(item.id).replace('https://openalex.org/', '')}` : null
  journal.title = item.display_name || 'Unknown journal'
  journal.issn_l = item.issn_l || null
  journal.issns = unique(item.issn)
  journal.publisher = item.host_organization_name || null
  journal.host_organization = item.host_organization_name || null
  journal.country_code = item.country_code || null
  journal.type = item.type || 'journal'
  journal.is_oa = item.is_oa ?? null
  journal.is_in_doaj = item.is_in_doaj ?? null
  journal.apc_usd = item.apc_usd ?? null
  journal.homepage_url = item.homepage_url || null
  journal.metrics = {
    two_year_mean_citedness: stats['2yr_mean_citedness'] ?? null,
    h_index: stats.h_index ?? null,
    i10_index: stats.i10_index ?? null,
    works_count: item.works_count ?? null,
    cited_by_count: item.cited_by_count ?? null,
  }
  journal.topics = (item.topics || []).map((topic) => topic?.display_name).filter(Boolean).slice(0, 8)
  journal.counts_by_year = (item.counts_by_year || []).slice(0, 5)
  return journal
}

export function fromDoajJournal(result) {
  if (!result || typeof result !== 'object') return null
  const bib = result.bibjson || {}
  const issns = unique([bib.pissn, bib.eissn])
  const apc = bib.apc || {}
  let apcUsd = null
  if (apc.has_apc && Array.isArray(apc.max)) {
    for (const amount of apc.max) {
      if (amount?.currency === 'USD' && Number.isFinite(Number(amount.price))) {
        apcUsd = Number(amount.price)
        break
      }
    }
  }
  const licenses = (bib.license || []).map((license) => license?.type).filter(Boolean)
  const journal = emptyJournal('doaj')
  journal.id = result.id ? `doaj:${result.id}` : null
  journal.title = bib.title || 'Unknown DOAJ journal'
  journal.issn_l = issns[0] || null
  journal.issns = issns
  journal.publisher = bib.publisher?.name || null
  journal.country_code = bib.publisher?.country || null
  journal.is_oa = true
  journal.is_in_doaj = true
  journal.apc_usd = apcUsd
  journal.oa_license = licenses[0] || null
  journal.homepage_url = bib.ref?.journal || null
  journal.metrics = {}
  journal.topics = (bib.subject || []).map((subject) => subject?.term).filter(Boolean).slice(0, 8)
  return journal
}

export function fromCrossrefJournal(message) {
  if (!message || typeof message !== 'object') return null
  const issns = unique(message.ISSN)
  const counts = message.counts || {}
  const journal = emptyJournal('crossref')
  journal.id = issns.length ? `crossref:${issns[0]}` : `crossref:${message.title || 'journal'}`
  journal.title = Array.isArray(message.title) ? (message.title[0] || 'Unknown journal') : (message.title || 'Unknown journal')
  journal.issn_l = issns[0] || null
  journal.issns = issns
  journal.publisher = message.publisher || null
  journal.type = 'journal'
  journal.metrics = { works_count: counts['total-dois'] ?? null }
  journal.topics = (message.subjects || []).map((subject) => subject?.name).filter(Boolean).slice(0, 8)
  return journal
}

export function mergeJournals(journals) {
  const merged = []
  const byIssn = new Map()
  const byTitle = new Map()
  for (const journal of journals) {
    if (!journal || !journal.title) continue
    const titleKey = normalizeTitle(journal.title)
    let position = -1
    for (const issn of journal.issns || []) {
      if (byIssn.has(issn)) {
        position = byIssn.get(issn)
        break
      }
    }
    if (position < 0 && titleKey && byTitle.has(titleKey)) position = byTitle.get(titleKey)

    if (position < 0) {
      const copy = { ...journal, issns: [...journal.issns], topics: [...journal.topics], sources: [...journal.sources], metrics: { ...journal.metrics } }
      merged.push(copy)
      position = merged.length - 1
    } else {
      const target = merged[position]
      target.issn_l = target.issn_l || journal.issn_l
      target.issns = [...new Set([...target.issns, ...(journal.issns || [])])]
      target.publisher = target.publisher || journal.publisher
      target.host_organization = target.host_organization || journal.host_organization
      target.country_code = target.country_code || journal.country_code
      target.homepage_url = target.homepage_url || journal.homepage_url
      target.oa_license = target.oa_license || journal.oa_license
      if (target.is_oa == null && journal.is_oa != null) target.is_oa = journal.is_oa
      if (target.is_in_doaj == null && journal.is_in_doaj != null) target.is_in_doaj = journal.is_in_doaj
      if (target.apc_usd == null && journal.apc_usd != null) target.apc_usd = journal.apc_usd
      for (const [key, value] of Object.entries(journal.metrics || {})) {
        if (target.metrics[key] == null && value != null) target.metrics[key] = value
      }
      target.topics = [...new Set([...target.topics, ...(journal.topics || [])])]
      target.sources = [...new Set([...target.sources, ...(journal.sources || [])])]
    }
    for (const issn of journal.issns || []) byIssn.set(issn, position)
    if (titleKey) byTitle.set(titleKey, position)
  }

  for (const journal of merged) {
    const exact = journal.title.trim().toLowerCase()
    journal._rank = [
      exact ? 1 : 0,
      journal.sources.length,
      journal.metrics.works_count || 0,
    ]
  }
  merged.sort((a, b) => {
    for (let index = 0; index < a._rank.length; index += 1) {
      if (a._rank[index] !== b._rank[index]) return b._rank[index] - a._rank[index]
    }
    return a.title.localeCompare(b.title)
  })
  for (const journal of merged) delete journal._rank
  return merged
}

async function crossrefMailto() {
  return await resolveEnv('CROSSREF_MAILTO') || await resolveEnv('UNPAYWALL_EMAIL') || ''
}

async function fetchOpenAlexJournals({ query, issn, openAccessOnly, limit, signal }) {
  const [apiKey, mailto] = await Promise.all([resolveEnv('OPENALEX_API_KEY'), crossrefMailto()])
  const params = new URLSearchParams({ per_page: String(Math.min(Math.max(limit, 1), 50)) })
  if (apiKey) params.set('api_key', apiKey)
  if (mailto) params.set('mailto', mailto)
  if (query) params.set('search', query)
  const filters = []
  if (issn) filters.push(`issn:${issn}`)
  if (openAccessOnly) filters.push('is_oa:true')
  if (filters.length) params.set('filter', filters.join(','))
  params.set('select', SOURCE_SELECT)

  const semantic = Boolean(query)
  const limiter = getLimiter(semantic ? 'openalex-semantic' : 'openalex', { minIntervalMs: semantic ? 1000 : (apiKey ? 34 : 100) })
  const url = issn && !query
    ? `${OPENALEX}/sources/issn:${encodeURIComponent(issn)}?${params}`
    : `${OPENALEX}/sources?${params}`
  const result = await limiter.run(() => fetchJson(url, {
    signal,
    headers: { 'User-Agent': searchUserAgent(mailto) },
  }))
  if (!result.ok) return { error: `OpenAlex sources API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
  if (issn && !query) {
    return { results: result.data ? [fromOpenAlexSource(result.data)].filter(Boolean) : [] }
  }
  return { results: (result.data?.results || []).map(fromOpenAlexSource).filter(Boolean) }
}

function doajPath(term) {
  return `${DOAJ}/search/journals/${encodeURIComponent(String(term)).replace(/%2F/gi, '%5C/')}`
}

async function fetchDoajJournals({ query, issn, limit, signal }) {
  const term = issn && !query ? `issn:"${issn}"` : (query || '*')
  const params = new URLSearchParams({ pageSize: String(Math.min(Math.max(limit, 1), 50)) })
  const limiter = getLimiter('doaj', { minIntervalMs: 200 })
  const result = await limiter.run(() => fetchJson(`${doajPath(term)}?${params}`, {
    signal,
    headers: { 'User-Agent': searchUserAgent() },
  }))
  if (!result.ok) return { error: `DOAJ API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
  return { results: (result.data?.results || []).map(fromDoajJournal).filter(Boolean) }
}

async function fetchCrossrefJournals({ query, issn, limit, signal }) {
  const mailto = await crossrefMailto()
  const params = new URLSearchParams({ rows: String(Math.min(Math.max(limit, 1), 50)) })
  if (mailto) params.set('mailto', mailto)
  if (query) params.set('query', query)
  const limiter = getLimiter('crossref-list', { minIntervalMs: mailto ? 334 : 1000 })
  const url = issn && !query
    ? `${CROSSREF}/journals/${encodeURIComponent(issn)}?${params}`
    : `${CROSSREF}/journals?${params}`
  const result = await limiter.run(() => fetchJson(url, {
    signal,
    headers: { 'User-Agent': searchUserAgent(mailto) },
  }))
  if (!result.ok) return { error: `Crossref journals API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
  if (issn && !query) {
    return { results: result.data?.message ? [fromCrossrefJournal(result.data.message)].filter(Boolean) : [] }
  }
  return { results: (result.data?.message?.items || []).map(fromCrossrefJournal).filter(Boolean) }
}

export async function runDoajArticles(args, exec) {
  const query = String(args.query || '').trim()
  if (!query) return { error: 'query is required' }
  const params = new URLSearchParams({ pageSize: String(Math.min(Math.max(Number(args.limit) || 20, 1), 50)) })
  const limiter = getLimiter('doaj', { minIntervalMs: 200 })
  const result = await limiter.run(() => fetchJson(`${DOAJ}/search/articles/${encodeURIComponent(query).replace(/%2F/gi, '%5C/')}?${params}`, {
    signal: exec?.signal,
    headers: { 'User-Agent': searchUserAgent() },
  }))
  if (!result.ok) return { error: `DOAJ article API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
  const results = (result.data?.results || []).map((record) => {
    const bib = record.bibjson || {}
    let doi = null
    const issns = []
    for (const identifier of bib.identifier || []) {
      if (identifier?.type === 'doi') doi = canonicalDoi(identifier.id) || doi
      if (identifier?.type === 'pissn' || identifier?.type === 'eissn') issns.push(identifier.id)
    }
    const links = bib.link || []
    const pdf = links.find((link) => link?.type === 'fulltext' && (/pdf/i.test(link.content_type || '') || /\.pdf($|\?)/i.test(link.url || '')))
    const landing = links.find((link) => link?.type === 'fulltext' && link !== pdf)
    const paper = emptyPaper('doaj')
    paper.source_id = record.id || null
    paper.doi = doi
    paper.title = bib.title || ''
    paper.authors = (bib.author || []).filter((author) => author?.name).map((author) => ({ name: author.name }))
    paper.year = yearOf(bib.year)
    paper.venue = bib.journal?.title || null
    paper.journal = paper.venue ? {
      name: paper.venue,
      issn_l: issns[0] || null,
      issns: unique(issns),
      publisher: bib.journal?.publisher || null,
      is_oa: true,
      is_in_doaj: true,
    } : null
    paper.volume = bib.journal?.volume || null
    paper.issue = bib.journal?.number || null
    paper.pages = [bib.start_page, bib.end_page].filter(Boolean).join('-') || null
    paper.abstract = bib.abstract || null
    paper.oa_status = 'gold'
    paper.oa_url = pdf?.url || landing?.url || null
    paper.pdf_url = pdf?.url || null
    paper.url = landing?.url || pdf?.url || null
    paper.type = 'journal-article'
    paper.fields = (bib.subject || []).map((subject) => subject?.term).filter(Boolean).slice(0, 8)
    paper.sources = ['doaj']
    return paper
  }).filter((paper) => paper.title)
  return { source: 'doaj', total: results.length, results }
}

async function elsevierSerialMetrics(issn, { signal }) {
  const apiKey = await resolveEnv('SCOPUS_API_KEY')
  if (!apiKey) return null
  const insttoken = await resolveEnv('ELSEVIER_INSTTOKEN')
  const headers = { 'X-ELS-APIKey': apiKey, Accept: 'application/json', 'User-Agent': searchUserAgent() }
  if (insttoken) headers['X-ELS-Insttoken'] = insttoken
  const limiter = getLimiter('elsevier-serial', { minIntervalMs: 500 })
  const result = await limiter.run(() => fetchJson(
    `https://api.elsevier.com/content/serial/title/issn/${encodeURIComponent(issn)}`,
    { signal, headers },
  ))
  if (!result.ok) return { error: `Elsevier Serial Title HTTP ${result.status}` }
  const entry = result.data?.['serial-metadata-response']?.entry?.[0]
  if (!entry) return null
  const citescore = entry.citeScoreYearInfoList?.citeScoreCurrentMetric
  const sjr = entry.SJRList?.SJR?.[0]?.$
  const snip = entry.SNIPList?.SNIP?.[0]?.$
  return {
    citescore: citescore != null && Number.isFinite(Number(citescore)) ? Number(citescore) : null,
    sjr: sjr != null && Number.isFinite(Number(sjr)) ? Number(sjr) : null,
    snip: snip != null && Number.isFinite(Number(snip)) ? Number(snip) : null,
  }
}

async function wosJcrMetrics(issn, { signal }) {
  const apiKey = await resolveEnv('WOS_API_KEY')
  if (!apiKey) return null
  const headers = { 'X-ApiKey': apiKey, Accept: 'application/json', 'User-Agent': searchUserAgent() }
  const limiter = getLimiter('wos-jcr', { minIntervalMs: 1000 })
  const search = await limiter.run(() => fetchJson(
    `https://api.clarivate.com/apis/wos-journals/v1/journals?q=${encodeURIComponent(issn)}&limit=1`,
    { signal, headers },
  ))
  if (!search.ok) return { error: `WoS JCR search HTTP ${search.status}` }
  const journalId = search.data?.hits?.[0]?.id
  if (!journalId) return null
  const currentYear = new Date().getUTCFullYear() - 1
  for (const year of [currentYear, currentYear - 1]) {
    const report = await limiter.run(() => fetchJson(
      `https://api.clarivate.com/apis/wos-journals/v1/journals/${encodeURIComponent(journalId)}/reports/year/${year}`,
      { signal, headers },
    ))
    if (!report.ok) continue
    const metrics = report.data?.metrics?.impactMetrics || {}
    const rank = report.data?.ranks?.[0] || {}
    return {
      jif: metrics.jif != null && Number.isFinite(Number(metrics.jif)) ? Number(metrics.jif) : null,
      jci: metrics.jci != null && Number.isFinite(Number(metrics.jci)) ? Number(metrics.jci) : null,
      jif_quartile: rank.quartile || null,
      jif_percentile: rank.jifPercentile != null && Number.isFinite(Number(rank.jifPercentile)) ? Number(rank.jifPercentile) : null,
    }
  }
  return null
}

function rankJournals(journals, query) {
  const exact = String(query || '').trim().toLowerCase()
  return [...journals].sort((a, b) => {
    const aExact = exact && a.title.trim().toLowerCase() === exact ? 1 : 0
    const bExact = exact && b.title.trim().toLowerCase() === exact ? 1 : 0
    if (aExact !== bExact) return bExact - aExact
    if (a.sources.length !== b.sources.length) return b.sources.length - a.sources.length
    return (b.metrics.works_count || 0) - (a.metrics.works_count || 0)
  })
}

export function renderJournals(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const bits = [
    `Journal search: ${value.query || value.issn || '*'} · sources: ${(value.providers_queried || []).join(', ')}`,
    `${value.journals?.length || 0} journal(s)`,
  ]
  if (value.warnings?.length) bits.push(`warnings: ${value.warnings.join('; ')}`)
  if (value.failures?.length) bits.push(`failed: ${value.failures.map((entry) => `${entry.source} (${entry.error})`).join('; ')}`)
  for (const journal of value.journals || []) {
    const metrics = journal.metrics || {}
    const metricBits = [
      metrics.two_year_mean_citedness != null ? `2yr mean citedness ${metrics.two_year_mean_citedness}` : null,
      metrics.h_index != null ? `h-index ${metrics.h_index}` : null,
      metrics.i10_index != null ? `i10 ${metrics.i10_index}` : null,
      metrics.works_count != null ? `${metrics.works_count} works` : null,
      metrics.citescore != null ? `CiteScore ${metrics.citescore}` : null,
      metrics.sjr != null ? `SJR ${metrics.sjr}` : null,
      metrics.snip != null ? `SNIP ${metrics.snip}` : null,
      metrics.jif != null ? `JIF ${metrics.jif}` : null,
      metrics.jif_quartile ? `${metrics.jif_quartile}` : null,
    ].filter(Boolean)
    const flags = [
      journal.is_oa ? 'OA' : null,
      journal.is_in_doaj ? 'DOAJ' : null,
      journal.apc_usd != null ? `APC $${journal.apc_usd}` : null,
      journal.oa_license || null,
    ].filter(Boolean)
    bits.push([
      `**${journal.title}**`,
      [journal.publisher, journal.issn_l || journal.issns?.[0], journal.country_code].filter(Boolean).join(' · '),
      metricBits.length ? metricBits.join(' · ') : 'no metrics returned',
      flags.length ? flags.join(' · ') : null,
      journal.homepage_url || null,
      `sources: ${journal.sources.join(', ')}`,
    ].filter(Boolean).join('\n'))
  }
  return [{ type: 'text', text: bits.join('\n\n') }]
}

export async function runJournalSearch(args, exec) {
  const query = String(args.query || '').trim()
  const issn = String(args.issn || '').trim()
  if (!query && !issn) return { error: 'give query or issn' }
  const rawProviders = args.providers == null || args.providers === ''
    ? PROVIDERS
    : (Array.isArray(args.providers) ? args.providers : String(args.providers).split(','))
  const providers = [...new Set(rawProviders.map((provider) => String(provider).trim().toLowerCase()).filter(Boolean))]
  if (!providers.length) return { error: `providers must include one of ${PROVIDERS.join(', ')}` }
  const invalid = providers.find((provider) => !PROVIDERS.includes(provider))
  if (invalid) return { error: `unknown journal provider "${invalid}"; use ${PROVIDERS.join(', ')}` }
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50)
  const warnings = []
  const failures = []

  const requests = providers.map((provider) => {
    if (provider === 'openalex') return { provider, promise: fetchOpenAlexJournals({ query, issn, openAccessOnly: Boolean(args.open_access_only), limit, signal: exec?.signal }) }
    if (provider === 'doaj') return { provider, promise: fetchDoajJournals({ query, issn, limit, signal: exec?.signal }) }
    return { provider, promise: fetchCrossrefJournals({ query, issn, limit, signal: exec?.signal }) }
  })
  const settled = await Promise.allSettled(requests.map((request) => request.promise))
  const all = []
  settled.forEach((entry, index) => {
    const provider = requests[index].provider
    if (entry.status === 'rejected') {
      failures.push({ source: provider, error: entry.reason?.message || String(entry.reason) })
      return
    }
    const value = entry.value
    if (!value || value.error) {
      failures.push({ source: provider, error: value?.error || 'no result' })
      return
    }
    all.push(...(value.results || []))
  })

  let merged = mergeJournals(all)
  if (args.open_access_only) merged = merged.filter((journal) => journal.is_oa || journal.is_in_doaj)

  const missingMetrics = merged
    .filter((journal) => journal.metrics.two_year_mean_citedness == null && (journal.issn_l || journal.issns.length))
    .slice(0, 10)
  for (const journal of missingMetrics) {
    const targetIssn = journal.issn_l || journal.issns[0]
    try {
      const enriched = await fetchOpenAlexJournals({ issn: targetIssn, limit: 1, signal: exec?.signal })
      const source = enriched.results?.[0]
      if (source) {
        journal.metrics = { ...source.metrics, ...journal.metrics }
        journal.apc_usd = journal.apc_usd ?? source.apc_usd
        journal.is_oa = journal.is_oa ?? source.is_oa
        journal.is_in_doaj = journal.is_in_doaj ?? source.is_in_doaj
        journal.homepage_url = journal.homepage_url || source.homepage_url
        journal.topics = [...new Set([...journal.topics, ...source.topics])]
        journal.sources = [...new Set([...journal.sources, 'openalex'])]
      }
    } catch (error) {
      warnings.push(`OpenAlex ISSN enrichment failed for ${targetIssn}: ${error.message}`)
    }
  }

  if (args.include_keyed_metrics !== false) {
    for (const journal of merged.slice(0, Math.min(limit, 10))) {
      const targetIssn = journal.issn_l || journal.issns[0]
      if (!targetIssn) continue
      try {
        const elsevier = await elsevierSerialMetrics(targetIssn, { signal: exec?.signal })
        if (elsevier?.error) warnings.push(elsevier.error)
        else if (elsevier) {
          journal.metrics = { ...journal.metrics, ...Object.fromEntries(Object.entries(elsevier).filter(([, value]) => value != null)) }
          if (!journal.sources.includes('elsevier')) journal.sources.push('elsevier')
        }
      } catch (error) {
        warnings.push(`Elsevier Serial Title failed for ${targetIssn}: ${error.message}`)
      }
      try {
        const jcr = await wosJcrMetrics(targetIssn, { signal: exec?.signal })
        if (jcr?.error) warnings.push(jcr.error)
        else if (jcr) {
          journal.metrics = { ...journal.metrics, ...Object.fromEntries(Object.entries(jcr).filter(([, value]) => value != null)) }
          if (!journal.sources.includes('wos')) journal.sources.push('wos')
        }
      } catch (error) {
        warnings.push(`WoS JCR failed for ${targetIssn}: ${error.message}`)
      }
    }
  }

  const journals = rankJournals(merged, query).slice(0, limit)
  return {
    query: query || issn || '*',
    issn: issn || null,
    providers_queried: providers,
    journals,
    warnings,
    failures,
  }
}

export const name = 'academic-harness-journal-search'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'journal_search',
    description: [
      'Search journals and venues with open metrics. Free sources: OpenAlex /sources (2-year mean citedness, h-index, i10, APC, DOAJ status), DOAJ v4 (APC/license/OA), and Crossref journals; merged by ISSN and title.',
      'Optional keyed enrichment adds Elsevier CiteScore/SJR/SNIP (SCOPUS_API_KEY) and WoS JCR JIF/JCI/quartile (WOS_API_KEY); unset keys are skipped.',
      'Use journal_policy instead when the question is OA/self-archiving policy rather than discovery or metrics.',
    ].join(' '),
    parameters: {
      query: { type: 'string', description: 'Journal title or topic keywords.' },
      issn: { type: 'string', description: 'Exact ISSN lookup, e.g. 1476-4687.' },
      providers: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: `Sources to query: ${PROVIDERS.join(', ')}. Default all three.`,
      },
      open_access_only: { type: 'boolean', description: 'Only return journals marked OA or listed in DOAJ.' },
      limit: { type: 'number', description: 'Maximum journals to return, 1-50. Default 10.' },
      include_keyed_metrics: { type: 'boolean', description: 'Add CiteScore/SJR/SNIP and JCR metrics when keys are set. Default true; set false to avoid quota use.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderJournals(value),
    },
    async execute(args, exec) {
      try {
        return await runJournalSearch(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Journal search: ${args.query || args.issn || ''}`, kind: 'search' }
    },
  }))
}
