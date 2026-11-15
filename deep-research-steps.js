/**
 * deep_research step engine.
 *
 * Drives the pipeline the way hyperresearch proved it works — one step per
 * phase, each loading its procedure only when it runs — but through the host's
 * own model route instead of a subprocess, so there is no second runtime and no
 * second source of truth about which model is answering.
 *
 * Division of labour, and it is the whole point of the split:
 *   - the **model** proposes: perspectives, loci, positions, drafts, critiques;
 *   - the **tool** executes retrieval, mints ids, clusters for independence,
 *     fences fetched text, accounts for spend, applies capped hunks, and decides
 *     whether a report may ship;
 *   - the **human** reads the report and the disclosed gaps.
 *
 * Retrieval and verification arrive as `deps`, so a run is reproducible in a
 * test with no network and no model.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEPTH, REGISTERS, TIERS, appendClaims, appendFindings, appendRecords, applyHunks,
  budgetState, findingIsCurrent, markFindingApplied, markStep, readArtifact, readCorpus, readFindings,
  readManifest, readQuery, readRetrievalByRecord, readRun, recordUsage, recordVerdict, stepView, supersedeFindings, writeArtifact,
} from './deep-research-store.js'
import { normalizeDoi } from './independence-cluster.js'
import { UNTRUSTED_RULE, fenceMany } from './untrusted-fence.js'

export const STEP_IDS = [
  'decompose', 'chapters', 'sweep', 'contradictions', 'loci', 'depth', 'reconcile',
  'tensions', 'corpus_critic', 'digest', 'draft', 'synthesize', 'critics', 'gap_fetch',
  'patcher', 'cite_check', 'polish', 'readability',
]

/** Which steps each tier runs. `light` is the bounded factual path. */
export const TIER_PLANS = {
  light: ['decompose', 'sweep', 'draft', 'cite_check', 'polish'],
  full: STEP_IDS.filter((id) => id !== 'chapters'),
  dissertation: STEP_IDS,
}

/** Gears set scale, not method. Verification is identical in every gear. */
export const GEARS = {
  scout: { label: 'scout', perspectives: 3, sources_per_perspective: 25, max_loci: 3, max_depth: 3, drafts: 1 },
  standard: { label: 'standard', perspectives: 5, sources_per_perspective: 40, max_loci: 5, max_depth: 5, drafts: 3 },
  premier: { label: 'premier', perspectives: 7, sources_per_perspective: 60, max_loci: 8, max_depth: 8, drafts: 3 },
}

export const MAX_CONCURRENCY = 4

const STEP_META = {
  decompose: { name: 'Decompose', owner: 'model' },
  chapters: { name: 'Chapter partition', owner: 'model' },
  sweep: { name: 'Width sweep', owner: 'model+retrieval' },
  contradictions: { name: 'Contradiction graph', owner: 'model' },
  loci: { name: 'Loci analysis', owner: 'model' },
  depth: { name: 'Depth investigation', owner: 'model' },
  reconcile: { name: 'Cross-locus reconcile', owner: 'model' },
  tensions: { name: 'Source tensions', owner: 'model' },
  corpus_critic: { name: 'Corpus critic', owner: 'model+retrieval' },
  digest: { name: 'Evidence digest', owner: 'model+verifier' },
  draft: { name: 'Draft', owner: 'model' },
  synthesize: { name: 'Synthesize', owner: 'model' },
  critics: { name: 'Adversarial critics', owner: 'model' },
  gap_fetch: { name: 'Gap fetch', owner: 'retrieval' },
  patcher: { name: 'Patcher', owner: 'model+store' },
  cite_check: { name: 'Cite check', owner: 'model+verifier' },
  polish: { name: 'Polish', owner: 'model+store' },
  readability: { name: 'Readability audit', owner: 'model' },
}

export function planFor(tier, gear = 'standard') {
  if (!TIERS.includes(tier)) throw new Error(`tier must be one of ${TIERS.join(', ')}`)
  if (!GEARS[gear]) throw new Error(`gear must be one of ${Object.keys(GEARS).join(', ')}`)
  const ids = TIER_PLANS[tier]
  if (!ids) throw new Error(`no plan for tier ${tier}`)
  return ids.map((id) => ({ id, name: STEP_META[id].name, owner: STEP_META[id].owner }))
}

/**
 * JSON out of a model that was told to emit JSON.
 *
 * Fences, prose preambles, and trailing commas are the normal failure modes;
 * a repair attempt is cheaper than a retry, and the fallback keeps a bad turn
 * from crashing a two-hour run.
 */
export function parseJsonResponse(text, fallback = null) {
  const raw = String(text ?? '').trim()
  if (!raw) return fallback
  const unfenced = raw.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  try {
    return JSON.parse(unfenced)
  } catch { /* fall through to the brace slice */ }
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(unfenced.slice(start, end + 1))
    } catch { /* fall through */ }
  }
  const openArray = unfenced.indexOf('[')
  const closeArray = unfenced.lastIndexOf(']')
  if (openArray >= 0 && closeArray > openArray) {
    try {
      return JSON.parse(unfenced.slice(openArray, closeArray + 1))
    } catch { /* fall through */ }
  }
  return fallback
}

/**
 * The host's llm service takes message content as text blocks, not bare
 * strings (see `toLlmMessages` in deep-review.js). Steps build plain strings for
 * readability, so the boundary normalises them here.
 */
function toTextBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return [{ type: 'text', text: String(content ?? '') }]
  return content.map((part) => (typeof part === 'string'
    ? { type: 'text', text: part }
    : { type: 'text', text: typeof part?.text === 'string' ? part.text : '' }))
    .filter((part) => part.text)
}

/**
 * The model driver. One place that talks to the route, so spend, cancellation,
 * and the shape of a failure are decided once.
 *
 * `onEvent` exists because a multi-minute step that says nothing looks broken.
 * Every call announces itself before it starts and reports tokens when it
 * lands, so the jobs panel shows work happening rather than a silent spinner.
 */
export function createLlmRunner({ ctx, route, signal = null, runId = null, cwd = null, onEvent = null }) {
  return async function llm({ system, messages, json = false, temperature = undefined, maxTokens = undefined, step = null }) {
    const controller = new AbortController()
    if (signal) {
      if (signal.aborted) controller.abort('cancelled')
      else signal.addEventListener('abort', () => controller.abort(signal.reason ?? 'cancelled'), { once: true })
    }
    const payload = {
      provider: route.provider,
      model: route.model,
      system: json ? `${system}\nReply with one JSON object and nothing else.` : system,
      messages: (Array.isArray(messages) ? messages : []).map((message) => ({
        role: message?.role === 'assistant' ? 'user' : (message?.role ?? 'user'),
        content: toTextBlocks(message?.content),
      })),
      signal: controller.signal,
    }
    if (Number.isFinite(temperature)) payload.temperature = temperature
    if (Number.isFinite(maxTokens)) payload.maxTokens = maxTokens

    const startedAt = Date.now()
    const notify = typeof onEvent === 'function' ? onEvent : () => {}
    const chars = (String(system ?? '').length + JSON.stringify(messages ?? []).length)
    notify({ type: 'request', step, model: route.model, provider: route.provider, prompt_chars: chars })

    let text = ''
    let usage = null
    let reason = null
    try {
      for await (const chunk of ctx.llm.stream(payload)) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (chunk?.type === 'usage') usage = chunk.usage ?? null
        else if (chunk?.type === 'finish') reason = chunk.reason ?? null
      }
    } catch (error) {
      notify({ type: 'error', step, model: route.model, message: error instanceof Error ? error.message : String(error), ms: Date.now() - startedAt })
      throw error
    }
    const ms = Date.now() - startedAt
    if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) {
      // Carrying the host's failure detail is the difference between a run that
      // can be diagnosed and one that just says "error".
      const detail = reason.failure?.message ?? reason.failure ?? reason.message ?? reason.kind
      notify({ type: 'error', step, model: route.model, message: String(detail), ms })
      throw new Error(`deep research model call ${reason.kind}: ${String(detail).slice(0, 300)}`)
    }
    notify({
      type: 'response', step, model: route.model, ms,
      input_tokens: usage?.inputTokens ?? null,
      output_tokens: usage?.outputTokens ?? null,
      completion_chars: text.length,
    })
    if (cwd && runId) {
      await recordUsage({
        cwd, runId, llmCalls: 1,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        step,
      })
    }
    return { text, json: json ? parseJsonResponse(text, null) : null, usage, reason }
  }
}

