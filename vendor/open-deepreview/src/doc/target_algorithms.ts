import type {
  AnchoredReviewComment,
  DocumentResource,
  NormalizedBoundingBox,
  RawPatFixture,
  Review,
  Severity,
} from "../types/schema.ts";
import { NUMERIC_SEVERITY_MAP } from "../types/schema.ts";

/**
 * Regex patterns recovered from `module_ZZg41c.js` (`FN`, `Vsa`, `Wsa`, `JN`, `Xsa`, `Ysa`)
 * and `module_GuMH2c.js` (`HK`, `IK`, `JK`, `KK`, `qra`).
 */
export const SUGGESTED_ACTION_REGEX =
  /\n*\*\*(?:Suggested\s+(?:Action|Fix|Edit)|Recommendation):?\*\*\s*([\s\S]+)$/i;

export const SEVERITY_META = new Map<
  string,
  { label: string; cssClass: string; priority: number }
>([
  ["CRITICAL", { label: "Critical", cssClass: "severity-critical", priority: 4 }],
  ["MAJOR", { label: "Major", cssClass: "severity-major", priority: 3 }],
  ["MINOR", { label: "Minor", cssClass: "severity-minor", priority: 2 }],
  ["SUGGESTION", { label: "Suggestion", cssClass: "severity-suggestion", priority: 1 }],
]);

export const FILTER_CATEGORIES = [
  { key: "SECTION_SUMMARY", label: "Section Summary", cssClass: "filter-chip-section-summary" },
  { key: "CRITICAL", label: "Critical", cssClass: "severity-critical" },
  { key: "MAJOR", label: "Major", cssClass: "severity-major" },
  { key: "MINOR", label: "Minor", cssClass: "severity-minor" },
  { key: "SUGGESTION", label: "Suggestion", cssClass: "severity-suggestion" },
] as const;

export interface PdfTextItem {
  str: string;
  transform: number[]; // 6-element PDF matrix [a, b, c, d, x, y]
  width: number;
}

export interface PdfPageTextLayer {
  pageNumber: number;
  width: number;
  height: number;
  items: PdfTextItem[];
}

/**
 * Exact reconstruction of `jAa` (`module_ZZg41c.js` lines 1319-1323):
 * Normalizes a raw internal PAT fixture (`R$`) into a canonical `DocumentResource` and `Review`.
 */
