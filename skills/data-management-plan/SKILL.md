---
name: data-management-plan
description: Draft a funder-shaped data management plan (NIH DMS, NSF DMP, Horizon Europe, Wellcome, ERC, generic) with the `dmp` tool, link it to the preregistration and data/repro ledgers, and review the concept checklist. Use when a grant, ethics submission, or data-sharing statement needs a DMP.
allowed-tools: Read Write Edit Bash
license: MIT
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Data Management Plan

> **In Academic Harness:** `dmp` writes an append-only plan under
> `.dsh/dmp/<slug>/`. The templates are paraphrased concepts, not official
> funder forms, and the checklist is not a compliance verdict.

## Build the plan

1. **Start with the funder shape.** `dmp start template=…` with title, funder,
   grant number, institution, PI, project summary, data types, repository,
   embargo, costs, roles, and ethics/legal constraints. If a field is unknown,
   leave it unrecorded; do not invent a repository, embargo, or cost.
2. **Write the required sections.** `dmp section` for data types/standards,
   storage, access, sharing/reuse, preservation, roles, costs, and ethics/legal
   constraints. Record actual formats, metadata standards, identifiers,
   retention periods, access controls, and who does what.
3. **Run `check`.** `missing` means no content is recorded; `manual_check`
   means a human/funder must confirm it (repository terms, costs, official
   template version, institutional requirements). `present` is not a funder
   approval.
4. **Link the records.** Use the same slug as `preregister`, `dataset_get`, and
   `repro_package`; `status` counts those ledgers. Linking is not verification.
5. **Export** Markdown or JSON. Compare against the funder's current official
   form before submission; this tool does not submit anywhere.

## Content prompts

- Which data are generated, in what formats, and under what standards?
- Where are they stored during the project, with what backup and access control?
- Which metadata/identifiers make them findable and citable?
- What is shared, when, under what license/embargo, and how is access requested?
- How long are data preserved, and where? What happens at project end?
- Which costs are requested, and who is responsible for each task?
- Which ethics, consent, legal, or contractual constraints limit sharing?

Use `docs/RESEARCH.md#data-management-plan` for the tool reference and the
`research-grants` skill for the wider proposal.
