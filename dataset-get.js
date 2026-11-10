/**
 * dataset_get: the explicit download layer over dataset_search's metadata.
 *
 * Resolves a dataset DOI through DataCite (and the Zenodo/Figshare file APIs),
 * downloads selected files into `data/<slug>/` with size caps, verifies
 * checksums, and keeps a provenance manifest under
 * `<cwd>/.dsh/data/<slug>/manifest.jsonl`. Nothing is uploaded or deposited;
 * licenses are recorded as stated, never inferred.
 */
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defineTool } from 'ah-dsh-tools'
import { NetGuardError, guardedFetch, iterateBody } from './net-guard.js'
import { canonicalDoi } from './search-normalize.js'
import { runDatasetSearch } from './dataset-search.js'
import { appendJsonl, ensureDir, hashFile, nowIso, readJsonl, slug as slugify } from './ledger-kit.js'
import { withLock } from './store-lock.js'
import { resolveWorkspacePath } from './workspace-path.js'

const ACTIONS = ['get', 'download', 'verify', 'status']
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
const HARD_MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024
// Timeouts for the default fetcher: how long to wait for headers, how long a body may go silent,
// and an overall ceiling for one file (the largest allowed file at a slow 1 MB/s is about 70 minutes).
const HEADERS_TIMEOUT_MS = 120_000
const IDLE_TIMEOUT_MS = 120_000
const FILE_DEADLINE_MS = 2 * 60 * 60 * 1000

function text(value) {
  return String(value ?? '').trim()
}

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function manifestFiles(cwd, slugValue) {
  const dir = join(cwd, '.dsh', 'data', slugify(slugValue))
  return { dir, manifest: join(dir, 'manifest.jsonl') }
}

export async function resolveDatasetRecord(doi, exec, deps = {}) {
  const search = deps.search || runDatasetSearch
  const meta = await search({ action: 'get', doi }, exec, deps)
  if (meta.error) return { error: meta.error }
  const listing = await search({ action: 'files', doi }, exec, deps)
  const dataset = meta.dataset
  if (listing.error) {
    return {
      doi,
      dataset,
      landing_url: dataset.url || `https://doi.org/${doi}`,
      repository: null,
      files: [],
      files_unavailable: true,
      files_reason: `file listing failed: ${listing.error}`,
      truncated: false,
    }
  }
  return {
    doi,
    dataset,
    landing_url: dataset.url || `https://doi.org/${doi}`,
    repository: listing.repository || null,
    files: listing.files || [],
    files_unavailable: Boolean(listing.files_unavailable),
    files_reason: listing.reason || null,
    truncated: Boolean(listing.truncated),
  }
}

