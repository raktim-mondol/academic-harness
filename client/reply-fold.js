/**
 * Reply folding for the chat turn tail.
 *
 * The fold engine is fold-core.js, shared with fold_text. This module holds the
 * snapshot selector, the persisted level, and a presentational view. It uses
 * React.createElement rather than JSX so the view can be server-rendered in
 * tests without a browser.
 */
import { createElement, useId, useMemo } from 'react'
import { foldReply, foldStats, worthFolding } from '../fold-core.js'

export const FOLD_LEVELS = ['full', 'brief', 'points', 'outline', 'gist']
export const LEVEL_LABELS = { full: 'Full', brief: 'Brief', points: 'Points', outline: 'Outline', gist: 'Gist' }
export const FOLD_STORAGE_KEY = 'ah-fold-level'
export const FOLD_TAB_ID = 'academic-harness-reply-fold-pane'

export function readFoldLevel() {
  try {
    const value = globalThis.localStorage?.getItem(FOLD_STORAGE_KEY)
    return FOLD_LEVELS.includes(value) ? value : 'full'
  } catch {
    return 'full'
  }
}

export function writeFoldLevel(level) {
  if (!FOLD_LEVELS.includes(level)) return
  try {
    globalThis.localStorage?.setItem(FOLD_STORAGE_KEY, level)
  } catch {
    // A browser that refuses storage still gets the fold for this render.
  }
}

/**
 * The last text-bearing assistant message in a Turn, or ''. Reasoning and tool
 * blocks are deliberately excluded: the fold is for the prose the reader sees.
 */
export function closingAssistantText(snapshot, turn) {
  if (!snapshot?.locations || !snapshot?.nodes || !Number.isInteger(turn)) return ''
  const keys = snapshot.locations.getTurn(turn) ?? []
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const node = snapshot.nodes.get(keys[index])
    if (node?.kind !== 'assistant-step') continue
    const blocks = node.data?.finalNode?.blocks ?? node.data?.blocks ?? []
    const text = blocks
      .filter((block) => block?.kind === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n\n')
      .trim()
    if (text) return text
  }
  return ''
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\([^)]+\))/g

function renderInline(text, prefix) {
  const input = String(text ?? '')
  if (!input) return []
  const out = []
  let last = 0
  let n = 0
  for (const match of input.matchAll(INLINE)) {
    if (match.index > last) out.push(input.slice(last, match.index))
    const token = match[0]
    const key = `${prefix}-${n++}`
    if (token.startsWith('`')) {
      out.push(createElement('code', { key, style: inlineCodeStyle }, token.slice(1, -1)))
    } else if (token.startsWith('**')) {
      out.push(createElement('strong', { key }, renderInline(token.slice(2, -2), `${key}-b`)))
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      out.push(link ? createElement('span', { key, title: link[2] }, renderInline(link[1], `${key}-l`)) : token)
    } else {
      out.push(createElement('em', { key }, renderInline(token.slice(1, -1), `${key}-i`)))
    }
    last = match.index + token.length
  }
  if (last < input.length) out.push(input.slice(last))
  return out
}

