/**
 * citation_network: build and analyze a citation graph around seed papers.
 *
 * `build` pulls works from OpenAlex (what the seeds cite, what cites them, or
 * both, to a small depth) and freezes the result under
 * `.dsh/network/<slug>/graph-<build>.json`, recording the source and the
 * retrieval time. Every other action is derived from a frozen build, so the
 * numbers are reproducible and nothing is re-fetched. The graph is a sample:
 * it is bounded by per-node and total limits and says when it was truncated.
 * Citation counts and centrality describe the sample, not paper quality, and
 * authors are not disambiguated.
 */
import { join } from 'node:path'
import { defineTool } from 'ah-dsh-tools'
import { resolveEnv } from './credential-env.js'
import {
  appendJsonl, csvCell, ensureDir, exportText, nowIso, readJson, readJsonl, sha256, shortHash, slug as slugify, writeOnceJson,
} from './ledger-kit.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { identifierKind } from './search-normalize.js'
import { withLock } from './store-lock.js'
import { resolveWorkspacePath } from './workspace-path.js'
import {
  betweenness, components, couplingAndCocitation, degrees, labelClusters, louvain, pagerank, shortestPath,
} from './citation-graph-algos.js'

export const NETWORK_ACTIONS = ['build', 'metrics', 'clusters', 'path', 'export', 'status']
export const NETWORK_DIRECTIONS = ['cites', 'cited_by', 'both']
export const NETWORK_EXPORTS = ['graphml', 'csv', 'mermaid']
const API = 'https://api.openalex.org'
const SELECT = 'id,doi,title,publication_year,cited_by_count,referenced_works,primary_location'
const LIMITS = { depth: 2, perNode: 100, nodes: 500, calls: 250, refs: 300 }

const shortId = (value) => String(value || '').match(/W\d+/)?.[0] || null
const dir = (cwd, slug) => join(cwd, '.dsh', 'network', slug)

