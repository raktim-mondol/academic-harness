/**
 * Phase 8 fixtures: optional gating, grant normalization for NIH/NSF/
 * Grants.gov, and PatentsView query/normalization. No network.
 */
import assert from 'node:assert/strict'
import { apply as applyGrant, normalizeGrantsGov, normalizeNsf, runGrantSearch } from '../grant-search.js'
import { apply as applyPatent, buildPatentQuery, normalizePatent, runPatentSearch } from '../patent-search.js'

function registered(apply) {
  const names = []
  apply({ tools: { register: (tool) => names.push(tool.name) } })
  return names
}

{
  delete process.env.AH_ENABLE_OPTIONAL_TOOLS
  assert.deepEqual(registered(applyGrant), [])
  assert.deepEqual(registered(applyPatent), [])
  process.env.AH_ENABLE_OPTIONAL_TOOLS = '1'
  assert.deepEqual(registered(applyGrant), ['grant_search'])
  assert.deepEqual(registered(applyPatent), ['patent_search'])
  delete process.env.AH_ENABLE_OPTIONAL_TOOLS
}

/* ------------------------------------------------------------------- NIH */

{
  let body
  const data = await runGrantSearch({ funder: 'nih', query: 'cancer immunotherapy', pi: 'Smith', org: 'Harvard', fiscal_year: 2024, limit: 5 }, {}, {
    fetchJson: async (url, options) => {
      assert.equal(url, 'https://api.reporter.nih.gov/v2/projects/search')
      body = JSON.parse(options.body)
      return {
        ok: true,
        status: 200,
        data: {
          meta: { total: 42 },
          results: [{
            project_num: '5R01CA000001-05',
            appl_id: 12345678,
            project_title: 'Cancer Immunotherapy',
            contact_pi_name: 'SMITH, JOHN',
            organization: { org_name: 'HARVARD UNIVERSITY' },
            award_amount: 500000,
            project_start_date: '2022-05-01T00:00:00',
            project_end_date: '2026-04-30T00:00:00',
            abstract_text: 'A long abstract.',
            agency_ic_admin: { abbreviation: 'NCI' },
          }],
        },
      }
    },
  })
  assert.deepEqual(body.criteria, {
    text_search: 'cancer immunotherapy',
    pi_names: [{ last_name: 'Smith' }],
    org_names: ['Harvard'],
    fiscal_years: [2024],
  })
  assert.equal(body.limit, 5)
  assert.equal(data.total, 42)
  assert.deepEqual(data.results[0], {
    funder: 'nih',
    award_id: '5R01CA000001-05',
    title: 'Cancer Immunotherapy',
    pi: 'SMITH, JOHN',
    organization: 'HARVARD UNIVERSITY',
    amount: 500000,
    start_date: '2022-05-01',
    end_date: '2026-04-30',
    abstract: 'A long abstract.',
    institute: 'NCI',
    url: 'https://reporter.nih.gov/project-details/12345678',
  })
}

{
  const data = await runGrantSearch({ funder: 'nih', query: 'x' }, {}, {
    fetchJson: async () => ({ ok: false, status: 503, error: 'HTTP 503', detail: 'maintenance' }),
  })
  assert.match(data.error, /NIH RePORTER API error 503: maintenance/)
}

{
  const data = await runGrantSearch({ funder: 'nih' }, {}, {
    fetchJson: async () => {
      throw new Error('must not fetch without criteria')
    },
  })
  assert.match(data.error, /give query, pi, org, or fiscal_year/)
}

/* ------------------------------------------------------------------- NSF */

