/**
 * Academic Harness CLI resolution, first-run install, and spawn helpers.
 * Shared by native `ah_*` tools and the DSH interceptors (guard / gate /
 * paper-state). Keep inject: [] consumers importing this file — do not put
 * inject: ['tools'] on a row whose apply() waits on install.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Nearest ancestor (inclusive) that contains `ah.yaml`, or null. */
export function findAhRoot(start) {
  if (!start) return null
  let d = start
  for (;;) {
    if (existsSync(join(d, 'ah.yaml'))) return d
    const p = dirname(d)
    if (p === d) return null
    d = p
  }
}

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000
const UV_BIN = process.platform === 'win32' ? 'uv.exe' : 'uv'
const PYTHON_BINS = process.platform === 'win32' ? ['python.exe', 'python'] : ['python3', 'python']

export const LOG = '[academic-harness] ah'
export const MIN_AH_VERSION = '0.1.0'
/** Bump when the vendored tree changes without a pyproject version bump. */
const BUNDLE_REV = 'dsh5'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Vendored engine inside this plugin (`vendor/academic-harness`). */
export function vendorDir() {
  return join(HERE, 'vendor', 'academic-harness')
}

/** Venv lives next to the vendored engine, not under $DSH_HOME. */
export function bundledInstallDir() {
  return vendorDir()
}

function bundledPython() {
  return process.platform === 'win32'
    ? join(bundledInstallDir(), '.venv', 'Scripts', 'python.exe')
    : join(bundledInstallDir(), '.venv', 'bin', 'python')
}

