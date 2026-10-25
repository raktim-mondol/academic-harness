import { useState } from 'react'
import { ReplyFoldView, closingAssistantText, readFoldLevel, writeFoldLevel } from './reply-fold.js'

/**
 * A turn-tail contribution: read the completed turn's closing assistant prose
 * at five levels. The original message stays mounted above it; this only adds
 * the row and an optional folded panel.
 */
export function ReplyFold({ turn, useChat, openFoldPane }) {
  const turnNumber = turn && typeof turn === 'object' ? turn.turn : turn
  const text = useChat((snapshot) => closingAssistantText(snapshot, turnNumber))
  const [level, setLevel] = useState(readFoldLevel)
  const select = (next) => {
    setLevel(next)
    writeFoldLevel(next)
  }
  const openPane = openFoldPane
    ? (payload) => {
        try {
          openFoldPane(payload)
        } catch (error) {
          console.warn('[academic-harness] could not open the fold pane', error)
        }
      }
    : undefined
  return <ReplyFoldView text={text} level={level} onSelect={select} onOpenPane={openPane} />
}
