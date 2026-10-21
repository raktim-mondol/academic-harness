import { existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, posix, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULT_MODAL_INSTANCE_ID, MODAL_INSTANCE_IDS, resolveModalInstance } from './modal-instances.js'
import { resolveEnv } from './credential-env.js'

const APP_NAME = 'dsh-researchcraft'
const WORKDIR = '/workspace'
const DEFAULT_TIMEOUT_S = 600
const MAX_TIMEOUT_S = 3600
const MAX_OUTPUT_CHARS = 16000

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

/** Resolve a workspace-relative path, refusing traversal outside the workspace root. */
function safeUnder(root, rel) {
  const target = resolve(root, rel)
  const normalizedRoot = resolve(root)
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + '/')) {
    throw new Error(`path escapes the workspace: ${rel}`)
  }
  return target
}

function truncate(s) {
  if (s.length <= MAX_OUTPUT_CHARS) return s
  return `…(${s.length - MAX_OUTPUT_CHARS} earlier chars truncated)\n${s.slice(-MAX_OUTPUT_CHARS)}`
}

/** Register the Modal remote-compute offload tool. */
export function applyModalRun(ctx) {
  ctx.tools.register(defineTool({
    name: 'modal_run',
    description: [
      'Run a command or script on a remote Modal Sandbox (on-demand CPU or GPU) and get the result back.',
      'Use for heavy or GPU work that should not run locally: model training/fine-tuning, GPU inference, large simulations.',
      `Pick an instance by GPU need (one of: ${MODAL_INSTANCE_IDS.join(', ')}; default "${DEFAULT_MODAL_INSTANCE_ID}").`,
      'Upload inputs with files_in (workspace-relative) and name expected outputs in files_out — they are copied back into the local workspace.',
      'Requires MODAL_TOKEN_ID and MODAL_TOKEN_SECRET (https://modal.com/settings) and the optional `modal` SDK in this profile. Always terminates the sandbox when done.',
    ].join(' '),
    parameters: {
      command: { type: 'string', required: true, description: 'Shell command to run remotely (via sh -lc) in /workspace.' },
      instance: { type: 'string', enum: MODAL_INSTANCE_IDS, description: `Compute instance id (default "${DEFAULT_MODAL_INSTANCE_ID}").` },
      image_base: { type: 'string', description: 'Base registry image (default python:3.13-slim), e.g. a CUDA/framework image.' },
      image_pip: { type: 'array', items: { type: 'string' }, description: 'pip packages to install into the image.' },
      image_apt: { type: 'array', items: { type: 'string' }, description: 'apt packages to install into the image.' },
      files_in: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths to upload into the remote /workspace before running.' },
      files_out: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths to download back after the job finishes.' },
      timeout_sec: { type: 'integer', description: `Max seconds before the sandbox is killed (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}).` },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        if (value.error) return [{ type: 'text', text: value.text ?? value.error }]
        return [{ type: 'text', text: value.text }]
      },
    },
    async execute(args, exec) {
      const [tokenId, tokenSecret] = await Promise.all([
        resolveEnv('MODAL_TOKEN_ID'),
        resolveEnv('MODAL_TOKEN_SECRET'),
      ])
      if (!tokenId || !tokenSecret) {
        return {
          error: 'not_configured',
          text: 'Modal is not configured. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET '
            + '(Settings -> ResearchCraft API keys, or the env vars — get them at https://modal.com/settings).',
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
              + 'or use `runpod_run` instead. ResearchCraft leaves `modal` as an optional peer '
              + 'so plugin installation does not require native build scripts.',
          }
        }
        throw error
      }
      const root = workspaceRoot(exec)
      const timeoutMs = Math.min(Math.max(Math.floor(args.timeout_sec ?? DEFAULT_TIMEOUT_S), 1), MAX_TIMEOUT_S) * 1000

      const modal = new ModalClient({ tokenId, tokenSecret })
      const startedAt = Date.now()
      let sb = null
      const onAbort = () => { sb?.terminate().catch(() => {}) }
      exec.signal?.addEventListener('abort', onAbort, { once: true })

      try {
        const app = await modal.apps.fromName(APP_NAME, { createIfMissing: true })

        let image = modal.images.fromRegistry(args.image_base ?? spec.defaultImage)
        const dockerCmds = []
        if (args.image_apt?.length) {
          dockerCmds.push(`RUN apt-get update && apt-get install -y ${args.image_apt.join(' ')} && rm -rf /var/lib/apt/lists/*`)
        }
        if (args.image_pip?.length) {
          dockerCmds.push(`RUN pip install --no-cache-dir ${args.image_pip.join(' ')}`)
        }
        if (dockerCmds.length) image = image.dockerfileCommands(dockerCmds)

        sb = await modal.sandboxes.create(app, image, { gpu: spec.gpu ?? undefined, cpu: spec.cpu, memoryMiB: spec.memoryMiB, timeoutMs })
        await sb.filesystem.makeDirectory(WORKDIR, { createParents: true })

        const stagedIn = []
        const missingIn = []
        for (const rel of args.files_in ?? []) {
          const local = safeUnder(root, rel)
          if (!existsSync(local)) { missingIn.push(rel); continue }
          const remote = posix.join(WORKDIR, rel)
          const remoteDir = posix.dirname(remote)
          if (remoteDir && remoteDir !== WORKDIR) await sb.filesystem.makeDirectory(remoteDir, { createParents: true })
          await sb.filesystem.copyFromLocal(local, remote)
          stagedIn.push(rel)
        }

        const proc = await sb.exec(['sh', '-lc', args.command], { stdout: 'pipe', stderr: 'pipe', workdir: WORKDIR, timeoutMs })
        const [stdout, stderr] = await Promise.all([proc.stdout.readText(), proc.stderr.readText()])
        const exitCode = await proc.wait()

        const collectedOut = []
        const missingOut = []
        for (const rel of args.files_out ?? []) {
          const local = safeUnder(root, rel)
          const remote = posix.join(WORKDIR, rel)
          try {
            mkdirSync(dirname(local), { recursive: true })
            await sb.filesystem.copyToLocal(remote, local)
            collectedOut.push(rel)
          } catch {
            missingOut.push(rel)
          }
        }

        const durationMs = Date.now() - startedAt
        const costUsd = (durationMs / 3_600_000) * spec.pricePerHour
        const summary = {
          instance: spec.id,
          gpu: spec.gpu,
          exit_code: exitCode,
          duration_ms: durationMs,
          cost_usd: Number(costUsd.toFixed(4)),
          ...(stagedIn.length ? { files_in: stagedIn } : {}),
          ...(missingIn.length ? { files_in_missing: missingIn } : {}),
          files_out: collectedOut,
          ...(missingOut.length ? { files_out_missing: missingOut } : {}),
        }
        const text = `${JSON.stringify(summary, null, 2)}\n\n--- stdout ---\n${truncate(stdout) || '(empty)'}\n\n--- stderr ---\n${truncate(stderr) || '(empty)'}`
        return { ...summary, text }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return {
          error: 'modal_failure',
          instance: spec.id,
          text: `Modal run failed on instance "${spec.id}": ${msg}\nIf this is an authentication error, check MODAL_TOKEN_ID / MODAL_TOKEN_SECRET.`,
        }
      } finally {
        exec.signal?.removeEventListener('abort', onAbort)
        if (sb) await sb.terminate().catch(() => {})
        modal.close()
      }
    },
    presentCall() {
      return { card: 'generic', title: 'Modal compute', kind: 'other' }
    },
  }))
}
