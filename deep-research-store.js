/**
 * deep_research run ledger.
 *
 * Owns what a long investigation cannot keep in a chat context: the frozen
 * query, the step plan, the corpus with its independence clusters, the claims
 * and their quote status, the gate verdicts, the critic findings, and the ship
 * gate that decides whether a report may be delivered.
 *
 * Pure state. No model calls, no network — verification is injected, so a run
 * is reproducible in a test and a missing verifier stays an explicit
 * `not_checked` rather than becoming a silent pass.
 *
 * Ledger root: `<cwd>/.dsh/deep-research/<run_id>/`
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withLock } from './store-lock.js'
import {
  appendJsonl, ensureDir, exportText, nowIso, readJsonl, requireText, sha256,
  shortHash, slug, writeOnceJson,
} from './ledger-kit.js'
import { clusterSources } from './independence-cluster.js'

export const SCHEMA_VERSION = 1
export const TIERS = ['light', 'full', 'dissertation']
export const REGISTERS = ['teach', 'survey', 'analyze', 'advocate']
export const DEPTH = ['surface', 'standard', 'deep']
export const STEP_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped', 'blocked']
export const QUOTE_STATES = ['supported', 'abstract', 'unsupported', 'not_checked']
export const FINDING_SEVERITIES = ['High', 'Medium', 'Low']
export const GATE_STATES = ['clear', 'flagged', 'blocked', 'not_checked']

const MAX_ARTIFACT_BYTES = 4_000_000

const FILES = {
  query: 'query.md',
  manifest: 'manifest.json',
  state: 'state.jsonl',
  corpus: 'corpus.jsonl',
  claims: 'claims.jsonl',
  verdicts: 'verdicts.jsonl',
  findings: 'findings.jsonl',
  patches: 'patches.jsonl',
  accounting: 'accounting.jsonl',
  artifacts: 'artifacts.jsonl',
  retrieval: 'retrieval.jsonl',
  papers: 'papers.jsonl',
}

export function runRoot(cwd) {
  return join(cwd, '.dsh', 'deep-research')
}

export function runDir(cwd, runId) {
  return join(runRoot(cwd), String(runId))
}

export function fileOf(cwd, runId, name) {
  return join(runDir(cwd, runId), name)
}

function hashText(value) {
  return `sha256:${sha256(String(value ?? ''))}`
}

/** Sequential id inside one ledger: `src-0001`, `cl-0002`, … */
function nextId(rows, field, prefix, width = 4) {
  let highest = 0
  for (const row of rows) {
    const raw = String(row?.[field] ?? '')
    if (!raw.startsWith(prefix)) continue
    const number = Number(raw.slice(prefix.length))
    if (Number.isFinite(number) && number > highest) highest = number
  }
  return `${prefix}${String(highest + 1).padStart(width, '0')}`
}

function nextRunId(cwd) {
  const root = runRoot(cwd)
  if (!existsSync(root)) return 'dr-0001'
  const highest = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .reduce((max, entry) => {
      const match = /^dr-(\d+)$/.exec(entry.name)
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)
  return `dr-${String(highest + 1).padStart(4, '0')}`
}

export function readManifest(cwd, runId) {
  const file = fileOf(cwd, runId, FILES.manifest)
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function readRun(cwd, runId) {
  const manifest = readManifest(cwd, runId)
  if (!manifest) return null
  const dir = runDir(cwd, runId)
  return {
    run_id: manifest.run_id,
    manifest,
    steps: readJsonl(join(dir, FILES.state)),
    records: readJsonl(join(dir, FILES.corpus)),
    claims: foldClaims(readJsonl(join(dir, FILES.claims))),
    verdicts: readJsonl(join(dir, FILES.verdicts)),
    findings: readJsonl(join(dir, FILES.findings)),
    patches: readJsonl(join(dir, FILES.patches)),
    accounting: readJsonl(join(dir, FILES.accounting)),
    artifactLog: readJsonl(join(dir, FILES.artifacts)),
  }
}

export function listRuns(cwd) {
  const root = runRoot(cwd)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^dr-\d+$/.test(entry.name))
    .map((entry) => readManifest(cwd, entry.name))
    .filter(Boolean)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))
      || String(b.run_id).localeCompare(String(a.run_id), undefined, { numeric: true }))
    .map((manifest) => ({
      run_id: manifest.run_id,
      topic: manifest.brief.topic,
      tier: manifest.tier,
      gear: manifest.gear,
      created_at: manifest.created_at,
      steps: stepView(cwd, manifest.run_id),
    }))
}

function normalizeBrief(brief) {
  const questions = (Array.isArray(brief?.research_questions) ? brief.research_questions : [])
    .map((item) => requireText(item, 'research_questions entry'))
  if (!questions.length) {
    throw new Error('a deep research run needs at least one research question, not only a topic')
  }
  if (questions.length > 6) throw new Error('more than six research questions; split into separate runs')
  const register = brief?.register ?? 'analyze'
  if (!REGISTERS.includes(register)) throw new Error(`register must be one of ${REGISTERS.join(', ')}`)
  const inference = brief?.inference_depth ?? 'standard'
  if (!DEPTH.includes(inference)) throw new Error(`inference_depth must be one of ${DEPTH.join(', ')}`)
  return {
    topic: requireText(brief?.topic, 'topic'),
    research_questions: questions.map((text, index) => ({ rq_id: `rq-${String(index + 1).padStart(4, '0')}`, text })),
    angle: String(brief?.angle ?? '').trim() || null,
    reader: String(brief?.reader ?? '').trim() || null,
    register,
    inference_depth: inference,
    domain_notes: String(brief?.domain_notes ?? '').trim() || null,
  }
}

function normalizePlan(plan) {
  const steps = Array.isArray(plan) ? plan : []
  if (!steps.length) throw new Error('the step plan is empty')
  const seen = new Set()
  return steps.map((step, index) => {
    const id = requireText(step?.id ?? step, 'step id')
    if (seen.has(id)) throw new Error(`step plan repeats ${id}`)
    seen.add(id)
    return { order: index + 1, id, name: String(step?.name ?? id), owner: String(step?.owner ?? 'model') }
  })
}

