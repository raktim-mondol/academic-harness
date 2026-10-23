/**
 * Registry fixtures for clinicaltrials + openfda — no network.
 */
import assert from 'node:assert/strict'
import { runClinicalTrials } from '../clinicaltrials.js'
import { runOpenFda } from '../openfda.js'
import { runDatasetSearch } from '../dataset-search.js'
import { runJournalPolicy } from '../journal-policy.js'

const trial = (overrides = {}) => ({
  protocolSection: {
    identificationModule: { nctId: 'NCT12345678', briefTitle: 'Semaglutide in Type 2 Diabetes', acronym: 'SUSTAIN-X' },
    statusModule: { overallStatus: 'COMPLETED', startDateStruct: { date: '2020-01' }, completionDateStruct: { date: '2022-06' } },
    sponsorCollaboratorsModule: { leadSponsor: { name: 'Example University' } },
    conditionsModule: { conditions: ['Diabetes Mellitus, Type 2'] },
    designModule: { studyType: 'INTERVENTIONAL', phases: ['PHASE3'], enrollmentInfo: { count: 1200, type: 'ACTUAL' } },
    armsInterventionsModule: { interventions: [{ type: 'DRUG', name: 'Semaglutide' }] },
    outcomesModule: {
      primaryOutcomes: [{ measure: 'Change in HbA1c', timeFrame: 'Week 26' }],
      secondaryOutcomes: [{ measure: 'Weight change' }],
    },
    contactsLocationsModule: { locations: [{ facility: 'Site A', city: 'Boston', state: 'MA', country: 'United States' }] },
  },
  hasResults: true,
  resultsSection: {
    outcomeMeasuresModule: {
      outcomeMeasures: [{ type: 'PRIMARY', title: 'Change in HbA1c', unitOfMeasure: 'percentage', timeFrame: 'Week 26', reportingStatus: 'POSTED' }],
    },
    adverseEventsModule: {
      frequencyThreshold: '5%',
      eventGroups: [{ title: 'Semaglutide' }, { title: 'Placebo' }],
      seriousEvents: [{ term: 'Nausea' }, { term: 'Vomiting' }],
      otherEvents: [{ term: 'Headache' }],
    },
  },
  ...overrides,
})

{
  let requested
  const data = await runClinicalTrials({ action: 'search', condition: 'diabetes', intervention: 'semaglutide', phase: 'phase3', page_size: 5 }, {}, {
    fetchJson: async (url) => {
      requested = url
      return { ok: true, status: 200, data: { studies: [trial()], nextPageToken: 'TOKEN2' } }
    },
  })
  assert.match(requested, /query\.cond=diabetes/)
  assert.match(requested, /query\.intr=semaglutide/)
  assert.match(requested, /filter\.advanced=AREA%5BPhase%5D%28PHASE3%29/)
  assert.match(requested, /pageSize=5/)
  assert.equal(data.total_returned, 1)
  assert.equal(data.next_page_token, 'TOKEN2')
  const record = data.results[0]
  assert.equal(record.nct_id, 'NCT12345678')
  assert.equal(record.title, 'Semaglutide in Type 2 Diabetes')
  assert.equal(record.acronym, 'SUSTAIN-X')
  assert.deepEqual(record.phase, ['PHASE3'])
  assert.deepEqual(record.enrollment, { count: 1200, type: 'ACTUAL' })
  assert.deepEqual(record.primary_outcomes, ['Change in HbA1c (Week 26)'])
  assert.equal(record.has_results, true)
  assert.equal(record.url, 'https://clinicaltrials.gov/study/NCT12345678')
  assert.equal(record.posted_results, undefined, 'results are only fetched on get')
}

{
  const data = await runClinicalTrials({ action: 'get', nct_id: 'nct12345678', include_results: true }, {}, {
    fetchJson: async () => ({ ok: true, status: 200, data: trial() }),
  })
  assert.equal(data.nct_id, 'NCT12345678')
  assert.equal(data.posted_results.outcomes[0].title, 'Change in HbA1c')
  assert.equal(data.posted_results.adverse_events.serious_events, 2)
  assert.equal(data.posted_results.adverse_events.other_events, 1)
  assert.deepEqual(data.posted_results.adverse_events.groups, ['Semaglutide', 'Placebo'])
}

