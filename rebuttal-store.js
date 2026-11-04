/**
 * Rebuttal coverage ledger under `<cwd>/.dsh/rebuttal/<slug>/`.
 *
 *   rebuttal.json  write-once round definition (created by the first import)
 *   points.jsonl   append-only imported review points      p0001…
 *   tasks.jsonl    append-only supplementary task stubs    t0001… (capped)
 *   links.jsonl    append-only task → run links, pinned by digest  l0001…
 *   answers.jsonl  append-only author-written responses    a0001…
 *   declines.jsonl append-only recorded author declines    d0001…
 *   imports.jsonl  append-only per-import provenance envelope i0001…
 *   exports/       report.md / rebuttal.json / coverage.csv
 *
 * Posture: this ledger makes no network call (all openreview data is supplied
 * by the caller), never runs or creates an experiment (it links runs that
 * already exist, by id), never edits a manuscript, never writes reviewer
 * prose, and stores no numbers of its own — every metric, verdict, digest,
 * and count it surfaces is read live from a linked ledger by id or is
 * caller-supplied text labelled as such. It never gates a turn: only ah_check
 * blocks. Coverage is this ledger's own reading; inside an ah.yaml project the
 * engine remains authoritative for item status and response prose, and a
 * divergence between the two is surfaced as a warning, never resolved
 * silently.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import {
  appendJsonl, csvCell, ensureDir, exportText, hashFile, mdCell, nowIso, readJson,
  readJsonl, sha256, slug as manuscriptDiffSlug, stableStringify, writeOnceJson,
} from './ledger-kit.js'
import { withLock } from './store-lock.js'
import { resolveWorkspacePath } from './workspace-path.js'
import { readExperiment, listExperimentRuns, latestVerdicts, EXPERIMENT_BASELINE_REFS } from './experiment-store.js'
import { currentPlan, listAnalysisRuns } from './analysis-store.js'
import { normalizeText, matchPool } from './deep-review.js'
import { findAhRoot } from './academic-harness.js'

export const REBUTTAL_SOURCES = ['deep_review', 'ah_review', 'openreview']
export const REBUTTAL_POINT_KINDS = ['question', 'weakness', 'comment', 'checklist', 'claim']
export const REBUTTAL_EXPECTED_EVIDENCE = ['metric_table', 'additional_baseline', 'ablation',
  'statistical_evidence', 'reproducibility_detail', 'text_revision', 'citation_fix', 'no_experiment_expected']
export const REBUTTAL_REPLICATES_BASIS = ['power_analysis', 'pilot', 'literature', 'budget', 'venue_requirement', 'author_judgement']
export const REBUTTAL_COVERAGE_STATES = ['answered', 'answered_asserted', 'declined_verified', 'declined_recorded', 'unaddressed']
export const REBUTTAL_EXPORT_FORMATS = ['markdown', 'json', 'csv']
export const REBUTTAL_LETTER_FORMATS = ['markdown', 'latex']
export const REBUTTAL_DEFAULT_MAX_TASKS = 20

export { EXPERIMENT_BASELINE_REFS }

const MAX_POINTS_PER_IMPORT = 500
const TEXT_CLIP = 2000
const DETAIL_CLIP = 4000
const QUOTE_CLIP = 600
const RESPONSE_CLIP = 8000
const MAX_COVERAGE_ROWS = 200
const MAX_ENVELOPES_SHOWN = 5
const MAX_TASKS_LIMIT = 200
const LETTER_RETURN_CLIP = 20000
const MAX_REPLICATES = 100
// deep-review's own stored-digest caps (deep-review.js:47-49). The digest
// slices before any filtering, so a non-latest round can silently lose real
// weaknesses; the reader detects that against the digest's uncapped counts.
const ROUND_COMMENT_CAP = 200
const ROUND_QUESTION_CAP = 60
const ROUND_CLAIM_CAP = 200

const OUTCOME_NOTE = 'Coverage counts whether a point was answered with cited evidence, never whether it helped: a linked run with verdict bad or engineer, a spec_drift state, a drifted digest, or a non-zero exit stays recorded and reportable and does not reduce coverage. Advisory only; nothing here gates a turn — only ah_check blocks.'

const CLOSE_CAVEAT = 'a closed finding is a lead, not proof the criticism was resolved; when input_sha1 matches the imported round the movement is reviewer variance, not revision'

const VERDICT_RANK = { bad: 0, engineer: 1, good: 2 }

function text(value) {
  return String(value ?? '').trim()
}

function clip(value, max) {
  const raw = typeof value === 'string' ? value : value == null ? '' : String(value)
  if (raw.length <= max) return raw
  return `${raw.slice(0, Math.max(0, max - 1))}…`
}

function objectValue(value, name) {
  if (value == null || value === '') return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}

/**
 * Slug rule for THIS ledger: review-store's reviewSlug shape — it throws on an
 * empty result instead of silently producing a `.dsh/rebuttal//` path. The
 * ledger-kit `slug()` is only used for the FOREIGN manuscript-diff path
 * because that is the sanitizer manuscript-diff itself uses (deriveSlug).
 */
