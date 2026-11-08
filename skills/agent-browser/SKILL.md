---
name: agent-browser
description: "Browse and interact with live websites — navigate, fill forms, extract data, download datasets/files — when web_search/web_fetch can't reach rendered or interactive content. Inspect screenshots with read_image on an image-capable model; report when vision is unavailable."
---

# agent-browser

Load this when a research task needs a real, rendered browser rather than a text fetch — `web_search`/`web_fetch` and `mcp__firecrawl__*` cover plain pages and search, but not JS-rendered content, logins, forms, multi-step navigation, or clicking through to a download. Typical triggers: "find and download this dataset," "log into X and pull Y," "explore this site and tell me what's there," "fill out/submit this form," "does this page actually render correctly."

## Install

Missing `agent-browser` isn't a reason to ask the user — install it yourself, no root needed:

```bash
npm i -g agent-browser && agent-browser install   # persistent install, once
# or, for a single ad hoc task:
npx agent-browser@latest <command>...
```

`agent-browser install --with-deps` additionally pulls required browser libraries on Linux hosts if a run fails with a missing-dependency error.

## Before anything else

Read the CLI's own live docs — commands move faster than any static reference:

```bash
agent-browser skills get core --full
```

Then set a named session for the task (the default session is shared machine-wide and can hijack another agent's page):

```bash
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix research)"
```

## The core loop

```bash
agent-browser open <url>
agent-browser snapshot -i       # interactive elements only, ~200-400 tokens
agent-browser click @e3         # act on a ref from the snapshot
agent-browser snapshot -i       # re-snapshot — refs go stale after any page change
```

Use `agent-browser read <url>` instead of `open`+`snapshot` for plain reading (docs, articles) — it prefers markdown and needs no browser session at all for many sites.

## Downloading data

```bash
agent-browser download <sel> <path>     # download by clicking the element that triggers it
agent-browser read <direct-file-url>    # or fetch a direct URL straight into the workspace
```

Save into the workspace (e.g. `user_data/` or wherever the task's other inputs live), not `/tmp`, so the downloaded dataset is visible to the rest of the session.

## Screenshots need a vision model

`agent-browser screenshot <path>` is the right call whenever the accessibility-tree snapshot isn't enough to judge a page — visual layout, a chart/canvas/image-heavy page, a CAPTCHA, confirming something *looks* right.

```bash
agent-browser screenshot page.png
```

Read `page.png` with `read_image` on an image-capable session model. The host checks whether the active route supports images. If image reading is unavailable, report that the visual check could not be performed; do not substitute OCR or guess at on-screen content, layout, or chart values.

## Cleanup

Always run `agent-browser close` (or `close --all`) when the task is done — the daemon otherwise keeps a browser alive for up to an hour of inactivity by default.
