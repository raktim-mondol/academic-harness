/**
 * Per-request time and cancellation for the paid-compute REST clients (review
 * A7, decision D29).
 *
 * Every call gets its own timer, so a provider that stops answering cannot hang
 * the tool. Provisioning calls also take the tool's cancel signal, so the user can
 * stop them. Teardown calls (delete a pod, destroy an instance, remove an SSH
 * key) are made WITHOUT a caller signal: they are what stops the billing, so a
 * cancel must not be able to abort them; they are bounded by their own timer and
 * retried by the caller.
 */

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** A signal that fires on the caller's cancel or after `timeoutMs`, whichever is first. */
export function requestSignal({ signal, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * Turn a fetch/body abort into a plain error: a user cancel is an AbortError
 * (never retried); a timeout is ETIMEDOUT (a connection-level failure the
 * pollers already retry). Anything else is returned unchanged.
 */
export function abortError(error, { label, timeoutMs, signal }) {
  if (signal?.aborted) {
    const cancelled = new Error(`${label} was cancelled`)
    cancelled.name = 'AbortError'
    cancelled.code = 'ABORT_ERR'
    return cancelled
  }
  if (error?.name === 'TimeoutError') {
    const timedOut = new Error(`${label} timed out after ${timeoutMs} ms`)
    timedOut.code = 'ETIMEDOUT'
    return timedOut
  }
  return error
}