export function normalizeRawPatFixture(raw: RawPatFixture): {
  document: DocumentResource;
  review: Review;
} {
  const toIso = (msStr: string | number): string => {
    const n = Number(msStr);
    return !Number.isNaN(n) && n > 0 ? new Date(n).toISOString() : new Date().toISOString();
  };

  const uploadTime = toIso(raw.upload_timestamp_ms);
  const startTime = toIso(raw.review_start_timestamp_ms);
  const endTime = toIso(raw.review_completion_timestamp_ms);

  const docName = `documents/${raw.paper_id || "paper-review-fixture"}`;
  const revName = `${docName}/reviews/fixture-review-1`;

  const document: DocumentResource = {
    name: docName,
    displayName: String(raw.filename ?? ""),
    createTime: uploadTime,
    latestReviewSummary: {
      review: revName,
      state: "SUCCEEDED",
      createTime: startTime,
    },
  };

  const anchoredComments: AnchoredReviewComment[] = (raw.anchored_comments ?? []).map(
    (item, idx) => {
      const pdfLoc = item.location?.pdf;
      const quoteSel = pdfLoc?.quote_selector;
      const bboxes = pdfLoc?.bounding_boxes ?? [];
      const textLoc = item.location?.text;

      const comment: AnchoredReviewComment = {
        commentId: String(item.comment_id || `comment-${idx + 1}`),
        severity: NUMERIC_SEVERITY_MAP[Number(item.severity)] || "SEVERITY_UNSPECIFIED",
        summary: String(item.summary || ""),
        bodyMarkdown: String(item.body_markdown || ""),
        suggestedEdit: String(item.suggested_edit || ""),
      };

      if (pdfLoc) {
        comment.location = {
          pdf: {
            pageNumber: Number(pdfLoc.page_number ?? 1),
            quoteSelector: quoteSel
              ? {
                  exact: String(quoteSel.exact || ""),
                  prefix: String(quoteSel.prefix || ""),
                  suffix: String(quoteSel.suffix || ""),
                }
              : undefined,
            boundingBoxes: bboxes.map((box) => ({
              left: Number(box.left ?? 0),
              top: Number(box.top ?? 0),
              right: Number(box.right ?? 0),
              bottom: Number(box.bottom ?? 0),
            })),
          },
        };
      } else if (textLoc) {
        comment.location = {
          text: {
            firstLine: Number(textLoc.first_line ?? 1),
            lastLine: textLoc.last_line ? Number(textLoc.last_line) : undefined,
            firstColumn: textLoc.first_column ? Number(textLoc.first_column) : undefined,
            lastColumn: textLoc.last_column ? Number(textLoc.last_column) : undefined,
            quotedLinePreview: textLoc.quoted_line_preview,
          },
        };
      }

      return comment;
    }
  );

  const topologyMap: Record<number, "LOW" | "MID" | "HIGH" | "EXTRA_HIGH"> = {
    1: "LOW",
    2: "MID",
    3: "HIGH",
    4: "EXTRA_HIGH",
  };

  const review: Review = {
    name: revName,
    state: "SUCCEEDED",
    createTime: startTime,
    startTime,
    endTime,
    result: {
      reviewMarkdown: String(raw.review_content || ""),
      anchoredComments,
    },
    runConfig: {
      model: raw.pat_run_config?.base_model_config?.vertex?.model_name || "gemini-3.1-pro-preview",
      topology: topologyMap[raw.pat_topology] || "LOW",
      patModules: raw.pat_run_config?.modules,
    },
  };

  return { document, review };
}

/**
 * Exact reconstruction of `yN` (`module_ZZg41c.js` line 1291)
 */
export function getCommentId(comment: AnchoredReviewComment): string {
  return comment.commentId ?? "";
}

/**
 * Exact reconstruction of `zN` (`module_ZZg41c.js` line 1291)
 */
export function getResolvedBoundingBoxes(
  comment: AnchoredReviewComment,
  recomputedMap?: Map<string, NormalizedBoundingBox[]>
): NormalizedBoundingBox[] {
  if (recomputedMap) {
    const boxes = recomputedMap.get(getCommentId(comment));
    if (boxes && boxes.length > 0) return boxes;
  }
  return comment.location?.pdf?.boundingBoxes ?? [];
}

/**
 * Exact reconstruction of `AN` (`module_ZZg41c.js` line 1291)
 */
export function getCommentPageNumber(comment: AnchoredReviewComment): number {
  const p = comment.location?.pdf?.pageNumber ?? 0;
  return p > 0 ? p : 1;
}

/**
 * Exact reconstruction of `BN` (`module_ZZg41c.js` line 1291):
 * Determines if an anchored comment is a Section Summary card.
 */
export function isSectionSummaryComment(
  comment: AnchoredReviewComment,
  recomputedMap?: Map<string, NormalizedBoundingBox[]>
): boolean {
  const id = getCommentId(comment);
  if (id.startsWith("section-") || id.startsWith("summary-")) return true;
  if (comment.severity && comment.severity !== "SEVERITY_UNSPECIFIED") return false;
  const pdf = comment.location?.pdf;
  if (!pdf) {
    const text = comment.location?.text;
    if (!text) return false;
    return !text.firstLine && !text.quotedLinePreview?.trim();
  }
  const hasBoxes =
    (recomputedMap && getResolvedBoundingBoxes(comment, recomputedMap).length > 0) ||
    (pdf.boundingBoxes?.length ?? 0) > 0;
  const hasExactQuote = Boolean(pdf.quoteSelector?.exact?.trim());
  return !hasBoxes && !hasExactQuote;
}

