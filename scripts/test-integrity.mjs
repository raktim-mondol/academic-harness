/**
 * integrity_check fixtures — no network. fetchJson is injected, so each case
 * controls exactly what Crossref and OpenAlex return.
 */
import assert from 'node:assert/strict'
import { classifyIntegrity, runIntegrityCheck } from '../integrity-check.js'

const DOI = '10.1000/target'
const NOTICE = '10.1000/notice'

function crossrefWork(relation, updates = {}) {
  return { ok: true, status: 200, data: { message: { DOI, title: ['Target Paper'], relation, ...updates } } }
}
function openalexWork(extra = {}) {
  return { ok: true, status: 200, data: { id: 'https://openalex.org/W1', doi: `https://doi.org/${DOI}`, display_name: 'Target Paper', is_retracted: false, is_paratext: false, ...extra } }
}

function harness({ crossref, openalex, crossrefError, openalexError, crossrefList }) {
  return {
    resolveEnv: async () => null,
    fetchJson: async (url) => {
      if (url.startsWith('https://api.crossref.org/works?')) {
        return crossrefList || { ok: true, status: 200, data: { message: { items: [] } } }
      }
      if (url.startsWith('https://api.crossref.org/works/')) return crossrefError || crossref
      if (url.startsWith('https://api.openalex.org/works/')) return openalexError || openalex
      throw new Error(`unexpected url: ${url}`)
    },
  }
}

/* ------------------------------------------------------------ classification */

const retractionSignal = [{ source: 'crossref', type: 'retraction', relation: 'has-retraction' }]
const noError = { crossrefError: null, openalexError: null }

assert.equal(
  classifyIntegrity({ crossrefSignals: retractionSignal, openalexSignals: retractionSignal, ...noError }),
  'retracted',
)
assert.equal(
  classifyIntegrity({ crossrefSignals: retractionSignal, openalexSignals: [], ...noError }),
  'unknown',
  'one registry flagging retraction while the other is silent is a disagreement',
)
assert.equal(
  classifyIntegrity({ crossrefSignals: retractionSignal, openalexSignals: [], crossrefError: null, openalexError: 'OpenAlex API error 500' }),
  'retracted',
  'one registry down must not erase a confirmed retraction',
)
assert.equal(
  classifyIntegrity({ crossrefSignals: [], openalexSignals: [], crossrefError: 'Crossref API error 500', openalexError: null }),
  'unknown',
  'a failed lookup is never clean',
)
assert.equal(
  classifyIntegrity({ crossrefSignals: [], openalexSignals: [], ...noError }),
  'clean',
)
assert.equal(
  classifyIntegrity({
    crossrefSignals: [{ source: 'crossref', type: 'expression_of_concern', relation: 'has-editorial-expression-of-concern' }],
    openalexSignals: [],
    ...noError,
  }),
  'expression_of_concern',
)
assert.equal(
  classifyIntegrity({
    crossrefSignals: [{ source: 'crossref', type: 'correction', relation: 'has-correction' }],
    openalexSignals: [{ source: 'openalex', type: 'paratext', relation: 'is_paratext' }],
    ...noError,
  }),
  'corrected',
)

/* -------------------------------------------------------------------- verdicts */

const retracted = await runIntegrityCheck(
  { doi: DOI },
  {},
  harness({
    crossref: crossrefWork({ 'has-retraction': [{ DOI: NOTICE, type: 'retraction' }] }),
    openalex: openalexWork({ is_retracted: true }),
  }),
)
assert.equal(retracted.verdict, 'retracted')
assert.equal(retracted.doi, DOI)
assert.equal(retracted.title, 'Target Paper')
assert.ok(retracted.checked_at, 'every verdict needs a timestamp')
assert.equal(retracted.signals.find((s) => s.source === 'crossref').notice_doi, NOTICE)
assert.ok(retracted.links.some((link) => link.url === `https://doi.org/${NOTICE}`))
assert.equal(retracted.pubpeer_url, `https://pubpeer.com/publications/${DOI}`, 'PubPeer is a URL, never a scrape')

