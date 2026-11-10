#!/usr/bin/env node
/**
 * Review B9 (hardening): if the engine exits before it reads its stdin, the
 * write raised an unhandled EPIPE on child.stdin and took the whole process
 * down (exit 1) instead of returning the child's exit code. Run in a separate
 * process so an unhandled error shows up as a non-zero exit, not a test hang.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const probe = `
import { run } from ${JSON.stringify(join(ROOT, 'academic-harness-cli.js'))}
const results = []
for (let i = 0; i < 5; i += 1) {
  results.push((await run(process.execPath, ['-e', 'process.exit(2)'], { stdin: 'x'.repeat(1024 * 1024), silent: true, timeoutMs: 10000 })).code)
}
console.log('codes:' + results.join(','))
`
const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', timeout: 60000 })
assert.equal(result.status, 0, `the probe process died (exit ${result.status}):\n${result.stderr.slice(-400)}`)
assert.match(result.stdout, /codes:2,2,2,2,2/, 'the child exit code is returned')

const ok = spawnSync(process.execPath, ['--input-type=module', '-e', `
import { run } from ${JSON.stringify(join(ROOT, 'academic-harness-cli.js'))}
const r = await run(process.execPath, ['-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(s.length)))'], { stdin: 'hello', silent: true })
console.log(r.code + ':' + r.out)
`], { encoding: 'utf8', timeout: 30000 })
assert.equal(ok.stdout.trim(), '0:5', 'a child that reads its stdin still gets it')
console.log('cli run epipe: 2 checks passed')
