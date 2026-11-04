#!/usr/bin/env node
/**
 * Evaluation-validity corpus calibration — the Phase 0 measurement Phase 2 owed.
 *
 * Phase 0 already measures reviewer variance and decision agreement from stored
 * rounds. This companion runs the four deterministic validity checks over a
 * labeled corpus of manuscripts, including real PDFs converted with the simple
 * text-based converter (no OCR), and reports:
 *
 *   - per-check flag rates, state agreement, precision, recall, and the two
 *     error types that matter here: a wrong `clear` on a case the label marks
 *     `flagged`, and a false `flagged` on a well-formed paper;
 *   - determinism (the same bytes must produce the same states and evidence);
 *   - every mismatch with its reason and evidence, so a heuristic can be tuned.
 *
 * Labels are an independent reader's reading of the manuscript, not ground
 * truth. Attribution is evaluated text/grid-side only unless a manifest row
 * supplies `claims`/`comments`; the live `validity` action additionally reads
 * the stored review's claims. That limitation is printed in every report.
 *
 * This script is intentionally not named `test-*.mjs`: it reads PDFs and is a
 * measurement harness, not a unit test. `test-deep-review-validity-calibration.mjs`
 * exercises the same code on the committed fixtures.
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateValidity } from '../deep-review.js'
import { convertPdfMarkdown } from '../pdf-to-markdown.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
export const VALIDITY_CHECKS = ['attribution', 'evaluator_drift', 'benchmark_coverage', 'unmeasured_trade_off']
export const VALIDITY_STATES = ['clear', 'flagged', 'not_checked']
const MIN_LABELED_PER_CHECK = 3
const MIN_PAPERS_FOR_VALIDITY = 6

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  return value && !value.startsWith('--') ? value : (fallback ?? true)
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function jsonOut(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function normalizeLabels(raw) {
  const labels = {}
  for (const id of VALIDITY_CHECKS) {
    const value = raw?.[id]
    labels[id] = VALIDITY_STATES.includes(String(value)) ? String(value) : null
  }
  return labels
}

/** Read one manuscript, converting a PDF with the simple text-based converter. */
async function readCorpusManuscript(paper, manifestDir) {
  if (typeof paper?.text === 'string') {
    return { text: paper.text, format: String(paper.format ?? 'md').toLowerCase(), source: 'manifest_text', note: null, path: null, error: null, page_count: null, ocr_pages: 0 }
  }
  const rawPath = String(paper?.path ?? '')
  const target = resolve(manifestDir, rawPath)
  const ext = extname(target).slice(1).toLowerCase()
  const format = String(paper?.format ?? ext).toLowerCase()
  if (!existsSync(target)) {
    return { text: null, format, source: 'missing', note: `file not found: ${target}`, path: target, error: `file not found: ${target}`, page_count: null, ocr_pages: 0 }
  }
  if (format === 'pdf') {
    let converted
    try {
      converted = await convertPdfMarkdown(readFileSync(target))
    } catch (error) {
      return { text: null, format, source: 'pdf_conversion_failed', note: error instanceof Error ? error.message : String(error), path: target, error: error instanceof Error ? error.message : String(error), page_count: null, ocr_pages: 0 }
    }
    const ocrPages = Array.isArray(converted?.pages_needing_ocr) ? converted.pages_needing_ocr.length : 0
    if (!converted?.success || typeof converted.markdown !== 'string' || !converted.markdown.trim()) {
      const error = converted?.error || 'the converter returned no Markdown'
      return { text: null, format, source: 'pdf_conversion_failed', note: error, path: target, error, page_count: converted?.page_count ?? null, ocr_pages: ocrPages, pdf_type: converted?.pdf_type ?? null }
    }
    return {
      text: converted.markdown,
      format,
      source: 'pdf_converted',
      note: `converted (${converted.pdf_type || 'unknown type'}, ${converted.page_count ?? '?'} page(s))${ocrPages ? `; ${ocrPages} page(s) flagged for OCR and left un-OCR'd` : ''}`,
      path: target,
      error: null,
      page_count: converted.page_count ?? null,
      ocr_pages: ocrPages,
      pdf_type: converted.pdf_type ?? null,
    }
  }
  try {
    return { text: readFileSync(target, 'utf8'), format, source: 'manuscript', note: null, path: target, error: null, page_count: null, ocr_pages: 0 }
  } catch (error) {
    return { text: null, format, source: 'read_failed', note: error instanceof Error ? error.message : String(error), path: target, error: error instanceof Error ? error.message : String(error), page_count: null, ocr_pages: 0 }
  }
}

