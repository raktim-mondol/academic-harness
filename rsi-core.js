/**
 * The local RSI learning loop: classify research work, turn tool outcomes into
 * signals, diagnose recurring failures, admit short lessons automatically, and
 * select the lessons injected into later turns.
 *
 * The loop only edits lesson text in its own store. It never edits the plugin,
 * the vendored `ah` engine, the project, or the audit/evaluation code.
 */
import {
  appendDecision, appendJsonl, appendLesson, currentLessons, effectiveConfig, ensureStore,
  lessonId, nowIso, normalizeLessonText, oracleManifest, pluginVersion, readJsonl, readMeta, sha1,
  updateMeta, withStoreLock,
} from './rsi-store.js'

export const TASK_CLASSES = [
  'literature', 'hypothesis', 'experiment', 'data-analysis', 'statistics', 'manuscript',
  'grant', 'review-response', 'reproducibility', 'data-management', 'general-research',
]

const TASK_RULES = [
  {
    id: 'statistics',
    weight: 1.25,
    words: [
      'p-value', 'p value', 'statistical', 'statistic', 'confidence interval', 'effect size',
      'anova', 'regression coefficient', 'bayesian', 'posterior', 'hypothesis test',
      'multiple comparison', 'multiple comparisons', 'grim', 'grimmer', 'power analysis',
      'sample size', 'significance', 'significant', 'standard deviation', 'standard error',
    ],
  },
  {
    id: 'hypothesis',
    weight: 1.2,
    words: [
      'hypothesis', 'hypotheses', 'research question', 'falsifiable', 'mechanism',
      'novel target', 'drug repurposing', 'what should we test', 'candidate explanation',
      'predict', 'prediction', 'theory',
    ],
  },
  {
    id: 'experiment',
    weight: 1.15,
    words: [
      'experiment', 'experimental design', 'protocol', 'randomization', 'randomised',
      'randomized', 'preregister', 'pre-register', 'preregistration', 'pre-registration',
      'control group', 'treatment arm', 'eligibility', 'endpoint', 'ablation', 'study design',
    ],
  },
  {
    id: 'data-analysis',
    weight: 1.1,
    words: [
      'dataset', 'data set', 'dataframe', 'csv', 'parquet', 'pandas', 'numpy', 'r studio',
      'analysis pipeline', 'machine learning', 'train', 'training', 'model fit', 'regression',
      'classification', 'clustering', 'notebook', 'jupyter', 'feature engineering',
      'data cleaning', 'data analysis', 'analyse', 'analyze', 'analysis',
    ],
  },
  {
    id: 'literature',
    weight: 1.05,
    words: [
      'literature', 'systematic review', 'scoping review', 'prisma', 'paper', 'papers',
      'citation', 'citations', 'doi', 'arxiv', 'pubmed', 'openalex', 'semantic scholar',
      'bibliography', 'related work', 'survey', 'state of the art', 'evidence synthesis',
    ],
  },
  {
    id: 'manuscript',
    weight: 1.0,
    words: [
      'manuscript', 'write', 'draft', 'abstract', 'introduction', 'methods', 'results',
      'discussion', 'conclusion', 'section', 'paragraph', 'latex', 'tex', 'revision',
      'revise', 'edit', 'proofread', 'thesis', 'chapter', 'journal', 'camera ready',
    ],
  },
  {
    id: 'grant',
    weight: 1.0,
    words: [
      'grant', 'proposal', 'funder', 'funding', 'specific aims', 'aims', 'nih', 'nsf',
      'erc', 'wellcome', 'budget justification', 'study section', 'call for proposals',
    ],
  },
  {
    id: 'review-response',
    weight: 1.0,
    words: [
      'reviewer', 'reviewers', 'rebuttal', 'response to reviewers', 'review comments',
      'revise and resubmit', 'r1', 'r2', 'referee',
    ],
  },
  {
    id: 'reproducibility',
    weight: 1.0,
    words: [
      'reproducible', 'reproducibility', 'replicate', 'replication', 'container', 'docker',
      'environment', 'requirements', 'lockfile', 'one command', 'reproduction', 'workflow',
    ],
  },
  {
    id: 'data-management',
    weight: 0.95,
    words: [
      'data availability', 'data management', 'dmp', 'repository', 'zenodo', 'figshare',
      'datacite', 'metadata', 'license', 'fair data', 'accession', 'deposit', 'open data',
    ],
  },
]

const TASK_WORKFLOW = {
  literature: {
    text: 'For literature tasks, start with literature_search or openalex_search/s2_search, resolve identifiers with paper_resolve, ingest what you will cite into PaperMemory, and cite only verified memory hits.',
    action: 'literature_search',
  },
  hypothesis: {
    text: 'For hypothesis-generation tasks, load generating-scientific-hypotheses and return ranked, falsifiable hypotheses with predictions and discriminating tests; do not jump to outcome analysis.',
    action: 'generating-scientific-hypotheses',
  },
  experiment: {
    text: 'For experiment-design tasks, load designing-the-analysis or preregistering-analysis before touching outcomes; state the design, sample-size/power rationale, and decision rules.',
    action: 'designing-the-analysis',
  },
  'data-analysis': {
    text: 'For data-analysis tasks, load agentic-data-science-pipeline, log each command and result in the notebook, and rerun the analysis before making a claim.',
    action: 'agentic-data-science-pipeline',
  },
  statistics: {
    text: 'For statistical claims, run stat_audit and report the test, N, effect size, and confidence interval; do not call a boundary p-value significant.',
    action: 'stat_audit',
  },
  manuscript: {
    text: 'For manuscript tasks, load academic-harness and use ah_* tools; run manuscript_citations and integrity_check before submission.',
    action: 'academic-harness',
  },
  grant: {
    text: 'For grant tasks, check funder requirements with funder_policy and use grant_search before drafting aims, significance, and approach.',
    action: 'funder_policy',
  },
  'review-response': {
    text: 'For review-response tasks, import comments with ah_review before revising, map each item to units, and build the letter with ah_review_respond.',
    action: 'ah_review',
  },
  reproducibility: {
    text: 'For reproducibility tasks, run repo_audit and record the exact environment and one-command reproduction path.',
    action: 'repo_audit',
  },
  'data-management': {
    text: 'For data-management tasks, use dataset_search and journal_policy/funder_policy; cite the actual repository, license, and accession, and never invent metadata.',
    action: 'dataset_search',
  },
  'general-research': {
    text: 'For research tasks, restate the deliverable and constraints first, check the current project state before editing, and verify any claim against its source before reporting it.',
    action: 'inspect-current-state',
  },
}

