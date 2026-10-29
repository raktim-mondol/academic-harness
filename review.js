/**
 * review: action-multiplexed systematic/scoping-review ledger.
 *
 * All state lives under `<cwd>/.dsh/review/<slug>/` (review-store.js). This
 * tool adds argument parsing, workspace-path input, and rendering; the store
 * enforces stage order, reasons, and append-only semantics.
 */
import {
  existsSync, mkdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  addEvidence, addRecords, appraiseRecord, deriveAppraisalStatus, deriveStatus, exportReview,
  frozenInstrument, readJsonl, readProtocol, reconcileRecord, reviewDir, screenRecord,
  screeningResolutions, startReview, SCREENING_DECISIONS, SCREENING_STAGES,
} from './review-store.js'
import { reviewerKey, summarizeAgreement, WEIGHTINGS } from './agreement.js'
import { buildFigureRequest, evaluateInstrument, scaleValues } from './appraisal.js'
import { mcpText, paperMemoryCall } from './papermemory-mcp.js'
import { resolvePaperMemoryLaunch } from './papermemory-cli.js'
import { runHelper } from './python-runtime.js'
import { resolveWorkspacePath } from './workspace-path.js'

const ACTIONS = [
  'start', 'add', 'screen', 'evidence', 'status',
  'appraise', 'reconcile', 'agreement', 'appraisal_status', 'export',
]
const SCORING_SCOPES = ['screening', 'appraisal']
const MAX_INPUT_BYTES = 50 * 1024 * 1024
const MAX_SVG_BYTES = 8 * 1024 * 1024

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function readRecordsFile(cwd, path) {
  const target = resolveWorkspacePath(cwd, path)
  if (!existsSync(target)) throw new Error(`file not found: ${path}`)
  if (statSync(target).size > MAX_INPUT_BYTES) throw new Error(`records file is larger than ${MAX_INPUT_BYTES / (1024 * 1024)}MB: ${path}`)
  const body = readFileSync(target, 'utf8')
  try {
    const parsed = JSON.parse(body)
    if (Array.isArray(parsed)) return parsed
    if (Array.isArray(parsed?.results)) return parsed.results
    if (Array.isArray(parsed?.records)) return parsed.records
    throw new Error('JSON records file must be an array or an object with results/records')
  } catch (error) {
    if (error instanceof SyntaxError) {
      const rows = body.split('\n').map((line) => line.trim()).filter(Boolean).map((line, index) => {
        try {
          return JSON.parse(line)
        } catch {
          throw new Error(`${path} line ${index + 1} is not valid JSON`)
        }
      })
      if (rows.length) return rows
    }
    throw error instanceof Error ? error : new Error(String(error))
  }
}

function requireString(value, name) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`${name} is required`)
  return text
}

function displayPath(cwd, absolute) {
  return relative(resolve(cwd), absolute)
}

async function verifyPaperMemoryQuote(paper, quote) {
  const launch = resolvePaperMemoryLaunch()
  if (!launch) throw new Error('PaperMemory is not installed')
  const result = await paperMemoryCall(launch, 'papermemory_quote_check', { quote, paper }, {
    clientName: 'academic-harness-review',
  })
  if (result?.isError) {
    const detail = mcpText(result)
    throw new Error(`PaperMemory: ${detail.error || detail.code || 'quote check failed'}`)
  }
  return mcpText(result)
}

function filterRaters(ratings, raters) {
  if (!Array.isArray(raters) || !raters.length) return ratings
  const keys = new Set(raters.map(reviewerKey))
  return ratings.filter((rating) => keys.has(reviewerKey(rating.reviewer)))
}

function screeningAgreement({ cwd, slug, args }) {
  const { events, reviewerKeyed } = screeningResolutions(cwd, slug)
  const stages = args.stage ? [args.stage] : SCREENING_STAGES
  const analyses = stages.map((stage) => {
    const latest = new Map()
    for (const event of events) {
      if (event.kind === 'reconcile' || event.stage !== stage) continue
      const key = reviewerKeyed
        ? `${event.record_id}:${reviewerKey(event.reviewer)}`
        : event.record_id
      latest.set(key, event)
    }
    const ratings = filterRaters(
      [...latest.values()].map((event) => ({
        unit: event.record_id,
        reviewer: reviewerKeyed ? event.reviewer : 'default',
        value: event.decision,
      })),
      args.raters,
    )
    return {
      target: stage,
      label: stage === 'title_abstract' ? 'Title/abstract' : 'Full text',
      ...summarizeAgreement({ ratings, categories: SCREENING_DECISIONS, weighting: 'none' }),
    }
  })
  return { scope: 'screening', analyses }
}

