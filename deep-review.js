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

const ACTIONS = ['review', 'estimate', 'pdf2md', 'verify_citations', 'status', 'show', 'list']
const SECTIONS = ['summary', 'comments', 'questions', 'checklist', 'claims', 'citations', 'markdown']
const TOPOLOGIES = ['LOW', 'MID', 'HIGH', 'EXTRA_HIGH']
const THINKING_LEVELS = ['LOW', 'MEDIUM', 'HIGH']
const SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR', 'SUGGESTION', 'SEVERITY_UNSPECIFIED']
const SEVERITY_RANK = { CRITICAL: 0, MAJOR: 1, MINOR: 2, SUGGESTION: 3, SEVERITY_UNSPECIFIED: 4 }
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

function buildEngineEnv(bridge) {
  const env = {}
  for (const key of ALLOWED_ENV) {
    if (process.env[key] != null) env[key] = process.env[key]
  }
  env.DEEPREVIEW_CONFIG_PATH = engineConfigPath()
  if (bridge) {
    env.DEEPREVIEW_BASE_URL = bridge.baseUrl
    env.DEEPREVIEW_API_KEY = bridge.token
    env.DEEPREVIEW_MODEL = 'dsh-session-model'
  }
  return env
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
export async function startLlmBridge(ctx, exec) {
  if (!ctx?.llm || typeof ctx.llm.stream !== 'function') {
    throw new Error('deep_review needs the host llm service, which is not available in this session.')
  }
  const token = randomUUID()
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

    try {
      const route = sessionRoute(exec)
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
        return send(502, { error: { message: failure.message || failure.code || 'model request failed' } })
      }
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
        ...(usage
          ? {
              usage: {
                prompt_tokens: usage.inputTokens ?? 0,
                completion_tokens: usage.outputTokens ?? 0,
                total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
              },
            }
          : {}),
      })
    } catch (error) {
      if (controller.signal.aborted) return send(499, { error: { message: 'model request aborted' } })
      send(502, { error: { message: error instanceof Error ? error.message : String(error) } })
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

async function runEngine(action, engineArgs, { cwd, timeoutMinutes, signal, env, apiKey }) {
  const launch = resolveEngine()
  const timeoutMs = Math.round(timeoutMinutes * 60_000)
  const result = await run(launch.command, [...launch.args, ...engineArgs], {
    cwd,
    timeoutMs,
    signal,
    silent: true,
    env,
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
    schemaVersion: 1,
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
  }
}

function mergeMeta(previous, input, params, exec) {
  const meta = previous && previous.schemaVersion === 1 ? previous : baseMeta(input, params, exec)
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
  return meta
}

async function persistArtifacts(cwd, paths, files, buildMeta) {
  mkdirSync(paths.dir, { recursive: true })
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
  const bridge = await startLlmBridge(ctx, exec)
  const env = buildEngineEnv(bridge)

  let result
  try {
    result = await runEngine('review', engineArgs, {
      cwd,
      timeoutMinutes,
      signal: exec?.signal,
      env,
      apiKey: bridge.token,
    })
  } catch (error) {
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

  const files = { [ARTIFACTS.review_json]: review }
  if (typeof review?.result?.reviewMarkdown === 'string') {
    files[ARTIFACTS.review_markdown] = review.result.reviewMarkdown
  }
  if (paperMarkdown != null) files[ARTIFACTS.paper_markdown] = paperMarkdown

  const meta = await persistArtifacts(cwd, paths, files, (current) => {
    const next = mergeMeta(current, input, params, exec)
    next.last_run = runRecord('review', startedAt, {
      review_id: ids.reviewId,
      document_id: ids.documentId,
      state: review?.state || 'SUCCEEDED',
      error: summary.error,
    })
    next.summary = summary
    next.review = {
      sha1: input.sha1,
      review_id: ids.reviewId,
      document_id: ids.documentId,
      finished_at: next.last_run.finished_at,
      params: { ...params },
    }
    return next
  })

  return {
    action: 'review',
    key: input.key,
    dir: paths.dirRel,
    ...summary,
    provider: meta.engine.provider,
    model: meta.engine.model,
    topology: params.topology,
    thinking_level: params.thinking_level,
    duration_ms: meta.last_run.duration_ms,
    artifacts: {
      review: meta.artifacts.review_json?.path ?? null,
      markdown: meta.artifacts.review_markdown?.path ?? null,
      paper: meta.artifacts.paper_markdown?.path ?? null,
    },
    engine_stderr_tail: result.stderr ? clip(result.stderr.slice(-600), 600) : null,
  }
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
  const env = buildEngineEnv(bridge)
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

function actionStatus(args, cwd, input) {
  const paths = storePaths(cwd, input.key)
  const meta = readMeta(paths.dir)
  if (!meta) {
    throw new Error(`no stored deep review for ${input.rel}; run action "review" first`)
  }
  const artifacts = artifactIndex(paths.dir, cwd)
  return {
    action: 'status',
    key: input.key,
    dir: paths.dirRel,
    stale: reviewStale(meta, input),
    input: meta.input,
    last_run: meta.last_run,
    summary: meta.summary,
    artifacts,
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
  if (value.stale === true) lines.push('Note: the manuscript changed since this run (stale).')
  if (value.contribution_type) lines.push(`Contribution type: ${value.contribution_type}`)
  const bySeverity = value.comments?.by_severity || {}
  const severityText = Object.entries(bySeverity).map(([key, count]) => `${key.toLowerCase()} ${count}`).join(', ')
  lines.push(`Comments: ${value.comments?.total ?? 0}${severityText ? ` (${severityText})` : ''}`)
  for (const comment of value.comments?.top || []) {
    lines.push(`- [${String(comment.severity).toLowerCase()}] ${comment.summary}${comment.location ? ` (${comment.location})` : ''}`)
  }
  lines.push(`Questions for authors: ${value.questions ?? 0}; flagged citations: ${value.flagged_citations?.total ?? 0}`)
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
    return text([
      `Stored deep review for ${value.input?.path} (${value.stale ? 'stale: manuscript changed' : 'current'}).`,
      `Last run: ${last.action || '?'} · ${last.state || '?'} · ${last.finished_at || '?'}${last.error ? ` · ${clip(last.error, 300)}` : ''}`,
      `Comments: ${value.summary?.comments?.total ?? '—'}; questions: ${value.summary?.questions ?? '—'}. Dir ${value.dir}.`,
    ].join('\n'))
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
export const inject = ['tools', 'llm']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'deep_review',
    description: [
      'Run a Deep-Review-style multi-pass critique of a manuscript with the vendored Open Deep Review engine: segmented review passes, page/quote-anchored comments, a scholar-peer summary with questions for authors, and reference verification against OpenAlex/Crossref.',
      'Actions: `review` (run the pipeline; slow and token-expensive), `estimate` (offline low/median/high cost estimate; run first), `pdf2md` (inspect a PDF), `verify_citations`, `status` (stored state, stale flag), `show` (read stored summary/comments/questions/checklist/claims/citations/markdown), `list` (stored reviews).',
      'Results live under `.dsh/deep-review/<key>/`; `review` returns a compact summary and never the full report, so use `show` for detail. `review` and `verify_citations` run on the session model (the provider/model of the calling chat) through the host llm service — there is no separate key or endpoint; switching the session model switches the reviewer.',
      'When a request is a generic paper review ("review this paper") with no deep/multi-pass qualifier, ask the user to choose `deep_review` or a normal session review before calling this tool; do not choose silently.',
      'This is not the systematic-review ledger (`review`) or a reporting checklist (`reporting_check`); for a referee report written by the session model, delegate to the `peer-reviewer` subagent. Findings are advisory. Load the `deep-review` skill for the workflow.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'review, estimate, pdf2md, verify_citations, status, show, or list. Default status.',
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
        description: 'show: summary (default), comments, questions, checklist, claims, citations, or markdown.',
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
