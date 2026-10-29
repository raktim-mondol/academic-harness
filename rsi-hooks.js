/**
 * DSH hooks for the local RSI loop. Captures user turns, tool outcomes and gate
 * decisions, injects learned lessons, and closes a turn episode when the agent
 * stops. Everything is fail-soft: the writing loop must never depend on RSI.
 */
import { onGate } from './rsi-bus.js'
import {
  appendEpisode, currentLessons, defaultStoreDir, effectiveConfig, ensureStore, projectInfo, sha1,
} from './rsi-store.js'
import {
  appendTurnEvent, classifyTask, computeTurnOutcome, detectCorrection, detectForget,
  extractLastUserText, extractPreference, formatLessonMessage, maybeDiagnose,
  recordExplicitPreference, retireSimilarLessons, selectLessonsForTurn, summarizeToolResult,
  updateLessonsForEpisode,
} from './rsi-core.js'

export const name = 'academic-harness-rsi-hooks'
export const inject = []

const STORE = defaultStoreDir()
const sessions = new Map()
let configCache = { at: 0, value: null }

function configNow() {
  if (configCache.value && Date.now() - configCache.at < 5_000) return configCache.value
  let value
  try {
    value = effectiveConfig(STORE)
  } catch (error) {
    console.warn(`[academic-harness] rsi store unavailable: ${error?.message || error}`)
    value = { mode: 'off', store: STORE }
  }
  configCache = { at: Date.now(), value }
  return value
}

