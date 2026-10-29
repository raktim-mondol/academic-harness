/**
 * reference_library: the PaperMemory reference library as a native tool.
 *
 * Why native and not the PaperMemory MCP tool: an MCP server is one process with one fixed working
 * directory, but every session has its own workspace, and the host freezes tool arguments, so a hook
 * cannot add one. A native tool receives the session, so the workspace is known without the model
 * having to pass it, and file paths are confined to that workspace. The MCP copy
 * (`papermemory_library`) is hidden when PaperMemory runs inside this plugin (see papermemory.js).
 *
 * Each action runs `papermemory library ...` (the same code the MCP tool and the standalone CLI use).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { libraryCli } from './papermemory-library.js'
import { resolveWorkspacePath } from './workspace-path.js'

export const ACTIONS = ['list', 'get', 'resolve', 'import', 'export', 'tag', 'collection', 'note', 'keys', 'dedupe', 'merge', 'doctor', 'set_integrity']
const MAX_INLINE_CHARS = 60_000
const MAX_RENDER_CHARS = 20_000
const LONG_MS = 180_000

class UsageError extends Error {
  constructor(message, code = 'invalid-argument') {
    super(message)
    this.code = code
  }
}

const list = (value) => (Array.isArray(value) ? value.map(String).filter((v) => v.trim()) : [])
const words = (value) => String(value || '').split(/\s+/).filter(Boolean)

function need(args, ...names) {
  const missing = names.filter((name) => {
    const v = args[name]
    return v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)
  })
  if (missing.length) throw new UsageError(`${args.action}${args.op ? ` ${args.op}` : ''} needs: ${missing.join(', ')}`)
}

function oneOf(args, allowed) {
  if (!allowed.includes(args.op)) throw new UsageError(`${args.action} needs op: one of ${allowed.join(', ')}`)
  return args.op
}

function flag(argv, name, value) {
  if (value !== undefined && value !== null && value !== '' && value !== false) argv.push(name, ...(value === true ? [] : [String(value)]))
}

/**
 * Translate a tool call into `papermemory library` arguments for the session's workspace.
 * @returns {{ argv: string[], cleanup?: () => void, timeoutMs?: number }}
 */
