/**
 * reporting_check: a reporting-guideline checker for manuscripts.
 *
 * The model proposes a verdict and evidence; the tool verifies the quote
 * against the manuscript and records the result in an append-only ledger under
 * `.dsh/reporting/<slug>/`. The tool never says a manuscript is compliant, and
 * `not_reported` is an advisory claim of absence that must name what was
 * searched.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { notebookFile } from './notebook.js'
import { papermemoryEnv, resolvePaperMemoryLaunch } from './papermemory-cli.js'
import { convertPdfMarkdown } from './pdf-to-markdown.js'
import { runHelper } from './python-runtime.js'
import {
  deriveStatus, exportCheck, readCheck, readVerdicts, recordVerdict, reportingSlug, startCheck, VERDICTS,
} from './reporting-store.js'
import { resolveWorkspacePath } from './workspace-path.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHECKLIST_ROOT = join(HERE, 'checklists')
const MAX_SOURCE_BYTES = 50 * 1024 * 1024
const ALLOWED_EXTENSIONS = new Set(['.tex', '.md', '.markdown', '.txt', '.text', '.docx', '.pdf'])
const ACTIONS = ['list', 'suggest', 'start', 'items', 'candidates', 'judge', 'status', 'export']
const FILTERS = ['all', 'unassessed', 'assessed', 'failing', 'stale', 'reported', 'partial', 'not_reported', 'not_applicable']
const EVIDENCE_VERDICTS = new Set(['reported', 'partial'])

const ALIASES = {
  consort: 'consort',
  'consort-2010': 'consort',
  strobe: 'strobe',
  'strobe-2007': 'strobe',
  prisma: 'prisma',
  'prisma-2020': 'prisma',
  'prisma-s': 'prisma-s',
  'prisma-s-2021': 'prisma-s',
  'prisma-scr': 'prisma-scr',
  'prisma-scr-2018': 'prisma-scr',
  arrive: 'arrive',
  'arrive-2': 'arrive',
  'arrive-2.0': 'arrive',
  'arrive-20': 'arrive',
  'arrive-2-0': 'arrive',
  'tripod-ai': 'tripod-ai',
  'tripod-plus-ai': 'tripod-ai',
  tripod: 'tripod-ai',
  care: 'care',
  'care-2013': 'care',
  stard: 'stard',
  'stard-2015': 'stard',
}

const DESIGN_CUES = [
  {
    id: 'consort',
    patterns: [
      [/randomi[sz]ed/gi, 3],
      [/\brandomi[sz]ation\b/gi, 2],
      [/\bplacebo\b/gi, 2],
      [/allocation conceal/gi, 3],
      [/parallel.group/gi, 2],
      [/\bclinical trial\b/gi, 2],
      [/\btrial\b/gi, 1],
    ],
  },
  {
    id: 'strobe',
    patterns: [
      [/\bcohort\b/gi, 4],
      [/case.control/gi, 4],
      [/cross.sectional/gi, 4],
      [/\bobservational\b/gi, 3],
      [/\bconfound/gi, 1],
    ],
  },
  {
    id: 'prisma',
    patterns: [
      [/systematic review/gi, 5],
      [/meta.analysis/gi, 4],
      [/\bPRISMA\b/gi, 3],
      [/search strategy/gi, 2],
      [/records? screened/gi, 2],
    ],
  },
  {
    id: 'prisma-scr',
    patterns: [
      [/scoping review/gi, 6],
      [/scoping study/gi, 6],
      [/mapping review/gi, 4],
      [/evidence map/gi, 3],
    ],
  },
  {
    id: 'arrive',
    patterns: [
      [/\bmice\b/gi, 2],
      [/\brats?\b/gi, 2],
      [/in vivo/gi, 3],
      [/\banimals?\b/gi, 1],
      [/\bIACUC\b/gi, 4],
      [/animal ethics/gi, 3],
    ],
  },
  {
    id: 'tripod-ai',
    patterns: [
      [/prediction model/gi, 4],
      [/prognostic model/gi, 3],
      [/machine learning/gi, 4],
      [/deep learning/gi, 4],
      [/artificial intelligence/gi, 3],
      [/\bAUC\b/gi, 2],
      [/calibration/gi, 1],
      [/training set/gi, 2],
    ],
  },
  {
    id: 'care',
    patterns: [
      [/case report/gi, 6],
      [/we report a case/gi, 6],
      [/\byear.old\b/gi, 2],
      [/informed consent/gi, 1],
    ],
  },
  {
    id: 'stard',
    patterns: [
      [/diagnostic accuracy/gi, 5],
      [/sensitivity and specificity/gi, 5],
      [/\bindex test\b/gi, 4],
      [/reference standard/gi, 4],
      [/\bspecificity\b/gi, 2],
    ],
  },
]

function workspaceRoot(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function text(value) {
  if (value == null) return ''
  if (Array.isArray(value)) return text(value[0])
  return String(value).replace(/\s+/g, ' ').trim()
}

function normalizeQuote(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function normalizeId(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\+/g, '-plus-')
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function compareVersions(a, b) {
  const left = String(a).split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  const right = String(b).split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l === r) continue
    if (typeof l === 'number' && typeof r === 'number') return l - r
    return String(l).localeCompare(String(r))
  }
  return 0
}

export function loadGuidelines() {
  if (!existsSync(CHECKLIST_ROOT)) return []
  const out = []
  for (const dir of readdirSync(CHECKLIST_ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const dirPath = join(CHECKLIST_ROOT, dir.name)
    for (const file of readdirSync(dirPath)) {
      if (!file.endsWith('.json')) continue
      try {
        const checklist = JSON.parse(readFileSync(join(dirPath, file), 'utf8'))
        out.push(checklist)
      } catch (error) {
        throw new Error(`checklist ${dir.name}/${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || compareVersions(a.version, b.version))
}

export function resolveChecklist(guideline, version) {
  const guidelines = loadGuidelines()
  const raw = normalizeId(guideline)
  let wantedVersion = version == null ? null : String(version).trim()
  let base = raw
  const at = raw.lastIndexOf('@')
  if (at > 0) {
    base = raw.slice(0, at)
    wantedVersion = wantedVersion || raw.slice(at + 1)
  }
  base = ALIASES[base] || base
  if (!wantedVersion) {
    const suffix = guidelines
      .map((item) => `${item.id}-${normalizeId(item.version)}`)
      .sort((a, b) => b.length - a.length)
      .find((candidate) => raw === candidate || raw.startsWith(`${candidate}-`))
    if (suffix) {
      const matched = guidelines.find((item) => `${item.id}-${normalizeId(item.version)}` === suffix)
      if (matched) {
        base = matched.id
        wantedVersion = matched.version
      }
    }
  }
  let matches = guidelines.filter((item) => item.id === base)
  if (!matches.length) {
    matches = guidelines.filter((item) => normalizeId(item.name) === raw || normalizeId(item.name).startsWith(`${raw}-`))
  }
  if (!matches.length) {
    const available = guidelines.map((item) => `${item.id}@${item.version}`).join(', ')
    throw new Error(`unknown guideline "${guideline}". Available: ${available}`)
  }
  if (wantedVersion) {
    const exact = matches.find((item) => String(item.version) === wantedVersion || normalizeId(item.version) === normalizeId(wantedVersion))
    if (!exact) {
      const available = matches.map((item) => item.version).join(', ')
      throw new Error(`guideline ${base} has no version "${wantedVersion}" (available: ${available})`)
    }
    return exact
  }
  return [...matches].sort((a, b) => compareVersions(b.version, a.version))[0]
}

function guidelineInfo(checklist) {
  return {
    id: checklist.id,
    name: checklist.name,
    version: checklist.version,
    study_designs: checklist.study_designs || [],
    source_url: checklist.source_url,
    item_count: checklist.items.length,
    notes: checklist.notes || null,
  }
}

/* ------------------------------------------------------------------ source */

