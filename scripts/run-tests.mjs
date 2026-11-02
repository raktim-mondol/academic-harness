/**
 * Run every scripts/test-*.mjs in order and report failures. Globbing means a
 * new test is never left out of `npm test` or CI. Pass name fragments to run a
 * subset: `npm test -- deep-research`.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const filters = process.argv.slice(2)
const tests = readdirSync(here)
  .filter((name) => /^test-.*\.mjs$/.test(name))
  .filter((name) => filters.length === 0 || filters.some((f) => name.includes(f)))
  .sort()

if (tests.length === 0) {
  console.error('no tests matched')
  process.exit(1)
}

const failed = []
for (const name of tests) {
  const started = Date.now()
  const result = spawnSync(process.execPath, [join(here, name)], { stdio: 'inherit' })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (result.status === 0) console.log(`PASS ${name} (${seconds}s)`)
  else {
    console.error(`FAIL ${name} (${seconds}s)`)
    failed.push(name)
  }
}

console.log(`\n${tests.length - failed.length}/${tests.length} test files passed`)
if (failed.length > 0) {
  console.error(`failed: ${failed.join(', ')}`)
  process.exit(1)
}