function checksumAlgorithms(sourceChecksum) {
  const value = text(sourceChecksum)
  if (!value) return []
  const normalized = value.toLowerCase()
  if (normalized.startsWith('sha256:')) return [{ algorithm: 'sha256', expected: normalized.slice(7) }]
  if (normalized.startsWith('md5:')) return [{ algorithm: 'md5', expected: normalized.slice(4) }]
  const bare = normalized.replace(/^https?:\/\/[^ ]*\//, '')
  if (/^[0-9a-f]{64}$/.test(bare)) return [{ algorithm: 'sha256', expected: bare }]
  if (/^[0-9a-f]{32}$/.test(bare)) return [{ algorithm: 'md5', expected: bare }]
  return []
}

/**
 * Default fetcher: public hosts only, redirects re-checked at every hop, a header
 * timeout, an idle timeout and an overall deadline that all stay armed while the
 * body is read. A refusal is returned as `{ ok: false, error }` so one bad link
 * fails that file, not the whole batch. `fetch` and `lookup` are injectable.
 */
export async function defaultFetchBinary(url, {
  signal, timeoutMs = HEADERS_TIMEOUT_MS, idleMs = IDLE_TIMEOUT_MS, deadlineMs = FILE_DEADLINE_MS, fetch: fetchImpl, lookup,
} = {}) {
  try {
    const { response } = await guardedFetch(url, {
      signal, headersMs: timeoutMs, deadlineMs, fetch: fetchImpl, lookup, headers: { Accept: '*/*' },
    })
    if (!response.ok) {
      try { await response.body?.cancel() } catch { /* closed */ }
      return { ok: false, status: response.status, error: `HTTP ${response.status}` }
    }
    const declared = Number(response.headers.get('content-length'))
    const result = { ok: true, stream: iterateBody(response, { idleMs }) }
    if (Number.isFinite(declared) && declared > 0) result.contentLength = declared
    return result
  } catch (error) {
    if (error instanceof NetGuardError) return { ok: false, status: error.status ?? 0, error: error.message }
    throw error
  }
}

/**
 * Write a stream to `dest` as it arrives (never holding the whole file), counting
 * the bytes actually received against the per-file cap and what is left of the
 * total. The file appears at `dest` only when complete; any other outcome removes
 * the partial file.
 */
async function streamToFile(stream, dest, maxBytes, remainingTotal = Infinity) {
  ensureDir(dirname(dest))
  const part = `${dest}.part`
  const sha256 = createHash('sha256')
  const md5 = createHash('md5')
  let fd = openSync(part, 'w')
  let bytes = 0
  let complete = false
  try {
    for await (const chunk of stream) {
      bytes += chunk.byteLength
      if (bytes > maxBytes) return { tooLarge: true, bytes }
      if (bytes > remainingTotal) return { totalExceeded: true, bytes }
      const buf = Buffer.from(chunk.buffer ?? chunk, chunk.byteOffset, chunk.byteLength)
      sha256.update(buf)
      md5.update(buf)
      writeSync(fd, buf)
    }
    closeSync(fd)
    fd = null
    renameSync(part, dest)
    complete = true
    return { tooLarge: false, bytes, sha256: sha256.digest('hex'), md5: md5.digest('hex') }
  } finally {
    if (fd != null) closeSync(fd)
    if (!complete) rmSync(part, { force: true })
    if (!complete && typeof stream.cancel === 'function') await Promise.resolve(stream.cancel()).catch(() => {})
  }
}

function selectFiles(files, wanted) {
  if (!wanted || !wanted.length) return files
  const out = []
  for (const name of wanted) {
    const match = files.find((file) => file.name === name)
    if (!match) throw new Error(`"${name}" is not a file in this record`)
    out.push(match)
  }
  return out
}

export async function downloadDataset({
  cwd, slug: slugValue, record, files: wantedFiles = null,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES, maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  fetchBinary = defaultFetchBinary, signal = null,
}) {
  const f = manifestFiles(cwd, slugValue)
  const perFile = Math.min(Math.max(Number(maxFileBytes) || DEFAULT_MAX_FILE_BYTES, 1), HARD_MAX_FILE_BYTES)
  const total = Number(maxTotalBytes) || DEFAULT_MAX_TOTAL_BYTES
  const selected = selectFiles(record.files, wantedFiles)
  if (!selected.length) throw new Error('this record has no downloadable files; open the landing page')
  ensureDir(f.dir)
  return withLock(f.dir, async () => {
    const written = []
    let bytesSoFar = 0
    for (const file of selected) {
      if (!file.download_url || !/^https?:\/\//i.test(file.download_url)) {
        written.push({ name: file.name, status: 'no_url' })
        continue
      }
      const rel = join('data', slugify(slugValue), file.name.replace(/[/\\]/g, '_'))
      let dest
      try {
        dest = resolveWorkspacePath(cwd, rel, { forWrite: true })
      } catch (error) {
        written.push({ name: file.name, status: 'rejected_path', error: error instanceof Error ? error.message : String(error) })
        continue
      }
      let streamed
      try {
        const response = await fetchBinary(file.download_url, { signal })
        if (!response.ok) {
          written.push({ name: file.name, status: 'download_failed', error: response.error || `HTTP ${response.status}` })
          continue
        }
        if (bytesSoFar + (response.contentLength || 0) > total) {
          written.push({ name: file.name, status: 'total_limit_exceeded', limit_bytes: total })
          continue
        }
        streamed = await streamToFile(response.stream, dest, perFile, total - bytesSoFar)
      } catch (error) {
        if (signal?.aborted) throw error
        written.push({ name: file.name, status: 'download_failed', error: error instanceof Error ? error.message : String(error) })
        continue
      }
      if (streamed.tooLarge) {
        written.push({ name: file.name, status: 'size_limit_exceeded', limit_bytes: perFile })
        continue
      }
      if (streamed.totalExceeded) {
        written.push({ name: file.name, status: 'total_limit_exceeded', limit_bytes: total })
        continue
      }
      bytesSoFar += streamed.bytes
      const checks = checksumAlgorithms(file.checksum)
      let verification = 'no_checksum'
      if (checks.length) {
        const [check] = checks
        verification = (check.algorithm === 'sha256' ? streamed.sha256 : streamed.md5) === check.expected
          ? 'verified'
          : 'verification_failed'
      }
      written.push({
        name: file.name,
        path: rel,
        url: file.download_url,
        bytes: streamed.bytes,
        sha256: `sha256:${streamed.sha256}`,
        source_checksum: text(file.checksum) || null,
        verification,
        status: 'downloaded',
      })
    }
    const event = {
      kind: 'download',
      ts: nowIso(),
      slug: slugify(slugValue),
      doi: record.doi,
      version: record.dataset?.version || null,
      license: record.dataset?.license || null,
      license_stated: Boolean(record.dataset?.license),
      landing_page: record.landing_url,
      repository: record.repository,
      files: written,
    }
    appendJsonl(f.manifest, [event])
    return event
  }, { label: 'dataset manifest' })
}

export function verifyDataset(cwd, slugValue) {
  const f = manifestFiles(cwd, slugValue)
  const events = readJsonl(f.manifest).filter((event) => event.kind === 'download')
  if (!events.length) throw new Error(`no downloads recorded for dataset "${slugify(slugValue)}"`)
  const latest = events.at(-1)
  const results = latest.files.map((entry) => {
    if (entry.status !== 'downloaded') return { name: entry.name, status: entry.status }
    let abs
    try {
      abs = resolveWorkspacePath(cwd, entry.path)
    } catch {
      return { name: entry.name, path: entry.path, status: 'path_escape' }
    }
    if (!existsSync(abs)) return { name: entry.name, path: entry.path, status: 'missing' }
    const actual = `sha256:${hashFile(abs)}`
    const checks = checksumAlgorithms(entry.source_checksum)
    let status = actual === entry.sha256 ? 'ok' : 'changed'
    if (status === 'ok' && checks.length && checks[0].algorithm === 'md5') {
      status = 'ok_no_source_sha256'
    }
    return { name: entry.name, path: entry.path, status, recorded: entry.sha256, actual }
  })
  return {
    slug: latest.slug,
    doi: latest.doi,
    downloaded_at: latest.ts,
    files: results,
    ok: results.filter((entry) => entry.status.startsWith('ok')).length,
    problems: results.filter((entry) => !entry.status.startsWith('ok') && entry.status !== 'no_url'),
  }
}

export function datasetStatus(cwd, slugValue) {
  const f = manifestFiles(cwd, slugValue)
  const events = readJsonl(f.manifest).filter((event) => event.kind === 'download')
  return {
    slug: slugify(slugValue),
    dir: f.dir.slice(cwd.length + 1),
    downloads: events.length,
    latest: events.at(-1)
      ? {
        doi: events.at(-1).doi,
        ts: events.at(-1).ts,
        license: events.at(-1).license,
        license_stated: events.at(-1).license_stated,
        files: events.at(-1).files.length,
        bytes: events.at(-1).files.reduce((sum, file) => sum + (file.bytes || 0), 0),
        missing_checksums: events.at(-1).files.filter((file) => file.status === 'downloaded' && !file.source_checksum).length,
        failed: events.at(-1).files.filter((file) => file.status !== 'downloaded' || file.verification === 'verification_failed').map((file) => `${file.name}: ${file.verification || file.status}`),
      }
      : null,
  }
}

function renderValue(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (value.action === 'get') {
    const r = value.record
    const lines = [
      `${r.dataset.title || '(untitled)'} — ${r.repository || 'DataCite record'}`,
      `DOI: ${r.doi}${r.dataset.version ? ` · version ${r.dataset.version}` : ''}`,
      `License: ${r.dataset.license || 'not stated in the record — do not assume one'}`,
      `Landing page: ${r.landing_url}`,
    ]
    if (r.files_unavailable) lines.push(`Files: unavailable (${r.files_reason})`)
    else lines.push(`Files: ${r.files.length}${r.truncated ? '+ (first 100)' : ''}`, ...r.files.map((file) => `- ${file.name}${file.size != null ? ` (${file.size} bytes)` : ''}${file.checksum ? ` · ${file.checksum}` : ''}`))
    return [{ type: 'text', text: lines.join('\n') }]
  }
  if (value.action === 'download') {
    const lines = [`Downloaded ${value.event.files.filter((file) => file.status === 'downloaded').length}/${value.event.files.length} file(s) for ${value.event.doi} into data/${value.event.slug}/`]
    if (!value.event.license_stated) lines.push('License is not stated in the record — verify before redistribution.')
    for (const file of value.event.files) {
      lines.push(`- ${file.name}: ${file.status === 'downloaded' ? `${file.bytes} bytes · ${file.verification}` : file.status}${file.error ? ` (${file.error})` : ''}`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }
  if (value.action === 'verify') {
    const lines = [`Verify ${value.result.doi} (${value.result.downloaded_at}):`]
    for (const file of value.result.files) lines.push(`- ${file.name}: ${file.status}`)
    lines.push('Verification compares recorded and source checksums; it does not vouch for the data itself.')
    return [{ type: 'text', text: lines.join('\n') }]
  }
  if (value.action === 'status') {
    const s = value.status
    if (!s.latest) return [{ type: 'text', text: `Dataset "${s.slug}": no downloads recorded yet.` }]
    return [{ type: 'text', text: [
      `Dataset "${s.slug}" at ${s.dir} — ${s.downloads} download event(s).`,
      `Latest: ${s.latest.doi} · ${s.latest.ts} · ${s.latest.files} file(s) · ${s.latest.bytes} bytes`,
      `License: ${s.latest.license || 'not stated'}`,
      s.latest.missing_checksums ? `Missing checksums: ${s.latest.missing_checksums}` : null,
      s.latest.failed.length ? `Problems: ${s.latest.failed.join('; ')}` : null,
    ].filter(Boolean).join('\n') }]
  }
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

export async function runDatasetGet(args, exec, deps = {}) {
  const action = args.action || 'status'
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)

  if (action === 'get' || action === 'download') {
    const doi = canonicalDoi(args.doi)
    if (!doi) throw new Error('doi is required (e.g. 10.5281/zenodo.1234567)')
    const record = await resolveDatasetRecord(doi, exec, deps)
    if (record.error) throw new Error(record.error)
    if (action === 'get') return { action, record }
    if (record.files_unavailable) throw new Error(`no downloadable files for ${doi}: ${record.files_reason}`)
    const slug = text(args.slug) || doi.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()
    const event = await downloadDataset({
      cwd,
      slug,
      record,
      files: Array.isArray(args.files) ? args.files : null,
      maxFileBytes: args.max_bytes_per_file,
      maxTotalBytes: args.max_total_bytes,
      fetchBinary: deps.fetchBinary || defaultFetchBinary,
      signal: exec?.signal,
    })
    return { action, slug, event }
  }

  const slug = text(args.slug)
  if (!slug) throw new Error('slug is required for verify/status')
  if (action === 'verify') return { action, result: verifyDataset(cwd, slug) }
  return { action, status: datasetStatus(cwd, slug) }
}

export const name = 'academic-harness-dataset-get'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'dataset_get',
    description: [
      'Download research datasets with provenance. `get` resolves a DOI through DataCite (with Zenodo/Figshare file listings) and returns files, sizes, checksums, and licenses without downloading. `download` fetches selected files into `data/<slug>/` with per-file and total size caps, verifies checksums when the record supplies them (a mismatch is recorded as verification_failed and the file kept for inspection), and appends a manifest under `.dsh/data/<slug>/`. `verify` re-hashes the latest download against the manifest; `status` summarizes downloads, sizes, licenses, and missing checksums.',
      'dataset_search stays search-only; this is the explicit download layer. Unknown licenses are flagged as not stated, never guessed. No authentication is forwarded to download URLs, no deposit or DOI minting happens here, and paths are confined to the workspace.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ACTIONS, description: 'get, download, verify, or status. Default status.' },
      doi: { type: 'string', description: 'Dataset DOI (get/download), e.g. 10.5281/zenodo.1234567.' },
      slug: { type: 'string', description: 'Local slug; defaults to a DOI-derived name (download/verify/status).' },
      files: { type: 'array', items: { type: 'string' }, description: 'Exact file names to download (default: all listed files).' },
      max_bytes_per_file: { type: 'number', description: 'Per-file cap in bytes (default 512MB, hard max 4GB).' },
      max_total_bytes: { type: 'number', description: 'Total cap per download event (default 2GB).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return await runDatasetGet(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Dataset ${args.action || 'status'}: ${args.doi || args.slug || ''}`, kind: 'search' }
    },
  }))
}
