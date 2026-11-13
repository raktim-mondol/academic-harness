#!/usr/bin/env node
/**
 * Decision D07: a build can leave out all six CC BY-NC skills.
 *  - the seeder honours AH_EXCLUDE_NONCOMMERCIAL=1
 *  - `npm run pack:commercial` makes a tarball with none of them, and with the rest
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SIX = ['deep-research', 'intro-drafter', 'paper-polish', 'paper-writer', 'rebuttal-guidance', 'what-if-oracle']

// Scratch under ~/.cache: /tmp is a small per-user tmpfs here.
const cache = join(homedir(), '.cache')
mkdirSync(cache, { recursive: true })
const scratch = mkdtempSync(join(cache, 'ah-nc-test-'))

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

try {
  check('seeding with AH_EXCLUDE_NONCOMMERCIAL=1 skips exactly the six and installs the rest', () => {
    const home = join(scratch, 'excluded-home')
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', "const { seed } = await import(process.argv[1]); seed()", join(ROOT, 'seed.js')], {
      env: { ...process.env, DSH_HOME: home, AH_EXCLUDE_NONCOMMERCIAL: '1', AH_SKILLS_SEED: 'all' },
      encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr)
    const installed = new Set(readdirSync(join(home, 'skills')))
    for (const name of SIX) assert.ok(!installed.has(name), `${name} was installed`)
    for (const name of ['docx', 'pdf', 'scientific-slides', 'paper2mcp', 'vastai']) assert.ok(installed.has(name), `${name} missing`)
    assert.ok(installed.size > 700, `only ${installed.size} skills installed`)
  })

  check('seeding without the switch installs all six', () => {
    const home = join(scratch, 'full-home')
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', "const { seed } = await import(process.argv[1]); seed()", join(ROOT, 'seed.js')], {
      env: { ...process.env, DSH_HOME: home, AH_EXCLUDE_NONCOMMERCIAL: '', AH_SKILLS_SEED: 'all' },
      encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr)
    for (const name of SIX) assert.ok(existsSync(join(home, 'skills', name, 'SKILL.md')), `${name} missing`)
  })

  check('pack:commercial --dry-run names the six', () => {
    const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'pack-commercial.mjs'), '--dry-run'], { encoding: 'utf8' })
    for (const name of SIX) assert.ok(out.includes(name), name)
    assert.match(out, /\(6\)/)
  })

  check('the commercial tarball contains none of the six and still contains the rest', () => {
    const out = join(scratch, 'tarball')
    const log = execFileSync(process.execPath, [join(ROOT, 'scripts', 'pack-commercial.mjs'), '--out', out], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const tarball = readdirSync(out).find((f) => f.endsWith('.tgz'))
    assert.ok(tarball, `no tarball written:\n${log}`)
    const listing = execFileSync('tar', ['-tzf', join(out, tarball)], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\n')
    for (const name of SIX) {
      assert.deepEqual(listing.filter((p) => p.startsWith(`package/skills/${name}/`)), [], `${name} is in the tarball`)
    }
    for (const name of ['docx', 'pdf', 'pptx', 'xlsx', 'scientific-slides', 'paper2mcp']) {
      assert.ok(listing.some((p) => p === `package/skills/${name}/SKILL.md`), `${name} missing from the tarball`)
    }
    assert.ok(listing.includes('package/NOTICE'))
    assert.ok(listing.includes('package/skill-licenses.js'))
    assert.deepEqual(listing.filter((p) => /\.xsd$/.test(p)), [], 'no schema files')
    assert.deepEqual(listing.filter((p) => /^package\/skills\/(docx|pdf|pptx|xlsx)\/LICENSE/.test(p)), [], 'no restricted LICENSE.txt')
  })
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (process.exitCode) console.error('noncommercial exclusion: FAILED')
else console.log(`noncommercial exclusion: ${passed} checks passed`)
