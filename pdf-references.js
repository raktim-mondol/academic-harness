/**
 * pdf_references: structured bibliography extraction from a PDF via a
 * user-provided GROBID service (BYO infrastructure, no auto-install).
 *
 * Requires GROBID_BASE_URL and AH_ENABLE_OPTIONAL_TOOLS=1; without either the
 * tool is not registered. Optional `resolve` checks DOI identity in Crossref.
 * It never invents a reference: if GROBID fails, the tool fails.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, fetchText, getLimiter, searchUserAgent } from './search-http.js'
import { normalizeTitle } from './search-normalize.js'
import { optionalToolsEnabled } from './optional-tools.js'

const MAX_PDF_BYTES = 200 * 1024 * 1024
const MAX_REFS = 500
const MAX_RESOLVE = 50

function grobidBase() {
  const raw = String(process.env.GROBID_BASE_URL || '').trim()
  return raw ? raw.replace(/\/+$/, '') : null
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function firstChild(block, tag, { level = null } = {}) {
  const pattern = level
    ? new RegExp(`<${tag}[^>]*level="${level}"[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
    : new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
  const match = block.match(pattern)
  return match ? decodeXml(match[1]) : null
}

function authorsOf(block) {
  const authors = []
  for (const match of block.matchAll(/<persName[^>]*>([\s\S]*?)<\/persName>/gi)) {
    const forename = firstChild(match[1], 'forename') || ''
    const surname = firstChild(match[1], 'surname') || ''
    const name = [forename, surname].filter(Boolean).join(' ')
    if (name) authors.push(name)
  }
  return authors
}

export function parseTeiReferences(xml) {
  const references = []
  for (const match of String(xml || '').matchAll(/<biblStruct\b[^>]*>[\s\S]*?<\/biblStruct>/gi)) {
    const block = match[0]
    const analytic = block.match(/<analytic\b[^>]*>[\s\S]*?<\/analytic>/i)?.[0] || ''
    const monogr = block.match(/<monogr\b[^>]*>[\s\S]*?<\/monogr>/i)?.[0] || ''
    const rawMatch = block.match(/<note[^>]*type="raw_reference"[^>]*>([\s\S]*?)<\/note>/i)
    const title = firstChild(analytic, 'title') || firstChild(monogr, 'title', { level: 'm' }) || firstChild(block, 'title')
    const venue = firstChild(monogr, 'title', { level: 'j' }) || firstChild(monogr, 'title', { level: 'm' })
    const yearMatch = block.match(/<date[^>]*when="(\d{4})/i) || block.match(/<date[^>]*>[\s\S]*?(\d{4})/i)
    const doiMatch = block.match(/<idno[^>]*type="DOI"[^>]*>([\s\S]*?)<\/idno>/i)
    const raw = rawMatch ? decodeXml(rawMatch[1]) : null
    const reference = {
      raw: raw || [title, authorsOf(block).join('; '), yearMatch?.[1]].filter(Boolean).join(' · ') || null,
      title: title || null,
      authors: authorsOf(block),
      year: yearMatch ? Number(yearMatch[1]) : null,
      venue: venue && venue !== title ? venue : null,
      doi: doiMatch ? decodeXml(doiMatch[1]).replace(/^https?:\/\/doi\.org\//i, '').toLowerCase() : null,
    }
    if (reference.raw || reference.title) references.push(reference)
    if (references.length >= MAX_REFS) break
  }
  return references
}

export async function runPdfReferences(args, exec, deps = {}) {
  const base = grobidBase()
  if (!base) return { error: 'GROBID_BASE_URL is not set; start GROBID and set e.g. http://127.0.0.1:8070' }
  const httpText = deps.fetchText || fetchText
  const httpJson = deps.fetchJson || fetchJson
  const readEnv = deps.resolveEnv || resolveEnv
  const cwd = exec.agent?.session?.header?.cwd || process.cwd()
  const path = String(args.path || '').trim()
  if (!path) return { error: 'give a path to a PDF' }
  const root = resolve(cwd)
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) return { error: `path escapes the workspace: ${path}` }
  if (!existsSync(target)) return { error: `file not found: ${path}` }
  if (statSync(target).size > MAX_PDF_BYTES) return { error: `PDF is larger than ${MAX_PDF_BYTES / (1024 * 1024)}MB` }

  const result = await httpText(`${base}/api/processReferences`, {
    signal: exec?.signal,
    method: 'POST',
    body: readFileSync(target),
    timeoutMs: 120_000,
    retries: 0,
    headers: { 'Content-Type': 'application/pdf', 'User-Agent': searchUserAgent() },
  })
  if (!result.ok) {
    const detail = result.status ? `HTTP ${result.status}${result.detail ? `: ${result.detail}` : ''}` : (result.error || 'network error')
    return { error: `GROBID service unavailable at ${base} (${detail})` }
  }
  const references = parseTeiReferences(result.data)
  if (!references.length) return { error: 'GROBID returned TEI without any biblStruct references; is this a full-text PDF?' }

  const payload = {
    source: rel,
    reference_count: references.length,
    references,
  }
  if (!args.resolve) return payload

  const mailto = await readEnv('CROSSREF_MAILTO') || await readEnv('UNPAYWALL_EMAIL')
  const limiter = getLimiter('crossref-single', { minIntervalMs: mailto ? 100 : 200 })
  const resolved = []
  for (const reference of references.filter((entry) => entry.doi).slice(0, MAX_RESOLVE)) {
    const params = new URLSearchParams()
    if (mailto) params.set('mailto', mailto)
    const lookup = await limiter.run(() => httpJson(
      `https://api.crossref.org/works/${encodeURIComponent(reference.doi)}?${params}`,
      { signal: exec?.signal, headers: { 'User-Agent': searchUserAgent(mailto) } },
    ))
    if (!lookup.ok) {
      resolved.push({ doi: reference.doi, error: `Crossref lookup failed (${lookup.status || lookup.error})` })
      continue
    }
    const published = lookup.data?.message?.title?.[0] || null
    resolved.push({
      doi: reference.doi,
      crossref_title: published,
      match: reference.title && published
        ? normalizeTitle(reference.title) === normalizeTitle(published)
        : null,
    })
  }
  payload.resolved = resolved
  return payload
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const lines = [`GROBID references: ${value.source} · ${value.reference_count} parsed`]
  value.references.slice(0, 60).forEach((reference, index) => {
    lines.push('', `${index + 1}. ${reference.title || '(untitled)'}`)
    const meta = [reference.authors.slice(0, 3).join(', '), reference.year, reference.venue].filter(Boolean).join(' · ')
    if (meta) lines.push(`   ${meta}`)
    if (reference.doi) lines.push(`   doi:${reference.doi}`)
    if (!reference.title && reference.raw) lines.push(`   ${reference.raw}`)
  })
  if (value.reference_count > 60) lines.push('', `… ${value.reference_count - 60} more references in the JSON result.`)
  if (value.resolved) {
    const matches = value.resolved.filter((entry) => entry.match === true).length
    const mismatches = value.resolved.filter((entry) => entry.match === false).length
    const errors = value.resolved.filter((entry) => entry.error).length
    lines.push('', `DOI resolution: ${matches} matched, ${mismatches} mismatched, ${errors} unresolved`)
    for (const entry of value.resolved.filter((item) => item.match === false || item.error)) {
      lines.push(`- ${entry.doi}: ${entry.error || `Crossref title "${entry.crossref_title || '(none)'}" differs`}`)
    }
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

export const name = 'academic-harness-pdf-references'
export const inject = ['tools']

export function apply(ctx) {
  if (!optionalToolsEnabled() || !grobidBase()) return
  ctx.tools.register(defineTool({
    name: 'pdf_references',
    description: [
      'Extract a structured bibliography from a PDF using a GROBID service you run (GROBID_BASE_URL, e.g. http://127.0.0.1:8070). Returns raw strings, titles, authors, years, venues, and DOIs; `resolve: true` checks DOI identity against Crossref.',
      'Requires AH_ENABLE_OPTIONAL_TOOLS=1 and GROBID_BASE_URL; the tool is not registered without both. If GROBID is down or returns no references, it reports the failure — it never falls back to model-generated references.',
      'Advisory extraction only: verify fields before citing. No PDF is uploaded anywhere except your own GROBID instance.',
    ].join(' '),
    parameters: {
      path: { type: 'string', description: 'Workspace-relative path to the PDF.' },
      resolve: { type: 'boolean', description: 'Check each extracted DOI against Crossref and compare the title.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      return runPdfReferences(args, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `PDF references: ${args.path || ''}`, kind: 'other' }
    },
  }))
}
