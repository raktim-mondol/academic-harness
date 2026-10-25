/**
 * Shared SSH/SCP/tar transport for the remote-compute tools.
 *
 * Runpod and Vast.ai both expose a plain SSH endpoint, so the upload, exec,
 * and download paths live here instead of being duplicated per provider.
 * Modal has its own SDK filesystem API and does not use this module.
 *
 * Every helper takes an `ssh` object shaped `{ host, port, username? }` and a
 * private-key path. Commands run as the provider's default SSH user (usually
 * root); the username comes from the provider endpoint, not a guess.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, randomBytes } from 'node:crypto'

const MAX_CAPTURE_BYTES = 256 * 1024
const DEFAULT_TRANSFER_TIMEOUT_MS = 30 * 60 * 1000

function runSync(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.stdout || '').trim()}`)
  return r.stdout
}

/** Keep only the tail of a stream so a huge log cannot exhaust dsh memory. */
function appendCapped(buffer, chunk) {
  const next = buffer + chunk
  return next.length > MAX_CAPTURE_BYTES ? next.slice(-MAX_CAPTURE_BYTES) : next
}

/** Generate an ephemeral OpenSSH ed25519 key pair in a temp dir. */
export function makeEphemeralSshKey() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'academic-harness-ssh-'))
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
      throw new Error(`ssh-keygen is required to provision ephemeral SSH keys for remote compute. Install OpenSSH client tools and retry. (${detail})`)
    }
  }
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

function sshTarget(ssh) {
  return `${ssh.username ?? 'root'}@${ssh.host}`
}

