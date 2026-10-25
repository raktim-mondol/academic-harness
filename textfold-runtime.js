/**
 * TextFold runtime for `paper_fold`: a pinned, plugin-managed Python install.
 *
 * The Python package is not vendored. The first preset mount prepares a venv
 * under `$DSH_HOME/textfold` in the background; the tool awaits the same
 * promise. Data lives under `$DSH_HOME/textfold/data` unless TEXTFOLD_DATA is
 * set. `TEXTFOLD_PYTHON` / `TEXTFOLD_CLI` point at an existing install, and
 * `TEXTFOLD_SKIP_INSTALL=1` disables the managed install.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { resolveEnv } from './credential-env.js'

export const TEXTFOLD_VERSION = '0.10.31'
export const LOG = '[academic-harness] textfold'
const MAX_OUTPUT = 64 * 1024 * 1024
const MAX_INSTALL_OUTPUT = 16 * 1024 * 1024
const MAX_STDERR = 200_000

export class TextfoldError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TextfoldError'
    this.code = code
  }
}

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function textfoldHome() {
  return join(dshHome(), 'textfold')
}

export function venvDir() {
  return join(textfoldHome(), 'venv')
}

export function venvPython() {
  return process.platform === 'win32'
    ? join(venvDir(), 'Scripts', 'python.exe')
    : join(venvDir(), 'bin', 'python')
}

export function dataDir() {
  const configured = process.env.TEXTFOLD_DATA?.trim()
  return configured ? (isAbsolute(configured) ? configured : resolve(configured)) : join(textfoldHome(), 'data')
}

export function resolveTextfoldLaunch() {
  const cli = process.env.TEXTFOLD_CLI?.trim()
  if (cli) return { command: cli, args: [], kind: 'cli' }
  const python = process.env.TEXTFOLD_PYTHON?.trim()
  if (python) return { command: python, args: ['-m', 'textfold'], kind: 'python' }
  const managed = venvPython()
  if (existsSync(managed)) return { command: managed, args: ['-m', 'textfold'], kind: 'venv' }
  return null
}

function skipInstall() {
  return /^(1|true|yes|on)$/i.test(String(process.env.TEXTFOLD_SKIP_INSTALL ?? ''))
}

export function parseVersion(text) {
  const match = /(\d+\.\d+\.\d+)/.exec(String(text ?? ''))
  return match ? match[1] : ''
}

export function lastLine(text) {
  return String(text ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''
}

/**
 * Run one command, collecting bounded stdout/stderr and honoring a timeout and
 * an AbortSignal. Python is spawned directly (no shell), so refs are not
 * interpreted by a shell.
 */
export function runProcess(command, args, options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 120_000,
    signal,
    maxBytes = MAX_OUTPUT,
  } = options

  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...(env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolvePromise({ code: null, stdout: '', stderr: '', error })
      return
    }

    let stdout = ''
    let stderr = ''
    let outBytes = 0
    let done = false
    let timedOut = false
    let tooLarge = false
    let aborted = false
    let timer
    let abortHandler

    const kill = () => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }

    const finish = (code, error) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
      resolvePromise({ code, stdout, stderr, error, timedOut, tooLarge, aborted })
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      outBytes += Buffer.byteLength(chunk)
      if (outBytes > maxBytes) {
        tooLarge = true
        kill()
        return
      }
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_STDERR) stderr += chunk
    })
    child.on('error', (error) => finish(null, error))
    child.on('close', (code) => finish(code))

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        kill()
      }, timeoutMs)
    }
    if (signal) {
      abortHandler = () => {
        aborted = true
        kill()
      }
      if (signal.aborted) abortHandler()
      else signal.addEventListener('abort', abortHandler, { once: true })
    }
  })
}

async function versionOf(launch) {
  const result = await runProcess(launch.command, [...launch.args, '--version'], {
    timeoutMs: 15_000,
    maxBytes: 1024 * 1024,
  })
  const version = parseVersion(result.stdout) || parseVersion(result.stderr)
  return {
    ...launch,
    version,
    ready: result.code === 0 && Boolean(version),
    error: result.error,
    stderr: result.stderr,
  }
}

async function hasUv() {
  const result = await runProcess('uv', ['--version'], { timeoutMs: 5_000, maxBytes: 1024 * 1024 })
  return result.code === 0
}

async function findPython() {
  const candidates = process.platform === 'win32' ? ['python'] : ['python3', 'python']
  for (const command of candidates) {
    const result = await runProcess(command, ['--version'], { timeoutMs: 5_000, maxBytes: 1024 * 1024 })
    if (result.code === 0) return command
  }
  return null
}

