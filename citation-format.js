/**
 * Pure citation utilities: BibTeX/RIS/CSL parsing, deterministic citation keys,
 * BibTeX/RIS writing, CSL bibliography formatting, and validation.
 *
 * No network and no DSH imports, so the whole module is fixture-testable.
 * CSL formatting uses citation-js; APA/Vancouver/Harvard1 ship with its CSL
 * plugin, and IEEE/Chicago author-date/MLA are vendored under styles/ (CSL
 * style repository, CC BY-SA 3.0 — see styles/README.md).
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { canonicalDoi, normalizeTitle } from './search-normalize.js'

const require = createRequire(import.meta.url)
const { Cite, plugins } = require('@citation-js/core')
require('@citation-js/plugin-bibtex')
require('@citation-js/plugin-csl')
require('@citation-js/plugin-ris')

const CSL = plugins.config.get('@csl')
const BUNDLED_STYLES = {
  apa: { template: 'apa', label: 'APA' },
  vancouver: { template: 'vancouver', label: 'Vancouver' },
  harvard1: { template: 'harvard1', label: 'Harvard' },
}
const VENDORED_STYLES = {
  ieee: { template: 'ieee', label: 'IEEE', file: 'ieee.csl' },
  'chicago-author-date': { template: 'chicago-author-date', label: 'Chicago author-date', file: 'chicago-author-date.csl' },
  mla: { template: 'modern-language-association', label: 'MLA', file: 'modern-language-association.csl' },
}
for (const [name, style] of Object.entries(VENDORED_STYLES)) {
  try {
    if (!CSL.styles.has(style.template)) {
      CSL.styles.add(style.template, readFileSync(new URL(`./styles/${style.file}`, import.meta.url), 'utf8'))
    }
  } catch (error) {
    console.warn(`[academic-harness] CSL style ${name} is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Canonical style names exposed by the `citation` tool. */
export const SUPPORTED_STYLES = {}
for (const [name, style] of Object.entries(BUNDLED_STYLES)) {
  if (CSL.styles.has(style.template)) SUPPORTED_STYLES[name] = { template: style.template, label: style.label }
}
for (const [name, style] of Object.entries(VENDORED_STYLES)) {
  if (CSL.styles.has(style.template)) SUPPORTED_STYLES[name] = { template: style.template, label: style.label }
}

const CUSTOM_STYLES = new Map()
const MAX_CSL_BYTES = 1024 * 1024

/** Validate one CSL style before registering it. Returns warnings, not a verdict. */
export function validateCslStyle(xml) {
  const body = typeof xml === 'string' ? xml : ''
  if (!body.trim()) throw new Error('CSL style is empty')
  if (Buffer.byteLength(body) > MAX_CSL_BYTES) throw new Error(`CSL style is larger than ${MAX_CSL_BYTES / 1024}KB`)
  if (/<!DOCTYPE|<!ENTITY|<script\b/i.test(body)) throw new Error('CSL style contains a DTD, entity declaration, or script; refusing to load it')
  const root = body.match(/<style\b([^>]*)>/i)
  if (!root) throw new Error('CSL style has no <style> root element')
  if (!/xmlns\s*=\s*["']http:\/\/purl\.org\/net\/xbiblio\/csl["']/i.test(root[1])) {
    throw new Error('CSL style is missing the CSL namespace (http://purl.org/net/xbiblio/csl)')
  }
  const version = root[1].match(/version\s*=\s*["']([^"']+)["']/i)?.[1] || null
  if (!version) throw new Error('CSL style is missing a version attribute (expected 1.0 or 1.0.x)')
  if (!/^1\.0(?:\.\d+)?$/.test(version)) throw new Error(`unsupported CSL version: ${version}`)
  if (!/<citation\b[\s\S]*?<\/citation>/i.test(body)) throw new Error('CSL style has no <citation> block')
  const warnings = []
  if (!/<bibliography\b[\s\S]*?<\/bibliography>/i.test(body)) {
    warnings.push('the style has no <bibliography> block; bibliography formatting may fail')
  }
  return {
    ok: true,
    id: root[1].match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1] || null,
    version,
    warnings,
  }
}

