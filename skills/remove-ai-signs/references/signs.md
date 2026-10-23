# Signs of AI Writing — field guide

Adapted from Wikipedia's "Signs of AI writing" (WP:AICAT) for general prose,
technical writing, and LaTeX documents. Each tell: what it looks like, why it
reads as machine-made, and how to fix it. Context decides: one occurrence is
coincidence; density and clustering are the signal.

## 1. Content patterns

### 1.1 Undue emphasis on significance
Puffery that asserts importance instead of demonstrating it: "a pivotal role",
"an enduring legacy", "a testament to", "marks a crucial moment", "stands as a
cornerstone".
- Fix: delete the claim or replace it with the concrete fact that earns it
  ("published in 1923 and reprinted twice" instead of "a lasting landmark").

### 1.2 Canned notability / coverage boilerplate
"has been featured in", "received critical acclaim", "garnered attention",
"been the subject of numerous publications", "widely regarded as".
- Fix: name the source or cut the sentence. Never keep a coverage claim with
  no citation behind it.

### 1.3 Superficial -ing analyses
Trailing present-participle clauses that fake depth: ", highlighting the
importance of…", ", showcasing…", ", underscoring…", ", reflecting the broader…",
", ensuring that…".
- Fix: cut the clause, or turn the hidden content into a real sentence with a
  subject and a verb that says something checkable.

### 1.4 Promotional language
"boasts", "vibrant", "rich heritage", "bustling", "cutting-edge",
"state-of-the-art", "seamless integration", "world-class".
- Fix: neutral description; adjectives only where a measurable property backs them.

### 1.5 Vague association
"associated with", "linked to", "connected to", "related to", "played a role
in" — hedged causality that commits to nothing.
- Fix: state the actual relation (causes, precedes, correlates with r=…,
  appears in), or delete.

### 1.6 Weak attribution
"experts argue", "studies have shown", "research suggests", "it is widely
acknowledged", "many have noted" — with no cited study.
- Fix: cite the specific work, or rewrite as the book's own claim if the book
  supports it, or delete.

### 1.7 Outline-like "Challenges and future directions"
Generic conclusion sections: "challenges and opportunities", "future
directions", "as the field continues to evolve…". Lists of vague limitations
with no specifics.
- Fix: either make each limitation concrete (which assumption fails, what
  breaks, what evidence would settle it) or fold the content into the body.

## 2. Language and grammar

### 2.1 AI vocabulary (density is the tell)
Words LLMs overuse; they co-occur, so clusters are damning:
delve/delves, tapestry, landscape (figural), pivotal, crucial, testament,
underscore (figural), showcase, bolster(ed), garner, foster(ing), vibrant,
intricate(-ies), interplay, meticulous(ly), enduring, valuable, robust,
seamless(ly), harness, leverage, multifaceted, realm(s), embark, unwavering,
cornerstone, hallmark, resonate(s), elevate, nuanced, rich tapestry, deep
dive, cutting-edge, state-of-the-art, holistic.
Era drift matters: "delve" peaked 2023–24; "leverage/multifaceted/quietly/
universally" mark later models. Synonyms are NOT automatically tells —
"important" is fine; "pivotal" is flagged.
- Fix: plain word, or restructure the sentence so the emphasis is in the fact.

### 2.2 Copula avoidance
"serves as", "stands as", "represents", "constitutes", "marks", "functions
as" where "is" is shorter and honest.
- Fix: use "is" unless the locution adds meaning.

### 2.3 Negative parallelism
"Not only X but also Y", "It is not just X, it's Y", "not because… but
because", "Y, rather than X" — the misconception-stacking tic.
- Fix: assert Y directly. Keep at most one genuine contrast per passage, and
  only where readers plausibly hold the wrong belief.

### 2.4 Rule of three
"adjective, adjective, and adjective" and triple-phrase rhythms everywhere:
"robust, scalable, and efficient"; "tiles, metals, and plastics".
- Fix: pick the one adjective that carries information; two items often beat
  three; break the rhythm by varying sentence openings.
- Caution: real technical triads are fine ("mass, momentum, and energy",
  the three Darcy variables). Judge by whether all three earn their place.

### 2.5 Uniform sentence rhythm
LLM prose has low variance in sentence length. Human academic prose mixes a
5-word sentence with a 45-word one.
- Fix: after editing, check the scanner's mean/sd line; raise sd by merging
  short parallel sentences and splitting long periodic ones.

