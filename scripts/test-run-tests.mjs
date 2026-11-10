#!/usr/bin/env node
/**
 * The test runner itself (decision D45): files run in parallel with a per-file
 * timeout that kills the whole process tree, each file gets its own scratch
 * DSH_HOME, failures print their output, and JUnit XML can be written.
 * Drives scripts/run-tests.mjs against a directory of fake test files.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'run-tests.mjs')
const scratch = mkdtempSync(join(homedir(), '.cache', 'ah-runner-test-'))

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

function suite(files) {
  const dir = mkdtempSync(join(scratch, 'suite-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}
function runner(dir, args = [], env = {}) {
  const started = Date.now()
  const result = spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AH_TESTS_DIR: dir, AH_TEST_HOME_ROOT: join(scratch, 'homes'), ...env },
    timeout: 60_000,
  })
  return { ...result, seconds: (Date.now() - started) / 1000, out: `${result.stdout}${result.stderr}` }
}
const sleeper = (ms, extra = '') => `${extra}\nawait new Promise((r) => setTimeout(r, ${ms}))\nconsole.log('done')\n`

check('all passing: exit 0 and a summary line', () => {
  const dir = suite({ 'test-a.mjs': 'console.log("a")', 'test-b.mjs': 'console.log("b")' })
  const r = runner(dir)
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /PASS test-a\.mjs/)
  assert.match(r.out, /PASS test-b\.mjs/)
  assert.match(r.out, /2\/2 test files passed/)
})

check('a failing file makes the run fail, and its output is shown', () => {
  const dir = suite({ 'test-ok.mjs': 'console.log("fine")', 'test-bad.mjs': 'console.error("the assertion that failed"); process.exit(3)' })
  const r = runner(dir)
  assert.equal(r.status, 1)
  assert.match(r.out, /FAIL test-bad\.mjs/)
  assert.match(r.out, /the assertion that failed/)
  assert.match(r.out, /1\/2 test files passed/)
  assert.match(r.out, /failed: test-bad\.mjs/)
})

check('output of passing files is quiet unless --verbose', () => {
  const dir = suite({ 'test-chatty.mjs': 'console.log("lots of passing detail")' })
  assert.doesNotMatch(runner(dir).out, /lots of passing detail/)
  assert.match(runner(dir, ['--verbose']).out, /lots of passing detail/)
})

check('files run in parallel: four 700 ms files finish in well under 2.8 s with --jobs 4', () => {
  const dir = suite(Object.fromEntries([1, 2, 3, 4].map((n) => [`test-s${n}.mjs`, sleeper(700)])))
  const parallel = runner(dir, ['--jobs', '4'])
  assert.equal(parallel.status, 0, parallel.out)
  assert.ok(parallel.seconds < 2.3, `took ${parallel.seconds}s`)
  const serial = runner(dir, ['--serial'])
  assert.equal(serial.status, 0, serial.out)
  assert.ok(serial.seconds > 2.7, `--serial should run one at a time, took ${serial.seconds}s`)
})

check('a file that hangs is killed at the timeout with its children, reported, and does not stop the others', () => {
  const pidFile = join(scratch, 'child.pid')
  const dir = suite({
    'test-hang.mjs': `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; const c = spawn('sleep', ['60']); writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000)`,
    'test-fast.mjs': 'console.log("fast")',
  })
  const r = runner(dir, ['--timeout', '2'])
  assert.equal(r.status, 1)
  assert.match(r.out, /TIMEOUT test-hang\.mjs/)
  assert.match(r.out, /PASS test-fast\.mjs/)
  assert.ok(r.seconds < 15, `took ${r.seconds}s`)
  const pid = Number(readFileSync(pidFile, 'utf8'))
  let alive = true
  try { process.kill(pid, 0) } catch { alive = false }
  assert.equal(alive, false, 'the hung file\'s child process survived')
})

check('each file gets its own scratch DSH_HOME, which is removed after a pass', () => {
  const seen = join(scratch, 'homes-seen.txt')
  writeFileSync(seen, '')
  const body = `import { appendFileSync, writeFileSync, existsSync } from 'node:fs'; appendFileSync(${JSON.stringify(seen)}, process.env.DSH_HOME + '\\n'); writeFileSync(process.env.DSH_HOME + '/marker', 'x')`
  const dir = suite({ 'test-h1.mjs': body, 'test-h2.mjs': body })
  const r = runner(dir)
  assert.equal(r.status, 0, r.out)
  const homes = readFileSync(seen, 'utf8').split('\n').filter(Boolean)
  assert.equal(homes.length, 2)
  assert.notEqual(homes[0], homes[1])
  assert.ok(homes.every((h) => h.startsWith(join(scratch, 'homes'))))
  assert.ok(homes.every((h) => !existsSync(h)), 'a passing file\'s scratch home should be cleaned up')
})

check('a failing file keeps its scratch home and says where', () => {
  const dir = suite({ 'test-keep.mjs': 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.DSH_HOME + "/evidence", "x"); process.exit(1)' })
  const r = runner(dir)
  const match = r.out.match(/scratch home kept: (\S+)/)
  assert.ok(match, r.out)
  assert.ok(existsSync(join(match[1], 'evidence')))
})

check('a DSH_HOME the caller set is respected as the parent of the per-file homes', () => {
  const parent = join(scratch, 'caller-home')
  const seen = join(scratch, 'caller-seen.txt')
  const dir = suite({ 'test-p.mjs': `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(seen)}, process.env.DSH_HOME)` })
  const r = runner(dir, [], { DSH_HOME: parent, AH_TEST_HOME_ROOT: '' })
  assert.equal(r.status, 0, r.out)
  assert.ok(readFileSync(seen, 'utf8').startsWith(parent))
})

check('name fragments select files; nothing matched is an error', () => {
  const dir = suite({ 'test-alpha.mjs': 'console.log(1)', 'test-beta.mjs': 'console.log(2)' })
  const only = runner(dir, ['alpha'])
  assert.match(only.out, /1\/1 test files passed/)
  assert.doesNotMatch(only.out, /beta/)
  assert.equal(runner(dir, ['nomatch']).status, 1)
  assert.match(runner(dir, ['--list']).out, /test-alpha\.mjs\ntest-beta\.mjs/)
})

check('--junit writes a report with counts, names, times and failure output', () => {
  const dir = suite({ 'test-ok.mjs': 'console.log("x")', 'test-bad.mjs': 'console.error("boom <&> detail"); process.exit(2)' })
  const file = join(scratch, 'report.xml')
  runner(dir, ['--junit', file])
  const xml = readFileSync(file, 'utf8')
  assert.match(xml, /<testsuite name="academic-harness" tests="2" failures="1"/)
  assert.match(xml, /<testcase classname="scripts" name="test-ok\.mjs" time="[\d.]+"\/>/)
  assert.match(xml, /<testcase classname="scripts" name="test-bad\.mjs" time="[\d.]+">\s*<failure message="exit code 2"/)
  assert.match(xml, /boom &lt;&amp;&gt; detail/)
})

check('the slowest files are listed in the summary', () => {
  const dir = suite({ 'test-slow.mjs': sleeper(400), 'test-quick.mjs': 'console.log(1)' })
  assert.match(runner(dir).out, /slowest:[\s\S]*test-slow\.mjs/)
})

check('the real suite directory is what the runner uses by default', () => {
  const r = spawnSync(process.execPath, [RUNNER, '--list'], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.ok(r.stdout.split('\n').filter(Boolean).length > 50)
  assert.match(r.stdout, /test-run-tests\.mjs/)
})

rmSync(scratch, { recursive: true, force: true })
if (process.exitCode) console.error('test runner: FAILED')
else console.log(`test runner: ${passed} checks passed`)
