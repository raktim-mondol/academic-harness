/**
 * Phase 6 fixtures: optional-tool gating, author_lookup, openreview, preprint
 * routing, and the registry API-key headers. No network.
 */
import assert from 'node:assert/strict'
import { apply as applyAuthor, normalizeOrcidRecord, normalizeOrcidSearch, normalizeRor, runAuthorLookup } from '../author-lookup.js'
import { apply as applyOpenReview, normalizeReview, normalizeSubmission, runOpenReview } from '../openreview.js'
import { buildEuropePmcQuery, runPubMedSearch } from '../pubmed-search.js'
import { chooseSources, parseSources } from '../literature-search.js'
import { runDatasetSearch } from '../dataset-search.js'

/* ------------------------------------------------------------------ gating */

{
  delete process.env.AH_ENABLE_OPTIONAL_TOOLS
  const registered = []
  const ctx = { tools: { register: (tool) => registered.push(tool.name) } }
  applyAuthor(ctx)
  applyOpenReview(ctx)
  assert.deepEqual(registered, [], 'optional tools must not register without the flag')
}

{
  process.env.AH_ENABLE_OPTIONAL_TOOLS = '1'
  const registered = []
  const ctx = { tools: { register: (tool) => registered.push(tool.name) } }
  applyAuthor(ctx)
  applyOpenReview(ctx)
  assert.deepEqual(registered, ['author_lookup', 'openreview'])
  delete process.env.AH_ENABLE_OPTIONAL_TOOLS
}

/* --------------------------------------------------------------- ORCID / ROR */

assert.deepEqual(
  normalizeOrcidSearch({ 'orcid-id': '0000-0002-1825-0097', 'given-names': 'Josiah', 'family-names': 'Carberry', 'institution-name': ['MIT'], email: ['j@example.org'] }),
  { orcid: '0000-0002-1825-0097', name: 'Josiah Carberry', institutions: ['MIT'], emails: ['j@example.org'], url: 'https://orcid.org/0000-0002-1825-0097' },
)

const orcidRecord = {
  person: {
    path: '0000-0002-1825-0097',
    name: { 'given-names': { value: 'Ada' }, 'family-name': { value: 'Lovelace' }, 'credit-name': null },
    'other-names': { 'other-name': [{ content: 'A. Lovelace' }] },
  },
  'activities-summary': {
    works: { group: [{}, {}, {}] },
    employments: {
      'affiliation-group': [{
        summaries: [{
          'employment-summary': {
            organization: {
              name: 'University of Oxford',
              'disambiguated-organization': { 'disambiguation-source': 'ROR', 'disambiguated-organization-identifier': '052gg0110' },
            },
            'role-title': 'Professor',
            'start-date': { year: { value: '2020' } },
            'end-date': null,
          },
        }],
      }],
    },
  },
}
const normalizedRecord = normalizeOrcidRecord(orcidRecord)
assert.equal(normalizedRecord.name, 'Ada Lovelace')
assert.equal(normalizedRecord.works_count, 3)
assert.deepEqual(normalizedRecord.other_names, ['A. Lovelace'])
assert.deepEqual(normalizedRecord.employments[0], {
  name: 'University of Oxford', role: 'Professor', start: '2020', end: null, ror_id: '052gg0110',
})

{
  const data = await runAuthorLookup({ action: 'author', query: 'Ada Lovelace' }, {}, {
    resolveEnv: async () => null,
    fetchJson: async (url, options) => {
      assert.match(url, /expanded-search\/\?q=Ada%20Lovelace&rows=10/)
      assert.equal(options.headers.Authorization, undefined)
      return { ok: true, status: 200, data: { 'num-found': 1, 'expanded-result': [{ 'orcid-id': '0000-0002-1825-0097', 'given-names': 'Ada', 'family-names': 'Lovelace' }] } }
    },
  })
  assert.equal(data.total, 1)
  assert.equal(data.authors[0].name, 'Ada Lovelace')
}

{
  const data = await runAuthorLookup({ action: 'author', orcid: '0000-0002-1825-0097' }, {}, {
    resolveEnv: async (name) => (name === 'ORCID_TOKEN' ? 'TOKEN' : null),
    fetchJson: async (url, options) => {
      assert.match(url, /\/0000-0002-1825-0097\/record$/)
      assert.equal(options.headers.Authorization, 'Bearer TOKEN')
      return { ok: true, status: 200, data: orcidRecord }
    },
  })
  assert.equal(data.author.works_count, 3)
  assert.equal(data.author.employments[0].ror_id, '052gg0110')
}

