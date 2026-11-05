/**
 * deep_research: a self-driving research pipeline with an auditable spine.
 *
 * One call decomposes a question, sweeps the literature, finds where the
 * sources disagree, drafts, attacks the draft, repairs it with surgical hunks
 * only, and refuses to ship a report that cites a source it cannot support.
 * The state lives in `.dsh/deep-research/<run>/` so a crashed run resumes at
 * the step that died instead of starting a two-hour investigation over again.
 *
 * The model proposes; this tool executes retrieval, mints ids, counts voice
 * rather than copies, fences what it fetched, keeps the spend, and gates the
 * result. It never decides what the answer should be, and it never claims a
 * citation is sound when it could not check one: unverified stays `not_checked`
 * and is disclosed in the same breath as a pass.
 *
 * Pipeline shape adapted from jordan-gibbs/hyperresearch (MIT); see NOTICE. No
 * upstream code is vendored.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from 'ah-dsh-tools'
import { GEARS, createLlmRunner, parseJsonResponse, planFor, runSteps } from './deep-research-steps.js'
import { EFFORT_LEVELS, EFFORT_PRESETS, resolveEffort } from './deep-research-effort.js'
import {
  GATE_STATES, TIERS, accounting, appendClaims, appendFindings, appendRecords, applyHunks,
  appendRetrieval, assertGospel, budgetState, listRuns, markStep, nextPendingStep, readArtifact,
  linkPaperMemory, readCorpus, readFindings, readManifest, readPaperLinks, readQuery, readRun,
  recordVerdict, shipGate, startRun,
  stepView,
} from './deep-research-store.js'
import { csvCell, ensureDir, exportText } from './ledger-kit.js'
import { resolveEnv } from './credential-env.js'
import { convertPdfMarkdown } from './pdf-to-markdown.js'
import { chooseSources, runSource } from './literature-search.js'
import { mergeRanked } from './search-normalize.js'
import { fetchPdf, resolvePdfSources } from './paper-download.js'
import { ingestConvertedMarkdown, projectSlugFromCwd, quoteCheck } from './papermemory-cli.js'
import { runBraveSearch } from './brave-search.js'
import { runExaSearch } from './exa-search.js'
import { runPerplexitySearch } from './perplexity-search.js'
import { runParallelSearch } from './parallel-search.js'
import { runTavilySearch } from './tavily-search.js'
import { normalizeDoi } from './independence-cluster.js'

const ACTIONS = ['start', 'run', 'status', 'resume', 'verify', 'export', 'list', 'record', 'gate', 'patch', 'answers']
const EXPORT_FORMATS = ['markdown', 'json', 'csv']
const RECORD_KINDS = ['records', 'claims', 'findings']
const DEFAULT_TIMEOUT_MINUTES = 90
const MAX_TIMEOUT_MINUTES = 720

function text(value) {
  return String(value ?? '').trim()
}

function workspaceRoot(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

/** The calling session's route; deep_research never picks its own model. */
function sessionRoute(exec) {
  let requestConfig
  try {
    requestConfig = exec?.agent?.session?.requestHeader?.()?.config
  } catch {
    requestConfig = undefined
  }
  const options = exec?.agent?.options && typeof exec.agent.options === 'object' ? exec.agent.options : {}
  const provider = requestConfig?.provider || options.provider
  const model = requestConfig?.model || options.model
  if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) {
    throw new Error('deep_research could not resolve the session model route. Run it from a session with a selected model.')
  }
  return { provider, model }
}

function clip(value, max = 300) {
  const raw = text(value)
  return raw.length > max ? `${raw.slice(0, max)}…` : raw
}

/**
 * Frame research questions from a bare topic.
 *
 * The brief is what everything else is checked against, so it is written once,
 * here, before the run exists. A topic is not a question and is refused.
 */
async function frameBrief({ llm, query, hint }) {
  const reply = await llm({
    step: 'frame',
    json: true,
    system: [
      'Turn a research request into a brief. Return JSON: {"topic":str,"research_questions":[str],"angle":str,"reader":str,"register":"teach|survey|analyze|advocate"}.',
      'Two to four research_questions: specific, answerable, and jointly exhaustive of what the requester actually needs. A topic restated as "what is known about X" is not a research question.',
    ].join(' '),
    messages: [{ role: 'user', content: [`Request:\n${query}`, hint ? `Extra direction:\n${hint}` : ''].filter(Boolean).join('\n\n') }],
  })
  const json = parseJsonResponse(reply.text, null) ?? reply.json
  if (!json || !Array.isArray(json.research_questions) || !json.research_questions.length) {
    throw new Error('could not frame research questions from this request; supply brief.research_questions')
  }
  return {
    topic: text(json.topic) || clip(query, 60),
    research_questions: json.research_questions.map(String).slice(0, 6),
    angle: text(json.angle) || null,
    reader: text(json.reader) || null,
    register: ['teach', 'survey', 'analyze', 'advocate'].includes(json.register) ? json.register : 'analyze',
  }
}

/** Retrieval through the existing literature router; no second search client. */
function buildSearch(exec, { sources, perSource, signal, email, failures = [] }) {
  const searchFailures = failures
  return async function search({ query, perSource: override = null }) {
    const chosen = sources ?? chooseSources(query, null)
    const limit = override ?? perSource
    const groups = await Promise.all(chosen.map(async (source) => {
      try {
        return { source, results: (await runSource(source, { query, perSource: limit, signal })).results ?? [], error: null }
      } catch (error) {
        // A source that failed is a failure, not an empty result set: hiding it
        // is how a title-only corpus ends up looking like a full one.
        return { source, results: [], error: error instanceof Error ? error.message : String(error) }
      }
    }))
    for (const group of groups) {
      if (group.error) searchFailures.push({ source: group.source, query, error: group.error })
    }
    const merged = mergeRanked(groups.map(({ source, results }) => ({ source, results })), { k: 60 })
    return merged.map((paper) => ({
      source: paper.source,
      doi: paper.doi ?? null,
      url: paper.url ?? paper.html_url ?? paper.pdf_url ?? null,
      year: paper.year ?? null,
      citation_count: paper.citation_count ?? null,
      title: paper.title,
      abstract: paper.abstract ?? paper.tldr ?? null,
    }))
  }
}

/**
 * Full text is opt-in.
 *
 * Bodies are cached content-addressed inside the run so a verbatim quote check
 * is a local string comparison rather than a guess. This cache is disposable
 * run state; PaperMemory remains the library of record.
 */

