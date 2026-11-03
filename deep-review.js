/**
 * deep_review: stateful wrapper around the vendored Open Deep Review engine
 * (vendor/open-deepreview, Google Deep Review recreation).
 *
 * Runs the engine under Node, persists its review/citation artifacts under
 * `<cwd>/.dsh/deep-review/<key>/`, and returns compact summaries so a full
 * report never lands in the model context by accident. `show` reads the rest
 * back from disk. The engine is stateless upstream; state lives here.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { run } from './academic-harness-cli.js'
import { withLock, writeJsonAtomic } from './store-lock.js'
import { resolveWorkspacePath } from './workspace-path.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const VENDOR_DIR = join(HERE, 'vendor', 'open-deepreview')
const RUNNER = join(VENDOR_DIR, 'runner.mjs')
const REGISTER = join(VENDOR_DIR, 'register.mjs')
const VENDOR_COMMIT = 'c48e29450134d7a41559a73112962377f9602bce'

const ACTIONS = ['review', 'estimate', 'pdf2md', 'verify_citations', 'status', 'show', 'compare', 'list']
const SECTIONS = ['summary', 'comments', 'questions', 'checklist', 'claims', 'citations', 'markdown', 'rounds']
const TOPOLOGIES = ['LOW', 'MID', 'HIGH', 'EXTRA_HIGH']
const THINKING_LEVELS = ['LOW', 'MEDIUM', 'HIGH']
const SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR', 'SUGGESTION', 'SEVERITY_UNSPECIFIED']
const SEVERITY_RANK = { CRITICAL: 0, MAJOR: 1, MINOR: 2, SUGGESTION: 3, SEVERITY_UNSPECIFIED: 4 }
/**
 * Rounds are meta.schemaVersion 2. Version 1 stored one review per manuscript
 * and let the next run overwrite it, which made a revision's effect unmeasurable.
 */
const META_SCHEMA_VERSION = 2
const ROUNDS_DIR = 'rounds'
const ROUND_COMMENT_CAP = 200
const ROUND_CLAIM_CAP = 200
const ROUND_QUESTION_CAP = 60
const COMPARE_LIST_CAP = 25
const COMPARE_CLIP = 220
const CLEAN_CITATION_VERDICTS = ['OK', 'SKIPPED', 'VERIFIED_BY_SEARCH']
const CLAIM_STATUS_RANK = { UNSUPPORTED: 0, OVERCLAIMED: 1, PARTIALLY_SUPPORTED: 2, SUPPORTED: 3 }
/**
 * Wording-similarity floor for pairing a reworded finding across rounds. The
 * engine re-issues comment ids per run, so exact wording alone splits a
 * rephrased criticism into one closed and one opened finding.
 */
const FUZZY_MIN_JACCARD = 0.6
const ALLOWED_ENV = [
  'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR', 'SHELL',
]
const MAX_INPUT_BYTES = 50 * 1024 * 1024
const MAX_FOCUS_CHARS = 4000
const DEFAULT_TIMEOUTS = { review: 30, verify_citations: 30, estimate: 5, pdf2md: 5 }
const ARTIFACTS = {
  review_json: 'review.json',
  review_markdown: 'review.md',
  paper_markdown: 'paper.md',
  pdf_meta: 'pdf-meta.json',
  citations: 'citations.json',
  estimate: 'estimate.json',
}

function workspaceRoot(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function clip(value, max) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function sha1(value) {
  return createHash('sha1').update(value).digest('hex')
}

/**
 * Key on the workspace-relative path, not on the content hash: `status` must
 * be able to find the stored record after the manuscript is edited. The
 * content hash lives in meta.input.sha1 and drives the stale flag.
 */
function docKey(relPath) {
  return sha1(relPath).slice(0, 16)
}

function storePaths(cwd, key) {
  const dir = join(cwd, '.dsh', 'deep-review', key)
  return {
    dir,
    dirRel: relative(cwd, dir),
    meta: join(dir, 'meta.json'),
    runs: join(dir, 'runs.jsonl'),
    roundsDir: join(dir, ROUNDS_DIR),
    reviewJson: join(dir, ARTIFACTS.review_json),
    reviewMarkdown: join(dir, ARTIFACTS.review_markdown),
    paperMarkdown: join(dir, ARTIFACTS.paper_markdown),
    pdfMeta: join(dir, ARTIFACTS.pdf_meta),
    citations: join(dir, ARTIFACTS.citations),
    estimate: join(dir, ARTIFACTS.estimate),
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readMeta(dir) {
  const meta = readJsonFile(join(dir, 'meta.json'))
  return meta && typeof meta === 'object' ? meta : null
}

function artifactIndex(dir, cwd) {
  const out = {}
  for (const [name, file] of Object.entries(ARTIFACTS)) {
    const path = join(dir, file)
    out[name] = existsSync(path) ? { path: relative(cwd, path), bytes: statSync(path).size } : null
  }
  return out
}

function nodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return { major, minor }
}

function supportsRegisterHooks() {
  const { major, minor } = nodeVersion()
  return major > 22 || (major === 22 && minor >= 15)
}

function resolveEngine() {
  const custom = String(process.env.DEEPREVIEW_ENGINE || '').trim()
  if (custom) {
    return { command: process.execPath, args: [resolvePath(custom)] }
  }
  let real = VENDOR_DIR
  try {
    real = realpathSync(VENDOR_DIR)
  } catch {
    // keep the unresolved path; the spawn error names the missing vendored tree
  }
  const underNodeModules = real.includes(`${sep}node_modules${sep}`)
  const native = process.features?.typescript === 'strip' && !underNodeModules
  if (native) return { command: process.execPath, args: [RUNNER] }
  if (!supportsRegisterHooks()) {
    throw new Error(
      `deep_review needs Node >= 22.15 when the plugin is installed under node_modules `
      + `(running ${process.version}; Node refuses to strip TypeScript inside node_modules).`,
    )
  }
  return {
    command: process.execPath,
    args: ['--disable-warning=ExperimentalWarning', '--import', REGISTER, RUNNER],
  }
}

function engineConfigPath() {
  // Outside the workspace on purpose: a committed config file could otherwise
  // point the engine at an attacker's base URL.
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'deep-review', 'engine-config.json')
}

/** The provider/model route of the calling agent, falling back to its creation options. */
function sessionRoute(exec) {
  let requestConfig
  try {
    requestConfig = exec?.agent?.session?.requestHeader?.()?.config
  } catch {
    requestConfig = undefined
  }
  const options = exec?.agent?.options && typeof exec.agent.options === 'object' ? exec.agent.options : {}
  const provider = requestConfig?.provider || options.provider
  const model = requestConfig?.model || options.model
  if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) {
    throw new Error(
      'deep_review could not resolve the session model route. Run it from an agent session with a selected model.',
    )
  }
  return { provider, model }
}

function buildEngineEnv(bridge, model) {
  const env = {}
  for (const key of ALLOWED_ENV) {
    if (process.env[key] != null) env[key] = process.env[key]
  }
  env.DEEPREVIEW_CONFIG_PATH = engineConfigPath()
  if (bridge) {
    env.DEEPREVIEW_BASE_URL = bridge.baseUrl
    env.DEEPREVIEW_API_KEY = bridge.token
    env.DEEPREVIEW_MODEL = model || 'dsh-session-model'
  }
  return env
}

function sessionModelName(exec) {
  try {
    return sessionRoute(exec).model
  } catch {
    return 'dsh-session-model'
  }
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    if (typeof part === 'string') return part
    return typeof part?.text === 'string' ? part.text : ''
  }).join('')
}

function toLlmMessages(messages) {
  const system = []
  const request = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = contentText(message?.content)
    if (!text) continue
    const role = message?.role
    if (role === 'system' || role === 'developer') system.push(text)
    else if (role === 'assistant') {
      request.push({ role: 'user', content: [{ type: 'text', text: `Previous assistant message:\n${text}` }] })
    } else {
      request.push({ role: 'user', content: [{ type: 'text', text }] })
    }
  }
  if (request.length === 0) request.push({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] })
  return { system: system.join('\n\n') || undefined, messages: request }
}

function bridgeFailure(reason) {
  if (!reason) return null
  if (reason.kind === 'error' || reason.kind === 'aborted') return reason.failure || { message: reason.kind }
  return null
}

/**
 * OpenAI Chat Completions front end for the vendored engine. Every engine call
 * is forwarded to the host `llm` service on the calling agent's provider/model,
 * so Deep Review runs on the session model with no separate key or endpoint.
 * Bound to loopback and guarded by a per-run bearer token.
 */