/**
 * A budget cap is either a real number or absent. `Number(null)` is 0, so a
 * naive coercion would turn "no cap" into "zero allowed" and block every run
 * the moment it started.
 */
function toCount(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * Open a run. The query is written once and its hash recorded in the manifest;
 * every later step is checked against that hash, so a paraphrased objective
 * cannot quietly become the objective.
 */
export async function startRun({
  cwd, query, brief, tier = 'full', gear = 'standard', plan, budget = {}, source = 'user', execution = {},
}) {
  if (!TIERS.includes(tier)) throw new Error(`tier must be one of ${TIERS.join(', ')}`)
  const text = String(query ?? '')
  requireText(text, 'query')
  const normalizedBrief = normalizeBrief(brief)
  const frozenPlan = normalizePlan(plan)
  const runId = nextRunId(cwd)
  const dir = runDir(cwd, runId)
  // withLock mkdirs <dir>/.lock without recursion, so the run root must exist
  // before the lock is taken, not inside it.
  ensureDir(dir)
  const manifest = {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    tier,
    gear,
    brief: normalizedBrief,
    plan: frozenPlan,
    query: { chars: text.length, hash: hashText(text) },
    budget: {
      max_llm_calls: toCount(budget.max_llm_calls),
      max_sources: toCount(budget.max_sources),
      timeout_minutes: toCount(budget.timeout_minutes),
    },
    acknowledged_retractions: Array.isArray(budget.acknowledged_retractions)
      ? budget.acknowledged_retractions.map(String) : [],
    // How the run is executed is part of the run, not of the call that happens
    // to resume it: a later `resume` must not silently lose full-text retrieval.
    execution: {
      fetch_full_text: Boolean(execution.fetch_full_text),
      sources: Array.isArray(execution.sources) && execution.sources.length ? execution.sources.map(String) : null,
      contact_email: execution.contact_email ? String(execution.contact_email) : null,
      web_sources: Array.isArray(execution.web_sources) && execution.web_sources.length
        ? execution.web_sources.map(String) : null,
      web_lane: execution.web_lane === undefined ? null : Boolean(execution.web_lane),
      // The level and why it was chosen travel with the run, so a resume does
      // not re-guess and a reader can see what was decided on their behalf.
      effort: execution.effort ? String(execution.effort) : null,
      effort_source: execution.effort_source ? String(execution.effort_source) : null,
      effort_basis: Array.isArray(execution.effort_basis) ? execution.effort_basis.map(String) : [],
      effort_conflict: Boolean(execution.effort_conflict),
      explicit_overrides: execution.explicit_overrides && typeof execution.explicit_overrides === 'object'
        ? execution.explicit_overrides : null,
    },
    source,
    created_at: nowIso(),
  }
  return withLock(dir, () => {
    if (existsSync(join(dir, FILES.manifest))) throw new Error(`run ${runId} already exists`)
    ensureDir(join(dir, 'artifacts'))
    ensureDir(join(dir, 'exports'))
    writeOnceJson(join(dir, FILES.manifest), manifest)
    exportText(join(dir, FILES.query), `${text}\n`)
    appendJsonl(join(dir, FILES.state), frozenPlan.map((step) => ({
      run_id: runId, step_id: step.id, order: step.order, status: 'pending', at: nowIso(),
    })))
    appendJsonl(join(dir, FILES.accounting), [{
      run_id: runId, event: 'created', at: nowIso(), llm_calls: 0, input_tokens: 0, output_tokens: 0,
    }])
    return manifest
  }, { label: 'deep-research run' })
}

/** The canonical query, exactly as the user wrote it. */
export function readQuery(cwd, runId) {
  const file = fileOf(cwd, runId, FILES.query)
  if (!existsSync(file)) throw new Error(`run ${runId} has no frozen query`)
  return readFileSync(file, 'utf8').replace(/\n$/u, '')
}

/** Gospel check: what a step acts on must be this run's query. */
export function assertGospel(cwd, runId, queryText) {
  const manifest = readManifest(cwd, runId)
  if (!manifest) throw new Error(`unknown run ${runId}`)
  const hash = hashText(queryText)
  if (hash !== manifest.query.hash) return { ok: false, code: 'query_drift', expected: manifest.query.hash, got: hash }
  return { ok: true, code: 'match', hash }
}

export async function markStep({ cwd, runId, step, status, detail = null }) {
  if (!STEP_STATUSES.includes(status)) throw new Error(`step status must be one of ${STEP_STATUSES.join(', ')}`)
  const file = fileOf(cwd, runId, FILES.state)
  return withLock(runDir(cwd, runId), () => {
    const rows = readJsonl(file)
    const known = rows.find((row) => row.step_id === step)
    if (!known) throw new Error(`step ${step} is not in the plan for ${runId}`)
    appendJsonl(file, [{
      run_id: runId, step_id: step, order: known.order, status,
      detail: detail ? String(detail).slice(0, 2000) : null, at: nowIso(),
    }])
    return { step_id: step, status, at: nowIso() }
  }, { label: 'deep-research step state' })
}

/** Latest status per step, in plan order. */
export function stepView(cwd, runId) {
  const manifest = readManifest(cwd, runId)
  if (!manifest) return []
  const latest = new Map()
  for (const row of readJsonl(fileOf(cwd, runId, FILES.state))) latest.set(row.step_id, row)
  return manifest.plan.map((step) => ({
    ...step,
    step_id: step.id,
    status: latest.get(step.id)?.status ?? 'pending',
    detail: latest.get(step.id)?.detail ?? null,
    at: latest.get(step.id)?.at ?? null,
  }))
}

/** What a resumed run should do next. `done` and `skipped` are satisfied. */
export function nextPendingStep(cwd, runId) {
  const view = stepView(cwd, runId)
  const blocked = view.find((step) => step.status === 'blocked')
  if (blocked) return { ...blocked, reason: 'a step blocked the run; clear it before continuing' }
  const running = view.find((step) => step.status === 'running')
  if (running) return { ...running, reason: 'step was left running; re-run this step only' }
  const failed = view.find((step) => step.status === 'failed')
  if (failed) return { ...failed, reason: 'step failed; resume re-runs this step' }
  const pending = view.find((step) => step.status === 'pending')
  return pending ? { ...pending, reason: null } : null
}

function independenceOf(clustered) {
  return {
    records: clustered.total_records,
    votes: clustered.independent_votes,
    redundant_records: clustered.redundant_records,
    derivative_clusters: clustered.derivative.length,
    max_copies_one_cluster: clustered.derivative.reduce((max, cluster) => Math.max(max, cluster.copies), 0),
  }
}

export async function appendRecords({ cwd, runId, records, suggestedBy = null, perspective = null, maxRecords = null }) {
  const rows = (Array.isArray(records) ? records : []).map((input) => {
    const title = requireText(input?.title, 'record title')
    const count = Number(input?.citation_count)
    return {
      source: String(input?.source ?? 'unknown'),
      doi: input?.doi ?? null,
      url: input?.url ?? input?.html_url ?? input?.pdf_url ?? null,
      year: Number.isFinite(Number(input?.year)) ? Number(input?.year) : null,
      citation_count: Number.isFinite(count) ? count : null,
      title,
      abstract: input?.abstract ?? input?.tldr ?? null,
      body_chars: Number.isFinite(Number(input?.body_chars)) ? Number(input?.body_chars) : null,
      body_hash: input?.body_hash ?? null,
      oa: input?.oa ?? null,
      // A web page and a trial report are not the same kind of evidence, and the
      // model must be able to see which is which before it weighs them.
      lane: input?.lane === 'web' ? 'web' : 'scholarly',
      work_type: input?.work_type ? String(input.work_type) : (input?.lane === 'web' ? 'web_page' : null),
      pm_paper: input?.pm_paper ?? null,
      perspective: perspective ? String(perspective) : null,
      // A source is either traceable to what surfaced it or an explicit seed.
      suggested_by: suggestedBy ?? input?.suggested_by ?? 'seed',
      retrieved_at: input?.retrieved_at ?? nowIso(),
    }
  })
  if (!rows.length) return { added: 0, dropped: 0, capped: false, records: [], independence: independenceOf(clusterSources([])) }
  const file = fileOf(cwd, runId, FILES.corpus)
  return withLock(runDir(cwd, runId), () => {
    const existing = readJsonl(file)
    // The corpus cap is enforced where records enter, not by blocking the next
    // reading step after a sweep has already overrun it. This is atomic with
    // the append, so parallel retrieval cannot race past the cap.
    const cap = maxRecords === null || maxRecords === undefined
      ? null
      : Number.isFinite(Number(maxRecords)) ? Math.max(0, Math.trunc(Number(maxRecords))) : null
    const accepted = cap === null ? rows : rows.slice(0, Math.max(0, cap - existing.length))
    const dropped = rows.length - accepted.length
    const stamped = []
    for (const row of accepted) {
      stamped.push({ ...row, record_id: nextId(existing.concat(stamped), 'record_id', 'src-'), run_id: runId, added_at: nowIso() })
    }
    // Cluster over the whole corpus: a new reprint can join an older cluster.
    // The ledger id is the cluster key, so members are traceable back to rows.
    const clustered = clusterSources(existing.concat(stamped), { recordId: (record, index) => record.record_id ?? `s${index + 1}` })
    const clusterOf = new Map()
    for (const cluster of clustered.clusters) {
      for (const member of cluster.members) clusterOf.set(member.record_id, cluster.cluster_id)
    }
    const votes = new Map(clustered.clusters.map((cluster) => [cluster.cluster_id, cluster.copies]))
    for (const row of stamped) {
      row.cluster_id = clusterOf.get(row.record_id) ?? null
      row.independent = votes.get(row.cluster_id) === 1
    }
    if (stamped.length) appendJsonl(file, stamped)
    return { added: stamped.length, dropped, capped: dropped > 0, records: stamped, independence: independenceOf(clustered) }
  }, { label: 'deep-research corpus' })
}

/**
 * Link a corpus record to the PaperMemory paper its full text was ingested into.
 *
 * Append-only: the corpus row is never rewritten, so the mapping lives beside it
 * and the latest entry per record wins.
 */
export async function linkPaperMemory({ cwd, runId, recordId, pmPaper, doi = null, status = 'ingested', error = null }) {
  const file = fileOf(cwd, runId, FILES.papers)
  return withLock(runDir(cwd, runId), () => {
    const rows = readJsonl(file)
    const row = {
      link_id: nextId(rows, 'link_id', 'pm-'),
      run_id: runId,
      record_id: requireText(recordId, 'recordId'),
      pm_paper: pmPaper ? String(pmPaper) : null,
      doi: doi ? String(doi) : null,
      status: requireText(status, 'status'),
      error: error ? String(error).slice(0, 240) : null,
      at: nowIso(),
    }
    appendJsonl(file, [row])
    return row
  }, { label: 'deep-research paper links' })
}

/** Latest PaperMemory link per record id. */
export function readPaperLinks(cwd, runId) {
  const latest = new Map()
  for (const row of readJsonl(fileOf(cwd, runId, FILES.papers))) {
    if (row.record_id) latest.set(row.record_id, row)
  }
  return latest
}

/** Cluster identity is derived, so it is recomputed on read, never trusted from a snapshot. */
export function readCorpus(cwd, runId) {
  const rows = readJsonl(fileOf(cwd, runId, FILES.corpus))
  const clustered = clusterSources(rows, { recordId: (record, index) => record.record_id ?? `s${index + 1}` })
  const clusterOf = new Map()
  for (const cluster of clustered.clusters) {
    for (const member of cluster.members) clusterOf.set(member.record_id, cluster.cluster_id)
  }
  const links = readPaperLinks(cwd, runId)
  return {
    records: rows.map((row) => ({
      ...row,
      cluster_id: clusterOf.get(row.record_id) ?? null,
      pm_paper: links.get(row.record_id)?.pm_paper ?? row.pm_paper ?? null,
    })),
    clustered,
    independence: independenceOf(clustered),
    lanes: {
      scholarly: rows.filter((row) => (row.lane ?? 'scholarly') !== 'web').length,
      web: rows.filter((row) => row.lane === 'web').length,
    },
  }
}

/**
 * Record what full-text retrieval actually did.
 *
 * Without this, a run that could not read a single paper reports quote integrity
 * as `not_checked` and nobody can tell whether that means "no papers were open
 * access", "the network was down", or "the flag was never honoured".
 */
export async function appendRetrieval({ cwd, runId, rows }) {
  const file = fileOf(cwd, runId, FILES.retrieval)
  return withLock(runDir(cwd, runId), () => {
    const existing = readJsonl(file)
    const stamped = (Array.isArray(rows) ? rows : []).map((row, index) => ({
      retrieval_id: `rt-${String(existing.length + index + 1).padStart(4, '0')}`,
      run_id: runId,
      record_id: row?.record_id ?? null,
      ok: Boolean(row?.ok),
      bytes: Number.isFinite(Number(row?.bytes)) ? Number(row.bytes) : 0,
      reason: row?.reason ? String(row.reason).slice(0, 200) : null,
      url: row?.url ? String(row.url) : null,
      at: nowIso(),
    }))
    if (stamped.length) appendJsonl(file, stamped)
    return stamped
  }, { label: 'deep-research retrieval' })
}

export function readRetrieval(cwd, runId) {
  const rows = readJsonl(fileOf(cwd, runId, FILES.retrieval))
  const latest = new Map()
  for (const row of rows) if (row.record_id) latest.set(row.record_id, row)
  const withText = [...latest.values()].filter((row) => row.ok)
  const failed = [...latest.values()].filter((row) => !row.ok)
  const reasons = {}
  for (const row of failed) reasons[row.reason ?? 'unspecified'] = (reasons[row.reason ?? 'unspecified'] ?? 0) + 1
  return {
    attempts: latest.size,
    with_text: withText.length,
    failed: failed.length,
    reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([reason, count]) => `${reason}×${count}`),
  }
}