const REMOVE_ARG_COMMANDS = new Set([
  'cite', 'citep', 'citet', 'citealp', 'citeauthor', 'citeyear', 'citeyearpar',
  'ref', 'eqref', 'pageref', 'autoref', 'label', 'url', 'href', 'includegraphics',
  'input', 'include', 'includeonly', 'bibliography', 'bibliographystyle',
  'documentclass', 'usepackage', 'newcommand', 'renewcommand', 'providecommand', 'def',
  'begin', 'end', 'graphicspath',
])

function maskArgs(chars, start, blank) {
  let i = start
  while (i < chars.length) {
    while (i < chars.length && /\s/.test(chars[i])) i += 1
    if (chars[i] !== '[' && chars[i] !== '{') break
    const open = chars[i]
    const close = open === '[' ? ']' : '}'
    let depth = 0
    let j = i
    while (j < chars.length) {
      if (chars[j] === open) depth += 1
      else if (chars[j] === close) {
        depth -= 1
        if (depth === 0) { j += 1; break }
      }
      j += 1
    }
    blank(i, j)
    i = j
  }
  return i
}

/** Mask LaTeX commands and math with spaces, preserving length and newlines. */
export function maskLatex(text) {
  const chars = text.split('')
  const blank = (from, to) => {
    for (let j = from; j < to; j += 1) {
      if (chars[j] !== '\n' && chars[j] !== '\r') chars[j] = ' '
    }
  }
  let i = 0
  while (i < chars.length) {
    const ch = chars[i]
    if (ch === '%' && chars[i - 1] !== '\\') {
      let j = i
      while (j < chars.length && chars[j] !== '\n') j += 1
      blank(i, j)
      i = j
      continue
    }
    if (ch === '\\') {
      const next = chars[i + 1]
      if (next && /[A-Za-z]/.test(next)) {
        let j = i + 1
        while (j < chars.length && /[A-Za-z]/.test(chars[j])) j += 1
        const command = chars.slice(i + 1, j).join('')
        if (chars[j] === '*') j += 1
        blank(i, j)
        if (REMOVE_ARG_COMMANDS.has(command)) j = maskArgs(chars, j, blank)
        i = j
        continue
      }
      if (next === '%' || next === '&' || next === '_' || next === '#' || next === '$' || next === '{' || next === '}') {
        blank(i, i + 1)
        i += 2
        continue
      }
      blank(i, Math.min(i + 2, chars.length))
      i += 2
      continue
    }
    if (ch === '{' || ch === '}') {
      chars[i] = ' '
      i += 1
      continue
    }
    if (ch === '~') {
      chars[i] = ' '
      i += 1
      continue
    }
    if (ch === '$') {
      const double = chars[i + 1] === '$'
      let j = i + (double ? 2 : 1)
      while (j < chars.length) {
        if (chars[j] === '\\') { j += 2; continue }
        if (double ? (chars[j] === '$' && chars[j + 1] === '$') : chars[j] === '$') break
        j += 1
      }
      if (j < chars.length) {
        const end = j + (double ? 2 : 1)
        blank(i, end)
        i = end
        continue
      }
      chars[i] = ' '
      i += 1
      continue
    }
    i += 1
  }
  return chars.join('')
}

function lineStartsOf(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1)
  }
  return starts
}

function lineAt(lineStarts, offset) {
  const target = Math.max(0, Math.min(offset, lineStarts[lineStarts.length - 1]))
  let low = 0
  let high = lineStarts.length - 1
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (lineStarts[mid] <= target) low = mid + 1
    else high = mid - 1
  }
  return high + 1
}

