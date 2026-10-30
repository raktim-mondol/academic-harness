import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeepReviewPipeline, estimateReviewCost } from "../agents/pipeline.ts";
import { resolveConfig } from "../config/store.ts";
import { parseManuscriptFile, parsePdfBuffer } from "../doc/parser.ts";
import {
  computeCategoryFilterChips,
  extractHighLevelSummaryMarkdown,
  formatCommentLocationBadge,
  getCommentCategory,
  getCommentCleanBody,
  getCommentPageNumber,
  getCommentQuotedText,
  getCommentSuggestedAction,
  getCommentTitle,
  getPageHighlightRects,
  isSectionSummaryComment,
  normalizeRawPatFixture,
  sortAnchoredComments,
} from "../doc/target_algorithms.ts";
import type {
  DocumentResource,
  Operation,
  RawPatFixture,
  Review,
  ThinkingLevel,
  Topology,
  UserQuota,
} from "../types/schema.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "..", "fixtures");

export interface StoredDocumentEntry {
  document: DocumentResource;
  rawBytes: Uint8Array;
  mimeType: string;
  reviews: Map<string, Review>;
}

/**
 * Local Deep Review REST API v1 + Interactive Split-Pane Review Viewer Server.
 * Implements the exact endpoints from `https://deepreview.googleapis.com/$discovery/rest?version=v1`
 * and serves an interactive web viewer matching `research.google/deepreview`.
 */
export class DeepReviewServer {
  private readonly docs = new Map<string, StoredDocumentEntry>();
  private readonly ops = new Map<string, Operation>();

  constructor() {
    this.seedEmbeddedFixture();
  }

