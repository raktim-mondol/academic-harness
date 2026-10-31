/**
 * Read-only cross-ledger provenance index (Phase 3 of
 * docs/SCIENTIFIC-EXPANSION-PLAN.md).
 *
 * This module is not a source of truth. Every node and edge is derived from
 * ledgers that already exist, joined by the ids and hashes they already store,
 * and a link is only a reference — it never asserts support. The only thing
 * written here is the audit cache under `<cwd>/.dsh/provenance/<slug>/`, and
 * `assertAuditWrite` refuses every other target so a bug cannot damage a source
 * ledger.
 *
 * States answer one question — what supports this claim? — and are deliberately
 * conservative:
 *   supported     an explicit stored link plus a verification or human signature
 *   no_link       no evidence link recorded at all
 *   not_checked   evidence recorded, never verified
 *   unverified    verification attempted and did not confirm it
 *   stale         the source behind the evidence changed
 *   not_found     a recorded link points at something that does not exist
 *   unknown       the ledger could not be read, or has not shipped
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, resolve, sep } from 'node:path'
import {
  csvCell, ensureDir, exportText, hashFile, mdCell, nowIso, readJson, readJsonl, sha256,
  shortHash, slug as slugify, stableStringify,
} from './ledger-kit.js'
import { PROVENANCE_SCHEMA_VERSION, provenanceKind } from './provenance.js'
import { withLock } from './store-lock.js'
import { resolveWorkspacePath } from './workspace-path.js'
import { readJsonl as readReviewJsonl, readProtocol as readReviewProtocol } from './review-store.js'
import { latestVerdicts, readCheck as readReportingCheck, readVerdicts } from './reporting-store.js'
import { readGradeEvents } from './grade-store.js'

export const AUDIT_STATES = ['supported', 'no_link', 'not_checked', 'unverified', 'stale', 'not_found', 'unknown']
export const UNSUPPORTED_STATES = ['no_link', 'not_checked', 'unverified', 'stale', 'not_found']
export const PROVENANCE_ACTIONS = ['index', 'coverage', 'unsupported', 'stale', 'unverified', 'impact', 'export']
export const PROVENANCE_EXPORT_FORMATS = ['markdown', 'csv', 'json', 'graphml', 'mermaid']

const STATE_RANK = { supported: 0, not_checked: 1, no_link: 2, unverified: 3, not_found: 4, stale: 5, unknown: 6 }
const CLIP = 220
const MAX_NODES = 20_000
const MAX_DEPTH = 4
const AH_DEFAULT_CLAIMS_DIR = 'claims'

function text(value) {
  if (value == null) return ''
  if (Array.isArray(value)) return text(value[0])
  return String(value).replace(/\s+/g, ' ').trim()
}

function clip(value, max = CLIP) {
  const raw = text(value)
  return raw.length <= max ? raw : `${raw.slice(0, max - 1)}…`
}

function normalizeForMatch(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\S ]+/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .trim()
}

/** `claim:review/bcg/e0001`, or `review:review/bcg` when there is no local id. */
function nodeId(kind, ledger, slug, localId = '') {
  provenanceKind(kind)
  const base = `${kind}:${ledger}/${slugify(slug)}`
  return localId ? `${base}/${localId}` : base
}

function fileNodeId(relPath) {
  return `export:${String(relPath).replace(/\\/g, '/')}`
}

function paperNodeId(key) {
  return `paper:${text(key)}`
}

/** The `sha256:<hex>` of a file's bytes, in the same form the ledgers store. */
function fileSha256(abs) {
  return `sha256:${hashFile(abs)}`
}

function sha1Hex(value) {
  return createHash('sha1').update(value).digest('hex')
}

function bare(value) {
  return String(value ?? '').replace(/^sha256:/, '').toLowerCase()
}

/* ------------------------------------------------------------------ storage */

export function provenanceSlug(value) {
  const slug = slugify(value == null || value === '' ? 'default' : value)
  if (!slug) throw new Error('audit slug must contain at least one letter or digit')
  return slug
}

export function provenanceDir(cwd, slug) {
  return join(resolve(cwd), '.dsh', 'provenance', provenanceSlug(slug))
}

function auditFiles(cwd, slug) {
  const dir = provenanceDir(cwd, slug)
  return { dir, index: join(dir, 'index.json'), exports: join(dir, 'exports') }
}

/**
 * The read-only guarantee, enforced at the only place that writes: the target
 * must resolve inside this audit's own cache directory.
 */
export function assertAuditWrite(cwd, slug, target) {
  const dir = resolve(provenanceDir(cwd, slug))
  const abs = resolve(target)
  if (abs !== dir && !abs.startsWith(`${dir}${sep}`)) {
    const shown = relative(resolve(cwd), abs) || abs
    throw new Error(`read_only_ledger: provenance_audit may only write under .dsh/provenance/${provenanceSlug(slug)}; refused ${shown}`)
  }
  return abs
}

function writeAuditExport({ cwd, slug, name, body, overwrite = false }) {
  const target = assertAuditWrite(cwd, slug, join(auditFiles(cwd, slug).exports, name))
  return { written: exportText(target, body, { overwrite }), path: target }
}

export function readAuditIndex(cwd, slug) {
  const index = readJson(auditFiles(cwd, slug).index)
  if (!index) throw new Error(`no provenance index for audit "${provenanceSlug(slug)}"; run action "index" first`)
  return index
}

/* ---------------------------------------------------------------------- graph */

function makeGraph() {
  const nodes = new Map()
  const edges = new Set()
  const notes = []

  function node(input) {
    const id = String(input.id)
    const existing = nodes.get(id)
    if (existing) return existing
    if (nodes.size >= MAX_NODES) {
      if (!notes.includes('node budget reached; later records were skipped')) notes.push('node budget reached; later records were skipped')
      return null
    }
    const created = {
      id,
      kind: input.kind,
      ledger: input.ledger,
      slug: input.slug ?? null,
      type: input.type,
      role: input.role,
      label: clip(input.label),
      state: input.state || 'unknown',
      reason: input.reason ?? null,
      reviewer: input.reviewer ?? null,
      ts: input.ts ?? null,
      location: input.location ?? null,
      paper: input.paper ?? null,
      path: input.path ?? null,
      quote: input.quote ?? null,
      hashes: input.hashes ?? null,
      detail: input.detail ?? null,
    }
    nodes.set(id, created)
    return created
  }

  /** Worsen an existing node's state — used when a claim inherits its evidence. */
  function bump(id, candidate) {
    const existing = nodes.get(id)
    if (!existing || !candidate?.state) return existing
    if (STATE_RANK[candidate.state] > STATE_RANK[existing.state]) {
      existing.state = candidate.state
      if (candidate.reason) existing.reason = candidate.reason
    }
    return existing
  }

  function edge(input) {
    if (!nodes.has(input.from) || !nodes.has(input.to) || input.from === input.to) return null
    const key = stableStringify(input)
    if (edges.has(key)) return null
    edges.add(key)
    return input
  }

  return {
    node,
    bump,
    edge,
    notes,
    has: (id) => nodes.has(id),
    ids: () => [...nodes.keys()],
    nodes: () => [...nodes.values()],
    edges: () => [...edges].map((key) => JSON.parse(key)),
    size: () => nodes.size,
  }
}

/** A quote is only support once something has actually checked it. */
function evidenceState({ paper, check, quote }) {
  if (!quote) return { state: 'no_link', reason: 'no verbatim quote recorded' }
  if (!paper) return { state: 'no_link', reason: 'a quote is recorded but no PaperMemory paper links it to a source' }
  if (!check) return { state: 'not_checked', reason: `quote recorded against paper "${clip(paper, 60)}" but never verified` }
  if (check.status === 'verified') return { state: 'supported', reason: `verified via ${check.via || 'a quote check'}` }
  if (check.status === 'unverified') return { state: 'unverified', reason: clip(check.detail || 'the quote check did not confirm the quote') }
  return { state: 'not_checked', reason: `quote check status "${check.status || 'unknown'}" is not a verification` }
}

function dropSuperseded(events, idKeys = ['event_id', 'evidence_id', 'appraisal_id', 'grade_id', 'extraction_id']) {
  const replaced = new Set(events.map((event) => event.supersedes).filter(Boolean))
  return events.filter((event) => !replaced.has(idKeys.map((key) => event[key]).find(Boolean)))
}

function fileState(cwd, relPath, recorded) {
  let abs
  try {
    abs = resolveWorkspacePath(cwd, relPath)
  } catch (error) {
    return { state: 'not_found', reason: clip(error.message), hashes: null }
  }
  if (!existsSync(abs)) {
    return { state: 'not_found', reason: `${relPath} is not in the workspace`, hashes: null }
  }
  let current
  try {
    current = fileSha256(abs)
  } catch (error) {
    return { state: 'unknown', reason: `${relPath} could not be hashed (${clip(error.message, 120)})`, hashes: null }
  }
  if (!recorded) {
    return { state: 'not_checked', reason: `${relPath} exists but no hash was recorded against it`, hashes: { current } }
  }
  if (bare(recorded) !== bare(current)) {
    return { state: 'stale', reason: `${relPath} changed since it was recorded`, hashes: { recorded, current } }
  }
  return { state: 'supported', reason: `${relPath} matches its recorded hash`, hashes: { recorded, current } }
}

function addFileNode(graph, cwd, ledger, slug, relPath, recorded, relation, fromId, { role = 'support', type = 'file', label = null } = {}) {
  const resolved = fileState(cwd, relPath, recorded)
  graph.node({
    id: fileNodeId(relPath), kind: 'export', ledger, slug, type, role,
    label: label || relPath,
    state: resolved.state,
    reason: resolved.reason,
    path: relPath,
    hashes: recorded ? { ...resolved.hashes, recorded } : resolved.hashes,
  })
  if (fromId) graph.edge({ from: fromId, to: fileNodeId(relPath), relation, ledger })
  return fileNodeId(relPath)
}

function addPaperNode(graph, ledger, slug, key, { state = null, reason = null, relation = null, fromId = null } = {}) {
  const paper = text(key)
  if (!paper) return null
  const id = paperNodeId(paper)
  graph.node({
    id, kind: 'paper', ledger, slug, type: 'paper', role: 'container', label: paper,
    state: state || 'unknown',
    reason: reason || 'PaperMemory was not queried for this paper during this index',
    paper,
  })
  if (fromId && relation) graph.edge({ from: fromId, to: id, relation, ledger })
  return id
}

/* --------------------------------------------------------------------- review */

