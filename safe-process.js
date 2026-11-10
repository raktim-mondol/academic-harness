/**
 * Running code the plugin did not write (analysis scripts, a cloned
 * repository's tests) without handing it the host's secrets, and without
 * freezing the host while it runs.
 *
 *   baseEnv(network)      the allowlisted environment `analysis_run` has always used
 *   repoTestEnv(network)  baseEnv plus the toolchain locations test runners need
 *   runCommand(...)       async spawn with a timeout, an abort signal, a process-group
 *                         kill (SIGTERM, then SIGKILL) and bounded output tails
 *
 * No credential-shaped variable is ever copied from the parent process: only
 * the names listed here are, so a new API key in the host cannot leak by default.
 */
import { spawn } from 'node:child_process'

const BASE_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TMP', 'TEMP']

/**
 * Toolchain locations and caches only. Registry and index URLs are left out on
 * purpose, because private-index URLs can embed credentials.
 */
const TOOLCHAIN_KEYS = [
  'LANGUAGE',
  'USER',
  'LOGNAME',
  'SHELL',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'npm_config_cache',
  'NPM_CONFIG_CACHE',
  'PIP_CACHE_DIR',
  'VIRTUAL_ENV',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'GOPATH',
  'GOCACHE',
  'GOMODCACHE',
  'NVM_DIR',
  'PNPM_HOME',
]

export function baseEnv(network) {
  const env = {}
  for (const key of BASE_KEYS) {
    if (process.env[key]) env[key] = process.env[key]
  }
  env.PYTHONUNBUFFERED = '1'
  env.PYTHONIOENCODING = 'utf-8'
  if (!network) {
    env.no_proxy = '*'
    env.NO_PROXY = '*'
  }
  return env
}

export function repoTestEnv(network = true) {
  const env = baseEnv(network)
  for (const key of TOOLCHAIN_KEYS) {
    if (process.env[key]) env[key] = process.env[key]
  }
  env.CI = '1'
  return env
}

function tailBuffer(limit) {
  let text = ''
  return {
    push(chunk) {
      text += chunk
      if (text.length > limit * 2) text = text.slice(-limit)
    },
    value() {
      return text.length > limit ? text.slice(-limit) : text
    },
  }
}

function killGroup(child, signal) {
  if (child.pid == null) return
  try {
    // Negative pid addresses the whole process group, so a test runner's own
    // children (npm -> node -> workers) die with it.
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

/**
 * Run a command to completion. Never throws: spawn failures, timeouts and
 * aborts come back as fields.
 *
 * @returns {Promise<{status: number|null, signal: string|null, stdout: string,
 *   stderr: string, timedOut: boolean, aborted: boolean, error: string|null}>}
 */
export function runCommand(command, args, {
  cwd,
  env,
  timeoutMs = 300_000,
  graceMs = 2_000,
  signal,
  tailChars = 64 * 1024,
  stdin,
} = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        detached: true,
        stdio: [stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ status: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, error: String(error?.message || error) })
      return
    }
    const out = tailBuffer(tailChars)
    const err = tailBuffer(tailChars)
    let timedOut = false
    let aborted = false
    let spawnError = null
    let killTimer = null
    let settled = false

    const stop = (why) => {
      if (why === 'timeout') timedOut = true
      if (why === 'abort') aborted = true
      killGroup(child, 'SIGTERM')
      killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), graceMs)
    }
    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    const onAbort = () => stop('abort')
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => out.push(chunk))
    child.stderr?.on('data', (chunk) => err.push(chunk))
    if (stdin != null && child.stdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(String(stdin))
    }
    child.on('error', (error) => {
      spawnError = String(error?.message || error)
    })
    child.on('close', (status, exitSignal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener?.('abort', onAbort)
      // A group member may outlive its parent; make sure nothing is left behind.
      if (timedOut || aborted) killGroup(child, 'SIGKILL')
      resolve({
        status: status ?? null,
        signal: exitSignal ?? null,
        stdout: out.value(),
        stderr: err.value(),
        timedOut,
        aborted,
        error: spawnError,
      })
    })
  })
}
