/**
 * provenance_audit: the read-only cross-ledger audit (Phase 3 of
 * docs/SCIENTIFIC-EXPANSION-PLAN.md).
 *
 * It answers the question no single ledger can: which manuscript claims, review
 * inclusions, extractions, appraisals, or hypotheses have no verified support,
 * and exactly where the supported ones came from. It creates no new source of
 * truth — it joins the ledgers that already exist by the ids and hashes they
 * already store, and writes only its own cache under `.dsh/provenance/<slug>/`.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { slug as slugify } from './ledger-kit.js'
import {
  AUDIT_STATES, PROVENANCE_ACTIONS, PROVENANCE_EXPORT_FORMATS, UNSUPPORTED_STATES,
  buildProvenanceIndex, coverageOf, exportProvenance, impactOf, readAuditIndex,
  staleOf, unverifiedOf, unsupportedOf,
} from './provenance-store.js'

function text(value) {
  return String(value ?? '').trim()
}

function list(value) {
  if (value == null || value === '') return null
  const items = (Array.isArray(value) ? value : [value]).map(text).filter(Boolean)
  return items.length ? items : null
}

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function selectionFrom(args) {
  return {
    review: list(args.review),
    reporting: list(args.reporting),
    meta: list(args.meta),
    analysis: list(args.analysis),
    experiment: list(args.experiment),
    dataset: list(args.dataset),
    deep_review: list(args.deep_review),
    manuscript: text(args.manuscript) || null,
    ah: args.include_ah === undefined ? true : Boolean(args.include_ah),
    verify_quotes: Boolean(args.verify_quotes),
  }
}

async function loadIndex(args, exec, { refresh = false } = {}) {
  const cwd = workspaceRoot(exec)
  const slug = text(args.audit) || 'default'
  const selection = selectionFrom(args)
  if (!refresh) {
    try {
      const cached = readAuditIndex(cwd, slug)
      if (!cached.selection || sameSelection(cached.selection, selection)) return cached
    } catch {
      // no cached index yet — build one below
    }
  }
  return buildProvenanceIndex({ cwd, slug, selection })
}

function sameSelection(cached, wanted) {
  const keyOf = (value) => JSON.stringify(
    value == null || value === ''
      ? null
      : (Array.isArray(value) ? value : [value]).map(text).filter(Boolean).map((entry) => slugify(entry)),
  )
  const path = (value) => text(value) || null
  return ['review', 'reporting', 'meta', 'analysis', 'experiment', 'dataset', 'deep_review']
    .every((field) => keyOf(cached[field]) === keyOf(wanted[field]))
    && path(cached.manuscript) === path(wanted.manuscript)
    && (cached.ah !== false) === (wanted.ah !== false)
    && Boolean(cached.verify_quotes) === Boolean(wanted.verify_quotes)
}

function itemLine(item) {
  const where = item.path || item.location || item.paper || item.slug || ''
  return `- [${item.state}] ${item.id} · ${item.label}${where ? ` · ${where}` : ''}${item.reason ? ` — ${item.reason}` : ''}`
}

function renderValue(value) {
  if (value?.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  switch (value.action) {
    case 'index': {
      const lines = [
        `Indexed ${value.coverage.totals.nodes} nodes and ${value.coverage.totals.edges} edges into audit "${value.audit}" (index ${value.index_hash.slice(0, 23)}…).`,
        `Readable ledgers: ${value.readable}. Claims: ${value.coverage.totals.supported}/${value.coverage.totals.claims} with verified support.`,
        `Without support: ${UNSUPPORTED_STATES.map((state) => `${state} ${value.coverage.totals.by_state[state] || 0}`).join(', ')}.`,
        'Read-only: no source ledger was written.',
      ]
      if (value.coverage.warnings.length) {
        lines.push('', `Warnings (${value.coverage.warnings.length}):`, ...value.coverage.warnings.slice(0, 6).map((warning) => `- ${warning}`))
        if (value.coverage.warnings.length > 6) lines.push(`- …${value.coverage.warnings.length - 6} more`)
      }
      const missing = value.coverage.sources.filter((entry) => entry.status === 'unknown')
      if (missing.length) lines.push('', `Unknown sources: ${missing.map((entry) => `${entry.ledger}:${entry.slug}`).join(', ')}`)
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'coverage': {
      const lines = [
        `Audit "${value.audit}" · index ${value.coverage.index_hash.slice(0, 23)}… · built ${value.coverage.created_at}`,
        `Totals: ${value.coverage.totals.nodes} nodes, ${value.coverage.totals.edges} edges, ${value.coverage.totals.claims} claims (${value.coverage.totals.supported} supported).`,
        '',
        '| Ledger | Nodes | Claims | ' + AUDIT_STATES.join(' | ') + ' |',
        `|---|---|---|${AUDIT_STATES.map(() => '---').join('|')}|`,
        ...value.coverage.ledgers.map((entry) => `| ${entry.ledger} | ${entry.nodes} | ${entry.claims} | ${AUDIT_STATES.map((state) => entry.by_state[state] || 0).join(' | ')} |`),
        '',
        'Sources:',
        ...value.coverage.sources.map((entry) => `- ${entry.ledger}:${entry.slug} — ${entry.status}${entry.reason ? ` (${entry.reason})` : ''}`),
      ]
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'unsupported': {
      if (!value.result.items.length) {
        return [{ type: 'text', text: `No unsupported claims${value.state ? ` in state "${value.state}"` : ''}. ${value.result.claims} claim(s) indexed, ${value.result.supported} with verified support.` }]
      }
      const lines = [
        `${value.result.unsupported} of ${value.result.claims} claim(s) lack verified support.`,
        UNSUPPORTED_STATES.map((state) => `${state}: ${value.result.by_state[state] || 0}`).join(' · '),
        '',
        ...value.result.items.map(itemLine),
      ]
      if (value.result.truncated) lines.push('', `…${value.result.truncated} more (raise limit or narrow with state).`)
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'stale': {
      if (!value.result.items.length) return [{ type: 'text', text: 'Nothing indexed depends on a source that changed since it was recorded.' }]
      const lines = [`${value.result.stale} node(s) are stale (${value.result.from_changed_sources} inherited from a changed file).`, '']
      for (const item of value.result.items) {
        const hashes = item.hashes?.recorded || item.hashes?.current
          ? ` · was ${String(item.hashes.recorded || '—').slice(0, 18)}, now ${String(item.hashes.current || '—').slice(0, 18)}`
          : ''
        lines.push(`- [${item.previous_state || item.state} → stale] ${item.id} · ${item.label}${item.location ? ` · ${item.location}` : ''}${hashes} — ${item.reason}`)
      }
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'unverified': {
      if (!value.result.items.length) return [{ type: 'text', text: 'No node carries a verification attempt that failed to confirm it.' }]
      return [{ type: 'text', text: [`${value.result.unverified} node(s) have a verification that did not confirm them.`, '', ...value.result.items.map(itemLine)].join('\n') }]
    }
    case 'impact': {
      const lines = [
        `Dependents of ${value.result.target}: ${value.result.dependents.length} ledger record(s) reference it.`,
        '',
        ...value.result.dependents.map((item) => `- d${item.depth} [${item.state}] ${item.id} (${item.ledger}): ${item.label}`),
      ]
      if (value.result.truncated) lines.push('', `…${value.result.truncated} more.`)
      lines.push('', value.result.note)
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'export':
      return [{ type: 'text', text: `Wrote ${value.result.path} (${value.result.bytes} bytes, ${value.result.format}, ${value.result.nodes} nodes / ${value.result.edges} edges).` }]
    default:
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }
}

export async function runProvenanceAction(args, exec) {
  const action = args.action || 'coverage'
  if (!PROVENANCE_ACTIONS.includes(action)) throw new Error(`action must be one of ${PROVENANCE_ACTIONS.join(', ')}`)
  const refresh = action === 'index' || Boolean(args.refresh)

  if (action === 'index') {
    const cwd = workspaceRoot(exec)
    const slug = text(args.audit) || 'default'
    const index = await buildProvenanceIndex({ cwd, slug, selection: selectionFrom(args) })
    const coverage = coverageOf(index)
    return {
      action,
      audit: index.audit,
      index_hash: index.index_hash,
      readable: index.sources.filter((entry) => entry.status === 'present').length,
      coverage,
      sources: index.sources,
      warnings: index.warnings,
      counts: index.counts,
    }
  }

  const index = await loadIndex(args, exec, { refresh })

  if (action === 'coverage') return { action, audit: index.audit, coverage: coverageOf(index) }
  if (action === 'unsupported') {
    return { action, state: args.state ? text(args.state) : null, result: unsupportedOf(index, { state: args.state, limit: args.limit }) }
  }
  if (action === 'stale') return { action, result: staleOf(index, { limit: args.limit }) }
  if (action === 'unverified') return { action, result: unverifiedOf(index, { limit: args.limit }) }
  if (action === 'impact') {
    const target = text(args.target)
    if (!target) throw new Error('impact requires a target id (for example paper:..., quote:..., export:<path>, run:...)')
    return { action, result: impactOf(index, target, { limit: args.limit }) }
  }
  if (action === 'export') {
    const cwd = workspaceRoot(exec)
    return {
      action,
      result: exportProvenance({
        cwd, slug: text(args.audit) || 'default', index,
        format: args.format || 'markdown', overwrite: Boolean(args.overwrite),
      }),
    }
  }
  throw new Error(`action must be one of ${PROVENANCE_ACTIONS.join(', ')}`)
}

export const name = 'academic-harness-provenance-audit'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'provenance_audit',
    description: [
      'Read-only cross-ledger provenance audit. It joins the ledgers that already exist — `review` (records, screening, evidence, extraction, appraisal, GRADE), `reporting_check`, `deep_review`, `notebook`, `analysis_run`, `experiment_log`, `dataset_get`, `meta_analysis`, and Academic Harness (`ah.yaml`) claim sidecars — by the ids and hashes they already store, and answers which claims lack verified support and where the supported ones came from.',
      'Actions: `index` (build or refresh the read-only index for this workspace; optional ledger slugs, `manuscript`, `include_ah`, and `verify_quotes` for a live PaperMemory quote re-check), `coverage` (counts per ledger and state, plus which sources were readable), `unsupported` (claims with no verified support, split into `no_link`, `not_checked`, `unverified`, `stale`, `not_found`; optional `state` filter), `stale` (evidence whose source hash or quote changed, with old and new hashes), `unverified` (evidence stored without a confirming verification or human signature), `impact` (what depends on a `paper:`/`quote:`/`export:<path>`/`run:` id), `export` (markdown, csv, json, graphml, mermaid under `.dsh/provenance/<audit>/exports/`).',
      'Support is never inferred from co-occurrence, citation proximity, or a model guess: a claim is `supported` only with an explicit stored link plus a verification or recorded human judgement, a ledger that could not be read is `unknown` with its reason, and a broken link is `not_found`. The tool writes only its own cache and export files — it never edits a source ledger, and the graph export is a view, not a database. Load the `provenance-audit` skill before acting on its output.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: PROVENANCE_ACTIONS, description: 'index, coverage, unsupported, stale, unverified, impact, or export. Default coverage (building the index if none is cached).' },
      audit: { type: 'string', description: 'Audit name; its cache lives under .dsh/provenance/<audit>/. Default "default".' },
      review: { type: 'array', items: { type: 'string' }, description: 'Review slugs to index (default: every review ledger in the workspace).' },
      reporting: { type: 'array', items: { type: 'string' }, description: 'Reporting-check slugs to index.' },
      meta: { type: 'array', items: { type: 'string' }, description: 'Meta-analysis slugs to index.' },
      analysis: { type: 'array', items: { type: 'string' }, description: 'Analysis-plan slugs to index.' },
      experiment: { type: 'array', items: { type: 'string' }, description: 'Experiment slugs to index.' },
      dataset: { type: 'array', items: { type: 'string' }, description: 'Dataset slugs to index.' },
      deep_review: { type: 'array', items: { type: 'string' }, description: 'Deep-review keys to index (default: every stored review).' },
      manuscript: { type: 'string', description: 'Workspace-relative manuscript path to include as an audited source.' },
      include_ah: { type: 'boolean', description: 'Index Academic Harness claim sidecars when the workspace has ah.yaml. Default true.' },
      verify_quotes: { type: 'boolean', description: 'Re-check every linked quote through PaperMemory (papermemory_quote_check). Default false: stored quote-check statuses are used.' },
      refresh: { type: 'boolean', description: 'Rebuild the index instead of reusing the cached one. Always on for action=index.' },
      state: { type: 'string', enum: UNSUPPORTED_STATES, description: 'unsupported: restrict to one unsupported state.' },
      target: { type: 'string', description: 'impact: node id, paper key, or workspace path to trace dependents of.' },
      limit: { type: 'integer', description: 'Rows to return for unsupported/stale/unverified/impact (default 50–100, max 500).' },
      format: { type: 'string', enum: PROVENANCE_EXPORT_FORMATS, description: 'export: markdown (default), csv, json, graphml, or mermaid.' },
      overwrite: { type: 'boolean', description: 'export: replace an existing export file. Default false.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return await runProvenanceAction(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Provenance audit (${args.action || 'coverage'})`, kind: 'other' }
    },
  }))
}
