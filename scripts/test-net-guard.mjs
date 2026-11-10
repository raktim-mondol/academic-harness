#!/usr/bin/env node
/**
 * One network guard for every place the plugin fetches a URL it did not choose
 * (review A5, decision D32): public hosts only, redirects re-checked at every
 * hop, one deadline that also covers the body, and a byte cap counted on the
 * bytes actually read. fetch and DNS are injected so the guard stays strict:
 * a loopback server is exactly what it must refuse.
 */
import assert from 'node:assert/strict'
import {
  NetGuardError, assertPublicUrl, createBudget, guardedDownload, guardedFetch, isBlockedHostname, isPrivateAddress, iterateBody, streamBody,
} from '../net-guard.js'

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

const PUBLIC = '93.184.216.34'
const publicLookup = async () => [{ address: PUBLIC, family: 4 }]

/** A scripted fetch: responses are consumed in order; every call is recorded. */
function scriptedFetch(responses) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    const next = responses.shift()
    if (!next) throw new Error(`unexpected fetch of ${url}`)
    return typeof next === 'function' ? next(url, init) : next
  }
  impl.calls = calls
  return impl
}
const redirect = (location, status = 302) => new Response(null, { status, headers: { location } })
const ok = (body, headers = {}) => new Response(body, { status: 200, headers })

/** A body that trickles: one byte every `everyMs`, and errors if the request signal fires. */
function slowBody(signal, everyMs = 20, count = 100) {
  let sent = 0
  return new ReadableStream({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, everyMs))
      if (signal?.aborted) return controller.error(signal.reason)
      if (sent >= count) return controller.close()
      sent += 1
      controller.enqueue(new Uint8Array([65]))
    },
  })
}

// ── address classification: the union of the three guards it replaces ───────
await check('private, loopback, link-local, shared and reserved IPv4 ranges are refused', () => {
  for (const a of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.127.255.255',
    '192.0.0.8', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255']) {
    assert.equal(isPrivateAddress(a), true, a)
  }
  for (const a of [PUBLIC, '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.255.255', '198.17.0.1', '193.0.0.1']) assert.equal(isPrivateAddress(a), false, a)
})

await check('IPv6 loopback, unique-local, link-local, multicast, mapped and embedded IPv4 are refused', () => {
  for (const a of ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:c0a8:0101',
    '64:ff9b::7f00:1', '::7f00:1', '2002:7f00:0001::1', '2001:db8::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2']) {
    assert.equal(isPrivateAddress(a), true, a)
  }
  for (const a of ['2001:4860:4860::8888', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateAddress(a), false, a)
})

await check('anything that is not an address counts as private', () => {
  for (const a of ['', 'not-an-ip', '1.2.3', '256.1.1.1', null, undefined, '1.2.3.4.5']) assert.equal(isPrivateAddress(a), true, String(a))
})

await check('local-only host names are refused', () => {
  for (const h of ['localhost', 'LOCALHOST', 'app.localhost', 'printer.local', 'metadata.google.internal', 'db.internal', '', '[::1]']) assert.equal(isBlockedHostname(h), true, h)
  for (const h of ['example.com', 'doi.org', 'localhost.example.com', 'internal.example.com']) assert.equal(isBlockedHostname(h), false, h)
})

// ── assertPublicUrl ──────────────────────────────────────────────────────────
await check('assertPublicUrl returns the URL for a public host and refuses the rest with the old messages', async () => {
  const url = await assertPublicUrl('https://example.com/a.pdf', { lookup: publicLookup })
  assert.equal(url.hostname, 'example.com')
  await assert.rejects(assertPublicUrl('http://127.0.0.1/admin'), /private\/internal/)
  await assert.rejects(assertPublicUrl('http://169.254.169.254/latest/meta-data'), /private\/internal/)
  await assert.rejects(assertPublicUrl('http://[::1]/'), /private\/internal/)
  await assert.rejects(assertPublicUrl('file:///etc/passwd'), /HTTP\(S\)/)
  await assert.rejects(assertPublicUrl('ftp://example.com/x'), /HTTP\(S\)/)
  await assert.rejects(assertPublicUrl('http://localhost:8080/'), /localhost/)
  await assert.rejects(assertPublicUrl('http://printer.local/'), /local/)
  await assert.rejects(assertPublicUrl('not a url'), /invalid URL/)
})