const SIGNAL_REMEDIES = [
  {
    prefix: 'finding:NUM',
    text: 'When a data-derived number or fact changes, run ah_sweep and ah_check before finishing; never retype a computed value.',
    action: 'ah_sweep',
  },
  {
    prefix: 'finding:BIB',
    text: 'Before citing, resolve the identifier and run integrity_check; run manuscript_citations before calling the reference list done.',
    action: 'manuscript_citations',
  },
  {
    prefix: 'finding:CITE',
    text: 'Before citing, resolve the identifier and run integrity_check; run manuscript_citations before calling the reference list done.',
    action: 'manuscript_citations',
  },
  {
    prefix: 'finding:STR',
    text: 'Keep every %% @unit line with its paragraph; run ah_units after moving or merging prose.',
    action: 'ah_units',
  },
  {
    prefix: 'finding:UNIT',
    text: 'Keep every %% @unit line with its paragraph; run ah_units after moving or merging prose.',
    action: 'ah_units',
  },
  {
    prefix: 'finding:TEX',
    text: 'If a LaTeX structure check fails, read the flagged file and line, fix the reference, label, or include, and re-run ah_check; do not delete the surrounding text to silence it.',
    action: 'ah_check',
  },
  {
    prefix: 'finding:COH',
    text: 'Read a flagged coherence clause against its cited source before relying on it; the T3 evidence check is advisory, so verify rather than assume.',
    action: 'ah_source_search',
  },
  {
    prefix: 'finding:STAT',
    text: 'Run stat_audit before reporting p-values or intervals, and report the test, N, effect size, and confidence interval.',
    action: 'stat_audit',
  },
  {
    prefix: 'finding:FIG',
    text: 'Run figure_audit before finalizing a figure; check DPI, duplicate panels, and caption/text consistency.',
    action: 'figure_audit',
  },
  {
    prefix: 'finding:REPO',
    text: 'Run repo_audit before claiming reproducibility; record the exact command and environment.',
    action: 'repo_audit',
  },
  {
    prefix: 'finding:',
    text: 'Run ah_check after the edit and address the specific finding before finishing.',
    action: 'ah_check',
  },
  {
    prefix: 'error:latex_compile',
    text: 'If latex_compile fails, read the first error and fix the source before rerunning; do not switch to raw pdflatex.',
    action: 'latex_compile',
  },
  {
    prefix: 'error:ah_build',
    text: 'If ah_build fails, read the first LaTeX error and fix the source before rebuilding; do not switch to raw pdflatex.',
    action: 'ah_build',
  },
  {
    prefix: 'error:citation',
    text: 'Validate the bibliography with citation validate before exporting or submitting.',
    action: 'citation',
  },
  {
    prefix: 'error:ah_fact',
    text: 'Before proposing or binding a fact, list existing facts and compute the value from the data; do not type the number.',
    action: 'ah_fact',
  },
  {
    prefix: 'error:ah_bind',
    text: 'Before binding a literal number, run ah_bind and use the fact id it returns; do not hand-edit the fact.',
    action: 'ah_bind',
  },
  {
    prefix: 'error:manuscript_citations',
    text: 'Run manuscript_citations on the manuscript and .bib before submission; fix missing and undefined keys.',
    action: 'manuscript_citations',
  },
  {
    prefix: 'error:integrity_check',
    text: 'If integrity_check cannot resolve a DOI, report unknown rather than clean; resolve the identifier with paper_resolve first.',
    action: 'paper_resolve',
  },
  {
    prefix: 'integrity:retracted',
    text: 'Never present a retracted paper as current evidence; report the retraction notice DOI to the user.',
    action: 'integrity_check',
  },
  {
    prefix: 'integrity:expression_of_concern',
    text: 'Surface expressions of concern with their notice DOI and do not present the paper as settled evidence.',
    action: 'integrity_check',
  },
  {
    prefix: 'integrity:corrected',
    text: 'When a correction exists, read the correction notice before relying on the paper and mention the correction to the user.',
    action: 'integrity_check',
  },
  {
    prefix: 'integrity:unknown',
    text: 'If a registry returns unknown, report unknown and which source failed; never treat unknown as clean.',
    action: 'integrity_check',
  },
  {
    prefix: 'citation_gap',
    text: 'Before finishing a manuscript section, run manuscript_citations and papermemory_cite_check; resolve missing keys rather than inventing them.',
    action: 'manuscript_citations',
  },
  {
    prefix: 'stat_flag',
    text: 'Before reporting a statistical result, run stat_audit and report the test, N, effect size, and confidence interval; do not label a boundary p-value as significant.',
    action: 'stat_audit',
  },
  {
    prefix: 'figure_flag',
    text: 'Before finalizing a figure, run figure_audit and check DPI, duplicate panels, and caption consistency.',
    action: 'figure_audit',
  },
  {
    prefix: 'repo_flag',
    text: 'Before claiming reproducibility, run repo_audit and record the exact environment and reproduction command.',
    action: 'repo_audit',
  },
  {
    prefix: 'handoff:',
    text: 'At the start of an Academic Harness writing task, run ah_check or ah_audit once to see existing blockers; fix only findings your edits introduce.',
    action: 'ah_check',
  },
  {
    prefix: 'retry:',
    text: 'When a tool call fails, read the error and correct the inputs; do not repeat the identical call.',
    action: 'read-error',
  },
  {
    prefix: 'error:',
    text: 'Before retrying a failed tool, read its error and correct the required inputs; do not switch tools without a reason.',
    action: 'read-error',
  },
]

