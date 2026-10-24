# How the tournament works

What the tools compute, so you can explain a ranking instead of second-guessing
it. None of this is yours to reproduce — read it to report it accurately.

## 1. Ratings are Glicko-2, not a score

Each hypothesis carries a **rating** and an **RD** (rating deviation — the
uncertainty in that rating), plus a volatility that controls how fast it can move.

| Situation | Rating | RD |
|---|---|---|
| Just added, never reviewed or played | 1200 | 350 |
| Evolved child of a top hypothesis | 85 % of best parent | 350 |
| Passed all five reviews | `1000 + (best review average / 10) × 400` | 200 |
| After matches | moves with results | tightens with every match |

- The review seed takes the **best** score each dimension received across the five
  stages, so a hypothesis that impressed one reviewer is not averaged down to
  obscurity. A 5/10 average lands on 1200, 8/10 on ~1320.
- Every match is **zero-sum**: what the winner gains, the loser gives. A
  tournament's total rating is conserved, so a leaderboard cannot inflate itself.
- Beating a **certain** opponent (low RD) moves you more than beating an
  **uncertain** one. The system discounts results against an idea nobody has
  pinned down yet.
- RD is capped at 350 and never exceeds it. It only shrinks by playing.

**Reading a rating out loud.** Always pair it with RD and matches played. A 1420
with 1 match and RD 240 is not better-established than a 1290 with 6 matches and
RD 120 — it is a coin flip whose luck has not been averaged yet. Never render a
rating as a probability, a confidence, or "quality".

## 2. What moves a rating

Only three things. Nothing else changes the ledger, including your own opinion:

1. **A review sequence completing** — sets the seed.
2. **A recorded match** (`coscientist_rank record`).
3. **Experimental feedback** (`coscientist_rank feedback`) — a real result, scored
   as a match against an empirical baseline fixed at 1200 with RD 50. The reward is
   `0.4 × sentiment + 0.6 × (mean score / 10 − 1)` from the feedback text and the
   three 0–10 scores; above `+0.33` counts as a win, below `−0.33` as a loss, and
   anything in between is a draw (which still tightens RD — the hypothesis is now
   known to be *neutral*, not untested). A rejected hypothesis cannot be revived by
   feedback.

Citation integrity applies a **soft penalty** instead: with
`f = (fabricated + 0.5 × unverified) / total` citations, the seed loses up to 150
rating points and gains up to 100 RD. One shaky citation among ten is a scratch,
not a disqualification — and a registry you could not reach is `unverified`, never
`verified`.

## 3. Judging both orders

LLM judges systematically prefer whichever hypothesis is shown first. Upstream
compounds this because the matchup selector always places its priority candidate
in slot A. So each match is judged twice, with the pair swapped, and each verdict
names the *presented slot*. Run the two orientations **sequentially**, one judge
subagent at a time; a parallel pair doubles the chance of a startup failure and
leaves no clean way to retry one orientation. The two briefs must be identical
apart from the swapped slots, and a retry must reuse the identical brief — a
shorter retry on one side makes the two verdicts incomparable:

| A,B run says | B,A run says | Real verdict |
|---|---|---|
| `A` | `B` | A wins (both orders chose `h_a`) |
| `B` | `A` | B wins |
| `A` | `A` | **draw** — each order chose whoever was first |
| `draw` | `A` | A wins (a decisive verdict beats a draw) |
| `draw` | `draw` | draw |

Record `verdict_ab` and `verdict_ba`. The reconciliation happens in the tool; if
you report the same letter twice it is not a bug, it is the third row of that
table — and it tells you the judges were chasing the presentation order, not the
science. Re-run the pair rather than recording a draw you did not mean.

A match recorded with one orientation is accepted but flagged
`position_controlled: false`, and the flag is visible in the match history. Use it
only when a second judge genuinely cannot be run, and say so in the report.

## 4. Which pair plays next

`propose` completes the first ranking before it starts repeating pairs:

1. While any two active hypotheses have never met, the fresh pair containing the
   most uncertain hypothesis (`RD / (matches played + 1)`) plays first. With `n`
   active hypotheses, that is at most `C(n,2)` matches to give every pair a
   result.
2. After every pair has met at least once, selection is upstream **uncertainty
   first**: the active hypothesis with the highest `RD / (matches played + 1)`
   plays a *similar* one from the proximity graph if one exists (nearby ideas
   resolve an uncertain rating fastest), otherwise a random peer from the top-10
   priority slice.
3. Never against itself; never a rejected or withheld hypothesis.

That is why a low-ranked hypothesis with few matches appears repeatedly later:
the tournament is spending its budget where it knows the least. `propose` reports
`pair_matches_played` and `unplayed_pairs_remaining` so you can see which phase
the policy is in.

## 5. Duplicates and similarity

Two measures, two scales, and the ledger always says which one produced a number.

