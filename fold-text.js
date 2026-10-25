/**
 * fold_text: fold long Markdown without a model call.
 *
 * The engine is shared with the browser panel (fold-core.js); this module only
 * validates arguments, contains workspace paths, and registers the tool.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { LEVELS, foldReply, foldStats, normalizeLevel, worthFolding } from './fold-core.js'

export const MAX_CHARS = 200_000
const FORMATS = ['markdown', 'json']
const LABEL = { full: 'Full', brief: 'Brief', points: 'Points', outline: 'Outline', gist: 'Gist' }

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

export function resolveWorkspacePath(cwd, path) {
  const root = resolve(cwd)
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes the workspace: ${path}`)
  return target
}

function original(text) {
  const full = foldReply(text, 'full')
  return { text, blocks: full.blocks }
}

/**
 * The tool body without registration. `cwd` is the session workspace; a
 * `write_to` path is resolved inside it.
 */
export function foldText(args, cwd = process.cwd()) {
  const text = typeof args?.text === 'string' ? args.text : ''
  if (!text.trim()) return { ok: false, error_code: 'empty', error: 'no text to fold' }
  if (text.length > MAX_CHARS) {
    return {
      ok: false,
      error_code: 'too-large',
      error: `text is ${text.length} characters; the limit is ${MAX_CHARS}. Fold it in parts.`,
    }
  }

  let requested
  try {
    requested = normalizeLevel(args?.level ?? 'brief')
  } catch {
    return { ok: false, error_code: 'bad-level', error: `level is one of ${LEVELS.join(', ')}` }
  }

  const format = String(args?.format ?? 'markdown').toLowerCase()
  if (!FORMATS.includes(format)) {
    return { ok: false, error_code: 'bad-format', error: `format is one of ${FORMATS.join(', ')}` }
  }

  const folded = foldReply(text, requested)
  if (!folded.text.trim()) {
    const keep = original(text)
    return {
      ok: true,
      requested_level: requested,
      level: folded.level,
      folded: false,
      reason: 'no-prose-to-fold',
      text: keep.text,
      blocks: keep.blocks,
      stats: foldStats(text, text),
    }
  }

  const short = !worthFolding(text, folded.text)
  const chosen = short ? { ...folded, text, blocks: original(text).blocks } : folded
  const stats = foldStats(text, chosen.text)
  const result = {
    ok: true,
    requested_level: requested,
    level: chosen.level,
    folded: !short,
    ...(short ? { reason: requested === 'full' ? 'full' : 'too-short-or-little-hidden' } : {}),
    stats,
  }

  if (args?.write_to) {
    let target
    try {
      target = resolveWorkspacePath(cwd, args.write_to)
      const realRoot = realpathSync(resolve(cwd))
      let existing = dirname(target)
      while (!existsSync(existing)) {
        const parent = dirname(existing)
        if (parent === existing) break
        existing = parent
      }
      const existingRel = relative(realRoot, realpathSync(existing))
      if (existingRel.startsWith('..') || isAbsolute(existingRel)) throw new Error(`path escapes the workspace: ${args.write_to}`)
      mkdirSync(dirname(target), { recursive: true })
      const realParent = realpathSync(dirname(target))
      const parentRel = relative(realRoot, realParent)
      if (parentRel.startsWith('..') || isAbsolute(parentRel)) throw new Error(`path escapes the workspace: ${args.write_to}`)
      if (existsSync(target)) {
        const targetRel = relative(realRoot, realpathSync(target))
        if (targetRel.startsWith('..') || isAbsolute(targetRel)) throw new Error(`path escapes the workspace: ${args.write_to}`)
      }
      writeFileSync(target, chosen.text, 'utf8')
    } catch (error) {
      const code = /escapes the workspace/.test(error.message) ? 'path-escapes-workspace' : 'write-failed'
      return { ok: false, error_code: code, error: code === 'write-failed' ? `could not write ${args.write_to}: ${error.message}` : error.message }
    }
    return { ...result, write_to: args.write_to }
  }

  return { ...result, text: chosen.text, blocks: chosen.blocks }
}

/** Register the Markdown folding tool. */
export function applyFoldText(ctx) {
  ctx.tools.register(defineTool({
    name: 'fold_text',
    description: [
      'Fold long Markdown to fewer words with no model call and no network. Levels: full (as written),',
      'brief (two sentences a paragraph), points (one sentence a paragraph/list item), outline (headings',
      'plus the first sentence under each, and an opening paragraph before the first heading), gist (the first sentence). It only deletes; it never rewrites.',
      'Short texts and folds that hide less than a quarter come back unchanged, and code/tables are kept',
      'at brief and points but dropped at outline and gist (outline falls back to points without headings).',
      'Use it for long reports, notes, or replies before handing the text to another tool.',
    ].join(' '),
    parameters: {
      text: { type: 'string', required: true, description: 'Markdown to fold.' },
      level: {
        type: 'string',
        enum: LEVELS,
        description: 'Fold level; default brief.',
      },
      format: {
        type: 'string',
        enum: FORMATS,
        description: 'markdown returns the folded text; json also returns stats and structured blocks.',
      },
      write_to: {
        type: 'string',
        description: 'Workspace-relative path for the folded Markdown instead of an inline return. format=json is inline-only.',
      },
    },
    output: {
      schema: { type: 'json' },
      render(args, value) {
        if (!value.ok) return [{ type: 'text', text: value.error ?? 'fold failed' }]
        const { words_before: before, words_after: after } = value.stats
        if (value.write_to) {
          return [{
            type: 'text',
            text: `folded to ${value.level}: ${value.write_to} (${after}/${before} words${value.folded ? '' : ', unchanged'})`,
          }]
        }
        if (String(args?.format ?? 'markdown').toLowerCase() === 'json') {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        }
        return [{ type: 'text', text: value.text }]
      },
    },
    execute: async (args, exec) => foldText(args, workspaceRoot(exec)),
    presentCall(args) {
      let level = 'Brief'
      try {
        level = LABEL[normalizeLevel(args?.level ?? 'brief')] ?? 'Brief'
      } catch {
        // The tool schema rejects unknown levels; a malformed call still gets a card.
      }
      return {
        card: 'generic',
        title: args?.write_to ? `Fold text → ${args.write_to}` : `Fold text → ${level}`,
        kind: 'other',
        locations: args?.write_to ? [{ path: args.write_to }] : undefined,
      }
    },
  }))
}
