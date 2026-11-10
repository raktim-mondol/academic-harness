/**
 * `skill_search` and `skill_load`: the bundled skills outside the host catalogue.
 *
 * Mounted as a row in the Academic Harness preset (like the other tool modules).
 * It does not shadow the host's `skill` tool: that tool and its catalogue keep
 * serving the core skills and anything a user installed, and `/name` invocation
 * is untouched. These two tools reach the rest of the bundle (decision D39).
 */
import { defineTool } from 'ah-dsh-tools'
import { loadSkill, renderLoadedSkill, searchSkills } from './skill-index.js'

export const name = 'academic-harness-skill-on-demand'
export const inject = ['tools']

export function renderSearch(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (!value.results.length) {
    return [{ type: 'text', text: `No bundled skill matches "${value.query}" (searched ${value.total}). Try other keywords for the task or the field; if none fits, continue without a skill.` }]
  }
  const lines = value.results.map((r) => `- \`${r.name}\`${r.in_catalog ? ' (in the session catalogue)' : ''}: ${r.description}`)
  return [{
    type: 'text',
    text: [
      `${value.results.length} of ${value.total} bundled skills match "${value.query}":`,
      ...lines,
      '',
      'Call skill_load with the exact name to read the instructions before acting. These are summaries only.',
    ].join('\n'),
  }]
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'skill_search',
    description: [
      'Find a bundled skill by task. The session catalogue lists only the core skills; hundreds more (genomics, chemistry, physics, statistics, clinical, engineering, writing, …) are searchable here and cost no context until loaded.',
      'Describe the task or the field in a few words; results are ranked name and description summaries.',
      'Then call skill_load with the exact name. Skills are instructions: follow them, then do the work with the normal tools.',
    ].join(' '),
    parameters: {
      query: { type: 'string', required: true, description: 'The task or field, in plain words (for example "single-cell clustering" or "grant budget").' },
      limit: { type: 'number', description: 'Maximum results, 1-25. Default 8.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => renderSearch(value) },
    async execute(args) {
      const query = String(args.query ?? '').trim()
      if (!query) return { error: 'query is required' }
      const { results, total } = searchSkills(query, { limit: args.limit })
      return { query, results, total }
    },
    presentCall(args) {
      return { card: 'generic', title: `Search skills: ${args.query || ''}`, kind: 'search' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'skill_load',
    description: 'Load the full instructions of a bundled skill by exact name (from skill_search, or a name the prompt gives). Use it for skills outside the session catalogue; for catalogue skills the `skill` tool does the same.',
    parameters: {
      name: { type: 'string', required: true, description: 'The exact skill name.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.error ? `Error: ${value.error}` : renderLoadedSkill(value) }],
    },
    async execute(args) {
      return loadSkill(args.name)
    },
    presentCall(args) {
      return { card: 'generic', title: `Load skill ${args.name || ''}`, kind: 'read', rawInput: args.name }
    },
  }))
}