function toNode(work, extra = {}) {
  const id = shortId(work?.id)
  if (!id) return null
  return {
    id,
    doi: work.doi ? String(work.doi).replace(/^https?:\/\/doi\.org\//i, '').toLowerCase() : null,
    title: work.title || '',
    year: work.publication_year ?? null,
    venue: work.primary_location?.source?.display_name || null,
    cited_by_count: work.cited_by_count ?? null,
    refs: (work.referenced_works || []).map(shortId).filter(Boolean).slice(0, LIMITS.refs),
    ...extra,
  }
}

function workPath(seed) {
  const parsed = identifierKind(seed)
  switch (parsed.kind) {
    case 'openalex': return `/works/${parsed.value}`
    case 'doi': return `/works/doi:${encodeURIComponent(parsed.value).replace(/%2F/gi, '/')}`
    case 'pmid': return `/works/pmid:${parsed.value}`
    case 'arxiv': return `/works/doi:10.48550/arXiv.${encodeURIComponent(parsed.value)}`
    default: return null
  }
}

export async function buildGraph({ seeds, direction, depth, perNode, maxNodes }, { signal, http = fetchJson } = {}) {
  const [apiKey, mailto] = await Promise.all([
    resolveEnv('OPENALEX_API_KEY'),
    resolveEnv('CROSSREF_MAILTO').then((v) => v || resolveEnv('UNPAYWALL_EMAIL')),
  ])
  const limiter = getLimiter('openalex', { minIntervalMs: apiKey ? 34 : 100 })
  const headers = { 'User-Agent': searchUserAgent(mailto) }
  let calls = 0
  const failures = []
  const get = async (url) => {
    if (calls >= LIMITS.calls) return { ok: false, error: 'call budget reached' }
    calls += 1
    return limiter.run(() => http(url, { signal, headers }))
  }
  const query = (params) => {
    const p = new URLSearchParams(params)
    if (apiKey) p.set('api_key', apiKey)
    if (mailto) p.set('mailto', mailto)
    return p
  }
  const nodes = new Map()
  let dropped = 0
  const add = (work, extra) => {
    const node = toNode(work, extra)
    if (!node || nodes.has(node.id)) return null
    if (nodes.size >= maxNodes) { dropped += 1; return null }
    nodes.set(node.id, node)
    return node
  }

  for (const seed of seeds) {
    const path = workPath(seed)
    if (!path) { failures.push({ seed, state: 'not_supported', error: 'seed must be a DOI, PMID, arXiv id, or OpenAlex id' }); continue }
    const res = await get(`${API}${path}?${query({ select: SELECT })}`)
    if (!res.ok || !res.data) { failures.push({ seed, state: res.status === 404 ? 'not_found' : 'error', error: res.error || 'no data' }); continue }
    add(res.data, { seed: true, depth: 0 })
  }
  let frontier = [...nodes.values()]
  for (let level = 1; level <= depth && frontier.length; level += 1) {
    const next = []
    for (const node of frontier) {
      if (direction !== 'cited_by') {
        const wanted = node.refs.filter((id) => !nodes.has(id)).slice(0, perNode)
        for (let i = 0; i < wanted.length; i += 50) {
          const chunk = wanted.slice(i, i + 50)
          const res = await get(`${API}/works?${query({ filter: `openalex_id:${chunk.join('|')}`, per_page: String(chunk.length), select: SELECT })}`)
          if (!res.ok) { failures.push({ node: node.id, state: 'error', error: res.error || 'fetch failed' }); break }
          for (const work of res.data?.results || []) { const added = add(work, { depth: level }); if (added) next.push(added) }
        }
      }
      if (direction !== 'cites') {
        const res = await get(`${API}/works?${query({ filter: `cites:${node.id}`, per_page: String(Math.min(perNode, 100)), sort: 'cited_by_count:desc', select: SELECT })}`)
        if (!res.ok) { failures.push({ node: node.id, state: 'error', error: res.error || 'fetch failed' }); continue }
        for (const work of res.data?.results || []) { const added = add(work, { depth: level }); if (added) next.push(added) }
      }
    }
    frontier = next
  }
  const list = [...nodes.values()]
  const edges = []
  for (const node of list) for (const ref of node.refs) if (nodes.has(ref) && ref !== node.id) edges.push({ from: node.id, to: ref })
  return {
    graph: { nodes: list, edges },
    truncated: dropped > 0 || calls >= LIMITS.calls,
    dropped_nodes: dropped,
    calls,
    failures,
  }
}

function loadBuild(cwd, slug, buildId) {
  const builds = readJsonl(join(dir(cwd, slug), 'builds.jsonl'))
  const row = buildId ? builds.find((b) => b.build_id === buildId) : builds[builds.length - 1]
  if (!row) throw new Error(`no citation network "${slug}"${buildId ? ` build ${buildId}` : ''}; run build first`)
  const frozen = readJson(join(dir(cwd, slug), row.file))
  if (!frozen) throw new Error(`build file ${row.file} is missing`)
  if (sha256(frozen.graph) !== row.graph_hash) throw new Error(`build ${row.build_id} no longer matches its recorded hash; it was edited after the build`)
  return { row, frozen }
}

function top(map, n, nodes) {
  const byId = new Map(nodes.map((x) => [x.id, x]))
  return Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n)
    .map(([id, value]) => ({ id, value: Number(value.toFixed(6)), title: byId.get(id)?.title, year: byId.get(id)?.year }))
}

