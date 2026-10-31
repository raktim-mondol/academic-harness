import assert from 'node:assert/strict'
import { buildParams as buildOpenAlexParams } from '../openalex-search.js'
import { buildSearchQuery } from '../arxiv-search.js'
import { buildParams as buildBraveParams } from '../brave-search.js'
import { buildBody as buildParallelExtractBody } from '../parallel-extract.js'
import { buildBody as buildTavilyBody } from '../tavily-search.js'
import { buildBody as buildExaBody } from '../exa-search.js'
import { buildBody as buildPerplexityBody } from '../perplexity-search.js'
import { buildRequest as buildJinaRequest } from '../jina-reader.js'
import { buildParams as buildCoreParams } from '../core-search.js'
import { buildBody as buildElicitBody } from '../elicit-search.js'
import { buildCreateBody as buildFutureHouseBody, summarizeTask } from '../futurehouse-agent.js'
import {
  capText,
  canonicalArxivId,
  canonicalBibcode,
  canonicalDoi,
  canonicalPmcid,
  canonicalScopusId,
  canonicalWosUid,
  fromAdsDoc,
  fromArxivEntry,
  fromBiorxivRecord,
  fromBraveResult,
  fromCoreResult,
  fromCrossrefWork,
  fromElicitPaper,
  fromElicitTrial,
  fromEuropePmcResult,
  fromInspireHit,
  fromNcbiSummary,
  fromOpenAlexWork,
  fromPerplexityResult,
  fromExaResult,
  fromScopusEntry,
  fromTavilyResult,
  fromSemanticScholarPaper,
  fromSemanticScholarSnippet,
  fromWosHit,
  identifierKind,
  mergePapers,
  mergeRanked,
  normalizeTitle,
  reconstructAbstract,
  renderPapers,
} from '../search-normalize.js'

assert.equal(canonicalDoi('https://doi.org/10.1000/ABC.1'), '10.1000/abc.1')
assert.equal(canonicalDoi('doi: 10.1000/ABC.1'), '10.1000/abc.1')
assert.equal(canonicalDoi('not-a-doi'), null)
assert.equal(canonicalArxivId('arXiv:2301.12345v2'), '2301.12345')
assert.equal(canonicalArxivId('https://arxiv.org/abs/hep-th/9901001'), 'hep-th/9901001')
assert.equal(normalizeTitle('A <i>Test</i> Paper!'), 'a test paper')
assert.equal(reconstructAbstract({ Hello: [0], world: [1] }), 'Hello world')
assert.match(capText('x'.repeat(30), 10), /\[output truncated\]/)

assert.deepEqual(identifierKind('https://doi.org/10.1000/abc.1'), { kind: 'doi', value: '10.1000/abc.1' })
assert.deepEqual(identifierKind('PMID: 12345678'), { kind: 'pmid', value: '12345678' })
assert.deepEqual(identifierKind('PMC11223843'), { kind: 'pmcid', value: 'PMC11223843' })
assert.equal(canonicalPmcid('pmcid:PMC11223843'), 'PMC11223843')
assert.deepEqual(identifierKind('2301.12345'), { kind: 'arxiv', value: '2301.12345' })
assert.deepEqual(identifierKind('W2741809807'), { kind: 'openalex', value: 'W2741809807' })
assert.equal(identifierKind('a'.repeat(40)).kind, 's2')
assert.deepEqual(identifierKind('recid:12345'), { kind: 'inspire', value: '12345' })
assert.equal(identifierKind('conf/x/y').kind, 'unknown', 'DBLP identifiers are no longer recognized')
assert.deepEqual(identifierKind('2024.acl-long.1'), { kind: 'acl', value: '2024.acl-long.1' })
assert.deepEqual(identifierKind('2-s2.0-123'), { kind: 'scopus', value: '2-s2.0-123' })
assert.deepEqual(identifierKind('WOS:000123'), { kind: 'wos', value: 'WOS:000123' })
assert.deepEqual(identifierKind('2024ApJ...123...45L'), { kind: 'bibcode', value: '2024ApJ...123...45L' })
assert.deepEqual(identifierKind('Q42'), { kind: 'wikidata', value: 'Q42' })
assert.equal(identifierKind('???').kind, 'unknown')
assert.equal(canonicalBibcode('2024ApJ...123...45L'), '2024ApJ...123...45L')
assert.equal(canonicalScopusId('2-s2.0-123'), '2-s2.0-123')
assert.equal(canonicalWosUid('wos:000123'), 'WOS:000123')

