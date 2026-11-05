/**
 * experiment_log: action-multiplexed experiment registry for runs that are not
 * a single pre-registered analysis — sweeps, simulations, pilots, comparisons.
 *
 * State lives under `<cwd>/.dsh/experiments/<slug>/` (experiment-store.js).
 * The tool records what was logged and never claims a scientific result.
 */
import { defineTool } from 'ah-dsh-tools'
import {
  EXPERIMENT_BASELINE_REFS, EXPERIMENT_DIRECTIONS, EXPERIMENT_EXPORT_FORMATS,
  EXPERIMENT_ROLES, EXPERIMENT_STAGES, EXPERIMENT_VERDICTS, LINK_TARGET_KINDS,
  bestExperimentRun, compareExperiments, dominanceExperiment, experimentStatus, exportExperiment,
  linkExperimentRun, listExperimentLinks, listExperimentRuns, listExperimentVerdicts, logExperimentRun,
  readExperiment, startExperiment, verdictExperiment,
} from './experiment-store.js'

const ACTIONS = ['start', 'log', 'compare', 'best', 'verdict', 'link', 'status', 'list', 'show', 'export']

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
  const metrics = Object.entries(run.metrics || {}).map(([key, value]) => `${key}=${value}`).join(', ')
  const params = Object.entries(run.params || {}).map(([key, value]) => `${key}=${value}`).join(', ')
  const staged = run.role ? ` · ${run.role}${run.baseline_ref ? `/${run.baseline_ref}` : ''}${run.stage ? `/${run.stage}` : ''}` : ''
  const drift = run.spec_drift?.state === 'drift' ? ' · SPEC DRIFT' : ''
  const verdict = run.verdict?.verdict ? ` · verdict ${run.verdict.verdict}` : ''
  const excluded = run.excluded ? ' · EXCLUDED (compliance)' : ''
  return `- ${run.run_id} · ${run.ts}${run.seed != null ? ` · seed ${run.seed}` : ''}${params ? ` · ${params}` : ''}${metrics ? ` · ${metrics}` : ''}${staged}${drift}${verdict}${excluded}${run.artifacts?.length ? ` · ${run.artifacts.length} artifact(s)` : ''}`
}

