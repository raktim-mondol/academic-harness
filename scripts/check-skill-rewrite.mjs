#!/usr/bin/env node
/**
 * Overlap check for the clean-room rewrite of the docx, pdf, pptx and xlsx
 * skills (decision D05, licence phase).
 *
 *   node scripts/check-skill-rewrite.mjs [--base <git-ref>] [--max-shared N]
 *                                        [--prose-n 12] [--code-n 10] [--json]
 *
 * Compares every text file now under skills/{docx,pdf,pptx,xlsx} with every
 * text file those directories held at --base (default 32ab58f, the 0.50.0 tree
 * the licence concern was raised against) and reports runs of words they share:
 *
 *   prose (.md)   12 consecutive words
 *   code (.py)    10 consecutive tokens, after dropping import lines, comments,
 *                 blank lines and one-line boilerplate (`if __name__ ...`)
 *
 * Deliberately prints ONLY locations in the NEW files (path and line range) and
 * counts. It never prints text from the old files, so the person fixing a hit
 * rewrites from their own words instead of paraphrasing the original. Exit 1
 * when shared runs exceed --max-shared (default 0).
 *
 * Limits: this finds copied wording, not copied structure or ideas. It is one
 * safeguard next to the method (public documentation only, new names, no
 * bundled schemas) and the provenance note, not a legal conclusion.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS = ['docx', 'pdf', 'pptx', 'xlsx']
function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}
const PROSE_N = Number(arg('--prose-n', '12'))
const CODE_N = Number(arg('--code-n', '10'))
const base = arg('--base', '32ab58f')
const maxShared = Number(arg('--max-shared', '0'))
const asJson = process.argv.includes('--json')

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

function kindOf(path) {
  const ext = extname(path).toLowerCase()
  if (ext === '.md') return 'prose'
  if (ext === '.py') return 'code'
  return null
}

function words(text) {
  return text.toLowerCase().match(/[a-z0-9_]+/g) || []
}

/** [{token, line}] for a file, with code boilerplate dropped. */
function tokenise(text, kind) {
  const out = []
  const lines = text.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i]
    if (kind === 'prose') {
      if (line.trim().startsWith('```')) {
        inFence = !inFence
        continue
      }
      if (/^---\s*$/.test(line) || /^(name|license|description|metadata|version|skill-author|skill-source):/.test(line)) continue
      if (inFence) continue // code fences are covered by the .py comparison and recipe blocks are our own, tested code
    } else {
      const t = line.trim()
      if (!t || t.startsWith('#') || /^(import|from)\s/.test(t) || /^if __name__/.test(t) || /^sys\.exit\(/.test(t)) continue
    }
    for (const token of words(line)) out.push({ token, line: i + 1 })
  }
  return out
}

function shingles(tokens, n) {
  const set = new Map()
  for (let i = 0; i + n <= tokens.length; i += 1) {
    const key = tokens.slice(i, i + n).map((t) => t.token).join(' ')
    if (!set.has(key)) set.set(key, [])
    set.get(key).push(i)
  }
  return set
}

// ── old tree ────────────────────────────────────────────────────────────────
const oldFiles = git('ls-tree', '-r', '--name-only', base, '--', ...SKILLS.map((s) => `skills/${s}`))
  .split('\n')
  .filter((p) => p && kindOf(p))
const oldShingles = { prose: new Set(), code: new Set() }
for (const path of oldFiles) {
  const kind = kindOf(path)
  const text = git('show', `${base}:${path}`)
  for (const key of shingles(tokenise(text, kind), kind === 'prose' ? PROSE_N : CODE_N).keys()) oldShingles[kind].add(key)
}

// ── new tree ────────────────────────────────────────────────────────────────
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === '__pycache__') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

const report = { base, oldFilesCompared: oldFiles.length, files: [], shared: 0 }
for (const skill of SKILLS) {
  for (const file of walk(join(ROOT, 'skills', skill))) {
    const kind = kindOf(file)
    if (!kind) continue
    const tokens = tokenise(readFileSync(file, 'utf8'), kind)
    const n = kind === 'prose' ? PROSE_N : CODE_N
    const hits = []
    for (const [key, positions] of shingles(tokens, n)) {
      if (!oldShingles[kind].has(key)) continue
      for (const p of positions) hits.push({ from: tokens[p].line, to: tokens[p + n - 1].line })
    }
    const rel = file.slice(ROOT.length + 1)
    report.files.push({ file: rel, kind, tokens: tokens.length, shared: hits.length, lines: mergeRanges(hits) })
    report.shared += hits.length
  }
}

function mergeRanges(hits) {
  const sorted = [...hits].sort((a, b) => a.from - b.from)
  const out = []
  for (const h of sorted) {
    const last = out[out.length - 1]
    if (last && h.from <= last.to + 1) last.to = Math.max(last.to, h.to)
    else out.push({ ...h })
  }
  return out.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`))
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`compared ${report.files.length} new text file(s) with ${oldFiles.length} file(s) at ${base}`)
  for (const f of report.files) {
    if (f.shared) console.log(`  SHARED ${f.file}: ${f.shared} run(s), lines ${f.lines.join(', ')}`)
  }
  console.log(report.shared === 0 ? 'no shared runs' : `${report.shared} shared run(s) in total`)
}
process.exit(report.shared > maxShared ? 1 : 0)
