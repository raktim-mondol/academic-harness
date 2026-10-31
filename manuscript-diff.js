/**
 * manuscript_diff: revision diffs, changed blocks, DOCX tracked changes, and a
 * response-letter skeleton (Phase 4C of docs/SCIENTIFIC-EXPANSION-PLAN.md).
 *
 * The tool only reads the two versions. It never edits either source, never
 * invents a change, and never marks a response item addressed without a
 * recorded diff hunk behind it.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import AdmZip from 'adm-zip'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { findAhRoot, runAh } from './academic-harness.js'
import { compileLatex } from './latex-compile.js'
import {
  ensureDir, exportText, hashFile, nowIso, readJson, sha256, slug as slugify,
} from './ledger-kit.js'
import { resolveWorkspacePath } from './workspace-path.js'

const MAX_SOURCE_BYTES = 50 * 1024 * 1024
const MAX_DOCX_XML_BYTES = 50 * 1024 * 1024
const ACTIONS = ['diff', 'changes', 'docx', 'letter']

function text(value) {
  return String(value ?? '').trim()
}

function list(value) {
  if (value == null || value === '') return []
  return (Array.isArray(value) ? value : [value]).map(text).filter(Boolean)
}

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function readWorkspaceFile(cwd, rel) {
  const abs = resolveWorkspacePath(cwd, rel)
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`file not found: ${rel}`)
  if (statSync(abs).size > MAX_SOURCE_BYTES) throw new Error(`file is larger than ${MAX_SOURCE_BYTES / (1024 * 1024)}MB: ${rel}`)
  return { abs, rel: rel.replace(/\\/g, '/'), body: readFileSync(abs, 'utf8') }
}

function storeDir(cwd, slug) {
  return join(cwd, '.dsh', 'manuscript-diff', slug)
}

function deriveSlug(args) {
  const explicit = text(args.slug)
  if (explicit) {
    const value = slugify(explicit)
    if (!value) throw new Error('slug must contain at least one letter or digit')
    return value
  }
  const source = text(args.new) || text(args.path) || text(args.old)
  if (!source) throw new Error('slug is required (or give a new/path file so one can be derived)')
  const value = slugify(basename(source).replace(/\.[^.]+$/, ''))
  return value || 'revision'
}

function runCommand(command, argv, { cwd, timeoutMs = 120_000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  const result = spawnSync(command, argv, {
    cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer, shell: false,
  })
  if (result.error?.code === 'ENOENT') return { missing: true, status: null, stdout: '', stderr: '', command: [command, ...argv] }
  return {
    missing: false,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    command: [command, ...argv],
  }
}

function commandAvailable(command, args = ['--version']) {
  const result = runCommand(command, args, { cwd: process.cwd(), timeoutMs: 5000 })
  return !result.missing
}

/* --------------------------------------------------------------- unified diffs */

function labelFor(cwd, abs) {
  return abs.startsWith(cwd) ? abs.slice(cwd.length + 1).replace(/\\/g, '/') : basename(abs)
}

function simpleLineDiff(oldText, newText) {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1
  const removed = oldLines.slice(prefix, oldLines.length - suffix)
  const added = newLines.slice(prefix, newLines.length - suffix)
  if (!removed.length && !added.length) return ''
  const contextBefore = prefix > 0 ? ` ${oldLines[prefix - 1]}\n` : ''
  const contextAfter = suffix > 0 ? ` ${oldLines[oldLines.length - suffix]}\n` : ''
  const header = `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`
  return `${header}\n${contextBefore}${removed.map((line) => `-${line}`).join('\n')}${removed.length ? '\n' : ''}${added.map((line) => `+${line}`).join('\n')}${added.length ? '\n' : ''}${contextAfter}`
}

function unifiedDiff(cwd, oldAbs, newAbs, oldText, newText) {
  if (!commandAvailable('diff', ['--version'])) return simpleLineDiff(oldText, newText)
  const result = runCommand('diff', ['-u', '--label', labelFor(cwd, oldAbs), '--label', labelFor(cwd, newAbs), oldAbs, newAbs], { cwd })
  if (result.missing) return simpleLineDiff(oldText, newText)
  if (result.status === 0) return ''
  if (result.status !== 1 && !result.stdout) {
    throw new Error(`diff failed: ${result.stderr.trim() || `exit ${result.status}`}`)
  }
  return result.stdout
}

