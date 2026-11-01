/**
 * paper_artifacts: pull data, code, and accession references and availability
 * statements out of a paper's text, then check whether the links answer.
 *
 * Extraction is pattern matching and says so. Verification is a HEAD (or a
 * one-byte GET) with a timeout; it never downloads a dataset (use
 * `dataset_get`), never follows a redirect into a private network, and a link
 * that answers is not proof that it holds what the paper claims. Accessions
 * are never reported as verified: a resolver page answering says nothing about
 * whether the record exists.
 */
import { readFileSync, statSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { getDefaultAutoSelectFamilyAttemptTimeout, isIP, setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { privateAddress, privateHostname } from './citation.js'
import { exportText, nowIso } from './ledger-kit.js'
import { canonicalDoi } from './search-normalize.js'
import { resolveWorkspacePath } from './workspace-path.js'

// Node tries each resolved address for 250 ms by default. Hosts with many addresses, some of them
// unreachable IPv6 (Zenodo, found in live testing), then fail every attempt although curl connects.
// Raise it only if it is lower; this is process-wide and never lowers an existing setting.
if (typeof getDefaultAutoSelectFamilyAttemptTimeout === 'function' && getDefaultAutoSelectFamilyAttemptTimeout() < 2000) {
  setDefaultAutoSelectFamilyAttemptTimeout(2000)
}

export const ARTIFACT_ACTIONS = ['extract', 'verify']
const MAX_TEXT_BYTES = 8 * 1024 * 1024
const DEFAULT_VERIFY_CAP = 25
const HARD_VERIFY_CAP = 100

const REPOSITORIES = [
  { id: 'zenodo', label: 'Zenodo', host: /(^|\.)zenodo\.org$/, doi: /^10\.5281\//, kind: 'data' },
  { id: 'figshare', label: 'Figshare', host: /(^|\.)figshare\.com$/, doi: /^10\.6084\//, kind: 'data' },
  { id: 'osf', label: 'OSF', host: /(^|\.)osf\.io$/, doi: /^10\.17605\//, kind: 'data' },
  { id: 'dryad', label: 'Dryad', host: /(^|\.)datadryad\.org$/, doi: /^10\.5061\//, kind: 'data' },
  { id: 'dataverse', label: 'Dataverse', host: /(^|\.)dataverse\.[a-z.]+$|(^|\.)dataverse\.harvard\.edu$/, doi: /^10\.7910\//, kind: 'data' },
  { id: 'github', label: 'GitHub', host: /(^|\.)github\.com$/, kind: 'code' },
  { id: 'gitlab', label: 'GitLab', host: /(^|\.)gitlab\.com$/, kind: 'code' },
  { id: 'huggingface', label: 'Hugging Face', host: /(^|\.)huggingface\.co$/, kind: 'data-or-code' },
  { id: 'kaggle', label: 'Kaggle', host: /(^|\.)kaggle\.com$/, kind: 'data-or-code' },
  { id: 'software-heritage', label: 'Software Heritage', host: /(^|\.)softwareheritage\.org$/, kind: 'code' },
]

const ACCESSIONS = [
  { db: 'GEO', re: /\bGS[EM]\d{3,9}\b/g, url: (id) => `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${id}` },
  { db: 'SRA', re: /\b[SED]R[RPXS]\d{6,9}\b/g, url: (id) => `https://www.ncbi.nlm.nih.gov/sra/?term=${id}` },
  { db: 'BioProject', re: /\bPRJ(?:NA|EB|DB)\d{3,9}\b/g, url: (id) => `https://www.ncbi.nlm.nih.gov/bioproject/?term=${id}` },
  { db: 'ArrayExpress', re: /\bE-[A-Z]{3,5}-\d{1,7}\b/g, url: (id) => `https://www.ebi.ac.uk/biostudies/arrayexpress/studies/${id}` },
  { db: 'PRIDE', re: /\bPXD\d{6}\b/g, url: (id) => `https://www.ebi.ac.uk/pride/archive/projects/${id}` },
  { db: 'MassIVE', re: /\bMSV\d{9}\b/g, url: (id) => `https://massive.ucsd.edu/ProteoSAFe/dataset.jsp?accession=${id}` },
  { db: 'EGA', re: /\bEGA[SD]\d{11}\b/g, url: (id) => `https://ega-archive.org/datasets/${id}` },
  // PDB ids and GenBank accessions collide with ordinary words and numbers, so they need nearby context.
  { db: 'PDB', re: /\b[1-9][A-Za-z0-9]{3}\b/g, context: /\b(?:PDB|Protein Data Bank|RCSB|PDB ID|PDB code)s?\b/i, url: (id) => `https://www.rcsb.org/structure/${id.toUpperCase()}` },
  { db: 'GenBank', re: /\b(?:[A-Z]{1,2}_?\d{5,8}|[A-Z]{4}\d{8,10})(?:\.\d+)?\b/g, context: /\b(?:GenBank|accession|RefSeq|ENA|DDBJ|NCBI)\b/i, url: (id) => `https://www.ncbi.nlm.nih.gov/nuccore/${id}` },
]

const STATEMENT_HEADING = /^(?:#{1,6}\s*|\*\*)?\s*((?:data|code|software|materials?)(?:\s+and\s+(?:data|code|software|materials?))?\s+(?:availability|sharing)(?:\s+statement)?|availability\s+of\s+(?:data|code|software|materials?)(?:\s+and\s+(?:data|code|software|materials?))?|data\s+sharing\s+statement)\b[\s:*.]*$/i
const STATEMENT_INLINE = /\b((?:data|code|software)(?:\s+and\s+(?:data|code|software))?\s+availability(?:\s+statement)?)\s*[:.]\s*(.{20,})/i
const ON_REQUEST = /(on (?:reasonable )?request|upon (?:reasonable )?request|available from the (?:corresponding )?author|contact the (?:corresponding )?author)/i
const NOT_AVAILABLE = /(not (?:publicly )?available|cannot be shared|are not shared|restricted (?:access|by)|proprietary|confidential)/i

function trimUrl(raw) {
  return raw.replace(/[.,;:)\]}>'"]+$/g, '')
}

export function extractUrls(text) {
  const urls = new Set()
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const url = trimUrl(match[0])
    try {
      urls.add(new URL(url).href)
    } catch { /* not a URL */ }
  }
  return [...urls]
}

export function extractDois(text) {
  const dois = new Set()
  for (const match of text.matchAll(/\b10\.\d{4,9}\/[^\s"<>]+/g)) {
    const doi = canonicalDoi(trimUrl(match[0]))
    if (doi) dois.add(doi)
  }
  return [...dois]
}

export function classifyRepository({ url, doi }) {
  let host = ''
  if (url) {
    try { host = new URL(url).hostname.toLowerCase() } catch { /* ignore */ }
  }
  for (const repo of REPOSITORIES) {
    if ((host && repo.host.test(host)) || (doi && repo.doi?.test(doi))) return repo
  }
  return null
}

export function extractAccessions(text) {
  const found = new Map()
  for (const spec of ACCESSIONS) {
    for (const match of text.matchAll(spec.re)) {
      const id = match[0]
      if (spec.context) {
        const window = text.slice(Math.max(0, match.index - 60), match.index + id.length + 20)
        if (!spec.context.test(window)) continue
        // A bare four-character PDB id that is all digits or a year-like number is not an id.
        if (spec.db === 'PDB' && (/^\d+$/.test(id) || !/[A-Za-z]/.test(id))) continue
        if (spec.db === 'GenBank' && /^\d/.test(id)) continue
      }
      const key = `${spec.db}:${id.toUpperCase()}`
      if (!found.has(key)) {
        found.set(key, { database: spec.db, accession: id, resolver_url: spec.url(id), status: 'unverified' })
      }
    }
  }
  return [...found.values()]
}

export function extractStatements(text) {
  const lines = text.split(/\r?\n/)
  const statements = []
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].trim().match(STATEMENT_HEADING)
    let label = null
    let body = ''
    if (heading) {
      label = heading[1]
      const parts = []
      for (let next = index + 1; next < lines.length && parts.join(' ').length < 1500; next += 1) {
        const line = lines[next].trim()
        if (!line && parts.length) break
        if (/^#{1,6}\s/.test(line)) break
        if (line) parts.push(line)
      }
      body = parts.join(' ')
    } else {
      const inline = lines[index].match(STATEMENT_INLINE)
      if (inline) {
        label = inline[1]
        body = inline[2].trim()
      }
    }
    if (!label || !body) continue
    const kind = /code|software/i.test(label) && !/data/i.test(label) ? 'code' : 'data'
    statements.push({
      kind,
      heading: label.replace(/\s+/g, ' '),
      text: body.slice(0, 1500),
      urls: extractUrls(body),
      on_request: ON_REQUEST.test(body),
      not_available: NOT_AVAILABLE.test(body),
    })
  }
  return statements
}

export function extractArtifacts(text) {
  const urls = extractUrls(text)
  const dois = extractDois(text)
  const artifacts = []
  const seen = new Set()
  for (const url of urls) {
    const repo = classifyRepository({ url })
    const doiMatch = url.match(/doi\.org\/(10\.\d{4,9}\/.+)$/i)
    const doi = doiMatch ? canonicalDoi(doiMatch[1]) : null
    const doiRepo = doi ? classifyRepository({ doi }) : null
    const found = repo || doiRepo
    if (!found && !doi) continue
    if (seen.has(url)) continue
    seen.add(url)
    artifacts.push({ url, doi, repository: found?.id || null, repository_label: found?.label || null, kind: found?.kind || 'link', status: 'unverified' })
  }
  for (const doi of dois) {
    const repo = classifyRepository({ doi })
    if (!repo) continue
    const url = `https://doi.org/${doi}`
    if (seen.has(url) || artifacts.some((a) => a.doi === doi)) continue
    seen.add(url)
    artifacts.push({ url, doi, repository: repo.id, repository_label: repo.label, kind: repo.kind, status: 'unverified' })
  }
  return {
    artifacts,
    accessions: extractAccessions(text),
    statements: extractStatements(text),
    other_urls: urls.filter((url) => !seen.has(url)).length,
  }
}

async function assertPublic(url) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
  if (privateHostname(url.hostname)) return false
  const host = url.hostname.replace(/^\[|\]$/g, '')
  try {
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true })
    return addresses.length > 0 && !addresses.some((entry) => privateAddress(entry.address))
  } catch {
    return false
  }
}

/** HEAD (falling back to a one-byte GET) with manual redirects, each hop re-checked for a public host. */
export async function checkLink(raw, { signal, timeoutMs = 10_000 } = {}) {
  let url
  try { url = new URL(raw) } catch { return { status: 'error', detail: 'not a URL' } }
  for (let hop = 0; hop <= 4; hop += 1) {
    if (!(await assertPublic(url))) return { status: 'unsafe_host', detail: 'host is local, private, or did not resolve', final_url: url.href }
    const attempt = async (method) => fetch(url, {
      method,
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'Academic Harness/1.0 (paper_artifacts)', ...(method === 'GET' ? { Range: 'bytes=0-0' } : {}) },
    })
    let response
    try {
      response = await attempt('HEAD')
      if ([403, 405, 501].includes(response.status)) response = await attempt('GET')
      try { await response.body?.cancel() } catch { /* ignore */ }
    } catch (error) {
      const cause = error?.cause?.code || error?.cause?.errors?.[0]?.code || error?.name
      return { status: 'error', detail: `${error instanceof Error ? error.message : String(error)}${cause ? ` (${cause})` : ''}`, final_url: url.href }
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) return { status: 'error', http: response.status, detail: 'redirect without Location', final_url: url.href }
      url = new URL(location, url)
      continue
    }
    const http = response.status
    if (http >= 200 && http < 300) return { status: hop ? 'resolves_after_redirect' : 'resolves', http, final_url: url.href, content_type: response.headers.get('content-type') || null }
    if (http === 404 || http === 410) return { status: 'not_found', http, final_url: url.href }
    if ([401, 403, 429].includes(http)) return { status: 'provider_blocked', http, final_url: url.href }
    return { status: 'error', http, final_url: url.href }
  }
  return { status: 'error', detail: 'too many redirects', final_url: url.href }
}

async function loadText(args, cwd) {
  if (typeof args.text === 'string' && args.text.trim()) return { text: args.text, source: 'text' }
  if (typeof args.path === 'string' && args.path.trim()) {
    const target = resolveWorkspacePath(cwd, args.path)
    if (statSync(target).size > MAX_TEXT_BYTES) throw new Error(`${args.path} is larger than ${MAX_TEXT_BYTES / (1024 * 1024)}MB`)
    return { text: readFileSync(target, 'utf8'), source: args.path }
  }
  throw new Error('give text or path (a PaperMemory paper can be exported to Markdown with paper_fold and passed as path)')
}

export async function runPaperArtifacts(args, exec, deps = {}) {
  const action = args.action || 'extract'
  if (!ARTIFACT_ACTIONS.includes(action)) throw new Error(`action must be one of ${ARTIFACT_ACTIONS.join(', ')}`)
  const cwd = exec?.agent?.session?.header?.cwd || process.cwd()
  const { text, source } = await loadText(args, cwd)
  const found = extractArtifacts(text)
  const result = { action, source, extracted_at: nowIso(), ...found, verified: 0, unchecked: 0 }
  const wantVerify = action === 'verify' || args.verify === true
  if (wantVerify) {
    const cap = Math.min(Math.max(Number(args.max_verify) || DEFAULT_VERIFY_CAP, 1), HARD_VERIFY_CAP)
    const check = deps.checkLink || checkLink
    const targets = [
      ...found.artifacts,
      ...found.statements.flatMap((s) => s.urls.map((url) => ({ url, from_statement: true }))),
    ]
    const unique = [...new Map(targets.map((t) => [t.url, t])).values()]
    const results = new Map()
    for (const target of unique.slice(0, cap)) {
      results.set(target.url, { ...(await check(target.url, { signal: exec?.signal })), checked_at: nowIso() })
    }
    for (const artifact of found.artifacts) {
      const res = results.get(artifact.url)
      if (res) Object.assign(artifact, res)
      else artifact.status = 'manual_check'
    }
    for (const statement of found.statements) {
      statement.link_checks = statement.urls.map((url) => ({ url, ...(results.get(url) || { status: 'manual_check' }) }))
    }
    result.verified = results.size
    result.unchecked = Math.max(0, unique.length - results.size)
  }
  if (args.out) {
    const target = resolveWorkspacePath(cwd, args.out, { forWrite: true })
    result.written = exportText(target, `${JSON.stringify(result, null, 2)}\n`, { overwrite: Boolean(args.overwrite) })
  }
  result.caveats = [
    'Extraction is pattern matching: review it against the paper.',
    'A link that resolves does not show it holds the data or code the paper describes.',
    'Accessions are unverified until looked up in their database (use science_source or the database itself).',
  ]
  return result
}

function render(value) {
  if (value?.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const lines = [`Paper artifacts from ${value.source}: ${value.artifacts.length} repository link(s), ${value.accessions.length} accession(s), ${value.statements.length} availability statement(s).`]
  for (const statement of value.statements) {
    const flags = [statement.on_request && 'on request only', statement.not_available && 'says not available'].filter(Boolean).join(', ')
    lines.push(`- ${statement.kind} statement${flags ? ` (${flags})` : ''}: ${statement.text.slice(0, 220)}${statement.text.length > 220 ? '…' : ''}`)
  }
  for (const artifact of value.artifacts.slice(0, 30)) {
    lines.push(`- ${artifact.repository_label || artifact.kind}: ${artifact.url} — ${artifact.status}${artifact.http ? ` (HTTP ${artifact.http})` : ''}`)
  }
  for (const accession of value.accessions.slice(0, 30)) lines.push(`- ${accession.database} ${accession.accession} — unverified (${accession.resolver_url})`)
  if (value.unchecked) lines.push(`${value.unchecked} link(s) not checked (over the max_verify cap): manual_check.`)
  if (value.written) lines.push(`Wrote ${value.written.path}.`)
  lines.push(...value.caveats.map((c) => `Note: ${c}`))
  return [{ type: 'text', text: lines.join('\n') }]
}

/** The host requires lossless JSON: no `undefined` fields, no non-finite numbers. */
function plain(value) {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)))
}

