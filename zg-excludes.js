/**
 * Translate PaperMemory runtime paths into zg index exclusion globs.
 *
 * Pure and environment-injectable so the zvec_index tool and the unit script
 * agree. The data directory (parent of the store DB) holds `corpus/` and the
 * SQLite/WAL files; a configured evidence directory is excluded wholesale.
 */
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const MAX_EXCLUDES = 32
const DEFAULT_DATA_DIR = ['.local', 'share', 'papermemory']

function expandUser(value) {
  const text = String(value)
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return join(homedir(), text.slice(2))
  return text
}

function toPosix(value) {
  return value.split(sep).join('/')
}

/** Resolve the store DB and optional evidence dir the same way PaperMemory does. */
export function resolvePaperMemoryPaths(env = process.env) {
  const dbOverride = String(env.PAPERMEMORY_DB || '').trim()
  const dataOverride = String(env.PAPERMEMORY_DATA_DIR || '').trim()
  const xdgOverride = String(env.XDG_DATA_HOME || '').trim()

  let dataDir
  if (dataOverride) dataDir = resolve(expandUser(dataOverride))
  else if (xdgOverride) dataDir = resolve(join(expandUser(xdgOverride), 'papermemory'))
  else dataDir = resolve(join(homedir(), ...DEFAULT_DATA_DIR))

  const store = dbOverride ? resolve(expandUser(dbOverride)) : join(dataDir, 'papermemory.db')
  const evidenceRaw = String(env.PAPERMEMORY_EVIDENCE_DIR || '').trim()
  const evidence = evidenceRaw ? resolve(expandUser(evidenceRaw)) : null
  return { dataDir, store, evidence }
}

function insideRoot(root, target) {
  const rel = relative(root, target)
  if (rel === '') return { rel: '' }
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return { rel: toPosix(rel) }
}

function runtimeGlobs(rel) {
  if (rel === '') return ['!corpus/**', '!*.db*', '!evidence/**']
  return [`!${rel}/corpus/**`, `!${rel}/*.db*`, `!${rel}/evidence/**`]
}

function normalizeUserExclude(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  return text.startsWith('!') ? text : `!${text}`
}

/**
 * Merge PaperMemory-derived exclusions with explicit user excludes.
 * Anything outside `root` (or outside the environment) contributes nothing.
 */
export function mergeExcludes(root, userExcludes = [], env = process.env) {
  const absRoot = resolve(String(root || '.'))
  const out = []
  const seen = new Set()
  const add = (glob) => {
    if (!glob || seen.has(glob) || out.length >= MAX_EXCLUDES) return
    seen.add(glob)
    out.push(glob)
  }

  const { store, evidence } = resolvePaperMemoryPaths(env)
  const storeDir = insideRoot(absRoot, dirname(store))
  if (storeDir) for (const glob of runtimeGlobs(storeDir.rel)) add(glob)
  if (evidence) {
    const evidenceDir = insideRoot(absRoot, evidence)
    if (evidenceDir && evidenceDir.rel !== '') add(`!${evidenceDir.rel}/**`)
  }

  const list = Array.isArray(userExcludes) ? userExcludes : [userExcludes]
  for (const value of list) add(normalizeUserExclude(value))
  return out
}
