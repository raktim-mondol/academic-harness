/**
 * Shared paper record for every academic-search provider.
 *
 * Each provider module maps its raw payload with the matching `from*` helper,
 * so tools, tests, and the future router agree on one shape. `mergePapers`
 * deduplicates across providers by DOI, then PMID, arXiv ID, OpenAlex ID, S2
 * ID, and finally normalized title+year. Identity keys are deliberately
 * conservative: a missing year does not merge two same-titled papers.
 */

const NOW = () => new Date().toISOString()

export function canonicalDoi(value) {
  if (!value) return null
  let s = String(value).trim()
  s = s.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '')
  if (!/^10\.\d{4,9}\//.test(s)) return null
  return s.replace(/[.,;]+$/, '').toLowerCase()
}

export function canonicalArxivId(value) {
  if (!value) return null
  const s = String(value).trim()
    .replace(/^arxiv:\s*/i, '')
    .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, '')
  const modern = s.match(/(\d{4}\.\d{4,5})(?:v\d+)?/i)
  if (modern) return modern[1]
  const legacy = s.match(/([a-z-]+(?:\.[a-z-]+)?\/\d{7})(?:v\d+)?/i)
  return legacy ? legacy[1].toLowerCase() : null
}

export function normalizeTitle(title) {
  return String(title || '')
    .replace(/<[^>]+>/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function stripPmid(value) {
  if (!value) return null
  const m = String(value).match(/(\d{5,9})/)
  return m ? m[1] : null
}

function stripPmcid(value) {
  if (!value) return null
  const m = String(value).match(/(PMC\d+)/i)
  return m ? m[1].toUpperCase() : null
}

function stripOpenAlexId(value) {
  if (!value) return null
  const m = String(value).match(/(W\d+)/)
  return m ? m[1] : null
}

function yearOf(value) {
  const n = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) ? n : null
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

function yearFromDate(value) {
  const match = String(value || '').match(/\b(19|20)\d{2}\b/)
  return match ? Number(match[0]) : null
}

function stripMarkup(text) {
  if (!text) return null
  return String(text)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim() || null
}

/** OpenAlex stores abstracts as an inverted index; rebuild the text. */
export function reconstructAbstract(index) {
  if (!index || typeof index !== 'object') return null
  const words = []
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue
    for (const position of positions) words[position] = word
  }
  const text = words.filter(Boolean).join(' ')
  return text || null
}

export function emptyPaper(source = 'unknown') {
  return {
    source,
    sources: [source],
    source_id: null,
    doi: null,
    pmid: null,
    pmcid: null,
    arxiv_id: null,
    openalex_id: null,
    s2_id: null,
    title: '',
    authors: [],
    year: null,
    venue: null,
    abstract: null,
    tldr: null,
    citation_count: null,
    influential_citation_count: null,
    oa_status: null,
    oa_url: null,
    url: null,
    type: null,
    fields: [],
    snippets: [],
    retrieved_at: NOW(),
  }
}

export function fromOpenAlexWork(work) {
  if (!work || typeof work !== 'object') return null
  const ids = work.ids || {}
  const authors = (work.authorships || [])
    .map((entry) => ({
      name: entry?.author?.display_name || entry?.raw_author_name || '',
      orcid: entry?.author?.orcid || undefined,
    }))
    .filter((author) => author.name)
  const location = work.primary_location || {}
  const best = work.best_oa_location || {}
  const paper = emptyPaper('openalex')
  paper.source_id = work.id || null
  paper.openalex_id = stripOpenAlexId(work.id)
  paper.doi = canonicalDoi(work.doi)
  paper.pmid = stripPmid(ids.pmid)
  paper.pmcid = stripPmcid(ids.pmcid)
  paper.title = stripMarkup(work.title || work.display_name) || ''
  paper.authors = authors
  paper.year = yearOf(work.publication_year)
  paper.venue = location.source?.display_name || null
  paper.abstract = reconstructAbstract(work.abstract_inverted_index)
  paper.citation_count = Number.isFinite(work.cited_by_count) ? work.cited_by_count : null
  paper.oa_status = work.open_access?.oa_status || null
  paper.oa_url = best.pdf_url || best.landing_page_url || location.pdf_url || null
  paper.url = location.landing_page_url || (paper.doi ? `https://doi.org/${paper.doi}` : null) || work.id || null
  paper.type = work.type || null
  paper.fields = (work.topics || []).map((topic) => topic?.display_name).filter(Boolean).slice(0, 8)
  return paper
}

export function fromSemanticScholarPaper(raw) {
  if (!raw || typeof raw !== 'object') return null
  const ext = raw.externalIds || {}
  const paper = emptyPaper('s2')
  paper.source_id = raw.paperId || null
  paper.s2_id = raw.paperId || null
  paper.doi = canonicalDoi(ext.DOI)
  paper.pmid = stripPmid(ext.PubMed)
  paper.arxiv_id = canonicalArxivId(ext.ArXiv)
  paper.title = stripMarkup(raw.title) || ''
  paper.authors = (raw.authors || []).map((author) => ({ name: author?.name || '' })).filter((a) => a.name)
  paper.year = yearOf(raw.year)
  paper.venue = raw.venue || null
  paper.abstract = raw.abstract || null
  paper.tldr = raw.tldr?.text || null
  paper.citation_count = Number.isFinite(raw.citationCount) ? raw.citationCount : null
  paper.influential_citation_count = Number.isFinite(raw.influentialCitationCount) ? raw.influentialCitationCount : null
  paper.oa_url = raw.openAccessPdf?.url || null
  paper.oa_status = paper.oa_url ? 'open' : null
  paper.url = raw.url || (paper.doi ? `https://doi.org/${paper.doi}` : null)
  paper.type = Array.isArray(raw.publicationTypes) ? raw.publicationTypes[0] : null
  paper.fields = Array.isArray(raw.fieldsOfStudy) ? raw.fieldsOfStudy.filter(Boolean) : []
  return paper
}

export function fromSemanticScholarSnippet(raw) {
  if (!raw || typeof raw !== 'object') return null
  const paper = fromSemanticScholarPaper(raw.paper)
  if (!paper) return null
  const text = stripMarkup(raw.snippet?.text || raw.text)
  if (text) paper.snippets = [text]
  return paper
}

export function fromCrossrefWork(work) {
  if (!work || typeof work !== 'object') return null
  const paper = emptyPaper('crossref')
  paper.source_id = work.DOI || null
  paper.doi = canonicalDoi(work.DOI)
  paper.pmid = stripPmid(work.PMID)
  paper.title = stripMarkup(Array.isArray(work.title) ? work.title[0] : work.title) || ''
  paper.authors = (work.author || [])
    .map((author) => ({ name: [author?.given, author?.family].filter(Boolean).join(' ') || author?.name || '' }))
    .filter((author) => author.name)
  paper.year = yearOf(work.issued?.['date-parts']?.[0]?.[0] ?? work.created?.['date-parts']?.[0]?.[0])
  paper.venue = (Array.isArray(work['container-title']) ? work['container-title'][0] : work['container-title']) || work.publisher || null
  paper.abstract = stripMarkup(work.abstract)
  paper.citation_count = Number.isFinite(work['is-referenced-by-count']) ? work['is-referenced-by-count'] : null
  paper.url = work.URL || (paper.doi ? `https://doi.org/${paper.doi}` : null)
  paper.type = work.type || null
  paper.fields = Array.isArray(work.subject) ? work.subject.filter(Boolean) : []
  return paper
}

export function fromArxivEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const paper = emptyPaper('arxiv')
  paper.source_id = entry.id || null
  paper.arxiv_id = canonicalArxivId(entry.id)
  paper.doi = canonicalDoi(entry.doi)
  paper.title = stripMarkup(entry.title) || ''
  paper.authors = (entry.authors || []).map((name) => ({ name: String(name).trim() })).filter((a) => a.name)
  paper.year = yearOf(String(entry.published || '').slice(0, 4))
  paper.venue = entry.journalRef || 'arXiv'
  paper.abstract = stripMarkup(entry.summary)
  paper.oa_url = entry.pdfUrl || null
  paper.url = entry.absUrl || entry.id || null
  paper.type = 'preprint'
  for (const value of [entry.primaryCategory, ...(entry.categories || [])]) {
    if (value && !paper.fields.includes(value)) paper.fields.push(value)
  }
  return paper
}