function detectSections(rawText, format) {
  const sections = []
  const starts = lineStartsOf(rawText)
  if (format === 'latex') {
    const pattern = /\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?\{([^}]*)\}/g
    let match
    while ((match = pattern.exec(rawText)) !== null) {
      const title = match[1].replace(/\\[A-Za-z]+\*?(?:\[[^\]]*\])?\{?|\}/g, ' ').replace(/\s+/g, ' ').trim()
      sections.push({ start: match.index, title: title || 'Methods' })
    }
  } else if (format === 'markdown' || format === 'pdf' || format === 'docx') {
    let fence = false
    for (let i = 0; i < starts.length; i += 1) {
      const end = i + 1 < starts.length ? starts[i + 1] : rawText.length
      const line = rawText.slice(starts[i], end).trim()
      if (/^```/.test(line)) { fence = !fence; continue }
      if (fence) continue
      const match = /^(#{1,6})\s+(.+)$/.exec(line)
      if (match) sections.push({ start: starts[i], title: match[2].trim() })
    }
  }
  if (!sections.length || sections[0].start > 0) sections.unshift({ start: 0, title: 'Document' })
  return sections.sort((a, b) => a.start - b.start)
}

function detectUnits(rawText, lineStarts) {
  const units = []
  for (let i = 0; i < lineStarts.length; i += 1) {
    const end = i + 1 < lineStarts.length ? lineStarts[i + 1] : rawText.length
    const line = rawText.slice(lineStarts[i], end)
    const match = /^\s*%%\s*@unit\s+([A-Za-z0-9._-]+)/.exec(line)
    if (match) units.push({ line: i + 1, id: match[1] })
  }
  return units
}

function buildNormalized(text) {
  const chars = []
  const map = []
  let pendingSpace = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      if (chars.length) pendingSpace = true
      continue
    }
    if (pendingSpace) {
      chars.push(' ')
      map.push(i)
      pendingSpace = false
    }
    chars.push(ch)
    map.push(i)
  }
  return { text: chars.join(''), map }
}

function firstHeading(rawText) {
  const match = /^\s*#{1,6}\s+(.+)$/m.exec(rawText)
  if (match) return match[1].trim()
  const title = /\\title\{([^}]*)\}/.exec(rawText)
  return title ? title[1].replace(/\s+/g, ' ').trim() : null
}

function buildSource({
  rawText, searchText, kind, path = null, paper = null, title = null, format, notes = [], truncated = false,
}) {
  const starts = lineStartsOf(rawText)
  const sections = detectSections(rawText, format)
  const units = detectUnits(rawText, starts)
  const normSearch = buildNormalized(searchText)
  const normRaw = buildNormalized(rawText)
  const quoteCache = new Map()

  const sectionAt = (offset) => {
    let current = sections[0]?.title || 'Document'
    for (const section of sections) {
      if (section.start > offset) break
      current = section.title
    }
    return current
  }

  const unitAtLine = (line) => {
    let unit = null
    for (const anchor of units) {
      if (anchor.line > line) break
      unit = anchor.id
    }
    return unit
  }

  const locate = (quote) => {
    const key = normalizeQuote(quote)
    if (!key) return null
    if (quoteCache.has(key)) return quoteCache.get(key)
    let hit = null
    for (const source of [normSearch, normRaw]) {
      const index = source.text.indexOf(key)
      if (index < 0) continue
      const start = source.map[index]
      const end = source.map[index + key.length - 1] + 1
      const lineStart = lineAt(starts, start)
      const lineEnd = lineAt(starts, Math.max(start, end - 1))
      hit = {
        start,
        end,
        line_start: lineStart,
        line_end: lineEnd,
        section: sectionAt(start),
        unit: unitAtLine(lineStart),
      }
      break
    }
    quoteCache.set(key, hit)
    return hit
  }

  return {
    kind,
    path,
    paper,
    title: title || firstHeading(rawText) || (path ? path.split('/').at(-1) : paper) || 'Manuscript',
    format,
    rawText,
    text: searchText,
    sha256: sha256(rawText),
    chars: rawText.length,
    lineCount: starts.length,
    lineStarts: starts,
    sections,
    units,
    notes,
    truncated,
    sectionAt,
    unitAtLine,
    locateQuote: locate,
    quoteMatches: (quote) => Boolean(locate(quote)),
  }
}

async function readTextFile(cwd, manuscript, deps = {}) {
  const target = resolveWorkspacePath(cwd, manuscript)
  if (!existsSync(target)) throw new Error(`file not found: ${manuscript}`)
  const stat = statSync(target)
  if (!stat.isFile()) throw new Error(`not a file: ${manuscript}`)
  if (stat.size > MAX_SOURCE_BYTES) throw new Error(`file is larger than ${MAX_SOURCE_BYTES / (1024 * 1024)}MB: ${manuscript}`)
  const ext = extname(target).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`unsupported manuscript type ${ext || '(none)'}; use .tex, .md, .txt, .docx, or .pdf`)
  }
  if (ext === '.docx') {
    const helper = deps.runHelper || runHelper
    const result = helper('reporting_text.py', { path: target })
    if (result?.error) throw new Error(result.error)
    if (typeof result?.text !== 'string') throw new Error('docx parser returned no text')
    return {
      rawText: result.text,
      format: 'docx',
      notes: ['DOCX text is extracted at paragraph level; line numbers refer to the extracted text, not Word pages.'],
    }
  }
  if (ext === '.pdf') {
    const convert = deps.convertPdf || convertPdfMarkdown
    const result = await convert(readFileSync(target), {})
    if (!result?.success) throw new Error(result?.error || 'PDF conversion failed')
    const notes = []
    if (result.pdf_type) notes.push(`PDF classified as ${result.pdf_type}.`)
    if (result.pages_needing_ocr?.length) {
      notes.push(`${result.pages_needing_ocr.length} page(s) were flagged for OCR; text from those pages may be missing. See pdf_to_markdown for OCR.`)
    }
    return {
      rawText: result.markdown || '',
      format: 'pdf',
      notes,
    }
  }
  const rawText = readFileSync(target, 'utf8')
  const format = ext === '.tex' ? 'latex' : ext === '.md' || ext === '.markdown' ? 'markdown' : 'text'
  return { rawText, format, notes: [] }
}

async function fileSource(cwd, manuscript, { title = null, deps = {} } = {}) {
  const loaded = await readTextFile(cwd, manuscript, deps)
  const searchText = loaded.format === 'latex' ? maskLatex(loaded.rawText) : loaded.rawText
  return buildSource({
    rawText: loaded.rawText,
    searchText,
    kind: 'file',
    path: manuscript,
    title,
    format: loaded.format,
    notes: loaded.notes,
  })
}

/* -------------------------------------------------------------- papermemory */

function mcpText(result) {
  const part = result?.content?.find((item) => item?.type === 'text')
  if (!part?.text) throw new Error('PaperMemory returned no text content')
  try {
    return JSON.parse(part.text)
  } catch {
    throw new Error('PaperMemory returned output that is not JSON')
  }
}

function paperMemoryCall(launch, name, args, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(launch.command, [...(launch.args || []), 'mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: papermemoryEnv(),
    })
    let buffer = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => finish(new Error(`PaperMemory did not answer within ${timeoutMs}ms`)), timeoutMs)

    function finish(error, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGTERM')
      if (error) reject(error)
      else resolvePromise(value)
    }

    function send(message) {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`)
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.id === 1 && message.result) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })
        } else if (message.id === 2) {
          if (message.error) finish(new Error(message.error.message || 'PaperMemory tool call failed'))
          else finish(null, message.result)
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => finish(new Error(`PaperMemory failed to start: ${error.message}`)))
    child.on('exit', (code) => {
      if (!settled) finish(new Error(`PaperMemory exited ${code}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`))
    })
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'academic-harness-reporting-check', version: '0.29.0' },
      },
    })
  })
}

