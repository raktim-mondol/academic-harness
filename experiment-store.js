/**
 * Experiment-log ledger: a structured run registry for sweeps, simulations,
 * pilots, and model comparisons under `<cwd>/.dsh/experiments/<slug>/`.
 *
 *   experiment.json  write-once definition (question, metric directions)
 *   runs.jsonl       append-only runs (params, metrics, artifacts, seed, env)
 *   links.jsonl      append-only links to notebook entries, results, papers
 *   exports/         csv/json/markdown/mlflow exports
 *
 * A rerun is a new run — nothing is deduplicated, and "best" is always by a
 * named metric with an explicit direction.
 */
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import {
  appendJsonl, csvCell, ensureDir, exportText, hashFile, mdCell, nowIso,
  readJson, readJsonl, slug as slugify, writeOnceJson,
} from './ledger-kit.js'
import { withLock } from './store-lock.js'
import { resolveWorkspacePath } from './workspace-path.js'

export const EXPERIMENT_DIRECTIONS = ['higher', 'lower']
export const EXPERIMENT_EXPORT_FORMATS = ['csv', 'json', 'markdown', 'mlflow']
export const LINK_TARGET_KINDS = ['notebook', 'scientific_result', 'analysis_run', 'experiment_run', 'paper', 'review']

function text(value) {
  return String(value ?? '').trim()
}

function files(cwd, slugValue) {
  const dir = join(cwd, '.dsh', 'experiments', slugify(slugValue))
  return {
    dir,
    experiment: join(dir, 'experiment.json'),
    runs: join(dir, 'runs.jsonl'),
    links: join(dir, 'links.jsonl'),
    exports: join(dir, 'exports'),
  }
}

function objectValue(value, name) {
  if (value == null || value === '') return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}

function normalizeMetrics(input) {
  if (input == null || input === '') return []
  if (!Array.isArray(input)) throw new Error('metrics must be an array')
  const out = []
  const seen = new Set()
  for (const entry of input) {
    const name = typeof entry === 'string' ? entry.trim() : text(entry?.name)
    if (!name) throw new Error('every metric needs a name')
    if (seen.has(name)) throw new Error(`duplicate metric ${name}`)
    seen.add(name)
    const direction = typeof entry === 'string' ? null : text(entry?.direction).toLowerCase()
    if (direction && !EXPERIMENT_DIRECTIONS.includes(direction)) {
      throw new Error(`metric ${name} direction must be one of ${EXPERIMENT_DIRECTIONS.join(', ')}`)
    }
    out.push({ name, direction: direction || null })
  }
  return out
}

export async function startExperiment({ cwd, slug: slugValue, experiment = {} }) {
  const f = files(cwd, slugValue)
  const question = text(experiment.question)
  if (!question) throw new Error('experiment.question is required')
  const stored = {
    slug: slugify(slugValue),
    name: text(experiment.name) || slugify(slugValue),
    question,
    metrics: normalizeMetrics(experiment.metrics),
    notes: text(experiment.notes) || null,
    created_at: nowIso(),
  }
  ensureDir(f.dir)
  return withLock(f.dir, () => {
    if (readJson(f.experiment)) {
      if (!experiment.resume) {
        throw new Error(`experiment "${stored.slug}" already exists; pass resume: true to continue it`)
      }
      return { experiment: readJson(f.experiment), resumed: true }
    }
    writeOnceJson(f.experiment, stored)
    return { experiment: stored, resumed: false }
  }, { label: 'experiment ledger' })
}

export function readExperiment(cwd, slugValue) {
  const f = files(cwd, slugValue)
  const stored = readJson(f.experiment)
  if (!stored) throw new Error(`experiment "${slugify(slugValue)}" not found under ${f.dir.slice(cwd.length + 1)}`)
  return stored
}

function gitCommit(cwd) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 10_000, shell: false })
  if (result.status !== 0) return null
  return text(result.stdout) || null
}

