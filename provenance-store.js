/**
 * Read-only cross-ledger provenance index.
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
import { listAblationRecords, listAblationVerdicts, statusAblation } from './ablation-store.js'
import { deriveState, limitationStatus, tournamentSlug } from './coscientist-store.js'
import { paramsReference } from './coscientist-trace.js'

export const AUDIT_STATES = [
  'supported', 'no_link', 'not_checked', 'unverified', 'stale', 'not_found',
  'spec_drift', 'no_attribution', 'rerun_mismatch', 'verdict_missing', 'unknown',
]
export const UNSUPPORTED_STATES = [
  'no_link', 'not_checked', 'unverified', 'stale', 'not_found',
  'spec_drift', 'no_attribution', 'rerun_mismatch', 'verdict_missing',
]
export const PROVENANCE_ACTIONS = ['index', 'coverage', 'unsupported', 'stale', 'unverified', 'impact', 'arms', 'rollup', 'export']
export const PROVENANCE_EXPORT_FORMATS = ['markdown', 'csv', 'json', 'graphml', 'mermaid']

const STATE_RANK = {
  supported: 0, not_checked: 1, no_link: 2, unverified: 3, not_found: 4,
  stale: 5, spec_drift: 6, no_attribution: 7, rerun_mismatch: 8, verdict_missing: 9, unknown: 10,
}
const CLIP = 220
const MAX_NODES = 20_000
const MAX_DEPTH = 4
const AH_DEFAULT_CLAIMS_DIR = 'claims'
const CODE_EXTENSIONS = new Set([
  '.py', '.pyx', '.r', '.jl', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs',
  '.java', '.kt', '.scala', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.cu', '.cuh',
  '.sql', '.sh', '.bash', '.yaml', '.yml', '.toml', '.json', '.cfg', '.ini',
])
const MANUSCRIPT_EXTENSIONS = new Set(['.tex', '.md', '.markdown', '.qmd', '.rmd', '.txt', '.rst'])

function bindingKind(file) {
  const name = String(file ?? '').toLowerCase()
  if (!name) return null
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  const ext = name.slice(dot)
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  if (MANUSCRIPT_EXTENSIONS.has(ext)) return 'manuscript'
  return 'other'
}

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

/** Optional Phase 8 ledger files: a malformed one is a warning, not a dead ledger. */
function optionalJsonl(file, graph, label) {
  try {
    return readJsonl(file)
  } catch (error) {
    graph.notes.push(`${label} could not be read: ${clip(error instanceof Error ? error.message : String(error), 220)}`)
    return []
  }
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

  const citationReports = Array.isArray(reports) ? reports : []
  const citationOk = citationReports.filter((report) => ['OK', 'VERIFIED_BY_SEARCH'].includes(report?.finalVerdict)).length
  const citationSkipped = citationReports.filter((report) => report?.finalVerdict === 'SKIPPED').length
  const extra = readJson(join(dir, 'extra_checks.json'))
  const validityChecks = Array.isArray(extra?.checks) ? extra.checks : []
  for (const check of validityChecks) {
    if (check?.state === 'clear' || !check?.id) continue
    const id = nodeId('claim', 'deep_review', key, `validity-${check.id}`)
    graph.node({
      id, kind: 'claim', ledger: 'deep_review', slug: key, type: 'validity_check', role: 'claim',
      label: `${check.id}${check.label ? `: ${check.label}` : ''}`,
      state: check.state === 'flagged' ? 'unverified' : 'not_checked',
      reason: check.state === 'flagged'
        ? clip(`the automated validity reading flagged this check: ${check.reason || 'no reason recorded'}`, 240)
        : clip(`the automated validity reading could not check this: ${check.reason || 'no reason recorded'}`, 240),
      detail: { state: check.state, tallies: check.tallies ?? null },
    })
    graph.edge({ from: id, to: checkId, relation: 'validity_read', ledger: 'deep_review' })
  }

  return {
    slug: key,
    manuscript: { path: input.path ?? null, state: manuscriptState.state },
    counts: {
      claims: claims.length,
      flagged_citations: flagged.length,
      citations: {
        total: citationReports.length,
        ok: citationOk,
        skipped: citationSkipped,
        flagged: flagged.length,
      },
      validity: {
        checks: validityChecks.length,
        flagged: validityChecks.filter((check) => check?.state === 'flagged').length,
        not_checked: validityChecks.filter((check) => check?.state === 'not_checked').length,
      },
    },
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

  const expectations = optionalJsonl(join(dir, 'expectations.jsonl'), graph, 'analysis expectations')
  const verifications = optionalJsonl(join(dir, 'verifications.jsonl'), graph, 'analysis verifications')
  const complianceEvents = optionalJsonl(join(dir, 'compliance.jsonl'), graph, 'analysis compliance')
  const latestVerification = new Map()
  for (const verification of verifications) latestVerification.set(verification.expectation_id, verification)
  const latestCompliance = new Map()
  for (const event of complianceEvents) latestCompliance.set(event.run_id, event)
  const stickyViolated = new Set(complianceEvents.filter((event) => event.verdict === 'violated').map((event) => event.run_id))

  // Every declared expectation is indexed, not only the latest. Re-declaring the
  // numbers must not launder a recorded non-reproduction out of the record: the
  // failed verification stays durable in verifications.jsonl and visible here,
  // exactly as a past compliance violation stays sticky.
  for (const expectation of expectations) {
    const id = nodeId('claim', 'analysis', slug, `expectation-${expectation.expectation_id}`)
    const verification = latestVerification.get(expectation.expectation_id)
    const state = !verification
      ? { state: 'not_checked', reason: `declared ${expectation.metrics.length} reported value(s) but never verified` }
      : verification.reproduction === true
        ? { state: 'supported', reason: `reported values reproduced in run ${verification.run_id} (${verification.counts?.match ?? 0} matched)` }
        : verification.reproduction === false
          ? { state: 'rerun_mismatch', reason: `re-execution ${verification.run_id} did not reproduce ${verification.counts?.mismatch ?? 0} reported value(s): ${clip(verification.reason, 180)}` }
          : { state: 'not_checked', reason: clip(verification.reason || 'the re-execution could not check the reported values') }
    graph.node({
      id, kind: 'claim', ledger: 'analysis', slug, type: 'analysis_expectation', role: 'claim',
      label: `expectation ${expectation.expectation_id}: ${expectation.metrics.map((metric) => metric.name).join(', ')}`,
      state: state.state, reason: state.reason, ts: expectation.created_at ?? null,
      detail: {
        reference: expectation.reference,
        metrics: expectation.metrics.map((metric) => ({ name: metric.name, value: metric.value })),
        verification_run_id: verification?.run_id ?? null,
        counts: verification?.counts ?? null,
      },
    })
    const planId = nodeId('record', 'analysis', slug, `plan-v${expectation.plan_version}`)
    if (graph.has(planId)) graph.edge({ from: id, to: planId, relation: 'declared_on', ledger: 'analysis' })
    if (verification) {
      const runId = nodeId('run', 'analysis', slug, verification.run_id)
      if (graph.has(runId)) graph.edge({ from: id, to: runId, relation: 'checked_by', ledger: 'analysis' })
    }
  }

  for (const event of latestCompliance.values()) {
    const id = nodeId('claim', 'analysis', slug, `compliance-${event.run_id}`)
    const sticky = stickyViolated.has(event.run_id)
    const state = event.verdict === 'violated'
      ? { state: 'unverified', reason: `run violated ${event.counts?.violated ?? 0} frozen task rule(s): ${(event.rules || []).filter((rule) => rule.status === 'violated').map((rule) => rule.rule_id).join(', ')}` }
      : sticky
        ? { state: 'unverified', reason: `a recorded compliance violation keeps this run discarded (latest reading: ${event.verdict})` }
        : event.verdict === 'compliant'
          ? { state: 'supported', reason: `all ${event.rules.length} frozen task rule(s) were satisfied` }
          : { state: 'not_checked', reason: `task-rule compliance could not be decided (${event.counts?.not_checked ?? 0} rule(s) unchecked)` }
    graph.node({
      id, kind: 'claim', ledger: 'analysis', slug, type: 'analysis_compliance', role: 'claim',
      label: `compliance ${event.compliance_id ?? ''} for run ${event.run_id}`,
      state: state.state, reason: state.reason, ts: event.ts ?? null,
      detail: { verdict: event.verdict, counts: event.counts ?? null, rules: (event.rules || []).map((rule) => ({ id: rule.rule_id, status: rule.status })) },
    })
    const runId = nodeId('run', 'analysis', slug, event.run_id)
    if (graph.has(runId)) {
      graph.edge({ from: id, to: runId, relation: 'checked_run', ledger: 'analysis' })
      if (sticky) {
        const lastViolation = [...complianceEvents].reverse().find((entry) => entry.run_id === event.run_id && entry.verdict === 'violated')
        graph.bump(runId, {
          state: 'unverified',
          reason: `a recorded compliance violation ${lastViolation?.compliance_id ?? ''} keeps this run excluded: ${(lastViolation?.rules || []).filter((rule) => rule.status === 'violated').map((rule) => rule.rule_id).join(', ')}`,
        })
      }
    }
  }

  return {
    slug: slugify(slug),
    counts: {
      plans: plans.length, runs: runs.length, latest_plan: plans.at(-1)?.version ?? null,
      expectations: expectations.length, verifications: verifications.length,
      compliance: latestCompliance.size,
      compliance_violated: stickyViolated.size,
    },
  }
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
    if (run.spec_drift?.state === 'drift') {
      const driftId = nodeId('claim', 'experiment', slug, `spec-drift-${run.run_id}`)
      const changed = Array.isArray(run.spec_drift.changed) && run.spec_drift.changed.length
        ? run.spec_drift.changed.join(', ')
        : 'protocol digest'
      graph.node({
        id: driftId, kind: 'claim', ledger: 'experiment', slug, type: 'spec_drift', role: 'claim',
        label: `${run.run_id}: evaluation protocol drift`,
        state: 'spec_drift',
        reason: `protocol changed against baseline ${run.spec_drift.baseline_run_id ?? '(unknown)'}: ${changed}`,
        ts: run.ts ?? null,
        detail: { expected_digest: run.spec_drift.expected_digest ?? null, actual_digest: run.spec_drift.actual_digest ?? null, changed: run.spec_drift.changed ?? [] },
      })
      graph.edge({ from: driftId, to: id, relation: 'observed_in', ledger: 'experiment' })
      graph.edge({ from: driftId, to: containerId, relation: 'drifted_in', ledger: 'experiment' })
    }
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

  const verdicts = optionalJsonl(join(dir, 'verdicts.jsonl'), graph, 'experiment verdicts')
  const verdictIds = new Set(verdicts.map((verdict) => verdict.run_id))
  const staged = Boolean(definition.benchmark || definition.protocol)
  const hasRoles = runs.some((run) => run.role)
  const unverdicted = staged
    ? runs.filter((run) => (hasRoles ? run.role === 'variant' : true) && !verdictIds.has(run.run_id))
    : []
  if (unverdicted.length) {
    const id = nodeId('claim', 'experiment', slug, 'verdict-missing')
    graph.node({
      id, kind: 'claim', ledger: 'experiment', slug, type: 'experiment_verdict', role: 'claim',
      label: `${slug}: ${unverdicted.length} staged run(s) without a verdict`,
      state: 'verdict_missing',
      reason: `${unverdicted.length} staged run(s) have no human verdict; the accept/refine/prune decision is incomplete`,
      ts: runs.at(-1)?.ts ?? null,
      detail: { runs: unverdicted.map((run) => run.run_id), benchmark: Boolean(definition.benchmark), protocol: Boolean(definition.protocol) },
    })
    graph.edge({ from: id, to: questionId, relation: 'decides', ledger: 'experiment' })
  }

  return {
    slug: slugify(slug),
    counts: {
      runs: runs.length,
      links: links.length,
      verdicts: verdicts.length,
      protocol_runs: runs.filter((run) => run.protocol_digest).length,
      protocol_matched: runs.filter((run) => run.spec_drift?.state === 'match').length,
      drift_runs: runs.filter((run) => run.spec_drift?.state === 'drift').length,
      verdict_missing: unverdicted.length ? 1 : 0,
    },
  }
}

/* -------------------------------------------------------------------- ablation */

function readAblationLedger(cwd, slug, graph) {
  const dir = join(resolve(cwd), '.dsh', 'ablation', slugify(slug))
  if (!existsSync(join(dir, 'ablation.json'))) throw new Error(`no ablation method spec under .dsh/ablation/${slugify(slug)}`)
  const status = statusAblation(cwd, slug)
  const containerId = nodeId('record', 'ablation', slug, 'ablation')
  graph.node({
    id: containerId, kind: 'record', ledger: 'ablation', slug, type: 'ablation', role: 'container',
    label: `${status.name || slug}: ${clip(status.question, 140)}`,
    state: 'not_checked', reason: 'container node — a method spec and removal plan, not evidence',
    detail: { idea_id: status.idea_id ?? null, plan: status.plan ?? null },
  })
  const attributed = status.attribution?.attributed || []
  const unattributed = status.attribution?.unattributed || []
  const partial = status.attribution?.partial || []
  const notChecked = status.attribution?.not_checked || []
  const verdicts = listAblationVerdicts(cwd, slug)
  const latest = [...verdicts].reverse().find((entry) => !entry.arm && !entry.component) || null
  let state
  if (!status.records) {
    state = { state: 'not_checked', reason: 'the removal plan exists but no removal run is recorded' }
  } else if (!latest) {
    state = { state: 'verdict_missing', reason: `${status.records} removal run(s) are recorded but no ablation-level verdict exists${verdicts.length ? ` (only ${verdicts.length} arm-scoped verdict(s))` : ''}` }
  } else if (!attributed.length && (unattributed.length || latest.verdict === 'unattributed')) {
    state = {
      state: 'no_attribution',
      reason: latest.verdict === 'unattributed'
        ? `human verdict "unattributed"${unattributed.length ? ` (${unattributed.join(', ')})` : ''}`
        : `the advisory reading attributes no component; human verdict ${latest.verdict}`,
    }
  } else if (latest.verdict === 'good' && attributed.length) {
    state = { state: 'supported', reason: `human verdict "good"; ${attributed.length} component(s) attributed (${attributed.join(', ')})` }
  } else {
    state = {
      state: 'not_checked',
      reason: `attribution is ${attributed.length} attributed / ${partial.length} partial / ${notChecked.length} not checked; human verdict ${latest.verdict}`,
    }
  }
  const id = nodeId('claim', 'ablation', slug, 'attribution')
  graph.node({
    id, kind: 'claim', ledger: 'ablation', slug, type: 'ablation_attribution', role: 'claim',
    label: `ablation ${slug}: component attribution`,
    state: state.state, reason: state.reason, ts: latest?.ts ?? null,
    detail: {
      records: status.records,
      verdicts: status.verdicts,
      attributed,
      unattributed,
      partial,
      not_checked: notChecked,
      latest_verdict: latest?.verdict ?? null,
      arm_verdicts: verdicts.filter((entry) => entry.arm || entry.component).length,
    },
  })
  graph.edge({ from: id, to: containerId, relation: 'attributed_by', ledger: 'ablation' })
  return {
    slug: slugify(slug),
    counts: {
      records: status.records,
      verdicts: status.verdicts,
      attributed: attributed.length,
      unattributed: unattributed.length,
      partial: partial.length,
      not_checked: notChecked.length,
      latest_verdict: latest?.verdict ?? null,
    },
  }
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

function passageAbs(root, passage) {
  try {
    return resolveWorkspacePath(root, passage.file)
  } catch {
    return null
  }
}

function passageFileHash(root, passage) {
  try {
    const abs = passageAbs(root, passage)
    if (!abs || !existsSync(abs)) return null
    return fileSha256(abs)
  } catch {
    return null
  }
}

function bindingStillMatches(root, passage) {
  const abs = passageAbs(root, passage)
  if (!abs) return { state: 'not_found', reason: `the bound source path ${clip(passage.file, 120)} escapes the workspace` }
  const current = passageFileHash(root, passage)
  if (!current) return { state: 'not_found', reason: `the bound source file ${passage.file} is no longer readable` }
  if (passage.raw_sha256 && bare(passage.raw_sha256) !== bare(current)) {
    return { state: 'stale', reason: `the bound source file changed (recorded ${clip(passage.raw_sha256, 20)}, now ${clip(current, 20)})` }
  }
  if (passage.quote) {
    try {
      const body = normalizeForMatch(readFileSync(abs, 'utf8'))
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

  const counts = { units: files.length, claims: 0, by_status: {}, bound_code: 0, bound_manuscript: 0, bound_other: 0, bound_none: 0 }
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
      const kind = passage?.file ? bindingKind(passage.file) : null
      if (kind === 'code') counts.bound_code += 1
      else if (kind === 'manuscript') counts.bound_manuscript += 1
      else if (kind === 'other') counts.bound_other += 1
      else counts.bound_none += 1
      graph.node({
        id, kind: 'claim', ledger: 'ah', slug: 'project', type: 'manuscript_claim', role: 'claim', label: claim.clause,
        state: state.state, reason: state.reason,
        location: passage?.file ? clip(`${passage.file}:${passage.start}-${passage.end}`, 160) : null,
        quote: passage?.quote || null,
        hashes: passage?.raw_sha256 ? { recorded: passage.raw_sha256, current: passageFileHash(root, passage) } : null,
        detail: {
          claim_kind: claim.kind ?? null,
          cites: claim.cites ?? [],
          numbers: claim.numbers ?? [],
          binding_file: passage?.file ?? null,
          binding_kind: kind,
        },
      })
      graph.edge({ from: id, to: unitId, relation: 'in_unit', ledger: 'ah' })
      for (const key of claim.cites || []) {
        addPaperNode(graph, 'ah', 'project', `cite:${key}`, { relation: 'cites', fromId: id })
      }
      if (passage?.file) {
        const passageAbsolute = passageAbs(root, passage)
        const rel = passageAbsolute ? relative(resolve(cwd), passageAbsolute) : passage.file
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
    ablation: requested('ablation'),
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
  const ablationSlugs = discover('ablation', 'ablation', 'ablation')
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
  for (const entry of ablationSlugs) collect(runLedger('ablation', entry, () => readAblationLedger(cwd, entry, graph), graph))
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
    existsSync(join(resolve(cwd), '.dsh', 'preregister'))
      ? 'a preregistration directory exists, but this audit does not read it yet'
      : 'preregistrations are not indexed by this audit', { nodes: 0 }))
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
      ablation: ablationSlugs,
      dataset: dataSlugs,
      deep_review: wantedDeep.map((entry) => (typeof entry === 'string' ? entry : entry?.key ?? null)).filter(Boolean),
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

/* ---------------------------------------------------------------------- arms */

function armsCell(state, value, detail = null) {
  return { state, value, detail }
}

function armsReadiness(cells) {
  const applicable = Object.values(cells).filter((cell) => cell.state !== 'n/a')
  if (!applicable.length) return 'not_checked'
  if (applicable.some((cell) => ['mismatch', 'drift', 'flagged', 'stale', 'missing', 'violated', 'no_attribution'].includes(cell.state))) return 'not_ready'
  if (applicable.some((cell) => ['not_checked', 'absent', 'verdict_missing', 'partial'].includes(cell.state))) return 'partial'
  if (applicable.every((cell) => ['matched', 'verified', 'supported'].includes(cell.state))) return 'ready'
  return 'partial'
}

/** Which column each ledger owns, and which contribute a row without one. */
const ARMS_SOURCE_COLUMNS = {
  analysis: 'reported_vs_recomputed',
  experiment: 'protocol_digest',
  deep_review: 'references',
  ah: 'method_code',
}
const ARMS_ROW_LEDGERS = new Set(['ablation'])

/**
 * The four-column readiness roll-up over artifacts that already exist. Every
 * cell is derived from the same index; a missing column is `n/a`, never a pass.
 * This is a reading, not an acceptance decision.
 */
export function armsOf(index) {
  const rows = []
  const nodesOf = (ledger, slug) => index.nodes.filter((node) => node.ledger === ledger && node.slug === slug)

  for (const source of index.sources) {
    const { ledger, slug } = source
    const column = ARMS_SOURCE_COLUMNS[ledger]
    if (!column && !ARMS_ROW_LEDGERS.has(ledger)) continue
    const counts = source.counts || {}
    const cells = {
      reported_vs_recomputed: armsCell('n/a', 'not applicable'),
      protocol_digest: armsCell('n/a', 'not applicable'),
      references: armsCell('n/a', 'not applicable'),
      method_code: armsCell('n/a', 'not applicable'),
    }
    // An unreadable or skipped ledger is a row of its own, not an omission. The
    // reason must reach the report and count in totals.not_checked, or a workspace
    // with no method–code ledger looks identical to one that passed.
    if (source.status !== 'present') {
      const reason = clip(source.reason || 'source not readable', 200)
      if (column) cells[column] = armsCell('not_checked', reason)
      rows.push({
        artifact: `${ledger}:${slug}`, ledger, slug, cells,
        notes: `source ${source.status}: ${reason}`,
        readiness: 'not_checked',
      })
      continue
    }
    let notes = null
    let readiness = null

    if (ledger === 'analysis') {
      const expectations = nodesOf('analysis', slug).filter((node) => node.type === 'analysis_expectation')
      const supported = expectations.filter((node) => node.state === 'supported').length
      const mismatched = expectations.filter((node) => node.state === 'rerun_mismatch').length
      const unchecked = expectations.filter((node) => node.state === 'not_checked').length
      if (!expectations.length) {
        cells.reported_vs_recomputed = armsCell('absent', 'no declared expectations')
      } else if (mismatched) {
        cells.reported_vs_recomputed = armsCell('mismatch', `${mismatched} mismatched / ${supported} matched / ${unchecked} not checked`)
      } else if (supported && !unchecked) {
        cells.reported_vs_recomputed = armsCell('matched', `${supported} matched`)
      } else {
        cells.reported_vs_recomputed = armsCell('not_checked', `${supported} matched / ${unchecked} not checked`)
      }
      const violated = counts.compliance_violated ?? 0
      notes = violated ? `${violated} run(s) excluded by compliance` : null
      if (violated) readiness = 'not_ready'
    } else if (ledger === 'experiment') {
      const protocolRuns = counts.protocol_runs ?? 0
      const protocolMatched = counts.protocol_matched ?? 0
      const driftRuns = counts.drift_runs ?? 0
      if (driftRuns) cells.protocol_digest = armsCell('drift', `${driftRuns} drifted / ${protocolRuns} protocol run(s)`)
      else if (protocolMatched) cells.protocol_digest = armsCell('verified', `${protocolMatched} variant run(s) share the baseline digest`)
      else if (protocolRuns) cells.protocol_digest = armsCell('not_checked', 'baseline digest recorded; no variant compared')
      else cells.protocol_digest = armsCell('absent', 'no protocol digest recorded')
      if (counts.verdict_missing) {
        notes = 'staged runs have no recorded verdict'
        readiness = armsReadiness(cells) === 'not_ready' ? 'not_ready' : 'partial'
      }
    } else if (ledger === 'deep_review') {
      const citations = counts.citations || { total: 0, ok: 0, skipped: 0, flagged: 0 }
      if (!citations.total) cells.references = armsCell('absent', 'no citation verdicts stored')
      else if (citations.flagged) cells.references = armsCell('flagged', `${citations.ok}/${citations.total} verified, ${citations.flagged} flagged`)
      else if (citations.ok && !citations.skipped) cells.references = armsCell('verified', `${citations.ok}/${citations.total} verified`)
      else cells.references = armsCell('not_checked', `${citations.ok}/${citations.total} verified, ${citations.skipped} skipped`)
      const validity = counts.validity || { checks: 0, flagged: 0, not_checked: 0 }
      if (validity.flagged) {
        notes = `${validity.flagged} validity flag(s)`
        readiness = 'not_ready'
      } else if (validity.not_checked) {
        notes = `${validity.not_checked} validity check(s) not checked`
        readiness = armsReadiness(cells) === 'not_ready' ? 'not_ready' : 'partial'
      }
    } else if (ledger === 'ah') {
      const claims = nodesOf('ah', slug).filter((node) => node.type === 'manuscript_claim' && node.detail?.binding_kind === 'code')
      const supported = claims.filter((node) => node.state === 'supported').length
      const stale = claims.filter((node) => node.state === 'stale').length
      const missing = claims.filter((node) => node.state === 'not_found').length
      const unbound = claims.filter((node) => node.state !== 'supported' && node.state !== 'stale' && node.state !== 'not_found').length
      if (!claims.length) cells.method_code = armsCell('absent', 'no code-bound claims')
      else if (missing) cells.method_code = armsCell('missing', `${missing} code binding(s) reference a missing source`)
      else if (stale) cells.method_code = armsCell('stale', `${stale} stale / ${supported} bound`)
      else if (supported && !unbound) cells.method_code = armsCell('verified', `${supported} code binding(s) verified`)
      else cells.method_code = armsCell('not_checked', `${supported} verified / ${unbound} unresolved`)
    } else if (ledger === 'ablation') {
      const claim = nodesOf('ablation', slug).find((node) => node.type === 'ablation_attribution')
      notes = claim
        ? `attribution: ${claim.state}${claim.detail?.latest_verdict ? ` (verdict ${claim.detail.latest_verdict})` : ''}`
        : null
      readiness = claim
        ? (claim.state === 'supported' ? 'ready'
          : ['no_attribution', 'verdict_missing'].includes(claim.state) ? 'not_ready' : 'partial')
        : 'not_checked'
    } else {
      continue
    }

    rows.push({
      artifact: `${ledger}:${slug}`,
      ledger,
      slug,
      cells,
      notes,
      readiness: readiness || armsReadiness(cells),
    })
  }

  const totals = { rows: rows.length, ready: 0, partial: 0, not_ready: 0, not_checked: 0 }
  for (const row of rows) totals[row.readiness] += 1
  const newStates = {
    no_attribution: index.nodes.filter((node) => node.role === 'claim' && node.state === 'no_attribution').length,
    rerun_mismatch: index.nodes.filter((node) => node.role === 'claim' && node.state === 'rerun_mismatch').length,
    verdict_missing: index.nodes.filter((node) => node.role === 'claim' && node.state === 'verdict_missing').length,
  }
  return {
    audit: index.audit,
    index_hash: index.index_hash,
    columns: ['reported_vs_recomputed', 'protocol_digest', 'references', 'method_code'],
    rows,
    totals,
    unsupported: newStates,
    note: 'A readiness roll-up over recorded artifacts: reported vs recomputed (analysis expectations and their re-executions), protocol digest (experiment spec_drift), references (deep-review citation verdicts), and method–code (Academic Harness bindings to code files). A missing column is n/a, never a pass. This is not an acceptance decision.',
  }
}

/* ------------------------------------------------------------------- roll-up */

const ROLLUP_DECISION = 'report_only'

function rollupRows(file) {
  if (!existsSync(file)) return { rows: [] }
  try {
    return { rows: readJsonl(file) }
  } catch (error) {
    return { rows: [], error: clip(error instanceof Error ? error.message : String(error), 220) }
  }
}

function analysisTargetId(value) {
  const parts = String(value ?? '').split(/[:/]/).filter(Boolean)
  return parts.at(-1) || null
}

function latestVerdictMap(verdicts) {
  const map = new Map()
  for (const verdict of verdicts) map.set(verdict.run_id, verdict)
  return map
}

function readAnalysisLedgers(cwd) {
  return listLedgers(cwd, 'analysis').map((slug) => {
    const dir = join(resolve(cwd), '.dsh', 'analysis', slug)
    const plans = rollupRows(join(dir, 'plan.jsonl'))
    const runs = rollupRows(join(dir, 'runs.jsonl'))
    const expectations = rollupRows(join(dir, 'expectations.jsonl'))
    const verifications = rollupRows(join(dir, 'verifications.jsonl'))
    const compliance = rollupRows(join(dir, 'compliance.jsonl'))
    return {
      slug,
      plans: plans.rows,
      runs: runs.rows,
      expectations: expectations.rows,
      verifications: verifications.rows,
      compliance: compliance.rows,
      unreadable: [plans.error, runs.error].filter(Boolean),
      warnings: [expectations.error, verifications.error, compliance.error].filter(Boolean),
    }
  })
}

function readExperimentLedgers(cwd) {
  const out = []
  for (const slug of listLedgers(cwd, 'experiments')) {
    const dir = join(resolve(cwd), '.dsh', 'experiments', slug)
    const definition = readJson(join(dir, 'experiment.json'))
    if (!definition) continue
    const runs = rollupRows(join(dir, 'runs.jsonl'))
    const links = rollupRows(join(dir, 'links.jsonl'))
    const verdicts = rollupRows(join(dir, 'verdicts.jsonl'))
    out.push({
      slug,
      definition,
      runs: runs.rows,
      links: links.rows,
      verdicts: verdicts.rows,
      unreadable: [runs.error].filter(Boolean),
      warnings: [links.error, verdicts.error].filter(Boolean),
    })
  }
  return out
}

function readAblationLedgers(cwd) {
  const out = []
  for (const slug of listLedgers(cwd, 'ablation')) {
    const dir = join(resolve(cwd), '.dsh', 'ablation', slug)
    const definition = readJson(join(dir, 'ablation.json'))
    if (!definition) continue
    let status = null
    let records = []
    let error = null
    try {
      status = statusAblation(cwd, slug)
    } catch (caught) {
      error = clip(caught instanceof Error ? caught.message : String(caught), 220)
    }
    try {
      records = listAblationRecords(cwd, slug)
    } catch (caught) {
      if (!error) error = clip(caught instanceof Error ? caught.message : String(caught), 220)
    }
    out.push({
      slug,
      definition,
      status,
      records,
      unreadable: error ? [error] : [],
    })
  }
  return out
}

function readReviewLedgers(cwd) {
  const out = []
  for (const key of listLedgers(cwd, 'deep-review')) {
    const dir = join(resolve(cwd), '.dsh', 'deep-review', key)
    const meta = readJson(join(dir, 'meta.json'))
    if (!meta) continue
    out.push({ key, meta, score: readJson(join(dir, 'score.json')), rounds: (Array.isArray(meta.rounds) ? meta.rounds : []).filter(Boolean) })
  }
  return out
}

function reviewMatches(meta, manuscript) {
  if (!manuscript) return true
  const input = text(meta?.input?.path)
  if (!input) return false
  const wanted = text(manuscript)
  return input === wanted || input.endsWith(`/${wanted}`) || wanted.endsWith(`/${input}`)
}

function stageGroup(stage) {
  if (stage === 'full') return 'scale_up'
  if (stage === 'subset' || stage === 'slice') return 'subset'
  return 'unstaged'
}

function summarizeStage(name, stages, rows, limit) {
  const verdicts = { good: 0, engineer: 0, bad: 0, missing: 0 }
  const analysisIds = new Set()
  let recorded = 0
  let measured = 0
  let missingDuration = 0
  for (const row of rows) {
    const verdict = row.verdict?.verdict
    if (verdict === 'good' || verdict === 'engineer' || verdict === 'bad') verdicts[verdict] += 1
    else verdicts.missing += 1
    if (row.recorded_ms == null) missingDuration += 1
    else {
      measured += 1
      recorded += row.recorded_ms
      for (const analysis of row.analysis) analysisIds.add(analysis.run_id)
    }
  }
  return {
    stages,
    state: rows.length ? 'recorded' : 'not_recorded',
    run_count: rows.length,
    runs: rows.slice(0, limit),
    omitted_runs: Math.max(0, rows.length - limit),
    verdicts,
    recorded_ms: measured ? recorded : null,
    analysis_run_ids: [...analysisIds],
    missing_duration: missingDuration,
  }
}

function analysisPlan(ledger) {
  const plan = ledger?.plans?.at(-1) || null
  return {
    slug: ledger?.slug ?? null,
    question: plan?.plan?.question ?? null,
    version: plan?.version ?? null,
    hash: plan?.hash ?? null,
  }
}

function linkedAnalysisForRun(ledger, run, analysisIndex) {
  const out = []
  const seen = new Set()
  for (const link of ledger.links.filter((entry) => entry.run_id === run.run_id && entry.target?.kind === 'analysis_run')) {
    const target = analysisTargetId(link.target.id)
    const found = target ? analysisIndex.get(target) : null
    if (!found || seen.has(found.run.run_id)) continue
    seen.add(found.run.run_id)
    out.push({
      slug: found.slug,
      run_id: found.run.run_id,
      duration_ms: durationValue(found.run.duration_ms),
    })
  }
  return out
}

/**
 * A recorded duration, or null when there is none. `Number('')` is 0 and
 * `Number(true)` is 1, so a blank field must not be read as a measured zero —
 * the whole cost block rests on absent meaning absent.
 */
function durationValue(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !value.trim()) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function baselineGateRow(ledger) {
  const expectation = ledger.expectations.at(-1) || null
  const verification = expectation
    ? [...ledger.verifications].reverse().find((entry) => entry.expectation_id === expectation.expectation_id) || null
    : null
  // The gate is about one run: the re-execution that answered the expectation, or
  // the reference run the expectation was declared against. A violation elsewhere
  // in the ledger is reported alongside, not substituted for this run's state —
  // otherwise a clean, reproduced baseline would be called excluded while the
  // object right next to it says reproduction: true.
  const gateRunIds = new Set([verification?.run_id, expectation?.reference_run_id].filter(Boolean))
  const runId = verification?.run_id ?? expectation?.reference_run_id ?? null
  const violations = ledger.compliance.filter((entry) => entry.verdict === 'violated' && gateRunIds.has(entry.run_id))
  const otherViolations = [...new Set(ledger.compliance
    .filter((entry) => entry.verdict === 'violated' && !gateRunIds.has(entry.run_id))
    .map((entry) => entry.run_id))]
  const violated = violations.length > 0
  const violatedRules = [...new Set(violations.flatMap((entry) => (entry.rules || [])
    .filter((rule) => rule.status === 'violated')
    .map((rule) => rule.rule_id)))]
  // A reproduced baseline is only gated when the check ran against a run other
  // than the one the expectation was declared from. Verifying the reference run
  // against its own numbers is a self-check, not a re-execution.
  const selfCheck = Boolean(verification && expectation?.reference_run_id
    && verification.run_id === expectation.reference_run_id)
  const reexecuted = Boolean(verification?.run_id && expectation?.reference_run_id && !selfCheck)
  let state = 'not_checked'
  if (violated) state = 'excluded'
  else if (expectation?.reference === 'reproduced' && verification?.reproduction === true && reexecuted) state = 'verified'
  else if (verification?.reproduction === false) state = 'mismatch'
  return {
    slug: ledger.slug,
    run_id: runId,
    question: analysisPlan(ledger).question,
    plan_version: analysisPlan(ledger).version,
    plan_hash: analysisPlan(ledger).hash,
    expectation_id: expectation?.expectation_id ?? null,
    reference: expectation?.reference ?? null,
    reproduction: verification?.reproduction ?? null,
    compliance_excluded_runs: otherViolations,
    state,
    reason: violated
      ? `baseline run(s) ${[...new Set(violations.map((entry) => entry.run_id))].join(', ')} carry a recorded compliance violation (${violations.map((entry) => entry.compliance_id).join(', ')}${violatedRules.length ? `: ${violatedRules.join(', ')}` : ''})`
      : selfCheck && expectation?.reference === 'reproduced' && verification?.reproduction === true
        ? `expectation ${expectation.expectation_id} was checked against the same run it was declared from (${runId}), so the baseline was not re-executed`
        : expectation?.reference === 'reproduced' && verification?.reproduction === true && !expectation.reference_run_id
          ? 'no reference run was recorded, so re-execution cannot be established'
        : expectation
        ? `expectation ${expectation.expectation_id} (${expectation.reference})${verification ? ` verified as ${verification.reproduction === true ? 'reproduced' : verification.reproduction === false ? 'mismatched' : 'not checked'}` : ' was never verified'}`
        : 'no declared expectation; the baseline is not gated',
  }
}

function aggregateBaseline(rows, linkedCount = rows.length, scope = 'cycle') {
  if (!rows.length) {
    return {
      state: linkedCount ? 'not_checked' : 'not_linked',
      rows,
      note: linkedCount
        ? (scope === 'workspace'
          ? 'Analysis ledgers exist in this workspace, but none declares reference: reproduced; the baseline is not gated.'
          : 'Linked analyses exist, but none declares reference: reproduced; the baseline is not gated.')
        : (scope === 'workspace'
          ? 'No analysis ledger in this workspace was linked to a tournament cycle; the workspace roll-up lists every ledger and gates none of them.'
          : 'No analysis_run is linked to this cycle; the baseline gate has nothing to check.'),
    }
  }
  const states = new Set(rows.map((row) => row.state))
  const state = states.has('excluded')
    ? 'excluded'
    : states.has('mismatch')
      ? 'unverified'
      : states.has('verified') && rows.every((row) => row.state === 'verified')
        ? 'verified'
        : states.has('verified')
          ? 'partial'
          : 'not_checked'
  return {
    state,
    rows,
    note: state === 'verified'
      ? 'Each gated row declares reference: reproduced and was confirmed by a re-execution other than the reference run; this is the Phase 8 improvement over an unchecked reference.'
      : state === 'excluded'
        ? 'A gated run carries a recorded compliance violation, so its baseline is excluded whatever verify_scores reported. The violation is scoped to that run, not to the ledger.'
        : 'A reproduced baseline is gated only when an analysis declares reference: reproduced and a re-execution other than the reference run confirms it; a reported-number check does not gate the baseline.',
  }
}

function costOf({ analysisDurations, stageSummaries, reviewLedgers, ablationRows, hasIdeation, hasSelection }) {
  const recorded = []
  const missing = []
  for (const [runId, duration] of analysisDurations) {
    if (duration != null) recorded.push(duration)
    else missing.push(`analysis run ${runId} has no duration_ms`)
  }
  const reviewRounds = reviewLedgers.flatMap((ledger) => ledger.rounds)
  const reviewDurations = reviewRounds.map((round) => durationValue(round.duration_ms)).filter((value) => value != null)
  const reviewTokensMeasured = reviewRounds.some((round) => round.usage && (round.usage.prompt_tokens != null || round.usage.completion_tokens != null))
  const reviewCallsMeasured = reviewRounds.some((round) => round.usage && round.usage.calls != null)
  const reviewTokens = reviewRounds.reduce((sum, round) => sum + (Number(round.usage?.prompt_tokens) || 0) + (Number(round.usage?.completion_tokens) || 0), 0)
  const reviewCalls = reviewRounds.reduce((sum, round) => sum + (Number(round.usage?.calls) || 0), 0)
  const allTimes = [...recorded, ...reviewDurations]
  const byStage = []
  if (hasIdeation) {
    byStage.push({ stage: 'ideation', recorded_ms: null, recorded_tokens: null, source: 'coscientist events (timestamps only)', note: 'The ideation ledger records timestamps, not compute time or tokens.' })
    missing.push('ideation: no compute measure (events carry timestamps only)')
  }
  for (const summary of stageSummaries) {
    if (!summary.run_count) continue;
    byStage.push({
      stage: summary.stages.join('+'),
      runs: summary.run_count,
      recorded_ms: summary.recorded_ms,
      recorded_tokens: null,
      analysis_runs: summary.analysis_run_ids.length,
      note: summary.missing_duration ? `${summary.missing_duration} run(s) had no linked analysis duration.` : null,
    })
    if (summary.missing_duration) missing.push(`${summary.stages.join('+')}: ${summary.missing_duration} run(s) have no linked analysis duration`)
  }
  if (ablationRows.length) {
    byStage.push({ stage: 'ablation', runs: ablationRows.length, recorded_ms: null, recorded_tokens: null, note: 'Ablation records link runs and timestamps; no duration is recorded.' })
    missing.push('ablation: no duration recorded')
  }
  if (reviewRounds.length) {
    byStage.push({ stage: 'review', rounds: reviewRounds.length, recorded_ms: reviewDurations.length ? reviewDurations.reduce((sum, value) => sum + value, 0) : null, recorded_tokens: reviewTokensMeasured ? reviewTokens : null, model_calls: reviewCallsMeasured ? reviewCalls : null })
    if (reviewRounds.some((round) => durationValue(round.duration_ms) == null && round.duration_ms != null)) {
      missing.push('review: some rounds record a duration that is not a number')
    }
    if (reviewRounds.some((round) => round.duration_ms == null)) missing.push('review: some rounds have no duration')
    if (reviewRounds.some((round) => !round.usage)) missing.push('review: some rounds have no token tally')
    else if (!reviewTokensMeasured) missing.push('review: token tallies omit token counts')
  }
  if (hasSelection) {
    byStage.push({ stage: 'selection', recorded_ms: null, recorded_tokens: null, note: 'Selection events carry timestamps only.' })
    missing.push('selection: no duration recorded')
  }
  return {
    recorded_ms: allTimes.length ? allTimes.reduce((sum, value) => sum + Number(value), 0) : null,
    recorded_tokens: reviewTokensMeasured ? reviewTokens : null,
    model_calls: reviewCallsMeasured ? reviewCalls : null,
    coverage: {
      experiment_runs: stageSummaries.reduce((sum, summary) => sum + summary.run_count, 0),
      analysis_runs_with_duration: recorded.length,
      analysis_runs_seen: analysisDurations.size,
      review_rounds: reviewRounds.length,
      review_rounds_with_duration: reviewDurations.length,
      review_rounds_with_usage: reviewRounds.filter((round) => round.usage).length,
    },
    by_stage: byStage,
    missing,
    note: 'Only ledgers that recorded a measure contribute. Missing durations and token tallies are listed, never zeroed, and stage sums can overlap when one analysis run serves several experiments; recorded_ms counts each run once. No dollar figure is computed: the plugin has duration and token tallies, not actual spend.',
    accounting: 'No headline gain is computed here, and this roll-up does not average over successful cases only. The source paper reports +25.2% over successful cases and a cost/time average covering 33 of 107 problems including VM cost; do not inherit that framing.',
    denominator: `${stageSummaries.reduce((sum, summary) => sum + summary.run_count, 0)} experiment run(s), ${recorded.length} analysis run(s) with a duration, ${reviewRounds.length} review round(s), ${ablationRows.length} ablation ledger(s).`,
  }
}
/**
 * Read-only loop roll-up: joins the ideation ledger with the Phase 4–8 evidence
 * and renders the ordered record. It is a report, not a store, and does not
 * promote anything.
 */
export function rollupOf(index, { cwd, coscientist = null, manuscript = null, limit = 50 } = {}) {
  const root = resolve(cwd)
  const cap = Math.max(1, Math.min(Number(limit) || 50, 500))
  const analysisLedgers = readAnalysisLedgers(root)
  const experimentLedgers = readExperimentLedgers(root)
  const ablationLedgers = readAblationLedgers(root)
  const reviewLedgers = readReviewLedgers(root)
  const analysisIndex = new Map()
  for (const ledger of analysisLedgers) {
    for (const run of ledger.runs) analysisIndex.set(run.run_id, { slug: ledger.slug, run, ledger })
  }
  const arms = armsOf(index)

  const coscientistSlugs = listLedgers(root, 'coscientist')
  let wanted = coscientistSlugs
  if (coscientist) {
    const slug = tournamentSlug(coscientist)
    if (!coscientistSlugs.includes(slug)) throw new Error(`no coscientist tournament named "${coscientist}" under .dsh/coscientist`)
    wanted = [slug]
  }

  // Coscientist hypothesis ids are a per-tournament counter (h1, h2, …) and an
  // experiment or ablation ledger names no tournament, so a bare id cannot say
  // which cycle it came from. Two cycles in one workspace is the documented
  // Phase 9 workflow, so link only ids this cycle owns alone, honour an explicit
  // `<tournament>#<idea>` reference, and say so when an id is contested.
  // Ownership is resolved across every tournament in the workspace, not just the
  // ones being reported, so asking for one cycle cannot hand it another cycle's
  // evidence simply because the other cycle was not named.
  const idsByTournament = new Map()
  for (const slug of coscientistSlugs) {
    try {
      idsByTournament.set(slug, new Set(deriveState(root, slug).hypotheses.map((hyp) => hyp.id)))
    } catch {
      idsByTournament.set(slug, null)
    }
  }
  const ideaOwners = (id) => [...idsByTournament.entries()]
    .filter(([, ids]) => ids && ids.has(id))
    .map(([owner]) => owner)

  const build = (slug) => {
    let state
    let limits
    try {
      state = deriveState(root, slug)
      limits = limitationStatus(root, slug)
    } catch (error) {
      return {
        id: slug, source: 'coscientist', state: 'unknown',
        reason: clip(error instanceof Error ? error.message : String(error), 220),
        problem: null, limitations: { state: 'unknown' }, ideas: { state: 'unknown' }, stages: { state: 'unknown' },
        selection: { state: 'unknown' }, ablation: { state: 'unknown' }, reviews: { state: 'unknown' },
        integrity: { state: 'unknown', rows: [] }, incumbent: { state: 'unknown' },
        baseline_gate: { state: 'unknown', rows: [] }, cost: { recorded_ms: null, recorded_tokens: null, missing: ['unreadable tournament'], note: 'The tournament could not be read.' },
        warnings: [],
      }
    }
    const ideaIds = new Set(state.hypotheses.map((hyp) => hyp.id))
    const selection = state.selections.at(-1) || null
    const selectionExperiment = selection?.experiment ? slugify(selection.experiment) : null
    const contested = new Map()
    // A run names an idea of this cycle either by scoped reference, or by a bare
    // id that no other cycle in scope also declares.
    const referencesCycle = (params) => {
      for (const id of ideaIds) {
        if (paramsReference(params, `${slug}#${id}`)) return { owned: true, id }
      }
      for (const id of ideaIds) {
        if (!paramsReference(params, id)) continue
        const owners = ideaOwners(id)
        if (owners.length > 1) {
          contested.set(id, owners)
          return { owned: false, id }
        }
        return { owned: true, id }
      }
      return { owned: false, id: null }
    }
    const linkedExperiments = experimentLedgers.filter((ledger) => (
      ledger.runs.some((run) => referencesCycle(run.params).owned)
      || (selectionExperiment && ledger.slug === selectionExperiment)
    ))
    const linkedAblations = ablationLedgers.filter((ledger) => {
      const idea = ledger.definition?.idea_id
      if (!idea) return false
      const owners = ideaOwners(idea)
      if (owners.length > 1) {
        contested.set(idea, owners)
        return false
      }
      return ideaIds.has(idea) || idea === selection?.hypothesisId
    })
    // Review ledgers name a manuscript, not a tournament. Without an explicit
    // manuscript, including every workspace review would attribute unrelated
    // rounds, cost and integrity findings to every cycle.
    const linkedReviewLedgers = manuscript
      ? reviewLedgers.filter((ledger) => reviewMatches(ledger.meta, manuscript))
      : []
    const rowsByGroup = { subset: [], scale_up: [], unstaged: [] }
    const linkedAnalysisSlugs = new Set()
    const ambiguousRuns = []
    for (const ledger of linkedExperiments) {
      const verdicts = latestVerdictMap(ledger.verdicts)
      // A ledger may contain runs for several cycles. A link to the ledger is
      // not evidence that every run (and its analysis links) belongs here.
      const ownersForRun = (run) => {
        const scoped = []
        const bare = []
        for (const [owner, ids] of idsByTournament) {
          if (!ids) continue
          for (const id of ids) {
            if (paramsReference(run.params, `${owner}#${id}`)) scoped.push(owner)
            if (paramsReference(run.params, id)) bare.push(owner)
          }
        }
        return new Set(scoped.length ? scoped : bare)
      }
      const ledgerOwners = new Set(ledger.runs.flatMap((run) => [...ownersForRun(run)]))
      for (const run of ledger.runs) {
        const owners = ownersForRun(run)
        if (owners.size && (owners.size !== 1 || !owners.has(slug))) {
          if (owners.has(slug)) ambiguousRuns.push(`${ledger.slug}/${run.run_id}`)
          continue
        }
        if (!owners.size && ledgerOwners.size > 1) {
          ambiguousRuns.push(`${ledger.slug}/${run.run_id}`)
          continue
        }
        const ideas = [...ideaIds].filter((id) => paramsReference(run.params, `${slug}#${id}`)
          || (paramsReference(run.params, id) && ideaOwners(id).length <= 1))
        // once a ledger is linked, its baseline and arms belong to the stage
        // record even when a run does not name an idea itself.
        const analysis = linkedAnalysisForRun(ledger, run, analysisIndex)
        analysis.forEach((entry) => linkedAnalysisSlugs.add(entry.slug))
        const measured = analysis.map((entry) => entry.duration_ms).filter((value) => value != null)
        rowsByGroup[stageGroup(run.stage)].push({
          experiment: ledger.slug,
          run_id: run.run_id,
          role: run.role ?? null,
          baseline_ref: run.baseline_ref ?? null,
          stage: run.stage ?? null,
          seed: run.seed ?? null,
          parent: run.parent ?? null,
          metrics: run.metrics ?? {},
          protocol_digest: run.protocol_digest ?? null,
          spec_drift: run.spec_drift?.state ?? null,
          verdict: verdicts.get(run.run_id) ? {
            verdict: verdicts.get(run.run_id).verdict,
            forced: Boolean(verdicts.get(run.run_id).forced),
            reason: verdicts.get(run.run_id).reason ?? null,
          } : null,
          idea_ids: ideas,
          analysis,
          recorded_ms: measured.length ? measured.reduce((sum, value) => sum + value, 0) : null,
          missing_duration: measured.length === 0,
        })
      }
    }
    const stageSummaries = [
      summarizeStage('subset', ['subset', 'slice'], rowsByGroup.subset, cap),
      summarizeStage('scale_up', ['full'], rowsByGroup.scale_up, cap),
      summarizeStage('unstaged', ['unstaged'], rowsByGroup.unstaged, cap),
    ]
    const hadRuns = stageSummaries.some((summary) => summary.run_count > 0)
    const stages = linkedExperiments.length
      ? {
        state: hadRuns ? 'recorded' : 'not_recorded',
        subset: stageSummaries[0],
        scale_up: stageSummaries[1],
        unstaged: stageSummaries[2],
        candidates: [],
        note: hadRuns ? null : 'Experiment ledgers are linked but no run belongs to this cycle.',
      }
      : {
        state: 'not_linked',
        subset: stageSummaries[0],
        scale_up: stageSummaries[1],
        unstaged: stageSummaries[2],
        candidates: experimentLedgers.map((ledger) => ({ slug: ledger.slug, question: ledger.definition.question })),
        note: 'No experiment run names an idea from this cycle. Log params.idea_id (or hypothesis_id) when testing an idea, or pass the selection experiment.',
      }
    const baselineRows = [...linkedAnalysisSlugs].map((slug) => baselineGateRow(analysisLedgers.find((ledger) => ledger.slug === slug))).filter(Boolean)
    const baseline = aggregateBaseline(baselineRows.filter((row) => row.reference === 'reproduced'), baselineRows.length)
    baseline.analyses = baselineRows
    const ablationRows = linkedAblations.map((ledger) => ({
      slug: ledger.slug,
      idea_id: ledger.definition.idea_id ?? null,
      records: ledger.status?.records ?? ledger.records.length,
      verdicts: ledger.status?.verdicts ?? 0,
      latest_verdict: ledger.status?.latest_verdict?.verdict ?? null,
      attribution: ledger.status?.attribution ?? null,
      state: ledger.unreadable.length ? 'unknown' : 'recorded',
      reason: ledger.unreadable[0] ?? null,
    }))
    const reviewRounds = linkedReviewLedgers.flatMap((ledger) => ledger.rounds.map((round) => ({
      key: ledger.key,
      round: round.round ?? null,
      run_id: round.run_id ?? null,
      evaluator_kind: round.evaluator_kind ?? 'held_out',
      evaluator_kind_source: round.evaluator_kind_source ?? 'inferred',
      duration_ms: durationValue(round.duration_ms),
      usage: round.usage ?? null,
      counts: round.counts ?? null,
    })))
    const reviewTokenTally = reviewRounds.some((round) => round.usage && (round.usage.prompt_tokens != null || round.usage.completion_tokens != null))
    const reviewCallTally = reviewRounds.some((round) => round.usage && round.usage.calls != null)
    const reviewTotals = {
      rounds: reviewRounds.length,
      held_out: reviewRounds.filter((round) => round.evaluator_kind === 'held_out').length,
      in_distribution: reviewRounds.filter((round) => round.evaluator_kind === 'in_distribution').length,
      duration_ms: reviewRounds.some((round) => round.duration_ms != null)
        ? reviewRounds.map((round) => durationValue(round.duration_ms)).filter((value) => value != null).reduce((sum, value) => sum + value, 0)
        : null,
      tokens: reviewTokenTally
        ? reviewRounds.reduce((sum, round) => sum + (Number(round.usage?.prompt_tokens) || 0) + (Number(round.usage?.completion_tokens) || 0), 0)
        : null,
      model_calls: reviewCallTally
        ? reviewRounds.reduce((sum, round) => sum + (Number(round.usage?.calls) || 0), 0)
        : null,
    }
    const integrityArtifacts = new Set([
      ...[...linkedAnalysisSlugs].map((slug) => `analysis:${slug}`),
      ...linkedExperiments.map((ledger) => `experiment:${ledger.slug}`),
      ...ablationRows.map((row) => `ablation:${row.slug}`),
      ...linkedReviewLedgers.map((ledger) => `deep_review:${ledger.key}`),
      'ah:project',
    ])
    const integrityRows = arms.rows.filter((row) => integrityArtifacts.has(row.artifact))
    const integrityTotals = { rows: integrityRows.length, ready: 0, partial: 0, not_ready: 0, not_checked: 0 }
    for (const row of integrityRows) integrityTotals[row.readiness] += 1
    const selectedPlans = [...new Set([...linkedAnalysisSlugs])].map((slug) => analysisPlan(analysisLedgers.find((ledger) => ledger.slug === slug))).filter((plan) => plan.slug)
    const problem = {
      source: 'coscientist',
      goal: state.protocol.goal ?? state.protocol.parsed_title ?? null,
      parsed_title: state.protocol.parsed_title ?? null,
      domain: state.protocol.domain ?? null,
      constraints: state.protocol.constraints ?? [],
      keywords: state.protocol.keywords ?? [],
      created_at: state.protocol.created_at ?? null,
      analyses: selectedPlans,
    }
    const warnings = [
      ...analysisLedgers.filter((ledger) => linkedAnalysisSlugs.has(ledger.slug)).flatMap((ledger) => [...ledger.unreadable, ...ledger.warnings].map((reason) => `analysis:${ledger.slug}: ${reason}`)),
      ...linkedExperiments.flatMap((ledger) => [...ledger.unreadable, ...ledger.warnings].map((reason) => `experiment:${ledger.slug}: ${reason}`)),
      ...linkedAblations.flatMap((ledger) => ledger.unreadable.map((reason) => `ablation:${ledger.slug}: ${reason}`)),
      ...(selection ? [] : ['No selection event; the incumbent is not recorded.']),
      ...(manuscript ? [] : ['Review rounds were not selected; pass manuscript to include matching reviews.']),
      ...(ambiguousRuns.length ? [`Ambiguous experiment runs were not attributed to this cycle: ${ambiguousRuns.join(', ')}.`] : []),
      ...[...contested.entries()].map(([id, owners]) => `idea id "${id}" is declared by ${owners.join(', ')}; it was not linked to this cycle. Reference it as "${slug}#${id}" in a run's params to claim it here.`),
    ]
    const incumbent = selection
      ? {
        state: 'selected',
        idea_id: selection.hypothesisId,
        selection_id: selection.id,
        evidence_digest: selection.evidence_digest,
        compared_ids: selection.compared_ids ?? [],
        rationale: selection.rationale ?? '',
        ts: selection.ts ?? null,
        promotion: { state: 'not_recorded', note: 'This report writes no promotion event. Start the next cycle with this champion as the declared baseline; a dedicated frontier ledger was not justified by this roll-up.' },
      }
      : { state: 'not_recorded', note: 'No coscientist selection event is recorded; the incumbent is not promoted.' }
    return {
      id: slug,
      source: 'coscientist',
      state: 'recorded',
      problem,
      protocol: {
        goal: state.protocol.goal ?? null,
        parsed_title: state.protocol.parsed_title ?? null,
        domain: state.protocol.domain ?? null,
        max_hypotheses: state.protocol.max_hypotheses ?? null,
        step_budget: state.protocol.step_budget ?? null,
        evaluation_rubric: state.protocol.evaluation_rubric ?? null,
        created_at: state.protocol.created_at ?? null,
      },
      limitations: {
        state: 'recorded',
        coverage: limits.coverage,
        records: limits.limitations.slice(0, cap).map((limitation) => ({
          id: limitation.id,
          flaw: limitation.flaw,
          state: limitation.state,
          rounds: limitation.rounds_used ?? limitation.rounds ?? null,
          max_rounds: limitation.max_rounds ?? null,
          addressed_by: limitation.addressed_by ?? [],
          covered: Boolean(limitation.covered),
          latest_verdict: limitation.latest_verdict ?? null,
        })),
        omitted_records: Math.max(0, limits.limitations.length - cap),
      },
      ideas: {
        state: 'recorded',
        counts: state.counts,
        rounds: state.rounds,
        matches: state.matches.length,
        champion_id: state.championId,
        rows: [...state.ranked, ...state.hypotheses.filter((hyp) => hyp.status === 'rejected')].slice(0, cap).map((hyp) => ({
          id: hyp.id,
          title: hyp.title,
          status: hyp.status,
          rating: hyp.rating,
          rd: hyp.rd,
          matches: hyp.matchesPlayed,
          limitation_ids: hyp.limitationIds,
          reviews: hyp.reviews.map((review) => `${review.stage}:${review.verdict}`),
        })),
        idea_count: state.hypotheses.length,
        omitted_rows: Math.max(0, [...state.ranked, ...state.hypotheses.filter((hyp) => hyp.status === 'rejected')].length - cap),
      },
      stages,
      selection: selection
        ? {
          state: 'recorded',
          idea_id: selection.hypothesisId,
          selection_id: selection.id,
          compared_ids: selection.compared_ids ?? [],
          evidence_digest: selection.evidence_digest ?? null,
          rationale: selection.rationale ?? '',
          experiment: selection.experiment ?? null,
          ts: selection.ts ?? null,
          history: state.selections.length,
        }
        : { state: 'not_recorded' },
      ablation: { state: ablationRows.length ? 'recorded' : 'not_linked', rows: ablationRows, note: ablationRows.length ? null : 'No ablation ledger names an idea from this cycle.' },
      reviews: {
        state: reviewRounds.length ? 'recorded' : 'not_recorded',
        cycle_linked: false,
        manuscript: manuscript ?? null,
        rounds: reviewRounds.slice(0, cap),
        omitted_rounds: Math.max(0, reviewRounds.length - cap),
        totals: reviewTotals,
        ledgers: linkedReviewLedgers.map((ledger) => ({
          key: ledger.key,
          input_path: ledger.meta.input?.path ?? null,
          latest_round: ledger.meta.latest_round ?? null,
          rounds: ledger.rounds.length,
          score: ledger.score ? { state: ledger.score.state ?? null, overall: ledger.score.overall ?? ledger.score.score ?? null } : null,
        })),
        note: 'Review rounds are manuscript-linked, not idea-linked; evaluator_kind and token tallies come from the stored rounds.',
      },
      integrity: {
        state: integrityRows.length ? 'recorded' : 'not_linked',
        rows: integrityRows,
        totals: integrityTotals,
        note: 'Integrity columns come from the same readiness roll-up as provenance_audit action=arms; an n/a cell is not a pass.',
      },
      incumbent,
      baseline_gate: baseline,
      cost: costOf({
        analysisDurations: new Map(Object.values(rowsByGroup).flat().flatMap((run) => run.analysis.map((analysis) => [analysis.run_id, analysis.duration_ms]))),
        stageSummaries,
        reviewLedgers: linkedReviewLedgers,
        ablationRows,
        hasIdeation: true,
        hasSelection: Boolean(selection),
      }),
      warnings,
    }
  }

  // The workspace branch selects review rounds by manuscript for display, so the
  // cost block must summarise the same rows — otherwise one report prints two
  // different review totals side by side.
  const selectedReviewLedgers = reviewLedgers.filter((ledger) => reviewMatches(ledger.meta, manuscript))
  const cycles = wanted.length
    ? wanted.map((slug) => build(slug))
    : [{
      id: 'workspace',
      source: 'workspace',
      state: 'recorded',
      problem: {
        source: 'workspace',
        goal: analysisLedgers.flatMap((ledger) => ledger.plans).at(-1)?.plan?.question ?? experimentLedgers[0]?.definition?.question ?? null,
        analyses: analysisLedgers.map((ledger) => analysisPlan(ledger)),
        experiments: experimentLedgers.map((ledger) => ({ slug: ledger.slug, question: ledger.definition?.question ?? null })),
      },
      protocol: null,
      limitations: { state: 'not_recorded', note: 'No coscientist tournament is recorded; limitations are not available.' },
      ideas: { state: 'not_recorded', note: 'No coscientist tournament is recorded; there is no idea pool or selection.' },
      stages: (() => {
        const rowsByGroup = { subset: [], scale_up: [], unstaged: [] }
        for (const ledger of experimentLedgers) {
          const verdicts = latestVerdictMap(ledger.verdicts)
          for (const run of ledger.runs) {
            const analysis = linkedAnalysisForRun(ledger, run, analysisIndex)
            const measured = analysis.map((entry) => entry.duration_ms).filter((value) => value != null)
            rowsByGroup[stageGroup(run.stage)].push({
              experiment: ledger.slug, run_id: run.run_id, role: run.role ?? null, baseline_ref: run.baseline_ref ?? null,
              stage: run.stage ?? null, seed: run.seed ?? null, parent: run.parent ?? null, metrics: run.metrics ?? {},
              protocol_digest: run.protocol_digest ?? null, spec_drift: run.spec_drift?.state ?? null,
              verdict: verdicts.get(run.run_id) ? { verdict: verdicts.get(run.run_id).verdict, forced: Boolean(verdicts.get(run.run_id).forced), reason: verdicts.get(run.run_id).reason ?? null } : null,
              idea_ids: [], analysis,
              recorded_ms: measured.length ? measured.reduce((sum, value) => sum + value, 0) : null,
              missing_duration: measured.length === 0,
            })
          }
        }
        const summaries = [
          summarizeStage('subset', ['subset', 'slice'], rowsByGroup.subset, cap),
          summarizeStage('scale_up', ['full'], rowsByGroup.scale_up, cap),
          summarizeStage('unstaged', ['unstaged'], rowsByGroup.unstaged, cap),
        ]
        return {
          state: summaries.some((summary) => summary.run_count) ? 'recorded' : 'not_recorded',
          subset: summaries[0], scale_up: summaries[1], unstaged: summaries[2], candidates: [],
          note: summaries.some((summary) => summary.run_count) ? null : 'No experiment runs are recorded.',
        }
      })(),
      selection: { state: 'not_recorded', note: 'No coscientist tournament is recorded; there is no selection.' },
      ablation: { state: ablationLedgers.length ? 'recorded' : 'not_recorded', rows: ablationLedgers.map((ledger) => ({ slug: ledger.slug, idea_id: ledger.definition.idea_id ?? null, records: ledger.status?.records ?? ledger.records.length, verdicts: ledger.status?.verdicts ?? 0, latest_verdict: ledger.status?.latest_verdict?.verdict ?? null, attribution: ledger.status?.attribution ?? null, state: ledger.unreadable.length ? 'unknown' : 'recorded', reason: ledger.unreadable[0] ?? null })), note: null },
      reviews: (() => {
        const selected = selectedReviewLedgers
        const rounds = selected.flatMap((ledger) => ledger.rounds.map((round) => ({
          key: ledger.key, round: round.round ?? null, run_id: round.run_id ?? null,
          evaluator_kind: round.evaluator_kind ?? 'held_out', evaluator_kind_source: round.evaluator_kind_source ?? 'inferred',
          duration_ms: durationValue(round.duration_ms), usage: round.usage ?? null, counts: round.counts ?? null,
        })))
        return { state: rounds.length ? 'recorded' : 'not_recorded', cycle_linked: false, manuscript: manuscript ?? null, rounds: rounds.slice(0, cap), totals: { rounds: rounds.length, held_out: rounds.filter((round) => round.evaluator_kind === 'held_out').length, in_distribution: rounds.filter((round) => round.evaluator_kind === 'in_distribution').length, duration_ms: rounds.some((round) => round.duration_ms != null) ? rounds.map((round) => durationValue(round.duration_ms)).filter((value) => value != null).reduce((sum, value) => sum + value, 0) : null, tokens: rounds.some((round) => round.usage && (round.usage.prompt_tokens != null || round.usage.completion_tokens != null)) ? rounds.reduce((sum, round) => sum + (Number(round.usage?.prompt_tokens) || 0) + (Number(round.usage?.completion_tokens) || 0), 0) : null, model_calls: rounds.some((round) => round.usage && round.usage.calls != null) ? rounds.reduce((sum, round) => sum + (Number(round.usage?.calls) || 0), 0) : null }, ledgers: selected.map((ledger) => ({ key: ledger.key, input_path: ledger.meta.input?.path ?? null, latest_round: ledger.meta.latest_round ?? null, rounds: ledger.rounds.length, score: ledger.score ? { state: ledger.score.state ?? null, overall: ledger.score.overall ?? ledger.score.score ?? null } : null })), note: 'Review rounds are manuscript-linked, not idea-linked.' }
      })(),
      integrity: { state: arms.rows.length ? 'recorded' : 'not_recorded', rows: arms.rows, totals: arms.totals, note: 'Workspace-wide readiness; there is no cycle to narrow it to.' },
      incumbent: { state: 'not_recorded', note: 'No selection event; the incumbent is not recorded.' },
      baseline_gate: (() => {
        const rows = analysisLedgers.map((ledger) => baselineGateRow(ledger))
        const gate = aggregateBaseline(rows.filter((row) => row.reference === 'reproduced'), rows.length, 'workspace')
        gate.analyses = rows
        return gate
      })(),
      cost: costOf({
        analysisDurations: new Map(experimentLedgers.flatMap((ledger) => ledger.runs.flatMap((run) => linkedAnalysisForRun(ledger, run, analysisIndex).map((analysis) => [analysis.run_id, analysis.duration_ms])))),
        stageSummaries: (() => {
          const rowsByGroup = { subset: [], scale_up: [], unstaged: [] }
          for (const ledger of experimentLedgers) {
            const verdicts = latestVerdictMap(ledger.verdicts)
            for (const run of ledger.runs) {
              const analysis = linkedAnalysisForRun(ledger, run, analysisIndex)
              const measured = analysis.map((entry) => entry.duration_ms).filter((value) => value != null)
              rowsByGroup[stageGroup(run.stage)].push({ experiment: ledger.slug, run_id: run.run_id, verdict: verdicts.get(run.run_id) ?? null, analysis, recorded_ms: measured.length ? measured.reduce((sum, value) => sum + value, 0) : null, missing_duration: measured.length === 0 })
            }
          }
          return [
            summarizeStage('subset', ['subset', 'slice'], rowsByGroup.subset, cap),
            summarizeStage('scale_up', ['full'], rowsByGroup.scale_up, cap),
            summarizeStage('unstaged', ['unstaged'], rowsByGroup.unstaged, cap),
          ]
        })(),
        reviewLedgers: selectedReviewLedgers,
        ablationRows: ablationLedgers,
        hasIdeation: false,
        hasSelection: false,
      }),
      warnings: experimentLedgers.length ? [] : ['No experiment_log ledger is recorded.'],
    }]

  return {
    decision: ROLLUP_DECISION,
    audit: index.audit,
    index_hash: index.index_hash,
    limit: cap,
    cycles,
    notes: [
      'This is a report over existing ledgers: no frontier store, no promotion event, and no execution.',
      'Missing durations and token tallies are not zero; the cost block lists what was not recorded.',
      'No headline gain is computed, and no average is taken over successful cases only.',
    ],
  }
}



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
