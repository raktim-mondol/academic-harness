/**
 * Randomization and design-of-experiments ledger under `<cwd>/.dsh/design/<slug>/`.
 *
 * Schedules are deterministic given a required seed and are stored append-only.
 * `balance` reports realized balance, not a guarantee; DOE output states its
 * assumed model and aliasing and never analyses a response.
 */
import { join } from 'node:path'
import {
  appendJsonl, csvCell, ensureDir, exportText, mdCell, nowIso, readJsonl,
  slug as slugify,
} from './ledger-kit.js'
import { withLock } from './store-lock.js'
import { resolveWorkspacePath } from './workspace-path.js'

export const DESIGN_ACTIONS = ['randomize', 'balance', 'doe', 'export', 'status', 'list']
export const RANDOMIZATION_METHODS = ['simple', 'block', 'stratified', 'cluster', 'crossover', 'minimization']
export const DOE_METHODS = ['full_factorial', 'fractional_factorial', 'plackett_burman', 'central_composite', 'box_behnken']
export const DESIGN_EXPORT_FORMATS = ['csv', 'json', 'markdown']
const MAX_RUNS = 4096
const MAX_PARTICIPANTS = 100_000
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function text(value) {
  return String(value ?? '').trim()
}

function number(value, name) {
  const result = Number(value)
  if (!Number.isFinite(result)) throw new Error(`${name} must be a number`)
  return result
}

function integer(value, name, { min = 1 } = {}) {
  const result = Number(value)
  if (!Number.isInteger(result) || result < min) throw new Error(`${name} must be an integer >= ${min}`)
  return result
}

export function designSlug(value) {
  const slug = slugify(value, 80)
  if (!slug) throw new Error('slug must contain at least one letter or digit')
  return slug
}

export function designDir(cwd, value) {
  return join(cwd, '.dsh', 'design', designSlug(value))
}

function files(cwd, value) {
  const dir = designDir(cwd, value)
  return { dir, schedules: join(dir, 'schedules.jsonl'), exports: join(dir, 'exports') }
}

function makeRng(seed) {
  const required = Number(seed)
  if (!Number.isInteger(required)) throw new Error('seed must be an integer; a schedule without a seed is not reproducible')
  let state = required >>> 0
  return () => {
    state += 0x6D2B79F5
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle(items, rng) {
  const out = [...items]
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1))
    ;[out[index], out[swap]] = [out[swap], out[index]]
  }
  return out
}

function randomCode(rng, used, length = 4) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    let code = ''
    for (let index = 0; index < length; index += 1) code += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)]
    if (!used.has(code)) {
      used.add(code)
      return code
    }
  }
  throw new Error('could not allocate a unique code')
}

export function normalizeArms(value, allocation = null) {
  const raw = value == null ? ['control', 'treatment'] : (Array.isArray(value) ? value : [value])
  const names = raw.map((entry) => text(typeof entry === 'string' ? entry : entry?.name)).filter(Boolean)
  if (names.length < 2) throw new Error('arms must name at least two arms')
  if (new Set(names).size !== names.length) throw new Error('arm names must be unique')
  let ratios
  if (allocation == null || allocation === '') ratios = names.map(() => 1)
  else if (Array.isArray(allocation)) ratios = allocation.map((entry) => integer(entry, 'allocation'))
  else if (typeof allocation === 'object') ratios = names.map((name) => integer(allocation[name] ?? 1, `allocation.${name}`))
  else throw new Error('allocation must be an array or an object of positive integers')
  if (ratios.length !== names.length) throw new Error('allocation must have one positive integer per arm')
  return { names, allocation: ratios }
}

function armPool(arms) {
  const pool = []
  arms.names.forEach((name, index) => {
    for (let count = 0; count < arms.allocation[index]; count += 1) pool.push(name)
  })
  return pool
}

function participantList(value, n) {
  if (value == null || value === '') {
    const total = integer(n, 'n')
    if (total > MAX_PARTICIPANTS) throw new Error(`n exceeds the ${MAX_PARTICIPANTS}-participant cap; split the schedule or use cluster allocation`)
    return Array.from({ length: total }, (_, index) => ({ participant_id: `p${String(index + 1).padStart(3, '0')}`, covariates: {} }))
  }
  if (!Array.isArray(value) || !value.length) throw new Error('participants must be a non-empty array')
  if (value.length > MAX_PARTICIPANTS) throw new Error(`participants exceed the ${MAX_PARTICIPANTS}-participant cap; split the schedule or use cluster allocation`)
  const out = value.map((entry, index) => {
    if (typeof entry === 'string') return { participant_id: text(entry), covariates: {} }
    if (!entry || typeof entry !== 'object') throw new Error('participants must be strings or objects')
    const id = text(entry.participant_id || entry.id) || `p${String(index + 1).padStart(3, '0')}`
    return {
      participant_id: id,
      covariates: entry.covariates && typeof entry.covariates === 'object' ? entry.covariates : {},
      factors: entry.factors && typeof entry.factors === 'object' ? entry.factors : null,
      stratum: text(entry.stratum) || null,
    }
  })
  if (new Set(out.map((entry) => entry.participant_id)).size !== out.length) throw new Error('participant ids must be unique')
  if (n != null && n !== '' && Number(n) !== out.length) throw new Error('n does not match the number of participants supplied')
  return out
}

