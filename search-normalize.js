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

export function canonicalPmcid(value) {
  if (!value) return null
  const match = String(value).match(/(PMC\d+)/i)
  return match ? match[1].toUpperCase() : null
}

export function canonicalScopusId(value) {
  if (!value) return null
  const raw = String(value).trim().replace(/^scopus:\s*/i, '')
  const eid = raw.match(/2-s2\.0-\d+/i)
  if (eid) return eid[0].toLowerCase()
  const scopus = raw.match(/SCOPUS_ID:\s*(\d+)/i)
  if (scopus) return `SCOPUS_ID:${scopus[1]}`
  if (/^\d+$/.test(raw)) return `SCOPUS_ID:${raw}`
  return null
}

export function canonicalWosUid(value) {
  if (!value) return null
  const match = String(value).trim().match(/WOS:\d+/i)
  return match ? match[0].toUpperCase() : null
}

export function canonicalInspireId(value) {
  if (!value) return null
  const match = String(value).trim().match(/^(?:inspire|recid):\s*(\d+)$/i)
  return match ? match[1] : null
}

export function canonicalAclId(value) {
  if (!value) return null
  const raw = String(value).trim().replace(/^acl:\s*/i, '')
  return /^(?:\d{4}\.[a-z0-9-]+(?:\.[a-z0-9-]+)*\.\d+|[A-Z]\d{2}-\d{4})$/i.test(raw) ? raw : null
}