async function installTextfold() {
  const home = textfoldHome()
  try {
    mkdirSync(home, { recursive: true })
  } catch (error) {
    throw new TextfoldError('textfold-install-failed', `could not create ${home}: ${error.message}`)
  }

  console.warn(`${LOG}: installing textfold==${TEXTFOLD_VERSION} into ${home} (first preset start; set TEXTFOLD_SKIP_INSTALL=1 to disable)`)
  const notes = []

  if (await hasUv()) {
    const create = await runProcess('uv', ['venv', venvDir()], {
      timeoutMs: 300_000,
      maxBytes: MAX_INSTALL_OUTPUT,
    })
    if (create.code === 0) {
      const install = await runProcess('uv', ['pip', 'install', '--python', venvPython(), `textfold==${TEXTFOLD_VERSION}`], {
        timeoutMs: 600_000,
        maxBytes: MAX_INSTALL_OUTPUT,
      })
      if (install.code === 0) {
        const checked = await versionOf({ command: venvPython(), args: ['-m', 'textfold'], kind: 'venv' })
        if (checked.ready && checked.version === TEXTFOLD_VERSION) {
          console.warn(`${LOG}: ready (${checked.version})`)
          return checked
        }
        notes.push(`uv install completed but the version is ${checked.version || 'unknown'}`)
      } else {
        notes.push(`uv pip install: ${lastLine(install.stderr) || install.error?.message || `exit ${install.code}`}`)
      }
    } else {
      notes.push(`uv venv: ${lastLine(create.stderr) || create.error?.message || `exit ${create.code}`}`)
    }
  }

  const python = await findPython()
  if (!python) {
    notes.push('no python3 or python on PATH')
  } else {
    const create = await runProcess(python, ['-m', 'venv', venvDir()], {
      timeoutMs: 300_000,
      maxBytes: MAX_INSTALL_OUTPUT,
    })
    if (create.code === 0) {
      const install = await runProcess(venvPython(), ['-m', 'pip', 'install', `textfold==${TEXTFOLD_VERSION}`], {
        timeoutMs: 600_000,
        maxBytes: MAX_INSTALL_OUTPUT,
      })
      if (install.code === 0) {
        const checked = await versionOf({ command: venvPython(), args: ['-m', 'textfold'], kind: 'venv' })
        if (checked.ready && checked.version === TEXTFOLD_VERSION) {
          console.warn(`${LOG}: ready (${checked.version})`)
          return checked
        }
        notes.push(`pip install completed but the version is ${checked.version || 'unknown'}`)
      } else {
        notes.push(`pip install: ${lastLine(install.stderr) || install.error?.message || `exit ${install.code}`}`)
      }
    } else {
      notes.push(`python -m venv: ${lastLine(create.stderr) || create.error?.message || `exit ${create.code}`}`)
    }
  }

  throw new TextfoldError(
    'textfold-install-failed',
    `TextFold could not be installed into ${home}. ${notes.join('; ')}. Set TEXTFOLD_PYTHON or TEXTFOLD_CLI to use an existing install.`,
  )
}

let installPromise = null

/** Resolve the managed install, preparing it once per process. */
export function ensureTextfoldInstalled() {
  if (!installPromise) {
    installPromise = prepare().catch((error) => {
      installPromise = null
      throw error
    })
  }
  return installPromise
}

async function prepare() {
  const existing = resolveTextfoldLaunch()
  if (existing) {
    const checked = await versionOf(existing)
    if (!checked.ready) {
      const detail = lastLine(checked.stderr) || checked.error?.message || 'the command did not answer --version'
      throw new TextfoldError(
        existing.kind === 'venv' ? 'textfold-version' : 'textfold-missing',
        `TextFold is not usable at ${existing.command}: ${detail}`,
      )
    }
    if (existing.kind === 'venv' && checked.version !== TEXTFOLD_VERSION) {
      throw new TextfoldError(
        'textfold-version',
        `managed TextFold is ${checked.version}; expected ${TEXTFOLD_VERSION}. Remove ${venvDir()} or set TEXTFOLD_PYTHON/TEXTFOLD_CLI.`,
      )
    }
    return checked
  }

  if (skipInstall()) {
    const onPath = await versionOf({ command: 'textfold', args: [], kind: 'path' })
    if (onPath.ready) return onPath
    throw new TextfoldError(
      'textfold-missing',
      'TextFold is not installed. Let the plugin install it (unset TEXTFOLD_SKIP_INSTALL) or set TEXTFOLD_PYTHON/TEXTFOLD_CLI.',
    )
  }

  return installTextfold()
}

/** TextFold's data dir plus provider keys already available to this process. */
export async function textfoldEnv() {
  const env = { TEXTFOLD_DATA: dataDir() }
  for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']) {
    const value = process.env[key]?.trim()
    if (value) env[key] = value
  }
  try {
    const gemini = await resolveEnv('GEMINI_API_KEY')
    if (gemini) env.GEMINI_API_KEY = gemini
  } catch {
    // A missing settings context is not an error here; generate:true will report it.
  }
  return env
}

/** Run the TextFold CLI with the managed data dir and provider environment. */
export async function runTextfold(launch, args, options = {}) {
  const env = { ...(await textfoldEnv()), ...(options.env ?? {}) }
  return runProcess(launch.command, [...launch.args, ...args], {
    cwd: options.cwd,
    env,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 120_000,
    maxBytes: MAX_OUTPUT,
  })
}

/** Current install state without triggering an install. */
export async function textfoldStatus() {
  const data = dataDir()
  const launch = resolveTextfoldLaunch()
  if (!launch) {
    const onPath = await versionOf({ command: 'textfold', args: [], kind: 'path' })
    if (onPath.ready) {
      return {
        ready: true,
        version: onPath.version,
        install: 'path',
        command: 'textfold',
        data_dir: data,
        expected_version: TEXTFOLD_VERSION,
      }
    }
    return {
      ready: false,
      version: '',
      install: 'missing',
      data_dir: data,
      expected_version: TEXTFOLD_VERSION,
      error: lastLine(onPath.stderr) || onPath.error?.message || 'not installed',
    }
  }
  const checked = await versionOf(launch)
  const versionOk = checked.ready && (launch.kind !== 'venv' || checked.version === TEXTFOLD_VERSION)
  return {
    ready: versionOk,
    version: checked.version,
    install: launch.kind,
    command: launch.command,
    data_dir: data,
    expected_version: TEXTFOLD_VERSION,
    ...(versionOk
      ? {}
      : {
          error:
            launch.kind === 'venv' && checked.ready && checked.version !== TEXTFOLD_VERSION
              ? `managed version ${checked.version}; expected ${TEXTFOLD_VERSION}`
              : lastLine(checked.stderr) || checked.error?.message || 'not usable',
        }),
  }
}
