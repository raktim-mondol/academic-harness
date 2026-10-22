/**
 * Cancelable, no-timeout zg indexer with progress published into Settings
 * (the working client↔host channel). Session-start auto-index and the native
 * zvec_index tool both go through here so the UI can show one progress bar
 * and Cancel control regardless of who started the job.
 *
 * There is no INDEX timeout: a large workspace may take hours. The user (or
 * exec.signal) can cancel at any time.
 */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import {
  cliArgs,
  cliCommand,
  DEFAULT_EMBEDDING,
  isAutoIndexOn,
  LOG,
  run,
  shouldIndexRoot,
  zgEnv,
} from './zvec-grep-cli.js'
import { getKeysScope } from './settings-keys.js'
import { resolveEnv } from './credential-env.js'
import { mergeExcludes } from './zg-excludes.js'

export const INDEX_STATE_FIELD = 'ZVEC_GREP_INDEX_STATE'
export const INDEX_CANCEL_FIELD = 'ZVEC_GREP_INDEX_CANCEL'

const jobs = new Map()
let watchingCancel = false
let publishTimer = null
let pendingPublish = null
let lastPublished = ''

function idleSnapshot() {
  return { status: 'idle' }
}

export function parseIndexState(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return idleSnapshot()
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && typeof parsed.status === 'string') return parsed
  } catch {
    /* ignore */
  }
  return idleSnapshot()
}

export function snapshotFromSettings() {
  return parseIndexState(getKeysScope()?.get()?.[INDEX_STATE_FIELD])
}

function serializeJob(job) {
  if (!job) return JSON.stringify(idleSnapshot())
  const { current, total } = job
  const percent = (typeof current === 'number' && typeof total === 'number' && total > 0)
    ? Math.min(100, Math.max(0, Math.round((current / total) * 100)))
    : (typeof job.percent === 'number' ? job.percent : null)
  return JSON.stringify({
    status: job.status,
    root: job.root,
    phase: job.phase,
    line: job.line,
    current: current ?? null,
    total: total ?? null,
    percent,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
    embedding: job.embedding,
    error: job.error ?? null,
  })
}

async function flushPublish() {
  publishTimer = null
  const json = pendingPublish
  pendingPublish = null
  if (json == null || json === lastPublished) return
  const scope = getKeysScope()
  if (!scope) return
  lastPublished = json
  try {
    const parsed = parseIndexState(json)
    if (parsed.status === 'idle') {
      await scope.update({ [INDEX_STATE_FIELD]: '', [INDEX_CANCEL_FIELD]: '' })
    } else {
      await scope.update({ [INDEX_STATE_FIELD]: json })
    }
  } catch (err) {
    console.warn(`${LOG}: failed to publish index progress: ${err instanceof Error ? err.message : err}`)
  }
}

function publishJob(job, { immediate = false } = {}) {
  pendingPublish = serializeJob(job)
  if (immediate) {
    if (publishTimer) {
      clearTimeout(publishTimer)
      publishTimer = null
    }
    void flushPublish()
    return
  }
  if (publishTimer) return
  publishTimer = setTimeout(() => { void flushPublish() }, 400)
}

export function ensureCancelWatch() {
  if (watchingCancel) return
  const scope = getKeysScope()
  if (!scope) return
  watchingCancel = true
  scope.watch((next, prev) => {
    const token = String(next?.[INDEX_CANCEL_FIELD] || '').trim()
    const prevToken = String(prev?.[INDEX_CANCEL_FIELD] || '').trim()
    if (!token || token === prevToken) return
    cancelIndex(token === '1' ? undefined : token)
    void scope.update({ [INDEX_CANCEL_FIELD]: '' }).catch(() => {})
  })
}

/** Drop a "running" snapshot left behind by a previous DSH process. */
export function resetStaleIndexState() {
  const current = snapshotFromSettings()
  if (current.status === 'running' || current.status === 'cancelling') {
    lastPublished = ''
    publishJob(null, { immediate: true })
  }
}

export function getIndexJob(root) {
  if (!root) return undefined
  return jobs.get(resolve(root))
}

export function listIndexJobs() {
  return [...jobs.values()].map((job) => parseIndexState(serializeJob(job)))
}

