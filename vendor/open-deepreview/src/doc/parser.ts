import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import {
  classifyPdf,
  extractPagesMarkdown,
  extractTextWithPositions,
  type PagesExtractionResult,
  type PdfClassification,
  type PdfResult,
  processPdf,
} from "@firecrawl/pdf-inspector";
import type { PdfPageTextLayer, PdfTextItem } from "./target_algorithms.ts";
import { validatePdfBuffer } from "./target_algorithms.ts";

export interface PdfInspectorMetadata {
  pdfType: string;
  confidence: number;
  pageCount: number;
  processingTimeMs: number;
  isComplexLayout: boolean;
  pagesWithTables: number[];
  pagesWithColumns: number[];
  pagesNeedingOcr: number[];
  hasEncodingIssues: boolean;
  title?: string;
  author?: string;
}

export interface ParsedManuscriptPage {
  pageNumber: number; // 1-indexed
  text: string;       // Clean Markdown for LLM consumption (via @firecrawl/pdf-inspector)
  markdown: string;   // Explicit per-page Markdown
  lines: string[];
  needsOcr?: boolean;
  pdfTextLayer?: PdfPageTextLayer;
}

export interface ParsedManuscript {
  filename: string;
  format: "pdf" | "text" | "markdown" | "latex";
  fullText: string;       // Page-tagged clean Markdown for LLM consumption
  markdown: string;       // Complete clean Markdown representation of the paper
  lines: string[];
  pages: ParsedManuscriptPage[];
  rawBytes: Uint8Array;
  pdfInspector?: PdfInspectorMetadata;
}

/**
 * Exact reconstruction of `Zsa` and `$sa` (`module_ZZg41c.js` lines 1307-1308):
 * Splits UTF-8 text into lines after stripping BOM and normalizing CRLF/CR.
 */
export function splitTextToLines(text: string): string[] {
  const clean = (text.startsWith("\ufeff") ? text.slice(1) : text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (!clean) return [];
  const lines = clean.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Converts a PDF buffer into clean, position-aware Markdown and classification metadata
 * using Firecrawl's `@firecrawl/pdf-inspector` Rust engine (`processPdf`, `extractPagesMarkdown`,
 * and `classifyPdf`).
 */
export function inspectAndConvertPdfToMarkdown(bytes: Uint8Array): {
  result: PdfResult;
  perPage: PagesExtractionResult;
  classification: PdfClassification;
  markdown: string;
} {
  const validation = validatePdfBuffer(bytes);
  if (!validation.valid) {
    throw new Error(validation.error || "Invalid PDF document");
  }
  const buf = Buffer.from(bytes);
  const classification = classifyPdf(buf);
  const result = processPdf(buf);
  const perPage = extractPagesMarkdown(buf);
  const markdown =
    result.markdown?.trim() ||
    perPage.pages.map((p) => p.markdown.trim()).filter(Boolean).join("\n\n---\n\n");

  return {
    result,
    perPage,
    classification,
    markdown,
  };
}

/**
 * Parses a PDF buffer using Firecrawl's `@firecrawl/pdf-inspector` as the primary
 * PDF-to-Markdown and positioned-text engine (with `pdfjs-dist` page dimension refinement).
 * Every page is converted into clean, LLM-friendly Markdown (headings, lists, tables,
 * bold/italic, code blocks) while preserving exact PDF coordinates for `bta` quote-to-bbox anchoring.
 */
export async function parsePdfBuffer(
  bytes: Uint8Array,
  filename = "manuscript.pdf"
): Promise<ParsedManuscript> {
  const validation = validatePdfBuffer(bytes);
  if (!validation.valid) {
    throw new Error(validation.error || "Invalid PDF document");
  }

  const buf = Buffer.from(bytes);
  const { result, perPage, markdown: fullDocMarkdown } = inspectAndConvertPdfToMarkdown(bytes);
  const positionedItems = extractTextWithPositions(buf, undefined, { frame: "display" });

  // Group pdf-inspector positioned text items by 1-indexed page number
  const itemsByPage = new Map<number, PdfTextItem[]>();
  const maxPosByPage = new Map<number, { maxRight: number; maxTop: number }>();

  for (const item of positionedItems) {
    if (item.itemType !== "Text" || !item.text) continue;
    const p = item.page;
    const list = itemsByPage.get(p) ?? [];
    list.push({
      str: item.text,
      transform: [item.fontSize || 10, 0, 0, item.fontSize || 10, item.x, item.y],
      width: item.width,
    });
    itemsByPage.set(p, list);

    const bounds = maxPosByPage.get(p) ?? { maxRight: 612, maxTop: 792 };
    bounds.maxRight = Math.max(bounds.maxRight, item.x + item.width + 36);
    bounds.maxTop = Math.max(bounds.maxTop, item.y + item.height + 36);
    maxPosByPage.set(p, bounds);
  }

  // Optionally query exact page viewport dimensions from pdfjs-dist when available
  const pageDimensions = new Map<number, { width: number; height: number }>();
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0,
    });
    const pdfDoc = await loadingTask.promise;
    try {
      for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
        const page = await pdfDoc.getPage(pageNum);
        const vp = page.getViewport({ scale: 1 });
        pageDimensions.set(pageNum, { width: vp.width, height: vp.height });
      }
    } finally {
      await pdfDoc.destroy?.();
    }
  } catch {
    // Fallback to standard US Letter / inferred bounds if pdfjs fails on an edge-case PDF
  }

  const totalPages = Math.max(1, result.pageCount || perPage.pages.length);
  const pages: ParsedManuscriptPage[] = [];
  const allLines: string[] = [];

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const pageEntry = perPage.pages.find((p) => p.page + 1 === pageNum) ?? perPage.pages[pageNum - 1];
    const pageMd = (pageEntry?.markdown ?? "").trim();
    const pageLines = splitTextToLines(pageMd);
    allLines.push(`--- [Page ${pageNum}] ---`, ...pageLines);

    const dims = pageDimensions.get(pageNum) ?? {
      width: maxPosByPage.get(pageNum)?.maxRight ?? 612,
      height: maxPosByPage.get(pageNum)?.maxTop ?? 792,
    };

    pages.push({
      pageNumber: pageNum,
      text: pageMd,
      markdown: pageMd,
      lines: pageLines,
      needsOcr: pageEntry?.needsOcr ?? false,
      pdfTextLayer: {
        pageNumber: pageNum,
        width: dims.width,
        height: dims.height,
        items: itemsByPage.get(pageNum) ?? [],
      },
    });
  }

  const fullText = pages.map((p) => `[Page ${p.pageNumber}]\n${p.markdown}`).join("\n\n");

  return {
    filename,
    format: "pdf",
    fullText,
    markdown: fullDocMarkdown || fullText,
    lines: allLines,
    pages,
    rawBytes: bytes,
    pdfInspector: {
      pdfType: String(result.pdfType),
      confidence: result.confidence,
      pageCount: result.pageCount,
      processingTimeMs: result.processingTimeMs,
      isComplexLayout: result.isComplexLayout,
      pagesWithTables: result.pagesWithTables,
      pagesWithColumns: result.pagesWithColumns,
      pagesNeedingOcr: result.pagesNeedingOcr,
      hasEncodingIssues: result.hasEncodingIssues,
      title: result.title,
      author: result.author,
    },
  };
}