export async function startLlmBridge(ctx, exec, onEvent) {
  if (!ctx?.llm || typeof ctx.llm.stream !== 'function') {
    throw new Error('deep_review needs the host llm service, which is not available in this session.')
  }
  const token = randomUUID()
  let calls = 0
  const notify = (event) => {
    try {
      onEvent?.(event)
    } catch {
      // progress reporting must never break a model call
    }
  }
  const server = createServer(async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.method !== 'POST') return send(405, { error: { message: 'method not allowed' } })
    if (String(req.headers.authorization || '') !== `Bearer ${token}`) {
      return send(401, { error: { message: 'unauthorized' } })
    }
    let body
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return send(400, { error: { message: 'invalid JSON body' } })
    }

    const controller = new AbortController()
    const abort = () => controller.abort()
    res.on('close', abort)
    if (exec?.signal) {
      if (exec.signal.aborted) abort()
      else exec.signal.addEventListener('abort', abort, { once: true })
    }

    const call = ++calls
    try {
      const route = sessionRoute(exec)
      notify({ type: 'request', call, provider: route.provider, model: route.model })
      const started = Date.now()
      const { system, messages } = toLlmMessages(body?.messages)
      const maxTokens = [body?.max_completion_tokens, body?.max_tokens]
        .find((value) => Number.isFinite(value))
      let text = ''
      let usage = null
      let reason = null
      for await (const chunk of ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        system,
        messages,
        ...(Number.isFinite(body?.temperature) ? { temperature: body.temperature } : {}),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        signal: controller.signal,
      })) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (chunk?.type === 'usage') usage = chunk.usage
        else if (chunk?.type === 'finish') reason = chunk.reason
      }
      const failure = bridgeFailure(reason)
      if (failure) {
        const message = failure.message || failure.code || 'model request failed'
        notify({ type: 'error', call, message })
        return send(502, { error: { message } })
      }
      const mappedUsage = usage
        ? {
            prompt_tokens: usage.inputTokens ?? 0,
            completion_tokens: usage.outputTokens ?? 0,
            total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
          }
        : undefined
      notify({ type: 'response', call, durationMs: Date.now() - started, usage: mappedUsage })
      send(200, {
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: route.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: reason?.kind === 'max-tokens' ? 'length' : 'stop',
        }],
        ...(mappedUsage ? { usage: mappedUsage } : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (controller.signal.aborted) {
        notify({ type: 'error', call, message: 'model request aborted' })
        return send(499, { error: { message: 'model request aborted' } })
      }
      notify({ type: 'error', call, message })
      send(502, { error: { message } })
    } finally {
      res.off?.('close', abort)
      exec?.signal?.removeEventListener?.('abort', abort)
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    token,
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function redact(text, secret) {
  const value = String(text ?? '')
  if (!secret) return value
  return value.split(secret).join('[redacted]')
}

function resolveInput(cwd, rel) {
  if (typeof rel !== 'string' || rel.trim() === '') throw new Error('path is required (workspace-relative)')
  let abs
  try {
    abs = resolveWorkspacePath(cwd, rel)
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
  let stat
  try {
    stat = statSync(abs)
  } catch {
    throw new Error(`file not found: ${rel}`)
  }
  if (!stat.isFile()) throw new Error(`not a file: ${rel}`)
  if (stat.size > MAX_INPUT_BYTES) throw new Error(`file is larger than 50 MB: ${rel}`)
  // resolveWorkspacePath returns a realpath-based path; relative() must use the
  // real workspace root or a symlinked cwd produces "../..." paths and keys.
  let rootReal = cwd
  try {
    rootReal = realpathSync(cwd)
  } catch {
    // keep the unresolved root; resolveWorkspacePath already checked containment
  }
  const relPath = relative(rootReal, abs)
  const sha = sha1(readFileSync(abs))
  return {
    abs,
    rel: relPath,
    fileName: basename(abs),
    sizeBytes: stat.size,
    sha1: sha,
    key: docKey(relPath),
    format: extname(abs).slice(1).toLowerCase(),
  }
}

function requireActionPath(action, args) {
  if (typeof args.path !== 'string' || args.path.trim() === '') {
    throw new Error(`path is required (workspace-relative) for action "${action}"`)
  }
}

function normalizeEnums(args) {
  const topology = args.topology ? String(args.topology).toUpperCase() : ''
  if (topology && !TOPOLOGIES.includes(topology)) {
    throw new Error(`topology must be one of ${TOPOLOGIES.join(', ')}`)
  }
  const thinking = args.thinking_level ? String(args.thinking_level).toUpperCase() : ''
  if (thinking && !THINKING_LEVELS.includes(thinking)) {
    throw new Error(`thinking_level must be one of ${THINKING_LEVELS.join(', ')}`)
  }
  return { topology, thinking }
}

function timeoutMinutesFor(action, value) {
  if (value == null) return DEFAULT_TIMEOUTS[action] ?? 30
  const minutes = Number(value)
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) {
    throw new Error('timeout_minutes must be between 1 and 120')
  }
  return minutes
}

function parseJsonOutput(stdout, action, secret) {
  const text = redact(String(stdout ?? ''), secret).trim()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`could not parse ${action} JSON output: ${clip(text, 400) || '(empty stdout)'}`)
  }
}

async function runEngine(action, engineArgs, { cwd, timeoutMinutes, signal, env, apiKey, onStderr }) {
  const launch = resolveEngine()
  const timeoutMs = Math.round(timeoutMinutes * 60_000)
  const result = await run(launch.command, [...launch.args, ...engineArgs], {
    cwd,
    timeoutMs,
    signal,
    silent: true,
    env,
    onStderr,
  })
  const stderr = redact(result.err, apiKey).trim()
  if (result.code === 124) {
    // run() resolves as soon as SIGTERM is sent; make sure a process that
    // ignores SIGTERM cannot keep billing after the recorded failure.
    try {
      if (result.pid) process.kill(result.pid, 'SIGKILL')
    } catch {
      // already gone
    }
    throw new Error(`deep review ${action} timed out after ${timeoutMinutes} minutes`)
  }
  if (result.code !== 0) {
    const tail = clip(stderr.slice(-1200), 1200)
    throw new Error(`deep review engine exited with code ${result.code}${tail ? `: ${tail}` : ''}`)
  }
  return { stdout: redact(result.out, apiKey), stderr }
}

/** Stream engine stderr and bridge call events into the session's job panel. */
function makeProgressSink(job) {
  if (!job) return { onStderr() {}, onEvent() {}, flush() {}, usage: () => null }
  let buffer = ''
  const tally = { calls: 0, prompt_tokens: 0, completion_tokens: 0 }
  const emit = (line) => {
    if (!line) return
    job.append(`${line}\n`, { channel: 'stderr' })
    const match = /^\[\s*(\d+)%\]\s*\[([^\]]+)\]\s*(.*)$/.exec(line)
    if (match) {
      const detail = clip(match[3], 140)
      job.updateProgress(`${match[1]}% ${match[2]}${detail ? ` — ${detail}` : ''}`)
    }
  }
  return {
    onStderr(text) {
      buffer += text
      const parts = buffer.split(/\r\n|\r|\n/)
      buffer = parts.pop() ?? ''
      for (const line of parts) emit(line)
    },
    onEvent(event) {
      if (!event) return
      if (event.type === 'request') {
        job.append(`[bridge] call ${event.call} → ${event.provider}/${event.model}\n`, { channel: 'log' })
        job.updateProgress(`model call ${event.call} (${event.model})…`)
      } else if (event.type === 'response') {
        const usage = event.usage
          ? ` · ${event.usage.prompt_tokens} in / ${event.usage.completion_tokens} out tokens`
          : ''
        tally.calls += 1
        tally.prompt_tokens += Number(event.usage?.prompt_tokens) || 0
        tally.completion_tokens += Number(event.usage?.completion_tokens) || 0
        job.append(`[bridge] call ${event.call} done in ${event.durationMs} ms${usage}\n`, { channel: 'log' })
      } else if (event.type === 'error') {
        job.append(`[bridge] call ${event.call} failed: ${clip(event.message, 300)}\n`, { channel: 'log' })
      }
    },
    usage() {
      return tally.calls ? { ...tally } : null
    },
    flush() {
      if (buffer) {
        emit(buffer)
        buffer = ''
      }
    },
  }
}

/**
 * Run long work as an owned background job so the Web UI's jobs panel can
 * stream progress while the tool call waits. The tool still returns the work's
 * value at settlement; the job id is added for the user to expand afterwards.
 */
async function runAsJob(ctx, exec, { kind, label, timeoutMs }, work) {
  const jobs = ctx?.jobs
  if (!jobs) return work(null, exec?.signal)
  const owner = exec?.agent?.id
  const controller = new AbortController()
  const onAbort = () => controller.abort('tool call aborted')
  if (exec?.signal?.aborted) controller.abort('tool call aborted')
  else exec?.signal?.addEventListener?.('abort', onAbort, { once: true })

  let resolveResult
  let rejectResult
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  resultPromise.catch(() => {})
  let settleOutcome
  const done = new Promise((resolve) => {
    settleOutcome = resolve
  })

  let jobId
  try {
    jobId = jobs.start({
      kind,
      label,
      ...(owner ? { owner } : {}),
      toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
      run: (job) => {
        void (async () => {
          let outcome
          try {
            const value = await work(job, controller.signal)
            resolveResult(value)
            outcome = { status: 'completed', detail: 'completed', result: JSON.stringify(value) }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            rejectResult(error)
            outcome = { status: controller.signal.aborted ? 'killed' : 'failed', detail: message }
          } finally {
            exec?.signal?.removeEventListener?.('abort', onAbort)
            settleOutcome(outcome)
          }
        })()
        return {
          done,
          cancel: (reason) => controller.abort(reason || 'cancelled'),
        }
      },
    })
  } catch (error) {
    exec?.signal?.removeEventListener?.('abort', onAbort)
    throw error
  }

  try {
    let view
    try {
      view = await jobs.wait(jobId, timeoutMs, owner, exec?.signal)
    } catch (error) {
      try { jobs.kill(jobId, owner, 'tool call aborted') } catch { /* already settled */ }
      throw error
    }
    if (view.status === 'running' || view.status === 'stopping') {
      try { jobs.kill(jobId, owner, 'deep review timed out') } catch { /* already settled */ }
      try { await jobs.wait(jobId, 10_000, owner) } catch { /* already gone */ }
      throw new Error(`deep review timed out after ${Math.round(timeoutMs / 60_000)} minutes`)
    }
    if (view.status === 'killed') {
      throw new Error(`deep review cancelled${view.detail ? `: ${view.detail}` : ''}`)
    }
    const value = await resultPromise
    return { ...value, job_id: jobId }
  } finally {
    exec?.signal?.removeEventListener?.('abort', onAbort)
  }
}

function locationText(location) {
  const pdf = location?.pdf
  if (pdf && Number.isFinite(Number(pdf.pageNumber))) return `page ${pdf.pageNumber}`
  const text = location?.text
  if (text && Number.isFinite(Number(text.firstLine))) {
    return text.lastLine && text.lastLine !== text.firstLine
      ? `lines ${text.firstLine}-${text.lastLine}`
      : `line ${text.firstLine}`
  }
  return ''
}

function quoteText(location) {
  return clip(location?.pdf?.quoteSelector?.exact || location?.text?.quotedLinePreview || '', 300)
}

