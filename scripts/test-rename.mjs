#!/usr/bin/env node
/**
 * Rename acceptance: package/patch identity, preset identity, API-key
 * migration, and the profile migration script (dry-run + apply) against temp
 * profiles.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getStoredKey, registerKeysSettings } from '../settings-keys.js'
import { PRESET_ID, isPluginPreset } from '../preset-ids.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const checks = []
const check = (name, fn) => checks.push([name, fn])
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const tempDirs = []

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'ah-rename-'))
  tempDirs.push(dir)
  return dir
}

function patchFixture(extra = '') {
  return `- id: researchcraft
  name: dsh-researchcraft
  config:
    PARALLEL_API_KEY: legacy-parallel-secret
    UNPAYWALL_EMAIL: legacy@example.com

- id: agent-preset-registry
  config:
    default: researchcraft
    selectedDefault: researchcraft
${extra}`
}

check('package identity is academic-harness with a semver version', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'academic-harness')
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  assert.equal(pkg.repository.url, 'git+https://github.com/raktim-mondol/academic-harness.git')
  assert.equal(pkg.homepage, 'https://github.com/raktim-mondol/academic-harness#readme')
  assert.equal(pkg.exports['./ah'], './academic-harness.js')
  assert.equal(pkg.exports['./ah-hooks'], './academic-harness-hooks.js')
  assert.ok(pkg.files.includes('preset-ids.js'))
  assert.ok(pkg.files.includes('scripts'))
})

check('preset ids accept only the current preset', () => {
  assert.equal(PRESET_ID, 'academic-harness')
  assert.ok(isPluginPreset(PRESET_ID))
  assert.ok(!isPluginPreset('researchcraft'))
  assert.ok(!isPluginPreset('standard'))
})

check('generated patch has one preset and no old module specifiers', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /default: academic-harness/)
  assert.match(patch, /- id: academic-harness\n      name: academic-harness/)
  const presetStart = patch.indexOf('    - id: preset-academic-harness')
  assert.ok(presetStart >= 0)
  assert.ok(!patch.includes('preset-researchcraft-legacy'))
  const presetBody = patch.slice(patch.indexOf('        plugins:', presetStart))
  assert.ok(presetBody.includes('name: academic-harness/ah'))
  assert.ok(presetBody.includes('name: academic-harness/ah-hooks'))
  assert.ok(!presetBody.includes('dsh-researchcraft/'))
  assert.ok(!patch.includes('name: dsh-researchcraft'))
})

check('client bundle registers under the new id', () => {
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.ok(bundle.includes("id: 'academic-harness'"))
  assert.ok(!bundle.includes("id: 'dsh-researchcraft'"))
})

check('migrates legacy keys per field and writes a marker', async () => {
  const home = tempHome()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const patchPath = join(home, 'cordis.patch.yml')
    writeFileSync(patchPath, patchFixture())
    writeFileSync(join(home, 'settings.yaml.imported'), 'dsh-researchcraft-keys:\n  CONSENSUS_API_KEY: legacy-consensus-secret\n')
    const updates = []
    const ctx = {
      settings: {
        documentPath: patchPath,
        update: async (id, fields) => { updates.push({ id, fields }) },
      },
      effect: (fn) => { fn(); return () => {} },
      on: () => () => {},
    }
    registerKeysSettings(ctx, { FIRECRAWL_API_KEY: 'live-firecrawl' })
    assert.equal(getStoredKey('PARALLEL_API_KEY'), 'legacy-parallel-secret')
    await tick()
    assert.equal(updates.length, 1)
    assert.equal(updates[0].id, 'academic-harness')
    assert.equal(updates[0].fields.PARALLEL_API_KEY, 'legacy-parallel-secret')
    assert.equal(updates[0].fields.CONSENSUS_API_KEY, 'legacy-consensus-secret')
    assert.equal(updates[0].fields.FIRECRAWL_API_KEY, undefined)
    assert.ok(existsSync(join(home, 'academic-harness-migrations.json')))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

check('cleared field stays cleared after the migration marker exists', async () => {
  const home = tempHome()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const patchPath = join(home, 'cordis.patch.yml')
    writeFileSync(patchPath, patchFixture())
    writeFileSync(join(home, 'academic-harness-migrations.json'), JSON.stringify({ version: 1, documents: { [patchPath]: '2026-01-01T00:00:00Z' } }))
    const updates = []
    const ctx = {
      settings: { documentPath: patchPath, update: async (id, fields) => { updates.push({ id, fields }) } },
      effect: (fn) => { fn(); return () => {} },
      on: () => () => {},
    }
    registerKeysSettings(ctx, { PARALLEL_API_KEY: '' })
    assert.equal(getStoredKey('PARALLEL_API_KEY'), undefined)
    await tick()
    assert.equal(updates.length, 0)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

check('migration failure keeps the fallback and never logs values', async () => {
  const home = tempHome()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const warnings = []
  const originalWarn = console.warn
  try {
    const patchPath = join(home, 'cordis.patch.yml')
    writeFileSync(patchPath, patchFixture().replace('legacy-parallel-secret', 'super-secret-value'))
    const ctx = {
      settings: { documentPath: patchPath, update: async () => { throw new Error('write failed') } },
      effect: (fn) => { fn(); return () => {} },
      on: () => () => {},
    }
    console.warn = (...args) => { warnings.push(args.join(' ')) }
    registerKeysSettings(ctx, {})
    await tick()
    assert.equal(getStoredKey('PARALLEL_API_KEY'), 'super-secret-value')
    assert.ok(warnings.length >= 1)
    assert.ok(warnings.every((line) => !line.includes('super-secret-value')))
  } finally {
    console.warn = originalWarn
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

check('profile migration dry-run and apply', () => {
  const home = tempHome()
  const source = join(home, 'profiles', 'researchcraft')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-researchcraft',
    dependencies: { 'dsh-researchcraft': 'link:/tmp/old' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-researchcraft'] } },
  }, null, 2)}\n`)
  writeFileSync(join(source, 'cordis.patch.yml'), patchFixture())
  const script = join(ROOT, 'scripts', 'migrate-profile.mjs')
  const base = [script, '--profile', 'researchcraft', '--to', 'academic-harness', '--dsh-home', home]

  const dry = spawnSync(process.execPath, base, { encoding: 'utf8' })
  assert.equal(dry.status, 0, dry.stderr)
  assert.ok(dry.stdout.includes('migrated host row'))
  assert.ok(dry.stdout.includes('PARALLEL_API_KEY'))
  assert.ok(!dry.stdout.includes('legacy-parallel-secret'))
  assert.ok(existsSync(source))
  assert.ok(!existsSync(join(home, 'profiles', 'academic-harness')))

  const applied = spawnSync(process.execPath, [...base, '--apply'], { encoding: 'utf8' })
  assert.equal(applied.status, 0, applied.stderr)
  const target = join(home, 'profiles', 'academic-harness')
  assert.ok(existsSync(target))
  assert.ok(!existsSync(source))
  const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-profile-academic-harness')
  assert.equal(pkg.dependencies['academic-harness'], 'link:/tmp/old')
  assert.ok(!('dsh-researchcraft' in pkg.dependencies))
  assert.deepEqual(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'academic-harness'])
  const patch = readFileSync(join(target, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('- id: academic-harness'))
  assert.ok(patch.includes('name: academic-harness'))
  assert.ok(patch.includes('PARALLEL_API_KEY: legacy-parallel-secret'))
  assert.ok(!patch.includes('- id: researchcraft'))
  assert.match(patch, /default: academic-harness/)
  assert.ok(!/default: researchcraft/.test(patch))
  assert.ok(existsSync(join(home, 'profile-migrations')))
})

let failed = 0
for (const [name, fn] of checks) {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL - ${name}: ${error.message}`)
  }
}
for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
if (failed) process.exit(1)
console.log('rename checks OK')
