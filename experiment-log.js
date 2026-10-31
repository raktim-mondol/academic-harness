/**
 * experiment_log: action-multiplexed experiment registry for runs that are not
 * a single pre-registered analysis — sweeps, simulations, pilots, comparisons.
 *
 * State lives under `<cwd>/.dsh/experiments/<slug>/` (experiment-store.js).
 * The tool records what was logged and never claims a scientific result.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  EXPERIMENT_DIRECTIONS, EXPERIMENT_EXPORT_FORMATS, LINK_TARGET_KINDS,
  bestExperimentRun, compareExperiments, experimentStatus, exportExperiment,
  linkExperimentRun, listExperimentLinks, listExperimentRuns, logExperimentRun,
  readExperiment, startExperiment,
} from './experiment-store.js'

const ACTIONS = ['start', 'log', 'compare', 'best', 'link', 'status', 'list', 'show', 'export']

function text(value) {
  return String(value ?? '').trim()
}

function requireString(value, name) {
  const result = text(value)
  if (!result) throw new Error(`${name} is required`)
  return result
}

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function renderRunLine(run) {
  const metrics = Object.entries(run.metrics).map(([key, value]) => `${key}=${value}`).join(', ')
  const params = Object.entries(run.params).map(([key, value]) => `${key}=${value}`).join(', ')
  return `- ${run.run_id} · ${run.ts}${run.seed != null ? ` · seed ${run.seed}` : ''}${params ? ` · ${params}` : ''}${metrics ? ` · ${metrics}` : ''}${run.artifacts.length ? ` · ${run.artifacts.length} artifact(s)` : ''}`
}

function renderValue(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  switch (value.action) {
    case 'start': {
      const e = value.experiment
      const metrics = e.metrics.length ? `\nMetrics: ${e.metrics.map((m) => `${m.name}${m.direction ? ` (${m.direction})` : ''}`).join(', ')}` : ''
      return [{ type: 'text', text: `Experiment "${e.slug}" ${value.resumed ? 'resumed' : 'started'}: ${e.question}${metrics}` }]
    }
    case 'log': {
      const undeclared = value.undeclared_metrics.length
        ? `\nUndeclared metrics (recorded, not defined at start): ${value.undeclared_metrics.join(', ')}`
        : ''
      return [{ type: 'text', text: `Logged ${value.run.run_id} (${Object.keys(value.run.metrics).length} metric(s), ${value.run.artifacts.length} artifact(s)).${undeclared}` }]
    }
    case 'compare': {
      const lines = [`Experiment "${value.comparison.experiment.slug}" — ${value.comparison.runs.length} run(s).`]
      if (value.comparison.note) return [{ type: 'text', text: lines[0] } ]
      lines.push('', ...value.comparison.runs.map(renderRunLine))
      const best = Object.entries(value.comparison.best)
      if (best.length) lines.push('', 'Best per named metric:', ...best.map(([name, entry]) => `- ${name} (${entry.direction}): ${entry.run_id} = ${entry.value}`))
      if (value.comparison.grouped) {
        lines.push('', `Grouped by param "${value.field}":`, ...value.comparison.grouped.map((group) => `- ${group.value}: ${group.runs} run(s)`))
      }
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'best': {
      const lines = [
        `Best by ${value.best.metric} (${value.best.direction}): ${value.best.run.run_id} = ${value.best.run.metrics[value.best.metric]}`,
        renderRunLine(value.best.run),
      ]
      if (value.best.tied_runs.length > 1) lines.push(`Tied runs: ${value.best.tied_runs.join(', ')}`)
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'link':
      return [{ type: 'text', text: `Linked ${value.link.run_id} → ${value.link.target.kind}:${value.link.target.id}.` }]
    case 'status': {
      const s = value.status
      return [{ type: 'text', text: [
        `Experiment "${s.slug}" at ${s.dir}`,
        `Question: ${s.question}`,
        `Runs: ${s.runs}${s.last_run ? ` (last ${s.last_run})` : ''} · links: ${s.links}`,
        s.metrics.length ? `Metrics: ${s.metrics.map((m) => `${m.name}${m.direction ? ` (${m.direction})` : ''}`).join(', ')}` : 'Metrics: none declared.',
      ].join('\n') }]
    }
    case 'list':
      return [{ type: 'text', text: value.runs.length ? value.runs.map(renderRunLine).join('\n') : 'No runs logged yet.' }]
    case 'show': {
      const lines = [renderRunLine(value.run).slice(2), `params: ${JSON.stringify(value.run.params)}`, `environment: ${JSON.stringify(value.run.environment)}`]
      if (value.run.artifacts.length) lines.push('artifacts:', ...value.run.artifacts.map((entry) => `- ${entry.path} (${entry.sha256.slice(0, 18)}…)`))
      if (value.links.length) lines.push('links:', ...value.links.map((link) => `- ${link.target.kind}:${link.target.id}${link.note ? ` — ${link.note}` : ''}`))
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'export':
      return [{ type: 'text', text: `Wrote ${value.path} (${value.bytes} bytes, ${value.format}).` }]
    default:
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }
}

export async function runExperimentAction(args, exec) {
  const action = args.action || 'status'
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  const slug = requireString(args.slug, 'slug')

  if (action === 'start') {
    const { experiment, resumed } = await startExperiment({ cwd, slug, experiment: { ...args.experiment, question: args.question ?? args.experiment?.question, resume: args.resume ?? args.experiment?.resume } })
    return { action, experiment, resumed }
  }

  if (action === 'log') {
    const { run, undeclared_metrics } = await logExperimentRun({
      cwd, slug,
      params: args.params,
      metrics: args.metrics,
      artifacts: args.artifacts,
      seed: args.seed,
      parent: args.parent,
      notes: args.notes,
      environment: args.environment,
    })
    return { action, run, undeclared_metrics }
  }

  if (action === 'compare') {
    return { action, field: args.field || null, comparison: compareExperiments(cwd, slug, { field: args.field }) }
  }

  if (action === 'best') {
    return { action, best: bestExperimentRun(cwd, slug, { metric: requireString(args.metric, 'metric'), direction: args.direction }) }
  }

  if (action === 'link') {
    const { link } = await linkExperimentRun({
      cwd, slug,
      runId: requireString(args.run_id, 'run_id'),
      targetKind: requireString(args.target_kind, 'target_kind'),
      targetId: requireString(args.target_id, 'target_id'),
      note: args.note,
    })
    return { action, link }
  }

  if (action === 'status') {
    return { action, status: experimentStatus(cwd, slug) }
  }

  if (action === 'list') {
    readExperiment(cwd, slug)
    return { action, runs: listExperimentRuns(cwd, slug) }
  }

  if (action === 'show') {
    const runId = requireString(args.run_id, 'run_id')
    const run = listExperimentRuns(cwd, slug).find((entry) => entry.run_id === runId)
    if (!run) throw new Error(`run "${runId}" not found`)
    return { action, run, links: listExperimentLinks(cwd, slug).filter((link) => link.run_id === runId) }
  }

  if (action === 'export') {
    return { action, ...exportExperiment({ cwd, slug, format: args.format || 'markdown', overwrite: Boolean(args.overwrite) }) }
  }

  throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
}

export const name = 'academic-harness-experiment-log'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'experiment_log',
    description: [
      'Keep an experiment registry under `.dsh/experiments/<slug>/` for sweeps, simulations, pilots, and model comparisons that are not a single pre-registered analysis (use `analysis_run` for that).',
      'Actions: `start` (question, named metrics with higher/lower directions, notes; write-once unless `resume: true`), `log` (append a run: params, metrics, hashed workspace artifacts, seed, parent, environment; a rerun is a new run — nothing is deduplicated), `compare` (all runs, best per named metric, optional grouping by a param `field`), `best` (by an explicit `metric` and `direction` — there is no implicit best model), `link` (run → notebook/scientific_result/analysis_run/experiment_run/paper/review id), `status`, `list`, `show`, `export` (csv, json, markdown, or MLflow-compatible json).',
      'Missing metrics stay blank, never zero. Artifact paths are workspace-confined and hashed. The tool records logged values and makes no scientific claim about them. Load the `experiment-tracking` skill for the workflow.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ACTIONS, description: 'start, log, compare, best, link, status, list, show, or export. Default status.' },
      slug: { type: 'string', description: 'Experiment slug (stable short name).' },
      experiment: { type: 'object', additionalProperties: true, description: 'Start object: {question, name, metrics:[{name,direction}], notes, resume}.' },
      question: { type: 'string', description: 'Experiment question (start; alternative to experiment.question).' },
      params: { type: 'object', additionalProperties: true, description: 'Parameters for a logged run (log).' },
      metrics: { type: 'object', additionalProperties: true, description: 'Numeric metric values for a logged run (log); omit what is missing.' },
      artifacts: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative artifact files to hash and attach (log).' },
      seed: { type: 'number', description: 'Run seed (log).' },
      parent: { type: 'string', description: 'Parent run id for follow-up runs (log).' },
      notes: { type: 'string', description: 'Free-text notes (start/log/link).' },
      environment: { type: 'object', additionalProperties: true, description: 'Extra environment fields (log); node/os/git are captured automatically.' },
      field: { type: 'string', description: 'Param name to group compare output by (compare).' },
      metric: { type: 'string', description: 'Metric name for best (best).' },
      direction: { type: 'string', enum: EXPERIMENT_DIRECTIONS, description: 'higher or lower (best; defaults to the declared direction).' },
      run_id: { type: 'string', description: 'Run id (link/show).' },
      target_kind: { type: 'string', enum: LINK_TARGET_KINDS, description: 'Link target kind (link).' },
      target_id: { type: 'string', description: 'Link target id (link).' },
      resume: { type: 'boolean', description: 'Continue an existing experiment instead of failing (start).' },
      format: { type: 'string', enum: EXPERIMENT_EXPORT_FORMATS, description: 'Export format (default markdown).' },
      overwrite: { type: 'boolean', description: 'Replace an existing export (default false).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return await runExperimentAction(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Experiment: ${args.slug || ''} (${args.action || 'status'})`, kind: 'other' }
    },
  }))
}
