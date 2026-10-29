/**
 * ACL Anthology record lookup by ACL ID. The Anthology has no keyword-search
 * API; routing comes from Semantic Scholar/OpenAlex. This module fetches
 * the canonical BibTeX and links for a known ACL ID.
 */
import { fetchText, getLimiter, searchUserAgent } from './search-http.js'
import { canonicalAclId } from './search-normalize.js'

const ANTHOLOGY = 'https://aclanthology.org'

function bibtexField(bibtex, name) {
  const match = bibtex.match(new RegExp(`\\b${name}\\s*=\\s*[{"]([\\s\\S]+?)[}"]\\s*,?`, 'i'))
  return match ? match[1].replace(/[{}]/g, '').replace(/\s+/g, ' ').trim() : null
}

function bibtexSummary(bibtex) {
  const title = bibtexField(bibtex, 'title')
  const author = bibtexField(bibtex, 'author')
  const year = bibtex.match(/\byear\s*=\s*[{"']?(\d{4})[}"']?/i)?.[1] || null
  return {
    title,
    authors: author ? author.split(/\s+and\s+/i).map((name) => name.trim()).filter(Boolean) : [],
    year: year ? Number(year) : null,
  }
}

export async function runAclDomain(args, exec) {
  const action = String(args.action || 'record').toLowerCase()
  if (action !== 'record') return { error: 'action must be record' }
  const raw = String(args.id || args.acl_id || '').trim()
  const id = canonicalAclId(raw)
  if (!id) return { error: 'id must be an ACL Anthology ID (e.g. 2024.acl-long.1 or P19-1234)' }
  const limiter = getLimiter('acl-anthology', { minIntervalMs: 1000 })
  const result = await limiter.run(() => fetchText(`${ANTHOLOGY}/${encodeURIComponent(id)}.bib`, {
    signal: exec?.signal,
    headers: { 'User-Agent': searchUserAgent() },
  }))
  if (!result.ok) {
    if (result.error === 'aborted') return { error: 'request cancelled' }
    return { error: `ACL Anthology API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
  }
  const bibtex = result.data || ''
  return {
    action,
    id,
    ...bibtexSummary(bibtex),
    bibtex,
    page_url: `${ANTHOLOGY}/${id}/`,
    pdf_url: `${ANTHOLOGY}/${id}.pdf`,
  }
}

export function renderAclDomain(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const header = [
    value.title || `ACL Anthology ${value.id}`,
    value.authors?.length ? value.authors.join(', ') : null,
    value.year || null,
    value.page_url,
    value.pdf_url,
  ].filter(Boolean).join('\n')
  return [{ type: 'text', text: `${header}\n\n\`\`\`bibtex\n${String(value.bibtex || '').trim()}\n\`\`\`` }]
}
