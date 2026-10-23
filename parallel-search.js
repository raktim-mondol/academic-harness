/**
 * Parallel Search REST API (POST https://api.parallel.ai/v1/search) —
 * `x-api-key` auth. This is the primary Parallel search tool: the agent
 * picks turbo/fast/basic/advanced per call. The MCP `web_search` tool in
 * mcp-connectors.js is the same search job locked to `basic` mode and is
 * only a fallback if this tool is missing or fails. Resolves
 * PARALLEL_API_KEY via resolveEnv() per call, so a key saved in Settings
 * takes effect on the next call — no restart needed.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'

const API_URL = 'https://api.parallel.ai/v1/search'
const MODES = ['turbo', 'fast', 'basic', 'advanced']

function renderResult(r) {
  const bits = [`**${r.title || r.url}**`]
  if (r.publish_date) bits.push(r.publish_date)
  if (r.url) bits.push(r.url)
  if (Array.isArray(r.excerpts) && r.excerpts.length) {
    bits.push(r.excerpts.filter(Boolean).join('\n\n'))
  }
  return bits.join('\n')
}

function render(value) {
  if (value.error) {
    return [{ type: 'text', text: `Error: ${value.error}` }]
  }
  if (!Array.isArray(value.results) || value.results.length === 0) {
    return [{ type: 'text', text: 'No results.' }]
  }
  const lines = value.results.map((r, i) => `${i + 1}. ${renderResult(r)}`)
  if (value.mode) lines.unshift(`_mode: ${value.mode}_`)
  return [{ type: 'text', text: lines.join('\n\n') }]
}

export const name = 'academic-harness-parallel-search'
export const inject = ['tools']

/** Register the Parallel web-search tool with per-call mode selection. */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'parallel_search',
    description: [
      'Primary Parallel web search: ranked URLs with LLM-oriented excerpts. Prefer this over mcp__parallel__web_search,',
      'which is the same search job locked to basic mode — only fall back to that MCP tool if this one is missing or errors.',
      'Requires PARALLEL_API_KEY (Settings -> Academic Harness API keys, or env).',
      'Always pass `mode` — pick it for the task, do not default blindly:',
      '`turbo` (~250ms) simple fact lookups / current numbers (English and Japanese queries only);',
      '`fast` (~700ms) ordinary non-literature lookups;',
      '`basic` (~1s) longer excerpts per source, best with 2-3 keyword queries;',
      '`advanced` (~3s) multi-hop retrieval for literature surveys and deep research.',
      'Pass `objective` (one standalone sentence naming the entity/topic) plus 1-5 keyword',
      '`search_queries` of 3-6 words each — not sentences, not site: operators; 2-3 queries is best.',
      'For peer-reviewed literature, use this with mode basic or advanced alongside consensus_search — not turbo/fast,',
      'and not instead of consensus_search. Prefer both over built-in web_search for finding papers.',
    ].join(' '),
    parameters: {
      objective: {
        type: 'string',
        required: true,
        description: 'Natural-language search goal in one standalone sentence. Name the key entity or topic. Include freshness or source preferences here rather than as operators.',
      },
      search_queries: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '1-5 keyword queries, 3-6 words each (2-3 is best). Include the key entity in every query. Vary names, synonyms, or angles. Not sentences, instructions, or site: operators.',
      },
      mode: {
        type: 'string',
        enum: MODES,
        required: true,
        description: 'Required. turbo (simple EN/JA lookups), fast (non-literature), basic (longer excerpts / focused literature), advanced (multi-hop literature / deep research).',
      },
      max_chars_total: {
        type: 'number',
        description: 'Optional upper bound on total excerpt characters across all results.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      const key = await resolveEnv('PARALLEL_API_KEY')
      if (!key) {
        return {
          error: 'PARALLEL_API_KEY is not set (Settings -> Academic Harness API keys, or the matching env var). mcp__parallel__* is also disabled without this key.',
        }
      }
      const queries = (args.search_queries || []).map((q) => String(q).trim()).filter(Boolean)
      if (!queries.length) {
        return { error: 'search_queries must contain at least one non-empty query.' }
      }
      const mode = String(args.mode || '').trim()
      if (!MODES.includes(mode)) {
        return { error: `mode must be one of ${MODES.join(', ')}.` }
      }
      const body = {
        objective: String(args.objective || '').trim(),
        search_queries: queries.slice(0, 5),
        mode,
      }
      if (!body.objective) {
        return { error: 'objective is required.' }
      }
      if (args.max_chars_total != null) {
        const maxChars = Number(args.max_chars_total)
        if (Number.isFinite(maxChars) && maxChars > 0) body.max_chars_total = maxChars
      }

      const limiter = getLimiter('parallel', { minIntervalMs: 100 })
      const result = await limiter.run(() => fetchJson(API_URL, {
        method: 'POST',
        retries: 0,
        signal: exec.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'User-Agent': searchUserAgent(),
        },
        body: JSON.stringify(body),
      }))
      if (!result.ok) {
        const message = result.data?.error?.message ?? result.data?.detail ?? result.data?.message ?? result.detail ?? result.error
        return { error: `Parallel Search API error ${result.status}`, status: result.status, detail: message }
      }
      const data = result.data && typeof result.data === 'object' && !Array.isArray(result.data)
        ? result.data
        : {}
      return { ...data, mode }
    },
    presentCall(args) {
      const q = Array.isArray(args.search_queries) ? args.search_queries.filter(Boolean)[0] : ''
      return { card: 'generic', title: `Parallel (${args.mode ?? 'search'}): ${q || args.objective || ''}`, kind: 'search' }
    },
  }))
}
