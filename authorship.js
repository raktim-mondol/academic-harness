/**
 * authorship: a CRediT/ICMJE contribution ledger (Phase 4F of
 * docs/SCIENTIFIC-EXPANSION-PLAN.md).
 *
 * It records who decided what. Author order, qualification, and the truth of
 * an affiliation or ORCID remain human decisions; the tool reports what is
 * missing or disputed and never resolves it.
 */
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { exportText } from './ledger-kit.js'
import {
  AUTHORSHIP_ACTIONS, AUTHORSHIP_EXPORT_FORMATS, CREDIT_ROLES, ICMJE_CRITERIA,
  addAuthor, authorshipSlug, authorshipSummary, exportAuthorship,
  recordCredit, recordIcmje, startAuthorship, statementMarkdown,
} from './authorship-store.js'

function text(value) {
  return String(value ?? '').trim()
}

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function slugFrom(args, { required = true } = {}) {
  const explicit = text(args.slug)
  if (explicit) return authorshipSlug(explicit)
  const manuscript = text(args.manuscript)
  if (manuscript) {
    const base = manuscript.split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
    return authorshipSlug(base)
  }
  if (required) throw new Error('slug is required (or give manuscript so one can be derived)')
  return null
}

function renderStart(value) {
  return `Authorship record "${value.slug}" ${value.created ? 'created' : 'already exists with the same metadata'}. Author order and qualification are human decisions; the tool records them only.`
}

function renderAdd(value) {
  return [
    `Added ${value.name} as ${value.author_id}.`,
    value.warning || `Position: ${value.position ?? 'not recorded'}.`,
  ].join('\n')
}

function renderSummary(summary) {
  const lines = [
    `Authorship "${summary.record.slug}": ${summary.authors.length} author(s), ${summary.corresponding.length} marked corresponding.`,
  ]
  if (summary.missing_order.length) lines.push(`Order not recorded for: ${summary.missing_order.join(', ')}.`)
  if (summary.missing_credit.length) lines.push(`No CRediT roles: ${summary.missing_credit.join(', ')}.`)
  if (summary.missing_icmje.length) lines.push(`No ICMJE criteria: ${summary.missing_icmje.join(', ')}.`)
  if (summary.incomplete_icmje.length) lines.push(`ICMJE with unknowns: ${summary.incomplete_icmje.join(', ')}.`)
  if (summary.conflicts.length) {
    lines.push('', `Recorded disagreements (${summary.conflicts.length}), not resolved:`)
    for (const conflict of summary.conflicts) lines.push(`- ${conflict.kind}: ${conflict.detail}`)
  }
  return lines.join('\n')
}

