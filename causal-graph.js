/**
 * Dependency-free DAG utilities for `causal_dag`.
 *
 * The graph is user-supplied; this module only derives what the graph implies
 * under the stated assumptions (d-separation, backdoor/front-door criteria,
 * instruments, testable independencies) and computes E-values. It never fits a
 * model, estimates a causal effect, or claims that an adjustment set is
 * scientifically correct — it reports which sets satisfy the graph criterion.
 */

const MAX_PATHS = 5000
const MAX_PATH_LENGTH = 14
const MAX_ADJUSTMENT_CANDIDATES = 12
const MAX_MINIMAL_SETS = 50

function sortedUnique(values) {
  return [...new Set(values)].sort()
}

export function buildGraph(dag) {
  const nodes = dag.nodes.map((node) => (typeof node === 'string' ? node : node.id))
  const nodeMap = new Map(dag.nodes.map((node) => {
    const id = typeof node === 'string' ? node : node.id
    return [id, typeof node === 'string' ? { id: node, observed: true } : { ...node, observed: node.observed !== false && node.latent !== true }]
  }))
  const parents = new Map(nodes.map((id) => [id, new Set()]))
  const children = new Map(nodes.map((id) => [id, new Set()]))
  for (const [from, to] of dag.edges) {
    parents.get(to)?.add(from)
    children.get(from)?.add(to)
  }
  return { nodes, nodeMap, parents, children }
}

export function isAcyclic(dag) {
  const { nodes, children } = buildGraph(dag)
  const indegree = new Map(nodes.map((id) => [id, 0]))
  for (const [, to] of dag.edges) indegree.set(to, (indegree.get(to) || 0) + 1)
  const queue = nodes.filter((id) => indegree.get(id) === 0)
  let seen = 0
  while (queue.length) {
    const id = queue.shift()
    seen += 1
    for (const child of children.get(id) || []) {
      indegree.set(child, indegree.get(child) - 1)
      if (indegree.get(child) === 0) queue.push(child)
    }
  }
  return seen === nodes.length
}

export function descendants(dag, node) {
  const { children } = buildGraph(dag)
  const out = new Set()
  const stack = [...(children.get(node) || [])]
  while (stack.length) {
    const id = stack.pop()
    if (out.has(id)) continue
    out.add(id)
    for (const child of children.get(id) || []) stack.push(child)
  }
  return out
}

export function ancestors(dag, node) {
  const { parents } = buildGraph(dag)
  const out = new Set()
  const stack = [...(parents.get(node) || [])]
  while (stack.length) {
    const id = stack.pop()
    if (out.has(id)) continue
    out.add(id)
    for (const parent of parents.get(id) || []) stack.push(parent)
  }
  return out
}

export function hasDirectedPath(dag, from, to, exclude = new Set()) {
  if (from === to) return true
  const { children } = buildGraph(dag)
  const seen = new Set([from])
  const queue = [from]
  while (queue.length) {
    const id = queue.shift()
    for (const child of children.get(id) || []) {
      if (exclude.has(child)) continue
      if (child === to) return true
      if (seen.has(child)) continue
      seen.add(child)
      queue.push(child)
    }
  }
  return false
}

/**
 * d-separation by ancestral subgraph moralization: X ⫫ Y | Z iff X and Y are
 * disconnected after keeping the ancestors of X∪Y∪Z, moralizing, and removing
 * Z. `blockOutgoing` drops every edge leaving the named nodes first.
 */
