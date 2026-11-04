---
name: method-code-alignment
description: Use when mapping a manuscript method, equation, constant, symbol, or default value to repository code and checking whether proposed claim bindings are grounded.
license: MIT
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Method–code alignment

1. Identify the manuscript claims and the authorized repository. Extract exact, distinctive anchors for equations, symbols, constants, and defaults, keeping the manuscript location and claim id. Missing methods are gaps, not values to infer.
2. Use `repo_audit action=align` with `anchors` entries containing `kind`, `text` or `pattern`, and optionally `id`, `file`, and `claim`. This is a static scan, not code execution. A `verified` anchor is one location match; `ambiguous`, `missing`, and `not_checked` are not matches to bind.
3. Read each matched file and surrounding lines; decide whether the implementation actually supports the claim. A matching symbol or literal alone is not semantic proof. Check units, transformations, configuration overrides, and call sites where relevant.
4. In an `ah.yaml` project, hand only reviewed `bind_calls` to `ah_claims_bind`; the writing engine remains authoritative. Report each claim, source `file:line`, what was checked, unresolved anchors, skipped files, and any discrepancy. Never silently edit the manuscript or bind a guessed source.
