/**
 * External-check bridge: run numbers_audit, figure_audit and the citation audit on an Academic Harness
 * project and write what they found as `.ah/external/<tool>.json`, the files the engine reads as tier TX.
 *
 * The three tools need SciPy, Pillow or the network, so they stay here. What the engine needs from them is a
 * fingerprintable finding (check ID, file, a key with no line number in it) and proof of what they were run
 * on: the sha256 of every input file, taken BEFORE the run, so an edit made during the run shows up as
 * stale instead of passing as fresh. The engine (ah/external.py) owns what to run on (`ah external plan`),
 * staleness, and the ledger; this file owns how each tool's answer maps onto the catalogue.
 *
 * An unknown tool code or row kind throws. A new kind of finding that is silently dropped here would be a
 * check that never reports, which is the failure this whole layer exists to remove.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runCitation } from './citation.js'
import { runFigureAudit } from './figure-audit.js'
import { runNumbersAudit } from './numbers-audit.js'
import { runReportingCheck } from './reporting-check.js'

export const EXTERNAL_TOOLS = ['numbers_audit', 'figure_audit', 'citation', 'reporting_check']
export const EXTERNAL_SCHEMA = 1

const collapse = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

/* ------------------------------------------------------------ numbers_audit */

const KIND_CHECK = {
  p_value: 'STAT-01',
  grim: 'STAT-02',
  n: 'STAT-03',
  n_inconsistent: 'STAT-03',
  n_subgroup: 'STAT-03',
  flow_count: 'STAT-03',
  percentage: 'STAT-03',
  ci: 'STAT-04',
  effect_ci: 'STAT-04',
  table_text: 'STAT-05',
}

/**
 * The prose files joined into one manuscript, so checks that compare across sections (a total N that must agree
 * between Methods and Results, a subgroup larger than the total) see the whole paper. Comments are stripped the
 * way the helper strips them, keeping every newline; `locate` maps a line of the joined text back to a file and
 * the line in it.
 */
export function mergeManuscript(parts) {
  const spans = []
  const chunks = []
  let line = 1
  for (const part of parts) {
    const stripped = String(part.text).replace(/(?<!\\)%.*$/gm, '')
    const body = stripped.endsWith('\n') ? stripped : `${stripped}\n`
    const lines = body.split('\n').length - 1
    spans.push({ file: part.file, start: line, lines })
    chunks.push(`${body}\n`)
    line += lines + 1
  }
  return {
    text: chunks.join(''),
    locate(n) {
      if (!Number.isInteger(n) || !spans.length) return { file: spans[0]?.file ?? null, line: null }
      const span = [...spans].reverse().find((candidate) => candidate.start <= n) || spans[0]
      return { file: span.file, line: Math.max(1, Math.min(n - span.start + 1, span.lines)) }
    },
  }
}

/** Rows of a numbers_audit run. `locate` is a file name, or a function from a line to {file, line}. The key is the problem's own text, never its line. */
export function numbersFindings(rows, locate) {
  const where = typeof locate === 'function' ? locate : (line) => ({ file: locate, line: Number.isInteger(line) ? line : null })
  return (rows || []).map((row) => {
    const check = KIND_CHECK[row.kind]
    if (!check) throw new Error(`numbers_audit reported an unmapped kind "${row.kind}"; add it to KIND_CHECK in external-bridge.js`)
    const facts = [
      row.statistic,
      row.reported_p != null ? `reported p ${row.reported_p}` : null,
      row.recomputed_p != null ? `recomputed p ${row.recomputed_p}` : null,
    ].filter(Boolean)
    const at = where(row.line)
    return {
      check,
      file: at.file,
      line: at.line,
      key: collapse(`${row.kind}|${row.detail}|${row.statistic ?? ''}|${row.reported_p ?? ''}`),
      message: collapse(`${row.kind}: ${row.detail}${facts.length ? ` (${facts.join('; ')})` : ''}`),
    }
  })
}

/* ------------------------------------------------------------- figure_audit */

const FLAG_CHECK = { low_dpi: 'FIG-01', dpi_missing: 'FIG-03', unreadable: 'FIG-04', too_large: 'FIG-04' }

