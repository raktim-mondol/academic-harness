/**
 * chem_toolkit: local small-molecule computation through RDKit
 * (python-helpers/chem_toolkit.py). No network. Every run records the input
 * hash and RDKit version; an unparsable structure is reported invalid with the
 * reason, never repaired silently.
 */
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureDir, hashFile } from './ledger-kit.js'
import { resolveWorkspacePath } from './workspace-path.js'
import { errorText, fileInput, inlineInput, provenanceLine, runToolkit, table, text, workspaceRoot } from './science-toolkit-kit.js'

const ACTIONS = ['validate', 'standardize', 'descriptors', 'similarity', 'substructure', 'conformers']
const MAX_INLINE = 2000

function asList(value) {
  if (Array.isArray(value)) return value.map(String)
  const one = text(value)
  return one ? one.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : []
}

export function runChemToolkit(args, exec, deps = {}) {
  const action = args.action || 'descriptors'
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  const request = { action }
  const inputs = []
  if (text(args.path)) {
    const input = fileInput(cwd, args.path)
    request.path = input.abs
    inputs.push(input)
  } else {
    const molecules = asList(args.molecules ?? args.smiles)
    if (!molecules.length) throw new Error('molecules (SMILES strings, optionally "SMILES name") or path is required')
    if (molecules.length > MAX_INLINE) throw new Error(`inline input is limited to ${MAX_INLINE} structures; put larger sets in a file and pass path`)
    request.molecules = molecules
    inputs.push(inlineInput('molecules', molecules))
  }
  if (action === 'similarity') {
    request.query = text(args.query)
    if (!request.query) throw new Error('query (a SMILES string) is required for similarity')
    inputs.push(inlineInput('query', request.query))
    for (const key of ['threshold', 'top_k', 'radius', 'n_bits']) if (args[key] != null) request[key] = Number(args[key])
  }
  if (action === 'substructure') {
    request.pattern = text(args.pattern)
    if (!request.pattern) throw new Error('pattern (SMARTS) is required for substructure')
    inputs.push(inlineInput('pattern', request.pattern))
  }
  if (action === 'standardize') request.tautomer = Boolean(args.tautomer)
  let outRel = null
  if (action === 'conformers') {
    if (args.n_conformers != null) request.n_conformers = Number(args.n_conformers)
    if (args.seed != null) request.seed = Number(args.seed)
    if (text(args.out_path)) {
      outRel = text(args.out_path)
      const abs = resolveWorkspacePath(cwd, outRel, { forWrite: true })
      if (existsSync(abs) && !args.overwrite) throw new Error(`${outRel} already exists; pass overwrite: true to replace it`)
      ensureDir(dirname(abs))
      request.out_path = abs
    }
  }
  const result = runToolkit({ tool: 'chem_toolkit', script: 'chem_toolkit.py', request, inputs, cwd, deps })
  if (outRel && result.written) {
    result.written = outRel
    result.provenance.outputs = [{ path: outRel, sha256: `sha256:${hashFile(resolveWorkspacePath(cwd, outRel))}` }]
  }
  return result
}

