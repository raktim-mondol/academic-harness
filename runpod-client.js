/**
 * Minimal Runpod REST client for ephemeral pod jobs.
 *
 * Targets REST API v2 (https://api.runpod.io/v2), the replacement for the old
 * v1 API (https://rest.runpod.io/v1). v2 wraps list
 * responses, nests the GPU/CPU request, reports pod lifecycle on
 * `status`, and returns RFC 9457 problem+json errors.
 *
 * Pods are created with an injected PUBLIC_KEY so we can SSH + SCP with a
 * fresh local key pair instead of a pre-registered account key.
 */
import { abortError, DEFAULT_REQUEST_TIMEOUT_MS, requestSignal } from './api-request.js'
import { ephemeralName } from './ssh-client.js'
import { isTransientError } from './search-http.js'

const API_BASE = process.env.RUNPOD_API_BASE_URL ?? process.env.RUNPOD_REST_API_URL ?? 'https://api.runpod.io/v2'

/**
 * One REST call. `opts.signal` is the tool's cancel signal (leave it out for teardown calls);
 * `opts.timeoutMs` bounds the whole exchange including the body.
 */
async function request(apiKey, method, relPath, body, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const label = `Runpod API ${method} ${relPath}`
  let res
  let text
  try {
    res = await fetch(`${API_BASE}${relPath}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: requestSignal({ signal: opts.signal, timeoutMs }),
    })
    text = await res.text()
  } catch (error) {
    throw abortError(error, { label, timeoutMs, signal: opts.signal })
  }
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text }
    }
  }
  if (!res.ok) {
    const problem = data && typeof data === 'object' ? data : {}
    const detail = problem.detail
      ?? problem.error
      ?? problem.message
      ?? (Array.isArray(problem.errors) ? problem.errors.join('; ') : undefined)
      ?? text
      ?? res.statusText
    const title = problem.title ? `${problem.title}: ` : ''
    const error = new Error(`Runpod API ${method} ${relPath} → ${res.status}: ${title}${detail}`)
    error.status = res.status
    throw error
  }
  return data
}

export async function createPod(apiKey, body, opts) {
  return request(apiKey, 'POST', '/pods', body, opts)
}

/** All pods, following the v2 cursor pagination. Used to find an orphan after a failed create. */
export async function listPods(apiKey, opts) {
  const out = []
  let cursor
  for (let page = 0; page < 10; page++) {
    const query = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : '?limit=100'
    const data = await request(apiKey, 'GET', `/pods${query}`, undefined, opts)
    out.push(...(Array.isArray(data?.pods) ? data.pods : []))
    if (!data?.pagination?.hasNextPage || !data.pagination.nextCursor) break
    cursor = data.pagination.nextCursor
  }
  return out
}

export async function getPod(apiKey, podId, opts) {
  return request(apiKey, 'GET', `/pods/${encodeURIComponent(podId)}`, undefined, opts)
}

/** Permanently delete a pod. v2 returns 204 with no body. */
export async function deletePod(apiKey, podId, opts) {
  await request(apiKey, 'DELETE', `/pods/${encodeURIComponent(podId)}`, undefined, opts)
}

/** All network volumes, following the cursor pagination v2 uses on list endpoints. */
export async function listNetworkVolumes(apiKey, opts) {
  const out = []
  let cursor
  for (let page = 0; page < 20; page++) {
    const query = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : '?limit=100'
    const data = await request(apiKey, 'GET', `/network-volumes${query}`, undefined, opts)
    out.push(...(Array.isArray(data?.networkVolumes) ? data.networkVolumes : []))
    if (!data?.pagination?.hasNextPage || !data.pagination.nextCursor) break
    cursor = data.pagination.nextCursor
  }
  return out
}

export async function createNetworkVolume(apiKey, { name, size, dataCenter, type }, opts) {
  return request(apiKey, 'POST', '/network-volumes', {
    name,
    size,
    dataCenter,
    ...(type ? { type } : {}),
  }, opts)
}

/**
 * SSH endpoints from a v2 Pod.
 *
 * `ssh.direct` is the full-featured path (SCP/SFTP) and is only present once
 * 22/tcp has a public mapping, so it is what the run tool waits for. `proxy`
 * needs no public IP but supports an interactive shell only — kept as a
 * fallback for runs that move no files.
 */
export function resolveSshEndpoint(pod) {
  const direct = pod?.ssh?.direct
  if (direct?.host && direct?.port) {
    return { host: direct.host, port: direct.port, username: direct.username ?? 'root', kind: 'direct' }
  }
  const proxy = pod?.ssh?.proxy
  if (proxy?.host && proxy?.port) {
    return { host: proxy.host, port: proxy.port, username: proxy.username ?? 'root', kind: 'proxy' }
  }
  return null
}

const TERMINAL_STATUSES = new Set(['ERROR', 'EXITED', 'TERMINATED'])

/**
 * Poll until the pod is RUNNING and a usable SSH endpoint is resolvable.
 * A transient network blip or a 5xx from the API costs a retry on the next
 * tick, not the whole provisioning run; permanent errors (401/404, terminal
 * pod status) rethrow immediately.
 */
export async function waitForPodSsh(apiKey, podId, opts) {
  const deadline = Date.now() + opts.timeoutMs
  const requireDirect = opts.requireDirect !== false
  let lastStatus = ''
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error('Aborted while waiting for Runpod pod')
    let pod
    try {
      pod = await getPod(apiKey, podId, { signal: opts.signal, timeoutMs: opts.requestTimeoutMs })
    } catch (error) {
      if (!isTransientError(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, 3000))
      continue
    }
    lastStatus = pod?.status ?? ''
    if (TERMINAL_STATUSES.has(lastStatus)) {
      throw new Error(`Pod ${podId} entered terminal status ${lastStatus}`)
    }
    if (lastStatus === 'RUNNING') {
      const ssh = resolveSshEndpoint(pod)
      if (ssh && (!requireDirect || ssh.kind === 'direct')) return { pod, ssh }
    }
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  throw new Error(`Timed out waiting for pod ${podId} SSH (last status: ${lastStatus || 'unknown'})`)
}

/** Unique short pod name for academic-harness ephemeral jobs. */
export function ephemeralPodName() {
  return ephemeralName('dshrc')
}
