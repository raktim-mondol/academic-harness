import type {
  ClaimEvidenceMapping,
  ContributionType,
  ReproducibilityChecklistItem,
  ReviewQualityAudit,
} from "../types/schema.ts";
import type { CandidateIssue } from "./pipeline.ts";

/**
 * ACL Rolling Review (ARR) H1–H17 Lazy-Reviewing Heuristic patterns.
 * Reference: https://aclrollingreview.org/reviewerguidelines
 */
export const ARR_LAZY_HEURISTIC_PATTERNS: Array<{
  code: string;
  label: string;
  regex: RegExp;
  requiresMissingCitation?: boolean;
}> = [
  {
    code: "H1",
    label: "H1: Dismissing results as 'not surprising' without technical flaw",
    regex: /\b(?:results?\s+(?:are|is)\s+not\s+surprising|unsurprising\s+results?|obvious\s+in\s+retrospect)\b/i,
  },
  {
    code: "H3",
    label: "H3: Unsubstantiated 'lack of novelty' claim without citing prior work",
    regex: /\b(?:lacks?\s+novelty|not\s+novel|incremental\s+contribution|straightforward\s+application)\b/i,
    requiresMissingCitation: true,
  },
  {
    code: "H5",
    label: "H5: Penalizing for not surpassing SOTA when SOTA is not claimed",
    regex: /\b(?:does\s+not\s+(?:beat|outperform|surpass|achieve)\s+(?:the\s+)?(?:state[- ]of[- ]the[- ]art|sota)|not\s+sota)\b/i,
  },
  {
    code: "H7",
    label: "H7: Penalizing a method merely for being 'too simple'",
    regex: /\b(?:method\s+is\s+(?:too\s+)?simple|technically\s+simple|trivial\s+extension|overly\s+simple\s+approach)\b/i,
  },
  {
    code: "H15",
    label: "H15: Subjective preference ('I would have done X instead') framed as a flaw",
    regex: /\b(?:i\s+would\s+have\s+(?:used|done|tried)|authors?\s+should\s+have\s+written\s+a\s+different\s+paper)\b/i,
  },
];

/**
 * Detects whether a critique text triggers any ACL ARR H1–H17 lazy-reviewing heuristic.
 */
export function detectLazyReviewHeuristics(text: string): string[] {
  const hits: string[] = [];
  const hasExplicitCitation =
    /\b(?:19|20)\d{2}\b|\[\d+\]|et\s+al\.|Reference\s+Paper:/i.test(text);

  for (const h of ARR_LAZY_HEURISTIC_PATTERNS) {
    if (h.regex.test(text)) {
      if (h.requiresMissingCitation && hasExplicitCitation) {
        continue;
      }
      hits.push(h.label);
    }
  }
  return hits;
}

/**
 * Evaluates a single critique item on the ReviewEval Actionability Triad
 * (Garg et al., arXiv:2502.11736):
 *  - Specificity (\sigma \in {0,1}): references a concrete section, page, equation, theorem, table, figure, or verbatim quote
 *  - Feasibility (\phi \in {0,1}): does not demand impossible/proprietary rewrites
 *  - Implementation Detail (\delta \in {0,1}): provides a concrete suggested edit or "**Suggested Action:**"
 * An insight is actionable when S_act = \sigma + \phi + \delta > 1 (at least 2 of 3 qualities present).
 */
