/** Composer integration through command claims; no DOM interception or replacement Send button. */
import { RESEARCH_TOKEN, TASK_COMMAND, TASK_EFFORTS, taskCommandLine } from '../task-modes.js'
import { createTaskModeStore } from './task-mode-store.js'
import { TaskRunNotice, TaskSelector, TaskSelectorStatus } from './task-selector.js'

const en = {
  deep_research: 'Deep Research', effort: 'Effort', 'effort.auto': 'Auto', 'effort.low': 'Low', 'effort.medium': 'Medium', 'effort.high': 'High',
  'effort.current': 'Deep Research effort: {effort}',
  started: 'Deep Research started',
  backgroundHint: 'Follow live status in Background tasks',
  dismiss: 'Dismiss',
  researchDescription: 'Select a cited, multi-step investigation. Send starts the task; click again to return to Chat.',
  costNotice: 'Multi-step research uses extra time and tokens. Send starts one run.',
  loading: 'Checking tasks…', unavailable: 'Deep Research is unavailable on this session’s preset.',
  planBlocked: 'Switch out of Plan mode before starting Deep Research.',
  hint: 'Enter the research question', attachments: 'Deep Research takes a text question. Remove attachments before sending.',
  empty: 'Enter a research question first.', conflict: 'Clear the current command before selecting Deep Research.',
  changed: 'The draft changed. Select Deep Research again.',
}
const zh = {
  deep_research: '深度研究', effort: '研究强度', 'effort.auto': '自动', 'effort.low': '低', 'effort.medium': '中', 'effort.high': '高',
  'effort.current': '深度研究强度：{effort}',
  started: '深度研究已启动',
  backgroundHint: '请在后台任务中查看实时状态',
  dismiss: '关闭',
  researchDescription: '选择带引用的多步骤研究。发送后开始；再次点击返回普通聊天。',
  costNotice: '多步骤研究需要更多时间和 token。发送后开始一次研究。',
  loading: '正在检查任务…', unavailable: '此会话的预设不支持深度研究。',
  planBlocked: '开始深度研究前请先退出计划模式。',
  hint: '输入研究问题', attachments: '深度研究接受文本问题，请先移除附件。',
  empty: '请先输入研究问题。', conflict: '选择深度研究前请先清除当前命令。', changed: '草稿已更改，请重新选择深度研究。',
}

