#!/usr/bin/env node
/**
 * Review A6 (decision D30): `analysis_run` ran its command with spawnSync inside the
 * ledger lock, for up to an hour. That froze the whole process (nothing else in the
 * plugin or the host was served), held the lock past its 60 s staleness limit so a
 * second process could steal it, and could not be cancelled.
 *
 * Now: a short locked step prepares the run, the command runs asynchronously with no
 * lock held (so the host stays responsive and the job panel can show and kill it),
 * and a short locked step records the result.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeAgent, fakeJobs } from './helpers/fake-host.mjs'
import { makeWorkspace } from './helpers/test-workspace.mjs'

const {
  analysisStatus, freezeAnalysisPlan, listAnalysisRuns, reapAbandonedRuns, runAnalysis,
} = await import('../analysis-store.js')
const { runAnalysisAction } = await import('../analysis-run.js')
const { withLock } = await import('../store-lock.js')

let passed = 0
async function check(label, fn) {
  const ws = makeWorkspace('ah-analysis-async-')
  try {
    await freezeAnalysisPlan({ cwd: ws.cwd, slug: 'a', plan: { question: 'does it run?', inputs: [], outputs: [] } })
    await fn(ws)
    passed += 1
  } catch (error) {
    console.error(`FAIL  ${label}\n${error.stack}`)
    process.exitCode = 1
  } finally {
    ws.cleanup()
  }
}
const node = (code) => [process.execPath, '-e', code]
const dirOf = (ws) => join(ws.cwd, '.dsh', 'analysis', 'a')
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const run = (ws, command, extra = {}) => runAnalysis({ cwd: ws.cwd, slug: 'a', command, kind: 'other', outputs: [], notebookEntry: null, ...extra })

await check('the event loop keeps running while the command runs', async (ws) => {
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 20)
  const started = Date.now()
  const manifest = await run(ws, node('setTimeout(() => {}, 400)'))
  clearInterval(timer)
  assert.equal(manifest.exit_code, 0)
  assert.ok(Date.now() - started >= 380)
  assert.ok(ticks >= 8, `the loop was blocked: ${ticks} ticks in ~400 ms`)
})

await check('the ledger lock is NOT held while the command runs', async (ws) => {
  const running = run(ws, node('setTimeout(() => {}, 700)'))
  await new Promise((resolve) => setTimeout(resolve, 200))
  const acquired = Date.now()
  await withLock(dirOf(ws), () => {}, { label: 'probe', giveUpMs: 2000 })
  const waited = Date.now() - acquired
  assert.ok(waited < 300, `another writer waited ${waited} ms for the lock during a run`)
  await running
})

await check('two runs of one slug overlap, both complete, and get distinct ids', async (ws) => {
  const started = Date.now()
  const [one, two] = await Promise.all([run(ws, node('setTimeout(() => {}, 500)')), run(ws, node('setTimeout(() => {}, 500)'))])
  assert.notEqual(one.run_id, two.run_id)
  assert.ok(Date.now() - started < 950, 'the two runs ran one after the other')
  assert.deepEqual(listAnalysisRuns(ws.cwd, 'a').map((r) => r.run_id).sort(), [one.run_id, two.run_id].sort())
})

await check('a run in flight is visible in status, and is gone from it once recorded', async (ws) => {
  const running = run(ws, node('setTimeout(() => {}, 500)'))
  await new Promise((resolve) => setTimeout(resolve, 150))
  const during = analysisStatus(ws.cwd, 'a')
  assert.equal(during.in_flight.length, 1)
  assert.match(during.in_flight[0].command.join(' '), /setTimeout/)
  assert.ok(during.in_flight[0].run_id)
  const manifest = await running
  const after = analysisStatus(ws.cwd, 'a')
  assert.deepEqual(after.in_flight, [])
  assert.equal(after.runs, 1)
  assert.equal(after.latest?.run_id ?? manifest.run_id, manifest.run_id)
  assert.equal(existsSync(join(dirOf(ws), 'runs', manifest.run_id, 'running.json')), false)
})

await check('cancelling kills the whole process tree and records a cancelled run', async (ws) => {
  const pidFile = join(ws.cwd, 'child.pid')
  const controller = new AbortController()
  const running = run(ws, ['sh', '-c', `sleep 60 & echo $! > ${pidFile}; wait`], { signal: controller.signal, timeoutMs: 60_000 })
  await new Promise((resolve) => setTimeout(resolve, 300))
  controller.abort()
  const started = Date.now()
  const manifest = await running
  assert.ok(Date.now() - started < 6000, 'cancel must not wait out the command')
  assert.equal(manifest.cancelled, true)
  assert.equal(manifest.exit_code, null)
  assert.equal(manifest.timed_out, false)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false, 'the grandchild sleep process survived')
  assert.equal(listAnalysisRuns(ws.cwd, 'a').length, 1, 'a cancelled run is still on the ledger')
})

await check('a timeout is recorded as before, and the tree is killed', async (ws) => {
  const pidFile = join(ws.cwd, 'child.pid')
  const manifest = await run(ws, ['sh', '-c', `sleep 60 & echo $! > ${pidFile}; wait`], { timeoutMs: 400 })
  assert.equal(manifest.timed_out, true)
  assert.equal(manifest.exit_code, null)
  assert.equal(manifest.cancelled ?? false, false)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false)
})

await check('a command that cannot start is recorded with its error and a null exit code', async (ws) => {
  const manifest = await run(ws, ['definitely-not-a-real-binary-xyz'])
  assert.ok(manifest.spawn_error)
  assert.equal(manifest.exit_code, null)
  assert.equal(manifest.timed_out, false)
})

await check('output beyond the log cap is truncated in the log, and does not kill the command', async (ws) => {
  const manifest = await run(ws, node("const chunk = 'x'.repeat(1024 * 1024); for (let i = 0; i < 6; i += 1) process.stdout.write(chunk); process.stdout.write('END')"))
  assert.equal(manifest.exit_code, 0, 'a chatty command must finish')
  assert.equal(manifest.spawn_error, null)
  const log = readFileSync(join(ws.cwd, manifest.stdout), 'utf8')
  assert.match(log, /\[truncated at 4194304 bytes\]$/)
  assert.ok(log.length < 4.3 * 1024 * 1024)
})

await check('the environment is still an allowlist: a host secret does not reach the command', async (ws) => {
  process.env.AH_ASYNC_CANARY_SECRET = 'canary-secret-value'
  try {
    const manifest = await run(ws, node('process.stdout.write(String(process.env.AH_ASYNC_CANARY_SECRET))'))
    assert.equal(readFileSync(join(ws.cwd, manifest.stdout), 'utf8'), 'undefined')
  } finally {
    delete process.env.AH_ASYNC_CANARY_SECRET
  }
})

await check('live output is handed to the caller as it arrives', async (ws) => {
  const seen = []
  await run(ws, node("process.stdout.write('first\\n'); setTimeout(() => process.stderr.write('second\\n'), 150)"), { onOutput: (stream, chunk) => seen.push([stream, chunk]) })
  assert.deepEqual(seen.map(([stream]) => stream), ['stdout', 'stderr'])
  assert.equal(seen[0][1], 'first\n')
})

// ── abandoned runs ───────────────────────────────────────────────────────────
function plantMarker(ws, runId, marker) {
  const dir = join(dirOf(ws), 'runs', runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'running.json'), JSON.stringify({ run_id: runId, slug: 'a', started_at: new Date().toISOString(), command: ['x'], timeout_ms: 1000, kind: 'other', inputs: [], ...marker }))
  return dir
}

await check('a run whose process died is recorded as abandoned instead of being lost', async (ws) => {
  plantMarker(ws, 'run-dead', { pid: 2 ** 22 + 12345 }) // no such process
  const reaped = await reapAbandonedRuns(ws.cwd, 'a')
  assert.deepEqual(reaped.map((r) => r.run_id), ['run-dead'])
  const [run1] = listAnalysisRuns(ws.cwd, 'a')
  assert.equal(run1.run_id, 'run-dead')
  assert.equal(run1.abandoned, true)
  assert.equal(run1.exit_code, null)
  assert.equal(existsSync(join(dirOf(ws), 'runs', 'run-dead', 'running.json')), false)
  assert.deepEqual((await reapAbandonedRuns(ws.cwd, 'a')), [], 'reaping twice does nothing more')
})

await check('a run that is still running (this process, or a live one) is never reaped', async (ws) => {
  const running = run(ws, node('setTimeout(() => {}, 500)'))
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.deepEqual(await reapAbandonedRuns(ws.cwd, 'a'), [], 'an active in-process run was reaped')
  plantMarker(ws, 'run-other', { pid: process.ppid || 1, timeout_ms: 3_600_000 })
  assert.deepEqual(await reapAbandonedRuns(ws.cwd, 'a'), [], 'a young marker owned by a live process was reaped')
  await running
})

await check('a marker with a finished manifest is completed from it, not marked abandoned', async (ws) => {
  const dir = plantMarker(ws, 'run-done', { pid: 2 ** 22 + 999 })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ run_id: 'run-done', slug: 'a', exit_code: 0, timed_out: false }))
  await reapAbandonedRuns(ws.cwd, 'a')
  const [recorded] = listAnalysisRuns(ws.cwd, 'a')
  assert.equal(recorded.run_id, 'run-done')
  assert.equal(recorded.abandoned, undefined)
  assert.equal(recorded.exit_code, 0)
})

// ── the tool, with and without a jobs service ────────────────────────────────
const exec = (ws, extra = {}) => ({ agent: fakeAgent({ cwd: ws.cwd, id: 'sess-a' }), callId: 'call-1', rootCallId: 'call-1', signal: undefined, ...extra })

await check('with a jobs service the run is a job: it streams output, and the result carries the job id', async (ws) => {
  const jobs = fakeJobs()
  const result = await runAnalysisAction(
    { action: 'run', slug: 'a', command: node("process.stdout.write('hello from the job\\n')"), outputs: [], notebook_entry: false },
    exec(ws), { ctx: { jobs } },
  )
  assert.equal(result.run.exit_code, 0)
  assert.equal(result.job_id, 'job-1')
  assert.equal(jobs.started.length, 1)
  assert.equal(jobs.started[0].kind, 'analysis_run')
  assert.match(jobs.started[0].label, /analysis a/)
  assert.ok(jobs.started[0].lines.some((l) => /hello from the job/.test(l.text)))
  assert.equal(jobs.started[0].status, 'completed')
})

await check('killing the job from the panel stops the command and the run is recorded as cancelled', async (ws) => {
  const jobs = fakeJobs()
  const pidFile = join(ws.cwd, 'child.pid')
  const running = runAnalysisAction(
    { action: 'run', slug: 'a', command: ['sh', '-c', `sleep 60 & echo $! > ${pidFile}; wait`], outputs: [], timeout_ms: 60_000, notebook_entry: false },
    exec(ws), { ctx: { jobs } },
  ).catch((error) => error)
  await new Promise((resolve) => setTimeout(resolve, 400))
  jobs.kill('job-1', 'sess-a', 'killed from the panel')
  const outcome = await running
  assert.ok(outcome instanceof Error || outcome.run?.cancelled === true, 'the tool call must end')
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false)
  assert.equal(listAnalysisRuns(ws.cwd, 'a')[0]?.cancelled, true)
})

await check('cancelling the tool call itself kills the command too', async (ws) => {
  const controller = new AbortController()
  const pidFile = join(ws.cwd, 'child.pid')
  const running = runAnalysisAction(
    { action: 'run', slug: 'a', command: ['sh', '-c', `sleep 60 & echo $! > ${pidFile}; wait`], outputs: [], timeout_ms: 60_000, notebook_entry: false },
    exec(ws, { signal: controller.signal }), { ctx: { jobs: fakeJobs() } },
  ).catch((error) => error)
  await new Promise((resolve) => setTimeout(resolve, 400))
  controller.abort()
  await running
  await new Promise((resolve) => setTimeout(resolve, 800))
  assert.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false)
})

await check('without a jobs service the run happens inline and still honours the call signal', async (ws) => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 300)
  const result = await runAnalysisAction(
    { action: 'run', slug: 'a', command: ['sh', '-c', 'sleep 60'], outputs: [], timeout_ms: 60_000, notebook_entry: false },
    exec(ws, { signal: controller.signal }), {},
  )
  assert.equal(result.run.cancelled, true)
  assert.equal(result.job_id, undefined)
})

await check('status and list reap an abandoned run before answering', async (ws) => {
  plantMarker(ws, 'run-ghost', { pid: 2 ** 22 + 4242 })
  const status = await runAnalysisAction({ action: 'list', slug: 'a' }, exec(ws), {})
  assert.deepEqual(status.runs.map((r) => r.run_id), ['run-ghost'])
  assert.equal(status.runs[0].abandoned, true)
})

await check('a notebook entry is still written, and says when a run was cancelled', async (ws) => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 300)
  await runAnalysisAction(
    { action: 'run', slug: 'a', command: ['sh', '-c', 'sleep 60'], outputs: [], timeout_ms: 60_000 },
    exec(ws, { signal: controller.signal }), {},
  )
  const nbDir = join(ws.cwd, '.dsh', 'notebook')
  const text = readdirSync(nbDir).map((f) => readFileSync(join(nbDir, f), 'utf8')).join('\n')
  assert.match(text, /cancelled/)
})

if (process.exitCode) console.error('analysis async: FAILED')
else console.log(`analysis async: ${passed} checks passed`)