export function canonicalBibcode(value) {
  if (!value) return null
  const raw = String(value).trim()
  return /^\d{4}[A-Za-z0-9&.\-?]{15}$/.test(raw) ? raw : null
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

export function yearOf(value) {
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

export function stripMarkup(text) {
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
    bibcode: null,
    inspire_id: null,
    acl_id: null,
    scopus_id: null,
    wos_uid: null,
    wikidata_qid: null,
    texkey: null,
    title: '',
    authors: [],
    year: null,
    venue: null,
    abstract: null,
    tldr: null,
    citation_count: null,
    influential_citation_count: null,
    reference_count: null,
    journal_quartile: null,
    journal: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    bibtex: null,
    oa_status: null,
    oa_url: null,
    pdf_url: null,
    html_url: null,
    url: null,
    type: null,
    licence: null,
    fields: [],
    snippets: [],
    retrieved_at: NOW(),
  }
}

export function fromOpenAlexWork(work) {
  if (!work || typeof work !== 'object') return null
  const ids = work.ids || {}
  const authors = (work.authorships || [])
    .map((entry) => {
      const name = entry?.author?.display_name || entry?.raw_author_name || ''
      if (!name) return null
      const author = { name }
      if (entry?.author?.orcid) author.orcid = entry.author.orcid
      return author
    })
    .filter(Boolean)
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
  paper.journal = location.source?.display_name ? {
    name: location.source.display_name,
    issn_l: location.source.issn_l || null,
    issns: Array.isArray(location.source.issn) ? [...location.source.issn] : [],
    publisher: location.source.host_organization_name || null,
    is_oa: location.source.is_oa ?? null,
    is_in_doaj: location.source.is_in_doaj ?? null,
    source_id: stripOpenAlexId(location.source.id),
  } : null
  paper.abstract = reconstructAbstract(work.abstract_inverted_index)
  paper.citation_count = Number.isFinite(work.cited_by_count) ? work.cited_by_count : null
  paper.reference_count = Number.isFinite(work.referenced_works_count)
    ? work.referenced_works_count
    : (Array.isArray(work.referenced_works) ? work.referenced_works.length : null)
  paper.oa_status = work.open_access?.oa_status || null
  paper.oa_url = best.pdf_url || best.landing_page_url || location.pdf_url || null
  paper.pdf_url = best.pdf_url || location.pdf_url || null
  paper.html_url = best.html_url || null
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
  paper.pmcid = stripPmcid(ext.PubMedCentral)
  paper.arxiv_id = canonicalArxivId(ext.ArXiv)
  paper.title = stripMarkup(raw.title) || ''
  paper.authors = (raw.authors || []).map((author) => ({ name: author?.name || '' })).filter((a) => a.name)
  paper.year = yearOf(raw.year)
  paper.venue = raw.venue || raw.journal?.name || raw.publicationVenue?.name || null
  paper.journal = paper.venue ? {
    name: paper.venue,
    issn_l: raw.publicationVenue?.issn || null,
    issns: raw.publicationVenue?.issn ? [raw.publicationVenue.issn] : [],
    publisher: null,
  } : null
  paper.volume = raw.journal?.volume || null
  paper.pages = raw.journal?.pages || null
  paper.abstract = raw.abstract || null
  paper.tldr = raw.tldr?.text || null
  paper.citation_count = Number.isFinite(raw.citationCount) ? raw.citationCount : null
  paper.influential_citation_count = Number.isFinite(raw.influentialCitationCount) ? raw.influentialCitationCount : null
  paper.reference_count = Number.isFinite(raw.referenceCount) ? raw.referenceCount : null
  paper.bibtex = raw.citationStyles?.bibtex || null
  paper.oa_url = raw.openAccessPdf?.url || null
  paper.pdf_url = raw.openAccessPdf?.url || null
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
  const issns = Array.isArray(work.ISSN) ? [...work.ISSN] : (work.ISSN ? [work.ISSN] : [])
  paper.journal = paper.venue ? {
    name: paper.venue,
    issn_l: issns[0] || null,
    issns,
    publisher: work.publisher || null,
  } : null
  paper.publisher = work.publisher || null
  paper.volume = work.volume || null
  paper.issue = work.issue || null
  paper.pages = work.page || null
  paper.pmcid = stripPmcid(work.PMCID)
  paper.abstract = stripMarkup(work.abstract)
  paper.citation_count = Number.isFinite(work['is-referenced-by-count']) ? work['is-referenced-by-count'] : null
  paper.reference_count = Number.isFinite(work['references-count']) ? work['references-count'] : null
  const pdfLink = (work.link || []).find((link) => link?.['content-type'] === 'application/pdf' && link.URL)
  paper.pdf_url = pdfLink?.URL || null
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
  paper.journal = { name: paper.venue, issns: [] }
  paper.abstract = stripMarkup(entry.summary)
  paper.oa_url = entry.pdfUrl || null
  paper.pdf_url = entry.pdfUrl || null
  paper.html_url = paper.arxiv_id ? `https://arxiv.org/html/${paper.arxiv_id}` : null
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
  paper.venue = result.journalTitle || result.journalInfo?.journal?.title || result.bookOrReportDetails?.publisher || null
  paper.journal = result.journalInfo?.journal?.title ? {
    name: result.journalInfo.journal.title,
    issn_l: result.journalInfo.journal.issn || result.journalInfo.journal.essn || null,
    issns: [result.journalInfo.journal.issn, result.journalInfo.journal.essn].filter(Boolean),
    publisher: result.journalInfo.journal.publisher || null,
  } : (paper.venue ? { name: paper.venue, issns: [] } : null)
  paper.volume = result.journalInfo?.volume || null
  paper.issue = result.journalInfo?.issue || null
  paper.pages = result.pageInfo || null
  paper.abstract = stripMarkup(result.abstractText)
  paper.citation_count = Number.isFinite(result.citedByCount) ? result.citedByCount : null
  const urls = Array.isArray(result.fullTextUrlList?.fullTextUrl) ? result.fullTextUrlList.fullTextUrl : []
  const pdfText = urls.find((entry) => /pdf/i.test(entry?.documentStyle || ''))
  const htmlText = urls.find((entry) => /html/i.test(entry?.documentStyle || ''))
  const fullText = pdfText || htmlText || urls[0]
  const isOpen = result.isOpenAccess === 'Y'
  paper.oa_status = isOpen ? 'open' : (result.isOpenAccess === 'N' ? 'closed' : null)
  paper.oa_url = isOpen ? (fullText?.url || null) : null
  paper.pdf_url = isOpen ? (pdfText?.url || null) : null
  paper.html_url = isOpen ? (htmlText?.url || null) : null
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

export function fromCoreResult(result, { includeFullText = false } = {}) {
  if (!result || typeof result !== 'object' || !result.title) return null
  const links = Array.isArray(result.links) ? result.links : []
  const display = links.find((link) => link?.type === 'display')?.url
  const download = links.find((link) => link?.type === 'download')?.url
  const paper = emptyPaper('core')
  paper.source_id = result.id != null ? String(result.id) : null
  paper.doi = canonicalDoi(result.doi)
  paper.pmid = stripPmid(result.pubmedId)
  paper.arxiv_id = canonicalArxivId(result.arxivId)
  paper.title = stripMarkup(result.title) || ''
  paper.authors = (result.authors || [])
    .map((author) => ({ name: String(author?.name || '').replace(/,\s*$/, '') }))
    .filter((author) => author.name)
  paper.year = yearOf(result.yearPublished)
  paper.venue = (Array.isArray(result.journals) ? result.journals[0]?.title : null) || result.publisher || null
  paper.abstract = stripMarkup(result.abstract)
  paper.citation_count = Number.isFinite(result.citationCount) ? result.citationCount : null
  paper.oa_url = result.downloadUrl
    || (Array.isArray(result.sourceFulltextUrls) ? result.sourceFulltextUrls[0] : null)
    || download
    || null
  paper.oa_status = paper.oa_url ? 'open' : null
  paper.url = display || (result.id != null ? `https://core.ac.uk/works/${result.id}` : null)
  paper.type = result.documentType || null
  paper.fields = Array.isArray(result.fieldOfStudy)
    ? result.fieldOfStudy
    : (result.fieldOfStudy ? [result.fieldOfStudy] : [])
  if (includeFullText
    && typeof result.fullText === 'string'
    && result.fullText.trim()
    && !/not available for public api users/i.test(result.fullText)) {
    paper.full_text = result.fullText
  }
  return paper
}

export function fromElicitPaper(result) {
  if (!result || typeof result !== 'object' || !result.title) return null
  const urls = Array.isArray(result.urls) ? result.urls : []
  const paper = emptyPaper('elicit')
  paper.source_id = result.elicitId || null
  paper.doi = canonicalDoi(result.doi)
  paper.pmid = stripPmid(result.pmid)
  paper.title = stripMarkup(result.title) || ''
  paper.authors = (result.authors || [])
    .map((name) => ({ name: String(name || '').trim() }))
    .filter((author) => author.name)
  paper.year = yearOf(result.year)
  paper.venue = result.venue || null
  paper.abstract = stripMarkup(result.abstract)
  paper.citation_count = Number.isFinite(result.citedByCount) ? result.citedByCount : null
  paper.journal_quartile = Number.isFinite(result.journalQuartile) ? result.journalQuartile : null
  paper.url = urls[0] || result.fullTextUrl || (paper.doi ? `https://doi.org/${paper.doi}` : null)
  paper.type = Array.isArray(result.studyTypeTags) ? result.studyTypeTags[0] : null
  paper.fields = Array.isArray(result.studyTypeTags) ? result.studyTypeTags.filter(Boolean) : []
  return paper
}

export function fromElicitTrial(result) {
  if (!result || typeof result !== 'object' || !result.title) return null
  const paper = emptyPaper('elicit-trial')
  paper.source_id = result.nctId || null
  paper.title = stripMarkup(result.title) || ''
  paper.abstract = stripMarkup(result.summary)
  paper.year = yearFromDate(result.startDate)
  paper.venue = result.leadSponsor || null
  paper.url = result.url || (result.nctId ? `https://clinicaltrials.gov/study/${result.nctId}` : null)
  paper.type = result.studyType || null
  paper.fields = Array.isArray(result.conditions) ? result.conditions.filter(Boolean) : []
  paper.trial = {
    nct_id: result.nctId || null,
    overall_status: result.overallStatus || null,
    phase: Array.isArray(result.phase) ? result.phase : [],
    enrollment_count: result.enrollmentCount ?? null,
    interventions: Array.isArray(result.interventions) ? result.interventions : [],
    has_results: result.hasResults ?? null,
    start_date: result.startDate || null,
    completion_date: result.completionDate || null,
  }
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

export function fromBiorxivRecord(record, { server = 'biorxiv' } = {}) {
  if (!record || typeof record !== 'object' || !record.title) return null
  const paper = emptyPaper('biorxiv')
  paper.source_id = record.doi || null
  paper.doi = canonicalDoi(record.doi)
  paper.title = stripMarkup(record.title) || ''
  paper.authors = String(record.authors || '')
    .split(/;\s*/)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name }))
  paper.year = yearOf(record.date)
  paper.venue = server === 'medrxiv' ? 'medRxiv' : 'bioRxiv'
  paper.abstract = stripMarkup(record.abstract)
  paper.url = record.doi
    ? `${server === 'medrxiv' ? 'https://www.medrxiv.org' : 'https://www.biorxiv.org'}/content/${record.doi}v${record.version || 1}`
    : null
  paper.type = 'preprint'
  paper.fields = record.category ? [record.category] : []
  return paper
}

