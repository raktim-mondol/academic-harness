import { createElement, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TASK_EFFORTS, TASK_MODES, RESEARCH_TOKEN } from '../task-modes.js'

const row = { display: 'inline-flex', alignItems: 'center', gap: 0, maxWidth: '100%' }
const segment = { font: 'inherit', fontSize: 12, minHeight: 32, padding: '4px 8px', border: 0, borderRadius: 0, color: 'inherit', background: 'transparent', cursor: 'pointer' }
const chip = { display: 'inline-flex', alignItems: 'stretch', position: 'relative', border: '1px solid var(--dsw-border, var(--color-border, currentColor))', borderRadius: 8 }
const menu = { position: 'fixed', zIndex: 1000, minWidth: 190, padding: 4, borderRadius: 10, border: '1px solid var(--dsw-border, var(--color-border, currentColor))', background: 'var(--dsw-surface-overlay, var(--dsw-bg-elevated, var(--color-surface-secondary, Canvas)))', boxShadow: '0 8px 24px rgba(0,0,0,0.28)' }
const menuRow = { display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: 12, font: 'inherit', fontSize: 12, padding: '7px 9px', border: 0, borderRadius: 7, color: 'inherit', background: 'transparent', textAlign: 'left', cursor: 'pointer' }
const MENU_WIDTH = 190
const MENU_ROW_HEIGHT = 31

/**
 * Effort is the right-hand segment of the selected Deep Research chip, so the
 * choice is visible before Send without a second toolbar control. The menu
 * portals above the chip on the bottom composer, matching the model seat and
 * avoiding both toolbar width and ancestor overflow clipping.
 */
export function EffortMenu({ effort, disabled, onEffort, t }) {
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
      style: { ...segment, borderLeft: '1px solid var(--dsw-border, var(--color-border, currentColor))', paddingLeft: 7 },
      disabled,
      'aria-label': t('effort.current', { effort: t(`effort.${effort}`) }),
      'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': open ? id : undefined,
      onClick: () => { if (open) setOpen(false); else show() },
    }, `${t(`effort.${effort}`)} ▾`),
    open && position ? createPortal(createElement('div', {
      key: 'menu', ref: list, id, role: 'menu', 'aria-label': t('effort'),
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

/** One compact task chip; selecting it is what opens the effort segment. */
export function TaskSelectorView({ selected, effort, available, loading, locked, planActive, disabled, onSelect, onEffort, t }) {
  const task = TASK_MODES.find((mode) => mode.enabled)
  const unusable = (planActive || !available) && !selected
  const reason = planActive ? 'planBlocked' : loading ? 'loading' : !available ? 'unavailable' : 'researchDescription'
  const selectedFill = 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-interactive-bg-active, #fff))'
  const selectedInk = 'var(--dsw-alias-label-primary-foreground, #000)'
  return createElement('span', { style: row, 'data-ah-task-selector': true }, [
    createElement('span', {
      key: 'chip',
      style: {
        ...chip,
        background: selected ? selectedFill : 'transparent',
        color: selected ? selectedInk : 'inherit',
        borderColor: selected ? selectedFill : 'var(--dsw-border, var(--color-border, currentColor))',
      },
    }, [
      createElement('button', {
        key: 'task', type: 'button', 'aria-pressed': selected, disabled: locked || unusable,
        onClick: onSelect, title: t(reason),
        style: { ...segment, fontWeight: selected ? 600 : 400 },
      }, `${selected ? '✓ ' : ''}${t(task.id)}`),
      selected ? createElement(EffortMenu, { key: 'effort', effort, disabled: disabled ?? locked, onEffort, t }) : null,
    ]),
  ])
}

/** Standard input/plan hooks keep selection tied to the actual composer command, not a second mode flag. */
export function TaskSelector({ useInput, useTaskMode, useProjection, selectTask, setEffort, t }) {
  const phase = useInput((input) => input.phase)
  const token = useInput((input) => input.claim?.token)
  const plan = useProjection('plan')
  const state = useTaskMode((value) => value)
  const frozen = !['plain', 'claimed'].includes(phase)
  return createElement(TaskSelectorView, {
    ...state, selected: token?.trim() === RESEARCH_TOKEN,
    locked: frozen, disabled: frozen,
    planActive: Boolean(plan && (plan.active || plan.pending)),
    onSelect: selectTask, onEffort: setEffort, t,
  })
}

/**
 * A task command returns when the background job is accepted. The empty-session
 * hero can show no transcript node yet, so this persistent receipt is the
 * immediate answer to "did my message go anywhere?".
 */
export function TaskRunNotice({ useTaskMode, dismiss, t }) {
  const task = useTaskMode((state) => state.lastTask)
  if (!task) return null
  const meta = [t(`effort.${task.effort}`), task.runId, task.jobId].filter(Boolean).join(' · ')
  const prompt = task.prompt.length > 180 ? `${task.prompt.slice(0, 180)}…` : task.prompt
  return createElement('div', {
    'data-ah-task-run': true, role: 'status',
    style: {
      display: 'flex', alignItems: 'flex-start', gap: 8, margin: '6px 0', padding: '8px 10px',
      fontSize: 12, lineHeight: 1.45, border: '1px solid var(--dsw-alias-state-business-primary, var(--color-border, currentColor))',
      borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1, transparent)',
    },
  }, [
    createElement('span', {
      key: 'dot', 'aria-hidden': true,
      style: { width: 8, height: 8, marginTop: 5, flex: '0 0 auto', borderRadius: '50%', background: 'var(--dsw-alias-state-business-primary, #22c55e)' },
    }),
    createElement('div', { key: 'body', style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 } }, [
      createElement('strong', { key: 'title' }, t('started')),
      createElement('span', { key: 'prompt', style: { overflowWrap: 'anywhere' } }, prompt),
      createElement('span', { key: 'meta', style: { opacity: 0.75 } }, [meta, t('backgroundHint')].filter(Boolean).join(' · ')),
    ]),
    createElement('button', {
      key: 'dismiss', type: 'button', onClick: dismiss, 'aria-label': t('dismiss'), title: t('dismiss'),
      style: { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 },
    }, '×'),
  ])
}

/** Long task guidance belongs in a full-width composer dock, not its compact toolbar. */
export function TaskSelectorStatus({ useInput, useTaskMode, t }) {
  const selected = useInput((input) => input.claim?.token?.trim() === RESEARCH_TOKEN)
  const error = useTaskMode((state) => state.error)
  if (!selected && !error) return null
  return createElement('p', {
    'data-ah-task-status': true, role: error ? 'alert' : 'status',
    style: { margin: '6px 0', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '100%' },
  }, error || t('costNotice'))
}
