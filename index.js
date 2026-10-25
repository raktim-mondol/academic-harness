import { applyNotebook } from './notebook.js'
import { applyFoldText } from './fold-text.js'
import { applyImageGenerate } from './image-generate.js'
import { applySciInspect } from './sci-inspect.js'
import { applyLatexCompile } from './latex-compile.js'
import { applyPdfToMarkdown } from './pdf-to-markdown.js'
import { applyMermaidRender } from './mermaid-render.js'
import { applyModalRun } from './modal-run.js'
import { applyRunpodRun } from './runpod-run.js'
import { applyVastaiRun } from './vastai-run.js'
import { applyWorkflows } from './workflows.js'
import { applyScientificResult } from './scientific-result.js'
import { seed } from './seed.js'
import { KeysSettingsSchema, registerKeysSettings } from './settings-keys.js'

export const name = 'academic-harness'
export const inject = ['tools', 'settings']
export const Config = KeysSettingsSchema

// The Academic Harness persona and system-prompt guidance are NOT registered
// here: they live in prompt-section.js, mounted as a row inside the
// Academic Harness preset (cordis.patch.yml `preset-academic-harness`, plugins
// sourced from presets/academic-harness/agent.cordis.yml) so they apply only
// to sessions on that preset. This apply() runs at the bundle (host) level —
// every session on every preset — so it carries only the tools and settings
// that are meant to be available everywhere.
export function apply(ctx, config) {
  seed()
  registerKeysSettings(ctx, config)
  applyNotebook(ctx)
  applyFoldText(ctx)
  applyImageGenerate(ctx)
  applySciInspect(ctx)
  applyLatexCompile(ctx)
  applyPdfToMarkdown(ctx)
  applyMermaidRender(ctx)
  applyModalRun(ctx)
  applyRunpodRun(ctx)
  applyVastaiRun(ctx)
  applyWorkflows(ctx)
  applyScientificResult(ctx)
}