export function dSeparated(dag, x, y, given = [], { blockOutgoing = [] } = {}) {
  const { nodes } = buildGraph(dag)
  const known = new Set(nodes)
  if (!known.has(x)) throw new Error(`unknown node: ${x}`)
  if (!known.has(y)) throw new Error(`unknown node: ${y}`)
  for (const id of given) if (!known.has(id)) throw new Error(`unknown node in given: ${id}`)
  const z = new Set(given)
  if (x === y || z.has(x) || z.has(y)) return { separated: false, reason: 'x and y are the same node or one of them is conditioned on' }
  const blocked = new Set(blockOutgoing)
  const edges = dag.edges.filter(([from]) => !blocked.has(from))
  const parentsEff = new Map(nodes.map((id) => [id, new Set()]))
  for (const [from, to] of edges) parentsEff.get(to)?.add(from)

  const targets = new Set([x, y, ...given])
  const ancestral = new Set()
  const stack = [...targets]
  while (stack.length) {
    const id = stack.pop()
    if (ancestral.has(id)) continue
    ancestral.add(id)
    for (const parent of parentsEff.get(id) || []) stack.push(parent)
  }

  const adj = new Map([...ancestral].map((id) => [id, new Set()]))
  const link = (a, b) => {
    if (!adj.has(a) || !adj.has(b) || a === b) return
    adj.get(a).add(b)
    adj.get(b).add(a)
  }
  for (const [from, to] of edges) {
    if (ancestral.has(from) && ancestral.has(to)) link(from, to)
  }
  for (const child of ancestral) {
    const ps = [...(parentsEff.get(child) || [])].filter((parent) => ancestral.has(parent))
    for (let i = 0; i < ps.length; i += 1) {
      for (let j = i + 1; j < ps.length; j += 1) link(ps[i], ps[j])
    }
  }

  const seen = new Set([x])
  const queue = [x]
  while (queue.length) {
    const id = queue.shift()
    for (const next of adj.get(id) || []) {
      if (z.has(next) || seen.has(next)) continue
      if (next === y) return { separated: false, reason: 'a path remains open given the conditioning set' }
      seen.add(next)
      queue.push(next)
    }
  }
  return { separated: true, reason: 'no path remains open given the conditioning set' }
}

function undirectedPaths(dag, from, to) {
  const { nodes } = buildGraph(dag)
  const adj = new Map(nodes.map((id) => [id, new Set()]))
  for (const [a, b] of dag.edges) {
    adj.get(a)?.add(b)
    adj.get(b)?.add(a)
  }
  const paths = []
  const stack = [[from]]
  while (stack.length && paths.length < MAX_PATHS) {
    const path = stack.pop()
    const last = path[path.length - 1]
    if (last === to) {
      if (path.length > 1) paths.push(path)
      continue
    }
    if (path.length >= MAX_PATH_LENGTH) continue
    for (const next of adj.get(last) || []) {
      if (path.includes(next)) continue
      stack.push([...path, next])
    }
  }
  return paths
}

function isCausalPath(dag, path) {
  const edges = new Set(dag.edges.map(([a, b]) => `${a}\u0000${b}`))
  for (let index = 0; index < path.length - 1; index += 1) {
    if (!edges.has(`${path[index]}\u0000${path[index + 1]}`)) return false
  }
  return true
}

function backdoorPaths(dag, x, y) {
  const { parents } = buildGraph(dag)
  return undirectedPaths(dag, x, y)
    .filter((path) => path.length >= 3 && (parents.get(x) || new Set()).has(path[1]) && !isCausalPath(dag, path))
}

function subsetKey(ids) {
  return [...ids].sort().join('\u0000')
}

function allSubsets(items) {
  const out = []
  const total = 2 ** items.length
  for (let mask = 0; mask < total; mask += 1) {
    const set = []
    for (let bit = 0; bit < items.length; bit += 1) {
      if (mask & (1 << bit)) set.push(items[bit])
    }
    out.push(set)
  }
  return out
}

function minimalSets(valid) {
  const validKeys = new Set(valid.map(subsetKey))
  const minimal = []
  const sorted = [...valid].sort((a, b) => a.length - b.length || subsetKey(a).localeCompare(subsetKey(b)))
  for (const set of sorted) {
    if (set.length === 0) {
      minimal.push(set)
      continue
    }
    const hasValidProperSubset = allSubsets(set).some((subset) => subset.length < set.length && validKeys.has(subsetKey(subset)))
    if (!hasValidProperSubset) minimal.push(set)
    if (minimal.length >= MAX_MINIMAL_SETS) break
  }
  return minimal
}

function adjustmentCandidates(dag, x, y) {
  const descX = descendants(dag, x)
  const ancX = ancestors(dag, x)
  const ancY = ancestors(dag, y)
  const { nodeMap } = buildGraph(dag)
  const candidates = dag.nodes
    .map((node) => (typeof node === 'string' ? { id: node, observed: true } : node))
    .filter((node) => nodeMap.get(node.id)?.observed !== false)
    .map((node) => node.id)
    .filter((id) => id !== x && id !== y && !descX.has(id) && (ancX.has(id) || ancY.has(id)))
  const ordered = candidates.sort((a, b) => {
    const aAnc = ancX.has(a) ? 0 : 1
    const bAnc = ancX.has(b) ? 0 : 1
    return aAnc - bAnc || a.localeCompare(b)
  })
  return { candidates: ordered, truncated: ordered.length > MAX_ADJUSTMENT_CANDIDATES }
}

