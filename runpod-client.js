/**
 * Minimal Runpod REST client for ephemeral pod jobs.
 *
 * Uses REST v1 (https://rest.runpod.io/v1) with `Authorization: Bearer <key>`.
 * Pods are created with an injected PUBLIC_KEY so we can SSH + SCP without a
 * pre-registered account key.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, randomBytes } from 'node:crypto'

const REST_BASE = process.env.RUNPOD_REST_API_URL ?? 'https://rest.runpod.io/v1'

async function request(apiKey, method, relPath, body) {
  const res = await fetch(`${REST_BASE}${relPath}`, {
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
    const msg = data && typeof data === 'object' && 'error' in data
      ? String(data.error)
      : data && typeof data === 'object' && 'message' in data ? String(data.message) : text || res.statusText
    throw new Error(`Runpod API ${method} ${relPath} → ${res.status}: ${msg}`)
  }
  return data
}

export async function createPod(apiKey, body) {
  return request(apiKey, 'POST', '/pods', body)
}

export async function getPod(apiKey, podId) {
  return request(apiKey, 'GET', `/pods/${encodeURIComponent(podId)}`)
}

export async function deletePod(apiKey, podId) {
  await request(apiKey, 'DELETE', `/pods/${encodeURIComponent(podId)}`)
}

export async function listNetworkVolumes(apiKey) {
  return request(apiKey, 'GET', '/networkvolumes')
}

export async function createNetworkVolume(apiKey, { name, size, dataCenterId }) {
  return request(apiKey, 'POST', '/networkvolumes', { name, size, dataCenterId })
}

function runSync(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.stdout || '').trim()}`)
  return r.stdout
}

/** Generate an ephemeral OpenSSH ed25519 key pair in a temp dir. */
export function makeEphemeralSshKey() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'academic-harness-runpod-ssh-'))
  const privateKeyPath = path.join(dir, 'id_ed25519')
  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup of a temp dir
    }
  }

  // Prefer ssh-keygen (emits native OpenSSH keys that ssh/scp accept).
  try {
    runSync('ssh-keygen', ['-t', 'ed25519', '-f', privateKeyPath, '-N', '', '-C', 'academic-harness-ephemeral', '-q'])
    const publicKeyOpenSsh = fs.readFileSync(`${privateKeyPath}.pub`, 'utf8').trim()
    if (!publicKeyOpenSsh.startsWith('ssh-')) throw new Error('ssh-keygen produced an unexpected public key format')
    return { privateKeyPath, publicKeyOpenSsh, cleanup }
  } catch (primaryErr) {
    // Fallback: Node crypto PEM + ssh-keygen -y conversion.
    try {
      const { privateKey } = generateKeyPairSync('ed25519', {
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      })
      fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 })
      let publicKeyOpenSsh = runSync('ssh-keygen', ['-y', '-f', privateKeyPath]).trim()
      if (!publicKeyOpenSsh.startsWith('ssh-')) throw new Error('ssh-keygen -y did not produce an OpenSSH public key')
      publicKeyOpenSsh = `${publicKeyOpenSsh} academic-harness-ephemeral`
      fs.writeFileSync(`${privateKeyPath}.pub`, `${publicKeyOpenSsh}\n`, { mode: 0o644 })
      return { privateKeyPath, publicKeyOpenSsh, cleanup }
    } catch {
      cleanup()
      const detail = primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
      throw new Error(`ssh-keygen is required to provision ephemeral SSH keys for Runpod pods. Install OpenSSH client tools and retry. (${detail})`)
    }
  }
}

/**
 * Resolve an SSH endpoint from a pod, with proxy fallback.
 *
 * REST v1's Pod object has no `runtime` field (verified against
 * https://rest.runpod.io/v1/openapi.json) — the public TCP mapping for port
 * 22 lives at top-level `portMappings["22"]` (public port) plus `publicIp`,
 * not a `runtime.ports[]` array. Both are `null`/absent while the pod is
 * still initializing, or on some community-cloud pods that only expose the
 * SSH proxy — in either case, fall back to Runpod's proxy host form.
 */
export function resolveSshEndpoint(pod) {
  const publicPort = pod.portMappings?.['22']
  if (pod.publicIp && publicPort) return { host: pod.publicIp, port: publicPort, kind: 'tcp' }
  if (pod.id) return { host: `${pod.id}-22.port.proxy.runpod.net`, port: 22, kind: 'proxy' }
  return null
}

