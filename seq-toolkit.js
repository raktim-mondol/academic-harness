/**
 * seq_toolkit: local sequence computation (python-helpers/seq_toolkit.py,
 * pure Python). Sequence statistics, translation, ORF finding, primer Tm, and
 * pairwise alignment. No network and no BLAST: a database search is a
 * different claim and belongs to a source that states its own statistics.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { errorText, fileInput, inlineInput, provenanceLine, runToolkit, table, text, workspaceRoot } from './science-toolkit-kit.js'

const ACTIONS = ['stats', 'translate', 'orfs', 'primer_tm', 'align']
const MAX_INLINE_CHARS = 1_000_000

export function runSeqToolkit(args, exec, deps = {}) {
  const action = args.action || 'stats'
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  const request = { action }
  const inputs = []
  if (text(args.path)) {
    const input = fileInput(cwd, args.path)
    request.path = input.abs
    inputs.push(input)
  } else {
    const sequence = String(args.sequence ?? '')
    if (!sequence.trim()) throw new Error('sequence (FASTA or a raw sequence) or path is required')
    if (sequence.length > MAX_INLINE_CHARS) throw new Error('inline sequence is too long; save it to a file and pass path')
    request.sequence = sequence
    inputs.push(inlineInput('sequence', sequence))
  }
  if (action === 'align') {
    if (args.sequence_b != null) {
      request.sequence_b = String(args.sequence_b)
      inputs.push(inlineInput('sequence_b', request.sequence_b))
    }
    if (args.mode) request.mode = text(args.mode)
    for (const key of ['match', 'mismatch', 'gap']) if (args[key] != null) request[key] = Number(args[key])
  }
  if (action === 'translate') {
    if (args.frame != null) request.frame = Number(args.frame)
    request.to_stop = Boolean(args.to_stop)
  }
  if (action === 'orfs') {
    if (args.min_length_aa != null) request.min_length_aa = Number(args.min_length_aa)
    request.alt_starts = Boolean(args.alt_starts)
  }
  if (action === 'primer_tm') {
    for (const key of ['primer_nm', 'na_mm']) if (args[key] != null) request[key] = Number(args[key])
  }
  if (action === 'stats' && text(args.kind)) request.kind = text(args.kind).toLowerCase()
  return runToolkit({ tool: 'seq_toolkit', script: 'seq_toolkit.py', request, inputs, cwd, deps, timeoutMs: 60_000 })
}

export function renderValue(value) {
  if (value.error) return errorText(value)
  const lines = []
  if (value.action === 'stats') {
    lines.push(...table(value.rows.map((r) => ({ ...r, gc: r.gc_percent ?? '', mass: r.mass_da ?? '' })), [['name', 'Name'], ['type', 'Type'], ['length', 'Length'], ['gc', 'GC %'], ['mass', 'Mass (Da)']]))
    for (const r of value.rows) if (r.warning) lines.push(`${r.name}: ${r.warning}`)
  } else if (value.action === 'translate') {
    lines.push(`Translation, ${value.table}`)
    for (const r of value.rows) {
      lines.push(r.error ? `- ${r.name}: ${r.error}` : `- ${r.name} (frame ${r.frame}, ${r.protein_length} aa, ${r.internal_stops} internal stop(s)): ${r.protein.slice(0, 200)}${r.protein.length > 200 ? '…' : ''}`)
    }
  } else if (value.action === 'orfs') {
    lines.push(`${value.found} ORF(s) of at least ${value.min_length_aa} aa (starts: ${value.start_codons.join('/')})${value.truncated ? '; first 100 shown' : ''}`)
    lines.push(...table(value.orfs.slice(0, 30), [['name', 'Seq'], ['strand', 'Strand'], ['frame', 'Frame'], ['start', 'Start'], ['end', 'End'], ['length_aa', 'aa'], ['has_stop', 'Stop'], ['protein_preview', 'Preview']]))
    lines.push(value.caveat)
  } else if (value.action === 'primer_tm') {
    lines.push(`${value.method} · ${value.conditions.primer_nM} nM primer, ${value.conditions.Na_mM} mM Na+`)
    lines.push(...table(value.rows.map((r) => ({ ...r, state: r.error ? r.error : '' })), [['name', 'Name'], ['length', 'nt'], ['gc_percent', 'GC %'], ['tm_c', 'Tm (°C)'], ['wallace_tm_c', 'Wallace'], ['three_prime_gc_clamp', "3' GC clamp"], ['state', 'Note']]))
    lines.push(value.caveat)
  } else if (value.action === 'align') {
    lines.push(`${value.mode} alignment · ${value.scoring} · score ${value.score}`)
    lines.push(`${value.a.name} ${value.a.aligned_from}-${value.a.aligned_to} vs ${value.b.name} ${value.b.aligned_from}-${value.b.aligned_to} · ${value.identities}/${value.alignment_columns} identical (${value.percent_identity_of_columns}%) · ${value.gaps} gap(s)`)
    const { a, match, b } = value.alignment
    for (let i = 0; i < Math.min(a.length, 600); i += 60) lines.push('```', a.slice(i, i + 60), match.slice(i, i + 60), b.slice(i, i + 60), '```')
    lines.push(value.caveat)
  }
  lines.push(provenanceLine(value))
  return [{ type: 'text', text: lines.filter(Boolean).join('\n') }]
}

export const name = 'academic-harness-seq-toolkit'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'seq_toolkit',
    description: [
      'Compute on DNA, RNA, and protein sequences locally. `stats` gives length, type, composition, GC%, and protein average mass; `translate` uses the standard genetic code in any of six frames; `orfs` finds open reading frames on both strands with a minimum length; `primer_tm` gives a SantaLucia nearest-neighbour Tm with salt correction (and the Wallace rule for reference); `align` does one global or local pairwise alignment with stated scoring (BLOSUM62 for protein when Biopython is installed, otherwise identity scoring, and the result says which).',
      'Input is an inline `sequence` (raw or FASTA, multiple records allowed) or a workspace `path`. Local only: no network, no BLAST, no database search. Every result records the input SHA-256 and versions. ORFs are candidates, a Tm is a model estimate to verify before ordering, and an alignment score without a null model is not a homology test.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ACTIONS, description: 'stats (default), translate, orfs, primer_tm, or align.' },
      sequence: { type: 'string', description: 'Inline sequence or FASTA text.' },
      path: { type: 'string', description: 'Workspace-relative FASTA/sequence file (instead of sequence).' },
      sequence_b: { type: 'string', description: 'align: the second sequence (otherwise the first two FASTA records are aligned).' },
      mode: { type: 'string', enum: ['global', 'local'], description: 'align: global (default) or local.' },
      match: { type: 'number', description: 'align (nucleotide): match score, default 2.' },
      mismatch: { type: 'number', description: 'align (nucleotide): mismatch score, default -1.' },
      gap: { type: 'number', description: 'align: linear gap penalty (default -2; -8 with BLOSUM62).' },
      frame: { type: 'number', description: 'translate: 1, 2, 3, -1, -2, or -3 (default 1).' },
      to_stop: { type: 'boolean', description: 'translate: stop at the first stop codon.' },
      min_length_aa: { type: 'number', description: 'orfs: minimum length in amino acids (default 100).' },
      alt_starts: { type: 'boolean', description: 'orfs: also accept GTG and TTG as starts.' },
      primer_nm: { type: 'number', description: 'primer_tm: primer concentration in nM (default 250).' },
      na_mm: { type: 'number', description: 'primer_tm: monovalent cation in mM (default 50).' },
      kind: { type: 'string', enum: ['dna', 'rna', 'protein'], description: 'stats: override the detected type.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return runSeqToolkit(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Sequence ${args.action || 'stats'}`, kind: 'other' }
    },
  }))
}