export function rebuttalSlug(value) {
  const out = text(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  if (!out) throw new Error('slug must contain at least one letter or digit')
  return out
}

export function files(cwd, slugValue) {
  const dir = join(resolve(cwd), '.dsh', 'rebuttal', rebuttalSlug(slugValue))
  return {
    dir,
    definition: join(dir, 'rebuttal.json'),
    points: join(dir, 'points.jsonl'),
    tasks: join(dir, 'tasks.jsonl'),
    links: join(dir, 'links.jsonl'),
    answers: join(dir, 'answers.jsonl'),
    declines: join(dir, 'declines.jsonl'),
    imports: join(dir, 'imports.jsonl'),
    exports: join(dir, 'exports'),
  }
}

function allocatedId(prefix, rows) {
  return `${prefix}${String(rows.length + 1).padStart(4, '0')}`
}

function sourceDigest(run) {
  return `sha256:${sha256(stableStringify(run))}`
}

export { sourceDigest }

/** cwd-relative display path; falls back to a prefix strip when realpath disagrees (symlinked roots). */
function relFrom(cwd, abs) {
  const rel = relative(resolve(cwd), abs)
  const out = rel && !rel.startsWith('..') ? rel : abs.slice(resolve(cwd).length + 1)
  return out.replace(/\\/g, '/')
}

function payloadSha256(point) {
  return `sha256:${sha256(stableStringify({
    native_id: point.native_id,
    kind: point.kind,
    severity: point.severity,
    source_label: point.source_label,
    text: point.text,
    location: point.location,
    quote: point.quote,
  }))}`
}

/** Global dedupe key for ALL sources — defined once here (§1.2). */
function dedupeKey(point) {
  return [point.source, point.native_id].join('\u0000')
}

/** Copy of manuscript-diff's latexEscape (manuscript-diff.js:435); the sibling file stays untouched. */
function latexEscapeText(value) {
  const placeholder = '\u0000'
  return String(value ?? '')
    .replace(/\\/g, placeholder)
    .replace(/([#$%&_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replaceAll(placeholder, '\\textbackslash{}')
}

/* ------------------------------------------------------------------ lists */

export function listRebuttalPoints(cwd, slugValue) {
  return readJsonl(files(cwd, slugValue).points)
}

export function listRebuttalTasks(cwd, slugValue) {
  return readJsonl(files(cwd, slugValue).tasks)
}

export function listRebuttalLinks(cwd, slugValue) {
  return readJsonl(files(cwd, slugValue).links)
}

export function listRebuttalAnswers(cwd, slugValue) {
  return readJsonl(files(cwd, slugValue).answers)
}

export function listRebuttalDeclines(cwd, slugValue) {
  return readJsonl(files(cwd, slugValue).declines)
}

export function listRebuttalImports(cwd, slugValue) {
  return readJsonl(files(cwd, slugValue).imports)
}

export function readRebuttal(cwd, slugValue) {
  const f = files(cwd, slugValue)
  const definition = readJson(f.definition)
  if (!definition) throw new Error(`rebuttal "${rebuttalSlug(slugValue)}" not found under .dsh/rebuttal/${rebuttalSlug(slugValue)}; run action "import" first`)
  return definition
}

function requirePoints(cwd, slugValue) {
  const points = listRebuttalPoints(cwd, slugValue)
  if (!points.length) throw new Error(`rebuttal "${rebuttalSlug(slugValue)}" has no points; run action "import" first`)
  return points
}

function findPoint(points, pointId, slugValue) {
  const id = text(pointId)
  if (!id) throw new Error('point_id is required')
  const point = points.find((entry) => entry.point_id === id)
  if (!point) throw new Error(`point "${id}" not found in rebuttal "${rebuttalSlug(slugValue)}"`)
  return point
}

function findTask(tasks, taskId, slugValue) {
  const id = text(taskId)
  if (!id) throw new Error('task_id is required')
  const task = tasks.find((entry) => entry.task_id === id)
  if (!task) throw new Error(`task "${id}" not found in rebuttal "${rebuttalSlug(slugValue)}"`)
  return task
}

/* --------------------------------------------------------- deep_review read */

function sha1Hex(value) {
  return createHash('sha1').update(value).digest('hex')
}

function deepReviewDirHasStore(cwd, key) {
  return existsSync(join(resolve(cwd), '.dsh', 'deep-review', key, 'meta.json'))
}

function resolveDeepReviewKey(cwd, value) {
  const raw = text(value)
  if (!raw) throw new Error('deep_review_key is required (the store key or the manuscript path)')
  const root = resolve(cwd)
  if (/^[0-9a-f]{16}$/.test(raw) && deepReviewDirHasStore(cwd, raw)) {
    return { key: raw, resolution: 'exact' }
  }
  // Path form: the same derivation deep-review.js uses — sha1 over the
  // workspace-relative path, keyed against the REAL cwd so a symlinked root
  // keys consistently. Retry with the unresolved cwd as the relative base.
  try {
    const abs = resolveWorkspacePath(cwd, raw)
    if (existsSync(abs) && statSync(abs).isFile()) {
      let rootReal = root
      try {
        rootReal = realpathSync(root)
      } catch {
        rootReal = root
      }
      const candidates = [
        sha1Hex(relative(rootReal, abs)).slice(0, 16),
        sha1Hex(relative(root, abs)).slice(0, 16),
      ]
      for (const key of candidates) {
        if (deepReviewDirHasStore(cwd, key)) return { key, resolution: 'path' }
      }
    }
  } catch {
    // not a readable workspace path — fall through to the basename match
  }
  const base = basename(raw)
  const storeRoot = join(root, '.dsh', 'deep-review')
  const hits = []
  let names = []
  try {
    names = readdirSync(storeRoot)
  } catch {
    names = []
  }
  for (const name of names) {
    if (name === '.lock' || !/^[0-9a-f]{16}$/.test(name)) continue
    // Enumeration is a best-effort lookup over OTHER stores: a directory with
    // no meta or an unreadable meta is skipped, exactly like the absent-meta
    // case. The selected store's own corrupt artifact still throws later.
    let meta = null
    try {
      meta = readJson(join(storeRoot, name, 'meta.json'))
    } catch {
      meta = null
    }
    if (!meta || typeof meta !== 'object') continue
    const inputPath = meta?.input?.path ?? null
    const fileName = meta?.input?.file_name ?? null
    if ((inputPath && (inputPath === raw || basename(inputPath) === base)) || (fileName && fileName === base)) {
      hits.push({ key: name, path: inputPath, round: meta.latest_round ?? null })
    }
  }
  if (hits.length === 1) return { key: hits[0].key, resolution: 'basename_match' }
  if (hits.length > 1) {
    throw new Error(`deep review key for "${raw}" is ambiguous (${hits.map((hit) => `${hit.key} → ${hit.path} (round ${hit.round ?? '?'})`).join(', ')}); pass the 16-character store key`)
  }
  throw new Error(`no stored deep review for "${raw}" under .dsh/deep-review/; run deep_review action="review" on the manuscript first, or pass the 16-character store key`)
}

function locationFromRich(location) {
  const pdf = location?.pdf
  if (pdf && Number.isFinite(Number(pdf.pageNumber))) return `page ${pdf.pageNumber}`
  const t = location?.text
  if (t && Number.isFinite(Number(t.firstLine))) {
    return t.lastLine && t.lastLine !== t.firstLine ? `lines ${t.firstLine}-${t.lastLine}` : `line ${t.firstLine}`
  }
  return null
}

function quoteFromRich(location) {
  return clip(location?.pdf?.quoteSelector?.exact || location?.text?.quotedLinePreview || '', QUOTE_CLIP) || null
}

function joinDetail(parts) {
  const body = parts.filter(Boolean).join('\n')
  return body ? clip(body, DETAIL_CLIP) : null
}

/**
 * Per-kind match keys, exactly as the engine builds them for its own items
 * (deep-review.js commentMatchKeys/reviewDigest). Never a uniform three tiers
 * for all five kinds: question/claim native ids are positional, so minting an
 * `id:` tier would pair round 1's question 1 with round 2's question 1
 * regardless of wording and invert the closed/still-present reading.
 * Clip asymmetry: digest quotes clip at 200 while this store clips `quote` at
 * 600; a point imported from a digest reuses its persisted keys, which keeps
 * the quote: tier at the digest's own depth automatically.
 */
function buildKeys(point) {
  if (Array.isArray(point.keys) && point.keys.length) return point.keys
  const summary = normalizeText(point.text)
  const quote = normalizeText(point.quote)
  if (point.kind === 'question') return summary ? [`question:${summary}`] : []
  if (point.kind === 'claim') return summary ? [`claim:${summary}`] : []
  if (point.kind === 'checklist') return []
  const keys = []
  if (point.native_id) keys.push(`id:${point.native_id}`)
  if (summary) keys.push(`summary:${summary}`)
  if (point.source === 'ah_review') return keys
  if (quote) keys.push(`quote:${quote}`)
  return keys
}

/**
 * The native id of a deep-review point is scoped to its round. Positional
 * ids (q-1, claim-…, checklist-…) repeat across rounds, so an unscoped id
 * would make a later round's point dedupe into the first round's row and
 * report drift instead of storing the new round as its own point. Re-importing
 * the SAME round keeps the same ids and still dedupes.
 */
function roundNativeId(refInfo, id) {
  const run = text(refInfo?.source_ref?.run_id)
  const round = refInfo?.source_ref?.round
  const scope = run || (round != null ? `round-${round}` : '')
  return scope ? `${scope}:${id}` : id
}

/** A checklist item's identity is its engine key, which is stable across rounds. */
function checklistKeys(item) {
  const key = text(item?.key)
  return key ? [`id:checklist:${key}`] : []
}

function deepReviewPointBase(refInfo) {
  return {
    source: 'deep_review',
    reviewer: {
      kind: 'ai',
      id: `ai:deep-review:${refInfo.model || 'unknown'}`,
      label: refInfo.model || null,
      identity_source: 'round_model',
    },
    // Copied verbatim from the round — never defaulted, never rewritten.
    evaluator_kind: refInfo.evaluator_kind ?? null,
    evaluator_kind_source: refInfo.evaluator_kind_source ?? null,
  }
}

function mapDigestComments(digest, base, refInfo, counts) {
  const out = []
  for (const comment of digest?.comments || []) {
    const nativeId = text(comment?.comment_id)
    if (!nativeId) continue
    if (/^section-/.test(nativeId)) {
      counts.excluded_section_comments += 1
      continue
    }
    const severity = text(comment?.severity) || null
    const kind = severity === 'CRITICAL' || severity === 'MAJOR' ? 'weakness' : 'comment'
    const point = {
      ...base,
      source_ref: { ...refInfo.source_ref, citation_ref: comment?.citation_ref ?? null, citation_verdict: comment?.citation_verdict ?? null },
      kind,
      severity,
      source_label: severity,
      text: clip(comment?.summary || '', TEXT_CLIP) || null,
      detail: null,
      location: text(comment?.location) || null,
      quote: clip(comment?.quote || '', QUOTE_CLIP) || null,
      // Persisted keys are reused verbatim: the newer round is paired against
      // the same strings the engine stored.
      keys: Array.isArray(comment?.keys) ? comment.keys : undefined,
      native_id: roundNativeId(refInfo, nativeId),
    }
    point.keys = buildKeys(point)
    out.push(point)
  }
  return out
}

function mapDigestQuestions(digest, base, refInfo) {
  const out = []
  return out.concat((digest?.questions || []).map((question, index) => {
    const nativeId = `q-${question?.number ?? index + 1}`
    const point = {
      ...base,
      source_ref: { ...refInfo.source_ref },
      kind: 'question',
      severity: null,
      source_label: null,
      text: clip(question?.question || '', TEXT_CLIP) || null,
      detail: null,
      location: null,
      quote: null,
      keys: Array.isArray(question?.keys) ? question.keys : undefined,
      native_id: roundNativeId(refInfo, nativeId),
    }
    point.keys = buildKeys(point)
    return point
  }))
}

function mapDigestClaims(digest, base, refInfo) {
  const out = []
  return out.concat((digest?.claims || []).filter((claim) => ['UNSUPPORTED', 'OVERCLAIMED'].includes(String(claim?.status || '').toUpperCase())).map((claim) => {
    const point = {
      ...base,
      source_ref: { ...refInfo.source_ref, evidence_type: claim?.evidence_type ?? null },
      kind: 'claim',
      severity: null,
      source_label: text(claim?.status) || null,
      text: clip(claim?.claim || '', TEXT_CLIP) || null,
      detail: null,
      location: null,
      quote: null,
      keys: Array.isArray(claim?.keys) ? claim.keys : undefined,
      native_id: roundNativeId(refInfo, `claim-${claim?.claim_id ?? 'unknown'}`),
    }
    point.keys = buildKeys(point)
    return point
  }))
}

function mapDigestChecklist(digest, base, refInfo, counts) {
  const out = []
  for (const item of digest?.checklist || []) {
    const status = String(item?.status || '').toUpperCase()
    if (!['NO', 'PARTIAL'].includes(status)) {
      counts.skipped_checklist_yes_na += 1
      continue
    }
    out.push({
      ...base,
      source_ref: { ...refInfo.source_ref },
      kind: 'checklist',
      severity: null,
      source_label: status,
      text: clip(item?.label || item?.key || '', TEXT_CLIP) || null,
      detail: null,
      location: null,
      quote: null,
      keys: checklistKeys(item),
      native_id: roundNativeId(refInfo, `checklist-${item?.key ?? 'unknown'}`),
    })
  }
  return out
}

function mapFullComments(comments, base, refInfo, counts) {
  const out = []
  for (const comment of comments) {
    const nativeId = text(comment?.commentId)
    if (!nativeId) continue
    if (/^section-/.test(nativeId)) {
      counts.excluded_section_comments += 1
      continue
    }
    const severity = text(comment?.severity) || null
    const kind = severity === 'CRITICAL' || severity === 'MAJOR' ? 'weakness' : 'comment'
    const point = {
      ...base,
      source_ref: { ...refInfo.source_ref, citation_ref: comment?.citationReport?.refNum ?? null, citation_verdict: comment?.citationReport?.finalVerdict ?? null },
      kind,
      severity,
      source_label: severity,
      text: clip(comment?.summary || '', TEXT_CLIP) || null,
      detail: joinDetail([
        comment?.bodyMarkdown ? text(comment.bodyMarkdown) : null,
        comment?.suggestedEdit ? `Suggested edit: ${text(comment.suggestedEdit)}` : null,
      ]),
      location: locationFromRich(comment?.location),
      quote: quoteFromRich(comment?.location),
      native_id: roundNativeId(refInfo, nativeId),
    }
    point.keys = buildKeys(point)
    out.push(point)
  }
  return out
}

function mapFullQuestions(questions, base, refInfo) {
  return questions.map((question, index) => {
    const point = {
      ...base,
      source_ref: { ...refInfo.source_ref },
      kind: 'question',
      severity: null,
      source_label: null,
      text: clip(question?.question || '', TEXT_CLIP) || null,
      detail: joinDetail([
        question?.linkedIssueSummary ? text(question.linkedIssueSummary) : null,
        question?.howResponseChangesEvaluation ? `How a response changes the evaluation: ${text(question.howResponseChangesEvaluation)}` : null,
      ]),
      location: null,
      quote: null,
      native_id: roundNativeId(refInfo, `q-${question?.questionNumber ?? index + 1}`),
    }
    point.keys = buildKeys(point)
    return point
  })
}

function mapFullClaims(claims, base, refInfo) {
  return claims.filter((claim) => ['UNSUPPORTED', 'OVERCLAIMED'].includes(String(claim?.status || '').toUpperCase())).map((claim) => {
    const point = {
      ...base,
      source_ref: { ...refInfo.source_ref, evidence_type: claim?.evidenceType ?? null },
      kind: 'claim',
      severity: null,
      source_label: text(claim?.status) || null,
      text: clip(claim?.claim || '', TEXT_CLIP) || null,
      detail: claim?.gapAnalysis ? clip(text(claim.gapAnalysis), DETAIL_CLIP) : null,
      location: null,
      quote: null,
      native_id: roundNativeId(refInfo, `claim-${claim?.claimId ?? 'unknown'}`),
    }
    point.keys = buildKeys(point)
    return point
  })
}

function mapFullChecklist(checklist, base, refInfo, counts) {
  const out = []
  for (const item of checklist) {
    const status = String(item?.status || '').toUpperCase()
    if (!['NO', 'PARTIAL'].includes(status)) {
      counts.skipped_checklist_yes_na += 1
      continue
    }
    out.push({
      ...base,
      source_ref: { ...refInfo.source_ref },
      kind: 'checklist',
      severity: null,
      source_label: status,
      text: clip(item?.label || item?.key || '', TEXT_CLIP) || null,
      detail: item?.evidenceAndSuggestion ? clip(text(item.evidenceAndSuggestion), DETAIL_CLIP) : null,
      location: null,
      quote: null,
      keys: checklistKeys(item),
      native_id: roundNativeId(refInfo, `checklist-${item?.key ?? 'unknown'}`),
    })
  }
  return out
}

/**
 * Read a stored deep_review round directly from .dsh/deep-review/<key>/,
 * exactly as provenance-store.js's readDeepReviewLedger does. readJson throws
 * on invalid JSON — a corrupt round must never read as "no points"; at import
 * that throw propagates, at closing-time the caller catches it per §4.6.
 * Never writes into the deep-review directory.
 */
export function readDeepReviewRound(cwd, selector, roundSelector = null) {
  const { key, resolution } = resolveDeepReviewKey(cwd, selector)
  const root = resolve(cwd)
  const dir = join(root, '.dsh', 'deep-review', key)
  const metaFile = join(dir, 'meta.json')
  const meta = readJson(metaFile)
  if (!meta || typeof meta !== 'object') throw new Error(`no stored deep review for "${text(selector)}" under .dsh/deep-review/; run deep_review action="review" on the manuscript first, or pass the 16-character store key`)
  const reviewJson = join(dir, 'review.json')
  let entries = Array.isArray(meta.rounds) && meta.rounds.length
    ? meta.rounds.filter(Boolean).map((entry, index) => ({ ...entry, round: entry.round ?? index + 1 }))
    : []
  let legacy = false
  if (!entries.length && existsSync(reviewJson)) {
    // schemaVersion 1 store: review.json is the single available round.
    entries = [{
      round: meta.latest_round ?? 1,
      run_id: meta?.last_run?.action === 'review' ? meta.last_run.run_id : `legacy-${sha1Hex(`${meta?.review?.finished_at ?? ''}|${meta?.input?.sha1 ?? ''}`).slice(0, 12)}`,
      input_sha1: meta?.input?.sha1 ?? null,
      evaluator_kind: meta?.review?.evaluator_kind ?? meta?.params?.evaluator_kind ?? 'held_out',
      evaluator_kind_source: (meta?.review?.evaluator_kind ?? meta?.params?.evaluator_kind) ? 'declared' : 'inferred',
      rubric_round: meta?.params?.rubric_round ?? null,
      model: meta?.last_run?.model ?? null,
    }]
    legacy = true
  }
  if (!entries.length) throw new Error(`no stored review rounds for deep review ${key}; run deep_review action="review" on the manuscript first`)
  const wanted = text(roundSelector)
  let entry
  if (!wanted) {
    const latest = meta.latest_round ?? entries.at(-1).round
    entry = entries.find((row) => row.round === latest) ?? entries.at(-1)
  } else {
    const asNumber = Number(wanted)
    entry = (Number.isInteger(asNumber) && asNumber > 0 ? entries.find((row) => row.round === asNumber) : null)
      || entries.find((row) => row.run_id === wanted)
      || null
    if (!entry) throw new Error(`no stored round "${wanted}" for deep review ${key} (rounds 1–${entries.length} exist; pass a round number or run_id)`)
  }
  const latestRound = meta.latest_round ?? entries.at(-1).round
  const isLatest = entry.round === latestRound
  const roundsFile = join(dir, 'rounds', `${entry.run_id}.json`)
  const counts = {
    point_total_in_source: 0,
    excluded_section_comments: 0,
    skipped_checklist_yes_na: 0,
    truncated_by_source_cap: 0,
  }
  const base = deepReviewPointBase({
    model: entry.model ?? null,
    evaluator_kind: legacy ? entry.evaluator_kind : (entry.evaluator_kind ?? null),
    evaluator_kind_source: legacy ? entry.evaluator_kind_source : (entry.evaluator_kind_source ?? null),
  })
  const refInfo = {
    // rubric_round rides on every point's source_ref (§3.1): an
    // in-distribution round must say which round fed it, point by point.
    source_ref: { run_id: entry.run_id, round: entry.round, rubric_round: entry.rubric_round ?? null },
    model: entry.model ?? null,
    evaluator_kind: base.evaluator_kind,
    evaluator_kind_source: base.evaluator_kind_source,
    rubric_round: entry.rubric_round ?? null,
  }
  let items = []
  let artifact = null
  let sourceTruncated = false
  if (isLatest && existsSync(reviewJson)) {
    // Prefer review.json's FULL result arrays: the stored digest applies the
    // 200/60/200 caps before this reader drops section pseudo-comments, so a
    // digest-only read could silently lose real MAJOR/CRITICAL weaknesses.
    artifact = 'review.json'
    const review = readJson(reviewJson)
    const result = review?.result && typeof review.result === 'object' ? review.result : {}
    const comments = Array.isArray(result.anchoredComments) ? result.anchoredComments : []
    const questions = Array.isArray(result.questionsForAuthors) ? result.questionsForAuthors : []
    const claims = Array.isArray(result.claimEvidenceMap) ? result.claimEvidenceMap : []
    const checklist = Array.isArray(result.reproducibilityChecklist) ? result.reproducibilityChecklist : []
    counts.point_total_in_source = comments.length + questions.length + claims.length + checklist.length
    items = [
      ...mapFullQuestions(questions, base, refInfo),
      ...mapFullComments(comments, base, refInfo, counts),
      ...mapFullClaims(claims, base, refInfo),
      ...mapFullChecklist(checklist, base, refInfo, counts),
    ]
  } else {
    if (!existsSync(roundsFile)) {
      if (!existsSync(reviewJson)) throw new Error(`no stored round digest for ${entry.run_id} under ${relative(cwd, join(dir, 'rounds')).replace(/\\/g, '/') || '.dsh/deep-review/rounds'} and no review.json for deep review ${key}`)
      throw new Error(`no stored round digest for ${entry.run_id} under .dsh/deep-review/${key}/rounds/; the round files were edited or deleted out of band`)
    }
    artifact = `rounds/${entry.run_id}.json`
    const digest = readJson(roundsFile)
    const storedComments = (digest?.comments || []).length
    const storedQuestions = (digest?.questions || []).length
    // digest counts.comments / counts.questions are pre-slice (deep-review.js:789-796),
    // so the gap against the stored arrays measures what the 200/60 caps dropped.
    // claims_by_status is computed POST-cap and cannot be measured from the stored
    // digest — the claim shortfall is reported only through the cap sentence itself.
    const lostComments = Math.max(0, (digest?.counts?.comments ?? storedComments) - storedComments)
    const lostQuestions = Math.max(0, (digest?.counts?.questions ?? storedQuestions) - storedQuestions)
    counts.truncated_by_source_cap = lostComments + lostQuestions
    sourceTruncated = lostComments > 0 || lostQuestions > 0
    counts.point_total_in_source = (digest?.counts?.comments ?? storedComments)
      + (digest?.counts?.questions ?? storedQuestions)
      + (digest?.claims || []).length
      + (digest?.checklist || []).length
    items = [
      ...mapDigestQuestions(digest, base, refInfo),
      ...mapDigestComments(digest, base, refInfo, counts),
      ...mapDigestClaims(digest, base, refInfo),
      ...mapDigestChecklist(digest, base, refInfo, counts),
    ]
  }
  const warnings = []
  if (sourceTruncated || counts.truncated_by_source_cap > 0) {
    warnings.push(`the stored round keeps at most ${ROUND_COMMENT_CAP} comments / ${ROUND_QUESTION_CAP} questions / ${ROUND_CLAIM_CAP} claims; ${counts.truncated_by_source_cap} points were never stored — re-run deep_review on the manuscript, or accept the shortfall and say so in the letter`)
  }
  const ref = {
    key,
    key_resolution: resolution,
    dir: relative(cwd, dir).replace(/\\/g, '/'),
    run_id: entry.run_id,
    round: entry.round,
    artifact,
    source_truncated: sourceTruncated || counts.truncated_by_source_cap > 0,
    input_sha1: entry.input_sha1 ?? (legacy ? (meta?.input?.sha1 ?? null) : null),
    manuscript: meta?.input?.path ?? null,
    evaluator_kind: base.evaluator_kind,
    evaluator_kind_source: base.evaluator_kind_source,
    rubric_round: refInfo.rubric_round,
    model: refInfo.model,
    available_rounds: entries.length,
    legacy_round: legacy ? true : null,
  }
  return { ref, reviewer: base.reviewer, evaluator_kind: base.evaluator_kind, evaluator_kind_source: base.evaluator_kind_source, items, counts, warnings }
}

/* ----------------------------------------------------------- ah_review read */

function ahReviewsDir(root) {
  try {
    const raw = readFileSync(join(root, 'ah.yaml'), 'utf8')
    const match = /^reviews:\s*(\S+)\s*$/m.exec(raw)
    if (!match) return 'reviews'
    return match[1].replace(/^["']|["']$/g, '')
  } catch {
    return 'reviews'
  }
}

/**
 * Read `<ah-root>/<reviews-dir>/<rid>.yaml` written by the engine. The engine
 * stores NO per-item reviewer identity, so the reviewer is unattributed —
 * stated rather than guessed. A corrupt review throws; it never reads as zero
 * items.
 */
export async function readAhReview(cwd, rid, deps = {}) {
  const id = text(rid)
  if (!id) throw new Error('ah_review is required (the review id, e.g. R1)')
  if (!/^[A-Za-z0-9_.-]+$/.test(id) || id.includes('..')) {
    throw new Error(`ah review id "${id}" must be a plain id without dots or path separators (the item ids reverse-map by rsplit(".", 1), e.g. R1.2)`)
  }
  const root = findAhRoot(resolve(cwd))
  if (!root) throw new Error(`ah_review items can only be imported inside an Academic Harness project (no ah.yaml above ${resolve(cwd)}); import the deep_review round or supplied openreview reviews instead`)
  const dirName = ahReviewsDir(root)
  const relFile = join(dirName, `${id}.yaml`)
  const absFile = join(root, relFile)
  if (!existsSync(absFile)) throw new Error(`no ah review "${id}" at ${relative(resolve(cwd), absFile).replace(/\\/g, '/')}`)
  let parseYaml = deps.parseYaml || null
  if (!parseYaml) {
    try {
      const module = await import('yaml')
      parseYaml = module.parse
    } catch {
      parseYaml = null
    }
  }
  if (!parseYaml) throw new Error('the yaml parser is unavailable, so ah review items cannot be read')
  const review = parseYaml(readFileSync(absFile, 'utf8'))
  if (!review || typeof review !== 'object' || !Array.isArray(review.items)) {
    throw new Error(`${relative(resolve(cwd), absFile).replace(/\\/g, '/')} is not an ah review file with an items list`)
  }
  const reviewer = {
    kind: 'unattributed',
    id: `ah_review:${id}`,
    label: text(review.source) || null,
    identity_source: 'review_not_person',
  }
  const items = []
  for (const item of review.items) {
    const itemId = text(item?.id)
    if (!itemId) continue
    const ahKind = text(item?.kind).toLowerCase()
    if (!['major', 'minor'].includes(ahKind)) {
      throw new Error(`ah review "${id}" item "${itemId}" has kind "${ahKind || '(none)'}"; the engine stores only major|minor`)
    }
    items.push({
      source: 'ah_review',
      reviewer,
      evaluator_kind: null,
      evaluator_kind_source: 'not_applicable',
      source_ref: {
        rid: id,
        item_id: itemId,
        ah_kind: ahKind,
        status_at_import: text(item?.status) || 'open',
        units_at_import: Array.isArray(item?.units) ? item.units : [],
        response_at_import: Boolean(text(item?.response)),
        snapshot: text(review.snapshot) || null,
        source_basename: text(review.source) || null,
        file: relFile.replace(/\\/g, '/'),
      },
      kind: ahKind === 'major' ? 'weakness' : 'comment',
      severity: ahKind,
      source_label: ahKind,
      text: clip(item?.text || '', TEXT_CLIP) || null,
      detail: null,
      location: null,
      quote: null,
      keys: buildKeys({ source: 'ah_review', kind: ahKind, native_id: itemId, text: item?.text ?? '', quote: null }),
      native_id: itemId,
    })
  }
  return {
    items,
    reviewer,
    ref: {
      rid: id,
      root,
      file: relFile.replace(/\\/g, '/'),
      manuscript: review.manuscript ? relative(root, resolve(root, String(review.manuscript))).replace(/\\/g, '/') : null,
      source_basename: text(review.source) || null,
      snapshot: text(review.snapshot) || null,
      item_total: items.length,
    },
    live: review,
    root,
  }
}

/* ------------------------------------------------------- openreview read */

function orvField(note, key) {
  const content = note?.content
  if (content && typeof content === 'object' && key in content) {
    const raw = content[key]
    return raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw
  }
  const flat = note?.[key]
  return flat && typeof flat === 'object' && 'value' in flat && !Array.isArray(flat) ? flat.value : flat
}

function orvText(value) {
  if (value == null) return null
  const raw = Array.isArray(value) ? value.map((entry) => String(entry ?? '')).filter(Boolean).join('\n\n') : String(value)
  const trimmed = raw.trim()
  return trimmed || null
}

function orvSignatures(note) {
  const raw = note?.signatures
  const arr = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && Array.isArray(raw.value) ? raw.value : [])
  return arr.map((entry) => text(entry)).filter(Boolean)
}

function orvInvitations(note) {
  if (Array.isArray(note?.invitations)) return note.invitations.map(String)
  if (typeof note?.invitation === 'string' && note.invitation) return [note.invitation]
  return []
}

function orvIdentity(note, id) {
  const signatures = orvSignatures(note)
  if (signatures.length) {
    const segment = signatures[0].split('/').filter(Boolean).pop() || signatures[0]
    return { kind: 'human', id: `openreview:${segment}`, label: segment, identity_source: 'signature' }
  }
  if (id) return { kind: 'human', id: `openreview:${id}`, label: id, identity_source: 'note_id' }
  const invitation = orvInvitations(note)[0] || null
  return { kind: 'human', id: `openreview:${invitation || 'unattributed'}`, label: invitation, identity_source: invitation ? 'invitation' : 'review_not_person' }
}

/**
 * Supplied openreview data only — this reader never fetches. Accepts a bare
 * array, {reviews}, {results}, {records}, or raw OpenReview {notes}. Tool-shaped
 * (flat keys, post §6.4 passthrough) and raw-note ({content}, wrapped {value})
 * forms are unwrapped with the same rule as openreview.js's value(): missing
 * stays missing, never backfilled.
 */
export function readOpenReviewSupplied(cwd, { reviews = null, reviewsPath = null, fetchedAt = null, forumIdArg = null } = {}) {
  if (forumIdArg != null && text(forumIdArg) !== '') {
    throw new Error('rebuttal does not call openreview: run the openreview tool yourself, then pass its reviews array to import')
  }
  let batch = null
  let input = 'reviews'
  let inputSha = null
  let absFile = null
  let relFile = null
  if (reviews != null && reviews !== '') {
    if (Array.isArray(reviews)) batch = reviews
    else if (typeof reviews === 'object' && (Array.isArray(reviews.reviews) || Array.isArray(reviews.results) || Array.isArray(reviews.records) || Array.isArray(reviews.notes))) {
      batch = reviews.reviews || reviews.results || reviews.records || reviews.notes
    } else throw new Error('reviews must be an array of review objects (the openreview action="reviews" output this session already has)')
    input = 'reviews'
  } else if (reviewsPath != null && text(reviewsPath) !== '') {
    relFile = text(reviewsPath)
    absFile = resolveWorkspacePath(cwd, relFile)
    if (!existsSync(absFile) || !statSync(absFile).isFile()) throw new Error(`file not found: ${relFile}`)
    if (statSync(absFile).size > 50 * 1024 * 1024) throw new Error(`reviews_path is larger than 50 MB: ${relFile}`)
    input = 'reviews_path'
  } else {
    throw new Error('rebuttal import never fetches: pass reviews (the openreview action="reviews" output this session already has) or reviews_path to a workspace file containing it')
  }
  if (!batch) {
    let body
    try {
      body = JSON.parse(readFileSync(absFile, 'utf8'))
    } catch (error) {
      throw new Error(`${relFile} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (Array.isArray(body)) batch = body
    else if (body && typeof body === 'object' && (Array.isArray(body.reviews) || Array.isArray(body.results) || Array.isArray(body.records) || Array.isArray(body.notes))) {
      batch = body.reviews || body.results || body.records || body.notes
    } else throw new Error(`${relFile} must contain a reviews/results/records/notes array`)
  }
  if (!Array.isArray(batch) || !batch.length) throw new Error('the supplied openreview batch is empty; pass the reviews array from the openreview tool')
  inputSha = absFile ? `sha256:${hashFile(absFile)}` : `sha256:${sha256(stableStringify(batch))}`

  const counts = { skipped_rebuttal_notes: 0, non_review_notes: 0, strength_fields_seen: 0 }
  const reviewersList = []
  const items = []
  let forumId = null
  let decision = null
  for (const [noteIndex, note] of batch.entries()) {
    if (!note || typeof note !== 'object') continue
    const noteForum = note.forum ?? note.id ?? null
    if (noteForum && !forumId) forumId = noteForum
    const invitations = orvInvitations(note)
    const joined = invitations.join(' ')
    const noteId = text(note.id ?? note.note_id) || null
    // Supplied batches can omit note ids. A positional fallback keeps each
    // note's points distinct instead of collapsing every id-less note onto the
    // same native id and silently dropping all but the first reviewer.
    const noteKey = noteId || `idx-${noteIndex + 1}`
    const url = note.url || (noteForum ? `https://openreview.net/forum?id=${noteForum}${noteId ? `&noteId=${noteId}` : ''}` : null)
    const dec = orvText(orvField(note, 'decision'))
    if (dec && !decision) decision = dec
    if (/rebuttal/i.test(joined)) {
      counts.skipped_rebuttal_notes += 1
      continue
    }
    const isMeta = /meta_review/i.test(joined)
    const hasReviewFields = ['rating', 'recommendation', 'summary', 'strengths', 'weaknesses', 'questions'].some((key) => orvField(note, key) != null)
    const reviewLike = !isMeta && (/review/i.test(joined) || hasReviewFields)
    if (!reviewLike) {
      counts.non_review_notes += 1
      continue
    }
    const identity = orvIdentity(note, noteId)
    const rating = orvField(note, 'rating') ?? orvField(note, 'recommendation')
    const confidence = orvField(note, 'confidence')
    reviewersList.push({ id: identity.id, rating: rating ?? null, confidence: confidence ?? null })
    const sourceRefBase = { forum_id: noteForum, note_id: noteId, invitation: invitations[0] ?? null, url }
    const base = {
      source: 'openreview',
      reviewer: identity,
      evaluator_kind: null,
      evaluator_kind_source: 'not_applicable',
    }
    const fieldPoint = (field, kind) => {
      const value = orvText(orvField(note, field))
      if (!value) return
      const point = {
        ...base,
        source_ref: { ...sourceRefBase, field },
        kind,
        severity: null,
        source_label: invitations[0] ?? field,
        text: clip(value, TEXT_CLIP),
        detail: null,
        location: null,
        quote: null,
        native_id: `${noteKey}#${field}`,
      }
      point.keys = buildKeys(point)
      items.push(point)
    }
    fieldPoint('weaknesses', 'weakness')
    fieldPoint('summary', 'comment')
    fieldPoint('questions', 'question')
    if (orvText(orvField(note, 'strengths'))) counts.strength_fields_seen += 1
  }
  return {
    items,
    counts,
    ref: {
      forum_id: forumId,
      note_total: batch.length,
      decision,
      reviewers: reviewersList,
      input,
      input_sha256: inputSha,
      fetched_at: text(fetchedAt) || null,
    },
  }
}

/* ------------------------------------------------------------- import */

function validateKinds(kinds) {
  if (kinds == null || kinds === '') return [...REBUTTAL_POINT_KINDS]
  if (!Array.isArray(kinds)) throw new Error('kinds must be an array of point kinds')
  for (const entry of kinds) {
    if (!REBUTTAL_POINT_KINDS.includes(text(entry))) {
      throw new Error(`kinds must be a subset of ${REBUTTAL_POINT_KINDS.join(', ')}`)
    }
  }
  const out = [...new Set(kinds.map(text))]
  if (!out.length) return [...REBUTTAL_POINT_KINDS]
  return out
}

export async function importRebuttalPoints({
  cwd, slug: slugValue, source, kinds = null,
  name = null, question = null, venue = null, manuscript = null,
  deepReviewKey = null, deepReviewRound = null, ahReview = null,
  reviews = null, reviewsPath = null, reviewsFetchedAt = null, forumId = null,
}) {
  const f = files(cwd, slugValue)
  const wantedSource = text(source)
  if (!REBUTTAL_SOURCES.includes(wantedSource)) throw new Error(`source must be one of ${REBUTTAL_SOURCES.join(', ')}`)
  const kindFilter = validateKinds(kinds)
  const warnings = []
  const counts = {
    point_total_in_source: 0,
    imported: 0,
    skipped_duplicates: 0,
    drifted_total: 0,
    excluded_section_comments: 0,
    skipped_rebuttal_notes: 0,
    skipped_checklist_yes_na: 0,
    non_review_notes: 0,
    strength_fields_seen: 0,
    new_round_points_total: 0,
    truncated_by_source_cap: 0,
  }
  let ref = {}
  let incoming = []
  if (wantedSource === 'deep_review') {
    if (!text(deepReviewKey)) throw new Error('import from deep_review needs deep_review_key (the store key or the manuscript path)')
    const read = readDeepReviewRound(cwd, deepReviewKey, deepReviewRound)
    incoming = read.items
    ref = { deep_review: read.ref }
    counts.excluded_section_comments = read.counts.excluded_section_comments
    counts.skipped_checklist_yes_na = read.counts.skipped_checklist_yes_na
    counts.truncated_by_source_cap = read.counts.truncated_by_source_cap
    counts.point_total_in_source = read.counts.point_total_in_source
    warnings.push(...read.warnings)
  } else if (wantedSource === 'ah_review') {
    if (!text(ahReview)) throw new Error('import from ah_review needs ah_review (the review id, e.g. R1)')
    const read = await readAhReview(cwd, ahReview)
    incoming = read.items
    ref = { ah_review: read.ref }
    counts.point_total_in_source = read.items.length
  } else {
    const read = readOpenReviewSupplied(cwd, { reviews, reviewsPath, fetchedAt: reviewsFetchedAt, forumIdArg: forumId })
    incoming = read.items
    ref = { openreview: read.ref }
    counts.skipped_rebuttal_notes = read.counts.skipped_rebuttal_notes
    counts.non_review_notes = read.counts.non_review_notes
    counts.strength_fields_seen = read.counts.strength_fields_seen
    // candidate points = the imported-field values present on review-like notes
    // (strengths are excluded by rule, not counted as candidates).
    counts.point_total_in_source = read.items.length
  }
  incoming = incoming.filter((item) => kindFilter.includes(item.kind))
  if (incoming.length > MAX_POINTS_PER_IMPORT) {
    throw new Error(`this import carries ${incoming.length} points; a single import takes at most ${MAX_POINTS_PER_IMPORT} — narrow with kinds`)
  }
  ensureDir(f.dir)
  return withLock(f.dir, () => {
    const importedWarnings = [...warnings]
    const existingDefinition = readJson(f.definition)
    const imports = readJsonl(f.imports)
    const importId = allocatedId('i', imports)
    let definition = existingDefinition
    if (!definition) {
      definition = {
        schemaVersion: 1,
        slug: rebuttalSlug(slugValue),
        name: text(name) || rebuttalSlug(slugValue),
        question: text(question) || null,
        venue: text(venue) || null,
        manuscript: text(manuscript) || null,
        created_at: nowIso(),
        created_by_import: importId,
      }
      writeOnceJson(f.definition, definition)
    } else {
      // The definition is write-once and the metadata parameters are accepted
      // on every import call, so a non-creating call must say out loud that it
      // stored none of them.
      importedWarnings.push('the rebuttal definition is write-once; name/question/venue/manuscript on this call were not stored')
    }
    const points = readJsonl(f.points)
    const byKey = new Map(points.map((point) => [dedupeKey(point), point]))
    const sourceAlreadyPresent = points.some((point) => point.source === wantedSource)
    const newRows = []
    const skippedDuplicates = []
    const drifted = []
    for (const item of incoming) {
      const row = {
        point_id: null,
        ts: nowIso(),
        source: item.source,
        reviewer: item.reviewer,
        evaluator_kind: item.evaluator_kind ?? null,
        evaluator_kind_source: item.evaluator_kind_source ?? null,
        source_ref: item.source_ref,
        kind: item.kind,
        severity: item.severity ?? null,
        source_label: item.source_label ?? null,
        text: item.text ?? null,
        detail: item.detail ?? null,
        location: item.location ?? null,
        quote: item.quote ?? null,
        keys: item.keys || [],
        native_id: item.native_id,
      }
      const sha = payloadSha256(row)
      const key = dedupeKey(row)
      const existing = byKey.get(key)
      if (existing) {
        if (existing.payload_sha256 === sha) {
          counts.skipped_duplicates += 1
          skippedDuplicates.push(existing.native_id)
        } else {
          // The artifact changed under us: report, never overwrite history.
          // A reworded deep_review comment has a NEW content-seeded native id
          // and arrives as a new point; drift only fires for stable native ids
          // whose payload changed in place.
          drifted.push({
            point_id: existing.point_id,
            native_id: existing.native_id,
            stored_sha256: existing.payload_sha256,
            incoming_sha256: sha,
            source_ref: existing.source_ref,
          })
          counts.drifted_total += 1
        }
        continue
      }
      row.point_id = allocatedId('p', [...points, ...newRows])
      row.payload_sha256 = sha
      newRows.push(row)
      byKey.set(key, row)
    }
    if (newRows.length) appendJsonl(f.points, newRows)
    counts.imported = newRows.length
    if (sourceAlreadyPresent && newRows.length) {
      counts.new_round_points_total = newRows.length
    }
    const envelopeNote = sourceAlreadyPresent && newRows.length
      ? 'points from a later round are separate rows and are paired at read time by the closing reading, not deduped against the first import'
      : null
    // Manuscript-pointer binding check: never refuse, never rewrite the
    // definition — a mismatch is surfaced and both paths are listed by status.
    const incomingPointer = ref.deep_review?.manuscript
      ?? ref.ah_review?.file
      ?? (text(manuscript) || null)
    if (definition.manuscript && incomingPointer && definition.manuscript !== incomingPointer) {
      importedWarnings.push(`imported points name ${incomingPointer}, but rebuttal "${definition.slug}" was created for ${definition.manuscript}; coverage totals mix the two`)
    }
    const envelope = {
      import_id: importId,
      ts: nowIso(),
      source: wantedSource,
      ref,
      kinds: [...new Set(incoming.map((item) => item.kind))],
      counts,
      batch_sha256: `sha256:${sha256(stableStringify(incoming.map((item) => ({
        native_id: item.native_id,
        kind: item.kind,
        severity: item.severity ?? null,
        source_label: item.source_label ?? null,
        text: item.text ?? null,
        location: item.location ?? null,
        quote: item.quote ?? null,
      }))))}`,
      ...(envelopeNote ? { note: envelopeNote } : {}),
    }
    appendJsonl(f.imports, [envelope])
    const byKind = {}
    const byEvaluatorKind = {}
    for (const row of newRows) {
      byKind[row.kind] = (byKind[row.kind] ?? 0) + 1
      const evaluator = row.evaluator_kind ?? 'not_applicable'
      byEvaluatorKind[evaluator] = (byEvaluatorKind[evaluator] ?? 0) + 1
    }
    return {
      definition,
      envelope,
      points: newRows,
      skipped_duplicates: skippedDuplicates,
      drifted,
      imported: { total: newRows.length, by_kind: byKind, by_evaluator_kind: byEvaluatorKind },
      warnings: importedWarnings,
    }
  }, { label: 'rebuttal ledger' })
}

/* ---------------------------------------------------------------- plan */

/** Named accessor paths over the supplied power_analysis result (§1.3). */
function powerN(power) {
  return power?.result?.n ?? power?.n ?? null
}

export async function planRebuttalTask({
  cwd,
  slug: slugValue,
  pointId,
  dataset,
  baselineRef,
  metric,
  metricDirection = null,
  replicates = null,
  replicatesBasis = null,
  power = null,
  experimentSlug = null,
  evidence,
  rationale = null,
  cap = { max_tasks: REBUTTAL_DEFAULT_MAX_TASKS, source: 'default' },
}) {
  const f = files(cwd, slugValue)
  readRebuttal(cwd, slugValue)
  const points = requirePoints(cwd, slugValue)
  const point = findPoint(points, pointId, slugValue)
  const datasetValue = text(dataset)
  if (!datasetValue) throw new Error('dataset is required')
  const baselineValue = text(baselineRef).toLowerCase()
  if (!EXPERIMENT_BASELINE_REFS.includes(baselineValue)) throw new Error(`baseline_ref must be one of ${EXPERIMENT_BASELINE_REFS.join(', ')}`)
  const metricValue = text(metric)
  if (!metricValue) throw new Error('metric is required')
  const directionValue = text(metricDirection).toLowerCase() || null
  if (directionValue && !['higher', 'lower'].includes(directionValue)) throw new Error('metric_direction must be one of higher, lower')
  const evidenceValue = text(evidence)
  if (!REBUTTAL_EXPECTED_EVIDENCE.includes(evidenceValue)) throw new Error(`evidence must be one of ${REBUTTAL_EXPECTED_EVIDENCE.join(', ')}`)
  const notes = []
  const validated = {
    benchmark_state: 'no_experiment',
    dataset_in_benchmark: null,
    metric_declared: null,
    notes: [],
  }
  let powerValue = objectValue(power, 'power')
  let replicatesValue = replicates == null || replicates === '' ? null : Number(replicates)
  let basisValue = text(replicatesBasis).toLowerCase() || null
  if (powerValue) {
    if (powerValue.error) {
      const code = powerValue.code ? `, code ${powerValue.code}` : ''
      throw new Error(`power_analysis returned an error ("${powerValue.error}"${code}); a replicate count cannot come from it`)
    }
    const n = powerN(powerValue)
    if (n == null || !Number.isFinite(Number(n)) || !Number.isInteger(Number(n)) || Number(n) <= 0) {
      throw new Error('power.n must be a positive whole number')
    }
    const nInt = Number(n)
    if (replicatesValue == null) replicatesValue = nInt
    if (!Number.isInteger(replicatesValue) || replicatesValue < 1 || replicatesValue > MAX_REPLICATES) {
      throw new Error(`replicates must be an integer from 1 to ${MAX_REPLICATES}`)
    }
    if (replicatesValue > nInt) {
      throw new Error(`replicates may not exceed the powered n (${nInt}) — plan fewer replicates and record the shortfall, or supply a power result that supports ${replicatesValue}`)
    }
    if (replicatesValue < nInt) {
      notes.push(`replicates <powered n by ${nInt - replicatesValue}>`)
    }
    basisValue = 'power_analysis'
    const effectSource = powerValue.effect_source
    if (effectSource && effectSource.source === 'convention') {
      if (effectSource.note) notes.push(text(effectSource.note))
      notes.push('sample size rests on a convention, not measured effect')
    } else if (!effectSource) {
      notes.push('the power result carries no effect_source; the sample size is unattributed')
    }
    // Stored VERBATIM plus exactly two rebuttal-owned keys (§1.3) — the store
    // defines no canonical field list for a power result.
    powerValue = {
      ...powerValue,
      basis: 'power_analysis',
      source_note: 'power_analysis is stateless; these numbers come from the result object supplied in this call',
    }
  } else {
    if (replicatesValue == null && !basisValue) {
      throw new Error(`replicates needs replicates_basis (${REBUTTAL_REPLICATES_BASIS.join('|')}); the ledger records where a replicate count came from`)
    }
    if (replicatesValue == null) throw new Error('replicates is required')
    if (!basisValue) throw new Error(`replicates needs replicates_basis (${REBUTTAL_REPLICATES_BASIS.join('|')}); the ledger records where a replicate count came from`)
    if (!REBUTTAL_REPLICATES_BASIS.includes(basisValue)) throw new Error(`replicates_basis must be one of ${REBUTTAL_REPLICATES_BASIS.join(', ')}`)
  }
  if (!Number.isInteger(replicatesValue) || replicatesValue < 1 || replicatesValue > MAX_REPLICATES) {
    throw new Error(`replicates must be an integer from 1 to ${MAX_REPLICATES}`)
  }
  const expSlug = text(experimentSlug)
  if (expSlug) {
    const experiment = readExperiment(cwd, expSlug) // existence throw gates "typo in slug" vs "no runs"
    validated.benchmark_state = 'validated'
    if (experiment.benchmark) {
      const known = experiment.benchmark.datasets || []
      validated.dataset_in_benchmark = known.includes(datasetValue)
      if (!validated.dataset_in_benchmark) {
        notes.push(`dataset "${datasetValue}" is not in the benchmark spec of experiment "${experiment.slug}" (known: ${known.join(', ')})`)
      }
    } else {
      validated.benchmark_state = 'no_benchmark_spec'
      validated.dataset_in_benchmark = null
    }
    const declared = (experiment.metrics || []).find((entry) => entry.name === metricValue)
    validated.metric_declared = Boolean(declared)
    if (!declared) {
      notes.push(`metric "${metricValue}" is not declared by experiment "${experiment.slug}" (declared: ${(experiment.metrics || []).map((entry) => entry.name).join(', ') || 'none'})`)
    } else if (declared.direction && directionValue && declared.direction !== directionValue) {
      notes.push(`metric "${metricValue}" is declared ${declared.direction} in experiment "${experiment.slug}"; the stub restates it as ${directionValue}`)
    } else if (!declared.direction && !directionValue) {
      throw new Error(`metric "${metricValue}" has no declared direction; pass metric_direction higher|lower`)
    }
  }
  validated.notes = [...validated.notes, ...notes]
  // Cap, dedupe, and id allocation are re-derived from the SAME read inside
  // the lock (the cap is what replaces the paper's N_t — a pre-lock check races).
  return withLock(f.dir, () => {
    const tasks = readJsonl(f.tasks)
    if (tasks.length >= cap.max_tasks) {
      throw new Error(`plan cap reached: rebuttal "${rebuttalSlug(slugValue)}" keeps at most ${cap.max_tasks} supplementary task(s) (REBUTTAL_MAX_TASKS, ${cap.source}); ${tasks.length} are already planned — consolidate stubs, answer the remaining points without a supplementary experiment (action "respond"), or raise the setting`)
    }
    const duplicate = tasks.find((entry) => entry.point_id === point.point_id && entry.dataset === datasetValue
      && entry.metric === metricValue && entry.baseline_ref === baselineValue && entry.evidence === evidenceValue)
    if (duplicate) {
      throw new Error(`point ${point.point_id} already has that stub (${duplicate.task_id}); link another run or plan a different arm`)
    }
    const task = {
      task_id: allocatedId('t', tasks),
      ts: nowIso(),
      point_id: point.point_id,
      source: point.source,
      dataset: datasetValue,
      baseline_ref: baselineValue,
      metric: metricValue,
      metric_direction: directionValue,
      replicates: replicatesValue,
      replicates_basis: basisValue,
      power: powerValue || null,
      experiment_slug: expSlug || null,
      evidence: evidenceValue,
      rationale: text(rationale) || null,
      validated,
      cap_at_plan: cap.max_tasks,
    }
    appendJsonl(f.tasks, [task])
    return { task, warnings: [] }
  }, { label: 'rebuttal ledger' })
}

/* ---------------------------------------------------------------- link */

export async function linkRebuttalTask({
  cwd, slug: slugValue, taskId,
  experimentSlug = null, experimentRunId = null,
  analysisSlug = null, analysisRunId = null,
  reading = null, note = null,
}) {
  const f = files(cwd, slugValue)
  readRebuttal(cwd, slugValue)
  const tasks = listRebuttalTasks(cwd, slugValue)
  const task = findTask(tasks, taskId, slugValue)
  const hasExperiment = experimentSlug != null || experimentRunId != null
  const hasAnalysis = analysisSlug != null || analysisRunId != null
  if (hasExperiment && hasAnalysis) throw new Error('link one source: experiment_log or analysis_run, not both')
  if (!hasExperiment && !hasAnalysis) throw new Error('link needs experiment_slug + experiment_run_id or analysis_slug + analysis_run_id')
  if (hasExperiment && reading != null) throw new Error('experiment links take metrics from the linked run; omit reading (rebuttal stores no numbers of its own)')
  let source = null
  let storedReading = null
  if (hasExperiment) {
    const slug = text(experimentSlug)
    const id = text(experimentRunId)
    if (!slug || !id) throw new Error('link needs experiment_slug + experiment_run_id or analysis_slug + analysis_run_id')
    readExperiment(cwd, slug) // existence gate: listExperimentRuns returns [] for an unknown slug
    const run = listExperimentRuns(cwd, slug).find((entry) => entry.run_id === id)
    if (!run) throw new Error(`experiment run "${id}" not found in experiment "${slug}"`)
    source = {
      ledger: 'experiment',
      slug,
      run_id: id,
      digest: sourceDigest(run),
      artifacts: (run.artifacts || []).map((entry) => ({ path: entry.path, sha256: entry.sha256 ?? null })),
      artifact_total: (run.artifacts || []).length,
      metrics_source: 'linked experiment run (read live by id)',
    }
  } else {
    const slug = text(analysisSlug)
    const id = text(analysisRunId)
    if (!slug || !id) throw new Error('link needs experiment_slug + experiment_run_id or analysis_slug + analysis_run_id')
    if (!currentPlan(cwd, slug) && !listAnalysisRuns(cwd, slug).length) {
      throw new Error(`analysis "${slug}" has no plan under ${relative(cwd, join(resolve(cwd), '.dsh', 'analysis', slug)).replace(/\\/g, '/') || '.dsh/analysis/' + slug}; run analysis_run action="plan" first`)
    }
    const run = listAnalysisRuns(cwd, slug).find((entry) => entry.run_id === id)
    if (!run) throw new Error(`analysis run "${id}" not found in analysis "${slug}"`)
    const hashedOutputs = (run.outputs || []).filter((entry) => entry.sha256)
    const hashed = hashedOutputs.length + (run.artifacts || []).length
    if (hashed === 0) throw new Error(`analysis run "${id}" has no hashed outputs or artifacts; link an experiment run or an analysis run with hashed evidence`)
    const readingObject = objectValue(reading, 'reading')
    if (!readingObject || !Object.keys(readingObject).length) {
      throw new Error('reading is required for an analysis_run link; the run carries no metrics')
    }
    storedReading = {}
    for (const [name, value] of Object.entries(readingObject)) {
      if (value == null) continue
      const number = Number(value)
      if (!Number.isFinite(number)) throw new Error(`metric ${name} must be a finite number`)
      storedReading[name] = number
    }
    if (!Object.keys(storedReading).length) throw new Error('reading is required for an analysis_run link; the run carries no metrics')
    source = {
      ledger: 'analysis',
      slug,
      run_id: id,
      digest: sourceDigest(run),
      artifacts: [
        ...hashedOutputs.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
        ...(run.artifacts || []).filter((entry) => typeof entry === 'string').map((path) => ({ path, sha256: null })),
      ],
      artifact_total: hashed,
      metrics_source: 'caller reading of hashed outputs',
    }
  }
  return withLock(f.dir, () => {
    const links = readJsonl(f.links)
    const duplicate = links.find((entry) => entry.task_id === task.task_id && entry.source.ledger === source.ledger
      && entry.source.slug === source.slug && entry.source.run_id === source.run_id)
    if (duplicate) {
      throw new Error(`task ${task.task_id} is already linked to ${source.ledger} ${source.slug}/${source.run_id} (${duplicate.link_id}); a rerun is a new run id — link that one instead`)
    }
    const link = {
      link_id: allocatedId('l', links),
      ts: nowIso(),
      task_id: task.task_id,
      point_id: task.point_id,
      source,
      reading: storedReading,
      note: text(note) || null,
    }
    appendJsonl(f.links, [link])
    return { link, point_id: task.point_id }
  }, { label: 'rebuttal ledger' })
}

/* -------------------------------------------------------- events / pins */

function mergeEvents(answers, declines, pointId) {
  const events = [
    ...answers.filter((entry) => entry.point_id === pointId).map((entry, index) => ({
      kind: 'answer', ts: entry.ts, id: entry.answer_id, seq: Number.isInteger(entry.event_seq) ? entry.event_seq : null, index, data: entry,
    })),
    ...declines.filter((entry) => entry.point_id === pointId).map((entry, index) => ({
      kind: 'decline', ts: entry.ts, id: entry.decline_id, seq: Number.isInteger(entry.event_seq) ? entry.event_seq : null, index: answers.length + index, data: entry,
    })),
  ]
  events.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1
    // Same millisecond: the monotonic event_seq records append order, so an
    // answer written after the decline it supersedes still wins. Legacy events
    // without one fall back to their ledger order.
    if (a.seq != null && b.seq != null && a.seq !== b.seq) return a.seq - b.seq
    return a.index - b.index
  })
  return events
}

/**
 * Resolve change_slug against the FOREIGN manuscript-diff ledger. The raw form
 * is normalized through ledger-kit slug() — the same sanitizer manuscript-diff's
 * own deriveSlug uses — so `Revision 1` resolves the directory manuscript-diff
 * actually created, and no `..` value reaches outside .dsh/manuscript-diff/.
 */
function readManuscriptDiffRecord(cwd, changeSlugRaw) {
  const normalized = manuscriptDiffSlug(text(changeSlugRaw))
  const recordFile = join(resolve(cwd), '.dsh', 'manuscript-diff', normalized, 'changes.json')
  const missing = () => new Error(`no recorded changes for "${normalized || text(changeSlugRaw)}" under .dsh/manuscript-diff/; run manuscript_diff action=changes first`)
  if (!normalized || !existsSync(recordFile)) throw missing()
  const record = readJson(recordFile)
  if (!record || record.slug !== normalized) throw missing()
  return { normalized, record }
}

function versionPairMatches(pin, record) {
  if (!pin || !record) return false
  return pin.old_sha256 === record.old_sha256 && pin.new_sha256 === record.new_sha256
}

/* ------------------------------------------------------------- respond */

export async function recordRebuttalAnswer({
  cwd, slug: slugValue, pointId, response, linkIds = null, changeSlug = null, changeIds = null, supersedes = null,
}) {
  const f = files(cwd, slugValue)
  readRebuttal(cwd, slugValue)
  const points = requirePoints(cwd, slugValue)
  const point = findPoint(points, pointId, slugValue)
  const responseText = text(response)
  if (!responseText) throw new Error('response is required (this tool never writes reviewer prose)')
  const links = listRebuttalLinks(cwd, slugValue)
  const tasks = new Map(listRebuttalTasks(cwd, slugValue).map((task) => [task.task_id, task]))
  const linkIdList = Array.isArray(linkIds) ? linkIds.map(text).filter(Boolean) : []
  for (const id of linkIdList) {
    const link = links.find((entry) => entry.link_id === id)
    if (!link) throw new Error(`link "${id}" not found in rebuttal "${rebuttalSlug(slugValue)}"`)
    const task = tasks.get(link.task_id)
    if (!task || task.point_id !== point.point_id) {
      throw new Error(`link "${id}" belongs to point "${task ? task.point_id : '(unknown)'}", not "${point.point_id}"; link a task planned for that point`)
    }
  }
  const changeIdList = Array.isArray(changeIds) ? changeIds.map(text).filter(Boolean) : []
  if (changeIdList.length && !text(changeSlug)) {
    throw new Error('change_ids need change_slug (the manuscript_diff slug holding the recorded hunks)')
  }
  let pin = null
  if (text(changeSlug)) {
    const { normalized, record } = readManuscriptDiffRecord(cwd, changeSlug)
    for (const id of changeIdList) {
      if (!(record.changes || []).some((change) => change.id === id)) {
        throw new Error(`change "${id}" is not in the recorded changes for "${normalized}"`)
      }
    }
    pin = {
      slug: normalized,
      old_sha256: record.old_sha256,
      new_sha256: record.new_sha256,
      ids: changeIdList,
      created_at: record.created_at,
    }
    if (!changeIdList.length) pin = null // a bare change_slug cites no hunk; nothing to pin
  }
  return withLock(f.dir, () => {
    const answers = readJsonl(f.answers)
    const declines = readJsonl(f.declines)
    const events = mergeEvents(answers, declines, point.point_id)
    const last = events.at(-1) ?? null
    let supersedesId = text(supersedes) || null
    let revision = 1 + Math.max(0, ...answers.filter((entry) => entry.point_id === point.point_id).map((entry) => Number(entry.revision) || 0))
    if (last && last.kind === 'answer') {
      supersedesId = last.id
      if (text(last.data.response) === responseText) {
        throw new Error(`point ${point.point_id} already has this answer (${last.id}); append a revision with different text`)
      }
    } else if (last && last.kind === 'decline') {
      if (supersedesId !== last.id) {
        throw new Error(`point ${point.point_id} is declined (${last.id}); pass supersedes to answer a point the author declined`)
      }
    }
    const hasLinks = linkIdList.length > 0
    const hasHunks = changeIdList.length > 0
    const answer = {
      answer_id: allocatedId('a', answers),
      ts: nowIso(),
      event_seq: answers.length + declines.length + 1,
      point_id: point.point_id,
      response: clip(responseText, RESPONSE_CLIP),
      revision,
      supersedes: supersedesId,
      link_ids: linkIdList,
      change_ids: changeIdList,
      change_pin: pin,
      evidence: hasLinks && hasHunks ? 'both' : hasLinks ? 'linked_artifact' : hasHunks ? 'recorded_hunks' : 'none_cited',
    }
    appendJsonl(f.answers, [answer])
    return { answer }
  }, { label: 'rebuttal ledger' })
}

/* -------------------------------------------------------------- decline */

export async function recordRebuttalDecline({
  cwd, slug: slugValue, pointId, reason, ahItem = null, declinedBy = null, supersedes = null,
}) {
  const f = files(cwd, slugValue)
  readRebuttal(cwd, slugValue)
  const points = requirePoints(cwd, slugValue)
  const point = findPoint(points, pointId, slugValue)
  const why = text(reason)
  if (!why) throw new Error('reason is required (the decline basis is the author\'s own words)')
  const warnings = []
  let verified = false
  let declineSource = 'author_recorded'
  let ahStatus = null
  let ahResponsePresent = null
  let rid = null
  const item = text(ahItem)
  if (item) {
    if (point.source !== 'ah_review' || point.source_ref?.item_id !== item) {
      throw new Error(`decline names ah item "${item}" but point ${point.point_id} was imported from ${point.source}`)
    }
    rid = point.source_ref?.rid ?? null
    const live = await readAhReview(cwd, rid)
    const liveItem = live.items.find((entry) => entry.source_ref.item_id === item)
    if (!liveItem) throw new Error(`ah item "${item}" is not in the live review "${rid}"`)
    const liveStatus = liveItem.source_ref.status_at_import
    if (liveStatus !== 'declined') {
      throw new Error(`ah item "${item}" has status "${liveStatus}", not "declined"; declining a reviewer's point is the author's decision — run ah_author action=decline ${item} first, then record it here`)
    }
    verified = true
    declineSource = 'ah_author_decline'
    ahStatus = 'declined'
    ahResponsePresent = liveItem.source_ref.response_at_import
    if (!ahResponsePresent) {
      warnings.push(`ah item ${item} is declined with no response text; the engine reports REV-04 (major) and ah_check will block`)
    }
  } else {
    const by = text(declinedBy)
    if (!by) {
      throw new Error('decline needs declined_by (who declined) for a point with no ah item, or ah_item to verify against the engine ledger')
    }
    verified = false
    declineSource = 'author_recorded'
  }
  return withLock(f.dir, () => {
    const answers = readJsonl(f.answers)
    const declines = readJsonl(f.declines)
    const events = mergeEvents(answers, declines, point.point_id)
    const last = events.at(-1) ?? null
    let supersedesId = text(supersedes) || null
    if (last && last.kind === 'decline') {
      throw new Error(`point ${point.point_id} is already declined (${last.id}); declines are append-only history`)
    }
    if (last && last.kind === 'answer' && supersedesId !== last.id) {
      throw new Error(`point ${point.point_id} is answered (${last.id}); pass supersedes naming that answer to decline over it`)
    }
    const decline = {
      decline_id: allocatedId('d', declines),
      ts: nowIso(),
      event_seq: answers.length + declines.length + 1,
      point_id: point.point_id,
      reason: clip(why, RESPONSE_CLIP),
      declined_by: text(declinedBy) || null,
      ah_item: item || null,
      ah_review: rid,
      verified,
      ah_status: ahStatus,
      ah_response_present: ahResponsePresent,
      decline_source: declineSource,
      supersedes: supersedesId,
      warnings: [...warnings],
    }
    appendJsonl(f.declines, [decline])
    return { decline, warnings }
  }, { label: 'rebuttal ledger' })
}

/* ------------------------------------------------------------- coverage */

function digestStateForLink(link, caches, unreadable) {
  const { ledger, slug, run_id: runId, digest } = link.source
  if (ledger === 'experiment') {
    if (!caches.experiment.has(slug)) {
      try {
        const runs = listExperimentRuns(caches.cwd, slug)
        caches.experiment.set(slug, { runs, verdicts: latestVerdicts(caches.cwd, slug), error: null })
      } catch (error) {
        caches.experiment.set(slug, { runs: [], verdicts: new Map(), error: error instanceof Error ? error.message : String(error) })
      }
    }
    const cache = caches.experiment.get(slug)
    if (cache.error) {
      unreadable.push({ ledger, slug, run_id: runId, reason: cache.error })
      return { state: 'unreadable', run: null, verdict: null }
    }
    const run = cache.runs.find((entry) => entry.run_id === runId) ?? null
    if (!run) {
      unreadable.push({ ledger, slug, run_id: runId, reason: 'the linked run id is no longer in the ledger' })
      return { state: 'unreadable', run: null, verdict: null }
    }
    const verdict = cache.verdicts.get(runId) ?? null
    return {
      state: sourceDigest(run) === digest ? 'verified' : 'drifted',
      run,
      verdict: verdict ? {
        verdict: verdict.verdict ?? null,
        requested_verdict: verdict.requested_verdict ?? null,
        forced: verdict.forced ?? null,
        reason: verdict.reason ?? null,
      } : null,
    }
  }
  if (!caches.analysis.has(slug)) {
    try {
      caches.analysis.set(slug, { runs: listAnalysisRuns(caches.cwd, slug), error: null })
    } catch (error) {
      caches.analysis.set(slug, { runs: [], error: error instanceof Error ? error.message : String(error) })
    }
  }
  const cache = caches.analysis.get(slug)
  if (cache.error) {
    unreadable.push({ ledger, slug, run_id: runId, reason: cache.error })
    return { state: 'unreadable', run: null, verdict: null }
  }
  const run = cache.runs.find((entry) => entry.run_id === runId) ?? null
  if (!run) {
    unreadable.push({ ledger, slug, run_id: runId, reason: 'the linked run id is no longer in the ledger' })
    return { state: 'unreadable', run: null, verdict: null }
  }
  return { state: sourceDigest(run) === digest ? 'verified' : 'drifted', run, verdict: null }
}

async function closingReading(cwd, points, imports, closing) {
  const closingResult = {
    compared_round: null,
    points_paired: 0,
    closed_total: 0,
    still_present_total: 0,
    variance_only_total: 0,
    matched_by: { id: 0, summary: 0, quote: 0, claim: 0, question: 0, similar: 0 },
    note: CLOSE_CAVEAT,
  }
  const outcomesByPoint = new Map()
  if (!closing || !text(closing.deepReviewKey)) {
    for (const point of points) {
      if (point.source === 'deep_review') outcomesByPoint.set(point.point_id, { state: 'not_compared', matched_by: null, score: null })
    }
    return { closing: closingResult, outcomesByPoint }
  }
  let read
  try {
    read = readDeepReviewRound(cwd, closing.deepReviewKey, closing.deepReviewRound)
  } catch (error) {
    return {
      closing: {
        ...closingResult,
        note: `the newer round "${text(closing.deepReviewKey)}${text(closing.deepReviewRound) ? `/${text(closing.deepReviewRound)}` : ''}" is unreadable, so no point could be compared: ${error instanceof Error ? error.message : String(error)}`,
      },
      outcomesByPoint,
      closingUnreadable: { ledger: 'deep_review', slug: text(closing.deepReviewKey), run_id: null, reason: error instanceof Error ? error.message : String(error) },
    }
  }
  closingResult.compared_round = {
    key: read.ref.key,
    dir: read.ref.dir,
    run_id: read.ref.run_id,
    round: read.ref.round,
    evaluator_kind: read.ref.evaluator_kind,
    input_sha1: read.ref.input_sha1,
  }
  const importedSha1s = new Set(
    imports
      .filter((envelope) => envelope.source === 'deep_review' && envelope.ref?.deep_review?.input_sha1)
      .map((envelope) => envelope.ref.deep_review.input_sha1),
  )
  const identicalBytes = read.ref.input_sha1 != null && importedSha1s.has(read.ref.input_sha1)
  const fromItems = points.filter((point) => point.source === 'deep_review')
  const match = matchPool(fromItems, read.items)
  for (const rule of Object.keys(closingResult.matched_by)) {
    closingResult.matched_by[rule] = match.byRule?.[rule] ?? 0
  }
  const pairedKeys = new Set(match.pairs.map((pair) => pair.from.point_id))
  for (const pair of match.pairs) {
    outcomesByPoint.set(pair.from.point_id, { state: 'still_present', matched_by: pair.matched_by, score: pair.score ?? null })
  }
  for (const point of fromItems) {
    if (pairedKeys.has(point.point_id)) continue
    // A point with no match keys cannot be paired in principle. Calling it
    // closed because the matcher found nothing would turn an unreadable point
    // into a resolution; say it was not compared instead.
    if (!Array.isArray(point.keys) || !point.keys.length) {
      outcomesByPoint.set(point.point_id, {
        state: 'not_compared',
        matched_by: null,
        score: null,
        note: 'this point stored no match keys, so the newer round could not be paired against it',
      })
      continue
    }
    if (identicalBytes) {
      outcomesByPoint.set(point.point_id, {
        state: 'variance_only',
        matched_by: null,
        score: null,
        note: 'the manuscript bytes are identical; a finding that did not recur is reviewer variance, not a revision',
      })
      closingResult.variance_only_total += 1
    } else {
      outcomesByPoint.set(point.point_id, { state: 'closed', matched_by: null, score: null })
      closingResult.closed_total += 1
    }
  }
  closingResult.points_paired = match.pairs.length
  closingResult.still_present_total = match.pairs.length
  if (identicalBytes) {
    closingResult.note = `${CLOSE_CAVEAT}; the compared round has the same input_sha1 as an imported round, so no row may read closed`
  }
  return { closing: closingResult, outcomesByPoint }
}

export async function rebuttalCoverage(cwd, slugValue, { cap = { max_tasks: REBUTTAL_DEFAULT_MAX_TASKS, source: 'default' }, limit = null, pointId = null, closing = null } = {}) {
  const f = files(cwd, slugValue)
  const definition = readRebuttal(cwd, slugValue)
  const limitValue = limit == null || limit === '' ? MAX_COVERAGE_ROWS : Number(limit)
  if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 2000) throw new Error('limit must be an integer from 1 to 2000')
  const points = listRebuttalPoints(cwd, slugValue)
  const tasks = listRebuttalTasks(cwd, slugValue)
  const links = listRebuttalLinks(cwd, slugValue)
  const answers = listRebuttalAnswers(cwd, slugValue)
  const declines = listRebuttalDeclines(cwd, slugValue)
  const imports = listRebuttalImports(cwd, slugValue)
  const warnings = []
  const unreadable = []
  const caches = { cwd: resolve(cwd), experiment: new Map(), analysis: new Map() }
  const tasksByPoint = new Map()
  for (const task of tasks) {
    if (!tasksByPoint.has(task.point_id)) tasksByPoint.set(task.point_id, [])
    tasksByPoint.get(task.point_id).push(task)
  }
  const linksByTask = new Map()
  for (const link of links) {
    if (!linksByTask.has(link.task_id)) linksByTask.set(link.task_id, [])
    linksByTask.get(link.task_id).push(link)
  }
  const diffRecords = new Map()
  const readDiffRecord = (pinSlug) => {
    if (!diffRecords.has(pinSlug)) {
      try {
        diffRecords.set(pinSlug, readJson(join(resolve(cwd), '.dsh', 'manuscript-diff', pinSlug, 'changes.json')))
      } catch (error) {
        diffRecords.set(pinSlug, { error: error instanceof Error ? error.message : String(error) })
      }
    }
    return diffRecords.get(pinSlug)
  }
  const { closing: closingView, outcomesByPoint, closingUnreadable } = await closingReading(cwd, points, imports, closing)
  if (closingUnreadable) unreadable.push(closingUnreadable)
  const ahLive = new Map()
  for (const point of points) {
    if (point.source !== 'ah_review') continue
    const rid = point.source_ref?.rid
    if (!ahLive.has(rid)) {
      try {
        const live = await readAhReview(cwd, rid)
        ahLive.set(rid, live)
      } catch (error) {
        ahLive.set(rid, { error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  const rows = []
  const totals = {
    points: points.length, answered: 0, answered_asserted: 0,
    declined_verified: 0, declined_recorded: 0, unaddressed: 0,
    tasks: tasks.length, links: links.length, answers: answers.length, declines: declines.length,
    points_with_tasks: 0,
  }
  const bySource = {}
  const byKind = {}
  const byEvaluatorKind = { held_out: 0, in_distribution: 0, not_applicable: 0 }
  const unaddressedIds = []
  for (const point of points) {
    if (!bySource[point.source]) {
      bySource[point.source] = {
        points: 0, answered: 0, answered_asserted: 0, declined: 0, unaddressed: 0,
        evaluator_kind: { held_out: 0, in_distribution: 0, not_applicable: 0 },
        evaluator_kind_source: { declared: 0, inferred: 0, not_applicable: 0 },
      }
    }
    const src = bySource[point.source]
    src.points += 1
    src.evaluator_kind[point.evaluator_kind ?? 'not_applicable'] = (src.evaluator_kind[point.evaluator_kind ?? 'not_applicable'] ?? 0) + 1
    src.evaluator_kind_source[point.evaluator_kind_source ?? 'not_applicable'] = (src.evaluator_kind_source[point.evaluator_kind_source ?? 'not_applicable'] ?? 0) + 1
    byKind[point.kind] = (byKind[point.kind] ?? 0) + 1
    byEvaluatorKind[point.evaluator_kind ?? 'not_applicable'] += 1
    const events = mergeEvents(answers, declines, point.point_id)
    const last = events.at(-1) ?? null
    const pointTasks = tasksByPoint.get(point.point_id) ?? []
    if (pointTasks.length) totals.points_with_tasks += 1
    let status = 'unaddressed'
    let declinedVia = null
    let activeAnswer = null
    let activeDecline = null
    const rowLinks = []
    const hunks = []
    const outcome = { worst_verdict: null, drifted_links: 0, unreadable_links: 0 }
    // Every link of the point's tasks is shown beside the point, cited or not:
    // a bad verdict, spec_drift state, or non-zero exit is reportable evidence
    // even before an answer references it (coverage counts citation, outcome
    // never reduces it).
    const pointTaskIds = new Set(pointTasks.map((task) => task.task_id))
    for (const link of links) {
      if (!pointTaskIds.has(link.task_id)) continue
      const view = digestStateForLink(link, caches, unreadable)
      if (view.state === 'drifted') outcome.drifted_links += 1
      if (view.state === 'unreadable') outcome.unreadable_links += 1
      rowLinks.push({
        link_id: link.link_id,
        task_id: link.task_id,
        ledger: link.source.ledger,
        slug: link.source.slug,
        run_id: link.source.run_id,
        digest_state: view.state,
        artifact_total: link.source.artifact_total,
        role: view.run?.role ?? null,
        baseline_ref: view.run?.baseline_ref ?? null,
        stage: view.run?.stage ?? null,
        protocol_digest: view.run?.protocol_digest ?? null,
        spec_drift_state: view.run?.spec_drift?.state ?? null,
        run_metrics: link.source.ledger === 'experiment' ? (view.run?.metrics ?? null) : null,
        reading: link.reading ?? null,
        verdict: view.verdict,
        exit_code: link.source.ledger === 'analysis' ? (view.run?.exit_code ?? null) : null,
        plan_hash: link.source.ledger === 'analysis' ? (view.run?.plan_hash ?? null) : null,
      })
    }
    if (last && last.kind === 'decline') {
      activeDecline = last.data
      status = activeDecline.verified ? 'declined_verified' : 'declined_recorded'
      declinedVia = activeDecline.decline_source === 'ah_author_decline'
        ? `ah_author decline (${activeDecline.ah_item})`
        : 'author recorded'
    } else if (last && last.kind === 'answer') {
      activeAnswer = last.data
      for (const changeId of activeAnswer.change_ids || []) {
        const pin = activeAnswer.change_pin
        const record = pin ? readDiffRecord(pin.slug) : null
        const resolved = Boolean(record && Array.isArray(record.changes) && record.changes.some((change) => change.id === changeId))
        const matches = resolved && versionPairMatches(pin, record)
        hunks.push({ change_id: changeId, change_slug: pin?.slug ?? null, resolved, version_pair_matches: matches })
      }
      // "answered" cites evidence that existed: a cited link that is in the ledger in any
      // digest state (verified/drifted/unreadable), or a change id that resolves in
      // its pinned changes.json. Whether it still checks out is the flag, not the state.
      const rowLinkIds = new Set(rowLinks.map((entry) => entry.link_id))
      const citesLink = (activeAnswer.link_ids || []).some((id) => rowLinkIds.has(id))
      status = (citesLink || hunks.some((entry) => entry.resolved)) ? 'answered' : 'answered_asserted'
    }
    for (const verdict of rowLinks.map((entry) => entry.verdict).filter(Boolean)) {
      if (!outcome.worst_verdict || (VERDICT_RANK[verdict.verdict] ?? 9) < (VERDICT_RANK[outcome.worst_verdict] ?? 9)) {
        outcome.worst_verdict = verdict.verdict
      }
    }
    const closed = point.source === 'deep_review'
      ? (outcomesByPoint.get(point.point_id) ?? { state: 'not_compared', matched_by: null, score: null })
      : { state: 'not_compared', matched_by: null, score: null }
    totals[status] += 1
    src[status.startsWith('declined') ? 'declined' : status] += 1
    if (status === 'unaddressed') unaddressedIds.push(point.point_id)
    const rowWarnings = []
    if (status === 'declined_recorded') {
      rowWarnings.push(`point ${point.point_id} is declined on the author's recorded word only (no engine item to verify)`)
    }
    let ahView = null
    if (point.source === 'ah_review') {
      const live = ahLive.get(point.source_ref?.rid)
      if (live && !live.error) {
        const liveItem = live.items.find((entry) => entry.source_ref.item_id === point.source_ref?.item_id) ?? null
        if (liveItem) {
          const engineStatus = liveItem.source_ref.status_at_import
          const responsePresent = liveItem.source_ref.response_at_import
          ahView = {
            item_id: point.source_ref.item_id,
            status: engineStatus,
            units_total: (liveItem.source_ref.units_at_import || []).length,
            response_present: responsePresent,
            snapshot: liveItem.source_ref.snapshot,
            state: 'live',
          }
          if (status === 'unaddressed' && ['addressed', 'rebutted'].includes(engineStatus) && responsePresent) {
            rowWarnings.push(`ah item ${point.source_ref.item_id} is ${engineStatus} with response text in the engine, but point ${point.point_id} is unaddressed in this ledger; record the author's answer here or treat the engine as the source of truth`)
          }
        } else {
          ahView = { item_id: point.source_ref?.item_id ?? null, status: null, units_total: null, response_present: null, snapshot: null, state: 'unreadable' }
        }
      } else {
        ahView = { item_id: point.source_ref?.item_id ?? null, status: null, units_total: null, response_present: null, snapshot: null, state: 'unreadable' }
      }
    }
    warnings.push(...rowWarnings)
    rows.push({
      point_id: point.point_id,
      source: point.source,
      kind: point.kind,
      severity: point.severity ?? null,
      source_label: point.source_label ?? null,
      reviewer_id: point.reviewer?.id ?? null,
      reviewer_identity_source: point.reviewer?.identity_source ?? null,
      evaluator_kind: point.evaluator_kind ?? null,
      evaluator_kind_source: point.evaluator_kind_source ?? null,
      status,
      declined_via: declinedVia,
      text: clip(point.text || '', 200),
      tasks: pointTasks.map((task) => ({
        task_id: task.task_id,
        dataset: task.dataset,
        metric: task.metric,
        metric_direction: task.metric_direction,
        baseline_ref: task.baseline_ref,
        replicates: task.replicates,
        replicates_basis: task.replicates_basis,
        powered_n: task.power ? powerN(task.power) : null,
        evidence: task.evidence,
        experiment_slug: task.experiment_slug,
        validated: task.validated,
      })),
      links: rowLinks,
      hunks,
      outcome,
      closed: { state: closed.state, matched_by: closed.matched_by ?? null, score: closed.score ?? null },
      ah: ahView,
      response_head: activeAnswer ? clip(activeAnswer.response, 200) : (activeDecline ? clip(activeDecline.reason, 200) : null),
    })
  }
  const filtered = pointId ? rows.filter((row) => row.point_id === text(pointId)) : rows
  if (pointId && !filtered.length) throw new Error(`point "${text(pointId)}" not found in rebuttal "${rebuttalSlug(slugValue)}"`)
  const returnedRows = filtered.slice(0, limitValue)
  const rowsTruncated = filtered.length - returnedRows.length
  if (rowsTruncated > 0) {
    // Silent truncation would read as "every point is covered"; say how much
    // was left out and how to narrow the reading.
    warnings.push(`the reading is capped at ${limitValue} rows; ${rowsTruncated} point(s) are omitted — narrow with point_id or raise the reading limit (max 2000)`)
  }
  const pointsWithoutTasks = points.filter((point) => !(tasksByPoint.get(point.point_id) ?? []).length).map((point) => point.point_id)
  return {
    action: 'coverage',
    slug: definition.slug,
    dir: relative(cwd, f.dir).replace(/\\/g, '/'),
    definition,
    totals,
    by_source: bySource,
    by_kind: byKind,
    by_evaluator_kind: byEvaluatorKind,
    rows: returnedRows,
    row_total: filtered.length,
    rows_returned: returnedRows.length,
    rows_truncated: rowsTruncated,
    row_limit: limitValue,
    unaddressed: unaddressedIds,
    planning_gaps: { points_without_tasks: pointsWithoutTasks, tasks: tasks.length, cap: { max_tasks: cap.max_tasks, source: cap.source } },
    closing: closingView,
    outcome_note: OUTCOME_NOTE,
    unreadable,
    warnings,
    note: 'Coverage is this ledger\'s own reading over the imported points and the linked runs; inside an ah.yaml project the engine remains authoritative for item status and response prose.',
  }
}

/* ---------------------------------------------------------------- draft */

function draftEvents(cwd, slugValue) {
  return {
    answers: listRebuttalAnswers(cwd, slugValue),
    declines: listRebuttalDeclines(cwd, slugValue),
    links: listRebuttalLinks(cwd, slugValue),
    points: listRebuttalPoints(cwd, slugValue),
  }
}

function renderLinkLineMarkdown(link) {
  const metricsText = link.run_metrics
    ? Object.entries(link.run_metrics).map(([name, value]) => `${name}=${value}`).join(', ')
    : link.reading ? Object.entries(link.reading).map(([name, value]) => `${name}=${value}`).join(', ') : ''
  return `- ${link.link_id}: ${link.ledger} ${link.slug}/${link.run_id} (digest ${link.digest_state}), ${link.artifact_total} hashed artifact(s)${metricsText ? `, metrics read live: ${metricsText}` : ''}${link.ledger === 'analysis' ? ' (caller reading of hashed outputs)' : ''}`
}

function renderLinkLineLatex(link) {
  const metricsText = link.run_metrics
    ? Object.entries(link.run_metrics).map(([name, value]) => `${name}=${value}`).join(', ')
    : link.reading ? Object.entries(link.reading).map(([name, value]) => `${name}=${value}`).join(', ') : ''
  return latexEscapeText(`- ${link.link_id}: ${link.ledger} ${link.slug}/${link.run_id} (digest ${link.digest_state}), ${link.artifact_total} hashed artifact(s)${metricsText ? `, metrics read live: ${metricsText}` : ''}${link.ledger === 'analysis' ? ' (caller reading of hashed outputs)' : ''}`)
}

export async function draftRebuttalLetter(cwd, slugValue, {
  cap = { max_tasks: REBUTTAL_DEFAULT_MAX_TASKS, source: 'default' },
  format = 'markdown', out = null, points = null, onlyUnanswered = false, overwrite = false,
} = {}) {
  const f = files(cwd, slugValue)
  readRebuttal(cwd, slugValue)
  const wanted = text(format).toLowerCase() || 'markdown'
  if (!REBUTTAL_LETTER_FORMATS.includes(wanted)) {
    throw new Error(`draft format must be one of ${REBUTTAL_LETTER_FORMATS.join(', ')} (json and csv are export formats)`)
  }
  const coverage = await rebuttalCoverage(cwd, slugValue, { cap, limit: 2000 })
  const { points: allPoints, answers, declines } = draftEvents(cwd, slugValue)
  const selectedIds = Array.isArray(points) && points.length ? points.map(text) : null
  if (selectedIds) {
    for (const id of selectedIds) {
      if (!allPoints.some((point) => point.point_id === id)) {
        throw new Error(`point "${id}" not found in rebuttal "${rebuttalSlug(slugValue)}"`)
      }
    }
  }
  let rows = coverage.rows
  if (selectedIds) rows = rows.filter((row) => selectedIds.includes(row.point_id))
  if (onlyUnanswered) rows = rows.filter((row) => row.status === 'unaddressed')
  const diffRecords = new Map()
  const readRecord = (pinSlug) => {
    if (!diffRecords.has(pinSlug)) {
      try {
        diffRecords.set(pinSlug, readJson(join(resolve(cwd), '.dsh', 'manuscript-diff', pinSlug, 'changes.json')))
      } catch {
        diffRecords.set(pinSlug, null)
      }
    }
    return diffRecords.get(pinSlug)
  }
  const warnings = [...coverage.warnings]
  const unresolved = []
  const evidenceStale = []
  const items = []
  const changeSlugs = []
  const ahHandoff = []
  const body = []
  const isLatex = wanted === 'latex'
  const heading = isLatex ? `\\section*{Response to reviewers: ${latexEscapeText(coverage.definition.name || coverage.slug)}}` : `# Response to reviewers: ${coverage.definition.name || coverage.slug}`
  body.push(heading, '')
  for (const row of rows) {
    const point = allPoints.find((entry) => entry.point_id === row.point_id)
    const events = mergeEvents(answers, declines, row.point_id)
    const last = events.at(-1) ?? null
    const kindLine = `${row.source}, ${row.kind}${row.severity ? `, ${row.severity}` : ''}${row.source_label && row.source_label !== row.severity ? `, ${row.source_label}` : ''}`
    if (isLatex) {
      body.push(`\\subsection*{${latexEscapeText(`${row.point_id} (${kindLine})`)}}`, '\\begin{quote}', latexEscapeText(point?.text || '[Reviewer point not recorded.]'), '\\end{quote}')
      body.push(latexEscapeText(`${row.reviewer_id || 'unattributed'} · evaluator: ${row.evaluator_kind ?? 'not_applicable'} (${row.evaluator_kind_source ?? 'not_applicable'})`))
    } else {
      body.push(`## ${row.point_id} (${kindLine})`, '')
      body.push(`> ${point?.text || '[Reviewer point not recorded.]'}`, '')
      body.push(`${row.reviewer_id || 'unattributed'} · evaluator: ${row.evaluator_kind ?? 'not_applicable'} (${row.evaluator_kind_source ?? 'not_applicable'})`, '')
    }
    let item = { id: row.point_id, text: point?.text || '', response: '', status: 'open', change_ids: [] }
    if (!last) {
      const placeholder = '[Author response required — this tool does not write it.]'
      if (isLatex) body.push(`\\textbf{Response.} ${latexEscapeText(placeholder)}`, '')
      else body.push(`**Response.** ${placeholder}`, '')
    } else if (last.kind === 'decline') {
      const decline = last.data
      const label = decline.verified ? 'verified against the engine ledger' : 'not verified against the engine ledger'
      if (isLatex) body.push(`\\textbf{Declined by the author} (${latexEscapeText(label)}): ${latexEscapeText(decline.reason)}`, '')
      else body.push(`**Declined by the author** (${label}): ${decline.reason}`, '')
      item = { ...item, response: decline.reason, status: 'declined' }
    } else if (last && last.kind === 'answer') {
      const answer = last.data
      if (isLatex) body.push(`\\textbf{Response.} ${latexEscapeText(answer.response)}`, '')
      else body.push(`**Response.** ${answer.response}`, '')
      item = { ...item, response: answer.response, change_ids: [...(answer.change_ids || [])] }
      // the letter cites only the links this answer actually cites
      const citedIds = new Set(answer.link_ids || [])
      for (const link of row.links.filter((entry) => citedIds.has(entry.link_id))) {
        if (link.digest_state === 'drifted') {
          evidenceStale.push(link.link_id)
          if (isLatex) body.push(latexEscapeText(`> EVIDENCE STALE: link ${link.link_id} no longer matches its pinned digest`), '')
          else body.push(`> EVIDENCE STALE: link ${link.link_id} no longer matches its pinned digest`, '')
        }
        if (isLatex) body.push(renderLinkLineLatex(link))
        else body.push(renderLinkLineMarkdown(link))
      }
      if (row.links.length) body.push('')
      for (const hunk of row.hunks) {
        if (!hunk.resolved) {
          unresolved.push(hunk.change_id)
          if (isLatex) body.push(`\\textbf{UNRESOLVED:} change \\texttt{${latexEscapeText(hunk.change_id)}} ${latexEscapeText(`is not in the recorded changes for "${hunk.change_slug}"`)}`, '')
          else body.push(`> UNRESOLVED: change \`${hunk.change_id}\` is not in the recorded changes for "${hunk.change_slug}"`, '')
          continue
        }
        const record = readRecord(hunk.change_slug)
        const change = (record?.changes || []).find((entry) => entry.id === hunk.change_id)
        if (!change) continue
        if (!hunk.version_pair_matches) {
          evidenceStale.push(hunk.change_id)
          if (isLatex) body.push(latexEscapeText(`> EVIDENCE STALE: change ${hunk.change_id} no longer matches its pinned version pair`), '')
          else body.push(`> EVIDENCE STALE: change \`${hunk.change_id}\` no longer matches its pinned version pair`, '')
        }
        if (isLatex) {
          body.push(`\\noindent ${latexEscapeText(`${change.id} (${change.kind}), old line ${change.old_start}, new line ${change.new_start}:`)}`, '\\begin{verbatim}')
          for (const line of change.removed) body.push(`-${line}`)
          for (const line of change.added) body.push(`+${line}`)
          body.push('\\end{verbatim}', '')
        } else {
          body.push(`- ${change.id} (${change.kind}), old line ${change.old_start}, new line ${change.new_start}:`, '', '```diff')
          for (const line of change.removed) body.push(`-${line}`)
          for (const line of change.added) body.push(`+${line}`)
          body.push('```', '')
        }
        if (answer.change_pin?.slug && !changeSlugs.includes(answer.change_pin.slug)) changeSlugs.push(answer.change_pin.slug)
      }
      const addressed = row.hunks.some((hunk) => hunk.resolved && hunk.version_pair_matches)
      // manuscript_diff only inspects the literal 'addressed'; anything else
      // with a recorded answer renders as 'rebuttal'.
      item = { ...item, status: addressed ? 'addressed' : 'rebuttal' }
    }
    items.push(item)
  }
  const tail = isLatex
    ? ['\\emph{This is a draft skeleton. Every response and every claim about the revision needs author review.}', '', latexEscapeText(OUTCOME_NOTE), '']
    : ['', '> This is a draft skeleton. Every response and every claim about the revision needs author review.', '', OUTCOME_NOTE, '']
  body.push(...tail)
  const letterFull = body.join(isLatex ? '\n' : '\n')
  const letter = clip(letterFull, LETTER_RETURN_CLIP)
  const letterTruncated = letterFull.length > LETTER_RETURN_CLIP
  // The return value is clipped for the tool channel; the full letter must
  // exist somewhere or the render's "the ledger keeps the full text" claim is
  // false. Keep one ledger-side copy even when the caller supplies `out`.
  const retainedName = `response-letter-${nowIso().replace(/[^0-9A-Za-z]+/g, '-')}.${isLatex ? 'tex' : 'md'}`
  const draftsDir = join(f.dir, 'drafts')
  ensureDir(draftsDir)
  let retainedFile = join(draftsDir, retainedName)
  for (let suffix = 2; existsSync(retainedFile); suffix += 1) {
    retainedFile = join(draftsDir, retainedName.replace(/(\.[^.]+)$/, `-${suffix}$1`))
  }
  const retainedFileWritten = exportText(retainedFile, `${letterFull}\n`, { overwrite: false })
  const retained = { path: relFrom(cwd, retainedFileWritten.path), bytes: retainedFileWritten.bytes }
  // manuscript_diff's letterFromItems resolves every item's change_ids against
  // exactly ONE changes.json (deriveSlug → one record). With more than one
  // pinned slug the items are grouped per slug and the caller runs letter once
  // per revision — a mixed items array would print a false UNRESOLVED.
  let manuscriptDiffItems = items
  let multiSlugNote = null
  if (changeSlugs.length > 1) {
    const grouped = {}
    for (const slugName of changeSlugs) grouped[slugName] = []
    grouped[changeSlugs[0]] = grouped[changeSlugs[0]] || []
    for (const entry of items) {
      const owning = changeSlugs.find((slugName) => (entry.change_ids || []).length
        && (answers.some((answer) => answer.point_id === entry.id && answer.change_pin?.slug === slugName
          && (answer.change_ids || []).some((id) => (entry.change_ids || []).includes(id)))))
      if (owning) grouped[owning].push(entry)
      else grouped[changeSlugs[0]].push(entry)
    }
    manuscriptDiffItems = grouped
    multiSlugNote = 'run manuscript_diff action=letter once per revision slug (items and change_ids resolve against that slug only); never pass a mixed items array'
  }
  for (const row of rows) {
    if (row.source !== 'ah_review' || !row.ah?.item_id) continue
    ahHandoff.push({
      review: row.ah.item_id.split('.').slice(0, -1).join('.') || null,
      item: row.ah.item_id,
      tool: 'ah_review_respond',
      format: isLatex ? 'tex' : 'md',
      note: 'the engine builds the letter from the review snapshot diff; record the response text with ah_review_set and decline only with ah_author action=decline',
    })
  }
  let written = null
  if (text(out)) {
    const abs = resolveWorkspacePath(cwd, text(out), { forWrite: true })
    const result = exportText(abs, `${letterFull}\n`, { overwrite: Boolean(overwrite) })
    written = { path: relFrom(cwd, result.path), bytes: result.bytes }
  }
  return {
    action: 'draft',
    slug: coverage.slug,
    format: wanted,
    letter,
    letter_truncated: letterTruncated,
    retained,
    manuscript_diff_items: manuscriptDiffItems,
    change_slugs: changeSlugs,
    ...(multiSlugNote ? { note: multiSlugNote } : {}),
    ah_handoff: ahHandoff,
    unresolved: [...new Set(unresolved)],
    evidence_stale: [...new Set(evidenceStale)],
    coverage_totals: coverage.totals,
    warnings,
    written,
    outcome_note: OUTCOME_NOTE,
  }
}

/* --------------------------------------------------------------- export */

function exportMarkdown(coverage, lists) {
  const definition = coverage.definition
  const lines = [
    `# Rebuttal coverage: ${definition.name}`,
    '',
    `**Question:** ${definition.question || '(not stated)'}`,
    `**Venue:** ${definition.venue || '(not stated)'}  `,
    `**Manuscript:** ${definition.manuscript || '(not bound)'}`,
    '',
    '## Totals',
    '',
    '| points | answered | answered_asserted | declined_verified | declined_recorded | unaddressed | tasks | links | answers | declines |',
    '|---|---|---|---|---|---|---|---|---|---|',
    `| ${coverage.totals.points} | ${coverage.totals.answered} | ${coverage.totals.answered_asserted} | ${coverage.totals.declined_verified} | ${coverage.totals.declined_recorded} | ${coverage.totals.unaddressed} | ${coverage.totals.tasks} | ${coverage.totals.links} | ${coverage.totals.answers} | ${coverage.totals.declines} |`,
    '',
    '## By source',
    '',
    ...Object.entries(coverage.by_source).map(([source, view]) => `- ${source}: ${view.points} point(s), answered ${view.answered}, answered_asserted ${view.answered_asserted}, declined ${view.declined}, unaddressed ${view.unaddressed}; evaluator_kind held_out ${view.evaluator_kind.held_out} / in_distribution ${view.evaluator_kind.in_distribution} / not_applicable ${view.evaluator_kind.not_applicable}`),
    '',
    '## Points',
    '',
  ]
  const grouped = new Map()
  for (const point of lists.points) {
    if (!grouped.has(point.source)) grouped.set(point.source, [])
    grouped.get(point.source).push(point)
  }
  for (const [source, pts] of grouped) {
    lines.push(`### ${source}`, '')
    for (const point of pts) {
      const row = coverage.rows.find((entry) => entry.point_id === point.point_id)
      lines.push(`- ${point.point_id} (${point.kind}${point.severity ? `, ${point.severity}` : ''}): ${clip(point.text || '', 200)} — status ${row?.status ?? 'unaddressed'}`)
      for (const task of row?.tasks || []) lines.push(`    task ${task.task_id}: ${task.dataset}/${task.metric}/${task.baseline_ref} × ${task.replicates} (${task.replicates_basis})`)
      for (const link of row?.links || []) lines.push(`    link ${link.link_id}: ${link.ledger} ${link.slug}/${link.run_id} (digest ${link.digest_state})`)
    }
    lines.push('')
  }
  lines.push('## Coverage', '', '| point | source | kind | status | tasks | links | closed |', '|---|---|---|---|---|---|---|')
  for (const row of coverage.rows) {
    lines.push(`| ${mdCell(row.point_id)} | ${mdCell(row.source)} | ${mdCell(row.kind)} | ${mdCell(row.status)} | ${row.tasks.length} | ${row.links.length} | ${mdCell(row.closed.state)} |`)
  }
  lines.push('', '## Closing reading', '', `- compared round: ${coverage.closing.compared_round ? `${coverage.closing.compared_round.key} round ${coverage.closing.compared_round.round} (${coverage.closing.compared_round.run_id})` : 'none'}`, `- paired: ${coverage.closing.points_paired}, closed: ${coverage.closing.closed_total}, still_present: ${coverage.closing.still_present_total}, variance_only: ${coverage.closing.variance_only_total}`, `- ${coverage.closing.note}`, '', coverage.outcome_note, '')
  return `${lines.join('\n')}\n`
}

function exportCsv(coverage) {
  const header = ['point_id', 'source', 'kind', 'severity', 'source_label', 'reviewer', 'evaluator_kind', 'evaluator_kind_source', 'status', 'tasks', 'links', 'answers', 'declined_by', 'change_ids', 'closed_state', 'matched_by', 'note']
  const lines = [header.map(csvCell).join(',')]
  const answers = coverage._answers || []
  const declines = coverage._declines || []
  for (const row of coverage.rows) {
    const pointAnswers = answers.filter((entry) => entry.point_id === row.point_id)
    const pointDeclines = declines.filter((entry) => entry.point_id === row.point_id)
    const activeDecline = pointDeclines.at(-1)
    const changeIds = [...new Set(pointAnswers.flatMap((entry) => entry.change_ids || []))]
    lines.push([
      row.point_id, row.source, row.kind, row.severity ?? '', row.source_label ?? '', row.reviewer_id ?? '',
      row.evaluator_kind ?? '', row.evaluator_kind_source ?? '', row.status,
      row.tasks.map((task) => task.task_id).join(' '), row.links.map((link) => link.link_id).join(' '),
      pointAnswers.length, activeDecline?.declined_by ?? (activeDecline ? 'author' : ''),
      changeIds.join(' '), row.closed.state, row.closed.matched_by ?? '', row.text,
    ].map(csvCell).join(','))
  }
  return `${lines.join('\n')}\n`
}

export async function exportRebuttal({ cwd, slug: slugValue, format = 'markdown', overwrite = false, cap = null, closing = null }) {
  const f = files(cwd, slugValue)
  readRebuttal(cwd, slugValue)
  const wanted = text(format).toLowerCase() || 'markdown'
  if (!REBUTTAL_EXPORT_FORMATS.includes(wanted)) {
    throw new Error(`export format must be one of ${REBUTTAL_EXPORT_FORMATS.join(', ')} (latex is a draft format only)`)
  }
  const coverage = await rebuttalCoverage(cwd, slugValue, { cap: cap ?? { max_tasks: REBUTTAL_DEFAULT_MAX_TASKS, source: 'default' }, limit: 2000, closing })
  const lists = {
    points: listRebuttalPoints(cwd, slugValue),
    tasks: listRebuttalTasks(cwd, slugValue),
    links: listRebuttalLinks(cwd, slugValue),
    answers: listRebuttalAnswers(cwd, slugValue),
    declines: listRebuttalDeclines(cwd, slugValue),
    imports: listRebuttalImports(cwd, slugValue),
  }
  coverage._answers = lists.answers
  coverage._declines = lists.declines
  let body
  let name
  if (wanted === 'json') {
    body = `${JSON.stringify({
      definition: coverage.definition,
      imports: lists.imports,
      points: lists.points,
      tasks: lists.tasks,
      links: lists.links,
      answers: lists.answers,
      declines: lists.declines,
      coverage,
    }, null, 2)}\n`
    name = 'rebuttal.json'
  } else if (wanted === 'csv') {
    body = exportCsv(coverage)
    name = 'coverage.csv'
  } else {
    body = exportMarkdown(coverage, lists)
    name = 'report.md'
  }
  const written = exportText(join(f.exports, name), body, { overwrite: Boolean(overwrite) })
  return {
    action: 'export',
    format: wanted,
    path: relFrom(cwd, written.path),
    bytes: written.bytes,
    totals: coverage.totals,
    warnings: coverage.warnings,
  }
}

/* ---------------------------------------------------------------- status */

export async function statusRebuttal(cwd, slugValue, { cap = { max_tasks: REBUTTAL_DEFAULT_MAX_TASKS, source: 'default' } } = {}) {
  const f = files(cwd, slugValue)
  const definition = readJson(f.definition)
  if (!definition) {
    return {
      action: 'status',
      slug: rebuttalSlug(slugValue),
      dir: relative(cwd, f.dir).replace(/\\/g, '/'),
      exists: false,
      state: 'empty',
      note: `no rebuttal under .dsh/rebuttal/${rebuttalSlug(slugValue)}; run action "import" first`,
    }
  }
  const points = readJsonl(f.points)
  const tasks = readJsonl(f.tasks)
  const links = readJsonl(f.links)
  const answers = readJsonl(f.answers)
  const declines = readJsonl(f.declines)
  const imports = readJsonl(f.imports)
  const warnings = []
  let coverage = null
  try {
    coverage = await rebuttalCoverage(cwd, slugValue, { cap, limit: 2000 })
    warnings.push(...coverage.warnings)
  } catch (error) {
    warnings.push(`the coverage reading is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  const bySource = {}
  const byKind = {}
  const byEvaluatorKind = { held_out: 0, in_distribution: 0, not_applicable: 0 }
  const byEvaluatorKindSource = { declared: 0, inferred: 0, not_applicable: 0 }
  for (const point of points) {
    bySource[point.source] = (bySource[point.source] ?? 0) + 1
    byKind[point.kind] = (byKind[point.kind] ?? 0) + 1
    byEvaluatorKind[point.evaluator_kind ?? 'not_applicable'] += 1
    byEvaluatorKindSource[point.evaluator_kind_source ?? 'not_applicable'] += 1
  }
  const replicatesBasis = {}
  const tasksWithoutLinks = []
  const linkedTaskIds = new Set(links.map((link) => link.task_id))
  for (const task of tasks) {
    replicatesBasis[task.replicates_basis] = (replicatesBasis[task.replicates_basis] ?? 0) + 1
    if (!linkedTaskIds.has(task.task_id)) tasksWithoutLinks.push(task.task_id)
  }
  const linksByLedger = {}
  let digestVerified = 0
  let digestDrifted = 0
  let digestUnreadable = 0
  const caches = { cwd: resolve(cwd), experiment: new Map(), analysis: new Map() }
  const unreadable = []
  for (const link of links) {
    linksByLedger[link.source.ledger] = (linksByLedger[link.source.ledger] ?? 0) + 1
    const view = digestStateForLink(link, caches, unreadable)
    if (view.state === 'verified') digestVerified += 1
    else if (view.state === 'drifted') digestDrifted += 1
    else digestUnreadable += 1
  }
  const latestPerPoint = {}
  for (const answer of answers) {
    const current = latestPerPoint[answer.point_id]
    if (!current || answer.ts > current.ts || (answer.ts === current.ts && answer.answer_id > current.answer_id)) {
      latestPerPoint[answer.point_id] = answer
    }
  }
  const deepReviewEnvelopes = imports.filter((envelope) => envelope.source === 'deep_review')
  const ahEnvelopes = imports.filter((envelope) => envelope.source === 'ah_review')
  const orEnvelopes = imports.filter((envelope) => envelope.source === 'openreview')
  let manuscriptSha1Match = null
  if (definition.manuscript && deepReviewEnvelopes.length) {
    let current = null
    try {
      const abs = resolveWorkspacePath(cwd, definition.manuscript)
      if (existsSync(abs) && statSync(abs).isFile()) current = sha1Hex(readFileSync(abs))
    } catch {
      current = null
    }
    if (current) {
      const sha1s = new Set(deepReviewEnvelopes.map((envelope) => envelope.ref?.deep_review?.input_sha1).filter(Boolean))
      manuscriptSha1Match = sha1s.has(current)
    } else {
      manuscriptSha1Match = null
    }
  }
  const sources = {
    deep_review: deepReviewEnvelopes.length
      ? {
        key: deepReviewEnvelopes.at(-1).ref?.deep_review?.key ?? null,
        dir: deepReviewEnvelopes.at(-1).ref?.deep_review?.dir ?? null,
        run_id: deepReviewEnvelopes.at(-1).ref?.deep_review?.run_id ?? null,
        round: deepReviewEnvelopes.at(-1).ref?.deep_review?.round ?? null,
        artifact: deepReviewEnvelopes.at(-1).ref?.deep_review?.artifact ?? null,
        available_rounds: deepReviewEnvelopes.at(-1).ref?.deep_review?.available_rounds ?? null,
        evaluator_kind: deepReviewEnvelopes.at(-1).ref?.deep_review?.evaluator_kind ?? null,
        manuscripts: [...new Set(deepReviewEnvelopes.map((row) => row.ref?.deep_review?.manuscript).filter(Boolean))],
        manuscript_sha1_match: manuscriptSha1Match,
      }
      : null,
    ah_review: [],
    openreview: {
      forum_ids: orEnvelopes.map((envelope) => envelope.ref?.openreview?.forum_id ?? null),
      reviewers: [...new Set(orEnvelopes.flatMap((envelope) => (envelope.ref?.openreview?.reviewers || []).map((entry) => entry.id)))],
    },
  }
  for (const envelope of ahEnvelopes) {
    const rid = envelope.ref?.ah_review?.rid
    let state = 'readable'
    try {
      await readAhReview(cwd, rid)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      state = message.includes('no ah.yaml') ? 'no_ah_project' : 'unreadable'
    }
    sources.ah_review.push({ rid, root: envelope.ref?.ah_review?.root ?? null, file: envelope.ref?.ah_review?.file ?? null, status: state })
  }
  const referencedChangeSlugs = [...new Set(answers.map((answer) => answer.change_pin?.slug).filter(Boolean))]
  const manuscriptDiffView = referencedChangeSlugs.map((slugName) => {
    let record = null
    try {
      record = readJson(join(resolve(cwd), '.dsh', 'manuscript-diff', slugName, 'changes.json'))
    } catch {
      record = null
    }
    const pinned = answers.filter((answer) => answer.change_pin?.slug === slugName)
    return {
      slug: slugName,
      readable: Boolean(record),
      version_pair_matches: record ? pinned.every((answer) => versionPairMatches(answer.change_pin, record)) : null,
    }
  })
  const artifacts = {}
  for (const [name, file] of Object.entries({
    rebuttal: f.definition, points: f.points, tasks: f.tasks, links: f.links,
    answers: f.answers, declines: f.declines, imports: f.imports,
  })) {
    artifacts[name] = existsSync(file) ? { exists: true, bytes: statSync(file).size } : { exists: false, bytes: 0 }
  }
  let exportsListing = []
  try {
    exportsListing = readdirSync(f.exports)
  } catch {
    exportsListing = []
  }
  artifacts.exports = exportsListing
  const state = !points.length
    ? 'imported'
    : (answers.length || declines.length)
      ? 'draftable'
      : links.length
        ? 'linked'
        : tasks.length
          ? 'planned'
          : 'imported'
  return {
    action: 'status',
    exists: true,
    slug: definition.slug,
    dir: relative(cwd, f.dir).replace(/\\/g, '/'),
    state,
    definition,
    points: { total: points.length, by_source: bySource, by_kind: byKind, by_evaluator_kind: byEvaluatorKind, by_evaluator_kind_source: byEvaluatorKindSource },
    tasks: { total: tasks.length, cap: { max_tasks: cap.max_tasks, source: cap.source }, remaining: Math.max(0, cap.max_tasks - tasks.length), without_links: tasksWithoutLinks, replicates_basis: replicatesBasis },
    links: { total: links.length, by_ledger: linksByLedger, digest_verified: digestVerified, digest_drifted: digestDrifted, digest_unreadable: digestUnreadable },
    answers: { total: answers.length, latest_per_point: latestPerPoint },
    declines: { total: declines.length, verified: declines.filter((entry) => entry.verified).length, recorded: declines.filter((entry) => !entry.verified).length },
    imports: imports.slice(-MAX_ENVELOPES_SHOWN),
    coverage: coverage ? { totals: coverage.totals, closing: coverage.closing } : null,
    sources,
    manuscript_diff: manuscriptDiffView,
    artifacts,
    unreadable: coverage?.unreadable ?? unreadable,
    warnings,
    outcome_note: OUTCOME_NOTE,
  }
}
