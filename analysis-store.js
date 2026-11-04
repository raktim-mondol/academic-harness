/**
 * Analysis-run ledger: frozen plans and immutable run manifests under
 * `<cwd>/.dsh/analysis/<slug>/`.
 *
 *   plan.jsonl   append-only plan versions (the plan is frozen at first run)
 *   runs.jsonl   append-only run manifests, one event per executed run
 *   runs/<id>/   stdout.log, stderr.log, manifest.json, artifacts/, environment/
 *   exports/     run reports
 *
 * Execution uses argv arrays (never a shell), an environment allowlist plus
 * explicitly supplied values, a hard timeout, and workspace-confined input and
 * output paths. Key-like values are redacted from the captured logs.
 */
import os from 'node:os'
import { relative, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import {
  appendJsonl, ensureDir, exportText, hashFile, mdCell, nowIso, readJson, readJsonl,
  sha256, shortHash, slug as slugify, stableStringify,
} from './ledger-kit.js'
import { withLock } from './store-lock.js'
import { resolveWorkspacePath } from './workspace-path.js'
import { appendNotebookEntryAt } from './notebook.js'

export const ANALYSIS_KINDS = ['python', 'r', 'shell', 'node', 'notebook', 'other']
export const ANALYSIS_EXPORT_FORMATS = ['json', 'markdown']
export const ANALYSIS_METRIC_FORMATS = ['json', 'csv', 'tsv', 'kv', 'regex']
export const ANALYSIS_RULE_OPS = [
  'equals', 'not_equals', 'greater_than', 'less_than', 'min', 'max',
  'contains', 'not_contains', 'matches', 'exists', 'absent',
]
export const ANALYSIS_REFERENCES = ['reported', 'reproduced']

const PLAN_LIST_FIELDS = [
  'hypotheses', 'inputs', 'outputs', 'variables', 'primary_outcomes',
  'secondary_outcomes', 'exclusions', 'sensitivity_analyses',
]
const PLAN_TEXT_FIELDS = ['methods', 'corrections', 'missing_data_rules', 'stopping_rules', 'software', 'notes']
const MAX_LOG_BYTES = 4 * 1024 * 1024
const MAX_PARSE_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 600_000
const MAX_TIMEOUT_MS = 3_600_000
const MAX_METRICS = 50
const MAX_RULES = 50
const ENVIRONMENT_FINGERPRINT = ['python', 'r', 'node', 'os']
const SECRET_TEXT_PATTERN = /\b([a-z0-9_.-]*(?:api[_-]?key|token|secret|password|passwd|credential|access[_-]?key|private[_-]?key)[a-z0-9_.-]*)\s*[=:]\s*(?!\[redacted)([^\s,;'"]{6,})/gi

function text(value) {
  return String(value ?? '').trim()
}

function files(cwd, slugValue) {
  const dir = join(cwd, '.dsh', 'analysis', slugify(slugValue))
  return {
    dir,
    plan: join(dir, 'plan.jsonl'),
    runs: join(dir, 'runs.jsonl'),
    runsDir: join(dir, 'runs'),
    expectations: join(dir, 'expectations.jsonl'),
    verifications: join(dir, 'verifications.jsonl'),
    compliance: join(dir, 'compliance.jsonl'),
    exports: join(dir, 'exports'),
  }
}

function listValue(value, name) {
  if (value == null || value === '') return []
  if (!Array.isArray(value)) {
    if (typeof value === 'string') return [value.trim()].filter(Boolean)
    throw new Error(`${name} must be an array`)
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : entry))
    .filter((entry) => (typeof entry === 'string' ? entry.length > 0 : Boolean(entry) && typeof entry === 'object'))
}

function objectValue(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}

function relativePath(value, name) {
  const path = text(value)
  if (!path) throw new Error(`${name} is required`)
  if (path.startsWith('/') || path.includes('..')) throw new Error(`${name} must be workspace-relative without ".."`)
  return path
}

function inferFormat(path) {
  if (/\.json$/i.test(path)) return 'json'
  if (/\.csv$/i.test(path)) return 'csv'
  if (/\.tsv$/i.test(path)) return 'tsv'
  return null
}

function normalizeRuleCheck(input, name) {
  const check = objectValue(input, name)
  const op = text(check.op).toLowerCase()
  if (!ANALYSIS_RULE_OPS.includes(op)) throw new Error(`${name}.op must be one of ${ANALYSIS_RULE_OPS.join(', ')}`)
  const spec = { path: relativePath(check.path, `${name}.path`), op }
  const existence = op === 'exists' || op === 'absent'
  if (!existence) {
    const format = text(check.format).toLowerCase() || inferFormat(spec.path)
    if (!ANALYSIS_METRIC_FORMATS.includes(format)) {
      throw new Error(`${name}.format must be one of ${ANALYSIS_METRIC_FORMATS.join(', ')} (or inferable from a .json/.csv/.tsv path)`)
    }
    spec.format = format
    if (format === 'regex' && !text(check.pattern)) throw new Error(`${name}.pattern is required for format "regex"`)
  }
  for (const key of ['key', 'column', 'key_column', 'row', 'pattern', 'source', 'unit']) {
    if (typeof check[key] === 'string' && check[key].trim()) spec[key] = check[key].trim()
  }
  if (!existence) {
    if (check.value == null || check.value === '') throw new Error(`${name}.value is required for op "${op}"`)
    spec.value = check.value
  }
  if (['greater_than', 'less_than', 'min', 'max'].includes(op) && !Number.isFinite(Number(check.value))) {
    throw new Error(`${name}.value must be numeric for op "${op}"`)
  }
  return spec
}

function normalizeTaskRules(input) {
  if (input == null || input === '') return []
  if (!Array.isArray(input)) throw new Error('plan.task_rules must be an array')
  if (input.length > MAX_RULES) throw new Error(`plan.task_rules accepts at most ${MAX_RULES} rules`)
  const ids = new Set()
  return input.map((raw, index) => {
    const name = `plan.task_rules[${index}]`
    if (typeof raw === 'string') {
      const statement = text(raw)
      if (!statement) throw new Error(`${name} is empty`)
      const id = `r${index + 1}`
      if (ids.has(id)) throw new Error(`duplicate task rule id "${id}"`)
      ids.add(id)
      return { id, statement, check: null }
    }
    const rule = objectValue(raw, name)
    const id = text(rule.id) || `r${index + 1}`
    if (ids.has(id)) throw new Error(`duplicate task rule id "${id}"`)
    ids.add(id)
    const statement = text(rule.statement ?? rule.description)
    if (!statement) throw new Error(`${name}.statement is required`)
    return {
      id,
      statement,
      check: rule.check ? normalizeRuleCheck(rule.check, `${name}.check`) : null,
    }
  })
}

export function normalizeAnalysisPlan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('plan must be an object')
  }
  const question = text(input.question)
  if (!question) throw new Error('plan.question is required')
  const plan = { question }
  for (const field of PLAN_LIST_FIELDS) plan[field] = listValue(input[field], `plan.${field}`)
  for (const field of ['inputs', 'outputs']) {
    if (plan[field].some((path) => typeof path === 'string' && (path.startsWith('/') || path.includes('..')))) {
      throw new Error(`plan.${field} paths must be workspace-relative without ".."`)
    }
  }
  for (const field of PLAN_TEXT_FIELDS) {
    const value = text(input[field])
    if (value) plan[field] = value
  }
  if (input.alpha != null && input.alpha !== '') {
    const alpha = Number(input.alpha)
    if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) throw new Error('plan.alpha must be between 0 and 1')
    plan.alpha = alpha
  }
  if (input.seed != null && input.seed !== '') {
    const seed = Number(input.seed)
    if (!Number.isInteger(seed)) throw new Error('plan.seed must be an integer')
    plan.seed = seed
  }
  const taskRules = normalizeTaskRules(input.task_rules)
  if (taskRules.length) plan.task_rules = taskRules
  return plan
}

