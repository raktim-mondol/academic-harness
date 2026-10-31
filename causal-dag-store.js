/**
 * Causal DAG ledger under `<cwd>/.dsh/causal/<slug>/`.
 *
 * The DAG is user-specified and versioned append-only. Analysis derives graph
 * implications only; it does not fit a model or estimate an effect. E-values
 * are recorded as sensitivity calculations, never as proof of robustness.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  appendJsonl, ensureDir, exportText, nowIso, readJsonl,
  sha256, slug as slugify, stableStringify,
} from './ledger-kit.js'
import { withLock } from './store-lock.js'
import { resolveWorkspacePath } from './workspace-path.js'
import { analyzeDag, buildGraph, computeEValue, isAcyclic } from './causal-graph.js'

export const CAUSAL_ACTIONS = ['create', 'edit', 'analyze', 'evalues', 'export', 'status']
export const CAUSAL_EXPORT_FORMATS = ['mermaid', 'dot', 'edge_list', 'json']
export const EVALUE_MEASURES = ['RR', 'OR', 'HR', 'SMD']
const MAX_TEXT_BYTES = 1 * 1024 * 1024

function text(value) {
  return String(value ?? '').trim()
}

export function causalSlug(value) {
  const slug = slugify(value, 80)
  if (!slug) throw new Error('slug must contain at least one letter or digit')
  return slug
}

export function causalDir(cwd, value) {
  return join(cwd, '.dsh', 'causal', causalSlug(value))
}

function files(cwd, value) {
  const dir = causalDir(cwd, value)
  return {
    dir,
    dag: join(dir, 'dag.jsonl'),
    analyses: join(dir, 'analyses.jsonl'),
    evalues: join(dir, 'evalues.jsonl'),
    exports: join(dir, 'exports'),
  }
}

const NODE_ID = /^[A-Za-z0-9_.:-]+$/

function validId(id) {
  if (!NODE_ID.test(id)) throw new Error(`node id "${id}" must use only letters, digits, "_", ".", ":", or "-" (put free text in label)`)
  return id
}

function normalizeNode(entry) {
  if (typeof entry === 'string') {
    const id = text(entry)
    if (!id) throw new Error('node ids must not be empty')
    return { id: validId(id), label: null, observed: true }
  }
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const id = text(entry.id || entry.name)
    if (!id) throw new Error('each node needs an id')
    validId(id)
    const latent = entry.latent === true
    const observed = entry.observed == null ? !latent : entry.observed !== false
    return {
      id,
      label: text(entry.label) || null,
      observed: observed && !latent,
    }
  }
  throw new Error('nodes must be strings or {id, label?, observed?, latent?} objects')
}

function normalizeEdge(entry, known) {
  let from
  let to
  if (typeof entry === 'string') {
    const match = entry.match(/^\s*"?([^"\s]+)"?\s*(?:->|→)\s*"?([^"\s]+)"?\s*$/)
    if (!match) throw new Error(`edge "${entry}" must look like "A -> B"`)
    from = match[1]
    to = match[2]
  } else if (Array.isArray(entry) && entry.length === 2) {
    from = text(entry[0])
    to = text(entry[1])
  } else if (entry && typeof entry === 'object') {
    from = text(entry.from || entry.source)
    to = text(entry.to || entry.target)
  }
  if (!from || !to) throw new Error('each edge needs from and to')
  validId(from)
  validId(to)
  if (from === to) throw new Error(`self-loop at "${from}"; a DAG cannot contain a self-loop`)
  if (known) {
    if (!known.has(from)) throw new Error(`edge endpoint "${from}" is not a declared node`)
    if (!known.has(to)) throw new Error(`edge endpoint "${to}" is not a declared node`)
  }
  return [from, to]
}

export function normalizeDag({ nodes = null, edges = [], treatment = null, outcome = null, label = null } = {}) {
  const rawEdges = edges == null ? [] : Array.isArray(edges) ? edges : [edges]
  const parsedEdges = rawEdges.map((edge) => normalizeEdge(edge, null))
  const declared = nodes == null ? [] : (Array.isArray(nodes) ? nodes : [nodes]).map(normalizeNode)
  const byId = new Map(declared.map((node) => [node.id, node]))
  for (const [from, to] of parsedEdges) {
    if (!byId.has(from)) byId.set(from, { id: from, label: null, observed: true })
    if (!byId.has(to)) byId.set(to, { id: to, label: null, observed: true })
  }
  if (nodes != null) {
    for (const [from, to] of parsedEdges) {
      if (!declared.some((node) => node.id === from) || !declared.some((node) => node.id === to)) {
        throw new Error('edges must reference declared nodes; add the node or omit nodes to derive it from the edges')
      }
    }
  }
  if (!byId.size) throw new Error('the DAG needs at least one node')
  const cleanEdges = [...new Map(parsedEdges.map(([from, to]) => [`${from}\u0000${to}`, [from, to]])).values()]
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
  const dag = {
    label: text(label) || null,
    nodes: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: cleanEdges,
    treatment: text(treatment) || null,
    outcome: text(outcome) || null,
  }
  for (const role of ['treatment', 'outcome']) {
    if (dag[role] && !byId.has(dag[role])) throw new Error(`${role} "${dag[role]}" is not a node in the DAG`)
  }
  if (!isAcyclic(dag)) {
    throw new Error('the graph has a directed cycle; a causal DAG must be acyclic')
  }
  return dag
}

export function dagHash(dag) {
  return `sha256:${sha256(stableStringify(dag))}`
}

function latestEvent(cwd, slug) {
  return readJsonl(files(cwd, slug).dag).at(-1) || null
}

export function readCausalDag(cwd, slug) {
  const latest = latestEvent(cwd, slug)
  if (!latest) throw new Error(`causal DAG "${causalSlug(slug)}" has not been created`)
  const analysis = readJsonl(files(cwd, slug).analyses).at(-1) || null
  return {
    ...latest.dag,
    version: latest.version,
    hash: latest.hash,
    created_at: latest.created_at,
    reason: latest.reason || null,
    adjustment: analysis?.analysis?.backdoor?.minimal_sets?.[0] || null,
    latest_analysis: analysis,
  }
}

export async function createCausalDag({ cwd, slug, nodes = null, edges = [], treatment = null, outcome = null, label = null, reason = null, recordedBy = null }) {
  const f = files(cwd, slug)
  // Validate before creating the ledger directory, so a rejected DAG leaves no
  // empty directory behind.
  const dag = normalizeDag({ nodes, edges, treatment, outcome, label })
  const hash = dagHash(dag)
  ensureDir(f.dir)
  return withLock(f.dir, async () => {
    const latest = latestEvent(cwd, slug)
    if (latest) {
      if (latest.hash === hash) return { slug: causalSlug(slug), version: latest.version, hash, unchanged: true, dag }
      throw new Error('a DAG already exists for this slug; use action=edit with a reason to add a version')
    }
    const event = {
      version: 1, dag, hash, created_at: nowIso(), reason: text(reason) || null,
      recorded_by: text(recordedBy) || null,
    }
    appendJsonl(f.dag, [event])
    return { slug: causalSlug(slug), version: 1, hash, created: true, dag }
  }, { label: 'causal DAG ledger' })
}

function applyOps(dag, args) {
  let nodes = dag.nodes
  let edges = dag.edges
  if (args.dag && typeof args.dag === 'object') {
    nodes = args.dag.nodes ?? nodes
    edges = args.dag.edges ?? edges
  }
  if (args.add_nodes?.length) nodes = [...nodes, ...args.add_nodes]
  if (args.add_edges?.length) edges = [...edges, ...args.add_edges]
  if (args.remove_nodes?.length) {
    const remove = new Set(args.remove_nodes.map(text))
    nodes = nodes.filter((node) => !remove.has(node.id))
    edges = edges.filter(([from, to]) => !remove.has(from) && !remove.has(to))
  }
  if (args.remove_edges?.length) {
    const remove = new Set(args.remove_edges.map((edge) => {
      const [from, to] = normalizeEdge(edge, null)
      return `${from}\u0000${to}`
    }))
    edges = edges.filter(([from, to]) => !remove.has(`${from}\u0000${to}`))
  }
  return {
    nodes,
    edges,
    treatment: args.treatment !== undefined ? args.treatment : dag.treatment,
    outcome: args.outcome !== undefined ? args.outcome : dag.outcome,
    label: args.label !== undefined ? args.label : dag.label,
  }
}

export async function editCausalDag({ cwd, slug, ...args }) {
  const f = files(cwd, slug)
  ensureDir(f.dir)
  return withLock(f.dir, async () => {
    const latest = latestEvent(cwd, slug)
    if (!latest) throw new Error(`causal DAG "${causalSlug(slug)}" has not been created`)
    if (!text(args.reason)) throw new Error('editing a causal DAG requires a reason (the earlier version stays)')
    const dag = normalizeDag(applyOps(latest.dag, args))
    const hash = dagHash(dag)
    if (hash === latest.hash) return { slug: causalSlug(slug), version: latest.version, hash, unchanged: true, dag }
    const event = {
      version: latest.version + 1, dag, hash, created_at: nowIso(),
      reason: text(args.reason), recorded_by: text(args.recordedBy) || null,
      operations: {
        add_nodes: args.add_nodes || [], add_edges: args.add_edges || [],
        remove_nodes: args.remove_nodes || [], remove_edges: args.remove_edges || [],
      },
    }
    appendJsonl(f.dag, [event])
    return { slug: causalSlug(slug), version: event.version, hash, created: true, dag, reason: event.reason }
  }, { label: 'causal DAG ledger' })
}

export function analyzeCausalDagStore({ cwd, slug, x = null, y = null, given = [], adjustFor = [], record = true }) {
  const latest = latestEvent(cwd, slug)
  if (!latest) throw new Error(`causal DAG "${causalSlug(slug)}" has not been created`)
  const analysis = analyzeDag(latest.dag, { x, y, given, adjustFor })
  if (record) {
    const f = files(cwd, slug)
    ensureDir(f.dir)
    appendJsonl(f.analyses, [{
      ts: nowIso(), dag_version: latest.version, dag_hash: latest.hash,
      treatment: analysis.treatment, outcome: analysis.outcome,
      given, adjust_for: adjustFor, analysis,
    }])
  }
  return { ...analysis, dag_version: latest.version, dag_hash: latest.hash }
}

export function recordEValue({ cwd, slug = null, measure, estimate, ciLow = null, ciHigh = null }) {
  const result = computeEValue({ measure, estimate, ciLow, ciHigh })
  if (slug) {
    const f = files(cwd, slug)
    ensureDir(f.dir)
    appendJsonl(f.evalues, [{ ts: nowIso(), ...result }])
  }
  return result
}

export function causalStatus(cwd, slug) {
  const latest = latestEvent(cwd, slug)
  if (!latest) throw new Error(`causal DAG "${causalSlug(slug)}" has not been created`)
  const analyses = readJsonl(files(cwd, slug).analyses)
  const evalues = readJsonl(files(cwd, slug).evalues)
  const graph = buildGraph(latest.dag)
  return {
    slug: causalSlug(slug),
    dir: files(cwd, slug).dir,
    version: latest.version,
    hash: latest.hash,
    created_at: latest.created_at,
    treatment: latest.dag.treatment,
    outcome: latest.dag.outcome,
    nodes: graph.nodes.length,
    edges: latest.dag.edges.length,
    versions: readJsonl(files(cwd, slug).dag).length,
    analyses: analyses.length,
    latest_analysis: analyses.length ? {
      ts: analyses.at(-1).ts,
      treatment: analyses.at(-1).analysis.treatment,
      outcome: analyses.at(-1).analysis.outcome,
      backdoor_status: analyses.at(-1).analysis.backdoor.status,
      minimal_sets: analyses.at(-1).analysis.backdoor.minimal_sets,
      front_door_status: analyses.at(-1).analysis.front_door.status,
    } : null,
    evalues: evalues.length,
  }
}

function mermaidId(id) {
  return String(id).replace(/[^A-Za-z0-9_]/g, '_')
}

function mermaidLabel(node) {
  const label = String(node.label || node.id).replace(/\s+/g, ' ').replace(/"/g, '&quot;')
  return `${mermaidId(node.id)}["${label}"]`
}

export function toMermaid(dag) {
  const lines = ['flowchart LR']
  for (const node of dag.nodes) {
    lines.push(`  ${mermaidLabel(node)}`)
    if (node.observed === false) lines.push(`  style ${mermaidId(node.id)} stroke-dasharray: 5 5`)
  }
  for (const [from, to] of dag.edges) lines.push(`  ${mermaidId(from)} --> ${mermaidId(to)}`)
  return `${lines.join('\n')}\n`
}

export function toDot(dag) {
  const lines = ['digraph causal_dag {', '  rankdir=LR;']
  for (const node of dag.nodes) {
    const attrs = [`label="${String(node.label || node.id).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ')}"`]
    if (node.observed === false) attrs.push('style=dashed')
    lines.push(`  "${node.id}" [${attrs.join(', ')}];`)
  }
  for (const [from, to] of dag.edges) lines.push(`  "${from}" -> "${to}";`)
  lines.push('}')
  return `${lines.join('\n')}\n`
}

function toEdgeList(dag) {
  return `${dag.edges.map(([from, to]) => `${from}\t${to}`).join('\n')}\n`
}

export function exportCausalDag({ cwd, slug, format = 'mermaid', out = null, overwrite = false }) {
  const latest = latestEvent(cwd, slug)
  if (!latest) throw new Error(`causal DAG "${causalSlug(slug)}" has not been created`)
  const kind = text(format).toLowerCase() || 'mermaid'
  if (!CAUSAL_EXPORT_FORMATS.includes(kind)) throw new Error(`format must be one of ${CAUSAL_EXPORT_FORMATS.join(', ')}`)
  const dir = files(cwd, slug).exports
  ensureDir(dir)
  const extension = { mermaid: 'mmd', dot: 'dot', edge_list: 'tsv', json: 'json' }[kind]
  const target = out ? resolveWorkspacePath(cwd, out, { forWrite: true }) : join(dir, `dag.${extension}`)
  let body
  if (kind === 'mermaid') body = toMermaid(latest.dag)
  else if (kind === 'dot') body = toDot(latest.dag)
  else if (kind === 'edge_list') body = toEdgeList(latest.dag)
  else body = `${JSON.stringify({ slug: causalSlug(slug), version: latest.version, hash: latest.hash, ...latest.dag }, null, 2)}\n`
  const result = exportText(target, body, { overwrite })
  return { ...result, format: kind, version: latest.version, hash: latest.hash }
}

export function parseGraphText(body, format = 'edge_list') {
  const source = String(body ?? '')
  if (Buffer.byteLength(source) > MAX_TEXT_BYTES) throw new Error(`graph text is larger than ${MAX_TEXT_BYTES} bytes`)
  const kind = text(format).toLowerCase() || 'edge_list'
  const labels = new Map()
  const edges = []
  if (kind === 'edge_list') {
    for (const raw of source.split('\n')) {
      const line = raw.replace(/(#|\/\/).*$/, '').trim()
      if (!line) continue
      const match = line.match(/^\s*"?([^"\s]+)"?\s*(?:->|→)\s*"?([^"\s]+)"?\s*$/)
      if (!match) throw new Error(`edge-list line is not "A -> B": ${raw.trim()}`)
      edges.push([match[1], match[2]])
    }
  } else if (kind === 'mermaid') {
    for (const raw of source.split('\n')) {
      const line = raw.trim()
      if (!line || /^(flowchart|graph)\b/.test(line) || /^(subgraph|end|classDef|class |style |linkStyle|click )/.test(line)) continue
      for (const match of line.matchAll(/([A-Za-z0-9_.-]+)\s*(?:\[["']?([^\]"']*)["']?\]|\(([^)]*)\)|\{([^}]*)\})/g)) {
        const label = match[2] ?? match[3] ?? match[4]
        if (label) labels.set(match[1], label.trim())
      }
      const edge = line.match(/^\s*([A-Za-z0-9_.-]+)(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?\s*(?:-->|---|==>|-.->)\s*(?:\|[^|]*\|\s*)?([A-Za-z0-9_.-]+)/)
      if (edge) edges.push([edge[1], edge[2]])
    }
  } else if (kind === 'dot') {
    const clean = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    for (const raw of clean.split(/[;\n{]/)) {
      const line = raw.trim()
      if (!line || /^digraph\b/.test(line) || /^graph\b/.test(line) || line === '}') continue
      const labelMatch = line.match(/^"?([A-Za-z0-9_.:-]+)"?\s*\[.*?label\s*=\s*"([^"]*)"/)
      if (labelMatch) labels.set(labelMatch[1], labelMatch[2])
      const edge = line.match(/^"?([A-Za-z0-9_.:-]+)"?\s*->\s*"?([A-Za-z0-9_.:-]+)"?/)
      if (edge) edges.push([edge[1], edge[2]])
    }
  } else {
    throw new Error('format must be edge_list, mermaid, or dot')
  }
  if (!edges.length) throw new Error('no directed edges were found in the supplied text')
  const nodes = [...new Set(edges.flat())].map((id) => ({ id, label: labels.get(id) || null }))
  return { nodes, edges }
}

export function readCausalTextFile(cwd, relativePath) {
  if (!text(relativePath)) throw new Error('file is required with format when text is not supplied')
  const abs = resolveWorkspacePath(cwd, relativePath)
  if (!existsSync(abs)) throw new Error(`file not found: ${relativePath}`)
  const body = readFileSync(abs)
  if (body.byteLength > MAX_TEXT_BYTES) throw new Error(`file is larger than ${MAX_TEXT_BYTES} bytes`)
  return body.toString('utf8')
}
