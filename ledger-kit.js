/**
 * Small, dependency-free helpers for the append-only `.dsh` ledgers.
 *
 * Existing ledgers keep their own local helpers for backward compatibility;
 * new ledgers (review extraction, meta-analysis, analysis runs, provenance)
 * use this module so locks, hashes, JSONL parsing, and overwrite refusal stay
 * consistent. Path confinement is deliberately not duplicated here: callers
 * resolve user paths through `workspace-path.js` before writing.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { writeJsonAtomic } from './store-lock.js'

export function nowIso() {
  return new Date().toISOString()
}

function canonical(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

/** Stable JSON used for hashes and fingerprints; object key order does not matter. */
export function stableStringify(value) {
  return canonical(value)
}

/** SHA-256 of a string, Buffer, or JSON-serializable value. */
export function sha256(value) {
  const input = typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)
  return createHash('sha256').update(input).digest('hex')
}

export function shortHash(value, length = 16) {
  return sha256(value).slice(0, Math.max(1, Math.min(64, Number(length) || 16)))
}

export function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Write a JSON file once; a second write with a different value is refused. */
export function writeOnceJson(file, value) {
  if (existsSync(file)) {
    throw new Error(`${file} already exists; write-once files cannot be replaced`)
  }
  ensureDir(dirname(file))
  return writeJsonAtomic(file, value)
}

export function appendJsonl(file, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0
  ensureDir(dirname(file))
  appendFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  return rows.length
}

export function readJsonl(file) {
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split('\n')
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) continue
    try {
      rows.push(JSON.parse(line))
    } catch (error) {
      throw new Error(`${file} line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return rows
}

/** Write text, refusing to replace an existing file unless `overwrite` is true. */
export function exportText(file, body, { overwrite = false } = {}) {
  if (existsSync(file) && !overwrite) {
    throw new Error(`${file} already exists; pass overwrite: true to replace it`)
  }
  ensureDir(dirname(file))
  writeFileSync(file, body)
  return { path: file, bytes: Buffer.byteLength(body) }
}

export function csvCell(value) {
  const raw = String(value ?? '')
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw
}

export function mdCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
}

export function slug(value, max = 80) {
  const text = String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return text.slice(0, max)
}

export function requireText(value, name) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`${name} is required`)
  return text
}
