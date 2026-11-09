---
name: ah-fix-findings
description: Work through findings reported by Academic Harness checks (stale numbers, unbound literals, bad citations, scope or term violations) and fix them in the text. Use when asked to fix, clean up or address the audit.
---

# Fix findings

Academic Harness on DeepSeek Harness. Native `ah_*` tools. Pi is not required.

1. Run `ah_check` (add `files` to narrow). Work through blockers, then majors, then minors.
2. For each finding read the unit it names, then fix by cause:
   - **STALE-01 / NUM-003 / NUM-004**: the number is wrong or from an old basis. Get the current value with `ah_fact`, replace the literal with `\fact{...}`, and run `ah_sweep` on the old value so no copy is left elsewhere. A hit that is a legitimate mention of the old basis ("the 62 retained after the audit") is not an error: do not change it; report it to the author as a candidate waiver.
   - **NUM-001**: a literal that should be a fact. Bind it with `\fact{...}` if a fact exists; otherwise leave it and list it for the author.
   - **BIB-01/02**: fix the key or remove the claim; never invent an entry.
   - **COH-01/02/03**: use the canonical term, a source in scope, or restore the mirrored fact.
   - **EXT-00**: an external check (numbers_audit, figure_audit, citation audit) is stale, unreadable, or was required and never ran. It is not a text problem: run `ah_external`, then `ah_audit external=use`. Never edit around it and never delete the result file to make it go away.
   - **STAT-*, FIG-*, CIT-***: findings from those external tools, with the same IDs on every run. They are candidates for review, most at minor (CIT-01 retracted, CIT-02 invalid DOI, CIT-03 concern or correction are the registry facts). Fix the manuscript or the bibliography; if the tool is wrong, list it for the author to waive. After the edit run `ah_external` again, because the edit made the stored result stale.
   - **RPT-01/02/03**: recorded reporting-guideline verdicts (from `reporting_check`). RPT-01: the manuscript lacks what the guideline item asks for; add it, then judge the item again with `reporting_check`. RPT-02: a quote recorded as evidence is gone from the text; restore the passage or judge the item again. RPT-03: the item is not assessed, or its absence claim predates your edit; judge it. Never record a verdict to make a finding disappear.
   - **RUB-01**: the frozen rubric found a defect and quoted it (the quote is checked against the paragraph). Read the quote, decide, and fix the wording if the criterion is right. Most criteria are unadmitted and report at info: they are leads, not a to-do list. If the criterion is wrong for this text, say so for the author; never edit `rubric/` and never judge a paragraph again just to get a different answer (the verdict is cached on the text, so only editing the paragraph changes it). **RUB-02**: a criteria file is malformed; report it to the author.
   - **ACR-\*, FMT-\***: format and consistency rules, advisory (info) unless the author promoted one. They are exact (`FMT-08` a repeated word, `FMT-01` a number and unit that can break across a line) but `ACR-03` (an acronym never defined) is low-precision: it cannot tell jargon from a name (a gene, a tool, a database). `ACR-01` (used before its definition, defined twice) is precise. Fix one only when the text is wrong; if the flagged form is deliberate (a system name, a technical term), say so for the author, who can waive it or add it to `style.format.acronyms_known`. Never rewrite fine text to quiet a hint, and never change `levels:` in ah.yaml. `ah_precision` shows how often the author fixed against waived each rule.
   - **PRM-01**: a rule the author promoted from a review comment matched. The message names the rule, the matched words and what is wrong; fix the wording unless the use is deliberate (then list it for the author). **PRM-02**: a promoted rule is broken (its own fixture fails or it does not compile); report it to the author, never edit `rules/`.
   - **EVD-02**: a cited number is not in the source. Check with `ah_source_search`. If the text misquotes, correct it to the source's value and condition. If the number is the review's own or derived, leave it and say so.
3. After each edit, read the harness note on the tool result; it lists what that edit introduced.
4. Never waive, never edit protected files, never lower a level. If a finding is wrong or needs a decision, `ah_decision_request`.
5. Finish with `ah_check` and report: fixed, left (with the reason for each), and what needs the author.

Fix only ledger findings. Comments from a free review (`deep_review`, `peer-reviewer`, `pre-submission-reviewer`) are exploratory: not a to-do list, never gating. Treat them as candidates for promotion: `ah_triage` shows which a rule already covers, and a recurring one a program could recognise goes to `ah_rule_propose` for the author. Never run a free review again only to check that your fixes worked; `ah_check` answers that.
