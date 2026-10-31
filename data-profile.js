/**
 * data_profile: local profiling of one scientific data file before analysis.
 *
 * The statistics run in python-helpers/data_profile.py (pandas). The tool
 * confines paths to the workspace, renders the findings, and can write a
 * Markdown report, a JSON profile, and a CSV data dictionary. It reports
 * leakage *risks* and explicit `not_checked` items — never a safety claim.
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { csvCell, ensureDir, exportText, slug as slugify } from './ledger-kit.js'
import { runHelper } from './python-runtime.js'
import { resolveWorkspacePath } from './workspace-path.js'

const ACTIONS = ['profile']

function text(value) {
  return String(value ?? '').trim()
}

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function requireString(value, name) {
  const result = text(value)
  if (!result) throw new Error(`${name} is required`)
  return result
}

export function renderProfileMarkdown(profile) {
  const lines = [
    `# Data profile: ${profile.path}`,
    '',
    `${profile.rows} rows × ${profile.columns} columns · ${profile.duplicate_rows} duplicate row(s) · ${profile.duplicate_columns} duplicate column(s)`,
  ]
  if (profile.sampled) lines.push(`Sampled: ${profile.sample_note}`)
  if (profile.target) lines.push(`Target: ${profile.target}${profile.split ? ` · split: ${profile.split}` : ''}`)
  lines.push('', '## Findings', '')
  if (!profile.findings.length) lines.push('_No structural findings. Absence of findings is not a safety guarantee._')
  for (const finding of profile.findings) {
    lines.push(`- **${finding.kind}** (${finding.severity}) — ${finding.columns.join(', ')}: ${finding.note}`)
  }
  if (profile.split_summary) {
    lines.push('', `Split sizes: ${Object.entries(profile.split_summary).map(([key, value]) => `${key}=${value}`).join(', ')}`, `Rows in more than one split: ${profile.split_overlap_rows}`)
  }
  lines.push('', '## Columns', '', '| Column | Dtype | Missing % | Unique | ID-like | Date-like | Notes |', '|---|---|---:|---:|---|---|---|')
  for (const column of profile.column_profiles) {
    const notes = []
    if (column.constant) notes.push('constant')
    if (column.numeric) notes.push(`mean ${column.numeric.mean.toFixed(3)}`)
    if (column.top_categories?.length) notes.push(`top: ${column.top_categories[0].value} (${column.top_categories[0].count})`)
    if (profile.associations_with_target?.[column.name] != null) notes.push(`assoc(target)=${profile.associations_with_target[column.name]}`)
    lines.push(`| ${csvCell(column.name)} | ${column.dtype} | ${column.missing_pct} | ${column.unique} | ${column.id_like ? 'yes' : ''} | ${column.date_like ? 'yes' : ''} | ${notes.join('; ')} |`)
  }
  lines.push('', '## Not checked', '', ...profile.not_checked.map((entry) => `- ${entry}`), '')
  lines.push('Heuristics on the file as read. This is not a PHI determination and not a claim that the data are safe, correct, or leakage-free.', '')
  return lines.join('\n')
}

export function dataDictionaryCsv(profile) {
  const header = ['column', 'dtype', 'rows', 'missing', 'missing_pct', 'unique', 'id_like', 'date_like', 'min', 'max', 'mean', 'std', 'median', 'top_categories']
  const lines = [header.map(csvCell).join(',')]
  for (const column of profile.column_profiles) {
    const numeric = column.numeric || {}
    lines.push([
      column.name, column.dtype, column.rows, column.missing, column.missing_pct, column.unique,
      column.id_like, column.date_like,
      numeric.min ?? '', numeric.max ?? '', numeric.mean ?? '', numeric.std ?? '', numeric.median ?? '',
      (column.top_categories || []).map((entry) => `${entry.value}:${entry.count}`).join('; '),
    ].map(csvCell).join(','))
  }
  return `${lines.join('\n')}\n`
}

export async function runDataProfile(args, exec, deps = {}) {
  const action = args.action || 'profile'
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  const helper = deps.runHelper || runHelper
  const rel = requireString(args.path, 'path')
  const abs = resolveWorkspacePath(cwd, rel)
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`file not found: ${rel}`)
  const maxRows = args.max_rows == null ? null : Math.min(Math.max(Number(args.max_rows), 1), 5_000_000)
  const request = {
    path: abs,
    target: text(args.target) || null,
    split: text(args.split) || null,
    id_columns: Array.isArray(args.id_columns) ? args.id_columns.map(String) : [],
    max_rows: maxRows,
    association_threshold: args.association_threshold == null ? 0.6 : Number(args.association_threshold),
  }
  const profile = helper('data_profile.py', request, { timeoutMs: 120_000 })
  if (profile?.error) {
    const error = new Error(profile.error)
    if (profile.code) error.code = profile.code
    throw error
  }
  profile.path = rel
  const result = { action, profile, markdown: renderProfileMarkdown(profile) }
  if (args.write) {
    const dir = join(cwd, '.dsh', 'profiles', slugify(args.slug || rel.replace(/\.[a-z0-9]+$/i, '')), 'exports')
    ensureDir(dir)
    const overwrite = Boolean(args.overwrite)
    const written = []
    for (const [name, body] of [
      ['report.md', result.markdown],
      ['report.json', `${JSON.stringify(profile, null, 2)}\n`],
      ['data-dictionary.csv', dataDictionaryCsv(profile)],
    ]) {
      const target = join(dir, name)
      if (existsSync(target) && !overwrite) throw new Error(`${target.slice(cwd.length + 1)} already exists; pass overwrite: true to replace it`)
      written.push(exportText(target, body, { overwrite }).path.slice(cwd.length + 1))
    }
    result.written = written
  }
  return result
}

export const name = 'academic-harness-data-profile'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'data_profile',
    description: [
      'Profile one local scientific data file (CSV/TSV/Parquet/Arrow/Excel/JSON/JSONL) before analysis: dtypes, missingness, unique counts, ranges and top categories, duplicate rows and columns, constant and high-cardinality columns, ID- and date-like columns, target balance, split overlap across a split column, small categorical cells, and per-column association with the target.',
      'Leakage *risks* are flagged (near-deterministic target association, ID-like columns that track the target, rows appearing in more than one split) — heuristics for review, never automatic exclusions. Large files are sampled with `max_rows` and the report says so. Checks that cannot run (PHI content, provenance, consent, temporal validity) are listed under `not_checked`; the tool never claims data are safe. `write: true` saves report.md, report.json, and data-dictionary.csv under `.dsh/profiles/<slug>/exports/`.',
      'Local-only: no network, no upload. Needs the helper environment (`cd python-helpers && uv sync`).',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ACTIONS, description: 'profile (default).' },
      path: { type: 'string', description: 'Workspace-relative data file to profile.' },
      target: { type: 'string', description: 'Target column for balance, association, and leakage heuristics.' },
      split: { type: 'string', description: 'Split column (e.g. train/test) to check for overlapping rows.' },
      id_columns: { type: 'array', items: { type: 'string' }, description: 'Known ID columns to include in the quasi-identifier review.' },
      max_rows: { type: 'number', description: 'Read at most this many rows (large files; the report says when sampled).' },
      association_threshold: { type: 'number', description: 'Association at/above which a review finding is raised (default 0.6; >=0.95 is flagged as possible leakage).' },
      write: { type: 'boolean', description: 'Also write report.md, report.json, and data-dictionary.csv (default false).' },
      slug: { type: 'string', description: 'Output slug for write (defaults to the file stem).' },
      overwrite: { type: 'boolean', description: 'Replace existing written files (default false).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => (value.error
        ? [{ type: 'text', text: `Error: ${value.error}` }]
        : [{ type: 'text', text: value.markdown }]),
    },
    async execute(args, exec) {
      try {
        return await runDataProfile(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Data profile: ${args.path || ''}`, kind: 'other' }
    },
  }))
}