export function parseUnifiedDiff(diffText) {
  const changes = []
  let current = null
  let counter = 0
  for (const line of String(diffText || '').split('\n')) {
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (header) {
      if (current && (current.removed.length || current.added.length)) {
        counter += 1
        current.id = `ch-${String(counter).padStart(3, '0')}`
        changes.push(current)
      }
      current = {
        id: null,
        old_start: Number(header[1]),
        new_start: Number(header[3]),
        old_lines: Number(header[2] ?? 1),
        new_lines: Number(header[4] ?? 1),
        removed: [],
        added: [],
        context: [],
      }
      continue
    }
    if (!current) continue
    if (line.startsWith('+')) current.added.push(line.slice(1))
    else if (line.startsWith('-')) current.removed.push(line.slice(1))
    else if (line.startsWith(' ')) current.context.push(line.slice(1))
  }
  if (current && (current.removed.length || current.added.length)) {
    counter += 1
    current.id = `ch-${String(counter).padStart(3, '0')}`
    changes.push(current)
  }
  return changes.map((change) => ({
    ...change,
    kind: change.removed.length && change.added.length ? 'modify' : change.added.length ? 'add' : 'remove',
    added_text: change.added.join('\n'),
    removed_text: change.removed.join('\n'),
  }))
}

function countLines(body) {
  return body ? body.split('\n').length : 0
}

function changesMarkdown({ slug, oldRel, newRel, changes }) {
  const lines = [
    `# Changed blocks: ${slug}`,
    '',
    `Old: \`${oldRel}\`  `,
    `New: \`${newRel}\`  `,
    `Changes: ${changes.length}`,
    '',
  ]
  if (!changes.length) lines.push('No textual changes were detected.')
  for (const change of changes) {
    lines.push(`## ${change.id} (${change.kind})`, '', `Old lines ${change.old_start}–${change.old_start + Math.max(change.old_lines, 1) - 1}, new lines ${change.new_start}–${change.new_start + Math.max(change.new_lines, 1) - 1}`, '', '```diff')
    for (const line of change.context) lines.push(` ${line}`)
    for (const line of change.removed) lines.push(`-${line}`)
    for (const line of change.added) lines.push(`+${line}`)
    lines.push('```', '')
  }
  return lines.join('\n')
}

function saveChanges({ cwd, slug, oldFile, newFile, diffText, overwrite = false }) {
  const dir = ensureDir(storeDir(cwd, slug))
  const changes = parseUnifiedDiff(diffText)
  const oldSha = `sha256:${hashFile(oldFile.abs)}`
  const newSha = `sha256:${hashFile(newFile.abs)}`
  const existing = readJson(join(dir, 'changes.json'))
  if (existing && !overwrite && (existing.old_sha256 !== oldSha || existing.new_sha256 !== newSha)) {
    throw new Error(`recorded changes for "${slug}" belong to a different version pair; use a new slug or pass overwrite: true (change ids would otherwise be re-bound)`)
  }
  const record = {
    slug,
    old: oldFile.rel,
    new: newFile.rel,
    old_sha256: oldSha,
    new_sha256: newSha,
    created_at: nowIso(),
    changes,
  }
  exportText(join(dir, 'changes.json'), `${JSON.stringify(record, null, 2)}\n`, { overwrite: true })
  exportText(join(dir, 'changes.md'), changesMarkdown({ slug, oldRel: oldFile.rel, newRel: newFile.rel, changes }), { overwrite: true })
  return { dir, record }
}

/* --------------------------------------------------------------------- diff */