export async function waitForIndex(root, signal) {
  if (!root) return idleSnapshot()
  const job = jobs.get(resolve(root))
  if (!job) return idleSnapshot()
  if (!signal) return job.promise
  if (signal.aborted) return job.snapshot()
  return Promise.race([
    job.promise,
    new Promise((resolvePromise) => {
      signal.addEventListener('abort', () => resolvePromise(job.snapshot()), { once: true })
    }),
  ])
}

export function cancelIndex(root) {
  let found = false
  if (typeof root === 'string' && root.length > 0 && root !== '1') {
    const job = jobs.get(resolve(root))
    if (job) {
      job.cancel('user')
      found = true
    }
  } else {
    for (const job of jobs.values()) {
      job.cancel('user')
      found = true
    }
  }
  if (!found) {
    // Dismiss a stale running snapshot (child already gone / previous process).
    publishJob(null, { immediate: true })
  }
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

export function stripAnsi(text) {
  return String(text).replace(ANSI_RE, '')
}

function parseCount(raw) {
  const n = Number(String(raw).replace(/,/g, ''))
  return Number.isFinite(n) ? n : undefined
}

/**
 * Parse zg CLI / `zg status` progress text into counts. Handles TTY `\r`
 * lines, "Indexing files: N/M", download percentages, and status Coverage.
 */
export function parseProgressText(chunk, prev = {}) {
  const next = { ...prev }
  const text = stripAnsi(chunk).replace(/\r/g, '\n')
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/[█░]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (!line) continue

    const coverage = line.match(/(\d{1,3})\s*%\s+([\d,]+)\s*\/\s*([\d,]+)\s+files/i)
    if (coverage) {
      next.phase = 'indexing'
      next.percent = Number(coverage[1])
      next.current = parseCount(coverage[2])
      next.total = parseCount(coverage[3])
      next.line = `Indexing files: ${coverage[2]}/${coverage[3]}`
      continue
    }

    const files = line.match(/Indexing files:\s*([\d,]+)\s*\/\s*([\d,]+)/i)
    if (files) {
      next.phase = 'indexing'
      next.current = parseCount(files[1])
      next.total = parseCount(files[2])
      next.line = `Indexing files: ${files[1]}/${files[2]}`
      continue
    }

    const filesBare = line.match(/Indexing files\s+(\d{1,3})\s*%\s+([\d,]+)\s*\/\s*([\d,]+)/i)
    if (filesBare) {
      next.phase = 'indexing'
      next.percent = Number(filesBare[1])
      next.current = parseCount(filesBare[2])
      next.total = parseCount(filesBare[3])
      next.line = `Indexing files: ${filesBare[2]}/${filesBare[3]}`
      continue
    }

    const dlPct = line.match(/Downloading\s+(\S+)(?:\s*[·•-]\s*)(\d{1,3})\s*%(?:\s*[·•-]\s*)([\d.]+\s*[KMGT]?i?B)\s*\/\s*([\d.]+\s*[KMGT]?i?B)/i)
    if (dlPct) {
      next.phase = 'downloading'
      next.percent = Number(dlPct[2])
      next.line = `Downloading ${dlPct[1]} · ${dlPct[2]}% · ${dlPct[3]}/${dlPct[4]}`
      continue
    }

    const dlBytes = line.match(/Downloading\s+(\S+)(?:\s*[·•-]\s*)([\d.]+\s*[KMGT]?i?B)\b/i)
    if (dlBytes) {
      next.phase = 'downloading'
      next.line = `Downloading ${dlBytes[1]} · ${dlBytes[2]}`
      continue
    }

    if (/^Preparing\s+\S+/i.test(line)) {
      next.phase = 'downloading'
      next.line = line
      continue
    }
    if (/Scanning workspace/i.test(line)) {
      next.phase = 'scanning'
      next.line = line
      continue
    }
    if (/Indexing complete|Workspace index is ready/i.test(line)) {
      next.phase = 'done'
      next.percent = 100
      next.line = 'Indexing complete'
      continue
    }
    if (/Workspace index is updating/i.test(line)) {
      next.phase = next.phase === 'downloading' ? 'downloading' : 'indexing'
      if (!next.line) next.line = 'Indexing workspace…'
    }
  }
  return next
}