function countBy(items, pick) {
  const counts = {}
  for (const item of items) {
    const key = pick(item) || 'UNSPECIFIED'
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function reviewIds(review) {
  const match = /documents\/([^/]+)\/reviews\/([^/]+)/.exec(String(review?.name || ''))
  return match ? { documentId: match[1], reviewId: match[2] } : { documentId: null, reviewId: null }
}

function summarizeReview(review = {}) {
  const result = review?.result && typeof review.result === 'object' ? review.result : {}
  const comments = Array.isArray(result.anchoredComments) ? result.anchoredComments : []
  const checklist = Array.isArray(result.reproducibilityChecklist) ? result.reproducibilityChecklist : []
  const claims = Array.isArray(result.claimEvidenceMap) ? result.claimEvidenceMap : []
  const questions = Array.isArray(result.questionsForAuthors) ? result.questionsForAuthors : []
  const audit = result.reviewQualityAudit && typeof result.reviewQualityAudit === 'object'
    ? result.reviewQualityAudit
    : null
  const citationComments = comments.filter((comment) => comment?.citationReport)

  const top = [...comments]
    .sort((a, b) => (SEVERITY_RANK[a?.severity] ?? 9) - (SEVERITY_RANK[b?.severity] ?? 9))
    .slice(0, 8)
    .map((comment) => ({
      severity: comment?.severity || 'SEVERITY_UNSPECIFIED',
      summary: clip(comment?.summary || '', 300),
      location: locationText(comment?.location),
    }))
  const ids = reviewIds(review)

  return {
    document_id: ids.documentId,
    review_id: ids.reviewId,
    state: review?.state || 'STATE_UNSPECIFIED',
    contribution_type: result.contributionType || null,
    comments: {
      total: comments.length,
      by_severity: countBy(comments, (comment) => comment?.severity),
      top,
    },
    questions: questions.length,
    checklist: {
      total: checklist.length,
      by_status: countBy(checklist, (item) => item?.status),
    },
    claims: {
      total: claims.length,
      by_status: countBy(claims, (claim) => claim?.status),
    },
    flagged_citations: {
      total: citationComments.length,
      by_verdict: countBy(citationComments, (comment) => comment?.citationReport?.finalVerdict),
    },
    quality: audit
      ? {
          actionability_score_pct: audit.actionabilityScorePct ?? null,
          depth_score: audit.depthScoreNormalized ?? null,
          factual_accuracy_score: audit.factualAccuracyScore ?? null,
          principles_passed: Object.values(audit.principlesPassed ?? {}).filter(Boolean).length,
        }
      : null,
    error: result.error ? clip(result.error.message || JSON.stringify(result.error), 500) : null,
  }
}

/**
 * Findings move between rounds without stable identities — the engine assigns
 * comment ids per run — so `compare` matches on id, then normalized summary,
 * then the quoted span, and reports which rule matched.
 */
export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

function commentMatchKeys(comment) {
  const keys = []
  const id = String(comment?.commentId ?? '').trim()
  if (id) keys.push(`id:${id}`)
  const summary = normalizeText(comment?.summary)
  if (summary) keys.push(`summary:${summary}`)
  const quote = normalizeText(quoteText(comment?.location))
  if (quote) keys.push(`quote:${quote}`)
  return keys
}

function listValue(list) {
  return Array.isArray(list) ? list : []
}

function reviewDigest(review, bits = {}) {
  const result = review?.result && typeof review.result === 'object' ? review.result : {}
  const allComments = listValue(result.anchoredComments)
  const allQuestions = listValue(result.questionsForAuthors)
  const checklist = listValue(result.reproducibilityChecklist).map((item) => ({
    key: item?.key ?? null,
    label: item?.label ?? null,
    status: item?.status ?? null,
  }))
  const claims = listValue(result.claimEvidenceMap).slice(0, ROUND_CLAIM_CAP).map((claim) => ({
    claim_id: claim?.claimId ?? null,
    claim: clip(claim?.claim || '', 400),
    status: claim?.status ?? null,
    evidence_type: claim?.evidenceType ?? null,
    keys: [`claim:${normalizeText(claim?.claim)}`].filter((key) => key !== 'claim:'),
  }))
  return {
    run_id: bits.run_id ?? null,
    started_at: bits.started_at ?? null,
    finished_at: bits.finished_at ?? null,
    duration_ms: bits.duration_ms ?? null,
    state: bits.state ?? null,
    input_sha1: bits.input_sha1 ?? null,
    input_path: bits.input_path ?? null,
    params: bits.params ?? null,
    model: bits.model ?? null,
    usage: bits.usage ?? null,
    contribution_type: result.contributionType ?? null,
    markdown: bits.markdown ?? null,
    counts: {
      comments: allComments.length,
      by_severity: countBy(allComments, (comment) => comment?.severity),
      questions: allQuestions.length,
      checklist_by_status: countBy(checklist, (item) => item?.status),
      claims_by_status: countBy(claims, (claim) => claim?.status),
      flagged_citations: allComments.filter((comment) => comment?.citationReport).length,
    },
    comments: allComments.slice(0, ROUND_COMMENT_CAP).map((comment) => ({
      comment_id: comment?.commentId ?? null,
      severity: comment?.severity ?? 'SEVERITY_UNSPECIFIED',
      summary: clip(comment?.summary || '', 500),
      location: locationText(comment?.location),
      quote: clip(quoteText(comment?.location) || '', 200),
      keys: commentMatchKeys(comment),
      citation_ref: comment?.citationReport?.refNum ?? null,
      citation_verdict: comment?.citationReport?.finalVerdict ?? null,
    })),
    checklist,
    claims,
    questions: allQuestions.slice(0, ROUND_QUESTION_CAP).map((question) => ({
      number: question?.questionNumber ?? null,
      question: clip(question?.question || '', COMPARE_CLIP),
      keys: [`question:${normalizeText(question?.question)}`].filter((key) => key !== 'question:'),
    })),
  }
}

function roundIndexEntry(detail, extra = {}) {
  return {
    round: extra.round ?? null,
    run_id: detail.run_id,
    started_at: detail.started_at,
    finished_at: detail.finished_at,
    duration_ms: detail.duration_ms,
    state: detail.state,
    input_sha1: detail.input_sha1,
    input_path: detail.input_path,
    params: detail.params,
    model: detail.model,
    usage: detail.usage,
    contribution_type: detail.contribution_type,
    counts: detail.counts,
    artifacts: extra.artifacts ?? {},
  }
}

function roundRel(paths, runId, extension) {
  return `${paths.dirRel}/${ROUNDS_DIR}/${runId}${extension}`
}

/**
 * A store written before rounds existed holds exactly one review in
 * `review.json`. Digest it as round 1 so the next review adds a round instead
 * of destroying the only record the workspace has.
 */
function priorRoundDigest(paths, meta) {
  if (!meta?.review || !existsSync(paths.reviewJson)) return null
  const review = readJsonFile(paths.reviewJson)
  if (!review) return null
  const stamp = `${meta.review?.finished_at ?? meta.last_run?.finished_at ?? ''}|${meta.input?.sha1 ?? ''}`
  return reviewDigest(review, {
    run_id: meta.last_run?.run_id || `legacy-${sha1(stamp).slice(0, 12)}`,
    started_at: meta.last_run?.started_at ?? null,
    finished_at: meta.review?.finished_at ?? meta.last_run?.finished_at ?? null,
    duration_ms: meta.last_run?.duration_ms ?? null,
    state: meta.last_run?.state ?? 'SUCCEEDED',
    input_sha1: meta.input?.sha1 ?? null,
    input_path: meta.input?.path ?? null,
    params: meta.review?.params ?? meta.params ?? null,
  })
}

function materializePriorRound(paths, meta) {
  const detail = priorRoundDigest(paths, meta)
  if (!detail) return null
  const files = { [`${ROUNDS_DIR}/${detail.run_id}.json`]: detail }
  const artifacts = { json: roundRel(paths, detail.run_id, '.json') }
  if (existsSync(paths.reviewMarkdown)) {
    try {
      const markdown = readFileSync(paths.reviewMarkdown, 'utf8')
      files[`${ROUNDS_DIR}/${detail.run_id}.md`] = markdown
      detail.markdown = roundRel(paths, detail.run_id, '.md')
      artifacts.markdown = detail.markdown
    } catch {
      // the digest is what compare needs; a report copy is a convenience
    }
  }
  return { entry: roundIndexEntry(detail, { round: 1, artifacts }), files }
}

function storedRounds(paths, meta) {
  if (Array.isArray(meta?.rounds) && meta.rounds.length) {
    return meta.rounds.filter(Boolean).map((entry, index) => ({ ...entry, round: entry.round ?? index + 1 }))
  }
  const detail = priorRoundDigest(paths, meta)
  return detail ? [roundIndexEntry(detail, { round: 1 })] : []
}

function roundDetail(paths, meta, entry) {
  if (!entry?.run_id) return null
  const file = join(paths.roundsDir, `${entry.run_id}.json`)
  if (existsSync(file)) return readJsonFile(file)
  const prior = priorRoundDigest(paths, meta)
  return prior && prior.run_id === entry.run_id ? prior : null
}

function tokenSet(text) {
  return new Set(String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean))
}

function jaccardTokens(a, b) {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const token of b) if (a.has(token)) shared += 1
  const union = a.size + b.size - shared
  return union ? shared / union : 0
}

/** The wording an item was found by, taken from its non-id match keys. */
function fuzzyText(item) {
  return (item?.keys || [])
    .filter((key) => /^(summary|claim|question):/.test(key))
    .map((key) => key.slice(key.indexOf(':') + 1))
    .join(' ')
}

/**
 * Greedy layered match: exact keys first (id, wording, quoted span, and the
 * claim/question equivalents), then a wording-similarity pass over what is
 * left. Each side is used once, and every pair records which rule made it.
 * Exported so the calibration harness measures the same thing `compare` does.
 */
export function matchPool(fromItems, toItems) {
  const remaining = fromItems.map((item) => ({ item, keys: item?.keys || [] }))
  const pairs = []
  let opened = []
  // The exact tiers start at zero so a reader can see that, e.g., id matching
  // never fired rather than wondering whether it was skipped.
  const byRule = { id: 0, summary: 0, quote: 0 }
  for (const target of toItems) {
    const keys = target?.keys || []
    let hit = null
    let rule = null
    for (const prefix of ['id:', 'summary:', 'quote:', 'claim:', 'question:']) {
      const want = keys.filter((key) => key.startsWith(prefix))
      if (!want.length) continue
      const index = remaining.findIndex((slot) => slot.keys.some((key) => want.includes(key)))
      if (index >= 0) {
        hit = index
        rule = prefix.slice(0, -1)
        break
      }
    }
    if (hit == null) {
      opened.push(target)
      continue
    }
    byRule[rule] = (byRule[rule] ?? 0) + 1
    pairs.push({ from: remaining[hit].item, to: target, matched_by: rule })
    remaining.splice(hit, 1)
  }

  if (opened.length && remaining.length) {
    const candidates = opened
    const scored = []
    for (const [ti, target] of candidates.entries()) {
      const tokens = tokenSet(fuzzyText(target))
      if (!tokens.size) continue
      for (const [ri, slot] of remaining.entries()) {
        const score = jaccardTokens(tokens, tokenSet(fuzzyText(slot.item)))
        if (score >= FUZZY_MIN_JACCARD) scored.push({ ti, ri, score })
      }
    }
    scored.sort((a, b) => b.score - a.score || a.ti - b.ti || a.ri - b.ri)
    const usedTarget = new Set()
    const usedSource = new Set()
    for (const match of scored) {
      if (usedTarget.has(match.ti) || usedSource.has(match.ri)) continue
      usedTarget.add(match.ti)
      usedSource.add(match.ri)
      byRule.similar = (byRule.similar ?? 0) + 1
      pairs.push({
        from: remaining[match.ri].item,
        to: candidates[match.ti],
        matched_by: 'similar',
        score: Number(match.score.toFixed(2)),
      })
    }
    opened = candidates.filter((_item, index) => !usedTarget.has(index))
    return { pairs, opened, closed: remaining.filter((_slot, index) => !usedSource.has(index)).map((slot) => slot.item), byRule }
  }

  return { pairs, opened, closed: remaining.map((slot) => slot.item), byRule }
}

