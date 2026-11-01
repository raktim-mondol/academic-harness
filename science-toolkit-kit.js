/**
 * Shared plumbing for the local science toolkits (chem_toolkit, seq_toolkit,
 * structure_toolkit): workspace-confined, size-limited inputs with SHA-256
 * hashes, one helper call, and an append-only run record carrying the input
 * hashes and tool versions. The computation itself lives in python-helpers/.
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { appendJsonl, hashFile, nowIso, sha256, stableStringify } from './ledger-kit.js'
import { runHelper } from './python-runtime.js'
import { resolveWorkspacePath } from './workspace-path.js'

const MAX_INPUT_BYTES = 200 * 1024 * 1024

export function text(value) {
  return String(value ?? '').trim()
}

export function workspaceRoot(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

/** Resolve one workspace file input; returns its relative path, absolute path, size, and hash. */
export function fileInput(cwd, rel, label = 'path') {
  const clean = text(rel)
  if (!clean) throw new Error(`${label} is required`)
  const abs = resolveWorkspacePath(cwd, clean)
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`file not found: ${clean}`)
  const bytes = statSync(abs).size
  if (bytes > MAX_INPUT_BYTES) throw new Error(`${clean} is ${bytes} bytes; the limit is ${MAX_INPUT_BYTES}`)
  return { label, path: clean, abs, bytes, sha256: `sha256:${hashFile(abs)}` }
}

/** Hash an inline value (a SMILES list, a sequence) so the run record names its exact input. */
export function inlineInput(label, value) {
  return { label, inline: true, sha256: `sha256:${sha256(stableStringify(value))}` }
}

export function runToolkit({ tool, script, request, inputs, cwd, deps = {}, timeoutMs = 120_000 }) {
  const helper = deps.runHelper || runHelper
  const result = helper(script, request, { timeoutMs })
  if (result?.error) {
    const error = new Error(result.error)
    if (result.code) error.code = result.code
    throw error
  }
  const provenance = {
    tool,
    action: request.action,
    ran_at: deps.now || nowIso(),
    inputs: inputs.map(({ abs: _abs, ...rest }) => rest),
    tool_versions: result.tool_versions || {},
  }
  if (!deps.skipLedger) {
    appendJsonl(join(cwd, '.dsh', 'science', 'runs.jsonl'), [{ kind: 'toolkit_run', ...provenance }])
  }
  const { tool_versions: _versions, ...rest } = result
  return { ...rest, provenance }
}

export function provenanceLine(value) {
  const p = value.provenance
  if (!p) return null
  const versions = Object.entries(p.tool_versions || {}).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')
  return `Inputs: ${p.inputs.map((i) => `${i.label} ${i.sha256.slice(0, 19)}…`).join('; ')}${versions ? ` · ${versions}` : ''}`
}

export function table(rows, columns) {
  if (!rows.length) return []
  const head = `| ${columns.map(([, title]) => title).join(' | ')} |`
  const rule = `|${columns.map(() => '---').join('|')}|`
  const body = rows.map((row) => `| ${columns.map(([key]) => String(row[key] ?? '')).join(' | ')} |`)
  return [head, rule, ...body]
}

export function errorText(value) {
  return [{ type: 'text', text: `Error: ${value.error}` }]
}