const openalex = fromOpenAlexWork({
  id: 'https://openalex.org/W123',
  doi: 'https://doi.org/10.1000/ABC.1',
  ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/12345678', pmcid: 'PMC123' },
  title: 'A <i>Test</i> Paper',
  publication_year: 2024,
  authorships: [
    { author: { display_name: 'Ada Lovelace', orcid: 'https://orcid.org/0000-0001' } },
    { author: { display_name: 'Alan Turing' } },
  ],
  primary_location: {
    source: { display_name: 'Journal of Tests' },
    landing_page_url: 'https://example.org/paper',
  },
  best_oa_location: { pdf_url: 'https://example.org/paper.pdf' },
  open_access: { oa_status: 'gold' },
  cited_by_count: 12,
  type: 'article',
  topics: [{ display_name: 'Testing' }],
  abstract_inverted_index: { A: [0], longer: [1], abstract: [2] },
})
assert.equal(openalex.source, 'openalex')
assert.equal(openalex.doi, '10.1000/abc.1')
assert.equal(openalex.pmid, '12345678')
assert.equal(openalex.pmcid, 'PMC123')
assert.equal(openalex.openalex_id, 'W123')
assert.equal(openalex.title, 'A Test Paper')
assert.equal(openalex.year, 2024)
assert.equal(openalex.venue, 'Journal of Tests')
assert.equal(openalex.oa_status, 'gold')
assert.equal(openalex.oa_url, 'https://example.org/paper.pdf')
assert.equal(openalex.abstract, 'A longer abstract')
assert.equal(openalex.authors.length, 2)
assert.deepEqual(openalex.sources, ['openalex'])

const semantic = fromSemanticScholarPaper({
  paperId: 's2-paper',
  externalIds: { DOI: '10.1000/ABC.1', PubMed: '12345678', ArXiv: '2301.12345' },
  title: 'A Test Paper',
  year: 2024,
  venue: 'Journal of Tests',
  authors: [{ name: 'Ada Lovelace' }],
  citationCount: 20,
  influentialCitationCount: 4,
  tldr: { text: 'A one-line summary.' },
  openAccessPdf: { url: 'https://example.org/paper.pdf' },
  fieldsOfStudy: ['Computer Science'],
  publicationTypes: ['JournalArticle'],
})
assert.equal(semantic.s2_id, 's2-paper')
assert.equal(semantic.arxiv_id, '2301.12345')
assert.equal(semantic.tldr, 'A one-line summary.')
assert.equal(semantic.citation_count, 20)
assert.equal(semantic.influential_citation_count, 4)

const snippet = fromSemanticScholarSnippet({
  snippet: { text: '...verbatim excerpt...' },
  paper: { paperId: 's2-paper', title: 'A Test Paper', year: 2024 },
})
assert.deepEqual(snippet.snippets, ['...verbatim excerpt...'])

const crossref = fromCrossrefWork({
  DOI: '10.1000/ABC.1',
  title: ['A Test Paper'],
  author: [{ given: 'Ada', family: 'Lovelace' }],
  issued: { 'date-parts': [[2023]] },
  'container-title': ['Journal of Tests'],
  'is-referenced-by-count': 15,
  URL: 'https://doi.org/10.1000/abc.1',
  abstract: '<jats:p>A <b>longer</b> abstract</jats:p>',
  subject: ['Testing'],
})
assert.equal(crossref.year, 2023)
assert.equal(crossref.venue, 'Journal of Tests')
assert.equal(crossref.citation_count, 15)
assert.equal(crossref.abstract, 'A longer abstract')

