import { createElement, useEffect, useState } from 'react'
import {
  FOLD_LEVELS,
  FOLD_TAB_ID,
  FoldContent,
  FoldLevelRow,
  readFoldLevel,
  writeFoldLevel,
} from './reply-fold.js'

/**
 * The right-dock reading pane. It receives the reply through the tab's
 * navigation params, so it never reaches into the Chat snapshot across
 * surfaces. Opening another reply navigates the same tab and resets the level
 * from the new params.
 */
export function FoldPane({ useTabInfo }) {
  const info = useTabInfo()
  const navigation = info?.tab?.navigation
  const params = navigation?.params ?? {}
  const text = typeof params.text === 'string' ? params.text : ''
  const requested = FOLD_LEVELS.includes(params.level) ? params.level : readFoldLevel()
  const revision = navigation?.revision ?? 0

  const [level, setLevel] = useState(requested)
  useEffect(() => {
    setLevel(requested)
  }, [revision, requested])

  const select = (next) => {
    setLevel(next)
    writeFoldLevel(next)
  }

  if (!text) {
    return createElement('div', { style: emptyStyle }, [
      'Open a reply with ',
      createElement('strong', { key: 'strong' }, 'Open in sidebar'),
      ' to read it here at another level.',
    ])
  }

  return createElement('div', { 'data-ah-fold-pane': FOLD_TAB_ID, style: paneStyle }, [
    createElement('div', { key: 'header', style: headerStyle }, [
      createElement('span', { key: 'title', style: titleStyle }, 'Read folded'),
      createElement('span', { key: 'hint', style: hintStyle }, 'Chat reply, at the level you choose'),
    ]),
    createElement(FoldLevelRow, {
      key: 'levels',
      level,
      onSelect: select,
      label: 'Level:',
      ariaLabel: 'Folded reply level',
    }),
    createElement('div', { key: 'content', style: contentStyle },
      createElement(FoldContent, { text, level })),
  ])
}

const paneStyle = {
  height: '100%',
  boxSizing: 'border-box',
  padding: '14px 16px',
  overflow: 'auto',
  color: 'inherit',
  fontFamily: 'inherit',
}
const headerStyle = { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }
const titleStyle = { fontWeight: 600, fontSize: '0.95em' }
const hintStyle = { opacity: 0.55, fontSize: '0.8em' }
const contentStyle = { marginTop: 10, fontSize: '0.95em', lineHeight: 1.55 }
const emptyStyle = { padding: 16, opacity: 0.65, fontSize: '0.9em', lineHeight: 1.5 }