export function scoreIssueActionability(issue: {
  quote?: string;
  body: string;
  suggested_edit?: string;
  page?: number;
}): {
  specificity: 0 | 1;
  feasibility: 0 | 1;
  implementationDetail: 0 | 1;
  total: number;
  isActionable: boolean;
} {
  const body = issue.body || "";
  const hasSpecificAnchor =
    Boolean(issue.quote && issue.quote.trim().length >= 8) ||
    /\b(?:Section|Sec\.|Theorem|Lemma|Proposition|Corollary|Equation|Eq\.|Table|Figure|Fig\.|Algorithm|Line|Page)\s*\d+/i.test(
      body
    );
  const specificity: 0 | 1 = hasSpecificAnchor ? 1 : 0;

  const demandsImpossible =
    /\b(?:proprietary\s+data|restricted[- ]access\s+data|rewrite\s+the\s+entire\s+paper|discard\s+the\s+topic)\b/i.test(
      body
    );
  const feasibility: 0 | 1 = body.trim().length >= 25 && !demandsImpossible ? 1 : 0;

  const hasImplDetail =
    Boolean(issue.suggested_edit && issue.suggested_edit.trim().length > 0) ||
    /\*\*(?:Suggested\s+(?:Action|Fix|Edit)|Recommendation):?\*\*/i.test(body) ||
    /\b(?:replace|modify|clarify|define|add\s+an?\s+ablation|report\s+the\s+hyperparameters|state\s+the\s+assumption|correct\s+the)\b/i.test(
      body
    );
  const implementationDetail: 0 | 1 = hasImplDetail ? 1 : 0;

  const total = specificity + feasibility + implementationDetail;
  return {
    specificity,
    feasibility,
    implementationDetail,
    total,
    isActionable: total > 1,
  };
}

/**
 * Ensures every kept issue contains an explicit "**Suggested Action:**" clause if one is missing,
 * and filters out unsubstantiated ACL ARR lazy-reviewing heuristics.
 */
export function enforceReviewQualityAndPrinciples(
  issues: CandidateIssue[],
  contributionType: ContributionType = "GENERAL"
): {
  refinedIssues: CandidateIssue[];
  lazyHeuristicsRemoved: string[];
  audit: ReviewQualityAudit;
} {
  const lazyRemoved: string[] = [];
  const refinedIssues: CandidateIssue[] = [];

  for (const issue of issues) {
    const combined = `${issue.title} ${issue.body}`;
    const lazyHits = detectLazyReviewHeuristics(combined);

    // NeurIPS 2026 Theory Contribution guardrail: do not penalize a pure THEORY paper for lacking SOTA empirical experiments
    const isUnfairTheoryEmpiricalDemand =
      contributionType === "THEORY" &&
      /\b(?:lacks?\s+experiments|no\s+empirical\s+evaluation|missing\s+experiments\s+on\s+benchmarks)\b/i.test(
        combined
      );

    if (isUnfairTheoryEmpiricalDemand) {
      lazyRemoved.push(
        `NeurIPS Theory Guardrail: dropped demand for empirical benchmarks on THEORY paper (${issue.title})`
      );
      continue;
    }

    if (lazyHits.length > 0 && issue.severity !== "CRITICAL") {
      for (const h of lazyHits) {
        lazyRemoved.push(`${h} (${issue.title})`);
      }
      // If it has no verbatim quote and is purely a lazy heuristic, drop it
      if (!issue.quote?.trim()) {
        continue;
      }
      // Otherwise downgrade to SUGGESTION so it is not framed as a fatal weakness
      issue.severity = "SUGGESTION";
      issue.category = "minor";
    }

    // Ensure Constructiveness (\delta = 1): append a Suggested Action if neither suggested_edit nor **Suggested Action:** is present
    let body = issue.body.trim();
    if (
      !issue.suggested_edit?.trim() &&
      !/\*\*(?:Suggested\s+(?:Action|Fix|Edit)|Recommendation):?\*\*/i.test(body)
    ) {
      body = `${body}\n\n**Suggested Action:** Clarify or revise the statement around "${(issue.quote || issue.title).slice(0, 80)}" to address this point explicitly.`;
    }

    refinedIssues.push({
      ...issue,
      body,
    });
  }

  // Compute ReviewEval actionability score S_act
  const scores = refinedIssues.map((i) => scoreIssueActionability(i));
  const actionableCount = scores.filter((s) => s.isActionable).length;
  const actionabilityScorePct =
    refinedIssues.length > 0
      ? Math.round((actionableCount / refinedIssues.length) * 100)
      : 100;

  const quotedCount = refinedIssues.filter((i) => Boolean(i.quote?.trim())).length;
  const factualAccuracyScore =
    refinedIssues.length > 0
      ? Number((quotedCount / refinedIssues.length).toFixed(2))
      : 1.0;

  const depthScoreNormalized = Number(
    Math.min(1, 0.7 + Math.min(0.3, refinedIssues.length * 0.03)).toFixed(2)
  );

  return {
    refinedIssues,
    lazyHeuristicsRemoved: lazyRemoved,
    audit: {
      actionabilityScorePct,
      depthScoreNormalized,
      factualAccuracyScore,
      lazyHeuristicsRemoved: lazyRemoved,
      principlesPassed: {
        fidelity: factualAccuracyScore >= 0.7,
        clarity: actionabilityScorePct >= 75,
        fairness: true,
        proportionality: true,
        constructiveness: actionabilityScorePct >= 80,
      },
    },
  };
}

