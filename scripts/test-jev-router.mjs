import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  askJev, borderlineSources, buildQuestions, decideSources, gatingIntents, GATE_THRESHOLD, JEV_MODEL, JEV_URL, resetJevForTests,
  ROUTE_THRESHOLD, suggestTools, rerankWithJev, orderByRelevance, RERANK_POOL,
} from '../jev-router.js'
import { rankWithBm25, tokenize } from '../bm25-rank.js'
import { orderLocally } from '../literature-search.js'
import { rerankWithCohere, resetCohereForTests, COHERE_RERANK_URL } from '../cohere-rerank.js'
import { chooseSources, preprintTopic, routeSources } from '../literature-search.js'
import { runLiteratureWatch } from '../literature-watch.js'
import { resetLimitersForTests } from '../search-http.js'

import { readFileSync } from 'node:fs'
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
assert.ok(pkg.files.includes('jev-router.js'), 'jev-router.js is imported by literature-search.js, so it must ship')
assert.ok(pkg.files.includes('scripts'), 'the routing fixture ships with scripts/')
assert.ok(pkg.files.includes('cohere-rerank.js'), 'cohere-rerank.js is imported by literature-search.js, so it must ship')
assert.ok(pkg.files.includes('bm25-rank.js'), 'bm25-rank.js is imported by literature-search.js, so it must ship')

const realFetch = globalThis.fetch
for (const key of ['TYPESAFE_API_KEY', 'ADS_API_TOKEN', 'PATENTSVIEW_API_KEY', 'CONSENSUS_API_KEY', 'ELICIT_API_KEY']) delete process.env[key]

const calls = []
function jev(answers, { status = 200, model = JEV_MODEL } = {}) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    const body = status === 200
      ? { model, usage: { input_tokens: 900, output_tokens: 90 }, answers: Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map((k) => [k, { type: 'noul', noul: answers[k] ?? 0.01 }])) }
      : { error: 'x' }
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
}
const fresh = () => { resetJevForTests(); resetLimitersForTests(); calls.length = 0 }

/* ---------------------------------------------------------------- questions */
{
  const q = buildQuestions()
  assert.ok(q['src::pubmed'] && q['src::arxiv'] && q['src::inspire'] && q['src::life_science'] && q['src::wants_preprints'])
  assert.equal(q['src::ads'], undefined, 'ADS is asked only when a token exists')
  assert.ok(buildQuestions({ ads: true })['src::ads'])
  assert.equal(Object.keys(q).filter((k) => k.startsWith('intent::')).length, 10)
  for (const question of Object.values(q)) assert.equal(question.type, 'noul')
}

