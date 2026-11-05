/**
 * design: seeded randomization schedules, realized-balance diagnostics, and
 * design-of-experiments matrices.
 *
 * A schedule is deterministic given its stored seed. Balance is reported as
 * realized, never guaranteed. DOE output states the assumed model and aliasing;
 * no response is analysed.
 */
import { defineTool } from 'ah-dsh-tools'
import {
  DESIGN_ACTIONS, DESIGN_EXPORT_FORMATS, DOE_METHODS, RANDOMIZATION_METHODS,
  balanceReport, designStatus, doeSchedule, exportDesign, listDesignSchedules,
  randomizeSchedule, readSchedule,
} from './design-store.js'

function text(value) {
  return String(value ?? '').trim()
}

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function renderRandomize(value) {
  const schedule = value.schedule
  const counts = Object.entries(schedule.counts || {}).map(([arm, count]) => `${arm} ${count}`).join(' · ')
  const lines = [
    `Schedule ${schedule.schedule_id} (${schedule.method}) saved under \`.dsh/design/${value.slug || ''}/\`.`,
    `Seed: ${schedule.seed} · units: ${schedule.kind === 'doe' ? schedule.matrix.length : schedule.rows.length}${counts ? ` · ${counts}` : ''}.`,
  ]
  if (schedule.method === 'crossover') lines.push(`Sequences: ${schedule.design.sequences.join(' / ')} · periods: ${schedule.design.periods}.`)
  if (schedule.method === 'cluster') lines.push(`Clusters: ${schedule.design.clusters} · allocation ratio ${schedule.allocation.join(':')}.`)
  lines.push('Codes are a record of the allocation, not a substitute for concealment. The schedule is reproducible from the stored seed.')
  return lines.join('\n')
}

function renderBalance(value) {
  const report = value.report
  const lines = [
    `Balance for ${report.schedule_id} (${report.method}): ${report.units} unit(s).`,
    `Arms: ${Object.entries(report.arms).map(([arm, count]) => `${arm} ${count}`).join(' · ')}.`,
  ]
  if (report.numeric.length) {
    for (const entry of report.numeric.slice(0, 8)) {
      const smd = entry.smd.map((valueEntry) => `${valueEntry.arm} ${valueEntry.smd_vs_first == null ? 'n/a' : valueEntry.smd_vs_first.toFixed(2)}`).join(' · ')
      lines.push(`- ${entry.covariate}: ${smd} (SMD vs first arm)`)
    }
  }
  if (report.categorical.length) lines.push(`Categorical covariates checked: ${report.categorical.map((entry) => entry.covariate).join(', ')}.`)
  if (report.flags.length) {
    lines.push(`Flags (${report.flags.length}):`)
    for (const flag of report.flags.slice(0, 20)) lines.push(`- ${flag.kind}: ${flag.covariate || flag.arm}${flag.value != null ? ` ${flag.value}` : ''}`)
    if (report.flags.length > 20) lines.push(`- …${report.flags.length - 20} more`)
  } else lines.push('No imbalance flags at the |SMD| > 0.1 or 10% allocation-share thresholds.')
  lines.push(report.note)
  return lines.join('\n')
}

function renderDoe(value) {
  const schedule = value.schedule
  const aliasing = schedule.aliasing || {}
  const lines = [
    `DOE ${schedule.schedule_id} (${schedule.method}) saved: ${schedule.matrix.length} runs, ${schedule.factors.length} factor(s), seed ${schedule.seed}.`,
    `Factors: ${schedule.factors.map((factor) => `${factor.name} (${factor.low}…${factor.high})`).join(', ')}.`,
  ]
  if (aliasing.resolution) lines.push(`Resolution: ${aliasing.resolution}${aliasing.defining_relation?.length ? ` · defining relation: ${aliasing.defining_relation.map((word) => (Array.isArray(word) ? word.join('') : word)).join(', ')}` : ''}.`)
  if (aliasing.alias_groups?.length) {
    const groups = aliasing.alias_groups.filter((group) => group.aliases.length).slice(0, 8)
    if (groups.length) lines.push(`Alias groups: ${groups.map((group) => `${group.effect} ↔ ${group.aliases.join(', ')}`).join(' · ')}.`)
  }
  if (aliasing.note) lines.push(aliasing.note)
  lines.push('The matrix is a design, not an analysis: no response was fitted and no effect is claimed.')
  return lines.join('\n')
}

function renderStatus(status) {
  if (!status.schedules.length) return `No design schedules under \`.dsh/design/${status.slug}/\` yet.`
  return [
    `Design "${status.slug}": ${status.schedules.length} schedule(s).`,
    ...status.schedules.map((entry) => `- ${entry.schedule_id} · ${entry.kind} · ${entry.method} · seed ${entry.seed} · ${entry.units} unit(s) · ${entry.created_at}`),
    'Balance is realized, not guaranteed; DOE reports a design, not a fitted model.',
  ].join('\n')
}

function renderList(schedules) {
  if (!schedules.length) return 'No schedules recorded yet.'
  return [
    `${schedules.length} schedule(s):`,
    ...schedules.map((entry) => `- ${entry.schedule_id} · ${entry.kind}/${entry.method} · seed ${entry.seed} · ${entry.units} unit(s)`),
  ].join('\n')
}

