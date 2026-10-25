---
name: vastai
description: "Use Vast.ai for cost-optimized GPU marketplace compute beyond what the vastai_run tool covers — bidding, spot instances, volumes, CLI/API control, multi-GPU offers."
---

# vastai

Load this before any Vast.ai task that is more than "rent the cheapest GPU that fits, run one command, get the result back" — that narrower case is already covered by the built-in `vastai_run` tool (searches live offers, rents one, uploads `files_in`, runs `command`, downloads `files_out`, destroys the instance; pass `bid_price` for spot, `volume_id` for an existing volume).

Reach beyond `vastai_run` — via the `bash` tool and the `vastai` CLI — for anything it doesn't do: browsing offer markets interactively, changing a bid, managing volumes, reserved instances, serverless endpoints, VM instances, or attaching an SSH key to an already-running container.

## Prerequisites

- `VAST_API_KEY` (Settings -> Academic Harness API keys, or env) — same credential `vastai_run` uses. Get it at <https://cloud.vast.ai/manage-keys/>.
- The `vastai` CLI (and Python SDK) in one package. **Install it yourself if it's missing** — don't ask the user to do it:

  ```bash
  if ! command -v vastai >/dev/null 2>&1; then
    uv tool install vastai        # or: python3 -m pip install --user vastai
    # one-off alternative: uvx vastai ...
  fi
  vastai --version
  ```

  Prefer `uv tool install` / `pip --user` over the `curl -fsSL https://vast.ai/install.sh | bash` installer so nothing needs root.
- SSH keys must be registered **before** an instance exists. `vastai_run` registers a temporary per-call key and removes it afterwards; a CLI-driven instance needs a key already on the account:

  ```bash
  vastai show ssh-keys
  vastai create ssh-key ~/.ssh/id_ed25519.pub   # only if absent
  ```

## Working with the CLI

The CLI moves faster than any static reference — treat `vastai <command> --help` as authoritative:

```bash
vastai show user --raw                        # auth check + credit balance
vastai search offers 'gpu_name=RTX_4090 num_gpus=1 verified=true rentable=true' \
  -o 'dph_total' --limit 5 --raw              # offers; CLI gpu_ram is GB, REST is MB
vastai create instance <OFFER_ID> \
  --image vastai/pytorch:@vastai-automatic-tag \
  --disk 50 --ssh --direct --label agent-run-01 --raw
vastai show instance <ID> --raw                # poll actual_status
vastai ssh-url <ID>                            # ssh://root@<host>:<port>
vastai execute <ID> "nvidia-smi"
vastai logs <ID> --tail 100
vastai copy local:./src/ <ID>:/workspace/src/  # never copy to / or /root
vastai stop instance <ID>                      # GPU billing stops; disk billing continues
vastai destroy instance <ID> -y                # permanent; -y is mandatory for agents
```

## Pitfalls that break agent runs

- **Spot pricing**: searching with `--type bid` returns `min_bid`, but `create instance` charges on-demand unless `--bid_price <price>` is passed. `vastai_run` sends `price` for you when `bid_price` is set.
- **Terminal states**: once `actual_status` is `exited`, `unknown`, or `offline` it never reaches `running`. Destroy and retry another offer instead of polling forever.
- **Destroy, don't stop**: `stop` keeps accruing storage charges; `destroy` is the only teardown that stops all billing.
- **Never write to `/` or `/root`**: copying there corrupts `.ssh/authorized_keys` permissions and locks you out. Use `/workspace/...`.
- **`onstart` is capped at 4,048 characters**; use `vastai copy` afterwards for anything longer.
- **Env visibility**: variables passed at create time reach the container entrypoint, not interactive SSH login shells; prepend `env >> /etc/environment` in `onstart` if a later SSH command needs them.
- **Runtypes**: `ssh_direct` (port 22) and `jupyter_direct` (8080 + 22) replace the image entrypoint; `args` preserves it but disables SSH. `vastai_run` uses `ssh_direct`.

## REST API notes

`vastai_run` uses the REST API directly (`https://console.vast.ai/api/v0`, Bearer auth):

- Search offers: `POST /bundles/` (filters such as `gpu_name`, `num_gpus`, `gpu_ram` in MB, `dph_total`; `order: [["dph_total","asc"]]`).
- Create: `PUT /asks/{offer_id}/` → `{"success":true,"new_contract":<instance_id>}`. `env` is a Docker-flag **string**, not an object.
- Status/destroy: `GET`/`DELETE /instances/{id}/`; SSH host and port come back as `ssh_host` / `ssh_port`.
- SSH keys: `POST /ssh` with `{"ssh_key": "..."}`, then `DELETE /ssh/{id}`.

## Choosing a lane

- One-shot GPU command, cheapest matching offer, automatic teardown: `vastai_run`.
- Spot/interruptible or a pinned offer: `vastai_run` with `bid_price` / `offer_id`.
- Persistent data: `vastai_run` with a pre-created `volume_id`.
- Bidding changes, multi-instance fleets, serverless, VMs, or interactive market browsing: `vastai` CLI via `bash`.

Always destroy what you created and report the offer's `dph_total` and the estimated cost, as `vastai_run` does.
