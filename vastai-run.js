import { existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_VASTAI_INSTANCE_ID,
  VASTAI_INSTANCE_IDS,
  buildVastCreateBody,
  buildVastSearchBody,
  resolveVastaiInstance,
} from './vastai-instances.js'
import {
  createInstance,
  deleteSshKey,
  destroyInstance,
  listInstances,
  registerSshKey,
  resolveSshEndpoint,
  searchOffers,
  waitForInstanceSsh,
} from './vastai-client.js'
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
const PROVISION_TIMEOUT_S = 600
const MAX_OUTPUT_CHARS = 16000
const DEFAULT_DISK_GB = 40
const TEARDOWN_ATTEMPTS = 3
const KEY_ATTEMPTS = 3

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

function expandHome(p) {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

function isNotFound(error) {
  const msg = error instanceof Error ? error.message : String(error)
  return /No such file|not found|does not exist|no such instance|scp failed \(1\)/i.test(msg)
}

/** Validate a user-provided key path; the matching public key is optional. */
function userSshKey(keyPath) {
  const privateKeyPath = expandHome(keyPath)
  if (!existsSync(privateKeyPath)) throw new Error(`ssh_key_path does not exist: ${privateKeyPath}`)
  const pubPath = `${privateKeyPath}.pub`
  return { privateKeyPath, publicKeyPath: existsSync(pubPath) ? pubPath : null }
}

/** Best-effort sweep for an instance whose create reply was lost mid-request. */
async function reconcileOrphanInstance(key, label) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const instances = await listInstances(key)
    const match = instances.find((instance) => instance.label === label)
    if (match?.id != null) {
      await destroyInstance(key, match.id)
      return match.id
    }
    await sleep(2000)
  }
  return null
}

