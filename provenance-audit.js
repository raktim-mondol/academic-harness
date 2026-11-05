/**
 * provenance_audit: the read-only cross-ledger audit.
 *
 * It answers the question no single ledger can: which manuscript claims, review
 * inclusions, extractions, appraisals, or hypotheses have no verified support,
 * and exactly where the supported ones came from. It creates no new source of
 * truth — it joins the ledgers that already exist by the ids and hashes they
 * already store, and writes only its own cache under `.dsh/provenance/<slug>/`.
 */
import { defineTool } from 'ah-dsh-tools'
import { slug as slugify } from './ledger-kit.js'
import {
  AUDIT_STATES, PROVENANCE_ACTIONS, PROVENANCE_EXPORT_FORMATS, UNSUPPORTED_STATES,
  armsOf, buildProvenanceIndex, coverageOf, exportProvenance, impactOf, readAuditIndex, rollupOf,
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
    ablation: list(args.ablation),
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
  return ['review', 'reporting', 'meta', 'analysis', 'experiment', 'ablation', 'dataset', 'deep_review']
    .every((field) => keyOf(cached[field]) === keyOf(wanted[field]))
    && path(cached.manuscript) === path(wanted.manuscript)
    && (cached.ah !== false) === (wanted.ah !== false)
    && Boolean(cached.verify_quotes) === Boolean(wanted.verify_quotes)
}

function itemLine(item) {
  const where = item.path || item.location || item.paper || item.slug || ''
  return `- [${item.state}] ${item.id} · ${item.label}${where ? ` · ${where}` : ''}${item.reason ? ` — ${item.reason}` : ''}`
}

