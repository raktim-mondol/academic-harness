/** Browser-safe task catalogue and wire validation. Only Phase 1 is enabled. */
export const TASK_COMMAND = 'academic-task'
export const RESEARCH_TOKEN = '/research'
export const TASK_EFFORTS = Object.freeze(['auto', 'low', 'medium', 'high'])
export const TASK_MODES = Object.freeze([
  { id: 'deep_research', label: 'Deep Research', phase: 1, enabled: true },
  { id: 'deep_review', label: 'Deep Review', phase: 2, enabled: false },
  { id: 'find_papers', label: 'Find Papers', phase: 3, enabled: false },
  { id: 'check_references', label: 'Check References', phase: 4, enabled: false },
  { id: 'write_revise', label: 'Write / Revise', phase: 5, enabled: false },
  { id: 'analyze_data', label: 'Analyze Data', phase: 6, enabled: false },
  { id: 'generate_hypotheses', label: 'Generate Hypotheses', phase: 7, enabled: false },
].map(Object.freeze))

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
  if (typeof value.prompt !== 'string' || !value.prompt.trim()) throw new Error('enter a research question first')
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
