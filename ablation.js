/**
 * ablation: component attribution ledger. It plans a removal grid, links each
 * cell to an existing experiment/analysis run, reports paired deltas, and records
 * an advisory human verdict. It never runs an experiment.
 */
import { defineTool } from 'ah-dsh-tools'
import {
  ABLATION_EXPORT_FORMATS, ABLATION_VERDICTS,
  exportAblation, planAblation, pruneAblation, recordAblation,
  reportAblation, showAblation, startAblation, statusAblation, verdictAblation,
} from './ablation-store.js'

const ACTIONS = ['start', 'plan', 'record', 'report', 'verdict', 'prune', 'show', 'status', 'export']

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

function reportLine(report) {
  const a = report.attribution
  return `Attribution reading: attributed ${a.attributed.join(', ') || 'none'}; unattributed ${a.unattributed.join(', ') || 'none'}; partial ${a.partial.join(', ') || 'none'}; not_checked ${a.not_checked.join(', ') || 'none'}. Advisory only.`
}

function renderValue(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  switch (value.action) {
    case 'start': {
      const a = value.ablation
      return [{ type: 'text', text: `Ablation "${a.slug}" started for champion idea ${a.idea_id}${a.idea_source ? ` (${a.idea_source})` : ''}: ${a.name}.` }]
    }
    case 'plan': {
      const p = value.plan
      const removal = p.arms.filter((arm) => arm.id !== p.reference_arm)
      return [{ type: 'text', text: `Planned ${p.arms.length} arm(s) (${removal.length} removal), ${p.datasets.length} dataset(s), ${p.metrics.length} metric(s), ${p.replicates} replicate(s); reference ${p.reference_arm}.\n${removal.map((arm) => `- ${arm.id}: removes ${arm.component} (${arm.code_path}); expects ${arm.expected.map((entry) => `${entry.metric} ${entry.change}`).join(', ')}`).join('\n')}` }]
    }
    case 'record': {
      const r = value.record
      const missing = r.missing_metrics.length ? `\nMissing declared metrics: ${r.missing_metrics.join(', ')}` : ''
      return [{ type: 'text', text: `Recorded ${r.record_id}: ${r.arm} / ${r.dataset} / rep ${r.replicate} ← ${r.source.ledger}:${r.source.slug}/${r.source.run_id} (${r.metrics ? Object.keys(r.metrics).length : 0} metric(s)).${missing}` }]
    }
    case 'report': {
      const report = value.report
      const lines = [
        `Ablation "${report.definition.slug}": ${report.records} record(s), ${report.row_total} paired row(s), ${report.tie_total} tie(s), ${report.missing_total} missing cell(s).`,
      ]
      for (const component of report.attribution.components || []) {
        lines.push(`- ${component.arm}${component.component ? ` (${component.component})` : ''}: ${component.reading}`)
        for (const [metric, summary] of Object.entries(component.metrics || {})) {
          lines.push(`    ${metric}: ${summary.n} pair(s), mean Δ ${summary.mean_delta ?? '—'}, expected ${summary.expected_change || 'any'}, matched ${summary.matched}/${summary.n}, ties ${summary.ties}`)
        }
      }
      lines.push(reportLine(report))
      if (report.latest_verdict) lines.push(`Latest verdict: ${report.latest_verdict.verdict}${report.latest_verdict.arm ? ` on ${report.latest_verdict.arm}` : ''} — ${report.latest_verdict.reason}.`)
      lines.push(report.note)
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'verdict': {
      const verdict = value.verdict
      return [{ type: 'text', text: `Verdict ${verdict.verdict_id}: ${verdict.verdict}${verdict.arm ? ` on ${verdict.arm}` : ''} — ${verdict.reason}.` }]
    }
    case 'prune': {
      const prune = value.prune
      return [{ type: 'text', text: `Pruned ${prune.prune_id}: ${prune.arm} (${prune.component}) — ${prune.reason}.` }]
    }
    case 'show': {
      if (value.record) {
        const record = value.record
        return [{ type: 'text', text: `${record.record_id}: ${record.arm} / ${record.dataset} / rep ${record.replicate} ← ${record.source.ledger}:${record.source.slug}/${record.source.run_id}\nmetrics: ${JSON.stringify(record.metrics)}\nmissing: ${record.missing_metrics.join(', ') || 'none'}${value.verdicts?.length ? `\nverdicts: ${value.verdicts.map((entry) => `${entry.verdict} — ${entry.reason}`).join('; ')}` : ''}` }]
      }
      if (value.report) {
        const report = value.report
        const lines = [
          `Ablation "${report.definition.slug}" — ${report.records} record(s), ${report.verdicts.length} verdict(s).`,
          `Plan: ${report.plan.arms.length} arm(s), ${report.plan.datasets.length} dataset(s), ${report.plan.metrics.length} metric(s), ${report.plan.replicates} replicate(s); reference ${report.plan.reference_arm}.`,
          ...report.plan.arms.filter((arm) => arm.id !== report.plan.reference_arm).map((arm) => `- ${arm.id}: removes ${arm.component}; expects ${arm.expected.map((entry) => `${entry.metric} ${entry.change}`).join(', ')}`),
          reportLine(report),
          `Ties: ${report.tie_total}; missing cells: ${report.missing_total}.`,
          ...(report.verdicts.length ? [`Verdicts: ${report.verdicts.map((entry) => `${entry.verdict}${entry.arm ? ` (${entry.arm})` : ''}`).join(', ')}`] : []),
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      }
      if (value.records) {
        return [{ type: 'text', text: `${value.records.length} record(s) for this ablation${value.verdicts?.length ? `; verdicts: ${value.verdicts.map((entry) => entry.verdict).join(', ')}` : ''}.` }]
      }
      return [{ type: 'text', text: `${JSON.stringify({ definition: value.definition, plan: value.plan, verdicts: value.verdicts ?? [], prunes: value.prunes ?? [] }, null, 2)}` }]
    }
    case 'status': {
      const s = value.status
      const lines = [
        `Ablation "${s.slug}" — ${s.records} record(s), ${s.verdicts} verdict(s), ${s.pruned.length} pruned arm(s).`,
        `Idea: ${s.idea_id}${s.question ? ` · ${s.question}` : ''}`,
      ]
      if (s.plan) lines.push(`Plan: ${s.plan.arms} arm(s) (${s.plan.removal_arms} removal), ${s.plan.datasets} dataset(s), ${s.plan.metrics} metric(s), ${s.plan.replicates} replicate(s); reference ${s.plan.reference_arm}.`)
      else lines.push('Plan: not created.')
      if (s.attribution) lines.push(`Reading: attributed ${s.attribution.attributed.join(', ') || 'none'}; unattributed ${s.attribution.unattributed.join(', ') || 'none'}; partial ${s.attribution.partial.join(', ') || 'none'}; not_checked ${s.attribution.not_checked.join(', ') || 'none'}.`)
      if (s.latest_verdict) lines.push(`Latest verdict: ${s.latest_verdict.verdict}${s.latest_verdict.arm ? ` on ${s.latest_verdict.arm}` : ''}.`)
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'export':
      return [{ type: 'text', text: `Wrote ${value.path} (${value.bytes} bytes, ${value.format}).` }]
    default:
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }
}

export async function runAblationAction(args = {}, exec = {}) {
  const action = args.action || 'status'
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  const slug = requireString(args.slug, 'slug')

  if (action === 'start') {
    const { ablation } = await startAblation({
      cwd, slug,
      ideaId: requireString(args.idea_id, 'idea_id'),
      ideaSource: args.idea_source,
      method: args.method,
      name: args.name,
      question: args.question,
    })
    return { action, ablation }
  }
  if (action === 'plan') {
    const { plan } = await planAblation({ cwd, slug, plan: args.plan })
    return { action, plan }
  }
  if (action === 'record') {
    const { record } = await recordAblation({
      cwd, slug,
      arm: requireString(args.arm, 'arm'),
      dataset: requireString(args.dataset, 'dataset'),
      replicate: args.replicate,
      experimentSlug: args.experiment_slug,
      experimentRunId: args.experiment_run_id,
      analysisSlug: args.analysis_slug,
      analysisRunId: args.analysis_run_id,
      metrics: args.metrics,
    })
    return { action, record }
  }
  if (action === 'report') return { action, report: reportAblation(cwd, slug) }
  if (action === 'verdict') {
    const { verdict } = await verdictAblation({
      cwd, slug,
      verdict: args.verdict,
      reason: args.reason,
      arm: args.arm,
      component: args.component,
    })
    return { action, verdict }
  }
  if (action === 'prune') {
    const { prune } = await pruneAblation({ cwd, slug, arm: requireString(args.arm, 'arm'), reason: args.reason })
    return { action, prune }
  }
  if (action === 'show') return { action, ...showAblation(cwd, slug, { recordId: args.record_id, arm: args.arm }) }
  if (action === 'status') return { action, status: statusAblation(cwd, slug) }
  if (action === 'export') return { action, ...exportAblation({ cwd, slug, format: args.format, overwrite: Boolean(args.overwrite) }) }
  throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
}

export const name = 'academic-harness-ablation'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'ablation',
    description: [
      'Keep a component-ablation and attribution ledger under `.dsh/ablation/<slug>/`. It never runs an experiment: `record` links a plan cell to an existing `experiment_log` run (metrics come from that run) or an `analysis_run` with hashed outputs (the metric reading is supplied), so every number has a stored source.',
      'Actions: `start` (bind a method spec and champion idea id from `coscientist`; write-once), `plan` (freeze component × arm × dataset × metric plan: arms naming the removed component/code path and expected metric change, datasets, metrics with directions, replicates, and a reference arm), `record` (link arm/dataset/replicate to a run), `report` (paired removal deltas against the reference, with ties, missing cells, and an advisory attribution reading), `verdict` (human good|refine|unattributed with reason), `prune` (append-only arm pruning), `show`, `status`, `export` (markdown/json/csv).',
      'A component is read as attributed only when removing it changes every paired expected metric in the declared direction; missing or tied cells are not evidence. The attribution reading is advisory and the human verdict is separate. No value here is a scientific claim. Load the `ablation-attribution` skill for the workflow.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ACTIONS, description: 'start, plan, record, report, verdict, prune, show, status, or export. Default status.' },
      slug: { type: 'string', description: 'Ablation slug (stable short name).' },
      idea_id: { type: 'string', description: 'start: champion idea id from coscientist.' },
      idea_source: { type: 'string', description: 'start: optional source reference for the idea, e.g. a coscientist slug.' },
      method: { type: 'object', additionalProperties: true, description: 'start: method/mechanism spec being ablated.' },
      name: { type: 'string', description: 'start: display name. Defaults to the slug.' },
      question: { type: 'string', description: 'start: optional question this ablation answers.' },
      plan: {
        type: 'object',
        additionalProperties: true,
        description: 'plan: {arms:[{id,component,code_path,removal,expected:[{metric,change}]}], datasets:[...], metrics:[{name,direction}], replicates, reference_arm}. Leave expected empty only on the reference arm.',
      },
      arm: { type: 'string', description: 'record/verdict/prune/show: plan arm id.' },
      dataset: { type: 'string', description: 'record: dataset named in the plan.' },
      replicate: { type: 'integer', description: 'record: replicate number, 1..plan.replicates. Default 1.' },
      experiment_slug: { type: 'string', description: 'record: experiment_log slug for the linked run.' },
      experiment_run_id: { type: 'string', description: 'record: experiment_log run id.' },
      analysis_slug: { type: 'string', description: 'record: analysis_run slug for the linked run.' },
      analysis_run_id: { type: 'string', description: 'record: analysis_run run id with hashed outputs.' },
      metrics: { type: 'object', additionalProperties: true, description: 'record: metric values read from hashed analysis outputs; omit for experiment_log (metrics come from the linked run).' },
      record_id: { type: 'string', description: 'show: a stored record id.' },
      verdict: { type: 'string', enum: ABLATION_VERDICTS, description: 'verdict: good, refine, or unattributed (advisory human decision).' },
      reason: { type: 'string', description: 'verdict/prune: required reason.' },
      component: { type: 'string', description: 'verdict: optional component label.' },
      format: { type: 'string', enum: ABLATION_EXPORT_FORMATS, description: 'export: markdown, json, or csv. Default markdown.' },
      overwrite: { type: 'boolean', description: 'export: replace an existing export (default false).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return await runAblationAction(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Ablation: ${args.slug || ''} (${args.action || 'status'})`, kind: 'other' }
    },
  }))
}