export async function checkIndexReady(root, launch, embedding) {
  if (!shouldIndexRoot(root) || !launch) return false
  const status = await run(cliCommand(launch), cliArgs(launch, ['status', '--check-ready']), {
    cwd: root,
    timeoutMs: 60_000,
    env: zgEnv(embedding || DEFAULT_EMBEDDING),
    silent: true,
  })
  return status.code === 0
}

/** Map `zg status` heading to zg's workspace-index state. */
export function parseWorkspaceIndexState(out) {
  const text = stripAnsi(String(out || ''))
  if (/Workspace index is ready/i.test(text)) return 'ready'
  if (/Workspace index is updating/i.test(text)) return 'indexing'
  if (/needs an update/i.test(text)) return 'stale'
  if (/index failed/i.test(text)) return 'failed'
  if (/update was cancelled/i.test(text)) return 'cancelled'
  if (/indexing is disabled/i.test(text)) return 'disabled'
  if (/is not created/i.test(text)) return 'unindexed'
  if (/is not configured/i.test(text)) return 'undecided'
  return 'unknown'
}

function isSearchableState(state) {
  return state === 'ready' || state === 'stale' || state === 'indexing'
}

function killIndexer(child) {
  if (!child?.pid) return
  try { child.kill('SIGINT') } catch { /* ignore */ }
  setTimeout(() => { try { child.kill('SIGTERM') } catch { /* ignore */ } }, 1500)
  setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, 4000)
}

function createJob({ root, launch, embedding, globs = [] }) {
  const job = {
    root,
    launch,
    embedding,
    globs,
    status: 'running',
    phase: 'starting',
    line: 'Starting workspace index…',
    current: null,
    total: null,
    percent: null,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    child: null,
    cancelRequested: false,
    cancelReason: null,
    snapshot() {
      return parseIndexState(serializeJob(job))
    },
    cancel(reason) {
      if (job.status !== 'running' && job.status !== 'cancelling') return
      job.cancelRequested = true
      job.cancelReason = reason || 'user'
      job.status = 'cancelling'
      job.line = 'Cancelling workspace index…'
      publishJob(job, { immediate: true })
      killIndexer(job.child)
    },
  }

  job.promise = (async () => {
    ensureCancelWatch()
    publishJob(job, { immediate: true })
    console.warn(`${LOG}: indexing ${root} with ${embedding} (no timeout; cancel from Settings or the progress bar)`)
    if (globs.length) console.warn(`${LOG}: index exclusions for ${root}: ${globs.join(' ')}`)

    const env = zgEnv(embedding)
    const command = cliCommand(launch)
    const args = cliArgs(launch, ['index', '--embedding', embedding, ...globs.flatMap((glob) => ['-g', glob])])
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    job.child = child

    const applyParsed = (parsed) => {
      if (parsed.phase) job.phase = parsed.phase
      if (parsed.line) job.line = parsed.line
      if (parsed.current != null) job.current = parsed.current
      if (parsed.total != null) job.total = parsed.total
      if (parsed.percent != null) job.percent = parsed.percent
      publishJob(job)
    }

    const onChunk = (buf) => {
      const text = buf.toString()
      process.stderr.write(text)
      applyParsed(parseProgressText(text, job))
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)

    let statusInFlight = false
    const poll = setInterval(() => {
      if (statusInFlight || job.status !== 'running') return
      statusInFlight = true
      void run(cliCommand(launch), cliArgs(launch, ['status']), {
        cwd: root,
        timeoutMs: 20_000,
        env,
        silent: true,
      }).then((result) => {
        applyParsed(parseProgressText(result.out, job))
      }).catch(() => {}).finally(() => {
        statusInFlight = false
      })
    }, 1500)

    const code = await new Promise((resolvePromise) => {
      child.on('close', (c) => resolvePromise(c ?? 1))
      child.on('error', (err) => {
        job.error = err.message
        resolvePromise(1)
      })
    })
    clearInterval(poll)
    job.child = null
    job.finishedAt = Date.now()

    if (job.cancelRequested) {
      job.status = 'cancelled'
      job.phase = 'done'
      job.line = 'Indexing cancelled'
      job.error = null
      console.warn(`${LOG}: index cancelled for ${root}`)
    } else if (code === 0) {
      job.status = 'ready'
      job.phase = 'done'
      job.percent = 100
      job.line = 'Indexing complete'
      job.error = null
      console.warn(`${LOG}: index ready for ${root}`)
    } else {
      job.status = 'failed'
      job.phase = 'done'
      job.error = job.error || `zg index exited ${code}`
      job.line = job.error
      console.warn(`${LOG}: index failed for ${root} (exit ${code})`)
    }
    publishJob(job, { immediate: true })
    if (job.status === 'ready' || job.status === 'cancelled') {
      setTimeout(() => {
        if (jobs.get(root) === job) return
        const live = snapshotFromSettings()
        if (live.root === root && (live.status === 'ready' || live.status === 'cancelled')) {
          publishJob(null, { immediate: true })
        }
      }, 12_000)
    }
    return job.snapshot()
  })().finally(() => {
    jobs.delete(root)
  })

  return job
}