export function fromEuropePmcResult(result) {
  if (!result || typeof result !== 'object') return null
  const paper = emptyPaper('pubmed')
  paper.source_id = result.id || result.pmid || null
  paper.pmid = stripPmid(result.pmid || (/^\d+$/.test(result.id) ? result.id : null))
  paper.pmcid = stripPmcid(result.pmcid)
  paper.doi = canonicalDoi(result.doi)
  paper.title = stripMarkup(result.title) || ''
  paper.authors = Array.isArray(result.authorList?.author)
    ? result.authorList.author.map((author) => ({ name: author.fullName || author.name || '' })).filter((a) => a.name)
    : String(result.authorString || '').split(/,\s*/).filter(Boolean).map((name) => ({ name: name.trim() }))
  paper.year = yearOf(result.pubYear || String(result.firstPublicationDate || '').slice(0, 4))
  paper.venue = result.journalTitle || result.bookOrReportDetails?.publisher || null
  paper.abstract = stripMarkup(result.abstractText)
  paper.citation_count = Number.isFinite(result.citedByCount) ? result.citedByCount : null
  const urls = Array.isArray(result.fullTextUrlList?.fullTextUrl) ? result.fullTextUrlList.fullTextUrl : []
  const fullText = urls.find((entry) => /pdf/i.test(entry?.documentStyle || ''))
    || urls.find((entry) => /html/i.test(entry?.documentStyle || ''))
    || urls[0]
  const isOpen = result.isOpenAccess === 'Y'
  paper.oa_status = isOpen ? 'open' : (result.isOpenAccess === 'N' ? 'closed' : null)
  paper.oa_url = isOpen ? (fullText?.url || null) : null
  paper.url = paper.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/` : `https://europepmc.org/article/${result.source || 'MED'}/${result.id}`
  paper.type = result.pubTypeList?.pubType?.[0] || result.resultType || null
  return paper
}

