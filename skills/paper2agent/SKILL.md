---
name: paper2agent
description: Convert research papers and associated files, research code, or both into a reviewed paper skill and tested MCP server. Use for paper-only, code-only, or combined conversions and resumes. Use when the user asks to agentify a paper, turn a methods paper plus its repo into MCP tools, or build a paper skill from PDFs.
license: MIT
metadata:
  version: "1.0"
  skill-source: https://github.com/jmiao24/Paper2Agent
  skill-commit: "8c2d059165ef8cdcb70dbea76655b9c2b55b38e6"
---

# Paper2Agent

## Academic Harness on DSH

This copy is `jmiao24/Paper2Agent` `skills/paper2agent` (commit `8c2d059`), mapped onto this plugin. Scientific procedure and Python helpers are unchanged.

- Load with the `skill` tool. There is no `/paper2agent` or `$paper2agent` command, and no `claude mcp add`.
- Missing paper URL/DOI, repository, or output directory: `ask_user_question`. Do not invent them.
- Paper PDFs: `paper_download` (DOI) then [Paper2Skill](paper2skill/SKILL.md). `pdf_to_markdown` is a fast unreviewed preview only — never the delivered paper skill.
- Specialists: `subagent` (managed activation). Every call returns `{ kind: "activation", subagentId }` immediately; keep that id as schema-1 `agent_id` in `reports/agent-runs.json`, wait for each child's completion notice, and read its report before the next workflow gate. A `.done_*` file means work ended, not that it passed.
- Independent verifiers: a **new** `subagent` spawn. Never `subagent_fork`. Never `send_message` into an implementer.
- Heavy implement/verify: `subagent_pro`. Paper2Skill page/figure inspection: `subagent_vision` after `pdftoppm`.
- Python: `uv venv` / `uv pip install --python "$PROJECT_PYTHON"` / `uv run`. Never bare `pip`/`python`.
- GPU `required`: `runpod_run` or `modal_run` for execution and verification. Do not silently fall back to CPU.
- Log conversion stages with `notebook` (`method` / `observation` / `decision`).
- After a verified Paper2Skill package: write it under workspace `dist/` and `ask_user_question` whether to copy it to `$DSH_HOME/skills/<id>-paper` (recommend yes for this workspace).
- After Paper2MCP ZIP delivery: write `<cwd>/.dsh/paper-mcps.json` (python, server entry, env **names** only, serverName). Call `paper_mcp` `register` only when the user asked to connect the server. Secrets stay in Settings/env, never in that JSON.
- A full Paper2MCP run is long. Confirm scope; honor task/tutorial filters. Report partial or blocked work. Never fake a tool.

---

Route by the supplied inputs and requested outcome. DSH's skill catalog is one level deep, so each component is its own loadable skill (not a nested folder):

- For paper PDFs and associated files, load `paper2skill` with the `skill` tool.
- For a research code repository, load `paper2mcp` with the `skill` tool.
- When both outputs are requested, load both.
- For questions about Paper2Agent's methods, results, figures, or supplementary material, load `paper2agent-paper`.

Resolve each component's scripts and references relative to **that skill's** directory (the `skill` tool prints it); bind `SKILL_ROOT` to that component. Keep their work directories separate. Independent paper and code tasks may run concurrently within host limits. Every MCP tool must bind to existing repository code.

Combined output:

```text
dist/<project>-agent/
├── skill/<paper-name>/
└── mcp/<repository-name>-mcp/
```

Build the paper skill at its final component path and pass its strict verification. Complete Paper2MCP's existing runtime and ZIP delivery checks, then stage the verified archive contents under `mcp/` and confirm the files are unchanged. Keep review and development evidence outside the delivery.

Single-mode runs retain their component's output contract. Report delivery paths, verification results and limitations. If either component is blocked, report the combined result as partial.
