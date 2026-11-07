/**
 * Routing quality gate for the Jev source router.
 *
 * Replays recorded production answers (scripts/fixtures/jev-routing.json) through
 * the real decision code and checks per-group rates against floors and ceilings,
 * so a change to a threshold, a gate, or a question's wiring fails CI with no
 * network and no key. The labels do not come from Jev: they are OpenAlex indexing
 * and field metadata, and PubMed-derived benchmark phrasing (SciFact, NFCorpus).
 *
 * This is a replay, so it cannot see the model change. To check for drift, run
 *   JEV_LIVE=1 TYPESAFE_API_KEY=... node scripts/test-jev-routing-eval.mjs
 * which re-asks Jev for a sample and compares its decisions with the recording.
 * Floors sit a little under what was measured when the fixture was recorded; they
 * guard against regressions, they are not a claim of accuracy on your queries.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { askJev, decideSources, gatingIntents, resetJevForTests, ROUTE_THRESHOLD, suggestTools } from '../jev-router.js'
import { routeSources } from '../literature-search.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/jev-routing.json', import.meta.url), 'utf8'))
const by = {}
for (const row of fixture.rows) (by[row.group] ||= []).push(row)

const routed = (row, source) => decideSources(row.p).includes(source)
const rate = (group, source) => by[group].filter((row) => routed(row, source)).length / by[group].length
const pct = (x) => `${(100 * x).toFixed(0)}%`

// [group, source, 'min'|'max', bound, what it means]
const GATES = [
  ['pubmed_pos', 'pubmed', 'min', 0.9, 'PubMed-derived benchmark phrasing reaches PubMed (rules: ~40%)'],
  ['pubmed_neg', 'pubmed', 'max', 0.05, 'non-biology fields do not reach PubMed'],
  ['arxiv_pos', 'arxiv', 'min', 0.9, 'arXiv-hosted papers reach arXiv (rules: ~18%)'],
  ['inspire_pos', 'inspire', 'min', 0.8, 'high-energy-physics papers reach INSPIRE (rules: ~7%)'],
  ['arxiv_neg', 'arxiv', 'max', 0.1, 'health, humanities and business topics do not reach arXiv'],
  ['bio_ask', 'biorxiv', 'min', 0.9, 'a life-science query that asks for preprints reaches bioRxiv (rules: ~49%)'],
  ['bio_plain', 'biorxiv', 'max', 0, 'a plain life-science query never adds bioRxiv'],
]
console.log(`fixture: ${fixture.rows.length} rows, model ${fixture.model}, recorded ${fixture.recorded}`)
for (const [group, source, kind, bound, meaning] of GATES) {
  const value = rate(group, source)
  const ok = kind === 'min' ? value >= bound : value <= bound
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${group.padEnd(11)} -> ${source.padEnd(8)} ${pct(value).padStart(4)} (${kind} ${pct(bound)})  ${meaning}`)
  assert.ok(ok, `${group} -> ${source} is ${pct(value)}, needs ${kind} ${pct(bound)}: ${meaning}`)
}

// New intents. claim_pos is SciFact (objective); web_* and retraction_* are
// hand-labelled by the author, so treat those as smoke tests, not measurements.
const intentRate = (group, name) => by[group].filter((row) => (row.p[`intent::${name}`] ?? 0) >= ROUTE_THRESHOLD).length / by[group].length
const INTENT_GATES = [
  ['claim_pos', 'claim_check', 'min', 0.9, 'SciFact claims are recognised as claims to check'],
  ['web_pos', 'not_scholarly', 'min', 0.9, 'news, prices, products and regulation are recognised as non-scholarly (hand-labelled)'],
  ['web_neg', 'not_scholarly', 'max', 0.05, 'scholarly topics are not sent to web search (hand-labelled)'],
  ['retraction_pos', 'retraction', 'min', 0.8, 'real retraction asks are recognised (hand-labelled)'],
  ['retraction_neg', 'retraction', 'max', 0, 'questions about retractions in general are not (hand-labelled)'],
]
for (const [group, name, kind, bound, meaning] of INTENT_GATES) {
  const value = intentRate(group, name)
  const ok = kind === 'min' ? value >= bound : value <= bound
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${group.padEnd(14)} -> ${name.padEnd(13)} ${pct(value).padStart(4)} (${kind} ${pct(bound)})  ${meaning}`)
  assert.ok(ok, `${group} -> ${name} is ${pct(value)}, needs ${kind} ${pct(bound)}: ${meaning}`)
}
// Hierarchy gate (0.9): non-paper asks skip domain sources, natural topic queries do not.
{
  const asks = [...by.intent_pos.filter((row) => !['study_design'].includes(row.intent)), ...by.web_pos, ...by.retraction_pos]
  const caught = asks.filter((row) => gatingIntents(row.p).length)
  const natural = [...by.pubmed_pos, ...by.intent_neg, ...by.web_neg, ...by.retraction_neg]
  const wrong = natural.filter((row) => gatingIntents(row.p).length)
  console.log(`${caught.length / asks.length >= 0.8 ? 'ok  ' : 'FAIL'} gate        ${caught.length}/${asks.length} non-paper asks switch to hint mode (min 80%)`)
  assert.ok(caught.length / asks.length >= 0.8, 'the gate must catch most non-paper asks')
  console.log(`${wrong.length / natural.length <= 0.03 ? 'ok  ' : 'FAIL'} gate        ${wrong.length}/${natural.length} natural topic queries wrongly switched (max 3%): ${wrong.map((r) => r.query).join('; ')}`)
  assert.ok(wrong.length / natural.length <= 0.03, 'the gate must almost never fire on topic queries')
  // an ordinary topic query keeps every source it had
  for (const row of by.pubmed_neg.slice(0, 5)) assert.equal(gatingIntents({ ...row.p, 'intent::specific_paper': 0 }).length, 0)
}
// each new intent lands on a usable tool
assert.deepEqual(suggestTools({ 'intent::not_scholarly': 0.95 }, () => false).map((x) => x.tool), ['web_search'])
assert.deepEqual(suggestTools({ 'intent::retraction': 0.95 }, () => false).map((x) => x.tool), ['integrity_check'])

// Intent hints: every probe finds its tool; ordinary topic queries stay quiet.
const intentTool = { clinical_trials: 'clinicaltrials', datasets: 'dataset_search', patents: 'patent_search', grants: 'grant_search', venues: 'journal_search', study_design: 'consensus_search', specific_paper: 'paper_get' }
let hit = 0
for (const row of by.intent_pos) {
  const tools = suggestTools(row.p).map((s) => s.tool)
  if (tools.includes(intentTool[row.intent])) hit += 1
  else console.log(`  missed hint ${row.intent}: ${row.query}`)
}
console.log(`${hit >= by.intent_pos.length - 1 ? 'ok  ' : 'FAIL'} intent_pos  ${hit}/${by.intent_pos.length} probes find their tool`)
assert.ok(hit >= by.intent_pos.length - 1, 'at most one intent probe may miss')
const noisy = by.intent_neg.filter((row) => suggestTools({ ...row.p, 'intent::claim_check': 0 }).length)
console.log(`${noisy.length === 0 ? 'ok  ' : 'FAIL'} intent_neg  ${noisy.length}/${by.intent_neg.length} ordinary topic queries get a hint`)
assert.equal(noisy.length, 0, `topic queries must not get tool hints: ${noisy.map((r) => r.query).join('; ')}`)
// pubmed_pos is natural phrasing (SciFact claims, NFCorpus titles). Two intents can
// legitimately fire on headline-like text, so they are counted apart from the rest:
// claim_check (SciFact claims are meant to trigger it) and not_scholarly (three
// NFCorpus rows name an organisation or a consumer product: "National Dairy Board",
// "National Dairy Promotion Board", "The Best Baby Formula"; checked by hand).
// Every other tool hint must be absent. The other groups are literal paper titles,
// where `paper_get` is the right suggestion and a study-design word in the title can
// raise `consensus_search`, so they are deliberately not held to zero.
const quiet = { 'intent::claim_check': 0, 'intent::not_scholarly': 0 }
const stray = by.pubmed_pos.filter((row) => suggestTools({ ...row.p, ...quiet }).length)
console.log(`${stray.length === 0 ? 'ok  ' : 'FAIL'} pubmed_pos  ${stray.length}/${by.pubmed_pos.length} natural-phrasing queries get an unexpected tool hint`)
assert.equal(stray.length, 0, `natural-phrasing queries must not get tool hints: ${stray.map((r) => r.query).join('; ')}`)
const webby = by.pubmed_pos.filter((row) => (row.p['intent::not_scholarly'] ?? 0) >= ROUTE_THRESHOLD)
console.log(`${webby.length <= 4 ? 'ok  ' : 'FAIL'} pubmed_pos  ${webby.length}/${by.pubmed_pos.length} flagged not_scholarly (cap 4): ${webby.map((r) => r.query).join('; ')}`)
assert.ok(webby.length <= 4, 'too many biomedical benchmark queries flagged as non-scholarly')

// The full path, not just the decision function: a recorded answer served through
// routeSources must give the same sources.
{
  const originalKey = process.env.TYPESAFE_API_KEY
  process.env.TYPESAFE_API_KEY = 'replay-key'
  const realFetch = globalThis.fetch
  try {
    for (const row of [...by.pubmed_pos.slice(0, 4), ...by.arxiv_pos.slice(0, 4), ...by.inspire_pos.slice(0, 3), ...by.bio_ask.slice(0, 4)]) {
      resetJevForTests()
      globalThis.fetch = async (_url, init) => {
        const questions = Object.keys(JSON.parse(init.body).questions)
        const answers = Object.fromEntries(questions.map((key) => {
          const name = key.replace(/^src::/, '')
          assert.ok(name in row.p, `recorded fixture lacks question ${key}: re-record it`)
          return [key, { type: 'noul', noul: row.p[name] }]
        }))
        return new Response(JSON.stringify({ model: fixture.model, answers }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const result = await routeSources(row.query, undefined)
      assert.equal(result.routing.engine, 'jev', `replay of "${row.query}" fell back: ${result.routing.reason}`)
      assert.deepEqual(result.sources, decideSources(row.p))
    }
  } finally {
    globalThis.fetch = realFetch
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = originalKey
  }
}

// Optional drift check against the live model.
if (process.env.JEV_LIVE === '1') {
  const apiKey = process.env.TYPESAFE_API_KEY
  assert.ok(apiKey, 'JEV_LIVE=1 needs TYPESAFE_API_KEY')
  const sample = fixture.rows.filter((_, index) => index % 4 === 0)
  let agree = 0
  for (const row of sample) {
    resetJevForTests()
    const live = await askJev(row.query, { apiKey, timeoutMs: 8000 })
    assert.ok(live.ok, `live call failed: ${live.reason}`)
    if (JSON.stringify(decideSources(live.p)) === JSON.stringify(decideSources(row.p))) agree += 1
  }
  const share = agree / sample.length
  console.log(`${share >= 0.95 ? 'ok  ' : 'FAIL'} live drift check: ${agree}/${sample.length} decisions unchanged (${pct(share)})`)
  assert.ok(share >= 0.95, 'live routing decisions drifted from the recording; re-record and re-evaluate')
}
console.log('jev routing eval OK')