{
  const data = await runAuthorLookup({ action: 'author', orcid: 'nope' }, {}, {})
  assert.match(data.error, /orcid must look like/)
}

const rorItem = {
  id: 'https://ror.org/052gg0110',
  names: [
    { lang: 'en', types: ['alias'], value: 'Oxford University' },
    { lang: 'en', types: ['ror_display', 'label'], value: 'University of Oxford' },
  ],
  types: ['education', 'funder'],
  links: [{ type: 'website', value: 'https://www.ox.ac.uk' }],
  locations: [{ geonames_details: { country_name: 'United Kingdom', name: 'Oxford' } }],
}
const normalizedRor = normalizeRor(rorItem)
assert.equal(normalizedRor.ror_id, '052gg0110')
assert.equal(normalizedRor.name, 'University of Oxford')
assert.deepEqual(normalizedRor.aliases, ['Oxford University'])
assert.equal(normalizedRor.country, 'United Kingdom')
assert.equal(normalizedRor.website, 'https://www.ox.ac.uk')

{
  const data = await runAuthorLookup({ action: 'institution', query: 'University of Oxford', limit: 2 }, {}, {
    fetchJson: async (url) => {
      assert.match(url, /ror\.org\/v2\/organizations\?query=University%20of%20Oxford/)
      return { ok: true, status: 200, data: { number_of_results: 1, items: [rorItem] } }
    },
  })
  assert.equal(data.total, 1)
  assert.equal(data.institutions[0].name, 'University of Oxford')
}

{
  const data = await runAuthorLookup({ action: 'institution', ror_id: 'https://ror.org/052gg0110' }, {}, {
    fetchJson: async (url) => {
      assert.match(url, /organizations\/052gg0110$/)
      return { ok: true, status: 200, data: rorItem }
    },
  })
  assert.equal(data.institution.ror_id, '052gg0110')
}

/* ---------------------------------------------------------------- OpenReview */

const orSubmission = {
  id: 'f1',
  forum: 'f1',
  invitations: ['ICLR.cc/2025/Conference/-/Submission'],
  content: {
    title: { value: 'A Diffusion Study' },
    authors: { value: ['Ada Lovelace', 'Alan Turing'] },
    venue: { value: 'ICLR 2025 Poster' },
    venueid: { value: 'ICLR.cc/2025/Conference' },
    pdf: { value: '/pdf/f1.pdf' },
  },
}
const normalizedSubmission = normalizeSubmission(orSubmission)
assert.equal(normalizedSubmission.forum_id, 'f1')
assert.equal(normalizedSubmission.title, 'A Diffusion Study')
assert.deepEqual(normalizedSubmission.authors, ['Ada Lovelace', 'Alan Turing'])
assert.equal(normalizedSubmission.url, 'https://openreview.net/forum?id=f1')

const reviewNote = {
  id: 'n1',
  forum: 'f1',
  invitations: ['ICLR.cc/2025/Conference/Submission1/-/Official_Review'],
  content: {
    rating: { value: 6 },
    confidence: { value: 4 },
    summary: { value: 'Good' },
    strengths: { value: 'Clear' },
    weaknesses: { value: 'Thin evaluation' },
  },
}
const normalizedReview = normalizeReview(reviewNote)
assert.equal(normalizedReview.rating, 6)
assert.equal(normalizedReview.confidence, 4)
assert.equal(normalizedReview.weaknesses, 'Thin evaluation')
assert.match(normalizedReview.url, /forum\?id=f1&noteId=n1$/)

{
  let requested
  const data = await runOpenReview({ action: 'search', query: 'diffusion models', venue: 'ICLR.cc/2025/Conference', limit: 5 }, {}, {
    fetchJson: async (url) => {
      requested = url
      return { ok: true, status: 200, data: { count: 1, notes: [orSubmission] } }
    },
  })
  assert.match(requested, /notes\/search\?term=diffusion\+models/)
  assert.match(requested, /source=forum/)
  assert.match(requested, /group=ICLR\.cc%2F2025%2FConference/)
  assert.equal(data.results[0].title, 'A Diffusion Study')
}