const concern = await runIntegrityCheck(
  { doi: DOI },
  {},
  harness({
    crossref: crossrefWork({ 'has-editorial-expression-of-concern': [{ DOI: NOTICE }] }),
    openalex: openalexWork(),
  }),
)
assert.equal(concern.verdict, 'expression_of_concern')

const corrected = await runIntegrityCheck(
  { doi: DOI },
  {},
  harness({
    crossref: crossrefWork({}, { 'updated-by': [{ DOI: NOTICE, Label: 'Correction' }] }),
    openalex: openalexWork(),
  }),
)
assert.equal(corrected.verdict, 'corrected')
assert.equal(corrected.signals[0].relation, 'updated-by')

const clean = await runIntegrityCheck(
  { doi: DOI },
  {},
  harness({ crossref: crossrefWork({}), openalex: openalexWork() }),
)
assert.equal(clean.verdict, 'clean')
assert.deepEqual(clean.unavailable, [])

const conflict = await runIntegrityCheck(
  { doi: DOI },
  {},
  harness({ crossref: crossrefWork({}), openalex: openalexWork({ is_retracted: true }) }),
)
assert.equal(conflict.verdict, 'unknown')
assert.equal(conflict.signals.length, 1, 'both signals are still reported')

const brokenCrossref = await runIntegrityCheck(
  { doi: DOI },
  {},
  harness({
    crossrefError: { ok: false, status: 500, error: 'HTTP 500', detail: 'server error' },
    openalex: openalexWork(),
  }),
)
assert.equal(brokenCrossref.verdict, 'unknown', 'a broken registry must not read as clean')
assert.match(brokenCrossref.unavailable.join(' '), /crossref: Crossref API error 500/)

const missing = await runIntegrityCheck(
  { doi: DOI },
  {},
  harness({
    crossrefError: { ok: false, status: 404, error: 'HTTP 404' },
    openalexError: { ok: false, status: 404, error: 'HTTP 404' },
  }),
)
assert.equal(missing.verdict, 'not_found')

/* ------------------------------------------------------- notices and paratext */

const notice = await runIntegrityCheck(
  { doi: DOI },
  {},
  harness({
    crossref: crossrefWork({ 'is-retraction-of': [{ DOI }] }),
    openalex: openalexWork({ is_paratext: true }),
  }),
)
assert.equal(notice.verdict, 'clean', 'a retraction notice is not itself a retracted paper')
assert.equal(notice.signals.length, 1)
assert.equal(notice.signals[0].relation, 'is_paratext')

/* ---------------------------------------------------------------- by title */

const ambiguous = await runIntegrityCheck(
  { title: 'Target Paper and Friends' },
  {},
  harness({
    crossref: crossrefWork({}),
    openalex: openalexWork(),
    crossrefList: {
      ok: true,
      status: 200,
      data: {
        message: {
          items: [
            { DOI, title: ['Target Paper'], issued: { 'date-parts': [[2019]] } },
            { DOI: '10.1000/other', title: ['Another Target Paper'], issued: { 'date-parts': [[2021]] } },
          ],
        },
      },
    },
  }),
)
assert.equal(ambiguous.verdict, 'ambiguous')
assert.equal(ambiguous.candidates.length, 2, 'fuzzy title matches are never auto-picked')

const titled = await runIntegrityCheck(
  { title: 'target  paper' },
  {},
  harness({
    crossref: crossrefWork({ 'has-retraction': [{ DOI: NOTICE }] }),
    openalex: openalexWork({ is_retracted: true }),
    crossrefList: {
      ok: true,
      status: 200,
      data: { message: { items: [{ DOI, title: ['Target Paper'] }, { DOI: '10.1000/other', title: ['Target Paper of Another Kind'] }] } },
    },
  }),
)
assert.equal(titled.verdict, 'retracted', 'a verbatim title match resolves to one DOI')
assert.equal(titled.doi, DOI)

assert.equal((await runIntegrityCheck({}, {}, harness({ crossref: crossrefWork({}), openalex: openalexWork() }))).error, 'give a doi or a title')

console.log('integrity OK')