function appraisalAgreement({ cwd, slug, args }) {
  const template = frozenInstrument(cwd, slug, args.instrument, args.version)
  const events = readJsonl(cwd, slug, 'appraisal').filter((event) => event.instrument?.id === template.id
    && String(event.instrument?.version) === String(template.version))
  const multiAxis = new Set(
    template.domains.filter((domain) => (domain.axes || []).length > 1).map((domain) => domain.id),
  )
  const weighting = args.weighting || (template.scale.type === 'stars' ? 'linear' : 'quadratic')
  const analyses = []

  for (const domain of template.domains) {
    for (const axis of domain.axes || ['risk_of_bias']) {
      const latest = new Map()
      for (const event of events) {
        if (event.kind === 'reconcile' || event.domain !== domain.id) continue
        if ((event.axis || 'risk_of_bias') !== axis) continue
        latest.set(`${event.record_id}:${reviewerKey(event.reviewer)}`, event)
      }
      if (!latest.size) continue
      const categories = scaleValues(template, domain).map((value) => value.id)
      const ratings = filterRaters(
        [...latest.values()].map((event) => ({ unit: event.record_id, reviewer: event.reviewer, value: event.judgement })),
        args.raters,
      )
      analyses.push({
        target: `${domain.id}:${axis}`,
        label: multiAxis.has(domain.id) ? `${domain.name} (${axis.replace(/_/g, ' ')})` : domain.name,
        axis,
        ...summarizeAgreement({ ratings, categories, weighting }),
      })
    }
  }

  if (template.overall) {
    const latest = new Map()
    for (const event of events) {
      if (event.kind === 'reconcile' || event.domain !== 'overall') continue
      latest.set(`${event.record_id}:${reviewerKey(event.reviewer)}`, event)
    }
    if (latest.size) {
      const categories = template.scale.values.map((value) => value.id)
      const ratings = filterRaters(
        [...latest.values()].map((event) => ({ unit: event.record_id, reviewer: event.reviewer, value: event.judgement })),
        args.raters,
      )
      analyses.push({
        target: 'overall',
        label: template.overall.name,
        ...summarizeAgreement({ ratings, categories, weighting }),
      })
    }
  }

  return {
    scope: 'appraisal',
    instrument: { id: template.id, version: template.version, name: template.name },
    analyses,
  }
}

async function writeRobFigure({ cwd, slug, args, deps }) {
  const template = frozenInstrument(cwd, slug, args.instrument, args.version)
  const protocol = readProtocol(cwd, slug)
  const { records, resolutions } = screeningResolutions(cwd, slug)
  const includedIds = records.map((record) => record.id)
    .filter((recordId) => resolutions.get(recordId)?.full?.value === 'include')
  const evaluation = evaluateInstrument({
    template,
    records,
    events: readJsonl(cwd, slug, 'appraisal'),
    includedIds,
    expectedReviewers: Array.isArray(protocol.reviewers) ? protocol.reviewers : [],
  })
  const request = buildFigureRequest(evaluation, template)
  const helper = deps.runHelper || runHelper
  const result = helper('rob_figure.py', request)
  if (result?.code === 'matplotlib_missing') {
    throw new Error(`rob-figure needs matplotlib: ${result.error || 'matplotlib is not installed'}. Run "cd python-helpers && uv sync" or set ACADEMIC_HARNESS_PYTHON to an interpreter with matplotlib.`)
  }
  if (result?.error) throw new Error(`rob-figure helper failed: ${result.error}`)
  const traffic = result?.svg?.traffic
  const summary = result?.svg?.summary
  if (typeof traffic !== 'string' || typeof summary !== 'string') {
    throw new Error('rob-figure helper returned no SVG')
  }
  for (const [name, svg] of [['traffic', traffic], ['summary', summary]]) {
    if (!svg.includes('<svg')) throw new Error(`rob-figure ${name} output is not an SVG`)
    if (Buffer.byteLength(svg) > MAX_SVG_BYTES) throw new Error(`rob-figure ${name} SVG is larger than 8MB`)
  }
  const dir = join(reviewDir(cwd, slug), 'exports')
  mkdirSync(dir, { recursive: true })
  const files = [
    { name: 'rob-traffic-light.svg', body: traffic },
    { name: 'rob-summary.svg', body: summary },
  ]
  for (const file of files) {
    const out = join(dir, file.name)
    if (existsSync(out) && !args.overwrite) {
      throw new Error(`${displayPath(cwd, out)} already exists; pass overwrite: true to replace it`)
    }
  }
  for (const file of files) writeFileSync(join(dir, file.name), file.body)
  return {
    action: 'export',
    format: 'rob-figure',
    files: files.map((file) => ({
      path: displayPath(cwd, join(dir, file.name)),
      bytes: Buffer.byteLength(file.body),
    })),
    studies: result.studies ?? evaluation.records.length,
    domains: result.domains ?? request.domains.length,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
  }
}