export function currentPlan(cwd, slugValue) {
  const events = readJsonl(files(cwd, slugValue).plan)
  return events.length ? events.at(-1) : null
}

export async function freezeAnalysisPlan({ cwd, slug: slugValue, plan, newVersion = false, reason = null }) {
  const f = files(cwd, slugValue)
  const normalized = normalizeAnalysisPlan(plan)
  const hash = `sha256:${sha256(stableStringify(normalized))}`
  ensureDir(f.dir)
  return withLock(f.dir, () => {
    const events = readJsonl(f.plan)
    const latest = events.at(-1)
    if (latest && latest.hash === hash) {
      return { slug: slugify(slugValue), version: latest.version, hash: latest.hash, plan: latest.plan, unchanged: true }
    }
    if (latest) {
      if (!newVersion) {
        throw new Error('the plan is frozen; pass new_version: true with a reason to supersede it (the old plan and runs stay)')
      }
      if (!text(reason)) throw new Error('a changed plan requires a reason')
    }
    const event = {
      version: (latest?.version ?? 0) + 1,
      plan: normalized,
      hash,
      created_at: nowIso(),
      reason: latest ? text(reason) : null,
      supersedes: latest ? latest.version : null,
    }
    appendJsonl(f.plan, [event])
    return { slug: slugify(slugValue), ...event, created: true }
  }, { label: 'analysis plan ledger' })
}

function baseEnv(network) {
  const env = {}
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TMP', 'TEMP']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  env.PYTHONUNBUFFERED = '1'
  env.PYTHONIOENCODING = 'utf-8'
  if (!network) {
    env.no_proxy = '*'
    env.NO_PROXY = '*'
  }
  return env
}