function frontDoorCandidates(dag, x, y) {
  const descX = descendants(dag, x)
  const ancY = ancestors(dag, y)
  const { nodeMap } = buildGraph(dag)
  return dag.nodes
    .map((node) => (typeof node === 'string' ? { id: node, observed: true } : node))
    .filter((node) => nodeMap.get(node.id)?.observed !== false)
    .map((node) => node.id)
    .filter((id) => id !== x && id !== y && descX.has(id) && ancY.has(id))
    .sort()
}

function frontDoorSets(dag, x, y) {
  if (!hasDirectedPath(dag, x, y)) {
    return { status: 'no_directed_path', sets: [], note: 'front-door identification needs a directed path from treatment to outcome' }
  }
  const candidates = frontDoorCandidates(dag, x, y)
  if (!candidates.length) return { status: 'no_candidates', sets: [], note: 'no observed mediator lies on a directed path from treatment to outcome' }
  const truncated = candidates.length > 8
  const pool = candidates.slice(0, 8)
  const valid = []
  for (const set of allSubsets(pool)) {
    if (!set.length) continue
    const med = new Set(set)
    if (hasDirectedPath(dag, x, y, med)) continue
    if (!set.every((m) => dSeparated(dag, x, m, [], { blockOutgoing: [x] }).separated)) continue
    if (!set.every((m) => dSeparated(dag, m, y, [x], { blockOutgoing: [m] }).separated)) continue
    valid.push(set)
  }
  const minimal = minimalSets(valid)
  return {
    status: minimal.length ? 'front_door_sets_found' : 'no_set_satisfies_criteria',
    sets: minimal.slice(0, MAX_MINIMAL_SETS), candidate_count: candidates.length, truncated,
    note: 'Front-door identification is conditional on the graph, including no unmeasured treatment–mediator or mediator–outcome confounding.',
  }
}

function instrumentCandidates(dag, x, y) {
  const descX = descendants(dag, x)
  const { nodeMap } = buildGraph(dag)
  const candidates = []
  for (const node of dag.nodes) {
    const id = typeof node === 'string' ? node : node.id
    if (id === x || id === y) continue
    if (nodeMap.get(id)?.observed === false) continue
    if (!hasDirectedPath(dag, id, x)) continue
    if (descX.has(id)) continue
    if (hasDirectedPath(dag, y, id)) continue
    const exclusion = dSeparated(dag, id, y, [], { blockOutgoing: [x] })
    if (!exclusion.separated) continue
    candidates.push({
      node: id,
      conditions: {
        associated_with_treatment: true,
        not_descendant_of_treatment: true,
        no_path_to_outcome_except_through_treatment: true,
      },
    })
  }
  return candidates
}

function testableImplications(dag) {
  const { parents } = buildGraph(dag)
  const out = []
  for (const node of dag.nodes.slice(0, 30)) {
    const id = typeof node === 'string' ? node : node.id
    const desc = descendants(dag, id)
    const parentList = [...(parents.get(id) || [])].sort()
    const independent = dag.nodes
      .map((entry) => (typeof entry === 'string' ? entry : entry.id))
      .filter((other) => other !== id && !desc.has(other) && !parentList.includes(other))
      .sort()
    if (!independent.length) continue
    out.push({
      node: id,
      independent_of: independent.slice(0, 12),
      given: parentList,
      implication: `${id} ⫫ {${independent.slice(0, 6).join(', ')}${independent.length > 6 ? ', …' : ''}} | {${parentList.join(', ') || '∅'}}`,
    })
    if (out.length >= 20) break
  }
  return out
}

