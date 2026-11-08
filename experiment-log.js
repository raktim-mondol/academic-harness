/**
 * experiment_log: action-multiplexed experiment registry for runs that are not
 * a single pre-registered analysis — sweeps, simulations, pilots, comparisons.
 *
 * State lives under `<cwd>/.dsh/experiments/<slug>/` (experiment-store.js).
 * The tool records what was logged and never claims a scientific result.
 */
import { defineTool } from 'ah-dsh-tools'
import {
  EXPERIMENT_BASELINE_REFS, EXPERIMENT_BRANCH_FORMATS, EXPERIMENT_DIRECTIONS, EXPERIMENT_EXPORT_FORMATS,
  EXPERIMENT_ROLES, EXPERIMENT_STAGES, EXPERIMENT_VERDICTS, LINK_TARGET_KINDS,
  bestExperimentRun, compareExperiments, dominanceExperiment, experimentBranches, experimentStatus, exportExperiment,
  linkExperimentRun, listExperimentLinks, listExperimentRuns, listExperimentVerdicts, logExperimentRun,
  readExperiment, startExperiment, summarizeExperimentReplicates, verdictExperiment,
} from './experiment-store.js'

const ACTIONS = ['start', 'log', 'compare', 'best', 'replicates', 'branches', 'verdict', 'link', 'status', 'list', 'show', 'export']
const FORMATS = [...new Set([...EXPERIMENT_EXPORT_FORMATS, ...EXPERIMENT_BRANCH_FORMATS])]

function text(value) {
  return String(value ?? '').trim()
}

// Presentation only: stored and returned numbers keep full precision.
function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value)
  return String(Number(value.toPrecision(12)))
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

function safeBranchText(value, max = 160) {
  const raw = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw
}

function shortScope(value) {
  const raw = String(value ?? '')
  return raw.startsWith('sha256:') ? `sha256:${raw.slice(7, 19)}…` : raw
}