## 3. Style

### 3.1 Title-case headings
"Significance and Impact", "Historical Background and Context" — LLMs
title-case what humans sentence-case.
- Fix: sentence case for headings (except proper nouns).

### 3.2 Boldface overuse
Bolded lead-ins on every bullet, bolded key terms mid-paragraph, bold inside
captions for emphasis.
- Fix: bold only structural labels the document convention expects (run-in
  definition terms, table headers). One emphasis device per paragraph.

### 3.3 Inline-header vertical lists
"- **Performance:** The system…", "- **Cost:** …" — bolded-word-plus-colon
bullets, the classic LLM outline format.
- Fix: convert to prose with connectives, or to a real table if the axis of
  comparison is genuine. Keep lists only for ordered procedures.

### 3.4 Em-dash density
LLMs (and their imitators) lean on — often — mid-sentence — apposition.
- Fix: target well under ~5 per 1,000 words; replace with commas, colons,
  parentheses, or a new sentence.

### 3.5 Emoji and decorative symbols
🚀💡 in headings or bullets; ✓/★ as ornament.
- Fix: delete. Always.

### 3.6 Unusual use of tables
LLMs convert prose into tables that do not earn their rows: "Feature |
Description" two-column tables restating the paragraph above them, summary
tables at the end of every section, cells padded with "N/A"/"—"/"varies",
one row per trivial item where a sentence would do, or comparison tables
whose columns are not actually comparable.
- Fix: keep a table only where it carries a real matrix of values the reader
  looks up (spec sheets, benchmarks, taxonomies); otherwise return the
  content to prose. Empty-cell padding means the row should not exist.

## 4. Communication artifacts (chatbot residue)

### 4.1 Collaborative tone
"Let's explore", "we will delve into", "As we discussed", "I hope this
helps", "Certainly!", "Here is a draft".
- Fix: delete; academic "we" (authorial plural) is fine, conversational "we"
  (with the reader as participant) is not.

### 4.2 Hedging disclaimers about sources
"as of 2024", "no reliable sources document", "specific details remain
scarce", "this section could be expanded", "while exact figures are
unavailable".
- Fix: in a book, either state the limitation once in the right place
  (a footnote, a "what we do not know" paragraph) or cut the apology.
  Repeated "no data" hedges read as generation residue, not scholarship.

### 4.3 Placeholders
"[insert …]", "[name]", "TBD", "XX%", "Example 1/2/3", "Lorem".
- Fix: fill or delete.

## 5. Markup tells (format-specific)

### 5.1 Markdown in non-Markdown files
`**bold**` inside LaTeX; `#` headings in .tex; `[text](url)` in plain text;
`---` thematic breaks between every section.
- Fix: convert to the target format's own devices (\textbf or \emph; \section;
  real citations; whitespace).

### 5.2 Provider-specific citation residue
ChatGPT: `[1]`, `oaicite`, `turn0search0`, `+1`, `attributableIndex`;
Gemini: `[cite: 1]`, `(start_span)`; Grok: `grok_card`; DeepSeek: `⟨…⟩`
lenticular brackets, stray †; Perplexity: `attached_file`, `ppl-ai-file-upload`.
- Fix: delete the residue, then re-verify the underlying claim against a real
  source before keeping the sentence.

### 5.3 Curly quotes in source files
Smart quotes (" " ') pasted into .tex or code where straight quotes are the
convention.
- Fix: normalize to the format's convention.

## Rewrite policy (binding)

1. Preserve meaning, numbers, hedges-that-are-true, citations, and register.
   An academic text may legitimately say "we show" or use "significant".
2. Never touch code, math, verbatim quotations, bib entries, or technical
   terminology that merely collides with a tell list ("marks a matrix",
   "mass, momentum, and energy").
3. Density, not presence, justifies a change. A single "robust" in 3,000
   words stays.
4. Fix by rewriting the sentence, not by thesaurus-swapping the flagged word —
   swapped synonyms keep the rhythm that made it read as AI in the first place.
5. After editing, re-scan; compare before/after counts; confirm the sd of
   sentence length went up, not down.
6. Over-correction is failure: flattening varied academic prose into
   subject-verb-object monotony is its own tell.