const arxiv = fromArxivEntry({
  id: 'http://arxiv.org/abs/2301.12345v2',
  title: 'A Test Preprint',
  summary: 'Preprint abstract',
  published: '2023-01-02T00:00:00Z',
  authors: ['Ada Lovelace', 'Alan Turing'],
  doi: '10.1000/abc.1',
  journalRef: 'Journal of Tests',
  primaryCategory: 'cs.CL',
  categories: ['cs.CL', 'cs.AI'],
  pdfUrl: 'https://arxiv.org/pdf/2301.12345v2',
  absUrl: 'https://arxiv.org/abs/2301.12345v2',
})
assert.equal(arxiv.arxiv_id, '2301.12345')
assert.equal(arxiv.year, 2023)
assert.equal(arxiv.oa_url, 'https://arxiv.org/pdf/2301.12345v2')
assert.deepEqual(arxiv.fields, ['cs.CL', 'cs.AI'])

const europePmc = fromEuropePmcResult({
  id: '26161953',
  source: 'MED',
  pmid: '26161953',
  pmcid: 'PMC4498753',
  doi: '10.1371/journal.pone.0130140',
  title: 'A Test Article',
  authorString: 'Smith J, Doe A.',
  journalTitle: 'PLOS ONE',
  pubYear: '2015',
  abstractText: 'Article abstract',
  citedByCount: 100,
  isOpenAccess: 'Y',
  fullTextUrlList: { fullTextUrl: [{ documentStyle: 'pdf', url: 'https://example.org/a.pdf' }] },
  pubTypeList: { pubType: ['Journal Article'] },
})
assert.equal(europePmc.pmid, '26161953')
assert.equal(europePmc.pmcid, 'PMC4498753')
assert.equal(europePmc.oa_url, 'https://example.org/a.pdf')
assert.equal(europePmc.authors.length, 2)
assert.equal(europePmc.year, 2015)

const ncbi = fromNcbiSummary({
  uid: '12345678',
  title: 'A Test Summary',
  authors: [{ name: 'Smith J' }],
  pubdate: '2024 Jan',
  fulljournalname: 'Journal of Tests',
  articleids: [{ idtype: 'doi', value: '10.1000/abc.1' }, { idtype: 'pmc', value: 'PMC123' }],
})
assert.equal(ncbi.pmid, '12345678')
assert.equal(ncbi.doi, '10.1000/abc.1')
assert.equal(ncbi.oa_status, 'open')
assert.equal(fromNcbiSummary({ uid: '1', error: 'cannot get document summary' }), null)

const biorxiv = fromBiorxivRecord({
  doi: '10.1101/2024.01.01.123456',
  title: 'A <b>Preprint</b>',
  authors: 'Ada Lovelace; Alan Turing',
  date: '2024-01-01',
  version: '2',
  category: 'microbiology',
}, { server: 'medrxiv' })
assert.equal(biorxiv.source, 'biorxiv')
assert.equal(biorxiv.venue, 'medRxiv')
assert.equal(biorxiv.title, 'A Preprint')
assert.equal(biorxiv.authors.length, 2)
assert.deepEqual(biorxiv.fields, ['microbiology'])

const inspire = fromInspireHit({
  metadata: {
    control_number: 123,
    titles: [{ title: 'An INSPIRE Paper' }],
    authors: [{ full_name: 'Ada Lovelace' }],
    publication_info: [{ year: 2024, journal_title: 'JHEP' }],
    dois: [{ value: '10.1000/inspire' }],
    arxiv_eprints: [{ value: '2401.12345' }],
    citation_count: 7,
    texkeys: ['Lovelace:2024aa'],
    abstracts: [{ value: 'Inspire abstract' }],
    subject_terms: [{ term: 'hep-th' }],
  },
})
assert.equal(inspire.inspire_id, '123')
assert.equal(inspire.texkey, 'Lovelace:2024aa')
assert.equal(inspire.arxiv_id, '2401.12345')
assert.equal(inspire.citation_count, 7)
assert.match(renderPapers([inspire]), /INSPIRE: 123/)

