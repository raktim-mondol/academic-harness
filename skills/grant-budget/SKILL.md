---
name: grant-budget
description: Build a multi-year grant budget and justification with the `grant_budget` tool — personnel effort/fringe/escalation, equipment, supplies, travel, publication, subawards, cost share, indirect rates and caps — with arithmetic checks and CSV/Markdown/JSON/XLSX export. Use when preparing a proposal budget or checking one.
allowed-tools: Read Write Edit Bash
license: MIT
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Grant Budget

> **In Academic Harness:** `grant_budget` keeps an append-only input ledger and a
> stored computation under `.dsh/budget/<slug>/`. It checks arithmetic and the
> caps you state; it does not decide allowability, eligibility, or what a
> funder will pay.

## Build the budget

1. **Collect explicit rates.** Salary bases, effort (0–1) or person-months,
   fringe rate, escalation, indirect rate, and any caps must come from the
   institution or funder. A missing fringe or indirect rate is an error, not a
   zero. Currency is a label; set it.
2. **Record line items.** `start` with `personnel` and `equipment`, `supplies`,
   `travel`, `publication`, `other`, `subawards`, and `cost_share`. A line item
   can apply every year, to one `year`, across `start_year`/`end_year`, or as
   explicit `years` amounts. Equipment and subawards are excluded from the
   indirect base unless `include_in_indirect_base` is true.
3. **Compute.** `compute` writes the multi-year table, indirect base, totals,
   per-person detail, flattened line items, arithmetic checks, and a
   justification. `failed_checks` names caps or arithmetic that do not hold;
   fix the inputs and recompute. A changed input makes the old computation
   stale and export refuses it.
4. **Check the caps and rules.** `indirect_rate_max` and `total_max` are only
   the caps you supplied. Funder-specific exclusions, salary caps, cost-share
   rules, and indirect-base definitions remain manual review.
5. **Export and review.** CSV, Markdown, JSON, or XLSX. Read the justification:
   it is assembled from your labels and notes, not invented prose.

## Guardrails

- No invented rates, salaries, eligibility, or funder rules.
- Cost share is reported separately, not folded into the requested total.
- The arithmetic check is not a funder audit or a financial-system import.
- Keep the ledger with the proposal so a later revision has its basis.