function renderBranches(report) {
  const lines = [
    `Experiment "${safeBranchText(report.experiment)}" — read-only branch view`,
    `Source snapshot: ${safeBranchText(report.generated_at)} · ${report.source_snapshot.files.map((file) => `${safeBranchText(file.path)} ${file.sha256 ? `${file.sha256.slice(0, 18)}…` : 'missing'}`).join(' · ')}`,
    `Runs: ${report.counts.runs_included}/${report.counts.runs_total} shown · roots ${report.counts.roots} · orphans ${report.counts.orphans} · cycles ${report.counts.cycles} · links ${report.counts.links_included}/${report.counts.links_total}`,
  ]
  if (report.source_snapshot.changed_during_read) lines.push('Source ledgers changed while this view was computed; re-run before relying on it.')
  if (report.truncated) lines.push(`View truncated: ${report.counts.runs_omitted} run(s), ${report.counts.edges_omitted} edge(s), ${report.counts.links_omitted} link(s) omitted.`)
  const nodeById = new Map(report.nodes.map((node) => [node.run_id, node]))
  const visited = new Set()
  const renderNode = (node, depth) => {
    if (!node || visited.has(node.run_id)) return
    visited.add(node.run_id)
    const indent = '  '.repeat(depth)
    const parts = [safeBranchText(node.run_id)]
    if (node.parent_state === 'root') parts.push('root')
    else if (node.parent_state === 'missing') parts.push(`parent ${safeBranchText(node.parent)} missing`)
    else if (node.parent_state === 'self') parts.push('self-parent')
    else if (node.parent_state === 'invalid') parts.push('invalid parent')
    else if (node.parent_state === 'cycle') parts.push('parent cycle')
    else if (node.parent_state === 'truncated') parts.push(`parent ${safeBranchText(node.parent)} not shown`)
    const staging = [node.role || 'unstaged', node.stage].filter(Boolean).join('/')
    if (staging) parts.push(staging)
    if (node.seed != null) parts.push(`seed ${node.seed}`)
    parts.push(`status ${node.status}`)
    if (node.scope_id) parts.push(`scope ${shortScope(node.scope_id)}`)
    parts.push(`comparison ${node.comparison_state}`)
    const metrics = Object.entries(node.metrics || {}).map(([name, value]) => `${safeBranchText(name)}=${formatNumber(value)}`)
    parts.push(metrics.length ? metrics.join(', ') : 'metrics not recorded')
    if (node.artifact_count) parts.push(`${node.artifact_count} artifact(s)`)
    if (node.spec_drift_state === 'drift') parts.push('SPEC DRIFT')
    if (node.excluded) parts.push('EXCLUDED (compliance)')
    lines.push(`${indent}- ${parts.join(' · ')}`)
    if (node.verdict) {
      lines.push(`${indent}  verdict: ${safeBranchText(node.verdict.verdict)}${node.verdict.forced ? ` (requested ${safeBranchText(node.verdict.requested_verdict)}, forced)` : ''}${node.verdict.reason ? ` — ${safeBranchText(node.verdict.reason, 240)}` : ''}`)
    }
    if (node.status_reason && node.status_source !== 'not_recorded') lines.push(`${indent}  status: ${safeBranchText(node.status_reason, 240)}`)
    if (node.spec_drift?.state === 'drift') {
      const changed = Array.isArray(node.spec_drift.changed) && node.spec_drift.changed.length ? node.spec_drift.changed.join(', ') : 'protocol digest'
      lines.push(`${indent}  drift: against ${safeBranchText(node.spec_drift.baseline_run_id || 'unknown')} (${safeBranchText(changed)})`)
    }
    for (const link of node.links) {
      let detail = link.resolution.reason
      if (link.resolution.state === 'resolved' && link.target.kind === 'analysis_run') {
        const bits = [`exit ${link.resolution.exit_code ?? 'n/a'}`]
        if (link.resolution.timed_out) bits.push('timed out')
        if (link.resolution.spawn_error) bits.push(`spawn error ${safeBranchText(link.resolution.spawn_error)}`)
        if (link.resolution.manifest_state === 'missing') bits.push('manifest file missing')
        detail = bits.join(', ')
      }
      lines.push(`${indent}  link: ${safeBranchText(link.target.kind)}:${safeBranchText(link.target.id)} → ${link.resolution.state}${detail ? ` (${safeBranchText(detail, 200)})` : ''}${link.duplicate ? ' [duplicate record]' : ''}`)
    }
    if (node.compliance.state === 'excluded') {
      const detail = node.compliance.detail
      lines.push(`${indent}  compliance: EXCLUDED — analysis_run ${safeBranchText((detail?.analysis_run_ids || []).join(', '))}${detail?.analysis_slug ? ` (${safeBranchText(detail.analysis_slug)})` : ''} violated ${safeBranchText((detail?.violated || []).join(', ') || 'a declared task rule')}`)
    } else if (node.compliance.state === 'unknown') {
      lines.push(`${indent}  compliance: unknown (${safeBranchText(node.compliance.reason)})`)
    }
    for (const child of node.children) renderNode(nodeById.get(child), depth + 1)
  }
  for (const id of report.roots) renderNode(nodeById.get(id), 0)
  if (report.orphans.length) lines.push('', 'Orphans (recorded parent cannot be followed):')
  for (const orphan of report.orphans) renderNode(nodeById.get(orphan.run_id), 0)
  if (report.cycles.length) lines.push('', 'Parent cycles (corrupt or hand-edited ancestry):')
  for (const cycle of report.cycles) for (const id of cycle) renderNode(nodeById.get(id), 0)
  for (const node of report.nodes) renderNode(node, 0)
  if (!report.nodes.length) lines.push('', 'No runs logged.')
  if (report.anomalies.length) {
    lines.push('', 'Anomalies:')
    for (const entry of report.anomalies.slice(0, 20)) {
      const details = Object.entries(entry).filter(([key]) => key !== 'kind').map(([key, value]) => `${key}=${safeBranchText(Array.isArray(value) ? value.join(',') : value)}`).join(' ')
      lines.push(`- ${entry.kind}${details ? `: ${details}` : ''}`)
    }
    if (report.anomalies.length > 20) lines.push(`- … ${report.anomalies.length - 20} more anomaly record(s)`)
  }
  lines.push('', ...report.notes)
  return lines.join('\n')
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
      return [{ type: 'text', text: `Logged ${run.run_id} (${Object.keys(run.metrics).length} metric(s), ${run.artifacts.length} artifact(s))${staged}.${drift}${run.comparison_identity ? `\nComparison scope (user-declared): ${run.comparison_identity.scope_id}` : '\nComparison identity not recorded; not eligible for scoped ranking.'}${undeclared}` }]
    }
    case 'compare': {
      const lines = [`Experiment "${value.comparison.experiment.slug}" — ${value.comparison.runs.length} run(s).`]
      if (value.comparison.note) return [{ type: 'text', text: lines[0] } ]
      lines.push('', ...value.comparison.runs.map(renderRunLine))
      if (value.comparison.comparison_scope) {
        const scope = value.comparison.comparison_scope
        lines.push('', scope.note, `Scope: ${scope.scope_id || 'not selected'}`, `Available scopes: ${scope.available_scopes.join(', ') || 'none'}`, ...scope.assessments.map((entry) => `- ${entry.run_id}: ${entry.state}${entry.reasons.length ? ` (${entry.reasons.join(', ')})` : ''} · scope ${entry.scope_id || 'not recorded'}`))
        for (const detail of scope.scope_details || []) lines.push(`Scope ${detail.scope_id}: dataset ${detail.dataset.id}@${detail.dataset.version_or_hash}, split ${detail.split.id}@${detail.split.version_or_hash}, stage ${detail.stage}, baseline ${detail.baseline_ref}/${detail.baseline_cohort_id}, protocol ${detail.protocol_digest}`)
      }
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
          `Scope: ${value.best.comparison_scope.scope_id} (user-declared, not scientific verification)`,
          `Best by ${value.best.metric} (${value.best.direction}): ${value.best.run.run_id} = ${value.best.run.metrics[value.best.metric]}`,
          renderRunLine(value.best.run),
        )
        if (value.best.tied_runs.length > 1) lines.push(`Tied runs: ${value.best.tied_runs.join(', ')}`)
        if (value.best.excluded_run_ids?.length) lines.push(`Excluded by compliance: ${value.best.excluded_run_ids.join(', ')}`)
      }
      if (value.dominance) {
        if (lines.length) lines.push('')
        lines.push(`Scope: ${value.dominance.comparison_scope.scope_id} (user-declared, not scientific verification)`, `Pareto front over ${value.dominance.metrics.map((metric) => `${metric.name} (${metric.direction})`).join(', ')}:`)
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
      const assessments = value.best?.comparison_scope?.assessments || value.dominance?.comparison_scope?.assessments || []
      if (assessments.length) lines.push('', 'Comparison eligibility:', ...assessments.map((entry) => `- ${entry.run_id}: ${entry.state}${entry.reasons.length ? ` (${entry.reasons.join(', ')})` : ''}`))
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'replicates': {
      const report = value.report
      const stat = (value, reason) => value == null ? `not_checked (${reason})` : formatNumber(value)
      const formatStats = (stats) => `n=${stats.n}, mean=${stat(stats.mean, stats.mean_reason)}, sample SD=${stat(stats.sample_sd, stats.sd_reason)}`
      const lines = [`Repeated runs for ${report.experiment} · scope ${report.scope_id}`, `Metric: ${report.metric} (${report.direction}) · candidate field: ${report.candidate_field} · declared replicate unit: ${report.replicate_unit}`, report.selection_history.note]
      for (const group of report.groups) {
        lines.push('', `${group.candidate} (${group.roles.join('/') || 'role not recorded'}): ${formatStats(group.statistics)}`)
        const gaps = [['missing metric', group.counts.missing_metric], ['non-finite metric', group.counts.nonfinite_metric], ['missing seed', group.counts.missing_or_invalid_seed], ['duplicate seed', group.counts.duplicate_seed], ['unexpected seed', group.counts.unexpected_seed], ['failed linked analysis', group.counts.linked_analysis_failed]].filter(([, count]) => count > 0).map(([name, count]) => `${name}: ${count}`)
        lines.push(`Runs: ${group.counts.runs} · included ${group.counts.included} · excluded ${group.counts.excluded}${gaps.length ? ` · ${gaps.join(' · ')}` : ''}`)
        lines.push(`Seeds expected: ${group.seed_coverage.expected?.join(', ') || 'unknown'}; observed: ${group.seed_coverage.observed.join(', ') || 'none'}; missing eligible: ${group.seed_coverage.missing?.join(', ') || (group.seed_coverage.missing ? 'none' : 'unknown')}; unexpected: ${group.seed_coverage.unexpected?.join(', ') || (group.seed_coverage.unexpected ? 'none' : 'unknown')}`)
        for (const row of group.runs) lines.push(`- ${row.run_id}: seed=${row.seed ?? 'not recorded'}, value=${row.value == null ? 'not recorded' : formatNumber(row.value)}, ${row.included ? 'included' : `not included (${row.reasons.join(', ')})`}`)
        if (!group.runs.length) lines.push('- no recorded runs for this candidate')
        lines.push(`Paired: ${group.paired.state}${group.paired.reason ? ` (${group.paired.reason})` : ''}; ${formatStats(group.paired.statistics)}`)
        for (const pair of group.paired.pairs) lines.push(`- seed ${pair.seed}: ${pair.variant_run_id} ${formatNumber(pair.variant_value)} − ${pair.baseline_run_id} ${formatNumber(pair.baseline_value)} = ${formatNumber(pair.difference)}`)
        for (const entry of group.paired.unpaired) lines.push(`- unpaired ${entry.run_id}: ${entry.reason}`)
        for (const entry of group.paired.unpaired_baselines) lines.push(`- unpaired baseline ${entry.run_id}: ${entry.reason}`)
      }
      if (report.ungrouped.length) lines.push('', `Runs in scope outside selected candidates: ${report.ungrouped.map((entry) => entry.run_id).join(', ')}`)
      lines.push('', ...report.notes)
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'branches': {
      const suffix = value.path ? `\n\nWrote ${value.path} (${value.bytes} bytes).` : ''
      if (value.format === 'mermaid') return [{ type: 'text', text: `${value.mermaid}${suffix}` }]
      if (value.format === 'json') return [{ type: 'text', text: `${JSON.stringify(value.branches, null, 2)}${suffix}` }]
      return [{ type: 'text', text: `${renderBranches(value.branches)}${suffix}` }]
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
      comparison: args.comparison_identity,
      baselineRunId: args.baseline_run_id,
    })
    return { action, run, undeclared_metrics }
  }

  if (action === 'compare') {
    return { action, field: args.field || null, comparison: compareExperiments(cwd, slug, { field: args.field, scopeId: args.scope_id }) }
  }

  if (action === 'best') {
    const best = args.metric ? bestExperimentRun(cwd, slug, { metric: requireString(args.metric, 'metric'), direction: args.direction, scopeId: args.scope_id }) : null
    const dominance = args.dominance ? dominanceExperiment(cwd, slug, { scopeId: args.scope_id }) : null
    if (!best && !dominance) throw new Error('best requires a named metric or dominance: true')
    return { action, best, dominance }
  }

  if (action === 'replicates') {
    return { action, report: summarizeExperimentReplicates(cwd, slug, {
      scopeId: args.scope_id, metric: args.metric, candidateField: args.candidate_field,
      candidates: args.candidates, baselineCandidate: args.baseline_candidate,
      expectedSeeds: args.expected_seeds, coverageUnknown: args.coverage_unknown,
      replicateUnit: args.replicate_unit, selectionHistory: args.selection_history,
    }) }
  }

  if (action === 'branches') {
    const format = text(args.format || 'text').toLowerCase()
    if (!EXPERIMENT_BRANCH_FORMATS.includes(format)) throw new Error(`branches format must be one of ${EXPERIMENT_BRANCH_FORMATS.join(', ')}`)
    if (args.write === true && format !== 'mermaid') throw new Error('branches write is only supported with format: mermaid')
    const branches = experimentBranches(cwd, slug, {
      format,
      write: Boolean(args.write),
      overwrite: Boolean(args.overwrite),
      maxNodes: args.max_nodes,
      maxEdges: args.max_edges,
      maxLinksPerRun: args.max_links_per_run,
    })
    // Optional fields are omitted, never set to undefined: the host rejects a tool result
    // that is not lossless JSON, and undefined is not.
    return {
      action,
      format,
      branches,
      ...(branches.mermaid !== undefined ? { mermaid: branches.mermaid } : {}),
      ...(branches.export?.path !== undefined ? { path: branches.export.path } : {}),
      ...(branches.export?.bytes !== undefined ? { bytes: branches.export.bytes } : {}),
    }
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
    return { action, ...exportExperiment({ cwd, slug, format: args.format || 'markdown', overwrite: Boolean(args.overwrite), scopeId: args.scope_id }) }
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
      'Actions: `start` (question, named metrics with higher/lower directions, an optional benchmark spec — datasets, splits, baseline_arm, task_rules — and an optional protocol: eval_script + metric_params; write-once unless `resume: true`), `log` (append a run: params, metrics, hashed workspace artifacts, seed, parent, environment; staged runs add role baseline|variant, baseline_ref reproduced|reported, stage subset|slice|full, a sampling rule, and a protocol whose SHA-256 is checked against the matching baseline as spec_drift; a rerun is a new run — nothing is deduplicated), `compare` (all runs, best per named metric, optional grouping by a param `field`), `best` (by an explicit `metric` and `direction`, and/or `dominance: true` for the multi-metric Pareto front), `replicates` (read-only repeated-seed and paired-baseline summary; see below), `branches` (read-only parent/child branch view with resolved links, metrics, protocol drift, compliance, and latest verdict; see below), `verdict` (advisory human decision good|engineer|bad with reason, engineering_round, and budget; a budget-exhausted engineer is recorded force-bad), `link` (run → notebook/scientific_result/analysis_run/experiment_run/paper/review id), `status`, `list`, `show`, `export` (csv, json, markdown, or MLflow-compatible json).',
      '`replicates` is a read-only descriptive repeated-seed report: supply scope_id, declared metric, candidate_field, candidates, replicate_unit, and expected_seeds or coverage_unknown: true. Optionally supply baseline_candidate to pair variants with their explicit baseline_run_id and same seed. Duplicate, failed, missing, incompatible, and unexpected runs stay visible and are not silently averaged. No winner, significance, confidence interval, or p-value is computed. Staged variants require an explicit baseline_run_id with the same reference, stage and sampling. Rankings require an explicit scope_id from compare; missing identities, protocol drift, unresolved links and compliance violations are not ranked. A comparison_identity is user-declared and is not scientific verification. Historical runs remain visible but are not silently ranked. Missing metrics stay blank, never zero. Artifact paths are workspace-confined and hashed.',
      '`branches` is a read-only graph over the same ledger: it uses recorded `parent` ids, run records, verdicts, and links and never creates a second ledger. `format: text` (default) is a concise tree, `json` is the structured report, and `mermaid` renders a diagram. Only `format: mermaid` with `write: true` writes anything: `<slug>/exports/branches.mmd` inside the workspace (use `overwrite: true` to replace it). Status is derived only from recorded evidence: `failed` requires a linked analysis execution failure or timeout, `pruned` requires a recorded bad verdict, and missing evidence stays `not_recorded` or `unknown` — missing metrics alone never mean failed. Multiple roots, orphans, missing/self/cyclic parents, unresolved links, and corrupt ledger lines are reported, not hidden. Output is bounded by `max_nodes`, `max_edges`, and `max_links_per_run`; a source snapshot hash reveals concurrent ledger changes. Load the `experiment-tracking` skill for the workflow.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ACTIONS, description: 'start, log, compare, best, replicates, branches, verdict, link, status, list, show, or export. Default status.' },
      slug: { type: 'string', description: 'Experiment slug (stable short name).' },
      experiment: { type: 'object', additionalProperties: true, description: 'Start object: {question, name, metrics:[{name,direction}], benchmark, protocol, notes, resume}.' },
      question: { type: 'string', description: 'Experiment question (start; alternative to experiment.question).' },
      benchmark: { type: 'object', additionalProperties: true, description: 'Start benchmark spec: {datasets:[...], splits:[...], baseline_arm, task_rules:[...]}. Required for staged runs.' },
      protocol: { type: 'object', additionalProperties: true, description: 'Start/log protocol: {eval_script: workspace-relative path, metric_params: object}. The baseline captures its SHA-256 digest; later runs are checked.' },
      role: { type: 'string', enum: EXPERIMENT_ROLES, description: 'log: baseline or variant. Required with baseline_ref/stage/sampling.' },
      baseline_ref: { type: 'string', enum: EXPERIMENT_BASELINE_REFS, description: 'log: reproduced or reported — which reference this run compares against. Variants must match a baseline with the same ref.' },
      baseline_run_id: { type: 'string', description: 'log: required for staged variants; explicit baseline run in this ledger with matching reference, stage and sampling.' },
      comparison_identity: { type: 'object', additionalProperties: true, description: 'log: user-declared {dataset:{id,version_or_hash}, split:{id,version_or_hash}, baseline_cohort_id, metric_definitions:{metric:{unit,implementation,parameters:{...}}}}. Required to rank; dataset and split must be declared in benchmark.' },
      scope_id: { type: 'string', description: 'Explicit scope hash from compare, required for best/dominance/replicates; compare and export use it to produce scoped rankings.' },
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
      candidate_field: { type: 'string', description: 'replicates: exact params key containing the user-declared candidate name.' },
      candidates: { type: 'array', items: { type: 'string' }, description: 'replicates: explicit candidate names, including the baseline candidate if pairing.' },
      baseline_candidate: { type: 'string', description: 'replicates: optional candidate name whose runs have baseline role; pairs use the explicitly linked baseline and matching seed.' },
      expected_seeds: { type: 'array', items: { type: 'number' }, description: 'replicates: expected distinct seeds; omit only with coverage_unknown: true.' },
      coverage_unknown: { type: 'boolean', description: 'replicates: explicitly state seed coverage is unknown; do not combine with expected_seeds.' },
      replicate_unit: { type: 'string', description: 'replicates: user-declared independent unit (not verified).' },
      selection_history: { type: 'string', enum: ['unknown', 'exploratory', 'declared_preplanned'], description: 'replicates: user-declared selection history; defaults to unknown.' },
      metric: { type: 'string', description: 'Declared metric name for best or replicates; omit for best when using dominance: true.' },
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
      format: { type: 'string', enum: FORMATS, description: 'Export format: csv, json, markdown, or MLflow-compatible json (export, default markdown); text, json, or mermaid (branches, default text).' },
      write: { type: 'boolean', description: 'branches: write the Mermaid diagram to the workspace exports directory (requires format: mermaid; default false).' },
      max_nodes: { type: 'integer', description: 'branches: maximum run nodes to include (default 500, max 5000).' },
      max_edges: { type: 'integer', description: 'branches: maximum parent-child edges to include (default 1000, max 10000).' },
      max_links_per_run: { type: 'integer', description: 'branches: maximum links resolved per run (default 50, max 500).' },
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