/**
 * Exact reconstruction of `EN` (`module_ZZg41c.js` line 1298):
 * Returns the category filter key for a comment.
 */
export function getCommentCategory(
  comment: AnchoredReviewComment,
  recomputedMap?: Map<string, NormalizedBoundingBox[]>
): string {
  if (isSectionSummaryComment(comment, recomputedMap)) return "SECTION_SUMMARY";
  const sev = (comment.severity ?? "").trim().toUpperCase();
  return sev === "CRITICAL" || sev === "MAJOR" || sev === "MINOR" || sev === "SUGGESTION"
    ? sev
    : "SECTION_SUMMARY";
}

/**
 * Exact reconstruction of `Ksa` (`module_ZZg41c.js` lines 1292-1297):
 * Sorts anchored comments by page number, text line/column, section summary status, and bounding box top/left.
 */
export function sortAnchoredComments(
  comments: AnchoredReviewComment[],
  recomputedMap?: Map<string, NormalizedBoundingBox[]>
): AnchoredReviewComment[] {
  return [...comments].sort((c, d) => {
    const pageDiff = getCommentPageNumber(c) - getCommentPageNumber(d);
    if (pageDiff !== 0) return pageDiff;

    const cIsSec = isSectionSummaryComment(c, recomputedMap);
    const dIsSec = isSectionSummaryComment(d, recomputedMap);

    const cLine = c.location?.text?.firstLine ?? 0;
    const dLine = d.location?.text?.firstLine ?? 0;
    if (cLine > 0 || dLine > 0) {
      const p = cLine > 0 ? cLine : cIsSec ? 0 : Number.MAX_SAFE_INTEGER;
      const v = dLine > 0 ? dLine : dIsSec ? 0 : Number.MAX_SAFE_INTEGER;
      if (p !== v) return p - v;
      if (cIsSec !== dIsSec) return cIsSec ? -1 : 1;
      return (c.location?.text?.firstColumn ?? 0) - (d.location?.text?.firstColumn ?? 0);
    }

    if (cIsSec !== dIsSec) return cIsSec ? -1 : 1;

    const cBoxes = getResolvedBoundingBoxes(c, recomputedMap);
    const dBoxes = getResolvedBoundingBoxes(d, recomputedMap);
    const cTop = cBoxes[0]?.top ?? 1;
    const dTop = dBoxes[0]?.top ?? 1;
    if (Math.abs(cTop - dTop) > 1e-4) return cTop - dTop;
    return (cBoxes[0]?.left ?? 0) - (dBoxes[0]?.left ?? 0);
  });
}

/**
 * Exact reconstruction of `Osa` (`module_ZZg41c.js` lines 1299-1300):
 * Computes filter chip counts across active anchored comments.
 */
