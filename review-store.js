/**
 * Append-only systematic-review ledger under `<cwd>/.dsh/review/<slug>/`.
 *
 * `screening.jsonl` and `evidence.jsonl` are event logs; current state is
 * derived from the latest event per (record, stage). This keeps concurrent
 * subagent writes safe and preserves an audit trail. No database, no server.
 */
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { withLock } from './store-lock.js'
import { canonicalDoi, normalizeTitle } from './search-normalize.js'

export const SCREENING_STAGES = ['title_abstract', 'full_text']
export const SCREENING_DECISIONS = ['include', 'exclude', 'maybe']

const FILES = {
  protocol: 'protocol.json',
  records: 'records.jsonl',
  screening: 'screening.jsonl',
  evidence: 'evidence.jsonl',
  searchLog: 'search_log.jsonl',
}

function nowIso() {
  return new Date().toISOString()
}

function text(value) {
  if (value == null) return ''
  if (Array.isArray(value)) return text(value[0])
  return String(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

export function reviewSlug(value) {
  const slug = text(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  if (!slug) throw new Error('slug must contain at least one letter or digit')
  return slug
}

export function reviewDir(cwd, slug) {
  return join(resolve(cwd), '.dsh', 'review', reviewSlug(slug))
}

function fileOf(cwd, slug, key) {
  return join(reviewDir(cwd, slug), FILES[key])
}

function ensureReview(cwd, slug) {
  const protocol = fileOf(cwd, slug, 'protocol')
  if (!existsSync(protocol)) throw new Error(`review "${reviewSlug(slug)}" has not been started`)
  return reviewDir(cwd, slug)
}

function ensureFiles(dir) {
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'exports'), { recursive: true })
  for (const key of ['records', 'screening', 'evidence', 'searchLog']) {
    const file = join(dir, FILES[key])
    if (!existsSync(file)) writeFileSync(file, '')
  }
}

export function readProtocol(cwd, slug) {
  const file = fileOf(cwd, slug, 'protocol')
  if (!existsSync(file)) throw new Error(`review "${reviewSlug(slug)}" has not been started`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function readJsonl(cwd, slug, key) {
  const file = fileOf(cwd, slug, key)
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split('\n')
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) continue
    try {
      rows.push(JSON.parse(line))
    } catch (error) {
      throw new Error(`${FILES[key]} line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return rows
}

function appendJsonl(file, rows) {
  if (!rows.length) return
  appendFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
}

const withReviewLock = (dir, fn) => withLock(dir, fn, { label: 'review ledger' })

export async function startReview({ cwd, slug, protocol = {}, resume = false }) {
  const dir = reviewDir(cwd, slug)
  ensureFiles(dir)
  const protocolPath = join(dir, FILES.protocol)
  const existed = existsSync(protocolPath)
  if (existed && !resume) {
    throw new Error(`review "${reviewSlug(slug)}" already exists; pass resume: true to continue it`)
  }
  if (!existed) {
    const question = text(protocol.question)
    if (!question) throw new Error('protocol.question is required')
    const stored = {
      slug: reviewSlug(slug),
      question,
      databases: Array.isArray(protocol.databases) ? protocol.databases.map(text).filter(Boolean) : [],
      inclusion: Array.isArray(protocol.inclusion) ? protocol.inclusion.map(text).filter(Boolean) : [],
      exclusion: Array.isArray(protocol.exclusion) ? protocol.exclusion.map(text).filter(Boolean) : [],
      date_range: text(protocol.date_range) || null,
      notes: text(protocol.notes) || null,
      created_at: nowIso(),
    }
    writeFileSync(protocolPath, `${JSON.stringify(stored, null, 2)}\n`)
    return { slug: stored.slug, dir, protocol: stored, resumed: false }
  }
  return { slug: reviewSlug(slug), dir, protocol: JSON.parse(readFileSync(protocolPath, 'utf8')), resumed: true }
}

function authorNames(authors) {
  if (typeof authors === 'string') return [text(authors)].filter(Boolean)
  if (!Array.isArray(authors)) return []
  return authors.map((author) => {
    if (typeof author === 'string') return text(author)
    if (!author || typeof author !== 'object') return ''
    if (author.literal) return text(author.literal)
    if (author.name) return text(author.name)
    if (author.firstName || author.lastName) return text([author.firstName, author.lastName].filter(Boolean).join(' '))
    return text([author.given, author.family].filter(Boolean).join(' '))
  }).filter(Boolean)
}

function yearOf(record) {
  const parts = record.issued?.['date-parts']?.[0]
  if (Array.isArray(parts) && Number.isFinite(Number(parts[0]))) return Number(parts[0])
  const raw = record.year ?? record.publication_year ?? record.date ?? record.published
  const match = String(raw ?? '').match(/(\d{4})/)
  return match ? Number(match[1]) : null
}

function normalizeRecord(record, source) {
  const raw = record?.paper && typeof record.paper === 'object' ? record.paper : record
  if (!raw || typeof raw !== 'object') throw new Error('each record must be an object')
  const doi = canonicalDoi(raw.doi ?? raw.DOI)
  const title = text(raw.title)
  if (!title) throw new Error('each record needs a title')
  const authors = authorNames(raw.authors ?? raw.author ?? raw.creators)
  const year = yearOf(raw)
  const venue = text(raw.venue ?? raw.journal ?? raw['container-title'] ?? raw.publicationTitle) || null
  const pmid = text(raw.pmid ?? raw.PMID) || null
  const arxivId = text(raw.arxiv_id ?? raw.arxivId ?? raw.arXiv) || null
  const sourceId = text(raw.source_id ?? raw.sourceId ?? raw.key) || doi || arxivId || pmid || null
  return {
    source: text(raw.source || source) || null,
    source_id: sourceId,
    doi: doi || null,
    pmid,
    arxiv_id: arxivId,
    title,
    authors,
    year,
    venue,
    url: text(raw.url ?? raw.URL) || null,
    abstract: text(raw.abstract ?? raw.abstractNote).slice(0, 1500) || null,
  }
}

function dedupeKey(record) {
  if (record.doi) return `doi:${record.doi}`
  if (record.pmid) return `pmid:${record.pmid}`
  if (record.arxiv_id) return `arxiv:${record.arxiv_id}`
  return `title:${normalizeTitle(record.title)}|${record.year || ''}`
}

function recordIdNumber(record) {
  const match = String(record.id || '').match(/^r(\d+)$/)
  return match ? Number(match[1]) : 0
}

export async function addRecords({ cwd, slug, records = [], source = 'manual', query = null }) {
  const dir = ensureReview(cwd, slug)
  if (!Array.isArray(records)) throw new Error('records must be an array')
  return withReviewLock(dir, () => {
    const existing = readJsonl(cwd, slug, 'records')
    const seen = new Set(existing.map(dedupeKey))
    let nextId = existing.reduce((max, record) => Math.max(max, recordIdNumber(record)), 0) + 1
    const added = []
    const skipped = []
    for (const input of records) {
      const normalized = normalizeRecord(input, source)
      const key = dedupeKey(normalized)
      if (seen.has(key)) {
        skipped.push({ key, title: normalized.title, reason: 'duplicate' })
        continue
      }
      seen.add(key)
      const row = {
        id: `r${String(nextId).padStart(4, '0')}`,
        ...normalized,
        added_at: nowIso(),
      }
      nextId += 1
      added.push(row)
    }
    appendJsonl(fileOf(cwd, slug, 'records'), added)
    appendJsonl(fileOf(cwd, slug, 'searchLog'), [{
      ts: nowIso(),
      source: text(source) || 'manual',
      query: query == null ? null : text(query),
      received: records.length,
      added: added.length,
      skipped: skipped.length,
    }])
    return {
      added: added.length,
      skipped: skipped.length,
      total: existing.length + added.length,
      ids: added.map((row) => row.id),
      duplicates: skipped,
    }
  })
}

function latestScreening(events) {
  const latest = new Map()
  for (const event of events) latest.set(`${event.record_id}:${event.stage}`, event)
  return latest
}

export async function screenRecord({
  cwd, slug, id, stage, decision, reason = '', reviewer = null, override = false,
}) {
  const dir = ensureReview(cwd, slug)
  const recordId = text(id)
  if (!recordId) throw new Error('id is required')
  if (!SCREENING_STAGES.includes(stage)) throw new Error(`stage must be one of ${SCREENING_STAGES.join(', ')}`)
  if (!SCREENING_DECISIONS.includes(decision)) throw new Error(`decision must be one of ${SCREENING_DECISIONS.join(', ')}`)
  const note = text(reason)
  if ((decision === 'exclude' || decision === 'maybe') && !note) {
    throw new Error(`a reason is required for decision "${decision}"`)
  }
  return withReviewLock(dir, () => {
    const records = readJsonl(cwd, slug, 'records')
    if (!records.some((record) => record.id === recordId)) throw new Error(`record ${recordId} not found`)
    const events = readJsonl(cwd, slug, 'screening')
    const latest = latestScreening(events)
    const previous = latest.get(`${recordId}:${stage}`)
    if (previous && !override) {
      throw new Error(`record ${recordId} already has a ${stage} decision; pass override: true to replace it`)
    }
    if (stage === 'full_text') {
      const titleDecision = latest.get(`${recordId}:title_abstract`)
      if (!titleDecision || titleDecision.decision !== 'include') {
        throw new Error(`record ${recordId} needs a title_abstract include before full_text screening`)
      }
    }
    const event = {
      ts: nowIso(),
      record_id: recordId,
      stage,
      decision,
      reason: note || null,
      reviewer: text(reviewer) || null,
      override: Boolean(override),
    }
    appendJsonl(fileOf(cwd, slug, 'screening'), [event])
    return { ...event, previous: previous || null }
  })
}

export async function addEvidence({
  cwd, slug, id, claim, quote, location, page = null, section = null,
}) {
  const dir = ensureReview(cwd, slug)
  const recordId = text(id)
  if (!recordId) throw new Error('id is required')
  const claimText = text(claim)
  const quoteText = String(quote ?? '').trim()
  const locationText = text(location)
  if (!claimText) throw new Error('claim is required')
  if (!quoteText) throw new Error('quote is required')
  if (!locationText) throw new Error('location is required')
  return withReviewLock(dir, () => {
    const records = readJsonl(cwd, slug, 'records')
    if (!records.some((record) => record.id === recordId)) throw new Error(`record ${recordId} not found`)
    const latest = latestScreening(readJsonl(cwd, slug, 'screening'))
    const decision = latest.get(`${recordId}:full_text`)
    if (!decision || decision.decision !== 'include') {
      throw new Error(`record ${recordId} must be a full_text include before evidence can be added`)
    }
    const existing = readJsonl(cwd, slug, 'evidence')
    const event = {
      evidence_id: `e${String(existing.length + 1).padStart(4, '0')}`,
      ts: nowIso(),
      record_id: recordId,
      claim: claimText,
      quote: quoteText,
      location: locationText,
      page: page == null ? null : text(page) || null,
      section: section == null ? null : text(section) || null,
    }
    appendJsonl(fileOf(cwd, slug, 'evidence'), [event])
    return event
  })
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1)
}

export function deriveStatus(cwd, slug) {
  const protocol = readProtocol(cwd, slug)
  const records = readJsonl(cwd, slug, 'records')
  const screening = readJsonl(cwd, slug, 'screening')
  const evidence = readJsonl(cwd, slug, 'evidence')
  const searchLog = readJsonl(cwd, slug, 'searchLog')
  const latest = latestScreening(screening)

  const title = { include: 0, exclude: 0, maybe: 0, pending: 0 }
  const full = { include: 0, exclude: 0, maybe: 0, pending: 0, not_eligible: 0 }
  const reasons = new Map()
  const included = []
  const evidenceByRecord = new Map()

  for (const event of evidence) bump(evidenceByRecord, event.record_id)

  for (const record of records) {
    const titleEvent = latest.get(`${record.id}:title_abstract`)
    if (!titleEvent) title.pending += 1
    else {
      title[titleEvent.decision] += 1
      if (titleEvent.decision !== 'include') {
        const reason = titleEvent.reason || '(no reason)'
        bump(reasons, `title_abstract:${reason}`)
      }
    }

    if (titleEvent?.decision === 'include') {
      const fullEvent = latest.get(`${record.id}:full_text`)
      if (!fullEvent) full.pending += 1
      else {
        full[fullEvent.decision] += 1
        if (fullEvent.decision === 'include') included.push(record.id)
        else {
          const reason = fullEvent.reason || '(no reason)'
          bump(reasons, `full_text:${reason}`)
        }
      }
    } else {
      full.not_eligible += 1
    }
  }

  const includedWithoutEvidence = included.filter((id) => !evidenceByRecord.get(id))
  const lastEventAt = [protocol.created_at, ...screening.map((event) => event.ts), ...evidence.map((event) => event.ts)]
    .filter(Boolean)
    .sort()
    .at(-1) || null

  return {
    slug: reviewSlug(slug),
    question: protocol.question,
    created_at: protocol.created_at,
    records_total: records.length,
    search: {
      queries: searchLog.length,
      added: searchLog.reduce((sum, row) => sum + (Number(row.added) || 0), 0),
      skipped: searchLog.reduce((sum, row) => sum + (Number(row.skipped) || 0), 0),
    },
    screening: { title_abstract: title, full_text: full },
    evidence: {
      rows: evidence.length,
      records_with_evidence: [...evidenceByRecord.keys()].filter((id) => included.includes(id)).length,
      included_without_evidence: includedWithoutEvidence,
    },
    included,
    exclusion_reasons: [...reasons.entries()].map(([key, count]) => {
      const [stage, ...rest] = key.split(':')
      return { stage, reason: rest.join(':'), count }
    }).sort((a, b) => b.count - a.count),
    last_event_at: lastEventAt,
  }
}

function csvCell(value) {
  const raw = String(value ?? '')
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw
}

function mdCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
}

function markdownReport(protocol, status, records, evidence) {
  const byId = new Map(records.map((record) => [record.id, record]))
  const lines = [
    `# Systematic review: ${protocol.slug}`,
    '',
    `**Question:** ${protocol.question}`,
    '',
    '## Protocol',
    '',
    `- Databases: ${protocol.databases?.length ? protocol.databases.join(', ') : '(none recorded)'}`,
    `- Date range: ${protocol.date_range || '(not set)'}`,
    `- Inclusion: ${protocol.inclusion?.length ? protocol.inclusion.join('; ') : '(none recorded)'}`,
    `- Exclusion: ${protocol.exclusion?.length ? protocol.exclusion.join('; ') : '(none recorded)'}`,
  ]
  if (protocol.notes) lines.push(`- Notes: ${protocol.notes}`)
  lines.push(
    '',
    '## PRISMA-style counts',
    '',
    '| Stage | Include | Exclude | Maybe | Pending |',
    '|---|---:|---:|---:|---:|',
    `| Title/abstract | ${status.screening.title_abstract.include} | ${status.screening.title_abstract.exclude} | ${status.screening.title_abstract.maybe} | ${status.screening.title_abstract.pending} |`,
    `| Full text | ${status.screening.full_text.include} | ${status.screening.full_text.exclude} | ${status.screening.full_text.maybe} | ${status.screening.full_text.pending} |`,
    '',
    `Records: ${status.records_total}. Search queries: ${status.search.queries}; added: ${status.search.added}; duplicates skipped: ${status.search.skipped}.`,
  )
  if (status.exclusion_reasons.length) {
    lines.push('', '## Exclusion reasons', '')
    for (const row of status.exclusion_reasons) lines.push(`- ${row.stage}: ${row.reason} (${row.count})`)
  }
  lines.push('', '## Included records', '')
  if (status.included.length) {
    for (const id of status.included) {
      const record = byId.get(id)
      const doi = record?.doi ? ` — https://doi.org/${record.doi}` : ''
      lines.push(`- ${id}: ${record?.title || '(missing title)'}${doi}`)
    }
  } else lines.push('_No full-text includes yet._')
  lines.push('', '## Evidence', '')
  if (evidence.length) {
    lines.push('| Record | Claim | Quote | Location |', '|---|---|---|---|')
    for (const row of evidence) {
      lines.push(`| ${mdCell(row.record_id)} | ${mdCell(row.claim)} | ${mdCell(row.quote)} | ${mdCell(row.location)} |`)
    }
  } else lines.push('_No evidence rows yet._')
  lines.push('', '## Review checklist', '', '- [ ] Confirm every included record has a full-text decision', '- [ ] Confirm every include has at least one evidence row', '- [ ] Verify quotes against the stored paper text', '- [ ] Resolve remaining maybe/pending records', '')
  return lines.join('\n')
}

function evidenceCsv(status, records, evidence) {
  const byId = new Map(records.map((record) => [record.id, record]))
  const lines = ['record_id,title,doi,claim,quote,location,page,section']
  for (const row of evidence) {
    const record = byId.get(row.record_id)
    lines.push([
      row.record_id,
      record?.title || '',
      record?.doi || '',
      row.claim,
      row.quote,
      row.location,
      row.page || '',
      row.section || '',
    ].map(csvCell).join(','))
  }
  return `${lines.join('\n')}\n`
}

export function exportReview({ cwd, slug, format = 'markdown', overwrite = false }) {
  const dir = ensureReview(cwd, slug)
  mkdirSync(join(dir, 'exports'), { recursive: true })
  const protocol = readProtocol(cwd, slug)
  const status = deriveStatus(cwd, slug)
  const records = readJsonl(cwd, slug, 'records')
  const evidence = readJsonl(cwd, slug, 'evidence')
  const kind = text(format).toLowerCase()
  let name
  let body
  if (kind === 'markdown' || kind === 'md') {
    name = 'review.md'
    body = markdownReport(protocol, status, records, evidence)
  } else if (kind === 'csv') {
    name = 'evidence.csv'
    body = evidenceCsv(status, records, evidence)
  } else if (kind === 'json') {
    name = 'review.json'
    body = `${JSON.stringify({ protocol, status, records, screening: readJsonl(cwd, slug, 'screening'), evidence }, null, 2)}\n`
  } else {
    throw new Error('format must be markdown, csv, or json')
  }
  const out = join(dir, 'exports', name)
  if (existsSync(out) && !overwrite) {
    throw new Error(`${relative(resolve(cwd), out)} already exists; pass overwrite: true to replace it`)
  }
  writeFileSync(out, body)
  return { format: kind, path: relative(resolve(cwd), out), bytes: Buffer.byteLength(body) }
}
