/**
 * PaperMemory CLI resolution, first-run install, and a small spawn helper.
 * Shared by the MCP mount (papermemory.js) and paper_download auto-ingest.
 * Keep inject: [] consumers importing this file — do not put inject: ['tools']
 * on the MCP row (same stall as zvec-grep.js).
 *
 * Search/cite/ingest surface over stdio MCP (`papermemory mcp`). The store is
 * the default PaperMemory DB (~/.local/share/papermemory/papermemory.db) so a
 * standalone CLI and Academic Harness share the same academic memory.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000
const INIT_TIMEOUT_MS = 20 * 1000
const INGEST_TIMEOUT_MS = 90 * 1000
const BIN_NAMES = process.platform === 'win32' ? ['papermemory.exe', 'papermemory.cmd', 'papermemory'] : ['papermemory']
const UV_BIN = process.platform === 'win32' ? 'uv.exe' : 'uv'
const PYTHON_BINS = process.platform === 'win32' ? ['python.exe', 'python'] : ['python3', 'python']

export const LOG = '[academic-harness] papermemory'
export const MIN_PAPERMEMORY_VERSION = '0.2.1'
/** Bump when the vendored tree changes without a pyproject version bump. */
const BUNDLE_REV = 'dsh15'

const HERE = dirname(fileURLToPath(import.meta.url))

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** Plugin-managed venv prefix under $DSH_HOME/papermemory. */
export function bundledInstallDir() {
  return join(dshHome(), 'papermemory')
}

export function vendorDir() {
  return join(HERE, 'vendor', 'papermemory')
}

function bundledPython() {
  return process.platform === 'win32'
    ? join(bundledInstallDir(), '.venv', 'Scripts', 'python.exe')
    : join(bundledInstallDir(), '.venv', 'bin', 'python')
}

function bundledBin() {
  return process.platform === 'win32'
    ? join(bundledInstallDir(), '.venv', 'Scripts', 'papermemory.exe')
    : join(bundledInstallDir(), '.venv', 'bin', 'papermemory')
}

function versionStampPath() {
  return join(bundledInstallDir(), 'installed-version')
}

function launchFromCommand(command) {
  return { command, args: [], cli: [command] }
}

export function vendoredVersion() {
  try {
    const text = readFileSync(join(vendorDir(), 'pyproject.toml'), 'utf8')
    const m = text.match(/^version\s*=\s*"([^"]+)"/m)
    return m ? m[1] : MIN_PAPERMEMORY_VERSION
  } catch {
    return MIN_PAPERMEMORY_VERSION
  }
}

function wantStamp() {
  return `${vendoredVersion()}+${BUNDLE_REV}`
}

export function bundledInstalledVersion() {
  try {
    const v = readFileSync(versionStampPath(), 'utf8').trim()
    return v.length > 0 ? v : undefined
  } catch {
    return undefined
  }
}

function parseSemver(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

export function versionAtLeast(have, want) {
  const a = parseSemver(have)
  const b = parseSemver(want)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true
    if (a[i] < b[i]) return false
  }
  return true
}

function findOnPath() {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    for (const bin of BIN_NAMES) {
      const candidate = join(dir, bin)
      if (existsSync(candidate)) return launchFromCommand(candidate)
    }
  }
  return undefined
}

function findBundled() {
  const bin = bundledBin()
  if (existsSync(bin)) return launchFromCommand(bin)
  const py = bundledPython()
  if (existsSync(py)) return { command: py, args: ['-m', 'papermemory'], cli: [py, '-m', 'papermemory'] }
  return undefined
}

