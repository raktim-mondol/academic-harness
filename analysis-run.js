/**
 * analysis_run: action-multiplexed reproducible-analysis ledger.
 *
 * Plans are frozen before execution; every run stores an immutable manifest
 * (command, environment, input/output hashes, exit status, logs). The tool
 * records what happened and never interprets the science.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  ANALYSIS_EXPORT_FORMATS, ANALYSIS_KINDS, analysisStatus, currentPlan,
  diffAnalysisRuns, exportAnalysisRun, freezeAnalysisPlan, listAnalysisRuns,
  runAnalysis, showAnalysisRun,
} from './analysis-store.js'
import { notebookFile } from './notebook.js'

const ACTIONS = ['plan', 'run', 'status', 'list', 'show', 'diff', 'export']

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

function renderPlan(value) {
  const lines = [
    `Plan v${value.version} for analysis "${value.slug}" ${value.unchanged ? 'unchanged' : value.created ? 'frozen' : 'recorded'}.`,
    `Hash: ${value.hash}`,
  ]
  if (value.reason) lines.push(`Reason: ${value.reason}`)
  return lines.join('\n')
}

function renderRun(run) {
  const status = run.timed_out
    ? `TIMED OUT after ${run.timeout_ms} ms`
    : run.spawn_error
      ? `FAILED TO START (${run.spawn_error})`
      : `exit ${run.exit_code}${run.signal ? ` (signal ${run.signal})` : ''}`
  const outputs = run.outputs.filter((entry) => entry.sha256).length
  return [
    `Run ${run.run_id} · ${status} · ${run.duration_ms} ms · plan v${run.plan_version}.`,
    `Inputs hashed: ${run.inputs.length}; outputs written: ${outputs}/${run.outputs.length}.`,
    `Logs: ${run.stdout} · ${run.stderr}`,
    'The manifest records reproducibility evidence, not a verdict on the result.',
  ].join('\n')
}

function renderStatus(status) {
  const lines = [`Analysis "${status.slug}" at ${status.dir}`]
  lines.push(status.plan
    ? `Plan v${status.plan.version} (${status.plan.hash.slice(0, 18)}…): ${status.plan.question}${status.plan.versions > 1 ? ` [${status.plan.versions} versions]` : ''}`
    : 'Plan: none frozen yet.')
  lines.push(`Runs: ${status.runs}${status.failed ? `, ${status.failed} failed or timed out` : ''}.`)
  if (status.last_run) {
    lines.push(`Last: ${status.last_run.run_id} · exit ${status.last_run.exit_code ?? 'n/a'}${status.last_run.timed_out ? ' (timed out)' : ''} · ${status.last_run.duration_ms} ms`)
  }
  return lines.join('\n')
}

function renderList(runs) {
  if (!runs.length) return 'No runs recorded yet.'
  return [
    `${runs.length} run(s):`,
    ...runs.map((run) => `- ${run.run_id} · ${run.ts} · ${run.kind} · exit ${run.exit_code ?? 'n/a'}${run.timed_out ? ' (timed out)' : ''} · ${run.duration_ms} ms · plan v${run.plan_version}`),
  ].join('\n')
}

function renderShow(run) {
  const lines = [renderRun(run)]
  lines.push(`Command: ${run.command.join(' ')}`)
  for (const entry of run.inputs) lines.push(`input ${entry.path}: ${entry.sha256 || entry.status || entry.error}`)
  for (const entry of run.outputs) lines.push(`output ${entry.path}: ${entry.sha256 || entry.status || entry.error}`)
  if (run.stdout_tail) lines.push('', '--- stderr tail ---', run.stderr_tail.trimEnd())
  return lines.join('\n')
}

function renderDiff(diff) {
  const lines = [`Diff ${diff.a} vs ${diff.b}:`]
  if (!diff.changed.length) lines.push('- identical plan, command, environment, inputs, outputs, and exit status')
  for (const change of diff.changed) {
    lines.push(`- ${change.field}${change.path ? ` ${change.path}` : ''}${'from' in change ? `: ${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}` : ''}`)
  }
  return lines.join('\n')
}

function renderValue(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  switch (value.action) {
    case 'plan': return [{ type: 'text', text: renderPlan(value) }]
    case 'run': return [{ type: 'text', text: renderRun(value.run) }]
    case 'status': return [{ type: 'text', text: renderStatus(value.status) }]
    case 'list': return [{ type: 'text', text: renderList(value.runs) }]
    case 'show': return [{ type: 'text', text: renderShow(value.run) }]
    case 'diff': return [{ type: 'text', text: renderDiff(value.diff) }]
    case 'export': return [{ type: 'text', text: `Wrote ${value.path} (${value.bytes} bytes).` }]
    default: return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }
}

export async function runAnalysisAction(args, exec, deps = {}) {
  const action = args.action || 'status'
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  const slug = requireString(args.slug, 'slug')
  const runner = deps.run || runAnalysis

  if (action === 'plan') {
    if (!args.plan || typeof args.plan !== 'object' || Array.isArray(args.plan)) {
      throw new Error('plan must be an object with at least a question')
    }
    return { action, slug, ...(await freezeAnalysisPlan({
      cwd,
      slug,
      plan: args.plan,
      newVersion: Boolean(args.new_version),
      reason: args.reason,
    })) }
  }

  if (action === 'run') {
    const run = await runner({
      cwd,
      slug,
      command: args.command,
      kind: args.kind || 'other',
      notebook: args.notebook,
      engine: args.engine,
      env: args.env,
      inputs: args.inputs,
      outputs: args.outputs,
      seed: args.seed,
      timeoutMs: args.timeout_ms,
      network: Boolean(args.network),
      capturePackages: Boolean(args.capture_packages),
      notebookEntry: args.notebook_entry === false ? null : { file: notebookFile(exec), id: exec.callId },
    })
    return { action, run }
  }

  if (action === 'status') {
    if (!currentPlan(cwd, slug) && !listAnalysisRuns(cwd, slug).length) {
      return { action, status: analysisStatus(cwd, slug), note: 'nothing recorded for this slug yet' }
    }
    return { action, status: analysisStatus(cwd, slug) }
  }

  if (action === 'list') {
    return { action, runs: listAnalysisRuns(cwd, slug) }
  }

  if (action === 'show') {
    return { action, run: showAnalysisRun(cwd, slug, requireString(args.run_id, 'run_id')) }
  }

  if (action === 'diff') {
    return { action, diff: diffAnalysisRuns(cwd, slug, { a: requireString(args.run_id, 'run_id'), b: args.compare_run_id }) }
  }

  if (action === 'export') {
    return {
      action,
      ...exportAnalysisRun({
        cwd, slug, runId: requireString(args.run_id, 'run_id'),
        format: args.format || 'markdown', overwrite: Boolean(args.overwrite),
      }),
    }
  }

  throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
}

export const name = 'academic-harness-analysis-run'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'analysis_run',
    description: [
      'Keep a reproducible analysis ledger under `.dsh/analysis/<slug>/`: a frozen plan plus immutable run manifests.',
      `Actions: \`plan\` (freeze question, hypotheses, inputs, outputs, methods, alpha, exclusions, stopping rules, software, seed; changing a frozen plan needs \`new_version: true\` and a \`reason\`), \`run\` (execute an argv \`command\` array — never a shell — with an environment allowlist plus explicit \`env\`, a hard \`timeout_ms\`, hashed \`inputs\`/\`outputs\`, and a lab-notebook entry), \`status\`, \`list\`, \`show\`, \`diff\` (run vs run, or run vs the current plan and inputs), \`export\` (${ANALYSIS_EXPORT_FORMATS.join(' or ')} run report).`,
      `Kinds: ${ANALYSIS_KINDS.join(', ')}. \`kind: "notebook"\` executes via jupyter nbconvert or papermill (a clear not_installed error otherwise) and stores the executed notebook under the run. Network is off by default (\`no_proxy=*\`; this is a convention, not a firewall) and \`network: true\` is recorded in the manifest. Explicit env values and key-looking text are redacted from stored logs; output paths outside the workspace are rejected; a nonzero exit or timeout is recorded, not hidden.`,
      'The tool records what ran — hashes, environment, exit status — and never interprets the result or claims the science is correct; a copied notebook output is not evidence, the manifest is. Call `scientific_result` separately when a run produced a finding. Load the `reproducible-analysis` skill for the workflow.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ACTIONS, description: 'plan, run, status, list, show, diff, or export. Default status.' },
      slug: { type: 'string', description: 'Analysis slug (stable short name).' },
      plan: { type: 'object', additionalProperties: true, description: 'Plan object for action=plan: {question, hypotheses, inputs, outputs, variables, primary_outcomes, secondary_outcomes, methods, alpha, corrections, missing_data_rules, exclusions, stopping_rules, software, seed, sensitivity_analyses, notes}.' },
      new_version: { type: 'boolean', description: 'Supersede the frozen plan (plan; requires reason).' },
      reason: { type: 'string', description: 'Why the plan changed (plan with new_version).' },
      command: { type: 'array', items: { type: 'string' }, description: 'Executable and arguments as an argv array, e.g. ["python3", "analysis/main.py"] (run). No shell is used.' },
      kind: { type: 'string', enum: ANALYSIS_KINDS, description: 'Run kind (run). Default other; python/r probes record interpreter versions.' },
      notebook: { type: 'string', description: 'Workspace-relative .ipynb path for kind=notebook.' },
      engine: { type: 'string', enum: ['auto', 'jupyter', 'papermill'], description: 'Notebook engine (default auto).' },
      env: { type: 'object', additionalProperties: true, description: 'Explicit NAME=value environment for the run; ambient secrets are not forwarded and values are redacted from logs.' },
      inputs: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative input paths to hash (defaults to the plan inputs).' },
      outputs: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative output paths to hash after the run (defaults to the plan outputs).' },
      seed: { type: 'number', description: 'Run seed recorded in the manifest (defaults to the plan seed).' },
      timeout_ms: { type: 'number', description: 'Hard timeout in ms (default 600000, max 3600000).' },
      network: { type: 'boolean', description: 'Allow network conventions for this run (default false, recorded in the manifest).' },
      capture_packages: { type: 'boolean', description: 'For python runs, store `pip freeze` under the run environment/ (default false).' },
      notebook_entry: { type: 'boolean', description: 'Set false to skip appending the lab-notebook entry for a run (default true).' },
      run_id: { type: 'string', description: 'Run id (show/diff/export).' },
      compare_run_id: { type: 'string', description: 'Second run id for diff; omit to diff against the current plan and inputs.' },
      format: { type: 'string', enum: ANALYSIS_EXPORT_FORMATS, description: 'Export format (default markdown).' },
      overwrite: { type: 'boolean', description: 'Replace an existing export (default false).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return await runAnalysisAction(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Analysis run: ${args.slug || ''} (${args.action || 'status'})`, kind: 'other' }
    },
  }))
}