function sessionCwd(agent) {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

function sessionId(agent) {
  const id = agent?.session?.header?.id ?? agent?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : 'default'
}

function sessionModel(agent) {
  const header = agent?.session?.header
  return header?.model || header?.route?.model || agent?.options?.model || null
}

function agentKind(agent) {
  const depth = Number(agent?.depth ?? agent?.descriptor?.depth ?? 0)
  return depth > 0 || agent?.parent ? 'subagent' : 'main'
}

function stateFor(agent) {
  const id = sessionId(agent)
  let state = sessions.get(id)
  if (!state) {
    state = {
      sessionId: id,
      agentKind: agentKind(agent),
      project: projectInfo(sessionCwd(agent)),
      model: sessionModel(agent),
      turnIndex: 0,
      turnNumber: null,
      currentTurn: null,
      lastTaskClass: null,
    }
    sessions.set(id, state)
  }
  return state
}

function newTurn(state, text, turnNumber = null) {
  const task = classifyTask(text)
  const inherited = task.class === 'general-research' && (text || '').length < 60 && state.lastTaskClass
  if (!inherited && task.class !== 'general-research') state.lastTaskClass = task.class
  return {
    index: turnNumber != null ? turnNumber : state.turnIndex++,
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    promptHash: text ? sha1(text, 12) : null,
    taskClass: inherited || task.class,
    taskTags: inherited ? [] : task.tags,
    userChars: (text || '').length,
    turns: 0,
    toolCounts: {},
    errors: 0,
    corrections: 0,
    blockingFindings: 0,
    latestFindingCount: 0,
    correctionMarkers: [],
    findings: new Map(),
    signals: new Set(),
    injectedLessonIds: new Set(),
    injectedTokens: 0,
    injectedActions: new Map(),
    reachedLessonIds: new Set(),
    controlLessonIds: new Set(),
    eligibleLessonIds: new Set(),
    toolSignatures: new Set(),
    gate: null,
    qualitySignals: {},
    integrityIssue: false,
    citationIssue: false,
    statIssue: false,
    figureIssue: false,
    repoIssue: false,
    substantive: false,
    finalized: false,
  }
}

function updateTurnPrompt(state, text) {
  const turn = state.currentTurn
  if (!turn) return
  const task = classifyTask(text)
  const inherited = task.class === 'general-research' && text.length < 60 && state.lastTaskClass
  if (!inherited && task.class !== 'general-research') state.lastTaskClass = task.class
  turn.taskClass = inherited || task.class
  turn.taskTags = inherited ? [] : task.tags
  turn.userChars += text.length
  turn.promptHash = sha1(text, 12)
}

async function finalizeTurn(state, reason, config) {
  const turn = state.currentTurn
  if (!turn || turn.finalized) return null
  turn.finalized = true
  const episode = computeTurnOutcome(turn, {
    sessionId: state.sessionId,
    agentKind: state.agentKind,
    project: state.project,
    model: state.model,
    reason,
  })
  try {
    appendEpisode(STORE, episode)
  } catch (error) {
    console.warn(`[academic-harness] rsi episode write failed: ${error?.message || error}`)
    state.currentTurn = null
    return null
  }
  if (episode.substantive) {
    updateLessonsForEpisode({ dir: STORE, episode, config })
      .catch((error) => console.warn(`[academic-harness] rsi lesson update failed: ${error?.message || error}`))
    maybeDiagnose({ dir: STORE, config })
      .catch((error) => console.warn(`[academic-harness] rsi diagnosis failed: ${error?.message || error}`))
  }
  state.currentTurn = null
  return episode
}

function clearSignals(turn, prefix) {
  for (const signal of [...turn.signals]) {
    if (signal.startsWith(prefix)) turn.signals.delete(signal)
  }
}

function updateTurnFromTool(turn, summary, args = {}) {
  turn.toolCounts[summary.name] = (turn.toolCounts[summary.name] || 0) + 1
  if (!['ask_user_question', 'working_directory', 'todo', 'todo_write'].includes(summary.name)) {
    turn.substantive = true
  }
  if (summary.is_error) turn.errors += 1
  for (const check of summary.findings || []) {
    turn.findings.set(check, (turn.findings.get(check) || 0) + 1)
    turn.signals.add(`finding:${check}`)
  }
  if (summary.name === 'ah_check' || summary.name === 'ah_audit') {
    turn.blockingFindings = Number(summary.blocking_findings)
      || (summary.gate_passed === false ? 1 : 0)
    turn.latestFindingCount = Number(summary.finding_count) || 0
  }
  if (summary.error_signature) turn.signals.add(`error:${summary.name}:${summary.error_signature}`)

  if (summary.verdict) {
    const verdict = summary.verdict.toLowerCase()
    clearSignals(turn, 'integrity:')
    if (verdict !== 'clean') turn.signals.add(`integrity:${verdict}`)
    turn.integrityIssue = ['retracted', 'expression_of_concern', 'unknown', 'not_found', 'ambiguous'].includes(verdict)
  }

  if (['manuscript_citations', 'citation', 'pdf_references'].includes(summary.name)) {
    clearSignals(turn, 'citation_gap:')
    turn.citationIssue = summary.issue_count > 0
    if (turn.citationIssue) turn.signals.add('citation_gap:manuscript_citations')
  }
  if (summary.name === 'stat_audit') {
    clearSignals(turn, 'stat_flag:')
    turn.statIssue = summary.issue_count > 0
    if (turn.statIssue) turn.signals.add('stat_flag:stat_audit')
  }
  if (summary.name === 'figure_audit') {
    clearSignals(turn, 'figure_flag:')
    turn.figureIssue = summary.issue_count > 0
    if (turn.figureIssue) turn.signals.add('figure_flag:figure_audit')
  }
  if (summary.name === 'repo_audit') {
    clearSignals(turn, 'repo_flag:')
    turn.repoIssue = summary.issue_count > 0
    if (turn.repoIssue) turn.signals.add('repo_flag:repo_audit')
  }

  if (summary.compile_ok === false) {
    turn.qualitySignals.compiled = false
    turn.signals.add(`error:${summary.name}:compile`)
  } else if (summary.compile_ok === true) {
    turn.qualitySignals.compiled = true
  }
  if (summary.gate_passed != null) turn.qualitySignals.gatePassed = summary.gate_passed
  const argsText = (() => {
    try { return JSON.stringify(args ?? {}) } catch { return '' }
  })()
  for (const [lessonId, action] of turn.injectedActions || []) {
    if (!action) continue
    if (summary.name === action) turn.reachedLessonIds.add(lessonId)
    else if (summary.name === 'skill' && argsText.includes(action)) turn.reachedLessonIds.add(lessonId)
  }
  const signature = `${summary.name}|${summary.args_hash}`
  if (turn.toolSignatures.has(signature)) turn.signals.add(`retry:${summary.name}`)
  else turn.toolSignatures.add(signature)
}

async function pluginMessage(text) {
  try {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin:academic-harness-rsi' },
    })
  } catch {
    return {
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin:academic-harness-rsi' },
    }
  }
}

