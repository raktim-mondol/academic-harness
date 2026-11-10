/**
 * Run every scripts/test-*.mjs and report failures (decision D45). Globbing means a
 * new test is never left out of `npm test` or CI.
 *
 *   npm test                       parallel, min(4, CPUs) files at a time
 *   npm test -- deep-research      only files whose name contains the fragment
 *   npm test -- --serial           one at a time (same as --jobs 1)
 *   npm test -- --jobs 8           at most 8 files at once
 *   npm test -- --timeout 120      kill a file that runs longer than 120 s (default 900)
 *   npm test -- --junit out.xml    also write a JUnit report
 *   npm test -- --verbose          print the output of passing files too
 *   npm test -- --list             print the files that would run
 *   npm test -- --no-prepare       do not build the engine venv first (see below)
 *
 * Each file is its own node process with its own scratch DSH_HOME, so parallel files
 * never share state and no test touches your real ~/.dsh. A file that hangs is killed
 * with its whole process tree and reported as TIMEOUT. The scratch home of a failing
 * file is kept and its path printed; a passing file's is removed.
 *
 * Before the first file the runner makes sure the vendored engine's venv exists, once, so
 * parallel files do not all try to build it at the same moment on a fresh checkout. (Skipped
 * for a custom AH_TESTS_DIR and with --no-prepare.)
 *
 * Environment: AH_TESTS_DIR (where to look for test-*.mjs; default: this directory) and
 * AH_TEST_HOME_ROOT (parent for per-file scratch homes; default: $DSH_HOME if you set
 * one, else ~/.cache/ah-test-homes — the real disk, because /tmp may be a small tmpfs).
 */
import { spawn } from 'node:child_process'
import { availableParallelism, homedir } from 'node:os'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = process.env.AH_TESTS_DIR || dirname(fileURLToPath(import.meta.url))
const MAX_CAPTURE = 4 * 1024 * 1024
const KILL_GRACE_MS = 3000

function parseArgs(argv) {
  const opts = { jobs: Math.min(4, availableParallelism()), timeout: 900, junit: null, verbose: false, list: false, prepare: true, filters: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--serial') opts.jobs = 1
    else if (arg === '--jobs') opts.jobs = Math.max(1, Number(argv[++i]) || 1)
    else if (arg === '--timeout') opts.timeout = Math.max(1, Number(argv[++i]) || 900)
    else if (arg === '--junit') opts.junit = argv[++i]
    else if (arg === '--verbose') opts.verbose = true
    else if (arg === '--list') opts.list = true
    else if (arg === '--no-prepare') opts.prepare = false
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
    else opts.filters.push(arg)
  }
  return opts
}

function homeRoot() {
  if (process.env.AH_TEST_HOME_ROOT) return process.env.AH_TEST_HOME_ROOT
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return join(homedir(), '.cache', 'ah-test-homes')
}

function killTree(child, signal) {
  try {
    process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* already gone */ }
  }
}

function runOne(name, { timeout, root }) {
  return new Promise((resolve) => {
    const home = join(root, `${name.replace(/\.mjs$/, '')}.${process.pid}`)
    rmSync(home, { recursive: true, force: true })
    mkdirSync(home, { recursive: true })
    const started = Date.now()
    const child = spawn(process.execPath, [join(here, name)], {
      env: { ...process.env, DSH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // its own process group, so a hung file's children die with it
    })
    let output = ''
    let dropped = false
    const take = (chunk) => {
      if (output.length < MAX_CAPTURE) output += chunk
      else dropped = true
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child, 'SIGTERM')
      setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS)
    }, timeout * 1000)
    const finish = (code, signal) => {
      clearTimeout(timer)
      killTree(child, 'SIGKILL') // anything the file left running
      const seconds = (Date.now() - started) / 1000
      const ok = code === 0 && !timedOut
      if (ok) rmSync(home, { recursive: true, force: true })
      resolve({ name, ok, timedOut, code, signal, seconds, output: dropped ? `${output}\n[output truncated]` : output, home: ok ? null : home })
    }
    child.on('close', finish)
    child.on('error', (error) => { output += `\n${error.message}`; finish(1, null) })
  })
}

const escapeXml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function junit(results) {
  const failures = results.filter((r) => !r.ok).length
  const total = results.reduce((sum, r) => sum + r.seconds, 0).toFixed(3)
  const cases = results.map((r) => {
    const base = `<testcase classname="scripts" name="${escapeXml(r.name)}" time="${r.seconds.toFixed(3)}"`
    if (r.ok) return `${base}/>`
    const message = r.timedOut ? 'timed out' : `exit code ${r.code ?? r.signal}`
    return `${base}>\n    <failure message="${escapeXml(message)}">${escapeXml(r.output.slice(-20_000))}</failure>\n  </testcase>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="academic-harness" tests="${results.length}" failures="${failures}" time="${total}">\n  ${cases.join('\n  ')}\n</testsuite>\n`
}

/** Build the engine venv once, serially, so concurrent test files find it ready. */
function prepareEngine(root) {
  return new Promise((resolve) => {
    const script = `const m = await import(${JSON.stringify(join(dirname(fileURLToPath(import.meta.url)), '..', 'academic-harness-cli.js'))}); const l = await m.ensureAcademicHarnessInstalled(); process.exit(l ? 0 : 3)`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, DSH_HOME: join(root, 'prepare') },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) console.error(`engine preparation exited ${code}; tests that need it may fail.\n${stderr.trim().split('\n').slice(-3).join('\n')}`)
      resolve()
    })
  })
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const tests = readdirSync(here)
    .filter((name) => /^test-.*\.mjs$/.test(name))
    .filter((name) => opts.filters.length === 0 || opts.filters.some((f) => name.includes(f)))
    .sort()
  if (opts.list) {
    console.log(tests.join('\n'))
    return 0
  }
  if (tests.length === 0) {
    console.error('no tests matched')
    return 1
  }

  const root = homeRoot()
  mkdirSync(root, { recursive: true })
  if (opts.prepare && !process.env.AH_TESTS_DIR && opts.jobs > 1) await prepareEngine(root)
  const results = []
  const queue = [...tests]
  const worker = async () => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      const result = await runOne(name, { timeout: opts.timeout, root })
      results.push(result)
      const seconds = result.seconds.toFixed(1)
      if (result.ok) {
        console.log(`PASS ${name} (${seconds}s)`)
        if (opts.verbose && result.output.trim()) console.log(result.output.trimEnd())
      } else {
        console.error(`${result.timedOut ? 'TIMEOUT' : 'FAIL'} ${name} (${seconds}s)${result.timedOut ? ` — killed after ${opts.timeout}s` : ''}`)
        const lines = result.output.trimEnd().split('\n')
        console.error(lines.slice(-80).join('\n'))
        if (result.home) console.error(`scratch home kept: ${result.home}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.jobs, tests.length) }, worker))

  results.sort((a, b) => a.name.localeCompare(b.name))
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} test files passed`)
  const slowest = [...results].sort((a, b) => b.seconds - a.seconds).slice(0, 5)
  console.log(`slowest: ${slowest.map((r) => `${r.name} ${r.seconds.toFixed(1)}s`).join(', ')}`)
  if (opts.junit) writeFileSync(opts.junit, junit(results))
  if (failed.length > 0) {
    console.error(`failed: ${failed.map((r) => r.name).join(', ')}`)
    return 1
  }
  return 0
}

main().then((code) => process.exit(code), (error) => {
  console.error(error.message)
  process.exit(2)
})
