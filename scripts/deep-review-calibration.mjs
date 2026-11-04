#!/usr/bin/env node
/**
 * deep_review calibration harness — Phase 0 of docs/SCIENTISTTWO-ROADMAP.md.
 *
 * Two jobs, both offline-safe:
 *
 *   --collect  Pull real reviews and decisions from OpenReview through the
 *              `openreview` tool (network, no model call) into a sample manifest.
 *   --report   Read the stored `.dsh/deep-review/` artifacts a session already
 *              produced and report reviewer variance and agreement with those
 *              decisions. Writes into `reports/`.
 *   --validity --corpus <manifest.json>
 *              Run the four deterministic validity checks over a labeled corpus
 *              (PDFs use the simple text converter; no OCR) and report agreement,
 *              precision, recall, false alarms, false positives on well-formed
 *              papers, and determinism. Writes into `reports/`.
 *
 * Why this exists before any change to the reviewer: a review tool that both
 * guides a revision and scores it reports its own influence. ScientistTwo shows
 * the shape of the problem — its in-distribution reviewer rose across rebuttal
 * rounds while the held-out reviewer peaked early and fell, and human-authored
 * accepted papers scored *lower* on the in-loop reviewer than the system's own
 * output. So the numbers that matter here are variance (how much a second pass
 * on an unchanged manuscript disagrees with the first) and agreement against a
 * decision the tool never saw. Under-sampled sections say `not_checked` rather
 * than guessing.
 *
 * `deep_review` needs the host llm bridge, so reviews cannot be produced from a
 * bare script: run them in a session (`deep_review` then `compare`), then point
 * this harness at the workspace afterwards. It is intentionally not named
 * `test-*.mjs` — scripts/run-tests.mjs globs that prefix and CI would take the
 * network dependency personally.
 */
