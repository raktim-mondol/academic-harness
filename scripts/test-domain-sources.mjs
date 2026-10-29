import assert from 'node:assert/strict'
import { resetLimitersForTests } from '../search-http.js'
import { chooseSources } from '../literature-search.js'
import { apply as applyDomainSearch, inject as domainInject, name as domainModuleName, runDomainSearch } from '../domain-search.js'
import { runBiorxivSearch, runBiorxivDomain } from '../biorxiv-search.js'
import { runAclDomain } from '../acl-lookup.js'
import { runInspireSearch, runInspireDomain } from '../inspire-search.js'
import { runAdsSearch, runAdsDomain } from '../ads-search.js'
import { runScopusSearch, runScopusDomain } from '../scopus-search.js'
import { runWosSearch, runWosDomain } from '../wos-search.js'
import { runWikidataLookup } from '../wikidata-lookup.js'
import { resolveIdentifier } from '../paper-resolve.js'

const originalFetch = globalThis.fetch
const calls = []

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
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

process.env.UNPAYWALL_EMAIL = 'test@example.org'
process.env.ADS_API_TOKEN = 'ads-test'
process.env.SCOPUS_API_KEY = 'scopus-test'
process.env.WOS_API_KEY = 'wos-test'

/* ------------------------------------------------------------------ bioRxiv */
fresh()
install(() => jsonResponse({
  hitCount: 1,
  resultList: {
    result: [{
      id: 'PPR1',
      source: 'PPR',
      bookOrReportDetails: { publisher: 'medRxiv' },
      doi: '10.1101/2024.01.01.123456',
      title: 'A preprint',
      authorString: 'Ada Lovelace, Alan Turing',
      pubYear: '2024',
      abstractText: 'Preprint abstract',
    }],
  },
}))
{
  const value = await runBiorxivSearch({ query: 'preprint', limit: 5 }, {})
  assert.match(calls[0].url, /SRC%3APPR/)
  assert.equal(value.results[0].source, 'biorxiv')
  assert.equal(value.results[0].venue, 'medRxiv')
  assert.equal(value.results[0].doi, '10.1101/2024.01.01.123456')
}

fresh()
install(() => jsonResponse({
  messages: [{ total: 1 }],
  collection: [{
    doi: '10.1101/2024.01.01.123456',
    title: 'A preprint',
    authors: 'Ada Lovelace; Alan Turing',
    date: '2024-01-01',
    version: '2',
    category: 'microbiology',
  }],
}))
{
  const value = await runBiorxivDomain({
    action: 'browse',
    server: 'medrxiv',
    start: '2024-01-01',
    end: '2024-01-31',
    category: 'microbiology',
  }, {})
  assert.match(calls[0].url, /api\.biorxiv\.org\/details\/medrxiv\/2024-01-01\/2024-01-31\/0\?category=microbiology/)
  assert.equal(value.server, 'medrxiv')
  assert.equal(value.results[0].venue, 'medRxiv')
  assert.equal(value.results[0].authors.length, 2)
}

fresh()
install(() => jsonResponse({
  collection: [{
    doi: '10.1101/2024.01.01.123456',
    title: 'A preprint',
    authors: 'Ada Lovelace',
    date: '2024-01-01',
    version: '1',
  }],
}))
{
  const value = await runBiorxivDomain({ action: 'doi', server: 'biorxiv', doi: '10.1101/2024.01.01.123456' }, {})
  assert.match(calls[0].url, /api\.biorxiv\.org\/details\/biorxiv\/10\.1101\/2024\.01\.01\.123456/)
  assert.equal(value.results[0].title, 'A preprint')
}

/* ---------------------------------------------------------------------- ACL */
fresh()
install(() => textResponse('@inproceedings{acl,\n  title = {An ACL Paper},\n  author = {Ada Lovelace and\n            Alan Turing},\n  year = {2024}\n}'))
{
  const value = await runAclDomain({ action: 'record', id: '2024.acl-long.1' }, {})
  assert.match(calls[0].url, /aclanthology\.org\/2024\.acl-long\.1\.bib/)
  assert.equal(value.title, 'An ACL Paper')
  assert.equal(value.authors.length, 2)
  assert.equal(value.year, 2024)
  assert.equal(value.pdf_url, 'https://aclanthology.org/2024.acl-long.1.pdf')
}

