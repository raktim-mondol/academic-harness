/** AlphaFold DB: predicted structures, keyed by UniProt accession. CC BY 4.0. */
import { call, makeRecord } from './common.js'

const BASE = 'https://alphafold.ebi.ac.uk/api'

export const alphafold = {
  id: 'alphafold',
  name: 'AlphaFold DB',
  version: 1,
  baseUrl: BASE,
  hosts: ['alphafold.ebi.ac.uk'],
  auth: null,
  rateLimit: 'no published hard limit; calls are paced at about 3/s',
  limiter: { minIntervalMs: 330 },
  license: 'CC-BY-4.0',
  capabilities: ['get', 'fetch'],
  idHelp: 'UniProt accession, e.g. P69905',

  normalize(entry, now, endpoint) {
    return makeRecord(this, {
      id: entry.uniprotAccession,
      url: `https://alphafold.ebi.ac.uk/entry/${entry.uniprotAccession}`,
      title: `${entry.uniprotDescription || entry.uniprotAccession} (predicted)`,
      fields: {
        entry_id: entry.entryId || null,
        organism: entry.organismScientificName || null,
        gene: entry.gene || null,
        model_version: entry.latestVersion ?? null,
        mean_plddt: entry.globalMetricValue ?? null,
        prediction_is_not_experiment: true,
        cif_url: entry.cifUrl || null,
        pdb_url: entry.pdbUrl || null,
      },
      endpoint,
    }, now)
  },

  async get({ id }, deps) {
    const url = `${BASE}/prediction/${encodeURIComponent(id)}`
    const res = await call(this, url, {}, deps)
    if (!res.ok) return res
    const first = Array.isArray(res.data) ? res.data[0] : res.data
    if (!first) return { ok: false, state: 'not_found', error: `AlphaFold DB: no prediction for ${id}` }
    return { ok: true, record: this.normalize(first, deps.now, url) }
  },
}
