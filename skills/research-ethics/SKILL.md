---
name: research-ethics
description: Draft an ethics/IRB protocol and consent, check it against Helsinki/Common Rule/GDPR/HIPAA concepts, and scan/redact PHI/PII locally with the ethics_protocol and deidentify tools. Use before human-subjects or identifiable-data work, before sharing a dataset, or when preparing an ethics submission.
allowed-tools: Read Write Edit Bash
license: MIT
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Research Ethics and De-identification

> **In Academic Harness:** `ethics_protocol` keeps an append-only protocol under
> `.dsh/ethics/<slug>/`; `deidentify` keeps masked scan/redaction records under
> `.dsh/deidentify/<slug>/`. Neither certifies compliance. A human must review
> every report, consent draft, and output.

## Ethics protocol

1. **Record the study shape.** `ethics_protocol start` with study type, population,
   risks, benefits, consent process, data types, jurisdiction, retention,
   sharing, funding, and any approval reference. Never invent an approval
   number, committee, or waiver.
2. **Append sections, not overwrite.** `section` records text for consent
   process, recruitment, data security, incidental findings, or other local
   requirements; the latest value is derived but earlier events stay.
3. **Generate a consent draft.** `consent` assembles Markdown from the protocol
   and your inputs. Every `[TO BE COMPLETED]` is a real gap. Complete the
   purpose, procedures, risks, benefits, alternatives, confidentiality,
   compensation, contacts, withdrawal, and signature blocks; translate and
   validate with the community where needed.
4. **Run `check`.** Read `present`, `missing`, and `manual_check` separately.
   Institutional requirements, GDPR lawful basis/DPIA, HIPAA authorization or
   waiver, vulnerable-population safeguards, and animal/IACUC requirements are
   always for a human or committee to confirm.
5. **Export** Markdown or JSON for the submission file; it is a draft, not an
   approval.

## De-identification

1. **Scan before sharing.** `deidentify scan file=…` detects emails, phones,
   SSNs, MRNs, dates, ages over 89, addresses, URLs/IPs/MACs, account numbers,
   titled or labelled names, and any `terms`/`names` you supply. The report is
   masked and includes line/column and column summaries for CSV/TSV.
2. **Review the matches.** A regex hit is a candidate, not a confirmed
   identifier; a zero-match file is not proven safe. Add local names,
   identifiers, or project codes with `terms`/`names`.
3. **Redact to a separate file.** `policy` supports per-type or per-column
   `mask`, `type`, `hash`, `remove`, `drop`, `generalize` (year, 90+, ZIP3).
   The input is never edited in place, and no reversible mapping is written.
   Custom terms are stored only as hashes; pass the same terms again to
   `redact`/`verify`. A scan with more than 1000 candidate matches is refused
   for redaction; split the file or narrow the terms rather than accept a
   partial result.
4. **Verify and review.** `verify` rescans the output. Residual matches need a
   decision: redact again or document why they are false positives/not PHI.
   Review the redacted file itself, not only the counts.

## Guardrails

- Not legal advice, not a HIPAA/GDPR compliance guarantee.
- Local only: `deidentify` makes no model or network call.
- Preserve provenance: keep the original file and the masked report; do not
  destroy the audit trail.
- Use the same slug as `preregister`/`dmp` so the records link.
