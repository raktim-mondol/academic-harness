/**
 * Minimal Runpod REST client for ephemeral pod jobs.
 *
 * Targets REST API v2 (https://api.runpod.io/v2) — v1
 * (https://rest.runpod.io/v1) retires on 2026-11-15. v2 wraps list
 * responses, nests the GPU/CPU request, reports pod lifecycle on
 * `status`, and returns RFC 9457 problem+json errors.
 *
 * Pods are created with an injected PUBLIC_KEY so we can SSH + SCP with a
 * fresh local key pair instead of a pre-registered account key.
 */
import { ephemeralName } from './ssh-client.js'

const API_BASE = process.env.RUNPOD_API_BASE_URL ?? process.env.RUNPOD_REST_API_URL ?? 'https://api.runpod.io/v2'

async function request(apiKey, method, relPath, body) {
  const res = await fetch(`${API_BASE}${relPath}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
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
    throw new Error(`Runpod API ${method} ${relPath} → ${res.status}: ${title}${detail}`)
  }
  return data
}

export async function createPod(apiKey, body) {
  return request(apiKey, 'POST', '/pods', body)
}

/** All pods, following the v2 cursor pagination. Used to find an orphan after a failed create. */
export async function listPods(apiKey) {
  const out = []
  let cursor
  for (let page = 0; page < 10; page++) {
    const query = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : '?limit=100'
    const data = await request(apiKey, 'GET', `/pods${query}`)
    out.push(...(Array.isArray(data?.pods) ? data.pods : []))
    if (!data?.pagination?.hasNextPage || !data.pagination.nextCursor) break
    cursor = data.pagination.nextCursor
  }
  return out
}

export async function getPod(apiKey, podId) {
  return request(apiKey, 'GET', `/pods/${encodeURIComponent(podId)}`)
}

/** Permanently delete a pod. v2 returns 204 with no body. */
export async function deletePod(apiKey, podId) {
  await request(apiKey, 'DELETE', `/pods/${encodeURIComponent(podId)}`)
}

/** All network volumes, following the cursor pagination v2 uses on list endpoints. */
export async function listNetworkVolumes(apiKey) {
  const out = []
  let cursor
  for (let page = 0; page < 20; page++) {
    const query = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : '?limit=100'
    const data = await request(apiKey, 'GET', `/network-volumes${query}`)
    out.push(...(Array.isArray(data?.networkVolumes) ? data.networkVolumes : []))
    if (!data?.pagination?.hasNextPage || !data.pagination.nextCursor) break
    cursor = data.pagination.nextCursor
  }
  return out
}

export async function createNetworkVolume(apiKey, { name, size, dataCenter, type }) {
  return request(apiKey, 'POST', '/network-volumes', {
    name,
    size,
    dataCenter,
    ...(type ? { type } : {}),
  })
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

/** Poll until the pod is RUNNING and a usable SSH endpoint is resolvable. */
export async function waitForPodSsh(apiKey, podId, opts) {
  const deadline = Date.now() + opts.timeoutMs
  const requireDirect = opts.requireDirect !== false
  let lastStatus = ''
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error('Aborted while waiting for Runpod pod')
    const pod = await getPod(apiKey, podId)
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