const ads = fromAdsDoc({
  bibcode: '2024ApJ...123...45L',
  title: ['An ADS Paper'],
  author: ['Lovelace, A.'],
  year: '2024',
  doi: ['10.1000/ads'],
  citation_count: 11,
  pub: 'ApJ',
})
assert.equal(ads.bibcode, '2024ApJ...123...45L')
assert.equal(ads.doi, '10.1000/ads')
assert.equal(ads.citation_count, 11)

const scopus = fromScopusEntry({
  eid: '2-s2.0-123',
  'dc:identifier': 'SCOPUS_ID:123',
  'dc:title': 'A Scopus Paper',
  'dc:creator': 'Lovelace A.',
  'prism:publicationName': 'Journal',
  'prism:coverDate': '2024-01-01',
  'citedby-count': '4',
  'prism:doi': '10.1000/scopus',
})
assert.equal(scopus.scopus_id, '2-s2.0-123')
assert.equal(scopus.licence, 'restricted')
assert.equal(scopus.citation_count, 4)

const wos = fromWosHit({
  uid: 'WOS:000123',
  title: 'A WoS Paper',
  names: { authors: [{ displayName: 'Lovelace, A.' }] },
  publicationInfo: { pubYear: '2024', sourceTitle: 'Journal' },
  identifiers: { doi: '10.1000/wos' },
  citations: [{ count: 3 }],
})
assert.equal(wos.wos_uid, 'WOS:000123')
assert.equal(wos.licence, 'restricted')
assert.equal(wos.citation_count, 3)

const grouped = buildOpenAlexParams({ entity: 'works', group_by: 'publication_year' }, null, null)
assert.equal(grouped.has('select'), false, 'group_by must not send select')
assert.equal(grouped.get('group_by'), 'publication_year')
assert.equal(buildSearchQuery('Turing', 'author'), 'au:Turing')
assert.equal(buildSearchQuery('Alan Turing', 'author'), 'au:"Alan Turing"')
assert.equal(buildSearchQuery('quantum', 'title'), 'ti:quantum')
assert.equal(buildSearchQuery('cs.CL', 'category'), 'cat:cs.CL')
assert.equal(buildSearchQuery('cat:cs.CL AND abs:retrieval', 'author'), 'cat:cs.CL AND abs:retrieval')

const brave = fromBraveResult({
  title: 'A <b>Web</b> Result',
  url: 'https://www.example.org/post',
  description: 'A description',
  profile: { long_name: 'Example' },
  extra_snippets: ['one', 'two'],
})
assert.equal(brave.source, 'brave')
assert.equal(brave.title, 'A Web Result')
assert.equal(brave.venue, 'Example')
assert.equal(brave.abstract, 'A description')
assert.equal(brave.type, 'web')
assert.deepEqual(brave.snippets, ['one', 'two'])
assert.equal(fromBraveResult({ title: 'T', url: 'https://www.example.org/x' }).venue, 'example.org')

const braveParams = buildBraveParams({ query: 'test', count: 50, country: 'gb', freshness: 'pw', extra_snippets: true })
assert.equal(braveParams.get('q'), 'test')
assert.equal(braveParams.get('count'), '20')
assert.equal(braveParams.get('country'), 'GB')
assert.equal(braveParams.get('freshness'), 'pw')
assert.equal(braveParams.get('extra_snippets'), 'true')

