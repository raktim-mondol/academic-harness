/**
 * Independence clustering for a research corpus.
 *
 * A sweep that returns five reprints of one press release has not found five
 * sources, and a synthesis that treats them as agreement manufactures consensus
 * out of syndication. This module groups records that describe the same
 * *originating act* so each group gets one vote, and reports the group as
 * evidence of how widely a single claim was repeated.
 *
 * Deterministic and dependency-free: no embedding, no network, no model. Two
 * rules are load-bearing and tested:
 *
 * - **Distinct DOIs are never merged.** A DOI names the work, so two different
 *   DOIs are two works however similar their titles look. Near-title merging
 *   across a DOI conflict is the failure mode that would silently delete real
 *   evidence.
 * - **Near-title needs corroboration.** A similar title alone is not a match;
 *   it takes a compatible year as well, or a shared host.
 */
import { sha256 } from './ledger-kit.js'

const SCHOLARLY_SOURCES = new Set([
  'openalex', 's2', 'pubmed', 'arxiv', 'crossref', 'biorxiv', 'preprints',
  'doaj', 'inspire', 'ads', 'scopus', 'wos', 'springer', 'ieee', 'publishers',
])

/** Lowercase, scheme- and prefix-free DOI. Returns null when there is none. */
export function normalizeDoi(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return null
  const stripped = raw
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//u, '')
    .replace(/^doi:\s*/u, '')
    .replace(/\s+/gu, '')
  // An empty DOI string, or the bare prefix, is not a identifier.
  return stripped && stripped !== '/' ? stripped : null
}

/** Case-, punctuation-, and accent-insensitive title used for matching. */
export function normalizeTitle(value) {
  const raw = String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/gu, '')
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    // A leading "the" changes nothing about which work this is.
    .replace(/^the\s+/u, '')
}