export function fromBraveResult(result) {
  if (!result || typeof result !== 'object' || !result.url) return null
  const paper = emptyPaper('brave')
  paper.source_id = result.url
  paper.title = stripMarkup(result.title) || result.url
  paper.venue = result.profile?.long_name || result.profile?.name || hostOf(result.url)
  paper.abstract = stripMarkup(result.description)
  paper.snippets = Array.isArray(result.extra_snippets)
    ? result.extra_snippets.map(stripMarkup).filter(Boolean)
    : []
  paper.url = result.url
  paper.type = 'web'
  return paper
}

export function fromTavilyResult(result) {
  if (!result || typeof result !== 'object' || !result.url) return null
  const paper = emptyPaper('tavily')
  paper.source_id = result.url
  paper.title = stripMarkup(result.title) || result.url
  paper.venue = hostOf(result.url)
  paper.abstract = stripMarkup(result.content || result.raw_content)
  paper.year = yearFromDate(result.published_date)
  paper.url = result.url
  paper.type = 'web'
  return paper
}

export function fromExaResult(result) {
  if (!result || typeof result !== 'object' || !result.url) return null
  const paper = emptyPaper('exa')
  paper.source_id = result.id || result.url
  paper.title = stripMarkup(result.title) || result.url
  paper.venue = hostOf(result.url)
  paper.abstract = stripMarkup(result.summary || result.text)
  paper.year = yearFromDate(result.publishedDate)
  const authors = Array.isArray(result.author)
    ? result.author
    : (result.author ? [result.author] : [])
  paper.authors = authors.map((name) => ({ name: String(name).trim() })).filter((author) => author.name)
  paper.snippets = Array.isArray(result.highlights)
    ? result.highlights.map(stripMarkup).filter(Boolean)
    : []
  paper.url = result.url
  paper.type = 'web'
  return paper
}