export async function runManuscriptDiff(args, exec, deps = {}) {
  const action = args.action || 'diff'
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  if (action === 'docx') return runDocxAction(args, cwd)
  if (action === 'letter') return runLetterAction(args, cwd, exec)
  const slug = deriveSlug(args)
  const dir = ensureDir(storeDir(cwd, slug))

  if (action === 'diff') {
    const oldFile = readWorkspaceFile(cwd, text(args.old))
    const newFile = readWorkspaceFile(cwd, text(args.new))
    const oldExt = extname(oldFile.abs).toLowerCase()
    const newExt = extname(newFile.abs).toLowerCase()
    const latex = oldExt === '.tex' && newExt === '.tex'
    const plain = ['.md', '.markdown', '.txt'].includes(oldExt) && ['.md', '.markdown', '.txt'].includes(newExt)
    if (!latex && !plain) throw new Error('diff needs two .tex files (latexdiff) or two .md/.txt files (text diff)')

    const defaultOut = join('.dsh', 'manuscript-diff', slug, latex ? 'diff.tex' : 'diff.md')
    const outRel = text(args.out) || defaultOut
    const outAbs = resolveWorkspacePath(cwd, outRel, { forWrite: true })
    if (outAbs === oldFile.abs || outAbs === newFile.abs) throw new Error('out must not overwrite either source file')
    ensureDir(join(outAbs, '..'))

    let diffText = ''
    let command = null
    let notInstalled = null
    if (latex) {
      if (!commandAvailable('latexdiff')) {
        notInstalled = 'latexdiff is not installed; install TeX Live (or a package containing latexdiff) and retry. The two source files were not changed.'
        return {
          action, slug, kind: 'latex', old: oldFile.rel, new: newFile.rel,
          not_installed: true, error: notInstalled,
        }
      }
      const result = runCommand('latexdiff', ['--type=UNDERLINE', '--exclude-textcmd=section,subsection,subsubsection,caption', oldFile.abs, newFile.abs], { cwd })
      if (result.status !== 0) {
        throw new Error(`latexdiff failed (exit ${result.status}): ${result.stderr.trim().slice(0, 2000) || 'no diagnostic'}`)
      }
      diffText = result.stdout
      command = result.command.map((part) => (part === oldFile.abs ? oldFile.rel : part === newFile.abs ? newFile.rel : part))
    } else {
      diffText = unifiedDiff(cwd, oldFile.abs, newFile.abs, oldFile.body, newFile.body)
      command = ['diff', '-u', oldFile.rel, newFile.rel]
    }
    const written = exportText(outAbs, diffText, { overwrite: Boolean(args.overwrite) })
    const meta = {
      slug,
      kind: latex ? 'latex' : 'text',
      old: oldFile.rel,
      new: newFile.rel,
      old_sha256: `sha256:${hashFile(oldFile.abs)}`,
      new_sha256: `sha256:${hashFile(newFile.abs)}`,
      out: outRel.replace(/\\/g, '/'),
      out_sha256: `sha256:${sha256(diffText)}`,
      command,
      created_at: nowIso(),
    }
    exportText(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, { overwrite: true })

    let compile = null
    if (latex && args.compile !== false) {
      compile = await (deps.compile || compileLatex)(cwd, outRel, args.engine || 'pdflatex')
    }
    return {
      action, slug, kind: meta.kind, old: meta.old, new: meta.new,
      out: meta.out, bytes: written.bytes, changed_lines: diffText ? countLines(diffText) : 0,
      compile, meta,
      note: 'Only the diff was written; both source files were read and left unchanged.',
    }
  }

  // changes: use the given pair, or the most recent diff for this slug.
  let oldFile
  let newFile
  if (args.old && args.new) {
    oldFile = readWorkspaceFile(cwd, text(args.old))
    newFile = readWorkspaceFile(cwd, text(args.new))
  } else {
    const meta = readJson(join(dir, 'meta.json'))
    if (!meta) throw new Error(`no stored diff for "${slug}"; run action=diff first or pass old and new`)
    oldFile = readWorkspaceFile(cwd, meta.old)
    newFile = readWorkspaceFile(cwd, meta.new)
  }
  const diffText = unifiedDiff(cwd, oldFile.abs, newFile.abs, oldFile.body, newFile.body)
  const saved = saveChanges({ cwd, slug, oldFile, newFile, diffText, overwrite: Boolean(args.overwrite) })
  return {
    action, slug, old: oldFile.rel, new: newFile.rel,
    changes: saved.record.changes,
    changes_path: join('.dsh', 'manuscript-diff', slug, 'changes.json'),
    markdown_path: join('.dsh', 'manuscript-diff', slug, 'changes.md'),
  }
}