export function fromInspireHit(hit) {
  const metadata = hit?.metadata || hit
  if (!metadata || typeof metadata !== 'object') return null
  const title = metadata.titles?.[0]?.title
  if (!title) return null
  const publication = (metadata.publication_info || [])[0] || {}
  const paper = emptyPaper('inspire')
  paper.source_id = metadata.control_number != null ? String(metadata.control_number) : null
  paper.inspire_id = paper.source_id
  paper.texkey = metadata.texkeys?.[0] || null
  paper.arxiv_id = canonicalArxivId(metadata.arxiv_eprints?.[0]?.value)
  paper.doi = canonicalDoi(metadata.dois?.[0]?.value)
  paper.title = stripMarkup(title) || ''
  paper.authors = (metadata.authors || [])
    .map((author) => ({ name: author?.full_name || '' }))
    .filter((author) => author.name)
  paper.year = yearOf(publication.year || metadata.preprint_date)
  paper.venue = publication.journal_title || publication.book_title || null
  paper.abstract = stripMarkup(metadata.abstracts?.[0]?.value)
  paper.citation_count = Number.isFinite(metadata.citation_count) ? metadata.citation_count : null
  paper.url = metadata.urls?.[0]?.value
    || (paper.arxiv_id ? `https://arxiv.org/abs/${paper.arxiv_id}` : null)
    || (paper.doi ? `https://doi.org/${paper.doi}` : null)
  paper.type = metadata.document_type?.[0] || null
  paper.fields = (metadata.subject_terms || []).map((term) => term?.term).filter(Boolean).slice(0, 8)
  return paper
}

