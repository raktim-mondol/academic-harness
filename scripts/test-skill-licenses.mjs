#!/usr/bin/env node
/**
 * Skill licence labels (decision D08, review C2/C3): the mapping to SPDX is
 * conservative, the repo is fully normalised, every non-commercial skill is
 * named in NOTICE, and nothing unresolved is silently guessed.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { excludeNonCommercial, isNonCommercial, normalize, readLicense } from '../skill-licenses.js'

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

check('readLicense reads the frontmatter field, with or without quotes, and nothing else', () => {
  assert.equal(readLicense('---\nname: x\nlicense: MIT\n---\nbody\nlicense: GPL\n'), 'MIT')
  assert.equal(readLicense('---\nname: x\nlicense: "Apache-2.0"\n---\n'), 'Apache-2.0')
  assert.equal(readLicense('---\nname: x\n---\nlicense: MIT\n'), null)
  assert.equal(readLicense('no frontmatter\nlicense: MIT\n'), null)
})

check('known spellings map to SPDX identifiers', () => {
  for (const [raw, spdx] of [
    ['MIT', 'MIT'], ['MIT license', 'MIT'], ['MIT License', 'MIT'],
    ['BSD-3-Clause license', 'BSD-3-Clause'], ['3-clause BSD license', 'BSD-3-Clause'],
    ['BSD-2-Clause license', 'BSD-2-Clause'],
    ['Apache-2.0 license', 'Apache-2.0'], ['Apache License, Version 2.0', 'Apache-2.0'],
    ['CC BY-NC-SA 4.0', 'CC-BY-NC-SA-4.0'], ['https://creativecommons.org/licenses/by/4.0/', 'CC-BY-4.0'],
  ]) assert.equal(normalize(raw).spdx, spdx, raw)
  assert.equal(normalize('MIT').changed, false)
  assert.equal(normalize('MIT license').changed, true)
})

check('ambiguous labels are reported, never guessed', () => {
  for (const raw of ['Unknown', 'BSD license', 'GPLv3 license', 'GPL-2.0 license', 'https://github.com/sympy/sympy/blob/master/LICENSE',
    'CeCILL FREE SOFTWARE LICENSE AGREEMENT', 'Proprietary (API key required)', 'This skill is provided under the MIT License. IDC data has its own terms.', null]) {
    const result = normalize(raw)
    assert.ok(result.unresolved, `${raw} should be unresolved, got ${JSON.stringify(result)}`)
    assert.equal(result.spdx, undefined)
  }
})

check('non-commercial labels are recognised in either spelling', () => {
  assert.ok(isNonCommercial('CC-BY-NC-SA-4.0'))
  assert.ok(isNonCommercial('CC BY-NC-SA 4.0'))
  assert.ok(isNonCommercial('CC-BY-NC-4.0'))
  assert.ok(!isNonCommercial('CC-BY-4.0'))
  assert.ok(!isNonCommercial('MIT'))
  assert.ok(!isNonCommercial(null))
})

check('AH_EXCLUDE_NONCOMMERCIAL parses as a switch', () => {
  assert.equal(excludeNonCommercial({}), false)
  assert.equal(excludeNonCommercial({ AH_EXCLUDE_NONCOMMERCIAL: '0' }), false)
  for (const v of ['1', 'true', 'YES']) assert.equal(excludeNonCommercial({ AH_EXCLUDE_NONCOMMERCIAL: v }), true)
})

const skills = readdirSync(join(ROOT, 'skills')).filter((n) => {
  try {
    readFileSync(join(ROOT, 'skills', n, 'SKILL.md'))
    return true
  } catch {
    return false
  }
})
const labels = new Map(skills.map((n) => [n, readLicense(readFileSync(join(ROOT, 'skills', n, 'SKILL.md'), 'utf8'))]))

check('every bundled skill with a mappable label already uses the SPDX form', () => {
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'normalize-skill-licenses.mjs'), '--check'], { encoding: 'utf8' })
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
})

check('the non-commercial skills are exactly the six NOTICE names, and each is named there', () => {
  const nc = [...labels].filter(([, raw]) => isNonCommercial(raw)).map(([n]) => n).sort()
  assert.deepEqual(nc, ['deep-research', 'intro-drafter', 'paper-polish', 'paper-writer', 'rebuttal-guidance', 'what-if-oracle'])
  const notice = readFileSync(join(ROOT, 'NOTICE'), 'utf8')
  for (const name of nc) assert.ok(notice.includes(name), `NOTICE does not name ${name}`)
  assert.match(notice, /six non-commercial skills/)
})

check('the five GPL-labelled skills are left as they were and explained in NOTICE', () => {
  const notice = readFileSync(join(ROOT, 'NOTICE'), 'utf8')
  for (const name of ['bioservices', 'cobrapy', 'etetoolkit', 'pathml', 'scikit-survival']) {
    assert.match(labels.get(name) ?? '', /GPL/i, `${name} label changed`)
    assert.ok(notice.includes(name), `NOTICE does not mention ${name}`)
  }
})

check('the four rewritten skills are MIT and carry no restricted label', () => {
  for (const name of ['docx', 'pdf', 'pptx', 'xlsx']) assert.equal(labels.get(name), 'MIT')
})

check('the committed inventory lists every unresolved skill', () => {
  const inventory = readFileSync(join(ROOT, 'docs', 'legal', 'skill-licence-inventory.md'), 'utf8')
  const unresolved = [...labels].filter(([, raw]) => normalize(raw).unresolved).map(([n]) => n)
  const missing = unresolved.filter((n) => !inventory.includes(`\`${n}\``))
  assert.deepEqual(missing, [], 'run: node scripts/normalize-skill-licenses.mjs --report docs/legal/skill-licence-inventory.md')
})

if (process.exitCode) console.error('skill licenses: FAILED')
else console.log(`skill licenses: ${passed} checks passed`)
