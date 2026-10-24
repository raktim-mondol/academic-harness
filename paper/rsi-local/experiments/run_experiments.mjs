#!/usr/bin/env node
/**
 * Offline RSI corpus experiments.
 *
 * Uses real manuscripts/proposals on this machine. It never modifies the
 * originals: every project is copied to a temporary work directory. Results are
 * written under experiments/results/ and are the source of the paper's tables.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  appendEpisode, currentLessons, defaultStoreDir, ensureStore, nowIso,
} from '../../../rsi-store.js'
import {
  classifyTask, diagnoseAndAdmit, lessonTextsSimilar, lintLesson, lintPreference, remedyFor,
  selectLessonsForTurn,
} from '../../../rsi-core.js'
import { injectDefects } from '../../../rsi-benchmark.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const AH = process.env.AH_BIN || join(ROOT, 'vendor/academic-harness/.venv/bin/ah')
const WORK = process.env.RSI_EXP_WORK || join(tmpdir(), 'rsi-corpus-work')
const RESULTS = join(HERE, 'results')
const MANIFEST = JSON.parse(readFileSync(join(HERE, 'corpus.json'), 'utf8'))
const SKIP_NETWORK = process.env.RSI_EXP_SKIP_NETWORK === '1'

const CONFIG = {
  mode: 'auto',
  exploration: 1,
  active_control_rate: 0,
  min_evidence: 3,
  min_sessions: 2,
  max_lessons: 50,
  max_per_class: 50,
  max_inject: 50,
  max_tokens: 5000,
  diagnose_every: 0,
  lesson_ttl_days: 180,
  remote_judge: false,
}

function writeJson(name, value) {
  writeFileSync(join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function copyProject(source, dest) {
  cpSync(source, dest, {
    recursive: true,
    filter: (src) => {
      const rel = relative(source, src)
      if (!rel) return true
      if (/(^|[/\\])(\.git|\.obsidian|\.claude|node_modules|\.venv|\.ah|__pycache__|\.pytest_cache|data|figures|diagrams|assets|images|experiment)([/\\]|$)/.test(rel)) return false
      if (/\.(pdf|png|jpe?g|tiff?|gif|bmp|svg|eps|ps|npy|npz|csv|xlsx|xls|parquet|h5ad|h5|zip|gz|tar|mp4|mov|avi|aux|log|fls|fdb_latexmk|out|bbl|blg|bcf|run\.xml|synctex\.gz)$/i.test(rel)) return false
      return true
    },
  })
}

function runAh(args, cwd) {
  const result = spawnSync(AH, args, {
    cwd,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 128 * 1024 * 1024,
  })
  return result
}

function auditProject(projectDir) {
  const started = Date.now()
  const result = runAh(['audit', '--project', projectDir, '--json', '--det-check', '--limit', '300'], projectDir)
  const text = String(result.stdout || '').trim()
  let report
  try {
    report = JSON.parse(text)
  } catch {
    throw new Error(`audit did not return JSON (exit ${result.status}): ${(result.stderr || text).slice(0, 500)}`)
  }
  return { report, seconds: (Date.now() - started) / 1000, exit: result.status }
}

function findingList(report) {
  return (Array.isArray(report.findings) ? report.findings : []).map((finding) => ({
    check: String(finding.check || finding.code || 'UNKNOWN'),
    level: String(finding.level || finding.severity || 'unknown').toLowerCase(),
    state: String(finding.state || 'open'),
    file: finding.file || null,
  }))
}

function countByCheck(findings) {
  const counts = {}
  for (const finding of findings) counts[finding.check] = (counts[finding.check] || 0) + 1
  return counts
}

function familyOf(check) {
  return String(check).split('-')[0].toUpperCase()
}

function familiesOf(findings) {
  return [...new Set(findings.map((finding) => familyOf(finding.check)))].sort()
}

function blocking(findings) {
  return findings.filter((finding) => ['blocker', 'major'].includes(finding.level) && finding.state === 'open').length
}

function prepare(item) {
  const dest = join(WORK, item.id)
  mkdirSync(dest, { recursive: true })
  copyProject(item.source, dest)
  const migration = runAh(['migrate', dest, '--profile', item.profile, '--apply', '--force'], dest)
  if (migration.status !== 0) {
    throw new Error(`migrate failed for ${item.id}: ${(migration.stderr || migration.stdout).slice(0, 500)}`)
  }
  const audit = auditProject(dest)
  return {
    dest,
    migrationExit: migration.status,
    report: audit.report,
    auditSeconds: audit.seconds,
  }
}

function runDefectTest(item, prepared) {
  const dest = join(WORK, `${item.id}-defects`)
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  const mutations = injectDefects(prepared.dest, dest)
  if (!mutations.length) return { mutations: [], before: findingList(prepared.report), after: [], newChecks: [], detected: [] }
  const audit = auditProject(dest)
  const beforeFindings = findingList(prepared.report)
  const afterFindings = findingList(audit.report)
  const beforeCounts = countByCheck(beforeFindings)
  const afterCounts = countByCheck(afterFindings)
  const newChecks = Object.keys(afterCounts).filter((check) => (afterCounts[check] || 0) > (beforeCounts[check] || 0))
  const expected = {
    missing_citation: 'BIB',
    missing_ref: 'TEX',
    duplicate_label: 'TEX',
    removed_anchor: 'UNIT',
  }
  const detected = mutations.map((mutation) => {
    const family = expected[mutation.type]
    const beforeFamily = Object.entries(beforeCounts).filter(([check]) => check.startsWith(family)).reduce((sum, [, count]) => sum + count, 0)
    const afterFamily = Object.entries(afterCounts).filter(([check]) => check.startsWith(family)).reduce((sum, [, count]) => sum + count, 0)
    return {
      type: mutation.type,
      file: mutation.file,
      expected_family: family,
      detected: afterFamily > beforeFamily,
      before_family: beforeFamily,
      after_family: afterFamily,
    }
  })
  return {
    mutations,
    before: beforeFindings.length,
    after: afterFindings.length,
    newChecks,
    detected,
    seconds: audit.seconds,
  }
}

function episodesFor(item, findings) {
  return findings.map((finding, index) => ({
    v: 1,
    ts: nowIso(),
    episode_id: `${item.id}-ep-${index}`,
    session_id: `${item.id}-session-${index % 2}`,
    agent_kind: 'main',
    project: { key: item.id, label: item.label, ah: true },
    task_class: item.task_class,
    task_tags: [],
    model: 'offline-corpus',
    plugin_version: '0.21.0',
    started_at: nowIso(),
    ended_at: nowIso(),
    reason: 'corpus-audit',
    turns: 1,
    tool_counts: { ah_audit: 1 },
    errors: 0,
    corrections: 0,
    finding_count: 1,
    blocking_findings: ['blocker', 'major'].includes(finding.level) ? 1 : 0,
    findings: { [finding.check]: 1 },
    gate: null,
    signals: [{ kind: 'finding', key: finding.check }],
    quality: 0.4,
    success: false,
    substantive: true,
    lesson_ids_injected: [],
    lesson_ids_control: [],
    lesson_ids_eligible: [],
    user_chars: 100,
  }))
}

async function learn(episodes) {
  if (!episodes.length) return []
  const dir = mkdtempSync(join(tmpdir(), 'rsi-corpus-store-'))
  try {
    ensureStore(dir)
    for (const episode of episodes) appendEpisode(dir, episode)
    await diagnoseAndAdmit({ dir, config: CONFIG })
    return currentLessons(dir).filter((lesson) => ['active', 'trial', 'candidate'].includes(lesson.status))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function lessonMatches(lesson, remedy) {
  return lessonTextsSimilar(lesson.text, remedy.text) >= 0.6
}

function coverage(item, findings, lessons) {
  const families = familiesOf(findings)
  const generic = remedyFor('finding', 'ZZZ-001', item.task_class)
  const specific = families
    .map((family) => ({ family, remedy: remedyFor('finding', `${family}-001`, item.task_class) }))
    .filter((row) => row.remedy && row.remedy.text !== generic.text)
  const any = families
    .map((family) => ({ family, remedy: remedyFor('finding', `${family}-001`, item.task_class) }))
    .filter((row) => row.remedy)
  const coveredSpecific = specific.filter((row) => lessons.some((lesson) => lessonMatches(lesson, row.remedy))).length
  const coveredAny = any.filter((row) => lessons.some((lesson) => lessonMatches(lesson, row.remedy))).length
  const selection = selectLessonsForTurn({
    lessons,
    taskClass: item.task_class,
    sessionId: item.id,
    turnHash: `${item.id}-coverage`,
    config: CONFIG,
  })
  const genericLesson = {
    id: 'Lgeneric', text: generic.text, task_class: item.task_class, scope: 'user', source: 'diagnosis',
    status: 'active', action: generic.action, stats: { injected: 1, injected_success: 1, control: 0, control_success: 0 },
    last_validated_at: nowIso(),
  }
  const genericSelection = selectLessonsForTurn({
    lessons: [genericLesson],
    taskClass: item.task_class,
    sessionId: item.id,
    turnHash: `${item.id}-generic`,
    config: CONFIG,
  })
  return {
    families,
    specific_families: specific.map((row) => row.family),
    covered_specific: coveredSpecific,
    specific_rate: specific.length ? coveredSpecific / specific.length : null,
    covered_any: coveredAny,
    any_rate: any.length ? coveredAny / any.length : null,
    injected_lessons: selection.injected.length,
    injected_tokens: selection.tokens,
    generic_tokens: genericSelection.tokens,
    lessons: lessons.map((lesson) => ({ id: lesson.id, status: lesson.status, task_class: lesson.task_class, text: lesson.text })),
  }
}

function metrics(rows, labelKey, predKey) {
  const labels = ['safe', 'unsafe']
  let tp = 0; let fp = 0; let tn = 0; let fn = 0
  for (const row of rows) {
    const actual = row[labelKey] === 'unsafe'
    const predicted = row[predKey] === 'unsafe'
    if (actual && predicted) tp += 1
    else if (!actual && predicted) fp += 1
    else if (!actual && !predicted) tn += 1
    else fn += 1
  }
  const precision = tp + fp ? tp / (tp + fp) : null
  const recall = tp + fn ? tp / (tp + fn) : null
  const f1 = precision != null && recall != null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null
  return { tp, fp, tn, fn, precision, recall, f1, accuracy: (tp + tn) / rows.length, n: rows.length }
}

function preferenceMetrics(rows) {
  let tp = 0; let fp = 0; let tn = 0; let fn = 0
  for (const row of rows) {
    const actual = row.label === 'durable'
    const predicted = row.accepted === true
    if (actual && predicted) tp += 1
    else if (!actual && predicted) fp += 1
    else if (!actual && !predicted) tn += 1
    else fn += 1
  }
  const precision = tp + fp ? tp / (tp + fp) : null
  const recall = tp + fn ? tp / (tp + fn) : null
  const f1 = precision != null && recall != null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null
  return { tp, fp, tn, fn, precision, recall, f1, accuracy: (tp + tn) / rows.length, n: rows.length }
}

function taskMetrics(rows) {
  const labels = [...new Set(rows.map((row) => row.label))].sort()
  const per = {}
  for (const label of labels) {
    const tp = rows.filter((row) => row.label === label && row.predicted === label).length
    const fp = rows.filter((row) => row.label !== label && row.predicted === label).length
    const fn = rows.filter((row) => row.label === label && row.predicted !== label).length
    const support = rows.filter((row) => row.label === label).length
    const precision = tp + fp ? tp / (tp + fp) : null
    const recall = tp + fn ? tp / (tp + fn) : null
    const f1 = precision != null && recall != null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null
    per[label] = { support, tp, fp, fn, precision, recall, f1 }
  }
  const correct = rows.filter((row) => row.label === row.predicted).length
  return { n: rows.length, accuracy: correct / rows.length, per_class: per }
}

function extractDois(pdf) {
  const result = spawnSync('pdftotext', [pdf, '-'], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 120_000 })
  if (result.status !== 0) return { error: (result.stderr || '').slice(0, 200), dois: [] }
  const text = String(result.stdout || '')
  const dois = new Set()
  for (const match of text.matchAll(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi)) {
    const doi = match[0].replace(/[.,;)\]}]+$/, '')
    const suffix = doi.slice(doi.indexOf('/') + 1)
    if (!suffix || suffix.length < 8 || !/\d/.test(suffix)) continue
    if (!suffix.includes('.') && !/[A-Za-z]/.test(suffix)) continue
    if (/^v\d+\/\d{4}$/i.test(suffix)) continue
    dois.add(doi)
  }
  return { dois: [...dois] }
}

async function pdfIntegrity() {
  if (SKIP_NETWORK) return { skipped: true, reason: 'RSI_EXP_SKIP_NETWORK=1', pdfs: [] }
  const { runIntegrityCheck } = await import('../../../integrity-check.js')
  const pdfRows = []
  const allDois = []
  for (const pdf of MANIFEST.pdfs) {
    if (!existsSync(pdf.source)) {
      pdfRows.push({ id: pdf.id, source: pdf.source, error: 'missing' })
      continue
    }
    const extracted = extractDois(pdf.source)
    pdfRows.push({ id: pdf.id, file: basename(pdf.source), doi_count: extracted.dois.length, error: extracted.error || null })
    for (const doi of extracted.dois) if (!allDois.some((row) => row.doi === doi)) allDois.push({ doi, pdf: pdf.id })
  }
  const sample = allDois.slice(0, 8)
  const verdicts = []
  for (const row of sample) {
    const started = Date.now()
    try {
      const value = await runIntegrityCheck(
        { doi: row.doi },
        { signal: AbortSignal.timeout(15_000) },
        { resolveEnv: async () => '' },
      )
      verdicts.push({
        doi: row.doi,
        pdf: row.pdf,
        verdict: value?.verdict || (value?.error ? 'error' : 'unknown'),
        title: value?.title || null,
        error: value?.error || null,
        seconds: (Date.now() - started) / 1000,
      })
    } catch (error) {
      verdicts.push({ doi: row.doi, pdf: row.pdf, verdict: 'error', error: error?.message || String(error), seconds: (Date.now() - started) / 1000 })
    }
    await sleep(300)
  }
  return { skipped: false, pdfs: pdfRows, verdicts, unique_dois: allDois.length, sampled: sample.length }
}

async function main() {
  if (!existsSync(AH)) throw new Error(`ah binary not found: ${AH}`)
  mkdirSync(RESULTS, { recursive: true })
  if (existsSync(WORK)) rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })

  const corpus = []
  const defects = []
  const prepared = new Map()
  for (const item of MANIFEST.documents) {
    process.stdout.write(`[prepare] ${item.id} ${item.label}\n`)
    try {
      const result = prepare(item)
      const findings = findingList(result.report)
      corpus.push({
        id: item.id,
        label: item.label,
        type: item.type,
        task_class: item.task_class,
        units: result.report.coverage?.units ?? null,
        citations: result.report.coverage?.citations ?? null,
        bib_entries: result.report.coverage?.bib_entries ?? null,
        findings: findings.length,
        blocking: blocking(findings),
        gate_passed: result.report.gate?.passed ?? null,
        checks: countByCheck(findings),
        families: familiesOf(findings),
        audit_seconds: result.auditSeconds,
        migration_exit: result.migrationExit,
      })
      prepared.set(item.id, { ...result, findings })
    } catch (error) {
      corpus.push({ id: item.id, label: item.label, type: item.type, error: error?.message || String(error) })
    }
  }
  writeJson('corpus.json', corpus)

  for (const item of MANIFEST.documents) {
    const result = prepared.get(item.id)
    if (!result) continue
    process.stdout.write(`[defects] ${item.id}\n`)
    try {
      const defect = runDefectTest(item, result)
      defects.push({ id: item.id, label: item.label, type: item.type, ...defect })
    } catch (error) {
      defects.push({ id: item.id, label: item.label, type: item.type, error: error?.message || String(error) })
    }
  }
  writeJson('defects.json', defects)

  const transfer = []
  for (const item of MANIFEST.documents) {
    const result = prepared.get(item.id)
    if (!result) continue
    const ownEpisodes = episodesFor(item, result.findings)
    const heldInLessons = await learn(ownEpisodes)
    const others = MANIFEST.documents.filter((other) => other.id !== item.id && other.type === item.type)
    const otherEpisodes = others.flatMap((other) => {
      const preparedOther = prepared.get(other.id)
      return preparedOther ? episodesFor(other, preparedOther.findings) : []
    })
    const looLessons = otherEpisodes.length ? await learn(otherEpisodes) : []
    const heldIn = coverage(item, result.findings, heldInLessons)
    const loo = otherEpisodes.length ? coverage(item, result.findings, looLessons) : null
    transfer.push({
      id: item.id,
      label: item.label,
      type: item.type,
      findings: result.findings.length,
      families: heldIn.families,
      specific_families: heldIn.specific_families,
      heldin_covered: heldIn.covered_specific,
      heldin_rate: heldIn.specific_rate,
      loo_covered: loo?.covered_specific ?? null,
      loo_rate: loo?.specific_rate ?? null,
      any_rate: heldIn.any_rate,
      heldin_lessons: heldInLessons.length,
      loo_lessons: looLessons.length,
      injected_lessons: heldIn.injected_lessons,
      injected_tokens: heldIn.injected_tokens,
      generic_tokens: heldIn.generic_tokens,
      heldin_lessons_detail: heldIn.lessons,
      loo_lessons_detail: loo?.lessons || [],
    })
    process.stdout.write(`[transfer] ${item.id}: held-in ${heldIn.covered_specific}/${heldIn.specific_families.length}, LOO ${loo ? `${loo.covered_specific}/${loo.specific_families.length}` : 'n/a'}\n`)
  }
  writeJson('transfer.json', transfer)

  const taskRows = readFileSync(join(HERE, 'task-set.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  for (const row of taskRows) row.predicted = classifyTask(row.text).class
  writeJson('classification.json', {
    rows: taskRows,
    metrics: taskMetrics(taskRows),
  })

  const safetyRows = readFileSync(join(HERE, 'safety-set.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  for (const row of safetyRows) {
    const lint = lintLesson(row.text)
    row.predicted = lint.ok ? 'safe' : 'unsafe'
    row.reason = lint.reason
  }
  const preferenceRows = readFileSync(join(HERE, 'preference-set.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  for (const row of preferenceRows) {
    const lint = lintPreference(row.text)
    row.accepted = lint.ok
    row.reason = lint.reason
  }
  const safetyHeldout = readFileSync(join(HERE, 'safety-heldout.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  for (const row of safetyHeldout) {
    const lint = lintLesson(row.text)
    row.predicted = lint.ok ? 'safe' : 'unsafe'
    row.reason = lint.reason
  }
  const preferenceHeldout = readFileSync(join(HERE, 'preference-heldout.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  for (const row of preferenceHeldout) {
    const lint = lintPreference(row.text)
    row.accepted = lint.ok
    row.reason = lint.reason
  }
  writeJson('safety.json', {
    lint: { rows: safetyRows, metrics: metrics(safetyRows, 'label', 'predicted') },
    preferences: { rows: preferenceRows, metrics: preferenceMetrics(preferenceRows) },
    lint_heldout: { rows: safetyHeldout, metrics: metrics(safetyHeldout, 'label', 'predicted') },
    preference_heldout: { rows: preferenceHeldout, metrics: preferenceMetrics(preferenceHeldout) },
  })

  process.stdout.write('[pdf] extracting DOIs and checking a sample\n')
  const pdfs = await pdfIntegrity()
  writeJson('pdf-integrity.json', pdfs)

  const summary = {
    generated_at: nowIso(),
    documents: corpus.length,
    prepared: corpus.filter((row) => !row.error).length,
    total_units: corpus.reduce((sum, row) => sum + (row.units || 0), 0),
    total_citations: corpus.reduce((sum, row) => sum + (row.citations || 0), 0),
    total_bib_entries: corpus.reduce((sum, row) => sum + (row.bib_entries || 0), 0),
    total_findings: corpus.reduce((sum, row) => sum + (row.findings || 0), 0),
    defect_mutations: defects.flatMap((row) => row.detected || []).length,
    defect_detected: defects.flatMap((row) => row.detected || []).filter((row) => row.detected).length,
    task_accuracy: taskMetrics(taskRows).accuracy,
    safety_metrics: metrics(safetyRows, 'label', 'predicted'),
    safety_heldout_metrics: metrics(safetyHeldout, 'label', 'predicted'),
    preference_metrics: preferenceMetrics(preferenceRows),
    preference_heldout_metrics: preferenceMetrics(preferenceHeldout),
    pdf_verdicts: pdfs.skipped ? 'skipped' : (pdfs.verdicts || []).reduce((acc, row) => {
      acc[row.verdict] = (acc[row.verdict] || 0) + 1
      return acc
    }, {}),
  }
  writeJson('summary.json', summary)
  console.log(JSON.stringify(summary, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
