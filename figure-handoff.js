/**
 * figure_audit action=handoff: a read-only figure-to-result report.
 *
 * It joins one explicitly supplied figure file (and an optional caption) to the
 * generating records the caller declares, using only the existing analysis and
 * experiment ledgers. It answers four narrow questions and nothing more:
 *
 *   - does each declared link resolve to a recorded run;
 *   - do the figure's current bytes match the hash that run recorded;
 *   - what execution status does the run itself record;
 *   - which numbers can be read from a hashed, machine-readable source file,
 *     and do the caption's numbers agree with them.
 *
 * A recorded relation is not proof that the figure depicts the data, and a hash
 * is byte identity, not correctness. Nothing is read from pixels. Missing,
 * stale, unsupported, or unparsed inputs are reported as such and never as a
 * pass. No ledger or workspace file is written.
 */
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { extname, posix } from 'node:path'
import { hashFile, nowIso } from './ledger-kit.js'
import { fenceUntrusted } from './untrusted-fence.js'
import { resolveWorkspacePath } from './workspace-path.js'
import { listAnalysisRuns, excludedAnalysisRunIds } from './analysis-store.js'
import { experimentBranches } from './experiment-store.js'

export const HANDOFF_SOURCE_KINDS = ['analysis_run', 'experiment_run']
export const HANDOFF_VALUE_FORMATS = ['json', 'csv', 'tsv']
export const FIGURE_FORMATS = ['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.gif', '.webp', '.svg', '.pdf', '.eps']

const MAX_SOURCES = 20
const MAX_VALUES = 50
const MAX_CAPTION = 20000
const MAX_VISION_CHARS = 4000
const MAX_HASH_BYTES = 200 * 1024 * 1024
const MAX_PARSE_BYTES = 5 * 1024 * 1024