/* ------------------------------------------------------------------- INSPIRE */
fresh()
install(() => jsonResponse({
  hits: {
    total: 1,
    hits: [{
      metadata: {
        control_number: 123,
        titles: [{ title: 'An INSPIRE paper' }],
        authors: [{ full_name: 'Ada Lovelace' }],
        publication_info: [{ year: 2024, journal_title: 'JHEP' }],
        dois: [{ value: '10.1000/inspire' }],
        arxiv_eprints: [{ value: '2401.12345' }],
        citation_count: 7,
        texkeys: ['Lovelace:2024aa'],
        document_type: ['article'],
        abstracts: [{ value: 'Inspire abstract' }],
        subject_terms: [{ term: 'hep-th' }],
      },
    }],
  },
}))
{
  const value = await runInspireSearch({ query: 'particle', limit: 5 }, {})
  assert.match(calls[0].url, /inspirehep\.net\/api\/literature/)
  assert.equal(value.results[0].inspire_id, '123')
  assert.equal(value.results[0].arxiv_id, '2401.12345')
  assert.equal(value.results[0].texkey, 'Lovelace:2024aa')
  assert.equal(value.results[0].citation_count, 7)
}

fresh()
install(() => jsonResponse({
  metadata: {
    control_number: 123,
    texkeys: ['Lovelace:2024aa'],
    citation_count: 7,
    dois: [{ value: '10.1000/inspire' }],
    arxiv_eprints: [{ value: '2401.12345' }],
    references: [{ reference: { title: 'Referenced paper', publication_info: [{ year: 2020 }] } }],
  },
}))
{
  const value = await runInspireDomain({ action: 'references', id: '123', limit: 5 }, {})
  assert.equal(value.total, 1)
  assert.equal(value.references[0].reference.title, 'Referenced paper')
}

fresh()
install(() => textResponse('@article{Lovelace:2024aa, title={An INSPIRE paper}}'))
{
  const value = await runInspireDomain({ action: 'bibtex', id: '123' }, {})
  assert.match(value.bibtex, /Lovelace:2024aa/)
}

/* ----------------------------------------------------------------------- ADS */
fresh()
install(() => jsonResponse({
  response: {
    numFound: 1,
    docs: [{
      bibcode: '2024ApJ...123...45L',
      title: ['An ADS paper'],
      author: ['Lovelace, A.'],
      year: '2024',
      doi: ['10.1000/ads'],
      citation_count: 11,
      pub: 'ApJ',
      abstract: 'ADS abstract',
    }],
  },
}, 200, { 'x-ratelimit-remaining': '99' }))
{
  const value = await runAdsSearch({ query: 'astro', limit: 5 }, {})
  assert.match(calls[0].url, /api\.adsabs\.harvard\.edu\/v1\/search\/query/)
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ads-test')
  assert.equal(value.results[0].bibcode, '2024ApJ...123...45L')
  assert.equal(value.quota_remaining, 99)
}

fresh()
install(() => textResponse('@article{ads, title={An ADS paper}}'))
{
  const value = await runAdsDomain({ action: 'export', bibcodes: ['2024ApJ...123...45L'] }, {})
  assert.match(calls[0].url, /export\/bibtex/)
  assert.equal(JSON.parse(calls[0].init.body).bibcode[0], '2024ApJ...123...45L')
  assert.match(value.bibtex, /An ADS paper/)
}

delete process.env.ADS_API_TOKEN
fresh()
install(() => { throw new Error('should not fetch without ADS_API_TOKEN') })
{
  const value = await runAdsSearch({ query: 'astro' }, {})
  assert.equal(value.code, 'key_missing')
  assert.equal(calls.length, 0)
}
process.env.ADS_API_TOKEN = 'ads-test'

