/** Preset-scoped composer tasks. Admission is a command; execution uses tool policy and owned jobs. */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { bindParentJob } from './job-runner.js'
import { resolveEffort } from './deep-research-effort.js'
import { artifactPath } from './deep-research-store.js'
import { sha256 } from './ledger-kit.js'
import { writeJsonAtomic } from './store-lock.js'
import { resolveWorkspacePath } from './workspace-path.js'
import { AUDIT_LIMITS, HYPOTHESIS_LIMITS, PAPER_LIMITS, REVIEW_TOPOLOGY, REVISION_COMPILE, TASK_COMMAND, validateTaskRequest } from './task-modes.js'

export const name = 'academic-harness-task'
export const inject = ['commands', 'tools', 'jobs', 'planMode']

const REVIEW_FOCUS_LIMIT = 4000
const REVIEW_FILE_LIMIT = 50 * 1024 * 1024

const TASK_LABELS = Object.freeze({
  deep_research: 'Deep Research',
  deep_review: 'Deep Review',
  find_papers: 'Find Papers',
  check_references: 'Check References',
  write_revise: 'Write / Revise',
  analyze_data: 'Analyze Data',
  generate_hypotheses: 'Generate Hypotheses',
})
const TASK_TOOLS = Object.freeze({
  deep_research: 'deep_research',
  deep_review: 'deep_review',
  find_papers: 'literature_search',
  check_references: 'citation',
  write_revise: 'manuscript_diff',
  analyze_data: 'analysis_run',
  generate_hypotheses: 'coscientist',
})
const TASK_FROM_TOOL = Object.freeze({
  deep_review: 'deep_review',
  literature_search: 'find_papers',
  citation: 'check_references',
  manuscript_diff: 'write_revise',
  analysis_run: 'analyze_data',
  coscientist: 'generate_hypotheses',
})
const PAPER_QUERY_LIMIT = 2000

function taskLabel(task) {
  return TASK_LABELS[task] || 'Deep Research'
}

function assertExecutionMode(ctx, agent, task = 'deep_research') {
  const mode = ctx.planMode.get(agent)
  if (mode.active || mode.pending) throw new Error(`${taskLabel(task)} cannot run in Plan mode. Switch to execution mode first.`)
}

/** First line is the workspace path; later lines are optional reviewer focus. The stored prompt stays verbatim. */
export function reviewPromptParts(prompt) {
  const text = String(prompt ?? '')
  const breakAt = text.indexOf('\n')
  const path = (breakAt === -1 ? text : text.slice(0, breakAt)).trim()
  const focus = breakAt === -1 ? '' : text.slice(breakAt + 1).trim()
  if (!path) throw new Error('enter a manuscript path first')
  if (focus.length > REVIEW_FOCUS_LIMIT) throw new Error(`focus is limited to ${REVIEW_FOCUS_LIMIT} characters`)
  return { path, focus }
}

const MANUSCRIPT_EXT = new Set(['tex', 'md', 'markdown', 'qmd', 'rmd'])