export function computeCategoryFilterChips(
  comments: AnchoredReviewComment[],
  recomputedMap?: Map<string, NormalizedBoundingBox[]>,
  selectedCategory = "ALL"
): Array<{ key: string; label: string; count: number; cssClass: string }> {
  if (comments.length === 0) return [];
  const counts = new Map<string, number>();
  for (const comment of comments) {
    const cat = getCommentCategory(comment, recomputedMap);
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  const chips: Array<{ key: string; label: string; count: number; cssClass: string }> = [
    { key: "ALL", label: "All Types", count: comments.length, cssClass: "filter-chip-all" },
  ];
  for (const item of FILTER_CATEGORIES) {
    const count = counts.get(item.key) ?? 0;
    if (count > 0 || item.key === selectedCategory) {
      chips.push({ key: item.key, label: item.label, count, cssClass: item.cssClass });
    }
  }
  return chips;
}

/**
 * Exact reconstruction of `Psa` (`module_ZZg41c.js` lines 1300-1301):
 * Formats the location badge label ("Page X" or "Line Y" / "Lines Y–Z").
 */
export function formatCommentLocationBadge(comment: AnchoredReviewComment): string {
  const pageNumber = comment.location?.pdf?.pageNumber ?? 0;
  if (pageNumber > 0) return `Page ${pageNumber}`;
  const textLoc = comment.location?.text;
  const firstLine = textLoc?.firstLine ?? 0;
  if (firstLine > 0) {
    const lastLine = textLoc?.lastLine ?? 0;
    return lastLine > firstLine ? `Lines ${firstLine}\u2013${lastLine}` : `Line ${firstLine}`;
  }
  return "";
}

/**
 * Exact reconstruction of `Qsa`, `Rsa`, `Ssa`, `Tsa` (`module_ZZg41c.js` lines 1301-1303)
 */
export function getCommentQuotedText(comment: AnchoredReviewComment): string {
  return (
    comment.location?.pdf?.quoteSelector?.exact ||
    comment.location?.text?.quotedLinePreview ||
    ""
  );
}

export function getCommentTitle(comment: AnchoredReviewComment): string {
  return comment.summary || "Review Comment";
}

export function getCommentCleanBody(comment: AnchoredReviewComment): string {
  return (comment.bodyMarkdown ?? "").trim().replace(SUGGESTED_ACTION_REGEX, "").trim();
}

export function getCommentSuggestedAction(comment: AnchoredReviewComment): string {
  const edit = (comment.suggestedEdit ?? "").trim();
  if (edit) return edit.replace(/\s*\n\s*/g, " ");
  const match = (comment.bodyMarkdown ?? "").trim().match(SUGGESTED_ACTION_REGEX);
  return match ? match[1].trim().replace(/\s*\n\s*/g, " ") : "";
}

/**
 * Exact reconstruction of `Np` (`module_ZZg41c.js` line 1338):
 * Extracts the High Level Summary section from the full review Markdown.
 */
export function extractHighLevelSummaryMarkdown(reviewMarkdown: string): string {
  const trimmed = (reviewMarkdown ?? "").trim();
  if (!trimmed) return "";
  const splitIdx = trimmed.search(
    /^#{1,2}\s+(?:Potential Issues And Suggestions|DETAILED FEEDBACK)\b|^#\s+CITATION\b/im
  );
  const slice = splitIdx >= 0 ? trimmed.slice(0, splitIdx).trim() : trimmed;
  return slice.replace(/^#\s+HIGH LEVEL SUMMARY\s*\n+(?:---+\s*\n+)?/i, "").trim();
}

/**
 * Exact reconstruction of `bta` (`module_ZZg41c.js` lines 1309-1312) and `NN` (line 1314):
 * Normalizes a quote using NFKD + lowercase + hyphen/whitespace stripping, matches it against
 * a PDF page's text items (skipping margin line numbers `< 0.085 * pageWidth`), and computes
 * merged normalized bounding boxes `[0, 1]`.
 */
export function computeQuoteBoundingBoxesOnPage(
  quote: string,
  items: PdfTextItem[],
  pageWidth: number,
  pageHeight: number
): NormalizedBoundingBox[] {
  const normalizedQuote = quote
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u00ad\u2010\u2011\u2012\u2013\u2014\u2212\ufe00-\ufe0f-]/g, "")
    .replace(/\s+/g, "");
  if (!normalizedQuote || items.length === 0) return [];

  let stream = "";
  const charMap: Array<{ itemIdx: number; charOffset: number }> = [];

  for (let g = 0; g < items.length; g++) {
    const item = items[g];
    const str = item.str || "";
    const relX = item.transform && pageWidth > 0 ? item.transform[4] / pageWidth : 0.5;
    // Skip left-margin line numbers (< 8.5% of page width and purely digits)
    if (relX < 0.085 && /^\d+$/.test(str.trim())) continue;

    let offset = 0;
    for (const ch of str) {
      const normChars = ch.normalize("NFKD").toLowerCase();
      for (let n = 0; n < normChars.length; n++) {
        const c = normChars[n];
        if (!/[\s\u00ad\u2010\u2011\u2012\u2013\u2014\u2212\ufe00-\ufe0f-]/.test(c)) {
          stream += c;
          charMap.push({ itemIdx: g, charOffset: offset });
        }
      }
      offset += ch.length;
    }
  }

  let matchStart = stream.indexOf(normalizedQuote);
  let matchLen = normalizedQuote.length;

  // Fallback prefix/suffix anchor matching for quotes >= 28 normalized chars
  if (matchStart === -1 && normalizedQuote.length >= 28) {
    const head = normalizedQuote.slice(0, 28);
    const tail = normalizedQuote.slice(-24);
    const headIdx = stream.indexOf(head);
    if (headIdx !== -1) {
      const tailIdx = stream.indexOf(tail, headIdx);
      matchStart = headIdx;
      matchLen =
        tailIdx !== -1 && tailIdx - headIdx < normalizedQuote.length + 60
          ? tailIdx + tail.length - headIdx
          : Math.min(normalizedQuote.length, stream.length - headIdx);
    }
  }

  if (matchStart === -1) return [];

  const matchEnd = Math.min(charMap.length, matchStart + matchLen);
  const itemSpans = new Map<number, { minChar: number; maxChar: number }>();

  for (let i = matchStart; i < matchEnd; i++) {
    const { itemIdx, charOffset } = charMap[i];
    const existing = itemSpans.get(itemIdx);
    if (existing) {
      existing.minChar = Math.min(existing.minChar, charOffset);
      existing.maxChar = Math.max(existing.maxChar, charOffset);
    } else {
      itemSpans.set(itemIdx, { minChar: charOffset, maxChar: charOffset });
    }
  }

  const rawBoxes: NormalizedBoundingBox[] = [];
  itemSpans.forEach((span, itemIdx) => {
    const item = items[itemIdx];
    if (item && item.transform) {
      const len = Math.max(1, (item.str || "").length);
      const x = item.transform[4];
      const y = item.transform[5];
      const fontSize = Math.max(8, Math.hypot(item.transform[2], item.transform[3]));
      const width = item.width > 0 ? item.width : len * fontSize * 0.48;

      rawBoxes.push({
        left: Math.max(0, Math.min(1, (x + (span.minChar / len) * width) / pageWidth)),
        top: Math.max(0, Math.min(1, (pageHeight - y - fontSize * 0.86) / pageHeight)),
        right: Math.max(0, Math.min(1, (x + ((span.maxChar + 1) / len) * width) / pageWidth)),
        bottom: Math.max(0, Math.min(1, (pageHeight - y + fontSize * 0.22) / pageHeight)),
      });
    }
  });

  rawBoxes.sort((a, b) => a.top - b.top || a.left - b.left);

  // Merge boxes on the same visual line (`Math.abs(n.top - q.top) < 0.009`)
  const merged: NormalizedBoundingBox[] = [];
  for (const box of rawBoxes) {
    const sameLine = merged.find((q) => Math.abs(box.top - q.top) < 0.009);
    if (sameLine) {
      sameLine.left = Math.min(sameLine.left, box.left);
      sameLine.top = Math.min(sameLine.top, box.top);
      sameLine.right = Math.max(sameLine.right, box.right);
      sameLine.bottom = Math.max(sameLine.bottom, box.bottom);
    } else {
      merged.push({ ...box });
    }
  }

  return merged;
}

