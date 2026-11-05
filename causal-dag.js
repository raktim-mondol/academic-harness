/**
 * causal_dag: explicit causal assumptions and graph-derived identification
 * diagnostics.
 *
 * The DAG is user-specified. The tool computes what the graph implies —
 * d-separation, adjustment sets, instruments, testable independencies — and
 * E-values. It never estimates a causal effect, fits a model, or claims the
 * assumptions are true.
 */
import { defineTool } from 'ah-dsh-tools'
import {
  CAUSAL_ACTIONS, CAUSAL_EXPORT_FORMATS, EVALUE_MEASURES,
  analyzeCausalDagStore, causalStatus, createCausalDag, editCausalDag,
  exportCausalDag, parseGraphText, readCausalTextFile, recordEValue,
} from './causal-dag-store.js'

function text(value) {
  return String(value ?? '').trim()
}

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function setList(value, name) {
  if (value == null || value === '') return []
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value.map((entry) => text(entry)).filter(Boolean)
}

function renderCreate(value) {
  return [
    `Causal DAG "${value.slug}" ${value.unchanged ? 'already exists unchanged' : `version ${value.version} recorded`}.`,
    `Hash: ${value.hash}`,
    `Nodes: ${value.dag.nodes.length} · edges: ${value.dag.edges.length}${value.dag.treatment ? ` · treatment ${value.dag.treatment}` : ''}${value.dag.outcome ? ` · outcome ${value.dag.outcome}` : ''}.`,
    value.unchanged ? '' : 'The graph is user-specified; editing it requires a reason and keeps the earlier version.',
  ].filter(Boolean).join('\n')
}

function renderAnalyze(value) {
  const lines = [
    `Causal analysis of "${value.treatment}" → "${value.outcome}" (DAG v${value.dag_version}, ${value.nodes} nodes, ${value.edges} edges).`,
    `Backdoor: ${value.backdoor.status}${value.backdoor.minimal_sets.length ? ` · minimal sets ${value.backdoor.minimal_sets.map((set) => `{${set.join(', ') || '∅'}}`).join(' ')}` : ''}${value.backdoor.truncated ? ' · candidate enumeration truncated' : ''}.`,
  ]
  if (value.backdoor.parents_of_treatment_valid) lines.push(`Observed parents of treatment form a valid adjustment set: {${value.backdoor.parents_of_treatment.join(', ')}}.`)
  lines.push(`Front-door: ${value.front_door.status}${value.front_door.sets.length ? ` · ${value.front_door.sets.map((set) => `{${set.join(', ')}}`).join(' ')}` : ''}.`)
  lines.push(`Instrument candidates: ${value.instruments.candidates.length ? value.instruments.candidates.map((entry) => entry.node).join(', ') : 'none'}.`)
  const risky = value.colliders.filter((entry) => entry.conditioning_risk)
  if (risky.length) lines.push(`Colliders with conditioning risk: ${risky.map((entry) => entry.node).join(', ')}.`)
  if (value.adjustment_warnings.length) {
    lines.push('Adjustment warnings:')
    for (const warning of value.adjustment_warnings) lines.push(`- ${warning.node}: ${warning.status} — ${warning.detail}`)
  }
  lines.push(`Testable implications listed: ${value.testable_implications.length}.`)
  lines.push('These are graph implications under the stated DAG, not estimates or proof of causality. No model was fitted.')
  return lines.join('\n')
}

function renderEValue(value) {
  const lines = [
    `E-value (${value.measure}): estimate ${value.estimate}${value.ci_low != null ? ` · CI ${value.ci_low}–${value.ci_high}` : ''}.`,
    `E-value: ${value.e_value}${value.e_value_ci != null ? ` · CI E-value: ${value.e_value_ci}` : ''}.`,
  ]
  if (value.ci_includes_null === true) lines.push('The confidence interval includes the null.')
  for (const caveat of value.caveats || []) lines.push(`- ${caveat}`)
  return lines.join('\n')
}