/** Register a validated CSL style under a deterministic name; no network. */
export function registerCslStyle({ name, xml, label = null }) {
  const clean = text(name).toLowerCase()
  if (!/^custom-[a-z0-9-]+$/.test(clean)) throw new Error(`custom CSL style name must look like custom-<id>: ${name}`)
  const validation = validateCslStyle(xml)
  if (CSL.styles.has(clean)) {
    CUSTOM_STYLES.set(clean, { template: clean, label: label || clean })
    return { name: clean, ...validation }
  }
  try {
    CSL.styles.add(clean, xml)
  } catch (error) {
    throw new Error(`CSL style was not accepted by the formatter: ${error instanceof Error ? error.message : String(error)}`)
  }
  CUSTOM_STYLES.set(clean, { template: clean, label: label || clean })
  return { name: clean, ...validation }
}

const STYLE_ALIASES = {
  apa7: 'apa',
  harvard: 'harvard1',
  chicago: 'chicago-author-date',
  'modern-language-association': 'mla',
}

const CSL_TYPES = new Set([
  'article', 'article-journal', 'article-magazine', 'article-newspaper', 'book',
  'chapter', 'dataset', 'entry-dictionary', 'entry-encyclopedia', 'figure',
  'graphic', 'interview', 'legal_case', 'legislation', 'manuscript', 'map',
  'motion_picture', 'paper-conference', 'patent', 'personal_communication',
  'post', 'post-weblog', 'report', 'review', 'review-book', 'software', 'song',
  'speech', 'standard', 'thesis', 'treaty', 'webpage',
])

const TYPE_ALIASES = {
  'journal-article': 'article-journal',
  journalarticle: 'article-journal',
  journal_article: 'article-journal',
  'conference-paper': 'paper-conference',
  conferencepaper: 'paper-conference',
  'book-chapter': 'chapter',
  bookchapter: 'chapter',
  booksection: 'chapter',
  dissertation: 'thesis',
  preprint: 'article',
  workingpaper: 'report',
  techreport: 'report',
  'web-page': 'webpage',
}

function text(value) {
  if (value == null) return ''
  if (Array.isArray(value)) return text(value[0])
  return decodeEntities(String(value))
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function stripInternal(record) {
  const out = {}
  for (const [key, value] of Object.entries(record || {})) {
    if (key.startsWith('_')) continue
    if (key === 'id' && typeof value === 'string' && value.startsWith('temp_id_')) continue
    out[key] = value
  }
  return out
}

const ORG_PATTERN = /\b(organization|organisation|university|institute|consortium|group|committee|department|agency|center|centre|inc|ltd|corporation|association)\b/i

function splitAuthorString(value) {
  return String(value).split(/\s+and\s+/i).map((part) => part.trim()).filter(Boolean)
}

function authorFromString(value) {
  const raw = value.trim()
  if (!raw) return null
  if (raw.includes(',')) {
    const [family, ...given] = raw.split(',')
    return { family: family.trim(), given: given.join(',').trim() || undefined }
  }
  const parts = raw.split(/\s+/)
  if (parts.length === 1 || ORG_PATTERN.test(raw)) return { literal: raw }
  return { family: parts.pop(), given: parts.join(' ') }
}

function normalizeName(value) {
  if (value == null) return null
  if (typeof value === 'string') return authorFromString(value)
  if (typeof value !== 'object') return null
  if (value.literal) return { literal: text(value.literal) }
  if (value.name) {
    const name = text(value.name)
    if (!name || ORG_PATTERN.test(name) || name.split(/\s+/).length === 1) return { literal: name }
    return authorFromString(name)
  }
  if (value.family || value.given) {
    const family = text(value.family)
    const given = text(value.given)
    if (family && given) return { family, given }
    if (family) return { family }
    return { literal: given }
  }
  return null
}

function normalizeNames(value) {
  if (value == null) return []
  const raw = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? splitAuthorString(value) : [value])
  return raw.map(normalizeName).filter(Boolean)
}

