/**
 * Dependency-free graph algorithms for citation_network.
 *
 * Graphs are `{ nodes: [{id,...}], edges: [{from,to}] }` where an edge means
 * "from cites to". Everything iterates in sorted id order so results are
 * deterministic for the same graph. Betweenness, components, and communities
 * treat the graph as undirected; degree, PageRank, and path (by default) use
 * the citation direction.
 */

function index(graph) {
  const ids = graph.nodes.map((n) => n.id).sort()
  const pos = new Map(ids.map((id, i) => [id, i]))
  const out = ids.map(() => new Set())
  const inn = ids.map(() => new Set())
  for (const edge of graph.edges) {
    const a = pos.get(edge.from)
    const b = pos.get(edge.to)
    if (a === undefined || b === undefined || a === b) continue
    out[a].add(b)
    inn[b].add(a)
  }
  const und = ids.map((_, i) => [...new Set([...out[i], ...inn[i]])].sort((x, y) => x - y))
  return { ids, pos, out: out.map((s) => [...s].sort((x, y) => x - y)), inn: inn.map((s) => [...s].sort((x, y) => x - y)), und }
}

export function degrees(graph) {
  const g = index(graph)
  return g.ids.map((id, i) => ({ id, in_degree: g.inn[i].length, out_degree: g.out[i].length }))
}

export function pagerank(graph, { damping = 0.85, iterations = 100, tolerance = 1e-10 } = {}) {
  const g = index(graph)
  const n = g.ids.length
  if (!n) return {}
  let rank = new Array(n).fill(1 / n)
  for (let step = 0; step < iterations; step += 1) {
    const next = new Array(n).fill((1 - damping) / n)
    let dangling = 0
    for (let i = 0; i < n; i += 1) {
      if (!g.out[i].length) dangling += rank[i]
      else for (const j of g.out[i]) next[j] += (damping * rank[i]) / g.out[i].length
    }
    for (let i = 0; i < n; i += 1) next[i] += (damping * dangling) / n
    const delta = next.reduce((sum, value, i) => sum + Math.abs(value - rank[i]), 0)
    rank = next
    if (delta < tolerance) break
  }
  return Object.fromEntries(g.ids.map((id, i) => [id, rank[i]]))
}

/** Brandes betweenness on the undirected graph, normalised to [0,1]. */
export function betweenness(graph) {
  const g = index(graph)
  const n = g.ids.length
  const score = new Array(n).fill(0)
  for (let s = 0; s < n; s += 1) {
    const stack = []
    const pred = Array.from({ length: n }, () => [])
    const sigma = new Array(n).fill(0)
    const dist = new Array(n).fill(-1)
    sigma[s] = 1
    dist[s] = 0
    const queue = [s]
    for (let head = 0; head < queue.length; head += 1) {
      const v = queue[head]
      stack.push(v)
      for (const w of g.und[v]) {
        if (dist[w] < 0) { dist[w] = dist[v] + 1; queue.push(w) }
        if (dist[w] === dist[v] + 1) { sigma[w] += sigma[v]; pred[w].push(v) }
      }
    }
    const delta = new Array(n).fill(0)
    while (stack.length) {
      const w = stack.pop()
      for (const v of pred[w]) delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w])
      if (w !== s) score[w] += delta[w]
    }
  }
  const norm = n > 2 ? 1 / ((n - 1) * (n - 2)) : 1
  return Object.fromEntries(g.ids.map((id, i) => [id, score[i] * norm]))
}

export function components(graph) {
  const g = index(graph)
  const seen = new Array(g.ids.length).fill(false)
  const groups = []
  for (let i = 0; i < g.ids.length; i += 1) {
    if (seen[i]) continue
    const group = []
    const queue = [i]
    seen[i] = true
    for (let head = 0; head < queue.length; head += 1) {
      group.push(g.ids[queue[head]])
      for (const w of g.und[queue[head]]) if (!seen[w]) { seen[w] = true; queue.push(w) }
    }
    groups.push(group.sort())
  }
  return groups.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]))
}

/** Bibliographic coupling (shared references) and co-citation (cited together), from the stored reference lists. */
export function couplingAndCocitation(nodes, { top = 20 } = {}) {
  const refs = new Map(nodes.map((n) => [n.id, new Set(n.refs || [])]))
  const ids = [...refs.keys()].sort()
  const coupling = []
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      let shared = 0
      for (const r of refs.get(ids[i])) if (refs.get(ids[j]).has(r)) shared += 1
      if (shared > 0) coupling.push({ a: ids[i], b: ids[j], shared_references: shared })
    }
  }
  const pairCount = new Map()
  const idSet = new Set(ids)
  for (const id of ids) {
    const inSet = [...refs.get(id)].filter((r) => idSet.has(r)).sort()
    for (let i = 0; i < inSet.length; i += 1) {
      for (let j = i + 1; j < inSet.length; j += 1) {
        const key = `${inSet[i]}|${inSet[j]}`
        pairCount.set(key, (pairCount.get(key) || 0) + 1)
      }
    }
  }
  const cocitation = [...pairCount].map(([key, count]) => { const [a, b] = key.split('|'); return { a, b, co_cited_by: count } })
  const order = (x, y, field) => y[field] - x[field] || x.a.localeCompare(y.a) || x.b.localeCompare(y.b)
  return {
    coupling: coupling.sort((x, y) => order(x, y, 'shared_references')).slice(0, top),
    cocitation: cocitation.sort((x, y) => order(x, y, 'co_cited_by')).slice(0, top),
    note: 'Coupling uses each paper\'s stored reference list (which can reach outside the graph); co-citation counts only citing papers inside the graph, so it is a lower bound.',
  }
}