function findUv() {
  const override = process.env.UV?.trim()
  if (override) return override
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, UV_BIN)
    if (existsSync(candidate)) return candidate
  }
  for (const candidate of [
    join(homedir(), '.local', 'bin', UV_BIN),
    join(homedir(), '.cargo', 'bin', UV_BIN),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function findPython() {
  const override = process.env.ACADEMIC_HARNESS_PYTHON?.trim()
    || process.env.RESEARCHCRAFT_PYTHON?.trim()
  if (override) return override
  for (const name of PYTHON_BINS) {
    for (const dir of (process.env.PATH || '').split(delimiter)) {
      if (!dir) continue
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return PYTHON_BINS[0]
}

/**
 * Resolve how DSH should spawn the papermemory CLI.
 * Order: PAPERMEMORY_CLI, the plugin-managed venv (vendored MCP with NDJSON
 * stdio), then PATH. PATH binaries may still speak Content-Length-only MCP,
 * which deadlocks DSH's MCP SDK — prefer the bundled copy.
 */
export function resolvePaperMemoryLaunch() {
  const override = process.env.PAPERMEMORY_CLI?.trim()
  if (override) return launchFromCommand(override)
  const bundled = findBundled()
  if (bundled) return bundled
  const onPath = findOnPath()
  return onPath ? { ...onPath, readOnly: true } : undefined
}

export function run(command, args, { cwd, timeoutMs, env, signal, silent } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout?.on('data', (buf) => {
      const text = buf.toString()
      out += text
      if (!silent) process.stderr.write(text)
    })
    child.stderr?.on('data', (buf) => {
      const text = buf.toString()
      err += text
      if (!silent) process.stderr.write(text)
    })
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolvePromise({ code: code ?? 1, out, err, pid: child.pid })
    }
    const onAbort = () => {
      try { child.kill('SIGINT') } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGTERM') } catch { /* ignore */ } }, 1500)
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, 4000)
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const timer = timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM')
          finish(124)
        }, timeoutMs)
      : null
    child.on('close', (code) => finish(code ?? 1))
    child.on('error', (error) => {
      err += error.message
      finish(1)
    })
  })
}

export function cliArgs(launch, rest) {
  return [...launch.args, ...rest]
}

export function papermemoryEnv(extra = {}) {
  const env = { ...process.env, PYTHONUNBUFFERED: '1', ...extra }
  return env
}

function specWithPdf(dir) {
  // pip/uv extras need the path quoted as a single argv token.
  return `${dir}[pdf]`
}

async function installedVersion(launch) {
  try {
    const result = await run(launch.command, cliArgs(launch, ['version', '--json']), {
      timeoutMs: INIT_TIMEOUT_MS,
      silent: true,
    })
    const parsed = parseJsonOutput(result.out)
    return parsed?.version
  } catch {
    return undefined
  }
}

async function installBundled() {  const dir = bundledInstallDir()
  const vendor = vendorDir()
  if (!existsSync(join(vendor, 'pyproject.toml'))) {
    console.warn(`${LOG}: vendored package missing at ${vendor}`)
    return undefined
  }
  mkdirSync(dir, { recursive: true })
  const want = vendoredVersion()
  console.warn(`${LOG}: installing papermemory ${want} into ${dir} (first run; includes pypdf)`)

  const uv = findUv()
  let result = { code: 1, out: '', err: '' }
  if (uv) {
    result = await run(uv, ['venv', '--clear', join(dir, '.venv')], {
      cwd: dir,
      timeoutMs: INSTALL_TIMEOUT_MS,
      silent: true,
    })
    if (result.code !== 0) {
      console.warn(`${LOG}: uv venv failed (exit ${result.code}): ${(result.err || result.out).trim()}`)
    } else {
      result = await run(uv, ['pip', 'install', '--python', bundledPython(), specWithPdf(vendor)], {
        cwd: dir,
        timeoutMs: INSTALL_TIMEOUT_MS,
        silent: true,
      })
    }
  }
  if (!uv || result.code !== 0 || !findBundled()) {
    const python = findPython()
    result = await run(python, ['-m', 'venv', '--clear', join(dir, '.venv')], {
      cwd: dir,
      timeoutMs: INSTALL_TIMEOUT_MS,
      silent: true,
    })
    if (result.code === 0) {
      const pip = process.platform === 'win32'
        ? join(dir, '.venv', 'Scripts', 'pip.exe')
        : join(dir, '.venv', 'bin', 'pip')
      const installer = existsSync(pip) ? pip : bundledPython()
      const pipArgs = existsSync(pip) ? ['install', specWithPdf(vendor)] : ['-m', 'pip', 'install', specWithPdf(vendor)]
      result = await run(installer, pipArgs, {
        cwd: dir,
        timeoutMs: INSTALL_TIMEOUT_MS,
        silent: true,
      })
    }
  }

  const launch = findBundled()
  if (!launch || result.code !== 0) {
    const detail = (result.err || result.out || '').trim().replace(/\s+/g, ' ').slice(0, 400)
    console.warn(
      `${LOG}: install failed (exit ${result.code}); mcp__papermemory__* tools will be absent`
      + (detail ? `: ${detail}` : ''),
    )
    return undefined
  }
  const cliVersion = await installedVersion(launch)
  if (!versionAtLeast(cliVersion, MIN_PAPERMEMORY_VERSION)) {
    console.warn(
      `${LOG}: installed papermemory version ${cliVersion || 'unknown'} is below `
      + `${MIN_PAPERMEMORY_VERSION}; refusing a half-installed CLI`,
    )
    return undefined
  }
  writeFileSync(versionStampPath(), `${wantStamp()}\n`)
  console.warn(`${LOG}: CLI ready (${wantStamp()}, version ${cliVersion})`)
  return launch
}

