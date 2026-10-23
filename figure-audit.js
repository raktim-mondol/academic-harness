/**
 * figure_audit: local figure inventory — dimensions, DPI, format, and
 * pairwise perceptual-hash similarity (duplicate/near-duplicate candidates).
 * Advisory only; it does not detect manipulation.
 *
 * Optional tool: registers only with AH_ENABLE_OPTIONAL_TOOLS=1.
 */
import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { optionalToolsEnabled } from './optional-tools.js'
import { runHelper } from './python-runtime.js'

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function resolveInside(cwd, path) {
  const root = resolve(cwd)
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes the workspace: ${path}`)
  if (!existsSync(target)) throw new Error(`path not found: ${path}`)
  return target
}

export async function runFigureAudit(args, exec, deps = {}) {
  const helper = deps.runHelper || runHelper
  const cwd = workspaceRoot(exec)
  const paths = Array.isArray(args.paths) ? args.paths : (args.paths ? [args.paths] : [])
  let resolved = []
  let dir = null
  try {
    resolved = paths.map((path) => resolveInside(cwd, path))
    if (args.dir) dir = resolveInside(cwd, args.dir)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  if (!resolved.length && !dir) return { error: 'give paths or a dir' }
  const result = await helper('figure_audit.py', {
    paths: resolved,
    dir,
    min_dpi: Number(args.min_dpi) || 300,
    similarity_threshold: Number(args.similarity_threshold) || 0.92,
  })
  if (result?.error) return { error: result.error }
  const strip = (path) => (path ? relative(resolve(cwd), path) : null)
  return {
    ...result,
    files: result.files.map((file) => ({ ...file, path: strip(file.path) })),
    duplicates: result.duplicates.map((pair) => ({ ...pair, a: strip(pair.a), b: strip(pair.b) })),
    suggested_review_order: result.suggested_review_order.map(strip),
  }
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const lines = [
    `Figure audit: ${value.summary.files} file(s) · ${value.summary.low_dpi} below ${value.min_dpi} DPI · ${value.summary.dpi_missing} without DPI metadata · ${value.summary.duplicate_pairs} near-duplicate pair(s)`,
  ]
  if (value.summary.unreadable) lines.push(`Unreadable: ${value.summary.unreadable}`)
  for (const file of value.files) {
    const bits = [
      file.width && file.height ? `${file.width}×${file.height}` : null,
      file.dpi ? `${file.dpi.join('×')} DPI` : 'DPI missing',
      file.format,
      file.flags?.length ? `FLAGS: ${file.flags.join(', ')}` : null,
      file.error ? `ERROR: ${file.error}` : null,
    ].filter(Boolean)
    lines.push(`- ${file.path}: ${bits.join(' · ')}`)
  }
  if (value.duplicates.length) {
    lines.push('', 'Near-duplicate candidates (review first):')
    for (const pair of value.duplicates) lines.push(`- ${pair.similarity} · ${pair.a} ↔ ${pair.b}`)
  }
  if (value.suggested_review_order.length) {
    lines.push('', `Suggested review order: ${value.suggested_review_order.join(', ')}`)
  }
  for (const note of value.notes || []) lines.push('', `Note: ${note}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

export const name = 'academic-harness-figure-audit'
export const inject = ['tools']

export function apply(ctx) {
  if (!optionalToolsEnabled()) return
  ctx.tools.register(defineTool({
    name: 'figure_audit',
    description: [
      'Audit figure files locally: dimensions, DPI, color mode, format, low-resolution candidates, images without DPI metadata, and pairwise perceptual-hash near-duplicate groups.',
      'Findings are advisory — duplicate panels and low DPI are candidates for human review, not image-manipulation conclusions. The hash is a local dHash; no network calls and no file modification.',
      'Optional tool: present only when AH_ENABLE_OPTIONAL_TOOLS=1. Requires Pillow in the Python helper environment.',
    ].join(' '),
    parameters: {
      paths: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'Workspace-relative image path(s).',
      },
      dir: { type: 'string', description: 'Workspace-relative directory to scan recursively for images.' },
      min_dpi: { type: 'number', description: 'Low-resolution threshold in DPI. Default 300.' },
      similarity_threshold: { type: 'number', description: 'Near-duplicate similarity threshold 0-1. Default 0.92.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      return runFigureAudit(args, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `Figure audit: ${args.dir || args.paths || ''}`, kind: 'other' }
    },
  }))
}
