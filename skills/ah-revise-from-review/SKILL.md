---
name: ah-revise-from-review
description: Revise an Academic Harness manuscript in response to reviewer or supervisor comments, then build a response letter in which every claimed change maps to a real edit. Use when asked to address reviews, comments or a revision round.
---

# Revise from review

Academic Harness on DeepSeek Harness. Native `ah_*` tools. Pi is not required.

1. **List the items.** `ah_review` shows each numbered item with its status. If the comments are not imported yet, call `ah_review` with `action: import`, a review `id` (e.g. `R1`), and `file` pointing at the comments; the harness stores a snapshot of the text at that moment.
2. **One item at a time.** For each item decide: change the text (addressed), or explain why not (rebutted). Declining a point is the author's decision: use `ah_decision_request`.
3. **Edit only what the item concerns.** Find the units with `ah_claims`, `ah_sweep` or by reading. Edit with `edit`; the harness checks every edit. Numbers stay `\fact{...}`; claims about a paper follow `ah-write-unit`. After changing a number or term, run `ah_sweep` on the old value so no copy is left elsewhere.
4. **Map and respond.** Call `ah_review_set` with the item, the unit ids you changed (they are printed in the edit results and in `ah_check` output), `status: addressed`, and a response in the voice of the authors that says what changed and where. For a rebuttal use `status: rebutted` and give the reason and, if it applies, the unit where the text already says it. A response that says "we added..." must have a mapped unit whose text really changed, or the harness refuses it.
5. **Build the letter.** `ah_review_respond` writes it from the items and the real diffs since the snapshot. Read what it reports: items marked addressed with no change, missing responses, units that changed but belong to no item. Fix those, then build again.
6. **Report** to the author: items addressed, items rebutted (with the reason), items waiting on a decision, and anything the letter flagged.