export function buildCliArgs(args, cwd) {
  const action = args.action
  if (!ACTIONS.includes(action)) throw new UsageError(`action must be one of ${ACTIONS.join(', ')}`)
  const project = args.project
  const argv = []
  switch (action) {
    case 'list':
      argv.push('list', ...words(args.query))
      flag(argv, '--sort', args.sort)
      flag(argv, '--desc', args.desc)
      flag(argv, '--limit', args.limit)
      flag(argv, '--cursor', args.cursor)
      return { argv }
    case 'get':
      need(args, 'ref')
      argv.push('get', args.ref)
      flag(argv, '--project', project)
      return { argv }
    case 'resolve':
      need(args, 'refs')
      argv.push('resolve', ...list(args.refs))
      flag(argv, '--project', project)
      flag(argv, '--project-keys', args.project_keys)
      return { argv }
    case 'import': {
      let path = args.path
      let cleanup
      if (args.text) {
        const dir = mkdtempSync(join(tmpdir(), 'ah-library-import-'))
        path = join(dir, 'inline.txt')
        writeFileSync(path, String(args.text))
        cleanup = () => rmSync(dir, { recursive: true, force: true })
      } else {
        need(args, 'path')
        path = resolveWorkspacePath(cwd, args.path)
      }
      argv.push('import', path)
      flag(argv, '--format', args.format)
      flag(argv, '--project', project)
      argv.push('--cwd', cwd)
      flag(argv, '--dry-run', args.dry_run)
      return { argv, cleanup, timeoutMs: LONG_MS }
    }
    case 'export':
      argv.push('export', ...words(args.query))
      flag(argv, '--format', args.format)
      flag(argv, '--out', args.out)
      flag(argv, '--collection', args.collection)
      flag(argv, '--project', project)
      flag(argv, '--cited-only', args.cited_only)
      flag(argv, '--all', args.all)
      flag(argv, '--style', args.style)
      flag(argv, '--fields', args.fields)
      flag(argv, '--variant', args.variant)
      flag(argv, '--check', args.check)
      flag(argv, '--force', args.force)
      flag(argv, '--adopt', args.adopt)
      argv.push('--cwd', cwd)
      return { argv, timeoutMs: LONG_MS }
    case 'tag': {
      const op = oneOf(args, ['add', 'remove', 'list'])
      if (op === 'list') return { argv: ['tag', 'list', ...words(args.query)] }
      need(args, 'tags', 'refs')
      argv.push('tag', op, list(args.tags).join(','), ...list(args.refs))
      flag(argv, '--project', project)
      return { argv }
    }
    case 'collection': {
      const op = oneOf(args, ['create', 'list', 'show', 'add', 'remove', 'reorder', 'delete'])
      if (op === 'list') return { argv: ['collection', 'list'] }
      need(args, 'slug')
      argv.push('collection', op, args.slug)
      if (op === 'create') {
        flag(argv, '--title', args.title)
        flag(argv, '--parent', args.parent)
        flag(argv, '--project', project)
        flag(argv, '--bib-path', args.bib_path)
      } else if (op === 'show') {
        flag(argv, '--limit', args.limit)
        flag(argv, '--offset', args.offset)
      } else if (op !== 'delete') {
        need(args, 'refs')
        argv.push(...list(args.refs))
        flag(argv, '--project', project)
      }
      return { argv }
    }
    case 'note': {
      const op = oneOf(args, ['add', 'list', 'edit', 'remove'])
      if (op === 'add') {
        need(args, 'ref', 'text')
        argv.push('note', 'add', args.ref, String(args.text))
        flag(argv, '--project', project)
      } else if (op === 'list') {
        need(args, 'ref')
        argv.push('note', 'list', args.ref)
        flag(argv, '--project', project)
      } else if (op === 'edit') {
        need(args, 'note_id', 'text')
        argv.push('note', 'edit', args.note_id, String(args.text))
      } else {
        need(args, 'note_id')
        argv.push('note', 'remove', args.note_id)
      }
      return { argv }
    }
    case 'keys': {
      const op = oneOf(args, ['check', 'assign', 'freeze', 'rekey'])
      argv.push('keys', op)
      if (op === 'check' || op === 'assign') {
        flag(argv, '--template', args.template)
        return { argv }
      }
      need(args, 'ref')
      argv.push(args.ref)
      flag(argv, '--project', project)
      if (op === 'freeze') {
        need(args, 'label')
        argv.push('--label', args.label)
      } else {
        flag(argv, '--to', args.to)
        flag(argv, '--template', args.template)
        flag(argv, '--reason', args.reason)
        flag(argv, '--apply', args.apply)
      }
      return { argv }
    }
    case 'dedupe':
      argv.push('dedupe')
      flag(argv, '--limit', args.limit)
      return { argv }
    case 'merge':
      need(args, 'keep', 'drop')
      argv.push('merge', args.keep, args.drop)
      flag(argv, '--prefer', args.prefer)
      flag(argv, '--project', project)
      flag(argv, '--apply', args.apply)
      flag(argv, '--reason', args.reason)
      return { argv }
    case 'doctor':
      argv.push('doctor')
      flag(argv, '--template', args.template)
      argv.push('--cwd', cwd)
      return { argv, timeoutMs: LONG_MS }
    default: {
      need(args, 'items')
      const items = (Array.isArray(args.items) ? args.items : []).filter((item) => item && typeof item === 'object')
      return { argv: ['integrity', 'set', '--items-json', JSON.stringify(items)] }
    }
  }
}

function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

export async function runReferenceLibrary(args, exec, deps = {}) {
  const cwd = sessionCwd(exec)
  let built
  try {
    built = buildCliArgs(args, cwd)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), code: error?.code || 'invalid-argument' }
  }
  try {
    const result = await (deps.libraryCli || libraryCli)(built.argv, { cwd, signal: exec?.signal, timeoutMs: built.timeoutMs })
    if (!result.ok) return { error: result.error, code: result.code }
    if (typeof result.data?.text === 'string' && result.data.text.length > MAX_INLINE_CHARS) {
      return { error: `${result.data.text.length} characters; write it to a file with out`, code: 'too-large-for-inline' }
    }
    return result.data
  } finally {
    built.cleanup?.()
  }
}

