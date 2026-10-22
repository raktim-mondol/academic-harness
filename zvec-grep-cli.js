/**
 * zg CLI resolution, first-run install, and a small spawn helper.
 * Shared by the MCP mount (zvec-grep.js) and the native indexer
 * (zvec-index-engine.js). Keep inject: [] consumers importing this file —
 * do not put inject: ['tools'] on the MCP row.
 *
 * Search is mounted over the daemon's loopback Streamable HTTP MCP
 * (`zg server on` while DSH is up, `zg server off` on unload). Bundled zg
 * is `@zvec/zvec-grep@^0.2.2` (Linux watchers, atomic daemon lease, stdio
 * heartbeat race fixed). HTTP is still the DSH mount — not `zg server --stdio`.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000
const SERVER_ON_TIMEOUT_MS = 60 * 1000
/** Stay under DSH's 5s process-shutdown grace so Ctrl+C actually stops the daemon. */
const SERVER_OFF_TIMEOUT_MS = 4_000
const SERVER_STATUS_TIMEOUT_MS = 15 * 1000
/** Local retrieval model; no API key. ~130 MB on first download. */
export const DEFAULT_EMBEDDING = 'local/potion-retrieval-32m'
/** Minimum bundled CLI. npm 0.2.2+ matches current zvec-ai/zvec-grep. */
export const MIN_ZG_VERSION = '0.2.2'
export const ZG_PACKAGE_SPEC = `@zvec/zvec-grep@^${MIN_ZG_VERSION}`
const BIN_NAMES = process.platform === 'win32' ? ['zg.cmd', 'zg.exe', 'zg'] : ['zg']
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm'
export const LOG = '[academic-harness] zvec-grep'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** User-local npm prefix used when zg is not already installed. */
export function bundledInstallDir() {
  return join(dshHome(), 'zvec-grep')
}

function bundledCliJs() {
  return join(bundledInstallDir(), 'node_modules', '@zvec', 'zvec-grep', 'dist', 'cli', 'index.js')
}

function isJsEntry(path) {
  return path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')
}