async function probeNdjson(launch, timeoutMs = 5000) {
  return await new Promise((resolve) => {
    const child = spawn(launch.command, [...(launch.args || []), 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch { /* gone */ }
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    child.stdout.once('data', (buf) => {
      const text = buf.toString()
      if (text.startsWith('Content-Length:')) return done(false)
      done(text.includes('{') && text.includes('jsonrpc'))
    })
    child.on('error', () => done(false))
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n')
      child.stdin.end()
    } catch {
      done(false)
    }
  })
}

/**
 * Ensure a papermemory CLI exists. Prefers the plugin-managed venv so DSH
 * runs the vendored MCP server (NDJSON stdio). PATH is the fallback if
 * install fails. PAPERMEMORY_CLI always wins.
 */
export async function ensurePaperMemoryInstalled() {
  if (process.env.PAPERMEMORY_SKIP_INSTALL === '1') return resolvePaperMemoryLaunch()
  if (process.env.PAPERMEMORY_CLI?.trim()) return resolvePaperMemoryLaunch()

  const have = bundledInstalledVersion()
  if (findBundled() && have === wantStamp()) return findBundled()

  const installed = await installBundled()
  if (installed) return installed
  const onPath = findOnPath()
  if (onPath) {
    const version = await installedVersion(onPath)
    if (!versionAtLeast(version, MIN_PAPERMEMORY_VERSION)) {
      console.warn(
        `${LOG}: PATH fallback ${onPath.command} is version ${version || 'unknown'} `
        + `(< ${MIN_PAPERMEMORY_VERSION}); not using it`,
      )
      return undefined
    }
    if (!(await probeNdjson(onPath))) {
      console.warn(
        `${LOG}: PATH fallback ${onPath.command} does not speak NDJSON MCP on startup; refusing it `
        + '(Content-Length-only servers deadlock DSH)',
      )
      return undefined
    }
    console.warn(`${LOG}: bundled install missing; PATH fallback ${onPath.command} is read-only (${version})`)
    return { ...onPath, readOnly: true, version }
  }
  return undefined
}

/** Create the SQLite store if it does not exist yet. */
export async function ensurePaperMemoryDb(launch) {
  if (!launch) return false
  if (launch.readOnly) {
    console.warn(`${LOG}: init skipped: PATH fallback is read-only`)
    return false
  }
  const result = await run(launch.command, cliArgs(launch, ['init', '--json']), {
    timeoutMs: INIT_TIMEOUT_MS,
    env: papermemoryEnv(),
    silent: true,
  })
  if (result.code !== 0) {
    const detail = (result.err || result.out || '').trim().replace(/\s+/g, ' ').slice(0, 240)
    console.warn(`${LOG}: init failed (exit ${result.code})${detail ? `: ${detail}` : ''}`)
    return false
  }
  return true
}

/**
 * Slug for auto-ingest / recap when the agent has not named a project.
 * Derived from the workspace directory name.
 *
 * @deprecated for writes: pass `cwd` to PaperMemory ingest and let
 * `canonical_project_slug` resolve ah.yaml / manuscript root_path. Kept for
 * read-side callers that still need a directory-derived key.
 */
export function projectSlugFromCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : undefined
}

function parseJsonOutput(out) {
  const text = String(out || '').trim()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)) } catch { /* fall through */ }
    }
    return undefined
  }
}

/**
 * Ingest a just-downloaded PDF (and optional DOI) into PaperMemory.
 * Non-throwing: download success must not depend on ingest.
 *
 * Crossref lookup (when DOI is set) runs first so title/authors/year/venue
 * are verified; the PDF ingest then merges onto that same record via --doi
 * instead of creating a second unverified local-pdf row.
 *
 * @param {{ path: string, doi?: string, title?: string, project?: string, cwd?: string, signal?: AbortSignal }} opts
 */