{
  let requested
  const data = await runGrantSearch({ funder: 'nsf', query: 'quantum', pi: 'Turing', org: 'MIT', fiscal_year: 2024, limit: 3 }, {}, {
    fetchJson: async (url) => {
      requested = url
      return {
        ok: true,
        status: 200,
        data: {
          response: {
            award: [{
              id: '2535346',
              title: 'Quantum Test Award',
              piFirstName: 'Alan',
              piLastName: 'Turing',
              awardeeName: 'MIT',
              estimatedTotalAmt: '1749000',
              startDate: '03/15/2024',
              expDate: '02/28/2027',
              abstractText: 'Abstract.',
              fundProgramName: 'Quantum Program',
            }],
          },
        },
      }
    },
  })
  assert.match(requested, /awards\.json\?/)
  assert.match(requested, /keyword=%22quantum%22/)
  assert.match(requested, /piLastName=Turing/)
  assert.match(requested, /awardeeName=MIT/)
  assert.match(requested, /startDateStart=01%2F01%2F2024/)
  assert.match(requested, /rpp=3/)
  assert.deepEqual(data.results[0], {
    funder: 'nsf',
    award_id: '2535346',
    title: 'Quantum Test Award',
    pi: 'Alan Turing',
    organization: 'MIT',
    amount: 1749000,
    start_date: '2024-03-15',
    end_date: '2027-02-28',
    abstract: 'Abstract.',
    program: 'Quantum Program',
    url: 'https://www.nsf.gov/awardsearch/showAward?AWD_ID=2535346',
  })
}

assert.deepEqual(normalizeNsf({ id: '1', startDate: '12/15/2024' }).start_date, '2024-12-15')

/* ------------------------------------------------------------- Grants.gov */

{
  let body
  const data = await runGrantSearch({ funder: 'grantsgov', query: 'cancer', limit: 2 }, {}, {
    fetchJson: async (url, options) => {
      assert.equal(url, 'https://api.grants.gov/v1/api/search2')
      body = JSON.parse(options.body)
      return {
        ok: true,
        status: 200,
        data: {
          errorcode: 0,
          data: {
            hitCount: 128,
            oppHits: [{
              id: '359892',
              number: 'RFA-CA-27-019',
              title: 'Informatics Technologies for Cancer Research',
              agency: 'National Institutes of Health',
              openDate: '05/21/2026',
              closeDate: '10/19/2027',
              oppStatus: 'posted',
            }],
          },
        },
      }
    },
  })
  assert.deepEqual(body, { keyword: 'cancer', rows: 2, startRecordNum: 0, oppStatuses: 'forecasted|posted' })
  assert.equal(data.total, 128)
  assert.deepEqual(data.results[0], {
    funder: 'grantsgov',
    award_id: 'RFA-CA-27-019',
    title: 'Informatics Technologies for Cancer Research',
    agency: 'National Institutes of Health',
    status: 'posted',
    open_date: '2026-05-21',
    close_date: '2027-10-19',
    amount_ceiling: null,
    amount_floor: null,
    abstract: null,
    url: 'https://www.grants.gov/search-results-detail/359892',
  })
}

{
  const data = await runGrantSearch({ funder: 'grantsgov' }, {}, {
    fetchJson: async () => {
      throw new Error('must not fetch without a query')
    },
  })
  assert.match(data.error, /needs a query keyword/)
}

{
  const data = await runGrantSearch({ funder: 'grantsgov', query: 'x' }, {}, {
    fetchJson: async () => ({ ok: true, status: 200, data: { errorcode: 1, msg: 'bad request' } }),
  })
  assert.match(data.error, /Grants.gov: bad request/)
}

/* --------------------------------------------------------------- gets */

{
  const data = await runGrantSearch({ action: 'get', funder: 'nih', award_id: '5R01CA000001-05' }, {}, {
    fetchJson: async (_url, options) => {
      assert.match(options.body, /"project_nums":\["5R01CA000001-05"\]/)
      return { ok: true, status: 200, data: { results: [{ project_num: '5R01CA000001-05', project_title: 'T' }] } }
    },
  })
  assert.equal(data.award.award_id, '5R01CA000001-05')
}

{
  const data = await runGrantSearch({ action: 'get', funder: 'nsf', award_id: '2535346' }, {}, {
    fetchJson: async (url) => {
      assert.match(url, /api\.nsf\.gov\/services\/v1\/awards\/2535346\.json$/)
      return { ok: true, status: 200, data: { response: { award: [{ id: '2535346', title: 'T' }] } } }
    },
  })
  assert.equal(data.award.award_id, '2535346')
}