function validitySignature(evaluation) {
  return JSON.stringify({
    states: evaluation.states,
    checks: evaluation.checks.map((check) => ({
      id: check.id,
      state: check.state,
      tallies: check.tallies,
      evidence: check.evidence.map((item) => [item.kind, item.line, item.page, item.location, item.text]),
    })),
    inventory: {
      grids: evaluation.inventory.grids,
      metric_axes: evaluation.inventory.metric_axes,
      other_axes: evaluation.inventory.other_axes,
      value_axes: evaluation.inventory.value_axes,
      references_masked: evaluation.inventory.references_masked,
      arms: evaluation.inventory.arms,
      baseline_arms: evaluation.inventory.baseline_arms,
      gain_claims: evaluation.inventory.gain_claims,
      truncated_at_chars: evaluation.inventory.truncated_at_chars,
      grids_truncated: evaluation.inventory.grids_truncated,
    },
  })
}

async function evaluatePaper(paper, manifestDir) {
  const read = await readCorpusManuscript(paper, manifestDir)
  const input = {
    text: read.text,
    format: read.format,
    claims: Array.isArray(paper?.claims) ? paper.claims : [],
    comments: Array.isArray(paper?.comments) ? paper.comments : [],
    source: read.source,
    note: read.note,
  }
  const first = evaluateValidity(input)
  const second = evaluateValidity(input)
  const labels = normalizeLabels(paper?.labels)
  return {
    id: String(paper?.id ?? basename(read.path ?? String(paper?.title ?? 'paper'))),
    title: paper?.title ?? null,
    path: read.path,
    format: read.format,
    text_source: read.source,
    text_note: read.note,
    references_masked: first.inventory.references_masked === true,
    reference_line: first.inventory.reference_line ?? null,
    pdf_line_numbers_stripped: first.inventory.pdf_line_numbers_stripped === true,
    page_count: read.page_count ?? null,
    ocr_pages: read.ocr_pages ?? 0,
    pdf_type: read.pdf_type ?? null,
    error: read.error ?? null,
    label_source: paper?.label_source ?? null,
    labels,
    labels_complete: VALIDITY_CHECKS.every((id) => labels[id]),
    states: first.states,
    checks: first.checks.map((check) => ({
      id: check.id,
      state: check.state,
      reason: check.reason,
      tallies: check.tallies,
      evidence: check.evidence.slice(0, 3),
    })),
    inventory: {
      grids: first.inventory.grids,
      metric_axes: first.inventory.metric_axes,
      other_axes: first.inventory.other_axes,
      value_axes: first.inventory.value_axes,
      arms: first.inventory.arms,
      baseline_arms: first.inventory.baseline_arms,
      gain_claims: first.inventory.gain_claims,
      truncated_at_chars: first.inventory.truncated_at_chars,
      grids_truncated: first.inventory.grids_truncated,
    },
    deterministic: validitySignature(first) === validitySignature(second),
  }
}

function ratio(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(3)) : null
}

