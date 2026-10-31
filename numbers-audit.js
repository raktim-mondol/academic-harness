/**
 * numbers_audit: extended statistical-reporting consistency checks across a
 * manuscript's text, tables, and flow counts (Phase 4E of
 * docs/SCIENTIFIC-EXPANSION-PLAN.md).
 *
 * The audit reports candidates for human review. It recomputes only what the
 * text makes checkable and marks everything else `not_checked`; it never says a
 * result is statistically valid.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { convertPdfMarkdown } from './pdf-to-markdown.js'
import { runHelper } from './python-runtime.js'
import { resolveWorkspacePath } from './workspace-path.js'

const MAX_BYTES = 50 * 1024 * 1024

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function resolveReadPath(cwd, path) {
  const target = resolveWorkspacePath(cwd, path)
  if (!existsSync(target)) throw new Error(`file not found: ${path}`)
  if (statSync(target).size > MAX_BYTES) throw new Error(`file is larger than ${MAX_BYTES / (1024 * 1024)}MB: ${path}`)
  return target
}

export async function runNumbersAudit(args, exec, deps = {}) {
  const helper = deps.runHelper || runHelper
  const cwd = workspaceRoot(exec)
  const path = typeof args.path === 'string' ? args.path.trim() : ''
  const inline = typeof args.text === 'string' && args.text.trim() ? args.text : ''
  if (!path && !inline) return { error: 'give a path or text' }
  if (path && inline) return { error: 'give a path or text, not both' }

  let target = null
  let text = inline || null
  let sourceKind = inline ? '(inline text)' : null
  if (path) {
    target = resolveReadPath(cwd, path)
    sourceKind = relative(resolve(cwd), target)
    const ext = extname(target).toLowerCase()
    if (ext === '.pdf') {
      const converted = await convertPdfMarkdown(readFileSync(target))
      if (!converted.success) return { error: converted.error || 'PDF text extraction failed' }
      text = converted.markdown || ''
      if (!text.trim()) return { error: 'the PDF yielded no extractable text; OCR it with pdf_to_markdown first' }
    } else if (!['.tex', '.md', '.markdown', '.txt', '.text', '.docx'].includes(ext)) {
      return { error: 'path must end in .tex, .md, .txt, .docx, or .pdf' }
    }
  }

  const request = {
    mode: 'numbers',
    path: target,
    text,
    alpha: Number(args.alpha) || 0.05,
    grim: Boolean(args.grim),
  }
  const result = await helper('stat_audit.py', request)
  if (result?.error) return { error: result.error }
  return { ...result, source: sourceKind, file: result.file || sourceKind }
}

function renderValue(value) {
  if (value?.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const summary = value.summary || {}
  const lines = [
    `Numbers audit: ${value.source || value.file || '(inline text)'}`,
    `${summary.flagged ?? 0} candidate issue(s) · ${summary.checked ?? 0} checked value(s)${summary.matched_table_rows != null ? ` · ${summary.matched_table_rows} matched table row(s)` : ''}`,
  ]
  if (summary.by_kind && Object.keys(summary.by_kind).length) {
    lines.push(`By kind: ${Object.entries(summary.by_kind).map(([kind, count]) => `${kind} ${count}`).join(' · ')}`)
  }
  for (const row of value.rows || []) {
    lines.push('', `- line ${row.line} [${row.kind}] ${row.detail}`)
    if (row.statistic) lines.push(`  ${row.statistic} · reported p ${row.reported_p ?? '(n/a)'}${row.recomputed_p != null ? ` · recomputed ${row.recomputed_p}` : ''}`)
    if (row.context) lines.push(`  “${row.context}”`)
  }
  if (value.not_checked?.length) {
    lines.push('', `Not checked (${value.not_checked.length}):`)
    for (const item of value.not_checked.slice(0, 12)) lines.push(`- ${item}`)
    if (value.not_checked.length > 12) lines.push(`- …${value.not_checked.length - 12} more`)
  }
  if (value.notes?.length) lines.push('', ...value.notes.map((note) => `Note: ${note}`))
  lines.push('', 'Candidates for human review; this is not a claim of statistical validity or misconduct.')
  return [{ type: 'text', text: lines.join('\n') }]
}

export const name = 'academic-harness-numbers-audit'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'numbers_audit',
    description: [
      'Audit a manuscript for numerical-reporting inconsistencies across text, tables, and flow counts. Reads `.tex`, `.md`, `.txt`, `.docx`, or `.pdf` (PDF text extraction first) and reports candidates for human review.',
      'Checks include: p-values recomputed from reported test statistics and df where possible; p-values outside [0, 1] or reported as exactly 0; confidence intervals that are reversed or zero-width; estimates outside their own CI; non-positive ratio measures; total N inconsistency across sections; subgroup n exceeding the total; flow counts that increase (analyzed > randomized); fraction/percentage mismatches; percentages outside 0–100; and label-matched table-versus-text values. Values that cannot be recomputed or matched are listed as `not_checked`.',
      'The tool is conservative about matching and ignores citations, references, equations, and years in its targeted patterns. It does not claim statistical validity, does not run GRIM unless `grim: true`, and never replaces a statistician. Load the `numbers-audit` skill.',
    ].join(' '),
    parameters: {
      path: { type: 'string', description: 'Workspace-relative .tex, .md, .txt, .docx, or .pdf manuscript.' },
      text: { type: 'string', description: 'Inline manuscript text instead of a path.' },
      alpha: { type: 'number', description: 'Alpha used for reporting context. Default 0.05.' },
      grim: { type: 'boolean', description: 'Also run the GRIM mean-consistency check. Default false.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return await runNumbersAudit(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Numbers audit: ${args.path || '(inline text)'}`, kind: 'other' }
    },
  }))
}