function compareDigests(from, to) {
  const brief = (item) => ({
    severity: item.severity ?? null,
    summary: clip(item.summary || '', COMPARE_CLIP),
    location: item.location || null,
  })
  const commentMatch = matchPool(from?.comments || [], to?.comments || [])
  const persisting = commentMatch.pairs.map((pair) => ({
    ...brief(pair.to),
    from_severity: pair.from.severity ?? null,
    matched_by: pair.matched_by,
    score: pair.score ?? null,
    changed: (pair.from.severity ?? null) !== (pair.to.severity ?? null),
  }))
  const severityMoved = persisting.filter((item) => item.changed)

  const claimMatch = matchPool(from?.claims || [], to?.claims || [])
  const claimRank = (status) => CLAIM_STATUS_RANK[status] ?? -1
  const claimsMoved = claimMatch.pairs
    .filter((pair) => claimRank(pair.to.status) !== claimRank(pair.from.status))
    .map((pair) => ({
      claim: clip(pair.to.claim || '', COMPARE_CLIP),
      from_status: pair.from.status ?? null,
      to_status: pair.to.status ?? null,
      improved: claimRank(pair.to.status) > claimRank(pair.from.status),
    }))

  const questionMatch = matchPool(from?.questions || [], to?.questions || [])

  const citationsById = (digest) => {
    const map = new Map()
    for (const comment of digest?.comments || []) {
      if (comment?.citation_verdict == null) continue
      map.set(String(comment.citation_ref ?? comment.citation_verdict), {
        ref: comment.citation_ref ?? null,
        verdict: comment.citation_verdict,
        reference: comment.summary || '',
      })
    }
    return map
  }
  const fromCitations = citationsById(from)
  const toCitations = citationsById(to)
  const citationDelta = { fixed: [], still_flagged: [], newly_flagged: [] }
  for (const [id, entry] of fromCitations) {
    const next = toCitations.get(id)
    if (next && CLEAN_CITATION_VERDICTS.includes(next.verdict)) continue
    if (!next || CLEAN_CITATION_VERDICTS.includes(next.verdict)) {
      citationDelta.fixed.push({ ref_num: entry.ref ?? id, from_verdict: entry.verdict, to_verdict: next?.verdict ?? 'removed' })
      continue
    }
    citationDelta.still_flagged.push({ ref_num: entry.ref ?? id, verdict: next.verdict })
  }
  for (const [id, entry] of toCitations) {
    if (fromCitations.has(id) || CLEAN_CITATION_VERDICTS.includes(entry.verdict)) continue
    citationDelta.newly_flagged.push({ ref_num: entry.ref ?? id, verdict: entry.verdict })
  }

  const checklistBy = (digest) => new Map((digest?.checklist || []).map((item) => [String(item.key), item]))
  const fromChecklist = checklistBy(from)
  const toChecklist = checklistBy(to)
  const checklistDelta = [...new Set([...fromChecklist.keys(), ...toChecklist.keys()])].map((key) => {
    const before = fromChecklist.get(key)
    const after = toChecklist.get(key)
    return {
      key,
      label: after?.label ?? before?.label ?? null,
      from_status: before?.status ?? null,
      to_status: after?.status ?? null,
      changed: (before?.status ?? null) !== (after?.status ?? null),
    }
  })

  return {
    comments: {
      total_from: from?.comments?.length ?? 0,
      total_to: to?.comments?.length ?? 0,
      closed_total: commentMatch.closed.length,
      opened_total: commentMatch.opened.length,
      persisting_total: commentMatch.pairs.length,
      severity_changed: severityMoved.length,
      matched_by: commentMatch.byRule,
      closed: commentMatch.closed.slice(0, COMPARE_LIST_CAP).map(brief),
      opened: commentMatch.opened.slice(0, COMPARE_LIST_CAP).map(brief),
      moved: persisting.filter((item) => item.changed).slice(0, COMPARE_LIST_CAP),
    },
    claims: {
      by_status_from: from?.counts?.claims_by_status ?? {},
      by_status_to: to?.counts?.claims_by_status ?? {},
      resolved_total: claimMatch.closed.length,
      raised_total: claimMatch.opened.length,
      changed: claimsMoved.slice(0, COMPARE_LIST_CAP),
    },
    questions: {
      total_from: from?.questions?.length ?? 0,
      total_to: to?.questions?.length ?? 0,
      dropped_total: questionMatch.closed.length,
      added_total: questionMatch.opened.length,
      dropped: questionMatch.closed.slice(0, COMPARE_LIST_CAP).map((item) => item.question),
      added: questionMatch.opened.slice(0, COMPARE_LIST_CAP).map((item) => item.question),
    },
    checklist: {
      changed_total: checklistDelta.filter((item) => item.changed).length,
      transitions: checklistDelta.filter((item) => item.changed).slice(0, 12),
      statuses_from: from?.counts?.checklist_by_status ?? {},
      statuses_to: to?.counts?.checklist_by_status ?? {},
    },
    citations: {
      flagged_from: from?.counts?.flagged_citations ?? 0,
      flagged_to: to?.counts?.flagged_citations ?? 0,
      fixed_total: citationDelta.fixed.length,
      still_flagged_total: citationDelta.still_flagged.length,
      newly_flagged_total: citationDelta.newly_flagged.length,
      fixed: citationDelta.fixed.slice(0, 12),
      still_flagged: citationDelta.still_flagged.slice(0, 12),
      newly_flagged: citationDelta.newly_flagged.slice(0, 12),
    },
    usage: {
      from: from?.usage ?? null,
      to: to?.usage ?? null,
      duration_ms_from: from?.duration_ms ?? null,
      duration_ms_to: to?.duration_ms ?? null,
    },
  }
}

function engineInfo(exec) {
  let route = null
  try {
    route = sessionRoute(exec)
  } catch {
    route = null
  }
  return {
    vendor_commit: VENDOR_COMMIT,
    node_version: process.versions.node,
    route: route ? 'session-model' : 'unknown',
    provider: route?.provider ?? null,
    model: route?.model ?? null,
  }
}

function baseMeta(input, params, exec) {
  return {
    schemaVersion: META_SCHEMA_VERSION,
    key: input.key,
    input: {
      path: input.rel,
      file_name: input.fileName,
      size_bytes: input.sizeBytes,
      sha1: input.sha1,
      format: input.format,
    },
    engine: engineInfo(exec),
    params,
    last_run: null,
    summary: null,
    artifacts: {},
    rounds: [],
    latest_round: null,
  }
}

function mergeMeta(previous, input, params, exec) {
  const stored = previous && (previous.schemaVersion === 1 || previous.schemaVersion === 2)
  const meta = stored ? previous : baseMeta(input, params, exec)
  meta.schemaVersion = META_SCHEMA_VERSION
  meta.key = input.key
  meta.input = {
    path: input.rel,
    file_name: input.fileName,
    size_bytes: input.sizeBytes,
    sha1: input.sha1,
    format: input.format,
  }
  meta.engine = engineInfo(exec)
  meta.params = params
  if (!Array.isArray(meta.rounds)) meta.rounds = []
  return meta
}

async function persistArtifacts(cwd, paths, files, buildMeta) {
  mkdirSync(paths.dir, { recursive: true })
  mkdirSync(paths.roundsDir, { recursive: true })
  let meta
  await withLock(paths.dir, async () => {
    for (const [name, content] of Object.entries(files)) {
      if (content == null) continue
      const target = join(paths.dir, name)
      if (name.endsWith('.json') && typeof content !== 'string') writeJsonAtomic(target, content)
      else writeFileSync(target, String(content), 'utf8')
    }
    // Re-read inside the lock: a run can take minutes, and another action may
    // have written meta in the meantime.
    meta = buildMeta(readMeta(paths.dir))
    meta.artifacts = artifactIndex(paths.dir, cwd)
    writeJsonAtomic(paths.meta, meta)
    appendFileSync(paths.runs, `${JSON.stringify(meta.last_run)}\n`)
  }, { label: 'deep-review store' })
  return meta
}

function reviewStale(meta, input) {
  const reviewedSha = meta?.review?.sha1 ?? (meta?.summary ? meta?.input?.sha1 : null)
  if (!reviewedSha) return null
  return reviewedSha !== input.sha1
}

function runRecord(action, startedAt, extra = {}) {
  const finishedAt = new Date().toISOString()
  return {
    action,
    run_id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    exit_code: 0,
    state: 'SUCCEEDED',
    review_id: null,
    document_id: null,
    error: null,
    ...extra,
  }
}

function moneyUsd(money) {
  if (!money) return null
  const units = Number(money.units ?? 0)
  const nanos = Number(money.nanos ?? 0)
  const total = units + nanos / 1e9
  if (!Number.isFinite(total)) return null
  const symbol = !money.currencyCode || money.currencyCode === 'USD' ? '$' : `${money.currencyCode} `
  return `${symbol}${total.toFixed(2)}`
}

function parseEstimate(raw) {
  return {
    low_cost: raw?.lowCost ?? null,
    median_cost: raw?.medianCost ?? null,
    high_cost: raw?.highCost ?? null,
    formatted: {
      low: moneyUsd(raw?.lowCost),
      median: moneyUsd(raw?.medianCost),
      high: moneyUsd(raw?.highCost),
    },
  }
}

