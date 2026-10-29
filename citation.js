/**
 * citation: format, export, and validate bibliographies.
 *
 * All parsing/formatting is local (citation-format.js). Network is used only
 * for DOI input (Crossref content negotiation) and optional DOI checks.
 */
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { resolveWorkspacePath } from './paper-download.js'
import { libraryRecords } from './papermemory-library.js'
import { fetchJson, fetchText, getLimiter, searchUserAgent } from './search-http.js'
import { canonicalDoi, normalizeTitle } from './search-normalize.js'
import {
  SUPPORTED_STYLES, formatBibliography, formatCitations, normalizeCsl,
  parseBibtex, parseInput, toBibtex, toRis, validateRecords,
} from './citation-format.js'

const CROSSREF_WORKS = 'https://api.crossref.org/works'
const MAX_INPUT_BYTES = 10 * 1024 * 1024

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
  if (existsSync(target)) {
    const realRoot = realpathSync(root)
    const targetRel = relative(realRoot, realpathSync(target))
    if (targetRel.startsWith('..') || isAbsolute(targetRel)) throw new Error(`path escapes the workspace: ${path}`)
  }
  return target
}

function readWorkspaceText(cwd, path) {
  const target = resolveReadPath(cwd, path)
  const size = statSync(target).size
  if (size > MAX_INPUT_BYTES) throw new Error(`citation input is larger than ${MAX_INPUT_BYTES / (1024 * 1024)}MB: ${path}`)
  return readFileSync(target, 'utf8')
}

function writeWorkspaceText(cwd, path, body) {
  const target = resolveWorkspacePath(cwd, path)
  writeFileSync(target, body)
  return target
}

function doiList(value) {
  const raw = Array.isArray(value) ? value : (value ? [value] : [])
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const doi = canonicalDoi(item)
    if (doi && !seen.has(doi)) {
      seen.add(doi)
      out.push(doi)
    }
  }
  return out
}

async function crossrefContact() {
  return await resolveEnv('CROSSREF_MAILTO') || await resolveEnv('UNPAYWALL_EMAIL') || ''
}

async function fetchDoiBibtex(doi, exec) {
  const mailto = await crossrefContact()
  const params = new URLSearchParams()
  if (mailto) params.set('mailto', mailto)
  const query = params.toString()
  const url = `${CROSSREF_WORKS}/${encodeURIComponent(doi)}/transform/application/x-bibtex${query ? `?${query}` : ''}`
  const limiter = getLimiter('crossref-single', { minIntervalMs: mailto ? 100 : 200 })
  const result = await limiter.run(() => fetchText(url, {
    signal: exec?.signal,
    timeoutMs: 20_000,
    retries: 1,
    headers: {
      'User-Agent': searchUserAgent(mailto),
      Accept: 'application/x-bibtex',
    },
  }))
  if (!result.ok) {
    if (result.error === 'aborted') throw new Error('request cancelled')
    throw new Error(`Crossref BibTeX lookup failed for ${doi}: HTTP ${result.status}${result.detail ? ` (${result.detail})` : ''}`)
  }
  const body = String(result.data || '').trim()
  if (!body.startsWith('@')) {
    throw new Error(`Crossref returned no BibTeX for ${doi}; the DOI may not be registered or may be invalid`)
  }
  return body
}

async function fetchCrossrefWork(doi, exec) {
  const mailto = await crossrefContact()
  const params = new URLSearchParams()
  if (mailto) params.set('mailto', mailto)
  const query = params.toString()
  const url = `${CROSSREF_WORKS}/${encodeURIComponent(doi)}${query ? `?${query}` : ''}`
  const limiter = getLimiter('crossref-single', { minIntervalMs: mailto ? 100 : 200 })
  const result = await limiter.run(() => fetchJson(url, {
    signal: exec?.signal,
    timeoutMs: 20_000,
    retries: 1,
    headers: { 'User-Agent': searchUserAgent(mailto) },
  }))
  if (!result.ok) return { ok: false, error: result.error, status: result.status, detail: result.detail }
  return { ok: true, work: result.data?.message || null }
}

