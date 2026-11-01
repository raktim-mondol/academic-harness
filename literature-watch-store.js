/**
 * Saved-search ledger under `<cwd>/.dsh/watch/`.
 *
 *   watches.jsonl  append-only add/remove events (the live set is derived)
 *   seen.jsonl     one row per record first seen by a watch (the dedupe set)
 *   hits.jsonl     the new records themselves, with the query that found them
 *   runs.jsonl     one row per watch per run, including per-source failures
 *   digests.jsonl  when a digest was last cut, so the next one shows only newer hits
 *
 * Nothing is edited in place and nothing is ingested into PaperMemory. A record
 * is "new" only relative to this ledger; it is not a judgement about relevance.
 */
import { join } from 'node:path'
import { appendJsonl, ensureDir, nowIso, readJsonl, shortHash, slug as slugify } from './ledger-kit.js'
import { withLock } from './store-lock.js'
import { canonicalDoi, normalizeTitle } from './search-normalize.js'

export const WATCH_ACTIONS = ['add', 'list', 'remove', 'run', 'digest', 'status']
export const WATCH_FREQUENCIES = ['manual', 'daily', 'weekly', 'monthly']
const FREQUENCY_MS = { daily: 86_400_000, weekly: 7 * 86_400_000, monthly: 30 * 86_400_000 }

export function watchDir(cwd) {
  return join(cwd, '.dsh', 'watch')
}

function file(cwd, name) {
  return join(watchDir(cwd), name)
}

/** Stable identity for "have we seen this record": DOI, then other ids, then title+year. */
export function recordKey(paper) {
  const doi = canonicalDoi(paper?.doi)
  if (doi) return `doi:${doi}`
  if (paper?.arxiv_id) return `arxiv:${String(paper.arxiv_id).toLowerCase()}`
  if (paper?.pmid) return `pmid:${paper.pmid}`
  if (paper?.openalex_id) return `openalex:${String(paper.openalex_id).toLowerCase()}`
  const title = normalizeTitle(paper?.title || '')
  return title ? `title:${shortHash(`${title}|${paper?.year || ''}`, 16)}` : ''
}

/** The live watches: add events minus later removes. */
export function listWatches(cwd) {
  const live = new Map()
  for (const row of readJsonl(file(cwd, 'watches.jsonl'))) {
    if (row.event === 'add') live.set(row.id, row)
    else if (row.event === 'remove') live.delete(row.id)
  }
  return [...live.values()]
}

export function getWatch(cwd, ref) {
  const wanted = String(ref || '').trim()
  return listWatches(cwd).find((watch) => watch.id === wanted || watch.name === wanted) || null
}

export async function addWatch({ cwd, input, recordedBy }) {
  const name = String(input.name || '').trim()
  const query = String(input.query || '').trim()
  if (!name) throw new Error('name is required')
  if (!query) throw new Error('query is required')
  const frequency = input.frequency || 'manual'
  if (!WATCH_FREQUENCIES.includes(frequency)) throw new Error(`frequency must be one of ${WATCH_FREQUENCIES.join(', ')}`)
  const id = `watch-${slugify(name, 40) || shortHash(name, 8)}`
  ensureDir(watchDir(cwd))
  return withLock(watchDir(cwd), async () => {
    if (listWatches(cwd).some((watch) => watch.id === id)) {
      throw new Error(`a watch named "${name}" already exists (${id}); remove it first or pick another name`)
    }
    const row = {
      event: 'add',
      id,
      name,
      query,
      sources: Array.isArray(input.sources) && input.sources.length ? input.sources.map(String) : null,
      year_min: input.year_min ?? null,
      year_max: input.year_max ?? null,
      open_access_only: Boolean(input.open_access_only),
      since: input.since || null,
      frequency,
      max_results: Math.min(Math.max(Number(input.max_results) || 25, 1), 100),
      notes: input.notes || '',
      added_at: nowIso(),
      recorded_by: recordedBy || null,
    }
    appendJsonl(file(cwd, 'watches.jsonl'), [row])
    return row
  }, { label: 'watch' })
}

export async function removeWatch({ cwd, ref, recordedBy }) {
  const watch = getWatch(cwd, ref)
  if (!watch) throw new Error(`no watch "${ref}"`)
  return withLock(watchDir(cwd), async () => {
    appendJsonl(file(cwd, 'watches.jsonl'), [{ event: 'remove', id: watch.id, removed_at: nowIso(), recorded_by: recordedBy || null }])
    return watch
  }, { label: 'watch' })
}

export function seenKeys(cwd, watchId) {
  return new Set(readJsonl(file(cwd, 'seen.jsonl')).filter((row) => row.watch_id === watchId).map((row) => row.key))
}

/** Compact record kept in the ledger; abstracts and author lists are not stored. */
export function compactRecord(paper) {
  return {
    title: paper.title || '',
    doi: canonicalDoi(paper.doi) || null,
    year: paper.year ?? null,
    venue: paper.venue || paper.journal || null,
    authors: (paper.authors || []).slice(0, 3).map((a) => (typeof a === 'string' ? a : a?.name || '')).filter(Boolean),
    url: paper.url || (paper.doi ? `https://doi.org/${paper.doi}` : null),
    sources: paper.sources || (paper.source ? [paper.source] : []),
  }
}

/**
 * Record one watch's run. `fresh` are papers whose key is not in seen.jsonl; they are
 * written to seen + hits atomically with the run row.
 */
export async function recordRun({ cwd, watch, runId, fresh, total, failures, sources, ranAt = nowIso() }) {
  return withLock(watchDir(cwd), async () => {
    const rows = fresh.map((paper) => ({ watch_id: watch.id, key: recordKey(paper), first_seen: ranAt }))
    appendJsonl(file(cwd, 'seen.jsonl'), rows)
    appendJsonl(file(cwd, 'hits.jsonl'), fresh.map((paper) => ({
      watch_id: watch.id,
      run_id: runId,
      key: recordKey(paper),
      found_at: ranAt,
      query: watch.query,
      sources: paper.sources || [],
      record: compactRecord(paper),
    })))
    const status = failures.length === 0 ? 'ok' : (failures.length >= sources.length ? 'failed' : 'partial')
    const run = {
      run_id: runId,
      watch_id: watch.id,
      ran_at: ranAt,
      status,
      sources,
      total,
      new: fresh.length,
      failures,
    }
    appendJsonl(file(cwd, 'runs.jsonl'), [run])
    return run
  }, { label: 'watch' })
}

export function lastRuns(cwd) {
  const latest = new Map()
  for (const row of readJsonl(file(cwd, 'runs.jsonl'))) latest.set(row.watch_id, row)
  return latest
}

export function isDue(watch, lastRun, now = Date.now()) {
  if (watch.frequency === 'manual' || !FREQUENCY_MS[watch.frequency]) return true
  if (!lastRun) return true
  return now - Date.parse(lastRun.ran_at) >= FREQUENCY_MS[watch.frequency]
}

export function readHits(cwd) {
  return readJsonl(file(cwd, 'hits.jsonl'))
}

export function lastDigestAt(cwd, scope) {
  let latest = null
  for (const row of readJsonl(file(cwd, 'digests.jsonl'))) {
    if (row.scope === scope) latest = row.cut_at
  }
  return latest
}

export async function markDigest({ cwd, scope, count }) {
  return withLock(watchDir(cwd), async () => {
    appendJsonl(file(cwd, 'digests.jsonl'), [{ scope, cut_at: nowIso(), count }])
  }, { label: 'watch' })
}