{
  const data = await runGrantSearch({ action: 'get', funder: 'grantsgov', award_id: '359892' }, {}, {
    fetchJson: async (_url, options) => {
      assert.match(options.body, /"opportunityId":359892/)
      return {
        ok: true,
        status: 200,
        data: {
          errorcode: 0,
          data: {
            id: 359892,
            opportunityNumber: 'RFA-CA-27-019',
            opportunityTitle: 'Informatics',
            agencyDetails: { agencyName: 'NIH' },
            synopsis: { awardCeiling: '300000', awardFloor: '50000', responseDate: 'Oct 19, 2027 12:00:00 AM EDT' },
          },
        },
      }
    },
  })
  assert.equal(data.award.award_id, 'RFA-CA-27-019')
  assert.equal(data.award.amount_ceiling, 300000)
}

assert.equal(normalizeGrantsGov(null, { id: 1, opportunityNumber: 'O-1' }).award_id, 'O-1')

{
  const data = await runGrantSearch({ funder: 'nope' }, {}, {})
  assert.match(data.error, /funder must be one of/)
}

/* --------------------------------------------------------------- patents */

{
  const data = await runPatentSearch({ query: 'widget' }, {}, {
    resolveEnv: async () => null,
    fetchJson: async () => {
      throw new Error('must not fetch without a key')
    },
  })
  assert.match(data.error, /PATENTSVIEW_API_KEY/)
}

const patentQuery = buildPatentQuery({
  query: 'widget', assignee: 'Acme', inventor: 'Turing', date_from: '2020-01-01', date_to: '2024-12-31',
})
assert.deepEqual(patentQuery._and[0], { _or: [{ _text_any: { patent_title: 'widget' } }, { _text_any: { patent_abstract: 'widget' } }] })
assert.deepEqual(patentQuery._and[1], { _text_any: { 'assignees.assignee_organization': 'Acme' } })
assert.deepEqual(patentQuery._and[3], { _gte: { patent_date: '2020-01-01' } })
assert.deepEqual(patentQuery._and[4], { _lte: { patent_date: '2024-12-31' } })
assert.throws(() => buildPatentQuery({ date_from: '01/2020' }), /YYYY-MM-DD/)

{
  let requested
  const data = await runPatentSearch({ query: 'widget', assignee: 'Acme', limit: 2, include_abstract: true }, {}, {
    resolveEnv: async (name) => (name === 'PATENTSVIEW_API_KEY' ? 'PVKEY' : null),
    fetchJson: async (url, options) => {
      requested = { url, headers: options.headers }
      return {
        ok: true,
        status: 200,
        data: {
          total_hits: 7,
          patents: [{
            patent_id: '12345678',
            patent_title: 'A Widget',
            patent_abstract: 'A widget abstract.',
            patent_date: '2021-06-01',
            patent_earliest_priority_date: '2018-06-01',
            assignees: [{ assignee_organization: 'Acme Corp' }],
            inventors: [{ inventor_name_first: 'Ada', inventor_name_last: 'Lovelace' }],
          }],
        },
      }
    },
  })
  assert.equal(requested.headers['X-Api-Key'], 'PVKEY')
  const url = new URL(requested.url)
  assert.equal(url.origin + url.pathname, 'https://search.patentsview.org/api/v1/patent/')
  const fields = JSON.parse(url.searchParams.get('f'))
  assert.ok(fields.includes('patent_abstract'))
  assert.deepEqual(JSON.parse(url.searchParams.get('q'))._and.length, 2)
  assert.equal(data.total, 7)
  assert.deepEqual(data.results[0], {
    patent_id: '12345678',
    title: 'A Widget',
    assignees: ['Acme Corp'],
    inventors: ['Ada Lovelace'],
    grant_date: '2021-06-01',
    priority_date: '2018-06-01',
    abstract: 'A widget abstract.',
    url: 'https://patents.google.com/patent/US12345678',
  })
}

assert.equal(normalizePatent({ patent_id: '1', patent_title: 'T' }).abstract, null)

{
  const data = await runPatentSearch({ query: 'widget' }, {}, {
    resolveEnv: async () => 'BAD',
    fetchJson: async () => ({ ok: false, status: 401, error: 'HTTP 401' }),
  })
  assert.match(data.error, /check PATENTSVIEW_API_KEY/)
}

{
  const data = await runPatentSearch({}, {}, {
    resolveEnv: async () => 'KEY',
    fetchJson: async () => {
      throw new Error('must not fetch without filters')
    },
  })
  assert.match(data.error, /give query, assignee, inventor/)
}

console.log('grants OK')
