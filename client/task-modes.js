/** Composer integration through command claims; no DOM interception or replacement Send button. */
import { TASK_COMMAND, TASK_EFFORTS, taskCommandLine, taskForToken, taskToken } from '../task-modes.js'
import { createTaskModeStore } from './task-mode-store.js'
import { TaskCommandReceipt, TaskRunNotice, TaskSelector, TaskSelectorStatus } from './task-selector.js'

const en = {
  deep_research: 'Deep Research', deep_review: 'Deep Review', find_papers: 'Find Papers', check_references: 'Check References',
  write_revise: 'Write / Revise', analyze_data: 'Analyze Data', generate_hypotheses: 'Generate Hypotheses',
  effort: 'Effort', depth: 'Depth', breadth: 'Results', scope: 'Checks', ideas: 'Ideas', 'effort.auto': 'Auto', 'effort.low': 'Low', 'effort.medium': 'Medium', 'effort.high': 'High',
  'effort.current': 'Deep Research effort: {effort}', 'depth.current': 'Deep Review depth: {effort}', 'breadth.current': 'Find Papers results: {effort}', 'scope.current': 'Check References online checks: {effort}', 'compile.current': 'Write / Revise compile: {effort}', 'ideas.current': 'Generate Hypotheses cap: {effort}',
  started: 'Deep Research started', startedReview: 'Deep Review started', startedPapers: 'Find Papers started', startedReferences: 'Check References started',
  startedWrite: 'Write / Revise started', startedAnalyze: 'Analyze Data started', startedHypotheses: 'Generate Hypotheses started',
  backgroundHint: 'Follow live status in Background tasks',
  dismiss: 'Dismiss',
  researchDescription: 'Select a cited, multi-step investigation. Send starts the task; click again to return to Chat.',
  reviewDescription: 'Select a multi-pass manuscript review. The first line is a workspace path; later lines are optional focus. Send starts the review; click again to return to Chat.',
  papersDescription: 'Search the literature and return one merged list. Send starts the search; click again to return to Chat.',
  referencesDescription: 'Audit a bibliography. The first line is a .bib, RIS, or CSL path; the second line is an optional manuscript. Send starts the check; click again to return to Chat.',
  writeDescription: 'Compare an earlier manuscript with a revised one. Two paths, .tex, .md, or .txt. Neither file is edited. Send starts the diff; click again to return to Chat.',
  analyzeDescription: 'Freeze an analysis plan from the question. A slug may go on the first line. No command runs. Send starts the plan; click again to return to Chat.',
  hypothesesDescription: 'Open a hypothesis tournament for a goal. A slug may go on the first line. No hypothesis text is written. Send starts the ledger; click again to return to Chat.',
  costNotice: 'Multi-step research uses extra time and tokens. Send starts one run.',
  costNoticeReview: 'A deep review reads the whole manuscript and can take several minutes. Auto uses the engine default (MID, two passes). Low, Medium, and High pass LOW, MID, and HIGH. Send starts one review.',
  costNoticePapers: 'Find Papers runs one literature search. Auto asks for the default 20 results. Low, Medium, and High ask for 10, 20, and 50. Send starts one search.',
  costNoticeReferences: 'Check References audits the bibliography and looks up DOIs. Auto checks up to 100 online. Low, Medium, and High check 25, 100, and 250. Send starts one audit.',
  costNoticeWrite: 'Write / Revise builds a diff of two manuscript versions and does not edit either file. Auto leaves TeX compilation at the tool default. Low skips the PDF. Medium and High compile it. Send starts one diff.',
  costNoticeAnalyze: 'Analyze Data freezes the question as an analysis plan. It does not run a program or choose a statistical test. Send starts one plan.',
  costNoticeHypotheses: 'Generate Hypotheses opens a tournament ledger. Auto keeps the default cap of 5. Low, Medium, and High cap the set at 3, 5, and 8. No hypothesis text is written. Send starts one tournament.',
  loading: 'Checking tasks…', unavailable: 'Academic tasks are unavailable on this session’s preset.',
  planBlocked: 'Switch out of Plan mode before starting this task.',
  hint: 'Enter the research question', hintReview: 'Enter the manuscript path', hintPapers: 'Enter what to find', hintReferences: 'Enter the bibliography path',
  hintWrite: 'Enter the earlier path, then the revised path', hintAnalyze: 'Enter the analysis question', hintHypotheses: 'Enter the research goal',
  attachments: 'Deep Research takes a text question. Remove attachments before sending.',
  attachmentsReview: 'Deep Review takes a manuscript path. Remove attachments before sending.',
  attachmentsPapers: 'Find Papers takes a search query. Remove attachments before sending.',
  attachmentsReferences: 'Check References takes a bibliography path. Remove attachments before sending.',
  attachmentsWrite: 'Write / Revise takes two manuscript paths. Remove attachments before sending.',
  attachmentsAnalyze: 'Analyze Data takes an analysis question. Remove attachments before sending.',
  attachmentsHypotheses: 'Generate Hypotheses takes a research goal. Remove attachments before sending.',
  empty: 'Enter a research question first.', emptyReview: 'Enter a manuscript path first.', emptyPapers: 'Enter a search query first.', emptyReferences: 'Enter a bibliography path first.',
  emptyWrite: 'Enter the two manuscript paths first.', emptyAnalyze: 'Enter an analysis question first.', emptyHypotheses: 'Enter a research goal first.',
  conflict: 'Clear the current command before selecting a task.',
  changed: 'The draft changed. Select the task again.',
}
const zh = {
  deep_research: '深度研究', deep_review: '深度评审', find_papers: '查找论文', check_references: '检查参考文献',
  write_revise: '写作 / 修订', analyze_data: '分析数据', generate_hypotheses: '生成假设',
  effort: '研究强度', depth: '评审深度', breadth: '结果数', scope: '核查数', ideas: '想法数', 'effort.auto': '自动', 'effort.low': '低', 'effort.medium': '中', 'effort.high': '高',
  'effort.current': '深度研究强度：{effort}', 'depth.current': '深度评审深度：{effort}', 'breadth.current': '查找论文结果数：{effort}', 'scope.current': '参考文献在线核查：{effort}', 'compile.current': '写作修订编译：{effort}', 'ideas.current': '假设数量上限：{effort}',
  started: '深度研究已启动', startedReview: '深度评审已启动', startedPapers: '论文查找已启动', startedReferences: '参考文献检查已启动',
  startedWrite: '写作修订已启动', startedAnalyze: '数据分析已启动', startedHypotheses: '假设生成已启动',
  backgroundHint: '请在后台任务中查看实时状态',
  dismiss: '关闭',
  researchDescription: '选择带引用的多步骤研究。发送后开始；再次点击返回普通聊天。',
  reviewDescription: '选择多轮文稿评审。第一行是工作区路径，后续行是可选关注点。发送后开始；再次点击返回普通聊天。',
  papersDescription: '检索文献并返回一份合并列表。发送后开始；再次点击返回普通聊天。',
  referencesDescription: '审计参考文献。第一行是 .bib、RIS 或 CSL 路径，第二行是可选文稿。发送后开始；再次点击返回普通聊天。',
  writeDescription: '比较修订前后的文稿。两行路径，.tex、.md 或 .txt。不会修改文件。发送后开始；再次点击返回普通聊天。',
  analyzeDescription: '把问题冻结为分析计划。第一行可以是短标识。不会运行命令。发送后开始；再次点击返回普通聊天。',
  hypothesesDescription: '为一个目标打开假设锦标赛。第一行可以是短标识。不会写下假设正文。发送后开始；再次点击返回普通聊天。',
  costNotice: '多步骤研究需要更多时间和 token。发送后开始一次研究。',
  costNoticeReview: '深度评审会通读整篇文稿，可能需要数分钟。自动使用引擎默认深度（MID，两轮）。低、中、高分别对应 LOW、MID、HIGH。发送后开始一次评审。',
  costNoticePapers: '查找论文会执行一次文献检索。自动使用默认的 20 条结果。低、中、高分别为 10、20、50 条。发送后开始一次检索。',
  costNoticeReferences: '检查参考文献会审计书目并查询 DOI。自动最多在线核查 100 条。低、中、高分别为 25、100、250 条。发送后开始一次审计。',
  costNoticeWrite: '写作修订会生成两个文稿版本的差异，不会修改原文件。自动沿用工具默认的 TeX 编译。低跳过 PDF。中和高会编译。发送后开始一次比较。',
  costNoticeAnalyze: '分析数据会把问题冻结为分析计划。不会运行程序，也不会选择统计检验。发送后开始一份计划。',
  costNoticeHypotheses: '生成假设会打开锦标赛账本。自动保持默认上限 5。低、中、高分别为 3、5、8。不会写下假设正文。发送后开始一次锦标赛。',
  loading: '正在检查任务…', unavailable: '此会话的预设不支持这些学术任务。',
  planBlocked: '开始此任务前请先退出计划模式。',
  hint: '输入研究问题', hintReview: '输入文稿路径', hintPapers: '输入要查找的内容', hintReferences: '输入参考文献路径',
  hintWrite: '先输入旧路径，再输入修订后路径', hintAnalyze: '输入分析问题', hintHypotheses: '输入研究目标',
  attachments: '深度研究接受文本问题，请先移除附件。',
  attachmentsReview: '深度评审接受文稿路径，请先移除附件。',
  attachmentsPapers: '查找论文接受检索词，请先移除附件。',
  attachmentsReferences: '检查参考文献接受书目路径，请先移除附件。',
  attachmentsWrite: '写作修订接受两个文稿路径，请先移除附件。',
  attachmentsAnalyze: '分析数据接受分析问题，请先移除附件。',
  attachmentsHypotheses: '生成假设接受研究目标，请先移除附件。',
  empty: '请先输入研究问题。', emptyReview: '请先输入文稿路径。', emptyPapers: '请先输入检索词。', emptyReferences: '请先输入参考文献路径。',
  emptyWrite: '请先输入两个文稿路径。', emptyAnalyze: '请先输入分析问题。', emptyHypotheses: '请先输入研究目标。',
  conflict: '选择任务前请先清除当前命令。', changed: '草稿已更改，请重新选择任务。',
}