function xml(value) {
  return String(value ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

export function toGraphMl(graph) {
  const keys = [['title', 'string'], ['year', 'int'], ['doi', 'string'], ['cited_by_count', 'int'], ['seed', 'boolean']]
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    ...keys.map(([name, type]) => `  <key id="${name}" for="node" attr.name="${name}" attr.type="${type}"/>`),
    '  <graph id="G" edgedefault="directed">']
  for (const node of graph.nodes) {
    lines.push(`    <node id="${xml(node.id)}">`)
    for (const [name] of keys) {
      const value = name === 'seed' ? Boolean(node.seed) : node[name]
      if (value !== null && value !== undefined && value !== '') lines.push(`      <data key="${name}">${xml(value)}</data>`)
    }
    lines.push('    </node>')
  }
  graph.edges.forEach((edge, i) => lines.push(`    <edge id="e${i}" source="${xml(edge.from)}" target="${xml(edge.to)}"/>`))
  lines.push('  </graph>', '</graphml>')
  return `${lines.join('\n')}\n`
}

export function toMermaid(graph, { max = 60 } = {}) {
  const ranks = pagerank(graph)
  const keep = graph.nodes.slice().sort((a, b) => (ranks[b.id] || 0) - (ranks[a.id] || 0) || a.id.localeCompare(b.id)).slice(0, max)
  const ids = new Set(keep.map((n) => n.id))
  const label = (n) => `${(n.title || n.id).slice(0, 40).replace(/["\[\]()<>]/g, ' ')} (${n.year ?? 'n.d.'})`
  const lines = ['flowchart LR', ...keep.map((n) => `  ${n.id}["${label(n)}"]`)]
  for (const e of graph.edges) if (ids.has(e.from) && ids.has(e.to)) lines.push(`  ${e.from} --> ${e.to}`)
  if (graph.nodes.length > max) lines.push(`  %% ${graph.nodes.length - max} lower-ranked node(s) omitted`)
  return `${lines.join('\n')}\n`
}

export async function runCitationNetwork(args, exec, deps = {}) {
  const action = args.action || 'status'
  if (!NETWORK_ACTIONS.includes(action)) throw new Error(`action must be one of ${NETWORK_ACTIONS.join(', ')}`)
  const cwd = exec?.agent?.session?.header?.cwd || process.cwd()
  const slug = slugify(args.slug || '')
  if (!slug) throw new Error('slug is required')
  const n = Math.min(Math.max(Number(args.top) || 10, 1), 50)

  if (action === 'build') {
    const seeds = [...new Set([args.seed, ...(Array.isArray(args.seeds) ? args.seeds : [])].map((s) => String(s || '').trim()).filter(Boolean))]
    if (!seeds.length) throw new Error('give seed or seeds (DOI, PMID, arXiv id, or OpenAlex id)')
    const direction = args.direction || 'both'
    if (!NETWORK_DIRECTIONS.includes(direction)) throw new Error(`direction must be one of ${NETWORK_DIRECTIONS.join(', ')}`)
    const params = {
      seeds, direction,
      depth: Math.min(Math.max(Math.trunc(Number(args.depth)) || 1, 1), LIMITS.depth),
      perNode: Math.min(Math.max(Math.trunc(Number(args.limit_per_node)) || 25, 1), LIMITS.perNode),
      maxNodes: Math.min(Math.max(Math.trunc(Number(args.max_nodes)) || 150, 2), LIMITS.nodes),
    }
    const built = await (deps.buildGraph || buildGraph)(params, { signal: exec?.signal, http: deps.fetchJson })
    if (!built.graph.nodes.length) return { action, slug, state: 'not_found', failures: built.failures, error: 'no seed could be resolved, so no graph was built' }
    ensureDir(dir(cwd, slug))
    return withLock(dir(cwd, slug), async () => {
      const buildId = `b-${shortHash(`${slug}|${nowIso()}|${Math.random()}`, 10)}`
      const file = `graph-${buildId}.json`
      const frozen = { build_id: buildId, source: 'openalex', retrieved_at: deps.now || nowIso(), params, truncated: built.truncated, dropped_nodes: built.dropped_nodes, graph: built.graph }
      writeOnceJson(join(dir(cwd, slug), file), frozen)
      const row = { build_id: buildId, built_at: frozen.retrieved_at, file, source: 'openalex', params, nodes: built.graph.nodes.length, edges: built.graph.edges.length, truncated: built.truncated, graph_hash: sha256(built.graph), failures: built.failures.length }
      appendJsonl(join(dir(cwd, slug), 'builds.jsonl'), [row])
      return { action, slug, build: row, failures: built.failures, dropped_nodes: built.dropped_nodes }
    }, { label: 'network' })
  }

  if (action === 'status') {
    const builds = readJsonl(join(dir(cwd, slug), 'builds.jsonl'))
    return { action, slug, builds }
  }

  const { row, frozen } = loadBuild(cwd, slug, args.build_id)
  const graph = frozen.graph
  const provenance = { build_id: row.build_id, source: frozen.source, retrieved_at: frozen.retrieved_at, truncated: frozen.truncated, nodes: graph.nodes.length, edges: graph.edges.length }
  const caveats = ['Citation counts and centrality describe this sample, not paper quality.', 'The graph is bounded by per-node and total limits; absence from it does not mean absence of a citation.', 'Authors are not disambiguated.']

  if (action === 'metrics') {
    const ranks = pagerank(graph)
    const between = betweenness(graph)
    const deg = degrees(graph)
    const byId = new Map(graph.nodes.map((x) => [x.id, x]))
    const comps = components(graph)
    return {
      action, slug, ...provenance,
      top_in_degree: deg.sort((a, b) => b.in_degree - a.in_degree || a.id.localeCompare(b.id)).slice(0, n).map((d) => ({ id: d.id, value: d.in_degree, title: byId.get(d.id)?.title, year: byId.get(d.id)?.year })),
      top_pagerank: top(ranks, n, graph.nodes),
      top_betweenness: top(between, n, graph.nodes),
      components: { count: comps.length, sizes: comps.slice(0, 10).map((c) => c.length) },
      ...couplingAndCocitation(graph.nodes, { top: n }),
      caveats,
    }
  }
  if (action === 'clusters') {
    const assignment = louvain(graph)
    return { action, slug, ...provenance, method: 'Louvain on the undirected citation graph (deterministic)', clusters: labelClusters(graph, assignment, pagerank(graph)), caveats: [...caveats, 'Cluster labels are the most frequent title words, not a topic model.'] }
  }
  if (action === 'path') {
    const from = shortId(args.from) || String(args.from || '').trim()
    const to = shortId(args.to) || String(args.to || '').trim()
    const resolve = (ref) => graph.nodes.find((x) => x.id === ref || x.doi === String(ref).toLowerCase())?.id || ref
    const result = shortestPath(graph, resolve(from), resolve(to), { directed: args.directed !== false })
    const byId = new Map(graph.nodes.map((x) => [x.id, x]))
    return { action, slug, ...provenance, directed: args.directed !== false, ...result, path: result.path?.map((id) => ({ id, title: byId.get(id)?.title, year: byId.get(id)?.year })), caveats: ['A path in a sampled graph is not the only or shortest path in the literature.'] }
  }
  // export
  const format = args.format || 'graphml'
  if (!NETWORK_EXPORTS.includes(format)) throw new Error(`format must be one of ${NETWORK_EXPORTS.join(', ')}`)
  if (!args.out) throw new Error('out is required for export (workspace-relative path; for csv, a base name)')
  const written = []
  const write = (rel, body) => written.push(exportText(resolveWorkspacePath(cwd, rel, { forWrite: true }), body, { overwrite: Boolean(args.overwrite) }))
  if (format === 'graphml') write(args.out, toGraphMl(graph))
  else if (format === 'mermaid') write(args.out, toMermaid(graph, { max: Math.min(Number(args.max_nodes) || 60, 200) }))
  else {
    const base = String(args.out).replace(/\.csv$/i, '')
    write(`${base}-nodes.csv`, `${['id,doi,title,year,venue,cited_by_count,seed', ...graph.nodes.map((x) => [x.id, x.doi, x.title, x.year, x.venue, x.cited_by_count, x.seed ? 1 : 0].map(csvCell).join(','))].join('\n')}\n`)
    write(`${base}-edges.csv`, `${['from,to', ...graph.edges.map((e) => `${e.from},${e.to}`)].join('\n')}\n`)
  }
  return { action, slug, ...provenance, format, written }
}

function render(value) {
  if (value?.error) return [{ type: 'text', text: `Error: ${value.error}${value.failures?.length ? ` (${value.failures.map((f) => `${f.seed || f.node}: ${f.state}`).join('; ')})` : ''}` }]
  const t = (text) => [{ type: 'text', text }]
  const head = value.build_id ? `Network "${value.slug}" build ${value.build_id} · ${value.source} · ${value.retrieved_at} · ${value.nodes} nodes, ${value.edges} edges${value.truncated ? ' · TRUNCATED' : ''}` : ''
  const list = (items) => items.map((x) => `  ${x.value}  ${x.id}  ${(x.title || '').slice(0, 70)} (${x.year ?? 'n.d.'})`).join('\n')
  switch (value.action) {
    case 'build': return t(`Built "${value.slug}" ${value.build.build_id}: ${value.build.nodes} nodes, ${value.build.edges} edges from ${value.build.source}${value.build.truncated ? ` — TRUNCATED (${value.dropped_nodes} node(s) dropped or call budget reached)` : ''}.${value.failures.length ? ` ${value.failures.length} fetch failure(s): ${value.failures.slice(0, 3).map((f) => `${f.seed || f.node} ${f.state}`).join('; ')}.` : ''}`)
    case 'status': return t(value.builds.length ? value.builds.map((b) => `- ${b.build_id} ${b.built_at}: ${b.nodes} nodes, ${b.edges} edges${b.truncated ? ' (truncated)' : ''}`).join('\n') : `No builds for "${value.slug}".`)
    case 'metrics': return t([head, 'In-degree:', list(value.top_in_degree), 'PageRank:', list(value.top_pagerank), 'Betweenness (undirected):', list(value.top_betweenness), `Components: ${value.components.count} (sizes ${value.components.sizes.join(', ')})`, `Bibliographic coupling (top): ${value.coupling.slice(0, 5).map((c) => `${c.a}~${c.b} ${c.shared_references}`).join('; ') || 'none'}`, `Co-citation (top): ${value.cocitation.slice(0, 5).map((c) => `${c.a}~${c.b} ${c.co_cited_by}`).join('; ') || 'none'}`, ...value.caveats.map((c) => `Note: ${c}`)].join('\n'))
    case 'clusters': return t([head, value.method, ...value.clusters.map((c) => `- cluster ${c.cluster} (${c.size}): ${c.label} — lead: ${(c.top_paper.title || c.top_paper.id).slice(0, 70)} (${c.top_paper.year ?? 'n.d.'})`), ...value.caveats.map((c) => `Note: ${c}`)].join('\n'))
    case 'path': return t([head, value.found ? `Path (${value.length} step${value.length === 1 ? '' : 's'}${value.directed ? ', following citations' : ', any direction'}):\n${value.path.map((p) => `  ${p.id} ${(p.title || '').slice(0, 70)} (${p.year ?? 'n.d.'})`).join('\n  ↓\n')}` : `No path: ${value.reason}.`, ...value.caveats.map((c) => `Note: ${c}`)].join('\n'))
    case 'export': return t(`Wrote ${value.written.map((w) => w.path).join(', ')} (${value.format}).`)
    default: return t(JSON.stringify(value, null, 2))
  }
}

/** The host requires lossless JSON: no `undefined` fields, no non-finite numbers. */
function plain(value) {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)))
}

