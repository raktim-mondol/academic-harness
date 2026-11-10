import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { queryResearchTemplates } from '../workflows.js'
import { seed } from '../seed.js'
import { loadSkill } from '../skill-index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const skillNames = [
  'subset-first-eval', 'ablation-attribution', 'rebuttal-experiments',
  'limitation-mining', 'novelty-triage', 'method-code-alignment', 'integrity-audit',
]
const workflowIds = ['limitation-mining', 'subset-first-eval', 'ablation-plan', 'rebuttal-plan', 'review-round-diff']
const workflows = JSON.parse(readFileSync(join(root, 'workflows.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.ok(pkg.files.includes('skills'), 'the package includes the skill catalogue')
assert.ok(pkg.files.includes('workflows.json'), 'the package includes workflow templates')

for (const name of skillNames) {
  const text = readFileSync(join(root, 'skills', name, 'SKILL.md'), 'utf8')
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(text)
  assert.ok(match, `${name} has frontmatter`)
  const meta = parse(match[1])
  assert.equal(meta.name, name)
  assert.match(meta.description, /^Use when\b/)
  assert.ok(meta.description.length <= 1024)
  assert.equal(meta.license, 'MIT')
  assert.equal(meta.metadata['skill-author'], 'Academic Harness')
  assert.ok(meta.metadata.version)
}

for (const id of workflowIds) {
  const entries = workflows.filter((entry) => entry.id === id)
  assert.equal(entries.length, 1, `${id} exists exactly once`)
  const [entry] = entries
  for (const field of ['name', 'description', 'category', 'icon', 'prompt']) assert.ok(entry[field], `${id} has ${field}`)
  assert.equal(typeof entry.requiresFiles, 'boolean')
  assert.ok(Array.isArray(entry.placeholders))
  for (const skill of entry.suggestedSkills) assert.ok(existsSync(join(root, 'skills', skill, 'SKILL.md')), `${id} references existing skill ${skill}`)
  const empty = queryResearchTemplates({ action: 'get', id })
  assert.deepEqual(empty.missing_required_values || [], entry.placeholders.filter((p) => p.required).map((p) => p.key))
  const values = Object.fromEntries(entry.placeholders.map((p) => [p.key, `test-${p.key}`]))
  const filled = queryResearchTemplates({ action: 'get', id, values })
  assert.equal(filled.error, undefined)
  assert.equal(filled.missing_required_values, undefined)
  for (const placeholder of entry.placeholders) {
    assert.ok(filled.prompt.includes(values[placeholder.key]), `${id} fills ${placeholder.key}`)
    assert.ok(!filled.prompt.includes(`{${placeholder.key}}`), `${id} has no unfilled ${placeholder.key}`)
  }
  assert.ok(queryResearchTemplates({ action: 'list', category: entry.category }).workflows.some((item) => item.id === id))
}

// A real first install finds every new skill, but does not overwrite an existing
// user's skill directory. The temporary DSH_HOME is created solely for this test.
const home = mkdtempSync(join(tmpdir(), 'ah-phase10-seed-'))
const oldHome = process.env.DSH_HOME
try {
  const kept = join(home, 'skills', 'subset-first-eval')
  mkdirSync(kept, { recursive: true })
  writeFileSync(join(kept, 'SKILL.md'), 'user-owned skill\n')
  process.env.DSH_HOME = home
  seed()
  assert.equal(readFileSync(join(kept, 'SKILL.md'), 'utf8'), 'user-owned skill\n')
  // Only the core skills are seeded into the host catalogue; the rest are bundled
  // and load on demand (skill_load), so each Phase 10 skill is reachable one way or the other.
  const coreNames = new Set(JSON.parse(readFileSync(join(root, 'skills-core.json'), 'utf8')))
  for (const name of skillNames.filter((name) => name !== 'subset-first-eval')) {
    const seeded = existsSync(join(home, 'skills', name, 'SKILL.md'))
    assert.equal(seeded, coreNames.has(name), `${name} is seeded exactly when it is core`)
    assert.ok(loadSkill(name).content, `${name} loads on demand`)
  }
  assert.ok(existsSync(join(root, 'skills', 'pele', 'scripts', 'render.mjs')), 'pele renderer is bundled')
  assert.ok(existsSync(join(root, 'skills', 'pele', 'LICENSE')), 'pele license is bundled')
  assert.ok(loadSkill('pele').content, 'pele loads on demand')
} finally {
  if (oldHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = oldHome
  rmSync(home, { recursive: true, force: true })
}

console.log('phase 10 skills and templates OK')
