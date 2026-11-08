/**
 * Lookup snapshot: a frozen copy of the registry answers an audit used.
 *
 * Crossref and OpenAlex answers drive the citation and integrity findings. When each audit asks them
 * again, a timeout, a rate limit or a quiet upstream edit changes the findings with no change to the
 * manuscript. The snapshot makes the audit read what it read last time:
 *
 *   - a definitive answer (2xx, or 404 "no such DOI") is stored under .ah/cache/lookups.json and reused;
 *   - a failure (timeout, 429, 5xx) is never stored. With no earlier answer it comes back as the failure
 *     it was, which the callers already report as "unverified", never as a finding; with an earlier answer
 *     the earlier answer is served, so a network outage cannot change what the audit says;
 *   - a new fetch happens only for a key not yet stored, an entry older than the maximum age, or when the
 *     caller asks to refresh. The age of what was used is reported (`asof`), so a stale snapshot is visible.
 *
 * Plain JSON with an atomic rename: no native dependency, readable by the Python engine, diff-friendly.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fetchJson as defaultFetchJson } from './search-http.js'

export const SNAPSHOT_VERSION = 1
export const DEFAULT_MAX_AGE_DAYS = 30
export const SNAPSHOT_RELATIVE = join('.ah', 'cache', 'lookups.json')

/** Only registries whose answers drive findings are frozen; every other URL goes straight through. */
const CACHED_HOSTS = new Set(['api.crossref.org', 'api.openalex.org'])
/** Credentials and politeness parameters never change the answer and must never reach the file. */
const VOLATILE_PARAMS = new Set(['mailto', 'api_key', 'apikey'])
const DAY_MS = 86_400_000

/** Identity of a request: host, lower-cased path, and the answer-relevant query parameters, sorted. */
export function lookupKey(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!CACHED_HOSTS.has(parsed.hostname)) return null
  const params = [...parsed.searchParams.entries()]
    .filter(([name]) => !VOLATILE_PARAMS.has(name.toLowerCase()))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)))
  const query = params.map(([name, value]) => `${name}=${value}`).join('&')
  let path = parsed.pathname
  try {
    path = decodeURIComponent(path)
  } catch {
    // malformed escape: key on the raw path
  }
  return `${parsed.hostname}${path.toLowerCase()}${query ? `?${query}` : ''}`
}

/** What is stored: the answer minus the bulk nothing reads (a work's full reference list). */
function slim(data) {
  if (data && typeof data === 'object' && data.message && typeof data.message === 'object' && 'reference' in data.message) {
    const { reference, ...message } = data.message
    return { ...data, message }
  }
  return data
}

function definitive(result) {
  return Boolean(result) && (result.ok === true || result.status === 404)
}

function fromEntry(entry, { stale = false } = {}) {
  const base = entry.status === 404
    ? { ok: false, status: 404, error: 'HTTP 404', data: entry.data }
    : { ok: true, status: entry.status, data: entry.data }
  return { ...base, snapshot: { cached: true, stale, fetched_at: entry.fetched_at } }
}

function readFile(path) {
  if (!existsSync(path)) return { entries: {} }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { entries: {}, error: `unreadable (${error instanceof Error ? error.message : error}); it will be rebuilt` }
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object' || parsed.entries === null) {
    return { entries: {}, error: 'unrecognised layout; it will be rebuilt' }
  }
  if (parsed.version !== SNAPSHOT_VERSION) {
    // Written by a different version: read nothing, and do not overwrite it.
    return { entries: {}, error: `version ${parsed.version} is not ${SNAPSHOT_VERSION}; not used and not overwritten`, readonly: true }
  }
  return { entries: parsed.entries }
}

/**
 * @param {string|null} root workspace root; null keeps the snapshot in memory for this call only
 * @param {object} [options]
 * @param {Function} [options.base] the real fetchJson (injected in tests)
 * @param {boolean} [options.refresh] fetch every key again; an earlier answer is kept if the fetch fails
 * @param {number} [options.maxAgeDays] reuse an answer at most this old; 0 never expires. Default 30.
 * @param {() => number} [options.now] clock
 */