export const name = 'academic-harness-citation-network'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'citation_network',
    description: [
      'Build and analyze a citation graph around seed papers, frozen under `.dsh/network/<slug>/`: `build` (OpenAlex; what seeds cite, what cites them, or both; depth 1-2, per-node and total limits), then `metrics` (degree, PageRank, betweenness, components, bibliographic coupling, co-citation), `clusters` (Louvain with title-term labels), `path` (shortest citation path), `export` (GraphML, CSV, Mermaid), and `status`.',
      'Every build records source, retrieval time, and truncation. Analysis reads the frozen build and is reproducible. The graph is a bounded sample: centrality and citation counts are not quality, absence of an edge is not absence of a citation, and authors are not disambiguated. Load the `citation-network` skill.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: NETWORK_ACTIONS, description: 'build, metrics, clusters, path, export, or status. Default status.' },
      slug: { type: 'string', description: 'Network name (a directory under .dsh/network/).' },
      seed: { type: 'string', description: 'build: seed paper (DOI, PMID, arXiv id, or OpenAlex id).' },
      seeds: { type: 'array', items: { type: 'string' }, description: 'build: several seeds.' },
      direction: { type: 'string', enum: NETWORK_DIRECTIONS, description: 'build: cites (what seeds cite), cited_by, or both (default).' },
      depth: { type: 'number', description: 'build: hops from the seeds, 1-2. Default 1.' },
      limit_per_node: { type: 'number', description: 'build: most neighbours per node per direction, 1-100. Default 25.' },
      max_nodes: { type: 'number', description: 'build: total node cap, 2-500 (default 150). mermaid export: nodes drawn (default 60).' },
      build_id: { type: 'string', description: 'Analyze this build instead of the latest.' },
      top: { type: 'number', description: 'metrics: rows per ranking, 1-50. Default 10.' },
      from: { type: 'string', description: 'path: start paper (OpenAlex id or DOI in the graph).' },
      to: { type: 'string', description: 'path: end paper.' },
      directed: { type: 'boolean', description: 'path: follow citations only (default true); false allows any direction.' },
      format: { type: 'string', enum: NETWORK_EXPORTS, description: 'export format (default graphml).' },
      out: { type: 'string', description: 'export: workspace-relative path (csv: a base name, writes -nodes.csv and -edges.csv).' },
      overwrite: { type: 'boolean', description: 'export: replace existing files.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => render(value) },
    async execute(args, exec) {
      try {
        return plain(await runCitationNetwork(args, exec))
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Citation network: ${args.slug || ''} (${args.action || 'status'})`, kind: 'other' }
    },
  }))
}