function colliderWarnings(dag, x, y, adjustFor = []) {
  const { parents, nodeMap } = buildGraph(dag)
  const descX = descendants(dag, x)
  const descY = descendants(dag, y)
  const backdoors = backdoorPaths(dag, x, y)
  const paths = undirectedPaths(dag, x, y)
  const collidersOnPaths = new Set()
  for (const path of paths) {
    for (let index = 1; index < path.length - 1; index += 1) {
      const node = path[index]
      const parentSet = parents.get(node) || new Set()
      if (parentSet.has(path[index - 1]) && parentSet.has(path[index + 1])) collidersOnPaths.add(node)
    }
  }
  const warnings = []
  for (const node of dag.nodes) {
    const id = typeof node === 'string' ? node : node.id
    const parentList = [...(parents.get(id) || [])].sort()
    if (parentList.length < 2) continue
    const onBackdoor = backdoors.some((path) => path.includes(id))
    warnings.push({
      node: id,
      parents: parentList,
      descendant_of_treatment: descX.has(id),
      descendant_of_outcome: descY.has(id),
      on_a_backdoor_path: onBackdoor,
      on_treatment_outcome_path: collidersOnPaths.has(id),
      conditioning_risk: collidersOnPaths.has(id),
      note: 'Conditioning on a collider that lies on a treatment–outcome path can open a non-causal path. This is a graph warning, not evidence of bias in a fitted model.',
    })
  }
  const adjustmentWarnings = []
  for (const id of adjustFor) {
    if (!nodeMap.has(id)) {
      adjustmentWarnings.push({ node: id, status: 'not_found', detail: 'node is not in the DAG' })
      continue
    }
    if (nodeMap.get(id).observed === false) adjustmentWarnings.push({ node: id, status: 'unobserved', detail: 'an unobserved node cannot be adjusted for; the graph must account for it as unmeasured confounding' })
    if (descX.has(id)) adjustmentWarnings.push({ node: id, status: 'descendant_of_treatment', detail: 'adjusting for a descendant of treatment can introduce bias' })
    if (collidersOnPaths.has(id)) adjustmentWarnings.push({ node: id, status: 'collider', detail: 'adjusting for a collider on a treatment–outcome path can open a non-causal path' })
  }
  return { colliders: warnings, adjustment_warnings: adjustmentWarnings, backdoor_paths: backdoors.slice(0, 20).map((path) => path.join(' - ')) }
}

export function analyzeDag(dag, { x = null, y = null, given = [], adjustFor = [] } = {}) {
  const treatment = x || dag.treatment
  const outcome = y || dag.outcome
  if (!treatment || !outcome) throw new Error('analysis needs treatment and outcome (store them on the DAG or pass x and y)')
  const { nodes, nodeMap } = buildGraph(dag)
  if (!nodeMap.has(treatment)) throw new Error(`treatment "${treatment}" is not a node in the DAG`)
  if (!nodeMap.has(outcome)) throw new Error(`outcome "${outcome}" is not a node in the DAG`)
  if (treatment === outcome) throw new Error('treatment and outcome must be different nodes')
  if (!isAcyclic(dag)) throw new Error('the graph has a directed cycle; a causal DAG must be acyclic')

  const candidateInfo = adjustmentCandidates(dag, treatment, outcome)
  const pool = candidateInfo.candidates.slice(0, MAX_ADJUSTMENT_CANDIDATES)
  const valid = []
  for (const set of allSubsets(pool)) {
    const result = dSeparated(dag, treatment, outcome, set, { blockOutgoing: [treatment] })
    if (result.separated) valid.push(set)
  }
  const minimal = minimalSets(valid)
  const parentSet = [...(buildGraph(dag).parents.get(treatment) || [])].filter((id) => nodeMap.get(id)?.observed !== false).sort()
  const parentSetValid = parentSet.length && dSeparated(dag, treatment, outcome, parentSet, { blockOutgoing: [treatment] }).separated
  const emptyValid = valid.some((set) => set.length === 0)
  const backdoor = {
    status: emptyValid ? 'no_open_backdoor_path' : minimal.length ? 'adjustment_sets_found' : candidateInfo.truncated ? 'truncated' : 'no_adjustment_set',
    candidate_count: candidateInfo.candidates.length,
    truncated: candidateInfo.truncated,
    minimal_sets: minimal,
    parents_of_treatment: parentSet,
    parents_of_treatment_valid: Boolean(parentSetValid),
    paths: backdoorPaths(dag, treatment, outcome).slice(0, 20).map((path) => path.join(' - ')),
    note: candidateInfo.truncated
      ? 'More than 12 candidate adjustment nodes; only the first 12 (treatment ancestors first) were enumerated. Treat an empty result as incomplete.'
      : 'A minimal set is minimal by inclusion among the enumerated subsets; it is not automatically the best set for estimation.',
  }

  const colliders = colliderWarnings(dag, treatment, outcome, adjustFor)
  return {
    treatment,
    outcome,
    nodes: nodes.length,
    edges: dag.edges.length,
    top_order: topologicalOrder(dag),
    d_separation: {
      x: treatment,
      y: outcome,
      given: [...given],
      ...dSeparated(dag, treatment, outcome, given),
    },
    backdoor,
    front_door: frontDoorSets(dag, treatment, outcome),
    instruments: {
      candidates: instrumentCandidates(dag, treatment, outcome),
      caveat: 'A candidate satisfies the graph conditions for an instrument; it says nothing about effect homogeneity, monotonicity, or unmeasured confounding.',
    },
    colliders: colliders.colliders,
    adjustment_warnings: colliders.adjustment_warnings,
    testable_implications: testableImplications(dag),
    assumptions: [
      'The graph is user-specified; arrows are assumed to be the only direct causal relations.',
      'No model is fitted and no effect is estimated here.',
      'Adjustment sets are valid only if the graph (including unmeasured common causes) is correct.',
      'E-values are a sensitivity aid, not evidence that an unmeasured confounder is absent or small.',
    ],
  }
}