/** getRandomValues also works on trusted plain-HTTP LAN deployments where randomUUID is absent. */
export function taskRequestId(crypto = globalThis.crypto) {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function applyTaskModes(ctx) {
  const states = new Map()
  const t = ctx.locale.bind('academicTasks')
  ctx.effect(() => ctx.locale.register('academicTasks', { en, zh }), 'academic-harness: task copy')

  function sessionState(sessionId) {
    if (states.has(sessionId)) return states.get(sessionId)
    const actx = ctx.sessions.scope(sessionId)
    if (!actx) throw new Error('Academic task session is no longer open')
    const store = createTaskModeStore({ sessionId })
    const state = { actx, store, alive: true }
    states.set(sessionId, state)
    ctx.effect(() => actx.effect(() => () => { state.alive = false; states.delete(sessionId) }, 'academic-harness: session task state'))
    void ctx.remote.commands.list(sessionId).then((response) => {
      if (!state.alive) return
      if (!response.ok) throw new Error(response.error.message)
      store.update({ loading: false, available: response.value.some((command) => command.name === TASK_COMMAND) })
    }).catch((error) => { if (state.alive) store.update({ loading: false, error: error.message }) })
    return state
  }

  function claimFor(sessionId) {
    const state = sessionState(sessionId)
    return {
      name: 'research', token: `${RESEARCH_TOKEN} `, hint: t('hint'),
      async submit(prompt, _actx, attachments = []) {
        if (attachments.length) return { kind: 'error', text: t('attachments') }
        if (!prompt.trim()) return { kind: 'error', text: t('empty') }
        // A retry is a new attempt, not a continuation of the previous receipt.
        state.store.update({ lastTask: null })
        const effort = state.store.getSnapshot().effort
        // Retrying a failed/lost acknowledgment reuses the same identity, not a second costly run.
        let request = state.store.getRequest()
        if (!request || request.prompt !== prompt || request.options.effort !== effort) {
          request = { version: 1, request_id: taskRequestId(), task: 'deep_research', prompt, options: { effort } }
          state.store.setRequest(request)
        }
        let result
        try {
          result = await ctx.remote.commands.execute(sessionId, taskCommandLine(request), [])
        } catch (error) {
          state.store.update({ error: error instanceof Error ? error.message : String(error) })
          throw error
        }
        if (!result.ok) {
          state.store.update({ error: result.error.message })
          return { kind: 'error', text: result.error.message }
        }
        const outcome = result.value?.result
        if (!outcome) {
          state.store.update({ error: t('unavailable') })
          return { kind: 'error', text: t('unavailable') }
        }
        if (outcome.kind === 'error') {
          // The host's empty-session hero may not display command transcript
          // nodes yet. Keep clarification/errors next to the selected task too.
          state.store.update({ error: outcome.text })
          return outcome
        }
        const receipt = String(outcome.text ?? '')
        const jobId = /Job:\s*(\S+)/u.exec(receipt)?.[1] ?? null
        const runId = /Research run:\s*(\S+)/u.exec(receipt)?.[1] ?? null
        state.store.setRequest(null)
        // The task command returns at acceptance; the outer job keeps running.
        // Keep a visible receipt in the composer so an empty hero never looks
        // like nothing happened.
        state.store.update({
          effort: 'auto',
          error: null,
          lastTask: { prompt, effort, jobId, runId, startedAt: Date.now() },
        })
        // The durable command node is not shown on an empty hero in every DSH
        // build. Return an immediate notice as well as the composer banner.
        return { kind: 'success', text: `Deep Research started${runId ? ` (${runId})` : ''}${jobId ? ` · ${jobId}` : ''}. Follow progress in Background tasks.` }
      },
    }
  }

  ctx.effect(() => ctx.inputTriggers.registerSource({
    trigger: '/', name: 'academic-research', order: 45,
    candidates: async () => [],
    onPick: ({ session }) => ({ claim: claimFor(session.sessionId) }),
    matchSpace: (session, token) => token === RESEARCH_TOKEN ? { claim: claimFor(session.sessionId) } : undefined,
    matchClaim: async (session, token) => token === RESEARCH_TOKEN ? claimFor(session.sessionId) : undefined,
    async matchEnter(session, line, _signal, envelope) {
      if (line !== RESEARCH_TOKEN && !line.startsWith(`${RESEARCH_TOKEN} `) && !line.startsWith(`${RESEARCH_TOKEN}\n`)) return undefined
      if (envelope.attachments || envelope.images) throw new Error(t('attachments'))
      return { claim: claimFor(session.sessionId) }
    },
  }), 'academic-harness: research command claim')

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: 'academic-task-selector', order: 45, locale: 'academicTasks',
    inject: (sessionId) => {
      const state = sessionState(sessionId)
      const input = () => ctx.conversation.input.for(state.actx)
      return {
        hooks: { taskMode: state.store },
        setEffort: (effort) => {
          if (TASK_EFFORTS.includes(effort)) state.store.update({ effort, error: null })
        },
        selectTask: () => {
          const current = input().state.getSnapshot()
          if (!['plain', 'claimed'].includes(current.phase)) return
          if (current.claim?.token.trim() === RESEARCH_TOKEN) {
            // 0.2.2's named command is one atomic chip in detect coordinates;
            // 0.2.1 publishes only the plain-text token. A bare-token guard would
            // refuse a draft containing arguments, so remove only the guarded token.
            const end = current.claim.name ? 1 : current.claim.token.length
            const changed = state.actx.bail('slash/input-consume-token', { guard: { kind: 'span', span: { start: 0, end, draftRev: current.draftRev } } })
            if (changed) {
              state.store.setRequest(null)
              state.store.update({ effort: 'auto', error: null })
            } else state.store.update({ error: t('changed') })
          } else if (current.claim || /^\s*\//u.test(current.draft)) {
            state.store.update({ error: t('conflict') })
          } else {
            const changed = state.actx.bail('slash/input-begin-command', { claim: claimFor(sessionId), span: { start: 0, end: 0, draftRev: current.draftRev } })
            state.store.update({ error: changed ? null : t('changed') })
          }
          input().focus?.()
        },
      }
    },
  }, TaskSelector))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'academic-task-run', order: 44, locale: 'academicTasks',
    inject: (sessionId) => {
      const state = sessionState(sessionId)
      return {
        hooks: { taskMode: state.store },
        dismiss: () => state.store.update({ lastTask: null }),
      }
    },
  }, TaskRunNotice))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'academic-task-status', order: 45, locale: 'academicTasks',
    inject: (sessionId) => ({ hooks: { taskMode: sessionState(sessionId).store } }),
  }, TaskSelectorStatus))
}
