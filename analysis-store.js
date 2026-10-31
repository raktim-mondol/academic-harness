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
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import {
  appendJsonl, ensureDir, exportText, hashFile, mdCell, nowIso, readJsonl,
  sha256, shortHash, slug as slugify, stableStringify,
} from './ledger-kit.js'
import { withLock } from './store-lock.js'
import { resolveWorkspacePath } from './workspace-path.js'
import { appendNotebookEntryAt } from './notebook.js'

export const ANALYSIS_KINDS = ['python', 'r', 'shell', 'node', 'notebook', 'other']
export const ANALYSIS_EXPORT_FORMATS = ['json', 'markdown']

const PLAN_LIST_FIELDS = [
  'hypotheses', 'inputs', 'outputs', 'variables', 'primary_outcomes',
  'secondary_outcomes', 'exclusions', 'sensitivity_analyses',
]
const PLAN_TEXT_FIELDS = ['methods', 'corrections', 'missing_data_rules', 'stopping_rules', 'software', 'notes']
const MAX_LOG_BYTES = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 600_000
const MAX_TIMEOUT_MS = 3_600_000
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
  return { ...run, stdout_tail: tail(run.stdout), stderr_tail: tail(run.stderr) }
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
        body: `Plan v${plan.version} ${plan.hash.slice(0, 18)}… · ${durationMs} ms · inputs ${inputHashes.length} · outputs ${outputHashes.filter((entry) => entry.sha256).length}/${outputHashes.length} written. Reproducibility evidence is recorded in the manifest; the tool does not interpret the result.`,
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
      'This report is reproducibility evidence — hashes, environment, and exit status — not a guarantee that the',
      'analysis is correct or that its result replicates. Re-run against the same plan hash to compare.',
      '',
    ]
    body = lines.join('\n')
  }
  const written = exportText(out, body, { overwrite })
  return { path: written.path.slice(cwd.length + 1), bytes: written.bytes }
}