/* -------------------------------------------------------------------- Scopus */
fresh()
install(() => jsonResponse({
  'search-results': {
    'opensearch:totalResults': '1',
    entry: [{
      eid: '2-s2.0-123',
      'dc:identifier': 'SCOPUS_ID:123',
      'dc:title': 'A Scopus paper',
      'dc:creator': 'Lovelace A.',
      'prism:publicationName': 'Journal',
      'prism:coverDate': '2024-01-01',
      'citedby-count': '4',
      'prism:doi': '10.1000/scopus',
      subtypeDescription: 'Article',
    }],
  },
}, 200, { 'x-ratelimit-remaining': '42' }))
{
  const value = await runScopusSearch({ query: 'medicine', limit: 5 }, {})
  assert.match(calls[0].url, /api\.elsevier\.com\/content\/search\/scopus/)
  assert.equal(calls[0].init.headers['X-ELS-APIKey'], 'scopus-test')
  assert.equal(value.results[0].licence, 'restricted')
  assert.equal(value.results[0].scopus_id, '2-s2.0-123')
  assert.equal(value.quota_remaining, 42)
}

fresh()
install(() => jsonResponse({ error: 'not entitled' }, 403))
{
  const value = await runScopusSearch({ query: 'medicine' }, {})
  assert.equal(value.code, 'not_entitled')
  assert.match(value.error, /institutional VPN/)
}

fresh()
install(() => jsonResponse({ error: 'quota' }, 429, { 'retry-after': '0' }))
{
  const value = await runScopusSearch({ query: 'medicine' }, {})
  assert.equal(value.code, 'quota')
}

delete process.env.SCOPUS_API_KEY
fresh()
install(() => { throw new Error('should not fetch without SCOPUS_API_KEY') })
{
  const value = await runScopusDomain({ action: 'record', id: '2-s2.0-123' }, {})
  assert.equal(value.code, 'key_missing')
  assert.equal(calls.length, 0)
}
process.env.SCOPUS_API_KEY = 'scopus-test'

/* ------------------------------------------------------------------------ WoS */
fresh()
install(() => jsonResponse({
  metadata: { total: 1 },
  hits: [{
    uid: 'WOS:000123',
    title: 'A WoS paper',
    names: { authors: [{ displayName: 'Lovelace, A.' }] },
    publicationInfo: { pubYear: '2024', sourceTitle: 'Journal' },
    identifiers: { doi: '10.1000/wos' },
    citations: [{ count: 3 }],
  }],
}, 200, { 'x-ratelimit-remaining': '7' }))
{
  const value = await runWosSearch({ query: 'TS=paper', limit: 5 }, {})
  assert.match(calls[0].url, /api\.clarivate\.com\/apis\/wos-starter\/v1\/documents/)
  assert.equal(calls[0].init.headers['X-ApiKey'], 'wos-test')
  assert.equal(value.results[0].wos_uid, 'WOS:000123')
  assert.equal(value.results[0].licence, 'restricted')
  assert.equal(value.results[0].citation_count, 3)
  assert.equal(value.quota_remaining, 7)
}

fresh()
install(() => jsonResponse({
  metadata: { total: 1 },
  hits: [{
    uid: 'WOS:000123',
    title: 'A WoS paper',
    publicationInfo: { pubYear: '2024' },
    citations: [{ count: 3 }],
  }],
}))
{
  const value = await runWosDomain({ action: 'cited_by', uid: 'WOS:000123' }, {})
  assert.equal(value.citation_count, 3)
  assert.match(value.note, /Starter API/)
}

delete process.env.WOS_API_KEY
fresh()
install(() => { throw new Error('should not fetch without WOS_API_KEY') })
{
  const value = await runWosSearch({ query: 'TS=paper' }, {})
  assert.equal(value.code, 'key_missing')
  assert.equal(calls.length, 0)
}
process.env.WOS_API_KEY = 'wos-test'