/* ---------------------------------------------------------------- decisions */
{
  assert.deepEqual(decideSources({}), ['openalex', 's2'], 'no signal: the two always-on sources only')
  assert.deepEqual(decideSources({ pubmed: 0.99 }), ['openalex', 's2', 'pubmed'])
  assert.deepEqual(decideSources({ pubmed: 0.99, arxiv: 0.97 }), ['openalex', 's2', 'pubmed', 'arxiv'])
  assert.deepEqual(decideSources({ pubmed: 0.69, arxiv: 0.7 }), ['openalex', 's2', 'arxiv'], 'threshold is >= 0.7')
  assert.equal(ROUTE_THRESHOLD, 0.7)
  // bioRxiv needs a life-science topic AND an explicit ask for preprints
  assert.ok(!decideSources({ pubmed: 0.99, life_science: 0.99, wants_preprints: 0.1 }).includes('biorxiv'))
  assert.ok(!decideSources({ pubmed: 0.99, life_science: 0.1, wants_preprints: 0.99 }).includes('biorxiv'))
  assert.ok(decideSources({ pubmed: 0.99, life_science: 0.9, wants_preprints: 0.9 }).includes('biorxiv'))
  assert.ok(decideSources({ pubmed: 0.6, life_science: 0.95, wants_preprints: 0.9 }).includes('biorxiv'), 'plant biology: life science, below PubMed threshold')
  assert.ok(!decideSources({ pubmed: 0.6, life_science: 0.95, wants_preprints: 0.9 }).includes('pubmed'))
  // ADS only with a token, even when Jev says astronomy
  assert.ok(!decideSources({ ads: 0.99 }).includes('ads'))
  assert.ok(decideSources({ ads: 0.99 }, { ads: true }).includes('ads'))
  // Jev can never pick an explicit-only or keyed source
  const everything = Object.fromEntries(['pubmed', 'arxiv', 'inspire', 'ads', 'life_science', 'wants_preprints', 'scopus', 'wos', 'crossref', 'doaj', 'springer', 'ieee', 'publishers'].map((k) => [k, 1]))
  const all = decideSources(everything, { ads: true })
  for (const banned of ['scopus', 'wos', 'crossref', 'doaj', 'springer', 'ieee', 'publishers', 'preprints']) assert.ok(!all.includes(banned), `${banned} must never be auto-routed`)
  // same order as the rules, so the two engines list sources identically
  assert.deepEqual(all, ['openalex', 's2', 'pubmed', 'arxiv', 'biorxiv', 'inspire', 'ads'])

  assert.deepEqual(borderlineSources({ pubmed: 0.5, arxiv: 0.95, inspire: 0.2 }), [{ source: 'pubmed', p: 0.5 }])

  const p = { 'intent::clinical_trials': 0.95, 'intent::patents': 0.9, 'intent::study_design': 0.8, 'intent::grants': 0.4 }
  assert.deepEqual(suggestTools(p, () => false).map((s) => s.tool), ['clinicaltrials'], 'keyed tools are not suggested without a key')
  const keyed = suggestTools(p, (name) => name === 'PATENTSVIEW_API_KEY' || name === 'ELICIT_API_KEY')
  assert.deepEqual(keyed.map((s) => s.tool), ['clinicaltrials', 'patent_search', 'elicit_search'], 'study design falls back to Elicit when Consensus is unkeyed')
  assert.equal(suggestTools(p, () => true).at(-1).tool, 'consensus_search')

  // web search: first usable key wins, and built-in web_search is always there
  const web = { 'intent::not_scholarly': 0.95 }
  assert.deepEqual(suggestTools(web, () => false).map((s) => s.tool), ['web_search'])
  assert.deepEqual(suggestTools(web, (k) => k === 'EXA_API_KEY' || k === 'BRAVE_API_KEY').map((s) => s.tool), ['exa_search'])
  assert.deepEqual(suggestTools(web, () => true).map((s) => s.tool), ['parallel_search'])
  // the generic web-search hint yields to a specific one: a funding call is not "news"
  assert.deepEqual(suggestTools({ 'intent::grants': 0.9, 'intent::not_scholarly': 0.85 }, () => false).map((s) => s.tool), ['grant_search'])
  assert.deepEqual(suggestTools({ 'intent::not_scholarly': 0.85, 'intent::claim_check': 0.9 }, () => true).map((s) => s.tool), ['parallel_search', 'mcp__scite__*'], 'claim_check is not a specific-tool intent')
  assert.deepEqual(suggestTools({ 'intent::grants': 0.6, 'intent::not_scholarly': 0.85 }, () => false).map((s) => s.tool), ['web_search'], 'a below-threshold specific intent does not suppress it')
  // claim checking: Scite, else Consensus, else nothing (the search itself is the answer)
  const claim = { 'intent::claim_check': 0.9 }
  assert.deepEqual(suggestTools(claim, () => true).map((s) => s.tool), ['mcp__scite__*'])
  assert.deepEqual(suggestTools(claim, (k) => k === 'CONSENSUS_API_KEY').map((s) => s.tool), ['consensus_search'])
  assert.deepEqual(suggestTools(claim, () => false), [])
  // retraction status goes to the native, keyless integrity check
  assert.deepEqual(suggestTools({ 'intent::retraction': 0.9 }, () => false).map((s) => s.tool), ['integrity_check'])
  // one tool suggested by two intents is listed once, with the higher probability
  const both = suggestTools({ 'intent::study_design': 0.8, 'intent::claim_check': 0.95 }, (k) => k === 'CONSENSUS_API_KEY')
  assert.deepEqual(both, [{ tool: 'consensus_search', reason: 'asks whether a claim is supported or disputed', p: 0.95 }])
  // below the threshold nothing is suggested
  assert.deepEqual(suggestTools({ 'intent::not_scholarly': 0.69, 'intent::retraction': 0.5 }), [])
}

/* ---------------------------------------------------------------- hierarchy gate */
{
  assert.equal(GATE_THRESHOLD, 0.9)
  assert.deepEqual(gatingIntents({}), [])
  assert.deepEqual(gatingIntents({ 'intent::retraction': 0.95 }), ['retraction'])
  assert.deepEqual(gatingIntents({ 'intent::retraction': 0.89 }), [], 'strictly 0.9: a 0.89 does not gate')
  // claim_check and study_design are still topic searches: they never gate
  assert.deepEqual(gatingIntents({ 'intent::claim_check': 0.99, 'intent::study_design': 0.99 }), [])
  assert.deepEqual(gatingIntents({ 'intent::not_scholarly': 0.95, 'intent::specific_paper': 0.92, 'intent::datasets': 0.5 }).sort(), ['not_scholarly', 'specific_paper'])
}

/* ---------------------------------------------------------------- transport */
{
  fresh()
  jev({ 'src::pubmed': 0.98, 'src::arxiv': 0.12, 'src::wants_preprints': 0.05 })
  const ok = await askJev('gut microbiome and depression', { apiKey: 'k-test' })
  assert.equal(ok.ok, true)
  assert.equal(ok.p.pubmed, 0.98)
  assert.equal(ok.model, JEV_MODEL)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, JEV_URL)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, 'Bearer k-test')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'jev-1.14.0', 'the model is pinned, not an alias')
  assert.deepEqual(body.state, { query: 'gut microbiome and depression' })
  assert.ok(!JSON.stringify(body).includes('k-test'), 'the key never goes in the body')

  const again = await askJev('gut microbiome and depression', { apiKey: 'k-test' })
  assert.equal(again.cached, true)
  assert.equal(calls.length, 1, 'a repeated query is served from cache')
  assert.deepEqual(await askJev('  ', { apiKey: 'k' }), { ok: false, reason: 'empty_query' })
  assert.deepEqual(await askJev('q'), { ok: false, reason: 'no_key' })

  // ADS question is only sent when asked for
  fresh(); jev({}); await askJev('q', { apiKey: 'k' })
  assert.ok(!('src::ads' in JSON.parse(calls[0].init.body).questions))
  fresh(); jev({}); await askJev('q', { apiKey: 'k', ads: true })
  assert.ok('src::ads' in JSON.parse(calls[0].init.body).questions)
}