function renderValue(value) {
  if (value?.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  switch (value.action) {
    case 'randomize': return [{ type: 'text', text: renderRandomize(value) }]
    case 'balance': return [{ type: 'text', text: renderBalance(value) }]
    case 'doe': return [{ type: 'text', text: renderDoe(value) }]
    case 'export': return [{ type: 'text', text: `Wrote ${value.result.path} (${value.result.bytes} bytes, ${value.result.format}, ${value.result.schedule_id}).` }]
    case 'status': return [{ type: 'text', text: renderStatus(value.status) }]
    case 'list': return [{ type: 'text', text: renderList(value.schedules) }]
    default: return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }
}

export async function runDesignAction(args, exec) {
  const action = args.action || 'status'
  if (!DESIGN_ACTIONS.includes(action)) throw new Error(`action must be one of ${DESIGN_ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  const slug = text(args.slug)
  if (action !== 'balance' && action !== 'export' && action !== 'list' && !slug) throw new Error('slug is required')
  if (action === 'randomize') {
    return { action, slug, ...(await randomizeSchedule({
      cwd, slug, method: args.method || 'simple', seed: args.seed,
      arms: args.arms, allocation: args.allocation, n: args.n, participants: args.participants,
      blockSize: args.block_size, strata: args.strata, clusters: args.clusters,
      sequences: args.sequences, nPerSequence: args.n_per_sequence, washout: args.washout,
      recordedBy: args.recorded_by,
    })) }
  }
  if (action === 'balance') {
    if (!slug) throw new Error('slug is required for balance')
    const record = readSchedule(cwd, slug, args.schedule_id || null)
    return { action, report: balanceReport(record) }
  }
  if (action === 'doe') {
    return { action, slug, ...(await doeSchedule({
      cwd, slug, method: args.method || 'full_factorial', seed: args.seed, factors: args.factors,
      generators: args.generators, runs: args.runs, alpha: args.alpha, centerPoints: args.center_points,
      recordedBy: args.recorded_by,
    })) }
  }
  if (action === 'export') {
    if (!slug) throw new Error('slug is required for export')
    return {
      action,
      result: exportDesign({
        cwd, slug, scheduleId: args.schedule_id || null, format: args.format || 'csv',
        out: args.out, overwrite: Boolean(args.overwrite),
      }),
    }
  }
  if (action === 'list') {
    if (!slug) throw new Error('slug is required for list')
    return { action, schedules: listDesignSchedules(cwd, slug) }
  }
  return { action, status: designStatus(cwd, slug) }
}

export const name = 'academic-harness-design'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'design',
    description: [
      'Generate reproducible randomization schedules and design-of-experiments matrices under `.dsh/design/<slug>/`.',
      `Actions: \`randomize\` (methods ${RANDOMIZATION_METHODS.join(', ')}; a seed is required and stored; allocation ratios, block size, strata, clusters, crossover sequences, minimization factors, allocation codes, and blinding codes), \`balance\` (realized arm counts and numeric/categorical balance with |SMD| and share flags), \`doe\` (methods ${DOE_METHODS.join(', ')}; full or fractional factorial, Plackett–Burman, central composite, Box–Behnken; factor levels, defining relation, aliasing, and a seeded run order), \`export\` (${DESIGN_EXPORT_FORMATS.join(', ')}), \`status\`, and \`list\`.`,
      'Balance is realized, not guaranteed, and only for supplied covariates. DOE output states its assumed model and aliasing; it does not fit or interpret a response. Randomization codes are records, not allocation concealment or a clinical workflow. Load the `experimental-design` skill before choosing a design or writing the analysis plan.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: DESIGN_ACTIONS, description: 'randomize, balance, doe, export, status, or list. Default status.' },
      slug: { type: 'string', description: 'Design slug.' },
      method: { type: 'string', description: `randomize: ${RANDOMIZATION_METHODS.join(', ')}. doe: ${DOE_METHODS.join(', ')}.` },
      seed: { type: 'number', description: 'Integer seed; required for randomize and doe so the schedule is reproducible.' },
      arms: { type: 'array', items: { type: 'string' }, description: 'Arm names (default control/treatment).' },
      allocation: { type: 'array', items: { type: 'number' }, description: 'Positive allocation ratio per arm (default 1:1).' },
      n: { type: 'number', description: 'Total participants (or use participants).' },
      participants: { type: 'array', description: 'Optional participant objects {participant_id, stratum?, covariates?, factors?}.' },
      block_size: { type: 'number', description: 'Block randomization: block size, a multiple of the allocation total.' },
      strata: { type: 'array', description: 'Strata: [{name, n}] or participants with a stratum field.' },
      clusters: { type: 'array', description: 'Cluster randomization: [{cluster_id, size, stratum?}].' },
      sequences: { type: 'array', description: 'Crossover sequences, e.g. ["AB","BA"] for one-letter arms or [["control","treatment"],["treatment","control"]].' },
      n_per_sequence: { type: 'number', description: 'Crossover: participants per sequence (default split evenly).' },
      washout: { type: 'string', description: 'Crossover washout description recorded with each row.' },
      factors: { type: 'array', description: 'DOE factors: names or {name, levels?, low?, high?, center?}.' },
      generators: { type: 'array', items: { type: 'string' }, description: 'Fractional factorial generators, e.g. ["D=ABC"].' },
      runs: { type: 'number', description: 'Plackett–Burman run count: 8, 12, or 16.' },
      alpha: { type: 'string', description: 'Central composite alpha: rotatable, orthogonal, face, or a positive number.' },
      center_points: { type: 'number', description: 'Central composite / Box–Behnken center points.' },
      schedule_id: { type: 'string', description: 'balance/export: a stored schedule id (default latest).' },
      format: { type: 'string', enum: DESIGN_EXPORT_FORMATS, description: 'Export format (default csv).' },
      out: { type: 'string', description: 'Export: workspace-relative output path.' },
      overwrite: { type: 'boolean', description: 'Export: replace an existing file.' },
      recorded_by: { type: 'string', description: 'Who recorded the schedule.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      try {
        return await runDesignAction(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Design: ${args.slug || ''} (${args.action || 'status'})`, kind: 'other' }
    },
  }))
}