function hashArtifacts(cwd, artifacts) {
  if (artifacts == null || artifacts === '') return []
  if (!Array.isArray(artifacts)) throw new Error('artifacts must be an array of workspace-relative paths')
  return artifacts.map((rel) => {
    if (typeof rel !== 'string' || !rel.trim()) throw new Error('artifact paths must be non-empty strings')
    const abs = resolveWorkspacePath(cwd, rel)
    return { path: rel, sha256: `sha256:${hashFile(abs)}` }
  })
}

function metricValues(input, definition) {
  const metrics = objectValue(input, 'metrics')
  const out = {}
  for (const [name, value] of Object.entries(metrics)) {
    if (value == null) continue
    const number = Number(value)
    if (!Number.isFinite(number)) throw new Error(`metric ${name} must be a finite number (missing metrics should be omitted, not zeroed)`)
    out[name] = number
  }
  const declared = new Set((definition?.metrics || []).map((entry) => entry.name))
  const undeclared = Object.keys(out).filter((name) => !declared.has(name))
  return { values: out, undeclared }
}

export async function logExperimentRun({ cwd, slug: slugValue, params, metrics, artifacts, seed = null, parent = null, notes = null, environment = null }) {
  const f = files(cwd, slugValue)
  const definition = readExperiment(cwd, slugValue)
  const paramsObject = objectValue(params, 'params')
  const { values, undeclared } = metricValues(metrics, definition)
  const hashed = hashArtifacts(cwd, artifacts)
  const seedNumber = seed == null || seed === '' ? null : Number(seed)
  if (seedNumber != null && !Number.isFinite(seedNumber)) throw new Error('seed must be a number')
  const parentRun = text(parent)
  return withLock(f.dir, () => {
    const runs = readJsonl(f.runs)
    if (parentRun && !runs.some((run) => run.run_id === parentRun)) {
      throw new Error(`parent run "${parentRun}" not found`)
    }
    const runId = `x${String(runs.length + 1).padStart(4, '0')}`
    const event = {
      run_id: runId,
      ts: nowIso(),
      experiment: definition.slug,
      params: paramsObject,
      metrics: values,
      artifacts: hashed,
      seed: seedNumber,
      parent: parentRun || null,
      notes: text(notes) || null,
      environment: {
        node: process.version,
        os: `${os.type()} ${os.release()}`,
        git_commit: gitCommit(cwd),
        ...objectValue(environment, 'environment'),
      },
    }
    appendJsonl(f.runs, [event])
    return { run: event, undeclared_metrics: undeclared }
  }, { label: 'experiment ledger' })
}

export function listExperimentRuns(cwd, slugValue) {
  return readJsonl(files(cwd, slugValue).runs)
}

export function listExperimentLinks(cwd, slugValue) {
  return readJsonl(files(cwd, slugValue).links)
}

function metricNames(definition, runs) {
  const names = new Set(definition.metrics.map((entry) => entry.name))
  for (const run of runs) for (const name of Object.keys(run.metrics)) names.add(name)
  return [...names]
}

function bestRun(runs, name, direction) {
  const scored = runs.filter((run) => run.metrics[name] != null)
  if (!scored.length) return null
  const better = direction === 'lower'
    ? (a, b) => a.metrics[name] < b.metrics[name]
    : (a, b) => a.metrics[name] > b.metrics[name]
  return scored.reduce((best, run) => (better(run, best) ? run : best))
}