function dateParts(value) {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(value['date-parts']) && value['date-parts'].length) {
      const parts = value['date-parts'][0].map((part) => Number(part)).filter(Number.isFinite)
      if (parts.length) return [parts.slice(0, 3)]
    }
    if (value.raw) return dateParts(String(value.raw))
    if (value.literal) return dateParts(String(value.literal))
  }
  if (Array.isArray(value)) {
    const parts = value.map((part) => Number(part)).filter(Number.isFinite)
    return parts.length ? [parts.slice(0, 3)] : null
  }
  const raw = String(value)
  const iso = raw.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/)
  if (iso) {
    const parts = [Number(iso[1])]
    if (iso[2]) parts.push(Number(iso[2]))
    if (iso[3]) parts.push(Number(iso[3]))
    return [parts]
  }
  const year = raw.match(/(\d{4})/)
  if (!year) return null
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const lower = raw.toLowerCase()
  const month = months.findIndex((name) => lower.includes(name))
  return month >= 0 ? [[Number(year[1]), month + 1]] : [[Number(year[1])]]
}

function issuedOf(record) {
  if (record.issued) {
    const parts = dateParts(record.issued)
    if (parts) return { 'date-parts': parts }
    return record.issued
  }
  const parts = dateParts(record.year ?? record.publication_year ?? record.date ?? record.published)
  return parts ? { 'date-parts': parts } : undefined
}

function normalizeType(value) {
  const raw = text(value).toLowerCase()
  const mapped = TYPE_ALIASES[raw] || raw
  return CSL_TYPES.has(mapped) ? mapped : 'article'
}

function firstText(...values) {
  for (const value of values) {
    const out = text(value)
    if (out) return out
  }
  return undefined
}

/** Convert arbitrary records into a predictable CSL-JSON shape. */
export function normalizeCsl(records) {
  const list = Array.isArray(records) ? records : (records == null ? [] : [records])
  return list.filter((record) => record && typeof record === 'object').map((record, index) => {
    const out = { ...record }
    out.type = normalizeType(record.type)
    out.title = text(record.title) || undefined
    const authorInput = (Array.isArray(record.author) && record.author.length)
      ? record.author
      : (record.authors ?? record.creators ?? record.author)
    out.author = normalizeNames(authorInput)
    if (!out.author.length) delete out.author
    const editorInput = (Array.isArray(record.editor) && record.editor.length)
      ? record.editor
      : (record.editors ?? record.editor)
    if (editorInput != null) {
      out.editor = normalizeNames(editorInput)
      if (!out.editor.length) delete out.editor
    }
    const issued = issuedOf(record)
    if (issued) out.issued = issued
    else delete out.issued
    out['container-title'] = firstText(
      record['container-title'], record.containerTitle, record.venue, record.journal,
      record.publicationTitle, record.bookTitle, record.conferenceName,
    )
    if (!out['container-title']) delete out['container-title']
    out.publisher = firstText(record.publisher, record.university, record.institution)
    if (!out.publisher) delete out.publisher
    out['publisher-place'] = firstText(record['publisher-place'], record.address, record.place)
    if (!out['publisher-place']) delete out['publisher-place']
    out.page = firstText(record.page, record.pages)
    if (!out.page) delete out.page
    out.volume = firstText(record.volume)
    if (!out.volume) delete out.volume
    out.issue = firstText(record.issue, record.number)
    if (!out.issue) delete out.issue
    const doi = text(record.DOI ?? record.doi)
    if (doi) out.DOI = canonicalDoi(doi) || doi
    else delete out.DOI
    out.URL = firstText(record.URL, record.url)
    if (!out.URL) delete out.URL
    out.abstract = firstText(record.abstract, record.abstractNote)
    if (!out.abstract) delete out.abstract
    out.language = firstText(record.language)
    if (!out.language) delete out.language
    out.keyword = firstText(
      record.keyword,
      Array.isArray(record.tags) ? record.tags.map((tag) => text(tag?.tag ?? tag)).filter(Boolean).join('; ') : record.tags,
    )
    if (!out.keyword) delete out.keyword
    out.genre = firstText(record.genre)
    if (!out.genre) delete out.genre
    out.id = text(record.id) || text(record['citation-key']) || `rec-${index + 1}`
    const key = text(record['citation-key'] ?? record.citationKey)
    if (key) out['citation-key'] = key
    else delete out['citation-key']
    return out
  })
}

function slugWord(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '')
    .toLowerCase()
}

function yearOf(record) {
  const parts = record.issued?.['date-parts']?.[0]
  return Number(parts?.[0]) || null
}