/* --------------------------------------------------------------------- docx */

const WORD_NS_ATTR = /<w:(ins|del)\b([^>]*)>/g

function xmlDecode(value) {
  return String(value || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&')
}

function stripTags(xml) {
  return xmlDecode(String(xml || '').replace(/<[^>]+>/g, ''))
}

function xmlAttr(attrs, name) {
  const match = String(attrs || '').match(new RegExp(`w:${name}="([^"]*)"`))
  return match ? xmlDecode(match[1]) : null
}

function paragraphTexts(paragraph) {
  let inner = paragraph
  inner = inner.replace(/<w:ins\b([^>]*)>([\s\S]*?)<\/w:ins>/g, (_all, _attrs, body) => `<w:t>{+</w:t>${body}<w:t>+}</w:t>`)
  inner = inner.replace(/<w:del\b([^>]*)>([\s\S]*?)<\/w:del>/g, (_all, _attrs, body) => `<w:t>[-</w:t>${body}<w:t>-]</w:t>`)
  const pieces = []
  const re = /<w:(t|delText)\b[^>]*>([\s\S]*?)<\/w:\1>/g
  let match
  while ((match = re.exec(inner)) !== null) pieces.push(xmlDecode(match[2]))
  return pieces.join('')
}

export function extractDocx(path) {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`)
  if (statSync(path).size > MAX_SOURCE_BYTES) throw new Error(`docx is larger than ${MAX_SOURCE_BYTES / (1024 * 1024)}MB: ${path}`)
  const zip = new AdmZip(path)
  const documentEntry = zip.getEntry('word/document.xml')
  if (!documentEntry) throw new Error(`not a Word document (missing word/document.xml): ${path}`)
  if (documentEntry.header.size > MAX_DOCX_XML_BYTES) throw new Error('word/document.xml is too large to read safely')
  const documentXml = documentEntry.getData().toString('utf8')
  if (/<!DOCTYPE|<!ENTITY/i.test(documentXml)) throw new Error('docx XML contains a DTD or entity declaration')

  const tracked = []
  for (const match of documentXml.matchAll(WORD_NS_ATTR)) {
    const tag = match[1]
    const attrs = match[2]
    const close = `</w:${tag}>`
    const start = match.index + match[0].length
    const end = documentXml.indexOf(close, start)
    if (end < 0) continue
    const body = documentXml.slice(start, end)
    const text = [...body.matchAll(/<w:(t|delText)\b[^>]*>([\s\S]*?)<\/w:\1>/g)].map((part) => xmlDecode(part[2])).join('')
    if (!text.trim()) continue
    tracked.push({
      kind: tag === 'ins' ? 'insertion' : 'deletion',
      author: xmlAttr(attrs, 'author'),
      date: xmlAttr(attrs, 'date'),
      text,
    })
  }

  const paragraphs = []
  for (const match of documentXml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const paragraph = paragraphTexts(match[1]).trim()
    if (paragraph) paragraphs.push(paragraph)
  }

  const comments = []
  const commentsEntry = zip.getEntry('word/comments.xml')
  if (commentsEntry && commentsEntry.header.size <= MAX_DOCX_XML_BYTES) {
    const commentsXml = commentsEntry.getData().toString('utf8')
    for (const match of commentsXml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
      const body = match[2]
      const commentText = [...body.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((part) => xmlDecode(part[1])).join('')
      comments.push({
        id: xmlAttr(match[1], 'id'),
        author: xmlAttr(match[1], 'author'),
        date: xmlAttr(match[1], 'date'),
        text: commentText,
      })
    }
  }

  const zoteroFields = []
  for (const match of documentXml.matchAll(/<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/g)) {
    const field = xmlDecode(match[1]).trim()
    if (/ADDIN\s+(ZOTERO|CSL)_|ZOTERO_BIBL/i.test(field)) zoteroFields.push(field)
  }

  return {
    path,
    tracked_changes: tracked,
    comments,
    zotero_fields: zoteroFields,
    paragraphs,
    text: paragraphs.join('\n'),
  }
}

function runDocxAction(args, cwd) {
  const path = readWorkspaceFile(cwd, text(args.path)).abs
  const extracted = extractDocx(path)
  const slug = deriveSlug({ slug: args.slug, path: args.path })
  const dir = ensureDir(storeDir(cwd, slug))
  const result = {
    slug,
    file: labelFor(cwd, path),
    tracked_changes: extracted.tracked_changes,
    comments: extracted.comments,
    zotero_fields: extracted.zotero_fields,
    notes: [
      'Tracked changes and comments are extracted as recorded; the document is not normalized or rewritten.',
      extracted.zotero_fields.length
        ? `${extracted.zotero_fields.length} Zotero/CSL field(s) were found and preserved in the extraction.`
        : 'No Zotero/CSL fields were found.',
    ],
  }
  if (args.old) {
    const oldPath = readWorkspaceFile(cwd, text(args.old)).abs
    const oldExtract = extractDocx(oldPath)
    const diffText = simpleLineDiff(oldExtract.text, extracted.text)
    result.old = labelFor(cwd, oldPath)
    result.changes = parseUnifiedDiff(diffText)
  }
  exportText(join(dir, 'docx.json'), `${JSON.stringify(result, null, 2)}\n`, { overwrite: true })
  return { action: 'docx', ...result, path: join('.dsh', 'manuscript-diff', slug, 'docx.json') }
}

/* ------------------------------------------------------------------- letter */

function latexEscape(value) {
  const placeholder = '\u0000'
  return String(value ?? '')
    .replace(/\\/g, placeholder)
    .replace(/([#$%&_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(new RegExp(placeholder, 'g'), '\\textbackslash{}')
}

function letterFromItems({ slug, items, record, requestedFormat }) {
  const byId = new Map((record?.changes || []).map((change) => [change.id, change]))
  const resolved = []
  const unresolved = []
  let index = 0
  for (const raw of items) {
    index += 1
    const item = typeof raw === 'string' ? { text: raw } : (raw || {})
    const itemId = text(item.id) || `item-${index}`
    const ids = list(item.change_ids)
    const matched = ids.map((id) => byId.get(id)).filter(Boolean)
    const missing = ids.filter((id) => !byId.has(id))
    if ((item.status === 'addressed' && !matched.length) || (text(item.response) && !ids.length)) unresolved.push(itemId)
    unresolved.push(...missing.map(() => itemId))
    resolved.push({ itemId, item, matched, missing })
  }

  if (requestedFormat === 'latex') {
    const tex = [`\\section*{Response to reviewers: ${latexEscape(slug)}}`, '']
    for (const { itemId, item, matched, missing } of resolved) {
      tex.push(`\\subsection*{${latexEscape(itemId)}}`, '\\begin{quote}', latexEscape(text(item.text) || '[Reviewer comment not recorded.]'), '\\end{quote}')
      tex.push(`\\textbf{Response.} ${latexEscape(text(item.response) || '[Author response required - the tool does not write it.]')}`, '')
      if ((item.status === 'addressed' && !matched.length) || (text(item.response) && !list(item.change_ids).length)) {
        tex.push('\\textbf{Warning:} this item has no recorded change attached; do not claim it as addressed.', '')
      }
      for (const id of missing) tex.push(`\\textbf{Unresolved:} change \\texttt{${latexEscape(id)}} is not in the recorded changes.`, '')
      for (const change of matched) {
        tex.push(`\\noindent ${latexEscape(change.id)} (${change.kind}), old line ${change.old_start}, new line ${change.new_start}:`, '\\begin{verbatim}')
        for (const line of change.removed) tex.push(`-${line}`)
        for (const line of change.added) tex.push(`+${line}`)
        tex.push('\\end{verbatim}', '')
      }
    }
    tex.push('\\emph{This is a draft skeleton. Every response and every claim about the revision needs author review.}', '')
    return { body: tex.join('\n'), unresolved }
  }

  const lines = [
    `# Response to reviewers: ${slug}`,
    '',
    'Changes below come from the recorded diff. Every quoted hunk is real; anything unresolved is marked for the authors.',
    '',
  ]
  for (const { itemId, item, matched, missing } of resolved) {
    lines.push(`## ${itemId}`, '', `> ${text(item.text) || '[Reviewer comment not recorded.]'}`, '')
    const response = text(item.response)
    lines.push(`**Response.** ${response || '[Author response required — the tool does not write it.]'}`, '')
    if ((item.status === 'addressed' && !matched.length) || (response && !list(item.change_ids).length)) {
      lines.push('> WARNING: this item is marked responded but no recorded change is attached. Do not claim it as addressed until a change exists.', '')
    }
    for (const id of missing) {
      lines.push(`> UNRESOLVED: change \`${id}\` is not in the recorded changes for this revision.`, '')
    }
    for (const change of matched) {
      lines.push(`- ${change.id} (${change.kind}), old lines ${change.old_start}, new lines ${change.new_start}:`, '', '```diff')
      for (const line of change.removed) lines.push(`-${line}`)
      for (const line of change.added) lines.push(`+${line}`)
      lines.push('```', '')
    }
  }
  lines.push('', '> This is a draft skeleton. Every response and every claim about the revision needs author review.', '')
  return { body: lines.join('\n'), unresolved }
}

