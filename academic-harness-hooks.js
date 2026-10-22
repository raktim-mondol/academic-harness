/**
 * Academic Harness interceptors on DeepSeek Harness.
 *
 * Same engine as Pi's ah-pi and Claude Code's `ah hook`, without Pi:
 *
 *   agent/pre-step        paper-state card + findings baseline (UserPromptSubmit)
 *   tools/pre-execute     protected paths, unit-anchor loss, author-only bash (PreToolUse)
 *   tools/post-execute    post-edit check note (PostToolUse)
 *   agent/turn-stopping   gate: steer until this turn's blockers are gone, then hand off (Stop)
 *
 * Translates DSH tool names (`write`/`edit`/`bash`) into the Claude-shaped
 * payload `ah hook` already understands. Outside a tree with `ah.yaml` this
 * module does nothing.
 *
 * Engine preparation runs in the background. Hooks register immediately and
 * resolve the engine lazily via `runHook`, so a plugin-manager install never
 * waits on the vendored venv's uv/pip timeout.
 */
import { ahEnv, cliArgs, DSH_STATE_FOOTER, ensureAcademicHarnessInstalled, findAhRoot, LOG, run } from './academic-harness-cli.js'

export const name = 'academic-harness-ah-hooks'
export const inject = []

const PLUGIN = 'academic-harness-ah'
const HOOK_TIMEOUT_MS = 120_000
const DSH_TO_CC = { write: 'Write', edit: 'Edit', bash: 'Bash' }

function sessionCwd(agent) {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

function sessionId(agent) {
  const id = agent?.session?.header?.id ?? agent?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : 'default'
}

/** Map a DSH tool call to the Claude Code payload `ah hook pre|post` expects. */
export function mapDshTool(name, args) {
  const tool = DSH_TO_CC[name]
  if (!tool) return null
  const input = args && typeof args === 'object' ? args : {}
  if (tool === 'Write') {
    return { tool_name: 'Write', tool_input: { file_path: input.file_path ?? '', content: input.content ?? '' } }
  }
  if (tool === 'Edit') {
    return {
      tool_name: 'Edit',
      tool_input: {
        file_path: input.file_path ?? '',
        old_string: input.old_string ?? '',
        new_string: input.new_string ?? '',
      },
    }
  }
  return { tool_name: 'Bash', tool_input: { command: input.command ?? '' } }
}

export function parseHookStdout(stdout) {
  const text = String(stdout || '').trim()
  if (!text) return null
  const i = text.indexOf('{')
  if (i < 0) return null
  let parsed
  try {
    parsed = JSON.parse(text.slice(i))
  } catch {
    return null
  }
  const spec = parsed.hookSpecificOutput || {}
  const additionalContext = spec.additionalContext
    || (typeof parsed.additionalContext === 'string' ? parsed.additionalContext : undefined)
  const deny = spec.permissionDecision === 'deny'
    || parsed.decision === 'block'
    || parsed.decision === 'deny'
  const reason = spec.permissionDecisionReason
    || parsed.reason
    || (deny ? additionalContext : undefined)
  return {
    additionalContext,
    deny,
    reason,
    decision: parsed.decision,
    systemMessage: parsed.systemMessage,
    raw: parsed,
  }
}

export function isHandoffMessage(text) {
  const s = String(text || '')
  return /AH gate: stop(?:ping|ped) after /i.test(s) || /The author decides what to do next/.test(s)
}

async function pluginMessage(text) {
  try {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: PLUGIN },
    })
  } catch {
    return {
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: PLUGIN },
    }
  }
}

function sessionModel(agent) {
  const h = agent?.session?.header
  return h?.model || h?.route?.model || agent?.options?.model || undefined
}

function withFooter(text) {
  const body = String(text || '').trim()
  if (!body) return DSH_STATE_FOOTER
  if (body.includes('On DeepSeek Harness use native ah_* tools')) return body
  return `${body}\n\n${DSH_STATE_FOOTER}`
}

export function gateDecision(out, { alreadyHandedOff, alreadyT3 } = {}) {
  const text = out?.reason || out?.systemMessage || out?.additionalContext
  if (!text) return { kind: 'none' }
  if (out.decision === 'block' || (out.deny && !isHandoffMessage(text))) {
    return { kind: 'continue', text }
  }
  if (isHandoffMessage(text)) {
    if (alreadyHandedOff) return { kind: 'none' }
    return {
      kind: 'handoff',
      text: `${text}\n\nSTOP. Report these findings to the author. Do not edit further. You cannot waive them.`,
    }
  }
  if (alreadyT3) return { kind: 'none' }
  return {
    kind: 't3',
    text: `${text}\nThis note is advisory and does not block. Read flagged clauses against the sources before you rely on them.`,
  }
}