function readReviewLedger(cwd, slug, graph) {
  const protocol = readReviewProtocol(cwd, slug)
  const records = readReviewJsonl(cwd, slug, 'records')
  const screening = readReviewJsonl(cwd, slug, 'screening')
  const evidence = dropSuperseded(readReviewJsonl(cwd, slug, 'evidence'))
  const extractions = dropSuperseded(readReviewJsonl(cwd, slug, 'extractions')).filter((event) => event.kind !== 'reconcile')
  const appraisals = dropSuperseded(readReviewJsonl(cwd, slug, 'appraisal')).filter((event) => event.kind !== 'reconcile')
  const gradeEvents = dropSuperseded(readGradeEvents(cwd, slug))
  const reviewId = nodeId('review', 'review', slug)

  graph.node({
    id: reviewId, kind: 'review', ledger: 'review', slug, type: 'review', role: 'container',
    label: protocol.question || slug, state: 'not_checked',
    reason: 'container node — a review protocol is the plan, not the evidence', ts: protocol.created_at ?? null,
  })

  for (const record of records) {
    const recordId = nodeId('record', 'review', slug, record.id)
    graph.node({
      id: recordId, kind: 'record', ledger: 'review', slug, type: 'record', role: 'container',
      label: `${record.id} ${record.title || ''} (${record.year ?? 'n.d.'})`,
      state: 'not_checked', reason: 'container node — a screening record', ts: record.added_at ?? null,
      detail: { doi: record.doi ?? null, pmid: record.pmid ?? null, arxiv_id: record.arxiv_id ?? null, source: record.source ?? null },
    })
    graph.edge({ from: recordId, to: reviewId, relation: 'in_review', ledger: 'review' })
    if (record.doi) addPaperNode(graph, 'review', slug, `doi:${record.doi}`, { relation: 'identifies', fromId: recordId })
  }
  for (const event of dropSuperseded(screening)) {
    if (event.kind === 'reconcile') continue
    const recordId = nodeId('record', 'review', slug, event.record_id)
    if (!graph.has(recordId)) continue
    const decisionId = nodeId('record', 'review', slug, `screen~${event.event_id || `${event.record_id}-${event.stage}`}`)
    graph.node({
      id: decisionId, kind: 'record', ledger: 'review', slug, type: 'screening_decision', role: 'container',
      label: `${event.record_id} ${event.stage}: ${event.decision}`,
      state: 'not_checked', reason: 'container node — a screening decision is a human record, not source evidence',
      reviewer: event.reviewer ?? null, ts: event.ts ?? null,
    })
    graph.edge({ from: decisionId, to: recordId, relation: 'about_record', ledger: 'review' })
    graph.edge({ from: decisionId, to: reviewId, relation: 'in_review', ledger: 'review' })
  }

  const evidenceByRecord = new Map()
  for (const event of evidence) {
    const claimId = nodeId('claim', 'review', slug, event.evidence_id)
    const quoteId = nodeId('quote', 'review', slug, event.evidence_id)
    const state = evidenceState({ paper: event.paper, check: event.quote_check, quote: event.quote })
    graph.node({
      id: claimId, kind: 'claim', ledger: 'review', slug, type: 'review_evidence', role: 'claim',
      label: event.claim, state: state.state, reason: state.reason,
      reviewer: event.reviewer ?? null, ts: event.ts ?? null, location: event.location ?? null, paper: event.paper ?? null,
    })
    graph.node({
      id: quoteId, kind: 'quote', ledger: 'review', slug, type: 'review_evidence_quote', role: 'support',
      label: event.quote, quote: event.quote, state: state.state, reason: state.reason,
      location: event.location ?? null, paper: event.paper ?? null,
      hashes: event.quote_check?.checked_against?.sha256 ? { recorded: event.quote_check.checked_against.sha256 } : null,
    })
    graph.edge({ from: claimId, to: quoteId, relation: 'supported_by', ledger: 'review' })
    graph.edge({ from: claimId, to: nodeId('record', 'review', slug, event.record_id), relation: 'about_record', ledger: 'review' })
    if (event.paper) addPaperNode(graph, 'review', slug, event.paper, { relation: 'quote_of', fromId: quoteId })
    evidenceByRecord.set(event.record_id, (evidenceByRecord.get(event.record_id) || 0) + 1)
  }

  for (const event of extractions) {
    const claimId = nodeId('claim', 'review', slug, event.extraction_id)
    const checks = Object.values(event.quote_checks || {})
    const state = !Object.keys(event.quotes || {}).length
      ? { state: 'no_link', reason: 'extraction values recorded without any supporting quote' }
      : checks.every((check) => check?.status === 'verified')
        ? { state: 'supported', reason: `all ${checks.length} field quote(s) verified` }
        : { state: 'unverified', reason: `${checks.filter((check) => check?.status !== 'verified').length} of ${checks.length} field quote(s) not verified` }
    graph.node({
      id: claimId, kind: 'claim', ledger: 'review', slug, type: 'review_extraction', role: 'claim',
      label: `extraction ${event.extraction_id} (row ${event.row_id || 'main'}, ${Object.keys(event.values || {}).length} field(s))`,
      state: state.state, reason: state.reason, reviewer: event.reviewer ?? null, ts: event.ts ?? null, paper: event.paper ?? null,
    })
    graph.edge({ from: claimId, to: nodeId('record', 'review', slug, event.record_id), relation: 'about_record', ledger: 'review' })
    for (const [fieldId, entry] of Object.entries(event.quotes || {})) {
      const check = event.quote_checks?.[fieldId]
      const fieldState = check?.status === 'verified'
        ? { state: 'supported', reason: `verified via ${check.via || 'a quote check'}` }
        : { state: 'unverified', reason: clip(check?.detail || 'the field quote was not verified') }
      const quoteId = nodeId('quote', 'review', slug, `${event.extraction_id}~${fieldId}`)
      graph.node({
        id: quoteId, kind: 'quote', ledger: 'review', slug, type: 'extraction_field_quote', role: 'support',
        label: `${fieldId}: ${entry.quote}`, quote: entry.quote, state: fieldState.state, reason: fieldState.reason,
        location: entry.location ?? null, paper: event.paper ?? null,
        hashes: check?.checked_against?.sha256 ? { recorded: check.checked_against.sha256 } : null,
      })
      graph.edge({ from: claimId, to: quoteId, relation: 'supported_by', ledger: 'review' })
      if (event.paper) addPaperNode(graph, 'review', slug, event.paper, { relation: 'quote_of', fromId: quoteId })
    }
  }

  for (const event of appraisals) {
    const claimId = nodeId('claim', 'review', slug, event.appraisal_id)
    const state = event.quote
      ? evidenceState({ paper: event.paper, check: event.quote_check, quote: event.quote })
      : { state: 'not_checked', reason: 'domain judgement recorded without a quote (not a decisive rating)' }
    graph.node({
      id: claimId, kind: 'claim', ledger: 'review', slug, type: 'review_appraisal', role: 'claim',
      label: `${event.instrument?.id ?? 'instrument'} ${event.domain}${event.axis ? `/${event.axis}` : ''} = ${event.judgement}`,
      state: state.state, reason: state.reason, reviewer: event.reviewer ?? null, ts: event.ts ?? null,
      location: event.location ?? null, paper: event.paper ?? null,
    })
    graph.edge({ from: claimId, to: nodeId('record', 'review', slug, event.record_id), relation: 'about_record', ledger: 'review' })
    if (event.quote) {
      const quoteId = nodeId('quote', 'review', slug, `${event.appraisal_id}~quote`)
      graph.node({
        id: quoteId, kind: 'quote', ledger: 'review', slug, type: 'appraisal_quote', role: 'support',
        label: event.quote, quote: event.quote, state: state.state, reason: state.reason,
        location: event.location ?? null, paper: event.paper ?? null,
        hashes: event.quote_check?.checked_against?.sha256 ? { recorded: event.quote_check.checked_against.sha256 } : null,
      })
      graph.edge({ from: claimId, to: quoteId, relation: 'supported_by', ledger: 'review' })
      if (event.paper) addPaperNode(graph, 'review', slug, event.paper, { relation: 'quote_of', fromId: quoteId })
    }
  }

  for (const event of gradeEvents) {
    const gradeId = nodeId('claim', 'review', slug, event.grade_id)
    if (event.kind === 'overall') {
      const human = text(event.reviewer).startsWith('human:')
      graph.node({
        id: gradeId, kind: 'claim', ledger: 'review', slug, type: 'grade_overall', role: 'support',
        label: `overall certainty ${event.certainty} for ${event.outcome}`,
        state: human ? 'supported' : 'unverified',
        reason: human
          ? 'recorded human certainty — a human judgement is evidence under the harness rules'
          : `recorded by ${event.reviewer || 'an unnamed reviewer'}; no human signature`,
        reviewer: event.reviewer ?? null, ts: event.ts ?? null,
      })
    } else {
      const state = event.quote
        ? evidenceState({ paper: event.paper, check: event.quote_check, quote: event.quote })
        : { state: 'not_checked', reason: `domain rating ${event.rating} recorded with a reason but no quote` }
      graph.node({
        id: gradeId, kind: 'claim', ledger: 'review', slug, type: 'grade_judgement', role: 'claim',
        label: `${event.outcome} / ${event.domain} = ${event.rating}`,
        state: state.state, reason: state.reason, reviewer: event.reviewer ?? null, ts: event.ts ?? null,
        location: event.location ?? null, paper: event.paper ?? null,
      })
      if (event.quote) {
        const quoteId = nodeId('quote', 'review', slug, `${event.grade_id}~quote`)
        graph.node({
          id: quoteId, kind: 'quote', ledger: 'review', slug, type: 'grade_quote', role: 'support',
          label: event.quote, quote: event.quote, state: state.state, reason: state.reason,
          location: event.location ?? null, paper: event.paper ?? null,
        })
        graph.edge({ from: gradeId, to: quoteId, relation: 'supported_by', ledger: 'review' })
        if (event.paper) addPaperNode(graph, 'review', slug, event.paper, { relation: 'quote_of', fromId: quoteId })
      }
    }
    graph.edge({ from: gradeId, to: reviewId, relation: 'grades', ledger: 'review' })
  }

  for (const record of records) {
    const included = screening.some((event) => event.kind !== 'reconcile'
      && event.record_id === record.id && event.stage === 'full_text' && event.decision === 'include')
    if (!included) continue
    const count = evidenceByRecord.get(record.id) || 0
    const claimId = nodeId('claim', 'review', slug, `include~${record.id}`)
    graph.node({
      id: claimId, kind: 'claim', ledger: 'review', slug, type: 'review_inclusion', role: 'claim',
      label: `inclusion of ${record.id}: ${record.title || ''}`,
      state: count ? 'not_checked' : 'no_link',
      reason: count
        ? `${count} evidence event(s) recorded; the inclusion itself rests on the screening decision, not on a verified quote`
        : 'record included at full text with no evidence recorded',
    })
    graph.edge({ from: claimId, to: nodeId('record', 'review', slug, record.id), relation: 'about_record', ledger: 'review' })
  }

  return {
    slug: slugify(slug),
    question: protocol.question ?? null,
    counts: {
      records: records.length, evidence: evidence.length, extractions: extractions.length,
      appraisals: appraisals.length, grade_events: gradeEvents.length,
    },
  }
}

/* ------------------------------------------------------------------ reporting */

