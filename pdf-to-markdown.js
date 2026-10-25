import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ingestConvertedMarkdown } from './papermemory-cli.js'

const INLINE_PREVIEW_CHARS = 4_000

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function resolveWorkspacePath(cwd, path) {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

let pdfInspectorPromise

/** Lazily load the native pdf-inspector module; the platform binary ships as an optionalDependency. */
function loadPdfInspector() {
  if (!pdfInspectorPromise) pdfInspectorPromise = import('@firecrawl/pdf-inspector')
  return pdfInspectorPromise
}

/** Register the PDF-to-Markdown conversion tool. */
export function applyPdfToMarkdown(ctx) {
  ctx.tools.register(defineTool({
    name: 'pdf_to_markdown',
    description: [
      'Convert a PDF to Markdown using pdf-inspector (github.com/firecrawl/pdf-inspector): classifies the PDF',
      '(text-based/scanned/image-based/mixed) in milliseconds and extracts headings, lists, tables, and reading',
      'order without OCR for text-based PDFs — the common case for papers, preprints, and reports in a literature',
      'survey. Prefer this over reading a PDF as raw text or shelling out to another converter.',
      'Pass write_to to save the Markdown to a file instead of returning it inline — do this for anything but a',
      'short excerpt, since a literature survey converting many PDFs will otherwise flood the conversation with',
      'full-paper text. write_to also ingests the Markdown into PaperMemory, merging onto the paper_download',
      'record for the same PDF when one exists. Scanned/image-based pages come back without markdown unless ocr is set to true, which',
      'requires the PDFium and ONNX Runtime shared libraries to be installed locally (see docs/PAPERS.md);',
      'without them, pass ocr:true anyway to see which pages were flagged as needing OCR, then fall back to',
      'subagent_vision on rendered page images for those pages.',
    ].join(' '),
    parameters: {
      path: { type: 'string', required: true, description: 'Workspace-relative or absolute path of the PDF to convert.' },
      pages: {
        type: 'array',
        items: { type: 'number' },
        description: 'Optional 1-indexed page numbers to convert (default: all pages).',
      },
      write_to: {
        type: 'string',
        description: 'Workspace-relative output path for the Markdown, e.g. literature/smith-2024.md. Recommended instead of returning the full text inline.',
      },
      doi: { type: 'string', description: 'Optional DOI to attach the converted markdown to the same PaperMemory record.' },
      ocr: {
        type: 'boolean',
        description: 'Selectively OCR pages the native extraction flags as low-quality (mode=auto). Requires PDFium/ONNX Runtime installed locally. Default false.',
      },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        if (!value.success) return [{ type: 'text', text: value.error ?? 'PDF conversion failed' }]
        const bits = [`type: ${value.pdf_type}`, `pages: ${value.page_count}`]
        if (typeof value.confidence === 'number') bits.push(`confidence: ${value.confidence.toFixed(2)}`)
        if (value.pages_needing_ocr?.length) bits.push(`pages needing OCR: ${value.pages_needing_ocr.join(',')}`)
        const head = bits.join(', ')
        if (value.written_to) {
          let text = `${head}\nwritten to: ${value.written_to}`
          if (value.papermemory?.ok) {
            const key = value.papermemory.bibtex_key
            const status = value.papermemory.status || 'ingested'
            const citeState = value.papermemory.cite_state ? ` (${value.papermemory.cite_state})` : ''
            text += `\nPaperMemory: ${status}${citeState}${key ? ` as ${key}` : ''}${value.papermemory.doi ? ` doi ${value.papermemory.doi}` : ''}`
            const degraded = value.papermemory.degradation?.pages_needing_ocr_count
            if (degraded) text += `; ${degraded} page(s) flagged for OCR (claims capped)`
          } else if (value.papermemory?.error) {
            text += `\nPaperMemory ingest skipped: ${value.papermemory.error}`
          }
          return [{ type: 'text', text }]
        }
        const md = value.markdown ?? ''
        const preview = md.length > INLINE_PREVIEW_CHARS ? `${md.slice(0, INLINE_PREVIEW_CHARS)}\n… (truncated, ${md.length} chars total — pass write_to to get the full file)` : md
        return [{ type: 'text', text: `${head}\n\n${preview}` }]
      },
    },
    async execute(args, exec) {
      const cwd = workspaceRoot(exec)
      const target = resolveWorkspacePath(cwd, args.path)
      if (!existsSync(target)) return { success: false, error: `file not found: ${args.path}` }

      let inspector
      try {
        inspector = await loadPdfInspector()
      } catch (error) {
        return {
          success: false,
          error: `pdf-inspector native module not available (${error?.message ?? error}). Run "npm install" in the plugin so its platform-specific optionalDependency binary is installed (Linux x64/ARM64, macOS ARM64, Windows x64).`,
        }
      }

      const buffer = readFileSync(target)
      const pages = Array.isArray(args.pages) && args.pages.length > 0 ? args.pages : undefined

      let result
      try {
        result = args.ocr
          ? await inspector.processPdfWithOcr(buffer, { mode: 'Auto', pageNumbers: pages })
          : await inspector.processPdfAsync(buffer, pages)
      } catch (error) {
        return { success: false, error: `PDF conversion failed: ${error?.message ?? error}` }
      }

      const out = {
        success: true,
        pdf_type: result.pdfType,
        page_count: result.pageCount,
        confidence: typeof result.confidence === 'number' ? result.confidence : undefined,
        pages_needing_ocr: result.pagesNeedingOcr ?? result.pagesRecommendedForOcr ?? [],
        markdown: result.markdown ?? '',
      }

      if (args.write_to) {
        const outAbs = resolveWorkspacePath(cwd, args.write_to)
        mkdirSync(dirname(outAbs), { recursive: true })
        writeFileSync(outAbs, out.markdown, 'utf8')
        delete out.markdown
        out.written_to = args.write_to
        const subset = Array.isArray(args.pages) && args.pages.length > 0
        if (subset) {
          out.papermemory = { ok: false, error: 'page-subset conversion is not ingested (it would replace the full paper text with an excerpt)' }
        } else {
          try {
            const originChannel = (
              String(out.pdf_type || '').toLowerCase().includes('scanned')
              || (out.pages_needing_ocr || []).length > 0
            ) ? 'ocr-recovered' : 'converter'
            out.papermemory = await ingestConvertedMarkdown({
              path: outAbs,
              pdfPath: target,
              doi: args.doi,
              project: process.env.PAPERMEMORY_PROJECT?.trim(),
              cwd,
              signal: exec.signal,
              converter: {
                pdf_type: out.pdf_type,
                confidence: out.confidence,
                pages_needing_ocr: out.pages_needing_ocr,
              },
              originChannel,
            })
          } catch (error) {
            out.papermemory = { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        }
      }
      return out
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `PDF → Markdown: ${args.path ?? ''}`,
        kind: 'other',
        locations: args.path ? [{ path: args.path }] : undefined,
      }
    },
  }))
}