/** Latest revision per claim id; revisions append under the same id. */
function foldClaims(rows) {
  const latest = new Map()
  for (const row of rows) latest.set(row.claim_id, row)
  return [...latest.values()]
}

export async function appendClaims({ cwd, runId, claims }) {
  const file = fileOf(cwd, runId, FILES.claims)
  return withLock(runDir(cwd, runId), () => {
    const existing = readJsonl(file)
    const rows = []
    for (const claim of Array.isArray(claims) ? claims : []) {
      rows.push({
        claim_id: nextId(existing.concat(rows), 'claim_id', 'cl-'),
        run_id: runId,
        rq_id: claim?.rq_id ?? null,
        text: requireText(claim?.text, 'claim text'),
        record_ids: Array.isArray(claim?.record_ids) ? claim.record_ids.map(String) : [],
        quote: claim?.quote ? String(claim.quote) : null,
        // Nothing is `supported` until an injected verifier says so.
        quote_status: QUOTE_STATES.includes(claim?.quote_status) ? claim.quote_status : 'not_checked',
        strength: String(claim?.strength ?? '').trim() || null,
        added_at: nowIso(),
        revision: 1,
      })
    }
    if (rows.length) appendJsonl(file, rows)
    return rows
  }, { label: 'deep-research claims' })
}