function stratumGroups(participants, strata) {
  if (strata != null && strata !== '') {
    const list = Array.isArray(strata) ? strata : [strata]
    const groups = list.map((entry) => {
      if (typeof entry === 'string') throw new Error('strata entries need a name and n, e.g. {name: "site A", n: 40}')
      const name = text(entry.name || entry.stratum)
      const size = integer(entry.n ?? entry.size, 'strata.n')
      if (!name) throw new Error('each stratum needs a name')
      return { name, size, participants: [] }
    })
    let cursor = 0
    for (const group of groups) {
      group.participants = participants.slice(cursor, cursor + group.size)
      if (group.participants.length !== group.size) throw new Error(`stratum "${group.name}" asks for ${group.size} participants but only ${group.participants.length} are available`)
      for (const participant of group.participants) participant.stratum = group.name
      cursor += group.size
    }
    if (cursor !== participants.length) throw new Error('strata sizes do not sum to the participant count')
    return groups
  }
  const byName = new Map()
  for (const participant of participants) {
    const name = participant.stratum || 'all'
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name).push(participant)
  }
  return [...byName.entries()].map(([name, members]) => ({ name, size: members.length, participants: members }))
}

function assignCodes(arms, participants, rng) {
  const used = new Set()
  const blinding = {}
  for (const arm of arms.names) blinding[arm] = randomCode(rng, used, 4)
  const allocation = new Map()
  for (const participant of participants) allocation.set(participant.participant_id, randomCode(rng, used, 4))
  return { blinding, allocation }
}

function armCounts(rows, method, arms) {
  const counts = Object.fromEntries(arms.map((arm) => [arm, 0]))
  if (method === 'cluster') {
    const seen = new Set()
    for (const row of rows) {
      const key = row.cluster_id
      if (seen.has(key)) continue
      seen.add(key)
      counts[row.arm] = (counts[row.arm] || 0) + 1
    }
  } else if (method === 'crossover') {
    const seen = new Set()
    for (const row of rows) {
      const key = `${row.participant_id}\u0000${row.arm}`
      if (seen.has(key)) continue
      seen.add(key)
      counts[row.arm] = (counts[row.arm] || 0) + 1
    }
  } else {
    for (const row of rows) counts[row.arm] = (counts[row.arm] || 0) + 1
  }
  return counts
}

function scheduleSummary(record) {
  return {
    schedule_id: record.schedule_id,
    kind: record.kind,
    method: record.method,
    seed: record.seed,
    created_at: record.created_at,
    units: record.kind === 'doe' ? record.matrix.length : record.rows.length,
    arms: record.arms || record.factors?.map((factor) => factor.name) || [],
    counts: record.counts || null,
  }
}

function nextScheduleId(records) {
  const last = records.at(-1)?.schedule_id
  const numberValue = last ? Number(last.replace(/\D/g, '')) : 0
  return `s${String((Number.isFinite(numberValue) ? numberValue : records.length) + 1).padStart(4, '0')}`
}

export async function saveSchedule({ cwd, slug, record }) {
  const f = files(cwd, slug)
  ensureDir(f.dir)
  return withLock(f.dir, async () => {
    const existing = readJsonl(f.schedules)
    const schedule = { ...record, schedule_id: nextScheduleId(existing), created_at: nowIso() }
    appendJsonl(f.schedules, [schedule])
    return schedule
  }, { label: 'design ledger' })
}

function blockAssignments(participants, arms, blockSize, rng) {
  const pool = armPool(arms)
  const unit = pool.length
  const size = blockSize == null ? unit * 2 : integer(blockSize, 'block_size')
  if (size < unit || size % unit !== 0) throw new Error(`block_size must be a multiple of the allocation total (${unit})`)
  const rows = []
  let block = 0
  for (let index = 0; index < participants.length; index += size) {
    block += 1
    const remaining = participants.length - index
    const actual = Math.min(size, remaining)
    if (actual % unit !== 0) throw new Error(`the final block has ${actual} participants, which is not a multiple of the allocation total (${unit})`)
    const sequence = shuffle(Array.from({ length: actual }, (_value, offset) => pool[offset % pool.length]), rng)
    const blockRows = []
    for (let offset = 0; offset < actual; offset += 1) {
      blockRows.push({ participant: participants[index + offset], arm: sequence[offset] })
    }
    for (const row of blockRows) rows.push({ participant: row.participant, arm: row.arm, block })
  }
  return rows
}

