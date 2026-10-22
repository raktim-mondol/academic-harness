#!/usr/bin/env node
/**
 * Migrate a DSH profile from dsh-researchcraft to academic-harness.
 *
 * Dry-run by default. `--apply` backs up the profile under
 * `$DSH_HOME/profile-migrations/<timestamp>-<profile>/`, renames the profile
 * directory when --to differs, moves the package dependency/bundle entries,
 * merges the old `researchcraft` host config into the `academic-harness` row,
 * and updates agent-preset-registry defaults.
 *
 * The profile patch is edited line-by-line on purpose: DSH patches use `!!js`
 * tags and comments, so a full YAML parse/re-serialize would be lossy.
 * Secret values are never printed.
 */
import {
  chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PACKAGE = 'academic-harness'
const OLD_PACKAGE = 'dsh-researchcraft'
const OLD_ROW = 'researchcraft'
const NEW_ROW = 'academic-harness'
const OLD_PRESET = 'researchcraft'
const NEW_PRESET = 'academic-harness'
const EPHEMERAL = new Set(['ZVEC_GREP_INDEX_STATE', 'ZVEC_GREP_INDEX_CANCEL'])
const PROFILE_FILES = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']

function usage() {
  console.error('usage: node scripts/migrate-profile.mjs --profile researchcraft [--to academic-harness] [--apply] [--dsh-home PATH]')
  process.exit(2)
}

function parseArgs(argv) {
  const out = { apply: false, profile: '', to: '', dshHome: process.env.DSH_HOME || join(homedir(), '.dsh') }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') out.apply = true
    else if (arg === '--profile') out.profile = argv[++i] || ''
    else if (arg === '--to') out.to = argv[++i] || ''
    else if (arg === '--dsh-home') out.dshHome = argv[++i] || ''
    else if (arg === '--help' || arg === '-h') usage()
    else usage()
  }
  if (!out.profile) usage()
  if (!out.to) out.to = out.profile
  return out
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

function topRow(line) {
  const match = line.match(/^-\s+id:\s*(['"]?)([^'"]+)\1\s*$/)
  return match ? match[2] : null
}

function findRow(lines, id) {
  for (let i = 0; i < lines.length; i += 1) if (topRow(lines[i]) === id) return i
  return -1
}

function rowEnd(lines, start) {
  for (let i = start + 1; i < lines.length; i += 1) if (topRow(lines[i])) return i
  return lines.length
}

function configLine(lines, start, end) {
  for (let i = start + 1; i < end; i += 1) if (/^\s+config:\s*$/.test(lines[i])) return i
  return -1
}

function configFields(lines, start, end) {
  const cfg = configLine(lines, start, end)
  if (cfg < 0) return new Map()
  const baseIndent = lines[cfg].match(/^\s*/)[0].length
  const fields = new Map()
  for (let i = cfg + 1; i < end; i += 1) {
    const line = lines[i]
    if (!line.trim()) continue
    const indent = line.match(/^\s*/)[0].length
    if (indent <= baseIndent) break
    const match = line.match(/^\s+([A-Z0-9_]+):\s*(.*)$/)
    if (!match || EPHEMERAL.has(match[1])) continue
    fields.set(match[1], match[2])
  }
  return fields
}

function renderHostRow(fields) {
  const row = [`- id: ${NEW_ROW}`, `  name: ${PACKAGE}`, '  config:']
  for (const [key, value] of fields) row.push(`    ${key}: ${value}`)
  return row
}

function updateRegistry(lines) {
  const start = findRow(lines, 'agent-preset-registry')
  if (start < 0) return false
  const end = rowEnd(lines, start)
  let changed = false
  for (let i = start; i < end; i += 1) {
    const next = lines[i]
      .replace(/^(\s+default:\s*)researchcraft$/u, `$1${NEW_PRESET}`)
      .replace(/^(\s+selectedDefault:\s*)researchcraft$/u, `$1${NEW_PRESET}`)
    if (next !== lines[i]) {
      lines[i] = next
      changed = true
    }
  }
  return changed
}

function migratePatch(text) {
  const lines = String(text || '').split(/\r?\n/)
  const oldStart = findRow(lines, OLD_ROW)
  const newStart = findRow(lines, NEW_ROW)
  const notes = []
  if (oldStart < 0 && newStart < 0) {
    const registry = updateRegistry(lines)
    return { text: lines.join('\n'), notes: registry ? ['agent-preset-registry default updated'] : [] }
  }

  const oldFields = oldStart >= 0 ? configFields(lines, oldStart, rowEnd(lines, oldStart)) : new Map()
  const newFields = newStart >= 0 ? configFields(lines, newStart, rowEnd(lines, newStart)) : new Map()
  const merged = new Map(oldFields)
  for (const [key, value] of newFields) if (value.trim()) merged.set(key, value)
  if (oldStart >= 0) notes.push(`migrated host row ${OLD_ROW} -> ${NEW_ROW}`)
  if (oldFields.size) notes.push(`host fields: ${[...merged.keys()].join(', ')}`)

  const rendered = renderHostRow(merged)
  const insertAt = oldStart >= 0 ? oldStart : newStart
  const removals = [oldStart, newStart].filter((i) => i >= 0).sort((a, b) => b - a)
  for (const start of removals) lines.splice(start, rowEnd(lines, start) - start)
  lines.splice(insertAt, 0, ...rendered, '')
  if (updateRegistry(lines)) notes.push('agent-preset-registry default updated')
  return { text: lines.join('\n'), notes }
}

function migratePackageJson(text) {
  const pkg = JSON.parse(text)
  const notes = []
  if (pkg.dependencies && pkg.dependencies[OLD_PACKAGE] !== undefined) {
    if (pkg.dependencies[PACKAGE] === undefined) pkg.dependencies[PACKAGE] = pkg.dependencies[OLD_PACKAGE]
    delete pkg.dependencies[OLD_PACKAGE]
    notes.push(`dependency ${OLD_PACKAGE} -> ${PACKAGE}`)
  }
  const bundles = pkg.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.includes(OLD_PACKAGE)) {
    pkg.dsh.profile.bundles = [...new Set(bundles.map((name) => (name === OLD_PACKAGE ? PACKAGE : name)))]
    notes.push(`bundle ${OLD_PACKAGE} -> ${PACKAGE}`)
  }
  if (pkg.name === 'dsh-profile-researchcraft') {
    pkg.name = 'dsh-profile-academic-harness'
    notes.push('profile package name updated')
  }
  return { text: `${JSON.stringify(pkg, null, 2)}\n`, notes }
}

function backupProfile(sourceDir, backupRoot) {
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 })
  chmodSync(backupRoot, 0o700)
  for (const file of PROFILE_FILES) {
    const from = join(sourceDir, file)
    if (!existsSync(from)) continue
    const to = join(backupRoot, file)
    cpSync(from, to)
    chmodSync(to, 0o600)
  }
}

function applyMigration({ dshHome, profile, to, apply }) {
  const profiles = join(dshHome, 'profiles')
  const sourceDir = join(profiles, profile)
  const targetDir = join(profiles, to)
  if (!existsSync(sourceDir)) throw new Error(`profile not found: ${sourceDir}`)
  if (sourceDir !== targetDir && existsSync(targetDir)) throw new Error(`target profile already exists: ${targetDir}`)

  const patchPath = join(sourceDir, 'cordis.patch.yml')
  const packagePath = join(sourceDir, 'package.json')
  const patchText = readText(patchPath)
  const packageText = readText(packagePath)
  const patch = patchText === null ? { text: null, notes: [] } : migratePatch(patchText)
  const pkg = packageText === null ? { text: null, notes: [] } : migratePackageJson(packageText)

  console.log(`profile: ${sourceDir}${sourceDir === targetDir ? '' : ` -> ${targetDir}`}`)
  for (const note of [...pkg.notes, ...patch.notes]) console.log(`  - ${note}`)
  if (!patch.notes.length && !pkg.notes.length) console.log('  - no changes needed')
  if (!apply) {
    console.log('dry run: re-run with --apply to write the migration')
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupRoot = join(dshHome, 'profile-migrations', `${stamp}-${profile}`)
  backupProfile(sourceDir, backupRoot)
  console.log(`backup: ${backupRoot}`)

  if (sourceDir !== targetDir) {
    renameSync(sourceDir, join(backupRoot, 'original-profile'))
    mkdirSync(targetDir, { recursive: true })
    for (const file of PROFILE_FILES) {
      const from = join(backupRoot, file)
      if (existsSync(from)) cpSync(from, join(targetDir, file))
    }
  }
  const outPatch = join(targetDir, 'cordis.patch.yml')
  if (patch.text !== null) writeAtomic(outPatch, patch.text)
  const outPackage = join(targetDir, 'package.json')
  if (pkg.text !== null) writeAtomic(outPackage, pkg.text)
  console.log(`migrated: ${targetDir}`)
  console.log(`next: dsh plugin --profile ${to} install`)
}

try {
  applyMigration(parseArgs(process.argv.slice(2)))
} catch (error) {
  console.error(`migrate-profile: ${error.message}`)
  process.exit(1)
}
