/**
 * GRADE certainty and summary-of-findings state for the review ledger.
 *
 * `grade.json` is write-once outcome definitions; `grade.jsonl` is an
 * append-only judgement log. GRADE is a human judgement: the tool records
 * ratings and derives a suggestion, but never stores an automatic certainty
 * verdict on its own.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { withLock } from './store-lock.js'
import {
  appendJsonl, csvCell, exportText, nowIso, readJson, readJsonl, slug, writeOnceJson,
} from './ledger-kit.js'
import { normalizeReviewer, reviewerKey } from './agreement.js'
import { readProtocol, reviewDir } from './review-store.js'

export const GRADE_DOWNGRADE_DOMAINS = [
  { id: 'risk_of_bias', label: 'Risk of bias' },
  { id: 'inconsistency', label: 'Inconsistency' },
  { id: 'indirectness', label: 'Indirectness' },
  { id: 'imprecision', label: 'Imprecision' },
  { id: 'publication_bias', label: 'Publication bias' },
]

export const GRADE_UPGRADE_DOMAINS = [
  { id: 'large_effect', label: 'Large effect' },
  { id: 'dose_response', label: 'Dose-response' },
  { id: 'plausible_confounding', label: 'Plausible confounding' },
]

export const GRADE_DOMAINS = [...GRADE_DOWNGRADE_DOMAINS, ...GRADE_UPGRADE_DOMAINS]
export const GRADE_DOWNGRADE_RATINGS = ['not_serious', 'serious', 'very_serious']
export const GRADE_UPGRADE_RATINGS = ['upgrade', 'not_applicable']
export const GRADE_CERTAINTIES = ['high', 'moderate', 'low', 'very_low']
const IMPORTANCE = ['critical', 'important', 'not_important', 'not_recorded']

function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function numberOrNull(value, name) {
  if (value == null || value === '') return null
  const result = Number(value)
  if (!Number.isFinite(result)) throw new Error(`${name} must be a finite number`)
  return result
}

function gradeFiles(cwd, slugValue) {
  const dir = reviewDir(cwd, slugValue)
  return { dir, grade: join(dir, 'grade.json'), events: join(dir, 'grade.jsonl') }
}

function ensureGrade(cwd, slugValue) {
  const files = gradeFiles(cwd, slugValue)
  if (!existsSync(files.grade)) {
    throw new Error('no GRADE outcomes are defined for this review; run grade_start first')
  }
  return files
}

export function readGrade(cwd, slugValue) {
  const file = gradeFiles(cwd, slugValue).grade
  if (!existsSync(file)) return null
  return readJson(file)
}

export function readGradeEvents(cwd, slugValue) {
  return readJsonl(gradeFiles(cwd, slugValue).events)
}

function normalizeOutcome(outcome, index) {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
    throw new Error(`outcome ${index + 1} must be an object`)
  }
  const id = slug(outcome.id || outcome.name || `outcome_${index + 1}`, 80)
  if (!id) throw new Error(`outcome ${index + 1} needs an id or name`)
  const name = text(outcome.name) || id
  const importance = text(outcome.importance || 'not_recorded').toLowerCase()
  if (!IMPORTANCE.includes(importance)) {
    throw new Error(`outcome "${id}" importance must be one of ${IMPORTANCE.join(', ')}`)
  }
  const studies = Array.isArray(outcome.studies)
    ? outcome.studies.map((entry) => text(entry)).filter(Boolean)
    : (outcome.studies == null ? null : numberOrNull(outcome.studies, `outcome "${id}" studies`))
  const participants = numberOrNull(outcome.participants, `outcome "${id}" participants`)
  let effectCi = outcome.effect_ci ?? outcome.ci ?? null
  if (Array.isArray(effectCi)) {
    if (effectCi.length !== 2) throw new Error(`outcome "${id}" effect_ci must have two values`)
    effectCi = effectCi.map((value, ciIndex) => numberOrNull(value, `outcome "${id}" effect_ci[${ciIndex}]`))
  } else if (effectCi != null) {
    effectCi = text(effectCi) || null
  }
  return {
    id,
    name,
    comparison: text(outcome.comparison) || null,
    importance,
    studies: studies == null ? null : studies,
    participants,
    effect: text(outcome.effect) || (typeof outcome.effect === 'number' ? outcome.effect : null),
    effect_ci: effectCi,
    measure: text(outcome.measure) || null,
    notes: text(outcome.notes) || null,
  }
}

export async function startGrade({ cwd, slug: slugValue, outcomes = [], resume = false }) {
  readProtocol(cwd, slugValue)
  const files = gradeFiles(cwd, slugValue)
  if (existsSync(files.grade) && !resume) {
    throw new Error('GRADE outcomes already exist for this review; pass resume: true to continue')
  }
  if (existsSync(files.grade)) {
    return { slug: slugValue, dir: files.dir, grade: readJson(files.grade), resumed: true }
  }
  if (!Array.isArray(outcomes) || outcomes.length === 0) {
    throw new Error('outcomes must be a non-empty array')
  }
  const normalized = outcomes.map(normalizeOutcome)
  const seen = new Set()
  for (const outcome of normalized) {
    if (seen.has(outcome.id)) throw new Error(`duplicate GRADE outcome id "${outcome.id}"`)
    seen.add(outcome.id)
  }
  const grade = {
    slug: slugValue,
    version: 1,
    outcomes: normalized,
    created_at: nowIso(),
  }
  writeOnceJson(files.grade, grade)
  if (!existsSync(files.events)) writeFileSync(files.events, '')
  return { slug: slugValue, dir: files.dir, grade, resumed: false }
}

function gradeReviewer(protocol, reviewer) {
  const name = normalizeReviewer(reviewer)
  if (!name) throw new Error('reviewer is required for a GRADE judgement')
  const roster = Array.isArray(protocol.reviewers) ? protocol.reviewers : []
  if (roster.length && !roster.some((entry) => reviewerKey(entry) === reviewerKey(name))) {
    throw new Error(`reviewer ${name} is not in the declared list (${roster.join(', ')})`)
  }
  return name
}

function domainDefinition(domainId) {
  const domain = GRADE_DOMAINS.find((entry) => entry.id === domainId)
  if (!domain) {
    throw new Error(`domain must be one of ${GRADE_DOMAINS.map((entry) => entry.id).join(', ')}`)
  }
  return domain
}

function ratingValid(domainId, rating) {
  return GRADE_UPGRADE_DOMAINS.some((entry) => entry.id === domainId)
    ? GRADE_UPGRADE_RATINGS.includes(rating)
    : GRADE_DOWNGRADE_RATINGS.includes(rating)
}

export async function addGradeJudgement({
  cwd, slug: slugValue, outcome, domain, rating, reason, reviewer,
  quote = null, location = null, page = null, section = null, quoteCheck = null,
  paper = null, override = false,
}) {
  readProtocol(cwd, slugValue)
  const grade = ensureGrade(cwd, slugValue)
  const outcomeId = text(outcome)
  const gradeOutcome = readJson(grade.grade)?.outcomes?.find((entry) => entry.id === outcomeId)
  if (!gradeOutcome) throw new Error(`GRADE outcome "${outcomeId}" not found`)
  const domainId = text(domain)
  domainDefinition(domainId)
  const ratingId = text(rating)
  if (!ratingValid(domainId, ratingId)) {
    const allowed = GRADE_UPGRADE_DOMAINS.some((entry) => entry.id === domainId)
      ? GRADE_UPGRADE_RATINGS
      : GRADE_DOWNGRADE_RATINGS
    throw new Error(`rating must be one of ${allowed.join(', ')} for ${domainId}`)
  }
  const reasonText = text(reason)
  if (!reasonText) throw new Error('a reason is required for every GRADE domain judgement')
  const quoteText = String(quote ?? '').trim()
  const locationText = text(location)
  if (quoteText && !locationText) throw new Error('location is required when a GRADE quote is supplied')
  const protocol = readProtocol(cwd, slugValue)
  const reviewerName = gradeReviewer(protocol, reviewer)

  return withLock(grade.dir, () => {
    const events = readGradeEvents(cwd, slugValue)
    const previous = [...events].reverse().find((event) => event.kind === 'judge'
      && event.outcome === outcomeId && event.domain === domainId
      && reviewerKey(event.reviewer) === reviewerKey(reviewerName))
    if (previous && !override) {
      const article = /^[aeiou]/i.test(domainId) ? 'an' : 'a'
      throw new Error(`${outcomeId} already has ${article} ${domainId} judgement by ${reviewerName}; pass override: true with a reason`)
    }
    if (previous && override && !reasonText) throw new Error('overriding a GRADE judgement requires a reason')
    const event = {
      grade_id: `g${String(events.length + 1).padStart(4, '0')}`,
      kind: 'judge',
      ts: nowIso(),
      outcome: outcomeId,
      domain: domainId,
      rating: ratingId,
      reason: reasonText,
      reviewer: reviewerName,
      quote: quoteText || null,
      location: locationText || null,
      page: page == null ? null : text(page) || null,
      section: section == null ? null : text(section) || null,
      quote_check: quoteCheck,
      paper: text(paper) || null,
      override: Boolean(override),
      supersedes: previous?.grade_id ?? null,
    }
    appendJsonl(grade.events, [event])
    const status = deriveGradeStatus(cwd, slugValue, { outcome: outcomeId })
    return { event, ...status }
  }, { label: 'GRADE ledger' })
}

export async function addGradeOverall({
  cwd, slug: slugValue, outcome, certainty, reason, reviewer, override = false,
}) {
  readProtocol(cwd, slugValue)
  const grade = ensureGrade(cwd, slugValue)
  const outcomeId = text(outcome)
  const gradeOutcome = readJson(grade.grade)?.outcomes?.find((entry) => entry.id === outcomeId)
  if (!gradeOutcome) throw new Error(`GRADE outcome "${outcomeId}" not found`)
  const certaintyId = text(certainty).toLowerCase()
  if (!GRADE_CERTAINTIES.includes(certaintyId)) {
    throw new Error(`certainty must be one of ${GRADE_CERTAINTIES.join(', ')}`)
  }
  const reasonText = text(reason)
  if (!reasonText) throw new Error('a reason is required for the overall GRADE certainty')
  const protocol = readProtocol(cwd, slugValue)
  const reviewerName = gradeReviewer(protocol, reviewer)

  return withLock(grade.dir, () => {
    const events = readGradeEvents(cwd, slugValue)
    const previous = [...events].reverse().find((event) => event.kind === 'overall'
      && event.outcome === outcomeId
      && reviewerKey(event.reviewer) === reviewerKey(reviewerName))
    if (previous && !override) {
      throw new Error(`${outcomeId} already has an overall GRADE certainty by ${reviewerName}; pass override: true with a reason`)
    }
    if (previous && override && !reasonText) throw new Error('overriding the overall GRADE certainty requires a reason')
    const event = {
      grade_id: `g${String(events.length + 1).padStart(4, '0')}`,
      kind: 'overall',
      ts: nowIso(),
      outcome: outcomeId,
      certainty: certaintyId,
      reason: reasonText,
      reviewer: reviewerName,
      override: Boolean(override),
      supersedes: previous?.grade_id ?? null,
    }
    appendJsonl(grade.events, [event])
    const status = deriveGradeStatus(cwd, slugValue, { outcome: outcomeId })
    return { event, ...status }
  }, { label: 'GRADE ledger' })
}

function latestByReviewer(events, outcome, domain = null) {
  const latest = new Map()
  for (const event of events) {
    if (event.kind !== 'judge' || event.outcome !== outcome) continue
    if (domain != null && event.domain !== domain) continue
    latest.set(reviewerKey(event.reviewer), event)
  }
  return latest
}

function latestOverall(events, outcome) {
  const latest = new Map()
  for (const event of events) {
    if (event.kind !== 'overall' || event.outcome !== outcome) continue
    latest.set(reviewerKey(event.reviewer), event)
  }
  return latest
}

function suggestionFor(outcomeStatus, expectedReviewers) {
  const missing = []
  for (const domain of GRADE_DOWNGRADE_DOMAINS) {
    const cell = outcomeStatus.domains[domain.id]
    if (cell.state === 'conflict') return { certainty: null, reason: `conflict in ${domain.label}`, missing: [] }
    if (cell.value == null) missing.push(domain.id)
  }
  if (missing.length) return { certainty: null, reason: `missing domain(s): ${missing.join(', ')}`, missing }
  let score = 0
  for (const domain of GRADE_DOWNGRADE_DOMAINS) {
    const rating = outcomeStatus.domains[domain.id].value
    if (rating === 'serious') score -= 1
    if (rating === 'very_serious') score -= 2
  }
  for (const domain of GRADE_UPGRADE_DOMAINS) {
    const cell = outcomeStatus.domains[domain.id]
    if (cell.state === 'conflict') return { certainty: null, reason: `conflict in ${domain.label}`, missing: [] }
    if (cell.value === 'upgrade') score += 1
  }
  score = Math.min(0, score)
  const certainty = score === 0 ? 'high' : score === -1 ? 'moderate' : score === -2 ? 'low' : 'very_low'
  const missingAny = expectedReviewers.filter((reviewer) => {
    return GRADE_DOWNGRADE_DOMAINS.some((domain) => {
      const cell = outcomeStatus.domains[domain.id]
      return !cell.by_reviewer.some((entry) => reviewerKey(entry.reviewer) === reviewerKey(reviewer))
    })
  })
  return {
    certainty,
    score,
    reason: 'derived from the recorded domain judgements; the stored overall is the human decision',
    missing: missingAny,
  }
}

export function deriveGradeStatus(cwd, slugValue, { outcome = null } = {}) {
  const grade = readGrade(cwd, slugValue)
  if (!grade) {
    return {
      outcomes: [],
      reviewers: [],
      note: 'No GRADE outcomes are defined for this review yet.',
    }
  }
  const protocol = readProtocol(cwd, slugValue)
  const events = readGradeEvents(cwd, slugValue)
  const activeReviewers = [...new Set(events
    .filter((event) => event.kind === 'judge' || event.kind === 'overall')
    .map((event) => event.reviewer)
    .filter(Boolean))]
  const expected = Array.isArray(protocol.reviewers) && protocol.reviewers.length >= 2
    ? protocol.reviewers
    : activeReviewers
  const selected = outcome == null
    ? grade.outcomes
    : grade.outcomes.filter((entry) => entry.id === text(outcome))
  const statuses = selected.map((gradeOutcome) => {
    const domains = {}
    const missing = []
    for (const domain of GRADE_DOMAINS) {
      const latest = latestByReviewer(events, gradeOutcome.id, domain.id)
      const entries = [...latest.values()].map((event) => ({
        reviewer: event.reviewer,
        value: event.rating,
        reason: event.reason,
        quote: event.quote,
        location: event.location,
        quote_status: event.quote_check?.status ?? null,
        event_id: event.grade_id,
        ts: event.ts,
      }))
      const distinct = [...new Set(entries.map((entry) => entry.value))]
      const missingReviewers = expected.filter((reviewer) => !latest.has(reviewerKey(reviewer)))
      const state = distinct.length > 1
        ? 'conflict'
        : entries.length === 0
          ? 'pending'
          : missingReviewers.length
            ? 'incomplete'
            : 'recorded'
      if ((state === 'pending' || state === 'incomplete')
        && GRADE_DOWNGRADE_DOMAINS.some((entry) => entry.id === domain.id)) {
        missing.push(domain.id)
      }
      domains[domain.id] = {
        id: domain.id,
        label: domain.label,
        state,
        value: state === 'recorded' ? distinct[0] : null,
        by_reviewer: entries,
        missing_reviewers: missingReviewers,
      }
    }
    const overallLatest = latestOverall(events, gradeOutcome.id)
    const overallEntries = [...overallLatest.values()].map((event) => ({
      reviewer: event.reviewer,
      value: event.certainty,
      reason: event.reason,
      event_id: event.grade_id,
      ts: event.ts,
    }))
    const overallDistinct = [...new Set(overallEntries.map((entry) => entry.value))]
    const overall = {
      state: overallDistinct.length > 1
        ? 'conflict'
        : overallEntries.length === 0
          ? 'pending'
          : 'recorded',
      value: overallDistinct.length === 1 ? overallDistinct[0] : null,
      by_reviewer: overallEntries,
    }
    const base = { domains, missing_domains: missing }
    const suggestion = suggestionFor({ domains }, expected)
    const warnings = []
    if (overall.state === 'conflict') warnings.push('reviewers recorded different overall certainties')
    if (overall.value && suggestion.certainty && overall.value !== suggestion.certainty) {
      warnings.push(`stored overall ${overall.value} differs from the suggestion ${suggestion.certainty}`)
    }
    if (!overall.value) warnings.push('no overall certainty has been recorded')
    return {
      outcome: gradeOutcome.id,
      name: gradeOutcome.name,
      comparison: gradeOutcome.comparison,
      importance: gradeOutcome.importance,
      studies: gradeOutcome.studies,
      study_count: Array.isArray(gradeOutcome.studies) ? gradeOutcome.studies.length : gradeOutcome.studies,
      participants: gradeOutcome.participants,
      effect: gradeOutcome.effect,
      effect_ci: gradeOutcome.effect_ci,
      measure: gradeOutcome.measure,
      notes: gradeOutcome.notes,
      domains,
      missing_domains: missing,
      suggestion,
      overall,
      warnings,
    }
  })
  return {
    outcomes: statuses,
    reviewers: expected,
    note: grade.outcomes.length === 0 ? 'No GRADE outcomes are defined.' : null,
  }
}

function domainLabel(domainId) {
  return GRADE_DOMAINS.find((entry) => entry.id === domainId)?.label || domainId
}

function certaintyLabel(value) {
  return value ? value.replace(/_/g, ' ') : 'not recorded'
}

function studyCount(outcome) {
  return Array.isArray(outcome.studies)
    ? outcome.studies.length
    : (outcome.studies == null ? null : outcome.studies)
}

function effectText(outcome) {
  const effect = outcome.effect
  const ci = outcome.effect_ci
  if (effect == null) return 'not recorded'
  const value = String(effect)
  if (Array.isArray(ci) && ci.length === 2) return `${value} (${ci[0]}–${ci[1]})`
  if (typeof ci === 'string' && ci) return `${value} (${ci})`
  return value
}

function gradeProfileMarkdown(status) {
  const lines = [
    '# GRADE evidence profile',
    '',
    'Domain ratings are recorded human judgements. The overall certainty is the stored human decision; the suggestion is derived from the domains.',
    '',
  ]
  for (const outcome of status.outcomes) {
    lines.push(`## ${outcome.name}`, '')
    if (outcome.comparison) lines.push(`Comparison: ${outcome.comparison}`, '')
    lines.push(
      `Suggestion: ${outcome.suggestion.certainty || 'not available'}${outcome.suggestion.reason ? ` (${outcome.suggestion.reason})` : ''}`,
      `Stored overall: ${certaintyLabel(outcome.overall.value)}`,
      '',
      '| Domain | Rating | Reviewers | Reason | Quote |',
      '|---|---|---|---|---|',
    )
    for (const domain of GRADE_DOMAINS) {
      const cell = outcome.domains[domain.id]
      const ratings = cell.by_reviewer.length
        ? cell.by_reviewer.map((entry) => `${entry.reviewer}=${entry.value}`).join('; ')
        : ''
      const reasons = cell.by_reviewer.map((entry) => entry.reason).filter(Boolean).join('; ')
      const quotes = cell.by_reviewer.map((entry) => entry.quote).filter(Boolean).join('; ')
      lines.push(`| ${domain.label} | ${cell.value || cell.state} | ${ratings || '(none)'} | ${reasons || ''} | ${quotes || ''} |`)
    }
    for (const warning of outcome.warnings) lines.push(`- Warning: ${warning}`)
    lines.push('')
  }
  lines.push('Recorded certainty judgements only; not a recommendation or a guarantee.')
  return lines.join('\n')
}

function gradeProfileCsv(status) {
  const lines = ['outcome,outcome_name,domain,rating,state,reviewers,reasons,quotes']
  for (const outcome of status.outcomes) {
    for (const domain of GRADE_DOMAINS) {
      const cell = outcome.domains[domain.id]
      lines.push([
        outcome.outcome,
        outcome.name,
        domain.id,
        cell.value || '',
        cell.state,
        cell.by_reviewer.map((entry) => `${entry.reviewer}=${entry.value}`).join('; '),
        cell.by_reviewer.map((entry) => entry.reason).filter(Boolean).join('; '),
        cell.by_reviewer.map((entry) => entry.quote).filter(Boolean).join('; '),
      ].map(csvCell).join(','))
    }
  }
  return `${lines.join('\n')}\n`
}

function sofRows(status) {
  return status.outcomes.map((outcome) => ({
    outcome: outcome.name,
    studies: studyCount(outcome) ?? 'not recorded',
    participants: outcome.participants ?? 'not recorded',
    effect: effectText(outcome),
    certainty: outcome.overall.value || (outcome.overall.state === 'conflict' ? 'conflict' : 'not assessed'),
    comments: outcome.notes || '',
  }))
}

function sofMarkdown(status) {
  const lines = [
    '# Summary of findings',
    '',
    '| Outcome | Studies | Participants | Effect (95% CI) | Certainty | Comments |',
    '|---|---:|---:|---|---|---|',
  ]
  for (const row of sofRows(status)) {
    lines.push(`| ${row.outcome} | ${row.studies} | ${row.participants} | ${row.effect} | ${row.certainty} | ${row.comments} |`)
  }
  lines.push('', 'Certainty is the recorded human GRADE decision, not an automatic verdict. "Conflict" means reviewers recorded different overall certainties.')
  return lines.join('\n')
}

function sofCsv(status) {
  const lines = ['outcome,studies,participants,effect,certainty,comments']
  for (const row of sofRows(status)) {
    lines.push([row.outcome, row.studies, row.participants, row.effect, row.certainty, row.comments].map(csvCell).join(','))
  }
  return `${lines.join('\n')}\n`
}

function latexEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
}

function sofLatex(status) {
  const lines = [
    '\\begin{longtable}{p{0.22\\linewidth}rp{0.12\\linewidth}p{0.24\\linewidth}p{0.13\\linewidth}p{0.18\\linewidth}}',
    '\\caption{Summary of findings. Certainty is the recorded human GRADE decision.}\\label{tab:sof}\\\\',
    '\\hline',
    'Outcome & Studies & Participants & Effect (95\\% CI) & Certainty & Comments \\\\',
    '\\hline',
    '\\endfirsthead',
    '\\hline',
    'Outcome & Studies & Participants & Effect (95\\% CI) & Certainty & Comments \\\\',
    '\\hline',
    '\\endhead',
  ]
  for (const row of sofRows(status)) {
    lines.push(`${latexEscape(row.outcome)} & ${latexEscape(row.studies)} & ${latexEscape(row.participants)} & ${latexEscape(row.effect)} & ${latexEscape(row.certainty)} & ${latexEscape(row.comments)} \\\\`)
  }
  lines.push('\\hline', '\\end{longtable}')
  return `${lines.join('\n')}\n`
}

export function exportGradeProfile({ cwd, slug: slugValue, table_format = 'markdown', overwrite = false }) {
  const status = deriveGradeStatus(cwd, slugValue)
  if (!status.outcomes.length) throw new Error('no GRADE outcomes are defined')
  const format = text(table_format).toLowerCase()
  if (format === 'md') return exportGradeProfile({ cwd, slug: slugValue, table_format: 'markdown', overwrite })
  if (!['markdown', 'csv'].includes(format)) throw new Error('table_format must be markdown or csv for grade-profile')
  const name = format === 'csv' ? 'grade-profile.csv' : 'grade-profile.md'
  const body = format === 'csv' ? gradeProfileCsv(status) : gradeProfileMarkdown(status)
  const out = join(reviewDir(cwd, slugValue), 'exports', name)
  const result = exportText(out, body, { overwrite })
  return { format: 'grade-profile', table_format: format, path: relative(resolve(cwd), out), bytes: result.bytes }
}

export function exportSofTable({ cwd, slug: slugValue, table_format = 'markdown', overwrite = false }) {
  const status = deriveGradeStatus(cwd, slugValue)
  if (!status.outcomes.length) throw new Error('no GRADE outcomes are defined')
  let format = text(table_format).toLowerCase()
  if (format === 'md') format = 'markdown'
  if (format === 'tex') format = 'latex'
  if (!['markdown', 'csv', 'latex'].includes(format)) {
    throw new Error('table_format must be markdown, csv, or latex for sof-table')
  }
  const name = format === 'csv' ? 'sof-table.csv' : format === 'latex' ? 'sof-table.tex' : 'sof-table.md'
  const body = format === 'csv' ? sofCsv(status) : format === 'latex' ? sofLatex(status) : sofMarkdown(status)
  const out = join(reviewDir(cwd, slugValue), 'exports', name)
  const result = exportText(out, body, { overwrite })
  return { format: 'sof-table', table_format: format, path: relative(resolve(cwd), out), bytes: result.bytes }
}