  private seedEmbeddedFixture() {
    try {
      const jsonPath = join(FIXTURES_DIR, "google_deepreview_fixture.json");
      const pdfPath = join(FIXTURES_DIR, "newton_third_law_fixture.pdf");
      if (!existsSync(jsonPath) || !existsSync(pdfPath)) return;

      const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as RawPatFixture;
      const pdfBytes = new Uint8Array(readFileSync(pdfPath));
      const { document, review } = normalizeRawPatFixture(raw);
      const docId = document.name.replace(/^documents\//, "");
      const revId = review.name.split("/").pop() || "fixture-review-1";

      const reviews = new Map<string, Review>();
      reviews.set(revId, review);
      this.docs.set(docId, {
        document,
        rawBytes: pdfBytes,
        mimeType: "application/pdf",
        reviews,
      });
    } catch {
      // Ignore if fixture files are unavailable
    }
  }

  public addDocumentAndReview(
    docId: string,
    displayName: string,
    rawBytes: Uint8Array,
    mimeType: string,
    review: Review
  ): DocumentResource {
    const revId = review.name.split("/").pop() || "review-1";
    const document: DocumentResource = {
      name: `documents/${docId}`,
      displayName,
      createTime: review.createTime,
      latestReviewSummary: {
        review: review.name,
        state: review.state,
        createTime: review.createTime,
      },
    };
    const existing = this.docs.get(docId);
    const reviews = existing?.reviews ?? new Map<string, Review>();
    reviews.set(revId, review);
    this.docs.set(docId, {
      document,
      rawBytes,
      mimeType,
      reviews,
    });
    return document;
  }

  public async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    // CORS headers for API interoperability
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
      });

    // 1. GET /v1/userQuota
    if (method === "GET" && path === "/v1/userQuota") {
      const used = [...this.docs.values()].reduce((acc, d) => acc + d.reviews.size, 0);
      const quota: UserQuota = {
        name: "userQuota",
        maxReviewCountPerWeek: 999,
        usedReviewCount: used,
        remainingReviewCount: Math.max(0, 999 - used),
        customLimitEnabled: true,
      };
      return json(quota);
    }

    // 2. GET /v1/documents
    if (method === "GET" && path === "/v1/documents") {
      const documents = [...this.docs.values()].map((d) => d.document);
      return json({ documents });
    }

    // 3. POST /upload/v1/documents or POST /v1/documents
    if (method === "POST" && (path === "/upload/v1/documents" || path === "/v1/documents")) {
      const buf = new Uint8Array(await req.arrayBuffer());
      const displayName = url.searchParams.get("displayName") || "uploaded-manuscript.pdf";
      const docId = `doc-${Date.now().toString(36)}`;
      const now = new Date().toISOString();
      const doc: DocumentResource = {
        name: `documents/${docId}`,
        displayName,
        createTime: now,
      };
      this.docs.set(docId, {
        document: doc,
        rawBytes: buf,
        mimeType: req.headers.get("content-type") || "application/pdf",
        reviews: new Map(),
      });
      return json(doc);
    }

    // 4. GET /v1/documents/{docId}:download
    const downloadMatch = path.match(/^\/v1\/documents\/([^/:]+):download$/);
    if (method === "GET" && downloadMatch) {
      const entry = this.docs.get(decodeURIComponent(downloadMatch[1]));
      if (!entry) return json({ error: { code: 404, message: "Document not found" } }, 404);
      return new Response(Buffer.from(entry.rawBytes), {
        status: 200,
        headers: {
          ...cors,
          "Content-Type": entry.mimeType,
          "Content-Disposition": `inline; filename="${entry.document.displayName || "document.pdf"}"`,
        },
      });
    }

    // 5. POST /v1/documents/{docId}:estimateReviewCost
    const costMatch = path.match(/^\/v1\/documents\/([^/:]+):estimateReviewCost$/);
    if (method === "POST" && costMatch) {
      const entry = this.docs.get(decodeURIComponent(costMatch[1]));
      if (!entry) return json({ error: { code: 404, message: "Document not found" } }, 404);
      const body = (await req.json().catch(() => ({}))) as {
        runConfig?: { model?: string; topology?: Topology; thinkingLevel?: ThinkingLevel };
      };
      const parsed = await parsePdfBuffer(entry.rawBytes, entry.document.displayName);
      const est = estimateReviewCost(parsed, {
        model: body.runConfig?.model,
        topology: body.runConfig?.topology,
        thinkingLevel: body.runConfig?.thinkingLevel,
        pastReviewCount: entry.reviews.size,
      });
      return json(est);
    }

    // 6. GET/DELETE /v1/documents/{docId}
    const docMatch = path.match(/^\/v1\/documents\/([^/:]+)$/);
    if (docMatch) {
      const docId = decodeURIComponent(docMatch[1]);
      const entry = this.docs.get(docId);
      if (!entry) return json({ error: { code: 404, message: "Document not found" } }, 404);
      if (method === "GET") return json(entry.document);
      if (method === "DELETE") {
        this.docs.delete(docId);
        return json({});
      }
    }

    // 7. GET/POST /v1/documents/{docId}/reviews
    const reviewsMatch = path.match(/^\/v1\/documents\/([^/:]+)\/reviews$/);
    if (reviewsMatch) {
      const docId = decodeURIComponent(reviewsMatch[1]);
      const entry = this.docs.get(docId);
      if (!entry) return json({ error: { code: 404, message: "Document not found" } }, 404);
      if (method === "GET") {
        return json({ reviews: [...entry.reviews.values()] });
      }
      if (method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Partial<Review>;
        const cfg = resolveConfig({
          baseUrl: body.runConfig?.baseUrl,
          apiKey: body.runConfig?.apiKey || body.runConfig?.geminiApiKey,
          model: body.runConfig?.model,
          topology: body.runConfig?.topology,
          thinkingLevel: body.runConfig?.thinkingLevel,
        });
        const parsed = await parsePdfBuffer(entry.rawBytes, entry.document.displayName);
        const revId = `rev-${Date.now().toString(36)}`;
        const pipeline = new DeepReviewPipeline({
          config: cfg,
          userPrompt: body.runConfig?.userPrompt,
          documentId: docId,
          reviewId: revId,
        });
        const review = await pipeline.run(parsed);
        entry.reviews.set(revId, review);
        entry.document.latestReviewSummary = {
          review: review.name,
          state: review.state,
          createTime: review.createTime,
        };
        const op: Operation = {
          name: `operations/documents/${docId}/reviews/${revId}`,
          done: true,
          metadata: {
            "@type": "type.googleapis.com/google.deepreview.v1.ReviewOperationMetadata",
            review: review.name,
            createTime: review.createTime,
            progressPercent: 100,
          },
          response: review,
        };
        this.ops.set(op.name, op);
        return json(op);
      }
    }

    // 8. GET /v1/documents/{docId}/reviews/{revId}
    const singleRevMatch = path.match(/^\/v1\/documents\/([^/:]+)\/reviews\/([^/:]+)$/);
    if (method === "GET" && singleRevMatch) {
      const docId = decodeURIComponent(singleRevMatch[1]);
      const revId = decodeURIComponent(singleRevMatch[2]);
      const entry = this.docs.get(docId);
      const rev = entry?.reviews.get(revId);
      if (!rev) return json({ error: { code: 404, message: "Review not found" } }, 404);
      return json(rev);
    }

    // 9. Interactive Viewer HTML at `/` or `/view`
    if (method === "GET" && (path === "/" || path === "/view")) {
      const requestedDocId = url.searchParams.get("doc") || [...this.docs.keys()][0] || "";
      const entry = this.docs.get(requestedDocId);
      const review = entry ? [...entry.reviews.values()].pop() : undefined;
      return new Response(this.renderViewerHtml(entry?.document, review), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return json({ error: { code: 404, message: `Route ${method} ${path} not found` } }, 404);
  }

  public renderViewerHtml(doc?: DocumentResource, review?: Review): string {
    const rawComments = review?.result?.anchoredComments ?? [];
    const sorted = sortAnchoredComments(rawComments);
    const chips = computeCategoryFilterChips(sorted);
    const highLevelSummary = extractHighLevelSummaryMarkdown(review?.result?.reviewMarkdown ?? "");

    const pages = new Set<number>();
    for (const c of sorted) pages.add(getCommentPageNumber(c));
    const maxPage = Math.max(1, ...pages);

    const pageCardsHtml = Array.from({ length: maxPage }, (_, i) => i + 1)
      .map((pageNum) => {
        const rects = getPageHighlightRects(pageNum, sorted);
        const overlays = rects
          .map(
            (r) =>
              `<div class="bbox-overlay cat-${getCommentCategory(r.comment).toLowerCase()}" data-comment-id="${escapeHtml(r.comment.commentId)}" style="left:${r.leftPct.toFixed(2)}%;top:${r.topPct.toFixed(2)}%;width:${r.widthPct.toFixed(2)}%;height:${r.heightPct.toFixed(2)}%;" title="${escapeHtml(getCommentTitle(r.comment))}"></div>`
          )
          .join("");
        return `<div class="pdf-page-card" id="page-${pageNum}">
          <div class="pdf-page-header">Page ${pageNum} (${rects.length} anchored highlights)</div>
          <div class="pdf-page-canvas">${overlays}</div>
        </div>`;
      })
      .join("\n");

    const commentsHtml = sorted
      .map((c) => {
        const cat = getCommentCategory(c);
        const isSec = isSectionSummaryComment(c);
        const badge = formatCommentLocationBadge(c);
        const quote = getCommentQuotedText(c);
        const body = getCommentCleanBody(c);
        const action = getCommentSuggestedAction(c);
        return `<article class="comment-card" data-category="${cat}" data-comment-id="${escapeHtml(c.commentId)}">
          <header class="comment-header">
            <span class="sev-badge sev-${cat.toLowerCase()}">${isSec ? "Section Summary" : c.severity}</span>
            ${badge ? `<span class="loc-badge">${escapeHtml(badge)}</span>` : ""}
            <h3 class="comment-title">${escapeHtml(getCommentTitle(c))}</h3>
          </header>
          ${quote ? `<blockquote class="comment-quote">${escapeHtml(quote)}</blockquote>` : ""}
          <div class="comment-body">${escapeHtml(body)}</div>
          ${action ? `<div class="comment-action"><strong>Suggested Action:</strong> ${escapeHtml(action)}</div>` : ""}
        </article>`;
      })
      .join("\n");

    const chipsHtml = chips
      .map(
        (ch, idx) =>
          `<button class="chip ${idx === 0 ? "active" : ""}" data-filter="${ch.key}">${escapeHtml(ch.label)} (${ch.count})</button>`
      )
      .join("\n");

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Open Deep Review — ${escapeHtml(doc?.displayName || "Viewer")}</title>
  <style>
    :root { --bg: #0f172a; --panel: #1e293b; --border: #334155; --text: #f8fafc; --muted: #94a3b8; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); }
    header.topbar { display: flex; justify-content: space-between; align-items: center; padding: 12px 20px; border-bottom: 1px solid var(--border); background: #0b1120; }
    .meta { font-size: 13px; color: var(--muted); }
    .layout { display: grid; grid-template-columns: 1fr 1fr; height: calc(100vh - 57px); }
    .pane { overflow-y: auto; padding: 20px; }
    .pane-left { border-right: 1px solid var(--border); }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    .chip { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 999px; padding: 6px 12px; cursor: pointer; font-size: 12px; }
    .chip.active { background: #3b82f6; border-color: #60a5fa; }
    .comment-card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px; margin-bottom: 12px; }
    .comment-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
    .comment-title { margin: 0; font-size: 15px; }
    .sev-badge { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; text-transform: uppercase; }
    .sev-critical { background: #ef4444; color: #fff; }
    .sev-major { background: #f97316; color: #fff; }
    .sev-minor { background: #eab308; color: #111827; }
    .sev-suggestion { background: #22c55e; color: #111827; }
    .sev-section_summary { background: #6366f1; color: #fff; }
    .loc-badge { font-size: 11px; color: var(--muted); background: #0f172a; padding: 2px 8px; border-radius: 4px; }
    .comment-quote { margin: 8px 0; padding: 8px 12px; border-left: 3px solid #60a5fa; background: #0f172a; font-size: 13px; color: #cbd5e1; }
    .comment-body { font-size: 14px; line-height: 1.55; white-space: pre-wrap; }
    .comment-action { margin-top: 8px; padding: 8px 10px; background: rgba(34,197,94,0.12); border-radius: 6px; font-size: 13px; }
    .pdf-page-card { background: #fff; color: #0f172a; border-radius: 8px; margin-bottom: 16px; padding: 10px; }
    .pdf-page-header { font-size: 12px; font-weight: 600; margin-bottom: 6px; color: #334155; }
    .pdf-page-canvas { position: relative; width: 100%; padding-top: 129.4%; background: #f8fafc; border: 1px solid #cbd5e1; overflow: hidden; }
    .bbox-overlay { position: absolute; background: rgba(239,68,68,0.28); border: 1px solid rgba(239,68,68,0.85); border-radius: 2px; cursor: pointer; }
    .bbox-overlay.cat-major { background: rgba(249,115,22,0.28); border-color: #f97316; }
    .bbox-overlay.cat-minor { background: rgba(234,179,8,0.28); border-color: #eab308; }
    .bbox-overlay.cat-suggestion { background: rgba(34,197,94,0.28); border-color: #22c55e; }
    .summary-box { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px; margin-bottom: 16px; white-space: pre-wrap; font-size: 13px; line-height: 1.5; }
  </style>
</head>
<body>
  <header class="topbar">
    <div><strong>Open Deep Review</strong> — ${escapeHtml(doc?.displayName || "No Document")}</div>
    <div class="meta">Model: ${escapeHtml(review?.runConfig?.model || "N/A")} | Topology: ${escapeHtml(review?.runConfig?.topology || "N/A")} | Comments: ${sorted.length}</div>
  </header>
  <main class="layout">
    <section class="pane pane-left">
      <div class="summary-box"><strong>High-Level Summary</strong>\n\n${escapeHtml(highLevelSummary)}</div>
      ${pageCardsHtml}
    </section>
    <section class="pane pane-right">
      <div class="chips">${chipsHtml}</div>
      <div id="comments-list">${commentsHtml}</div>
    </section>
  </main>
  <script>
    document.querySelectorAll('.chip').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const filter = btn.getAttribute('data-filter');
        document.querySelectorAll('.comment-card').forEach(card => {
          const cat = card.getAttribute('data-category');
          card.style.display = (filter === 'ALL' || cat === filter) ? '' : 'none';
        });
      });
    });
  </script>
</body>
</html>`;
  }
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