/**
 * Append a new revision of one claim. The old row remains in the log; readers
 * fold by claim_id. Used to drop or replace a quote without hand-editing the
 * ledger, which would bypass the quote gate.
 */
export async function reviseClaim({ cwd, runId, claimId, quote = undefined, quoteStatus = 'not_checked', reason = null }) {
  const file = fileOf(cwd, runId, FILES.claims)
  return withLock(runDir(cwd, runId), () => {
    const rows = readJsonl(file)
    const current = foldClaims(rows).find((row) => row.claim_id === claimId)
    if (!current) throw new Error(`unknown claim ${claimId}`)
    const next = {
      ...current,
      quote: quote === undefined ? current.quote : (quote ? String(quote) : null),
      quote_status: QUOTE_STATES.includes(quoteStatus) ? quoteStatus : 'not_checked',
      revision: Number(current.revision ?? 1) + 1,
      revised_at: nowIso(),
      revision_reason: String(reason ?? '').trim() || null,
    }
    appendJsonl(file, [next])
    return next
  }, { label: 'deep-research claims' })
}

/**
 * A critic finding, in the shape Phase 9C requires: an inspected target, one
 * primary check, and a named way to confirm closure. Unobserved evidence is
 * rejected rather than promoted — it stays visible in the gate as `not_checked`.
 */
/**
 * Whether a finding still describes the current report.
 *
 * Legacy findings predate artifact binding. A patch recorded after the finding
 * was raised proves the bytes changed, so those findings are stale rather than
 * current; this keeps old ledgers honest without rewriting them.
 */
export function findingIsCurrent(row, reportHash, patches = []) {
  if (row.artifact_hash !== undefined && row.artifact_hash !== null) return row.artifact_hash === reportHash
  if (reportHash === null || reportHash === undefined) return true
  const added = Date.parse(row.added_at)
  if (!Number.isFinite(added)) return true
  return !patches.some((patch) => {
    const at = Date.parse(patch.at)
    return Number.isFinite(at) && at > added
  })
}