function bundledBin() {
  return process.platform === 'win32'
    ? join(bundledInstallDir(), '.venv', 'Scripts', 'ah.exe')
    : join(bundledInstallDir(), '.venv', 'bin', 'ah')
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
    return m ? m[1] : MIN_AH_VERSION
  } catch {
    return MIN_AH_VERSION
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

function findBundled() {
  const bin = bundledBin()
  if (existsSync(bin)) return launchFromCommand(bin)
  const py = bundledPython()
  if (existsSync(py)) return { command: py, args: ['-m', 'ah'], cli: [py, '-m', 'ah'] }
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
 * Resolve how DSH should spawn `ah`.
 * Order: ACADEMIC_HARNESS_CLI / AH_CMD, then the venv inside this plugin's
 * vendored engine. No $DSH_HOME install, no PATH `ah`.
 */
export function resolveAhLaunch() {
  const override = (process.env.ACADEMIC_HARNESS_CLI || process.env.AH_CMD || '').trim()
  if (override) {
    const parts = override.split(/\s+/).filter(Boolean)
    return { command: parts[0], args: parts.slice(1), cli: parts }
  }
  return findBundled()
}

export function run(command, args, { cwd, timeoutMs, env, signal, silent, stdin, onStdout, onStderr } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: [stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout?.on('data', (buf) => {
      const text = buf.toString()
      out += text
      onStdout?.(text)
      if (!silent) process.stderr.write(text)
    })
    child.stderr?.on('data', (buf) => {
      const text = buf.toString()
      err += text
      onStderr?.(text)
      if (!silent) process.stderr.write(text)
    })
    if (stdin != null && child.stdin) {
      child.stdin.write(typeof stdin === 'string' ? stdin : String(stdin))
      child.stdin.end()
    }
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

/**
 * Environment for every `ah` subprocess.
 * Default AH_LOG is <project>/.ah/dsh-hooks.jsonl so guard/gate events are
 * auditable. AH_MODEL tags provenance when the DSH session has a model id.
 */
export function ahEnv(extra = {}, { root, model } = {}) {
  const env = { ...process.env, PYTHONUNBUFFERED: '1', ...extra }
  if (model && !String(env.AH_MODEL || '').trim()) env.AH_MODEL = String(model)
  if (root) {
    try {
      mkdirSync(join(root, '.ah'), { recursive: true })
    } catch {
      /* best-effort */
    }
    if (!String(env.AH_LOG || '').trim()) env.AH_LOG = join(root, '.ah', 'dsh-hooks.jsonl')
  }
  return env
}

/** How the agent should drive the engine on DeepSeek Harness (appended to the paper-state card). */
export const DSH_STATE_FOOTER = `On DeepSeek Harness use native ah_* tools (not the shell, not Pi):
ah_state, ah_check, ah_audit, ah_inventory, ah_units, ah_fact (action list|build|check), ah_source (list|add|search) / ah_source_search, ah_claims, ah_claims_sync, ah_claims_bind, ah_bind, ah_pack, ah_brief_new, ah_plan, ah_sweep, ah_build, ah_findings, ah_decision_request, ah_review (list|import|show|check), ah_review_set, ah_review_respond, ah_fact_propose, ah_snapshot, ah_provenance, ah_disclosure, ah_profile, ah_config, ah_catalogue, ah_init, ah_migrate.
You cannot waive findings, approve briefs or plans, accept or reject fact proposals, verify claims, decline a review item, fill provenance, or approve a disclosure. Call ah_decision_request and stop. If the human explicitly asked in this message, ah_author (DSH will ask them to confirm).
Numbers from data are \\fact{id}. Cite only registered sources. Keep every "%% @unit" line with its paragraph. Done means coverage is complete and this turn introduced no open blocker or major.`

async function installBundled() {
  const vendor = vendorDir()
  if (!existsSync(join(vendor, 'pyproject.toml'))) {
    console.warn(`${LOG}: vendored engine missing at ${vendor}`)
    return undefined
  }
  const want = vendoredVersion()
  console.warn(`${LOG}: preparing plugin engine ${want} (${vendor})`)

  const uv = findUv()
  let result = { code: 1, out: '', err: '' }
  if (uv) {
    result = await run(uv, ['venv', '--clear', join(vendor, '.venv')], {
      cwd: vendor,
      timeoutMs: INSTALL_TIMEOUT_MS,
      silent: true,
    })
    if (result.code !== 0) {
      console.warn(`${LOG}: uv venv failed (exit ${result.code}): ${(result.err || result.out).trim()}`)
    } else {
      result = await run(uv, ['pip', 'install', '--python', bundledPython(), vendor], {
        cwd: vendor,
        timeoutMs: INSTALL_TIMEOUT_MS,
        silent: true,
      })
    }
  }
  if (!uv || result.code !== 0 || !findBundled()) {
    const python = findPython()
    result = await run(python, ['-m', 'venv', '--clear', join(vendor, '.venv')], {
      cwd: vendor,
      timeoutMs: INSTALL_TIMEOUT_MS,
      silent: true,
    })
    if (result.code === 0) {
      const pip = process.platform === 'win32'
        ? join(vendor, '.venv', 'Scripts', 'pip.exe')
        : join(vendor, '.venv', 'bin', 'pip')
      const installer = existsSync(pip) ? pip : bundledPython()
      const pipArgs = existsSync(pip) ? ['install', vendor] : ['-m', 'pip', 'install', vendor]
      result = await run(installer, pipArgs, {
        cwd: vendor,
        timeoutMs: INSTALL_TIMEOUT_MS,
        silent: true,
      })
    }
  }

  const launch = findBundled()
  if (!launch || result.code !== 0) {
    const detail = (result.err || result.out || '').trim().replace(/\s+/g, ' ').slice(0, 400)
    console.warn(
      `${LOG}: plugin engine venv failed (exit ${result.code}); ah_* tools will error until this is fixed`
      + (detail ? `: ${detail}` : ''),
    )
    return undefined
  }
  writeFileSync(versionStampPath(), `${wantStamp()}\n`)
  console.warn(`${LOG}: plugin engine ready (${wantStamp()})`)
  return launch
}

let ensurePromise

/**
 * Ensure the vendored engine inside this plugin has a local venv.
 * ACADEMIC_HARNESS_CLI / AH_CMD always wins. Nothing is installed into $DSH_HOME.
 */
export function ensureAcademicHarnessInstalled() {
  if (process.env.ACADEMIC_HARNESS_SKIP_INSTALL === '1') {
    return Promise.resolve(resolveAhLaunch())
  }
  if ((process.env.ACADEMIC_HARNESS_CLI || process.env.AH_CMD || '').trim()) {
    return Promise.resolve(resolveAhLaunch())
  }
  if (ensurePromise) return ensurePromise
  ensurePromise = (async () => {
    const have = bundledInstalledVersion()
    if (findBundled() && have === wantStamp()) return findBundled()
    return installBundled()
  })()
  return ensurePromise
}

/** Test-only: drop the cached install promise. */
export function resetAhInstallForTests() {
  ensurePromise = undefined
}
