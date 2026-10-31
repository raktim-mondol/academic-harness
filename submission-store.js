/**
 * Submission-pack ledger: derive a journal checklist from a manuscript and
 * build a hashed, reproducible bundle (Phase 4A of
 * docs/SCIENTIFIC-EXPANSION-PLAN.md).
 *
 * Everything here is advisory. An unknown journal requirement is
 * `manual_check`, never a silent pass; a generated cover letter or highlight is
 * a draft; no submission API, email, or portal is contacted.
 */
import { copyFileSync, cpSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import AdmZip from 'adm-zip'
import { convertPdfMarkdown } from './pdf-to-markdown.js'
import { runCitation } from './citation.js'
import { runManuscriptCitations } from './manuscript-citations.js'
import { deriveStatus, readCheck } from './reporting-store.js'
import { resolveChecklist } from './reporting-check.js'
import { runNumbersAudit } from './numbers-audit.js'
import { runHelper } from './python-runtime.js'
import {
  appendJsonl, ensureDir, exportText, hashFile, mdCell, nowIso,
  readJsonl, sha256, slug as slugify,
} from './ledger-kit.js'
import { resolveWorkspacePath } from './workspace-path.js'

export const SUBMISSION_ACTIONS = ['plan', 'build', 'status', 'export']
export const CHECK_STATES = ['pass', 'fail', 'missing', 'manual_check', 'not_checked']
export const STATEMENT_KEYS = [
  'data_availability', 'code_availability', 'funding', 'competing_interests',
  'ethics', 'author_contributions', 'ai_use',
]

const STATEMENT_LABELS = {
  data_availability: 'Data availability',
  code_availability: 'Code availability',
  funding: 'Funding',
  competing_interests: 'Competing interests',
  ethics: 'Ethics approval',
  author_contributions: 'Author contributions',
  ai_use: 'AI use',
}

const STATEMENT_PATTERNS = {
  data_availability: /(?:^|\n)\s*(?:\\section\*?\{|#{1,6}\s*)?(?:data|dataset|data and code) availability\b/i,
  code_availability: /(?:^|\n)\s*(?:\\section\*?\{|#{1,6}\s*)?(?:code|software) availability\b/i,
  funding: /(?:^|\n)\s*(?:\\section\*?\{|#{1,6}\s*)?(?:funding|financial support|grant support)\b/i,
  competing_interests: /(?:^|\n)\s*(?:\\section\*?\{|#{1,6}\s*)?(?:competing interests?|conflicts? of interest|declaration of interest)\b/i,
  ethics: /(?:^|\n)\s*(?:\\section\*?\{|#{1,6}\s*)?(?:ethics|ethical approval|institutional review|irb)\b/i,
  author_contributions: /(?:^|\n)\s*(?:\\section\*?\{|#{1,6}\s*)?(?:author contributions?|authors? contributions?)\b/i,
  ai_use: /(?:^|\n)\s*(?:\\section\*?\{|#{1,6}\s*)?(?:ai use|use of ai|artificial intelligence|generative ai|large language model)\b/i,
}

function text(value) {
  return String(value ?? '').trim()
}

function list(value) {
  if (value == null || value === '') return []
  return (Array.isArray(value) ? value : [value]).map(text).filter(Boolean)
}

function splitList(value) {
  if (value == null || value === '') return []
  return (Array.isArray(value) ? value : String(value).split(',')).map(text).filter(Boolean)
}

export function submissionSlug(value) {
  const slug = slugify(value, 80)
  if (!slug) throw new Error('slug must contain at least one letter or digit')
  return slug
}

export function submissionDir(cwd, slug) {
  return join(cwd, '.dsh', 'submission', submissionSlug(slug))
}

function files(cwd, slug) {
  const dir = submissionDir(cwd, slug)
  return {
    dir,
    plans: join(dir, 'plans.jsonl'),
    packs: join(dir, 'packs.jsonl'),
    packsDir: join(dir, 'packs'),
    exports: join(dir, 'exports'),
  }
}

function resolveSource(cwd, rel) {
  const abs = resolveWorkspacePath(cwd, rel)
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`file not found: ${rel}`)
  return abs
}

function normalizeRequirements(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  return {
    word_limit: value.word_limit == null ? null : Math.trunc(Number(value.word_limit)),
    abstract_limit: value.abstract_limit == null ? null : Math.trunc(Number(value.abstract_limit)),
    reference_limit: value.reference_limit == null ? null : Math.trunc(Number(value.reference_limit)),
    figure_limit: value.figure_limit == null ? null : Math.trunc(Number(value.figure_limit)),
    table_limit: value.table_limit == null ? null : Math.trunc(Number(value.table_limit)),
    figure_dpi: value.figure_dpi == null ? null : Number(value.figure_dpi),
    figure_formats: splitList(value.figure_formats).map((format) => format.toLowerCase().replace(/^\./, '')),
    figure_naming: text(value.figure_naming) || null,
    figure_max_width_mm: value.figure_max_width_mm == null ? null : Number(value.figure_max_width_mm),
    figure_max_height_mm: value.figure_max_height_mm == null ? null : Number(value.figure_max_height_mm),
    color_mode: text(value.color_mode) || null,
    citation_style: text(value.citation_style) || text(value.style) || null,
    citation_style_file: text(value.citation_style_file) || null,
    citation_style_url: text(value.citation_style_url) || null,
    required_statements: splitList(value.required_statements),
    required_sections: splitList(value.required_sections),
    suggested_reviewers_limit: value.suggested_reviewers_limit == null ? null : Math.trunc(Number(value.suggested_reviewers_limit)),
    article_type: text(value.article_type) || null,
    notes: text(value.notes) || null,
  }
}

/* ------------------------------------------------------------- manuscript text */

function stripTex(textValue) {
  let body = textValue
  const doc = body.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/i)
  if (doc) body = doc[1]
  body = body.replace(/(?<!\\)%.*$/gm, '')
  body = body.replace(/\\begin\{thebibliography\}[\s\S]*?\\end\{thebibliography\}/gi, ' ')
  body = body.replace(/\\bibliography\{[^}]*\}/gi, ' ')
  body = body.replace(/\\begin\{(?:equation|align|eqnarray|displaymath)\*?\}[\s\S]*?\\end\{(?:equation|align|eqnarray|displaymath)\*?\}/gi, ' ')
  body = body.replace(/\$\$[\s\S]*?\$\$/g, ' ').replace(/\\\[[\s\S]*?\\\]/g, ' ').replace(/\$[^$]*\$/g, ' ')
  body = body.replace(/\\includegraphics(?:\[[^\]]*\])?\{[^}]*\}/gi, ' ')
  body = body.replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g, ' $1 ')
  body = body.replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, ' ')
  body = body.replace(/[{}]/g, ' ')
  return body
}

function stripMarkdown(textValue) {
  let body = textValue.replace(/```[\s\S]*?```/g, ' ')
  body = body.replace(/^\s*#{1,6}\s+/gm, ' ')
  body = body.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  body = body.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  body = body.replace(/[*_`>~]/g, ' ')
  return body
}

function bodyForCounting(textValue, ext) {
  let body = textValue
  if (ext === '.tex') body = stripTex(body)
  else body = stripMarkdown(body)
  body = body.replace(/^\s*(?:references|bibliography|works cited)\s*$/gim, '\u0000')
  const cut = body.indexOf('\u0000')
  if (cut >= 0) body = body.slice(0, cut)
  return body
}

function wordCount(body) {
  return (body.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) || []).length
}

function markdownSection(textValue, wanted) {
  const lines = textValue.split('\n')
  let collecting = false
  const body = []
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.+)$/)
    if (heading) {
      if (collecting) break
      if (heading[1].trim().toLowerCase() === wanted) collecting = true
      continue
    }
    if (collecting) body.push(line)
  }
  const result = body.join('\n').trim()
  return result || null
}

function abstractOf(textValue, ext) {
  if (ext === '.tex') {
    const match = textValue.match(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/i)
    if (match) return stripTex(match[1]).trim()
  }
  if (ext === '.md' || ext === '.markdown') {
    const section = markdownSection(textValue, 'abstract')
    if (section) return stripMarkdown(section).trim()
  }
  const fallback = textValue.match(/(?:^|\n)\s*abstract\s*[:\-]?\s*([\s\S]*?)(?=\n\s*(?:keywords?|introduction|1\.|background)\b)/i)
  return fallback ? stripMarkdown(fallback[1]).trim() : null
}

function figureRefsFromText(textValue, ext) {
  if (ext === '.tex') {
    return [...textValue.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)].map((match) => match[1].trim())
  }
  if (ext === '.md' || ext === '.markdown') {
    return [...textValue.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)].map((match) => match[1].trim())
  }
  return []
}

function tableCount(textValue, ext) {
  if (ext === '.tex') return (textValue.match(/\\begin\{table\*?\}/g) || []).length
  const lines = textValue.split('\n')
  let count = 0
  let inTable = false
  for (const line of lines) {
    const isRow = /^\s*\|.*\|\s*$/.test(line) && !/^\s*\|?[\s:|-]+\|?\s*$/.test(line)
    if (isRow && !inTable) count += 1
    inTable = isRow
  }
  return count
}

async function readManuscriptText(cwd, rel) {
  const abs = resolveSource(cwd, rel)
  const ext = extname(abs).toLowerCase()
  if (ext === '.pdf') {
    const converted = await convertPdfMarkdown(readFileSync(abs))
    if (!converted.success) throw new Error(`PDF text extraction failed: ${converted.error}`)
    return { text: converted.markdown || '', ext }
  }
  if (ext === '.docx') {
    const extracted = runHelper('document_text.py', { path: abs })
    if (extracted?.error) throw new Error(extracted.error)
    return { text: extracted.text, ext }
  }
  return { text: readFileSync(abs, 'utf8'), ext }
}

/* ------------------------------------------------------------------ checks */

function check(id, label, status, detail, requirement = null) {
  if (!CHECK_STATES.includes(status)) throw new Error(`invalid check state: ${status}`)
  return { id, label, status, detail, requirement }
}

function limitCheck({ id, label, actual, limit }) {
  if (limit == null) {
    return check(id, label, 'not_checked', `${actual} recorded; the journal limit is not known`, 'not provided')
  }
  return actual <= limit
    ? check(id, label, 'pass', `${actual} / ${limit}`, `≤ ${limit}`)
    : check(id, label, 'fail', `${actual} exceeds the limit of ${limit}`, `≤ ${limit}`)
}

function findReportingCheck(cwd, requested) {
  const root = join(cwd, '.dsh', 'reporting')
  const slug = text(requested)
  if (slug) {
    try {
      return { slug: slugify(slug), check: readCheck(cwd, slug) }
    } catch {
      return { slug: slugify(slug), check: null, error: `reporting check "${slug}" not found` }
    }
  }
  if (!existsSync(root)) return null
  const dirs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  if (dirs.length === 1) {
    try {
      return { slug: dirs[0], check: readCheck(cwd, dirs[0]) }
    } catch {
      return null
    }
  }
  return null
}

function reportingSummary(cwd, requested) {
  const found = findReportingCheck(cwd, requested)
  if (!found) return { status: 'manual_check', detail: 'no reporting_check ledger was found; run reporting_check first if this guideline applies' }
  if (!found.check) return { status: 'manual_check', detail: found.error || 'the reporting check could not be read' }
  try {
    const checklist = resolveChecklist(found.check.guideline.id, found.check.guideline.version)
    const status = deriveStatus({ cwd, slug: found.slug, checklist })
    const evidence = `${status.assessed}/${status.total} item(s) assessed, ${status.verified_evidence} with verified evidence`
    const statusValue = status.assessed > 0 ? 'manual_check' : 'missing'
    return {
      status: statusValue,
      detail: `${found.check.guideline.name} (${found.slug}): ${evidence}${status.stale ? `, ${status.stale} stale` : ''}. This is evidence coverage, not a compliance verdict.`,
      slug: found.slug,
    }
  } catch (error) {
    return { status: 'manual_check', detail: `reporting check could not be evaluated: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function figureChecks({ cwd, figures, requirements }) {
  const checks = []
  const figureInfo = []
  const missing = []
  for (const rel of figures) {
    let abs
    try {
      abs = resolveSource(cwd, rel)
    } catch (error) {
      missing.push({ path: rel, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    const ext = extname(abs).toLowerCase()
    const entry = { path: relative(cwd, abs).replace(/\\/g, '/'), format: ext.replace('.', '') }
    const raster = ['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp', '.gif']
    if (!raster.includes(ext)) {
      const allowed = requirements.figure_formats.length
        ? (requirements.figure_formats.includes(entry.format) ? 'pass' : 'fail')
        : 'not_checked'
      entry.checks = [
        check('figure_format', `Figure format: ${entry.path}`, allowed, requirements.figure_formats.length ? `${entry.format} ${allowed === 'pass' ? 'is allowed' : `is not in ${requirements.figure_formats.join(', ')}`}` : `${entry.format} recorded; allowed formats are not known`, requirements.figure_formats.length ? requirements.figure_formats.join(', ') : 'not provided'),
        check('figure_dpi', `Figure DPI: ${entry.path}`, 'manual_check', 'vector or unsupported format; verify the effective resolution and color mode in the source figure', requirements.figure_dpi == null ? 'not provided' : `≥ ${requirements.figure_dpi}`),
        check('figure_size', `Figure print size: ${entry.path}`, 'manual_check', 'vector or unsupported format; verify the printed size against the journal requirement', requirements.figure_max_width_mm == null && requirements.figure_max_height_mm == null ? 'not provided' : 'size requirement supplied'),
      ]
      figureInfo.push(entry)
      checks.push(...entry.checks)
      continue
    }
    const audit = runHelper('figure_audit.py', { paths: [abs], min_dpi: requirements.figure_dpi || 300 })
    if (audit?.error) {
      entry.checks = [check('figure_metadata', `Figure metadata: ${entry.path}`, 'manual_check', `figure metadata could not be read: ${audit.error}`)]
      figureInfo.push(entry)
      continue
    }
    const file = audit.files?.[0] || {}
    entry.width = file.width || null
    entry.height = file.height || null
    entry.dpi = file.dpi || null
    entry.color_mode = file.mode || null
    if (requirements.figure_formats.length) {
      const ok = requirements.figure_formats.includes(entry.format)
      entry.checks = [check('figure_format', `Figure format: ${entry.path}`, ok ? 'pass' : 'fail', `${entry.format} ${ok ? 'is allowed' : `is not in ${requirements.figure_formats.join(', ')}`}`, requirements.figure_formats.join(', '))]
    } else {
      entry.checks = [check('figure_format', `Figure format: ${entry.path}`, 'not_checked', `${entry.format} recorded; allowed formats are not known`, 'not provided')]
    }
    if (requirements.figure_dpi != null) {
      const dpi = Array.isArray(entry.dpi) ? Math.min(...entry.dpi) : entry.dpi
      entry.checks.push(dpi == null
        ? check('figure_dpi', `Figure DPI: ${entry.path}`, 'manual_check', 'no DPI metadata; verify in the source figure', `≥ ${requirements.figure_dpi}`)
        : check('figure_dpi', `Figure DPI: ${entry.path}`, dpi >= requirements.figure_dpi ? 'pass' : 'fail', `${dpi} DPI`, `≥ ${requirements.figure_dpi}`))
    } else {
      entry.checks.push(check('figure_dpi', `Figure DPI: ${entry.path}`, 'not_checked', entry.dpi ? `${entry.dpi.join('×')} DPI recorded; the journal minimum is not known` : 'no DPI metadata', 'not provided'))
    }
    if (requirements.figure_max_width_mm != null || requirements.figure_max_height_mm != null) {
      const dpi = Array.isArray(entry.dpi) ? Math.min(...entry.dpi) : entry.dpi
      if (entry.width && entry.height && dpi) {
        const widthMm = (entry.width / dpi) * 25.4
        const heightMm = (entry.height / dpi) * 25.4
        const tooWide = requirements.figure_max_width_mm != null && widthMm > requirements.figure_max_width_mm * 1.05
        const tooTall = requirements.figure_max_height_mm != null && heightMm > requirements.figure_max_height_mm * 1.05
        entry.checks.push(check('figure_size', `Figure print size: ${entry.path}`, tooWide || tooTall ? 'fail' : 'pass',
          `${widthMm.toFixed(1)} × ${heightMm.toFixed(1)} mm at ${dpi} DPI`,
          [requirements.figure_max_width_mm != null ? `≤ ${requirements.figure_max_width_mm} mm wide` : null, requirements.figure_max_height_mm != null ? `≤ ${requirements.figure_max_height_mm} mm high` : null].filter(Boolean).join(', ')))
      } else {
        entry.checks.push(check('figure_size', `Figure print size: ${entry.path}`, 'manual_check', 'width, height, or DPI metadata is missing; verify the printed size', 'size requirement supplied'))
      }
    } else {
      entry.checks.push(check('figure_size', `Figure print size: ${entry.path}`, 'not_checked', 'no physical size requirement was supplied', 'not provided'))
    }
    if (requirements.color_mode) {
      const mode = String(entry.color_mode || '').toUpperCase()
      const wanted = requirements.color_mode.toUpperCase()
      const ok = mode === wanted || (wanted === 'GRAYSCALE' && ['L', 'LA'].includes(mode))
      entry.checks.push(check('figure_color', `Figure color mode: ${entry.path}`, ok ? 'pass' : 'fail', `${entry.color_mode || 'unknown'} (required ${requirements.color_mode})`, requirements.color_mode))
    } else {
      entry.checks.push(check('figure_color', `Figure color mode: ${entry.path}`, 'not_checked', `${entry.color_mode || 'unknown'} recorded; color mode requirement is not known`, 'not provided'))
    }
    if (requirements.figure_naming) {
      let re = null
      try { re = new RegExp(requirements.figure_naming) } catch { re = null }
      entry.checks.push(re
        ? check('figure_naming', `Figure naming: ${entry.path}`, re.test(basename(abs)) ? 'pass' : 'fail', `tested ${requirements.figure_naming}`, requirements.figure_naming)
        : check('figure_naming', `Figure naming: ${entry.path}`, 'manual_check', 'figure_naming is not a valid regular expression', requirements.figure_naming))
    }
    figureInfo.push(entry)
    checks.push(...entry.checks)
  }
  for (const item of missing) {
    checks.push(check('figure_file', `Figure file: ${item.path}`, 'missing', item.reason))
  }
  return { checks, figures: figureInfo, missing }
}

/* -------------------------------------------------------------------- plan */

export async function analyzeSubmission(args, exec, deps = {}) {
  const cwd = deps.cwd
  if (!text(args.manuscript)) throw new Error('manuscript is required')
  if (!text(args.journal)) throw new Error('journal is required')
  const slug = submissionSlug(args.slug || args.name || basename(text(args.manuscript)).replace(/\.[^.]+$/, ''))
  const manuscript = text(args.manuscript)
  const manuscriptAbs = resolveSource(cwd, manuscript)
  const ext = extname(manuscriptAbs).toLowerCase()
  const requirements = normalizeRequirements(args.requirements)
  if (text(args.article_type)) requirements.article_type = text(args.article_type) || requirements.article_type
  const warnings = []
  const checks = []

  const read = await readManuscriptText(cwd, manuscript)
  const body = bodyForCounting(read.text, read.ext)
  const words = wordCount(body)
  const abstract = abstractOf(read.text, read.ext)
  const abstractWords = abstract ? wordCount(abstract) : null
  const figures = list(args.figures)
  const extractedFigures = figureRefsFromText(read.text, read.ext)
  const figureList = [...new Set([...figures, ...extractedFigures])]
  const tables = tableCount(read.text, read.ext)

  checks.push(limitCheck({ id: 'word_count', label: 'Manuscript word count', actual: words, limit: requirements.word_limit }))
  checks.push(abstract
    ? limitCheck({ id: 'abstract_word_count', label: 'Abstract word count', actual: abstractWords, limit: requirements.abstract_limit })
    : check('abstract_word_count', 'Abstract word count', 'missing', 'no abstract was found in the manuscript'))

  let citationResult = null
  if (['.tex', '.md', '.markdown'].includes(read.ext)) {
    citationResult = await (deps.runCitations || runManuscriptCitations)({
      manuscript,
      bib_path: args.bib,
    }, exec)
    if (citationResult?.error) {
      checks.push(check('citations', 'Manuscript citations', 'not_checked', citationResult.error))
      checks.push(check('reference_count', 'Reference count', 'not_checked', citationResult.error, requirements.reference_limit == null ? 'not provided' : `≤ ${requirements.reference_limit}`))
    } else {
      const stats = citationResult.statistics
      const inspected = stats.cited_keys + stats.bibliography_entries
      checks.push(inspected === 0
        ? check('citations', 'Manuscript citations', 'not_checked', 'no cited keys or bibliography entries were found; the manuscript/bibliography pair was not checked', 'no missing/duplicate/undefined')
        : check('citations', 'Manuscript citations',
          stats.missing || stats.duplicate_keys || stats.undefined_refs ? 'fail' : 'pass',
          `${stats.missing} cited key(s) missing, ${stats.unused} unused entr(ies), ${stats.duplicate_keys} duplicate key(s), ${stats.undefined_refs} undefined ref(s)`,
          'no missing/duplicate/undefined'))
      checks.push(limitCheck({
        id: 'reference_count', label: 'Reference count',
        actual: stats.bibliography_entries, limit: requirements.reference_limit,
      }))
    }
  } else {
    checks.push(check('citations', 'Manuscript citations', 'not_checked', `${read.ext} citation fields cannot be checked reliably; verify in the submission system`))
    checks.push(check('reference_count', 'Reference count', 'not_checked', `${read.ext} files are not parsed for references`, 'not provided'))
  }

  if (requirements.citation_style || requirements.citation_style_file || requirements.citation_style_url) {
    const bibPath = splitList(args.bib)[0] || citationResult?.bibliography?.[0] || null
    if (!bibPath) {
      checks.push(check('citation_style', 'Citation style', 'not_checked', 'a style was requested but no bibliography file is available to test it', requirements.citation_style || requirements.citation_style_file || requirements.citation_style_url))
    } else {
      try {
        const formatted = await (deps.runCitationStyle || runCitation)({
          action: 'format',
          path: bibPath,
          style: requirements.citation_style || undefined,
          style_file: requirements.citation_style_file || undefined,
          style_url: requirements.citation_style_url || undefined,
        }, exec)
        checks.push(formatted?.error
          ? check('citation_style', 'Citation style', 'fail', formatted.error, requirements.citation_style || requirements.citation_style_file || requirements.citation_style_url)
          : check('citation_style', 'Citation style', 'manual_check', `the bibliography formats as ${formatted.style}; verify the manuscript itself uses that style`, formatted.style))
      } catch (error) {
        checks.push(check('citation_style', 'Citation style', 'fail', error instanceof Error ? error.message : String(error), requirements.citation_style || requirements.citation_style_file || requirements.citation_style_url))
      }
    }
  } else {
    checks.push(check('citation_style', 'Citation style', 'not_checked', 'no citation-style requirement was supplied', 'not provided'))
  }

  checks.push(limitCheck({ id: 'figure_count', label: 'Figure count', actual: figureList.length, limit: requirements.figure_limit }))
  checks.push(limitCheck({ id: 'table_count', label: 'Table count', actual: tables, limit: requirements.table_limit }))

  if (read.ext === '.pdf') {
    checks.push(check('manuscript_pdf', 'Manuscript PDF', 'pass', 'the supplied manuscript is a PDF'))
  } else if (read.ext === '.tex') {
    checks.push(check('manuscript_pdf', 'Manuscript PDF', 'manual_check', 'a PDF is compiled at build time when compile is true; verify the compiled output before upload'))
  } else if (text(args.manuscript_pdf)) {
    checks.push(check('manuscript_pdf', 'Manuscript PDF', 'pass', `supplied separately as ${args.manuscript_pdf}`))
  } else {
    checks.push(check('manuscript_pdf', 'Manuscript PDF', 'manual_check', 'supply manuscript_pdf or convert the source before upload'))
  }
  checks.push(text(args.graphical_abstract)
    ? check('graphical_abstract', 'Graphical abstract', 'manual_check', `supplied as ${args.graphical_abstract}; confirm the journal's dimensions and format`)
    : check('graphical_abstract', 'Graphical abstract', 'not_checked', 'not supplied; confirm whether the journal requires one'))

  const figureAudit = await (deps.figureChecks || figureChecks)({ cwd, figures: figureList, requirements })
  checks.push(...figureAudit.checks)

  const reporting = (deps.reportingSummary || reportingSummary)(cwd, args.reporting)
  checks.push(check('reporting_guideline', 'Reporting guideline evidence', reporting.status, reporting.detail))

  let numbers = null
  try {
    numbers = await (deps.runNumbers || runNumbersAudit)({ path: manuscript }, exec)
    if (numbers?.error) {
      checks.push(check('numbers_audit', 'Numerical reporting', 'not_checked', numbers.error))
      numbers = null
    } else {
      const checkedValues = numbers.summary.checked || 0
      checks.push(check('numbers_audit', 'Numerical reporting',
        checkedValues === 0 ? 'not_checked' : (numbers.summary.flagged ? 'manual_check' : 'pass'),
        checkedValues === 0
          ? 'no locally checkable numeric pattern was found; the audit checked nothing'
          : `${numbers.summary.flagged} candidate issue(s) of ${checkedValues} checked value(s); ${numbers.summary.not_checked} item(s) not checked`,
        'no candidate inconsistencies'))
    }
  } catch (error) {
    checks.push(check('numbers_audit', 'Numerical reporting', 'not_checked', error instanceof Error ? error.message : String(error)))
  }

  const providedStatements = args.statements && typeof args.statements === 'object' ? args.statements : {}
  const requiredStatements = requirements.required_statements.length ? requirements.required_statements : STATEMENT_KEYS
  const statementRows = []
  for (const key of requiredStatements) {
    if (!STATEMENT_KEYS.includes(key)) {
      const detail = 'unknown statement key; check the journal instructions'
      statementRows.push({ key, label: key, status: 'manual_check', detail })
      checks.push(check(`statement_${slugify(key) || 'unknown'}`, `Statement: ${key}`, 'manual_check', detail))
      continue
    }
    const provided = text(providedStatements[key])
    if (provided) {
      statementRows.push({ key, label: STATEMENT_LABELS[key], status: 'provided', detail: 'author-supplied text will be bundled' })
      checks.push(check(`statement_${key}`, `Statement: ${STATEMENT_LABELS[key]}`, 'pass', 'author-supplied text will be bundled'))
      continue
    }
    const pattern = STATEMENT_PATTERNS[key]
    const match = pattern ? pattern.exec(read.text) : null
    if (match) {
      statementRows.push({ key, label: STATEMENT_LABELS[key], status: 'found_in_manuscript', detail: `presence detected near line ${read.text.slice(0, match.index).split('\n').length}; verify that the statement is accurate and complete` })
      checks.push(check(`statement_${key}`, `Statement: ${STATEMENT_LABELS[key]}`, 'manual_check', 'a statement heading or phrase was found; verify its content'))
    } else if (requirements.required_statements.length) {
      statementRows.push({ key, label: STATEMENT_LABELS[key], status: 'missing', detail: 'required by the supplied requirements and not found' })
      checks.push(check(`statement_${key}`, `Statement: ${STATEMENT_LABELS[key]}`, 'missing', 'required and not found in the manuscript or supplied statements'))
    } else {
      statementRows.push({ key, label: STATEMENT_LABELS[key], status: 'manual_check', detail: 'not found; the journal requirement is not known' })
      checks.push(check(`statement_${key}`, `Statement: ${STATEMENT_LABELS[key]}`, 'manual_check', 'not found; confirm whether the journal requires it'))
    }
  }

  const requiredSections = requirements.required_sections
  for (const section of requiredSections) {
    const re = new RegExp(`(?:\\\\section\\*?\\{|#{1,6}\\s*)${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')
    const found = re.test(read.text)
    checks.push(check(`section_${slugify(section)}`, `Required section: ${section}`, found ? 'pass' : 'missing', found ? 'heading found' : 'heading not found'))
  }

  const reviewers = Array.isArray(args.suggested_reviewers) ? args.suggested_reviewers : []
  if (reviewers.length) {
    const invalid = reviewers.filter((reviewer) => !text(reviewer?.name))
    checks.push(check('suggested_reviewers', 'Suggested reviewers',
      invalid.length ? 'fail' : 'manual_check',
      invalid.length ? `${invalid.length} entr(ies) have no name` : `${reviewers.length} user-supplied entr(ies); the tool did not invent or verify them`,
      requirements.suggested_reviewers_limit == null ? 'not provided' : `≤ ${requirements.suggested_reviewers_limit}`))
  } else {
    checks.push(check('suggested_reviewers', 'Suggested reviewers',
      requirements.suggested_reviewers_limit ? 'missing' : 'not_checked',
      requirements.suggested_reviewers_limit ? 'the journal asks for suggested reviewers and none were supplied' : 'no suggested reviewers were supplied; the requirement is not known',
      requirements.suggested_reviewers_limit == null ? 'not provided' : `≤ ${requirements.suggested_reviewers_limit}`))
  }

  if (figureAudit.missing.length) warnings.push(`${figureAudit.missing.length} figure reference(s) could not be resolved`)

  const statusCounts = {}
  for (const state of CHECK_STATES) statusCounts[state] = checks.filter((entry) => entry.status === state).length
  const missing = checks.filter((entry) => entry.status === 'missing').map((entry) => entry.id)
  const manualCheck = checks.filter((entry) => entry.status === 'manual_check').map((entry) => entry.id)
  const failed = checks.filter((entry) => entry.status === 'fail').map((entry) => entry.id)

  return {
    slug,
    journal: text(args.journal),
    title: text(args.title) || null,
    article_type: requirements.article_type,
    manuscript,
    manuscript_ext: read.ext,
    requirements,
    counts: { words, abstract_words: abstractWords, references: citationResult?.statistics?.bibliography_entries ?? null, figures: figureList.length, tables },
    abstract,
    checks,
    status_counts: statusCounts,
    missing,
    manual_check: manualCheck,
    failed,
    ready: failed.length === 0 && missing.length === 0 && manualCheck.length === 0,
    statements: statementRows,
    figures: figureAudit.figures,
    missing_figures: figureAudit.missing,
    suggested_reviewers: reviewers,
    citation_statistics: citationResult?.statistics || null,
    numbers: numbers ? { summary: numbers.summary, rows: (numbers.rows || []).slice(0, 20) } : null,
    reporting,
    warnings,
    note: 'Advisory submission checklist. Unknown requirements are manual_check, not passes; no journal submission, email, or portal action is performed.',
  }
}

export function recordPlan(cwd, slug, plan) {
  const f = files(cwd, slug)
  ensureDir(f.dir)
  const created = nowIso()
  const record = {
    plan_id: `sub-plan-${created.replace(/[-:TZ.]/g, '').slice(0, 14)}-${sha256(plan).slice(0, 8)}`,
    created_at: created,
    ...plan,
  }
  appendJsonl(f.plans, [record])
  return record
}

export function latestPlan(cwd, slug) {
  const records = readJsonl(files(cwd, slug).plans)
  return records.at(-1) || null
}

/* ------------------------------------------------------------------- build */

function buildChecklistMarkdown(plan) {
  return [
    `# Submission checklist: ${plan.journal}`,
    '',
    `Manuscript: \`${plan.manuscript}\`  `,
    `Generated: ${plan.created_at || nowIso()}`,
    '',
    '| Check | Status | Detail | Requirement |',
    '|---|---|---|---|',
    ...plan.checks.map((entry) => `| ${mdCell(entry.label)} | ${entry.status} | ${mdCell(entry.detail)} | ${mdCell(entry.requirement || '')} |`),
    '',
    `Failed: ${plan.failed.join(', ') || 'none'}. Missing: ${plan.missing.join(', ') || 'none'} (${plan.missing.length}). Manual checks: ${plan.manual_check.length}.`,
    '',
    '> Advisory checklist only. A pass means the local check succeeded, not that the journal will accept the submission.',
    '',
  ].join('\n')
}

function buildStatementsMarkdown(plan) {
  const lines = [
    '# Statements and declarations',
    '',
    'Author-supplied text is copied below. A statement detected in the manuscript is marked as present, not reproduced, until the authors confirm its wording.',
    '',
  ]
  for (const statement of plan.statements) {
    lines.push(`## ${statement.label}`, '', `Status: ${statement.status}. ${statement.detail}`, '')
  }
  return lines.join('\n')
}

function safeCoverLetter(plan, plan2 = {}) {
  const provided = text(plan2.coverLetter)
  if (provided) return `${provided}\n`
  const abstractSentence = plan.abstract
    ? plan.abstract.replace(/\s+/g, ' ').slice(0, 500).trim()
    : ''
  return [
    `Dear Editors of ${plan.journal},`,
    '',
    `Please consider our manuscript, "${plan2.title || plan.title || plan.manuscript}", for publication in ${plan.journal}${plan.article_type ? ` as ${plan.article_type}` : ''}.`,
    '',
    abstractSentence ? `Abstract (as recorded): ${abstractSentence}` : '',
    '',
    '[Author approval required: state the novelty, significance, and fit to the journal in your own words. This draft contains no claims generated by the tool.]',
    '',
    'Thank you for your consideration.',
    '',
    'Sincerely,',
    '',
    '[Corresponding author name, affiliation, and contact details]',
    '',
  ].filter((line) => line !== '').join('\n')
}

function safeHighlights(plan, provided) {
  const values = list(provided)
  if (values.length) {
    return values.map((value) => `- ${value}`).join('\n') + '\n'
  }
  return [
    '- [Author to supply highlight 1 — no claim was generated]',
    '- [Author to supply highlight 2 — no claim was generated]',
    '- [Author to supply highlight 3 — no claim was generated]',
    '',
  ].join('\n')
}

function assertSafeArchivePath(rel) {
  const normalized = String(rel || '').replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..') || normalized.includes('\0')) {
    throw new Error(`unsafe archive path: ${rel}`)
  }
  return normalized
}

function copyInto(cwd, srcRel, destRel, packDir, role, entries, warnings, capBytes = 200 * 1024 * 1024) {
  const safeDest = assertSafeArchivePath(destRel)
  let abs
  try {
    abs = resolveSource(cwd, srcRel)
  } catch (error) {
    warnings.push(`${srcRel}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  if (statSync(abs).size > capBytes) {
    warnings.push(`${srcRel}: larger than ${capBytes} bytes, not copied`)
    return null
  }
  const dest = join(packDir, safeDest)
  ensureDir(dirname(dest))
  copyFileSync(abs, dest)
  entries.push({ path: safeDest, role, bytes: statSync(dest).size, sha256: `sha256:${hashFile(dest)}`, source: relative(cwd, abs).replace(/\\/g, '/') })
  return dest
}

function fixedZipTime() {
  return new Date(Date.UTC(1980, 0, 1))
}

export function reproducibleZip(packDir, entries) {
  const zip = new AdmZip()
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const safe = assertSafeArchivePath(entry.path)
    const abs = join(packDir, safe)
    const zipEntry = zip.addFile(safe, readFileSync(abs))
    zipEntry.header.time = fixedZipTime()
  }
  return zip.toBuffer()
}

export async function buildSubmissionPack(args, exec, deps = {}) {
  const cwd = deps.cwd
  const plan = await (deps.analyze || analyzeSubmission)(args, exec, { cwd })
  const slug = plan.slug
  const recorded = recordPlan(cwd, slug, plan)
  const f = files(cwd, slug)
  const packId = `sub-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`
  const packDir = join(f.packsDir, packId)
  ensureDir(packDir)
  const entries = []
  const warnings = [...plan.warnings]
  const generated = []
  const buildChecks = []
  let manuscriptPdfBundled = false

  const pdfRel = text(args.manuscript_pdf)
  if (pdfRel) {
    if (copyInto(cwd, pdfRel, join('manuscript', basename(pdfRel)), packDir, 'manuscript_pdf', entries, warnings)) manuscriptPdfBundled = true
  } else if (plan.manuscript_ext === '.pdf') {
    if (copyInto(cwd, plan.manuscript, join('manuscript', basename(plan.manuscript)), packDir, 'manuscript_pdf', entries, warnings)) manuscriptPdfBundled = true
  } else if (plan.manuscript_ext === '.tex' && args.compile !== false) {
    const compile = await (deps.compile || (async (cwdValue, rel, engine) => {
      const { compileLatex } = await import('./latex-compile.js')
      return compileLatex(cwdValue, rel, engine)
    }))(cwd, plan.manuscript, args.engine || 'pdflatex')
    if (compile.success) {
      if (copyInto(cwd, compile.pdf_path, join('manuscript', basename(compile.pdf_path)), packDir, 'manuscript_pdf', entries, warnings)) manuscriptPdfBundled = true
      generated.push({ role: 'manuscript_pdf', source: 'latex_compile', path: compile.pdf_path })
    } else {
      warnings.push(`manuscript PDF was not produced: ${compile.error || 'compile failed'}`)
    }
  }
  buildChecks.push(manuscriptPdfBundled
    ? check('pack_manuscript_pdf', 'Bundled manuscript PDF', 'pass', 'a manuscript PDF is in the pack')
    : check('pack_manuscript_pdf', 'Bundled manuscript PDF', 'fail', 'no manuscript PDF was bundled; supply manuscript_pdf or compile the source'))
  if (plan.manuscript_ext !== '.pdf') {
    copyInto(cwd, plan.manuscript, join('manuscript', basename(plan.manuscript)), packDir, 'manuscript_source', entries, warnings)
  }
  if (args.bib) {
    for (const bib of splitList(args.bib)) copyInto(cwd, bib, join('manuscript', basename(bib)), packDir, 'bibliography', entries, warnings)
  }

  const usedFigures = new Set()
  for (const figure of plan.figures) {
    const name = basename(figure.path)
    const target = usedFigures.has(name) ? `${basename(name, extname(name))}-${usedFigures.size + 1}${extname(name)}` : name
    usedFigures.add(target)
    copyInto(cwd, figure.path, join('figures', target), packDir, 'figure', entries, warnings)
  }
  for (const supplementary of list(args.supplementary)) {
    copyInto(cwd, supplementary, join('supplementary', basename(supplementary)), packDir, 'supplementary', entries, warnings)
  }

  const statements = []
  const providedStatements = args.statements && typeof args.statements === 'object' ? args.statements : {}
  for (const statement of plan.statements) {
    if (!STATEMENT_KEYS.includes(statement.key)) continue
    const provided = text(providedStatements[statement.key])
    if (provided) {
      const rel = join('statements', `${statement.key}.md`)
      exportText(join(packDir, rel), `${provided.trim()}\n`, { overwrite: true })
      entries.push({ path: rel, role: 'statement', bytes: Buffer.byteLength(provided.trim()) + 1, sha256: `sha256:${hashFile(join(packDir, rel))}`, source: 'author-supplied' })
      statements.push({ key: statement.key, label: statement.label, status: 'provided', path: rel })
    } else {
      statements.push({ key: statement.key, label: statement.label, status: statement.status, path: null })
    }
  }
  const statementsRel = join('statements', 'statements.md')
  exportText(join(packDir, statementsRel), buildStatementsMarkdown(recorded), { overwrite: true })
  entries.push({ path: statementsRel, role: 'statement-summary', bytes: statSync(join(packDir, statementsRel)).size, sha256: `sha256:${hashFile(join(packDir, statementsRel))}`, source: 'submission_pack' })

  const coverRel = join('cover-letter.md')
  const coverBody = safeCoverLetter(recorded, { coverLetter: args.cover_letter, title: args.title })
  exportText(join(packDir, coverRel), coverBody, { overwrite: true })
  generated.push({ role: 'cover_letter', source: args.cover_letter ? 'author-supplied' : 'draft', path: coverRel })
  entries.push({ path: coverRel, role: 'cover_letter', bytes: Buffer.byteLength(coverBody), sha256: `sha256:${hashFile(join(packDir, coverRel))}`, source: args.cover_letter ? 'author-supplied' : 'draft' })

  const highlightsRel = join('highlights.md')
  const highlightsBody = safeHighlights(recorded, args.highlights)
  exportText(join(packDir, highlightsRel), highlightsBody, { overwrite: true })
  generated.push({ role: 'highlights', source: list(args.highlights).length ? 'author-supplied' : 'draft', path: highlightsRel })
  entries.push({ path: highlightsRel, role: 'highlights', bytes: Buffer.byteLength(highlightsBody), sha256: `sha256:${hashFile(join(packDir, highlightsRel))}`, source: list(args.highlights).length ? 'author-supplied' : 'draft' })

  if (args.graphical_abstract) {
    copyInto(cwd, text(args.graphical_abstract), join('graphical-abstract', basename(text(args.graphical_abstract))), packDir, 'graphical_abstract', entries, warnings)
  }

  const checklistRel = join('checklist.md')
  exportText(join(packDir, checklistRel), buildChecklistMarkdown(recorded), { overwrite: true })
  entries.push({ path: checklistRel, role: 'checklist', bytes: statSync(join(packDir, checklistRel)).size, sha256: `sha256:${hashFile(join(packDir, checklistRel))}`, source: 'submission_pack' })

  const readmeRel = 'README.txt'
  const readme = [
    `Submission pack ${packId}`,
    `Journal: ${recorded.journal}`,
    `Manuscript: ${recorded.manuscript}`,
    '',
    'This bundle was assembled locally. It was NOT submitted anywhere.',
    'A pass in checklist.md means a local check succeeded, not that the journal will accept the submission.',
    'Cover letter and highlights marked as drafts require author review and approval before upload.',
    'manifest.json lists every bundled file with its SHA-256. The zip is reproducible from that manifest.',
    '',
  ].join('\n')
  exportText(join(packDir, readmeRel), readme, { overwrite: true })
  entries.push({ path: readmeRel, role: 'readme', bytes: Buffer.byteLength(readme), sha256: `sha256:${hashFile(join(packDir, readmeRel))}`, source: 'submission_pack' })

  const allChecks = [...recorded.checks, ...buildChecks]
  const failed = allChecks.filter((entry) => entry.status === 'fail').map((entry) => entry.id)
  const missing = allChecks.filter((entry) => entry.status === 'missing').map((entry) => entry.id)
  const manualCheck = allChecks.filter((entry) => entry.status === 'manual_check').map((entry) => entry.id)
  const statusCounts = {}
  for (const state of CHECK_STATES) statusCounts[state] = allChecks.filter((entry) => entry.status === state).length
  const manifest = {
    pack_id: packId,
    plan_id: recorded.plan_id,
    journal: recorded.journal,
    article_type: recorded.article_type,
    manuscript: recorded.manuscript,
    created_at: nowIso(),
    files: entries,
    checks: allChecks,
    status_counts: statusCounts,
    failed,
    missing,
    manual_check: manualCheck,
    ready_to_upload: failed.length === 0 && missing.length === 0 && manualCheck.length === 0,
    statements,
    suggested_reviewers: recorded.suggested_reviewers,
    warnings,
    note: 'Every bundled file is hashed above except this manifest and the zip container. No submission action was taken.',
  }
  exportText(join(packDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { overwrite: true })

  const zipEntries = [...entries, { path: 'manifest.json' }]
  const zipBuffer = reproducibleZip(packDir, zipEntries)
  exportText(join(packDir, `${packId}.zip`), zipBuffer, { overwrite: true })

  const event = {
    pack_id: packId,
    plan_id: recorded.plan_id,
    created_at: manifest.created_at,
    pack_dir: relative(cwd, packDir).replace(/\\/g, '/'),
    zip: relative(cwd, join(packDir, `${packId}.zip`)).replace(/\\/g, '/'),
    zip_sha256: `sha256:${sha256(zipBuffer)}`,
    files: entries.length,
    bytes: zipBuffer.length,
    failed: manifest.failed,
    missing: manifest.missing,
    manual_check: manifest.manual_check,
    warnings,
  }
  appendJsonl(f.packs, [event])
  return { plan: recorded, pack: event, manifest, generated }
}

/* ------------------------------------------------------------------ status/export */

export function submissionStatus(cwd, slugValue) {
  const slug = submissionSlug(slugValue)
  const plan = latestPlan(cwd, slug)
  const packs = readJsonl(files(cwd, slug).packs)
  return {
    slug,
    plan,
    packs,
    ready: plan ? plan.ready : false,
    missing: plan ? plan.missing : [],
    manual_check: plan ? plan.manual_check : [],
    failed: plan ? plan.failed : [],
  }
}

export function exportSubmissionPack({ cwd, slug: slugValue, packId = null, out = null, format = 'zip', overwrite = false }) {
  const slug = submissionSlug(slugValue)
  const packs = readJsonl(files(cwd, slug).packs)
  const pack = packId ? packs.find((entry) => entry.pack_id === packId) : packs.at(-1)
  if (!pack) throw new Error(`no submission pack for "${slug}"${packId ? ` with id ${packId}` : ''}`)
  const kind = String(format || 'zip').toLowerCase()
  if (!['zip', 'dir'].includes(kind)) throw new Error('format must be zip or dir')
  if (kind === 'zip') {
    const outRel = text(out) || join('.dsh', 'submission', slug, 'exports', `${pack.pack_id}.zip`)
    const outAbs = resolveWorkspacePath(cwd, outRel, { forWrite: true })
    ensureDir(dirname(outAbs))
    if (existsSync(outAbs) && !overwrite) throw new Error(`${outRel} already exists; pass overwrite: true to replace it`)
    copyFileSync(resolveSource(cwd, pack.zip), outAbs)
    return { format: 'zip', path: outRel.replace(/\\/g, '/'), bytes: statSync(outAbs).size, pack_id: pack.pack_id }
  }
  const outRel = text(out) || join('.dsh', 'submission', slug, 'exports', pack.pack_id)
  const outAbs = resolveWorkspacePath(cwd, outRel, { forWrite: true })
  const sourceDir = resolveWorkspacePath(cwd, pack.pack_dir)
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) throw new Error(`pack directory not found: ${pack.pack_dir}`)
  if (existsSync(outAbs) && !overwrite) throw new Error(`${outRel} already exists; pass overwrite: true to replace it`)
  cpSync(sourceDir, outAbs, { recursive: true, force: Boolean(overwrite) })
  return { format: 'dir', path: outRel.replace(/\\/g, '/'), pack_id: pack.pack_id }
}