const extractBody = buildParallelExtractBody({
  urls: ['https://a.example/x'],
  objective: 'Get methods',
  search_queries: ['method'],
  full_content: true,
})
assert.deepEqual(extractBody.urls, ['https://a.example/x'])
assert.equal(extractBody.advanced_settings.full_content, true)
assert.throws(() => buildParallelExtractBody({ urls: [] }), /at least one/)
assert.throws(() => buildParallelExtractBody({ urls: ['ftp://example.org/x'] }), /HTTP/)

const tavilyPaper = fromTavilyResult({
  title: 'Tavily <b>Title</b>',
  url: 'https://www.example.org/t',
  content: 'Tavily content',
  published_date: '2024-01-02',
})
assert.equal(tavilyPaper.source, 'tavily')
assert.equal(tavilyPaper.title, 'Tavily Title')
assert.equal(tavilyPaper.abstract, 'Tavily content')
assert.equal(tavilyPaper.year, 2024)
assert.equal(tavilyPaper.venue, 'example.org')

const exaPaper = fromExaResult({
  id: 'exa-1',
  title: 'Exa Title',
  url: 'https://example.org/e',
  summary: 'Exa summary',
  author: 'Ada Lovelace',
  publishedDate: '2023-05-06',
  highlights: ['first highlight'],
})
assert.equal(exaPaper.source, 'exa')
assert.equal(exaPaper.abstract, 'Exa summary')
assert.equal(exaPaper.authors[0].name, 'Ada Lovelace')
assert.equal(exaPaper.year, 2023)
assert.deepEqual(exaPaper.snippets, ['first highlight'])

const perplexityPaper = fromPerplexityResult({
  title: 'Perplexity Title',
  url: 'https://example.org/p',
  snippet: 'Perplexity snippet',
  date: '2024-02-03',
})
assert.equal(perplexityPaper.source, 'perplexity')
assert.equal(perplexityPaper.abstract, 'Perplexity snippet')
assert.equal(perplexityPaper.year, 2024)

const tavilyBody = buildTavilyBody({
  query: 'test',
  search_depth: 'advanced',
  max_results: 50,
  chunks_per_source: 3,
  topic: 'news',
  include_answer: true,
  include_domains: ['example.org'],
})
assert.equal(tavilyBody.max_results, 20)
assert.equal(tavilyBody.chunks_per_source, 3)
assert.equal(tavilyBody.topic, 'news')
assert.equal(tavilyBody.include_answer, 'basic')
assert.deepEqual(tavilyBody.include_domains, ['example.org'])
assert.throws(() => buildTavilyBody({ query: 'x', search_depth: 'ultra-fast', chunks_per_source: 2 }), /ultra-fast/)

const exaBody = buildExaBody({
  query: 'test',
  type: 'deep',
  num_results: 500,
  include_text: true,
  include_highlights: true,
})
assert.equal(exaBody.numResults, 100)
assert.deepEqual(exaBody.contents, { text: true, highlights: true })
assert.throws(
  () => buildExaBody({ query: 'x', category: 'people', start_published_date: '2024-01-01' }),
  /do not support publication-date filters/,
)

const perplexityBody = buildPerplexityBody({
  query: 'test',
  search_type: 'people',
  max_results: 30,
  country: 'gb',
  search_domain_filter: ['example.org'],
  search_language_filter: ['en'],
  search_recency_filter: 'week',
})
assert.equal(perplexityBody.max_results, 30)
assert.equal(perplexityBody.country, 'GB')
assert.deepEqual(perplexityBody.search_language_filter, ['en'])
assert.throws(() => buildPerplexityBody({ query: 'x', max_results: 30 }), /people/)
assert.throws(() => buildPerplexityBody({ query: 'x', country: 'GBR' }), /two-letter/)

