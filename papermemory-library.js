/**
 * Calls into the PaperMemory reference library (`papermemory library ...`) from the
 * harness tools that need it: `citation` (library as a record source),
 * `manuscript_citations`, `literature_search`, and `integrity_check`.
 *
 * Every call is local (the PaperMemory CLI and its SQLite store), non-throwing, and
 * says plainly when the library is unavailable. An unavailable library is never
 * reported as an empty one.
 */
import { cliArgs, papermemoryEnv, resolvePaperMemoryLaunch, run } from './papermemory-cli.js'

const LIBRARY_TIMEOUT_MS = 60_000
const REFS_PER_CALL = 100
const ITEMS_PER_CALL = 100

function parseJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try { return JSON.parse(raw.slice(start, end + 1)) } catch { /* fall through */ }
    }
    return undefined
  }
}

/** True when `papermemory` is installed and new enough to have a library. Never installs anything. */
export function libraryLaunch() {
  return resolvePaperMemoryLaunch()
}

/**
 * Run `papermemory library <args> --json`.
 * @returns {Promise<{ ok: true, data: any } | { ok: false, code: string, error: string }>}
 */
export async function libraryCli(args, { cwd, signal, timeoutMs = LIBRARY_TIMEOUT_MS, launch = libraryLaunch() } = {}) {
  if (!launch) return { ok: false, code: 'unavailable', error: 'PaperMemory is not installed' }
  const result = await run(launch.command, cliArgs(launch, ['library', ...args, '--json']), {
    cwd, timeoutMs, env: papermemoryEnv(), signal, silent: true,
  })
  if (result.code === 0) {
    const data = parseJson(result.out)
    return data === undefined
      ? { ok: false, code: 'bad-output', error: 'PaperMemory returned output that is not JSON' }
      : { ok: true, data }
  }
  const text = `${result.err || ''}\n${result.out || ''}`
  if (/invalid choice: 'library'|No such command|unrecognized arguments: library/i.test(text)) {
    return { ok: false, code: 'library-unavailable', error: 'the installed PaperMemory has no reference library (needs 0.3.0 or newer)' }
  }
  if (/migration-required/.test(text)) {
    return { ok: false, code: 'migration-required', error: 'the PaperMemory database needs `papermemory migrate`' }
  }
  const parsed = parseJson(result.out) || parseJson(result.err)
  let code = 'error'
  let detail = text.trim()
  if (parsed && typeof parsed.error === 'string') {
    // {"error": "<code>", "message": "..."} from export, or {"error": "<message>", "code": "<code>"} elsewhere
    code = parsed.code || (parsed.message ? parsed.error : 'error')
    detail = parsed.message || parsed.error
  } else {
    const named = /library [\w-]+: ([a-z0-9-]+): /i.exec(text)
    if (named) code = named[1]
  }
  return { ok: false, code, error: detail.replace(/\s+/g, ' ').slice(0, 300) || `papermemory exited ${result.code}` }
}

/** The library's papers as CSL-JSON records, each carrying the key it would be exported under. */
export async function libraryRecords(scope = {}, { cwd, signal } = {}) {
  const args = ['export', '--format', 'csl-json']
  if (scope.collection) args.push('--collection', scope.collection)
  if (scope.project) args.push('--project', scope.project)
  if (scope.cited_only) args.push('--cited-only', scope.cited_only)
  if (scope.variant) args.push('--variant', scope.variant)
  if (scope.all) args.push('--all')
  const query = Array.isArray(scope.query) ? scope.query : (scope.query ? String(scope.query).split(/\s+/).filter(Boolean) : [])
  args.push(...query)
  const result = await libraryCli(args, { cwd, signal })
  if (!result.ok) return result
  let records
  try {
    records = JSON.parse(result.data.text)
  } catch {
    return { ok: false, code: 'bad-output', error: 'library export did not return CSL-JSON' }
  }
  return { ok: true, records, warnings: result.data.warnings || [], missing_keys: result.data.missing_keys || [] }
}

/** Which of these keys / DOIs / ids are in the library (a project's own keys win). Batches large lists. */
export async function libraryResolve(refs, { project, projectKeys = false, cwd, signal } = {}) {
  const unique = [...new Set(refs.map((ref) => String(ref || '').trim()).filter(Boolean))]
  const results = []
  let keys
  for (let start = 0; start < Math.max(unique.length, 1); start += REFS_PER_CALL) {
    const chunk = unique.slice(start, start + REFS_PER_CALL)
    if (!chunk.length && !projectKeys) break
    const args = ['resolve', ...(chunk.length ? chunk : ['-'])]
    if (project) args.push('--project', project)
    if (projectKeys && start === 0) args.push('--project-keys')
    const result = await libraryCli(args, { cwd, signal })
    if (!result.ok) return result
    results.push(...result.data.results.filter((r) => chunk.includes(r.ref)))
    if (result.data.project_keys) keys = result.data.project_keys
  }
  return { ok: true, results, project_keys: keys }
}

/** Record retraction / correction results (from `integrity_check`) on library papers. */
export async function librarySetIntegrity(items, { cwd, signal } = {}) {
  const totals = { written: 0, unresolved: [], rejected: [] }
  for (let start = 0; start < items.length; start += ITEMS_PER_CALL) {
    const result = await libraryCli(
      ['integrity', 'set', '--items-json', JSON.stringify(items.slice(start, start + ITEMS_PER_CALL))],
      { cwd, signal },
    )
    if (!result.ok) return { ...result, ...totals }
    totals.written += result.data.written
    totals.unresolved.push(...result.data.unresolved)
    totals.rejected.push(...result.data.rejected)
  }
  return { ok: true, ...totals }
}

/** Library papers with their DOIs, for sweeps. `query` uses the library filter syntax. */
export async function libraryPapers(query, { cwd, signal, limit = 200, cursor } = {}) {
  const args = ['list', ...(Array.isArray(query) ? query : (query ? String(query).split(/\s+/).filter(Boolean) : []))]
  args.push('--limit', String(limit))
  if (cursor) args.push('--cursor', cursor)
  return await libraryCli(args, { cwd, signal })
}
