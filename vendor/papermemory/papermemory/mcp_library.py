"""The ``papermemory_library`` MCP tool: the whole reference library behind one ``action`` argument.

Read actions never change anything. Anything destructive or hard to undo needs an explicit flag
(``apply`` with a ``reason``, ``force``, ``adopt``); dry runs are the default.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

MAX_INLINE_CHARS = 60_000

ACTIONS = (
    "list", "get", "resolve", "import", "export", "tag", "collection", "note", "keys", "dedupe", "merge",
    "doctor", "set_integrity",
)

TOOL = {
    "name": "papermemory_library",
    "description": (
        "Reference library: list/get/resolve papers, import BibTeX/BibLaTeX/RIS/CSL-JSON, export BibTeX/BibLaTeX/RIS/"
        "CSL-JSON/JSON/CSV or sync a managed project .bib, tags, collections, notes, citation keys, duplicates, merge, "
        "doctor, record integrity results. Pick an `action`; changes that are hard to undo are dry runs unless "
        "`apply`/`force`/`adopt` is set. Cite only keys the library returns; never invent one."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": list(ACTIONS)},
            "op": {"type": "string", "description": "tag: add|remove|list; collection: create|list|show|add|remove|reorder|delete; note: add|list|edit|remove; keys: check|assign|freeze|rekey"},
            "query": {"type": "string", "description": "filters, e.g. 'tag:ml year:2020..2024 has:pdf !tag:skip graph' (list, export, tag list)"},
            "ref": {"type": "string", "description": "a key, project alias, paper id, or DOI"},
            "refs": {"type": "array", "items": {"type": "string"}},
            "project": {"type": "string", "description": "project key; makes that project's own citation keys win"},
            "cwd": {"type": "string", "description": "workspace directory; export/import paths must stay inside it"},
            "path": {"type": "string", "description": "import: file to read"},
            "text": {"type": "string", "description": "import: inline BibTeX/RIS/CSL-JSON text; note: the note text"},
            "format": {"type": "string", "description": "import: auto|bibtex|ris|csl-json; export: bibtex|biblatex|ris|csl-json|json|csv"},
            "dry_run": {"type": "boolean"},
            "out": {"type": "string", "description": "export: file inside the workspace; omit to return the text"},
            "collection": {"type": "string"},
            "cited_only": {"type": "string", "description": "export: only papers this manuscript cites"},
            "all": {"type": "boolean", "description": "export: every paper"},
            "style": {"type": "string", "description": "export: normalized|original"},
            "fields": {"type": "string", "description": "export: standard|all"},
            "variant": {"type": "string", "description": "export: project|canonical"},
            "check": {"type": "boolean", "description": "export: report sync status, write nothing"},
            "force": {"type": "boolean", "description": "export: overwrite hand edits / an existing file (backup kept)"},
            "adopt": {"type": "boolean", "description": "export: take over an existing .bib (backup kept)"},
            "tags": {"type": "array", "items": {"type": "string"}},
            "slug": {"type": "string"},
            "title": {"type": "string"},
            "parent": {"type": "string"},
            "bib_path": {"type": "string"},
            "note_id": {"type": "string"},
            "to": {"type": "string", "description": "keys rekey: the new key (default: from the template)"},
            "template": {"type": "string"},
            "label": {"type": "string"},
            "reason": {"type": "string"},
            "apply": {"type": "boolean", "description": "keys rekey / merge: really do it (needs a reason)"},
            "keep": {"type": "string"},
            "drop": {"type": "string"},
            "prefer": {"type": "string", "description": "merge: keep|drop wins conflicting fields"},
            "project_keys": {"type": "boolean", "description": "resolve: also list the project's keys"},
            "items": {"type": "array", "items": {"type": "object"}, "description": "set_integrity: [{ref, status, source, notice_doi}]"},
            "sort": {"type": "string"},
            "desc": {"type": "boolean"},
            "limit": {"type": "integer"},
            "offset": {"type": "integer"},
            "cursor": {"type": "string"},
        },
        "required": ["action"],
    },
}


class ToolError(Exception):
    def __init__(self, message: str, code: str = "invalid-argument"):
        super().__init__(message)
        self.code = code


def _need(args: dict[str, Any], *names: str) -> None:
    missing = [n for n in names if args.get(n) in (None, "", [])]
    if missing:
        raise ToolError(f"{args.get('action')} needs: {', '.join(missing)}")


def _op(args: dict[str, Any], allowed: tuple[str, ...]) -> str:
    op = args.get("op")
    if op not in allowed:
        raise ToolError(f"{args.get('action')} needs op: one of {', '.join(allowed)}")
    return op


def library_call(store: Any, args: dict[str, Any], sandbox: Any) -> dict[str, Any]:
    """Run one action. ``sandbox(raw)`` returns (resolved path, None) or (None, error response)."""
    from papermemory import library_keys, library_org
    from papermemory.library import get_entry, import_text
    from papermemory.library_export import export_library
    from papermemory.library_hygiene import doctor, find_duplicates, merge_apply, merge_plan, resolve_refs, set_integrity
    from papermemory.library_query import list_papers, tag_counts
    from papermemory.scope import canonical_project_slug

    action = args.get("action")
    if action not in ACTIONS:
        raise ToolError(f"action must be one of {', '.join(ACTIONS)}")
    project = args.get("project")

    def workspace() -> str | None:
        cwd = args.get("cwd")
        if not cwd:
            return None
        resolved, error = sandbox(cwd)
        if error:
            raise ToolError("cwd is outside the allowed roots", "path-escape")
        return resolved

    if action == "list":
        return list_papers(store, args.get("query"), sort=args.get("sort") or "added", desc=bool(args.get("desc")),
                           limit=int(args.get("limit") or 50), cursor=args.get("cursor"))
    if action == "get":
        _need(args, "ref")
        entry = get_entry(store, args["ref"], project_id=project)
        if entry is None:
            raise ToolError(f"nothing in the library for {args['ref']!r}", "not-found")
        return entry
    if action == "resolve":
        _need(args, "refs")
        return resolve_refs(store, [str(r) for r in args["refs"]], project_id=project,
                            include_project_keys=bool(args.get("project_keys")))
    if action == "import":
        text = args.get("text")
        label = None
        if not text:
            _need(args, "path")
            path, error = sandbox(args["path"])
            if error:
                raise ToolError("path is outside the allowed roots", "path-escape")
            text, label = Path(path).read_text(encoding="utf-8", errors="replace"), path
        proj = args.get("project")
        if proj or args.get("cwd"):
            proj = canonical_project_slug(Path(workspace() or Path.cwd()), project=proj, store=store)
        return import_text(store, text, fmt=args.get("format") or "auto", path=label, project_id=proj,
                           dry_run=bool(args.get("dry_run")))
    if action == "export":
        result = export_library(
            store, fmt=args.get("format") or "bibtex", query=args.get("query"), collection=args.get("collection"),
            project=project, cited_only=args.get("cited_only"), everything=bool(args.get("all")), out=args.get("out"),
            cwd=workspace(), style=args.get("style") or "normalized", fields=args.get("fields") or "standard",
            check=bool(args.get("check")), force=bool(args.get("force")), adopt=bool(args.get("adopt")),
            variant=args.get("variant") or "project",
        )
        if len(result.get("text", "")) > MAX_INLINE_CHARS:
            raise ToolError(f"{len(result['text'])} characters; write to a file with `out`", "too-large-for-inline")
        return result
    if action == "tag":
        op = _op(args, ("add", "remove", "list"))
        if op == "list":
            return {"tags": tag_counts(store, args.get("query"))}
        _need(args, "tags", "refs")
        fn = library_org.add_tags if op == "add" else library_org.remove_tags
        return fn(store, [str(r) for r in args["refs"]], [str(t) for t in args["tags"]], project_id=project)
    if action == "collection":
        op = _op(args, ("create", "list", "show", "add", "remove", "reorder", "delete"))
        if op == "list":
            return {"collections": library_org.list_collections(store)}
        _need(args, "slug")
        if op == "create":
            return library_org.create_collection(store, args["slug"], title=args.get("title"), parent=args.get("parent"),
                                                 project=project, bib_path=args.get("bib_path"))
        if op == "show":
            return library_org.show_collection(store, args["slug"], limit=int(args.get("limit") or 50), offset=int(args.get("offset") or 0))
        if op == "delete":
            return library_org.delete_collection(store, args["slug"])
        _need(args, "refs")
        fn = {"add": library_org.add_to_collection, "remove": library_org.remove_from_collection,
              "reorder": library_org.reorder_collection}[op]
        return fn(store, args["slug"], [str(r) for r in args["refs"]], project_id=project)
    if action == "note":
        op = _op(args, ("add", "list", "edit", "remove"))
        if op == "add":
            _need(args, "ref", "text")
            return library_org.add_note(store, args["ref"], args["text"], project_id=project)
        if op == "list":
            _need(args, "ref")
            return {"notes": library_org.list_notes(store, args["ref"], project_id=project)}
        if op == "edit":
            _need(args, "note_id", "text")
            return library_org.edit_note(store, args["note_id"], args["text"])
        _need(args, "note_id")
        return library_org.remove_note(store, args["note_id"])
    if action == "keys":
        op = _op(args, ("check", "assign", "freeze", "rekey"))
        if op == "check":
            return library_keys.check(store, template=args.get("template"))
        if op == "assign":
            return library_keys.assign_missing(store, template=args.get("template"))
        _need(args, "ref")
        if op == "freeze":
            _need(args, "label")
            return library_keys.freeze(store, args["ref"], args["label"], project_id=project)
        return library_keys.rekey(store, args["ref"], to=args.get("to"), template=args.get("template"),
                                  reason=args.get("reason") or "", apply=bool(args.get("apply")), project_id=project)
    if action == "dedupe":
        return find_duplicates(store, limit=int(args.get("limit") or 50))
    if action == "merge":
        _need(args, "keep", "drop")
        if args.get("apply"):
            return merge_apply(store, args["keep"], args["drop"], reason=args.get("reason") or "",
                               prefer=args.get("prefer") or "keep", project_id=project)
        return merge_plan(store, args["keep"], args["drop"], project_id=project, prefer=args.get("prefer") or "keep")
    if action == "doctor":
        return doctor(store, template=args.get("template"), cwd=workspace())
    _need(args, "items")  # set_integrity
    return set_integrity(store, [i for i in args["items"] if isinstance(i, dict)], project_id=project)


def error_code(exc: Exception) -> str:
    return getattr(exc, "code", None) or "internal"
