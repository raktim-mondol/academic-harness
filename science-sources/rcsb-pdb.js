/** RCSB PDB: experimental structures. Keyless; metadata is CC0. */
import { call, makeRecord } from './common.js'

const DATA = 'https://data.rcsb.org'
const SEARCH = 'https://search.rcsb.org/rcsbsearch/v2/query'

const ENTRY_QUERY = `query($ids:[String!]!){entries(entry_ids:$ids){rcsb_id struct{title}
  exptl{method} rcsb_entry_info{resolution_combined polymer_entity_count deposited_atom_count}
  rcsb_accession_info{initial_release_date} rcsb_primary_citation{pdbx_database_id_DOI}}}`

export const rcsbPdb = {
  id: 'rcsb-pdb',
  name: 'RCSB PDB',
  version: 1,
  baseUrl: DATA,
  hosts: ['data.rcsb.org', 'search.rcsb.org', 'files.rcsb.org'],
  auth: null,
  rateLimit: 'no published hard limit; calls are paced at about 5/s',
  limiter: { minIntervalMs: 200 },
  license: 'CC0-1.0',
  capabilities: ['search', 'get', 'fetch'],
  idHelp: 'four-character PDB id, e.g. 4HHB',
  fileUrl: (id, format = 'cif') => `https://files.rcsb.org/download/${encodeURIComponent(String(id).toUpperCase())}.${format === 'pdb' ? 'pdb' : 'cif'}`,

  normalize(entry, now, query = null, endpoint = DATA) {
    const res = entry.rcsb_entry_info?.resolution_combined?.[0]
    return makeRecord(this, {
      id: entry.rcsb_id,
      url: `https://www.rcsb.org/structure/${entry.rcsb_id}`,
      title: entry.struct?.title,
      fields: {
        method: entry.exptl?.[0]?.method || null,
        resolution_angstrom: res ?? null,
        polymer_entities: entry.rcsb_entry_info?.polymer_entity_count ?? null,
        atoms: entry.rcsb_entry_info?.deposited_atom_count ?? null,
        released: entry.rcsb_accession_info?.initial_release_date?.slice(0, 10) || null,
        citation_doi: entry.rcsb_primary_citation?.pdbx_database_id_DOI || null,
        file_url: this.fileUrl(entry.rcsb_id),
      },
      endpoint,
      query,
    }, now)
  },

  async _entries(ids, deps, query) {
    const res = await call(this, `${DATA}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: ENTRY_QUERY, variables: { ids } }),
    }, deps)
    if (!res.ok) return res
    const entries = res.data?.data?.entries || []
    return { ok: true, records: entries.filter(Boolean).map((entry) => this.normalize(entry, deps.now, query, `${DATA}/graphql`)) }
  },

  async search({ query, limit = 10 }, deps) {
    const body = {
      query: { type: 'terminal', service: 'full_text', parameters: { value: query } },
      return_type: 'entry',
      request_options: { paginate: { start: 0, rows: limit }, results_content_type: ['experimental'] },
    }
    const res = await call(this, SEARCH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, deps)
    if (!res.ok) return res.state === 'not_found' ? { ok: true, records: [] } : res
    const ids = (res.data?.result_set || []).map((row) => row.identifier)
    if (!ids.length) return { ok: true, records: [] }
    const detail = await this._entries(ids, deps, query)
    if (!detail.ok) return detail
    return { ok: true, records: detail.records, total: res.data?.total_count ?? null }
  },

  async get({ id }, deps) {
    const clean = String(id).trim().toUpperCase()
    if (!/^[0-9][A-Z0-9]{3}$/.test(clean)) return { ok: false, state: 'bad_request', error: `not a PDB id: ${id}` }
    const detail = await this._entries([clean], deps, null)
    if (!detail.ok) return detail
    if (!detail.records.length) return { ok: false, state: 'not_found', error: `RCSB PDB: ${clean} not found` }
    return { ok: true, record: detail.records[0] }
  },
}
