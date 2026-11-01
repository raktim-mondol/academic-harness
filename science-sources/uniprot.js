/** UniProtKB: proteins. Keyless REST; data is CC BY 4.0. */
import { call, cap, makeRecord } from './common.js'

const BASE = 'https://rest.uniprot.org'

export const uniprot = {
  id: 'uniprot',
  name: 'UniProt',
  version: 1,
  baseUrl: BASE,
  hosts: ['rest.uniprot.org'],
  auth: null,
  rateLimit: 'no published hard limit; calls are paced at about 3/s',
  limiter: { minIntervalMs: 330 },
  license: 'CC-BY-4.0',
  capabilities: ['search', 'get', 'resolve'],
  idHelp: 'UniProt accession, e.g. P69905',

  normalize(entry, now, query = null, endpoint = BASE) {
    const accession = entry.primaryAccession
    const protein = entry.proteinDescription?.recommendedName?.fullName?.value
      || entry.proteinDescription?.submissionNames?.[0]?.fullName?.value
      || entry.uniProtkbId
    return makeRecord(this, {
      id: accession,
      url: `https://www.uniprot.org/uniprotkb/${accession}`,
      title: protein,
      summary: entry.comments?.find((c) => c.commentType === 'FUNCTION')?.texts?.[0]?.value || null,
      fields: {
        entry_name: entry.uniProtkbId || null,
        reviewed: entry.entryType ? entry.entryType.toLowerCase().includes('swiss-prot') : null,
        gene: entry.genes?.[0]?.geneName?.value || null,
        organism: entry.organism?.scientificName || null,
        taxon_id: entry.organism?.taxonId ?? null,
        length: entry.sequence?.length ?? null,
        mass: entry.sequence?.molWeight ?? null,
        sequence_md5: entry.sequence?.md5 || null,
        pdb_cross_references: (entry.uniProtKBCrossReferences || []).filter((x) => x.database === 'PDB').length,
      },
      endpoint,
      query,
    }, now)
  },

  async search({ query, limit = 10 }, deps) {
    const url = `${BASE}/uniprotkb/search?query=${encodeURIComponent(query)}&size=${limit}&format=json`
    const res = await call(this, url, {}, deps)
    if (!res.ok) return res
    const records = (res.data?.results || []).map((entry) => this.normalize(entry, deps.now, query, url))
    return { ok: true, records }
  },

  async get({ id, include_sequence = false }, deps) {
    const url = `${BASE}/uniprotkb/${encodeURIComponent(id)}.json`
    const res = await call(this, url, {}, deps)
    if (!res.ok) return res
    const record = this.normalize(res.data, deps.now, null, url)
    record.fields.sequence = include_sequence ? (res.data.sequence?.value || null) : undefined
    if (!include_sequence) delete record.fields.sequence
    record.fields.function = cap(res.data.comments?.find((c) => c.commentType === 'FUNCTION')?.texts?.[0]?.value, 1200)
    return { ok: true, record }
  },

  async resolve({ id, to }, deps) {
    if (to === 'alphafold') return { ok: true, ids: [id], note: 'AlphaFold DB is keyed by the UniProt accession' }
    if (to === 'rcsb-pdb') {
      const url = `${BASE}/uniprotkb/${encodeURIComponent(id)}.json`
      const res = await call(this, url, {}, deps)
      if (!res.ok) return res
      const ids = (res.data.uniProtKBCrossReferences || []).filter((x) => x.database === 'PDB').map((x) => x.id)
      return { ok: true, ids: ids.slice(0, 100), truncated: ids.length > 100, note: 'PDB cross-references listed in the UniProt entry' }
    }
    return { ok: false, state: 'not_supported', error: `uniprot cannot resolve to ${to}` }
  },
}
