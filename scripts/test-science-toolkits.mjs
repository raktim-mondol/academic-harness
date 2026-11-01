import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apply as applyChem, renderValue as renderChem, runChemToolkit } from '../chem-toolkit.js'
import { apply as applySeq, renderValue as renderSeq, runSeqToolkit } from '../seq-toolkit.js'
import { apply as applyStructure, renderValue as renderStructure, runStructureToolkit } from '../structure-toolkit.js'
import { runHelper } from '../python-runtime.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const workspace = makeWorkspace('ah-toolkits-')
const exec = fakeExec(workspace.cwd)
let checks = 0
const ok = (condition, message) => { assert.ok(condition, message); checks += 1 }
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1 }
const near = (actual, expected, tolerance, message) => ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`)
const rejects = async (fn, pattern, message) => { await assert.rejects(Promise.resolve().then(fn), pattern, message); checks += 1 }

function surface(register, expectedName, expectedActions) {
  let tool
  register({ tools: { register: (registered) => { tool = registered } } })
  eq(tool.name, expectedName, `${expectedName} name`)
  eq(tool.parameters.properties.action.enum, expectedActions, `${expectedName} actions`)
  return tool
}
const chemTool = surface(applyChem, 'chem_toolkit', ['validate', 'standardize', 'descriptors', 'similarity', 'substructure', 'conformers'])
surface(applySeq, 'seq_toolkit', ['stats', 'translate', 'orfs', 'primer_tm', 'align'])
surface(applyStructure, 'structure_toolkit', ['chains', 'ligands', 'contacts', 'superpose'])

// A synthetic PDB: chain A (6 residues) with a ligand and a water, chain B a copy shifted in x.
function pdb({ shift = 0, ligand = true } = {}) {
  const lines = []
  let serial = 1
  const atom = (record, name, resName, chain, seq, x, y, z, element) => {
    lines.push(`${record.padEnd(6)}${String(serial).padStart(5)} ${name.padEnd(4)} ${resName.padStart(3)} ${chain}${String(seq).padStart(4)}    ${(x + shift).toFixed(3).padStart(8)}${y.toFixed(3).padStart(8)}${z.toFixed(3).padStart(8)}  1.00 20.00          ${element.padStart(2)}`)
    serial += 1
  }
  const residues = ['ALA', 'GLY', 'SER', 'LEU', 'VAL', 'LYS']
  for (const chain of ['A', 'B']) {
    residues.forEach((res, i) => {
      const t = i * 1.7 + (chain === 'B' ? 40 : 0)
      const y = Math.sin(i * 1.6) * 2.3
      const z = Math.cos(i * 1.6) * 2.3
      atom('ATOM', 'N', res, chain, i + 1, t - 1.2, y + 0.2, z, 'N')
      atom('ATOM', 'CA', res, chain, i + 1, t, y, z, 'C')
      atom('ATOM', 'C', res, chain, i + 1, t + 1.2, y - 0.3, z + 0.1, 'C')
      atom('ATOM', 'O', res, chain, i + 1, t + 1.5, y - 1.3, z + 0.2, 'O')
    })
  }
  if (ligand) {
    atom('HETATM', 'FE', 'HEM', 'A', 7, 3.0, 2.0, 2.5, 'FE')
    atom('HETATM', 'O', 'HOH', 'A', 8, 9.0, 9.0, 9.0, 'O')
  }
  return `${lines.join('\n')}\nEND\n`
}

try {
  // ---------- seq_toolkit (pure Python: runs anywhere) ----------
  const stats = runSeqToolkit({ action: 'stats', sequence: '>dna\nATGCGCGTATAA\n>prot\nMKTAYIAKQR' }, exec)
  eq(stats.rows.map((r) => r.type), ['dna', 'protein'], 'type detection')
  eq(stats.rows[0].gc_percent, 41.67, 'GC percent')
  near(stats.rows[1].mass_da, 1209.47, 0.05, 'peptide average mass')
  ok(/^sha256:[0-9a-f]{64}$/.test(stats.provenance.inputs[0].sha256), 'inline input hashed')
  eq(runSeqToolkit({ action: 'stats', sequence: '>dna\nATGCGCGTATAA\n>prot\nMKTAYIAKQR' }, exec).provenance.inputs[0].sha256, stats.provenance.inputs[0].sha256, 'same input, same hash')
  ok(runSeqToolkit({ action: 'stats', sequence: 'ACGTACGT' }, exec).provenance.inputs[0].sha256 !== stats.provenance.inputs[0].sha256, 'different input, different hash')
  ok(stats.provenance.tool_versions.python, 'python version recorded')

  const fwd = runSeqToolkit({ action: 'translate', sequence: 'ATGGCCATTGTAATGGGCCGCTGAAAGGGTGCCCGATAG' }, exec)
  eq(fwd.rows[0].protein, 'MAIVMGR*KGAR*', 'standard-code translation')
  eq(fwd.rows[0].internal_stops, 1, 'internal stop counted')
  eq(runSeqToolkit({ action: 'translate', sequence: 'ATGGCCATTGTAATGGGCCGCTGAAAGGGTGCCCGATAG', frame: -1, to_stop: true }, exec).rows[0].protein, 'LSGTLSAAHYNGH', 'reverse frame')
  ok(runSeqToolkit({ action: 'translate', sequence: 'MKTAYIAKQR' }, exec).rows[0].error.includes('protein'), 'protein input to translate is flagged')
  eq(runSeqToolkit({ action: 'translate', sequence: 'ATGGCCAT' }, exec).rows[0].trailing_nucleotides, 2, 'trailing bases reported, not dropped silently')

  const orfs = runSeqToolkit({ action: 'orfs', sequence: 'CCATGGCCATTGTAATGGGCCGCTGAAAGGGTGCCCGATAGCC', min_length_aa: 5 }, exec)
  eq([orfs.orfs[0].start, orfs.orfs[0].end, orfs.orfs[0].length_aa, orfs.orfs[0].has_stop], [3, 26, 7, true], 'ORF coordinates are 1-based and include the stop')
  const rev = runSeqToolkit({ action: 'orfs', sequence: 'GGCATGGCCATTGTAATGGGCCGCTGAAAGGGTGCCCGATAGCC'.split('').reverse().map((c) => ({ A: 'T', T: 'A', C: 'G', G: 'C' }[c])).join(''), min_length_aa: 5 }, exec)
  eq(rev.orfs[0].strand, '-', 'ORF on the reverse strand')
  eq(runSeqToolkit({ action: 'orfs', sequence: 'ATGAAATAG', min_length_aa: 100 }, exec).found, 0, 'minimum length enforced')

  const tm = runSeqToolkit({ action: 'primer_tm', sequence: '>M13f\nGTAAAACGACGGCCAGT\n>short\nACGT' }, exec)
  near(tm.rows[0].tm_c, 52, 3, 'M13 forward primer Tm is in the expected range')
  ok(tm.rows[1].error.includes('8-60'), 'too-short primer refused rather than extrapolated')
  const lowSalt = runSeqToolkit({ action: 'primer_tm', sequence: 'GTAAAACGACGGCCAGT', na_mm: 10 }, exec).rows[0].tm_c
  ok(lowSalt < tm.rows[0].tm_c, 'lower salt lowers Tm')
  ok(runSeqToolkit({ action: 'primer_tm', sequence: 'GTAAAACGANGGCCAGT' }, exec).rows[0].error.includes('unambiguous'), 'ambiguous base refused')

  const aln = runSeqToolkit({ action: 'align', sequence: 'GATTACA', sequence_b: 'GCATGCA' }, exec)
  eq([aln.score, aln.identities, aln.alignment.a, aln.alignment.b], [5, 4, 'GATTACA', 'GCATGCA'], 'global alignment score and rows')
  const local = runSeqToolkit({ action: 'align', sequence: 'MKTAYIAKQRQISFVK', sequence_b: 'TAYIAKQRQ', mode: 'local' }, exec)
  eq([local.a.aligned_from, local.a.aligned_to, local.percent_identity_of_columns], [3, 11, 100], 'local alignment finds the embedded segment')
  ok(local.scoring.startsWith('BLOSUM62') || local.scoring.includes('identity fallback'), 'protein scoring is stated')
  await rejects(() => runSeqToolkit({ action: 'align', sequence: 'ACGT' }, exec), /two sequences/, 'align needs two sequences')
  await rejects(() => runSeqToolkit({ action: 'stats' }, exec), /sequence .* or path is required/, 'input required')
  await rejects(() => runSeqToolkit({ action: 'nope', sequence: 'A' }, exec), /action must be one of/, 'unknown action')

  workspace.write('seqs/a.fa', '>x\nACGTACGTAC\n')
  const fromFile = runSeqToolkit({ action: 'stats', path: 'seqs/a.fa' }, exec)
  eq(fromFile.provenance.inputs[0].path, 'seqs/a.fa', 'file input recorded by relative path')
  ok(!JSON.stringify(fromFile.provenance).includes(workspace.cwd), 'absolute paths are not leaked into provenance')
  await rejects(() => runSeqToolkit({ action: 'stats', path: '../outside.fa' }, exec), /outside|workspace/i, 'path escape refused')
  await rejects(() => runSeqToolkit({ action: 'stats', path: 'seqs/missing.fa' }, exec), /file not found/, 'missing file')
  ok(renderSeq(aln)[0].text.includes('GATTACA'), 'alignment render shows the rows')

  const runs = readFileSync(workspace.path('.dsh/science/runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  ok(runs.length >= 10 && runs.every((r) => r.kind === 'toolkit_run' && r.tool && r.action && r.inputs.length), 'every run is appended to the run ledger')

  // ---------- chem_toolkit (RDKit) ----------
  const probe = runHelper('chem_toolkit.py', { action: 'validate', molecules: ['C'] })
  if (probe?.error) {
    console.log(`chem_toolkit skipped: ${probe.error}`)
  } else {
    const val = runChemToolkit({ action: 'validate', molecules: ['CC(=O)Oc1ccccc1C(=O)O aspirin', 'C((', 'c1ccccc1'] }, exec)
    eq([val.valid, val.invalid], [2, 1], 'validate counts')
    ok(val.rows[1].error.includes('could not parse'), 'invalid structure carries a reason')
    eq(val.rows[0].name, 'aspirin', 'name after the SMILES is kept')
    const desc = runChemToolkit({ action: 'descriptors', molecules: ['CC(=O)Oc1ccccc1C(=O)O'] }, exec)
    near(desc.rows[0].mol_weight, 180.159, 0.01, 'aspirin molecular weight')
    eq([desc.rows[0].formula, desc.rows[0].hbd, desc.rows[0].rule_of_five_violations], ['C9H8O4', 1, 0], 'aspirin descriptors')
    ok(desc.provenance.tool_versions.rdkit, 'RDKit version recorded')
    const std = runChemToolkit({ action: 'standardize', molecules: ['[Na+].CC(=O)[O-]'] }, exec)
    eq([std.rows[0].standardized_smiles, std.rows[0].changed], ['CC(=O)O', true], 'salt stripped and neutralized')
    eq(std.rows[0].inchikey, 'QTBSBXVTEAMEQO-UHFFFAOYSA-N', 'InChIKey of acetic acid')
    const sim = runChemToolkit({ action: 'similarity', query: 'CC(=O)Oc1ccccc1C(=O)O', molecules: ['OC(=O)c1ccccc1O salicylic', 'c1ccccc1 benzene', 'CCCC butane', 'bad(('], top_k: 2 }, exec)
    eq(sim.rows.map((r) => r.name), ['salicylic', 'benzene'], 'similarity ranking')
    eq(sim.invalid_count, 1, 'unparsable candidate counted, not scored')
    ok(sim.rows[0].tanimoto > sim.rows[1].tanimoto, 'scores descend')
    const sub = runChemToolkit({ action: 'substructure', pattern: 'c1ccccc1', molecules: ['CCO', 'c1ccccc1O phenol'] }, exec)
    eq(sub.rows.map((r) => r.name), ['phenol'], 'substructure hit')
    await rejects(() => runChemToolkit({ action: 'substructure', pattern: '[', molecules: ['CCO'] }, exec), /not valid SMARTS|pattern/, 'bad SMARTS')
    await rejects(() => runChemToolkit({ action: 'similarity', molecules: ['CCO'] }, exec), /query/, 'similarity needs a query')
    await rejects(() => runChemToolkit({ action: 'descriptors' }, exec), /molecules .* or path/, 'input required')
    await rejects(() => runChemToolkit({ action: 'descriptors', molecules: Array(2001).fill('C') }, exec), /limited to 2000/, 'inline cap')

    const c1 = runChemToolkit({ action: 'conformers', molecules: ['CCCC'], n_conformers: 4, seed: 7, out_path: 'out/butane.sdf' }, exec)
    eq([c1.rows[0].conformers, c1.rows[0].force_field, c1.rows[0].seed], [4, 'MMFF94', 7], 'conformers generated')
    ok(workspace.read('out/butane.sdf').includes('$$$$'), 'SDF written inside the workspace')
    ok(/^sha256:/.test(c1.provenance.outputs[0].sha256), 'output hashed')
    const c2 = runChemToolkit({ action: 'conformers', molecules: ['CCCC'], n_conformers: 4, seed: 7 }, exec)
    eq(c2.rows[0].lowest_energy_kcal_mol, c1.rows[0].lowest_energy_kcal_mol, 'same seed, same lowest energy')
    await rejects(() => runChemToolkit({ action: 'conformers', molecules: ['CCCC'], out_path: 'out/butane.sdf' }, exec), /already exists/, 'no silent overwrite')
    await rejects(() => runChemToolkit({ action: 'conformers', molecules: ['CCCC'], out_path: '../x.sdf' }, exec), /outside|workspace/i, 'output path escape refused')
    workspace.write('mols/set.smi', 'CCO ethanol\nC((\nc1ccccc1 benzene\n')
    const fromSmi = runChemToolkit({ action: 'validate', path: 'mols/set.smi' }, exec)
    eq([fromSmi.valid, fromSmi.invalid], [2, 1], 'SMILES file input')
    ok(renderChem(sim)[0].text.includes('Tanimoto'), 'chem render')
    const rendered = await chemTool.execute({ action: 'validate', molecules: ['bad(('] }, exec)
    ok(!rendered.error && rendered.invalid === 1, 'tool execute returns the result')
    ok((await chemTool.execute({ action: 'validate' }, exec)).error, 'tool execute turns a thrown error into an error value')
  }

  // ---------- structure_toolkit (gemmi) ----------
  const structProbe = runHelper('structure_toolkit.py', { action: 'chains', path: '/nonexistent.pdb' })
  if (!/could not read/.test(structProbe?.error || '')) {
    console.log(`structure_toolkit skipped: ${structProbe?.error}`)
  } else {
    workspace.write('s/a.pdb', pdb())
    workspace.write('s/shifted.pdb', pdb({ shift: 25 }))
    const chains = runStructureToolkit({ action: 'chains', path: 's/a.pdb' }, exec)
    eq(chains.chains.map((c) => [c.chain, c.residues, c.sequence]), [['A', 6, 'AGSLVK'], ['B', 6, 'AGSLVK']], 'chains and sequences')
    eq(chains.chains[0].ligand_residues, 1, 'ligand counted on its chain')
    eq(chains.chains[0].water_residues, 1, 'water counted separately from ligands')
    ok(chains.provenance.tool_versions.gemmi, 'gemmi version recorded')
    const lig = runStructureToolkit({ action: 'ligands', path: 's/a.pdb' }, exec)
    eq(lig.distinct, { HEM: 1 }, 'waters are not ligands')
    ok(lig.caveat.includes('additives'), 'ligand caveat present')
    const con = runStructureToolkit({ action: 'contacts', path: 's/a.pdb', selection_a: 'HEM', selection_b: 'A', cutoff: 4 }, exec)
    ok(con.residue_pairs > 0, 'ligand-protein contacts found')
    ok(con.rows.every((r) => r.min_distance <= 4), 'cutoff respected')
    ok(con.rows[0].min_distance <= con.rows.at(-1).min_distance, 'rows sorted by distance')
    eq(runStructureToolkit({ action: 'contacts', path: 's/a.pdb', selection_a: 'HEM', selection_b: 'B', cutoff: 4 }, exec).residue_pairs, 0, 'no contacts with the distant chain')
    await rejects(() => runStructureToolkit({ action: 'contacts', path: 's/a.pdb', selection_a: 'HEM' }, exec), /selection_a and selection_b/, 'selections required')
    await rejects(() => runStructureToolkit({ action: 'contacts', path: 's/a.pdb', selection_a: 'A', selection_b: 'B', cutoff: 50 }, exec), /cutoff/, 'cutoff bounded')
    const sup = runStructureToolkit({ action: 'superpose', path: 's/a.pdb', path2: 's/shifted.pdb', chain: 'A' }, exec)
    near(sup.rmsd_angstrom, 0, 0.01, 'a pure translation superposes with ~zero RMSD')
    eq(sup.matched_atoms, 6, 'all C-alpha atoms matched')
    eq(sup.provenance.inputs.length, 2, 'both structures hashed')
    ok(sup.provenance.inputs[0].sha256 !== sup.provenance.inputs[1].sha256, 'distinct input hashes')
    await rejects(() => runStructureToolkit({ action: 'superpose', path: 's/a.pdb' }, exec), /path2 is required/, 'path2 required')
    await rejects(() => runStructureToolkit({ action: 'superpose', path: 's/a.pdb', path2: 's/shifted.pdb', chain: 'Z' }, exec), /chain|not found/i, 'unknown chain')
    await rejects(() => runStructureToolkit({ action: 'chains', path: '../../etc/passwd' }, exec), /outside|workspace/i, 'path escape refused')
    workspace.write('s/bad.pdb', 'not a structure\n')
    await rejects(() => runStructureToolkit({ action: 'chains', path: 's/bad.pdb' }, exec), /no models|could not read|empty/i, 'unparsable file is an error, not an empty result')
    ok(renderStructure(chains)[0].text.includes('AGSLVK'), 'structure render shows sequences')
  }

  console.log(`science toolkits: ${checks} checks passed`)
} finally {
  workspace.cleanup()
}