{
  const data = await runClinicalTrials({ action: 'search', query: 'nothing at all' }, {}, {
    fetchJson: async () => ({ ok: true, status: 200, data: { studies: [] } }),
  })
  assert.equal(data.total_returned, 0)
  assert.deepEqual(data.results, [])
  assert.equal(data.next_page_token, null)
}

{
  const data = await runClinicalTrials({ action: 'search', query: 'x' }, {}, {
    fetchJson: async () => ({ ok: false, status: 429, error: 'HTTP 429' }),
  })
  assert.match(data.error, /rate limited/)
}

{
  const data = await runClinicalTrials({ action: 'search', query: 'x', phase: 'PHASE9' }, {}, {
    fetchJson: async () => ({ ok: true, status: 200, data: { studies: [] } }),
  })
  assert.match(data.error, /phase must be one of/)
}

{
  const data = await runClinicalTrials({ action: 'search' }, {}, {
    fetchJson: async () => ({ ok: true, status: 200, data: { studies: [] } }),
  })
  assert.match(data.error, /give a query, condition, or intervention/)
}

{
  const data = await runClinicalTrials({ action: 'get', nct_id: 'NCT1' }, {}, {
    fetchJson: async () => ({ ok: true, status: 200, data: trial() }),
  })
  assert.match(data.error, /NCT12345678/)
}

/* ------------------------------------------------------------------ openFDA */

const event = {
  safetyreportid: '1001',
  receivedate: '20240101',
  serious: '1',
  seriousnessdeath: '2',
  patient: {
    primarysource: { reportercountry: 'US' },
    reaction: [{ reactionmeddrapt: 'Nausea' }, { reactionmeddrapt: 'Vomiting' }],
    drug: [{ medicinalproduct: 'SEMAGLUTIDE' }],
  },
}

{
  let requested
  const data = await runOpenFda({ endpoint: 'drug/event', search: 'patient.drug.medicinalproduct:"semaglutide"', limit: 400 }, {}, {
    resolveEnv: async () => null,
    fetchJson: async (url) => {
      requested = url
      return { ok: true, status: 200, data: { meta: { results: { total: 42, skip: 0, limit: 100 }, last_updated: '2026-01-01' }, results: [event] } }
    },
  })
  assert.match(requested, /limit=100$/, 'limit is capped at 100')
  assert.equal(data.total, 42)
  assert.equal(data.results[0].serious, true)
  assert.equal(data.results[0].death, false)
  assert.deepEqual(data.results[0].reactions, ['Nausea', 'Vomiting'])
  assert.deepEqual(data.results[0].drugs, ['SEMAGLUTIDE'])
  assert.match(data.source_url, /^https:\/\/api\.fda\.gov\/drug\/event\.json\?/)
}

{
  const data = await runOpenFda({ endpoint: 'drug/enforcement', search: 'classification:"Class I"' }, {}, {
    resolveEnv: async () => 'SECRET',
    fetchJson: async (url) => {
      assert.match(url, /api_key=SECRET/)
      return { ok: true, status: 200, data: { meta: { results: { total: 1 } }, results: [{ recall_number: 'D-1', classification: 'Class I', reason_for_recall: 'Contamination' }] } }
    },
  })
  assert.equal(data.results[0].id, 'D-1')
  assert.ok(!data.source_url.includes('SECRET'), 'the API key must not leak into the source URL')
  assert.ok(!data.source_url.includes('api_key'), 'the API key must not leak into the source URL')
}

{
  const data = await runOpenFda({ endpoint: 'device/510k', search: 'device_name:"pump"' }, {}, {
    resolveEnv: async () => null,
    fetchJson: async () => ({
      ok: true,
      status: 200,
      data: { meta: { results: { total: 1 } }, results: [{ k_number: 'K123456', device_name: 'Infusion Pump', decision_description: 'Substantially Equivalent' }] },
    }),
  })
  assert.equal(data.results[0].id, 'K123456')
  assert.equal(data.results[0].decision, 'Substantially Equivalent')
}

{
  const data = await runOpenFda({ endpoint: 'drug/event', search: 'nothing' }, {}, {
    resolveEnv: async () => null,
    fetchJson: async () => ({ ok: false, status: 404, error: 'HTTP 404', data: { error: { code: 'NOT_FOUND' } } }),
  })
  assert.equal(data.total, 0)
  assert.deepEqual(data.results, [])
  assert.match(data.note, /no matches/)
  assert.equal(data.error, undefined, 'no matches is an empty result, not an error')
}

