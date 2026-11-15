import { createElement, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TASK_EFFORTS, TASK_MODES, taskForToken } from '../task-modes.js'

const row = { display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%', flexWrap: 'wrap' }
const segment = { font: 'inherit', fontSize: 11, lineHeight: '16px', minHeight: 24, padding: '1px 6px', border: 0, borderRadius: 0, color: 'inherit', background: 'transparent', cursor: 'pointer', whiteSpace: 'nowrap' }
const chip = { display: 'inline-flex', alignItems: 'stretch', flex: '0 0 auto', position: 'relative', border: '1px solid var(--dsw-border, var(--color-border, currentColor))', borderRadius: 6 }
const menu = { position: 'fixed', zIndex: 1000, minWidth: 190, padding: 4, borderRadius: 10, border: '1px solid var(--dsw-border, var(--color-border, currentColor))', background: 'var(--dsw-surface-overlay, var(--dsw-bg-elevated, var(--color-surface-secondary, Canvas)))', boxShadow: '0 8px 24px rgba(0,0,0,0.28)' }
const menuRow = { display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: 12, font: 'inherit', fontSize: 12, padding: '7px 9px', border: 0, borderRadius: 7, color: 'inherit', background: 'transparent', textAlign: 'left', cursor: 'pointer' }
const MENU_WIDTH = 190
const MENU_ROW_HEIGHT = 31
const TASK_CHROME = {
  deep_research: { description: 'researchDescription', effort: 'effort', current: 'effort.current', started: 'started', notice: 'costNotice' },
  deep_review: { description: 'reviewDescription', effort: 'depth', current: 'depth.current', started: 'startedReview', notice: 'costNoticeReview' },
  find_papers: { description: 'papersDescription', effort: 'breadth', current: 'breadth.current', started: 'startedPapers', notice: 'costNoticePapers' },
  check_references: { description: 'referencesDescription', effort: 'scope', current: 'scope.current', started: 'startedReferences', notice: 'costNoticeReferences' },
  write_revise: { description: 'writeDescription', effort: 'effort', current: 'compile.current', started: 'startedWrite', notice: 'costNoticeWrite' },
  analyze_data: { description: 'analyzeDescription', effort: null, current: null, started: 'startedAnalyze', notice: 'costNoticeAnalyze' },
  generate_hypotheses: { description: 'hypothesesDescription', effort: 'ideas', current: 'ideas.current', started: 'startedHypotheses', notice: 'costNoticeHypotheses' },
}
function taskChrome(id) {
  return TASK_CHROME[id] || TASK_CHROME.deep_research
}

/**
 * Effort is the right-hand segment of the selected Deep Research chip, so the
 * choice is visible before Send without a second toolbar control. The menu
 * portals above the chip on the bottom composer, matching the model seat and
 * avoiding both toolbar width and ancestor overflow clipping.
 */
export function EffortMenu({ effort, disabled, onEffort, t, labelKey = 'effort', currentKey = 'effort.current' }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState(null)
  const [active, setActive] = useState(() => Math.max(0, TASK_EFFORTS.indexOf(effort)))
  const trigger = useRef(null)
  const list = useRef(null)
  const rows = useRef([])
  const id = useId()

  useEffect(() => {
    if (!open) { setPosition(null); return undefined }
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const margin = 8
      const height = TASK_EFFORTS.length * MENU_ROW_HEIGHT + 8
      const left = Math.min(Math.max(rect.right - MENU_WIDTH, margin), window.innerWidth - MENU_WIDTH - margin)
      const below = rect.bottom + 6
      const top = below + height <= window.innerHeight - margin ? below : Math.max(margin, rect.top - height - 6)
      setPosition({ left, top })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])

  const ready = position !== null
  useEffect(() => {
    if (open && ready) rows.current[Math.max(0, TASK_EFFORTS.indexOf(effort))]?.focus()
  }, [open, ready, effort])

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event) => {
      if (trigger.current?.contains(event.target) || list.current?.contains(event.target)) return
      setOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      queueMicrotask(() => trigger.current?.focus())
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const choose = (level) => {
    onEffort(level)
    setOpen(false)
    queueMicrotask(() => trigger.current?.focus())
  }

  const show = () => {
    setActive(Math.max(0, TASK_EFFORTS.indexOf(effort)))
    setOpen(true)
  }

  const onKeyDown = (event) => {
    if (!open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
    event.preventDefault()
    const next = (active + (event.key === 'ArrowDown' ? 1 : -1) + TASK_EFFORTS.length) % TASK_EFFORTS.length
    setActive(next)
    rows.current[next]?.focus()
  }

  return createElement('span', { style: { display: 'inline-flex' }, onKeyDown, 'data-ah-effort-menu': true }, [
    createElement('button', {
      key: 'trigger', ref: trigger, type: 'button',
      style: { ...segment, borderLeft: '1px solid var(--dsw-border, var(--color-border, currentColor))', paddingLeft: 5 },
      disabled,
      'aria-label': t(currentKey, { effort: t(`effort.${effort}`) }),
      'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': open ? id : undefined,
      onClick: () => { if (open) setOpen(false); else show() },
    }, `${t(`effort.${effort}`)} ▾`),
    open && position ? createPortal(createElement('div', {
      key: 'menu', ref: list, id, role: 'menu', 'aria-label': t(labelKey),
      style: { ...menu, left: position.left, top: position.top },
    }, TASK_EFFORTS.map((level, index) => createElement('button', {
      key: level, ref: (node) => { rows.current[index] = node }, type: 'button', role: 'menuitemradio',
      'aria-checked': effort === level, tabIndex: active === index ? 0 : -1,
      style: { ...menuRow, background: active === index ? 'var(--dsw-bg-active, var(--color-surface-secondary, transparent))' : 'transparent' },
      onMouseEnter: () => setActive(index), onFocus: () => setActive(index), onClick: () => choose(level),
    }, [
      createElement('span', { key: 'label' }, t(`effort.${level}`)),
      effort === level ? createElement('span', { key: 'check', 'aria-hidden': true }, '✓') : null,
    ]))), document.body) : null,
  ])
}

/** One compact chip per enabled task. Selecting a chip opens its effort segment. */
export function TaskSelectorView({ selected, effort, available, loading, locked, planActive, disabled, onSelect, onEffort, t }) {
  const modes = TASK_MODES.filter((mode) => mode.enabled)
  const selectedFill = 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-interactive-bg-active, #fff))'
  const selectedInk = 'var(--dsw-alias-label-primary-foreground, #000)'
  return createElement('span', { style: row, 'data-ah-task-selector': true }, modes.map((mode) => {
    const isSelected = selected === mode.id
    const chrome = taskChrome(mode.id)
    const unusable = (planActive || !available) && !isSelected
    const reason = planActive ? 'planBlocked' : loading ? 'loading' : !available ? 'unavailable' : chrome.description
    return createElement('span', {
      key: mode.id,
      'data-ah-task': mode.id,
      style: {
        ...chip,
        background: isSelected ? selectedFill : 'transparent',
        color: isSelected ? selectedInk : 'inherit',
        borderColor: isSelected ? selectedFill : 'var(--dsw-border, var(--color-border, currentColor))',
      },
    }, [
      createElement('button', {
        key: 'task', type: 'button', 'aria-pressed': isSelected, disabled: locked || unusable,
        onClick: () => onSelect(mode.id), title: t(reason),
        style: { ...segment, fontWeight: isSelected ? 600 : 400 },
      }, `${isSelected ? '✓ ' : ''}${t(mode.id)}`),
      isSelected && chrome.effort ? createElement(EffortMenu, {
        key: 'effort', effort, disabled: disabled ?? locked, onEffort, t,
        labelKey: chrome.effort,
        currentKey: chrome.current,
      }) : null,
    ])
  }))
}

/** Standard input/plan hooks keep selection tied to the actual composer command, not a second mode flag. */
export function TaskSelector({ useInput, useTaskMode, useProjection, selectTask, setEffort, t }) {
  const phase = useInput((input) => input.phase)
  const token = useInput((input) => input.claim?.token)
  const plan = useProjection('plan')
  const state = useTaskMode((value) => value)
  const frozen = !['plain', 'claimed'].includes(phase)
  return createElement(TaskSelectorView, {
    ...state, selected: taskForToken(token) ?? null,
    locked: frozen, disabled: frozen,
    planActive: Boolean(plan && (plan.active || plan.pending)),
    onSelect: selectTask, onEffort: setEffort, t,
  })
}

const RECEIPT_IDS = /(?:Research run|Review|Papers|References|Diff|Analysis|Tournament):\s*(\S+)/u

/** Rebuild the start card from the durable academic-task command node. */
export function taskReceiptFromCommand(node) {
  const text = typeof node?.outcome?.text === 'string' ? node.outcome.text : ''
  let request = null
  try { request = JSON.parse(String(node?.args ?? '')) } catch { /* a cut window can omit args */ }
  const task = TASK_CHROME[request?.task] ? request.task : 'deep_research'
  const prompt = typeof request?.prompt === 'string' ? request.prompt : ''
  const effort = TASK_EFFORTS.includes(request?.options?.effort) ? request.options.effort : 'auto'
  const jobId = /Job:\s*(\S+)/u.exec(text)?.[1] ?? null
  const runId = RECEIPT_IDS.exec(text)?.[1] ?? null
  return { task, prompt, effort, jobId, runId }
}

function receiptPrompt(prompt) {
  const flat = String(prompt ?? '').replace(/[ \t]*\n[ \t]*/g, ' · ').replace(/[ \t]+/g, ' ').trim()
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat
}

function TaskReceiptCard({ task, shown, meta, hint, dismiss, dismissLabel, transcript = false }) {
  return createElement('div', {
    'data-ah-task-run': true,
    ...transcript ? { 'data-ah-task-transcript': true } : {},
    role: 'status',
    style: {
      display: 'flex', alignItems: 'flex-start', alignSelf: 'center', gap: 8, margin: '6px auto', padding: '8px 10px',
      width: 'min(100%, var(--dsh-composer-card-max-width, 46rem))', maxWidth: 'var(--dsh-composer-card-max-width, 46rem)', boxSizing: 'border-box',
      fontSize: 12, lineHeight: 1.45, border: '1px solid var(--dsw-alias-state-business-primary, var(--color-border, currentColor))',
      borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1, transparent)',
    },
  }, [
    createElement('span', {
      key: 'dot', 'aria-hidden': true,
      style: { width: 8, height: 8, marginTop: 5, flex: '0 0 auto', borderRadius: '50%', background: 'var(--dsw-alias-state-business-primary, #22c55e)' },
    }),
    createElement('div', { key: 'body', style: { display: 'flex', flex: '1 1 auto', flexDirection: 'column', gap: 2, minWidth: 0 } }, [
      createElement('strong', { key: 'title' }, task),
      createElement('span', { key: 'prompt', style: { overflowWrap: 'anywhere' } }, shown),
      createElement('span', { key: 'meta', style: { opacity: 0.75, overflowWrap: 'anywhere' } }, meta),
      createElement('span', { key: 'hint', style: { opacity: 0.75 } }, hint),
    ]),
    dismiss ? createElement('button', {
      key: 'dismiss', type: 'button', onClick: dismiss, 'aria-label': dismissLabel, title: dismissLabel,
      style: { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 },
    }, '×') : null,
  ])
}

/**
 * A task command returns when the background job is accepted. The same card is
 * also a transcript node. This dock copy covers the moment before that node paints.
 */
export function TaskRunNotice({ useTaskMode, dismiss, t }) {
  const task = useTaskMode((state) => state.lastTask)
  const inTranscript = useTaskMode((state) => state.inTranscript)
  if (!task || inTranscript) return null
  const meta = [t(`effort.${task.effort}`), task.runId, task.jobId].filter(Boolean).join(' · ')
  return TaskReceiptCard({
    task: t(taskChrome(task.task).started),
    shown: receiptPrompt(task.prompt),
    meta,
    hint: t('backgroundHint'),
    dismiss,
    dismissLabel: t('dismiss'),
  })
}

/** Durable start receipt for the academic-task command row inside the chat. */
export function TaskCommandReceipt({ node, markInTranscript, t }) {
  useEffect(() => { markInTranscript?.() }, [markInTranscript])
  if (node?.outcome?.kind === 'error') {
    return createElement('div', {
      'data-ah-task-run': true, 'data-ah-task-transcript': true, role: 'alert',
      style: {
        margin: '6px auto', alignSelf: 'center', boxSizing: 'border-box', overflowWrap: 'anywhere',
        width: 'min(100%, var(--dsh-composer-card-max-width, 46rem))', maxWidth: 'var(--dsh-composer-card-max-width, 46rem)',
        fontSize: 12, lineHeight: 1.45,
      },
    }, node.outcome.text || '')
  }
  const receipt = taskReceiptFromCommand(node)
  const meta = [t(`effort.${receipt.effort}`), receipt.runId, receipt.jobId].filter(Boolean).join(' · ')
  return TaskReceiptCard({
    task: t(taskChrome(receipt.task).started),
    shown: receiptPrompt(receipt.prompt),
    meta,
    hint: t('backgroundHint'),
    transcript: true,
  })
}

/** Long task guidance sits in the composer dock, on the chat box column, not the compact toolbar. */
export function TaskSelectorStatus({ useInput, useTaskMode, t }) {
  const selected = taskForToken(useInput((input) => input.claim?.token))
  const error = useTaskMode((state) => state.error)
  if (!selected && !error) return null
  const notice = taskChrome(selected).notice
  return createElement('p', {
    'data-ah-task-status': true, role: error ? 'alert' : 'status',
    style: {
      // The dock slot is a flex child of the full-width composer stack. Match
      // the input card: side clearance on a narrow column, the card cap when
      // the column is wider, centered either way.
      margin: '6px auto', alignSelf: 'center', boxSizing: 'border-box',
      width: 'calc(100% - 2 * var(--dsh-composer-side-clearance, 16px))',
      maxWidth: 'var(--dsh-composer-card-max-width, 46rem)',
      fontSize: 12, lineHeight: 1.5,
      whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
    },
  }, error || t(notice))
}
