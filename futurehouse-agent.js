/**
 * FutureHouse agents, now hosted on the Edison Scientific platform
 * (https://api.platform.edisonscientific.com). Crow/Falcon/Owl map to the
 * paperqa3 literature, literature-high, and precedent jobs.
 *
 * Tasks are asynchronous: `action=start` posts to `/v0.1/crows` and returns a
 * trajectory ID; `action=status` polls `/v0.1/trajectories/{id}`; `action=cancel`
 * cancels. Never block waiting for an agent to finish — poll from a later turn.
 *
 * Auth is a two-step exchange: POST /auth/login with FUTUREHOUSE_API_KEY, then
 * use the returned bearer token. Tokens are cached for five minutes and
 * refreshed once on a 401/403.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { capText } from './search-normalize.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'

const BASE = 'https://api.platform.edisonscientific.com'
const JOBS = {
  quick_search: 'job-futurehouse-paperqa3',
  deep_search: 'job-futurehouse-paperqa3-high',
  precedent_search: 'job-futurehouse-paperqa3-precedent',
}
const AGENTS = Object.keys(JOBS)
const ACTIONS = ['start', 'status', 'cancel']
const TERMINAL = new Set(['success', 'fail', 'cancelled', 'truncated'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN_TTL_MS = 5 * 60 * 1000
const tokens = new Map()

export function resetFutureHouseTokensForTests() {
  tokens.clear()
}

export function buildCreateBody(args) {
  const agent = args.agent
  if (!AGENTS.includes(agent)) throw new Error(`agent must be one of ${AGENTS.join(', ')}`)
  const query = String(args.query || '').trim()
  if (!query) throw new Error('query is required for action=start')
  return { name: JOBS[agent], query }
}

async function authToken(apiKey, signal) {
  const cached = tokens.get(apiKey)
  if (cached && cached.expiresAt > Date.now()) return cached.token

  const limiter = getLimiter('futurehouse-auth', { minIntervalMs: 250 })
  const result = await limiter.run(() => fetchJson(`${BASE}/auth/login`, {
    method: 'POST',
    retries: 0,
    timeoutMs: 30_000,
    signal,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': searchUserAgent(),
    },
    body: JSON.stringify({ api_key: apiKey }),
  }))
  if (!result.ok) {
    throw new Error(`FutureHouse/Edison authentication failed (${result.status}); check FUTUREHOUSE_API_KEY${result.detail ? `: ${result.detail}` : ''}`)
  }
  const token = result.data?.access_token
  if (!token) throw new Error('FutureHouse authentication returned no access_token')
  tokens.set(apiKey, { token, expiresAt: Date.now() + TOKEN_TTL_MS })
  return token
}

async function authorizedRequest(path, { method = 'GET', body, apiKey, signal } = {}) {
  const send = async () => {
    const token = await authToken(apiKey, signal)
    const limiter = getLimiter('futurehouse', { minIntervalMs: 250 })
    return limiter.run(() => fetchJson(`${BASE}${path}`, {
      method,
      retries: 0,
      timeoutMs: 60_000,
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': searchUserAgent(),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }))
  }

  let result = await send()
  if (result.status === 401 || result.status === 403) {
    tokens.delete(apiKey)
    result = await send()
  }
  return result
}

export function summarizeTask(task) {
  const state = task?.environment_frame?.state?.state || {}
  const answer = state.response?.answer || {}
  return {
    status: task?.status || null,
    job_name: task?.crow || task?.job_name || null,
    query: task?.task || task?.query || null,
    answer: answer.answer ?? task?.answer ?? null,
    formatted_answer: answer.formatted_answer ?? null,
    answer_reasoning: answer.answer_reasoning ?? null,
    has_successful_answer: answer.has_successful_answer ?? null,
    total_cost: state.info?.usage?.total_cost ?? null,
    total_queries: state.info?.usage?.total_queries ?? null,
    error: task?.error ?? state.error ?? null,
  }
}

function apiError(label, result) {
  if (result.error === 'aborted') return { error: 'request cancelled' }
  return {
    error: `FutureHouse ${label} error ${result.status}`,
    status: result.status,
    detail: result.detail ?? result.error,
  }
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (value.action === 'start') {
    return [{
      type: 'text',
      text: `Started FutureHouse ${value.agent} task ${value.task_id} (${value.job_name}).\nPoll with action="status" and task_id="${value.task_id}" in a later turn — these agents can take minutes.`,
    }]
  }
  const bits = [`FutureHouse task ${value.task_id}: ${value.status || 'unknown'}`]
  const answer = value.formatted_answer || value.answer
  if (answer) bits.push(answer)
  if (!answer && !TERMINAL.has(value.status)) bits.push('Still running. Poll again with action="status" in a later turn.')
  if (!answer && TERMINAL.has(value.status)) bits.push('The task finished without an answer.')
  if (value.error) bits.push(`Task error: ${value.error}`)
  return [{ type: 'text', text: capText(bits.join('\n\n'), 20_000) }]
}

export const name = 'academic-harness-futurehouse-agent'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'futurehouse_agent',
    description: [
      'Run a FutureHouse (now Edison Scientific) scientific agent asynchronously. action="start" requires agent + query and returns a task_id immediately; poll with action="status" and task_id in a later turn; action="cancel" cancels a running task.',
      'Agents: quick_search (paperqa3 literature answers), deep_search (high-reasoning literature report), precedent_search (has anyone done X?). Never busy-wait or block on a task — these can take minutes.',
      'Requires FUTUREHOUSE_API_KEY (an Edison Scientific API key). Use it for synthesis/verification after openalex_search/s2_search/pubmed_search discovery; it is not a keyword index.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'start (default when no task_id), status (default when task_id is given), or cancel.',
      },
      agent: { type: 'string', enum: AGENTS, description: 'Agent to run for action=start.' },
      query: { type: 'string', description: 'Task/question for action=start.' },
      task_id: { type: 'string', description: 'Trajectory ID returned by action=start, for status/cancel.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      const action = args.action || (args.task_id ? 'status' : 'start')
      if (!ACTIONS.includes(action)) return { error: `action must be one of ${ACTIONS.join(', ')}` }
      const apiKey = await resolveEnv('FUTUREHOUSE_API_KEY')
      if (!apiKey) return { error: 'FUTUREHOUSE_API_KEY is not set (Settings -> Academic Harness API keys, or the matching env var).' }

      try {
        if (action === 'start') {
          let body
          try {
            body = buildCreateBody(args)
          } catch (error) {
            return { error: error.message }
          }
          const result = await authorizedRequest('/v0.1/crows', {
            method: 'POST',
            body,
            apiKey,
            signal: exec.signal,
          })
          if (!result.ok) return apiError('create', result)
          const taskId = result.data?.trajectory_id
          if (!taskId) {
            return { error: 'FutureHouse did not return a trajectory_id', detail: result.data }
          }
          return {
            action: 'start',
            task_id: taskId,
            agent: args.agent,
            job_name: body.name,
            status: 'queued',
          }
        }

        const taskId = String(args.task_id || '').trim()
        if (!taskId) return { error: `task_id is required for action=${action}` }
        if (!UUID_RE.test(taskId)) return { error: 'task_id must be a FutureHouse task UUID' }

        const getTask = () => authorizedRequest(
          `/v0.1/trajectories/${encodeURIComponent(taskId)}?history=false&lite=false`,
          { method: 'GET', apiKey, signal: exec.signal },
        )

        if (action === 'cancel') {
          const before = await getTask()
          if (!before.ok) return apiError('status', before)
          const beforeSummary = summarizeTask(before.data)
          if (beforeSummary.status !== 'in progress') {
            return {
              action,
              task_id: taskId,
              ...beforeSummary,
              note: beforeSummary.status === 'queued'
                ? 'Task is queued; the platform cancels only in-progress tasks. Poll status first.'
                : 'Task is already in a terminal state.',
            }
          }
          const cancel = await authorizedRequest(`/v0.1/trajectories/${encodeURIComponent(taskId)}/cancel`, {
            method: 'POST',
            apiKey,
            signal: exec.signal,
          })
          if (!cancel.ok && cancel.error === 'aborted') return { error: 'request cancelled' }
          const after = await getTask()
          if (!after.ok) return apiError('status', after)
          return {
            action,
            task_id: taskId,
            ...summarizeTask(after.data),
            ...(cancel.ok ? {} : { cancel_error: `FutureHouse cancel error ${cancel.status}`, cancel_detail: cancel.detail ?? cancel.error }),
          }
        }

        const status = await getTask()
        if (!status.ok) return apiError('status', status)
        return { action, task_id: taskId, ...summarizeTask(status.data) }
      } catch (error) {
        return { error: error.message }
      }
    },
    presentCall(args) {
      if (args.action === 'start' || (!args.action && !args.task_id)) {
        return { card: 'generic', title: `FutureHouse ${args.agent || ''}: ${args.query || ''}`, kind: 'search' }
      }
      return { card: 'generic', title: `FutureHouse task: ${args.task_id || ''}`, kind: 'other' }
    },
  }))
}