export function fromPerplexityResult(result) {
  if (!result || typeof result !== 'object' || !result.url) return null
  const paper = emptyPaper('perplexity')
  paper.source_id = result.url
  paper.title = stripMarkup(result.title) || result.url
  paper.venue = hostOf(result.url)
  paper.abstract = stripMarkup(result.snippet)
  paper.year = yearFromDate(result.date || result.last_updated)
  paper.url = result.url
  paper.type = 'web'
  return paper
}

export function fromNcbiSummary(summary) {
  if (!summary || typeof summary !== 'object' || summary.error) return null
  const articleIds = Array.isArray(summary.articleids) ? summary.articleids : []
  const doi = articleIds.find((entry) => entry?.idtype === 'doi')?.value
  const pmcid = articleIds.find((entry) => entry?.idtype === 'pmc')?.value
  const paper = emptyPaper('pubmed')
  paper.source_id = summary.uid || null
  paper.pmid = stripPmid(summary.uid)
  paper.pmcid = stripPmcid(pmcid)
  paper.doi = canonicalDoi(doi)
  paper.title = stripMarkup(summary.title) || ''
  paper.authors = (summary.authors || []).map((author) => ({ name: author?.name || '' })).filter((a) => a.name)
  paper.year = yearOf(String(summary.pubdate || '').slice(0, 4))
  paper.venue = summary.fulljournalname || summary.source || null
  paper.abstract = null
  paper.citation_count = null
  paper.oa_status = paper.pmcid ? 'open' : null
  paper.oa_url = paper.pmcid ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${paper.pmcid}/` : null
  paper.url = paper.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/` : null
  paper.type = Array.isArray(summary.pubtype) ? summary.pubtype[0] : null
  return paper
}

const SCALAR_FIELDS = [
  'source_id', 'doi', 'pmid', 'pmcid', 'arxiv_id', 'openalex_id', 's2_id',
  'title', 'year', 'venue', 'tldr', 'oa_status', 'oa_url', 'url', 'type',
]

function paperKeys(paper) {
  const keys = []
  if (paper.doi) keys.push(`doi:${paper.doi}`)
  if (paper.pmid) keys.push(`pmid:${paper.pmid}`)
  if (paper.arxiv_id) keys.push(`arxiv:${paper.arxiv_id}`)
  if (paper.openalex_id) keys.push(`openalex:${paper.openalex_id}`)
  if (paper.s2_id) keys.push(`s2:${paper.s2_id}`)
  if (paper.title && paper.year != null) keys.push(`title:${normalizeTitle(paper.title)}:${paper.year}`)
  return keys
}

function mergeInto(target, source) {
  for (const field of SCALAR_FIELDS) {
    if (!target[field] && source[field]) target[field] = source[field]
  }
  if (!target.abstract || (source.abstract && source.abstract.length > target.abstract.length)) {
    target.abstract = source.abstract || target.abstract
  }
  if ((source.citation_count ?? -1) > (target.citation_count ?? -1)) {
    target.citation_count = source.citation_count
  }
  if ((source.influential_citation_count ?? -1) > (target.influential_citation_count ?? -1)) {
    target.influential_citation_count = source.influential_citation_count
  }
  if ((source.authors?.length || 0) > (target.authors?.length || 0)) target.authors = source.authors
  for (const field of source.fields || []) {
    if (!target.fields.includes(field)) target.fields.push(field)
  }
  for (const snippet of source.snippets || []) {
    if (!target.snippets.includes(snippet)) target.snippets.push(snippet)
  }
  for (const sourceName of source.sources || [source.source]) {
    if (sourceName && !target.sources.includes(sourceName)) target.sources.push(sourceName)
  }
}

const SOURCE_PRIORITY = {
  openalex: 0,
  s2: 1,
  crossref: 2,
  pubmed: 3,
  arxiv: 4,
  consensus: 5,
  parallel: 6,
  brave: 7,
}

/** Deterministic order for a merged multi-source list. */
export function sortPapers(papers) {
  const priority = (paper) => SOURCE_PRIORITY[paper.source] ?? 50
  return [...papers].sort((a, b) => {
    if (priority(a) !== priority(b)) return priority(a) - priority(b)
    if ((a.citation_count ?? -1) !== (b.citation_count ?? -1)) {
      return (b.citation_count ?? -1) - (a.citation_count ?? -1)
    }
    return (b.year ?? 0) - (a.year ?? 0)
  })
}

