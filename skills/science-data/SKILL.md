---
name: science-data
description: Look up proteins, structures, and compounds in UniProt, RCSB PDB, AlphaFold DB, and PubChem with `science_source`, and compute on them locally with `chem_toolkit` (RDKit), `seq_toolkit` (sequences, ORFs, primer Tm, alignment), and `structure_toolkit` (chains, ligands, contacts, superposition). Use when a claim rests on a database record or a calculated molecular, sequence, or structural property and the source, retrieval date, license, and inputs must be recoverable.
allowed-tools: Read Write Edit Bash
license: MIT license
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Science data

> **In Academic Harness:** `science_source` is the read-only, keyless database
> layer; `chem_toolkit`, `seq_toolkit`, and `structure_toolkit` are local
> computation. Retrievals are logged to `.dsh/science/retrievals.jsonl` and every
> toolkit run to `.dsh/science/runs.jsonl` with input hashes and tool versions.
> They report what a source or a calculation says; they do not judge the science.

## Choose the layer

| Need | Tool |
|---|---|
| Find or read a record (protein, PDB entry, predicted structure, compound) | `science_source` `search` / `get` |
| Map an id to another database | `science_source` `resolve` (UniProt→PDB, UniProt→AlphaFold, PubChem CID→InChIKey) |
| Get a structure file into the workspace | `science_source` `fetch` with `id` and `save_to` |
| Validate, standardize, or describe SMILES; similarity; substructure; conformers | `chem_toolkit` |
| Sequence stats, translation, ORFs, primer Tm, pairwise alignment | `seq_toolkit` |
| Chains, deposited ligands, residue contacts, RMSD between structures | `structure_toolkit` |
| Literature about these entities | `literature_search`, not this skill |
| A binary lab format you have not identified | `sci_inspect` |

## Workflow

1. **Resolve the entity first.** Search by name, then `get` by id. State the id you
   settled on (UniProt accession, four-character PDB id, PubChem CID) and why.
   One name can map to several records; do not pick silently.
2. **Quote the record, not memory.** Report the field the record states. A missing
   field is "not recorded", never an inferred value.
3. **Keep provenance in the text.** Cite the database, the id, the retrieval date,
   and the license shown on the record. Licenses differ: UniProt and AlphaFold are
   CC BY 4.0, RCSB metadata is CC0, PubChem is NCBI public domain with depositor
   terms that may differ.
4. **Compute locally from a saved copy.** `fetch` the structure with `save_to`, then
   run `structure_toolkit` on that path so the run is tied to a file hash.
5. **Say what a number is.** A Crippen logP is an estimate; a Tanimoto score depends
   on the fingerprint; an ORF is a candidate; a Tm is a model value to verify; a
   contact is proximity, not an interaction type; an RMSD over a short match is
   weak evidence.

## Guardrails

- **AlphaFold is a prediction.** Never describe an AlphaFold model as an
  experimental structure; report mean pLDDT with it and note low-confidence regions.
- **An empty search is not absence.** "No match" means this query on this source.
- **PDB ligands include additives.** Ions, buffers, and cryoprotectants appear in
  `ligands`; do not call them bound ligands without the paper's support.
- **`fetch` is host-limited.** Only https URLs on the source's own hosts, capped at
  25 MB. No redirects to other hosts, no paywalled or bot-protected sources.
- **Sources are not interchangeable.** Different databases curate differently;
  disagreement between them is a finding to report, not to average.
- **Large inputs are capped and say so.** Chemistry reads the first 5000
  structures; sequences are limited to 2 million residues; pairwise alignment to
  5000 per sequence; contact and ligand tables to 200 rows.
- **Not covered here:** BLAST and database sequence search, docking, free-energy or
  quantum calculations, toxicity prediction, and astronomy files. Name the right
  tool or say it is not available; do not approximate it.

## Failure states

`science_source` returns `not_found`, `bad_request`, `rate_limited`,
`provider_blocked`, `unavailable`, `not_supported`, or `size_limit_exceeded`.
`rate_limited` and `unavailable` are worth one retry later; `not_found` and
`bad_request` are not. Toolkit errors name the cause (unparsable SMILES, missing
chain, file not a structure); report them rather than working around them.

## Reporting

Methods sentence: "Records were retrieved from UniProt (accession P69905) and RCSB
PDB (4HHB) on 2026-11-01; descriptors were computed with RDKit 2026.09.1 on
standardized structures." Name the versions the run record shows and keep
`.dsh/science/` with the project so the retrieval and the calculation can be repeated.
