import type { ParsedManuscript } from "../doc/parser.ts";
import { computeQuoteBoundingBoxesOnPage } from "../doc/target_algorithms.ts";
import type { DocumentLocation } from "../types/schema.ts";

/** Whitespace/hyphen-insensitive normalisation with an index map back to the original string. */
function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i].normalize("NFKD").toLowerCase();
    for (const c of ch) {
      if (/[\s\u00ad\u2010\u2011\u2012\u2013\u2014\u2212\ufe00-\ufe0f\u0300-\u036f-]/.test(c)) continue;
      norm += c;
      map.push(i);
    }
  }
  return { norm, map };
}

function normQuote(q: string): string {
  return normalizeWithMap(q).norm;
}

/**
 * Locates a quote in a page's text and returns the exact original span plus
 * W3C TextQuoteSelector prefix/suffix context (the fixture uses ~40-60 chars).
 */
export function locateQuoteInText(
  pageText: string,
  quote: string
): { exact: string; prefix: string; suffix: string; start: number; end: number } | null {
  const q = normQuote(quote);
  if (!q) return null;
  const { norm, map } = normalizeWithMap(pageText);
  let idx = norm.indexOf(q);
  let len = q.length;
  if (idx === -1 && q.length >= 28) {
    const head = q.slice(0, 28);
    const tail = q.slice(-24);
    const h = norm.indexOf(head);
    if (h !== -1) {
      const t = norm.indexOf(tail, h);
      idx = h;
      len = t !== -1 && t - h < q.length + 60 ? t + tail.length - h : Math.min(q.length, norm.length - h);
    }
  }
  if (idx === -1) return null;
  const start = map[idx];
  const end = map[Math.min(map.length - 1, idx + len - 1)] + 1;
  return {
    exact: pageText.slice(start, end),
    prefix: pageText.slice(Math.max(0, start - 60), start),
    suffix: pageText.slice(end, end + 60),
    start,
    end,
  };
}

/**
 * Anchors a quote to a `DocumentLocation`:
 *  - PDF: page number + quoteSelector + normalized bounding boxes from the pdf.js text layer
 *  - Text/Markdown/LaTeX: 1-indexed firstLine/lastLine/firstColumn/lastColumn + quotedLinePreview
 */
export function anchorQuote(
  doc: ParsedManuscript,
  quote: string,
  hintPage?: number
): DocumentLocation | undefined {
  if (!quote?.trim()) return undefined;

  if (doc.format === "pdf") {
    const order = [...doc.pages].sort((a, b) => {
      if (!hintPage) return a.pageNumber - b.pageNumber;
      return Math.abs(a.pageNumber - hintPage) - Math.abs(b.pageNumber - hintPage);
    });
    for (const page of order) {
      const hit = locateQuoteInText(page.text, quote);
      if (!hit) continue;
      const layer = page.pdfTextLayer;
      const boxes = layer
        ? computeQuoteBoundingBoxesOnPage(hit.exact, layer.items, layer.width, layer.height).slice(0, 50)
        : [];
      return {
        pdf: {
          pageNumber: page.pageNumber,
          quoteSelector: { exact: hit.exact, prefix: hit.prefix, suffix: hit.suffix },
          boundingBoxes: boxes,
        },
      };
    }
    return hintPage ? { pdf: { pageNumber: hintPage, boundingBoxes: [] } } : undefined;
  }

  // Text-based: search the full joined text and convert to line/column
  const full = doc.lines.join("\n");
  const hit = locateQuoteInText(full, quote);
  if (!hit) return undefined;
  const before = full.slice(0, hit.start);
  const firstLine = before.split("\n").length;
  const firstColumn = hit.start - (before.lastIndexOf("\n") + 1) + 1;
  const spanText = full.slice(0, hit.end);
  const lastLine = spanText.split("\n").length;
  const lastColumn = hit.end - (spanText.lastIndexOf("\n") + 1);
  return {
    text: {
      firstLine,
      lastLine,
      firstColumn,
      lastColumn,
      quotedLinePreview: doc.lines.slice(firstLine - 1, lastLine).join("\n"),
    },
  };
}
