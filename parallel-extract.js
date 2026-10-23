/**
 * Parallel Extract REST API (POST https://api.parallel.ai/v1/extract).
 *
 * Native parity for `mcp__parallel__web_fetch`: give up to 20 URLs and get
 * LLM-ready excerpts, or full content when requested. Use it after search has
 * produced URLs; it is not a search tool. Requires PARALLEL_API_KEY.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'

const API = 'https://api.parallel.ai/v1/extract'
const MAX_URLS = 20
const RENDER_CAP = 6000
const RENDER_TOTAL_CAP = 24_000

function excerptText(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  return value.text || value.excerpt || value.content || ''
}

export function buildBody(args) {
  const urls = (args.urls || []).map((value) => String(value).trim()).filter(Boolean)
  if (!urls.length) throw new Error('urls must contain at least one URL')
  if (urls.length > MAX_URLS) throw new Error(`urls accepts at most ${MAX_URLS} URLs`)
  const invalid = urls.find((url) => !/^https?:\/\//i.test(url))
  if (invalid) throw new Error(`not an HTTP(S) URL: ${invalid}`)

  const body = { urls }
  if (args.objective) body.objective = String(args.objective).trim()
  const queries = (args.search_queries || []).map((value) => String(value).trim()).filter(Boolean)
  if (queries.length) body.search_queries = queries.slice(0, 5)
  if (args.full_content != null) body.advanced_settings = { full_content: Boolean(args.full_content) }
  return body
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object') return null
  const fullContent = result.full_content?.content ?? result.full_content ?? result.content ?? null
  const excerpts = Array.isArray(result.excerpts)
    ? result.excerpts
    : (result.excerpts ? [result.excerpts] : [])
  return {
    url: result.url || null,
    title: result.title || null,
    publish_date: result.publish_date || null,
    excerpts: excerpts.map(excerptText).filter(Boolean),
    full_content: typeof fullContent === 'string' ? fullContent : null,
  }
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (!value.results?.length) return [{ type: 'text', text: 'No content returned.' }]
  const blocks = []
  let budget = RENDER_TOTAL_CAP
  for (const [i, result] of value.results.entries()) {
    const bits = [`${i + 1}. **${result.title || result.url || '(untitled)'}**`]
    if (result.url) bits.push(result.url)
    if (result.publish_date) bits.push(result.publish_date)
    for (const excerpt of result.excerpts) bits.push(excerpt)
    if (result.full_content) {
      bits.push(result.full_content.length > RENDER_CAP
        ? `${result.full_content.slice(0, RENDER_CAP).trimEnd()}\n… [truncated]`
        : result.full_content)
    }
    let block = bits.join('\n')
    if (block.length > budget) {
      block = `${block.slice(0, budget)}\n… [output truncated]`
      blocks.push(block)
      budget = 0
      break
    }
    budget -= block.length
    blocks.push(block)
  }
  return [{ type: 'text', text: blocks.join('\n\n') }]
}

export const name = 'academic-harness-parallel-extract'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'parallel_extract',
    description: [
      'Extract LLM-ready excerpts or full page content from up to 20 URLs via the Parallel Extract API.',
      'Use this after search has produced URLs; it does not discover pages. It is the native counterpart of mcp__parallel__web_fetch and needs PARALLEL_API_KEY.',
      'Pass `objective` and/or `search_queries` to focus excerpts on what you need. Set full_content=true only when the excerpt is insufficient — it is much larger. For JavaScript-heavy pages or PDFs, prefer mcp__firecrawl__firecrawl_scrape or pdf_to_markdown after downloading.',
    ].join(' '),
    parameters: {
      urls: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'HTTP(S) URLs to extract, 1-20.',
      },
      objective: { type: 'string', description: 'One sentence naming what to extract from the pages.' },
      search_queries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional keyword queries to focus excerpts (max 5).',
      },
      full_content: { type: 'boolean', description: 'Return full page content instead of excerpts. Default false.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      let body
      try {
        body = buildBody(args)
      } catch (error) {
        return { error: error.message }
      }
      const apiKey = await resolveEnv('PARALLEL_API_KEY')
      if (!apiKey) {
        return { error: 'PARALLEL_API_KEY is not set (Settings -> Academic Harness API keys, or the matching env var).' }
      }

      const limiter = getLimiter('parallel', { minIntervalMs: 100 })
      const result = await limiter.run(() => fetchJson(API, {
        method: 'POST',
        retries: 0,
        signal: exec.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'User-Agent': searchUserAgent(),
        },
        body: JSON.stringify(body),
      }))
      if (!result.ok) {
        const detail = result.data?.error?.message ?? result.data?.detail ?? result.detail ?? result.error
        return { error: `Parallel Extract API error ${result.status}`, status: result.status, detail }
      }
      const data = result.data && typeof result.data === 'object' ? result.data : {}
      const rawResults = Array.isArray(data.results)
        ? data.results
        : (Array.isArray(data.extract?.results) ? data.extract.results : [])
      return {
        extract_id: data.extract_id || data.extract?.extract_id || null,
        results: rawResults.map(normalizeResult).filter(Boolean),
      }
    },
    presentCall(args) {
      const first = Array.isArray(args.urls) ? args.urls[0] : ''
      const extra = Array.isArray(args.urls) && args.urls.length > 1 ? ` (+${args.urls.length - 1})` : ''
      return { card: 'generic', title: `Parallel extract: ${first}${extra}`, kind: 'other' }
    },
  }))
}
