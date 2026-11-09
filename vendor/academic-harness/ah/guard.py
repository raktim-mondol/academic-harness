"""Guard logic that does not depend on any agent: protected paths, anchor loss, shell writes, author-only commands.

Mirrors packages/ah-pi/src/lib.ts (same rules, same tests). The Claude Code hooks use this module; the Pi extension keeps its
TypeScript copy so it needs no Python at the edge.
"""
from __future__ import annotations

import re

ANCHOR_LINE = re.compile(r"^\s*%%\s*@unit\s+(\S+)")


def glob_to_regex(glob: str) -> re.Pattern:
    out, i = "", 0
    while i < len(glob):
        c = glob[i]
        if c == "*":
            if glob[i + 1: i + 2] == "*":
                out += ".*"
                i += 1
                if glob[i + 1: i + 2] == "/":
                    i += 1
            else:
                out += "[^/]*"
        elif c == "?":
            out += "[^/]"
        else:
            out += re.escape(c)
        i += 1
    return re.compile(f"^{out}$")


def normalize_rel(p: str) -> str:
    parts: list[str] = []
    for seg in p.replace("\\", "/").split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if parts:
                parts.pop()
        else:
            parts.append(seg)
    return "/".join(parts)


def rel_to_root(root: str, cwd: str, p: str) -> str | None:
    """Path relative to the project root, or None when it lies outside it."""
    absp = p if p.startswith("/") else f"{cwd.rstrip('/')}/{p}"
    r, a = normalize_rel(root), normalize_rel(absp)
    if a != r and not a.startswith(r + "/"):
        return None
    return "" if a == r else a[len(r) + 1:]


def is_protected(rel: str, globs: list[str]) -> str | None:
    return next((g for g in globs if glob_to_regex(g).match(rel)), None)


def anchor_ids(text: str) -> list[str]:
    return [m.group(1) for l in text.split("\n") if (m := ANCHOR_LINE.match(l))]


def has_prose(text: str) -> bool:
    return any(l.strip() and not l.strip().startswith("%") for l in text.split("\n"))


def anchors_lost(before: str, after: str) -> list[str]:
    """Anchors in `before` missing from `after`. Deleting a whole paragraph (nothing but whitespace or comments left) is allowed."""
    if not has_prose(after):
        return []
    kept = set(anchor_ids(after))
    return [a for a in anchor_ids(before) if a not in kept]


WRITE_VERB = re.compile(r"(>>?|\btee\b|\bsed\s+-[a-zA-Z]*i|\brm\b|\bmv\b|\bcp\b|\binstall\b|\btruncate\b|\bchmod\b|\bchown\b|\bdd\b|\bsqlite3\b|\bgit\s+(checkout|restore|reset|clean|stash)\b)")
INTERPRETER = re.compile(r"\b(python[0-9.]*|perl|ruby|node|bash|sh)\b")
SCRIPT_WRITE = re.compile(r"""(write\(|['"]w[b+]?['"]|['"]a[b+]?['"]|os\.remove|unlink|shutil|rename\(|writeFile|appendFile|>\s*['"]?[\w./-])""")


def bash_writes_protected(cmd: str, globs: list[str], root: str, cwd: str) -> str | None:
    mentions: list[str] = []
    for tok in re.split(r"""[\s;|&()<>'",=]+""", cmd):
        if not tok or tok.startswith("-"):
            continue
        rel = rel_to_root(root, cwd, tok)
        if rel and is_protected(rel, globs):
            mentions.append(rel)
    for m in re.finditer(r">>?\s*([^\s;|&]+)", cmd):
        rel = rel_to_root(root, cwd, m.group(1).strip("\"'"))
        if rel is not None and is_protected(rel, globs):
            mentions.append(rel)
    if not mentions:
        return None
    if WRITE_VERB.search(cmd):
        return mentions[0]
    if INTERPRETER.search(cmd) and SCRIPT_WRITE.search(cmd):
        return mentions[0]
    return None


def bash_is_human_only(cmd: str) -> str | None:
    if re.search(r"\bfinding\s+waive\b", cmd):
        return "waiving a finding is the author's decision"
    if re.search(r"\bproposals\s+(accept|reject)\b", cmd):
        return "accepting or rejecting a fact proposal is the author's decision"
    if re.search(r"\bbrief\s+approve\b", cmd):
        return "approving a brief is the author's decision"
    if re.search(r"\bplan\s+approve\b", cmd):
        return "approving an outline plan is the author's decision"
    if re.search(r"\bclaims\s+verify\b", cmd):
        return "verifying a claim is the author's decision"
    if re.search(r"\breview\s+set\b[^;|&]*--status[\s=]+declined\b", cmd):
        return "declining a reviewer's point is the author's decision"
    if re.search(r"\bah\b[^;|&]*--yes\b", cmd) or "AH_ASSUME_YES" in cmd:
        return "--yes confirms on the author's behalf"
    return None


def new_findings(baseline: set[str], current: list[dict], levels: list[str] | None = None) -> list[dict]:
    return [f for f in current if f["fp"] not in baseline and (not levels or f["level"] in levels) and f.get("state") not in ("waived", "decision-needed")]   # a finding handed to the author is theirs to decide; steering the agent again only loops


def format_findings(fs: list[dict], mx: int = 8) -> str:
    lines = [f"- {f['fp'][:8]} {f['check']} [{f['level']}] {f.get('unit') or f.get('file') or '-'}"
             + (f" ({f['file']}:{f.get('line') or '?'})" if f.get("file") and f.get("unit") else "") + f": {f['message'][:200]}" for f in fs[:mx]]
    if len(fs) > mx:
        lines.append(f"- ... {len(fs) - mx} more")
    return "\n".join(lines)
