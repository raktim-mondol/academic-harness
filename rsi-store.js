/**
 * Local store for the Academic Harness RSI loop.
 *
 * Everything lives under `$DSH_HOME/ah-rsi` (or `AH_RSI_STORE`). The store is
 * append-only JSONL plus atomically written JSON metadata. It never writes to
 * the plugin tree, the vendored engine, the project, or the paper ledger.
 */
import { createHash } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findAhRoot } from './academic-harness-cli.js'

export const RSI_VERSION = 1
const HERE = dirname(fileURLToPath(import.meta.url))
const VALID_MODES = new Set(['off', 'observe', 'auto'])

const DEFAULTS = {
  mode: 'auto',
  exploration: 0.5,
  active_control_rate: 0.1,
  min_evidence: 3,
  min_sessions: 2,
  max_lessons: 12,
  max_per_class: 4,
  max_inject: 6,
  max_tokens: 600,
  diagnose_every: 5,
  lesson_ttl_days: 180,
  remote_judge: false,
  auto_skills: false,
}

export function nowIso() {
  return new Date().toISOString()
}

export function sha1(value, length = 12) {
  return createHash('sha1').update(String(value ?? '')).digest('hex').slice(0, length)
}

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function defaultStoreDir() {
  const override = String(process.env.AH_RSI_STORE || '').trim()
  return override ? resolve(override) : join(dshHome(), 'ah-rsi')
}

export function pluginVersion() {
  try {
    return JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version || 'unknown'
  } catch {
    return 'unknown'
  }
}

export function normalizeMode(value) {
  const mode = String(value ?? '').trim().toLowerCase()
  if (mode === '1' || mode === 'true' || mode === 'on' || mode === 'yes') return 'auto'
  if (mode === '0' || mode === 'false' || mode === 'no') return 'off'
  return VALID_MODES.has(mode) ? mode : 'auto'
}

function numberFromEnv(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function boolFromEnv(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  return /^(1|true|yes|on)$/i.test(String(raw))
}

export function defaultConfig() {
  return { v: RSI_VERSION, ...DEFAULTS, created_at: nowIso() }
}

export function ensureStore(dir = defaultStoreDir()) {
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'benchmarks'), { recursive: true })
  const config = join(dir, 'config.json')
  if (!existsSync(config)) writeJsonAtomic(config, defaultConfig())
  const meta = join(dir, 'meta.json')
  if (!existsSync(meta)) {
    writeJsonAtomic(meta, {
      v: RSI_VERSION,
      created_at: nowIso(),
      last_diagnosis_at: null,
      episodes_at_last_diagnosis: 0,
    })
  }
  return dir
}

export function storePath(dir, ...parts) {
  return join(ensureStore(dir), ...parts)
}

export function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, file)
}

export function readConfig(dir = defaultStoreDir()) {
  ensureStore(dir)
  return { ...defaultConfig(), ...readJson(join(dir, 'config.json'), {}) }
}

export function writeConfig(dir = defaultStoreDir(), patch = {}) {
  ensureStore(dir)
  const next = { ...readConfig(dir), ...patch, v: RSI_VERSION }
  writeJsonAtomic(join(dir, 'config.json'), next)
  return next
}

export function effectiveConfig(dir = defaultStoreDir()) {
  const base = readConfig(dir)
  return {
    ...base,
    store: dir,
    mode: normalizeMode(process.env.AH_RSI || base.mode),
    exploration: numberFromEnv('AH_RSI_EXPLORATION', base.exploration),
    active_control_rate: numberFromEnv('AH_RSI_CONTROL', base.active_control_rate),
    max_lessons: numberFromEnv('AH_RSI_MAX_LESSONS', base.max_lessons),
    max_tokens: numberFromEnv('AH_RSI_MAX_TOKENS', base.max_tokens),
    remote_judge: boolFromEnv('AH_RSI_REMOTE', base.remote_judge),
  }
}

export function readMeta(dir = defaultStoreDir()) {
  ensureStore(dir)
  return readJson(join(dir, 'meta.json'), { v: RSI_VERSION })
}

