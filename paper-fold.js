/**
 * paper_fold: map-first reading for the Academic Harness preset.
 *
 * One `textfold get --json` call returns the whole document; this module
 * validates language/provenance and renders the requested view. It never asks
 * TextFold for a second Markdown pass, so a bad section, a silent language
 * fallback, or a local-level response cannot masquerade as something else.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  LOG,
  TEXTFOLD_VERSION,
  ensureTextfoldInstalled,
  lastLine,
  runTextfold,
  textfoldStatus,
} from './textfold-runtime.js'

const ACTIONS = ['map', 'section', 'doc', 'export', 'status']
const DOC_LEVELS = ['topic', 'takeaway', 'key', 'brief', 'full']
const FILE_EXT = /\.(?:pdf|md|markdown|txt|docx?|pptx?|xlsx?|epub|html?|csv|png|jpe?g|tiff?|webp)$/i
const IMPORTED_ID = /^(?:md-[a-z0-9]+(?:-[a-z0-9]+)*|pmc\d{4,9}|ppr\d{4,9}|(?:biorxiv|medrxiv)-[0-9.]{3,40}|wiki-[a-z][a-z-]{1,15}-\d{1,10}|gh-[a-z0-9-]{1,39}--[a-z0-9._-]{1,100}|(?:pdf|doc)-[0-9a-f]{16}|web-[a-z0-9-]{1,40}-[0-9a-f]{12})$/i
const BARE_URL = /^(?:[a-z0-9-]+\.)+[a-z]{2,}\//i

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

export function resolveWorkspacePath(cwd, path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('a workspace path is required')
  const root = resolve(cwd)
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes the workspace: ${path}`)
  return target
}

/** Write one file inside the workspace, refusing textual and symlink escapes. */
export function writeWorkspaceFile(cwd, path, data) {
  let target
  try {
    target = resolveWorkspacePath(cwd, path)
    const realRoot = realpathSync(resolve(cwd))
    let existing = dirname(target)
    while (!existsSync(existing)) {
      const parent = dirname(existing)
      if (parent === existing) break
      existing = parent
    }
    const existingRel = relative(realRoot, realpathSync(existing))
    if (existingRel.startsWith('..') || isAbsolute(existingRel)) throw new Error(`path escapes the workspace: ${path}`)
    mkdirSync(dirname(target), { recursive: true })
    const parentRel = relative(realRoot, realpathSync(dirname(target)))
    if (parentRel.startsWith('..') || isAbsolute(parentRel)) throw new Error(`path escapes the workspace: ${path}`)
    if (existsSync(target)) {
      const targetRel = relative(realRoot, realpathSync(target))
      if (targetRel.startsWith('..') || isAbsolute(targetRel)) throw new Error(`path escapes the workspace: ${path}`)
    }
    writeFileSync(target, data, 'utf8')
    return { ok: true, path }
  } catch (error) {
    const code = /escapes the workspace/.test(error.message) ? 'path-escapes-workspace' : 'write-failed'
    return { ok: false, error_code: code, error: code === 'write-failed' ? `could not write ${path}: ${error.message}` : error.message }
  }
}

function isIdentifier(value) {
  return /^https?:\/\//i.test(value)
    || /^10\.\d{4,9}\/\S+$/i.test(value)
    || /^(?:arxiv:)?\d{4}\.\d{4,5}(v\d+)?$/i.test(value)
    || IMPORTED_ID.test(value)
}

/**
 * A URL or paper identifier passes through; a workspace file becomes its real
 * path. A bare id with no matching source goes to TextFold so its own error is
 * returned instead of a misleading "file not found".
 */
