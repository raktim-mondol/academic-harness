/**
 * dmp: draft a funder-shaped data management plan under
 * `.dsh/dmp/<slug>/` with a concept checklist. Templates are paraphrased, not
 * official requirements; no repository, embargo, or cost is invented.
 */
import { defineTool } from 'ah-dsh-tools'
import {
  DMP_ACTIONS, DMP_EXPORT_FORMATS, DMP_TEMPLATES,
  dmpStatus, exportDmp, recordDmpSection, startDmp,
} from './dmp-store.js'

function text(value) {
  return String(value ?? '').trim()
}

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function renderStart(value) {
  const lines = [
    `DMP "${value.slug}" ${value.unchanged ? 'is unchanged' : value.updated ? 'updated' : 'started'}.`,
    `Template: ${value.input.template} · hash: ${value.hash}`,
    'Templates are paraphrased concepts; check the funder’s current official requirements before submission.',
  ]
  return lines.join('\n')
}

function renderSection(value) {
  return `Recorded DMP section "${value.section.id}" (${value.section.title}) for "${value.slug}". Earlier versions stay in the append-only ledger.`
}

function renderCheck(value) {
  const checklist = value.checklist
  const lines = [`DMP concept checklist: ${checklist.counts.present} present · ${checklist.counts.missing} missing · ${checklist.counts.manual_check} manual.`]
  const attention = checklist.items.filter((item) => item.status !== 'present')
  if (attention.length) {
    lines.push('Items needing attention:')
    for (const item of attention.slice(0, 20)) lines.push(`- ${item.status}: ${item.label} — ${item.detail}`)
    if (attention.length > 20) lines.push(`- …${attention.length - 20} more`)
  }
  lines.push(checklist.note)
  return lines.join('\n')
}

function renderStatus(status) {
  if (!status.input) return `DMP "${status.slug}" has not been started.`
  const lines = [
    `DMP "${status.slug}": ${status.input.title}`,
    `Template: ${status.template?.label || status.input.template} · sections: ${Object.keys(status.sections).length}.`,
  ]
  if (status.checklist) lines.push(`Checklist: ${status.checklist.counts.missing} missing · ${status.checklist.counts.manual_check} manual · ${status.checklist.counts.present} present.`)
  if (status.links) lines.push(`Linked records: datasets ${status.links.datasets} · repro packages ${status.links.repro_packages} · pre-registrations ${status.links.preregistrations}.`)
  return lines.join('\n')
}

function renderValue(value) {
  if (value?.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  switch (value.action) {
    case 'start': return [{ type: 'text', text: renderStart(value) }]
    case 'section': return [{ type: 'text', text: renderSection(value) }]
    case 'check': return [{ type: 'text', text: renderCheck(value) }]
    case 'status': return [{ type: 'text', text: renderStatus(value.status) }]
    case 'export': return [{ type: 'text', text: `Wrote ${value.result.path} (${value.result.bytes} bytes, ${value.result.format}).` }]
    default: return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }
}

export async function runDmpAction(args, exec) {
  const action = args.action || 'status'
  if (!DMP_ACTIONS.includes(action)) throw new Error(`action must be one of ${DMP_ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  const slug = text(args.slug)
  if (!slug) throw new Error('slug is required')
  if (action === 'start') {
    const input = args.input && typeof args.input === 'object' ? { ...args.input } : {}
    for (const field of ['template', 'title', 'funder', 'grant_number', 'institution', 'principal_investigator', 'project_summary', 'data_types', 'repository', 'embargo', 'costs', 'roles', 'ethics_legal', 'notes']) {
      if (args[field] !== undefined) input[field] = args[field]
    }
    return { action, ...(await startDmp({ cwd, slug, input, reason: args.reason, recordedBy: args.recorded_by })) }
  }
  if (action === 'section') {
    return { action, ...(await recordDmpSection({ cwd, slug, id: args.id, title: args.section_title || args.title, body: args.body, recordedBy: args.recorded_by })) }
  }
  if (action === 'check') {
    const status = dmpStatus(cwd, slug)
    if (!status.input) throw new Error(`DMP "${slug}" has not been started`)
    return { action, checklist: status.checklist }
  }
  if (action === 'export') {
    return { action, result: exportDmp({ cwd, slug, format: args.format || 'markdown', out: args.out, overwrite: Boolean(args.overwrite) }) }
  }
  return { action, status: dmpStatus(cwd, slug) }
}

export const name = 'academic-harness-dmp'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'dmp',
    description: [
      'Draft a funder-shaped data management plan under `.dsh/dmp/<slug>/`: `start`, append-only `section`s, `check` (present/missing/manual_check), `status`, and `export` (Markdown/JSON).',
      `Templates: ${Object.keys(DMP_TEMPLATES).join(', ')}. Sections cover data types, standards, storage, access/sharing, reuse, preservation, costs, roles, and ethics/legal constraints. The checklist is a paraphrased concept aid, not the funder’s official form or a compliance verdict; institution/funder requirements and every repository/embargo choice stay manual_check. The tool never invents a repository, embargo, cost, or approval. Use the same slug as preregister/dataset_get/repro_package to see linked records. Load the \`data-management-plan\` skill.`,
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: DMP_ACTIONS, description: 'start, section, check, status, or export. Default status.' },
      slug: { type: 'string', description: 'DMP slug.' },
      input: { type: 'object', additionalProperties: true, description: 'start: full input object (flat fields also accepted).' },
      template: { type: 'string', enum: Object.keys(DMP_TEMPLATES), description: 'start: funder template (default generic).' },
      title: { type: 'string', description: 'Project title (start) or section title (section, if section_title is absent).' },
      funder: { type: 'string', description: 'Funder.' },
      grant_number: { type: 'string', description: 'Grant/award number.' },
      institution: { type: 'string', description: 'Institution.' },
      principal_investigator: { type: 'string', description: 'Principal investigator.' },
      project_summary: { type: 'string', description: 'Project summary.' },
      data_types: { type: 'array', items: { type: 'string' }, description: 'Data types and sources.' },
      repository: { type: 'string', description: 'Chosen repository, if the project has actually chosen one.' },
      embargo: { type: 'string', description: 'Embargo/access delay.' },
      costs: { type: 'string', description: 'Cost statement.' },
      roles: { type: 'string', description: 'Roles and responsibilities.' },
      ethics_legal: { type: 'string', description: 'Ethics/legal/contractual constraints.' },
      notes: { type: 'string', description: 'Notes.' },
      reason: { type: 'string', description: 'Why the DMP changed (required after the first start).' },
      id: { type: 'string', description: 'section: section id.' },
      section_title: { type: 'string', description: 'section: display title for a custom section.' },
      body: { type: 'string', description: 'section: section text.' },
      format: { type: 'string', enum: DMP_EXPORT_FORMATS, description: 'Export format (default markdown).' },
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
        return await runDmpAction(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `DMP: ${args.slug || ''} (${args.action || 'status'})`, kind: 'other' }
    },
  }))
}
