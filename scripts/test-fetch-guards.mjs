#!/usr/bin/env node
/**
 * Review A5 (decision D32) at the publisher PDF fetch and the image-URL fetch:
 * both used `redirect: 'follow'` with no host check; the Wiley fetch read the
 * whole body before enforcing its size cap and let its token header travel to
 * whatever origin a redirect chose.
 */
import assert from 'node:assert/strict'

process.env.WILEY_TDM_TOKEN = 'wiley-secret-token'
const { fetchWileyPdf } = await import('../publisher-tdm.js')
const { downloadGeneratedImage } = await import('../image-gen-client.js')

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
const redirect = (location) => new Response(null, { status: 302, headers: { location } })
const pdf = (extra = '') => new Response(Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(extra)]), { status: 200, headers: { 'content-type': 'application/pdf' } })

function scripted(responses) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {}, redirect: init?.redirect })
    const next = responses.shift()
    if (!next) throw new Error(`unexpected request to ${url}`)
    return next
  }
  impl.calls = calls
  return impl
}

// ── Wiley TDM ────────────────────────────────────────────────────────────────
await check('Wiley: a PDF comes back as a buffer and the token is sent to the API host', async () => {
  const fetchImpl = scripted([pdf('body')])
  const result = await fetchWileyPdf('10.1002/abc.123', { fetch: fetchImpl, lookup: publicLookup })
  assert.ok(Buffer.isBuffer(result.buffer))
  assert.ok(result.buffer.subarray(0, 4).equals(Buffer.from('%PDF')))
  assert.equal(fetchImpl.calls[0].headers['Wiley-TDM-Client-Token'], 'wiley-secret-token')
  assert.match(fetchImpl.calls[0].url, /^https:\/\/api\.wiley\.com\/onlinelibrary\/tdm\/v1\/articles\/10\.1002%2Fabc\.123$/)
  assert.equal(fetchImpl.calls[0].redirect, 'manual')
})

await check('Wiley: the token is not sent to another origin after a redirect', async () => {
  const fetchImpl = scripted([redirect('https://cdn.other.example/file.pdf'), pdf()])
  const result = await fetchWileyPdf('10.1002/abc', { fetch: fetchImpl, lookup: publicLookup })
  assert.ok(result.buffer)
  assert.equal(fetchImpl.calls[1].url, 'https://cdn.other.example/file.pdf')
  assert.equal(fetchImpl.calls[1].headers['Wiley-TDM-Client-Token'], undefined, 'token leaked to the CDN')
})

await check('Wiley: a redirect to a local or private address is refused and not requested', async () => {
  for (const target of ['http://127.0.0.1:8080/x.pdf', 'http://169.254.169.254/latest/meta-data/']) {
    const fetchImpl = scripted([redirect(target), pdf()])
    const result = await fetchWileyPdf('10.1002/abc', { fetch: fetchImpl, lookup: publicLookup })
    assert.match(result.error, /private|not allowed|localhost/, target)
    assert.equal(fetchImpl.calls.length, 1)
  }
})

await check('Wiley: the 25 MB cap is enforced on the bytes read, not after reading everything', async () => {
  let pulled = 0
  const huge = new Response(new ReadableStream({
    pull(controller) {
      pulled += 1
      controller.enqueue(new Uint8Array(1024 * 1024))
      if (pulled > 200) controller.close()
    },
  }), { status: 200 })
  const result = await fetchWileyPdf('10.1002/abc', { fetch: scripted([huge]), lookup: publicLookup })
  assert.match(result.error, /exceeds the 25 MB limit/)
  assert.ok(pulled < 40, `read ${pulled} MB before giving up`)
})

await check('Wiley: HTTP errors and non-PDF bodies keep their messages', async () => {
  assert.match((await fetchWileyPdf('10.1002/abc', { fetch: scripted([new Response('no', { status: 403 })]), lookup: publicLookup })).error, /Wiley TDM returned HTTP 403/)
  assert.match((await fetchWileyPdf('10.1002/abc', { fetch: scripted([new Response('<html>login</html>', { status: 200 })]), lookup: publicLookup })).error, /was not a PDF/)
  assert.equal((await fetchWileyPdf('not a doi', { fetch: scripted([]), lookup: publicLookup })).error, 'invalid DOI')
})

// ── generated image URLs ─────────────────────────────────────────────────────
await check('image: a public URL is downloaded with its content type', async () => {
  const fetchImpl = scripted([new Response(Buffer.from('PNGDATA'), { status: 200, headers: { 'content-type': 'image/webp; charset=binary' } })])
  const image = await downloadGeneratedImage('https://images.example.org/a.webp', { fetch: fetchImpl, lookup: publicLookup })
  assert.equal(image.buffer.toString(), 'PNGDATA')
  assert.equal(image.mimeType, 'image/webp')
})

await check('image: a URL naming a loopback, private or metadata address is refused and not requested', async () => {
  for (const url of ['http://127.0.0.1:9999/leak.png', 'http://10.1.2.3/x.png', 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd']) {
    const fetchImpl = scripted([new Response('secret')])
    await assert.rejects(downloadGeneratedImage(url, { fetch: fetchImpl, lookup: publicLookup }), /generated image URL.*(private|not allowed|HTTP\(S\)|localhost)/i, url)
    assert.equal(fetchImpl.calls.length, 0, `${url} must not be requested`)
  }
})

await check('image: a redirect to a private address is refused', async () => {
  const fetchImpl = scripted([redirect('http://192.168.0.9/x.png'), new Response('secret')])
  await assert.rejects(downloadGeneratedImage('https://images.example.org/a.png', { fetch: fetchImpl, lookup: publicLookup }), /private/)
  assert.equal(fetchImpl.calls.length, 1)
})

await check('image: an oversized body and an HTTP error are errors', async () => {
  await assert.rejects(downloadGeneratedImage('https://images.example.org/a.png', { fetch: scripted([new Response(Buffer.alloc(2048))]), lookup: publicLookup, maxBytes: 1024 }), /limit/)
  await assert.rejects(downloadGeneratedImage('https://images.example.org/a.png', { fetch: scripted([new Response('x', { status: 404 })]), lookup: publicLookup }), /HTTP 404/)
})

if (process.exitCode) console.error('fetch guards: FAILED')
else console.log(`fetch guards: ${passed} checks passed`)