function cellText(value) {
  return String(value ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim()
}

function msText(value) {
  if (value == null) return 'not recorded'
  if (value < 1000) return `${value} ms`
  const seconds = value / 1000
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${(seconds / 60).toFixed(1)} min`
}

function stageText(summary) {
  if (!summary || summary.state === 'not_recorded') return 'not recorded'
  if (summary.state === 'not_linked') return 'not linked'
  const verdicts = summary.verdicts || {}
  return `${summary.run_count} run(s) · good ${verdicts.good || 0}, engineer ${verdicts.engineer || 0}, bad ${verdicts.bad || 0}, missing ${verdicts.missing || 0} · ${msText(summary.recorded_ms)}`
}

function renderRollup(value) {
  const rollup = value.rollup
  const lines = [`Loop roll-up (report only) for audit "${rollup.audit}" · index ${rollup.index_hash.slice(0, 23)}…`]
  if (!rollup.cycles.length) {
    lines.push('', ...rollup.notes)
    return [{ type: 'text', text: lines.join('\n') }]
  }
  for (const cycle of rollup.cycles) {
    lines.push('', `## ${cycle.id}${cycle.source === 'workspace' ? ' (workspace)' : ''}`)
    if (cycle.state === 'unknown') {
      lines.push(`Could not read this cycle: ${cycle.reason}`)
      continue
    }
    lines.push(`Problem: ${cycle.problem?.goal || '(not recorded)'}`)
    if (cycle.problem?.analyses?.length) {
      lines.push(`Analyses: ${cycle.problem.analyses.map((analysis) => `${analysis.slug}${analysis.question ? ` — ${analysis.question}` : ''}`).join('; ')}`)
    }
    if (cycle.limitations?.state === 'recorded') {
      const c = cycle.limitations.coverage
      lines.push(`Limitations: ${c.limitations} (covered ${c.covered}, sufficient ${c.sufficient}, insufficient ${c.insufficient}, exhausted ${c.exhausted}, open ${c.open})`)
      for (const limitation of (cycle.limitations.records || []).slice(0, 5)) {
        lines.push(`- ${limitation.id} · ${limitation.state}${limitation.rounds != null ? ` · round ${limitation.rounds}/${limitation.max_rounds}` : ''} · ${limitation.flaw}`)
      }
    } else {
      lines.push(`Limitations: ${cycle.limitations?.state || 'not recorded'}`)
    }
    if (cycle.ideas?.state === 'recorded') {
      const c = cycle.ideas.counts
      lines.push(`Idea pool: ${c.total} total / ${c.active} active / ${c.pendingReview} pending / ${c.rejected} rejected / ${c.quarantined} quarantined · champion ${cycle.ideas.champion_id || 'none'}`)
      for (const idea of (cycle.ideas.rows || []).slice(0, 5)) {
        lines.push(`- ${idea.id} · ${idea.status} · rating ${Number(idea.rating).toFixed(1)} · ${idea.title}`)
      }
    } else {
      lines.push(`Idea pool: ${cycle.ideas?.state || 'not recorded'}`)
    }
    lines.push(`Subset verdicts: ${stageText(cycle.stages?.subset)}`)
    lines.push(`Scale-up: ${stageText(cycle.stages?.scale_up)}`)
    if (cycle.stages?.unstaged?.run_count) lines.push(`Unstaged runs: ${stageText(cycle.stages.unstaged)}`)
    if (cycle.stages?.state === 'not_linked' && cycle.stages.candidates?.length) {
      lines.push(`No linked experiment run. Candidates: ${cycle.stages.candidates.map((candidate) => candidate.slug).join(', ')}`)
    }
    if (cycle.selection?.state === 'recorded') {
      lines.push(`Selection: ${cycle.selection.idea_id}${cycle.selection.evidence_digest ? ` · ${cycle.selection.evidence_digest.slice(0, 23)}…` : ''}${cycle.selection.rationale ? ` — ${cycle.selection.rationale}` : ''}`)
    } else {
      lines.push('Selection: not recorded')
    }
    if (cycle.ablation?.state === 'recorded') {
      lines.push(`Ablation (${cycle.ablation.rows.length}):`)
      for (const row of cycle.ablation.rows.slice(0, 5)) {
        lines.push(`- ${row.slug} · idea ${row.idea_id || '—'} · verdict ${row.latest_verdict || 'missing'} · ${row.attribution ? `${row.attribution.attributed.length} attributed / ${row.attribution.unattributed.length} unattributed` : 'no attribution reading'}`)
      }
    } else {
      lines.push(`Ablation: ${cycle.ablation?.state || 'not recorded'}`)
    }
    if (cycle.reviews?.state === 'recorded') {
      const t = cycle.reviews.totals
      lines.push(`Review rounds: ${t.rounds} (${t.held_out} held_out, ${t.in_distribution} in_distribution) · ${msText(t.duration_ms)} · ${t.tokens ?? 'no'} token(s)`)
      for (const round of (cycle.reviews.rounds || []).slice(0, 5)) {
        lines.push(`- ${round.key} round ${round.round} · ${round.evaluator_kind} · ${msText(round.duration_ms)} · ${round.usage ? `${round.usage.prompt_tokens || 0}/${round.usage.completion_tokens || 0} tokens` : 'no token tally'}`)
      }
    } else {
      lines.push('Review rounds: not recorded')
    }
    if (cycle.integrity?.state === 'recorded') {
      const t = cycle.integrity.totals
      lines.push(`Integrity: ${t.rows} artifact(s): ${t.ready} ready, ${t.partial} partial, ${t.not_ready} not ready, ${t.not_checked} not checked`)
      for (const row of cycle.integrity.rows.slice(0, 6)) {
        lines.push(`- ${row.artifact}: ${row.readiness} · ${Object.entries(row.cells).map(([key, cell]) => `${key} ${cell.state}`).join(' · ')}`)
      }
    } else {
      lines.push('Integrity: not linked')
    }
    lines.push(`Incumbent: ${cycle.incumbent?.state === 'selected' ? `${cycle.incumbent.idea_id} (selected, not promoted)` : 'not recorded'}`)
    const gate = cycle.baseline_gate
    lines.push(`Baseline gate: ${gate?.state || 'not checked'}${gate?.note ? ` — ${gate.note}` : ''}`)
    if (gate?.rows?.length) {
      for (const row of gate.rows.slice(0, 5)) {
        lines.push(`- ${row.slug}${row.run_id ? ` run ${row.run_id}` : ''}: ${row.state}${row.reference ? ` (${row.reference})` : ''}${row.reproduction === false ? ' · mismatch' : ''}${row.compliance_excluded_runs?.length ? ` · other runs violated in this ledger: ${row.compliance_excluded_runs.join(', ')}` : ''}`)
      }
    }
    const cost = cycle.cost
    const omitted = [
      cycle.limitations?.omitted_records ? `${cycle.limitations.omitted_records} limitation(s)` : null,
      cycle.ideas?.omitted_rows ? `${cycle.ideas.omitted_rows} idea(s)` : null,
      cycle.stages?.subset?.omitted_runs ? `${cycle.stages.subset.omitted_runs} subset run(s)` : null,
      cycle.stages?.scale_up?.omitted_runs ? `${cycle.stages.scale_up.omitted_runs} scale-up run(s)` : null,
      cycle.stages?.unstaged?.omitted_runs ? `${cycle.stages.unstaged.omitted_runs} unstaged run(s)` : null,
      cycle.reviews?.omitted_rounds ? `${cycle.reviews.omitted_rounds} review round(s)` : null,
    ].filter(Boolean)
    if (omitted.length) lines.push(`Truncated at limit ${rollup.limit}: ${omitted.join(', ')} — every count above covers all rows.`)
    lines.push(`Cost/time: ${msText(cost?.recorded_ms)} · ${cost?.recorded_tokens ?? 'no'} token(s) · ${cost?.model_calls ?? 'no'} model call tally`)
    if (cost?.by_stage?.length) {
      for (const row of cost.by_stage) lines.push(`- ${row.stage}: ${msText(row.recorded_ms)}${row.recorded_tokens != null ? ` · ${row.recorded_tokens} tokens` : ''}${row.note ? ` — ${row.note}` : ''}`)
    }
    if (cost?.missing?.length) lines.push(`Missing measures: ${cost.missing.join('; ')}`)
    if (cycle.warnings?.length) lines.push('', 'Warnings:', ...cycle.warnings.map((warning) => `- ${warning}`))
  }
  lines.push('', ...rollup.notes)
  return [{ type: 'text', text: lines.join('\n') }]
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
    case 'arms': {
      const arms = value.arms
      const lines = [
        `Readiness roll-up for audit "${arms.audit}" · index ${arms.index_hash.slice(0, 23)}…`,
        `${arms.totals.rows} artifact(s): ${arms.totals.ready} ready · ${arms.totals.partial} partial · ${arms.totals.not_ready} not ready · ${arms.totals.not_checked} not checked.`,
        '',
        '| Artifact | Reported vs recomputed | Protocol digest | References | Method–code | Readiness |',
        '|---|---|---|---|---|---|',
        ...(arms.rows.length
          ? arms.rows.map((row) => `| ${cellText(row.artifact)} | ${arms.columns.map((column) => cellText(`${row.cells[column].state}: ${row.cells[column].value}`)).join(' | ')} | ${row.readiness} |`)
          : ['| (none) | not checked | not checked | not checked | not checked | not_checked |']),
      ]
      if (!arms.rows.length) lines.push('', 'No ledger with a readiness column is indexed, so nothing is ready and nothing is ruled out.')
      const flagged = Object.entries(arms.unsupported).filter(([, count]) => count > 0)
      if (flagged.length) lines.push('', `Unsupported states: ${flagged.map(([state, count]) => `${state} ${count}`).join(', ')}.`)
      const notes = arms.rows.filter((row) => row.notes)
      if (notes.length) lines.push('', 'Notes:', ...notes.map((row) => `- ${row.artifact}: ${row.notes}`))
      lines.push('', arms.note)
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'rollup':
      return renderRollup(value)
    case 'export':
      return [{ type: 'text', text: `Wrote ${value.result.path} (${value.result.bytes} bytes, ${value.result.format}, ${value.result.nodes} nodes / ${value.result.edges} edges).` }]
    default:
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }
}

