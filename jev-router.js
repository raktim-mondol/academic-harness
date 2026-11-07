/**
 * Jev source routing for `literature_search`.
 *
 * TypeSafe's Jev answers fast yes/no questions about a query. Here it decides
 * which domain sources to add on top of the always-on OpenAlex + Semantic Scholar
 * pair, and whether the query is really asking for a different tool (trials,
 * datasets, patents, grants, venues, a specific paper). One request carries one
 * Noul per question; code owns the policy:
 *
 *   - a source is added only at probability >= ROUTE_THRESHOLD (0.7);
 *   - keyed or explicit-only sources (Scopus, WoS, Springer, IEEE, Crossref, DOAJ,
 *     publishers) are never chosen here, whatever Jev says;
 *   - any failure, slow answer, or malformed response falls back to the keyword
 *     rules in literature-search.js (`chooseSources`), and the result says so.
 *
 * Pure module: no import from literature-search.js (that file composes this with
 * `chooseSources`). Plain `fetch` through search-http.js, no SDK dependency.
 * The model is pinned: thresholds were tuned against it, and an alias would move
 * them silently.
 */
import { fetchJson } from './search-http.js'

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL = 'jev-1.14.0'
export const ROUTE_THRESHOLD = 0.7
export const BORDERLINE_LOW = 0.3
/** Level 1 of the hierarchy: how sure Jev must be that a query is NOT a topic search. */
export const GATE_THRESHOLD = 0.9
/** Intents that mean "this is not a topic search": a topic search of papers is the wrong tool. */
export const NON_PAPER_INTENTS = ['clinical_trials', 'datasets', 'patents', 'grants', 'venues', 'not_scholarly', 'retraction', 'specific_paper']
export const ROUTE_TIMEOUT_MS = 1500

const SOURCE_QUESTIONS = {
  pubmed: {
    type: 'noul',
    instructions: 'Would a search of PubMed / Europe PMC (biomedical, clinical, public-health and life-science journals) likely return research papers relevant to the topic in `query`?',
    criteria: {
      true: 'The topic is about human or animal health, medicine, clinical care, biology, genetics, neuroscience, pharmacology, or public health, including computational or AI methods applied to them.',
      false: 'The topic is outside medicine and the life sciences, even if it uses words such as cell, health, drug, or virus in another sense (fuel cells, financial health, drug policy, computer viruses).',
    },
  },
  arxiv: {
    type: 'noul',
    instructions: 'Would a search of arXiv (preprints in physics, astronomy, mathematics, computer science, machine learning, statistics, electrical engineering, quantitative biology and quantitative finance) likely return research papers relevant to the topic in `query`?',
    criteria: {
      true: 'The topic is research in physics, astronomy, mathematics, computer science, AI or machine learning, statistics, or engineering, or applies computational, mathematical or ML methods to another field.',
      false: 'The topic is clinical, social-science, humanities, education or policy research with no physics, mathematics, computing or machine-learning component.',
    },
  },
  inspire: {
    type: 'noul',
    instructions: 'Is the topic in `query` high-energy, particle, nuclear or astroparticle physics, or gravitation and cosmology theory, the fields indexed by INSPIRE-HEP?',
  },
  ads: {
    type: 'noul',
    instructions: 'Is the topic in `query` astronomy, astrophysics, planetary science or cosmology, the fields indexed by the NASA Astrophysics Data System?',
  },
  life_science: {
    type: 'noul',
    instructions: 'Is the topic in `query` in the life sciences: biology, medicine, ecology, agriculture, neuroscience, microbiology, genetics, or biochemistry?',
  },
  wants_preprints: {
    type: 'noul',
    instructions: 'Does `query` explicitly ask for preprints (bioRxiv, medRxiv, arXiv) or for very recent, not-yet-published work?',
  },
}