/**
 * Start (or join) an index of `root`. No timeout.
 * @param {object} opts
 * @param {string} opts.root
 * @param {object} opts.launch
 * @param {string} [opts.embedding]
 * @param {string[]} [opts.globs] extra zg -g exclusions; PaperMemory runtime paths are added automatically
 * @param {AbortSignal} [opts.signal]
 * @param {boolean} [opts.wait=true]
 * @param {boolean} [opts.skipIfReady=false] session-start only: do nothing when already indexed
 */
export async function startIndex(opts) {
  const root = typeof opts.root === 'string' ? resolve(opts.root) : ''
  const launch = opts.launch
  const embedding = opts.embedding || DEFAULT_EMBEDDING
  if (!launch) return { status: 'failed', error: 'zg CLI is not installed' }
  if (!shouldIndexRoot(root)) {
    return { status: 'failed', root, error: 'Refusing to index home directory or /' }
  }
  const globs = mergeExcludes(root, opts.globs || [])
  ensureCancelWatch()

  // Jobs are keyed by root: a running job is joined with its original globs.
  const existing = jobs.get(root)
  if (existing) {
    if (opts.signal?.aborted) existing.cancel('signal')
    else if (opts.signal) {
      opts.signal.addEventListener('abort', () => existing.cancel('signal'), { once: true })
    }
    return opts.wait === false ? existing.snapshot() : existing.promise
  }

  if (opts.skipIfReady && await checkIndexReady(root, launch, embedding)) {
    return { status: 'ready', root, skipped: true, embedding }
  }

  const job = createJob({ root, launch, embedding, globs })
  jobs.set(root, job)
  if (opts.signal?.aborted) job.cancel('signal')
  else if (opts.signal) {
    opts.signal.addEventListener('abort', () => job.cancel('signal'), { once: true })
  }
  return opts.wait === false ? job.snapshot() : job.promise
}

export async function indexStatus(root, launch) {
  const embedding = (await resolveEnv('ZVEC_GREP_EMBEDDING')) || DEFAULT_EMBEDDING
  const autoIndex = isAutoIndexOn(await resolveEnv('ZVEC_GREP_AUTO_INDEX'))
  const abs = typeof root === 'string' && root.length > 0 ? resolve(root) : null
  const live = abs ? jobs.get(abs)?.snapshot() : listIndexJobs()[0]
  let workspaceState = 'unknown'
  let parsed = {}
  if (abs && launch) {
    const result = await run(cliCommand(launch), cliArgs(launch, ['status']), {
      cwd: abs,
      timeoutMs: 60_000,
      env: zgEnv(embedding),
      silent: true,
    })
    workspaceState = parseWorkspaceIndexState(result.out)
    parsed = parseProgressText(result.out)
  }
  const searchable = isSearchableState(workspaceState)
  return {
    status: live?.status || workspaceState,
    ready: searchable,
    fresh: workspaceState === 'ready',
    workspace_state: workspaceState,
    auto_index: autoIndex,
    root: abs,
    embedding,
    job: live ?? null,
    line: live?.line ?? parsed.line ?? null,
    percent: live?.percent ?? parsed.percent ?? null,
    current: live?.current ?? parsed.current ?? null,
    total: live?.total ?? parsed.total ?? null,
  }
}

