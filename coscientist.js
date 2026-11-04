/**
 * coscientist: the hypothesis-tournament ledger.
 *
 * State lives under `<cwd>/.dsh/coscientist/<slug>/` (coscientist-store.js);
 * rating arithmetic and scheduling policy live in coscientist-models.js. This
 * tool is argument parsing and rendering — the cap, the duplicate gate, the
 * review stage order, and the status transitions are enforced in the store, so
 * they hold whether a call comes from the session, a subagent, or a script.
 *
 * The tournament is driven turn by turn: `next` says which task the policy
 * samples, the session does it (usually with a subagent), and the result is
 * recorded back here. There is no background loop to wait on.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_LIMITATION_ROUNDS, DEFAULT_MAX_HYPOTHESES, DEFAULT_STEP_BUDGET, HYPOTHESIS_STATUSES,
  LIMITATION_VERDICTS, REVIEW_STAGES, VERDICTS,
  addHypothesis, addLimitation, attachVectors, exportTournament, knowledgeGraph, leaderboard, lineage,
  limitationStatus, nextTask, priorFeedback, recordReview, recordSafety, saveExperimentProtocol,
  saveSynthesis, selectChampion, setStatus, similarityNeighbours, startTournament, tournamentSlug,
  verifyLimitation,
} from './coscientist-store.js'
import { traceExperiments } from './coscientist-trace.js'
import { selectEvolutionStrategy } from './coscientist-models.js'
import { MAX_TEXTS_PER_BATCH, embedTexts, resolveEmbedModel } from './coscientist-embed.js'
import { resolveEnv } from './credential-env.js'

const ACTIONS = [
  'start', 'add', 'review', 'safety', 'status', 'next', 'set_status',
  'lineage', 'embed', 'priors', 'graph', 'design_protocol', 'synthesize', 'export',
  'limitation', 'trace', 'select',
]
const LIMITATION_ACTIONS = ['add', 'verify', 'status']

/** What each sampled task asks the session to do, in one line. */
const DISPATCH = {
  generation: () => 'Generate one hypothesis: search the literature first, then run one of the four generation strategies (literature_exploration while fewer than 3 are active, then rotating scientific_debate → assumption_chaining → research_expansion by round) and `add` the result.',
  reflection: () => 'Review one pending hypothesis through the five stages in order (`review`); verify its citations as you go with crossref_lookup / paper_resolve, and record what could not be resolved as unverified.',
  ranking: () => 'Run one tournament match: `coscientist_rank propose`, judge both orientations with one subagent at a time (same brief, slots swapped), then `coscientist_rank record`.',
  evolution: (round) => `Evolve a top hypothesis with the ${selectEvolutionStrategy(round)} mutation, then \`add\` it with parent_ids. Treat any failed or pruned experiment traces in this dispatch as constraints: do not re-propose an assumption they already refuted.`,
  proximity: () => 'Refresh similarity: `coscientist_rank similarity` on the live hypotheses; flag any duplicate pair for the scientist.',
  meta_review: () => 'Synthesize a cross-cutting critique of the current set, then `synthesize` it; it steers later generation.',
}

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function requireSlug(args) {
  const slug = String(args.slug ?? '').trim()
  if (!slug) throw new Error('slug is required')
  return tournamentSlug(slug)
}

function requireId(args) {
  const id = String(args.id ?? '').trim()
  if (!id) throw new Error('id is required (e.g. h1)')
  return id
}

function finiteOrUndefined(value) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function listParam(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry ?? '').trim()).filter(Boolean)
  const single = String(value ?? '').trim()
  return single ? [single] : []
}