export async function ingestDownloadedPaper({ path, doi, title, project, cwd, signal }) {
  const launch = resolvePaperMemoryLaunch() || await ensurePaperMemoryInstalled()
  if (!launch) return { ok: false, error: 'papermemory CLI not available' }
  if (launch.readOnly) {
    return { ok: false, error: 'papermemory-write-unavailable: plugin-managed install missing (PATH fallback is read-only)' }
  }
  const env = papermemoryEnv()
  const extra = []
  if (project) extra.push('--project', project)
  if (cwd) extra.push('--cwd', cwd)

  let doiRecord
  if (doi) {
    const looked = await run(
      launch.command,
      cliArgs(launch, ['ingest', '--doi', doi, '--json', ...extra]),
      { timeoutMs: INGEST_TIMEOUT_MS, env, signal, silent: true },
    )
    if (looked.code === 0) doiRecord = parseJsonOutput(looked.out)
  }

  const pdfArgs = ['ingest', path, '--json', ...extra]
  if (doi) pdfArgs.push('--doi', doi)
  if (title) pdfArgs.push('--title', title)
  const pdf = await run(
    launch.command,
    cliArgs(launch, pdfArgs),
    { timeoutMs: INGEST_TIMEOUT_MS, env, signal, silent: true },
  )
  if (pdf.code !== 0) {
    const detail = (pdf.err || pdf.out || '').trim().replace(/\s+/g, ' ').slice(0, 300)
    if (doiRecord) {
      return {
        ok: true,
        paper: doiRecord,
        bibtex_key: doiRecord.bibtex_key || doiRecord.id,
        verified: Boolean(doiRecord.verified),
        error: detail || `papermemory PDF ingest exited ${pdf.code}`,
      }
    }
    return {
      ok: false,
      error: detail || `papermemory ingest exited ${pdf.code}`,
    }
  }
  const parsed = parseJsonOutput(pdf.out)
  const paper = parsed?.paper || parsed || doiRecord
  return {
    ok: true,
    paper,
    bibtex_key: paper?.bibtex_key || paper?.id,
    verified: Boolean(Number(paper?.verified)),
    doi: paper?.doi,
    status: parsed?.status || 'created',
    cite_state: parsed?.cite_state || paper?.cite_state,
    degradation: parsed?.degradation || null,
  }
}

/**
 * Ingest a pdf_to_markdown output onto the PaperMemory record for the source PDF.
 *
 * @param {{ path: string, pdfPath?: string, doi?: string, project?: string, cwd?: string, signal?: AbortSignal }} opts
 */
export async function ingestConvertedMarkdown({ path, pdfPath, doi, project, cwd, signal, converter, originChannel }) {
  const launch = resolvePaperMemoryLaunch() || await ensurePaperMemoryInstalled()
  if (!launch) return { ok: false, error: 'papermemory CLI not available' }
  if (launch.readOnly) {
    return { ok: false, error: 'papermemory-write-unavailable: plugin-managed install missing (PATH fallback is read-only)' }
  }
  const args = ['ingest', path, '--json', '--kind', 'markdown']
  if (project) args.push('--project', project)
  if (cwd) args.push('--cwd', cwd)
  if (doi) args.push('--doi', doi)
  if (pdfPath) args.push('--pdf-path', pdfPath)
  if (converter) args.push('--converter-json', JSON.stringify(converter))
  if (originChannel) args.push('--origin-channel', originChannel)
  const result = await run(launch.command, cliArgs(launch, args), {
    timeoutMs: INGEST_TIMEOUT_MS,
    env: papermemoryEnv(),
    signal,
    silent: true,
  })
  if (result.code !== 0) {
    const detail = (result.err || result.out || '').trim().replace(/\s+/g, ' ').slice(0, 300)
    return { ok: false, error: detail || `papermemory ingest exited ${result.code}` }
  }
  const parsed = parseJsonOutput(result.out)
  const paper = parsed?.paper || parsed
  return {
    ok: true,
    paper,
    bibtex_key: paper?.bibtex_key || paper?.id,
    verified: Boolean(Number(paper?.verified)),
    doi: paper?.doi,
    status: parsed?.status || 'created',
    cite_state: parsed?.cite_state || paper?.cite_state,
    degradation: parsed?.degradation || null,
  }
}
