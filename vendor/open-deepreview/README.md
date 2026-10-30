# Open Deep Review (`open-deepreview`)

[![CI](https://github.com/raktim-mondol/open-deepreview/actions/workflows/ci.yml/badge.svg)](https://github.com/raktim-mondol/open-deepreview/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/raktim-mondol/open-deepreview)](https://github.com/raktim-mondol/open-deepreview/releases)

An open-source TypeScript + Bun CLI and local API/viewer that recreates Google Research's **Deep Review** ([research.google/deepreview](https://research.google/deepreview/)) and **Paper Assistant Tool (PAT)** pipeline ([Google Research Blog](https://research.google/blog/analyzing-technical-documents-with-deep-review/), [arXiv:2606.28277](https://arxiv.org/abs/2606.28277)) for analyzing technical and scientific papers — with full support for any user-specified LLM **`baseUrl`**, **`apiKey`**, and **`model`**.

---

## How Google Deep Review Works (Reverse-Engineered Architecture)

Based on static analysis of the shipped `BoqAngularDeepReviewUi` JavaScript bundles (`deepreview_bundle.js`, `module_GuMH2c.js`, `module_ZZg41c.js`), the Google Discovery Service schema (`https://deepreview.googleapis.com/$discovery/rest?version=v1`), and the companion PAT paper ([arXiv:2606.28277](https://arxiv.org/abs/2606.28277)), Deep Review operates through three coordinated modules (`pat_run_config.modules`: `pat`, `scholar_peer`, and `citation_checker`):

```
Manuscript (.pdf / .tex / .md)
 │
 ├─► 0. PDF-to-Markdown Conversion (`@firecrawl/pdf-inspector`)
 │      Classifies PDF (`TextBased` / `Scanned` / `Mixed`), extracts structured
 │      per-page Markdown (headings, tables, lists, bold/italic, code blocks)
 │      + positioned text coordinates in milliseconds
 │
 ├─► 1. Document Segmentation (Stage 1)
 │      Partitions pages into overlapping thematic segments
 │      (theory/proofs, methodology, experiments, intro, related work)
 │
 ├─► 2. Adaptive Compute Budgeting (Stage 2)
 │      Assigns each segment a LIGHT, MEDIUM, or HIGH budget
 │      scaled by the chosen Topology (LOW=1, MID=2, HIGH=3, EXTRA_HIGH=4)
 │
 ├─► 3. Parallel Deep Review Verifiers + Segment Consolidator (Stage 3)
 │      Runs N independent verification passes per segment (full paper context,
 │      segment-scoped critique) -> skeptical consolidation drops false positives
 │
 ├─► 4. Global Synthesis, Scholar Peer & Citation Checker (Stage 4)
 │      • Cross-segment de-duplication, severity calibration (CRITICAL/MAJOR/MINOR/SUGGESTION)
 │      • Scholar Peer high-level summary, strengths & grounded weaknesses
 │      • Citation Checker against OpenAlex + Crossref + LLM search grounding
 │      • Quote-to-PDF-bounding-box matcher (NFKD normalization, margin line-number
 │        filtering < 8.5% page width, 28/24-char prefix/suffix fallback, <0.009 line merge)
 │
 └─► Output: Deep Review Markdown Report + AnchoredReviewComment[] + Split-Pane Viewer
```

See [`docs/REVERSE_ENGINEERING_REPORT.md`](./docs/REVERSE_ENGINEERING_REPORT.md) for the complete reverse-engineering evidence ledger, SHA-256 digests, and provenance classification.

---

## Features

- **Bring Your Own LLM (`--base-url`, `--api-key`, `--model`)**: Works with any OpenAI-compatible endpoint (`https://api.openai.com/v1`, OpenRouter, Ollama, vLLM, DeepSeek, Groq, Together, Gemini OpenAI endpoint), native Google Gemini (`https://generativelanguage.googleapis.com`), or native Anthropic (`https://api.anthropic.com`).
- **Native Rust PDF-to-Markdown Engine (`@firecrawl/pdf-inspector`)**: Automatically converts any PDF paper into clean, position-aware Markdown (`processPdf`, `extractPagesMarkdown`, `extractTextWithPositions`) before feeding it to the LLM, and provides a standalone `deepreview pdf2md` (`pdf-inspector`) CLI subcommand.
- **Full 4-Stage PAT Pipeline (`deepreview review`)**:
  - Stage 1: Overlapping thematic page segmentation + **NeurIPS 2026 Contribution Type Classification** (`THEORY`, `EMPIRICAL_ML`, `USE_INSPIRED`, `CONCEPT_FEASIBILITY`, `NEGATIVE_RESULTS`, `SURVEY_POSITION`, `GENERAL`)
  - Stage 2: Adaptive compute budgeting (`LIGHT` / `MEDIUM` / `HIGH`) across `LOW`, `MID`, `HIGH`, and `EXTRA_HIGH` topologies
  - Stage 3: Multi-pass parallel verification + per-segment skeptical consolidation
  - Stage 4: Global synthesis, `scholar_peer` overview, **ICML Claim-to-Evidence Graph Mapping**, **NeurIPS Reproducibility & Rigor Checklist**, **High-Leverage Questions for Authors**, **ACL ARR H1–H17 Lazy-Heuristic Guardrail**, **ReviewEval Actionability Triad Audit**, and `citation_checker`
  - **Markdown Review Output**: Emits the structured Deep Review report in Markdown (`# HIGH LEVEL SUMMARY`, `## Issue Overview`, `## Claims and Evidence`, `## Reproducibility and Rigor Checklist`, `## Questions for the Authors`, `## Potential Issues And Suggestions`, `# CITATION & REFERENCE VERIFICATION`, and `# REVIEW QUALITY AUDIT`) and automatically writes `<paper>.review.md` (or `-o <path.md>`).
- **Scholarly Citation Verification (`deepreview verify-citations`)**: Extracts bibliography entries, queries **OpenAlex** and **Crossref** (`doi`, `title`, `title_author`, `autocomplete`), compares `title`, `authors`, `year`, `journal`, `volume`, `pages`, and `doi`, generates BibTeX, and classifies each reference (`OK`, `MINOR_MISMATCH`, `MAJOR_MISMATCH`, `VERIFIED_BY_SEARCH`, `NOT_FOUND`, `HALLUCINATED`, `SKIPPED`).
- **Exact Client-Side Target Algorithms**:
  - `bta` / `NN`: PDF quote-to-normalized-bounding-box (`[0, 1]`) engine using `pdfjs-dist`
  - `ata`: CSS highlight percentage converter (`min-width: 2%`, `min-height: 1.4%`)
  - `Ksa` / `Osa` / `Psa`: Comment sorting, section summary cards, and severity filter chips
  - `NK`: PDF validator & lexical `/Encrypt` stripper
- **Local Deep Review REST API v1 + Interactive Split-Pane Web Viewer (`deepreview serve`)**: Implements `/v1/documents`, `/v1/documents/{id}/reviews`, `/v1/documents/{id}:estimateReviewCost`, `/v1/documents/{id}:download`, `/v1/userQuota`, and an interactive split-pane viewer with anchored PDF bounding-box overlays.

---

## Installation

Requires [Bun](https://bun.sh) (`>= 1.1`).

```bash
git clone https://github.com/raktim-mondol/open-deepreview.git
cd open-deepreview
bun install
```

---

## Quick Start

### 1. Configure Your Desired LLM (`baseUrl`, `apiKey`, `model`)

You can persist your LLM configuration once with `deepreview config set` or pass `--base-url`, `--api-key`, and `--model` on any command:

```bash
# Example A: OpenAI or any OpenAI-compatible provider (OpenRouter, DeepSeek, vLLM, Ollama)
bun run src/cli.ts config set \
  --base-url "https://api.openai.com/v1" \
  --api-key "sk-..." \
  --model "gpt-4o" \
  --topology HIGH \
  --thinking-level HIGH

# Example B: Google Gemini (OpenAI-compatible or native endpoint)
bun run src/cli.ts config set \
  --base-url "https://generativelanguage.googleapis.com/v1beta/openai" \
  --api-key "$GEMINI_API_KEY" \
  --model "gemini-2.5-pro"

# Example C: Local Ollama / vLLM
bun run src/cli.ts config set \
  --base-url "http://localhost:11434/v1" \
  --api-key "ollama" \
  --model "qwen2.5:72b"
```

### 2. Review a Technical Paper (PDF Automatically Converted to Markdown -> Review Output in Markdown)

```bash
# Automatically converts ./paper.pdf to clean Markdown via @firecrawl/pdf-inspector,
# runs the 4-stage PAT review pipeline, and outputs the review in Markdown:
bun run src/cli.ts review ./paper.pdf \
  --base-url "https://api.openai.com/v1" \
  --api-key "$OPENAI_API_KEY" \
  --model "gpt-4o" \
  --topology HIGH \
  --prompt "Focus on Theorem 2 and experimental baselines" \
  --save-markdown ./paper.converted.md \
  -o review_report.md

# Or convert a PDF to Markdown directly using Firecrawl's pdf-inspector:
bun run src/cli.ts pdf2md ./paper.pdf -o paper.md

# Emit the full Deep Review REST API v1 JSON (with anchoredComments & PDF boundingBoxes)
bun run src/cli.ts review ./paper.pdf --json -o review_v1.json
```

### 3. Verify Citations Against OpenAlex & Crossref

```bash
bun run src/cli.ts verify-citations ./paper.pdf -o citations.md
```

### 4. Estimate Review Cost

```bash
bun run src/cli.ts estimate-cost ./paper.pdf --model gemini-3.1-pro-preview --topology HIGH
```

### 5. Inspect Google's Embedded PAT Fixture & Launch the Split-Pane Web Viewer

```bash
# Inspect the embedded "Newton's Third Law" PAT fixture recovered from module_ZZg41c.js
bun run src/cli.ts fixture

# Launch the local Deep Review REST API v1 + Split-Pane Viewer on http://localhost:8787
bun run src/cli.ts serve --port 8787
```

---

## Testing & Verification

Run the test suite and TypeScript typechecker:

```bash
bun test
bun run typecheck
```

---

## License

MIT — see [LICENSE](./LICENSE).