function renderStatus(status) {
  const ta = status.screening.title_abstract
  const ft = status.screening.full_text
  const multi = Boolean(status.multi_reviewer)
  const header = multi
    ? '| Stage | Include | Exclude | Maybe | Conflict | Pending |'
    : '| Stage | Include | Exclude | Maybe | Pending |'
  const divider = multi ? '|---|---:|---:|---:|---:|---:|' : '|---|---:|---:|---:|---:|'
  const stageRow = (label, counts) => (multi
    ? `| ${label} | ${counts.include} | ${counts.exclude} | ${counts.maybe} | ${counts.conflict ?? 0} | ${counts.pending} |`
    : `| ${label} | ${counts.include} | ${counts.exclude} | ${counts.maybe} | ${counts.pending} |`)
  const lines = [
    `Review "${status.slug}" — ${status.question}`,
    '',
    `Records: ${status.records_total} · search queries: ${status.search.queries} · added: ${status.search.added} · duplicates skipped: ${status.search.skipped}`,
    '',
    header,
    divider,
    stageRow('Title/abstract', ta),
    stageRow('Full text', ft),
  ]
  if (ft.not_eligible) lines.push(`\nFull text not yet eligible (no title/abstract include): ${ft.not_eligible}`)
  if (status.included.length) lines.push(`\nIncluded: ${status.included.join(', ')}`)
  if (status.evidence.included_without_evidence.length) {
    lines.push(`Included without evidence: ${status.evidence.included_without_evidence.join(', ')}`)
  }
  if (status.exclusion_reasons.length) {
    lines.push('', 'Exclusion reasons:')
    for (const row of status.exclusion_reasons) lines.push(`- ${row.stage}: ${row.reason} (${row.count})`)
  }
  if (multi) {
    lines.push('', 'Reviewers:')
    for (const reviewer of status.reviewers) {
      const title = reviewer.title_abstract
      const full = reviewer.full_text
      lines.push(`- ${reviewer.reviewer} (${reviewer.type}): title/abstract ${title.include} include, ${title.exclude} exclude, ${title.maybe} maybe, ${title.pending} pending; full text ${full.include} include, ${full.exclude} exclude, ${full.maybe} maybe, ${full.pending} pending; ${reviewer.appraisals} appraisal(s)`)
    }
    if (status.conflicts.length) {
      lines.push('', 'Conflicts:')
      for (const conflict of status.conflicts) {
        const values = conflict.by_reviewer.map((entry) => `${entry.reviewer}=${entry.value}`).join(', ')
        lines.push(`- ${conflict.record_id} ${conflict.stage}: ${conflict.state} (${values})`)
      }
    }
  }
  if (!status.exclusion_reasons.length && !status.included.length) lines.push('\nNo screening decisions yet.')
  return lines.join('\n')
}