export async function randomizeSchedule({ cwd, slug, method = 'simple', seed, arms: armInput = null, allocation = null, n = null, participants: participantInput = null, blockSize = null, strata = null, clusters = null, sequences = null, nPerSequence = null, washout = null, recordedBy = null }) {
  const methodName = text(method).toLowerCase() || 'simple'
  if (!RANDOMIZATION_METHODS.includes(methodName)) throw new Error(`method must be one of ${RANDOMIZATION_METHODS.join(', ')}`)
  const arms = normalizeArms(armInput, allocation)
  const rng = makeRng(seed)
  const participants = methodName === 'cluster' ? [] : participantList(participantInput, n)
  const codes = assignCodes(arms, participants, rng)
  let rows = []
  let design = { method: methodName }

  if (methodName === 'simple') {
    const pool = armPool(arms)
    if (participants.length % pool.length !== 0) throw new Error(`n (${participants.length}) must be a multiple of the allocation total (${pool.length})`)
    const sequence = shuffle(Array.from({ length: participants.length }, (_value, index) => pool[index % pool.length]), rng)
    rows = participants.map((participant, index) => ({ participant_id: participant.participant_id, arm: sequence[index], stratum: participant.stratum || 'all' }))
    design = { method: methodName, allocation_total: pool.length }
  } else if (methodName === 'block' || methodName === 'stratified') {
    const groups = methodName === 'block' && !strata ? [{ name: 'all', participants }] : stratumGroups(participants, strata)
    const blockSizeValue = blockSize ?? armPool(arms).length * 2
    let blockOffset = 0
    for (const group of groups) {
      const assigned = blockAssignments(group.participants, arms, blockSizeValue, rng)
      for (const row of assigned) {
        rows.push({
          participant_id: row.participant.participant_id,
          stratum: group.name,
          arm: row.arm,
          block: row.block + blockOffset,
        })
      }
      blockOffset = Math.max(blockOffset, ...assigned.map((row) => row.block + blockOffset))
    }
    design = { method: methodName, block_size: blockSizeValue, allocation_total: armPool(arms).length, strata: groups.map((group) => ({ name: group.name, n: group.participants.length })) }
  } else if (methodName === 'cluster') {
    if (!Array.isArray(clusters) || !clusters.length) throw new Error('cluster randomization needs a non-empty clusters array')
    const cleanClusters = clusters.map((entry, index) => {
      if (!entry || typeof entry !== 'object') throw new Error('clusters entries must be objects')
      const id = text(entry.cluster_id || entry.id) || `c${index + 1}`
      return { cluster_id: id, size: integer(entry.size ?? entry.n, `clusters[${index}].size`), stratum: text(entry.stratum) || 'all' }
    })
    if (new Set(cleanClusters.map((entry) => entry.cluster_id)).size !== cleanClusters.length) throw new Error('cluster ids must be unique')
    const groups = new Map()
    for (const cluster of cleanClusters) {
      if (!groups.has(cluster.stratum)) groups.set(cluster.stratum, [])
      groups.get(cluster.stratum).push(cluster)
    }
    const clusterCodes = new Map()
    const usedClusterCodes = new Set([...Object.values(codes.blinding), ...codes.allocation.values()])
    for (const cluster of cleanClusters) clusterCodes.set(cluster.cluster_id, randomCode(rng, usedClusterCodes, 4))
    const pool = armPool(arms)
    if (pool.length === 0) throw new Error('allocation produced no clusters')
    let block = 0
    for (const [stratum, group] of groups) {
      if (group.length % pool.length !== 0) throw new Error(`cluster stratum "${stratum}" has ${group.length} clusters, not a multiple of the allocation total (${pool.length})`)
      const sequence = shuffle(Array.from({ length: group.length }, (_value, index) => pool[index % pool.length]), rng)
      group.forEach((cluster, index) => {
        rows.push({
          cluster_id: cluster.cluster_id,
          size: cluster.size,
          stratum,
          arm: sequence[index],
          allocation_code: clusterCodes.get(cluster.cluster_id),
          blinding_code: codes.blinding[sequence[index]],
          block: block + Math.floor(index / pool.length) + 1,
        })
      })
      block += group.length / pool.length
    }
    design = { method: methodName, clusters: cleanClusters.length, allocation_total: pool.length, strata: [...groups.keys()] }
  } else if (methodName === 'crossover') {
    const parsedSequences = normalizeSequences(sequences, arms)
    const periods = parsedSequences[0].length
    if (parsedSequences.some((sequence) => sequence.length !== periods)) throw new Error('all crossover sequences must have the same number of periods')
    let perSequence
    if (nPerSequence != null) {
      perSequence = parsedSequences.map((_sequence, index) => integer(Array.isArray(nPerSequence) ? nPerSequence[index] : nPerSequence, 'n_per_sequence'))
      const total = perSequence.reduce((sum, value) => sum + value, 0)
      if (total !== participants.length) throw new Error(`n_per_sequence sums to ${total} but ${participants.length} participants were supplied; every participant must be scheduled`)
    } else {
      if (participants.length < parsedSequences.length) throw new Error('n must be at least the number of sequences')
      perSequence = parsedSequences.map(() => Math.floor(participants.length / parsedSequences.length))
      for (let index = 0; index < participants.length - perSequence.reduce((sum, value) => sum + value, 0); index += 1) perSequence[index % perSequence.length] += 1
    }
    let cursor = 0
    for (let sequenceIndex = 0; sequenceIndex < parsedSequences.length; sequenceIndex += 1) {
      for (let repeat = 0; repeat < perSequence[sequenceIndex]; repeat += 1) {
        const participant = participants[cursor]
        cursor += 1
        parsedSequences[sequenceIndex].forEach((arm, period) => {
          rows.push({
            participant_id: participant.participant_id,
            sequence: parsedSequences[sequenceIndex].join('-'),
            period: period + 1,
            arm,
            washout: text(washout) || null,
            allocation_code: codes.allocation.get(participant.participant_id),
            blinding_code: codes.blinding[arm],
          })
        })
      }
    }
    design = { method: methodName, sequences: parsedSequences.map((sequence) => sequence.join('-')), periods, washout: text(washout) || null }
  } else {
    if (!Array.isArray(participantInput) || !participantInput.length) throw new Error('minimization needs participants with factors')
    const withFactors = participants.filter((participant) => participant.factors && Object.keys(participant.factors).length)
    if (withFactors.length !== participants.length) throw new Error('every participant needs a factors object for minimization')
    const factorNames = [...new Set(participants.flatMap((participant) => Object.keys(participant.factors)))].sort()
    const counts = new Map(arms.names.map((arm) => [arm, { total: 0, levels: new Map() }]))
    const levelTotals = new Map()
    const totalAllocation = arms.allocation.reduce((sum, value) => sum + value, 0)
    const proportions = Object.fromEntries(arms.names.map((arm, index) => [arm, arms.allocation[index] / totalAllocation]))
    for (let index = 0; index < participants.length; index += 1) {
      const participant = participants[index]
      for (const factor of factorNames) {
        const level = String(participant.factors[factor])
        if (!levelTotals.has(`${factor}\u0000${level}`)) levelTotals.set(`${factor}\u0000${level}`, 0)
      }
      const scores = []
      for (const arm of arms.names) {
        let score = 0
        const state = counts.get(arm)
        for (const factor of factorNames) {
          const level = String(participant.factors[factor])
          const key = `${factor}\u0000${level}`
          const current = state.levels.get(key) || 0
          const overall = (levelTotals.get(key) || 0) + 1
          score += Math.abs(current + 1 - overall * proportions[arm])
          score += Math.abs(current - (levelTotals.get(key) || 0) * proportions[arm])
        }
        score += Math.abs(state.total + 1 - (index + 1) * proportions[arm])
        scores.push({ arm, score })
      }
      const best = Math.min(...scores.map((entry) => entry.score))
      const tied = scores.filter((entry) => Math.abs(entry.score - best) < 1e-9).map((entry) => entry.arm)
      const chosen = tied[Math.floor(rng() * tied.length)]
      const state = counts.get(chosen)
      state.total += 1
      for (const factor of factorNames) {
        const key = `${factor}\u0000${String(participant.factors[factor])}`
        state.levels.set(key, (state.levels.get(key) || 0) + 1)
        levelTotals.set(key, (levelTotals.get(key) || 0) + 1)
      }
      rows.push({
        participant_id: participant.participant_id,
        arm: chosen,
        factors: { ...participant.factors },
        allocation_code: codes.allocation.get(participant.participant_id),
        blinding_code: codes.blinding[chosen],
        minimization_score: best,
      })
    }
    design = { method: methodName, factors: factorNames, allocation_total: totalAllocation }
  }

  const participantById = new Map(participants.map((participant) => [participant.participant_id, participant]))
  for (const row of rows) {
    const participant = row.participant_id ? participantById.get(row.participant_id) : null
    if (participant?.covariates && Object.keys(participant.covariates).length) row.covariates = participant.covariates
    if (participant?.factors && !row.factors) row.factors = participant.factors
    if (row.allocation_code == null && row.participant_id) row.allocation_code = codes.allocation.get(row.participant_id)
    if (row.blinding_code == null) row.blinding_code = codes.blinding[row.arm]
  }
  const counts = armCounts(rows, methodName, arms.names)
  const record = {
    kind: 'randomization', method: methodName, seed: Number(seed), arms: arms.names,
    allocation: arms.allocation, design, rows, counts, blinding: codes.blinding,
    recorded_by: text(recordedBy) || null,
    note_text: 'Deterministic given the stored seed. Codes are records, not allocation concealment; no clinical workflow is implied.',
  }
  const stored = await saveSchedule({ cwd, slug, record })
  return { schedule: stored, summary: scheduleSummary(stored) }
}