/** intent -> the plugin tool that answers it better than a topic search does. */
const INTENT_QUESTIONS = {
  clinical_trials: 'Does `query` ask for clinical trial registrations or ongoing or planned trials, rather than published papers?',
  datasets: 'Does `query` ask for datasets or data repositories rather than papers?',
  patents: 'Does `query` ask for patents or prior art in patent filings?',
  grants: 'Does `query` ask for research funding, grants or funding calls?',
  venues: 'Does `query` ask which journal or conference to publish in, or about venue rankings?',
  study_design: 'Does `query` restrict the evidence by study design or quality, such as randomised trials, meta-analyses, systematic reviews or minimum sample size?',
  specific_paper: 'Does `query` identify one specific paper, by title, DOI, arXiv ID or PMID, rather than describe a topic?',
  not_scholarly: 'Is `query` mainly about current events, news, prices, products, companies, laws or regulations, official guidance, deadlines, or practical how-to information, so that scholarly journal papers would not be the main source?',
  claim_check: 'Does `query` state a specific scientific claim, or ask whether a claim or finding is supported, contradicted or disputed by the research literature?',
  retraction: 'Does `query` ask whether a specific paper or study has been retracted, corrected, or flagged with an expression of concern?',
}

/**
 * intent -> tools that answer it better than a topic search, best first. The first
 * choice whose key is set (or that needs none) is suggested, so a tool that cannot
 * run is never recommended. `web_search` is built in and always available.
 */
export const INTENT_TOOLS = {
  clinical_trials: { why: 'asks for trial registrations', choices: [{ tool: 'clinicaltrials' }] },
  datasets: { why: 'asks for datasets', choices: [{ tool: 'dataset_search' }] },
  patents: { why: 'asks for patents', choices: [{ tool: 'patent_search', needs: 'PATENTSVIEW_API_KEY' }] },
  grants: { why: 'asks for funding', choices: [{ tool: 'grant_search' }] },
  venues: { why: 'asks which venue to publish in', choices: [{ tool: 'journal_search' }] },
  study_design: { why: 'restricts by study design', choices: [{ tool: 'consensus_search', needs: 'CONSENSUS_API_KEY' }, { tool: 'elicit_search', needs: 'ELICIT_API_KEY' }] },
  specific_paper: { why: 'names one specific paper', choices: [{ tool: 'paper_get' }] },
  not_scholarly: {
    why: 'is about news, products, regulations or other non-scholarly material',
    choices: [
      { tool: 'parallel_search', needs: 'PARALLEL_API_KEY' },
      { tool: 'exa_search', needs: 'EXA_API_KEY' },
      { tool: 'tavily_search', needs: 'TAVILY_API_KEY' },
      { tool: 'brave_search', needs: 'BRAVE_API_KEY' },
      { tool: 'web_search' },
    ],
  },
  claim_check: {
    why: 'asks whether a claim is supported or disputed',
    choices: [{ tool: 'mcp__scite__*', needs: 'SCITE_API_KEY' }, { tool: 'consensus_search', needs: 'CONSENSUS_API_KEY' }],
  },
  retraction: { why: 'asks whether a paper was retracted or corrected', choices: [{ tool: 'integrity_check' }] },
}

/** Intents with a dedicated tool; when one fires, the generic `not_scholarly` hint is dropped. */
const SPECIFIC_INTENTS = ['clinical_trials', 'datasets', 'patents', 'grants', 'venues', 'specific_paper', 'retraction']

/** Every key a tool hint can depend on; the caller resolves these once. */
export const HINT_KEYS = [...new Set(Object.values(INTENT_TOOLS).flatMap((spec) => spec.choices.map((c) => c.needs).filter(Boolean)))]

export function buildQuestions({ ads = false } = {}) {
  const questions = {}
  for (const [name, question] of Object.entries(SOURCE_QUESTIONS)) {
    if (name === 'ads' && !ads) continue
    questions[`src::${name}`] = question
  }
  for (const [name, text] of Object.entries(INTENT_QUESTIONS)) {
    questions[`intent::${name}`] = { type: 'noul', instructions: text }
  }
  return questions
}

