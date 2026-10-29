from __future__ import annotations

EVENT_OPS = frozenset(
    {
        "INGEST",
        "DERIVE",
        "INDEX_REBUILD",
        "CLAIM_WRITE",
        "CLAIM_TRANSITION",
        "DOC_SUPERSEDE",
        "IDENTITY_PROMOTE",
        "PROJECT_ENSURE",
        "AH_REGISTER",
        "LEDGER_EXPORT",
        "VERDICT_IMPORT",
        "MIGRATION",
        "SWEEP",
        "MERGE",
        "BIND",
        "REPAIR",
        "DELETE",
        "CITE_CHECK",
        "REMEMBER",
        "LESSON_WRITE",
        "MANUSCRIPT_WRITE",
        "LIBRARY_IMPORT",
        "LIBRARY_WRITE",
        "KEY_ASSIGN",
        "KEY_FREEZE",
        "KEY_RENAME",
    }
)

# One canonical op per content-mutating method. Entity/relation writes are
# derived data until v2 drops those tables. Access telemetry is not semantic
# state and deliberately emits no event.
MUTATORS = {
    "upsert_paper_v2": "INGEST",
    "add_claim_v2": "CLAIM_WRITE",
    "ensure_project": "PROJECT_ENSURE",
    "add_membership": "PROJECT_ENSURE",
    "promote_identity": "IDENTITY_PROMOTE",
    "merge_papers": "MERGE",
    "upsert_manuscript": "MANUSCRIPT_WRITE",
    "replace_sections": "MANUSCRIPT_WRITE",
    "replace_contributions": "MANUSCRIPT_WRITE",
    "add_term": "MANUSCRIPT_WRITE",
    "add_reviewer_comment": "MANUSCRIPT_WRITE",
    "remember": "REMEMBER",
    "add_lesson": "LESSON_WRITE",
}

NON_SEMANTIC = {"get_paper": "access_count telemetry only"}

LEGACY_OP_MAP = {
    "paper_create": "INGEST",
    "claim_create": "CLAIM_WRITE",
    "manuscript_create": "MANUSCRIPT_WRITE",
    "remember": "REMEMBER",
}