function readReportingLedger(cwd, slug, graph) {
  const check = readReportingCheck(cwd, slug)
  const latest = latestVerdicts(readVerdicts(cwd, slug))
  const manuscript = check.manuscript || {}
  const reviewId = nodeId('review', 'reporting', slug)

  graph.node({
    id: reviewId, kind: 'review', ledger: 'reporting', slug, type: 'reporting_check', role: 'container',
    label: `${check.guideline?.id ?? 'guideline'} check on ${manuscript.path || manuscript.paper || manuscript.title || slug}`,
    state: 'not_checked', reason: 'container node — a reporting checklist is a set of items, not evidence', ts: check.created_at ?? null,
  })

  let manuscriptNode = null
  let manuscriptState = { state: 'unknown', reason: 'the checked source cannot be re-read from this ledger', hashes: null }
  let currentText = null
  if (manuscript.kind === 'file' && manuscript.path) {
    manuscriptState = fileState(cwd, manuscript.path, manuscript.sha256)
    manuscriptNode = fileNodeId(manuscript.path)
    graph.node({
      id: manuscriptNode, kind: 'export', ledger: 'reporting', slug, type: 'manuscript', role: 'container',
      label: manuscript.path, state: manuscriptState.state,
      reason: `snapshot ${clip(manuscript.sha256, 22)}: ${manuscriptState.reason}`,
      path: manuscript.path, hashes: manuscriptState.hashes,
    })
    if (manuscriptState.state !== 'not_found') {
      try {
        currentText = normalizeForMatch(readFileSync(resolveWorkspacePath(cwd, manuscript.path), 'utf8'))
      } catch {
        currentText = null
      }
    }
  } else if (manuscript.kind === 'papermemory' && manuscript.paper) {
    manuscriptNode = paperNodeId(manuscript.paper)
    graph.node({
      id: manuscriptNode, kind: 'paper', ledger: 'reporting', slug, type: 'manuscript', role: 'container',
      label: manuscript.paper, state: 'unknown',
      reason: 'PaperMemory was not queried for the manuscript during this index', paper: manuscript.paper,
    })
  }

  const counts = { reported: 0, partial: 0, not_reported: 0, not_applicable: 0, unassessed: 0 }
  for (const [itemId, event] of latest) {
    counts[event.verdict] = (counts[event.verdict] || 0) + 1
    const claimId = nodeId('claim', 'reporting', slug, itemId)
    const quote = event.evidence?.quote ? text(event.evidence.quote) : ''
    const searched = (event.searched || []).slice(0, 6).join(', ')
    const negative = event.verdict === 'not_applicable'
    let state
    if (negative) {
      state = { state: 'not_checked', reason: `recorded not applicable: ${clip(event.reason || 'no reason given', 140)}` }
    } else if (event.verdict === 'not_reported') {
      state = { state: 'no_link', reason: searched ? `no passage reporting this item was found (searched: ${searched})` : 'no passage reporting this item was found' }
    } else if (!quote) {
      state = { state: 'no_link', reason: `verdict "${event.verdict}" recorded without a verbatim quote` }
    } else if (manuscriptState.state === 'stale' || manuscriptState.state === 'not_found') {
      const stillThere = currentText == null ? null : currentText.includes(normalizeForMatch(quote).slice(0, 200))
      state = stillThere === false
        ? { state: 'stale', reason: 'the manuscript changed and the recorded quote is no longer found in it' }
        : stillThere
          ? { state: 'supported', reason: 'the manuscript changed but the recorded quote is still present in it' }
          : { state: 'stale', reason: `the manuscript snapshot changed (${manuscriptState.reason}) and the quote cannot be re-matched` }
    } else if (manuscriptState.state === 'unknown') {
      state = { state: 'not_checked', reason: 'a quote was recorded, but the source is a PaperMemory paper the audit did not re-read' }
    } else {
      state = { state: 'supported', reason: 'quote re-found in the manuscript when the verdict was recorded; the snapshot has not changed since' }
    }
    graph.node({
      id: claimId, kind: 'claim', ledger: 'reporting', slug, type: 'checklist_item',
      role: negative ? 'container' : 'claim',
      label: `${itemId}: ${event.verdict}`, state: state.state, reason: state.reason,
      reviewer: event.reviewer ?? null, ts: event.ts ?? null,
      detail: { guideline: check.guideline?.id ?? null, verdict: event.verdict },
    })
    graph.edge({ from: claimId, to: reviewId, relation: 'in_check', ledger: 'reporting' })
    if (manuscriptNode) graph.edge({ from: claimId, to: manuscriptNode, relation: 'reported_in', ledger: 'reporting' })
    if (!quote || negative) continue
    const quoteId = nodeId('quote', 'reporting', slug, `${itemId}~quote`)
    graph.node({
      id: quoteId, kind: 'quote', ledger: 'reporting', slug, type: 'checklist_quote', role: 'support',
      label: quote, quote, state: state.state, reason: state.reason,
      location: event.evidence?.location ?? null, path: manuscript.path ?? null, hashes: manuscriptState.hashes,
    })
    graph.edge({ from: claimId, to: quoteId, relation: 'supported_by', ledger: 'reporting' })
  }
  for (const itemId of check.item_ids || []) {
    if (latest.has(itemId)) continue
    counts.unassessed += 1
    graph.node({
      id: nodeId('claim', 'reporting', slug, itemId), kind: 'claim', ledger: 'reporting', slug,
      type: 'checklist_item', role: 'container', label: `${itemId}: unassessed`,
      state: 'not_checked', reason: 'no verdict recorded for this checklist item',
    })
    graph.edge({ from: nodeId('claim', 'reporting', slug, itemId), to: reviewId, relation: 'in_check', ledger: 'reporting' })
  }

  return {
    slug: slugify(slug),
    guideline: check.guideline?.id ?? null,
    manuscript: { kind: manuscript.kind ?? null, path: manuscript.path ?? null, state: manuscriptState.state },
    counts: { verdicts: latest.size, ...counts },
  }
}

/* ---------------------------------------------------------------- deep review */

function readDeepReviewLedger(cwd, key, graph) {
  const dir = join(resolve(cwd), '.dsh', 'deep-review', key)
  const meta = readJson(join(dir, 'meta.json'))
  if (!meta || typeof meta !== 'object') throw new Error(`no deep-review record under .dsh/deep-review/${key}`)
  const input = meta.input || {}
  const reviewedSha = meta.review?.sha1 ?? meta.input?.sha1 ?? null
  const checkId = nodeId('review', 'deep_review', key)

  let manuscriptNode = null
  let manuscriptState = { state: 'unknown', reason: 'the reviewed file is not readable from this workspace', hashes: null }
  if (input.path) {
    let current = null
    try {
      const abs = resolveWorkspacePath(cwd, input.path)
      if (existsSync(abs)) current = sha1Hex(readFileSync(abs))
    } catch {
      current = null
    }
    manuscriptState = !current
      ? { state: 'not_found', reason: `${input.path} is not in the workspace`, hashes: null }
      : reviewedSha && current !== reviewedSha
        ? { state: 'stale', reason: 'the manuscript changed after this review was stored', hashes: { recorded: reviewedSha, current } }
        : { state: 'supported', reason: 'the reviewed file matches the stored content hash', hashes: { recorded: reviewedSha, current } }
    manuscriptNode = fileNodeId(input.path)
    graph.node({
      id: manuscriptNode, kind: 'export', ledger: 'deep_review', slug: key, type: 'manuscript', role: 'container',
      label: input.path, state: manuscriptState.state, reason: manuscriptState.reason,
      path: input.path, hashes: manuscriptState.hashes,
    })
  }

  graph.node({
    id: checkId, kind: 'review', ledger: 'deep_review', slug: key, type: 'deep_review', role: 'container',
    label: `deep review of ${input.path || key}`,
    state: 'not_checked', reason: 'container node — an engine review is a set of readings, not verified evidence',
  })

  const review = readJson(join(dir, 'review.json'))
  const claims = Array.isArray(review?.result?.claimEvidenceMap) ? review.result.claimEvidenceMap : []
  const reports = readJson(join(dir, 'citations.json'))
  const flagged = (Array.isArray(reports) ? reports : []).filter((report) => !['OK', 'SKIPPED', 'VERIFIED_BY_SEARCH'].includes(report?.finalVerdict))
  const sourceChanged = manuscriptState.state === 'stale' || manuscriptState.state === 'not_found'

  claims.forEach((claim, position) => {
    const id = nodeId('claim', 'deep_review', key, String(claim.claimId || `claim-${position + 1}`))
    const recorded = text(claim.status) || 'UNSPECIFIED'
    graph.node({
      id, kind: 'claim', ledger: 'deep_review', slug: key, type: 'engine_claim', role: 'claim', label: claim.claim,
      state: sourceChanged ? 'stale' : 'unverified',
      reason: sourceChanged
        ? `the reviewed manuscript no longer matches its stored hash (${manuscriptState.reason})`
        : `engine judgement "${recorded.toLowerCase()}" against ${text(claim.evidenceType) || 'no recorded evidence type'} — a model reading, not a stored verification`,
      location: clip(claim.evidenceLocation, 120) || null,
      detail: { recorded_status: recorded, gap_analysis: clip(claim.gapAnalysis, 300) },
    })
    if (manuscriptNode) graph.edge({ from: id, to: manuscriptNode, relation: 'asserted_in', ledger: 'deep_review' })
    graph.edge({ from: id, to: checkId, relation: 'from_review', ledger: 'deep_review' })
  })

  for (const report of flagged) {
    const id = nodeId('claim', 'deep_review', key, `citation-${report.refNum ?? 'unknown'}`)
    graph.node({
      id, kind: 'claim', ledger: 'deep_review', slug: key, type: 'citation_verdict', role: 'claim',
      label: report.rawReference,
      state: 'unverified',
      reason: `reference-verification verdict "${text(report.finalVerdict) || 'UNSPECIFIED'}" is advisory; no quote check backs it`,
      detail: { verdict: report.finalVerdict ?? null },
    })
    if (manuscriptNode) graph.edge({ from: id, to: manuscriptNode, relation: 'cites_from', ledger: 'deep_review' })
  }

  return {
    slug: key,
    manuscript: { path: input.path ?? null, state: manuscriptState.state },
    counts: { claims: claims.length, flagged_citations: flagged.length },
  }
}

/* ------------------------------------------------------------------- notebook */

const NOTEBOOK_KINDS = { hypothesis: 'claim', observation: 'result', decision: 'result', method: 'record', note: 'record' }