function explicitEnv(input) {
  if (input == null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('env must be an object of NAME=value strings')
  const out = {}
  for (const [key, value] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid env name: ${key}`)
    if (value == null) continue
    out[key] = String(value)
  }
  return out
}

function redactLog(value, envValues) {
  let out = String(value ?? '')
  for (const [key, secret] of envValues) {
    if (secret.length < 6) continue
    let index = out.indexOf(secret)
    while (index >= 0) {
      const marker = `[redacted:${key}]`
      out = `${out.slice(0, index)}${marker}${out.slice(index + secret.length)}`
      index = out.indexOf(secret, index + marker.length + 1)
    }
  }
  return out.replace(SECRET_TEXT_PATTERN, (match, key) => `${key}=[redacted]`)
}

function capLog(value) {
  const buffer = Buffer.from(String(value ?? ''), 'utf8')
  if (buffer.byteLength <= MAX_LOG_BYTES) return String(value ?? '')
  return `${buffer.subarray(0, MAX_LOG_BYTES).toString('utf8')}\n[truncated at ${MAX_LOG_BYTES} bytes]`
}

function gitCommit(cwd) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 10_000, shell: false })
  if (result.status !== 0) return null
  return text(result.stdout) || null
}

function isPythonExe(kind, exe) {
  return kind === 'python' || /python3?(?:\.\d+)?$/.test(exe)
}

function interpreterEnvironment(kind, command, cwd) {
  const environment = { node: process.version, os: `${os.type()} ${os.release()}` }
  const exe = command[0]
  if (isPythonExe(kind, exe)) {
    const probe = spawnSync(exe, ['-c', 'import sys,platform,json;print(json.dumps({"python":sys.version.split()[0],"executable":sys.executable,"platform":platform.platform()}))'],
      { cwd, encoding: 'utf8', timeout: 30_000, shell: false })
    if (probe.status === 0) {
      try {
        Object.assign(environment, JSON.parse(text(probe.stdout)))
      } catch { /* an unparseable probe is left out rather than guessed */ }
    }
  }
  if (kind === 'r' || /Rscript$/.test(exe)) {
    const probe = spawnSync(exe, ['--version'], { cwd, encoding: 'utf8', timeout: 30_000, shell: false })
    const first = text(probe.stdout || probe.stderr).split('\n')[0]
    if (probe.status === 0 && first) environment.r = first
  }
  return environment
}

function capturePackages(kind, command, cwd, runDir) {
  if (!isPythonExe(kind, command[0])) return null
  const freeze = spawnSync(command[0], ['-m', 'pip', 'freeze'], { cwd, encoding: 'utf8', timeout: 60_000, shell: false })
  if (freeze.status !== 0) return null
  const dir = join(runDir, 'environment')
  ensureDir(dir)
  const file = join(dir, 'packages.txt')
  writeFileSync(file, capLog(freeze.stdout), 'utf8')
  return file
}

function hashPaths(cwd, paths, { forWrite = false } = {}) {
  const out = []
  for (const rel of paths) {
    if (typeof rel !== 'string' || !rel.trim()) continue
    let abs
    try {
      abs = resolveWorkspacePath(cwd, rel, { forWrite })
    } catch (error) {
      out.push({ path: rel, error: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (!existsSync(abs)) {
      out.push({ path: rel, status: forWrite ? 'not_written' : 'missing' })
      continue
    }
    out.push({ path: rel, sha256: `sha256:${hashFile(abs)}`, bytes: statSync(abs).size })
  }
  return out
}

/**
 * Whether this run can be shown to have produced the file. Changed bytes are the
 * run's. Identical bytes are the run's only if the file's own timestamp moved
 * between the snapshot and the hash — a deterministic rerun rewrites the same
 * content and re-stamps it, while a stale file from an earlier run does not.
 */
function outputWriteStatus(prior, entry, mtimeMs) {
  if (entry.error) return { write_status: 'error', prior_sha256: null, written_by_run: false }
  if (!entry.sha256) return { write_status: 'not_written', prior_sha256: prior?.sha256 ?? null, written_by_run: false }
  if (prior?.status === 'missing') return { write_status: 'written', prior_sha256: null, written_by_run: true }
  if (!prior?.sha256) return { write_status: 'unknown', prior_sha256: null, written_by_run: false }
  if (prior.sha256 !== entry.sha256) return { write_status: 'changed', prior_sha256: prior.sha256, written_by_run: true }
  const touched = Number.isFinite(mtimeMs) && Number.isFinite(prior.mtimeMs) && mtimeMs > prior.mtimeMs
  return {
    write_status: touched ? 'rewritten_identical' : 'unchanged',
    prior_sha256: prior.sha256,
    written_by_run: touched,
  }
}

function outputStamp(cwd, entry) {
  if (!entry?.path) return { sha256: null, mtimeMs: null }
  if (!entry.sha256) return { sha256: null, mtimeMs: null, status: entry.status ?? null, error: entry.error ?? null }
  let mtimeMs = null
  try {
    mtimeMs = statSync(resolveWorkspacePath(cwd, entry.path)).mtimeMs
  } catch {
    mtimeMs = null
  }
  return { sha256: entry.sha256, mtimeMs }
}

function commandForNotebook(args, cwd, slugValue, runId) {
  const notebook = text(args.notebook)
  if (!notebook) throw new Error('notebook runs need a workspace-relative notebook path')
  const nbAbs = resolveWorkspacePath(cwd, notebook)
  const outRel = join('.dsh', 'analysis', slugify(slugValue), 'runs', runId, 'artifacts', 'executed.ipynb')
  const outAbs = join(cwd, outRel)
  const engine = text(args.engine).toLowerCase() || 'auto'
  const candidates = []
  if (engine === 'auto' || engine === 'jupyter') {
    candidates.push({ engine: 'jupyter', argv: ['jupyter', 'nbconvert', '--to', 'notebook', '--execute', `--output=${outAbs}`, nbAbs] })
  }
  if (engine === 'auto' || engine === 'papermill') {
    candidates.push({ engine: 'papermill', argv: ['papermill', nbAbs, outAbs] })
  }
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.argv[0], ['--version'], { cwd, encoding: 'utf8', timeout: 30_000, shell: false })
    if (!probe.error) return { ...candidate, executedNotebook: outRel }
  }
  throw new Error('notebook execution needs jupyter nbconvert or papermill on PATH (not_installed)')
}

export function listAnalysisRuns(cwd, slugValue) {
  return readJsonl(files(cwd, slugValue).runs)
}

export function showAnalysisRun(cwd, slugValue, runIdValue) {
  const f = files(cwd, slugValue)
  const run = listAnalysisRuns(cwd, slugValue).find((entry) => entry.run_id === text(runIdValue))
  if (!run) throw new Error(`run "${runIdValue}" not found in ${f.dir.slice(cwd.length + 1)}`)
  const tail = (rel) => {
    try {
      const body = readFileSync(join(cwd, rel), 'utf8')
      return body.length > 4000 ? `…${body.slice(-4000)}` : body
    } catch {
      return ''
    }
  }
  return {
    ...run,
    stdout_tail: tail(run.stdout),
    stderr_tail: tail(run.stderr),
    ...readRunChecks(cwd, slugValue, run.run_id),
    excluded_by_compliance: excludedAnalysisRunIds(cwd, slugValue).has(run.run_id),
  }
}

export function analysisStatus(cwd, slugValue) {
  const f = files(cwd, slugValue)
  const planEvents = readJsonl(f.plan)
  const runs = readJsonl(f.runs)
  const last = runs.at(-1)
  return {
    slug: slugify(slugValue),
    dir: f.dir.slice(cwd.length + 1),
    plan: planEvents.length
      ? { version: planEvents.at(-1).version, hash: planEvents.at(-1).hash, question: planEvents.at(-1).plan.question, versions: planEvents.length }
      : null,
    runs: runs.length,
    failed: runs.filter((run) => run.exit_code !== 0 || run.timed_out).length,
    last_run: last
      ? { run_id: last.run_id, ts: last.ts, exit_code: last.exit_code, timed_out: Boolean(last.timed_out), duration_ms: last.duration_ms }
      : null,
    checks: analysisCheckStatus(cwd, slugValue),
  }
}

function manifestDiff(a, b) {
  const changed = []
  const push = (name, left, right) => {
    if (stableStringify(left) !== stableStringify(right)) changed.push({ field: name, from: left ?? null, to: right ?? null })
  }
  push('plan_hash', a.plan_hash, b.plan_hash)
  push('command', a.command, b.command)
  push('seed', a.seed, b.seed)
  push('network', a.network, b.network)
  push('exit_code', a.exit_code, b.exit_code)
  push('timed_out', Boolean(a.timed_out), Boolean(b.timed_out))
  const envDiff = {}
  for (const key of new Set([...Object.keys(a.environment || {}), ...Object.keys(b.environment || {})])) {
    if ((a.environment || {})[key] !== (b.environment || {})[key]) {
      envDiff[key] = { from: (a.environment || {})[key] ?? null, to: (b.environment || {})[key] ?? null }
    }
  }
  if (Object.keys(envDiff).length) changed.push({ field: 'environment', ...envDiff })
  const toMap = (side, kind) => new Map((side[kind] || []).map((entry) => [entry.path, entry.sha256 || entry.status || entry.error]))
  for (const kind of ['inputs', 'outputs']) {
    const left = toMap(a, kind)
    const right = toMap(b, kind)
    for (const path of new Set([...left.keys(), ...right.keys()])) {
      if (!left.has(path)) changed.push({ field: `${kind.slice(0, -1)}_added`, path })
      else if (!right.has(path)) changed.push({ field: `${kind.slice(0, -1)}_removed`, path })
      else if (left.get(path) !== right.get(path)) {
        changed.push({ field: `${kind.slice(0, -1)}_changed`, path, from: left.get(path), to: right.get(path) })
      }
    }
  }
  return changed
}

export function diffAnalysisRuns(cwd, slugValue, { a, b = null } = {}) {
  const runs = listAnalysisRuns(cwd, slugValue)
  const left = runs.find((run) => run.run_id === text(a))
  if (!left) throw new Error(`run "${a}" not found`)
  if (b) {
    const right = runs.find((run) => run.run_id === text(b))
    if (!right) throw new Error(`run "${b}" not found`)
    return { a: left.run_id, b: right.run_id, against_plan: false, changed: manifestDiff(left, right) }
  }
  const plan = currentPlan(cwd, slugValue)
  const current = {
    plan_hash: plan?.hash ?? null,
    command: left.command,
    seed: plan?.plan.seed ?? null,
    network: left.network,
    exit_code: left.exit_code,
    timed_out: left.timed_out,
    environment: left.environment,
    inputs: hashPaths(cwd, (plan?.plan.inputs ?? []).filter((entry) => typeof entry === 'string')),
    outputs: left.outputs,
  }
  return { a: left.run_id, b: 'current plan and inputs', against_plan: true, changed: manifestDiff(left, current) }
}

export async function runAnalysis({
  cwd, slug: slugValue, command, kind = 'other', notebook = null, engine = 'auto',
  env = null, inputs = null, outputs = null, seed = null,
  timeoutMs = DEFAULT_TIMEOUT_MS, network = false, capturePackages: wantPackages = false,
  notebookEntry = null,
}) {
  const f = files(cwd, slugValue)
  const plan = currentPlan(cwd, slugValue)
  if (!plan) throw new Error(`no frozen plan for analysis "${slugify(slugValue)}"; call plan first`)
  if (!Array.isArray(command) || !command.length || command.some((entry) => typeof entry !== 'string' || !entry.length)) {
    throw new Error('command must be a non-empty array of strings (no shell)')
  }
  const timeout = Number(timeoutMs)
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
    throw new Error(`timeout_ms must be between 1 and ${MAX_TIMEOUT_MS}`)
  }
  if (!ANALYSIS_KINDS.includes(kind)) throw new Error(`kind must be one of ${ANALYSIS_KINDS.join(', ')}`)
  const wantNetwork = Boolean(network)
  const extraEnv = explicitEnv(env)
  const inputPaths = listValue(inputs ?? plan.plan.inputs, 'inputs').filter((entry) => typeof entry === 'string')
  const outputPaths = listValue(outputs ?? plan.plan.outputs, 'outputs').filter((entry) => typeof entry === 'string')
  const baseRunId = `run-${nowIso().replace(/[-:]/g, '').replace(/\..+$/, '').replace(/Z$/, '')}-${shortHash(stableStringify({ command, plan: plan.hash, ts: nowIso() }), 6)}`

  ensureDir(f.dir)
  return withLock(f.dir, () => {
    let runId = baseRunId
    let runDir = join(f.runsDir, runId)
    for (let suffix = 2; existsSync(runDir); suffix += 1) {
      runId = `${baseRunId}-${suffix}`
      runDir = join(f.runsDir, runId)
    }
    ensureDir(join(runDir, 'artifacts'))
    let argv = command.map(String)
    let executedNotebook = null
    if (kind === 'notebook') {
      const nb = commandForNotebook({ notebook, engine }, cwd, slugValue, runId)
      argv = nb.argv
      executedNotebook = nb.executedNotebook
    }
    const inputHashes = hashPaths(cwd, inputPaths)
    // Snapshot the declared outputs before spawning. Without a prior state, a
    // file left over from an earlier run is hashed as if this run wrote it, and
    // a machine check would pass on bytes the re-execution never produced.
    const priorOutputs = new Map(hashPaths(cwd, outputPaths).map((entry) => [entry.path, outputStamp(cwd, entry)]))
    const started = Date.now()
    const spawnResult = spawnSync(argv[0], argv.slice(1), {
      cwd,
      env: { ...baseEnv(wantNetwork), ...extraEnv },
      encoding: 'utf8',
      timeout,
      maxBuffer: MAX_LOG_BYTES + 1024 * 1024,
      shell: false,
      killSignal: 'SIGKILL',
    })
    const durationMs = Date.now() - started
    const timedOut = spawnResult.error?.code === 'ETIMEDOUT'
    const spawnError = spawnResult.error && !timedOut
      ? text(spawnResult.error.message || spawnResult.error.code)
      : null
    const stdout = redactLog(capLog(spawnResult.stdout ?? ''), Object.entries(extraEnv))
    const stderr = redactLog(capLog(spawnResult.stderr ?? ''), Object.entries(extraEnv))
    writeFileSync(join(runDir, 'stdout.log'), stdout, 'utf8')
    writeFileSync(join(runDir, 'stderr.log'), stderr, 'utf8')

    const environment = interpreterEnvironment(kind, argv, cwd)
    environment.git_commit = gitCommit(cwd)
    environment.network = wantNetwork ? 'allowed' : 'discouraged (no_proxy=* set; not a firewall)'
    const packagesFile = wantPackages ? capturePackages(kind, argv, cwd, runDir) : null
    if (packagesFile) environment.packages_file = packagesFile.slice(cwd.length + 1)

    const outputHashes = hashPaths(cwd, outputPaths, { forWrite: true })
      .map((entry) => {
        const stamped = outputStamp(cwd, entry)
        return { ...entry, ...outputWriteStatus(priorOutputs.get(entry.path), entry, stamped.mtimeMs) }
      })
    const manifest = {
      run_id: runId,
      slug: slugify(slugValue),
      ts: nowIso(),
      plan_hash: plan.hash,
      plan_version: plan.version,
      command: argv,
      kind,
      seed: seed == null ? (plan.plan.seed ?? null) : Number(seed),
      timeout_ms: timeout,
      timed_out: timedOut,
      spawn_error: spawnError,
      exit_code: timedOut || spawnError ? null : (spawnResult.status ?? null),
      signal: spawnResult.signal ?? null,
      duration_ms: durationMs,
      inputs: inputHashes,
      outputs: outputHashes,
      environment,
      stdout: join(relative(cwd, runDir), 'stdout.log'),
      stderr: join(relative(cwd, runDir), 'stderr.log'),
      artifacts: [
        ...(executedNotebook ? [executedNotebook] : []),
        ...outputHashes.filter((entry) => entry.sha256).map((entry) => entry.path),
      ],
    }
    writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    appendJsonl(f.runs, [manifest])
    if (notebookEntry) {
      const status = timedOut ? 'timed out' : spawnError ? 'failed to start' : `exit ${manifest.exit_code}`
      appendNotebookEntryAt(notebookEntry.file, {
        id: notebookEntry.id || runId,
        timestamp: Date.now(),
        type: 'observation',
        title: `analysis run ${runId} ${status} (${kind})`,
        body: `Plan v${plan.version} ${plan.hash.slice(0, 18)}… · ${durationMs} ms · inputs ${inputHashes.length} · outputs ${outputHashes.filter((entry) => entry.written_by_run).length}/${outputHashes.length} written by this run. Reproducibility evidence is recorded in the manifest; the tool does not interpret the result.`,
        artifacts: [...manifest.artifacts, manifest.stdout, manifest.stderr],
        tags: ['analysis_run', `slug:${manifest.slug}`],
      })
    }
    return manifest
  }, { label: 'analysis run ledger' })
}

export function exportAnalysisRun({ cwd, slug: slugValue, runId, format = 'markdown', overwrite = false }) {
  const f = files(cwd, slugValue)
  const run = showAnalysisRun(cwd, slugValue, runId)
  const wanted = format === 'json' ? 'json' : 'markdown'
  const out = join(f.exports, `${run.run_id}.${wanted === 'json' ? 'json' : 'md'}`)
  let body
  if (wanted === 'json') {
    body = `${JSON.stringify(run, null, 2)}\n`
  } else {
    const lines = [
      `# Analysis run ${run.run_id}`,
      '',
      `**Slug:** ${run.slug} · **Kind:** ${run.kind} · **Plan:** v${run.plan_version} (${run.plan_hash})`,
      `**Started:** ${run.ts} · **Duration:** ${run.duration_ms} ms · **Exit:** ${run.exit_code ?? 'n/a'}${run.signal ? ` (signal ${run.signal})` : ''}${run.timed_out ? ' · TIMED OUT' : ''}${run.spawn_error ? ` · ${run.spawn_error}` : ''}`,
      '',
      '## Command',
      '',
      '```',
      run.command.join(' '),
      '```',
      '',
      '## Environment',
      '',
      ...Object.entries(run.environment || {}).map(([key, value]) => `- ${key}: ${value ?? 'null'}`),
      '',
      '## Inputs',
      '',
      '| Path | SHA-256 | Bytes |',
      '|---|---|---|',
      ...(run.inputs || []).map((entry) => `| ${mdCell(entry.path)} | ${entry.sha256 ? entry.sha256.slice(0, 23) : (entry.status || entry.error || '')} | ${entry.bytes ?? ''} |`),
      '',
      '## Outputs',
      '',
      ...(run.outputs || []).length
        ? run.outputs.map((entry) => `- ${entry.path}: ${entry.sha256 ? `sha256 ${entry.sha256.slice(0, 23)}… (${entry.bytes} bytes)` : (entry.status || entry.error || 'unknown')}`)
        : ['_none declared_'],
      '',
      '## Logs',
      '',
      `- stdout: ${run.stdout}`,
      `- stderr: ${run.stderr}`,
      '',
      ...(run.repro_check ? [
        '## Reported vs recomputed',
        '',
        run.repro_check.reproduction === true
          ? `Reproduction: **true** — ${run.repro_check.reason}`
          : run.repro_check.reproduction === false
            ? `Reproduction: **false** — ${run.repro_check.reason}`
            : `Reproduction: **not checked** — ${run.repro_check.reason}`,
        '',
        '| Metric | Reported | Recomputed | Delta | Status |',
        '|---|---|---|---|---|',
        ...(run.repro_check.metrics || []).map((metric) => `| ${mdCell(metric.name)} | ${metric.expected} | ${metric.actual ?? '—'} | ${metric.delta ?? '—'} | ${metric.status} |`),
        '',
      ] : []),
      ...(run.compliance ? [
        '## Task-rule compliance',
        '',
        `Verdict: **${run.compliance.verdict}** (${run.compliance.counts.satisfied} satisfied, ${run.compliance.counts.violated} violated, ${run.compliance.counts.not_checked} not checked)`,
        '',
        ...(run.compliance.rules || []).map((rule) => `- ${rule.status} · ${rule.rule_id}: ${rule.statement}${rule.reason ? ` — ${rule.reason}` : ''}`),
        '',
      ] : []),
      ...(run.excluded_by_compliance ? [
        '**Compliance exclusion:** a recorded violation keeps this run excluded from experiment best/dominance and repro_package, even if a later reading is compliant.',
        '',
      ] : []),
      'This report is reproducibility evidence — hashes, environment, and exit status — not a guarantee that the',
      'analysis is correct or that its result replicates. Re-run against the same plan hash to compare.',
      '',
    ]
    body = lines.join('\n')
  }
  const written = exportText(out, body, { overwrite })
  return { path: written.path.slice(cwd.length + 1), bytes: written.bytes }
}

