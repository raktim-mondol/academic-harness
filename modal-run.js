import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join, posix } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULT_MODAL_INSTANCE_ID, MODAL_INSTANCE_IDS, resolveModalInstance } from './modal-instances.js'
import { resolveEnv } from './credential-env.js'
import { resolveWorkspacePath } from './workspace-path.js'

const APP_NAME = 'academic-harness'
const WORKDIR = '/workspace'
const DEFAULT_TIMEOUT_S = 600
const MAX_TIMEOUT_S = 3600
const MAX_OUTPUT_CHARS = 16000

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function truncate(s) {
  if (s.length <= MAX_OUTPUT_CHARS) return s
  return `…(${s.length - MAX_OUTPUT_CHARS} earlier chars truncated)\n${s.slice(-MAX_OUTPUT_CHARS)}`
}

function shellQuote(s) {
  return `'${s.replace(/'/g, "'\\''")}'`
}

function isNotFound(error) {
  const msg = error instanceof Error ? error.message : String(error)
  return /No such file|not found|does not exist/i.test(msg)
}

/** Read a Modal stream while keeping only its tail, so a huge log cannot exhaust memory. */
async function readCapped(stream, maxChars = 256 * 1024) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += typeof value === 'string' ? value : decoder.decode(value, { stream: true })
    if (text.length > maxChars) text = text.slice(-maxChars)
  }
  return text
}