{
  const data = await runOpenFda({ endpoint: 'drug/event', search: 'x' }, {}, {
    resolveEnv: async () => null,
    fetchJson: async () => ({ ok: false, status: 429, error: 'HTTP 429' }),
  })
  assert.match(data.error, /OPENFDA_API_KEY/)
}

{
  const data = await runOpenFda({ endpoint: 'drug/event', search: 'x' }, {}, {
    resolveEnv: async () => null,
    fetchJson: async () => ({ ok: false, status: 400, error: 'HTTP 400', detail: 'unrecognized term' }),
  })
  assert.match(data.error, /rejected the search expression: unrecognized term/)
}

{
  const data = await runOpenFda({ endpoint: 'drug/not-real', search: 'x' }, {}, {
    resolveEnv: async () => null,
    fetchJson: async () => {
      throw new Error('must not fetch')
    },
  })
  assert.match(data.error, /endpoint must be one of/)
}

{
  const data = await runOpenFda({ endpoint: 'drug/event' }, {}, {
    resolveEnv: async () => null,
    fetchJson: async () => {
      throw new Error('must not fetch')
    },
  })
  assert.match(data.error, /give an openFDA search expression/)
}

/* ------------------------------------------------------------- dataset_search */

const dataciteItem = {
  id: '10.5281/zenodo.123',
  attributes: {
    doi: '10.5281/zenodo.123',
    titles: [{ title: 'Mouse cortex atlas' }],
    creators: [{ name: 'Ada Lovelace' }, { givenName: 'Alan', familyName: 'Turing' }],
    publisher: 'Zenodo',
    publicationYear: 2024,
    types: { resourceTypeGeneral: 'Dataset', resourceType: 'Dataset' },
    version: '1.0',
    rightsList: [{ rightsIdentifier: 'CC-BY-4.0' }],
    url: 'https://zenodo.org/records/123',
    descriptions: [{ descriptionType: 'Abstract', description: 'A single-cell atlas.' }],
  },
}

{
  let requested
  const data = await runDatasetSearch({ action: 'search', query: 'cortex', repository: 'Zenodo', year: 2024, limit: 5 }, {}, {
    resolveEnv: async () => null,
    fetchJson: async (url) => {
      requested = url
      return { ok: true, status: 200, data: { data: [dataciteItem], meta: { total: 1 }, links: { next: 'https://api.datacite.org/dois?page%5Bcursor%5D=abc&page%5Bsize%5D=5' } } }
    },
  })
  assert.match(requested, /resource-type-id=dataset/)
  assert.match(requested, /query=cortex\+AND\+publisher%3A%22Zenodo%22/)
  assert.match(requested, /published=2024/)
  assert.equal(data.total, 1)
  assert.equal(data.next_cursor, 'abc')
  const dataset = data.results[0]
  assert.equal(dataset.doi, '10.5281/zenodo.123')
  assert.equal(dataset.title, 'Mouse cortex atlas')
  assert.deepEqual(dataset.creators, ['Ada Lovelace', 'Alan Turing'])
  assert.equal(dataset.publisher, 'Zenodo')
  assert.equal(dataset.license, 'CC-BY-4.0')
  assert.equal(dataset.resource_type, 'Dataset')
  assert.equal(dataset.url, 'https://zenodo.org/records/123')
}

{
  const data = await runDatasetSearch({ action: 'get', doi: 'https://doi.org/10.5281/zenodo.123' }, {}, {
    fetchJson: async (url) => {
      assert.match(url, /\/dois\/10\.5281\/zenodo\.123$/)
      return { ok: true, status: 200, data: { data: dataciteItem } }
    },
  })
  assert.equal(data.dataset.title, 'Mouse cortex atlas')
}

{
  const data = await runDatasetSearch({ action: 'get', doi: '10.5281/zenodo.999' }, {}, {
    fetchJson: async () => ({ ok: false, status: 404, error: 'HTTP 404' }),
  })
  assert.match(data.error, /not found in DataCite/)
}

