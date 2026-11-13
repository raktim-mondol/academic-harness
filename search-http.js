/**
 * Shared client for academic-search providers: per-provider pacing plus a
 * JSON/text fetch with timeout, cancellation, and retry.
 *
 * Limits live in code because they are part of each provider's contract:
 * arXiv allows one request every three seconds, Semantic Scholar's intro key
 * gets 1 RPS, NCBI allows 3 RPS keyless, and Crossref's polite pool gets 3 RPS
 * on list queries. Tools call `getLimiter(name, opts).run(fn)` around every
 * request; a single limiter instance is shared for the process lifetime.
 */

import { relocateCredential } from './provider-auth.js'
import { createHash } from 'node:crypto'

const limiters = new Map()
const warned = new Set()
// A provider that said "come back in N seconds" with N longer than we are willing to wait
// (a daily quota, typically) is not asked again until then. Retrying inside the wait cap
// cannot succeed, and every later search would repeat the same doomed call.
const cooldowns = new Map()
const MAX_RETRY_WAIT_MS = 30_000
const MAX_COOLDOWN_MS = 24 * 60 * 60_000
const TRANSIENT_NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'])
const TRANSIENT_NETWORK_PHRASES = ['socket hang up', 'fetch failed', ...[...TRANSIENT_NETWORK_CODES].map((code) => code.toLowerCase())]

export function getLimiter(name, options = {}) {
  if (!limiters.has(name)) limiters.set(name, new RateLimiter(options))
  return limiters.get(name)
}

export function resetLimitersForTests() {
  limiters.clear()
  warned.clear()
  cooldowns.clear()
  streaks.clear()
}

/**
 * Cooldown identity: the provider origin plus the credential on the request, so entering
 * a key in Settings is not blocked by the keyless quota running out. Hashed so no secret
 * is held as a map key.
 */
function cooldownKey(url, headers) {
  let origin = ''
  let credential = ''
  try {
    const parsed = new URL(url)
    origin = parsed.origin
    credential = parsed.searchParams.get('api_key') || parsed.searchParams.get('apiKey') || ''
  } catch {
    return null
  }
  const header = (name) => {
    if (!headers) return ''
    if (typeof headers.get === 'function') return headers.get(name) || ''
    const hit = Object.entries(headers).find(([key]) => key.toLowerCase() === name)
    return hit ? String(hit[1]) : ''
  }
  credential ||= header('authorization') || header('x-api-key')
  return `${origin}|${createHash('sha1').update(credential).digest('hex').slice(0, 12)}`
}

/** Failure fields for an adapter whose provider is in cooldown, or null. */
export function cooldownFailure(label, result) {
  if (!result?.cooldown) return null
  const seconds = Math.round(result.retryAfterMs / 1000)
  return { error: `${label} is rate limiting or unavailable; not called again for ${seconds >= 3600 ? `${(seconds / 3600).toFixed(1)} h` : `${seconds} s`}`, status: result.status, code: 'rate_limited', retry_after_s: seconds }
}

/** Milliseconds until a provider may be called again, or 0. */
export function cooldownRemainingMs(url, headers) {
  const key = cooldownKey(url, headers)
  const until = key ? cooldowns.get(key) : null
  if (!until) return 0
  const left = until - Date.now()
  if (left <= 0) {
    cooldowns.delete(key)
    return 0
  }
  return left
}

export class RateLimiter {
  constructor({ minIntervalMs = 0, maxConcurrent = 1 } = {}) {
    this.minIntervalMs = Math.max(0, minIntervalMs)
    this.maxConcurrent = Math.max(1, maxConcurrent)
    this.active = 0
    this.lastStart = 0
    this.queue = []
    this.timer = null
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject })
      this.#drain()
    })
  }

  #drain() {
    while (this.active < this.maxConcurrent && this.queue.length) {
      const wait = Math.max(0, this.lastStart + this.minIntervalMs - Date.now())
      if (wait > 0) {
        if (!this.timer) {
          this.timer = setTimeout(() => {
            this.timer = null
            this.#drain()
          }, wait)
        }
        return
      }
      const task = this.queue.shift()
      this.active += 1
      this.lastStart = Date.now()
      let released = false
      const release = () => {
        if (released) return
        released = true
        this.active -= 1
        this.#drain()
      }
      Promise.resolve()
        .then(task.fn)
        .then(task.resolve, task.reject)
        .finally(release)
    }
  }
}

export function retryAfterMs(header) {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return null
}

/**
 * True when a thrown error is a connection-level failure worth retrying:
 * a DNS/socket code anywhere in the `cause` chain (undici wraps the real
 * failure in `TypeError: fetch failed`), or one of the known socket phrases.
 */
