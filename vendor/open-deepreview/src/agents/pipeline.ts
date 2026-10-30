import { createHash } from "node:crypto";
import { renderCitationSection, runCitationChecker } from "../citation/checker.ts";
import type { LLMUserConfig } from "../config/store.ts";
import { TOPOLOGY_PROFILES } from "../config/store.ts";
import type { ParsedManuscript } from "../doc/parser.ts";
import { sortAnchoredComments } from "../doc/target_algorithms.ts";
import { UniversalLLMClient } from "../llm/client.ts";
import type {
  AnchoredReviewComment,
  AuthorRebuttalQuestion,
  CitationReport,
  ClaimEvidenceMapping,
  ContributionType,
  EstimateReviewCostResponse,
  Money,
  ReproducibilityChecklistItem,
  Review,
  ReviewQualityAudit,
  Severity,
  ThinkingLevel,
  Topology,
} from "../types/schema.ts";
import { anchorQuote } from "./anchoring.ts";
import {
  GROUNDING_REF_SYSTEM,
  SCHOLAR_PEER_SYSTEM,
  SEGMENT_CONSOLIDATOR_SYSTEM,
  SEGMENTER_SYSTEM,
  SYNTHESIS_SYSTEM,
  VERIFIER_SYSTEM,
} from "./prompts.ts";
import {
  detectLazyReviewHeuristics,
  enforceReviewQualityAndPrinciples,
  normalizeChecklist,
  normalizeClaimEvidenceMap,
} from "./review_heuristics.ts";

export interface ScholarWeakness {
  text: string;
  severity?: string;
  summary?: string;
  page?: number;
  quote?: string;
}

export interface ScholarPeerResult {
  summary: string;
  strengths: string[];
  weaknesses: ScholarWeakness[];
  claimEvidenceMap: ClaimEvidenceMapping[];
  reproducibilityChecklist: ReproducibilityChecklistItem[];
  questionsForAuthors: AuthorRebuttalQuestion[];
  lazyDropped: string[];
}

export type Complexity = "LIGHT" | "MEDIUM" | "HIGH";

export interface Segment {
  title: string;
  pages: number[];
  theme: string;
  complexity: Complexity;
  focus: string;
}

export interface CandidateIssue {
  id: string;
  segmentIndex: number;
  title: string;
  summary: string;
  category: "mistake" | "minor";
  severity: Severity;
  page: number;
  quote: string;
  body: string;
  suggested_edit: string;
}

interface VerifierOutput {
  segment_summary?: string;
  issues?: Array<Partial<CandidateIssue>>;
}

export interface PipelineProgress {
  stage: string;
  percent: number;
  message: string;
}

export interface PipelineOptions {
  config: LLMUserConfig;
  userPrompt?: string;
  concurrency?: number;
  offlineCitations?: boolean;
  onProgress?: (p: PipelineProgress) => void;
  documentId?: string;
  reviewId?: string;
}

const SEVERITIES: Severity[] = ["CRITICAL", "MAJOR", "MINOR", "SUGGESTION"];
const SEVERITY_RANK: Record<string, number> = { CRITICAL: 4, MAJOR: 3, MINOR: 2, SUGGESTION: 1 };

function normSeverity(s: unknown): Severity {
  const v = String(s ?? "").trim().toUpperCase();
  return (SEVERITIES as string[]).includes(v) ? (v as Severity) : "MINOR";
}