{
  const data = await runDatasetSearch({ action: 'files', doi: '10.5281/zenodo.123' }, {}, {
    fetchJson: async (url) => {
      assert.match(url, /zenodo\.org\/api\/records\/123\/files/)
      return { ok: true, status: 200, data: { entries: [{ key: 'data.csv', size: 2048, checksum: 'md5:abc', links: { self: 'https://zenodo.org/api/records/123/files/data.csv/content' } }] } }
    },
  })
  assert.equal(data.repository, 'Zenodo')
  assert.equal(data.files[0].name, 'data.csv')
  assert.equal(data.files[0].size, 2048)
  assert.match(data.files[0].download_url, /data\.csv\/content$/)
}

{
  const data = await runDatasetSearch({ action: 'files', doi: '10.6084/m9.figshare.33560125.v2' }, {}, {
    fetchJson: async (url) => {
      assert.match(url, /figshare\.com\/v2\/articles\/33560125\/files/)
      return { ok: true, status: 200, data: [{ name: 'visit.csv', size: 1821, supplied_md5: 'md5x', download_url: 'https://ndownloader.figshare.com/files/1' }] }
    },
  })
  assert.equal(data.repository, 'Figshare')
  assert.equal(data.files[0].checksum, 'md5x')
}

{
  const data = await runDatasetSearch({ action: 'files', doi: '10.5061/dryad.abc123' }, {}, {
    fetchJson: async () => {
      throw new Error('must not fetch for unsupported repositories')
    },
  })
  assert.equal(data.files_unavailable, true)
  assert.match(data.landing_url, /doi\.org\/10\.5061\/dryad\.abc123/)
}

{
  const data = await runDatasetSearch({ action: 'files', doi: '10.5281/zenodo.404' }, {}, {
    fetchJson: async () => ({ ok: false, status: 404, error: 'HTTP 404' }),
  })
  assert.equal(data.files_unavailable, true)
  assert.match(data.reason, /not public or not found/)
}

{
  const data = await runDatasetSearch({ action: 'search' }, {}, {
    fetchJson: async () => ({ ok: true, status: 200, data: { data: [] } }),
  })
  assert.match(data.error, /give a query, repository, or year/)
}

{
  const data = await runDatasetSearch({ action: 'search', query: 'x', year: 1700 }, {}, {
    fetchJson: async () => ({ ok: true, status: 200, data: { data: [] } }),
  })
  assert.match(data.error, /four-digit year/)
}

/* ------------------------------------------------------------ journal_policy */

const doajRecord = {
  id: 'doaj123',
  bibjson: {
    title: 'PLoS ONE',
    eissn: '1932-6203',
    publisher: { name: 'Public Library of Science (PLoS)', country: 'US' },
    apc: { has_apc: true, max: [{ price: 2477, currency: 'USD' }], url: 'https://plos.org/publish/fees/' },
    license: [{ type: 'CC BY', url: 'https://creativecommons.org/licenses/by/4.0/' }],
    oa_start: 2006,
  },
}

const sherpaItem = {
  title: 'PLoS ONE',
  issns: ['1932-6203'],
  publisher: { name: 'Public Library of Science' },
  publisherPolicies: [{
    preprint: { permitted: true, embargo: { amount: 0, period: 'months' }, license: 'CC BY 4.0' },
    postprint: {
      permitted_oa: [{ license: 'CC BY 4.0', embargo: { amount: 6, period: 'months' }, location: 'Any Repository', conditions: 'Published source must be acknowledged' }],
    },
    published: { permitted: false },
  }],
}

function journalHarness({ doaj: doajData, doajStatus = 200, sherpa, sherpaStatus = 200 }) {
  return {
    resolveEnv: async (name) => (name === 'SHERPA_ROMERO_API_KEY' && sherpa ? 'KEY' : null),
    fetchJson: async (url) => {
      if (url.startsWith('https://doaj.org/api/search/journals/')) {
        if (doajStatus !== 200) return { ok: false, status: doajStatus, error: `HTTP ${doajStatus}`, detail: 'down' }
        return { ok: true, status: 200, data: doajData }
      }
      if (url.startsWith('https://v2.sherpa.ac.uk/cgi/retrieve?')) {
        assert.match(url, /api-key=KEY/)
        if (sherpaStatus !== 200) return { ok: false, status: sherpaStatus, error: `HTTP ${sherpaStatus}` }
        return { ok: true, status: 200, data: sherpa }
      }
      throw new Error(`unexpected url: ${url}`)
    },
  }
}

