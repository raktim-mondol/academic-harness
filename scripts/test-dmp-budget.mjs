import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { apply as applyDmp, runDmpAction } from '../dmp.js'
import { apply as applyBudget, runBudgetAction } from '../grant-budget.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const workspace = makeWorkspace('ah-dmp-budget-')
const cwd = workspace.cwd
const exec = fakeExec(cwd)
let dmpTool
let budgetTool
applyDmp({ tools: { register: (registered) => { dmpTool = registered } } })
applyBudget({ tools: { register: (registered) => { budgetTool = registered } } })
const dmp = (args) => dmpTool.execute(args, exec)
const budget = (args) => budgetTool.execute(args, exec)

try {
  /* ------------------------------------------------------------------ DMP */

  let result = await dmp({
    action: 'start', slug: 'nsf-plan', template: 'nsf_dmp', title: 'Widget data plan',
    data_types: ['tabular assay data', 'microscopy images'], repository: 'Zenodo',
    funder: 'NSF', grant_number: '1234567', institution: 'Example University',
  })
  assert.equal(result.created, true)
  assert.match(result.hash, /^sha256:/)
  result = await dmp({ action: 'start', slug: 'nsf-plan', notes: 'Updated' })
  assert.match(result.error, /reason/)
  result = await dmp({ action: 'start', slug: 'nsf-plan', notes: 'Updated', reason: 'add note' })
  assert.equal(result.updated, true)

  result = await dmp({ action: 'check', slug: 'nsf-plan' })
  assert.ok(result.checklist.counts.missing > 0)
  assert.ok(result.checklist.items.some((item) => item.id === 'repository' && item.status === 'manual_check'))
  assert.ok(result.checklist.items.some((item) => item.id === 'data_types' && item.status === 'present'))

  for (const [id, body] of [
    ['standards', 'CSV and OME-TIFF with schema metadata.'],
    ['access', 'Public datasets are open; controlled data use a managed-access repository.'],
    ['sharing', 'Share after publication under CC-BY-4.0.'],
    ['reuse', 'Document variables and code in the repository README.'],
    ['preservation', 'Zenodo preserves the record for at least 10 years.'],
    ['roles', 'PI owns the plan; data manager handles deposits.'],
  ]) {
    result = await dmp({ action: 'section', slug: 'nsf-plan', id, body })
    assert.equal(result.section.id, id)
  }
  result = await dmp({ action: 'section', slug: 'nsf-plan', id: 'custom', body: 'Custom text' })
  assert.match(result.error, /unknown section|title/)
  result = await dmp({ action: 'section', slug: 'nsf-plan', id: 'custom', section_title: 'Custom section', body: 'Custom text' })
  assert.equal(result.section.title, 'Custom section')

  // Linked workspace records are counted, not verified.
  workspace.write('.dsh/data/one/.keep', '')
  workspace.write('.dsh/repro/two/.keep', '')
  workspace.write('.dsh/preregister/three/.keep', '')
  result = await dmp({ action: 'check', slug: 'nsf-plan' })
  assert.equal(result.checklist.counts.missing, 0)
  assert.ok(result.checklist.items.some((item) => item.id === 'linked_records' && item.status === 'present'))
  assert.ok(result.checklist.items.some((item) => item.id === 'institutional_requirements' && item.status === 'manual_check'))

  result = await dmp({ action: 'export', slug: 'nsf-plan', format: 'markdown', overwrite: true })
  const dmpMarkdown = workspace.read('.dsh/dmp/nsf-plan/exports/dmp.md')
  assert.match(dmpMarkdown, /Widget data plan/)
  assert.match(dmpMarkdown, /Zenodo/)
  assert.match(dmpMarkdown, /Concept checklist/)
  result = await dmp({ action: 'export', slug: 'nsf-plan', format: 'json', overwrite: true })
  const dmpJson = JSON.parse(workspace.read('.dsh/dmp/nsf-plan/exports/dmp.json'))
  assert.equal(dmpJson.input.template, 'nsf_dmp')
  assert.ok(dmpJson.checklist.items.length)

  result = await dmp({ action: 'status', slug: 'nsf-plan' })
  assert.equal(result.status.links.datasets, 1)
  assert.equal(result.status.checklist.counts.missing, 0)

  // Other templates load and require their own concepts.
  result = await dmp({ action: 'start', slug: 'nih-plan', template: 'nih_dms', title: 'NIH plan', data_types: ['clinical'] })
  result = await dmp({ action: 'check', slug: 'nih-plan' })
  assert.ok(result.checklist.items.some((item) => item.id === 'template_version' && item.status === 'manual_check'))

  /* -------------------------------------------------------------- budget */

  const input = {
    title: 'Widget grant', funder: 'NIH', institution: 'Example University', currency: 'USD',
    start_year: 2026, years: 2,
    personnel: [
      { role: 'PI', name: 'Ada Lovelace', base_salary: 120000, effort: 0.25, fringe_rate: 0.3, escalation: 0.03 },
      { role: 'RA', base_salary: 60000, person_months: 6, fringe_rate: 0.25 },
    ],
    equipment: [{ label: 'Scanner', amount: 50000, year: 1 }],
    supplies: [{ label: 'Reagents', amount: 10000, escalation: 0.02 }],
    travel: [{ label: 'Conference', amount: 3000, year: 2 }],
    publication: [{ label: 'Open access', amount: 2000, year: 2 }],
    subawards: [{ label: 'Subward', years: [20000, 20000] }],
    cost_share: [{ label: 'In-kind', amount: 5000 }],
    indirect_rate: 0.55,
  }
  result = await budget({ action: 'start', slug: 'widget', input })
  assert.equal(result.created, true)
  result = await budget({ action: 'compute', slug: 'widget' })
  const computation = result.computation
  assert.equal(computation.rows.length, 2)
  assert.equal(computation.rows[0].personnel, 76500)
  assert.equal(computation.rows[0].direct_total, 156500)
  assert.equal(computation.rows[0].indirect, 47575)
  assert.equal(computation.rows[0].total, 204075)
  assert.equal(computation.rows[1].personnel, 77670)
  assert.equal(computation.rows[1].indirect, 51078.5)
  assert.equal(computation.rows[1].total, 163948.5)
  assert.equal(computation.totals.direct, 269370)
  assert.equal(computation.totals.indirect, 98653.5)
  assert.equal(computation.totals.total, 368023.5)
  assert.equal(computation.totals.cost_share, 10000)
  assert.deepEqual(computation.failed_checks, [])
  assert.equal(computation.personnel.length, 4)
  assert.ok(computation.line_items.some((item) => item.category === 'equipment' && item.amount === 50000))

  result = await budget({ action: 'export', slug: 'widget', format: 'csv', overwrite: true })
  const csv = workspace.read('.dsh/budget/widget/exports/budget.csv')
  assert.match(csv, /year,calendar_year,personnel/)
  assert.match(csv, /2026/)
  result = await budget({ action: 'export', slug: 'widget', format: 'markdown', overwrite: true })
  const markdown = workspace.read('.dsh/budget/widget/exports/budget.md')
  assert.match(markdown, /Budget justification/)
  assert.match(markdown, /368023\.5/)
  result = await budget({ action: 'export', slug: 'widget', format: 'json', overwrite: true })
  const json = JSON.parse(workspace.read('.dsh/budget/widget/exports/budget.json'))
  assert.equal(json.computation.totals.total, 368023.5)
  result = await budget({ action: 'export', slug: 'widget', format: 'xlsx', overwrite: true })
  if (result.result.success === false) assert.match(result.result.note, /openpyxl|CSV|JSON/)
  else assert.ok(existsSync(workspace.path('.dsh/budget/widget/exports/budget.xlsx')))
  workspace.write('.dsh/budget/widget/exports/budget.xlsx', 'occupied')
  result = await budget({ action: 'export', slug: 'widget', format: 'xlsx' })
  assert.match(result.error, /already exists/)

  // Staleness: a new input refuses an old computation until recompute.
  result = await budget({ action: 'start', slug: 'widget', notes: 'Add note' })
  assert.match(result.error, /reason/)
  result = await budget({ action: 'start', slug: 'widget', notes: 'Add note', reason: 'clarify' })
  assert.equal(result.updated, true)
  result = await budget({ action: 'export', slug: 'widget', format: 'csv' })
  assert.match(result.error, /changed|compute again/)
  result = await budget({ action: 'compute', slug: 'widget' })
  assert.equal(result.computation.totals.total, 368023.5)
  result = await budget({ action: 'status', slug: 'widget' })
  assert.equal(result.status.computation_stale, false)
  assert.equal(result.status.versions, 2)

  // Per-line exclusion from the indirect base.
  result = await budget({
    action: 'start', slug: 'indirect', input: {
      title: 'Indirect base', currency: 'USD', years: 1,
      personnel: [{ role: 'PI', base_salary: 100000, effort: 0.5, fringe_rate: 0.2 }],
      supplies: [{ label: 'Excluded supplies', amount: 1000, include_in_indirect_base: false }],
      indirect_rate: 0.5,
    },
  })
  result = await budget({ action: 'compute', slug: 'indirect' })
  assert.equal(result.computation.rows[0].direct_total, 61000)
  assert.equal(result.computation.rows[0].indirect_base, 60000)
  assert.equal(result.computation.rows[0].indirect, 30000)
  assert.equal(result.computation.rows[0].total, 91000)

  // Caps fail loudly and do not hide the arithmetic.
  result = await budget({
    action: 'start', slug: 'caps', input: {
      title: 'Capped', currency: 'EUR', years: 1,
      personnel: [{ role: 'PI', base_salary: 100000, effort: 1, fringe_rate: 0.2 }],
      indirect_rate: 0.6, caps: { indirect_rate_max: 0.5, total_max: 100000 },
    },
  })
  result = await budget({ action: 'compute', slug: 'caps' })
  assert.ok(result.computation.failed_checks.includes('indirect_rate_cap'))
  assert.ok(result.computation.failed_checks.includes('total_cap'))

  // Required rates and valid effort are enforced.
  result = await budget({
    action: 'start', slug: 'bad-rate', input: {
      title: 'Bad', years: 1, personnel: [{ role: 'PI', base_salary: 100000, effort: 0.5 }], indirect_rate: 0.5,
    },
  })
  assert.match(result.error, /fringe_rate/)
  result = await budget({
    action: 'start', slug: 'bad-effort', input: {
      title: 'Bad', years: 1, personnel: [{ role: 'PI', base_salary: 100000, effort: 1.5, fringe_rate: 0.2 }], indirect_rate: 0.5,
    },
  })
  assert.match(result.error, /effort/)
  result = await budget({ action: 'compute', slug: 'not-started' })
  assert.match(result.error, /not been started/)
  await budget({
    action: 'start', slug: 'uncomputed', input: {
      title: 'Uncomputed', years: 1, personnel: [{ role: 'PI', base_salary: 100000, effort: 0.5, fringe_rate: 0.2 }], indirect_rate: 0.5,
    },
  })
  result = await budget({ action: 'export', slug: 'uncomputed', format: 'csv' })
  assert.match(result.error, /compute/)

  // A currency omitted is labelled, not silently guessed.
  result = await budget({ action: 'start', slug: 'currency', input: {
    title: 'No currency', years: 1, personnel: [{ role: 'PI', base_salary: 100000, effort: 0.5, fringe_rate: 0.2 }], indirect_rate: 0.5,
  } })
  result = await budget({ action: 'compute', slug: 'currency' })
  assert.equal(result.computation.input.currency, 'USD')
  assert.ok(result.computation.checks.some((check) => check.id === 'currency' && check.status === 'manual_check'))

  console.log('dmp and grant_budget OK')
} finally {
  workspace.cleanup()
}