function readNotebookLedger(cwd, graph) {
  const dir = join(resolve(cwd), '.dsh', 'notebook')
  if (!existsSync(dir)) throw new Error('no notebook entries under .dsh/notebook')
  const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort()
  if (!files.length) throw new Error('no notebook entries under .dsh/notebook')

  let entries = 0
  let hypotheses = 0
  let dangling = 0
  for (const name of files) {
    const session = name.replace(/\.jsonl$/, '')
    const rows = readJsonl(join(dir, name))
    const present = new Set(rows.map((entry) => entry.id).filter(Boolean))
    for (const entry of rows) {
      entries += 1
      const isClaim = entry.type === 'hypothesis'
      const kind = NOTEBOOK_KINDS[entry.type] || 'record'
      const id = nodeId(kind, 'notebook', session, String(entry.id || clip(entry.title, 40)))
      const hasArtifact = Array.isArray(entry.artifacts) && entry.artifacts.length > 0
      const hasLink = Boolean(entry.relatesTo || entry.supersedes)
      graph.node({
        id, kind, ledger: 'notebook', slug: session, type: `notebook_${entry.type || 'note'}`,
        role: isClaim ? 'claim' : kind === 'record' ? 'container' : 'support',
        label: entry.title,
        state: isClaim
          ? (hasArtifact || hasLink ? 'not_checked' : 'no_link')
          : 'not_checked',
        reason: isClaim
          ? (hasArtifact || hasLink
            ? 'a notebook hypothesis is linked to artifacts or entries, but nothing verified it'
            : 'no artifact and no related entry recorded for this hypothesis')
          : 'container node — a notebook entry records what happened, it is not verified evidence',
        ts: entry.timestamp ? new Date(entry.timestamp).toISOString() : null,
        detail: { confidence: entry.confidence ?? null, stance: entry.stance ?? null, tags: entry.tags ?? null },
      })
      if (isClaim) hypotheses += 1
      for (const artifact of hasArtifact ? entry.artifacts : []) {
        if (typeof artifact !== 'string' || !artifact.trim()) continue
        addFileNode(graph, cwd, 'notebook', session, artifact, null, 'uses_artifact', id, { role: 'support' })
      }
      for (const [relation, target] of [['relates_to', entry.relatesTo], ['supersedes', entry.supersedes]]) {
        if (!target) continue
        const targetId = notebookTargetId(graph, session, target, present)
        if (targetId) graph.edge({ from: id, to: targetId, relation, ledger: 'notebook' })
        else if (isClaim) graph.bump(id, { state: 'not_found', reason: `this hypothesis references notebook entry "${target}", which is not in any notebook file` })
        if (!targetId) {
          dangling += 1
          graph.node({
            id: nodeId('record', 'notebook', session, `dangling~${target}`), kind: 'record', ledger: 'notebook', slug: session,
            type: 'dangling_link', role: 'support', label: `missing entry ${target}`, state: 'not_found',
            reason: `an entry in ${session} references notebook entry "${target}", which is not in any notebook file`,
          })
          graph.edge({ from: id, to: nodeId('record', 'notebook', session, `dangling~${target}`), relation: 'dangling_reference', ledger: 'notebook' })
        }
      }
    }
  }
  return { slug: 'sessions', counts: { files: files.length, entries, hypotheses, dangling_links: dangling } }
}

function notebookTargetId(graph, session, target, present) {
  if (!present.has(target)) return null
  for (const kind of ['claim', 'result', 'record']) {
    const candidate = nodeId(kind, 'notebook', session, String(target))
    if (graph.has(candidate)) return candidate
  }
  return null
}

/* ------------------------------------------------------------------- analysis */

function readAnalysisLedger(cwd, slug, graph) {
  const dir = join(resolve(cwd), '.dsh', 'analysis', slugify(slug))
  if (!existsSync(join(dir, 'plan.jsonl'))) throw new Error(`no analysis plan under .dsh/analysis/${slugify(slug)}`)
  const plans = readJsonl(join(dir, 'plan.jsonl'))
  const runs = readJsonl(join(dir, 'runs.jsonl'))

  for (const plan of plans) {
    const planId = nodeId('record', 'analysis', slug, `plan-v${plan.version}`)
    graph.node({
      id: planId, kind: 'record', ledger: 'analysis', slug, type: 'analysis_plan', role: 'container',
      label: `plan v${plan.version}: ${clip(plan.plan?.question, 160)}`,
      state: 'not_checked', reason: 'container node — a frozen plan is the intent, not the evidence',
      ts: plan.created_at ?? null, hashes: { recorded: plan.hash },
    })
    if (plan.supersedes) {
      graph.edge({ from: planId, to: nodeId('record', 'analysis', slug, `plan-v${plan.supersedes}`), relation: 'supersedes_plan', ledger: 'analysis' })
    }
    (plan.plan?.hypotheses || []).forEach((hypothesis, index) => {
      const label = text(hypothesis)
      if (!label) return
      const id = nodeId('claim', 'analysis', slug, `h${plan.version}-${index + 1}`)
      graph.node({
        id, kind: 'claim', ledger: 'analysis', slug, type: 'analysis_hypothesis', role: 'claim', label,
        state: runs.length ? 'not_checked' : 'no_link',
        reason: runs.length
          ? 'the ledger does not link a plan hypothesis to a specific run; record the link in the notebook'
          : 'the plan is frozen but no run has executed against it',
      })
      graph.edge({ from: id, to: planId, relation: 'declared_in', ledger: 'analysis' })
    })
  }

  for (const run of runs) {
    const id = nodeId('run', 'analysis', slug, run.run_id)
    const planRecord = plans.find((plan) => plan.version === run.plan_version) || null
    const planId = planRecord ? nodeId('record', 'analysis', slug, `plan-v${planRecord.version}`) : null
    const outputsWritten = (run.outputs || []).filter((entry) => entry.sha256).length
    graph.node({
      id, kind: 'run', ledger: 'analysis', slug, type: 'analysis_run', role: 'support',
      label: `${run.run_id} (${run.kind}, exit ${run.timed_out ? 'timeout' : run.exit_code ?? run.spawn_error ?? '?'})`,
      state: run.timed_out || run.exit_code !== 0 ? 'unverified' : 'supported',
      reason: run.timed_out
        ? 'the run timed out; a timed-out run is not evidence'
        : run.exit_code === 0
          ? `completed with ${outputsWritten} hashed output(s)`
          : `exit code ${run.exit_code ?? 'unknown'}${run.signal ? ` (signal ${run.signal})` : ''}${run.spawn_error ? ` (${clip(run.spawn_error, 120)})` : ''}`,
      ts: run.ts ?? null, hashes: { recorded: run.plan_hash },
      detail: { seed: run.seed ?? null, command: clip((run.command || []).join(' '), 200), git_commit: run.environment?.git_commit ?? null },
    })
    if (planId) {
      graph.edge({ from: id, to: planId, relation: 'follows_plan', ledger: 'analysis' })
      if (run.plan_hash && planRecord.hash && bare(run.plan_hash) !== bare(planRecord.hash)) {
        graph.bump(id, { state: 'stale', reason: `the manifest plan hash (${clip(run.plan_hash, 20)}) is not the hash recorded for plan v${planRecord.version}` })
      }
    } else {
      const missingId = nodeId('record', 'analysis', slug, `missing-plan~${shortHash(run.plan_hash || run.run_id, 12)}`)
      graph.node({
        id: missingId, kind: 'record', ledger: 'analysis', slug, type: 'dangling_link', role: 'support',
        label: `plan ${clip(run.plan_hash, 24)}`, state: 'not_found',
        reason: 'the run manifest cites a plan version that is not in plan.jsonl',
      })
      graph.edge({ from: id, to: missingId, relation: 'dangling_reference', ledger: 'analysis' })
    }
    for (const entry of run.inputs || []) {
      if (!entry?.path) continue
      if (entry.status || entry.error) {
        graph.node({
          id: fileNodeId(entry.path), kind: 'export', ledger: 'analysis', slug, type: 'file', role: 'support',
          label: entry.path, state: 'not_found', reason: clip(entry.status || entry.error), path: entry.path,
        })
        graph.edge({ from: id, to: fileNodeId(entry.path), relation: 'reads_input', ledger: 'analysis' })
        graph.bump(id, { state: 'not_found', reason: `declared input ${entry.path} was ${entry.status || clip(entry.error)}` })
        continue
      }
      addFileNode(graph, cwd, 'analysis', slug, entry.path, entry.sha256 || null, 'reads_input', id, { role: 'support' })
    }
    for (const entry of run.outputs || []) {
      if (!entry?.path) continue
      if (entry.status || entry.error) {
        graph.node({
          id: fileNodeId(entry.path), kind: 'export', ledger: 'analysis', slug, type: 'file', role: 'support',
          label: entry.path, state: 'not_found', reason: `output was ${clip(entry.status || entry.error)}`, path: entry.path,
        })
        graph.edge({ from: id, to: fileNodeId(entry.path), relation: 'writes_output', ledger: 'analysis' })
        continue
      }
      addFileNode(graph, cwd, 'analysis', slug, entry.path, entry.sha256 || null, 'writes_output', id, { role: 'support' })
    }
  }

  return { slug: slugify(slug), counts: { plans: plans.length, runs: runs.length, latest_plan: plans.at(-1)?.version ?? null } }
}

/* ------------------------------------------------------------------ experiment */

function readExperimentLedger(cwd, slug, graph) {
  const dir = join(resolve(cwd), '.dsh', 'experiments', slugify(slug))
  const definition = readJson(join(dir, 'experiment.json'))
  if (!definition) throw new Error(`no experiment definition under .dsh/experiments/${slugify(slug)}`)
  const runs = readJsonl(join(dir, 'runs.jsonl'))
  const links = readJsonl(join(dir, 'links.jsonl'))
  const containerId = nodeId('record', 'experiment', slug, 'experiment')

  graph.node({
    id: containerId, kind: 'record', ledger: 'experiment', slug, type: 'experiment', role: 'container',
    label: definition.question, state: 'not_checked',
    reason: 'container node — an experiment question with its declared metrics', ts: definition.created_at ?? null,
    detail: { metrics: definition.metrics ?? null },
  })
  const questionId = nodeId('claim', 'experiment', slug, 'question')
  graph.node({
    id: questionId, kind: 'claim', ledger: 'experiment', slug, type: 'experiment_question', role: 'claim',
    label: definition.question,
    state: runs.length ? 'not_checked' : 'no_link',
    reason: runs.length
      ? `${runs.length} run(s) logged; no run is marked as the recorded answer to the question`
      : 'no runs logged against this experiment',
  })
  graph.edge({ from: questionId, to: containerId, relation: 'asked_in', ledger: 'experiment' })

  const runIds = new Set(runs.map((run) => run.run_id))
  for (const run of runs) {
    const id = nodeId('run', 'experiment', slug, run.run_id)
    const metrics = Object.entries(run.metrics || {})
    graph.node({
      id, kind: 'run', ledger: 'experiment', slug, type: 'experiment_run', role: 'support',
      label: `${run.run_id}: ${metrics.map(([key, value]) => `${key}=${value}`).join(', ') || 'no metrics'}`,
      state: metrics.length ? 'supported' : 'not_checked',
      reason: metrics.length ? `${metrics.length} metric(s) recorded as logged values, not as a scientific claim` : 'run logged without metrics',
      ts: run.ts ?? null,
      detail: { seed: run.seed ?? null, parent: run.parent ?? null, git_commit: run.environment?.git_commit ?? null },
    })
    graph.edge({ from: questionId, to: id, relation: 'explored_by', ledger: 'experiment' })
    graph.edge({ from: id, to: containerId, relation: 'in_experiment', ledger: 'experiment' })
    for (const artifact of run.artifacts || []) {
      if (!artifact?.path) continue
      addFileNode(graph, cwd, 'experiment', slug, artifact.path, artifact.sha256 || null, 'produced_artifact', id, { role: 'support' })
    }
  }

  links.forEach((link, index) => {
    const id = nodeId('record', 'experiment', slug, `link-${index + 1}`)
    const target = link.target || {}
    const resolved = resolveLinkTarget(graph, target.kind, target.id)
    graph.node({
      id, kind: 'record', ledger: 'experiment', slug, type: 'experiment_link', role: 'support',
      label: `${link.run_id} → ${target.kind}:${target.id}`,
      state: resolved.state, reason: resolved.reason, ts: link.ts ?? null,
    })
    const runId = link.run_id && runIds.has(link.run_id) ? nodeId('run', 'experiment', slug, link.run_id) : null
    if (runId) graph.edge({ from: id, to: runId, relation: 'links_run', ledger: 'experiment' })
    else {
      const missingId = nodeId('record', 'experiment', slug, `missing-run~${link.run_id || 'none'}`)
      graph.node({
        id: missingId, kind: 'record', ledger: 'experiment', slug, type: 'dangling_link', role: 'support',
        label: `run ${link.run_id || '(none)'}`, state: 'not_found', reason: 'a link references an experiment run that is not in runs.jsonl',
      })
      graph.edge({ from: id, to: missingId, relation: 'dangling_reference', ledger: 'experiment' })
    }
    if (resolved.id) graph.edge({ from: id, to: resolved.id, relation: 'links_to', ledger: 'experiment' })
  })

  return { slug: slugify(slug), counts: { runs: runs.length, links: links.length } }
}