async function memorySource(paper, { deps = {} } = {}) {
  const fetch = deps.getMemoryText || (async (ref) => {
    const launch = resolvePaperMemoryLaunch()
    if (!launch) throw new Error('PaperMemory is not installed; pass a workspace manuscript path instead')
    const result = await paperMemoryCall(launch, 'papermemory_get', { key: ref, max_chars: 40_000_000 })
    if (result?.isError) {
      const detail = mcpText(result)
      throw new Error(`PaperMemory: ${detail.error || detail.code || 'lookup failed'}`)
    }
    return mcpText(result)
  })
  const payload = await fetch(paper)
  const chunks = Array.isArray(payload?.chunks) ? payload.chunks : []
  if (!chunks.length) throw new Error(`PaperMemory paper "${paper}" has no stored text chunks to check`)
  const parts = []
  for (const chunk of chunks) {
    if (typeof chunk.text === 'string' && chunk.text) parts.push(chunk.text)
  }
  if (!parts.length) throw new Error(`PaperMemory paper "${paper}" has empty chunks`)
  const assembled = parts.join('\n\n')
  return buildSource({
    rawText: assembled,
    searchText: assembled,
    kind: 'papermemory',
    paper,
    title: payload?.paper?.title || null,
    format: 'markdown',
    truncated: Boolean(payload?.truncated),
    notes: [
      'Text comes from PaperMemory indexed chunks, not an original file; line numbers refer to the assembled chunks.',
      ...(payload?.truncated ? ['PaperMemory truncated the stored text; items may appear absent only because the tail was not loaded.'] : []),
    ],
  })
}

async function loadSourceForCheck(check, cwd, deps = {}) {
  if (check.manuscript.kind === 'file') {
    return fileSource(cwd, check.manuscript.path, { title: check.manuscript.title, deps })
  }
  return memorySource(check.manuscript.paper, { deps })
}

/* -------------------------------------------------------------- candidates */

function settlePassages(text, starts, extraCuts = []) {
  const passages = []
  const push = (start, end) => {
    let from = start
    let to = end
    while (from < to && /\s/.test(text[from])) from += 1
    while (to > from && /\s/.test(text[to - 1])) to -= 1
    if (to - from < 20) return
    const body = text.slice(from, to)
    if (!/[A-Za-z]/.test(body)) return
    if (/^#{1,6}\s/.test(body.trim()) && body.trim().length < 120) return
    if (/^\s*%%\s*@unit\b/.test(body.trim()) && body.trim().split('\n').length === 1) return
    if (to - from > 1800) {
      let cursor = from
      while (cursor < to) {
        let stop = Math.min(cursor + 1400, to)
        if (stop < to) {
          const window = text.slice(cursor + 500, stop)
          const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'))
          if (cut > 0) stop = cursor + 500 + cut + 1
        }
        push(cursor, stop)
        cursor = stop
      }
      return
    }
    passages.push({ start: from, end: to, line_start: lineAt(starts, from), line_end: lineAt(starts, Math.max(from, to - 1)) })
  }
  const cuts = new Set([0, text.length, ...extraCuts.filter((value) => value >= 0 && value <= text.length)])
  const pattern = /\n\s*\n+/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    cuts.add(match.index)
    cuts.add(match.index + match[0].length)
  }
  const ordered = [...cuts].sort((a, b) => a - b)
  for (let i = 0; i < ordered.length - 1; i += 1) push(ordered[i], ordered[i + 1])
  return passages
}

