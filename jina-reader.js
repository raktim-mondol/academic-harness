/**
 * Jina Reader (https://r.jina.ai) and Jina Search (https://s.jina.ai).
 *
 * URL/PDF -> clean Markdown, or a five-result web search. Keyless Reader runs
 * at 20 RPM; JINA_API_KEY raises it and is optional. A general web tool, not a
 * literature index.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchText, getLimiter, searchUserAgent } from './search-http.js'

const READ = 'https://r.jina.ai/'
const SEARCH = 'https://s.jina.ai/'
const MODES = ['read', 'search']
const RESPOND_WITH = ['markdown', 'html', 'text', 'readerlm-v2', 'jina-ocr-v1']
const RENDER_CAP = 20_000
const MAX_CONTENT = 50_000

export function buildRequest(args, apiKey) {
  const mode = args.mode || (args.url ? 'read' : (args.query ? 'search' : 'read'))
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`)

  let url
  let target
  if (mode === 'read') {
    target = String(args.url || '').trim()
    if (!/^https?:\/\//i.test(target)) throw new Error('url must be an HTTP(S) URL')
    url = `${READ}${target}`
  } else {
    target = String(args.query || '').trim()
    if (!target) throw new Error('query is required for mode=search')
    url = `${SEARCH}?q=${encodeURIComponent(target)}`
  }

  const headers = { 'User-Agent': searchUserAgent() }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (args.respond_with) {
    if (!RESPOND_WITH.includes(args.respond_with)) {
      throw new Error(`respond_with must be one of ${RESPOND_WITH.join(', ')}`)
    }
    headers['X-Respond-With'] = args.respond_with
  }
  if (args.token_budget != null) {
    const budget = Number(args.token_budget)
    if (!Number.isFinite(budget) || budget <= 0) throw new Error('token_budget must be a positive number')
    headers['X-Token-Budget'] = String(Math.floor(budget))
  }
  if (args.with_links) headers['X-With-Links-Summary'] = 'true'
  return { url, headers, mode, target }
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const header = `Jina ${value.mode}: ${value.target} (${value.chars} chars)`
  const content = value.content.length > RENDER_CAP
    ? `${value.content.slice(0, RENDER_CAP).trimEnd()}\n… [truncated]`
    : value.content
  return [{ type: 'text', text: `${header}\n\n${content}` }]
}

export const name = 'academic-harness-jina-reader'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'jina_read',
    description: [
      'Read a URL (including PDFs) as clean Markdown via Jina Reader, or run a five-result Jina web search. Handles JavaScript-heavy pages and OCR-heavy PDFs.',
      'Use read mode after search has produced a URL, especially when built-in web_fetch or Parallel/Firecrawl fail. This is a general web tool, not a literature index. JINA_API_KEY is optional for read (keyless 20 RPM) and required for search (Jina Search has no keyless tier).',
      'mode is inferred from url vs query when omitted. respond_with=markdown (default), html, text, readerlm-v2 (structured), or jina-ocr-v1 (complex layouts/equations; 40x token cost).',
    ].join(' '),
    parameters: {
      mode: { type: 'string', enum: MODES, description: 'read (default) fetches url; search runs a Jina web search.' },
      url: { type: 'string', description: 'HTTP(S) URL to read (required for mode=read).' },
      query: { type: 'string', description: 'Search query (required for mode=search).' },
      respond_with: { type: 'string', enum: RESPOND_WITH, description: 'Output format. Default markdown.' },
      token_budget: { type: 'number', description: 'Maximum tokens of page content to return.' },
      with_links: { type: 'boolean', description: 'Include a links summary at the end of the output.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      const apiKey = await resolveEnv('JINA_API_KEY')
      let request
      try {
        request = buildRequest(args, apiKey)
      } catch (error) {
        return { error: error.message }
      }

      if (request.mode === 'search' && !apiKey) {
        return { error: 'JINA_API_KEY is required for mode=search; Jina Search has no keyless tier.' }
      }

      const limiter = getLimiter(request.mode === 'search' ? 'jina-search' : (apiKey ? 'jina-keyed' : 'jina-keyless'), {
        minIntervalMs: apiKey ? 120 : 3000,
      })
      const result = await limiter.run(() => fetchText(request.url, {
        retries: 0,
        signal: exec.signal,
        headers: request.headers,
      }))
      if (!result.ok) {
        if (result.error === 'aborted') return { error: 'request cancelled' }
        return { error: `Jina API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
      }
      const rawContent = typeof result.data === 'string' ? result.data : ''
      const content = rawContent.length > MAX_CONTENT ? rawContent.slice(0, MAX_CONTENT) : rawContent
      return {
        mode: request.mode,
        target: request.target,
        content,
        chars: rawContent.length,
        truncated: rawContent.length > content.length,
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: args.mode === 'search' ? `Jina search: ${args.query || ''}` : `Jina read: ${args.url || ''}`,
        kind: args.mode === 'search' ? 'search' : 'other',
      }
    },
  }))
}
