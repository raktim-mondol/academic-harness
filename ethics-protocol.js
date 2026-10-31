/**
 * ethics_protocol: draft an ethics/IRB protocol and consent documents from
 * structured inputs, with a concept checklist. This is not legal advice and
 * never records an invented approval.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  ETHICS_ACTIONS, ETHICS_EXPORT_FORMATS, JURISDICTIONS, STUDY_TYPES,
  ethicsStatus, exportEthicsProtocol, generateConsent,
  recordEthicsSection, startEthicsProtocol,
} from './ethics-protocol-store.js'

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
    `Ethics protocol "${value.slug}" ${value.created ? (value.updated ? 'updated' : 'started') : 'unchanged'}.`,
    `Hash: ${value.hash}`,
    `Study type: ${value.protocol.study_type} · jurisdiction: ${value.protocol.jurisdiction}.`,
  ]
  if (value.reason) lines.push(`Reason: ${value.reason}`)
  lines.push('Approval references are recorded, never invented or verified. Add sections, generate a consent draft, then run check.')
  return lines.join('\n')
}

function renderSection(value) {
  return `Recorded section "${value.section.id}"${value.section.title ? ` (${value.section.title})` : ''} for "${value.slug}". Earlier versions stay in the append-only ledger.`
}

function renderConsent(value) {
  return [
    `Wrote ${value.path} (${value.bytes} bytes).`,
    `Sha256: ${value.hash}`,
    `Placeholders remaining: ${value.placeholders}.`,
    'The draft is not approval; complete every placeholder, translate if needed, and review with the responsible committee.',
  ].join('\n')
}

function renderCheck(value) {
  const checklist = value.checklist
  const lines = [
    `Ethics concept checklist: ${checklist.counts.present} present · ${checklist.counts.missing} missing · ${checklist.counts.manual_check} manual · ${checklist.counts.not_applicable} not applicable.`,
  ]
  const attention = checklist.items.filter((entry) => entry.status === 'missing' || entry.status === 'manual_check')
  if (attention.length) {
    lines.push('Items needing attention:')
    for (const entry of attention.slice(0, 20)) lines.push(`- ${entry.status}: ${entry.label} — ${entry.detail}`)
    if (attention.length > 20) lines.push(`- …${attention.length - 20} more`)
  }
  lines.push(checklist.note)
  return lines.join('\n')
}

function renderStatus(status) {
  if (!status.started) return `Ethics protocol "${status.slug}" has not been started.`
  const lines = [
    `Ethics protocol "${status.slug}": ${status.protocol.title}`,
    `Study type: ${status.protocol.study_type} · jurisdiction: ${status.protocol.jurisdiction}.`,
    `Sections: ${Object.keys(status.sections).length} · consent drafts: ${status.consents.length}.`,
  ]
  if (status.checklist) lines.push(`Checklist: ${status.checklist.counts.missing} missing · ${status.checklist.counts.manual_check} manual · ${status.checklist.counts.present} present.`)
  if (status.preregister) lines.push(`Linked pre-registration: v${status.preregister.version} (${status.preregister.plan_hash}).`)
  lines.push('The checklist is a review aid, not a compliance verdict.')
  return lines.join('\n')
}

function renderValue(value) {
  if (value?.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  switch (value.action) {
    case 'start': return [{ type: 'text', text: renderStart(value) }]
    case 'section': return [{ type: 'text', text: renderSection(value) }]
    case 'consent': return [{ type: 'text', text: renderConsent(value) }]
    case 'check': return [{ type: 'text', text: renderCheck(value) }]
    case 'status': return [{ type: 'text', text: renderStatus(value.status) }]
    case 'export': return [{ type: 'text', text: `Wrote ${value.result.path} (${value.result.bytes} bytes, ${value.result.format}).` }]
    default: return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }
}

function protocolFromArgs(args) {
  if (args.protocol && typeof args.protocol === 'object' && !Array.isArray(args.protocol)) return { ...args.protocol }
  const protocol = {}
  for (const field of [
    'title', 'study_type', 'institution', 'principal_investigator', 'population', 'vulnerable_populations',
    'risk_level', 'risks', 'benefits', 'consent_process', 'data_handling', 'data_types', 'jurisdiction',
    'retention', 'sharing', 'compensation', 'incidental_findings', 'conflicts', 'funding', 'approval', 'notes',
  ]) {
    if (args[field] !== undefined) protocol[field] = args[field]
  }
  return protocol
}

export async function runEthicsAction(args, exec) {
  const action = args.action || 'status'
  if (!ETHICS_ACTIONS.includes(action)) throw new Error(`action must be one of ${ETHICS_ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  const slug = text(args.slug)
  if (!slug) throw new Error('slug is required')
  if (action === 'start') {
    return {
      action,
      ...(await startEthicsProtocol({
        cwd, slug, protocol: protocolFromArgs(args), reason: args.reason, recordedBy: args.recorded_by,
      })),
    }
  }
  if (action === 'section') {
    return {
      action,
      ...(await recordEthicsSection({
        cwd, slug, id: args.id, title: args.title, body: args.body, recordedBy: args.recorded_by,
      })),
    }
  }
  if (action === 'consent') {
    return {
      action,
      ...(await generateConsent({
        cwd, slug, inputs: args.consent && typeof args.consent === 'object' ? args.consent : {},
        overwrite: Boolean(args.overwrite), recordedBy: args.recorded_by,
      })),
    }
  }
  if (action === 'check') {
    const state = ethicsStatus(cwd, slug)
    if (!state.started) throw new Error(`ethics protocol "${slug}" has not been started`)
    return { action, checklist: state.checklist }
  }
  if (action === 'export') {
    return {
      action,
      result: exportEthicsProtocol({
        cwd, slug, format: args.format || 'markdown', out: args.out, overwrite: Boolean(args.overwrite),
      }),
    }
  }
  return { action, status: ethicsStatus(cwd, slug) }
}

export const name = 'academic-harness-ethics-protocol'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'ethics_protocol',
    description: [
      'Draft an ethics/IRB protocol and consent documents from structured inputs under `.dsh/ethics/<slug>/`, with a concept checklist against Helsinki/Common Rule/GDPR/HIPAA themes.',
      `Actions: \`start\` (title, study_type ${STUDY_TYPES.join('/')}, institution, population, risks, benefits, consent process, data handling/types, jurisdiction ${JURISDICTIONS.join('/')}, retention, sharing, compensation, incidental findings, approval reference; changing it requires a reason), \`section\` (append-only text sections), \`consent\` (Markdown draft with explicit placeholders), \`check\` (status per concept: present/missing/manual_check/not_applicable), \`status\`, and \`export\` (${ETHICS_EXPORT_FORMATS.join('/')}).`,
      'This is template-and-checklist support, not legal advice and not a compliance guarantee. An approval reference is recorded, never verified or invented; institution-specific requirements always stay manual_check. Link to `preregister` by using the same slug. Load the `research-ethics` skill for the review workflow.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ETHICS_ACTIONS, description: 'start, section, consent, check, status, or export. Default status.' },
      slug: { type: 'string', description: 'Ethics protocol slug (use the pre-registration slug to link them).' },
      protocol: { type: 'object', additionalProperties: true, description: 'start: full protocol object (flat fields also accepted).' },
      title: { type: 'string', description: 'Study title.' },
      study_type: { type: 'string', enum: STUDY_TYPES, description: 'Default not_recorded.' },
      institution: { type: 'string', description: 'Institution.' },
      principal_investigator: { type: 'string', description: 'Principal investigator.' },
      population: { type: 'string', description: 'Study population.' },
      vulnerable_populations: { type: 'array', items: { type: 'string' }, description: 'Vulnerable groups involved.' },
      risk_level: { type: 'string', description: 'Recorded risk level.' },
      risks: { type: 'string', description: 'Risks and discomforts.' },
      benefits: { type: 'string', description: 'Potential benefits.' },
      consent_process: { type: 'string', description: 'Consent process description.' },
      data_handling: { type: 'string', description: 'Confidentiality and data-handling description.' },
      data_types: { type: 'array', items: { type: 'string' }, description: 'Data types (identifiable, de-identified, genomic, ...).' },
      jurisdiction: { type: 'string', enum: JURISDICTIONS, description: 'Privacy jurisdiction.' },
      retention: { type: 'string', description: 'Retention/destruction statement.' },
      sharing: { type: 'string', description: 'Data-sharing/access statement.' },
      compensation: { type: 'string', description: 'Compensation description.' },
      incidental_findings: { type: 'string', description: 'Incidental-findings plan.' },
      conflicts: { type: 'string', description: 'Conflicts of interest.' },
      funding: { type: 'string', description: 'Funding disclosure.' },
      approval: { type: 'object', additionalProperties: true, description: 'Recorded approval {reference, committee, date}; never verified by the tool.' },
      notes: { type: 'string', description: 'Notes.' },
      reason: { type: 'string', description: 'Why the protocol changed (required after the first start).' },
      id: { type: 'string', description: 'section: section id.' },
      body: { type: 'string', description: 'section: section text.' },
      consent: { type: 'object', additionalProperties: true, description: 'consent: fields for the draft (purpose, procedures, alternatives, contacts, ...).' },
      format: { type: 'string', enum: ETHICS_EXPORT_FORMATS, description: 'export format (default markdown).' },
      out: { type: 'string', description: 'export: workspace-relative output path.' },
      overwrite: { type: 'boolean', description: 'consent/export: replace an existing file.' },
      recorded_by: { type: 'string', description: 'Who recorded the event.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return await runEthicsAction(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Ethics protocol: ${args.slug || ''} (${args.action || 'status'})`, kind: 'other' }
    },
  }))
}