/**
 * Exact reconstruction of `ata` (`module_ZZg41c.js` line 1308):
 * Converts normalized [0, 1] bounding boxes to CSS percentage rectangles (`left%`, `top%`, `width%`, `height%`)
 * with minimum width `2%` and minimum height `1.4%`.
 */
export function getPageHighlightRects(
  pageNumber: number,
  comments: AnchoredReviewComment[],
  recomputedMap?: Map<string, NormalizedBoundingBox[]>
): Array<{
  comment: AnchoredReviewComment;
  boxIndex: number;
  leftPct: number;
  topPct: number;
  widthPct: number;
  heightPct: number;
}> {
  return comments.flatMap((comment) => {
    if (
      getCommentPageNumber(comment) !== pageNumber ||
      isSectionSummaryComment(comment, recomputedMap)
    ) {
      return [];
    }
    const boxes = getResolvedBoundingBoxes(comment, recomputedMap);
    return boxes.map((box, idx) => {
      const left = box.left ?? 0;
      const top = box.top ?? 0;
      const right = box.right ?? 0;
      const bottom = box.bottom ?? 0;
      const leftPct = Math.max(0, Math.min(100, left * 100));
      const topPct = Math.max(0, Math.min(100, top * 100));
      return {
        comment,
        boxIndex: idx,
        leftPct,
        topPct,
        widthPct: Math.max(2, Math.min(100 - leftPct, (right - left) * 100)),
        heightPct: Math.max(1.4, Math.min(100 - topPct, (bottom - top) * 100)),
      };
    });
  });
}

