/** Preset-scoped composer tasks. Admission is a command; execution uses tool policy and owned jobs. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveEffort } from './deep-research-effort.js'
import { artifactPath } from './deep-research-store.js'
import { sha256 } from './ledger-kit.js'
import { writeJsonAtomic } from './store-lock.js'
import { resolveWorkspacePath } from './workspace-path.js'
import { TASK_COMMAND, validateTaskRequest } from './task-modes.js'

export const name = 'academic-harness-task'
export const inject = ['commands', 'tools', 'jobs', 'planMode']

function assertExecutionMode(ctx, agent) {
  const mode = ctx.planMode.get(agent)
  if (mode.active || mode.pending) throw new Error('Deep Research cannot run in Plan mode. Switch to execution mode first.')
}

function taskFile(agent, id) {
  const cwd = agent.session.header.cwd
  if (typeof cwd !== 'string' || !cwd) throw new Error('task requires a workspace')
  return resolveWorkspacePath(cwd, `.dsh/tasks/${sha256(agent.id).slice(0, 24)}/${id}.json`, { forWrite: true })
}

/** Execute through the published policy pipeline on DSH 0.2.1 and 0.2.2. Never call a tool body directly. */
export async function executeTaskTool(ctx, agent, signal, args) {
  assertExecutionMode(ctx, agent)
  signal.throwIfAborted()
  const callId = `task-${randomUUID()}`
  // 0.2.2 split the batch executor from the registry and added step admission.
  const result = typeof ctx.tools.resolve === 'function'
    ? (await ctx.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id: callId, name: 'deep_research', arguments: JSON.stringify(args) }] })).results[0]?.result
    : await ctx.tools.execute({ agent, signal, callId, name: 'deep_research', arguments: args })
  if (!result || result.isError) throw new Error(result?.error?.message || 'Deep Research was refused by tool policy')
  const value = result.value
  if (!value || typeof value !== 'object') throw new Error('Deep Research returned no structured result')
  if (value.error) throw new Error(String(value.error))
  return value
}

function accepted(record, file, cwd) {
  return {
    kind: 'success',
    text: `Deep Research — recorded task status: ${record.status}.\nJob: ${record.job_id || 'registration failed or pending'}\nTask: ${relative(cwd, file)}${record.run_id ? `\nResearch run: ${record.run_id}` : ''}\nFollow progress and stop live work in Background jobs. An already accepted request is never started again automatically; after a host restart, inspect the stored research run before explicitly resuming.`,
  }
}

/** Validate and accept one idempotent task. Request ids are scoped to the receiving session. */
export function submitAcademicTask(ctx, invocation) {
  const { agent, signal } = invocation
  try {
    signal.throwIfAborted()
    assertExecutionMode(ctx, agent)
    if (invocation.attachments?.length) throw new Error('Deep Research takes a text question. Remove attachments before sending.')
    if (invocation.rawInput.length > 400_000) throw new Error('task request is too large')
    const request = validateTaskRequest(JSON.parse(invocation.rawInput))
    if (!ctx.tools.get('deep_research', agent)) throw new Error('Deep Research is not available on this preset')
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
    const level = resolveEffort({ query: request.prompt, effort: effort === 'auto' ? null : effort })
    if (level.conflict && effort === 'auto') return { kind: 'error', text: `${level.ask_user}\nChoose Low, Medium, or High in the effort selector, then send the same question again. Nothing has run.` }
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
    try {
      const jobId = ctx.jobs.start({
        kind: 'deep-research', owner: agent.id, label: `Deep Research: ${request.prompt.trim().slice(0, 100)}`,
        run(job) {
          // Defer work until registration and the task/job link have committed.
          const done = Promise.resolve().then(async () => {
            try {
              save({ status: 'running' })
              job.updateProgress('Framing research questions')
              const start = await executeTaskTool(ctx, agent, controller.signal, {
                action: 'start', query: request.prompt, run: false,
                ...(effort === 'auto' ? {} : { effort }),
              })
              if (start.status === 'needs_input') throw new Error(start.ask_user)
              if (!start.run_id) throw new Error('Deep Research did not return a run id')
              save({ run_id: start.run_id, effort: start.effort })
              job.append(`Research run: ${start.run_id}\nEffort: ${start.effort}\n${start.expectation || ''}\n`)
              job.updateProgress(`Running ${start.run_id}; expand its research job for step-by-step progress`)
              const result = await executeTaskTool(ctx, agent, controller.signal, { action: 'run', run_id: start.run_id })
              const status = controller.signal.aborted ? 'cancelled' : (result.status || 'failed')
              save({ status, engine_job_id: result.job_id ?? null, finished_at: new Date().toISOString() })
              const report = relative(agent.session.header.cwd, artifactPath(agent.session.header.cwd, start.run_id, 'final_report'))
              const detail = `Deep Research ${status}: ${start.run_id}. ${status === 'complete' ? `Report: ${report}` : `The stored run is ${status}; inspect deep_research status before resuming.`}`
              job.append(`${detail}\n`)
              return { status: status === 'cancelled' ? 'killed' : status === 'complete' ? 'completed' : 'failed', detail, result: JSON.stringify({ ...result, task_path: relative(agent.session.header.cwd, file) }) }
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