/** Adaptive budgeting (Stage 2): number of parallel verifier passes per segment. */
export function passesForSegment(complexity: Complexity, topologyPasses: number): number {
  const mult = complexity === "HIGH" ? 1 : complexity === "MEDIUM" ? 0.75 : 0.5;
  return Math.max(1, Math.round(topologyPasses * mult));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

function pagesText(doc: ParsedManuscript, pages: number[]): string {
  const set = new Set(pages);
  return doc.pages
    .filter((p) => set.has(p.pageNumber))
    .map((p) => `[Page ${p.pageNumber}]\n${p.text}`)
    .join("\n\n");
}

function fullContext(doc: ParsedManuscript, maxChars = 400_000): string {
  const t = doc.pages.map((p) => `[Page ${p.pageNumber}]\n${p.text}`).join("\n\n");
  return t.length > maxChars ? t.slice(0, maxChars) + "\n[... truncated ...]" : t;
}

export function commentIdFor(n: number, seed: string): string {
  return `c-${n}-${createHash("sha1").update(seed).digest("hex").slice(0, 8)}`;
}

function pageRangeLabel(pages: number[]): string {
  if (pages.length === 0) return "";
  const s = [...new Set(pages)].sort((a, b) => a - b);
  return s.length === 1 ? `Pages: ${s[0]}` : `Pages: ${s[0]}-${s[s.length - 1]}`;
}

export class DeepReviewPipeline {
  private readonly llm: UniversalLLMClient;
  private readonly cfg: LLMUserConfig;
  private readonly opts: PipelineOptions;
  private readonly profile;
  public contributionType: ContributionType = "GENERAL";

  constructor(opts: PipelineOptions) {
    this.opts = opts;
    this.cfg = opts.config;
    this.llm = new UniversalLLMClient({
      baseUrl: this.cfg.baseUrl,
      apiKey: this.cfg.apiKey,
      model: this.cfg.model,
      thinkingLevel: this.cfg.thinkingLevel,
    });
    const topo = this.cfg.topology === "TOPOLOGY_UNSPECIFIED" ? "MID" : this.cfg.topology;
    this.profile = TOPOLOGY_PROFILES[topo];
  }

  private progress(stage: string, percent: number, message: string) {
    this.opts.onProgress?.({ stage, percent: Math.round(percent), message });
  }

  private userGuidance(): string {
    return this.opts.userPrompt?.trim()
      ? `\n\nUSER GUIDANCE (focus areas / venue provided by the author):\n${this.opts.userPrompt.trim()}`
      : "";
  }

  /** Stage 1: Document Segmentation & Contribution-Type Classification (+ Stage 2 adaptive budget labels). */
  async segment(doc: ParsedManuscript): Promise<Segment[]> {
    const maxSegments = Math.min(12, Math.max(2, Math.ceil(doc.pages.length / 2)));
    const outline = doc.pages
      .map((p) => `[Page ${p.pageNumber}]\n${p.text.slice(0, 2500)}`)
      .join("\n\n");
    const res = await this.llm.complete({
      systemPrompt: SEGMENTER_SYSTEM.replace("{MAX_SEGMENTS}", String(maxSegments)),
      userPrompt: `MANUSCRIPT (${doc.pages.length} pages, page excerpts):\n\n${outline}${this.userGuidance()}`,
      jsonMode: true,
      temperature: 0,
    });
    const parsed = UniversalLLMClient.parseJsonResponse<{
      contribution_type?: string;
      segments?: Segment[];
    }>(res.content, {});
    const rawCt = String(parsed.contribution_type ?? "GENERAL").toUpperCase();
    const validCts: ContributionType[] = [
      "GENERAL",
      "THEORY",
      "EMPIRICAL_ML",
      "USE_INSPIRED",
      "CONCEPT_FEASIBILITY",
      "NEGATIVE_RESULTS",
      "SURVEY_POSITION",
    ];
    this.contributionType = (validCts as string[]).includes(rawCt)
      ? (rawCt as ContributionType)
      : "GENERAL";
    const valid = new Set(doc.pages.map((p) => p.pageNumber));
    let segs = (parsed.segments ?? [])
      .map((s) => ({
        title: String(s.title || "Segment").trim(),
        pages: (s.pages ?? []).map(Number).filter((p) => valid.has(p)),
        theme: String(s.theme || "other"),
        complexity: (["LIGHT", "MEDIUM", "HIGH"].includes(String(s.complexity)) ? s.complexity : "MEDIUM") as Complexity,
        focus: String(s.focus || ""),
      }))
      .filter((s) => s.pages.length > 0)
      .slice(0, maxSegments);

    // Coverage guarantee: every page in at least one segment
    const covered = new Set(segs.flatMap((s) => s.pages));
    const missing = [...valid].filter((p) => !covered.has(p));
    if (segs.length === 0) {
      const all = [...valid];
      const chunk = 3;
      segs = [];
      for (let i = 0; i < all.length; i += chunk) {
        const pg = all.slice(i, i + chunk);
        segs.push({ title: `Pages ${pg[0]}-${pg[pg.length - 1]}`, pages: pg, theme: "other", complexity: "MEDIUM", focus: "" });
      }
    } else if (missing.length) {
      segs.push({ title: "Remaining Content", pages: missing, theme: "other", complexity: "LIGHT", focus: "" });
    }
    return segs;
  }

  /** Stage 3: Deep Review — parallel verifier passes per segment + consolidation. */
  async reviewSegment(doc: ParsedManuscript, seg: Segment, segIndex: number): Promise<{ summary: string; issues: CandidateIssue[] }> {
    const passes = passesForSegment(seg.complexity, this.profile.verifierPassesPerSegment);
    const ctx = fullContext(doc);
    const assigned = pagesText(doc, seg.pages);
    const userPrompt = `FULL MANUSCRIPT (context only):\n\n${ctx}\n\n=====\nASSIGNED SEGMENT: "${seg.title}" (${pageRangeLabel(seg.pages)}), theme: ${seg.theme}, budget: ${seg.complexity}\nFOCUS: ${seg.focus}\n\nASSIGNED SEGMENT TEXT:\n\n${assigned}${this.userGuidance()}`;
    const override = this.cfg.patModules?.pat?.segment_model_overrides?.[segIndex];

    const outputs = await Promise.all(
      Array.from({ length: passes }, (_, k) =>
        this.llm
          .complete({
            systemPrompt: VERIFIER_SYSTEM,
            userPrompt: userPrompt + (passes > 1 ? `\n\n(Independent verification pass ${k + 1} of ${passes}. Think independently.)` : ""),
            jsonMode: true,
            temperature: passes > 1 ? 0.7 : 0.2,
            modelOverride: override || undefined,
          })
          .then((r) => UniversalLLMClient.parseJsonResponse<VerifierOutput>(r.content, {}))
          .catch(() => ({} as VerifierOutput))
      )
    );

    let merged: VerifierOutput;
    if (passes > 1 && this.profile.enableDebateRefinement) {
      const candidates = outputs.flatMap((o, k) => (o.issues ?? []).map((i) => ({ pass: k + 1, ...i })));
      const res = await this.llm
        .complete({
          systemPrompt: SEGMENT_CONSOLIDATOR_SYSTEM,
          userPrompt: `ASSIGNED SEGMENT TEXT:\n\n${assigned}\n\nCANDIDATE ISSUES FROM ${passes} PASSES:\n${JSON.stringify(candidates, null, 1)}\n\nSEGMENT SUMMARIES:\n${outputs.map((o) => o.segment_summary ?? "").join("\n")}`,
          jsonMode: true,
          temperature: 0,
        })
        .catch(() => null);
      merged = res ? UniversalLLMClient.parseJsonResponse<VerifierOutput>(res.content, outputs[0]) : outputs[0];
    } else {
      merged = {
        segment_summary: outputs.find((o) => o.segment_summary)?.segment_summary,
        issues: outputs.flatMap((o) => o.issues ?? []),
      };
    }

    const issues: CandidateIssue[] = (merged.issues ?? [])
      .filter((i) => i && (i.body || i.title))
      .map((i, n) => ({
        id: `s${segIndex}-i${n}`,
        segmentIndex: segIndex,
        title: String(i.title ?? i.summary ?? "Issue").trim(),
        summary: String(i.summary ?? i.title ?? "Review comment").trim(),
        category: i.category === "minor" ? "minor" : "mistake",
        severity: normSeverity(i.severity),
        page: Number(i.page ?? seg.pages[0]),
        quote: String(i.quote ?? "").trim(),
        body: String(i.body ?? "").trim(),
        suggested_edit: String(i.suggested_edit ?? "").trim(),
      }));
    return { summary: String(merged.segment_summary ?? ""), issues };
  }

  /** Stage 4: Global synthesis, ReviewEval actionability audit, ACL ARR lazy-heuristic filter, and category limits. */
  async synthesize(candidates: CandidateIssue[]): Promise<{
    kept: CandidateIssue[];
    qualityAudit: ReviewQualityAudit;
  }> {
    const maxIssues = this.profile.maxCommentsPerReview;
    if (candidates.length === 0) {
      return { kept: [], qualityAudit: enforceReviewQualityAndPrinciples([], this.contributionType).audit };
    }
    const compact = candidates.map((c) => ({
      id: c.id,
      segment: c.segmentIndex,
      severity: c.severity,
      title: c.title,
      quote: c.quote.slice(0, 200),
      body: c.body.slice(0, 600),
    }));
    const res = await this.llm
      .complete({
        systemPrompt: SYNTHESIS_SYSTEM.replace("{MAX_ISSUES}", String(maxIssues)),
        userPrompt: `CONTRIBUTION TYPE: ${this.contributionType}\n\nCANDIDATE ISSUES:\n${JSON.stringify(compact, null, 1)}`,
        jsonMode: true,
        temperature: 0,
      })
      .catch(() => null);
    let kept = candidates;
    let llmLazyRemoved: string[] = [];
    if (res) {
      const parsed = UniversalLLMClient.parseJsonResponse<{
        keep?: Array<{ id: string; severity?: string }>;
        lazy_heuristics_removed?: string[];
      }>(res.content, {});
      if (parsed.keep && parsed.keep.length) {
        const byId = new Map(candidates.map((c) => [c.id, c]));
        kept = parsed.keep
          .filter((k) => byId.has(k.id))
          .map((k) => ({ ...byId.get(k.id)!, severity: k.severity ? normSeverity(k.severity) : byId.get(k.id)!.severity }));
      }
      if (Array.isArray(parsed.lazy_heuristics_removed)) {
        llmLazyRemoved = parsed.lazy_heuristics_removed.map(String);
      }
    }

    // Deterministic guardrails: ACL ARR lazy heuristics, NeurIPS theory guardrail, ReviewEval actionability triad
    const { refinedIssues, lazyHeuristicsRemoved, audit } = enforceReviewQualityAndPrinciples(kept, this.contributionType);
    kept = refinedIssues;
    audit.lazyHeuristicsRemoved = [...new Set([...llmLazyRemoved, ...lazyHeuristicsRemoved])];

    // enforce_category_limits: cap per segment and total
    if (this.cfg.patModules?.pat?.enforce_category_limits !== false) {
      const perSeg = Math.max(6, Math.ceil(maxIssues / 4));
      const counts = new Map<number, number>();
      kept = [...kept]
        .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0))
        .filter((c) => {
          const n = (counts.get(c.segmentIndex) ?? 0) + 1;
          counts.set(c.segmentIndex, n);
          return n <= perSeg;
        });
    }
    return { kept: kept.slice(0, Math.min(maxIssues, 300)), qualityAudit: audit };
  }

  async scholarPeer(doc: ParsedManuscript): Promise<ScholarPeerResult> {
    const res = await this.llm.complete({
      systemPrompt: SCHOLAR_PEER_SYSTEM,
      userPrompt: `CONTRIBUTION TYPE: ${this.contributionType}\n\nMANUSCRIPT:\n\n${fullContext(doc)}${this.userGuidance()}`,
      jsonMode: true,
      temperature: 0.3,
    });
    const parsed = UniversalLLMClient.parseJsonResponse<{
      summary?: string;
      strengths?: string[];
      weaknesses?: ScholarWeakness[];
      claim_evidence_map?: Array<Partial<ClaimEvidenceMapping>>;
      reproducibility_checklist?: Array<Partial<ReproducibilityChecklistItem>>;
      questions_for_authors?: Array<Partial<AuthorRebuttalQuestion>>;
    }>(res.content, {});

    // Search grounding of "(Reference Paper: Title, Year)" mentions — remove hallucinated works
    const weaknesses = (parsed.weaknesses ?? []).filter((w) => w && w.text);
    if (this.cfg.patModules?.pat?.enable_search !== false) {
      const refs = [...new Set(weaknesses.flatMap((w) => [...String(w.text).matchAll(/\(Reference Paper: ([^)]+)\)/g)].map((m) => m[1])))];
      if (refs.length) {
        const g = await this.llm
          .complete({ systemPrompt: GROUNDING_REF_SYSTEM, userPrompt: JSON.stringify(refs), jsonMode: true, temperature: 0 })
          .catch(() => null);
        if (g) {
          const out = UniversalLLMClient.parseJsonResponse<{ results?: Array<{ title: string; exists: boolean }> }>(g.content, {});
          const fake = new Set((out.results ?? []).filter((r) => r.exists === false).map((r) => r.title));
          for (const w of weaknesses) {
            for (const f of fake) w.text = w.text.replace(`(Reference Paper: ${f})`, "").trim();
          }
        }
      }
    }

    // Apply ACL ARR lazy-heuristic filter to high-level weaknesses too
    const lazyDropped: string[] = [];
    const filteredWeaknesses = weaknesses.filter((w) => {
      const hits = detectLazyReviewHeuristics(w.text);
      if (hits.length && !/\(Reference Paper:/.test(w.text) && normSeverity(w.severity) !== "CRITICAL") {
        lazyDropped.push(...hits.map((h) => `${h} (weakness: ${String(w.summary ?? w.text).slice(0, 60)})`));
        return false;
      }
      return true;
    });

    const questionsForAuthors: AuthorRebuttalQuestion[] = (parsed.questions_for_authors ?? [])
      .filter((q) => q && q.question)
      .map((q, idx) => ({
        questionNumber: Number(q.questionNumber ?? idx + 1),
        question: String(q.question).trim(),
        linkedIssueSummary: q.linkedIssueSummary ? String(q.linkedIssueSummary).trim() : undefined,
        howResponseChangesEvaluation: String(
          q.howResponseChangesEvaluation || "A clear justification or additional evidence would resolve this concern."
        ).trim(),
      }));

    return {
      summary: parsed.summary ?? "",
      strengths: (parsed.strengths ?? []).map(String),
      weaknesses: filteredWeaknesses,
      claimEvidenceMap: normalizeClaimEvidenceMap(parsed.claim_evidence_map),
      reproducibilityChecklist: normalizeChecklist(parsed.reproducibility_checklist, this.contributionType),
      questionsForAuthors,
      lazyDropped,
    };
  }

  async run(doc: ParsedManuscript): Promise<Review> {
    const startTime = new Date().toISOString();
    const docId = this.opts.documentId ?? createHash("sha1").update(doc.rawBytes).digest("hex").slice(0, 16);
    const revId = this.opts.reviewId ?? crypto.randomUUID();
    const modules = this.cfg.patModules;
    const conc = this.opts.concurrency ?? 4;

    this.progress("SEGMENTATION", 3, "Segmenting manuscript and classifying contribution type");
    const segments = await this.segment(doc);

    this.progress("ADAPTIVE_BUDGETING", 8, `Contribution type ${this.contributionType}; allocated budgets for ${segments.length} segments`);

    const emptyScholar = (): ScholarPeerResult => ({
      summary: "",
      strengths: [],
      weaknesses: [],
      claimEvidenceMap: [],
      reproducibilityChecklist: normalizeChecklist([], this.contributionType),
      questionsForAuthors: [],
      lazyDropped: [],
    });

    const scholarP = modules?.scholar_peer?.enabled !== false
      ? this.scholarPeer(doc).catch(() => emptyScholar())
      : Promise.resolve(emptyScholar());

    const citationP: Promise<CitationReport[]> = modules?.citation_checker?.enabled !== false
      ? runCitationChecker(this.llm, doc.fullText, {
          enableSearchGrounding: modules?.pat?.enable_search !== false,
          offline: this.opts.offlineCitations,
          concurrency: conc,
        }).catch(() => [])
      : Promise.resolve([]);

    let done = 0;
    const segResults = await mapLimit(segments, conc, async (seg, i) => {
      const r = await this.reviewSegment(doc, seg, i);
      done++;
      this.progress("DEEP_REVIEW", 10 + (70 * done) / segments.length, `Verified segment ${done}/${segments.length}: ${seg.title}`);
      return r;
    });

    this.progress("GLOBAL_SYNTHESIS", 82, "De-duplicating, calibrating severity, filtering lazy heuristics, auditing actionability");
    const { kept, qualityAudit } = await this.synthesize(segResults.flatMap((r) => r.issues));
    const scholar = await scholarP;
    qualityAudit.lazyHeuristicsRemoved = [...new Set([...qualityAudit.lazyHeuristicsRemoved, ...scholar.lazyDropped])];
    this.progress("CITATION_CHECK", 92, "Verifying references against OpenAlex and Crossref");
    const citations = await citationP;

    this.progress("REPORT", 97, "Assembling Markdown report and anchoring comments");
    const anchored = this.buildAnchoredComments(doc, kept, scholar.weaknesses, citations, segments, segResults);
    const markdown = this.renderMarkdown(doc, segments, segResults, kept, scholar, citations, qualityAudit);

    this.progress("DONE", 100, "Review succeeded");
    return {
      name: `documents/${docId}/reviews/${revId}`,
      state: "SUCCEEDED",
      createTime: startTime,
      startTime,
      endTime: new Date().toISOString(),
      progressPercent: 100,
      runConfig: {
        model: this.cfg.model,
        baseUrl: this.cfg.baseUrl,
        topology: this.cfg.topology,
        thinkingLevel: this.cfg.thinkingLevel,
        userPrompt: this.opts.userPrompt,
        patModules: this.cfg.patModules,
      },
      result: {
        reviewMarkdown: markdown,
        anchoredComments: anchored,
        contributionType: this.contributionType,
        claimEvidenceMap: scholar.claimEvidenceMap,
        reproducibilityChecklist: scholar.reproducibilityChecklist,
        questionsForAuthors: scholar.questionsForAuthors,
        reviewQualityAudit: qualityAudit,
      },
    };
  }

  buildAnchoredComments(
    doc: ParsedManuscript,
    issues: CandidateIssue[],
    weaknesses: ScholarWeakness[],
    citations: CitationReport[],
    segments: Segment[],
    segResults: Array<{ summary: string }>
  ): AnchoredReviewComment[] {
    const out: AnchoredReviewComment[] = [];
    let n = 1;
    for (const w of weaknesses) {
      const body = String(w.text).replace(/\s*\(Reference Paper: [^)]+\)/g, "").trim();
      out.push({
        commentId: commentIdFor(n++, body),
        severity: normSeverity(w.severity ?? "MAJOR"),
        summary: String(w.summary ?? "High-level weakness"),
        bodyMarkdown: body,
        suggestedEdit: "",
        location: anchorQuote(doc, String(w.quote ?? ""), w.page),
      });
    }
    for (const i of issues) {
      out.push({
        commentId: commentIdFor(n++, i.id + i.body),
        severity: i.severity,
        summary: i.summary || i.title,
        bodyMarkdown: i.body,
        suggestedEdit: i.suggested_edit,
        location: anchorQuote(doc, i.quote, i.page),
      });
    }
    if (this.cfg.patModules?.pat?.include_segment_summaries !== false) {
      segments.forEach((s, idx) => {
        const summary = segResults[idx]?.summary;
        if (!summary) return;
        out.push({
          commentId: `section-${idx + 1}`,
          severity: "SEVERITY_UNSPECIFIED",
          summary: s.title,
          bodyMarkdown: summary,
          location: { pdf: { pageNumber: s.pages[0] ?? 1 } },
        });
      });
    }
    for (const c of citations) {
      if (["OK", "SKIPPED", "VERIFIED_BY_SEARCH"].includes(c.finalVerdict)) continue;
      out.push({
        commentId: commentIdFor(n++, `ref-${c.refNum}-${c.rawReference}`),
        severity: c.finalVerdict === "HALLUCINATED" || c.finalVerdict === "MAJOR_MISMATCH" ? "MAJOR" : "MINOR",
        summary: `Reference [${c.refNum}] ${c.finalVerdict.replace(/_/g, " ").toLowerCase()}`,
        bodyMarkdown: [
          `Bibliography entry: ${c.rawReference}`,
          ...(c.fieldComparisons ?? []).filter((f) => !f.match).map((f) => `- ${f.fieldKey}: ${f.detail}`),
          c.searchRationale ? `Search grounding: ${c.searchRationale}` : "",
        ].filter(Boolean).join("\n"),
        location: anchorQuote(doc, c.rawReference.slice(0, 160)),
        citationReport: c,
      });
    }
    return sortAnchoredComments(out).slice(0, 300);
  }

  renderMarkdown(
    doc: ParsedManuscript,
    segments: Segment[],
    segResults: Array<{ summary: string }>,
    issues: CandidateIssue[],
    scholar: ScholarPeerResult,
    citations: CitationReport[],
    audit?: ReviewQualityAudit
  ): string {
    const L: string[] = ["# HIGH LEVEL SUMMARY", "---"];
    L.push(
      `**Manuscript:** ${doc.filename} | **Contribution type:** ${CONTRIBUTION_LABELS[this.contributionType]} | **Pages:** ${doc.pages.length}`,
      ""
    );
    L.push("## Summary", scholar.summary || "(No summary produced.)", "");
    if (scholar.strengths.length) {
      L.push("## Strengths", ...scholar.strengths.map((s) => `* ${s}`), "");
    }
    if (scholar.weaknesses.length) {
      L.push(
        "## Weaknesses",
        ...scholar.weaknesses.map((w) => `* **[${normSeverity(w.severity ?? "MAJOR")}]** ${w.text}`),
        ""
      );
    }

    // Severity overview
    const sevCounts = { CRITICAL: 0, MAJOR: 0, MINOR: 0, SUGGESTION: 0 } as Record<string, number>;
    for (const i of issues) sevCounts[i.severity] = (sevCounts[i.severity] ?? 0) + 1;
    L.push(
      "## Issue Overview",
      "",
      "| Critical | Major | Minor | Suggestion |",
      "|---|---|---|---|",
      `| ${sevCounts.CRITICAL} | ${sevCounts.MAJOR} | ${sevCounts.MINOR} | ${sevCounts.SUGGESTION} |`,
      ""
    );

    if (scholar.claimEvidenceMap.length) {
      L.push(
        "## Claims and Evidence",
        "",
        "| ID | Claim | Evidence | Type | Status | Gap |",
        "|---|---|---|---|---|---|",
        ...scholar.claimEvidenceMap.map(
          (c) =>
            `| ${c.claimId} | ${mdCell(c.claim)} | ${mdCell(c.evidenceLocation)} | ${c.evidenceType} | ${CLAIM_STATUS_LABELS[c.status]} | ${mdCell(c.gapAnalysis || "-")} |`
        ),
        ""
      );
    }

    if (scholar.reproducibilityChecklist.length) {
      L.push(
        "## Reproducibility and Rigor Checklist",
        "",
        "| Item | Status | Evidence / Suggestion |",
        "|---|---|---|",
        ...scholar.reproducibilityChecklist.map(
          (c) => `| ${mdCell(c.label)} | ${c.status} | ${mdCell(c.evidenceAndSuggestion)} |`
        ),
        ""
      );
    }

    if (scholar.questionsForAuthors.length) {
      L.push("## Questions for the Authors", "");
      for (const q of scholar.questionsForAuthors) {
        L.push(`${q.questionNumber}. ${q.question}`);
        L.push(`    * Why it matters: ${q.howResponseChangesEvaluation}`);
      }
      L.push("");
    }

    L.push("## Potential Issues And Suggestions", "");
    segments.forEach((s, idx) => {
      const segIssues = issues
        .filter((i) => i.segmentIndex === idx)
        .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));
      if (segIssues.length === 0 && !segResults[idx]?.summary) return;
      L.push(`### [${s.title}] (${pageRangeLabel(s.pages)})`);
      if (segResults[idx]?.summary) L.push("", `> ${segResults[idx].summary.replace(/\n+/g, " ")}`, "");
      const mistakes = segIssues.filter((i) => i.category === "mistake");
      const minor = segIssues.filter((i) => i.category === "minor");
      if (mistakes.length) {
        L.push("#### Potential Mistakes and Improvements", "");
        for (const m of mistakes) L.push(renderIssue(m), "");
      }
      if (minor.length) {
        L.push("#### Minor Corrections and Typos", "");
        for (const m of minor) L.push(renderIssue(m), "");
      }
      if (!mistakes.length && !minor.length) L.push("", "No significant issues identified in this segment.", "");
    });
    L.push(renderCitationSection(citations));

    if (audit) {
      L.push(
        "",
        "# REVIEW QUALITY AUDIT",
        "---",
        "Self-check of this review against peer-review best practice (ReviewEval actionability, ACL ARR reviewing guidelines, and fidelity/clarity/fairness/proportionality/constructiveness principles).",
        "",
        "| Metric | Value |",
        "|---|---|",
        `| Actionable comments (specific + feasible + concrete fix) | ${audit.actionabilityScorePct}% |`,
        `| Comments anchored to a verbatim quote | ${Math.round(audit.factualAccuracyScore * 100)}% |`,
        `| Principles passed | ${Object.entries(audit.principlesPassed).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"} |`,
        ""
      );
      if (audit.lazyHeuristicsRemoved.length) {
        L.push("Filtered or downgraded comments (lazy-reviewing heuristics):", ...audit.lazyHeuristicsRemoved.map((h) => `* ${h}`), "");
      }
    }
    return L.join("\n");
  }
}

