#!/usr/bin/env node
/**
 * seed.js retires an installed copy of the old restricted docx/pdf/pptx/xlsx
 * skills (recognised by their LICENSE.txt) and installs the bundled rewrite,
 * but leaves a user's own skill of the same name alone.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = '32ab58f' // the 0.50.0 tree that shipped the restricted copies

let oldLicense
try {
  oldLicense = execFileSync('git', ['show', `${BASE}:skills/docx/LICENSE.txt`], { cwd: ROOT, maxBuffer: 1 << 20 })
} catch {
  console.log(`SKIP  seed-restricted: ${BASE} is not available in this checkout (shallow clone?)`)
  process.exit(0)
}

const home = mkdtempSync(join(tmpdir(), 'ah-seed-restricted-'))
process.env.DSH_HOME = home
const { seed, retireRestrictedSkills } = await import('../seed.js')

let passed = 0
function check(label, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL  ${label}\n${error.stack}`)
    process.exitCode = 1
  }
}

const skills = join(home, 'skills')
function install(name, license, extra = {}) {
  const dir = join(skills, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\nold copy\n`)
  if (license != null) writeFileSync(join(dir, 'LICENSE.txt'), license)
  for (const [file, body] of Object.entries(extra)) writeFileSync(join(dir, file), body)
}

install('docx', oldLicense)
install('pdf', oldLicense, { 'forms.md': 'old' })
install('pptx', 'my own licence text')       // a user's own skill with a different licence
install('xlsx', null)                        // no LICENSE.txt at all

const warnings = []
const warn = console.warn
console.warn = (...args) => warnings.push(args.join(' '))
seed()
console.warn = warn

check('a copy carrying the old LICENSE.txt is moved out of the catalogue, not deleted', () => {
  const retired = join(home, 'skills-retired')
  assert.ok(existsSync(join(retired, 'docx', 'LICENSE.txt')))
  assert.ok(existsSync(join(retired, 'pdf', 'forms.md')))
  assert.equal(readFileSync(join(retired, 'docx', 'SKILL.md'), 'utf8').includes('old copy'), true)
})

check('the bundled rewrite is installed in its place', () => {
  for (const name of ['docx', 'pdf']) {
    const text = readFileSync(join(skills, name, 'SKILL.md'), 'utf8')
    assert.ok(!text.includes('old copy'), `${name} still the old copy`)
    assert.match(text, /license: MIT/)
    assert.ok(!existsSync(join(skills, name, 'LICENSE.txt')))
  }
  assert.ok(existsSync(join(skills, 'docx', 'scripts', 'docx_track.py')))
})

check("a user's own skill with the same name (different or no LICENSE.txt) is left alone", () => {
  assert.equal(readFileSync(join(skills, 'pptx', 'LICENSE.txt'), 'utf8'), 'my own licence text')
  assert.ok(readFileSync(join(skills, 'pptx', 'SKILL.md'), 'utf8').includes('old copy'))
  assert.ok(readFileSync(join(skills, 'xlsx', 'SKILL.md'), 'utf8').includes('old copy'))
  assert.ok(!existsSync(join(home, 'skills-retired', 'pptx')))
  assert.ok(!existsSync(join(home, 'skills-retired', 'xlsx')))
})

check('the move is announced once per skill', () => {
  const lines = warnings.filter((w) => w.includes('moved the previously installed copy'))
  assert.equal(lines.length, 2)
  assert.ok(lines.every((l) => l.includes('skills-retired')))
})

check('running seed again changes nothing and does not retire the rewrite', () => {
  const before = readFileSync(join(skills, 'docx', 'SKILL.md'), 'utf8')
  seed()
  assert.equal(readFileSync(join(skills, 'docx', 'SKILL.md'), 'utf8'), before)
  assert.deepEqual(retireRestrictedSkills(skills), [])
})

check('a second retired copy gets a numbered name instead of overwriting the first', () => {
  const again = mkdtempSync(join(tmpdir(), 'ah-seed-restricted-2-'))
  const dest = join(again, 'skills')
  for (let round = 0; round < 2; round += 1) {
    mkdirSync(join(dest, 'docx'), { recursive: true })
    writeFileSync(join(dest, 'docx', 'LICENSE.txt'), oldLicense)
    assert.equal(retireRestrictedSkills(dest).length, 1)
  }
  assert.ok(existsSync(join(again, 'skills-retired', 'docx')))
  assert.ok(existsSync(join(again, 'skills-retired', 'docx-2')))
  rmSync(again, { recursive: true, force: true })
})

rmSync(home, { recursive: true, force: true })
if (process.exitCode) console.error('seed restricted: FAILED')
else console.log(`seed restricted: ${passed} checks passed`)
