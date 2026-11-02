/**
 * grant_budget: a multi-year budget ledger with explicit rates and arithmetic
 * checks.
 *
 * The tool computes from supplied rates and line items. It never invents a
 * salary, fringe rate, indirect rate, cap, or eligibility rule, and it does not
 * submit anything.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  BUDGET_ACTIONS, BUDGET_EXPORT_FORMATS,
  budgetStatus, computeBudgetStore, exportBudget, startBudget,
} from './grant-budget-store.js'

function text(value) {
  return String(value ?? '').trim()
}

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function renderStart(value) {
  return [
    `Budget "${value.slug}" ${value.unchanged ? 'is unchanged' : value.updated ? 'updated' : 'started'}.`,
    `Hash: ${value.hash}`,
    'Rates and line items are recorded as supplied; run action=compute for the multi-year table and checks.',
  ].join('\n')
}

function renderCompute(value) {
  const computation = value.computation
  const lines = [
    `Budget "${value.slug}" computed: direct ${computation.input.currency} ${computation.totals.direct.toLocaleString()} · indirect ${computation.input.currency} ${computation.totals.indirect.toLocaleString()} · total ${computation.input.currency} ${computation.totals.total.toLocaleString()}.`,
    `Years: ${computation.rows.length}${computation.totals.cost_share ? ` · cost share ${computation.input.currency} ${computation.totals.cost_share.toLocaleString()}` : ''}.`,
  ]
  for (const row of computation.rows) lines.push(`- Year ${row.year}${row.calendar_year ? ` (${row.calendar_year})` : ''}: direct ${row.direct_total} · indirect ${row.indirect} · total ${row.total}`)
  if (computation.failed_checks.length) lines.push('', `Failed checks: ${computation.failed_checks.join(', ')}.`)
  else lines.push('', 'Arithmetic checks passed; this is not a funder allowability or eligibility decision.')
  const manual = computation.checks.filter((check) => check.status === 'manual_check')
  if (manual.length) lines.push(...manual.map((check) => `Manual: ${check.detail}`))
  lines.push('', computation.note)
  return lines.join('\n')
}

function renderStatus(status) {
  if (!status.input) return `Budget "${status.slug}" has not been started.`
  const computation = status.computation
  return [
    `Budget "${status.slug}": ${status.input.title}`,
    `Currency: ${status.input.currency} · years: ${status.input.years} · versions: ${status.versions}.`,
    computation ? `Latest computation: total ${status.input.currency} ${computation.totals.total.toLocaleString()}${computation.failed_checks.length ? ` · failed checks ${computation.failed_checks.join(', ')}` : ''}.` : 'No computation recorded yet.',
  ].join('\n')
}

function renderExport(value) {
  if (value.result.success === false) return `XLSX export failed: ${value.result.error}\n${value.result.note || ''}`
  return `Wrote ${value.result.path} (${value.result.format}).`
}

function renderValue(value) {
  if (value?.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  switch (value.action) {
    case 'start': return [{ type: 'text', text: renderStart(value) }]
    case 'compute': return [{ type: 'text', text: renderCompute(value) }]
    case 'status': return [{ type: 'text', text: renderStatus(value.status) }]
    case 'export': return [{ type: 'text', text: renderExport(value) }]
    default: return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }
}

function inputFromArgs(args) {
  const input = args.input && typeof args.input === 'object' ? { ...args.input } : {}
  for (const field of ['title', 'funder', 'institution', 'currency', 'start_year', 'years', 'personnel', 'equipment', 'supplies', 'travel', 'publication', 'other', 'subawards', 'cost_share', 'indirect_rate', 'indirect_cap', 'caps', 'notes']) {
    if (args[field] !== undefined) input[field] = args[field]
  }
  return input
}

export async function runBudgetAction(args, exec) {
  const action = args.action || 'status'
  if (!BUDGET_ACTIONS.includes(action)) throw new Error(`action must be one of ${BUDGET_ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  const slug = text(args.slug)
  if (!slug) throw new Error('slug is required')
  if (action === 'start') {
    return { action, ...(await startBudget({ cwd, slug, input: inputFromArgs(args), reason: args.reason, recordedBy: args.recorded_by })) }
  }
  if (action === 'compute') {
    return { action, slug, computation: await computeBudgetStore({ cwd, slug }) }
  }
  if (action === 'export') {
    return { action, result: await exportBudget({ cwd, slug, format: args.format || 'csv', out: args.out, overwrite: Boolean(args.overwrite) }) }
  }
  return { action, status: budgetStatus(cwd, slug) }
}

export const name = 'academic-harness-grant-budget'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'grant_budget',
    description: [
      'Build and check a multi-year grant budget under `.dsh/budget/<slug>/`: `start` (personnel with salary, effort/person-months, fringe, escalation; equipment, supplies, travel, publication, other, subawards, cost share; indirect rate, optional cap; funder/institution/currency), `compute` (multi-year table, indirect base, totals, arithmetic and cap checks, justification), `status`, and `export` (CSV, Markdown, JSON, or XLSX).',
      'Every rate and amount comes from the user; a missing fringe or indirect rate is an error rather than a guessed default. The computation checks arithmetic and stated caps, not funder allowability, eligibility, or submission rules. No budget is submitted. Load the `grant-budget` skill for the build and review workflow.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: BUDGET_ACTIONS, description: 'start, compute, status, or export. Default status.' },
      slug: { type: 'string', description: 'Budget slug.' },
      input: { type: 'object', additionalProperties: true, description: 'start: full budget object (flat fields also accepted).' },
      title: { type: 'string', description: 'Project title.' },
      funder: { type: 'string', description: 'Funder.' },
      institution: { type: 'string', description: 'Institution.' },
      currency: { type: 'string', description: 'Currency code (default USD only as a label if omitted).' },
      start_year: { type: 'number', description: 'First calendar year (optional).' },
      years: { type: 'number', description: 'Number of budget years, 1–10.' },
      personnel: { type: 'array', description: 'Personnel: [{role, name?, base_salary, effort (0–1) or person_months (0–12), fringe_rate, escalation?}].' },
      equipment: { type: 'array', description: 'Equipment line items: [{label, amount, year?|start_year?/end_year?|years?|annual?, escalation?, include_in_indirect_base?}].' },
      supplies: { type: 'array', description: 'Supplies line items.' },
      travel: { type: 'array', description: 'Travel line items.' },
      publication: { type: 'array', description: 'Publication line items.' },
      other: { type: 'array', description: 'Other direct-cost line items.' },
      subawards: { type: 'array', description: 'Subaward line items (excluded from the indirect base by default).' },
      cost_share: { type: 'array', description: 'Cost-share line items (reported separately, not in the requested total).' },
      indirect_rate: { type: 'number', description: 'Indirect rate as a decimal (0.55 = 55%); required.' },
      indirect_cap: { type: 'number', description: 'Optional per-year indirect-cost cap.' },
      caps: { type: 'object', additionalProperties: true, description: 'Optional caps {indirect_rate_max, total_max}.' },
      notes: { type: 'string', description: 'Notes.' },
      reason: { type: 'string', description: 'Why the budget changed (required after the first start).' },
      format: { type: 'string', enum: BUDGET_EXPORT_FORMATS, description: 'Export format (default csv).' },
      out: { type: 'string', description: 'Export: workspace-relative path.' },
      overwrite: { type: 'boolean', description: 'Replace an existing export.' },
      recorded_by: { type: 'string', description: 'Who recorded the event.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return await runBudgetAction(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Grant budget: ${args.slug || ''} (${args.action || 'status'})`, kind: 'other' }
    },
  }))
}
