/**
 * academic-harness client plugin: Settings page for Academic Harness API keys
 * plus zvec-grep index progress (header chip + tool card). Uses
 * `ctx.configForms` (DSH 0.2.0; the 0.1.x `settingsScope` seam is gone).
 * Host keys live on the `academic-harness` Loader entry Config.
 */
import { ApiKeysSection } from './ApiKeysSection.jsx'
import { ZvecIndexHeaderAction, ZvecIndexToolView } from './ZvecIndexProgress.jsx'

const ENTRY_ID = 'academic-harness'

export const inject = ['slots', 'configForms']

export function apply(ctx) {
  const scope = ctx.configForms.get(ENTRY_ID)

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
}