const jinaRead = buildJinaRequest({ url: 'https://example.org/a' }, null)
assert.equal(jinaRead.url, 'https://r.jina.ai/https://example.org/a')
assert.equal(jinaRead.headers.Authorization, undefined)
const jinaInferredSearch = buildJinaRequest({ query: 'inferred' }, 'jina-key')
assert.equal(jinaInferredSearch.url, 'https://s.jina.ai/?q=inferred')
assert.equal(jinaInferredSearch.mode, 'search')
const jinaSearch = buildJinaRequest({ mode: 'search', query: 'test query' }, 'jina-key')
assert.equal(jinaSearch.url, 'https://s.jina.ai/?q=test%20query')
assert.equal(jinaSearch.headers.Authorization, 'Bearer jina-key')
assert.throws(() => buildJinaRequest({ mode: 'search' }, 'key'), /query is required/)
assert.throws(() => buildJinaRequest({ url: 'ftp://example.org' }, null), /HTTP/)

const corePaper = fromCoreResult({
  id: 123,
  doi: 'https://doi.org/10.1000/ABC.1',
  pubmedId: '12345678',
  arxivId: '2301.12345',
  title: 'Core <b>Title</b>',
  authors: [{ name: 'Ada Lovelace,' }, { name: 'Alan Turing' }],
  yearPublished: 2022,
  journals: [],
  publisher: 'Repo Press',
  abstract: 'Core abstract',
  citationCount: 7,
  downloadUrl: 'https://core.ac.uk/download/123.pdf',
  links: [{ type: 'display', url: 'https://core.ac.uk/works/123' }],
  fieldOfStudy: 'Article',
  fullText: 'Full text body',
}, { includeFullText: true })
assert.equal(corePaper.source, 'core')
assert.equal(corePaper.doi, '10.1000/abc.1')
assert.equal(corePaper.pmid, '12345678')
assert.equal(corePaper.arxiv_id, '2301.12345')
assert.equal(corePaper.title, 'Core Title')
assert.equal(corePaper.authors[0].name, 'Ada Lovelace')
assert.equal(corePaper.venue, 'Repo Press')
assert.equal(corePaper.oa_url, 'https://core.ac.uk/download/123.pdf')
assert.equal(corePaper.url, 'https://core.ac.uk/works/123')
assert.equal(corePaper.full_text, 'Full text body')
assert.equal(fromCoreResult({ id: 1, title: 'T', fullText: 'body' }).full_text, undefined)
assert.equal(
  fromCoreResult({ id: 2, title: 'T', fullText: 'Not available for public API users.' }, { includeFullText: true }).full_text,
  undefined,
  'CORE keyless sentinel must not be stored as full text',
)

const elicitPaper = fromElicitPaper({
  elicitId: 'elicit-1',
  title: 'Elicit Title',
  authors: ['Ada Lovelace', 'Alan Turing'],
  year: 2024,
  abstract: 'Elicit abstract',
  doi: '10.1000/ABC.1',
  pmid: '12345678',
  venue: 'Journal of Tests',
  citedByCount: 9,
  urls: ['https://example.org/e'],
  studyTypeTags: ['RCT'],
  journalQuartile: 1,
  fullTextUrl: 'https://example.org/e.pdf',
})
assert.equal(elicitPaper.source, 'elicit')
assert.equal(elicitPaper.title, 'Elicit Title')
assert.equal(elicitPaper.year, 2024)
assert.equal(elicitPaper.journal_quartile, 1)
assert.equal(elicitPaper.oa_url, null, 'fullTextUrl is not proof of open access')
assert.equal(elicitPaper.url, 'https://example.org/e')
assert.deepEqual(elicitPaper.fields, ['RCT'])

const elicitTrial = fromElicitTrial({
  nctId: 'NCT123',
  title: 'Trial Title',
  summary: 'Trial summary',
  startDate: '2023-05-01',
  leadSponsor: 'Sponsor',
  url: 'https://clinicaltrials.gov/study/NCT123',
  studyType: 'INTERVENTIONAL',
  conditions: ['Obesity'],
  overallStatus: 'RECRUITING',
  phase: ['PHASE2'],
  enrollmentCount: 100,
  interventions: ['Drug'],
  hasResults: false,
  completionDate: '2025-01-01',
})
assert.equal(elicitTrial.source, 'elicit-trial')
assert.equal(elicitTrial.year, 2023)
assert.equal(elicitTrial.trial.nct_id, 'NCT123')
assert.deepEqual(elicitTrial.trial.phase, ['PHASE2'])
assert.deepEqual(elicitTrial.fields, ['Obesity'])

