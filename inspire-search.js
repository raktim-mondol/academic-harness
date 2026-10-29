/**
 * INSPIRE-HEP literature API: search, citation/reference trails, texkeys, and
 * BibTeX. Keyless; INSPIRE allows 15 requests in a 5-second window per IP, so
 * calls are serialized at a conservative 500 ms.
 */
import { fetchJson, fetchText, getLimiter, searchUserAgent } from './search-http.js'
import { fromInspireHit, renderPapers } from './search-normalize.js'

const API = 'https://inspirehep.net/api/literature'
const FIELDS = [
  'titles', 'authors', 'publication_info', 'dois', 'arxiv_eprints',
  'citation_count', 'texkeys', 'control_number', 'document_type',
  'subject_terms', 'abstracts', 'urls', 'preprint_date',
].join(',')

function limiter() {
  return getLimiter('inspire', { minIntervalMs: 500 })
}

function idOf(args) {
  return String(args.id || args.recid || '').trim()
}

export async function runInspireSearch(args, exec) {
  const query = String(args.query || '').trim()
  if (!query) return { error: 'query is required' }
  const params = new URLSearchParams({
    q: query,
    size: String(Math.min(Math.max(Number(args.limit) || 20, 1), 100)),
    page: String(Math.max(1, Number(args.page) || 1)),
    sort: args.sort || 'mostrecent',
    fields: FIELDS,
  })
  const result = await limiter().run(() => fetchJson(`${API}?${params}`, {
    signal: exec?.signal,
    headers: { 'User-Agent': searchUserAgent(), Accept: 'application/json' },
  }))
  if (!result.ok) {
    if (result.error === 'aborted') return { error: 'request cancelled' }
    return { error: `INSPIRE API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
  }
  const hits = result.data?.hits || {}
  const results = (Array.isArray(hits.hits) ? hits.hits : []).map(fromInspireHit).filter(Boolean)
  return {
    total: hits.total ?? results.length,
    page: Math.max(1, Number(args.page) || 1),
    results,
  }
}

async function fetchRecord(id, exec) {
  return limiter().run(() => fetchJson(`${API}/${encodeURIComponent(id)}`, {
    signal: exec?.signal,
    headers: { 'User-Agent': searchUserAgent(), Accept: 'application/json' },
  }))
}

export async function runInspireDomain(args, exec) {
  const action = String(args.action || 'record').toLowerCase()
  const id = idOf(args)
  if (!id) return { error: 'id or recid is required' }

  if (action === 'citations') {
    return runInspireSearch({
      query: `refersto:recid:${id}`,
      limit: args.limit,
    }, exec).then((value) => (value.error ? value : { action, id, ...value }))
  }

  if (action === 'bibtex') {
    const result = await limiter().run(() => fetchText(`${API}/${encodeURIComponent(id)}?format=bibtex`, {
      signal: exec?.signal,
      headers: { 'User-Agent': searchUserAgent(), Accept: 'application/x-bibtex' },
    }))
    if (!result.ok) {
      if (result.error === 'aborted') return { error: 'request cancelled' }
      return { error: `INSPIRE API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
    }
    return { action, id, bibtex: result.data || '' }
  }

  const result = await fetchRecord(id, exec)
  if (!result.ok) {
    if (result.error === 'aborted') return { error: 'request cancelled' }
    return { error: `INSPIRE API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
  }
  const metadata = result.data?.metadata || result.data || {}

  if (action === 'record') return { action, id, record: metadata }
  if (action === 'texkey') {
    return {
      action,
      id,
      texkeys: Array.isArray(metadata.texkeys) ? metadata.texkeys : [],
      citation_count: metadata.citation_count ?? null,
      arxiv_id: metadata.arxiv_eprints?.[0]?.value || null,
      doi: metadata.dois?.[0]?.value || null,
    }
  }
  if (action === 'references') {
    const references = Array.isArray(metadata.references) ? metadata.references : []
    const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100)
    return {
      action,
      id,
      total: references.length,
      references: references.slice(0, limit),
    }
  }
  return { error: 'action must be record, citations, references, texkey, or bibtex' }
}

export function renderInspireSearch(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  return [{ type: 'text', text: `INSPIRE-HEP: ${value.total ?? value.results.length} total · page ${value.page}\n\n${renderPapers(value.results || [])}` }]
}

function renderRecord(record) {
  const title = record?.titles?.[0]?.title || '(untitled)'
  const authors = (record?.authors || []).map((author) => author.full_name).filter(Boolean).join(', ')
  const publication = (record?.publication_info || [])[0] || {}
  const ids = [
    record?.control_number && `recid: ${record.control_number}`,
    record?.texkeys?.[0] && `texkey: ${record.texkeys[0]}`,
    record?.dois?.[0]?.value && `doi: ${record.dois[0].value}`,
    record?.arxiv_eprints?.[0]?.value && `arXiv: ${record.arxiv_eprints[0].value}`,
    record?.citation_count != null && `${record.citation_count} citations`,
  ].filter(Boolean)
  return [
    `**${title}**`,
    authors || null,
    [publication.year, publication.journal_title].filter(Boolean).join(' · ') || null,
    ids.length ? ids.join(' · ') : null,
  ].filter(Boolean).join('\n')
}

export function renderInspireDomain(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (value.bibtex != null) {
    return [{ type: 'text', text: `INSPIRE ${value.id}\n\n\`\`\`bibtex\n${value.bibtex.trim()}\n\`\`\`` }]
  }
  if (value.texkeys) {
    return [{ type: 'text', text: `INSPIRE ${value.id}\n\ntexkeys: ${value.texkeys.join(', ') || '(none)'}\ndoi: ${value.doi || '(none)'}\narXiv: ${value.arxiv_id || '(none)'}\ncitations: ${value.citation_count ?? 'unknown'}` }]
  }
  if (value.references) {
    const lines = value.references.map((entry, index) => {
      const reference = entry.reference || entry
      const record = reference.record || entry.record
      const title = reference.title
        || reference.misc?.[0]
        || record?.titles?.[0]?.title
        || entry.raw_refs?.[0]?.value
        || '(untitled)'
      const publication = Array.isArray(reference.publication_info)
        ? reference.publication_info[0]
        : (reference.publication_info || record?.publication_info?.[0] || {})
      const year = publication.year || reference.year || record?.publication_info?.[0]?.year
      const authors = (reference.authors || record?.authors || []).map((author) => author.full_name).filter(Boolean)
      const doi = reference.dois?.[0]?.value || record?.dois?.[0]?.value
      const link = entry.record?.$ref || record?.$ref
      const meta = [authors.length ? authors.join(', ') : null, year, doi ? `doi: ${doi}` : null, link]
        .filter(Boolean).join(' · ')
      return `${index + 1}. **${title}**${meta ? `\n   ${meta}` : ''}`
    })
    return [{ type: 'text', text: [`INSPIRE references for ${value.id}: ${value.total}`, ...lines].join('\n\n') }]
  }
  if (value.results) return renderInspireSearch(value)
  if (value.record) return [{ type: 'text', text: renderRecord(value.record) }]
  return [{ type: 'text', text: 'No INSPIRE result.' }]
}