export function fromAdsDoc(doc) {
  if (!doc || typeof doc !== 'object') return null
  const bibcode = canonicalBibcode(doc.bibcode)
  const title = Array.isArray(doc.title) ? doc.title[0] : doc.title
  if (!bibcode || !title) return null
  const paper = emptyPaper('ads')
  paper.source_id = bibcode
  paper.bibcode = bibcode
  paper.title = stripMarkup(title) || ''
  const rawAuthors = Array.isArray(doc.author) ? doc.author : (doc.author ? [doc.author] : [])
  paper.authors = rawAuthors
    .map((name) => ({ name: String(name || '').trim() }))
    .filter((author) => author.name)
  paper.year = yearOf(doc.year)
  paper.venue = doc.pub || doc.pub_raw || null
  paper.doi = canonicalDoi(Array.isArray(doc.doi) ? doc.doi[0] : doc.doi)
  paper.arxiv_id = canonicalArxivId(Array.isArray(doc.arxiv) ? doc.arxiv[0] : doc.arxiv)
  paper.abstract = stripMarkup(doc.abstract)
  paper.citation_count = Number.isFinite(doc.citation_count) ? doc.citation_count : null
  paper.url = `https://ui.adsabs.harvard.edu/abs/${bibcode}/abstract`
  paper.type = doc.doctype || null
  paper.fields = Array.isArray(doc.keyword) ? doc.keyword.slice(0, 8) : []
  return paper
}

export function fromScopusEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const title = entry['dc:title']
  if (!title) return null
  const paper = emptyPaper('scopus')
  const eid = entry.eid || null
  paper.source_id = eid || canonicalScopusId(entry['dc:identifier'])
  paper.scopus_id = canonicalScopusId(eid) || canonicalScopusId(entry['dc:identifier'])
  paper.doi = canonicalDoi(entry['prism:doi'] || entry.doi)
  paper.title = stripMarkup(title) || ''
  paper.authors = String(entry['dc:creator'] || '')
    .split(/;\s*/)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name }))
  paper.year = yearOf(entry['prism:coverDate'])
  paper.venue = entry['prism:publicationName'] || null
  paper.citation_count = Number.isFinite(Number.parseInt(entry['citedby-count'], 10))
    ? Number.parseInt(entry['citedby-count'], 10)
    : null
  paper.url = entry['prism:url'] || (paper.doi ? `https://doi.org/${paper.doi}` : null)
  paper.type = entry.subtypeDescription || null
  paper.licence = 'restricted'
  return paper
}

export function fromWosHit(hit) {
  if (!hit || typeof hit !== 'object') return null
  const title = hit.title
  if (!title) return null
  const paper = emptyPaper('wos')
  const uid = canonicalWosUid(hit.uid) || hit.uid || null
  paper.source_id = uid
  paper.wos_uid = uid
  paper.title = stripMarkup(title) || ''
  const rawAuthors = hit.names?.authors || []
  paper.authors = (Array.isArray(rawAuthors) ? rawAuthors : [rawAuthors])
    .map((author) => ({
      name: typeof author === 'string'
        ? author
        : author?.displayName || author?.wosStandard || author?.fullName || author?.name || '',
    }))
    .filter((author) => author.name)
  paper.year = yearOf(hit.publicationInfo?.pubYear || hit.publicationInfo?.pubyear)
  paper.venue = hit.publicationInfo?.sourceTitle || hit.publicationInfo?.journalTitle || null
  const doi = hit.identifiers?.doi
  paper.doi = canonicalDoi(Array.isArray(doi) ? doi[0] : doi)
  if (Number.isFinite(hit.citationCount)) paper.citation_count = hit.citationCount
  else if (Number.isFinite(hit.citations)) paper.citation_count = hit.citations
  else if (Array.isArray(hit.citations)) {
    paper.citation_count = hit.citations.reduce((sum, citation) => sum + (Number(citation?.count) || 0), 0)
  }
  paper.url = hit.links?.record || hit.links?.self
    || (uid ? `https://www.webofscience.com/wos/woscc/full-record/${encodeURIComponent(uid)}` : null)
  paper.type = hit.documentType || null
  paper.licence = 'restricted'
  return paper
}

/* ------------------------------------------------------------------ DOI helpers */

/** Prefixes of preprint servers: a DOI here names a preprint, not the published version. */
const PREPRINT_DOI_PREFIXES = [
  '10.1101/',   // bioRxiv, medRxiv
  '10.48550/',  // arXiv
  '10.21203/',  // Research Square
  '10.2139/',   // SSRN
  '10.20944/',  // Preprints.org
  '10.31219/',  // OSF Preprints
  '10.26434/',  // ChemRxiv
  '10.31234/',  // PsyArXiv
  '10.31235/',  // SocArXiv
  '10.64898/',  // openRxiv
]
export function isPreprintDoi(doi) {
  const d = canonicalDoi(doi)
  return Boolean(d) && PREPRINT_DOI_PREFIXES.some((prefix) => d.startsWith(prefix))
}

/** arXiv assigns every paper a DOI of this form. Deterministic, not a guess. */
export function arxivDoi(arxivId) {
  const id = canonicalArxivId(arxivId)
  return id ? `10.48550/arxiv.${id}`.toLowerCase() : null
}

/**
 * A DOI written in a URL. Only the URL is trusted: a DOI in page text is often one the
 * page cites, not the page's own. Handles doi.org links, publisher /doi/ paths, query
 * strings such as aeaweb's `?id=10.1257%2Fpol...`, and percent-encoded slashes.
 */