function renderStatus(status) {
  const lines = [
    `Causal DAG "${status.slug}": v${status.version} · ${status.nodes} nodes · ${status.edges} edges · ${status.versions} version(s).`,
    status.treatment ? `Stored treatment: ${status.treatment}${status.outcome ? ` · outcome ${status.outcome}` : ''}.` : 'Treatment/outcome not stored yet.',
  ]
  if (status.latest_analysis) {
    const analysis = status.latest_analysis
    lines.push(`Latest analysis: ${analysis.treatment} → ${analysis.outcome} · backdoor ${analysis.backdoor_status}${analysis.minimal_sets.length ? ` · minimal ${analysis.minimal_sets.map((set) => `{${set.join(', ') || '∅'}}`).join(' ')}` : ''}.`)
  } else lines.push('No analyses recorded yet.')
  lines.push(`E-value calculations recorded: ${status.evalues}.`)
  return lines.join('\n')
}

function renderValue(value) {
  if (value?.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  switch (value.action) {
    case 'create':
    case 'edit': return [{ type: 'text', text: renderCreate(value) }]
    case 'analyze': return [{ type: 'text', text: renderAnalyze(value.analysis) }]
    case 'evalues': return [{ type: 'text', text: renderEValue(value.result) }]
    case 'export': return [{ type: 'text', text: `Wrote ${value.result.path} (${value.result.bytes} bytes, ${value.result.format}, DAG v${value.result.version}).` }]
    case 'status': return [{ type: 'text', text: renderStatus(value.status) }]
    default: return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }
}

function graphFromArgs(cwd, args) {
  if (args.text || args.file) {
    const format = args.format || (args.file ? 'dot' : 'edge_list')
    const body = args.text || readCausalTextFile(cwd, args.file)
    return parseGraphText(body, format)
  }
  return { nodes: args.nodes || null, edges: args.edges || [] }
}

export async function runCausalAction(args, exec) {
  const action = args.action || 'status'
  if (!CAUSAL_ACTIONS.includes(action)) throw new Error(`action must be one of ${CAUSAL_ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  const slug = text(args.slug)

  if (action === 'create') {
    if (!slug) throw new Error('slug is required')
    const graph = graphFromArgs(cwd, args)
    const value = await createCausalDag({
      cwd, slug, nodes: graph.nodes, edges: graph.edges,
      treatment: args.treatment, outcome: args.outcome, label: args.label,
      reason: args.reason, recordedBy: args.recorded_by,
    })
    return { action, ...value }
  }
  if (action === 'edit') {
    if (!slug) throw new Error('slug is required')
    const graph = (args.text || args.file) ? graphFromArgs(cwd, args) : null
    const value = await editCausalDag({
      cwd, slug, reason: args.reason, recordedBy: args.recorded_by,
      dag: graph || args.dag, add_nodes: args.add_nodes, add_edges: args.add_edges,
      remove_nodes: args.remove_nodes, remove_edges: args.remove_edges,
      treatment: args.treatment, outcome: args.outcome, label: args.label,
    })
    return { action, ...value }
  }
  if (action === 'analyze') {
    if (!slug) throw new Error('slug is required')
    const analysis = analyzeCausalDagStore({
      cwd, slug, x: args.x, y: args.y,
      given: setList(args.given, 'given'), adjustFor: setList(args.adjust_for, 'adjust_for'),
      record: args.record !== false,
    })
    return { action, analysis }
  }
  if (action === 'evalues') {
    if (!text(args.measure)) throw new Error('measure is required (RR, OR, HR, or SMD)')
    if (args.estimate == null) throw new Error('estimate is required')
    const result = recordEValue({
      cwd, slug: slug || null, measure: args.measure, estimate: args.estimate,
      ciLow: args.ci_low, ciHigh: args.ci_high,
    })
    return { action, result }
  }
  if (action === 'export') {
    if (!slug) throw new Error('slug is required')
    return {
      action,
      result: exportCausalDag({
        cwd, slug, format: args.format || 'mermaid', out: args.out, overwrite: Boolean(args.overwrite),
      }),
    }
  }
  if (!slug) throw new Error('slug is required')
  return { action, status: causalStatus(cwd, slug) }
}

export const name = 'academic-harness-causal-dag'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'causal_dag',
    description: [
      'Store a user-specified causal DAG under `.dsh/causal/<slug>/` and derive what the graph implies for identification.',
      `Actions: \`create\` and \`edit\` (nodes/edges, or DOT/Mermaid/edge-list text via \`text\` or \`file\` plus \`format\`; edits require a reason and keep the old version), \`analyze\` (d-separation of treatment and outcome, backdoor minimal adjustment sets, front-door sets, collider/M-bias warnings, instrument candidates, testable implications), \`evalues\` (VanderWeele E-value for RR/OR/HR, or an approximate standardized-effect conversion), \`status\`, and \`export\` (${CAUSAL_EXPORT_FORMATS.join(', ')}).`,
      'The DAG and every arrow are assumptions supplied by the user; unmeasured confounding is represented only if the graph includes it. Adjustment sets satisfy the graph criterion, not a guarantee of correct identification, and E-values are sensitivity aids. No model is fitted and no causal effect is estimated here; do that in `analysis_run` with explicit code.',
      'Load the `causal-dag` skill for the identification workflow and the E-value caveats.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: CAUSAL_ACTIONS, description: 'create, edit, analyze, evalues, export, or status. Default status.' },
      slug: { type: 'string', description: 'DAG slug (required except for standalone evalues).' },
      nodes: { type: 'array', description: 'Nodes: strings or {id, label?, observed?, latent?}.' },
      edges: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Directed edges as [from, to] pairs.' },
      text: { type: 'string', description: 'DOT, Mermaid, or edge-list text to parse instead of nodes/edges.' },
      file: { type: 'string', description: 'Workspace-relative file with graph text.' },
      format: { type: 'string', enum: ['edge_list', 'mermaid', 'dot'], description: 'Graph text format (default edge_list for text, dot for file).' },
      label: { type: 'string', description: 'Optional DAG label/description.' },
      treatment: { type: 'string', description: 'Treatment node (create/edit).' },
      outcome: { type: 'string', description: 'Outcome node (create/edit).' },
      x: { type: 'string', description: 'analyze: treatment node (defaults to the stored treatment).' },
      y: { type: 'string', description: 'analyze: outcome node (defaults to the stored outcome).' },
      given: { type: 'array', items: { type: 'string' }, description: 'analyze: conditioning set for the d-separation check.' },
      adjust_for: { type: 'array', items: { type: 'string' }, description: 'analyze: a proposed adjustment set to warn about (colliders/descendants/unobserved).' },
      record: { type: 'boolean', description: 'analyze: record the analysis under the slug (default true).' },
      add_nodes: { type: 'array', description: 'edit: nodes to add.' },
      add_edges: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'edit: edges to add.' },
      remove_nodes: { type: 'array', items: { type: 'string' }, description: 'edit: node ids to remove with their incident edges.' },
      remove_edges: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'edit: edges to remove.' },
      dag: { type: 'object', additionalProperties: true, description: 'edit: full replacement {nodes, edges, treatment, outcome}.' },
      reason: { type: 'string', description: 'Why the DAG changed (required for edit).' },
      recorded_by: { type: 'string', description: 'Who recorded the change.' },
      measure: { type: 'string', enum: EVALUE_MEASURES, description: 'evalues: RR, OR, HR, or SMD.' },
      estimate: { type: 'number', description: 'evalues: effect estimate on the measure scale.' },
      ci_low: { type: 'number', description: 'evalues: lower confidence limit.' },
      ci_high: { type: 'number', description: 'evalues: upper confidence limit.' },
      out: { type: 'string', description: 'export: workspace-relative output path.' },
      overwrite: { type: 'boolean', description: 'export: replace an existing file.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return await runCausalAction(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Causal DAG: ${args.slug || ''} (${args.action || 'status'})`, kind: 'other' }
    },
  }))
}
