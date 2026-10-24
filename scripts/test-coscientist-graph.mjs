import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addHypothesis, attachVectors, deriveState, knowledgeGraph, priorFeedback, recordFeedback,
  recordProvenance, recordSafety, recordReview, setStatus, startTournament, similarityNeighbours, tournamentDir,
} from '../coscientist-store.js'

const cwd = mkdtempSync(join(tmpdir(), 'ah-cosc-graph-'))

const STAGES = ['initial', 'full', 'deep_verification', 'simulation', 'observation']

async function activate(slug, hyp, options = {}) {
  const added = await addHypothesis({ cwd, slug, hypothesis: hyp, ...options })
  if (added.discarded) return added
  let latest = added.hypothesis
  for (const stage of STAGES) {
    latest = (await recordReview({
      cwd, slug, id: added.hypothesis.id, stage, verdict: 'pass',
      noveltyScore: 6, correctnessScore: 6, testabilityScore: 6,
    })).hypothesis
  }
  return latest
}

try {
  // ─── attachVectors validation ───────────────────────────────────────────────
  const slug = 'vectors'
  await startTournament({ cwd, slug, protocol: { goal: 'embedding plumbing', max_hypotheses: 6 } })
  const one = await addHypothesis({ cwd, slug, hypothesis: { title: 'Alpha-synuclein clearing depends on lysosomal pH setpoints', summary: 'A neuron clears aggregates at a pH threshold no other mechanism explains.', content: 'Claim one.' } })
  const two = await addHypothesis({ cwd, slug, hypothesis: { title: 'Glial iron storage limits oxidative buffering in aging cortex', summary: 'A different tissue and a different chemistry entirely.', content: 'Claim two.' } })

  await assert.rejects(() => attachVectors({ cwd, slug, vectors: {} }), /no vectors supplied/)
  await assert.rejects(() => attachVectors({ cwd, slug, vectors: null }), /must be an object/)
  await assert.rejects(() => attachVectors({ cwd, slug, vectors: { h404: [1, 0] } }), /unknown hypothesis id\(s\): h404/)
  await assert.rejects(() => attachVectors({ cwd, slug, vectors: { [one.hypothesis.id]: [] } }), /non-empty array/)
  await assert.rejects(() => attachVectors({ cwd, slug, vectors: { [one.hypothesis.id]: ['a', 'b'] } }), /finite numbers/)

  const attached = await attachVectors({ cwd, slug, vectors: { [one.hypothesis.id]: [1, 0, 0], [two.hypothesis.id]: [0, 1, 0] } })
  assert.equal(attached.embedded, 2)
  assert.equal(attached.dimensions, 3)
  assert.deepEqual(deriveState(cwd, slug).byId.get(one.hypothesis.id).vector, [1, 0, 0])

  // A second model in one tournament is refused outright: mixing scales would
  // make every later similarity number meaningless and undetectable.
  await assert.rejects(
    () => attachVectors({ cwd, slug, vectors: { [two.hypothesis.id]: [1, 0, 0, 0] } }),
    /mixed embedding dimensions/,
  )

  // Re-attaching replaces rather than duplicates.
  await attachVectors({ cwd, slug, vectors: { [one.hypothesis.id]: [0, 1, 0] } })
  assert.deepEqual(deriveState(cwd, slug).byId.get(one.hypothesis.id).vector, [0, 1, 0])
  assert.equal(deriveState(cwd, slug).hypotheses.length, 2, 're-embedding must not add a hypothesis')

  // With both embedded, similarity is cosine: orthogonal means no relation.
  const orthogonal = similarityNeighbours(cwd, slug)
  assert.deepEqual(orthogonal.edges, [])
  await attachVectors({ cwd, slug, vectors: { [two.hypothesis.id]: [0.01, 0.99, 0] } })
  const near = similarityNeighbours(cwd, slug)
  assert.equal(near.duplicates.length, 1, 'cosine 0.999 is a duplicate at the vector threshold')
  assert.equal(near.duplicates[0].threshold, 0.92)
  assert.equal(near.duplicates[0].measure, 'vector')

  // ─── the graph is derived from the ledger ──────────────────────────────────
  const graphSlug = 'graph-demo'
  await startTournament({ cwd, slug: graphSlug, protocol: { goal: 'How do cells survive proteotoxic stress?', max_hypotheses: 8 } })
  const first = await activate(graphSlug, {
    title: 'Chaperone triage decides which misfolded proteins get degraded',
    summary: 'A triage step at the chaperone layer sets degradation order.',
    content: 'Predicts order changes when the triage sensor is mutated.',
    rationale: 'Chaperones discriminate by exposure length.',
  })
  const child = await addHypothesis({
    cwd, slug: graphSlug, parentIds: [first.id], strategy: 'evolution:coherence',
    hypothesis: { title: 'Coherence edit: chaperone triage with the sensor named', summary: 'Same mechanism, one assumption made explicit.', content: 'Predicts a specific sensor knockout reverses the order.' },
  })
  const unrelated = await activate(graphSlug, {
    title: 'Proteasome gating by phosphorylation sets the degradation rate',
    summary: 'A gating modification on the proteasome controls flux.',
    content: 'Predicts flux falls when the kinase is inhibited.',
  })
  const hostile = await activate(graphSlug, {
    title: 'Lipid tension recruits chaperones ["alpha"] <b>bold</b> | with a pipe',
    summary: 'Membrane tension is the recruit signal, not the cargo. [bracketed]',
    content: 'Predicts tension alone recruits.',
  })

  await recordProvenance({
    cwd, slug: graphSlug, id: first.id,
    claims: [
      { claim: 'Triage precedes degradation', support: 'supports', confidence: 0.8, paper_title: 'Chaperone-mediated ordering of substrates', paper_doi: '10.1000/triage' },
      { claim: 'Triage is saturable', support: 'contradicts', confidence: 0.65, paper_title: 'Saturation of ordering ["of substrates"] <i>| notes</i>', paper_doi: '10.1000/saturate' },
      { claim: 'Triage is reversible', support: 'unaddressed', confidence: 0.2, paper_title: 'Some paper nobody checked', paper_doi: '10.1000/nobody' },
    ],
  })
  // The same paper cited by two hypotheses is one node, not two.
  await recordProvenance({
    cwd, slug: graphSlug, id: unrelated.id,
    claims: [{ claim: 'Ordering exists', support: 'supports', confidence: 0.7, paper_title: 'Chaperone-mediated ordering of substrates', paper_doi: '10.1000/triage' }],
  })

  const withheld = await activate(graphSlug, {
    title: 'Engineering a broadly transmissible respiratory agent',
    summary: 'A gain-of-function route to higher transmissibility.',
    content: 'Predicts specific substitutions raise transmission.',
  })
  await recordSafety({ cwd, slug: graphSlug, id: withheld.id, severity: 'high', category: 'bioweapon', reasoning: 'Actionable uplift toward harm.' })
  const vetoed = await addHypothesis({
    cwd, slug: graphSlug,
    hypothesis: { title: 'A restatement of a published result about ubiquitin chains', summary: 'Already known in detail.', content: 'Claim.' },
  })
  await recordReview({ cwd, slug: graphSlug, id: vetoed.hypothesis.id, stage: 'initial', verdict: 'fail', critique: 'trivial' })

  const graph = knowledgeGraph(cwd, graphSlug)
  const nodeIds = graph.nodes.map((node) => node.id)
  const hypothesisIds = graph.nodes.filter((node) => node.kind === 'hypothesis').map((node) => node.id)
  assert.deepEqual(
    new Set(hypothesisIds),
    new Set([first.id, child.hypothesis.id, unrelated.id, hostile.id, withheld.id, vetoed.hypothesis.id]),
    'every hypothesis is a node, including the rejected and withheld ones',
  )
  assert.equal(graph.nodes.filter((node) => node.kind === 'paper').length, 2, 'the shared paper is one node; an unaddressed claim adds none')
  assert.deepEqual(graph.nodes.filter((node) => node.kind === 'paper').map((node) => node.doi).sort(), ['10.1000/saturate', '10.1000/triage'])

  const edgeKinds = graph.edges.map((edge) => edge.kind)
  assert.equal(edgeKinds.filter((kind) => kind === 'evolved').length, 1)
  assert.deepEqual(graph.edges.find((edge) => edge.kind === 'evolved'), { from: first.id, to: child.hypothesis.id, kind: 'evolved', label: 'evolved from' })
  assert.equal(edgeKinds.filter((kind) => kind === 'supports').length, 2)
  assert.equal(edgeKinds.filter((kind) => kind === 'contradicts').length, 1)
  assert.ok(!edgeKinds.includes('unaddressed'), 'an unaddressed claim is not an edge to a paper')
  assert.ok(graph.edges.every((edge) => nodeIds.includes(edge.from) && nodeIds.includes(edge.to)), 'no dangling edges')

  const mermaid = graph.mermaid
  assert.match(mermaid, /^%% Goal: How do cells survive proteotoxic stress\?$/m, 'the goal comment is escaped too')
  assert.match(mermaid, /^flowchart TD$/m)
  assert.match(mermaid, /---\ntitle: Hypothesis tournament — /)
  // Labels are what break a diagram, and the node syntax itself is `id["label"]`,
  // so assert on the label content rather than the whole line.
  const hostileLine = mermaid.split('\n').map((line) => line.trim()).find((line) => line.startsWith(`${hostile.id}["`))
  assert.ok(hostileLine, `no node line for ${hostile.id}`)
  const hostileLabel = hostileLine.slice(hostileLine.indexOf('["') + 2, hostileLine.lastIndexOf('"]'))
  // The only `<br/>` allowed is the one the renderer inserted between the title
  // and the rating line; anything the hypothesis itself contained was stripped.
  const [hostileTitle, hostileDetail] = hostileLabel.split('<br/>')
  assert.ok(!/["[\]{}<>|`]/.test(hostileTitle), `label still carries Mermaid syntax: ${hostileTitle}`)
  assert.match(hostileTitle, /bold with a pipe/)
  assert.match(hostileTitle, /alpha/)
  assert.ok(!hostileTitle.includes('[') && !hostileTitle.includes('<'), 'brackets and tags never reach a node label')
  assert.match(hostileDetail, /1240 ± 200 · 0 matches/, 'the rating line survives as renderer markup')
  assert.equal(hostileLabel.split('<br/>').length, 2, 'exactly one inserted break')
  const saturateNode = mermaid.split('\n').map((line) => line.trim()).find((line) => line.startsWith('p') && line.includes('Saturation of ordering'))
  assert.ok(saturateNode, 'the paper node is present')
  assert.ok(!/["[\]{}<>|]/.test(saturateNode.slice(saturateNode.indexOf('["') + 2, saturateNode.lastIndexOf('"]'))), `paper label is not sanitized: ${saturateNode}`)
  assert.match(saturateNode, /Saturation of ordering of substrates/)
  assert.match(mermaid, /class [\w,]+ withheld/)
  assert.match(mermaid, /class [\w,]+ rejected/)
  assert.match(mermaid, /class [\w,]+ active/)
  assert.match(mermaid, /class [\w,]+ paper/)
  assert.equal(mermaid, knowledgeGraph(cwd, graphSlug).mermaid, 'the same ledger renders the same diagram')
  assert.deepEqual(graph.measures, [], 'this pool has no similar pair, so there is no measure to report')

  // Embedding two of them turns a previously unrelated pair into a vector edge,
  // and the edge says which scale produced it.
  // A parent/child pair would already be joined by its lineage edge, so embed two
  // hypotheses that have no other connection.
  await attachVectors({ cwd, slug: graphSlug, vectors: { [first.id]: [1, 0, 0], [unrelated.id]: [0.8, 0.6, 0] } })
  const embeddedGraph = knowledgeGraph(cwd, graphSlug)
  assert.deepEqual(embeddedGraph.measures, ['vector'])
  const vectorEdge = embeddedGraph.edges.find((edge) => edge.kind === 'related')
  assert.equal(vectorEdge.measure, 'vector')
  assert.ok(vectorEdge.label.startsWith('related 0.8'), vectorEdge.label)
  assert.deepEqual([vectorEdge.from, vectorEdge.to], [first.id, unrelated.id])
  assert.equal(embeddedGraph.edges.filter((edge) => edge.kind === 'related').length, 1, 'one related pair, no duplicate')

  // ─── cross-session priors ───────────────────────────────────────────────────
  const priorSlug = 'prior-source'
  await startTournament({ cwd, slug: priorSlug, protocol: { goal: 'chaperone triage and proteostasis in aging cells', max_hypotheses: 4 } })
  const priorTarget = await activate(priorSlug, {
    title: 'Chaperone triage capacity declines with replicative age',
    summary: 'Aging cells lose the ability to order misfolded proteins for degradation.',
    content: 'Predicts young cytosol restores ordering.',
  })
  await recordFeedback({
    cwd, slug: priorSlug, id: priorTarget.id,
    feedbackText: 'The chaperone triage prediction was refuted in three replicate assays.',
    recordedBy: 'wet-lab',
  })
  await setStatus({ cwd, slug: priorSlug, id: priorTarget.id, status: 'quarantined', reason: 'Shares reagents with a dual-use protocol' })

  const priors = priorFeedback({ cwd, slug: 'a-brand-new-slug', query: 'chaperone triage of misfolded proteins during aging' })
  assert.ok(priors.scanned >= 1)
  assert.ok(priors.priors.length >= 1, JSON.stringify(priors))
  const kinds = priors.priors.map((prior) => prior.kind)
  assert.ok(kinds.includes('feedback'), 'the refuted result surfaces')
  assert.ok(kinds.includes('withheld') || kinds.includes('rejection'), 'the earlier withholding surfaces')
  assert.equal(priors.priors[0].score >= 0.15, true, 'results are ranked by relevance')
  assert.ok(priors.priors.every((prior) => prior.session !== 'a-brand-new-slug'), 'a tournament never cites itself')
  assert.ok(priors.priors.every((prior) => prior.session_goal), 'each prior names the goal it came from')
  assert.equal(priorFeedback({ cwd, slug: priorSlug, query: 'chaperone triage' }).priors.filter((p) => p.session === priorSlug).length, 0, 'the current session is skipped')
  assert.equal(priorFeedback({ cwd, slug: 'x', query: 'chaperone triage', limit: 1 }).priors.length, 1)
  // A stricter bar on the same query drops everything: overlap is 3 shared
  // tokens over the smaller side, which clears 0.15 and not 0.9.
  const broadQuery = 'chaperone triage of misfolded proteins during replicative aging in motor neurons'
  assert.ok(priorFeedback({ cwd, slug: 'x', query: broadQuery }).priors.length >= 1, 'the default bar still finds it')
  assert.equal(priorFeedback({ cwd, slug: 'x', query: broadQuery, minScore: 0.9 }).priors.length, 0, 'a stricter bar returns less')
  assert.ok(priorFeedback({ cwd, slug: 'x', query: 'chaperone triage' }).priors.every((prior) => prior.score === 1), 'a query contained in a prior is a full-overlap match')
  assert.match(priorFeedback({ cwd, slug: 'x', query: '' }).error, /query is required/)
  assert.deepEqual(priorFeedback({ cwd: join(cwd, 'nowhere'), slug: 'x', query: 'anything' }), { priors: [], scanned: 0 })

  // A sibling with damaged logs is skipped, never fatal: one crashed experiment
  // must not block a new one.
  const broken = tournamentDir(cwd, 'broken-sibling')
  mkdirSync(broken, { recursive: true })
  writeFileSync(join(broken, 'protocol.json'), JSON.stringify({ slug: 'broken-sibling', goal: 'chaperone triage of misfolded proteins' }))
  writeFileSync(join(broken, 'events.jsonl'), '{"type":"feedback","hypothesisId":"h1","feedback_text":"whole line"}\n{not json at all}\n')
  const afterBroken = priorFeedback({ cwd, slug: 'fresh', query: 'chaperone triage of misfolded proteins' })
  assert.ok(afterBroken.scanned >= 1)
  assert.ok(afterBroken.priors.every((prior) => prior.session !== 'broken-sibling'), 'the corrupt file contributes nothing')

  // A sibling whose protocol is unreadable still contributes its feedback.
  const noProtocol = tournamentDir(cwd, 'no-protocol')
  mkdirSync(noProtocol, { recursive: true })
  writeFileSync(join(noProtocol, 'events.jsonl'), `${JSON.stringify({
    type: 'added', hypothesisId: 'h1', title: 'Chaperone triage fails in senescent fibroblasts', summary: 'Ordering declines.', ts: new Date().toISOString(),
  })}\n${JSON.stringify({
    type: 'feedback', hypothesisId: 'h1', feedback_text: 'Confirmed: chaperone triage of misfolded proteins recovered after rapamycin.', reward: 0.6, ts: new Date().toISOString(),
  })}\n`)
  const orphan = priorFeedback({ cwd, slug: 'fresh', query: 'chaperone triage of misfolded proteins' })
  const orphanPrior = orphan.priors.find((prior) => prior.session === 'no-protocol')
  assert.ok(orphanPrior, 'an orphaned ledger is still readable')
  assert.equal(orphanPrior.kind, 'feedback')
  assert.equal(orphanPrior.session_goal, 'no-protocol', 'it falls back to the slug for provenance')

  console.log('coscientist-graph OK')
} finally {
  rmSync(cwd, { recursive: true, force: true })
}