const text = (value) => (typeof value === 'string' ? value.trim() : '')
const normalizePath = (value) => posix.normalize(String(value).replace(/\\/g, '/')).replace(/^\.\//, '')

/** Resolve a workspace path without throwing; the reason is returned instead. */
function locate(cwd, rel) {
  let abs
  try {
    abs = resolveWorkspacePath(cwd, rel)
  } catch (error) {
    return { state: 'unsafe_path', reason: error instanceof Error ? error.message : String(error) }
  }
  if (!existsSync(abs)) return { state: 'missing', abs, reason: 'file is not in the workspace' }
  const stat = statSync(abs)
  if (!stat.isFile()) return { state: 'not_a_file', abs, reason: 'path is not a regular file' }
  return { state: 'present', abs, bytes: stat.size }
}

/** Current hash of a workspace file, or the reason it cannot be hashed. Memoised per call. */
function currentHash(cwd, rel, cache) {
  const key = normalizePath(rel)
  if (cache?.has(key)) return cache.get(key)
  const found = locate(cwd, rel)
  let out
  if (found.state !== 'present') out = { state: found.state, reason: found.reason, sha256: null }
  else if (found.bytes > MAX_HASH_BYTES) out = { state: 'too_large', reason: `larger than ${MAX_HASH_BYTES / (1024 * 1024)}MB`, sha256: null, abs: found.abs }
  else out = { state: 'present', sha256: `sha256:${hashFile(found.abs)}`, bytes: found.bytes, abs: found.abs }
  cache?.set(key, out)
  return out
}

/** Compare one recorded entry's hash with the file's bytes right now. */
function compareRecorded(cwd, rel, entry, cache) {
  if (!entry) return { state: 'not_recorded', recorded_sha256: null, current_sha256: null, reason: 'the run does not list this path' }
  if (!entry.sha256) {
    return { state: 'not_hashed', recorded_sha256: null, current_sha256: null, reason: entry.status || entry.error || 'the run recorded no hash for this path' }
  }
  const now = currentHash(cwd, rel, cache)
  if (!now.sha256) return { state: now.state === 'missing' ? 'missing' : 'not_checked', recorded_sha256: entry.sha256, current_sha256: null, reason: now.reason }
  return {
    state: now.sha256 === entry.sha256 ? 'current' : 'stale',
    recorded_sha256: entry.sha256,
    current_sha256: now.sha256,
    reason: now.sha256 === entry.sha256 ? null : 'bytes changed after the run recorded them',
  }
}

function findEntry(list, rel) {
  const target = normalizePath(rel)
  return (list || []).find((entry) => entry && typeof entry.path === 'string' && normalizePath(entry.path) === target) || null
}

function analysisExecution(run) {
  if (run.timed_out) return { status: 'timed_out', exit_code: run.exit_code ?? null }
  if (run.spawn_error) return { status: 'spawn_error', exit_code: null }
  if (Number.isInteger(run.exit_code)) return { status: run.exit_code === 0 ? 'succeeded' : 'failed', exit_code: run.exit_code }
  return { status: 'unknown', exit_code: null }
}

function declared(source) {
  return {
    kind: source.kind,
    slug: source.slug ?? null,
    run_id: source.run_id ?? null,
    path: source.path ?? null,
  }
}

function resolveAnalysisSource(cwd, source, figureRel, cache) {
  let run
  try {
    run = listAnalysisRuns(cwd, source.slug).find((entry) => entry.run_id === source.run_id)
  } catch (error) {
    return { link_state: 'not_checked', reason: error instanceof Error ? error.message : String(error) }
  }
  if (!run) return { link_state: 'unresolved', reason: `no analysis run "${source.run_id}" in analysis "${source.slug}"` }
  const entry = findEntry(run.outputs, figureRel)
  const pathEntry = source.path ? (findEntry(run.outputs, source.path) || findEntry(run.inputs, source.path)) : null
  let excluded = null
  try {
    excluded = excludedAnalysisRunIds(cwd, source.slug).has(run.run_id)
  } catch {
    excluded = null
  }
  return {
    link_state: 'resolved',
    execution: { ...analysisExecution(run), recorded_at: run.ts ?? null, note: 'exit code only; says nothing about whether the output is correct' },
    excluded_by_compliance: excluded,
    figure_record: { listed_as: entry ? 'output' : null, ...compareRecorded(cwd, figureRel, entry, cache), written_by_run: entry ? entry.written_by_run ?? null : null },
    path_record: source.path ? { path: source.path, ...compareRecorded(cwd, source.path, pathEntry, cache), written_by_run: pathEntry ? pathEntry.written_by_run ?? null : null } : null,
  }
}

function resolveExperimentSource(cwd, source, figureRel, cache, hashes) {
  let report = cache.get(source.slug)
  if (report === undefined) {
    try {
      report = experimentBranches(cwd, source.slug, { maxNodes: 5000, maxEdges: 10000, maxLinksPerRun: 500 })
    } catch (error) {
      report = { error: error instanceof Error ? error.message : String(error) }
    }
    cache.set(source.slug, report)
  }
  if (report.error) return { link_state: 'not_checked', reason: report.error }
  const node = (report.nodes || []).find((entry) => entry.run_id === source.run_id)
  if (!node && report.truncated) return { link_state: 'not_checked', reason: `the branch view was truncated at ${report.limits?.max_nodes ?? 5000} runs, so "${source.run_id}" could not be looked up` }
  if (!node) return { link_state: 'unresolved', reason: `no experiment run "${source.run_id}" in experiment "${source.slug}"` }
  const entry = findEntry(node.artifacts, figureRel)
  const pathEntry = source.path ? findEntry(node.artifacts, source.path) : null
  return {
    link_state: 'resolved',
    execution: { status: node.execution.state, analysis_run_ids: node.execution.analysis_run_ids, unresolved_run_ids: node.execution.unresolved_run_ids, note: 'experiment_log records results and does not execute them; status comes only from linked analysis runs' },
    excluded_by_compliance: node.compliance?.state === 'unknown' ? null : node.excluded === true,
    ...(node.compliance?.state === 'unknown' ? { compliance_reason: node.compliance.reason } : {}),
    figure_record: { listed_as: entry ? 'artifact' : null, ...compareRecorded(cwd, figureRel, entry, hashes) },
    path_record: source.path ? { path: source.path, ...compareRecorded(cwd, source.path, pathEntry, hashes) } : null,
  }
}

/* ------------------------------------------------------------ value reading */

function dotted(root, locator) {
  const steps = []
  for (const part of locator.split('.')) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part)
    if (!match) return { error: `unsupported locator segment "${part}"` }
    if (match[1]) steps.push(match[1])
    for (const index of match[2].matchAll(/\[(\d+)\]/g)) steps.push(Number(index[1]))
  }
  let current = root
  for (const step of steps) {
    if (current == null || typeof current !== 'object' || !Object.hasOwn(current, step)) return { error: `locator "${locator}" does not resolve` }
    current = current[step]
  }
  return { value: current }
}