export function resolveRef(ref, cwd = process.cwd()) {
  const value = String(ref ?? '').trim()
  if (!value) return { ok: false, error_code: 'bad-ref', error: 'ref is required' }
  if (isIdentifier(value)) return { ok: true, value }
  if (BARE_URL.test(value)) return { ok: true, value: `https://${value}` }

  const candidate = isAbsolute(value) ? resolve(value) : resolve(cwd, value)
  const looksPath = isAbsolute(value) || /[\\/]/.test(value) || FILE_EXT.test(value) || existsSync(candidate)
  if (!looksPath) return { ok: true, value }

  let target
  try {
    target = resolveWorkspacePath(cwd, value)
  } catch (error) {
    return { ok: false, error_code: 'path-escapes-workspace', error: error.message }
  }
  if (!existsSync(target)) return { ok: false, error_code: 'bad-ref', error: `file not found in the workspace: ${value}` }
  const real = realpathSync(target)
  const rel = relative(realpathSync(resolve(cwd)), real)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error_code: 'path-escapes-workspace', error: `file resolves outside the workspace: ${value}` }
  }
  return { ok: true, value: real }
}

export function buildTextfoldArgs({ action = 'map', ref, lang = 'en', generate = false } = {}) {
  if (action === 'status') return ['--version']
  return ['get', ref, '--json', '--lang', lang, ...(generate ? [] : ['--no-generate'])]
}

