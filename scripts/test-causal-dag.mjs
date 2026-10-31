import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { apply, runCausalAction } from '../causal-dag.js'
import { computeEValue } from '../causal-graph.js'
import { startPreregistration, importPreregistration } from '../preregister-store.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const workspace = makeWorkspace('ah-causal-')
const cwd = workspace.cwd
const exec = fakeExec(cwd)
let tool
apply({ tools: { register: (registered) => { tool = registered } } })
const run = (args) => tool.execute(args, exec)
const sets = (value) => value.map((set) => [...set].sort().join(','))

try {
  // Confounding: Z causes both X and Y; X causes Y.
  let result = await run({
    action: 'create', slug: 'confounding', treatment: 'X', outcome: 'Y',
    nodes: ['X', 'Y', 'Z'], edges: [['Z', 'X'], ['Z', 'Y'], ['X', 'Y']],
  })
  assert.equal(result.version, 1)
  assert.match(result.hash, /^sha256:/)

  result = await run({ action: 'analyze', slug: 'confounding' })
  assert.equal(result.analysis.backdoor.status, 'adjustment_sets_found')
  assert.deepEqual(sets(result.analysis.backdoor.minimal_sets), ['Z'])
  assert.equal(result.analysis.backdoor.parents_of_treatment_valid, true)
  assert.equal(result.analysis.front_door.status, 'no_candidates')
  assert.deepEqual(result.analysis.instruments.candidates.map((entry) => entry.node), [])

  // Known d-separation: X ⊥ Y | Z in X <- Z -> Y with no direct edge.
  result = await run({ action: 'create', slug: 'fork', treatment: 'X', outcome: 'Y', nodes: ['X', 'Y', 'Z'], edges: [['Z', 'X'], ['Z', 'Y']] })
  result = await run({ action: 'analyze', slug: 'fork', given: ['Z'] })
  assert.equal(result.analysis.d_separation.separated, true)
  assert.deepEqual(sets(result.analysis.backdoor.minimal_sets), ['Z'])
  assert.equal(result.analysis.backdoor.paths.length, 1)

  // A latent confounder leaves no observed adjustment set.
  result = await run({
    action: 'create', slug: 'latent', treatment: 'X', outcome: 'Y',
    nodes: ['X', 'Y', { id: 'U', latent: true }], edges: [['U', 'X'], ['U', 'Y'], ['X', 'Y']],
  })
  result = await run({ action: 'analyze', slug: 'latent' })
  assert.equal(result.analysis.backdoor.status, 'no_adjustment_set')
  assert.ok(!result.analysis.backdoor.minimal_sets.flat().includes('U'))

  // Mediation: front-door mediator M.
  result = await run({
    action: 'create', slug: 'frontdoor', treatment: 'X', outcome: 'Y',
    nodes: ['X', 'M', 'Y'], edges: [['X', 'M'], ['M', 'Y']],
  })
  result = await run({ action: 'analyze', slug: 'frontdoor' })
  assert.equal(result.analysis.backdoor.status, 'no_open_backdoor_path')
  assert.equal(result.analysis.front_door.status, 'front_door_sets_found')
  assert.deepEqual(sets(result.analysis.front_door.sets), ['M'])

  // Instrument: Z -> X -> Y only.
  result = await run({
    action: 'create', slug: 'instrument', treatment: 'X', outcome: 'Y',
    nodes: ['Z', 'X', 'Y'], edges: [['Z', 'X'], ['X', 'Y']],
  })
  result = await run({ action: 'analyze', slug: 'instrument' })
  assert.deepEqual(result.analysis.instruments.candidates.map((entry) => entry.node), ['Z'])

  // Collider: adjusting for C should warn.
  result = await run({
    action: 'create', slug: 'collider', treatment: 'X', outcome: 'Y',
    nodes: ['X', 'C', 'Y'], edges: [['X', 'C'], ['Y', 'C']],
  })
  result = await run({ action: 'analyze', slug: 'collider', adjust_for: ['C'] })
  assert.ok(result.analysis.colliders.some((entry) => entry.node === 'C'))
  assert.ok(result.analysis.adjustment_warnings.some((entry) => entry.node === 'C' && entry.status === 'collider'))
  assert.equal(result.analysis.d_separation.separated, true)
  result = await run({ action: 'analyze', slug: 'collider', given: ['C'] })
  assert.equal(result.analysis.d_separation.separated, false)

  // Descendant-of-treatment warning.
  result = await run({ action: 'analyze', slug: 'confounding', adjust_for: ['Y', 'X'] })
  assert.ok(result.analysis.adjustment_warnings.some((entry) => entry.status === 'descendant_of_treatment'))

  // A node with two parents that is a common cause of X and Y is not a
  // collider on a treatment–outcome path; do not warn about adjusting for it.
  result = await run({
    action: 'create', slug: 'common-cause', treatment: 'X', outcome: 'Y',
    nodes: ['Z1', 'Z2', 'C', 'X', 'Y'], edges: [['Z1', 'C'], ['Z2', 'C'], ['C', 'X'], ['C', 'Y']],
  })
  result = await run({ action: 'analyze', slug: 'common-cause', adjust_for: ['C'] })
  assert.ok(!result.analysis.adjustment_warnings.some((entry) => entry.node === 'C' && entry.status === 'collider'))

  // Front-door must reject a set when the mediators share an unobserved cause.
  result = await run({
    action: 'create', slug: 'bad-frontdoor', treatment: 'X', outcome: 'Y',
    nodes: ['X', 'M1', 'M2', 'Y', { id: 'U', latent: true }],
    edges: [['X', 'M1'], ['X', 'M2'], ['M1', 'Y'], ['M2', 'Y'], ['U', 'M1'], ['U', 'M2']],
  })
  result = await run({ action: 'analyze', slug: 'bad-frontdoor' })
  assert.equal(result.analysis.front_door.status, 'no_set_satisfies_criteria')

  // Editing is versioned and requires a reason; cycles are refused.
  result = await run({ action: 'edit', slug: 'confounding', remove_edges: [['Z', 'Y']] })
  assert.match(result.error, /reason/)
  result = await run({ action: 'edit', slug: 'confounding', add_nodes: ['W'], add_edges: [['Y', 'W']], reason: 'add downstream marker' })
  assert.equal(result.version, 2)
  assert.equal(result.dag.nodes.length, 4)
  result = await run({ action: 'edit', slug: 'confounding', add_edges: [['W', 'Z']], reason: 'would create a cycle' })
  assert.match(result.error, /cycle/)

  result = await run({ action: 'create', slug: 'cycle', nodes: ['A', 'B'], edges: [['A', 'B'], ['B', 'A']] })
  assert.match(result.error, /cycle/)

  // Import DOT text, export Mermaid/DOT/edge list.
  workspace.write('graphs/simple.dot', 'digraph G { Z -> X; Z -> Y; X -> Y; X [label="Treatment"]; }')
  result = await run({ action: 'create', slug: 'from-dot', text: workspace.read('graphs/simple.dot'), format: 'dot', treatment: 'X', outcome: 'Y' })
  assert.equal(result.dag.edges.length, 3)
  assert.equal(result.dag.nodes.find((node) => node.id === 'X').label, 'Treatment')
  result = await run({ action: 'export', slug: 'from-dot', format: 'mermaid', overwrite: true })
  assert.match(workspace.read('.dsh/causal/from-dot/exports/dag.mmd'), /X --> Y/)
  result = await run({ action: 'export', slug: 'from-dot', format: 'dot', overwrite: true })
  assert.match(workspace.read('.dsh/causal/from-dot/exports/dag.dot'), /digraph causal_dag/)
  result = await run({ action: 'export', slug: 'from-dot', format: 'edge_list', overwrite: true })
  assert.match(workspace.read('.dsh/causal/from-dot/exports/dag.tsv'), /X\tY/)

  // E-values.
  const rr = computeEValue({ measure: 'RR', estimate: 2, ciLow: 1.5, ciHigh: 2.7 })
  assert.ok(Math.abs(rr.e_value - (2 + Math.sqrt(2))) < 1e-12)
  assert.ok(Math.abs(rr.e_value_ci - (1.5 + Math.sqrt(0.75))) < 1e-12)
  const or = computeEValue({ measure: 'OR', estimate: 4, ciLow: 2, ciHigh: 8 })
  assert.ok(Math.abs(or.e_value - (2 + Math.sqrt(2))) < 1e-12)
  const inverted = computeEValue({ measure: 'RR', estimate: 0.5 })
  assert.ok(Math.abs(inverted.e_value - (2 + Math.sqrt(2))) < 1e-12)
  const nullCi = computeEValue({ measure: 'RR', estimate: 0.8, ciLow: 0.4, ciHigh: 2 })
  assert.equal(nullCi.e_value_ci, 1)
  const smd = computeEValue({ measure: 'SMD', estimate: 0.5, ciLow: 0.1, ciHigh: 0.9 })
  assert.ok(smd.e_value > 1)
  assert.match(smd.caveats.join(' '), /standardized mean difference/i)
  assert.throws(() => computeEValue({ measure: 'RD', estimate: 0.2 }), /measure/)
  result = await run({ action: 'evalues', slug: 'confounding', measure: 'RR', estimate: 2, ci_low: 1.5, ci_high: 2.7 })
  assert.match(result.result.e_value.toFixed(2), /^3\.41/)
  result = await run({ action: 'evalues', measure: 'RR', estimate: 2 })
  assert.ok(result.result.e_value > 3)

  // Status and preregister integration.
  result = await run({ action: 'status', slug: 'confounding' })
  assert.equal(result.status.version, 2)
  assert.ok(existsSync(workspace.path('.dsh/causal/confounding/dag.jsonl')))

  await startPreregistration({ cwd, slug: 'prereg-causal', patch: {} })
  result = await run({ action: 'analyze', slug: 'confounding' })
  const imported = await importPreregistration({ cwd, slug: 'prereg-causal', from: 'causal_dag', sourceSlug: 'confounding' })
  assert.ok(imported.imported_fields.includes('variables'))
  const draft = JSON.parse(workspace.read('.dsh/preregister/prereg-causal/draft.json'))
  assert.equal(draft.plan.variables.treatment, 'X')
  assert.deepEqual(draft.plan.variables.adjustment, ['Z'])

  console.log('causal_dag OK')
} finally {
  workspace.cleanup()
}
