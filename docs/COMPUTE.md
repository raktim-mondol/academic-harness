# Remote compute

`modal_run` and `runpod_run` offload a command to a remote CPU/GPU instance — upload inputs, run, download outputs, and always terminate when done.

![Remote compute flow](assets/diagrams/compute-flow.svg)

## Credentials

| Tool | Key (Settings or env) | Get credentials |
|---|---|---|
| `modal_run` | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | <https://modal.com/settings> |
| `runpod_run` | `RUNPOD_API_KEY` | <https://console.runpod.io/user/settings> |

`runpod_run` works with its API key alone (`ssh`, `scp`, and `ssh-keygen` must also be on `PATH`).

`modal_run` additionally needs the optional Modal SDK, which Academic Harness deliberately does not install so that Add Plugin never blocks on native build scripts. Install it into the profile and restart DSH:

```sh
dsh plugin --profile <profile> add modal
```

Without it, `modal_run` returns an `sdk_missing` message with the same instruction; `runpod_run` remains available.

## Runpod storage

By default every `runpod_run` call is a brand-new, disposable pod — `/workspace` (and anything uploaded into it) is gone once the pod terminates, so only what's named in `files_out` comes back.

Pass `volume_name` to persist data across calls instead: it mounts a Runpod [network volume](https://docs.runpod.io/pods/storage/create-network-volumes) at `/workspace`, and reusing the same `volume_name` on a later call reattaches the same storage — e.g. upload a large dataset once, then run several training/eval passes against it without re-uploading it with `files_in` each time.

The volume is looked up by name and created automatically the first time it's used, which requires `data_center_id` (network volumes are pinned to a data center); `volume_size_gb` (default 20) only applies when creating a new one. The pod's compute is always deleted after the call regardless — a named volume is not, and keeps costing storage until deleted from the Runpod console (this tool has no delete-volume path, so it won't silently remove a dataset).

## Beyond the two tools

For anything beyond what `modal_run`/`runpod_run` cover — Serverless endpoints, Hub templates, direct volume/secret management, a deployed app, checking GPU availability — the agent loads the bundled `runpod`/`modal` skills (`skills/runpod`, `skills/modal`) and drives the `runpodctl`/`modal` CLIs directly via `bash`.

Neither CLI ships inside this plugin's package, but the agent installs whichever it needs itself, user-locally and without root, per the steps baked into each skill:

- `runpodctl` as a plain release binary into `~/.local/bin`,
- `modal` via `uvx modal ...` (no persistent install needed) or `uv tool install modal` for a longer session.

The agent does this rather than asking you to set it up first.

## API version note

`runpod_run`/`runpod-client.js` talk to Runpod's REST v1 API (`https://rest.runpod.io/v1`), which Runpod has flagged for retirement on 2026-11-15 in favor of REST v2 — no action needed yet, but worth knowing before that date.

## Related

- [Agents](AGENTS.md) — when to delegate work instead of running it locally.
- [Configuration](CONFIGURATION.md) — keys and restart behavior.
- [Skills](SKILLS.md) — the `modal` and `runpod` skills.
