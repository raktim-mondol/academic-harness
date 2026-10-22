/**
 * Registers ACADEMIC_HARNESS_PROMPT as a system-prompt section, mounted as a row
 * inside the Academic Harness preset (`cordis.patch.yml` preset-academic-harness,
 * plugins sourced from `presets/academic-harness/agent.cordis.yml`) rather than called from
 * `index.js`'s host-level `apply()`. `ctx.systemPrompt.section()` scopes to
 * whatever context registers it (the same scope-only mechanism
 * `@deepseek-ai/dsh-persona` relies on) — called from a preset row, the
 * section is visible only to sessions joined to that preset. Called from the
 * plugin's bundle-level apply() (as it originally was) it registers globally
 * instead, so every session on every preset got the Academic Harness persona and
 * tool guidance even in Standard/PTC/Minimal/Creator mode.
 */
import { ACADEMIC_HARNESS_PROMPT } from './prompt.js'

export const name = 'academic-harness-prompt-section'
export const inject = ['systemPrompt']

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'academic-harness',
    order: 20,
    text: ACADEMIC_HARNESS_PROMPT,
  })
}