export function mergePapers(papers) {
  const merged = []
  const index = new Map()
  for (const paper of papers) {
    if (!paper || !paper.title) continue
    const keys = paperKeys(paper)
    let position = -1
    for (const key of keys) {
      if (index.has(key)) {
        position = index.get(key)
        break
      }
    }
    if (position >= 0) {
      mergeInto(merged[position], paper)
      for (const key of paperKeys(merged[position])) index.set(key, position)
    } else {
      const copy = {
        ...paper,
        sources: [...(paper.sources || [paper.source])],
        authors: [...(paper.authors || [])],
        fields: [...(paper.fields || [])],
        snippets: [...(paper.snippets || [])],
      }
      merged.push(copy)
      for (const key of keys) index.set(key, merged.length - 1)
    }
  }
  return sortPapers(merged)
}

function authorLine(authors, maxAuthors) {
  const names = (authors || []).map((author) => author.name).filter(Boolean)
  if (!names.length) return ''
  if (names.length <= maxAuthors) return names.join(', ')
  return `${names.slice(0, maxAuthors).join(', ')}, et al.`
}

export function capText(text, maxChars = 24_000) {
  return text.length > maxChars
    ? `${text.slice(0, maxChars).trimEnd()}\n… [output truncated]`
    : text
}

export function renderPapers(papers, { maxAuthors = 3, abstractChars = 0 } = {}) {
  if (!Array.isArray(papers) || papers.length === 0) return 'No results.'
  return papers.map((paper, i) => {
    const bits = [`${i + 1}. **${paper.title || '(untitled)'}**`]
    const meta = [authorLine(paper.authors, maxAuthors), paper.year, paper.venue].filter(Boolean).join(' · ')
    if (meta) bits.push(meta)
    const ids = []
    if (paper.doi) ids.push(`doi: ${paper.doi}`)
    if (paper.pmid) ids.push(`pmid: ${paper.pmid}`)
    if (paper.arxiv_id) ids.push(`arXiv: ${paper.arxiv_id}`)
    if (paper.openalex_id) ids.push(`openalex: ${paper.openalex_id}`)
    if (paper.citation_count != null) ids.push(`${paper.citation_count} citations`)
    if (paper.oa_url) ids.push(`oa: ${paper.oa_url}`)
    if (ids.length) bits.push(ids.join(' · '))
    if (paper.tldr) bits.push(paper.tldr)
    if (paper.url) bits.push(paper.url)
    if (abstractChars > 0 && paper.abstract) {
      const text = paper.abstract.length > abstractChars
        ? `${paper.abstract.slice(0, abstractChars).trimEnd()}…`
        : paper.abstract
      bits.push(text)
    }
    for (const snippet of paper.snippets || []) {
      bits.push(`> ${snippet.length > 400 ? `${snippet.slice(0, 400).trimEnd()}…` : snippet}`)
    }
    return bits.join('\n')
  }).join('\n\n')
}

/** Classify a free-form identifier into the provider that can resolve it. */
export function identifierKind(value) {
  const raw = String(value || '').trim()
  if (!raw) return { kind: 'unknown', value: raw }
  const doi = canonicalDoi(raw)
  if (doi) return { kind: 'doi', value: doi }
  const arxiv = canonicalArxivId(raw)
  if (/arxiv/i.test(raw) || /^\d{4}\.\d{4,5}(v\d+)?$/i.test(raw) || /^[a-z-]+(?:\.[a-z-]+)?\/\d{7}(v\d+)?$/i.test(raw)) {
    if (arxiv) return { kind: 'arxiv', value: arxiv }
  }
  const openalex = stripOpenAlexId(raw)
  if (openalex && /openalex|^W\d+$/i.test(raw)) return { kind: 'openalex', value: openalex }
  const pmid = raw.match(/^(?:pmid:\s*)?(\d{5,9})$/i)
  if (pmid) return { kind: 'pmid', value: pmid[1] }
  if (/^[0-9a-f]{40}$/i.test(raw)) return { kind: 's2', value: raw }
  return { kind: 'unknown', value: raw }
}
