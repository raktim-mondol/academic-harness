/**
 * manuscript_citations: consistency check between a manuscript and its
 * bibliography. LaTeX (.tex) and Pandoc-flavored Markdown (.md) are supported;
 * Word fields are opaque, so .docx is rejected rather than guessed at.
 *
 * Local, deterministic, no network. It reports missing/unused keys, duplicate
 * entries, and — for LaTeX — undefined \ref targets and duplicate labels.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parseBibtex } from './citation-format.js'

const MAX_BYTES = 20 * 1024 * 1024
const CITE_COMMANDS = new Set([
  'cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'citeyearpar',
  'cites', 'parencite', 'parencites', 'textcite', 'textcites', 'autocite', 'autocites',
  'footcite', 'footcites', 'fullcite', 'footfullcite', 'supercite', 'smartcite', 'nocite',
])
const REF_COMMANDS = /(?:ref|autoref|cref|Cref|eqref|pageref|nameref|vref)\*?/

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
  if (!existsSync(target)) throw new Error(`file not found: ${path}`)
  if (statSync(target).size > MAX_BYTES) throw new Error(`file is larger than ${MAX_BYTES / (1024 * 1024)}MB: ${path}`)
  return target
}

function isEscaped(text, index) {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) backslashes += 1
  return backslashes % 2 === 1
}

export function stripTexComments(source) {
  return String(source || '').split('\n').map((line) => {
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === '%' && !isEscaped(line, i)) return line.slice(0, i)
    }
    return line
  }).join('\n')
}

function skipWhitespace(text, index) {
  let i = index
  while (i < text.length && /\s/.test(text[i])) i += 1
  return i
}

export function extractTexCitations(source) {
  const text = stripTexComments(source)
  const keys = new Map()
  let nociteAll = false
  const command = /\\([A-Za-z]+)\*?/g
  let match
  while ((match = command.exec(text))) {
    const name = match[1].toLowerCase()
    if (!CITE_COMMANDS.has(name)) continue
    let i = skipWhitespace(text, command.lastIndex)
    while (text[i] === '[') {
      const end = text.indexOf(']', i)
      if (end === -1) break
      i = skipWhitespace(text, end + 1)
    }
    let consumed = false
    while (text[i] === '{') {
      const end = text.indexOf('}', i)
      if (end === -1) break
      const group = text.slice(i + 1, end)
      consumed = true
      if (name === 'nocite' && group.trim() === '*') nociteAll = true
      for (const raw of group.split(',')) {
        const key = raw.trim()
        if (!key || key === '*') continue
        keys.set(key, (keys.get(key) || 0) + 1)
      }
      i = skipWhitespace(text, end + 1)
    }
    if (consumed) command.lastIndex = i
  }
  return { keys, nociteAll }
}

export function extractMarkdownCitations(source) {
  const keys = new Map()
  const pattern = /(^|[^\w@])@([A-Za-z0-9][A-Za-z0-9_:.#$%&+?<>~/-]*)/g
  for (const match of String(source || '').matchAll(pattern)) {
    const key = match[2].replace(/[.,;:]+$/, '')
    if (!key) continue
    keys.set(key, (keys.get(key) || 0) + 1)
  }
  return { keys, nociteAll: false }
}

export function extractTexLabels(source) {
  const text = stripTexComments(source)
  const labels = new Map()
  const references = new Map()
  for (const match of text.matchAll(/\\label\{([^}]*)\}/g)) {
    const label = match[1].trim()
    if (label) labels.set(label, (labels.get(label) || 0) + 1)
  }
  for (const match of text.matchAll(new RegExp(`\\\\(${REF_COMMANDS.source})\\s*\\{([^}]*)\\}`, 'g'))) {
    for (const raw of match[2].split(',')) {
      const label = raw.trim()
      if (label) references.set(label, (references.get(label) || 0) + 1)
    }
  }
  return {
    labels,
    undefined_refs: [...references.keys()].filter((label) => !labels.has(label)),
    duplicate_labels: [...labels.entries()].filter(([, count]) => count > 1).map(([label]) => label),
  }
}

export function parseBibEntries(text) {
  const entries = []
  const counts = new Map()
  const pattern = /@([A-Za-z]+)\s*[{(]\s*([^,\s}]+)\s*,/g
  for (const match of String(text || '').matchAll(pattern)) {
    const type = match[1].toLowerCase()
    if (['string', 'preamble', 'comment'].includes(type)) continue
    const key = match[2].trim()
    entries.push({ key, type })
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return {
    entries,
    duplicate_keys: [...counts.entries()].filter(([, count]) => count > 1).map(([key, count]) => ({ key, count })),
  }
}

function discoverBibliographies(manuscriptPath, source) {
  const dir = dirname(manuscriptPath)
  const found = []
  const withBib = (value) => (value.endsWith('.bib') ? value : `${value}.bib`)
  for (const match of source.matchAll(/\\bibliography\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim()
      if (name) found.push(resolve(dir, withBib(name)))
    }
  }
  for (const match of source.matchAll(/\\addbibresource(?:\[[^\]]*\])?\{([^}]*)\}/g)) {
    const name = match[1].trim()
    if (name) found.push(resolve(dir, name))
  }
  return [...new Set(found)]
}

function bibPathsFromArgs(cwd, value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',')
  return raw.map((part) => part.trim()).filter(Boolean).map((part) => resolveInside(cwd, part))
}

export async function runManuscriptCitations(args, exec) {
  const cwd = workspaceRoot(exec)
  const manuscriptPath = String(args.manuscript || '').trim()
  if (!manuscriptPath) return { error: 'give a manuscript path (.tex or .md)' }
  let manuscript
  try {
    manuscript = resolveInside(cwd, manuscriptPath)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  const extension = manuscript.toLowerCase().slice(manuscript.lastIndexOf('.'))
  if (!['.tex', '.md', '.markdown'].includes(extension)) {
    return { error: 'manuscript must be a .tex or .md file (Word citation fields cannot be inspected reliably)' }
  }
  const source = readFileSync(manuscript, 'utf8')
  const warnings = []
  const citations = extension === '.tex' ? extractTexCitations(source) : extractMarkdownCitations(source)
  const refs = extension === '.tex' ? extractTexLabels(source) : { undefined_refs: [], duplicate_labels: [] }

  let bibPaths = []
  try {
    bibPaths = bibPathsFromArgs(cwd, args.bib_path)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  if (!bibPaths.length && extension === '.tex') {
    bibPaths = discoverBibliographies(manuscript, stripTexComments(source))
  }
  if (!bibPaths.length) return { error: 'give bib_path: no bibliography was found in the manuscript' }
  const missingFiles = bibPaths.filter((path) => !existsSync(path))
  if (missingFiles.length && missingFiles.length === bibPaths.length) {
    return { error: `bibliography file not found: ${missingFiles.map((path) => relative(cwd, path)).join(', ')}` }
  }
  for (const path of missingFiles) warnings.push(`bibliography file not found: ${relative(cwd, path)}`)

  const bibText = bibPaths.filter((path) => existsSync(path)).map((path) => readFileSync(path, 'utf8')).join('\n\n')
  const bibliography = parseBibEntries(bibText)
  const entriesByKey = new Map()
  for (const entry of bibliography.entries) if (!entriesByKey.has(entry.key)) entriesByKey.set(entry.key, entry)
  let titles = new Map()
  try {
    titles = new Map(parseBibtex(bibText).map((record) => [record['citation-key'], record.title]).filter(([key]) => key))
  } catch {
    warnings.push('BibTeX could not be fully parsed; unused-entry titles are unavailable')
  }

  const cited = [...citations.keys.entries()].map(([key, count]) => ({ key, count }))
  const missing = cited.filter((entry) => !entriesByKey.has(entry.key))
  const unused = citations.nociteAll
    ? []
    : bibliography.entries
      .filter((entry) => !citations.keys.has(entry.key))
      .map((entry) => ({ key: entry.key, type: entry.type, title: titles.get(entry.key) || null }))

  return {
    manuscript: relative(cwd, manuscript),
    bibliography: bibPaths.filter((path) => existsSync(path)).map((path) => relative(cwd, path)),
    statistics: {
      cited_keys: cited.length,
      citation_uses: cited.reduce((sum, entry) => sum + entry.count, 0),
      bibliography_entries: bibliography.entries.length,
      missing: missing.length,
      unused: unused.length,
      duplicate_keys: bibliography.duplicate_keys.length,
      undefined_refs: refs.undefined_refs.length,
      duplicate_labels: refs.duplicate_labels.length,
    },
    missing_keys: missing,
    unused_keys: unused,
    duplicate_keys: bibliography.duplicate_keys,
    undefined_refs: refs.undefined_refs,
    duplicate_labels: refs.duplicate_labels,
    nocite_all: citations.nociteAll,
    warnings,
  }
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const stats = value.statistics
  const lines = [
    `Manuscript citations: ${value.manuscript} ↔ ${value.bibliography.join(', ')}`,
    `${stats.cited_keys} key(s) cited (${stats.citation_uses} uses) · ${stats.bibliography_entries} bibliography entries`,
  ]
  const section = (title, items) => {
    if (!items.length) return
    lines.push('', `${title}:`)
    for (const item of items) lines.push(`- ${item}`)
  }
  section('Missing from the bibliography', value.missing_keys.map((entry) => `${entry.key} (cited ${entry.count}×)`))
  section('Bibliography entries never cited', value.unused_keys.map((entry) => `${entry.key}${entry.title ? ` — ${entry.title}` : ''}`))
  section('Duplicate bibliography keys', value.duplicate_keys.map((entry) => `${entry.key} (${entry.count} entries)`))
  section('Undefined references', value.undefined_refs)
  section('Duplicate labels', value.duplicate_labels)
  if (value.nocite_all) lines.push('', 'Unused-entry detection is suppressed by \\nocite{*}.')
  if (!stats.missing && !stats.unused && !stats.duplicate_keys && !stats.undefined_refs && !stats.duplicate_labels) {
    lines.push('', 'No citation or reference inconsistencies found.')
  }
  for (const warning of value.warnings) lines.push('', `Warning: ${warning}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

export const name = 'academic-harness-manuscript-citations'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'manuscript_citations',
    description: [
      'Check a LaTeX (.tex) or Pandoc Markdown (.md) manuscript against its BibTeX bibliography: cited keys missing from the .bib, entries never cited, duplicate keys, and — for LaTeX — undefined \\ref targets and duplicate \\label definitions.',
      'Pass `manuscript` and optionally `bib_path` (comma-separated or array). For .tex, the bibliography is otherwise discovered from \\bibliography{...} or \\addbibresource{...}. \\nocite{*} suppresses unused-entry reporting.',
      'Local, deterministic, no network. It does not reformat citations (use `citation`) and does not verify that a citation supports a claim (PaperMemory/scite). Word .docx files are rejected because citation fields are opaque.',
    ].join(' '),
    parameters: {
      manuscript: { type: 'string', description: 'Workspace-relative .tex or .md manuscript.' },
      bib_path: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'Workspace-relative .bib file(s). Optional for .tex, required for .md.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      return runManuscriptCitations(args, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `Citations: ${args.manuscript || ''}`, kind: 'other' }
    },
  }))
}
