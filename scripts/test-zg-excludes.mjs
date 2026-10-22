import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_EXCLUDES, mergeExcludes, resolvePaperMemoryPaths } from '../zg-excludes.js'

const root = mkdtempSync(join(tmpdir(), 'zg-excl-'))
const failures = []
const check = (name, fn) => {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (err) {
    failures.push(name)
    console.error(`FAIL - ${name}: ${err.message}`)
  }
}

try {
  check('store outside root contributes no auto-excludes', () => {
    const env = { PAPERMEMORY_DB: '/var/lib/papermemory/papermemory.db' }
    assert.deepEqual(mergeExcludes(root, [], env), [])
  })

  check('PAPERMEMORY_DB inside root yields store-dir globs', () => {
    const env = { PAPERMEMORY_DB: join(root, '.pm', 'papermemory.db') }
    assert.deepEqual(mergeExcludes(root, [], env), [
      '!.pm/corpus/**',
      '!.pm/*.db*',
      '!.pm/evidence/**',
    ])
  })

  check('PAPERMEMORY_DATA_DIR inside root yields store-dir globs', () => {
    const env = { PAPERMEMORY_DATA_DIR: join(root, '.data') }
    assert.deepEqual(mergeExcludes(root, [], env), [
      '!.data/corpus/**',
      '!.data/*.db*',
      '!.data/evidence/**',
    ])
  })

  check('store directly in root uses root-relative globs', () => {
    const env = { PAPERMEMORY_DB: join(root, 'papermemory.db') }
    assert.deepEqual(mergeExcludes(root, [], env), ['!corpus/**', '!*.db*', '!evidence/**'])
  })

  check('PAPERMEMORY_EVIDENCE_DIR inside root is excluded wholesale', () => {
    const env = {
      PAPERMEMORY_DB: join(root, 'pm', 'papermemory.db'),
      PAPERMEMORY_EVIDENCE_DIR: join(root, 'pm', 'ah-evidence'),
    }
    assert.deepEqual(mergeExcludes(root, [], env), [
      '!pm/corpus/**',
      '!pm/*.db*',
      '!pm/evidence/**',
      '!pm/ah-evidence/**',
    ])
  })

  check('evidence dir outside root is ignored', () => {
    const env = {
      PAPERMEMORY_DB: join(root, 'papermemory.db'),
      PAPERMEMORY_EVIDENCE_DIR: '/var/lib/evidence',
    }
    assert.deepEqual(mergeExcludes(root, [], env), ['!corpus/**', '!*.db*', '!evidence/**'])
  })

  check('user excludes keep the bang prefix and dedupe', () => {
    const env = { PAPERMEMORY_DB: '/var/lib/papermemory/papermemory.db' }
    assert.deepEqual(
      mergeExcludes(root, ['!tmp/**', 'tmp/**', ' !tmp/** '], env),
      ['!tmp/**'],
    )
  })

  check('auto-excludes precede user excludes and survive the cap', () => {
    const env = { PAPERMEMORY_DB: join(root, 'pm', 'papermemory.db') }
    const user = Array.from({ length: MAX_EXCLUDES + 5 }, (_, i) => `!u${i}/**`)
    const merged = mergeExcludes(root, user, env)
    assert.equal(merged.length, MAX_EXCLUDES)
    assert.deepEqual(merged.slice(0, 3), ['!pm/corpus/**', '!pm/*.db*', '!pm/evidence/**'])
  })

  check('default store path matches PaperMemory layout', () => {
    const paths = resolvePaperMemoryPaths({})
    assert.match(paths.store.replaceAll('\\', '/'), /\/\.local\/share\/papermemory\/papermemory\.db$/)
    assert.equal(paths.evidence, null)
  })

  check('PAPERMEMORY_DB wins over PAPERMEMORY_DATA_DIR', () => {
    const paths = resolvePaperMemoryPaths({
      PAPERMEMORY_DATA_DIR: join(root, 'data'),
      PAPERMEMORY_DB: join(root, 'other', 'custom.db'),
    })
    assert.equal(paths.store, join(root, 'other', 'custom.db'))
  })

  check('XDG_DATA_HOME is honored when no overrides exist', () => {
    const paths = resolvePaperMemoryPaths({ XDG_DATA_HOME: join(root, 'xdg') })
    assert.equal(paths.store, join(root, 'xdg', 'papermemory', 'papermemory.db'))
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`zg exclude helper FAILED (${failures.length})`)
  process.exit(1)
}
console.log('zg exclude helper OK')
