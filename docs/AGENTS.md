# Agents and browsing

The Academic Harness preset adds a specialist roster and two model-pinned delegation tools on top of DSH's normal delegation. The goal is to route a task to the model that fits it instead of running everything on whatever model the current chat session happens to be on.

![Subagent routing](assets/diagrams/subagent-routing.svg)

## Subagent model routing

Besides the plain `subagent`/`subagent_fork` delegation tools, the `academic-harness` preset adds two optional, user-triggered model-routed tools. Each can register a custom OpenAI/Anthropic-compatible route from its endpoint URL, model, and API key; with no complete route it inherits the session model:

| Tool | Use it for | Route (Settings or env) | Default |
|---|---|---|---|
| `subagent` | Delegated work, including difficulty-bound and image-reading tasks when the session model supports images | — (inherits the parent session's model) | — |
| `subagent_fork` | Forked delegation that inherits the parent preset and history | — (inherits the parent) | — |
| `subagent_pro` | Difficulty-bound work, only when the user explicitly asks for the Pro route or says a custom Pro route is configured | Pro endpoint URL + model + API key (Settings) | Inherit session model |
| `subagent_vision` | Image-reading work with `read_image` — only when the user explicitly asks for the Vision route or says a custom Vision route is configured | Vision endpoint URL + model + API key (Settings) | Inherit session model |

Both routes are optional and user-triggered: use Pro or Vision only when the user explicitly asks for that route or says a custom route is configured. Otherwise `subagent` handles the task, including image reading when the session model supports images. A request to "delegate" or "use a subagent" is not a request for Pro or Vision; this applies to image tasks too. Set the endpoint URL, model, and API key to register a custom OpenAI/Anthropic-compatible route; with none set they inherit the session model (DeepSeek-V4.1-Flash by default). A partial set is ignored. The endpoint URL selects Anthropic Messages when it contains `anthropic` (for example `https://api.deepseek.com/anthropic`) and OpenAI Chat Completions otherwise. The plugin registers the route on the host's pi-ai adapter and stores the key in the credential service. The legacy model names `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are still accepted by the API, but those models have been retired and their requests are served by Flash.

All four delegation tools use DSH 0.2.1's managed activations: a call returns a `subagentId` immediately, the child's final answer arrives as a completion notice, and `send_message` / `interrupt_agent` handle follow-ups and stops.

`subagent` is deliberately left without a pinned model: it inherits whichever model the session is already on. Forcing every delegation onto a hardcoded model id would break delegation outright wherever that id isn't registered under the session's provider. The two optional routes also inherit the session model unless a model is configured.

### What gets routed to `subagent_pro`

The system prompt steers `subagent_pro` toward difficulty, not length, but **only when the user explicitly asks for the Pro route or says a custom route is configured**. Otherwise use `subagent`; never infer that a Pro route exists. With no route, `subagent` is the same delegation on the session model:

- verifying a mathematical derivation step-by-step,
- propagating uncertainty through a multi-stage calculation,
- a causal-inference critique (spotting a hidden confounder, weighing conflicting evidence across several studies),
- tracing a subtle methodological flaw through many interacting parts (data leakage in a multi-stage ML pipeline, a silently-wrong nested cross-validation setup),
- multi-step reaction-mechanism or pathway reasoning,
- large multi-file refactors that need many call sites kept consistent.

It explicitly steers away from routine review, lookup, simple data validation, or literature search, since those get the same quality on plain `subagent` for a fraction of the cost and latency.

### What gets routed to `subagent_vision`

Use `subagent_vision` only when the user explicitly asks for the Vision route or says a custom Vision route is configured; otherwise use `subagent` (or read the image directly when the session model supports it). Do not choose it merely because the task involves an image or because the user said "use a subagent"; only the user naming the Vision route (or declaring a custom Vision route) opts in. `subagent_vision` only routes the child to a model; the child still calls `read_image` (`@deepseek-ai/dsh-tool-fs`) itself, which refuses to read an image unless the calling route's resolved model actually declares `image` input in this deployment's model catalog. A custom vision endpoint must declare image input; with no custom route the session model is used (DeepSeek-V4.1-Flash accepts images).

When the user has asked for the Vision route, use it for scientific reading tasks such as:

- interpreting a plot or trend,
- comparing panels in a multi-panel figure,
- reviewing a microscopy/gel/medical-imaging scan for qualitative features,
- checking a chemical structure/phylogenetic tree/pathway diagram for correctness,
- comparing a generated figure against what was asked for.

It also covers a case text tools can't: auditing a compiled LaTeX PDF's page layout — a table split across a page break, a table or figure that drifted into the references section, an overfull line, a caption stranded from its figure. Since `read_image` only accepts PNG/JPEG/WebP/GIF, the agent renders the PDF pages first with `pdftoppm -png -r 150 file.pdf page` (poppler, usually already present alongside TeX Live) before delegating.

### Configuration

Set the endpoint URL, model, and API key for Pro and Vision in Settings → Academic Harness API keys (or the matching `SUBAGENT_PRO_*` / `SUBAGENT_VISION_*` env vars; env wins). Set all three fields to register the custom route; leave all three blank to inherit the session model, and a partial set is ignored. The endpoint URL selects Anthropic Messages when it contains `anthropic` and OpenAI Chat Completions otherwise. The plugin writes the route onto the host's pi-ai adapter and stores the key in the credential service. These fields need a `dsh` restart to take effect (see [Configuration](CONFIGURATION.md#when-a-change-takes-effect)).

## Specialist briefs and skills

The preset carries specialist briefs for the `subagent` tool (code-reviewer, literature-researcher, and others) and the full skill catalogue. The 745 bundles in `skills/` include research-discipline workflows, domain skills, expert-reasoning profiles, and the local tools' workflow skills; see [Skills](SKILLS.md).

## Browsing the web

Built-in `web_search` works (DeepSeek search provider). Built-in `web_fetch` retrieves public HTTP(S) pages through the local HTTP provider; if a page is blocked, needs JavaScript, or returns `WEB_PROVIDER_UNAVAILABLE`, the agent falls back to `mcp__parallel__web_fetch`, `parallel_extract`, or `mcp__firecrawl__firecrawl_scrape` (Firecrawl needs `FIRECRAWL_API_KEY`). DeepSeek's Search and Fetch APIs can be enabled in Web Search settings.

For anything that needs a real rendered browser — exploring a site interactively, logging in, filling out a form, clicking through to a dataset download, or verifying a page actually renders correctly — the agent loads the bundled `agent-browser` skill (`skills/agent-browser`, shipped and seeded the same way as the other skills) and drives the [agent-browser](https://github.com/vercel-labs/agent-browser) CLI directly via `bash`.

The CLI isn't bundled with this plugin's package, but the agent installs it itself when missing (`npm i -g agent-browser && agent-browser install`, or `npx agent-browser@latest ...` for a one-off task) rather than asking the user to.

Most of what it does — navigating, reading, filling forms, extracting data, downloading files — works off an accessibility-tree snapshot and needs no image at all. The one exception is `screenshot`: since the session's own model isn't guaranteed to have vision input, the skill steers the agent to delegate reading any screenshot to `subagent_vision` (see above) instead of guessing at its content.

## Related

- [Search](SEARCH.md) — the connectors behind the fallback paths.
- [Compute](COMPUTE.md) — GPU work that should not run locally.
- [Skills](SKILLS.md) — the complete catalogue.
- [Configuration](CONFIGURATION.md) — model ids and keys.