export function doiFromUrl(url) {
  let text = String(url || '')
  try { text = decodeURIComponent(text) } catch { /* keep the raw string */ }
  const match = text.match(/10\.\d{4,9}\/[^\s"'<>?#&]+/)
  if (!match) return null
  let doi = match[0].replace(/[.,;:]+$/, '')
  // drop an unbalanced trailing ")" left over from markdown or prose
  while (doi.endsWith(')') && (doi.match(/\)/g) || []).length > (doi.match(/\(/g) || []).length) doi = doi.slice(0, -1)
  return canonicalDoi(doi)
}

const SCHOLARLY_HOST = /(^|\.)(pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov|europepmc\.org|arxiv\.org|biorxiv\.org|medrxiv\.org|doi\.org|nature\.com|science\.org|sciencedirect\.com|springer\.com|springernature\.com|wiley\.com|onlinelibrary\.wiley\.com|tandfonline\.com|sagepub\.com|jstor\.org|ieee\.org|acm\.org|aps\.org|iop\.org|rsc\.org|acs\.org|oup\.com|academic\.oup\.com|cambridge\.org|mdpi\.com|frontiersin\.org|plos\.org|plosone\.org|biomedcentral\.com|elifesciences\.org|cell\.com|thelancet\.com|nejm\.org|jamanetwork\.com|bmj\.com|jacc\.org|ahajournals\.org|aeaweb\.org|nber\.org|ssrn\.com|researchgate\.net|semanticscholar\.org|openreview\.net|aclanthology\.org|aaai\.org|neurips\.cc|mlr\.press|jmlr\.org|pnas\.org|annualreviews\.org|karger\.com|thieme-connect\.com|osf\.io)$/i

/** A page that is plausibly a paper: it names a DOI in its URL, or sits on a scholarly host. */
export function isScholarlyUrl(url) {
  if (doiFromUrl(url)) return true
  try { return SCHOLARLY_HOST.test(new URL(String(url)).hostname) } catch { return false }
}

/* ------------------------------------------------------- premium-source normalisers */

function cleanText(value) {
  const text = stripMarkup(String(value ?? ''))
  return text ? text.replace(/\s+/g, ' ').trim() || null : null
}

/** Consensus `/v1/search` result. */
export function fromConsensusResult(r) {
  if (!r || typeof r !== 'object') return null
  const paper = emptyPaper('consensus')
  paper.doi = canonicalDoi(r.doi)
  paper.title = cleanText(r.title) || ''
  paper.authors = (Array.isArray(r.authors) ? r.authors : [])
    .map((author) => ({ name: typeof author === 'string' ? author : (author?.name || '') }))
    .filter((author) => author.name)
  paper.year = yearOf(r.publish_year ?? r.publish_date)
  paper.venue = r.journal_name || null
  paper.publisher = r.publisher_name || null
  paper.volume = r.volume != null ? String(r.volume) : null
  paper.pages = r.pages != null ? String(r.pages) : null
  paper.abstract = cleanText(r.abstract)
  paper.citation_count = Number.isFinite(r.citation_count) ? r.citation_count : null
  paper.influential_citation_count = Number.isFinite(r.influential_citation_count) ? r.influential_citation_count : null
  paper.journal_quartile = r.sjr_best_quartile != null ? `Q${r.sjr_best_quartile}`.replace(/^QQ/, 'Q') : null
  paper.type = r.is_preprint ? 'preprint' : (r.study_type ? 'article' : null)
  paper.url = r.url || (paper.doi ? `https://doi.org/${paper.doi}` : null)
  if (r.takeaway) paper.takeaway = cleanText(r.takeaway)
  if (r.study_type) paper.study_type = String(r.study_type)
  return paper
}

/** One hit of Scite's `search_literature`. `tally` is its citation-statement count. */
export function fromSciteHit(hit) {
  if (!hit || typeof hit !== 'object') return null
  const paper = emptyPaper('scite')
  paper.doi = canonicalDoi(hit.doi)
  paper.title = cleanText(hit.title) || ''
  paper.authors = (Array.isArray(hit.authors) ? hit.authors : [])
    .map((author) => ({ name: typeof author === 'string' ? author : (author?.authorName || author?.name || '') }))
    .filter((author) => author.name)
  paper.year = yearOf(hit.year ?? hit.date)
  paper.venue = cleanText(hit.journal)
  paper.publisher = hit.publisher || null
  paper.volume = hit.volume != null ? String(hit.volume) : null
  paper.issue = hit.issue != null ? String(hit.issue) : null
  paper.pages = hit.page != null ? String(hit.page) : null
  paper.abstract = cleanText(hit.abstract)
  const tally = hit.tally && typeof hit.tally === 'object' ? hit.tally : null
  if (tally) {
    paper.citation_count = Number.isFinite(tally.citingPublications) ? tally.citingPublications : null
    paper.scite = {
      supporting: tally.supporting ?? 0,
      contrasting: tally.contrasting ?? 0,
      mentioning: tally.mentioning ?? 0,
      total: tally.total ?? 0,
      citing_publications: tally.citingPublications ?? null,
    }
  }
  if (hit.isOa === true) paper.oa_status = String(hit.oaStatus || 'open').toLowerCase()
  paper.url = hit.url || (paper.doi ? `https://doi.org/${paper.doi}` : null)
  return paper
}

/** One result of Firecrawl's `firecrawl_research_search_papers` (its structuredContent). */
export function fromFirecrawlPaper(r) {
  if (!r || typeof r !== 'object') return null
  const paper = emptyPaper('firecrawl')
  const ids = r.ids && typeof r.ids === 'object' ? r.ids : {}
  const first = (v) => (Array.isArray(v) ? v[0] : v)
  paper.source_id = r.primaryId || r.paperId || null
  paper.arxiv_id = canonicalArxivId(first(ids.arxiv))
  paper.pmid = stripPmid(first(ids.pmid))
  paper.pmcid = stripPmcid(first(ids.pmcid))
  // a journal/preprint DOI when the index has one; otherwise arXiv's own, which is deterministic
  paper.doi = canonicalDoi(first(ids.doi)) || arxivDoi(paper.arxiv_id)
  paper.title = cleanText(r.title) || ''
  paper.authors = (Array.isArray(r.authors) ? r.authors : []).map((name) => ({ name: String(name) })).filter((author) => author.name)
  paper.year = yearOf(r.createdDate)
  paper.abstract = cleanText(r.abstract)
  paper.url = paper.doi && !isPreprintDoi(paper.doi) ? `https://doi.org/${paper.doi}`
    : paper.arxiv_id ? `https://arxiv.org/abs/${paper.arxiv_id}`
      : paper.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`
        : (paper.doi ? `https://doi.org/${paper.doi}` : null)
  return paper
}

/**
 * One Parallel web-search row, kept only if it is plausibly a paper. Parallel returns
 * no DOI field, so identity comes from the URL: an explicit DOI, an arXiv or PubMed
 * id. A page with none of these and on no scholarly host is news or a blog and is dropped.
 */
export function fromParallelResult(row) {
  if (!row || typeof row !== 'object') return null
  const url = String(row.url || '').trim()
  if (!url || !isScholarlyUrl(url)) return null
  const paper = emptyPaper('parallel')
  paper.source_id = url
  paper.url = url
  paper.doi = doiFromUrl(url)
  const arxiv = url.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?(?:v\d+)?(?:[?#]|$)/i)
  if (arxiv) paper.arxiv_id = canonicalArxivId(arxiv[1])
  const pubmed = url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{5,9})/i)
  if (pubmed) paper.pmid = pubmed[1]
  const pmc = url.match(/\/(PMC\d+)/i)
  if (pmc) paper.pmcid = canonicalPmcid(pmc[1])
  paper.title = cleanText(row.title) || url
  const publish = String(row.publish_date || '').match(/^(\d{4})/)
  paper.year = publish ? Number(publish[1]) : null
  const excerpts = Array.isArray(row.excerpts) ? row.excerpts.filter(Boolean).join(' ') : ''
  paper.abstract = excerpts ? cleanText(excerpts).slice(0, 1500) : null
  return paper
}

const SCALAR_FIELDS = [
  'source_id', 'pmid', 'pmcid', 'arxiv_id', 'openalex_id', 's2_id',
  'bibcode', 'inspire_id', 'acl_id', 'scopus_id', 'wos_uid',
  'wikidata_qid', 'texkey',
  'title', 'year', 'venue', 'tldr', 'journal_quartile', 'oa_status', 'oa_url',
  'pdf_url', 'html_url', 'url', 'type', 'full_text', 'bibtex', 'publisher',
  'volume', 'issue', 'pages', 'takeaway', 'study_type',
]

function mergeJournalFields(target, source) {
  if (!source) return
  if (!target.journal) {
    target.journal = {
      ...source,
      issns: Array.isArray(source.issns) ? [...source.issns] : [],
    }
    return
  }
  const journal = target.journal
  for (const field of ['name', 'issn_l', 'publisher', 'source_id', 'apc_usd', 'oa_license', 'homepage_url']) {
    if (!journal[field] && source[field]) journal[field] = source[field]
  }
  for (const field of ['is_oa', 'is_in_doaj']) {
    if (journal[field] == null && source[field] != null) journal[field] = source[field]
  }
  journal.issns = [...new Set([...(journal.issns || []), ...(source.issns || [])])]
  if (source.metrics) {
    journal.metrics = { ...(journal.metrics || {}), ...Object.fromEntries(
      Object.entries(source.metrics).filter(([, value]) => value != null),
    ) }
  }
  if (Array.isArray(source.topics)) {
    journal.topics = [...new Set([...(journal.topics || []), ...source.topics])]
  }
}

/**
 * Identity keys for a record, as [key, weak] pairs. Strong keys are identifiers: two
 * records sharing one are the same work. Weak keys are title-based and only count when
 * `weakCompatible` agrees, so a shared title never merges two papers that carry
 * different DOIs.
 */
function identityKeys(paper) {
  const keys = []
  const strong = (name, value) => { if (value) keys.push([`${name}:${value}`, false]) }
  strong('doi', paper.doi)
  for (const doi of paper.preprint_dois || []) strong('doi', doi)
  for (const doi of paper.other_dois || []) strong('doi', doi)
  strong('pmid', paper.pmid)
  strong('pmcid', paper.pmcid)
  strong('arxiv', paper.arxiv_id)
  strong('openalex', paper.openalex_id)
  strong('s2', paper.s2_id)
  strong('bibcode', paper.bibcode)
  strong('inspire', paper.inspire_id)
  strong('acl', paper.acl_id)
  strong('scopus', paper.scopus_id)
  strong('wos', paper.wos_uid)
  strong('wikidata', paper.wikidata_qid)
  const title = normalizeTitle(paper.title)
  if (title && paper.year != null) keys.push([`title:${title}:${paper.year}`, true])
  // A long exact title is identifying even when a source gives no year (Parallel, Scite).
  if (title && title.split(' ').length >= 6) keys.push([`titlelong:${title}`, true])
  return keys
}

/**
 * May a title match stand? Not when both records carry published DOIs that differ
 * ("Editorial" in two journals). A preprint DOI and a published DOI are one work.
 */
function weakCompatible(existing, paper) {
  if (existing.doi && paper.doi && existing.doi !== paper.doi) {
    const known = [existing.doi, ...(existing.preprint_dois || []), ...(existing.other_dois || [])]
    if (!known.includes(paper.doi) && !isPreprintDoi(existing.doi) && !isPreprintDoi(paper.doi)) return false
  }
  if (existing.year != null && paper.year != null && Math.abs(existing.year - paper.year) > 1) return false
  return true
}

function findMatch(index, merged, paper) {
  let rejected = null
  for (const [key, weak] of identityKeys(paper)) {
    const position = index.get(key)
    if (position == null) continue
    if (weak && !weakCompatible(merged[position], paper)) {
      if (rejected == null) rejected = position
      continue
    }
    return { position, rejected: null }
  }
  return { position: -1, rejected }
}

function register(index, record, position) {
  for (const [key, weak] of identityKeys(record)) {
    if (!weak || !index.has(key)) index.set(key, position)
  }
}

function addUnique(list, value) {
  if (value && !list.includes(value)) list.push(value)
}

/** Two records with one title and two published DOIs stay apart but point at each other. */
function linkSameTitle(a, b) {
  if (!a || !b || !a.doi || !b.doi) return
  addUnique((a.same_title_dois ||= []), b.doi)
  addUnique((b.same_title_dois ||= []), a.doi)
}

/**
 * DOI policy when records merge. A published DOI beats a preprint DOI and the preprint
 * DOI is kept in `preprint_dois`; two published DOIs on one record (merged through a
 * shared PMID, say) keep the first and list the other in `other_dois`. No DOI is dropped.
 */
function mergeDoi(target, source) {
  if (!source.doi || source.doi === target.doi) return
  if (!target.doi) { target.doi = source.doi; return }
  const targetPre = isPreprintDoi(target.doi)
  const sourcePre = isPreprintDoi(source.doi)
  if (targetPre && !sourcePre) {
    addUnique((target.preprint_dois ||= []), target.doi)
    target.doi = source.doi
  } else if (sourcePre && !targetPre) {
    addUnique((target.preprint_dois ||= []), source.doi)
  } else if (sourcePre && targetPre) {
    addUnique((target.preprint_dois ||= []), source.doi)
  } else {
    addUnique((target.other_dois ||= []), source.doi)
  }
}

function mergeInto(target, source) {
  mergeDoi(target, source)
  for (const doi of source.preprint_dois || []) { if (doi !== target.doi) addUnique((target.preprint_dois ||= []), doi) }
  if (source.scite && !target.scite) target.scite = source.scite
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
  if ((source.reference_count ?? -1) > (target.reference_count ?? -1)) {
    target.reference_count = source.reference_count
  }
  if (source.journal) mergeJournalFields(target, source.journal)
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
  biorxiv: 8,
  inspire: 10,
  ads: 11,
  scopus: 12,
  wos: 13,
  acl: 14,
  wikidata: 15,
  scite: 16,
  firecrawl: 17,
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
    const { position, rejected } = findMatch(index, merged, paper)
    if (position >= 0) {
      mergeInto(merged[position], paper)
      register(index, merged[position], position)
    } else {
      const copy = {
        ...paper,
        sources: [...(paper.sources || [paper.source])],
        authors: [...(paper.authors || [])],
        fields: [...(paper.fields || [])],
        snippets: [...(paper.snippets || [])],
      }
      merged.push(copy)
      if (rejected != null) linkSameTitle(merged[rejected], copy)
      register(index, copy, merged.length - 1)
    }
  }
  return sortPapers(merged)
}

/**
 * Sources that are one index seen through different doors vote once. Crossref and its
 * publisher-member searches are the same deposits, so a paper found by both is not
 * twice as relevant. Every other source is its own family.
 */
export function defaultFamily(source) {
  const name = String(source || '')
  return name === 'crossref' || name.startsWith('publisher:') ? 'crossref' : name
}

/**
 * Reciprocal-rank fusion for multi-source results.
 * `groups` is [{ source, results }] in provider-relevance order. A paper's score is the
 * sum over source families of the best 1/(k+rank) any member of that family gave it.
 */
export function mergeRanked(groups, { k = 60, family = defaultFamily } = {}) {
  const merged = []
  const index = new Map()
  const votes = new Map()
  for (const group of groups) {
    const results = Array.isArray(group?.results) ? group.results : []
    const familyName = family(group?.source)
    results.forEach((paper, rank) => {
      if (!paper || !paper.title) return
      const score = 1 / (k + rank + 1)
      const { position, rejected } = findMatch(index, merged, paper)
      let target
      if (position >= 0) {
        target = merged[position]
        mergeInto(target, paper)
      } else {
        target = {
          ...paper,
          sources: [...(paper.sources || [paper.source])],
          authors: [...(paper.authors || [])],
          fields: [...(paper.fields || [])],
          snippets: [...(paper.snippets || [])],
          rrf_score: 0,
        }
        merged.push(target)
        if (rejected != null) linkSameTitle(merged[rejected], target)
      }
      register(index, target, merged.indexOf(target))
      const best = votes.get(target) || votes.set(target, new Map()).get(target)
      best.set(familyName, Math.max(best.get(familyName) ?? 0, score))
    })
  }
  for (const [record, best] of votes) record.rrf_score = [...best.values()].reduce((sum, value) => sum + value, 0)
  return merged.sort((a, b) => b.rrf_score - a.rrf_score)
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

export function renderPapers(papers, { maxAuthors = 3, abstractChars = 0, showSources = false } = {}) {
  if (!Array.isArray(papers) || papers.length === 0) return 'No results.'
  return papers.map((paper, i) => {
    const bits = [`${i + 1}. **${paper.title || '(untitled)'}**`]
    const meta = [authorLine(paper.authors, maxAuthors), paper.year, paper.venue].filter(Boolean).join(' · ')
    if (meta) bits.push(meta)
    const ids = []
    if (paper.doi) ids.push(`doi: ${paper.doi}`)
    if (paper.preprint_dois?.length) ids.push(`preprint: ${paper.preprint_dois.join(', ')}`)
    if (paper.other_dois?.length) ids.push(`also doi: ${paper.other_dois.join(', ')}`)
    if (paper.pmid) ids.push(`pmid: ${paper.pmid}`)
    if (paper.arxiv_id) ids.push(`arXiv: ${paper.arxiv_id}`)
    if (paper.openalex_id) ids.push(`openalex: ${paper.openalex_id}`)
    if (paper.inspire_id) ids.push(`INSPIRE: ${paper.inspire_id}`)
    if (paper.bibcode) ids.push(`bibcode: ${paper.bibcode}`)
    if (paper.acl_id) ids.push(`ACL: ${paper.acl_id}`)
    if (paper.scopus_id) ids.push(`Scopus: ${paper.scopus_id}`)
    if (paper.wos_uid) ids.push(`WoS: ${paper.wos_uid}`)
    if (paper.wikidata_qid) ids.push(`Wikidata: ${paper.wikidata_qid}`)
    if (paper.citation_count != null) ids.push(`${paper.citation_count} citations`)
    if (paper.licence) ids.push(`licence: ${paper.licence}`)
    if (paper.oa_url) ids.push(`oa: ${paper.oa_url}`)
    if (ids.length) bits.push(ids.join(' · '))
    if (paper.scite) bits.push(`scite: ${paper.scite.supporting} supporting · ${paper.scite.contrasting} contrasting · ${paper.scite.mentioning} mentioning`)
    if (paper.takeaway) bits.push(`takeaway: ${paper.takeaway}`)
    if (paper.same_title_dois?.length) bits.push(`same title, different DOI (distinct work): ${paper.same_title_dois.join(', ')}`)
    if (paper.tldr) bits.push(paper.tldr)
    if (paper.url) bits.push(paper.url)
    if (showSources && paper.sources?.length) bits.push(`sources: ${paper.sources.join(', ')}`)
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
  const pmcid = canonicalPmcid(/^(?:pmcid:\s*)?PMC\d+$/i.test(raw) ? raw : null)
  if (pmcid) return { kind: 'pmcid', value: pmcid }
  const pmid = raw.match(/^(?:pmid:\s*)?(\d{5,9})$/i)
  if (pmid) return { kind: 'pmid', value: pmid[1] }
  if (/^[0-9a-f]{40}$/i.test(raw)) return { kind: 's2', value: raw }
  const scopus = raw.match(/^(?:scopus|2-s2\.0-|SCOPUS_ID:).+$/i) ? canonicalScopusId(raw) : null
  if (scopus) return { kind: 'scopus', value: scopus }
  const wos = canonicalWosUid(raw)
  if (wos) return { kind: 'wos', value: wos }
  const inspire = canonicalInspireId(raw)
  if (inspire) return { kind: 'inspire', value: inspire }
  const acl = canonicalAclId(raw)
  if (acl) return { kind: 'acl', value: acl }
  const bibcode = canonicalBibcode(raw)
  if (bibcode) return { kind: 'bibcode', value: bibcode }
  if (/^Q\d+$/.test(raw)) return { kind: 'wikidata', value: raw }
  return { kind: 'unknown', value: raw }
}
