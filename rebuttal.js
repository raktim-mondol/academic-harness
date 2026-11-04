/**
 * rebuttal: advisory reviewer-response coverage ledger (Phase 7).
 *
 * It makes no network call, never runs or creates an experiment, never edits
 * a manuscript, never writes reviewer prose, and never gates a turn — only
 * ah_check blocks. Coverage is this ledger's own reading; inside an ah.yaml
 * project the engine remains authoritative for item status and response prose.
 * The paper's Rebuttal Planner instantiates N_t; this tool never does and caps
 * planned stubs with REBUTTAL_MAX_TASKS in Settings instead.
 */
import { relative } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { EXPERIMENT_BASELINE_REFS } from './experiment-store.js'
import {
  REBUTTAL_SOURCES, REBUTTAL_EXPECTED_EVIDENCE, REBUTTAL_REPLICATES_BASIS,
  REBUTTAL_EXPORT_FORMATS, REBUTTAL_DEFAULT_MAX_TASKS,
  files, listRebuttalTasks, importRebuttalPoints, planRebuttalTask, linkRebuttalTask,
  recordRebuttalAnswer, recordRebuttalDecline, rebuttalCoverage, draftRebuttalLetter,
  exportRebuttal, statusRebuttal,
} from './rebuttal-store.js'

const ACTIONS = ['import', 'plan', 'link', 'respond', 'decline', 'coverage', 'draft', 'export', 'status']

function text(value) {
  return String(value ?? '').trim()
}

function requireString(value, name) {
  const result = text(value)
  if (!result) throw new Error(`${name} is required`)
  return result
}

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

/**
 * The plan cap is Settings-only: no per-call argument overrides it, because an
 * override would defeat the cap that replaces the paper's N_t. An out-of-range
 * or non-numeric value falls back to the default and says so through warnings
 * — unlike the coscientist reader, a non-numeric value is a misconfiguration,
 * not an absence.
 */
async function resolveCap() {
  const raw = String(await resolveEnv('REBUTTAL_MAX_TASKS').catch(() => '') ?? '').trim()
  if (!raw) return { max_tasks: REBUTTAL_DEFAULT_MAX_TASKS, source: 'default' }
  const parsed = Number(raw)
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 200) return { max_tasks: parsed, source: 'setting' }
  return { max_tasks: REBUTTAL_DEFAULT_MAX_TASKS, source: 'invalid_setting' }
}

const CAP_WARNING = 'REBUTTAL_MAX_TASKS must be an integer 1..200; using 20'