function parseDelimited(body, delimiter) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]
    if (quoted) {
      if (char === '"' && body[i + 1] === '"') { cell += '"'; i += 1 } else if (char === '"') quoted = false
      else cell += char
    } else if (char === '"') quoted = true
    else if (char === delimiter) { row.push(cell); cell = '' } else if (char === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = '' } else cell += char
  }
  if (cell !== '' || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row) }
  return rows.filter((entry) => entry.some((value) => value !== ''))
}

function readValue(cwd, request, trusted) {
  const base = { path: request.path, format: request.format, locator: request.field ?? { column: request.column, row: request.row } }
  const norm = normalizePath(request.path)
  const gate = trusted.get(norm)
  if (!gate) return { ...base, state: 'not_checked', reason: 'path is not a declared source path, so its bytes are not tied to any run' }
  if (gate.state !== 'current') return { ...base, state: 'not_checked', reason: `source bytes are ${gate.state}: ${gate.reason || 'hash does not confirm the current file'}` }
  if (!HANDOFF_VALUE_FORMATS.includes(request.format)) return { ...base, state: 'not_checked', reason: `format must be one of ${HANDOFF_VALUE_FORMATS.join(', ')}; it is never inferred` }
  const found = locate(cwd, request.path)
  if (found.state !== 'present') return { ...base, state: 'not_checked', reason: found.reason }
  if (found.bytes > MAX_PARSE_BYTES) return { ...base, state: 'not_checked', reason: `larger than ${MAX_PARSE_BYTES / (1024 * 1024)}MB` }
  const body = readFileSync(found.abs, 'utf8')
  let raw
  if (request.format === 'json') {
    if (!text(request.field)) return { ...base, state: 'not_checked', reason: 'json needs a field locator such as "results.accuracy" or "rows[2].f1"' }
    let parsed
    try { parsed = JSON.parse(body) } catch (error) { return { ...base, state: 'not_checked', reason: `not valid JSON: ${error.message}` } }
    const hit = dotted(parsed, request.field)
    if (hit.error) return { ...base, state: 'not_checked', reason: hit.error }
    raw = hit.value
  } else {
    const rows = parseDelimited(body.replace(/^\uFEFF/, ''), request.format === 'tsv' ? '\t' : ',')
    const column = text(request.column)
    if (!column || !Number.isInteger(request.row) || request.row < 0) return { ...base, state: 'not_checked', reason: 'delimited files need a header name in column and a zero-based integer row' }
    const header = rows[0] || []
    const at = header.indexOf(column)
    if (at < 0) return { ...base, state: 'not_checked', reason: `no column "${column}" in the header` }
    const data = rows[request.row + 1]
    if (!data) return { ...base, state: 'not_checked', reason: `no data row ${request.row}` }
    raw = data[at]
  }
  // Number() would turn [], '  ', '0x1F', and ['0.9'] into numbers; accept only a real
  // number or a string that is a plain decimal literal.
  const isNumber = typeof raw === 'number' && Number.isFinite(raw)
  const isLiteral = typeof raw === 'string' && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw.trim())
  if (!isNumber && !isLiteral) return { ...base, state: 'not_checked', reason: `the located value ${typeof raw === 'string' ? `"${raw.slice(0, 40)}"` : `of type ${Array.isArray(raw) ? 'array' : raw === null ? 'null' : typeof raw}`} is not a plain number` }
  const value = isNumber ? raw : Number(raw.trim())
  if (!Number.isFinite(value)) return { ...base, state: 'not_checked', reason: 'the located value is not a finite number' }
  return { ...base, state: 'extracted', value, source_sha256: gate.sha256 }
}

/* ----------------------------------------------------------------- captions */

// "Figure 2", "Figs. 2a, 3 and 4", "Supplementary Figure S4", "panel B2" are labels, not data.
const FIG_ONE = String.raw`S?\d+[a-z]?`
const FIGURE_REF = new RegExp(String.raw`\b(?:supplementary\s+)?(?:fig(?:ure)?s?\.?|panels?)\s*${FIG_ONE}(?:\s*(?:,|and|&|to|[-–])\s*${FIG_ONE})*`, 'giu')