/**
 * The web lane.
 *
 * The scholarly sweep returns canonical, citation-ranked works; it does not
 * return guidelines, regulator statements, news, or the grey literature where a
 * field's actual disputes live. This lane reuses the plugin's existing keyed web
 * clients rather than a new one, stops as soon as it has enough context, and
 * tags every record so a webpage can never be mistaken for a trial report.
 */
const WEB_SEARCHERS = {
  // Parallel takes one objective with up to five queries, which is the shape a
  // research lane actually has; the others are per-query indexes.
  parallel: { run: runParallelSearch, batch: true },
  exa: { run: runExaSearch, batch: false, args: { num_results: 10 } },
  tavily: { run: runTavilySearch, batch: false, args: { search_depth: 'advanced' } },
  brave: { run: runBraveSearch, batch: false, args: { count: 10 } },
}
export const WEB_PROVIDERS = Object.keys(WEB_SEARCHERS)
const WEB_DEFAULT = ['parallel', 'exa', 'tavily', 'brave']

/** Parallel returns raw API rows; the others are already normalized papers. */
export function webRecord(name, row) {
  if (!row || typeof row !== 'object') return null
  const title = String(row.title ?? '').trim()
  const url = String(row.url ?? row.link ?? '').trim()
  if (!title && !url) return null
  const abstract = Array.isArray(row.excerpts)
    ? row.excerpts.filter(Boolean).join('\n\n')
    : row.abstract ?? row.snippet ?? row.content ?? null
  return {
    title: title || url,
    url: url || null,
    source: `web:${name}`,
    lane: 'web',
    work_type: 'web_page',
    year: Number.isFinite(Number(String(row.publish_date ?? '').slice(0, 4))) ? Number(String(row.publish_date).slice(0, 4)) : null,
    abstract: abstract ? String(abstract).slice(0, 4000) : null,
    doi: null,
    citation_count: null,
  }
}

export function buildWebSearch({ signal, providers = null, target = 20, failures = [] }) {
  const wanted = Array.isArray(providers) && providers.length ? providers : WEB_DEFAULT
  return async function web({ objective, queries = [] } = {}) {
    const list = (Array.isArray(queries) ? queries : []).map(String).filter(Boolean)
    if (!list.length) return []
    const out = []
    for (const name of wanted) {
      const spec = WEB_SEARCHERS[name]
      if (!spec) {
        failures.push({ provider: name, code: 'not_supported', error: `unknown web provider ${name}` })
        continue
      }
      let result
      try {
        result = spec.batch
          ? await spec.run({ objective: String(objective || list[0]), search_queries: list.slice(0, 5), mode: 'advanced' }, { signal })
          : await spec.run({ query: list[0], ...spec.args }, { signal })
      } catch (error) {
        failures.push({ provider: name, code: 'failed', error: (error instanceof Error ? error.message : String(error)).slice(0, 200) })
        continue
      }
      if (result?.error) {
        // A missing key is a configuration state, not a retrieval failure: the
        // gate reports the two differently.
        failures.push({ provider: name, code: result.code ?? 'failed', error: String(result.error).slice(0, 200) })
        continue
      }
      // Verified against a live call: Parallel answers with `results`, each row
      // `{url, title, publish_date, excerpts}`.
      const rows = Array.isArray(result?.results) ? result.results : []
      for (const row of rows) {
        const record = webRecord(name, row)
        if (record) out.push(record)
      }
      if (!rows.length && !result?.error) {
        // "No error and no rows" is the case that would otherwise be invisible.
        failures.push({
          provider: name,
          code: 'empty_response',
          error: `no recognised result array (keys: ${Object.keys(result ?? {}).slice(0, 8).join(',') || 'none'})`,
        })
      }
      if (out.length >= target) break
    }
    return out
  }
}

/**
 * Retrieve open-access full text for the records a step is about to quote.
 *
 * `resolvePdfSources` yields either a candidate (`{candidate:{pdfUrl}}`) or a
 * failed resolver (`{attempt:{source,error}}`); `fetchPdf` returns a PDF buffer,
 * and `convertPdfMarkdown` turns it into text. Every outcome is recorded, because
 * "we could not verify that quote" needs a reason, not a shrug.
 */
export function buildFetch(cwd, runId, { signal, enabled, email, perBodyChars = 60000, resolvers = {}, library = {} } = {}) {
  const resolve = resolvers.resolvePdfSources ?? resolvePdfSources
  const download = resolvers.fetchPdf ?? fetchPdf
  const convert = resolvers.convertPdfMarkdown ?? convertPdfMarkdown
  const dir = join(cwd, '.dsh', 'deep-research', runId, 'bodies')
  const memory = new Map()
  const attempts = []
  return async function fetchBodies(records) {
    if (!enabled) return []
    const mailto = email || await resolveEnv('CROSSREF_MAILTO').catch(() => null) || await resolveEnv('UNPAYWALL_EMAIL').catch(() => null)
    const out = []
    for (const record of records) {
      if (!record?.record_id) continue
      if (memory.has(record.record_id)) {
        const cached = memory.get(record.record_id)
        if (cached.body) out.push(cached)
        continue
      }
      let entry
      try {
        let url = null
        let resolver = null
        let version = null
        const failures = []
        for await (const step of resolve({ doi: record.doi, signal, email: mailto })) {
          if (step.attempt) { failures.push(`${step.attempt.source}: ${step.attempt.error}`); continue }
          if (step.candidate?.pdfUrl && !url) {
            url = step.candidate.pdfUrl
            resolver = step.candidate.source ?? null
            version = step.candidate.version ?? step.candidate.oaVersion ?? null
          }
        }
        if (!url) throw new Error(failures[0] ?? 'no_open_access_copy')
        const buffer = await download(url, mailto, signal)
        const converted = await convert(buffer, {})
        if (!converted?.success) throw new Error(`pdf_conversion_failed: ${String(converted?.error ?? 'unknown').slice(0, 160)}`)
        const body = String(converted.markdown ?? '').trim()
        // A repository landing page is not full text; a thin body is worse than
        // none, because it would let a quote check pass on a title line.
        if (body.length < 1200) throw new Error('open_access_copy_too_thin')
        const truncated = body.length > perBodyChars ? body.slice(0, perBodyChars) : body
        ensureDir(dir)
        const bodyFile = join(dir, `${record.record_id}.md`)
        writeFileSync(bodyFile, truncated)
        // The run cache makes the quote checkable now; PaperMemory makes it
        // durable, so the next session does not re-fetch the same paper.
        const deposited = await ingestToLibrary({ cwd, runId, bodyFile, record, signal, ingest: library.ingest ?? ingestConvertedMarkdown })
        entry = {
          record_id: record.record_id, source: record.source, body: truncated,
          truncated: truncated.length < body.length,
          oa: { resolver, url, version },
          pm_paper: deposited.pm_paper ?? null,
          library: deposited.status,
        }
        attempts.push({ record_id: record.record_id, ok: true, bytes: truncated.length, url })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        entry = { record_id: record.record_id, source: record.source, body: '', error: reason }
        attempts.push({ record_id: record.record_id, ok: false, bytes: 0, reason: reason.slice(0, 200) })
      }
      memory.set(record.record_id, entry)
      if (entry.body) out.push(entry)
    }
    if (attempts.length) {
      const rows = attempts.splice(0, attempts.length)
      await appendRetrieval({ cwd, runId, rows })
    }
    return out
  }
}