export function validityMetrics(papers) {
  const evaluated = papers.filter((paper) => !paper.error)
  const perCheck = {}
  for (const id of VALIDITY_CHECKS) {
    const labeled = evaluated.filter((paper) => paper.labels[id])
    const predictedFlagged = evaluated.filter((paper) => paper.states[id] === 'flagged')
    const truePositive = labeled.filter((paper) => paper.states[id] === 'flagged' && paper.labels[id] === 'flagged').length
    const missedClear = labeled.filter((paper) => paper.states[id] === 'clear' && paper.labels[id] === 'flagged').length
    const abstained = labeled.filter((paper) => paper.states[id] === 'not_checked' && paper.labels[id] === 'flagged').length
    const falseAlarms = labeled.filter((paper) => paper.states[id] === 'flagged' && paper.labels[id] !== 'flagged').length
    const matched = labeled.filter((paper) => paper.states[id] === paper.labels[id]).length
    const labelFlagged = labeled.filter((paper) => paper.labels[id] === 'flagged').length
    const notFlaggedLabels = labeled.filter((paper) => paper.labels[id] !== 'flagged').length
    perCheck[id] = {
      labeled: labeled.length,
      verdict: labeled.length >= MIN_LABELED_PER_CHECK
        ? 'measured'
        : `not_checked (${labeled.length}/${MIN_LABELED_PER_CHECK} labeled)`,
      state_agreement: { matched, total: labeled.length, rate: ratio(matched, labeled.length) },
      label_flagged: labelFlagged,
      predicted_flagged: predictedFlagged.length,
      true_positive: truePositive,
      missed_clear: missedClear,
      abstained,
      false_alarm: falseAlarms,
      precision: ratio(truePositive, truePositive + falseAlarms),
      recall: ratio(truePositive, truePositive + missedClear + abstained),
      flag_rate: ratio(predictedFlagged.length, evaluated.length),
      false_alarm_rate: ratio(falseAlarms, notFlaggedLabels),
    }
  }

  const complete = evaluated.filter((paper) => paper.labels_complete)
  const matchedStates = complete.reduce((sum, paper) => sum + VALIDITY_CHECKS.filter((id) => paper.states[id] === paper.labels[id]).length, 0)
  const totalStates = complete.length * VALIDITY_CHECKS.length
  const wellFormed = complete.filter((paper) => VALIDITY_CHECKS.every((id) => paper.labels[id] !== 'flagged'))
  const falsePositivePapers = wellFormed.filter((paper) => VALIDITY_CHECKS.some((id) => paper.states[id] === 'flagged'))
  const determinismMismatches = evaluated.filter((paper) => !paper.deterministic)
  return {
    papers: papers.length,
    evaluated: evaluated.length,
    labels_complete: complete.length,
    papers_for_a_number: MIN_PAPERS_FOR_VALIDITY,
    verdict: evaluated.length >= MIN_PAPERS_FOR_VALIDITY
      ? (complete.length >= MIN_PAPERS_FOR_VALIDITY
          ? 'measured'
          : `flag rates measured; agreement not_checked (${complete.length}/${MIN_PAPERS_FOR_VALIDITY} complete labels)`)
      : `not_checked (${evaluated.length}/${MIN_PAPERS_FOR_VALIDITY} evaluable papers)`,
    overall_agreement: { matched: matchedStates, total: totalStates, rate: ratio(matchedStates, totalStates) },
    false_positive_papers: falsePositivePapers.map((paper) => ({ id: paper.id, states: paper.states, labels: paper.labels })),
    determinism_mismatches: determinismMismatches.map((paper) => ({ id: paper.id, path: paper.path })),
    per_check: perCheck,
  }
}

function stateCell(state, label) {
  if (!label) return state
  const mark = state === label ? '' : state === 'flagged' && label !== 'flagged' ? ' !alarm' : label === 'flagged' && state === 'clear' ? ' !miss' : label === 'flagged' && state === 'not_checked' ? ' !abstain' : ' !diff'
  return `${state} (${label})${mark}`
}