async function actionReview(args, exec, cwd, input, ctx) {
  const { topology, thinking } = normalizeEnums(args)
  const startedAt = new Date().toISOString()
  const focus = args.focus == null ? '' : String(args.focus).trim()
  if (focus.length > MAX_FOCUS_CHARS) {
    throw new Error(`focus is limited to ${MAX_FOCUS_CHARS} characters`)
  }
  const timeoutMinutes = timeoutMinutesFor('review', args.timeout_minutes)
  const paths = storePaths(cwd, input.key)
  mkdirSync(paths.dir, { recursive: true })

  // The engine writes this outside the store lock; a unique name keeps a slow
  // review from racing pdf2md's or another run's paper.md write.
  const tmpPaper = join(paths.dir, `paper.${randomUUID().slice(0, 8)}.tmp.md`)
  const engineArgs = ['review', input.abs, '--json']
  if (topology) engineArgs.push('--topology', topology)
  if (thinking) engineArgs.push('--thinking-level', thinking)
  if (focus) engineArgs.push('--prompt', focus)
  if (args.citations === false) engineArgs.push('--no-citations')
  if (args.scholar_peer === false) engineArgs.push('--no-scholar-peer')
  if (input.format === 'pdf') engineArgs.push('--save-markdown', tmpPaper)

  const params = {
    topology: topology || null,
    thinking_level: thinking || null,
    focus: focus || null,
    citations: args.citations !== false,
    scholar_peer: args.scholar_peer !== false,
  }
  const label = `Deep review: ${input.fileName}${topology ? ` (${topology})` : ''}`
  return runAsJob(ctx, exec, {
    kind: 'deep-review',
    label,
    timeoutMs: timeoutMinutes * 60_000 + 60_000,
  }, async (job, signal) => {
    const progress = makeProgressSink(job)
    const bridge = await startLlmBridge(ctx, exec, progress.onEvent)
    const env = buildEngineEnv(bridge, sessionModelName(exec))

    let result
    try {
      result = await runEngine('review', engineArgs, {
        cwd,
        timeoutMinutes,
        signal,
        env,
        apiKey: bridge.token,
        onStderr: progress.onStderr,
      })
    } catch (error) {
      progress.flush()
      await bridge.close().catch(() => {})
      rmSync(tmpPaper, { force: true })
      await persistArtifacts(cwd, paths, {}, (current) => {
        const meta = mergeMeta(current, input, params, exec)
        meta.last_run = runRecord('review', startedAt, {
          exit_code: 1,
          state: 'FAILED',
          error: clip(error instanceof Error ? error.message : String(error), 1200),
        })
        return meta
      })
      throw error
    }
    progress.flush()
    await bridge.close().catch(() => {})

    let review
    try {
      review = parseJsonOutput(result.stdout, 'review', bridge.token)
    } catch (error) {
      rmSync(tmpPaper, { force: true })
      throw error
    }
    const summary = summarizeReview(review)
    const ids = reviewIds(review)
    let paperMarkdown = null
    if (input.format === 'pdf') {
      try {
        paperMarkdown = readFileSync(tmpPaper, 'utf8')
      } catch {
        // the review is still valid even if the engine skipped the parsed Markdown
      }
      rmSync(tmpPaper, { force: true })
    }

    const run = runRecord('review', startedAt, {
      review_id: ids.reviewId,
      document_id: ids.documentId,
      state: review?.state || 'SUCCEEDED',
      error: summary.error,
    })
    const markdownText = typeof review?.result?.reviewMarkdown === 'string' ? review.result.reviewMarkdown : null
    const files = { [ARTIFACTS.review_json]: review }
    if (markdownText != null) files[ARTIFACTS.review_markdown] = markdownText
    if (paperMarkdown != null) files[ARTIFACTS.paper_markdown] = paperMarkdown

    const detail = reviewDigest(review, {
      run_id: run.run_id,
      started_at: startedAt,
      finished_at: run.finished_at,
      duration_ms: run.duration_ms,
      state: run.state,
      input_sha1: input.sha1,
      input_path: input.rel,
      params,
      model: sessionModelName(exec) || null,
      usage: progress.usage(),
    })
    files[`${ROUNDS_DIR}/${run.run_id}.json`] = detail
    if (markdownText != null) files[`${ROUNDS_DIR}/${run.run_id}.md`] = markdownText

    // Read before the write: a store from before rounds holds one review, and
    // this run is about to overwrite it.
    const prior = materializePriorRound(paths, readMeta(paths.dir))

    const meta = await persistArtifacts(cwd, paths, { ...prior?.files, ...files }, (current) => {
      const next = mergeMeta(current, input, params, exec)
      next.last_run = run
      next.summary = summary
      next.review = {
        sha1: input.sha1,
        review_id: ids.reviewId,
        document_id: ids.documentId,
        finished_at: run.finished_at,
        params: { ...params },
      }
      const seeded = next.rounds.length ? next.rounds.filter(Boolean) : (prior ? [prior.entry] : [])
      const round = seeded.reduce((max, entry) => Math.max(max, Number(entry.round) || 0), 0) + 1
      const artifacts = { json: roundRel(paths, run.run_id, '.json') }
      if (markdownText != null) artifacts.markdown = roundRel(paths, run.run_id, '.md')
      next.rounds = [...seeded, roundIndexEntry(detail, { round, artifacts })]
      next.latest_round = round
      return next
    })

    const entry = meta.rounds[meta.rounds.length - 1]
    return {
      action: 'review',
      key: input.key,
      dir: paths.dirRel,
      ...summary,
      round: entry?.round ?? null,
      rounds: meta.rounds.length,
      seeded_prior_round: prior ? prior.entry.round : null,
      usage: detail.usage,
      provider: meta.engine.provider,
      model: meta.engine.model,
      topology: params.topology,
      thinking_level: params.thinking_level,
      duration_ms: meta.last_run.duration_ms,
      artifacts: {
        review: meta.artifacts.review_json?.path ?? null,
        markdown: meta.artifacts.review_markdown?.path ?? null,
        paper: meta.artifacts.paper_markdown?.path ?? null,
        round: entry?.artifacts ?? null,
      },
      engine_stderr_tail: result.stderr ? clip(result.stderr.slice(-600), 600) : null,
    }
  })
}

async function actionEstimate(args, exec, cwd, input) {
  const { topology, thinking } = normalizeEnums(args)
  const startedAt = new Date().toISOString()
  const timeoutMinutes = timeoutMinutesFor('estimate', args.timeout_minutes)
  const paths = storePaths(cwd, input.key)
  mkdirSync(paths.dir, { recursive: true })

  const engineArgs = ['estimate-cost', input.abs, '--json']
  if (topology) engineArgs.push('--topology', topology)
  if (thinking) engineArgs.push('--thinking-level', thinking)

  const params = {
    topology: topology || null,
    thinking_level: thinking || null,
  }
  const env = buildEngineEnv(null)
  const result = await runEngine('estimate-cost', engineArgs, {
    cwd,
    timeoutMinutes,
    signal: exec?.signal,
    env,
  })
  const raw = parseJsonOutput(result.stdout, 'estimate-cost')
  const estimate = parseEstimate(raw)

  const meta = await persistArtifacts(cwd, paths, { [ARTIFACTS.estimate]: raw }, (current) => {
    const next = mergeMeta(current, input, params, exec)
    next.last_run = runRecord('estimate', startedAt)
    return next
  })

  return {
    action: 'estimate',
    key: input.key,
    dir: paths.dirRel,
    ...estimate,
    provider: meta.engine.provider,
    model: meta.engine.model,
    topology: params.topology,
    thinking_level: params.thinking_level,
    duration_ms: meta.last_run.duration_ms,
    stored: relative(cwd, paths.estimate),
  }
}

async function actionPdf2md(args, exec, cwd, input) {
  if (input.format !== 'pdf') throw new Error(`pdf2md needs a PDF, got .${input.format || 'unknown'}`)
  const startedAt = new Date().toISOString()
  const timeoutMinutes = timeoutMinutesFor('pdf2md', args.timeout_minutes)
  const paths = storePaths(cwd, input.key)
  mkdirSync(paths.dir, { recursive: true })

  const env = buildEngineEnv(null)
  const result = await runEngine('pdf2md', ['pdf2md', input.abs, '--json'], {
    cwd,
    timeoutMinutes,
    signal: exec?.signal,
    env,
  })
  const parsed = parseJsonOutput(result.stdout, 'pdf2md')
  if (typeof parsed?.markdown !== 'string') {
    throw new Error('deep review engine returned no Markdown for pdf2md')
  }
  const markdown = parsed.markdown
  const pages = Array.isArray(parsed?.pages) ? parsed.pages : []
  const pagesNeedingOcr = Array.isArray(parsed?.pagesNeedingOcr)
    ? parsed.pagesNeedingOcr
    : pages.filter((page) => page?.needsOcr).map((page) => page?.pageNumber).filter((page) => page != null)
  const pdfMeta = {
    filename: parsed?.filename ?? input.fileName,
    pdf_type: parsed?.pdfType ?? null,
    page_count: parsed?.pageCount ?? null,
    confidence: parsed?.confidence ?? null,
    processing_time_ms: parsed?.processingTimeMs ?? null,
    is_complex_layout: parsed?.isComplexLayout ?? null,
    pages_with_tables: parsed?.pagesWithTables ?? [],
    pages_with_columns: parsed?.pagesWithColumns ?? [],
    pages_needing_ocr: pagesNeedingOcr,
    pages: pages.map((page) => ({
      page_number: page?.pageNumber ?? null,
      needs_ocr: page?.needsOcr ?? false,
      ocr_reason: page?.ocrReason ?? null,
    })),
  }

  const meta = await persistArtifacts(cwd, paths, {
    [ARTIFACTS.paper_markdown]: markdown,
    [ARTIFACTS.pdf_meta]: pdfMeta,
  }, (current) => {
    const next = mergeMeta(current, input, {}, exec)
    next.last_run = runRecord('pdf2md', startedAt)
    return next
  })

  return {
    action: 'pdf2md',
    key: input.key,
    dir: paths.dirRel,
    pdf_type: pdfMeta.pdf_type,
    page_count: pdfMeta.page_count,
    confidence: pdfMeta.confidence,
    pages_needing_ocr: pdfMeta.pages_needing_ocr.length,
    duration_ms: meta.last_run.duration_ms,
    stored: {
      paper: relative(cwd, paths.paperMarkdown),
      metadata: relative(cwd, paths.pdfMeta),
    },
  }
}

