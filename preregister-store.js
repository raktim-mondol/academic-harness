/**
 * Pre-registration ledger under `<cwd>/.dsh/preregister/<slug>/`.
 *
 * A draft is editable until it is frozen. Each freeze writes a write-once
 * version file plus an append-only summary line; the hash covers the complete
 * plan, so a later edit is visible as a new version rather than a silent
 * change. Nothing here invents a hypothesis, an outcome, or a data-collection
 * fact; missing fields stay missing and are reported.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  appendJsonl, ensureDir, exportText, mdCell, nowIso, readJson, readJsonl,
  sha256, slug as slugify, stableStringify, writeOnceJson,
} from './ledger-kit.js'
import { withLock, writeJsonAtomic } from './store-lock.js'
import { resolveWorkspacePath } from './workspace-path.js'
import { readProtocol as readReviewProtocol } from './review-store.js'
import { deriveState as deriveTournamentState } from './coscientist-store.js'
import { currentPlan as currentAnalysisPlan } from './analysis-store.js'

export const PREREGISTER_ACTIONS = ['start', 'import', 'freeze', 'status', 'verify', 'export', 'submit']
export const PREREGISTER_EXPORT_FORMATS = ['markdown', 'json', 'pdf']
export const IMPORT_SOURCES = ['review', 'coscientist', 'analysis', 'causal_dag', 'power', 'file']
export const DIRECTIONS = ['greater', 'less', 'two_sided', 'difference', 'non_inferiority', 'not_recorded']
const REQUIRED_FIELDS = ['question', 'design', 'hypotheses', 'outcomes', 'analysis_plan']
const MAX_IMPORT_BYTES = 2 * 1024 * 1024

function text(value) {
  return String(value ?? '').trim()
}

function listText(value) {
  if (value == null || value === '') return []
  return (Array.isArray(value) ? value : [value]).map(text).filter(Boolean)
}

export function preregisterSlug(value) {
  const slug = slugify(value, 80)
  if (!slug) throw new Error('slug must contain at least one letter or digit')
  return slug
}

export function preregisterDir(cwd, value) {
  return join(cwd, '.dsh', 'preregister', preregisterSlug(value))
}

function files(cwd, value) {
  const dir = preregisterDir(cwd, value)
  return {
    dir,
    draft: join(dir, 'draft.json'),
    events: join(dir, 'draft-events.jsonl'),
    versions: join(dir, 'versions.jsonl'),
    versionsDir: join(dir, 'versions'),
    exports: join(dir, 'exports'),
  }
}

function normalizeDirection(value) {
  const raw = text(value).toLowerCase().replace(/\s+/g, '_')
  if (!raw) return 'not_recorded'
  if (['greater', 'gt', 'increase', 'positive'].includes(raw)) return 'greater'
  if (['less', 'lt', 'decrease', 'negative'].includes(raw)) return 'less'
  if (['two_sided', 'two-sided', 'two_tailed', 'two-tailed', 'different'].includes(raw)) return raw === 'different' ? 'difference' : 'two_sided'
  if (['non_inferiority', 'non-inferiority', 'noninferiority'].includes(raw)) return 'non_inferiority'
  if (DIRECTIONS.includes(raw)) return raw
  throw new Error(`direction "${value}" is not recognized; use ${DIRECTIONS.join(', ')}`)
}

function normalizeHypotheses(value) {
  if (value == null || value === '') return []
  const raw = Array.isArray(value) ? value : [value]
  return raw.map((entry, index) => {
    if (typeof entry === 'string') {
      const statement = text(entry)
      if (!statement) throw new Error('hypotheses entries must not be empty')
      return { id: `H${index + 1}`, statement, direction: 'not_recorded', notes: null }
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('hypotheses entries must be strings or objects')
    }
    const statement = text(entry.statement || entry.hypothesis || entry.text)
    if (!statement) throw new Error('each hypothesis needs a statement')
    return {
      id: text(entry.id) || `H${index + 1}`,
      statement,
      direction: normalizeDirection(entry.direction),
      notes: text(entry.notes) || null,
    }
  })
}

function normalizeOutcomes(value) {
  if (value == null || value === '') return []
  const raw = Array.isArray(value) ? value : [value]
  return raw.map((entry, index) => {
    if (typeof entry === 'string') {
      const name = text(entry)
      if (!name) throw new Error('outcomes entries must not be empty')
      return { id: `O${index + 1}`, name, type: null, analysis: null, timepoint: null }
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('outcomes entries must be strings or objects')
    }
    const name = text(entry.name || entry.outcome || entry.label)
    if (!name) throw new Error('each outcome needs a name')
    return {
      id: text(entry.id) || `O${index + 1}`,
      name,
      type: text(entry.type) || null,
      analysis: text(entry.analysis) || null,
      timepoint: text(entry.timepoint) || null,
    }
  })
}

function normalizeSampleSize(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) throw new Error('sample_size must be positive')
    return { n: Math.trunc(value), basis: null, dropout: null, power: null, alpha: null }
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('sample_size must be a number or an object')
  const out = {}
  for (const field of ['n', 'per_group', 'clusters', 'cluster_size']) {
    if (value[field] != null && value[field] !== '') {
      const number = Number(value[field])
      if (!Number.isFinite(number) || number <= 0) throw new Error(`sample_size.${field} must be positive`)
      out[field] = Math.trunc(number)
    }
  }
  for (const field of ['dropout', 'power', 'alpha']) {
    if (value[field] != null && value[field] !== '') {
      const number = Number(value[field])
      if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error(`sample_size.${field} must be between 0 and 1`)
      out[field] = number
    }
  }
  for (const field of ['basis', 'test', 'effect_size', 'effect_source', 'note']) {
    const clean = text(value[field])
    if (clean) out[field] = clean
  }
  return Object.keys(out).length ? out : null
}

function normalizeAnalysisPlan(value) {
  if (value == null || value === '') return null
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n')
  if (typeof value === 'object') return stableStringify(value)
  return text(value) || null
}

/** Normalize a plan object; unknown fields are kept so nothing is silently dropped. */
export function normalizePreregistrationPlan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('plan must be an object')
  }
  const plan = { schema_version: 1 }
  for (const field of ['title', 'question', 'design', 'exclusions', 'stopping_rules', 'notes', 'data_collection_start', 'registration_url']) {
    const value = text(input[field])
    if (value) plan[field] = value
  }
  const hypotheses = normalizeHypotheses(input.hypotheses)
  if (hypotheses.length) plan.hypotheses = hypotheses
  const outcomes = normalizeOutcomes(input.outcomes)
  if (outcomes.length) plan.outcomes = outcomes
  const sample = normalizeSampleSize(input.sample_size)
  if (sample) plan.sample_size = sample
  const analysisPlan = normalizeAnalysisPlan(input.analysis_plan)
  if (analysisPlan) plan.analysis_plan = analysisPlan
  const variables = input.variables
  if (variables != null && variables !== '') {
    if (typeof variables !== 'object' || Array.isArray(variables)) throw new Error('variables must be an object')
    plan.variables = variables
  }
  if (input.data_collected != null && input.data_collected !== '') {
    if (typeof input.data_collected !== 'boolean') throw new Error('data_collected must be true or false')
    plan.data_collected = input.data_collected
  }
  for (const [key, value] of Object.entries(input)) {
    if (key in plan || ['schema_version', 'hypotheses', 'outcomes', 'sample_size', 'analysis_plan', 'variables', 'data_collected'].includes(key)) continue
    if (value === undefined) continue
    plan[key] = value
  }
  return plan
}

