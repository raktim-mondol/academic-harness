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

const limiters = new Map()
const warned = new Set()
const TRANSIENT_NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'])
const TRANSIENT_NETWORK_PHRASES = ['socket hang up', 'fetch failed']

export function getLimiter(name, options = {}) {
  if (!limiters.has(name)) limiters.set(name, new RateLimiter(options))
  return limiters.get(name)
}

export function resetLimitersForTests() {
  limiters.clear()
  warned.clear()
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

async function request(url, options, parse) {
  const {
    signal,
    timeoutMs = 15_000,
    retries = 2,
    maxBytes = 20 * 1024 * 1024,
    headers,
    ...init
  } = options
  const urlLabel = safeUrl(url)
  let attempt = 0

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

    if (isTransientStatus(response.status) && attempt < retries) {
      const waitMs = Math.min(retryAfterMs(response.headers.get('retry-after')) ?? backoffMs(attempt), 30_000)
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