function summarizeCitationReports(list) {
  return {
    total: list.length,
    by_verdict: countBy(list, (report) => report?.finalVerdict),
    flagged: list
      .filter((report) => !['OK', 'SKIPPED', 'VERIFIED_BY_SEARCH'].includes(report?.finalVerdict))
      .slice(0, 10)
      .map((report) => ({
        ref_num: report?.refNum ?? null,
        verdict: report?.finalVerdict ?? 'VERDICT_UNSPECIFIED',
        reference: clip(report?.rawReference || '', 300),
        mismatches: Array.isArray(report?.fieldComparisons)
          ? report.fieldComparisons.filter((field) => !field?.match).map((field) => field?.fieldKey).slice(0, 6)
          : [],
      })),
  }
}

async function actionVerifyCitations(args, exec, cwd, input, ctx) {
  const startedAt = new Date().toISOString()
  const timeoutMinutes = timeoutMinutesFor('verify_citations', args.timeout_minutes)
  const paths = storePaths(cwd, input.key)
  mkdirSync(paths.dir, { recursive: true })

  const bridge = await startLlmBridge(ctx, exec)
  const env = buildEngineEnv(bridge, sessionModelName(exec))
  let result
  try {
    result = await runEngine('verify-citations', ['verify-citations', input.abs, '--json'], {
      cwd,
      timeoutMinutes,
      signal: exec?.signal,
      env,
      apiKey: bridge.token,
    })
  } catch (error) {
    await bridge.close().catch(() => {})
    throw error
  }
  await bridge.close().catch(() => {})
  const reports = parseJsonOutput(result.stdout, 'verify-citations', bridge.token)
  if (!Array.isArray(reports)) throw new Error('deep review engine returned no citation report array')

  const meta = await persistArtifacts(cwd, paths, { [ARTIFACTS.citations]: reports }, (current) => {
    const next = mergeMeta(current, input, {}, exec)
    next.last_run = runRecord('verify_citations', startedAt)
    return next
  })

  return {
    action: 'verify_citations',
    key: input.key,
    dir: paths.dirRel,
    ...summarizeCitationReports(reports),
    provider: meta.engine.provider,
    model: meta.engine.model,
    duration_ms: meta.last_run.duration_ms,
    stored: relative(cwd, paths.citations),
  }
}

function roundTotals(entries) {
  const totals = { duration_ms: 0, model_calls: 0, prompt_tokens: 0, completion_tokens: 0 }
  for (const entry of entries) {
    totals.duration_ms += Number(entry.duration_ms) || 0
    totals.model_calls += Number(entry.usage?.calls) || 0
    totals.prompt_tokens += Number(entry.usage?.prompt_tokens) || 0
    totals.completion_tokens += Number(entry.usage?.completion_tokens) || 0
  }
  return totals
}

function roundViews(paths, meta, currentSha1) {
  return storedRounds(paths, meta).map((entry) => ({
    round: entry.round,
    run_id: entry.run_id,
    finished_at: entry.finished_at,
    duration_ms: entry.duration_ms,
    state: entry.state,
    comments: entry.counts?.comments ?? null,
    by_severity: entry.counts?.by_severity ?? {},
    questions: entry.counts?.questions ?? null,
    claims_by_status: entry.counts?.claims_by_status ?? {},
    flagged_citations: entry.counts?.flagged_citations ?? null,
    topology: entry.params?.topology ?? null,
    thinking_level: entry.params?.thinking_level ?? null,
    model: entry.model ?? null,
    usage: entry.usage ?? null,
    reviewed_this_input: (entry.input_sha1 ?? null) === (currentSha1 ?? null),
    artifacts: entry.artifacts ?? {},
  }))
}

function actionStatus(args, cwd, input) {
  const paths = storePaths(cwd, input.key)
  const meta = readMeta(paths.dir)
  if (!meta) {
    throw new Error(`no stored deep review for ${input.rel}; run action "review" first`)
  }
  const artifacts = artifactIndex(paths.dir, cwd)
  const rounds = roundViews(paths, meta, input.sha1)
  return {
    action: 'status',
    key: input.key,
    dir: paths.dirRel,
    stale: reviewStale(meta, input),
    input: meta.input,
    last_run: meta.last_run,
    summary: meta.summary,
    rounds: {
      total: rounds.length,
      latest_round: meta.latest_round ?? (rounds.length || null),
      totals: roundTotals(meta.rounds || rounds),
      recent: rounds.slice(-5),
    },
    artifacts,
  }
}

function pickRound(entries, selector, fallback) {
  if (selector == null || String(selector).trim() === '') return fallback
  const asNumber = Number(String(selector).trim())
  if (Number.isInteger(asNumber) && asNumber > 0) {
    const hit = entries.find((entry) => entry.round === asNumber)
    if (hit) return hit
  }
  const wanted = String(selector).trim()
  const byRun = entries.find((entry) => entry.run_id === wanted)
  if (byRun) return byRun
  throw new Error(`no stored round "${wanted}" (rounds 1–${entries.length} exist; pass a round number or run_id)`)
}

function actionCompare(args, cwd, input) {
  const paths = storePaths(cwd, input.key)
  const meta = readMeta(paths.dir)
  if (!meta) throw new Error(`no stored deep review for ${input.rel}; run action "review" first`)
  const entries = storedRounds(paths, meta)
  if (!entries.length) throw new Error(`no stored review rounds for ${input.rel}; run action "review" first`)
  if (entries.length < 2) {
    throw new Error(`only 1 review round stored for ${input.rel}; revise the manuscript and run "review" again, then "compare" to see which findings moved`)
  }
  const to = pickRound(entries, args.to, entries[entries.length - 1])
  const from = pickRound(entries, args.from, entries[Math.max(0, entries.indexOf(to) - 1)])
  if (!from) throw new Error('no earlier round to compare against; "from" must differ from "to"')
  if (from.run_id === to.run_id) throw new Error('"from" and "to" name the same round')
  const fromDetail = roundDetail(paths, meta, from)
  const toDetail = roundDetail(paths, meta, to)
  if (!fromDetail || !toDetail) {
    throw new Error(`round digest missing for ${from.run_id === to.run_id ? from.run_id : `${from.run_id}/${to.run_id}`}; the ${ROUNDS_DIR}/ files were edited or deleted out of band`)
  }
  const ref = (entry) => ({
    round: entry.round,
    run_id: entry.run_id,
    finished_at: entry.finished_at,
    input_sha1: entry.input_sha1,
    reviewed_this_input: (entry.input_sha1 ?? null) === (input.sha1 ?? null),
    topology: entry.params?.topology ?? null,
    thinking_level: entry.params?.thinking_level ?? null,
  })
  return {
    action: 'compare',
    key: input.key,
    dir: paths.dirRel,
    stale: reviewStale(meta, input),
    from: ref(from),
    to: ref(to),
    input_changed: (from.input_sha1 ?? '') !== (to.input_sha1 ?? ''),
    ...compareDigests(fromDetail, toDetail),
    note: `Advisory: the engine re-issues comment ids per run, so findings are paired by wording, then wording similarity (≥${FUZZY_MIN_JACCARD} token overlap), then the quoted span — the "Matched by" line says which rule made each pair. A closed finding is a lead, not proof the criticism was resolved, and if the manuscript bytes did not change the movement is reviewer variance.`,
  }
}

function showComments(review, args) {
  const result = review?.result && typeof review.result === 'object' ? review.result : {}
  let comments = Array.isArray(result.anchoredComments) ? result.anchoredComments : []
  const severity = args.severity ? String(args.severity).toUpperCase() : ''
  if (severity && !SEVERITIES.includes(severity)) {
    throw new Error(`severity must be one of ${SEVERITIES.join(', ')}`)
  }
  if (severity) comments = comments.filter((comment) => comment?.severity === severity)
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50)
  const offset = Math.max(Number(args.offset) || 0, 0)
  const includeBody = args.include_body === true
  const page = comments.slice(offset, offset + limit).map((comment) => {
    const item = {
      comment_id: comment?.commentId ?? null,
      severity: comment?.severity ?? 'SEVERITY_UNSPECIFIED',
      summary: clip(comment?.summary || '', 500),
      location: locationText(comment?.location),
      quote: quoteText(comment?.location),
    }
    if (includeBody) {
      item.body = clip(comment?.bodyMarkdown || '', 800)
      item.suggested_edit = clip(comment?.suggestedEdit || '', 500)
    }
    return item
  })
  return { total: comments.length, offset, limit, comments: page }
}

function showQuestions(review) {
  const result = review?.result && typeof review.result === 'object' ? review.result : {}
  const questions = Array.isArray(result.questionsForAuthors) ? result.questionsForAuthors : []
  return {
    total: questions.length,
    questions: questions.map((question) => ({
      number: question?.questionNumber ?? null,
      question: clip(question?.question || '', 1000),
      linked_issue: clip(question?.linkedIssueSummary || '', 400),
      changes_evaluation: clip(question?.howResponseChangesEvaluation || '', 600),
    })),
  }
}

function showChecklist(review) {
  const result = review?.result && typeof review.result === 'object' ? review.result : {}
  const checklist = Array.isArray(result.reproducibilityChecklist) ? result.reproducibilityChecklist : []
  return {
    total: checklist.length,
    checklist: checklist.map((item) => ({
      key: item?.key ?? null,
      label: item?.label ?? null,
      status: item?.status ?? null,
      evidence: clip(item?.evidenceAndSuggestion || '', 600),
    })),
  }
}

function showClaims(review, args) {
  const result = review?.result && typeof review.result === 'object' ? review.result : {}
  const claims = Array.isArray(result.claimEvidenceMap) ? result.claimEvidenceMap : []
  const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200)
  return {
    total: claims.length,
    claims: claims.slice(0, limit).map((claim) => ({
      claim_id: claim?.claimId ?? null,
      claim: clip(claim?.claim || '', 400),
      page: claim?.page ?? null,
      evidence_type: claim?.evidenceType ?? null,
      evidence_location: clip(claim?.evidenceLocation || '', 300),
      status: claim?.status ?? null,
      gap_analysis: clip(claim?.gapAnalysis || '', 600),
    })),
  }
}