/** Lowercase registrable host, `www.` dropped. Null when unparseable. */
export function urlHost(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`)
    const host = url.hostname.toLowerCase().replace(/^www\./u, '')
    return host || null
  } catch {
    return null
  }
}

/** Word shingles; short texts fall back to the whole string so they still compare. */
export function titleShingles(value, size = 5) {
  const words = String(value ?? '').split(' ').filter(Boolean)
  if (!words.length) return new Set()
  if (words.length <= size) return new Set([words.join(' ')])
  const out = new Set()
  for (let index = 0; index + size <= words.length; index += 1) out.add(words.slice(index, index + size).join(' '))
  return out
}

export function jaccard(a, b) {
  if (!a?.size || !b?.size) return 0
  let shared = 0
  for (const item of a) if (b.has(item)) shared += 1
  return shared / (a.size + b.size - shared)
}

/** Fingerprint of title plus abstract: identical bodies across hosts is syndication. */
export function bodyFingerprint(record) {
  const title = normalizeTitle(record?.title)
  const abstract = normalizeTitle(record?.abstract || record?.tldr || '')
  if (!title && !abstract) return null
  const shape = `${title} ${abstract}`.trim().slice(0, 2400)
  if (!shape) return null
  return sha256(shape)
}

function workIds(record) {
  const ids = []
  for (const key of ['doi', 'arxiv_id', 'pmid', 'pmcid', 'openalex_id', 's2_id', 'scopus_id', 'wos_uid']) {
    const value = key === 'doi' ? normalizeDoi(record?.[key]) : String(record?.[key] ?? '').trim().toLowerCase()
    if (value) ids.push(`${key}:${value}`)
  }
  return ids
}

/** Two records with conflicting persistent ids are different works. */
function idsConflict(a, b) {
  for (const key of ['doi', 'arxiv_id', 'pmid', 'pmcid']) {
    const left = key === 'doi' ? normalizeDoi(a?.[key]) : String(a?.[key] ?? '').trim().toLowerCase()
    const right = key === 'doi' ? normalizeDoi(b?.[key]) : String(b?.[key] ?? '').trim().toLowerCase()
    if (left && right && left !== right) return true
  }
  return false
}

function yearsCompatible(a, b) {
  const left = Number(a?.year)
  const right = Number(b?.year)
  if (!Number.isFinite(left) || !Number.isFinite(right)) return true
  return Math.abs(left - right) <= 1
}

class DisjointSet {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, index) => index)
  }

  find(index) {
    let root = index
    while (this.parent[root] !== root) root = this.parent[root]
    // Path compression keeps the pairwise sweep linear on a few hundred records.
    let cursor = index
    while (this.parent[cursor] !== root) {
      const next = this.parent[cursor]
      this.parent[cursor] = root
      cursor = next
    }
    return root
  }

  union(a, b) {
    const rootA = this.find(a)
    const rootB = this.find(b)
    if (rootA === rootB) return
    if (rootA < rootB) this.parent[rootB] = rootA
    else this.parent[rootA] = rootB
  }
}

/** A citation count stays null when no source reported one; 0 is a real value. */
function citationCount(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function representativeScore(record, index) {
  const citations = citationCount(record?.citation_count)
  const scholarly = SCHOLARLY_SOURCES.has(String(record?.source ?? '').toLowerCase())
  return {
    citations: citations ?? -1,
    scholarly: scholarly ? 1 : 0,
    resolved: record?.doi || record?.pdf_url || record?.oa_url || record?.url ? 1 : 0,
    richness: String(record?.abstract ?? record?.tldr ?? '').length,
    index,
  }
}

/** Highest-authority member becomes the cluster's visible representative. */
function pickRepresentative(members) {
  let best = members[0]
  for (const candidate of members.slice(1)) {
    const a = representativeScore(candidate.record, candidate.index)
    const b = representativeScore(best.record, best.index)
    if (a.citations !== b.citations) {
      if (a.citations > b.citations) best = candidate
      continue
    }
    if (a.scholarly !== b.scholarly) {
      if (a.scholarly > b.scholarly) best = candidate
      continue
    }
    if (a.resolved !== b.resolved) {
      if (a.resolved > b.resolved) best = candidate
      continue
    }
    if (a.richness !== b.richness) {
      if (a.richness > b.richness) best = candidate
      continue
    }
    if (a.index < b.index) best = candidate
  }
  return best
}

/**
 * Group records that share one originating act.
 *
 * @param {Array<object>} records search-normalized paper records
 * @param {{ titleThreshold?: number, recordId?: (record: object, index: number) => string }} options
 * @returns {{ total_records: number, independent_votes: number, clusters: Array<object>,
 *             derivative: Array<object>, params: object }}
 */
export function clusterSources(records, options = {}) {
  const titleThreshold = Number.isFinite(options.titleThreshold) ? options.titleThreshold : 0.82
  const rows = (Array.isArray(records) ? records : []).filter((record) => record && String(record.title ?? '').trim())
  const id = options.recordId ?? ((record, index) => String(record.id ?? `s${String(index + 1).padStart(4, '0')}`))

  const view = rows.map((record, index) => ({
    record,
    index,
    record_id: id(record, index),
    title: normalizeTitle(record.title),
    shingles: titleShingles(normalizeTitle(record.title)),
    host: urlHost(record.url || record.html_url || record.pdf_url || record.oa_url),
    fingerprint: bodyFingerprint(record),
    ids: new Set(workIds(record)),
  }))

  const sets = new DisjointSet(view.length)
  const reasons = view.map(() => new Set())
  for (const item of view) if (!item.title && !item.fingerprint) reasons[item.index].add('no_signal')

  for (let a = 0; a < view.length; a += 1) {
    for (let b = a + 1; b < view.length; b += 1) {
      const left = view[a]
      const right = view[b]
      // Conflicting persistent ids veto every weaker signal below.
      if (idsConflict(left.record, right.record)) continue

      let matched = null
      const sharedId = [...left.ids].find((key) => right.ids.has(key))
      if (sharedId) matched = { code: sharedId.startsWith('doi:') ? 'doi' : 'work_id', detail: sharedId }
      else if (left.title && left.title === right.title) matched = { code: 'title_exact', detail: left.title }
      else if (left.fingerprint && left.fingerprint === right.fingerprint) matched = { code: 'body_identical', detail: left.fingerprint.slice(0, 12) }
      else if (left.title.length >= 12 && right.title.length >= 12
        && jaccard(left.shingles, right.shingles) >= titleThreshold
        && (yearsCompatible(left.record, right.record) || (left.host && left.host === right.host))) {
        matched = { code: 'title_near', detail: jaccard(left.shingles, right.shingles).toFixed(2) }
      }
      if (!matched) continue

      sets.union(a, b)
      reasons[a].add(matched.code)
      reasons[b].add(matched.code)
      if (left.host && right.host && left.host !== right.host) {
        reasons[a].add('cross_host')
        reasons[b].add('cross_host')
      }
    }
  }

  const groups = new Map()
  view.forEach((item) => {
    const root = sets.find(item.index)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(item)
  })

  const clusters = [...groups.entries()].sort((x, y) => x[0] - y[0]).map(([root, members]) => {
    const best = pickRepresentative(members)
    const hosts = [...new Set(members.map((member) => member.host).filter(Boolean))].sort()
    const codes = [...new Set(members.flatMap((member) => [...reasons[member.index]]))].sort()
    return {
      cluster_id: `c${String(root + 1).padStart(4, '0')}`,
      // One originating act, however many copies arrived.
      votes: 1,
      copies: members.length,
      hosts,
      distinct_hosts: hosts.length,
      representative: {
        record_id: best.record_id,
        source: best.record.source ?? null,
        title: best.record.title,
        year: best.record.year ?? null,
        doi: normalizeDoi(best.record.doi),
        url: best.record.url || best.record.html_url || best.record.pdf_url || null,
        host: best.host,
        citation_count: citationCount(best.record.citation_count),
      },
      members: members.map((member) => ({
        record_id: member.record_id,
        source: member.record.source ?? null,
        host: member.host,
        title: member.record.title,
        year: member.record.year ?? null,
        doi: normalizeDoi(member.record.doi),
      })),
      reason_codes: codes,
    }
  })

  const derivative = clusters.filter((cluster) => cluster.copies > 1)
    .sort((x, y) => y.copies - x.copies || x.cluster_id.localeCompare(y.cluster_id))

  return {
    total_records: view.length,
    independent_votes: clusters.length,
    // Records that would have been over-counted as agreement before clustering.
    redundant_records: view.length - clusters.length,
    clusters,
    derivative,
    params: { titleThreshold },
  }
}

/**
 * Consensus guard for synthesis: how much independent support does a claim have?
 *
 * `source_count` from a raw corpus is the number a draft would quote; `votes` is
 * the number that earns it.
 */
export function independenceSummary(clustered) {
  const copies = clustered.derivative.reduce((sum, cluster) => sum + cluster.copies, 0)
  return {
    records: clustered.total_records,
    votes: clustered.independent_votes,
    clustered_copies: copies,
    clusters: clustered.derivative.length,
    // Above this, "several sources said it" is a statement about syndication.
    inflation_ratio: clustered.independent_votes ? copies / clustered.derivative.length : 0,
    max_copies_one_cluster: clustered.derivative.reduce((max, cluster) => Math.max(max, cluster.copies), 0),
  }
}