{
  const data = await runJournalPolicy({ issn: '1932-6203' }, {}, journalHarness({
    doaj: { total: 1, results: [doajRecord] },
  }))
  assert.equal(data.status, 'found')
  assert.equal(data.doaj.listed, true)
  assert.equal(data.doaj.apc.amounts[0].price, 2477)
  assert.deepEqual(data.doaj.licenses, ['CC BY'])
  assert.equal(data.doaj.oa_start, 2006)
  assert.equal(data.sherpa.skipped, 'key_not_set')
  assert.equal(data.journal.title, 'PLoS ONE')
  assert.equal(data.journal.publisher, 'Public Library of Science (PLoS)')
  assert.ok(!JSON.stringify(data.sources).includes('api-key'), 'the Sherpa key must never appear in sources')
}

{
  const data = await runJournalPolicy({ issn: '1932-6203' }, {}, journalHarness({
    doaj: { total: 1, results: [doajRecord] },
    sherpa: { total: 1, items: [sherpaItem] },
  }))
  assert.equal(data.status, 'found')
  const policy = data.sherpa.policies[0]
  assert.equal(policy.preprint.permitted, 'yes')
  assert.equal(policy.preprint.embargo, '0 months')
  assert.equal(policy.postprint.permitted, 'yes')
  assert.equal(policy.postprint.embargo, '6 months')
  assert.deepEqual(policy.postprint.license, ['CC BY 4.0'])
  assert.match(policy.postprint.location, /Any Repository/)
  assert.match(policy.postprint.conditions, /acknowledged/)
  assert.equal(policy.published.permitted, 'no')
}

{
  const data = await runJournalPolicy({ issn: '0000-0000' }, {}, journalHarness({
    doaj: { total: 0, results: [] },
  }))
  assert.equal(data.status, 'not_found')
  assert.equal(data.doaj.listed, false)
}

{
  const data = await runJournalPolicy({ issn: '1932-6203' }, {}, journalHarness({
    doajStatus: 500,
  }))
  assert.equal(data.status, 'unknown', 'a failed DOAJ lookup is never not_found')
  assert.match(data.doaj.error, /DOAJ API error 500/)
}

{
  const data = await runJournalPolicy({ issn: '1932-6203' }, {}, journalHarness({
    doajStatus: 500,
    sherpa: { total: 1, items: [sherpaItem] },
  }))
  assert.equal(data.status, 'found', 'Sherpa data still answers when DOAJ is down')
  assert.match(data.doaj.error, /DOAJ API error 500/)
}

{
  const data = await runJournalPolicy({ issn: '1932-6203' }, {}, journalHarness({
    doaj: { total: 1, results: [doajRecord] },
    sherpa: { total: 0, items: [] },
    sherpaStatus: 401,
  }))
  assert.equal(data.status, 'found')
  assert.match(data.sherpa.error, /check SHERPA_ROMERO_API_KEY/)
}

{
  const data = await runJournalPolicy({ title: 'Nature' }, {}, journalHarness({
    doaj: {
      total: 2,
      results: [
        { id: 'a', bibjson: { title: 'Nature-Nurture Journal', issn: '1111-1111' } },
        { id: 'b', bibjson: { title: 'Nature and Culture', issn: '2222-2222' } },
      ],
    },
  }))
  assert.equal(data.status, 'ambiguous')
  assert.equal(data.candidates.length, 2)
}

{
  const data = await runJournalPolicy({ title: 'PLoS ONE' }, {}, journalHarness({
    doaj: { total: 3, results: [doajRecord, { id: 'x', bibjson: { title: 'PLoS ONE Plus', issn: '9999-9999' } }] },
  }))
  assert.equal(data.status, 'found', 'an exact title match wins over fuzzy siblings')
  assert.equal(data.doaj.title, 'PLoS ONE')
}

{
  const data = await runJournalPolicy({ issn: 'nonsense' }, {}, journalHarness({ doaj: { total: 0, results: [] } }))
  assert.match(data.error, /issn must look like/)
}

{
  const data = await runJournalPolicy({}, {}, journalHarness({ doaj: { total: 0, results: [] } }))
  assert.match(data.error, /give an issn or a title/)
}

console.log('registries OK')