{
  const data = await runOpenReview({ action: 'reviews', forum_id: 'f1' }, {}, {
    fetchJson: async (url) => {
      assert.match(url, /notes\?forum=f1&limit=10/)
      return {
        ok: true,
        status: 200,
        data: {
          notes: [
            { ...orSubmission, content: { ...orSubmission.content, decision: { value: 'Accept (Poster)' } } },
            reviewNote,
            { id: 'n2', forum: 'f1', invitations: ['ICLR.cc/2025/Conference/Submission1/-/Official_Comment'], content: { comment: { value: 'Thanks' } } },
          ],
        },
      }
    },
  })
  assert.equal(data.decision, 'Accept (Poster)')
  assert.equal(data.reviews.length, 1)
  assert.equal(data.submission.title, 'A Diffusion Study')
}

{
  const data = await runOpenReview({ action: 'reviews', forum_id: 'f1' }, {}, {
    fetchJson: async () => ({ ok: false, status: 403, error: 'HTTP 403' }),
  })
  assert.match(data.error, /browser verification/)
  assert.match(data.error, /forum\?id=f1/)
}

{
  const data = await runOpenReview({ action: 'venue', venue_id: 'ICLR.cc/2025/Conference' }, {}, {
    fetchJson: async () => ({
      ok: true,
      status: 200,
      data: { groups: [{ id: 'ICLR.cc/2025/Conference', content: { submission_name: { value: 'Submission' }, submission_venue_id: { value: 'ICLR.cc/2025/Conference/Submission' } } }] },
    }),
  })
  assert.equal(data.submission_name, 'Submission')
  assert.equal(data.url, 'https://openreview.net/group?id=ICLR.cc%2F2025%2FConference')
}

/* ---------------------------------------------------------- preprint routing */

assert.deepEqual(
  chooseSources('semaglutide obesity clinical trial preprints'),
  ['openalex', 's2', 'pubmed', 'arxiv', 'preprints'],
)
assert.ok(!chooseSources('diffusion models preprints').includes('preprints'), 'preprints auto-route is biomedical-only')
assert.deepEqual(parseSources('openalex,preprints'), ['openalex', 'preprints'])
assert.equal(buildEuropePmcQuery('GLP-1 obesity', true), '(GLP-1 obesity) AND SRC:PPR')
assert.equal(buildEuropePmcQuery('GLP-1 obesity AND SRC:PPR', true), 'GLP-1 obesity AND SRC:PPR', 'no double SRC restriction')
assert.equal(buildEuropePmcQuery('GLP-1 obesity', false), 'GLP-1 obesity')

{
  const data = await runPubMedSearch({ query: 'x', source: 'ncbi', preprints: true }, { signal: null })
  assert.match(data.error, /Europe PMC only/)
}

/* ------------------------------------------------------- registry key headers */

function keyDeps(keys, onRequest) {
  return {
    resolveEnv: async (name) => keys[name] || null,
    fetchJson: async (url, options) => {
      onRequest?.(url, options)
      if (url.includes('api.datacite.org')) return { ok: true, status: 200, data: { data: [], meta: { total: 0 }, links: {} } }
      if (url.includes('zenodo.org')) return { ok: true, status: 200, data: { entries: [] } }
      if (url.includes('figshare.com')) return { ok: true, status: 200, data: [] }
      throw new Error(`unexpected url: ${url}`)
    },
  }
}

{
  let headers
  await runDatasetSearch({ action: 'search', query: 'x' }, {}, keyDeps({ DATACITE_API_KEY: 'DK' }, (_url, options) => { headers = options.headers }))
  assert.equal(headers.Authorization, 'Bearer DK')
}

{
  let headers
  await runDatasetSearch({ action: 'files', doi: '10.5281/zenodo.1' }, {}, keyDeps({ ZENODO_API_KEY: 'ZK' }, (_url, options) => { headers = options.headers }))
  assert.equal(headers.Authorization, 'Bearer ZK')
}

{
  let headers
  await runDatasetSearch({ action: 'files', doi: '10.6084/m9.figshare.123.v1' }, {}, keyDeps({ FIGSHARE_API_KEY: 'FK' }, (_url, options) => { headers = options.headers }))
  assert.equal(headers.Authorization, 'token FK')
}

{
  let headers
  await runDatasetSearch({ action: 'search', query: 'x' }, {}, keyDeps({}, (_url, options) => { headers = options.headers }))
  assert.equal(headers.Authorization, undefined, 'keyless requests carry no Authorization header')
}

console.log('optional tools OK')
