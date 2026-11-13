# Deferred tool loading (D40)

**Status: measured, not enabled.** No Academic Harness tool is marked `deferLoading`, and a test keeps it that way until the activation step below exists.

## What the tool surface costs

`node scripts/measure-tool-surface.mjs` loads every plugin module with a recording context and sums the wire size of each definition (name, description, parameters). At this commit: **136 tools, about 294,000 characters (roughly 73,000 tokens), resent on every step.** That is the same order as the skill catalogue D39 removed (about 290,000 characters). The twenty largest tools (`coscientist`, `review`, `experiment_log`, `rebuttal`, `deep_research`, `deep_review`, `analysis_run`, `citation`, `provenance_audit`, ...) are each 4,000 to 11,000 characters, mostly action-by-action parameter documentation.

## Why nothing is deferred yet

`defineTool({ deferLoading: true })` is preserved by the tool registry and sent to the model API as `defer_loading`. What the host does next depends on the route:

- A route with no `toolUpdate` setting strips the flag, so the tool loads immediately and nothing is saved.
- A route with `toolUpdate` set (the DeepSeek catalogue default is `addition-only`) keeps the tool deferred. The host's own wording: *"declaring a deferred tool does not activate it"*; a deferred baseline tool stays deferred **until its first retained `tool-addition` developer message**. In the 0.2.2-rc.1 host that is read from session history; nothing in the host ships a tool-search or activation tool that writes it.

So deferring a tool without something that appends the `tool-addition` record would make that tool uncallable on the main route. Saving 70,000 tokens is not worth silently removing 136 tools. This plugin has no safe way to write that record from a plugin today, and it cannot be checked without a live host (the deferred live-verification list).

## What would make it safe

1. An activation path the plugin can rely on: either a host tool-search that appends `tool-addition`, or a documented plugin API to append one for a named tool (with the header sequence the host requires).
2. Feature detection at startup, so a host without it keeps every tool immediate.
3. A live check on both host lines that a deferred tool is announced, becomes callable after activation, and survives a restored session.

## Cheaper steps that need no host support

- Shorten the largest descriptions: the action list in a tool's `description` repeats what each parameter already says. Measure with the script before and after.
- Split a very large tool only when its actions are used by different tasks.

Re-run the measurement after any change to a tool definition; the total is the number to watch.
