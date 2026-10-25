/**
 * Modal SDK runtime for `modal_run`.
 *
 * The SDK stays an optional peer so installing Academic Harness never needs it.
 * On first use the tool loads it from the profile when present; otherwise it
 * prepares a pinned, plugin-managed install under `$DSH_HOME/modal-sdk`,
 * including the pnpm `allowBuilds` policy for its two optional native deps.
 *
 * `ACADEMIC_HARNESS_MODAL_SKIP_INSTALL=1` disables the managed install and
 * leaves the manual `dsh plugin --profile <profile> add modal` path.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dshHome, runProcess } from './textfold-runtime.js'
import { patchAllowBuilds } from './pnpm-workspace.js'

export const MODAL_SDK_VERSION = '0.11.1'
const LOG = '[academic-harness] modal-sdk'
const INSTALL_TIMEOUT_MS = 300_000

export class ModalSdkError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ModalSdkError'
    this.code = code
  }
}

export function modalSdkHome() {
  return join(dshHome(), 'modal-sdk')
}

function skipInstall() {
  return /^(1|true|yes|on)$/i.test(String(process.env.ACADEMIC_HARNESS_MODAL_SKIP_INSTALL ?? ''))
}

function installedVersion(dir = modalSdkHome()) {
  try {
    return JSON.parse(readFileSync(join(dir, 'node_modules', 'modal', 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

function lastLine(text) {
  return String(text ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''
}

/** Write the manifest and pnpm build policy without touching an existing config's other keys. */
function writeRuntimeConfig(dir) {
  mkdirSync(dir, { recursive: true })
  const pkgPath = join(dir, 'package.json')
  const wanted = `${JSON.stringify({
    name: 'academic-harness-modal-runtime',
    private: true,
    type: 'module',
    dependencies: { modal: MODAL_SDK_VERSION },
  }, null, 2)}\n`
  if (!existsSync(pkgPath) || readFileSync(pkgPath, 'utf8') !== wanted) writeFileSync(pkgPath, wanted)

  const wsPath = join(dir, 'pnpm-workspace.yaml')
  const before = existsSync(wsPath) ? readFileSync(wsPath, 'utf8') : ''
  const { text, changed } = patchAllowBuilds(before)
  if (changed) writeFileSync(wsPath, text.endsWith('\n') ? text : `${text}\n`)
}

async function installRuntime({ signal }) {
  const dir = modalSdkHome()
  writeRuntimeConfig(dir)
  console.warn(`${LOG}: installing modal@${MODAL_SDK_VERSION} into ${dir} (first use; set ACADEMIC_HARNESS_MODAL_SKIP_INSTALL=1 to disable)`)

  const notes = []
  const pnpm = await runProcess('pnpm', ['install', '--prod'], {
    cwd: dir,
    signal,
    timeoutMs: INSTALL_TIMEOUT_MS,
    maxBytes: 1024 * 1024,
  })
  if (pnpm.code === 0) return
  notes.push(`pnpm: ${pnpm.aborted ? 'aborted' : lastLine(pnpm.stderr) || pnpm.error?.message || `exit ${pnpm.code}`}`)

  // npm --ignore-scripts needs no pnpm build approval; same JS fallback either way.
  const npm = await runProcess('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: dir,
    signal,
    timeoutMs: INSTALL_TIMEOUT_MS,
    maxBytes: 1024 * 1024,
  })
  if (npm.code === 0) return
  notes.push(`npm: ${npm.aborted ? 'aborted' : lastLine(npm.stderr) || npm.error?.message || `exit ${npm.code}`}`)

  throw new ModalSdkError(
    'sdk_install_failed',
    `The Modal SDK could not be installed into ${dir}. ${notes.join('; ')}. `
      + 'Install it manually with `dsh plugin --profile <profile> add modal` (then restart dsh), '
      + 'or set ACADEMIC_HARNESS_MODAL_SKIP_INSTALL=1 to manage it yourself.',
  )
}

async function importFromProfile() {
  const mod = await import('modal')
  const ModalClient = mod.ModalClient ?? mod.default?.ModalClient
  if (typeof ModalClient !== 'function') throw new Error('the modal package did not export ModalClient')
  return { ModalClient, version: mod.version, install: 'profile' }
}

async function importFromRuntime() {
  const dir = modalSdkHome()
  const req = createRequire(join(dir, 'package.json'))
  const entry = req.resolve('modal')
  const mod = await import(pathToFileURL(entry).href)
  const ModalClient = mod.ModalClient ?? mod.default?.ModalClient
  if (typeof ModalClient !== 'function') throw new Error('the managed modal package did not export ModalClient')
  return { ModalClient, version: installedVersion(dir), install: 'managed', path: entry }
}

let sdkPromise = null

/**
 * Resolve ModalClient, installing the managed runtime once per process when
 * the profile does not already provide the SDK.
 */
export function ensureModalSdk({ signal } = {}) {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      try {
        return await importFromProfile()
      } catch (error) {
        const code = error?.code
        if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') throw error
      }

      if (skipInstall()) {
        throw new ModalSdkError(
          'sdk_missing',
          'The Modal SDK is not available and ACADEMIC_HARNESS_MODAL_SKIP_INSTALL is set. '
            + 'Unset it to let the plugin install the SDK, or run '
            + '`dsh plugin --profile <profile> add modal` and restart dsh.',
        )
      }

      if (installedVersion() !== MODAL_SDK_VERSION) await installRuntime({ signal })
      return importFromRuntime()
    })().catch((error) => {
      sdkPromise = null
      throw error
    })
  }
  return sdkPromise
}
