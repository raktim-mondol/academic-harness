/**
 * presentation_build: posters and slides from a paper/outline (Phase 4D of
 * docs/SCIENTIFIC-EXPANSION-PLAN.md).
 *
 * The generator fills known sections and figures into a chosen template. It
 * never invents results or figures, and a successful compile is not a visual
 * QA pass: `qa` returns the checklist for a vision review.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { convertPdfMarkdown } from './pdf-to-markdown.js'
import { compileLatex } from './latex-compile.js'
import {
  ensureDir, exportText, hashFile, nowIso, readJson, sha256, slug as slugify,
} from './ledger-kit.js'
import { runHelper } from './python-runtime.js'
import { resolveWorkspacePath } from './workspace-path.js'

const ACTIONS = ['poster', 'slides', 'status', 'qa']
const POSTER_TEMPLATES = ['tikzposter', 'beamerposter', 'baposter']
const SLIDE_ENGINES = ['beamer', 'pptx']
const SLIDE_STYLES = ['conference', 'seminar', 'defense']

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

function slugFrom(args) {
  const explicit = text(args.slug)
  if (explicit) {
    const value = slugify(explicit)
    if (!value) throw new Error('slug must contain at least one letter or digit')
    return value
  }
  const source = text(args.manuscript) || text(args.title)
  if (!source) throw new Error('slug is required (or give manuscript/title so one can be derived)')
  return slugify(basename(source).replace(/\.[^.]+$/, '')) || 'presentation'
}

function storeDir(cwd, slug) {
  return join(cwd, '.dsh', 'presentation', slug)
}

function plainInline(value) {
  return text(value)
    .replace(/\\cite[tp]?\{([^}]*)\}/g, '[$1]')
    .replace(/\\(?:textbf|textit|emph|underline|mathrm|text|mathbf)\{([^{}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, '')
    .replace(/[{}]/g, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function latexInline(value) {
  const placeholder = '\u0000'
  return plainInline(value)
    .replace(/\\/g, placeholder)
    .replace(/([#$%&_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(new RegExp(placeholder, 'g'), '\\textbackslash{}')
}

const UNSAFE_TEX = /\\(?:input|include|includeonly|includegraphics|lstinputlisting|verbatiminput|VerbatimInput|includepdf|import|subimport|subfile|inputminted|loadglsentries|addbibresource|bibliography|write18|immediate|openout|openin|read|special|catcode|csname|endcsname|directlua|usepackage|documentclass|begin|end|newcommand|renewcommand|providecommand|def|let)\*?(?:\[[^\]]*\])?(?:\{[^{}]*\})?/gi

function cleanBullet(value, sourceKind) {
  const raw = text(value)
  if (!raw) return ''
  return sourceKind === 'tex' ? raw.replace(UNSAFE_TEX, ' ') : latexInline(raw)
}

function uniqueFigureName(used, path) {
  const base = basename(path).replace(/[^A-Za-z0-9._-]+/g, '_')
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  const ext = extname(base)
  const stem = base.slice(0, base.length - ext.length)
  let index = 2
  while (used.has(`${stem}-${index}${ext}`)) index += 1
  const name = `${stem}-${index}${ext}`
  used.add(name)
  return name
}

function resolveFigure(cwd, manuscriptPath, raw) {
  const candidates = []
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) candidates.push(raw)
  else {
    if (manuscriptPath) candidates.push(join(dirname(manuscriptPath), raw))
    candidates.push(raw)
  }
  for (const candidate of candidates) {
    try {
      const abs = resolveWorkspacePath(cwd, candidate)
      if (existsSync(abs) && statSync(abs).isFile()) return { abs, rel: relative(cwd, abs) }
    } catch {
      // try the next candidate
    }
  }
  return null
}

function texOutline(source) {
  const title = source.match(/\\title\s*\{([^{}]*)\}/)?.[1] || null
  const authors = source.match(/\\author\s*\{([^{}]*)\}/)?.[1] || null
  const institute = source.match(/\\institute\s*\{([^{}]*)\}/)?.[1] || null
  const matches = [...source.matchAll(/\\(?:section|subsection)\*?\{([^{}]*)\}/g)]
  const sections = []
  for (let index = 0; index < matches.length; index += 1) {
    const heading = matches[index][1]
    const start = matches[index].index + matches[index][0].length
    const end = index + 1 < matches.length ? matches[index + 1].index : source.length
    const chunk = source.slice(start, end)
    const bullets = [...chunk.matchAll(/\\item\s+([^\n]+)/g)].map((match) => match[1].trim())
    const figures = [...chunk.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)].map((match) => match[1].trim())
    const paragraphs = chunk.split(/\n\s*\n/).map((part) => plainInline(part)).filter((part) => part.length > 20).slice(0, 3)
    sections.push({ heading: plainInline(heading), bullets: bullets.length ? bullets : paragraphs, figures, notes: '' })
  }
  return { title: plainInline(title), authors: plainInline(authors), institute: plainInline(institute), sections, sourceKind: 'tex' }
}

function markdownOutline(source) {
  const title = source.match(/^#\s+(.+)$/m)?.[1] || null
  const matches = [...source.matchAll(/^#{2,3}\s+(.+)$/gm)]
  const sections = []
  for (let index = 0; index < matches.length; index += 1) {
    const heading = matches[index][1]
    const start = matches[index].index + matches[index][0].length
    const end = index + 1 < matches.length ? matches[index + 1].index : source.length
    const chunk = source.slice(start, end)
    const bullets = [...chunk.matchAll(/^\s*[-*+]\s+(.+)$/gm)].map((match) => match[1].trim())
    const figures = [...chunk.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)].map((match) => match[1].trim())
    const paragraphs = chunk.split(/\n\s*\n/).map((part) => plainInline(part)).filter((part) => part.length > 20).slice(0, 3)
    sections.push({ heading: plainInline(heading), bullets: bullets.length ? bullets : paragraphs, figures, notes: '' })
  }
  return { title: plainInline(title), authors: null, institute: null, sections, sourceKind: 'markdown' }
}

function plainOutline(source) {
  const title = null
  const paragraphs = source.split(/\n\s*\n/).map((part) => plainInline(part)).filter(Boolean)
  const sections = paragraphs.slice(0, 10).map((paragraph, index) => ({
    heading: `Point ${index + 1}`,
    bullets: [paragraph],
    figures: [],
    notes: '',
  }))
  return { title, authors: null, institute: null, sections, sourceKind: 'text' }
}

async function readManuscript(cwd, path) {
  const abs = resolveWorkspacePath(cwd, path)
  if (!existsSync(abs)) throw new Error(`manuscript not found: ${path}`)
  const ext = extname(abs).toLowerCase()
  if (ext === '.pdf') {
    const converted = await convertPdfMarkdown(readFileSync(abs))
    if (!converted.success) throw new Error(converted.error || 'PDF text extraction failed')
    return { text: converted.markdown || converted.text || '', ext: '.pdf', path }
  }
  if (ext === '.docx') {
    const extracted = runHelper('document_text.py', { path: abs })
    if (extracted?.error) throw new Error(extracted.error)
    return { text: extracted.text, ext, path }
  }
  if (!['.tex', '.md', '.markdown', '.txt'].includes(ext)) {
    throw new Error('manuscript must be .tex, .md, .txt, .docx, or .pdf; or pass sections directly')
  }
  return { text: readFileSync(abs, 'utf8'), ext, path }
}

function normalizeSections(input) {
  if (!Array.isArray(input)) return null
  return input.map((section, index) => {
    if (typeof section === 'string') {
      return { heading: `Section ${index + 1}`, bullets: [section], figures: [], notes: '' }
    }
    const value = section || {}
    const bullets = Array.isArray(value.bullets) ? value.bullets.map(text).filter(Boolean) : (text(value.content) ? [text(value.content)] : [])
    return {
      heading: text(value.heading) || `Section ${index + 1}`,
      bullets,
      figures: list(value.figures),
      notes: text(value.notes),
    }
  }).filter((section) => section.heading || section.bullets.length)
}

function itemize(bullets, sourceKind, indent = '  ') {
  if (!bullets.length) return ''
  return [
    `${indent}\\begin{itemize}`,
    ...bullets.map((bullet) => `${indent}  \\item ${cleanBullet(bullet, sourceKind)}`),
    `${indent}\\end{itemize}`,
  ].join('\n')
}

function figureLatex(figures, options = 'width=\\linewidth,height=0.25\\textheight,keepaspectratio') {
  if (!figures.length) return ''
  return figures.slice(0, 2).map((figure) => `\\includegraphics[${options}]{${figure}}`).join('\n')
}

function posterDocument({ template, title, authors, institute, sections, sourceKind }) {
  const headingTitle = latexInline(title || 'Untitled poster')
  const headingAuthors = latexInline(authors || '[Authors to be recorded]')
  const headingInstitute = latexInline(institute || '')
  const blocks = sections.map((section, index) => ({
    heading: latexInline(section.heading || `Section ${index + 1}`),
    body: [itemize(section.bullets, sourceKind), figureLatex(section.figures)].filter(Boolean).join('\n\n'),
  }))
  const split = Math.ceil(blocks.length / 2)
  const left = blocks.slice(0, split)
  const right = blocks.slice(split)

  if (template === 'beamerposter') {
    return [
      '% Generated by academic-harness presentation_build from the recorded outline.',
      '\\documentclass[final]{beamer}',
      '\\usepackage[size=a0,scale=1.4]{beamerposter}',
      '\\usepackage{graphicx}',
      '\\usepackage{amsmath,amssymb}',
      '\\usepackage{booktabs}',
      '\\setbeamertemplate{navigation symbols}{}',
      `\\title{${headingTitle}}`,
      `\\author{${headingAuthors}}`,
      headingInstitute ? `\\institute{${headingInstitute}}` : '',
      '\\begin{document}',
      '\\begin{frame}[t]',
      '\\begin{columns}[t]',
      '\\begin{column}{.48\\textwidth}',
      ...left.map((block) => `\\begin{block}{${block.heading}}\n${block.body}\n\\end{block}`),
      '\\end{column}',
      '\\begin{column}{.48\\textwidth}',
      ...right.map((block) => `\\begin{block}{${block.heading}}\n${block.body}\n\\end{block}`),
      '\\end{column}',
      '\\end{columns}',
      '\\end{frame}',
      '\\end{document}',
      '',
    ].filter((line) => line !== '').join('\n')
  }

  if (template === 'baposter') {
    return [
      '% Generated by academic-harness presentation_build from the recorded outline.',
      '\\documentclass[a0paper,portrait]{baposter}',
      '\\usepackage{graphicx}',
      '\\usepackage{amsmath,amssymb}',
      '\\usepackage{booktabs}',
      '\\begin{document}',
      '\\begin{poster}{grid=false,columns=2,headerheight=0.12\\textheight,headershape=rounded,boxheaderheight=2em}',
      '{}',
      `{${headingTitle}}`,
      `{${headingAuthors}}`,
      `{${headingInstitute}}`,
      '{}',
      ...blocks.map((block, index) => `\\headerbox{${block.heading}}{name=b${index},column=${index % 2},row=${Math.floor(index / 2)}}{${block.body}}`),
      '\\end{poster}',
      '\\end{document}',
      '',
    ].filter((line) => line !== '').join('\n')
  }

  return [
    '% Generated by academic-harness presentation_build from the recorded outline.',
    '\\documentclass[25pt,a0paper,portrait,margin=10mm,innermargin=15mm,blockverticalspace=15mm,colspace=15mm,subcolspace=8mm]{tikzposter}',
    '\\usepackage{graphicx}',
    '\\usepackage{amsmath,amssymb}',
    '\\usepackage{booktabs}',
    '\\usetheme{Rays}',
    '\\usecolorstyle{Denmark}',
    `\\title{${headingTitle}}`,
    `\\author{${headingAuthors}}`,
    headingInstitute ? `\\institute{${headingInstitute}}` : '',
    '\\begin{document}',
    '\\maketitle',
    '\\begin{columns}',
    '\\column{0.5}',
    ...left.map((block) => `\\block{${block.heading}}{\n${block.body}\n}`),
    '\\column{0.5}',
    ...right.map((block) => `\\block{${block.heading}}{\n${block.body}\n}`),
    '\\end{columns}',
    '\\end{document}',
    '',
  ].filter((line) => line !== '').join('\n')
}

function slidesDocument({ style, title, authors, institute, date, sections, sourceKind }) {
  const theme = style === 'seminar' ? 'Madrid' : style === 'defense' ? 'Frankfurt' : 'Madrid'
  const color = style === 'conference' ? 'beaver' : style === 'seminar' ? 'dolphin' : 'whale'
  const frames = []
  for (const section of sections) {
    const content = [itemize(section.bullets, sourceKind, ''), figureLatex(section.figures, 'width=0.9\\textwidth,height=0.55\\textheight,keepaspectratio')]
      .filter(Boolean).join('\n\n')
    frames.push(
      `\\section{${latexInline(section.heading)}}`,
      '\\begin{frame}{' + latexInline(section.heading) + '}',
      content || '[Author content required for this section]',
      section.notes ? `\\note{${latexInline(section.notes)}}` : '',
      '\\end{frame}',
      '',
    )
  }
  return [
    '% Generated by academic-harness presentation_build from the recorded outline.',
    '\\documentclass[aspectratio=169,11pt]{beamer}',
    '\\usepackage[utf8]{inputenc}',
    '\\usepackage[T1]{fontenc}',
    '\\usepackage{graphicx}',
    '\\usepackage{amsmath,amssymb}',
    '\\usepackage{booktabs}',
    `\\usetheme{${theme}}`,
    `\\usecolortheme{${color}}`,
    '\\setbeamertemplate{navigation symbols}{}',
    '\\setbeamertemplate{footline}[frame number]',
    `\\title{${latexInline(title || 'Untitled presentation')}}`,
    `\\author{${latexInline(authors || '[Authors to be recorded]')}}`,
    institute ? `\\institute{${latexInline(institute)}}` : '',
    date ? `\\date{${latexInline(date)}}` : '',
    '\\begin{document}',
    '\\begin{frame}[plain]',
    '\\titlepage',
    '\\end{frame}',
    '\\begin{frame}{Outline}',
    '\\tableofcontents',
    '\\end{frame}',
    ...frames,
    '\\end{document}',
    '',
  ].filter((line) => line !== '').join('\n')
}

function pdfToPng(cwd, pdfRel) {
  const pdfAbs = resolveWorkspacePath(cwd, pdfRel)
  const stem = pdfAbs.replace(/\.pdf$/i, '')
  const result = spawnSync('pdftoppm', ['-png', '-r', '150', '-singlefile', pdfAbs, stem], {
    cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024, shell: false,
  })
  if (result.error?.code === 'ENOENT') return { png: null, note: 'pdftoppm is not installed; no PNG preview was written.' }
  if (result.status !== 0 || !existsSync(`${stem}.png`)) {
    return { png: null, note: `pdftoppm failed: ${(result.stderr || '').trim().slice(0, 500) || `exit ${result.status}`}` }
  }
  return { png: relative(cwd, `${stem}.png`), note: null }
}

function readBuild(cwd, slug, buildId) {
  const dir = join(storeDir(cwd, slug), 'builds')
  if (!existsSync(dir)) return null
  if (buildId) {
    if (!/^build-\d+$/.test(buildId)) throw new Error(`invalid build_id: ${buildId}`)
    const file = join(dir, buildId, 'build.json')
    return existsSync(file) ? readJson(file) : null
  }
  const builds = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  if (!builds.length) return null
  return readJson(join(dir, builds.at(-1), 'build.json'))
}

async function buildPresentation(args, cwd) {
  const action = args.action
  const slug = slugFrom(args)
  const buildId = `build-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`
  const dirRel = join('.dsh', 'presentation', slug, 'builds', buildId)
  const dirAbs = ensureDir(resolveWorkspacePath(cwd, dirRel, { forWrite: true }))
  const warnings = []
  const missingFigures = []

  let outline
  if (Array.isArray(args.sections) && args.sections.length) {
    outline = {
      title: text(args.title) || null,
      authors: text(args.authors) || null,
      institute: text(args.institute) || null,
      sections: normalizeSections(args.sections),
      sourceKind: 'text',
    }
  } else {
    if (!text(args.manuscript)) throw new Error('give manuscript or sections')
    const source = await readManuscript(cwd, text(args.manuscript))
    const ext = source.ext
    outline = ext === '.tex' ? texOutline(source.text)
      : (ext === '.md' || ext === '.markdown' ? markdownOutline(source.text) : plainOutline(source.text))
    outline.manuscript = text(args.manuscript)
    outline.sourceKind = ext === '.tex' ? 'tex' : 'text'
  }
  if (text(args.title)) outline.title = text(args.title)
  if (text(args.authors)) outline.authors = text(args.authors)
  if (text(args.institute)) outline.institute = text(args.institute)
  if (!outline.sections?.length) throw new Error('no sections were found; pass sections or a manuscript with headings')

  const figuresDir = ensureDir(join(dirAbs, 'figures'))
  const usedNames = new Set()
  const copied = []
  for (const section of outline.sections) {
    const resolved = []
    for (const raw of section.figures) {
      const found = resolveFigure(cwd, outline.manuscript ? resolveWorkspacePath(cwd, outline.manuscript) : null, raw)
      if (!found) { missingFigures.push(raw); warnings.push(`figure not found: ${raw}`); continue }
      const name = uniqueFigureName(usedNames, found.abs)
      copyFileSync(found.abs, join(figuresDir, name))
      copied.push({ source: found.rel, bundled: `figures/${name}`, sha256: `sha256:${hashFile(join(figuresDir, name))}` })
      resolved.push(`figures/${name}`)
    }
    section.figures = resolved
  }
  for (const raw of list(args.figures)) {
    const found = resolveFigure(cwd, outline.manuscript ? resolveWorkspacePath(cwd, outline.manuscript) : null, raw)
    if (!found) { missingFigures.push(raw); warnings.push(`figure not found: ${raw}`); continue }
    const name = uniqueFigureName(usedNames, found.abs)
    copyFileSync(found.abs, join(figuresDir, name))
    copied.push({ source: found.rel, bundled: `figures/${name}`, sha256: `sha256:${hashFile(join(figuresDir, name))}` })
    if (outline.sections[0]) outline.sections[0].figures.push(`figures/${name}`)
  }

  const metadata = {
    title: outline.title || 'Untitled presentation',
    authors: outline.authors || '[Authors to be recorded]',
    institute: outline.institute || null,
    date: text(args.date) || null,
  }
  let sourceRel
  let artifact = null
  let compile = null
  let png = null
  let pngNote = null

  if (action === 'poster') {
    const template = POSTER_TEMPLATES.includes(args.template) ? args.template : 'tikzposter'
    const body = posterDocument({ template, ...metadata, sections: outline.sections, sourceKind: outline.sourceKind })
    sourceRel = join(dirRel, 'poster.tex')
    exportText(join(dirAbs, 'poster.tex'), body, { overwrite: true })
    if (args.compile !== false) {
      compile = await compileLatex(cwd, sourceRel, args.engine || 'pdflatex')
      if (compile.success) {
        artifact = { kind: 'pdf', path: compile.pdf_path }
        ;({ png, note: pngNote } = pdfToPng(cwd, compile.pdf_path))
      }
    }
    artifact = artifact || { kind: 'tex', path: sourceRel }
  } else {
    const engine = SLIDE_ENGINES.includes(args.engine) ? args.engine : 'beamer'
    const style = SLIDE_STYLES.includes(args.style) ? args.style : 'conference'
    if (engine === 'pptx') {
      const outRel = join(dirRel, 'slides.pptx')
      const outAbs = resolveWorkspacePath(cwd, outRel, { forWrite: true })
      const helperResult = runHelper('presentation_helper.py', {
        out: outAbs,
        title: metadata.title,
        subtitle: text(args.subtitle) || '',
        authors: metadata.authors,
        sections: outline.sections.map((section) => ({
          ...section,
          figures: section.figures.map((figure) => join(dirAbs, figure)),
        })),
      })
      if (helperResult?.error) {
        if (helperResult.not_installed) {
          return {
            action, slug, build_id: buildId, not_installed: true,
            error: 'PowerPoint generation needs python-pptx in the helper environment (pip install python-pptx); nothing was generated.',
            warnings,
          }
        }
        throw new Error(helperResult.error)
      }
      artifact = { kind: 'pptx', path: outRel, slides: helperResult.slides }
      sourceRel = outRel
    } else {
      const body = slidesDocument({ ...metadata, style, sections: outline.sections, sourceKind: outline.sourceKind })
      sourceRel = join(dirRel, 'slides.tex')
      exportText(join(dirAbs, 'slides.tex'), body, { overwrite: true })
      if (args.compile !== false) {
        compile = await compileLatex(cwd, sourceRel, args.engine === 'pptx' ? 'pdflatex' : (args.engine || 'pdflatex'))
        if (compile.success) {
          artifact = { kind: 'pdf', path: compile.pdf_path }
          ;({ png, note: pngNote } = pdfToPng(cwd, compile.pdf_path))
        }
      }
      artifact = artifact || { kind: 'tex', path: sourceRel }
    }
  }
  if (png) {
    artifact.png = png
    artifact.png_note = 'PNG preview is page 1 only; render every page for visual QA.'
  }
  if (pngNote) warnings.push(pngNote)
  if (compile && !compile.success) warnings.push(`compile did not finish: ${compile.error || compile.log?.slice(-1200) || 'unknown error'}`)

  const build = {
    slug,
    build_id: buildId,
    action,
    created_at: nowIso(),
    manuscript: outline.manuscript || null,
    template: action === 'poster' ? (POSTER_TEMPLATES.includes(args.template) ? args.template : 'tikzposter') : (SLIDE_ENGINES.includes(args.engine) ? args.engine : 'beamer'),
    style: action === 'slides' ? (SLIDE_STYLES.includes(args.style) ? args.style : 'conference') : null,
    title: metadata.title,
    authors: metadata.authors,
    sections: outline.sections,
    figures: copied,
    missing_figures: [...new Set(missingFigures)],
    artifact,
    source: sourceRel,
    source_sha256: existsSync(resolveWorkspacePath(cwd, sourceRel)) ? `sha256:${hashFile(resolveWorkspacePath(cwd, sourceRel))}` : null,
    compile: compile ? { success: compile.success, error: compile.error || null, log_tail: compile.log ? compile.log.slice(-2000) : null } : null,
    warnings,
    note: 'Filled from the supplied outline and figures. A successful compile is not a visual QA pass; run qa and have the rendered pages reviewed.',
  }
  exportText(join(dirAbs, 'build.json'), `${JSON.stringify(build, null, 2)}\n`, { overwrite: true })
  return { action, ...build, dir: dirRel }
}

function qaChecklist(build) {
  const artifact = build?.artifact?.path || build?.source
  const lines = [
    `# Visual QA checklist — ${build?.slug || 'presentation'} (${build?.build_id || 'no build'})`,
    '',
    artifact ? `Artifact: \`${artifact}\`` : 'No artifact was found.',
    build?.artifact?.png ? `Preview: \`${build.artifact.png}\`` : null,
    '',
    'Render every PDF page at 150 DPI and delegate the images to `subagent_vision`; this tool does not claim the visual check passed.',
    '',
    '```sh',
    'pdftoppm -png -r 150 <deck>.pdf page',
    '```',
    '',
    'Check for:',
    '- Text overflow or clipping at the top, bottom, and right edges of every block or slide.',
    '- Figure legibility at print size, including axis labels, units, and panel letters.',
    '- Consistent capitalization, citation style, and abbreviations across panels.',
    '- Colour contrast and readability for greyscale printing and colour-vision deficiency.',
    '- Font sizes appropriate to the viewing distance (poster body ≥ 24 pt; slide body ≥ 18 pt).',
    '- Balanced whitespace, aligned blocks, and no orphaned headings.',
    '- Footer, funding, conflicts, and QR/contact information present where required.',
    '- No placeholder text such as "Author content required" left in the final file.',
    '',
    build?.missing_figures?.length
      ? `Missing figures recorded: ${build.missing_figures.join(', ')}.`
      : 'No missing figures were recorded at build time.',
    build?.warnings?.length ? `Build warnings:\n${build.warnings.map((warning) => `- ${warning}`).join('\n')}` : 'No build warnings were recorded.',
    '',
  ].filter((line) => line != null)
  return { markdown: lines.join('\n'), artifact }
}

function renderValue(value) {
  if (value?.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (value.action === 'poster' || value.action === 'slides') {
    const lines = [
      `${value.action === 'poster' ? 'Poster' : 'Slides'} ${value.build_id} for "${value.title}".`,
      `Source: ${value.source}${value.source_sha256 ? ` (${value.source_sha256.slice(0, 23)}…)` : ''}`,
    ]
    if (value.artifact) lines.push(`Artifact: ${value.artifact.path}${value.artifact.png ? ` · preview ${value.artifact.png}` : ''}`)
    if (value.missing_figures?.length) lines.push(`Missing figures: ${value.missing_figures.join(', ')}`)
    if (value.warnings?.length) lines.push('', ...value.warnings.map((warning) => `- ${warning}`))
    lines.push('', value.note)
    return [{ type: 'text', text: lines.join('\n') }]
  }
  if (value.action === 'status') {
    if (!value.builds.length) return [{ type: 'text', text: `No builds recorded for "${value.slug}".` }]
    return [{
      type: 'text',
      text: [
        `Presentation "${value.slug}": ${value.builds.length} build(s).`,
        ...value.builds.map((build) => `- ${build.build_id} · ${build.action} · ${build.artifact?.kind || 'source only'} · ${build.artifact?.path || build.source}${build.missing_figures?.length ? ` · ${build.missing_figures.length} missing figure(s)` : ''}${build.compile && !build.compile.success ? ' · compile failed' : ''}`),
      ].join('\n'),
    }]
  }
  if (value.action === 'qa') return [{ type: 'text', text: value.markdown }]
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

export async function runPresentationAction(args, exec) {
  const action = args.action || 'status'
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  if (action === 'poster' || action === 'slides') return buildPresentation(args, cwd)
  const slug = slugFrom(args)
  if (action === 'status') {
    const dir = join(storeDir(cwd, slug), 'builds')
    const builds = existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => readJson(join(dir, entry.name, 'build.json'))).filter(Boolean)
      : []
    return { action, slug, builds }
  }
  const build = readBuild(cwd, slug, text(args.build_id) || null)
  if (!build) throw new Error(`no build for "${slug}"${args.build_id ? ` and build_id ${args.build_id}` : ''}`)
  const qa = qaChecklist(build)
  exportText(join(storeDir(cwd, slug), 'qa.md'), qa.markdown, { overwrite: true })
  return { action, slug, build_id: build.build_id, markdown: qa.markdown, artifact: qa.artifact, qa_path: join('.dsh', 'presentation', slug, 'qa.md') }
}

export const name = 'academic-harness-presentation-build'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'presentation_build',
    description: [
      'Build a conference poster or slide deck from a manuscript or an explicit outline under `.dsh/presentation/<slug>/`.',
      `Actions: \`poster\` (${POSTER_TEMPLATES.join(', ')}; fills sections and figures, compiles PDF, and writes PNG when pdftoppm is available), \`slides\` (Beamer, or PowerPoint when python-pptx is installed), \`status\` (builds, artifacts, missing figures, compile failures), \`qa\` (a visual-QA checklist for the rendered pages and the \`subagent_vision\` review; it does not claim the check passed).`,
      'Content comes only from the supplied manuscript/sections and figure files; empty sections become explicit placeholders, never invented results. A successful compile is not a visual pass. If a template dependency is missing the tool reports not_installed. Load the `presentation-build` skill (which routes to `latex-posters` and `scientific-slides`).',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ACTIONS, description: 'poster, slides, status, or qa. Default status.' },
      slug: { type: 'string', description: 'Presentation slug; derived from manuscript/title when omitted.' },
      manuscript: { type: 'string', description: 'Workspace-relative .tex/.md/.txt/.docx/.pdf manuscript to derive sections from.' },
      title: { type: 'string', description: 'Title override.' },
      authors: { type: 'string', description: 'Authors line.' },
      institute: { type: 'string', description: 'Institute line.' },
      subtitle: { type: 'string', description: 'PPTX subtitle.' },
      date: { type: 'string', description: 'Date line for Beamer.' },
      sections: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'Explicit sections [{heading, bullets:[], figures:[], notes}]. Overrides manuscript parsing.',
      },
      figures: { type: 'array', items: { type: 'string' }, description: 'Additional workspace-relative figure paths.' },
      template: { type: 'string', enum: POSTER_TEMPLATES, description: 'poster: tikzposter (default), beamerposter, or baposter.' },
      engine: { type: 'string', enum: SLIDE_ENGINES, description: 'slides: beamer (default) or pptx.' },
      style: { type: 'string', enum: SLIDE_STYLES, description: 'slides: conference (default), seminar, or defense.' },
      compile: { type: 'boolean', description: 'Compile LaTeX output. Default true.' },
      build_id: { type: 'string', description: 'qa: build id (default latest).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return await runPresentationAction(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Presentation (${args.action || 'status'})`, kind: 'other' }
    },
  }))
}
