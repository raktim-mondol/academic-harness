import assert from 'node:assert/strict'
import {
  RateLimiter,
  cooldownFailure,
  cooldownRemainingMs,
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

// A quota that resets in hours is not retried (waiting the 30 s cap cannot help) and is not
// asked again: later calls fail instantly without a request. A different credential is not blocked.
resetLimitersForTests()
let quotaCalls = 0
globalThis.fetch = async (url) => {
  quotaCalls += 1
  if (String(url).includes('api_key=GOOD')) {
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return new Response(JSON.stringify({ message: 'budget exhausted' }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': '70384' },
  })
}
const quotaStart = Date.now()
const quotaFirst = await fetchJson('https://quota.invalid/works?search=a', { retries: 2 })
assert.equal(quotaFirst.ok, false)
assert.equal(quotaFirst.cooldown, true)
assert.equal(quotaFirst.retryAfterMs, 70384000)
assert.equal(quotaCalls, 1, 'a multi-hour Retry-After must not be retried')
assert.ok(Date.now() - quotaStart < 2000, 'must fail fast, not sleep through retries')
const quotaSecond = await fetchJson('https://quota.invalid/works?search=b', { retries: 2 })
assert.equal(quotaSecond.cooldown, true)
assert.equal(quotaCalls, 1, 'a provider in cooldown must not be called again')
assert.ok(cooldownRemainingMs('https://quota.invalid/works?search=c') > 70_000_000)
const withKey = await fetchJson('https://quota.invalid/works?search=a&api_key=GOOD', { retries: 2 })
assert.equal(withKey.ok, true, 'entering a key lifts a keyless cooldown')
assert.equal(quotaCalls, 2)
// a short Retry-After is still retried as before
resetLimitersForTests()
let shortCalls = 0
globalThis.fetch = async () => {
  shortCalls += 1
  return shortCalls === 1
    ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } })
    : new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
}
assert.equal((await fetchJson('https://short.invalid/x', { retries: 1 })).ok, true)
assert.equal(shortCalls, 2)

// Two consecutive transient failures open a short cooldown; a success closes the streak;
// a lone failure never trips it.
resetLimitersForTests()
let downCalls = 0
globalThis.fetch = async () => { downCalls += 1; return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }) }
await fetchJson('https://down.invalid/q?x=1', { retries: 0 })
assert.equal(downCalls, 1)
await fetchJson('https://down.invalid/q?x=2', { retries: 0 })
assert.equal(downCalls, 2)
const skipped = await fetchJson('https://down.invalid/q?x=3', { retries: 0 })
assert.equal(downCalls, 2, 'after two failures in a row the provider is not called')
assert.equal(skipped.cooldown, true)
assert.match(cooldownFailure('Down', skipped).error, /Down is rate limiting or unavailable; not called again for 1\d\d s/)
assert.equal(cooldownFailure('Down', { ok: false }), null)
resetLimitersForTests()
let flaky = 0
globalThis.fetch = async () => { flaky += 1; return flaky % 2 ? new Response('{}', { status: 503 }) : new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }) }
for (let i = 0; i < 6; i += 1) await fetchJson(`https://flaky.invalid/q?x=${i}`, { retries: 0 })
assert.equal(flaky, 6, 'alternating failures and successes never open the cooldown')
// "slow down" (429) counts for half: two in a row do not pause a provider, four do
resetLimitersForTests()
let slow = 0
globalThis.fetch = async () => { slow += 1; return new Response('{}', { status: 429 }) }
for (let i = 0; i < 3; i += 1) await fetchJson(`https://slow.invalid/q?x=${i}`, { retries: 0 })
assert.equal(slow, 3, 'three 429s in a row still call the provider')
await fetchJson('https://slow.invalid/q?x=4', { retries: 0 })
await fetchJson('https://slow.invalid/q?x=5', { retries: 0 })
assert.equal(slow, 4, 'the fourth 429 in a row pauses it')
// a permanent error (404) is not a streak
resetLimitersForTests()
let notFound = 0
globalThis.fetch = async () => { notFound += 1; return new Response('{}', { status: 404 }) }
for (let i = 0; i < 4; i += 1) await fetchJson(`https://nf.invalid/q?x=${i}`, { retries: 0 })
assert.equal(notFound, 4)

globalThis.fetch = originalFetch
console.log('Search rate limiting OK')