function normalizeSequences(value, arms) {
  const raw = value == null || value === '' ? (arms.names.length === 2 ? ['AB', 'BA'] : null) : value
  if (!raw) throw new Error('crossover needs sequences (for two arms the default is AB/BA only when arm names are single letters)')
  const list = Array.isArray(raw) ? raw : [raw]
  return list.map((entry) => {
    let sequence
    if (Array.isArray(entry)) sequence = entry.map(text)
    else if (typeof entry === 'string' && entry.includes(',')) sequence = entry.split(',').map(text)
    else if (typeof entry === 'string' && arms.names.every((arm) => arm.length === 1)) sequence = entry.split('')
    else if (typeof entry === 'string' && arms.names.every((arm) => entry.includes(arm))) {
      sequence = []
      let cursor = 0
      while (cursor < entry.length) {
        const arm = arms.names.find((name) => entry.startsWith(name, cursor))
        if (!arm) throw new Error(`sequence "${entry}" cannot be parsed; use arrays of arm names`)
        sequence.push(arm)
        cursor += arm.length
      }
    } else throw new Error(`sequence "${entry}" is not an array of arm names`)
    if (sequence.some((arm) => !arms.names.includes(arm))) throw new Error('a crossover sequence uses an arm that is not declared')
    return sequence
  })
}

function numericValues(rows, key) {
  return rows.map((row) => row[key]).filter((value) => value != null && value !== '' && Number.isFinite(Number(value))).map(Number)
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function stdev(values) {
  if (values.length < 2) return null
  const average = mean(values)
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1))
}

function unitRows(record) {
  if (record.method === 'cluster') {
    const seen = new Set()
    return record.rows.filter((row) => {
      if (seen.has(row.cluster_id)) return false
      seen.add(row.cluster_id)
      return true
    })
  }
  if (record.method === 'crossover') {
    const seen = new Set()
    return record.rows.filter((row) => {
      if (seen.has(row.participant_id)) return false
      seen.add(row.participant_id)
      return true
    })
  }
  return record.rows
}

function covariateMap(rows) {
  const out = new Map()
  for (const row of rows) {
    const source = row.covariates || row.factors || {}
    for (const [key, value] of Object.entries(source)) {
      if (!out.has(key)) out.set(key, [])
      out.get(key).push({ arm: row.arm, value })
    }
  }
  return out
}