export function validityMarkdown(report) {
  const v = report.validity
  const lines = [
    '# deep_review evaluation-validity calibration',
    '',
    `Generated ${report.generated_at}. ${v.verdict}. Advisory readings; the labels are an independent reader's reading, not ground truth.`,
    '',
    '## Corpus',
    '',
    `- manifest: ${report.corpus.path}`,
    `- papers: ${v.papers}; evaluable: ${v.evaluated}; labels complete: ${v.labels_complete}; verdict floor: ${v.papers_for_a_number} evaluable papers`,
    `- PDFs converted with the simple text converter: ${report.conversion.converted}/${report.conversion.pdfs}; conversion/read failures: ${report.conversion.failed}; pages flagged for OCR, not OCR'd: ${report.conversion.ocr_pages}`,
    `- references excluded from counting: ${report.conversion.references_masked} paper(s); leading PDF line numbers stripped: ${report.conversion.pdf_line_numbers_stripped} paper(s)`,
    `- label source: ${report.corpus.label_source || 'not stated'}`,
    '- attribution in corpus mode uses the manuscript text and grids; stored-review claims are included only when a manifest row supplies `claims`/`comments`.',
    '',
  ]
  if (report.conversion.failures.length) {
    lines.push('Conversion failures (excluded from agreement, reported as not_checked by the tool):', '')
    for (const failure of report.conversion.failures) lines.push(`- ${failure.id}: ${failure.error}`)
    lines.push('')
  }
  lines.push(
    '## Per check',
    '',
    '| check | verdict | labeled | agreement | flag labels | predicted flagged | TP | missed clear | abstained | false alarms | precision | recall | flag rate |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  )
  for (const id of VALIDITY_CHECKS) {
    const m = v.per_check[id]
    lines.push(`| ${id} | ${m.verdict} | ${m.labeled} | ${m.state_agreement.matched}/${m.state_agreement.total} (${m.state_agreement.rate ?? '—'}) | ${m.label_flagged} | ${m.predicted_flagged} | ${m.true_positive} | ${m.missed_clear} | ${m.abstained} | ${m.false_alarm} | ${m.precision ?? '—'} | ${m.recall ?? '—'} | ${m.flag_rate ?? '—'} |`)
  }
  lines.push(
    '',
    `Overall state agreement on complete labels: ${v.overall_agreement.matched}/${v.overall_agreement.total} (${v.overall_agreement.rate ?? '—'}).`,
    `False positives on well-formed papers: ${v.false_positive_papers.length}${v.false_positive_papers.length ? ` — ${v.false_positive_papers.map((paper) => paper.id).join(', ')}` : ''}.`,
    `Determinism mismatches: ${v.determinism_mismatches.length}${v.determinism_mismatches.length ? ` — ${v.determinism_mismatches.map((paper) => paper.id).join(', ')}` : ''}.`,
    '',
    '## Per paper',
    '',
    '| paper | source | attribution | evaluator_drift | benchmark_coverage | unmeasured_trade_off | deterministic |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  )
  for (const paper of report.papers) {
    const p = paper
    lines.push(`| ${p.id} | ${p.text_source} | ${VALIDITY_CHECKS.map((id) => stateCell(p.states[id], p.labels[id])).join(' | ')} | ${p.deterministic ? 'yes' : 'NO'} |`)
  }
  const mismatches = report.papers.filter((paper) => !paper.error && VALIDITY_CHECKS.some((id) => paper.labels[id] && paper.states[id] !== paper.labels[id]))
  lines.push('', '## Mismatches', '')
  if (!mismatches.length) {
    lines.push('- none on the labeled checks.')
  } else {
    for (const paper of mismatches) {
      for (const id of VALIDITY_CHECKS) {
        if (!paper.labels[id] || paper.states[id] === paper.labels[id]) continue
        const check = paper.checks.find((item) => item.id === id)
        const evidence = (check.evidence || []).slice(0, 2).map((item) => `${item.line != null ? `line ${item.line}` : item.page != null ? `page ${item.page}` : item.location || 'review'}: ${item.text}`).join(' / ')
        lines.push(`- ${paper.id} / ${id}: predicted ${paper.states[id]}, label ${paper.labels[id]} — ${check.reason}${evidence ? ` — ${evidence}` : ''}`)
      }
    }
  }
  lines.push(
    '',
    '## Interpretation limits',
    '',
    '- Labels are a reader\'s reading of the manuscript, not a venue decision or a proof; disagreement is a prompt to inspect the evidence, not an automatic bug.',
    '- `missed clear` is the dangerous error: the check said `clear` on a case the reader marked `flagged`. `abstained` is `not_checked` on such a case, which is honest but not a pass.',
    '- `false alarms` are `flagged` where the reader did not mark a failure; the well-formed line counts papers with no flagged labels that received any flag.',
    '- PDFs use the simple text converter, no OCR. Pages flagged for OCR can lose text; those papers remain in the measurement but carry the note.',
    '- Attribution corpus mode is text/grid-side. The live action also reads stored review claims, so corpus recall for attribution is a lower bound for papers whose only removal evidence is an engine-typed claim.',
    '',
  )
  return lines.join('\n')
}

export async function runValidityCorpus(corpusPath, { outDir = join(ROOT, 'reports') } = {}) {
  const manifest = readJson(corpusPath)
  if (!manifest || !Array.isArray(manifest.papers) || !manifest.papers.length) {
    throw new Error(`corpus manifest has no papers: ${corpusPath}`)
  }
  const manifestDir = dirname(corpusPath)
  const papers = []
  for (const paper of manifest.papers) papers.push(await evaluatePaper(paper, manifestDir))
  const validity = validityMetrics(papers)
  const pdfRows = papers.filter((paper) => paper.format === 'pdf' && paper.text_source !== 'missing')
  const conversion = {
    pdfs: papers.filter((paper) => paper.format === 'pdf').length,
    converted: pdfRows.filter((paper) => paper.text_source === 'pdf_converted').length,
    failed: papers.filter((paper) => paper.error).length,
    ocr_pages: papers.reduce((sum, paper) => sum + (paper.ocr_pages || 0), 0),
    references_masked: papers.filter((paper) => paper.references_masked).length,
    pdf_line_numbers_stripped: papers.filter((paper) => paper.pdf_line_numbers_stripped).length,
    failures: papers.filter((paper) => paper.error).map((paper) => ({ id: paper.id, path: paper.path, error: paper.error })),
  }
  const report = {
    generated_at: new Date().toISOString(),
    corpus: {
      path: corpusPath,
      papers: manifest.papers.length,
      label_source: manifest.label_source ?? manifest.papers.find((paper) => paper?.label_source)?.label_source ?? null,
      notes: manifest.notes ?? null,
    },
    conversion,
    validity,
    papers,
  }
  mkdirSync(outDir, { recursive: true })
  const stamp = report.generated_at.replace(/[-:]/g, '').replace(/\..+/, '')
  const jsonPath = join(outDir, `deep-review-validity-${stamp}.json`)
  const mdPath = join(outDir, `deep-review-validity-${stamp}.md`)
  jsonOut(jsonPath, report)
  writeFileSync(mdPath, validityMarkdown(report), 'utf8')
  return { report, jsonPath, mdPath }
}

async function main() {
  const corpus = arg('corpus', '')
  if (!corpus) {
    console.error('pass --corpus <manifest.json> (see docs/PAPERS.md for the shape)')
    process.exitCode = 1
    return
  }
  const outDir = resolve(ROOT, String(arg('out-dir', 'reports')))
  const result = await runValidityCorpus(resolve(ROOT, String(corpus)), { outDir })
  const v = result.report.validity
  console.log(`papers: ${v.papers} · evaluable ${v.evaluated} · ${v.verdict} · false-positive papers ${v.false_positive_papers.length} · determinism mismatches ${v.determinism_mismatches.length}`)
  console.log(`wrote ${result.jsonPath} and ${result.mdPath}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (hasFlag('help') || hasFlag('h')) {
    console.log([
      'usage:',
      '  node scripts/deep-review-validity-calibration.mjs --corpus <manifest.json> [--out-dir reports]',
      '',
      'The manifest is { "papers": [{ "id", "path", "format"?, "labels": { attribution, evaluator_drift, benchmark_coverage, unmeasured_trade_off } }] }.',
      'PDFs are converted with the simple text converter; no OCR is run. The report is written as Markdown and JSON.',
    ].join('\n'))
  } else {
    await main()
  }
}
