/**
 * Where each provider's API key travels (review A9, decision D34).
 *
 * A key in a URL path or query string is kept by proxies, server access logs and
 * error messages. These providers document a header for the same key (read from
 * their documentation), so the key goes there:
 *
 *   OpenAlex   Authorization: Bearer <key>          docs: "Both work identically."
 *   openFDA    Authorization: Basic base64(key:)    docs: the key as the basic-auth username
 *   Firecrawl  Authorization: Bearer <key>          to https://mcp.firecrawl.dev/v2/mcp
 *
 * Providers with no documented header (NCBI PubMed, Springer Nature) keep the
 * key in the query string; `search-http.js` redacts query strings from its logs.
 *
 * Call sites still build `api_key=` into OpenAlex and openFDA URLs; `fetchJson`
 * and `fetchText` call `relocateCredential` just before the request leaves, so
 * the key is in the URL only inside this process.
 */
import { createHash } from 'node:crypto'

export const FIRECRAWL_MCP_URL = 'https://mcp.firecrawl.dev/v2/mcp'

/** { endpoint, headers } for the hosted Firecrawl MCP server. */
export function firecrawlMcp(key) {
  return { endpoint: FIRECRAWL_MCP_URL, headers: { Authorization: `Bearer ${key}` } }
}

const AS_HEADER = {
  'api.openalex.org': (key) => `Bearer ${key}`,
  'api.fda.gov': (key) => `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
}

function hasAuthorization(headers) {
  if (!headers) return false
  if (typeof headers.has === 'function') return headers.has('authorization')
  return Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')
}

/**
 * For a host whose docs accept the key in a header, take `api_key` out of the
 * URL and put it in `Authorization`. Everything else in the URL is left byte for
 * byte as it was. A header the caller already set wins. Other hosts pass through.
 */
export function relocateCredential(url, headers) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { url, headers }
  }
  const build = AS_HEADER[parsed.hostname]
  const key = build ? parsed.searchParams.get('api_key') : null
  if (!key) return { url, headers }
  const stripped = String(url).replace(/([?&])api_key=[^&#]*&?/, '$1').replace(/[?&]$/, '')
  if (hasAuthorization(headers)) return { url: stripped, headers }
  const authorization = build(key)
  if (headers && typeof headers.set === 'function') {
    const copy = new Headers(headers)
    copy.set('Authorization', authorization)
    return { url: stripped, headers: copy }
  }
  return { url: stripped, headers: { ...(headers ?? {}), Authorization: authorization } }
}

/** Short stable digest of a credential, for keys of in-memory maps (never the secret itself). */
export function credentialFingerprint(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16)
}
