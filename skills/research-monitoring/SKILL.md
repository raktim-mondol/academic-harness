---
name: research-monitoring
description: Keep a literature search alive between sessions with `literature_watch` (saved queries, de-duplicated runs, Markdown digests) and find related work from a seed paper with `paper_recommend`. Use when the user wants to track a topic over time, set up alerts, catch up on what is new since last time, or expand from a few key papers without re-running the same search by hand.
allowed-tools: Read Write Edit Bash
license: MIT license
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Research monitoring

> **In Academic Harness:** `literature_watch` stores watches, what each has seen, and
> what was new, under `.dsh/watch/`. `paper_recommend` returns related papers with a
> stated reason. Neither ingests anything into PaperMemory, sends email, or runs on a
> timer: you run a watch, then read the digest.

## Choose the tool

| Need | Tool |
|---|---|
| A topic to keep checking | `literature_watch` `add`, then `run` and `digest` |
| What is due / what failed | `literature_watch` `status` |
| More papers like these | `paper_recommend` with `seed` or `seeds` |
| A one-off search | `literature_search`, not a watch |
| Follow citations of one paper | `citation_network` or `openalex_cite` |

## Setting up a watch

1. Write the query as you would for `literature_search`; test it there first. A watch
   repeats a query, so a vague one produces a vague digest forever.
2. Name the sources when the topic is narrow (biomedical → `pubmed`; preprints →
   `arxiv`, `biorxiv`). Leave `sources` unset for the auto choice.
3. Set `since` or `year_min` so the first run does not return the whole back catalogue.
4. `frequency` is advisory (`status` marks a watch due). Nothing runs by itself; run
   `run` with `due_only` at the start of a session.

## Reading a digest

- **New means unseen by this watch.** It is not relevant, high-quality, or read.
  Screen the records before relying on any of them.
- **The first run is the baseline.** Everything in it is "new"; expect a long first digest.
- **A `partial` or `failed` run names the failing source.** Do not treat a quiet week
  as no new papers until `status` shows every source answered.
- **`digest` advances the cut** so the next one shows only newer hits. Use `preview`
  to look without advancing, `all` to see every hit, and `out` to write Markdown.
- **A watch only sees what its sources return.** Top-N relevance per source is not
  exhaustive; for a systematic search use the `review` tools and record the strategy.

## Using recommendations

- **They are leads, not evidence.** Both providers are algorithmic. Cite what you read,
  not that something was recommended.
- **Read the "why".** "Shares 12 references with the seed" is measurable; "suggested by
  Semantic Scholar model (no explanation from the provider)" is only a suggestion.
- **Agreement across providers ranks higher**, citation count does not. Do not read
  citation counts as quality, and do not drop a recent paper for having few.
- **Several seeds change the result.** Semantic Scholar then recommends from all seeds
  together, which suits a topic; one seed suits "more like this paper".
- **Library duplicates are removed only if the library was reachable.** The result says
  when it could not be checked.

## Failure states

`not_found` (seed unknown to a provider), `not_supported` (identifier type a provider
cannot use), `provider_blocked` (rate limit — retry later), `error`. A provider that
fails is reported by name; the other still answers.