export async function runProvenanceAction(args, exec) {
  const action = args.action || 'coverage'
  if (!PROVENANCE_ACTIONS.includes(action)) throw new Error(`action must be one of ${PROVENANCE_ACTIONS.join(', ')}`)
  const refresh = action === 'index' || action === 'arms' || action === 'rollup' || Boolean(args.refresh)

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
  if (action === 'arms') return { action, arms: armsOf(index) }
  if (action === 'rollup') {
    return {
      action,
      rollup: rollupOf(index, {
        cwd: workspaceRoot(exec),
        coscientist: text(args.coscientist) || null,
        manuscript: text(args.manuscript) || null,
        limit: args.limit,
      }),
    }
  }
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
      'Read-only cross-ledger provenance audit. It joins the ledgers that already exist — `review` (records, screening, evidence, extraction, appraisal, GRADE), `reporting_check`, `deep_review`, `notebook`, `analysis_run`, `experiment_log`, `ablation`, `dataset_get`, `meta_analysis`, and Academic Harness (`ah.yaml`) claim sidecars — by the ids and hashes they already store, and answers which claims lack verified support and where the supported ones came from.',
      `Actions: \`index\` (build or refresh the read-only index for this workspace; optional ledger slugs, \`manuscript\`, \`include_ah\`, and \`verify_quotes\` for a live PaperMemory quote re-check), \`coverage\` (counts per ledger and state, plus which sources were readable), \`unsupported\` (claims with no verified support, split into ${UNSUPPORTED_STATES.map((state) => `\`${state}\``).join(', ')}; optional \`state\` filter), \`stale\` (evidence whose source hash or quote changed, with old and new hashes), \`unverified\` (evidence stored without a confirming verification or human signature), \`impact\` (what depends on a \`paper:\`/\`quote:\`/\`export:<path>\`/\`run:\` id), \`arms\` (one four-column readiness roll-up over artifacts that already exist: reported vs recomputed, protocol digest, references, method–code; it re-indexes first), \`rollup\` (the ordered loop record: frozen problem → limitations → idea pool → subset verdicts → scale-up → selection → ablation → review rounds with evaluator kind → integrity columns → incumbent; optional \`coscientist\` slug and \`manuscript\` review filter), \`export\` (markdown, csv, json, graphml, mermaid under \`.dsh/provenance/<audit>/exports/\`).`,
      '`rollup` is a report, not a store: it reads the coscientist tournament directly (no idea/limitation nodes are added to the index) and writes no source ledger — it refreshes its own audit index first, so the record is never built from stale data. It embeds the same readiness rows as `arms` and reports each stage with what the ledgers actually recorded: analysis `duration_ms` and deep-review round durations/tokens are summed, while experiment, ablation, ideation, and selection stages without a recorded measure are listed as missing, never zeroed. No headline gain is computed, and the report explicitly refuses the paper\'s successful-cases-only framing. A reproduced baseline is gated by `analysis_run expect`/`verify_scores` when it declares `reference: reproduced` and the check ran against a run other than the one the expectation was declared from; the baseline-gate column says which, and the incumbent is `selected` but never silently promoted.',
      `The Phase 8 states are conservative: \`rerun_mismatch\` means a declared reported value did not reproduce in a re-execution, \`no_attribution\` means an ablation reading or human verdict attributes no component, and \`verdict_missing\` means a staged run or ablation has no human verdict. \`arms\` also reads \`deep_review\` \`extra_checks.json\` validity findings, so a flagged check appears here instead of being skipped.`,
      'Support is never inferred from co-occurrence, citation proximity, or a model guess: a claim is `supported` only with an explicit stored link plus a verification or recorded human judgement, a ledger that could not be read is `unknown` with its reason, and a broken link is `not_found`. The tool writes only its own cache and export files — it never edits a source ledger, and the graph export is a view, not a database. Load the `provenance-audit` skill before acting on its output.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: PROVENANCE_ACTIONS, description: 'index, coverage, unsupported, stale, unverified, impact, arms, rollup, or export. Default coverage (building the index if none is cached).' },
      audit: { type: 'string', description: 'Audit name; its cache lives under .dsh/provenance/<audit>/. Default "default".' },
      review: { type: 'array', items: { type: 'string' }, description: 'Review slugs to index (default: every review ledger in the workspace).' },
      reporting: { type: 'array', items: { type: 'string' }, description: 'Reporting-check slugs to index.' },
      meta: { type: 'array', items: { type: 'string' }, description: 'Meta-analysis slugs to index.' },
      analysis: { type: 'array', items: { type: 'string' }, description: 'Analysis-plan slugs to index.' },
      experiment: { type: 'array', items: { type: 'string' }, description: 'Experiment slugs to index.' },
      ablation: { type: 'array', items: { type: 'string' }, description: 'Ablation slugs to index.' },
      coscientist: { type: 'string', description: 'rollup: coscientist tournament slug to roll up. Default: every tournament, or a workspace roll-up when none exists.' },
      dataset: { type: 'array', items: { type: 'string' }, description: 'Dataset slugs to index.' },
      deep_review: { type: 'array', items: { type: 'string' }, description: 'Deep-review keys to index (default: every stored review).' },
      manuscript: { type: 'string', description: 'Workspace-relative manuscript path to include as an audited source; rollup uses it to select stored review rounds.' },
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
