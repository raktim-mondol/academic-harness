/**
 * Native `zvec_index` tool on the ResearchCraft preset.
 *
 * Separate from zvec-grep.js because this row must inject `tools` (to
 * register a defineTool) and the MCP connector row must not — inject: ['tools']
 * on that standing fiber can stall apply() so the CLI never installs.
 *
 * No timeoutMs: indexing a large workspace can run for hours. Progress is
 * published to Settings and the session header; Cancel is always available.
 */
import { isAbsolute, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import {
  DEFAULT_EMBEDDING,
  ensureZgInstalled,
  shouldIndexRoot,
} from './zvec-grep-cli.js'
import {
  cancelIndex,
  ensureCancelWatch,
  indexStatus,
  resetStaleIndexState,
  startIndex,
} from './zvec-index-engine.js'

export const name = 'dsh-researchcraft-zvec-index'
export const inject = ['tools']

const ACTIONS = ['start', 'status', 'cancel']

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function resolveRoot(args, exec) {
  const raw = typeof args.root === 'string' && args.root.trim() ? args.root.trim() : workspaceRoot(exec)
  return isAbsolute(raw) ? resolve(raw) : resolve(workspaceRoot(exec), raw)
}

/** DSH rejects execute() results that are not lossless JSON (`undefined`, NaN, -0). */
function lossless(value) {
  const round = JSON.parse(JSON.stringify(value, (_key, v) => (v === undefined ? null : v)))
  return dropNulls(round)
}

function dropNulls(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(dropNulls)
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === null) continue
    out[key] = dropNulls(item)
  }
  return out
}

function render(value) {
  if (value.error && !value.status) {
    return [{ type: 'text', text: `Error: ${value.error}` }]
  }
  const lines = []
  if (value.action) lines.push(`action: ${value.action}`)
  if (value.status) lines.push(`status: ${value.status}`)
  if (value.ready != null) lines.push(`ready: ${value.ready}`)
  if (value.fresh != null) lines.push(`fresh: ${value.fresh}`)
  if (value.workspace_state) lines.push(`workspace_state: ${value.workspace_state}`)
  if (value.auto_index != null) lines.push(`auto_index: ${value.auto_index}`)
  if (value.root) lines.push(`root: ${value.root}`)
  if (value.embedding) lines.push(`embedding: ${value.embedding}`)
  if (value.percent != null) lines.push(`percent: ${value.percent}`)
  if (value.current != null && value.total != null) lines.push(`files: ${value.current}/${value.total}`)
  if (value.line) lines.push(value.line)
  if (value.error) lines.push(`error: ${value.error}`)
  if (value.skipped) lines.push('already indexed; skipped')
  if (value.hint) lines.push(value.hint)
  return [{ type: 'text', text: lines.join('\n') }]
}

export function apply(ctx) {
  ensureCancelWatch()
  resetStaleIndexState()

  ctx.tools.register(defineTool({
    name: 'zvec_index',
    description: [
      'Create or incrementally update the local zvec-grep (zg) index for this workspace so',
      'mcp__zvec_grep__zvec_grep_search can return semantic hits. Default Settings leave',
      'session-start indexing OFF. Call action=status first when you are about to use semantic',
      'search and are not sure an index exists. If ready is false and auto_index is false, you',
      'MUST ask with ask_user_question before action=start unless the user already asked to index',
      'or already said yes this turn. Never start silently. Never zg index / --drop / --rebuild',
      'via bash. action=start has no timeout; the user sees a progress bar with an estimated time',
      'and can cancel at any time. Home directory and / are refused. Paths can be excluded with',
      'exclude (zg -g globs with a leading "!"); PaperMemory runtime paths under the index root are',
      'excluded automatically. Exclusions apply only when a job starts: if a job for the same root',
      'is already running, action=start joins it with its original globs instead of restarting.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ACTIONS,
        required: true,
        description: 'start (run until done/cancelled), status (ready + auto_index + live progress), cancel (stop a running index).',
      },
      root: {
        type: 'string',
        description: 'Absolute workspace root to index. Defaults to this session working directory.',
      },
      exclude: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra zg exclude globs, e.g. ["!tmp/**", "!*.log"]. A leading "!" is added when missing. PaperMemory store/corpus/evidence paths under root are excluded automatically. Ignored when joining an already-running job for the same root.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      const action = String(args.action || '').trim()
      if (!ACTIONS.includes(action)) {
        return lossless({ error: `action must be one of ${ACTIONS.join(', ')}.` })
      }
      const root = resolveRoot(args, exec)
      if (!shouldIndexRoot(root)) {
        return lossless({ action, status: 'failed', root, error: 'Refusing to index home directory or /.' })
      }
      const launch = await ensureZgInstalled()
      if (!launch) {
        return lossless({ action, status: 'failed', root, error: 'zg CLI is not installed. Check Settings / ZVEC_GREP_CLI.' })
      }
      const embedding = (await resolveEnv('ZVEC_GREP_EMBEDDING')) || DEFAULT_EMBEDDING

      if (action === 'status') {
        const info = await indexStatus(root, launch)
        const state = info.workspace_state
        let hint = 'No index. If semantic search would help, ask_user_question before action=start unless the user already asked to index.'
        if (info.fresh || state === 'ready') {
          hint = 'Index is ready; call mcp__zvec_grep__zvec_grep_search.'
        } else if (state === 'stale') {
          hint = 'Index exists but is stale (files changed). Hits may omit new files. action=start incrementally updates it, or pass freshness="wait_for_fresh" on mcp__zvec_grep__zvec_grep_search. Do not --rebuild unless asked.'
        } else if (state === 'indexing' || info.status === 'running') {
          hint = 'Indexing is in progress. Wait, or action=start to join.'
        } else if (info.auto_index) {
          hint = 'Session-start indexing is on; if a job is not already running, call action=start and wait.'
        }
        return lossless({
          action,
          ...info,
          hint,
        })
      }

      if (action === 'cancel') {
        cancelIndex(root)
        return lossless({ action, status: 'cancelling', root, line: 'Cancel requested.' })
      }

      const result = await startIndex({
        root,
        launch,
        embedding,
        globs: Array.isArray(args.exclude) ? args.exclude : [],
        signal: exec.signal,
        wait: true,
        skipIfReady: false,
      })
      return lossless({ action, ...result })
    },
    presentCall() {
      return { card: 'generic', title: 'Workspace index', kind: 'other' }
    },
  }))
}