export function openSnapshot(root, options = {}) {
  const base = options.base || defaultFetchJson
  const now = options.now || Date.now
  const refresh = options.refresh === true
  const maxAgeDays = Number.isFinite(Number(options.maxAgeDays)) && options.maxAgeDays !== null && options.maxAgeDays !== undefined
    ? Math.max(0, Number(options.maxAgeDays))
    : DEFAULT_MAX_AGE_DAYS
  const maxAgeMs = maxAgeDays > 0 ? maxAgeDays * DAY_MS : Infinity
  const path = root ? join(root, SNAPSHOT_RELATIVE) : null

  const loaded = path ? readFile(path) : { entries: {} }
  const entries = new Map(Object.entries(loaded.entries))
  const persist = Boolean(path) && !loaded.readonly
  const touched = new Map()
  const pending = new Map()
  const counts = { hits: 0, fetched: 0, refreshed: 0, served_stale: 0, failed: 0 }
  let dirty = false
  let writeError = null

  const expired = (entry) => now() - Date.parse(entry.fetched_at) > maxAgeMs

  /** The stored answer for this request when one may be reused, else null. Costs no network and no pacing. */
  function peek(url) {
    const key = lookupKey(url)
    const entry = key ? entries.get(key) : null
    if (!entry || refresh || expired(entry)) return null
    counts.hits += 1
    touched.set(key, entry.fetched_at)
    return fromEntry(entry)
  }

  async function lookup(url, requestOptions) {
    const key = lookupKey(url)
    if (!key) return base(url, requestOptions)
    const hit = peek(url)
    if (hit) return hit
    const entry = entries.get(key)
    if (pending.has(key)) return pending.get(key)
    const job = (async () => {
      const result = await base(url, requestOptions)
      if (definitive(result)) {
        const stored = { status: result.status, fetched_at: new Date(now()).toISOString(), data: slim(result.data) }
        entries.set(key, stored)
        touched.set(key, stored.fetched_at)
        dirty = true
        if (entry) counts.refreshed += 1
        else counts.fetched += 1
        return fromEntry(stored)
      }
      counts.failed += 1
      if (entry) {
        counts.served_stale += 1
        touched.set(key, entry.fetched_at)
        return fromEntry(entry, { stale: true })
      }
      return result
    })().finally(() => pending.delete(key))
    pending.set(key, job)
    return job
  }

  /** Write back what changed, merging with whatever another process wrote meanwhile (newer answer wins). */
  function flush() {
    if (!persist || !dirty) return { written: false }
    try {
      const onDisk = readFile(path)
      if (onDisk.readonly) return { written: false }
      const merged = { ...onDisk.entries }
      for (const [key, entry] of entries) {
        const other = merged[key]
        if (!other || Date.parse(entry.fetched_at) >= Date.parse(other.fetched_at)) merged[key] = entry
      }
      const sorted = Object.fromEntries(Object.keys(merged).sort().map((key) => [key, merged[key]]))
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      try {
        writeFileSync(tmp, `${JSON.stringify({ version: SNAPSHOT_VERSION, entries: sorted }, null, 1)}\n`)
        renameSync(tmp, path)
      } catch (error) {
        try { unlinkSync(tmp) } catch { /* nothing to clean */ }
        throw error
      }
      dirty = false
      return { written: true }
    } catch (error) {
      writeError = error instanceof Error ? error.message : String(error)
      return { written: false, error: writeError }
    }
  }

  /** What this run used. `asof` is the oldest answer used, so a mix is reported at its weakest. */
  function stats() {
    const times = [...touched.values()].sort()
    return {
      path: persist ? SNAPSHOT_RELATIVE : null,
      persisted: persist,
      max_age_days: maxAgeDays,
      refresh,
      ...counts,
      entries_used: touched.size,
      asof: times[0] || null,
      newest: times[times.length - 1] || null,
      ...(loaded.error ? { load_note: loaded.error } : {}),
      ...(writeError ? { write_error: writeError } : {}),
    }
  }

  lookup.peek = peek
  return { fetchJson: lookup, flush, stats }
}

/**
 * Run a request through a provider's rate limiter, except when the snapshot already holds the answer:
 * a stored answer needs no pacing, so a warm audit is not as slow as a cold one.
 */
export async function pacedFetch(http, limiter, url, options) {
  const hit = typeof http.peek === 'function' ? http.peek(url) : null
  return hit || limiter.run(() => http(url, options))
}

/** Snapshot controls shared by every tool that offers them. */
export function snapshotOptions(args = {}) {
  return {
    refresh: args.refresh_lookups === true,
    maxAgeDays: args.lookup_max_age_days,
  }
}

export const SNAPSHOT_PARAMETERS = {
  refresh_lookups: {
    type: 'boolean',
    description: 'Fetch Crossref/OpenAlex answers again instead of reusing the snapshot in .ah/cache/lookups.json. An earlier answer is kept if the fetch fails. Default false: the same references give the same findings until the snapshot is refreshed.',
  },
  lookup_max_age_days: {
    type: 'number',
    description: 'Reuse a snapshot answer at most this many days old, then fetch it again. Default 30; 0 never expires.',
  },
}