function renderAppraise(value) {
  const event = value.event
  const quote = event.quote_check
    ? ` · quote ${event.quote_check.status}${event.quote_check.detail ? ` (${event.quote_check.detail})` : ''}`
    : ''
  const overall = value.overall
    ? `\nCurrent overall: ${value.overall.value ?? value.overall.state}${value.overall.derived ? ' (derived, not stored)' : ' (explicit)'}.`
    : ''
  return [{
    type: 'text',
    text: `${event.record_id} · ${event.instrument.id}@${event.instrument.version} · ${event.domain} · ${event.judgement} · ${event.reviewer}${quote}${event.override ? ' (override; previous event kept)' : ''}${overall}`,
  }]
}

const fmt = (value) => (Number.isFinite(value) ? value.toFixed(3) : 'n/a')

function pairLine(pair) {
  const ci = pair.ci ? `, 95% CI ${fmt(pair.ci[0])}–${fmt(pair.ci[1])}` : ''
  const dropped = pair.dropped_units ? `, dropped ${pair.dropped_units}` : ''
  const kappa = pair.kappa == null
    ? `κ undefined (${pair.undefined_reason})`
    : `κ ${fmt(pair.kappa)}${pair.weighting === 'none' ? '' : ` (${pair.weighting} weighted)`}`
  return `${pair.raters.join(' vs ')}: Po ${fmt(pair.percent_agreement)}, ${kappa}${ci}, N=${pair.n}${dropped}`
}

