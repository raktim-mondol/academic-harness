# Academic Harness in ResearchCraft — open decision

Status: **deferred** (2026-10-05). Keep the current layout until we pick one of the options below.

## What is shipped now (v0.13.2)

The writing oracle (inventory, facts, T0–T6 checks, ledger, briefs, plans, reviews, guard, gate) runs **inside this plugin**. Pi is not required. Nothing is installed into `$DSH_HOME`.

| Piece | Path |
|---|---|
| Python engine | `vendor/academic-harness/` (`ah/` package, ~57 files / ~8.6k lines / ~600 KB) |
| Local venv (gitignored) | `vendor/academic-harness/.venv` |
| Native tools | `academic-harness.js` |
| Guard / post-edit / gate / paper-state | `academic-harness-hooks.js` |
| CLI / venv helper | `academic-harness-cli.js` |
| Skills | `skills/academic-harness`, `skills/ah-*` |

Upstream pin: `raktim-mondol/academic-harness` commit `dbc7414662c776b55e9da87c798d1ad08bf1c941`. See `vendor/academic-harness/SOURCE.txt`.

The engine **must** live in the plugin somehow. DSH does not run Pi, and without this code the `ah_*` tools have nothing to call.

## Decision (pick later)

`vendor/academic-harness/` is a **shipping name**, not a second DSH plugin.

1. **Keep it vendored** (current). Honest about origin; plugin stays self-contained.
2. **Move first-party** — same Python tree at e.g. `ah/` at the plugin root; drop the `vendor/` label.
3. **Rewrite in JavaScript** — then the Python tree can go. That is a full port of those ~8.6k lines, not a small cleanup.

Do not start (2) or (3) until this is chosen.

## Runtime

First ResearchCraft start creates the plugin-local `.venv` (via `uv`, or `python -m venv` + pip). Override: `ACADEMIC_HARNESS_CLI` / `AH_CMD`. Skip: `ACADEMIC_HARNESS_SKIP_INSTALL=1`.

Inactive outside a directory tree with `ah.yaml`.
