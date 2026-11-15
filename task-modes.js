/** Browser-safe task catalogue and wire validation. All seven composer tasks are enabled. */
export const TASK_COMMAND = 'academic-task'
export const RESEARCH_TOKEN = '/research'
export const REVIEW_TOKEN = '/review'
export const PAPERS_TOKEN = '/papers'
export const REFERENCES_TOKEN = '/references'
export const WRITE_TOKEN = '/write'
export const ANALYZE_TOKEN = '/analyze'
export const HYPOTHESES_TOKEN = '/hypotheses'
export const TASK_EFFORTS = Object.freeze(['auto', 'low', 'medium', 'high'])
/** Composer effort for Deep Review. Auto omits topology so the engine keeps MID. Extra high stays a tool argument. */
export const REVIEW_TOPOLOGY = Object.freeze({ low: 'LOW', medium: 'MID', high: 'HIGH' })
/** Composer effort for Find Papers. Auto omits max_results so literature_search keeps 20. */
export const PAPER_LIMITS = Object.freeze({ low: 10, medium: 20, high: 50 })
/** Composer effort for Check References. Auto omits max_audit so citation audit keeps 100. */
export const AUDIT_LIMITS = Object.freeze({ low: 25, medium: 100, high: 250 })
/** Composer effort for Write / Revise. Auto omits compile so a TeX diff keeps the tool default. */
export const REVISION_COMPILE = Object.freeze({ low: false, medium: true, high: true })
/** Composer effort for Generate Hypotheses. Auto omits max_hypotheses so the tournament keeps 5. */
export const HYPOTHESIS_LIMITS = Object.freeze({ low: 3, medium: 5, high: 8 })
const TASK_TOKENS = Object.freeze({
  deep_research: RESEARCH_TOKEN,
  deep_review: REVIEW_TOKEN,
  find_papers: PAPERS_TOKEN,
  check_references: REFERENCES_TOKEN,
  write_revise: WRITE_TOKEN,
  analyze_data: ANALYZE_TOKEN,
  generate_hypotheses: HYPOTHESES_TOKEN,
})
export const TASK_MODES = Object.freeze([
  { id: 'deep_research', label: 'Deep Research', phase: 1, enabled: true },
  { id: 'deep_review', label: 'Deep Review', phase: 2, enabled: true },
  { id: 'find_papers', label: 'Find Papers', phase: 3, enabled: true },
  { id: 'check_references', label: 'Check References', phase: 4, enabled: true },
  { id: 'write_revise', label: 'Write / Revise', phase: 5, enabled: true },
  { id: 'analyze_data', label: 'Analyze Data', phase: 6, enabled: true },
  { id: 'generate_hypotheses', label: 'Generate Hypotheses', phase: 7, enabled: true },
].map(Object.freeze))

export function taskToken(task) {
  const token = TASK_TOKENS[task]
  if (!token) throw new Error('task is not available')
  return token
}

export function taskForToken(token) {
  const normalized = String(token ?? '').trim()
  return Object.entries(TASK_TOKENS).find(([, value]) => value === normalized)?.[0]
}

function object(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} contains unknown fields`)
}

/** Validate untrusted command input without trimming or rewriting the prompt. */
export function validateTaskRequest(value) {
  object(value, 'task request', ['version', 'request_id', 'task', 'prompt', 'options'])
  if (value.version !== 1) throw new Error('unsupported task request version')
  if (typeof value.request_id !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/u.test(value.request_id)) {
    throw new Error('task request_id must contain 16–100 letters, digits, dashes, or underscores')
  }
  if (!TASK_MODES.some((mode) => mode.id === value.task && mode.enabled)) throw new Error('task is not available')
  if (typeof value.prompt !== 'string' || !value.prompt.trim()) {
    const empty = {
      deep_review: 'enter a manuscript path first',
      find_papers: 'enter a search query first',
      check_references: 'enter a bibliography path first',
      write_revise: 'enter the two manuscript paths first',
      analyze_data: 'enter an analysis question first',
      generate_hypotheses: 'enter a research goal first',
    }
    throw new Error(empty[value.task] || 'enter a research question first')
  }
  if (value.prompt.length > 64_000) throw new Error('research prompt exceeds 64000 characters')
  const options = value.options ?? {}
  object(options, 'task options', ['effort'])
  const effort = options.effort ?? 'auto'
  if (!TASK_EFFORTS.includes(effort)) throw new Error('effort must be auto, low, medium, or high')
  return { version: 1, request_id: value.request_id, task: value.task, prompt: value.prompt, options: { effort } }
}

/** Encode one request for the host's durable command execution path. */
export function taskCommandLine(request) {
  return `/${TASK_COMMAND} ${JSON.stringify(validateTaskRequest(request))}`
}