function sshExecOnce(keyPath, ssh, command, opts) {
  return new Promise((resolve, reject) => {
    const args = [...sshBaseArgs(keyPath, ssh), sshTarget(ssh), command]
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

    child.stdout?.on('data', (c) => { stdout = appendCapped(stdout, c.toString('utf8')) })
    child.stderr?.on('data', (c) => { stderr = appendCapped(stderr, c.toString('utf8')) })
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

/**
 * Run a remote command over SSH. Retries briefly while sshd starts.
 * `deadlineMs` is an absolute Date.now() bound for the whole retry loop, so a
 * stuck host cannot extend provisioning indefinitely.
 */
export async function sshExec(keyPath, ssh, command, opts = { timeoutMs: 600_000 }) {
  const retries = opts.retries ?? 12
  const deadline = opts.deadlineMs ?? Infinity
  let lastErr = ''
  for (let attempt = 0; attempt < retries; attempt++) {
    if (opts.signal?.aborted) throw new Error('Aborted')
    if (Date.now() >= deadline) throw new Error(`SSH provisioning deadline exceeded${lastErr ? `: ${lastErr}` : ''}`)
    try {
      return await sshExecOnce(keyPath, ssh, command, {
        ...opts,
        timeoutMs: Math.min(opts.timeoutMs, Math.max(deadline - Date.now(), 1)),
      })
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
      if (/Connection refused|Connection timed out|Connection reset|No route to host|Connection closed/i.test(lastErr) && attempt < retries - 1) {
        await sleep(4000, opts.signal)
        continue
      }
      // Permission denied during early boot: the key is installed by the
      // provider's entrypoint slightly after sshd starts listening. Only the
      // provisioning call opts into this; retrying a user command could
      // repeat side effects.
      if (opts.retryPermissionDenied && /Permission denied/i.test(lastErr) && attempt < retries - 1) {
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
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=4',
      src, dest,
    ]
    const child = spawn('scp', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`scp timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const onAbort = () => {
      clearTimeout(timer)
      child.kill('SIGTERM')
      reject(new Error('Aborted'))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stderr?.on('data', (c) => { stderr = appendCapped(stderr, c.toString('utf8')) })
    child.on('error', (err) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (code === 0) resolve()
      else reject(Object.assign(new Error(`scp failed (${code}): ${stderr.trim() || 'unknown error'}`), { code }))
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
  await scpOnce(keyPath, ssh, localPath, `${sshTarget(ssh)}:${remotePath}`, { ...opts, recursive })
}

/** Download a remote file to a local path via scp, replacing it only on success. */
export async function scpDownload(keyPath, ssh, remotePath, localPath, opts = {}) {
  const tmp = `${localPath}.part-${randomBytes(4).toString('hex')}`
  try {
    await scpOnce(keyPath, ssh, `${sshTarget(ssh)}:${remotePath}`, tmp, opts)
    fs.renameSync(tmp, localPath)
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
}

/**
 * Tar a local directory and extract it on the remote host at remoteDir.
 * Both ends must exit 0; a failed local read (partial upload) is an error.
 */
export async function tarUploadDir(keyPath, ssh, localDir, remoteDir, signal, timeoutMs = DEFAULT_TRANSFER_TIMEOUT_MS) {
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
      '-o', 'ConnectTimeout=15',
      sshTarget(ssh),
      `mkdir -p '${remoteParent.replace(/'/g, "'\\''")}' && tar xzf - -C '${remoteParent.replace(/'/g, "'\\''")}'`,
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    tar.stdout.pipe(remote.stdin)
    let err = ''
    let localCode = null
    let remoteCode = null
    let settled = false
    const kill = () => {
      tar.kill('SIGTERM')
      remote.kill('SIGTERM')
    }
    const timer = setTimeout(() => finish(new Error(`directory upload timed out after ${timeoutMs}ms`)), timeoutMs)
    const onAbort = () => finish(new Error('Aborted'))
    function finish(error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) {
        kill()
        reject(error)
        return
      }
      if (localCode === 0 && remoteCode === 0) resolve()
      else reject(new Error(`directory upload failed (tar ${localCode}, ssh ${remoteCode}): ${err.trim()}`))
    }
    tar.stderr?.on('data', (c) => { err = appendCapped(err, c.toString('utf8')) })
    remote.stderr?.on('data', (c) => { err = appendCapped(err, c.toString('utf8')) })
    signal?.addEventListener('abort', onAbort, { once: true })
    tar.on('close', (code) => { localCode = code; if (remoteCode !== null) finish() })
    remote.on('close', (code) => { remoteCode = code; if (localCode !== null) finish() })
    tar.on('error', (e) => finish(e))
    remote.on('error', (e) => finish(e))
  })
}

/**
 * Stream a remote directory back as a tar and extract it at `localDir`.
 * The old directory is replaced only after both the remote and local tar
 * succeed; a failed transfer leaves the previous output intact.
 */
export async function tarDownloadDir(keyPath, ssh, remoteDir, localDir, signal, timeoutMs = DEFAULT_TRANSFER_TIMEOUT_MS) {
  const remoteParent = path.posix.dirname(remoteDir)
  const remoteBase = path.posix.basename(remoteDir)
  const localParent = path.dirname(localDir)
  fs.mkdirSync(localParent, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'academic-harness-tar-'))
  try {
    await new Promise((resolve, reject) => {
      const remote = spawn('ssh', [
        '-i', keyPath,
        '-p', String(ssh.port),
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'IdentitiesOnly=yes',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=15',
        sshTarget(ssh),
        `tar czf - -C '${remoteParent.replace(/'/g, "'\\''")}' '${remoteBase.replace(/'/g, "'\\''")}'`,
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      const tar = spawn('tar', ['xzf', '-', '-C', tmp], { stdio: ['pipe', 'pipe', 'pipe'] })
      remote.stdout.pipe(tar.stdin)
      let err = ''
      let localCode = null
      let remoteCode = null
      let settled = false
      const kill = () => {
        remote.kill('SIGTERM')
        tar.kill('SIGTERM')
      }
      const timer = setTimeout(() => finish(new Error(`directory download timed out after ${timeoutMs}ms`)), timeoutMs)
      const onAbort = () => finish(new Error('Aborted'))
      function finish(error) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error) {
          kill()
          reject(error)
          return
        }
        if (localCode === 0 && remoteCode === 0) resolve()
        else reject(new Error(`directory download failed (ssh ${remoteCode}, tar ${localCode}): ${err.trim()}`))
      }
      remote.stderr?.on('data', (c) => { err = appendCapped(err, c.toString('utf8')) })
      tar.stderr?.on('data', (c) => { err = appendCapped(err, c.toString('utf8')) })
      signal?.addEventListener('abort', onAbort, { once: true })
      remote.on('close', (code) => { remoteCode = code; if (localCode !== null) finish() })
      tar.on('close', (code) => { localCode = code; if (remoteCode !== null) finish() })
      remote.on('error', (e) => finish(e))
      tar.on('error', (e) => finish(e))
    })
    fs.rmSync(localDir, { recursive: true, force: true })
    fs.renameSync(path.join(tmp, remoteBase), localDir)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** Unique short run id shared by the providers' ephemeral resource names. */
export function ephemeralName(prefix = 'dshrc') {
  return `${prefix}-${randomBytes(4).toString('hex')}`
}
