---
name: ah-write-unit
description: Write or rewrite a paragraph, table or figure in an Academic Harness LaTeX project so that every number, citation, term and planned claim passes the project's checks. Use whenever you add or change prose in a project that has an ah.yaml.
---

# Write a unit

Academic Harness on DeepSeek Harness. Native `ah_*` tools. Pi is not required.

A unit is one paragraph, float or display. The harness checks every edit by code. Follow this order so the edit passes the first time.

1. **Plan.** If the task names a new file, call `ah_plan` with `action: show`. When that file is absent from the outline and no approved brief names it, propose the outline change (skill `ah-plan-section`) and stop. Write the file only after the author has approved the outline, or after an approved brief names that file.
2. **Find the brief.** If the task names a brief, or the unit has one (`Briefs:` line in the paper state), call `ah_pack` with its id. The pack holds the brief, where the unit sits (what comes before and after), the facts to use with their values, and source passages with locators for each planned claim. If there is no brief and the unit matters (a new paragraph that makes claims), draft one with `ah_brief_new` and tell the author it needs approval; write the prose after it is approved, or when the author says to write now.
3. **Numbers.** If a number comes from the project's data, write `\fact{id}` or `\fact{id.variant}`, never the value. `ah_fact` lists them. If you need a number no fact defines, call `ah_fact_propose` with the data it should come from and why, then stop that thread: the author accepts or rejects it. Do not type the number meanwhile.
4. **Claims about a paper.** State only what the pack's passage says, with its condition: dataset, measure, population, "only on the external set". The quoted span is the part of the source that matches the claim; it may sit in the middle of a long methods block. If a source has no text in the pack, do not write a finding about it. Put the citation right after the clause it supports, one citation group per clause.
5. **What the brief forbids.** Respect `must_not` and the hedging level. Descriptive means describing what was reported, not proving; tentative means hedged. Use the canonical terms from the brief and the Terms line.
6. **Structure.** Keep every `%% @unit ...` line with its paragraph. A new file needs an `\input` from its section's index. Put `\label{...}` right after its heading or caption.
7. **Edit with `edit`** on the smallest range. After each edit the harness appends the findings that edit introduced to the tool result. Fix them in the text.
8. **Bind your claims.** When the paragraph is written, call `ah_claims_sync`, then `ah_claims_bind` with `auto: true` for each cited claim, and read the quote it captured: if the passage does not say what you wrote, rewrite the sentence. Binding records evidence; only the author verifies.
9. **Done** means no new blocking finding and the brief's findings clear. You cannot waive findings, approve briefs, or approve outline plans. If an instruction forces a violation, call `ah_decision_request` and stop.