/** Verbatim containment against what this run actually fetched. */
/**
 * Deposit a fetched full text into PaperMemory.
 *
 * A failure is recorded, never hidden: the run can still verify quotes from its
 * own cache, but the user needs to know the library did not grow.
 */
async function ingestToLibrary({ cwd, runId, bodyFile, record, signal, ingest = ingestConvertedMarkdown }) {
  try {
    const result = await ingest({
      path: bodyFile,
      doi: record.doi ?? null,
      project: projectSlugFromCwd(cwd),
      cwd,
      signal,
      originChannel: 'deep-research',
    })
    if (!result?.ok) {
      const error = result?.error ?? 'ingest rejected'
      await linkPaperMemory({ cwd, runId, recordId: record.record_id, pmPaper: null, doi: record.doi ?? null, status: 'ingest_failed', error })
      return { status: 'ingest_failed', pm_paper: null, error }
    }
    const paperId = result.paper?.id ?? result.paper?.paper_id ?? result.bibtex_key ?? null
    await linkPaperMemory({ cwd, runId, recordId: record.record_id, pmPaper: paperId, doi: record.doi ?? null, status: result.status ?? 'created' })
    return { status: 'ingested', pm_paper: paperId }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      await linkPaperMemory({ cwd, runId, recordId: record.record_id, pmPaper: null, doi: record.doi ?? null, status: 'ingest_failed', error: message })
    } catch { /* a failing link ledger must not fail the run */ }
    return { status: 'ingest_failed', pm_paper: null, error: message }
  }
}

/**
 * Verify a quoted span.
 *
 * PaperMemory is tried first: it holds the stored text of every paper the
 * library has ever read, so a quote can be checked against the library rather
 * than only against what this run happened to fetch. When the library cannot be
 * read, that is not a verdict on the quote, so the check falls through to the
 * run's own cache and, failing that, reports `not_checked`.
 */
export function buildQuoteStatus(cwd, runId, { check = quoteCheck, projectOf = projectSlugFromCwd } = {}) {
  const dir = join(cwd, '.dsh', 'deep-research', runId, 'bodies')
  const fold = (value) => String(value).toLowerCase()
    .replace(/\u2019|\u2018/gu, "'").replace(/\u201c|\u201d/gu, '"')
    .replace(/\s+/gu, ' ').trim()
  let links = null
  return async function quoteStatus(quote, record) {
    if (!quote || !record?.record_id) return 'not_checked'
    if (!links) links = readPaperLinks(cwd, runId)
    const paperId = links.get(record.record_id)?.pm_paper ?? record.pm_paper ?? null
    if (paperId) {
      const checked = await check({ quote, paper: paperId, project: projectOf(cwd), cwd })
      if (checked.ok) return checked.found ? 'supported' : 'unsupported'
    }
    const file = join(dir, `${record.record_id}.md`)
    if (!existsSync(file)) return 'not_checked'
    return fold(readFileSync(file, 'utf8')).includes(fold(quote)) ? 'supported' : 'unsupported'
  }
}


function buildRetraction(exec, { signal }) {
  return async function retractionFor(record) {
    const doi = normalizeDoi(record?.doi)
    if (!doi) return null
    try {
      const { runIntegrityCheck } = await import('./integrity-check.js')
      const result = await runIntegrityCheck({ doi }, exec, { signal })
      const hits = (result?.findings ?? result?.results ?? []).filter((finding) => /retract/iu.test(String(finding?.type ?? '')))
      return { retracted: hits.some((hit) => hit.type === 'retraction'), notice: hits[0]?.detail ?? null, record_id: record.record_id, doi }
    } catch {
      // Unreadable is not "not retracted".
      return null
    }
  }
}

function renderStatus(value) {
  const lines = [`Run ${value.run_id} · ${value.tier} · gear ${value.gear} · ${value.status}`]
  lines.push(`Query: ${clip(value.query, 160)}`)
  lines.push(`Questions: ${value.research_questions.length}`)
  lines.push('')
  for (const step of value.steps) {
    lines.push(`${step.status === 'done' ? 'x' : step.status === 'pending' ? ' ' : step.status[0]} ${step.order}. ${step.name}${step.detail ? ` — ${clip(step.detail, 120)}` : ''}`)
  }
  lines.push('')
  lines.push(`Sources: ${value.accounting.sources} records = ${value.accounting.votes} independent voices${value.accounting.derivative_clusters ? ` (${value.accounting.derivative_clusters} syndicated)` : ''}`)
  lines.push(`Spend: ${value.accounting.llm_calls} model calls, ${value.accounting.input_tokens}+${value.accounting.output_tokens} tokens, ${Math.round((value.accounting.wall_ms ?? 0) / 1000)}s`)
  if (value.next_step) lines.push(`Next: ${value.next_step.name}${value.next_step.reason ? ` (${value.next_step.reason})` : ''}`)
  if (value.budget?.exceeded) lines.push(`Budget exceeded: ${value.budget.checks.filter((c) => c.exceeded).map((c) => `${c.kind} ${c.used}/${c.cap}`).join(', ')}`)
  return lines.join('\n')
}