/* ---------------------------------------------------------------- failure handling */
{
  // a rejected key: one attempt (no retry), then skipped for a while
  fresh(); jev({}, { status: 401 })
  const bad = await askJev('first', { apiKey: 'k-bad' })
  assert.deepEqual([bad.ok, bad.reason], [false, 'auth_failed'])
  assert.equal(calls.length, 1, 'no retries on the search path')
  const skipped = await askJev('second', { apiKey: 'k-bad' })
  assert.equal(skipped.reason, 'skipped_after_auth_failed')
  assert.equal(calls.length, 1, 'the breaker stops hammering a rejected key')
  jev({})
  assert.equal((await askJev('third', { apiKey: 'k-new' })).ok, true, 'a new key is tried immediately')

  // breaker expires
  fresh(); jev({}, { status: 500 })
  let clock = 1_000
  assert.equal((await askJev('q', { apiKey: 'k', now: () => clock })).reason, 'http_500')
  assert.equal((await askJev('q2', { apiKey: 'k', now: () => clock + 30_000 })).reason, 'skipped_after_http_500')
  jev({})
  assert.equal((await askJev('q3', { apiKey: 'k', now: () => clock + 61_000 })).ok, true)

  // rate limited
  fresh(); jev({}, { status: 429 })
  assert.equal((await askJev('q', { apiKey: 'k' })).reason, 'rate_limited')

  // slow: gives up at the deadline instead of stalling the search
  fresh()
  globalThis.fetch = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted'))))
  const started = Date.now()
  const slow = await askJev('q', { apiKey: 'k', timeoutMs: 40 })
  assert.deepEqual([slow.ok, slow.reason], [false, 'timeout'])
  assert.ok(Date.now() - started < 1000, 'the deadline is honoured')

  // network failure
  fresh()
  globalThis.fetch = async () => { throw new TypeError('fetch failed') }
  assert.equal((await askJev('q', { apiKey: 'k' })).reason, 'network_error')

  // malformed bodies never become routing decisions
  fresh()
  for (const bad of [{ answers: {} }, { answers: { 'src::pubmed': { type: 'noul', noul: 2 } } }, null]) {
    resetJevForTests()
    globalThis.fetch = async () => new Response(JSON.stringify(bad), { status: 200, headers: { 'content-type': 'application/json' } })
    assert.equal((await askJev('q', { apiKey: 'k' })).reason, 'malformed_response')
  }
}

