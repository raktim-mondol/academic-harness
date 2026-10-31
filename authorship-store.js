/**
 * Authorship ledger: CRediT contributions and ICMJE criteria.
 *
 * The ledger records human decisions only. It never assigns author order,
 * never decides who qualifies for authorship, and never fills an unknown
 * affiliation or ORCID. Disagreements stay in the event log and are reported,
 * not resolved.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  appendJsonl, csvCell, ensureDir, exportText, mdCell, nowIso, readJson,
  readJsonl, slug as slugify, stableStringify, writeOnceJson,
} from './ledger-kit.js'
import { withLock } from './store-lock.js'

export const AUTHORSHIP_ACTIONS = ['start', 'add', 'credit', 'icmje', 'statement', 'export']
export const AUTHORSHIP_EXPORT_FORMATS = ['markdown', 'csv', 'json']

export const CREDIT_ROLES = [
  'Conceptualization',
  'Data curation',
  'Formal analysis',
  'Funding acquisition',
  'Investigation',
  'Methodology',
  'Project administration',
  'Resources',
  'Software',
  'Supervision',
  'Validation',
  'Visualization',
  'Writing – original draft',
  'Writing – review & editing',
]

export const ICMJE_CRITERIA = [
  { key: 'substantial_contributions', label: 'Substantial contributions to conception/design or acquisition/analysis/interpretation of data' },
  { key: 'drafted_or_revised', label: 'Drafted the work or revised it critically for important intellectual content' },
  { key: 'final_approval', label: 'Approved the final version to be published' },
  { key: 'accountable', label: 'Agrees to be accountable for all aspects of the work' },
]

const ROLE_ALIASES = new Map()
for (const role of CREDIT_ROLES) {
  ROLE_ALIASES.set(role.toLowerCase(), role)
  ROLE_ALIASES.set(role.toLowerCase().replace(/[–-]/g, '-'), role)
}
const EXTRA_ALIASES = {
  'writing original draft': 'Writing – original draft',
  'writing original': 'Writing – original draft',
  'writing review editing': 'Writing – review & editing',
  'writing review & editing': 'Writing – review & editing',
  'writing – review and editing': 'Writing – review & editing',
  'writing - review and editing': 'Writing – review & editing',
  'data curation': 'Data curation',
  'formal analysis': 'Formal analysis',
  'funding acquisition': 'Funding acquisition',
  'project administration': 'Project administration',
}
for (const [alias, role] of Object.entries(EXTRA_ALIASES)) ROLE_ALIASES.set(alias, role)

function text(value) {
  return String(value ?? '').trim()
}

function list(value) {
  if (value == null || value === '') return []
  const raw = Array.isArray(value) ? value : String(value).split(',')
  return raw.map(text).filter(Boolean)
}

export function authorshipSlug(value) {
  const slug = slugify(value, 80)
  if (!slug) throw new Error('slug must contain at least one letter or digit')
  return slug
}

export function authorshipDir(cwd, value) {
  return join(cwd, '.dsh', 'authorship', authorshipSlug(value))
}

function files(cwd, value) {
  const dir = authorshipDir(cwd, value)
  return {
    dir,
    record: join(dir, 'record.json'),
    authors: join(dir, 'authors.jsonl'),
    credit: join(dir, 'credit.jsonl'),
    icmje: join(dir, 'icmje.jsonl'),
    exports: join(dir, 'exports'),
  }
}

function requireRecord(cwd, slug) {
  const record = readJson(files(cwd, slug).record)
  if (!record) throw new Error(`authorship "${authorshipSlug(slug)}" has not been started`)
  return record
}

export async function startAuthorship({ cwd, slug, manuscript = null, title = null, recordedBy = null, note = null }) {
  const f = files(cwd, slug)
  ensureDir(f.dir)
  return withLock(f.dir, async () => {
    const record = {
      slug: authorshipSlug(slug),
      manuscript: text(manuscript) || null,
      title: text(title) || null,
      recorded_by: text(recordedBy) || null,
      note: text(note) || null,
      created_at: nowIso(),
      note_text: 'Human-owned record. Authorship order and qualification are never inferred.',
    }
    const existing = readJson(f.record)
    if (existing) {
      const same = stableStringify({
        manuscript: existing.manuscript, title: existing.title, recorded_by: existing.recorded_by,
      }) === stableStringify({
        manuscript: record.manuscript, title: record.title, recorded_by: record.recorded_by,
      })
      if (same) return { slug: existing.slug, created: false, record: existing }
      throw new Error(`authorship "${record.slug}" already exists with different metadata; start a new slug or keep the existing record`)
    }
    writeOnceJson(f.record, record)
    return { slug: record.slug, created: true, record }
  }, { label: 'authorship ledger' })
}

function authorEvents(cwd, slug) {
  return readJsonl(files(cwd, slug).authors)
}

export function currentAuthors(cwd, slug) {
  const events = authorEvents(cwd, slug)
  const authors = []
  for (const event of events) {
    if (event.event !== 'author') continue
    authors.push({
      author_id: event.author_id,
      name: event.name,
      affiliation: event.affiliation || [],
      orcid: event.orcid || null,
      corresponding: Boolean(event.corresponding),
      email: event.email || null,
      position: event.position ?? null,
      note: event.note || null,
      recorded_by: event.recorded_by || null,
      added_at: event.ts,
    })
  }
  return authors
}

function resolveAuthor(authors, reference) {
  const key = text(reference).toLowerCase()
  if (!key) throw new Error('author is required (author id or exact name)')
  const byId = authors.find((author) => author.author_id.toLowerCase() === key)
  if (byId) return byId
  const byName = authors.filter((author) => author.name.toLowerCase() === key)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    throw new Error(`author name "${reference}" is ambiguous; use one of ${byName.map((author) => author.author_id).join(', ')}`)
  }
  throw new Error(`no author "${reference}" in this record`)
}

export async function addAuthor({ cwd, slug, name, affiliation = null, orcid = null, corresponding = null, email = null, position = null, note = null, recordedBy = null }) {
  const f = files(cwd, slug)
  ensureDir(f.dir)
  return withLock(f.dir, async () => {
    requireRecord(cwd, slug)
    const cleanName = text(name)
    if (!cleanName) throw new Error('name is required')
    const cleanOrcid = text(orcid) ? text(orcid).replace(/^https?:\/\/orcid\.org\//i, '') : null
    if (cleanOrcid && !/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/i.test(cleanOrcid)) {
      throw new Error(`orcid "${orcid}" is not in 0000-0000-0000-0000 form`)
    }
    let cleanPosition = null
    if (position != null && position !== '') {
      cleanPosition = Math.trunc(Number(position))
      if (!Number.isFinite(cleanPosition) || cleanPosition < 1) throw new Error('position must be a positive integer')
    }
    const existing = authorEvents(cwd, slug)
    const next = existing.filter((event) => event.event === 'author').length + 1
    const author_id = `a${String(next).padStart(3, '0')}`
    const event = {
      event: 'author',
      author_id,
      name: cleanName,
      affiliation: list(affiliation),
      orcid: cleanOrcid,
      corresponding: corresponding == null ? null : Boolean(corresponding),
      email: text(email) || null,
      position: cleanPosition,
      note: text(note) || null,
      recorded_by: text(recordedBy) || null,
      ts: nowIso(),
    }
    appendJsonl(f.authors, [event])
    return {
      author_id,
      name: event.name,
      position: event.position,
      warning: event.position == null ? 'author order was not recorded; the tool does not assign one' : null,
    }
  }, { label: 'authorship ledger' })
}

export function normalizeCreditRoles(roles) {
  const values = list(roles)
  if (!values.length) throw new Error('roles must name at least one CRediT role')
  const normalized = []
  const unknown = []
  for (const value of values) {
    const key = value.toLowerCase().replace(/\s+/g, ' ').trim()
    const role = ROLE_ALIASES.get(key)
    if (!role) unknown.push(value)
    else if (!normalized.includes(role)) normalized.push(role)
  }
  if (unknown.length) {
    throw new Error(`unknown CRediT role(s): ${unknown.join(', ')}; use ${CREDIT_ROLES.join('; ')}`)
  }
  return normalized
}

export async function recordCredit({ cwd, slug, author, roles, note = null, recordedBy = null }) {
  const f = files(cwd, slug)
  ensureDir(f.dir)
  return withLock(f.dir, async () => {
    requireRecord(cwd, slug)
    const target = resolveAuthor(currentAuthors(cwd, slug), author)
    const normalized = normalizeCreditRoles(roles)
    const event = {
      event: 'credit',
      author_id: target.author_id,
      roles: normalized,
      note: text(note) || null,
      recorded_by: text(recordedBy) || null,
      ts: nowIso(),
    }
    appendJsonl(f.credit, [event])
    return { author: target.name, author_id: target.author_id, roles: normalized }
  }, { label: 'authorship ledger' })
}

function normalizeIcmje(criteria) {
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
    throw new Error('criteria must be an object with the four ICMJE keys')
  }
  const out = {}
  const missing = []
  for (const { key } of ICMJE_CRITERIA) {
    const value = criteria[key]
    if (value === true || value === false) out[key] = value
    else if (value == null || value === '' || String(value).toLowerCase() === 'unknown') {
      out[key] = null
      missing.push(key)
    } else {
      throw new Error(`ICMJE criterion "${key}" must be true, false, or unknown`)
    }
  }
  return { criteria: out, missing }
}

export async function recordIcmje({ cwd, slug, author, criteria, notes = null, recordedBy = null }) {
  const f = files(cwd, slug)
  ensureDir(f.dir)
  return withLock(f.dir, async () => {
    requireRecord(cwd, slug)
    const target = resolveAuthor(currentAuthors(cwd, slug), author)
    const normalized = normalizeIcmje(criteria)
    const event = {
      event: 'icmje',
      author_id: target.author_id,
      criteria: normalized.criteria,
      missing: normalized.missing,
      notes: text(notes) || null,
      recorded_by: text(recordedBy) || null,
      ts: nowIso(),
    }
    appendJsonl(f.icmje, [event])
    return { author: target.name, author_id: target.author_id, criteria: normalized.criteria, missing: normalized.missing }
  }, { label: 'authorship ledger' })
}

function latestByAuthor(events) {
  const latest = new Map()
  const history = new Map()
  for (const event of events) {
    if (!event.author_id) continue
    latest.set(event.author_id, event)
    if (!history.has(event.author_id)) history.set(event.author_id, [])
    history.get(event.author_id).push(event)
  }
  return { latest, history }
}

function uniqStrings(values) {
  return [...new Set(values.filter(Boolean))]
}

export function authorshipSummary(cwd, slug) {
  const record = requireRecord(cwd, slug)
  const authors = currentAuthors(cwd, slug)
  const credit = latestByAuthor(readJsonl(files(cwd, slug).credit))
  const icmje = latestByAuthor(readJsonl(files(cwd, slug).icmje))
  const conflicts = []

  const positionSeen = new Map()
  for (const author of authors) {
    if (author.position == null) continue
    const key = String(author.position)
    if (!positionSeen.has(key)) positionSeen.set(key, [])
    positionSeen.get(key).push(author.name)
  }
  for (const [position, names] of positionSeen) {
    if (names.length > 1) conflicts.push({ kind: 'duplicate_position', detail: `position ${position} is claimed by ${names.join(', ')}` })
  }

  const orcidSeen = new Map()
  for (const author of authors) {
    if (!author.orcid) continue
    if (!orcidSeen.has(author.orcid)) orcidSeen.set(author.orcid, [])
    orcidSeen.get(author.orcid).push(author.name)
  }
  for (const [orcid, names] of orcidSeen) {
    if (names.length > 1) conflicts.push({ kind: 'duplicate_orcid', detail: `${orcid} is recorded for ${names.join(', ')}` })
  }

  for (const author of authors) {
    const creditHistory = credit.history.get(author.author_id) || []
    const creditValues = uniqStrings(creditHistory.map((event) => JSON.stringify(event.roles || [])))
    if (creditValues.length > 1) {
      conflicts.push({
        kind: 'credit_disagreement',
        detail: `${author.name} has ${creditValues.length} different CRediT role sets recorded; the latest is shown, earlier events stay in the log`,
      })
    }
    const icmjeHistory = icmje.history.get(author.author_id) || []
    const icmjeValues = uniqStrings(icmjeHistory.map((event) => JSON.stringify(event.criteria || {})))
    if (icmjeValues.length > 1) {
      conflicts.push({
        kind: 'icmje_disagreement',
        detail: `${author.name} has ${icmjeValues.length} different ICMJE criterion sets recorded; the latest is shown, earlier events stay in the log`,
      })
    }
  }

  const ordered = [...authors].sort((a, b) => {
    if (a.position == null && b.position == null) return authors.indexOf(a) - authors.indexOf(b)
    if (a.position == null) return 1
    if (b.position == null) return -1
    return a.position - b.position
  })

  const rows = ordered.map((author) => {
    const creditEvent = credit.latest.get(author.author_id) || null
    const icmjeEvent = icmje.latest.get(author.author_id) || null
    return {
      ...author,
      credit_roles: creditEvent?.roles || [],
      credit_recorded_by: creditEvent?.recorded_by || null,
      icmje: icmjeEvent?.criteria || null,
      icmje_notes: icmjeEvent?.notes || null,
      icmje_recorded_by: icmjeEvent?.recorded_by || null,
    }
  })

  const corresponding = rows.filter((row) => row.corresponding === true).map((row) => row.name)
  const missingOrder = rows.filter((row) => row.position == null).map((row) => row.name)
  const missingCredit = rows.filter((row) => !row.credit_roles.length).map((row) => row.name)
  const missingIcmje = rows.filter((row) => !row.icmje).map((row) => row.name)
  const incompleteIcmje = rows
    .filter((row) => row.icmje && Object.values(row.icmje).some((value) => value == null))
    .map((row) => row.name)

  return {
    record,
    authors: rows,
    corresponding,
    conflicts,
    missing_order: missingOrder,
    missing_credit: missingCredit,
    missing_icmje: missingIcmje,
    incomplete_icmje: incompleteIcmje,
  }
}

function yesNo(value) {
  if (value === true) return 'yes'
  if (value === false) return 'no'
  return 'not recorded'
}

export function statementMarkdown(summary, { funding = null, competing_interests = null, ai_use = null, note = null } = {}) {
  const record = summary.record
  const lines = [
    `# Author contributions: ${record.title || record.slug}`,
    '',
    record.manuscript ? `**Manuscript:** \`${record.manuscript}\`  ` : '',
    record.title ? `**Title:** ${record.title}  ` : '',
    `**Record:** \`${record.slug}\` · created ${record.created_at}`,
    '',
    '## Authors (as recorded)',
    '',
    '| # | Author | Affiliation | ORCID | Corresponding |',
    '|---|---|---|---|---|',
    ...summary.authors.map((author) => `| ${author.position ?? '—'} | ${mdCell(author.name)} | ${mdCell(author.affiliation.join('; ') || 'not recorded')} | ${mdCell(author.orcid || 'not recorded')} | ${author.corresponding === true ? 'yes' : author.corresponding === false ? 'no' : 'not recorded'} |`),
    '',
    '## CRediT contributions',
    '',
    ...(summary.authors.length
      ? summary.authors.map((author) => `- **${author.name}:** ${author.credit_roles.length ? author.credit_roles.join(', ') : 'no CRediT roles recorded'}`)
      : ['No authors recorded.']),
    '',
    '## ICMJE criteria',
    '',
    '| Author | 1. Substantial contributions | 2. Drafted/revised | 3. Final approval | 4. Accountable |',
    '|---|---|---|---|---|',
    ...summary.authors.map((author) => `| ${mdCell(author.name)} | ${ICMJE_CRITERIA.map(({ key }) => yesNo(author.icmje?.[key])).join(' | ')} |`),
    '',
    '## Funding, competing interests, and AI use',
    '',
    `- **Funding:** ${funding ? funding : 'not recorded'}`,
    `- **Competing interests:** ${competing_interests ? competing_interests : 'not recorded'}`,
    `- **AI use:** ${ai_use ? ai_use : 'not recorded'}`,
    ...(note ? ['', `**Note:** ${note}`] : []),
    '',
    '## Items for the authors to resolve',
    '',
  ]
  const items = []
  if (summary.missing_order.length) items.push(`Author order not recorded for: ${summary.missing_order.join(', ')}. The tool does not assign an order.`)
  if (summary.missing_credit.length) items.push(`No CRediT roles recorded for: ${summary.missing_credit.join(', ')}.`)
  if (summary.missing_icmje.length) items.push(`No ICMJE criteria recorded for: ${summary.missing_icmje.join(', ')}.`)
  if (summary.incomplete_icmje.length) items.push(`ICMJE criteria left unknown for: ${summary.incomplete_icmje.join(', ')}.`)
  if (!summary.corresponding.length) items.push('No corresponding author is marked.')
  if (summary.corresponding.length > 1) items.push(`Multiple corresponding authors are marked: ${summary.corresponding.join(', ')}. Confirm with the journal.`)
  for (const conflict of summary.conflicts) items.push(`${conflict.kind}: ${conflict.detail}`)
  lines.push(...(items.length ? items.map((item) => `- ${item}`) : ['- Nothing outstanding in the recorded fields.']))
  lines.push('', '> This statement is assembled from recorded human decisions. It does not determine authorship order or qualify any contributor; review it before submission.', '')
  return lines.join('\n')
}

export function exportAuthorship({ cwd, slug, format = 'markdown', funding = null, competing_interests = null, ai_use = null, note = null, overwrite = false }) {
  const summary = authorshipSummary(cwd, slug)
  const kind = String(format || 'markdown').toLowerCase()
  if (!AUTHORSHIP_EXPORT_FORMATS.includes(kind)) {
    throw new Error(`format must be one of ${AUTHORSHIP_EXPORT_FORMATS.join(', ')}`)
  }
  const dir = files(cwd, slug).exports
  ensureDir(dir)
  if (kind === 'markdown') {
    const body = statementMarkdown(summary, { funding, competing_interests, ai_use, note })
    const result = exportText(join(dir, 'authorship.md'), body, { overwrite })
    return { ...result, format: 'markdown', summary }
  }
  if (kind === 'json') {
    const body = `${JSON.stringify({
      record: summary.record,
      authors: summary.authors,
      corresponding: summary.corresponding,
      conflicts: summary.conflicts,
      missing_order: summary.missing_order,
      missing_credit: summary.missing_credit,
      missing_icmje: summary.missing_icmje,
      incomplete_icmje: summary.incomplete_icmje,
      funding: funding || null,
      competing_interests: competing_interests || null,
      ai_use: ai_use || null,
      note: note || null,
      note_text: 'Human-owned record; authorship order and qualification are not inferred.',
    }, null, 2)}\n`
    const result = exportText(join(dir, 'authorship.json'), body, { overwrite })
    return { ...result, format: 'json', summary }
  }
  const header = ['author_id', 'name', 'position', 'affiliation', 'orcid', 'corresponding', 'credit_roles', 'icmje_1', 'icmje_2', 'icmje_3', 'icmje_4', 'notes']
  const rows = summary.authors.map((author) => [
    author.author_id,
    author.name,
    author.position ?? '',
    author.affiliation.join('; '),
    author.orcid || '',
    author.corresponding === true ? 'yes' : author.corresponding === false ? 'no' : '',
    author.credit_roles.join('; '),
    yesNo(author.icmje?.substantial_contributions),
    yesNo(author.icmje?.drafted_or_revised),
    yesNo(author.icmje?.final_approval),
    yesNo(author.icmje?.accountable),
    author.note || '',
  ])
  const safeCell = (value) => {
    const raw = String(value ?? '')
    return /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
  }
  const body = `${[header, ...rows].map((row) => row.map(safeCell).map(csvCell).join(',')).join('\n')}\n`
  const result = exportText(join(dir, 'authorship.csv'), body, { overwrite })
  return { ...result, format: 'csv', summary }
}
