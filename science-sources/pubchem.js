/** PubChem: compounds via PUG REST. Keyless; NCBI data, no copyright claim. */
import { call, makeRecord } from './common.js'

const BASE = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug'
const PROPS = 'Title,MolecularFormula,MolecularWeight,SMILES,InChIKey,IUPACName'

export const pubchem = {
  id: 'pubchem',
  name: 'PubChem',
  version: 1,
  baseUrl: BASE,
  hosts: ['pubchem.ncbi.nlm.nih.gov'],
  auth: null,
  rateLimit: 'PubChem asks for at most 5 requests per second; calls are paced at about 4/s',
  limiter: { minIntervalMs: 250 },
  license: 'public-domain-NCBI (individual depositor data may carry its own terms)',
  capabilities: ['search', 'get', 'resolve'],
  idHelp: 'PubChem CID, e.g. 2244',

  normalize(p, now, query = null, endpoint = BASE) {
    return makeRecord(this, {
      id: p.CID,
      url: `https://pubchem.ncbi.nlm.nih.gov/compound/${p.CID}`,
      title: p.Title || p.IUPACName,
      fields: {
        formula: p.MolecularFormula || null,
        molecular_weight: p.MolecularWeight != null ? Number(p.MolecularWeight) : null,
        smiles: p.SMILES ?? p.CanonicalSMILES ?? p.ConnectivitySMILES ?? null,
        inchikey: p.InChIKey || null,
        iupac_name: p.IUPACName || null,
      },
      endpoint,
      query,
    }, now)
  },

  async _properties(cids, deps, query) {
    const url = `${BASE}/compound/cid/${cids.join(',')}/property/${PROPS}/JSON`
    const res = await call(this, url, {}, deps)
    if (!res.ok) return res
    const rows = res.data?.PropertyTable?.Properties || []
    return { ok: true, records: rows.map((row) => this.normalize(row, deps.now, query, url)) }
  },

  async search({ query, limit = 10 }, deps) {
    const url = `${BASE}/compound/name/${encodeURIComponent(query)}/cids/JSON`
    const res = await call(this, url, {}, deps)
    if (!res.ok) return res.state === 'not_found' ? { ok: true, records: [] } : res
    const cids = (res.data?.IdentifierList?.CID || []).slice(0, limit)
    if (!cids.length) return { ok: true, records: [] }
    return this._properties(cids, deps, query)
  },

  async get({ id }, deps) {
    if (!/^\d+$/.test(String(id))) return { ok: false, state: 'bad_request', error: `not a PubChem CID: ${id}` }
    const detail = await this._properties([id], deps, null)
    if (!detail.ok) return detail
    const only = detail.records[0]
    if (!only || (!only.title && !only.fields.formula && !only.fields.inchikey)) {
      return { ok: false, state: 'not_found', error: `PubChem: CID ${id} not found` }
    }
    return { ok: true, record: only }
  },

  async resolve({ id, to }, deps) {
    if (to !== 'inchikey') return { ok: false, state: 'not_supported', error: `pubchem cannot resolve to ${to}` }
    const got = await this.get({ id }, deps)
    if (!got.ok) return got
    return { ok: true, ids: got.record.fields.inchikey ? [got.record.fields.inchikey] : [], note: 'InChIKey from the PubChem compound record' }
  },
}