export const name = 'academic-harness-paper-artifacts'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'paper_artifacts',
    description: [
      'Extract data/code/accession references and data/code availability statements from a paper\'s text, and optionally check that the links answer.',
      'Finds repository links (Zenodo, Figshare, OSF, Dryad, Dataverse, GitHub, GitLab, Hugging Face, Kaggle, Software Heritage), GEO/SRA/BioProject/ArrayExpress/PRIDE/MassIVE/EGA accessions, and PDB/GenBank ids that appear with context. `verify` sends a HEAD (or one-byte GET) with a timeout to public hosts only, capped by `max_verify`; it never downloads data (use dataset_get) and never calls an accession verified. A link that resolves is not proof it holds what the paper says. Input is `text` or a workspace `path`; export a PaperMemory paper to Markdown with paper_fold first. Load the `reference-audit` skill when judging a statement.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ARTIFACT_ACTIONS, description: 'extract (default) or verify (extract + check links).' },
      text: { type: 'string', description: 'Paper text or Markdown.' },
      path: { type: 'string', description: 'Workspace-relative text/Markdown file.' },
      verify: { type: 'boolean', description: 'extract: also check links.' },
      max_verify: { type: 'number', description: 'Most links to check, 1-100. Default 25; the rest are manual_check.' },
      out: { type: 'string', description: 'Workspace-relative JSON path to write the result.' },
      overwrite: { type: 'boolean', description: 'Replace an existing out file.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => render(value) },
    async execute(args, exec) {
      try {
        return plain(await runPaperArtifacts(args, exec))
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Paper artifacts (${args.action || 'extract'})`, kind: 'other' }
    },
  }))
}