function renderValue(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  switch (value.action) {
    case 'import': {
      const imported = value.imported
      const lines = [
        `Imported ${imported.total} point(s) into rebuttal "${value.slug}" from ${value.envelope.source} (${value.envelope.import_id}).`,
        `Skipped ${value.skipped_duplicates.length} duplicate(s), reported ${value.drifted.length} drift(s).`,
      ]
      if (imported.total) lines.push(`By kind: ${Object.entries(imported.by_kind).map(([k, n]) => `${k} ${n}`).join(', ')}.`)
      if (value.warnings?.length) lines.push('', ...value.warnings.map((w) => `warning: ${w}`))
      lines.push(value.outcome_note ?? 'Next: plan supplementary task stubs per point (action "plan").')
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'plan': {
      const t = value.task
      return [{ type: 'text', text: `Planned ${t.task_id} for point ${t.point_id}: ${t.dataset}/${t.metric}${t.metric_direction ? ` (${t.metric_direction})` : ''}/${t.baseline_ref} × ${t.replicates} (${t.replicates_basis}), evidence ${t.evidence}; cap ${value.cap.tasks_total}/${value.cap.max_tasks} (REBUTTAL_MAX_TASKS, ${value.cap.source}), ${value.cap.remaining} remaining.\n${(t.validated?.notes || []).map((n) => `note: ${n}`).filter(Boolean).join('\n')}${value.warnings?.length ? `\n${value.warnings.map((w) => `warning: ${w}`).join('\n')}` : ''}` }]
    }
    case 'link': {
      const l = value.link
      return [{ type: 'text', text: `Linked ${l.link_id}: task → ${l.source.ledger} ${l.source.slug}/${l.source.run_id} (digest pinned, ${l.source.artifact_total} artifact(s)) for point ${value.point_id}.${value.warnings?.length ? `\n${value.warnings.map((w) => `warning: ${w}`).join('\n')}` : ''}` }]
    }
    case 'respond': {
      const a = value.answer
      return [{ type: 'text', text: `Recorded ${a.answer_id} for point ${a.point_id} (revision ${a.revision}, evidence ${a.evidence}${a.supersedes ? `, supersedes ${a.supersedes}` : ''}).${value.warnings?.length ? `\n${value.warnings.map((w) => `warning: ${w}`).join('\n')}` : ''}` }]
    }
    case 'decline': {
      const d = value.decline
      return [{ type: 'text', text: `Recorded ${d.decline_id} for point ${d.point_id}: ${d.verified ? 'verified against the engine ledger (ah_author decline)' : 'author-recorded decline (not verified against the engine ledger)'}.${(value.warnings || []).length ? `\n${value.warnings.map((w) => `warning: ${w}`).join('\n')}` : ''}` }]
    }
    case 'coverage': {
      const t = value.totals
      const lines = [
        `Rebuttal "${value.slug}": ${t.points} point(s) — answered ${t.answered}, answered_asserted ${t.answered_asserted}, declined_verified ${t.declined_verified}, declined_recorded ${t.declined_recorded}, unaddressed ${t.unaddressed}; tasks ${t.tasks}, links ${t.links}.`,
      ]
      if (value.closing?.compared_round) {
        lines.push(`Closing vs ${value.closing.compared_round.key} round ${value.closing.compared_round.round}: paired ${value.closing.points_paired}, closed ${value.closing.closed_total}, still_present ${value.closing.still_present_total}, variance_only ${value.closing.variance_only_total}.`)
        lines.push(value.closing.note)
      }
      for (const row of value.rows.slice(0, 20)) {
        lines.push(`- ${row.point_id} (${row.source}, ${row.kind}) ${row.status}${row.closed.state !== 'not_compared' ? ` [${row.closed.state}${row.closed.matched_by ? ` via ${row.closed.matched_by}` : ''}]` : ''}: ${row.text}`)
      }
      if (value.warnings?.length) lines.push('', ...value.warnings.map((w) => `warning: ${w}`))
      lines.push(value.outcome_note)
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'draft': {
      const lines = [
        `Draft response letter (${value.format}) for rebuttal "${value.slug}"${value.written ? ` — wrote ${value.written.path} (${value.written.bytes} bytes)` : ' (returned; nothing written without out)'}.`,
      ]
      if (value.unresolved?.length) lines.push(`Unresolved change ids: ${value.unresolved.join(', ')}.`)
      if (value.evidence_stale?.length) lines.push(`Stale evidence: ${value.evidence_stale.join(', ')}.`)
      if (value.note) lines.push(value.note)
      if (value.retained) lines.push('', `Full letter kept at ${value.retained.path} (${value.retained.bytes} bytes).`)
      lines.push('', value.letter_truncated ? `${value.letter}\n(letter truncated in the return; full text at ${value.retained?.path || 'the ledger copy'})` : value.letter)
      if (value.warnings?.length) lines.push('', ...value.warnings.map((w) => `warning: ${w}`))
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'export':
      return [{ type: 'text', text: `Wrote ${value.path} (${value.bytes} bytes, ${value.format}).${value.warnings?.length ? `\n${value.warnings.map((w) => `warning: ${w}`).join('\n')}` : ''}` }]
    case 'status': {
      const s = value
      if (s.exists === false) return [{ type: 'text', text: `${s.note}` }]
      const lines = [
        `Rebuttal "${s.slug}" — state ${s.state}, dir ${s.dir}.`,
        `Points ${s.points.total} (${Object.entries(s.points.by_source).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}).`,
        `Tasks ${s.tasks.total}/${s.tasks.cap.max_tasks} cap (REBUTTAL_MAX_TASKS, ${s.tasks.cap.source}), links ${s.links.total} (verified ${s.links.digest_verified}, drifted ${s.links.digest_drifted}, unreadable ${s.links.digest_unreadable}), answers ${s.answers.total}, declines ${s.declines.total} (${s.declines.verified} verified / ${s.declines.recorded} recorded).`,
      ]
      if (s.coverage?.totals) lines.push(`Coverage: answered ${s.coverage.totals.answered}, answered_asserted ${s.coverage.totals.answered_asserted}, declined ${s.coverage.totals.declined_verified + s.coverage.totals.declined_recorded}, unaddressed ${s.coverage.totals.unaddressed}.`)
      if (s.warnings?.length) lines.push('', ...s.warnings.map((w) => `warning: ${w}`))
      lines.push(s.outcome_note)
      return [{ type: 'text', text: lines.join('\n') }]
    }
    default:
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }
}

export async function runRebuttalAction(args = {}, exec = {}) {
  const action = args.action || 'status'
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  const slug = requireString(args.slug, 'slug')
  const cap = await resolveCap()

  let result
  if (action === 'import') {
    if (args.forum_id != null && text(args.forum_id) !== '') {
      throw new Error('rebuttal does not call openreview: run the openreview tool yourself, then pass its reviews array to import')
    }
    const imported = await importRebuttalPoints({
      cwd, slug,
      source: requireString(args.source, 'source'),
      kinds: args.kinds,
      name: args.name,
      question: args.question,
      venue: args.venue,
      manuscript: args.manuscript,
      deepReviewKey: args.deep_review_key,
      deepReviewRound: args.deep_review_round,
      ahReview: args.ah_review,
      reviews: args.reviews,
      reviewsPath: args.reviews_path,
      reviewsFetchedAt: args.reviews_fetched_at,
    })
    const f = files(cwd, slug)
    result = {
      action,
      slug: imported.definition.slug,
      dir: relative(cwd, f.dir).replace(/\\/g, '/'),
      definition: imported.definition,
      envelope: imported.envelope,
      imported: imported.imported,
      skipped_duplicates: imported.skipped_duplicates,
      drifted: imported.drifted,
      warnings: imported.warnings,
      next: 'plan',
    }
  } else if (action === 'plan') {
    const { task, warnings } = await planRebuttalTask({
      cwd, slug,
      pointId: args.point_id,
      dataset: args.dataset,
      baselineRef: args.baseline_ref,
      metric: args.metric,
      metricDirection: args.metric_direction,
      replicates: args.replicates,
      replicatesBasis: args.replicates_basis,
      power: args.power,
      experimentSlug: args.experiment_slug,
      evidence: args.evidence,
      rationale: args.rationale,
      cap,
    })
    // cap totals are re-derived from the append-only ledger after the locked
    // append (lock-free read; the cap itself was enforced inside the lock).
    const total = listRebuttalTasks(cwd, slug).length
    result = {
      action,
      task,
      cap: { max_tasks: cap.max_tasks, source: cap.source, tasks_total: total, remaining: Math.max(0, cap.max_tasks - total) },
      warnings,
    }
  } else if (action === 'link') {
    const { link, point_id } = await linkRebuttalTask({
      cwd, slug,
      taskId: args.task_id,
      experimentSlug: args.experiment_slug,
      experimentRunId: args.experiment_run_id,
      analysisSlug: args.analysis_slug,
      analysisRunId: args.analysis_run_id,
      reading: args.reading,
      note: args.note,
    })
    result = { action, link, point_id }
  } else if (action === 'respond') {
    const { answer } = await recordRebuttalAnswer({
      cwd, slug,
      pointId: args.point_id,
      response: args.response,
      linkIds: args.link_ids,
      changeSlug: args.change_slug,
      changeIds: args.change_ids,
      supersedes: args.supersedes,
    })
    result = { action, answer }
  } else if (action === 'decline') {
    const { decline, warnings } = await recordRebuttalDecline({
      cwd, slug,
      pointId: args.point_id,
      reason: args.reason,
      ahItem: args.ah_item,
      declinedBy: args.declined_by,
      supersedes: args.supersedes,
    })
    result = { action, decline, warnings }
  } else if (action === 'coverage') {
    result = await rebuttalCoverage(cwd, slug, {
      cap,
      limit: args.limit,
      pointId: args.point_id,
      closing: { deepReviewKey: args.deep_review_key, deepReviewRound: args.deep_review_round },
    })
  } else if (action === 'draft') {
    result = await draftRebuttalLetter(cwd, slug, {
      cap,
      format: args.format,
      out: args.out,
      points: args.points,
      onlyUnanswered: Boolean(args.only_unanswered),
      overwrite: Boolean(args.overwrite),
    })
  } else if (action === 'export') {
    const exported = await exportRebuttal({
      cwd, slug,
      format: args.format,
      overwrite: Boolean(args.overwrite),
      cap,
      closing: { deepReviewKey: args.deep_review_key, deepReviewRound: args.deep_review_round },
    })
    result = exported
  } else if (action === 'status') {
    result = await statusRebuttal(cwd, slug, { cap })
  } else {
    throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  }
  if (cap.source === 'invalid_setting') {
    result.warnings = [CAP_WARNING, ...(Array.isArray(result.warnings) ? result.warnings : [])]
  }
  return result
}

export const name = 'academic-harness-rebuttal'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'rebuttal',
    description: [
      'Keep a reviewer-response coverage ledger under `.dsh/rebuttal/<slug>/`. It never fetches, never executes, never edits a manuscript, and never writes reviewer prose: `import` takes a stored `deep_review` round, `ah_review` items, or `openreview` reviews the session already has, keeping reviewer identity and `evaluator_kind` with each point.',
      'Actions: `import` (one source per call; a re-import dedupes and reports drift), `plan` (per point a supplementary task stub: dataset, baseline arm reproduced|reported, metric, replicate count from a supplied power_analysis result or a declared basis, expected evidence type; growth capped by REBUTTAL_MAX_TASKS), `link` (task to an existing `experiment_log` or hashed `analysis_run` run by id, pinned to a SHA-256 digest of that run), `respond` (the author\'s own answer, citing link ids and recorded manuscript_diff hunks), `decline` (record a decline the author already made: with `ah_item` it is verified against the engine\'s `declined` status — run `ah_author action=decline` first; without one, for a `deep_review` or `openreview` point, it is stored as an author-recorded decline and always labelled unverified; this tool never makes a decline itself), `coverage` (answered / answered_asserted / declined / unaddressed, and which points a newer `deep_review` round closed), `draft` (a response-letter skeleton that cites only recorded hunks and linked artifacts, plus the items array for manuscript_diff and the ah_review_respond handoff), `export` (markdown/json/csv), `status`.',
      'Coverage counts whether a point was answered with cited evidence, never whether the answer helped: a linked run with a bad verdict, spec drift, or a non-zero exit stays recorded and reportable. The paper\'s Rebuttal Planner instantiates N_t; this tool never does, and REBUTTAL_MAX_TASKS caps the stubs instead. Inside an ah.yaml project the engine remains authoritative for item status and the response letter; this ledger records its own evidence-linked reading beside it. No value here is a scientific claim or an acceptance decision, and nothing gates a turn — only `ah_check` blocks. Load the `rebuttal-experiments` skill for the workflow; `rebuttal-guidance` supplies strategy, this ledger keeps the evidence.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ACTIONS, description: 'import, plan, link, respond, decline, coverage, draft, export, or status. Default status.' },
      slug: { type: 'string', description: 'All actions: rebuttal slug (stable short name for the ledger under .dsh/rebuttal/<slug>/).' },
      source: { type: 'string', enum: REBUTTAL_SOURCES, description: 'import: deep_review, ah_review, or openreview. One source per call.' },
      name: { type: 'string', description: 'import: display name for the write-once definition (first import only; defaults to the slug).' },
      question: { type: 'string', description: 'import: question the ledger answers (first import only; stored as supplied, never inferred).' },
      venue: { type: 'string', description: 'import: venue label, e.g. ICLR 2027 (first import only).' },
      manuscript: { type: 'string', description: 'import: workspace-relative manuscript pointer (first import only). It is a pointer, never opened at import; a source that names a different path prints a mismatch warning.' },
      kinds: { type: 'array', items: { type: 'string' }, description: 'import: point kinds to keep (question, weakness, comment, checklist, claim). Default all five; an unknown value is refused in-band.' },
      deep_review_key: { type: 'string', description: 'import/coverage: deep_review store key (16 hex) or the manuscript path of the round to import (import) or the newer round to pair against (coverage closing reading).' },
      deep_review_round: { type: 'string', description: 'import/coverage: round number or run_id within the deep_review store. Default the latest round.' },
      ah_review: { type: 'string', description: 'import: Academic Harness review id (e.g. R1); imports its major|minor items from the engine YAML.' },
      reviews: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'import: the openreview action="reviews" output (or raw OpenReview notes) this session already has. This tool never fetches.' },
      reviews_path: { type: 'string', description: 'import: workspace-relative file containing the supplied openreview reviews or notes (≤50 MB). Alternative to reviews.' },
      reviews_fetched_at: { type: 'string', description: 'import: the caller\'s verbatim note of when the openreview data was fetched; rebuttal cannot know it.' },
      point_id: { type: 'string', description: 'plan/coverage/respond/decline: an imported point id (p0001…).' },
      dataset: { type: 'string', description: 'plan: dataset name for the supplementary task stub.' },
      baseline_ref: { type: 'string', enum: EXPERIMENT_BASELINE_REFS, description: 'plan: baseline arm — reproduced or reported. Never mixed in one stub.' },
      metric: { type: 'string', description: 'plan: metric the stub reads.' },
      metric_direction: { type: 'string', enum: ['higher', 'lower'], description: 'plan: metric direction when the experiment does not declare one, or restates it (a contradiction is recorded as a note).' },
      replicates: { type: 'integer', description: 'plan: replicate count, 1..100. With a power object it defaults to the powered n and may not exceed it; without one it is required.' },
      replicates_basis: { type: 'string', enum: REBUTTAL_REPLICATES_BASIS, description: 'plan: where the replicate count came from (power_analysis, pilot, literature, budget, venue_requirement, author_judgement). Required when no power object is supplied.' },
      power: { type: 'object', additionalProperties: true, description: 'plan: a power_analysis result object stored verbatim beside two provenance keys; the store reads result.n (or a flat preregister-style n).' },
      experiment_slug: { type: 'string', description: 'plan: experiment_log slug whose benchmark spec and declared metrics the stub is validated against (readings recorded, not refused). link: slug of the run to link.' },
      evidence: { type: 'string', enum: REBUTTAL_EXPECTED_EVIDENCE, description: 'plan: expected evidence type (metric_table, additional_baseline, ablation, statistical_evidence, reproducibility_detail, text_revision, citation_fix, no_experiment_expected).' },
      rationale: { type: 'string', description: 'plan: caller-supplied reason for the stub, stored as given.' },
      task_id: { type: 'string', description: 'link: a planned task id (t0001…).' },
      experiment_run_id: { type: 'string', description: 'link: an existing experiment_log run id (metrics are read live from it; never copied).' },
      analysis_slug: { type: 'string', description: 'link: analysis_run slug for a hashed analysis run.' },
      analysis_run_id: { type: 'string', description: 'link: an existing analysis_run run id with hashed outputs or artifacts.' },
      reading: { type: 'object', additionalProperties: true, description: 'link: caller reading of the analysis run\'s hashed outputs (metric name → finite number). Required for analysis links, refused for experiment links.' },
      note: { type: 'string', description: 'link: free-text note stored as given.' },
      response: { type: 'string', description: 'respond: the author\'s own words (clipped at 8000); this tool never writes reviewer prose.' },
      link_ids: { type: 'array', items: { type: 'string' }, description: 'respond: link ids (l0001…) of tasks planned for the same point, cited by the answer.' },
      change_slug: { type: 'string', description: 'respond: manuscript_diff slug whose recorded changes.json holds the cited hunks (normalized with manuscript-diff\'s own sanitizer).' },
      change_ids: { type: 'array', items: { type: 'string' }, description: 'respond: recorded change ids (ch-003…) to cite; needs change_slug.' },
      supersedes: { type: 'string', description: 'respond/decline: the answer or decline id being superseded; required to answer or decline over a live event.' },
      reason: { type: 'string', description: 'decline: the author\'s recorded reason, stored as given.' },
      ah_item: { type: 'string', description: 'decline: engine item id (e.g. R1.2); the decline is verified against its live declined status.' },
      declined_by: { type: 'string', description: 'decline: who declined, for a point with no ah item; always labelled an unverified author-recorded decline.' },
      limit: { type: 'integer', description: 'coverage: rows to return, 1..2000 (default 200); totals always cover the full set.' },
      format: { type: 'string', enum: [...REBUTTAL_EXPORT_FORMATS, 'latex'], description: 'draft: markdown (default) or latex — json/csv are refused for draft; export: markdown, json, or csv — latex is refused for export.' },
      out: { type: 'string', description: 'draft: workspace-relative path to write the letter to; when omitted nothing is written.' },
      overwrite: { type: 'boolean', description: 'draft/export: replace an existing file (default false).' },
      points: { type: 'array', items: { type: 'string' }, description: 'draft: point ids to include (default every point).' },
      only_unanswered: { type: 'boolean', description: 'draft: include only unaddressed points (default false).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return await runRebuttalAction(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Rebuttal: ${args.slug || ''} (${args.action || 'status'})`, kind: 'other' }
    },
  }))
}
