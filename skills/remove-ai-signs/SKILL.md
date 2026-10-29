---
name: remove-ai-signs
description: Detect and remove signs of AI writing from text (prose, LaTeX, Markdown), based on Wikipedia's "Signs of AI writing". Scans for AI vocabulary clusters, superficial -ing clauses, negative parallelisms, rule-of-three rhythms, copula avoidance, hedging boilerplate, chatbot residue, and formatting tells; then rewrites affected passages while preserving meaning, numbers, citations, and register. Use when asked to remove AI signs/tells, de-AI or humanize text, make writing "not sound like ChatGPT", scrub AI-isms, or on files matching /remove-ai-signs.
argument-hint: <file-or-directory> [more paths...]
---

# Remove AI Signs

> **When:** after a draft or chapter exists. This is a post-draft editing
> pass — do not run it at the start of a writing task or on an outline. Write
> the draft first, then scan and edit it.

## Overview

Sweep the given files for machine-writing tells, then rewrite only the
flagged passages. The taxonomy and fix recipes live in
`references/signs.md` (read it before editing). The deterministic first pass
is `scripts/scan_ai_signs.py`.

## Related Supervisor-Skills

For broader academic polish (grammar, claim calibration, translation), use `paper-polish`; this skill remains the mechanical AI-tone scanner and rewriter within that pass.

## Workflow

1. **Scan.** Run the scanner on the target paths (files or directories;
   `.tex`/`.md`/`.txt`):
   ```bash
   uv run python skills/remove-ai-signs/scripts/scan_ai_signs.py PATH... --top 5
   ```
   The scanner is standard-library only; use `python3` directly if `uv` is
   unavailable.
   It masks code/verbatim/math before counting, reports per-pattern hits with
   densities and line numbers, plus em-dash density and sentence-length
   variance. Save the output as the BEFORE report.

2. **Triage with judgment.** Open `references/signs.md` next to each hit.
   Decide per occurrence: real tell, legitimate technical usage
   ("mass, momentum, and energy"; "marks a matrix"), or density too low to
   matter. Density, not presence, justifies change. One "robust" in 3k words
   stays; a cluster of "pivotal… testament… showcase… vibrant" in one
   paragraph goes.

3. **Rewrite.** Fix the sentence, not the word:
   - Delete puffery or replace it with the concrete fact that earns it.
   - Cut ", highlighting/underscoring/showcasing…" tails or make them real
     sentences.
   - Break "not only X but also Y" into a direct assertion of Y.
   - Collapse adjective triples to the one that carries information.
   - Replace "serves as/represents/constitutes" with "is" when nothing is lost.
   - Remove chatbot residue ("Let's…", "As of 2024…", "no reliable sources",
     `[1]`/`oaicite`/`[cite: 1]`, emoji, `**bold:**` bullet outlines,
     Markdown in LaTeX).
   - Vary rhythm where it is uniform: merge choppy parallel sentences, split
     periodic ones; raise the sentence-length standard deviation.
   - NEVER alter: numbers, claims, citations, code, math, verbatim quotes,
     technical terms that merely collide with a tell list, or the document's
     register.

4. **Re-scan and report.** Run the scanner again on the same paths. Present a
   compact before/after table (per file: hits by category, em-dash density,
   sentence sd). Explain any hit deliberately kept.

## Guardrails

- Edit only prose the user pointed at; this is a surgery, not a rewrite of
  untouched material.
- If a flagged sentence's claim cannot survive the de-AI phrasing honestly
  (e.g. a vague attribution with no citable source), do not paper over it —
  list it under "needs your decision".
- For LaTeX books/projects, rebuild the document after editing if a build
  system exists, and check the log for newly introduced bad line breaks.
- Over-correction is failure: monotone simple sentences are their own tell.

## Resources

- `references/signs.md` — full taxonomy with examples and fixes (read before editing).
- `scripts/scan_ai_signs.py` — deterministic scanner; stdout is a compact report; `--top N` caps examples.
