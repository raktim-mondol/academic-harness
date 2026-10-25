/**
 * Minimal Vast.ai REST client for ephemeral instance jobs.
 *
 * Base https://console.vast.ai/api/v0 with `Authorization: Bearer <key>`.
 * The marketplace flow is: POST /bundles/ (search offers) → PUT /asks/{offer}/
 * (create instance, returns `new_contract` as the instance id) → poll
 * GET /instances/{id}/ → DELETE /instances/{id}/.
 *
 * SSH keys must be registered on the account before an instance is created,
 * so the run tool registers a per-call ephemeral key and removes it again in
 * its teardown block.
 */
import { sleep } from './ssh-client.js'

const API_BASE = process.env.VAST_API_BASE_URL ?? 'https://console.vast.ai/api/v0'

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
  if (!res.ok || data?.success === false) {
    const msg = data?.detail
      ?? data?.msg
      ?? data?.error
      ?? text
      ?? res.statusText
    throw new Error(`Vast.ai API ${method} ${relPath} → ${res.status}: ${msg}`)
  }
  return data
}

/** POST /bundles/ — returns offer objects, cheapest first. */
export async function searchOffers(apiKey, body) {
  const data = await request(apiKey, 'POST', '/bundles/', body)
  const raw = data?.offers
  const offers = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : []
  return offers
    .filter((o) => o && (o.id ?? o.ask_contract_id) != null)
    .map((o) => ({ ...o, id: o.id ?? o.ask_contract_id }))
    .sort((a, b) => Number(a.dph_total ?? Infinity) - Number(b.dph_total ?? Infinity))
}

/** PUT /asks/{offerId}/ — returns `{ success, new_contract }`. */
export async function createInstance(apiKey, offerId, body) {
  return request(apiKey, 'PUT', `/asks/${encodeURIComponent(offerId)}/`, body)
}

/** GET /instances/{id}/ — returns the instance object (wrapped in `instances`). */
export async function showInstance(apiKey, instanceId) {
  const data = await request(apiKey, 'GET', `/instances/${encodeURIComponent(instanceId)}/`)
  return data?.instances ?? data?.instance ?? data ?? null
}

/** GET /instances/ — used to find an orphan after a failed create. */
export async function listInstances(apiKey) {
  const data = await request(apiKey, 'GET', '/instances/')
  const raw = data?.instances
  return Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : []
}

/** DELETE /instances/{id}/ — permanently destroys the instance. */
export async function destroyInstance(apiKey, instanceId) {
  return request(apiKey, 'DELETE', `/instances/${encodeURIComponent(instanceId)}/`)
}

/** POST /ssh — register a public key on the account (required before create). */
export async function registerSshKey(apiKey, publicKey) {
  const data = await request(apiKey, 'POST', '/ssh', { ssh_key: publicKey })
  const id = data?.key?.id ?? data?.id
  if (id === undefined || id === null) throw new Error('Vast.ai SSH key registration returned no key id')
  return id
}

/** DELETE /ssh/{id} — remove a key from the account. */
export async function deleteSshKey(apiKey, keyId) {
  return request(apiKey, 'DELETE', `/ssh/${encodeURIComponent(keyId)}`)
}

/** SSH endpoint from an instance object: `ssh_host`/`ssh_port`, else the 22/tcp mapping. */
export function resolveSshEndpoint(instance) {
  if (instance?.ssh_host && instance?.ssh_port) {
    return { host: instance.ssh_host, port: Number(instance.ssh_port), username: 'root', kind: 'direct' }
  }
  const mapping = instance?.ports?.['22/tcp']
  const entry = Array.isArray(mapping) ? mapping[0] : mapping
  const port = entry?.HostPort ?? entry?.hostPort
  const host = instance?.public_ipaddr?.split(',')?.[0]?.trim()
  if (host && port) return { host, port: Number(port), username: 'root', kind: 'direct' }
  return null
}

const TERMINAL_BAD_STATES = new Set(['exited', 'unknown', 'offline'])

/**
 * Poll until the container is running and SSH details exist.
 * `exited`/`unknown`/`offline` never recover on their own — fail fast so the
 * caller can destroy the instance and retry on a different offer.
 */
export async function waitForInstanceSsh(apiKey, instanceId, opts) {
  const deadline = Date.now() + opts.timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error('Aborted while waiting for Vast.ai instance')
    const info = await showInstance(apiKey, instanceId)
    last = String(info?.actual_status ?? info?.cur_state ?? 'unknown')
    if (TERMINAL_BAD_STATES.has(last)) {
      throw new Error(`Instance ${instanceId} entered unrecoverable state "${last}" (${info?.status_msg || 'no status message'})`)
    }
    if (last === 'running') {
      const ssh = resolveSshEndpoint(info)
      if (ssh) return { info, ssh }
    }
    await sleep(opts.pollMs ?? 10_000, opts.signal)
  }
  throw new Error(`Timed out waiting for instance ${instanceId} SSH (last status: ${last || 'unknown'})`)
}