export function updateMeta(dir = defaultStoreDir(), patch = {}) {
  ensureStore(dir)
  const next = { ...readMeta(dir), ...patch, v: RSI_VERSION }
  writeJsonAtomic(join(dir, 'meta.json'), next)
  return next
}

export function readJsonl(dir, name, { tail = 0 } = {}) {
  ensureStore(dir)
  const file = join(dir, name)
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split('\n')
  const start = tail > 0 ? Math.max(0, lines.length - tail - 1) : 0
  const rows = []
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      // A truncated tail line is expected after an interrupted append.
      if (index !== lines.length - 1) throw new Error(`${name} line ${index + 1} is not valid JSON`)
    }
  }
  return rows
}

export function appendJsonl(dir, name, rows) {
  ensureStore(dir)
  const list = Array.isArray(rows) ? rows : [rows]
  if (!list.length) return
  appendFileSync(join(dir, name), `${list.map((row) => JSON.stringify(row)).join('\n')}\n`)
}

export async function withStoreLock(dir, fn) {
  ensureStore(dir)
  const lock = join(dir, '.lock')
  const started = Date.now()
  for (;;) {
    try {
      mkdirSync(lock)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lock).mtimeMs > 60_000) {
          rmSync(lock, { recursive: true, force: true })
          continue
        }
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10))
        continue
      }
      if (Date.now() - started > 10_000) throw new Error('RSI store is busy; retry the operation')
      await new Promise((resolveWait) => setTimeout(resolveWait, 25))
      continue
    }
    try {
      return await fn()
    } finally {
      rmSync(lock, { recursive: true, force: true })
    }
  }
}

export function normalizeLessonText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function lessonId(taskClass, text) {
  return `L${sha1(`${taskClass}|${normalizeLessonText(text)}`, 10)}`
}

export function projectInfo(cwd) {
  const root = findAhRoot(cwd) || cwd || process.cwd()
  return {
    key: sha1(resolve(root), 12),
    label: basename(resolve(root)) || 'workspace',
    ah: Boolean(findAhRoot(cwd)),
  }
}

export function appendLesson(dir, lesson, meta = {}) {
  appendJsonl(dir, 'lessons.jsonl', [{ v: RSI_VERSION, ts: nowIso(), op: 'upsert', lesson, ...meta }])
}

export function deleteLesson(dir, id, meta = {}) {
  appendJsonl(dir, 'lessons.jsonl', [{ v: RSI_VERSION, ts: nowIso(), op: 'delete', id, ...meta }])
}

export function currentLessons(dir = defaultStoreDir()) {
  const map = new Map()
  for (const row of readJsonl(dir, 'lessons.jsonl')) {
    if (row.op === 'delete') {
      map.delete(row.id)
      continue
    }
    if (row.lesson?.id) map.set(row.lesson.id, row.lesson)
  }
  return [...map.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

export function appendEpisode(dir, episode) {
  appendJsonl(dir, 'episodes.jsonl', [episode])
}

export function appendDecision(dir, decision) {
  appendJsonl(dir, 'decisions.jsonl', [decision])
}

export function appendBenchmark(dir, kind, row) {
  appendJsonl(dir, join('benchmarks', `${kind}.jsonl`), [row])
}

export function slug(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'lesson'
}

let oracleCache = null

export function engineVersion() {
  try {
    const text = readFileSync(join(HERE, 'vendor', 'academic-harness', 'pyproject.toml'), 'utf8')
    const match = text.match(/^version\s*=\s*"([^"]+)"/m)
    return match ? match[1] : 'unknown'
  } catch {
    return 'unknown'
  }
}

export function oracleManifest() {
  if (oracleCache) return oracleCache
  const hashFile = (relativePath) => {
    try {
      return sha1(readFileSync(join(HERE, relativePath), 'utf8'), 16)
    } catch {
      return null
    }
  }
  const base = {
    plugin_version: pluginVersion(),
    engine_version: engineVersion(),
    node: process.version,
    prompt_hash: hashFile('prompt.js'),
    hooks_hash: hashFile('academic-harness-hooks.js'),
    audit_hash: hashFile(join('vendor', 'academic-harness', 'ah', 'audit.py')),
  }
  oracleCache = { ...base, manifest_hash: sha1(JSON.stringify(base), 16) }
  return oracleCache
}