/** Turn raw probabilities into the domain sources to add, in the rules' own order. */
export function decideSources(p, { ads = false, threshold = ROUTE_THRESHOLD } = {}) {
  const yes = (name) => (p[name] ?? 0) >= threshold
  const sources = ['openalex', 's2']
  if (yes('pubmed')) sources.push('pubmed')
  if (yes('arxiv')) sources.push('arxiv')
  // bioRxiv/medRxiv only for a life-science topic that asks for preprints, the
  // same two-part condition the keyword rules use. Gated on its own life-science
  // question, not on PubMed's score: bioRxiv covers plant biology and ecology that
  // PubMed's health slant scores lower.
  if (yes('life_science') && yes('wants_preprints')) sources.push('biorxiv')
  if (yes('inspire')) sources.push('inspire')
  if (ads && yes('ads')) sources.push('ads')
  return sources
}

/**
 * The non-paper intents Jev is at least `threshold` sure of. When any fires, domain
 * sources are skipped (hint mode): PubMed adds nothing to "price of an Nvidia GPU" or a
 * DOI. claim_check and study_design are deliberately not here: they are still topic
 * searches. Stricter than the 0.7 used to show a hint, because wrongly skipping sources
 * costs more than a wasted call.
 */
export function gatingIntents(p, threshold = GATE_THRESHOLD) {
  return NON_PAPER_INTENTS.filter((name) => (p[`intent::${name}`] ?? 0) >= threshold)
}

/** Sources that scored in the grey band: shown to the user, never acted on. */
export function borderlineSources(p, { ads = false } = {}) {
  const names = ['pubmed', 'arxiv', 'inspire', ...(ads ? ['ads'] : [])]
  return names
    .filter((name) => p[name] != null && p[name] > BORDERLINE_LOW && p[name] < ROUTE_THRESHOLD)
    .map((name) => ({ source: name, p: Number(p[name].toFixed(2)) }))
}

/**
 * Tools the query is really asking for. `available(envName)` says whether a keyed
 * tool can run; the first usable choice per intent wins, and one tool suggested by
 * two intents is listed once with the higher probability.
 */
export function suggestTools(p, available = () => true, threshold = ROUTE_THRESHOLD) {
  const byTool = new Map()
  // "not scholarly" is the catch-all: a funding call, a patent or a trial registry also looks
  // like non-journal material to it. When a specific intent fires too, the specific tool is the
  // answer and the generic web search is noise.
  const specificFired = SPECIFIC_INTENTS.some((name) => (p[`intent::${name}`] ?? 0) >= threshold)
  for (const [name, spec] of Object.entries(INTENT_TOOLS)) {
    if (name === 'not_scholarly' && specificFired) continue
    const score = p[`intent::${name}`]
    if (score == null || score < threshold) continue
    const pick = spec.choices.find((choice) => !choice.needs || available(choice.needs))
    if (!pick) continue
    const prior = byTool.get(pick.tool)
    if (!prior || score > prior.p) byTool.set(pick.tool, { tool: pick.tool, reason: spec.why, p: Number(score.toFixed(2)) })
  }
  return [...byTool.values()]
}

/* ------------------------------------------------------------------ transport */

// A slow or failing Jev must not tax every search: after a failure, skip it for a
// while (longer for a rejected key). Keyed by the key itself so entering a new
// key in Settings takes effect on the next call.
const breaker = new Map()
const cache = new Map()
const CACHE_MAX = 200
const BREAK_MS = 60_000
const BREAK_AUTH_MS = 10 * 60_000

export function resetJevForTests() {
  breaker.clear()
  cache.clear()
}

function reasonFor(result) {
  if (result.status === 401 || result.status === 403) return 'auth_failed'
  if (result.status === 429) return 'rate_limited'
  // search-http reports a deadline hit mid-fetch as "network error: request timed out"
  if (/timed out/i.test(result.error || '')) return 'timeout'
  if (result.error === 'aborted') return 'aborted'
  return result.status ? `http_${result.status}` : 'network_error'
}

/**
 * Ask Jev about one query. Never throws: resolves to
 * `{ ok: true, p, model, ms, usage, cached }` or `{ ok: false, reason }`.
 */
