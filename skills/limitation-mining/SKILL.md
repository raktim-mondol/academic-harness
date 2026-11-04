---
name: limitation-mining
description: Use when identifying and recording checkable methodological limitations with source quotes, remedy families, coverage, and a bounded sufficiency review in a co-scientist tournament.
license: MIT
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Limitation mining

Identify a specific methodological weakness, not a generic complaint or an invented quote. Use `co-scientist-tournament` for the wider tournament and its `references/briefs.md` for the limitation-mining brief.

1. Read the named hypothesis or workspace source and locate a verbatim quote. Explain why that actual passage limits the method and propose at least two distinct remedy families. Separate the author's statement from your interpretation; report unavailable source text rather than guessing.
2. Record it with `coscientist action=limitation limitation_action=add slug=<tournament> flaw=<flaw> why=<reason> quote=<verbatim> source=<hypothesis-id-or-workspace-file> opportunities=[...]`. The source must contain the quote. Do not rewrite a prior limitation; append a new one when refining it.
3. Record the caller's reasoned sufficiency reading with `limitation_action=verify limitation_id=<id> limitation_verdict=sufficient|insufficient reason=<reason>`. Respect the configured round cap; `exhausted` is not sufficient.
4. Use `limitation_action=status` to report coverage, uncovered limitations, and ideas addressing none. When adding a proposed idea, link existing limitation ids with `addresses_limitation`; do not claim a limitation is addressed merely because it was logged.
5. Preserve open questions and uncertainty for the human decision. A recorded quote or coverage link is not proof that a remedy works.
