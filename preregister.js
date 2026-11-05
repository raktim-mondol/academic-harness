/**
 * preregister: freeze a study plan before data collection and export it.
 *
 * The ledger records the plan the author supplied and its hash. It never
 * invents a hypothesis or outcome, never claims registry acceptance, and never
 * contacts OSF: `submit` is explicit about being unimplemented.
 */
import { defineTool } from 'ah-dsh-tools'
import {
  DIRECTIONS, IMPORT_SOURCES, PREREGISTER_ACTIONS, PREREGISTER_EXPORT_FORMATS,
  exportPreregistration, freezePreregistration, importPreregistration,
  preregistrationStatus, startPreregistration, submitPreregistration,
  verifyPreregistration,
} from './preregister-store.js'

function text(value) {
  return String(value ?? '').trim()
}

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function renderStart(value) {
  const lines = [
    `Pre-registration "${value.slug}" ${value.created ? 'started' : 'updated'} (${value.frozen ? 'a frozen version exists' : 'not frozen yet'}).`,
  ]
  if (value.changed_fields?.length) lines.push(`Changed: ${value.changed_fields.join(', ')}.`)
  if (value.warning) lines.push(value.warning)
  lines.push('Freeze before data collection with action=freeze; a later edit becomes a new version with a reason.')
  return lines.join('\n')
}

function renderImport(value) {
  const source = value.source
  const lines = [
    `Imported from ${source.kind}${source.slug ? ` "${source.slug}"` : ''}${source.id ? ` (${source.id})` : ''}${source.path ? ` (${source.path})` : ''}.`,
    `Fields: ${value.imported_fields.join(', ') || 'none'}.`,
  ]
  if (source.note) lines.push(source.note)
  lines.push('The imported values are a snapshot of the source ledger, not a re-derivation. Review and freeze when complete.')
  return lines.join('\n')
}

function renderFreeze(value) {
  const lines = [
    `Froze pre-registration "${value.slug}" as version ${value.version}.`,
    `Plan hash: ${value.hash}`,
    `Frozen at: ${value.frozen_at}`,
  ]
  if (value.unchanged) lines.push('The plan is unchanged from the latest frozen version; no new version was written.')
  if (value.data_collected) lines.push('Data collection was recorded as started. This is not a clean pre-data registration; the reason is stored with the version.')
  if (value.incomplete?.length) lines.push(`Incomplete fields: ${value.incomplete.join(', ')}.`)
  if (value.warning) lines.push(value.warning)
  lines.push('Frozen versions are write-once; edit with new_version: true and a reason, then freeze again.')
  return lines.join('\n')
}

function renderStatus(status) {
  const lines = [`Pre-registration "${status.slug}" at ${status.dir}`]
  if (status.latest) {
    const plan = status.latest.plan
    lines.push(`Frozen v${status.latest.version} · ${status.latest.frozen_at} · ${status.latest.plan_hash}`)
    lines.push(`Question: ${plan.question}`)
    if (status.latest.data_collected) lines.push('WARNING: frozen after data collection started; see the recorded reason.')
  } else {
    lines.push('No frozen version yet.')
  }
  if (status.changed_fields.length) lines.push(`Draft differs from the frozen plan in: ${status.changed_fields.join(', ')}.`)
  if (status.missing_required.length) lines.push(`Missing required fields: ${status.missing_required.join(', ')}.`)
  if (status.sources.length) lines.push(`Imported sources: ${status.sources.map((source) => source.kind).join(', ')}.`)
  lines.push('Status is a record of the draft and frozen versions, not a compliance or registry check.')
  return lines.join('\n')
}

function renderVerify(value) {
  if (value.status === 'not_frozen') return `Pre-registration "${value.slug}": ${value.message}`
  const lines = [
    `Pre-registration "${value.slug}" verification: ${value.status} (v${value.version}, ${value.frozen_at}).`,
    `Hash: ${value.hash}`,
  ]
  for (const check of value.checks) lines.push(`- ${check.check}: ${check.status} — ${check.detail}`)
  if (value.status === 'tampered') lines.push('A frozen file or its hash no longer matches; do not treat this record as trustworthy until the cause is found.')
  if (value.status === 'changed') lines.push('The draft changed after freezing; freeze again to record a new version.')
  return lines.join('\n')
}

