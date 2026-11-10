#!/usr/bin/env node
/**
 * What the published package contains (decision D44).
 *
 * Parses `npm pack --dry-run --json` and asserts:
 *  1. development-only trees (scripts/, docs/, reports/, vendored tests) are not shipped;
 *  2. every relative import in a shipped .js/.mjs file resolves to a shipped file,
 *     so a new root module that is missing from package.json "files" fails here
 *     instead of at a user's first start (compute-approval.js nearly shipped that way);
 *  3. `main` and every `exports` target are shipped.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
function check(label, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL  ${label}\n${error.message}`)
    process.exitCode = 1
  }
}

const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'ignore'],
})
const pack = JSON.parse(raw)[0]
const shipped = new Set(pack.files.map((f) => f.path))
console.log(`pack: ${pack.entryCount} files, ${(pack.size / 1048576).toFixed(1)} MiB packed, ${(pack.unpackedSize / 1048576).toFixed(1)} MiB unpacked`)

check('development-only trees are not shipped', () => {
  const leaked = [...shipped].filter((p) => /^(scripts|docs|reports)\//.test(p) || /^vendor\/[^/]+\/tests\//.test(p))
  assert.deepEqual(leaked.slice(0, 10), [], `${leaked.length} development-only file(s) are in the package`)
})

check('every relative import in a shipped module is shipped', () => {
  const missing = []
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"\n]+)\1/g
  for (const path of shipped) {
    if (!/\.(m?js)$/.test(path) || path.startsWith('lib/') || path.startsWith('skills/') || path.startsWith('vendor/')) continue
    const text = readFileSync(join(ROOT, path), 'utf8')
    for (const m of text.matchAll(re)) {
      const target = posix.normalize(posix.join(posix.dirname(path), m[2]))
      if (!shipped.has(target)) missing.push(`${path} -> ${m[2]}`)
    }
  }
  assert.deepEqual(missing, [], 'imported but not in the package; add the file to "files" in package.json')
})

check('main and exports targets are shipped', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const targets = new Set()
  if (pkg.main) targets.add(pkg.main)
  const walk = (v) => {
    if (typeof v === 'string') targets.add(v)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(pkg.exports)
  const missing = []
  for (const target of targets) {
    const path = posix.normalize(target)
    if (path.includes('*')) {
      const re = new RegExp(`^${path.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`)
      if (![...shipped].some((p) => re.test(p))) missing.push(target)
    } else if (!shipped.has(path)) missing.push(target)
  }
  assert.deepEqual(missing, [])
})

check('the vendored engine and PaperMemory sources are shipped', () => {
  for (const p of ['vendor/academic-harness/pyproject.toml', 'vendor/academic-harness/ah/hooks.py', 'vendor/papermemory/pyproject.toml']) assert.ok(shipped.has(p), `${p} missing`)
})

if (process.exitCode) console.error('package files: FAILED')
else console.log(`package files: ${passed} checks passed`)