function launchFromCommand(command) {
  if (isJsEntry(command)) {
    return { command: process.execPath, args: [command], cli: [process.execPath, command] }
  }
  return { command, args: [], cli: [command] }
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

function findGlobalNpm() {
  const execDir = dirname(process.execPath)
  for (const bin of BIN_NAMES) {
    const candidate = join(execDir, bin)
    if (existsSync(candidate)) return launchFromCommand(candidate)
  }
  const jsCandidates = [
    bundledCliJs(),
    join(execDir, '..', 'lib', 'node_modules', '@zvec', 'zvec-grep', 'dist', 'cli', 'index.js'),
    join(execDir, '..', 'node_modules', '@zvec', 'zvec-grep', 'dist', 'cli', 'index.js'),
    join(homedir(), '.npm-global', 'lib', 'node_modules', '@zvec', 'zvec-grep', 'dist', 'cli', 'index.js'),
    join(homedir(), '.local', 'lib', 'node_modules', '@zvec', 'zvec-grep', 'dist', 'cli', 'index.js'),
  ]
  for (const js of jsCandidates) {
    if (existsSync(js)) return launchFromCommand(js)
  }
  return undefined
}

function bundledPkgPath() {
  return join(bundledInstallDir(), 'node_modules', '@zvec', 'zvec-grep', 'package.json')
}

export function bundledZgVersion() {
  try {
    const pkg = JSON.parse(readFileSync(bundledPkgPath(), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : undefined
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

function findBundled() {
  const js = bundledCliJs()
  if (existsSync(js)) return launchFromCommand(js)
  return undefined
}

/**
 * Resolve how DSH should spawn the zg CLI (index / `server on` / status).
 * Order: ZVEC_GREP_CLI, the plugin-managed install under $DSH_HOME/zvec-grep,
 * then PATH / other npm prefixes.
 */
export function resolveZgLaunch() {
  const override = process.env.ZVEC_GREP_CLI?.trim()
  if (override) return launchFromCommand(override)
  return findBundled() || findOnPath() || findGlobalNpm()
}

export function run(command, args, { cwd, timeoutMs, env, signal, onData, silent } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const onChunk = (buf) => {
      const text = buf.toString()
      out += text
      onData?.(text)
      if (!silent) process.stderr.write(text)
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolvePromise({ code: code ?? 1, out, pid: child.pid })
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
    child.on('error', (err) => {
      out += err.message
      finish(1)
    })
  })
}

function npmCommand() {
  const sibling = join(dirname(process.execPath), NPM_BIN)
  if (existsSync(sibling)) return sibling
  return NPM_BIN
}

export async function ensureZgInstalled() {
  if (process.env.ZVEC_GREP_SKIP_INSTALL === '1') return resolveZgLaunch()
  // A user-supplied binary is theirs to upgrade. Only manage the bundled copy.
  if (process.env.ZVEC_GREP_CLI?.trim()) return resolveZgLaunch()

  const have = bundledZgVersion()
  if (have && versionAtLeast(have, MIN_ZG_VERSION)) return resolveZgLaunch()

  const dir = bundledInstallDir()
  mkdirSync(dir, { recursive: true })
  const reason = have
    ? `upgrading bundled zg ${have} → ${ZG_PACKAGE_SPEC}`
    : `installing ${ZG_PACKAGE_SPEC} (first run; may take several minutes)`
  console.warn(`${LOG}: ${reason}`)
  const result = await run(npmCommand(), [
    'install',
    '--prefix', dir,
    '--no-fund',
    '--no-audit',
    ZG_PACKAGE_SPEC,
  ], {
    cwd: dir,
    timeoutMs: INSTALL_TIMEOUT_MS,
    env: { ...process.env, npm_config_update_notifier: 'false' },
  })
  const launch = resolveZgLaunch()
  if (!launch) {
    console.warn(`${LOG}: install failed (exit ${result.code}); mcp__zvec_grep__* tools will be absent`)
    return undefined
  }
  console.warn(`${LOG}: CLI ready (${bundledZgVersion() || 'unknown'})`)
  return launch
}

export function shouldIndexRoot(root) {
  if (typeof root !== 'string' || root.length === 0) return false
  if (!isAbsolute(root)) return false
  const abs = resolve(root)
  if (abs === resolve(homedir()) || abs === '/' || abs === homedir()) return false
  try {
    return statSync(abs).isDirectory()
  } catch {
    return false
  }
}

export function cliArgs(launch, rest) {
  return launch.cli.length === 2
    ? [launch.cli[1], ...rest]
    : rest
}

export function cliCommand(launch) {
  return launch.cli[0]
}

export function zgEnv(embedding, extra = {}) {
  const env = {
    ...process.env,
    ZVEC_GREP_EMBEDDING: embedding,
    ZVEC_GREP_MCP_TOOLSET: 'agent',
    ...extra,
  }
  return env
}

export function isAutoIndexOn(value) {
  const v = String(value || '').trim().toLowerCase()
  return v === 'yes' || v === 'true' || v === '1' || v === 'on'
}

/** zg state directory (`ZVEC_GREP_HOME`, default `~/.zvec-grep`). */
export function zgHome() {
  const override = process.env.ZVEC_GREP_HOME?.trim()
  return override && override.length > 0 ? override : join(homedir(), '.zvec-grep')
}

/**
 * Parse `zg server on` / `zg server status` text.
 * @param {string} out
 */
export function parseServerStatus(out) {
  const text = String(out || '').replace(/\r/g, '')
  const state = text.match(/^Server:\s+(\S+)/m)?.[1]
  const url = text.match(/^URL:\s+(\S+)/m)?.[1]
  const pidRaw = text.match(/^PID:\s+(\d+)/m)?.[1]
  const pid = pidRaw ? Number(pidRaw) : undefined
  const mcpToolset = text.match(/^MCP toolset:\s+(\S+)/m)?.[1]
  return {
    running: state === 'ready' || state === 'starting',
    ready: state === 'ready',
    serverUrl: url,
    pid: Number.isFinite(pid) ? pid : undefined,
    mcpToolset,
  }
}

/** Bearer token for the loopback MCP server, if the user configured one. */
export async function readServerToken() {
  const explicit = process.env.ZVEC_GREP_SERVER_TOKEN?.trim()
  if (explicit) return explicit
  const tokenFile = process.env.ZVEC_GREP_SERVER_TOKEN_FILE?.trim()
    || join(zgHome(), 'daemon', 'token')
  try {
    const token = (await readFile(tokenFile, 'utf8')).trim()
    return token.length > 0 ? token : undefined
  } catch {
    return undefined
  }
}

/**
 * Start or reuse the zg loopback daemon and return its MCP URL.
 * Returns undefined when the daemon cannot be brought up; the caller skips
 * the search-tool mount so the rest of the preset still loads.
 *
 * @param {{ cli: string[] }} launch
 * @param {{ embedding?: string, apiKey?: string }} [opts]
 */
export async function ensureDaemonReady(launch, opts = {}) {
  const extra = {}
  if (opts.apiKey) extra.ZVEC_GREP_API_KEY = opts.apiKey
  const env = zgEnv(opts.embedding || DEFAULT_EMBEDDING, extra)
  const overrideUrl = process.env.ZVEC_GREP_SERVER_URL?.trim()

  const started = await run(cliCommand(launch), cliArgs(launch, ['server', 'on', '--mcp-toolset', 'agent']), {
    timeoutMs: SERVER_ON_TIMEOUT_MS,
    env,
    silent: true,
  })
  let status = parseServerStatus(started.out)
  if (!status.serverUrl || !status.ready) {
    const checked = await run(cliCommand(launch), cliArgs(launch, ['server', 'status']), {
      timeoutMs: SERVER_STATUS_TIMEOUT_MS,
      env,
      silent: true,
    })
    status = parseServerStatus(checked.out)
    if (!status.serverUrl) {
      const detail = (checked.out || started.out || '').trim().replace(/\s+/g, ' ')
      console.warn(
        `${LOG}: daemon not ready (on=${started.code}, status=${checked.code})`
        + (detail ? `: ${detail}` : ''),
      )
      if (!overrideUrl) return undefined
    }
  }

  const serverUrl = overrideUrl || status.serverUrl
  if (!serverUrl) return undefined
  const token = await readServerToken()
  return { serverUrl, token, pid: status.pid, ready: status.ready || Boolean(overrideUrl) }
}

/**
 * Stop the loopback daemon this process started (or reused). No-op when the
 * caller pointed MCP at `ZVEC_GREP_SERVER_URL` — that endpoint is not ours
 * to tear down. `zg server off` is idempotent if the daemon is already gone.
 *
 * @param {{ cli: string[] }} launch
 */
export async function stopDaemon(launch) {
  if (!launch) return
  if (process.env.ZVEC_GREP_SERVER_URL?.trim()) return
  const result = await run(cliCommand(launch), cliArgs(launch, ['server', 'off']), {
    timeoutMs: SERVER_OFF_TIMEOUT_MS,
    silent: true,
  })
  if (result.code !== 0) {
    const detail = String(result.out || '').trim().replace(/\s+/g, ' ')
    console.warn(
      `${LOG}: zg server off failed (exit ${result.code})`
      + (detail ? `: ${detail}` : ''),
    )
  }
}