/** `fileOf` maps the path figure_audit printed to the name findings use. */
export function figureFindings(result, fileOf, minDpi) {
  const out = []
  for (const entry of result.files || []) {
    const file = fileOf(entry.path)
    for (const flag of entry.flags || []) {
      const check = FLAG_CHECK[flag]
      if (!check) throw new Error(`figure_audit reported an unmapped flag "${flag}"; add it to FLAG_CHECK in external-bridge.js`)
      const dpi = Array.isArray(entry.dpi) ? entry.dpi.join('×') : null
      const message = {
        low_dpi: `${file} is ${dpi} DPI, below ${minDpi}`,
        dpi_missing: `${file} has no DPI metadata`,
        unreadable: `${file} could not be read${entry.error ? `: ${collapse(entry.error)}` : ''}`,
        too_large: `${file} is too large to inspect`,
      }[flag]
      out.push({ check, file, line: null, key: flag, message })
    }
  }
  for (const pair of result.duplicates || []) {
    const [first, second] = [fileOf(pair.a), fileOf(pair.b)].sort()
    out.push({
      check: 'FIG-02', file: first, line: null, key: `dup|${second}`,
      message: `${first} and ${second} are near-duplicates (dHash similarity ${Number(pair.similarity).toFixed(2)})`,
    })
  }
  return out
}

/* ----------------------------------------------------------------- citation */

const CODE_CHECK = {
  retracted: 'CIT-01',
  invalid_doi: 'CIT-02',
  doi_not_registered: 'CIT-02',
  expression_of_concern: 'CIT-03',
  corrected: 'CIT-03',
  title_mismatch: 'CIT-04',
  year_mismatch: 'CIT-04',
  venue_mismatch: 'CIT-04',
  first_author_mismatch: 'CIT-04',
  duplicate: 'CIT-05',
  missing_field: 'CIT-05',
  style_issue: 'CIT-05',
  no_doi: 'CIT-06',
  crossref_unavailable: 'CIT-06',
  integrity_unknown: 'CIT-06',
  not_checked: 'CIT-06',
  title_uncomparable: 'CIT-06',
  venue_uncomparable: 'CIT-06',
  first_author_uncomparable: 'CIT-06',
}
// Owned by the engine (BIB-05), so reporting it here would count it twice.
const CODE_SKIPPED = new Set(['uncited'])
// These codes can occur more than once per reference with different details; the detail tells them apart.
const DETAIL_IN_KEY = new Set(['missing_field', 'duplicate', 'style_issue'])

export function citationFindings(audit, file) {
  const out = []
  for (const reference of audit.references || []) {
    for (const f of reference.findings || []) {
      if (CODE_SKIPPED.has(f.code)) continue
      const check = CODE_CHECK[f.code]
      if (!check) throw new Error(`the citation audit reported an unmapped code "${f.code}"; add it to CODE_CHECK in external-bridge.js`)
      out.push({
        check,
        file,
        line: null,
        key: collapse(`${reference.key}|${f.code}${DETAIL_IN_KEY.has(f.code) ? `|${f.detail}` : ''}`),
        message: collapse(`${reference.key}: ${f.detail}${reference.doi ? ` (${reference.doi})` : ''}`),
      })
    }
  }
  return out
}

/* ---------------------------------------------------------- reporting_check */

/**
 * The recorded verdicts of one reporting-guideline check (the tool's `status` action). They are judgments an
 * agent recorded and the tool verified, so this reads them and never judges again. An absence claim that merely
 * predates a manuscript edit is a prompt to re-judge (RPT-03, info); only a quote that no longer verifies is
 * RPT-02, because that is a fact about the text and not a candidate.
 */
export function reportingFindings(status, file) {
  const slug = status.slug
  const guideline = status.guideline?.name || status.guideline?.id || 'guideline'
  const out = []
  for (const item of status.items || []) {
    const label = `${guideline} item ${item.item_id}${item.short_prompt ? ` (${collapse(item.short_prompt)})` : ''}`
    const add = (check, kind, message) => out.push({ check, file, line: null, key: `${slug}|${item.item_id}|${kind}`, message: collapse(message) })
    if (item.verdict === 'not_reported' || item.verdict === 'partial') {
      const searched = item.searched?.length ? `; searched ${item.searched.join(', ')}` : ''
      add('RPT-01', item.verdict, `${label} is recorded as ${item.verdict.replace('_', ' ')}${searched}`)
    }
    if (item.evidence_mismatch) add('RPT-02', 'quote-gone', `${label}: the quote recorded as evidence is no longer in the manuscript`)
    if (item.verdict === 'unassessed') add('RPT-03', 'unassessed', `${label} has not been assessed yet`)
    else if (item.stale && !item.evidence_mismatch) add('RPT-03', 'recheck', `${label}: the manuscript changed since this was judged; judge it again`)
  }
  return out
}

/* ------------------------------------------------------------------ runner */

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** The tools resolve paths against the session's cwd; the project root is what the plan is relative to. */
function atRoot(exec, root) {
  return { ...exec, agent: { ...(exec?.agent || {}), session: { ...(exec?.agent?.session || {}), header: { ...(exec?.agent?.session?.header || {}), cwd: root } } } }
}

function dedupeSorted(findings) {
  const seen = new Map()
  for (const f of findings) seen.set(`${f.check}|${f.file ?? ''}|${f.key}`, f)
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, f]) => f)
}