/** A numeric Settings field, absent unless it actually holds a number. */
async function settingNumber(field) {
  const raw = String(await resolveEnv(field) ?? '').trim()
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Similarity summary after a change of measure, so the shift is visible. */
function similarityNeighboursFor(cwd, slug) {
  const live = leaderboard(cwd, slug).ranked.filter((row) => row.status !== 'rejected')
  const embedded = live.filter((row) => row.embedded).length
  // Read off the pool, not off the edges: two orthogonal embeddings produce no
  // edges at all, and "no edges" is not the same as "lexical".
  const measure = !embedded ? 'lexical' : (embedded === live.length ? 'vector' : 'mixed')
  const { edges, duplicates } = similarityNeighbours(cwd, slug)
  return {
    measure,
    live_embedded: embedded,
    total: live.length,
    duplicates: duplicates.map((entry) => ({ a: entry.a, b: entry.b, score: entry.score, threshold: entry.threshold })),
    related: edges.map((entry) => ({ a: entry.a, b: entry.b, score: entry.score, measure: entry.measure })),
  }
}

/** Argument first, then Settings, then the built-in default. */
async function settingOr(field, argsValue, fallback) {
  const explicit = finiteOrUndefined(argsValue)
  if (explicit !== undefined) return explicit
  const stored = await settingNumber(field)
  return stored === undefined ? fallback : stored
}

function compactBoard(view) {
  return {
    slug: view.slug,
    goal: view.goal,
    counts: view.counts,
    rounds: view.rounds,
    steps_used: view.steps_used,
    step_budget: view.step_budget,
    max_hypotheses: view.max_hypotheses,
    max_matches: view.max_matches,
    avg_top_elo: view.avg_top_elo,
    top_elo: view.top_elo,
    termination: view.termination,
    limitations: view.limitations,
    champion: view.champion,
    selections: view.selections,
    ranked: view.ranked,
  }
}

/** Drop the full derived state; a tool result should not carry every body. */
function withoutState(result) {
  if (!result || typeof result !== 'object') return result
  const { state, ...rest } = result
  return rest
}

function renderStatus(value) {
  if (value?.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  switch (value?.action) {
    case 'start': {
      const protocol = value.protocol
      return [{
        type: 'text',
        text: [
          `${value.resumed ? 'Resumed' : 'Started'} tournament \`${protocol.slug}\`.`,
          `Goal: ${protocol.goal}`,
          `Budget: ${protocol.max_hypotheses} hypotheses, ${protocol.step_budget} steps.${protocol.max_matches ? ` Match cap: ${protocol.max_matches} (the loop stops there).` : ''} Duplicate gate: ${protocol.dup_threshold >= 1 ? 'off' : protocol.dup_threshold}.`,
          protocol.seed !== undefined ? `Schedule seed: ${protocol.seed}.` : '',
          'Ask `next` for the first task. Hypotheses are recombined published knowledge, not results.',
        ].filter(Boolean).join('\n'),
      }]
    }
    case 'add': {
      if (value.discarded) {
        if (value.discarded.reason === 'near_duplicate') {
          return [{ type: 'text', text: `Discarded as a near-duplicate of \`${value.discarded.nearest_id}\` (similarity ${value.discarded.score} ≥ ${value.discarded.threshold}). Generate a genuinely different claim, not a restatement.` }]
        }
        return [{ type: 'text', text: `Discarded: the cap of ${value.discarded.cap} hypotheses is reached. Rank and evolve what you have.` }]
      }
      const hyp = value.hypothesis
      return [{ type: 'text', text: `Added \`${hyp.id}\` (${hyp.status}, rating ${hyp.rating}, RD ${hyp.rd}): ${hyp.title}${hyp.parent_ids.length ? `\nLineage: evolved from ${hyp.parent_ids.join(', ')}.` : ''}${hyp.limitation_ids?.length ? `\nAddresses limitations: ${hyp.limitation_ids.join(', ')}.` : ''}` }]
    }
    case 'review': {
      const hyp = value.hypothesis
      const lines = [`\`${hyp.id}\` ${value.stage || ''} → ${value.status}.`]
      if (value.seeded) lines.push(`Seeded rating ${value.seeded.rating} (RD ${value.seeded.rd}) — the hypothesis now competes in the tournament.`)
      if (value.stages_remaining?.length) lines.push(`Stages still to record: ${value.stages_remaining.join(', ')}.`)
      if (value.status === 'rejected') lines.push('Rejected; it leaves the tournament. Its reviews stay in the ledger.')
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'next': {
      const guide = DISPATCH[value.task] || (() => '')
      return [{
        type: 'text',
        text: [
          `Round ${value.round} — sampled task: ${value.task}.`,
          value.dispatch,
          `Weights in force: ${Object.entries(value.weights).map(([key, weight]) => `${key} ${weight}`).join(', ')}.`,
          `Steps ${value.steps_used}/${value.step_budget}.${value.max_matches ? ` Matches ${value.matches_used}/${value.max_matches}.` : ''}${value.budget_warning ? ' ⚠ approaching the step budget.' : ''}`,
          value.traces?.failed?.length
            ? `Experiment traces to respect: ${value.traces.failed_total} failed/pruned run(s) — ${value.traces.notes.slice(0, 3).join('; ')}`
            : (value.traces ? 'No failed or pruned experiment traces in this workspace yet.' : ''),
          value.terminate ? `STOP: ${value.reason}. Run \`select\` to freeze the champion, design its protocol, then export.` : '',
        ].filter(Boolean).join('\n'),
      }]
    }
    case 'safety': {
      const assessment = value.assessment
      const lines = [`${value.hypothesis.id} screened: severity ${assessment.severity} → ${assessment.decision} (${value.hypothesis.safety?.category || 'unspecified'}).`]
      if (value.hypothesis.safety?.reasoning) lines.push(value.hypothesis.safety.reasoning)
      if (assessment.decision === 'quarantined') lines.push('Withheld from the tournament. Only the user can release it, by name, with `set_status`.')
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'set_status': {
      const hyp = value.hypothesis
      return [{ type: 'text', text: value.unchanged ? `\`${hyp.id}\` was already ${hyp.status}; nothing recorded.` : `\`${hyp.id}\` → ${hyp.status}. ${hyp.status_reason}` }]
    }
    case 'lineage': {
      const lines = [`\`${value.id}\` — ${value.title} (rating ${value.rating}, RD ${value.rd}, ${value.status})`, `Parents: ${value.parent_ids.join(', ') || 'none'} · Children: ${value.children.join(', ') || 'none'}`]
      for (const diff of value.diffs) {
        lines.push(diff.missing ? `  parent ${diff.parent_id}: missing from this ledger` : `  vs ${diff.parent_id} (${diff.parent_title}): ${diff.changed_fields.join(', ') || 'no field changed'}, rating ${diff.rating_delta >= 0 ? '+' : ''}${diff.rating_delta}`)
      }
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'design_protocol':
      return [{ type: 'text', text: `Protocol for \`${value.hypothesis.id}\` recorded (${value.steps} steps). It belongs to that hypothesis only.` }]
    case 'synthesize':
      const saved = [value.critique ? 'Meta-review critique stored; it steers later generation.' : '', value.overview ? 'Research overview stored.' : ''].filter(Boolean)
      return [{ type: 'text', text: saved.join('\n') }]
    case 'embed':
      return [{ type: 'text', text: [
        value.note || `Embedded ${value.embedded}/${value.total} hypotheses with ${value.model} (${value.dimensions}-dimensional).`,
        value.measure ? `Similarity now uses the ${value.measure} measure with its own thresholds.` : '',
        value.duplicates?.length ? `Duplicate pairs at the current threshold: ${value.duplicates.map((d) => `${d.a}~${d.b} (${d.score})`).join(', ')}` : 'No duplicate pairs at the current threshold.',
        value.measure === 'mixed' ? 'Some hypotheses are embedded and some are not — re-run embed so the whole pool is scored on one scale.' : '',
      ].filter(Boolean).join('\n') }]
    case 'priors':
      if (!value.priors?.length) return [{ type: 'text', text: `No prior feedback in this workspace matched \`${value.query.slice(0, 70)}\` (scanned ${value.scanned} other tournament(s)).` }]
      return [{ type: 'text', text: [`${value.priors.length} prior result(s) from ${value.scanned} other tournament(s) in this workspace:`, ...value.priors.map((p) => `- [${p.kind}${p.reward !== undefined ? `, reward ${p.reward}` : ''}] (${p.score}) ${p.session}/${p.hypothesis_id || '-'}: ${String(p.text).replace(/\n+/g, ' ').slice(0, 200)}`)].join('\n') }]
    case 'graph':
      return [{ type: 'text', text: [`${value.nodes} nodes / ${value.edges} edges (${value.measures.join(', ') || 'no similarity edges'}; ${value.paper_nodes} paper node(s)).`, 'Pass the mermaid block to mermaid_render for SVG, or export format:mermaid to write exports/tournament.mmd.', '', value.mermaid].join('\n') }]
    case 'limitation': {
      if (value.subaction === 'add') {
        const limitation = value.limitation
        return [{ type: 'text', text: [
          `Recorded limitation \`${limitation.id}\`: ${limitation.flaw}`,
          `Source quote verified in ${limitation.source} (${limitation.source_kind}).`,
          `Remedy families: ${limitation.opportunities.join(' · ')}`,
          `Address it with \`add addresses_limitation: ["${limitation.id}"]\`; verify sufficiency with \`limitation limitation_action: "verify"\`.`,
        ].join('\n') }]
      }
      if (value.subaction === 'verify') {
        const limitation = value.limitation
        const lines = [`\`${limitation.id}\` → ${limitation.state} at round ${value.round}/${limitation.max_rounds}.`]
        if (limitation.latest_reason) lines.push(limitation.latest_reason)
        if (value.exhausted) lines.push('The round cap is spent without a sufficient reading. This is not an acceptance: record a narrower limitation or leave the flaw open for the scientist.')
        return [{ type: 'text', text: lines.join('\n') }]
      }
      const coverage = value.coverage
      const lines = [
        `${coverage.limitations} limitation(s): ${coverage.sufficient} sufficient, ${coverage.insufficient} insufficient, ${coverage.exhausted} exhausted, ${coverage.open} open; ${coverage.covered} addressed by an active idea.`,
      ]
      if (coverage.ideas_without_limitation.length) lines.push(`Live ideas that address no limitation: ${coverage.ideas_without_limitation.join(', ')}.`)
      if (value.limitations.length) {
        lines.push('', '| id | state | rounds | addressed by | flaw |', '|---|---|---|---|---|')
        for (const limitation of value.limitations) {
          lines.push(`| ${limitation.id} | ${limitation.state} | ${limitation.rounds_used}/${limitation.max_rounds} | ${limitation.addressed_by.join(', ') || '—'} | ${String(limitation.flaw).replace(/\|/g, '\\|')} |`)
        }
        lines.push('', coverage.note)
      }
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'trace': {
      const lines = [`Read ${value.scanned} experiment ledger(s): ${value.total_runs} run(s), ${value.failed_total} failed/pruned (${value.pruned_total} with a bad verdict).`]
      if (value.unreadable?.length) lines.push(`Skipped unreadable ledger(s): ${value.unreadable.map((entry) => entry.experiment).join(', ')}.`)
      if (!value.runs.length) lines.push('No runs matched. Nothing to feed back into evolution yet.')
      for (const run of value.runs) {
        const verdict = run.verdict ? ` · verdict ${run.verdict.verdict}${run.verdict.forced ? ' (forced)' : ''}: ${run.verdict.reason}` : ''
        lines.push(`- ${run.state.toUpperCase()} ${run.experiment}/${run.run_id}: ${Object.entries(run.metrics).map(([key, metric]) => `${key}=${metric}`).join(', ') || 'no metrics'}${verdict}`)
      }
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'select': {
      const selection = value.selection
      const lines = [
        `Selected \`${selection.champion_id}\` as champion${selection.sole_survivor ? ' (sole active survivor)' : ` over ${selection.compared_ids.join(', ')}`}.`,
        `Evidence digest: ${selection.evidence_digest}`,
        '',
        '| candidate | rating | RD | novelty | correctness | testability | traces | failed |',
        '|---|---|---|---|---|---|---|---|',
        ...value.comparison.map((candidate) => `| ${candidate.id} | ${candidate.rating} | ${candidate.rd} | ${candidate.review_scores.novelty ?? '—'} | ${candidate.review_scores.correctness ?? '—'} | ${candidate.review_scores.testability ?? '—'} | ${candidate.traces.linked_runs} | ${candidate.traces.failed} |`),
        '',
        selection.rationale,
      ]
      if (value.traces.failed_total) lines.push(`${value.traces.failed_total} failed/pruned experiment trace(s) were part of the evidence.`)
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'export':
      return [{ type: 'text', text: `Wrote ${value.path} (${value.bytes} bytes).${value.format === 'mermaid' ? ' Pass it to mermaid_render for SVG.' : ''}` }]
    default: {
      const view = value.board
      const lines = [
        `Tournament \`${view.slug}\` — ${view.counts.total} hypotheses (${view.counts.active} active, ${view.counts.pendingReview} in review, ${view.counts.rejected} rejected, ${view.counts.quarantined} withheld), ${view.counts.totalMatches} matches, round ${view.rounds}/${view.step_budget}.`,
        view.termination.terminate ? `Terminated: ${view.termination.reason}.` : 'Rankings still moving — ask `next`.',
        view.limitations?.coverage?.limitations
          ? `Limitations: ${view.limitations.coverage.limitations} recorded, ${view.limitations.coverage.covered} addressed by an active idea, ${view.limitations.coverage.sufficient} sufficient, ${view.limitations.coverage.exhausted} exhausted.`
          : '',
        view.champion ? `Champion (frozen by \`select\`): \`${view.champion.id}\` — ${view.champion.title}.` : '',
        '',
        '| # | id | rating | RD | W-L-D | played | status | hypothesis |',
        '|---|---|---|---|---|---|---|---|',
        ...view.ranked.map((row) => `| ${row.rank} | ${row.id} | ${row.rating} | ${row.rd} | ${row.record} | ${row.matches_played} | ${row.status} | ${row.title.replace(/\|/g, '\\|')} |`),
        '',
        'Rating is tournament performance, not scientific merit; RD is its uncertainty. A high rating with few matches is unproven.',
      ]
      return [{ type: 'text', text: lines.join('\n') }]
    }
  }
}

/** Pure dispatch of tool arguments to the store. Exported for tests. */
export async function runCosc(args = {}, exec = {}, deps = {}) {
  const cwd = workspaceRoot(exec)
  const action = String(args.action ?? 'status').trim().toLowerCase()
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  const slug = requireSlug(args)

  if (action === 'start') {
    const protocol = {
      goal: String(args.goal ?? '').trim(),
      background: args.background,
      constraints: listParam(args.constraints),
      keywords: listParam(args.keywords),
      evaluation_criteria: listParam(args.evaluation_criteria),
      hypothesis_attributes: listParam(args.hypothesis_attributes),
      evaluation_rubric: args.evaluation_rubric,
      parsed_title: args.parsed_title,
      domain: args.domain,
      search_queries: listParam(args.search_queries),
      max_hypotheses: await settingOr('CO_SCIENTIST_MAX_HYPOTHESES', args.max_hypotheses, DEFAULT_MAX_HYPOTHESES),
      step_budget: await settingOr('CO_SCIENTIST_STEP_BUDGET', args.step_budget, DEFAULT_STEP_BUDGET),
      max_matches: finiteOrUndefined(args.max_matches),
      dup_threshold: await settingOr('CO_SCIENTIST_DUP_THRESHOLD', args.dup_threshold, undefined),
      seed: await settingOr('CO_SCIENTIST_SEED', args.seed, undefined),
    }
    const started = await startTournament({ cwd, slug, protocol, resume: Boolean(args.resume) })
    return { action, slug, protocol: started.protocol, resumed: started.resumed }
  }

  if (action === 'add') {
    const added = await addHypothesis({
      cwd,
      slug,
      strategy: String(args.strategy ?? 'generation:literature_exploration').trim(),
      round: args.round === undefined ? null : Number(args.round),
      parentIds: listParam(args.parent_ids),
      limitationIds: listParam(args.addresses_limitation),
      hypothesis: {
        title: args.title,
        summary: args.summary,
        content: args.content,
        rationale: args.rationale,
        experimental_plan: args.experimental_plan,
        novelty_assessment: args.novelty_assessment,
        key_assumptions: listParam(args.key_assumptions),
        citations: listParam(args.citations),
      },
    })
    return { action, slug, ...withoutState(added) }
  }

  if (action === 'limitation') {
    const subaction = String(args.limitation_action ?? args.subaction ?? 'status').trim().toLowerCase()
    if (!LIMITATION_ACTIONS.includes(subaction)) throw new Error(`limitation_action must be one of ${LIMITATION_ACTIONS.join(', ')}`)
    const maxRounds = await settingOr('CO_SCIENTIST_LIMITATION_ROUNDS', args.max_rounds, DEFAULT_LIMITATION_ROUNDS)
    if (subaction === 'add') {
      const added = await addLimitation({
        cwd,
        slug,
        flaw: args.flaw,
        why: args.why ?? args.limitation_why,
        opportunities: listParam(args.opportunities ?? args.opportunity),
        quote: args.quote,
        source: args.source ?? args.quote_source,
      })
      return { action, subaction, slug, ...withoutState(added) }
    }
    if (subaction === 'verify') {
      const limitationId = String(args.limitation_id ?? '').trim()
      if (!limitationId) throw new Error('limitation_id is required (e.g. l1)')
      const verified = await verifyLimitation({
        cwd,
        slug,
        id: limitationId,
        verdict: String(args.limitation_verdict ?? '').trim(),
        reason: args.limitation_reason ?? args.reason,
        maxRounds,
      })
      return { action, subaction, slug, ...withoutState(verified) }
    }
    return { action, subaction, slug, max_rounds: maxRounds, ...limitationStatus(cwd, slug, { maxRounds }) }
  }

  if (action === 'trace') {
    return {
      action,
      slug,
      ...traceExperiments({
        cwd,
        experiment: args.experiment,
        hypothesisId: args.id ? requireId(args) : null,
        limit: args.limit,
      }),
    }
  }

  if (action === 'select') {
    const selected = await selectChampion({
      cwd,
      slug,
      id: requireId(args),
      comparedIds: listParam(args.compared_ids),
      rationale: args.rationale ?? args.selection_reason ?? args.reason,
      experiment: args.experiment,
    })
    return { action, slug, ...withoutState(selected) }
  }

  if (action === 'review') {
    const recorded = await recordReview({
      cwd,
      slug,
      id: requireId(args),
      stage: String(args.stage ?? '').trim(),
      verdict: String(args.verdict ?? '').trim(),
      noveltyScore: args.novelty_score,
      correctnessScore: args.correctness_score,
      testabilityScore: args.testability_score,
      safetyFlag: Boolean(args.safety_flag),
      summary: args.summary,
      critique: args.critique,
      supportingEvidence: listParam(args.supporting_evidence),
    })
    return { action, slug, stage: String(args.stage).trim(), ...withoutState(recorded) }
  }

  if (action === 'safety') {
    const screened = await recordSafety({
      cwd,
      slug,
      id: requireId(args),
      severity: args.severity,
      category: args.category,
      reasoning: args.reasoning,
      threshold: args.threshold,
    })
    return { action, slug, assessment: screened.assessment, hypothesis: screened.hypothesis }
  }

  if (action === 'status') {
    return { action, slug, board: compactBoard(leaderboard(cwd, slug)) }
  }

  if (action === 'next') {
    const dispatched = await nextTask({ cwd, slug })
    const guide = DISPATCH[dispatched.task] || (() => '')
    // Evolution is the one task that should read the experiment record back into
    // ideation. Failed and pruned runs are the constraints the mutation must not
    // repeat, so they travel with the dispatch rather than in a separate lookup.
    const traces = dispatched.task === 'evolution'
      ? traceExperiments({ cwd, limit: 5 })
      : null
    return {
      action,
      slug,
      task: dispatched.task,
      weights: dispatched.weights,
      round: dispatched.round,
      steps_used: dispatched.steps_used,
      step_budget: dispatched.step_budget,
      matches_used: dispatched.matches_used,
      max_matches: dispatched.max_matches,
      budget_warning: dispatched.budget_warning,
      terminate: dispatched.terminate,
      reason: dispatched.reason,
      dispatch: guide(dispatched.round),
      traces: traces
        ? {
            scanned: traces.scanned,
            total_runs: traces.total_runs,
            failed_total: traces.failed_total,
            pruned_total: traces.pruned_total,
            failed: traces.failed,
            notes: traces.notes,
          }
        : null,
    }
  }

  if (action === 'set_status') {
    const changed = await setStatus({
      cwd,
      slug,
      id: requireId(args),
      status: String(args.status ?? '').trim(),
      reason: args.reason,
      overriddenBy: args.overridden_by,
    })
    return { action, slug, ...withoutState(changed) }
  }

  if (action === 'lineage') {
    return { action, slug, ...lineage(cwd, slug, requireId(args)) }
  }

  if (action === 'embed') {
    // Opt-in, because this is the only tournament call that needs a key and a
    // network round trip. Without vectors the lexical gate stays in force.
    const state = leaderboard(cwd, slug)
    const targets = state.ranked.filter((row) => row.status !== 'rejected')
    const pending = targets.filter((row) => !row.embedded)
    // Resolved before the early return so both paths report the same thing.
    const model = await resolveEmbedModel({ deps })
    if (!pending.length) return { action, slug, model, embedded: targets.length, total: targets.length, note: 'every live hypothesis already has an embedding' }
    if (pending.length > MAX_TEXTS_PER_BATCH) {
      throw new Error(`${pending.length} hypotheses to embed exceeds the ${MAX_TEXTS_PER_BATCH}-per-call batch limit`)
    }
    const texts = pending.map((row) => `${row.title}. ${row.summary}`)
    const vectors = await embedTexts(texts, { signal: exec.signal, deps })
    const byId = {}
    for (const [index, row] of pending.entries()) byId[row.id] = vectors[index]
    // Record which model produced them: a later dimension check is the only
    // thing standing between two models' vectors and a meaningless score.
    const attached = await attachVectors({ cwd, slug, vectors: byId, model })
    const sim = similarityNeighboursFor(cwd, slug)
    return { action, slug, model, ...attached, ...sim }
  }

  if (action === 'priors') {
    const board = leaderboard(cwd, slug)
    const query = String(args.query ?? '').trim() || board.goal
    const found = priorFeedback({ cwd, slug, query, limit: args.limit, minScore: args.min_score })
    return { action, slug, query, ...found }
  }

  if (action === 'graph') {
    const graph = knowledgeGraph(cwd, slug)
    return {
      action,
      slug,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      measures: graph.measures,
      paper_nodes: graph.nodes.filter((node) => node.kind === 'paper').length,
      mermaid: graph.mermaid,
      graph: { nodes: graph.nodes, edges: graph.edges },
    }
  }

  if (action === 'design_protocol') {
    const saved = await saveExperimentProtocol({ cwd, slug, id: requireId(args), steps: listParam(args.steps) })
    return { action, slug, id: requireId(args), steps: saved.steps }
  }

  if (action === 'synthesize') {
    const synthesized = await saveSynthesis({ cwd, slug, critique: args.meta_critique, overview: args.overview })
    return { action, slug, ...synthesized }
  }

  const exported = exportTournament({ cwd, slug, format: args.format, overwrite: Boolean(args.overwrite) })
  return { action, slug, format: exported.format, path: exported.path, bytes: exported.bytes }
}

export const name = 'academic-harness-coscientist'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'coscientist',
    description: [
      'Co-Scientist hypothesis tournament: generate, review, rank, and evolve candidate hypotheses with persistent state under `.dsh/coscientist/<slug>/`. Actions: `start` (goal, constraints, max_hypotheses, step_budget, max_matches, seed — defaults 5 ideas / 36 steps; `max_matches` enforces an explicit user stop bound), `add` (one hypothesis with title/summary/content plus rationale, experimental_plan, key_assumptions, citations, parent_ids, and addresses_limitation), `review` (five stages in order: initial, full, deep_verification, simulation, observation), `safety` (record a dual-use classification and apply the withhold gate), `status` (ranked leaderboard plus limitation coverage and the selected champion), `next` (which task the scheduling policy samples now; an evolution dispatch carries failed/pruned experiment traces), `set_status` (reject or withhold; a reason is required), `lineage` (parentage and diff), `embed` (opt-in Gemini embeddings that switch the duplicate gate and similarity to cosine), `priors` (what sibling tournaments in this workspace already learned about similar ideas), `graph` (Mermaid knowledge graph of lineage, similarity, claim support, prior art, and limitations), `design_protocol` (steps for the chosen hypothesis), `synthesize` (meta-review critique and research overview), `export` (markdown, json, or mermaid report), `limitation` (limitation_action add/verify/status: an append-only numbered record with a verbatim source quote span, why it limits the method, and at least two remedy families; sufficiency is binary sufficient|insufficient under a round cap), `trace` (read experiment_log runs, including failed and pruned ones, as evidence for evolution), `select` (freeze an active champion with the compared candidates and an evidence digest).',
      'The tool decides, not the model: a near-duplicate `add` is discarded with its similarity score, a cap-reached `add` is discarded, review stages are refused out of order, a `fail` at initial or full rejects the hypothesis, a `safety` severity at or above the threshold withholds it, and `next` reports when the tournament should stop (step budget, match cap, no pair left to play, Elo plateau, cap ranked). `next` never samples a task the ledger cannot execute. A limitation cannot be added without a verbatim source quote from a hypothesis or workspace file, and an `insufficient` verdict never becomes a pass; at the round cap it is reported `exhausted`. Ratings are Glicko-2 with uncertainty (RD); see the co-scientist-tournament skill for the loop.',
      'This is for a persistent, ranked, multi-round hypothesis set. For one pass of ideation use generating-scientific-hypotheses. Generated hypotheses recombine published knowledge — they are not results, and citations must be verified before use. Matches are judged with `coscientist_rank`.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ACTIONS, description: 'What to do. Default status.' },
      slug: { type: 'string', description: 'Tournament slug (letters, digits, dashes). Required for every action.' },
      goal: { type: 'string', description: 'Research goal in natural language (start). Required for a new tournament.' },
      background: { type: 'string', description: 'Context the scientist supplies (start).' },
      constraints: { type: 'array', items: { type: 'string' }, description: 'Hard constraints, e.g. ["approved drugs only"] (start).' },
      keywords: { type: 'array', items: { type: 'string' }, description: 'Domain keywords from the goal parse (start).' },
      evaluation_criteria: { type: 'array', items: { type: 'string' }, description: 'What a good hypothesis must satisfy (start).' },
      hypothesis_attributes: { type: 'array', items: { type: 'string' }, description: 'Attributes generation should target. Default Novel/Testable/Plausible/Impactful.' },
      evaluation_rubric: { type: 'string', description: 'Rubric the judges are briefed with (start).' },
      parsed_title: { type: 'string', description: 'Short title for the goal, from the goal-parse subagent (start).' },
      domain: { type: 'string', description: 'Scientific domain, from the goal-parse subagent (start).' },
      search_queries: { type: 'array', items: { type: 'string' }, description: 'Seed literature queries (start).' },
      max_hypotheses: { type: 'number', description: `Cap on hypotheses. Default ${DEFAULT_MAX_HYPOTHESES} (or CO_SCIENTIST_MAX_HYPOTHESES).` },
      step_budget: { type: 'number', description: `Cap on dispatch rounds. Default ${DEFAULT_STEP_BUDGET} (or CO_SCIENTIST_STEP_BUDGET).` },
      max_matches: { type: 'number', description: 'Stop after this many recorded matches. Use for an explicit user stop bound, e.g. one match per active pair.' },
      dup_threshold: { type: 'number', description: 'Similarity at which an `add` is discarded (default 0.7). Set 1 to disable the gate.' },
      seed: { type: 'number', description: 'Reproducible scheduling seed. Unset = non-deterministic.' },
      resume: { type: 'boolean', description: 'Continue an existing tournament instead of failing (start).' },
      title: { type: 'string', description: 'Hypothesis title (add).' },
      summary: { type: 'string', description: 'One-paragraph claim (add); the review one-liner (review).' },
      content: { type: 'string', description: 'The hypothesis stated in full, with its predictions (add).' },
      rationale: { type: 'string', description: 'Mechanism and why it is plausible (add).' },
      experimental_plan: { type: 'string', description: 'A discriminating experiment that could refute it (add).' },
      novelty_assessment: { type: 'string', description: 'What makes it distinct from published work, with the searches that checked it (add).' },
      key_assumptions: { type: 'array', items: { type: 'string' }, description: 'Load-bearing assumptions (add). Verified one by one in deep_verification.' },
      citations: { type: 'array', items: { type: 'string' }, description: 'References the hypothesis rests on (add). Unverified ones must be marked, never invented.' },
      parent_ids: { type: 'array', items: { type: 'string' }, description: 'For an evolved child: the parent hypothesis ids (add).' },
      addresses_limitation: { type: 'array', items: { type: 'string' }, description: 'Limitation ids this hypothesis addresses, e.g. ["l1"]. The limitation must already be recorded (add).' },
      strategy: { type: 'string', description: 'What produced it, e.g. generation:scientific_debate or evolution:coherence (add).' },
      round: { type: 'number', description: 'Dispatch round that produced it (add).' },
      id: { type: 'string', description: 'Hypothesis id such as h1 (review/safety/set_status/lineage/design_protocol/select). For trace, an optional filter on run params.' },
      severity: { type: 'string', enum: ['none', 'low', 'moderate', 'high'], description: 'Dual-use severity from the safety-classifier subagent (safety).' },
      category: { type: 'string', description: 'Risk label, e.g. bioweapon, chem_weapon, human_harm, dual_use, none (safety).' },
      reasoning: { type: 'string', description: 'Why that severity, about the specific idea rather than the field (safety).' },
      threshold: { type: 'string', enum: ['none', 'low', 'moderate', 'high'], description: 'Severity at or above which the hypothesis is withheld (safety). Default high.' },
      stage: { type: 'string', enum: REVIEW_STAGES, description: 'Review stage (review). Must follow the previous stage.' },
      verdict: { type: 'string', enum: VERDICTS, description: 'pass, fail, or uncertain (review).' },
      novelty_score: { type: 'number', description: '0-10 novelty (review). Omit or null when the stage does not assess it.' },
      correctness_score: { type: 'number', description: '0-10 correctness (review).' },
      testability_score: { type: 'number', description: '0-10 testability (review).' },
      safety_flag: { type: 'boolean', description: 'Set when this stage raises a dual-use or harm concern (review).' },
      critique: { type: 'string', description: 'The reviewer\'s specific objections (review).' },
      supporting_evidence: { type: 'array', items: { type: 'string' }, description: 'URLs or DOIs bearing on the verdict (review).' },
      status: { type: 'string', enum: HYPOTHESIS_STATUSES, description: 'Target status (set_status).' },
      reason: { type: 'string', description: 'Why the status changed (set_status). Required.' },
      overridden_by: { type: 'string', description: 'Who released a withheld hypothesis (set_status). Required to activate one.' },
      limitation_action: { type: 'string', enum: LIMITATION_ACTIONS, description: 'add, verify, or status for the limitation action. Default status.' },
      limitation_id: { type: 'string', description: 'Limitation id such as l1 (limitation verify).' },
      flaw: { type: 'string', description: 'The methodological flaw, quoting the offending equation or step (limitation add).' },
      why: { type: 'string', description: 'Why the flaw limits the method (limitation add).' },
      opportunities: { type: 'array', items: { type: 'string' }, description: 'At least two generic remedy families; not one chosen fix (limitation add).' },
      quote: { type: 'string', description: 'The verbatim source span the flaw is anchored to (limitation add).' },
      source: { type: 'string', description: 'Hypothesis id or workspace-relative text file containing the quote (limitation add). Verified before recording.' },
      limitation_verdict: { type: 'string', enum: LIMITATION_VERDICTS, description: 'sufficient or insufficient (limitation verify). Binary by design.' },
      limitation_reason: { type: 'string', description: 'Why this sufficiency reading (limitation verify). Required.' },
      max_rounds: { type: 'number', description: `Verification rounds one limitation may spend. Default ${DEFAULT_LIMITATION_ROUNDS} (or CO_SCIENTIST_LIMITATION_ROUNDS).` },
      compared_ids: { type: 'array', items: { type: 'string' }, description: 'Surviving candidates the champion was compared against (select). Defaults to every other active idea.' },
      rationale: { type: 'string', description: 'Why this candidate is the champion (select). Required; stored with the evidence digest.' },
      experiment: { type: 'string', description: 'Restrict traces or selection evidence to one experiment_log slug (trace/select).' },
      steps: { type: 'array', items: { type: 'string' }, description: 'Ordered protocol steps (design_protocol).' },
      meta_critique: { type: 'string', description: 'Cross-cutting critique of the set, injected into later generation (synthesize).' },
      overview: { type: 'string', description: 'Final research overview (synthesize).' },
      format: { type: 'string', enum: ['markdown', 'json', 'mermaid'], description: 'Export format (export). Default markdown. mermaid writes the tournament graph for mermaid_render.' },
      overwrite: { type: 'boolean', description: 'Replace an existing export file (export). Default false.' },
      query: { type: 'string', description: 'Text to match prior feedback against (priors). Defaults to this tournament\'s goal.' },
      limit: { type: 'number', description: 'How many priors or traces to return (priors/trace). Default 5 priors, 50 traces.' },
      min_score: { type: 'number', description: 'Minimum similarity for a prior to be worth showing (priors). Default 0.15.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderStatus(value),
    },
    async execute(args, exec) {
      try {
        return await runCosc(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      const verb = args.action || 'status'
      return { card: 'generic', title: `Tournament ${verb}: ${args.slug || ''}`, kind: 'other' }
    },
  }))
}