function renderVerify(value) {
  const lines = [`Ship gate ${value.run_id}: ${value.status.toUpperCase()}`]
  if (value.caveat) lines.push(value.caveat)
  for (const check of value.checks) {
    lines.push(`${check.state === 'pass' ? 'PASS' : check.state === 'blocked' ? 'BLOCK' : '    '} ${check.id} · ${check.detail ?? ''}`)
  }
  return lines.join('\n')
}

function renderExport(value) {
  const lines = [`Exported ${value.run_id} as ${value.format} → ${value.path} (${value.bytes} bytes)`]
  if (value.report_sha) lines.push(`report sha256:${value.report_sha}`)
  return lines.join('\n')
}

function renderList(value) {
  if (!value.runs.length) return 'No deep research runs in this workspace.'
  return value.runs.map((run) => {
    const done = run.steps.filter((step) => step.status === 'done').length
    return `${run.run_id} · ${clip(run.topic, 60)} · ${run.tier} · ${done}/${run.steps.length} steps · ${run.created_at}`
  }).join('\n')
}

function renderAnswers(value) {
  const lines = [`Answers for ${value.run_id}`]
  for (const question of value.research_questions) {
    const claims = value.answers[question.rq_id] ?? []
    lines.push(`\n## ${question.rq_id}: ${question.text}`)
    if (!claims.length) lines.push('- no recorded claim answers this question')
    for (const claim of claims) {
      lines.push(`- ${clip(claim.text, 400)} [${claim.record_ids.join(', ') || 'no records'}] quote:${claim.quote_status}`)
    }
  }
  return lines.join('\n')
}

const RENDERERS = {
  status: renderStatus,
  verify: renderVerify,
  export: renderExport,
  list: renderList,
  answers: renderAnswers,
}

function presentCall(args) {
  const action = args?.action ?? 'status'
  const title = action === 'start' ? 'Deep research: start'
    : action === 'list' ? 'Deep research: runs'
      : `Deep research: ${action}`
  return { card: 'generic', title, kind: 'other' }
}

/**
 * `injected` replaces any production dependency — the seam every audited tool in
 * this plugin exposes for tests, and the reason a CI run never reaches the network.
 */
async function runAction(args, exec, ctx, injected = {}) {
  const cwd = workspaceRoot(exec)
  const action = args.action ?? 'status'
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
  const runId = text(args.run_id) || null

  if (action === 'list') return { action, runs: listRuns(cwd) }

  if (action === 'start') {
    const query = text(args.query ?? args.topic)
    if (!query) throw new Error('query is required')
    const statedEffort = text(args.effort) || null
    if (statedEffort && !EFFORT_LEVELS.includes(statedEffort)) {
      throw new Error(`effort must be one of ${EFFORT_LEVELS.join(', ')}`)
    }
    const explicitTier = text(args.tier) || null
    const explicitGear = text(args.gear) || null
    if (explicitTier && !TIERS.includes(explicitTier)) throw new Error(`tier must be one of ${TIERS.join(', ')}`)
    if (explicitGear && !GEARS[explicitGear]) throw new Error(`gear must be one of ${Object.keys(GEARS).join(', ')}`)

    const level = resolveEffort({
      effort: statedEffort,
      query,
      explicitTier,
      explicitGear,
      overrides: {
        max_llm_calls: args.max_llm_calls,
        max_sources: args.max_sources,
        timeout_minutes: args.timeout_minutes,
        fetch_full_text: args.fetch_full_text,
        web_lane: args.web_lane,
      },
    })
    // An unresolved guess at an expensive run should ask, not spend. Nothing is
    // created and no model call is made until the caller answers. A caller who
    // named a level is driving, so the run proceeds — but the contradiction is
    // still reported, because picking "medium" does not resolve "quickly, but
    // make it comprehensive".
    if (level.conflict && !statedEffort && !args.confirm_effort) {
      return {
        action,
        status: 'needs_input',
        suggested_effort: level.effort,
        effort_basis: level.effort_basis,
        conflict: true,
        ask_user: level.ask_user,
        options: EFFORT_PRESETS,
        note: 'answer, then call start again with effort=low|medium|high. Nothing was run and no model call was made.',
      }
    }
    const { tier, gear } = level
    const route = sessionRoute(exec)
    const llm = createLlmRunner({ ctx, route, runId: null, cwd: null, signal: exec?.signal ?? null })
    let brief = args.brief && typeof args.brief === 'object' ? args.brief : null
    if (brief && !Array.isArray(brief.research_questions)) brief = { ...brief, research_questions: null }
    if (!brief?.research_questions?.length) brief = await frameBrief({ llm, query, hint: text(args.direction) })
    const manifest = await startRun({
      cwd, query, brief, tier, gear, plan: planFor(tier, gear),
      budget: {
        // Raw values: the store decides what counts as a cap, so an absent
        // value can never become a zero cap.
        max_llm_calls: level.budget.max_llm_calls ?? null,
        max_sources: level.budget.max_sources ?? null,
        timeout_minutes: level.budget.timeout_minutes ?? null,
        acknowledged_retractions: args.acknowledged_retractions ?? [],
      },
      execution: {
        fetch_full_text: level.fetch_full_text,
        web_lane: level.web_lane,
        sources: Array.isArray(args.sources) && args.sources.length ? args.sources : null,
        contact_email: text(args.contact_email) || null,
        web_sources: Array.isArray(args.web_sources) && args.web_sources.length ? args.web_sources : null,
        effort: level.effort,
        effort_source: level.effort_source,
        effort_basis: level.effort_basis,
        effort_conflict: Boolean(level.conflict),
        explicit_overrides: level.explicit,
      },
    })
    if (!args.run) {
      return {
        action,
        run_id: manifest.run_id,
        tier,
        gear,
        effort: level.effort,
        effort_source: level.effort_source,
        effort_basis: level.effort_basis,
        ...(level.conflict ? { effort_conflict: true, ask_user: level.ask_user } : {}),
        expectation: level.expectation,
        status: 'prepared',
        steps: stepView(cwd, manifest.run_id),
        research_questions: manifest.brief.research_questions,
      }
    }
    return dispatchAction({ action: 'run', cwd, runId: manifest.run_id, args, exec, ctx, injected })
  }

  if (!runId) {
    const latest = listRuns(cwd)[0]
    if (!latest) throw new Error('no deep research run in this workspace; start one first')
    return dispatchAction({ action, cwd, runId: latest.run_id, args, exec, ctx, injected })
  }
  return dispatchAction({ action, cwd, runId, args, exec, ctx, injected })
}