/**
 * Parses any supported manuscript file (`.pdf`, `.tex`, `.md`, `.markdown`, `.txt`).
 * When a `.pdf` is provided, it is automatically converted into clean Markdown via
 * Firecrawl's `@firecrawl/pdf-inspector` so that any LLM can read it accurately.
 */
export async function parseManuscriptFile(filePath: string): Promise<ParsedManuscript> {
  const bytes = new Uint8Array(readFileSync(filePath));
  const filename = basename(filePath);
  const ext = extname(filePath).toLowerCase();

  // Check if PDF by extension or magic header `%PDF-`
  const isPdfMagic =
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d;

  if (ext === ".pdf" || isPdfMagic) {
    return parsePdfBuffer(bytes, filename);
  }

  const text = new TextDecoder("utf-8").decode(bytes);
  const lines = splitTextToLines(text);
  const format: ParsedManuscript["format"] =
    ext === ".tex"
      ? "latex"
      : ext === ".md" || ext === ".markdown"
      ? "markdown"
      : "text";

  // Group plain-text / LaTeX into synthetic 55-line pages for segmentation while preserving 1-indexed line numbers
  const linesPerPage = 55;
  const pages: ParsedManuscriptPage[] = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    const slice = lines.slice(i, i + linesPerPage);
    const pageNum = Math.floor(i / linesPerPage) + 1;
    const pageText = slice.map((line, idx) => `[L${i + idx + 1}] ${line}`).join("\n");
    pages.push({
      pageNumber: pageNum,
      text: pageText,
      markdown: slice.join("\n"),
      lines: slice,
    });
  }

  if (pages.length === 0) {
    pages.push({ pageNumber: 1, text: "", markdown: "", lines: [] });
  }

  return {
    filename,
    format,
    fullText: lines.map((l, idx) => `[L${idx + 1}] ${l}`).join("\n"),
    markdown: text,
    lines,
    pages,
    rawBytes: bytes,
  };
}
