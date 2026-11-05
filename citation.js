/**
 * citation: format, export, and validate bibliographies.
 *
 * All parsing/formatting is local (citation-format.js). Network is used only
 * for DOI input (Crossref content negotiation) and optional DOI checks.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { defineTool } from 'ah-dsh-tools'
import { resolveEnv } from './credential-env.js'
import { resolveWorkspacePath } from './paper-download.js'
import { libraryRecords } from './papermemory-library.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { canonicalDoi, normalizeTitle } from './search-normalize.js'
import { resolveBibtexForIdentifier } from './bibtex-resolve.js'
import { resolveWorkspacePath as resolveWritePath } from './workspace-path.js'
import { auditReferences } from './citation-audit.js'
import { runIntegrityCheck } from './integrity-check.js'
import { extractMarkdownCitations, extractTexCitations } from './manuscript-citations.js'
import {
  SUPPORTED_STYLES, assignCitationKeys, formatBibliography, formatCitations, normalizeCsl,
  parseBibtex, parseInput, registerCslStyle, sanitizeKey, toBibtex, toRis, validateRecords,
} from './citation-format.js'

const CROSSREF_WORKS = 'https://api.crossref.org/works'
const MAX_INPUT_BYTES = 10 * 1024 * 1024
const MAX_CSTYLE_BYTES = 1024 * 1024
const MAX_REPAIR = 100
const REPAIR_CODES = new Set([
  'doi_not_registered', 'invalid_doi', 'title_mismatch', 'year_mismatch',
  'venue_mismatch', 'first_author_mismatch',
])
const INTEGRITY_CODES = new Set(['retracted', 'expression_of_concern', 'corrected'])
// A bare substring match only counts when the shorter title carries enough of
// its own to identify a paper; "Housing" does not.
const TITLE_CONTAINMENT_MIN_TOKENS = 3
const TITLE_CONTAINMENT_MIN_MEANINGFUL = 2
const TITLE_STOPWORDS = new Set(['a', 'an', 'the', 'on', 'of', 'for', 'and', 'in', 'to', 'with', 'from', 'by', 'at', 'is', 'are', 'as'])

function text(value) {
  return String(value ?? '').trim()
}

function privateIpv4(address) {
  const match = String(address || '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!match) return true
  const octets = match.slice(1).map(Number)
  if (octets.some((value) => value < 0 || value > 255)) return true
  const [a, b] = octets
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 192 && b === 0 && octets[2] === 0)
}

function expandIpv6(address) {
  let value = String(address || '').toLowerCase().split('%')[0]
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':')
    const ipv4 = value.slice(lastColon + 1).split('.').map(Number)
    if (ipv4.length !== 4 || ipv4.some((part) => Number.isNaN(part) || part > 255)) return null
    value = `${value.slice(0, lastColon + 1)}${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`
  }
  const [head, tail] = value.split('::')
  const headParts = head ? head.split(':').filter(Boolean) : []
  const tailParts = tail ? tail.split(':').filter(Boolean) : []
  const missing = 8 - headParts.length - tailParts.length
  if (missing < 0) return null
  return [...headParts, ...Array(missing).fill('0'), ...tailParts].map((part) => Number.parseInt(part, 16))
}

function privateIpv6(address) {
  const parts = expandIpv6(address)
  if (!parts || parts.length !== 8 || parts.some((part) => Number.isNaN(part))) return true
  if (parts.every((part) => part === 0)) return true
  if (parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1) return true
  if ((parts[0] & 0xfe00) === 0xfc00) return true
  if ((parts[0] & 0xffc0) === 0xfe80) return true
  if ((parts[0] & 0xff00) === 0xff00) return true
  const embedded = `${parts[6] >> 8}.${parts[6] & 0xff}.${parts[7] >> 8}.${parts[7] & 0xff}`
  if (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff) return privateIpv4(embedded)
  if (parts[0] === 0x0064 && parts[1] === 0xff9b && parts.slice(2, 6).every((part) => part === 0)) return privateIpv4(embedded)
  if (parts.slice(0, 6).every((part) => part === 0)) return privateIpv4(embedded)
  return false
}

export function privateAddress(address) {
  const kind = isIP(String(address || ''))
  if (kind === 4) return privateIpv4(address)
  if (kind === 6) return privateIpv6(address)
  return true
}

export function privateHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  if (isIP(host)) return privateAddress(host)
  return false
}

async function assertPublicStyleUrl(url) {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('style_url must use http or https')
  if (url.username || url.password) throw new Error('style_url must not contain credentials')
  if (privateHostname(url.hostname)) throw new Error('style_url must not point at a local or private network host')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  let addresses
  if (isIP(host)) addresses = [{ address: host }]
  else {
    try {
      addresses = await lookup(host, { all: true, verbatim: true })
    } catch (error) {
      throw new Error(`style_url host could not be resolved: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) {
    throw new Error('style_url resolves to a local or private network address')
  }
}

async function fetchStyleUrl(raw) {
  let url
  try {
    url = new URL(String(raw).trim())
  } catch {
    throw new Error(`style_url is not a valid URL: ${raw}`)
  }
  for (let hop = 0; hop <= 4; hop += 1) {
    await assertPublicStyleUrl(url)
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': searchUserAgent() },
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop === 4) throw new Error('style_url redirected too many times')
      const location = response.headers.get('location')
      if (!location) throw new Error(`style_url redirected (HTTP ${response.status}) without a Location header`)
      const next = new URL(location, url)
      if (!['http:', 'https:'].includes(next.protocol)) throw new Error('style_url redirected to a non-http(s) URL')
      url = next
      continue
    }
    return { response, finalUrl: url }
  }
  throw new Error('style_url redirected too many times')
}

async function loadCustomStyle(cwd, args) {
  const file = typeof args.style_file === 'string' ? args.style_file.trim() : ''
  const urlArg = typeof args.style_url === 'string' ? args.style_url.trim() : ''
  if (file && urlArg) throw new Error('give style_file or style_url, not both')
  if (!file && !urlArg) return null
  let xml
  let source
  let cached = false
  let cacheAbs = null
  let writeCache = false
  if (file) {
    xml = readWorkspaceText(cwd, file)
    source = file
  } else {
    let requested
    try {
      requested = new URL(String(urlArg).trim())
    } catch {
      throw new Error(`style_url is not a valid URL: ${urlArg}`)
    }
    if (!['http:', 'https:'].includes(requested.protocol)) throw new Error('style_url must use http or https')
    if (requested.username || requested.password) throw new Error('style_url must not contain credentials')
    if (privateHostname(requested.hostname)) throw new Error('style_url must not point at a local or private network host')
    const cacheRel = join('.dsh', 'styles', `${createHash('sha256').update(requested.href).digest('hex').slice(0, 16)}.csl`)
    cacheAbs = resolveWorkspacePath(cwd, cacheRel)
    if (existsSync(cacheAbs)) {
      xml = readFileSync(cacheAbs, 'utf8')
      source = requested.href
      cached = true
    } else {
      const { response, finalUrl } = await fetchStyleUrl(urlArg)
      if (!response.ok) throw new Error(`style_url returned HTTP ${response.status}`)
      const declared = Number(response.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > MAX_CSTYLE_BYTES) throw new Error(`style_url is larger than ${MAX_CSTYLE_BYTES / 1024}KB`)
      xml = await response.text()
      if (Buffer.byteLength(xml) > MAX_CSTYLE_BYTES) throw new Error(`style_url is larger than ${MAX_CSTYLE_BYTES / 1024}KB`)
      source = finalUrl.href
      writeCache = true
    }
  }
  if (Buffer.byteLength(xml) > MAX_CSTYLE_BYTES) throw new Error(`custom CSL style is larger than ${MAX_CSTYLE_BYTES / 1024}KB`)
  const hash = createHash('sha256').update(xml).digest('hex')
  const name = `custom-${hash.slice(0, 12)}`
  const registered = registerCslStyle({ name, xml, label: file ? basename(file) : 'Custom CSL style' })
  if (writeCache && cacheAbs) writeFileSync(cacheAbs, xml)
  return {
    name,
    label: file ? basename(file) : 'Custom CSL style',
    source,
    sha256: `sha256:${hash}`,
    cached,
    warnings: registered.warnings || [],
  }
}

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
  const target = resolveWritePath(cwd, path, { forWrite: true })
  mkdirSync(dirname(target), { recursive: true })
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
  const resolved = await resolveBibtexForIdentifier(doi, {
    signal: exec?.signal,
    allowPaperGet: false,
  })
  if (!resolved.bibtex) {
    throw new Error(`Could not resolve BibTeX for ${doi}; the DOI may not be registered or may be invalid`)
  }
  return resolved.bibtex
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

function titleTokens(value) {
  return String(value || '').split(/\s+/).filter(Boolean)
}

/** True when `shorter` sits inside `longer` and carries enough of its own to name a paper. */
function containedTitle(shorter, longer) {
  if (!longer.includes(shorter)) return false
  const tokens = titleTokens(shorter)
  if (tokens.length >= TITLE_CONTAINMENT_MIN_TOKENS) return true
  return tokens.filter((token) => !TITLE_STOPWORDS.has(token)).length >= TITLE_CONTAINMENT_MIN_MEANINGFUL
}