function renderBlock(block, index) {
  switch (block.kind) {
    case 'heading': {
      const text = String(block.lines?.[0] ?? '').replace(/^#{1,6}\s+/, '')
      const level = Math.min(6, Math.max(1, Number(block.level) || 2))
      return createElement('div', {
        key: `h${index}`,
        role: 'heading',
        'aria-level': level,
        style: headingStyle,
      }, renderInline(text, `h${index}`))
    }
    case 'paragraph':
      return createElement('p', { key: `p${index}`, style: paragraphStyle }, renderInline(block.text, `p${index}`))
    case 'quote':
      return createElement('blockquote', { key: `q${index}`, style: quoteStyle }, renderInline(block.text, `q${index}`))
    case 'list': {
      const items = (block.items ?? []).map((item, n) => createElement('li', {
        key: `li${index}-${n}`,
        style: { marginLeft: item.indent ? item.indent * 8 : 0 },
      }, renderInline(`${item.text}${item.more ? ' …' : ''}`, `li${index}-${n}`)))
      return createElement(block.ordered ? 'ol' : 'ul', { key: `l${index}`, style: listStyle }, items)
    }
    case 'table': {
      const rows = block.rows ?? []
      if (!rows.length) return createElement('pre', { key: `t${index}`, style: codeStyle }, (block.lines ?? []).join('\n'))
      const head = rows[0].map((cell, n) => createElement('th', { key: `th${index}-${n}`, style: cellStyle }, renderInline(cell, `th${index}-${n}`)))
      const body = rows.slice(1).map((row, r) => createElement('tr', { key: `tr${index}-${r}` },
        row.map((cell, n) => createElement('td', { key: `td${index}-${r}-${n}`, style: cellStyle }, renderInline(cell, `td${index}-${r}-${n}`)))))
      return createElement('table', { key: `t${index}`, style: tableStyle }, [
        createElement('thead', { key: 'head' }, createElement('tr', null, head)),
        createElement('tbody', { key: 'body' }, body),
      ])
    }
    case 'code': {
      const lines = block.lines ?? []
      const first = String(lines[0] ?? '').trim()
      const last = String(lines[lines.length - 1] ?? '').trim()
      const fenced = /^(`{3,}|~{3,})/.test(first) && /^(`{3,}|~{3,})/.test(last)
      const code = (fenced ? lines.slice(1, -1) : lines).join('\n')
      return createElement('pre', { key: `c${index}`, style: codeStyle }, createElement('code', null, code))
    }
    case 'rule':
      return createElement('hr', { key: `r${index}`, style: ruleStyle })
    default:
      return null
  }
}

/**
 * The folded content at one level, without the level row. Used by the inline
 * panel (for a non-Full level) and by the right-sidebar pane (for every level,
 * including Full).
 */
export function FoldContent({ text, level }) {
  const source = typeof text === 'string' ? text : ''
  const requested = FOLD_LEVELS.includes(level) ? level : 'full'
  const folded = useMemo(() => foldReply(source, requested), [source, requested])
  const stats = foldStats(source, folded.text)
  const label = LEVEL_LABELS[folded.level] ?? 'Brief'
  return createElement('div', { 'data-ah-fold-content': true, style: contentStyle }, [
    createElement('div', { key: 'blocks', style: blocksStyle }, (folded.blocks ?? []).map(renderBlock).filter(Boolean)),
    createElement('div', { key: 'footer', style: footerStyle }, `${label} · ${stats.words_after}/${stats.words_before} words`),
  ])
}

/** The level buttons shared by the inline row and the sidebar pane. */
export function FoldLevelRow({
  level,
  onSelect,
  onOpenPane,
  label = 'Read folded:',
  ariaLabel = 'Read this reply folded',
  panelId,
}) {
  const requested = FOLD_LEVELS.includes(level) ? level : 'full'
  return createElement('div', {
    'data-ah-fold-row': true,
    role: 'group',
    'aria-label': ariaLabel,
    style: rowStyle,
  }, [
    createElement('span', { key: 'label', style: labelStyle }, label),
    ...FOLD_LEVELS.map((name) => createElement('button', {
      key: name,
      type: 'button',
      'aria-pressed': requested === name,
      'aria-expanded': requested === name ? requested !== 'full' : undefined,
      'aria-controls': panelId && requested === name && requested !== 'full' ? panelId : undefined,
      onClick: () => onSelect?.(name),
      style: requested === name ? selectedButtonStyle : buttonStyle,
    }, LEVEL_LABELS[name])),
    onOpenPane ? createElement('button', {
      key: 'pane',
      type: 'button',
      onClick: () => onOpenPane(requested),
      style: paneActionStyle,
    }, 'Open in sidebar') : null,
  ])
}

/**
 * The visible fold row and, below it, the folded blocks. The original chat
 * message stays mounted above this component; nothing here replaces it.
 */
export function ReplyFoldView({ text, level, onSelect, onOpenPane }) {
  const source = typeof text === 'string' ? text : ''
  const requested = FOLD_LEVELS.includes(level) ? level : 'full'
  const panelId = useId()
  const gist = useMemo(() => foldReply(source, 'gist'), [source])
  const applied = useMemo(() => (requested === 'full' ? null : foldReply(source, requested)), [source, requested])
  if (!source.trim() || !gist.text.trim() || !worthFolding(source, gist.text)) return null

  const label = applied ? LEVEL_LABELS[applied.level] ?? 'Brief' : ''
  const row = createElement(FoldLevelRow, {
    level: requested,
    onSelect,
    panelId,
    onOpenPane: onOpenPane ? (nextLevel) => onOpenPane({ text: source, level: nextLevel }) : undefined,
  })

  const panel = requested === 'full' ? null : createElement('div', {
    id: panelId,
    'data-ah-fold-panel': true,
    role: 'region',
    'aria-label': `Folded reply, ${label} level`,
    style: panelStyle,
  }, createElement(FoldContent, { text: source, level: requested }))

  return createElement('div', { 'data-ah-fold-root': true, style: rootStyle }, row, panel)
}

const rootStyle = { marginTop: 6, color: 'inherit', fontFamily: 'inherit' }
const rowStyle = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, fontSize: '0.78em', lineHeight: 1.4, opacity: 0.85 }
const labelStyle = { opacity: 0.55, marginRight: 2 }
const buttonStyle = {
  border: '1px solid transparent',
  background: 'transparent',
  color: 'inherit',
  borderRadius: 999,
  padding: '1px 8px',
  fontFamily: 'inherit',
  fontSize: '1em',
  cursor: 'pointer',
  opacity: 0.7,
}
const selectedButtonStyle = {
  ...buttonStyle,
  background: 'var(--color-surface-tertiary, rgba(127,127,127,0.18))',
  borderColor: 'var(--color-border, rgba(127,127,127,0.28))',
  opacity: 1,
}
const panelStyle = {
  marginTop: 6,
  padding: '8px 10px',
  border: '1px solid var(--color-border, rgba(127,127,127,0.22))',
  borderRadius: 8,
  background: 'var(--color-surface-secondary, rgba(127,127,127,0.07))',
  fontSize: '0.92em',
  lineHeight: 1.55,
}
const blocksStyle = { display: 'flex', flexDirection: 'column', gap: 6 }
const contentStyle = { display: 'flex', flexDirection: 'column', gap: 6 }
const paneActionStyle = {
  marginLeft: 'auto',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  fontFamily: 'inherit',
  fontSize: '0.95em',
  cursor: 'pointer',
  opacity: 0.6,
  textDecoration: 'underline',
  padding: '1px 2px',
}
const headingStyle = { margin: 0, fontWeight: 600, fontSize: '1em', lineHeight: 1.4 }
const paragraphStyle = { margin: 0 }
const quoteStyle = { margin: 0, paddingLeft: 10, borderLeft: '3px solid var(--color-border, rgba(127,127,127,0.3))', opacity: 0.9 }
const listStyle = { margin: 0, paddingLeft: '1.25em' }
const inlineCodeStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '0.92em',
  padding: '0 3px',
  borderRadius: 4,
  background: 'var(--color-surface-tertiary, rgba(127,127,127,0.14))',
}
const codeStyle = {
  margin: 0,
  padding: 8,
  borderRadius: 6,
  background: 'var(--color-surface-tertiary, rgba(127,127,127,0.12))',
  overflowX: 'auto',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '0.9em',
  lineHeight: 1.45,
}
const tableStyle = { borderCollapse: 'collapse', width: '100%', fontSize: '0.92em' }
const cellStyle = { border: '1px solid var(--color-border, rgba(127,127,127,0.22))', padding: '3px 6px', textAlign: 'left', verticalAlign: 'top' }
const ruleStyle = { border: 0, borderTop: '1px solid var(--color-border, rgba(127,127,127,0.25))', margin: '4px 0' }
const footerStyle = { marginTop: 6, opacity: 0.55, fontSize: '0.85em' }
