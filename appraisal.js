/**
 * Risk-of-bias instrument templates, derivation, and table/summary/figure
 * data. Pure apart from reading the bundled `appraisal/` templates.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  resolveSeries, reviewerKey, reviewerLabel,
} from './agreement.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'appraisal')

const ALIASES = {
  'rob-2': 'rob-2',
  rob2: 'rob-2',
  'risk-of-bias-2': 'rob-2',
  'robins-i': 'robins-i',
  robins: 'robins-i',
  robinsi: 'robins-i',
  'quadas-2': 'quadas-2',
  quadas2: 'quadas-2',
  quadas: 'quadas-2',
  'newcastle-ottawa': 'newcastle-ottawa',
  'newcastle-ottawa-scale': 'newcastle-ottawa',
  nos: 'newcastle-ottawa',
}

const AXES = ['risk_of_bias', 'applicability']

function normalizeId(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '-')
}

export function instrumentKey(reference, version = null) {
  let raw = normalizeId(reference)
  let wanted = version == null ? null : String(version).trim()
  const at = raw.lastIndexOf('@')
  if (at > 0) {
    wanted = wanted || raw.slice(at + 1)
    raw = raw.slice(0, at)
  }
  return { id: ALIASES[raw] || raw, version: wanted }
}

function compareVersions(a, b) {
  const split = (value) => String(value ?? '').split(/[.+-]/)
  const left = split(a)
  const right = split(b)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? '0'
    const r = right[index] ?? '0'
    const ln = Number(l)
    const rn = Number(r)
    if (Number.isFinite(ln) && Number.isFinite(rn)) {
      if (ln !== rn) return ln - rn
      continue
    }
    const compared = String(l).localeCompare(String(r))
    if (compared) return compared
  }
  return 0
}

export function validateTemplate(template) {
  if (!template || typeof template !== 'object') throw new Error('instrument template must be an object')
  for (const key of ['id', 'name', 'version', 'source_url']) {
    if (typeof template[key] !== 'string' || !template[key].trim()) {
      throw new Error(`instrument template needs a non-empty ${key}`)
    }
  }
  if (!/^https?:\/\//.test(template.source_url)) throw new Error('instrument source_url must be a URL')

  const scale = template.scale
  if (!scale || !['ordinal', 'stars'].includes(scale.type)) {
    throw new Error('instrument scale must be ordinal or stars')
  }
  if (scale.type === 'ordinal') {
    if (!Array.isArray(scale.values) || scale.values.length < 2) {
      throw new Error('an ordinal scale needs at least two values')
    }
    const ids = new Set()
    for (const value of scale.values) {
      if (!value?.id || !value.label) throw new Error('every scale value needs an id and a label')
      if (ids.has(value.id)) throw new Error(`duplicate scale value ${value.id}`)
      ids.add(value.id)
    }
  }

  if (!Array.isArray(template.domains) || !template.domains.length) {
    throw new Error('instrument needs at least one domain')
  }
  const domainIds = new Set()
  for (const domain of template.domains) {
    if (!domain?.id || !domain.name || !domain.short_prompt) {
      throw new Error('every domain needs an id, name, and short_prompt')
    }
    if (domainIds.has(domain.id)) throw new Error(`duplicate domain id ${domain.id}`)
    domainIds.add(domain.id)
    const axes = domain.axes || ['risk_of_bias']
    if (!Array.isArray(axes) || axes.length === 0 || axes.some((axis) => !AXES.includes(axis))) {
      throw new Error(`domain ${domain.id} has an invalid axis list`)
    }
    if (scale.type === 'stars') {
      if (!Number.isInteger(domain.max_stars) || domain.max_stars < 1) {
        throw new Error(`star domain ${domain.id} needs a positive max_stars`)
      }
    }
    if (domain.signalling != null) {
      if (!Array.isArray(domain.signalling)) throw new Error(`domain ${domain.id} signalling must be an array`)
      const questionIds = new Set()
      for (const question of domain.signalling) {
        if (!question?.id || !question.prompt || !Array.isArray(question.answers) || question.answers.length < 2) {
          throw new Error(`domain ${domain.id} has an invalid signalling question`)
        }
        if (questionIds.has(question.id)) throw new Error(`duplicate signalling id ${question.id}`)
        questionIds.add(question.id)
      }
    }
  }

  if (template.overall != null) {
    if (scale.type !== 'ordinal') throw new Error('an overall rule needs an ordinal scale')
    if (!template.overall.rule || template.overall.rule.type !== 'worst') {
      throw new Error('only the "worst" overall rule is supported')
    }
    const order = template.overall.rule.order
    const scaleIds = new Set(scale.values.map((value) => value.id))
    if (!Array.isArray(order) || order.length !== scaleIds.size
      || new Set(order).size !== order.length || order.some((id) => !scaleIds.has(id))) {
      throw new Error('the overall rule order must list every scale value exactly once')
    }
  }

  return template
}

export function loadInstruments() {
  if (!existsSync(ROOT)) return []
  const out = []
  for (const dir of readdirSync(ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    for (const file of readdirSync(join(ROOT, dir.name))) {
      if (!file.endsWith('.json')) continue
      const path = join(ROOT, dir.name, file)
      try {
        out.push(validateTemplate(JSON.parse(readFileSync(path, 'utf8'))))
      } catch (error) {
        throw new Error(`instrument ${dir.name}/${file} is invalid: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || compareVersions(a.version, b.version))
}

export function resolveInstrument(reference, version = null) {
  const instruments = loadInstruments()
  if (!instruments.length) throw new Error('no appraisal instruments are bundled')
  let raw = normalizeId(reference)
  let wantedVersion = version == null ? null : String(version).trim()
  const at = raw.lastIndexOf('@')
  if (at > 0) {
    wantedVersion = wantedVersion || raw.slice(at + 1)
    raw = raw.slice(0, at)
  }
  let base = ALIASES[raw] || raw
  if (!wantedVersion) {
    const suffix = instruments
      .map((item) => `${item.id}-${normalizeId(item.version)}`)
      .sort((a, b) => b.length - a.length)
      .find((candidate) => raw === candidate || raw.startsWith(`${candidate}-`))
    if (suffix) {
      const matched = instruments.find((item) => `${item.id}-${normalizeId(item.version)}` === suffix)
      if (matched) {
        base = matched.id
        wantedVersion = matched.version
      }
    }
  }
  const matches = instruments.filter((item) => item.id === base
    && (wantedVersion == null || String(item.version) === String(wantedVersion)))
  if (!matches.length) {
    const available = instruments.map((item) => `${item.id}@${item.version}`).join(', ')
    throw new Error(`instrument "${reference}"${wantedVersion ? ` version ${wantedVersion}` : ''} is not bundled. Available: ${available}`)
  }
  return matches.at(-1)
}

export function fingerprint(template) {
  return createHash('sha256').update(JSON.stringify(template)).digest('hex')
}

export function domainCells(template) {
  const cells = []
  for (const domain of template.domains) {
    const axes = Array.isArray(domain.axes) && domain.axes.length ? domain.axes : ['risk_of_bias']
    for (const axis of axes) cells.push({ key: `${domain.id}:${axis}`, domain, axis })
  }
  return cells
}

export function scaleValues(template, domain = null) {
  if (template.scale.type === 'stars') {
    const max = Number.isInteger(domain?.max_stars) ? domain.max_stars : Math.max(
      ...template.domains.map((entry) => entry.max_stars || 0),
    )
    return Array.from({ length: max + 1 }, (_, value) => ({ id: value, label: String(value), rank: value }))
  }
  return template.scale.values
}

export function normaliseJudgement(template, domain, raw) {
  if (template.scale.type === 'stars') {
    if (raw == null || String(raw).trim() === '') {
      throw new Error(`judgement for ${domain.id} must be an integer from 0 to ${domain.max_stars}`)
    }
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 0 || value > domain.max_stars) {
      throw new Error(`judgement for ${domain.id} must be an integer from 0 to ${domain.max_stars}`)
    }
    return value
  }
  const wanted = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  const match = template.scale.values.find((value) => value.id.toLowerCase() === wanted
    || value.label.toLowerCase() === String(raw ?? '').trim().toLowerCase())
  if (!match) {
    throw new Error(`judgement must be one of ${template.scale.values.map((value) => value.id).join(', ')}`)
  }
  return match.id
}

export function validateSignalling(template, domain, signalling) {
  if (signalling == null) return null
  if (typeof signalling !== 'object' || Array.isArray(signalling)) {
    throw new Error('signalling must be an object keyed by question id')
  }
  const questions = new Map((domain.signalling || []).map((question) => [question.id, question]))
  const out = {}
  for (const [id, answer] of Object.entries(signalling)) {
    const question = questions.get(String(id))
    if (!question) throw new Error(`signalling question "${id}" is not in domain ${domain.id}`)
    if (!question.answers.includes(answer)) {
      throw new Error(`signalling answer "${answer}" is not allowed for ${id}; use ${question.answers.join(', ')}`)
    }
    out[String(id)] = answer
  }
  return out
}

export function deriveOverall(template, valuesByDomain) {
  const rule = template.overall?.rule
  if (!rule) return null
  let worst = null
  for (const domain of template.domains) {
    const value = valuesByDomain?.[domain.id]
    if (value == null) return null
    const rank = rule.order.indexOf(value)
    if (rank < 0) return null
    if (worst == null || rank > worst.rank) worst = { rank, value }
  }
  if (!worst) return null
  return { judgement: worst.value, rule: rule.type, values: { ...valuesByDomain } }
}

function columnLabel(cell, template) {
  const multiAxis = new Set(template.domains.filter((domain) => (domain.axes || []).length > 1).map((domain) => domain.id))
  if (!multiAxis.has(cell.domain.id)) return cell.domain.name
  return `${cell.domain.name} (${cell.axis.replace(/_/g, ' ')})`
}

function cellResolutionFor(record, key) {
  return record.cells.find((cell) => cell.key === key)?.resolution
}

function displayValue(resolution) {
  if (resolution?.value != null) return resolution.value
  if (resolution?.state === 'conflict' || resolution?.state === 'reopened') return 'conflict'
  return 'pending'
}

export function evaluateInstrument({
  template, records = [], events = [], includedIds = [], onlyRecordId = null, expectedReviewers = [],
}) {
  const recordById = new Map(records.map((record) => [record.id, record]))
  const population = includedIds.filter((id) => recordById.has(id) && (!onlyRecordId || id === onlyRecordId))
  const populationSet = new Set(population)
  const instrumentEvents = []
  events.forEach((event, index) => {
    if (!event?.instrument) return
    if (String(event.instrument.id) !== template.id) return
    if (String(event.instrument.version) !== String(template.version)) return
    instrumentEvents.push({ ...event, __index: index })
  })
  const appraisers = new Map()
  for (const event of instrumentEvents) {
    if (event.kind === 'reconcile' || !populationSet.has(event.record_id)) continue
    const key = reviewerKey(event.reviewer)
    if (!appraisers.has(key)) appraisers.set(key, reviewerLabel(event.reviewer))
  }
  const labels = new Map(appraisers)
  for (const reviewer of expectedReviewers) labels.set(reviewerKey(reviewer), reviewerLabel(reviewer))
  const expected = [...new Set([
    ...expectedReviewers.map((reviewer) => reviewerKey(reviewer)),
    ...appraisers.keys(),
  ])]
  const cells = domainCells(template)
  const rows = []
  const conflicts = []

  for (const recordId of population) {
    const recordEvents = instrumentEvents.filter((event) => event.record_id === recordId)
    const resolutions = cells.map((cell) => {
      const series = recordEvents.filter((event) => event.domain === cell.domain.id
        && (event.axis || 'risk_of_bias') === cell.axis)
      const resolution = resolveSeries(series, {
        valueOf: (event) => event.judgement,
        expectedReviewers: expected,
      })
      if (resolution.state === 'conflict' || resolution.state === 'reopened') {
        conflicts.push({
          record_id: recordId,
          cell: cell.key,
          state: resolution.state,
          by_reviewer: resolution.conflict?.by_reviewer ?? [],
          reconcile: resolution.conflict?.reconcile ?? null,
        })
      }
      return { ...cell, resolution }
    })

    let overall = null
    if (template.overall) {
      const explicit = resolveSeries(recordEvents.filter((event) => event.domain === 'overall'), {
        valueOf: (event) => event.judgement,
        expectedReviewers: null,
      })
      const allResolved = resolutions.every((cell) => cell.resolution.value != null)
      if (explicit.value != null) {
        overall = {
          state: explicit.state,
          value: explicit.value,
          derived: false,
          source: 'explicit',
          by_reviewer: explicit.by_reviewer,
          conflict: explicit.conflict,
          reconcile: explicit.reconcile,
        }
      } else if (explicit.state === 'conflict' || explicit.state === 'reopened') {
        overall = {
          state: explicit.state,
          value: null,
          derived: false,
          source: 'explicit',
          by_reviewer: explicit.by_reviewer,
          conflict: explicit.conflict,
          reconcile: explicit.reconcile,
        }
        conflicts.push({
          record_id: recordId,
          cell: 'overall',
          state: explicit.state,
          by_reviewer: explicit.conflict?.by_reviewer ?? [],
          reconcile: explicit.conflict?.reconcile ?? null,
        })
      } else if (allResolved) {
        const values = Object.fromEntries(resolutions.map((cell) => [cell.domain.id, cell.resolution.value]))
        const derived = deriveOverall(template, values)
        overall = derived ? {
          state: 'derived',
          value: derived.judgement,
          derived: true,
          source: 'derived',
          rule: derived.rule,
          values,
          by_reviewer: [],
          conflict: null,
          reconcile: null,
        } : {
          state: 'pending', value: null, derived: false, source: 'none', by_reviewer: [], conflict: null, reconcile: null,
        }
      } else {
        const cellConflict = resolutions.some((cell) => cell.resolution.state === 'conflict'
          || cell.resolution.state === 'reopened')
        overall = {
          state: cellConflict ? 'conflict' : 'pending',
          value: null,
          derived: false,
          source: 'none',
          by_reviewer: [],
          conflict: null,
          reconcile: null,
        }
      }
    }

    const totalStars = template.scale.type === 'stars'
      && resolutions.every((cell) => Number.isInteger(cell.resolution.value))
      ? resolutions.reduce((sum, cell) => sum + cell.resolution.value, 0)
      : null
    const anyConflict = resolutions.some((cell) => cell.resolution.state === 'conflict'
      || cell.resolution.state === 'reopened')
      || (overall && (overall.state === 'conflict' || overall.state === 'reopened'))
    const allComplete = resolutions.every((cell) => cell.resolution.value != null)
    const status = anyConflict ? 'conflict' : allComplete ? 'complete' : 'pending'

    rows.push({
      record_id: recordId,
      record: recordById.get(recordId),
      cells: resolutions,
      overall,
      total_stars: totalStars,
      status,
    })
  }

  return {
    instrument: { id: template.id, version: template.version, name: template.name },
    template,
    population,
    reviewers: expected.map((key) => labels.get(key) || key),
    records: rows,
    complete_records: rows.filter((row) => row.status === 'complete').length,
    conflicts,
  }
}

export function buildRobTable(evaluation, template = evaluation.template) {
  const columns = domainCells(template).map((cell) => ({
    key: cell.key,
    label: columnLabel(cell, template),
    domain: cell.domain.id,
    axis: cell.axis,
  }))
  if (template.overall) {
    columns.push({
      key: 'overall', label: template.overall.name, domain: 'overall', axis: null,
    })
  }
  const rows = evaluation.records.map((row) => {
    const values = {}
    const reviewers = new Set()
    let unverified = 0
    const collect = (resolution) => {
      for (const entry of resolution?.by_reviewer || []) {
        reviewers.add(entry.reviewer)
        if (entry.quote_status && entry.quote_status !== 'verified') unverified += 1
      }
    }
    for (const cell of row.cells) {
      values[cell.key] = displayValue(cell.resolution)
      collect(cell.resolution)
    }
    if (template.overall) values.overall = row.overall ? displayValue(row.overall) : null
    collect(row.overall)
    return {
      record_id: row.record_id,
      title: row.record?.title || '',
      year: row.record?.year ?? null,
      doi: row.record?.doi ?? null,
      values,
      reviewers: [...reviewers],
      unverified_quotes: unverified,
      overall_basis: row.overall ? (row.overall.derived ? 'derived' : row.overall.value != null ? 'explicit' : row.overall.state) : null,
      total_stars: row.total_stars,
      status: row.status,
    }
  })
  return {
    columns, rows, population: evaluation.records.length,
  }
}

function summaryRow({ key, label, domain, axis, scale, records, resolve }) {
  const counts = Object.fromEntries(scale.map((value) => [String(value.id ?? value), 0]))
  let conflict = 0
  let pending = 0
  for (const record of records) {
    const resolution = resolve(record)
    if (resolution?.value == null) {
      if (resolution?.state === 'conflict' || resolution?.state === 'reopened') conflict += 1
      else pending += 1
    } else {
      counts[String(resolution.value)] = (counts[String(resolution.value)] || 0) + 1
    }
  }
  return {
    key, label, domain: domain ?? null, axis: axis ?? null, scale: Object.keys(counts), counts, conflict, pending, total: records.length,
  }
}

export function buildRobSummary(evaluation, template = evaluation.template) {
  const rows = []
  for (const cell of domainCells(template)) {
    rows.push(summaryRow({
      key: cell.key,
      label: columnLabel(cell, template),
      domain: cell.domain.id,
      axis: cell.axis,
      scale: scaleValues(template, cell.domain),
      records: evaluation.records,
      resolve: (record) => cellResolutionFor(record, cell.key),
    }))
  }
  if (template.overall) {
    rows.push(summaryRow({
      key: 'overall',
      label: template.overall.name,
      domain: 'overall',
      axis: null,
      scale: scaleValues(template),
      records: evaluation.records,
      resolve: (record) => record.overall,
    }))
  }
  if (template.scale.type === 'stars') {
    const max = template.domains.reduce((sum, domain) => sum + (domain.max_stars || 0), 0)
    const counts = Object.fromEntries(Array.from({ length: max + 1 }, (_, value) => [String(value), 0]))
    let pending = 0
    for (const record of evaluation.records) {
      if (record.total_stars == null) pending += 1
      else counts[String(record.total_stars)] += 1
    }
    rows.push({
      key: 'total_stars',
      label: 'Total stars',
      domain: null,
      axis: null,
      scale: Object.keys(counts),
      counts,
      conflict: 0,
      pending,
      total: evaluation.records.length,
      note: 'A star total is a count, not a quality verdict.',
    })
  }
  return { rows, population: evaluation.records.length }
}

const STYLE = {
  low: { color: '#2e7d32', symbol: '+' },
  moderate: { color: '#f9a825', symbol: '?' },
  some_concerns: { color: '#f9a825', symbol: '?' },
  unclear: { color: '#9e9e9e', symbol: '?' },
  no_information: { color: '#9e9e9e', symbol: '?' },
  serious: { color: '#ef6c00', symbol: '−' },
  high: { color: '#c62828', symbol: '−' },
  critical: { color: '#6a1b9a', symbol: '!' },
  conflict: { color: '#6a1b9a', symbol: '!' },
  pending: { color: '#bdbdbd', symbol: '·' },
}

function starStyle(value) {
  return { color: '#455a64', symbol: String(value) }
}

function figureScale(template) {
  if (template.scale.type === 'stars') {
    const max = Math.max(...template.domains.map((domain) => domain.max_stars || 0))
    return [
      ...Array.from({ length: max + 1 }, (_, value) => ({
        id: String(value), label: String(value), ...starStyle(value),
      })),
      { id: 'conflict', label: 'Conflict', ...STYLE.conflict },
      { id: 'pending', label: 'Pending', ...STYLE.pending },
    ]
  }
  return [
    ...template.scale.values.map((value) => ({
      id: value.id,
      label: value.label,
      ...(STYLE[value.id] || { color: '#616161', symbol: '?' }),
    })),
    { id: 'conflict', label: 'Conflict', ...STYLE.conflict },
    { id: 'pending', label: 'Pending', ...STYLE.pending },
  ]
}

export function buildFigureRequest(evaluation, template = evaluation.template, { maxStudies = 200, maxDomains = 24 } = {}) {
  const cells = domainCells(template)
  if (cells.length > maxDomains) throw new Error(`rob-figure supports at most ${maxDomains} domain columns`)
  if (evaluation.records.length > maxStudies) throw new Error(`rob-figure supports at most ${maxStudies} studies`)
  const domains = cells.map((cell) => ({
    id: cell.key, label: columnLabel(cell, template), axis: cell.axis,
  }))
  if (template.overall) {
    domains.push({ id: 'overall', label: template.overall.name, axis: null })
  }
  const reviewers = new Set()
  let unverified = 0
  const studies = evaluation.records.map((row) => {
    const values = {}
    for (const cell of row.cells) {
      values[cell.key] = { value: displayValue(cell.resolution) }
      for (const entry of cell.resolution.by_reviewer || []) {
        reviewers.add(entry.reviewer)
        if (entry.quote_status && entry.quote_status !== 'verified') unverified += 1
      }
    }
    if (row.overall) {
      values.overall = {
        value: displayValue(row.overall),
        derived: row.overall.derived === true,
      }
      for (const entry of row.overall.by_reviewer || []) {
        reviewers.add(entry.reviewer)
        if (entry.quote_status && entry.quote_status !== 'verified') unverified += 1
      }
    }
    return { id: row.record_id, label: row.record?.title || row.record_id, cells: values }
  })
  const names = [...reviewers]
  const note = `Unverified quotes: ${unverified}. Reviewers: ${names.join(', ') || '(none)'}.${names.some((name) => name.startsWith('ai:')) ? ' AI judgements are marked ai:.' : ''}`
  return {
    title: `${template.name} ${template.version} — ${evaluation.records.length} included studies`,
    note,
    panels: ['traffic', 'summary'],
    domains,
    scale: figureScale(template),
    studies,
  }
}