function showCitations(review) {
  const result = review?.result && typeof review.result === 'object' ? review.result : {}
  const comments = Array.isArray(result.anchoredComments) ? result.anchoredComments : []
  const flagged = comments.filter((comment) => comment?.citationReport)
  const limit = 25
  return {
    total: flagged.length,
    note: 'Only references the engine flagged are embedded in the review; clean references are omitted upstream.',
    citations: flagged.slice(0, limit).map((comment) => {
      const report = comment.citationReport
      return {
        ref_num: report?.refNum ?? null,
        verdict: report?.finalVerdict ?? 'VERDICT_UNSPECIFIED',
        reference: clip(report?.rawReference || '', 300),
        mismatches: Array.isArray(report?.fieldComparisons)
          ? report.fieldComparisons.filter((field) => !field?.match).map((field) => ({
              field: field?.fieldKey ?? null,
              detail: clip(field?.detail || '', 200),
            })).slice(0, 8)
          : [],
      }
    }),
  }
}

function showStandaloneCitations(cwd, paths) {
  const reports = readJsonFile(paths.citations)
  const list = Array.isArray(reports) ? reports : []
  const limit = 25
  const citations = list
    .filter((report) => !['OK', 'SKIPPED', 'VERIFIED_BY_SEARCH'].includes(report?.finalVerdict))
    .slice(0, limit)
    .map((report) => ({
      ref_num: report?.refNum ?? null,
      verdict: report?.finalVerdict ?? 'VERDICT_UNSPECIFIED',
      reference: clip(report?.rawReference || '', 300),
      mismatches: Array.isArray(report?.fieldComparisons)
        ? report.fieldComparisons.filter((field) => !field?.match).map((field) => ({
            field: field?.fieldKey ?? null,
            detail: clip(field?.detail || '', 200),
          })).slice(0, 8)
        : [],
    }))
  return {
    total: list.length,
    by_verdict: countBy(list, (report) => report?.finalVerdict),
    citations,
    source: relative(cwd, paths.citations),
  }
}

function showMarkdown(cwd, paths, args) {
  if (!existsSync(paths.reviewMarkdown)) {
    throw new Error('no stored review Markdown; run action "review" first')
  }
  const maxChars = Math.min(Math.max(Number(args.max_chars) || 20_000, 500), 60_000)
  const markdown = readFileSync(paths.reviewMarkdown, 'utf8')
  return {
    markdown: clip(markdown, maxChars),
    truncated: markdown.length > maxChars,
    total_chars: markdown.length,
    stored: relative(cwd, paths.reviewMarkdown),
  }
}

function actionShow(args, cwd, input) {
  const paths = storePaths(cwd, input.key)
  const meta = readMeta(paths.dir)
  const review = existsSync(paths.reviewJson) ? readJsonFile(paths.reviewJson) : null
  const section = String(args.section || 'summary').toLowerCase()
  if (!SECTIONS.includes(section)) {
    throw new Error(`section must be one of ${SECTIONS.join(', ')}`)
  }
  const base = {
    action: 'show',
    section,
    key: input.key,
    dir: paths.dirRel,
    stale: reviewStale(meta, input),
  }
  if (section === 'citations') {
    if (existsSync(paths.citations)) return { ...base, ...showStandaloneCitations(cwd, paths) }
    if (!review) {
      throw new Error(`no stored review or citation report for ${input.rel}; run action "review" or "verify_citations" first`)
    }
    return { ...base, ...showCitations(review) }
  }
  if (section === 'markdown') {
    return { ...base, ...showMarkdown(cwd, paths, args) }
  }
  if (section === 'rounds') {
    const rounds = roundViews(paths, meta, input.sha1)
    return {
      ...base,
      total: rounds.length,
      latest_round: meta?.latest_round ?? (rounds.length || null),
      totals: roundTotals(meta?.rounds && meta.rounds.length ? meta.rounds : rounds),
      rounds,
    }
  }
  if (!review) {
    throw new Error(`no stored deep review for ${input.rel}; run action "review" first`)
  }
  if (section === 'summary') return { ...base, summary: summarizeReview(review) }
  if (section === 'comments') return { ...base, ...showComments(review, args) }
  if (section === 'questions') return { ...base, ...showQuestions(review) }
  if (section === 'checklist') return { ...base, ...showChecklist(review) }
  return { ...base, ...showClaims(review, args) }
}

function actionList(cwd, args) {
  const root = join(cwd, '.dsh', 'deep-review')
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
  if (!existsSync(root)) {
    return { action: 'list', dir: relative(cwd, root), total: 0, reviews: [] }
  }
  const reviews = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const meta = readMeta(join(root, entry.name))
    if (!meta) continue
    reviews.push({
      key: meta.key ?? entry.name,
      file_name: meta.input?.file_name ?? null,
      path: meta.input?.path ?? null,
      last_action: meta.last_run?.action ?? null,
      state: meta.last_run?.state ?? null,
      finished_at: meta.last_run?.finished_at ?? null,
      duration_ms: meta.last_run?.duration_ms ?? null,
      comments: meta.summary?.comments?.total ?? null,
      questions: meta.summary?.questions ?? null,
      stored: relative(cwd, join(root, entry.name)),
    })
  }
  reviews.sort((a, b) => String(b.finished_at || '').localeCompare(String(a.finished_at || '')))
  return { action: 'list', dir: relative(cwd, root), total: reviews.length, reviews: reviews.slice(0, limit) }
}

async function runDeepReview(args = {}, exec = {}, ctx = null) {
  const action = String(args.action || 'status').toLowerCase()
  if (!ACTIONS.includes(action)) {
    throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  }
  const cwd = workspaceRoot(exec)
  if (action === 'list') return actionList(cwd, args)

  requireActionPath(action, args)
  const input = resolveInput(cwd, args.path)
  if (action === 'review') return actionReview(args, exec, cwd, input, ctx)
  if (action === 'estimate') return actionEstimate(args, exec, cwd, input)
  if (action === 'pdf2md') return actionPdf2md(args, exec, cwd, input)
  if (action === 'verify_citations') return actionVerifyCitations(args, exec, cwd, input, ctx)
  if (action === 'status') return actionStatus(args, cwd, input)
  if (action === 'compare') return actionCompare(args, cwd, input)
  return actionShow(args, cwd, input)
}

function text(value) {
  return [{ type: 'text', text: value }]
}

function renderReviewSummary(value) {
  const lines = []
  const state = value.state || 'SUCCEEDED'
  const duration = Number.isFinite(value.duration_ms) ? ` (${value.duration_ms} ms)` : ''
  lines.push(`Deep review ${state.toLowerCase()} for ${value.dir}${duration}.`)
  if (value.round) lines.push(`Round ${value.round} of ${value.rounds ?? value.round}; earlier rounds stay under ${value.dir}/rounds/.`)
  if (value.usage) lines.push(`Model calls this round: ${value.usage.calls} (${value.usage.prompt_tokens} in / ${value.usage.completion_tokens} out tokens).`)
  if (value.stale === true) lines.push('Note: the manuscript changed since this run (stale).')
  if (value.contribution_type) lines.push(`Contribution type: ${value.contribution_type}`)
  const bySeverity = value.comments?.by_severity || {}
  const severityText = Object.entries(bySeverity).map(([key, count]) => `${key.toLowerCase()} ${count}`).join(', ')
  lines.push(`Comments: ${value.comments?.total ?? 0}${severityText ? ` (${severityText})` : ''}`)
  for (const comment of value.comments?.top || []) {
    lines.push(`- [${String(comment.severity).toLowerCase()}] ${comment.summary}${comment.location ? ` (${comment.location})` : ''}`)
  }
  lines.push(`Questions for authors: ${value.questions ?? 0}; flagged citations: ${value.flagged_citations?.total ?? 0}`)
  if (value.job_id) lines.push(`Live progress: background job ${value.job_id} — expand it in the session header jobs panel.`)
  lines.push(`Stored under ${value.dir}. Full report: action "show" section "markdown"; findings are advisory.`)
  return text(lines.join('\n'))
}