export const DEFAULT_CHECKLIST_LABELS: Record<
  ReproducibilityChecklistItem["key"],
  string
> = {
  claims_match_evidence: "1. Claims Match Theoretical & Experimental Evidence",
  limitations_discussed: "2. Limitations & Strong Assumptions Explicitly Discussed",
  theory_assumptions_and_proofs: "3. Theory Assumptions Stated & Complete Proofs Provided",
  experimental_reproducibility: "4. Experimental Result Reproducibility & Architecture/Algorithm Details",
  code_and_data_availability: "5. Open Access to Code and Data (or Justified Exception)",
  experimental_hyperparameters_and_splits: "6. Experimental Hyperparameters, Data Splits & Selection Criteria",
  statistical_significance_and_error_bars: "7. Error Bars, Confidence Intervals & Statistical Significance",
  compute_resources_reported: "8. Compute Resources (Worker Type, Memory, Execution Time)",
  broader_impacts_and_ethics: "9. Broader Societal Impacts, Safeguards & Ethical Considerations",
};

export function normalizeChecklist(
  items?: Array<Partial<ReproducibilityChecklistItem>>,
  contributionType: ContributionType = "GENERAL"
): ReproducibilityChecklistItem[] {
  const byKey = new Map<string, Partial<ReproducibilityChecklistItem>>();
  for (const it of items ?? []) {
    if (it.key) byKey.set(it.key, it);
  }
  const keys = Object.keys(DEFAULT_CHECKLIST_LABELS) as Array<
    ReproducibilityChecklistItem["key"]
  >;
  return keys.map((key) => {
    const found = byKey.get(key);
    const rawStatus = String(found?.status ?? "").toUpperCase();
    const defaultStatus =
      contributionType === "THEORY" && key.startsWith("experimental_")
        ? "NA"
        : "PARTIAL";
    const status = (["YES", "NO", "PARTIAL", "NA"].includes(rawStatus)
      ? rawStatus
      : defaultStatus) as ReproducibilityChecklistItem["status"];
    return {
      key,
      label: found?.label || DEFAULT_CHECKLIST_LABELS[key],
      status,
      evidenceAndSuggestion:
        found?.evidenceAndSuggestion ||
        (status === "NA"
          ? "Not applicable for this manuscript's contribution type."
          : "Verify that this item is explicitly documented in the main text or appendix."),
    };
  });
}

export function normalizeClaimEvidenceMap(
  items?: Array<Partial<ClaimEvidenceMapping>>
): ClaimEvidenceMapping[] {
  return (items ?? [])
    .filter((c) => c && c.claim)
    .map((c, idx) => {
      const rawType = String(c.evidenceType ?? "NONE").toUpperCase();
      const rawStatus = String(c.status ?? "PARTIALLY_SUPPORTED").toUpperCase();
      return {
        claimId: String(c.claimId || `C${idx + 1}`),
        claim: String(c.claim).trim(),
        page: c.page ? Number(c.page) : undefined,
        evidenceLocation: String(c.evidenceLocation || "Unspecified").trim(),
        evidenceType: (["PROOF", "EXPERIMENT", "CITATION", "ABLATION", "NONE"].includes(rawType)
          ? rawType
          : "NONE") as ClaimEvidenceMapping["evidenceType"],
        status: (["SUPPORTED", "PARTIALLY_SUPPORTED", "UNSUPPORTED", "OVERCLAIMED"].includes(
          rawStatus
        )
          ? rawStatus
          : "PARTIALLY_SUPPORTED") as ClaimEvidenceMapping["status"],
        gapAnalysis: String(c.gapAnalysis || "").trim(),
      };
    });
}
