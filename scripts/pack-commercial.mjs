#!/usr/bin/env node
/**
 * Build an npm tarball without the non-commercial (CC BY-NC) skills.
 *
 *   node scripts/pack-commercial.mjs [--out DIR] [--dry-run]     (npm run pack:commercial)
 *
 * Copies the working tree (tracked and untracked, ignoring what git ignores) to
 * a scratch directory, removes every skill whose licence label is a Creative
 * Commons NonCommercial one, and runs `npm pack` there. The tarball lands in
 * --out (default: the current directory). Nothing in the real tree changes.
 * `--dry-run` only lists the skills that would be left out.
 *
 * The six skills are found from their `license:` frontmatter, not from a list in
 * this script, so a newly vendored NC skill is excluded automatically. Mentions
 * of an excluded skill in prompts, workflows and docs remain as plain text; the
 * `skill` tool will report it as not found.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isNonCommercial, readLicense } from '../skill-licenses.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const outIndex = args.indexOf('--out')
const out = resolve(outIndex === -1 ? process.cwd() : args[outIndex + 1])

export function nonCommercialSkills(skillsDir) {
  const found = []
  for (const name of readdirSync(skillsDir).sort()) {
    const file = join(skillsDir, name, 'SKILL.md')
    if (!existsSync(file)) continue
    if (isNonCommercial(readLicense(readFileSync(file, 'utf8')))) found.push(name)
  }
  return found
}

const excluded = nonCommercialSkills(join(ROOT, 'skills'))
console.log(`non-commercial skills left out (${excluded.length}): ${excluded.join(', ')}`)
if (dryRun) process.exit(0)

// Scratch space goes under ~/.cache: /tmp here is a small tmpfs with a per-user quota.
const cache = join(homedir(), '.cache')
mkdirSync(cache, { recursive: true })
const scratch = mkdtempSync(join(cache, 'ah-pack-commercial-'))
try {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
  const copy = join(scratch, 'package')
  for (const rel of listed) {
    const from = join(ROOT, rel)
    let stat
    try {
      stat = lstatSync(from)
    } catch {
      continue // listed but deleted in the working tree
    }
    const to = join(copy, rel)
    mkdirSync(dirname(to), { recursive: true })
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to) // e.g. .opencode/skills/pele -> ../../skills/pele
    else cpSync(from, to)
  }
  for (const name of excluded) rmSync(join(copy, 'skills', name), { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const packed = execFileSync('npm', ['pack', '--pack-destination', out, '--silent'], { cwd: copy, encoding: 'utf8' }).trim().split('\n').pop()
  console.log(`wrote ${join(out, packed)}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
