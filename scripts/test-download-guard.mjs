#!/usr/bin/env node
/**
 * Review A5 (decision D32) at the dataset downloader: the real default fetcher
 * must not follow a redirect to a private address, the total byte cap must hold
 * when a server sends no Content-Length, a stalled or oversized body must leave
 * no partial file behind, and one bad file must not abort the rest of a batch.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorkspace } from './helpers/test-workspace.mjs'

const { defaultFetchBinary, downloadDataset } = await import('../dataset-get.js')

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

function recordOf(files) {
  return {
    doi: '10.5281/zenodo.1',
    dataset: { version: '1', license: 'CC-BY-4.0' },
    landing_url: 'https://doi.org/10.5281/zenodo.1',
    repository: 'Zenodo',
    files: files.map((name) => ({ name, download_url: `https://data.example.org/${name}` })),
  }
}

const bytesOf = (text) => ({
  async * [Symbol.asyncIterator]() { yield new Uint8Array(Buffer.from(text)) },
  async cancel() {},
})
function filesIn(ws, slug) {
  const dir = join(ws.cwd, 'data', slug)
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

await check('a redirect from a public host to a loopback or metadata address is refused and never requested', async () => {
  for (const target of ['http://127.0.0.1:9/secret.csv', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/x']) {
    const calls = []
    const fetchImpl = async (url) => {
      calls.push(String(url))
      return calls.length === 1 ? redirect(target) : new Response('secret', { status: 200 })
    }
    const result = await defaultFetchBinary('https://data.example.org/a.csv', { fetch: fetchImpl, lookup: publicLookup })
    assert.equal(result.ok, false, target)
    assert.match(result.error, /private|localhost|not allowed/, target)
    assert.equal(calls.length, 1, `${target} must not be requested`)
  }
})

await check('a direct link to a private address is refused', async () => {
  const result = await defaultFetchBinary('http://10.0.0.5/data.csv', { fetch: async () => new Response('x'), lookup: publicLookup })
  assert.equal(result.ok, false)
  assert.match(result.error, /private\/internal/)
})

await check('a normal download streams through the guard and reports its length when declared', async () => {
  const fetchImpl = async () => new Response('a,b\n1,2\n', { status: 200, headers: { 'content-length': '8' } })
  const result = await defaultFetchBinary('https://data.example.org/a.csv', { fetch: fetchImpl, lookup: publicLookup })
  assert.equal(result.ok, true)
  assert.equal(result.contentLength, 8)
  let text = ''
  for await (const chunk of result.stream) text += Buffer.from(chunk).toString()
  assert.equal(text, 'a,b\n1,2\n')
})

await check('an HTTP error status is a per-file failure, not an exception', async () => {
  const result = await defaultFetchBinary('https://data.example.org/a.csv', { fetch: async () => new Response('no', { status: 503 }), lookup: publicLookup })
  assert.deepEqual({ ok: result.ok, status: result.status }, { ok: false, status: 503 })
})

await check('two files with no Content-Length cannot exceed a 5-byte total cap', async () => {
  const ws = makeWorkspace('ah-dl-total-')
  try {
    const fetchBinary = async () => ({ ok: true, stream: bytesOf('1234') }) // 4 bytes each, nothing declared
    const event = await downloadDataset({ cwd: ws.cwd, slug: 't', record: recordOf(['one.bin', 'two.bin']), maxTotalBytes: 5, fetchBinary })
    assert.deepEqual(event.files.map((f) => f.status), ['downloaded', 'total_limit_exceeded'])
    assert.deepEqual(filesIn(ws, 't'), ['one.bin'], 'the second file must not be left on disk')
    assert.equal(readFileSync(join(ws.cwd, 'data', 't', 'one.bin'), 'utf8'), '1234')
  } finally {
    ws.cleanup()
  }
})

await check('a file over the per-file cap leaves no partial file', async () => {
  const ws = makeWorkspace('ah-dl-file-')
  try {
    const fetchBinary = async () => ({ ok: true, stream: bytesOf('0123456789') })
    const event = await downloadDataset({ cwd: ws.cwd, slug: 'f', record: recordOf(['big.bin']), maxFileBytes: 4, fetchBinary })
    assert.equal(event.files[0].status, 'size_limit_exceeded')
    assert.deepEqual(filesIn(ws, 'f'), [])
  } finally {
    ws.cleanup()
  }
})

await check('a stream that fails midway is a download_failed for that file only, with no partial file', async () => {
  const ws = makeWorkspace('ah-dl-fail-')
  try {
    const failing = { async * [Symbol.asyncIterator]() { yield new Uint8Array(Buffer.from('par')); throw new Error('connection reset') }, async cancel() {} }
    const fetchBinary = async (url) => (url.endsWith('bad.bin') ? { ok: true, stream: failing } : { ok: true, stream: bytesOf('good') })
    const event = await downloadDataset({ cwd: ws.cwd, slug: 'x', record: recordOf(['bad.bin', 'good.bin']), fetchBinary })
    assert.deepEqual(event.files.map((f) => f.status), ['download_failed', 'downloaded'])
    assert.match(event.files[0].error, /connection reset/)
    assert.deepEqual(filesIn(ws, 'x'), ['good.bin'])
  } finally {
    ws.cleanup()
  }
})

await check('a body that stalls is cut off by the idle timeout and recorded as a failure', async () => {
  const ws = makeWorkspace('ah-dl-stall-')
  try {
    const fetchImpl = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(Buffer.from('first'))) },
      async pull() { await new Promise((r) => setTimeout(r, 5_000)) },
    }), { status: 200 })
    const fetchBinary = (url, opts) => defaultFetchBinary(url, { ...opts, fetch: fetchImpl, lookup: publicLookup, idleMs: 100 })
    const started = Date.now()
    const event = await downloadDataset({ cwd: ws.cwd, slug: 's', record: recordOf(['slow.bin']), fetchBinary })
    assert.equal(event.files[0].status, 'download_failed')
    assert.match(event.files[0].error, /stalled/)
    assert.ok(Date.now() - started < 3000)
    assert.deepEqual(filesIn(ws, 's'), [])
  } finally {
    ws.cleanup()
  }
})

await check('the real fetcher plus the real writer round-trip a file and hash it', async () => {
  const ws = makeWorkspace('ah-dl-ok-')
  try {
    const fetchImpl = async () => new Response('x,y\n1,2\n', { status: 200 })
    const fetchBinary = (url, opts) => defaultFetchBinary(url, { ...opts, fetch: fetchImpl, lookup: publicLookup })
    const event = await downloadDataset({ cwd: ws.cwd, slug: 'ok', record: recordOf(['d.csv']), fetchBinary })
    assert.equal(event.files[0].status, 'downloaded')
    assert.equal(event.files[0].bytes, 8)
    assert.match(event.files[0].sha256, /^sha256:[0-9a-f]{64}$/)
    assert.deepEqual(filesIn(ws, 'ok'), ['d.csv'])
  } finally {
    ws.cleanup()
  }
})

if (process.exitCode) console.error('download guard: FAILED')
else console.log(`download guard: ${passed} checks passed`)
