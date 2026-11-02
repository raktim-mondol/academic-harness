# Scientific data and toolkits

This extends the harness from literature discovery to scientific databases and local molecular computation. Four preset-only tools; none needs a key.

| Tool | Scope | State |
|---|---|---|
| [`science_source`](#science_source) | UniProt, RCSB PDB, AlphaFold DB, PubChem | Network, read-only |
| [`chem_toolkit`](#chem_toolkit) | RDKit chemistry | Local |
| [`seq_toolkit`](#seq_toolkit) | Sequences | Local, pure Python |
| [`structure_toolkit`](#structure_toolkit) | gemmi structures | Local |

The skill is `science-data`. State lives under `<cwd>/.dsh/science/`:

- `retrievals.jsonl`: one line per `science_source` `fetch` (url, license, bytes, SHA-256, saved path).
- `runs.jsonl`: one line per toolkit run (tool, action, time, input hashes, tool versions). Inline inputs are hashed from their canonical JSON, file inputs from their bytes; absolute paths are never recorded.

## `science_source`

One tool, one adapter per database (`science-sources/*.js`).

| Action | Behaviour |
|---|---|
| `catalog` | Sources, capabilities, auth, rate limit, license, and `ready` / `key_missing` state. |
| `search` | Source query with a common record shape. `limit` 1–25 (default 10). |
| `get` | One record by source id. UniProt `include_sequence` adds the sequence. |
| `resolve` | UniProt→PDB (from the entry's cross-references), UniProt→AlphaFold, PubChem CID→InChIKey. |
| `fetch` | Raw file or record from the source's own https hosts, capped at 1 MB (hard maximum 25 MB). `save_to` writes it inside the workspace and appends to `retrievals.jsonl`. |

| Source | Id help | Capabilities | License on records |
|---|---|---|---|
| `uniprot` | accession, e.g. `P69905` | search, get, resolve | CC BY 4.0 |
| `rcsb-pdb` | `4HHB` | search, get, fetch | CC0 |
| `alphafold` | UniProt accession | get, fetch | CC BY 4.0 |
| `pubchem` | CID, e.g. `2244` | search, get, resolve | NCBI public domain; depositor data may carry its own terms |

Every record has `source`, `id`, `url`, `title`, `summary`, `fields`, `retrieved_at`, `license`, and `provenance` (`endpoint`, `query`, `adapter`, `adapter_version`). A missing field is `null`, never inferred.

**Failure states.** `not_found`, `bad_request`, `rate_limited`, `provider_blocked`, `unavailable`, `not_supported`, `size_limit_exceeded`. An empty search is a result with a note, not an error, and the note says it is not proof of absence. There is no key to be `key_missing` for today, but the catalog reports it for any future adapter that declares `auth`.

**Pacing.** Each adapter has its own limiter (about 3–5 requests per second) and the shared transient-retry client, so a 429 or 5xx is retried and then reported as a state.

**Notes.**

- RCSB search returns ids; details come from one batched GraphQL call, not one request per hit.
- An AlphaFold record is labelled a prediction (`prediction_is_not_experiment: true`, title suffix `(predicted)`) and carries mean pLDDT.
- `fetch` refuses plain http, any host not in the adapter's allow-list, and any `save_to` that escapes the workspace.

### Adding an adapter

Add a file under `science-sources/` exporting an object with `id`, `name`, `version`, `baseUrl`, `hosts`, `auth`, `rateLimit`, `limiter`, `license`, `capabilities`, `idHelp`, and methods for each capability it lists (`search(params, deps)`, `get(params, deps)`, `resolve(params, deps)`), build records with `makeRecord`, make requests with `call` (both from `science-sources/common.js`), and register it in `science-sources/index.js`. A test enforces that an adapter advertises a capability if and only if it implements it, and every network test injects `deps.fetchJson`, so none touches the network. The adapters are exported as `academic-harness/science-sources/*`.

Not included, because of unstable APIs and licensing: ChEMBL, NCBI Gene / Ensembl, GEO, and Reactome are deferred. Use `domain_search`, `dataset_search`, or the `database-lookup` skill for those.

## `chem_toolkit`

RDKit through `python-helpers/chem_toolkit.py`. Input is inline `molecules` (up to 2000; each `SMILES` or `SMILES name`) or a workspace `path` (`.smi`, `.sdf`; the first 5000 structures, and the result says when it stopped).

| Action | Result |
|---|---|
| `validate` | Valid/invalid with the reason, canonical SMILES, formula. |
| `standardize` | Cleanup, largest fragment, neutralization, optional canonical tautomer, InChIKey, and whether the structure changed. |
| `descriptors` | MW, exact mass, Crippen logP, TPSA, HBD/HBA, rotatable bonds, rings, rule-of-five flag count. |
| `similarity` | Morgan Tanimoto against `query` (radius, bits, threshold, `top_k`); unparsable candidates are counted and skipped. |
| `substructure` | SMARTS matches. |
| `conformers` | Seeded ETKDG embedding with MMFF94 relaxation; `out_path` writes an SDF inside the workspace and refuses to replace one without `overwrite`. |

The rule-of-five count is a screening heuristic, logP is an estimate, and similarity depends on the fingerprint. The tool does not predict activity, toxicity, or docking scores.

## `seq_toolkit`

Pure Python (`python-helpers/seq_toolkit.py`); it works on any machine with `python3`. Input is an inline `sequence` (raw or FASTA, several records allowed) or a `path`.

| Action | Result |
|---|---|
| `stats` | Type (DNA, RNA, protein, or a warning), length, composition, GC%, protein average mass. |
| `translate` | Standard genetic code, six frames, `to_stop`; trailing bases and internal stops are reported. |
| `orfs` | Both strands, 1-based coordinates, `min_length_aa` (default 100), optional GTG/TTG starts. |
| `primer_tm` | SantaLucia (1998) nearest-neighbour Tm with sodium correction, plus the Wallace rule for reference. 8–60 nt, unambiguous bases only. |
| `align` | One global (Needleman–Wunsch) or local (Smith–Waterman) alignment with linear gaps, up to 5000 per sequence. |

For protein alignment the helper uses BLOSUM62 when Biopython is installed (`uv pip install biopython` in the helper environment) and otherwise falls back to identity scoring, and the result names which it used. An alignment score has no null model and is not a homology test. BLAST and any database search are out of scope; the optional BLAST action in the plan is not implemented.

## `structure_toolkit`

gemmi through `python-helpers/structure_toolkit.py`, on a PDB or mmCIF file already in the workspace (bring one in with `science_source` `fetch` and `save_to`). Only the first model is read.

| Action | Result |
|---|---|
| `chains` | Chain id, polymer type, residue count and range, one-letter sequence, ligand and water counts, resolution, space group. |
| `ligands` | Non-polymer, non-water residues by chain and name. Ions, buffers, and cryo additives appear here. |
| `contacts` | Residue pairs within `cutoff` (1–8 Å, default 4) between two selections, each a chain id or a residue name such as `HEM`; adjacent residues are ignored, waters are excluded unless asked for, crystal-packing neighbours are flagged `symmetry_mate`. |
| `superpose` | C-alpha or backbone fit of `chain2` in `path2` onto `chain` in `path`: matched atoms, RMSD, and the transform. Nothing is written. |

A contact list is proximity, not an interaction type. An RMSD over a short or trimmed match is weak evidence. A file that parses to no atoms is an error, not an empty result.

## Not implemented

An `astro_toolkit` (needs astropy) and a BLAST action are not built. The tool ships with four adapters and three toolkits.

## Setup

`seq_toolkit` needs only `python3`. `chem_toolkit` and `structure_toolkit` need the helper environment (`cd python-helpers && uv sync`), which already includes RDKit and gemmi. Without them the tool returns an error naming the missing package; nothing else is affected.

## Tests

`npm run test:science` runs `scripts/test-science-source.mjs` (adapters and the tool against injected fetchers, no network) and `scripts/test-science-toolkits.mjs` (the real helpers on synthetic inputs; the RDKit and gemmi sections skip with a printed reason when those packages are absent).