function tokenize(value) {
  return String(value ?? '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []
}

function cuePattern(cue) {
  if (/[\\^$.*+?()[\]{}|]/.test(cue)) {
    try {
      return { regex: new RegExp(cue, 'gi'), label: cue }
    } catch {
      return { terms: tokenize(cue), label: cue }
    }
  }
  return { terms: tokenize(cue), label: cue }
}

export function rankPassages(source, item, { limit = 8 } = {}) {
  const passages = settlePassages(source.text, source.lineStarts, source.sections.map((section) => section.start)).map((passage) => ({
    ...passage,
    text: source.text.slice(passage.start, passage.end),
    raw: source.rawText.slice(passage.start, passage.end),
    section: source.sectionAt(passage.start),
    unit: source.unitAtLine(passage.line_start),
    tokens: tokenize(source.text.slice(passage.start, passage.end)),
  }))
  if (!passages.length) return []
  const documentFreq = new Map()
  for (const passage of passages) {
    for (const term of new Set(passage.tokens)) documentFreq.set(term, (documentFreq.get(term) || 0) + 1)
  }
  const avgLength = passages.reduce((sum, passage) => sum + passage.tokens.length, 0) / passages.length || 1
  const cues = (item.cues || []).map(cuePattern)
  const scored = []
  for (const passage of passages) {
    const termCounts = new Map()
    for (const term of passage.tokens) termCounts.set(term, (termCounts.get(term) || 0) + 1)
    let score = 0
    const matched = []
    for (const cue of cues) {
      if (cue.regex) {
        const found = passage.text.match(cue.regex)
        if (found?.length) {
          score += 4 + Math.min(found.length, 4) * 2
          matched.push(cue.label)
        }
        continue
      }
      let cueScore = 0
      for (const term of cue.terms) {
        const tf = termCounts.get(term) || 0
        if (!tf) continue
        const df = documentFreq.get(term) || 1
        const idf = Math.log(1 + (passages.length - df + 0.5) / (df + 0.5))
        cueScore += idf * (tf * 2.2) / (tf + 1.2 * (1 - 0.75 + 0.75 * passage.tokens.length / avgLength))
      }
      if (cueScore > 0) {
        score += cueScore
        matched.push(cue.label)
      }
    }
    if (item.section && passage.section) {
      const a = item.section.toLowerCase()
      const b = passage.section.toLowerCase()
      if (a === b || b.includes(a) || a.includes(b)) score += 3
    }
    if (score > 0 && matched.length) {
      scored.push({
        score: Number(score.toFixed(3)),
        section: passage.section,
        unit: passage.unit,
        line_start: passage.line_start,
        line_end: passage.line_end,
        offset: passage.start,
        matched_cues: [...new Set(matched)],
        excerpt: passage.text.replace(/\s+/g, ' ').trim().slice(0, 420),
      })
    }
  }
  return scored.sort((a, b) => b.score - a.score || a.offset - b.offset).slice(0, Math.min(Math.max(limit, 1), 25))
}

/* ----------------------------------------------------------------- suggest */

function countPattern(textValue, pattern) {
  const matches = textValue.match(pattern)
  return matches ? matches.length : 0
}

export function suggestGuidelines(source) {
  const haystack = source.text.toLowerCase()
  const suggestions = []
  const byId = new Map(loadGuidelines().map((checklist) => [checklist.id, checklist]))
  for (const design of DESIGN_CUES) {
    const checklist = byId.get(design.id)
    if (!checklist) continue
    let score = 0
    const terms = []
    for (const [pattern, weight] of design.patterns) {
      const count = countPattern(haystack, pattern)
      if (!count) continue
      score += weight * Math.min(count, 3)
      terms.push({ term: pattern.source, count })
    }
    if (score > 0) {
      suggestions.push({
        ...guidelineInfo(checklist),
        score,
        matching_terms: terms.sort((a, b) => b.count - a.count),
        reason: `matched ${terms.map((entry) => `${entry.term}×${entry.count}`).join(', ')}`,
      })
    }
  }
  const has = (id) => suggestions.some((entry) => entry.id === id)
  if (has('prisma') && byId.has('prisma-s')) {
    const companion = suggestions.find((entry) => entry.id === 'prisma')
    suggestions.push({
      ...guidelineInfo(byId.get('prisma-s')),
      score: Math.max(1, Math.round(companion.score / 3)),
      matching_terms: companion.matching_terms.filter((entry) => /search|database|record/i.test(entry.term)),
      reason: 'companion search-reporting extension for a systematic review',
    })
  }
  if (has('prisma-scr') && byId.has('prisma')) {
    const scoping = suggestions.find((entry) => entry.id === 'prisma-scr')
    const base = suggestions.find((entry) => entry.id === 'prisma')
    if (base) base.score = Math.max(1, base.score - scoping.score)
  }
  return {
    suggestions: suggestions.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)),
    note: suggestions.length
      ? 'These are candidates from study-design cues. No guideline was selected; choose one explicitly before starting a check.'
      : 'No guideline cues matched. Choose a guideline explicitly or ask the user which one applies.',
  }
}

/* ------------------------------------------------------------------- render */

function renderList(value) {
  const lines = [`Reporting guidelines (${value.guidelines.length})`]
  for (const guideline of value.guidelines) {
    const designs = guideline.study_designs.length ? ` — ${guideline.study_designs.join(', ')}` : ''
    lines.push(`- ${guideline.name} (${guideline.id}@${guideline.version}): ${guideline.item_count} items${designs}`)
    lines.push(`  ${guideline.source_url}`)
  }
  lines.push('', 'Use `start` with `guideline`, `slug`, and `manuscript` (or `paper` for a PaperMemory paper).')
  return lines.join('\n')
}

function renderSuggest(value) {
  if (!value.suggestions.length) return value.note
  const lines = ['Candidate reporting guidelines (none selected):']
  for (const entry of value.suggestions) {
    lines.push(`- ${entry.name} @ ${entry.version} — score ${entry.score}; ${entry.reason}`)
  }
  lines.push('', value.note)
  return lines.join('\n')
}

function renderStart(value) {
  const check = value.check
  const lines = [
    value.resumed
      ? `Reporting check "${value.slug}" resumed: ${check.guideline.name}, ${check.guideline.item_count} items.`
      : `Reporting check "${value.slug}" started: ${check.guideline.name}, ${check.guideline.item_count} items.`,
    `Manuscript: ${check.manuscript.path || check.manuscript.paper || check.manuscript.title} (${check.manuscript.kind}, sha256 ${check.manuscript.sha256.slice(0, 12)}…)`,
  ]
  for (const note of check.manuscript.notes || []) lines.push(`Note: ${note}`)
  lines.push('Next: ask for `items`, then `candidates` + `judge` item by item. Exports carry evidence, never a compliance verdict.')
  return lines.join('\n')
}

