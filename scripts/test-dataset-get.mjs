import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply, runDatasetGet } from '../dataset-get.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const workspace = makeWorkspace('ah-dataset-')
const cwd = workspace.cwd
const exec = fakeExec(cwd)
let tool
apply({ tools: { register: (registered) => { tool = registered } } })

const ZENODO_DOI = '10.5281/zenodo.1234567'
const payload = Buffer.from('col1,col2\n1,2\n3,4\n')
const sha256 = `sha256:${createHash('sha256').update(payload).digest('hex')}`
const md5hex = createHash('md5').update(payload).digest('hex')

function fakeSearch({ action, doi }) {
  if (doi === '10.5281/zenodo.7777777') {
    if (action === 'files') return Promise.resolve({ error: 'Zenodo API error 0: network error' })
    return Promise.resolve({ dataset: { doi, title: 'Flaky listing', creators: [], publisher: 'Zenodo', year: 2024, resource_type: 'Dataset', version: null, license: 'CC0-1.0', url: `https://doi.org/${doi}`, description: null } })
  }
  if (doi !== ZENODO_DOI && doi !== '10.6084/m9.figshare.999' && doi !== '10.5061/dryad.abc') {
    return Promise.resolve({ error: `dataset DOI not found in DataCite: ${doi}` })
  }
  if (action === 'get') {
    return Promise.resolve({
      dataset: {
        doi,
        title: 'Test dataset',
        creators: ['Doe, J'],
        publisher: doi.startsWith('10.5281') ? 'Zenodo' : 'Figshare',
        year: 2024,
        resource_type: 'Dataset',
        version: doi.startsWith('10.5281') ? 'v2' : null,
        license: doi.startsWith('10.5281') ? 'CC-BY-4.0' : null,
        url: `https://doi.org/${doi}`,
        description: null,
      },
    })
  }
  if (action === 'files') {
    if (doi.startsWith('10.5061')) {
      return Promise.resolve({ doi, files_unavailable: true, reason: 'file listings are resolved only for Zenodo and Figshare DOIs', landing_url: `https://doi.org/${doi}` })
    }
    return Promise.resolve({
      doi,
      repository: doi.startsWith('10.5281') ? 'Zenodo' : 'Figshare',
      file_count: 2,
      truncated: false,
      files: [
        { name: 'data.csv', size: payload.length, checksum: doi.startsWith('10.5281') ? `md5:${md5hex}` : sha256, download_url: 'https://example.invalid/data.csv' },
        { name: 'notes/../escape.txt', size: 3, checksum: null, download_url: 'https://example.invalid/escape.txt' },
      ],
    })
  }
  return Promise.resolve({ error: 'bad action' })
}

function streamOf(buffer) {
  return {
    async * [Symbol.asyncIterator]() { yield new Uint8Array(buffer) },
    async cancel() {},
  }
}

const fakeFetchBinary = async (url) => {
  if (url.endsWith('data.csv')) return { ok: true, stream: streamOf(payload), contentLength: payload.length }
  return { ok: true, stream: streamOf(Buffer.from('x')), contentLength: 1 }
}
const failingFetchBinary = async () => ({ ok: false, status: 503, error: 'HTTP 503' })

const deps = { search: fakeSearch, fetchBinary: fakeFetchBinary }