function renderValue(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  switch (value.action) {
    case 'start': {
      const e = value.experiment
      const metrics = e.metrics.length ? `\nMetrics: ${e.metrics.map((m) => `${m.name}${m.direction ? ` (${m.direction})` : ''}`).join(', ')}` : ''
      const benchmark = e.benchmark
        ? `\nBenchmark: datasets ${e.benchmark.datasets.join(', ')}; splits ${e.benchmark.splits.join(', ')}; baseline arm ${e.benchmark.baseline_arm}; ${e.benchmark.task_rules.length} task rule(s)`
        : ''
      const protocol = e.protocol ? `\nProtocol: ${e.protocol.eval_script} + metric parameters` : ''
      return [{ type: 'text', text: `Experiment "${e.slug}" ${value.resumed ? 'resumed' : 'started'}: ${e.question}${metrics}${benchmark}${protocol}` }]
    }
    case 'log': {
      const undeclared = value.undeclared_metrics.length
        ? `\nUndeclared metrics (recorded, not defined at start): ${value.undeclared_metrics.join(', ')}`
        : ''
      const run = value.run
      const staged = run.role ? ` · ${run.role}${run.baseline_ref ? `/${run.baseline_ref}` : ''}${run.stage ? `/${run.stage}` : ''}` : ''
      const drift = run.spec_drift?.state === 'drift'
        ? `\nSpec drift against baseline ${run.spec_drift.baseline_run_id}: ${run.spec_drift.changed.join(', ') || 'protocol digest changed'}`
        : run.spec_drift?.state === 'match'
          ? `\nProtocol digest matches baseline ${run.spec_drift.baseline_run_id}.`
          : ''
      return [{ type: 'text', text: `Logged ${run.run_id} (${Object.keys(run.metrics).length} metric(s), ${run.artifacts.length} artifact(s))${staged}.${drift}${undeclared}` }]
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
      if (value.comparison.compliance?.excluded_run_ids.length) {
        lines.push('', `Excluded by compliance: ${value.comparison.compliance.excluded_run_ids.join(', ')}`)
      }
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'best': {
      const lines = []
      if (value.best) {
        lines.push(
          `Best by ${value.best.metric} (${value.best.direction}): ${value.best.run.run_id} = ${value.best.run.metrics[value.best.metric]}`,
          renderRunLine(value.best.run),
        )
        if (value.best.tied_runs.length > 1) lines.push(`Tied runs: ${value.best.tied_runs.join(', ')}`)
        if (value.best.excluded_run_ids?.length) lines.push(`Excluded by compliance: ${value.best.excluded_run_ids.join(', ')}`)
      }
      if (value.dominance) {
        if (lines.length) lines.push('')
        lines.push(`Pareto front over ${value.dominance.metrics.map((metric) => `${metric.name} (${metric.direction})`).join(', ')}:`)
        if (!value.dominance.front.length) lines.push('- none (no complete run)')
        for (const entry of value.dominance.front) {
          lines.push(`- ${entry.run_id}: ${Object.entries(entry.metrics).map(([key, val]) => `${key}=${val}`).join(', ')}${entry.dominated_run_ids.length ? ` · dominates ${entry.dominated_run_ids.join(', ')}` : ''}`)
        }
        if (value.dominance.dominated.length) lines.push(`Dominated: ${value.dominance.dominated.join(', ')}`)
        if (value.dominance.incomplete.length) {
          lines.push(`Incomplete (missing metrics, not ranked): ${value.dominance.incomplete.map((entry) => `${entry.run_id} (${entry.missing.join(', ')})`).join('; ')}`)
        }
        if (value.dominance.excluded?.length) {
          lines.push(`Excluded by compliance: ${value.dominance.excluded.map((entry) => entry.run_id).join(', ')}`)
        }
        lines.push(value.dominance.note)
      }
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'verdict': {
      const verdict = value.verdict
      return [{ type: 'text', text: `Verdict ${verdict.verdict_id} on ${verdict.run_id}: ${verdict.verdict}${verdict.forced ? ` (requested ${verdict.requested_verdict}, forced)` : ''} — ${verdict.reason}` }]
    }
    case 'link':
      return [{ type: 'text', text: `Linked ${value.link.run_id} → ${value.link.target.kind}:${value.link.target.id}.` }]
    case 'status': {
      const s = value.status
      const lines = [
        `Experiment "${s.slug}" at ${s.dir}`,
        `Question: ${s.question}`,
        `Runs: ${s.runs}${s.last_run ? ` (last ${s.last_run})` : ''} · links: ${s.links} · verdicts: ${s.verdicts ?? 0}`,
        s.metrics.length ? `Metrics: ${s.metrics.map((m) => `${m.name}${m.direction ? ` (${m.direction})` : ''}`).join(', ')}` : 'Metrics: none declared.',
      ]
      if (s.benchmark) lines.push(`Benchmark: datasets ${s.benchmark.datasets.join(', ')}; splits ${s.benchmark.splits.join(', ')}; baseline arm ${s.benchmark.baseline_arm}.`)
      if (s.protocol) lines.push(`Protocol: ${s.protocol.eval_script} + metric parameters.`)
      if (s.baseline_runs?.length) lines.push(`Baselines: ${s.baseline_runs.map((entry) => `${entry.run_id} (${entry.baseline_ref || '?'})`).join(', ')}.`)
      if (s.spec_drift_runs?.length) lines.push(`Spec drift: ${s.spec_drift_runs.map((entry) => `${entry.run_id} (${entry.changed.join(', ') || 'digest'})`).join(', ')}.`)
      if (s.latest_verdict) lines.push(`Latest verdict: ${s.latest_verdict.run_id} ${s.latest_verdict.verdict}${s.latest_verdict.forced ? ' (forced)' : ''}.`)
      if (s.compliance?.excluded_run_ids?.length) lines.push(`Excluded by compliance: ${s.compliance.excluded_run_ids.join(', ')}.`)
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'list':
      return [{ type: 'text', text: value.runs.length ? value.runs.map(renderRunLine).join('\n') : 'No runs logged yet.' }]
    case 'show': {
      const lines = [renderRunLine(value.run).slice(2), `params: ${JSON.stringify(value.run.params)}`, `environment: ${JSON.stringify(value.run.environment)}`]
      if (value.run.protocol_digest) lines.push(`protocol: ${value.run.protocol_digest}${value.run.spec_drift?.state ? ` (${value.run.spec_drift.state}${value.run.spec_drift.changed?.length ? `: ${value.run.spec_drift.changed.join(', ')}` : ''})` : ''}`)
      if (value.run.artifacts.length) lines.push('artifacts:', ...value.run.artifacts.map((entry) => `- ${entry.path} (${entry.sha256.slice(0, 18)}…)`))
      if (value.links.length) lines.push('links:', ...value.links.map((link) => `- ${link.target.kind}:${link.target.id}${link.note ? ` — ${link.note}` : ''}`))
      if (value.verdicts?.length) lines.push('verdicts:', ...value.verdicts.map((verdict) => `- ${verdict.verdict}${verdict.forced ? ` (requested ${verdict.requested_verdict}, forced)` : ''} — ${verdict.reason}`))
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
    const { experiment, resumed } = await startExperiment({
      cwd,
      slug,
      experiment: {
        ...args.experiment,
        question: args.question ?? args.experiment?.question,
        benchmark: args.benchmark ?? args.experiment?.benchmark,
        protocol: args.protocol ?? args.experiment?.protocol,
        resume: args.resume ?? args.experiment?.resume,
      },
    })
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
      role: args.role,
      baselineRef: args.baseline_ref,
      stage: args.stage,
      sampling: args.sampling,
      protocol: args.protocol,
    })
    return { action, run, undeclared_metrics }
  }

  if (action === 'compare') {
    return { action, field: args.field || null, comparison: compareExperiments(cwd, slug, { field: args.field }) }
  }

  if (action === 'best') {
    const best = args.metric ? bestExperimentRun(cwd, slug, { metric: requireString(args.metric, 'metric'), direction: args.direction }) : null
    const dominance = args.dominance ? dominanceExperiment(cwd, slug) : null
    if (!best && !dominance) throw new Error('best requires a named metric or dominance: true')
    return { action, best, dominance }
  }

  if (action === 'verdict') {
    const { verdict } = await verdictExperiment({
      cwd, slug,
      runId: requireString(args.run_id, 'run_id'),
      verdict: args.verdict,
      reason: args.reason,
      engineeringRound: args.engineering_round,
      budget: args.budget,
    })
    return { action, verdict }
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
    return {
      action,
      run,
      links: listExperimentLinks(cwd, slug).filter((link) => link.run_id === runId),
      verdicts: listExperimentVerdicts(cwd, slug).filter((verdict) => verdict.run_id === runId),
    }
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
      'Actions: `start` (question, named metrics with higher/lower directions, an optional benchmark spec — datasets, splits, baseline_arm, task_rules — and an optional protocol: eval_script + metric_params; write-once unless `resume: true`), `log` (append a run: params, metrics, hashed workspace artifacts, seed, parent, environment; staged runs add role baseline|variant, baseline_ref reproduced|reported, stage subset|slice|full, a sampling rule, and a protocol whose SHA-256 is checked against the matching baseline as spec_drift; a rerun is a new run — nothing is deduplicated), `compare` (all runs, best per named metric, optional grouping by a param `field`), `best` (by an explicit `metric` and `direction`, and/or `dominance: true` for the multi-metric Pareto front), `verdict` (advisory human decision good|engineer|bad with reason, engineering_round, and budget; a budget-exhausted engineer is recorded force-bad), `link` (run → notebook/scientific_result/analysis_run/experiment_run/paper/review id), `status`, `list`, `show`, `export` (csv, json, markdown, or MLflow-compatible json).',
      'Missing metrics stay blank, never zero. Artifact paths are workspace-confined and hashed. A baseline_run with a protocol_digest is the reference for later staged runs; a variant must name a matching baseline_ref, and a changed eval script or metric parameters is reported as spec_drift, not silently accepted. A run linked to an `analysis_run` that failed its frozen task rules is excluded from `best` and `dominance` (the analysis ledger owns that check); the run stays visible with its exclusion. The tool records logged values and human verdicts and makes no scientific claim about them. Load the `experiment-tracking` skill for the workflow.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ACTIONS, description: 'start, log, compare, best, verdict, link, status, list, show, or export. Default status.' },
      slug: { type: 'string', description: 'Experiment slug (stable short name).' },
      experiment: { type: 'object', additionalProperties: true, description: 'Start object: {question, name, metrics:[{name,direction}], benchmark, protocol, notes, resume}.' },
      question: { type: 'string', description: 'Experiment question (start; alternative to experiment.question).' },
      benchmark: { type: 'object', additionalProperties: true, description: 'Start benchmark spec: {datasets:[...], splits:[...], baseline_arm, task_rules:[...]}. Required for staged runs.' },
      protocol: { type: 'object', additionalProperties: true, description: 'Start/log protocol: {eval_script: workspace-relative path, metric_params: object}. The baseline captures its SHA-256 digest; later runs are checked.' },
      role: { type: 'string', enum: EXPERIMENT_ROLES, description: 'log: baseline or variant. Required with baseline_ref/stage/sampling.' },
      baseline_ref: { type: 'string', enum: EXPERIMENT_BASELINE_REFS, description: 'log: reproduced or reported — which reference this run compares against. Variants must match a baseline with the same ref.' },
      stage: { type: 'string', enum: EXPERIMENT_STAGES, description: 'log: subset, slice, or full. Subset/slice need a sampling rule.' },
      sampling: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }], description: 'log: sampling rule, e.g. {rule, size, seed, stratification} or a rule string. Required for subset/slice.' },
      params: { type: 'object', additionalProperties: true, description: 'Parameters for a logged run (log).' },
      metrics: { type: 'object', additionalProperties: true, description: 'Numeric metric values for a logged run (log); omit what is missing.' },
      artifacts: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative artifact files to hash and attach (log).' },
      seed: { type: 'number', description: 'Run seed (log).' },
      parent: { type: 'string', description: 'Parent run id for follow-up runs (log).' },
      notes: { type: 'string', description: 'Free-text notes (start/log/link).' },
      environment: { type: 'object', additionalProperties: true, description: 'Extra environment fields (log); node/os/git are captured automatically.' },
      field: { type: 'string', description: 'Param name to group compare output by (compare).' },
      metric: { type: 'string', description: 'Metric name for best (best); omit when using dominance: true.' },
      direction: { type: 'string', enum: EXPERIMENT_DIRECTIONS, description: 'higher or lower (best; defaults to the declared direction).' },
      dominance: { type: 'boolean', description: 'best: return the multi-metric Pareto front over declared metrics and directions.' },
      verdict: { type: 'string', enum: EXPERIMENT_VERDICTS, description: 'verdict: good, engineer, or bad (advisory human decision).' },
      reason: { type: 'string', description: 'verdict: the required reason for the decision.' },
      engineering_round: { type: 'integer', description: 'verdict: the engineering round requested (required for engineer).' },
      budget: { oneOf: [{ type: 'number' }, { type: 'object', additionalProperties: true }], description: 'verdict: engineering budget, e.g. {max_rounds, used, exhausted}. A budget-exhausted engineer is recorded force-bad.' },
      run_id: { type: 'string', description: 'Run id (link/show/verdict).' },
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