export function balanceReport(record) {
  if (record.kind === 'doe') throw new Error('balance applies to randomized schedules, not DOE designs')
  const rows = unitRows(record)
  const arms = record.arms
  const counts = armCounts(record.rows, record.method, arms)
  const units = record.method === 'crossover'
    ? new Set(record.rows.map((row) => row.participant_id)).size
    : record.method === 'cluster'
      ? new Set(record.rows.map((row) => row.cluster_id)).size
      : record.rows.length
  const covariates = covariateMap(rows)
  const numeric = []
  const categorical = []
  for (const [name, entries] of covariates) {
    const values = entries.map((entry) => entry.value)
    const isNumeric = values.length > 0 && values.every((value) => value != null && value !== '' && Number.isFinite(Number(value)))
    if (isNumeric) numeric.push({ name, entries: entries.map((entry) => ({ arm: entry.arm, value: Number(entry.value) })) })
    else categorical.push({ name, entries })
  }
  const numericTable = numeric.map(({ name, entries }) => {
    const overall = numericValues(entries, 'value')
    const armStats = arms.map((arm) => {
      const values = entries.filter((entry) => entry.arm === arm).map((entry) => entry.value)
      return { arm, n: values.length, mean: values.length ? mean(values) : null, sd: values.length ? stdev(values) : null }
    })
    const first = armStats[0]
    const smd = armStats.map((entry) => {
      if (entry.mean == null || first.mean == null || entry.arm === first.arm) return { arm: entry.arm, smd_vs_first: 0 }
      const pooled = Math.sqrt(((first.sd ?? 0) ** 2 + (entry.sd ?? 0) ** 2) / 2)
      return { arm: entry.arm, smd_vs_first: pooled === 0 ? null : (entry.mean - first.mean) / pooled }
    })
    return { covariate: name, overall: { n: overall.length, mean: overall.length ? mean(overall) : null, sd: overall.length ? stdev(overall) : null }, arms: armStats, smd }
  })
  const categoricalTable = categorical.map(({ name, entries }) => {
    const levels = [...new Set(entries.map((entry) => String(entry.value ?? '')))].sort()
    const byArm = arms.map((arm) => {
      const armEntries = entries.filter((entry) => entry.arm === arm)
      return {
        arm,
        n: armEntries.length,
        levels: Object.fromEntries(levels.map((level) => [level, armEntries.filter((entry) => String(entry.value ?? '') === level).length])),
      }
    })
    return { covariate: name, levels, arms: byArm }
  })
  const flags = []
  for (const entry of numericTable) {
    for (const value of entry.smd) {
      if (value.smd_vs_first != null && Math.abs(value.smd_vs_first) > 0.1) flags.push({ kind: 'standardized_mean_difference', covariate: entry.covariate, arm: value.arm, value: value.smd_vs_first })
    }
  }
  const expected = arms.reduce((sum, arm, index) => sum + record.allocation[index], 0)
  const assignmentTotal = record.method === 'crossover'
    ? Object.values(counts).reduce((sum, value) => sum + value, 0)
    : units
  for (const arm of arms) {
    const expectedShare = record.method === 'crossover' ? 1 / arms.length : record.allocation[arms.indexOf(arm)] / expected
    const actualShare = assignmentTotal ? counts[arm] / assignmentTotal : 0
    if (Math.abs(actualShare - expectedShare) > 0.1) flags.push({ kind: 'arm_count', arm, expected: expectedShare, actual: actualShare })
  }
  for (const entry of categoricalTable) {
    for (const level of entry.levels) {
      const shares = entry.arms.map((arm) => arm.n ? arm.levels[level] / arm.n : 0)
      if (Math.max(...shares) - Math.min(...shares) > 0.1) flags.push({ kind: 'categorical_share', covariate: entry.covariate, level, shares: Object.fromEntries(entry.arms.map((arm) => [arm.arm, arm.n ? arm.levels[level] / arm.n : 0])) })
    }
  }
  return {
    schedule_id: record.schedule_id, method: record.method, units,
    arms: counts, allocation: Object.fromEntries(arms.map((arm, index) => [arm, record.allocation[index]])),
    numeric: numericTable, categorical: categoricalTable, flags,
    note: 'Realized balance only. It does not guarantee balance in unmeasured variables, and a covariate not supplied here was not assessed.',
  }
}

export function readSchedule(cwd, slug, scheduleId = null) {
  const records = readJsonl(files(cwd, slug).schedules)
  if (!records.length) throw new Error(`design "${designSlug(slug)}" has no schedules`)
  if (scheduleId == null || scheduleId === '') return records.at(-1)
  const record = records.find((entry) => entry.schedule_id === scheduleId)
  if (!record) throw new Error(`schedule "${scheduleId}" not found`)
  return record
}

export function designStatus(cwd, slug) {
  const records = readJsonl(files(cwd, slug).schedules)
  return {
    slug: designSlug(slug), dir: files(cwd, slug).dir,
    schedules: records.map(scheduleSummary),
    latest: records.length ? scheduleSummary(records.at(-1)) : null,
  }
}

export function listDesignSchedules(cwd, slug) {
  return readJsonl(files(cwd, slug).schedules).map(scheduleSummary)
}

function safeCell(value) {
  if (typeof value === 'number') return value
  const raw = String(value ?? '')
  return /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
}