/* ------------------------------------------------------- re-execution checks */

function parseError(message) {
  return { ok: false, reason: message }
}

function jsonValueAt(document, key) {
  if (!key || key === '$') return document
  const parts = String(key).replace(/^\$\.?/, '').split('.').filter(Boolean)
  let current = document
  for (const part of parts) {
    if (current == null) return undefined
    const indexed = part.match(/^(.+)\[(\d+)\]$/)
    if (indexed) {
      current = current[indexed[1]]
      if (current == null) return undefined
      current = current[Number(indexed[2])]
      continue
    }
    current = current[part]
  }
  return current
}

/** Minimal RFC-4180-friendly parser; enough for metric tables, no dependency. */
function parseDelimited(body, delimiter) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
      continue
    }
    if (char === '"') quoted = true
    else if (char === delimiter) {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      if (row.some((cell) => cell.trim() !== '')) rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') field += char
  }
  row.push(field)
  if (row.some((cell) => cell.trim() !== '')) rows.push(row)
  return rows
}

function parseMetricText(spec, body) {
  if (spec.format === 'json') {
    let document
    try {
      document = JSON.parse(body)
    } catch (error) {
      return parseError(`${spec.path} is not valid JSON (${error instanceof Error ? error.message : String(error)})`)
    }
    const value = jsonValueAt(document, spec.key)
    if (value === undefined) return parseError(`key "${spec.key || '$'}" was not found in ${spec.path}`)
    return { ok: true, value, raw: typeof value === 'object' ? stableStringify(value) : String(value) }
  }
  if (spec.format === 'csv' || spec.format === 'tsv') {
    const rows = parseDelimited(body, spec.format === 'csv' ? ',' : '\t')
    if (!rows.length) return parseError(`${spec.path} has no rows`)
    const header = rows[0].map((cell) => cell.trim())
    const keyColumn = spec.key_column || 'metric'
    const valueColumn = spec.column || 'value'
    if (spec.key) {
      const keyIndex = header.findIndex((cell) => cell === keyColumn)
      const valueIndex = header.findIndex((cell) => cell === valueColumn)
      if (keyIndex < 0) return parseError(`${spec.path} has no "${keyColumn}" column`)
      if (valueIndex < 0) return parseError(`${spec.path} has no "${valueColumn}" column`)
      const match = rows.slice(1).find((entry) => (entry[keyIndex] ?? '').trim() === spec.key)
      if (!match) return parseError(`row "${spec.key}" was not found in ${spec.path}`)
      return { ok: true, value: (match[valueIndex] ?? '').trim(), raw: (match[valueIndex] ?? '').trim() }
    }
    const declaredIndex = header.findIndex((cell) => cell === valueColumn)
    if (declaredIndex < 0) {
      return parseError(`${spec.path} has no "${valueColumn}" column (header: ${header.join(', ') || 'empty'}); name the value column with column:`)
    }
    const dataRow = spec.row != null && spec.row !== ''
      ? rows[1 + Number(spec.row)]
      : rows[1]
    if (!dataRow) return parseError(`${spec.path} has no ${spec.row != null && spec.row !== '' ? `data row ${spec.row}` : 'data row'}`)
    return { ok: true, value: (dataRow[declaredIndex] ?? '').trim(), raw: (dataRow[declaredIndex] ?? '').trim() }
  }
  if (spec.format === 'kv') {
    if (!spec.key) return parseError('format "kv" needs a key')
    const escaped = String(spec.key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = body.match(new RegExp(`^\\s*${escaped}\\s*[:=]\\s*(.+?)\\s*$`, 'm'))
    if (!match) return parseError(`${spec.key} was not found in ${spec.path}`)
    return { ok: true, value: match[1].trim(), raw: match[1].trim() }
  }
  if (spec.format === 'regex') {
    let pattern
    try {
      pattern = new RegExp(spec.pattern, 'm')
    } catch (error) {
      return parseError(`invalid pattern: ${error instanceof Error ? error.message : String(error)}`)
    }
    const match = body.match(pattern)
    if (!match) return parseError(`pattern did not match ${spec.path}`)
    const value = match.groups?.[spec.key] ?? match[1] ?? match[0]
    if (value == null) return parseError('the pattern has no capture group and no match')
    return { ok: true, value: String(value).trim(), raw: String(value).trim() }
  }
  return parseError(`unknown format "${spec.format}"`)
}

/**
 * A machine check may read only bytes the run itself hashed. A path the run did
 * not write, a missing file, or changed bytes is `not_checked` — never a pass.
 */
function hashedOutput(cwd, run, pathValue) {
  const path = text(pathValue)
  const entry = (run.outputs || []).find((output) => output.path === path)
  if (!entry) return { ok: false, entry: null, reason: `${path} is not an output of this run` }
  if (!entry.sha256) {
    return {
      ok: false, entry,
      reason: `${path} was not written and hashed by this run (${entry.status || entry.error || 'no hash'})`,
    }
  }
  if (entry.written_by_run === false) {
    return {
      ok: false, entry,
      reason: `${path} held these bytes before the run started and its modification time did not change, so this run cannot be credited with writing it (delete the output and re-run to prove ownership)`,
    }
  }
  if (entry.written_by_run === undefined) {
    return {
      ok: false, entry,
      reason: `${path} comes from a manifest that does not record write ownership, so this run cannot be credited with writing it`,
    }
  }
  let abs
  try {
    abs = resolveWorkspacePath(cwd, path)
  } catch (error) {
    return { ok: false, entry, reason: error instanceof Error ? error.message : String(error) }
  }
  if (!existsSync(abs)) return { ok: false, entry, reason: `${path} was written by this run but is no longer in the workspace` }
  if (statSync(abs).size > MAX_PARSE_BYTES) {
    return { ok: false, entry, reason: `${path} is larger than ${MAX_PARSE_BYTES / (1024 * 1024)}MB` }
  }
  let buffer
  try {
    buffer = readFileSync(abs)
  } catch (error) {
    return { ok: false, entry, reason: `${path} could not be re-read (${error instanceof Error ? error.message : String(error)})` }
  }
  const current = `sha256:${sha256(buffer)}`
  if (current !== entry.sha256) {
    return {
      ok: false, entry,
      reason: `${path} changed after this run (recorded ${entry.sha256.slice(0, 23)}, now ${current.slice(0, 23)})`,
      hashes: { recorded: entry.sha256, current },
    }
  }
  return { ok: true, entry, abs, body: buffer.toString('utf8'), sha256: entry.sha256 }
}

export function numericValue(raw) {
  const value = String(raw ?? '').trim().replace(/^["']|["']$/g, '').replace(/,/g, '')
  if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?%?$/.test(value)) return null
  const parsed = Number(value.replace(/%$/, ''))
  return Number.isFinite(parsed) ? parsed : null
}

function nonNegativeNumber(value, name, fallback = 0) {
  if (value == null || value === '') return fallback
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be a non-negative number`)
  return number
}

function normalizeExpectedMetric(input, index) {
  const name = `metrics[${index}]`
  const metric = objectValue(input, name)
  const label = text(metric.name)
  if (!label) throw new Error(`${name}.name is required`)
  const rawValue = metric.value
  const expected = typeof rawValue === 'number'
    ? rawValue
    : typeof rawValue === 'string' && rawValue.trim() !== ''
      ? Number(rawValue)
      : NaN
  if (!Number.isFinite(expected)) throw new Error(`${name}.value must be a finite number`)
  const path = relativePath(metric.path, `${name}.path`)
  const format = text(metric.format).toLowerCase() || inferFormat(path)
  if (!ANALYSIS_METRIC_FORMATS.includes(format)) {
    throw new Error(`${name}.format must be one of ${ANALYSIS_METRIC_FORMATS.join(', ')} (or inferable from a .json/.csv/.tsv path)`)
  }
  const tolerance = nonNegativeNumber(metric.tolerance, `${name}.tolerance`)
  const relative = nonNegativeNumber(metric.rel_tolerance, `${name}.rel_tolerance`)
  const normalized = { name: label, value: expected, path, format, tolerance, rel_tolerance: relative }
  for (const key of ['key', 'column', 'key_column', 'row', 'pattern', 'source', 'unit']) {
    if (typeof metric[key] === 'string' && metric[key].trim()) normalized[key] = metric[key].trim()
  }
  if (metric.row != null && typeof metric.row === 'number') normalized.row = String(metric.row)
  if (normalized.row != null) {
    const rowIndex = Number(normalized.row)
    if (!Number.isInteger(rowIndex) || rowIndex < 0) {
      throw new Error(`${name}.row must be a zero-based index into the rows after the header (0 is the first data row)`)
    }
  }
  if (format === 'regex' && !normalized.pattern) throw new Error(`${name}.pattern is required for format "regex"`)
  return normalized
}

function normalizeExpectedMetrics(input) {
  const list = Array.isArray(input) ? input : input?.metrics
  if (!Array.isArray(list) || !list.length) throw new Error('expected metrics must be a non-empty array')
  if (list.length > MAX_METRICS) throw new Error(`at most ${MAX_METRICS} expected metrics are accepted`)
  return list.map(normalizeExpectedMetric)
}

function latestSuccessfulRun(runs, planHash = null) {
  return [...runs].reverse().find((run) => run.exit_code === 0
    && !run.timed_out
    && !run.spawn_error
    && (!planHash || run.plan_hash === planHash)) || null
}

function environmentFingerprint(environment) {
  const out = {}
  for (const key of ENVIRONMENT_FINGERPRINT) {
    if (environment?.[key] != null) out[key] = environment[key]
  }
  return out
}

/**
 * Notebook commands embed the run-specific executed-notebook path. Compare the
 * notebook and engine, not the per-run output argument. Only this run's own
 * artifacts directory is stripped: a command pointing at another run's artifact
 * is a real entrypoint change and must stay visible.
 */
export function entrypointFingerprint(run) {
  if (!run) return null
  if (run.kind !== 'notebook') return run.command
  const own = run.run_id
    ? new RegExp(`[/\\\\]runs[/\\\\]${String(run.run_id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\]artifacts[/\\\\]`)
    : null
  return (run.command || []).filter((arg) => !arg.startsWith('--output=') && !(own && own.test(arg)))
}

export function latestExpectation(cwd, slugValue) {
  return readJsonl(files(cwd, slugValue).expectations).at(-1) || null
}

export async function expectAnalysisScores({
  cwd, slug: slugValue, metrics, reference = 'reported', referenceRunId = null, notes = null,
}) {
  const f = files(cwd, slugValue)
  const plan = currentPlan(cwd, slugValue)
  if (!plan) throw new Error(`no frozen plan for analysis "${slugify(slugValue)}"; call plan first`)
  const wanted = text(reference).toLowerCase() || 'reported'
  if (!ANALYSIS_REFERENCES.includes(wanted)) throw new Error(`reference must be one of ${ANALYSIS_REFERENCES.join(', ')}`)
  const normalized = normalizeExpectedMetrics(metrics)
  const runs = listAnalysisRuns(cwd, slugValue)
  const referenceRun = referenceRunId
    ? runs.find((run) => run.run_id === text(referenceRunId))
    : latestSuccessfulRun(runs, plan.hash)
  if (referenceRunId && !referenceRun) throw new Error(`run "${referenceRunId}" not found`)
  ensureDir(f.dir)
  return withLock(f.dir, () => {
    const previous = readJsonl(f.expectations)
    const latest = previous.at(-1) || null
    const payload = {
      plan_hash: plan.hash,
      plan_version: plan.version,
      reference: wanted,
      metrics: normalized,
      reference_run_id: referenceRun?.run_id ?? null,
      entrypoint: entrypointFingerprint(referenceRun),
      kind: referenceRun?.kind ?? null,
      environment: referenceRun ? environmentFingerprint(referenceRun.environment) : null,
      notes: text(notes) || null,
    }
    if (latest && stableStringify({ ...latest, expectation_id: undefined, version: undefined, created_at: undefined })
      === stableStringify({ ...payload, expectation_id: undefined, version: undefined, created_at: undefined })) {
      return { expectation: latest, unchanged: true, slug: slugify(slugValue) }
    }
    const version = (latest?.version ?? 0) + 1
    const event = {
      expectation_id: `e${String(version).padStart(4, '0')}`,
      version,
      created_at: nowIso(),
      ...payload,
    }
    appendJsonl(f.expectations, [event])
    return { expectation: event, unchanged: false, slug: slugify(slugValue) }
  }, { label: 'analysis expectation ledger' })
}

function metricComparison(metric, parsed) {
  if (!parsed.ok) return { status: 'not_checked', reason: parsed.reason }
  const actual = numericValue(parsed.raw ?? parsed.value)
  if (actual == null) return { status: 'not_checked', reason: `parsed value "${parsed.raw ?? parsed.value}" is not numeric` }
  const delta = actual - metric.value
  const allowed = Math.max(metric.tolerance, Math.abs(metric.value) * metric.rel_tolerance)
  const slack = 1e-9 * Math.max(1, Math.abs(metric.value))
  const status = Math.abs(delta) <= allowed + slack ? 'match' : 'mismatch'
  return { status, actual, delta, allowed, raw: parsed.raw ?? String(parsed.value) }
}

export async function verifyAnalysisScores({
  cwd, slug: slugValue, runId = null, allowEnvironmentDrift = false, allowEntrypointChange = false,
}) {
  const f = files(cwd, slugValue)
  const expectation = latestExpectation(cwd, slugValue)
  if (!expectation) throw new Error(`no declared expectations for analysis "${slugify(slugValue)}"; call action "expect" first`)
  const runs = listAnalysisRuns(cwd, slugValue)
  if (!runs.length) throw new Error(`no runs recorded for analysis "${slugify(slugValue)}"; run the analysis first`)
  const run = runId
    ? runs.find((entry) => entry.run_id === text(runId))
    : runs.at(-1)
  if (!run) throw new Error(`run "${runId}" not found`)

  const blockers = []
  if (run.timed_out) blockers.push('the re-execution timed out')
  else if (run.spawn_error) blockers.push(`the re-execution failed to start (${run.spawn_error})`)
  else if (run.exit_code !== 0) blockers.push(`the re-execution exited ${run.exit_code ?? 'unknown'}`)
  if (run.plan_hash !== expectation.plan_hash) {
    blockers.push(`the run followed plan ${run.plan_hash?.slice(0, 18) ?? '(unknown)'}, not the expected ${expectation.plan_hash.slice(0, 18)}`)
  }
  if (expectation.kind && run.kind !== expectation.kind) {
    blockers.push(`the re-execution kind changed (${expectation.kind} → ${run.kind})`)
  } else if (expectation.entrypoint && !allowEntrypointChange
    && stableStringify(entrypointFingerprint(run)) !== stableStringify(expectation.entrypoint)) {
    blockers.push('the re-execution entrypoint (command) differs from the declared one')
  }
  const recordedEnvironment = expectation.environment || {}
  const currentEnvironment = environmentFingerprint(run.environment)
  // An expectation declared before the first run has no captured environment to
  // drift from. Comparing against nothing would flag every key as changed and
  // block the check forever, so it is skipped — like the kind and entrypoint
  // comparisons above, which are guarded by the presence of a baseline.
  const hasEnvironmentBaseline = expectation.environment != null && Object.keys(recordedEnvironment).length > 0
  const environmentKeys = hasEnvironmentBaseline
    ? [...new Set([...Object.keys(recordedEnvironment), ...Object.keys(currentEnvironment)])]
    : []
  const environmentChanged = environmentKeys
    .filter((key) => String(recordedEnvironment[key] ?? '') !== String(currentEnvironment[key] ?? ''))
    .map((key) => ({ key, recorded: recordedEnvironment[key] ?? null, current: currentEnvironment[key] ?? null }))
  if (environmentChanged.length && !allowEnvironmentDrift) {
    blockers.push(`the interpreter environment changed (${environmentChanged.map((entry) => entry.key).join(', ')})`)
  }

  const metrics = expectation.metrics.map((metric) => {
    const owned = hashedOutput(cwd, run, metric.path)
    if (!owned.ok) {
      return {
        ...metric, status: 'not_checked', actual: null, delta: null,
        reason: owned.reason,
      }
    }
    const parsed = parseMetricText(metric, owned.body)
    const comparison = metricComparison(metric, parsed)
    return { ...metric, ...comparison, reason: comparison.reason ?? null }
  })

  const counts = { match: 0, mismatch: 0, not_checked: 0 }
  for (const metric of metrics) counts[metric.status] += 1
  let reproduction = null
  let reason = null
  if (blockers.length) {
    reason = blockers.join('; ')
    for (const metric of metrics) {
      metric.status = 'not_checked'
      metric.reason = `blocked: ${reason}`
    }
    counts.match = 0
    counts.mismatch = 0
    counts.not_checked = metrics.length
  } else if (counts.mismatch > 0) {
    reproduction = false
    reason = `${counts.mismatch} reported value(s) did not reproduce`
  } else if (counts.not_checked > 0 || counts.match === 0) {
    reproduction = null
    reason = counts.not_checked
      ? `${counts.not_checked} value(s) could not be recomputed`
      : 'no reported value could be checked'
  } else {
    reproduction = true
    reason = `all ${counts.match} reported value(s) reproduced within the declared tolerance`
  }

  const check = {
    schema_version: 1,
    tool: 'analysis_run',
    check: 'verify_scores',
    slug: slugify(slugValue),
    run_id: run.run_id,
    expectation_id: expectation.expectation_id,
    reference: expectation.reference,
    plan_hash: expectation.plan_hash,
    generated_at: nowIso(),
    entrypoint: entrypointFingerprint(run),
    environment: {
      baseline: hasEnvironmentBaseline,
      recorded: recordedEnvironment,
      current: currentEnvironment,
      changed: environmentChanged,
      note: hasEnvironmentBaseline
        ? null
        : 'the expectation was declared with no reference run, so there is no recorded environment to compare against',
    },
    reproduction,
    reason,
    counts,
    metrics: metrics.map((metric) => ({
      name: metric.name,
      expected: metric.value,
      actual: metric.actual ?? null,
      delta: metric.delta ?? null,
      allowed: metric.allowed ?? null,
      tolerance: metric.tolerance,
      rel_tolerance: metric.rel_tolerance,
      path: metric.path,
      format: metric.format,
      key: metric.key ?? metric.pattern ?? null,
      status: metric.status,
      reason: metric.reason,
    })),
  }
  return withLock(f.dir, () => {
    const runDir = join(f.runsDir, run.run_id)
    ensureDir(runDir)
    writeFileSync(join(runDir, 'repro_check.json'), `${JSON.stringify(check, null, 2)}\n`, 'utf8')
    const events = readJsonl(f.verifications)
    const event = {
      verification_id: `v${String(events.length + 1).padStart(4, '0')}`,
      ts: check.generated_at,
      run_id: run.run_id,
      expectation_id: expectation.expectation_id,
      reproduction,
      counts,
      reason,
      repro_check: join(relative(cwd, runDir), 'repro_check.json'),
    }
    appendJsonl(f.verifications, [event])
    return { slug: slugify(slugValue), check, verification: event }
  }, { label: 'analysis verification ledger' })
}

/* ------------------------------------------------------------- compliance */

function normalizeEvidence(input) {
  const map = new Map()
  if (input == null || input === '') return map
  if (!Array.isArray(input)) throw new Error('evidence must be an array')
  for (const raw of input) {
    const entry = objectValue(raw, 'evidence[]')
    const ruleId = text(entry.rule_id ?? entry.rule)
    if (!ruleId) throw new Error('evidence entries need a rule_id')
    let status = text(entry.status).toLowerCase()
    if (!status && typeof entry.satisfied === 'boolean') status = entry.satisfied ? 'satisfied' : 'violated'
    if (!['satisfied', 'violated', 'not_checked'].includes(status)) {
      throw new Error(`evidence for rule "${ruleId}" needs satisfied: true|false or status satisfied|violated|not_checked`)
    }
    map.set(ruleId, { status, detail: text(entry.detail) || null })
  }
  return map
}

function compareRuleValue(actual, op, expected) {
  const left = String(actual ?? '').trim()
  const right = String(expected ?? '').trim()
  const numeric = numericValue(left)
  if (['greater_than', 'less_than', 'min', 'max'].includes(op)) {
    if (numeric == null) return { status: 'not_checked', reason: `value "${left}" is not numeric` }
    const target = Number(expected)
    const ok = op === 'greater_than' ? numeric > target
      : op === 'less_than' ? numeric < target
        : op === 'min' ? numeric >= target
          : numeric <= target
    return { status: ok ? 'satisfied' : 'violated', actual: numeric, expected: target }
  }
  if (op === 'contains' || op === 'not_contains') {
    const found = left.includes(right)
    return { status: (op === 'contains' ? found : !found) ? 'satisfied' : 'violated', actual: left, expected: right }
  }
  if (op === 'matches') {
    let pattern
    try {
      pattern = new RegExp(String(expected))
    } catch (error) {
      return { status: 'not_checked', reason: `invalid pattern: ${error instanceof Error ? error.message : String(error)}` }
    }
    return { status: pattern.test(left) ? 'satisfied' : 'violated', actual: left, expected: right }
  }
  const equal = numeric != null && numericValue(right) != null
    ? numeric === Number(String(right).replace(/,/g, ''))
    : left === right
  const ok = op === 'equals' ? equal : !equal
  return { status: ok ? 'satisfied' : 'violated', actual: left, expected: right }
}

function evaluateRule(cwd, rule, evidence, run) {
  if (!rule.check) {
    const supplied = evidence.get(rule.id)
    return supplied
      ? { rule_id: rule.id, statement: rule.statement, status: supplied.status, reason: supplied.detail }
      : {
        rule_id: rule.id, statement: rule.statement, status: 'not_checked',
        reason: 'the rule has no machine check and no caller-supplied evidence',
      }
  }
  const check = rule.check
  const entry = (run.outputs || []).find((output) => output.path === check.path)
  if (!entry) {
    return {
      rule_id: rule.id, statement: rule.statement, status: 'not_checked',
      reason: `${check.path} is not an output of this run`, source: check.path,
    }
  }
  if (check.op === 'exists' || check.op === 'absent') {
    if (entry.error) {
      return {
        rule_id: rule.id, statement: rule.statement, status: 'not_checked',
        reason: `${check.path} could not be resolved (${entry.error}), so its presence is unknown`, source: check.path,
      }
    }
    // The manifest is the record of what the run wrote; a later deletion does
    // not turn a written output into a written nothing.
    const present = Boolean(entry.sha256)
    const ok = check.op === 'exists' ? present : !present
    return {
      rule_id: rule.id, statement: rule.statement, status: ok ? 'satisfied' : 'violated',
      expected: check.op, actual: present ? 'present' : 'absent', source: check.path,
    }
  }
  const owned = hashedOutput(cwd, run, check.path)
  if (!owned.ok) {
    return { rule_id: rule.id, statement: rule.statement, status: 'not_checked', reason: owned.reason, source: check.path }
  }
  const parsed = parseMetricText(check, owned.body)
  if (!parsed.ok) {
    return { rule_id: rule.id, statement: rule.statement, status: 'not_checked', reason: parsed.reason, source: check.path }
  }
  const compared = compareRuleValue(parsed.raw ?? parsed.value, check.op, check.value)
  return {
    rule_id: rule.id,
    statement: rule.statement,
    status: compared.status,
    expected: compared.expected ?? check.value,
    actual: compared.actual ?? parsed.raw ?? parsed.value,
    op: check.op,
    source: check.path,
    reason: compared.reason ?? null,
  }
}

export async function complianceAnalysisRun({
  cwd, slug: slugValue, runId = null, evidence = null, notes = null,
}) {
  const f = files(cwd, slugValue)
  const planEvents = readJsonl(f.plan)
  const current = planEvents.at(-1) || null
  if (!current) throw new Error(`no frozen plan for analysis "${slugify(slugValue)}"; call plan first`)
  const runs = listAnalysisRuns(cwd, slugValue)
  const run = runId
    ? runs.find((entry) => entry.run_id === text(runId))
    : runs.at(-1)
  if (!run) throw new Error(runId ? `run "${runId}" not found` : `no runs recorded for analysis "${slugify(slugValue)}"`)
  // The rules that governed this run are those of its plan version, not whatever
  // the current plan has become since.
  const plan = planEvents.find((entry) => entry.version === run.plan_version)
  if (!plan) throw new Error(`run "${run.run_id}" follows plan v${run.plan_version ?? '(unknown)'}, which is not in plan.jsonl`)
  const rules = plan.plan.task_rules || []
  if (!rules.length) throw new Error('the frozen plan declares no task_rules; add them with action=plan and new_version: true, then run again')
  const supplied = normalizeEvidence(evidence)

  let checks
  if (run.timed_out || run.spawn_error || run.exit_code !== 0) {
    const reason = run.timed_out
      ? 'the run timed out, so its solution cannot be checked'
      : run.spawn_error
        ? `the run failed to start (${run.spawn_error})`
        : `the run exited ${run.exit_code ?? 'unknown'}, so its solution cannot be checked`
    checks = rules.map((rule) => ({ rule_id: rule.id, statement: rule.statement, status: 'not_checked', reason }))
  } else {
    checks = rules.map((rule) => evaluateRule(cwd, rule, supplied, run))
  }
  const counts = { satisfied: 0, violated: 0, not_checked: 0 }
  for (const check of checks) counts[check.status] += 1
  const verdict = counts.violated > 0
    ? 'violated'
    : counts.not_checked > 0
      ? 'not_checked'
      : 'compliant'

  const record = {
    schema_version: 1,
    tool: 'analysis_run',
    check: 'compliance',
    compliance_id: null,
    ts: nowIso(),
    slug: slugify(slugValue),
    run_id: run.run_id,
    plan_hash: plan.hash,
    plan_version: plan.version,
    verdict,
    counts,
    rules: checks,
    notes: text(notes) || null,
    note: 'A violated rule excludes the run from best, repro_package, and deposit. It is a recorded reading of the declared rules, not a misconduct verdict.',
  }
  ensureDir(f.dir)
  return withLock(f.dir, () => {
    const events = readJsonl(f.compliance)
    record.compliance_id = `c${String(events.length + 1).padStart(4, '0')}`
    appendJsonl(f.compliance, [record])
    const runDir = join(f.runsDir, run.run_id)
    ensureDir(runDir)
    writeFileSync(join(runDir, 'compliance.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    return { slug: slugify(slugValue), compliance: record }
  }, { label: 'analysis compliance ledger' })
}

export function latestCompliance(cwd, slugValue) {
  const map = new Map()
  for (const event of readJsonl(files(cwd, slugValue).compliance)) map.set(event.run_id, event)
  return map
}

export function excludedAnalysisRunIds(cwd, slugValue) {
  const excluded = new Set()
  // Sticky: any recorded violation keeps the run discarded. A later reading
  // cannot launder it back into best/dominance or the package.
  for (const event of readJsonl(files(cwd, slugValue).compliance)) {
    if (event.verdict === 'violated') excluded.add(event.run_id)
  }
  return excluded
}

/**
 * The compliance record that discarded the run. Sticky exclusion must cite the
 * violating reading, never the latest one: a re-check that passes would otherwise
 * erase the rule ids and name a record showing no violation at all.
 */
function violationRecord(events) {
  const violated = events.filter((event) => event.verdict === 'violated')
  const first = violated[0]
  if (!first) return null
  const rules = new Map()
  for (const event of violated) {
    for (const rule of event.rules || []) {
      if (rule.status === 'violated' && !rules.has(rule.rule_id)) rules.set(rule.rule_id, rule)
    }
  }
  return {
    ...first,
    rules: [...rules.values()],
    violation_count: violated.length,
    violation_ids: violated.map((event) => event.compliance_id),
  }
}

/** Whether a run id exists here. Fails closed on an unreadable ledger. */
export function hasAnalysisRun(cwd, slugValue, runId) {
  const wanted = text(runId)
  if (!wanted) return false
  if (slugValue) return listAnalysisRuns(cwd, slugValue).some((run) => run.run_id === wanted)
  const root = join(cwd, '.dsh', 'analysis')
  if (!existsSync(root)) return false
  let dirs
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch (error) {
    throw new Error(`cannot list the analysis ledgers: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const slug of dirs) {
    let runs
    try {
      runs = listAnalysisRuns(cwd, slug)
    } catch (error) {
      throw new Error(`cannot read the run ledger for analysis "${slug}": ${error instanceof Error ? error.message : String(error)}`)
    }
    if (runs.some((run) => run.run_id === wanted)) return true
  }
  return false
}

/** Every violated analysis run in the workspace, keyed for foreign-ledger lookups. */
export function excludedAnalysisRunIndex(cwd, { targets = null } = {}) {
  const byRun = new Map()
  const bySlug = new Map()
  const root = join(cwd, '.dsh', 'analysis')
  if (!existsSync(root)) return { by_run: byRun, by_slug: bySlug }
  let dirs
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch (error) {
    throw new Error(`cannot list the analysis ledgers: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const slug of dirs) {
    if (targets) {
      const scoped = targets.some((target) => target.slug === slug)
      const bare = targets.filter((target) => !target.slug)
      if (!scoped && !bare.length) continue
      if (!scoped) {
        let runs
        try {
          runs = listAnalysisRuns(cwd, slug)
        } catch (error) {
          throw new Error(`cannot read the run ledger for analysis "${slug}": ${error instanceof Error ? error.message : String(error)}`)
        }
        if (!bare.some((target) => runs.some((run) => run.run_id === target.analysis_run_id))) continue
      }
    }
    let events
    try {
      events = readJsonl(files(cwd, slug).compliance)
    } catch (error) {
      throw new Error(`cannot read the compliance ledger for analysis "${slug}": ${error instanceof Error ? error.message : String(error)}`)
    }
    const violations = new Map()
    for (const event of events) {
      if (event.verdict !== 'violated') continue
      if (!violations.has(event.run_id)) violations.set(event.run_id, [])
      violations.get(event.run_id).push(event)
    }
    if (!violations.size) continue
    bySlug.set(slug, new Set(violations.keys()))
    for (const [runId, runEvents] of violations) {
      byRun.set(runId, { slug, run_id: runId, compliance: violationRecord(runEvents) })
    }
  }
  return { by_run: byRun, by_slug: bySlug }
}

/* ----------------------------------------------- persisted check summaries */

export function readRunChecks(cwd, slugValue, runId) {
  const dir = join(files(cwd, slugValue).runsDir, text(runId))
  return {
    repro_check: readJson(join(dir, 'repro_check.json')),
    compliance: readJson(join(dir, 'compliance.json')),
  }
}

export function analysisCheckStatus(cwd, slugValue) {
  const expectations = readJsonl(files(cwd, slugValue).expectations)
  const verifications = readJsonl(files(cwd, slugValue).verifications)
  const complianceEvents = readJsonl(files(cwd, slugValue).compliance)
  const latest = latestCompliance(cwd, slugValue)
  const violated = [...new Set(complianceEvents.filter((entry) => entry.verdict === 'violated').map((entry) => entry.run_id))]
  return {
    expectations: expectations.length,
    latest_expectation: expectations.at(-1) || null,
    verifications: verifications.length,
    latest_verification: verifications.at(-1) || null,
    compliance: {
      checked: latest.size,
      violated,
      not_checked: [...latest.values()]
        .filter((entry) => entry.verdict === 'not_checked' && !violated.includes(entry.run_id))
        .map((entry) => entry.run_id),
    },
  }
}