function renderAgreement(value) {
  const lines = [
    `Agreement — ${value.scope}${value.instrument ? ` · ${value.instrument.id}@${value.instrument.version}` : ''}`,
    '',
  ]
  for (const analysis of value.analyses) {
    lines.push(`${analysis.label} (${analysis.categories.length} categories)`)
    if (!analysis.human.pairs.length) lines.push('- no human pair')
    for (const pair of analysis.human.pairs) lines.push(`- ${pairLine(pair)}`)
    for (const pair of analysis.ai_vs_human.pairs) lines.push(`- AI vs human — ${pairLine(pair)}`)
    for (const pair of analysis.ai_vs_ai.pairs) lines.push(`- AI vs AI — ${pairLine(pair)}`)
    if (analysis.dropped.invalid || analysis.dropped.incomplete_units) {
      lines.push(`- dropped ${analysis.dropped.invalid} invalid rating(s); ${analysis.dropped.incomplete_units} unit(s) missing a rating`)
    }
    for (const caveat of analysis.caveats) lines.push(`- caveat: ${caveat.code} — ${caveat.detail}`)
    lines.push('')
  }
  lines.push('Agreement statistics only; they are not a quality verdict.')
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderAppraisalStatus(value) {
  const status = value.status
  const lines = [`Appraisal status — ${status.population} included record(s)`, '']
  for (const instrument of status.instruments) {
    lines.push(`${instrument.name} ${instrument.version}: ${instrument.complete_records}/${instrument.population} complete; reviewers: ${instrument.reviewers.join(', ') || '(none)'}`)
    for (const conflict of instrument.outstanding.conflicts) {
      lines.push(`- conflict ${conflict.record_id} ${conflict.cell}: ${conflict.state}`)
    }
    const missing = instrument.outstanding.missing
    if (missing.length) {
      const shown = missing.slice(0, 10).map((row) => `${row.record_id} ${row.cell}${row.missing_reviewers?.length ? ` (missing ${row.missing_reviewers.join(', ')})` : ''}`)
      lines.push(`- missing: ${shown.join('; ')}${missing.length > 10 ? `; +${missing.length - 10} more` : ''}`)
    }
    lines.push('')
  }
  if (status.appraisals_outside_population.length) {
    lines.push(`Appraisals outside the included population: ${status.appraisals_outside_population.join(', ')}`)
  }
  if (status.note) lines.push(status.note)
  lines.push('This tool reports completeness and disagreements, not a risk-of-bias verdict.')
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderReview(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (value.action === 'status') return [{ type: 'text', text: renderStatus(value.status) }]
  if (value.action === 'start') {
    const head = value.resumed
      ? `Review "${value.slug}" resumed (${value.protocol.question}).`
      : `Review "${value.slug}" started at ${value.dir}.`
    const protocol = value.protocol
    const details = [
      protocol.reviewers?.length ? `Reviewers: ${protocol.reviewers.join(', ')}` : null,
      protocol.instruments?.length
        ? `Instruments: ${protocol.instruments.map((entry) => `${entry.id}@${entry.version}`).join(', ')}`
        : null,
      protocol.databases?.length ? `Databases: ${protocol.databases.join(', ')}` : null,
      protocol.inclusion?.length ? `Inclusion: ${protocol.inclusion.join('; ')}` : null,
      protocol.exclusion?.length ? `Exclusion: ${protocol.exclusion.join('; ')}` : null,
      protocol.date_range ? `Date range: ${protocol.date_range}` : null,
    ].filter(Boolean)
    return [{ type: 'text', text: [head, ...details].join('\n') }]
  }
  if (value.action === 'add') {
    const dupes = value.skipped ? `; ${value.skipped} duplicate(s) skipped` : ''
    const ids = value.ids?.length ? `\nAdded: ${value.ids.join(', ')}` : ''
    return [{ type: 'text', text: `Added ${value.added} record(s)${dupes}. Total: ${value.total}.${ids}` }]
  }
  if (value.action === 'screen') {
    return [{
      type: 'text',
      text: `${value.record_id} · ${value.stage} · ${value.decision}${value.reason ? ` — ${value.reason}` : ''}${value.override ? ' (override; previous event kept)' : ''}`,
    }]
  }
  if (value.action === 'evidence') {
    return [{
      type: 'text',
      text: `Evidence ${value.evidence_id} stored for ${value.record_id} (${value.location}). Quote must still be verified against the paper — use PaperMemory quote_check when the paper is ingested.`,
    }]
  }
  if (value.action === 'appraise') return renderAppraise(value)
  if (value.action === 'reconcile') {
    const event = value.event
    const target = value.scope === 'screening'
      ? `${event.record_id} · ${event.stage}`
      : `${event.record_id} · ${event.instrument.id}@${event.instrument.version} · ${event.domain}`
    const state = value.resolution?.state ?? 'recorded'
    const resolved = value.resolution?.value ?? event.judgement
    return [{
      type: 'text',
      text: `Reconciled ${target} → ${resolved} (${state}) · ${event.basis}; ${event.supersedes.length} event(s) superseded, originals kept.`,
    }]
  }
  if (value.action === 'agreement') return renderAgreement(value)
  if (value.action === 'appraisal_status') return renderAppraisalStatus(value)
  if (value.files) {
    const lines = value.files.map((file) => `Wrote ${file.path} (${file.bytes} bytes).`)
    if (value.warnings?.length) lines.push(`Warnings: ${value.warnings.join('; ')}`)
    return [{ type: 'text', text: lines.join('\n') }]
  }
  return [{ type: 'text', text: `Wrote ${value.path} (${value.bytes} bytes).` }]
}

export async function runReview(args, exec, deps = {}) {
  const action = args.action || 'status'
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  const slug = requireString(args.slug, 'slug')
  const cwd = workspaceRoot(exec)

  if (action === 'start') {
    const started = await startReview({
      cwd,
      slug,
      resume: Boolean(args.resume),
      reviewers: args.reviewers,
      instruments: args.instruments,
      protocol: {
        question: args.question,
        databases: args.databases,
        inclusion: args.inclusion,
        exclusion: args.exclusion,
        date_range: args.date_range,
        notes: args.notes,
      },
    })
    return {
      action,
      ...started,
      dir: displayPath(cwd, started.dir),
      records_total: started.resumed ? deriveStatus(cwd, slug).records_total : 0,
    }
  }

  if (action === 'add') {
    let records = Array.isArray(args.records) ? args.records : []
    if (!records.length && typeof args.path === 'string' && args.path.trim()) {
      records = readRecordsFile(cwd, args.path.trim())
    }
    if (!records.length) throw new Error('give records or a path to a JSON/JSONL file')
    return { action, ...await addRecords({ cwd, slug, records, source: args.source, query: args.query }) }
  }

  if (action === 'screen') {
    const event = await screenRecord({
      cwd,
      slug,
      id: requireString(args.id, 'id'),
      stage: args.stage,
      decision: args.decision,
      reason: args.reason,
      reviewer: args.reviewer,
      override: Boolean(args.override),
    })
    return { action, ...event }
  }

  if (action === 'evidence') {
    const event = await addEvidence({
      cwd,
      slug,
      id: requireString(args.id, 'id'),
      claim: args.claim,
      quote: args.quote,
      location: requireString(args.location, 'location'),
      page: args.page,
      section: args.section,
    })
    return { action, ...event }
  }

  if (action === 'appraise') {
    const recordId = requireString(args.id, 'id')
    const instrument = requireString(args.instrument, 'instrument')
    const domain = requireString(args.domain, 'domain')
    const judgement = requireString(args.judgement, 'judgement')
    const reviewer = requireString(args.reviewer, 'reviewer')
    const quote = String(args.quote ?? '').trim()
    let quoteCheck = null
    if (quote && args.paper) {
      const verify = deps.verifyQuote || verifyPaperMemoryQuote
      let result
      try {
        result = await verify(args.paper, quote)
      } catch (error) {
        quoteCheck = {
          status: 'unverified',
          via: 'papermemory_quote_check',
          detail: `quote check failed: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      if (!quoteCheck) {
        if (result?.found === true) {
          const occurrences = Array.isArray(result.occurrences) ? result.occurrences : []
          const bibliographyOnly = result.reason === 'bibliography-only'
            || (occurrences.length > 0 && occurrences.every((entry) => Number(entry.is_bibliography) === 1))
          if (bibliographyOnly) {
            return {
              error: `the evidence quote only occurs in the bibliography of PaperMemory paper "${args.paper}". Quote the study text, not a reference-list entry.`,
            }
          }
          if (!occurrences.length || result.checked_against?.sha256 == null) {
            quoteCheck = {
              status: 'unverified',
              via: 'papermemory_quote_check',
              detail: 'PaperMemory returned found:true without a resolved occurrence',
            }
          } else if (result.reason) {
            quoteCheck = {
              status: 'unverified',
              via: 'papermemory_quote_check',
              detail: `PaperMemory: ${result.reason}`,
              checked_against: result.checked_against,
            }
          } else {
            quoteCheck = {
              status: 'verified',
              via: 'papermemory_quote_check',
              detail: 'found',
              checked_against: result.checked_against,
            }
          }
        } else if (result?.found === false && result.checked_against?.sha256 != null) {
          const reason = result.reason ? ` (${result.reason})` : ''
          return {
            error: `the evidence quote was not found in PaperMemory paper "${args.paper}"${reason}. A quote that does not appear is rejected and not stored.`,
          }
        } else if (result?.found === false) {
          quoteCheck = {
            status: 'unverified',
            via: 'papermemory_quote_check',
            detail: `PaperMemory could not resolve paper "${args.paper}" (${result.reason || 'no-match'})`,
          }
        } else {
          quoteCheck = {
            status: 'unverified',
            via: 'papermemory_quote_check',
            detail: 'PaperMemory returned an unexpected result',
          }
        }
      }
    }
    const event = await appraiseRecord({
      cwd,
      slug,
      id: recordId,
      instrument,
      version: args.version,
      domain,
      axis: args.axis,
      judgement,
      signalling: args.signalling,
      quote,
      location: args.location,
      page: args.page,
      section: args.section,
      reason: args.reason,
      reviewer,
      override: Boolean(args.override),
      paper: args.paper,
      quoteCheck,
    })
    const status = deriveAppraisalStatus(cwd, slug, { id: recordId, instrument })
    const row = status.instruments[0]?.records.find((entry) => entry.record_id === recordId)
    return { action, event, overall: row?.overall ?? null }
  }

  if (action === 'reconcile') {
    const scope = requireString(args.scope, 'scope')
    if (!SCORING_SCOPES.includes(scope)) throw new Error(`scope must be one of ${SCORING_SCOPES.join(', ')}`)
    const result = await reconcileRecord({
      cwd,
      slug,
      scope,
      id: requireString(args.id, 'id'),
      stage: args.stage,
      decision: args.decision,
      instrument: args.instrument,
      version: args.version,
      domain: args.domain,
      axis: args.axis,
      judgement: args.judgement,
      reason: args.reason,
      reviewer: requireString(args.reviewer, 'reviewer'),
    })
    return { action, ...result }
  }

  if (action === 'agreement') {
    const scope = args.scope || 'screening'
    if (!SCORING_SCOPES.includes(scope)) throw new Error(`scope must be one of ${SCORING_SCOPES.join(', ')}`)
    if (scope === 'screening') {
      if (args.weighting && args.weighting !== 'none') {
        throw new Error('weighting applies to ordinal appraisal scales; screening agreement is unweighted')
      }
      readProtocol(cwd, slug)
      return { action, ...screeningAgreement({ cwd, slug, args }) }
    }
    return { action, ...appraisalAgreement({ cwd, slug, args }) }
  }

  if (action === 'appraisal_status') {
    readProtocol(cwd, slug)
    return {
      action,
      status: deriveAppraisalStatus(cwd, slug, {
        id: args.id, instrument: args.instrument, version: args.version,
      }),
    }
  }

  if (action === 'status') {
    readProtocol(cwd, slug)
    return { action, status: deriveStatus(cwd, slug) }
  }

  if (action === 'export') {
    const format = args.format || 'markdown'
    if (format === 'rob-figure') return writeRobFigure({ cwd, slug, args, deps })
    const exported = exportReview({
      cwd,
      slug,
      format,
      overwrite: Boolean(args.overwrite),
      table_format: args.table_format,
      instrument: args.instrument,
      version: args.version,
    })
    return { action, ...exported, format }
  }

  throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
}

export const name = 'academic-harness-review'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'review',
    description: [
      'Maintain a systematic/scoping-review ledger (protocol, records, screening, evidence, appraisals, PRISMA-style counts) under `.dsh/review/<slug>/.',
      'Actions: `start` (protocol; optional reviewers and risk-of-bias instruments; refuses to overwrite unless resume: true), `add` (records from a search tool or a workspace JSON/JSONL file; dedupes by DOI, arXiv/PMID, then normalized title+year), `screen` (title_abstract or full_text; include/exclude/maybe; a reason is required to exclude or mark maybe), `evidence` (only after a resolved full_text include), `appraise` (record a domain-level risk-of-bias judgement by a named reviewer, with a quote for low/high), `reconcile` (record a consensus or third-reviewer decision over a disagreement; originals kept), `agreement` (percent agreement and Cohen/weighted kappa; human-vs-human primary, AI reported separately), `appraisal_status` (completeness and outstanding disagreements), `status` (screening counts and conflicts), `export` (markdown, csv, json, rob-table, rob-summary, rob-figure).',
      'This tool never makes an inclusion, appraisal, or consensus decision — every value and reason comes from a named reviewer. Reviewer identities are human:<name> or ai:<model>; a legacy event with no reviewer is `default`. The quote in `evidence` and `appraise` is stored verbatim; with a PaperMemory `paper`, a quote is checked through papermemory_quote_check and a quote that does not appear is rejected. Exports report recorded judgements and verified evidence, never a compliance or quality verdict. Load the systematic-review-ledger and risk-of-bias-appraisal skills for the workflows.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'start, add, screen, evidence, appraise, reconcile, agreement, appraisal_status, status, or export. Default status.',
      },
      slug: { type: 'string', description: 'Review slug (stable short name; letters, digits, dashes).' },
      question: { type: 'string', description: 'Review question (start). Required for a new review.' },
      databases: {
        type: 'array',
        items: { type: 'string' },
        description: 'Databases searched (start), e.g. ["OpenAlex", "PubMed"].',
      },
      inclusion: { type: 'array', items: { type: 'string' }, description: 'Inclusion criteria (start).' },
      exclusion: { type: 'array', items: { type: 'string' }, description: 'Exclusion criteria (start).' },
      date_range: { type: 'string', description: 'Date range covered, e.g. "2015-2026" (start).' },
      notes: { type: 'string', description: 'Protocol notes (start).' },
      reviewers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Declared reviewer roster (start), e.g. ["human:alice", "human:bob"] or ["ai:model"]. With two or more, screening state is per reviewer and conflicts are reported.',
      },
      instruments: {
        type: 'array',
        items: { type: 'string' },
        description: 'Risk-of-bias instruments to freeze for the review (start), e.g. ["rob-2"] or ["robins-i@1"]. Instruments can also be frozen on first appraise.',
      },
      resume: { type: 'boolean', description: 'Continue an existing review instead of failing (start).' },
      records: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'Search results to record (add): normalized papers or CSL-JSON-like objects with title, doi, authors, year, venue.',
      },
      path: { type: 'string', description: 'Workspace-relative JSON/JSONL file of records (add). Used when records is absent.' },
      source: { type: 'string', description: 'Source of the records, e.g. openalex or literature_search (add).' },
      query: { type: 'string', description: 'The query that produced these records (add).' },
      id: { type: 'string', description: 'Record id such as r0001 (screen/evidence/appraise/reconcile/appraisal_status).' },
      stage: {
        type: 'string',
        enum: SCREENING_STAGES,
        description: 'title_abstract or full_text (screen/reconcile/agreement). full_text requires a title_abstract include.',
      },
      decision: {
        type: 'string',
        enum: SCREENING_DECISIONS,
        description: 'include, exclude, or maybe (screen/reconcile screening).',
      },
      reason: { type: 'string', description: 'Why the record was excluded/marked maybe (screen); required for exclude/maybe, overrides, reconcile, and an explicit overall judgement.' },
      reviewer: { type: 'string', description: 'Reviewer identity, e.g. human:alice or ai:model (screen/appraise/reconcile).' },
      override: { type: 'boolean', description: 'Replace this reviewer’s earlier decision at the same key; both events are kept (screen/appraise). A reason is required in a multi-reviewer screening review and for every appraisal override.' },
      claim: { type: 'string', description: 'What the record supports (evidence).' },
      quote: { type: 'string', description: 'Verbatim supporting quote (evidence/appraise). Checked through PaperMemory when paper is supplied.' },
      location: { type: 'string', description: 'Where the quote is, e.g. "Results, p. 4" (evidence/appraise).' },
      page: { type: 'string', description: 'Page number (evidence/appraise).' },
      section: { type: 'string', description: 'Section name (evidence/appraise).' },
      instrument: { type: 'string', description: 'Risk-of-bias instrument id, e.g. rob-2, robins-i, quadas-2, nos (appraise/reconcile/agreement/appraisal_status/export).' },
      version: { type: 'string', description: 'Instrument version, e.g. 2019 (optional).' },
      domain: { type: 'string', description: 'Domain id from the instrument, or "overall" for an explicit overall override (appraise/reconcile/agreement).' },
      axis: {
        type: 'string',
        enum: ['risk_of_bias', 'applicability'],
        description: 'Domain axis (QUADAS-2 uses applicability on three domains). Default risk_of_bias.',
      },
      judgement: { type: 'string', description: 'Instrument judgement, e.g. low, some_concerns, high, moderate, serious, critical, no_information, unclear, or a star count (appraise/reconcile).' },
      signalling: {
        type: 'object',
        additionalProperties: true,
        description: 'Signalling-question answers keyed by question id (appraise). Supporting detail only; never converted into a judgement.',
      },
      paper: { type: 'string', description: 'PaperMemory paper key used to verify the quote (appraise).' },
      scope: {
        type: 'string',
        enum: SCORING_SCOPES,
        description: 'screening or appraisal (reconcile/agreement).',
      },
      weighting: {
        type: 'string',
        enum: WEIGHTINGS,
        description: 'Kappa weighting (agreement on appraisal): none, linear, or quadratic. Default quadratic for ordinal scales and linear for star counts.',
      },
      raters: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restrict agreement to these reviewer identities (optional).',
      },
      table_format: {
        type: 'string',
        enum: ['markdown', 'csv'],
        description: 'File format for rob-table and rob-summary (export). Default markdown.',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'csv', 'json', 'rob-table', 'rob-summary', 'rob-figure'],
        description: 'Export format. markdown = report skeleton + PRISMA counts; csv = evidence table; json = full ledger; rob-table/rob-summary = appraisal tables; rob-figure = traffic-light and summary SVGs. Default markdown.',
      },
      overwrite: { type: 'boolean', description: 'Replace existing export files (export). Default false.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderReview(value),
    },
    async execute(args, exec) {
      try {
        return await runReview(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      const verb = args.action || 'status'
      return { card: 'generic', title: `Review: ${args.slug || ''} (${verb})`, kind: 'other' }
    },
  }))
}
