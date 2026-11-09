# Live test plan: the writing compiler (phases 0–6)

What to look for when you run the writing checks for real, on a real manuscript, with a real model and the real registries. The automated tests (234 engine tests, 103 JS test files) use fakes: a stub model, hand-written external results, a faked network. They prove the code does what it says. They cannot show that the checks are *useful*, that the real services behave as assumed, or that an agent in a real session uses the tools correctly. That is what this plan is for.

Nothing here has been run against a real hosted model, a live Crossref/OpenAlex, a real `deep_review` round, or a long agent session. Treat every "expected" below as a hypothesis, and record what you actually saw.

Design background: [WRITING.md](WRITING.md) (what each tier does) and the plan it implements ("a writing compiler": the same text gives the same findings, so a fix loop converges).

## 0. Ground rules

- **Test instance only.** Use a separate DSH instance on its own port. Never your everyday instance on `:3080`.
- **Work on a copy.** Copy the manuscript into a scratch folder and run everything there. Keep the original untouched. Several steps edit the text.
- **Use two manuscripts.** One small LaTeX project you know well (you can predict most findings), and one real draft (a proposal or paper, 5+ files, 20+ citations) for realism. Findings you can predict tell you whether the tool is right; findings on the real draft tell you whether it is useful.
- **Record cost.** For every step that calls a model, write down the model, the number of calls and the tokens (the report prints them). Phase 4 and Phase 6 `judge` runs cost money.
- **Keep a log.** Copy the template in section 12 for every scenario. A scenario with no recorded observation did not happen.
- **Do not skip the negatives.** For each check, find a case where it *should not* fire and confirm it does not. False positives are how a gate becomes noise.

### Setup

1. Create a scratch project. Either `ah_init` with a profile (`paper/conference`, `paper/journal-empirical`, `grant/proposal`, `thesis`) or `ah_migrate` on a copy of your tree (dry-run first, then `apply` with `confirm`).
2. `ah_units` to give each paragraph a stable `%% @unit` anchor. **Do this before measuring anything.** Without anchors, editing a paragraph changes the finding's identity and the ledger cannot tell "fixed" from "moved".
3. Add a `verifier:` section to `ah.yaml` for the model-backed steps (`backend: http` is the one that sends temperature 0; `pi` cannot set it). Pick one model and keep it for the whole test; changing the model on purpose is its own scenario.
4. Run `ah_audit` once to create the ledger. Note the report hash.

### What "pass" means for this whole exercise

Not "no findings". The writing compiler passes live testing when:

1. The same text gives the same findings, every time, across sessions and restarts (S1).
2. A fix loop converges: fix what the ledger lists, re-run, and the list gets shorter and stops (S12).
3. Nothing the checks report needs a human to say "that is wrong" more often than it is right, for any rule that can gate.
4. Everything that could not be checked says so, instead of looking like a pass (S10, S11).
5. An agent working in the real UI follows the rules: fixes ledger findings, does not self-approve, does not re-run reviews to see whether fixes worked (S13).

---

## 1. Phase 0: stability (S1)

**Goal:** the checks give identical findings on unchanged text.

| Step | Do | Expect |
|---|---|---|
| 1.1 | `ah_audit stability_runs=5` on the small project | Every code tier at overlap 1.0; no findings "come and go"; no unanchored paragraphs listed (you ran `ah_units`); exit status 0 |
| 1.2 | Same on the real draft | Same. If anything moves, copy the finding's check ID and fingerprint into the log: that is a determinism bug |
| 1.3 | Remove the anchors from one section (copy only), re-run | The tool reports the paragraphs without a stable anchor. This is the intended warning |
| 1.4 | Run `ah_audit` twice with no change | Same `report_hash`; the second run reports 0 new, 0 fixed |
| 1.5 | Restart the DSH instance, repeat 1.4 | Same hash. A different hash after a restart means something depends on process state or time |
| 1.6 | Make one edit to one paragraph, re-run | Only findings in that paragraph (and document-level checks that depend on it) change; fingerprints of everything else are identical |

