/**
 * Local lexical relevance scoring (BM25) for `literature_search` candidates.
 *
 * Needs no key and no network: it scores the merged candidates' title + abstract against the
 * query in memory. Same contract as the other rerankers: `{ ok: true, scores }` (one number per
 * candidate, input order) or `{ ok: false, reason }`. Never throws.
 *
 * Scores are not probabilities and only compare candidates within one search. Lexical matching
 * cannot see synonyms or non-English queries against English abstracts, which is why Jev (or the
 * fused source order) stays the default and this is evaluated before use.
 */
const K1 = 1.2
const B = 0.75
const TITLE_WEIGHT = 2
const ABSTRACT_CHARS = 1200

const STOP = new Set((
  'a an and are as at be but by can do does for from had has have how in into is it its of on or such that the their then ' +
  'there these they this to was were what when where which while who whom why will with within without versus vs via using use used'
).split(' '))

/** Lowercase word tokens; very light plural/-ing/-ed stripping so "women"/"woman" stay distinct but "effects"/"effect" meet. */
export function tokenize(text) {
  const out = []
  for (const raw of String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}\p{N}]+/u)) {
    if (!raw || (raw.length < 2 && !/\d/.test(raw)) || STOP.has(raw)) continue
    out.push(stem(raw))
  }
  return out
}

function stem(word) {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3)
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 4 && word.endsWith('es') && /(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is')) return word.slice(0, -1)
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2)
  return word
}

export function rankWithBm25(query, candidates) {
  const terms = [...new Set(tokenize(query))]
  if (!terms.length || !candidates?.length) return { ok: false, reason: 'nothing_to_rank' }

  const docs = candidates.map((paper) => {
    const tf = new Map()
    let length = 0
    const add = (text, weight) => {
      for (const token of tokenize(text)) {
        tf.set(token, (tf.get(token) || 0) + weight)
        length += weight
      }
    }
    add(paper.title, TITLE_WEIGHT)
    add(String(paper.abstract || '').slice(0, ABSTRACT_CHARS), 1)
    return { tf, length }
  })
  const n = docs.length
  const avg = docs.reduce((sum, d) => sum + d.length, 0) / n || 1
  const df = new Map(terms.map((t) => [t, docs.reduce((count, d) => count + (d.tf.has(t) ? 1 : 0), 0)]))

  const scores = docs.map((d) => {
    let score = 0
    for (const t of terms) {
      const f = d.tf.get(t)
      if (!f) continue
      const idf = Math.log(1 + (n - df.get(t) + 0.5) / (df.get(t) + 0.5))
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.length / avg))))
    }
    return score
  })
  if (!scores.some((s) => s > 0)) return { ok: false, reason: 'no_term_overlap' }
  return { ok: true, scores, model: 'bm25' }
}
