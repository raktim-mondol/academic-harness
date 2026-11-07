import assert from 'node:assert/strict'
import { SOURCE_DEADLINES_MS, apply } from '../literature-search.js'
import { resetLimitersForTests } from '../search-http.js'

// A source that never answers must not hold back the others: the search returns at the
// deadline with the healthy sources' papers and reports the stalled one.
const realFetch = globalThis.fetch
for (const key of ['TYPESAFE_API_KEY', 'OPENALEX_API_KEY', 'S2_API_KEY']) delete process.env[key]
resetLimitersForTests()
SOURCE_DEADLINES_MS.default = 300
const tools = []
apply({ tools: { register: (t) => tools.push(t) } })
const tool = tools[0]

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
globalThis.fetch = (url, init) => {
  const u = String(url)
  if (u.includes('arxiv.org')) {
    // hangs until aborted, like a throttled provider
    return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
  }
  if (u.includes('openalex')) return json({ meta: { count: 1 }, results: [{ id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1000/a', title: 'Healthy source paper', publication_year: 2021 }] })
  return json({ data: [], total: 0 })
}
const started = Date.now()
const value = await tool.execute({ query: 'attention', sources: ['openalex', 'arxiv'], rerank: 'off' }, {})
const elapsed = Date.now() - started
assert.ok(elapsed < 3000, `the search must not wait on the stalled source (took ${elapsed} ms)`)
assert.equal(value.papers.length, 1)
assert.equal(value.papers[0].title, 'Healthy source paper')
const stalled = value.failures.find((f) => f.source === 'arxiv')
assert.ok(stalled, 'the stalled source is reported')
assert.equal(stalled.code, 'timeout')
assert.match(stalled.error, /arxiv did not answer within 0 s|arxiv did not answer within/)

// the caller's own cancellation is still reported as cancellation, not as a timeout
const controller = new AbortController()
setTimeout(() => controller.abort(), 50)
const cancelled = await tool.execute({ query: 'attention', sources: ['arxiv'], rerank: 'off' }, { signal: controller.signal })
assert.ok(!cancelled.failures?.some((f) => f.code === 'timeout'), 'user cancellation is not a timeout')

globalThis.fetch = realFetch
console.log('Source deadline OK')