function row(r) {
  const who = (r.authors || []).slice(0, 2).join(', ') + ((r.authors || []).length > 2 ? ' et al.' : '')
  const extras = [r.tags?.length ? `#${r.tags.join(',')}` : '', r.collections?.length ? `[${r.collections.join(',')}]` : '', r.notes ? `notes:${r.notes}` : '', r.integrity ? `integrity:${r.integrity}` : '']
    .filter(Boolean).join(' ')
  return `${r.key || '-'}  ${r.year || '?'}  ${r.title}${who ? ` (${who})` : ''}${extras ? ` ${extras}` : ''}`
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error${value.code ? ` (${value.code})` : ''}: ${value.error}` }]
  if (Array.isArray(value.rows)) {
    const lines = [`${value.total_count} paper(s)`, ...value.rows.map(row)]
    if (value.next_cursor) lines.push(`more: cursor ${value.next_cursor}`)
    return [{ type: 'text', text: lines.join('\n') }]
  }
  if (typeof value.text === 'string') {
    const head = `${value.format}: ${value.count} entr${value.count === 1 ? 'y' : 'ies'}${value.warnings?.length ? `\nwarnings: ${value.warnings.join('; ')}` : ''}`
    return [{ type: 'text', text: `${head}\n\n${value.text}` }]
  }
  const body = JSON.stringify(value, null, 2)
  return [{ type: 'text', text: body.length > MAX_RENDER_CHARS ? `${body.slice(0, MAX_RENDER_CHARS)}\n… (truncated)` : body }]
}

export const name = 'academic-harness-reference-library'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'reference_library',
    description: [
      'The reference manager (PaperMemory\'s library) for this workspace: `list`/`get`/`resolve` papers by key, DOI, or filters (`tag:ml year:2020..2024 has:pdf !tag:skip words`); `import` BibTeX, BibLaTeX, RIS (EndNote, Scopus, Web of Science, publishers), or CSL-JSON; `export` BibTeX/BibLaTeX/RIS/CSL-JSON/JSON/CSV, or keep a project .bib in sync; `tag`, `collection`, `note`; citation `keys`; `dedupe`, `merge`, `doctor`; `set_integrity`.',
      'Paths are relative to the session workspace and cannot leave it. Hard-to-undo changes are dry runs unless `apply` (with a `reason`), `force`, or `adopt` is set. Cite only keys the library returns; never invent one. A paper never integrity-checked is unknown, not clean.',
      'Use `export` with `cited_only: <manuscript>` and `out` to write a project bibliography, and run it with `check: true` first on an existing file.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ACTIONS, required: true },
      op: { type: 'string', description: 'tag: add|remove|list; collection: create|list|show|add|remove|reorder|delete; note: add|list|edit|remove; keys: check|assign|freeze|rekey' },
      query: { type: 'string', description: 'Filters, e.g. "tag:ml year:2020..2024 has:pdf !tag:skip graph" (list, export, tag list).' },
      ref: { type: 'string', description: 'A key, project alias, paper id, or DOI.' },
      refs: { type: 'array', items: { type: 'string' } },
      project: { type: 'string', description: 'Project key; that project\'s own citation keys then win.' },
      path: { type: 'string', description: 'import: workspace-relative file to read.' },
      text: { type: 'string', description: 'import: inline BibTeX/RIS/CSL-JSON text; note: the note text.' },
      format: { type: 'string', description: 'import: auto|bibtex|ris|csl-json; export: bibtex|biblatex|ris|csl-json|json|csv.' },
      dry_run: { type: 'boolean', description: 'import: report what would change, write nothing.' },
      out: { type: 'string', description: 'export: workspace-relative file; omit to get the text back.' },
      collection: { type: 'string' },
      cited_only: { type: 'string', description: 'export: only the papers this manuscript cites.' },
      all: { type: 'boolean', description: 'export: every paper.' },
      style: { type: 'string', description: 'export: normalized|original.' },
      fields: { type: 'string', description: 'export: standard|all.' },
      variant: { type: 'string', description: 'export: project|canonical.' },
      check: { type: 'boolean', description: 'export: report sync status, write nothing.' },
      force: { type: 'boolean', description: 'export: overwrite hand edits or an existing file (a backup is kept).' },
      adopt: { type: 'boolean', description: 'export: take over an existing .bib (a backup is kept).' },
      tags: { type: 'array', items: { type: 'string' } },
      slug: { type: 'string' },
      title: { type: 'string' },
      parent: { type: 'string' },
      bib_path: { type: 'string' },
      note_id: { type: 'string' },
      to: { type: 'string', description: 'keys rekey: the new key (default: from the template).' },
      template: { type: 'string' },
      label: { type: 'string' },
      reason: { type: 'string' },
      apply: { type: 'boolean', description: 'keys rekey / merge: really do it (needs a reason).' },
      keep: { type: 'string' },
      drop: { type: 'string' },
      prefer: { type: 'string', description: 'merge: keep|drop wins conflicting fields.' },
      project_keys: { type: 'boolean', description: 'resolve: also list the project\'s keys.' },
      items: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'set_integrity: [{ref, status, source, notice_doi}].' },
      sort: { type: 'string' },
      desc: { type: 'boolean' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      cursor: { type: 'string' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      return runReferenceLibrary(args, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `Library: ${args.action || ''}${args.op ? ` ${args.op}` : ''}`, kind: 'other' }
    },
  }))
}
