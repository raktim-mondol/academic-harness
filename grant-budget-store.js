/**
 * Grant-budget ledger under `<cwd>/.dsh/budget/<slug>/`.
 *
 * Inputs are versioned append-only; the computation is derived and stored with
 * its arithmetic checks. Rates, salaries, and caps are user-supplied. The tool
 * never invents a rate, eligibility rule, or submission; it does not decide
 * what a funder will allow.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  appendJsonl, csvCell, ensureDir, exportText, nowIso, readJsonl,
  sha256, slug as slugify, stableStringify,
} from './ledger-kit.js'
import { withLock } from './store-lock.js'
import { resolveWorkspacePath } from './workspace-path.js'
import { runHelper } from './python-runtime.js'

export const BUDGET_ACTIONS = ['start', 'compute', 'status', 'export']
export const BUDGET_EXPORT_FORMATS = ['csv', 'markdown', 'json', 'xlsx']
export const BUDGET_CATEGORIES = ['equipment', 'supplies', 'travel', 'publication', 'other', 'subawards', 'cost_share']
const CATEGORY_LABELS = {
  personnel: 'Personnel', equipment: 'Equipment', supplies: 'Supplies', travel: 'Travel',
  publication: 'Publication costs', other: 'Other direct costs', subawards: 'Subawards', cost_share: 'Cost share',
}

function text(value) {
  return String(value ?? '').trim()
}

function number(value, name, { min = 0, max = null, integer = false } = {}) {
  const result = Number(value)
  if (!Number.isFinite(result)) throw new Error(`${name} must be a number`)
  if (integer && !Number.isInteger(result)) throw new Error(`${name} must be an integer`)
  if (result < min) throw new Error(`${name} must be >= ${min}`)
  if (max != null && result > max) throw new Error(`${name} must be <= ${max}`)
  return result
}

function rate(value, name, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw new Error(`${name} is required; say explicitly if the rate is 0`)
    return 0
  }
  return number(value, name, { min: 0, max: 2 })
}

export function budgetSlug(value) {
  const slug = slugify(value, 80)
  if (!slug) throw new Error('slug must contain at least one letter or digit')
  return slug
}

export function budgetDir(cwd, value) {
  return join(cwd, '.dsh', 'budget', budgetSlug(value))
}

function files(cwd, value) {
  const dir = budgetDir(cwd, value)
  return { dir, ledger: join(dir, 'budget.jsonl'), exports: join(dir, 'exports') }
}

function lineItems(value, years, category) {
  if (value == null || value === '') return []
  if (!Array.isArray(value)) throw new Error(`${category} must be an array of line items`)
  return value.map((entry, index) => {
    if (typeof entry === 'number') {
      return { label: `${CATEGORY_LABELS[category]} item ${index + 1}`, annual: Array(years).fill(number(entry, `${category}[${index}]`)), escalation: 0, include_in_indirect_base: !['equipment', 'subawards', 'cost_share'].includes(category) }
    }
    if (!entry || typeof entry !== 'object') throw new Error(`${category} items must be objects or numbers`)
    let annual
    if (Array.isArray(entry.annual)) {
      if (entry.annual.length !== years) throw new Error(`${category}[${index}].annual must have ${years} entries`)
      annual = entry.annual.map((valueEntry, yearIndex) => number(valueEntry ?? 0, `${category}[${index}].annual[${yearIndex}]`))
    } else if (Array.isArray(entry.years)) {
      if (entry.years.length !== years) throw new Error(`${category}[${index}].years must have ${years} entries`)
      annual = entry.years.map((valueEntry, yearIndex) => number(valueEntry ?? 0, `${category}[${index}].years[${yearIndex}]`))
    } else {
      const amount = number(entry.amount ?? entry.total, `${category}[${index}].amount`)
      if (entry.year != null) {
        const yearIndex = number(entry.year, `${category}[${index}].year`, { min: 1, max: years, integer: true }) - 1
        annual = Array(years).fill(0)
        annual[yearIndex] = amount
      } else if (entry.start_year != null || entry.end_year != null) {
        const start = number(entry.start_year ?? 1, `${category}[${index}].start_year`, { min: 1, max: years, integer: true })
        const end = number(entry.end_year ?? years, `${category}[${index}].end_year`, { min: start, max: years, integer: true })
        annual = Array(years).fill(0)
        for (let year = start; year <= end; year += 1) annual[year - 1] = amount
      } else {
        annual = Array(years).fill(amount)
      }
    }
    return {
      label: text(entry.label || entry.name || entry.category) || `${CATEGORY_LABELS[category]} item ${index + 1}`,
      annual,
      escalation: rate(entry.escalation, `${category}[${index}].escalation`),
      include_in_indirect_base: entry.include_in_indirect_base == null
        ? !['equipment', 'subawards', 'cost_share'].includes(category)
        : Boolean(entry.include_in_indirect_base),
      note: text(entry.note) || null,
    }
  })
}

function personnelItems(value, years) {
  if (!Array.isArray(value) || !value.length) throw new Error('personnel must be a non-empty array')
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error('personnel entries must be objects')
    const base = number(entry.base_salary ?? entry.salary, `personnel[${index}].base_salary`)
    let effort
    if (entry.effort != null && entry.effort !== '') {
      effort = number(entry.effort, `personnel[${index}].effort`, { min: 0, max: 1 })
    } else if (entry.person_months != null && entry.person_months !== '') {
      effort = number(entry.person_months, `personnel[${index}].person_months`, { min: 0, max: 12 }) / 12
    } else {
      throw new Error(`personnel[${index}] needs effort (0–1) or person_months`)
    }
    if (effort === 0) throw new Error(`personnel[${index}].effort must be greater than 0`)
    return {
      role: text(entry.role || entry.title) || `Personnel ${index + 1}`,
      name: text(entry.name) || null,
      base_salary: base,
      effort,
      person_months: round2(effort * 12),
      fringe_rate: rate(entry.fringe_rate, `personnel[${index}].fringe_rate`, { required: true }),
      escalation: rate(entry.escalation, `personnel[${index}].escalation`),
      note: text(entry.note) || null,
    }
  })
}

export function normalizeBudgetInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('budget input must be an object')
  const years = number(input.years ?? 1, 'years', { min: 1, max: 10, integer: true })
  const startYear = input.start_year == null || input.start_year === '' ? null : number(input.start_year, 'start_year', { integer: true })
  const out = {
    title: text(input.title) || null,
    funder: text(input.funder) || null,
    institution: text(input.institution) || null,
    currency: text(input.currency).toUpperCase() || null,
    start_year: startYear,
    years,
    personnel: personnelItems(input.personnel, years),
    equipment: lineItems(input.equipment, years, 'equipment'),
    supplies: lineItems(input.supplies, years, 'supplies'),
    travel: lineItems(input.travel, years, 'travel'),
    publication: lineItems(input.publication, years, 'publication'),
    other: lineItems(input.other, years, 'other'),
    subawards: lineItems(input.subawards, years, 'subawards'),
    cost_share: lineItems(input.cost_share, years, 'cost_share'),
    indirect_rate: rate(input.indirect_rate, 'indirect_rate', { required: true }),
    indirect_cap: input.indirect_cap == null || input.indirect_cap === '' ? null : number(input.indirect_cap, 'indirect_cap'),
    caps: {
      indirect_rate_max: input.caps?.indirect_rate_max == null ? null : rate(input.caps.indirect_rate_max, 'caps.indirect_rate_max'),
      total_max: input.caps?.total_max == null ? null : number(input.caps.total_max, 'caps.total_max'),
    },
    notes: text(input.notes) || null,
  }
  if (!out.title) throw new Error('title is required')
  if (!out.currency) { out.currency = 'USD'; out.currency_defaulted = true }
  return out
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function escalated(amount, escalation, year) {
  return amount * (1 + escalation) ** (year - 1)
}

export function computeBudget(input) {
  const years = input.years
  const rows = []
  const personnelDetail = []
  const lineItemsOut = []
  for (let year = 1; year <= years; year += 1) {
    const personRows = input.personnel.map((person) => {
      const salary = person.base_salary * (1 + person.escalation) ** (year - 1)
      const amount = salary * person.effort * (1 + person.fringe_rate)
      const detail = {
        year, role: person.role, name: person.name, effort: person.effort,
        person_months: person.person_months, base_salary: round2(salary),
        fringe_rate: person.fringe_rate, amount: round2(amount),
      }
      personnelDetail.push(detail)
      return detail
    })
    const personnelAmount = personRows.reduce((sum, entry) => sum + entry.amount, 0)
    const categoryAmount = (category) => input[category].reduce((sum, item) => sum + item.annual[year - 1] * (1 + item.escalation) ** (year - 1), 0)
    const categoryBase = (category) => input[category]
      .filter((item) => item.include_in_indirect_base)
      .reduce((sum, item) => sum + item.annual[year - 1] * (1 + item.escalation) ** (year - 1), 0)
    const equipmentAmount = categoryAmount('equipment')
    const suppliesAmount = categoryAmount('supplies')
    const travelAmount = categoryAmount('travel')
    const publicationAmount = categoryAmount('publication')
    const otherAmount = categoryAmount('other')
    const subawardAmount = categoryAmount('subawards')
    const costShareAmount = categoryAmount('cost_share')
    const direct = personnelAmount + equipmentAmount + suppliesAmount + travelAmount + publicationAmount + otherAmount + subawardAmount
    const indirectBase = personnelAmount
      + categoryBase('supplies') + categoryBase('travel') + categoryBase('publication') + categoryBase('other')
      + categoryBase('equipment')
      + categoryBase('subawards')
    let indirect = indirectBase * input.indirect_rate
    if (input.indirect_cap != null) indirect = Math.min(indirect, input.indirect_cap)
    const total = direct + indirect
    rows.push({
      year,
      calendar_year: input.start_year == null ? null : input.start_year + year - 1,
      personnel: round2(personnelAmount),
      equipment: round2(equipmentAmount),
      supplies: round2(suppliesAmount),
      travel: round2(travelAmount),
      publication: round2(publicationAmount),
      other: round2(otherAmount),
      subawards: round2(subawardAmount),
      direct_total: round2(direct),
      indirect_base: round2(indirectBase),
      indirect: round2(indirect),
      total: round2(total),
      cost_share: round2(costShareAmount),
    })
    for (const category of ['equipment', 'supplies', 'travel', 'publication', 'other', 'subawards', 'cost_share']) {
      for (const item of input[category]) {
        const amount = item.annual[year - 1] * (1 + item.escalation) ** (year - 1)
        if (amount === 0) continue
        lineItemsOut.push({ year, category, label: item.label, amount: round2(amount), include_in_indirect_base: item.include_in_indirect_base, note: item.note })
      }
    }
  }
  const totals = {
    personnel: round2(rows.reduce((sum, row) => sum + row.personnel, 0)),
    equipment: round2(rows.reduce((sum, row) => sum + row.equipment, 0)),
    supplies: round2(rows.reduce((sum, row) => sum + row.supplies, 0)),
    travel: round2(rows.reduce((sum, row) => sum + row.travel, 0)),
    publication: round2(rows.reduce((sum, row) => sum + row.publication, 0)),
    other: round2(rows.reduce((sum, row) => sum + row.other, 0)),
    subawards: round2(rows.reduce((sum, row) => sum + row.subawards, 0)),
    direct: round2(rows.reduce((sum, row) => sum + row.direct_total, 0)),
    indirect: round2(rows.reduce((sum, row) => sum + row.indirect, 0)),
    total: round2(rows.reduce((sum, row) => sum + row.total, 0)),
    cost_share: round2(rows.reduce((sum, row) => sum + row.cost_share, 0)),
  }
  const checks = []
  for (const row of rows) {
    const expected = round2(row.personnel + row.equipment + row.supplies + row.travel + row.publication + row.other + row.subawards)
    checks.push({ id: `year_${row.year}_direct`, status: Math.abs(expected - row.direct_total) < 0.01 ? 'pass' : 'fail', detail: `${expected} vs ${row.direct_total}` })
    const expectedTotal = round2(row.direct_total + row.indirect)
    checks.push({ id: `year_${row.year}_total`, status: Math.abs(expectedTotal - row.total) < 0.01 ? 'pass' : 'fail', detail: `${expectedTotal} vs ${row.total}` })
  }
  if (input.caps.indirect_rate_max != null) {
    checks.push({ id: 'indirect_rate_cap', status: input.indirect_rate <= input.caps.indirect_rate_max ? 'pass' : 'fail', detail: `rate ${input.indirect_rate} vs cap ${input.caps.indirect_rate_max}` })
  }
  if (input.caps.total_max != null) {
    const over = rows.filter((row) => row.total > input.caps.total_max).map((row) => row.year)
    checks.push({ id: 'total_cap', status: over.length ? 'fail' : 'pass', detail: over.length ? `over cap in year(s) ${over.join(', ')}` : `total within ${input.caps.total_max}` })
  }
  if (input.currency_defaulted) checks.push({ id: 'currency', status: 'manual_check', detail: 'No currency was supplied; USD was used as a label. Change it before sharing the budget.' })
  checks.push({ id: 'rates', status: 'pass', detail: `fringe rates, indirect rate ${input.indirect_rate}, and escalations are the values supplied in the ledger.` })
  return {
    input,
    rows,
    personnel: personnelDetail,
    line_items: lineItemsOut,
    totals,
    checks,
    failed_checks: checks.filter((check) => check.status === 'fail').map((check) => check.id),
    note: 'Arithmetic is checked against the entered rates. Funders and institutions decide allowability, caps, and eligibility; no rate or eligibility rule is inferred.',
  }
}

export function budgetJustification(computation) {
  const input = computation.input
  const lines = [
    `# Budget justification: ${input.title}`,
    '',
    `**Currency:** ${input.currency} · **Years:** ${input.years}${input.start_year ? ` starting ${input.start_year}` : ''} · **Indirect rate:** ${input.indirect_rate}`,
    '',
    '## Personnel',
    '',
  ]
  for (const person of input.personnel) {
    lines.push(`- **${person.role}**${person.name ? ` (${person.name})` : ''}: ${round2(person.effort * 100)}% effort (${person.person_months} person-months) per year; base salary ${input.currency} ${person.base_salary.toLocaleString()}; fringe ${round2(person.fringe_rate * 100)}%; escalation ${round2(person.escalation * 100)}%.${person.note ? ` ${person.note}` : ''}`)
  }
  for (const category of ['equipment', 'supplies', 'travel', 'publication', 'other', 'subawards']) {
    const items = computation.line_items.filter((item) => item.category === category)
    if (!items.length) continue
    lines.push('', `## ${CATEGORY_LABELS[category]}`, '')
    for (const item of items) lines.push(`- ${item.label}: ${input.currency} ${item.amount.toLocaleString()} (year ${item.year})${item.note ? ` — ${item.note}` : ''}`)
  }
  if (computation.totals.cost_share) {
    lines.push('', '## Cost share', '')
    for (const item of computation.line_items.filter((entry) => entry.category === 'cost_share')) lines.push(`- ${item.label}: ${input.currency} ${item.amount.toLocaleString()} (year ${item.year})`)
  }
  lines.push('', '## Indirect costs', '', `Indirect costs are applied at ${input.indirect_rate} to the direct-cost base recorded in the ledger; equipment and subawards are excluded unless their line item says otherwise.${input.indirect_cap != null ? ` An indirect cap of ${input.indirect_cap} is applied.` : ''}`, '')
  lines.push('## Totals', '', `Direct ${input.currency} ${computation.totals.direct.toLocaleString()} · indirect ${input.currency} ${computation.totals.indirect.toLocaleString()} · total ${input.currency} ${computation.totals.total.toLocaleString()}${computation.totals.cost_share ? ` · cost share ${input.currency} ${computation.totals.cost_share.toLocaleString()}` : ''}.`, '')
  if (input.notes) lines.push('## Notes', '', input.notes, '')
  lines.push(`> ${computation.note}`, '')
  return lines.join('\n')
}

export function budgetStatus(cwd, slug) {
  const events = readJsonl(files(cwd, slug).ledger)
  const start = [...events].reverse().find((event) => event.event === 'start')
  const compute = [...events].reverse().find((event) => event.event === 'compute')
  return {
    slug: budgetSlug(slug), dir: files(cwd, slug).dir,
    input: start?.input || null, start_hash: start?.hash || null,
    computation: compute?.computation || null, computation_input_hash: compute?.input_hash || null,
    computation_stale: Boolean(start && compute && compute.input_hash !== start.hash),
    versions: events.filter((event) => event.event === 'start').length,
  }
}

export async function startBudget({ cwd, slug, input = {}, reason = null, recordedBy = null }) {
  const f = files(cwd, slug)
  ensureDir(f.dir)
  return withLock(f.dir, async () => {
    const events = readJsonl(f.ledger)
    const latest = [...events].reverse().find((event) => event.event === 'start')
    const merged = latest ? { ...latest.input, ...input } : input
    const normalized = normalizeBudgetInput(merged)
    const hash = `sha256:${sha256(stableStringify(normalized))}`
    if (latest?.hash === hash) return { slug: budgetSlug(slug), input: latest.input, hash, unchanged: true }
    if (latest && !text(reason)) throw new Error('changing a budget requires a reason; the earlier version stays')
    appendJsonl(f.ledger, [{ event: 'start', ts: nowIso(), input: normalized, hash, reason: text(reason) || null, recorded_by: text(recordedBy) || null }])
    return { slug: budgetSlug(slug), input: normalized, hash, created: true, updated: Boolean(latest) }
  }, { label: 'budget ledger' })
}

export async function computeBudgetStore({ cwd, slug }) {
  const state = budgetStatus(cwd, slug)
  if (!state.input) throw new Error(`budget "${budgetSlug(slug)}" has not been started`)
  const computation = computeBudget(state.input)
  const f = files(cwd, slug)
  await withLock(f.dir, async () => {
    appendJsonl(f.ledger, [{ event: 'compute', ts: nowIso(), computation, input_hash: state.start_hash, hash: `sha256:${sha256(stableStringify(computation))}` }])
  }, { label: 'budget ledger' })
  return computation
}

function csvRows(computation) {
  const header = ['year', 'calendar_year', 'personnel', 'equipment', 'supplies', 'travel', 'publication', 'other', 'subawards', 'direct_total', 'indirect_base', 'indirect', 'total', 'cost_share']
  return [header, ...computation.rows.map((row) => header.map((key) => row[key] ?? ''))]
}

function xlsxCell(value) {
  if (typeof value !== 'string') return value
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

export async function exportBudget({ cwd, slug, format = 'csv', out = null, overwrite = false }) {
  const state = budgetStatus(cwd, slug)
  if (!state.input) throw new Error(`budget "${budgetSlug(slug)}" has not been started`)
  if (!state.computation) throw new Error('no computation recorded; run action=compute first')
  if (state.computation_stale) throw new Error('the budget input changed after the last computation; run action=compute again')
  const kind = text(format).toLowerCase() || 'csv'
  if (!BUDGET_EXPORT_FORMATS.includes(kind)) throw new Error(`format must be one of ${BUDGET_EXPORT_FORMATS.join(', ')}`)
  const dir = files(cwd, slug).exports
  ensureDir(dir)
  const extensions = { csv: 'csv', markdown: 'md', json: 'json', xlsx: 'xlsx' }
  const target = out ? resolveWorkspacePath(cwd, out, { forWrite: true }) : join(dir, `budget.${extensions[kind]}`)
  if (kind === 'json') {
    const result = exportText(target, `${JSON.stringify({ input: state.input, computation: state.computation }, null, 2)}\n`, { overwrite })
    return { ...result, format: 'json' }
  }
  if (kind === 'markdown') {
    const body = [
      `# Grant budget: ${state.input.title}`,
      '',
      '## Multi-year table',
      '',
      '| Year | Personnel | Equipment | Supplies | Travel | Publication | Other | Subawards | Direct | Indirect | Total | Cost share |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|',
      ...state.computation.rows.map((row) => `| ${row.year}${row.calendar_year ? ` (${row.calendar_year})` : ''} | ${row.personnel} | ${row.equipment} | ${row.supplies} | ${row.travel} | ${row.publication} | ${row.other} | ${row.subawards} | ${row.direct_total} | ${row.indirect} | ${row.total} | ${row.cost_share} |`),
      '',
      `**Totals:** direct ${state.computation.totals.direct} · indirect ${state.computation.totals.indirect} · total ${state.computation.totals.total}${state.computation.totals.cost_share ? ` · cost share ${state.computation.totals.cost_share}` : ''}.`,
      '',
      budgetJustification(state.computation),
    ].join('\n')
    const result = exportText(target, body, { overwrite })
    return { ...result, format: 'markdown' }
  }
  if (kind === 'xlsx') {
    if (existsSync(target) && !overwrite) throw new Error(`${target} already exists; pass overwrite: true to replace it`)
    const rows = csvRows(state.computation).map((row) => row.map(xlsxCell))
    const summary = [['Category', 'Amount'], ...Object.entries(state.computation.totals).map(([key, value]) => [key, value])].map((row) => row.map(xlsxCell))
    const personnel = [['Year', 'Role', 'Name', 'Effort', 'Person-months', 'Base salary', 'Fringe rate', 'Amount'], ...state.computation.personnel.map((entry) => [entry.year, entry.role, entry.name || '', entry.effort, entry.person_months, entry.base_salary, entry.fringe_rate, entry.amount])].map((row) => row.map(xlsxCell))
    const items = [['Year', 'Category', 'Label', 'Amount', 'In indirect base'], ...state.computation.line_items.map((entry) => [entry.year, entry.category, entry.label, entry.amount, entry.include_in_indirect_base ? 'yes' : 'no'])].map((row) => row.map(xlsxCell))
    const helper = runHelper('grant_budget.py', {
      path: target,
      sheets: [
        { name: 'Multi-year', rows },
        { name: 'Summary', rows: summary },
        { name: 'Personnel', rows: personnel },
        { name: 'Line items', rows: items },
      ],
    }, { timeoutMs: 30_000 })
    if (helper?.error) return { format: 'xlsx', success: false, error: helper.error, note: 'Install openpyxl in the helper environment or export CSV/JSON instead.' }
    return { format: 'xlsx', success: true, path: target, bytes: null, note: 'Workbook written by python-helpers/grant_budget.py.' }
  }
  const body = `${csvRows(state.computation).map((row) => row.map((cell) => {
    const raw = String(cell ?? '')
    return /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
  }).map(csvCell).join(',')).join('\n')}\n`
  const result = exportText(target, body, { overwrite })
  return { ...result, format: 'csv' }
}