/** First line is the bibliography. The second line is an optional manuscript. The stored prompt stays verbatim. */
export function referencePromptParts(prompt) {
  const lines = String(prompt ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
  if (!lines.length) throw new Error('enter a bibliography path first')
  if (lines.length > 2) throw new Error('Check References takes a bibliography path and an optional manuscript path')
  const path = lines[0]
  const manuscript = lines[1] || ''
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : ''
  if (!manuscript && MANUSCRIPT_EXT.has(ext)) throw new Error('put the bibliography path on the first line; a manuscript path is optional on the second line')
  return { path, manuscript }
}

const REVISION_EXT = new Set(['tex', 'md', 'txt', 'markdown'])
const SLUG_LINE = /^[a-z0-9][a-z0-9-]{0,40}$/u
const TASK_BODY_LIMIT = 8000

/** Two workspace paths: the earlier manuscript, then the revised one. */
export function revisionPaths(prompt) {
  const lines = String(prompt ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length !== 2) throw new Error('Write / Revise compares two manuscript versions. Put the earlier file on the first line and the revised file on the second.')
  if (lines[0] === lines[1]) throw new Error('the two manuscript paths must differ')
  for (const path of lines) {
    const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : ''
    if (!REVISION_EXT.has(ext)) throw new Error('Write / Revise compares .tex, .md, or .txt versions')
  }
  return { old: lines[0], next: lines[1] }
}

/** An optional slug on the first line, then the question or goal. Otherwise the slug is derived. */
export function slugAndBody(prompt, { empty, prefix }) {
  const text = String(prompt ?? '')
  const breakAt = text.indexOf('\n')
  const first = (breakAt === -1 ? text : text.slice(0, breakAt)).trim()
  const rest = breakAt === -1 ? '' : text.slice(breakAt + 1).trim()
  const body = rest && SLUG_LINE.test(first) ? rest : text.trim()
  if (!body) throw new Error(empty)
  if (body.length > TASK_BODY_LIMIT) throw new Error(`this task is limited to ${TASK_BODY_LIMIT} characters`)
  const slug = rest && SLUG_LINE.test(first) ? first : `${prefix}-${sha256(body).slice(0, 12)}`
  return { slug, body }
}

function assertWorkspaceFile(cwd, path) {
  let abs
  try {
    abs = resolveWorkspacePath(cwd, path)
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
  let stat
  try {
    stat = statSync(abs)
  } catch {
    throw new Error(`file not found: ${path}`)
  }
  if (!stat.isFile()) throw new Error(`not a file: ${path}`)
  if (stat.size > REVIEW_FILE_LIMIT) throw new Error(`file is larger than 50 MB: ${path}`)
}

function taskFile(agent, id) {
  const cwd = agent.session.header.cwd
  if (typeof cwd !== 'string' || !cwd) throw new Error('task requires a workspace')
  return resolveWorkspacePath(cwd, `.dsh/tasks/${sha256(agent.id).slice(0, 24)}/${id}.json`, { forWrite: true })
}

/** Execute through the published policy pipeline on DSH 0.2.1 and 0.2.2. Never call a tool body directly. */
export async function executeTaskTool(ctx, agent, signal, toolName, args, task, hostJob) {
  const resolved = task || TASK_FROM_TOOL[toolName] || 'deep_research'
  assertExecutionMode(ctx, agent, resolved)
  signal.throwIfAborted()
  const callId = `task-${randomUUID()}`
  // The composer task already has a row. A nested engine job would show a second one.
  const releaseParent = bindParentJob(callId, hostJob)
  const label = taskLabel(resolved)
  try {
    // 0.2.2 split the batch executor from the registry and added step admission.
    const result = typeof ctx.tools.resolve === 'function'
      ? (await ctx.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id: callId, name: toolName, arguments: JSON.stringify(args) }] })).results[0]?.result
      : await ctx.tools.execute({ agent, signal, callId, name: toolName, arguments: args })
    if (!result || result.isError) throw new Error(result?.error?.message || `${label} was refused by tool policy`)
    const value = result.value
    if (!value || typeof value !== 'object') throw new Error(`${label} returned no structured result`)
    if (value.error) throw new Error(String(value.error))
    return value
  } finally {
    releaseParent()
  }
}

