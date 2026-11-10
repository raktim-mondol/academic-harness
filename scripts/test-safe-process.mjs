#!/usr/bin/env node
/**
 * Review A3 (decisions D13, D14): `repo_audit run_tests` must not hand the
 * host's secrets to a repository's test process, and it must run without
 * blocking the event loop and kill what it starts on timeout or cancel.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const CANARY = 'AH_REVIEW_FAKE_SECRET'
const CANARY_VALUE = 'sk-invented-canary-value'
process.env[CANARY] = CANARY_VALUE
process.env.OPENAI_API_KEY = 'sk-another-invented-value'

const { baseEnv, repoTestEnv, runCommand } = await import('../safe-process.js')
const { runRepoAudit } = await import('../repo-audit.js')

let passed = 0
async function check(label, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL  ${label}\n${error.stack}`)
    process.exitCode = 1
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

await check('baseEnv and repoTestEnv carry no secret-shaped parent variable', () => {
  for (const env of [baseEnv(true), repoTestEnv(true)]) {
    assert.equal(env[CANARY], undefined)
    assert.equal(env.OPENAI_API_KEY, undefined)
    assert.ok(env.PATH, 'PATH is still passed')
  }
  assert.equal(baseEnv(false).no_proxy, '*')
  assert.equal(repoTestEnv(true).CI, '1')
})

await check('repo_audit run_tests: the test process cannot see the host secret', async () => {
  const ws = makeWorkspace('ah-safe-process-')
  try {
    ws.write('repo/package.json', JSON.stringify({
      name: 'fixture',
      scripts: { test: `node -e "console.log('SAW=' + String(process.env.${CANARY}) + ' KEY=' + String(process.env.OPENAI_API_KEY))"` },
    }))
    ws.write('repo/README.md', '# fixture\n')
    const result = await runRepoAudit({ path: 'repo', run_tests: true }, fakeExec(ws.cwd))
    const run = result.run_tests
    assert.equal(run?.ran, true, `tests did not run: ${JSON.stringify(result.run_tests)}`)
    assert.equal(run.exit_code, 0)
    assert.match(run.stdout_tail, /SAW=undefined/)
    assert.match(run.stdout_tail, /KEY=undefined/)
    assert.ok(!run.stdout_tail.includes(CANARY_VALUE))
  } finally {
    ws.cleanup()
  }
})

await check('runCommand does not block the event loop', async () => {
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 20)
  const started = Date.now()
  const result = await runCommand(process.execPath, ['-e', 'setTimeout(()=>{}, 400)'], { env: baseEnv(false) })
  clearInterval(timer)
  assert.equal(result.status, 0)
  assert.ok(Date.now() - started >= 380)
  assert.ok(ticks >= 8, `event loop starved: only ${ticks} ticks in ~400ms`)
})

await check('a timeout kills the whole process group, not just the shell', async () => {
  const ws = makeWorkspace('ah-safe-process-kill-')
  try {
    const pidFile = join(ws.cwd, 'child.pid')
    const started = Date.now()
    const result = await runCommand('sh', ['-c', `sleep 60 & echo $! > ${pidFile}; wait`], {
      env: baseEnv(false),
      timeoutMs: 300,
      graceMs: 300,
    })
    assert.equal(result.timedOut, true)
    assert.ok(Date.now() - started < 5000, 'returned promptly after the timeout')
    assert.ok(existsSync(pidFile), 'grandchild recorded its pid')
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(alive(pid), false, 'grandchild sleep process should be gone')
  } finally {
    ws.cleanup()
  }
})

await check('an abort signal cancels the run and is reported', async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 150)
  const result = await runCommand('sh', ['-c', 'sleep 60'], { env: baseEnv(false), signal: controller.signal, graceMs: 200 })
  assert.equal(result.aborted, true)
  assert.equal(result.timedOut, false)
  assert.notEqual(result.status, 0)
})

await check('a missing executable resolves with an error instead of throwing', async () => {
  const result = await runCommand('definitely-not-a-real-binary-xyz', [], { env: baseEnv(false) })
  assert.ok(result.error || result.status !== 0)
})

await check('a command that ignores SIGTERM is still stopped by SIGKILL', async () => {
  const result = await runCommand('sh', ['-c', "trap '' TERM; sleep 60"], { env: baseEnv(false), timeoutMs: 200, graceMs: 300 })
  assert.equal(result.timedOut, true)
})

if (process.exitCode) console.error('safe-process: FAILED')
else console.log(`safe-process: ${passed} checks passed`)