async function dispatchAction({ action, cwd, runId, args, exec, ctx, injected = {} }) {
  const manifest = readManifest(cwd, runId)
  if (!manifest) throw new Error(`unknown run ${runId}`)
  const spend = accounting(cwd, runId)

  if (action === 'status') {
    return {
      action, run_id: runId, tier: manifest.tier, gear: manifest.gear,
      status: statusOf(manifest, cwd, runId), query: readQuery(cwd, runId),
      research_questions: manifest.brief.research_questions, steps: stepView(cwd, runId),
      execution: manifest.execution ?? null,
      next_step: nextPendingStep(cwd, runId), accounting: spend, budget: budgetState(cwd, runId),
    }
  }

  if (action === 'run' || action === 'resume') {
    return {
      action,
      run_id: runId,
      ...(await runAsJob(ctx, exec, {
        kind: 'deep-research',
        label: `deep research ${runId} (${action})`,
        timeoutMs: jobTimeoutMs(manifest),
      }, (job, signal) => {
        const lines = []
        const sink = makeProgressSink(job, (line) => lines.push(line))
        return execute({
          cwd,
          runId,
          args,
          exec,
          ctx,
          resume: action === 'resume',
          signal,
          injected,
          onProgress: (event) => sink.event(event),
        }).then((value) => ({
          ...value,
          // No jobs service means nothing streamed: return what happened instead
          // of leaving the caller with a result and no account of the run.
          ...(job ? {} : { progress_lines: lines.slice(-40) }),
        }))
      })),
    }
  }

  if (action === 'verify') {
    return { action, run_id: runId, ...(await shipGate({ cwd, runId, deps: { ...gateDeps(cwd, runId, exec, args), ...injected } })) }
  }

  if (action === 'answers') {
    const run = readRun(cwd, runId)
    const answers = {}
    for (const claim of run.claims) {
      if (!claim.rq_id) continue
      answers[claim.rq_id] = (answers[claim.rq_id] ?? []).concat(claim)
    }
    return { action, run_id: runId, research_questions: manifest.brief.research_questions, answers }
  }

  if (action === 'export') {
    const format = text(args.format) || 'markdown'
    if (!EXPORT_FORMATS.includes(format)) throw new Error(`format must be one of ${EXPORT_FORMATS.join(', ')}`)
    const report = readArtifact({ cwd, runId, name: 'final_report' })
    if (!report) throw new Error('run has no final_report to export')
    const gate = await shipGate({ cwd, runId, deps: { ...gateDeps(cwd, runId, exec, args), ...injected } })
    const target = join(cwd, '.dsh', 'deep-research', runId, 'exports', `report.${format === 'csv' ? 'csv' : format}`)
    const corpus = readCorpus(cwd, runId)
    let body
    if (format === 'markdown') {
      body = [report.text, '', '---', '', '# Verification', gate.status === 'pass' ? `Ship gate: PASS${gate.caveat ? ` — ${gate.caveat}` : ''}` : `Ship gate: BLOCKED (${gate.blocked.join(', ')})`,
        '', ...gate.checks.map((check) => `- ${check.state} · ${check.id} · ${check.detail ?? ''}`),
        '', `Corpus: ${corpus.independence.records} records, ${corpus.independence.votes} independent voices.`,
        '', ...corpus.records.map((record) => `- [${record.record_id}] ${record.title}${record.doi ? ` — doi:${record.doi}` : ''} (${record.source})`)].join('\n')
    } else if (format === 'csv') {
      body = ['record_id,cluster_id,copies_independent,title,doi,source,year,citation_count,url',
        ...corpus.records.map((record) => [record.record_id, record.cluster_id, record.independent ? '1' : '0', csvCell(record.title), csvCell(record.doi), record.source, record.year, record.citation_count, csvCell(record.url)].join(','))].join('\n')
    } else {
      body = JSON.stringify({ manifest, gate, corpus: corpus.records, claims: readRun(cwd, runId).claims, report: report.text }, null, 2)
    }
    const written = exportText(target, body, { overwrite: Boolean(args.overwrite) })
    return { action, run_id: runId, format, path: written.path, bytes: written.bytes, report_sha: report.hash.slice(7, 23), gate_status: gate.status }
  }

  if (action === 'record') {
    const kind = text(args.kind)
    if (!RECORD_KINDS.includes(kind)) throw new Error(`kind must be one of ${RECORD_KINDS.join(', ')}`)
    if (kind === 'records') {
      const stored = await appendRecords({ cwd, runId, records: args.records ?? [], suggestedBy: text(args.suggested_by) || null, perspective: text(args.perspective) || null })
      return { action, run_id: runId, kind, added: stored.added, independence: stored.independence }
    }
    if (kind === 'claims') {
      const rows = await appendClaims({ cwd, runId, claims: args.claims ?? [] })
      return { action, run_id: runId, kind, added: rows.length, claims: rows }
    }
    const stored = await appendFindings({ cwd, runId, findings: args.findings ?? [], stepId: text(args.step_id) || null })
    return { action, run_id: runId, kind, accepted: stored.accepted, rejected: stored.rejected }
  }

  if (action === 'gate') {
    const gate = text(args.gate)
    const status = text(args.status).toLowerCase()
    if (!GATE_STATES.includes(status)) throw new Error(`status must be one of ${GATE_STATES.join(', ')}`)
    const verdict = await recordVerdict({ cwd, runId, gate, status, severity: args.severity ?? null, reason: args.reason ?? null, route: args.route ?? null })
    // A CRITICAL gate is a fact about the run, so it blocks here rather than
    // waiting for the ship gate to rediscover it.
    if (status === 'blocked') await writeBlockedStep(cwd, runId, gate)
    return { action, run_id: runId, verdict }
  }

  if (action === 'patch') {
    const artifact = text(args.artifact) || 'final_report'
    const result = await applyHunks({
      cwd, runId, artifact, hunks: args.hunks ?? [], findingId: text(args.finding_id) || null,
      maxHunkChars: Number.isFinite(Number(args.max_hunk_chars)) ? Number(args.max_hunk_chars) : 1200,
    })
    return { action, run_id: runId, artifact, ...result, findings: readFindings(cwd, runId).filter((row) => row.status === 'open').length }
  }

  throw new Error(`unhandled action ${action}`)
}