export function isTransientNetworkError(error) {
  for (let node = error; node && typeof node === 'object'; node = node.cause) {
    if (typeof node.code === 'string' && TRANSIENT_NETWORK_CODES.has(node.code)) return true
    const message = typeof node.message === 'string' ? node.message.toLowerCase() : ''
    if (message && TRANSIENT_NETWORK_PHRASES.some((phrase) => message.includes(phrase))) return true
    if (node.cause === node) break
  }
  return false
}

/** True for HTTP statuses that mean "the server could not answer right now", not "your request is wrong". 501 is permanent. */
export function isTransientStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status !== 501)
}

/** True when an error is worth retrying as-is: a transient connection failure, or an HTTP error carrying a transient status on `error.status`. */
export function isTransientError(error) {
  return isTransientNetworkError(error) || (Number.isInteger(error?.status) && isTransientStatus(error.status))
}

/** True for HTTP 401/403 — the caller's credential is wrong and retrying the same call cannot help. */
export function isAuthStatus(status) {
  return status === 401 || status === 403
}

/** Run `fn`, retrying only transient failures with exponential backoff. Permanent errors and aborts rethrow immediately. `classify` can widen "transient" for non-HTTP clients. */
export async function withTransientRetry(fn, { tries = 3, baseDelayMs = 1000, maxDelayMs = 15_000, signal, classify = isTransientError } = {}) {
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (error) {
      if (signal?.aborted || attempt >= tries || !classify(error)) throw error
      await sleep(Math.min(baseDelayMs * 2 ** attempt, maxDelayMs), signal)
      attempt += 1
    }
  }
}

/** Run `fn` up to `tries` times with linear backoff, never throwing; resolves to null on success or the last error. */
export async function retryQuietly(fn, { tries = 3, baseDelayMs = 1500 } = {}) {
  let lastError = null
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      await fn()
      return null
    } catch (error) {
      lastError = error
      if (attempt < tries - 1) await sleep(baseDelayMs * (attempt + 1))
    }
  }
  return lastError
}

const RETRY_DELAYS_MS = [500, 1500]

function backoffMs(attempt) {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    if (signal) signal.addEventListener('abort', done, { once: true })
  })
}

function detailFrom(data) {
  if (typeof data === 'string') return data.slice(0, 500) || undefined
  const topLevel = typeof data?.error === 'string'
    ? data.error
    : (data?.error?.message ?? data?.error?.detail ?? data?.error?.code)
  if (typeof topLevel === 'string') return topLevel
  const nested = data?.detail
  if (typeof nested === 'string') return nested
  if (nested && typeof nested === 'object') {
    const inner = nested.error ?? nested.message ?? nested.detail
    return typeof inner === 'string' ? inner : JSON.stringify(nested).slice(0, 500)
  }
  return typeof data?.message === 'string' ? data.message : undefined
}

function warnOnce(key, message) {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(message)
}

function safeUrl(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return 'provider request'
  }
}

// Two requests in a row that fail with a transient error (after their retries) open a short
// cooldown for that provider: a source that is down or throttling this address would otherwise
// cost the full timeout and retries on every search. One success closes it. Occasional single
// failures (a burst over a 1 RPS limit) never trip it.
const streaks = new Map()
const STREAK_LIMIT = 2
const STREAK_COOLDOWN_MS = 120_000

function transientFailure(result) {
  if (result.ok || result.cooldown || result.error === 'aborted') return false
  return result.status === 0 || isTransientStatus(result.status)
}

async function request(url, options, parse) {
  const result = await attemptRequest(url, options, parse)
  const key = cooldownKey(url, options.headers)
  if (!key) return result
  if (result.ok) {
    streaks.delete(key)
  } else if (transientFailure(result)) {
    // A 429 means "slow down" and heals once calls are spaced (a key's 1 request per second), so
    // it counts for half; timeouts, network errors and 5xx mean the provider is not answering.
    const streak = (streaks.get(key) || 0) + (result.status === 429 ? 0.5 : 1)
    streaks.set(key, streak)
    if (streak >= STREAK_LIMIT && !cooldowns.has(key)) {
      cooldowns.set(key, Date.now() + STREAK_COOLDOWN_MS)
      warnOnce(`streak:${key}`, `[academic-harness] search provider ${safeUrl(url)} failed ${streak} times in a row; skipping it for ${STREAK_COOLDOWN_MS / 1000}s`)
    }
  }
  return result
}