| | lexical (default) | vector (`coscientist embed`) |
|---|---|---|
| What it compares | word 5-gram shingles, Jaccard | cosine over embeddings |
| Duplicate at | ≥ 0.70 | ≥ 0.92 |
| Related at | ≥ 0.50 | ≥ 0.70 |
| Needs | nothing | `GEMINI_API_KEY` + one call per hypothesis |

- **At save time**, an `add` is compared against every live hypothesis in the
  session and discarded with the score, the nearest id, the measure, and the
  threshold that fired. Two hypotheses sharing a mechanism but making different
  claims pass; a restatement does not. `dup_threshold: 1` turns the gate off, and
  leaving it unset means "whatever this measure's scale implies" — so a tournament
  that starts embedding gets 0.92 without being reconfigured.
- **A half-embedded pool is `mixed`, not semantic.** Comparing one side's embedding
  against the other side's words is neither measure, so the tools fall back to
  lexical for that pair and say so. Embed the whole pool or none of it.
- **Post-hoc**, `similarity` reports related and duplicate pairs with their
  measure. Surface duplicate pairs to the scientist; deleting one is their call,
  not yours.
- `propose` prefers a similar opponent when matching an uncertain hypothesis, so
  embeddings change who plays whom, not only who gets discarded.

## 6. When the tournament stops

`next` samples one task per dispatch from a weight table that depends on phase
(these are upstream's numbers, kept so runs stay comparable):

| Phase | generation | reflection | ranking | evolution | proximity | meta |
|---|---|---|---|---|---|---|
| Bootstrap, < 2 active | 0.70 | 0.22 | 0.03 | 0.03 | 0.02 | 0.03 |
| Bootstrap, 2 active | 0.50 | 0.20 | 0.20 | 0.03 | 0.04 | 0.03 |
| Review backlog | 0.10 | 0.55 | 0.20 | 0.08 | 0.05 | 0.02 |
| Mid-run (< round 20) | 0.30 | 0.20 | 0.30 | 0.10 | 0.07 | 0.03 |
| Late-run | 0.15 | 0.20 | 0.30 | 0.25 | 0.05 | 0.05 |
| At cap, reviews pending | 0 | 0.70 | 0.15 | 0.05 | 0.05 | 0.05 |
| At cap, drained | 0 | 0.10 | 0.55 | 0.25 | 0.05 | 0.05 |

It stops for one of five reasons, reported in `terminate`/`reason`:

- **`budget_exhausted`** — dispatch rounds reached `step_budget`. The plan's
  honest deviation from upstream: a tool here cannot see subagent token spend, so
  the budget counts steps rather than tokens. Report steps used, not imagined
  tokens.
- **`match_cap_reached`** — `max_matches` was set (for an explicit user stop
  bound) and that many matches are recorded. It fires even before round 10,
  because it is a request rather than a policy inference.
- **`no_competitors`** — the cap is reached, nothing waits for review, and fewer
  than two hypotheses can still compete. A pool of five absorbs a review veto and
  a withholding and still ranks three; a smaller pool can be emptied by ordinary
  attrition, and then no match can ever be played again, so the loop ends rather
  than spending the rest of the budget. This is why the default cap is 5.
- **`elo_plateau`** — 20 or more rounds sampled, the top-10 average moved by under
  5 rating points across the last 20, at least 10 matches played, and the best
  rating ever above 1210. The rankings have converged.
- **`cap_reached_and_ranked`** — the hypothesis cap is reached, nothing is waiting
  for review, and there are at least 3 matches per active hypothesis.

Hitting the cap alone does **not** end a tournament: it only stops new ideas, and
the policy spends the remaining budget ranking what exists. Never before round 10
does the loop stop for any reason other than the step budget or an explicit match
cap.

## 7. Where the state lives

`<cwd>/.dsh/coscientist/<slug>/` — `protocol.json`, append-only `events.jsonl` and
`matches.jsonl`, and `snapshot.json` (a regenerable cache; the logs are the truth).
Reviews, safety screens, provenance, status changes, feedback, and dispatches are
all *event types* in `events.jsonl`, not separate files — one ordered log is what
makes a replay reproduce the ratings exactly. Exports go under `exports/` and are
never overwritten unless you ask. The ledger is shared by the whole delegation
tree in the workspace, which is why parallel subagents can write to one tournament
at a time — and why you should not run two sessions on the same slug concurrently.

Every rating change carries its evidence: which stages produced the seed, which
match moved it, which result refuted it. If a number cannot be traced to an entry,
do not report it.

`graph` and `priors` read that same ledger rather than keeping notes of their own:
the diagram is derived from lineage, similarity, and recorded claim judgements, and
priors come from the `feedback`, `rejected`, and `quarantined` events of the other
slug directories beside this one. A sibling with damaged logs is skipped, not
fatal — an old experiment cannot block a new one.