function renderDeepReview(value) {
  if (!value || value.error) return text(`Error: ${value?.error ?? 'unknown error'}`)
  if (value.action === 'review') return renderReviewSummary(value)
  if (value.action === 'estimate') {
    return text(
      `Estimated review cost: low ${value.formatted?.low ?? '?'} | median ${value.formatted?.median ?? '?'} | `
      + `high ${value.formatted?.high ?? '?'} (session model${value.model ? ` ${value.model}` : ''}). `
      + `Stored ${value.stored}. Run action "review" only after the user confirms.`,
    )
  }
  if (value.action === 'pdf2md') {
    return text(
      `Converted ${value.page_count ?? '?'} page(s) (${value.pdf_type ?? 'unknown type'}, confidence `
      + `${value.confidence != null ? `${Math.round(value.confidence * 100)}%` : '?'}); `
      + `${value.pages_needing_ocr ?? 0} page(s) need OCR. Stored ${value.stored?.paper}.`,
    )
  }
  if (value.action === 'verify_citations') {
    const verdicts = Object.entries(value.by_verdict || {}).map(([key, count]) => `${key} ${count}`).join(', ')
    const flagged = (value.flagged || []).slice(0, 5)
      .map((item) => `- [${item.ref_num}] ${item.verdict}: ${clip(item.reference, 160)}`)
    return text([
      `Verified ${value.total} reference(s)${verdicts ? `: ${verdicts}` : ''}.`,
      ...flagged,
      `Stored ${value.stored}.`,
    ].join('\n'))
  }
  if (value.action === 'status') {
    const last = value.last_run || {}
    const rounds = value.rounds || {}
    const totals = rounds.totals || {}
    return text([
      `Stored deep review for ${value.input?.path} (${value.stale ? 'stale: manuscript changed' : 'current'}).`,
      `Last run: ${last.action || '?'} · ${last.state || '?'} · ${last.finished_at || '?'}${last.error ? ` · ${clip(last.error, 300)}` : ''}`,
      `Comments: ${value.summary?.comments?.total ?? '—'}; questions: ${value.summary?.questions ?? '—'}. Dir ${value.dir}.`,
      `Rounds: ${rounds.total ?? 0} (latest ${rounds.latest_round ?? '—'})`
        + `${totals.model_calls ? ` · ${totals.model_calls} model call(s), ${totals.prompt_tokens} in / ${totals.completion_tokens} out tokens` : ''}`
        + `${(rounds.total ?? 0) > 1 ? '; use action "compare" to see which findings moved' : '; a second review enables action "compare"'}.`,
      ...(rounds.recent || []).slice(-3).map((round) => `- round ${round.round}: ${round.comments ?? 0} comment(s), ${round.finished_at || '?'}${round.reviewed_this_input ? '' : ' (older manuscript)'}`),
    ].join('\n'))
  }
  if (value.action === 'compare') {
    const lines = [
      `Round ${value.from?.round} (${value.from?.finished_at || '?'}) → round ${value.to?.round} (${value.to?.finished_at || '?'})${value.input_changed ? ' — the manuscript changed between rounds' : ' — same manuscript hash, so this is reviewer variance, not revision'}.`,
    ]
    const comments = value.comments || {}
    lines.push(`Comments: ${comments.total_from} → ${comments.total_to}. Closed ${comments.closed_total}, still open ${comments.persisting_total}, new ${comments.opened_total}, severity moved ${comments.severity_changed}.`)
    const rules = Object.entries(comments.matched_by || {}).map(([key, count]) => `${key} ${count}`).join(', ')
    if (rules) lines.push(`Matched by: ${rules} — the engine re-issues comment ids per run, so "similar" pairs a reworded finding at ≥${FUZZY_MIN_JACCARD} token overlap.`)
    for (const item of comments.closed.slice(0, 10)) lines.push(`- closed [${String(item.severity).toLowerCase()}] ${item.summary}`)
    for (const item of comments.opened.slice(0, 10)) lines.push(`- new [${String(item.severity).toLowerCase()}] ${item.summary}`)
    for (const item of comments.moved.slice(0, 10)) {
      const how = item.matched_by === 'similar' ? ` (reworded, overlap ${item.score ?? '?'})` : ''
      lines.push(`- moved [${String(item.from_severity).toLowerCase()} → ${String(item.severity).toLowerCase()}] ${item.summary}${how}`)
    }
    const claims = value.claims || {}
    if (claims.changed?.length || claims.raised_total || claims.resolved_total) {
      lines.push(`Claims: ${claims.changed.filter((item) => item.improved).length} better supported, ${claims.changed.filter((item) => !item.improved).length} weaker; ${Object.entries(claims.by_status_to || {}).map(([key, count]) => `${key} ${count}`).join(', ')}.`)
      for (const item of claims.changed.slice(0, 8)) lines.push(`- ${item.improved ? '↑' : '↓'} ${item.from_status} → ${item.to_status}: ${item.claim}`)
    }
    const checklist = value.checklist || {}
    if (checklist.changed_total) {
      lines.push(`Checklist: ${checklist.changed_total} item(s) changed status.`)
      for (const item of checklist.transitions.slice(0, 8)) lines.push(`- ${item.label || item.key}: ${item.from_status ?? '—'} → ${item.to_status ?? '—'}`)
    }
    const citations = value.citations || {}
    if (citations.fixed_total || citations.newly_flagged_total || citations.still_flagged_total) {
      lines.push(`Citations: ${citations.fixed_total} now clean, ${citations.still_flagged_total} still flagged, ${citations.newly_flagged_total} newly flagged.`)
    }
    const questions = value.questions || {}
    if (questions.total_from !== questions.total_to) lines.push(`Questions for authors: ${questions.total_from} → ${questions.total_to}.`)
    if (value.usage?.to) lines.push(`This round cost ${value.usage.to.calls} model call(s), ${value.usage.to.prompt_tokens} in / ${value.usage.to.completion_tokens} out tokens.`)
    lines.push(value.note)
    return text(lines.join('\n'))
  }
  if (value.action === 'show') {
    if (value.section === 'summary') {
      return renderReviewSummary({ ...value.summary, dir: value.dir, stale: value.stale })
    }
    if (value.section === 'comments') {
      const lines = (value.comments || []).map(
        (comment) => `- [${String(comment.severity).toLowerCase()}] ${comment.summary}${comment.location ? ` (${comment.location})` : ''}`,
      )
      const shown = value.comments?.length ?? 0
      const window = shown ? `showing ${value.offset + 1}–${value.offset + shown}` : 'none matched'
      return text([`${value.total} comment(s), ${window}:`, ...lines].join('\n'))
    }
    if (value.section === 'questions') {
      return text((value.questions || []).map((question) => `${question.number}. ${question.question}`).join('\n') || 'No questions stored.')
    }
    if (value.section === 'checklist') {
      return text((value.checklist || []).map((item) => `- ${item.label}: ${item.status}`).join('\n') || 'No checklist stored.')
    }
    if (value.section === 'claims') {
      return text((value.claims || []).map((claim) => `- [${claim.status}] ${claim.claim} (${claim.evidence_type})`).join('\n') || 'No claims stored.')
    }
    if (value.section === 'citations') {
      return text((value.citations || []).map((item) => `- [${item.ref_num}] ${item.verdict}: ${clip(item.reference, 200)}`).join('\n') || 'No flagged citations stored.')
    }
    if (value.section === 'rounds') {
      if (!value.total) return text(`No stored review rounds for this manuscript yet.`)
      const lines = (value.rounds || []).map((round) => `- round ${round.round}: ${round.comments ?? 0} comment(s), ${round.questions ?? 0} question(s), ${round.flagged_citations ?? 0} flagged citation(s) · ${round.finished_at || '?'} · ${round.topology || 'default'}${round.reviewed_this_input ? '' : ' · older manuscript'}`)
      return text([`${value.total} round(s), latest ${value.latest_round}.`, ...lines, value.total > 1 ? 'Use action "compare" for what moved.' : 'Run "review" again after revising to build the ladder.'].join('\n'))
    }
    return text(value.markdown || '(empty review Markdown)')
  }
  if (value.action === 'list') {
    if (!value.total) return text(`No stored deep reviews under ${value.dir}.`)
    return text([
      `${value.total} stored deep review(s):`,
      ...value.reviews.map((item) => `- ${item.file_name || item.key} · ${item.last_action || '?'} · ${item.state || '?'} · ${item.finished_at || '?'}`),
    ].join('\n'))
  }
  return text(JSON.stringify(value, null, 2))
}

export const name = 'academic-harness-deep-review'
export const inject = ['tools', 'llm', 'jobs']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'deep_review',
    description: [
      'Run a Deep-Review-style multi-pass critique of a manuscript with the vendored Open Deep Review engine: segmented review passes, page/quote-anchored comments, a scholar-peer summary with questions for authors, and reference verification against OpenAlex/Crossref.',
      'Actions: `review` (run the pipeline; slow and token-heavy), `estimate` (optional engine-run estimate; no model call), `pdf2md` (inspect a PDF), `verify_citations`, `status` (stored state, stale flag, round ladder), `show` (read stored summary/comments/questions/checklist/claims/citations/markdown/rounds), `compare` (diff two review rounds), `list` (stored reviews).',
      'Results live under `.dsh/deep-review/<key>/`; `review` returns a compact summary and never the full report, so use `show` for detail. Every `review` is kept as a numbered round with its report under `rounds/`, so reviewing again after a revision does not erase the earlier round — use `compare` to see which comments closed, reopened, or changed severity, and which claims, checklist items, or citations moved. After a revision, review and then compare instead of eyeballing the two reports. While a review runs, the engine stage/percentage and model-call events stream to the session\'s background-jobs panel; the result includes a `job_id` so the user can expand the finished log. `review` and `verify_citations` run on the session model (the provider/model of the calling chat) through the host llm service — there is no separate key or endpoint; switching the session model switches the reviewer.',
      'Whenever the user asks to review, critique, referee, or give feedback on a paper or manuscript, ask them to choose `deep_review` (multi-pass, takes minutes) or a normal session review before calling this tool — even for a plain "review this paper" — unless they explicitly chose a mode. Describe the deep option in the question; the user may not know it exists.',
      'After finishing a paper, manuscript, or technical document, offer the same choice: deliver the draft, then ask whether the user wants a deep review of it. Offer only — never run `review` on a just-written document without the user agreeing.',
      'This is not the systematic-review ledger (`review`) or a reporting checklist (`reporting_check`); for a referee report written by the session model, delegate to the `peer-reviewer` subagent. Findings are advisory. Load the `deep-review` skill for the workflow.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'review, estimate, pdf2md, verify_citations, status, show, compare, or list. Default status.',
      },
      path: { type: 'string', description: 'Workspace-relative manuscript path (PDF, TeX, Markdown, or text). Required for every action except list.' },
      topology: {
        type: 'string',
        enum: TOPOLOGIES,
        description: 'Review depth: LOW (1 pass), MID (2), HIGH (3), EXTRA_HIGH (4). Default from the engine (MID).',
      },
      thinking_level: {
        type: 'string',
        enum: THINKING_LEVELS,
        description: 'Engine thinking budget: LOW, MEDIUM, or HIGH. Default from the engine (MEDIUM). This changes the review prompts/passes, not the provider reasoning effort.',
      },
      focus: {
        type: 'string',
        description: 'Optional extra reviewer guidance passed to the engine, for example "focus on the causal claims and the missing baselines" (max 4000 chars).',
      },
      citations: { type: 'boolean', description: 'Verify bibliography entries during review. Default true.' },
      scholar_peer: { type: 'boolean', description: 'Include the scholar-peer summary, strengths/weaknesses, checklist, and author questions. Default true.' },
      timeout_minutes: { type: 'integer', description: 'Engine timeout in minutes (1–120). Defaults: review and verify_citations 30, estimate and pdf2md 5.' },
      section: {
        type: 'string',
        enum: SECTIONS,
        description: 'show: summary (default), comments, questions, checklist, claims, citations, markdown, or rounds (the stored review ladder with per-round counts).',
      },
      from: {
        type: 'string',
        description: 'compare: the earlier round — a round number or run_id. Default: the round before "to".',
      },
      to: {
        type: 'string',
        description: 'compare: the later round — a round number or run_id. Default: the latest round.',
      },
      severity: {
        type: 'string',
        enum: SEVERITIES,
        description: 'show comments: filter by severity.',
      },
      limit: { type: 'integer', description: 'show comments: page size (default 20, max 50). show claims: max claims (default 50). list: max entries (default 20).' },
      offset: { type: 'integer', description: 'show comments: skip this many comments. Default 0.' },
      include_body: { type: 'boolean', description: 'show comments: include the comment body and suggested edit (clipped). Default false.' },
      max_chars: { type: 'integer', description: 'show markdown: character cap (default 20000, max 60000).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderDeepReview(value),
    },
    async execute(args, exec) {
      try {
        return await runDeepReview(args, exec, ctx)
      } catch (error) {
        return { action: args?.action || 'status', error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      const verb = args.action || 'status'
      return { card: 'generic', title: `Deep review: ${args.path || ''} (${verb})`, kind: 'other' }
    },
  }))
}
