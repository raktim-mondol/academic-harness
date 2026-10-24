import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyTournament, runCosc } from '../coscientist.js'
import { apply as applyRank, runCoscRank } from '../coscientist-rank.js'
import { attachVectors, addHypothesis, proposeMatch, recordFeedback, recordProvenance, startTournament } from '../coscientist-store.js'

const cwd = mkdtempSync(join(tmpdir(), 'ah-cosc-tool-'))
const exec = { agent: { session: { header: { cwd } } } }
const slug = 'tool-demo'

const tools = new Map()
for (const apply of [applyTournament, applyRank]) {
  apply({ tools: { register: (tool) => tools.set(tool.name, tool) } })
}
const tournament = tools.get('coscientist')
const rank = tools.get('coscientist_rank')

// Lexically distinct claims: the duplicate gate must not fire on these.
const CLAIMS = [
  {
    title: 'R-loop resolution failure at TDP-43 loci initiates motor neuron degeneration',
    summary: 'Unresolved R-loops at TDP-43 intronic loci trigger transcriptional collapse before any protein aggregation.',
    content: 'Predicts that resolving R-loops pharmacologically preserves motor neuron viability even when TDP-43 is mislocalized.',
    rationale: 'R-loop accumulation blocks elongation at long introns, and TDP-43 loss de-regulates exactly those loci.',
    experimental_plan: 'Long-read RNA-seq plus DRIP-qPCR in iPSC motor neurons treated with an RNase H1 overexpression construct.',
    key_assumptions: ['R-loops form at TDP-43 intronic loci in patient neurons', 'Their removal is not merely correlative'],
    citations: ['Bosco 2020 eLife'],
  },
  {
    title: 'Mitochondrial fission asymmetry, not aggregation, drives distal axon loss',
    summary: 'Uneven division of mitochondria starves the distal axon arbor while the soma stays bioenergetically normal.',
    content: 'Predicts that normalising fission dynamics rescues axon caliber independently of TDP-43 state.',
    rationale: 'Axon retraction begins at the most distal mitochondria-poor segments in live imaging models.',
    experimental_plan: 'Mito-DYNAMO imaging in microfluidic chambers with a formin inhibitor at the distal compartment.',
    key_assumptions: ['Distal segments are energy-limited first', 'Fission asymmetry is causal'],
    citations: ['Mancuso 2019 Cell Metab'],
  },
  {
    title: 'Astrocytic lactate shuttle failure is the primary rate-limiting step',
    summary: 'Mutant neurons are fine until astrocytes stop delivering lactate; the energy substrate, not the lesion, kills.',
    content: 'Predicts that exogenous lactate or MCT1 agonism delays degeneration more than any neuronal-targeted therapy.',
    rationale: 'Motor neurons rely on astrocyte-derived lactate at long axons where glycolysis is insufficient.',
    experimental_plan: 'Astrocyte-neuron co-culture with MCT1/MCT4 knockdown and 13C-lactate tracing.',
    key_assumptions: ['Lactate transfer is rate-limiting in vivo', 'MCT1 agonists reach CNS'],
    citations: [],
  },
  {
    title: 'Intronic cryptic splice sites create a toxic gain-of-function peptide',
    summary: 'A cryptic exon in an unrelated RNA-binding gene yields a short peptide that disrupts ribostasis.',
    content: 'Predicts an anti-cryptic-peptide antibody reduces toxicity without changing splicing at TDP-43.',
    rationale: 'Cryptic exons are translated in frame and the resulting peptides aggregate with ribosomal RNA.',
    experimental_plan: 'Mass-spec immunoprecipitation of the cryptic peptide, then passive immunisation in SOD1/TDP-43 mice.',
    key_assumptions: ['The cryptic peptide reaches detectable levels', 'It is extracellularly accessible'],
    citations: ['Ling 2022 Science'],
  },
  {
    title: 'Nuclear pore density, not transport cargo, is the failing variable',
    summary: 'Loss of nuclear pore complexes at the axon initial segment, rather than TDP-43 mislocation itself, correlates with onset.',
    content: 'Predicts that boosting pore assembly delays onset even with persistent cytoplasmic TDP-43.',
    rationale: 'Pore density falls before mislocalisation in staged tissue sections.',
    experimental_plan: 'Nup358 overexpression with titration of cytoplasmic TDP-43, read by onset in a knock-in mouse.',
    key_assumptions: ['Pore loss precedes mislocalisation', 'Pore assembly is druggable'],
    citations: [],
  },
  {
    title: 'Clonal haematopoiesis-derived microglia set the disease tempo',
    summary: 'Age-related somatic mutation in myeloid progenitors, not the neuron, determines how fast degeneration proceeds.',
    content: 'Predicts that microglia with DNMT3A clonal variants accelerate decline in the same neuronal genotype.',
    rationale: 'Disease tempo varies at fixed neuronal genotype, and myeloid clone size tracks with progression rate.',
    experimental_plan: 'Bone-marrow chimeras with CRISPR-edited DNMT3A clones, longitudinal OCT and survival readouts.',
    key_assumptions: ['Clone size is measurable in CNS myeloid cells', 'Neuronal genotype is held constant'],
    citations: ['Bick 2023 Nature'],
  },
]

