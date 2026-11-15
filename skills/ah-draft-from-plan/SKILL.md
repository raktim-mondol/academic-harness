---
name: ah-draft-from-plan
description: Turn an approved Academic Harness outline's literature searches, citation hints, and figure plan into sources and images. Use after ah_author plan-approve when the outline carries that draft contract, and before ah-write-unit writes the prose.
license: MIT
---

# Draft from the approved plan

Academic Harness on DeepSeek Harness. Native `ah_*` tools. Pi is not required.

Run this only after `ah_plan` `action: show` reports outline status `approved` and the outline carries literature, citation hints, or figures. You cannot approve a plan. If the status is still `draft` or a proposal is pending, stop and send the author to `ah-plan-section`.

1. Call `ah_plan` with `action: queries`. Each row is one `literature_search`. Pass `year_max` when the row has one. Drop a hit whose full date is after `cutoff`. Keep a hit with no date and say the date is unknown.
2. A hint that carries `title` may be registered when one result title matches that title. Registration is `paper_download` or a file the user already has, then `ah_source` `action: add`. A title with no match is reported. It is not written into the bibliography from memory.
3. Introduction and related-work searches are listed. The author says which records to keep before any `ah_source` add. Approving the plan approves the queries, not every paper a search returns.
4. Run `citation` with `action: audit` on the bibliography those sources produced.
5. Figures. A plot reads `experiment_log` for the named slug and takes only those metrics. A missing slug stops that figure. A diagram is drawn with `mermaid_render` or `image_generate` and carries no invented numbers. Images go under the project's `figures/`.
6. Stop. `ah-write-unit` writes the prose. After `ah_build`, offer `deep_review`. Do not rewrite the TeX from a review score.

## Outside an ah.yaml project

This skill is active only inside an Academic Harness project.