export function apply(ctx) {
  onGate((event) => {
    const state = sessions.get(event.sessionId)
    if (!state?.currentTurn || state.currentTurn.finalized) return
    if (Number(event.at) && Number(event.at) < Number(state.currentTurn.startedAtMs || 0)) return
    state.currentTurn.gate = event.kind === 'none' ? null : { kind: event.kind, at: event.at || Date.now() }
    if (event.kind === 'handoff') state.currentTurn.signals.add(`handoff:${state.currentTurn.taskClass}`)
    try {
      appendTurnEvent(STORE, {
        type: 'gate',
        session_id: event.sessionId,
        kind: event.kind,
        cwd_hash: event.cwd ? sha1(event.cwd, 12) : null,
      })
    } catch {
      // fail-soft
    }
  })

  ctx.on('agent/pre-step', async ({ agent, messages, turn: hostTurn, step, signal }, next) => {
    const config = configNow()
    if (config.mode === 'off') return next()
    const downstream = await next()
    if (downstream.kind !== 'enter') return downstream
    const state = stateFor(agent)
    const text = extractLastUserText(messages)
    const hash = text ? sha1(text, 12) : null
    const turnNumber = Number.isFinite(Number(hostTurn)) ? Number(hostTurn) : null
    const turnChanged = turnNumber != null
      ? state.turnNumber !== turnNumber
      : Boolean(text) && (!state.currentTurn || state.currentTurn.promptHash !== hash)
    let promptChanged = false

    if (turnChanged) {
      await finalizeTurn(state, 'new_turn', config)
      state.currentTurn = newTurn(state, text, turnNumber)
      state.turnNumber = turnNumber
      promptChanged = Boolean(text)
    } else if (!state.currentTurn) {
      if (text || turnNumber != null) {
        state.currentTurn = newTurn(state, text, turnNumber)
        state.turnNumber = turnNumber
        promptChanged = Boolean(text)
      }
    } else if (text && state.currentTurn.promptHash !== hash) {
      updateTurnPrompt(state, text)
      promptChanged = true
    }
    if (state.currentTurn) state.currentTurn.turns += 1

    if (promptChanged && state.currentTurn) {
      const preference = extractPreference(text)
      const forget = !preference && detectForget(text)
      const correction = preference ? { corrected: false, marker: null } : detectCorrection(text)
      if (preference) {
        try {
          await recordExplicitPreference({
            dir: STORE,
            text: preference.text,
            taskClass: preference.taskClass,
            model: state.model,
          })
        } catch (error) {
          console.warn(`[academic-harness] rsi preference rejected: ${error?.message || error}`)
        }
      }
      if (forget) {
        try {
          await retireSimilarLessons({ dir: STORE, text, config })
        } catch (error) {
          console.warn(`[academic-harness] rsi forget failed: ${error?.message || error}`)
        }
      }
      if (correction.corrected) {
        state.currentTurn.corrections += 1
        state.currentTurn.correctionMarkers.push(correction.marker)
      }
      try {
        appendTurnEvent(STORE, {
          type: 'user_turn',
          session_id: state.sessionId,
          agent_kind: state.agentKind,
          project: state.project,
          turn_number: state.currentTurn.index,
          task_class: state.currentTurn.taskClass,
          task_tags: state.currentTurn.taskTags,
          user_chars: state.currentTurn.userChars,
          message_hash: hash,
          correction: correction.corrected,
          preference: Boolean(preference),
          forget: Boolean(forget),
        })
      } catch {
        // fail-soft
      }
    }

    if (!promptChanged || config.mode !== 'auto' || !state.currentTurn) {
      return downstream
    }
    try {
      const selection = selectLessonsForTurn({
        lessons: currentLessons(STORE),
        taskClass: state.currentTurn.taskClass,
        sessionId: state.sessionId,
        turnHash: `${state.currentTurn.index}:${hash}`,
        config,
      })
      state.currentTurn.eligibleLessonIds = new Set(selection.eligible)
      state.currentTurn.controlLessonIds = new Set(selection.control)
      state.currentTurn.injectedLessonIds = new Set(selection.injected.map((lesson) => lesson.id))
      state.currentTurn.injectedTokens = selection.tokens
      state.currentTurn.injectedActions = new Map(selection.injected.map((lesson) => [lesson.id, lesson.action || null]))
      const message = formatLessonMessage(selection.injected)
      if (!message) return downstream
      appendTurnEvent(STORE, {
        type: 'lesson_injected',
        session_id: state.sessionId,
        turn_number: state.currentTurn.index,
        task_class: state.currentTurn.taskClass,
        lesson_ids: selection.injected.map((lesson) => lesson.id),
        control_ids: selection.control,
        tokens: selection.tokens,
      })
      const ours = await pluginMessage(message)
      return { ...downstream, messages: [...downstream.messages, ours] }
    } catch (error) {
      console.warn(`[academic-harness] rsi injection failed: ${error?.message || error}`)
      return downstream
    }
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    const config = configNow()
    if (config.mode === 'off' || exec?.name === 'ah_rsi') return downstream
    const state = sessions.get(sessionId(exec?.agent))
    if (!state?.currentTurn || state.currentTurn.finalized) return downstream
    try {
      const summary = summarizeToolResult(exec.name, exec.arguments, result)
      updateTurnFromTool(state.currentTurn, summary, exec.arguments)
      appendTurnEvent(STORE, {
        type: 'tool',
        session_id: state.sessionId,
        task_class: state.currentTurn.taskClass,
        tool: summary.name,
        is_error: summary.is_error,
        finding_count: summary.finding_count,
        findings: summary.findings,
        verdict: summary.verdict,
        gate_passed: summary.gate_passed,
        result_size: summary.result_size,
        result_hash: summary.text_hash,
      })
    } catch (error) {
      console.warn(`[academic-harness] rsi capture failed: ${error?.message || error}`)
    }
    return downstream
  })

  ctx.on('agent/disposed', async (payload) => {
    const agent = payload?.agent ?? payload
    const config = configNow()
    const state = sessions.get(sessionId(agent))
    if (!state) return
    await finalizeTurn(state, 'dispose', config)
    sessions.delete(state.sessionId)
  })

  try {
    ensureStore(STORE)
  } catch (error) {
    console.warn(`[academic-harness] rsi store unavailable at activation: ${error?.message || error}`)
  }
}