export async function sleep(ms, signal) {
  if (signal?.aborted) throw new Error('Aborted')
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new Error('Aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Poll until the pod is RUNNING and an SSH endpoint is resolvable (or timeout). */
export async function waitForPodSsh(apiKey, podId, opts) {
  const deadline = Date.now() + opts.timeoutMs
  let lastStatus = ''
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error('Aborted while waiting for Runpod pod')
    const pod = await getPod(apiKey, podId)
    lastStatus = pod.desiredStatus ?? ''
    if (lastStatus === 'EXITED' || lastStatus === 'TERMINATED') {
      throw new Error(`Pod ${podId} entered terminal status ${lastStatus}`)
    }
    if (lastStatus === 'RUNNING') {
      const ssh = resolveSshEndpoint(pod)
      if (ssh) return { pod, ssh }
    }
    await sleep(3000, opts.signal)
  }
  throw new Error(`Timed out waiting for pod ${podId} SSH (last status: ${lastStatus || 'unknown'})`)
}

function sshBaseArgs(keyPath, ssh) {
  return [
    '-i', keyPath,
    '-p', String(ssh.port),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
  ]
}

function sshExecOnce(keyPath, ssh, command, opts) {
  return new Promise((resolve, reject) => {
    const args = [...sshBaseArgs(keyPath, ssh), `root@${ssh.host}`, command]
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const onAbort = () => {
      child.kill('SIGTERM')
      reject(new Error('Aborted'))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`SSH command timed out after ${opts.timeoutMs}ms`))
    }, opts.timeoutMs)

    child.stdout?.on('data', (c) => { stdout += c.toString('utf8') })
    child.stderr?.on('data', (c) => { stderr += c.toString('utf8') })
    child.on('error', (err) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (code === 255 && /Permission denied|Connection refused|timed out/i.test(stderr + stdout)) {
        reject(new Error((stderr || stdout || 'SSH failed').trim()))
        return
      }
      resolve({ exitCode: code ?? 1, stdout, stderr })
    })
  })
}

/** Run a remote command over SSH as root. Retries briefly while sshd starts. */
export async function sshExec(keyPath, ssh, command, opts = { timeoutMs: 600_000 }) {
  const retries = opts.retries ?? 12
  let lastErr = ''
  for (let attempt = 0; attempt < retries; attempt++) {
    if (opts.signal?.aborted) throw new Error('Aborted')
    try {
      return await sshExecOnce(keyPath, ssh, command, opts)
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
      if (/Connection refused|Connection timed out|Connection reset|No route to host|Connection closed/i.test(lastErr) && attempt < retries - 1) {
        await sleep(4000, opts.signal)
        continue
      }
      throw err
    }
  }
  throw new Error(lastErr || 'SSH exec failed')
}

function scpOnce(keyPath, ssh, src, dest, opts) {
  return new Promise((resolve, reject) => {
    const args = [
      ...(opts.recursive ? ['-r'] : []),
      '-i', keyPath,
      '-P', String(ssh.port),
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=15',
      src, dest,
    ]
    const child = spawn('scp', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    const onAbort = () => {
      child.kill('SIGTERM')
      reject(new Error('Aborted'))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stderr?.on('data', (c) => { stderr += c.toString('utf8') })
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (code === 0) resolve()
      else reject(new Error(`scp failed (${code}): ${stderr.trim() || 'unknown error'}`))
    })
  })
}

/** Upload a local file or directory to the remote path via scp. */
export async function scpUpload(keyPath, ssh, localPath, remotePath, opts = {}) {
  const recursive = opts.recursive ?? (() => {
    try {
      return fs.statSync(localPath).isDirectory()
    } catch {
      return false
    }
  })()
  await scpOnce(keyPath, ssh, localPath, `root@${ssh.host}:${remotePath}`, { ...opts, recursive })
}

/** Download a remote file to a local path via scp. */
export async function scpDownload(keyPath, ssh, remotePath, localPath, opts = {}) {
  await scpOnce(keyPath, ssh, `root@${ssh.host}:${remotePath}`, localPath, opts)
}

/** Tar a local directory and extract it on the remote host at remoteDir. */
export async function tarUploadDir(keyPath, ssh, localDir, remoteDir, signal) {
  const parent = path.dirname(localDir)
  const base = path.basename(localDir)
  const remoteParent = path.posix.dirname(remoteDir)
  await new Promise((resolve, reject) => {
    const tar = spawn('tar', ['czf', '-', '-C', parent, base], { stdio: ['ignore', 'pipe', 'pipe'] })
    const remote = spawn('ssh', [
      '-i', keyPath,
      '-p', String(ssh.port),
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes',
      `root@${ssh.host}`,
      `mkdir -p '${remoteParent.replace(/'/g, "'\\''")}' && tar xzf - -C '${remoteParent.replace(/'/g, "'\\''")}'`,
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    tar.stdout.pipe(remote.stdin)
    let err = ''
    tar.stderr?.on('data', (c) => { err += c.toString('utf8') })
    remote.stderr?.on('data', (c) => { err += c.toString('utf8') })
    const onAbort = () => {
      tar.kill('SIGTERM')
      remote.kill('SIGTERM')
      reject(new Error('Aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    remote.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (code === 0) resolve()
      else reject(new Error(`tar-ssh upload failed: ${err.trim() || code}`))
    })
    tar.on('error', reject)
    remote.on('error', reject)
  })
}

/** Unique short pod name for academic-harness ephemeral jobs. */
export function ephemeralPodName() {
  return `dshrc-${randomBytes(4).toString('hex')}`
}
