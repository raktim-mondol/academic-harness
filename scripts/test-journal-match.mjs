import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resetLimitersForTests } from '../search-http.js'
import { runJournalSearch } from '../journal-search.js'
import { apply } from '../citation.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const originalFetch = globalThis.fetch
const calls = []
const strong = {
  id: 'https://openalex.org/S1',
  display_name: 'Journal of Widget Science',
  issn_l: '1234-5678',
  issn: ['1234-5678'],
  host_organization_name: 'Widget Press',
  is_oa: true,
  is_in_doaj: true,
  apc_usd: 1500,
  homepage_url: 'https://journal.example',
  summary_stats: { '2yr_mean_citedness': 3.5, h_index: 40, i10_index: 100 },
  works_count: 1000,
  cited_by_count: 20000,
  topics: [{ display_name: 'Widgets' }, { display_name: 'Materials Science' }],
  type: 'journal',
  country_code: 'US',
  counts_by_year: [],
}
const closed = {
  ...strong,
  id: 'https://openalex.org/S2',
  display_name: 'Closed Widget Letters',
  issn_l: '8765-4321',
  issn: ['8765-4321'],
  host_organization_name: 'Other Press',
  is_oa: false,
  is_in_doaj: false,
  apc_usd: 5000,
  homepage_url: 'https://closed.example',
  topics: [{ display_name: 'Widgets' }],
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function installJournalFetch() {
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    if (String(url).includes('api.openalex.org/sources')) return jsonResponse({ results: [strong, closed] })
    if (String(url).includes('doaj.org')) return jsonResponse({ results: [] })
    if (String(url).includes('crossref.org')) return jsonResponse({ message: { items: [] } })
    throw new Error(`unexpected URL: ${url}`)
  }
}

const workspace = makeWorkspace('ah-journal-match-')
const exec = fakeExec(workspace.cwd)
let citationTool
apply({ tools: { register: (registered) => { citationTool = registered } } })

try {
  resetLimitersForTests()
  await installJournalFetch()
  let result = await runJournalSearch({
    action: 'match',
    title: 'Stronger widgets for health',
    keywords: ['widgets', 'materials'],
    abstract: 'We study widget strength in a materials context.',
    article_type: 'research article',
    constraints: { oa: true, max_apc_usd: 2000, indexation: ['doaj'] },
    providers: ['openalex', 'doaj', 'crossref'],
    include_keyed_metrics: false,
  }, exec)
  assert.equal(result.action, 'match')
  assert.equal(result.query_source, 'keywords')
  assert.equal(result.journals.length, 1, 'the closed/expensive venue must be filtered')
  const journal = result.journals[0]
  assert.equal(journal.title, 'Journal of Widget Science')
  assert.match(journal.fit, /scope_evidence/)
  assert.equal(journal.fit_is_advisory, true)
  assert.ok(journal.rationale.some((line) => /topic overlap/.test(line)))
  assert.ok(journal.rationale.some((line) => /2-year mean citedness/.test(line)))
  assert.ok(journal.venue_signals.manual_check)
  assert.ok(journal.venue_signals.signals.some((signal) => signal.id === 'doaj_listing' && signal.status === 'listed'))
  assert.ok(journal.signal_summary.some((line) => line.startsWith('publisher_membership:')))
  assert.match(result.notes.join(' '), /advisory/i)

  result = await runJournalSearch({
    action: 'match',
    title: 'Widgets',
    keywords: ['widgets'],
    constraints: { indexation: ['scopus'] },
    providers: ['openalex'],
    include_keyed_metrics: false,
  }, exec)
  assert.equal(result.journals.length, 2, 'unknown indexation must not exclude venues')
  assert.ok(result.journals.every((entry) => entry.missing.some((item) => /indexation unknown/.test(item))))

  result = await runJournalSearch({ action: 'match' }, exec)
  assert.match(result.error, /match needs title/)

  // Custom CSL: a workspace file and a cached URL both format.
  const IEEE = fileURLToPath(new URL('../styles/ieee.csl', import.meta.url))
  workspace.write('styles/ieee.csl', readFileSync(IEEE, 'utf8'))
  const records = [{
    id: 'x', type: 'article-journal', title: 'A title',
    author: [{ family: 'Lovelace', given: 'Ada' }],
    issued: { 'date-parts': [[2024]] },
    'container-title': 'Journal of Tests', volume: '1', issue: '2', page: '1-9', DOI: '10.1000/x',
  }]
  result = await citationTool.execute({ action: 'format', records, style_file: 'styles/ieee.csl' }, exec)
  assert.equal(result.error, undefined, result.error)
  assert.match(result.style, /^custom-/)
  assert.match(result.bibliography, /Lovelace/)
  assert.equal(result.custom_style.cached, false)

  workspace.write('styles/bad.csl', '<style xmlns="http://purl.org/net/xbiblio/csl"><citation></citation></style>')
  result = await citationTool.execute({ action: 'format', records, style_file: 'styles/bad.csl' }, exec)
  assert.match(result.error, /version attribute/)
  result = await citationTool.execute({ action: 'format', records, style: 'apa', style_file: 'styles/ieee.csl' }, exec)
  assert.match(result.error, /not both/)
  result = await citationTool.execute({ action: 'format', records, style_url: 'http://localhost/style.csl' }, exec)
  assert.match(result.error, /local or private/)
  result = await citationTool.execute({ action: 'format', records, style_url: 'http://169.254.169.254/latest/meta-data' }, exec)
  assert.match(result.error, /local or private/)
  result = await citationTool.execute({ action: 'format', records, style_url: 'http://[::ffff:127.0.0.1]/style.csl' }, exec)
  assert.match(result.error, /local or private/)

  globalThis.fetch = async (url) => {
    if (String(url) === 'https://93.184.216.34/redirect.csl') {
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret.csl' } })
    }
    throw new Error(`unexpected URL: ${url}`)
  }
  result = await citationTool.execute({ action: 'format', records, style_url: 'https://93.184.216.34/redirect.csl' }, exec)
  assert.match(result.error, /local or private/)

  let styleFetches = 0
  globalThis.fetch = async (url) => {
    if (String(url) === 'https://93.184.216.34/custom.csl') {
      styleFetches += 1
      return new Response(readFileSync(IEEE, 'utf8'), { status: 200, headers: { 'content-type': 'application/xml' } })
    }
    throw new Error(`unexpected URL: ${url}`)
  }
  result = await citationTool.execute({ action: 'format', records, style_url: 'https://93.184.216.34/custom.csl' }, exec)
  assert.equal(result.error, undefined, result.error)
  assert.equal(result.custom_style.cached, false)
  result = await citationTool.execute({ action: 'format', records, style_url: 'https://93.184.216.34/custom.csl' }, exec)
  assert.equal(result.error, undefined, result.error)
  assert.equal(result.custom_style.cached, true)
  assert.equal(styleFetches, 1, 'the CSL style is cached under .dsh/styles/')

  console.log('journal match + custom CSL OK')
} finally {
  globalThis.fetch = originalFetch
  workspace.cleanup()
}