async function attemptRequest(url, options, parse) {
  const {
    signal,
    timeoutMs = 15_000,
    retries = 2,
    minRetryDelayMs = 0,
    maxBytes = 20 * 1024 * 1024,
    headers: callerHeaders,
    ...init
  } = options
  // OpenAlex and openFDA document a header for the key: move it out of the URL before anything is sent or logged (provider-auth.js).
  const relocated = relocateCredential(url, callerHeaders)
  url = relocated.url
  const headers = relocated.headers
  const urlLabel = safeUrl(url)
  let attempt = 0

  const waiting = cooldownRemainingMs(url, headers)
  if (waiting > 0) {
    return { ok: false, status: 429, error: 'HTTP 429', detail: 'rate limit in effect; not retried', cooldown: true, retryAfterMs: waiting }
  }

  for (;;) {
    if (signal?.aborted) return { ok: false, status: 0, error: 'aborted' }

    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('request timed out')), timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    let response
    try {
      response = await fetch(url, { ...init, headers, signal: controller.signal })
    } catch (error) {
      cleanup()
      if (signal?.aborted) return { ok: false, status: 0, error: 'aborted' }
      // Retry our own timeout abort and connection-level failures; anything else (a malformed
      // URL, a programming error) is permanent and must fail fast, not burn the retry budget.
      const timedOut = error instanceof Error && error.name === 'AbortError'
      if (!timedOut && !isTransientNetworkError(error)) {
        return { ok: false, status: 0, error: `network error: ${error.message}`, detail: String(error) }
      }
      if (attempt >= retries) {
        return { ok: false, status: 0, error: `network error: ${error.message}`, detail: String(error) }
      }
      await sleep(backoffMs(attempt), signal)
      attempt += 1
      continue
    }

    let data
    let parseError = null
    try {
      data = await parse(response, maxBytes)
    } catch (error) {
      parseError = error
    }
    const aborted = controller.signal.aborted
    cleanup()

    if (aborted) {
      if (signal?.aborted) return { ok: false, status: 0, error: 'aborted' }
      if (attempt >= retries) return { ok: false, status: 0, error: 'request timed out' }
      await sleep(backoffMs(attempt), signal)
      attempt += 1
      continue
    }

    if (parseError) {
      const message = parseError instanceof Error ? parseError.message : String(parseError)
      if (message.startsWith('response exceeds')) {
        return { ok: false, status: response.status, error: message }
      }
      if (attempt >= retries) {
        return { ok: false, status: response.status, error: `response parse error: ${message}` }
      }
      await sleep(backoffMs(attempt), signal)
      attempt += 1
      continue
    }

    if (response.ok) {
      return { ok: true, status: response.status, data, headers: response.headers }
    }

    const asked = isTransientStatus(response.status) ? retryAfterMs(response.headers.get('retry-after')) : null
    if (asked != null && asked > MAX_RETRY_WAIT_MS) {
      // The provider wants longer than we would wait: retrying is a guaranteed second failure.
      const key = cooldownKey(url, headers)
      if (key) cooldowns.set(key, Date.now() + Math.min(asked, MAX_COOLDOWN_MS))
      warnOnce(`cooldown:${urlLabel}`, `[academic-harness] search provider ${urlLabel} asked to wait ${Math.round(asked / 1000)}s; skipping it until then`)
      return {
        ok: false,
        status: response.status,
        data,
        headers: response.headers,
        error: `HTTP ${response.status}`,
        detail: detailFrom(data),
        cooldown: true,
        retryAfterMs: asked,
      }
    }

    if (isTransientStatus(response.status) && attempt < retries) {
      const waitMs = Math.min(asked ?? Math.max(backoffMs(attempt), minRetryDelayMs), MAX_RETRY_WAIT_MS)
      warnOnce(`retry:${urlLabel}`, `[academic-harness] search provider ${urlLabel} returned HTTP ${response.status}; retrying in ${waitMs}ms`)
      await sleep(waitMs, signal)
      attempt += 1
      continue
    }

    return {
      ok: false,
      status: response.status,
      data,
      headers: response.headers,
      error: `HTTP ${response.status}`,
      detail: detailFrom(data),
    }
  }
}

async function readBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await response.body?.cancel()
    } catch {
      // body may already be closed
    }
    throw new Error(`response exceeds ${maxBytes} bytes`)
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      try {
        await reader.cancel()
      } catch {
        // body may already be closed
      }
      throw new Error(`response exceeds ${maxBytes} bytes`)
    }
    chunks.push(decoder.decode(value, { stream: true }))
  }
  chunks.push(decoder.decode())
  return chunks.join('')
}

export function fetchJson(url, options = {}) {
  return request(url, options, async (response, maxBytes) => {
    const text = await readBody(response, maxBytes)
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return response.ok ? null : text.slice(0, 500)
    }
  })
}

export function fetchText(url, options = {}) {
  return request(url, options, async (response, maxBytes) => readBody(response, maxBytes))
}

export function searchUserAgent(email) {
  return `Academic Harness/1.0 (academic search${email ? `; mailto:${email}` : ''})`
}