const coreParams = buildCoreParams({ query: 'test', limit: 500, offset: 3 })
assert.equal(coreParams.get('q'), 'test')
assert.equal(coreParams.get('limit'), '100')
assert.equal(coreParams.get('offset'), '3')

const elicitBody = buildElicitBody({
  kind: 'papers',
  query: 'test',
  type_tags: ['RCT', 'Meta-Analysis'],
  min_year: 2020,
  retracted: 'exclude_retracted',
})
assert.equal(elicitBody.endpoint, 'papers')
assert.deepEqual(elicitBody.body.filters.typeTags, ['RCT', 'Meta-Analysis'])
assert.equal(elicitBody.body.filters.minYear, 2020)
assert.throws(() => buildElicitBody({ query: 'x', search_mode: 'keyword', max_year: 2024 }), /keyword/)
assert.throws(() => buildElicitBody({ query: 'x', max_results: 5000 }), /at most 1000/)
assert.throws(() => buildElicitBody({ query: 'x', min_year: 'abc' }), /must be a number/)

const trialBody = buildElicitBody({
  kind: 'trials',
  query: 'obesity',
  phase: ['PHASE2', 'PHASE3'],
  recruitment_status: ['RECRUITING'],
  has_results: true,
})
assert.equal(trialBody.endpoint, 'trials')
assert.deepEqual(trialBody.body.trialFilters.phase, ['PHASE2', 'PHASE3'])

const futureHouseBody = buildFutureHouseBody({ agent: 'quick_search', query: 'Has X been done?' })
assert.equal(futureHouseBody.name, 'job-futurehouse-paperqa3')
assert.equal(futureHouseBody.query, 'Has X been done?')
assert.equal(buildFutureHouseBody({ agent: 'deep_search', query: 'x' }).name, 'job-futurehouse-paperqa3-high')
assert.equal(buildFutureHouseBody({ agent: 'precedent_search', query: 'x' }).name, 'job-futurehouse-paperqa3-precedent')
assert.throws(() => buildFutureHouseBody({ agent: 'unknown', query: 'x' }), /agent must be one of/)

const summarized = summarizeTask({
  status: 'success',
  task: 'Has X been done?',
  crow: 'job-futurehouse-paperqa3-precedent',
  environment_frame: {
    state: {
      state: {
        response: { answer: { answer: 'Yes.', formatted_answer: 'Yes, in 2020.', has_successful_answer: true } },
        info: { usage: { total_cost: 0.12, total_queries: 3 } },
      },
    },
  },
})
assert.equal(summarized.status, 'success')
assert.equal(summarized.answer, 'Yes.')
assert.equal(summarized.formatted_answer, 'Yes, in 2020.')
assert.equal(summarized.total_queries, 3)

const restricted = fromScopusEntry({
  eid: '2-s2.0-123',
  'dc:identifier': 'SCOPUS_ID:123',
  'dc:title': 'A Test Paper',
  'prism:doi': '10.1000/ABC.1',
})
const mergedLicence = mergePapers([openalex, restricted])
assert.equal(mergedLicence[0].licence, null, 'a restricted source must not mark an open merged record restricted')

const merged = mergePapers([openalex, crossref, semantic])
assert.equal(merged.length, 1, 'DOI duplicates must collapse')
assert.deepEqual(merged[0].sources.sort(), ['crossref', 'openalex', 's2'])
assert.equal(merged[0].citation_count, 20, 'highest citation count wins')
assert.equal(merged[0].authors.length, 2, 'longest author list wins')
assert.equal(merged[0].abstract, 'A longer abstract', 'longest abstract wins')