/** Token-overlap check used by optional DOI verification. */
export function titleMatches(expected, actual) {
  const a = normalizeTitle(expected)
  const b = normalizeTitle(actual)
  if (!a || !b) return true
  if (a === b || a.includes(b) || b.includes(a)) return true
  const aTokens = a.split(/\s+/).filter(Boolean)
  const bTokens = b.split(/\s+/).filter(Boolean)
  if (!aTokens.length || !bTokens.length) return true
  const set = new Set(aTokens)
  const overlap = bTokens.filter((token) => set.has(token)).length
  return overlap / Math.max(aTokens.length, bTokens.length) >= 0.6
}

async function loadRecords(args, exec) {
  if (Array.isArray(args.records) && args.records.length) {
    return normalizeCsl(args.records)
  }
  if (args.library && typeof args.library === 'object') {
    const scope = args.library
    if (!(scope.query || scope.collection || scope.project || scope.cited_only || scope.all)) {
      throw new Error('library needs a scope: query, collection, project, cited_only, or all')
    }
    const loaded = await libraryRecords(scope, { cwd: workspaceRoot(exec), signal: exec?.signal })
    if (!loaded.ok) throw new Error(`reference library unavailable (${loaded.code}): ${loaded.error}`)
    return normalizeCsl(loaded.records)
  }
  const dois = doiList(args.doi)
  if (dois.length) {
    const bibtex = []
    for (const doi of dois) bibtex.push(await fetchDoiBibtex(doi, exec))
    return parseBibtex(bibtex.join('\n\n'))
  }
  if (args.doi) throw new Error('no valid DOI given (expected a DOI such as 10.1000/xyz or a doi.org URL)')
  const cwd = workspaceRoot(exec)
  if (typeof args.text === 'string' && args.text.trim()) return parseInput(args.text, args.input_format)
  if (typeof args.path === 'string' && args.path.trim()) {
    return parseInput(readWorkspaceText(cwd, args.path), args.input_format)
  }
  throw new Error('give records, doi, text, path, or library')
}

async function checkDois(records, exec) {
  const warnings = []
  const checked = []
  const seen = new Set()
  for (const record of records) {
    const doi = canonicalDoi(record.DOI)
    if (!doi || seen.has(doi)) continue
    seen.add(doi)
    const result = await fetchCrossrefWork(doi, exec)
    if (!result.ok) {
      warnings.push(`${doi}: Crossref lookup failed (${result.error || `HTTP ${result.status}`}); DOI existence is unverified`)
      continue
    }
    const published = result.work?.title?.[0] || result.work?.title || ''
    if (record.title && published && !titleMatches(record.title, published)) {
      warnings.push(`${doi}: Crossref title "${published}" does not match "${record.title}"`)
    } else {
      checked.push(doi)
    }
  }
  return { warnings, checked }
}

function renderCitation(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (value.action === 'validate') {
    const lines = [
      `Citation validation: ${value.count} record(s), ${value.errors.length} error(s), ${value.warnings.length} warning(s)`,
    ]
    for (const error of value.errors) lines.push(`- ERROR: ${error}`)
    for (const warning of value.warnings) lines.push(`- WARNING: ${warning}`)
    for (const duplicate of value.duplicates) {
      lines.push(`- DUPLICATE ${duplicate.field} "${duplicate.value}": ${duplicate.entries.join(', ')}`)
    }
    if (value.doi_checks?.length) lines.push(`- DOI checks passed: ${value.doi_checks.join(', ')}`)
    if (!value.errors.length && !value.warnings.length && !value.duplicates.length) lines.push('- No issues found.')
    return [{ type: 'text', text: lines.join('\n') }]
  }
  if (value.output_path) {
    return [{
      type: 'text',
      text: `Wrote ${value.count} ${value.action === 'format' ? 'bibliography entry/entries' : value.action.toUpperCase()} to ${value.output_path}.`,
    }]
  }
  const body = value.action === 'format'
    ? [value.bibliography, value.in_text ? `In-text: ${value.in_text}` : ''].filter(Boolean).join('\n\n')
    : (value.bibtex || value.ris || '')
  return [{ type: 'text', text: body || 'No citation output.' }]
}

