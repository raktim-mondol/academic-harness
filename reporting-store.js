/**
 * Append-only reporting-guideline ledger under `<cwd>/.dsh/reporting/<slug>/`.
 *
 * `check.json` is the write-once snapshot (guideline, manuscript identity, hash,
 * item ids). `verdicts.jsonl` is an event log; the current verdict for an item is
 * the latest event. Corrections append a new event and keep the old one. Exports
 * go to `exports/`.
 *
 * A verdict is evidence, not a compliance verdict: the export reports counts of
 * items with verified evidence and never labels the manuscript compliant.
 */
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { withLock, writeJsonAtomic } from './store-lock.js'

export const VERDICTS = ['reported', 'partial', 'not_reported', 'not_applicable']
export const EVIDENCE_VERDICTS = new Set(['reported', 'partial'])
const MAX_QUOTE_RENDER = 220

function nowIso() {
  return new Date().toISOString()
}

function text(value) {
  if (value == null) return ''
  if (Array.isArray(value)) return text(value[0])
  return String(value).replace(/\s+/g, ' ').trim()
}

export function reportingSlug(value) {
  const slug = text(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  if (!slug) throw new Error('slug must contain at least one letter or digit')
  return slug
}

export function reportingDir(cwd, slug) {
  return join(resolve(cwd), '.dsh', 'reporting', reportingSlug(slug))
}

function checkPath(cwd, slug) {
  return join(reportingDir(cwd, slug), 'check.json')
}

function verdictsPath(cwd, slug) {
  return join(reportingDir(cwd, slug), 'verdicts.jsonl')
}

function ensureCheck(cwd, slug) {
  const dir = reportingDir(cwd, slug)
  if (!existsSync(checkPath(cwd, slug))) throw new Error(`reporting check "${reportingSlug(slug)}" has not been started`)
  return dir
}

function ensureFiles(dir) {
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'exports'), { recursive: true })
  if (!existsSync(join(dir, 'verdicts.jsonl'))) writeFileSync(join(dir, 'verdicts.jsonl'), '')
}

