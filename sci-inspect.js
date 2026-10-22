import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

const KINDS = ['chem', 'structure', 'massspec', 'arrays', 'imaging', 'anndata']

const KIND_TO_SCRIPT = {
  chem: 'chem_helper.py',
  structure: 'structure_helper.py',
  massspec: 'massspec_helper.py',
  arrays: 'arrays_helper.py',
  imaging: 'imaging_helper.py',
  anndata: 'anndata_helper.py',
}

const HERE = dirname(fileURLToPath(import.meta.url))

function helpersDir() {
  return process.env.ACADEMIC_HARNESS_HELPERS_DIR
    || process.env.RESEARCHCRAFT_HELPERS_DIR
    || join(HERE, 'python-helpers')
}

function pythonBin() {
  const override = process.env.ACADEMIC_HARNESS_PYTHON || process.env.RESEARCHCRAFT_PYTHON
  if (override) return override
  const dir = helpersDir()
  const venv = process.platform === 'win32'
    ? join(dir, '.venv', 'Scripts', 'python.exe')
    : join(dir, '.venv', 'bin', 'python')
  if (existsSync(venv)) return venv
  return process.platform === 'win32' ? 'python' : 'python3'
}

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function resolveWorkspacePath(cwd, path) {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

/** Register the scientific-file-format inspection tool. */
export function applySciInspect(ctx) {
  ctx.tools.register(defineTool({
    name: 'sci_inspect',
    description: [
      'Summarize a scientific file: chemistry (SMILES/MOL/SDF), structure (PDB/CIF), mass spec (mzML/etc.),',
      'arrays (npy/npz/parquet/hdf5), imaging (TIFF/NIfTI/DICOM), or AnnData (h5ad).',
      'Returns JSON from a Python helper. Requires the helper venv (see the plugin README — python-helpers/, uv sync).',
      'Prefer this over guessing binary scientific formats or reading them as text.',
    ].join(' '),
    parameters: {
      kind: {
        type: 'string',
        enum: KINDS,
        required: true,
        description: 'Which helper to run.',
      },
      path: {
        type: 'string',
        required: true,
        description: 'Workspace-relative or absolute path of the file to inspect.',
      },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        const body = value.status === 0
          ? value.stdout
          : (value.stderr || value.stdout || `helper exited ${value.status}`)
        return [{ type: 'text', text: body }]
      },
    },
    async execute(args, exec) {
      const script = join(helpersDir(), KIND_TO_SCRIPT[args.kind])
      if (!existsSync(script)) {
        return { status: 2, stdout: '', stderr: `helper script missing: ${script}` }
      }
      const target = resolveWorkspacePath(workspaceRoot(exec), args.path)
      const result = spawnSync(pythonBin(), [script, 'summarize', target], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 60_000,
      })
      return {
        status: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `Inspect ${args.kind ?? 'file'}`,
        kind: 'search',
        locations: args.path ? [{ path: args.path }] : undefined,
      }
    },
  }))
}
