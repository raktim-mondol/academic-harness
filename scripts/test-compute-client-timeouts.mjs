#!/usr/bin/env node
/**
 * Review A7 (decision D29): the Runpod and Vast.ai clients called fetch with no
 * timeout and no abort signal, so a hung provider call could not be interrupted
 * by the user, and a hung teardown call could hang forever. Now every request
 * has its own timer; provisioning calls also take the tool's cancel signal;
 * teardown calls take none, so a cancel cannot stop the call that ends billing.
 */
import assert from 'node:assert/strict'
import { isTransientError } from '../search-http.js'

const runpod = await import('../runpod-client.js')
const vast = await import('../vastai-client.js')

// AbortSignal.timeout timers are unref'd; the real host has other handles, a bare test process does not.
const keepAlive = setInterval(() => {}, 1000)

let passed = 0
async function check(label, fn) {
  const original = globalThis.fetch
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL  ${label}\n${error.stack}`)
    process.exitCode = 1
  } finally {
    globalThis.fetch = original
  }
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
/** A fetch that never answers until its signal fires. */
const hang = (url, init) => new Promise((resolve, reject) => {
  if (init?.signal?.aborted) return reject(init.signal.reason)
  init?.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true })
})

await check('every Runpod request carries a signal, with or without a caller signal', async () => {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push(init?.signal)
    return json({ pods: [], pagination: { hasNextPage: false }, networkVolumes: [], id: 'p1', status: 'RUNNING' })
  }
  const controller = new AbortController()
  await runpod.createPod('k', {}, { signal: controller.signal })
  await runpod.listPods('k')
  await runpod.getPod('k', 'p1')
  await runpod.deletePod('k', 'p1')
  await runpod.listNetworkVolumes('k')
  await runpod.createNetworkVolume('k', { name: 'v', size: 10, dataCenter: 'EU' })
  assert.equal(seen.length, 6)
  for (const signal of seen) assert.ok(signal instanceof AbortSignal, 'a request had no signal')
})

await check('every Vast.ai request carries a signal', async () => {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push(init?.signal)
    return json({ success: true, offers: [], instances: [], new_contract: 7, key: { id: 3 } })
  }
  await vast.searchOffers('k', {}, { signal: new AbortController().signal })
  await vast.createInstance('k', 1, {}, { signal: new AbortController().signal })
  await vast.showInstance('k', 7)
  await vast.listInstances('k')
  await vast.destroyInstance('k', 7)
  await vast.registerSshKey('k', 'ssh-ed25519 AAAA')
  await vast.deleteSshKey('k', 3)
  assert.equal(seen.length, 7)
  for (const signal of seen) assert.ok(signal instanceof AbortSignal, 'a request had no signal')
})

await check('a hung request times out on its own timer and the error is retryable', async () => {
  globalThis.fetch = hang
  const started = Date.now()
  for (const call of [
    () => runpod.getPod('k', 'p1', { timeoutMs: 80 }),
    () => vast.showInstance('k', 7, { timeoutMs: 80 }),
  ]) {
    await assert.rejects(call(), (error) => /timed out after 80 ms/.test(error.message) && error.code === 'ETIMEDOUT' && isTransientError(error))
  }
  assert.ok(Date.now() - started < 2000)
})

await check('a response whose body stalls is also cut off by the request timer', async () => {
  globalThis.fetch = async (url, init) => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"pods":')) },
    pull: () => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })),
  }), { status: 200 })
  await assert.rejects(runpod.getPod('k', 'p1', { timeoutMs: 80 }), /timed out after 80 ms/)
})

await check('cancelling a provisioning call stops it promptly and is not retryable', async () => {
  globalThis.fetch = hang
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 40)
  const started = Date.now()
  for (const call of [
    () => runpod.createPod('k', {}, { signal: controller.signal, timeoutMs: 60_000 }),
    () => vast.createInstance('k', 1, {}, { signal: controller.signal, timeoutMs: 60_000 }),
  ]) {
    await assert.rejects(call(), (error) => /cancelled/.test(error.message) && error.name === 'AbortError' && !isTransientError(error))
  }
  assert.ok(Date.now() - started < 2000)
})

await check('a call that is already cancelled never reaches the network', async () => {
  let called = 0
  globalThis.fetch = async (url, init) => { called += 1; return hang(url, init) }
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runpod.createPod('k', {}, { signal: controller.signal }), /cancelled/)
  assert.ok(called <= 1)
})

await check('teardown calls take no caller signal: a cancel elsewhere cannot stop them', async () => {
  const cancelled = new AbortController()
  cancelled.abort() // the tool was cancelled; teardown must still go out
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ method: init.method, url: String(url), aborted: init.signal.aborted })
    return new Response(null, { status: 204 })
  }
  await runpod.deletePod('k', 'p1')
  await vast.destroyInstance('k', 7)
  await vast.deleteSshKey('k', 3)
  assert.deepEqual(requests.map((r) => r.method), ['DELETE', 'DELETE', 'DELETE'])
  assert.ok(requests.every((r) => r.aborted === false))
})

await check('waiting for a pod passes the cancel signal down to the status requests', async () => {
  globalThis.fetch = hang
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 40)
  const started = Date.now()
  await assert.rejects(runpod.waitForPodSsh('k', 'p1', { timeoutMs: 60_000, signal: controller.signal, requestTimeoutMs: 60_000 }), /cancelled|Aborted/)
  assert.ok(Date.now() - started < 2000, 'the wait must not sit in a hung request')
})

await check('errors from the API keep their status and message', async () => {
  globalThis.fetch = async () => json({ title: 'Not Found', detail: 'no such pod' }, 404)
  await assert.rejects(runpod.getPod('k', 'p1'), (error) => error.status === 404 && /no such pod/.test(error.message))
  globalThis.fetch = async () => json({ success: false, msg: 'bad offer' }, 400)
  await assert.rejects(vast.showInstance('k', 7), (error) => error.status === 400 && /bad offer/.test(error.message))
})

clearInterval(keepAlive)
if (process.exitCode) console.error('compute client timeouts: FAILED')
else console.log(`compute client timeouts: ${passed} checks passed`)