export function compareExperiments(cwd, slugValue, { field = null } = {}) {
  const definition = readExperiment(cwd, slugValue)
  const runs = listExperimentRuns(cwd, slugValue)
  if (!runs.length) return { experiment: definition, runs: [], metrics: [], best: {}, note: 'No runs logged yet.' }
  const metrics = metricNames(definition, runs)
  const directions = Object.fromEntries(definition.metrics.map((entry) => [entry.name, entry.direction || 'higher']))
  const best = {}
  for (const name of metrics) {
    const winner = bestRun(runs, name, directions[name])
    if (winner) best[name] = { run_id: winner.run_id, value: winner.metrics[name], direction: directions[name] || 'higher' }
  }
  let grouped = null
  if (field) {
    const groups = new Map()
    for (const run of runs) {
      const key = run.params?.[field]
      const label = key == null ? '(missing)' : String(key)
      if (!groups.has(label)) groups.set(label, [])
      groups.get(label).push(run)
    }
    grouped = [...groups.entries()].map(([label, members]) => ({
      value: label,
      runs: members.length,
      best: Object.fromEntries(metrics.flatMap((name) => {
        const winner = bestRun(members, name, directions[name] || 'higher')
        return winner ? [[name, { run_id: winner.run_id, value: winner.metrics[name] }]] : []
      })),
    }))
  }
  return {
    experiment: definition,
    metrics,
    directions,
    runs: runs.map((run) => ({
      run_id: run.run_id,
      ts: run.ts,
      seed: run.seed,
      params: run.params,
      metrics: run.metrics,
      artifact_count: run.artifacts.length,
    })),
    best,
    grouped,
  }
}

export function bestExperimentRun(cwd, slugValue, { metric, direction = null } = {}) {
  const definition = readExperiment(cwd, slugValue)
  const name = text(metric)
  if (!name) throw new Error('best requires a named metric (there is no implicit best model)')
  const declared = definition.metrics.find((entry) => entry.name === name)
  const wanted = text(direction).toLowerCase() || declared?.direction
  if (!wanted) {
    throw new Error(`metric "${name}" has no direction; pass direction: higher|lower explicitly`)
  }
  if (!EXPERIMENT_DIRECTIONS.includes(wanted)) throw new Error(`direction must be one of ${EXPERIMENT_DIRECTIONS.join(', ')}`)
  const runs = listExperimentRuns(cwd, slugValue)
  const winner = bestRun(runs, name, wanted)
  if (!winner) throw new Error(`no run records metric "${name}"`)
  const tied = runs.filter((run) => run.metrics[name] === winner.metrics[name])
  return { metric: name, direction: wanted, run: winner, tied_runs: tied.map((run) => run.run_id) }
}

export async function linkExperimentRun({ cwd, slug: slugValue, runId, targetKind, targetId, note = null }) {
  const f = files(cwd, slugValue)
  const run = listExperimentRuns(cwd, slugValue).find((entry) => entry.run_id === text(runId))
  if (!run) throw new Error(`run "${runId}" not found`)
  const kind = text(targetKind)
  if (!LINK_TARGET_KINDS.includes(kind)) throw new Error(`target_kind must be one of ${LINK_TARGET_KINDS.join(', ')}`)
  const id = text(targetId)
  if (!id) throw new Error('target_id is required')
  return withLock(f.dir, () => {
    const event = { run_id: run.run_id, ts: nowIso(), target: { kind, id }, note: text(note) || null }
    appendJsonl(f.links, [event])
    return { link: event }
  }, { label: 'experiment ledger' })
}

export function experimentStatus(cwd, slugValue) {
  const f = files(cwd, slugValue)
  const definition = readExperiment(cwd, slugValue)
  const runs = readJsonl(f.runs)
  const links = readJsonl(f.links)
  return {
    slug: definition.slug,
    name: definition.name,
    question: definition.question,
    dir: f.dir.slice(cwd.length + 1),
    metrics: definition.metrics,
    runs: runs.length,
    last_run: runs.at(-1)?.run_id ?? null,
    links: links.length,
  }
}

function runsCsv(definition, runs) {
  const metrics = metricNames(definition, runs)
  const params = [...new Set(runs.flatMap((run) => Object.keys(run.params || {})))]
  const header = ['run_id', 'ts', 'seed', 'parent', ...params, ...metrics, 'artifacts', 'notes']
  const lines = [header.map(csvCell).join(',')]
  for (const run of runs) {
    lines.push([
      run.run_id, run.ts, run.seed ?? '', run.parent ?? '',
      ...params.map((name) => run.params?.[name] ?? ''),
      ...metrics.map((name) => run.metrics?.[name] ?? ''),
      run.artifacts.map((entry) => entry.path).join('; '),
      run.notes ?? '',
    ].map(csvCell).join(','))
  }
  return `${lines.join('\n')}\n`
}

