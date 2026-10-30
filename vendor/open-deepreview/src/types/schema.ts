/**
 * Exact TypeScript schemas recovered from Google Deep Review REST API v1 Discovery Document
 * (`https://deepreview.googleapis.com/$discovery/rest?version=v1`, revision 20261030)
 * and the `research.google/deepreview` frontend bundle (`module_GuMH2c.js` & `module_ZZg41c.js`).
 */

export type ReviewState =
  | "STATE_UNSPECIFIED"
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED";

export type Severity =
  | "SEVERITY_UNSPECIFIED"
  | "CRITICAL"
  | "MAJOR"
  | "MINOR"
  | "SUGGESTION";

/**
 * Numeric severity codes used in raw backend PAT fixtures (`jAa` in `module_ZZg41c.js`):
 * 1: CRITICAL, 2: MAJOR, 3: MINOR, 4: SUGGESTION
 */
export const NUMERIC_SEVERITY_MAP: Record<number, Severity> = {
  1: "CRITICAL",
  2: "MAJOR",
  3: "MINOR",
  4: "SUGGESTION",
};

export type ThinkingLevel =
  | "THINKING_LEVEL_UNSPECIFIED"
  | "THINKING_LEVEL_LOW"
  | "THINKING_LEVEL_MEDIUM"
  | "THINKING_LEVEL_HIGH";

export type Topology =
  | "TOPOLOGY_UNSPECIFIED"
  | "EXTRA_HIGH"
  | "HIGH"
  | "MID"
  | "LOW";

export type CitationVerdict =
  | "VERDICT_UNSPECIFIED"
  | "OK"
  | "MINOR_MISMATCH"
  | "MAJOR_MISMATCH"
  | "VERIFIED_BY_SEARCH"
  | "NOT_FOUND"
  | "HALLUCINATED"
  | "SKIPPED";

export type SearchVerdict =
  | "SEARCH_VERDICT_UNSPECIFIED"
  | "NOT_HALLUCINATED"
  | "HALLUCINATED_BY_SEARCH"
  | "SEARCH_ERROR";

export interface GoogleDate {
  year: number;
  month: number;
  day: number;
}

export interface Author {
  givenName?: string;
  familyName?: string;
}

export interface CitationMetadata {
  title?: string;
  authors?: Author[];
  publicationDate?: GoogleDate;
  journal?: string;
  volume?: string;
  pages?: string;
  doi?: string;
  urls?: string[];
  source?: string; // e.g., "openalex", "crossref", or empty on extractedMetadata
}

export interface FieldComparison {
  fieldKey: "title" | "authors" | "year" | "journal" | "volume" | "pages" | "doi";
  match: boolean;
  detail: string; // e.g., "extracted=2023, found=2024 (diff=1)"
}

export interface GroundingUrl {
  title?: string;
  url: string;
}

export interface CitationReport {
  refNum: number;
  rawReference: string;
  citationKey: string;
  entryType: string;
  extractedMetadata?: CitationMetadata;
  retrievedMetadata?: CitationMetadata;
  retrievedBibtex?: string;
  searchMethod?: string; // "doi" | "title" | "title_author" | "autocomplete" | ""
  firstAuthorFamilyNameMatch?: boolean;
  fieldComparisons?: FieldComparison[];
  lookupVerdict: CitationVerdict;
  searchVerdict?: SearchVerdict;
  searchRationale?: string;
  groundingUrls?: GroundingUrl[];
  finalVerdict: CitationVerdict;
}

export interface NormalizedBoundingBox {
  left: number;   // [0.0, 1.0]
  top: number;    // [0.0, 1.0]
  right: number;  // [0.0, 1.0]
  bottom: number; // [0.0, 1.0]
}

export interface TextQuoteSelector {
  exact: string;
  prefix?: string;
  suffix?: string;
}

export interface PdfLocation {
  pageNumber: number; // 1-indexed
  boundingBoxes?: NormalizedBoundingBox[]; // Max 50 per anchored span
  quoteSelector?: TextQuoteSelector;
}

export interface TextLocation {
  firstLine: number; // 1-indexed inclusive
  lastLine?: number; // 1-indexed inclusive
  firstColumn?: number;
  lastColumn?: number;
  quotedLinePreview?: string;
}

export interface DocumentLocation {
  pdf?: PdfLocation;
  text?: TextLocation;
}

export interface AnchoredReviewComment {
  commentId: string;
  severity: Severity;
  summary: string;
  bodyMarkdown: string;
  suggestedEdit?: string;
  location?: DocumentLocation;
  citationReport?: CitationReport;
}

export interface Status {
  code: number;
  message: string;
  details?: Array<Record<string, unknown>>;
}

export type ContributionType =
  | "GENERAL"
  | "THEORY"
  | "EMPIRICAL_ML"
  | "USE_INSPIRED"
  | "CONCEPT_FEASIBILITY"
  | "NEGATIVE_RESULTS"
  | "SURVEY_POSITION";

export interface ClaimEvidenceMapping {
  claimId: string;
  claim: string;
  page?: number;
  evidenceLocation: string;
  evidenceType: "PROOF" | "EXPERIMENT" | "CITATION" | "ABLATION" | "NONE";
  status: "SUPPORTED" | "PARTIALLY_SUPPORTED" | "UNSUPPORTED" | "OVERCLAIMED";
  gapAnalysis: string;
}

