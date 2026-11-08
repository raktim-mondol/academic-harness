#!/usr/bin/env node
/**
 * Live smoke evaluation of prior_art on REAL search results. Needs the network,
 * so it is not part of `npm test`.
 *
 *   node scripts/prior-art-live-eval.mjs collect  <out.json>      retrieve and dump candidates
 *   node scripts/prior-art-live-eval.mjs evaluate <labels.json>   retrieve again, score against labels
 *
 * HONEST LIMITS. The labels in scripts/fixtures/prior-art-live-labels.json were
 * written by the implementer (an AI assistant) reading each candidate's title
 * and abstract; no independent human labelled them, and human labelling is not
 * available. Retrieval drifts between runs, so a candidate with no label is
 * counted as unlabeled and left out, never guessed. The set is tiny and chosen
 * by hand. The output is a smoke check of how the tool behaves on real text and
 * how well its one semantic signal (the lexical cross-check) tracks the labels:
 * counts only, no claim of accuracy.
 *
 * The labels file stores titles, identifiers and labels, not abstracts, so no
 * third-party text is redistributed; the abstracts are re-fetched at run time.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runOpenAlexSearch } from '../openalex-search.js'
import { runArxivSearch } from '../arxiv-search.js'
import { runPubMedSearch } from '../pubmed-search.js'
import { arxivDiscoveryQuery } from '../literature-search.js'
import { LEXICAL_HIGH, LEXICAL_LOW, priorArtReport } from '../prior-art.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PER_SOURCE = { openalex: 6, arxiv: 4, pubmed: 4 }
const claims = JSON.parse(readFileSync(join(root, 'scripts/fixtures/prior-art-live-claims.json'), 'utf8')).claims

const norm = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
export function candidateKey(paper) {
  const doi = String(paper.doi ?? '').toLowerCase().replace(/^https?:\/\/doi\.org\//, '')
  if (doi) return `doi:${doi}`
  if (paper.arxiv_id) return `arxiv:${String(paper.arxiv_id).replace(/v\d+$/, '')}`
  if (paper.pmid) return `pmid:${paper.pmid}`
  return `title:${norm(paper.title)}`
}

async function search(source, claim) {
  const signal = AbortSignal.timeout(30_000)
  const started = new Date().toISOString()
  try {
    let results
    if (source === 'openalex') {
      results = (await runOpenAlexSearch({ query: claim.query, per_page: PER_SOURCE.openalex, select: 'id,doi,ids,title,publication_year,abstract_inverted_index' }, { signal })).results
    } else if (source === 'arxiv') {
      results = (await runArxivSearch({ query: arxivDiscoveryQuery(claim.query), field: 'all', max_results: PER_SOURCE.arxiv }, { signal })).results
    } else {
      results = (await runPubMedSearch({ query: claim.query, source: 'europepmc', max_results: PER_SOURCE.pubmed }, { signal })).results
    }
    return { source, started, status: 'ok', limit: PER_SOURCE[source], results: results || [] }
  } catch (error) {
    return { source, started, status: 'failed', error: error instanceof Error ? error.message : String(error), limit: PER_SOURCE[source], results: [] }
  }
}

async function retrieve() {
  const out = []
  for (const claim of claims) {
    const seen = new Map()
    const searches = []
    for (const source of claim.sources) {
      const run = await search(source, claim)
      searches.push({ provider: source, query: claim.query, status: run.status, accessed_at: run.started, limit: run.limit, result_count: run.results.length, ...(run.error ? { error: run.error } : {}) })
      for (const paper of run.results) {
        if (!paper.title) continue
        const key = candidateKey(paper)
        if (!seen.has(key)) seen.set(key, { key, source, title: paper.title, year: paper.year ?? null, doi: paper.doi ?? null, abstract: paper.abstract || '' })
      }
    }
    out.push({ ...claim, searches, candidates: [...seen.values()] })
  }
  return out
}

function sentences(text) {
  return String(text).replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.split(' ').length >= 6)
}

async function collect(outPath) {
  const data = await retrieve()
  writeFileSync(outPath, JSON.stringify(data, null, 1))
  for (const c of data) console.log(`${c.id}: ${c.candidates.length} candidates (${c.candidates.filter((x) => x.abstract).length} with abstract); searches ${c.searches.map((s) => `${s.provider}:${s.status}:${s.result_count}`).join(' ')}`)
}

async function evaluate(labelsPath) {
  const labels = JSON.parse(readFileSync(labelsPath, 'utf8')).labels
  const data = await retrieve()
  const tally = { claims: data.length, retrieved: 0, with_abstract: 0, labelled: 0, unlabeled: 0, no_abstract: 0 }
  const byLabel = { none: [], partial: [], close: [] }
  const confusion = { tp: 0, fp: 0, fn: 0, tn: 0 }
  const statements = {}
  const quotes = { attempted: 0, verified: 0 }
  const flagged = { high_but_none: 0, low_but_close: 0 }
  const perClaim = []

  for (const claim of data) {
    const candidates = []
    for (const cand of claim.candidates) {
      tally.retrieved += 1
      if (!cand.abstract) { tally.no_abstract += 1; continue }
      tally.with_abstract += 1
      const entry = labels[`${claim.id}|${cand.key}`]
      if (!entry) { tally.unlabeled += 1; continue }
      tally.labelled += 1
      const quotesIn = []
      if (entry.label === 'partial' || entry.label === 'close') {
        const best = sentences(cand.abstract)[0]
        if (best) quotesIn.push({ quote: best, location: 'abstract' })
      }
      candidates.push({ ref: { title: cand.title, year: cand.year, doi: cand.doi || undefined }, provider: cand.source, evidence_level: 'abstract', text: cand.abstract, quotes: quotesIn, overlap: { claimed: entry.label, ...(entry.label === 'none' ? {} : { distinction: entry.note || 'see label note' }) } })
    }
    const report = priorArtReport({ claim: claim.claim, searches: claim.searches, candidates })
    statements[report.statement] = (statements[report.statement] || 0) + 1
    perClaim.push({ id: claim.id, statement: report.statement, candidates: report.candidates.length, claimed_overlap: report.counts.claimed_overlap, flagged: report.counts.flagged })
    for (const c of report.candidates) {
      byLabel[c.claimed_overlap].push(c.lexical_overlap)
      const predicted = c.lexical_overlap >= LEXICAL_HIGH
      const actual = c.claimed_overlap !== 'none'
      confusion[actual ? (predicted ? 'tp' : 'fn') : (predicted ? 'fp' : 'tn')] += 1
      for (const q of c.quotes) { quotes.attempted += 1; if (q.state === 'verified_in_abstract') quotes.verified += 1 }
      if (c.flags.includes('lexical_overlap_high_but_claimed_none_or_unknown')) flagged.high_but_none += 1
      if (c.flags.includes('claimed_close_but_lexical_overlap_low')) flagged.low_but_close += 1
    }
  }
  const stats = (xs) => (xs.length ? { n: xs.length, min: Math.min(...xs), median: [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)], max: Math.max(...xs) } : { n: 0 })
  console.log(JSON.stringify({
    note: 'Implementer-labelled smoke check on live results; counts only, not an accuracy claim.',
    thresholds: { lexical_high: LEXICAL_HIGH, lexical_low: LEXICAL_LOW },
    tally,
    lexical_by_label: { none: stats(byLabel.none), partial: stats(byLabel.partial), close: stats(byLabel.close) },
    lexical_high_vs_label_partial_or_close: confusion,
    cross_check_flags_raised: flagged,
    quotes_from_real_abstracts: quotes,
    report_statements: statements,
    per_claim: perClaim,
  }, null, 1))
}

const [mode, file] = process.argv.slice(2)
if (!file || !['collect', 'evaluate'].includes(mode)) {
  console.error('usage: prior-art-live-eval.mjs collect <out.json> | evaluate <labels.json>')
  process.exit(2)
}
await (mode === 'collect' ? collect(file) : evaluate(file))