async function runLetterAction(args, cwd, exec) {
  const format = args.format === 'tex' || args.format === 'latex' ? 'latex' : 'markdown'
  const reviewId = text(args.review)

  if (reviewId) {
    const root = findAhRoot(cwd)
    if (!root) {
      throw new Error('review letters for an Academic Harness review need an ah.yaml project; otherwise pass reviewer items with change_ids from action=changes')
    }
    const slug = text(args.slug)
      ? deriveSlug({ slug: args.slug })
      : (text(args.new) || text(args.path) ? deriveSlug({ new: args.new, path: args.path }) : (slugify(reviewId) || 'review'))
    const outRel = text(args.out) || join('.dsh', 'manuscript-diff', slug, format === 'latex' ? 'response-letter.tex' : 'response-letter.md')
    const outAbs = resolveWorkspacePath(cwd, outRel, { forWrite: true })
    ensureDir(join(outAbs, '..'))
    const argv = ['review', 'respond', reviewId, '--format', format === 'latex' ? 'tex' : 'md', '--out', outRel]
    const result = await runAh(cwd, argv, { timeoutMs: 120_000, signal: exec?.signal })
    const output = String(result.out || '').trim()
    if (result.code !== 0 && result.code !== 1 && result.code !== 3) {
      throw new Error(`ah review respond failed (exit ${result.code}): ${String(result.err || output || 'no diagnostic').slice(0, 2000)}`)
    }
    if (!existsSync(outAbs)) {
      throw new Error(`ah review respond finished but did not write ${outRel}: ${output.slice(0, 1000)}`)
    }
    const body = readFileSync(outAbs, 'utf8')
    return {
      action: 'letter', source: 'ah_review_respond', review: reviewId, slug,
      out: outRel.replace(/\\/g, '/'), bytes: Buffer.byteLength(body),
      findings: result.code === 3 ? output.split('\n').filter(Boolean) : [],
      note: 'The letter was built by the Academic Harness review ledger from real unit changes; it is a draft for author review.',
    }
  }

  const items = Array.isArray(args.items) ? args.items : []
  if (!items.length) throw new Error('give review (an ah_review id) or items (reviewer comments with change_ids)')
  const slug = deriveSlug(args)
  const dir = storeDir(cwd, slug)
  const record = readJson(join(dir, 'changes.json'))
  if (!record) throw new Error(`no recorded changes for "${slug}"; run action=changes first`)
  const outRel = text(args.out) || join('.dsh', 'manuscript-diff', slug, format === 'latex' ? 'response-letter.tex' : 'response-letter.md')
  const { body, unresolved } = letterFromItems({ slug, items, record, requestedFormat: format })
  const written = exportText(resolveWorkspacePath(cwd, outRel, { forWrite: true }), body, { overwrite: Boolean(args.overwrite) })
  return {
    action: 'letter', source: 'recorded_changes', slug,
    out: outRel.replace(/\\/g, '/'), bytes: written.bytes,
    changes: record.changes.length,
    unresolved: [...new Set(unresolved)],
    note: 'Every hunk came from the recorded diff; responses remain placeholders until the authors supply them.',
  }
}