/** Register the Vast.ai marketplace remote-compute offload tool. */
export function applyVastaiRun(ctx) {
  ctx.tools.register(defineTool({
    name: 'vastai_run',
    description: [
      'Run a command or script on an ephemeral Vast.ai GPU instance and get the result back.',
      'Vast.ai is a GPU marketplace: the tool searches live offers for the requested GPU, rents the cheapest verified one, runs the command, and destroys it.',
      `Pick an instance by GPU need (one of: ${VASTAI_INSTANCE_IDS.join(', ')}; default "${DEFAULT_VASTAI_INSTANCE_ID}").`,
      'Upload inputs with files_in (workspace-relative; files or directories) and name expected outputs in files_out — they are copied back into the local workspace.',
      'Pass bid_price to rent an interruptible (spot) instance. Persistent storage needs a pre-created volume_id, mounted at /workspace. Requires VAST_API_KEY (https://cloud.vast.ai/manage-keys/). Always destroys the instance when done.',
    ].join(' '),
    parameters: {
      command: { type: 'string', required: true, description: 'Shell command to run remotely (via bash -lc) in /workspace.' },
      instance: { type: 'string', enum: VASTAI_INSTANCE_IDS, description: `Vast.ai GPU class (default "${DEFAULT_VASTAI_INSTANCE_ID}").` },
      image: { type: 'string', description: 'Docker image to run (default vastai/pytorch:@vastai-automatic-tag, which includes SSH).' },
      files_in: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths (files or directories) to upload into the remote /workspace before running.' },
      files_out: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths (files or directories) to download back after the job finishes.' },
      timeout_sec: { type: 'integer', description: `Max seconds for the remote command (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}). Provisioning has a separate ${PROVISION_TIMEOUT_S}s cap.` },
      disk_gb: { type: 'integer', description: `Local disk to allocate in GB (default ${DEFAULT_DISK_GB}).` },
      num_gpus: { type: 'integer', description: 'GPUs per instance (default 1). Offers with a different GPU count are not rented.' },
      max_price_dph: { type: 'number', description: 'Only consider offers at or below this $/hour rate.' },
      bid_price: { type: 'number', description: 'Rent an interruptible instance at this bid price in $/hour. Omit for on-demand.' },
      offer_id: { type: 'integer', description: 'Pin a specific Vast.ai offer id instead of searching (for reproducibility).' },
      volume_id: { type: 'integer', description: 'Existing Vast.ai volume id to mount at /workspace (volume must already exist).' },
      ssh_key_path: { type: 'string', description: 'Path to an SSH private key already registered with Vast.ai. Default: register a temporary per-call key automatically.' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: value.text }]
      },
    },
    async execute(args, exec) {
      const signal = exec.signal
      if (signal?.aborted) return { error: 'aborted', text: 'Vast.ai run was cancelled before it started.' }

      const key = await resolveEnv('VAST_API_KEY')
      if (!key) {
        return {
          error: 'not_configured',
          text: 'Vast.ai is not configured. Set VAST_API_KEY (Settings -> Academic Harness API keys, or the env var — '
            + 'get one at https://cloud.vast.ai/manage-keys/).',
        }
      }

      const instanceId = args.instance ?? DEFAULT_VASTAI_INSTANCE_ID
      const spec = resolveVastaiInstance(instanceId)
      if (!spec) {
        return { error: 'unknown_instance', text: `Unknown Vast.ai instance "${instanceId}". Valid instances: ${VASTAI_INSTANCE_IDS.join(', ')}.` }
      }

      const numeric = (value) => (value === undefined || value === null || value === '' ? undefined : Number(value))
      const maxPrice = numeric(args.max_price_dph)
      const bidPrice = numeric(args.bid_price)
      if (args.max_price_dph !== undefined && !Number.isFinite(maxPrice)) {
        return { error: 'invalid_argument', text: 'max_price_dph must be a number in $/hour.' }
      }
      if (args.bid_price !== undefined && !Number.isFinite(bidPrice)) {
        return { error: 'invalid_argument', text: 'bid_price must be a number in $/hour (omit it for on-demand).' }
      }
      const spot = bidPrice !== undefined

      const root = workspaceRoot(exec)
      const requestedTimeout = Number(args.timeout_sec ?? DEFAULT_TIMEOUT_S)
      const timeoutSec = Math.min(Math.max(Math.floor(Number.isFinite(requestedTimeout) ? requestedTimeout : DEFAULT_TIMEOUT_S), 1), MAX_TIMEOUT_S)
      const timeoutMs = timeoutSec * 1000
      const image = args.image?.trim() || spec.defaultImage
      const numGpus = Math.max(Math.floor(Number(args.num_gpus ?? 1)) || 1, 1)
      const diskGb = Math.max(Math.floor(Number(args.disk_gb ?? DEFAULT_DISK_GB)) || DEFAULT_DISK_GB, 10)

      let inFiles
      let outFiles
      try {
        inFiles = (args.files_in ?? []).map((rel) => ({ rel, local: resolveWorkspacePath(root, rel) }))
        outFiles = (args.files_out ?? []).map((rel) => ({ rel, local: resolveWorkspacePath(root, rel, { forWrite: true }) }))
      } catch (error) {
        return { error: 'invalid_path', text: error instanceof Error ? error.message : String(error) }
      }

      let userKey = null
      if (args.ssh_key_path) {
        try {
          userKey = userSshKey(args.ssh_key_path)
        } catch (error) {
          return { error: 'invalid_ssh_key', text: error instanceof Error ? error.message : String(error) }
        }
      }

      // Find the offer before registering anything, so a no-capacity exit
      // leaves no key or instance behind.
      let offer
      if (args.offer_id != null) {
        offer = { id: args.offer_id, dph_total: null, gpu_name: spec.gpuNames[0] }
      } else {
        try {
          const offers = await searchOffers(key, buildVastSearchBody({
            spec,
            numGpus,
            maxPricePerHour: maxPrice,
            spot,
          }))
          offer = offers[0]
        } catch (error) {
          return { error: 'vastai_failure', text: `Vast.ai offer search failed: ${error instanceof Error ? error.message : String(error)}` }
        }
        if (!offer) {
          return {
            error: 'no_offers',
            text: `No Vast.ai offers matched ${spec.label} × ${numGpus}${maxPrice ? ` under $${maxPrice}/hr` : ''}. `
              + 'Try another instance, raise max_price_dph, or check https://cloud.vast.ai/ for stock.',
          }
        }
      }

      let ephemeralKey = null
      let registeredKeyId = null
      let lastInstanceId = null
      const label = `dshrc-${Date.now().toString(36)}`
      const startedAt = Date.now()

      let teardownChain = Promise.resolve(null)
      const terminate = () => {
        teardownChain = teardownChain.then(async () => {
          let instanceFailure = null
          let keyFailure = null
          if (lastInstanceId !== null) {
            for (let attempt = 0; attempt < TEARDOWN_ATTEMPTS; attempt++) {
              try {
                await destroyInstance(key, lastInstanceId)
                lastInstanceId = null
                instanceFailure = null
                break
              } catch (error) {
                const msg = error instanceof Error ? error.message : String(error)
                if (/→ 404\b|not found|no such instance/i.test(msg)) {
                  lastInstanceId = null
                  instanceFailure = null
                  break
                }
                instanceFailure = error
                if (attempt < TEARDOWN_ATTEMPTS - 1) await sleep(2000 * (attempt + 1))
              }
            }
          }
          if (registeredKeyId !== null) {
            for (let attempt = 0; attempt < KEY_ATTEMPTS; attempt++) {
              try {
                await deleteSshKey(key, registeredKeyId)
                registeredKeyId = null
                keyFailure = null
                break
              } catch (error) {
                const msg = error instanceof Error ? error.message : String(error)
                if (/→ 404\b|not found/i.test(msg)) {
                  registeredKeyId = null
                  keyFailure = null
                  break
                }
                keyFailure = error
                if (attempt < KEY_ATTEMPTS - 1) await sleep(1000 * (attempt + 1))
              }
            }
          }
          ephemeralKey?.cleanup()
          ephemeralKey = null
          return { instanceFailure, keyFailure }
        })
        return teardownChain
      }
      const onAbort = () => { void terminate() }
      signal?.addEventListener('abort', onAbort, { once: true })

      let outcome = null
      let teardown = { instanceFailure: null, keyFailure: null }
      try {
        // SSH readiness is a Vast.ai prerequisite: keys must be registered
        // before the instance exists.
        if (!userKey) {
          ephemeralKey = makeEphemeralSshKey()
          registeredKeyId = await registerSshKey(key, ephemeralKey.publicKeyOpenSsh)
          if (signal?.aborted) throw new Error('Aborted after SSH key registration')
        }
        const sshKeyPath = userKey?.privateKeyPath ?? ephemeralKey.privateKeyPath

        const createBody = buildVastCreateBody({
          spec,
          image,
          diskGb,
          label,
          spotPrice: spot ? bidPrice : undefined,
          volumeId: args.volume_id,
        })

        let created
        try {
          created = await createInstance(key, offer.id, createBody)
        } catch (error) {
          const orphan = await reconcileOrphanInstance(key, label).catch(() => null)
          if (orphan !== null) {
            throw new Error(`${error instanceof Error ? error.message : String(error)} (reconciled and destroyed orphaned instance ${orphan})`)
          }
          throw error
        }
        lastInstanceId = created?.new_contract ?? null
        if (lastInstanceId === null) throw new Error('Vast.ai create-instance returned no new_contract instance id')
        if (signal?.aborted) throw new Error('Aborted after instance creation')

        const provisionDeadline = Date.now() + PROVISION_TIMEOUT_S * 1000
        const { info } = await waitForInstanceSsh(key, lastInstanceId, {
          timeoutMs: PROVISION_TIMEOUT_S * 1000,
          signal,
        })
        const endpoint = resolveSshEndpoint(info)
        if (!endpoint) throw new Error('Vast.ai instance is running but has no SSH endpoint yet')

        await sshExec(sshKeyPath, endpoint, `mkdir -p ${WORKDIR}`, {
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
            await sshExec(sshKeyPath, endpoint, `mkdir -p ${shellQuote(posix.dirname(remote))}`, { timeoutMs: 60_000, signal })
            await tarUploadDir(sshKeyPath, endpoint, local, remote, signal)
          } else {
            const remoteDir = posix.dirname(remote)
            if (remoteDir && remoteDir !== '.') {
              await sshExec(sshKeyPath, endpoint, `mkdir -p ${shellQuote(remoteDir)}`, { timeoutMs: 60_000, signal })
            }
            await scpUpload(sshKeyPath, endpoint, local, remote, { signal })
          }
          stagedIn.push(rel)
        }

        const remoteCmd = `cd ${WORKDIR} && bash -lc ${shellQuote(args.command)}`
        // One attempt: never silently re-run a command that may have had side effects.
        const result = await sshExec(sshKeyPath, endpoint, remoteCmd, { timeoutMs, signal, retries: 1 })

        const collectedOut = []
        const missingOut = []
        const failedOut = []
        for (const { rel, local } of outFiles) {
          const remote = posix.join(WORKDIR, rel)
          let missing = false
          try {
            mkdirSync(dirname(local), { recursive: true })
            const probe = await sshExec(sshKeyPath, endpoint, `test -d ${shellQuote(remote)}`, { timeoutMs: 30_000, signal, retries: 1 })
            if (probe.exitCode === 0) {
              await tarDownloadDir(sshKeyPath, endpoint, remote, local, signal)
            } else {
              try {
                await scpDownload(sshKeyPath, endpoint, remote, local, { signal })
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
        const dphTotal = Number(info?.dph_total ?? offer.dph_total)
        const costUsd = Number.isFinite(dphTotal) ? Number(((durationMs / 3_600_000) * dphTotal).toFixed(4)) : null
        const summary = {
          provider: 'vastai',
          instance_id: lastInstanceId,
          offer_id: offer.id,
          instance: spec.id,
          gpu: info?.gpu_name ?? offer.gpu_name ?? spec.gpuNames[0],
          num_gpus: numGpus,
          image,
          spot,
          ...(spot ? { bid_price: bidPrice } : {}),
          dph_total: Number.isFinite(dphTotal) ? dphTotal : null,
          exit_code: result.exitCode,
          duration_ms: durationMs,
          ...(costUsd !== null ? { cost_usd: costUsd } : {}),
          ...(stagedIn.length ? { files_in: stagedIn } : {}),
          ...(missingIn.length ? { files_in_missing: missingIn } : {}),
          files_out: collectedOut,
          ...(missingOut.length ? { files_out_missing: missingOut } : {}),
          ...(failedOut.length ? { files_out_failed: failedOut } : {}),
          ...(args.volume_id != null ? { volume_id: args.volume_id } : {}),
        }
        const text = `${JSON.stringify(summary, null, 2)}\n\n--- stdout ---\n${truncate(result.stdout) || '(empty)'}\n\n--- stderr ---\n${truncate(result.stderr) || '(empty)'}`
        outcome = { ...summary, text }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        outcome = {
          error: 'vastai_failure',
          instance: spec.id,
          instance_id: lastInstanceId,
          text: `Vast.ai run failed on instance "${spec.id}"${lastInstanceId !== null ? ` (instance ${lastInstanceId})` : ''}: ${msg}\n`
            + 'If this is an authentication error, check VAST_API_KEY. If the host was unreachable, retry (the marketplace has variable hosts) or raise max_price_dph.',
        }
      } finally {
        signal?.removeEventListener('abort', onAbort)
        teardown = await terminate()
      }

      if (teardown.instanceFailure) {
        const msg = teardown.instanceFailure instanceof Error ? teardown.instanceFailure.message : String(teardown.instanceFailure)
        const id = lastInstanceId ?? outcome?.instance_id ?? null
        return {
          ...(outcome ?? {}),
          error: 'vastai_teardown_failed',
          teardown_error: msg,
          instance_id: id,
          text: `${outcome?.text ? `${outcome.text}\n\n` : ''}TEARDOWN FAILED: instance ${id ?? '(unknown id)'} could not be destroyed after ${TEARDOWN_ATTEMPTS} attempts: ${msg}\n`
            + 'The instance may still be billing. Destroy it with `vastai destroy instance '
            + `${id ?? '<instance-id>'}` + ' -y` or from https://cloud.vast.ai/instances/.',
        }
      }
      if (teardown.keyFailure) {
        const msg = teardown.keyFailure instanceof Error ? teardown.keyFailure.message : String(teardown.keyFailure)
        return {
          ...(outcome ?? {}),
          error: 'vastai_ssh_key_cleanup_failed',
          teardown_error: msg,
          text: `${outcome?.text ? `${outcome.text}\n\n` : ''}The instance is gone, but the temporary Vast.ai SSH key could not be removed: ${msg}\n`
            + 'Remove it with `vastai delete ssh-key <id>` or from https://cloud.vast.ai/manage-keys/.',
        }
      }
      return outcome
    },
    presentCall() {
      return { card: 'generic', title: 'Vast.ai compute', kind: 'other' }
    },
  }))
}