async function runHook(event, payload, signal) {
  const launch = await ensureAcademicHarnessInstalled()
  if (!launch) return null
  const root = findAhRoot(payload.cwd) || payload.cwd
  const r = await run(launch.command, cliArgs(launch, ['hook', event]), {
    cwd: payload.cwd,
    timeoutMs: HOOK_TIMEOUT_MS,
    env: ahEnv({}, { root, model: payload.model }),
    signal,
    silent: true,
    stdin: `${JSON.stringify(payload)}\n`,
  })
  if (r.code !== 0 && r.code !== 1) {
    console.warn(`${LOG}: ah hook ${event} exited ${r.code}: ${(r.err || r.out).slice(0, 200)}`)
    return null
  }
  return parseHookStdout(r.out)
}

function prependContext(ours, theirs) {
  return [ours, ...(theirs ?? [])]
}

export function apply(ctx) {
  ensureAcademicHarnessInstalled()
    .then((launch) => {
      if (!launch) {
        console.warn(
          `${LOG}: CLI not found; Academic Harness guard/gate inactive. `
          + `Set ACADEMIC_HARNESS_CLI or check vendor/academic-harness in this plugin.`,
        )
      }
    })
    .catch((error) => {
      console.warn(`${LOG}: background install failed: ${error?.message || error}`)
    })

  const handedOff = new Set()
  const t3Steered = new Set()

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const cwd = sessionCwd(agent)
    if (!cwd || !findAhRoot(cwd) || messages.length === 0) return next()
    const sid = sessionId(agent)
    handedOff.delete(sid)
    t3Steered.delete(sid)
    let out = null
    try {
      out = await runHook('userprompt', {
        cwd,
        session_id: sid,
        model: sessionModel(agent),
        hook_event_name: 'UserPromptSubmit',
      }, signal)
    } catch (error) {
      console.warn(`${LOG}: userprompt hook failed: ${error?.message || error}`)
    }
    const downstream = await next()
    if (downstream.kind !== 'enter') return downstream
    const card = out?.additionalContext ? withFooter(out.additionalContext) : null
    if (!card) return downstream
    const ours = await pluginMessage(card)
    return { ...downstream, messages: [...downstream.messages, ours] }
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec?.name === 'ah_author') {
      return {
        kind: 'ask',
        reason: 'Author-only Academic Harness act (waive, accept/reject a fact, approve a brief or plan, verify a claim, decline a review item, fill provenance, approve a disclosure). Confirm to run it.',
      }
    }
    if (exec?.name === 'ah_migrate' && exec.arguments?.apply && !exec.arguments?.confirm) {
      return { kind: 'deny', reason: 'AH guard: applying migrate rewrites the tree. Pass confirm=true after the author agrees, or run a dry plan first.' }
    }
    const cwd = sessionCwd(exec.agent)
    if (!cwd || !findAhRoot(cwd)) return next()
    const mapped = mapDshTool(exec.name, exec.arguments)
    if (!mapped) return next()
    try {
      const out = await runHook('pre', {
        cwd,
        session_id: sessionId(exec.agent),
        model: sessionModel(exec.agent),
        hook_event_name: 'PreToolUse',
        tool_name: mapped.tool_name,
        tool_input: mapped.tool_input,
      }, exec.signal)
      if (out?.deny) {
        return { kind: 'deny', reason: out.reason || 'blocked by Academic Harness guard' }
      }
    } catch (error) {
      console.warn(`${LOG}: pre hook failed: ${error?.message || error}`)
    }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (result?.isError) return downstream
    const cwd = sessionCwd(exec.agent)
    if (!cwd || !findAhRoot(cwd)) return downstream
    const mapped = mapDshTool(exec.name, exec.arguments)
    if (!mapped) return downstream
    try {
      const out = await runHook('post', {
        cwd,
        session_id: sessionId(exec.agent),
        model: sessionModel(exec.agent),
        hook_event_name: 'PostToolUse',
        tool_name: mapped.tool_name,
        tool_input: mapped.tool_input,
      }, exec.signal)
      if (!out?.additionalContext) return downstream
      const ours = await pluginMessage(out.additionalContext)
      return { ...downstream, additionalContexts: prependContext(ours, downstream.additionalContexts) }
    } catch (error) {
      console.warn(`${LOG}: post hook failed: ${error?.message || error}`)
      return downstream
    }
  })

  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    const cwd = sessionCwd(agent)
    if (!cwd || !findAhRoot(cwd)) return
    const sid = sessionId(agent)
    let out = null
    try {
      out = await runHook('stop', {
        cwd,
        session_id: sid,
        model: sessionModel(agent),
        hook_event_name: 'Stop',
      }, signal)
    } catch (error) {
      console.warn(`${LOG}: stop hook failed: ${error?.message || error}`)
      return
    }
    const decision = gateDecision(out, {
      alreadyHandedOff: handedOff.has(sid),
      alreadyT3: t3Steered.has(sid),
    })
    if (decision.kind === 'none') return
    const message = await pluginMessage(decision.text)
    if (decision.kind === 'handoff') handedOff.add(sid)
    if (decision.kind === 't3') t3Steered.add(sid)
    agent.steer(message)
  })
}