function flatPlanFromArgs(args) {
  const source = args.plan && typeof args.plan === 'object' && !Array.isArray(args.plan) ? { ...args.plan } : {}
  const direct = [
    'title', 'question', 'design', 'hypotheses', 'outcomes', 'sample_size', 'exclusions',
    'stopping_rules', 'analysis_plan', 'variables', 'data_collected', 'data_collection_start',
    'registration_url', 'notes',
  ]
  for (const field of direct) {
    if (args[field] !== undefined) source[field] = args[field]
  }
  return source
}

function planHash(plan) {
  return `sha256:${sha256(stableStringify(plan))}`
}

function readDraft(cwd, slug) {
  return readJson(files(cwd, slug).draft)
}

function readVersions(cwd, slug) {
  return readJsonl(files(cwd, slug).versions)
}

function versionFile(cwd, slug, version) {
  return join(files(cwd, slug).versionsDir, `v${version}.json`)
}

function requireDraft(cwd, slug) {
  const draft = readDraft(cwd, slug)
  if (!draft) throw new Error(`pre-registration "${preregisterSlug(slug)}" has not been started`)
  return draft
}

function mergePlan(base, patch) {
  const next = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    next[key] = value
  }
  return normalizePreregistrationPlan(next)
}

function changedFields(a, b) {
  if (!a || !b) return []
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  return keys
    .filter((key) => stableStringify(a[key]) !== stableStringify(b[key]))
    .map((key) => ({ field: key, from: a[key] ?? null, to: b[key] ?? null }))
}

function sourcesOf(draft) {
  return Array.isArray(draft.sources) ? draft.sources : []
}

