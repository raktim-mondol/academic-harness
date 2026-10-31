import assert from 'node:assert/strict'
import { resetLimitersForTests } from '../search-http.js'
import { runDoajArticles, runJournalSearch } from '../journal-search.js'
import { runPaperGet } from '../paper-get.js'
import { runPaperContext } from '../paper-context.js'
import { normalizePublisherAliases, runPublisherSearch } from '../publisher-members.js'
import { catalogWithKeyStatus } from '../academic-databases.js'
import { searchSnippets } from '../semantic-scholar-search.js'

const originalFetch = globalThis.fetch
const calls = []

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function textResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain' },
  })
}

function install(handler) {
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
}

function fresh() {
  resetLimitersForTests()
  calls.length = 0
}

function clearKeys() {
  for (const key of [
    'OPENALEX_API_KEY', 'S2_API_KEY', 'CROSSREF_MAILTO', 'UNPAYWALL_EMAIL',
    'SCOPUS_API_KEY', 'ELSEVIER_INSTTOKEN', 'WOS_API_KEY', 'WILEY_TDM_TOKEN',
    'SPRINGER_API_KEY', 'IEEE_API_KEY', 'NCBI_API_KEY', 'NCBI_EMAIL',
    'CORE_API_KEY', 'ADS_API_TOKEN', 'ELICIT_API_KEY', 'FUTUREHOUSE_API_KEY',
  ]) delete process.env[key]
}

async function loadTool(modulePath) {
  const module = await import(new URL(modulePath, import.meta.url))
  const tools = []
  module.apply({ tools: { register: (tool) => tools.push(tool) } })
  return tools[0]
}

clearKeys()

/* ------------------------------------------------------------- journal search */
const openalexSource = {
  id: 'https://openalex.org/S1',
  display_name: 'Journal One',
  issn_l: '1234-5678',
  issn: ['1234-5678', '8765-4321'],
  host_organization_name: 'Publisher One',
  is_oa: true,
  is_in_doaj: true,
  apc_usd: 1000,
  homepage_url: 'https://journal.example',
  summary_stats: { '2yr_mean_citedness': 3.5, h_index: 10, i10_index: 20 },
  works_count: 100,
  cited_by_count: 2000,
  topics: [{ display_name: 'Topic One' }],
  type: 'journal',
}

const doajJournal = {
  id: 'doaj-1',
  bibjson: {
    title: 'Journal One',
    pissn: '1234-5678',
    publisher: { name: 'Publisher One', country: 'US' },
    apc: { has_apc: true, max: [{ currency: 'USD', price: 1200 }] },
    license: [{ type: 'CC BY' }],
    subject: [{ term: 'Topic One' }],
    ref: { journal: 'https://journal.example' },
  },
}

const crossrefJournal = {
  title: ['Journal One'],
  ISSN: ['1234-5678'],
  publisher: 'Publisher One',
  counts: { 'total-dois': 90 },
  subjects: [{ name: 'Topic One' }],
}

fresh()
install((url) => {
  if (url.includes('api.openalex.org/sources')) return jsonResponse({ results: [openalexSource] })
  if (url.includes('doaj.org/api/v4/search/journals')) return jsonResponse({ results: [doajJournal] })
  if (url.includes('api.crossref.org/v1/journals')) return jsonResponse({ message: { items: [crossrefJournal] } })
  throw new Error(`unexpected journal URL: ${url}`)
})
{
  const value = await runJournalSearch({
    query: 'Journal One',
    providers: ['openalex', 'doaj', 'crossref'],
    include_keyed_metrics: false,
  }, {})
  assert.equal(value.journals.length, 1, 'journal duplicates must merge by ISSN/title')
  const journal = value.journals[0]
  assert.equal(journal.title, 'Journal One')
  assert.equal(journal.metrics.two_year_mean_citedness, 3.5)
  assert.equal(journal.metrics.h_index, 10)
  assert.equal(journal.apc_usd, 1000)
  assert.equal(journal.oa_license, 'CC BY')
  assert.deepEqual(journal.sources.sort(), ['crossref', 'doaj', 'openalex'])
  assert.equal(value.failures.length, 0)
}

