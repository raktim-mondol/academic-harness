/**
 * science_source: one multiplexed tool over scientific-database adapters
 * (science-sources/*.js). Adapters carry the per-database knowledge; this file
 * owns validation, the size/host limits on `fetch`, workspace-confined saves,
 * a retrieval ledger, and the compact renderer. Every record states its source,
 * license, retrieval time, and endpoint. A failure is a named state, never a
 * guessed value.
 */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendJsonl, ensureDir, nowIso } from './ledger-kit.js'
import { fetchText } from './search-http.js'
import { ADAPTERS, getAdapter } from './science-sources/index.js'
import { resolveWorkspacePath } from './workspace-path.js'

const ACTIONS = ['catalog', 'search', 'get', 'fetch', 'resolve']
const DEFAULT_FETCH_BYTES = 1024 * 1024
const HARD_FETCH_BYTES = 25 * 1024 * 1024
const PREVIEW_CHARS = 8000

function text(value) {
  return String(value ?? '').trim()
}

function workspaceRoot(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

function needAdapter(args, capability) {
  const adapter = getAdapter(args.source)
  if (!adapter) throw new Error(`source must be one of ${ADAPTERS.map((a) => a.id).join(', ')}`)
  if (!adapter.capabilities.includes(capability)) {
    return { adapter, refusal: { state: 'not_supported', error: `${adapter.name} does not support ${capability}` } }
  }
  return { adapter }
}

export function catalog() {
  return ADAPTERS.map((a) => ({
    id: a.id,
    name: a.name,
    capabilities: a.capabilities,
    auth: a.auth,
    state: a.auth ? 'key_missing' : 'ready',
    rate_limit: a.rateLimit,
    license: a.license,
    id_help: a.idHelp,
    base_url: a.baseUrl,
  }))
}

function fetchTarget(adapter, args) {
  const raw = text(args.url)
  if (raw) return raw
  const id = text(args.id)
  if (id && adapter.id === 'rcsb-pdb') return adapter.fileUrl(id, args.format)
  if (id && adapter.id === 'alphafold') return `${adapter.baseUrl}/prediction/${encodeURIComponent(id)}`
  return ''
}

async function runFetch(args, exec, deps) {
  const { adapter, refusal } = needAdapter(args, 'fetch')
  if (refusal) return { action: 'fetch', source: adapter.id, ...refusal }
  const target = fetchTarget(adapter, args)
  if (!target) throw new Error('url (or id for rcsb-pdb / alphafold) is required for fetch')
  let parsed
  try {
    parsed = new URL(target)
  } catch {
    throw new Error(`not a URL: ${target}`)
  }
  if (parsed.protocol !== 'https:' || !adapter.hosts.includes(parsed.hostname)) {
    return { action: 'fetch', source: adapter.id, state: 'not_supported', error: `fetch is limited to https URLs on ${adapter.hosts.join(', ')}` }
  }
  const maxBytes = Math.min(Math.max(Number(args.max_bytes) || DEFAULT_FETCH_BYTES, 1), HARD_FETCH_BYTES)
  const res = await (deps.fetchText || fetchText)(target, { signal: deps.signal, maxBytes, headers: { 'user-agent': 'Academic Harness/1.0 (science_source)' } })
  if (!res.ok) {
    const state = res.status === 404 ? 'not_found' : res.error?.startsWith('response exceeds') ? 'size_limit_exceeded' : 'unavailable'
    return { action: 'fetch', source: adapter.id, url: target, state, error: res.error || `HTTP ${res.status}`, limit_bytes: maxBytes }
  }
  const body = String(res.data ?? '')
  const event = {
    kind: 'fetch',
    ts: deps.now,
    source: adapter.id,
    url: target,
    license: adapter.license,
    bytes: Buffer.byteLength(body),
    sha256: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    path: null,
  }
  if (text(args.save_to)) {
    const cwd = workspaceRoot(exec)
    const abs = resolveWorkspacePath(cwd, text(args.save_to), { forWrite: true })
    ensureDir(dirname(abs))
    writeFileSync(abs, body)
    event.path = text(args.save_to)
  }
  appendJsonl(join(workspaceRoot(exec), '.dsh', 'science', 'retrievals.jsonl'), [event])
  const truncated = body.length > PREVIEW_CHARS
  return { action: 'fetch', source: adapter.id, ...event, preview: body.slice(0, PREVIEW_CHARS), preview_truncated: truncated }
}

export async function runScienceSource(args, exec, deps = {}) {
  const action = args.action || 'catalog'
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  const run = { ...deps, now: deps.now || nowIso(), signal: deps.signal || exec?.signal }
  if (action === 'catalog') return { action, sources: catalog() }
  if (action === 'fetch') return runFetch(args, exec, run)

  const { adapter, refusal } = needAdapter(args, action)
  if (refusal) return { action, source: adapter.id, ...refusal }

  if (action === 'search') {
    const query = text(args.query)
    if (!query) throw new Error('query is required for search')
    const limit = Math.min(Math.max(Math.trunc(Number(args.limit) || 10), 1), 25)
    const out = await adapter.search({ query, limit }, run)
    return out.ok
      ? { action, source: adapter.id, query, count: out.records.length, total: out.total ?? null, records: out.records, note: out.records.length ? null : 'no matches (this is not proof the entity does not exist)' }
      : { action, source: adapter.id, query, state: out.state, error: out.error }
  }
  if (action === 'get') {
    const id = text(args.id)
    if (!id) throw new Error(`id is required for get (${adapter.idHelp})`)
    const out = await adapter.get({ id, include_sequence: Boolean(args.include_sequence) }, run)
    return out.ok
      ? { action, source: adapter.id, record: out.record }
      : { action, source: adapter.id, id, state: out.state, error: out.error }
  }
  const id = text(args.id)
  const to = text(args.to).toLowerCase()
  if (!id || !to) throw new Error('id and to are required for resolve')
  if (!adapter.resolve) return { action, source: adapter.id, state: 'not_supported', error: `${adapter.name} has no identifier mappings` }
  const out = await adapter.resolve({ id, to }, run)
  return out.ok
    ? { action, source: adapter.id, from: id, to, ids: out.ids, truncated: Boolean(out.truncated), note: out.note || null, retrieved_at: run.now }
    : { action, source: adapter.id, from: id, to, state: out.state, error: out.error }
}

function renderRecord(r) {
  const facts = Object.entries(r.fields).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${k}=${v}`).join(' · ')
  return [`- ${r.id} — ${r.title || '(untitled)'}`, `  ${facts}`, `  ${r.url}`].join('\n')
}

export function renderValue(value) {
  if (value.error && !value.records && !value.record) {
    return [{ type: 'text', text: `${value.state || 'error'}: ${value.error}` }]
  }
  if (value.action === 'catalog') {
    const lines = value.sources.map((s) => `- ${s.id} (${s.name}) · ${s.capabilities.join('/')} · ${s.state} · ${s.license} · ${s.rate_limit}`)
    return [{ type: 'text', text: ['Science sources:', ...lines].join('\n') }]
  }
  if (value.action === 'search') {
    const head = `${value.source}: ${value.count} record(s) for "${value.query}"${value.total != null ? ` of ${value.total}` : ''}`
    const first = value.records[0]
    const tail = first ? `License: ${first.license} · retrieved ${first.retrieved_at}` : value.note
    return [{ type: 'text', text: [head, ...value.records.map(renderRecord), tail].filter(Boolean).join('\n') }]
  }
  if (value.action === 'get') {
    const r = value.record
    return [{ type: 'text', text: [renderRecord(r), r.summary ? `  ${r.summary}` : null, `License: ${r.license} · retrieved ${r.retrieved_at}`].filter(Boolean).join('\n') }]
  }
  if (value.action === 'resolve') {
    return [{ type: 'text', text: `${value.source} ${value.from} → ${value.to}: ${value.ids.length ? value.ids.slice(0, 25).join(', ') : 'no mapping found'}${value.ids.length > 25 ? ` (+${value.ids.length - 25} more in the result)` : ''}${value.truncated ? ' (source list truncated)' : ''}${value.note ? `\n${value.note}` : ''}` }]
  }
  if (value.action === 'fetch') {
    if (value.error) return [{ type: 'text', text: `${value.state}: ${value.error}` }]
    return [{ type: 'text', text: [`Fetched ${value.url} — ${value.bytes} bytes · ${value.sha256}${value.path ? ` · saved to ${value.path}` : ''}`, `License: ${value.license}`, value.preview_truncated ? `Preview (first ${PREVIEW_CHARS} chars):` : 'Content:', value.preview].join('\n') }]
  }
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

export const name = 'academic-harness-science-source'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'science_source',
    description: [
      'Query scientific databases through one interface: UniProt (proteins), RCSB PDB (experimental structures), AlphaFold DB (predicted structures), and PubChem (compounds). `catalog` lists sources, capabilities, rate limits, and licenses. `search` and `get` return normalized records, each with source, id, url, retrieved_at, license, and the endpoint called. `resolve` maps identifiers where a stable mapping exists (UniProt→PDB, UniProt→AlphaFold, PubChem CID→InChIKey). `fetch` retrieves a raw file or record from the source\'s own hosts with a size cap, and `save_to` writes it inside the workspace (for structure_toolkit) with a hashed entry in `.dsh/science/retrievals.jsonl`.',
      'Read-only and keyless. A failure is a named state (not_found, rate_limited, provider_blocked, unavailable, not_supported, size_limit_exceeded), never a guessed value; an empty search is not proof of absence. AlphaFold records are predictions, not experiments. Reported figures belong to the source and its stated license; cite the database and the retrieval date.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ACTIONS, description: 'catalog (default), search, get, fetch, or resolve.' },
      source: { type: 'string', enum: ADAPTERS.map((a) => a.id), description: 'Source id (all actions except catalog).' },
      query: { type: 'string', description: 'search: free text (a protein name, gene, PDB keyword, or compound name).' },
      id: { type: 'string', description: 'get/resolve/fetch: source identifier (UniProt accession, PDB id, PubChem CID).' },
      to: { type: 'string', description: 'resolve: target (rcsb-pdb, alphafold, inchikey).' },
      limit: { type: 'number', description: 'search: max records, 1-25 (default 10).' },
      include_sequence: { type: 'boolean', description: 'get (uniprot): include the full sequence (default false).' },
      url: { type: 'string', description: 'fetch: an https URL on the source\'s own hosts.' },
      format: { type: 'string', enum: ['cif', 'pdb'], description: 'fetch (rcsb-pdb) with id: file format, default cif.' },
      max_bytes: { type: 'number', description: 'fetch: size cap in bytes (default 1MB, hard max 25MB).' },
      save_to: { type: 'string', description: 'fetch: workspace-relative path to save the body to.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return await runScienceSource(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Science source ${args.action || 'catalog'}: ${args.source || ''} ${args.query || args.id || ''}`.trim(), kind: 'search' }
    },
  }))
}