function renderValue(value) {
  if (value?.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  switch (value.action) {
    case 'start': return [{ type: 'text', text: renderStart(value) }]
    case 'add': return [{ type: 'text', text: renderAdd(value) }]
    case 'credit': return [{ type: 'text', text: `Recorded ${value.roles.join(', ')} for ${value.author} (${value.author_id}).` }]
    case 'icmje': {
      const missing = value.missing.length ? `\nNot recorded: ${value.missing.join(', ')}.` : ''
      return [{ type: 'text', text: `Recorded ICMJE criteria for ${value.author} (${value.author_id}).${missing}` }]
    }
    case 'statement': {
      const lines = [renderSummary(value.summary)]
      lines.push('', `Wrote ${value.path} (${value.bytes} bytes) and statement.json.`)
      if (value.summary.conflicts.length) lines.push('The statement lists the disagreements; it does not resolve them.')
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'export':
      return [{ type: 'text', text: `Wrote ${value.path} (${value.bytes} bytes, ${value.format}).\n\n${renderSummary(value.summary)}` }]
    default:
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }
}

export async function runAuthorshipAction(args, exec) {
  const action = args.action || 'statement'
  if (!AUTHORSHIP_ACTIONS.includes(action)) throw new Error(`action must be one of ${AUTHORSHIP_ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  const slug = slugFrom(args, { required: action !== 'start' ? true : false })

  if (action === 'start') {
    const targetSlug = slugFrom(args)
    return { action, ...(await startAuthorship({
      cwd, slug: targetSlug, manuscript: args.manuscript, title: args.title,
      recordedBy: args.recorded_by, note: args.note,
    })) }
  }

  if (action === 'add') {
    return { action, ...(await addAuthor({
      cwd, slug, name: args.name, affiliation: args.affiliation, orcid: args.orcid,
      corresponding: args.corresponding, email: args.email, position: args.position,
      note: args.note, recordedBy: args.recorded_by,
    })) }
  }

  if (action === 'credit') {
    return { action, ...(await recordCredit({
      cwd, slug, author: args.author, roles: args.roles, note: args.note, recordedBy: args.recorded_by,
    })) }
  }

  if (action === 'icmje') {
    return { action, ...(await recordIcmje({
      cwd, slug, author: args.author, criteria: args.criteria, notes: args.notes, recordedBy: args.recorded_by,
    })) }
  }

  if (action === 'statement') {
    const summary = authorshipSummary(cwd, slug)
    const body = statementMarkdown(summary, {
      funding: args.funding, competing_interests: args.competing_interests, ai_use: args.ai_use, note: args.note,
    })
    const dir = join(cwd, '.dsh', 'authorship', slug)
    const written = exportText(join(dir, 'statement.md'), body, { overwrite: Boolean(args.overwrite) })
    exportText(join(dir, 'statement.json'), `${JSON.stringify({
      record: summary.record,
      authors: summary.authors,
      corresponding: summary.corresponding,
      conflicts: summary.conflicts,
      missing_order: summary.missing_order,
      missing_credit: summary.missing_credit,
      missing_icmje: summary.missing_icmje,
      incomplete_icmje: summary.incomplete_icmje,
      funding: args.funding || null,
      competing_interests: args.competing_interests || null,
      ai_use: args.ai_use || null,
      note: args.note || null,
    }, null, 2)}\n`, { overwrite: Boolean(args.overwrite) })
    return { action, ...written, summary }
  }

  if (action === 'export') {
    return {
      action,
      ...exportAuthorship({
        cwd, slug, format: args.format || 'markdown',
        funding: args.funding, competing_interests: args.competing_interests,
        ai_use: args.ai_use, note: args.note, overwrite: Boolean(args.overwrite),
      }),
    }
  }

  throw new Error(`action must be one of ${AUTHORSHIP_ACTIONS.join(', ')}`)
}

export const name = 'academic-harness-authorship'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'authorship',
    description: [
      'A CRediT/ICMJE contribution ledger under `.dsh/authorship/<slug>/` for author statements and submission metadata.',
      `Actions: \`start\` (create a write-once record for a manuscript/project), \`add\` (name, affiliation, ORCID, corresponding flag, position, email; position is supplied by the user and never inferred), \`credit\` (assign one or more CRediT roles: ${CREDIT_ROLES.join(', ')}), \`icmje\` (record the four ICMJE criteria as true, false, or unknown with optional notes), \`statement\` (assemble a Markdown author-contributions statement plus a JSON sidecar; optional funding/competing-interests/AI-use text is included only as supplied), \`export\` (markdown, csv, or json under \`exports/\`).`,
      'The tool never decides author order, never decides who qualifies, and never invents an affiliation, ORCID, funding source, or conflict. Changed and disagreeing entries remain in the append-only log and are reported as unresolved; review the statement with the authors before submission. Load the `authorship-credit` skill.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: AUTHORSHIP_ACTIONS, description: 'start, add, credit, icmje, statement, or export. Default statement.' },
      slug: { type: 'string', description: 'Authorship record slug. Derived from the manuscript filename when omitted at start.' },
      manuscript: { type: 'string', description: 'Workspace-relative manuscript path (start).' },
      title: { type: 'string', description: 'Manuscript title (start; optional).' },
      recorded_by: { type: 'string', description: 'Who recorded this decision (for the audit trail); optional.' },
      name: { type: 'string', description: 'Author name (add). Required.' },
      author: { type: 'string', description: 'Author id or exact name (credit/icmje).' },
      affiliation: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Affiliation(s) exactly as supplied (add). Unknown is left blank.' },
      orcid: { type: 'string', description: 'ORCID in 0000-0000-0000-0000 form (add). Never inferred.' },
      corresponding: { type: 'boolean', description: 'Mark this author as corresponding (add).' },
      email: { type: 'string', description: 'Contact email exactly as supplied (add).' },
      position: { type: 'integer', description: 'Author position supplied by the user (add). Omit if the order is not decided; the tool will not assign one.' },
      roles: { type: 'array', items: { type: 'string' }, description: `CRediT roles (credit). Use: ${CREDIT_ROLES.join('; ')}.` },
      criteria: {
        type: 'object',
        additionalProperties: true,
        description: `ICMJE criteria object (icmje): ${ICMJE_CRITERIA.map(({ key }) => key).join(', ')}. Values true, false, or "unknown".`,
      },
      notes: { type: 'string', description: 'ICMJE notes (icmje).' },
      funding: { type: 'string', description: 'Funding statement exactly as supplied (statement/export).' },
      competing_interests: { type: 'string', description: 'Competing-interests statement exactly as supplied (statement/export).' },
      ai_use: { type: 'string', description: 'AI-use statement exactly as supplied (statement/export).' },
      note: { type: 'string', description: 'Note recorded with an event or shown in the statement.' },
      format: { type: 'string', enum: AUTHORSHIP_EXPORT_FORMATS, description: 'export: markdown (default), csv, or json.' },
      overwrite: { type: 'boolean', description: 'statement/export: replace an existing file. Default false.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return await runAuthorshipAction(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Authorship (${args.action || 'statement'})`, kind: 'other' }
    },
  }))
}
