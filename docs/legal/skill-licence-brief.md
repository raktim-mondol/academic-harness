# Brief for an independent review of the bundled skill licences (decision D09)

Prepared for the owner to pass to counsel. It is a description of what the package contains and where the questions are. It is not legal advice and it takes no position on any of them.

## The package

`academic-harness` is published to npm and GitHub under the MIT licence (`LICENSE`). It bundles 790 agent skills under `skills/`, assembled from several upstream catalogues, and vendored Python code under `vendor/`. `NOTICE` records upstream sources, adaptations and licences. A skill's own `license:` frontmatter field states its label.

Label summary after normalisation (`docs/legal/skill-licence-inventory.md` lists every skill):

| Label | Skills |
|---|---|
| MIT | 633 |
| Apache-2.0 | 19 |
| BSD-3-Clause | 19 |
| BSD-2-Clause | 2 |
| CC-BY-4.0 | 8 |
| CC-BY-NC-SA-4.0 | 6 |
| No `license` field | 77 |
| Other (GPL labels, links to a library's LICENSE file, "Unknown", free text, proprietary) | 26 |

## What changed in this release line

1. **Four skills replaced.** `docx`, `pdf`, `pptx`, `xlsx` shipped in 0.50.0 and earlier as third-party files under an all-rights-reserved licence that does not permit redistribution. They were replaced by original skills (`skill-rewrite-provenance.md`).
2. **Non-commercial skills named.** The six CC BY-NC-SA 4.0 skills (`deep-research`, `intro-drafter`, `paper-polish`, `paper-writer`, `rebuttal-guidance`, `what-if-oracle`) are now all listed in `NOTICE`, and a build option leaves them out (`AH_EXCLUDE_NONCOMMERCIAL=1`, `npm run pack:commercial`).
3. **Labels normalised** to SPDX identifiers where the meaning was unambiguous (109 skills). Nothing else was relabelled.
4. **GPL-labelled skills explained.** Five skills carry GPL labels (`bioservices`, `cobrapy`, `etetoolkit`, `pathml`, `scikit-survival`). `NOTICE` now says the label names the licence of the library the skill teaches, not of the skill text, and that no GPL library is bundled. That is the maintainers' reading, recorded for review.

## Questions for counsel

1. **Prior releases.** The restricted skill files remain in git history and in published releases up to 0.50.0. Is any action needed beyond what has been done (replacement going forward, local copies moved aside)? For example, withdrawing or yanking releases, or rewriting history, and whether the maintainers need permission or a notice to the rights holder.
2. **Adequacy of the rewrite.** Do the method, the automated overlap check and the provenance note (`skill-rewrite-provenance.md`) suffice, given that an AI model wrote the replacement and may have seen the originals in training?
3. **Non-commercial, share-alike skills inside an MIT package.** Six CC BY-NC-SA 4.0 skills are distributed in the same package and repository as MIT code. Is the `NOTICE` arrangement (the licence stays with the skill, MIT does not relicense it) sufficient for share-alike and attribution, for the npm tarball and for the repository? Are adaptations in this repository (frontmatter additions, runtime notes) "adapted material" that must itself carry CC BY-NC-SA?
4. **GPL labels.** Is it right to treat these five skills as MIT text about GPL libraries? Should the label be changed, and to what?
5. **Missing and unclear labels.** 77 skills have no licence field and 26 have a label that is not an identifier (including `Unknown`, links, and one "Proprietary (API key required)"). What default applies, and what must be done per upstream? The inventory lists each.
6. **Attribution duties** of the 8 CC-BY-4.0 and the BSD and Apache-2.0 skills, and whether `NOTICE` carries what each requires.
7. **Commercial use.** If the project is used or redistributed commercially, is `pack:commercial` (which removes the six NC skills but leaves the text of `NOTICE` and prompts that mention them) enough?

## Out of scope for this brief

Vendored Python under `vendor/` (PaperMemory, the Academic Harness engine) and npm dependencies were not re-reviewed here. Their licences are recorded in their own files and in `NOTICE`.

## Release gate

The decision record holds the next release until the licence work is merged. This brief is the input to the independent opinion the owner asked for; the release should wait for it.