function rowColumns(record) {
  if (record.kind === 'doe') return ['run_order', 'standard_order', ...record.factors.map((factor) => factor.name)]
  const keys = new Set()
  for (const row of record.rows.slice(0, 200)) {
    for (const [key, value] of Object.entries(row)) {
      if (value != null && typeof value !== 'object') keys.add(key)
    }
  }
  for (const key of ['participant_id', 'cluster_id', 'stratum', 'block', 'sequence', 'period', 'arm', 'allocation_code', 'blinding_code', 'size', 'washout']) {
    if (keys.has(key)) continue
    if (record.rows.some((row) => row[key] != null)) keys.add(key)
  }
  for (const row of record.rows.slice(0, 200)) {
    for (const key of Object.keys(row.factors || {})) keys.add(key)
    for (const key of Object.keys(row.covariates || {})) keys.add(key)
  }
  const ordered = [...keys].sort((a, b) => {
    const order = ['participant_id', 'cluster_id', 'stratum', 'block', 'sequence', 'period', 'arm', 'allocation_code', 'blinding_code', 'size', 'washout']
    const ai = order.indexOf(a)
    const bi = order.indexOf(b)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.localeCompare(b)
  })
  return ordered
}

function markdownTable(record) {
  const columns = rowColumns(record)
  const rows = record.kind === 'doe' ? record.matrix : record.rows
  const lines = [`| ${columns.map(mdCell).join(' | ')} |`, `|${columns.map(() => '---').join('|')}|`]
  for (const row of rows.slice(0, 200)) {
    lines.push(`| ${columns.map((column) => mdCell(row[column] ?? row.factors?.[column] ?? row.covariates?.[column] ?? '')).join(' | ')} |`)
  }
  if (rows.length > 200) lines.push(`\n_${rows.length - 200} more row(s) are in the CSV/JSON export._`)
  return lines.join('\n')
}

export function exportDesign({ cwd, slug, scheduleId = null, format = 'csv', out = null, overwrite = false }) {
  const record = readSchedule(cwd, slug, scheduleId)
  const kind = text(format).toLowerCase() || 'csv'
  if (!DESIGN_EXPORT_FORMATS.includes(kind)) throw new Error(`format must be one of ${DESIGN_EXPORT_FORMATS.join(', ')}`)
  const dir = files(cwd, slug).exports
  ensureDir(dir)
  const extension = { csv: 'csv', json: 'json', markdown: 'md' }[kind]
  const target = out ? resolveWorkspacePath(cwd, out, { forWrite: true }) : join(dir, `${record.schedule_id}.${extension}`)
  if (kind === 'json') {
    const result = exportText(target, `${JSON.stringify(record, null, 2)}\n`, { overwrite })
    return { ...result, format: kind, schedule_id: record.schedule_id }
  }
  if (kind === 'markdown') {
    const body = [
      `# Design schedule ${record.schedule_id}`,
      '',
      `Method: ${record.method} · seed: ${record.seed} · created: ${record.created_at}`,
      record.kind === 'doe' ? `Runs: ${record.matrix.length}` : `Rows: ${record.rows.length}`,
      '',
      markdownTable(record),
      '',
      '> A seeded schedule is reproducible. Randomization does not replace allocation concealment, and the reported balance is realized balance only.',
      '',
    ].join('\n')
    const result = exportText(target, body, { overwrite })
    return { ...result, format: kind, schedule_id: record.schedule_id }
  }
  const columns = rowColumns(record)
  const rows = record.kind === 'doe' ? record.matrix : record.rows
  const body = `${[columns, ...rows.map((row) => columns.map((column) => row[column] ?? row.factors?.[column] ?? row.covariates?.[column] ?? ''))]
    .map((row) => row.map(safeCell).map(csvCell).join(','))
    .join('\n')}\n`
  const result = exportText(target, body, { overwrite })
  return { ...result, format: kind, schedule_id: record.schedule_id }
}

/* ------------------------------------------------------------------ DOE */

function normalizeFactors(value) {
  if (!Array.isArray(value) || !value.length) throw new Error('doe needs a non-empty factors array')
  const factors = value.map((entry, index) => {
    if (typeof entry === 'string') {
      const name = text(entry)
      if (!name) throw new Error('factor names must not be empty')
      return { name, levels: [-1, 1], low: -1, high: 1, type: 'two_level' }
    }
    if (!entry || typeof entry !== 'object') throw new Error('factors must be strings or objects')
    const name = text(entry.name)
    if (!name) throw new Error(`factors[${index}] needs a name`)
    let levels = Array.isArray(entry.levels) ? entry.levels : null
    if (!levels && entry.low != null && entry.high != null) levels = [entry.low, entry.high]
    if (!levels) levels = [-1, 1]
    if (levels.length < 2) throw new Error(`factor "${name}" needs at least two levels`)
    return {
      name,
      levels,
      low: entry.low ?? levels[0],
      high: entry.high ?? levels[levels.length - 1],
      center: entry.center ?? (levels.every((level) => Number.isFinite(Number(level))) ? (Number(levels[0]) + Number(levels[levels.length - 1])) / 2 : 0),
      type: levels.length === 2 ? 'two_level' : 'multi_level',
    }
  })
  if (new Set(factors.map((factor) => factor.name)).size !== factors.length) throw new Error('factor names must be unique')
  return factors
}

function cartesian(sets) {
  let out = [[]]
  for (const set of sets) {
    const next = []
    for (const prefix of out) for (const value of set) next.push([...prefix, value])
    out = next
  }
  return out
}

function twoLevelValue(factor, code) {
  return code >= 0 ? factor.high : factor.low
}

function runOrderRows(rows, seed) {
  const rng = makeRng(seed)
  const order = shuffle(rows.map((_row, index) => index), rng)
  const position = new Map(order.map((index, positionValue) => [index, positionValue + 1]))
  return rows.map((row, index) => ({ standard_order: index + 1, run_order: position.get(index), ...row }))
}