/* ---------------------------------------------------------------- routeSources */
{
  fresh()
  globalThis.fetch = async () => { throw new Error('must not fetch') }
  // explicit sources win and nothing is sent anywhere
  process.env.TYPESAFE_API_KEY = 'k-test'
  const manual = await routeSources('anything', ['crossref', 's2'])
  assert.deepEqual(manual.sources, ['crossref', 's2'])
  assert.equal(manual.routing.engine, 'manual')
  await assert.rejects(routeSources('x', 'nope'), /unknown source/, 'unknown sources still throw')
  // routing=rules sends nothing even with a key
  const rules = await routeSources('malaria treatment outcomes', undefined, { mode: 'rules' })
  assert.deepEqual(rules.sources, chooseSources('malaria treatment outcomes', undefined))
  assert.deepEqual(rules.routing, { engine: 'rules', reason: 'rules_requested' })
  // no key: rules, no request
  delete process.env.TYPESAFE_API_KEY
  const nokey = await routeSources('malaria treatment outcomes', undefined)
  assert.deepEqual(nokey.sources, ['openalex', 's2', 'pubmed'])
  assert.equal(nokey.routing.reason, 'no_key')

  // keyed: Jev decides
  process.env.TYPESAFE_API_KEY = 'k-test'
  fresh(); jev({ 'src::pubmed': 0.99, 'src::arxiv': 0.96, 'src::wants_preprints': 0.2, 'intent::datasets': 0.85 })
  const routed = await routeSources('cáncer de mama y aprendizaje profundo', undefined)
  assert.deepEqual(routed.sources, ['openalex', 's2', 'pubmed', 'arxiv'])
  assert.equal(routed.routing.engine, 'jev')
  assert.equal(routed.routing.model, JEV_MODEL)
  assert.equal(routed.routing.probabilities.pubmed, 0.99)
  assert.ok(!('intent::datasets' in routed.routing.probabilities), 'intent scores are not mixed into source probabilities')
  assert.deepEqual(routed.suggested_tools.map((s) => s.tool), ['dataset_search'])

  // hierarchy: a strong non-paper intent skips the domain sources and says so
  fresh(); jev({ 'src::pubmed': 0.97, 'src::arxiv': 0.1, 'intent::retraction': 0.98, 'intent::specific_paper': 0.4 })
  const gated = await routeSources('has the Wakefield 1998 MMR paper been retracted', undefined)
  assert.deepEqual(gated.sources, ['openalex', 's2'], 'PubMed is skipped for a retraction question')
  assert.equal(gated.routing.mode, 'hint_only')
  assert.deepEqual(gated.routing.gated_by, ['retraction'])
  assert.deepEqual(gated.routing.skipped, ['pubmed'], 'the output says what was skipped')
  assert.deepEqual(gated.suggested_tools.map((s) => s.tool), ['integrity_check'])
  // the same answers with the hierarchy off (flat) keep PubMed
  fresh(); jev({ 'src::pubmed': 0.97, 'intent::retraction': 0.98 })
  const flat = await routeSources('has the Wakefield 1998 MMR paper been retracted', undefined, { hierarchy: false })
  assert.deepEqual(flat.sources, ['openalex', 's2', 'pubmed'])
  assert.equal(flat.routing.mode, undefined)
  // an intent at 0.8 still shows a hint but does not gate
  fresh(); jev({ 'src::pubmed': 0.97, 'intent::retraction': 0.8 })
  const soft = await routeSources('was this paper retracted maybe', undefined)
  assert.deepEqual(soft.sources, ['openalex', 's2', 'pubmed'])
  assert.deepEqual(soft.suggested_tools.map((s) => s.tool), ['integrity_check'])
  // an ordinary topic search is untouched
  fresh(); jev({ 'src::pubmed': 0.99, 'src::arxiv': 0.96 })
  const topic = await routeSources('transformers for protein structure prediction', undefined)
  assert.deepEqual(topic.sources, ['openalex', 's2', 'pubmed', 'arxiv'])

  // keyed but Jev down: identical to the rules, with the reason
  fresh(); jev({}, { status: 500 })
  const down = await routeSources('malaria treatment outcomes', undefined)
  assert.deepEqual(down.sources, chooseSources('malaria treatment outcomes', undefined))
  assert.equal(down.routing.engine, 'rules')
  assert.equal(down.routing.reason, 'http_500')
  assert.deepEqual(down.suggested_tools, [])
  delete process.env.TYPESAFE_API_KEY
}

