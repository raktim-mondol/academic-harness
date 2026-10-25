/**
 * Registers two preset-scoped system-prompt sections: ACADEMIC_HARNESS_PROMPT
 * (the persona and tool guidance) and RESPONSE_SHAPE (point-first prose for
 * deletion-only folding). Mounted as rows inside the Academic Harness preset
 * (`cordis.patch.yml` preset-academic-harness, plugins sourced from
 * `presets/academic-harness/agent.cordis.yml`) rather than called from
 * `index.js`'s host-level `apply()`. `ctx.systemPrompt.section()` scopes to
 * whatever context registers it (the same scope-only mechanism
 * `@deepseek-ai/dsh-persona` relies on) — called from a preset row, the
 * sections are visible only to sessions joined to that preset. Called from the
 * plugin's bundle-level apply() (as it originally was) they register globally
 * instead, so every session on every preset got the Academic Harness persona and
 * tool guidance even in Standard/PTC/Minimal/Creator mode.
 */
import { ACADEMIC_HARNESS_PROMPT, RESPONSE_SHAPE } from './prompt.js'

export const name = 'academic-harness-prompt-section'
export const inject = ['systemPrompt']

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'academic-harness',
    order: 20,
    text: ACADEMIC_HARNESS_PROMPT,
  })
  ctx.systemPrompt.section({
    name: 'academic-harness-response-shape',
    order: 21,
    text: RESPONSE_SHAPE,
  })
}