const CONTRIBUTION_LABELS: Record<ContributionType, string> = {
  GENERAL: "General research",
  THEORY: "Theory",
  EMPIRICAL_ML: "Empirical / methods",
  USE_INSPIRED: "Use-inspired / application",
  CONCEPT_FEASIBILITY: "Concept and feasibility",
  NEGATIVE_RESULTS: "Negative results",
  SURVEY_POSITION: "Survey / position",
};

const CLAIM_STATUS_LABELS: Record<ClaimEvidenceMapping["status"], string> = {
  SUPPORTED: "Supported",
  PARTIALLY_SUPPORTED: "Partially supported",
  UNSUPPORTED: "Unsupported",
  OVERCLAIMED: "Overclaimed",
};

function mdCell(s: string): string {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

function renderIssue(m: CandidateIssue): string {
  const lines = [`*   **[${m.severity}] ${m.title}** (page ${m.page})`];
  if (m.quote) lines.push(`    > "${m.quote.replace(/\s*\n\s*/g, " ")}"`);
  lines.push(`    ${m.body.replace(/\n/g, "\n    ")}`);
  if (m.suggested_edit) lines.push(`    * Suggested edit: \`${m.suggested_edit.replace(/`/g, "'")}\``);
  return lines.join("\n");
}

export function usdToMoney(usd: number): Money {
  const safe = Math.max(0, usd);
  const units = Math.floor(safe);
  const nanos = Math.round((safe - units) * 1_000_000_000);
  return {
    currencyCode: "USD",
    units: String(units),
    nanos,
  };
}