function topologicalOrder(dag) {
  const { nodes, children } = buildGraph(dag)
  const indegree = new Map(nodes.map((id) => [id, 0]))
  for (const [, to] of dag.edges) indegree.set(to, (indegree.get(to) || 0) + 1)
  const queue = nodes.filter((id) => indegree.get(id) === 0).sort()
  const order = []
  while (queue.length) {
    const id = queue.shift()
    order.push(id)
    for (const child of [...(children.get(id) || [])].sort()) {
      indegree.set(child, indegree.get(child) - 1)
      if (indegree.get(child) === 0) queue.push(child)
    }
  }
  return order
}

function rrEvalue(rr) {
  if (!Number.isFinite(rr) || rr <= 0) throw new Error('effect estimate must be positive')
  const value = rr >= 1 ? rr : 1 / rr
  return value + Math.sqrt(value * (value - 1))
}

/**
 * VanderWeele & Ding E-value. For OR and HR the E-value uses the square-root
 * (OR) or direct hazard-ratio approximation; for a standardized mean difference
 * it converts d to RR with exp(0.91·d). These are approximations and are
 * labelled as such.
 */
export function computeEValue({ measure, estimate, ciLow = null, ciHigh = null }) {
  const kind = String(measure || '').toUpperCase()
  if (!['RR', 'OR', 'HR', 'SMD'].includes(kind)) throw new Error('measure must be RR, OR, HR, or SMD')
  const value = Number(estimate)
  if (!Number.isFinite(value)) throw new Error('estimate must be a number')
  const caveats = []
  let rr
  let rrLow = null
  let rrHigh = null
  if (kind === 'RR' || kind === 'HR') {
    rr = value
    if (kind === 'HR') caveats.push('The hazard ratio is treated like a risk ratio; this is an approximation that ignores censoring and time-varying effects.')
    if (ciLow != null) rrLow = lengthCheck(Number(ciLow), 'ci_low')
    if (ciHigh != null) rrHigh = lengthCheck(Number(ciHigh), 'ci_high')
  } else if (kind === 'OR') {
    if (value <= 0) throw new Error('odds ratio must be positive')
    rr = Math.sqrt(value)
    if (ciLow != null) rrLow = Math.sqrt(lengthCheck(Number(ciLow), 'ci_low'))
    if (ciHigh != null) rrHigh = Math.sqrt(lengthCheck(Number(ciHigh), 'ci_high'))
    caveats.push('The odds ratio is converted with RR ≈ sqrt(OR); the approximation is reasonable mainly for rare outcomes. A common outcome needs a different sensitivity analysis.')
  } else {
    rr = Math.exp(0.91 * value)
    if (ciLow != null) rrLow = Math.exp(0.91 * Number(ciLow))
    if (ciHigh != null) rrHigh = Math.exp(0.91 * Number(ciHigh))
    caveats.push('A standardized mean difference is converted to an approximate risk ratio with exp(0.91·d); the E-value is approximate and the original scale should be reported.')
  }
  const eValue = rrEvalue(rr)
  let ci = null
  let ciIncludedNull = null
  if (rrLow != null && rrHigh != null) {
    ciIncludedNull = kind === 'SMD'
      ? Number(ciLow) <= 0 && Number(ciHigh) >= 0
      : rrLow <= 1 && rrHigh >= 1
    if (ciIncludedNull) {
      ci = 1
      caveats.push('The confidence interval includes the null, so the E-value for the interval is 1.')
    } else {
      const bound = rr >= 1 ? rrLow : rrHigh
      ci = rrEvalue(bound)
    }
  }
  return {
    measure: kind,
    estimate: value,
    ci_low: ciLow,
    ci_high: ciHigh,
    rr_used: rr,
    e_value: eValue,
    e_value_ci: ci,
    ci_includes_null: ciIncludedNull,
    formula: 'E = RR + sqrt(RR × (RR − 1)), with RR inverted below 1; the interval E-value uses the confidence limit closest to the null.',
    caveats: [
      ...caveats,
      'An E-value is the minimum strength of association an unmeasured confounder would need with both treatment and outcome to explain away the estimate; it is a sensitivity aid, not a test of causation.',
    ],
  }
}

function lengthCheck(value, name) {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`)
  return value
}