/* ---------------------------------------------------------------- literature_search tool */
{
  const tools = []
  ;(await import('../literature-search.js')).apply({ tools: { register: (t) => tools.push(t) } })
  const tool = tools[0]
  assert.ok(tool.parameters.properties.routing, 'routing parameter is declared')
  assert.match(tool.description, /TYPESAFE_API_KEY/, 'the tool description tells the agent how routing works')
  assert.deepEqual(await tool.execute({ query: 'x', routing: 'nope' }, {}), { error: 'routing must be "auto" or "rules"' })

  process.env.TYPESAFE_API_KEY = 'k-test'
  fresh()
  const seen = []
  const jevAnswers = { 'src::pubmed': 0.01, 'src::arxiv': 0.01, 'intent::clinical_trials': 0.95 }
  globalThis.fetch = async (url, init) => {
    seen.push(String(url))
    if (String(url) === JEV_URL) {
      const questions = Object.keys(JSON.parse(init.body).questions)
      return new Response(JSON.stringify({ model: JEV_MODEL, answers: Object.fromEntries(questions.map((k) => [k, { type: 'noul', noul: jevAnswers[k] ?? 0.01 }])) }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (String(url).includes('openalex')) return new Response(JSON.stringify({ meta: { count: 0 }, results: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ total: 0, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const value = await tool.execute({ query: 'recruiting trials for pancreatic cancer immunotherapy' }, { signal: undefined })
  assert.deepEqual(value.sources, ['openalex', 's2'], 'a clinical-trial query is not sent to PubMed/arXiv just because it is medical')
  assert.equal(value.routing.engine, 'jev')
  assert.deepEqual(value.suggested_tools.map((s) => s.tool), ['clinicaltrials'])
  assert.ok(!seen.some((u) => u.includes('europepmc') || u.includes('arxiv.org')))
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /routing: jev jev-1\.14\.0/)
  assert.match(text, /better served by: clinicaltrials/)

  // explicit sources: no routing call at all (an empty result also leaves nothing to rerank)
  seen.length = 0
  const manual = await tool.execute({ query: 'anything', sources: ['openalex'] }, {})
  assert.equal(manual.routing.engine, 'manual')
  assert.ok(!seen.includes(JEV_URL), 'explicit sources never reach TypeSafe for routing')
  assert.doesNotMatch(tool.output.render({}, manual)[0].text, /routing:/)

  // routing=rules: no Jev call
  seen.length = 0
  const forced = await tool.execute({ query: 'anything', routing: 'rules' }, {})
  assert.equal(forced.routing.reason, 'rules_requested')
  assert.ok(!seen.includes(JEV_URL))
  delete process.env.TYPESAFE_API_KEY
}

/* ---------------------------------------------------------------- rerank */
{
  // unit: one request, one question per candidate, scores come back in input order
  process.env.TYPESAFE_API_KEY = 'k-rerank'
  fresh()
  const cands = [{ title: 'Alpha', abstract: 'about a' }, { title: 'Beta', abstract: '' }, { title: 'Gamma' }]
  let body
  globalThis.fetch = async (url, init) => {
    body = JSON.parse(init.body)
    const answers = Object.fromEntries(Object.keys(body.questions).map((k, i) => [k, { type: 'noul', noul: [0.2, 0.9, 0.5][i] }]))
    return new Response(JSON.stringify({ model: JEV_MODEL, answers }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const ok = await rerankWithJev('my query', cands, { apiKey: 'k-rerank' })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.scores, [0.2, 0.9, 0.5])
  assert.deepEqual(body.state, { query: 'my query' })
  assert.equal(Object.keys(body.questions).length, 3, 'one request carries every candidate')
  assert.match(body.questions.c0.instructions, /Document title: Alpha\nDocument abstract: about a/)
  assert.doesNotMatch(body.questions.c2.instructions, /abstract/, 'a missing abstract is not printed as empty')
  assert.deepEqual(orderByRelevance(cands, [0.5, 0.5, 0.9]).map((x) => x.paper.title), ['Gamma', 'Alpha', 'Beta'], 'ties keep fused order')
  assert.equal((await rerankWithJev('q', cands, {})).reason, 'no_key')
  assert.equal((await rerankWithJev('q', [], { apiKey: 'k' })).reason, 'nothing_to_rank')

  // malformed answers are rejected, and a failure trips only the rerank breaker, not routing
  globalThis.fetch = async (url, init) => new Response(JSON.stringify({ answers: { c0: { noul: 0.5 } } }), { status: 200, headers: { 'content-type': 'application/json' } })
  assert.equal((await rerankWithJev('q', cands, { apiKey: 'k-rerank' })).reason, 'malformed_response')
  fresh()
  globalThis.fetch = async () => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
  assert.equal((await rerankWithJev('q', cands, { apiKey: 'k-b' })).reason, 'http_500')
  assert.equal((await rerankWithJev('q', cands, { apiKey: 'k-b' })).reason, 'skipped_after_http_500')
  jev({ 'src::pubmed': 0.95 })
  assert.equal((await askJev('malaria', { apiKey: 'k-b' })).ok, true, 'a failed rerank does not switch off routing')

  // integration through the tool
  fresh()
  const tools = []
  ;(await import('../literature-search.js')).apply({ tools: { register: (t) => tools.push(t) } })
  const tool = tools[0]
  assert.deepEqual(await tool.execute({ query: 'x', rerank: 'maybe' }, {}), { error: 'rerank must be "auto", "off", "jev", "cohere" or "bm25"' })
  const works = Array.from({ length: 8 }, (_, i) => ({ id: `https://openalex.org/W${i + 1}`, doi: `https://doi.org/10.1000/x${i + 1}`, title: `Paper ${i + 1}`, publication_year: 2020 }))
  let rerankCalls = 0
  let rerankMode = 'ok'
  const install = () => {
    globalThis.fetch = async (url, init) => {
      if (String(url) === JEV_URL) {
        const questions = Object.keys(JSON.parse(init.body).questions)
        if (questions.some((k) => /^c\d+$/.test(k))) {
          rerankCalls += 1
          if (rerankMode === 'down') return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })
          // reverse the fused order: the last candidate is the most relevant
          return new Response(JSON.stringify({ model: JEV_MODEL, answers: Object.fromEntries(questions.map((k, i) => [k, { type: 'noul', noul: (i + 1) / 10 }])) }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify({ model: JEV_MODEL, answers: Object.fromEntries(questions.map((k) => [k, { type: 'noul', noul: k === 'intent::retraction' ? 0.97 : 0.01 }])) }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ meta: { count: 8 }, results: works }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
  }
  install()
  const fused = await tool.execute({ query: 'x topic', sources: ['openalex'], rerank: 'off' }, {})
  assert.equal(rerankCalls, 0, 'rerank off makes no call')
  assert.deepEqual(fused.papers.map((p) => p.title).slice(0, 2), ['Paper 1', 'Paper 2'])
  assert.equal(fused.routing.rerank, undefined)

  const reranked = await tool.execute({ query: 'x topic', sources: ['openalex'] }, {})
  assert.equal(rerankCalls, 1, 'one request reranks the whole pool')
  assert.equal(reranked.papers[0].title, 'Paper 8')
  assert.equal(reranked.papers[0].relevance, 0.8)
  assert.equal(reranked.routing.rerank.engine, 'jev')
  assert.equal(reranked.routing.rerank.candidates, 8)
  assert.match(tool.output.render({}, reranked)[0].text, /ranking: Jev relevance over the top 8/)

  // routing=rules means nothing is sent to TypeSafe
  rerankCalls = 0
  const rules = await tool.execute({ query: 'x topic', routing: 'rules' }, {})
  assert.equal(rerankCalls, 0)
  assert.equal(rules.routing.rerank, undefined)

  // hint mode (not a topic search): no rerank
  fresh(); install()
  const hint = await tool.execute({ query: 'has the Wakefield paper been retracted' }, {})
  assert.equal(hint.routing.mode, 'hint_only')
  assert.equal(rerankCalls, 0, 'a non-topic ask is not reranked by topical relevance')

  // Jev down: the fused order stands and says why
  fresh(); install(); rerankMode = 'down'
  const down = await tool.execute({ query: 'x topic', sources: ['openalex'] }, {})
  assert.equal(down.papers[0].title, 'Paper 1')
  assert.equal(down.routing.rerank.engine, 'rrf')
  assert.equal(down.routing.rerank.reason, 'http_503')
  assert.match(tool.output.render({}, down)[0].text, /fused source ranking \(rerank skipped: http_503\)/)

  // too few candidates: nothing to reorder
  fresh(); install(); rerankMode = 'ok'
  works.length = 3
  rerankCalls = 0
  await tool.execute({ query: 'x topic', sources: ['openalex'] }, {})
  assert.equal(rerankCalls, 0)
  assert.equal(RERANK_POOL, 30)
  delete process.env.TYPESAFE_API_KEY
}

/* ---------------------------------------------------------------- cohere rerank + engine choice */
{
  delete process.env.TYPESAFE_API_KEY
  delete process.env.COHERE_API_KEY
  resetCohereForTests()
  const cands = [{ title: 'Alpha', abstract: 'about a' }, { title: 'Beta' }, { title: 'Gamma', abstract: 'g' }]
  let body, auth
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), COHERE_RERANK_URL)
    body = JSON.parse(init.body); auth = init.headers.authorization
    // Cohere returns results sorted by score, each with its original index
    return new Response(JSON.stringify({ results: [{ index: 2, relevance_score: 0.4 }, { index: 0, relevance_score: 0.2 }, { index: 1, relevance_score: 0.01 }], meta: { billed_units: { search_units: 1 } } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const ok = await rerankWithCohere('my query', cands, { apiKey: 'c-key' })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.scores, [0.2, 0.01, 0.4], 'scores are put back in input order')
  assert.equal(auth, 'bearer c-key')
  assert.equal(body.query, 'my query')
  assert.deepEqual(body.documents, ['Alpha\nabout a', 'Beta', 'Gamma\ng'])
  assert.equal(body.top_n, 3)
  assert.equal((await rerankWithCohere('q', cands, {})).reason, 'no_key')
  assert.equal((await rerankWithCohere('q', [], { apiKey: 'k' })).reason, 'nothing_to_rank')
  // a response missing a candidate is malformed
  globalThis.fetch = async () => new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.3 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  assert.equal((await rerankWithCohere('q', cands, { apiKey: 'c-key' })).reason, 'malformed_response')
  // rate limit (a trial key) opens the breaker and is reported as such
  resetCohereForTests(); resetLimitersForTests()
  let hits = 0
  globalThis.fetch = async () => { hits += 1; return new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } }) }
  assert.equal((await rerankWithCohere('q', cands, { apiKey: 'c-key' })).reason, 'rate_limited')
  assert.equal((await rerankWithCohere('q', cands, { apiKey: 'c-key' })).reason, 'skipped_after_rate_limited')
  assert.equal(hits, 1)

  // engine choice through the tool
  resetCohereForTests(); fresh()
  const tools = []
  ;(await import('../literature-search.js')).apply({ tools: { register: (t) => tools.push(t) } })
  const tool = tools[0]
  const works = Array.from({ length: 8 }, (_, i) => ({ id: `https://openalex.org/W${i + 1}`, doi: `https://doi.org/10.1000/y${i + 1}`, title: `Paper ${i + 1}`, publication_year: 2020 }))
  const seen = { jev: 0, cohere: 0 }
  let jevOk = true, cohereOk = true
  const install = () => {
    globalThis.fetch = async (url, init) => {
      const u = String(url)
      if (u === JEV_URL) {
        seen.jev += 1
        if (!jevOk) return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })
        const questions = Object.keys(JSON.parse(init.body).questions)
        return new Response(JSON.stringify({ model: JEV_MODEL, answers: Object.fromEntries(questions.map((k, i) => [k, { type: 'noul', noul: (i + 1) / 10 }])) }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (u === COHERE_RERANK_URL) {
        seen.cohere += 1
        if (!cohereOk) return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
        // Cohere prefers the FIRST candidate: opposite of Jev above
        const n = JSON.parse(init.body).documents.length
        return new Response(JSON.stringify({ results: Array.from({ length: n }, (_, i) => ({ index: i, relevance_score: 0.9 - i * 0.05 })) }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ meta: { count: 8 }, results: works }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
  }
  const run = (args) => tool.execute({ query: 'x topic', sources: ['openalex'], ...args }, {})
  const reset = () => { fresh(); resetCohereForTests(); seen.jev = 0; seen.cohere = 0; jevOk = true; cohereOk = true; install() }

  // only a Cohere key: auto does not use Cohere, it keeps the fused order and calls nothing
  process.env.COHERE_API_KEY = 'c-key'; reset()
  const onlyCohere = await run({})
  assert.equal(onlyCohere.routing.rerank, undefined, 'Cohere is opt-in, never chosen by auto')
  assert.equal(onlyCohere.papers[0].title, 'Paper 1')
  assert.equal(seen.jev + seen.cohere, 0)
  // ... but rerank:"cohere" asks for it explicitly
  reset()
  const forcedCohere = await run({ rerank: 'cohere' })
  assert.equal(forcedCohere.routing.rerank.engine, 'cohere')
  assert.equal(forcedCohere.routing.rerank.model, 'rerank-v3.5')
  assert.equal(seen.jev, 0)
  assert.match(tool.output.render({}, forcedCohere)[0].text, /ranking: Cohere relevance over the top 8/)

  // both keys: auto uses Jev and never touches Cohere
  process.env.TYPESAFE_API_KEY = 'k-both'; reset()
  assert.equal((await run({})).routing.rerank.engine, 'jev')
  assert.equal(seen.cohere, 0, 'auto never calls Cohere')

  // Jev fails: the fused order stands, the reason is reported, Cohere is not tried
  reset(); jevOk = false
  const down = await run({})
  assert.equal(down.routing.rerank.engine, 'rrf')
  assert.equal(down.routing.rerank.reason, 'http_503')
  assert.equal(down.papers[0].title, 'Paper 1')
  assert.equal(seen.cohere, 0, 'a Jev failure does not send the query to Cohere')
  assert.match(tool.output.render({}, down)[0].text, /fused source ranking/)
  // forcing an engine that has no key is reported, not silently swapped
  delete process.env.COHERE_API_KEY; reset()
  const noKey = await run({ rerank: 'cohere' })
  assert.equal(noKey.routing.rerank.reason, 'no_key')
  assert.equal(seen.jev, 0, 'a forced engine never falls back')
  // neither key: nothing reported
  delete process.env.TYPESAFE_API_KEY; reset()
  assert.equal((await run({})).routing.rerank, undefined)
  // routing=rules sends nothing to either
  process.env.COHERE_API_KEY = 'c-key'; process.env.TYPESAFE_API_KEY = 'k-both'; reset()
  await tool.execute({ query: 'x topic', routing: 'rules' }, {})
  assert.equal(seen.jev + seen.cohere, 0)
  delete process.env.COHERE_API_KEY; delete process.env.TYPESAFE_API_KEY
}

/* ---------------------------------------------------------------- local BM25 fallback */
{
  assert.deepEqual(tokenize('Effects of the Vitamin-D supplementation'), ['effect', 'vitamin', 'supplementation'])
  const cands = [
    { title: 'Cooking pasta', abstract: 'boil water' },
    { title: 'Vitamin D and bone density', abstract: 'postmenopausal women supplementation trial' },
    { title: 'Bone cells', abstract: 'osteoclast' },
  ]
  const r = rankWithBm25('vitamin D supplementation bone density women', cands)
  assert.equal(r.ok, true)
  assert.equal(r.scores[0], 0)
  assert.ok(r.scores[1] > r.scores[2] && r.scores[2] > 0)
  assert.equal(rankWithBm25('the of', cands).reason, 'nothing_to_rank')
  assert.equal(rankWithBm25('quark', cands).reason, 'no_term_overlap')
  assert.equal(rankWithBm25('bone', []).reason, 'nothing_to_rank')

  // fusion keeps the source order when BM25 has no opinion, and lets a strong lexical match move up
  const pool = Array.from({ length: 6 }, (_, i) => ({ title: `Unrelated study ${i}`, abstract: '' }))
  pool[5] = { title: 'Zebra finch song learning', abstract: 'zebra finch song learning in juveniles' }
  const local = orderLocally('zebra finch song learning', pool)
  assert.equal(local.ok, true)
  // fusion is gentle: the lexical match climbs from 6th to 3rd, it does not jump the top two
  assert.equal(local.ordered.findIndex((p) => p.title === 'Zebra finch song learning'), 2)
  assert.deepEqual(local.ordered.filter((p) => p.title !== 'Zebra finch song learning').map((p) => p.title), pool.slice(0, 5).map((p) => p.title), 'the rest keep source order')
  assert.equal(orderLocally('quark', pool).ok, false)
}

{
  delete process.env.TYPESAFE_API_KEY; delete process.env.COHERE_API_KEY
  const titles = ['Unrelated study A', 'Unrelated study B', 'Unrelated study C', 'Unrelated study D', 'Unrelated study E', 'Zebra finch song learning']
  const works = titles.map((title, i) => ({ id: `https://openalex.org/W${i + 1}`, doi: `https://doi.org/10.1000/z${i + 1}`, title, publication_year: 2020, abstract_inverted_index: i === 5 ? { zebra: [0], finch: [1], song: [2], learning: [3] } : undefined }))
  let network = 0
  fresh()
  const tools = []
  ;(await import('../literature-search.js')).apply({ tools: { register: (t) => tools.push(t) } })
  const tool = tools[0]
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u === JEV_URL || u === COHERE_RERANK_URL) { network += 1; return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }) }
    return new Response(JSON.stringify({ meta: { count: 6 }, results: works }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const run = (args) => tool.execute({ query: 'zebra finch song learning', sources: ['openalex'], ...args }, {})

  // no keys: auto uses the local ranking, which calls nothing and carries no `relevance`
  const auto = await run({})
  assert.equal(auto.routing.rerank.engine, 'bm25')
  assert.equal(auto.routing.rerank.model, 'bm25+fused')
  assert.equal(auto.papers.findIndex((p) => p.title === 'Zebra finch song learning'), 2, 'moved up from 6th')
  assert.equal(auto.papers[0].relevance, undefined)
  assert.equal(network, 0)
  assert.match(tool.output.render({}, auto)[0].text, /ranking: local BM25 fused with the source order over the top 6/)
  // off keeps the plain fused order
  const off = await run({ rerank: 'off' })
  assert.equal(off.routing.rerank, undefined)
  assert.equal(off.papers[0].title, 'Unrelated study A')
  // routing=rules still allows the local ranking (nothing leaves the machine)
  const rules = await run({ routing: 'rules' })
  assert.equal(rules.routing.rerank.engine, 'bm25')
  // a forced network engine without a key is reported, never swapped for BM25
  const forced = await run({ rerank: 'jev' })
  assert.equal(forced.routing.rerank.reason, 'no_key')
  assert.equal(forced.papers[0].title, 'Unrelated study A')
  // routing=rules with a forced network engine sends nothing and does not rerank
  process.env.TYPESAFE_API_KEY = 'k-local'; fresh()
  const rulesJev = await run({ routing: 'rules', rerank: 'jev' })
  assert.equal(rulesJev.routing.rerank, undefined)
  assert.equal(network, 0)
  // Jev configured but failing: the local ranking takes over and says why
  fresh()
  const failing = await run({})
  assert.equal(failing.routing.rerank.engine, 'bm25')
  assert.deepEqual(failing.routing.rerank.fallback_from, { jev: 'http_503' })
  assert.equal(failing.papers.findIndex((p) => p.title === 'Zebra finch song learning'), 2)
  assert.match(tool.output.render({}, failing)[0].text, /jev skipped: http_503/)
  // bm25 can be forced even with a Jev key, and then never calls Jev
  network = 0; fresh()
  const forcedLocal = await run({ rerank: 'bm25' })
  assert.equal(forcedLocal.routing.rerank.engine, 'bm25')
  assert.equal(network, 0)
  delete process.env.TYPESAFE_API_KEY
}

/* ---------------------------------------------------------------- literature_watch add */
{
  const cwd = mkdtempSync(join(tmpdir(), 'jev-watch-'))
  const exec = { agent: { session: { header: { cwd } } } }
  try {
    const frozen = await runLiteratureWatch({
      action: 'add', name: 'microbiome', query: 'gut microbiome and depression',
    }, exec, {
      routeSources: async () => ({ sources: ['openalex', 's2', 'pubmed'], routing: { engine: 'jev', model: JEV_MODEL }, suggested_tools: [] }),
    })
    assert.deepEqual(frozen.watch.sources, ['openalex', 's2', 'pubmed'], 'Jev routing is frozen at add time')
    assert.equal(frozen.routing.engine, 'jev')

    const keyless = await runLiteratureWatch({
      action: 'add', name: 'plain', query: 'gut microbiome and depression',
    }, exec, {
      routeSources: async () => ({ sources: ['openalex', 's2'], routing: { engine: 'rules', reason: 'no_key' }, suggested_tools: [] }),
    })
    assert.equal(keyless.watch.sources, null, 'rules routing leaves the watch on auto')
    assert.equal(keyless.routing, undefined)

    const explicit = await runLiteratureWatch({
      action: 'add', name: 'explicit', query: 'q', sources: 'arxiv',
    }, exec, { routeSources: async () => { throw new Error('must not route when sources are given') } })
    assert.deepEqual(explicit.watch.sources, ['arxiv'])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}


/* ---------------------------------------------------------------- preprint wording */
{
  assert.equal(preprintTopic('recent preprints on H5N1 in dairy cattle'), 'H5N1 in dairy cattle')
  assert.equal(preprintTopic('latest bioRxiv preprints about organoid vascularisation'), 'organoid vascularisation')
  assert.equal(preprintTopic('medRxiv preprints on mpox transmission'), 'mpox transmission')
  assert.equal(preprintTopic('the most recent preprints regarding long COVID'), 'long COVID')
  assert.equal(preprintTopic('malaria treatment preprints'), 'malaria treatment')
  assert.equal(preprintTopic('malaria treatment bioRxiv preprints'), 'malaria treatment')
  assert.equal(preprintTopic('gut microbiome and depression'), 'gut microbiome and depression', 'a plain query is untouched')
  assert.equal(preprintTopic('preprints'), 'preprints', 'never strips down to nothing')
  assert.equal(preprintTopic('  '), '')
}

globalThis.fetch = realFetch
console.log('jev router OK')
