import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

const MAX_SOURCE_CHARS = 200_000
const MAX_SVG_CHARS = 8_000_000
const FENCE = /^\s*(?:```|~~~)(?:mermaid)?\s*$/i

const DIAGRAM_TYPES = [
  'flowchart', 'sequence', 'class', 'state', 'er', 'pie', 'gantt', 'gitGraph', 'mindmap', 'timeline',
  'journey', 'xychart', 'quadrantChart', 'requirement', 'c4', 'sankey', 'block', 'packet', 'kanban',
  'architecture', 'radar', 'treemap', 'info', 'agentflow', 'usecase', 'railroad', 'treeView', 'venn',
  'cynefin', 'wardley', 'swimlane', 'ishikawa', 'eventmodeling',
]

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function resolveWorkspacePath(cwd, path) {
  const target = isAbsolute(path) ? path : resolve(cwd, path)
  if (!target.startsWith(resolve(cwd))) {
    throw new Error(`path escapes the workspace: ${path}`)
  }
  return target
}

/** Pele parses bare Mermaid; sources pasted from Markdown usually arrive fenced. */
function stripFence(source) {
  const lines = source.split('\n')
  if (FENCE.test(lines[0] ?? '')) lines.shift()
  if (FENCE.test(lines[lines.length - 1] ?? '')) lines.pop()
  return lines.join('\n')
}

function describeError(error) {
  return {
    ok: false,
    error_code: error.code ?? 'render-failed',
    error: error.message,
    line: Number.isFinite(error.line) && error.line > 0 ? error.line : undefined,
    column: Number.isFinite(error.column) && error.column > 0 ? error.column : undefined,
    snippet: typeof error.snippet === 'string' && error.snippet ? error.snippet : undefined,
  }
}

const FLATTEN_PASSES = 8
// Matches one innermost var() call (no nested parens in its arguments) so nested
// chains resolve from the inside out, one pass per level.
const INNERMOST_VAR = /var\(\s*(--[\w-]+)\s*(?:,\s*([^(),]*))?\)/g

/**
 * Replace Pele's `var(--pele-*, fallback)` colors with literal values.
 *
 * Browsers resolve those, and the fallbacks keep a standalone SVG light-themed,
 * but Inkscape, rsvg-convert, and CairoSVG do not resolve CSS variables at all
 * and rasterize the file to a blank image. Flattening loses the `--pele-*`
 * theming hook, so it is only done for files written to disk.
 */
export function flattenColors(svg) {
  const props = new Map()
  for (const match of svg.matchAll(/(--[\w-]+)\s*:\s*([^;}"]+)/g)) {
    if (!props.has(match[1])) props.set(match[1], match[2].trim())
  }
  let out = svg
  for (let pass = 0; pass < FLATTEN_PASSES && out.includes('var('); pass += 1) {
    const next = out.replace(INNERMOST_VAR, (_whole, name, fallback) => {
      const declared = props.get(name)
      if (declared != null && !declared.includes(name)) return declared
      return fallback != null ? fallback.trim() : ''
    })
    if (next === out) break
    out = next
  }
  return out
}

/** Register the Mermaid-to-SVG render tool (Pele). */
export function applyMermaidRender(ctx) {
  ctx.tools.register(defineTool({
    name: 'mermaid_render',
    description: [
      'Render Mermaid diagram source to SVG with Pele (https://github.com/obsidianmd/pele) — synchronous,',
      'in-process, no browser or headless Chrome. Supports every diagram type built into Mermaid 12.1.0:',
      DIAGRAM_TYPES.join(', ') + '.',
      'Writes the SVG to `path` when given, otherwise returns it inline for embedding. A parse failure returns',
      'the offending line/column and snippet, so fix the source and retry. Colors come from `--pele-*` CSS',
      'variables: a written file has them baked to literal fallbacks (light theme) so Inkscape/rsvg/CairoSVG can',
      'rasterize it — they do not resolve CSS variables and would produce a blank image — while inline SVG keeps',
      'the variables so a page can re-skin it. Node-side limits: icons named from an external set (`fa:bug`, `si:react`) render',
      'as empty boxes (built-in shapes like `cloud`/`database` are fine), and `$$…$$` math stays literal text — both need a',
      'browser-side resolver. For a publication-quality scientific figure use the',
      '`diagram-design` skill instead — this reproduces Mermaid layout as-is.',
    ].join(' '),
    parameters: {
      mermaid: { type: 'string', required: true, description: 'Mermaid source; a ```mermaid fenced block is accepted.' },
      path: { type: 'string', description: 'Workspace-relative or absolute .svg path to write. Omit for inline SVG.' },
      font_size: { type: 'number', description: 'Base font size in px; the layout scales with it.' },
      padding: { type: 'number', description: 'Padding around the diagram in px.' },
      max_width: { type: 'number', description: 'Cap the diagram width in px, re-laying-out to fit.' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        if (!value.ok) {
          // Pele's syntax message already quotes the offending line.
          const parts = [value.error ?? 'Mermaid render failed']
          if (value.line && !parts[0].includes(`line ${value.line}`)) {
            parts.push(`at line ${value.line}, column ${value.column}`)
          }
          if (value.snippet && !parts[0].includes(value.snippet)) parts.push(value.snippet)
          return [{ type: 'text', text: parts.join('\n') }]
        }
        const size = `${value.width}x${value.height}`
        if (value.path) return [{ type: 'text', text: `wrote SVG: ${value.path} (${size}, ${value.mermaid_type})` }]
        return [{ type: 'text', text: value.svg }]
      },
    },
    async execute(args, exec) {
      const source = stripFence(String(args.mermaid ?? ''))
      if (!source.trim()) return { ok: false, error_code: 'empty', error: 'no Mermaid source given' }

      let render
      try {
        ({ render } = await import('pele'))
      } catch {
        return { ok: false, error_code: 'pele-missing', error: 'Pele is not installed in this profile (dependency `pele`).' }
      }

      const options = { limit: MAX_SOURCE_CHARS, outputLimit: MAX_SVG_CHARS }
      if (Number.isFinite(args.font_size)) options.fontSize = args.font_size
      if (Number.isFinite(args.padding)) options.padding = args.padding
      if (Number.isFinite(args.max_width)) options.maxWidth = args.max_width

      let result
      try {
        result = render(source, options)
      } catch (error) {
        return describeError(error)
      }

      if (!args.path) {
        return {
          ok: true,
          svg: result.svg,
          width: result.width,
          height: result.height,
          diagram_type: result.type,
          mermaid_type: result.mermaidType,
        }
      }

      const target = resolveWorkspacePath(workspaceRoot(exec), args.path)
      try {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, flattenColors(result.svg), 'utf8')
      } catch (error) {
        return { ok: false, error_code: 'write-failed', error: `could not write ${args.path}: ${error.message}` }
      }

      return {
        ok: true,
        path: args.path,
        width: result.width,
        height: result.height,
        diagram_type: result.type,
        mermaid_type: result.mermaidType,
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `Render Mermaid ${args.path ? `→ ${args.path}` : 'to SVG'}`,
        kind: 'other',
        locations: args.path ? [{ path: args.path }] : undefined,
      }
    },
  }))
}