export interface ReproducibilityChecklistItem {
  key:
    | "claims_match_evidence"
    | "limitations_discussed"
    | "theory_assumptions_and_proofs"
    | "experimental_reproducibility"
    | "code_and_data_availability"
    | "experimental_hyperparameters_and_splits"
    | "statistical_significance_and_error_bars"
    | "compute_resources_reported"
    | "broader_impacts_and_ethics";
  label: string;
  status: "YES" | "NO" | "PARTIAL" | "NA";
  evidenceAndSuggestion: string;
}

export interface AuthorRebuttalQuestion {
  questionNumber: number;
  question: string;
  linkedIssueSummary?: string;
  howResponseChangesEvaluation: string;
}

export interface ReviewQualityAudit {
  actionabilityScorePct: number; // ReviewEval S_act [0..100]
  depthScoreNormalized: number;  // ReviewEval S_depth [0..1]
  factualAccuracyScore: number;  // ReviewEval S_factual [0..1]
  lazyHeuristicsRemoved: string[]; // ACL ARR H1-H17 violations caught and rewritten/dropped
  principlesPassed: {
    fidelity: boolean;
    clarity: boolean;
    fairness: boolean;
    proportionality: boolean;
    constructiveness: boolean;
  };
}

export interface Result {
  reviewMarkdown?: string;
  anchoredComments?: AnchoredReviewComment[]; // Max 300 per review
  contributionType?: ContributionType;
  claimEvidenceMap?: ClaimEvidenceMapping[];
  reproducibilityChecklist?: ReproducibilityChecklistItem[];
  questionsForAuthors?: AuthorRebuttalQuestion[];
  reviewQualityAudit?: ReviewQualityAudit;
  error?: Status;
}

/**
 * Extended PAT Run Configuration recovered from `R$.pat_run_config` in `module_ZZg41c.js`
 * alongside `DeepReviewRunConfig` from the Discovery schema (`deepreview:v1`)
 * and user-configurable LLM endpoint parameters (`baseUrl`, `apiKey`, `model`).
 */
export interface PatModulesConfig {
  pat: {
    enabled: boolean;
    topology: number; // 1=LOW, 2=MID, 3=HIGH, 4=EXTRA_HIGH
    enable_search: boolean;
    include_segment_summaries: boolean;
    enforce_category_limits: boolean;
    segment_model_overrides: string[];
  };
  scholar_peer: {
    enabled: boolean;
  };
  citation_checker: {
    enabled: boolean;
  };
}

export interface DeepReviewRunConfig {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  geminiApiKey?: string;
  geminiApiKeySet?: boolean;
  thinkingLevel?: ThinkingLevel;
  topology?: Topology;
  userPrompt?: string;
  patModules?: PatModulesConfig;
}

export interface Review {
  name: string; // `documents/{document}/reviews/{review}`
  state: ReviewState;
  createTime: string;
  startTime?: string;
  endTime?: string;
  progressPercent?: number; // [0, 100]
  runConfig?: DeepReviewRunConfig;
  result?: Result;
}

export interface ReviewSummary {
  review: string;
  state: ReviewState;
  createTime: string;
}

export interface DriveSource {
  fileId: string;
  resourceKey?: string;
  resourceKeySet?: boolean;
  revisionId?: string;
}

export interface DocumentResource {
  name: string; // `documents/{document}`
  displayName?: string;
  createTime: string;
  driveSource?: DriveSource;
  latestReviewSummary?: ReviewSummary;
}

export interface Money {
  currencyCode: string; // "USD"
  units: string;        // int64 string
  nanos: number;        // int32 nanos (10^-9)
}

export interface EstimateReviewCostResponse {
  lowCost?: Money;
  medianCost?: Money;
  highCost?: Money;
  pastReviewCount: number;
}

export interface UserQuota {
  name: string; // "userQuota"
  maxReviewCountPerWeek: number;
  usedReviewCount: number;
  remainingReviewCount: number;
  customLimitEnabled: boolean;
  nextAvailableTime?: string;
}

export interface Operation {
  name: string; // `operations/documents/{doc}/reviews/{rev}`
  done: boolean;
  metadata?: {
    "@type"?: string;
    review?: string;
    createTime?: string;
    progressPercent?: number;
  };
  response?: Review;
  error?: Status;
}

/**
 * Raw internal fixture format (`R$` in `module_ZZg41c.js` line 1319)
 */
export interface RawPatFixture {
  paper_id: string;
  filename: string;
  review_status: number;
  review_content: string;
  review_error: string;
  recipient?: { googler_email?: string };
  review_start_timestamp_ms: string;
  upload_timestamp_ms: string;
  review_completion_timestamp_ms: string;
  failed_count: number;
  pat_topology: number;
  pat_run_config: {
    modules: PatModulesConfig;
    base_model_config: {
      vertex: {
        model_name: string;
      };
    };
  };
  anchored_comments: Array<{
    comment_id: string;
    severity: number;
    summary: string;
    body_markdown: string;
    suggested_edit: string;
    location?: {
      pdf?: {
        page_number: number;
        quote_selector?: {
          exact: string;
          prefix?: string;
          suffix?: string;
        };
        bounding_boxes?: NormalizedBoundingBox[];
      };
      text?: {
        first_line: number;
        last_line?: number;
        first_column?: number;
        last_column?: number;
        quoted_line_preview?: string;
      };
    };
  }>;
}