/**
 * A link is valid only if both ends exist in their owner ledger. Missing ends
 * are reported, never inferred away.
 */
function resolveLinkTarget(graph, kind, id) {
  const value = text(id)
  if (!value) return { id: null, state: 'not_found', reason: 'the link recorded no target id' }
  const ids = graph.ids()
  const bySuffix = (prefixes) => ids.find((nodeIdValue) => nodeIdValue.endsWith(`/${value}`)
    && prefixes.some((prefix) => nodeIdValue.startsWith(prefix)))
  switch (kind) {
    case 'paper': {
      const direct = graph.has(paperNodeId(value)) ? paperNodeId(value) : null
      const loose = bySuffix(['paper:'])
      return direct || loose
        ? { id: direct || loose, state: 'supported', reason: 'both ends of the link exist in their own ledger' }
        : { id: null, state: 'not_found', reason: `no indexed ledger links a paper to "${value}"` }
    }
    case 'review': {
      const hit = bySuffix(['review:review/', 'record:review/'])
      return hit
        ? { id: hit, state: 'supported', reason: 'both ends of the link exist in their own ledger' }
        : { id: null, state: 'not_found', reason: `no indexed review ledger contains "${value}"` }
    }
    case 'notebook': {
      const hit = bySuffix(['claim:notebook/', 'result:notebook/', 'record:notebook/'])
      return hit
        ? { id: hit, state: 'supported', reason: 'both ends of the link exist in their own ledger' }
        : { id: null, state: 'not_found', reason: `no notebook entry in this workspace has id "${value}"` }
    }
    case 'analysis_run': {
      const hit = bySuffix(['run:analysis/'])
      return hit
        ? { id: hit, state: 'supported', reason: 'both ends of the link exist in their own ledger' }
        : { id: null, state: 'not_found', reason: `no indexed analysis run has id "${value}"` }
    }
    case 'experiment_run': {
      const hit = bySuffix(['run:experiment/'])
      return hit
        ? { id: hit, state: 'supported', reason: 'both ends of the link exist in their own ledger' }
        : { id: null, state: 'not_found', reason: `no indexed experiment run has id "${value}"` }
    }
    case 'scientific_result':
      return { id: null, state: 'unknown', reason: 'scientific_result cards are returned to the session and not persisted, so this link has no ledger end to resolve' }
    default:
      return { id: null, state: 'unknown', reason: `link target kind "${kind}" is not a ledger the audit indexes` }
  }
}

/* -------------------------------------------------------------------- dataset */

function readDatasetLedger(cwd, slug, graph) {
  const manifest = join(resolve(cwd), '.dsh', 'data', slugify(slug), 'manifest.jsonl')
  if (!existsSync(manifest)) throw new Error(`no dataset manifest under .dsh/data/${slugify(slug)}`)
  const events = readJsonl(manifest)
  const downloads = events.filter((event) => event.kind === 'download')
  if (!downloads.length) throw new Error('the dataset manifest records no download')

  for (const [index, event] of downloads.entries()) {
    const id = nodeId('record', 'dataset', slug, `ds${String(index + 1).padStart(4, '0')}`)
    const failed = (event.files || []).filter((file) => file.verification === 'verification_failed')
    graph.node({
      id, kind: 'record', ledger: 'dataset', slug, type: 'dataset_download', role: 'container',
      label: `${event.doi || event.landing_page || slugify(slug)} @${event.version || 'n.d.'}`,
      state: failed.length ? 'unverified' : 'not_checked',
      reason: failed.length
        ? `${failed.length} file(s) failed checksum verification and were kept for inspection`
        : 'container node — a download record with license and retrieval provenance',
      ts: event.ts ?? null,
      detail: { license: event.license ?? null, license_stated: event.license_stated ?? null, repository: event.repository ?? null, landing_page: event.landing_page ?? null },
    })
    for (const file of event.files || []) {
      if (!file?.path) {
        graph.node({
          id: nodeId('record', 'dataset', slug, `skipped~${file?.name || index}`), kind: 'record', ledger: 'dataset', slug,
          type: 'skipped_file', role: 'support', label: `${file?.name || '(unnamed)'}: ${file?.status || 'not downloaded'}`,
          state: 'not_found', reason: `the file was not downloaded (${clip(file?.status || 'no status', 120)})`,
        })
        graph.edge({ from: id, to: nodeId('record', 'dataset', slug, `skipped~${file?.name || index}`), relation: 'skipped_file', ledger: 'dataset' })
        continue
      }
      const fileId = addFileNode(graph, cwd, 'dataset', slug, file.path, file.sha256 || null, 'contains_file', id, { role: 'support' })
      if (file.verification === 'verification_failed') {
        graph.bump(fileId, { state: 'unverified', reason: 'the checksum stated by the source does not match the downloaded file' })
        graph.bump(id, { state: 'unverified', reason: 'one or more downloaded files failed checksum verification' })
      } else if (file.verification === 'verified') {
        graph.bump(fileId, { state: 'supported', reason: 'checksum verified when downloaded and the file still matches' })
      } else if (!file.source_checksum) {
        graph.bump(fileId, { state: 'not_checked', reason: 'the source supplied no checksum, so the recorded hash was never independently verified' })
      }
    }
    if (event.doi) addPaperNode(graph, 'dataset', slug, `doi:${event.doi}`, { relation: 'dataset_doi', fromId: id })
  }

  return { slug: slugify(slug), counts: { downloads: downloads.length, manifest_events: events.length } }
}

/* ----------------------------------------------------------------------- meta */

function readMetaLedger(cwd, slug, graph, { reviewSlugs }) {
  const dir = join(resolve(cwd), '.dsh', 'meta', slugify(slug))
  const protocol = readJson(join(dir, 'protocol.json'))
  if (!protocol) throw new Error(`no meta-analysis protocol under .dsh/meta/${slugify(slug)}`)
  const studies = readJsonl(join(dir, 'studies.jsonl'))
  const analyses = readJsonl(join(dir, 'analyses.jsonl'))
  const protocolId = nodeId('review', 'meta', slug, 'protocol')

  graph.node({
    id: protocolId, kind: 'review', ledger: 'meta', slug, type: 'meta_protocol', role: 'container',
    label: `${clip(protocol.question, 120) || slug}: ${protocol.outcome || 'outcome not recorded'} (${protocol.effect_measure}, ${protocol.model})`,
    state: 'not_checked', reason: 'container node — a write-once pooling protocol', ts: protocol.created_at ?? null,
  })

  const reviewRecordNodes = graph.nodes().filter((node) => node.ledger === 'review' && node.type === 'record')
  for (const study of studies) {
    const id = nodeId('record', 'meta', slug, String(study.id))
    const sourceRecord = text(study.meta?.record_id)
    graph.node({
      id, kind: 'record', ledger: 'meta', slug, type: 'meta_study', role: 'claim',
      label: `${study.id}: ${study.label || ''}`,
      state: sourceRecord ? 'supported' : 'no_link',
      reason: sourceRecord
        ? `imported from review record ${sourceRecord}`
        : 'study added directly with no recorded review or extraction provenance',
      detail: { effect: study.effect ?? null, se: study.se ?? null, n: study.n ?? null, rob: study.rob ?? null },
    })
    graph.edge({ from: id, to: protocolId, relation: 'pooled_in', ledger: 'meta' })
    if (sourceRecord) {
      const matches = reviewSlugs.length
        ? reviewRecordNodes.filter((node) => node.slug === slugify(reviewSlugs[0]) && node.id.endsWith(`/${sourceRecord}`))
        : []
      if (matches.length === 1) {
        graph.edge({ from: id, to: matches[0].id, relation: 'extracted_from', ledger: 'meta' })
      } else {
        const missingId = nodeId('record', 'meta', slug, `missing-record~${sourceRecord}`)
        graph.node({
          id: missingId, kind: 'record', ledger: 'meta', slug, type: 'dangling_link', role: 'support',
          label: `review record ${sourceRecord}`, state: 'not_found',
          reason: matches.length > 1
            ? `record id ${sourceRecord} is ambiguous across the indexed reviews; no provenance edge drawn`
            : `review record ${sourceRecord} is not in any indexed review`,
        })
        graph.edge({ from: id, to: missingId, relation: 'dangling_reference', ledger: 'meta' })
      }
    }
  }

  for (const analysis of analyses) {
    const id = nodeId('result', 'meta', slug, analysis.analysis_id)
    graph.node({
      id, kind: 'result', ledger: 'meta', slug, type: 'meta_analysis', role: 'support',
      label: `${analysis.kind} ${analysis.analysis_id} (k=${analysis.result?.k ?? '?'})`,
      state: 'supported', reason: `computed from ${studies.length} recorded stud(ies) under the frozen protocol`,
      ts: analysis.ts ?? null,
      detail: { pooled: analysis.result?.display_pooled ?? analysis.result?.pooled ?? null, i2: analysis.result?.heterogeneity?.i2 ?? null },
    })
    graph.edge({ from: id, to: protocolId, relation: 'follows_protocol', ledger: 'meta' })
    if (analysis.result?.plot) {
      addFileNode(graph, cwd, 'meta', slug, analysis.result.plot, null, 'plots', id, { role: 'support', type: 'plot' })
    }
  }

  return { slug: slugify(slug), effect_measure: protocol.effect_measure ?? null, counts: { studies: studies.length, analyses: analyses.length } }
}

/* ------------------------------------------------------------------------- AH */

function findAhProject(cwd) {
  const root = resolve(cwd)
  return existsSync(join(root, 'ah.yaml')) ? root : null
}