/**
 * Plain numeric tokens only. Skipped on purpose, not mis-parsed: ranges (3-5),
 * scientific notation (1e-3), names with a number (ResNet-50), and figure labels.
 * Thousands separators are joined (12,345 is one number).
 */
export function captionNumbers(caption) {
  const cleaned = caption
    .replace(FIGURE_REF, ' ')
    .replace(/(?<=\d),(?=\d{3}(?!\d))/g, '')
    .replace(/\d+(?:\.\d+)?[eE][-+]?\d+/g, ' ')
    .replace(/\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?/g, ' ')
  const out = []
  for (const match of cleaned.matchAll(/(?<![\w.])([-+−]?)(\d+(?:\.\d+)?)(%?)(?![\w]|\.\d)/gu)) {
    const before = cleaned[match.index - 1]
    // "-" glued to a word or digit is a hyphen (ResNet-50), not a minus sign.
    if (match[1] && before !== undefined && /[\w]/u.test(before)) continue
    const glued = cleaned[match.index - 1]
    if (!match[1] && (glued === '-' || glued === '\u2212' || glued === '\u2013') && /\w/u.test(cleaned[match.index - 2] ?? '')) continue
    const decimals = (match[2].split('.')[1] || '').length
    const sign = match[1] === '-' || match[1] === '−' ? -1 : 1
    out.push({ token: match[0], value: sign * Number(match[2]), decimals, percent: match[3] === '%' })
  }
  return out
}

function matches(parsed, extracted) {
  const rounded = (a, b, d) => Math.abs(a - b) < 0.5 * 10 ** -d + 1e-12
  // A percentage is a rounded statement ("81%" for 81.23%), so it matches at its own precision.
  if (parsed.percent) return rounded(parsed.value, extracted * 100, parsed.decimals) || (parsed.decimals > 0 && rounded(parsed.value, extracted, parsed.decimals))
  // A plain integer is a count: it must equal the value. Only stated decimals license rounding.
  return parsed.decimals === 0 ? Math.abs(parsed.value - extracted) < 1e-9 : rounded(parsed.value, extracted, parsed.decimals)
}

/* --------------------------------------------------------------------- main */

/**
 * A vision reading is a model's interpretation of the image. It is recorded so the
 * researcher can see it, labelled as such, and it never verifies the data, never
 * changes a state, and never closes a gap.
 */
function visionReview(raw) {
  if (raw == null) return { state: 'not_requested' }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('vision_review must be an object {summary, reviewer?}')
  const summary = text(raw.summary).slice(0, MAX_VISION_CHARS)
  if (!summary) return { state: 'not_requested', reason: 'vision_review had no summary' }
  const reviewer = text(raw.reviewer)
  return {
    state: 'model_interpretation',
    verified: false,
    reviewer: /^[\w .:@/+-]{1,60}$/.test(reviewer) ? reviewer : null,
    summary,
    note: 'A model\'s reading of the picture. It does not verify the underlying data, a hash, or any state above, and it does not replace expert review.',
  }
}