function accepted(record, file, cwd) {
  const task = record.request?.task
  const title = taskLabel(task)
  const run = task === 'deep_review'
    ? (record.review_key ? `\nReview: ${record.review_key}` : '')
    : task === 'find_papers'
      ? (record.paper_count != null ? `\nPapers: ${record.paper_count}` : '')
      : task === 'check_references'
        ? (record.reference_count != null ? `\nReferences: ${record.reference_count}` : '')
        : task === 'write_revise'
          ? (record.diff_path ? `\nDiff: ${record.diff_path}` : '')
          : task === 'analyze_data'
            ? (record.analysis_slug ? `\nAnalysis: ${record.analysis_slug}` : '')
            : task === 'generate_hypotheses'
              ? (record.tournament_slug ? `\nTournament: ${record.tournament_slug}` : '')
              : (record.run_id ? `\nResearch run: ${record.run_id}` : '')
  const resume = task === 'deep_review'
    ? 'inspect the stored deep review before explicitly running it again.'
    : task === 'find_papers'
      ? 'inspect the background job for the paper list before running it again.'
      : task === 'check_references'
        ? 'inspect the background job for the reference findings before running it again.'
        : task === 'write_revise'
          ? 'inspect the diff artifact before running it again. Neither manuscript is edited.'
          : task === 'analyze_data'
            ? 'inspect the frozen analysis plan before running it again. No command has run.'
            : task === 'generate_hypotheses'
              ? 'inspect the tournament before running it again. No hypothesis text has been written.'
              : 'inspect the stored research run before explicitly resuming.'
  return {
    kind: 'success',
    text: `${title} — recorded task status: ${record.status}.\nJob: ${record.job_id || 'registration failed or pending'}\nTask: ${relative(cwd, file)}${run}\nFollow progress and stop live work in Background jobs. An already accepted request is never started again automatically; after a host restart, ${resume}`,
  }
}

