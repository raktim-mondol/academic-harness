/**
 * review: action-multiplexed systematic/scoping-review ledger.
 *
 * All state lives under `<cwd>/.dsh/review/<slug>/` (review-store.js). This
 * tool adds argument parsing, workspace-path input, and rendering; the store
 * enforces stage order, reasons, and append-only semantics.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  addEvidence, addRecords, deriveStatus, exportReview, readProtocol,
  screenRecord, startReview, SCREENING_DECISIONS, SCREENING_STAGES,
} from './review-store.js'

const ACTIONS = ['start', 'add', 'screen', 'evidence', 'status', 'export']
const MAX_INPUT_BYTES = 50 * 1024 * 1024

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function readRecordsFile(cwd, path) {
  const root = resolve(cwd)
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes the workspace: ${path}`)
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

function renderStatus(status) {
  const ta = status.screening.title_abstract
  const ft = status.screening.full_text
  const lines = [
    `Review "${status.slug}" — ${status.question}`,
    '',
    `Records: ${status.records_total} · search queries: ${status.search.queries} · added: ${status.search.added} · duplicates skipped: ${status.search.skipped}`,
    '',
    '| Stage | Include | Exclude | Maybe | Pending |',
    '|---|---:|---:|---:|---:|',
    `| Title/abstract | ${ta.include} | ${ta.exclude} | ${ta.maybe} | ${ta.pending} |`,
    `| Full text | ${ft.include} | ${ft.exclude} | ${ft.maybe} | ${ft.pending} |`,
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
  if (!status.exclusion_reasons.length && !status.included.length) lines.push('\nNo screening decisions yet.')
  return lines.join('\n')
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
  return [{ type: 'text', text: `Wrote ${value.path} (${value.bytes} bytes).` }]
}

export async function runReview(args, exec) {
  const action = args.action || 'status'
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  const slug = requireString(args.slug, 'slug')
  const cwd = workspaceRoot(exec)

  if (action === 'start') {
    const started = await startReview({
      cwd,
      slug,
      resume: Boolean(args.resume),
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

  if (action === 'status') {
    readProtocol(cwd, slug)
    return { action, status: deriveStatus(cwd, slug) }
  }

  const exported = exportReview({
    cwd, slug, format: args.format || 'markdown', overwrite: Boolean(args.overwrite),
  })
  return { action, ...exported, format: args.format || 'markdown' }
}

export const name = 'academic-harness-review'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'review',
    description: [
      'Maintain a systematic/scoping-review ledger (protocol, records, screening, evidence, PRISMA-style counts) under `.dsh/review/<slug>/`.',
      'Actions: `start` (protocol; refuses to overwrite unless resume: true), `add` (records from a search tool or a workspace JSON/JSONL file; dedupes by DOI, arXiv/PMID, then normalized title+year), `screen` (title_abstract or full_text; include/exclude/maybe; a reason is required to exclude or mark maybe), `evidence` (only after a full_text include), `status` (counts, exclusion reasons, includes missing evidence), `export` (markdown, csv, json).',
      'This tool never makes an inclusion decision — every decision and reason comes from the user or agent. Discovery stays in literature_search et al.; this only records the funnel. The quote in `evidence` is stored verbatim, not verified: PaperMemory quote_check/trace remains the verifier. Load the systematic-review-ledger skill for the full workflow.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'start, add, screen, evidence, status, or export. Default status.',
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
      resume: { type: 'boolean', description: 'Continue an existing review instead of failing (start).' },
      records: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'Search results to record (add): normalized papers or CSL-JSON-like objects with title, doi, authors, year, venue.',
      },
      path: { type: 'string', description: 'Workspace-relative JSON/JSONL file of records (add). Used when records is absent.' },
      source: { type: 'string', description: 'Source of the records, e.g. openalex or literature_search (add).' },
      query: { type: 'string', description: 'The query that produced these records (add).' },
      id: { type: 'string', description: 'Record id such as r0001 (screen/evidence).' },
      stage: {
        type: 'string',
        enum: SCREENING_STAGES,
        description: 'title_abstract or full_text (screen). full_text requires a prior title_abstract include.',
      },
      decision: {
        type: 'string',
        enum: SCREENING_DECISIONS,
        description: 'include, exclude, or maybe (screen).',
      },
      reason: { type: 'string', description: 'Why the record was excluded/marked maybe (screen). Required for exclude/maybe.' },
      reviewer: { type: 'string', description: 'Reviewer name or agent id (screen).' },
      override: { type: 'boolean', description: 'Replace an earlier decision at the same stage; both events are kept (screen).' },
      claim: { type: 'string', description: 'What the record supports (evidence).' },
      quote: { type: 'string', description: 'Verbatim supporting quote (evidence).' },
      location: { type: 'string', description: 'Where the quote is, e.g. "Results, p. 4" (evidence).' },
      page: { type: 'string', description: 'Page number (evidence).' },
      section: { type: 'string', description: 'Section name (evidence).' },
      format: {
        type: 'string',
        enum: ['markdown', 'csv', 'json'],
        description: 'Export format. markdown = report skeleton + PRISMA counts; csv = evidence table; json = full ledger. Default markdown.',
      },
      overwrite: { type: 'boolean', description: 'Replace an existing export file (export). Default false.' },
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