async function gather(tasks, limit = MAX_CONCURRENCY) {
  const results = new Array(tasks.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor
      cursor += 1
      try {
        results[index] = { ok: true, value: await tasks[index]() }
      } catch (error) {
        results[index] = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
  await Promise.all(workers)
  return results
}

function briefBlock(manifest) {
  const questions = manifest.brief.research_questions.map((rq) => `- ${rq.rq_id}: ${rq.text}`).join('\n')
  return [
    `Canonical query (verbatim, not to be paraphrased): ${manifest.query.chars} chars, ${manifest.query.hash.slice(0, 18)}…`,
    `Topic: ${manifest.brief.topic}`,
    `Research questions:\n${questions}`,
    manifest.brief.angle ? `Angle: ${manifest.brief.angle}` : null,
    manifest.brief.reader ? `Intended reader: ${manifest.brief.reader}` : null,
    `Register: ${manifest.brief.register}`,
    `Depth: ${manifest.brief.inference_depth}`,
    manifest.brief.domain_notes ? `Domain notes: ${manifest.brief.domain_notes}` : null,
    `Tier: ${manifest.tier} · Gear: ${manifest.gear}`,
  ].filter(Boolean).join('\n')
}

function registerVoice(register) {
  if (register === 'survey') return 'Represent every school on its own terms and do not force a single verdict. Write that as survey prose.'
  if (register === 'teach') return 'Write a pedagogical explainer; sequence concepts so each one rests only on the ones before it.'
  if (register === 'advocate') return 'Defend one named thesis; state the strongest objection to it and answer it.'
  return 'Build an evaluative argument; let the conclusion follow the evidence.'
}

/**
 * The reader-facing report. Research-question ids, locus notes, the ship
 * gate, and the corpus index stay in the run; they are how the report is
 * written, not the report.
 */
function researchReportContract() {
  return [
    'Write the final report as a research survey in Markdown that a reader can read from top to bottom.',
    'Shape: a title that names the topic and the angle; an abstract; a numbered introduction that states the research questions in prose; a short account of how the literature was examined; thematic sections that compare sources inside sentences; a section on disagreements and the conditions that produce them; open problems; and a conclusion that answers each research question in its own paragraph.',
    'Close with a References heading that lists only works cited in the body, one line each, keeping the same [src-] ids used inline.',
    'Cite the [src-] ids printed in the material and copy them exactly. Do not renumber a source, and do not copy a claim number into a source id: cl-0041 is a claim, never [src-0041]. A cluster id such as c0004 names a group of copies and is never a citation.',
    'When a source is marked full text, the fenced paper is what you may use. When it is marked abstract only, use only that abstract: do not state methods, tables, or results the abstract does not contain. A title-only source supports no factual claim about its contents. Do not paste the source-access list into the report.',
    'The evidence map, research-question ids, locus ids, ship gate, and corpus index are private working notes. Do not publish them. Do not title the report an evidence map, do not write "How to read this map" or "Boundaries of this map", and do not use rq- ids or locus ids as headings.',
    'Keep disagreements visible with the conditions that produce them. Do not average them into one number.',
    'Do not append a verification section, a ship-gate ledger, or a dump of the corpus.',
  ].join(' ')
}

/** True when the text is the internal gateway, not a survey a reader would read. */
export function looksLikeGatewayMap(text) {
  const body = String(text ?? '')
  const heading = body.split('\n').find((line) => /^#\s+\S/u.test(line)) ?? ''
  if (/evidence map/iu.test(heading)) return true
  if (/how to read this map/iu.test(body)) return true
  if (/boundaries of this map/iu.test(body)) return true
  if (/^#{1,3}\s+(?:\d+\.\s*)?rq-\d+\b/imu.test(body)) return true
  if (/^# Verification\s*$/mu.test(body) || /^Ship gate:/mu.test(body)) return true
  return false
}

function stripGatewayTail(text) {
  return String(text ?? '')
    .replace(/\n+#{1,3} Verification\b[\s\S]*$/iu, '')
    .replace(/\n+Ship gate:[\s\S]*$/iu, '')
    .trimEnd()
}

/** Citation audit reads the argument, not the bibliography that repeats its ids. */
function proseForCitation(text) {
  return String(text ?? '').replace(/\n#{1,3} References\b[\s\S]*$/iu, '\n')
}

function bibliographyFor(text, records) {
  const byId = new Map((records ?? []).map((record) => [record.record_id, record]))
  const ids = []
  const seen = new Set()
  for (const match of String(text ?? '').matchAll(/\[(src-[a-z0-9-]+)\]/giu)) {
    const id = match[1].toLowerCase()
    if (seen.has(id) || !byId.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  if (!ids.length) return ''
  const lines = ids.map((id) => {
    const record = byId.get(id)
    const year = record.year ? ` ${record.year}.` : ''
    const doi = record.doi ? ` doi:${record.doi}.` : ''
    return `- [${id}] ${String(record.title ?? 'Untitled').replace(/\s+/gu, ' ').trim()}.${year}${doi}`.replace(/\s+\./gu, '.').trim()
  })
  return ['', '## References', '', ...lines, ''].join('\n')
}

/** The model's References blurbs are not the corpus. The tool writes the list. */
function withCorpusBibliography(text, records) {
  const prose = proseForCitation(text).trimEnd()
  return `${prose}${bibliographyFor(prose, records)}`
}

/**
 * Reader-facing source numbers start at src-0001 for this report, in the
 * order the works are first cited. The index remembers which corpus record
 * each displayed id is, so a later cite check still opens the right paper.
 */
function compactCitedSources(text, records) {
  const byId = new Map((records ?? []).map((record) => [record.record_id, record]))
  const prose = proseForCitation(text).trimEnd()
  const corpusToDisplay = new Map()
  for (const match of prose.matchAll(/\[(src-[a-z0-9-]+)\]/giu)) {
    const id = match[1].toLowerCase()
    if (!byId.has(id) || corpusToDisplay.has(id)) continue
    corpusToDisplay.set(id, `src-${String(corpusToDisplay.size + 1).padStart(4, '0')}`)
  }
  // One pass over the original text. A later corpus id must not be rewritten
  // again just because an earlier source was displayed as that same number.
  const renumbered = prose.replace(/\[(src-[a-z0-9-]+)\]/giu, (whole, id) => {
    const display = corpusToDisplay.get(id.toLowerCase())
    return display ? `[${display}]` : whole
  })
  const displayToCorpus = {}
  for (const [corpusId, display] of corpusToDisplay) displayToCorpus[display] = corpusId
  const body = `${renumbered}${bibliographyFor(renumbered, [...corpusToDisplay].map(([corpusId, display]) => {
    const record = byId.get(corpusId)
    return { ...record, record_id: display }
  }))}`
  return { text: `${body.trimEnd()}\n`, index: { display_to_corpus: displayToCorpus } }
}

function expandCitedSources(text, index) {
  const map = index?.display_to_corpus ?? {}
  if (!Object.keys(map).length) return String(text ?? '')
  return String(text ?? '').replace(/\[(src-[a-z0-9-]+)\]/giu, (whole, id) => (map[id.toLowerCase()] ? `[${map[id.toLowerCase()]}]` : whole))
}

/** Order of src- brackets, so a prose edit can be told from a renumber. */
function citationBracketKey(text) {
  return [...String(text ?? '').matchAll(/\[(src-[a-z0-9-]+)\]/giu)].map((match) => match[1].toLowerCase()).join('|')
}

function readCitationIndex(cwd, runId) {
  const artifact = readArtifact({ cwd, runId, name: 'citation-index' })
  if (!artifact?.text.trim()) return null
  try {
    const parsed = JSON.parse(artifact.text)
    const map = parsed?.display_to_corpus
    if (!map || typeof map !== 'object' || Array.isArray(map)) return null
    return {
      space: parsed.space === 'display' ? 'display' : 'corpus',
      bracket_key: typeof parsed.bracket_key === 'string' ? parsed.bracket_key : '',
      display_to_corpus: map,
    }
  } catch {
    return null
  }
}

function sentenceAt(text, index) {
  const body = String(text ?? '')
  const before = body.slice(0, index)
  const start = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('. '))
  const after = body.slice(index)
  const rel = after.search(/[.\n]/u)
  const end = rel < 0 ? body.length : index + rel + 1
  return body.slice(start < 0 ? 0 : start + 1, end)
}

/** Six consecutive words, so a shared topic word is not treated as the same claim. */
function sharesClaimText(sentence, claimText) {
  const claim = String(claimText ?? '').replace(/\[[^\]]*\]/gu, ' ').replace(/\s+/gu, ' ').trim().toLowerCase()
  const host = String(sentence ?? '').replace(/\[[^\]]*\]/gu, ' ').replace(/\s+/gu, ' ').trim().toLowerCase()
  if (claim.length < 40) return false
  const words = claim.split(' ').filter(Boolean)
  if (words.length < 6) return host.includes(claim)
  for (let i = 0; i <= words.length - 6; i += 1) {
    if (host.includes(words.slice(i, i + 6).join(' '))) return true
  }
  return false
}

/**
 * A claim label is not a paper. [cl-0041] becomes that claim's records.
 * [src-0041] is repaired the same way only when the sentence is that claim
 * and cl-0041 cites different records — the copy that produced src-0041 on a
 * new topic whose corpus already started at src-0001.
 */
function repairClaimSerialCitations(text, claims, records) {
  const byClaim = new Map((claims ?? []).map((claim) => [String(claim.claim_id ?? '').toLowerCase(), claim]))
  return String(text ?? '').replace(/\[((?:cl|src)-(\d+))\]/giu, (whole, id, digits, offset, source) => {
    const claim = byClaim.get(`cl-${digits}`)
    if (!claim) return whole
    const sources = sourceIdsFor(claim.record_ids, records)
    if (!sources.length) return whole
    const normalized = id.toLowerCase()
    if (normalized.startsWith('src-') && sources.includes(normalized)) return whole
    if (normalized.startsWith('src-') && !sharesClaimText(sentenceAt(source, offset), claim.text)) return whole
    return sources.map((recordId) => `[${recordId}]`).join(' ')
  })
}

/**
 * Cite-check audits corpus ids. A finished report stores reader ids, so a
 * rerun expands only when the bracket sequence still matches the index.
 * A mismatch means the report is already in corpus space (or a crash left
 * the two out of step) and must not be expanded a second time.
 */
async function expandReaderCitations({ cwd, runId, report }) {
  const index = readCitationIndex(cwd, runId)
  const map = index?.display_to_corpus ?? {}
  if (index?.space !== 'display' || !Object.keys(map).length) return report
  if (index.bracket_key !== citationBracketKey(report.text)) return report
  const expanded = expandCitedSources(report.text, index)
  if (expanded === report.text) return report
  await writeArtifact({ cwd, runId, name: 'final_report', step: 'cite_check', overwrite: true, mechanical: true, body: expanded })
  return readArtifact({ cwd, runId, name: 'final_report' })
}

async function publishReaderCitations({ cwd, runId, report, records }) {
  const compacted = compactCitedSources(report.text, records)
  const map = compacted.index.display_to_corpus
  if (!Object.keys(map).length) return report
  // Write the index before the report. If the process dies between the two,
  // the bracket key will not match the corpus-id report and the next check
  // will not expand it.
  await writeArtifact({
    cwd, runId, name: 'citation-index', step: 'cite_check', overwrite: true,
    body: `${JSON.stringify({ space: 'display', bracket_key: citationBracketKey(compacted.text), display_to_corpus: map }, null, 2)}\n`,
  })
  if (compacted.text === report.text) return report
  await writeArtifact({ cwd, runId, name: 'final_report', step: 'cite_check', overwrite: true, mechanical: true, body: compacted.text })
  return readArtifact({ cwd, runId, name: 'final_report' })
}

/** Polish may edit prose around a citation. Keep the index pointed at those brackets. */
async function refreshReaderCitationKey({ cwd, runId }) {
  const index = readCitationIndex(cwd, runId)
  if (index?.space !== 'display') return
  const report = readArtifact({ cwd, runId, name: 'final_report' })
  if (!report) return
  const key = citationBracketKey(report.text)
  if (key === index.bracket_key) return
  const ids = key ? key.split('|') : []
  if (!ids.length || ids.some((id) => !index.display_to_corpus[id])) return
  await writeArtifact({
    cwd, runId, name: 'citation-index', step: 'polish', overwrite: true,
    body: `${JSON.stringify({ space: 'display', bracket_key: key, display_to_corpus: index.display_to_corpus }, null, 2)}\n`,
  })
}

function clusterIndex(records) {
  const byCluster = new Map()
  for (const record of records ?? []) {
    if (record.cluster_id && !byCluster.has(record.cluster_id)) byCluster.set(record.cluster_id, record)
  }
  return byCluster
}

/** A writer should see a paper id. A cluster id becomes its representative record. */
function sourceIdsFor(ids, records) {
  const known = new Set((records ?? []).map((record) => record.record_id))
  const clusters = clusterIndex(records)
  const out = []
  for (const raw of ids ?? []) {
    const id = String(raw ?? '')
    const resolved = known.has(id) ? id : clusters.get(id.toLowerCase())?.record_id
    if (resolved && !out.includes(resolved)) out.push(resolved)
  }
  return out
}

function buildEvidenceMap({ manifest, contradictions, tensions, comparisons, digest, drafts, reading }) {
  const questions = (manifest?.brief?.research_questions ?? []).map((rq) => `- ${rq.rq_id}: ${rq.text}`).join('\n')
  return [
    '# Internal evidence map',
    '',
    'Gateway notes for writing the research report. This file is not the deliverable. The reader-facing result is the research report in final-report.md.',
    '',
    '## Research questions',
    questions || '_none recorded_',
    '',
    '## Contradictions',
    contradictions || '_none recorded_',
    '',
    '## Source tensions',
    tensions || '_none recorded_',
    '',
    '## Comparisons',
    comparisons || '_none recorded_',
    '',
    '## Evidence digest',
    digest || '_none recorded_',
    '',
    '## What was read',
    reading || '_none recorded_',
    '',
    '## Draft prose',
    drafts || '_none recorded_',
  ].join('\n')
}

function corpusDigest(records, { perRecord = 220, limit = 60, includeBody = [], perBodyChars = 1600 } = {}) {
  const bodyById = new Map(includeBody.map((entry) => [entry.record_id, entry.body]))
  return records.slice(0, limit).map((record) => {
    const body = bodyById.get(record.record_id)
    const access = body ? 'full text' : (String(record.abstract ?? '').trim() ? 'abstract only' : 'title only')
    const head = `[${record.record_id}] ${record.title} (${record.source}${record.year ? `, ${record.year}` : ''}${record.doi ? `, doi:${record.doi}` : ''}${record.independent === false ? `, cluster ${record.cluster_id}` : ''}; ${access})`
    const note = String(record.abstract ?? '').replace(/\s+/gu, ' ').slice(0, perRecord)
    const fenced = body ? `\n${fenceMany([{ record_id: record.record_id, source: record.source, body }], { perBodyChars }).text}` : ''
    return `${head}\n  ${note || 'no abstract'}${fenced}`
  }).join('\n\n')
}

const ACCESS_LIMIT = 'A source marked full text supports the fenced paper. A source marked abstract only supports only what its abstract states. A title-only source supports no factual claim about its contents.'

/** Body already stored for this run, including one the user supplied. */
function readStoredBody(cwd, runId, recordId) {
  const dir = join(cwd, '.dsh', 'deep-research', runId, 'bodies')
  const file = join(dir, `${recordId}.md`)
  if (!existsSync(file)) return null
  const body = readFileSync(file, 'utf8')
  if (!body.trim()) return null
  let meta = {}
  try { meta = JSON.parse(readFileSync(join(dir, `${recordId}.meta.json`), 'utf8')) } catch { /* legacy body */ }
  return {
    body,
    chars: body.length,
    truncated: Boolean(meta.truncated),
    supplied_by: meta.supplied_by ?? null,
    resolver: meta.resolver ?? null,
  }
}

/**
 * Read stored papers first. Download only the records that have no body yet,
 * and skip the call entirely when every record is already on disk.
 */
async function textsFor(cwd, runId, records, deps) {
  const out = []
  const missing = []
  for (const record of records ?? []) {
    if (!record?.record_id) continue
    const stored = readStoredBody(cwd, runId, record.record_id)
    if (stored) out.push({ record_id: record.record_id, source: record.source, body: stored.body, truncated: stored.truncated, supplied_by: stored.supplied_by })
    else missing.push(record)
  }
  if (missing.length && typeof deps?.fetch === 'function') {
    const fetched = await deps.fetch(missing)
    for (const entry of fetched ?? []) {
      if (entry?.body && entry.record_id) out.push(entry)
    }
  }
  return out
}

function pendingSuppliedRecords(cwd, runId) {
  const artifact = readArtifact({ cwd, runId, name: 'supplied-text' })
  if (!artifact?.text.trim()) return []
  try {
    const parsed = JSON.parse(artifact.text)
    return Array.isArray(parsed?.pending) ? parsed.pending.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

async function clearSuppliedPending(cwd, runId) {
  if (!pendingSuppliedRecords(cwd, runId).length) return
  await writeArtifact({
    cwd, runId, name: 'supplied-text', step: 'supply', overwrite: true,
    body: `${JSON.stringify({ pending: [], note: 'user supplied full text' }, null, 2)}\n`,
  })
}

/** Reader id, corpus id, or DOI. A reader id wins when the report is in display space. */
export function resolveSourceRecord(cwd, runId, raw) {
  const id = String(raw ?? '').trim()
  if (!id) throw new Error('record_id is required')
  const corpus = readCorpus(cwd, runId)
  const byId = new Map(corpus.records.map((record) => [record.record_id, record]))
  const index = readCitationIndex(cwd, runId)
  const key = id.toLowerCase()
  if (index?.space === 'display' && index.display_to_corpus[key] && byId.has(index.display_to_corpus[key])) {
    return byId.get(index.display_to_corpus[key])
  }
  if (byId.has(key)) return byId.get(key)
  const doi = normalizeDoi(id)
  if (doi) {
    const match = corpus.records.find((record) => normalizeDoi(record.doi) === doi)
    if (match) return match
  }
  throw new Error(`no source ${id} in ${runId}`)
}

function accessDetail({ record, stored, row, fetchRequested }) {
  if (stored) {
    const chars = `${stored.chars} characters${stored.truncated ? ', truncated' : ''}`
    if (stored.supplied_by === 'user') return `Supplied by you, ${chars}.`
    return `Downloaded${stored.resolver ? ` (${stored.resolver})` : ''}, ${chars}.`
  }
  const reason = row && row.ok === false && row.reason ? String(row.reason) : null
  const abstract = String(record.abstract ?? '').trim()
  if (abstract) {
    if (reason) return `No open-access PDF (${reason}). The report uses the abstract.`
    if (!fetchRequested) return 'Full text was not requested. The report uses the abstract.'
    return 'No full text stored. The report uses the abstract.'
  }
  if (reason) return `No abstract and no open-access PDF (${reason}).`
  if (!fetchRequested) return 'No abstract was available, and full text was not requested.'
  return 'No abstract and no full text stored.'
}

/**
 * User-facing list of cited papers only. Reader ids match the report.
 * The file states what was read. It does not include the paper text.
 */
export async function writeSourceAccess({ cwd, runId }) {
  const report = readArtifact({ cwd, runId, name: 'final_report' })
  if (!report?.text.trim()) return null
  const corpus = readCorpus(cwd, runId)
  const index = readCitationIndex(cwd, runId)
  const byId = new Map(corpus.records.map((record) => [record.record_id, record]))
  const map = index?.display_to_corpus ?? {}
  const displaySpace = index?.space === 'display' && Object.keys(map).length > 0
  const seen = new Set()
  const cited = []
  for (const match of proseForCitation(report.text).matchAll(/\[(src-[a-z0-9-]+)\]/giu)) {
    const token = match[1].toLowerCase()
    if (seen.has(token)) continue
    seen.add(token)
    const corpusId = displaySpace && map[token] ? map[token] : token
    const record = byId.get(corpusId)
    if (!record) continue
    cited.push({ displayId: displaySpace && map[token] ? token : record.record_id, record })
  }
  const fetchRequested = Boolean(readManifest(cwd, runId)?.execution?.fetch_full_text)
  const retrieval = readRetrievalByRecord(cwd, runId)
  const groups = { full: [], abstract: [], title: [] }
  for (const entry of cited) {
    const stored = readStoredBody(cwd, runId, entry.record.record_id)
    const detail = accessDetail({
      record: entry.record, stored, row: retrieval.get(entry.record.record_id), fetchRequested,
    })
    const year = entry.record.year ? ` ${entry.record.year}.` : ''
    const doi = entry.record.doi ? ` doi:${entry.record.doi}.` : ''
    const title = String(entry.record.title ?? 'Untitled').replace(/\s+/gu, ' ').trim() || 'Untitled'
    const line = `- [${entry.displayId}] ${title}.${year}${doi} ${detail}`.replace(/\s+\./gu, '.').trim()
    groups[stored ? 'full' : (String(entry.record.abstract ?? '').trim() ? 'abstract' : 'title')].push(line)
  }
  const intro = !fetchRequested && !groups.full.length
    ? 'Full text was not requested for this run. Each cited source was used from its abstract or its title. To read a paper in full, give deep_research action supply a PDF or markdown file for that source. The report is then rewritten from that text.'
    : 'Open-access papers are downloaded and converted from PDF to markdown when a copy can be retrieved. A paper with no open copy is used only at the depth of the text on hand (its abstract, or its title). To go further, give deep_research action supply a PDF or markdown file for that source. The report is then rewritten from that text.'
  const sections = ['# Source access', '', intro, '']
  if (!cited.length) sections.push('No cited source was found in the report.', '')
  if (groups.full.length) sections.push('## Read in full', '', ...groups.full, '')
  if (groups.abstract.length) sections.push('## Abstract only', '', ...groups.abstract, '')
  if (groups.title.length) sections.push('## Title only', '', ...groups.title, '')
  return writeArtifact({
    cwd, runId, name: 'source-access', step: 'cite_check', overwrite: true,
    body: `${sections.join('\n').trimEnd()}\n`,
  })
}

function loadBearingRecords(cwd, runId, records) {
  const byId = new Map((records ?? []).map((record) => [record.record_id, record]))
  const out = []
  const seen = new Set()
  for (const claim of readRun(cwd, runId)?.claims ?? []) {
    for (const id of sourceIdsFor(claim.record_ids, records)) {
      if (seen.has(id) || !byId.has(id)) continue
      seen.add(id)
      out.push(byId.get(id))
      if (out.length >= 24) return out
    }
  }
  return out
}

function clipTitle(value, max = 46) {
  const raw = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return raw.length > max ? `${raw.slice(0, max)}…` : raw
}

/**
 * Rank the corpus for a draft that has no digest: most-cited first, then the
 * order retrieved. Ties keep retrieval order so the result is deterministic.
 */
/** Record ids that actually appear in supplied material. Used to constrain synthesis to real citations. */
function allowedRecordIds(...texts) {
  const ids = new Set()
  for (const text of texts) {
    for (const match of String(text ?? '').matchAll(/\[(src-[a-z0-9-]+)\]/gu)) ids.add(match[1])
  }
  return [...ids]
}

function rankRecords(records, limit = 60) {
  return [...records]
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const ca = Number.isFinite(Number(a.record.citation_count)) ? Number(a.record.citation_count) : -1
      const cb = Number.isFinite(Number(b.record.citation_count)) ? Number(b.record.citation_count) : -1
      if (ca !== cb) return cb - ca
      return a.index - b.index
    })
    .slice(0, limit)
    .map((entry) => entry.record)
}

function requireJson(reply, step) {
  if (reply.json && typeof reply.json === 'object') return reply.json
  throw new Error(`${step} returned no parseable JSON`)
}

const STEP_RUNNERS = {
  // 1 — atomic items, coverage matrix, and the routing this run will follow.
  async decompose({ cwd, runId, manifest, llm }) {
    const reply = await llm({
      step: 'decompose',
      system: [
        'You decompose a research request into atomic, answerable items before anything is searched.',
        'Return JSON: {"atomic_items":[{"item","rq_id","kind":"factual|comparative|evaluative"}],"coverage_axes":[str],"tier":"light|full","register":"teach|survey|analyze|advocate","inference_depth":"surface|standard|deep","adversarial_queries":[str]}',
        'A tier is chosen from how much is genuinely at stake in the question, never from how long the prompt is. `light` is for bounded factual lookups and surveys; `full` for anything where the answer is contested.',
        'Adversarial queries are the searches most likely to refute the thesis, not to confirm it.',
        registerVoice(manifest.brief.register),
      ].join(' '),
      messages: [{ role: 'user', content: [`Research request:\n${readQuery(cwd, runId)}`, '', briefBlock(manifest)].join('\n') }],
      json: true,
    })
    const json = requireJson(reply, 'decompose')
    const items = (Array.isArray(json.atomic_items) ? json.atomic_items : []).map((item) => ({
      item: String(item?.item ?? '').trim(),
      rq_id: String(item?.rq_id ?? '').trim() || null,
      kind: ['factual', 'comparative', 'evaluative'].includes(item?.kind) ? item.kind : 'factual',
    })).filter((item) => item.item)
    if (!items.length) throw new Error('decompose produced no atomic items')
    const known = new Set(manifest.brief.research_questions.map((rq) => rq.rq_id))
    const orphan = items.filter((item) => item.rq_id && !known.has(item.rq_id)).map((item) => item.rq_id)
    const tier = TIERS.includes(json.tier) ? json.tier : null
    const artifact = [
      '# Atomic items and coverage', '',
      ...items.map((item) => `- ${item.item}${item.rq_id ? ` [${item.rq_id}]` : ' [no rq]'} · ${item.kind}`),
      '', '## Coverage axes', ...(json.coverage_axes ?? []).map((axis) => `- ${axis}`),
      '', '## Adversarial queries', ...(json.adversarial_queries ?? []).map((query) => `- ${query}`),
      '', `Suggested tier: ${tier ?? 'unchanged'}`,
      `Suggested register: ${REGISTERS.includes(json.register) ? json.register : manifest.brief.register}`,
      `Suggested depth: ${DEPTH.includes(json.inference_depth) ? json.inference_depth : manifest.brief.inference_depth}`,
    ].join('\n')
    const written = await writeArtifact({ cwd, runId, name: 'coverage_matrix', step: 'decompose', body: artifact, overwrite: true })
    return {
      artifact: written,
      summary: { items: items.length, axes: (json.coverage_axes ?? []).length, tier_suggestion: tier, orphan_rq_ids: orphan },
      // A suggestion never silently reroutes a dissertation-tier run.
      verdict: tier && tier !== manifest.tier
        ? { gate: 'tier_routing', status: 'flagged', reason: `model suggested ${tier} for a ${manifest.tier} run; plan unchanged`, route: 'accept or restart at the suggested tier' }
        : null,
    }
  },

  // 1.5 — dissertation only: group items into chapters the later steps loop over.
  async chapters({ cwd, runId, manifest, llm }) {
    const matrix = readArtifact({ cwd, runId, name: 'coverage_matrix' })
    const reply = await llm({
      step: 'chapters',
      system: 'Group atomic items into 4 to 10 chapters. Return JSON: {"chapters":[{"title","items":[str]}]}. Every item must appear in exactly one chapter.',
      messages: [{ role: 'user', content: [briefBlock(manifest), '', matrix?.text ?? ''].join('\n') }],
      json: true,
    })
    const json = requireJson(reply, 'chapters')
    const chapters = (Array.isArray(json.chapters) ? json.chapters : []).map((chapter) => ({
      title: String(chapter?.title ?? '').trim(),
      items: (chapter?.items ?? []).map(String),
    })).filter((chapter) => chapter.title)
    if (chapters.length < 4) throw new Error(`a dissertation run needs 4-10 chapters, got ${chapters.length}`)
    const written = await writeArtifact({
      cwd, runId, name: 'chapters', step: 'chapters', overwrite: true,
      body: ['# Chapters', '', ...chapters.map((chapter) => `## ${chapter.title}\n${chapter.items.map((item) => `- ${item}`).join('\n')}`)].join('\n\n'),
    })
    return { artifact: written, summary: { chapters: chapters.length } }
  },

  // 2 — multi-perspective search plan, then retrieval the tool executes.
  async sweep({ cwd, runId, manifest, llm, deps, gear, progress }) {
    const matrix = readArtifact({ cwd, runId, name: 'coverage_matrix' })
    const reply = await llm({
      step: 'sweep',
      system: [
        'Write a multi-perspective search plan. Return JSON: {"perspectives":[{"name","question","queries":[str]}],"web_queries":[str]}.',
        `Between 2 and ${gear.perspectives} perspectives. Include at least one critic perspective that expects to find refutations, and one methodology perspective.`,
        'Queries are keyword strings for a scholarly index, not sentences.',
        'web_queries feed a separate general-web pass for official guidance, regulator statements, trial registers, and serious reporting: two to four, or empty when the question is purely about the literature.',
      ].join(' '),
      messages: [{ role: 'user', content: [briefBlock(manifest), '', matrix?.text ?? ''].join('\n') }],
      json: true,
    })
    const json = requireJson(reply, 'sweep')
    const perspectives = (Array.isArray(json.perspectives) ? json.perspectives : []).slice(0, gear.perspectives)
    if (!perspectives.length) throw new Error('the sweep produced no perspectives')
    const failures = []
    const results = await gather(perspectives.map((perspective) => async () => {
      const queries = (perspective.queries ?? []).map(String).filter(Boolean).slice(0, 4)
      const papers = []
      for (const query of queries) {
        try {
          papers.push(...await deps.search({ query, perSource: gear.sources_per_perspective }))
        } catch (error) {
          failures.push({ perspective: String(perspective.name ?? 'unnamed'), query, error: error instanceof Error ? error.message : String(error) })
        }
      }
      return { perspective: String(perspective.name ?? 'unnamed'), question: String(perspective.question ?? ''), papers }
    }))
    const seen = new Set()
    const lines = []
    const configuredSources = manifest.budget?.max_sources
    const maxSources = configuredSources === null || configuredSources === undefined
      ? null
      : Number.isFinite(Number(configuredSources)) ? Number(configuredSources) : null
    let cappedRecords = 0
    let added = 0
    let landed = 0
    for (const entry of results) {
      landed += 1
      progress({ step: 'sweep', phase: 'perspective', done: landed, total: results.length, detail: `${entry.value?.perspective ?? 'perspective'} searched` })
      if (!entry.ok) { failures.push({ perspective: 'unknown', query: '*', error: entry.error }); continue }
      const fresh = entry.value.papers.filter((paper) => {
        const key = `${(paper.doi ?? '').toLowerCase()}|${String(paper.title ?? '').toLowerCase().replace(/\W+/gu, '')}`
        if (seen.has(key) || !paper.title) return false
        seen.add(key)
        return true
      })
      const stored = await appendRecords({ cwd, runId, perspective: entry.value.perspective, records: fresh, maxRecords: maxSources })
      added += stored.added
      cappedRecords += stored.dropped ?? 0
      lines.push(`## ${entry.value.perspective} — ${entry.value.papers.length} returned, ${stored.added} new${stored.dropped ? `, ${stored.dropped} over the ${maxSources}-record cap` : ''}\n${corpusDigest(stored.records, { perRecord: 160, limit: 20 })}`)
    }
    // The web lane runs after the scholarly one, on its own queries. It exists
    // for guidance documents, registers, and reporting — not to out-vote the
    // literature — so its records are tagged and its failures are named.
    let webAdded = 0
    const webNotes = []
    const webQueries = (Array.isArray(json.web_queries) ? json.web_queries : []).map(String).filter(Boolean).slice(0, 4)
    if (typeof deps.web === 'function' && webQueries.length) {
      // One call, not one per query: the batch providers take an objective with
      // several queries, and a per-query loop would multiply the cost.
      try {
        const papers = await deps.web({
          objective: `${manifest.brief.topic}${manifest.brief.angle ? ` — ${manifest.brief.angle}` : ''}`,
          queries: webQueries,
        })
        const stored = await appendRecords({ cwd, runId, perspective: 'web lane', suggestedBy: 'web_sweep', records: papers, maxRecords: maxSources })
        webAdded = stored.added
        cappedRecords += stored.dropped ?? 0
        webNotes.push(`- ${webQueries.length} web queries → ${papers.length} pages, ${stored.added} new records${stored.dropped ? `, ${stored.dropped} over the ${maxSources}-record cap` : ''}`)
      } catch (error) {
        webNotes.push(`- web lane failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else if (typeof deps.web === 'function') {
      webNotes.push('- the model proposed no web queries for this question')
    } else {
      webNotes.push('- web lane unavailable in this run')
    }
    const laneFailures = deps.webFailures ?? []
    const skipped = laneFailures.filter((entry) => entry.code === 'key_missing')
    const broken = laneFailures.filter((entry) => entry.code !== 'key_missing')
    if (skipped.length) {
      webNotes.push(`- providers skipped for want of a key: ${[...new Set(skipped.map((entry) => entry.provider))].join(', ')}`)
    }
    for (const entry of broken) webNotes.push(`- ${entry.provider}: ${entry.error}`)
    const sourceFailures = [...failures, ...((deps.searchFailures ?? []).slice(0, 20).map((entry) => ({ perspective: entry.source, query: entry.query, error: entry.error })))]
    const corpus = readCorpus(cwd, runId)
    const written = await writeArtifact({
      cwd, runId, name: 'sweep', step: 'sweep', overwrite: true,
      body: ['# Width sweep', '', `Records: ${corpus.independence.records} · Independent votes: ${corpus.independence.votes}`,
        ...(maxSources !== null ? [`Corpus cap: ${maxSources} records${cappedRecords ? `; ${cappedRecords} returned beyond it were not stored` : '; not reached'}`] : []),
        ...(webNotes.length ? ['', '## Web lane', ...webNotes] : []),
        ...(sourceFailures.length ? ['', '## Retrieval failures', ...sourceFailures.map((f) => `- ${f.perspective} · ${f.query} · ${f.error}`)] : []),
        '', ...lines].join('\n\n'),
    })
    if (!corpus.independence.records) throw new Error('the sweep retrieved nothing; a report from memory is not research')
    return {
      artifact: written,
      summary: { perspectives: perspectives.length, records: corpus.independence.records, votes: corpus.independence.votes, web_records: webAdded, failures: sourceFailures.length, capped_records: cappedRecords },
      verdict: sourceFailures.length ? { gate: 'coverage', status: 'flagged', reason: `${sourceFailures.length} retrieval failure(s)`, route: 'retry or widen sources' } : null,
    }
  },

  // 3 — pair conflicting claims across the corpus into ranked clusters.
  async contradictions({ cwd, runId, manifest, llm }) {
    const corpus = readCorpus(cwd, runId)
    const reply = await llm({
      step: 'contradictions',
      system: [
        'Find where the corpus disagrees. Return JSON: {"contradictions":[{"claim","side_a":[record_id],"side_b":[record_id],"why","weight":"high|medium|low"}]}.',
        'Records in the same independence cluster are one voice: never count a syndicated pair as agreement between two sources.',
        'Report only disagreements the quoted or abstracted text actually shows. An absence of evidence is not a contradiction.',
      ].join(' '),
      messages: [{ role: 'user', content: [briefBlock(manifest), '', clusterNote(corpus), corpusDigest(corpus.records, { perRecord: 300 })].join('\n\n') }],
      json: true,
    })
    const json = requireJson(reply, 'contradictions')
    const byId = new Map(corpus.records.map((record) => [record.record_id, record]))
    const rows = (Array.isArray(json.contradictions) ? json.contradictions : []).map((entry) => {
      const sides = { a: (entry.side_a ?? []).map(String).filter((id) => byId.has(id)), b: (entry.side_b ?? []).map(String).filter((id) => byId.has(id)) }
      return { claim: String(entry.claim ?? '').trim(), sides, why: String(entry.why ?? ''), weight: ['high', 'medium', 'low'].includes(entry.weight) ? entry.weight : 'low' }
    }).filter((entry) => entry.claim && entry.sides.a.length && entry.sides.b.length)
    const written = await writeArtifact({
      cwd, runId, name: 'contradictions', step: 'contradictions', overwrite: true,
      body: ['# Contradiction graph', '', ...(rows.length ? rows : [{ claim: 'no supported contradiction found', sides: { a: [], b: [] } }])
        .map((row, index) => `## C${index + 1} · ${row.claim} (${row.weight ?? 'n/a'})\n- A: ${row.sides.a.join(', ') || '—'}\n- B: ${row.sides.b.join(', ') || '—'}\n- ${row.why ?? ''}`)].join('\n\n'),
    })
    return { artifact: written, summary: { contradictions: rows.length } }
  },

  // 4 — two independent loci analysts, then the union scored.
  async loci({ cwd, runId, manifest, llm, gear, progress }) {
    const corpus = readCorpus(cwd, runId)
    const brief = [briefBlock(manifest), '', clusterNote(corpus), '', corpusDigest(corpus.records, { perRecord: 200 })].join('\n')
    const analysts = await gather([1, 2].map((which) => () => llm({
      step: 'loci',
      system: `You are loci analyst ${which}. Choose where deep investigation would most change the answer. Return JSON: {"loci":[{"title","question","record_ids":[str],"expected_yield":num,"why"}]}. At most ${gear.max_loci}.`,
      messages: [{ role: 'user', content: brief }],
      json: true,
    })))
    const pool = []
    const problems = []
    analysts.forEach((entry, index) => {
      if (!entry.ok) { problems.push(`analyst ${index + 1}: ${entry.error}`); return }
      const json = entry.value.json
      if (!json || !Array.isArray(json.loci)) { problems.push(`analyst ${index + 1}: unparseable`); return }
      for (const locus of json.loci.slice(0, gear.max_loci)) {
        if (!String(locus?.title ?? '').trim()) continue
        pool.push({ ...locus, proposed_by: `analyst-${index + 1}` })
      }
    })
    if (!pool.length) throw new Error(`no loci proposed (${problems.join('; ') || 'both analysts silent'})`)
    const merged = await llm({
      step: 'loci',
      system: 'Merge duplicate loci and rank the rest by how much they would change the answer. Return JSON: {"loci":[{"title","question","record_ids":[str],"budget":num,"why"}]}.',
      messages: [{ role: 'user', content: JSON.stringify({ candidates: pool }) }],
      json: true,
    })
    const json = requireJson(merged, 'loci merge')
    const byId = new Set(corpus.records.map((record) => record.record_id))
    const loci = (Array.isArray(json.loci) ? json.loci : []).slice(0, gear.max_loci).map((locus, index) => ({
      locus_id: `loc-${String(index + 1).padStart(4, '0')}`,
      title: String(locus?.title ?? '').trim(),
      question: String(locus?.question ?? '').trim() || null,
      record_ids: (locus?.record_ids ?? []).map(String).filter((id) => byId.has(id)),
      budget: Number.isFinite(Number(locus?.budget)) ? Number(locus.budget) : gear.max_depth,
      why: String(locus?.why ?? ''),
    })).filter((locus) => locus.title)
    if (!loci.length) throw new Error('the loci merge produced nothing')
    const written = await writeArtifact({
      cwd, runId, name: 'loci', step: 'loci', overwrite: true,
      body: ['# Depth loci', '', ...loci.map((locus) => `## ${locus.locus_id} · ${locus.title}\n- Question: ${locus.question ?? locus.title}\n- Sources: ${locus.record_ids.join(', ') || 'none assigned'}\n- Depth budget: ${locus.budget}\n- Why: ${locus.why}`)].join('\n\n'),
    })
    return { artifact: written, summary: { loci: loci.length, analyst_problems: problems }, loci }
  },

  // 5 — one investigator per locus; every locus must come back with a note.
  async depth({ cwd, runId, manifest, llm, deps, progress }) {
    const lociArtifact = readArtifact({ cwd, runId, name: 'loci' })
    if (!lociArtifact) throw new Error('no loci artifact to investigate')
    const loci = [...lociArtifact.text.matchAll(/^## (loc-\d+) · (.+)$/gmu)].map((match) => ({ locus_id: match[1], title: match[2].trim() }))
    if (!loci.length) throw new Error('the loci artifact lists no loci')
    const corpus = readCorpus(cwd, runId)
    const results = await gather(loci.map((locus) => async () => {
      const assigned = corpus.records.filter((record) => lociArtifact.text.includes(record.record_id))
      const fetched = await textsFor(cwd, runId, assigned.slice(0, 6), deps)
      const reply = await llm({
        step: 'depth',
        system: [
          'Investigate this one locus and commit to a position. Return JSON: {"position":str,"confidence":"supported|provisional|contested","claims":[{"text","record_ids":[str],"quote":str}],"what_would_change_it":str}.',
          'A quote is copied out of the supplied text exactly, or it is not given. Never paraphrase inside the quote field.',
          ACCESS_LIMIT,
          UNTRUSTED_RULE,
        ].join(' '),
        messages: [{ role: 'user', content: [briefBlock(manifest), `Locus: ${locus.locus_id} ${locus.title}`, '', corpusDigest(assigned, { perRecord: 300, includeBody: fetched })].join('\n\n') }],
        json: true,
      })
      const json = requireJson(reply, `depth ${locus.locus_id}`)
      const claims = await appendClaims({
        cwd, runId,
        claims: (json.claims ?? []).filter((claim) => String(claim?.text ?? '').trim()).map((claim) => ({
          text: String(claim.text),
          record_ids: (claim.record_ids ?? []).map(String),
          quote: claim.quote ? String(claim.quote) : null,
          rq_id: null,
          strength: ['supported', 'provisional', 'contested'].includes(claim.confidence) ? claim.confidence : null,
        })),
      })
      const note = [
        `# Interim note ${locus.locus_id} · ${locus.title}`, '',
        `**Position:** ${json.position ?? 'not committed'}`, `**Confidence:** ${['supported', 'provisional', 'contested'].includes(json.confidence) ? json.confidence : 'provisional'}`,
        `**What would change it:** ${json.what_would_change_it ?? 'unstated'}`, '',
        ...claims.map((claim) => `- ${sourceIdsFor(claim.record_ids, corpus.records).map((id) => `[${id}]`).join(' ') || '[no source id]'}: ${claim.text}${claim.quote ? ` (quoted: "${claim.quote}")` : ''}`),
      ].join('\n')
      await writeArtifact({ cwd, runId, name: `interim-${locus.locus_id}`, step: 'depth', body: note, overwrite: true })
      progress({ step: 'depth', phase: 'locus', done: loci.indexOf(locus) + 1, total: loci.length, detail: `${locus.locus_id} ${clipTitle(locus.title)} — ${claims.length} claim(s)` })
      return { locus_id: locus.locus_id, claims: claims.length, position: Boolean(json.position) }
    }))
    const done = results.filter((entry) => entry.ok).map((entry) => entry.value)
    const missing = loci.filter((locus) => !done.some((entry) => entry.locus_id === locus.locus_id))
      .map((locus) => locus.locus_id)
    // Locus coverage is enforced here rather than trusted to a later critic.
    const verdict = missing.length
      ? { gate: 'locus_coverage', status: 'blocked', severity: 'MAJOR', reason: `${missing.length} locus/loci produced no interim note`, route: `re-run depth for ${missing.join(', ')}`, detail: missing.join(', ') }
      : null
    return {
      summary: { loci: loci.length, notes: done.length, missing },
      verdict,
      artifact: missing.length ? null : { artifact: 'interim notes' },
    }
  },

  // 6 — reconcile the committed positions against each other.
  async reconcile({ cwd, runId, manifest, llm }) {
    const lociArtifact = readArtifact({ cwd, runId, name: 'loci' })
    const notes = [...lociArtifact.text.matchAll(/^## (loc-\d+) · (.+)$/gmu)]
      .map((match) => readArtifact({ cwd, runId, name: `interim-${match[1]}` }))
      .filter(Boolean)
    if (!notes.length) throw new Error('no interim notes to reconcile')
    const reply = await llm({
      step: 'reconcile',
      system: 'Reconcile the committed positions. Return JSON: {"comparisons":[{"axis","positions":[str],"reconciliation","unresolved":bool}]}. Keep disagreements visible; do not average them away.',
      messages: [{ role: 'user', content: [briefBlock(manifest), '', ...notes.map((note) => note.text)].join('\n\n') }],
      json: true,
    })
    const json = requireJson(reply, 'reconcile')
    const rows = (json.comparisons ?? []).map((row) => `- **${row.axis}** — ${row.reconciliation}${row.unresolved ? ' (unresolved)' : ''}\n${(row.positions ?? []).map((p) => `  - ${p}`).join('\n')}`)
    const written = await writeArtifact({ cwd, runId, name: 'comparisons', step: 'reconcile', overwrite: true, body: ['# Cross-locus comparison', '', ...rows].join('\n\n') })
    return { artifact: written, summary: { comparisons: rows.length, unresolved: (json.comparisons ?? []).filter((row) => row.unresolved).length } }
  },

  // 7 — extract the disagreements the sources themselves are having.
  async tensions({ cwd, runId, manifest, llm, deps }) {
    const corpus = readCorpus(cwd, runId)
    const reply = await llm({
      step: 'tensions',
      system: `Extract expert disagreements present in the corpus. Return JSON: {"tensions":[{"issue","positions":[{"stance","record_ids":[str],"rationale"}],"stake"}]}. One entry per genuine disagreement; syndicated copies are one voice. ${ACCESS_LIMIT}`,
      messages: [{ role: 'user', content: [briefBlock(manifest), '', clusterNote(corpus), corpusDigest(corpus.records, { perRecord: 300, includeBody: await textsFor(cwd, runId, corpus.records.slice(0, 8), deps) })].join('\n\n') }],
      json: true,
    })
    const json = requireJson(reply, 'tensions')
    const tensions = json.tensions ?? []
    const written = await writeArtifact({
      cwd, runId, name: 'source-tensions', step: 'tensions', overwrite: true,
      body: ['# Source tensions', '', ...(tensions.length ? tensions : [{ issue: 'no explicit disagreement recorded', positions: [] }])
        .map((tension) => `## ${tension.issue}\n${(tension.positions ?? []).map((p) => `- **${p.stance}** (${sourceIdsFor(p.record_ids, corpus.records).map((id) => `[${id}]`).join(' ') || 'no source id'}): ${p.rationale}`).join('\n')}\n- Stake: ${tension.stake ?? 'unstated'}`)].join('\n\n'),
    })
    return { artifact: written, summary: { tensions: tensions.length } }
  },

  // 8 — ask what would overturn the run, then go and fetch that.
  async corpus_critic({ cwd, runId, manifest, llm, deps, progress }) {
    const corpus = readCorpus(cwd, runId)
    const reply = await llm({
      step: 'corpus_critic',
      system: 'You are the corpus critic before drafting. Name the sources or whole literatures that would overturn the current direction. Return JSON: {"gaps":[{"what","why","query","expected_source"}]} and at most 6.',
      messages: [{ role: 'user', content: [briefBlock(manifest), '', readArtifact({ cwd, runId, name: 'sweep' })?.text ?? '', '', readArtifact({ cwd, runId, name: 'comparisons' })?.text ?? ''].join('\n\n') }],
      json: true,
    })
    const json = requireJson(reply, 'corpus_critic')
    const gaps = (json.gaps ?? []).slice(0, 6)
    const fetched = await gather(gaps.map((gap) => async () => {
      const papers = await deps.search({ query: String(gap.query ?? ''), perSource: 20 })
      const stored = await appendRecords({ cwd, runId, suggestedBy: 'corpus_critic', records: papers })
      return { gap: String(gap.what ?? 'unnamed'), added: stored.added }
    }))
    const total = fetched.reduce((sum, entry) => sum + (entry.ok ? entry.value.added : 0), 0)
    const written = await writeArtifact({
      cwd, runId, name: 'corpus-gaps', step: 'corpus_critic', overwrite: true,
      body: ['# What would overturn this', '', ...fetched.map((entry, index) => `- ${gaps[index].gap}: ${entry.ok ? `${entry.value.added} new records` : `retrieval failed (${entry.error})`}`)].join('\n\n'),
    })
    const verdict = total === 0 && gaps.length
      ? { gate: 'coverage', status: 'flagged', reason: 'the critic named gaps but retrieval added nothing', route: 'widen sources or accept the boundary' }
      : null
    return { artifact: written, summary: { gaps: gaps.length, added: total }, verdict }
  },

  // 9 — top claims with verbatim quotes, checked against stored text now.
  async digest({ cwd, runId, manifest, llm, deps, progress }) {
    const corpus = readCorpus(cwd, runId)
    const reply = await llm({
      step: 'digest',
      system: `Select the load-bearing claims. Return JSON: {"claims":[{"text","rq_id","record_ids":[str],"quote":str,"strength":"supported|provisional|contested"}]}. A quote is copied verbatim from the supplied text or omitted. ${ACCESS_LIMIT}`,
      messages: [{ role: 'user', content: [briefBlock(manifest), '', clusterNote(corpus), corpusDigest(corpus.records, { perRecord: 400, perBodyChars: 4000, includeBody: await textsFor(cwd, runId, corpus.records.slice(0, 12), deps) })].join('\n\n') }],
      json: true,
    })
    const json = requireJson(reply, 'digest')
    const questions = new Set(manifest.brief.research_questions.map((rq) => rq.rq_id))
    const drafted = (json.claims ?? []).filter((claim) => String(claim?.text ?? '').trim()).map((claim) => ({
      text: String(claim.text),
      rq_id: questions.has(claim.rq_id) ? claim.rq_id : null,
      record_ids: (claim.record_ids ?? []).map(String),
      quote: claim.quote ? String(claim.quote) : null,
      strength: ['supported', 'provisional', 'contested'].includes(claim.strength) ? claim.strength : 'provisional',
    }))
    // Quote status is set by the verifier, never by the model that wrote it.
    const byId = new Map(corpus.records.map((record) => [record.record_id, record]))
    const statuses = []
    for (const claim of drafted) {
      if (!claim.quote || typeof deps.quoteStatus !== 'function') {
        statuses.push('not_checked')
        continue
      }
      const verdicts = []
      for (const recordId of claim.record_ids.length ? claim.record_ids : [null]) {
        const record = recordId ? byId.get(recordId) : null
        if (!record) { verdicts.push('not_checked'); continue }
        const verdict = await deps.quoteStatus(claim.quote, record)
        verdicts.push(verdict === null || verdict === undefined ? 'not_checked' : verdict)
      }
      statuses.push(verdicts.includes('supported') ? 'supported'
        : verdicts.includes('abstract') ? 'abstract'
          : verdicts.includes('unsupported') ? 'unsupported' : 'not_checked')
    }
    const claims = await appendClaims({
      cwd, runId,
      claims: drafted.map((claim, index) => ({ ...claim, quote_status: statuses[index] })),
    })
    const unsupported = claims.filter((claim) => claim.quote_status === 'unsupported')
    const written = await writeArtifact({
      cwd, runId, name: 'evidence-digest', step: 'digest', overwrite: true,
      body: ['# Evidence digest', '', 'Copy each [src-] id exactly as printed. A cl- label is a claim, not a source, and must not be turned into a citation.', '', ...claims.map((claim) => {
        const sources = sourceIdsFor(claim.record_ids, corpus.records)
        return `- ${sources.map((id) => `[${id}]`).join(' ') || '[no source id]'} [${claim.rq_id ?? 'no rq'}] (${claim.strength}, quote ${claim.quote_status}) ${claim.text}${claim.quote ? `\n  > ${claim.quote}` : ''}`
      })].join('\n')
        + (unsupported.length ? `\n\n${unsupported.length} claim(s) failed the verbatim check and must not be cited as quoted.` : ''),
    })
    return {
      artifact: written,
      summary: { claims: claims.length, unsupported: unsupported.length, answered: new Set(claims.filter((claim) => claim.rq_id).map((claim) => claim.rq_id)).size },
      // A quote that is not verbatim is disclosed on the claim. It does not halt
      // the run: the live session showed a citation block sending the host into
      // a patch-and-resume loop that never returned the report.
      verdict: unsupported.length
        ? { gate: 'citation', status: 'flagged', severity: 'MAJOR', reason: `${unsupported.length} quote(s) not present verbatim`, route: 'the claims stay marked unsupported and the report is still written', detail: unsupported.map((claim) => claim.claim_id).join(', ') }
        : { gate: 'citation', status: 'clear', reason: 'no claim quote failed the verbatim check' },
    }
  },

  // 10 — light tier drafts once; full tier drafts from three angles in parallel.
  async draft({ cwd, runId, manifest, llm, gear, progress, deps }) {
    const corpus = readCorpus(cwd, runId)
    const digestArtifact = readArtifact({ cwd, runId, name: 'evidence-digest' })
    // The light tier has no digest step. Without this fallback the draft is
    // handed a cluster note and no evidence, and honestly concludes that
    // nothing is known — which is a starved run, not a finding.
    const ranked = rankRecords(corpus.records)
    // `fetch_full_text` has to mean something on the light path too, or the
    // draft cites titles it was never allowed to read and every binding comes
    // back "partial" against an abstract.
    const bodies = digestArtifact ? [] : await textsFor(cwd, runId, ranked.slice(0, 12), deps)
    const evidence = digestArtifact?.text?.trim()
      ? digestArtifact.text
      : `## Retrieved corpus (ranked by citation authority)\n\n${corpusDigest(ranked, { perRecord: 320, limit: 60, perBodyChars: 4000, includeBody: bodies })}`
    const angles = gear.drafts > 1
      ? ['evidence and mechanism', 'disagreement and limits', 'application, policy, and who is affected']
      : ['the question as asked']
    const results = await gather(angles.map((angle) => () => llm({
      step: 'draft',
      system: [
        `Draft from this angle: ${angle}. Write only from the material supplied; cite record ids inline as [src-NNNN].`,
        'Cite the [src-] ids printed on the claims and copy them exactly. A cl- label is a claim, not a source: do not turn cl-0041 into [src-0041]. A cluster id such as c0004 is never a citation.',
        'Never cite a claim the material marks unsupported, and never present a cluster of copies as several sources.',
        manifest.tier === 'light'
          ? researchReportContract()
          : 'Write prose a later survey can use. Do not write an evidence map, a verification ledger, or headings that are research-question ids.',
        registerVoice(manifest.brief.register),
      ].join(' '),
      messages: [{ role: 'user', content: [briefBlock(manifest), '', clusterNote(corpus), evidence].join('\n\n') }],
      json: false,
    })))
    const drafts = results.map((entry, index) => entry.ok
      ? entry.value.text
      : `<!-- draft ${index + 1} failed: ${entry.error} -->`)
    drafts.forEach((text, index) => progress({ step: 'draft', phase: 'angle', done: index + 1, total: drafts.length, detail: results[index].ok ? `${angles[index]} drafted` : `${angles[index]} failed` }))
    const usable = drafts.filter((text) => text.trim() && !text.trim().startsWith('<!--'))
    if (!usable.length) throw new Error('every draft attempt failed')
    const written = await writeArtifact({
      cwd, runId, name: 'drafts', step: 'draft', overwrite: true,
      body: usable.map((text, index) => `# Draft ${index + 1}\n\n${text}`).join('\n\n---\n\n'),
    })
    // Light tier has no separate synthesis step, so the single draft *is* the
    // report — and cite check, polish, and the ship gate operate on it. Nothing
    // may skip verification, however short the run is. A gateway-shaped draft
    // is rewritten once into the survey; the angle notes stay in `drafts`.
    if (manifest.tier === 'light') {
      let body = usable[0]
      if (looksLikeGatewayMap(body)) {
        const again = await llm({
          step: 'draft',
          system: [researchReportContract(), registerVoice(manifest.brief.register)].join(' '),
          messages: [{ role: 'user', content: [briefBlock(manifest), '', 'The draft below is a gateway evidence map. Rewrite it as the research report.', '', body.slice(0, 14000)].join('\n') }],
          json: false,
          maxTokens: 12000,
        })
        if (again.text.trim()) body = again.text
      }
      body = repairClaimSerialCitations(stripGatewayTail(body), readRun(cwd, runId)?.claims ?? [], corpus.records)
      body = withCorpusBibliography(body, corpus.records)
      const evidenceRewrite = pendingSuppliedRecords(cwd, runId).length > 0
      await writeArtifact({ cwd, runId, name: 'final_report', step: 'draft', body, overwrite: true, evidenceRewrite })
      if (evidenceRewrite) await clearSuppliedPending(cwd, runId)
    }
    return { artifact: written, summary: { angles: usable.length, failed: drafts.length - usable.length } }
  },

  // 11 — synthesize; from here the report is patch-only.
  // The evidence map is the gateway the writer reads. The stored report is the survey.
  async synthesize({ cwd, runId, manifest, llm, deps }) {
    const drafts = readArtifact({ cwd, runId, name: 'drafts' })
    if (!drafts) throw new Error('nothing to synthesize')
    const comparisons = readArtifact({ cwd, runId, name: 'comparisons' })?.text ?? ''
    const tensions = readArtifact({ cwd, runId, name: 'source-tensions' })?.text ?? ''
    const contradictions = readArtifact({ cwd, runId, name: 'contradictions' })?.text ?? ''
    const digest = readArtifact({ cwd, runId, name: 'evidence-digest' })?.text ?? ''
    const allowed = allowedRecordIds(drafts.text, comparisons, tensions, contradictions, digest)
    const corpus = readCorpus(cwd, runId)
    const bearing = loadBearingRecords(cwd, runId, corpus.records)
    const reading = corpusDigest(bearing, {
      perRecord: 400, limit: 24, perBodyChars: 4000,
      includeBody: await textsFor(cwd, runId, bearing, deps),
    })
    // Stored for the writer and for a later resume of this step. show, patch,
    // and export refuse the name, so it never becomes the result the user sees.
    const map = buildEvidenceMap({ manifest, contradictions, tensions, comparisons, digest, drafts: drafts.text, reading })
    await writeArtifact({ cwd, runId, name: 'evidence-map', step: 'synthesize', body: map, overwrite: true })
    const system = [
      researchReportContract(),
      allowed.length ? `Allowed record ids: ${allowed.slice(0, 300).join(', ')}${allowed.length > 300 ? ` (+${allowed.length - 300} more in the drafts)` : ''}.` : '',
      registerVoice(manifest.brief.register),
    ].filter(Boolean).join(' ')
    const reply = await llm({
      step: 'synthesize',
      system,
      messages: [{ role: 'user', content: [briefBlock(manifest), '', 'Private evidence map. Use it to write the report. Do not copy its title, its headings, or its ledger voice.', '', map].join('\n') }],
      json: false,
      maxTokens: 12000,
    })
    if (!reply.text.trim()) throw new Error('the synthesizer returned nothing')
    let body = reply.text
    if (looksLikeGatewayMap(body)) {
      const again = await llm({
        step: 'synthesize',
        system,
        messages: [{ role: 'user', content: [briefBlock(manifest), '', 'The draft below is a gateway evidence map. Rewrite it as the research report. Do not reuse its headings.', '', body.slice(0, 14000)].join('\n') }],
        json: false,
        maxTokens: 12000,
      })
      if (again.text.trim()) body = again.text
    }
    body = repairClaimSerialCitations(stripGatewayTail(body), readRun(cwd, runId)?.claims ?? [], corpus.records)
    body = withCorpusBibliography(body, corpus.records)
    const evidenceRewrite = pendingSuppliedRecords(cwd, runId).length > 0
    const written = await writeArtifact({ cwd, runId, name: 'final_report', step: 'synthesize', body, overwrite: true, evidenceRewrite })
    if (evidenceRewrite) await clearSuppliedPending(cwd, runId)
    return { artifact: written, summary: { chars: written.chars } }
  },

  // 12 — four critics, each blind to the others, none of them authoritative.
  async critics({ cwd, runId, manifest, llm, progress }) {
    const report = readArtifact({ cwd, runId, name: 'final_report' })
    if (!report) throw new Error('no report to critique')
    const corpus = readCorpus(cwd, runId)
    const roles = [
      { id: 'dialectic', brief: 'Counter-evidence the draft missed or dismissed. In survey register, judge fairness of representation instead of missing commitment.' },
      { id: 'depth', brief: 'Places where the draft is shallower than its own interim notes.' },
      { id: 'width', brief: 'Topical corners the corpus supports but the draft ignores.' },
      { id: 'instruction', brief: 'Research questions the draft does not actually answer, and atomic items it dropped.' },
    ]
    const results = await gather(roles.map((role) => () => llm({
      step: 'critics',
      system: [
        `You are the ${role.id} critic. ${role.brief}`,
        'Return JSON: {"findings":[{"title","severity":"High|Medium|Low","reason","target","primary_check","verifier","suggested_hunk":{"find","replace"}}]}.',
        '`target` is the smallest repairable thing (a section heading or record id). `primary_check` is one of angle, coverage, citation, taxonomy, calibration, weaving. `verifier` says how a human confirms closure.',
        'Report only what you inspected in the text. An absence in the material you were given is not a defect; it is unobserved, and unobserved is not a finding.',
        'At most 5 findings. Five is a floor for coverage, never a quota to fill.',
      ].join(' '),
      messages: [{ role: 'user', content: [briefBlock(manifest), '', clusterNote(corpus), report.text].join('\n\n') }],
      json: true,
    })))
    let accepted = 0
    let rejected = 0
    const escalations = []
    let criticIndex = 0
    for (const entry of results) {
      criticIndex += 1
      progress({ step: 'critics', phase: 'critic', done: criticIndex, total: results.length, detail: `${roles[criticIndex - 1].id} critic reported` })
      if (!entry.ok) { escalations.push({ critic: 'unknown', error: entry.error }); continue }
      const findings = entry.value.json?.findings ?? []
      const stored = await appendFindings({ cwd, runId, stepId: 'critics', findings })
      accepted += stored.accepted.length
      rejected += stored.rejected.length
      for (const finding of stored.rejected) escalations.push({ critic: finding.title ?? 'unnamed', error: finding.rejected_reason })
    }
    return { artifact: { artifact: 'findings' }, summary: { accepted, rejected, escalations }, escalations }
  },

  // 13 — critic-identified gaps get one targeted retrieval wave before patching.
  async gap_fetch({ cwd, runId, manifest, deps, progress }) {
    const findings = readFindings(cwd, runId).filter((finding) => finding.status === 'open')
    const wanted = findings.filter((finding) => finding.primary_check === 'coverage' || finding.primary_check === 'citation')
    if (!wanted.length) return { summary: { queried: 0, added: 0, capped_records: 0 }, artifact: { artifact: 'gap-fetch' } }
    const configuredSources = manifest.budget?.max_sources
    const maxSources = configuredSources === null || configuredSources === undefined
      ? null
      : Number.isFinite(Number(configuredSources)) ? Number(configuredSources) : null
    const results = await gather(wanted.map((finding) => async () => {
      const papers = await deps.search({ query: String(finding.title ?? finding.reason ?? ''), perSource: 15 })
      const stored = await appendRecords({ cwd, runId, suggestedBy: finding.finding_id, records: papers, maxRecords: maxSources })
      return { finding_id: finding.finding_id, added: stored.added, dropped: stored.dropped ?? 0 }
    }))
    const added = results.reduce((sum, entry) => sum + (entry.ok ? entry.value.added : 0), 0)
    const cappedRecords = results.reduce((sum, entry) => sum + (entry.ok ? entry.value.dropped : 0), 0)
    const written = await writeArtifact({
      cwd, runId, name: 'gap-fetch', step: 'gap_fetch', overwrite: true,
      body: ['# Gap fetch', '', ...results.map((entry, index) => `- ${wanted[index].finding_id}: ${entry.ok ? `${entry.value.added} records${entry.value.dropped ? `, ${entry.value.dropped} over the ${maxSources}-record cap` : ''}` : `failed (${entry.error})`}`)].join('\n'),
    })
    return { artifact: written, summary: { queried: wanted.length, added, capped_records: cappedRecords } }
  },

  // 14 — apply critic findings as capped hunks, or escalate them. Never rewrite.
  async patcher({ cwd, runId, progress }) {
    const report = readArtifact({ cwd, runId, name: 'final_report' })
    if (!report) throw new Error('nothing to patch')
    const findings = readFindings(cwd, runId).filter((finding) => finding.status === 'open' && finding.suggested_hunk)
    let applied = 0
    const escalated = []
    for (const finding of findings) {
      const result = await applyHunks({
        cwd, runId, artifact: 'final_report', findingId: finding.finding_id,
        hunks: [finding.suggested_hunk],
      })
      if (result.applied.length && !result.escalated.length) {
        await markFindingApplied({ cwd, runId, findingId: finding.finding_id, patchId: result.patch_id })
        applied += 1
      } else {
        // A partial patch does not close the finding; the remaining context is
        // still a defect the report must answer for.
        for (const entry of result.escalated) escalated.push({ finding_id: finding.finding_id, reason: entry.reason, detail: entry.detail })
        if (!result.escalated.length) escalated.push({ finding_id: finding.finding_id, reason: 'not_applied', detail: 'no hunk changed the report' })
      }
      progress({ step: 'patcher', phase: 'finding', done: findings.indexOf(finding) + 1, total: findings.length, detail: `${finding.finding_id} ${result.applied.length ? 'patched' : 'escalated'}` })
    }
    // A High finding that cannot fit a hunk must surface, not vanish.
    const stillOpen = readFindings(cwd, runId).filter((finding) => finding.status === 'open' && finding.severity === 'High')
    return {
      artifact: { artifact: 'final_report' },
      summary: { findings: findings.length, applied, escalated: escalated.length },
      escalations: escalated,
      verdict: stillOpen.length ? null : { gate: 'patch_surgery', status: 'clear', reason: 'no open High finding after patching' },
    }
  },

  // 14.5 — do the citations actually support the sentences that carry them?
  async cite_check({ cwd, runId, manifest, llm, deps, progress }) {
    let report = readArtifact({ cwd, runId, name: 'final_report' })
    if (!report) throw new Error('nothing to cite-check')
    const corpus = readCorpus(cwd, runId)
    report = await expandReaderCitations({ cwd, runId, report })
    // A cluster id is not a paper. When the corpus already names that cluster's
    // representative record, rewrite the bracket before the audit. The DBT run
    // blocked on fourteen of these, each of which already had a src- id.
    const clusterById = new Map()
    for (const record of corpus.records) {
      if (record.cluster_id && !clusterById.has(record.cluster_id)) clusterById.set(record.cluster_id, record)
    }
    const seenClusters = new Set()
    const rewrites = []
    for (const match of report.text.matchAll(/\[(c\d{3,})\]/giu)) {
      const token = match[1].toLowerCase()
      if (seenClusters.has(token)) continue
      seenClusters.add(token)
      const representative = clusterById.get(token)
      if (!representative) continue
      rewrites.push({ find: match[0], replace: `[${representative.record_id}]`, all: true })
    }
    if (rewrites.length) {
      const rewritten = await applyHunks({ cwd, runId, artifact: 'final_report', hunks: rewrites, maxHunks: Math.max(24, rewrites.length) })
      if (rewritten.applied?.length) report = readArtifact({ cwd, runId, name: 'final_report' })
    }
    const claims = readRun(cwd, runId)?.claims ?? []
    const repaired = repairClaimSerialCitations(report.text, claims, corpus.records)
    if (repaired !== report.text) {
      await writeArtifact({ cwd, runId, name: 'final_report', step: 'cite_check', overwrite: true, mechanical: true, body: repaired })
      report = readArtifact({ cwd, runId, name: 'final_report' })
    }
    // Scan every bracketed id-shaped token, not just well-formed ones: a model
    // that writes [src-c0004] is citing a cluster, and a report that cites
    // nothing at all must not be handed a clean citation verdict.
    const tokens = [...new Set([...report.text.matchAll(/\[([A-Za-z][A-Za-z0-9-]{1,20})\]/gmu)].map((match) => match[1].toLowerCase()))]
    // Bracketed prose such as [AUC] is not a citation. These shapes are. A
    // cluster id (`c0242`) is especially dangerous: it looks like a citation,
    // is stable across copies, and names no single work, so every one is a
    // High finding rather than an ignored token.
    const citationShaped = tokens.filter((token) => /^(?:src-[a-z0-9-]+|c\d{3,}|cl-[a-z0-9-]+|rec-\d+)$/u.test(token))
    const sourceRefs = [...new Set(citationShaped.filter((token) => /^src-/u.test(token)))]
    const knownIds = sourceRefs.filter((id) => corpus.records.some((record) => record.record_id === id))
    const cited = knownIds.map((id) => corpus.records.find((record) => record.record_id === id)).filter(Boolean)
    const missing = sourceRefs.filter((id) => !knownIds.includes(id))
    const invalid = citationShaped.filter((token) => !/^src-/u.test(token))
      .map((token) => ({ token, representative: clusterById.get(token) ?? null }))
    // Low runs can cite 25-30 records. A 12-record sample can omit the one
    // co-citation that supports a sentence, producing a false challenge.
    const sample = cited.slice(0, 30)
    const sampledBodies = await textsFor(cwd, runId, sample, deps)
    const withBody = new Set(sampledBodies.map((entry) => entry.record_id))
    // A record with no abstract and no fetched body cannot confirm or refute a
    // citation. Challenging those would blame the report for a retrieval gap of
    // ours, and would block a ship that is actually unverifiable rather than wrong.
    const readableIds = new Set(sample.filter((record) => String(record.abstract ?? '').trim() || withBody.has(record.record_id)).map((record) => record.record_id))
    const evidenceless = sample.filter((record) => !readableIds.has(record.record_id))
    const reply = await llm({
      step: 'cite_check',
      system: [
        'Audit whether each cited record actually supports the sentence that cites it. Return JSON: {"bindings":[{"record_id","sentence","verdict":"supports|partial|mismatch|unknown","evidence":str}]}.',
        'Return one binding for every cited record in a sentence. A sentence is supported when at least one cited record carries the claim; do not challenge it merely because another co-citation is partial. Judge only the sentence-citation pair you can see. If the material does not show it, say unknown; unknown is not a mismatch.',
        UNTRUSTED_RULE,
      ].join(' '),
      messages: [{ role: 'user', content: [
        `Report:\n${proseForCitation(report.text).slice(0, 20000)}`, '',
        // 400 chars truncated the very sentence that supported the claim in a
        // live run (the GI/hypoglycemia details sat after the cut). Cite-check
        // needs the full abstract, not the head of it.
        `Cited records:\n${corpusDigest(sample, { perRecord: 2000, perBodyChars: 4000, includeBody: sampledBodies })}`,
        evidenceless.length
          ? `Records with no readable text (title only): ${evidenceless.map((record) => record.record_id).join(', ')}. Return verdict \"unknown\" for any binding to these; they cannot be judged.`
          : '',
      ].join('\n\n') }],
      json: true,
    })
    const json = reply.json ?? {}
    const normalizeSentence = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim().toLowerCase()
    const bindings = Array.isArray(json.bindings) ? json.bindings : []
    // A sentence often carries several citations because different sources
    // support different parts of it. One supporting co-citation settles the
    // sentence; challenging every partial binding would block a supported claim.
    const supportedSentences = new Set(bindings
      .filter((binding) => binding.verdict === 'supports' && readableIds.has(String(binding.record_id ?? '')))
      .map((binding) => normalizeSentence(binding.sentence)))
    const challengedGroups = new Map()
    let unverifiable = 0
    for (const binding of bindings) {
      if (!['partial', 'mismatch'].includes(binding.verdict)) continue
      const key = normalizeSentence(binding.sentence) || `record:${binding.record_id ?? 'unknown'}`
      if (supportedSentences.has(key)) continue
      if (!challengedGroups.has(key)) challengedGroups.set(key, [])
      challengedGroups.get(key).push(binding)
    }
    const challenged = []
    for (const group of challengedGroups.values()) {
      if (group.some((binding) => readableIds.has(String(binding.record_id ?? '')))) {
        challenged.push({
          ...group[0],
          record_ids: [...new Set(group.map((binding) => String(binding.record_id ?? '')).filter(Boolean))],
          details: group,
        })
      } else unverifiable += 1
    }
    const retractions = deps.retractionFor
      ? (await Promise.all(cited.map((record) => deps.retractionFor(record)))).filter((flag) => flag?.retracted)
      : []
    const pendingFindings = [
        // A report with no traceable reference has not been verified at all, so
        // the absence is itself the finding rather than a silent clean pass.
        ...(sourceRefs.length === 0 ? [{
          severity: 'High',
          title: 'Report cites no traceable record',
          reason: 'the finished report contains no [src-NNNN] reference, so no sentence in it can be checked against the corpus',
          target: 'final_report', primary_check: 'citation',
          verifier: 'add the record ids supplied to the draft, or mark the claim as unsourced',
        }] : []),
        // Partial and mismatch are readings of a real paper. They are recorded
        // beside the report. They are not High, because a High finding stops
        // verify and the last live run then patched and re-audited forever.
        ...challenged.map((binding) => ({
          severity: 'Medium', title: `Citation does not support its sentence (${binding.verdict})`,
          reason: binding.details.map((row) => `${row.record_id}: ${row.verdict}${row.evidence ? ` — ${row.evidence}` : ''}`).join('; '),
          target: binding.record_ids.join(',') || binding.record_id || binding.sentence || 'final_report', primary_check: 'citation',
          verifier: `the sentence and ${binding.record_ids.join('/') || 'the citation'} only partly agree; the report still ships with this note`,
        })),
        ...missing.map((id) => ({
          severity: 'High', title: 'Citation names a record that is not in the corpus', reason: `${id} appears in the report but was never retrieved`,
          target: id, primary_check: 'citation', verifier: 'retrieve the work or delete the citation',
        })),
        ...invalid.map(({ token, representative }) => ({
          severity: 'High',
          title: token.startsWith('cl-') ? 'Citation names a claim, not a record' : 'Citation names a cluster, not a record',
          reason: token.startsWith('cl-')
            ? `${token} is a claim label, not a source. Cite the record ids on that claim.`
            : representative
              ? `${token} names a cluster of copies; its representative record is ${representative.record_id}. Cite a specific [src-...] work, not the cluster.`
              : `${token} is not a [src-...] record in this corpus`,
          target: token,
          primary_check: 'citation',
          verifier: token.startsWith('cl-')
            ? 'cite the [src-] records on that claim, or remove the label'
            : representative
              ? `replace [${token}] with [${representative.record_id}] for the sentence it supports, or remove it`
              : 'replace it with the specific [src-...] record(s) that support the sentence, or remove it',
          // A cluster token is a mechanical substitution when it is unique in
          // the report; the patcher applies it as a hunk and closes the finding.
          ...(representative ? { suggested_hunk: { find: `[${token}]`, replace: `[${representative.record_id}]` } } : {}),
        })),
        ...retractions.map((flag) => ({
          severity: 'High', title: 'Retracted source cited without acknowledgement', reason: flag.notice ?? 'retraction flag returned',
          target: flag.record_id ?? flag.doi ?? 'final_report', primary_check: 'citation',
          verifier: 'acknowledge the retraction in the text or remove the citation',
        })),
    ]
    // Number the reader's sources only after the audit has used corpus ids.
    // Findings are then bound to the report the reader actually receives.
    report = await publishReaderCitations({ cwd, runId, report, records: corpus.records })
    await writeSourceAccess({ cwd, runId })
    const findings = await appendFindings({ cwd, runId, stepId: 'cite_check', findings: pendingFindings })
    const written = await writeArtifact({
      cwd, runId, name: 'cite-check', step: 'cite_check', overwrite: true,
      body: ['# Cite check', '', `Cited records: ${cited.length} · sampled: ${sample.length} · unknown or invalid ids: ${missing.length + invalid.length}`,
        `Bindings challenged: ${challenged.length} · unverifiable for want of text: ${unverifiable + evidenceless.length} · retracted cited: ${retractions.length}`,
        ...(invalid.length ? ['', 'Cluster or non-record ids used as citations:', ...invalid.map(({ token, representative }) => `- ${token}${representative ? ` → representative ${representative.record_id}` : ' → no matching cluster'}`)] : []),
        ...(evidenceless.length ? ['', `Title-only records the sweep could not read (abstract absent from every source): ${evidenceless.map((record) => `${record.record_id} ${clipTitle(record.title)}`).join('; ')}`] : []),
        ...(findings.accepted.length ? ['', ...findings.accepted.map((finding) => `- ${finding.finding_id} ${finding.severity} · ${finding.title} → ${finding.target}`)] : []),
        ...(findings.rejected.length ? ['', 'Rejected candidates (kept visible, not promoted):', ...findings.rejected.map((row) => `- ${row.title}: ${row.rejected_reason}`)] : [])].join('\n'),
    })
    // The gate is about the current report, not only findings this pass happened
    // to add. A rerun that re-observes a still-open High defect must block even
    // when duplicate suppression returns it in `rejected`.
    const patches = readRun(cwd, runId)?.patches ?? []
    const currentOpen = readFindings(cwd, runId).filter((finding) => finding.status === 'open'
      && finding.primary_check === 'citation'
      && findingIsCurrent(finding, report.hash, patches))
    // These are not readings. The reference does not name a paper the run can
    // stand behind, so the report is not ready to return.
    const stopsTheRun = (finding) => /^(?:Report cites no traceable record|Citation names a record that is not in the corpus|Citation names a cluster, not a record|Citation names a claim, not a record|Retracted source cited without acknowledgement)/u.test(finding.title ?? '')
    const mechanical = currentOpen.filter(stopsTheRun)
    const judged = currentOpen.filter((finding) => !stopsTheRun(finding))
    return {
      artifact: written,
      summary: { cited: cited.length, challenged: challenged.length, unverifiable, title_only: evidenceless.length, unknown_ids: missing.length + invalid.length, invalid_citations: invalid.length, retractions: retractions.length, accepted: findings.accepted.length, rejected: findings.rejected.length, open_high: mechanical.length, flagged: judged.length },
      verdict: mechanical.length
        ? { gate: 'citation', status: 'blocked', severity: 'CRITICAL', reason: `${mechanical.length} citation(s) name nothing in the corpus, a cluster, a claim label, or a retraction`, route: 'repair or remove that reference before resuming' }
        : evidenceless.length && evidenceless.length >= Math.max(1, sample.length - 1) && !judged.length
          ? { gate: 'citation', status: 'not_checked', reason: `${evidenceless.length} of ${sample.length} sampled records had no readable text; bindings could not be judged either way`, route: 'rerun with fetch_full_text or accept an unverifiable citation set' }
          : judged.length
            ? { gate: 'citation', status: 'flagged', severity: 'MAJOR', reason: `${judged.length} citation(s) only partly match their sentence`, route: 'recorded beside the report; the run continues and the report is returned' }
            : { gate: 'citation', status: 'clear', reason: `${cited.length} citations sampled, none challenged` },
    }
  },

  // 15 — hygiene and filler, applied as hunks; the report body still cannot be rewritten.
  async polish({ cwd, runId, manifest, llm, progress }) {
    const report = readArtifact({ cwd, runId, name: 'final_report' })
    if (!report) throw new Error('nothing to polish')
    const reply = await llm({
      step: 'polish',
      system: [
        'Cut filler, hedge-stacking, and any leaked scaffolding (section labels, frontmatter, prompt echoes). Return JSON: {"hunks":[{"find","replace"}]} with at most 20 hunks.',
        '`find` must be copied exactly from the report and must appear once. You are not permitted to restructure or rewrite. Do not add, remove, or renumber [src-] citations.',
        manifest.brief.register === 'survey' ? 'In survey register, keep the hedges that report uncertainty honestly.' : 'Tighten wording that overstates the evidence.',
      ].join(' '),
      messages: [{ role: 'user', content: report.text }],
      json: true,
    })
    const hunks = (reply.json?.hunks ?? []).slice(0, 20)
    const result = await applyHunks({ cwd, runId, artifact: 'final_report', hunks })
    progress({ step: 'polish', phase: 'hunk', done: 1, total: 1, detail: `${result.applied.length} of ${hunks.length} hunks applied, ${result.escalated.length} escalated` })
    await refreshReaderCitationKey({ cwd, runId })
    return {
      artifact: { artifact: 'final_report' },
      summary: { proposed: hunks.length, applied: result.applied.length, escalated: result.escalated.length },
      escalations: result.escalated,
    }
  },

  // 16 — suggestions are recommended, never applied wholesale.
  async readability({ cwd, runId, llm }) {
    const report = readArtifact({ cwd, runId, name: 'final_report' })
    if (!report) throw new Error('nothing to audit')
    const reply = await llm({
      step: 'readability',
      system: 'Recommend rhythm and structure changes only. Return JSON: {"suggestions":[{"why","find","replace","priority":"high|low"}]}. Do not change any claim, citation, or number.',
      messages: [{ role: 'user', content: report.text }],
      json: true,
    })
    const suggestions = (reply.json?.suggestions ?? []).slice(0, 12)
    const written = await writeArtifact({
      cwd, runId, name: 'readability-suggestions', step: 'readability', overwrite: true,
      body: ['# Readability suggestions', '', ...suggestions.map((suggestion, index) => `${index + 1}. (${suggestion.priority ?? 'low'}) ${suggestion.why}\n   - from: ${String(suggestion.find ?? '').slice(0, 120)}\n   - to: ${String(suggestion.replace ?? '').slice(0, 120)}`)].join('\n'),
    })
    return {
      artifact: written,
      summary: { suggestions: suggestions.length },
      note: 'The orchestrator applies these selectively by hand; the audit never edits the report itself.',
    }
  },
}

/** Cluster membership the model must be told about before it counts voices. */
function clusterNote(corpus) {
  if (!corpus.clustered.derivative.length) {
    return `Independence: ${corpus.independence.records} records, ${corpus.independence.votes} independent voices.`
  }
  return [
    `Independence: ${corpus.independence.records} records collapse to ${corpus.independence.votes} independent voices.`,
    ...corpus.clustered.derivative.map((cluster) => `- ${cluster.cluster_id}: ${cluster.copies} copies of one originating act across ${cluster.distinct_hosts} host(s) — ${cluster.representative.title}`),
  ].join('\n')
}

/**
 * Run the plan, resumably.
 *
 * A step already marked `done` is not repeated, which is what makes `resume`
 * pick up at the step that died rather than restarting a two-hour run.
 */
export async function runSteps({
  cwd, runId, ctx, route, deps, signal = null, gear = null,
  fromStep = null, maxSteps = null, onProgress = null,
}) {
  const stored = readManifest(cwd, runId)
  if (!stored) throw new Error(`unknown run ${runId}`)
  const manifest = { ...stored, gear: gear ?? stored.gear }
  let steps = stepView(cwd, runId)
  const totalSteps = steps.length
  const orderOf = (id) => steps.findIndex((entry) => entry.step_id === id)
  if (fromStep && orderOf(fromStep) < 0) {
    throw new Error(`unknown from_step "${fromStep}"; expected one of ${steps.map((entry) => entry.step_id).join(', ')}`)
  }
  const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0))
  const sink = typeof onProgress === 'function' ? onProgress : () => {}
  /**
   * Percent is derived from plan position, so the bar means "how much of the
   * pipeline is left" rather than "how many calls happened to succeed".
   */
  const progress = (event) => {
    if (!event || !event.step) return
    const index = orderOf(event.step)
    const slice = 1 / Math.max(1, totalSteps)
    const at = event.status === 'done' ? 1
      : event.status === 'failed' || event.status === 'blocked' ? 1
        : Number.isFinite(event.frac) ? clamp01(event.frac) : 0
    const percent = index < 0 ? 0 : Math.min(99, Math.max(0, Math.round((index + at) * slice * 100)))
    sink({ ...event, step_index: index < 0 ? null : index + 1, total_steps: totalSteps, percent })
  }
  const llm = createLlmRunner({
    ctx, route, signal, runId, cwd,
    onEvent: (event) => progress({ step: event.step, phase: 'model', kind: event.type, detail: event.detail ?? null, model: event.model, ms: event.ms, input_tokens: event.input_tokens, output_tokens: event.output_tokens, message: event.message, prompt_chars: event.prompt_chars, completion_chars: event.completion_chars }),
  })
  const log = []
  const invocationStartedAt = Date.now()

  // A blocked step halts the run. Skipping past it would let a CRITICAL gate
  // verdict be walked around by simply running the later steps.
  const blockedStep = steps.find((entry) => entry.status === 'blocked')
  const order = (id) => steps.findIndex((entry) => entry.step_id === id)
  const restartAt = fromStep ? order(fromStep) : null
  if (blockedStep && restartAt === null) {
    return {
      status: 'blocked',
      reason: `step ${blockedStep.step_id} is blocked`,
      blocked_at: blockedStep.step_id,
      detail: blockedStep.detail ?? null,
      hint: 'clear the gate with action=gate status=clear, or re-run with from_step',
      completed: steps.filter((entry) => entry.status === 'done').length,
      steps: log,
    }
  }
  if (restartAt !== null) {
    // An explicit restart means every blocked step at or after that point is
    // being retried. Reset them all, then re-read the state: filtering a stale
    // snapshot made the reset step invisible and let later steps run instead.
    for (const entry of steps.slice(restartAt)) {
      if (entry.status === 'blocked') {
        await markStep({ cwd, runId, step: entry.step_id, status: 'pending', detail: 'reset by an explicit from_step restart' })
      }
    }
    steps = stepView(cwd, runId)
    if (!steps.some((entry) => entry.step_id === fromStep)) {
      throw new Error(`unknown from_step "${fromStep}"`)
    }
  }

  const freshOrder = new Map(steps.map((step, index) => [step.step_id, index]))
  const queue = steps.filter((step) => {
    if (restartAt !== null) {
      // `from_step` is an explicit re-run: it starts at the named step (even if
      // that step is done) and never walks backwards into earlier steps.
      if (freshOrder.get(step.step_id) < restartAt) return false
      if (step.step_id === fromStep) return true
      return !['done', 'skipped', 'blocked'].includes(step.status)
    }
    return !['done', 'skipped', 'blocked'].includes(step.status)
  })

  const bounded = Number.isFinite(maxSteps) ? queue.slice(0, maxSteps) : queue

  for (const step of bounded) {
    // Segment rows hold completed invocations; add this one's elapsed time so
    // the cap applies during the run rather than only after it ends.
    const budget = budgetState(cwd, runId, { extraMs: Date.now() - invocationStartedAt })
    if (budget.exceeded) {
      const exceeded = budget.checks.filter((check) => check.exceeded)
      await markStep({ cwd, runId, step: step.step_id, status: 'blocked', detail: `budget exceeded: ${exceeded.map((c) => `${c.kind} ${c.used}/${c.cap}`).join(', ')}` })
      log.push({ step: step.step_id, status: 'blocked', reason: 'budget', checks: exceeded })
      progress({ step: step.step_id, status: 'blocked', reason: 'budget_exceeded' })
      return { status: 'blocked', reason: 'budget_exceeded', completed: log.filter((entry) => entry.status === 'done').length, steps: log }
    }
    const runStep = STEP_RUNNERS[step.step_id]
    if (!runStep) {
      await markStep({ cwd, runId, step: step.step_id, status: 'skipped', detail: 'no runner bound' })
      log.push({ step: step.step_id, status: 'skipped', reason: 'no_runner' })
      continue
    }
    // A re-run grades its own replacement, so anything it raised last time is
    // retired before the new pass starts.
    const prior = steps.find((entry) => entry.step_id === step.step_id)
    if (prior && ['done', 'failed', 'blocked'].includes(prior.status)) {
      const retired = await supersedeFindings({ cwd, runId, stepId: step.step_id })
      if (retired.superseded) progress({ step: step.step_id, phase: 'supersede', done: 1, total: 1, detail: `${retired.superseded} earlier finding(s) retired` })
    }
    await markStep({ cwd, runId, step: step.step_id, status: 'running' })
    progress({ step: step.step_id, status: 'running', detail: step.name })
    try {
      const outcome = await runStep({
        cwd, runId, manifest, llm, deps, gear: GEARS[manifest.gear] ?? GEARS.standard, signal, progress,
      })
      if (outcome?.verdict) await recordVerdict({ cwd, runId, ...outcome.verdict })
      const blocked = outcome?.verdict?.status === 'blocked'
      await markStep({ cwd, runId, step: step.step_id, status: blocked ? 'blocked' : 'done', detail: summarize(outcome?.summary) })
      log.push({ step: step.step_id, status: blocked ? 'blocked' : 'done', summary: outcome?.summary ?? null, escalations: outcome?.escalations ?? [] })
      progress({ step: step.step_id, status: blocked ? 'blocked' : 'done', summary: outcome?.summary, detail: summarize(outcome?.summary) ?? step.name })
      if (blocked) return { status: 'blocked', reason: outcome.verdict.gate, completed: log.filter((entry) => entry.status === 'done').length, steps: log }
    } catch (error) {
      const message = error instanceof Error ? error.message
        : typeof error?.message === 'string' ? error.message
          : error && typeof error === 'object' ? JSON.stringify(error).slice(0, 500) : String(error)
      await markStep({ cwd, runId, step: step.step_id, status: 'failed', detail: message.slice(0, 500) })
      log.push({ step: step.step_id, status: 'failed', error: message.slice(0, 500) })
      progress({ step: step.step_id, status: 'failed', error: message, detail: message.slice(0, 200) })
      if (signal?.aborted) return { status: 'cancelled', completed: log.filter((entry) => entry.status === 'done').length, steps: log }
      return { status: 'failed', step: step.step_id, error: message.slice(0, 500), completed: log.filter((entry) => entry.status === 'done').length, steps: log }
    }
  }
  return { status: signal?.aborted ? 'cancelled' : 'complete', completed: log.filter((entry) => entry.status === 'done').length, steps: log }
}

function summarize(summary) {
  if (!summary) return null
  return Object.entries(summary).slice(0, 6).map(([key, value]) => `${key}=${Array.isArray(value) ? value.length : value}`).join(' ')
}

export { STEP_META }