export function figureHandoff({ cwd, figure, caption = null, reference = null, sources = [], values = [], vision_review: vision = null } = {}) {
  const figureRel = text(figure)
  if (!figureRel) throw new Error('figure is required (a workspace-relative path)')
  if (!Array.isArray(sources)) throw new Error('sources must be an array')
  if (!Array.isArray(values)) throw new Error('values must be an array')
  if (sources.length > MAX_SOURCES) throw new Error(`at most ${MAX_SOURCES} sources`)
  if (values.length > MAX_VALUES) throw new Error(`at most ${MAX_VALUES} values`)
  if (caption != null && typeof caption !== 'string') throw new Error('caption must be a string')
  if (caption && caption.length > MAX_CAPTION) throw new Error(`caption is longer than ${MAX_CAPTION} characters`)

  const gaps = []

  // The figure itself.
  const hashes = new Map()
  const now = currentHash(cwd, figureRel, hashes)
  const ext = extname(figureRel).toLowerCase()
  const figureOut = {
    path: figureRel,
    state: now.state,
    sha256: now.sha256,
    bytes: now.bytes ?? null,
    format: ext || null,
    format_state: FIGURE_FORMATS.includes(ext) ? 'supported' : 'unsupported',
    ...(now.reason ? { reason: now.reason } : {}),
  }
  if (now.state !== 'present') gaps.push(`figure ${now.state}: ${now.reason}`)
  if (figureOut.format_state === 'unsupported') gaps.push(`figure format "${ext || '(none)'}" is not a recognised figure format; bytes were hashed but nothing about the file was interpreted`)
  try {
    if (lstatSync(resolveWorkspacePath(cwd, figureRel)).isSymbolicLink()) figureOut.symlink = true
  } catch { /* the path state above already explains it */ }

  if (!sources.length) gaps.push('no generating run was declared, so the figure is unlinked')

  // Declared generating records, every one preserved.
  const cache = new Map()
  const outSources = sources.map((raw, index) => {
    const source = { kind: text(raw?.kind), slug: text(raw?.slug), run_id: text(raw?.run_id), path: text(raw?.path) || null }
    const base = { index, declared: declared(source) }
    if (!HANDOFF_SOURCE_KINDS.includes(source.kind)) {
      gaps.push(`source ${index}: kind must be one of ${HANDOFF_SOURCE_KINDS.join(', ')}`)
      return { ...base, link_state: 'not_checked', reason: `kind must be one of ${HANDOFF_SOURCE_KINDS.join(', ')}` }
    }
    if (!source.slug || !source.run_id) {
      gaps.push(`source ${index}: slug and run_id are both required`)
      return { ...base, link_state: 'not_checked', reason: 'slug and run_id are both required' }
    }
    const resolved = source.kind === 'analysis_run' ? resolveAnalysisSource(cwd, source, figureRel, hashes) : resolveExperimentSource(cwd, source, figureRel, cache, hashes)
    if (resolved.link_state !== 'resolved') gaps.push(`source ${index}: link ${resolved.link_state} (${resolved.reason})`)
    else {
      if (resolved.figure_record.state !== 'current') gaps.push(`source ${index}: figure is ${resolved.figure_record.state} in this run's record${resolved.figure_record.reason ? ` (${resolved.figure_record.reason})` : ''}`)
      else if (source.kind === 'analysis_run' && resolved.figure_record.written_by_run !== true) {
        gaps.push(`source ${index}: the run's record lists the figure with matching bytes, but ${resolved.figure_record.written_by_run === false ? 'those bytes existed before the run started' : 'the manifest does not record write ownership'}, so the run cannot be credited with producing it`)
      }
      if (resolved.execution.status !== 'succeeded') gaps.push(`source ${index}: recorded execution status is ${resolved.execution.status}`)
      if (resolved.excluded_by_compliance) gaps.push(`source ${index}: the run is excluded by a recorded compliance violation`)
      else if (resolved.excluded_by_compliance === null) gaps.push(`source ${index}: compliance exclusion is unknown${resolved.compliance_reason ? ` (${resolved.compliance_reason})` : ''}`)
      if (resolved.path_record && resolved.path_record.state !== 'current') gaps.push(`source ${index}: source path ${resolved.path_record.path} is ${resolved.path_record.state}`)
    }
    return { ...base, ...resolved }
  })

  // Only bytes that a run hashed, and that still match, may be read for values.
  // A path is readable only when EVERY source that names it confirms the bytes; one
  // stale or unhashed record is enough to withhold it, whatever the order.
  const trusted = new Map()
  for (const entry of outSources) {
    if (!entry.path_record) continue
    const key = normalizePath(entry.path_record.path)
    const next = entry.path_record.state === 'current'
      ? { state: 'current', sha256: entry.path_record.current_sha256 }
      : { state: entry.path_record.state, reason: entry.path_record.reason }
    const prior = trusted.get(key)
    if (!prior || (prior.state === 'current' && next.state !== 'current')) trusted.set(key, next)
  }
  const outValues = values.map((raw, index) => ({ index, ...readValue(cwd, {
    path: text(raw?.path), format: text(raw?.format), field: raw?.field, column: raw?.column, row: raw?.row,
  }, trusted) }))
  for (const entry of outValues) if (entry.state !== 'extracted') gaps.push(`value ${entry.index}: not_checked (${entry.reason})`)

  // Advisory caption agreement.
  let captionCheck = { state: 'not_provided' }
  if (caption && caption.trim()) {
    const parsed = captionNumbers(caption)
    const extracted = outValues.filter((entry) => entry.state === 'extracted')
    const rows = parsed.map((entry) => {
      const hits = extracted.filter((value) => matches(entry, value.value)).map((value) => value.index)
      return { token: entry.token, value: entry.value, decimals: entry.decimals, percent: entry.percent, state: hits.length === 1 ? 'matched' : hits.length > 1 ? 'ambiguous' : 'unmatched', value_indexes: hits }
    })
    captionCheck = {
      state: extracted.length ? 'advisory' : 'not_checked',
      parsed: rows,
      parsed_count: rows.length,
      matched: rows.filter((row) => row.state === 'matched').length,
      unmatched: rows.filter((row) => row.state === 'unmatched').length,
      ambiguous: rows.filter((row) => row.state === 'ambiguous').length,
      reason: extracted.length ? null : 'no value was extracted from a hashed source, so no caption number can be compared',
      parsed_scope: 'plain numeric tokens only; figure and panel references, ranges such as 3-5, scientific notation, and names containing a number are skipped; words and units are not interpreted; integers must match exactly',
    }
    if (!extracted.length) gaps.push('caption numbers not compared: no extracted source value')
  }

  return {
    action: 'handoff',
    read_only: true,
    generated_at: nowIso(),
    reference: text(reference) || null,
    figure: figureOut,
    sources: outSources,
    values: outValues,
    caption: captionCheck,
    vision_review: visionReview(vision),
    gaps: [...new Set(gaps)],
    limitations: [
      'A recorded relation between a run and a figure is not proof that the figure depicts that data.',
      'A matching hash proves byte identity, not correctness; a succeeded status is an exit code of 0.',
      'Nothing is read from pixels; caption agreement is advisory and limited to the numbers listed under caption.parsed_scope.',
      'Declared links are asserted by the caller until the ledger record confirms them.',
    ],
  }
}