const text = (blocks) => blocks.map((block) => block.text).join('\n')
// defineTool keeps the render hook on `output.render(args, value)`.
const renderOf = (tool) => (value) => tool.output.render({}, value)
const renderTournament = renderOf(tournament)
const renderRank = renderOf(rank)
const proposeMatchFor = (target) => proposeMatch(cwd, target).error

try {
  // ── registration surface ───────────────────────────────────────────────────
  // defineTool compiles `parameters` into a JSON Schema object.
  const tournamentParams = tournament.parameters.properties
  const rankParams = rank.parameters.properties
  assert.equal(tournament.name, 'coscientist')
  assert.equal(rank.name, 'coscientist_rank')
  assert.match(tournament.description, /position|duplicate|cap/)
  assert.match(rank.description, /BOTH presentation orders/)
  assert.ok(Object.keys(tournamentParams).length > 20, 'the tournament tool must expose the whole surface')
  assert.equal(tournamentParams.stage.enum.length, 5)
  assert.equal(tournamentParams.action.enum.length, 14)
  assert.equal(rankParams.action.enum.length, 6)
  assert.deepEqual(rankParams.verdict_ab.enum, ['A', 'B', 'draw'])
  assert.deepEqual(tournamentParams.constraints.items.type, 'string')
  assert.match(tournamentParams.slug.description, /Required/)

  // ── bad arguments ──────────────────────────────────────────────────────────
  // Enum-constrained fields are rejected by the schema validator before the tool
  // body runs; every other rejection comes back in band as { error }.
  let result = await tournament.execute({ action: 'status', slug }, exec)
  assert.match(result.error, /has not been started/)
  await assert.rejects(() => tournament.execute({ action: 'bogus', slug }, exec), /must be one of/)
  result = await tournament.execute({ action: 'start' }, exec)
  assert.match(result.error, /slug is required/)
  result = await tournament.execute({ action: 'start', slug, background: 'x' }, exec)
  assert.match(result.error, /goal is required/)
  await assert.rejects(() => runCosc({ action: 'nope', slug }, exec), /action must be one of/)

  // ── a full tournament, driven through the tool surface only ────────────────
  const started = await tournament.execute({
    action: 'start',
    slug,
    goal: 'What initiates motor neuron degeneration in ALS?',
    constraints: ['primary human neurons or human data', 'no primate work'],
    max_hypotheses: 6,
    step_budget: 400,
    seed: 42,
    evaluation_rubric: 'Novelty, correctness, testability.',
  }, exec)
  assert.equal(started.resumed, false)
  assert.match(text(renderTournament(started)), /Started tournament/)
  assert.match(text(renderTournament(started)), /Budget: 6 hypotheses/)

  // Fill the pool, then let the policy run the loop. The first claim goes in
  // alone so the duplicate gate can be shown before the cap starts answering.
  const firstClaim = await tournament.execute({
    action: 'add', slug, strategy: 'generation:literature_exploration', round: 1, ...CLAIMS[0],
  }, exec)
  assert.equal(firstClaim.hypothesis.id, 'h1')

  const dupe = await tournament.execute({
    action: 'add',
    slug,
    title: CLAIMS[0].title,
    summary: CLAIMS[0].summary,
    content: CLAIMS[0].content,
  }, exec)
  assert.equal(dupe.discarded.reason, 'near_duplicate')
  assert.match(text(renderTournament(dupe)), /near-duplicate of `h1`/)

  for (const claim of CLAIMS.slice(1)) {
    const added = await tournament.execute({ action: 'add', slug, strategy: 'generation:literature_exploration', round: 1, ...claim }, exec)
    assert.equal(added.discarded, undefined, `unexpected discard: ${JSON.stringify(added.discarded)}`)
  }

  const overCap = await tournament.execute({
    action: 'add', slug, title: 'A seventh, quite different idea about periastrin dysregulation',
    summary: 'Periastrin calcium buffering failure in ALS proximal axons.',
    content: 'Predicts buffering loss precedes mitochondrial fragmentation.',
  }, exec)
  assert.equal(overCap.discarded.reason, 'hypothesis_cap')

  let outOfOrder = await tournament.execute({ action: 'review', slug, id: 'h1', stage: 'simulation', verdict: 'pass' }, exec)
  assert.match(outOfOrder.error, /requires "deep_verification"/)

  const stages = ['initial', 'full', 'deep_verification', 'simulation', 'observation']
  const scoreCard = { novelty_score: 7, correctness_score: 8, testability_score: 6 }

  // h6 is vetoed at the first stage, so it never reaches a debate.
  const vetoed = await tournament.execute({
    action: 'review', slug, id: 'h6', stage: 'initial', verdict: 'fail',
    summary: 'restates a published result', critique: 'The lactate shuttle claim is already established.',
  }, exec)
  assert.equal(vetoed.status, 'rejected')
  assert.match(text(renderTournament(vetoed)), /Rejected/)

  for (const id of ['h1', 'h2', 'h3', 'h4', 'h5']) {
    for (const stage of stages) {
      const recorded = await tournament.execute({
        action: 'review', slug, id, stage, verdict: 'pass', ...scoreCard,
        summary: `${stage} looks sound`, critique: `Stage ${stage}: mechanism is coherent, test is feasible.`,
      }, exec)
      assert.equal(recorded.error, undefined, `${id}/${stage}: ${recorded.error}`)
      if (stage === 'observation') assert.equal(recorded.status, 'active')
    }
  }

  // Now run the policy loop to completion.
  let rounds = 0
  let terminate = null
  const seenTasks = new Set()
  while (rounds < 400) {
    const next = await tournament.execute({ action: 'next', slug }, exec)
    assert.equal(next.error, undefined, next.error)
    rounds += 1
    seenTasks.add(next.task)
    if (next.terminate) { terminate = next.reason; break }

    if (next.task === 'reflection') {
      const board = await tournament.execute({ action: 'status', slug }, exec)
      const target = board.board.ranked.find((row) => row.status === 'pending_review')
      if (target) {
        const remaining = stages.filter((stage) => !target.reviews.includes(stage))
        for (const stage of remaining) {
          await tournament.execute({ action: 'review', slug, id: target.id, stage, verdict: 'pass', ...scoreCard }, exec)
        }
      }
      continue
    }

    if (next.task === 'ranking') {
      const proposed = await rank.execute({ action: 'propose', slug }, exec)
      if (proposed.error) continue
      // Alternate which side wins so the tournament is not rigged toward one pole.
      // A real winner is reported as opposite slot letters, because each verdict
      // names the slot presented first in that run (agreement is A + B).
      const winner = rounds % 2 === 0 ? 'A' : 'B'
      const agreed = { A: 'B', B: 'A' }[winner]
      const recorded = await rank.execute({
        action: 'record', slug, a: proposed.a.id, b: proposed.b.id,
        verdict_ab: winner, verdict_ba: agreed, match_type: 'simple', round: next.round,
        rationale: `Judged in both orders: ${winner} is more novel and better testable.`,
      }, exec)
      assert.equal(recorded.error, undefined, recorded.error)
      assert.equal(recorded.position_controlled, true)
      assert.notEqual(recorded.verdict, 'draw', 'a pair of agreeing verdicts must not resolve to a draw')
      continue
    }

    if (next.task === 'evolution') {
      const board = await tournament.execute({ action: 'status', slug }, exec)
      const top = board.board.ranked.find((row) => row.status === 'active')
      if (top) {
        const evolved = await tournament.execute({
          action: 'add', slug, parent_ids: [top.id], strategy: 'evolution:coherence', round: next.round,
          title: `Coherence edit of ${top.id}: same mechanism, one assumption made explicit`,
          summary: `Rewrites ${top.id} so the load-bearing assumption is testable on its own.`,
          content: 'Predicts the narrower claim survives a targeted perturbation.',
        }, exec)
        if (evolved.discarded) assert.equal(evolved.discarded.reason, 'hypothesis_cap')
      }
      continue
    }

    if (next.task === 'proximity') {
      const sim = await rank.execute({ action: 'similarity', slug }, exec)
      assert.equal(sim.error, undefined)
      continue
    }

    if (next.task === 'meta_review') {
      const synthesized = await tournament.execute({
        action: 'synthesize', slug, meta_critique: 'Every candidate assumes the neuron, not the support cells, is the failing unit.',
      }, exec)
      assert.match(synthesized.critique, /support cells/)
      continue
    }

    if (next.task === 'generation') {
      // The pool is at cap, so the policy should stop asking for generation.
      assert.fail('a capped tournament must not sample generation')
    }
  }

  assert.ok(terminate, `the loop must reach termination (ran ${rounds} rounds)`)
  // A uniform synthetic pool converges on the Elo plateau; a pool that finishes
  // its matches inside 20 samples stops on the cap rule instead. Either is the
  // policy working — the specific reason is unit-tested in test-coscientist-models.
  assert.ok(['elo_plateau', 'cap_reached_and_ranked'].includes(terminate), `unexpected termination: ${terminate}`)
  assert.ok(seenTasks.has('ranking'), 'a tournament with active hypotheses must sample ranking')

  const final = await tournament.execute({ action: 'status', slug }, exec)
  const boardView = final.board
  assert.equal(boardView.counts.total, 6)
  assert.equal(boardView.counts.active, 5, 'the vetoed hypothesis stays out')
  assert.equal(boardView.counts.rejected, 1)
  assert.equal(boardView.counts.pendingReview, 0)
  assert.ok(boardView.counts.totalMatches >= 10, `${boardView.counts.totalMatches} matches recorded`)
  assert.ok(boardView.ranked.length >= 5)
  assert.ok(new Set(boardView.ranked.map((row) => row.rating)).size > 1, 'the matches must actually separate the pool')
  assert.ok(boardView.ranked.some((row) => row.matches_played > 0), 'at least one hypothesis competed')
  const renderedBoard = text(renderTournament(final))
  assert.match(renderedBoard, /\| # \| id \| rating \| RD \| W-L-D \| played \| status \| hypothesis \|/)
  assert.match(renderedBoard, /Rating is tournament performance, not scientific merit/)

  // Ratings must be strictly the product of recorded matches and feedback.
  const history = await rank.execute({ action: 'history', slug }, exec)
  assert.ok(history.matches.length >= 10, `only ${history.matches.length} matches recorded`)
  assert.ok(history.matches.every((match) => match.position_controlled), 'the loop judged both orders every time')
  assert.match(text(renderRank(history)), /\| a \| b \| verdict \| type \| orders \| ratings \|/)

  const moved = await rank.execute({
    action: 'feedback', slug, id: boardView.ranked[0].id,
    feedback_text: 'The perturbation confirmed the prediction and the effect was robust and reproducible across lines.',
    novelty: 10, correctness: 10, testability: 10, recorded_by: 'wet-lab',
  }, exec)
  assert.ok(moved.rating_after > moved.rating_before, `validated hypothesis should rise, got ${moved.rating_before} → ${moved.rating_after}`)
  assert.match(text(renderRank(moved)), /validated/)

  const lineageView = await tournament.execute({ action: 'lineage', slug, id: 'h1' }, exec)
  assert.ok(Array.isArray(lineageView.children))
  assert.match(text(renderTournament(lineageView)), /Parents: .* · Children:/)

  const design = await tournament.execute({
    action: 'design_protocol', slug, id: boardView.ranked[0].id,
    steps: ['Primary human motor neurons with the candidate genotype', 'Perturb the load-bearing assumption only', 'Read the predicted discriminator'],
  }, exec)
  assert.equal(design.steps, 3)

  const exported = await tournament.execute({ action: 'export', slug, format: 'markdown' }, exec)
  assert.equal(exported.error, undefined, exported.error)
  assert.ok(existsSync(join(cwd, exported.path)))
  const markdown = readFileSync(join(cwd, exported.path), 'utf8')
  assert.match(markdown, /# Hypothesis tournament: /)
  assert.match(markdown, /cap reached|budget|Termination:/)
  assert.match(markdown, /Primary human motor neurons with the candidate genotype/)

  const asJson = await tournament.execute({ action: 'export', slug, format: 'json' }, exec)
  assert.equal(asJson.error, undefined, asJson.error)
  assert.match(asJson.path, /tournament\.json$/)

  // ── resume: a fresh process sees the same ratings ──────────────────────────
  const reopened = await runCosc({ action: 'status', slug }, { agent: { session: { header: { cwd } } } })
  assert.deepEqual(reopened.board.ranked.map((row) => `${row.id}:${row.rating}`), (await runCosc({ action: 'status', slug }, { agent: { session: { header: { cwd } } } })).board.ranked.map((row) => `${row.id}:${row.rating}`))
  assert.ok(reopened.board.ranked.some((row) => row.matches_played > 0))

  // ── the safety gate runs in code, not in prose ─────────────────────────────
  const cleared = await tournament.execute({
    action: 'safety', slug, id: 'h4', severity: 'low', category: 'dual_use',
    reasoning: 'Sensitive agent, but the protocol adds no actionable uplift.', threshold: 'high',
  }, exec)
  assert.equal(cleared.assessment.decision, 'allowed')
  assert.equal(cleared.hypothesis.status, 'active', 'a below-threshold screen changes nothing')
  assert.match(text(renderTournament(cleared)), /severity low → allowed/)

  const flagged = await tournament.execute({
    action: 'safety', slug, id: 'h5', severity: 'high', category: 'bioweapon',
    reasoning: 'Describes enhancement that would increase transmissibility of a vertebrate pathogen.',
  }, exec)
  assert.equal(flagged.assessment.decision, 'quarantined')
  assert.equal(flagged.hypothesis.status, 'quarantined')
  assert.match(text(renderTournament(flagged)), /Only the user can release it/)
  const reviewAfterWithhold = await tournament.execute({ action: 'review', slug, id: 'h5', stage: 'initial', verdict: 'pass' }, exec)
  assert.match(reviewAfterWithhold.error, /quarantined; release it/)
  await assert.rejects(() => tournament.execute({ action: 'safety', slug, id: 'h5', severity: 'high', threshold: 'extreme' }, exec), /"threshold" must be one of/)
  await assert.rejects(() => tournament.execute({ action: 'safety', slug, id: 'h5', severity: 'catastrophic' }, exec), /"severity" must be one of/)
  // The store validates too, so a script calling the dispatcher is covered as well.
  await assert.rejects(() => runCosc({ action: 'safety', slug, id: 'h5', severity: 'high', threshold: 'extreme' }, exec), /threshold must be one of/)
  const releasedByUser = await tournament.execute({
    action: 'set_status', slug, id: 'h5', status: 'active',
    reason: 'Institutional biosafety review cleared the protocol', overridden_by: 'biosafety-committee',
  }, exec)
  assert.equal(releasedByUser.hypothesis.status, 'active')
  assert.equal(releasedByUser.hypothesis.safety.released_by, 'biosafety-committee')

  // ── withholding needs a human release ─────────────────────────────────────
  const withheld = await tournament.execute({
    action: 'set_status', slug, id: 'h2', status: 'quarantined',
    reason: 'Gain-of-function elements flagged by the safety screen',
  }, exec)
  assert.equal(withheld.hypothesis.status, 'quarantined')
  const refused = await rank.execute({ action: 'propose', slug }, exec)
  assert.equal(refused.error ? false : true, true)
  if (!refused.error) {
    assert.notEqual(refused.a.id, 'h2')
    assert.notEqual(refused.b.id, 'h2')
  }
  const blocked = await tournament.execute({ action: 'set_status', slug, id: 'h2', status: 'active', reason: 'fine now' }, exec)
  assert.match(blocked.error, /requires overridden_by/)
  const released = await tournament.execute({
    action: 'set_status', slug, id: 'h2', status: 'active',
    reason: 'Institutional biosafety review cleared the protocol', overridden_by: 'biosafety-committee',
  }, exec)
  assert.equal(released.error, undefined, released.error)
  assert.equal(released.hypothesis.status, 'active')

  // A withheld hypothesis cannot be matched while it is withheld.
  await tournament.execute({ action: 'set_status', slug, id: 'h3', status: 'quarantined', reason: 'pending biosafety review' }, exec)
  const whileWithheld = await rank.execute({
    action: 'record', slug, a: 'h1', b: 'h3', verdict_ab: 'A', rationale: 'should be refused',
  }, exec)
  assert.match(whileWithheld.error, /is quarantined; only active hypotheses compete/)

  // ── the rank tool refuses bad input ────────────────────────────────────────
  await assert.rejects(() => rank.execute({ action: 'record', slug, a: 'h1', b: 'h2', verdict_ab: 'first' }, exec), /must be one of/)
  await assert.rejects(() => runCoscRank({ action: 'record', slug, a: 'h1', b: 'h2', verdict_ab: 'first' }, exec), /must each be A, B, or draw/)
  const selfMatch = await rank.execute({ action: 'record', slug, a: 'h1', b: 'h1', verdict_ab: 'A' }, exec)
  assert.match(selfMatch.error, /itself/)
  const missingPair = await rank.execute({ action: 'compare', slug, a: 'h1' }, exec)
  assert.match(missingPair.error, /both a and b are required/)
  const noSlug = await rank.execute({ action: 'propose' }, exec)
  assert.match(noSlug.error, /slug is required/)

  const positionDriven = await rank.execute({
    action: 'record', slug, a: 'h1', b: 'h2', verdict_ab: 'A', verdict_ba: 'A',
    rationale: 'each order favoured whoever was shown first',
  }, exec)
  assert.equal(positionDriven.verdict, 'draw', 'a verdict that tracks presentation order is a draw')
  assert.equal(positionDriven.contradictory_orientations, true)
  assert.match(text(renderRank(positionDriven)), /counted as a draw/)

  const presented = await rank.execute({ action: 'compare', slug, a: 'h1', b: 'h2' }, exec)
  assert.equal(presented.judge_as.length, 2)
  assert.match(text(renderRank(presented)), /Manual head-to-head/)

  const scopeNeighbours = await rank.execute({ action: 'similarity', slug, id: 'h1' }, exec)
  assert.ok(Array.isArray(scopeNeighbours.neighbours))

  // ── a default pool too small to compete stops at once, not at the budget ───
  const stalled = 'stalled-pool'
  const stalledStart = await runCosc({
    action: 'start', slug: stalled, goal: 'What drives the recurrent DNA-damage signal in these lines?',
    max_hypotheses: 3, step_budget: 24,
  }, exec)
  // Explicit small caps here: the stall this exercises needs a pool that can be
  // emptied by vetoes, which the 5/36 default deliberately is not.
  assert.equal(stalledStart.protocol.max_hypotheses, 3)
  assert.equal(stalledStart.protocol.step_budget, 24)
  assert.match(text(renderTournament(stalledStart)), /Budget: 3 hypotheses, 24 steps/)
  for (const [index, claim] of [
    ['Ribosomal stalling at short uORFs gates the stress-granule response', 'A uORF-level stall limits granule assembly after arsenite.'],
    ['Lysosomal pH setpoints decide which aggregates are cleared first', 'Clearing order follows a lumenal pH threshold rather than aggregate size.'],
    ['Nuclear envelope rupture cycles drive the observed DNA damage signal', 'Recurrent rupture, not persistent damage, produces the cGAS-STING readout.'],
  ].entries()) {
    const added = await runCosc({ action: 'add', slug: stalled, title: claim[0], summary: claim[1], content: `Claim ${index}.` }, exec)
    assert.equal(added.discarded, undefined)
    if (index > 0) {
      const veto = await runCosc({ action: 'review', slug: stalled, id: added.hypothesis.id, stage: 'initial', verdict: 'fail', critique: 'published verbatim last year' }, exec)
      assert.equal(veto.status, 'rejected')
    } else {
      for (const stage of ['initial', 'full', 'deep_verification', 'simulation', 'observation']) {
        await runCosc({ action: 'review', slug: stalled, id: added.hypothesis.id, stage, verdict: 'pass', novelty_score: 6, correctness_score: 6, testability_score: 6 }, exec)
      }
    }
  }
  let stalledOut = null
  for (let i = 0; i < 24 && !stalledOut; i += 1) {
    const dispatched = await runCosc({ action: 'next', slug: stalled }, exec)
    if (dispatched.terminate) stalledOut = dispatched
  }
  assert.ok(stalledOut, 'a one-competitor pool must stop on its own')
  assert.equal(stalledOut.reason, 'no_competitors')
  assert.ok(stalledOut.steps_used < 6, `it should stop early, used ${stalledOut.steps_used} of 24 steps`)
  // And the shipped defaults do not stall on the same shape: five ideas with two
  // losses left standing keep competing.
  const survived = await runCosc({ action: 'start', slug: 'survivor', goal: 'How do cells buffer proteotoxic load?' }, exec)
  assert.equal(survived.protocol.max_hypotheses, 5, 'the default pool absorbs two losses without stalling')
  assert.equal(survived.protocol.step_budget, 36)
  assert.match(text(renderTournament(survived)), /Budget: 5 hypotheses, 36 steps/)
  // Which task happens to be sampled at that dispatch is random; what must hold
  // either way is that the policy reports the stop alongside it, and that no
  // further generation is possible at cap.
  assert.equal(stalledOut.weights.generation, 0, 'a full pool must not sample generation')
  assert.ok(['ranking', 'evolution', 'reflection', 'proximity', 'meta_review'].includes(stalledOut.task))
  assert.match(text(renderTournament(stalledOut)), /STOP: no_competitors/)
  const stalledBoard = (await runCosc({ action: 'status', slug: stalled }, exec)).board
  assert.deepEqual([stalledBoard.counts.active, stalledBoard.counts.rejected], [1, 2])
  assert.equal(stalledBoard.termination.reason, 'no_competitors')
  assert.match(proposeMatchFor(stalled), /at least 2 active hypotheses/)

  // ── an empty tournament refuses to match, and a tiny budget stops early ────
  const thin = await rank.execute({ action: 'propose', slug: 'never' }, exec)
  assert.match(thin.error, /has not been started/)
  await tournament.execute({ action: 'start', slug: 'brief', goal: 'termination guard', step_budget: 12, seed: 5 }, exec)
  let briefTerminated = null
  for (let i = 0; i < 20 && !briefTerminated; i += 1) {
    const dispatched = await tournament.execute({ action: 'next', slug: 'brief' }, exec)
    if (dispatched.terminate) briefTerminated = dispatched.reason
  }
  assert.equal(briefTerminated, 'budget_exhausted')

  // ── Phase 4: embeddings, priors, graph ────────────────────────────────────
  const p4 = 'phase4'
  await tournament.execute({ action: 'start', slug: p4, goal: 'How do stressed cells protect their proteome?', max_hypotheses: 5 }, { agent: { session: { header: { cwd } } } })
  const embedExec = { agent: { session: { header: { cwd } } }, signal: undefined }
  const made = []
  for (const [index, title] of [
    'Chaperone-mediated triage decides which misfolded proteins get degraded',
    'Proteasome gating by phosphorylation sets the degradation rate under stress',
    'Poly(ADP-ribose) scaffolds recruit repair teams to stalled transcription sites',
    'Lipid-bilayer tension recruits the same chaperones to degraded membrane folds',
  ].entries()) {
    const added = await tournament.execute({
      action: 'add', slug: p4, strategy: 'generation:assumption_chaining',
      title, summary: `Distinct mechanism ${index}: the cell handles proteotoxic stress this way and not that way.`,
      content: `Claim ${index} with its own predictions.`,
    }, embedExec)
    assert.equal(added.discarded, undefined)
    made.push(added.hypothesis.id)
  }

  // One embedding model for the whole tournament: identical vectors for two
  // lexically distinct ideas proves the gate switched scale.
  // The four vectors below are chosen so embedding visibly changes the answer:
  // idea 4 is a near-copy of idea 1 in cosine yet nothing like it in wording, so
  // the lexical gate passed it and cosine must catch it.
  const POOL_VECTORS = [[1, 0, 0], [0.8, 0.6, 0], [0, 1, 0], [0.999, 0.04, 0]]
  const fakeEmbed = {
    fetchJson: async (url, options) => {
      const body = JSON.parse(options.body)
      assert.equal(url.includes('?key='), false, 'the key must never travel in the URL')
      assert.equal(options.headers['x-goog-api-key'], 'test-key')
      assert.match(url, /:batchEmbedContents$/)
      assert.equal(body.requests[0].taskType, 'SEMANTIC_SIMILARITY', 'comparing like with like')
      return { ok: true, status: 200, data: { embeddings: body.requests.map((request, index) => ({ values: POOL_VECTORS[index] })) } }
    },
    getLimiter: () => ({ run: (fn) => fn() }),
    resolveEnv: async (field) => (field === 'GEMINI_API_KEY' ? 'test-key' : ''),
  }
  process.env.GEMINI_API_KEY = 'test-key'
  const embedded = await runCosc({ action: 'embed', slug: p4 }, embedExec, fakeEmbed)
  delete process.env.GEMINI_API_KEY
  assert.equal(embedded.embedded, 4)
  assert.equal(embedded.dimensions, 3)
  assert.match(embedded.model, /text-embedding/)
  assert.equal(embedded.measure, 'vector', 'an embedded pool reports the cosine measure')
  assert.equal(embedded.duplicates.length, 1, `cosine should catch what lexical missed: ${JSON.stringify(embedded.duplicates)}`)
  assert.deepEqual([embedded.duplicates[0].a, embedded.duplicates[0].b], [made[0], made[3]])
  assert.equal(embedded.duplicates[0].threshold, 0.92, 'the gate moved to the cosine threshold without reconfiguring')
  assert.ok(embedded.duplicates[0].score > 0.99)
  assert.ok(embedded.related.some((pair) => pair.score > 0.75 && pair.score < 0.92), 'a genuinely related pair stays an edge, not a duplicate')
  assert.match(text(renderTournament(embedded)), /Duplicate pairs at the current threshold/)

  // A partially embedded pool must say so rather than blending two scales.
  const partial = await startTournament({ cwd, slug: 'partial', protocol: { goal: 'mixed pool', max_hypotheses: 3 } })
  assert.equal(partial.protocol.slug, 'partial')
  const one = await addHypothesis({ cwd, slug: 'partial', hypothesis: { title: 'First idea with its own wording here', summary: 'A mechanism unlike the others in this ledger.', content: 'Claim one.' } })
  const two = await addHypothesis({ cwd, slug: 'partial', hypothesis: { title: 'Second idea with different wording', summary: 'Another mechanism that stands on its own here.', content: 'Claim two.' } })
  await attachVectors({ cwd, slug: 'partial', vectors: { [one.hypothesis.id]: [1, 0, 0] } })
  const mixed = await rank.execute({ action: 'similarity', slug: 'partial' }, embedExec)
  assert.equal(mixed.edges.length, 0, 'a cross-scale pair never becomes a vector comparison')
  assert.deepEqual(mixed.duplicates, [])
  await assert.rejects(
    () => attachVectors({ cwd, slug: 'partial', vectors: { [two.hypothesis.id]: [1, 0] } }),
    /mixed embedding dimensions/,
    'two models in one tournament is refused, not silently mixed',
  )

  // The model named in the ledger is the one the call actually used — an
  // override must not be reported as the default.
  process.env.GEMINI_API_KEY = 'test-key'
  process.env.CO_SCIENTIST_EMBED_MODEL = 'gemini-embedding-001'
  const reembedded = await runCosc({ action: 'embed', slug: 'partial' }, embedExec, {
    fetchJson: async (url) => {
      assert.match(url, /gemini-embedding-001:batchEmbedContents$/)
      return { ok: true, status: 200, data: { embeddings: [{ values: [0, 0, 1] }] } }
    },
    getLimiter: () => ({ run: (fn) => fn() }),
    resolveEnv: async (field) => (field === 'GEMINI_API_KEY' ? 'test-key' : field === 'CO_SCIENTIST_EMBED_MODEL' ? 'gemini-embedding-001' : ''),
  })
  delete process.env.GEMINI_API_KEY
  delete process.env.CO_SCIENTIST_EMBED_MODEL
  assert.match(reembedded.model, /gemini-embedding-001/, 'the ledger names the model that produced the vectors')
  assert.equal(reembedded.embedded, 2, 'the missing hypothesis is now embedded')
  assert.equal(reembedded.measure, 'vector', 'the pool is no longer mixed')
  assert.equal(reembedded.live_embedded, 2)


  // Priors come out of sibling tournaments in the same workspace.
  await recordFeedback({
    cwd, slug: 'phase4', id: made[0],
    feedbackText: 'The chaperone triage prediction was refuted: the assay failed and did not replicate.',
    recordedBy: 'wet-lab',
  })
  const priors = await tournament.execute({ action: 'priors', slug: 'partial', query: 'chaperone triage of misfolded proteins under stress' }, embedExec)
  assert.ok(priors.scanned >= 1, 'the sibling ledger was scanned')
  assert.ok(priors.priors.length >= 1, `no prior surfaced: ${JSON.stringify(priors)}`)
  assert.equal(priors.priors[0].kind, 'feedback')
  assert.ok(priors.priors[0].reward < -0.33)
  assert.equal(priors.priors[0].session, 'phase4')
  assert.match(text(renderTournament(priors)), /prior result/)
  const none = await tournament.execute({ action: 'priors', slug: 'phase4', query: 'deep-sea sediment thermohaline circulation' }, embedExec)
  assert.deepEqual(none.priors.filter((prior) => prior.session === 'phase4'), [], 'a tournament never cites itself')

  // The graph is built from the ledger only, and survives hostile labels.
  await recordProvenance({
    cwd, slug: 'phase4', id: made[1],
    claims: [{ claim: 'Phosphorylation gates the proteasome', support: 'supports', confidence: 0.7, paper_title: 'Proteasome gating [in] vivo', paper_doi: '10.1000/gate' },
      { claim: 'Rate is set by substrate supply', support: 'contradicts', confidence: 0.6, paper_title: 'Substrate supply and degradation', paper_doi: '10.1000/supply' }],
  })
  const graphed = await tournament.execute({ action: 'graph', slug: 'phase4' }, embedExec)
  assert.equal(graphed.nodes, 6, 'four hypotheses + two papers')
  assert.equal(graphed.paper_nodes, 2)
  const kinds = graphed.graph.edges.map((edge) => edge.kind)
  assert.equal(kinds.filter((kind) => kind === 'supports').length, 1)
  assert.equal(kinds.filter((kind) => kind === 'contradicts').length, 1)
  assert.ok(kinds.includes('related'), 'similarity edges come from the ledger')
  assert.ok(graphed.graph.edges.filter((edge) => edge.kind === 'related').every((edge) => edge.measure === 'vector'))
  assert.equal(graphed.measures.join(','), 'vector')
  assert.ok(!graphed.graph.edges.some((edge) => edge.kind === 'evolved'), 'nothing evolved from anything here')
  assert.match(graphed.mermaid, /^flowchart TD$/m)
  assert.ok(!graphed.mermaid.includes('Proteasome gating [in] vivo'), 'label characters that would break Mermaid are stripped')
  assert.match(graphed.mermaid, /Proteasome gating in vivo/)
  assert.match(graphed.mermaid, /classDef withheld/)
  assert.match(text(renderTournament(graphed)), /mermaid_render/)

  const graphFile = await tournament.execute({ action: 'export', slug: 'phase4', format: 'mermaid' }, embedExec)
  assert.equal(graphFile.error, undefined, graphFile.error)
  assert.match(graphFile.path, /exports\/tournament\.mmd$/)
  assert.match(readFileSync(join(cwd, graphFile.path), 'utf8'), /flowchart TD/)
  await assert.rejects(() => runCosc({ action: 'export', slug: 'phase4', format: 'mermaid' }, embedExec), /already exists/)

  console.log('coscientist-tool OK')
} finally {
  rmSync(cwd, { recursive: true, force: true })
}