function runsMarkdown(definition, runs, links) {
  const metrics = metricNames(definition, runs)
  const directions = Object.fromEntries(definition.metrics.map((entry) => [entry.name, entry.direction || 'higher']))
  const lines = [
    `# Experiment: ${definition.name}`,
    '',
    `**Question:** ${definition.question}`,
    definition.notes ? `**Notes:** ${definition.notes}` : null,
    '',
    '## Runs',
    '',
    `| Run | ${['ts', ...metrics.map((name) => `${name} (${directions[name] || 'higher'})`), 'artifacts', 'notes'].join(' | ')} |`,
    `|---|${Array(metrics.length + 4).fill('---').join('|')}|`,
  ].filter((entry) => entry !== null)
  for (const run of runs) {
    lines.push(`| ${run.run_id} | ${run.ts} | ${metrics.map((name) => (run.metrics[name] == null ? '' : mdCell(run.metrics[name]))).join(' | ')} | ${run.artifacts.length} | ${mdCell(run.notes || '')} |`)
  }
  const bestLines = metrics.flatMap((name) => {
    const winner = bestRun(runs, name, directions[name] || 'higher')
    return winner ? [`- ${name} (${directions[name] || 'higher'}): ${winner.run_id} = ${winner.metrics[name]}`] : []
  })
  if (bestLines.length) lines.push('', '## Best per named metric', '', ...bestLines)
  if (links.length) {
    lines.push('', '## Links', '', ...links.map((link) => `- ${link.run_id} → ${link.target.kind}:${link.target.id}${link.note ? ` (${link.note})` : ''}`))
  }
  lines.push('', 'Logged runs and metrics as recorded. No metric here is a scientific claim, and missing values stay blank.', '')
  return lines.join('\n')
}

function runsMlflow(definition, runs) {
  return {
    experiment: { experiment_id: definition.slug, name: definition.name, tags: { question: definition.question } },
    runs: runs.map((run) => ({
      info: {
        run_id: run.run_id,
        run_uuid: run.run_id,
        experiment_id: definition.slug,
        start_time: new Date(run.ts).getTime() * 1000,
        status: 'FINISHED',
      },
      data: {
        tags: { ...Object.fromEntries(Object.entries(run.params || {}).map(([key, value]) => [`param:${key}`, String(value)])), ...(run.seed != null ? { seed: String(run.seed) } : {}) },
        params: Object.fromEntries(Object.entries(run.params || {}).map(([key, value]) => [key, String(value)])),
        metrics: Object.entries(run.metrics || {}).map(([key, value]) => ({ key, value, timestamp: new Date(run.ts).getTime() * 1000 })),
        artifacts: (run.artifacts || []).map((entry) => ({ path: entry.path, tags: [] })),
      },
    })),
  }
}

export function exportExperiment({ cwd, slug: slugValue, format = 'markdown', overwrite = false }) {
  const f = files(cwd, slugValue)
  const definition = readExperiment(cwd, slugValue)
  const runs = readJsonl(f.runs)
  const links = readJsonl(f.links)
  const wanted = text(format).toLowerCase()
  if (!EXPERIMENT_EXPORT_FORMATS.includes(wanted)) {
    throw new Error(`format must be one of ${EXPERIMENT_EXPORT_FORMATS.join(', ')}`)
  }
  let name
  let body
  if (wanted === 'csv') {
    name = 'runs.csv'
    body = runsCsv(definition, runs)
  } else if (wanted === 'json') {
    name = 'experiment.json'
    body = `${JSON.stringify({ experiment: definition, runs, links }, null, 2)}\n`
  } else if (wanted === 'mlflow') {
    name = 'mlflow.json'
    body = `${JSON.stringify(runsMlflow(definition, runs), null, 2)}\n`
  } else {
    name = 'report.md'
    body = runsMarkdown(definition, runs, links)
  }
  const written = exportText(join(f.exports, name), body, { overwrite })
  return { format: wanted, path: written.path.slice(cwd.length + 1), bytes: written.bytes }
}