/** Validate and accept one idempotent task. Request ids are scoped to the receiving session. */
export function submitAcademicTask(ctx, invocation) {
  const { agent, signal } = invocation
  try {
    signal.throwIfAborted()
    if (invocation.rawInput.length > 400_000) throw new Error('task request is too large')
    const request = validateTaskRequest(JSON.parse(invocation.rawInput))
    const label = taskLabel(request.task)
    assertExecutionMode(ctx, agent, request.task)
    if (invocation.attachments?.length) {
      const attachment = request.task === 'deep_review'
        ? 'Deep Review takes a manuscript path. Remove attachments before sending.'
        : request.task === 'find_papers'
          ? 'Find Papers takes a search query. Remove attachments before sending.'
          : request.task === 'check_references'
            ? 'Check References takes a bibliography path. Remove attachments before sending.'
            : request.task === 'write_revise'
              ? 'Write / Revise takes two manuscript paths. Remove attachments before sending.'
              : request.task === 'analyze_data'
                ? 'Analyze Data takes an analysis question. Remove attachments before sending.'
                : request.task === 'generate_hypotheses'
                  ? 'Generate Hypotheses takes a research goal. Remove attachments before sending.'
                  : 'Deep Research takes a text question. Remove attachments before sending.'
      throw new Error(attachment)
    }
    const toolName = TASK_TOOLS[request.task] || 'deep_research'
    if (!ctx.tools.get(toolName, agent)) throw new Error(`${label} is not available on this preset`)
    const file = taskFile(agent, request.request_id)
    const fingerprint = sha256(request)
    let previous
    try { previous = JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('request_id already belongs to a different task')
      // Even after a host restart, an accepted id never starts a second costly run.
      return accepted(previous, file, agent.session.header.cwd)
    }
    const effort = request.options.effort
    let review = null
    let revision = null
    let analysis = null
    let tournament = null
    if (request.task === 'deep_review') {
      review = reviewPromptParts(request.prompt)
      assertWorkspaceFile(agent.session.header.cwd, review.path)
    } else if (request.task === 'check_references') {
      review = referencePromptParts(request.prompt)
      assertWorkspaceFile(agent.session.header.cwd, review.path)
      if (review.manuscript) assertWorkspaceFile(agent.session.header.cwd, review.manuscript)
    } else if (request.task === 'write_revise') {
      revision = revisionPaths(request.prompt)
      assertWorkspaceFile(agent.session.header.cwd, revision.old)
      assertWorkspaceFile(agent.session.header.cwd, revision.next)
    } else if (request.task === 'analyze_data') {
      analysis = slugAndBody(request.prompt, { empty: 'enter an analysis question first', prefix: 'analysis' })
    } else if (request.task === 'generate_hypotheses') {
      tournament = slugAndBody(request.prompt, { empty: 'enter a research goal first', prefix: 'hypotheses' })
    } else if (request.task === 'find_papers') {
      const query = request.prompt.trim()
      if (!query) throw new Error('enter a search query first')
      if (query.length > PAPER_QUERY_LIMIT) throw new Error(`search query exceeds ${PAPER_QUERY_LIMIT} characters`)
    } else {
      const level = resolveEffort({ query: request.prompt, effort: effort === 'auto' ? null : effort })
      if (level.conflict && effort === 'auto') return { kind: 'error', text: `${level.ask_user}\nChoose Low, Medium, or High in the effort selector, then send the same question again. Nothing has run.` }
    }
    const record = {
      version: 1, request, fingerprint, session_id: agent.id,
      status: 'accepted', created_at: new Date().toISOString(), job_id: null, run_id: null,
    }
    mkdirSync(dirname(file), { recursive: true })
    // Exclusive reservation survives lost acknowledgments, concurrent clients, and restarts.
    try { writeFileSync(file, JSON.stringify(record, null, 2), { flag: 'wx' }) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const existing = JSON.parse(readFileSync(file, 'utf8'))
      if (existing.fingerprint !== fingerprint) throw new Error('request_id already belongs to a different task')
      return accepted(existing, file, agent.session.header.cwd)
    }
    const save = (patch) => {
      Object.assign(record, patch, { updated_at: new Date().toISOString() })
      writeJsonAtomic(file, record)
    }
    const controller = new AbortController()
    const cwd = agent.session.header.cwd
    try {
      const papersLimit = PAPER_LIMITS[effort]
      const auditLimit = AUDIT_LIMITS[effort]
      const hypothesisLimit = HYPOTHESIS_LIMITS[effort]
      const compile = Object.hasOwn(REVISION_COMPILE, effort) ? REVISION_COMPILE[effort] : undefined
      const jobId = ctx.jobs.start(request.task === 'write_revise'
        ? {
          kind: 'manuscript-diff', owner: agent.id, label: `Write / Revise: ${revision.next.slice(0, 80)}`,
          run(job) {
            const done = Promise.resolve().then(async () => {
              try {
                save({ status: 'running' })
                job.updateProgress(`Comparing ${revision.old} with ${revision.next}`)
                const result = await executeTaskTool(ctx, agent, controller.signal, 'manuscript_diff', {
                  action: 'diff', old: revision.old, new: revision.next,
                  ...(compile === undefined ? {} : { compile }),
                }, 'write_revise', job)
                const status = controller.signal.aborted ? 'cancelled' : 'complete'
                save({ status, diff_path: result.out ?? null, finished_at: new Date().toISOString() })
                const detail = `Write / Revise ${status}: diff ${result.out || `${revision.old} → ${revision.next}`}. Neither manuscript was edited.`
                job.append(`${detail}\n`)
                return { status: status === 'cancelled' ? 'killed' : 'completed', detail, result: JSON.stringify({ out: result.out ?? null, task_path: relative(cwd, file) }) }
              } catch (error) {
                const status = controller.signal.aborted ? 'cancelled' : 'failed'
                const message = error instanceof Error ? error.message : String(error)
                save({ status, error: message, finished_at: new Date().toISOString() })
                job.append(`${status}: ${message}\n`)
                return { status: status === 'cancelled' ? 'killed' : 'failed', detail: message }
              }
            })
            return { done, cancel: (reason) => controller.abort(reason || 'cancelled') }
          },
        }
        : request.task === 'analyze_data'
        ? {
          kind: 'analysis-plan', owner: agent.id, label: `Analyze Data: ${analysis.slug}`,
          run(job) {
            const done = Promise.resolve().then(async () => {
              try {
                save({ status: 'running' })
                job.updateProgress(`Freezing analysis plan ${analysis.slug}`)
                const result = await executeTaskTool(ctx, agent, controller.signal, 'analysis_run', {
                  action: 'plan', slug: analysis.slug, plan: { question: analysis.body },
                }, 'analyze_data', job)
                const status = controller.signal.aborted ? 'cancelled' : 'complete'
                save({ status, analysis_slug: result.slug || analysis.slug, plan_version: result.version ?? null, finished_at: new Date().toISOString() })
                const detail = `Analyze Data ${status}: plan ${result.slug || analysis.slug}${result.version != null ? ` v${result.version}` : ''}. No command ran.`
                job.append(`${detail}\n`)
                return { status: status === 'cancelled' ? 'killed' : 'completed', detail, result: JSON.stringify({ slug: result.slug || analysis.slug, version: result.version ?? null, task_path: relative(cwd, file) }) }
              } catch (error) {
                const status = controller.signal.aborted ? 'cancelled' : 'failed'
                const message = error instanceof Error ? error.message : String(error)
                save({ status, error: message, finished_at: new Date().toISOString() })
                job.append(`${status}: ${message}\n`)
                return { status: status === 'cancelled' ? 'killed' : 'failed', detail: message }
              }
            })
            return { done, cancel: (reason) => controller.abort(reason || 'cancelled') }
          },
        }
        : request.task === 'generate_hypotheses'
        ? {
          kind: 'hypothesis-tournament', owner: agent.id, label: `Generate Hypotheses: ${tournament.slug}`,
          run(job) {
            const done = Promise.resolve().then(async () => {
              try {
                save({ status: 'running' })
                job.updateProgress(`Opening tournament ${tournament.slug}`)
                const result = await executeTaskTool(ctx, agent, controller.signal, 'coscientist', {
                  action: 'start', slug: tournament.slug, goal: tournament.body,
                  ...(hypothesisLimit ? { max_hypotheses: hypothesisLimit } : {}),
                }, 'generate_hypotheses', job)
                const status = controller.signal.aborted ? 'cancelled' : 'complete'
                const slug = result.slug || tournament.slug
                save({ status, tournament_slug: slug, finished_at: new Date().toISOString() })
                const detail = `Generate Hypotheses ${status}: tournament ${slug}. The ledger is open; no hypothesis text was written.`
                job.append(`${detail}\n`)
                return { status: status === 'cancelled' ? 'killed' : 'completed', detail, result: JSON.stringify({ slug, task_path: relative(cwd, file) }) }
              } catch (error) {
                const status = controller.signal.aborted ? 'cancelled' : 'failed'
                const message = error instanceof Error ? error.message : String(error)
                save({ status, error: message, finished_at: new Date().toISOString() })
                job.append(`${status}: ${message}\n`)
                return { status: status === 'cancelled' ? 'killed' : 'failed', detail: message }
              }
            })
            return { done, cancel: (reason) => controller.abort(reason || 'cancelled') }
          },
        }
        : request.task === 'check_references'
        ? {
          kind: 'citation-audit', owner: agent.id, label: `Check References: ${review.path.slice(0, 100)}`,
          run(job) {
            const done = Promise.resolve().then(async () => {
              try {
                save({ status: 'running' })
                job.updateProgress(`Auditing ${review.path}${auditLimit ? ` (${auditLimit} online)` : ''}`)
                const result = await executeTaskTool(ctx, agent, controller.signal, 'citation', {
                  action: 'audit', path: review.path,
                  ...(review.manuscript ? { manuscript: review.manuscript } : {}),
                  ...(auditLimit ? { max_audit: auditLimit } : {}),
                }, 'check_references', job)
                const counts = result.counts && typeof result.counts === 'object' ? result.counts : {}
                const status = controller.signal.aborted ? 'cancelled' : 'complete'
                save({
                  status, reference_count: result.count ?? null, finding_counts: counts,
                  finished_at: new Date().toISOString(),
                })
                const flagged = (Array.isArray(result.references) ? result.references : [])
                  .filter((item) => item.status === 'problem' || item.status === 'review')
                  .slice(0, 8)
                  .map((item) => `- ${item.status} ${item.key || 'entry'}`)
                const detail = `Check References ${status}: ${result.count ?? 0} reference(s). ${counts.problem ?? 0} problem, ${counts.review ?? 0} review, ${counts.unverified ?? 0} unverified, ${counts.no_issues_found ?? 0} no issues found.`
                job.append(`${detail}\n${flagged.join('\n')}${flagged.length ? '\n' : ''}`)
                return { status: status === 'cancelled' ? 'killed' : 'completed', detail, result: JSON.stringify({ count: result.count ?? null, counts, task_path: relative(cwd, file) }) }
              } catch (error) {
                const status = controller.signal.aborted ? 'cancelled' : 'failed'
                const message = error instanceof Error ? error.message : String(error)
                save({ status, error: message, finished_at: new Date().toISOString() })
                job.append(`${status}: ${message}\n`)
                return { status: status === 'cancelled' ? 'killed' : 'failed', detail: message }
              }
            })
            return { done, cancel: (reason) => controller.abort(reason || 'cancelled') }
          },
        }
        : request.task === 'find_papers'
        ? {
          kind: 'literature-search', owner: agent.id, label: `Find Papers: ${request.prompt.trim().slice(0, 100)}`,
          run(job) {
            const done = Promise.resolve().then(async () => {
              try {
                save({ status: 'running' })
                const query = request.prompt.trim()
                job.updateProgress(`Searching for “${query.slice(0, 80)}”${papersLimit ? ` (${papersLimit})` : ''}`)
                const result = await executeTaskTool(ctx, agent, controller.signal, 'literature_search', {
                  query,
                  ...(papersLimit ? { max_results: papersLimit } : {}),
                }, 'find_papers', job)
                const papers = Array.isArray(result.papers) ? result.papers : []
                const status = controller.signal.aborted ? 'cancelled' : 'complete'
                save({
                  status, paper_count: papers.length, total_unique: result.total_unique ?? null,
                  sources: result.sources ?? null, finished_at: new Date().toISOString(),
                })
                const lines = papers.slice(0, 8).map((paper) => `- ${String(paper.title || 'Untitled').slice(0, 180)}${paper.year ? ` (${paper.year})` : ''}`)
                const detail = `Find Papers ${status}: ${papers.length} paper(s).${result.total_unique != null ? ` ${result.total_unique} unique before the cap.` : ''}`
                job.append(`${detail}\n${lines.join('\n')}${lines.length ? '\n' : ''}`)
                return { status: status === 'cancelled' ? 'killed' : 'completed', detail, result: JSON.stringify({ query, total_unique: result.total_unique ?? null, sources: result.sources ?? null, paper_count: papers.length, task_path: relative(cwd, file) }) }
              } catch (error) {
                const status = controller.signal.aborted ? 'cancelled' : 'failed'
                const message = error instanceof Error ? error.message : String(error)
                save({ status, error: message, finished_at: new Date().toISOString() })
                job.append(`${status}: ${message}\n`)
                return { status: status === 'cancelled' ? 'killed' : 'failed', detail: message }
              }
            })
            return { done, cancel: (reason) => controller.abort(reason || 'cancelled') }
          },
        }
        : request.task === 'deep_review'
        ? {
          kind: 'deep-review', owner: agent.id, label: `Deep Review: ${review.path.slice(0, 100)}`,
          run(job) {
            const done = Promise.resolve().then(async () => {
              try {
                save({ status: 'running' })
                const topology = REVIEW_TOPOLOGY[effort]
                job.updateProgress(`Reviewing ${review.path}${topology ? ` at ${topology}` : ''}`)
                const result = await executeTaskTool(ctx, agent, controller.signal, 'deep_review', {
                  action: 'review', path: review.path,
                  ...(review.focus ? { focus: review.focus } : {}),
                  ...(topology ? { topology } : {}),
                }, 'deep_review', job)
                const status = controller.signal.aborted ? 'cancelled' : 'complete'
                save({
                  status, review_key: result.key ?? null, review_dir: result.dir ?? null,
                  round: result.round ?? null, engine_job_id: result.job_id ?? null,
                  finished_at: new Date().toISOString(),
                })
                const detail = `Deep Review ${status}: ${result.dir || review.path}.${result.round ? ` Round ${result.round}.` : ''} Inspect deep_review status for the stored review.`
                job.append(`${detail}\n`)
                return { status: status === 'cancelled' ? 'killed' : 'completed', detail, result: JSON.stringify({ ...result, task_path: relative(cwd, file) }) }
              } catch (error) {
                const status = controller.signal.aborted ? 'cancelled' : 'failed'
                const message = error instanceof Error ? error.message : String(error)
                save({ status, error: message, finished_at: new Date().toISOString() })
                job.append(`${status}: ${message}${record.review_key ? `\nStored review: ${record.review_key}` : ''}\n`)
                return { status: status === 'cancelled' ? 'killed' : 'failed', detail: message }
              }
            })
            return { done, cancel: (reason) => controller.abort(reason || 'cancelled') }
          },
        }
        : {
          kind: 'deep-research', owner: agent.id, label: `Deep Research: ${request.prompt.trim().slice(0, 100)}`,
          run(job) {
            // Defer work until registration and the task/job link have committed.
            const done = Promise.resolve().then(async () => {
              try {
                save({ status: 'running' })
                job.updateProgress('Framing research questions')
                const start = await executeTaskTool(ctx, agent, controller.signal, 'deep_research', {
                  action: 'start', query: request.prompt, run: false,
                  ...(effort === 'auto' ? {} : { effort }),
                }, 'deep_research', job)
                if (start.status === 'needs_input') throw new Error(start.ask_user)
                if (!start.run_id) throw new Error('Deep Research did not return a run id')
                save({ run_id: start.run_id, effort: start.effort })
                job.append(`Research run: ${start.run_id}\nEffort: ${start.effort}\n${start.expectation || ''}\n`)
                job.updateProgress(`Running ${start.run_id}`)
                const result = await executeTaskTool(ctx, agent, controller.signal, 'deep_research', { action: 'run', run_id: start.run_id }, 'deep_research', job)
                const status = controller.signal.aborted ? 'cancelled' : (result.status || 'failed')
                save({ status, engine_job_id: result.job_id ?? null, finished_at: new Date().toISOString() })
                const report = relative(cwd, artifactPath(cwd, start.run_id, 'final_report'))
                const audit = result.citation_note ? ` Citation audit: ${result.citation_note}.` : ''
                const access = result.access_path ? ` Source access: ${result.access_path}.` : ''
                const detail = `Deep Research ${status}: ${start.run_id}. ${status === 'complete' ? `Report: ${report}.${audit}${access}` : `The stored run is ${status}; inspect deep_research status before resuming.`}`
                job.append(`${detail}\n`)
                return { status: status === 'cancelled' ? 'killed' : status === 'complete' ? 'completed' : 'failed', detail, result: JSON.stringify({ ...result, task_path: relative(cwd, file) }) }
              } catch (error) {
                const status = controller.signal.aborted ? 'cancelled' : 'failed'
                const message = error instanceof Error ? error.message : String(error)
                save({ status, error: message, finished_at: new Date().toISOString() })
                job.append(`${status}: ${message}${record.run_id ? `\nStored research run: ${record.run_id}` : ''}\n`)
                return { status: status === 'cancelled' ? 'killed' : 'failed', detail: message }
              }
            })
            return { done, cancel: (reason) => controller.abort(reason || 'cancelled') }
          },
        })
      save({ job_id: jobId })
    } catch (error) {
      controller.abort('task registration failed')
      save({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
      throw error
    }
    return accepted(record, file, agent.session.header.cwd)
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.commands.register({
    name: TASK_COMMAND,
    description: 'Submit an explicitly selected Academic Harness task.',
    input: { hint: 'Structured task request from the chatbox task selector' },
    handler: (invocation) => submitAcademicTask(ctx, invocation),
  }), 'academic-harness: composer tasks')
}