/* ------------------------------------------------------------------- Wikidata */
fresh()
install((url) => {
  if (url.includes('wbsearchentities')) {
    return jsonResponse({
      search: [
        { id: 'Q42', label: 'Ada Lovelace', description: 'mathematician' },
        { id: 'Q999', label: 'Not a person', description: 'GPU microarchitecture' },
      ],
    })
  }
  if (url.includes('wbgetentities')) {
    return jsonResponse({
      entities: {
        Q42: {
          id: 'Q42',
          labels: { en: { value: 'Ada Lovelace' } },
          descriptions: { en: { value: 'mathematician' } },
          aliases: { en: [{ value: 'Augusta Ada King' }] },
          claims: {
            P31: [{ mainsnak: { datavalue: { value: { id: 'Q5' } } } }],
            P496: [{ mainsnak: { datavalue: { value: '0000-0002-1825-0097' } } }],
          },
        },
        Q999: {
          id: 'Q999',
          labels: { en: { value: 'Not a person' } },
          descriptions: { en: { value: 'GPU microarchitecture' } },
          aliases: { en: [] },
          claims: {
            P31: [{ mainsnak: { datavalue: { value: { id: 'Q259864' } } } }],
          },
        },
      },
    })
  }
  throw new Error(`unexpected Wikidata URL ${url}`)
})
{
  const value = await runWikidataLookup({ action: 'resolve', query: 'Ada Lovelace', type: 'person' }, {})
  assert.equal(value.entities.length, 1)
  assert.equal(value.entities[0].qid, 'Q42')
  assert.equal(value.entities[0].claims.orcid, '0000-0002-1825-0097')
}

fresh()
install(() => { throw new Error('should not fetch a mismatched Wikidata type') })
{
  const value = await runWikidataLookup({ action: 'resolve', type: 'journal', orcid: '0000-0002-1825-0097' }, {})
  assert.match(value.error, /does not match/)
  assert.equal(calls.length, 0)
}

/* --------------------------------------------------------------- domain tool */
fresh()
install(() => textResponse('@inproceedings{acl, title={Dispatched ACL Paper}, year={2024}}'))
{
  const value = await runDomainSearch({ source: 'acl', action: 'record', id: '2024.acl-long.1' }, {})
  assert.equal(value.source, 'acl')
  assert.equal(value.title, 'Dispatched ACL Paper')
}

/* ------------------------------------------------------------------ routing */
assert.ok(chooseSources('particle physics collider', 'auto').includes('inspire'))
assert.ok(!chooseSources('exoplanet atmosphere', 'auto').includes('ads'))
assert.ok(chooseSources('exoplanet atmosphere', 'auto', { adsToken: true }).includes('ads'))
assert.ok(chooseSources('malaria treatment preprints', 'auto').includes('biorxiv'))
assert.deepEqual(chooseSources('anything', 'scopus'), ['scopus'])
assert.throws(() => chooseSources('x', 'unknown-source'), /unknown source/)

const registered = []
applyDomainSearch({ tools: { register: (tool) => registered.push(tool) } })
assert.equal(domainModuleName, 'academic-harness-domain-search')
assert.deepEqual(domainInject, ['tools'])
assert.equal(registered.length, 1)
assert.equal(registered[0].name, 'domain_search')

/* ----------------------------------------------------- paper_resolve bridge */
fresh()
install((url) => {
  if (url.includes('inspirehep.net')) {
    return jsonResponse({
      metadata: {
        control_number: 123,
        dois: [{ value: '10.1000/resolve' }],
        arxiv_eprints: [],
      },
    })
  }
  if (url.includes('api.openalex.org')) {
    return jsonResponse({
      id: 'https://openalex.org/W1',
      doi: 'https://doi.org/10.1000/resolve',
      title: 'Resolved Paper',
      publication_year: 2024,
      authorships: [],
      primary_location: {},
      open_access: { oa_status: 'closed' },
      cited_by_count: 0,
      type: 'article',
      topics: [],
    })
  }
  throw new Error(`unexpected resolve URL ${url}`)
})
{
  const value = await resolveIdentifier('recid:123', {})
  assert.equal(value.resolved, true)
  assert.equal(value.paper.title, 'Resolved Paper')
}

delete process.env.WOS_API_KEY
fresh()
install(() => { throw new Error('should not fetch a keyed identifier without a key') })
{
  const value = await resolveIdentifier('WOS:000123', {})
  assert.equal(value.resolved, false)
  assert.match(value.reason, /WOS_API_KEY/)
}
process.env.WOS_API_KEY = 'wos-test'

globalThis.fetch = originalFetch
delete process.env.UNPAYWALL_EMAIL
delete process.env.ADS_API_TOKEN
delete process.env.SCOPUS_API_KEY
delete process.env.WOS_API_KEY
console.log('Domain sources OK')