export async function startPreregistration({ cwd, slug, patch = {}, newVersion = false, reason = null, recordedBy = null }) {
  const f = files(cwd, slug)
  ensureDir(f.dir)
  return withLock(f.dir, async () => {
    const versions = readVersions(cwd, slug)
    const latest = versions.at(-1) || null
    const existing = readDraft(cwd, slug)
    const cleanPatch = normalizePreregistrationPlan(patch)
    const hasPatch = Object.keys(cleanPatch).some((key) => key !== 'schema_version')
    if (latest && hasPatch) {
      if (!newVersion) {
        throw new Error('this pre-registration is frozen; pass new_version: true with a reason to edit it (the frozen version stays)')
      }
      if (!text(reason)) throw new Error('editing a frozen pre-registration requires a reason')
    }
    const plan = mergePlan(existing?.plan || {}, cleanPatch)
    const draft = {
      slug: preregisterSlug(slug),
      plan,
      sources: sourcesOf(existing || {}),
      updated_at: nowIso(),
      recorded_by: text(recordedBy) || existing?.recorded_by || null,
      base_version: latest ? latest.version : null,
      reason: text(reason) || existing?.reason || null,
      status: 'draft',
      note_text: 'Draft only. Freeze it before data collection; freezing is a new versioned record, not an overwrite.',
    }
    writeJsonAtomic(f.draft, draft)
    appendJsonl(f.events, [{
      event: 'draft', ts: draft.updated_at, plan_hash: planHash(plan),
      base_version: draft.base_version, reason: draft.reason, recorded_by: draft.recorded_by,
      changed_fields: existing ? changedFields(existing.plan, plan).map((entry) => entry.field) : Object.keys(plan),
    }])
    return {
      slug: draft.slug, created: !existing, draft,
      frozen: Boolean(latest),
      changed_fields: existing ? changedFields(existing.plan, plan).map((entry) => entry.field) : Object.keys(plan),
      warning: latest ? `frozen version ${latest.version} stays; freeze again to record a new version` : null,
    }
  }, { label: 'pre-registration ledger' })
}

function sourceFromReview(cwd, slug) {
  const protocol = readReviewProtocol(cwd, slug)
  const parts = []
  if (protocol.databases?.length) parts.push(`Databases: ${protocol.databases.join(', ')}`)
  if (protocol.inclusion?.length) parts.push(`Inclusion: ${protocol.inclusion.join('; ')}`)
  if (protocol.exclusion?.length) parts.push(`Exclusion: ${protocol.exclusion.join('; ')}`)
  if (protocol.date_range) parts.push(`Date range: ${protocol.date_range}`)
  return {
    fields: {
      question: text(protocol.question),
      design: 'Systematic or scoping review',
      exclusions: protocol.exclusion?.join('; ') || null,
      analysis_plan: parts.join('\n') || null,
      notes: [text(protocol.notes), protocol.reviewers?.length ? `Reviewers: ${protocol.reviewers.join(', ')}` : ''].filter(Boolean).join('\n') || null,
    },
    source: { kind: 'review', slug: preregisterSlug(slug), fields: ['question', 'design', 'exclusions', 'analysis_plan', 'notes'] },
  }
}

function sourceFromTournament(cwd, slug, hypothesisId) {
  const state = deriveTournamentState(cwd, slug)
  let hypothesis = null
  if (text(hypothesisId)) {
    hypothesis = state.byId.get(text(hypothesisId))
    if (!hypothesis) throw new Error(`hypothesis "${hypothesisId}" is not in tournament "${preregisterSlug(slug)}"`)
  } else {
    const active = state.ranked.filter((entry) => entry.status !== 'rejected' && entry.status !== 'quarantined')
    if (active.length !== 1) {
      throw new Error('tournament has more than one candidate; pass id to choose the hypothesis to pre-register')
    }
    hypothesis = active[0]
  }
  const planSteps = hypothesis.protocolPlan?.steps || []
  return {
    fields: {
      title: text(hypothesis.title) || null,
      question: text(state.protocol.goal) || text(hypothesis.title) || null,
      design: 'Hypothesis-testing study (from the tournament protocol)',
      hypotheses: [{ id: text(hypothesis.id) || 'H1', statement: text(hypothesis.title), direction: 'not_recorded', notes: text(hypothesis.summary) || null }],
      outcomes: [],
      analysis_plan: planSteps.length ? planSteps.join('\n') : text(hypothesis.experimental_plan) || null,
      notes: [text(hypothesis.rationale), text(hypothesis.content)].filter(Boolean).join('\n') || null,
    },
    source: { kind: 'coscientist', slug: preregisterSlug(slug), id: hypothesis.id, fields: ['title', 'question', 'design', 'hypotheses', 'analysis_plan', 'notes'] },
  }
}

function sourceFromAnalysis(cwd, slug) {
  const plan = currentAnalysisPlan(cwd, slug)
  if (!plan) throw new Error(`no frozen analysis plan under .dsh/analysis/${preregisterSlug(slug)}`)
  const outcomes = [
    ...(plan.plan.primary_outcomes || []).map((name) => ({ name, type: 'primary' })),
    ...(plan.plan.secondary_outcomes || []).map((name) => ({ name, type: 'secondary' })),
  ]
  return {
    fields: {
      question: plan.plan.question,
      design: 'Analysis plan imported from analysis_run',
      hypotheses: plan.plan.hypotheses || [],
      outcomes,
      analysis_plan: [
        plan.plan.methods ? `Methods: ${plan.plan.methods}` : '',
        plan.plan.corrections ? `Corrections: ${plan.plan.corrections}` : '',
        plan.plan.missing_data_rules ? `Missing data: ${plan.plan.missing_data_rules}` : '',
        plan.plan.exclusions?.length ? `Exclusions: ${plan.plan.exclusions.join('; ')}` : '',
        plan.plan.stopping_rules ? `Stopping rules: ${plan.plan.stopping_rules}` : '',
        plan.plan.alpha != null ? `Alpha: ${plan.plan.alpha}` : '',
      ].filter(Boolean).join('\n') || null,
      exclusions: plan.plan.exclusions?.join('; ') || null,
      stopping_rules: plan.plan.stopping_rules || null,
      notes: [plan.plan.software ? `Software: ${plan.plan.software}` : '', plan.plan.notes || ''].filter(Boolean).join('\n') || null,
      variables: plan.plan.variables && typeof plan.plan.variables === 'object' && !Array.isArray(plan.plan.variables) ? plan.plan.variables : undefined,
      data_collected: null,
    },
    source: { kind: 'analysis', slug: preregisterSlug(slug), version: plan.version, hash: plan.hash, fields: ['question', 'design', 'hypotheses', 'outcomes', 'analysis_plan', 'exclusions', 'stopping_rules', 'notes', 'variables'] },
  }
}