const otherPaper = fromOpenAlexWork({
  id: 'https://openalex.org/W999',
  doi: 'https://doi.org/10.1000/other',
  title: 'Other Paper',
  publication_year: 2024,
  authorships: [],
  cited_by_count: 1,
  type: 'article',
})
const ranked = mergeRanked([
  { source: 'openalex', results: [openalex, otherPaper] },
  { source: 's2', results: [semantic] },
  { source: 'crossref', results: [crossref] },
])
assert.equal(ranked.length, 2)
assert.equal(ranked[0].doi, '10.1000/abc.1')
assert.ok(ranked[0].rrf_score > ranked[1].rrf_score, 'a paper found in three sources should rank first')
assert.deepEqual(ranked[0].sources.sort(), ['crossref', 'openalex', 's2'])

const titleOnly = mergePapers([
  { source: 'a', sources: ['a'], title: 'Same Title', year: 2020, authors: [], fields: [], snippets: [] },
  { source: 'b', sources: ['b'], title: 'Same  title!', year: 2020, authors: [], fields: [], snippets: [] },
])
assert.equal(titleOnly.length, 1, 'title+year fallback must collapse')
assert.deepEqual(titleOnly[0].sources, ['a', 'b'])

const noYear = mergePapers([
  { source: 'a', sources: ['a'], title: 'Same Title', year: null, authors: [], fields: [], snippets: [] },
  { source: 'b', sources: ['b'], title: 'Same Title', year: null, authors: [], fields: [], snippets: [] },
])
assert.equal(noYear.length, 2, 'a missing year must not merge title-only records')

const markdown = renderPapers(merged, { abstractChars: 20 })
assert.match(markdown, /A Test Paper/)
assert.match(markdown, /doi: 10\.1000\/abc\.1/)
assert.match(markdown, /20 citations/)

const journalFirst = fromOpenAlexWork({
  id: 'https://openalex.org/W777',
  doi: 'https://doi.org/10.1000/journal-merge',
  title: 'Journal Merge',
  publication_year: 2024,
  authorships: [],
  primary_location: { source: { display_name: 'Journal One', issn_l: '1234-5678', issn: ['1234-5678'], host_organization_name: 'Publisher One', is_oa: true } },
})
journalFirst.bibtex = '@article{journalmerge, title={Journal Merge}}'
journalFirst.journal.metrics = { h_index: 10 }
const journalSecond = fromCrossrefWork({
  DOI: '10.1000/journal-merge',
  title: ['Journal Merge'],
  ISSN: ['1234-5678'],
  publisher: 'Publisher Two',
  volume: '12',
  issue: '3',
  page: '1-9',
  'references-count': 42,
})
const journalMerged = mergePapers([journalFirst, journalSecond])
assert.equal(journalMerged.length, 1)
assert.equal(journalMerged[0].journal.name, 'Journal One')
assert.equal(journalMerged[0].journal.metrics.h_index, 10)
assert.equal(journalMerged[0].volume, '12')
assert.equal(journalMerged[0].reference_count, 42)
assert.equal(journalMerged[0].bibtex, journalFirst.bibtex)

const pmcidSecond = fromSemanticScholarPaper({
  paperId: 'abc123',
  externalIds: { DOI: '10.1000/abc.1', PubMedCentral: 'PMC11223843' },
  title: 'A Test Paper',
})
const noPmcid = fromOpenAlexWork({
  id: 'https://openalex.org/W778',
  doi: 'https://doi.org/10.1000/abc.1',
  title: 'A Test Paper',
  publication_year: 2024,
  authorships: [],
})
const pmcidMerged = mergePapers([noPmcid, pmcidSecond])
assert.equal(pmcidMerged[0].pmcid, 'PMC11223843')

console.log('Search normalization OK')
