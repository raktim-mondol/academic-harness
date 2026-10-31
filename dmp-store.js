/**
 * Data-management-plan ledger under `<cwd>/.dsh/dmp/<slug>/`.
 *
 * Templates are paraphrased concept checklists for NIH DMS, NSF DMP, Horizon
 * Europe, Wellcome, ERC, and a generic plan. They are not the funders' official
 * requirements; unknown or institutional requirements stay manual_check, and
 * the tool never invents a repository, embargo, or cost.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  appendJsonl, ensureDir, exportText, mdCell, nowIso, readJsonl,
  sha256, slug as slugify, stableStringify,
} from './ledger-kit.js'
import { withLock } from './store-lock.js'
import { resolveWorkspacePath } from './workspace-path.js'

export const DMP_ACTIONS = ['start', 'section', 'check', 'status', 'export']
export const DMP_EXPORT_FORMATS = ['markdown', 'json']
export const DMP_TEMPLATES = {
  generic: {
    label: 'Generic data management plan',
    requirements: ['data_types', 'standards', 'storage', 'access', 'sharing', 'preservation', 'costs', 'roles', 'ethics_legal'],
  },
  nih_dms: {
    label: 'NIH Data Management and Sharing Plan',
    requirements: ['data_types', 'standards', 'storage', 'access', 'sharing', 'preservation', 'roles', 'costs'],
    note: 'Paraphrased NIH DMS concepts; check the current NIH policy and the specific NOFO.',
  },
  nsf_dmp: {
    label: 'NSF Data Management Plan',
    requirements: ['data_types', 'standards', 'access', 'sharing', 'reuse', 'preservation', 'roles'],
    note: 'Paraphrased NSF DMP concepts; check the current NSF PAPPG and directorate guidance.',
  },
  horizon_europe: {
    label: 'Horizon Europe Data Management Plan',
    requirements: ['data_types', 'standards', 'access', 'sharing', 'preservation', 'costs', 'roles', 'ethics_legal'],
    note: 'Paraphrased Horizon Europe DMP concepts; check the current Work Programme and FAIR requirements.',
  },
  wellcome: {
    label: 'Wellcome Data Management Plan',
    requirements: ['data_types', 'standards', 'storage', 'access', 'sharing', 'preservation', 'costs', 'roles', 'ethics_legal'],
    note: 'Paraphrased Wellcome policy concepts; check the current grant conditions.',
  },
  erc: {
    label: 'ERC Data Management Plan',
    requirements: ['data_types', 'standards', 'access', 'sharing', 'preservation', 'costs', 'roles', 'ethics_legal'],
    note: 'Paraphrased ERC DMP concepts; check the current ERC guidance.',
  },
}

const SECTION_LABELS = {
  data_types: 'Data types and sources',
  standards: 'Formats, metadata, and standards',
  storage: 'Storage, backup, and security',
  access: 'Access and authentication',
  sharing: 'Sharing and reuse',
  reuse: 'Reuse and redistribution',
  preservation: 'Preservation and archiving',
  costs: 'Costs and resources',
  roles: 'Roles and responsibilities',
  ethics_legal: 'Ethics, legal, and contractual constraints',
}

function text(value) {
  return String(value ?? '').trim()
}

export function dmpSlug(value) {
  const slug = slugify(value, 80)
  if (!slug) throw new Error('slug must contain at least one letter or digit')
  return slug
}

export function dmpDir(cwd, value) {
  return join(cwd, '.dsh', 'dmp', dmpSlug(value))
}

function files(cwd, value) {
  const dir = dmpDir(cwd, value)
  return { dir, plan: join(dir, 'plan.jsonl'), exports: join(dir, 'exports') }
}

export function normalizeDmpInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('dmp input must be an object')
  const template = text(input.template).toLowerCase() || 'generic'
  if (!DMP_TEMPLATES[template]) throw new Error(`template must be one of ${Object.keys(DMP_TEMPLATES).join(', ')}`)
  const out = {
    template,
    title: text(input.title) || null,
    funder: text(input.funder) || null,
    grant_number: text(input.grant_number) || null,
    institution: text(input.institution) || null,
    principal_investigator: text(input.principal_investigator || input.pi) || null,
    project_summary: text(input.project_summary || input.summary) || null,
    data_types: Array.isArray(input.data_types) ? input.data_types.map(text).filter(Boolean) : text(input.data_types) ? [text(input.data_types)] : [],
    repository: text(input.repository) || null,
    embargo: text(input.embargo) || null,
    costs: text(input.costs || input.cost_statement) || null,
    roles: text(input.roles || input.responsibilities) || null,
    ethics_legal: text(input.ethics_legal || input.ethics) || null,
    notes: text(input.notes) || null,
  }
  for (const [key, value] of Object.entries(input)) {
    if (key in out || value === undefined) continue
    out[key] = value
  }
  return out
}

function readEvents(cwd, slug) {
  return readJsonl(files(cwd, slug).plan)
}

export function readDmp(cwd, slug) {
  const events = readEvents(cwd, slug)
  const start = [...events].reverse().find((event) => event.event === 'start')
  const sections = {}
  for (const event of events) {
    if (event.event === 'section') sections[event.id] = { id: event.id, title: event.title || null, text: event.text, ts: event.ts }
  }
  return { input: start?.input || null, sections, events, started_at: start?.ts || null }
}

export async function startDmp({ cwd, slug, input = {}, reason = null, recordedBy = null }) {
  const f = files(cwd, slug)
  ensureDir(f.dir)
  return withLock(f.dir, async () => {
    const events = readEvents(cwd, slug)
    const latest = [...events].reverse().find((event) => event.event === 'start')
    const merged = latest ? { ...latest.input, ...input } : input
    const normalized = normalizeDmpInput(merged)
    if (!normalized.title) throw new Error('title is required')
    const hash = `sha256:${sha256(stableStringify(normalized))}`
    if (latest?.hash === hash) return { slug: dmpSlug(slug), input: latest.input, hash, unchanged: true }
    if (latest && !text(reason)) throw new Error('changing a DMP requires a reason; the earlier version stays')
    appendJsonl(f.plan, [{ event: 'start', ts: nowIso(), input: normalized, hash, reason: text(reason) || null, recorded_by: text(recordedBy) || null }])
    return { slug: dmpSlug(slug), input: normalized, hash, created: true, updated: Boolean(latest) }
  }, { label: 'DMP ledger' })
}

export async function recordDmpSection({ cwd, slug, id, title = null, body, recordedBy = null }) {
  const f = files(cwd, slug)
  ensureDir(f.dir)
  return withLock(f.dir, async () => {
    const state = readDmp(cwd, slug)
    if (!state.input) throw new Error(`DMP "${dmpSlug(slug)}" has not been started`)
    const sectionId = text(id)
    if (!SECTION_LABELS[sectionId] && !text(title)) throw new Error(`unknown section id "${sectionId}"; give a title or use ${Object.keys(SECTION_LABELS).join(', ')}`)
    const value = text(body)
    if (!value) throw new Error('body is required')
    appendJsonl(f.plan, [{ event: 'section', ts: nowIso(), id: sectionId, title: text(title) || SECTION_LABELS[sectionId], text: value, recorded_by: text(recordedBy) || null }])
    return { slug: dmpSlug(slug), section: { id: sectionId, title: text(title) || SECTION_LABELS[sectionId], text: value } }
  }, { label: 'DMP ledger' })
}

function linkedLedgers(cwd) {
  const count = (dir) => {
    const abs = join(cwd, dir)
    if (!existsSync(abs)) return 0
    try {
      return readdirSync(abs, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
    } catch {
      return 0
    }
  }
  return {
    datasets: count(join('.dsh', 'data')),
    repro_packages: count(join('.dsh', 'repro')),
    preregistrations: count(join('.dsh', 'preregister')),
  }
}

export function dmpChecklist(input, sections, links) {
  const template = DMP_TEMPLATES[input.template]
  const items = []
  const present = (id) => Boolean(sections[id]) || (id === 'data_types' && input.data_types.length) || (id === 'costs' && input.costs) || (id === 'roles' && input.roles) || (id === 'ethics_legal' && input.ethics_legal)
  for (const id of template.requirements) {
    const exists = present(id)
    const manual = ['ethics_legal', 'costs'].includes(id) && exists
    items.push({
      id,
      label: SECTION_LABELS[id] || id,
      status: exists ? (manual ? 'manual_check' : 'present') : 'missing',
      detail: exists
        ? (manual ? 'Content is recorded; the funder/institution must confirm this section and its cost treatment.' : 'Recorded in the plan.')
        : `No ${SECTION_LABELS[id] || id} section or input field is recorded.`,
    })
  }
  if (input.repository) items.push({ id: 'repository', label: 'Repository choice', status: 'manual_check', detail: `Repository "${input.repository}" is recorded; availability, certification, identifiers, and terms were not verified.` })
  else items.push({ id: 'repository', label: 'Repository choice', status: 'manual_check', detail: 'No repository is recorded; do not name one unless the project has chosen and checked it.' })
  if (input.embargo) items.push({ id: 'embargo', label: 'Embargo or access delay', status: 'manual_check', detail: `Embargo "${input.embargo}" is recorded; confirm it matches funder and legal requirements.` })
  items.push({ id: 'institutional_requirements', label: 'Institutional and funder requirements', status: 'manual_check', detail: 'Official templates, page limits, signatures, and current agency guidance are not bundled; check the funder’s site.' })
  if (template.note) items.push({ id: 'template_version', label: 'Template version', status: 'manual_check', detail: template.note })
  if (links.datasets || links.repro_packages || links.preregistrations) {
    items.push({
      id: 'linked_records', label: 'Linked workspace records', status: 'present',
      detail: `Found ${links.datasets} dataset ledger(s), ${links.repro_packages} reproducibility package ledger(s), and ${links.preregistrations} pre-registration ledger(s). Linking them does not verify their contents.`,
    })
  }
  const counts = { present: 0, missing: 0, manual_check: 0, not_applicable: 0 }
  for (const item of items) counts[item.status] += 1
  return { items, counts, ready_for_review: counts.missing === 0, note: 'Concept checklist only, not a compliance guarantee. Funder and institutional requirements stay manual_check.' }
}

export function dmpStatus(cwd, slug) {
  const state = readDmp(cwd, slug)
  const links = linkedLedgers(cwd)
  return {
    slug: dmpSlug(slug), dir: files(cwd, slug).dir,
    input: state.input, sections: state.sections, links,
    checklist: state.input ? dmpChecklist(state.input, state.sections, links) : null,
    template: state.input ? { id: state.input.template, ...DMP_TEMPLATES[state.input.template] } : null,
  }
}

function renderMarkdown(state) {
  const input = state.input
  const template = DMP_TEMPLATES[input.template]
  const lines = [
    `# Data management plan: ${input.title}`,
    '',
    `**Template:** ${template.label} · **Funder:** ${input.funder || 'not recorded'} · **Grant:** ${input.grant_number || 'not recorded'}`,
    `**Institution:** ${input.institution || 'not recorded'} · **PI:** ${input.principal_investigator || 'not recorded'}`,
    '',
    '## Project summary',
    '',
    input.project_summary || 'not recorded',
    '',
    '## Data types and sources',
    '',
    input.data_types.length ? input.data_types.map((entry) => `- ${entry}`).join('\n') : 'not recorded',
    '',
  ]
  for (const id of template.requirements) {
    if (id === 'data_types') continue
    const section = state.sections[id]
    const fallback = id === 'costs' ? input.costs : id === 'roles' ? input.roles : id === 'ethics_legal' ? input.ethics_legal : null
    lines.push(`## ${SECTION_LABELS[id] || id}`, '', section?.text || fallback || 'not recorded', '')
  }
  for (const section of Object.values(state.sections)) {
    if (template.requirements.includes(section.id)) continue
    lines.push(`## ${section.title || section.id}`, '', section.text, '')
  }
  lines.push('## Repository, embargo, and costs', '')
  lines.push(`**Repository:** ${input.repository || 'not recorded'}  `)
  lines.push(`**Embargo/access delay:** ${input.embargo || 'not recorded'}  `)
  lines.push(`**Costs:** ${input.costs || 'not recorded'}`, '')
  const checklist = dmpChecklist(input, state.sections, state.links || { datasets: 0, repro_packages: 0, preregistrations: 0 })
  lines.push('## Concept checklist', '', '| Item | Status | Detail |', '|---|---|---|')
  for (const item of checklist.items) lines.push(`| ${mdCell(item.label)} | ${item.status} | ${mdCell(item.detail)} |`)
  lines.push('', checklist.note, '')
  return lines.join('\n')
}

export function exportDmp({ cwd, slug, format = 'markdown', out = null, overwrite = false }) {
  const state = dmpStatus(cwd, slug)
  if (!state.input) throw new Error(`DMP "${dmpSlug(slug)}" has not been started`)
  const kind = text(format).toLowerCase() || 'markdown'
  if (!DMP_EXPORT_FORMATS.includes(kind)) throw new Error(`format must be one of ${DMP_EXPORT_FORMATS.join(', ')}`)
  const dir = files(cwd, slug).exports
  ensureDir(dir)
  const target = out ? resolveWorkspacePath(cwd, out, { forWrite: true }) : join(dir, `dmp.${kind === 'json' ? 'json' : 'md'}`)
  if (kind === 'json') {
    const result = exportText(target, `${JSON.stringify({ ...state, note_text: 'Concept checklist only, not a compliance guarantee.' }, null, 2)}\n`, { overwrite })
    return { ...result, format: 'json' }
  }
  const result = exportText(target, renderMarkdown(state), { overwrite })
  return { ...result, format: 'markdown' }
}