try {
  // get: metadata without downloading.
  let result = await runDatasetGet({ action: 'get', doi: ZENODO_DOI }, exec, deps)
  assert.equal(result.record.dataset.license, 'CC-BY-4.0')
  assert.equal(result.record.files.length, 2)
  assert.ok(!existsSync(join(cwd, 'data')), 'get must not download')

  // download: md5 source checksum verified, escape path rejected, manifest written.
  result = await runDatasetGet({ action: 'download', doi: ZENODO_DOI }, exec, deps)
  assert.equal(result.slug, '10-5281-zenodo-1234567')
  const event = result.event
  assert.equal(event.doi, ZENODO_DOI)
  assert.equal(event.license_stated, true)
  const dataFile = event.files.find((file) => file.name === 'data.csv')
  assert.equal(dataFile.status, 'downloaded')
  assert.equal(dataFile.verification, 'verified', 'md5 source checksum compared')
  assert.equal(dataFile.sha256, sha256)
  const escapeFile = event.files.find((file) => file.name.startsWith('notes/'))
  assert.equal(escapeFile.status, 'downloaded')
  assert.equal(escapeFile.path, join('data', result.slug, 'notes_.._escape.txt'), 'path separators are flattened into the name')
  assert.ok(!existsSync(join(cwd, 'data', result.slug, 'escape.txt')))
  assert.ok(existsSync(join(cwd, 'data', result.slug, 'data.csv')))

  // verify: ok, then changed, then missing.
  let verify = await runDatasetGet({ action: 'verify', slug: result.slug }, exec, deps)
  assert.equal(verify.result.files.find((file) => file.name === 'data.csv').status, 'ok_no_source_sha256')
  writeFileSync(join(cwd, 'data', result.slug, 'data.csv'), 'tampered')
  verify = await runDatasetGet({ action: 'verify', slug: result.slug }, exec, deps)
  assert.equal(verify.result.files.find((file) => file.name === 'data.csv').status, 'changed')
  assert.equal(verify.result.problems.length, 1)
  rmSync(join(cwd, 'data', result.slug, 'data.csv'))
  verify = await runDatasetGet({ action: 'verify', slug: result.slug }, exec, deps)
  assert.equal(verify.result.files.find((file) => file.name === 'data.csv').status, 'missing')

  // status reports the download history and missing checksums.
  let status = await runDatasetGet({ action: 'status', slug: result.slug }, exec, deps)
  assert.equal(status.status.downloads, 1)
  assert.ok(status.status.latest.bytes >= 0)

  // sha256 source checksums verify directly (Figshare path, license not stated).
  result = await runDatasetGet({ action: 'download', doi: '10.6084/m9.figshare.999', slug: 'fig', files: ['data.csv'] }, exec, deps)
  const figFile = result.event.files[0]
  assert.equal(figFile.verification, 'verified')
  assert.equal(result.event.license_stated, false, 'unknown license is flagged, not guessed')

  // Size caps and download failures are recorded per file.
  result = await runDatasetGet({ action: 'download', doi: ZENODO_DOI, slug: 'capped', max_bytes_per_file: 4 }, exec, deps)
  assert.equal(result.event.files.find((file) => file.name === 'data.csv').status, 'size_limit_exceeded')
  result = await runDatasetGet({ action: 'download', doi: ZENODO_DOI, slug: 'total', max_total_bytes: 4 }, exec, deps)
  assert.equal(result.event.files.find((file) => file.name === 'data.csv').status, 'total_limit_exceeded')
  result = await runDatasetGet({ action: 'download', doi: ZENODO_DOI, slug: 'down' }, exec, { ...deps, fetchBinary: failingFetchBinary })
  assert.equal(result.event.files.find((file) => file.name === 'data.csv').status, 'download_failed')

  // File selection and unknown repositories.
  await assert.rejects(
    () => runDatasetGet({ action: 'download', doi: ZENODO_DOI, files: ['nope.csv'] }, exec, deps),
    /not a file in this record/,
  )
  await assert.rejects(
    () => runDatasetGet({ action: 'download', doi: '10.5061/dryad.abc' }, exec, deps),
    /no downloadable files/,
  )
  await assert.rejects(() => runDatasetGet({ action: 'get', doi: 'not-a-doi' }, exec, deps), /doi is required/)
  await assert.rejects(() => runDatasetGet({ action: 'verify', slug: 'ghost' }, exec, deps), /no downloads recorded/)
  await assert.rejects(() => runDatasetGet({ action: 'status' }, exec, deps), /slug is required/)

  // A failed file listing is surfaced as unavailable with a reason, never silently empty.
  result = await runDatasetGet({ action: 'get', doi: '10.5281/zenodo.7777777' }, exec, deps)
  assert.equal(result.record.files_unavailable, true)
  assert.match(result.record.files_reason, /file listing failed: Zenodo API error/)
  await assert.rejects(
    () => runDatasetGet({ action: 'download', doi: '10.5281/zenodo.7777777' }, exec, deps),
    /no downloadable files.*file listing failed/,
  )

  // The tool wrapper returns {error} and renders structured output.
  const wrapped = await tool.execute({ action: 'verify', slug: 'ghost' }, exec)
  assert.match(wrapped.error, /no downloads recorded/)
  const okStatus = await tool.execute({ action: 'status', slug: 'ghost' }, exec)
  assert.equal(okStatus.status.downloads, 0)

  // Loopback HTTP: exercise the real fetchBinary/stream/hash path end to end.
  const http = await import('node:http')
  const body = Buffer.from('loopback,payload\n1,2\n')
  const loopSha = 'sha256:' + createHash('sha256').update(body).digest('hex')
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const loopDeps = {
    search: async ({ action }) => action === 'get'
      ? { dataset: { doi: ZENODO_DOI, title: 'Loopback', creators: [], publisher: 'Zenodo', year: 2024, resource_type: 'Dataset', version: null, license: 'MIT', url: 'https://doi.org/x', description: null } }
      : { repository: 'Zenodo', files: [{ name: 'loop.csv', size: body.length, checksum: loopSha, download_url: `http://127.0.0.1:${port}/loop.csv` }] },
  }
  result = await runDatasetGet({ action: 'download', doi: ZENODO_DOI, slug: 'loopback' }, exec, loopDeps)
  const loopFile = result.event.files[0]
  assert.equal(loopFile.status, 'downloaded')
  assert.equal(loopFile.verification, 'verified', 'real streaming path hashes match the record checksum')
  assert.deepEqual(readFileSync(join(cwd, loopFile.path)), body)
  const loopVerify = await runDatasetGet({ action: 'verify', slug: 'loopback' }, exec, loopDeps)
  assert.equal(loopVerify.result.files[0].status, 'ok')
  server.close()

  console.log('dataset_get OK')
} finally {
  workspace.cleanup()
}
