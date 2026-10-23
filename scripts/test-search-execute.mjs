import assert from 'node:assert/strict'

process.env.BRAVE_API_KEY = 'test-brave'
process.env.PARALLEL_API_KEY = 'test-parallel'
process.env.TAVILY_API_KEY = 'test-tavily'
process.env.EXA_API_KEY = 'test-exa'
process.env.PERPLEXITY_API_KEY = 'test-perplexity'
delete process.env.JINA_API_KEY

const originalFetch = globalThis.fetch
const calls = []

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function loadTool(name) {
  const tools = []
  const module = await import(new URL(`../${name}`, import.meta.url))
  module.apply({ tools: { register: (tool) => tools.push(tool) } })
  return tools[0]
}

const brave = await loadTool('brave-search.js')
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  return jsonResponse({
    web: {
      results: [{
        title: 'Brave Title',
        url: 'https://www.example.org/a',
        description: 'Brave description',
        profile: { long_name: 'Example' },
        extra_snippets: ['extra snippet'],
      }],
    },
  })
}
const braveValue = await brave.execute({ query: 'test', count: 1, extra_snippets: true }, {})
assert.equal(calls.length, 1)
assert.match(calls[0].url, /api\.search\.brave\.com/)
assert.equal(calls[0].init.headers['X-Subscription-Token'], 'test-brave')
assert.equal(braveValue.results[0].title, 'Brave Title')
assert.match(brave.output.render({ query: 'test' }, braveValue)[0].text, /Brave description/)

const search = await loadTool('parallel-search.js')
calls.length = 0
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  return jsonResponse({ results: [{ url: 'https://example.org', title: 'Result', excerpts: ['x'] }] })
}
const searchValue = await search.execute({ objective: 'find x', search_queries: ['x'], mode: 'fast' }, {})
assert.equal(searchValue.mode, 'fast')
assert.equal(calls[0].init.headers['x-api-key'], 'test-parallel')
assert.match(calls[0].url, /api\.parallel\.ai\/v1\/search/)

const extract = await loadTool('parallel-extract.js')
calls.length = 0
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  return jsonResponse({
    results: [{ url: 'https://example.org', title: 'Page', excerpts: ['excerpt'], full_content: 'full body' }],
  })
}
const extractValue = await extract.execute({ urls: ['https://example.org'], full_content: true }, {})
assert.equal(extractValue.results[0].full_content, 'full body')
assert.equal(calls[0].init.headers['x-api-key'], 'test-parallel')
const extractText = extract.output.render({}, extractValue)[0].text
assert.match(extractText, /Page/)
assert.match(extractText, /full body/)

const tavily = await loadTool('tavily-search.js')
calls.length = 0
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  return jsonResponse({
    answer: 'Because.',
    results: [{
      title: 'Tavily Title',
      url: 'https://www.example.org/t',
      content: 'Tavily content',
      published_date: '2024-01-02',
    }],
  })
}
const tavilyValue = await tavily.execute({ query: 'test', search_depth: 'basic' }, {})
assert.equal(calls[0].init.headers.Authorization, 'Bearer test-tavily')
assert.equal(JSON.parse(calls[0].init.body).search_depth, 'basic')
assert.equal(tavilyValue.results[0].title, 'Tavily Title')
assert.match(tavily.output.render({ query: 'test' }, tavilyValue)[0].text, /Because\./)

const exa = await loadTool('exa-search.js')
calls.length = 0
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  return jsonResponse({
    requestId: 'exa-request',
    costDollars: { total: 0.005 },
    results: [{
      id: 'exa-1',
      title: 'Exa Title',
      url: 'https://example.org/e',
      summary: 'Exa summary',
      author: 'Ada Lovelace',
      publishedDate: '2023-05-06',
      highlights: ['highlight'],
    }],
  })
}
const exaValue = await exa.execute({ query: 'test', type: 'auto', include_summary: true }, {})
assert.equal(calls[0].init.headers['x-api-key'], 'test-exa')
assert.equal(JSON.parse(calls[0].init.body).contents.summary, true)
assert.equal(exaValue.results[0].abstract, 'Exa summary')

const perplexity = await loadTool('perplexity-search.js')
calls.length = 0
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  return jsonResponse({
    id: 'pplx-request',
    results: [{ title: 'Perplexity Title', url: 'https://example.org/p', snippet: 'Perplexity snippet', date: '2024-02-03' }],
  })
}
const perplexityValue = await perplexity.execute({ query: 'test', search_type: 'fast' }, {})
assert.equal(calls[0].init.headers.Authorization, 'Bearer test-perplexity')
assert.equal(JSON.parse(calls[0].init.body).search_type, 'fast')
assert.equal(perplexityValue.results[0].title, 'Perplexity Title')

const jina = await loadTool('jina-reader.js')
calls.length = 0
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  return new Response('# Markdown body', { status: 200, headers: { 'content-type': 'text/plain' } })
}
const jinaValue = await jina.execute({ url: 'https://example.org/a' }, {})
assert.equal(calls[0].url, 'https://r.jina.ai/https://example.org/a')
assert.equal(calls[0].init.headers.Authorization, undefined)
assert.equal(jinaValue.content, '# Markdown body')
const jinaSearchError = await jina.execute({ mode: 'search', query: 'test' }, {})
assert.match(jinaSearchError.error, /JINA_API_KEY is required/)

delete process.env.BRAVE_API_KEY
assert.match((await brave.execute({ query: 'x' }, {})).error, /BRAVE_API_KEY is not set/)
delete process.env.TAVILY_API_KEY
assert.match((await tavily.execute({ query: 'x' }, {})).error, /TAVILY_API_KEY is not set/)
delete process.env.EXA_API_KEY
assert.match((await exa.execute({ query: 'x' }, {})).error, /EXA_API_KEY is not set/)
delete process.env.PERPLEXITY_API_KEY
assert.match((await perplexity.execute({ query: 'x' }, {})).error, /PERPLEXITY_API_KEY is not set/)
delete process.env.PARALLEL_API_KEY
assert.match((await extract.execute({ urls: ['https://example.org'] }, {})).error, /PARALLEL_API_KEY is not set/)
assert.match((await search.execute({ objective: 'x', search_queries: ['x'], mode: 'fast' }, {})).error, /PARALLEL_API_KEY is not set/)

globalThis.fetch = originalFetch
console.log('Search tool execution OK')