/* --------------------------------------------------------------------- tool */

function renderValue(value) {
  if (value?.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (value.action === 'diff') {
    if (value.not_installed) return [{ type: 'text', text: value.error }]
    const lines = [
      `Wrote ${value.out} (${value.bytes} bytes) from ${value.old} → ${value.new}.`,
    ]
    if (value.compile) {
      lines.push(value.compile.success
        ? `Compiled: ${value.compile.pdf_path}`
        : `Compile did not finish: ${value.compile.error || value.compile.log?.slice(-800) || 'unknown error'}`)
    }
    lines.push(value.note)
    return [{ type: 'text', text: lines.join('\n') }]
  }
  if (value.action === 'changes') {
    return [{
      type: 'text',
      text: `Detected ${value.changes.length} changed block(s) in ${value.slug}.\nChanges: ${value.changes_path}\nSummary: ${value.markdown_path}`,
    }]
  }
  if (value.action === 'docx') {
    const lines = [
      `DOCX extraction for ${value.file}: ${value.tracked_changes.length} tracked change(s), ${value.comments.length} comment(s), ${value.zotero_fields.length} Zotero/CSL field(s).`,
      `Stored: ${value.path}`,
      ...(value.changes ? [`Text changes against ${value.old}: ${value.changes.length} block(s).`] : []),
      ...value.notes.map((note) => `- ${note}`),
    ]
    return [{ type: 'text', text: lines.join('\n') }]
  }
  if (value.action === 'letter') {
    const lines = [`Wrote ${value.out} (${value.bytes} bytes).`, value.note]
    if (value.findings?.length) lines.push('', 'Open review findings:', ...value.findings.map((line) => `- ${line}`))
    if (value.unresolved?.length) lines.push('', `Unresolved items: ${value.unresolved.join(', ')}. They stay unmarked until a real change or response is recorded.`)
    return [{ type: 'text', text: lines.join('\n') }]
  }
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

export const name = 'academic-harness-manuscript-diff'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'manuscript_diff',
    description: [
      'Diff two manuscript versions and build revision artifacts without editing either file.',
      'Actions: `diff` (two .tex files → latexdiff output plus optional compile; two .md/.txt files → unified diff), `changes` (extract changed blocks into `changes.json` and `changes.md` under `.dsh/manuscript-diff/<slug>/`), `docx` (extract tracked insertions/deletions and comments from a .docx, preserving Zotero/CSL fields; optional old .docx adds text changes), `letter` (build a response-letter skeleton from an `ah_review` id — via the Academic Harness engine — or from supplied reviewer items whose `change_ids` must resolve to recorded changes).',
      'latexdiff is required for .tex diffs; when missing the tool returns not_installed and writes nothing. A response item is never marked addressed without a real diff hunk behind it, and the generated letter is a draft until the authors supply the response text. Load the `manuscript-revision` skill.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ACTIONS, description: 'diff, changes, docx, or letter. Default diff.' },
      slug: { type: 'string', description: 'Revision slug; derived from the new/path filename when omitted.' },
      old: { type: 'string', description: 'Workspace-relative old version (.tex/.md/.txt; docx: optional old .docx).' },
      new: { type: 'string', description: 'Workspace-relative new version (.tex/.md/.txt).' },
      path: { type: 'string', description: 'docx: workspace-relative .docx path.' },
      out: { type: 'string', description: 'Output path for diff/letter. Default under `.dsh/manuscript-diff/<slug>/`.' },
      compile: { type: 'boolean', description: 'diff: compile a .tex diff to PDF. Default true.' },
      engine: { type: 'string', enum: ['pdflatex', 'xelatex', 'lualatex'], description: 'TeX engine for the diff compile. Default pdflatex.' },
      overwrite: { type: 'boolean', description: 'Replace an existing diff or letter file. Default false.' },
      review: { type: 'string', description: 'letter: Academic Harness review id (requires ah.yaml).' },
      items: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'letter: reviewer items [{id, text, response, status, change_ids}]. Each change_id must match a recorded change.',
      },
      format: { type: 'string', enum: ['markdown', 'latex'], description: 'letter: markdown (default) or latex.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return await runManuscriptDiff(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Manuscript diff (${args.action || 'diff'})`, kind: 'other' }
    },
  }))
}