export function readCheck(cwd, slug) {
  const file = checkPath(cwd, slug)
  if (!existsSync(file)) throw new Error(`reporting check "${reportingSlug(slug)}" has not been started`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function readVerdicts(cwd, slug) {
  const file = verdictsPath(cwd, slug)
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split('\n')
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) continue
    try {
      rows.push(JSON.parse(line))
    } catch (error) {
      throw new Error(`verdicts.jsonl line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return rows
}

export function latestVerdicts(events) {
  const latest = new Map()
  for (const event of events) latest.set(event.item_id, event)
  return latest
}

const withReportingLock = (dir, fn) => withLock(dir, fn, { label: 'reporting ledger' })

export async function startCheck({
  cwd, slug, guideline, manuscript, itemIds, resume = false,
}) {
  const dir = reportingDir(cwd, slug)
  ensureFiles(dir)
  const file = checkPath(cwd, slug)
  if (existsSync(file)) {
    if (!resume) throw new Error(`reporting check "${reportingSlug(slug)}" already exists; pass resume: true to continue it`)
    const existing = JSON.parse(readFileSync(file, 'utf8'))
    if (guideline && existing.guideline?.id !== guideline.id) {
      throw new Error(`reporting check "${reportingSlug(slug)}" uses ${existing.guideline?.id}; it cannot be resumed as ${guideline.id}`)
    }
    if (guideline?.version && existing.guideline?.version !== guideline.version) {
      throw new Error(`reporting check "${reportingSlug(slug)}" uses ${existing.guideline?.name}; it cannot be resumed as version ${guideline.version}`)
    }
    return { slug: reportingSlug(slug), dir, check: existing, resumed: true }
  }
  if (!guideline || !manuscript) throw new Error('a new reporting check needs a guideline and a manuscript')
  const stored = {
    slug: reportingSlug(slug),
    guideline: {
      id: guideline.id,
      name: guideline.name,
      version: guideline.version,
      source_url: guideline.source_url,
      item_count: itemIds.length,
    },
    manuscript: {
      kind: manuscript.kind,
      path: manuscript.path ?? null,
      paper: manuscript.paper ?? null,
      title: manuscript.title ?? null,
      format: manuscript.format ?? null,
      sha256: manuscript.sha256,
      chars: manuscript.chars,
      lines: manuscript.lines,
      truncated: Boolean(manuscript.truncated),
      notes: manuscript.notes || [],
    },
    item_ids: itemIds,
    created_at: nowIso(),
  }
  writeJsonAtomic(file, stored)
  return { slug: stored.slug, dir, check: stored, resumed: false }
}

function normaliseSearched(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean)
  const raw = text(value)
  return raw ? raw.split(/\s*[;,]\s*/).map(text).filter(Boolean) : []
}

export async function recordVerdict({
  cwd, slug, itemId, verdict, evidence = null, searched = [], reason = '', reviewer = null, override = false,
}) {
  const dir = ensureCheck(cwd, slug)
  const check = readCheck(cwd, slug)
  if (!check.item_ids.includes(itemId)) throw new Error(`item ${itemId} is not in this checklist (${check.guideline.name})`)
  if (!VERDICTS.includes(verdict)) throw new Error(`verdict must be one of ${VERDICTS.join(', ')}`)
  const note = text(reason)
  let quote = null
  if (EVIDENCE_VERDICTS.has(verdict)) {
    quote = String(evidence?.quote ?? '').trim()
    if (!quote) throw new Error(`verdict "${verdict}" requires a verbatim evidence quote`)
    if (quote.length < 8) throw new Error('the evidence quote is too short to identify a passage (minimum 8 characters)')
    if (!text(evidence?.location)) throw new Error(`verdict "${verdict}" requires a location for the quote`)
  }
  const searchedTerms = normaliseSearched(searched)
  if (verdict === 'not_reported' && !searchedTerms.length) {
    throw new Error('not_reported is a claim of absence: list the terms or sections searched (searched)')
  }
  if (verdict === 'not_applicable' && !note) {
    throw new Error('not_applicable requires a reason so a reader can challenge it')
  }
  return withReportingLock(dir, () => {
    const events = readVerdicts(cwd, slug)
    const latest = latestVerdicts(events).get(itemId)
    if (latest && !override) {
      throw new Error(`item ${itemId} already has a verdict (${latest.verdict}); pass override: true with a reason to replace it`)
    }
    if (latest && override && !note) {
      throw new Error('overriding a verdict requires a reason; both events are kept')
    }
    const event = {
      verdict_id: `v${String(events.length + 1).padStart(4, '0')}`,
      ts: nowIso(),
      item_id: itemId,
      verdict,
      evidence: EVIDENCE_VERDICTS.has(verdict)
        ? {
          quote,
          section: text(evidence?.section) || null,
          location: text(evidence?.location),
          line_start: evidence?.line_start ?? null,
          line_end: evidence?.line_end ?? null,
          unit: text(evidence?.unit) || null,
        }
        : null,
      searched: verdict === 'not_reported' ? searchedTerms : [],
      reason: note || null,
      reviewer: text(reviewer) || null,
      override: Boolean(override),
      supersedes: latest?.verdict_id ?? null,
    }
    appendFileSync(verdictsPath(cwd, slug), `${JSON.stringify(event)}\n`)
    return event
  })
}

export function itemState(item, latest, { sourceChanged = false, source } = {}) {
  if (!latest) {
    return {
      item_id: item.id,
      section: item.section,
      short_prompt: item.short_prompt,
      source_url: item.source_url ?? null,
      verdict: 'unassessed',
      stale: false,
      evidence_mismatch: false,
      evidence: null,
      searched: [],
      reason: null,
      reviewer: null,
      judged_at: null,
    }
  }
  let matches = null
  if (latest.evidence && source?.quoteMatches) matches = source.quoteMatches(latest.evidence.quote)
  const evidenceMismatch = latest.evidence ? matches === false : false
  const stale = evidenceMismatch || (sourceChanged && !latest.evidence)
  return {
    item_id: item.id,
    section: item.section,
    short_prompt: item.short_prompt,
    source_url: item.source_url ?? null,
    verdict: latest.verdict,
    stale,
    evidence_mismatch: evidenceMismatch,
    evidence: latest.evidence,
    searched: latest.searched || [],
    reason: latest.reason,
    reviewer: latest.reviewer,
    judged_at: latest.ts,
    verdict_id: latest.verdict_id,
    override: Boolean(latest.override),
    supersedes: latest.supersedes,
    quote_matches: matches,
  }
}

export function deriveStatus({ cwd, slug, checklist, source }) {
  const check = readCheck(cwd, slug)
  const events = readVerdicts(cwd, slug)
  const latest = latestVerdicts(events)
  const currentSha256 = source?.sha256 ?? check.manuscript.sha256
  const sourceChanged = currentSha256 !== check.manuscript.sha256
  const counts = { reported: 0, partial: 0, not_reported: 0, not_applicable: 0, unassessed: 0 }
  const items = []
  let stale = 0
  let evidenceMismatch = 0
  let verifiedEvidence = 0
  for (const item of checklist.items) {
    const event = latest.get(item.id) || null
    const state = itemState(item, event, { sourceChanged, source })
    items.push(state)
    counts[state.verdict] += 1
    if (state.stale) stale += 1
    if (state.evidence_mismatch) evidenceMismatch += 1
    if (EVIDENCE_VERDICTS.has(state.verdict) && state.evidence && state.quote_matches !== false) verifiedEvidence += 1
  }
  const lastEventAt = events.map((event) => event.ts).filter(Boolean).sort().at(-1) || null
  return {
    slug: reportingSlug(slug),
    guideline: check.guideline,
    manuscript: {
      ...check.manuscript,
      current_sha256: currentSha256,
      source_changed: sourceChanged,
      ...(source ? { current_chars: source.text.length, current_lines: source.lineCount } : {}),
    },
    created_at: check.created_at,
    total: checklist.items.length,
    assessed: checklist.items.length - counts.unassessed,
    counts,
    verified_evidence: verifiedEvidence,
    stale,
    evidence_mismatch: evidenceMismatch,
    last_event_at: lastEventAt,
    items,
  }
}

function statusLabel(state) {
  const label = state.verdict === 'not_reported'
    ? 'not reported'
    : state.verdict.replace(/_/g, ' ')
  const flags = []
  if (state.stale) flags.push('stale')
  if (state.evidence_mismatch) flags.push('evidence not found')
  return flags.length ? `${label} (${flags.join(', ')})` : label
}

function evidenceCell(state) {
  if (state.evidence) {
    const where = state.evidence.location || [state.evidence.section, state.evidence.line_start ? `line ${state.evidence.line_start}` : null].filter(Boolean).join(', ')
    const unit = state.evidence.unit ? ` [${state.evidence.unit}]` : ''
    return `${shorten(state.evidence.quote)} — ${where}${unit}`
  }
  if (state.verdict === 'not_reported' && state.searched.length) {
    return `searched: ${state.searched.join(', ')}${state.reason ? ` — ${state.reason}` : ''}`
  }
  if (state.verdict === 'not_applicable') return state.reason || ''
  return ''
}

function shorten(value, limit = MAX_QUOTE_RENDER) {
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim()
  return raw.length > limit ? `${raw.slice(0, limit - 1)}…` : raw
}

function mdCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
}

function csvCell(value) {
  const raw = String(value ?? '')
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw
}

function latexEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
}

function evidenceLatex(state) {
  if (state.evidence) {
    const where = state.evidence.location || [state.evidence.section, state.evidence.line_start ? `line ${state.evidence.line_start}` : null].filter(Boolean).join(', ')
    const unit = state.evidence.unit ? ` [${state.evidence.unit}]` : ''
    return `${latexEscape(shorten(state.evidence.quote, 140))} --- ${latexEscape(where)}${latexEscape(unit)}`
  }
  if (state.verdict === 'not_reported' && state.searched.length) {
    return `searched: ${latexEscape(state.searched.join(', '))}${state.reason ? ` --- ${latexEscape(state.reason)}` : ''}`
  }
  if (state.verdict === 'not_applicable') return latexEscape(state.reason || '')
  return ''
}

export function markdownReport(check, status) {
  const lines = [
    `# Reporting check: ${check.manuscript.title || check.manuscript.path || check.manuscript.paper || check.slug}`,
    '',
    `**Guideline:** ${check.guideline.name} ([checklist](${check.guideline.source_url}))  `,
    `**Manuscript:** \`${check.manuscript.path || check.manuscript.paper || check.manuscript.title}\`  `,
    `**Snapshot:** \`${check.manuscript.sha256}\`${status.manuscript.source_changed ? ' (manuscript has changed since the snapshot)' : ''}  `,
    `**Items:** ${status.total}`,
    '',
    `**${status.verified_evidence} of ${status.total} items have verified evidence.** ${status.counts.unassessed} unassessed, ${status.stale} stale.`,
    '',
    'This export records what the manuscript reports against paraphrased checklist items. It is not a compliance verdict and does not establish that the manuscript meets the guideline.',
    '',
    '| Item | Checklist section | Status | Evidence |',
    '|---|---|---|---|',
  ]
  for (const state of status.items) {
    lines.push(`| ${mdCell(state.item_id)} | ${mdCell(state.section)} | ${mdCell(statusLabel(state))} | ${mdCell(evidenceCell(state))} |`)
  }
  lines.push('', '## Checklist prompts', '')
  for (const state of status.items) {
    lines.push(`- **${state.item_id}** (${state.section}): ${state.short_prompt}`)
  }
  lines.push('', '## Verdict definitions', '', '- **reported**: a verbatim quote shows the item is addressed.', '- **partial**: a verbatim quote shows the item is addressed only in part.', '- **not reported**: the listed terms or sections were checked and the item was not found; this is advisory and must be rechecked if the manuscript changes.', '- **not applicable**: the item does not apply, with a reason a reader can challenge.', '')
  return `${lines.join('\n')}`
}

export function csvReport(check, status) {
  const lines = ['item,checklist_section,status,evidence_quote,location,line_start,line_end,unit,searched,reason,reviewer,judged_at,stale,evidence_mismatch,source_url']
  for (const state of status.items) {
    lines.push([
      state.item_id,
      state.section,
      state.verdict,
      state.evidence?.quote || '',
      state.evidence?.location || '',
      state.evidence?.line_start ?? '',
      state.evidence?.line_end ?? '',
      state.evidence?.unit || '',
      (state.searched || []).join('; '),
      state.reason || '',
      state.reviewer || '',
      state.judged_at || '',
      state.stale ? 'true' : 'false',
      state.evidence_mismatch ? 'true' : 'false',
      state.source_url || '',
    ].map(csvCell).join(','))
  }
  return `${lines.join('\n')}\n`
}

export function latexReport(check, status) {
  const lines = [
    '% Reporting check export. Requires: \\usepackage{longtable}',
    `% Official checklist: ${check.guideline.source_url}`,
    '\\begin{small}',
    `\\textbf{Reporting check: ${latexEscape(check.guideline.name)}} \\\\`,
    `${status.verified_evidence} of ${status.total} items have verified evidence; ${status.counts.unassessed} unassessed; ${status.stale} stale.`,
    'This table records what the manuscript reports against paraphrased checklist items. It is not a compliance verdict.',
    '\\end{small}',
    '',
    '\\begin{longtable}{@{}p{0.07\\linewidth}p{0.17\\linewidth}p{0.13\\linewidth}p{0.58\\linewidth}@{}}',
    '\\hline',
    'Item & Checklist section & Status & Evidence \\\\',
    '\\hline',
    '\\endhead',
  ]
  for (const state of status.items) {
    lines.push(`${latexEscape(state.item_id)} & ${latexEscape(state.section)} & ${latexEscape(statusLabel(state))} & ${evidenceLatex(state)} \\\\`)
  }
  lines.push('\\hline', '\\end{longtable}', '')
  return lines.join('\n')
}

export function exportCheck({ cwd, slug, check, status, format = 'markdown', overwrite = false }) {
  const dir = ensureCheck(cwd, slug)
  mkdirSync(join(dir, 'exports'), { recursive: true })
  const kind = text(format).toLowerCase()
  let name
  let body
  if (kind === 'markdown' || kind === 'md') {
    name = 'check.md'
    body = markdownReport(check, status)
  } else if (kind === 'csv') {
    name = 'check.csv'
    body = csvReport(check, status)
  } else if (kind === 'latex' || kind === 'tex') {
    name = 'check.tex'
    body = latexReport(check, status)
  } else {
    throw new Error('format must be markdown, csv, or latex')
  }
  const out = join(dir, 'exports', name)
  if (existsSync(out) && !overwrite) {
    throw new Error(`${relative(resolve(cwd), out)} already exists; pass overwrite: true to replace it`)
  }
  writeFileSync(out, body)
  return {
    format: kind === 'md' ? 'markdown' : (kind === 'tex' ? 'latex' : kind),
    path: relative(resolve(cwd), out),
    bytes: Buffer.byteLength(body),
    summary: {
      total: status.total,
      verified_evidence: status.verified_evidence,
      unassessed: status.counts.unassessed,
      stale: status.stale,
    },
  }
}
