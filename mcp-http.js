/**
 * Minimal MCP client over Streamable HTTP, for calling a remote MCP tool from plugin
 * code (the agent-facing `mcp__*` mounts cannot be called from another tool).
 *
 * Used by firecrawl-papers.js and scite-search.js. It does exactly: initialize,
 * notifications/initialized, tools/call. The session id is cached per endpoint and
 * credential and re-created once if the server forgets it.
 *
 * Endpoints can carry a secret (Firecrawl puts the key in the URL path), so no error
 * or log line from here ever includes the URL, the headers, or a response body.
 */

const sessions = new Map()
const PROTOCOL_VERSION = '2025-03-26'

export function resetMcpHttpForTests() {
  sessions.clear()
}

function parseBody(contentType, text, id) {
  const raw = String(text || '')
  if (/text\/event-stream/i.test(contentType)) {
    let found = null
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      try {
        const message = JSON.parse(line.slice(5).trim())
        if (message && (message.id === id || message.result || message.error)) found = message
      } catch { /* ignore a non-JSON data line */ }
    }
    return found
  }
  try { return JSON.parse(raw) } catch { return null }
}

async function post(endpoint, headers, session, body, { signal, timeoutMs }) {
  const guard = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, guard]) : guard
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify(body),
    signal: combined,
  })
  const text = await response.text()
  return {
    status: response.status,
    sessionId: response.headers.get('mcp-session-id'),
    json: parseBody(response.headers.get('content-type') || '', text, body.id),
  }
}

async function openSession(endpoint, headers, opts) {
  const init = await post(endpoint, headers, null, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'academic-harness', version: '1' } },
  }, opts)
  if (init.status === 401 || init.status === 403) return { error: 'auth_failed', status: init.status }
  if (init.status < 200 || init.status >= 300 || !init.json?.result) return { error: 'init_failed', status: init.status }
  const sessionId = init.sessionId || null
  await post(endpoint, headers, sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' }, opts).catch(() => {})
  return { sessionId }
}

/**
 * Call one tool. Resolves to `{ ok: true, structured, text }` or
 * `{ ok: false, error, status? }`; never throws.
 */
export async function callMcpTool({ endpoint, headers = {}, tool, args = {}, signal, timeoutMs = 30_000 }) {
  const cacheKey = `${endpoint}|${headers.authorization || headers.Authorization || ''}`
  const opts = { signal, timeoutMs }
  let id = 100
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      let entry = sessions.get(cacheKey)
      if (!entry) {
        entry = await openSession(endpoint, headers, opts)
        if (entry.error) return { ok: false, error: entry.error, status: entry.status }
        sessions.set(cacheKey, entry)
      }
      id += 1
      const reply = await post(endpoint, headers, entry.sessionId, {
        jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args },
      }, opts)
      if ((reply.status === 400 || reply.status === 404) && attempt === 0) {
        sessions.delete(cacheKey) // the server forgot our session: start a fresh one once
        continue
      }
      if (reply.status === 401 || reply.status === 403) return { ok: false, error: 'auth_failed', status: reply.status }
      if (reply.status === 429) return { ok: false, error: 'rate_limited', status: 429 }
      if (reply.status < 200 || reply.status >= 300) return { ok: false, error: `http_${reply.status}`, status: reply.status }
      if (reply.json?.error) return { ok: false, error: String(reply.json.error.message || 'tool error').slice(0, 200) }
      const result = reply.json?.result
      if (!result) return { ok: false, error: 'malformed_response' }
      const text = Array.isArray(result.content) ? result.content.map((part) => part?.text || '').join('') : ''
      if (result.isError) return { ok: false, error: text.slice(0, 200) || 'tool error' }
      return { ok: true, structured: result.structuredContent ?? null, text }
    } catch (error) {
      sessions.delete(cacheKey)
      const message = error instanceof Error ? error.message : String(error)
      if (/aborted|timeout|timed out/i.test(message)) return { ok: false, error: 'timeout' }
      return { ok: false, error: 'network_error' }
    }
  }
  return { ok: false, error: 'session_failed' }
}