function renderItems(value) {
  const lines = [
    `Reporting check "${value.slug}" — ${value.guideline.name} (${value.total} items; filter: ${value.filter})`,
    `${value.verified_evidence} of ${value.total} items have verified evidence · unassessed ${value.counts.unassessed} · stale ${value.stale}`,
  ]
  if (value.source_warning) lines.push(`Warning: ${value.source_warning}`)
  if (!value.items.length) lines.push('', 'No items match this filter.')
  for (const item of value.items) {
    const flags = []
    if (item.stale) flags.push('stale')
    if (item.evidence_mismatch) flags.push('evidence not found')
    lines.push('', `${item.item_id} [${item.section}] ${item.verdict}${flags.length ? ` (${flags.join(', ')})` : ''}`)
    lines.push(`  ${item.short_prompt}`)
    if (item.evidence) lines.push(`  Evidence: "${item.evidence.quote}" — ${item.evidence.location}`)
    if (item.verdict === 'not_reported' && item.searched.length) lines.push(`  Searched: ${item.searched.join(', ')}`)
    if (item.reason) lines.push(`  Reason: ${item.reason}`)
  }
  return lines.join('\n')
}

function renderCandidates(value) {
  const lines = [
    `Candidates for ${value.item} — ${value.short_prompt}`,
    `Manuscript: ${value.manuscript}`,
  ]
  if (value.note) lines.push(value.note)
  for (const passage of value.passages) {
    lines.push('', `- score ${passage.score} · ${passage.section}, lines ${passage.line_start}–${passage.line_end}${passage.unit ? ` · unit ${passage.unit}` : ''}`)
    lines.push(`  ${passage.excerpt}`)
    if (passage.matched_cues.length) lines.push(`  cues: ${passage.matched_cues.join(', ')}`)
  }
  return lines.join('\n')
}

function renderJudge(value) {
  const event = value.event
  const lines = [`${event.item_id} recorded as ${event.verdict}.`]
  if (event.evidence) lines.push(`Verified quote at ${event.evidence.location}: "${event.evidence.quote}"`)
  if (event.verdict === 'not_reported') lines.push(`Searched: ${event.searched.join(', ')} (advisory; recheck if the manuscript changes).`)
  if (event.reason) lines.push(`Reason: ${event.reason}`)
  if (event.override) lines.push(`Override; the previous verdict ${event.supersedes} is kept in the log.`)
  return lines.join('\n')
}

function renderStatus(value) {
  const status = value.status
  const lines = [
    `Reporting check "${status.slug}" — ${status.guideline.name}`,
    `Manuscript: ${status.manuscript.path || status.manuscript.paper || status.manuscript.title} · snapshot ${status.manuscript.sha256.slice(0, 12)}…`,
    '',
    `Reported ${status.counts.reported} · Partial ${status.counts.partial} · Not reported ${status.counts.not_reported} · Not applicable ${status.counts.not_applicable} · Unassessed ${status.counts.unassessed}`,
    `${status.verified_evidence} of ${status.total} items have verified evidence. Stale: ${status.stale}. Evidence no longer found: ${status.evidence_mismatch}.`,
  ]
  if (status.manuscript.source_changed) lines.push('The manuscript has changed since the snapshot; status re-verifies quotes against the current text.')
  if (value.source_warning) lines.push(`Warning: ${value.source_warning}`)
  const unassessed = status.items.filter((item) => item.verdict === 'unassessed').map((item) => item.item_id)
  if (unassessed.length) lines.push('', `Unassessed: ${unassessed.slice(0, 30).join(', ')}${unassessed.length > 30 ? ` … (+${unassessed.length - 30})` : ''}`)
  const failing = status.items.filter((item) => item.verdict === 'partial' || item.verdict === 'not_reported' || item.stale || item.evidence_mismatch)
  if (failing.length) {
    lines.push('', 'Needs attention:')
    for (const item of failing) {
      const flags = []
      if (item.stale) flags.push('stale')
      if (item.evidence_mismatch) flags.push('quote not found')
      lines.push(`- ${item.item_id} (${item.verdict}${flags.length ? `; ${flags.join(', ')}` : ''})${item.reason ? ` — ${item.reason}` : ''}`)
    }
  }
  return lines.join('\n')
}

function renderExport(value) {
  return [
    `Wrote ${value.path} (${value.bytes} bytes).`,
    `${value.summary.verified_evidence} of ${value.summary.total} items have verified evidence; ${value.summary.unassessed} unassessed; ${value.summary.stale} stale.`,
    'The export records evidence and counts; it does not contain a compliance verdict.',
  ].join('\n')
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (value.action === 'list') return [{ type: 'text', text: renderList(value) }]
  if (value.action === 'suggest') return [{ type: 'text', text: renderSuggest(value) }]
  if (value.action === 'start') return [{ type: 'text', text: renderStart(value) }]
  if (value.action === 'items') return [{ type: 'text', text: renderItems(value) }]
  if (value.action === 'candidates') return [{ type: 'text', text: renderCandidates(value) }]
  if (value.action === 'judge') return [{ type: 'text', text: renderJudge(value) }]
  if (value.action === 'status') return [{ type: 'text', text: renderStatus(value) }]
  return [{ type: 'text', text: renderExport(value) }]
}

/* -------------------------------------------------------------------- tool */

function logNote(exec, { type = 'note', title, body, tags = [] }) {
  try {
    const file = notebookFile(exec)
    const entry = {
      id: `reporting-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      type,
      title,
      ...(body ? { body } : {}),
      ...(tags.length ? { tags } : {}),
    }
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(entry)}\n`)
  } catch {
    // The notebook is a convenience, never a reason to fail a check.
  }
}