fresh()
install((url) => {
  if (url.includes('doaj.org/api/v4/search/articles')) {
    return jsonResponse({
      results: [{
        id: 'article-1',
        bibjson: {
          title: 'An OA Article',
          year: '2024',
          identifier: [{ type: 'doi', id: '10.1000/oa.1' }, { type: 'eissn', id: '1234-5678' }],
          author: [{ name: 'Ada Lovelace' }],
          journal: { title: 'Journal One', publisher: 'Publisher One' },
          link: [{ type: 'fulltext', url: 'https://example.org/oa.pdf', content_type: 'application/pdf' }],
          abstract: 'An abstract',
          subject: [{ term: 'Topic One' }],
        },
      }],
    })
  }
  throw new Error(`unexpected DOAJ article URL: ${url}`)
})
{
  const value = await runDoajArticles({ query: 'OA Article', limit: 5 }, {})
  assert.equal(value.results.length, 1)
  assert.equal(value.results[0].doi, '10.1000/oa.1')
  assert.equal(value.results[0].oa_status, 'gold')
  assert.equal(value.results[0].pdf_url, 'https://example.org/oa.pdf')
}

fresh()
install((url) => {
  if (url.includes('api.openalex.org/sources')) return jsonResponse({ error: 'down' }, 500)
  if (url.includes('doaj.org/api/v4/search/journals')) return jsonResponse({ results: [doajJournal] })
  if (url.includes('api.crossref.org/v1/journals')) return jsonResponse({ message: { items: [crossrefJournal] } })
  throw new Error(`unexpected failure URL: ${url}`)
})
{
  const value = await runJournalSearch({
    query: 'Journal One',
    providers: ['openalex', 'doaj', 'crossref'],
    include_keyed_metrics: false,
  }, {})
  assert.equal(value.failures.length, 1, 'a failed source must not fail the journal search')
  assert.equal(value.journals.length, 1)
}

/* ---------------------------------------------------------------- paper_get */
clearKeys()
process.env.UNPAYWALL_EMAIL = 'test@example.org'
const openalexWork = {
  id: 'https://openalex.org/W123',
  doi: 'https://doi.org/10.1000/test',
  title: 'A Test Paper',
  publication_year: 2024,
  ids: {
    pmid: 'https://pubmed.ncbi.nlm.nih.gov/12345678',
    pmcid: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123',
  },
  authorships: [{ author: { display_name: 'Ada Lovelace' } }],
  primary_location: { source: { display_name: 'Journal One', issn_l: '1234-5678', issn: ['1234-5678'], host_organization_name: 'Publisher One' } },
  best_oa_location: null,
  open_access: { is_oa: false, oa_status: 'closed' },
  cited_by_count: 7,
  referenced_works_count: 11,
  type: 'article',
  topics: [{ display_name: 'Topic One' }],
  abstract_inverted_index: { An: [0], abstract: [1] },
}
const s2Work = {
  paperId: 's2-123',
  externalIds: { DOI: '10.1000/test', PubMed: '12345678', PubMedCentral: 'PMC123' },
  title: 'A Test Paper',
  abstract: 'A longer abstract from Semantic Scholar',
  year: 2024,
  venue: 'Journal One',
  authors: [{ name: 'Ada Lovelace' }],
  citationCount: 9,
  influentialCitationCount: 2,
  referenceCount: 12,
  openAccessPdf: null,
  tldr: { text: 'A short TLDR' },
  publicationTypes: ['JournalArticle'],
  fieldsOfStudy: ['Computer Science'],
  url: 'https://www.semanticscholar.org/paper/s2-123',
  journal: { name: 'Journal One', volume: '12', pages: '1-9' },
  citationStyles: { bibtex: '@article{s2, title={A Test Paper}}' },
}
const crossrefWork = {
  DOI: '10.1000/test',
  title: ['A Test Paper'],
  author: [{ given: 'Ada', family: 'Lovelace' }],
  issued: { 'date-parts': [[2024]] },
  'container-title': ['Journal One'],
  ISSN: ['1234-5678'],
  publisher: 'Publisher One',
  volume: '12',
  issue: '3',
  page: '1-9',
  'is-referenced-by-count': 8,
  'references-count': 42,
  type: 'journal-article',
}
const epmcResult = {
  pmid: '12345678',
  pmcid: 'PMC123',
  doi: '10.1000/test',
  title: 'A Test Paper',
  authorString: 'Ada Lovelace',
  journalTitle: 'Journal One',
  pubYear: '2024',
  citedByCount: 7,
  isOpenAccess: 'N',
  fullTextUrlList: { fullTextUrl: [] },
}