**Look for:** any non-determinism you can reproduce (dictionary order, timestamps, locale, line endings). Try a file saved with CRLF endings and one with a trailing-space change.

---

## 2. Phase 1: frozen registry lookups (S2)

**Goal:** Crossref/OpenAlex answers cannot change the findings between runs, and a network failure is never a finding.

| Step | Do | Expect |
|---|---|---|
| 2.1 | `citation action=audit` on a bibliography with 20+ entries (include 2 you know are wrong: a made-up DOI, a title that differs from the DOI's record) | Findings for the wrong ones; the output says "Lookups: as of <date> (N fetched, N reused...)"; `.ah/cache/lookups.json` now exists |
| 2.2 | Run it again immediately | 0 fetched, all reused; identical findings in the same order |
| 2.3 | Disconnect the network (or block the two hosts) and run again | Identical findings. No new finding appears because of the outage |
| 2.4 | With the network still down, audit a **new** reference never seen before | It is reported as unverified, not as "DOI not registered". A timeout must never become a finding |
| 2.5 | Reconnect, pass `refresh_lookups: true` | Answers are fetched again; if something upstream changed, the finding changes and the ledger names the refresh as the cause (`evidence-changed`), not `UNEXPLAINED` |
| 2.6 | Do the same through `integrity_check` | Same behaviour; they share the snapshot |
| 2.7 | Hand-edit one entry's `fetched_at` to 40 days ago and run with default age | That entry is fetched again (default 30 days); the others are reused |
| 2.8 | Set `lookup_max_age_days: 0` | Nothing expires |
| 2.9 | Run two citation audits at the same moment (two sessions) | The snapshot file is not corrupted (it merges, newer wins) |
| 2.10 | Make the snapshot file unreadable (`{not json`) | A clear message; the audit does not crash and does not silently pass |

**Look for:** a retracted paper. Pick a reference you know was retracted recently and confirm it shows as retracted after a refresh, **and** confirm what you see *before* a refresh if the snapshot is older (the documented limit: a retraction last week is invisible until the entry is refreshed). Decide whether the 30-day default is acceptable for you.

**Look for:** `mailto` or API keys in `.ah/cache/lookups.json`. They must not be there. Search the file.

---

## 3. Phase 2: external tools in the ledger, tier TX (S3)

**Goal:** `numbers_audit`, `figure_audit`, the citation audit and `reporting_check` give findings with IDs, fingerprints and ledger states, and a stale result is reported instead of reused.

Prerequisites: SciPy and Pillow installed for the numbers and figure tools; a manuscript with a figure folder; for the reporting step, a `reporting_check` run recorded for the manuscript.

| Step | Do | Expect |
|---|---|---|
| 3.1 | `ah_external action=plan` | Lists each tool and the files it would read |
| 3.2 | `ah_external action=run` | Per-tool summary; files in `.ah/external/*.json` with input hashes |
| 3.3 | `ah_audit external=use` | `STAT-*`, `FIG-*`, `CIT-*`, `RPT-*` findings appear with ledger states; the report says each tool is `fresh` |
| 3.4 | Plant a p-value that disagrees with its test statistic (`t(28) = 2.1, p = 0.9`) | `STAT-01` on that paragraph |
| 3.5 | Plant a mean/N pair that GRIM rejects (needs `grim: true`) | `STAT-02` |
| 3.6 | Add a 72-DPI image | `FIG-01`; a duplicated image gives `FIG-02` |
| 3.7 | Edit the paragraph so the p-value is right, **do not re-run** `ah_external`, then `ah_audit external=use` | `EXT-00` (stale), major. The old `STAT-01` is **not** marked fixed: it is carried. This is the most important TX behaviour |
| 3.8 | Re-run `ah_external`, audit again | `STAT-01` is fixed; `EXT-00` gone |
| 3.9 | Move the planted paragraph down by adding text above it | The fingerprint of `STAT-01` is unchanged (no line numbers in keys) |
| 3.10 | Delete a result file, with the tool listed under `external: {required: [...]}` in `ah.yaml` | `EXT-00` for a required-but-missing result |
| 3.11 | Corrupt a result file (truncate it) | `EXT-00` "unreadable", no crash |
| 3.12 | Run `ah_external` with SciPy uninstalled | An error for that tool, **not** an empty result that looks like a pass |
| 3.13 | Run `ah_audit external=run` | Runs the tools first, then audits; the output starts with what was run |

**Look for:** (a) false positives from `numbers_audit` on prose that merely mentions "p" or "t"; (b) the cross-section total check: the same N written differently in two sections (`N=95` in Methods, `N=120` in Results) is reported once, attributed to the first mention; (c) how long `ah_external run` takes on a large manuscript and whether the 120 s default is enough.

---

## 4. Phase 3: format and consistency rules (S4)

**Goal:** the thirteen rules (`ACR-01/02/03`, `FMT-01..11`) are exact where they claim to be, and honest about where they are not. All are at **info**, advisory; none gates unless the author promotes it.

The held-out evidence from the build was small (two unseen proposals, 45 findings, 25 right). Seven rules never fired on that text, so for them **you are the first test**. Spend the most effort here.

For each rule, make a text where it should fire and a near-miss where it should not, then run it on the real draft and judge every finding yourself as right or wrong.

| Rule | Should fire | Should not fire |
|---|---|---|
| `ACR-01` | an acronym used before its definition; one defined twice | "Long short-term memory (LSTM)"; "eXplainable AI (XAI)" (definitions with letters inside the words) |
| `ACR-02` | defined, then never used again | defined and used once more |
| `ACR-03` | an unexpanded jargon acronym | a gene, tool, database or hardware name (KRAS, KEGG, RTX); an ID like `PRF-03`; a name in a bibliography title |
| `FMT-01` | `5 ms` with a plain space | `5~ms`, `\SI{5}{ms}`, `\qty{5}{ms}` |
| `FMT-02` | `%` and "percent" both used | only one form |
| `FMT-03` | `\cite` mixed with `\citep` | `\cite` mixed with narrative `\citet` (normal natbib) |
| `FMT-04` | citation before the full stop in some places, after in others | consistently one way |
| `FMT-05` | a table or figure never referred to; referred to only after it appears (if the profile requires) | a float referred to once, before it |
| `FMT-06` | heading capitalisation that disagrees with the declared style | headings in the declared style |
| `FMT-07` | "color" and "colour" both used | one variety throughout |
| `FMT-08` | "the the" | "that that" in a legitimate sentence |
| `FMT-09` | "dataset", "data set", "data-set" mixed | one form |
| `FMT-10` | "e.g." with a comma in some places and not others | consistent |
| `FMT-11` | a sentence over the limit | a long sentence under it; a list in an `itemize` |

Then:

1. **`ah_precision`.** Fix some findings and waive others (as the author, with `ah_author action=waive`), then run `ah_precision`. Check the fixed-versus-waived counts and the precision estimate match what you did. Check it says "not enough decisions" until you have ≥10 for a rule.
2. **Agent noise.** In a live agent session, edit a paragraph so it adds an undefined acronym. The agent's post-edit note must **not** mention `ACR-*`/`FMT-*` (they are filtered), but `ah_audit` must list them.
3. **Reading order.** Put the acronym definition in a section that is `\input` first but has a later file name. `ACR-01` must follow LaTeX order, not file-name order.
4. **Prose the rules skip.** Acronyms defined in the main file's own paragraphs, in a caption, in a table: no false "undefined".
5. **Level control.** Raise one rule to `minor` or `major` in `ah.yaml` (`levels:`), confirm it can gate, then put it back.

**Look for:** the *ratio* of right to wrong per rule on your text. Write it down. Any rule below ~0.8 precision on your text should stay at info; any above ~0.9 over 10+ decisions is a candidate to promote. `ACR-03` is expected to be the noisiest.

---

## 5. Phase 4: the frozen rubric, tier TR (S5, needs a real model)

**Goal:** yes/no questions about one paragraph, answered by a model, each "yes" backed by a verified quote, cached so unchanged text is never asked twice.

Prerequisite: `verifier:` configured. Use `backend: http` and set the model explicitly. Note the number of paragraphs and criteria first: calls = paragraphs in scope × criteria.

| Step | Do | Expect |
|---|---|---|
| 5.1 | `ah_rubric action=list` | The criteria for your profile (`core`, plus `empirical` or `grant`), none admitted |
| 5.2 | `ah_rubric action=run judge=true judge_limit=10` | At most 10 calls; the rest are "not judged (carried)" |
| 5.3 | Run the same again | **0 model calls**, identical verdicts. If the second run makes calls, the cache key is unstable. Stop and record it |
| 5.4 | Edit one paragraph, re-run | Exactly that paragraph is judged again (one call per criterion in scope); the rest are cached |
| 5.5 | Restart the instance, re-run | Still 0 calls: the cache is on disk |
| 5.6 | Read every "yes" and its quote | The quote is a real excerpt of the paragraph. A "yes" without a verifiable quote must show as `unverifiable`, not a finding |
| 5.7 | Plant a paragraph with an obvious defect for `RUB-CAUSAL` ("X causes Y" where the text only shows a correlation) and a clean paragraph | Yes on the first with a quote, no on the second |
| 5.8 | Judge the same paragraph through a different model | A different cache entry: everything is re-judged, and any admission is void |
| 5.9 | Break the network or the model endpoint mid-run | The affected pairs are `unjudged` and carried, never closed. A failed call must not turn an open finding into "fixed" |
| 5.10 | Reword a criterion in `rubric/*.yaml` | The ledger cause is `rubric-changed`; the paragraphs are re-judged |
| 5.11 | Malform a criteria file | `RUB-02`, not a crash |
| 5.12 | `ah_audit rubric=true` (no `judge`) | Reports cached verdicts only; **no model calls** |

### Admission (this is where the rubric earns the right to gate)

1. `ah_rubric action=sheet criterion=RUB-GENERAL limit=40` produces a labelling sheet.
2. Label ≥ 20 paragraphs yourself, with ≥ 5 `yes` and ≥ 5 `no`, **without looking at what the model said first**.
3. `ah_author action=rubric-admit id=RUB-GENERAL file=labels.yaml` (a human act; the UI should ask you to confirm).
4. Read the kappa, precision and recall. Admission needs kappa ≥ 0.6 and precision ≥ 0.8.

Questions to answer: Does the model agree with you? On what kind of paragraph does it disagree? Is a criterion that passes admission also useful on paragraphs you did not label? After admission change the model name in `ah.yaml`: the admission must go void and findings must fall back to info.

**Look for:** (a) model replies that are not valid JSON; (b) quotes that are paraphrases (must be rejected); (c) a model that says "yes" to everything; (d) temperature: confirm the request really sends 0 for the `http` backend; (e) wall time and cost for the whole document.

---

## 6. Phase 5: free reviews are exploratory; promote to rule (S6)

**Goal:** a free review (`deep_review`, `peer-reviewer`) never decides "done", and a recurring comment can become a rule that is checked every time.

| Step | Do | Expect |
|---|---|---|
| 6.1 | Run `deep_review` on the copy (cost: several minutes and model calls; confirm the scope first) | The summary ends with "Exploratory, never gating..." |
| 6.2 | `deep_review action=show section=comments` | The same label at the end |
| 6.3 | `ah_triage source=deep_review deep_review_key=<key>` | Each comment tagged `covered-by:<check>`, `same-unit:<check>` or `exploratory`. No model call. Run it twice: identical |
| 6.4 | Read each `covered-by` tag | Does the named check really address the comment? Record every wrong link. The tag is a lookup (same paragraph, shared word), so wrong links are expected sometimes |
| 6.5 | Read each `exploratory` comment | Could a program recognise this? Most cannot (a weak argument, a missing baseline). That is correct |
| 6.6 | Pick a comment about a fixed phrase ("a later section", "it is well known that") and `ah_rule_propose` a pattern with the exact span and one or two negative sentences | A proposal that prints where the pattern fires today; **nothing is checked yet** (`ah_audit` shows no `PRM-01`) |
| 6.7 | Try a bad proposal: a pattern that matches almost everything; a span that is not in the manuscript; one that matches your negative | Each is refused with a reason |
| 6.8 | Let the agent try `ah_author action=accept` without you asking | It must not. If the UI lets an agent accept unprompted, that is a security finding |
| 6.9 | Accept it yourself (`ah_author action=accept id=PRM-...`) | `rules/promoted.yaml` exists; `ah_audit` now lists `PRM-01` at info; the agent cannot edit `rules/` or `rubric/` |
| 6.10 | Fix the phrase, re-audit | The finding is fixed in the ledger |
| 6.11 | `ah_rule_propose kind=criterion` with a yes/no question | Joins the rubric at info until admitted (section 5) |
| 6.12 | Import a reviewer file with `ah_review action=import` | Each item is tagged on import |
| 6.13 | Hand-edit `rules/promoted.yaml` so a fixture fails | `PRM-02`, major; the broken rule is not half-applied |
| 6.14 | Run `deep_review` a second time on the **unchanged** text and `deep_review action=compare` | Expect reviewer variance (the build saw 9 closed and 6 opened on an unchanged manuscript). This is the problem the ledger solves; record the numbers |

**Look for:** a promoted pattern that turns out to be noisy on the next chapter. `ah_precision checks=["PRM-*"]` should show fixed versus waived after some use. Decide whether `info` is the right permanent level.

---

## 7. Phase 6: one answer, `ah_done` (S7)

**Goal:** pass / fail / incomplete with the deciding component, and "incomplete" never mistaken for a pass.

| Step | Do | Expect |
|---|---|---|
| 7.1 | `ah_done` on a project with an unresolved blocker | `FAIL`, component `findings` names the check IDs; exit 1 |
| 7.2 | Fix everything blocking; `ah_done` | `PASS` only if nothing else is unchecked; exit 0 |
| 7.3 | Run `ah_external` so results exist, then call `ah_audit` **without** `external=use` | The audit text's trailing `done:` line shows the external component as not checked; `ah_done` itself reads the results and is current |
| 7.4 | Admit a criterion (section 5), then `ah_done` with no cached verdicts for some paragraphs | `INCOMPLETE`, component `rubric`: "N paragraphs have no verdict". Not a pass |
| 7.5 | `ah_done judge=true` | Judges the missing ones (model calls); then `PASS` or `FAIL` |
| 7.6 | An admitted criterion at `minor` that fires | `FAIL` on `rubric` even though the old gate (blocker/major only) passes |
| 7.7 | Make the registry snapshot older than the limit (edit `fetched_at`) | `FAIL` on `lookups` with the age; a refresh fixes it |
| 7.8 | No snapshot at all | `lookups` is "not checked"; overall `PASS` unless `done: {require: [lookups]}` is set, then `INCOMPLETE` |
| 7.9 | `ah_check files=<one file>` | No `done` in a narrowed view |
| 7.10 | The paper-state card at the start of a turn | A `Done:` line that matches `ah_done` |
| 7.11 | Exit codes from the CLI: 0, 1, 3 | As stated; check that the UI shows incomplete as a non-success, not as an error |

### The stop gate (the agent's turn)

1. **Baseline and new findings.** Start a turn, let the agent edit a paragraph so it introduces a major finding, and try to end the turn. The stop hook must block, name the finding, allow up to `max_loops` attempts, then hand off.
2. **External tier in the hook.** In a project with external results, an edit that introduces a `STAT-01`-class finding is not possible to see until `ah_external` re-runs, so the hook cannot block on it. Confirm the agent is not blocked on `EXT-00` (documented: it is left to `ah_done`).
3. **Admitted rubric in the hook.** With an admitted criterion at `major` and cached verdicts, an agent edit that makes the cached verdict "yes" on an *unchanged* paragraph cannot happen. An edit to a new paragraph has no verdict, so the hook sees nothing unless `gate: {judge_touched: true}`. Turn it on, make the agent write a defective paragraph, and confirm the stop gate catches it and the cost is only the touched files.
4. **Noise.** Unadmitted rubric hints (info) and format rules must not appear in post-edit notes.

---

## 8. Cross-cutting scenarios

### S8. Provenance of a finding across edits (the ledger)

1. Take a finding. Move its paragraph (add text above). Same fingerprint, no new finding.
2. Fix it. State `fixed`. Reintroduce it. State `regressed`.
3. Waive it as the author with a reason. It stops counting; the waiver shows in the ledger.
4. Every new finding has a cause. **`UNEXPLAINED` must never appear.** If it does, copy the report and the previous run's manifest into the log.

### S9. Version bumps

Update the engine version (or bump `RUBRIC_VERSION`) on a project with an existing ledger. New findings caused by the bump are labelled `rubric-changed`, not `UNEXPLAINED`. Existing findings keep their fingerprints.

### S10. Everything that cannot run says so

For each, confirm the output is a clear statement and **not** a silent empty result or a pass:

- no `verifier:` section and `judge=true`
- model endpoint down
- no SciPy, no Pillow
- no network during `ah_external`
- no LaTeX build
- project without `ah.yaml` (tools return "not a project")
- `.ah/` read-only

### S11. Optimistic-pass hunt

Deliberately build situations where a naive reading would say "done" and check the tool refuses:
- external results exist but are not read
- admitted criteria with no verdicts
- registry snapshot 60 days old
- a required external tool never run
- a rubric run capped by `judge_limit` that left most paragraphs unjudged

### S12. Does the fix loop converge? (the headline test)

On the real draft:

1. Baseline: `ah_audit` (with `external=use`, `rubric=true`). Record the count by level.
2. Ask the agent (in the UI) to "fix the audit findings", with `ah-fix-findings` loaded.
3. After it stops, run `ah_done` and `ah_audit`. Record the new count.
4. Repeat up to 5 rounds **without adding any free review**.
5. Plot findings against round. A compiler-like loop goes down and ends at zero or a short list of waivers. If it oscillates, a fix creates a new finding, or the agent "fixes" by weakening claims, record exactly what happened.
6. Then run a free `deep_review` on the result. How many of its comments are `covered-by` a check? How many are new? That is the measure of what the compiler still misses.

### S13. Agent behaviour in the real UI (with agent-browser)

Drive the test DSH instance through its web UI. For each, record whether the agent behaved:

- Does not call `ah_author` unless you asked in that message.
- Does not edit `rules/`, `rubric/`, `ah.yaml`, `sources/`, the ledger. The write should be blocked.
- Does not re-run `deep_review` just to see whether fixes worked; uses `ah_check`/`ah_done`.
- Treats `PASS` / `INCOMPLETE` correctly in its summary (does not report incomplete as done).
- Uses `\fact{}` for numbers; does not invent citations.
- When `ah_done` says `rubric: no verdict`, it asks you before `judge=true` (model calls), instead of spending silently.
- Handles the hook hand-off after `max_loops` by reporting, not looping forever.
- Long session: the paper-state card and the done line stay in sync after context compaction.

### S14. Concurrency and robustness

- Two sessions auditing the same project: the ledger and the snapshot do not corrupt (watch for "database is locked").
- Very large manuscript (50+ files): time for `ah_audit`, `ah_audit stability_runs=3`, `ah_done`. Record seconds.
- Unusual LaTeX: `\input` chains, `\include`, macros that wrap paragraphs, `\newcommand` heavy preambles, a bilingual document, an `\iffalse` block. Do units and rules behave?
- Non-ASCII text (accents, Greek letters, CJK in a bilingual paper): the prose view and the quote check must not mangle or reject.
- Windows line endings; a file with a BOM.

---

## 9. What to measure and keep

| Measure | How | Why it matters |
|---|---|---|
| Stability | S1 overlap, repeated across days | The foundation |
| Precision per rule | right / (right + wrong) on your text, from `ah_precision` | Decides what may gate |
| Rubric agreement | kappa and precision at admission; later spot checks on unlabelled paragraphs | A criterion that passed on 20 labels may fail on the rest |
| Model cost | calls and tokens for first judging, a re-run, and one edit | Whether judging is affordable in a loop |
| Cache hit rate | calls on the second run (should be 0) | Determinism claim |
| Loop convergence | findings per round (S12) | Headline claim |
| Coverage of free review | share of `deep_review` comments `covered-by` a check | What the compiler still misses |
| False "done" | any `PASS` you later disagree with | The worst failure |
| Time | seconds per tool on the real draft | Usability |

## 10. Known weak spots to probe on purpose

These are limits the build already knows about. Push on them so you learn how bad they are.

1. **`ACR-03`** cannot tell an unexpanded acronym from a name. 10 of 30 right on held-out text.
2. **Seven format rules** have no held-out evidence at all (`FMT-01/02/04/06/08/10/11`).
3. **Triage tags** are a lookup (same paragraph, shared word). `covered-by` can be wrong; `same-unit` is a lead, not a match.
4. **Promoted patterns** are checked against one sentence and your negatives, not a labelled set.
5. **Rubric judges one paragraph at a time.** A defect that spans paragraphs is invisible to it.
6. **Registry answers** can be 30 days old: a recent retraction is invisible until a refresh.
7. **Admission is on your labels.** 20 labels is a thin basis; a criterion can pass and still be wrong on a different section.
8. **The `pi` backend cannot set temperature 0**, so its verdicts can differ run to run (with `--no-cache`, visible as `evidence-changed`).
9. **LaTeX only.** Markdown/Word/PDF are out of scope; confirm the tools say so cleanly on a non-LaTeX project.
10. **`EXT-00` in the stop gate** is left out on purpose; confirm you are comfortable that an agent can finish a turn with stale external results as long as `ah_done` says so.
11. **Pass is not truth.** A passing document can still be wrong. Read three "passes" with a critical eye.

## 11. Stop conditions

Stop and write up (do not tune around it) if you see any of:

- `UNEXPLAINED` in a report
- non-identical findings on unchanged text (S1)
- the second rubric run making model calls (S5.3)
- an open finding marked fixed because a tool could not run (S3.7, S5.9)
- an agent accepting its own proposal, editing a protected file, or reporting `INCOMPLETE` as done (S13)
- a `PASS` on a document you know has a blocking problem (S11)
- a secret or API key in `.ah/` files

## 12. Log template (one per scenario)

```
Scenario:            (e.g. S5.3 rubric cache)
Date / instance:     
Manuscript:          (small / real draft; files, paragraphs)
Model and backend:   
Steps run:           
Expected:            
Observed:            
Result:              pass | fail | partial | not run
Evidence:            (report hash, finding fingerprints, command output, screenshot path)
Cost:                (calls / tokens / seconds)
Follow-up:           (bug to file, rule to demote, doc to fix)
```

End the exercise with a short summary table: scenario, result, and the three things that most need fixing.
