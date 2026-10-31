/**
 * repro_package: build a reader-facing reproducibility package (environment,
 * manifests, code/data references, container spec, citation metadata) from the
 * analysis, experiment, and dataset ledgers. Building never uploads; deposit
 * to Zenodo is confirm-gated and creates a draft only.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import {
  buildReproPackage, depositReproPackage, readReproPlan, reproDepositPreview,
  reproStatus, saveReproPlan, verifyReproPackage,
} from './repro-package-store.js'

const ACTIONS = ['plan', 'build', 'verify', 'status', 'deposit']

function text(value) {
  return String(value ?? '').trim()
}

function requireString(value, name) {
  const result = text(value)
  if (!result) throw new Error(`${name} is required`)
  return result
}

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function renderValue(value) {
  if (value.error) {
    const preview = value.preview
      ? `\nPreview: ${value.preview.files.length} file(s), ${value.preview.total_bytes} bytes; blockers: ${value.preview.blockers.join('; ') || 'none'}. Re-issue with confirm: true and preview_hash: ${value.preview.preview_hash} once resolved.`
      : ''
    return [{ type: 'text', text: `Error: ${value.error}${preview}` }]
  }
  switch (value.action) {
    case 'plan':
      return [{ type: 'text', text: `Reproducibility plan "${value.plan.slug}" frozen: ${value.plan.name}\nOutput directory: ${value.plan.output_dir}${value.plan.include_data ? ' (data will be copied)' : ' (data referenced, not copied)'}` }]
    case 'build': {
      const lines = [`Built ${value.package.path}: ${value.package.files} file(s), ${value.package.bytes} bytes.`]
      if (value.package.warnings.length) lines.push('Warnings:', ...value.package.warnings.map((warning) => `- ${warning}`))
      lines.push('The package is reproducibility evidence, not a guarantee.')
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'verify': {
      const lines = [`Verify ${value.result.path}: ${value.result.ok}/${value.result.files} file(s) match the manifest hashes.`]
      for (const problem of value.result.problems) lines.push(`- ${problem.path}: ${problem.status}`)
      return [{ type: 'text', text: lines.join('\n') }]
    }
    case 'status': {
      const s = value.status
      return [{ type: 'text', text: [
        `Package "${s.slug}" (${s.name}) → ${s.output_dir}: ${s.built ? 'built' : 'not built yet'}.`,
        `Inventory: ${s.analyses} analysis, ${s.experiments} experiment, ${s.datasets} dataset reference(s); ${s.code_files} code file(s).`,
        `License: ${s.license || 'NOT STATED — flag for the authors'}.`,
      ].join('\n') }]
    }
    case 'deposit':
      return [{ type: 'text', text: `Zenodo draft ${value.deposition.deposition_id} created with ${value.deposition.files_uploaded.length} file(s).${value.deposition.html_url ? ` Review at ${value.deposition.html_url}.` : ''} Publishing stays a human action.` }]
    case 'preview':
      return [{ type: 'text', text: [
        `Deposit preview for "${value.preview.slug}" → zenodo:`,
        `Title: ${value.preview.metadata.title}`,
        `License: ${value.preview.metadata.license || 'NOT STATED (blocker)'}`,
        `Files: ${value.preview.files.length} (${value.preview.total_bytes} bytes)`,
        `Blockers: ${value.preview.blockers.join('; ') || 'none'}`,
        `preview_hash: ${value.preview.preview_hash}`,
        value.preview.note,
      ].join('\n') }]
    default:
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }
}

export async function runReproPackage(args, exec, deps = {}) {
  const action = args.action || 'status'
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  const slug = requireString(args.slug, 'slug')

  if (action === 'plan') {
    return { action, plan: saveReproPlan({ cwd, slug, plan: args.plan }) }
  }
  if (action === 'build') {
    readReproPlan(cwd, slug)
    return { action, package: buildReproPackage({ cwd, slug, overwrite: Boolean(args.overwrite) }) }
  }
  if (action === 'verify') {
    return { action, result: verifyReproPackage({ cwd, slug }) }
  }
  if (action === 'status') {
    return { action, status: reproStatus(cwd, slug) }
  }
  // deposit
  const readEnv = deps.resolveEnv || resolveEnv
  const token = deps.token ?? await readEnv('ZENODO_API_KEY')
  if (args.preview_only || !args.confirm) {
    return { action: 'preview', preview: reproDepositPreview(cwd, slug) }
  }
  const deposition = await depositReproPackage({
    cwd, slug,
    confirm: true,
    previewHash: args.preview_hash,
    token,
    http: deps.http || ((url, options) => fetch(url, options)),
  })
  return { action, deposition }
}

export const name = 'academic-harness-repro-package'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'repro_package',
    description: [
      'Build reproducibility packages from the other ledgers. `plan` freezes an inventory (title, authors, analysis_run slugs/run ids, experiment_log slugs, dataset_get slugs/DOIs, code files, manuscript, repo, license, funder, citation, output dir, include_data). `build` writes a reader-facing package — manifest.json with SHA-256 per file, environment/ snapshot, generated Dockerfile, README with run order and data availability, CITATION.cff, codemeta.json, RO-Crate 1.1 metadata, checksums.sha256 — without uploading anything. `verify` re-hashes the package against its manifest; `status` reports readiness.',
      '`deposit` targets Zenodo only: without `confirm: true` it returns a preview (files, license blockers, preview_hash); with confirm and an unchanged preview_hash and a configured ZENODO_API_KEY it creates a draft deposition and uploads files — it never publishes, and data are not copied into the package unless include_data is set. Unknown licenses and failed runs are flagged, never hidden. The package is evidence of reproducibility, not proof the result is correct.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ACTIONS, description: 'plan, build, verify, status, or deposit. Default status.' },
      slug: { type: 'string', description: 'Package slug.' },
      plan: { type: 'object', additionalProperties: true, description: 'Inventory for plan: {name, authors, analyses:[{slug,run_id?}], experiments:[{slug}], datasets:[{slug}], code_files:[], manuscript, repo, license, funder, citation, output_dir, include_data, notes}.' },
      overwrite: { type: 'boolean', description: 'Rebuild over an existing output directory (default false).' },
      confirm: { type: 'boolean', description: 'Required for deposit, together with preview_hash.' },
      preview_hash: { type: 'string', description: 'preview_hash from the deposit preview (deposit).' },
      preview_only: { type: 'boolean', description: 'Return the deposit preview without checking confirmation (deposit).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return await runReproPackage(args, exec)
      } catch (error) {
        const value = { error: error instanceof Error ? error.message : String(error) }
        if (error?.code) value.code = error.code
        if (error?.preview) value.preview = error.preview
        return value
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Repro package: ${args.slug || ''} (${args.action || 'status'})`, kind: 'other' }
    },
  }))
}
