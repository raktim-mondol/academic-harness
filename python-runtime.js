/**
 * Shared runtime for the Python helpers in python-helpers/: resolves the
 * helper directory and interpreter, and runs one helper with JSON on stdin.
 * Same discovery rules as sci_inspect (`ACADEMIC_HARNESS_HELPERS_DIR`,
 * `ACADEMIC_HARNESS_PYTHON`, then the helper venv, then python3).
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export function helpersDir() {
  return process.env.ACADEMIC_HARNESS_HELPERS_DIR
    || process.env.RESEARCHCRAFT_HELPERS_DIR
    || join(HERE, 'python-helpers')
}

export function pythonBin() {
  const override = process.env.ACADEMIC_HARNESS_PYTHON || process.env.RESEARCHCRAFT_PYTHON
  if (override) return override
  const dir = helpersDir()
  const venv = process.platform === 'win32'
    ? join(dir, '.venv', 'Scripts', 'python.exe')
    : join(dir, '.venv', 'bin', 'python')
  if (existsSync(venv)) return venv
  return process.platform === 'win32' ? 'python' : 'python3'
}

/** Run `<helpers>/<script>` with a JSON request on stdin; parses JSON stdout. */
export function runHelper(script, request, { timeoutMs = 120_000 } = {}) {
  const path = join(helpersDir(), script)
  if (!existsSync(path)) return { error: `helper script missing: ${path}` }
  const result = spawnSync(pythonBin(), [path], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
  })
  if (result.error) return { error: `helper failed to start: ${result.error.message}` }
  if (result.status === null) return { error: `helper timed out after ${timeoutMs}ms` }
  const stdout = String(result.stdout || '').trim()
  if (!stdout) {
    return { error: `helper exited ${result.status}${result.stderr ? `: ${result.stderr.trim().slice(0, 800)}` : ''}` }
  }
  try {
    return JSON.parse(stdout)
  } catch {
    return { error: `helper returned non-JSON output (exit ${result.status})`, stderr: String(result.stderr || '').slice(0, 800) }
  }
}