export async function appendFindings({ cwd, runId, findings, stepId = null }) {
  const file = fileOf(cwd, runId, FILES.findings)
  return withLock(runDir(cwd, runId), () => {
    const existing = readJsonl(file)
    const latest = new Map()
    for (const row of existing) latest.set(row.finding_id, row)
    const accepted = []
    const rejected = []
    // A finding belongs to the exact report bytes it was raised against. Without
    // this, a patched report is blocked by findings about text that no longer
    // exists, and a stale gate looks like a current one.
    const report = readArtifact({ cwd, runId, name: 'final_report' })
    const artifactHash = report?.hash ?? null
    const patches = readJsonl(fileOf(cwd, runId, FILES.patches))
    // Only currently open findings for the same report suppress a duplicate.
    // Applied/superseded rows and findings against earlier bytes must not hide a
    // defect that is still present after a patch or a rerun.
    const open = [...latest.values()].filter((row) => row.status === 'open' && findingIsCurrent(row, artifactHash, patches))
    const seen = new Set(open.map((row) => `${row.target}|${row.primary_check}`))
    for (const input of Array.isArray(findings) ? findings : []) {
      const row = {
        finding_id: nextId([...latest.values()].concat(accepted), 'finding_id', 'f-'),
        run_id: runId,
        step_id: input?.step_id ?? stepId,
        severity: FINDING_SEVERITIES.includes(input?.severity) ? input.severity : null,
        title: String(input?.title ?? '').trim() || null,
        reason: String(input?.reason ?? '').trim() || null,
        target: String(input?.target ?? '').trim() || null,
        primary_check: String(input?.primary_check ?? '').trim() || null,
        verifier: String(input?.verifier ?? '').trim() || null,
        evidence_state: String(input?.evidence_state ?? 'observed'),
        // A critic's proposed hunk is only a suggestion; the patcher applies it
        // through applyHunks, which is where the size and uniqueness rules bite.
        suggested_hunk: input?.suggested_hunk && typeof input.suggested_hunk === 'object'
          ? { find: String(input.suggested_hunk.find ?? ''), replace: String(input.suggested_hunk.replace ?? '') }
          : null,
        status: 'open',
        artifact_hash: artifactHash,
        added_at: nowIso(),
      }
      const missing = ['severity', 'target', 'primary_check', 'verifier'].filter((key) => !row[key])
      const key = `${row.target}|${row.primary_check}`
      if (['unobserved', 'not_checked'].includes(row.evidence_state)) {
        rejected.push({ ...row, rejected_reason: 'unobserved_evidence' })
      } else if (missing.length) {
        rejected.push({ ...row, rejected_reason: `missing:${missing.join(',')}` })
      } else if (!row.reason) {
        rejected.push({ ...row, rejected_reason: 'missing_inspection' })
      } else if (seen.has(key)) {
        rejected.push({ ...row, rejected_reason: 'duplicate_target_check' })
      } else {
        seen.add(key)
        accepted.push(row)
      }
    }
    if (accepted.length) appendJsonl(file, accepted)
    return { accepted, rejected }
  }, { label: 'deep-research findings' })
}

export async function markFindingApplied({ cwd, runId, findingId, patchId = null }) {
  const file = fileOf(cwd, runId, FILES.findings)
  return withLock(runDir(cwd, runId), () => {
    const latest = new Map()
    for (const row of readJsonl(file)) latest.set(row.finding_id, row)
    const row = latest.get(findingId)
    if (!row) throw new Error(`unknown finding ${findingId}`)
    const updated = { ...row, status: 'applied', applied_by_patch: patchId, at: nowIso() }
    latest.set(findingId, updated)
    appendJsonl(file, [updated])
    return updated
  }, { label: 'deep-research findings' })
}

/**
 * Retire a step's open findings when that step runs again.
 *
 * Without this, a from_step restart that fixes the report still blocks the ship
 * on findings raised against the earlier text — the gate would be grading a
 * draft that no longer exists.
 */
export async function supersedeFindings({ cwd, runId, stepId }) {
  const file = fileOf(cwd, runId, FILES.findings)
  return withLock(runDir(cwd, runId), () => {
    const latest = new Map()
    for (const row of readJsonl(file)) latest.set(row.finding_id, row)
    const stale = [...latest.values()].filter((row) => row.step_id === stepId && row.status === 'open')
    if (!stale.length) return { superseded: 0 }
    appendJsonl(file, stale.map((row) => ({ ...row, status: 'superseded', at: nowIso() })))
    return { superseded: stale.length, finding_ids: stale.map((row) => row.finding_id) }
  }, { label: 'deep-research findings' })
}

export function readFindings(cwd, runId) {
  const latest = new Map()
  for (const row of readJsonl(fileOf(cwd, runId, FILES.findings))) latest.set(row.finding_id, row)
  return [...latest.values()]
}

export function artifactPath(cwd, runId, name) {
  const safe = slug(requireText(name, 'artifact name'), 60)
  if (!safe) throw new Error('artifact name is not a usable file name')
  return join(runDir(cwd, runId), 'artifacts', `${safe}.md`)
}

/**
 * Write a step's own artifact.
 *
 * An artifact that has received hunks is frozen against regeneration: after
 * synthesis the only permitted change is a patch. That makes "patch, never
 * regenerate" a fact about the store rather than a request in a prompt.
 */
export async function writeArtifact({ cwd, runId, name, body, step = null, overwrite = false }) {
  const file = artifactPath(cwd, runId, name)
  const safe = slug(name, 60)
  const text = String(body ?? '')
  if (Buffer.byteLength(text) > MAX_ARTIFACT_BYTES) throw new Error(`artifact exceeds ${MAX_ARTIFACT_BYTES} bytes: ${name}`)
  return withLock(runDir(cwd, runId), () => {
    if (readJsonl(fileOf(cwd, runId, FILES.patches)).some((row) => row.artifact === safe) && existsSync(file)) {
      throw new Error(`${safe} was patched; later changes must be hunks, not a rewrite`)
    }
    if (existsSync(file) && !overwrite) throw new Error(`${safe} exists; pass overwrite: true to replace it`)
    ensureDir(join(runDir(cwd, runId), 'artifacts'))
    exportText(file, text, { overwrite: true })
    appendJsonl(fileOf(cwd, runId, FILES.artifacts), [{
      run_id: runId, artifact: safe, step_id: step, chars: text.length, hash: hashText(text), at: nowIso(),
    }])
    return { artifact: safe, path: file, chars: text.length, hash: hashText(text) }
  }, { label: 'deep-research artifact' })
}

export function readArtifact({ cwd, runId, name }) {
  const file = artifactPath(cwd, runId, name)
  const safe = slug(name, 60)
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  return { artifact: safe, path: file, text, chars: text.length, hash: hashText(text) }
}

/**
 * Apply surgical hunks to an artifact.
 *
 * Refuses anything that is not a small, findable edit: absent context,
 * ambiguous context, an oversized replacement, or a hunk count that would amount
 * to a rewrite. Refusals come back as escalations, so a critic finding is never
 * silently dropped because it did not fit.
 */
