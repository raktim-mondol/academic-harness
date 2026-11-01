/** Adapter registry for science_source. Add a source by exporting an adapter here. */
import { alphafold } from './alphafold.js'
import { pubchem } from './pubchem.js'
import { rcsbPdb } from './rcsb-pdb.js'
import { uniprot } from './uniprot.js'

export const ADAPTERS = [uniprot, rcsbPdb, alphafold, pubchem]

export function getAdapter(id) {
  return ADAPTERS.find((adapter) => adapter.id === String(id || '').trim().toLowerCase()) || null
}