await check('a host that resolves to a private address is refused, even if another address is public', async () => {
  const mixed = async () => [{ address: PUBLIC, family: 4 }, { address: '10.0.0.7', family: 4 }]
  await assert.rejects(assertPublicUrl('https://rebind.example/x', { lookup: mixed }), /resolves to a private\/internal address \(10\.0\.0\.7\)/)
  await assert.rejects(assertPublicUrl('https://empty.example/x', { lookup: async () => [] }), /could not resolve/)
  await assert.rejects(assertPublicUrl('https://nx.example/x', { lookup: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }) } }), /could not resolve/)
})

await check('credentials in the URL are refused unless the caller opts in', async () => {
  await assert.rejects(assertPublicUrl('https://user:pw@example.com/x', { lookup: publicLookup }), /credentials/)
  await assertPublicUrl('https://user:pw@example.com/x', { lookup: publicLookup, allowCredentials: true })
})

// ── guardedFetch: redirects ──────────────────────────────────────────────────
await check('redirects are followed manually and each hop is checked', async () => {
  const fetchImpl = scriptedFetch([redirect('https://cdn.example.org/file.pdf'), ok('data')])
  const { response, url, hops } = await guardedFetch('https://example.com/start', { fetch: fetchImpl, lookup: publicLookup })
  assert.equal(await response.text(), 'data')
  assert.equal(url.href, 'https://cdn.example.org/file.pdf')
  assert.equal(hops, 1)
  assert.deepEqual(fetchImpl.calls.map((c) => c.init.redirect), ['manual', 'manual'])
})

