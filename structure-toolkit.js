/**
 * structure_toolkit: local macromolecular-structure computation through gemmi
 * (python-helpers/structure_toolkit.py). Chains and sequences, deposited
 * ligands, distance contacts, and C-alpha/backbone superposition. No network:
 * use science_source `fetch` with `save_to` to bring a file into the workspace.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { errorText, fileInput, provenanceLine, runToolkit, table, text, workspaceRoot } from './science-toolkit-kit.js'

const ACTIONS = ['chains', 'ligands', 'contacts', 'superpose']

export function runStructureToolkit(args, exec, deps = {}) {
  const action = args.action || 'chains'
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  const first = fileInput(cwd, args.path, 'path')
  const request = { action, path: first.abs }
  const inputs = [first]
  if (action === 'contacts') {
    request.selection_a = text(args.selection_a)
    request.selection_b = text(args.selection_b)
    if (args.cutoff != null) request.cutoff = Number(args.cutoff)
    request.include_waters = Boolean(args.include_waters)
  }
  if (action === 'superpose') {
    const second = fileInput(cwd, args.path2, 'path2')
    request.path2 = second.abs
    inputs.push(second)
    if (text(args.chain)) request.chain = text(args.chain)
    if (text(args.chain2)) request.chain2 = text(args.chain2)
    if (text(args.atoms)) request.atoms = text(args.atoms)
  }
  return runToolkit({ tool: 'structure_toolkit', script: 'structure_toolkit.py', request, inputs, cwd, deps })
}

export function renderValue(value) {
  if (value.error) return errorText(value)
  const lines = []
  const s = value.structure
  if (s) lines.push(`${s.models} model(s) · ${s.chains_in_first_model} chain(s) · ${s.atoms_in_first_model} atoms${s.resolution ? ` · ${s.resolution} Å` : ''}${s.spacegroup ? ` · ${s.spacegroup}` : ''}`)
  if (value.action === 'chains') {
    lines.push(...table(value.chains.map((c) => ({ ...c, range: c.residues ? `${c.first_residue}-${c.last_residue}` : '' })), [['chain', 'Chain'], ['polymer_type', 'Type'], ['residues', 'Residues'], ['range', 'Numbering'], ['ligand_residues', 'Ligands'], ['water_residues', 'Waters']]))
    for (const c of value.chains) if (c.sequence) lines.push(`Chain ${c.chain}: ${c.sequence.slice(0, 120)}${c.sequence.length > 120 ? '…' : ''}`)
    if (value.alternate_models_note) lines.push(value.alternate_models_note)
  } else if (value.action === 'ligands') {
    lines.push(`Distinct: ${Object.entries(value.distinct).map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}`)
    lines.push(...table(value.rows.slice(0, 40), [['chain', 'Chain'], ['name', 'Residue'], ['seq', 'Seq'], ['atoms', 'Atoms']]))
    lines.push(value.caveat)
  } else if (value.action === 'contacts') {
    lines.push(`${value.selection_a} ↔ ${value.selection_b} within ${value.cutoff_angstrom} Å: ${value.residue_pairs} residue pair(s), ${value.atom_pairs} atom pair(s)${value.truncated ? ' (first 200 shown)' : ''}`)
    lines.push(...table(value.rows.slice(0, 40), [['a_chain', 'A chain'], ['a_residue', 'A res'], ['a_seq', 'A seq'], ['b_chain', 'B chain'], ['b_residue', 'B res'], ['b_seq', 'B seq'], ['min_distance', 'Min Å'], ['symmetry_mate', 'Sym']]))
    lines.push(value.caveat)
  } else if (value.action === 'superpose') {
    lines.push(`Chain ${value.moving.chain} (${value.moving.residues} res) onto chain ${value.fixed.chain} (${value.fixed.residues} res): RMSD ${value.rmsd_angstrom} Å over ${value.matched_atoms} ${value.atoms} atoms`)
    lines.push(value.caveat)
  }
  lines.push(provenanceLine(value))
  return [{ type: 'text', text: lines.filter(Boolean).join('\n') }]
}

export const name = 'academic-harness-structure-toolkit'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'structure_toolkit',
    description: [
      'Compute on PDB/mmCIF structure files locally with gemmi. `chains` lists chains with polymer type, residue range, one-letter sequence, and ligand/water counts; `ligands` lists non-polymer, non-water residues; `contacts` lists residue pairs within a distance cutoff between two selections (a chain id, or a residue name such as HEM), marking crystal-symmetry neighbours; `superpose` aligns a chain of `path2` onto a chain of `path` by C-alpha or backbone atoms and reports RMSD and the transform.',
      'Files must be in the workspace; bring one in with `science_source` fetch + `save_to`. Local only. Each result records the input SHA-256 and the gemmi version. Only the first model is read, outputs are capped and say so, and nothing is rendered or written. Listed ligands include additives and ions, contacts are proximity not interaction type, and an RMSD over a short match is weak evidence.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ACTIONS, description: 'chains (default), ligands, contacts, or superpose.' },
      path: { type: 'string', description: 'Workspace-relative .pdb/.cif file.' },
      selection_a: { type: 'string', description: 'contacts: a chain id or residue name.' },
      selection_b: { type: 'string', description: 'contacts: a chain id or residue name.' },
      cutoff: { type: 'number', description: 'contacts: distance in Å, 1-8 (default 4).' },
      include_waters: { type: 'boolean', description: 'contacts: include water residues (default false).' },
      path2: { type: 'string', description: 'superpose: the structure to move onto path.' },
      chain: { type: 'string', description: 'superpose: chain in path (default the first chain).' },
      chain2: { type: 'string', description: 'superpose: chain in path2 (default the same id).' },
      atoms: { type: 'string', enum: ['ca', 'backbone'], description: 'superpose: atoms to fit (default ca).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return runStructureToolkit(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Structure ${args.action || 'chains'}: ${args.path || ''}`, kind: 'other' }
    },
  }))
}
