#!/usr/bin/env node
/**
 * Review A9 (decision D34): API keys were sent in URL paths and query strings,
 * where proxies, server access logs and error messages keep them. Three providers
 * document a header for the same key (checked against their documentation):
 *
 *   OpenAlex   Authorization: Bearer <key>         ("Both work identically")
 *   openFDA    Authorization: Basic base64(key:)   (key as the basic-auth username)
 *   Firecrawl  Authorization: Bearer <key> to https://mcp.firecrawl.dev/v2/mcp
 *
 * The URL-only providers (NCBI PubMed, Springer Nature) have no documented
 * header; their keys stay in the query string and are redacted from logs.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const KEY = 'sk-super-secret-key-12345'
process.env.OPENALEX_API_KEY = KEY
process.env.FIRECRAWL_API_KEY = KEY
process.env.OPENFDA_API_KEY = KEY

const { relocateCredential, firecrawlMcp, FIRECRAWL_MCP_URL, credentialFingerprint } = await import('../provider-auth.js')
const { fetchJson, fetchText, resetLimitersForTests } = await import('../search-http.js')
const { callMcpTool, resetMcpHttpForTests, sessionKeysForTests } = await import('../mcp-http.js')

let passed = 0
const original = globalThis.fetch
async function check(label, fn) {
  resetLimitersForTests()
  resetMcpHttpForTests()
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
const json = (value, init = {}) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
const headerOf = (init, name) => {
  const h = init?.headers ?? {}
  if (typeof h.get === 'function') return h.get(name)
  const hit = Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase())
  return hit ? hit[1] : undefined
}

// ── relocation rule ──────────────────────────────────────────────────────────
await check('OpenAlex: the key moves to a Bearer header and every other part of the URL is untouched', () => {
  const url = 'https://api.openalex.org/works/doi:10.1002/abc.123?select=id,doi&api_key=KEY1&mailto=me%40example.org'
  const out = relocateCredential(url, { 'User-Agent': 'ua' })
  assert.equal(out.url, 'https://api.openalex.org/works/doi:10.1002/abc.123?select=id,doi&mailto=me%40example.org')
  assert.equal(out.headers.Authorization, 'Bearer KEY1')
  assert.equal(out.headers['User-Agent'], 'ua')
})

await check('the key may be first, last or alone in the query string', () => {
  assert.equal(relocateCredential('https://api.openalex.org/works?api_key=K&per_page=5').url, 'https://api.openalex.org/works?per_page=5')
  assert.equal(relocateCredential('https://api.openalex.org/works?per_page=5&api_key=K').url, 'https://api.openalex.org/works?per_page=5')
  assert.equal(relocateCredential('https://api.openalex.org/works?api_key=K').url, 'https://api.openalex.org/works')
  assert.equal(relocateCredential('https://api.openalex.org/works?per_page=5').url, 'https://api.openalex.org/works?per_page=5')
})

await check('openFDA: the key becomes the Basic-auth username', () => {
  const out = relocateCredential('https://api.fda.gov/drug/label.json?search=aspirin&limit=3&api_key=FDAKEY')
  assert.equal(out.url, 'https://api.fda.gov/drug/label.json?search=aspirin&limit=3')
  assert.equal(out.headers.Authorization, `Basic ${Buffer.from('FDAKEY:').toString('base64')}`)
})

await check('hosts with no documented header are left exactly as they were', () => {
  for (const url of ['https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&api_key=NCBI', 'https://api.springernature.com/meta/v2/json?q=x&api_key=SPR', 'https://example.org/x?api_key=Z']) {
    const out = relocateCredential(url, { A: '1' })
    assert.equal(out.url, url)
    assert.deepEqual(out.headers, { A: '1' })
  }
})

await check('a caller-supplied Authorization header is never overwritten', () => {
  const out = relocateCredential('https://api.openalex.org/works?api_key=K', { authorization: 'Bearer mine' })
  assert.equal(out.headers.authorization, 'Bearer mine')
  assert.equal(out.headers.Authorization, undefined)
  assert.ok(!out.url.includes('api_key'))
})

await check('the key is decoded before it is put in the header', () => {
  assert.equal(relocateCredential('https://api.openalex.org/works?api_key=a%2Bb%3Dc').headers.Authorization, 'Bearer a+b=c')
})

await check('an unparseable URL or a missing key passes through untouched', () => {
  assert.deepEqual(relocateCredential('not a url', { A: '1' }), { url: 'not a url', headers: { A: '1' } })
  assert.deepEqual(relocateCredential('https://api.openalex.org/works', undefined), { url: 'https://api.openalex.org/works', headers: undefined })
})

// ── what really goes out ─────────────────────────────────────────────────────
await check('fetchJson sends the OpenAlex key in the header only', async () => {
  const seen = []
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), init }); return json({ ok: true }) }
  const result = await fetchJson(`https://api.openalex.org/works?filter=doi:10.1/x&api_key=${KEY}`, { headers: { 'User-Agent': 'ua' }, retries: 0 })
  assert.equal(result.ok, true)
  assert.equal(seen.length, 1)
  assert.ok(!seen[0].url.includes(KEY), `key found in the URL: ${seen[0].url}`)
  assert.equal(seen[0].url, 'https://api.openalex.org/works?filter=doi:10.1/x')
  assert.equal(headerOf(seen[0].init, 'authorization'), `Bearer ${KEY}`)
  assert.equal(headerOf(seen[0].init, 'user-agent'), 'ua')
})

await check('fetchText does the same, and the key survives retries', async () => {
  const seen = []
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), init }); return seen.length === 1 ? new Response('busy', { status: 503 }) : new Response('fine') }
  const result = await fetchText(`https://api.openalex.org/works?api_key=${KEY}`, { retries: 2, minRetryDelayMs: 1 })
  assert.equal(result.ok, true)
  assert.equal(seen.length, 2)
  for (const call of seen) {
    assert.ok(!call.url.includes(KEY))
    assert.equal(headerOf(call.init, 'authorization'), `Bearer ${KEY}`)
  }
})

await check('error text and detail never carry the key', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'bad' }), { status: 400 })
  const result = await fetchJson(`https://api.openalex.org/works?api_key=${KEY}`, { retries: 0 })
  assert.equal(result.ok, false)
  assert.ok(!JSON.stringify(result).includes(KEY))
})

await check('the real OpenAlex callers (search, resolve) put nothing secret in the URL', async () => {
  const seen = []
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), init }); return json({ results: [], meta: { count: 0 }, id: 'https://openalex.org/W1' }) }
  const { fetchOpenAlexWork } = await import('../paper-resolve.js')
  await fetchOpenAlexWork('10.1038/nature12373', { apiKey: KEY, email: 'me@example.org' }).catch(() => {})
  const { runOpenAlexSearch } = await import('../openalex-search.js')
  await runOpenAlexSearch({ entity: 'works', query: 'crispr' }, { agent: { session: { header: { cwd: process.cwd() } } } }).catch(() => {})
  assert.ok(seen.length >= 2, `only ${seen.length} request(s) captured`)
  for (const call of seen) {
    assert.ok(!call.url.includes(KEY), `key in URL: ${call.url}`)
    assert.ok(!/api_key/.test(call.url), `api_key parameter in URL: ${call.url}`)
    assert.equal(headerOf(call.init, 'authorization'), `Bearer ${KEY}`, call.url)
  }
})

// ── Firecrawl MCP ────────────────────────────────────────────────────────────
await check('the Firecrawl endpoint is the documented keyless URL with a Bearer header', () => {
  const { endpoint, headers } = firecrawlMcp(KEY)
  assert.equal(endpoint, 'https://mcp.firecrawl.dev/v2/mcp')
  assert.equal(FIRECRAWL_MCP_URL, endpoint)
  assert.equal(headers.Authorization, `Bearer ${KEY}`)
  assert.ok(!endpoint.includes(KEY))
})

await check('the Firecrawl MCP connector mounts with a header, not a key in the path', async () => {
  const { apply } = await import('../mcp-connectors.js')
  const mounted = []
  await apply({ plugin: (mod, config) => mounted.push(config) })
  const firecrawl = mounted.find((c) => c.serverName === 'firecrawl')
  assert.equal(firecrawl.url, 'https://mcp.firecrawl.dev/v2/mcp')
  assert.equal(firecrawl.headers.Authorization, `Bearer ${KEY}`)
  assert.ok(!JSON.stringify(firecrawl.url).includes(KEY))
})

await check('runFirecrawlPapers sends the key in the header and keeps it out of the URL and the session cache', async () => {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init })
    const body = JSON.parse(init.body)
    if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: 1, result: {} }, { headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess' } })
    if (body.method === 'tools/call') return json({ jsonrpc: '2.0', id: body.id, result: { content: [], structuredContent: { results: [] } } })
    return new Response(null, { status: 202 })
  }
  const { runFirecrawlPapers } = await import('../firecrawl-papers.js')
  const result = await runFirecrawlPapers({ query: 'semaglutide' })
  assert.equal(result.error, undefined, JSON.stringify(result))
  assert.ok(seen.length >= 2)
  for (const call of seen) {
    assert.equal(call.url, 'https://mcp.firecrawl.dev/v2/mcp')
    assert.equal(headerOf(call.init, 'authorization'), `Bearer ${KEY}`)
  }
  const keys = sessionKeysForTests()
  assert.ok(keys.length >= 1)
  for (const key of keys) assert.ok(!key.includes(KEY), `the session cache holds the raw key: ${key}`)
})

await check('two keys on one endpoint get separate MCP sessions', async () => {
  let opened = 0
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    if (body.method === 'initialize') { opened += 1; return json({ jsonrpc: '2.0', id: 1, result: {} }, { headers: { 'content-type': 'application/json', 'mcp-session-id': `s${opened}` } }) }
    if (body.method === 'tools/call') return json({ jsonrpc: '2.0', id: body.id, result: { content: [], structuredContent: {} } })
    return new Response(null, { status: 202 })
  }
  await callMcpTool({ endpoint: FIRECRAWL_MCP_URL, headers: { Authorization: 'Bearer A' }, tool: 't' })
  await callMcpTool({ endpoint: FIRECRAWL_MCP_URL, headers: { Authorization: 'Bearer B' }, tool: 't' })
  await callMcpTool({ endpoint: FIRECRAWL_MCP_URL, headers: { Authorization: 'Bearer A' }, tool: 't' })
  assert.equal(opened, 2)
  assert.notEqual(credentialFingerprint('Bearer A'), credentialFingerprint('Bearer B'))
})

await check('no source file builds a Firecrawl MCP URL with the key in the path', () => {
  const offenders = []
  for (const name of readdirSync(ROOT).filter((n) => n.endsWith('.js'))) {
    const text = readFileSync(join(ROOT, name), 'utf8')
    if (/mcp\.firecrawl\.dev\/\$\{/.test(text)) offenders.push(name)
  }
  assert.deepEqual(offenders, [])
})

if (process.exitCode) console.error('keys not in URLs: FAILED')
else console.log(`keys not in URLs: ${passed} checks passed`)