async function writeBlockedStep(cwd, runId, gate) {
  const next = nextPendingStep(cwd, runId)
  if (!next) return
  await markStep({ cwd, runId, step: next.step_id, status: 'blocked', detail: `gate ${gate} reported blocked` })
}

function statusOf(manifest, cwd, runId) {
  const steps = stepView(cwd, runId)
  if (steps.some((step) => step.status === 'blocked')) return 'blocked'
  if (steps.some((step) => step.status === 'failed')) return 'failed'
  if (steps.every((step) => ['done', 'skipped'].includes(step.status))) return 'complete'
  if (steps.some((step) => step.status === 'running')) return 'running'
  if (steps.every((step) => step.status === 'pending')) return 'prepared'
  return 'in_progress'
}

function gateDeps(cwd, runId, exec, args) {
  return {
    quoteStatus: buildQuoteStatus(cwd, runId),
    retractionFor: args?.skip_retraction_check ? undefined : buildRetraction(exec, { signal: exec?.signal }),
    consensusClaimed: async () => false,
    lociCoverage: async (_cwd, id) => {
      const loci = readArtifact({ cwd: _cwd, runId: id, name: 'loci' })
      if (!loci) return null
      const found = [...loci.text.matchAll(/^## (loc-\d+)/gmu)].map((match) => match[1])
      if (!found.length) return null
      return { covered: found.filter((locusId) => readArtifact({ cwd: _cwd, runId: id, name: `interim-${locusId}` })), missing: found.filter((locusId) => !readArtifact({ cwd: _cwd, runId: id, name: `interim-${locusId}` })).map((locusId) => locusId) }
    },
    numericCheck: async () => null,
    hygieneCheck: async (body) => {
      const leaks = []
      if (/<untrusted-source/u.test(body)) leaks.push('fenced source text left in the report')
      if (/```json/iu.test(body)) leaks.push('machine output left in the report')
      if (/\b(?:scaffold|canonical query|Register:)\b/u.test(body)) leaks.push('scaffold label echoed into the report')
      return { leaks }
    },
  }
}

/**
 * Long runs execute inside a host job so the chat stays responsive, progress is
 * visible while it works, and an abort actually stops the model calls in flight.
 * With no jobs service the same work runs inline on the call's own signal.
 */
async function runAsJob(ctx, exec, { kind, label, timeoutMs }, work) {
  const jobs = ctx?.jobs
  if (!jobs) return work(null, exec?.signal ?? null)
  const owner = exec?.agent?.id
  const controller = new AbortController()
  const onAbort = () => controller.abort('tool call aborted')
  if (exec?.signal?.aborted) controller.abort('tool call aborted')
  else exec?.signal?.addEventListener?.('abort', onAbort, { once: true })

  let resolveResult
  let rejectResult
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  resultPromise.catch(() => {})
  let settleOutcome
  const done = new Promise((resolve) => {
    settleOutcome = resolve
  })

  let jobId
  try {
    jobId = jobs.start({
      kind,
      label,
      ...(owner ? { owner } : {}),
      toolCall: { callId: exec?.callId, rootCallId: exec?.rootCallId },
      run: (job) => {
        void (async () => {
          let outcome
          try {
            const value = await work(job, controller.signal)
            resolveResult(value)
            outcome = { status: 'completed', detail: value?.status ?? 'completed', result: JSON.stringify(value)?.slice(0, 2000) }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            rejectResult(error)
            outcome = { status: controller.signal.aborted ? 'killed' : 'failed', detail: message }
          } finally {
            exec?.signal?.removeEventListener?.('abort', onAbort)
            settleOutcome(outcome)
          }
        })()
        return { done, cancel: (reason) => controller.abort(reason || 'cancelled') }
      },
    })
  } catch (error) {
    exec?.signal?.removeEventListener?.('abort', onAbort)
    throw error
  }

  try {
    let view
    try {
      view = await jobs.wait(jobId, timeoutMs, owner, exec?.signal)
    } catch (error) {
      try { jobs.kill(jobId, owner, 'tool call aborted') } catch { /* already settled */ }
      throw error
    }
    if (view.status === 'running' || view.status === 'stopping') {
      try { jobs.kill(jobId, owner, 'deep research timed out') } catch { /* already settled */ }
      try { await jobs.wait(jobId, 10_000, owner) } catch { /* already gone */ }
      throw new Error(`deep research timed out after ${Math.round(timeoutMs / 60_000)} minutes; the run is resumable with action=resume`)
    }
    if (view.status === 'killed') {
      throw new Error(`deep research cancelled${view.detail ? `: ${view.detail}` : ''}; the run is resumable with action=resume`)
    }
    const value = await resultPromise
    return { ...value, job_id: jobId }
  } finally {
    exec?.signal?.removeEventListener?.('abort', onAbort)
  }
}

/**
 * Progress rendering for the jobs panel.
 *
 * A run can take an hour and make dozens of model calls, so silence reads as a
 * hang. Every step start, every wave item, and every model call gets a line in
 * the `[NN%] [i/n step] detail` shape the panel already understands, and the
 * one-line progress label tracks it. The tail is also kept for hosts without a
 * jobs service, where nothing else would show what happened.
 */
function makeProgressSink(job, onLine) {
  const tail = []
  const emit = (line) => {
    if (!line) return
    tail.push(line)
    if (tail.length > 200) tail.shift()
    if (job) {
      job.append(`${line}\n`, { channel: 'stderr' })
    }
    if (onLine) onLine(line)
  }
  return {
    tail,
    emit,
    event(event) {
      if (!event?.step) return
      const place = event.step_index && event.total_steps ? `${event.step_index}/${event.total_steps}` : '—'
      const pct = String(event.percent ?? 0).padStart(2, ' ')
      const head = `[${pct}%] [${place} ${event.step}]`
      if (event.phase === 'model') {
        if (event.kind === 'request') {
          emit(`${head} → ${event.model ?? 'model'} call (${Math.round((event.prompt_chars ?? 0) / 100) / 10}k chars)…`)
          if (job) job.updateProgress(`${pct}% ${event.step} — model call`)
          return
        }
        if (event.kind === 'response') {
          const tokens = event.input_tokens || event.output_tokens
            ? ` · ${event.input_tokens ?? '?'} in / ${event.output_tokens ?? '?'} out`
            : ''
          emit(`${head} ← ${Math.round((event.ms ?? 0) / 100) / 10}s${tokens} · ${Math.round((event.completion_chars ?? 0) / 100) / 10}k chars`)
          return
        }
        emit(`${head} !! model call failed after ${Math.round((event.ms ?? 0) / 100) / 10}s: ${clip(event.message ?? 'unknown', 160)}`)
        return
      }
      if (event.status === 'running') {
        emit(`${head} start${event.detail ? ` — ${event.detail}` : ''}`)
        if (job) job.updateProgress(`${pct}% ${event.step}`)
        return
      }
      if (event.status === 'done' || event.status === 'failed' || event.status === 'blocked') {
        emit(`${head} ${event.status.toUpperCase()}${event.detail ? ` — ${event.detail}` : ''}`)
        if (job) job.updateProgress(`${pct}% ${event.step} ${event.status}`)
        return
      }
      if (event.done && event.total) {
        emit(`${head} ${event.phase} ${event.done}/${event.total}${event.detail ? ` — ${event.detail}` : ''}`)
        if (job) job.updateProgress(`${pct}% ${event.step}: ${event.phase} ${event.done}/${event.total}`)
      }
    },
  }
}

async function execute({ cwd, runId, args, exec, ctx, resume, signal = null, onProgress = null, injected = {} }) {
  const route = sessionRoute(exec)
  const manifest = readManifest(cwd, runId)
  const resumeTarget = nextPendingStep(cwd, runId)
  // Resume restarts a failed or interrupted step. It must not restart a *blocked*
  // one: a blocked step is a human decision, and silently running past it would
  // let a CRITICAL gate be bypassed by asking nicely.
  const fromStep = text(args.from_step)
    || (resume && resumeTarget && resumeTarget.status !== 'blocked' ? resumeTarget.step_id : null)
  // The manifest wins unless this call restates the option: `resume` carries no
  // retrieval flags, and a run that quietly stops fetching is worse than one
  // that never started.
  const frozen = manifest.execution ?? {}
  const sources = (Array.isArray(args.sources) && args.sources.length ? args.sources : frozen.sources) ?? null
  const email = text(args.contact_email) || frozen.contact_email || null
  const fetchText = args.fetch_full_text ?? frozen.fetch_full_text ?? false
  const searchFailures = []
  const search = buildSearch(exec, { sources, perSource: GEARS[manifest.gear].sources_per_perspective, signal, email, failures: searchFailures })
  const webFailures = []
  const deps = {
    search,
    // Only present when the level (or an override) asked for it: the sweep says
    // "web lane unavailable in this run" rather than pretending it found nothing.
    web: (args.web_lane ?? frozen.web_lane)
      ? buildWebSearch({
        signal,
        providers: Array.isArray(args.web_sources) && args.web_sources.length ? args.web_sources : frozen.web_sources,
        failures: webFailures,
      })
      : undefined,
    webFailures,
    fetch: buildFetch(cwd, runId, { signal, enabled: Boolean(fetchText), email }),
    quoteStatus: buildQuoteStatus(cwd, runId, { check: injected.quoteCheck ?? quoteCheck }),
    retractionFor: buildRetraction(exec, { signal }),
    searchFailures,
    // A test or an offline workspace supplies its own; nothing here is optional
    // at runtime, so a stub never quietly turns a verification into a pass.
    ...injected,
  }
  const result = await runSteps({
    cwd, runId, ctx, route, deps, signal, fromStep,
    maxSteps: Number.isFinite(Number(args.max_steps)) ? Number(args.max_steps) : null,
    onProgress,
  })
  const gospel = assertGospel(cwd, runId, readQuery(cwd, runId))
  return { ...result, query_ok: gospel.ok, next_step: nextPendingStep(cwd, runId), accounting: accounting(cwd, runId) }
}

function jobTimeoutMs(manifest) {
  const raw = manifest?.budget?.timeout_minutes
  const minutes = raw === null || raw === undefined || !Number.isFinite(Number(raw))
    ? DEFAULT_TIMEOUT_MINUTES
    : Math.min(Math.max(1, Number(raw)), MAX_TIMEOUT_MINUTES)
  return minutes * 60_000 + 60_000
}

/** Exported for tests and for a caller that wants to drive steps itself. */
export async function runDeepResearchAction(args, exec, ctx, deps = {}) {
  return runAction(args, exec, ctx, deps)
}

export const name = 'academic-harness-deep-research'
export const inject = ['tools', 'llm', 'jobs']

export function apply(ctx) {
  const define = {
    name: 'deep_research',
    description: [
      'Run a bounded, adversarially-audited deep research investigation and return a cited report.',
      'Actions: start (frame the brief and optionally run), run, resume, status, verify, export, list, record, gate, patch, answers.',
      'Usually only action, query and effort matter: effort=low|medium|high sets how much work the run does, and is inferred from the request when omitted.',
      'Retrieval reuses the existing literature router plus a web lane for guidance, registers, and reporting; fetched open-access text is deposited in PaperMemory, so quotes are checked against the library rather than a paraphrase.',
      'Tiers route query size: light is the bounded factual path, full runs the whole pipeline, dissertation is opt-in and chaptered.',
      'The run ledger freezes the query verbatim, resumes at the step that died, and counts independent voices rather than copies.',
      'verify reports PASS only for what was actually checked; anything unverifiable is disclosed as not_checked.',
      'Never invent a citation to fill a gap: an unsupported quote blocks the ship and an unacknowledged retraction blocks the ship.',
      'Load the `deep-research-pipeline` skill before driving a long run.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ACTIONS, description: 'What to do.' },
      run_id: { type: 'string', description: 'Target run. Defaults to the newest run in the workspace for read actions.' },
      query: { type: 'string', description: 'The user\'s request word for word. Required for start; it is frozen, re-read by every step, and used to infer the effort level — tidying it (dropping "quickly", softening "comprehensive") destroys the signal that decides cost, so pass it unedited.' },
      brief: {
        type: 'object',
        additionalProperties: false,
        description: 'Optional brief. Without research_questions the tool frames them from the query first.',
        properties: {
          topic: { type: 'string', description: 'What is being investigated.' },
          research_questions: { type: 'array', items: { type: 'string' }, description: '2-6 specific answerable questions. The conclusion must answer each one.' },
          angle: { type: 'string', description: 'The claim or tension the report argues.' },
          reader: { type: 'string', description: 'Who the report is written for.' },
          register: { type: 'string', enum: ['teach', 'survey', 'analyze', 'advocate'], description: 'Report voice. Verification never softens with it.' },
          inference_depth: { type: 'string', enum: ['surface', 'standard', 'deep'], description: 'How far to push inference.' },
          domain_notes: { type: 'string', description: 'Field-specific sourcing norms or recency window.' },
        },
      },
      direction: { type: 'string', description: 'Extra steering for question framing.' },
      run: { type: 'boolean', description: 'For start: execute the plan immediately instead of only preparing the run.' },
      effort: { type: 'string', enum: EFFORT_LEVELS, description: 'The one scale knob: low (minutes, abstracts and metadata), medium (a cited report with critics and full-text reading), high (the widest sweep and deepest critique). Omit it and the level is inferred from the request and reported back; pass it to be sure.' },
      confirm_effort: { type: 'boolean', description: 'Proceed even when the tool wanted to ask about cost. Set only after the user has answered.' },
      web_lane: { type: 'boolean', description: 'Advanced. Include the web/grey-literature pass. Defaults to off at low effort and on above it.' },
      tier: { type: 'string', enum: TIERS, description: 'Advanced override of the pipeline depth. Usually leave unset and pass effort instead.' },
      gear: { type: 'string', enum: Object.keys(GEARS), description: 'Advanced override of source and depth budgets. Usually leave unset and pass effort instead.' },
      sources: { type: 'array', description: 'Literature sources for the sweep. Default is auto selection per query.' },
      contact_email: { type: 'string', description: 'Optional polite-pool contact address for OpenAlex/Crossref/PDF resolution.' },
      web_sources: { type: 'array', description: 'Web providers for the grey-literature lane, in preference order: exa, tavily, brave, perplexity. Default exa, tavily, brave. Ones without a key are skipped and reported.' },
      fetch_full_text: { type: 'boolean', description: 'Retrieve open-access full text, deposit it in PaperMemory, and verify quotes verbatim. On at medium and high effort; pass false to skip the downloads.' },
      max_llm_calls: { type: 'number', description: 'Advanced override of the run call cap; effort already sets a sensible one. Crossing it blocks rather than continues.' },
      max_sources: { type: 'number', description: 'Advanced override of the corpus record cap.' },
      max_steps: { type: 'number', description: 'Run at most this many steps in this call.' },
      from_step: { type: 'string', description: 'Restart from a named step.' },
      timeout_minutes: { type: 'number', description: 'Advanced override of the wall-clock cap per run (1-720).' },
      acknowledged_retractions: { type: 'array', description: 'DOIs whose retraction the report already acknowledges.' },
      kind: { type: 'string', enum: RECORD_KINDS, description: 'For record: what to append to the ledger.' },
      records: {
        type: 'array',
        description: 'Corpus records for action=record.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', description: 'Required. A record with no title is refused.' },
            source: { type: 'string', description: 'Which index returned it.' },
            doi: { type: 'string', description: 'Distinct DOIs are never clustered together.' },
            url: { type: 'string' },
            year: { type: 'number' },
            citation_count: { type: 'number' },
            abstract: { type: 'string' },
            suggested_by: { type: 'string', description: 'Record id, step, or seed. Every source traces to what surfaced it.' },
          },
        },
      },
      claims: {
        type: 'array',
        description: 'Claims for action=record.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', description: 'Required.' },
            rq_id: { type: 'string', description: 'The research question this answers. Every question needs at least one claim.' },
            record_ids: { type: 'array', description: 'src- ids that support it.' },
            quote: { type: 'string', description: 'Verbatim span, checked against fetched text. Never paraphrase into this field.' },
            strength: { type: 'string', enum: ['supported', 'provisional', 'contested'] },
          },
        },
      },
      findings: {
        type: 'array',
        description: 'Findings for action=record. Anything missing severity, target, primary_check, or verifier is rejected rather than stored.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            severity: { type: 'string', enum: ['High', 'Medium', 'Low'] },
            title: { type: 'string' },
            reason: { type: 'string', description: 'What was inspected and found. Not a guess.' },
            target: { type: 'string', description: 'Smallest repairable thing: a section, artifact, or record id.' },
            primary_check: { type: 'string', description: 'Exactly one of angle, coverage, citation, taxonomy, calibration, weaving.' },
            verifier: { type: 'string', description: 'How a human confirms it is closed.' },
            evidence_state: { type: 'string', enum: ['observed', 'unobserved', 'not_checked'], description: 'unobserved is never promoted to a finding.' },
            step_id: { type: 'string' },
            suggested_hunk: {
              type: 'object',
              additionalProperties: false,
              properties: { find: { type: 'string' }, replace: { type: 'string' } },
              description: 'Optional surgical edit. Applied only through the capped patcher, never as a rewrite.',
            },
          },
        },
      },
      suggested_by: { type: 'string', description: 'What surfaced these records (a record id, a step, or seed).' },
      perspective: { type: 'string', description: 'Search perspective these records came from.' },
      gate: { type: 'string', description: 'For gate: angle, coverage, citation, taxonomy, calibration, weaving, locus_coverage, tier_routing.' },
      status: { type: 'string', enum: GATE_STATES, description: 'For gate: clear, flagged, blocked, not_checked.' },
      severity: { type: 'string', description: 'For gate: CRITICAL or MAJOR.' },
      reason: { type: 'string', description: 'For gate: what was inspected and found.' },
      route: { type: 'string', description: 'For gate: how to fix it.' },
      artifact: { type: 'string', description: 'For patch: artifact name. Default final_report.' },
      hunks: {
        type: 'array',
        description: 'Edits for action=patch.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            find: { type: 'string', description: 'Copied verbatim from the target and unique in it.' },
            replace: { type: 'string' },
          },
        },
      },
      finding_id: { type: 'string', description: 'For patch: the finding this hunk closes.' },
      format: { type: 'string', enum: EXPORT_FORMATS, description: 'For export: markdown, json, or csv.' },
      overwrite: { type: 'boolean', description: 'For export: replace an existing export file.' },
      skip_retraction_check: { type: 'boolean', description: 'Skip live retraction lookup in verify (offline or repeat runs).' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: (RENDERERS[value?.action] ?? ((input) => JSON.stringify(input, null, 2)))(value) }] },
    presentCall,
    async execute(args, exec) {
      try {
        return await runAction(args, exec, ctx)
      } catch (error) {
        return { action: args?.action ?? 'status', error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
  ctx.tools.register(defineTool(define))
}