export async function applyHunks({ cwd, runId, artifact, hunks, maxHunkChars = 1200, maxHunks = 24, findingId = null }) {
  const safe = slug(requireText(artifact, 'artifact'), 60)
  const file = artifactPath(cwd, runId, safe)
  return withLock(runDir(cwd, runId), () => {
    if (!existsSync(file)) throw new Error(`artifact ${safe} does not exist`)
    let text = readFileSync(file, 'utf8')
    const before = hashText(text)
    const applied = []
    const escalated = []
    const list = Array.isArray(hunks) ? hunks : []
    if (list.length > maxHunks) {
      return {
        applied: [], escalated: [{ index: null, reason: 'patch_budget', detail: `${list.length} hunks over a budget of ${maxHunks}` }],
        changed: 0, before, after: before,
      }
    }
    list.forEach((hunk, index) => {
      const find = String(hunk?.find ?? '')
      const replace = String(hunk?.replace ?? '')
      if (!find) {
        escalated.push({ index, reason: 'hunk_escalated', detail: 'a hunk must name the text it replaces' })
        return
      }
      if (find.length > maxHunkChars || replace.length > maxHunkChars) {
        escalated.push({ index, reason: 'hunk_escalated', detail: 'hunk too large; a change this size is a structural issue' })
        return
      }
      const first = text.indexOf(find)
      if (first < 0) {
        escalated.push({ index, reason: 'context_not_found', detail: find.slice(0, 80) })
        return
      }
      if (text.indexOf(find, first + 1) >= 0) {
        escalated.push({ index, reason: 'context_ambiguous', detail: find.slice(0, 80) })
        return
      }
      text = text.slice(0, first) + replace + text.slice(first + find.length)
      applied.push({ index, delta_chars: replace.length - find.length })
    })
    if (!applied.length) return { applied: [], escalated, changed: 0, before, after: before }
    exportText(file, text, { overwrite: true })
    const patches = readJsonl(fileOf(cwd, runId, FILES.patches))
    const patchId = nextId(patches, 'patch_id', 'p-')
    const changed = applied.reduce((sum, entry) => sum + Math.abs(entry.delta_chars), 0)
    appendJsonl(fileOf(cwd, runId, FILES.patches), [{
      patch_id: patchId, run_id: runId, artifact: safe, finding_id: findingId,
      hunks: applied.length, changed_chars: changed, before, after: hashText(text),
      escalated: escalated.length, at: nowIso(),
    }])
    return { patch_id: patchId, applied, escalated, changed, before, after: hashText(text) }
  }, { label: 'deep-research patcher' })
}

/** Cumulative spend, so a budget is enforced against a run rather than a call. */
export async function recordUsage({ cwd, runId, llmCalls = 1, inputTokens = 0, outputTokens = 0, step = null }) {
  const file = fileOf(cwd, runId, FILES.accounting)
  return withLock(runDir(cwd, runId), () => {
    const totals = totalsOf(readJsonl(file))
    const row = {
      run_id: runId, step, event: 'usage', at: nowIso(),
      llm_calls: totals.llm_calls + Number(llmCalls || 0),
      input_tokens: totals.input_tokens + Number(inputTokens || 0),
      output_tokens: totals.output_tokens + Number(outputTokens || 0),
    }
    appendJsonl(file, [row])
    return row
  }, { label: 'deep-research accounting' })
}

function totalsOf(accounting) {
  const usage = accounting.filter((row) => row.event === 'usage')
  const last = usage[usage.length - 1]
  return last
    ? { llm_calls: last.llm_calls, input_tokens: last.input_tokens, output_tokens: last.output_tokens }
    : { llm_calls: 0, input_tokens: 0, output_tokens: 0 }
}

/**
 * Persist one active execution segment. A resumable run is paused between calls
 * and may sit blocked for hours; calendar elapsed time is not the work budget.
 */