export async function runCitation(args, exec) {
  const action = args.action || 'format'
  if (!['format', 'bibtex', 'ris', 'validate'].includes(action)) {
    throw new Error('action must be format, bibtex, ris, or validate')
  }
  const records = await loadRecords(args, exec)
  if (!records.length) throw new Error('no citation records found')

  if (action === 'validate') {
    const result = validateRecords(records)
    let doiCheck = { warnings: [], checked: [] }
    if (args.check_dois) {
      doiCheck = await checkDois(result.entries, exec)
    }
    return {
      action,
      count: records.length,
      errors: result.errors,
      warnings: [...result.warnings, ...doiCheck.warnings],
      duplicates: result.duplicates,
      doi_checks: doiCheck.checked,
    }
  }

  if (action === 'bibtex' || action === 'ris') {
    const textOut = action === 'bibtex' ? toBibtex(records) : toRis(records)
    const value = { action, count: records.length, [action]: textOut }
    if (typeof args.output_path === 'string' && args.output_path.trim()) {
      writeWorkspaceText(workspaceRoot(exec), args.output_path, `${textOut}\n`)
      value.output_path = args.output_path
    }
    return value
  }

  const style = args.style || 'apa'
  const locale = args.locale || 'en-US'
  const bibliography = formatBibliography(records, { style, locale })
  const inText = args.include_in_text ? formatCitations(records, { style, locale }) : ''
  const value = { action, style, locale, count: records.length, bibliography, in_text: inText || null }
  if (typeof args.output_path === 'string' && args.output_path.trim()) {
    writeWorkspaceText(workspaceRoot(exec), args.output_path, `${bibliography}\n`)
    value.output_path = args.output_path
  }
  return value
}

export const name = 'academic-harness-citation'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'citation',
    description: [
      'Format, export, or validate citations and bibliographies.',
      '`format` renders a bibliography in APA (default), Vancouver, Harvard, IEEE, Chicago author-date, or MLA, with optional in-text markers. `bibtex` and `ris` produce reference-manager files from records, BibTeX/RIS text, or DOIs (Crossref content negotiation). `validate` reports missing fields, duplicate DOIs/keys, and optionally checks each DOI against Crossref.',
      'Accepts CSL-JSON records, BibTeX, RIS, a workspace path, or `library` (papers from the PaperMemory reference library, under its own keys; to write a project .bib use `papermemory_library` export). No key; set CROSSREF_MAILTO (or UNPAYWALL_EMAIL) for the Crossref polite pool. Use this instead of hand-writing bibliography entries or citation keys.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ['format', 'bibtex', 'ris', 'validate'],
        description: 'format (bibliography), bibtex, ris, or validate. Default format.',
      },
      records: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'CSL-JSON records. Takes precedence over doi/text/path.',
      },
      library: {
        type: 'object',
        additionalProperties: false,
        description: 'Use papers from the PaperMemory reference library as the records (keys are the library\'s own). Give one scope.',
        properties: {
          query: { type: 'string', description: 'Library filters, e.g. "tag:ml year:2020.. has:doi".' },
          collection: { type: 'string' },
          project: { type: 'string', description: 'Papers of this project, under that project\'s own citation keys.' },
          cited_only: { type: 'string', description: 'Only the papers this manuscript cites.' },
          all: { type: 'boolean' },
          variant: { type: 'string', enum: ['project', 'canonical'] },
        },
      },
      doi: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'DOI or DOIs to fetch as BibTeX from Crossref before formatting/validating.',
      },
      text: { type: 'string', description: 'BibTeX, RIS, or CSL-JSON text.' },
      path: { type: 'string', description: 'Workspace-relative file containing BibTeX, RIS, or CSL-JSON.' },
      input_format: {
        type: 'string',
        enum: ['auto', 'bibtex', 'ris', 'csl-json'],
        description: 'Input format for text/path. Default auto.',
      },
      style: {
        type: 'string',
        enum: Object.keys(SUPPORTED_STYLES),
        description: 'CSL style for format. Default apa.',
      },
      locale: { type: 'string', description: 'CSL locale, e.g. en-US. Default en-US.' },
      include_in_text: { type: 'boolean', description: 'Also return in-text citation markers (format action).' },
      check_dois: { type: 'boolean', description: 'Validate DOIs against Crossref (validate action). Adds network calls, one per DOI.' },
      output_path: { type: 'string', description: 'Workspace-relative path to write the output. For format, writes the bibliography only.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderCitation(value),
    },
    async execute(args, exec) {
      try {
        return await runCitation(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Citation: ${args.action || 'format'}`, kind: 'other' }
    },
  }))
}