async function sourceFromCausalDag(cwd, slug, treatment, outcome) {
  const { readCausalDag } = await import('./causal-dag-store.js')
  const dag = readCausalDag(cwd, slug)
  const x = text(treatment) || text(dag.treatment)
  const y = text(outcome) || text(dag.outcome)
  if (!x || !y) throw new Error('causal_dag import needs treatment and outcome (or store them on the DAG with action=analyze)')
  const variables = { treatment: x, outcome: y }
  if (Array.isArray(dag.adjustment) && dag.adjustment.length) variables.adjustment = dag.adjustment
  return {
    fields: {
      question: `What is the causal effect of ${x} on ${y}?`,
      design: 'Observational causal analysis',
      analysis_plan: text(dag.analysis_plan)
        || `Specify the estimand for the effect of ${x} on ${y}; adjust using a recorded minimal sufficient set and report unmeasured-confounding sensitivity.`,
      notes: dag.edges?.length ? `DAG ${preregisterSlug(slug)} has ${dag.nodes.length} nodes and ${dag.edges.length} edges; identification details stay in causal_dag.` : null,
      variables,
    },
    source: { kind: 'causal_dag', slug: preregisterSlug(slug), version: dag.version, fields: ['question', 'design', 'analysis_plan', 'notes', 'variables'] },
  }
}

function sourceFromPower(power) {
  if (!power || typeof power !== 'object' || Array.isArray(power)) {
    throw new Error('power import needs a power object such as {n, test, effect_size, power, alpha, effect_source}')
  }
  const n = Number(power.n)
  if (!Number.isFinite(n) || n <= 0) throw new Error('power.n must be a positive number')
  const basis = [
    text(power.test) ? `test ${power.test}` : '',
    power.effect_size != null ? `effect ${power.effect_size}` : '',
    power.power != null ? `target power ${power.power}` : '',
    power.alpha != null ? `alpha ${power.alpha}` : '',
    text(power.effect_source) ? `effect source ${power.effect_source}` : '',
    text(power.note),
  ].filter(Boolean).join(', ')
  return {
    fields: {
      sample_size: {
        n,
        basis: `power_analysis: ${basis || 'supplied in this call'}`,
        power: power.power ?? null,
        alpha: power.alpha ?? null,
        dropout: power.dropout ?? null,
        test: text(power.test) || null,
      },
      notes: text(power.effect_note) || null,
    },
    source: { kind: 'power_analysis', fields: ['sample_size', 'notes'], note: 'power_analysis is stateless; these numbers come from the result object supplied in this call' },
  }
}