function loadChecklistForCheck(check) {
  const checklist = resolveChecklist(check.guideline.id, check.guideline.version)
  const ids = checklist.items.map((item) => item.id)
  if (JSON.stringify(ids) !== JSON.stringify(check.item_ids)) {
    throw new Error(`the ${check.guideline.name} checklist data changed since this check started; start a new check instead of judging against different items`)
  }
  return checklist
}

function sourceManuscript(source) {
  return source.kind === 'file'
    ? { kind: 'file', path: source.path, paper: null, title: source.title, format: source.format, sha256: source.sha256, chars: source.chars, lines: source.lineCount, truncated: source.truncated, notes: source.notes }
    : { kind: 'papermemory', path: null, paper: source.paper, title: source.title, format: source.format, sha256: source.sha256, chars: source.chars, lines: source.lineCount, truncated: source.truncated, notes: source.notes }
}

async function currentSource(check, cwd, deps) {
  try {
    return { source: await loadSourceForCheck(check, cwd, deps), warning: null }
  } catch (error) {
    return { source: null, warning: `could not re-read the manuscript (${error instanceof Error ? error.message : String(error)})` }
  }
}

export async function runReportingCheck(args, exec, deps = {}) {
  const action = args.action || 'status'
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)

  if (action === 'list') {
    const guidelines = loadGuidelines().map(guidelineInfo)
    return { action, guidelines, count: guidelines.length }
  }

  if (action === 'suggest') {
    let source
    if (typeof args.text === 'string' && args.text.trim()) {
      source = buildSource({ rawText: args.text, searchText: args.text, kind: 'inline', format: 'text', title: 'Inline text' })
    } else if (args.paper) {
      source = await memorySource(String(args.paper).trim(), { deps })
    } else if (args.manuscript) {
      source = await fileSource(cwd, String(args.manuscript).trim(), { title: args.title, deps })
    } else {
      throw new Error('suggest needs a manuscript path, a PaperMemory paper, or inline text')
    }
    const suggested = suggestGuidelines(source)
    return { action, manuscript: source.path || source.paper || '(inline text)', ...suggested }
  }

  const slug = text(args.slug)
  if (!slug) throw new Error(`${action} needs a slug`)

  if (action === 'start') {
    if (args.resume && !args.manuscript && !args.paper) {
      const existing = readCheck(cwd, slug)
      const existingChecklist = loadChecklistForCheck(existing)
      const resumed = await startCheck({
        cwd,
        slug,
        guideline: existingChecklist,
        manuscript: null,
        itemIds: existing.item_ids,
        resume: true,
      })
      return { action, ...resumed }
    }
    const checklist = resolveChecklist(args.guideline, args.version)
    let source
    if (args.paper) source = await memorySource(String(args.paper).trim(), { deps })
    else if (args.manuscript) source = await fileSource(cwd, String(args.manuscript).trim(), { title: args.title, deps })
    else throw new Error('start needs a manuscript path or a PaperMemory paper')
    const started = await startCheck({
      cwd,
      slug,
      guideline: checklist,
      manuscript: sourceManuscript(source),
      itemIds: checklist.items.map((item) => item.id),
      resume: Boolean(args.resume),
    })
    if (!started.resumed) {
      logNote(exec, {
        type: 'method',
        title: `Reporting check started: ${checklist.name} on ${source.title}`,
        body: `Ledger: .dsh/reporting/${reportingSlug(slug)}/. ${checklist.items.length} items; ${source.kind} source; snapshot ${source.sha256}.`,
        tags: ['reporting-check'],
      })
    }
    return { action, ...started }
  }

  const check = readCheck(cwd, slug)
  const checklist = loadChecklistForCheck(check)
  const { source, warning } = await currentSource(check, cwd, deps)

  if (action === 'items') {
    const filter = args.filter || 'all'
    if (!FILTERS.includes(filter)) throw new Error(`filter must be one of ${FILTERS.join(', ')}`)
    const status = deriveStatus({ cwd, slug, checklist, source })
    let items = status.items
    if (filter === 'unassessed') items = items.filter((item) => item.verdict === 'unassessed')
    else if (filter === 'assessed') items = items.filter((item) => item.verdict !== 'unassessed')
    else if (filter === 'failing') items = items.filter((item) => item.verdict === 'partial' || item.verdict === 'not_reported')
    else if (filter === 'stale') items = items.filter((item) => item.stale)
    else if (VERDICTS.includes(filter)) items = items.filter((item) => item.verdict === filter)
    return {
      action,
      slug: status.slug,
      guideline: status.guideline,
      total: status.total,
      filter,
      counts: status.counts,
      verified_evidence: status.verified_evidence,
      stale: status.stale,
      source_warning: warning,
      items,
    }
  }

  if (action === 'candidates') {
    if (!source) throw new Error(warning)
    const itemId = text(args.item)
    const item = checklist.items.find((entry) => entry.id === itemId)
    if (!item) throw new Error(`item "${itemId}" is not in ${check.guideline.name}; use action "items" to list item ids`)
    const passages = rankPassages(source, item, { limit: Number(args.limit) || 8 })
    return {
      action,
      item: item.id,
      short_prompt: item.short_prompt,
      section: item.section,
      manuscript: source.path || source.paper || source.title,
      passages,
      ...(passages.length ? {} : { note: 'No passage matched this item\'s cue terms. A not_reported verdict still needs the searched terms recorded.' }),
    }
  }

  if (action === 'judge') {
    if (!source) throw new Error(warning)
    const itemId = text(args.item)
    const item = checklist.items.find((entry) => entry.id === itemId)
    if (!item) throw new Error(`item "${itemId}" is not in ${check.guideline.name}; use action "items" to list item ids`)
    const verdict = args.verdict
    if (!VERDICTS.includes(verdict)) throw new Error(`verdict must be one of ${VERDICTS.join(', ')}`)
    let evidence = null
    if (EVIDENCE_VERDICTS.has(verdict)) {
      const located = source.locateQuote(args.quote)
      if (!located) {
        return {
          error: `the evidence quote was not found in the manuscript after whitespace normalisation. Copy a verbatim passage from the manuscript; a quote that does not appear is rejected and not stored.`,
        }
      }
      const derived = [
        located.section || 'Document',
        located.line_start === located.line_end ? `line ${located.line_start}` : `lines ${located.line_start}-${located.line_end}`,
      ].join(', ')
      evidence = {
        quote: String(args.quote ?? '').trim(),
        section: located.section,
        location: text(args.location) || `${derived}${located.unit ? ` (${located.unit})` : ''}`,
        line_start: located.line_start,
        line_end: located.line_end,
        unit: located.unit,
      }
    }
    const event = await recordVerdict({
      cwd,
      slug,
      itemId,
      verdict,
      evidence,
      searched: args.searched,
      reason: args.reason,
      reviewer: args.reviewer,
      override: Boolean(args.override),
    })
    return { action, item: item.id, short_prompt: item.short_prompt, event }
  }

  if (action === 'status') {
    const status = deriveStatus({ cwd, slug, checklist, source })
    return { action, status, source_warning: warning }
  }

  const status = deriveStatus({ cwd, slug, checklist, source })
  const exported = exportCheck({
    cwd, slug, check, status, format: args.format || 'markdown', overwrite: Boolean(args.overwrite),
  })
  logNote(exec, {
    type: 'observation',
    title: `Reporting check exported: ${check.guideline.name} on ${check.manuscript.title || check.manuscript.path}`,
    body: `${exported.path}; ${status.verified_evidence} of ${status.total} items have verified evidence; ${status.counts.unassessed} unassessed; ${status.stale} stale. This is evidence, not a compliance verdict.`,
    tags: ['reporting-check'],
  })
  return { action, ...exported, source_warning: warning }
}

