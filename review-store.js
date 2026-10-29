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
import { withLock, writeJsonAtomic } from './store-lock.js'
import { canonicalDoi, normalizeTitle } from './search-normalize.js'
import {
  normalizeReviewer, resolveSeries, reviewerKey, reviewerLabel, reviewerType,
} from './agreement.js'
import {
  buildRobSummary, buildRobTable, evaluateInstrument, fingerprint, instrumentKey,
  normaliseJudgement, resolveInstrument, validateSignalling,
} from './appraisal.js'

export const SCREENING_STAGES = ['title_abstract', 'full_text']
export const SCREENING_DECISIONS = ['include', 'exclude', 'maybe']

const FILES = {
  protocol: 'protocol.json',
  records: 'records.jsonl',
  screening: 'screening.jsonl',
  evidence: 'evidence.jsonl',
  appraisal: 'appraisal.jsonl',
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
  for (const key of ['records', 'screening', 'evidence', 'appraisal', 'searchLog']) {
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

function reviewerList(value) {
  if (value == null) return null
  if (!Array.isArray(value)) throw new Error('reviewers must be an array of names')
  const seen = new Set()
  const out = []
  for (const entry of value) {
    const normalized = normalizeReviewer(entry)
    if (!normalized) throw new Error('reviewer names cannot be empty or "default"')
    const key = reviewerKey(normalized)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out.length ? out : null
}

export async function startReview({
  cwd, slug, protocol = {}, reviewers = null, instruments = null, resume = false,
}) {
  const dir = reviewDir(cwd, slug)
  ensureFiles(dir)
  const protocolPath = join(dir, FILES.protocol)
  const existed = existsSync(protocolPath)
  if (existed && !resume) {
    throw new Error(`review "${reviewSlug(slug)}" already exists; pass resume: true to continue it`)
  }
  if (instruments != null && !Array.isArray(instruments)) {
    throw new Error('instruments must be an array of instrument ids')
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
    const declared = reviewerList(reviewers)
    if (declared) stored.reviewers = declared
    let declaredInstruments = []
    if (instruments != null) {
      const seen = new Set()
      declaredInstruments = instruments
        .map((reference) => resolveInstrument(reference))
        .filter((template) => {
          if (seen.has(template.id)) return false
          seen.add(template.id)
          return true
        })
      if (declaredInstruments.length) {
        stored.instruments = declaredInstruments.map((template) => ({
          id: template.id,
          version: String(template.version),
        }))
      }
    }
    writeJsonAtomic(protocolPath, stored)
    for (const template of declaredInstruments) freezeInstrument(cwd, slug, template, { declaredAtStart: true })
    return { slug: stored.slug, dir, protocol: stored, resumed: false }
  }
  const stored = JSON.parse(readFileSync(protocolPath, 'utf8'))
  if (reviewers != null) {
    const declared = reviewerList(reviewers) || []
    const current = Array.isArray(stored.reviewers) ? stored.reviewers : []
    const same = declared.length === current.length
      && declared.every((name, index) => reviewerKey(name) === reviewerKey(current[index]))
    if (!same) {
      if (current.length) throw new Error('reviewers cannot be changed after the review starts')
      const screening = readJsonl(cwd, slug, 'screening')
      if (screening.some((event) => event.kind === 'screen' || event.kind === 'reconcile')) {
        throw new Error('reviewers cannot be added after reviewer-keyed screening has started')
      }
      if (declared.length) {
        stored.reviewers = declared
        writeJsonAtomic(protocolPath, stored)
      }
    }
  }
  if (instruments != null) {
    const requested = instruments.map((reference) => {
      const template = resolveInstrument(reference)
      return `${template.id}@${template.version}`
    })
    const current = (Array.isArray(stored.instruments) ? stored.instruments : [])
      .map((entry) => `${entry.id}@${entry.version}`)
    const same = requested.length === current.length
      && requested.every((reference, index) => reference === current[index])
    if (!same) throw new Error('instruments cannot be changed after the review starts')
  }
  return { slug: reviewSlug(slug), dir, protocol: stored, resumed: true }
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

function latestScreening(events, { reviewerKeyed = true } = {}) {
  const latest = new Map()
  events.forEach((event, index) => {
    if (event.kind === 'reconcile') return
    const key = reviewerKeyed
      ? `${event.record_id}:${event.stage}:${reviewerKey(event.reviewer)}`
      : `${event.record_id}:${event.stage}`
    latest.set(key, { event, index })
  })
  return latest
}

function screeningIsReviewerKeyed(protocol, events) {
  if (Array.isArray(protocol.reviewers) && protocol.reviewers.length > 0) return true
  return events.some((event) => event.kind === 'screen' || event.kind === 'reconcile')
}

function expectedScreeningReviewers(protocol) {
  const declared = Array.isArray(protocol.reviewers) ? protocol.reviewers : []
  return declared.length >= 2 ? declared : null
}

export function screeningResolutions(cwd, slug) {
  const protocol = readProtocol(cwd, slug)
  const records = readJsonl(cwd, slug, 'records')
  const events = readJsonl(cwd, slug, 'screening')
  const reviewerKeyed = screeningIsReviewerKeyed(protocol, events)
  const expected = reviewerKeyed ? expectedScreeningReviewers(protocol) : null
  const grouped = new Map()
  for (const event of events) {
    const key = `${event.record_id}:${event.stage}`
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(event)
  }
  const options = { expectedReviewers: expected }
  if (!reviewerKeyed) options.reviewerOf = () => 'default'
  options.valueOf = (event) => event.decision
  const resolutions = new Map()
  for (const record of records) {
    resolutions.set(record.id, {
      title: resolveSeries(grouped.get(`${record.id}:title_abstract`) || [], options),
      full: resolveSeries(grouped.get(`${record.id}:full_text`) || [], options),
    })
  }
  return {
    protocol, records, events, resolutions, expected, reviewerKeyed,
  }
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
  const protocol = readProtocol(cwd, slug)
  const roster = Array.isArray(protocol.reviewers) ? protocol.reviewers : []
  const reviewerName = normalizeReviewer(reviewer)
  if (roster.length) {
    if (!reviewerName) throw new Error(`reviewer is required; declared reviewers: ${roster.join(', ')}`)
    const key = reviewerKey(reviewerName)
    if (!roster.some((entry) => reviewerKey(entry) === key)) {
      throw new Error(`reviewer ${reviewerName} is not in the declared list (${roster.join(', ')})`)
    }
  }
  const key = reviewerKey(reviewerName)
  return withReviewLock(dir, () => {
    const records = readJsonl(cwd, slug, 'records')
    if (!records.some((record) => record.id === recordId)) throw new Error(`record ${recordId} not found`)
    const events = readJsonl(cwd, slug, 'screening')
    const reviewerKeyed = screeningIsReviewerKeyed(protocol, events)
    if (reviewerKeyed && !reviewerName
      && events.some((event) => event.kind !== 'reconcile' && reviewerKey(event.reviewer) !== 'default')) {
      throw new Error('reviewer is required: this review already uses named reviewers; pass the same reviewer identity')
    }
    const latest = latestScreening(events, { reviewerKeyed })
    const suffix = reviewerKeyed ? `:${key}` : ''
    const previous = latest.get(`${recordId}:${stage}${suffix}`)?.event
    if (previous && !override) {
      throw new Error(`record ${recordId} already has a ${stage} decision; pass override: true to replace it`)
    }
    const multi = reviewerKeyed && (roster.length >= 2 || new Set(
      events.filter((event) => event.kind !== 'reconcile').map((event) => reviewerKey(event.reviewer)),
    ).size > 1)
    if (previous && override && multi && !note) {
      throw new Error('overriding a decision in a multi-reviewer review requires a reason')
    }
    if (stage === 'full_text') {
      const titleDecision = latest.get(`${recordId}:title_abstract${suffix}`)?.event
      if (!titleDecision || titleDecision.decision !== 'include') {
        throw new Error(`record ${recordId} needs a title_abstract include before full_text screening`)
      }
    }
    const event = {
      event_id: `s${String(events.length + 1).padStart(4, '0')}`,
      kind: 'screen',
      ts: nowIso(),
      record_id: recordId,
      stage,
      decision,
      reason: note || null,
      reviewer: reviewerName,
      override: Boolean(override),
      supersedes: previous?.event_id ?? null,
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
    const { resolutions } = screeningResolutions(cwd, slug)
    const recordResolution = resolutions.get(recordId)
    const titleResolution = recordResolution?.title
    if (titleResolution?.state === 'conflict' || titleResolution?.state === 'reopened') {
      throw new Error(`record ${recordId} has a title_abstract disagreement; reconcile it before adding evidence`)
    }
    if (!titleResolution || titleResolution.value !== 'include') {
      throw new Error(`record ${recordId} must be a full_text include before evidence can be added`)
    }
    const resolution = recordResolution?.full
    if (resolution?.state === 'conflict' || resolution?.state === 'reopened') {
      throw new Error(`record ${recordId} has a full_text disagreement; reconcile it to a full_text include before adding evidence`)
    }
    if (!resolution || resolution.value !== 'include') {
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

/* --------------------------------------------------------------- appraisal */

function instrumentsFile(cwd, slug) {
  return join(reviewDir(cwd, slug), 'instruments.json')
}

export function readInstruments(cwd, slug) {
  const file = instrumentsFile(cwd, slug)
  if (!existsSync(file)) return { instruments: [] }
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`instruments.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function freezeInstrument(cwd, slug, template, { declaredAtStart = false } = {}) {
  const registry = readInstruments(cwd, slug)
  const existing = registry.instruments.find((entry) => entry.id === template.id)
  if (existing) {
    if (String(existing.version) !== String(template.version)) {
      throw new Error(`instrument ${template.id}@${existing.version} is already frozen for this review; start a new review for @${template.version}`)
    }
    return existing
  }
  const entry = {
    id: template.id,
    version: String(template.version),
    name: template.name,
    source_url: template.source_url,
    fingerprint: fingerprint(template),
    frozen_at: nowIso(),
    declared_at_start: Boolean(declaredAtStart),
    definition: template,
  }
  registry.instruments.push(entry)
  mkdirSync(reviewDir(cwd, slug), { recursive: true })
  writeJsonAtomic(instrumentsFile(cwd, slug), registry)
  return entry
}

export function frozenInstrument(cwd, slug, reference = null, version = null) {
  const registry = readInstruments(cwd, slug)
  if (!registry.instruments.length) {
    throw new Error('no appraisal instrument is frozen for this review; appraise a record or start the review with instruments: [...]')
  }
  if (reference == null) {
    if (registry.instruments.length === 1) return registry.instruments[0].definition
    throw new Error(`instrument is required; frozen instruments: ${registry.instruments.map((entry) => `${entry.id}@${entry.version}`).join(', ')}`)
  }
  const parsed = instrumentKey(reference, version)
  let matches = registry.instruments.filter((entry) => entry.id === parsed.id
    && (parsed.version == null || String(entry.version) === String(parsed.version)))
  if (!matches.length) {
    try {
      const bundled = resolveInstrument(reference, version)
      matches = registry.instruments.filter((entry) => entry.id === bundled.id
        && String(entry.version) === String(bundled.version))
    } catch {
      // not a bundled reference; report the frozen list below
    }
  }
  if (matches.length > 1) {
    throw new Error(`instrument ${parsed.id} has more than one frozen version; pass version`)
  }
  if (matches.length === 1) return matches[0].definition
  throw new Error(`instrument "${reference}" has not been frozen for this review; frozen: ${registry.instruments.map((entry) => `${entry.id}@${entry.version}`).join(', ')}`)
}

function authoritativeInstrument(cwd, slug, reference, version = null) {
  const bundled = resolveInstrument(reference, version)
  const registry = readInstruments(cwd, slug)
  const existing = registry.instruments.find((entry) => entry.id === bundled.id)
  if (existing) {
    if (String(existing.version) !== String(bundled.version)) {
      throw new Error(`instrument ${bundled.id}@${existing.version} is already frozen for this review; start a new review for @${bundled.version}`)
    }
    return { template: existing.definition, bundled }
  }
  return { template: bundled, bundled }
}

function instrumentDomain(template, domainId) {
  if (domainId === 'overall') {
    if (!template.overall) {
      throw new Error(`${template.name} has no explicit overall judgement; omit domain to use the derived one`)
    }
    return template.overall
  }
  const domain = template.domains.find((entry) => entry.id === domainId)
  if (!domain) {
    const ids = [...template.domains.map((entry) => entry.id), ...(template.overall ? ['overall'] : [])]
    throw new Error(`domain "${domainId}" is not in ${template.name}; domains: ${ids.join(', ')}`)
  }
  return domain
}

function instrumentAxis(domain, axis) {
  const axes = Array.isArray(domain.axes) && domain.axes.length ? domain.axes : ['risk_of_bias']
  const wanted = axis || 'risk_of_bias'
  if (!axes.includes(wanted)) throw new Error(`axis must be one of ${axes.join(', ')}`)
  return wanted
}

function judgementNeedsQuote(template, judgement) {
  if (template.scale.type !== 'ordinal') return false
  return Boolean(template.scale.values.find((value) => value.id === judgement)?.requires_quote)
}

function requireIncludedRecord(cwd, slug, recordId) {
  const { resolutions } = screeningResolutions(cwd, slug)
  const recordResolution = resolutions.get(recordId)
  const titleResolution = recordResolution?.title
  if (titleResolution?.state === 'conflict' || titleResolution?.state === 'reopened') {
    throw new Error(`record ${recordId} has a title_abstract disagreement; reconcile it before appraising`)
  }
  if (!titleResolution || titleResolution.value !== 'include') {
    throw new Error(`record ${recordId} must be a full_text include before it can be appraised`)
  }
  const fullResolution = recordResolution?.full
  if (fullResolution?.state === 'conflict' || fullResolution?.state === 'reopened') {
    throw new Error(`record ${recordId} has a full_text disagreement; reconcile it before appraising`)
  }
  if (!fullResolution || fullResolution.value !== 'include') {
    throw new Error(`record ${recordId} must be a full_text include before it can be appraised`)
  }
}

export async function appraiseRecord({
  cwd, slug, id, instrument, version = null, domain, axis = null, judgement,
  signalling = null, quote = null, location = null, page = null, section = null,
  reason = null, reviewer = null, override = false, paper = null, quoteCheck = null,
}) {
  const dir = ensureReview(cwd, slug)
  const recordId = text(id)
  if (!recordId) throw new Error('id is required')
  const protocol = readProtocol(cwd, slug)
  const reviewerName = normalizeReviewer(reviewer)
  if (!reviewerName) throw new Error('reviewer is required for an appraisal')
  const roster = Array.isArray(protocol.reviewers) ? protocol.reviewers : []
  if (roster.length && !roster.some((entry) => reviewerKey(entry) === reviewerKey(reviewerName))) {
    throw new Error(`reviewer ${reviewerName} is not in the declared list (${roster.join(', ')})`)
  }
  const { template, bundled } = authoritativeInstrument(cwd, slug, instrument, version)
  const domainId = text(domain)
  if (!domainId) throw new Error('domain is required')
  const domainDef = instrumentDomain(template, domainId)
  const isOverall = domainId === 'overall'
  const axisId = isOverall ? null : instrumentAxis(domainDef, axis)
  const judgementId = normaliseJudgement(template, domainDef, judgement)
  const quoteText = String(quote ?? '').trim()
  const locationText = text(location)
  if (!isOverall && judgementNeedsQuote(template, judgementId) && quoteText.length < 8) {
    throw new Error(`a verbatim quote of at least 8 characters is required for judgement "${judgementId}"`)
  }
  if (quoteText && !locationText) throw new Error('location is required when a quote is supplied')
  if (isOverall && signalling != null) throw new Error('signalling answers do not apply to the overall judgement')
  if (isOverall && !text(reason)) throw new Error('an explicit overall judgement requires a reason')
  const signallingAnswers = isOverall ? null : validateSignalling(template, domainDef, signalling)

  return withReviewLock(dir, () => {
    requireIncludedRecord(cwd, slug, recordId)
    freezeInstrument(cwd, slug, bundled)
    const records = readJsonl(cwd, slug, 'records')
    if (!records.some((record) => record.id === recordId)) throw new Error(`record ${recordId} not found`)
    const events = readJsonl(cwd, slug, 'appraisal')
    const previous = [...events].reverse().find((event) => event.kind !== 'reconcile'
      && event.record_id === recordId
      && event.instrument?.id === template.id
      && String(event.instrument?.version) === String(template.version)
      && event.domain === domainId
      && (isOverall || (event.axis || 'risk_of_bias') === axisId)
      && reviewerKey(event.reviewer) === reviewerKey(reviewerName))
    if (previous && !override) {
      throw new Error(`record ${recordId} already has a ${domainId} appraisal by ${reviewerName}; pass override: true with a reason`)
    }
    if (previous && override && !text(reason)) throw new Error('overriding an appraisal requires a reason')
    const check = quoteText
      ? (quoteCheck || { status: 'unverified', via: null, detail: 'no PaperMemory paper supplied' })
      : null
    const idText = `a${String(events.length + 1).padStart(4, '0')}`
    const event = {
      appraisal_id: idText,
      event_id: idText,
      kind: 'appraise',
      ts: nowIso(),
      record_id: recordId,
      instrument: { id: template.id, version: String(template.version) },
      domain: domainId,
      axis: axisId,
      judgement: judgementId,
      signalling: signallingAnswers,
      quote: quoteText || null,
      location: locationText || null,
      page: page == null ? null : text(page) || null,
      section: section == null ? null : text(section) || null,
      reason: text(reason) || null,
      reviewer: reviewerName,
      override: Boolean(override),
      supersedes: previous?.appraisal_id ?? null,
      derived: false,
      quote_check: check,
      paper: text(paper) || null,
    }
    appendJsonl(fileOf(cwd, slug, 'appraisal'), [event])
    return { ...event, previous: previous || null }
  })
}

function reconcileBasis(resolution, reviewerName) {
  const entries = resolution.conflict?.by_reviewer || []
  return entries.some((entry) => entry.reviewer_key === reviewerKey(reviewerName)) ? 'consensus' : 'third_reviewer'
}

function reconciliationSupersedes(resolution) {
  return (resolution.conflict?.by_reviewer || []).map((entry) => entry.event_id).filter(Boolean)
}

export async function reconcileRecord({
  cwd, slug, scope, id, stage = null, decision = null, instrument = null, version = null,
  domain = null, axis = null, judgement = null, reason = null, reviewer = null,
}) {
  const dir = ensureReview(cwd, slug)
  const scopeId = text(scope)
  if (!['screening', 'appraisal'].includes(scopeId)) throw new Error('scope must be screening or appraisal')
  const recordId = text(id)
  if (!recordId) throw new Error('id is required')
  const reasonText = text(reason)
  if (!reasonText) throw new Error('reconcile requires a reason')
  const reviewerName = normalizeReviewer(reviewer)
  if (!reviewerName) throw new Error('reviewer is required for reconcile')
  const protocol = readProtocol(cwd, slug)
  const records = readJsonl(cwd, slug, 'records')
  if (!records.some((record) => record.id === recordId)) throw new Error(`record ${recordId} not found`)

  if (scopeId === 'screening') {
    if (!SCREENING_STAGES.includes(stage)) throw new Error(`stage must be one of ${SCREENING_STAGES.join(', ')}`)
    if (!SCREENING_DECISIONS.includes(decision)) throw new Error(`decision must be one of ${SCREENING_DECISIONS.join(', ')}`)
    return withReviewLock(dir, () => {
      const { resolutions } = screeningResolutions(cwd, slug)
      const recordResolution = resolutions.get(recordId)
      if (stage === 'full_text' && recordResolution?.title?.value !== 'include') {
        throw new Error(`record ${recordId} needs a resolved title_abstract include before reconciling full_text`)
      }
      const resolution = stage === 'title_abstract' ? recordResolution?.title : recordResolution?.full
      if (!resolution || !['conflict', 'reopened'].includes(resolution.state)) {
        throw new Error(`record ${recordId} has no ${stage} disagreement to reconcile`)
      }
      const events = readJsonl(cwd, slug, 'screening')
      const event = {
        event_id: `s${String(events.length + 1).padStart(4, '0')}`,
        kind: 'reconcile',
        ts: nowIso(),
        record_id: recordId,
        stage,
        decision,
        reason: reasonText,
        reviewer: reviewerName,
        basis: reconcileBasis(resolution, reviewerName),
        supersedes: reconciliationSupersedes(resolution),
      }
      appendJsonl(fileOf(cwd, slug, 'screening'), [event])
      const after = screeningResolutions(cwd, slug).resolutions.get(recordId)
      return {
        scope: scopeId,
        event,
        resolution: stage === 'title_abstract' ? after?.title : after?.full,
      }
    })
  }

  const template = frozenInstrument(cwd, slug, instrument, version)
  const domainId = text(domain)
  if (!domainId) throw new Error('domain is required for an appraisal reconcile')
  const domainDef = instrumentDomain(template, domainId)
  const isOverall = domainId === 'overall'
  const axisId = isOverall ? null : instrumentAxis(domainDef, axis)
  const judgementId = normaliseJudgement(template, domainDef, judgement)

  return withReviewLock(dir, () => {
    requireIncludedRecord(cwd, slug, recordId)
    const events = readJsonl(cwd, slug, 'appraisal')
    const expectedReviewers = Array.isArray(protocol.reviewers) ? protocol.reviewers : []
    const evaluation = evaluateInstrument({
      template, records, events, includedIds: [recordId], onlyRecordId: recordId, expectedReviewers,
    })
    const row = evaluation.records[0]
    if (!row) throw new Error(`record ${recordId} is not in the appraisal population`)
    const resolution = isOverall ? row.overall : row.cells.find((cell) => cell.key === `${domainId}:${axisId}`)?.resolution
    if (!resolution || !['conflict', 'reopened'].includes(resolution.state)) {
      throw new Error(`record ${recordId} has no ${domainId} appraisal disagreement to reconcile`)
    }
    const idText = `a${String(events.length + 1).padStart(4, '0')}`
    const event = {
      appraisal_id: idText,
      event_id: idText,
      kind: 'reconcile',
      ts: nowIso(),
      record_id: recordId,
      instrument: { id: template.id, version: String(template.version) },
      domain: domainId,
      axis: axisId,
      judgement: judgementId,
      reason: reasonText,
      reviewer: reviewerName,
      basis: reconcileBasis(resolution, reviewerName),
      supersedes: reconciliationSupersedes(resolution),
    }
    appendJsonl(fileOf(cwd, slug, 'appraisal'), [event])
    const after = evaluateInstrument({
      template,
      records,
      events: [...events, event],
      includedIds: [recordId],
      onlyRecordId: recordId,
      expectedReviewers,
    }).records[0]
    return {
      scope: scopeId,
      event,
      resolution: isOverall ? after?.overall : after?.cells.find((cell) => cell.key === `${domainId}:${axisId}`)?.resolution,
    }
  })
}

export function deriveAppraisalStatus(cwd, slug, { id = null, instrument = null, version = null } = {}) {
  const protocol = readProtocol(cwd, slug)
  const expectedReviewers = Array.isArray(protocol.reviewers) ? protocol.reviewers : []
  const records = readJsonl(cwd, slug, 'records')
  const { resolutions } = screeningResolutions(cwd, slug)
  const includedIds = records.map((record) => record.id)
    .filter((recordId) => resolutions.get(recordId)?.full?.value === 'include')
  const events = readJsonl(cwd, slug, 'appraisal')
  const registry = readInstruments(cwd, slug)
  let entries = registry.instruments
  if (instrument != null) {
    const template = frozenInstrument(cwd, slug, instrument, version)
    entries = entries.filter((entry) => entry.id === template.id)
  }
  const onlyRecordId = id == null ? null : text(id)
  const statuses = entries.map((entry) => {
    const evaluation = evaluateInstrument({
      template: entry.definition, records, events, includedIds, onlyRecordId, expectedReviewers,
    })
    const missing = []
    for (const row of evaluation.records) {
      for (const cell of row.cells) {
        if (cell.resolution.value != null) continue
        if (cell.resolution.state === 'conflict' || cell.resolution.state === 'reopened') continue
        missing.push({
          record_id: row.record_id,
          cell: cell.key,
          missing_reviewers: cell.resolution.missing_reviewers,
        })
      }
      const allCellsResolved = row.cells.every((cell) => cell.resolution.value != null)
      if (allCellsResolved && row.overall && row.overall.value == null
        && row.overall.state !== 'conflict' && row.overall.state !== 'reopened') {
        missing.push({ record_id: row.record_id, cell: 'overall', missing_reviewers: [] })
      }
    }
    return {
      id: entry.id,
      version: entry.version,
      name: entry.name,
      source_url: entry.source_url,
      population: evaluation.population.length,
      reviewers: evaluation.reviewers,
      complete_records: evaluation.complete_records,
      records: evaluation.records.map((row) => ({
        record_id: row.record_id,
        title: row.record?.title || null,
        status: row.status,
        total_stars: row.total_stars,
        overall: row.overall ? {
          state: row.overall.state,
          value: row.overall.value,
          derived: row.overall.derived,
          by_reviewer: row.overall.by_reviewer,
          reconcile: row.overall.reconcile,
        } : null,
        cells: row.cells.map((cell) => ({
          key: cell.key,
          domain: cell.domain.id,
          axis: cell.axis,
          state: cell.resolution.state,
          value: cell.resolution.value,
          missing_reviewers: cell.resolution.missing_reviewers,
          by_reviewer: cell.resolution.by_reviewer,
          reconcile: cell.resolution.reconcile,
        })),
      })),
      outstanding: { conflicts: evaluation.conflicts, missing },
    }
  })
  const outside = [...new Set(events.filter((event) => event.kind !== 'reconcile').map((event) => event.record_id))]
    .filter((recordId) => !includedIds.includes(recordId))
  const population = onlyRecordId
    ? includedIds.filter((recordId) => recordId === onlyRecordId).length
    : includedIds.length
  return {
    population,
    instruments: statuses,
    appraisals_outside_population: outside,
    ...(entries.length ? {} : { note: 'No appraisal instrument is frozen for this review yet.' }),
  }
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1)
}

function reviewerSummaries({ records, screening, expected, appraisalCounts }) {
  const latest = latestScreening(screening)
  const keys = new Map()
  const add = (reviewer) => {
    const key = reviewerKey(reviewer)
    if (!keys.has(key)) keys.set(key, { reviewer: reviewerLabel(reviewer), type: reviewerType(reviewer) })
  }
  for (const reviewer of expected || []) add(reviewer)
  for (const event of screening) if (event.kind !== 'reconcile') add(event.reviewer)

  return [...keys.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, info]) => {
    const title = { include: 0, exclude: 0, maybe: 0, pending: 0 }
    const full = { include: 0, exclude: 0, maybe: 0, pending: 0, not_eligible: 0 }
    for (const record of records) {
      const titleEvent = latest.get(`${record.id}:title_abstract:${key}`)?.event
      if (!titleEvent) {
        title.pending += 1
        full.not_eligible += 1
        continue
      }
      title[titleEvent.decision] += 1
      if (titleEvent.decision !== 'include') {
        full.not_eligible += 1
        continue
      }
      const fullEvent = latest.get(`${record.id}:full_text:${key}`)?.event
      if (fullEvent) full[fullEvent.decision] += 1
      else full.pending += 1
    }
    return {
      reviewer: info.reviewer,
      type: info.type,
      title_abstract: title,
      full_text: full,
      appraisals: appraisalCounts.get(key) || 0,
    }
  })
}

export function deriveStatus(cwd, slug) {
  const {
    protocol, records, events: screening, resolutions, expected, reviewerKeyed,
  } = screeningResolutions(cwd, slug)
  const evidence = readJsonl(cwd, slug, 'evidence')
  const appraisalEvents = readJsonl(cwd, slug, 'appraisal')
  const searchLog = readJsonl(cwd, slug, 'searchLog')
  const activeReviewers = new Set(
    screening.filter((event) => event.kind !== 'reconcile').map((event) => reviewerKey(event.reviewer)),
  )
  const multi = reviewerKeyed && (Boolean(expected) || activeReviewers.size > 1)

  const title = { include: 0, exclude: 0, maybe: 0, pending: 0 }
  const full = { include: 0, exclude: 0, maybe: 0, pending: 0, not_eligible: 0 }
  if (multi) {
    title.conflict = 0
    full.conflict = 0
  }
  const reasons = new Map()
  const included = []
  const evidenceByRecord = new Map()
  const conflicts = []

  for (const event of evidence) bump(evidenceByRecord, event.record_id)

  function countConflict(recordId, stage, resolution) {
    if (!multi) return false
    if (stage === 'title_abstract') title.conflict += 1
    else full.conflict += 1
    conflicts.push({
      record_id: recordId,
      stage,
      state: resolution.state,
      by_reviewer: resolution.conflict?.by_reviewer ?? [],
      reconcile: resolution.conflict?.reconcile ?? null,
    })
    return true
  }

  for (const record of records) {
    const resolution = resolutions.get(record.id)
    const titleRes = resolution.title
    const titleConflict = titleRes.state === 'conflict' || titleRes.state === 'reopened'
    if (titleRes.value == null) {
      if (!(titleConflict && countConflict(record.id, 'title_abstract', titleRes))) title.pending += 1
    } else {
      title[titleRes.value] += 1
      if (titleRes.value !== 'include') {
        const reason = titleRes.value_event?.reason || '(no reason)'
        bump(reasons, `title_abstract:${reason}`)
      }
    }

    if (titleRes.value === 'include') {
      const fullRes = resolution.full
      const fullConflict = fullRes.state === 'conflict' || fullRes.state === 'reopened'
      if (fullRes.value == null) {
        if (!(fullConflict && countConflict(record.id, 'full_text', fullRes))) full.pending += 1
      } else {
        full[fullRes.value] += 1
        if (fullRes.value === 'include') included.push(record.id)
        else {
          const reason = fullRes.value_event?.reason || '(no reason)'
          bump(reasons, `full_text:${reason}`)
        }
      }
    } else {
      full.not_eligible += 1
    }
  }

  const includedWithoutEvidence = included.filter((id) => !evidenceByRecord.get(id))
  const lastEventAt = [
    protocol.created_at,
    ...screening.map((event) => event.ts),
    ...evidence.map((event) => event.ts),
    ...appraisalEvents.map((event) => event.ts),
  ].filter(Boolean).sort().at(-1) || null

  const status = {
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

  if (multi) {
    const appraisalCounts = new Map()
    for (const event of appraisalEvents) {
      if (event.kind !== 'reconcile') bump(appraisalCounts, reviewerKey(event.reviewer))
    }
    status.multi_reviewer = true
    status.reviewers = reviewerSummaries({
      records, screening, expected, appraisalCounts,
    })
    status.conflicts = conflicts
  }

  return status
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
  const multi = Boolean(status.multi_reviewer)
  const stageRow = (label, counts) => (multi
    ? `| ${label} | ${counts.include} | ${counts.exclude} | ${counts.maybe} | ${counts.conflict ?? 0} | ${counts.pending} |`
    : `| ${label} | ${counts.include} | ${counts.exclude} | ${counts.maybe} | ${counts.pending} |`)
  lines.push(
    '',
    '## PRISMA-style counts',
    '',
    multi ? '| Stage | Include | Exclude | Maybe | Conflict | Pending |' : '| Stage | Include | Exclude | Maybe | Pending |',
    multi ? '|---|---:|---:|---:|---:|---:|' : '|---|---:|---:|---:|---:|',
    stageRow('Title/abstract', status.screening.title_abstract),
    stageRow('Full text', status.screening.full_text),
    '',
    `Records: ${status.records_total}. Search queries: ${status.search.queries}; added: ${status.search.added}; duplicates skipped: ${status.search.skipped}.`,
  )
  if (multi) {
    const conflicts = (status.screening.title_abstract.conflict || 0)
      + (status.screening.full_text.conflict || 0)
    if (conflicts) {
      lines.push('', `Unresolved conflicts: ${conflicts} stage decision(s). Run \`review status\` for the record list; reconcile them before reporting the funnel.`)
    }
  }
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

function robStudyLabel(row) {
  const title = row.title || '(missing title)'
  return row.year ? `${title} (${row.year})` : title
}

function robTableMarkdown(template, table) {
  const stars = template.scale.type === 'stars'
  const trailing = stars
    ? '| Total stars | Reviewers | Reconciled by | Unverified | Status |'
    : '| Reviewers | Reconciled by | Unverified | Status |'
  const trailingDivider = stars ? '|---:|---|---|---:|---|' : '|---|---|---|---:|---|'
  const lines = [
    `# Risk-of-bias table — ${template.name} ${template.version}`,
    '',
    `Source: ${template.source_url}`,
    '',
    `Population: ${table.population} included record(s).`,
    '',
    'Judgements are reviewer opinions recorded against paraphrased domains; this table is not a quality score.',
    '',
    `| Record | Study | ${table.columns.map((column) => mdCell(column.label)).join(' | ')} ${trailing}`,
    `|---|---|${table.columns.map(() => '---').join('|')}${trailingDivider}`,
  ]
  for (const row of table.rows) {
    const cells = table.columns.map((column) => {
      const value = row.values[column.key]
      if (column.key === 'overall' && row.overall_basis === 'derived' && value != null) {
        return `${value} (derived)`
      }
      return value == null ? '' : String(value)
    })
    const reviewers = row.reviewers.length ? row.reviewers.join('; ') : '(none)'
    const reconciled = row.reconciled_by.length ? row.reconciled_by.join('; ') : ''
    const end = stars
      ? `| ${row.total_stars ?? ''} | ${mdCell(reviewers)} | ${mdCell(reconciled)} | ${row.unverified_quotes} | ${row.status} |`
      : `| ${mdCell(reviewers)} | ${mdCell(reconciled)} | ${row.unverified_quotes} | ${row.status} |`
    lines.push(`| ${row.record_id} | ${mdCell(robStudyLabel(row))} | ${cells.map(mdCell).join(' | ')} ${end}`)
  }
  lines.push('', 'A cell may read "conflict" or "pending"; neither is a judgement. An overall marked (derived) follows the instrument rule, not a new reviewer decision. "Reconciled by" names the reviewer whose consensus decision resolved a disagreement. AI reviewers are marked ai:. Unverified counts quotes not confirmed through PaperMemory.', '')
  return lines.join('\n')
}

function robTableCsv(table, template) {
  const header = [
    'record_id', 'title', 'year', 'doi',
    ...table.columns.map((column) => column.key),
    'overall_basis', 'reviewers', 'reconciled_by', 'unverified_quotes', 'status',
  ]
  if (template.scale.type === 'stars') header.push('total_stars')
  const lines = [header.map(csvCell).join(',')]
  for (const row of table.rows) {
    const values = table.columns.map((column) => row.values[column.key] ?? '')
    const line = [
      row.record_id, row.title, row.year ?? '', row.doi ?? '',
      ...values,
      row.overall_basis ?? '', row.reviewers.join('; '), row.reconciled_by.join('; '),
      row.unverified_quotes, row.status,
    ]
    if (template.scale.type === 'stars') line.push(row.total_stars ?? '')
    lines.push(line.map(csvCell).join(','))
  }
  return `${lines.join('\n')}\n`
}

function scaleLabel(template, id) {
  if (template.scale.type === 'ordinal') {
    return template.scale.values.find((value) => value.id === id)?.label || id
  }
  return String(id)
}

function robSummaryMarkdown(template, summary) {
  const scaleIds = [...new Set(summary.rows.flatMap((row) => row.scale))]
  const lines = [
    `# Risk-of-bias summary — ${template.name} ${template.version}`,
    '',
    `Source: ${template.source_url}`,
    '',
    `Population: ${summary.population} included record(s).`,
    '',
    'Counts describe recorded reviewer judgements; they are not a quality score.',
    '',
    `| Domain | ${scaleIds.map((id) => mdCell(scaleLabel(template, id))).join(' | ')} | Conflict | Pending | Total |`,
    `|---|${scaleIds.map(() => '---:').join('|')}|---:|---:|---:|`,
  ]
  for (const row of summary.rows) {
    const counts = scaleIds.map((id) => row.counts[id] ?? 0)
    lines.push(`| ${mdCell(row.label)} | ${counts.join(' | ')} | ${row.conflict} | ${row.pending} | ${row.total} |`)
  }
  lines.push('')
  if (template.scale.type === 'stars') lines.push('Total stars is a count, not a quality verdict.', '')
  return lines.join('\n')
}

function robSummaryCsv(template, summary) {
  const scaleIds = [...new Set(summary.rows.flatMap((row) => row.scale))]
  const header = ['key', 'label', 'domain', 'axis', ...scaleIds, 'conflict', 'pending', 'total']
  const lines = [header.map(csvCell).join(',')]
  for (const row of summary.rows) {
    lines.push([
      row.key,
      row.label,
      row.domain ?? '',
      row.axis ?? '',
      ...scaleIds.map((id) => row.counts[id] ?? 0),
      row.conflict,
      row.pending,
      row.total,
    ].map(csvCell).join(','))
  }
  return `${lines.join('\n')}\n`
}

export function exportReview({
  cwd, slug, format = 'markdown', overwrite = false, table_format = 'markdown',
  instrument = null, version = null,
}) {
  const dir = ensureReview(cwd, slug)
  mkdirSync(join(dir, 'exports'), { recursive: true })
  const protocol = readProtocol(cwd, slug)
  const status = deriveStatus(cwd, slug)
  const records = readJsonl(cwd, slug, 'records')
  const evidence = readJsonl(cwd, slug, 'evidence')
  const kind = text(format).toLowerCase()
  let name
  let body
  let tableFormat = null
  if (kind === 'markdown' || kind === 'md') {
    name = 'review.md'
    body = markdownReport(protocol, status, records, evidence)
  } else if (kind === 'csv') {
    name = 'evidence.csv'
    body = evidenceCsv(status, records, evidence)
  } else if (kind === 'json') {
    const appraisal = readJsonl(cwd, slug, 'appraisal')
    const registry = readInstruments(cwd, slug)
    const payload = {
      protocol, status, records, screening: readJsonl(cwd, slug, 'screening'), evidence,
    }
    if (appraisal.length) payload.appraisal = appraisal
    if (registry.instruments.length) payload.instruments = registry.instruments
    name = 'review.json'
    body = `${JSON.stringify(payload, null, 2)}\n`
  } else if (kind === 'rob-table' || kind === 'rob-summary') {
    const template = frozenInstrument(cwd, slug, instrument, version)
    const { records: allRecords, resolutions } = screeningResolutions(cwd, slug)
    const includedIds = allRecords.map((record) => record.id)
      .filter((recordId) => resolutions.get(recordId)?.full?.value === 'include')
    const evaluation = evaluateInstrument({
      template,
      records: allRecords,
      events: readJsonl(cwd, slug, 'appraisal'),
      includedIds,
      expectedReviewers: Array.isArray(protocol.reviewers) ? protocol.reviewers : [],
    })
    tableFormat = text(table_format).toLowerCase()
    if (tableFormat === 'md') tableFormat = 'markdown'
    if (!['markdown', 'csv'].includes(tableFormat)) {
      throw new Error('table_format must be markdown or csv')
    }
    if (kind === 'rob-table') {
      const table = buildRobTable(evaluation, template)
      name = tableFormat === 'csv' ? 'rob-table.csv' : 'rob-table.md'
      body = tableFormat === 'csv' ? robTableCsv(table, template) : robTableMarkdown(template, table)
    } else {
      const summary = buildRobSummary(evaluation, template)
      name = tableFormat === 'csv' ? 'rob-summary.csv' : 'rob-summary.md'
      body = tableFormat === 'csv' ? robSummaryCsv(template, summary) : robSummaryMarkdown(template, summary)
    }
  } else if (kind === 'rob-figure') {
    throw new Error('rob-figure is rendered by the review tool, not the store; use action export format rob-figure')
  } else {
    throw new Error('format must be markdown, csv, json, rob-table, rob-summary, or rob-figure')
  }
  const out = join(dir, 'exports', name)
  if (existsSync(out) && !overwrite) {
    throw new Error(`${relative(resolve(cwd), out)} already exists; pass overwrite: true to replace it`)
  }
  writeFileSync(out, body)
  return {
    format: kind,
    ...(tableFormat ? { table_format: tableFormat } : {}),
    path: relative(resolve(cwd), out),
    bytes: Buffer.byteLength(body),
  }
}