function renderValue(value) {
  if (value?.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  switch (value.action) {
    case 'start': return [{ type: 'text', text: renderStart(value) }]
    case 'import': return [{ type: 'text', text: renderImport(value) }]
    case 'freeze': return [{ type: 'text', text: renderFreeze(value) }]
    case 'status': return [{ type: 'text', text: renderStatus(value.status) }]
    case 'verify': return [{ type: 'text', text: renderVerify(value.verification) }]
    case 'export': return [{ type: 'text', text: value.result.success === false
      ? `PDF export failed: ${value.result.error}\nTeX source: ${value.result.tex}\n${value.result.note}`
      : `Wrote ${value.result.path || value.result.pdf_path || value.result.tex} (${value.result.format}, version ${value.result.version}).` }]
    case 'submit': return [{ type: 'text', text: `${value.status}: ${value.message}` }]
    default: return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }
}

export async function runPreregisterAction(args, exec) {
  const action = args.action || 'status'
  if (!PREREGISTER_ACTIONS.includes(action)) throw new Error(`action must be one of ${PREREGISTER_ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  const slug = text(args.slug)
  if (!slug) throw new Error('slug is required')

  if (action === 'start') {
    const value = await startPreregistration({
      cwd, slug, patch: buildPatch(args), newVersion: Boolean(args.new_version),
      reason: args.reason, recordedBy: args.recorded_by,
    })
    return { action, ...value }
  }
  if (action === 'import') {
    const value = await importPreregistration({
      cwd, slug, from: args.from, sourceSlug: args.source_slug || args.slug,
      id: args.id, treatment: args.treatment, outcome: args.outcome, power: args.power,
      file: args.file, overwrite: Boolean(args.overwrite), reason: args.reason,
      recordedBy: args.recorded_by,
    })
    return { action, ...value }
  }
  if (action === 'freeze') {
    const value = await freezePreregistration({
      cwd, slug, reason: args.reason, dataCollected: args.data_collected,
      allowIncomplete: Boolean(args.allow_incomplete), recordedBy: args.recorded_by,
    })
    return { action, ...value }
  }
  if (action === 'status') {
    return { action, status: preregistrationStatus(cwd, slug) }
  }
  if (action === 'verify') {
    return { action, verification: verifyPreregistration(cwd, slug) }
  }
  if (action === 'export') {
    const result = await exportPreregistration({
      cwd, slug, format: args.format || 'markdown', version: args.version,
      out: args.out, overwrite: Boolean(args.overwrite), engine: args.engine,
    })
    return { action, result }
  }
  return { action, ...(await submitPreregistration({ cwd, slug, confirm: Boolean(args.confirm), token: args.token })) }
}

function buildPatch(args) {
  const patch = args.plan && typeof args.plan === 'object' && !Array.isArray(args.plan) ? { ...args.plan } : {}
  for (const field of [
    'title', 'question', 'design', 'hypotheses', 'outcomes', 'sample_size', 'exclusions',
    'stopping_rules', 'analysis_plan', 'variables', 'data_collected', 'data_collection_start',
    'registration_url', 'notes',
  ]) {
    if (args[field] !== undefined) patch[field] = args[field]
  }
  return patch
}

export const name = 'academic-harness-preregister'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'preregister',
    description: [
      'Freeze a study plan before data collection and keep every later change as a new versioned record under `.dsh/preregister/<slug>/`.',
      `Actions: \`start\` (record title, question, design, sample_size with its basis, hypotheses with direction, outcomes, exclusions, stopping_rules, analysis_plan; \`new_version: true\` plus a \`reason\` is required to edit a frozen plan), \`import\` (from ${IMPORT_SOURCES.join(', ')}; a source ledger is read, never re-derived, and a stateless power result can be supplied as an object), \`freeze\` (hash the complete plan, write a write-once version file, and require a reason if data collection had started), \`status\`, \`verify\` (recompute the hash and detect draft changes or tampering), \`export\` (${PREREGISTER_EXPORT_FORMATS.join('/')}; JSON includes OSF/AsPredicted-shaped fields), and \`submit\` (disabled: no registry API is called).`,
      'Directions: greater, less, two_sided, difference, non_inferiority, not_recorded. Missing fields stay missing. Freezing does not make a prediction correct and export is not registry acceptance; review and submit it yourself.',
      'Load the `preregistering-analysis` skill for the discipline and the fields that matter.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: PREREGISTER_ACTIONS, description: 'start, import, freeze, status, verify, export, or submit. Default status.' },
      slug: { type: 'string', description: 'Pre-registration slug.' },
      plan: { type: 'object', additionalProperties: true, description: 'Plan fields for start (or pass them flat).' },
      title: { type: 'string', description: 'Study title.' },
      question: { type: 'string', description: 'The research question.' },
      design: { type: 'string', description: 'Design, e.g. two-arm randomized trial.' },
      hypotheses: { type: 'array', items: { type: 'string' }, description: 'Hypotheses as strings; use plan.hypotheses for ids/directions/notes.' },
      outcomes: { type: 'array', items: { type: 'string' }, description: 'Outcomes as strings; use plan.outcomes for ids/types/analysis/timepoints.' },
      sample_size: { type: 'object', additionalProperties: true, description: 'Sample size: {n, per_group, dropout, power, alpha, basis, test, effect_source, note}. `basis` records where the numbers came from.' },
      exclusions: { type: 'string', description: 'Pre-specified exclusion rules.' },
      stopping_rules: { type: 'string', description: 'Stopping or interim-analysis rules.' },
      analysis_plan: { type: 'string', description: 'The pre-specified analysis plan.' },
      variables: { type: 'object', additionalProperties: true, description: 'Optional variable mapping (treatment, outcome, covariates).' },
      data_collected: { type: 'boolean', description: 'True if data collection had already started when freezing; a reason is then required.' },
      data_collection_start: { type: 'string', description: 'Planned or actual data-collection start date.' },
      registration_url: { type: 'string', description: 'Existing registry record URL, if any.' },
      notes: { type: 'string', description: 'Free-text notes.' },
      new_version: { type: 'boolean', description: 'Allow editing a frozen pre-registration (start/import; requires reason).' },
      reason: { type: 'string', description: 'Why the plan changed, or why it is being frozen after data collection.' },
      from: { type: 'string', enum: IMPORT_SOURCES, description: 'import: source ledger.' },
      source_slug: { type: 'string', description: 'import: slug in the source ledger (defaults to slug).' },
      id: { type: 'string', description: 'import from coscientist: hypothesis id to use.' },
      treatment: { type: 'string', description: 'import from causal_dag: treatment node (defaults to the stored one).' },
      outcome: { type: 'string', description: 'import from causal_dag: outcome node (defaults to the stored one).' },
      power: { type: 'object', additionalProperties: true, description: 'import from power: a power_analysis result object (n, test, effect_size, power, alpha, effect_source, note).' },
      file: { type: 'string', description: 'import from file: workspace-relative JSON plan.' },
      overwrite: { type: 'boolean', description: 'import: replace conflicting draft fields (default false) or replace an existing export.' },
      allow_incomplete: { type: 'boolean', description: 'freeze: permit missing required fields with a reason (recorded as incomplete).' },
      recorded_by: { type: 'string', description: 'Who recorded this event.' },
      format: { type: 'string', enum: PREREGISTER_EXPORT_FORMATS, description: 'export format (default markdown).' },
      version: { type: 'number', description: 'export: frozen version to export (default latest).' },
      out: { type: 'string', description: 'export: workspace-relative output path.' },
      engine: { type: 'string', enum: ['pdflatex', 'xelatex', 'lualatex'], description: 'export format=pdf: LaTeX engine.' },
      confirm: { type: 'boolean', description: 'submit: required confirmation.' },
      token: { type: 'string', description: 'submit: unused unless a registry integration is configured.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return await runPreregisterAction(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Pre-register: ${args.slug || ''} (${args.action || 'status'})`, kind: 'other' }
    },
  }))
}
