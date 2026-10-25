/**
 * academic-harness client plugin: Settings page for Academic Harness API keys
 * plus zvec-grep index progress (header chip + tool card). Uses
 * `ctx.configForms` (DSH 0.2.0; the 0.1.x `settingsScope` seam is gone).
 * Host keys live on the `academic-harness` Loader entry Config.
 */
import { ApiKeysSection } from './ApiKeysSection.jsx'
import { ZvecIndexHeaderAction, ZvecIndexToolView } from './ZvecIndexProgress.jsx'
import { FoldPane } from './FoldPane.js'
import { ReplyFold } from './ReplyFold.jsx'
import { FOLD_TAB_ID } from './reply-fold.js'

const ENTRY_ID = 'academic-harness'

export const inject = ['slots', 'configForms', 'sidebarRight', 'sidebarRightTabs']

export function apply(ctx) {
  const scope = ctx.configForms.get(ENTRY_ID)

  const openFoldPane = ({ text, level }) => {
    ctx.sidebarRight.openTab(FOLD_TAB_ID, { params: { text, level } })
  }

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: FOLD_TAB_ID,
    kind: FOLD_TAB_ID,
    title: () => 'Read folded',
    keepMounted: true,
  }), 'academic-harness: reply fold pane type')

  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: FOLD_TAB_ID,
  }, FoldPane))

  ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'academic-harness-api-keys',
    order: 60,
    label: () => 'Academic Harness API keys',
    inject: () => ({ scope }),
  }, ApiKeysSection))))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'zvec-index-progress',
    order: 25,
    inject: () => ({ scope }),
  }, ZvecIndexHeaderAction))

  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'zvec_index',
    inject: () => ({ scope }),
  }, ZvecIndexToolView))

  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: 'academic-harness-reply-fold',
    order: 40,
    inject: () => ({ openFoldPane }),
  }, ReplyFold))
}