/**
 * Token-overlap check used by optional DOI verification and the repair title gate.
 * A pair that cannot be compared — either side empty, or either side normalizes to
 * nothing, as a Chinese/Arabic/Cyrillic title does — is never a match: unknown is
 * reported as unverified, never clean.
 */
export function titleMatches(expected, actual) {
  const a = normalizeTitle(expected)
  const b = normalizeTitle(actual)
  if (!a || !b) return false
  if (a === b) return true
  if (containedTitle(a, b) || containedTitle(b, a)) return true
  const aTokens = titleTokens(a)
  const bTokens = titleTokens(b)
  const set = new Set(aTokens)
  const overlap = bTokens.filter((token) => set.has(token)).length
  return overlap / Math.max(aTokens.length, bTokens.length) >= 0.6
}

/** True when both titles exist and both survive lexical normalization. */
function comparableTitles(expected, actual) {
  const a = String(expected || '').trim()
  const b = String(actual || '').trim()
  if (!a || !b) return false
  return Boolean(normalizeTitle(a)) && Boolean(normalizeTitle(b))
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
  if (typeof args.identifier === 'string' && args.identifier.trim()) {
    const resolved = await resolveBibtexForIdentifier(args.identifier.trim(), { signal: exec?.signal })
    if (!resolved.bibtex) throw new Error(`could not resolve a BibTeX record for ${args.identifier}`)
    return parseBibtex(resolved.bibtex)
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

async function checkDois(records, exec, deps = {}) {
  const fetchWork = deps.fetchCrossref || ((doi) => fetchCrossrefWork(doi, exec))
  const warnings = []
  const checked = []
  const unverified = []
  const seen = new Set()
  for (const record of records) {
    const doi = canonicalDoi(record.DOI)
    if (!doi || seen.has(doi)) continue
    seen.add(doi)
    const result = await fetchWork(doi)
    if (!result.ok) {
      warnings.push(`${doi}: Crossref lookup failed (${result.error || `HTTP ${result.status}`}); DOI existence is unverified`)
      unverified.push(doi)
      continue
    }
    const published = result.work?.title?.[0] || result.work?.title || ''
    if (record.title && published && !comparableTitles(record.title, published)) {
      warnings.push(`${doi}: the Crossref title "${published}" and the cited title "${record.title}" could not be compared lexically; the DOI resolved, but the title match is unverified`)
      unverified.push(doi)
    } else if (record.title && published && !titleMatches(record.title, published)) {
      warnings.push(`${doi}: Crossref title "${published}" does not match "${record.title}"`)
    } else {
      checked.push(doi)
    }
  }
  return { warnings, checked, unverified }
}

/** What the writer actually did to this record's citation key, in the emitted .bib. */
function repairedKeyNote(reference) {
  if (reference.key_preserved) return ''
  if (reference.key_suffixed) {
    return ` — key renamed to ${reference.grounded_key} to avoid a duplicate citation key; re-check every \\cite{${reference.unchanged_key}}`
  }
  return ' — key changed, re-check citations'
}

function renderCitation(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (value.action === 'audit') {
    const lines = [`Reference audit: ${value.count} reference(s) · ${value.counts.problem} problem · ${value.counts.review} review · ${value.counts.unverified} unverified · ${value.counts.no_issues_found} no issues found (${value.network_checked} DOI(s) checked online).`]
    for (const ref of value.references.filter((r) => r.status === 'problem' || r.status === 'review')) {
      lines.push(`- ${ref.status.toUpperCase()} ${ref.key}${ref.doi ? ` (${ref.doi})` : ''}`)
      for (const f of ref.findings.filter((x) => x.severity !== 'info')) lines.push(`    ${f.code}: ${f.detail}${f.suggested_fix ? ` → ${f.suggested_fix}` : ''}`)
    }
    const unverified = value.references.filter((r) => r.status === 'unverified')
    if (unverified.length) lines.push(`- unverified (${unverified.length}): ${unverified.slice(0, 15).map((r) => r.key).join(', ')}${unverified.length > 15 ? ', …' : ''}`)
    lines.push(...value.caveats.map((c) => `Note: ${c}`))
    return [{ type: 'text', text: lines.join('\n') }]
  }
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
    if (value.doi_unverified?.length) lines.push(`- DOI checks unverified (a lookup failed or the titles could not be compared; not a pass): ${value.doi_unverified.join(', ')}`)
    if (!value.errors.length && !value.warnings.length && !value.duplicates.length) lines.push('- No issues found.')
    return [{ type: 'text', text: lines.join('\n') }]
  }
  if (value.action === 'repair') {
    const lines = [
      `Citation repair: ${value.count} record(s) · ${value.targets} target(s) · ${value.repaired} repaired · ${value.unresolved} unresolved · ${value.skipped} skipped.`,
    ]
    for (const ref of value.references.slice(0, 30)) {
      if (ref.status === 'repaired') {
        const changes = Object.entries(ref.changes || {}).map(([field, change]) => field).join(', ')
        lines.push(`- repaired ${ref.key}: ${ref.grounded?.title || ''}${ref.grounded?.doi ? ` (${ref.grounded.doi})` : ''} via ${ref.source}${changes ? ` — changed ${changes}` : ''}${repairedKeyNote(ref)}`)
      } else if (ref.status === 'unresolved') {
        lines.push(`- unresolved ${ref.key}: ${ref.reason}${ref.rejected?.length ? ` (tried: ${ref.rejected.map((entry) => entry.identifier).join('; ')})` : ''}`)
      } else if (ref.status === 'skipped') {
        lines.push(`- skipped ${ref.key}: ${ref.reason}`)
      }
    }
    if (value.references.length > 30) lines.push(`- …${value.references.length - 30} more in the sidecar`)
    lines.push('', `Wrote ${value.output_path} and ${value.sidecar_path}.`, value.note)
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

function repairNeed(reference) {
  const codes = [...new Set((reference.findings || []).map((finding) => finding.code))]
  if (codes.includes('retracted')) {
    return { needed: false, codes: ['retracted'], reason: 'recorded as retracted; metadata repair is not the remedy' }
  }
  const repairable = codes.filter((code) => REPAIR_CODES.has(code))
  if (repairable.length) return { needed: true, codes: repairable }
  const integrity = codes.filter((code) => INTEGRITY_CODES.has(code))
  if (integrity.length) return { needed: false, codes: integrity, reason: `recorded integrity finding (${integrity.join(', ')}), not a metadata mismatch` }
  return { needed: false, codes, reason: 'no repairable mismatch was recorded' }
}

function repairCandidates(original, codes) {
  const identifiers = []
  const doi = canonicalDoi(original.DOI)
  const title = String(original.title || '').trim()
  const titleFirst = codes.includes('title_mismatch')
  if (titleFirst && title) identifiers.push(title)
  if (doi && !codes.includes('doi_not_registered')) identifiers.push(doi)
  if (!titleFirst && title) identifiers.push(title)
  if (doi && !identifiers.includes(doi)) identifiers.push(doi)
  return identifiers
}

function repairYear(record) {
  const parts = record?.issued?.['date-parts']?.[0]
  return Number(Array.isArray(parts) ? parts[0] : null) || null
}

function repairFamily(record) {
  const author = record?.author?.[0]
  return String(author?.family || author?.literal || '').trim().toLowerCase()
}

function repairVenue(record) {
  return String(record?.['container-title'] || '').trim().toLowerCase()
}

/** Fields the grounded record agrees with the cited record on, besides the title. */
function corroborateRepair(original, candidate) {
  const matched = []
  const citedFamily = repairFamily(original)
  const foundFamily = repairFamily(candidate)
  if (citedFamily && foundFamily && (citedFamily === foundFamily
    || (Math.min(citedFamily.length, foundFamily.length) >= 3
      && (citedFamily.includes(foundFamily) || foundFamily.includes(citedFamily))))) {
    matched.push('first_author')
  }
  const citedYear = repairYear(original)
  const foundYear = repairYear(candidate)
  if (citedYear && foundYear && citedYear === foundYear) matched.push('issued')
  const citedVenue = repairVenue(original)
  const foundVenue = repairVenue(candidate)
  if (citedVenue && foundVenue && titleMatches(citedVenue, foundVenue)) matched.push('container-title')
  return matched
}

/**
 * The repair title gate. `basis` says how the title evidence was obtained:
 * `doi_identity` (the grounded DOI is the cited DOI), `exact_title` (the titles are
 * the same string once normalized, or exactly the same where normalization yields
 * nothing), or `title_match` (lexical overlap only). A pair whose titles cannot be
 * compared never passes.
 */
function acceptableRepair(original, candidate) {
  const originalTitle = String(original.title || '').trim()
  const candidateTitle = String(candidate.title || '').trim()
  const originalDoi = canonicalDoi(original.DOI)
  const candidateDoi = canonicalDoi(candidate.DOI)
  const sameDoi = Boolean(originalDoi) && originalDoi === candidateDoi
  if (!candidateTitle) return { ok: false, reason: 'the grounded record has no title' }
  if (!originalTitle) {
    if (sameDoi) return { ok: true, basis: 'doi_identity' }
    return { ok: false, reason: 'the cited record has no title, so a different grounding cannot be verified' }
  }
  const normalizedOriginal = normalizeTitle(originalTitle)
  const normalizedCandidate = normalizeTitle(candidateTitle)
  if (!normalizedOriginal || !normalizedCandidate) {
    // A non-Latin title normalizes to nothing; the helper refuses such a pair, so
    // fall back to exact casing/space comparison rather than letting an
    // incomparable title accept any paper.
    return originalTitle === candidateTitle
      ? { ok: true, basis: 'exact_title' }
      : { ok: false, reason: `the grounded title "${candidateTitle}" does not match "${originalTitle}" (titles could not be compared lexically)` }
  }
  if (!titleMatches(originalTitle, candidateTitle)) {
    return { ok: false, reason: `the grounded title "${candidateTitle}" does not match "${originalTitle}"` }
  }
  if (sameDoi) return { ok: true, basis: 'doi_identity' }
  return { ok: true, basis: normalizedOriginal === normalizedCandidate ? 'exact_title' : 'title_match' }
}

async function repairReferences(records, audit, { resolveBibtex, maxRepair }) {
  const outputs = []
  const repairedRecords = [...records]
  let repaired = 0
  let unresolved = 0
  let skipped = 0
  let attempted = 0

  audit.references.forEach((reference, index) => {
    const original = records[index]
    if (!original) {
      skipped += 1
      outputs.push({ key: reference.key, index, status: 'skipped', codes: [], reason: 'no matching input record' })
      return
    }
    const need = repairNeed(reference)
    if (!need.needed) {
      skipped += 1
      outputs.push({
        key: reference.key,
        index,
        status: 'skipped',
        codes: need.codes,
        reason: need.reason,
        original: { doi: canonicalDoi(original.DOI) || null, title: original.title || null },
      })
      return
    }
    outputs.push({ key: reference.key, index, status: 'pending', codes: need.codes })
  })

  for (const outcome of outputs) {
    if (outcome.status !== 'pending') continue
    if (attempted >= maxRepair) {
      outcome.status = 'skipped'
      outcome.reason = `over the ${maxRepair}-reference repair cap`
      skipped += 1
      continue
    }
    attempted += 1
    const original = records[outcome.index]
    const identifiers = repairCandidates(original, outcome.codes)
    const originalDoi = canonicalDoi(original.DOI)
    const rejected = []
    let resolved = null
    for (const identifier of identifiers) {
      let value
      try {
        value = await resolveBibtex(identifier)
      } catch (error) {
        rejected.push({ identifier, reason: error instanceof Error ? error.message : String(error) })
        continue
      }
      if (!value?.bibtex) {
        rejected.push({ identifier, reason: 'no grounded BibTeX was returned' })
        continue
      }
      let parsed
      try {
        parsed = parseBibtex(value.bibtex)
      } catch (error) {
        rejected.push({ identifier, reason: `grounded BibTeX did not parse (${error instanceof Error ? error.message : String(error)})` })
        continue
      }
      if (!parsed.length) {
        rejected.push({ identifier, reason: 'grounded BibTeX had no record' })
        continue
      }
      const candidate = parsed[0]
      const check = acceptableRepair(original, candidate)
      if (!check.ok) {
        rejected.push({ identifier, reason: check.reason })
        continue
      }
      // A title-only acceptance is not identity when the cited record carries a
      // registered DOI: the grounded record must also agree on author, year, or venue.
      const requiresCorroboration = Boolean(originalDoi) && check.basis !== 'doi_identity'
      const corroboratedBy = check.basis === 'doi_identity'
        ? ['doi']
        : requiresCorroboration ? corroborateRepair(original, candidate) : []
      if (requiresCorroboration && !corroboratedBy.length) {
        rejected.push({
          identifier,
          reason: `the grounded title "${candidate.title}" resembles the cited title, but neither the first author, the year, nor the venue corroborates it; not accepted on title alone`,
        })
        continue
      }
      const confirmed = check.basis === 'doi_identity' || corroboratedBy.length > 0
      const candidateResolution = {
        record: candidate,
        source: value.source || 'lookup',
        identifier,
        basis: check.basis,
        corroboratedBy,
        confirmed,
        rank: confirmed ? 2 : (check.basis === 'exact_title' ? 1 : 0),
      }
      if (!resolved || candidateResolution.rank > resolved.rank) resolved = candidateResolution
      // Only a corroborated acceptance ends the search; a weaker one stays open so a
      // later identifier (usually the DOI) can supersede it.
      if (confirmed) break
    }
    if (!resolved) {
      unresolved += 1
      Object.assign(outcome, {
        status: 'unresolved',
        reason: 'no live lookup produced a record whose title matches the cited paper',
        rejected,
        original: { doi: canonicalDoi(original.DOI) || null, title: original.title || null },
      })
      continue
    }
    const replacement = { ...resolved.record }
    const originalKey = text(original['citation-key'])
    if (originalKey) replacement['citation-key'] = originalKey
    if (original.id && !replacement.id) replacement.id = original.id
    repairedRecords[outcome.index] = replacement
    repaired += 1
    const changes = {}
    for (const [field, value] of Object.entries({
      DOI: replacement.DOI ?? null,
      title: replacement.title ?? null,
      issued: replacement.issued ?? null,
      'container-title': replacement['container-title'] ?? null,
      author: replacement.author?.map((author) => author.family || author.literal).filter(Boolean) ?? null,
    })) {
      const before = field === 'author'
        ? (original.author || []).map((author) => author.family || author.literal).filter(Boolean)
        : (original[field] ?? null)
      if (JSON.stringify(before) !== JSON.stringify(value)) changes[field] = { from: before, to: value }
    }
    Object.assign(outcome, {
      status: 'repaired',
      source: resolved.source,
      matched_identifier: resolved.identifier,
      title_basis: resolved.basis,
      corroborated_by: resolved.corroboratedBy,
      unchanged_key: originalKey || null,
      original: { doi: canonicalDoi(original.DOI) || null, title: original.title || null },
      grounded: {
        doi: canonicalDoi(replacement.DOI) || null,
        title: replacement.title || null,
        issued: replacement.issued ?? null,
      },
      changes,
      rejected,
    })
  }

  // `toBibtex` writes the emitter's own keys: assignCitationKeys suffixes any key two
  // entries share (the duplicate citation-key case the audit reports). Report the key
  // actually emitted, so `key_preserved` cannot claim a key the new .bib renamed.
  const emittedKeys = assignCitationKeys(repairedRecords).map((record) => record['citation-key'] || null)
  for (const outcome of outputs) {
    if (outcome.status !== 'repaired') continue
    const originalKey = outcome.unchanged_key || ''
    const emitted = emittedKeys[outcome.index] || null
    outcome.grounded_key = emitted
    outcome.key_preserved = Boolean(originalKey) && emitted === originalKey
    outcome.key_suffixed = !outcome.key_preserved && Boolean(originalKey) && sanitizeKey(originalKey) === originalKey
    if (!outcome.key_preserved) {
      outcome.key_reason = outcome.key_suffixed
        ? `the emitted key "${emitted}" was suffixed to avoid a duplicate citation key; \\cite{${originalKey}} in the manuscript now points elsewhere`
        : (originalKey
          ? `the emitted key "${emitted}" replaces the cited key "${originalKey}"`
          : `the cited record had no citation key; the emitted key is "${emitted}"`)
    }
  }

  return { repairedRecords, outcomes: outputs, counts: { targets: attempted, repaired, unresolved, skipped } }
}

function repairSource(args) {
  if (Array.isArray(args.records) && args.records.length) return '(records)'
  if (args.library) return '(library)'
  if (typeof args.identifier === 'string' && args.identifier.trim()) return args.identifier.trim()
  if (args.doi) return '(doi)'
  if (typeof args.text === 'string' && args.text.trim()) return '(text)'
  if (typeof args.path === 'string' && args.path.trim()) return args.path.trim()
  return '(records)'
}

async function checkCitations(records, args, deps, exec) {
  let citedKeys = null
  if (typeof args.manuscript === 'string' && args.manuscript.trim()) {
    const source = readWorkspaceText(workspaceRoot(exec), args.manuscript)
    const cited = /\.(md|markdown|qmd|rmd)$/i.test(args.manuscript) ? extractMarkdownCitations(source) : extractTexCitations(source)
    citedKeys = cited.nociteAll ? null : new Set(cited.keys.keys())
  }
  return await auditReferences(records, {
    fetchCrossref: deps.fetchCrossref || ((doi) => fetchCrossrefWork(doi, exec)),
    integrity: deps.integrity || ((doi) => runIntegrityCheck({ doi }, exec).catch((error) => ({ error: error.message }))),
    titleMatches,
    citedKeys,
    style: args.style || 'apa',
    maxAudit: args.max_audit,
  })
}

export async function runCitation(args, exec, deps = {}) {
  const action = args.action || 'format'
  if (!['format', 'bibtex', 'ris', 'validate', 'audit', 'repair'].includes(action)) {
    throw new Error('action must be format, bibtex, ris, validate, audit, or repair')
  }
  if ((args.style_file || args.style_url) && action !== 'format') {
    throw new Error('style_file/style_url apply to action=format only')
  }
  if (args.style_file || args.style_url) {
    if (args.style) throw new Error('give style or style_file/style_url, not both')
  }
  const customStyle = await loadCustomStyle(workspaceRoot(exec), args)
  if (action === 'bibtex' && typeof args.identifier === 'string' && args.identifier.trim()
    && !(Array.isArray(args.records) && args.records.length) && !args.library) {
    const resolved = await resolveBibtexForIdentifier(args.identifier.trim(), { signal: exec?.signal })
    if (!resolved.bibtex) throw new Error(`could not resolve a BibTeX record for ${args.identifier}`)
    const value = { action, count: 1, bibtex: resolved.bibtex, source: resolved.source }
    if (typeof args.output_path === 'string' && args.output_path.trim()) {
      writeWorkspaceText(workspaceRoot(exec), args.output_path, `${resolved.bibtex}\n`)
      value.output_path = args.output_path
    }
    return value
  }
  const records = await loadRecords(args, exec)
  if (!records.length) throw new Error('no citation records found')

  if (action === 'validate') {
    const result = validateRecords(records)
    let doiCheck = { warnings: [], checked: [], unverified: [] }
    if (args.check_dois) {
      doiCheck = await checkDois(result.entries, exec, deps)
    }
    return {
      action,
      count: records.length,
      errors: result.errors,
      warnings: [...result.warnings, ...doiCheck.warnings],
      duplicates: result.duplicates,
      doi_checks: doiCheck.checked,
      doi_unverified: doiCheck.unverified,
    }
  }

  if (action === 'audit') {
    const audit = await checkCitations(records, args, deps, exec)
    return { action, count: records.length, manuscript: args.manuscript || null, ...audit }
  }

  if (action === 'repair') {
    const cwd = workspaceRoot(exec)
    const outputPath = typeof args.output_path === 'string' ? args.output_path.trim() : ''
    if (!outputPath) throw new Error('repair needs output_path for the new .bib; the input file is never overwritten')
    const inputAbs = typeof args.path === 'string' && args.path.trim() ? resolveReadPath(cwd, args.path) : null
    const inputReal = inputAbs && existsSync(inputAbs) ? realpathSync(inputAbs) : inputAbs
    const outputAbs = resolveWritePath(cwd, outputPath, { forWrite: true })
    if (inputReal && inputReal === outputAbs) throw new Error('repair writes a new .bib; output_path must differ from the input path')
    if (existsSync(outputAbs) && !args.overwrite) throw new Error(`${outputPath} already exists; pass overwrite: true`)
    const sidecarPath = outputPath.replace(/\.bib$/i, '') + '.repair.json'
    const sidecarAbs = resolveWritePath(cwd, sidecarPath, { forWrite: true })
    if (sidecarAbs === outputAbs) throw new Error('repair sidecar would overwrite output_path; choose another output_path')
    if (inputReal && sidecarAbs === inputReal) throw new Error('repair sidecar would overwrite the input bibliography; choose another output_path')
    if (existsSync(sidecarAbs) && !args.overwrite) throw new Error(`${sidecarPath} already exists; pass overwrite: true`)
    const maxRepair = Math.min(Math.max(Number(args.max_repair) || 25, 1), MAX_REPAIR)
    const audit = await checkCitations(records, args, deps, exec)
    const resolveBibtex = deps.resolveBibtex || ((identifier) => resolveBibtexForIdentifier(identifier, { signal: exec?.signal }))
    const { repairedRecords, outcomes, counts } = await repairReferences(records, audit, { resolveBibtex, maxRepair })
    const bibtex = toBibtex(repairedRecords)
    writeWorkspaceText(cwd, outputPath, `${bibtex}\n`)
    const sidecar = {
      schema_version: 1,
      tool: 'citation',
      action: 'repair',
      generated_at: new Date().toISOString(),
      source: repairSource(args),
      output_path: outputPath,
      max_repair: maxRepair,
      counts,
      normalized: true,
      note: 'The input bibliography was not modified. A record was replaced only when the grounded title matches the cited paper (never on a bare substring of a short title, and never where the titles cannot be compared) and, when the cited record carries a registered DOI, the grounded author, year, or venue corroborates it; every unresolved record is reported, never guessed. The new .bib is re-serialized from parsed records, so fields the exporter cannot represent may be dropped and a citation key shared by two entries is suffixed; the sidecar reports the key actually emitted. The original file remains the reference for those fields. A repair corrects metadata, not whether the reference supports the claim.',
      references: outcomes.map((outcome) => {
        const { index, ...rest } = outcome
        return rest
      }),
    }
    writeWorkspaceText(cwd, sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`)
    return {
      action,
      count: records.length,
      ...counts,
      output_path: outputPath,
      sidecar_path: sidecarPath,
      references: sidecar.references,
      note: sidecar.note,
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

  const style = customStyle ? customStyle.name : (args.style || 'apa')
  const locale = args.locale || 'en-US'
  const bibliography = formatBibliography(records, { style, locale })
  const inText = args.include_in_text ? formatCitations(records, { style, locale }) : ''
  const value = { action, style, locale, count: records.length, bibliography, in_text: inText || null }
  if (customStyle) value.custom_style = customStyle
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
      '`format` renders a bibliography in APA (default), Vancouver, Harvard, IEEE, Chicago author-date, or MLA, with optional in-text markers. A custom CSL style can be loaded from a workspace `style_file` or an http(s) `style_url`; it is validated, cached under `.dsh/styles/`, and used for this call. `bibtex` and `ris` produce reference-manager files from records, BibTeX/RIS text, DOIs, or a single `identifier` (DOI → arXiv → INSPIRE → S2 → synthesized). `validate` reports missing fields, duplicate DOIs/keys, and optionally checks each DOI against Crossref. `audit` is the batch check for a manuscript or .bib: per-reference DOI validity, Crossref metadata match (title/year/venue/first author), retraction/concern/correction status via integrity_check, duplicates, missing fields, uncited entries (with `manuscript`), and style fit, each with a suggested fix. Audit does not check that a reference supports the claim it is cited for; unknown is reported as unverified, never clean.',
      'Accepts CSL-JSON records, BibTeX, RIS, a workspace path, `library` (papers from the PaperMemory reference library, under its own keys; to write a project .bib use `papermemory_library` export), or `identifier` for one canonical entry. Use paper_get when you need a merged paper record rather than a citation. No key; set CROSSREF_MAILTO (or UNPAYWALL_EMAIL) for the Crossref polite pool. Use this instead of hand-writing bibliography entries or citation keys.',
      '`repair` re-audits the input, then grounds each metadata mismatch (`doi_not_registered`, `invalid_doi`, `title_mismatch`, `year_mismatch`, `venue_mismatch`, `first_author_mismatch`) through DOI and title resolution (Crossref, arXiv, INSPIRE, S2, paper_get). It accepts only a record whose title matches the cited paper: a bare substring of a one- or two-word title is not a match, a pair whose titles cannot be compared lexically is not a match (only an exact string comparison is), and when the cited record carries a registered DOI a title-only match must also be corroborated by first author, year, or venue. Weaker acceptances stay open so a later identifier can supersede them, and the sidecar reports the key the writer actually emitted, including a key suffixed to avoid a duplicate. It writes a NEW .bib plus a `.repair.json` sidecar; the input is never modified, writes refuse symlinked targets, a retracted record is reported as not repairable, a correction or expression of concern does not block metadata repair, and an unresolved record is reported, never guessed. The new .bib is re-serialized from parsed records, so fields the exporter cannot represent may be dropped; the sidecar records that. The audit vocabulary is `problem|review|unverified|no_issues_found`; the engine-side `HALLUCINATED|MISMATCH` labels are not produced by this tool.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ['format', 'bibtex', 'ris', 'validate', 'audit', 'repair'],
        description: 'format (bibliography), bibtex, ris, validate, audit (batch reference audit), or repair (ground mismatched records and write a new .bib). Default format.',
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
      identifier: {
        type: 'string',
        description: 'Resolve one DOI, arXiv ID, INSPIRE/source identifier, or title to canonical BibTeX. For action=bibtex, returns the official entry when a DOI/arXiv/INSPIRE/S2 record exists, otherwise a synthesized entry.',
      },
      doi: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'DOI or DOIs to fetch as BibTeX before formatting/validating.',
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
        description: 'CSL style for format. Default apa. Do not combine with style_file/style_url.',
      },
      style_file: { type: 'string', description: 'format: workspace-relative CSL style file. Validated and used for this call.' },
      style_url: { type: 'string', description: 'format: http(s) CSL style URL. Validated, cached under .dsh/styles/, and used for this call; local/private hosts are refused.' },
      locale: { type: 'string', description: 'CSL locale, e.g. en-US. Default en-US.' },
      include_in_text: { type: 'boolean', description: 'Also return in-text citation markers (format action).' },
      manuscript: { type: 'string', description: 'audit: workspace-relative .tex or .md manuscript, used to find uncited bibliography entries.' },
      max_audit: { type: 'number', description: 'audit: most DOIs to check online, 1-500. Default 100.' },
      check_dois: { type: 'boolean', description: 'Validate DOIs against Crossref (validate action). Adds network calls, one per DOI.' },
      output_path: { type: 'string', description: 'Workspace-relative path to write the output. For format, writes the bibliography only. For repair, the new .bib (required; the input is never overwritten).' },
      max_repair: { type: 'number', description: 'repair: most records to ground online, 1-100. Default 25.' },
      overwrite: { type: 'boolean', description: 'repair: replace existing output_path/sidecar files. Default false.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderCitation(value),
    },
    async execute(args, exec) {
      try {
        return JSON.parse(JSON.stringify(await runCitation(args, exec), (_key, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)))
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Citation: ${args.action || 'format'}`, kind: 'other' }
    },
  }))
}