await check('a redirect to a loopback or metadata address is refused before it is fetched', async () => {
  for (const target of ['http://127.0.0.1:9/secret', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/x', 'file:///etc/passwd']) {
    const fetchImpl = scriptedFetch([redirect(target), ok('secret')])
    await assert.rejects(guardedFetch('https://example.com/start', { fetch: fetchImpl, lookup: publicLookup }), /not allowed|private|HTTP\(S\)|localhost/, target)
    assert.equal(fetchImpl.calls.length, 1, `${target} must not be requested`)
  }
})

await check('a redirect whose hostname resolves to a private address is refused', async () => {
  const lookup = async (host) => (host === 'evil.example' ? [{ address: '192.168.1.5', family: 4 }] : [{ address: PUBLIC, family: 4 }])
  const fetchImpl = scriptedFetch([redirect('https://evil.example/x'), ok('x')])
  await assert.rejects(guardedFetch('https://example.com/start', { fetch: fetchImpl, lookup }), /private\/internal/)
  assert.equal(fetchImpl.calls.length, 1)
})

await check('too many redirects is an error with a clear code', async () => {
  const fetchImpl = scriptedFetch(Array.from({ length: 10 }, () => redirect('https://example.com/loop')))
  await assert.rejects(guardedFetch('https://example.com/loop', { fetch: fetchImpl, lookup: publicLookup, maxHops: 3 }), (e) => e instanceof NetGuardError && e.code === 'redirects')
  assert.equal(fetchImpl.calls.length, 4)
})

await check('a redirect with no Location is an error', async () => {
  const fetchImpl = scriptedFetch([new Response(null, { status: 302 })])
  await assert.rejects(guardedFetch('https://example.com/x', { fetch: fetchImpl, lookup: publicLookup }), /without a Location/)
})

await check('credential headers are dropped when a redirect leaves the origin', async () => {
  const fetchImpl = scriptedFetch([redirect('https://other.example/x'), ok('x')])
  await guardedFetch('https://example.com/x', {
    fetch: fetchImpl,
    lookup: publicLookup,
    headers: { 'Wiley-TDM-Client-Token': 'secret', Authorization: 'Bearer t', 'X-Api-Key': 'k', 'User-Agent': 'ua', Accept: '*/*' },
  })
  const first = fetchImpl.calls[0].init.headers
  const second = fetchImpl.calls[1].init.headers
  assert.equal(first['Wiley-TDM-Client-Token'], 'secret')
  for (const name of ['Wiley-TDM-Client-Token', 'Authorization', 'X-Api-Key']) assert.equal(second[name], undefined, `${name} leaked to another origin`)
  assert.equal(second['User-Agent'], 'ua')
  assert.equal(second.Accept, '*/*')
})

await check('credential headers survive a redirect within the same origin', async () => {
  const fetchImpl = scriptedFetch([redirect('/second'), ok('x')])
  await guardedFetch('https://example.com/x', { fetch: fetchImpl, lookup: publicLookup, headers: { Authorization: 'Bearer t' } })
  assert.equal(fetchImpl.calls[1].init.headers.Authorization, 'Bearer t')
})

// ── deadline covers the body ─────────────────────────────────────────────────
await check('the deadline is still armed after the headers arrive and ends a slow body', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = init.signal
    return new Response(slowBody(init.signal, 20, 500), { status: 200 })
  }
  const started = Date.now()
  const { response } = await guardedFetch('https://example.com/slow', { fetch: fetchImpl, lookup: publicLookup, deadlineMs: 120 })
  await assert.rejects(streamBody(response, { maxBytes: 1e6 }), (e) => e instanceof NetGuardError && e.code === 'deadline')
  assert.ok(Date.now() - started < 2000, 'finished promptly')
  assert.equal(seen.aborted, true)
})

await check('the caller can cancel at any point', async () => {
  const controller = new AbortController()
  const fetchImpl = async (url, init) => new Response(slowBody(init.signal, 20, 500), { status: 200 })
  const { response } = await guardedFetch('https://example.com/slow', { fetch: fetchImpl, lookup: publicLookup, signal: controller.signal, deadlineMs: 10_000 })
  setTimeout(() => controller.abort(), 60)
  await assert.rejects(streamBody(response, { maxBytes: 1e6 }), (e) => e instanceof NetGuardError && (e.code === 'aborted' || e.code === 'deadline'))
})

// ── size caps counted on real bytes ──────────────────────────────────────────
await check('a declared Content-Length over the cap is refused before any byte is read', async () => {
  const fetchImpl = scriptedFetch([ok('x'.repeat(10), { 'content-length': '10' })])
  await assert.rejects(guardedDownload('https://example.com/f', { fetch: fetchImpl, lookup: publicLookup, maxBytes: 5 }), (e) => e.code === 'size')
})

await check('a body with no Content-Length is stopped on the bytes actually read', async () => {
  const fetchImpl = scriptedFetch([ok('x'.repeat(50))])
  await assert.rejects(guardedDownload('https://example.com/f', { fetch: fetchImpl, lookup: publicLookup, maxBytes: 5 }), (e) => e.code === 'size')
})

await check('a Content-Length that understates the body does not fool the cap', async () => {
  const lying = new Response('x'.repeat(50), { status: 200, headers: { 'content-length': '3' } })
  await assert.rejects(guardedDownload('https://example.com/f', { fetch: scriptedFetch([lying]), lookup: publicLookup, maxBytes: 5 }), (e) => e.code === 'size')
})