function fractionalDesign(factors, generators, seed) {
  if (factors.some((factor) => factor.type !== 'two_level')) throw new Error('fractional factorial needs two-level factors')
  if (!Array.isArray(generators) || !generators.length) throw new Error('fractional_factorial needs generators such as "D=ABC"')
  if (factors.length > 20) throw new Error('fractional factorial is limited to 20 factors')
  const names = factors.map((factor) => factor.name)
  const base = names.filter((name) => !generators.some((generator) => generator.split('=')[0].trim() === name))
  if (!base.length) throw new Error('fractional factorial needs at least one base factor')
  if (2 ** base.length > MAX_RUNS) throw new Error(`fractional factorial base would produce ${2 ** base.length} runs; the cap is ${MAX_RUNS}`)
  const bits = new Map()
  let nextBit = 0
  for (const name of names) {
    bits.set(name, 1 << nextBit)
    nextBit += 1
  }
  const known = new Set(base)
  const generated = []
  const words = []
  for (const generator of generators) {
    const [left, right] = String(generator).split('=').map((part) => part.trim())
    if (!left || !right) throw new Error(`generator "${generator}" must look like "D=ABC"`)
    if (!names.includes(left)) throw new Error(`generator defines unknown factor "${left}"`)
    if (base.includes(left)) throw new Error(`generator cannot redefine base factor "${left}"`)
    if (generated.some((entry) => entry.name === left)) throw new Error(`generator defines "${left}" more than once`)
    let terms = right.split(/\s*\*\s*|\s+/).filter(Boolean)
    if (terms.length === 1 && terms[0].length > 1 && !known.has(terms[0])) terms = terms[0].split('')
    const wordMask = terms.reduce((acc, term) => {
      if (!known.has(term)) throw new Error(`generator references "${term}" before it is defined; list base factors first or order the generators`)
      return acc ^ bits.get(term)
    }, bits.get(left))
    words.push(wordMask)
    generated.push({ name: left, terms })
    known.add(left)
  }
  const baseRuns = cartesian(base.map(() => [-1, 1]))
  const rows = baseRuns.map((values) => {
    const row = {}
    const code = {}
    base.forEach((name, index) => {
      code[name] = values[index]
      row[name] = twoLevelValue(factors.find((factor) => factor.name === name), values[index])
    })
    for (const entry of generated) {
      const value = entry.terms.reduce((product, term) => product * code[term], 1)
      code[entry.name] = value >= 0 ? 1 : -1
      row[entry.name] = twoLevelValue(factors.find((factor) => factor.name === entry.name), code[entry.name])
    }
    return row
  })
  // Closure of the defining relation under XOR.
  const relation = new Set(words.filter((word) => word !== 0))
  let changed = true
  while (changed) {
    changed = false
    const current = [...relation]
    for (let i = 0; i < current.length; i += 1) {
      for (let j = i + 1; j < current.length; j += 1) {
        const word = current[i] ^ current[j]
        if (word !== 0 && !relation.has(word)) { relation.add(word); changed = true }
      }
    }
  }
  function popcount(value) {
    let count = 0
    for (let bitsValue = value; bitsValue; bitsValue >>= 1) count += bitsValue & 1
    return count
  }
  const resolution = relation.size ? Math.min(...[...relation].map(popcount)) : null
  const effectLabel = (mask) => {
    if (mask === 0) return 'I'
    return [...bits.entries()].filter(([, code]) => (mask & code) === code).map(([name]) => name).join('*')
  }
  const aliasGroups = []
  for (const factor of factors) {
    const code = bits.get(factor.name)
    const group = [factor.name]
    for (const word of relation) {
      const label = effectLabel(code ^ word)
      if (!group.includes(label)) group.push(label)
    }
    aliasGroups.push({ effect: factor.name, aliases: group.slice(1) })
  }
  const relationNames = [...relation].map(effectLabel)
  return {
    rows: runOrderRows(rows, seed),
    aliasing: {
      resolution, defining_relation: relationNames,
      alias_groups: aliasGroups,
      note: 'Alias groups use the generator set and the assumption that higher-order interactions are negligible; they are not a substitute for checking the design.',
    },
    design: { base_factors: base, generators },
  }
}

function plackettBurmanRows(N) {
  if (N === 8 || N === 16) {
    let matrix = [[1]]
    while (matrix.length < N) {
      matrix = [
        ...matrix.map((row) => [...row, ...row]),
        ...matrix.map((row) => [...row, ...row.map((value) => -value)]),
      ]
    }
    return matrix.map((row) => row.slice(1))
  }
  if (N === 12) {
    const base = [1, 1, -1, 1, 1, 1, -1, -1, -1, 1, -1]
    const rows = []
    for (let shift = 0; shift < 11; shift += 1) {
      rows.push(Array.from({ length: 11 }, (_value, index) => base[(index + shift) % 11]))
    }
    rows.push(Array(11).fill(-1))
    return rows
  }
  throw new Error('plackett_burman supports runs 8, 12, or 16')
}