export function renderValue(value) {
  if (value.error) return errorText(value)
  const lines = []
  if (value.action === 'validate') {
    lines.push(`${value.valid} valid, ${value.invalid} invalid of ${value.count} structure(s)`)
    lines.push(...table(value.rows.slice(0, 40).map((r) => ({ ...r, state: r.valid ? 'valid' : r.error })), [['name', 'Name'], ['state', 'State'], ['canonical_smiles', 'Canonical SMILES'], ['formula', 'Formula']]))
  } else if (value.action === 'standardize') {
    lines.push(`${value.rows.filter((r) => r.ok).length}/${value.count} standardized`)
    lines.push(...table(value.rows.slice(0, 40).map((r) => ({ ...r, state: r.ok ? (r.changed ? 'changed' : 'unchanged') : r.error })), [['name', 'Name'], ['state', 'State'], ['standardized_smiles', 'Standardized SMILES'], ['inchikey', 'InChIKey']]))
    lines.push(value.steps_note)
  } else if (value.action === 'descriptors') {
    lines.push(...table(value.rows.slice(0, 40).map((r) => ({ ...r, ro5: r.valid ? r.rule_of_five_violations : '' })), [['name', 'Name'], ['formula', 'Formula'], ['mol_weight', 'MW'], ['logp_crippen', 'cLogP'], ['tpsa', 'TPSA'], ['hbd', 'HBD'], ['hba', 'HBA'], ['rotatable_bonds', 'RotB'], ['ro5', 'Ro5 flags']]))
    lines.push(value.caveat)
  } else if (value.action === 'similarity') {
    lines.push(`Query ${value.query} · ${value.fingerprint} · ${value.compared} compared, ${value.above_threshold} at or above threshold`)
    lines.push(...table(value.rows.slice(0, 40), [['name', 'Name'], ['tanimoto', 'Tanimoto'], ['canonical_smiles', 'SMILES']]))
    if (value.invalid_count) lines.push(`${value.invalid_count} input structure(s) could not be parsed and were skipped.`)
    lines.push(value.caveat)
  } else if (value.action === 'substructure') {
    lines.push(`Pattern ${value.pattern}: ${value.matches} of ${value.searched} structure(s) match${value.truncated ? ' (first 200 shown)' : ''}`)
    lines.push(...table(value.rows.slice(0, 40), [['name', 'Name'], ['match_count', 'Matches'], ['canonical_smiles', 'SMILES']]))
  } else if (value.action === 'conformers') {
    lines.push(...table(value.rows.map((r) => ({ ...r, state: r.ok ? r.conformers : r.error })), [['name', 'Name'], ['state', 'Conformers'], ['force_field', 'Force field'], ['lowest_energy_kcal_mol', 'Lowest E (kcal/mol)'], ['energy_range_kcal_mol', 'Range']]))
    if (value.written) lines.push(`Conformers written to ${value.written}`)
    lines.push(value.caveat)
  }
  if (value.note) lines.push(value.note)
  lines.push(provenanceLine(value))
  return [{ type: 'text', text: lines.filter(Boolean).join('\n') }]
}

export const name = 'academic-harness-chem-toolkit'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'chem_toolkit',
    description: [
      'Compute on small molecules locally with RDKit. `validate` parses SMILES/SDF and reports canonical SMILES, formula, and why an input failed; `standardize` cleans, keeps the largest fragment, neutralizes, optionally canonicalizes tautomers, and gives InChIKeys; `descriptors` returns MW, exact mass, Crippen logP, TPSA, HBD/HBA, rotatable bonds, rings, and a rule-of-five flag count; `similarity` ranks a set against a query by Morgan-fingerprint Tanimoto; `substructure` matches a SMARTS pattern; `conformers` embeds and MMFF-relaxes conformers (seeded) and can write an SDF.',
      'Input is inline `molecules` (one SMILES per entry, optional name after a space) or a workspace `path` (.smi/.sdf). Local only, no network. Each result carries the input SHA-256 and the RDKit version. Descriptors are calculated estimates and the rule-of-five count is a screening heuristic; similarity is not evidence of shared activity. Not for property prediction claims, docking, or toxicity calls. Needs the helper environment (`cd python-helpers && uv sync`).',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ACTIONS, description: 'validate, standardize, descriptors (default), similarity, substructure, or conformers.' },
      molecules: { type: 'array', items: { type: 'string' }, description: 'Inline structures: "SMILES" or "SMILES name" (max 2000).' },
      path: { type: 'string', description: 'Workspace-relative .smi/.sdf file (instead of molecules; first 5000 structures).' },
      query: { type: 'string', description: 'similarity: the query SMILES.' },
      pattern: { type: 'string', description: 'substructure: a SMARTS pattern.' },
      threshold: { type: 'number', description: 'similarity: minimum Tanimoto to keep (default 0).' },
      top_k: { type: 'number', description: 'similarity: rows to return (default 20).' },
      radius: { type: 'number', description: 'similarity: Morgan radius (default 2).' },
      n_bits: { type: 'number', description: 'similarity: fingerprint length (default 2048).' },
      tautomer: { type: 'boolean', description: 'standardize: also canonicalize the tautomer (default false).' },
      n_conformers: { type: 'number', description: 'conformers: per molecule, 1-50 (default 10).' },
      seed: { type: 'number', description: 'conformers: random seed (default 42).' },
      out_path: { type: 'string', description: 'conformers: workspace-relative SDF to write.' },
      overwrite: { type: 'boolean', description: 'conformers: replace an existing out_path (default false).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return runChemToolkit(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Chemistry ${args.action || 'descriptors'}`, kind: 'other' }
    },
  }))
}