function makeLocalTar(localDir) {
  const dir = mkdtempSync(join(tmpdir(), 'academic-harness-modal-tar-'))
  const tarPath = join(dir, 'upload.tgz')
  const r = spawnSync('tar', ['czf', tarPath, '-C', dirname(localDir), basename(localDir)], { encoding: 'utf8' })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`tar failed: ${(r.stderr || r.stdout || '').trim()}`)
  return { tarPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function extractLocalTar(tarPath, localDir) {
  const parent = dirname(localDir)
  const base = basename(localDir)
  const tmp = mkdtempSync(join(tmpdir(), 'academic-harness-modal-extract-'))
  try {
    const target = join(tmp, base)
    const r = spawnSync('tar', ['xzf', tarPath, '-C', tmp], { encoding: 'utf8' })
    if (r.error) throw r.error
    if (r.status !== 0) throw new Error(`tar extract failed: ${(r.stderr || r.stdout || '').trim()}`)
    mkdirSync(parent, { recursive: true })
    rmSync(localDir, { recursive: true, force: true })
    const r2 = spawnSync('mv', [target, localDir], { encoding: 'utf8' })
    if (r2.error) throw r2.error
    if (r2.status !== 0) throw new Error(`move failed: ${(r2.stderr || r2.stdout || '').trim()}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** Register the Modal remote-compute offload tool. */
export function applyModalRun(ctx) {
  ctx.tools.register(defineTool({
    name: 'modal_run',
    description: [
      'Run a command or script on a remote Modal Sandbox (on-demand CPU or GPU) and get the result back.',
      'Use for heavy or GPU work that should not run locally: model training/fine-tuning, GPU inference, large simulations.',
      `Pick an instance by GPU need (one of: ${MODAL_INSTANCE_IDS.join(', ')}; default "${DEFAULT_MODAL_INSTANCE_ID}").`,
      'Upload inputs with files_in (workspace-relative; files or directories) and name expected outputs in files_out — they are copied back into the local workspace.',
      'GPU instances default to a CUDA/PyTorch image; override with image_base. Pass volume_name to mount a persistent Modal Volume at /workspace so data survives between calls.',
      'Requires MODAL_TOKEN_ID and MODAL_TOKEN_SECRET (https://modal.com/settings) and the optional `modal` SDK in this profile. Always terminates the sandbox when done.',
    ].join(' '),
    parameters: {
      command: { type: 'string', required: true, description: 'Shell command to run remotely (via sh -lc) in /workspace.' },
      instance: { type: 'string', enum: MODAL_INSTANCE_IDS, description: `Compute instance id (default "${DEFAULT_MODAL_INSTANCE_ID}").` },
      image_base: { type: 'string', description: 'Base registry image. Defaults to a slim Python image for CPU and a CUDA/PyTorch image for GPU instances.' },
      image_pip: { type: 'array', items: { type: 'string' }, description: 'pip packages to install into the image.' },
      image_apt: { type: 'array', items: { type: 'string' }, description: 'apt packages to install into the image.' },
      files_in: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths (files or directories) to upload into the remote /workspace before running.' },
      files_out: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths (files or directories) to download back after the job finishes.' },
      timeout_sec: { type: 'integer', description: `Max seconds before the sandbox is killed (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}).` },
      volume_name: { type: 'string', description: 'Reusable Modal Volume name mounted at /workspace, created if missing. Reuse the same name across calls to keep datasets and checkpoints instead of re-uploading them.' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        if (value.error) return [{ type: 'text', text: value.text ?? value.error }]
        return [{ type: 'text', text: value.text }]
      },
    },
    async execute(args, exec) {
      if (exec.signal?.aborted) return { error: 'aborted', text: 'Modal run was cancelled before it started.' }
      const [tokenId, tokenSecret] = await Promise.all([
        resolveEnv('MODAL_TOKEN_ID'),
        resolveEnv('MODAL_TOKEN_SECRET'),
      ])
      if (!tokenId || !tokenSecret) {
        return {
          error: 'not_configured',
          text: 'Modal is not configured. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET '
            + '(Settings -> Academic Harness API keys, or the env vars — get them at https://modal.com/settings).',
        }
      }

      const instanceId = args.instance ?? DEFAULT_MODAL_INSTANCE_ID
      const spec = resolveModalInstance(instanceId)
      if (!spec) {
        return { error: 'unknown_instance', text: `Unknown compute instance "${instanceId}". Valid instances: ${MODAL_INSTANCE_IDS.join(', ')}.` }
      }

      let ModalClient
      try {
        ({ ModalClient } = await import('modal'))
      } catch (error) {
        const code = error?.code
        if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
          return {
            error: 'sdk_missing',
            text: 'The optional Modal SDK is not installed in this DSH profile. '
              + 'Install it with `dsh plugin --profile <profile> add modal`, then restart dsh; '
              + 'or use `runpod_run` / `vastai_run` instead.',
          }
        }
        throw error
      }
      const root = workspaceRoot(exec)
      let inFiles
      let outFiles
      try {
        inFiles = (args.files_in ?? []).map((rel) => ({ rel, local: resolveWorkspacePath(root, rel) }))
        outFiles = (args.files_out ?? []).map((rel) => ({ rel, local: resolveWorkspacePath(root, rel, { forWrite: true }) }))
      } catch (error) {
        return { error: 'invalid_path', text: error instanceof Error ? error.message : String(error) }
      }
      const requestedTimeout = Number(args.timeout_sec ?? DEFAULT_TIMEOUT_S)
      const timeoutMs = Math.min(Math.max(Math.floor(Number.isFinite(requestedTimeout) ? requestedTimeout : DEFAULT_TIMEOUT_S), 1), MAX_TIMEOUT_S) * 1000

      let modal
      try {
        modal = new ModalClient({ tokenId, tokenSecret })
      } catch (error) {
        return {
          error: 'modal_failure',
          text: `Modal client could not be created: ${error instanceof Error ? error.message : String(error)}\n`
            + 'Check MODAL_TOKEN_ID / MODAL_TOKEN_SECRET (https://modal.com/settings).',
        }
      }
      const startedAt = Date.now()
      let sb = null
      let sandboxId = null
      let teardownChain = Promise.resolve(null)
      const terminate = () => {
        teardownChain = teardownChain.then(async () => {
          if (!sb) return null
          let lastError = null
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await sb.terminate()
              sb = null
              return null
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error)
              if (/not found|already terminated|does not exist/i.test(msg)) {
                sb = null
                return null
              }
              lastError = error
              if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
            }
          }
          return lastError
        })
        return teardownChain
      }
      const onAbort = () => { void terminate() }
      exec.signal?.addEventListener('abort', onAbort, { once: true })

      let outcome = null
      let teardownError = null
      try {
        const app = await modal.apps.fromName(APP_NAME, { createIfMissing: true })

        let image = modal.images.fromRegistry(args.image_base?.trim() || spec.defaultImage)
        const dockerCmds = []
        if (args.image_apt?.length) {
          dockerCmds.push(`RUN apt-get update && apt-get install -y ${args.image_apt.join(' ')} && rm -rf /var/lib/apt/lists/*`)
        }
        if (args.image_pip?.length) {
          dockerCmds.push(`RUN pip install --no-cache-dir ${args.image_pip.join(' ')}`)
        }
        if (dockerCmds.length) image = image.dockerfileCommands(dockerCmds)

        const volumes = {}
        if (args.volume_name) {
          volumes[WORKDIR] = await modal.volumes.fromName(args.volume_name, { createIfMissing: true })
        }

        sb = await modal.sandboxes.create(app, image, {
          gpu: spec.gpu ?? undefined,
          cpu: spec.cpu,
          memoryMiB: spec.memoryMiB,
          timeoutMs,
          ...(Object.keys(volumes).length ? { volumes } : {}),
        })
        sandboxId = sb.sandboxId ?? null
        if (exec.signal?.aborted) throw new Error('Aborted after sandbox creation')
        await sb.filesystem.makeDirectory(WORKDIR, { createParents: true })

        const stagedIn = []
        const missingIn = []
        for (const { rel, local } of inFiles) {
          if (!existsSync(local)) { missingIn.push(rel); continue }
          const remote = posix.join(WORKDIR, rel)
          const remoteDir = posix.dirname(remote)
          if (remoteDir && remoteDir !== WORKDIR) await sb.filesystem.makeDirectory(remoteDir, { createParents: true })
          if (statSync(local).isDirectory()) {
            const { tarPath, cleanup } = makeLocalTar(local)
            try {
              const remoteTar = `/tmp/ah-upload-${basename(local)}.tgz`
              await sb.filesystem.copyFromLocal(tarPath, remoteTar)
              const extract = await sb.exec(['sh', '-lc', `tar xzf ${shellQuote(remoteTar)} -C ${shellQuote(remoteDir)} && rm -f ${shellQuote(remoteTar)}`], { timeoutMs: 600_000 })
              const code = await extract.wait()
              if (code !== 0) throw new Error(`remote tar extract failed for ${rel} (exit ${code})`)
            } finally {
              cleanup()
            }
          } else {
            await sb.filesystem.copyFromLocal(local, remote)
          }
          stagedIn.push(rel)
        }

        const proc = await sb.exec(['sh', '-lc', args.command], { stdout: 'pipe', stderr: 'pipe', workdir: WORKDIR, timeoutMs })
        const [stdout, stderr] = await Promise.all([readCapped(proc.stdout), readCapped(proc.stderr)])
        const exitCode = await proc.wait()

        // Volume v2 persists shell writes on an explicit sync; v1 ignores it.
        if (args.volume_name) {
          const sync = await sb.exec(['sh', '-lc', `sync ${shellQuote(WORKDIR)} || true`], { timeoutMs: 120_000 })
          await sync.wait()
        }

        const collectedOut = []
        const missingOut = []
        const failedOut = []
        for (const { rel, local } of outFiles) {
          const remote = posix.join(WORKDIR, rel)
          let missing = false
          try {
            mkdirSync(dirname(local), { recursive: true })
            const probe = await sb.exec(['sh', '-lc', `test -d ${shellQuote(remote)}`], { timeoutMs: 30_000 })
            const isDir = (await probe.wait()) === 0
            if (isDir) {
              const remoteTar = `/tmp/ah-download-${Date.now()}.tgz`
              const pack = await sb.exec(['sh', '-lc', `tar czf ${shellQuote(remoteTar)} -C ${shellQuote(posix.dirname(remote))} ${shellQuote(posix.basename(remote))}`], { timeoutMs: 1800_000 })
              const packCode = await pack.wait()
              if (packCode !== 0) throw new Error(`remote tar failed (exit ${packCode})`)
              const localTar = `${local}.download.tgz`
              try {
                await sb.filesystem.copyToLocal(remoteTar, localTar)
                extractLocalTar(localTar, local)
              } finally {
                rmSync(localTar, { force: true })
                await sb.exec(['sh', '-lc', `rm -f ${shellQuote(remoteTar)}`], { timeoutMs: 30_000 }).then((p) => p.wait()).catch(() => {})
              }
            } else {
              try {
                await sb.filesystem.copyToLocal(remote, local)
              } catch (error) {
                if (isNotFound(error)) missing = true
                else throw error
              }
            }
            if (!missing) collectedOut.push(rel)
          } catch (error) {
            if (exec.signal?.aborted) throw error
            if (missing || isNotFound(error)) missingOut.push(rel)
            else failedOut.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }

        const durationMs = Date.now() - startedAt
        const costUsd = (durationMs / 3_600_000) * spec.pricePerHour
        const summary = {
          provider: 'modal',
          sandbox_id: sandboxId,
          instance: spec.id,
          gpu: spec.gpu,
          image: args.image_base?.trim() || spec.defaultImage,
          exit_code: exitCode,
          duration_ms: durationMs,
          cost_usd: Number(costUsd.toFixed(4)),
          ...(stagedIn.length ? { files_in: stagedIn } : {}),
          ...(missingIn.length ? { files_in_missing: missingIn } : {}),
          files_out: collectedOut,
          ...(missingOut.length ? { files_out_missing: missingOut } : {}),
          ...(failedOut.length ? { files_out_failed: failedOut } : {}),
          ...(args.volume_name ? { volume_name: args.volume_name } : {}),
        }
        const text = `${JSON.stringify(summary, null, 2)}\n\n--- stdout ---\n${truncate(stdout) || '(empty)'}\n\n--- stderr ---\n${truncate(stderr) || '(empty)'}`
        outcome = { ...summary, text }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        outcome = {
          error: 'modal_failure',
          instance: spec.id,
          sandbox_id: sandboxId,
          text: `Modal run failed on instance "${spec.id}"${sandboxId ? ` (sandbox ${sandboxId})` : ''}: ${msg}\nIf this is an authentication error, check MODAL_TOKEN_ID / MODAL_TOKEN_SECRET.`,
        }
      } finally {
        exec.signal?.removeEventListener('abort', onAbort)
        teardownError = await terminate()
        modal.close()
      }

      if (teardownError) {
        const msg = teardownError instanceof Error ? teardownError.message : String(teardownError)
        return {
          ...(outcome ?? {}),
          error: 'modal_teardown_failed',
          teardown_error: msg,
          sandbox_id: sandboxId,
          text: `${outcome?.text ? `${outcome.text}\n\n` : ''}TEARDOWN FAILED: Modal sandbox ${sandboxId ?? '(unknown id)'} could not be terminated after 3 attempts: ${msg}\n`
            + 'The sandbox self-destructs at its timeout, but may keep billing until then. '
            + 'Stop it with `modal container stop` or from the Modal dashboard.',
        }
      }
      return outcome
    },
    presentCall() {
      return { card: 'generic', title: 'Modal compute', kind: 'other' }
    },
  }))
}
