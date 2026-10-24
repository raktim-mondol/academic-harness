/**
 * coscientist-rank: the tournament half of the hypothesis ledger — matchups,
 * judged matches with position-bias control, similarity, experimental feedback,
 * and match history.
 *
 * State and rating math stay in coscientist-store.js / coscientist-models.js.
 * Judging itself is done by the session (usually two subagents briefed with the
 * pair in opposite orders); this tool reconciles those verdicts and applies one
 * Glicko-2 period to both hypotheses from a single pre-match read.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  MATCH_TYPES, deriveState, matchHistory, proposeMatch, publicHypothesis,
  recordFeedback, recordMatch, similarityNeighbours,
} from './coscientist-store.js'
import { VERDICTS } from './coscientist-models.js'

const ACTIONS = ['propose', 'record', 'compare', 'similarity', 'feedback', 'history']

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function requireSlug(args) {
  const slug = String(args.slug ?? '').trim()
  if (!slug) throw new Error('slug is required')
  return slug
}

function requirePair(args) {
  const a = String(args.a ?? '').trim()
  const b = String(args.b ?? '').trim()
  if (!a || !b) throw new Error('both a and b are required (hypothesis ids)')
  return [a, b]
}

function finiteOrUndefined(value) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export async function runCoscRank(args = {}, exec = {}) {
  const cwd = workspaceRoot(exec)
  const action = String(args.action ?? 'propose').trim().toLowerCase()
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  const slug = requireSlug(args)

  if (action === 'propose') {
    const proposed = proposeMatch(cwd, slug)
    if (proposed.error) return { action, slug, ...proposed }
    return {
      action,
      slug,
      a: { id: proposed.a.id, title: proposed.a.title, rating: proposed.a.rating, rd: proposed.a.rd, matches_played: proposed.a.matches_played, summary: proposed.a.summary },
      b: { id: proposed.b.id, title: proposed.b.title, rating: proposed.b.rating, rd: proposed.b.rd, matches_played: proposed.b.matches_played, summary: proposed.b.summary },
      basis: proposed.basis,
      judge_as: proposed.judge_as,
    }
  }

  if (action === 'record') {
    const [a, b] = requirePair(args)
    const recorded = await recordMatch({
      cwd,
      slug,
      a,
      b,
      verdictAb: args.verdict_ab,
      verdictBa: args.verdict_ba,
      rationale: args.rationale,
      transcript: args.transcript,
      matchType: String(args.match_type ?? 'simple').trim(),
      round: finiteOrUndefined(args.round),
    })
    const { state, ...rest } = recorded
    return { action, slug, ...rest }
  }

  if (action === 'compare') {
    const [a, b] = requirePair(args)
    const state = deriveState(cwd, slug)
    const hypA = state.byId.get(a)
    const hypB = state.byId.get(b)
    if (!hypA || !hypB) throw new Error(`unknown hypothesis id(s): ${[a, b].filter((id) => !state.byId.get(id)).join(', ')}`)
    if (hypA.id === hypB.id) throw new Error('a hypothesis cannot be compared with itself')
    return {
      action,
      slug,
      a: publicHypothesis(hypA),
      b: publicHypothesis(hypB),
      judge_as: [
        { presentation: 'A,B', first: hypA.id, second: hypB.id },
        { presentation: 'B,A', first: hypB.id, second: hypA.id },
      ],
      note: 'Manual head-to-head. Judge both orders, then `record` with a and b in this same assignment.',
    }
  }

  if (action === 'similarity') {
    const id = String(args.id ?? '').trim()
    const view = similarityNeighbours(cwd, slug, { id: id || null })
    if (!id) return { action, slug, edges: view.edges, duplicates: view.duplicates }
    return { action, slug, id, neighbours: view.neighbours, duplicates: view.duplicates }
  }

  if (action === 'feedback') {
    const id = String(args.id ?? '').trim()
    if (!id) throw new Error('id is required (the hypothesis the result bears on)')
    const applied = await recordFeedback({
      cwd,
      slug,
      id,
      feedbackText: args.feedback_text,
      novelty: args.novelty,
      correctness: args.correctness,
      testability: args.testability,
      recordedBy: args.recorded_by,
    })
    return {
      action,
      slug,
      id,
      reward: applied.reward,
      rating_before: applied.rating_before,
      rating_after: applied.rating_after,
      rd_after: applied.rd_after,
      feedback: applied.hypothesis.feedback,
    }
  }

  const id = String(args.id ?? '').trim()
  return { action, slug, matches: matchHistory(cwd, slug, id || null) }
}

function render(value) {
  if (value?.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  switch (value.action) {
    case 'propose': {
      return [{
        type: 'text',
        text: [
          `Match \`${value.a.id}\` (rating ${value.a.rating}, RD ${value.a.rd}) vs \`${value.b.id}\` (rating ${value.b.rating}, RD ${value.b.rd}) — ${value.basis}.`,
          `Judge it twice, once per presentation order, then \`record\` with a=${value.a.id}, b=${value.b.id}, verdict_ab and verdict_ba:`,
          `  1. ${value.judge_as[0].presentation}: ${value.judge_as[0].first} presented first`,
          `  2. ${value.judge_as[1].presentation}: ${value.judge_as[1].first} presented first`,
          value.a.matches_played === 0 || value.b.matches_played === 0 ? 'At least one of these has never competed; its rating is not yet earned.' : '',
        ].filter(Boolean).join('\n'),
      }]
    }
    case 'record': {
      const lines = [`Verdict: ${value.verdict} → ${value.result}.`]
      lines.push(`  ${value.a}: ${value.rating_a.before} → ${value.rating_a.after} (RD ${value.rating_a.rd})`)
      lines.push(`  ${value.b}: ${value.rating_b.before} → ${value.rating_b.after} (RD ${value.rating_b.rd})`)
      if (value.contradictory_orientations) lines.push('Both orders named the same presented slot: that means the two judges disagreed about which hypothesis is better, so this counted as a draw. If one really won, report verdict_ab and verdict_ba as A and B.')
      else if (!value.position_controlled) lines.push('Only one presentation order was judged — position bias is not controlled for this match. Prefer both.')
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'compare':
      return [{
        type: 'text',
        text: [
          `${value.a.id}: ${value.a.title} (rating ${value.a.rating}, RD ${value.a.rd}, ${value.a.matches_played} matches)`,
          `${value.b.id}: ${value.b.title} (rating ${value.b.rating}, RD ${value.b.rd}, ${value.b.matches_played} matches)`,
          value.note,
        ].join('\n'),
      }]
    case 'similarity': {
      if (value.id) {
        if (!value.neighbours.length) return [{ type: 'text', text: `\`${value.id}\` has no similar live hypothesis at the current edge threshold.` }]
        return [{ type: 'text', text: [`Neighbours of \`${value.id}\`:`, ...value.neighbours.map((n) => `  ${n.id}: ${n.score}`)].join('\n') }]
      }
      const pairs = [...(value.duplicates || []).map((edge) => `duplicate ${edge.a}~${edge.b} ${edge.score.toFixed(3)}`), ...(value.edges || []).map((edge) => `related  ${edge.a}~${edge.b} ${edge.score.toFixed(3)}`)]
      return [{ type: 'text', text: pairs.length ? pairs.join('\n') : 'No live pair is similar enough to report.' }]
    }
    case 'feedback': {
      const moved = value.rating_after - value.rating_before
      return [{ type: 'text', text: [`Reward ${value.reward} (${value.reward > 0.33 ? 'validated' : value.reward < -0.33 ? 'refuted' : 'neutral, scored as a draw'}) against the empirical baseline.`, `\`${value.id}\`: rating ${value.rating_before} → ${value.rating_after} (${moved >= 0 ? '+' : ''}${moved}), RD ${value.rd_after}.`].join('\n') }]
    }
    default: {
      if (!value.matches?.length) return [{ type: 'text', text: 'No matches recorded yet.' }]
      const rows = value.matches.map((match) => `| ${match.a} | ${match.b} | ${match.verdict} | ${match.match_type} | ${match.position_controlled ? 'both' : 'one'} | ${match.rating_a.before}→${match.rating_a.after} / ${match.rating_b.before}→${match.rating_b.after} |`)
      return [{ type: 'text', text: ['| a | b | verdict | type | orders | ratings |', '|---|---|---|---|---|---|', ...rows].join('\n') }]
    }
  }
}

export const name = 'academic-harness-coscientist-rank'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'coscientist_rank',
    description: [
      'Rank half of the Co-Scientist hypothesis tournament (state under `.dsh/coscientist/<slug>/`). Actions: `propose` (the next matchup — the most uncertain hypothesis, ideally against a similar one), `record` (judge a pair and apply one Glicko-2 period), `compare` (manual head-to-head without recording), `similarity` (near-duplicate and related pairs, or one hypothesis\'s neighbours), `feedback` (an experimental result as a reward that moves the rating), `history` (matches played).',
      'Judging is done by the session, not this tool: run `propose`, brief subagents with the pair in BOTH presentation orders, then `record` verdict_ab (A,B order) and verdict_ba (B,A order). A verdict that flips with order is position bias and becomes a draw; one orientation alone is recorded but flagged as uncontrolled.',
      'Only active hypotheses compete. A rating is tournament performance with visible uncertainty (RD), not a measurement of scientific merit.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ACTIONS, description: 'What to do. Default propose.' },
      slug: { type: 'string', description: 'Tournament slug. Required for every action.' },
      a: { type: 'string', description: 'First hypothesis id (record/compare).' },
      b: { type: 'string', description: 'Second hypothesis id (record/compare).' },
      verdict_ab: { type: 'string', enum: VERDICTS, description: 'Which slot won in the A,B run, where a=<first id> was shown first. Required (record).' },
      verdict_ba: { type: 'string', enum: VERDICTS, description: 'Which slot won in the B,A run, where b=<second id> was shown first (record). Each verdict names a PRESENTED slot, so a genuine agreement is verdict_ab="A" with verdict_ba="B" — the same slot letter in both means the two judges disagreed, which reconciles to a draw.' },
      rationale: { type: 'string', description: 'Why the verdict, in the judge\'s words (record).' },
      transcript: { type: 'string', description: 'Workspace-relative path holding the full debate transcript (record).' },
      match_type: { type: 'string', enum: MATCH_TYPES, description: 'simple (one comparison per order) or debate (multi-round advocacy). Default simple.' },
      round: { type: 'number', description: 'Dispatch round this match belongs to (record).' },
      id: { type: 'string', description: 'Hypothesis id (similarity to scope neighbours, feedback, history).' },
      feedback_text: { type: 'string', description: 'What the experiment showed, in the scientist\'s words (feedback). Required.' },
      novelty: { type: 'number', description: '0-10 post-hoc novelty (feedback). Supply all three scores or none.' },
      correctness: { type: 'number', description: '0-10 post-hoc correctness (feedback).' },
      testability: { type: 'number', description: '0-10 post-hoc testability (feedback).' },
      recorded_by: { type: 'string', description: 'Who supplied the result (feedback). Default user.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      try {
        return await runCoscRank(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      const verb = args.action || 'propose'
      return { card: 'generic', title: `Tournament rank ${verb}: ${args.slug || ''}`, kind: 'other' }
    },
  }))
}
