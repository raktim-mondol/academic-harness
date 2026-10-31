/**
 * Local PHI/PII detection and redaction under `<cwd>/.dsh/deidentify/<slug>/`.
 *
 * Detection is regex/heuristic only, runs locally with no model call, and its
 * report is always masked. The tool does not certify HIPAA/GDPR compliance;
 * a human must review every report, and no reversible mapping is written.
 */
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import {
  appendJsonl, ensureDir, exportText, mdCell, nowIso, readJsonl,
  sha256, slug as slugify,
} from './ledger-kit.js'
import { withLock } from './store-lock.js'
import { resolveWorkspacePath } from './workspace-path.js'

export const DEIDENTIFY_ACTIONS = ['scan', 'redact', 'report', 'verify']
export const DEIDENTIFY_REPORT_FORMATS = ['markdown', 'json']
export const DEIDENTIFY_ACTIONS_FOR_TYPES = ['mask', 'type', 'hash', 'remove']
const MAX_BYTES = 20 * 1024 * 1024
const MAX_MATCHES = 1000

function text(value) {
  return String(value ?? '').trim()
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function deidentifySlug(value) {
  const slug = slugify(value, 80)
  if (!slug) throw new Error('slug must contain at least one letter or digit')
  return slug
}

export function deidentifyDir(cwd, value) {
  return join(cwd, '.dsh', 'deidentify', deidentifySlug(value))
}

function files(cwd, value) {
  const dir = deidentifyDir(cwd, value)
  return {
    dir,
    scans: join(dir, 'scans.jsonl'),
    redactions: join(dir, 'redactions.jsonl'),
    reports: join(dir, 'reports'),
  }
}

function detectors(extraTerms = [], extraNames = []) {
  const list = [
    { type: 'email', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
    { type: 'phone', pattern: /(?<!\d)(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3}[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g },
    { type: 'phone', pattern: /(?<!\d)(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3}[\s.-]\d{4}(?!\d)/g },
    { type: 'phone', pattern: /\+\d{10,15}\b/g },
    { type: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
    { type: 'mrn', pattern: /\b(?:MRN|medical record(?: number)?|record no\.?|record number)\s*[:#]?\s*[A-Z0-9][A-Z0-9-]{3,}\b/gi },
    { type: 'date', pattern: /\b\d{4}-\d{2}-\d{2}\b/g },
    { type: 'date', pattern: /\b\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4})\b/g },
    { type: 'date', pattern: /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b/gi },
    { type: 'age_over_89', pattern: /\b(?:age\s*[:=]?\s*)?(?:9\d|1\d{2})\s*(?:years?|yrs?|yo|y\/o)\b/gi },
    { type: 'address', pattern: /\b\d{1,6}\s+[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl)\.?\b/g },
    { type: 'url', pattern: /\bhttps?:\/\/[^\s<>"']+/gi },
    { type: 'ip', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
    { type: 'mac', pattern: /\b(?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}\b/gi },
    { type: 'account', pattern: /\b(?:account|acct|policy|member|insurance)\s*(?:number|no\.?|#)?\s*[:#]?\s*[A-Z0-9-]{6,}\b/gi },
    { type: 'zip', pattern: /\b(?:ZIP|postal code)\s*[:#]?\s*\d{5}(?:-\d{4})?\b/gi },
    { type: 'name', pattern: /\b(?:Dr|Prof|Mr|Mrs|Ms|Mx)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/g },
    { type: 'name', pattern: /\b(?:patient|subject|participant|name)\s*[:=]\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/gi },
  ]
  for (const term of extraTerms) {
    if (!text(term)) continue
    list.push({ type: 'custom', pattern: new RegExp(`(?<![A-Za-z0-9])${escapeRegex(term)}(?![A-Za-z0-9])`, 'gi') })
  }
  for (const name of extraNames) {
    if (!text(name)) continue
    list.push({ type: 'name', pattern: new RegExp(`(?<![A-Za-z0-9])${escapeRegex(name)}(?![A-Za-z0-9])`, 'gi') })
  }
  return list
}

function maskValue(value) {
  const raw = String(value)
  if (raw.length <= 2) return '***'
  if (raw.length <= 5) return `${raw[0]}***`
  return `${raw[0]}***${raw[raw.length - 1]}`
}

function lineStarts(body) {
  const starts = [0]
  for (let index = 0; index < body.length; index += 1) if (body[index] === '\n') starts.push(index + 1)
  return starts
}

function location(starts, offset) {
  let low = 0
  let high = starts.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (starts[middle] <= offset) low = middle + 1
    else high = middle - 1
  }
  return { line: high + 1, column: offset - starts[high] + 1 }
}

function parseDelimited(body, delimiter) {
  const rows = []
  const cells = []
  let row = []
  let field = ''
  let fieldStart = 0
  let inQuotes = false
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (inQuotes) {
      if (char === '"' && body[index + 1] === '"') { field += '"'; index += 1 }
      else if (char === '"') inQuotes = false
      else field += char
    } else if (char === '"' && field === '') inQuotes = true
    else if (char === delimiter) {
      row.push({ value: field, start: fieldStart, end: index })
      field = ''
      fieldStart = index + 1
    } else if (char === '\n') {
      if (field.endsWith('\r')) field = field.slice(0, -1)
      row.push({ value: field, start: fieldStart, end: index })
      rows.push(row)
      row = []
      field = ''
      fieldStart = index + 1
    } else field += char
  }
  if (field || row.length) {
    row.push({ value: field, start: fieldStart, end: body.length })
    rows.push(row)
  }
  if (!rows.length) return { rows: [], header: [], cells: [] }
  const header = rows[0].map((cell) => cell.value)
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    rows[rowIndex].forEach((cell, column) => {
      cells.push({ ...cell, row: rowIndex, column, name: header[column] || `col${column + 1}` })
    })
  }
  return { rows, header, cells }
}

function columnFor(cells, start, end) {
  const cell = cells.find((entry) => entry.start <= start && start < entry.end)
  return cell ? { name: cell.name, column: cell.column } : null
}

export function scanText(body, { kind = 'text', terms = [], names = [], filename = null } = {}) {
  if (typeof body !== 'string') throw new Error('body must be a string')
  const delimited = kind === 'csv' || kind === 'tsv' ? parseDelimited(body, kind === 'csv' ? ',' : '\t') : null
  const starts = lineStarts(body)
  const found = []
  for (const detector of detectors(terms, names)) {
    for (const match of body.matchAll(detector.pattern)) {
      const value = match[0]
      if (!value) continue
      if (detector.type === 'ip') {
        const octets = value.split('.').map(Number)
        if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) continue
      }
      const offset = match.index
      const locationInfo = location(starts, offset)
      const column = delimited ? columnFor(delimited.cells, offset, offset + value.length) : null
      found.push({
        type: detector.type,
        start: offset,
        end: offset + value.length,
        ...locationInfo,
        preview: maskValue(value),
        ...(column ? { column_name: column.name, column_index: column.column } : {}),
      })
    }
  }
  const unique = new Map()
  for (const match of found) unique.set(`${match.type}\u0000${match.start}\u0000${match.end}`, match)
  const grouped = new Map()
  for (const match of unique.values()) {
    if (!grouped.has(match.type)) grouped.set(match.type, [])
    grouped.get(match.type).push(match)
  }
  const matches = []
  for (const group of grouped.values()) {
    let coveredUntil = -1
    for (const match of group.sort((a, b) => a.start - b.start || b.end - a.end)) {
      if (match.end <= coveredUntil) continue
      matches.push(match)
      coveredUntil = Math.max(coveredUntil, match.end)
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end || a.type.localeCompare(b.type))
  const byType = {}
  for (const match of matches) byType[match.type] = (byType[match.type] || 0) + 1
  const columns = delimited
    ? [...new Set(matches.map((match) => match.column_name).filter(Boolean))].map((name) => {
      const entries = matches.filter((match) => match.column_name === name)
      const counts = {}
      for (const entry of entries) counts[entry.type] = (counts[entry.type] || 0) + 1
      return { name, matches: entries.length, by_type: counts }
    })
    : []
  return {
    filename, kind, bytes: Buffer.byteLength(body), sha256: `sha256:${sha256(body)}`,
    match_count: matches.length, by_type: byType, columns,
    matches: matches.slice(0, MAX_MATCHES), truncated: matches.length > MAX_MATCHES,
    note: 'Regex/heuristic detection only. A human must review every match; zero matches does not prove the file is de-identified.',
  }
}

function kindFor(file) {
  const extension = extname(file).toLowerCase()
  if (extension === '.csv') return 'csv'
  if (extension === '.tsv') return 'tsv'
  if (extension === '.json') return 'json'
  return 'text'
}

function readWorkspaceText(cwd, relativePath) {
  const abs = resolveWorkspacePath(cwd, relativePath)
  if (!existsSync(abs)) throw new Error(`file not found: ${relativePath}`)
  const stat = statSync(abs)
  if (!stat.isFile()) throw new Error(`not a file: ${relativePath}`)
  if (stat.size > MAX_BYTES) throw new Error(`file is larger than ${MAX_BYTES} bytes`)
  const buffer = readFileSync(abs)
  if (buffer.includes(0)) throw new Error('file appears to be binary; deidentify supports text, JSON, and delimited tables')
  return { abs, body: buffer.toString('utf8'), bytes: buffer.length, sha256: `sha256:${sha256(buffer)}` }
}

function nextId(records, prefix) {
  const field = prefix === 'r' ? 'redaction_id' : 'scan_id'
  const last = records.at(-1)?.[field]
  const numberValue = last ? Number(last.replace(/\D/g, '')) : 0
  return `${prefix}${String((Number.isFinite(numberValue) ? numberValue : records.length) + 1).padStart(4, '0')}`
}

const termKeyCache = new Map()

function termKey(cwd) {
  const root = join(cwd, '.dsh', 'deidentify')
  ensureDir(root)
  const file = join(root, '.term-key')
  if (termKeyCache.has(file)) return termKeyCache.get(file)
  if (!existsSync(file)) {
    try {
      writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  const key = readFileSync(file, 'utf8').trim()
  termKeyCache.set(file, key)
  return key
}

function termHashes(cwd, terms) {
  const values = terms.map(text).filter(Boolean)
  if (!values.length) return []
  const key = termKey(cwd)
  return values.map((term) => createHmac('sha256', key).update(term).digest('hex').slice(0, 16))
}

export async function scanFile({ cwd, slug, file, kind = null, terms = [], names = [] }) {
  const f = files(cwd, slug)
  ensureDir(f.dir)
  const { body, bytes, sha256: hash } = readWorkspaceText(cwd, file)
  const resolvedKind = text(kind).toLowerCase() || kindFor(file)
  if (!['text', 'csv', 'tsv', 'json'].includes(resolvedKind)) throw new Error('kind must be text, csv, tsv, or json')
  const report = scanText(body, { kind: resolvedKind, terms, names, filename: file })
  const hashes = termHashes(cwd, [...terms, ...names])
  const record = {
    scan_id: null, ts: nowIso(), file, kind: resolvedKind, bytes, sha256: hash,
    ...report, custom_terms: hashes.length, term_hashes: hashes,
  }
  return withLock(f.dir, async () => {
    const existing = readJsonl(f.scans)
    record.scan_id = nextId(existing, 'd')
    appendJsonl(f.scans, [record])
    return { scan: record }
  }, { label: 'deidentify ledger' })
}

export function readScan(cwd, slug, scanId = null) {
  const records = readJsonl(files(cwd, slug).scans)
  if (!records.length) throw new Error(`no scan exists for "${deidentifySlug(slug)}"`)
  if (scanId == null || scanId === '') return records.at(-1)
  const record = records.find((entry) => entry.scan_id === scanId)
  if (!record) throw new Error(`scan "${scanId}" not found`)
  return record
}

function actionFor(type, policy = {}, column = null) {
  if (column && policy.columns && policy.columns[column] != null) return policy.columns[column]
  if (policy.types && policy.types[type] != null) return policy.types[type]
  return policy.default_action || 'mask'
}

function placeholder(type, value, action) {
  if (action === 'type') return `[${type.toUpperCase()}]`
  if (action === 'hash') return `[${type.toUpperCase()}:${sha256(value).slice(0, 12)}]`
  if (action === 'remove') return ''
  return '*'.repeat(value.length)
}

function applyTextRedaction(body, matches, policy) {
  const ranges = []
  for (const match of matches) {
    const action = actionFor(match.type, policy, match.column_name)
    if (action === 'drop') {
      throw new Error('action "drop" is only valid for a CSV/TSV column; use "remove" for text, JSON, and individual values')
    }
    if (!DEIDENTIFY_ACTIONS_FOR_TYPES.includes(action)) throw new Error(`unknown redaction action "${action}"; use ${DEIDENTIFY_ACTIONS_FOR_TYPES.join(', ')}`)
    ranges.push({ start: match.start, end: match.end, replacement: placeholder(match.type, body.slice(match.start, match.end), action) })
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (!last || range.start >= last.end) {
      merged.push({ ...range, overlapping: false })
      continue
    }
    last.end = Math.max(last.end, range.end)
    last.overlapping = true
  }
  let output = ''
  let cursor = 0
  for (const range of merged) {
    output += body.slice(cursor, range.start)
    output += range.overlapping ? '*'.repeat(range.end - range.start) : range.replacement
    cursor = range.end
  }
  output += body.slice(cursor)
  return output
}

function redactDelimited(body, kind, matches, policy, terms = [], names = []) {
  const delimiter = kind === 'csv' ? ',' : '\t'
  const parsed = parseDelimited(body, delimiter)
  if (!parsed.rows.length) return body
  const dropColumns = new Set()
  for (const [key, action] of Object.entries(policy.columns || {})) {
    if (action !== 'drop' && action !== 'drop_column') continue
    const index = Number.isInteger(Number(key)) ? Number(key) : parsed.header.indexOf(key)
    if (index < 0 || index >= parsed.header.length) throw new Error(`drop column "${key}" was not found in the header`)
    dropColumns.add(index)
  }
  const cellsWithMatches = new Set()
  for (const match of matches) {
    const cell = parsed.cells.find((entry) => entry.start <= match.start && match.start < entry.end)
    if (cell) cellsWithMatches.add(`${cell.row}\u0000${cell.column}`)
  }
  const outputRows = []
  for (let rowIndex = 0; rowIndex < parsed.rows.length; rowIndex += 1) {
    const row = parsed.rows[rowIndex]
    const output = []
    for (let column = 0; column < row.length; column += 1) {
      if (dropColumns.has(column)) continue
      const cell = row[column]
      const name = parsed.header[column] || `col${column + 1}`
      if (!cellsWithMatches.has(`${rowIndex}\u0000${column}`)) { output.push(cell.value); continue }
      const localReport = scanText(cell.value, { kind: 'text', terms, names })
      if (!localReport.matches.length) { output.push(cell.value); continue }
      const columnAction = policy.columns?.[name] ?? policy.columns?.[String(column)]
      if (columnAction === 'hash') {
        output.push(sha256(cell.value).slice(0, 16))
        continue
      }
      if (columnAction === 'generalize') {
        output.push(generalizeValue(localReport.matches[0].type, cell.value))
        continue
      }
      const cellPolicy = columnAction && columnAction !== 'drop' && columnAction !== 'drop_column'
        ? { default_action: columnAction, types: {} }
        : { default_action: policy.default_action, types: policy.types }
      output.push(applyTextRedaction(cell.value, localReport.matches, cellPolicy))
    }
    outputRows.push(output)
  }
  const quote = (value) => {
    const raw = String(value ?? '')
    return `"${raw.replace(/"/g, '""')}"`
  }
  return `${outputRows.map((row) => row.map(quote).join(delimiter)).join('\n')}\n`
}

function generalizeValue(type, value) {
  if (type === 'date') {
    const match = String(value).match(/\b(\d{4})\b/)
    return match ? match[1] : '[DATE]'
  }
  if (type === 'age_over_89') return '90+'
  if (type === 'zip') {
    const match = String(value).match(/\d{5}/)
    return match ? `${match[0].slice(0, 3)}**` : '[ZIP]'
  }
  return placeholder(type, value, 'type')
}

export async function redactFile({ cwd, slug, file, out, scanId = null, policy = {}, terms = [], names = [], overwrite = false, recordedBy = null }) {
  const f = files(cwd, slug)
  ensureDir(f.dir)
  const scan = scanId ? readScan(cwd, slug, scanId) : null
  if (scan && file && scan.file !== file) throw new Error(`scan ${scan.scan_id} is for "${scan.file}", not "${file}"`)
  const sourceFile = scan?.file || file
  const input = readWorkspaceText(cwd, sourceFile)
  if (scan && scan.sha256 !== input.sha256) throw new Error(`scan ${scan.scan_id} was taken from a different file version; rescan before redacting`)
  if (!text(out)) throw new Error('out is required; redaction never overwrites the input in place')
  const outAbs = resolveWorkspacePath(cwd, out, { forWrite: true })
  if (outAbs === input.abs) throw new Error('out must differ from the input; redaction never edits in place')
  if (existsSync(outAbs) && !overwrite) throw new Error(`${out} already exists; pass overwrite: true to replace it`)
  const kind = text(policy.kind).toLowerCase() || scan?.kind || kindFor(sourceFile)
  const effectiveTerms = terms
  const effectiveNames = names
  if (scan?.custom_terms && !effectiveTerms.length && !effectiveNames.length) {
    throw new Error(`scan ${scan.scan_id} used custom terms; pass the same terms/names again to redact (the ledger stores only their hashes)`)
  }
  if (scan?.term_hashes?.length) {
    const supplied = new Set(termHashes(cwd, [...effectiveTerms, ...effectiveNames]))
    const missing = scan.term_hashes.filter((hash) => !supplied.has(hash))
    if (missing.length) throw new Error(`the supplied terms/names do not match scan ${scan.scan_id}; pass the same custom terms used for the scan`)
  }
  const report = scanText(input.body, { kind, terms: effectiveTerms, names: effectiveNames, filename: sourceFile })
  if (report.truncated) {
    throw new Error(`too many candidate matches (${report.match_count}) to redact safely; split the file or narrow the terms and rescan`)
  }
  const redacted = kind === 'csv' || kind === 'tsv'
    ? redactDelimited(input.body, kind, report.matches, policy, effectiveTerms, effectiveNames)
    : applyTextRedaction(input.body, report.matches, policy)
  const result = exportText(outAbs, redacted, { overwrite: true })
  const residual = scanText(redacted, { kind, terms: effectiveTerms, names: effectiveNames, filename: out })
  const record = {
    redaction_id: null, ts: nowIso(), scan_id: scan?.scan_id || null, input: sourceFile, out,
    input_sha256: input.sha256, output_sha256: `sha256:${sha256(redacted)}`, bytes: result.bytes,
    matches_before: report.match_count, by_type_before: report.by_type,
    residual: { match_count: residual.match_count, by_type: residual.by_type, columns: residual.columns, matches: residual.matches.slice(0, 200) },
    policy, custom_terms: effectiveTerms.length + effectiveNames.length,
    term_hashes: termHashes(cwd, [...effectiveTerms, ...effectiveNames]),
    recorded_by: text(recordedBy) || null,
    note: `No reversible mapping was written. Regex/heuristic redaction is not a compliance certification; review the residual report.${kind === 'json' ? ' JSON is redacted textually: re-parse the output, because a numeric match replaced in place can invalidate the document.' : ''}`,
  }
  return withLock(f.dir, async () => {
    const existing = readJsonl(f.redactions)
    record.redaction_id = nextId(existing, 'r')
    appendJsonl(f.redactions, [record])
    return { redaction: record, residual }
  }, { label: 'deidentify ledger' })
}

export function verifyFile({ cwd, slug, file = null, redactionId = null, terms = [], names = [] }) {
  const f = files(cwd, slug)
  const redactions = readJsonl(f.redactions)
  let target = file
  let stored = null
  if (redactionId) {
    stored = redactions.find((entry) => entry.redaction_id === redactionId)
    if (!stored) throw new Error(`redaction "${redactionId}" not found`)
    target = stored.out
    if (stored.custom_terms && !terms.length && !names.length) {
      throw new Error(`redaction ${stored.redaction_id} used custom terms; pass them again to verify (the ledger stores only their hashes)`)
    }
    if (stored.term_hashes?.length) {
      const supplied = new Set(termHashes(cwd, [...terms, ...names]))
      if (stored.term_hashes.some((hash) => !supplied.has(hash))) throw new Error(`the supplied terms/names do not match redaction ${stored.redaction_id}`)
    }
  }
  if (!target) throw new Error('verify needs file or redaction_id')
  const { body, sha256: currentHash } = readWorkspaceText(cwd, target)
  if (stored?.output_sha256 && currentHash !== stored.output_sha256) {
    return {
      file: target, redaction_id: redactionId || null, status: 'modified', residual: null,
      note: 'The file hash differs from the redaction record. It was changed after redaction; re-scan and redo the redaction rather than trusting the old residual report.',
    }
  }
  const kind = kindFor(target)
  const report = scanText(body, { kind, terms, names, filename: target })
  return {
    file: target, redaction_id: redactionId || null,
    status: report.match_count === 0 ? 'clean' : 'residual_matches',
    residual: { match_count: report.match_count, by_type: report.by_type, matches: report.matches.slice(0, 200) },
    note: report.match_count === 0
      ? 'No pattern match remains. This is not proof of de-identification; review the file and the report.'
      : 'Pattern matches remain; redact again or review whether they are false positives.',
  }
}

function reportMarkdown(record, redactions = []) {
  const lines = [
    `# De-identification scan ${record.scan_id}`,
    '',
    `**File:** \`${record.file}\` · ${record.bytes} bytes · ${record.kind}`,
    `**Sha256:** \`${record.sha256}\``,
    `**Matches:** ${record.match_count}${record.truncated ? ' (report capped at 1000)' : ''}`,
    '',
    '| Type | Count |',
    '|---|---|',
    ...Object.entries(record.by_type).map(([type, count]) => `| ${type} | ${count} |`),
    '',
  ]
  if (record.columns.length) {
    lines.push('## Columns', '', '| Column | Matches | Types |', '|---|---|---|')
    for (const column of record.columns) lines.push(`| ${mdCell(column.name)} | ${column.matches} | ${mdCell(Object.entries(column.by_type).map(([type, count]) => `${type}:${count}`).join(', '))} |`)
    lines.push('')
  }
  if (record.matches.length) {
    lines.push('## Matches (masked)', '', '| Type | Line | Column | Preview |', '|---|---|---|---|')
    for (const match of record.matches.slice(0, 200)) lines.push(`| ${match.type} | ${match.line} | ${match.column} | ${mdCell(match.preview)} |`)
    if (record.matches.length > 200) lines.push(`\n_${record.matches.length - 200} more matches are in the JSON report._`)
    lines.push('')
  }
  const related = redactions.filter((entry) => entry.scan_id === record.scan_id)
  if (related.length) {
    lines.push('## Redactions', '')
    for (const entry of related) lines.push(`- ${entry.redaction_id} → \`${entry.out}\` · before ${entry.matches_before} · residual ${entry.residual.match_count}`)
    lines.push('')
  }
  lines.push(`> ${record.note}`, '')
  return lines.join('\n')
}

export function exportDeidentifyReport({ cwd, slug, scanId = null, format = 'markdown', out = null, overwrite = false }) {
  const record = readScan(cwd, slug, scanId)
  const redactions = readJsonl(files(cwd, slug).redactions)
  const kind = text(format).toLowerCase() || 'markdown'
  if (!DEIDENTIFY_REPORT_FORMATS.includes(kind)) throw new Error(`format must be one of ${DEIDENTIFY_REPORT_FORMATS.join(', ')}`)
  const dir = files(cwd, slug).reports
  ensureDir(dir)
  const target = out ? resolveWorkspacePath(cwd, out, { forWrite: true }) : join(dir, `${record.scan_id}.${kind === 'json' ? 'json' : 'md'}`)
  if (kind === 'json') {
    const result = exportText(target, `${JSON.stringify({ scan: record, redactions: redactions.filter((entry) => entry.scan_id === record.scan_id) }, null, 2)}\n`, { overwrite })
    return { ...result, format: 'json', scan_id: record.scan_id }
  }
  const result = exportText(target, reportMarkdown(record, redactions), { overwrite })
  return { ...result, format: 'markdown', scan_id: record.scan_id }
}

export function deidentifyStatus(cwd, slug) {
  const scans = readJsonl(files(cwd, slug).scans)
  const redactions = readJsonl(files(cwd, slug).redactions)
  return {
    slug: deidentifySlug(slug), dir: files(cwd, slug).dir,
    scans: scans.map((entry) => ({ scan_id: entry.scan_id, file: entry.file, match_count: entry.match_count, by_type: entry.by_type, ts: entry.ts })),
    redactions: redactions.map((entry) => ({ redaction_id: entry.redaction_id, input: entry.input, out: entry.out, matches_before: entry.matches_before, residual: entry.residual.match_count, ts: entry.ts })),
  }
}
