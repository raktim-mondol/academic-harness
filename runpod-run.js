import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, posix } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_RUNPOD_INSTANCE_ID,
  RUNPOD_INSTANCE_IDS,
  buildRunpodCreateBody,
  resolveRunpodInstance,
} from './runpod-instances.js'
import {
  createNetworkVolume,
  createPod,
  deletePod,
  ephemeralPodName,
  listNetworkVolumes,
  listPods,
  waitForPodSsh,
} from './runpod-client.js'
import {
  makeEphemeralSshKey,
  scpDownload,
  scpUpload,
  sleep,
  sshExec,
  tarDownloadDir,
  tarUploadDir,
} from './ssh-client.js'
import { resolveEnv } from './credential-env.js'
import { resolveWorkspacePath } from './workspace-path.js'

const WORKDIR = '/workspace'
const DEFAULT_TIMEOUT_S = 600
const MAX_TIMEOUT_S = 3600
const PROVISION_TIMEOUT_S = 300
const MAX_OUTPUT_CHARS = 16000
const DEFAULT_VOLUME_SIZE_GB = 20
const TEARDOWN_ATTEMPTS = 3

/** Find an existing network volume by name, or create one. Volumes are pinned to a data center. */
async function resolveNetworkVolume(key, { volumeName, volumeSizeGb, dataCenterId }) {
  const existing = await listNetworkVolumes(key)
  const found = existing.find((v) => v.name === volumeName)
  if (found) return { id: found.id, dataCenter: found.dataCenter, created: false }
  if (!dataCenterId) {
    throw Object.assign(new Error(`No existing Runpod network volume named "${volumeName}" — pass data_center_id to create one.`), { code: 'volume_needs_data_center' })
  }
  const created = await createNetworkVolume(key, {
    name: volumeName,
    size: Math.max(Math.floor(Number(volumeSizeGb ?? DEFAULT_VOLUME_SIZE_GB)) || DEFAULT_VOLUME_SIZE_GB, 10),
    dataCenter: dataCenterId,
  })
  return { id: created.id, dataCenter: created.dataCenter ?? dataCenterId, created: true }
}

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
  return /No such file|not found|does not exist|scp failed \(1\)/i.test(msg)
}

/** Best-effort sweep for a pod whose create reply was lost mid-request. */
async function reconcileOrphanPod(key, name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const pods = await listPods(key)
    const match = pods.find((pod) => pod.name === name)
    if (match?.id) {
      await deletePod(key, match.id)
      return match.id
    }
    await sleep(2000)
  }
  return null
}