export const name = 'academic-harness-reporting-check'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'reporting_check',
    description: [
      'Check a manuscript against a reporting guideline (CONSORT, STROBE, PRISMA 2020/PRISMA-S/PRISMA-ScR, ARRIVE 2.0, TRIPOD+AI, CARE, STARD) in an auditable ledger under `.dsh/reporting/<slug>/`.',
      'Actions: `list` (guidelines and item counts), `suggest` (candidate guidelines from study-design cues; never selects one), `start` (open a check for a workspace manuscript or PaperMemory paper; snapshots its hash), `items` (checklist with current status), `candidates` (ranked passages for one item from section heuristics and its cue terms), `judge` (record reported/partial/not_reported/not_applicable with evidence), `status` (counts, unassessed, stale evidence), `export` (markdown, csv, or a LaTeX table).',
      'Evidence rules: reported and partial require a verbatim quote that the tool re-finds in the manuscript; not_reported is an advisory claim of absence and must list the searched terms or sections; not_applicable needs a reason. Editing the manuscript re-verifies dependent verdicts on `status` and marks quotes that no longer match stale. Exports report how many items have verified evidence and never say a manuscript is compliant. The agent proposes and the tool verifies; the author decides.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'list, suggest, start, items, candidates, judge, status, or export. Default status.',
      },
      slug: { type: 'string', description: 'Check slug (stable short name; letters, digits, dashes). Required except for list/suggest.' },
      guideline: { type: 'string', description: 'Guideline id or alias, e.g. consort, strobe, prisma, prisma-s, prisma-scr, arrive, tripod-ai, care, stard (start).' },
      version: { type: 'string', description: 'Checklist version when a guideline has more than one (start).' },
      manuscript: { type: 'string', description: 'Workspace-relative manuscript path (.tex, .md, .txt, .docx, .pdf) (start/suggest).' },
      paper: { type: 'string', description: 'PaperMemory paper id or key; its stored text is snapshotted (start/suggest).' },
      text: { type: 'string', description: 'Inline text for suggest only.' },
      title: { type: 'string', description: 'Optional display title for the manuscript (start/suggest).' },
      resume: { type: 'boolean', description: 'Continue an existing check instead of failing (start).' },
      item: { type: 'string', description: 'Checklist item id such as 1a or 13c (candidates/judge).' },
      filter: {
        type: 'string',
        enum: FILTERS,
        description: 'Which items to return: all (default), unassessed, assessed, failing, stale, or one verdict.',
      },
      limit: { type: 'number', description: 'Maximum candidate passages (candidates). Default 8, maximum 25.' },
      verdict: {
        type: 'string',
        enum: VERDICTS,
        description: 'reported, partial, not_reported, or not_applicable (judge).',
      },
      quote: { type: 'string', description: 'Verbatim evidence quote (judge; required for reported/partial).' },
      location: { type: 'string', description: 'Optional human-readable location label; line and section are derived from the quote.' },
      searched: {
        type: 'array',
        items: { type: 'string' },
        description: 'Terms or sections searched (judge; required for not_reported).',
      },
      reason: { type: 'string', description: 'Reason for not_applicable, or for overriding an earlier verdict (judge).' },
      reviewer: { type: 'string', description: 'Reviewer or agent identity (judge). Optional.' },
      override: { type: 'boolean', description: 'Replace an earlier verdict for the same item; both events are kept and a reason is required (judge).' },
      format: {
        type: 'string',
        enum: ['markdown', 'csv', 'latex'],
        description: 'Export format (export). Default markdown.',
      },
      overwrite: { type: 'boolean', description: 'Replace an existing export file (export). Default false.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      try {
        return await runReportingCheck(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      const suffix = args.slug ? `: ${args.slug}` : ''
      return { card: 'generic', title: `Reporting check${suffix} (${args.action || 'status'})`, kind: 'other' }
    },
  }))
}