fresh()
install((url) => {
  if (url.includes('api.openalex.org/works/doi:')) return jsonResponse(openalexWork)
  if (url.includes('api.semanticscholar.org/graph/v1/paper/DOI:')) return jsonResponse(s2Work)
  if (url.includes('api.crossref.org/works/')) return jsonResponse({ message: crossrefWork })
  if (url.includes('europepmc/webservices/rest/search')) return jsonResponse({ resultList: { result: [epmcResult] } })
  throw new Error(`unexpected paper_get URL: ${url}`)
})
{
  const value = await runPaperGet({ identifier: '10.1000/test', include_bibtex: false, include_oa: false }, {})
  assert.equal(value.paper.title, 'A Test Paper')
  assert.equal(value.paper.doi, '10.1000/test')
  assert.equal(value.paper.pmid, '12345678')
  assert.equal(value.paper.pmcid, 'PMC123')
  assert.equal(value.paper.journal.name, 'Journal One')
  assert.equal(value.paper.reference_count, 42)
  assert.ok(value.paper.sources.includes('openalex'))
  assert.ok(value.paper.sources.includes('s2'))
  assert.ok(value.paper.sources.includes('crossref'))
  assert.ok(value.paper.sources.includes('pubmed'))
}

fresh()
install((url) => {
  if (url.includes('api.openalex.org/works/doi:')) return jsonResponse(openalexWork)
  if (url.includes('api.semanticscholar.org/graph/v1/paper/DOI:')) return jsonResponse(s2Work)
  if (url.includes('api.crossref.org/works/')) return jsonResponse({ message: crossrefWork })
  if (url.includes('europepmc/webservices/rest/search')) return jsonResponse({ resultList: { result: [epmcResult] } })
  if (url.includes('api.unpaywall.org/v2/')) {
    return jsonResponse({ is_oa: true, oa_status: 'gold', best_oa_location: { url_for_pdf: 'https://example.org/oa.pdf' } })
  }
  throw new Error(`unexpected OA URL: ${url}`)
})
{
  const value = await runPaperGet({ identifier: '10.1000/test', include_bibtex: false, include_oa: true }, {})
  assert.equal(value.paper.oa_url, 'https://example.org/oa.pdf')
  assert.equal(value.paper.oa_status, 'gold')
}