await check('a shared budget is spent across downloads, so two small files cannot exceed the total', async () => {
  const budget = createBudget(5)
  const one = await guardedDownload('https://example.com/a', { fetch: scriptedFetch([ok('1234')]), lookup: publicLookup, maxBytes: 100, budget })
  assert.equal(one.buffer.length, 4)
  assert.equal(budget.remaining, 1)
  await assert.rejects(guardedDownload('https://example.com/b', { fetch: scriptedFetch([ok('5678')]), lookup: publicLookup, maxBytes: 100, budget }), (e) => e.code === 'size' && /total/.test(e.message))
})

await check('streamBody can hand chunks to a sink instead of buffering them', async () => {
  const chunks = []
  const total = await streamBody(ok('hello world'), { maxBytes: 100, onChunk: (c) => chunks.push(Buffer.from(c)) })
  assert.equal(total, 11)
  assert.equal(Buffer.concat(chunks).toString(), 'hello world')
})

await check('a download returns the bytes, the final URL and the response headers', async () => {
  const fetchImpl = scriptedFetch([redirect('https://cdn.example.org/x.bin'), ok('payload', { 'content-type': 'application/octet-stream' })])
  const result = await guardedDownload('https://example.com/start', { fetch: fetchImpl, lookup: publicLookup, maxBytes: 100 })
  assert.equal(result.buffer.toString(), 'payload')
  assert.equal(result.url.href, 'https://cdn.example.org/x.bin')
  assert.equal(result.headers.get('content-type'), 'application/octet-stream')
  assert.equal(result.status, 200)
})

await check('a non-2xx final response is an error carrying the status', async () => {
  await assert.rejects(guardedDownload('https://example.com/x', { fetch: scriptedFetch([new Response('nope', { status: 404 })]), lookup: publicLookup, maxBytes: 100 }), (e) => e.code === 'http' && e.status === 404)
})

await check('a server that never sends headers is cut off by the header timeout, while the overall deadline stays long', async () => {
  const hang = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))
  const started = Date.now()
  await assert.rejects(guardedFetch('https://example.com/hang', { fetch: hang, lookup: publicLookup, headersMs: 80, deadlineMs: 60_000 }), (e) => e instanceof NetGuardError && e.code === 'deadline')
  assert.ok(Date.now() - started < 1500)
})

await check('the header timeout is released once headers arrive, so a long body is not cut by it', async () => {
  const fetchImpl = async (url, init) => new Response(slowBody(init.signal, 15, 20), { status: 200 })
  const { response } = await guardedFetch('https://example.com/long', { fetch: fetchImpl, lookup: publicLookup, headersMs: 50, deadlineMs: 10_000 })
  const total = await streamBody(response, { maxBytes: 1e6 })
  assert.equal(total, 20, 'a body slower than headersMs still completes')
})

await check('an idle body is cut off after idleMs even though the overall deadline is far away', async () => {
  const stalled = new Response(new ReadableStream({ async pull() { await new Promise((r) => setTimeout(r, 5_000)) } }), { status: 200 })
  const started = Date.now()
  await assert.rejects(streamBody(stalled, { maxBytes: 1e6, idleMs: 100 }), (e) => e instanceof NetGuardError && e.code === 'deadline' && /stalled/.test(e.message))
  assert.ok(Date.now() - started < 2000)
})

await check('a steady body is not cut off by the idle timeout', async () => {
  const response = new Response(slowBody(undefined, 20, 15), { status: 200 })
  assert.equal(await streamBody(response, { maxBytes: 1e6, idleMs: 200 }), 15)
})

await check('iterateBody yields the chunks and cancels the reader if the consumer stops early', async () => {
  let cancelled = false
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array([1, 2, 3])) },
    cancel() { cancelled = true },
  })
  let seen = 0
  for await (const chunk of iterateBody(new Response(body))) {
    seen += chunk.byteLength
    if (seen >= 6) break
  }
  assert.equal(seen, 6)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(cancelled, true)
})

if (process.exitCode) console.error('net guard: FAILED')
else console.log(`net guard: ${passed} checks passed`)
