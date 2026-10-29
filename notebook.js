import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { notebookToMarkdown } from './notebook-export.js'
import { buildNotebookZip } from './notebook-zip.js'

const TYPES = ['hypothesis', 'method', 'observation', 'decision', 'note']
const STANCES = ['supports', 'refutes', 'neutral']
const CONFIDENCE = ['low', 'medium', 'high']

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function sanitize(id) {
  return id.replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * Resolve the notebook file's session key, walking `session.header.parentSession`
 * as far as the live in-process SessionStore (`ctx.get('sessions')` — the
 * documented optional-service pattern, never a hard dependency) lets us follow
 * it, so every session in one delegation tree (a subagent's own session is
 * distinct from its parent's) shares a single notebook file. Falls back to the
 * last resolvable hop, and to this session's own id when there is no parent —
 * unchanged behavior for a plain top-level session.
 */
export function sessionKey(exec) {
  let id = exec.agent?.session?.header?.id ?? exec.agent?.session?.id ?? exec.agent?.sessionId
  if (typeof id !== 'string' || id.length === 0) return 'default'
  const visited = new Set([id])
  let parent = exec.agent?.session?.header?.parentSession
  const sessions = exec.agent?.ctx?.get?.('sessions')
  while (typeof parent === 'string' && parent.length > 0 && !visited.has(parent)) {
    id = parent
    visited.add(parent)
    if (typeof sessions?.get !== 'function') break
    parent = sessions.get(parent)?.header?.parentSession
  }
  return sanitize(id)
}

export function notebookFile(exec) {
  return join(workspaceRoot(exec), '.dsh', 'notebook', `${sessionKey(exec)}.jsonl`)
}

function readEntries(file) {
  try {
    const raw = readFileSync(file, 'utf8')
    const out = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // skip a corrupt line; the rest of the log is still usable
      }
    }
    return out
  } catch (err) {
    if (err && err.code === 'ENOENT') return []
    throw err
  }
}

function render(value) {
  if (value && typeof value.path === 'string' && typeof value.entries === 'number') {
    const missingNote = value.missing_artifacts?.length ? `, ${value.missing_artifacts.length} artifact(s) missing` : ''
    const label = value.format === 'zip' ? 'lab notebook bundle' : 'lab notebook'
    return [{ type: 'text', text: `wrote ${label} to ${value.path} (${value.entries} entries${missingNote})` }]
  }
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Register the living lab-notebook tool. */
export function applyNotebook(ctx) {
  ctx.tools.register(defineTool({
    name: 'notebook',
    description: [
      'Log or read the living lab notebook for this session.',
      'Use action "log" (default) for a hypothesis, method, observation, decision, or note as you work — not as a dump at the end.',
      'Attach artifacts (workspace-relative paths) for figures, tables, and scripts.',
      'Every log returns an id. Thread later results with relatesTo and stance. Correct an earlier entry by logging a new one with supersedes.',
      'Use action "read" to recall ids and earlier findings.',
      'Use action "export" to render the session\'s entries to a readable Markdown lab record and write it into the workspace, or export_format "zip" to bundle that Markdown together with every artifact file the entries reference into one .zip.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ['log', 'read', 'export'],
        description: 'log appends an entry; read returns this session\'s entries; export renders them to a Markdown file (or a zip bundle, see export_format).',
      },
      export_path: {
        type: 'string',
        description: 'Workspace-relative output path for action=export (default lab-notebook.md, or lab-notebook.zip when export_format="zip").',
      },
      export_format: {
        type: 'string',
        enum: ['markdown', 'zip'],
        description: 'Only for action=export. "zip" bundles lab-notebook.md with every referenced artifact file under artifacts/. Default markdown.',
      },
      type: {
        type: 'string',
        enum: TYPES,
        description: 'Entry kind for action=log.',
      },
      title: { type: 'string', description: 'One-line headline (required for log).' },
      body: { type: 'string', description: 'Markdown detail.' },
      artifacts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Workspace-relative paths this entry produced or references.',
      },
      code: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Code or snippet text.' },
          lang: { type: 'string', description: 'Language for highlighting.' },
        },
        additionalProperties: false,
      },
      confidence: {
        type: 'string',
        enum: CONFIDENCE,
        description: 'Confidence, mainly for hypothesis/decision.',
      },
      tags: { type: 'array', items: { type: 'string' } },
      relatesTo: { type: 'string', description: 'Id of an earlier entry this one responds to.' },
      stance: {
        type: 'string',
        enum: STANCES,
        description: 'How this entry bears on relatesTo.',
      },
      supersedes: { type: 'string', description: 'Id of an earlier entry this one replaces.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      const action = args.action ?? 'log'
      const file = notebookFile(exec)
      if (action === 'read') {
        const entries = readEntries(file)
        return { file, count: entries.length, entries }
      }
      if (action === 'export') {
        const entries = readEntries(file)
        const format = args.export_format === 'zip' ? 'zip' : 'markdown'
        const root = workspaceRoot(exec)
        const defaultName = format === 'zip' ? 'lab-notebook.zip' : 'lab-notebook.md'
        const rel = typeof args.export_path === 'string' && args.export_path.trim()
          ? args.export_path.trim()
          : defaultName
        const out = isAbsolute(rel) ? rel : resolve(root, rel)
        mkdirSync(dirname(out), { recursive: true })
        if (format === 'zip') {
          const { buffer, missing } = buildNotebookZip(entries, { sessionId: sessionKey(exec), sandboxRoot: root })
          writeFileSync(out, buffer)
          return { path: rel, entries: entries.length, format: 'zip', missing_artifacts: missing }
        }
        const markdown = notebookToMarkdown(entries, { sessionId: sessionKey(exec) })
        writeFileSync(out, markdown, 'utf8')
        return { path: rel, entries: entries.length, format: 'markdown' }
      }

      const title = typeof args.title === 'string' ? args.title.trim() : ''
      if (!title) throw new Error('notebook log requires a non-empty title')
      const type = args.type ?? 'note'
      if (!TYPES.includes(type)) throw new Error(`invalid notebook type: ${type}`)
      if (args.stance && !args.relatesTo) {
        throw new Error('stance requires relatesTo')
      }

      const entry = {
        id: exec.callId,
        timestamp: Date.now(),
        type,
        title,
      }
      if (args.body) entry.body = args.body
      if (Array.isArray(args.artifacts) && args.artifacts.length) entry.artifacts = args.artifacts
      if (args.code && typeof args.code === 'object' && args.code.source) entry.code = args.code
      if (args.confidence) entry.confidence = args.confidence
      if (Array.isArray(args.tags) && args.tags.length) entry.tags = args.tags
      if (args.relatesTo) entry.relatesTo = args.relatesTo
      if (args.stance) entry.stance = args.stance
      if (args.supersedes) entry.supersedes = args.supersedes

      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
      return {
        id: entry.id,
        type: entry.type,
        title: entry.title,
        file,
        hint: 'reference this id in relatesTo/supersedes to link later entries',
      }
    },
  }))
}