const unique = (items) => {
  const seen = new Set()
  return items.filter((value) => {
    if (!value) return false
    const key = value.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function decorate(unit, text) {
  if (!text) return ''
  if (unit.kind === 'list item') return `- ${text}`
  if (unit.kind === 'caption') return `*${text}*`
  return text
}

function unitText(unit, level) {
  if (level === 'full') return decorate(unit, unit.full || '')
  if (level === 'brief') return decorate(unit, (Array.isArray(unit.brief) ? unit.brief : []).join(' … '))
  if (level === 'key') return decorate(unit, unit.key || '')
  return ''
}

function findSection(sections, which) {
  const value = String(which ?? '').trim()
  if (!value) return null
  const direct = sections.find((section) => section.id === value || section.num === value)
  if (direct) return direct
  if (/^\d+$/.test(value)) return sections[Number(value) - 1] ?? null
  return null
}

function provenanceNote(doc) {
  const provenance = doc.provenance || {}
  if (provenance.ai_generated) {
    return `Written by ${provenance.model || 'a model'}; each line rests on the sentences marked in the full text.`
  }
  if (provenance.local) return "The author's own first sentences (no model); this map is not evidence for a claim."
  return "The author's own words."
}

function renderSection(section, level) {
  const depth = Number.isFinite(Number(section.depth)) ? Math.max(1, Number(section.depth)) : 1
  const hashes = '#'.repeat(Math.min(6, 1 + depth))
  const head = [section.num, section.title].filter(Boolean).join(' ').trim() || '(untitled)'
  const out = [`${hashes} ${head}  \`[${section.id || '?'}]\``]
  const units = Array.isArray(section.units) ? section.units : []

  if (level === 'topic') {
    const sectionTopic = (section.topic || section.takeaway || '').trim()
    if (sectionTopic) out.push(`**${sectionTopic}**`)
    const topics = unique(units.map((unit) => (unit.topic || '').trim()))
      .filter((topic) => topic.toLowerCase() !== sectionTopic.toLowerCase())
    if (topics.length) out.push(topics.join('; '))
    return out.join('\n')
  }

  if (level === 'takeaway') {
    if (section.takeaway) out.push(`**${section.takeaway}**`)
    for (const unit of units) {
      if (unit.takeaway) out.push(`- ${unit.takeaway}`)
    }
    return out.join('\n')
  }

  if (level === 'key' && section.takeaway) out.push('', `**${section.takeaway}**`)
  for (const unit of units) {
    const text = unitText(unit, level)
    if (!text) continue
    out.push('')
    out.push(text)
  }
  return out.join('\n')
}

/**
 * Render a textfold/doc to Markdown at one level. `section` is required for the
 * `section` action; `maxChars` truncates inline output at a line boundary.
 */
export function renderPaperView(doc, { action = 'map', level, section, maxChars = 12_000 } = {}) {
  const defaultLevel = action === 'map' ? 'takeaway' : action === 'section' ? 'key' : 'full'
  const chosen = String(level ?? defaultLevel).toLowerCase()
  if (!DOC_LEVELS.includes(chosen)) {
    return { ok: false, error_code: 'bad-level', error: `level is one of ${DOC_LEVELS.join(', ')}` }
  }
  const sections = Array.isArray(doc.sections) ? doc.sections : []
  let selected = sections
  let selectedOne = null
  if (action === 'section') {
    selectedOne = findSection(sections, section)
    if (!selectedOne) {
      return {
        ok: false,
        error_code: 'bad-section',
        error: `no section ${section}`,
        sections: sections.map((s) => ({ id: s.id, num: s.num, title: s.title })),
      }
    }
    selected = [selectedOne]
  }

  const out = [`# ${doc.title || 'Untitled'}`, '']
  const authors = Array.isArray(doc.authors) ? doc.authors : []
  const byline = [
    authors.length ? `${authors.slice(0, 4).join('; ')}${authors.length > 4 ? ' et al.' : ''}` : '',
    doc.source?.label || doc.source?.url || '',
    doc.date || '',
  ].filter(Boolean).join(' · ')
  if (byline) out.push(byline, '')
  out.push(`*Level: ${chosen}. ${provenanceNote(doc)}*`, '')

  for (const item of selected) {
    out.push(renderSection(item, chosen))
    out.push('')
  }

  const next = { topic: 'takeaway', takeaway: 'key', key: 'brief', brief: 'full' }[chosen]
  if (action !== 'export' && next) {
    out.push(action === 'section' && selectedOne
      ? `*Deeper: action=section level=${next} section=${selectedOne.id}.*`
      : `*Deeper: action=section level=${next} section=<id>.*`)
    out.push('')
  }

  let markdown = `${out.join('\n').trimEnd()}\n`
  let truncated = false
  if (Number.isFinite(maxChars) && maxChars > 0 && markdown.length > maxChars) {
    const cut = markdown.lastIndexOf('\n', maxChars)
    const head = markdown.slice(0, cut > 0 ? cut : maxChars).trimEnd()
    markdown = `${head}\n\n… [truncated; pass write_to or request one section]\n`
    truncated = true
  }
  return { ok: true, markdown, truncated, level: chosen, section: selectedOne?.id }
}

function failure(code, error, extra = {}) {
  return { ok: false, error_code: code, error, ...extra }
}

function processFailure(result) {
  if (result.error?.code === 'ENOENT') {
    return failure('textfold-missing', 'The TextFold command was not found. Set TEXTFOLD_PYTHON/TEXTFOLD_CLI.')
  }
  if (result.aborted) return failure('cancelled', 'TextFold was cancelled.')
  if (result.timedOut) return failure('timeout', 'TextFold did not finish in time.')
  if (result.tooLarge) return failure('too-large', 'TextFold output exceeded 64 MB; use pdf_to_markdown or a narrower source.')
  const detail = lastLine(result.stderr)
  if (!result.stdout.trim()) {
    if (/needs the PDF engine|PDF engine/i.test(detail)) {
      return failure('scanned-pdf', 'This PDF needs TextFold\'s PDF engine (MinerU, about 3.4 GB), which this plugin does not install. Use pdf_to_markdown for a text PDF; for a scan, use pdf_to_markdown\'s OCR path or subagent_vision.')
    }
    if (/no-html/i.test(detail)) return failure('no-html', 'TextFold found no readable HTML for this paper. Try its PDF with pdf_to_markdown, or another source.')
    if (/no-fulltext/i.test(detail)) return failure('no-fulltext', 'No open full text was found for this DOI. Use paper_download or the publisher page.')
    if (/no-article/i.test(detail)) return failure('no-article', 'No article was found at that link.')
    if (/No model/i.test(detail)) return failure('model-required', 'TextFold has no model provider. Configure one in TextFold, or use generate:false for local levels.')
    return failure('textfold-failed', detail || `TextFold exited ${result.code}`)
  }
  return null
}

/** The tool body without registration; `cwd` is the session workspace. */
export async function paperFold(args = {}, { cwd = process.cwd(), signal } = {}) {
  const action = String(args.action ?? 'map').toLowerCase()
  if (!ACTIONS.includes(action)) return failure('bad-action', `action is one of ${ACTIONS.join(', ')}`)

  if (action === 'status') {
    const status = await textfoldStatus()
    return { ok: true, action, ...status, textfold_version: status.version || TEXTFOLD_VERSION }
  }

  const resolved = resolveRef(args.ref, cwd)
  if (!resolved.ok) return resolved

  const generate = args.generate === true
  const lang = String(args.lang ?? 'en').trim().toLowerCase() || 'en'
  if (lang !== 'en' && !generate) {
    return failure('model-required', `translating to ${lang} needs a model. Use lang=en, or generate:true with a TextFold provider.`)
  }
  if (action === 'section' && !args.section) {
    return failure('bad-request', 'section is required for action=section (use an id from the map).')
  }
  if ((action === 'doc' || action === 'export') && !args.write_to) {
    return failure('bad-request', `action=${action} needs write_to (a workspace-relative path).`)
  }

  let launch
  try {
    launch = await ensureTextfoldInstalled()
  } catch (error) {
    return failure(error.code || 'textfold-missing', error.message)
  }

  const cliArgs = buildTextfoldArgs({ action, ref: resolved.value, lang, generate })
  const result = await runTextfold(launch, cliArgs, {
    cwd,
    signal,
    timeoutMs: generate ? 600_000 : 120_000,
  })
  const failed = processFailure(result)
  if (failed) return failed

  let doc
  try {
    doc = JSON.parse(result.stdout)
  } catch {
    return failure('bad-output', `TextFold did not return JSON. ${lastLine(result.stderr)}`.trim())
  }
  if (doc?.format !== 'textfold/doc' || !Array.isArray(doc.sections)) {
    return failure('bad-output', 'TextFold returned an unexpected JSON shape (expected textfold/doc with sections).')
  }
  if (generate && doc.provenance?.local) {
    return failure('model-required', 'TextFold returned local levels because no provider was found. Configure TextFold, or use generate:false.')
  }
  if (lang !== 'en' && doc.lang !== lang) {
    return failure('translation-unavailable', `Asked for ${lang}, but TextFold returned ${doc.lang || 'no language'}.`)
  }

  const base = {
    action,
    ref: args.ref,
    doc_id: doc.id,
    title: doc.title || '',
    lang: doc.lang || lang,
    generated: Boolean(doc.provenance?.ai_generated),
    textfold_version: launch.version || TEXTFOLD_VERSION,
    sections: doc.sections.length,
  }

  if (action === 'doc') {
    const written = writeWorkspaceFile(cwd, args.write_to, `${JSON.stringify(doc, null, 1)}\n`)
    if (!written.ok) return written
    return { ...base, ok: true, write_to: args.write_to }
  }

  const maxChars = action === 'export' || args.write_to
    ? Infinity
    : (Number.isFinite(Number(args.max_chars)) && Number(args.max_chars) > 0 ? Math.floor(Number(args.max_chars)) : 12_000)
  const view = renderPaperView(doc, { action, level: args.level, section: args.section, maxChars })
  if (!view.ok) return view

  if (args.write_to) {
    const written = writeWorkspaceFile(cwd, args.write_to, view.markdown)
    if (!written.ok) return written
    return { ...base, ok: true, level: view.level, write_to: args.write_to }
  }
  return { ...base, ok: true, level: view.level, markdown: view.markdown, truncated: view.truncated }
}

/** Register the paper-reading tool. `prepare:false` is for tests only. */
export const inject = ['tools']

export function apply(ctx, config = {}) {
  ctx.tools.register(defineTool({
    name: 'paper_fold',
    description: [
      'Read a paper map-first. Actions: map (default; section titles and the author\'s first-sentence',
      'takeaways, no model call), section (one section at topic/takeaway/key/brief/full; default key),',
      'doc (write textfold/doc JSON), export (write Markdown), status. Local levels need no provider;',
      'generate:true asks TextFold to write model levels and requires TextFold\'s own provider. PaperMemory',
      'remains the source for quotes, numbers, and citation keys. Scanned PDFs are routed to',
      'pdf_to_markdown/subagent_vision; a text PDF may produce a shallow map. Use action=map before full text.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'What to return; default map.',
      },
      ref: {
        type: 'string',
        description: 'DOI, arXiv/PMC/bioRxiv ID, URL, or workspace file (PDF, Markdown, Word, PowerPoint, Excel, EPUB, HTML). Required for every action except status.',
      },
      level: {
        type: 'string',
        enum: DOC_LEVELS,
        description: 'Document level: topic, takeaway, key, brief, full. Defaults: map takeaway, section key, export full.',
      },
      section: {
        type: 'string',
        description: 'Section id (S2), number (2.1), or 1-based position; required for action=section.',
      },
      lang: { type: 'string', description: 'Language code; default en. A non-en language needs generate:true and a TextFold provider.' },
      generate: { type: 'boolean', description: 'Ask TextFold for model-written levels; default false (local levels, no model).' },
      write_to: {
        type: 'string',
        description: 'Workspace-relative output path. Required for doc/export; optional for map/section.',
      },
      max_chars: { type: 'number', description: 'Inline markdown cap; default 12000. Ignored when write_to is set.' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        if (!value.ok) {
          let text = value.error ?? 'paper_fold failed'
          if (value.error_code === 'bad-section' && Array.isArray(value.sections)) {
            text += `\nValid sections: ${value.sections.map((s) => `${s.id}${s.num ? ` (${s.num})` : ''}${s.title ? ` ${s.title}` : ''}`).join('; ')}`
          }
          if (['textfold-missing', 'textfold-install-failed', 'textfold-version'].includes(value.error_code)) {
            text += '\nSet TEXTFOLD_PYTHON or TEXTFOLD_CLI, or let the plugin install TextFold on first use.'
          }
          return [{ type: 'text', text }]
        }
        if (value.action === 'status') {
          return [{
            type: 'text',
            text: `TextFold ${value.version || value.expected_version}: ${value.ready ? 'ready' : 'not ready'} (${value.install}; data ${value.data_dir})${value.error ? `\n${value.error}` : ''}`,
          }]
        }
        if (value.write_to) {
          const bits = [`wrote ${value.action}: ${value.write_to}`]
          if (value.level) bits.push(`level: ${value.level}`)
          if (value.sections) bits.push(`${value.sections} sections`)
          bits.push(value.generated ? 'model-written levels' : 'local levels')
          return [{ type: 'text', text: bits.join(' · ') }]
        }
        return [{ type: 'text', text: value.markdown ?? '' }]
      },
    },
    execute: async (args, exec) => paperFold(args, { cwd: workspaceRoot(exec), signal: exec.signal }),
    presentCall(args) {
      const action = String(args?.action ?? 'map')
      const ref = typeof args?.ref === 'string' ? args.ref : ''
      const isFile = FILE_EXT.test(ref) && !/^https?:/i.test(ref)
      return {
        card: 'generic',
        title: ref ? `Paper ${ref} → ${action}` : `Paper → ${action}`,
        kind: 'search',
        locations: isFile ? [{ path: ref }] : undefined,
      }
    },
  }))

  if (config?.prepare !== false) {
    ensureTextfoldInstalled().catch((error) => {
      console.warn(`${LOG}: paper_fold is not ready: ${error.message}`)
    })
  }
}

export const applyPaperFold = apply