export function renderFigureHandoff(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const lines = [
    `Figure handoff: ${value.figure.path}${value.reference ? ` (${value.reference})` : ''}`,
    `Figure: ${value.figure.state}${value.figure.sha256 ? ` · ${value.figure.sha256.slice(0, 23)}…` : ''} · format ${value.figure.format_state}`,
    `Declared sources: ${value.sources.length}`,
  ]
  for (const source of value.sources) {
    const d = source.declared
    lines.push(`- [${source.index}] ${d.kind} ${d.slug}/${d.run_id}: link ${source.link_state}${source.reason ? ` (${source.reason})` : ''}`)
    if (source.link_state === 'resolved') {
      lines.push(`    execution ${source.execution.status} · figure in record: ${source.figure_record.state} · compliance exclusion: ${source.excluded_by_compliance === null ? 'unknown' : source.excluded_by_compliance}`)
      if (source.path_record) lines.push(`    source ${source.path_record.path}: ${source.path_record.state}`)
    }
  }
  for (const entry of value.values) lines.push(`- value [${entry.index}] ${entry.path}: ${entry.state === 'extracted' ? entry.value : `not_checked (${entry.reason})`}`)
  if (value.caption.state !== 'not_provided') {
    lines.push(`Caption (advisory): ${value.caption.state}${value.caption.reason ? ` — ${value.caption.reason}` : ` · ${value.caption.matched} matched, ${value.caption.unmatched} unmatched, ${value.caption.ambiguous} ambiguous of ${value.caption.parsed_count} number(s)`}`)
  }
  if (value.vision_review?.state === 'model_interpretation') {
    lines.push(`Vision review (model interpretation, not verification${value.vision_review.reviewer ? `, by ${value.vision_review.reviewer}` : ''}):`, fenceUntrusted(value.vision_review.summary, { source: 'vision-review', kind: 'model-interpretation' }))
  }
  if (value.gaps.length) lines.push('', 'Gaps:', ...value.gaps.map((gap) => `- ${gap}`))
  lines.push('', ...value.limitations.map((note) => `Note: ${note}`))
  return [{ type: 'text', text: lines.join('\n') }]
}
