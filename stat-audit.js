/**
 * stat_audit: candidate statistical-reporting inconsistencies in a local
 * manuscript (.tex/.md/.txt/.docx). Recomputed p-values and a GRIM check come
 * from python-helpers/stat_audit.py. Advisory only — never misconduct.
 *
 * Optional tool: registers only with AH_ENABLE_OPTIONAL_TOOLS=1.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { optionalToolsEnabled } from './optional-tools.js'
import { runHelper } from './python-runtime.js'

const MAX_BYTES = 50 * 1024 * 1024

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function resolveReadPath(cwd, path) {
  const root = resolve(cwd)
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes the workspace: ${path}`)
  if (!existsSync(target)) throw new Error(`file not found: ${path}`)
  if (statSync(target).size > MAX_BYTES) throw new Error(`file is larger than ${MAX_BYTES / (1024 * 1024)}MB: ${path}`)
  return target
}

export async function runStatAudit(args, exec, deps = {}) {
  const helper = deps.runHelper || runHelper
  const path = typeof args.path === 'string' ? args.path.trim() : ''
  const text = typeof args.text === 'string' && args.text.trim() ? args.text : ''
  if (!path && !text) return { error: 'give a path or text' }
  const cwd = workspaceRoot(exec)
  let target = null
  if (path) {
    try {
      target = resolveReadPath(cwd, path)
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
  const result = await helper('stat_audit.py', {
    path: target,
    text: text || null,
    alpha: Number(args.alpha) || 0.05,
    grim: Boolean(args.grim),
  })
  if (result?.error) return { error: result.error }
  return { ...result, source: target ? relative(resolve(cwd), target) : '(inline text)' }
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const header = [
    `Statistical audit: ${value.source}`,
    `${value.summary.flagged} candidate inconsistency/ies`,
  ]
  if (value.summary.grim_checked) {
    header.push(`GRIM: ${value.summary.grim_flagged}/${value.summary.grim_checked} flagged`)
  }
  const lines = [header.join(' · ')]
  if (!value.rows.length) lines.push('', 'No candidate inconsistencies found in the detectable patterns.')
  for (const row of value.rows) {
    lines.push('', `- line ${row.line}: ${row.issue}`)
    lines.push(`  ${row.statistic} · reported p ${row.reported_p ?? '(n/a)'}${row.recomputed_p != null ? ` · recomputed ${row.recomputed_p}` : ''}`)
    if (row.context) lines.push(`  "${row.context}"`)
    if (row.scales_tested) lines.push(`  scales tested: ${row.scales_tested.join(', ')}`)
  }
  if (value.notes?.length) {
    lines.push('')
    for (const note of value.notes) lines.push(`Note: ${note}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

export const name = 'academic-harness-stat-audit'
export const inject = ['tools']

export function apply(ctx) {
  if (!optionalToolsEnabled()) return
  ctx.tools.register(defineTool({
    name: 'stat_audit',
    description: [
      'Scan a manuscript (.tex/.md/.txt/.docx) or inline text for candidate statistical-reporting inconsistencies: recompute p-values from reported t/F/χ²/z/r statistics and df, flag p = 0 and incompatible statistic/p pairs, and optionally run a GRIM check on reported means with their N.',
      'Findings are candidates for human review — never a misconduct conclusion. The check is pattern-based: it cannot see the underlying data, and GRIMMER (SD consistency) is not implemented.',
      'Optional tool: present only when AH_ENABLE_OPTIONAL_TOOLS=1. Local only; requires sciPy in the Python helper environment. No network and no file modification.',
    ].join(' '),
    parameters: {
      path: { type: 'string', description: 'Workspace-relative manuscript path (.tex, .md, .txt, .docx).' },
      text: { type: 'string', description: 'Inline text to audit instead of a path.' },
      alpha: { type: 'number', description: 'Alpha used when reporting boundary claims. Default 0.05.' },
      grim: { type: 'boolean', description: 'Also run GRIM consistency checks on reported means with N.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      return runStatAudit(args, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `Statistical audit: ${args.path || 'inline text'}`, kind: 'other' }
    },
  }))
}