/** Louvain community detection on the undirected graph (unit edge weights). Deterministic. */
export function louvain(graph, { maxPasses = 20 } = {}) {
  const g = index(graph)
  const n = g.ids.length
  let adj = g.und.map((list) => new Map(list.map((j) => [j, 1])))
  let members = g.ids.map((_, i) => [i])
  const m2Total = adj.reduce((sum, map) => sum + [...map.values()].reduce((a, b) => a + b, 0), 0)
  if (!m2Total) return Object.fromEntries(g.ids.map((id, i) => [id, i]))
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const size = adj.length
    const community = Array.from({ length: size }, (_, i) => i)
    const degree = adj.map((map) => [...map.values()].reduce((a, b) => a + b, 0))
    const total = degree.slice()
    let improved = false
    for (let sweep = 0; sweep < 50; sweep += 1) {
      let moved = false
      for (let v = 0; v < size; v += 1) {
        const links = new Map()
        for (const [w, weight] of adj[v]) if (w !== v) links.set(community[w], (links.get(community[w]) || 0) + weight)
        const own = community[v]
        total[own] -= degree[v]
        let best = own
        let bestGain = (links.get(own) || 0) - (total[own] * degree[v]) / m2Total
        for (const c of [...links.keys()].sort((a, b) => a - b)) {
          const gain = links.get(c) - (total[c] * degree[v]) / m2Total
          if (gain > bestGain + 1e-12) { best = c; bestGain = gain }
        }
        total[best] += degree[v]
        if (best !== own) { community[v] = best; moved = true; improved = true }
      }
      if (!moved) break
    }
    if (!improved) break
    const labels = [...new Set(community)].sort((a, b) => a - b)
    const relabel = new Map(labels.map((c, i) => [c, i]))
    const nextMembers = labels.map(() => [])
    const nextAdj = labels.map(() => new Map())
    for (let v = 0; v < size; v += 1) {
      const c = relabel.get(community[v])
      nextMembers[c].push(...members[v])
      for (const [w, weight] of adj[v]) {
        const cw = relabel.get(community[w])
        nextAdj[c].set(cw, (nextAdj[c].get(cw) || 0) + weight)
      }
    }
    members = nextMembers
    adj = nextAdj
    if (adj.length === size) break
  }
  const sorted = members.map((list) => list.slice().sort((a, b) => a - b)).sort((a, b) => b.length - a.length || a[0] - b[0])
  const result = {}
  sorted.forEach((list, label) => { for (const i of list) result[g.ids[i]] = label })
  return result
}

/** Shortest path by BFS. `directed` follows "cites" edges only; otherwise any link. */
export function shortestPath(graph, from, to, { directed = true } = {}) {
  const g = index(graph)
  const a = g.pos.get(from)
  const b = g.pos.get(to)
  if (a === undefined || b === undefined) return { found: false, reason: 'not_in_graph' }
  const prev = new Map([[a, -1]])
  const queue = [a]
  for (let head = 0; head < queue.length; head += 1) {
    const v = queue[head]
    if (v === b) break
    for (const w of (directed ? g.out[v] : g.und[v])) if (!prev.has(w)) { prev.set(w, v); queue.push(w) }
  }
  if (!prev.has(b)) return { found: false, reason: directed ? 'no_directed_path' : 'no_path' }
  const path = []
  for (let v = b; v !== -1; v = prev.get(v)) path.unshift(g.ids[v])
  return { found: true, length: path.length - 1, path }
}

const STOP = new Set('a an and are as at be by for from in into is it of on or the to with using use via towards toward based study analysis new approach method methods model models'.split(' '))

/** Cluster label: the most frequent title words, and the best-ranked paper. */
export function labelClusters(graph, assignment, ranks) {
  const byCluster = new Map()
  for (const node of graph.nodes) {
    const c = assignment[node.id]
    if (c === undefined) continue
    if (!byCluster.has(c)) byCluster.set(c, [])
    byCluster.get(c).push(node)
  }
  return [...byCluster].sort((x, y) => x[0] - y[0]).map(([cluster, nodes]) => {
    const words = new Map()
    for (const node of nodes) {
      for (const word of new Set(String(node.title || '').toLowerCase().match(/[a-z][a-z-]{3,}/g) || [])) {
        if (!STOP.has(word)) words.set(word, (words.get(word) || 0) + 1)
      }
    }
    const terms = [...words].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 3).map(([w]) => w)
    const lead = nodes.slice().sort((x, y) => (ranks[y.id] || 0) - (ranks[x.id] || 0) || x.id.localeCompare(y.id))[0]
    return { cluster, size: nodes.length, label: terms.join(' / ') || '(no common terms)', top_paper: { id: lead.id, title: lead.title, year: lead.year } }
  })
}
