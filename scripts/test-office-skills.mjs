#!/usr/bin/env node
/**
 * The rewritten docx, pdf, pptx and xlsx skills (decision D05, licence phase).
 *
 *  1. Structure: frontmatter, MIT licence, every script a SKILL.md names exists,
 *     the shared ooxml_tools.py is byte-identical in all three Office skills.
 *  2. Provenance guard: none of the four skills carries a restricted LICENSE.txt,
 *     a bundled ECMA/ISO/Microsoft schema, or the old helper layout.
 *  3. Behaviour: each skill's Python unit tests (python-docx, openpyxl, pypdf,
 *     reportlab, python-pptx, lxml). Set AH_OFFICE_PYTHON to the interpreter that
 *     has them. Tests whose optional library or tool is missing skip and say so;
 *     when no interpreter has the core libraries the behavioural part is skipped
 *     with a notice instead of failing, so a plain checkout still runs `npm test`.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS = ['docx', 'pdf', 'pptx', 'xlsx']
const OFFICE = ['docx', 'pptx', 'xlsx']

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

function frontmatter(skill) {
  const text = readFileSync(join(ROOT, 'skills', skill, 'SKILL.md'), 'utf8')
  const match = text.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(match, `${skill}/SKILL.md has no frontmatter`)
  const fields = {}
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (m) fields[m[1]] = m[2].replace(/^"|"$/g, '')
  }
  return { fields, body: text.slice(match[0].length), text }
}

for (const skill of SKILLS) {
  check(`${skill}: frontmatter names the skill, is MIT, and describes when to use it`, () => {
    const { fields } = frontmatter(skill)
    assert.equal(fields.name, skill)
    assert.equal(fields.license, 'MIT')
    assert.ok(fields.description.length > 80 && fields.description.length < 700, `description length ${fields.description.length}`)
    assert.match(fields.description, /Use (for|to|when)/)
  })

  check(`${skill}: every script and reference SKILL.md names exists`, () => {
    const { text } = frontmatter(skill)
    const named = new Set([...text.matchAll(/(?:scripts|references)\/[\w./-]+\.(?:py|md)/g)].map((m) => m[0]))
    assert.ok(named.size > 0, 'SKILL.md names no scripts')
    for (const rel of named) assert.ok(existsSync(join(ROOT, 'skills', skill, rel)), `${skill}/SKILL.md names ${rel}, which does not exist`)
  })

  check(`${skill}: no restricted licence file, bundled schema or legacy helper layout`, () => {
    const files = walk(join(ROOT, 'skills', skill))
    assert.deepEqual(files.filter((f) => /LICENSE(\.txt)?$/i.test(f)), [], 'no LICENSE.txt: the skill is MIT like the package')
    assert.deepEqual(files.filter((f) => f.endsWith('.xsd')), [], 'no bundled ECMA/ISO/Microsoft schema files')
    assert.deepEqual(files.filter((f) => /\/scripts\/office\//.test(f)), [], 'no legacy scripts/office tree')
    for (const file of files.filter((f) => /\.(md|py|txt)$/.test(f))) {
      const body = readFileSync(file, 'utf8')
      assert.ok(!/all rights reserved/i.test(body), `${file} contains "all rights reserved"`)
      assert.ok(!/anthropic, pbc/i.test(body), `${file} carries an Anthropic copyright line`)
    }
  })
}

check('ooxml_tools.py is byte-identical in the docx, pptx and xlsx skills', () => {
  const hashes = OFFICE.map((s) => createHash('sha256').update(readFileSync(join(ROOT, 'skills', s, 'scripts', 'ooxml_tools.py'))).digest('hex'))
  assert.equal(new Set(hashes).size, 1, `copies differ: ${hashes.map((h) => h.slice(0, 8)).join(' ')}`)
})

check('the four skills stay small (no bundled schemas or binaries)', () => {
  for (const skill of SKILLS) {
    const bytes = walk(join(ROOT, 'skills', skill)).reduce((sum, f) => sum + statSync(f).size, 0)
    assert.ok(bytes < 400_000, `${skill} is ${bytes} bytes`)
  }
})

// ── behaviour ────────────────────────────────────────────────────────────────
function pythonWith(modules) {
  const candidates = [process.env.AH_OFFICE_PYTHON, 'python3', 'python'].filter(Boolean)
  for (const py of candidates) {
    const probe = spawnSync(py, ['-c', modules.map((m) => `import ${m}`).join('; ')], { encoding: 'utf8' })
    if (probe.status === 0) return py
  }
  return null
}

const core = {
  docx: ['docx', 'lxml'],
  pdf: ['pypdf', 'reportlab'],
  pptx: ['pptx', 'PIL'],
  xlsx: ['openpyxl', 'lxml'],
}
for (const skill of SKILLS) {
  const py = pythonWith(core[skill])
  if (!py) {
    console.log(`SKIP  ${skill} unit tests: no Python with ${core[skill].join(', ')} (set AH_OFFICE_PYTHON)`)
    continue
  }
  check(`${skill}: Python unit tests pass`, () => {
    const result = spawnSync(py, ['-m', 'unittest', 'discover', '-s', join(ROOT, 'skills', skill, 'tests')], {
      encoding: 'utf8',
      cwd: ROOT,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    const tail = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-12).join('\n')
    assert.equal(result.status, 0, tail)
    const ran = (result.stderr.match(/Ran (\d+) tests?/) || [])[1]
    const skipped = (result.stderr.match(/skipped=(\d+)/) || [])[1]
    console.log(`      ${skill}: ${ran} tests${skipped ? `, ${skipped} skipped (optional library or tool missing)` : ''}`)
  })
}

if (process.exitCode) console.error('office skills: FAILED')
else console.log(`office skills: ${passed} checks passed`)
