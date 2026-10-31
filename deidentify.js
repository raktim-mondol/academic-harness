/**
 * deidentify: local PHI/PII scanning and redaction for text, JSON, and
 * delimited tables. Regex/heuristic detection only; no network, no model call,
 * no compliance certification, and no reversible mapping.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DEIDENTIFY_ACTIONS, DEIDENTIFY_REPORT_FORMATS,
  deidentifyStatus, exportDeidentifyReport, redactFile, scanFile, verifyFile,
} from './deidentify-store.js'

function text(value) {
  return String(value ?? '').trim()
}

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function list(value) {
  if (value == null || value === '') return []
  return (Array.isArray(value) ? value : [value]).map(text).filter(Boolean)
}

function renderScan(value) {
  const scan = value.scan
  const lines = [
    `Scan ${scan.scan_id}: \`${scan.file}\` · ${scan.bytes} bytes · ${scan.match_count} candidate match(es)${scan.truncated ? ' (report capped at 1000)' : ''}.`,
    Object.keys(scan.by_type).length ? `Types: ${Object.entries(scan.by_type).map(([type, count]) => `${type} ${count}`).join(' · ')}.` : 'No pattern matches were found; this does not prove the file is de-identified.',
  ]
  if (scan.columns.length) lines.push(`Columns with matches: ${scan.columns.map((column) => `${column.name} (${column.matches})`).join(', ')}.`)
  const preview = scan.matches.slice(0, 10).map((match) => `${match.type} line ${match.line} col ${match.column}: ${match.preview}`)
  if (preview.length) lines.push('', 'Masked samples:', ...preview.map((line) => `- ${line}`))
  lines.push('', scan.note)
  return lines.join('\n')
}

function renderRedact(value) {
  const redaction = value.redaction
  const lines = [
    `Wrote redacted file ${redaction.out} (${redaction.bytes} bytes).`,
    `Matches before: ${redaction.matches_before} · residual after: ${redaction.residual.match_count}.`,
  ]
  const before = Object.entries(redaction.by_type_before || {})
  if (before.length) lines.push(`Before by type: ${before.map(([type, count]) => `${type} ${count}`).join(' · ')}.`)
  if (redaction.residual.match_count) lines.push(`Residual types: ${Object.entries(redaction.residual.by_type || {}).map(([type, count]) => `${type} ${count}`).join(' · ')}. Review these before sharing.`)
  lines.push('No reversible mapping was written. Redaction is heuristic, not a HIPAA/GDPR certification; review the report and the output.')
  return lines.join('\n')
}

function renderReport(value) {
  return `Wrote ${value.result.path} (${value.result.bytes} bytes, ${value.result.format}, scan ${value.result.scan_id}).`
}

function renderVerify(value) {
  const result = value.verification
  const lines = [
    `Verification for ${result.file}: ${result.status} (${result.residual?.match_count ?? 'not re-scanned'} match(es)).`,
  ]
  if (result.residual?.match_count) {
    lines.push(...result.residual.matches.slice(0, 10).map((match) => `- ${match.type} line ${match.line} col ${match.column}: ${match.preview}`))
    if (result.residual.match_count > 10) lines.push(`- …${result.residual.match_count - 10} more`)
  }
  lines.push(result.note)
  return lines.join('\n')
}

function renderStatus(status) {
  return [
    `De-identification ledger "${status.slug}".`,
    `Scans: ${status.scans.length}${status.scans.length ? ` · latest ${status.scans.at(-1).scan_id} (${status.scans.at(-1).match_count} matches)` : ''}.`,
    `Redactions: ${status.redactions.length}${status.redactions.length ? ` · latest ${status.redactions.at(-1).redaction_id} (residual ${status.redactions.at(-1).residual})` : ''}.`,
  ].join('\n')
}

function renderValue(value) {
  if (value?.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  switch (value.action) {
    case 'scan': return [{ type: 'text', text: renderScan(value) }]
    case 'redact': return [{ type: 'text', text: renderRedact(value) }]
    case 'report': return [{ type: 'text', text: renderReport(value) }]
    case 'verify': return [{ type: 'text', text: renderVerify(value) }]
    case 'status': return [{ type: 'text', text: renderStatus(value.status) }]
    default: return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }
}

export async function runDeidentifyAction(args, exec) {
  const action = args.action || 'scan'
  if (![...DEIDENTIFY_ACTIONS, 'status'].includes(action)) throw new Error(`action must be one of ${DEIDENTIFY_ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  const slug = text(args.slug)
  if (!slug) throw new Error('slug is required')
  if (action === 'scan') {
    if (!text(args.file)) throw new Error('file is required')
    const value = await scanFile({
      cwd, slug, file: args.file, kind: args.kind,
      terms: list(args.terms), names: list(args.names),
    })
    return { action, ...value }
  }
  if (action === 'redact') {
    if (!text(args.file) && !text(args.scan_id)) throw new Error('redact needs file or scan_id')
    const value = await redactFile({
      cwd, slug, file: args.file, out: args.out, scanId: args.scan_id,
      policy: args.policy && typeof args.policy === 'object' ? args.policy : {},
      terms: list(args.terms), names: list(args.names),
      overwrite: Boolean(args.overwrite), recordedBy: args.recorded_by,
    })
    return { action, ...value }
  }
  if (action === 'report') {
    return {
      action,
      result: exportDeidentifyReport({
        cwd, slug, scanId: args.scan_id || null, format: args.format || 'markdown',
        out: args.out, overwrite: Boolean(args.overwrite),
      }),
    }
  }
  if (action === 'verify') {
    return {
      action,
      verification: verifyFile({
        cwd, slug, file: args.file || null, redactionId: args.redaction_id || null,
        terms: list(args.terms), names: list(args.names),
      }),
    }
  }
  return { action, status: deidentifyStatus(cwd, slug) }
}

export const name = 'academic-harness-deidentify'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'deidentify',
    description: [
      'Scan and redact PHI/PII locally under `.dsh/deidentify/<slug>/` for text, JSON, CSV, and TSV files.',
      `Actions: \`scan\` (emails, phones, SSNs, MRNs, dates, ages over 89, addresses, URLs/IPs/MACs, account numbers, titled/labelled names, and explicit \`terms\`/\`names\`; a masked report with offsets, line/column, and column summaries), \`redact\` (write a separate redacted file; per-type or per-column actions mask/type/hash/remove/drop/generalize; the residual file is re-scanned), \`report\` (${DEIDENTIFY_REPORT_FORMATS.join('/')}; masked), and \`verify\` (rescan a redacted output).`,
      'Detection is regex/heuristic only and runs locally with no model or network call. Zero matches does not prove de-identification, and the tool does not guarantee HIPAA/GDPR compliance. Reports are masked, no reversible mapping is written, and a human must review every report and output. Redaction refuses a file with more than 1000 candidate matches rather than producing a partial redaction; split it or narrow the terms. Load the `research-ethics` skill for the workflow.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: [...DEIDENTIFY_ACTIONS, 'status'], description: 'scan, redact, report, verify, or status (default scan).' },
      slug: { type: 'string', description: 'De-identification ledger slug.' },
      file: { type: 'string', description: 'Workspace-relative input file.' },
      out: { type: 'string', description: 'redact: separate workspace-relative output file (required, never the input). report: optional path.' },
      kind: { type: 'string', enum: ['text', 'json', 'csv', 'tsv'], description: 'Input format (default from the extension).' },
      terms: { type: 'array', items: { type: 'string' }, description: 'Extra literal terms to detect (e.g. names or local identifiers).' },
      names: { type: 'array', items: { type: 'string' }, description: 'Extra names to detect and label as name.' },
      scan_id: { type: 'string', description: 'redact/report: use a stored scan (default latest).' },
      redaction_id: { type: 'string', description: 'verify: a stored redaction to re-scan.' },
      policy: { type: 'object', additionalProperties: true, description: 'redact policy: {default_action, types: {email: "type", ...}, columns: {column: "drop"|"hash"|"generalize"|...}, kind}.' },
      format: { type: 'string', enum: DEIDENTIFY_REPORT_FORMATS, description: 'report format (default markdown).' },
      overwrite: { type: 'boolean', description: 'Replace an existing output/report.' },
      recorded_by: { type: 'string', description: 'Who recorded the redaction.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return await runDeidentifyAction(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `De-identify: ${args.slug || ''} (${args.action || 'scan'})`, kind: 'other' }
    },
  }))
}