async function collect(tool, files, root, exec, args, deps, plan) {
  const shim = atRoot(exec, root)
  if (tool === 'numbers_audit') {
    // One run on the whole manuscript, so totals that must agree across sections are compared across files.
    const merged = mergeManuscript(files.map((entry) => ({ file: entry.file, text: readFileSync(join(root, entry.path), 'utf8') })))
    const result = await (deps.runNumbersAudit || runNumbersAudit)({ text: merged.text, grim: args.grim === true }, shim, deps)
    if (result?.error) throw new Error(result.error)
    // A run that skipped its p-value recomputation found nothing because it looked at nothing. Recording
    // that as a fresh, empty result would read as "no problems", so it is a failure instead.
    const degraded = (result.notes || []).find((note) => /scipy is not installed/i.test(note))
    if (degraded) throw new Error(`${degraded} Install SciPy in the Python helper environment, then run again.`)
    return { findings: numbersFindings(result.rows, merged.locate) }
  }
  if (tool === 'figure_audit') {
    const minDpi = Number(args.min_dpi) || 300
    const result = await (deps.runFigureAudit || runFigureAudit)({ paths: files.map((e) => e.path), min_dpi: minDpi }, shim, deps)
    if (result?.error) throw new Error(result.error)
    const byPath = new Map(files.map((e) => [e.path, e.file]))
    return { findings: figureFindings(result, (path) => byPath.get(path) || path, minDpi) }
  }
  if (tool === 'citation') {
    const findings = []
    let lookup = null
    for (const entry of files) {
      const audit = await (deps.runCitation || runCitation)({
        action: 'audit', path: entry.path, max_audit: 500,
        refresh_lookups: args.refresh_lookups === true,
        ...(args.lookup_max_age_days != null ? { lookup_max_age_days: args.lookup_max_age_days } : {}),
      }, shim, deps)
      if (audit?.error) throw new Error(`${entry.path}: ${audit.error}`)
      findings.push(...citationFindings(audit, entry.file))
      lookup = audit.lookup || lookup
    }
    return { findings, lookup }
  }
  if (tool === 'reporting_check') {
    const findings = []
    for (const check of plan?.checks || []) {
      const result = await (deps.runReportingCheck || runReportingCheck)({ action: 'status', slug: check.slug }, shim, deps)
      if (result?.error) throw new Error(`${check.slug}: ${result.error}`)
      findings.push(...reportingFindings(result.status, check.file))
    }
    return { findings }
  }
  throw new Error(`unknown external tool: ${tool}`)
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

/**
 * Run the named tools (default: all) on what `plan` says and write their result files.
 * @param {string} root project root (where ah.yaml is)
 * @param {object} plan output of `ah external plan`: {tool: {files: [{path, file}]}}
 * @returns {{written: object[], skipped: object[], errors: object[]}} one tool failing does not stop the others;
 *   its previous file is left alone (and goes stale when its inputs change).
 */
export async function runExternal({ root, plan, tools, exec, args = {}, deps = {} }) {
  const wanted = (tools?.length ? tools : EXTERNAL_TOOLS)
  const summary = { written: [], skipped: [], errors: [] }
  for (const tool of wanted) {
    if (!EXTERNAL_TOOLS.includes(tool)) {
      summary.errors.push({ tool, error: `unknown external tool; choose from ${EXTERNAL_TOOLS.join(', ')}` })
      continue
    }
    const files = plan?.[tool]?.files || []
    if (!files.length) {
      summary.skipped.push({ tool, reason: 'nothing to check in this project' })
      continue
    }
    try {
      const inputs = Object.fromEntries(files.map((entry) => [entry.path, sha256(join(root, entry.path))]))
      const { findings, lookup } = await collect(tool, files, root, exec, args, deps, plan?.[tool])
      const body = {
        schema: EXTERNAL_SCHEMA,
        tool,
        generated_at: new Date().toISOString(),
        inputs,
        findings: dedupeSorted(findings),
        ...(lookup ? { lookup: { asof: lookup.asof, max_age_days: lookup.max_age_days, served_stale: lookup.served_stale, failed: lookup.failed } } : {}),
      }
      writeAtomic(join(root, '.ah', 'external', `${tool}.json`), `${JSON.stringify(body, null, 1)}\n`)
      summary.written.push({ tool, files: files.length, findings: body.findings.length })
    } catch (error) {
      summary.errors.push({ tool, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return summary
}

export function renderExternalRun(summary) {
  const lines = []
  for (const w of summary.written) lines.push(`external ${w.tool}: ${w.findings} finding(s) from ${w.files} file(s)`)
  for (const s of summary.skipped) lines.push(`external ${s.tool}: skipped (${s.reason})`)
  for (const e of summary.errors) lines.push(`external ${e.tool}: FAILED, previous result kept: ${e.error}`)
  return lines.join('\n')
}
