import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { apply, catalog, renderValue, runScienceSource } from '../science-source.js'
import { ADAPTERS, getAdapter } from '../science-sources/index.js'
import { resetLimitersForTests } from '../search-http.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const workspace = makeWorkspace('ah-science-source-')
const exec = fakeExec(workspace.cwd)
const NOW = '2026-11-01T00:00:00.000Z'
let checks = 0
const ok = (condition, message) => { assert.ok(condition, message); checks += 1 }
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1 }

const UNIPROT_ENTRY = {
  primaryAccession: 'P69905', uniProtkbId: 'HBA_HUMAN', entryType: 'UniProtKB reviewed (Swiss-Prot)',
  organism: { scientificName: 'Homo sapiens', taxonId: 9606 }, genes: [{ geneName: { value: 'HBA1' } }],
  proteinDescription: { recommendedName: { fullName: { value: 'Hemoglobin subunit alpha' } } },
  sequence: { length: 142, molWeight: 15258, md5: 'ABC', value: 'VLSPADKTNV' },
  comments: [{ commentType: 'FUNCTION', texts: [{ value: 'Involved in oxygen transport.' }] }],
  uniProtKBCrossReferences: [{ database: 'PDB', id: '1A00' }, { database: 'PDB', id: '4HHB' }, { database: 'Pfam', id: 'PF00042' }],
}
const calls = []
function fakeFetchJson(url, options = {}) {
  calls.push({ url, method: options.method || 'GET', body: options.body })
  if (url.includes('rest.uniprot.org/uniprotkb/search')) return Promise.resolve({ ok: true, status: 200, data: { results: [UNIPROT_ENTRY] } })
  if (url.includes('rest.uniprot.org/uniprotkb/P69905.json')) return Promise.resolve({ ok: true, status: 200, data: UNIPROT_ENTRY })
  if (url.includes('rest.uniprot.org/uniprotkb/NOPE')) return Promise.resolve({ ok: false, status: 404, error: 'HTTP 404' })
  if (url.includes('rest.uniprot.org/uniprotkb/BLOCK')) return Promise.resolve({ ok: false, status: 403, error: 'HTTP 403' })
  if (url.includes('rest.uniprot.org/uniprotkb/SLOW')) return Promise.resolve({ ok: false, status: 429, error: 'HTTP 429' })
  if (url.includes('search.rcsb.org')) return Promise.resolve({ ok: true, status: 200, data: { total_count: 2, result_set: [{ identifier: '4HHB' }, { identifier: '1A3N' }] } })
  if (url.includes('data.rcsb.org/graphql')) {
    const ids = JSON.parse(options.body).variables.ids
    return Promise.resolve({ ok: true, status: 200, data: { data: { entries: ids.filter((id) => id !== '9ZZZ').map((id) => ({
      rcsb_id: id, struct: { title: `Structure ${id}` }, exptl: [{ method: 'X-RAY DIFFRACTION' }],
      rcsb_entry_info: { resolution_combined: [1.74], polymer_entity_count: 2, deposited_atom_count: 4779 },
      rcsb_accession_info: { initial_release_date: '1984-07-17T00:00:00Z' }, rcsb_primary_citation: { pdbx_database_id_DOI: '10.1/x' },
    })) } } })
  }
  if (url.includes('alphafold.ebi.ac.uk/api/prediction/P69905')) {
    return Promise.resolve({ ok: true, status: 200, data: [{ uniprotAccession: 'P69905', entryId: 'AF-P69905-F1', uniprotDescription: 'Hemoglobin subunit alpha', globalMetricValue: 98.06, latestVersion: 6, cifUrl: 'https://alphafold.ebi.ac.uk/files/x.cif' }] })
  }
  if (url.includes('alphafold.ebi.ac.uk/api/prediction/')) return Promise.resolve({ ok: false, status: 404, error: 'HTTP 404' })
  if (url.includes('/compound/name/aspirin/cids')) return Promise.resolve({ ok: true, status: 200, data: { IdentifierList: { CID: [2244, 9999] } } })
  if (url.includes('/compound/name/zzzz/cids')) return Promise.resolve({ ok: false, status: 404, error: 'HTTP 404' })
  if (url.includes('/compound/cid/999999/property')) return Promise.resolve({ ok: true, status: 200, data: { PropertyTable: { Properties: [{ CID: 999999 }] } } })
  if (url.includes('/compound/cid/')) {
    return Promise.resolve({ ok: true, status: 200, data: { PropertyTable: { Properties: [{ CID: 2244, Title: 'Aspirin', MolecularFormula: 'C9H8O4', MolecularWeight: '180.16', SMILES: 'CC(=O)OC1=CC=CC=C1C(=O)O', InChIKey: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N' }] } } })
  }
  return Promise.resolve({ ok: false, status: 500, error: `unexpected ${url}` })
}
const deps = { fetchJson: fakeFetchJson, now: NOW }
const call = (args, extra = {}) => runScienceSource(args, exec, { ...deps, ...extra })

try {
  // Registration surface
  let tool
  apply({ tools: { register: (registered) => { tool = registered } } })
  eq(tool.name, 'science_source', 'tool name')
  eq(tool.parameters.properties.action.enum, ['catalog', 'search', 'get', 'fetch', 'resolve'], 'action enum')
  eq(tool.parameters.properties.source.enum, ADAPTERS.map((a) => a.id), 'source enum follows the registry')

  // Adapter contract: every adapter declares the documented fields and only implements what it advertises
  for (const adapter of ADAPTERS) {
    for (const key of ['id', 'name', 'baseUrl', 'hosts', 'rateLimit', 'license', 'capabilities', 'idHelp']) ok(adapter[key] != null, `${adapter.id}.${key}`)
    ok(adapter.auth === null, `${adapter.id} is keyless`)
    for (const capability of ['search', 'get', 'resolve']) {
      eq(adapter.capabilities.includes(capability), typeof adapter[capability] === 'function', `${adapter.id} advertises ${capability} iff implemented`)
    }
    if (adapter.capabilities.includes('fetch')) ok(adapter.hosts.length > 0, `${adapter.id} fetch has a host allow-list`)
  }
  eq(getAdapter('UniProt').id, 'uniprot', 'getAdapter is case-insensitive')
  eq(getAdapter('nope'), null, 'unknown adapter')

  // catalog
  const cat = await call({ action: 'catalog' })
  eq(cat.sources.length, ADAPTERS.length, 'catalog size')
  ok(cat.sources.every((s) => s.state === 'ready' && s.license && s.rate_limit), 'catalog states')
  ok(renderValue(cat)[0].text.includes('uniprot'), 'catalog render')
  eq(catalog().length, ADAPTERS.length, 'catalog() export')

  // uniprot
  const search = await call({ action: 'search', source: 'uniprot', query: 'hemoglobin alpha', limit: 3 })
  eq(search.count, 1, 'uniprot search count')
  const rec = search.records[0]
  eq([rec.source, rec.id, rec.license, rec.retrieved_at], ['uniprot', 'P69905', 'CC-BY-4.0', NOW], 'record provenance fields')
  eq(rec.fields.gene, 'HBA1', 'gene')
  eq(rec.fields.reviewed, true, 'reviewed flag')
  ok(rec.provenance.endpoint.includes('size=3'), 'limit reaches the endpoint')
  ok(rec.provenance.query === 'hemoglobin alpha', 'query recorded')
  ok(rec.fields.sequence === undefined, 'search never returns a sequence')
  const got = await call({ action: 'get', source: 'uniprot', id: 'P69905' })
  ok(got.record.fields.sequence === undefined, 'sequence omitted by default')
  eq(got.record.fields.function, 'Involved in oxygen transport.', 'function text')
  const withSeq = await call({ action: 'get', source: 'uniprot', id: 'P69905', include_sequence: true })
  eq(withSeq.record.fields.sequence, 'VLSPADKTNV', 'sequence on request')
  ok(renderValue(got)[0].text.includes('License: CC-BY-4.0'), 'render carries license')

  // failure states are named, never invented
  eq((await call({ action: 'get', source: 'uniprot', id: 'NOPE' })).state, 'not_found', '404 -> not_found')
  eq((await call({ action: 'get', source: 'uniprot', id: 'BLOCK' })).state, 'provider_blocked', '403 -> provider_blocked')
  eq((await call({ action: 'get', source: 'uniprot', id: 'SLOW' })).state, 'rate_limited', '429 -> rate_limited')
  const down = await call({ action: 'get', source: 'uniprot', id: 'X' }, { fetchJson: () => Promise.resolve({ ok: false, status: 0, error: 'network error: boom' }) })
  eq(down.state, 'unavailable', 'network failure -> unavailable')
  ok(renderValue(down)[0].text.startsWith('unavailable'), 'failure render names the state')

  // resolve
  const toPdb = await call({ action: 'resolve', source: 'uniprot', id: 'P69905', to: 'rcsb-pdb' })
  eq(toPdb.ids, ['1A00', '4HHB'], 'uniprot -> pdb uses cross-references')
  eq((await call({ action: 'resolve', source: 'uniprot', id: 'P69905', to: 'alphafold' })).ids, ['P69905'], 'uniprot -> alphafold')
  eq((await call({ action: 'resolve', source: 'uniprot', id: 'P69905', to: 'ensembl' })).state, 'not_supported', 'unmapped target')
  eq((await call({ action: 'resolve', source: 'rcsb-pdb', id: '4HHB', to: 'uniprot' })).state, 'not_supported', 'adapter without resolve')
  eq((await call({ action: 'resolve', source: 'pubchem', id: '2244', to: 'inchikey' })).ids, ['BSYNRYMUTXBXSQ-UHFFFAOYSA-N'], 'pubchem cid -> inchikey')

  // rcsb: search -> ids -> one batched GraphQL call
  calls.length = 0
  const pdb = await call({ action: 'search', source: 'rcsb-pdb', query: 'hemoglobin', limit: 2 })
  eq(pdb.records.map((r) => r.id), ['4HHB', '1A3N'], 'pdb search ids')
  eq(pdb.total, 2, 'pdb total reported')
  eq(calls.filter((c) => c.url.includes('graphql')).length, 1, 'details fetched in one batch, not one call per id')
  eq(pdb.records[0].fields.resolution_angstrom, 1.74, 'resolution')
  eq(pdb.records[0].fields.file_url, 'https://files.rcsb.org/download/4HHB.cif', 'file url')
  eq((await call({ action: 'get', source: 'rcsb-pdb', id: '4hhb' })).record.id, '4HHB', 'pdb id upper-cased')
  eq((await call({ action: 'get', source: 'rcsb-pdb', id: 'not a pdb id' })).state, 'bad_request', 'bad pdb id refused before any request')
  eq((await call({ action: 'get', source: 'rcsb-pdb', id: '9ZZZ' })).state, 'not_found', 'absent entry -> not_found')

  // alphafold: a prediction is labelled as one
  const af = await call({ action: 'get', source: 'alphafold', id: 'P69905' })
  eq(af.record.fields.prediction_is_not_experiment, true, 'prediction flag')
  ok(af.record.title.endsWith('(predicted)'), 'title marks prediction')
  eq((await call({ action: 'get', source: 'alphafold', id: 'Q00000' })).state, 'not_found', 'no prediction -> not_found')
  eq((await call({ action: 'search', source: 'alphafold', query: 'x' })).state, 'not_supported', 'alphafold has no search')

  // pubchem
  const pc = await call({ action: 'search', source: 'pubchem', query: 'aspirin', limit: 1 })
  eq(pc.records[0].fields.molecular_weight, 180.16, 'numeric weight')
  ok(pc.records[0].license.startsWith('public-domain'), 'pubchem license')
  eq((await call({ action: 'search', source: 'pubchem', query: 'zzzz' })).count, 0, 'no match -> empty, not an error')
  ok((await call({ action: 'search', source: 'pubchem', query: 'zzzz' })).note.includes('not proof'), 'empty search is not proof of absence')
  eq((await call({ action: 'get', source: 'pubchem', id: '999999' })).state, 'not_found', 'stub record -> not_found')
  eq((await call({ action: 'get', source: 'pubchem', id: 'aspirin' })).state, 'bad_request', 'non-numeric cid refused')

  // validation
  await assert.rejects(call({ action: 'nope' }), /action must be one of/); checks += 1
  await assert.rejects(call({ action: 'search', source: 'nope', query: 'x' }), /source must be one of/); checks += 1
  await assert.rejects(call({ action: 'search', source: 'uniprot' }), /query is required/); checks += 1
  await assert.rejects(call({ action: 'get', source: 'uniprot' }), /id is required/); checks += 1
  await assert.rejects(call({ action: 'resolve', source: 'uniprot', id: 'P1' }), /id and to are required/); checks += 1
  eq((await call({ action: 'search', source: 'uniprot', query: 'x', limit: 9999 }) && calls.at(-1).url.includes('size=25')), true, 'limit capped at 25')

  // fetch: host allow-list, size cap, workspace-confined save, ledger
  const cif = 'data_4HHB\n#\n'
  const fakeText = (url, options) => Promise.resolve(url.endsWith('missing.cif')
    ? { ok: false, status: 404, error: 'HTTP 404' }
    : options.maxBytes < cif.length ? { ok: false, status: 200, error: 'response exceeds 5 bytes' } : { ok: true, status: 200, data: cif })
  const fetched = await call({ action: 'fetch', source: 'rcsb-pdb', id: '4hhb', save_to: 'structures/4HHB.cif' }, { fetchText: fakeText })
  eq(fetched.url, 'https://files.rcsb.org/download/4HHB.cif', 'fetch by id builds the file url')
  eq(workspace.read('structures/4HHB.cif'), cif, 'file saved in the workspace')
  ok(/^sha256:[0-9a-f]{64}$/.test(fetched.sha256), 'fetch hash')
  const ledger = readFileSync(workspace.path('.dsh/science/retrievals.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  eq([ledger.length, ledger[0].source, ledger[0].path, ledger[0].license], [1, 'rcsb-pdb', 'structures/4HHB.cif', 'CC0-1.0'], 'retrieval ledger entry')
  eq((await call({ action: 'fetch', source: 'rcsb-pdb', url: 'https://evil.example/x.cif' }, { fetchText: fakeText })).state, 'not_supported', 'foreign host refused')
  eq((await call({ action: 'fetch', source: 'rcsb-pdb', url: 'http://files.rcsb.org/download/4HHB.cif' }, { fetchText: fakeText })).state, 'not_supported', 'plain http refused')
  eq((await call({ action: 'fetch', source: 'uniprot', url: 'https://rest.uniprot.org/x' }, { fetchText: fakeText })).state, 'not_supported', 'adapter without fetch')
  eq((await call({ action: 'fetch', source: 'rcsb-pdb', url: 'https://files.rcsb.org/download/missing.cif' }, { fetchText: fakeText })).state, 'not_found', 'fetch 404')
  eq((await call({ action: 'fetch', source: 'rcsb-pdb', id: '4HHB', max_bytes: 5 }, { fetchText: fakeText })).state, 'size_limit_exceeded', 'size cap')
  await assert.rejects(call({ action: 'fetch', source: 'rcsb-pdb', id: '4HHB', save_to: '../escape.cif' }, { fetchText: fakeText }), /outside|escape|workspace/i); checks += 1
  ok(!existsSync(workspace.path('../escape.cif')), 'nothing written outside the workspace')

  console.log(`science_source: ${checks} checks passed`)
} finally {
  resetLimitersForTests()
  workspace.cleanup()
}
