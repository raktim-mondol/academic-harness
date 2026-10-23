import assert from 'node:assert/strict'
import {
  RateLimiter,
  fetchJson,
  getLimiter,
  resetLimitersForTests,
  retryAfterMs,
} from '../search-http.js'

resetLimitersForTests()
assert.equal(getLimiter('same', { minIntervalMs: 10 }), getLimiter('same', { minIntervalMs: 999 }), 'limiter registry must be a singleton per name')

const spaced = new RateLimiter({ minIntervalMs: 80 })
const started = Date.now()
await spaced.run(async () => {})
await spaced.run(async () => {})
const elapsed = Date.now() - started
assert.ok(elapsed >= 70, `expected >=70ms spacing, got ${elapsed}ms`)

const concurrent = new RateLimiter({ minIntervalMs: 0, maxConcurrent: 2 })
let active = 0
let peak = 0
await Promise.all(Array.from({ length: 4 }, () => concurrent.run(async () => {
  active += 1
  peak = Math.max(peak, active)
  await new Promise((resolve) => setTimeout(resolve, 25))
  active -= 1
})))
assert.equal(peak, 2, `expected peak concurrency 2, got ${peak}`)

assert.equal(retryAfterMs('1'), 1000)
assert.equal(retryAfterMs(null), null)
const future = new Date(Date.now() + 5000).toUTCString()
const until = retryAfterMs(future)
assert.ok(until > 3000 && until <= 5000, `expected a future retry-after, got ${until}`)

const originalFetch = globalThis.fetch
let retryCalls = 0
globalThis.fetch = async () => {
  retryCalls += 1
  if (retryCalls === 1) {
    return new Response(JSON.stringify({ message: 'slow down' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '0' },
    })
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
const retried = await fetchJson('https://example.invalid/search', { retries: 1 })
assert.equal(retried.ok, true)
assert.equal(retried.data.ok, true)
assert.equal(retryCalls, 2, '429 must be retried once')

let plainCalls = 0
globalThis.fetch = async () => {
  plainCalls += 1
  return new Response(JSON.stringify({ message: 'not found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  })
}
const missing = await fetchJson('https://example.invalid/search', { retries: 2 })
assert.equal(missing.ok, false)
assert.equal(missing.status, 404)
assert.equal(missing.detail, 'not found')
assert.equal(plainCalls, 1, '404 must not be retried')

globalThis.fetch = async () => new Response(
  JSON.stringify({ error: { code: 'SUBSCRIPTION_TOKEN_INVALID', detail: 'The token is invalid.' } }),
  { status: 422, headers: { 'content-type': 'application/json' } },
)
const detailed = await fetchJson('https://example.invalid/search', { retries: 0 })
assert.equal(detailed.ok, false)
assert.equal(detailed.detail, 'The token is invalid.')

globalThis.fetch = async () => new Response(
  JSON.stringify({ detail: { error: 'Unauthorized: invalid key.' } }),
  { status: 401, headers: { 'content-type': 'application/json' } },
)
const nestedDetail = await fetchJson('https://example.invalid/search', { retries: 0 })
assert.equal(nestedDetail.ok, false)
assert.equal(nestedDetail.detail, 'Unauthorized: invalid key.')

globalThis.fetch = async () => new Response('{"ok":true}', {
  status: 200,
  headers: { 'content-type': 'application/json', 'content-length': '999999' },
})
const tooBig = await fetchJson('https://example.invalid/search', { maxBytes: 10, retries: 0 })
assert.equal(tooBig.ok, false)
assert.match(tooBig.error, /exceeds/)

globalThis.fetch = async () => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('{"ok":true}'))
    controller.close()
  },
}), { status: 200, headers: { 'content-type': 'application/json' } })
const streamedTooBig = await fetchJson('https://example.invalid/search', { maxBytes: 5, retries: 0 })
assert.equal(streamedTooBig.ok, false)
assert.match(streamedTooBig.error, /exceeds/)

globalThis.fetch = originalFetch
console.log('Search rate limiting OK')
