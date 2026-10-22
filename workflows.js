import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

const HERE = dirname(fileURLToPath(import.meta.url))

let cache = null
function loadWorkflows() {
  if (!cache) cache = JSON.parse(readFileSync(join(HERE, 'workflows.json'), 'utf8'))
  return cache
}

function summary(w) {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    category: w.category,
    requiresFiles: Boolean(w.requiresFiles),
    placeholders: w.placeholders?.map((p) => ({ key: p.key, label: p.label, required: Boolean(p.required) })) ?? [],
  }
}

/** Fill `{key}` tokens in a workflow prompt from a values map; unfilled tokens stay literal. */
export function fillPrompt(prompt, values = {}) {
  return prompt.replace(/\{(\w+)\}/g, (match, key) => {
    const v = values[key]
    return typeof v === 'string' && v.trim() ? v.trim() : match
  })
}

/** Catalogue lookup used by the `research_template` tool. Exported for tests. */
export function queryResearchTemplates(args = {}) {
  const all = loadWorkflows()
  const action = args.action ?? 'list'

  if (action === 'get') {
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (!id) return { error: 'action=get requires id' }
    const w = all.find((x) => x.id === id)
    if (!w) return { error: `unknown workflow id "${id}". Use action=list to browse.` }
    const missing = (w.placeholders ?? [])
      .filter((p) => p.required && !(args.values && typeof args.values[p.key] === 'string' && args.values[p.key].trim()))
      .map((p) => p.key)
    return {
      id: w.id,
      name: w.name,
      category: w.category,
      requiresFiles: Boolean(w.requiresFiles),
      suggestedSkills: w.suggestedSkills ?? [],
      prompt: fillPrompt(w.prompt, args.values),
      ...(missing.length ? { missing_required_values: missing } : {}),
    }
  }

  let list = all
  if (args.category) list = list.filter((w) => w.category === args.category)
  if (args.query) {
    const q = args.query.toLowerCase()
    list = list.filter((w) => w.name.toLowerCase().includes(q) || w.description.toLowerCase().includes(q))
  }
  return { workflows: list.map(summary) }
}

/**
 * Register the Academic Harness task-template catalogue.
 *
 * Named `research_template`, not `workflow`: the Academic Harness preset also
 * mounts DSH's Rhai `workflow` tool (`@deepseek-ai/dsh-tool-workflow`), and
 * scoped tools shadow globals — a same-name register here was invisible to
 * the agent (verified: `workflow action=get id=agentify-paper` ran a Rhai
 * script instead of this catalogue).
 */
export function applyWorkflows(ctx) {
  ctx.tools.register(defineTool({
    name: 'research_template',
    description: [
      'Browse and use Academic Harness\'s catalogue of ~330 one-click research task templates across 22 disciplines',
      '(paper, literature, genomics, chemistry, clinical, ml, statistics, grants, and more).',
      'Not the DSH Rhai `workflow` orchestrator — this is prompt templates only.',
      'Use action "list" (default) to browse by category and/or search text — returns compact summaries, not full prompts.',
      'Use action "get" with an id to retrieve one template\'s full prompt, filling any {placeholder} tokens from "values".',
      'A template is a starting point, not a substitute for your own judgment — adapt it to the actual request.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ['list', 'get'], description: 'list (default) browses; get retrieves one template.' },
      category: {
        type: 'string',
        enum: ['astro', 'cellbio', 'chemistry', 'clinical', 'data', 'drugdiscovery', 'ecology', 'engineering', 'finance', 'genomics', 'grants', 'literature', 'materials', 'math', 'ml', 'neuro', 'paper', 'physics', 'proteomics', 'scicomm', 'social', 'visual'],
        description: 'Filter by discipline category (action=list).',
      },
      query: { type: 'string', description: 'Case-insensitive substring match against name/description (action=list).' },
      id: { type: 'string', description: 'Workflow id (action=get, e.g. "review-paper").' },
      values: {
        type: 'object',
        additionalProperties: true,
        description: 'Placeholder key → string value substitutions for the template\'s {placeholder} tokens (action=get).',
      },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        if (Array.isArray(value.workflows)) {
          return [{ type: 'text', text: `${value.workflows.length} workflow(s):\n${value.workflows.map((w) => `- ${w.id}: ${w.name} (${w.category})`).join('\n')}` }]
        }
        if (value.error) return [{ type: 'text', text: value.error }]
        return [{ type: 'text', text: value.prompt }]
      },
    },
    async execute(args) {
      return queryResearchTemplates(args)
    },
  }))
}
