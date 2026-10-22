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
   - **EVD-02**: a cited number is not in the source. Check with `ah_source_search`. If the text misquotes, correct it to the source's value and condition. If the number is the review's own or derived, leave it and say so.
3. After each edit, read the harness note on the tool result; it lists what that edit introduced.
4. Never waive, never edit protected files, never lower a level. If a finding is wrong or needs a decision, `ah_decision_request`.
5. Finish with `ah_check` and report: fixed, left (with the reason for each), and what needs the author.