import {
  existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { matchPool } from '../deep-review.js'
import { runOpenReview } from '../openreview.js'
import { runValidityCorpus } from './deep-review-validity-calibration.mjs'
import { scoreCorrelation } from './calibration-metrics.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const MIN_PAIRS_FOR_VARIANCE = 3
const MIN_ROWS_FOR_AGREEMENT = 6

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  return value && !value.startsWith('--') ? value : (fallback ?? true)
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function jsonOut(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

// ── collect ───────────────────────────────────────────────────────────────

async function collect() {
  const venue = String(arg('venue', ''))
  const query = String(arg('query', ''))
  const forums = String(arg('forums', ''))
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const limit = Number(arg('limit', 10))
  const out = resolve(ROOT, String(arg('out', 'scripts/fixtures/deep-review/calibration-sample.json')))

  let candidates = forums.map((forum_id) => ({ forum_id }))
  if (!candidates.length && query) {
    const found = await runOpenReview({ action: 'search', query, venue, limit }, {})
    if (found?.error) throw new Error(`openreview search: ${found.error}`)
    candidates = (found.results || []).map((row) => ({ forum_id: row.forum_id, title: row.title }))
  }
  if (!candidates.length) {
    throw new Error('nothing to collect: pass --forums id,id or --query "term" (optionally --venue ICLR.cc/2025/Conference)')
  }

  const rows = []
  for (const candidate of candidates.slice(0, Math.max(1, limit))) {
    const detail = await runOpenReview({ action: 'reviews', forum_id: candidate.forum_id, limit: 50 }, {})
    if (detail?.error) {
      rows.push({ forum_id: candidate.forum_id, title: candidate.title ?? null, error: detail.error })
      continue
    }
    const reviews = (detail.reviews || []).filter((review) => review?.rating != null || review?.weaknesses != null)
    const ratings = reviews.map((review) => Number(review.rating)).filter(Number.isFinite)
    rows.push({
      forum_id: candidate.forum_id,
      title: detail.submission?.title ?? candidate.title ?? null,
      venue: detail.submission?.venue ?? detail.submission?.venue_id ?? null,
      url: detail.submission?.url ?? null,
      pdf: detail.submission?.pdf ?? null,
      decision: detail.decision ?? null,
      review_count: reviews.length,
      ratings,
      mean_rating: ratings.length ? Number((ratings.reduce((sum, value) => sum + value, 0) / ratings.length).toFixed(3)) : null,
      // Fill in after downloading the manuscript: sha1 of the file under review.
      manuscript_sha1: null,
      manuscript_file: null,
      weaknesses: reviews.map((review) => review.weaknesses).filter(Boolean).slice(0, 6),
    })
  }

  mkdirSync(dirname(out), { recursive: true })
  jsonOut(out, { collected_at: new Date().toISOString(), venue: venue || null, query: query || null, rows })
  const decided = rows.filter((row) => row.decision).length
  console.log(`collected ${rows.length} forum(s) (${decided} with a published decision) → ${out}`)
  console.log('next: download those PDFs into the workspace, run deep_review on each in a session, fill manuscript_sha1/manuscript_file, then re-run with --report.')
}

// ── store census ──────────────────────────────────────────────────────────

function storedRounds(root, key) {
  const dir = join(root, key)
  const meta = readJson(join(dir, 'meta.json'))
  if (!meta) return null
  const roundsDir = join(dir, 'rounds')
  const entries = Array.isArray(meta.rounds) && meta.rounds.length
    ? meta.rounds.filter(Boolean)
    : (meta.review ? [{ round: 1, run_id: meta.last_run?.run_id ?? 'legacy', finished_at: meta.review.finished_at, duration_ms: meta.last_run?.duration_ms ?? null, usage: null, counts: meta.summary ? {
      comments: meta.summary.comments?.total ?? null,
      by_severity: meta.summary.comments?.by_severity ?? {},
      questions: meta.summary.questions ?? null,
      flagged_citations: meta.summary.flagged_citations?.total ?? null,
    } : null, input_sha1: meta.input?.sha1 ?? null, params: meta.review.params ?? null }] : [])
  const details = new Map()
  for (const entry of entries) {
    const file = join(roundsDir, `${entry.run_id}.json`)
    if (existsSync(file)) details.set(entry.run_id, readJson(file))
  }
  return {
    key,
    dir,
    schema_version: meta.schemaVersion ?? null,
    path: meta.input?.path ?? null,
    file_name: meta.input?.file_name ?? null,
    sha1: meta.input?.sha1 ?? null,
    engine: meta.engine ?? null,
    score: readJson(join(dir, 'score.json')),
    actions: (() => {
      const runs = join(dir, 'runs.jsonl')
      if (!existsSync(runs)) return []
      return readFileSync(runs, 'utf8').trim().split('\n').filter(Boolean)
        .map((line) => { try { return JSON.parse(line) } catch { return null } })
        .filter(Boolean)
    })(),
    rounds: entries.map((entry) => ({ ...entry, detail: details.get(entry.run_id) ?? null })),
  }
}

function census(store) {
  const root = join(store, '.dsh', 'deep-review')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => storedRounds(root, entry.name))
    .filter(Boolean)
}

/**
 * Persisting findings between two rounds, measured with the same layered matcher
 * `deep_review action=compare` uses — over the larger of the two rounds. Using
 * exact wording alone here would report far less persistence than the tool does.
 */
function overlapOf(from, to) {
  const a = from?.comments || []
  const b = to?.comments || []
  const span = Math.max(a.length, b.length)
  if (!span) return 1
  return Number((matchPool(a, b).pairs.length / span).toFixed(3))
}

function variance(stored) {
  const pairs = []
  for (const record of stored) {
    const rounds = record.rounds.filter((round) => round.detail)
    for (let index = 1; index < rounds.length; index += 1) {
      const before = rounds[index - 1]
      const after = rounds[index]
      // Only same-bytes pairs measure the reviewer; a changed manuscript is a revision.
      if (!before.input_sha1 || before.input_sha1 !== after.input_sha1) continue
      pairs.push({
        file: record.path ?? record.file_name,
        from_round: before.round,
        to_round: after.round,
        overlap: overlapOf(before.detail, after.detail),
        comments_from: before.detail.counts?.comments ?? null,
        comments_to: after.detail.counts?.comments ?? null,
        critical_from: before.detail.counts?.by_severity?.CRITICAL ?? 0,
        critical_to: after.detail.counts?.by_severity?.CRITICAL ?? 0,
        duration_ms_from: before.duration_ms ?? null,
        duration_ms_to: after.duration_ms ?? null,
      })
    }
  }
  const overlaps = pairs.map((pair) => pair.overlap).filter(Number.isFinite)
  return {
    pairs: pairs.length,
    min_pairs_for_a_number: MIN_PAIRS_FOR_VARIANCE,
    mean_overlap: overlaps.length ? Number((overlaps.reduce((sum, value) => sum + value, 0) / overlaps.length).toFixed(3)) : null,
    detail: pairs.slice(0, 20),
    verdict: overlaps.length >= MIN_PAIRS_FOR_VARIANCE
      ? 'measured'
      : `not_checked (${overlaps.length}/${MIN_PAIRS_FOR_VARIANCE} same-manuscript round pairs stored)`,
  }
}

function agreement(stored, sample) {
  const rows = (sample?.rows || []).filter((row) => row?.decision && (row?.manuscript_sha1 || row?.manuscript_file))
  const decided = (record) => {
    const text = String(record.decision ?? '').toLowerCase()
    if (/(reject|withdraw|desk)/.test(text)) return 'reject'
    if (/(accept|poster|spotlight|oral)/.test(text)) return 'accept'
    return null
  }
  const matched = []
  for (const record of stored) {
    const latest = record.rounds.filter((round) => round.detail).at(-1)
    if (!latest) continue
    const hit = rows.find((row) => (row.manuscript_sha1 && row.manuscript_sha1 === record.sha1)
      || (row.manuscript_file && basename(String(row.manuscript_file)) === record.file_name))
    if (!hit) continue
    const bucket = decided(hit)
    if (!bucket) continue
    matched.push({
      file: record.path ?? record.file_name,
      forum_id: hit.forum_id ?? null,
      decision: hit.decision,
      bucket,
      mean_rating: hit.mean_rating ?? null,
      real_review_count: hit.review_count ?? null
      ,
      critical: latest.detail.counts?.by_severity?.CRITICAL ?? 0,
      major: latest.detail.counts?.by_severity?.MAJOR ?? 0,
      comments: latest.detail.counts?.comments ?? null,
      flagged_citations: latest.detail.counts?.flagged_citations ?? null,
      checklist_no: (latest.detail.counts?.checklist_by_status?.NO) ?? 0,
      score: Number.isFinite(Number(record.score?.overall?.score)) ? Number(record.score.overall.score) : null,
      evaluator_kind: record.score?.review?.evaluator_kind ?? record.review?.evaluator_kind ?? latest.detail?.evaluator_kind ?? null,
    })
  }
  const bucketOf = (name) => matched.filter((row) => row.bucket === name)
  const mean = (list, pick) => (list.length ? Number((list.reduce((sum, row) => sum + (pick(row) || 0), 0) / list.length).toFixed(2)) : null)
  const accepts = bucketOf('accept')
  const rejects = bucketOf('reject')
  const enough = matched.length >= MIN_ROWS_FOR_AGREEMENT && accepts.length && rejects.length
  const heldOutRows = matched.filter((row) => row.score != null && row.evaluator_kind === 'held_out')
  return {
    matched: matched.length,
    min_rows_for_a_number: MIN_ROWS_FOR_AGREEMENT,
    accepts: accepts.length,
    rejects: rejects.length,
    severity_by_bucket: enough
      ? {
          accept: { critical: mean(accepts, (row) => row.critical), major: mean(accepts, (row) => row.major), checklist_no: mean(accepts, (row) => row.checklist_no) },
          reject: { critical: mean(rejects, (row) => row.critical), major: mean(rejects, (row) => row.major), checklist_no: mean(rejects, (row) => row.checklist_no) },
        }
      : null,
    score_correlation: scoreCorrelation(matched, { min: MIN_ROWS_FOR_AGREEMENT }),
    score_correlation_held_out: scoreCorrelation(heldOutRows, { min: MIN_ROWS_FOR_AGREEMENT }),
    detail: matched.slice(0, 20),
    verdict: enough
      ? 'measured — compare against the held-out rule: a reviewer that also guided the revision is not a neutral judge'
      : `not_checked (${matched.length} stored reviews joined to a decided sample; need ${MIN_ROWS_FOR_AGREEMENT} with both classes present)`,
  }
}

function schemaNotes(stored) {
  const versions = {}
  for (const record of stored) {
    const key = String(record.schema_version ?? 'unset')
    versions[key] = (versions[key] ?? 0) + 1
  }
  return {
    meta_versions: versions,
    legacy_stores: stored.filter((record) => record.schema_version === 1).map((record) => record.path ?? record.file_name ?? record.key),
    rounds_per_store: stored.map((record) => ({ file: record.path ?? record.file_name, rounds: record.rounds.length })),
  }
}

function markdown(report) {
  const lines = [
    '# deep_review calibration',
    '',
    `Generated ${report.generated_at}. Read-only census of stored reviews; advisory measurements, not verdicts.`,
    '',
    '## Store census',
    '',
    `- stores: ${report.stores.length}; schema versions: ${Object.entries(report.schema.meta_versions).map(([key, value]) => `v${key}=${value}`).join(', ') || 'none'}`,
    `- v1 stores awaiting a round-2 upgrade: ${report.schema.legacy_stores.length ? report.schema.legacy_stores.join(', ') : 'none'}`,
    `- rounds per store: ${report.schema.rounds_per_store.map((row) => `${row.file ?? row.rounds}=${row.rounds}`).join(', ') || 'none'}`,
    '',
    '## Reviewer variance (same manuscript, consecutive rounds)',
    '',
    `- ${report.variance.verdict}`,
    `- same-bytes round pairs: ${report.variance.pairs}; mean finding overlap: ${report.variance.mean_overlap ?? 'not_checked'}`,
    '  Overlap is the share of findings `compare` would call persisting, using its own matcher. Below 1 it means a re-run on an unchanged manuscript reports different findings; that gap is the floor any "findings closed" claim has to clear.',
    '',
    '| file | rounds | overlap | comments | critical |',
    '| --- | --- | --- | --- | --- |',
    ...(report.variance.detail.length
      ? report.variance.detail.map((row) => `| ${row.file} | ${row.from_round}→${row.to_round} | ${row.overlap} | ${row.comments_from}→${row.comments_to} | ${row.critical_from}→${row.critical_to} |`)
      : ['| not_checked | — | — | — | — |']),
    '',
    '## Agreement with real decisions (held-out labels)',
    '',
    `- ${report.agreement.verdict}`,
    `- joined ${report.agreement.matched} stored review(s) to a decided sample (${report.agreement.accepts} accepted, ${report.agreement.rejects} rejected)`,
    ...(report.agreement.severity_by_bucket
      ? [
          '',
          '| bucket | mean CRITICAL | mean MAJOR | mean checklist NO |',
          '| --- | --- | --- | --- |',
          `| accepted | ${report.agreement.severity_by_bucket.accept.critical} | ${report.agreement.severity_by_bucket.accept.major} | ${report.agreement.severity_by_bucket.accept.checklist_no} |`,
          `| rejected | ${report.agreement.severity_by_bucket.reject.critical} | ${report.agreement.severity_by_bucket.reject.major} | ${report.agreement.severity_by_bucket.reject.checklist_no} |`,
        ]
      : []),
    '',
    '## Score correlation with real decisions',
    '',
    `- ${report.agreement.score_correlation.verdict}`,
    ...(report.agreement.score_correlation.scored
      ? [
          `- scored: ${report.agreement.score_correlation.scored} (${report.agreement.score_correlation.accepts} accepted, ${report.agreement.score_correlation.rejects} rejected; ${report.agreement.score_correlation.held_out} held_out, ${report.agreement.score_correlation.in_distribution} in_distribution)`,
          ...(report.agreement.score_correlation.auc != null
            ? [`- mean accepted ${report.agreement.score_correlation.mean_accept}, mean rejected ${report.agreement.score_correlation.mean_reject}; point-biserial r ${report.agreement.score_correlation.point_biserial_r}, AUC ${report.agreement.score_correlation.auc}`]
            : []),
        ]
      : ['- no stored score joined to a decided sample yet; run action "score" in a session, then re-run this report']),
    `- held-out subset: ${report.agreement.score_correlation_held_out.verdict}`,
    ...(report.agreement.score_correlation_held_out.auc != null
      ? [`- held-out: mean accepted ${report.agreement.score_correlation_held_out.mean_accept}, mean rejected ${report.agreement.score_correlation_held_out.mean_reject}; r ${report.agreement.score_correlation_held_out.point_biserial_r}, AUC ${report.agreement.score_correlation_held_out.auc}`]
      : []),
    '- A positive r/AUC means the advisory score separates accepted from rejected manuscripts in this sample. It is not a decision predictor, and the held-out subset is the honest headline when both evaluator kinds are present.',
    '',
    '## Interpretation limits',
    '',
    '- OpenReview decisions are not comparable across venues, and the sample is small by construction.',
    '- If the same reviewer rubric guided a revision, its later score is in-distribution; report the held-out reviewer as the headline number.',
    '- This harness never runs the reviewer or the score: `deep_review` needs the host llm bridge, so reviews and scores come from a session first; the harness reads the stored `score.json`.',
    '',
  ]
  return lines.join('\n')
}

async function main() {
  if (hasFlag('collect')) {
    await collect()
    return
  }
  if (hasFlag('validity')) {
    const corpus = String(arg('corpus', ''))
    if (!corpus) {
      console.error('--validity needs --corpus <manifest.json>')
      process.exitCode = 1
      return
    }
    const outDir = resolve(ROOT, String(arg('out-dir', 'reports')))
    const result = await runValidityCorpus(resolve(ROOT, corpus), { outDir })
    const v = result.report.validity
    console.log(`papers: ${v.papers} · evaluable ${v.evaluated} · ${v.verdict} · false-positive papers ${v.false_positive_papers.length} · determinism mismatches ${v.determinism_mismatches.length}`)
    console.log(`wrote ${result.jsonPath} and ${result.mdPath}`)
    return
  }
  const store = resolve(String(arg('store', process.cwd())))
  const samplePath = resolve(ROOT, String(arg('sample', 'scripts/fixtures/deep-review/calibration-sample.json')))
  const sample = existsSync(samplePath) ? readJson(samplePath) : null
  const stored = census(store)
  if (!stored.length) {
    console.error(`no stored deep reviews under ${store}/.dsh/deep-review — run deep_review in a session first, or pass --store <workspace>`)
    process.exitCode = 1
    return
  }
  const report = {
    generated_at: new Date().toISOString(),
    store,
    sample: sample ? { path: samplePath, rows: (sample.rows || []).length, decided: (sample.rows || []).filter((row) => row.decision).length } : { path: samplePath, rows: 0, decided: 0, note: 'no manifest; run --collect' },
    schema: schemaNotes(stored),
    variance: variance(stored),
    agreement: agreement(stored, sample),
    stores: stored.map((record) => ({
      key: record.key,
      file: record.path,
      sha1: record.sha1,
      schema_version: record.schema_version,
      rounds: record.rounds.length,
      engine: record.engine?.model ?? null,
      runs: record.actions.map((run) => `${run.action}:${run.state}`),
    })),
  }
  const outDir = resolve(ROOT, String(arg('out-dir', 'reports')))
  mkdirSync(outDir, { recursive: true })
  const stamp = report.generated_at.replace(/[-:]/g, '').replace(/\..+/, '')
  const jsonPath = join(outDir, `deep-review-calibration-${stamp}.json`)
  const mdPath = join(outDir, `deep-review-calibration-${stamp}.md`)
  jsonOut(jsonPath, report)
  writeFileSync(mdPath, markdown(report), 'utf8')
  console.log(`stores: ${report.stores.length} · variance ${report.variance.verdict} · agreement ${report.agreement.verdict}`)
  console.log(`wrote ${jsonPath} and ${mdPath}`)
}

if (hasFlag('help')) {
  console.log([
    'usage:',
    '  node scripts/deep-review-calibration.mjs --collect [--forums id,id | --query "term" [--venue ICLR.cc/2025/Conference]] [--limit N] [--out <manifest>]',
    '  node scripts/deep-review-calibration.mjs --validity --corpus <manifest.json> [--out-dir reports]',
    '  node scripts/deep-review-calibration.mjs [--store <workspace>] [--sample <manifest>] [--out-dir reports]',
    '',
    'collect needs network (OpenReview). report is offline over artifacts a session already stored.',
    'validity is offline; PDFs use the simple text converter and no OCR is run.',
    'deep_review itself cannot run here: it needs the host llm bridge, so review in a session first.',
  ].join('\n'))
} else {
  await main()
}
