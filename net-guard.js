/**
 * One network guard for every URL the plugin fetches that it did not choose
 * (review A5, decision D32). Dataset links, publisher links, image URLs returned
 * by an API and PDF links from search results all come from outside, and any of
 * them can redirect somewhere the caller never meant.
 *
 *   assertPublicUrl     http(s) only, no credentials, no local or private target
 *   guardedFetch        manual redirects, each hop re-checked, one deadline
 *   streamBody          read a body counting the bytes actually received
 *   guardedDownload     all of the above, returning a Buffer
 *
 * What it guarantees: every address the host name resolves to is public at the
 * moment of the check; a redirect cannot reach a private address or leave
 * http(s); credential-bearing headers are not sent to a different origin after
 * a redirect; one deadline covers the whole exchange including the body (it is
 * never cleared after the headers); and size limits count real bytes, so a
 * missing or false Content-Length does not defeat them.
 *
 * What it does not: it checks the DNS answer, then lets fetch resolve again, so
 * a DNS-rebinding race between the check and the connection is narrowed, not
 * closed. Pinning the connection to the checked address needs a custom dispatcher.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export class NetGuardError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'NetGuardError'
    this.code = code
    Object.assign(this, extra)
  }
}

// ── addresses ───────────────────────────────────────────────────────────────

function privateIpv4(address) {
  const match = String(address || '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!match) return true
  const octets = match.slice(1).map(Number)
  if (octets.some((value) => value > 255)) return true
  const [a, b, c] = octets
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0 && c === 0)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
}

function expandIpv6(address) {
  let value = String(address || '').toLowerCase().split('%')[0]
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':')
    const v4 = value.slice(lastColon + 1).split('.').map(Number)
    if (v4.length !== 4 || v4.some((part) => Number.isNaN(part) || part > 255)) return null
    value = `${value.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }
  const halves = value.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : []
  const tail = halves[1] ? halves[1].split(':').filter(Boolean) : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null
  return [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((part) => Number.parseInt(part, 16))
}

function privateIpv6(address) {
  const p = expandIpv6(address)
  if (!p || p.length !== 8 || p.some((part) => Number.isNaN(part))) return true
  if (p.every((part) => part === 0)) return true                                   // ::
  if (p.slice(0, 7).every((part) => part === 0) && p[7] === 1) return true         // ::1
  if ((p[0] & 0xfe00) === 0xfc00) return true                                       // fc00::/7 unique local
  if ((p[0] & 0xffc0) === 0xfe80) return true                                       // fe80::/10 link local
  if ((p[0] & 0xff00) === 0xff00) return true                                       // multicast
  if (p[0] === 0x2001 && p[1] === 0x0db8) return true                               // documentation
  if (p[0] === 0x2001 && p[1] === 0x0000) return true                               // Teredo tunnelling
  const tail4 = `${p[6] >> 8}.${p[6] & 0xff}.${p[7] >> 8}.${p[7] & 0xff}`
  if (p.slice(0, 5).every((part) => part === 0) && p[5] === 0xffff) return privateIpv4(tail4)                   // ::ffff:a.b.c.d
  if (p[0] === 0x0064 && p[1] === 0xff9b && p.slice(2, 6).every((part) => part === 0)) return privateIpv4(tail4) // NAT64
  if (p.slice(0, 6).every((part) => part === 0)) return privateIpv4(tail4)                                        // ::a.b.c.d
  if (p[0] === 0x2002) return privateIpv4(`${p[1] >> 8}.${p[1] & 0xff}.${p[2] >> 8}.${p[2] & 0xff}`)             // 6to4
  return false
}

/** True for private, loopback, link-local, shared, reserved or unparseable addresses. Anything that is not an IP address counts as private. */
export function isPrivateAddress(address) {
  const text = String(address ?? '')
  const family = isIP(text)
  if (family === 4) return privateIpv4(text)
  if (family === 6) return privateIpv6(text)
  return true
}

export function isBlockedHostname(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  if (isIP(host)) return isPrivateAddress(host)
  return false
}

// ── URLs ────────────────────────────────────────────────────────────────────

/**
 * Throws NetGuardError unless the URL is http(s) to a public host. Returns the parsed URL.
 * `lookup` is injectable for tests; production uses the system resolver.
 */