export async function recordSegment({ cwd, runId, startedAt, endedAt = Date.now(), kind = 'run' }) {
  const start = Number(startedAt)
  const end = Number(endedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  const durationMs = end - start
  return withLock(runDir(cwd, runId), () => {
    const row = {
      run_id: runId, step: null, event: 'segment', kind,
      started_at: new Date(start).toISOString(), ended_at: new Date(end).toISOString(),
      duration_ms: durationMs, at: nowIso(),
    }
    appendJsonl(fileOf(cwd, runId, FILES.accounting), [row])
    return row
  }, { label: 'deep-research accounting' })
}

/**
 * Active milliseconds when segment records exist. Legacy ledgers predate
 * segments; estimate from step state transitions and never from wall-clock time
 * since creation, which would count a paused or blocked run's idle hours.
 */
function activeMsOf(run, cwd, runId) {
  const segments = run.accounting.filter((row) => row.event === 'segment' && Number.isFinite(row.duration_ms))
  if (segments.length) return segments.reduce((sum, row) => sum + Math.max(0, row.duration_ms), 0)
  let total = 0
  const started = new Map()
  for (const row of run.steps) {
    const at = Date.parse(row.at)
    if (!Number.isFinite(at)) continue
    if (row.status === 'running') { started.set(row.step_id, at); continue }
    const begin = started.get(row.step_id)
    if (begin === undefined) continue
    started.delete(row.step_id)
    const elapsed = at - begin
    // A step left running across a host restart is not provably active work.
    if (elapsed > 0 && elapsed <= 60 * 60_000) total += elapsed
  }
  return total
}

export function accounting(cwd, runId) {
  const run = readRun(cwd, runId)
  if (!run) return null
  const totals = totalsOf(run.accounting)
  const activeMs = activeMsOf(run, cwd, runId)
  const started = Date.parse(run.manifest.created_at)
  const corpus = readCorpus(cwd, runId)
  return {
    ...totals,
    active_ms: activeMs,
    elapsed_ms: Number.isFinite(started) ? Math.max(0, Date.now() - started) : null,
    // Kept for callers written before active time existed; it now means active
    // execution time, never calendar time since the run was created.
    wall_ms: activeMs,
    sources: run.records.length,
    votes: corpus.independence.votes,
    derivative_clusters: corpus.independence.derivative_clusters,
    claims: run.claims.length,
    open_findings: readFindings(cwd, runId).filter((row) => row.status === 'open').length,
    patches: run.patches.length,
  }
}

/** Budget check before a step starts, so a run is capped rather than ballooned. */
export function budgetState(cwd, runId, { extraMs = 0 } = {}) {
  const manifest = readManifest(cwd, runId)
  if (!manifest) return { exceeded: false, checks: [] }
  const totals = accounting(cwd, runId)
  const activeMs = (totals.active_ms ?? 0) + Math.max(0, Number(extraMs) || 0)
  const checks = []
  const cap = manifest.budget?.max_llm_calls
  if (cap !== null) checks.push({ kind: 'llm_calls', used: totals.llm_calls, cap, exceeded: totals.llm_calls >= cap })
  const sourceCap = manifest.budget?.max_sources
  // The corpus cap is enforced at ingestion. A legacy corpus already over the
  // cap must not strand a run at its next step; report it as non-blocking.
  if (sourceCap !== null) checks.push({ kind: 'sources', used: totals.sources, cap: sourceCap, exceeded: totals.sources >= sourceCap, blocking: false })
  const minutes = manifest.budget?.timeout_minutes
  if (minutes !== null) {
    const used = Math.round(activeMs / 60_000)
    checks.push({ kind: 'wall_minutes', used, cap: minutes, exceeded: activeMs / 60_000 >= minutes })
  }
  return { exceeded: checks.some((check) => check.exceeded && check.blocking !== false), checks }
}

/**
 * The ship gate. Verification never softens with register, tier, or gear.
 *
 * Each check returns `pass`, `blocked`, or `not_checked`. Only `blocked`
 * prevents delivery; `not_checked` is disclosed so a pass never implies more
 * was verified than actually was. Verifiers arrive injected — a missing ledger
 * or absent tool is an explicit state, never a guess.
 */
export async function shipGate({ cwd, runId, deps = {} }) {
  const run = readRun(cwd, runId)
  if (!run) throw new Error(`unknown run ${runId}`)
  const manifest = run.manifest
  const corpus = readCorpus(cwd, runId)
  const findings = readFindings(cwd, runId)
  const checks = []
  const add = (id, state, detail = null, extra = {}) => checks.push({ id, state, detail, ...extra })

  const gospel = assertGospel(cwd, runId, readQuery(cwd, runId))
  add('query_is_gospel', gospel.ok ? 'pass' : 'blocked', gospel.ok ? manifest.query.hash.slice(0, 18) : gospel.code)

  const report = readArtifact({ cwd, runId, name: 'final_report' })
  if (!report) add('report_present', 'blocked', 'no final_report artifact was written')
  else add('report_present', 'pass', `${report.chars} chars`)

  const answered = new Set(run.claims.filter((claim) => claim.rq_id).map((claim) => claim.rq_id))
  const unanswered = manifest.brief.research_questions.filter((rq) => !answered.has(rq.rq_id))
  if (!run.claims.length) add('research_questions_answered', 'blocked', 'no claims recorded')
  else if (unanswered.length) {
    add('research_questions_answered', 'blocked', `${unanswered.length} unanswered`, { unanswered: unanswered.map((rq) => rq.rq_id) })
  } else add('research_questions_answered', 'pass', `${answered.size} answered`)

  const citedClaims = run.claims.filter((claim) => claim.quote)
  if (!citedClaims.length) add('quote_integrity', 'not_checked', 'no claim carries a verbatim quote')
  else if (typeof deps.quoteStatus !== 'function') add('quote_integrity', 'not_checked', 'no quote verifier supplied')
  else {
    const byId = new Map(corpus.records.map((row) => [row.record_id, row]))
    const bad = []
    let unreadable = 0
    let abstractOnly = 0
    for (const claim of citedClaims) {
      const sources = claim.record_ids.length ? claim.record_ids : [null]
      const verdicts = []
      for (const recordId of sources) {
        const record = recordId ? byId.get(recordId) : null
        if (!record) { verdicts.push('not_checked'); continue }
        const verdict = await deps.quoteStatus(claim.quote, record)
        if (verdict === null || verdict === undefined) { verdicts.push('not_checked'); continue }
        verdicts.push(QUOTE_STATES.includes(verdict) ? verdict : 'unsupported')
      }
      // A claim cites several papers and the sentence normally belongs to one
      // of them, so one cited source carrying the span settles it — the same
      // rule the digest step applies. Abstract-only support is disclosed: it is
      // evidence that the span exists, not proof that the full text says it in
      // this context. Only a claim no cited source supports stops the ship.
      if (verdicts.includes('supported')) continue
      if (verdicts.includes('abstract')) { abstractOnly += 1; continue }
      if (verdicts.includes('unsupported')) bad.push(claim.claim_id)
      else unreadable += 1
    }
    if (bad.length) add('quote_integrity', 'blocked', `${bad.length} claim(s) fail the verbatim check`, { claims: bad })
    else if (unreadable) add('quote_integrity', 'not_checked', `${unreadable} span(s) the verifier could not read`, { abstract_only: abstractOnly })
    else add('quote_integrity', 'pass', abstractOnly
      ? `${citedClaims.length} verified (${abstractOnly} against abstracts only)`
      : `${citedClaims.length} verified`, abstractOnly ? { abstract_only: abstractOnly } : {})
  }

  if (typeof deps.retractionFor !== 'function') add('retracted_citations', 'not_checked', 'no retraction verifier supplied')
  else {
    const acknowledged = new Set(manifest.acknowledged_retractions ?? [])
    const hit = []
    for (const record of corpus.records) {
      if (!record.doi) continue
      const flag = await deps.retractionFor(record)
      if (flag?.retracted && !acknowledged.has(String(normalizeDoiFor(record.doi)))) {
        hit.push({ record_id: record.record_id, doi: record.doi, notice: flag.notice ?? null })
      }
    }
    if (hit.length) add('retracted_citations', 'blocked', `${hit.length} cited work is retracted and unacknowledged`, { hits: hit })
    else add('retracted_citations', 'pass', 'no unacknowledged retraction among cited DOIs')
  }

  // Say which kinds of evidence actually arrived. A run that only read journal
  // metadata has not seen the guidance, regulator statements, or reporting a web
  // lane would surface, and that boundary belongs in the result.
  if (corpus.lanes.web > 0) add('lane_coverage', 'pass', `${corpus.lanes.scholarly} scholarly and ${corpus.lanes.web} web records`)
  else add('lane_coverage', 'not_checked', 'no web-lane records; configure a web provider key and pass web_sources to sweep guidelines, news, and grey literature')

  // Consensus is counted in votes, not copies.
  const inflated = corpus.clustered.derivative.filter((cluster) => cluster.copies >= 3)
  if (!corpus.records.length) add('independence_recorded', 'blocked', 'the corpus is empty')
  else if (inflated.length && typeof deps.consensusClaimed === 'function' && await deps.consensusClaimed(inflated)) {
    add('independence_recorded', 'blocked', `${inflated.length} cluster(s) of 3+ copies cited as independent support`, {
      clusters: inflated.map((cluster) => ({ cluster_id: cluster.cluster_id, copies: cluster.copies, hosts: cluster.hosts })),
    })
  } else {
    add('independence_recorded', 'pass', `${corpus.records.length} records, ${corpus.independence.votes} independent votes`)
  }

  const criticalOpen = findings.filter((row) => row.severity === 'High' && row.status === 'open')
  const currentOpen = criticalOpen.filter((row) => findingIsCurrent(row, report?.hash ?? null, run.patches))
  const staleOpen = criticalOpen.filter((row) => !findingIsCurrent(row, report?.hash ?? null, run.patches))
  if (currentOpen.length) add('critical_findings_applied', 'blocked', `${currentOpen.length} High finding(s) still open`, { findings: currentOpen.map((row) => row.finding_id) })
  else add('critical_findings_applied', 'pass', 'no open High finding for the current report')
  if (staleOpen.length) {
    add('findings_current', 'blocked', `${staleOpen.length} High finding(s) refer to an earlier report; re-run the affected step before shipping`, {
      findings: staleOpen.map((row) => row.finding_id),
      route: 'run from_step=cite_check (and critics when the text changed) so the gate grades the current bytes',
    })
  } else add('findings_current', 'pass', 'all High findings refer to the current report')

  if (!report) add('patch_only', 'not_checked', 'no report to check')
  else if (run.patches.length) add('patch_only', 'pass', `${run.patches.length} patch pass(es); no regeneration after synthesis`)
  else add('patch_only', 'not_checked', 'no patch pass recorded')

  // Say *why* nothing could be verified, instead of leaving not_checked bare.
  const retrieval = readRetrieval(cwd, runId)
  if (!retrieval.attempts) add('full_text_coverage', 'not_checked', 'no full text was requested; pass fetch_full_text: true to verify quotations verbatim')
  else if (retrieval.with_text === 0) add('full_text_coverage', 'not_checked', `${retrieval.failed} retrieval attempt(s) produced no readable text (${retrieval.reasons.join(', ') || 'no reason recorded'})`, retrieval)
  else add('full_text_coverage', 'pass', `${retrieval.with_text} of ${retrieval.attempts} attempted sources readable in full`, retrieval)

  const numeric = typeof deps.numericCheck === 'function' ? await deps.numericCheck(report?.text ?? '') : null
  if (!numeric) add('numeric_consistency', 'not_checked', 'no numeric verifier supplied')
  else add('numeric_consistency', numeric.state ?? 'not_checked', numeric.detail ?? null)

  const loci = typeof deps.lociCoverage === 'function' ? await deps.lociCoverage(cwd, runId) : null
  if (!loci) add('locus_coverage', 'not_checked', 'this tier records no loci, or none supplied')
  else if (loci.missing?.length) add('locus_coverage', 'blocked', `${loci.missing.length} locus/loci have no interim note`, { loci: loci.missing })
  else add('locus_coverage', 'pass', `${loci.covered ?? 0} loci covered`)

  if (typeof deps.hygieneCheck === 'function') {
    const hygiene = await deps.hygieneCheck(report?.text ?? '')
    if (hygiene?.leaks?.length) add('hygiene', 'blocked', `${hygiene.leaks.length} scaffold or prompt leak(s)`, { leaks: hygiene.leaks })
    else if (hygiene) add('hygiene', 'pass', 'no scaffold leak in the report body')
    else add('hygiene', 'not_checked', 'no hygiene verifier supplied')
  } else add('hygiene', 'not_checked', 'no hygiene verifier supplied')

  const blocked = checks.filter((check) => check.state === 'blocked')
  const notChecked = checks.filter((check) => check.state === 'not_checked')
  return {
    run_id: runId,
    status: blocked.length ? 'blocked' : 'pass',
    caveat: notChecked.length && !blocked.length
      ? `${notChecked.length} check(s) could not be verified and are reported as not_checked`
      : null,
    checks,
    blocked: blocked.map((check) => check.id),
    not_checked: notChecked.map((check) => check.id),
    at: nowIso(),
  }
}

function normalizeDoiFor(value) {
  return String(value ?? '').trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//u, '').replace(/^doi:\s*/u, '')
}

export async function recordVerdict({ cwd, runId, gate, status, severity = null, reason = null, route = null, detail = null }) {
  const lowered = requireText(status, 'gate status').toLowerCase()
  if (!GATE_STATES.includes(lowered)) throw new Error(`gate status must be one of ${GATE_STATES.join(', ')}`)
  const file = fileOf(cwd, runId, FILES.verdicts)
  return withLock(runDir(cwd, runId), () => {
    const existing = readJsonl(file)
    const row = {
      verdict_id: nextId(existing, 'verdict_id', 'v-'),
      run_id: runId,
      gate: requireText(gate, 'gate'),
      // CLEAR is the only state that lets the loop stop.
      status: lowered,
      severity: severity ? String(severity).toUpperCase() : null,
      reason: reason ? String(reason) : null,
      route: route ? String(route) : null,
      detail: detail ? String(detail).slice(0, 2000) : null,
      at: nowIso(),
    }
    appendJsonl(file, [row])
    return row
  }, { label: 'deep-research verdicts' })
}

export function latestVerdict(cwd, runId, gate) {
  const rows = readJsonl(fileOf(cwd, runId, FILES.verdicts)).filter((row) => row.gate === gate)
  return rows.length ? rows[rows.length - 1] : null
}

export function displayHash(value) {
  return shortHash(String(value ?? ''))
}