/** Register the Runpod ephemeral-pod remote-compute offload tool. */
export function applyRunpodRun(ctx) {
  ctx.tools.register(defineTool({
    name: 'runpod_run',
    description: [
      'Run a command or script on an ephemeral Runpod Pod (on-demand CPU or GPU) and get the result back.',
      'Use for heavy or GPU work that should not run locally: model training/fine-tuning, GPU inference, large simulations.',
      `Pick an instance by GPU need (one of: ${RUNPOD_INSTANCE_IDS.join(', ')}; default "${DEFAULT_RUNPOD_INSTANCE_ID}").`,
      'Upload inputs with files_in (workspace-relative; files or directories) and name expected outputs in files_out — they are copied back into the local workspace.',
      'Every call is a fresh, disposable pod by default — /workspace is wiped when it terminates. Pass volume_name to mount a persistent Runpod network volume at /workspace instead, so a dataset or checkpoints uploaded in one call are still there on the next call with the same volume_name (no need to re-upload via files_in every time). The pod is always deleted after the call either way; a named volume is not — it keeps costing storage until deleted from the Runpod console.',
      'Uses Runpod REST API v2. Requires RUNPOD_API_KEY (https://console.runpod.io/user/settings). Always terminates the pod when done.',
    ].join(' '),
    parameters: {
      command: { type: 'string', required: true, description: 'Shell command to run remotely (via bash -lc) in /workspace.' },
      instance: { type: 'string', enum: RUNPOD_INSTANCE_IDS, description: `Runpod instance id (default "${DEFAULT_RUNPOD_INSTANCE_ID}").` },
      image: { type: 'string', description: 'Docker image to run (default is instance-specific).' },
      files_in: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths (files or directories) to upload into the remote /workspace before running.' },
      files_out: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths (files or directories) to download back after the job finishes.' },
      timeout_sec: { type: 'integer', description: `Max seconds for the remote command (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}). Pod provisioning has a separate ${PROVISION_TIMEOUT_S}s cap.` },
      cloud_type: { type: 'string', enum: ['SECURE', 'COMMUNITY'], description: 'Runpod cloud tier (default COMMUNITY).' },
      volume_name: { type: 'string', description: 'Reusable name for a persistent Runpod network volume mounted at /workspace. Reuse the same name across calls to keep data between runs instead of re-uploading it. Created automatically the first time it is used (needs data_center_id).' },
      volume_size_gb: { type: 'integer', description: `Size in GB for a new volume_name volume (default ${DEFAULT_VOLUME_SIZE_GB}). Ignored when the volume already exists.` },
      data_center_id: { type: 'string', description: 'Runpod data center id to create volume_name in, if it does not already exist yet (network volumes are pinned to a data center). Ignored when the volume already exists.' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: value.text }]
      },
    },
    async execute(args, exec) {
      const signal = exec.signal
      if (signal?.aborted) return { error: 'aborted', text: 'Runpod run was cancelled before it started.' }

      const key = await resolveEnv('RUNPOD_API_KEY')
      if (!key) {
        return {
          error: 'not_configured',
          text: 'Runpod is not configured. Set RUNPOD_API_KEY (Settings -> Academic Harness API keys, or the env var — '
            + 'get one at https://console.runpod.io/user/settings).',
        }
      }

      const instanceId = args.instance ?? DEFAULT_RUNPOD_INSTANCE_ID
      const spec = resolveRunpodInstance(instanceId)
      if (!spec) {
        return { error: 'unknown_instance', text: `Unknown Runpod instance "${instanceId}". Valid instances: ${RUNPOD_INSTANCE_IDS.join(', ')}.` }
      }

      const root = workspaceRoot(exec)
      const requestedTimeout = Number(args.timeout_sec ?? DEFAULT_TIMEOUT_S)
      const timeoutSec = Math.min(Math.max(Math.floor(Number.isFinite(requestedTimeout) ? requestedTimeout : DEFAULT_TIMEOUT_S), 1), MAX_TIMEOUT_S)
      const timeoutMs = timeoutSec * 1000
      const cloudType = args.cloud_type === 'SECURE' ? 'SECURE' : 'COMMUNITY'
      const imageName = args.image?.trim() || spec.defaultImage

      let inFiles
      let outFiles
      try {
        inFiles = (args.files_in ?? []).map((rel) => ({ rel, local: resolveWorkspacePath(root, rel) }))
        outFiles = (args.files_out ?? []).map((rel) => ({ rel, local: resolveWorkspacePath(root, rel, { forWrite: true }) }))
      } catch (error) {
        return { error: 'invalid_path', text: error instanceof Error ? error.message : String(error) }
      }

      let volume = null
      if (args.volume_name) {
        try {
          volume = await resolveNetworkVolume(key, {
            volumeName: args.volume_name,
            volumeSizeGb: args.volume_size_gb,
            dataCenterId: args.data_center_id,
          })
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          return { error: 'volume_failure', text: `Runpod network volume "${args.volume_name}" could not be resolved: ${msg}` }
        }
        if (signal?.aborted) return { error: 'aborted', text: 'Runpod run was cancelled while resolving its network volume.' }
      }

      let keys = null
      let podId = null
      const startedAt = Date.now()

      // Serialized teardown: the abort listener and the finally block can both
      // fire, and a teardown that ran before create finished must be retried
      // once the pod id exists.
      let teardownChain = Promise.resolve(null)
      const terminate = () => {
        teardownChain = teardownChain.then(async () => {
          let failure = null
          if (podId) {
            for (let attempt = 0; attempt < TEARDOWN_ATTEMPTS; attempt++) {
              try {
                await deletePod(key, podId)
                podId = null
                failure = null
                break
              } catch (error) {
                const msg = error instanceof Error ? error.message : String(error)
                // Already gone is the desired end state.
                if (/→ 404\b|not found/i.test(msg)) {
                  podId = null
                  failure = null
                  break
                }
                failure = error
                if (attempt < TEARDOWN_ATTEMPTS - 1) await sleep(1500 * (attempt + 1))
              }
            }
          }
          keys?.cleanup()
          keys = null
          return failure
        })
        return teardownChain
      }
      const onAbort = () => { void terminate() }
      signal?.addEventListener('abort', onAbort, { once: true })

      let outcome = null
      let teardownError = null
      try {
        keys = makeEphemeralSshKey()

        const createBody = buildRunpodCreateBody({
          spec,
          imageName,
          publicKey: keys.publicKeyOpenSsh,
          cloudType,
          podName: ephemeralPodName(),
          volume,
        })

        let created
        try {
          created = await createPod(key, createBody)
        } catch (error) {
          const orphan = await reconcileOrphanPod(key, createBody.name).catch(() => null)
          if (orphan) {
            throw new Error(`${error instanceof Error ? error.message : String(error)} (reconciled and deleted orphaned pod ${orphan})`)
          }
          throw error
        }
        podId = created?.id ?? null
        if (!podId) throw new Error('Runpod create-pod returned no pod id')
        if (signal?.aborted) throw new Error('Aborted after pod creation')

        const provisionDeadline = Date.now() + PROVISION_TIMEOUT_S * 1000
        const { ssh } = await waitForPodSsh(key, podId, { timeoutMs: PROVISION_TIMEOUT_S * 1000, signal, requireDirect: true })

        await sshExec(keys.privateKeyPath, ssh, `mkdir -p ${WORKDIR}`, {
          timeoutMs: 60_000,
          deadlineMs: provisionDeadline,
          signal,
          retries: 15,
          retryPermissionDenied: true,
        })

        const stagedIn = []
        const missingIn = []
        for (const { rel, local } of inFiles) {
          if (!existsSync(local)) { missingIn.push(rel); continue }
          const remote = posix.join(WORKDIR, rel)
          if (statSync(local).isDirectory()) {
            await sshExec(keys.privateKeyPath, ssh, `mkdir -p ${shellQuote(posix.dirname(remote))}`, { timeoutMs: 60_000, signal })
            await tarUploadDir(keys.privateKeyPath, ssh, local, remote, signal)
            stagedIn.push(rel)
            continue
          }
          const remoteDir = posix.dirname(remote)
          if (remoteDir && remoteDir !== '.') {
            await sshExec(keys.privateKeyPath, ssh, `mkdir -p ${shellQuote(remoteDir)}`, { timeoutMs: 60_000, signal })
          }
          await scpUpload(keys.privateKeyPath, ssh, local, remote, { signal })
          stagedIn.push(rel)
        }

        const remoteCmd = `cd ${WORKDIR} && bash -lc ${shellQuote(args.command)}`
        // One attempt: a dropped connection must not silently re-run a command
        // that may already have written files or started training.
        const result = await sshExec(keys.privateKeyPath, ssh, remoteCmd, { timeoutMs, signal, retries: 1 })

        const collectedOut = []
        const missingOut = []
        const failedOut = []
        for (const { rel, local } of outFiles) {
          const remote = posix.join(WORKDIR, rel)
          let missing = false
          try {
            mkdirSync(dirname(local), { recursive: true })
            const probe = await sshExec(keys.privateKeyPath, ssh, `test -d ${shellQuote(remote)}`, { timeoutMs: 30_000, signal, retries: 1 })
            if (probe.exitCode === 0) {
              await tarDownloadDir(keys.privateKeyPath, ssh, remote, local, signal)
            } else {
              try {
                await scpDownload(keys.privateKeyPath, ssh, remote, local, { signal })
              } catch (error) {
                if (probe.exitCode === 1 && isNotFound(error)) missing = true
                else throw error
              }
            }
            if (!missing) collectedOut.push(rel)
          } catch (error) {
            if (signal?.aborted) throw error
            if (missing || isNotFound(error)) missingOut.push(rel)
            else failedOut.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }

        const durationMs = Date.now() - startedAt
        const costUsd = (durationMs / 3_600_000) * spec.pricePerHour
        const summary = {
          provider: 'runpod',
          pod_id: podId,
          instance: spec.id,
          gpu: spec.gpuTypeId ?? null,
          ...(spec.gpuTypeId ? {} : { cpu: { flavor: spec.cpuFlavorId, vcpus: spec.vcpuCount } }),
          image: imageName,
          cloud_type: cloudType,
          exit_code: result.exitCode,
          duration_ms: durationMs,
          cost_usd: Number(costUsd.toFixed(4)),
          ...(stagedIn.length ? { files_in: stagedIn } : {}),
          ...(missingIn.length ? { files_in_missing: missingIn } : {}),
          files_out: collectedOut,
          ...(missingOut.length ? { files_out_missing: missingOut } : {}),
          ...(failedOut.length ? { files_out_failed: failedOut } : {}),
          ...(volume ? { network_volume_id: volume.id, network_volume_name: args.volume_name } : {}),
        }
        const text = `${JSON.stringify(summary, null, 2)}\n\n--- stdout ---\n${truncate(result.stdout) || '(empty)'}\n\n--- stderr ---\n${truncate(result.stderr) || '(empty)'}`
        outcome = { ...summary, text }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        outcome = {
          error: 'runpod_failure',
          instance: spec.id,
          pod_id: podId,
          text: `Runpod run failed on instance "${spec.id}"${podId ? ` (pod ${podId})` : ''}: ${msg}\n`
            + 'If this is an authentication error, check RUNPOD_API_KEY. If the GPU is out of stock, try another instance or cloud_type SECURE.'
            + (volume ? ` If a volume_name is set, the chosen GPU may simply not be available in that volume's data center — try another instance, or drop volume_name for this run.` : ''),
        }
      } finally {
        signal?.removeEventListener('abort', onAbort)
        teardownError = await terminate()
      }

      if (teardownError) {
        const msg = teardownError instanceof Error ? teardownError.message : String(teardownError)
        const id = podId ?? outcome?.pod_id ?? null
        return {
          ...(outcome ?? {}),
          error: 'runpod_teardown_failed',
          teardown_error: msg,
          pod_id: id,
          text: `${outcome?.text ? `${outcome.text}\n\n` : ''}TEARDOWN FAILED: pod ${id ?? '(unknown id)'} could not be deleted after ${TEARDOWN_ATTEMPTS} attempts: ${msg}\n`
            + 'The pod may still be running and billing. Delete it from the Runpod console or with `runpodctl pod delete '
            + `${id ?? '<pod-id>'}` + '`.',
        }
      }
      return outcome
    },
    presentCall() {
      return { card: 'generic', title: 'Runpod compute', kind: 'other' }
    },
  }))
}