export function formatMoneyUsd(m?: Money): string {
  if (!m) return "$0.00";
  const val = Number(m.units || 0) + (m.nanos || 0) / 1e9;
  return `$${val.toFixed(4)}`;
}

/**
 * Implements `documents:estimateReviewCost` (`POST /v1/{name=documents/*}:estimateReviewCost`)
 * estimating low/median/high USD cost based on manuscript token count, topology, thinking level, and model pricing.
 */
export function estimateReviewCost(
  doc: ParsedManuscript,
  options: {
    model?: string;
    topology?: Topology;
    thinkingLevel?: ThinkingLevel;
    pastReviewCount?: number;
  } = {}
): EstimateReviewCostResponse {
  const topoKey =
    !options.topology || options.topology === "TOPOLOGY_UNSPECIFIED"
      ? "MID"
      : options.topology;
  const profile = TOPOLOGY_PROFILES[topoKey];
  const approxDocTokens = Math.max(500, Math.ceil(doc.fullText.length / 4));
  const numSegments = Math.min(12, Math.max(2, Math.ceil(doc.pages.length / 2)));
  const avgPasses = profile.verifierPassesPerSegment * 0.75;
  const thinkingMult =
    options.thinkingLevel === "THINKING_LEVEL_HIGH"
      ? 1.8
      : options.thinkingLevel === "THINKING_LEVEL_LOW"
      ? 0.7
      : 1.0;

  // Per-1M token pricing heuristic across common model families
  const model = (options.model || "gpt-4o").toLowerCase();
  let inputPer1M = 2.0;
  let outputPer1M = 10.0;
  if (model.includes("flash") || model.includes("mini") || model.includes("haiku")) {
    inputPer1M = 0.3;
    outputPer1M = 1.5;
  } else if (model.includes("opus") || model.includes("o1") || model.includes("gpt-4.5")) {
    inputPer1M = 15.0;
    outputPer1M = 60.0;
  } else if (model.includes("deepseek")) {
    inputPer1M = 0.55;
    outputPer1M = 2.19;
  }

  const totalInputTokens = approxDocTokens * (2 + numSegments * avgPasses);
  const totalOutputTokens = (2500 + numSegments * avgPasses * 1800) * thinkingMult;

  const medianUsd =
    (totalInputTokens / 1_000_000) * inputPer1M +
    (totalOutputTokens / 1_000_000) * outputPer1M;

  return {
    lowCost: usdToMoney(medianUsd * 0.65),
    medianCost: usdToMoney(medianUsd),
    highCost: usdToMoney(medianUsd * 1.55),
    pastReviewCount: options.pastReviewCount ?? 1,
  };
}