/**
 * Exact reconstruction of `NK` PDF validation (`module_GuMH2c.js` lines 618-620):
 * Checks magic header `%PDF-`, 20MB limit, and strips comments/strings/streams before testing `/Encrypt`.
 */
export function validatePdfBuffer(bytes: Uint8Array): { valid: boolean; error?: string } {
  if (bytes.byteLength > 20971520) {
    return {
      valid: false,
      error: "File exceeds the 20MB size limit. Please choose a smaller PDF.",
    };
  }
  const text = new TextDecoder("latin1").decode(bytes);
  if (!text.startsWith("%PDF-")) {
    return {
      valid: false,
      error: "This file appears to be corrupted or is not a valid PDF.",
    };
  }
  if (text.includes("/Encrypt")) {
    const tokenRe = /%|\bstream[ \t]*[\r\n]|\(/g;
    const newlineRe = /[\r\n]/g;
    const endstreamRe = /endstream\b/g;
    const parenRe = /\\[\s\S]?|[()]/g;
    const encryptRe = /\/Encrypt(?:\s+\d+\s+\d+\s+R\b|\s*<<)/;

    const strippedParts: string[] = [];
    let pos = 0;
    for (;;) {
      tokenRe.lastIndex = pos;
      const match = tokenRe.exec(text);
      if (!match) break;
      strippedParts.push(text.slice(pos, match.index), " ");
      const afterToken = match.index + match[0].length;
      if (match[0] === "%") {
        newlineRe.lastIndex = afterToken;
        const nl = newlineRe.exec(text);
        pos = nl ? nl.index : text.length;
      } else if (match[0] === "(") {
        let depth = 1;
        pos = text.length;
        parenRe.lastIndex = afterToken;
        let pm: RegExpExecArray | null;
        while ((pm = parenRe.exec(text)) !== null) {
          if (pm[0] === "(") depth++;
          else if (pm[0] === ")" && --depth === 0) {
            pos = pm.index + 1;
            break;
          }
        }
      } else if (text[match.index - 1] === "/") {
        pos = afterToken;
      } else {
        endstreamRe.lastIndex = afterToken;
        const es = endstreamRe.exec(text);
        pos = es ? es.index + es[0].length : text.length;
      }
    }
    strippedParts.push(text.slice(pos));
    if (encryptRe.test(strippedParts.join(""))) {
      return {
        valid: false,
        error: "This PDF is password-protected or encrypted. Please upload an unlocked PDF.",
      };
    }
  }
  return { valid: true };
}