export async function askJev(query, { apiKey, ads = false, signal, timeoutMs = ROUTE_TIMEOUT_MS, now = Date.now } = {}) {
  if (!apiKey) return { ok: false, reason: 'no_key' }
  const text = String(query || '').trim()
  if (!text) return { ok: false, reason: 'empty_query' }
  const until = breaker.get(apiKey)
  if (until && now() < until.at) return { ok: false, reason: `skipped_after_${until.reason}` }

  const cacheKey = `${JEV_MODEL}|${ads ? 'ads' : '-'}|${text}`
  if (cache.has(cacheKey)) return { ...cache.get(cacheKey), cached: true }

  const started = Date.now()
  const result = await fetchJson(JEV_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: JEV_MODEL, state: { query: text }, questions: buildQuestions({ ads }) }),
    timeoutMs,
    retries: 0,
    signal,
  })
  const ms = Date.now() - started
  if (!result.ok) {
    const reason = reasonFor(result)
    if (reason !== 'aborted') breaker.set(apiKey, { at: now() + (reason === 'auth_failed' ? BREAK_AUTH_MS : BREAK_MS), reason })
    return { ok: false, reason, ms }
  }

  const answers = result.data?.answers
  const wanted = Object.keys(buildQuestions({ ads }))
  const p = {}
  for (const key of wanted) {
    const value = answers?.[key]?.noul
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      return { ok: false, reason: 'malformed_response', ms }
    }
    p[key.replace(/^src::/, '')] = value
  }
  const out = {
    ok: true,
    p,
    model: result.data?.model || JEV_MODEL,
    ms,
    usage: result.data?.usage ?? null,
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
  cache.set(cacheKey, out)
  return out
}

/* --------------------------------------------------------------------- rerank */

export const RERANK_POOL = 30
export const RERANK_TIMEOUT_MS = 4000
const RERANK_QUESTION = 'Is the document below directly relevant to the search query in `query`: would a researcher who typed that query want to read this document?'
const ABSTRACT_CHARS = 1200

/**
 * Score merged candidates for relevance to the query with one Jev request (one yes/no
 * question per candidate, evaluated in parallel by Jev). Returns `{ ok: true, scores }`
 * with a probability per candidate in input order, or `{ ok: false, reason }`; never throws.
 * Kept on its own breaker so a slow rerank cannot switch off source routing.
 */
export async function rerankWithJev(query, candidates, { apiKey, signal, timeoutMs = RERANK_TIMEOUT_MS, now = Date.now } = {}) {
  if (!apiKey) return { ok: false, reason: 'no_key' }
  const text = String(query || '').trim()
  if (!text || !candidates?.length) return { ok: false, reason: 'nothing_to_rank' }
  const breakKey = `${apiKey}|rerank`
  const until = breaker.get(breakKey)
  if (until && now() < until.at) return { ok: false, reason: `skipped_after_${until.reason}` }

  const questions = {}
  candidates.forEach((paper, index) => {
    const abstract = String(paper.abstract || '').slice(0, ABSTRACT_CHARS)
    questions[`c${index}`] = {
      type: 'noul',
      instructions: `${RERANK_QUESTION}\n\nDocument title: ${paper.title || ''}${abstract ? `\nDocument abstract: ${abstract}` : ''}`,
    }
  })
  const started = Date.now()
  const result = await fetchJson(JEV_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: JEV_MODEL, state: { query: text }, questions }),
    timeoutMs,
    retries: 0,
    signal,
  })
  const ms = Date.now() - started
  if (!result.ok) {
    const reason = reasonFor(result)
    if (reason !== 'aborted') breaker.set(breakKey, { at: now() + (reason === 'auth_failed' ? BREAK_AUTH_MS : BREAK_MS), reason })
    return { ok: false, reason, ms }
  }
  const scores = candidates.map((_, index) => result.data?.answers?.[`c${index}`]?.noul)
  if (scores.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) return { ok: false, reason: 'malformed_response', ms }
  return { ok: true, scores, model: result.data?.model || JEV_MODEL, ms, usage: result.data?.usage ?? null }
}

/** Stable reorder: highest relevance first, ties keep their fused (RRF) order. */
export function orderByRelevance(candidates, scores) {
  return candidates
    .map((paper, index) => ({ paper, index, score: scores[index] }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
}

