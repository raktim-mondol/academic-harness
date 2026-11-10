# Host compatibility

Academic Harness is a plugin for the DeepSeek Harness (DSH). This page says which host builds it is developed and tested against, and what each check proves.

## Supported combination

| Piece | Version | Where it comes from |
|---|---|---|
| Plugin-pinned tool packages | `ah-dsh-tools`, `ah-dsh-tool-subagent`, `ah-dsh-mcp-client` at **0.2.1-rc.5** | `package.json` |
| Host CLI used in `verify.yml` | **0.2.1-rc.5** (pinned on purpose; an unpinned CLI once sent npm into a peer-resolution loop) | `.github/workflows/verify.yml` |
| Host used day to day by the maintainer | **0.2.2-rc.1** | local install |
| Host builds booted daily | the `latest` and `next` npm channels, with npm and pnpm | `.github/workflows/dsh-compat.yml` |

The plugin is expected to work on 0.2.1-rc.5 and 0.2.2-rc.1. Anything newer is covered only by the daily boot and the contract check below until it is added to this table.

## What each check proves

- **`npm test`** drives the plugin's listeners and tools with a fake host (`scripts/helpers/fake-host.mjs`). It proves the plugin answers correctly. It does not prove a real host routes the answer.
- **`scripts/check-host-contract.mjs <dir>`** reads the installed host's own type declarations and pipeline and fails when a seam the plugin depends on moves: `tools/pre-execute` may return `{kind: 'ask'}`, the `approval` service is read with `ctx.get('approval')`, and `request()` resolves to `allowed-once | rejected | cancelled | unavailable`. It runs in `verify.yml` against the pinned host and in `dsh-compat.yml` against `latest` and `next`. It passed locally on the 0.2.1-rc.5 packages in `node_modules` and on a global 0.2.2-rc.1 install.
- **`dsh-compat.yml`** installs the plugin into a throwaway profile, boots the host against a stub provider and creates a preset session. It proves the plugin loads and a session starts.

## Not covered by CI

These need a real host and a browser, and are run by hand in an isolated DSH home (never the maintainer's daily instance):

- the approval prompt as a person sees it (reject, allow, cancel);
- delegated sub-agent sessions end to end;
- whether a registered MCP entry mounts on session start for a given host build and on restored sessions. The plugin now mounts only approved entries, so an unapproved entry never starts either way.