function plackettBurman(factors, requestedRuns, seed) {
  if (factors.some((factor) => factor.type !== 'two_level')) throw new Error('Plackett–Burman needs two-level factors')
  const allowed = [8, 12, 16]
  const runs = requestedRuns == null ? allowed.find((value) => value - 1 >= factors.length) : Number(requestedRuns)
  if (!allowed.includes(runs)) throw new Error(`plackett_burman runs must be one of ${allowed.join(', ')}`)
  if (factors.length > runs - 1) throw new Error(`a ${runs}-run Plackett–Burman design supports at most ${runs - 1} factors`)
  const matrix = plackettBurmanRows(runs)
  const rows = matrix.map((row) => {
    const out = {}
    factors.forEach((factor, index) => { out[factor.name] = twoLevelValue(factor, row[index]) })
    return out
  })
  return {
    rows: runOrderRows(rows, seed),
    aliasing: {
      resolution: 'III',
      defining_relation: [],
      alias_groups: [],
      note: 'Plackett–Burman main effects are aliased with two-factor interactions; the design screens for large effects, it does not resolve interactions.',
    },
    design: { runs, factor_count: factors.length },
  }
}

function centralComposite(factors, alphaOption, centerPoints, seed) {
  if (factors.length < 2 || factors.length > 5) throw new Error('central_composite supports 2–5 factors')
  if (factors.some((factor) => factor.type !== 'two_level')) throw new Error('central_composite factors must have low/high levels')
  let alpha
  if (alphaOption == null || alphaOption === 'rotatable') alpha = (2 ** factors.length) ** 0.25
  else if (alphaOption === 'orthogonal') alpha = Math.sqrt(factors.length)
  else if (alphaOption === 'face') alpha = 1
  else alpha = number(alphaOption, 'alpha')
  if (!(alpha > 0)) throw new Error('alpha must be positive')
  const centers = integer(centerPoints ?? 4, 'center_points')
  const rows = []
  for (const values of cartesian(factors.map(() => [-1, 1]))) {
    const out = {}
    factors.forEach((factor, index) => { out[factor.name] = values[index] })
    rows.push(out)
  }
  for (let index = 0; index < factors.length; index += 1) {
    for (const sign of [-1, 1]) {
      const out = {}
      factors.forEach((factor, factorIndex) => { out[factor.name] = factorIndex === index ? sign * alpha : 0 })
      rows.push(out)
    }
  }
  for (let index = 0; index < centers; index += 1) rows.push(Object.fromEntries(factors.map((factor) => [factor.name, 0])))
  return {
    rows: runOrderRows(rows, seed),
    aliasing: { resolution: 'response-surface', defining_relation: [], alias_groups: [], note: 'The central composite design assumes a quadratic model; the matrix is coded (-alpha…+alpha), not the original units.' },
    design: { alpha, center_points: centers, model: 'quadratic' },
  }
}

function boxBehnken(factors, centerPoints, seed) {
  if (factors.length < 3 || factors.length > 4) throw new Error('box_behnken supports 3 or 4 factors')
  if (factors.some((factor) => factor.type !== 'two_level')) throw new Error('box_behnken factors must have low/high levels')
  const centers = integer(centerPoints ?? 3, 'center_points')
  const rows = []
  for (let first = 0; first < factors.length; first += 1) {
    for (let second = first + 1; second < factors.length; second += 1) {
      for (const [a, b] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
        const out = Object.fromEntries(factors.map((factor) => [factor.name, 0]))
        out[factors[first].name] = a
        out[factors[second].name] = b
        rows.push(out)
      }
    }
  }
  for (let index = 0; index < centers; index += 1) rows.push(Object.fromEntries(factors.map((factor) => [factor.name, 0])))
  return {
    rows: runOrderRows(rows, seed),
    aliasing: { resolution: 'response-surface', defining_relation: [], alias_groups: [], note: 'Box–Behnken assumes a quadratic model; the matrix is coded and every run is at an edge or the center.' },
    design: { center_points: centers, model: 'quadratic' },
  }
}

export async function doeSchedule({ cwd, slug, method = 'full_factorial', seed, factors: factorInput, generators = null, runs = null, alpha = null, centerPoints = null, recordedBy = null }) {
  const methodName = text(method).toLowerCase() || 'full_factorial'
  if (!DOE_METHODS.includes(methodName)) throw new Error(`doe method must be one of ${DOE_METHODS.join(', ')}`)
  if (seed == null) throw new Error('doe needs a seed so the run order is reproducible')
  makeRng(seed)
  const factors = normalizeFactors(factorInput)
  let result
  if (methodName === 'full_factorial') {
    const runsCount = factors.reduce((product, factor) => product * factor.levels.length, 1)
    if (runsCount > MAX_RUNS) throw new Error(`full factorial would produce ${runsCount} runs; the cap is ${MAX_RUNS}`)
    const rows = cartesian(factors.map((factor) => factor.levels)).map((values) => Object.fromEntries(factors.map((factor, index) => [factor.name, values[index]])))
    result = {
      rows: runOrderRows(rows, seed),
      aliasing: { resolution: 'full', defining_relation: [], alias_groups: [], note: 'A full factorial design has no aliasing among the included factors.' },
      design: { runs: rows.length },
    }
  } else if (methodName === 'fractional_factorial') result = fractionalDesign(factors, generators, seed)
  else if (methodName === 'plackett_burman') result = plackettBurman(factors, runs, seed)
  else if (methodName === 'central_composite') result = centralComposite(factors, alpha, centerPoints, seed)
  else result = boxBehnken(factors, centerPoints, seed)
  const record = {
    kind: 'doe', method: methodName, seed: Number(seed), factors,
    matrix: result.rows, aliasing: result.aliasing, design: result.design,
    recorded_by: text(recordedBy) || null,
    note_text: 'Design matrix only; no response is analysed here. The assumed model and aliasing are reported with the design.',
  }
  const stored = await saveSchedule({ cwd, slug, record })
  return { schedule: stored, summary: scheduleSummary(stored) }
}