function sourceFromFile(cwd, relativePath) {
  const abs = resolveWorkspacePath(cwd, relativePath)
  if (!existsSync(abs)) throw new Error(`file not found: ${relativePath}`)
  const body = readFileSync(abs)
  if (body.byteLength > MAX_IMPORT_BYTES) throw new Error(`file is larger than ${MAX_IMPORT_BYTES} bytes`)
  let parsed
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch (error) {
    throw new Error(`${relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    fields: normalizePreregistrationPlan(parsed),
    source: { kind: 'file', path: relativePath, sha256: `sha256:${sha256(body)}`, fields: Object.keys(parsed) },
  }
}

export async function importPreregistration({ cwd, slug, from, sourceSlug = null, id = null, treatment = null, outcome = null, power = null, file = null, overwrite = false, reason = null, recordedBy = null }) {
  const kind = text(from).toLowerCase()
  if (!IMPORT_SOURCES.includes(kind)) throw new Error(`from must be one of ${IMPORT_SOURCES.join(', ')}`)
  let imported
  if (kind === 'review') imported = sourceFromReview(cwd, sourceSlug || slug)
  else if (kind === 'coscientist') imported = sourceFromTournament(cwd, sourceSlug || slug, id)
  else if (kind === 'analysis') imported = sourceFromAnalysis(cwd, sourceSlug || slug)
  else if (kind === 'causal_dag') imported = await sourceFromCausalDag(cwd, sourceSlug || slug, treatment, outcome)
  else if (kind === 'power') imported = sourceFromPower(power)
  else imported = sourceFromFile(cwd, file)

  const clean = normalizePreregistrationPlan(imported.fields)
  const existing = readDraft(cwd, slug)
  const f = files(cwd, slug)
  ensureDir(f.dir)
  return withLock(f.dir, async () => {
    const versions = readVersions(cwd, slug)
    const latest = versions.at(-1) || null
    const effectiveReason = text(reason) || text(existing?.reason)
    if (latest && !effectiveReason) throw new Error('importing into a frozen pre-registration requires a reason (and freeze again to record a new version)')
    const base = existing?.plan || {}
    const conflicts = []
    const merged = { ...base }
    for (const [key, value] of Object.entries(clean)) {
      if (key === 'schema_version' || value == null) continue
      const current = base[key]
      const currentEmpty = current == null || (Array.isArray(current) && current.length === 0)
      if (!currentEmpty && stableStringify(current) !== stableStringify(value) && !overwrite) {
        conflicts.push(key)
        continue
      }
      merged[key] = value
    }
    if (conflicts.length) {
      throw new Error(`import conflicts on ${conflicts.join(', ')}; pass overwrite: true to replace those fields (or keep the draft values)`)
    }
    const plan = normalizePreregistrationPlan(merged)
    const source = { ...imported.source, imported_at: nowIso() }
    const draft = {
      slug: preregisterSlug(slug),
      plan,
      sources: [...sourcesOf(existing || {}), source],
      updated_at: nowIso(),
      recorded_by: text(recordedBy) || existing?.recorded_by || null,
      base_version: latest ? latest.version : null,
      reason: effectiveReason || null,
      status: 'draft',
      note_text: 'Draft only. Imported values are copied from the named ledger at the recorded time; they are not re-derived here.',
    }
    writeJsonAtomic(f.draft, draft)
    appendJsonl(f.events, [{
      event: 'import', ts: draft.updated_at, source, plan_hash: planHash(plan),
      base_version: draft.base_version, conflicts: [], recorded_by: draft.recorded_by,
    }])
    return { slug: draft.slug, source, draft, imported_fields: Object.keys(clean).filter((key) => key !== 'schema_version') }
  }, { label: 'pre-registration ledger' })
}

function missingRequired(plan) {
  return REQUIRED_FIELDS.filter((field) => {
    const value = plan[field]
    if (Array.isArray(value)) return value.length === 0
    return value == null || text(value) === ''
  })
}

export async function freezePreregistration({ cwd, slug, reason = null, dataCollected = null, allowIncomplete = false, recordedBy = null }) {
  const f = files(cwd, slug)
  ensureDir(f.dir)
  return withLock(f.dir, async () => {
    const draft = requireDraft(cwd, slug)
    const plan = normalizePreregistrationPlan(draft.plan)
    const missing = missingRequired(plan)
    const effectiveReason = text(reason) || text(draft.reason)
    if (missing.length && !allowIncomplete) {
      throw new Error(`cannot freeze: missing ${missing.join(', ')} (complete them or pass allow_incomplete: true with a reason)`)
    }
    if (missing.length && !effectiveReason) throw new Error('freezing an incomplete plan requires a reason')
    const collected = dataCollected == null ? plan.data_collected === true : Boolean(dataCollected)
    if (collected && !effectiveReason) {
      throw new Error('data_collected is true: freezing after data collection requires a reason that is recorded with the version')
    }
    const frozenPlan = collected ? { ...plan, data_collected: true } : plan
    const hash = planHash(frozenPlan)
    const versions = readVersions(cwd, slug)
    const latest = versions.at(-1) || null
    if (latest && latest.plan_hash === hash) {
      return { slug: preregisterSlug(slug), version: latest.version, hash, unchanged: true, data_collected: latest.data_collected }
    }
    if (latest && !effectiveReason) throw new Error('a post-freeze change requires a reason (the earlier version stays)')
    const version = (latest?.version ?? 0) + 1
    const record = {
      version,
      slug: preregisterSlug(slug),
      plan: frozenPlan,
      plan_hash: hash,
      frozen_at: nowIso(),
      reason: effectiveReason || null,
      data_collected: collected,
      incomplete: missing.length ? missing : [],
      sources: sourcesOf(draft),
      recorded_by: text(recordedBy) || draft.recorded_by || null,
      supersedes: latest ? latest.version : null,
      note_text: 'Frozen record. The version file and hash are write-once; later edits become a new version.',
    }
    writeOnceJson(versionFile(cwd, slug, version), record)
    appendJsonl(f.versions, [{
      version, plan_hash: hash, frozen_at: record.frozen_at, reason: record.reason,
      data_collected: collected, incomplete: record.incomplete,
      supersedes: record.supersedes, recorded_by: record.recorded_by,
    }])
    const nextDraft = { ...draft, plan: frozenPlan, base_version: version, reason: null, updated_at: nowIso(), status: 'draft' }
    writeJsonAtomic(f.draft, nextDraft)
    appendJsonl(f.events, [{ event: 'freeze', ts: record.frozen_at, version, plan_hash: hash, data_collected: collected, reason: record.reason, recorded_by: record.recorded_by }])
    return {
      slug: record.slug, version, hash, frozen_at: record.frozen_at, data_collected: collected,
      incomplete: record.incomplete, changed: Boolean(latest), created: true,
      warning: collected
        ? 'This version was frozen after data collection; the recorded reason is the only justification stored.'
        : missing.length
          ? `Frozen with missing ${missing.join(', ')}; the version is marked incomplete.`
          : null,
    }
  }, { label: 'pre-registration ledger' })
}

export function readPreregister(cwd, slug) {
  const draft = readDraft(cwd, slug)
  const versions = readVersions(cwd, slug)
  const latestSummary = versions.at(-1) || null
  let latest = null
  let tampered = false
  if (latestSummary) {
    const record = readJson(versionFile(cwd, slug, latestSummary.version))
    if (!record) tampered = true
    else {
      latest = record
      const currentHash = planHash(normalizePreregistrationPlan(record.plan))
      if (currentHash !== record.plan_hash) tampered = true
    }
  }
  return { draft, versions, latest, latestSummary, tampered }
}

export function preregistrationStatus(cwd, slug) {
  const state = readPreregister(cwd, slug)
  const draftPlan = state.draft ? normalizePreregistrationPlan(state.draft.plan) : null
  const changed = draftPlan && state.latest ? changedFields(state.latest.plan, draftPlan) : []
  return {
    slug: preregisterSlug(slug),
    dir: files(cwd, slug).dir,
    draft: state.draft,
    draft_hash: draftPlan ? planHash(draftPlan) : null,
    versions: state.versions,
    latest: state.latest,
    latest_summary: state.latestSummary,
    tampered: state.tampered,
    changed_fields: changed.map((entry) => entry.field),
    data_collected: state.latest?.data_collected === true || draftPlan?.data_collected === true,
    missing_required: draftPlan ? missingRequired(draftPlan) : REQUIRED_FIELDS,
    sources: sourcesOf(state.draft || {}),
  }
}

export function verifyPreregistration(cwd, slug) {
  const state = readPreregister(cwd, slug)
  const checks = []
  if (!state.latestSummary) {
    return { slug: preregisterSlug(slug), status: 'not_frozen', message: 'no frozen version exists yet', checks }
  }
  let failed = false
  let latestRecord = null
  for (const summary of state.versions) {
    const record = readJson(versionFile(cwd, slug, summary.version))
    if (!record) {
      checks.push({ check: `v${summary.version}:version_file`, status: 'fail', detail: `v${summary.version}.json is missing` })
      failed = true
      continue
    }
    if (summary.version === state.latestSummary.version) latestRecord = record
    const currentHash = planHash(normalizePreregistrationPlan(record.plan))
    checks.push({
      check: `v${summary.version}:plan_hash`,
      status: currentHash === record.plan_hash ? 'pass' : 'fail',
      detail: currentHash === record.plan_hash ? currentHash : `${record.plan_hash} recorded, ${currentHash} recomputed`,
    })
    checks.push({
      check: `v${summary.version}:summary_hash`,
      status: summary.plan_hash === record.plan_hash ? 'pass' : 'fail',
      detail: summary.plan_hash === record.plan_hash ? record.plan_hash : `${summary.plan_hash} in versions.jsonl, ${record.plan_hash} in the version file`,
    })
    if (currentHash !== record.plan_hash || summary.plan_hash !== record.plan_hash) failed = true
  }
  if (latestRecord && state.draft) {
    const draftPlan = normalizePreregistrationPlan(state.draft.plan)
    const changed = changedFields(latestRecord.plan, draftPlan).map((entry) => entry.field)
    checks.push({ check: 'draft_matches_frozen', status: changed.length ? 'changed' : 'pass', detail: changed.length ? `draft differs in ${changed.join(', ')}` : 'draft matches the latest frozen plan' })
  }
  const status = failed ? 'tampered' : checks.some((entry) => entry.status === 'changed') ? 'changed' : 'verified'
  return {
    slug: preregisterSlug(slug), status, version: state.latestSummary.version,
    hash: latestRecord?.plan_hash || state.latestSummary.plan_hash,
    frozen_at: latestRecord?.frozen_at || null,
    data_collected: latestRecord?.data_collected === true, checks,
  }
}

function renderMarkdown(record, summary) {
  const plan = record.plan
  const lines = [
    `# ${plan.title || 'Pre-registration'}`,
    '',
    `**Slug:** \`${record.slug}\` · **Version:** ${record.version} · **Frozen:** ${record.frozen_at}`,
    `**Plan hash:** \`${record.plan_hash}\``,
    plan.data_collected ? '**Data collection had started when this version was frozen.** The recorded reason is shown below; this is not a clean pre-data registration.' : '**Data collection:** not recorded as started at freeze.',
    '',
    '## Question',
    '',
    plan.question || '_not recorded_',
    '',
    '## Design',
    '',
    plan.design || '_not recorded_',
    '',
  ]
  if (plan.sample_size) {
    lines.push('## Sample size', '')
    const sample = plan.sample_size
    const bits = []
    if (sample.n != null) bits.push(`n = ${sample.n}`)
    if (sample.per_group != null) bits.push(`per group = ${sample.per_group}`)
    if (sample.dropout != null) bits.push(`dropout = ${sample.dropout}`)
    if (sample.power != null) bits.push(`power = ${sample.power}`)
    if (sample.alpha != null) bits.push(`alpha = ${sample.alpha}`)
    lines.push(bits.join(' · ') || '_not recorded_', '')
    lines.push(`**Basis:** ${sample.basis || '_not recorded_'}`, '')
  }
  lines.push('## Hypotheses', '')
  if (plan.hypotheses?.length) {
    lines.push('| ID | Statement | Direction |', '|---|---|---|')
    lines.push(...plan.hypotheses.map((entry) => `| ${mdCell(entry.id)} | ${mdCell(entry.statement)} | ${entry.direction || 'not recorded'} |`))
  } else lines.push('_not recorded_')
  lines.push('', '## Outcomes', '')
  if (plan.outcomes?.length) {
    lines.push('| ID | Outcome | Type | Analysis | Timepoint |', '|---|---|---|---|---|')
    lines.push(...plan.outcomes.map((entry) => `| ${mdCell(entry.id)} | ${mdCell(entry.name)} | ${mdCell(entry.type || 'not recorded')} | ${mdCell(entry.analysis || 'not recorded')} | ${mdCell(entry.timepoint || 'not recorded')} |`))
  } else lines.push('_not recorded_')
  lines.push('', '## Exclusions', '', plan.exclusions || '_not recorded_', '')
  lines.push('## Stopping rules', '', plan.stopping_rules || '_not recorded_', '')
  lines.push('## Analysis plan', '', plan.analysis_plan || '_not recorded_', '')
  if (plan.notes) lines.push('## Notes', '', plan.notes, '')
  if (record.reason) lines.push('## Reason for this version', '', record.reason, '')
  if (record.incomplete?.length) lines.push('## Incomplete at freeze', '', record.incomplete.join(', '), '')
  if (record.sources?.length) {
    lines.push('## Imported sources', '')
    for (const source of record.sources) {
      lines.push(`- ${source.kind}${source.slug ? ` \`${source.slug}\`` : ''}${source.id ? ` · ${source.id}` : ''}${source.path ? ` · ${source.path}` : ''}${source.imported_at ? ` · ${source.imported_at}` : ''}`)
    }
    lines.push('')
  }
  lines.push('> This document was assembled from the recorded plan. It is not a guarantee of registry acceptance, and freezing does not make a prediction correct.', '')
  return lines.join('\n')
}

function registryFields(record) {
  const plan = record.plan
  return {
    osf: {
      title: plan.title || null,
      description: [plan.question, plan.design].filter(Boolean).join('\n\n') || null,
      tags: plan.outcomes?.map((entry) => entry.name).filter(Boolean) || [],
      registration_supplement: null,
      note: 'Field names follow the Open Science Framework pre-registration form; submit manually after review.',
    },
    aspredicted: {
      data_collected: plan.data_collected === true ? 'yes' : plan.data_collected === false ? 'no' : 'not recorded',
      hypotheses: plan.hypotheses?.map((entry) => entry.statement) || [],
      main_outcomes: plan.outcomes?.map((entry) => entry.name) || [],
      exclusions: plan.exclusions || null,
      analysis_plan: plan.analysis_plan || null,
    },
  }
}

function latexEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([{}%$#&_])/g, '\\$1')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}')
}

function renderLatex(record) {
  const plan = record.plan
  const body = []
  body.push('\\documentclass[11pt]{article}')
  body.push('\\usepackage[margin=1in]{geometry}')
  body.push('\\usepackage[hidelinks]{hyperref}')
  body.push('\\setlength{\\parindent}{0pt}')
  body.push('\\begin{document}')
  body.push(`\\section*{${latexEscape(plan.title || 'Pre-registration')}}`)
  body.push(`\\textbf{Slug:} \\texttt{${latexEscape(record.slug)}} \\quad \\textbf{Version:} ${record.version} \\quad \\textbf{Frozen:} ${latexEscape(record.frozen_at)}`)
  body.push(`\\textbf{Plan hash:} \\texttt{${latexEscape(record.plan_hash)}}`)
  if (plan.data_collected) body.push('\\textbf{Data collection had started when this version was frozen.}')
  body.push(`\\section*{Question}\n${latexEscape(plan.question || 'not recorded')}`)
  body.push(`\\section*{Design}\n${latexEscape(plan.design || 'not recorded')}`)
  if (plan.sample_size) {
    const sample = plan.sample_size
    body.push(`\\section*{Sample size}\n${latexEscape([
      sample.n != null ? `n = ${sample.n}` : '', sample.per_group != null ? `per group = ${sample.per_group}` : '',
      sample.dropout != null ? `dropout = ${sample.dropout}` : '', sample.power != null ? `power = ${sample.power}` : '',
      sample.alpha != null ? `alpha = ${sample.alpha}` : '',
    ].filter(Boolean).join('; ') || 'not recorded')}\n\n\\textbf{Basis:} ${latexEscape(sample.basis || 'not recorded')}`)
  }
  body.push('\\section*{Hypotheses}')
  if (plan.hypotheses?.length) {
    body.push('\\begin{itemize}')
    for (const entry of plan.hypotheses) body.push(`\\item[${latexEscape(entry.id)}] ${latexEscape(entry.statement)} (${latexEscape(entry.direction || 'not recorded')})`)
    body.push('\\end{itemize}')
  } else body.push('not recorded')
  body.push('\\section*{Outcomes}')
  if (plan.outcomes?.length) {
    body.push('\\begin{itemize}')
    for (const entry of plan.outcomes) body.push(`\\item[${latexEscape(entry.id)}] ${latexEscape(entry.name)} — ${latexEscape(entry.type || 'type not recorded')}; ${latexEscape(entry.analysis || 'analysis not recorded')}; ${latexEscape(entry.timepoint || 'timepoint not recorded')}`)
    body.push('\\end{itemize}')
  } else body.push('not recorded')
  body.push(`\\section*{Exclusions}\n${latexEscape(plan.exclusions || 'not recorded')}`)
  body.push(`\\section*{Stopping rules}\n${latexEscape(plan.stopping_rules || 'not recorded')}`)
  body.push(`\\section*{Analysis plan}\n${latexEscape(plan.analysis_plan || 'not recorded')}`)
  if (plan.notes) body.push(`\\section*{Notes}\n${latexEscape(plan.notes)}`)
  if (record.reason) body.push(`\\section*{Reason for this version}\n${latexEscape(record.reason)}`)
  body.push('\\vspace{1em}\\noindent\\textit{This document was assembled from the recorded plan. It is not a guarantee of registry acceptance.}')
  body.push('\\end{document}')
  return `${body.join('\n')}\n`
}

export async function exportPreregistration({ cwd, slug, format = 'markdown', version = null, out = null, overwrite = false, engine = 'pdflatex' }) {
  const state = readPreregister(cwd, slug)
  if (!state.latestSummary) throw new Error('nothing is frozen yet; run action=freeze first')
  let record = state.latest
  if (version != null) {
    record = readJson(versionFile(cwd, slug, Number(version)))
    if (!record) throw new Error(`version ${version} not found`)
  }
  const kind = text(format).toLowerCase() || 'markdown'
  if (!PREREGISTER_EXPORT_FORMATS.includes(kind)) throw new Error(`format must be one of ${PREREGISTER_EXPORT_FORMATS.join(', ')}`)
  const dir = files(cwd, slug).exports
  ensureDir(dir)
  if (kind === 'markdown') {
    const target = out ? resolveWorkspacePath(cwd, out, { forWrite: true }) : join(dir, 'preregistration.md')
    const result = exportText(target, renderMarkdown(record, state), { overwrite })
    return { ...result, format: 'markdown', version: record.version, plan_hash: record.plan_hash }
  }
  if (kind === 'json') {
    const target = out ? resolveWorkspacePath(cwd, out, { forWrite: true }) : join(dir, 'preregistration.json')
    const body = `${JSON.stringify({
      slug: record.slug, version: record.version, frozen_at: record.frozen_at, plan_hash: record.plan_hash,
      data_collected: record.data_collected, reason: record.reason, incomplete: record.incomplete,
      plan: record.plan, sources: record.sources, registry_fields: registryFields(record),
      note_text: 'Exported from the frozen preregister ledger; registry submission remains manual.',
    }, null, 2)}\n`
    const result = exportText(target, body, { overwrite })
    return { ...result, format: 'json', version: record.version, plan_hash: record.plan_hash, registry_fields: registryFields(record) }
  }
  const texTarget = out ? resolveWorkspacePath(cwd, out, { forWrite: true }).replace(/\.pdf$/i, '.tex') : join(dir, 'preregistration.tex')
  exportText(texTarget, renderLatex(record), { overwrite: true })
  const { compileLatex } = await import('./latex-compile.js')
  const compile = await compileLatex(cwd, texTarget, engine)
  if (!compile.success) {
    return {
      format: 'pdf', version: record.version, plan_hash: record.plan_hash, success: false,
      error: compile.error, log: compile.log,
      tex: texTarget, note: 'The LaTeX source was written; fix the compiler error or export markdown/json instead.',
    }
  }
  return {
    format: 'pdf', version: record.version, plan_hash: record.plan_hash, success: true,
    path: compile.pdf_path, tex: texTarget, bytes: null,
    note: 'PDF compiled from the frozen record. It is a document, not a registry acceptance.',
  }
}

export async function submitPreregistration({ cwd, slug, confirm = false, token = null }) {
  if (!confirm) throw new Error('submit requires confirm: true; nothing is submitted without an explicit confirmation')
  return {
    slug: preregisterSlug(slug), status: 'not_supported',
    token_configured: Boolean(text(token) || text(process.env.OSF_TOKEN)),
    message: 'OSF submission is not implemented in this release: there is no safe generic endpoint for creating a preregistration with the user\'s project metadata. Export the JSON (registry_fields) or Markdown and submit it manually.',
  }
}