/** Deterministic BibTeX-style key: family + year + first title word. */
export function makeCitationKey(record) {
  const author = record.author?.[0]
  const family = slugWord(author?.family || author?.literal || 'anon') || 'anon'
  const year = yearOf(record) || 'nd'
  const stop = new Set(['a', 'an', 'the', 'on', 'of', 'for', 'and', 'in', 'to', 'with', 'from'])
  const titleWords = String(record.title || 'untitled')
    .split(/\s+/)
    .map(slugWord)
    .filter(Boolean)
  const titleWord = titleWords.find((word) => word.length > 2 && !stop.has(word)) || titleWords[0] || 'untitled'
  let key = `${family}${year}${titleWord}`.slice(0, 48)
  if (/^\d/.test(key)) key = `ref${key}`
  return key
}

function sanitizeKey(value) {
  const raw = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9:_-]/g, '')
  if (!raw) return ''
  return /^\d/.test(raw) ? `ref${raw}` : raw
}

/** Assign unique ids and deterministic citation keys without mutating input. */
export function assignCitationKeys(records) {
  const prepared = normalizeCsl(records)
  const usedKeys = new Set()
  const usedIds = new Set()
  return prepared.map((record, index) => {
    const out = { ...record }
    let baseKey = sanitizeKey(out['citation-key']) || makeCitationKey(out)
    if (!baseKey) baseKey = `ref${index + 1}`
    let key = baseKey
    let suffix = 0
    while (usedKeys.has(key)) {
      key = `${baseKey}${String.fromCharCode(97 + (suffix % 26))}`
      suffix += 1
    }
    usedKeys.add(key)
    out['citation-key'] = key
    const baseId = text(out.id) || key
    let id = baseId
    let idSuffix = 1
    while (usedIds.has(id)) {
      idSuffix += 1
      id = `${baseId}-${idSuffix}`
    }
    usedIds.add(id)
    out.id = id
    return out
  })
}

function resolveStyleName(style) {
  const raw = text(style || 'apa').toLowerCase()
  const canonical = STYLE_ALIASES[raw] || raw
  if (CUSTOM_STYLES.has(canonical)) return { canonical, ...CUSTOM_STYLES.get(canonical) }
  if (!SUPPORTED_STYLES[canonical]) {
    throw new Error(`unsupported citation style "${style}". Supported: ${Object.keys(SUPPORTED_STYLES).join(', ')}`)
  }
  return { canonical, ...SUPPORTED_STYLES[canonical] }
}

function citeFor(records) {
  return new Cite(assignCitationKeys(records))
}

