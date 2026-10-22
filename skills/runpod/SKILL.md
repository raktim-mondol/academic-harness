---
name: runpod
description: "Use Runpod for GPU/CPU remote compute beyond what the runpod_run tool covers — serverless endpoints, network volumes, Hub templates, SSH/file transfer."
---

# runpod

Load this before any Runpod task that is more than "run one command on a GPU and get the result back" — that narrower case is already covered by the built-in `runpod_run` tool (upload `files_in`, run `command`, download `files_out`, always terminates the pod; pass `volume_name` to persist data across calls on a Runpod network volume).

Reach beyond `runpod_run` — via the `bash` tool and the `runpodctl` CLI — for anything it doesn't do: deploying a Serverless endpoint, browsing/deploying a Hub template, managing network volumes directly, `send`/`receive` file transfer, or checking GPU/data-center availability before picking an instance.

## Prerequisites

- `RUNPOD_API_KEY` (Settings -> Academic Harness API keys, or env) — same credential `runpod_run` uses. `export RUNPOD_API_KEY=...` before calling `runpodctl` non-interactively — `runpodctl doctor` is interactive/human-only (also sets up SSH keys) and should not be run by the agent.
- The `runpodctl` binary on `PATH`. **Install it yourself if it's missing** — don't ask the user to do it, and don't use the official `curl -sSL https://cli.runpod.net | bash` installer (it demands root). Fetch the plain release binary into a user-writable dir instead:

  ```bash
  if ! command -v runpodctl >/dev/null 2>&1; then
    mkdir -p "$HOME/.local/bin"
    os=$(uname -s | tr '[:upper:]' '[:lower:]')            # linux / darwin
    arch=$(uname -m); case "$arch" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; esac
    curl -fsSL "https://github.com/runpod/runpodctl/releases/latest/download/runpodctl-${os}-${arch}" -o "$HOME/.local/bin/runpodctl"
    chmod +x "$HOME/.local/bin/runpodctl"
    export PATH="$HOME/.local/bin:$PATH"
  fi
  runpodctl version
  ```

  This needs no root and survives for the rest of the session (re-export `PATH`, or re-run the snippet, in a fresh shell/session). Windows isn't covered above — on Windows use WSL, or point the user at the `.exe` asset in the same release.

## Working with runpodctl

The CLI surface moves faster than any static doc, so treat `--help` as authoritative over anything below:

```
runpodctl version                     # confirm the build before relying on any flag
runpodctl gpu list                    # GPU types and availability
runpodctl datacenter list             # availability per data center (co-locate GPU + volume)
runpodctl pod create --help           # inspect current flags before creating
runpodctl pod list / pod terminate    # manage running pods
runpodctl serverless create --help    # deploy a Serverless endpoint
runpodctl hub search <query>          # find a prebuilt template/endpoint on the Hub
runpodctl send <file> / receive <code>  # ad hoc file transfer outside a runpod_run call
```

Old `runpodctl` builds silently lack newer flags and produce confusing errors — if a command behaves unexpectedly, check `runpodctl version` before assuming the task is wrong.

## Choosing a lane

- One-shot command on a GPU, with the plugin handling upload/download/cleanup: `runpod_run`.
- Multi-step workflow reusing the same dataset/checkpoints: `runpod_run` with `volume_name`.
- Anything else (Serverless, Hub templates, volume/SSH management, availability checks): `runpodctl` via `bash`.

Always account for compute cost (report it, as `runpod_run` already does) and never leave a pod or Serverless endpoint running when the user's task is done — terminate what you created.
