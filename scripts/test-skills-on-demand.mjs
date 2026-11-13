#!/usr/bin/env node
/**
 * Skills on demand (decision D39).
 *
 * The host catalogue lists only the core skills; the rest of the bundle is
 * found with skill_search and read with skill_load. Pins: the core list is
 * current and covers every skill the prompt names; search and load behave and
 * refuse path tricks; seeding copies only core skills and prunes earlier full
 * copies without touching a skill the user edited; the registered tools render;
 * the catalogue the host would publish shrinks by an order of magnitude.
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveCore } from './build-skills-core.mjs'
import { BUNDLED_SKILLS_DIR, bundledSkills, coreSkillNames, isNonCommercialLicense, loadSkill, renderLoadedSkill, resetSkillIndexForTests, searchSkills } from '../skill-index.js'
import { seedSkills } from '../seed.js'
import { apply as applySkillTools } from '../skill-on-demand.js'
import { ACADEMIC_HARNESS_PROMPT } from '../prompt.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(join(process.env.AH_TEST_TMP || tmpdir(), 'ah-skills-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

let passed = 0
async function check(label, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL  ${label}\n${error.stack || error.message}`)
    process.exitCode = 1
  }
}

function writeSkill(root, name, { description = `Skill ${name} for testing things.`, license = 'MIT', body = `# ${name}\n\nDo the thing.\n` } = {}) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\nlicense: ${license}\n---\n\n${body}`)
  return dir
}

const core = coreSkillNames()

await check('skills-core.json is current and every listed skill is bundled', () => {
  assert.deepEqual([...core].sort(), deriveCore(ROOT))
  for (const name of core) assert.ok(existsSync(join(BUNDLED_SKILLS_DIR, name, 'SKILL.md')), `${name} is not bundled`)
  assert.ok(core.size >= 40 && core.size < 150, `core size ${core.size}`)
})

await check('every skill the system prompt names in backticks is core, so the catalogue keeps serving it', () => {
  const bundled = new Set(bundledSkills().map((s) => s.name))
  const named = new Set()
  for (const m of ACADEMIC_HARNESS_PROMPT.matchAll(/`([a-z0-9][a-z0-9-]+)`/g)) if (bundled.has(m[1])) named.add(m[1])
  assert.ok(named.size > 30, `only ${named.size} skills recognised in the prompt`)
  assert.deepEqual([...named].filter((n) => !core.has(n)), [])
})

await check('search ranks by task, puts an exact name first, flags catalogue skills, and honours the limit', () => {
  const r = searchSkills('single cell rna-seq clustering', { limit: 5 })
  assert.ok(r.results.length > 0 && r.results.length <= 5)
  assert.equal(r.results[0].name, 'scanpy')
  assert.equal(r.results[0].in_catalog, true)
  assert.ok(r.results.some((x) => !x.in_catalog), 'a non-core skill is reachable by search')
  assert.equal(searchSkills('anndata').results[0].name, 'anndata')
  assert.equal(searchSkills('scanpy', { limit: 3 }).results[0].name, 'scanpy')
  assert.ok(r.results.every((x) => x.description.length <= 240))
  assert.deepEqual(searchSkills('   ').results, [])
  assert.deepEqual(searchSkills('zzqxv nonsense').results, [])
  assert.equal(r.total, bundledSkills().length)
})

await check('load returns the body without frontmatter, with the base directory; bad names are refused', () => {
  const ok = loadSkill('scanpy')
  assert.equal(ok.name, 'scanpy')
  assert.ok(!ok.content.startsWith('---'))
  assert.match(ok.content, /Scanpy/)
  assert.equal(ok.base_directory, join(BUNDLED_SKILLS_DIR, 'scanpy'))
  const text = renderLoadedSkill(ok)
  assert.match(text, /^<skill_content name="scanpy">/)
  assert.match(text, /Base directory for this skill:/)
  for (const bad of ['../package', '..', 'a/b', 'Scanpy', '', ' ', 'x'.repeat(200), '/etc/passwd']) {
    assert.match(loadSkill(bad).error, /invalid skill name/, JSON.stringify(bad))
  }
  assert.match(loadSkill('no-such-skill-here').error, /unknown or not bundled/)
})

await check('AH_EXCLUDE_NONCOMMERCIAL hides CC-BY-NC skills from search and load', () => {
  const dir = join(scratch, 'nc-skills')
  writeSkill(dir, 'free-kelp-analysis', { description: 'Analyse kelp growth data.' })
  writeSkill(dir, 'nc-kelp-analysis', { description: 'Analyse kelp growth data, non-commercial.', license: 'CC-BY-NC-SA-4.0' })
  resetSkillIndexForTests()
  const none = searchSkills('kelp analysis', { dir, env: {}, core: new Set() }).results.map((r) => r.name).sort()
  assert.deepEqual(none, ['free-kelp-analysis', 'nc-kelp-analysis'])
  const env = { AH_EXCLUDE_NONCOMMERCIAL: '1' }
  assert.deepEqual(searchSkills('kelp analysis', { dir, env, core: new Set() }).results.map((r) => r.name), ['free-kelp-analysis'])
  assert.match(loadSkill('nc-kelp-analysis', { dir, env }).error, /unknown or not bundled/)
  assert.ok(loadSkill('nc-kelp-analysis', { dir, env: {} }).content)
  assert.equal(isNonCommercialLicense('CC BY-NC-SA 4.0'), true)
  assert.equal(isNonCommercialLicense('MIT'), false)
  assert.equal(isNonCommercialLicense('This skill is provided under the MIT License. ... mostly CC-BY, some CC-NC'), false)
  resetSkillIndexForTests()
})

await check('seeding copies only core skills, prunes identical earlier copies once, and keeps edits and the user\'s own skills', () => {
  const bundled = join(scratch, 'bundled')
  for (const n of ['core-one', 'core-two', 'other-a', 'other-b', 'other-edited']) writeSkill(bundled, n)
  writeFileSync(join(bundled, 'other-a', 'extra.txt'), 'resource\n')
  const home = join(scratch, 'home')
  const skills = join(home, 'skills')
  // an earlier version seeded everything
  cpSync(bundled, skills, { recursive: true })
  mkdirSync(join(skills, 'other-a', '__pycache__'), { recursive: true })
  writeFileSync(join(skills, 'other-a', '__pycache__', 'x.pyc'), 'x')
  writeFileSync(join(skills, 'other-edited', 'SKILL.md'), `${readFileSync(join(skills, 'other-edited', 'SKILL.md'), 'utf8')}\nMy own note.\n`)
  writeSkill(skills, 'my-own-skill')
  const coreSet = new Set(['core-one', 'core-two'])

  const first = seedSkills({ home, bundled, env: {}, core: coreSet })
  assert.deepEqual(first.pruned.sort(), ['other-a', 'other-b'])
  assert.deepEqual(readdirSync(skills).filter((n) => !n.startsWith('.')).sort(), ['core-one', 'core-two', 'my-own-skill', 'other-edited'])
  assert.ok(existsSync(join(skills, '.ah-skill-seed.json')))

  // once done, a later start neither re-hashes nor re-prunes
  cpSync(join(bundled, 'other-b'), join(skills, 'other-b'), { recursive: true })
  const second = seedSkills({ home, bundled, env: {}, core: coreSet })
  assert.deepEqual(second.pruned, [])
  assert.ok(existsSync(join(skills, 'other-b')), 'a skill the user re-installed after the clean-up stays')

  // a fresh install seeds the core only
  const fresh = join(scratch, 'fresh')
  const r = seedSkills({ home: fresh, bundled, env: {}, core: coreSet })
  assert.equal(r.copied, 2)
  assert.deepEqual(readdirSync(join(fresh, 'skills')).filter((n) => !n.startsWith('.')).sort(), ['core-one', 'core-two'])

  // the escape hatch restores the old behaviour
  const all = join(scratch, 'all')
  assert.equal(seedSkills({ home: all, bundled, env: { AH_SKILLS_SEED: 'all' }, core: coreSet }).copied, 5)
})

await check('seeding the real package puts only the core skills in the host catalogue', () => {
  const home = join(scratch, 'real-home')
  const r = seedSkills({ home, env: {} })
  assert.equal(r.copied, core.size)
  const seeded = readdirSync(join(home, 'skills')).filter((n) => !n.startsWith('.'))
  assert.equal(seeded.length, core.size)
  // what the host would publish: name + description capped (240 now, 500 before), per seeded skill
  const entry = (s, cap) => `- \`${s.name}\`: ${s.description.slice(0, cap)}\n`.length
  const before = bundledSkills().reduce((n, s) => n + entry(s, 500), 0)
  const after = bundledSkills().filter((s) => core.has(s.name)).reduce((n, s) => n + entry(s, 240), 0)
  console.log(`      host catalogue: ${before} -> ${after} characters (${(100 * (1 - after / before)).toFixed(0)}% smaller), ${bundledSkills().length} -> ${core.size} skills`)
  assert.ok(after < before * 0.1, `${after} vs ${before}`)
})

await check('the registered tools search, load and render', async () => {
  const tools = new Map()
  applySkillTools({ tools: { register: (def) => tools.set(def.name, def) } })
  assert.deepEqual([...tools.keys()].sort(), ['skill_load', 'skill_search'])
  const search = tools.get('skill_search')
  const value = await search.execute({ query: 'mass spectrometry proteomics' }, {})
  assert.ok(value.results.length > 0)
  const text = search.output.render({}, value)[0].text
  assert.match(text, /skill_load/)
  assert.match(search.output.render({}, await search.execute({ query: 'zzqxv' }, {}))[0].text, /No bundled skill matches/)
  assert.match((await search.execute({ query: '  ' }, {})).error, /required/)
  const load = tools.get('skill_load')
  assert.match(load.output.render({}, await load.execute({ name: 'scanpy' }, {}))[0].text, /<skill_content name="scanpy">/)
  assert.match(load.output.render({}, await load.execute({ name: '../x' }, {}))[0].text, /^Error: invalid skill name/)
})

await check('the preset mounts the tools beside the host skill tool, which stays', () => {
  const preset = readFileSync(join(ROOT, 'presets/academic-harness/agent.cordis.yml'), 'utf8')
  assert.match(preset, /name: academic-harness\/skill-on-demand/)
  assert.match(preset, /name: '@deepseek-ai\/dsh-tool-skill'/, 'the host tool-skill row (catalogue, loader, /name) is kept')
  assert.match(preset, /catalogDescriptionMaxLength: 240/)
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./skill-on-demand'], './skill-on-demand.js')
  for (const f of ['skill-index.js', 'skill-on-demand.js', 'skills-core.json']) assert.ok(pkg.files.includes(f), `${f} must ship`)
  assert.match(readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8'), /skill-on-demand/)
})

if (process.exitCode) console.error('skills on demand: FAILED')
else console.log(`skills on demand: ${passed} checks passed`)
