/**
 * submission_pack: plan, build, inspect, and export a journal-ready bundle
 * (Phase 4A of docs/SCIENTIFIC-EXPANSION-PLAN.md).
 *
 * The tool never submits, emails, logs into a portal, or fabricates a claim.
 * Unknown requirements stay manual_check and drafts stay drafts.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  SUBMISSION_ACTIONS, analyzeSubmission, buildSubmissionPack, exportSubmissionPack,
  recordPlan, submissionStatus,
} from './submission-store.js'

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function lineList(items, limit = 18) {
  if (!items.length) return ['- none']
  const lines = items.slice(0, limit).map((entry) => `- ${entry.status}: ${entry.label} — ${entry.detail}`)
  if (items.length > limit) lines.push(`- …${items.length - limit} more`)
  return lines
}

function renderPlan(plan) {
  const counts = plan.counts
  const lines = [
    `Submission plan for "${plan.journal}" (${plan.slug}).`,
    `Manuscript: ${plan.manuscript} · ${counts.words} words${counts.abstract_words != null ? ` · abstract ${counts.abstract_words} words` : ''}`,
    `Figures: ${counts.figures} · tables: ${counts.tables} · references: ${counts.references ?? 'not checked'}`,
    `Checks: ${plan.checks.length} · pass ${plan.status_counts.pass} · fail ${plan.status_counts.fail} · missing ${plan.status_counts.missing} · manual ${plan.status_counts.manual_check} · not checked ${plan.status_counts.not_checked}`,
    plan.ready ? 'No failed, missing, or manual checks remain.' : `Blocks upload: failed ${plan.failed.join(', ') || 'none'}; missing ${plan.missing.join(', ') || 'none'}; manual ${plan.manual_check.join(', ') || 'none'}.`,
    '',
    'Checks:',
    ...lineList(plan.checks.filter((entry) => entry.status !== 'pass' && entry.status !== 'not_checked'), 24),
  ]
  if (plan.numbers?.summary) lines.push('', `Numbers audit: ${plan.numbers.summary.flagged} candidate issue(s) of ${plan.numbers.summary.checked} checked.`)
  if (plan.warnings.length) lines.push('', 'Warnings:', ...plan.warnings.map((warning) => `- ${warning}`))
  lines.push('', plan.note)
  return lines.join('\n')
}

function renderBuild(result) {
  const { pack, manifest, plan } = result
  return [
    `Built submission pack ${pack.pack_id}.`,
    `Zip: ${pack.zip} (${pack.bytes} bytes, ${pack.zip_sha256.slice(0, 23)}…)`,
    `Files hashed: ${manifest.files.length} · checks: ${manifest.checks.length} · manual checks: ${manifest.manual_check.length}.`,
    `Cover letter and highlights are ${manifest.files.filter((entry) => entry.role === 'cover_letter' || entry.role === 'highlights').every((entry) => entry.source === 'author-supplied') ? 'author-supplied' : 'drafts requiring author approval'}.`,
    manifest.failed.length ? `Failed checks: ${manifest.failed.join(', ')}.` : 'No failed checks.',
    manifest.missing.length ? `Missing items: ${manifest.missing.join(', ')}.` : 'No missing items.',
    manifest.warnings.length ? `Warnings:\n${manifest.warnings.map((warning) => `- ${warning}`).join('\n')}` : 'No build warnings.',
    '',
    'The bundle was assembled locally and was not submitted anywhere. The zip is reproducible from manifest.json; check with action=status and action=export.',
    plan.ready ? '' : '',
  ].filter((line) => line !== '').join('\n')
}

function renderStatus(status) {
  if (!status.plan) return `No submission plan for "${status.slug}". Run action=plan first.`
  const plan = status.plan
  const lines = [
    `Submission "${status.slug}": ${plan.journal} · plan ${plan.plan_id}`,
    plan.ready ? 'No failed, missing, or manual checks in the latest plan.' : `Latest plan has failed ${plan.failed.join(', ') || 'none'}, missing ${plan.missing.join(', ') || 'none'}, and ${plan.manual_check.length} manual check(s).`,
    `Manual checks: ${plan.manual_check.length} · packs: ${status.packs.length}.`,
  ]
  if (status.packs.length) {
    lines.push('', 'Packs:')
    for (const pack of status.packs) {
      lines.push(`- ${pack.pack_id} · ${pack.created_at} · ${pack.files} file(s) · ${pack.bytes} bytes · failed ${pack.failed.length} · missing ${pack.missing.length} · manual ${pack.manual_check.length}\n  ${pack.zip}`)
    }
  }
  if (plan.manual_check.length) lines.push('', `Manual checks: ${plan.manual_check.join(', ')}.`)
  lines.push('', 'Status reports recorded checks; it does not certify submission readiness.')
  return lines.join('\n')
}

function renderValue(value) {
  if (value?.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  switch (value.action) {
    case 'plan': return [{ type: 'text', text: renderPlan(value.plan) }]
    case 'build': return [{ type: 'text', text: renderBuild(value) }]
    case 'status': return [{ type: 'text', text: renderStatus(value.status) }]
    case 'export': return [{ type: 'text', text: `Exported ${value.result.format} to ${value.result.path} (pack ${value.result.pack_id}).` }]
    default: return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }
}

export async function runSubmissionAction(args, exec) {
  const action = args.action || 'status'
  if (!SUBMISSION_ACTIONS.includes(action)) throw new Error(`action must be one of ${SUBMISSION_ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  if (action === 'plan') {
    const plan = await analyzeSubmission(args, exec, { cwd })
    const recorded = recordPlan(cwd, plan.slug, plan)
    return { action, plan: recorded }
  }
  if (action === 'build') {
    const result = await buildSubmissionPack(args, exec, { cwd })
    return { action, ...result }
  }
  if (action === 'status') {
    return { action, status: submissionStatus(cwd, args.slug) }
  }
  return {
    action,
    result: exportSubmissionPack({
      cwd, slug: args.slug, packId: args.pack_id, out: args.out,
      format: args.format || 'zip', overwrite: Boolean(args.overwrite),
    }),
  }
}

export const name = 'academic-harness-submission-pack'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'submission_pack',
    description: [
      'Plan, build, inspect, and export a journal submission bundle under `.dsh/submission/<slug>/`. It never submits, emails, or logs into a portal.',
      'Actions: `plan` (read the manuscript and journal requirements; check word/abstract/reference/figure/table limits, figure format/DPI/color/size/naming, citation style and manuscript citations, reporting-check evidence, a numbers audit, required statements, required sections, suggested reviewers, and a manuscript PDF; unknown requirements are `manual_check`), `build` (copy or compile the manuscript PDF and sources, figures, supplementary files, statements, cover letter, highlights, checklist, and a SHA-256 manifest into a pack; the zip is reproducible from the manifest), `status` (latest plan and packs with failed/missing/manual checks), `export` (copy the zip or directory; never submit).',
      'Cover letters and highlights are drafts unless the author supplies them; no claim is generated. Suggested reviewers are only those supplied by the user. Figure metadata checks use the local figure helper and vector files stay manual_check. Load the `submission-package` skill.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: SUBMISSION_ACTIONS, description: 'plan, build, status, or export. Default status.' },
      slug: { type: 'string', description: 'Submission slug; derived from the manuscript filename when omitted.' },
      manuscript: { type: 'string', description: 'Workspace-relative manuscript (.tex, .md, .txt, .docx, or .pdf).' },
      manuscript_pdf: { type: 'string', description: 'Optional final manuscript PDF when the source is not a PDF.' },
      bib: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Bibliography file(s) for the citation check.' },
      journal: { type: 'string', description: 'Target journal name.' },
      title: { type: 'string', description: 'Manuscript title for the draft cover letter.' },
      article_type: { type: 'string', description: 'Article type (e.g. research article, brief report).' },
      requirements: {
        type: 'object',
        additionalProperties: true,
        description: 'Journal requirements: {word_limit, abstract_limit, reference_limit, figure_limit, table_limit, figure_dpi, figure_formats, figure_naming (regex), color_mode, required_statements, required_sections, suggested_reviewers_limit, article_type, notes}.',
      },
      figures: { type: 'array', items: { type: 'string' }, description: 'Additional figure paths; figure references in the manuscript are included automatically.' },
      supplementary: { type: 'array', items: { type: 'string' }, description: 'Supplementary files to bundle.' },
      statements: { type: 'object', additionalProperties: true, description: 'Author-supplied statement text by key: data_availability, code_availability, funding, competing_interests, ethics, author_contributions, ai_use.' },
      suggested_reviewers: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'User-supplied reviewers only: [{name, affiliation, email, reason, source}]. Never invented.' },
      cover_letter: { type: 'string', description: 'Author-supplied cover-letter text. Omit for a placeholder draft.' },
      highlights: { type: 'array', items: { type: 'string' }, description: 'Author-supplied highlights. Omit for placeholders, not generated claims.' },
      graphical_abstract: { type: 'string', description: 'Workspace-relative graphical abstract file.' },
      reporting: { type: 'string', description: 'Reporting-check slug to include (default: the only reporting ledger, if exactly one).' },
      compile: { type: 'boolean', description: 'build: compile a .tex manuscript to PDF. Default true.' },
      engine: { type: 'string', enum: ['pdflatex', 'xelatex', 'lualatex'], description: 'TeX engine for manuscript compilation.' },
      pack_id: { type: 'string', description: 'export: pack id (default latest).' },
      out: { type: 'string', description: 'export: workspace-relative output path.' },
      format: { type: 'string', enum: ['zip', 'dir'], description: 'export: zip (default) or dir.' },
      overwrite: { type: 'boolean', description: 'export: replace an existing output. Default false.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return await runSubmissionAction(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Submission pack (${args.action || 'status'})`, kind: 'other' }
    },
  }))
}