export async function assertPublicUrl(value, { lookup = dnsLookup, allowCredentials = false } = {}) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new NetGuardError('url', `invalid URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new NetGuardError('scheme', 'only HTTP(S) URLs are allowed')
  if (!allowCredentials && (url.username || url.password)) throw new NetGuardError('credentials', 'URLs with embedded credentials are not allowed')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) throw new NetGuardError('private', 'localhost URLs are not allowed')
  if (host.endsWith('.local') || host.endsWith('.internal')) throw new NetGuardError('private', `local network host names are not allowed: ${host}`)
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new NetGuardError('private', `private/internal address is not allowed: ${host}`)
    return url
  }
  let addresses
  try {
    addresses = await lookup(host, { all: true, verbatim: true })
  } catch (error) {
    throw new NetGuardError('dns', `could not resolve host: ${host} (${error?.code || error?.message || error})`)
  }
  if (!addresses?.length) throw new NetGuardError('dns', `could not resolve host: ${host}`)
  const bad = addresses.find((entry) => isPrivateAddress(entry.address))
  if (bad) throw new NetGuardError('private', `host ${host} resolves to a private/internal address (${bad.address})`)
  return url
}

// ── fetching ────────────────────────────────────────────────────────────────

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const SENSITIVE_HEADER = /^(authorization|cookie|proxy-authorization)$|token|key|secret|auth/i

function stripSensitive(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !SENSITIVE_HEADER.test(name)))
}

function translate(error) {
  if (error instanceof NetGuardError) return error
  if (error?.name === 'TimeoutError') return new NetGuardError('deadline', 'the download deadline passed before it finished')
  if (error?.name === 'AbortError') return new NetGuardError('aborted', 'the request was cancelled')
  return error
}

/**
 * Fetch with the guard applied to the first URL and to every redirect hop.
 * Returns { response, url, hops }; the body is not read. `deadlineMs` is
 * deliberately left armed so it also ends a body that stalls after the headers;
 * `headersMs` only bounds the wait for the headers themselves.
 */
export async function guardedFetch(value, {
  fetch: fetchImpl = globalThis.fetch,
  lookup,
  signal,
  deadlineMs = 60_000,
  headersMs = deadlineMs,
  maxHops = 5,
  headers = {},
  method = 'GET',
  allowCredentials = false,
} = {}) {
  const deadline = AbortSignal.timeout(deadlineMs)
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
  const check = (target) => assertPublicUrl(target, { lookup, allowCredentials })
  let url = await check(value)
  let currentHeaders = { ...headers }
  for (let hops = 0; ; hops += 1) {
    // headersMs bounds the wait for response headers only; it is released once they arrive, while
    // `combined` (the overall deadline and the caller's signal) stays armed through the body.
    const headerGate = new AbortController()
    const headerTimer = setTimeout(() => headerGate.abort(new DOMException('no response headers in time', 'TimeoutError')), headersMs)
    let response
    try {
      response = await fetchImpl(url, { method, headers: currentHeaders, redirect: 'manual', signal: AbortSignal.any([combined, headerGate.signal]) })
    } catch (error) {
      throw translate(error)
    } finally {
      clearTimeout(headerTimer)
    }
    if (!REDIRECT_STATUS.has(response.status)) return { response, url, hops }
    try {
      await response.body?.cancel()
    } catch {
      // already closed
    }
    const location = response.headers.get('location')
    if (!location) throw new NetGuardError('redirects', `redirect without a Location header from ${url.href}`)
    if (hops >= maxHops) throw new NetGuardError('redirects', `too many redirects starting at ${value}`)
    const next = await check(new URL(location, url).href)
    if (next.origin !== url.origin) currentHeaders = stripSensitive(currentHeaders)
    url = next
  }
}

/** A shared byte allowance for several downloads: `{ remaining }`. */
export function createBudget(totalBytes) {
  return { remaining: Number(totalBytes) }
}

function sizeError(limit, total) {
  return new NetGuardError('size', total ? `downloads exceed the total limit of ${limit} bytes` : `download exceeds the limit of ${limit} bytes`)
}

/**
 * Yield a response body's chunks. Stops with a NetGuardError if no chunk arrives
 * for `idleMs` (a stalled server), and cancels the underlying reader when the
 * consumer stops early or an error occurs.
 */
export async function* iterateBody(response, { idleMs } = {}) {
  const reader = response.body?.getReader()
  if (!reader) return
  try {
    for (;;) {
      let timer
      const next = reader.read()
      const result = idleMs
        ? await Promise.race([
          next,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new NetGuardError('deadline', `the download stalled: no data for ${idleMs} ms`)), idleMs) }),
        ]).finally(() => clearTimeout(timer))
        : await next
      if (result.done) return
      yield result.value
    }
  } catch (error) {
    throw translate(error)
  } finally {
    try { await reader.cancel() } catch { /* already closed */ }
  }
}

/**
 * Read a response body, counting bytes as they arrive. `maxBytes` caps this
 * body, `budget` caps the sum across bodies, `idleMs` ends a stalled one, and
 * `onChunk` receives each chunk (so a caller can write to a file instead of
 * holding it all in memory). Returns the number of bytes read.
 */
export async function streamBody(response, { maxBytes = Infinity, budget, onChunk, idleMs } = {}) {
  const declared = Number(response.headers?.get('content-length'))
  if (Number.isFinite(declared)) {
    if (declared > maxBytes) {
      try { await response.body?.cancel() } catch { /* closed */ }
      throw sizeError(maxBytes)
    }
    if (budget && declared > budget.remaining) {
      try { await response.body?.cancel() } catch { /* closed */ }
      throw sizeError(budget.remaining, true)
    }
  }
  let total = 0
  for await (const value of iterateBody(response, { idleMs })) {
    total += value.byteLength
    if (total > maxBytes) throw sizeError(maxBytes)
    if (budget) {
      if (value.byteLength > budget.remaining) throw sizeError(budget.remaining, true)
      budget.remaining -= value.byteLength
    }
    if (onChunk) await onChunk(value)
  }
  return total
}

/** guardedFetch + streamBody into a Buffer. A non-2xx final response is a NetGuardError with `status`. */
export async function guardedDownload(value, { maxBytes, budget, ...fetchOptions } = {}) {
  const { response, url } = await guardedFetch(value, fetchOptions)
  if (!response.ok) {
    try { await response.body?.cancel() } catch { /* closed */ }
    throw new NetGuardError('http', `fetch failed: HTTP ${response.status} for ${url.href}`, { status: response.status })
  }
  const chunks = []
  const bytes = await streamBody(response, { maxBytes, budget, onChunk: (chunk) => chunks.push(Buffer.from(chunk)) })
  return { buffer: Buffer.concat(chunks), url, status: response.status, headers: response.headers, bytes }
}