/** Format a bibliography in a supported CSL style. */
export function formatBibliography(records, { style = 'apa', locale = 'en-US' } = {}) {
  const resolved = resolveStyleName(style)
  if (!Array.isArray(records) || records.length === 0) return ''
  try {
    const output = citeFor(records).format('bibliography', {
      format: 'text',
      template: resolved.template,
      lang: text(locale) || 'en-US',
    })
    return String(output || '').trim()
  } catch (error) {
    throw new Error(`CSL bibliography formatting failed for style "${style}": ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Format in-text citation markers in a supported CSL style. */
export function formatCitations(records, { style = 'apa', locale = 'en-US' } = {}) {
  const resolved = resolveStyleName(style)
  if (!Array.isArray(records) || records.length === 0) return ''
  try {
    const output = citeFor(records).format('citation', {
      format: 'text',
      template: resolved.template,
      lang: text(locale) || 'en-US',
    })
    return String(output || '').trim()
  } catch (error) {
    throw new Error(`CSL citation formatting failed for style "${style}": ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function parseBibtex(value) {
  const source = String(value || '').trim()
  if (!source) throw new Error('no BibTeX text given')
  try {
    const cite = new Cite(source, { forceType: '@bibtex/text' })
    return normalizeCsl(cite.data.map(stripInternal))
  } catch (error) {
    throw new Error(`could not parse BibTeX: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function parseRis(value) {
  const source = String(value || '').trim()
  if (!source) throw new Error('no RIS text given')
  try {
    const cite = new Cite(source, { forceType: '@ris/file' })
    return normalizeCsl(cite.data.map(stripInternal))
  } catch (error) {
    throw new Error(`could not parse RIS: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function parseCslJson(value) {
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch (error) {
      throw new Error(`could not parse CSL-JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.items)) parsed = parsed.items
  if (parsed && !Array.isArray(parsed)) parsed = [parsed]
  if (!Array.isArray(parsed)) throw new Error('CSL-JSON must be an array of records or an object with an items array')
  return normalizeCsl(parsed)
}

/** Parse text, auto-detecting BibTeX, RIS, or CSL-JSON. */
export function parseInput(value, format) {
  const kind = text(format).toLowerCase()
  const source = String(value ?? '')
  if (kind === 'bibtex' || kind === 'bib') return parseBibtex(source)
  if (kind === 'ris') return parseRis(source)
  if (kind === 'csl' || kind === 'csl-json' || kind === 'json') return parseCslJson(source)
  const trimmed = source.trim()
  if (!trimmed) throw new Error('no citation text given')
  if (trimmed.startsWith('@')) return parseBibtex(source)
  if (trimmed.startsWith('TY  -') || trimmed.startsWith('TY -')) return parseRis(source)
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return parseCslJson(source)
    } catch {
      // fall through to BibTeX/RIS
    }
  }
  try {
    return parseBibtex(source)
  } catch (bibtexError) {
    try {
      return parseRis(source)
    } catch {
      throw bibtexError
    }
  }
}

function escapeBibtex(value, { url = false } = {}) {
  const cleaned = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (url) return cleaned.replace(/[{}]/g, '')
  return cleaned
    .replace(/([&%$#_])/g, '\\$1')
    .replace(/[{}]/g, (brace) => (brace === '{' ? '\\{' : '\\}'))
}

function bibtexAuthor(author) {
  if (author.literal) return `{${escapeBibtex(author.literal)}}`
  if (author.family && author.given) return `${escapeBibtex(author.family)}, ${escapeBibtex(author.given)}`
  if (author.family) return escapeBibtex(author.family)
  return escapeBibtex(author.given || '')
}

function bibtexEntryType(record) {
  switch (record.type) {
    case 'article-journal': return 'article'
    case 'paper-conference': return 'inproceedings'
    case 'chapter': return 'incollection'
    case 'book': return 'book'
    case 'thesis': return /master/i.test(record.genre || '') ? 'mastersthesis' : 'phdthesis'
    case 'report': return 'techreport'
    default: return 'misc'
  }
}

/** Deterministic BibTeX export. */
export function toBibtex(records) {
  const prepared = assignCitationKeys(records)
  return prepared.map((record) => {
    const fields = []
    const authors = (record.author || []).map(bibtexAuthor).filter(Boolean)
    if (authors.length) fields.push(['author', authors.join(' and ')])
    if (record.title) fields.push(['title', escapeBibtex(record.title)])
    if (record['container-title']) {
      const field = record.type === 'article-journal' ? 'journal'
        : (record.type === 'paper-conference' || record.type === 'chapter' ? 'booktitle' : 'howpublished')
      fields.push([field, escapeBibtex(record['container-title'])])
    }
    const year = yearOf(record)
    if (year) fields.push(['year', String(year)])
    if (record.volume) fields.push(['volume', escapeBibtex(record.volume)])
    if (record.issue) fields.push(['number', escapeBibtex(record.issue)])
    if (record.page) fields.push(['pages', escapeBibtex(String(record.page).replace(/--/g, '-'))])
    if (record.publisher) {
      const field = record.type === 'thesis' ? 'school'
        : (record.type === 'report' ? 'institution' : 'publisher')
      fields.push([field, escapeBibtex(record.publisher)])
    }
    if (record['publisher-place']) fields.push(['address', escapeBibtex(record['publisher-place'])])
    if (record.DOI) fields.push(['doi', escapeBibtex(record.DOI, { url: true })])
    if (record.URL) fields.push(['url', escapeBibtex(record.URL, { url: true })])
    if (record.keyword) fields.push(['keywords', escapeBibtex(record.keyword)])
    const body = fields.map(([key, value]) => `  ${key} = {${value}}`).join(',\n')
    return `@${bibtexEntryType(record)}{${record['citation-key']},\n${body}\n}`
  }).join('\n\n')
}

const RIS_TYPES = {
  article: 'JOUR',
  'article-journal': 'JOUR',
  'article-magazine': 'MGZN',
  'article-newspaper': 'NEWS',
  'paper-conference': 'CPAPER',
  chapter: 'CHAP',
  book: 'BOOK',
  thesis: 'THES',
  report: 'RPRT',
  webpage: 'ELEC',
  dataset: 'DATA',
  software: 'COMP',
  patent: 'PAT',
}

function risAuthor(author) {
  if (author.literal) return author.literal
  if (author.family && author.given) return `${author.family}, ${author.given}`
  return author.family || author.given || ''
}

/** Deterministic RIS export. */
export function toRis(records) {
  const prepared = assignCitationKeys(records)
  return prepared.map((record) => {
    const lines = [`TY  - ${RIS_TYPES[record.type] || 'GEN'}`]
    for (const author of record.author || []) {
      const value = risAuthor(author)
      if (value) lines.push(`AU  - ${value}`)
    }
    if (record.title) lines.push(`TI  - ${record.title}`)
    if (record['container-title']) lines.push(`T2  - ${record['container-title']}`)
    const year = yearOf(record)
    if (year) lines.push(`PY  - ${year}`)
    if (record.volume) lines.push(`VL  - ${record.volume}`)
    if (record.issue) lines.push(`IS  - ${record.issue}`)
    if (record.page) {
      const [start, end] = String(record.page).replace(/--/g, '-').split('-').map((part) => part.trim())
      if (start) lines.push(`SP  - ${start}`)
      if (end) lines.push(`EP  - ${end}`)
    }
    if (record.publisher) lines.push(`PB  - ${record.publisher}`)
    if (record.DOI) lines.push(`DO  - ${record.DOI}`)
    if (record.URL) lines.push(`UR  - ${record.URL}`)
    if (record.abstract) lines.push(`AB  - ${record.abstract.slice(0, 2000)}`)
    if (record.keyword) lines.push(`KW  - ${record.keyword}`)
    lines.push('ER  - ')
    return lines.join('\n')
  }).join('\n\n')
}

function labelOf(record) {
  return record['citation-key'] || record.title || record.id
}

/** Validate normalized records and report duplicate identifiers. */
export function validateRecords(records) {
  const raw = normalizeCsl(records)
  const prepared = assignCitationKeys(records)
  const errors = []
  const warnings = []
  const duplicateMap = new Map()
  const addDuplicate = (field, value, label) => {
    if (!value) return
    const mapKey = `${field}:${value}`
    if (!duplicateMap.has(mapKey)) duplicateMap.set(mapKey, { field, value, entries: [] })
    duplicateMap.get(mapKey).entries.push(label)
  }

  if (!prepared.length) errors.push('no citation records found')

  const suppliedKeys = new Map()
  raw.forEach((record, index) => {
    const key = sanitizeKey(record['citation-key'])
    if (!key) return
    if (!suppliedKeys.has(key)) suppliedKeys.set(key, [])
    suppliedKeys.get(key).push(labelOf(prepared[index] || record))
  })
  for (const [key, entries] of suppliedKeys) {
    if (entries.length > 1) duplicateMap.set(`citation-key:${key}`, { field: 'citation-key', value: key, entries })
  }

  for (const record of prepared) {
    const label = labelOf(record)
    if (!record.title) errors.push(`${label}: missing title`)
    if (!record.author?.length && !record.editor?.length) warnings.push(`${label}: no author or editor`)
    if (!yearOf(record)) warnings.push(`${label}: missing year`)
    if (['article-journal', 'paper-conference', 'chapter'].includes(record.type) && !record['container-title']) {
      warnings.push(`${label}: missing journal or container title`)
    }
    const rawDoi = text(record.DOI)
    if (rawDoi && !canonicalDoi(rawDoi)) warnings.push(`${label}: DOI does not look valid: ${rawDoi}`)
    if (record.DOI) addDuplicate('doi', record.DOI.toLowerCase(), label)
    const titleYear = record.title ? `${normalizeTitle(record.title)}|${yearOf(record) || ''}` : ''
    addDuplicate('title-year', titleYear, label)
  }

  const duplicates = [...duplicateMap.values()].filter((entry) => entry.entries.length > 1)
  return { errors, warnings, duplicates, entries: prepared }
}