const TASK_FACE = {
  deep_research: { claim: 'research', hint: 'hint', attachments: 'attachments', empty: 'empty', started: 'Deep Research' },
  deep_review: { claim: 'review', hint: 'hintReview', attachments: 'attachmentsReview', empty: 'emptyReview', started: 'Deep Review' },
  find_papers: { claim: 'papers', hint: 'hintPapers', attachments: 'attachmentsPapers', empty: 'emptyPapers', started: 'Find Papers' },
  check_references: { claim: 'references', hint: 'hintReferences', attachments: 'attachmentsReferences', empty: 'emptyReferences', started: 'Check References' },
  write_revise: { claim: 'write', hint: 'hintWrite', attachments: 'attachmentsWrite', empty: 'emptyWrite', started: 'Write / Revise' },
  analyze_data: { claim: 'analyze', hint: 'hintAnalyze', attachments: 'attachmentsAnalyze', empty: 'emptyAnalyze', started: 'Analyze Data' },
  generate_hypotheses: { claim: 'hypotheses', hint: 'hintHypotheses', attachments: 'attachmentsHypotheses', empty: 'emptyHypotheses', started: 'Generate Hypotheses' },
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

  function claimFor(sessionId, task = 'deep_research') {
    const state = sessionState(sessionId)
    const face = TASK_FACE[task] || TASK_FACE.deep_research
    return {
      name: face.claim, token: `${taskToken(task)} `, hint: t(face.hint),
      async submit(prompt, _actx, attachments = []) {
        if (attachments.length) return { kind: 'error', text: t(face.attachments) }
        if (!prompt.trim()) return { kind: 'error', text: t(face.empty) }
        // A retry is a new attempt, not a continuation of the previous receipt.
        state.store.update({ lastTask: null, inTranscript: false })
        const effort = state.store.getSnapshot().effort
        // Retrying a failed/lost acknowledgment reuses the same identity, not a second costly run.
        let request = state.store.getRequest()
        if (!request || request.task !== task || request.prompt !== prompt || request.options.effort !== effort) {
          request = { version: 1, request_id: taskRequestId(), task, prompt, options: { effort } }
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
        const runId = /Research run:\s*(\S+)/u.exec(receipt)?.[1] ?? /Review:\s*(\S+)/u.exec(receipt)?.[1] ?? null
        state.store.setRequest(null)
        // The task command returns at acceptance; the outer job keeps running.
        // The dock card covers the gap until the transcript node paints.
        state.store.update({
          effort: 'auto',
          error: null,
          inTranscript: false,
          lastTask: { task, prompt, effort, jobId, runId, startedAt: Date.now() },
        })
        // A blank hero does not mount the transcript, and a command success is
        // not a prompt, so the receipt stayed out of the chat until the next
        // message. Open that same chat without sending a model turn.
        revealSessionTranscript(ctx, sessionId)
        const started = face.started
        return { kind: 'success', text: `${started} started${runId ? ` (${runId})` : ''}${jobId ? ` · ${jobId}` : ''}. Follow progress in Background tasks.` }
      },
    }
  }

  ctx.effect(() => ctx.inputTriggers.registerSource({
    trigger: '/', name: 'academic-research', order: 45,
    candidates: async () => [],
    onPick: ({ session }) => ({ claim: claimFor(session.sessionId) }),
    matchSpace: (session, token) => {
      const task = taskForToken(token)
      return task ? { claim: claimFor(session.sessionId, task) } : undefined
    },
    matchClaim: async (session, token) => {
      const task = taskForToken(token)
      return task ? claimFor(session.sessionId, task) : undefined
    },
    async matchEnter(session, line, _signal, envelope) {
      const task = taskForToken(line.split(/[\s\n]/u, 1)[0])
      if (!task) return undefined
      if (envelope.attachments || envelope.images) throw new Error(t((TASK_FACE[task] || TASK_FACE.deep_research).attachments))
      return { claim: claimFor(session.sessionId, task) }
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
        selectTask: (taskId = 'deep_research') => {
          const current = input().state.getSnapshot()
          if (!['plain', 'claimed'].includes(current.phase)) return
          const token = taskToken(taskId)
          const active = current.claim?.token.trim()
          const clearClaim = (snapshot) => {
            // 0.2.2's named command is one atomic chip in detect coordinates;
            // 0.2.1 publishes only the plain-text token. A bare-token guard would
            // refuse a draft containing arguments, so remove only the guarded token.
            const end = snapshot.claim.name ? 1 : snapshot.claim.token.length
            return state.actx.bail('slash/input-consume-token', { guard: { kind: 'span', span: { start: 0, end, draftRev: snapshot.draftRev } } })
          }
          if (active === token) {
            if (clearClaim(current)) {
              state.store.setRequest(null)
              state.store.update({ effort: 'auto', error: null })
            } else state.store.update({ error: t('changed') })
          } else if (active && taskForToken(active)) {
            if (!clearClaim(current)) {
              state.store.update({ error: t('changed') })
            } else {
              const next = input().state.getSnapshot()
              const changed = state.actx.bail('slash/input-begin-command', { claim: claimFor(sessionId, taskId), span: { start: 0, end: 0, draftRev: next.draftRev } })
              if (changed) {
                state.store.setRequest(null)
                state.store.update({ effort: 'auto', error: null })
              } else state.store.update({ error: t('changed') })
            }
          } else if (current.claim || /^\s*\//u.test(current.draft)) {
            state.store.update({ error: t('conflict') })
          } else {
            const changed = state.actx.bail('slash/input-begin-command', { claim: claimFor(sessionId, taskId), span: { start: 0, end: 0, draftRev: current.draftRev } })
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

  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
    name: 'conversation.chat.commandview', key: TASK_COMMAND, locale: 'academicTasks',
    inject: (sessionId) => {
      const state = sessionState(sessionId)
      return {
        markInTranscript: () => { if (state.alive) state.store.update({ inTranscript: true }) },
      }
    },
  }, TaskCommandReceipt))
}

/**
 * Leave the blank hero so the command row can render.
 * DSH's session face keeps this transition on the concrete session; a missing
 * method leaves the dock receipt in place.
 * @param ctx - client context.
 * @param sessionId - session that just accepted a task.
 */
function revealSessionTranscript(ctx, sessionId) {
  try {
    const session = ctx.sessions.binding?.(sessionId)?.session
    if (typeof session?.acceptPrompt === 'function') session.acceptPrompt()
  } catch { /* the composer receipt remains when the host cannot open the chat */ }
}