function ahClaimsDir(root) {
  try {
    const raw = readFileSync(join(root, 'ah.yaml'), 'utf8')
    const match = raw.match(/^claims_dir:\s*(\S+)\s*$/m)
    if (!match) return AH_DEFAULT_CLAIMS_DIR
    return match[1].replace(/^["']|["']$/g, '')
  } catch {
    return AH_DEFAULT_CLAIMS_DIR
  }
}

function passageFileHash(root, passage) {
  try {
    const abs = join(root, passage.file)
    if (!existsSync(abs)) return null
    return fileSha256(abs)
  } catch {
    return null
  }
}

function bindingStillMatches(root, passage) {
  const current = passageFileHash(root, passage)
  if (!current) return { state: 'not_found', reason: `the bound source file ${passage.file} is no longer readable` }
  if (passage.raw_sha256 && bare(passage.raw_sha256) !== bare(current)) {
    return { state: 'stale', reason: `the bound source file changed (recorded ${clip(passage.raw_sha256, 20)}, now ${clip(current, 20)})` }
  }
  if (passage.quote) {
    try {
      const body = normalizeForMatch(readFileSync(join(root, passage.file), 'utf8'))
      const needle = normalizeForMatch(passage.quote).slice(0, 200)
      if (needle && !body.includes(needle)) {
        return { state: 'stale', reason: 'the bound passage text is no longer found in the source file' }
      }
    } catch {
      return { state: 'not_found', reason: `the bound source file ${passage.file} could not be re-read` }
    }
  }
  return { state: 'supported', reason: 'bound to a source passage whose file hash and quote still match' }
}

function readAhLedger(cwd, graph, { parseYaml }) {
  const root = findAhProject(cwd)
  if (!root) throw new Error('this workspace has no ah.yaml project, so manuscript units and cited claims are unknown')
  if (!parseYaml) throw new Error('the YAML parser is unavailable, so AH claim sidecars were not read')
  const claimsDir = join(root, ahClaimsDir(root))
  if (!existsSync(claimsDir)) {
    throw new Error(`no claim sidecar directory at ${relative(root, claimsDir)}; run ah_claims_sync to create it`)
  }
  const files = readdirSync(claimsDir).filter((name) => name.endsWith('.yaml')).sort()
  if (!files.length) throw new Error(`the claim sidecar directory ${relative(root, claimsDir)} is empty; run ah_claims_sync`)

  const counts = { units: files.length, claims: 0, by_status: {} }
  for (const name of files) {
    let sidecar
    try {
      sidecar = parseYaml(readFileSync(join(claimsDir, name), 'utf8'))
    } catch (error) {
      throw new Error(`${name} is not a readable claim sidecar: ${clip(error.message, 160)}`)
    }
    const unit = text(sidecar?.unit) || name.replace(/\.yaml$/, '')
    const unitId = nodeId('unit', 'ah', 'project', unit)
    graph.node({
      id: unitId, kind: 'unit', ledger: 'ah', slug: 'project', type: 'ah_unit', role: 'container', label: unit,
      state: 'not_checked', reason: 'container node — a manuscript unit; who wrote it is reported by ah_provenance',
    })
    for (const claim of sidecar?.claims || []) {
      counts.claims += 1
      const status = text(claim.status) || 'unbound'
      counts.by_status[status] = (counts.by_status[status] || 0) + 1
      const id = nodeId('claim', 'ah', 'project', `${unit}~${claim.id}`)
      const bindings = Array.isArray(claim.bindings) ? claim.bindings : []
      const passage = bindings.find((binding) => binding?.type === 'passage')
      const fact = bindings.find((binding) => binding?.type === 'fact')
      let state
      if (status === 'stale') state = { state: 'stale', reason: 'the clause changed after it was bound; the binding no longer counts' }
      else if (status === 'verified') state = { state: 'supported', reason: `author-verified (${clip(claim.verified_by || 'verified_by not recorded', 60)})` }
      else if (status === 'bound' && passage) state = bindingStillMatches(root, passage)
      else if (status === 'bound' && fact) state = { state: 'supported', reason: `bound to fact ${fact.fact} (${clip(fact.token, 40)})` }
      else if (status === 'bound') state = { state: 'unverified', reason: 'recorded as bound but no binding is stored in the sidecar' }
      else state = { state: 'no_link', reason: 'cited clause has no recorded binding' }
      graph.node({
        id, kind: 'claim', ledger: 'ah', slug: 'project', type: 'manuscript_claim', role: 'claim', label: claim.clause,
        state: state.state, reason: state.reason,
        location: passage?.file ? clip(`${passage.file}:${passage.start}-${passage.end}`, 160) : null,
        quote: passage?.quote || null,
        hashes: passage?.raw_sha256 ? { recorded: passage.raw_sha256, current: passageFileHash(root, passage) } : null,
        detail: { claim_kind: claim.kind ?? null, cites: claim.cites ?? [], numbers: claim.numbers ?? [] },
      })
      graph.edge({ from: id, to: unitId, relation: 'in_unit', ledger: 'ah' })
      for (const key of claim.cites || []) {
        addPaperNode(graph, 'ah', 'project', `cite:${key}`, { relation: 'cites', fromId: id })
      }
      if (passage?.file) {
        const rel = relative(resolve(cwd), join(root, passage.file))
        const shown = rel.startsWith('..') ? passage.file : rel
        const fileId = fileNodeId(shown)
        graph.node({
          id: fileId, kind: 'export', ledger: 'ah', slug: 'project', type: 'source_file', role: 'support',
          label: shown, state: state.state, reason: `bound source: ${state.reason}`, path: shown,
          hashes: { recorded: passage.raw_sha256 ?? null, current: passageFileHash(root, passage) },
        })
        graph.edge({ from: id, to: fileId, relation: 'bound_to_source', ledger: 'ah' })
      }
      if (fact?.fact) {
        const factId = nodeId('record', 'ah', 'project', `fact~${fact.fact}`)
        graph.node({
          id: factId, kind: 'record', ledger: 'ah', slug: 'project', type: 'ah_fact', role: 'support',
          label: `fact ${fact.fact}`, state: 'not_checked',
          reason: 'the fact value is rendered from the project facts file; the audit does not recompute it',
        })
        graph.edge({ from: id, to: factId, relation: 'bound_to_fact', ledger: 'ah' })
      }
    }
  }
  return { slug: 'project', counts }
}

/* --------------------------------------------------------------- index build */

function listLedgers(cwd, subdir) {
  const dir = join(resolve(cwd), '.dsh', subdir)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}

function sourceEntry(ledger, slug, status, reason, stats = {}) {
  return { ledger, slug, status, reason: reason ?? null, ...stats }
}

function runLedger(ledger, slug, reader, graph) {
  const before = graph.size()
  try {
    const result = reader()
    return sourceEntry(ledger, result?.slug || slugify(slug), 'present', null, {
      counts: result?.counts ?? {},
      nodes: graph.size() - before,
    })
  } catch (error) {
    const reason = clip(error instanceof Error ? error.message : String(error), 300)
    return { ...sourceEntry(ledger, slugify(slug), 'unknown', reason, { nodes: graph.size() - before }), warning: reason }
  }
}

async function defaultQuoteVerifier(warnings) {
  let launch
  try {
    const { resolvePaperMemoryLaunch } = await import('./papermemory-cli.js')
    launch = resolvePaperMemoryLaunch()
  } catch {
    launch = null
  }
  if (!launch) {
    warnings.push('papermemory_unavailable: no PaperMemory CLI could be resolved, so stored quote-check statuses were used')
    return null
  }
  const { paperMemoryCall, mcpText } = await import('./papermemory-mcp.js')
  return async ({ paper, quote }) => {
    const result = await paperMemoryCall(launch, 'papermemory_quote_check', { quote, paper }, {
      clientName: 'academic-harness-provenance', timeoutMs: 90_000,
    })
    if (result?.isError) {
      const detail = (() => { try { return mcpText(result) } catch { return {} } })()
      return { status: 'unverified', detail: detail?.error || detail?.code || 'quote check failed' }
    }
    const payload = mcpText(result)
    const occurrences = Array.isArray(payload?.occurrences) ? payload.occurrences : []
    if (payload?.found === true) {
      const bibliographyOnly = payload.reason === 'bibliography-only'
        || (occurrences.length > 0 && occurrences.every((entry) => Number(entry.is_bibliography) === 1))
      if (bibliographyOnly) return { status: 'unverified', detail: 'the quote only occurs in the bibliography' }
      if (!occurrences.length) return { status: 'unverified', detail: 'found:true without a resolved occurrence' }
      return { status: 'verified', detail: 'found', checked_against: payload.checked_against ?? null }
    }
    if (payload?.found === false && payload?.checked_against?.sha256 != null) {
      return { status: 'not_found', detail: payload.reason || 'not found in the resolved paper', checked_against: payload.checked_against }
    }
    return { status: 'unverified', detail: payload?.reason || 'PaperMemory could not resolve the paper' }
  }
}

async function reverifyQuotes(graph, deps, warnings) {
  const edges = graph.edges()
  const claimsForQuote = new Map()
  const touched = new Set()
  for (const edge of edges) {
    if (edge.relation !== 'supported_by') continue
    if (!claimsForQuote.has(edge.to)) claimsForQuote.set(edge.to, [])
    claimsForQuote.get(edge.to).push(edge.from)
  }
  const byId = new Map(graph.nodes().map((node) => [node.id, node]))
  for (const node of graph.nodes()) {
    if (node.kind !== 'quote' || !node.paper) continue
    const quote = node.quote || node.label
    let result
    try {
      result = await deps.verifyQuote({ paper: node.paper, quote })
    } catch (error) {
      warnings.push(`papermemory_quote_check failed for ${node.id}: ${clip(error instanceof Error ? error.message : String(error), 160)}`)
      continue
    }
    if (!result?.status) continue
    const status = result.status
    if (status === 'verified') {
      const recorded = bare(node.hashes?.recorded)
      const now = bare(result.checked_against?.sha256)
      if (recorded && now && recorded !== now) {
        node.state = 'stale'
        node.reason = `the quote is found again, but in a different source snapshot (${clip(result.checked_against.sha256, 20)})`
      } else {
        node.state = 'supported'
        node.reason = 're-verified through papermemory_quote_check during this index'
      }
      if (now) node.hashes = { ...(node.hashes || {}), current: `sha256:${now}` }
    } else if (status === 'not_found') {
      node.state = 'not_found'
      node.reason = clip(`papermemory_quote_check no longer finds this quote (${result.detail || 'no reason given'})`)
    } else {
      node.state = 'unverified'
      node.reason = clip(result.detail || 'papermemory_quote_check did not confirm the quote')
    }
    for (const claimId of claimsForQuote.get(node.id) || []) touched.add(claimId)
  }
  // A claim is only as well supported as the weakest quote supporting it.
  const quotesForClaim = new Map()
  for (const [quoteId, claimIds] of claimsForQuote) {
    const quote = byId.get(quoteId)
    if (!quote) continue
    for (const claimId of claimIds) {
      if (!quotesForClaim.has(claimId)) quotesForClaim.set(claimId, [])
      quotesForClaim.get(claimId).push(quote)
    }
  }
  for (const claimId of touched) {
    const claim = byId.get(claimId)
    const quotes = quotesForClaim.get(claimId) || []
    if (!claim || !quotes.length) continue
    const worst = quotes.reduce(
      (current, quote) => (!current || STATE_RANK[quote.state] > STATE_RANK[current.state] ? quote : current),
      null,
    )
    if (!worst) continue
    claim.state = worst.state
    claim.reason = `its recorded quote: ${worst.reason}`
  }
}

/** Claims that rest on a changed or missing source file inherit the change. */
function propagateStale(graph) {
  const reverse = new Map()
  for (const edge of graph.edges()) {
    if (!reverse.has(edge.to)) reverse.set(edge.to, [])
    reverse.get(edge.to).push(edge.from)
  }
  const byId = new Map(graph.nodes().map((node) => [node.id, node]))
  const sources = graph.nodes().filter((node) => ['file', 'manuscript', 'source_file'].includes(node.type)
    && ['stale', 'not_found'].includes(node.state))
  const marked = []
  for (const source of sources) {
    const queue = [{ id: source.id, depth: 0 }]
    const seen = new Set([source.id])
    while (queue.length) {
      const current = queue.shift()
      if (current.depth >= MAX_DEPTH) continue
      for (const dependent of reverse.get(current.id) || []) {
        if (seen.has(dependent)) continue
        seen.add(dependent)
        const node = byId.get(dependent)
        queue.push({ id: dependent, depth: current.depth + 1 })
        if (!node || node.role !== 'claim' || node.state === 'stale' || node.state === 'not_found') continue
        marked.push({ id: node.id, from: source.id, path: source.path || source.label })
        node.previous_state = node.state
        node.state = 'stale'
        node.reason = `depends on ${source.path || source.label}, which ${source.reason}`
      }
    }
  }
  return marked
}

export async function buildProvenanceIndex({ cwd, slug = 'default', selection = {}, deps = {} } = {}) {
  const audit = provenanceSlug(slug)
  const f = auditFiles(cwd, audit)
  const graph = makeGraph()
  const warnings = []
  const sources = []

  const pick = (key) => {
    const value = selection[key]
    if (value == null || value === '') return null
    const list = (Array.isArray(value) ? value : [value]).map(text).filter(Boolean)
    return list.length ? list : null
  }
  const discover = (subdir, key, ledger) => {
    const wanted = pick(key)
    const found = listLedgers(cwd, subdir)
    if (!wanted) return found
    for (const entry of wanted) {
      if (found.includes(slugify(entry))) continue
      const reason = `no ${ledger} ledger named "${entry}" under .dsh/${subdir}`
      warnings.push(reason)
      sources.push(sourceEntry(ledger, slugify(entry), 'unknown', reason, { nodes: 0 }))
    }
    return found.filter((entry) => wanted.some((want) => slugify(want) === entry))
  }

  const requested = (key) => {
    const value = pick(key)
    return value ? value.map((entry) => slugify(entry)) : null
  }
  const requestedSelection = {
    review: requested('review'),
    reporting: requested('reporting'),
    meta: requested('meta'),
    analysis: requested('analysis'),
    experiment: requested('experiment'),
    dataset: requested('dataset'),
    deep_review: requested('deep_review'),
    manuscript: text(selection.manuscript) || null,
    ah: selection.ah !== false,
    verify_quotes: Boolean(selection.verify_quotes),
  }

  const reviewSlugs = discover('review', 'review', 'review')
  const reportingSlugs = discover('reporting', 'reporting', 'reporting')
  const metaSlugs = discover('meta', 'meta', 'meta')
  const analysisSlugs = discover('analysis', 'analysis', 'analysis')
  const experimentSlugs = discover('experiments', 'experiment', 'experiment')
  const dataSlugs = discover('data', 'dataset', 'dataset')

  const collect = (result) => {
    if (result.warning) warnings.push(`${result.ledger}:${result.slug}: ${result.warning}`)
    sources.push(result)
  }

  for (const entry of reviewSlugs) collect(runLedger('review', entry, () => readReviewLedger(cwd, entry, graph), graph))
  for (const entry of reportingSlugs) collect(runLedger('reporting', entry, () => readReportingLedger(cwd, entry, graph), graph))

  const deepDirs = listLedgers(cwd, 'deep-review')
  const wantedDeep = pick('deep_review') || deepDirs
  for (const entry of wantedDeep) {
    if (deepDirs.includes(entry)) {
      collect(runLedger('deep_review', entry, () => readDeepReviewLedger(cwd, entry, graph), graph))
      continue
    }
    const reason = `no stored deep review under .dsh/deep-review/${entry}`
    warnings.push(reason)
    sources.push(sourceEntry('deep_review', entry, 'unknown', reason, { nodes: 0 }))
  }

  collect(runLedger('notebook', 'sessions', () => readNotebookLedger(cwd, graph), graph))
  for (const entry of metaSlugs) collect(runLedger('meta', entry, () => readMetaLedger(cwd, entry, graph, { reviewSlugs }), graph))
  for (const entry of analysisSlugs) collect(runLedger('analysis', entry, () => readAnalysisLedger(cwd, entry, graph), graph))
  for (const entry of experimentSlugs) collect(runLedger('experiment', entry, () => readExperimentLedger(cwd, entry, graph), graph))
  for (const entry of dataSlugs) collect(runLedger('dataset', entry, () => readDatasetLedger(cwd, entry, graph), graph))

  if (selection.ah === false) {
    sources.push(sourceEntry('ah', 'project', 'skipped', 'excluded by the audit selection', { nodes: 0 }))
  } else {
    let parseYaml = deps.parseYaml || null
    if (!parseYaml) {
      try {
        const module = await import('yaml')
        parseYaml = module.parse
      } catch {
        parseYaml = null
      }
    }
    collect(runLedger('ah', 'project', () => readAhLedger(cwd, graph, { parseYaml }), graph))
  }

  sources.push(sourceEntry('preregister', 'workspace', 'unknown',
    existsSync(join(resolve(cwd), '.dsh', 'prereg'))
      ? 'a preregistration directory exists, but this release does not read it'
      : 'the preregister ledger (Phase 5A) has not shipped, so no preregistration is indexed', { nodes: 0 }))
  sources.push(sourceEntry('scientific_result', 'session', 'unknown',
    'result cards are returned to the session and are not persisted; link a finding through notebook entries or analysis runs', { nodes: 0 }))

  let verifyQuote = deps.verifyQuote || null
  if (!verifyQuote && selection.verify_quotes) verifyQuote = await defaultQuoteVerifier(warnings)
  if (verifyQuote) {
    await reverifyQuotes(graph, { verifyQuote }, warnings)
    sources.push(sourceEntry('papermemory', 'library', 'queried',
      'stored quote links were re-checked through papermemory_quote_check', { nodes: graph.nodes().filter((node) => node.kind === 'paper').length }))
  } else {
    sources.push(sourceEntry('papermemory', 'library', 'not_queried',
      'live PaperMemory verification is off; stored quote-check statuses were used', { nodes: graph.nodes().filter((node) => node.kind === 'paper').length }))
  }

  if (selection.manuscript) {
    const state = fileState(cwd, selection.manuscript, null)
    graph.node({
      id: fileNodeId(selection.manuscript), kind: 'export', ledger: 'manuscript', slug: 'workspace',
      type: 'manuscript', role: 'container', label: selection.manuscript,
      state: state.state === 'not_checked' ? 'not_checked' : state.state,
      reason: state.state === 'not_checked'
        ? 'the manuscript is readable, but no ledger snapshot was recorded to compare it against'
        : state.reason,
      path: selection.manuscript, hashes: state.hashes,
    })
  }

  const staleRipple = propagateStale(graph)
  for (const note of graph.notes) warnings.push(note)

  const nodes = graph.nodes()
  const edges = graph.edges()
  const totals = totalsOf(nodes, edges)
  const index = {
    schema_version: PROVENANCE_SCHEMA_VERSION,
    tool: 'provenance_audit',
    audit,
    created_at: nowIso(),
    selection: requestedSelection,
    discovered: {
      review: reviewSlugs,
      reporting: reportingSlugs,
      meta: metaSlugs,
      analysis: analysisSlugs,
      experiment: experimentSlugs,
      dataset: dataSlugs,
      deep_review: wantedDeep.map((entry) => entry.key),
    },
    index_hash: `sha256:${sha256(stableStringify({ audit, nodes, edges }))}`,
    sources,
    counts: totals,
    nodes,
    edges,
    warnings,
    stale_from_changed_sources: staleRipple,
  }

  ensureDir(f.dir)
  await withLock(f.dir, () => {
    const target = assertAuditWrite(cwd, audit, f.index)
    exportText(target, `${JSON.stringify(index, null, 2)}\n`, { overwrite: true })
    return target
  }, { label: 'provenance audit cache' })

  return index
}

/* -------------------------------------------------------------------- queries */

function totalsOf(nodes, edges) {
  const totals = { nodes: nodes.length, edges: edges.length, claims: 0, supported: 0, by_state: {} }
  for (const state of AUDIT_STATES) totals.by_state[state] = 0
  for (const node of nodes) {
    totals.by_state[node.state] = (totals.by_state[node.state] || 0) + 1
    if (node.role === 'claim') {
      totals.claims += 1
      if (node.state === 'supported') totals.supported += 1
    }
  }
  return totals
}

export function coverageOf(index) {
  const perLedger = new Map()
  for (const node of index.nodes) {
    if (!perLedger.has(node.ledger)) perLedger.set(node.ledger, { ledger: node.ledger, nodes: 0, claims: 0, by_state: {} })
    const entry = perLedger.get(node.ledger)
    entry.nodes += 1
    if (node.role === 'claim') entry.claims += 1
    entry.by_state[node.state] = (entry.by_state[node.state] || 0) + 1
  }
  return {
    audit: index.audit,
    index_hash: index.index_hash,
    created_at: index.created_at,
    totals: totalsOf(index.nodes, index.edges),
    ledgers: [...perLedger.values()].sort((a, b) => a.ledger.localeCompare(b.ledger)),
    sources: index.sources,
    warnings: index.warnings,
  }
}

function claimsIn(index, states) {
  return index.nodes.filter((node) => node.role === 'claim' && (!states || states.includes(node.state)))
}

export function unsupportedOf(index, { state = null, limit = 50 } = {}) {
  let wanted = UNSUPPORTED_STATES
  if (state) {
    if (!AUDIT_STATES.includes(state)) throw new Error(`state must be one of ${AUDIT_STATES.join(', ')}`)
    if (!UNSUPPORTED_STATES.includes(state)) throw new Error(`"${state}" is not an unsupported state; expected one of ${UNSUPPORTED_STATES.join(', ')}`)
    wanted = [state]
  }
  const capped = Math.max(1, Math.min(Number(limit) || 50, 500))
  const nodes = claimsIn(index, wanted)
  const by_state = {}
  for (const entry of wanted) by_state[entry] = nodes.filter((node) => node.state === entry).length
  return {
    audit: index.audit,
    claims: claimsIn(index, null).length,
    supported: claimsIn(index, ['supported']).length,
    unsupported: nodes.length,
    by_state,
    items: nodes.slice(0, capped).map(describe),
    truncated: Math.max(0, nodes.length - capped),
  }
}

export function staleOf(index, { limit = 100 } = {}) {
  const capped = Math.max(1, Math.min(Number(limit) || 100, 500))
  const nodes = index.nodes.filter((node) => node.state === 'stale')
  return {
    audit: index.audit,
    stale: nodes.length,
    from_changed_sources: (index.stale_from_changed_sources || []).length,
    items: nodes.slice(0, capped).map((node) => ({
      ...describe(node),
      previous_state: node.previous_state ?? null,
      hashes: node.hashes ? { recorded: node.hashes.recorded ?? null, current: node.hashes.current ?? null } : null,
    })),
  }
}

export function unverifiedOf(index, { limit = 100 } = {}) {
  const capped = Math.max(1, Math.min(Number(limit) || 100, 500))
  const nodes = index.nodes.filter((node) => node.state === 'unverified')
  return {
    audit: index.audit,
    unverified: nodes.length,
    items: nodes.slice(0, capped).map(describe),
    truncated: Math.max(0, nodes.length - capped),
  }
}

export function impactOf(index, target, { limit = 100 } = {}) {
  const wanted = text(target)
  if (!wanted) throw new Error('impact requires a target id (for example paper:..., quote:..., export:<path>, run:...)')
  const matches = index.nodes.filter((node) => node.id === wanted
    || node.id.endsWith(`:${wanted}`)
    || node.label === wanted
    || node.path === wanted)
  if (!matches.length) {
    throw new Error(`"${wanted}" is not in the index; run action "index" for this workspace and pass an id from its node list`)
  }
  const reverse = new Map()
  for (const edge of index.edges) {
    if (!reverse.has(edge.to)) reverse.set(edge.to, [])
    reverse.get(edge.to).push(edge.from)
  }
  const byId = new Map(index.nodes.map((node) => [node.id, node]))
  const seen = new Map()
  const queue = []
  for (const node of matches) {
    seen.set(node.id, { depth: 0, via: null, node })
    queue.push({ id: node.id, depth: 0 })
  }
  while (queue.length) {
    const current = queue.shift()
    if (current.depth >= MAX_DEPTH * 2) continue
    for (const dependent of reverse.get(current.id) || []) {
      if (seen.has(dependent)) continue
      const node = byId.get(dependent)
      if (!node) continue
      seen.set(dependent, { depth: current.depth + 1, via: current.id, node })
      queue.push({ id: dependent, depth: current.depth + 1 })
    }
  }
  const capped = Math.max(1, Math.min(Number(limit) || 100, 500))
  const dependents = [...seen.values()]
    .filter((entry) => entry.depth > 0)
    .sort((a, b) => a.depth - b.depth || a.node.ledger.localeCompare(b.node.ledger) || a.node.id.localeCompare(b.node.id))
  return {
    audit: index.audit,
    target: matches[0].id,
    matched: matches.map((node) => node.id),
    dependents: dependents.slice(0, capped).map((entry) => ({ ...describe(entry.node), depth: entry.depth, via: entry.via })),
    truncated: Math.max(0, dependents.length - capped),
    note: 'Dependents are ledger records that reference this id. The audit does not decide whether the reference still holds the claim up.',
  }
}

function describe(node) {
  return {
    id: node.id,
    ledger: node.ledger,
    slug: node.slug,
    type: node.type,
    role: node.role,
    label: node.label,
    state: node.state,
    reason: node.reason,
    reviewer: node.reviewer ?? null,
    location: node.location ?? null,
    paper: node.paper ?? null,
    path: node.path ?? null,
    ts: node.ts ?? null,
  }
}

/* -------------------------------------------------------------------- exports */

function markdownReport(index, coverage) {
  const lines = [
    `# Provenance audit: ${index.audit}`,
    '',
    `Indexed ${coverage.totals.nodes} nodes and ${coverage.totals.edges} edges from ${index.sources.filter((entry) => entry.status === 'present').length} readable ledger(s) at \`${index.created_at}\`.`,
    `Index hash \`${clip(index.index_hash, 26)}\`. Read-only: no source ledger was modified.`,
    '',
    '## Coverage',
    '',
    `| Ledger | Nodes | Claims | ${AUDIT_STATES.join(' | ')} |`,
    `|---|---|---|${AUDIT_STATES.map(() => '---').join('|')}|`,
    ...coverage.ledgers.map((entry) => `| ${entry.ledger} | ${entry.nodes} | ${entry.claims} | ${AUDIT_STATES.map((state) => entry.by_state[state] || 0).join(' | ')} |`),
    '',
    '## Ledger availability',
    '',
    ...index.sources.map((entry) => `- \`${entry.ledger}:${entry.slug}\` — ${entry.status}${entry.reason ? `: ${mdCell(entry.reason)}` : ''}`),
    '',
    '## Claims without verified support',
    '',
  ]
  const unsupported = unsupportedOf(index, { limit: 200 })
  if (!unsupported.items.length) {
    lines.push('Every indexed claim has a stored verification or a recorded human signature. That is a statement about recorded links, not about scientific correctness.', '')
  } else {
    lines.push('| Claim | Ledger | State | Why |', '|---|---|---|---|')
    for (const item of unsupported.items) {
      lines.push(`| ${mdCell(item.label)} | ${item.ledger} | ${item.state} | ${mdCell(item.reason || '')} |`)
    }
    if (unsupported.truncated) lines.push('', `_${unsupported.truncated} more not shown._`, '')
  }
  const stale = staleOf(index, { limit: 100 })
  lines.push('## Stale evidence', '')
  if (!stale.items.length) lines.push('Nothing indexed depends on a source that changed since it was recorded.', '')
  else {
    lines.push('| Node | Ledger | Recorded hash | Current hash | Why |', '|---|---|---|---|---|')
    for (const item of stale.items) {
      lines.push(`| ${mdCell(item.label)} | ${item.ledger} | ${mdCell(item.hashes?.recorded || '')} | ${mdCell(item.hashes?.current || '')} | ${mdCell(item.reason || '')} |`)
    }
    lines.push('')
  }
  const unverified = unverifiedOf(index, { limit: 100 })
  lines.push('## Unverified evidence', '')
  if (!unverified.items.length) lines.push('Nothing indexed carries a verification attempt that failed to confirm it.', '')
  else {
    lines.push('| Node | Ledger | Why |', '|---|---|---|')
    for (const item of unverified.items) lines.push(`| ${mdCell(item.label)} | ${item.ledger} | ${mdCell(item.reason || '')} |`)
    lines.push('')
  }
  lines.push(
    '## Warnings',
    '',
    ...(index.warnings.length ? index.warnings.map((warning) => `- ${mdCell(warning)}`) : ['- none']),
    '',
    'This index joins existing ledgers by the ids and hashes they already store. It never infers support from co-occurrence or citation proximity, reports a missing ledger as `unknown`, and treats a graph export as a view rather than a database.',
    '',
  )
  return lines.join('\n')
}

function csvReport(index) {
  const header = ['node_id', 'kind', 'ledger', 'slug', 'type', 'role', 'label', 'state', 'reason', 'reviewer', 'location', 'paper', 'path', 'recorded_hash', 'current_hash', 'ts']
  const lines = [header.map(csvCell).join(',')]
  for (const node of index.nodes) {
    lines.push([
      node.id, node.kind, node.ledger, node.slug, node.type, node.role, node.label, node.state, node.reason,
      node.reviewer, node.location, node.paper, node.path, node.hashes?.recorded ?? '', node.hashes?.current ?? '', node.ts,
    ].map(csvCell).join(','))
  }
  return `${lines.join('\n')}\n`
}

function graphmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function graphmlReport(index) {
  const keys = ['kind', 'ledger', 'slug', 'type', 'role', 'label', 'state', 'reason']
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    ...keys.map((key) => `  <key id="${key}" for="node" attr.name="${key}" attr.type="string"/>`),
    '  <key id="relation" for="edge" attr.name="relation" attr.type="string"/>',
    `  <graph id="${graphmlEscape(index.audit)}" edgedefault="directed">`,
  ]
  for (const node of index.nodes) {
    lines.push(`    <node id="${graphmlEscape(node.id)}">`)
    for (const key of keys) {
      const value = node[key]
      if (value == null || value === '') continue
      lines.push(`      <data key="${key}">${graphmlEscape(value)}</data>`)
    }
    lines.push('    </node>')
  }
  index.edges.forEach((edge, position) => {
    lines.push(`    <edge id="e${position}" source="${graphmlEscape(edge.from)}" target="${graphmlEscape(edge.to)}">`)
    lines.push(`      <data key="relation">${graphmlEscape(edge.relation)}</data>`)
    lines.push('    </edge>')
  })
  lines.push('  </graph>', '</graphml>', '')
  return lines.join('\n')
}

const MERMAID_UNSAFE = /[^A-Za-z0-9_\-:.~ ]/g

function mermaidReport(index) {
  const alias = new Map()
  const nameFor = (id) => {
    if (!alias.has(id)) alias.set(id, `n${alias.size}`)
    return alias.get(id)
  }
  const lines = ['---', `title: provenance audit ${index.audit}`, '---', 'graph LR']
  for (const node of index.nodes) {
    const label = `${node.state} | ${node.label}`.replace(MERMAID_UNSAFE, ' ').slice(0, 120).trim()
    lines.push(`  ${nameFor(node.id)}["${label}"]`)
  }
  for (const edge of index.edges) {
    lines.push(`  ${nameFor(edge.from)} -->|${String(edge.relation).replace(MERMAID_UNSAFE, '_')}| ${nameFor(edge.to)}`)
  }
  lines.push('')
  return lines.join('\n')
}

export function exportProvenance({ cwd, slug = 'default', index, format = 'markdown', overwrite = false }) {
  const wanted = text(format).toLowerCase()
  if (!PROVENANCE_EXPORT_FORMATS.includes(wanted)) {
    throw new Error(`format must be one of ${PROVENANCE_EXPORT_FORMATS.join(', ')}`)
  }
  const audit = provenanceSlug(slug)
  let name
  let body
  if (wanted === 'csv') {
    name = 'provenance.csv'
    body = csvReport(index)
  } else if (wanted === 'json') {
    name = 'provenance.json'
    body = `${JSON.stringify(index, null, 2)}\n`
  } else if (wanted === 'graphml') {
    name = 'provenance.graphml'
    body = graphmlReport(index)
  } else if (wanted === 'mermaid') {
    name = 'provenance.mmd'
    body = mermaidReport(index)
  } else {
    name = 'provenance.md'
    body = markdownReport(index, coverageOf(index))
  }
  const { written, path } = writeAuditExport({ cwd, slug: audit, name, body, overwrite })
  return {
    format: wanted,
    path: relative(resolve(cwd), path),
    bytes: written.bytes,
    audit,
    index_hash: index.index_hash,
    nodes: index.nodes.length,
    edges: index.edges.length,
  }
}