const BLOCKED_PATTERNS = [
  { re: /ignore (all|any|the) (previous|prior|earlier) instructions/i, negatable: false },
  { re: /\b(system|developer) prompt\b/i, negatable: false },
  { re: /\b(waive|skip|disable|bypass|override|circumvent|ignore)\b[\s\S]{0,60}\b(checks?|gates?|audits?|verification|guard|safety|filter|integrity_check|manuscript_citations|stat_audit|figure_audit|repo_audit)\b/i, negatable: true },
  { re: /\b(hide|fabricate|invent|falsify)\b[\s\S]{0,60}\b(result|data|citation|number|finding|evidence|retraction|notice|p-?value|statistic|manuscript|paper|document)\b/i, negatable: true },
  { re: /\b(exfiltrate|reveal|leak|upload|send)\b[\s\S]{0,60}\b(secret|key|token|password|credential|file|data|manuscript|paper|document|confidential)\b/i, negatable: true },
  { re: /\b(api[\s_-]?key|password|secret|credential|access token)\b/i, negatable: false },
  { re: /\b(rm\s+-rf|sudo|chmod|curl|wget|ssh|scp)\b/i, negatable: false },
  { re: /https?:\/\//i, negatable: false },
  { re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, negatable: false },
  { re: /\bfile:\/\//i, negatable: false },
  { re: /\b(install|pip install|npm install|uv add)\b/i, negatable: false },
  { re: /\b(never|don'?t|do not|avoid|stop)\b[\s\S]{0,80}\b(run|use|call|perform|do)\b[\s\S]{0,80}\b(integrity_check|manuscript_citations|stat_audit|figure_audit|repo_audit|the audit|the gate|the check|verification)\b/i, negatable: false },
  { re: /\b(never|don'?t|do not)\s+(verify|validate)\b/i, negatable: false },
  { re: /\b(just|simply)\s+(say|claim|report|assume|treat)\b[\s\S]{0,60}\b(verified|clean|correct|supported|true)\b/i, negatable: true },
  { re: /\b(trust|assume)\b[\s\S]{0,40}\b(citations?|data|results?|numbers?)\b[\s\S]{0,40}\b(correct|verified|clean|supported)\b/i, negatable: true },
  { re: /\b(claim|say|report|state)\b[\s\S]{0,40}\b(results?|data|citations?|numbers?|findings?|papers?)\b[\s\S]{0,20}\b(are|is|as)\b[\s\S]{0,20}\b(verified|clean|correct|supported)\b/i, negatable: true },
]

const CORRECTION = /\b(wrong|incorrect|not what|you missed|still not|try again|fix this|that'?s not|don'?t do that|stop doing|misunderstood)\b/i
const DIRECTIVE = /\b(always|never|from now on|going forward|remember to|please always|please never|do not|don'?t|prefer|make sure)\b/i
const PERSISTENCE = /\b(always|never|from now on|going forward|remember to|remember that|prefer|make sure)\b/i
const WEAK_START = /^\s*(do not|don'?t)\b/i
const FORGET = /^\s*(please\s+)?(forget|stop doing|don'?t do that anymore|do not do that anymore|remove that (rule|lesson)|ignore that (rule|lesson))\b/i
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'before', 'by', 'do', 'for', 'from', 'if', 'in',
  'is', 'it', 'not', 'of', 'on', 'or', 'that', 'the', 'then', 'this', 'to', 'use', 'when',
  'with', 'you', 'your', 'always', 'never', 'avoid', 'prefer', 'make', 'sure',
])

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function classifyTask(text) {
  const value = String(text ?? '').toLowerCase()
  const scores = new Map()
  const tags = []
  for (const rule of TASK_RULES) {
    let score = 0
    for (const word of rule.words) {
      if (new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i').test(value)) {
        score += rule.weight
        if (tags.length < 12) tags.push(word)
      }
    }
    if (score > 0) scores.set(rule.id, score)
  }
  if (!scores.size) return { class: 'general-research', tags: [], scores: {} }
  const order = TASK_RULES.map((rule) => rule.id)
  const ranked = [...scores.entries()].sort((a, b) => (b[1] - a[1]) || (order.indexOf(a[0]) - order.indexOf(b[0])))
  return {
    class: ranked[0][0],
    tags: [...new Set(tags)].slice(0, 8),
    scores: Object.fromEntries(ranked),
  }
}

function messageText(message) {
  if (!message || typeof message !== 'object') return ''
  const raw = message.data && (message.data.role || message.data.content) ? message.data : message
  if (raw.source?.kind && raw.source.kind !== 'user') return ''
  if (raw.role && raw.role !== 'user') return ''
  if (raw.type && !['user', 'text', 'message'].includes(raw.type)) return ''
  const content = raw.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text' || typeof part === 'string')
      .map((part) => (typeof part === 'string' ? part : part.text || ''))
      .join('\n')
      .trim()
  }
  if (typeof raw.text === 'string') return raw.text
  return ''
}

export function extractLastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messageText(messages[index])
    if (text.trim()) return text.trim()
  }
  return ''
}

export function detectCorrection(text) {
  const match = String(text ?? '').match(CORRECTION)
  return match ? { corrected: true, marker: match[1] || match[0] } : { corrected: false, marker: null }
}

export function detectForget(text) {
  return FORGET.test(String(text ?? ''))
}

export function extractPreference(text) {
  const raw = String(text ?? '').trim()
  if (!raw || raw.length > 500 || raw.includes('```') || (raw.match(/\n/g) || []).length > 3) return null
  const value = raw.replace(/\s+/g, ' ').trim()
  const sentences = value.split(/(?<=[.!?])\s+/).filter(Boolean)
  for (const sentence of sentences) {
    if (sentence.length < 12 || sentence.length > 300) continue
    if (sentence.trim().endsWith('?')) continue
    if (/\b(following|below|attached)\b/i.test(sentence)) continue
    if (!DIRECTIVE.test(sentence)) continue
    if (!PERSISTENCE.test(sentence) && !WEAK_START.test(sentence)) continue
    return { text: sanitizeLessonText(sentence), taskClass: classifyTask(value).class }
  }
  return null
}

export function sanitizeLessonText(text) {
  return String(text ?? '')
    .replace(/^[\s"'`“”‘’]+|[\s"'`“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
}

export function lintLesson(text) {
  const value = sanitizeLessonText(text)
  if (value.length < 20) return { ok: false, reason: 'lesson is shorter than 20 characters' }
  if (value.length > 400) return { ok: false, reason: 'lesson is longer than 400 characters' }
  if ((value.match(/\n/g) || []).length > 1) return { ok: false, reason: 'lesson has too many lines' }
  for (const entry of BLOCKED_PATTERNS) {
    const match = value.match(entry.re)
    if (!match) continue
    if (entry.negatable) {
      const prefix = value.slice(Math.max(0, match.index - 30), match.index).toLowerCase()
      if (/\b(never|don'?t|do not|avoid|no)\s*$/.test(prefix)) continue
    }
    return { ok: false, reason: `lesson matches a blocked pattern: ${entry.re}` }
  }
  return { ok: true, reason: null, text: value }
}

export function lintPreference(text) {
  const base = lintLesson(text)
  if (!base.ok) return base
  if (!PERSISTENCE.test(base.text) && !WEAK_START.test(base.text)) {
    return { ok: false, reason: 'a preference needs a durable cue (always, never, from now on, remember, prefer, make sure, or an imperative do not/don\'t)' }
  }
  return base
}

export function lessonTextsSimilar(a, b) {
  const left = new Set(normalizeLessonText(a).split(' ').filter((word) => word.length > 2 && !STOPWORDS.has(word)))
  const right = new Set(normalizeLessonText(b).split(' ').filter((word) => word.length > 2 && !STOPWORDS.has(word)))
  if (!left.size || !right.size) return 0
  let overlap = 0
  for (const word of left) if (right.has(word)) overlap += 1
  return overlap / Math.max(left.size, right.size)
}

function hasNegation(text) {
  return /\b(never|avoid|don'?t|do not|not|no)\b/i.test(String(text ?? ''))
}

export function findContradiction(lessons, candidate) {
  const candidateStatus = candidate.status || 'active'
  if (!['active', 'trial', 'candidate'].includes(candidateStatus)) return null
  for (const lesson of lessons) {
    if (!['active', 'trial', 'candidate'].includes(lesson.status)) continue
    if (lesson.task_class !== candidate.task_class && lesson.task_class !== 'any') continue
    if (lessonTextsSimilar(lesson.text, candidate.text) < 0.45) continue
    if (hasNegation(lesson.text) !== hasNegation(candidate.text)) return lesson
  }
  return null
}

export function remedyFor(kind, key, taskClass) {
  if (kind === 'task_failure' || kind === 'correction') {
    const workflow = TASK_WORKFLOW[taskClass] || TASK_WORKFLOW['general-research']
    return { text: workflow.text, action: workflow.action, taskClass }
  }
  const signal = `${kind}:${key}`
  const remedy = SIGNAL_REMEDIES.find((entry) => signal.startsWith(entry.prefix))
  if (!remedy) return null
  return { text: remedy.text, action: remedy.action, taskClass: TASK_WORKFLOW[taskClass] ? taskClass : 'general-research' }
}

export function resultText(result) {
  if (result == null) return ''
  if (typeof result === 'string') return result
  if (typeof result.text === 'string') return result.text
  if (Array.isArray(result.content)) {
    return result.content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('\n')
  }
  if (Array.isArray(result.items)) {
    return result.items.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('\n')
  }
  if (result.output != null) return resultText(result.output)
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

function tryJson(text) {
  const value = String(text ?? '').trim()
  if (!value || (!value.startsWith('{') && !value.startsWith('['))) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function collectFindings(value, out, levels, depth = 0) {
  if (depth > 3 || value == null) return
  if (Array.isArray(value)) {
    for (const item of value) collectFindings(item, out, levels, depth + 1)
    return
  }
  if (typeof value !== 'object') return
  for (const key of ['findings', 'issues', 'errors']) {
    if (Array.isArray(value[key])) {
      for (const item of value[key]) {
        if (typeof item === 'string') continue
        const id = item?.check || item?.code || item?.id || item?.rule
        const level = item?.severity || item?.level || null
        if (typeof id === 'string' && /^[A-Z][A-Z0-9]{1,8}-\d{1,5}[A-Z]?$/.test(id)) {
          out.add(id)
          if (level) levels.set(id, String(level))
        } else if (level) {
          const issue = `ISSUE-${String(level).toUpperCase()}`
          out.add(issue)
          levels.set(issue, String(level))
        }
      }
    }
  }
  if (typeof value.check === 'string' && /^[A-Z][A-Z0-9]{1,8}-\d{1,5}[A-Z]?$/.test(value.check)) {
    out.add(value.check)
    if (value.level) levels.set(value.check, String(value.level))
  }
}

function normalizeErrorSignature(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/(?:[a-z]:[\\/]|\/)[^\s:'\"]+/gi, '<path>')
    .replace(/\b[\w.-]+\.(?:tex|bib|py|js|ts|json|csv|parquet|pdf|md|txt|zip)\b/gi, '<file>')
    .replace(/\b[0-9a-f]{8,}\b/g, '<id>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140)
}

export function summarizeToolResult(name, args, result) {
  const text = resultText(result)
  const parsed = tryJson(text)
  const findings = new Set()
  const levels = new Map()
  collectFindings(parsed, findings, levels)
  for (const match of text.matchAll(/\b[A-Z][A-Z0-9]{1,8}-\d{1,5}[A-Z]?\b/g)) findings.add(match[0])
  const blocking = [...levels.values()].filter((level) => /^(blocker|major|error|critical|high)$/i.test(level)).length

  const integrityTool = name === 'integrity_check' || String(name).includes('integrity')
  const verdictMatch = integrityTool ? text.match(/\b(retracted|expression_of_concern|corrected|clean|unknown|not_found|ambiguous)\b/i) : null
  const verdict = integrityTool
    ? (parsed?.verdict || parsed?.status || (verdictMatch ? verdictMatch[1].toLowerCase() : null))
    : null
  const isError = Boolean(result?.isError || result?.error || parsed?.error)
  const issueCount = findings.size
    + (Array.isArray(parsed?.issues) ? parsed.issues.length : 0)
    + (Array.isArray(parsed?.errors) ? parsed.errors.length : 0)

  return {
    name,
    is_error: isError,
    result_size: text.length,
    text_hash: sha1(text, 12),
    findings: [...findings].slice(0, 40),
    finding_count: findings.size,
    blocking_findings: blocking,
    issue_count: issueCount,
    verdict,
    gate_passed: typeof parsed?.gate?.passed === 'boolean' ? parsed.gate.passed : null,
    compile_ok: ['latex_compile', 'ah_build'].includes(name) ? !isError && parsed?.ok !== false : null,
    error_signature: isError ? normalizeErrorSignature(text || result?.error?.message || '') : null,
    args_hash: sha1(JSON.stringify(args ?? {}), 12),
  }
}

function deterministicUnit(seed) {
  const hex = sha1(seed, 8)
  return parseInt(hex, 16) / 0xffffffff
}

function dominant(map) {
  let best = null
  let count = -1
  for (const [key, value] of map) {
    if (value > count) {
      best = key
      count = value
    }
  }
  return best || 'general-research'
}

export function signalsFromTurn(turn) {
  const signals = new Set(turn.signals || [])
  if (turn.corrections > 0) signals.add(`correction:${turn.taskClass}`)
  if (turn.gate?.kind === 'handoff') signals.add(`handoff:${turn.taskClass}`)
  if (turn.gate?.kind === 'continue') signals.add('gate:continue')
  return [...signals].map((value) => {
    const split = value.indexOf(':')
    return split < 0
      ? { kind: value, key: '' }
      : { kind: value.slice(0, split), key: value.slice(split + 1) }
  })
}

export function computeTurnOutcome(turn, context) {
  const findingCount = Number.isFinite(Number(turn.latestFindingCount))
    ? Number(turn.latestFindingCount)
    : [...(turn.findings?.values() || [])].reduce((sum, value) => sum + value, 0)
  let quality = 1
  quality -= Math.min(0.35, (turn.errors || 0) * 0.08)
  quality -= Math.min(0.3, (turn.corrections || 0) * 0.15)
  quality -= Math.min(0.2, findingCount * 0.01)
  quality -= Math.min(0.4, (turn.blockingFindings || 0) * 0.1)
  if (turn.gate?.kind === 'continue') quality -= 0.25
  if (turn.integrityIssue) quality -= 0.2
  if (turn.citationIssue) quality -= 0.1
  if (turn.statIssue) quality -= 0.1
  if (turn.figureIssue) quality -= 0.05
  if (turn.repoIssue) quality -= 0.05
  if (turn.gate?.kind === 'handoff') quality -= 0.2
  if (turn.qualitySignals?.compiled === false) quality -= 0.1
  quality = Math.max(0, Math.min(1, quality))

  const substantive = Boolean(
    (turn.substantive || turn.corrections > 0 || turn.gate)
    && (turn.turns || 0) >= 1,
  )
  const success = Boolean(
    substantive
    && (turn.errors || 0) === 0
    && (turn.corrections || 0) === 0
    && turn.gate?.kind !== 'handoff'
    && turn.gate?.kind !== 'continue'
    && (turn.blockingFindings || 0) === 0
    && turn.qualitySignals?.gatePassed !== false
    && !turn.integrityIssue
    && !turn.citationIssue
    && !turn.statIssue
    && quality >= 0.7,
  )

  const signals = signalsFromTurn(turn)
  const hasSpecificSignal = signals.some((signal) => signal.kind !== 'task_failure')
  if (substantive && !success && !hasSpecificSignal) signals.push({ kind: 'task_failure', key: turn.taskClass })

  return {
    v: 1,
    ts: nowIso(),
    episode_id: `${sha1(context.sessionId, 8)}-${turn.index}-${Date.now().toString(36)}`,
    session_id: context.sessionId,
    agent_kind: context.agentKind,
    project: context.project,
    task_class: turn.taskClass,
    task_tags: turn.taskTags,
    model: context.model || null,
    plugin_version: pluginVersion(),
    started_at: turn.startedAt,
    ended_at: nowIso(),
    reason: context.reason || 'turn_stop',
    turns: turn.turns || 0,
    tool_counts: turn.toolCounts || {},
    errors: turn.errors || 0,
    corrections: turn.corrections || 0,
    finding_count: findingCount,
    blocking_findings: turn.blockingFindings || 0,
    findings: Object.fromEntries(turn.findings || []),
    gate: turn.gate || null,
    signals,
    quality: Number(quality.toFixed(3)),
    success,
    substantive,
    lesson_ids_injected: [...(turn.injectedLessonIds || [])],
    lesson_ids_control: [...(turn.controlLessonIds || [])],
    lesson_ids_eligible: [...(turn.eligibleLessonIds || [])],
    lesson_ids_reached: [...(turn.reachedLessonIds || [])],
    injected_tokens: Number(turn.injectedTokens) || 0,
    oracle: oracleManifest(),
    user_chars: turn.userChars || 0,
  }
}

export function diagnoseEpisodes({ episodes, lessons = [], config }) {
  const clusters = new Map()
  const byClass = new Map()
  for (const episode of episodes) {
    if (!episode.substantive) continue
    const cls = byClass.get(episode.task_class) || { total: 0, success: 0, failures: 0, sessions: new Set() }
    cls.total += 1
    if (episode.success) cls.success += 1
    else cls.failures += 1
    cls.sessions.add(episode.session_id)
    byClass.set(episode.task_class, cls)
    for (const signal of episode.signals || []) {
      const key = `${signal.kind}:${signal.key}`
      const cluster = clusters.get(key) || {
        kind: signal.kind,
        key: signal.key,
        total: 0,
        failures: 0,
        successes: 0,
        sessions: new Set(),
        taskClasses: new Map(),
        episodeIds: [],
      }
      cluster.total += 1
      if (episode.success) cluster.successes += 1
      else cluster.failures += 1
      cluster.sessions.add(episode.session_id)
      cluster.taskClasses.set(episode.task_class, (cluster.taskClasses.get(episode.task_class) || 0) + 1)
      if (cluster.episodeIds.length < 40) cluster.episodeIds.push(episode.episode_id)
      clusters.set(key, cluster)
    }
  }

  const candidates = []
  const seen = new Set()
  for (const cluster of clusters.values()) {
    if (cluster.failures < config.min_evidence) continue
    if (cluster.sessions.size < config.min_sessions) continue
    if (cluster.total < config.min_evidence) continue
    if (cluster.failures / cluster.total < 0.5) continue
    const taskClass = dominant(cluster.taskClasses)
    const remedy = remedyFor(cluster.kind, cluster.key, taskClass)
    if (!remedy) continue
    const lint = lintLesson(remedy.text)
    if (!lint.ok) continue
    const id = lessonId(remedy.taskClass || taskClass, lint.text)
    if (seen.has(id)) continue
    seen.add(id)
    const classStats = byClass.get(remedy.taskClass || taskClass) || { total: 0, success: 0 }
    candidates.push({
      id,
      text: lint.text,
      task_class: remedy.taskClass || taskClass,
      action: remedy.action,
      source: 'diagnosis',
      signal: `${cluster.kind}:${cluster.key}`,
      evidence: {
        support: cluster.failures,
        total: cluster.total,
        sessions: cluster.sessions.size,
        episode_ids: cluster.episodeIds,
        baseline_success: Number((cluster.successes / Math.max(1, cluster.total)).toFixed(3)),
        class_success: Number((classStats.success / Math.max(1, classStats.total)).toFixed(3)),
      },
    })
  }
  return candidates
}

function makeLesson(candidate, config, mode) {
  const status = mode === 'observe' ? 'candidate' : 'trial'
  return {
    v: 1,
    id: candidate.id,
    text: candidate.text,
    task_class: candidate.task_class,
    scope: 'user',
    source: candidate.source || 'diagnosis',
    action: candidate.action || null,
    target: 'lesson',
    risk_tier: 1,
    requires_release: false,
    status,
    inject_probability: status === 'trial' ? config.exploration : 0,
    evidence: candidate.evidence || { support: 0, total: 0, sessions: 0, episode_ids: [] },
    stats: {
      injected: 0,
      injected_success: 0,
      control: 0,
      control_success: 0,
      reached: 0,
      reached_success: 0,
      last_episode_at: null,
    },
    created_at: nowIso(),
    updated_at: nowIso(),
    last_validated_at: nowIso(),
    model: candidate.model || null,
    plugin_version: pluginVersion(),
    reason: candidate.reason || 'diagnosed from local outcomes',
  }
}

function retireLesson(lesson, reason) {
  return {
    ...lesson,
    status: 'retired',
    inject_probability: 0,
    retired_at: nowIso(),
    updated_at: nowIso(),
    retire_reason: reason,
  }
}

function enforceCaps(dir, lessons, config) {
  const live = lessons.filter((lesson) => ['active', 'trial', 'candidate'].includes(lesson.status))
  const cap = (list, limit, label) => {
    if (list.length <= limit) return
    const ranked = [...list].sort((a, b) => {
      const explicit = Number(a.source === 'explicit') - Number(b.source === 'explicit')
      if (explicit !== 0) return explicit
      const rateA = a.stats?.injected ? a.stats.injected_success / a.stats.injected : 0.5
      const rateB = b.stats?.injected ? b.stats.injected_success / b.stats.injected : 0.5
      if (rateA !== rateB) return rateA - rateB
      return String(a.created_at || '').localeCompare(String(b.created_at || ''))
    })
    for (const lesson of ranked.slice(0, ranked.length - limit)) {
      if (lesson.source === 'explicit') continue
      const next = retireLesson(lesson, `cap: ${label}`)
      appendLesson(dir, next, { reason: 'cap' })
      appendDecision(dir, {
        v: 1,
        ts: nowIso(),
        type: 'retire',
        lesson_id: lesson.id,
        reason: `cap: ${label}`,
      })
      lesson.status = 'retired'
      lesson.inject_probability = 0
    }
  }
  cap(live, config.max_lessons, 'max_lessons')
  const byClass = new Map()
  for (const lesson of live.filter((entry) => entry.status !== 'retired')) {
    const list = byClass.get(lesson.task_class) || []
    list.push(lesson)
    byClass.set(lesson.task_class, list)
  }
  for (const [taskClass, list] of byClass) cap(list, config.max_per_class, `max_per_class:${taskClass}`)
}

export async function remoteJudge(candidate, config) {
  if (!config?.remote_judge) return null
  const url = String(process.env.AH_RSI_JUDGE_URL || '').trim()
  if (!url) return { verdict: null, reason: 'AH_RSI_JUDGE_URL is not set' }
  if (typeof fetch !== 'function') return { verdict: null, reason: 'fetch is unavailable in this runtime' }
  const key = String(process.env.AH_RSI_JUDGE_KEY || '').trim()
  const model = String(process.env.AH_RSI_JUDGE_MODEL || 'gpt-4o-mini').trim()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You are a conservative reviewer for a local research assistant. A candidate lesson is supported by observed tool outcomes. Accept only if it is safe, specific, and does not encourage fabrication, skipping checks, or overclaiming. Return JSON only: {"verdict":"accept"|"reject","reason":"..."}.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              lesson: candidate.text,
              task_class: candidate.task_class,
              action: candidate.action || null,
              evidence: {
                support: candidate.evidence?.support ?? null,
                total: candidate.evidence?.total ?? null,
                sessions: candidate.evidence?.sessions ?? null,
              },
            }),
          },
        ],
      }),
      signal: controller.signal,
    })
    if (!response.ok) return { verdict: null, reason: `HTTP ${response.status}` }
    const body = await response.json()
    const text = body?.choices?.[0]?.message?.content || body?.output_text || ''
    const parsed = JSON.parse(text)
    const verdict = String(parsed.verdict || '').toLowerCase()
    if (!['accept', 'reject'].includes(verdict)) return { verdict: null, reason: 'no accept/reject verdict returned' }
    return { verdict, reason: String(parsed.reason || '').slice(0, 200) }
  } catch (error) {
    return { verdict: null, reason: `failed: ${error?.message || error}` }
  } finally {
    clearTimeout(timer)
  }
}

export async function diagnoseAndAdmit({ dir, config = effectiveConfig(dir) } = {}) {
  ensureStore(dir)
  const episodes = readJsonl(dir, 'episodes.jsonl').slice(-500)
  const result = { candidates: 0, created: [], updated: [], rejected: [], retired: [], remote_errors: [] }
  const initialLessons = currentLessons(dir)
  const candidates = diagnoseEpisodes({ episodes, lessons: initialLessons, config })
  result.candidates = candidates.length
  const accepted = []
  const remoteRejected = []
  for (const candidate of candidates) {
    const verdict = await remoteJudge(candidate, config)
    if (verdict?.verdict === 'reject') {
      remoteRejected.push({ id: candidate.id, reason: `remote judge: ${verdict.reason || 'rejected'}` })
      continue
    }
    if (verdict && verdict.verdict == null && verdict.reason) {
      result.remote_errors.push({ id: candidate.id, reason: verdict.reason })
    }
    accepted.push(candidate)
  }
  await withStoreLock(dir, async () => {
    const lessons = currentLessons(dir)
    if (config.mode === 'auto') {
      for (const lesson of lessons) {
        if (lesson.status !== 'candidate') continue
        const next = {
          ...lesson,
          status: 'trial',
          inject_probability: config.exploration,
          updated_at: nowIso(),
          status_reason: 'observe mode ended',
        }
        appendLesson(dir, next, { reason: 'observe-to-auto' })
        appendDecision(dir, {
          v: 1,
          ts: nowIso(),
          type: 'promote',
          lesson_id: lesson.id,
          reason: 'observe mode ended',
        })
        Object.assign(lesson, next)
        result.updated.push(lesson.id)
      }
    }
    for (const rejection of remoteRejected) {
      result.rejected.push(rejection)
      appendDecision(dir, { v: 1, ts: nowIso(), type: 'reject', lesson_id: rejection.id, reason: rejection.reason })
    }
    for (const candidate of accepted) {
      const lint = lintLesson(candidate.text)
      if (!lint.ok) {
        result.rejected.push({ id: candidate.id, reason: lint.reason })
        appendDecision(dir, { v: 1, ts: nowIso(), type: 'reject', lesson_id: candidate.id, reason: lint.reason })
        continue
      }
      const contradiction = findContradiction(lessons, candidate)
      if (contradiction) {
        if (candidate.source === 'explicit') {
          const retired = retireLesson(contradiction, `superseded by explicit preference ${candidate.id}`)
          appendLesson(dir, retired, { reason: 'superseded' })
          appendDecision(dir, {
            v: 1,
            ts: nowIso(),
            type: 'retire',
            lesson_id: contradiction.id,
            reason: `superseded by ${candidate.id}`,
          })
          result.retired.push(contradiction.id)
        } else {
          result.rejected.push({ id: candidate.id, reason: `contradicts ${contradiction.id}` })
          appendDecision(dir, {
            v: 1,
            ts: nowIso(),
            type: 'reject',
            lesson_id: candidate.id,
            reason: `contradicts ${contradiction.id}`,
          })
          continue
        }
      }
      const existing = lessons.find((lesson) => lesson.id === candidate.id)
      if (existing) {
        const next = {
          ...existing,
          evidence: {
            ...existing.evidence,
            ...candidate.evidence,
            support: Math.max(existing.evidence?.support || 0, candidate.evidence.support),
            total: Math.max(existing.evidence?.total || 0, candidate.evidence.total),
            sessions: Math.max(existing.evidence?.sessions || 0, candidate.evidence.sessions),
          },
          updated_at: nowIso(),
          last_validated_at: nowIso(),
        }
        appendLesson(dir, next, { reason: 'revalidated' })
        result.updated.push(next.id)
        continue
      }
      const lesson = makeLesson(candidate, config, config.mode)
      appendLesson(dir, lesson, { reason: 'diagnosed' })
      appendDecision(dir, {
        v: 1,
        ts: nowIso(),
        type: 'admit',
        lesson_id: lesson.id,
        reason: `diagnosed from ${candidate.evidence.support}/${candidate.evidence.total} failures`,
        evidence: candidate.evidence,
      })
      lessons.push(lesson)
      result.created.push(lesson)
    }
    enforceCaps(dir, lessons, config)
  })
  updateMeta(dir, {
    last_diagnosis_at: nowIso(),
    episodes_at_last_diagnosis: episodes.length,
  })
  return result
}

function lessonRate(stats, key) {
  const total = stats?.[key] || 0
  if (!total) return 0
  return (stats[`${key}_success`] || 0) / total
}

export function evaluateLessonStatus(lesson) {
  if (lesson.source === 'explicit' || lesson.status === 'candidate') return null
  const stats = lesson.stats || {}
  const injected = stats.injected || 0
  const control = stats.control || 0
  const p1 = lessonRate(stats, 'injected')
  const p0 = lessonRate(stats, 'control')
  const se = Math.sqrt((p1 * (1 - p1)) / Math.max(1, injected) + (p0 * (1 - p0)) / Math.max(1, control))
  const margin = Math.max(0.1, 1.5 * se)

  if (lesson.status === 'trial') {
    if (injected >= 5 && control >= 3) {
      if (p1 - p0 > margin) return { status: 'active', reason: `promoted: injected ${p1.toFixed(2)} vs control ${p0.toFixed(2)}` }
      if (p0 - p1 > margin) return { status: 'retired', reason: `retired: injected ${p1.toFixed(2)} vs control ${p0.toFixed(2)}` }
      if (injected >= 12 && control >= 6 && p1 <= p0) return { status: 'retired', reason: 'retired: no benefit after 12 trials' }
    }
    return null
  }
  if (lesson.status === 'active' && injected >= 8 && control >= 4 && p0 - p1 > margin) {
    return { status: 'quarantined', reason: `quarantined: injected ${p1.toFixed(2)} vs control ${p0.toFixed(2)}` }
  }
  return null
}

export async function updateLessonsForEpisode({ dir, episode, config = effectiveConfig(dir) } = {}) {
  if (!episode?.substantive || !['auto'].includes(config.mode)) return []
  const eligible = new Set([...(episode.lesson_ids_injected || []), ...(episode.lesson_ids_control || [])])
  if (!eligible.size) return []
  const changes = []
  await withStoreLock(dir, async () => {
    const lessons = currentLessons(dir)
    for (const lesson of lessons) {
      if (!eligible.has(lesson.id)) continue
      if (!['trial', 'active'].includes(lesson.status)) continue
      const injected = (episode.lesson_ids_injected || []).includes(lesson.id)
      const reached = (episode.lesson_ids_reached || []).includes(lesson.id)
      const stats = {
        ...(lesson.stats || {}),
        injected: lesson.stats?.injected || 0,
        injected_success: lesson.stats?.injected_success || 0,
        control: lesson.stats?.control || 0,
        control_success: lesson.stats?.control_success || 0,
        reached: lesson.stats?.reached || 0,
        reached_success: lesson.stats?.reached_success || 0,
        last_episode_at: nowIso(),
      }
      if (injected) {
        stats.injected += 1
        if (episode.success) stats.injected_success += 1
      } else {
        stats.control += 1
        if (episode.success) stats.control_success += 1
      }
      if (reached) {
        stats.reached += 1
        if (episode.success) stats.reached_success += 1
      }
      let next = {
        ...lesson,
        stats,
        updated_at: nowIso(),
        ...(injected && episode.success ? { last_validated_at: nowIso() } : {}),
      }
      const change = evaluateLessonStatus(next)
      if (change) {
        next = {
          ...next,
          status: change.status,
          inject_probability: change.status === 'active' ? 1 : 0,
          updated_at: nowIso(),
          status_reason: change.reason,
        }
        appendDecision(dir, {
          v: 1,
          ts: nowIso(),
          type: change.status === 'active' ? 'promote' : change.status === 'quarantined' ? 'quarantine' : 'retire',
          lesson_id: lesson.id,
          reason: change.reason,
          stats,
        })
        changes.push({ id: lesson.id, status: change.status, reason: change.reason })
      }
      appendLesson(dir, next, { reason: 'episode' })
    }
  })
  return changes
}

export async function maybeDiagnose({ dir, config = effectiveConfig(dir), force = false } = {}) {
  if (config.mode === 'off') return null
  const meta = readMeta(dir)
  const episodes = readJsonl(dir, 'episodes.jsonl')
  const since = episodes.length - (Number(meta.episodes_at_last_diagnosis) || 0)
  if (!force && since < config.diagnose_every) return null
  return diagnoseAndAdmit({ dir, config })
}

export async function recordExplicitPreference({ dir, text, taskClass, model = null } = {}) {
  const lint = lintPreference(text)
  if (!lint.ok) throw new Error(`preference rejected: ${lint.reason}`)
  const cls = taskClass || classifyTask(text).class
  const id = lessonId(cls, lint.text)
  const now = nowIso()
  let saved
  await withStoreLock(dir, async () => {
    const lessons = currentLessons(dir)
    const contradiction = findContradiction(lessons, { text: lint.text, task_class: cls })
    if (contradiction) {
      const retired = retireLesson(contradiction, `superseded by explicit preference ${id}`)
      appendLesson(dir, retired, { reason: 'superseded' })
      appendDecision(dir, {
        v: 1,
        ts: now,
        type: 'retire',
        lesson_id: contradiction.id,
        reason: `superseded by ${id}`,
      })
    }
    const existing = lessons.find((lesson) => lesson.id === id)
    saved = {
      ...(existing || {}),
      v: 1,
      id,
      text: lint.text,
      task_class: cls,
      scope: 'user',
      source: 'explicit',
      action: null,
      target: 'lesson',
      risk_tier: 1,
      requires_release: false,
      status: 'active',
      inject_probability: 1,
      evidence: {
        support: (existing?.evidence?.support || 0) + 1,
        total: (existing?.evidence?.total || 0) + 1,
        sessions: (existing?.evidence?.sessions || 0) + 1,
        episode_ids: existing?.evidence?.episode_ids || [],
        baseline_success: null,
      },
      stats: existing?.stats || {
        injected: 0,
        injected_success: 0,
        control: 0,
        control_success: 0,
        reached: 0,
        reached_success: 0,
        last_episode_at: null,
      },
      created_at: existing?.created_at || now,
      updated_at: now,
      last_validated_at: now,
      model,
      plugin_version: pluginVersion(),
      reason: 'explicit user preference',
    }
    appendLesson(dir, saved, { reason: 'explicit' })
    appendDecision(dir, {
      v: 1,
      ts: now,
      type: 'admit',
      lesson_id: id,
      reason: 'explicit user preference',
      evidence: saved.evidence,
    })
  })
  return saved
}

export async function retireSimilarLessons({ dir, text, id = null, config = effectiveConfig(dir) } = {}) {
  const retired = []
  await withStoreLock(dir, async () => {
    const lessons = currentLessons(dir)
    for (const lesson of lessons) {
      if (!['active', 'trial', 'candidate'].includes(lesson.status)) continue
      const matches = id ? lesson.id === id : lessonTextsSimilar(lesson.text, text) >= 0.45 || lesson.id === id
      if (!matches) continue
      const next = retireLesson(lesson, id ? 'explicit forget' : 'forget request')
      appendLesson(dir, next, { reason: 'forget' })
      appendDecision(dir, {
        v: 1,
        ts: nowIso(),
        type: 'retire',
        lesson_id: lesson.id,
        reason: id ? 'explicit forget' : 'forget request',
      })
      retired.push(lesson.id)
    }
  })
  return retired
}

function isFresh(lesson, config) {
  if (!lesson.last_validated_at) return true
  const ttlDays = Number(config.lesson_ttl_days) || 180
  const age = Date.now() - Date.parse(lesson.last_validated_at)
  return Number.isFinite(age) ? age < ttlDays * 86_400_000 : true
}

export function selectLessonsForTurn({
  lessons, taskClass, sessionId, turnHash, config = {},
}) {
  const eligible = []
  for (const lesson of lessons) {
    if (!['active', 'trial'].includes(lesson.status)) continue
    if (lesson.task_class !== 'any' && lesson.task_class !== taskClass) continue
    if (!isFresh(lesson, config)) continue
    eligible.push(lesson)
  }
  const sourceRank = (lesson) => (lesson.source === 'explicit' ? 0 : lesson.status === 'active' ? 1 : 2)
  const successRate = (lesson) => (lesson.stats?.injected ? lesson.stats.injected_success / lesson.stats.injected : 0.5)
  eligible.sort((a, b) => (
    sourceRank(a) - sourceRank(b)
    || successRate(b) - successRate(a)
    || String(b.updated_at || '').localeCompare(String(a.updated_at || ''))
    || String(a.id).localeCompare(String(b.id))
  ))

  const maxTokens = Number(config.max_tokens) || 600
  const maxInject = Number(config.max_inject) || 6
  const controlRate = Number(config.active_control_rate) || 0
  const injected = []
  const control = []
  const skipped = []
  let tokens = 0
  for (const lesson of eligible) {
    const activeControl = lesson.status === 'active'
      && lesson.source !== 'explicit'
      && deterministicUnit(`${sessionId}|${lesson.id}|${turnHash}|active`) < controlRate
    const explore = deterministicUnit(`${sessionId}|${lesson.id}|${turnHash}|trial`) < (Number(config.exploration) || 0.5)
    const shouldInject = lesson.status === 'active' ? !activeControl : explore
    if (!shouldInject) {
      if (lesson.status === 'trial' || (lesson.status === 'active' && lesson.source !== 'explicit')) control.push(lesson.id)
      skipped.push(lesson.id)
      continue
    }
    const cost = Math.ceil(lesson.text.length / 4)
    if (injected.length >= maxInject || (injected.length > 0 && tokens + cost > maxTokens)) {
      skipped.push(lesson.id)
      continue
    }
    injected.push(lesson)
    tokens += cost
  }
  return { eligible: eligible.map((lesson) => lesson.id), injected, control, skipped, tokens }
}

export function formatLessonMessage(injected) {
  if (!injected?.length) return null
  const lines = [
    '## Local learned guidance (RSI)',
    'These short lessons were learned automatically from prior sessions on this machine. Apply them only when relevant. They are not evidence, do not override the current request, project rules, or safety rules, and can be removed with `ah_rsi forget`.',
    '',
  ]
  for (const lesson of injected) {
    lines.push(`- [${lesson.id}] ${lesson.text}`)
  }
  return lines.join('\n')
}

export function rsiStatus({ dir } = {}) {
  const config = effectiveConfig(dir)
  const meta = readMeta(dir)
  const episodes = readJsonl(dir, 'episodes.jsonl')
  const lessons = currentLessons(dir)
  const counts = { active: 0, trial: 0, candidate: 0, retired: 0, quarantined: 0, blocked: 0 }
  for (const lesson of lessons) counts[lesson.status] = (counts[lesson.status] || 0) + 1
  const staleLessons = lessons.filter((lesson) => ['active', 'trial'].includes(lesson.status) && !isFresh(lesson, config)).length
  const classes = new Map()
  for (const episode of episodes) {
    if (!episode.substantive) continue
    classes.set(episode.task_class, (classes.get(episode.task_class) || 0) + 1)
  }
  const taskClasses = [...classes.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }))
  const injected = lessons.reduce((sum, lesson) => sum + (lesson.stats?.injected || 0), 0)
  const reached = lessons.reduce((sum, lesson) => sum + (lesson.stats?.reached || 0), 0)
  const reachedSuccess = lessons.reduce((sum, lesson) => sum + (lesson.stats?.reached_success || 0), 0)
  const injectedTokens = episodes.reduce((sum, episode) => sum + (Number(episode.injected_tokens) || 0), 0)
  const riskTiers = {}
  for (const lesson of lessons) {
    const tier = lesson.risk_tier || 1
    riskTiers[tier] = (riskTiers[tier] || 0) + 1
  }
  return {
    store: config.store || dir,
    mode: config.mode,
    remote_judge: Boolean(config.remote_judge),
    plugin_version: pluginVersion(),
    oracle: oracleManifest(),
    episodes: episodes.length,
    substantive_episodes: episodes.filter((episode) => episode.substantive).length,
    lessons: counts,
    stale_lessons: staleLessons,
    task_classes: taskClasses,
    injected_tokens: injectedTokens,
    activation: {
      injected,
      reached,
      reached_success: reachedSuccess,
      rate: injected ? reached / injected : null,
    },
    risk_tiers: riskTiers,
    last_diagnosis_at: meta.last_diagnosis_at || null,
    exploration: config.exploration,
  }
}

function topSignals(episodes, limit = 12) {
  const counts = new Map()
  for (const episode of episodes) {
    if (!episode.substantive) continue
    for (const signal of episode.signals || []) {
      const key = `${signal.kind}:${signal.key}`
      const row = counts.get(key) || { signal: key, count: 0, failures: 0, sessions: new Set() }
      row.count += 1
      if (!episode.success) row.failures += 1
      row.sessions.add(episode.session_id)
      counts.set(key, row)
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.failures - a.failures || b.count - a.count)
    .slice(0, limit)
    .map((row) => ({ signal: row.signal, count: row.count, failures: row.failures, sessions: row.sessions.size }))
}

export function rsiReport({ dir } = {}) {
  const status = rsiStatus({ dir })
  const episodes = readJsonl(dir, 'episodes.jsonl').slice(-200)
  const lessons = currentLessons(dir)
  const decisions = readJsonl(dir, 'decisions.jsonl').slice(-20)
  const signals = topSignals(episodes)
  const lines = [
    '# Local RSI report',
    '',
    `Store: ${status.store}`,
    `Mode: ${status.mode}${status.remote_judge ? ' (remote judge enabled)' : ' (local-only judge)'}`,
    `Episodes: ${status.episodes} (${status.substantive_episodes} substantive)`,
    `Lessons: ${status.lessons.active} active, ${status.lessons.trial} trial, ${status.lessons.candidate} candidate, ${status.lessons.retired} retired, ${status.lessons.quarantined} quarantined`,
    `Last diagnosis: ${status.last_diagnosis_at || 'never'}`,
    '',
    '## Recurring signals',
    '',
  ]
  if (signals.length) {
    lines.push('| Signal | Seen | Failures | Sessions |', '|---|---:|---:|---:|')
    for (const signal of signals) lines.push(`| ${signal.signal} | ${signal.count} | ${signal.failures} | ${signal.sessions} |`)
  } else lines.push('_No substantive episodes captured yet._')
  lines.push('', '## Lessons', '')
  if (lessons.length) {
    lines.push('| ID | Status | Class | Injected | Control | Reached | Lesson |', '|---|---|---|---:|---:|---:|---|')
    for (const lesson of lessons.slice(-30)) {
      lines.push(`| ${lesson.id} | ${lesson.status} | ${lesson.task_class} | ${lesson.stats?.injected || 0} | ${lesson.stats?.control || 0} | ${lesson.stats?.reached || 0} | ${String(lesson.text).replace(/\|/g, '\\|')} |`)
    }
  } else lines.push('_No lessons yet._')
  const activationRate = status.activation.rate == null ? 'n/a' : `${(status.activation.rate * 100).toFixed(1)}%`
  lines.push(
    '',
    '## Cost and activation',
    '',
    `Injected tokens: ${status.injected_tokens}`,
    `Reached: ${status.activation.reached}/${status.activation.injected} (${activationRate}); reached and successful: ${status.activation.reached_success}`,
    `Risk tiers: ${Object.entries(status.risk_tiers).map(([tier, count]) => `T${tier} ${count}`).join(', ') || 'none'}`,
    `Oracle: plugin ${status.oracle.plugin_version}, engine ${status.oracle.engine_version}, manifest ${status.oracle.manifest_hash}`,
    '',
    '## Recent decisions',
    '',
  )
  if (decisions.length) {
    for (const decision of decisions.reverse()) {
      lines.push(`- ${decision.ts} ${decision.type} ${decision.lesson_id || ''}: ${decision.reason || ''}`)
    }
  } else lines.push('_No decisions yet._')
  return lines.join('\n')
}

export function rsiLessons({ dir, status = 'all' } = {}) {
  const lessons = currentLessons(dir)
  return status === 'all' ? lessons : lessons.filter((lesson) => lesson.status === status)
}

export function rsiInjectPreview({ dir, taskClass = 'general-research', sessionId = 'preview', turnHash = 'preview' } = {}) {
  const config = effectiveConfig(dir)
  const selection = selectLessonsForTurn({
    lessons: currentLessons(dir),
    taskClass,
    sessionId,
    turnHash,
    config,
  })
  return {
    ...selection,
    message: formatLessonMessage(selection.injected),
  }
}

export function recentDecisions(dir, limit = 20) {
  return readJsonl(dir, 'decisions.jsonl').slice(-limit)
}

export function episodeSummary(dir) {
  const episodes = readJsonl(dir, 'episodes.jsonl')
  const byClass = new Map()
  for (const episode of episodes) {
    if (!episode.substantive) continue
    const row = byClass.get(episode.task_class) || { total: 0, success: 0, quality: 0 }
    row.total += 1
    if (episode.success) row.success += 1
    row.quality += Number(episode.quality) || 0
    byClass.set(episode.task_class, row)
  }
  return {
    episodes: episodes.length,
    substantive: episodes.filter((episode) => episode.substantive).length,
    by_class: [...byClass.entries()].map(([name, row]) => ({
      name,
      total: row.total,
      success: row.success,
      success_rate: Number((row.success / Math.max(1, row.total)).toFixed(3)),
      mean_quality: Number((row.quality / Math.max(1, row.total)).toFixed(3)),
    })).sort((a, b) => b.total - a.total),
    signals: topSignals(episodes),
  }
}

export function appendTurnEvent(dir, event) {
  appendJsonl(dir, 'events.jsonl', [{ v: 1, ts: nowIso(), ...event }])
}