fresh()
install((url) => {
  if (url.startsWith('https://doi.org/')) return textResponse('@article{test, title={A Test Paper}}')
  if (url.includes('api.openalex.org/works/doi:')) return jsonResponse(openalexWork)
  if (url.includes('api.semanticscholar.org/graph/v1/paper/DOI:')) return jsonResponse(s2Work)
  if (url.includes('api.crossref.org/works/')) return jsonResponse({ message: crossrefWork })
  if (url.includes('europepmc/webservices/rest/search')) return jsonResponse({ resultList: { result: [epmcResult] } })
  throw new Error(`unexpected BibTeX URL: ${url}`)
})
{
  const value = await runPaperGet({ identifier: '10.1000/test', include_bibtex: true, include_oa: false }, {})
  assert.match(value.bibtex, /@article\{test/)
  assert.equal(value.bibtex_source, 'doi')
}

const arxivEntry = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <title>An arXiv Paper</title>
    <summary>An arXiv abstract</summary>
    <published>2024-01-01T00:00:00Z</published>
    <author><name>Ada Lovelace</name></author>
    <link title="pdf" href="https://arxiv.org/pdf/2401.12345"/>
    <link rel="alternate" href="https://arxiv.org/abs/2401.12345"/>
    <arxiv:primary_category term="cs.CL"/>
  </entry>
</feed>`
const arxivOpenAlex = {
  ...openalexWork,
  id: 'https://openalex.org/W124',
  doi: 'https://doi.org/10.48550/arXiv.2401.12345',
  title: 'An arXiv Paper',
  ids: {},
  primary_location: { source: { display_name: 'arXiv' } },
}
fresh()
install((url) => {
  if (url.includes('export.arxiv.org/api/query')) return textResponse(arxivEntry)
  if (url.includes('api.openalex.org/works/doi:10.48550/arXiv.2401.12345')) return jsonResponse(arxivOpenAlex)
  if (url.includes('api.semanticscholar.org/graph/v1/paper/ARXIV:')) return jsonResponse({ ...s2Work, externalIds: { ArXiv: '2401.12345' }, title: 'An arXiv Paper' })
  throw new Error(`unexpected arXiv URL: ${url}`)
})
{
  const value = await runPaperGet({ identifier: '2401.12345', include_bibtex: false, include_oa: false }, {})
  assert.equal(value.paper.arxiv_id, '2401.12345')
  assert.equal(value.paper.title, 'An arXiv Paper')
}

fresh()
install((url) => {
  if (url.includes('api.openalex.org/works?')) return jsonResponse({ results: [openalexWork] })
  if (url.includes('api.crossref.org/works?')) return jsonResponse({ message: { items: [crossrefWork] } })
  throw new Error(`unexpected title URL: ${url}`)
})
{
  const value = await runPaperGet({ identifier: 'A Test Paper', include_bibtex: false, include_oa: false }, {})
  assert.equal(value.matched_by, 'title')
  assert.equal(value.paper.title, 'A Test Paper')
}

fresh()
install((url) => {
  if (url.includes('europepmc/webservices/rest/search')) return jsonResponse({ resultList: { result: [epmcResult] } })
  if (url.includes('api.openalex.org/works/pmcid:PMC123')) return jsonResponse(openalexWork)
  if (url.includes('api.openalex.org/works/pmid:12345678')) return jsonResponse(openalexWork)
  if (url.includes('api.semanticscholar.org/graph/v1/paper/PMCID:')) return jsonResponse(s2Work)
  if (url.includes('api.semanticscholar.org/graph/v1/paper/PMID:')) return jsonResponse(s2Work)
  throw new Error(`unexpected PMID/PMCID URL: ${url}`)
})
{
  const pmcid = await runPaperGet({ identifier: 'PMC123', include_bibtex: false, include_oa: false }, {})
  assert.equal(pmcid.matched_by, 'pmcid')
  assert.equal(pmcid.paper.pmcid, 'PMC123')
  const pmid = await runPaperGet({ identifier: 'PMID:12345678', include_bibtex: false, include_oa: false }, {})
  assert.equal(pmid.matched_by, 'pmid')
  assert.equal(pmid.paper.pmid, '12345678')
  assert.equal(pmid.paper.title, 'A Test Paper')
}

/* -------------------------------------------------------------- paper_context */
const contextPaper = {
  title: 'A Test Paper',
  doi: '10.1000/test',
  arxiv_id: '2401.12345',
  pmid: null,
  pmcid: null,
  s2_id: 's2-123',
  abstract: 'An abstract',
  tldr: 'A TLDR',
  sources: ['openalex'],
  pdf_url: null,
  oa_url: null,
  html_url: null,
}
{
  const value = await runPaperContext({
    identifier: '10.1000/test',
    focus_query: 'method',
    max_chars: 5000,
    include_pdf: false,
  }, {}, {
    paperGet: async () => ({ paper: contextPaper, bibtex: '@article{test}' }),
    searchSnippets: async () => [{ paper: null, section: 'Methods', text: 'We used a method with enough detail.', score: 0.9, source: 'semantic_scholar_snippet' }],
    fetchText: async () => ({
      ok: true,
      data: '<article><h2>Methods</h2><p>We used a detailed method that is long enough to be included in the context extraction.</p><h2>Results</h2><p>The results were also long enough to be included in the extracted sections.</p></article>',
    }),
    fetchJson: async () => ({ ok: false, status: 404 }),
  })
  assert.ok(value.sections.length >= 1)
  assert.ok(value.snippets.some((snippet) => snippet.section === 'Methods'))
  assert.ok(value.extraction_sources.includes('semantic_scholar_snippet'))
  assert.ok(value.extraction_sources.includes('arxiv_html'))
  assert.equal(value.bibtex, '@article{test}')
}

{
  const biocPaper = {
    title: 'A Biomedical Paper',
    doi: '10.1000/biomed',
    arxiv_id: null,
    pmid: '12345678',
    pmcid: 'PMC123',
    s2_id: null,
    abstract: 'Biomedical abstract',
    tldr: null,
    sources: ['pubmed'],
    pdf_url: null,
    oa_url: null,
    html_url: null,
  }
  const value = await runPaperContext({ identifier: 'PMC123', include_pdf: false }, {}, {
    paperGet: async () => ({ paper: biocPaper, bibtex: null }),
    searchSnippets: async () => [],
    fetchText: async () => ({ ok: false, status: 404 }),
    fetchJson: async () => ({
      ok: true,
      data: {
        documents: [{
          passages: [
            { infons: { section_type: 'METHODS' }, text: 'The methods passage is long enough to be retained for context.' },
            { infons: { section_type: 'RESULTS' }, text: 'The results passage is also long enough to be retained for context.' },
            { infons: { section_type: 'REF' }, text: 'Reference passages are skipped entirely.' },
          ],
        }],
      },
    }),
  })
  assert.ok(value.sections.some((section) => section.heading === 'METHODS'))
  assert.ok(value.extraction_sources.includes('ncbi_pmc_bioc_json'))
  assert.ok(!value.sections.some((section) => section.heading === 'REF'))
}

{
  const pubtatorPaper = {
    title: 'A PubTator Paper',
    doi: '10.1000/pubtator',
    arxiv_id: null,
    pmid: '99999999',
    pmcid: 'PMC999',
    s2_id: null,
    abstract: 'PubTator abstract',
    tldr: null,
    sources: ['pubmed'],
    pdf_url: null,
    oa_url: null,
    html_url: null,
  }
  const value = await runPaperContext({ identifier: 'PMID:99999999', include_pdf: false }, {}, {
    paperGet: async () => ({ paper: pubtatorPaper, bibtex: null }),
    searchSnippets: async () => [],
    fetchText: async () => ({ ok: false, status: 404 }),
    fetchJson: async (url) => {
      if (String(url).includes('pmcoa.cgi')) return { ok: true, data: { documents: [{ passages: [] }] } }
      if (String(url).includes('pubtator3-api')) {
        return {
          ok: true,
          data: {
            PubTator3: [{
              passages: [
                { infons: { section_type: 'METHODS' }, text: 'A PubTator methods passage that is long enough to be retained.' },
                { infons: { section_type: 'RESULTS' }, text: 'A PubTator results passage that is long enough to be retained.' },
              ],
            }],
          },
        }
      }
      return { ok: false, status: 404 }
    },
  })
  assert.ok(value.sections.length >= 1)
  assert.ok(value.extraction_sources.includes('ncbi_pubtator3_biocjson'))
}

{
  const pdfPaper = {
    title: 'A PDF Paper',
    doi: '10.1000/pdf',
    arxiv_id: null,
    pmid: null,
    pmcid: null,
    s2_id: null,
    abstract: 'PDF abstract',
    tldr: null,
    sources: ['openalex'],
    pdf_url: 'https://example.org/paper.pdf',
    oa_url: null,
    html_url: null,
  }
  const value = await runPaperContext({ identifier: '10.1000/pdf', include_pdf: true, include_bibtex: false }, {}, {
    paperGet: async () => ({ paper: pdfPaper, bibtex: null }),
    searchSnippets: async () => [],
    fetchText: async () => ({ ok: false, status: 404 }),
    fetchJson: async () => ({ ok: false, status: 404 }),
    fetchPdf: async () => Buffer.from('%PDF-1.4'),
    convertPdf: async () => ({
      success: true,
      markdown: '# Methods\nA long paragraph from the PDF that should become a section in the context result.\n\n# Results\nAnother long paragraph from the PDF that should also become a section.',
    }),
  })
  assert.ok(value.sections.length >= 1)
  assert.ok(value.extraction_sources.includes('open_access_pdf_pdf_inspector'))
}

{
  const paper = { ...contextPaper, arxiv_id: null, s2_id: null, pdf_url: null, oa_url: null }
  const value = await runPaperContext({ identifier: '10.1000/test', include_pdf: false }, {}, {
    paperGet: async () => ({ paper, bibtex: null }),
    searchSnippets: async () => [],
    fetchText: async () => ({ ok: false, status: 404 }),
    fetchJson: async () => ({ ok: false, status: 404 }),
  })
  assert.equal(value.sections.length, 0)
  assert.ok(value.warnings.some((warning) => warning.startsWith('no_full_text')))
  assert.equal(value.abstract, 'An abstract')
}

/* ------------------------------------------------------- S2 snippet scoping */
fresh()
install((url) => {
  assert.match(url, /snippet\/search/)
  assert.match(url, /paperIds=s2-1/)
  return jsonResponse({
    data: [{
      paper: { title: 'A Test Paper' },
      snippet: { text: 'A paper-scoped snippet.', section: 'Methods' },
      score: 0.91,
    }],
  })
})
{
  const snippets = await searchSnippets({ query: 'method', paperIds: ['s2-1'], limit: 3 })
  assert.equal(snippets.length, 1)
  assert.equal(snippets[0].section, 'Methods')
  assert.equal(snippets[0].text, 'A paper-scoped snippet.')
  assert.equal(snippets[0].score, 0.91)
}

/* ------------------------------------------------------- citation identifier */
fresh()
install((url) => {
  if (url.startsWith('https://doi.org/')) return textResponse('@article{test, title={A Test Paper}}')
  throw new Error(`unexpected citation identifier URL: ${url}`)
})
{
  const tool = await loadTool('../citation.js')
  const value = await tool.execute({ action: 'bibtex', identifier: '10.1000/test' }, {})
  assert.match(value.bibtex, /@article\{test/)
  assert.equal(value.source, 'doi')
}

/* -------------------------------------------------------------- citations */
fresh()
install((url) => {
  if (url.includes('api.openalex.org/works/doi:')) {
    return jsonResponse({ id: 'https://openalex.org/W123', doi: 'https://doi.org/10.1000/test', title: 'A Test Paper' })
  }
  if (url.includes('filter=cites:')) return jsonResponse({ results: [] })
  if (url.includes('api.openalex.org/works/W123')) return jsonResponse({ referenced_works: [] })
  if (url.includes('api.opencitations.net/index/v2/citations/doi:')) {
    return jsonResponse([{ oci: '01', citing: '10.1000/citing', cited: '10.1000/test', creation: '2023-01-01', timespan: 'P1Y' }])
  }
  if (url.includes('api.opencitations.net/index/v2/references/doi:')) {
    return jsonResponse([{ oci: '02', citing: '10.1000/test', cited: '10.1000/ref', creation: '2022-01-01', timespan: 'P2Y' }])
  }
  throw new Error(`unexpected citation URL: ${url}`)
})
{
  const tool = await loadTool('../openalex-cite.js')
  const value = await tool.execute({ id: '10.1000/test', direction: 'both', limit: 5 }, {})
  assert.equal(value.citing.results.length, 1)
  assert.equal(value.references.results.length, 1)
  assert.deepEqual(value.providers, ['opencitations'])
  assert.match(value.citing.results[0].title, /Citing work/)
  assert.match(value.references.results[0].title, /Referenced work/)
  assert.ok(value.note)
}

/* --------------------------------------------------------------- publishers */
fresh()
install((url) => {
  if (url.includes('api.crossref.org/v1/members/340/works')) {
    return jsonResponse({
      message: {
        'total-results': 1,
        items: [{
          DOI: '10.1371/journal.one',
          title: ['A PLOS Paper'],
          author: [{ given: 'Ada', family: 'Lovelace' }],
          issued: { 'date-parts': [[2024]] },
          'container-title': ['PLOS ONE'],
          publisher: 'PLOS',
          ISSN: ['1932-6203'],
          type: 'journal-article',
        }],
      },
    })
  }
  throw new Error(`unexpected publisher URL: ${url}`)
})
{
  const value = await runPublisherSearch({ publisher: 'plos', query: 'paper', limit: 5 }, {})
  assert.equal(value.publisher, 'plos')
  assert.equal(value.results.length, 1)
  assert.equal(value.results[0].title, 'A PLOS Paper')
  assert.deepEqual(value.results[0].sources, ['plos'])
  const aliases = normalizePublisherAliases('plos,unknown')
  assert.deepEqual(aliases.aliases, ['plos'])
  assert.deepEqual(aliases.unknown, ['unknown'])
}

fresh()
install((url) => {
  if (url.includes('api.crossref.org/v1/members/340/works')) {
    return jsonResponse({
      message: {
        'total-results': 1,
        items: [{
          DOI: '10.1371/journal.one',
          title: ['A PLOS Paper'],
          issued: { 'date-parts': [[2024]] },
          'container-title': ['PLOS ONE'],
          type: 'journal-article',
        }],
      },
    })
  }
  throw new Error(`unexpected router publisher URL: ${url}`)
})
{
  const tool = await loadTool('../literature-search.js')
  const value = await tool.execute({
    query: 'paper',
    sources: ['publishers'],
    publishers: ['plos'],
    max_results: 5,
  }, {})
  assert.equal(value.papers.length, 1)
  assert.equal(value.papers[0].title, 'A PLOS Paper')
  assert.ok(value.sources.includes('publisher:plos'))
}

/* ----------------------------------------------------------------- catalog */
clearKeys()
delete process.env.OPENALEX_API_KEY
{
  const before = await catalogWithKeyStatus()
  const openalex = before.find((entry) => entry.id === 'openalex')
  assert.equal(openalex.configured, false)
  process.env.OPENALEX_API_KEY = 'secret-test-key'
  const after = await catalogWithKeyStatus()
  assert.equal(after.find((entry) => entry.id === 'openalex').configured, true)
  assert.ok(!JSON.stringify(after).includes('secret-test-key'), 'catalog must not expose key values')
  delete process.env.OPENALEX_API_KEY
}

globalThis.fetch = originalFetch
console.log('Academic search parity OK')
