# Remote GPU Agent Documentation

This reference manual provides complete implementation specifications for autonomous AI agents and developers provisioning, executing, monitoring, and tearing down remote GPU workloads across **Runpod**, **Modal**, and **Vast.ai**. It covers official agent skills, Model Context Protocol (MCP) servers, command-line interfaces (CLIs), software development kits (SDKs), and REST APIs.

---

## Provider Architecture Comparison

Each provider targets a distinct abstraction layer for GPU workloads, ranging from serverless Python functions to containerized pods and decentralized marketplace machines ([Runpod Docs](https://docs.runpod.io/api-reference-v2/overview), [Modal Docs](https://modal.com/docs/sdk/py/latest), [Vast.ai Docs](https://docs.vast.ai/api-reference/introduction)).

| Capability | Runpod | Modal | Vast.ai |
| :--- | :--- | :--- | :--- |
| **Primary Compute Model** | Persistent GPU Pods, Autoscaling Serverless Endpoints, Instant Clusters ([Runpod API v2](https://docs.runpod.io/api-reference-v2/overview)) | Serverless Python Functions, Classes, Web Endpoints, Isolated Sandboxes ([Modal SDK Reference](https://modal.com/docs/sdk/py/latest)) | Decentralized GPU Marketplace (On-Demand, Spot/Bid, Reserved Containers & VMs) ([Vast.ai Creating Instances](https://docs.vast.ai/api-reference/creating-instances-with-api)) |
| **Unit of Work** | OCI Docker Container or Decorator Function (`@app.task`, `@app.queue`) ([Runpod Python SDK](https://docs.runpod.io/sdk/overview)) | Python Function/Class (`@app.function`) or `modal.Sandbox` ([Modal Sandboxes](https://modal.com/docs/guide/sandboxes.md)) | Docker Container (`ssh_direct`, `jupyter_direct`, `args`) or Full VM ([Vast.ai Creating Instances](https://docs.vast.ai/api-reference/creating-instances-with-api)) |
| **Official Agent Skills** | `npx skills add runpod/runpod-plugins-official` or Claude/Codex plugin ([Runpod Agent Setup](https://docs.runpod.io/agent-setup.md)) | `modal skills install --claude -g -y` ([Modal Skills CLI](https://modal.com/docs/cli/latest/skills)) | `npx skills add vast-ai/vast-cli` ([Vast.ai Search Offers API](https://docs.vast.ai/api-reference/search/search-offers.md)) |
| **MCP Support** | Official hosted (`https://mcp.runpod.io/`) and local (`@runpod/mcp-server`) plus Docs MCP (`https://docs.runpod.io/mcp`) ([Runpod MCP Servers](https://docs.runpod.io/get-started/mcp-servers.md)) | Community Sandbox MCP (`mcp4modal_sandbox`) and native ASGI hosting for custom MCP servers ([MCP4Modal Sandbox](https://github.com/milkymap/mcp4modal_sandbox), [Modal MCP Blog](https://modal.com/resources/best-platforms-host-mcp-servers-for-claude)) | Community REST/SSH MCP servers (`dam2452/vastai-mcp`, `alperiox/vast-mcp`) and GPU-hosted MCP servers ([vastai-mcp GitHub](https://github.com/dam2452/vastai-mcp), [Vast.ai MCP Guide](https://vast.ai/article/building-your-first-mcp-server-on-vast-ai)) |
| **Official CLI** | `runpodctl` (resource CRUD, SSH, file transfer) and `rp` (app dev/deploy) ([Runpod CLI Overview](https://docs.runpod.io/runpodctl/overview.md), [Runpod Python SDK](https://docs.runpod.io/sdk/overview)) | `modal` (`run`, `serve`, `deploy`, `shell`, `volume`, `endpoint`, `container`) ([Modal CLI Reference](https://modal.com/docs/cli/latest)) | `vastai` (search, create, show, execute, logs, copy, ssh-url, volumes) ([Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)) |
| **Official SDKs** | Python (`runpod` v2.0), JavaScript (`runpod-sdk`), Go (`go-sdk`) ([Runpod Python SDK](https://docs.runpod.io/sdk/overview), [Runpod Serverless SDKs](https://docs.runpod.io/serverless/sdks.md)) | Python (`modal`), JavaScript (`modal`), Go (`modal-client/go`) ([Modal Sandboxes](https://modal.com/docs/guide/sandboxes.md)) | Python (`vastai`: `VastAI`, `SyncClient`, `AsyncClient`, `Serverless`) ([Vast.ai Python SDK Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai_sdk/SKILL.md)) |
| **REST API** | Control Plane v2 (`https://api.runpod.io/v2`) and Serverless Data Plane (`https://api.runpod.ai/v2`) ([Runpod API v2](https://docs.runpod.io/api-reference-v2/overview), [Runpod Operation Reference](https://docs.runpod.io/serverless/endpoints/operation-reference)) | Web Functions (`@modal.fastapi_endpoint`, `@modal.asgi_app`, `@modal.web_server`) ([Modal Web Functions](https://modal.com/docs/guide/webhooks.md)) | Full Platform REST API (`https://console.vast.ai/api/v0`) ([Vast.ai API Reference](https://docs.vast.ai/api-reference/introduction)) |
| **Persistent Storage** | `NetworkVolume` (datacenter-scoped) and `GlobalVolume` (cross-region) mounted at `/workspace` or `/runpod-volume` ([Runpod Network Volumes](https://docs.runpod.io/storage/network-volumes), [Runpod Python SDK](https://docs.runpod.io/sdk/overview)) | `modal.Volume` (v1 & v2 distributed filesystem) and `CloudBucketMount` (S3/GCS/R2) ([Modal Volumes Guide](https://modal.com/docs/guide/volumes.md)) | Local disk allocation, Local Volumes (`volume_info`), Network Volumes, and S3/Cloud Sync ([Vast.ai Creating Instances](https://docs.vast.ai/api-reference/creating-instances-with-api), [Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)) |
| **Best Workload Fit** | Long-running interactive or headless training Pods, custom Docker stacks, queue-based Serverless inference ([Runpod API Overview](https://docs.runpod.io/api-reference/overview)) | Python-native batch jobs, bursty fine-tuning, evaluation, serverless inference, and gVisor/VM code sandboxes ([Modal Sandboxes](https://modal.com/docs/guide/sandboxes.md), [Modal GPU Guide](https://modal.com/docs/guide/gpu.md)) | Cost-optimized deep learning training, multi-GPU experiments, and spot/interruptible batch compute ([Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)) |

---

## Agent Interface Selection

An autonomous agent or multi-agent system (such as a Lead Agent coordinating worker agents in Claude Code, Codex, or Herdr) should select the integration surface that matches its runtime environment ([Runpod Agent Setup](https://docs.runpod.io/agent-setup.md), [Modal CLI Reference](https://modal.com/docs/cli/latest), [Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)):

| Interface | When an Agent Should Choose It | Strengths | Limitations |
| :--- | :--- | :--- | :--- |
| **Agent Skills + CLI** | Terminal-capable coding agents (Claude Code, Codex CLI, OpenCode, Gemini CLI, Cursor) with bash execution access. | Zero boilerplate; official `SKILL.md` playbooks guide command flags, polling loops, and error recovery ([Runpod Agent Skills](https://docs.runpod.io/get-started/agent-skills.md), [Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)). | Requires parsing stdout/JSON (`--raw` or `--output json`) and managing shell subprocesses. |
| **MCP Server** | Tool-calling LLM clients (Claude Desktop, Claude Code, Cursor, Windsurf, custom MCP orchestrators) managing infrastructure at runtime. | Structured JSON schemas, built-in read/destructive hints (`destructiveHint`), and OAuth or header-based auth ([Runpod MCP GitHub](https://github.com/runpod/runpod-mcp)). | Official MCP exists only for Runpod; Modal and Vast.ai rely on community MCP wrappers or CLI skills ([Runpod MCP Servers](https://docs.runpod.io/get-started/mcp-servers.md), [vastai-mcp GitHub](https://github.com/dam2452/vastai-mcp)). |
| **Python / JS / Go SDK** | Programmatic orchestration pipelines, automated hyperparameter sweeps, retry loops, and in-code function dispatch. | Strongly typed objects, native async support (`asyncio`), direct exception handling, and decorator-based deployment ([Modal Python SDK](https://modal.com/docs/sdk/py/latest), [Vast.ai Python SDK Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai_sdk/SKILL.md)). | Requires writing and maintaining host Python/JS/Go scripts. |
| **REST API** | Language-agnostic services, custom backend control planes, or environments where installing provider CLIs/SDKs is restricted. | Direct HTTP control over every platform parameter, rate-limit header inspection, and zero dependency footprint ([Runpod API v2](https://docs.runpod.io/api-reference-v2/overview), [Vast.ai API Reference](https://docs.vast.ai/api-reference/introduction)). | Agent must implement its own retry backoff, pagination, and state polling logic ([Runpod Create Pod API](https://docs.runpod.io/api-reference-v2/pods/create-a-pod)). |

---

## Runpod Implementation Guide

Runpod provides two primary compute abstractions: **Pods** (dedicated GPU/CPU containers with optional SSH and persistent volumes) and **Serverless** (autoscaling queue-based or load-balanced HTTP workers) ([Runpod API v2](https://docs.runpod.io/api-reference-v2/overview), [Runpod Python SDK](https://docs.runpod.io/sdk/overview)). Note that Runpod updated its official brand casing to **Runpod** (single capital letter) and is retiring REST API v1 on **November 15, 2026** in favor of REST API v2 ([Runpod Agent Setup](https://docs.runpod.io/agent-setup.md), [Runpod Migrate from API v1](https://docs.runpod.io/api-reference-v2/migrate-from-v1)).

### Runpod Agent Skills Onboarding

Runpod publishes an official skills and MCP bundle at `https://agents.runpod.io/` (`runpod/runpod-plugins-official`) that installs the `runpod` router skill alongside specialized lane skills (`runpod-mcp`, `runpodctl`, `flash`, `runpod-usage`, `runpod-templates`, `companion-clis`, and `runpod-migrate`) ([Runpod Agent Setup](https://docs.runpod.io/agent-setup.md), [Runpod Agent Skills](https://docs.runpod.io/get-started/agent-skills.md)).

```bash
# Claude Code (installs both skills and the hosted MCP server)
claude plugin marketplace add runpod/runpod-plugins-official
claude plugin install runpod@runpod
claude plugin list | grep -A2 'runpod@runpod'

# OpenAI Codex CLI
codex plugin marketplace add https://github.com/runpod/runpod-plugins-official.git
codex plugin add runpod@runpod

# Universal installer for Codex, Cursor, Windsurf, Cline, opencode, Gemini CLI, Pi, etc. (Requires Node.js >= 22.20)
npx -y skills add runpod/runpod-plugins-official --skill '*' --agent codex --yes --global
```

For headless or CI agents running without a human in the loop, set `RUNPOD_API_KEY` in the environment and pre-authorize the skill in headless Claude Code with `--allowedTools "Skill(runpod:runpod-mcp)"` ([Runpod Agent Setup](https://docs.runpod.io/agent-setup.md)).

### Runpod MCP Servers

Runpod maintains two official MCP servers ([Runpod MCP Servers](https://docs.runpod.io/get-started/mcp-servers.md)):
1. **Runpod API MCP Server**: Manages Pods, Serverless endpoints, templates, network volumes, registries, and billing ([Runpod MCP Servers](https://docs.runpod.io/get-started/mcp-servers.md)).
   - **Hosted URL (Streamable HTTP)**: `https://mcp.runpod.io/` (also accessible via `https://mcp.getrunpod.io/`) ([Runpod Agent Setup](https://docs.runpod.io/agent-setup.md), [Runpod MCP Servers](https://docs.runpod.io/get-started/mcp-servers.md)).
   - **Local Package (stdio)**: `@runpod/mcp-server` ([Runpod MCP GitHub](https://github.com/runpod/runpod-mcp)).
2. **Runpod Docs MCP Server**: Searches Runpod documentation and guides without authentication ([Runpod MCP Servers](https://docs.runpod.io/get-started/mcp-servers.md)).
   - **Hosted URL (Streamable HTTP)**: `https://docs.runpod.io/mcp` ([Runpod MCP Servers](https://docs.runpod.io/get-started/mcp-servers.md)).

#### Registering Runpod MCP Clients

```bash
# Guided non-interactive installer (supports claude-code, cursor, windsurf, claude-desktop, vscode, opencode, pi)
npx @runpod/mcp-server@latest add --client claude-code

# Headless / API-Key HTTP registration in Claude Code (skips browser OAuth)
claude mcp add --transport http runpod -s user https://mcp.runpod.io/ \
  --header "Authorization: Bearer $RUNPOD_API_KEY"

# Local stdio registration in Claude Code
claude mcp add runpod --scope user -e RUNPOD_API_KEY=$RUNPOD_API_KEY \
  -- npx -y @runpod/mcp-server@latest

# Local stdio registration in Codex CLI
codex mcp add runpod --env RUNPOD_API_KEY=$RUNPOD_API_KEY \
  -- npx -y @runpod/mcp-server@latest

# Register Runpod Docs MCP server
claude mcp add runpod-docs --scope user --transport http https://docs.runpod.io/mcp
codex mcp add runpod-docs --url https://docs.runpod.io/mcp
```

> **Codex HTTP 403 Firewall Note**: When connecting Codex to the hosted server (`https://mcp.runpod.io/`), Codex may send a burst of unauthenticated requests during sign-in that triggers a temporary `403 Forbidden` (`X-Vercel-Mitigated: deny`) IP block ([Runpod MCP GitHub](https://github.com/runpod/runpod-mcp)). Avoid this by configuring `~/.codex/config.toml` to pass your bearer token directly ([Runpod MCP GitHub](https://github.com/runpod/runpod-mcp)):
> ```toml
> [mcp_servers.runpod]
> url = "https://mcp.runpod.io/"
> bearer_token_env_var = "RUNPOD_API_KEY"
> ```

#### Runpod MCP Tool Catalog

The v2 Runpod MCP server generates its tool surface from the Runpod REST API v2 OpenAPI specification plus curated data-plane and guide tools, attaching MCP safety annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) to each tool ([Runpod MCP GitHub](https://github.com/runpod/runpod-mcp), [Runpod MCP Parity Manifest](https://raw.githubusercontent.com/runpod/runpod-mcp/main/specgen/old-mcp-tools.yaml)):

| Category | MCP Tool Names | Notes |
| :--- | :--- | :--- |
| **Pods** | `list-pods`, `get-pod`, `create-pod`, `update-pod`, `pod-action`, `delete-pod`, `stream-pod-logs` | `pod-action` takes `action: "start" \| "stop" \| "restart" \| "terminate"` (replacing legacy `start-pod`, `stop-pod`, `restart-pod`) ([Runpod MCP GitHub](https://github.com/runpod/runpod-mcp), [Runpod MCP Parity Manifest](https://raw.githubusercontent.com/runpod/runpod-mcp/main/specgen/old-mcp-tools.yaml)). |
| **Serverless Control Plane** | `list-endpoints`, `get-endpoint`, `create-endpoint`, `update-endpoint`, `delete-endpoint`, `set-endpoint-gpus`, `list-endpoint-workers`, `list-endpoint-releases`, `stream-worker-logs` | Endpoints can be created directly with an image and a GPU pool (`AMPERE_80`, etc.) or template ([Runpod MCP GitHub](https://github.com/runpod/runpod-mcp), [Runpod MCP Parity Manifest](https://raw.githubusercontent.com/runpod/runpod-mcp/main/specgen/old-mcp-tools.yaml)). |
| **Serverless Data Plane** | `run-endpoint`, `runsync-endpoint`, `get-job-status`, `stream-job`, `cancel-job`, `retry-job`, `purge-endpoint-queue`, `endpoint-health` | Submits and manages jobs on queue-based Serverless endpoints ([Runpod MCP Parity Manifest](https://raw.githubusercontent.com/runpod/runpod-mcp/main/specgen/old-mcp-tools.yaml)). |
| **Catalog & Capacity** | `list-gpu-types`, `get-gpu-type`, `list-cpu-types`, `get-cpu-type`, `list-data-centers`, `get-data-center`, `get-capacity` | Queries live GPU/CPU stock and data center availability before provisioning ([Runpod MCP Parity Manifest](https://raw.githubusercontent.com/runpod/runpod-mcp/main/specgen/old-mcp-tools.yaml)). |
| **Storage & Templates** | `list-network-volumes`, `get-network-volume`, `create-network-volume`, `update-network-volume`, `delete-network-volume`, `list-templates`, `get-template`, `create-template`, `update-template`, `delete-template` | Manages persistent storage and reusable container templates ([Runpod MCP Parity Manifest](https://raw.githubusercontent.com/runpod/runpod-mcp/main/specgen/old-mcp-tools.yaml)). |
| **Registries, Hub & Billing** | `list-registries`, `get-registry`, `create-registry`, `delete-registry`, `list-delegations`, `create-delegation`, `revoke-delegation`, `list-hub-repos`, `deploy-hub-repo`, `list-public-endpoints`, `list-billing` | Manages private image credentials, ECR delegations, Hub deployments, and billing history ([Runpod MCP Parity Manifest](https://raw.githubusercontent.com/runpod/runpod-mcp/main/specgen/old-mcp-tools.yaml)). |
| **Playbooks & Feedback** | `list-guides`, `read-guide`, `lookup-concept`, `search-concepts`, `report_feedback` | Serves built-in playbooks to agents that cannot load local skills ([Runpod Agent Setup](https://docs.runpod.io/agent-setup.md), [Runpod MCP GitHub](https://github.com/runpod/runpod-mcp)). |

### Runpod CLI Reference

Runpod provides two CLIs:
1. **`runpodctl` (v2.0+)**: Standalone binary pre-installed on all Runpod Pods and installable locally for managing Pods, Serverless endpoints, network volumes, SSH keys, and peer-to-peer file transfers ([Runpod CLI Overview](https://docs.runpod.io/runpodctl/overview.md)).
2. **`rp` (or `runpod`)**: Installed with the `runpod` Python SDK (`pip install runpod`) for authenticating (`rp login`) and developing/deploying Python decorator apps (`rp flash dev`, `rp flash deploy`) ([Runpod Python SDK](https://docs.runpod.io/sdk/overview)).

#### Installing and Configuring `runpodctl`

```bash
# Install on Linux / macOS
curl -sSL https://cli.runpod.net | bash
# Or via Homebrew / Conda
brew install runpod/runpodctl/runpodctl
conda install conda-forge::runpodctl

# Configure API key (saves to ~/.runpod/config.toml) or export RUNPOD_API_KEY
runpodctl config --apiKey "$RUNPOD_API_KEY"
# Interactive first-time setup (configures API key + SSH keys)
runpodctl doctor
```

#### Core `runpodctl` Commands for Agents

```bash
# 1. Discover GPUs, Datacenters, and Templates
runpodctl gpu list
runpodctl datacenter list
runpodctl template search pytorch

# 2. Create a GPU Pod
runpodctl pod create \
  --name "agent-train-job" \
  --image "runpod/pytorch:1.0.3-cu1281-torch291-ubuntu2404" \
  --gpu-id "NVIDIA GeForce RTX 4090" \
  --gpu-count 1 \
  --container-disk-in-gb 40 \
  --volume-in-gb 100 \
  --volume-mount-path "/workspace" \
  --ports "8888/http,22/tcp" \
  --env '{"WANDB_API_KEY":"xxx","HF_TOKEN":"hf_xxx"}' \
  --cloud-type SECURE \
  --ssh

# 3. Poll Pod Readiness Using runtimeStatus (Critical for Agents)
# Always branch on runtimeStatus ("running", "initializing", "stopped", "terminated", "error", "unknown")
until [ "$(runpodctl pod get <pod-id> --output json | jq -r '.runtimeStatus')" = "running" ]; do
  status=$(runpodctl pod get <pod-id> --output json | jq -r '.runtimeStatus')
  if [ "$status" = "error" ]; then
    echo "Pod entered unrecoverable error state" >&2
    exit 1
  fi
  sleep 5
done

# 4. SSH Key Management & Connection Info
runpodctl ssh add-key --key-file ~/.ssh/id_ed25519.pub
runpodctl ssh list-keys
runpodctl ssh info <pod-id>   # Prints exact `ssh user@host -p <port> -i <key>` command or reason why unreachable

# 5. File Transfers
# Option A: One-time code transfer via runpodctl (small/medium files)
runpodctl send ./train.py     # Outputs one-time code, e.g. 8338-galileo-collect-fidel
runpodctl receive 8338-galileo-collect-fidel  # Run on destination machine

# Option B: rsync over Direct SSH (recommended for datasets and checkpoints)
rsync -avz -e "ssh -p <PORT> -i ~/.ssh/id_ed25519" ./dataset/ root@<IP>:/workspace/dataset/

# 6. Lifecycle & Teardown
runpodctl pod list                        # Shows running and error-state Pods (which still bill)
runpodctl pod list --all                  # Includes exited Pods
runpodctl pod stop <pod-id>               # Stops compute; persistent volume storage still bills
runpodctl pod start <pod-id>              # Resumes stopped Pod
runpodctl pod delete <pod-id>             # Permanently terminates Pod
```

> **Port Update Warning**: Running `runpodctl pod update <pod-id> --ports ...` replaces the entire port list (unlike `--env`, which merges) and restarts the container, wiping anything outside `/workspace` ([Runpod CLI SSH Reference](https://docs.runpod.io/runpodctl/reference/runpodctl-ssh)).

### Runpod SDK Reference

The `runpod` Python package (`pip install runpod`, Python 3.10+) unifies four capabilities into a single SDK ([Runpod Python SDK](https://docs.runpod.io/sdk/overview)):
1. **Apps (Decorator SDK, formerly Flash)**: Define GPU functions and classes in Python with `@app.queue`, `@app.task`, and `@app.api` ([Runpod Python SDK](https://docs.runpod.io/sdk/overview)).
2. **Endpoint Client (`runpod.Endpoint`)**: Invoke existing Serverless endpoints synchronously, asynchronously, or via streaming ([Runpod Python SDK](https://docs.runpod.io/sdk/overview), [Runpod Operation Reference](https://docs.runpod.io/serverless/endpoints/operation-reference)).
3. **Serverless Worker (`runpod.serverless.start`)**: Build custom container handlers ([Runpod Python SDK](https://docs.runpod.io/sdk/overview)).
4. **Control-Plane API Wrapper**: Call `runpod.create_pod()`, `runpod.get_pods()`, `runpod.stop_pod()`, and `runpod.terminate_pod()` ([Runpod Python SDK](https://docs.runpod.io/sdk/overview)).

#### Decorator App SDK (`runpod.App`)

- `@app.task`: Provisions **one ephemeral Pod per call**, runs the function to completion (ideal for model training and fine-tuning), and automatically terminates the Pod when the function returns ([Runpod Python SDK](https://docs.runpod.io/sdk/overview)).
- `@app.queue`: Creates an autoscaling, queue-based Serverless endpoint that can scale to zero (`workers=(0, 3)`) ([Runpod Python SDK](https://docs.runpod.io/sdk/overview)).
- `@app.api`: Deploys a load-balanced HTTP service from a Python class ([Runpod Python SDK](https://docs.runpod.io/sdk/overview)).

```python
import runpod
from runpod import App, Model, NetworkVolume, Secret

app = App("agent-ml-pipeline")

# Persistent storage in a single datacenter (created automatically if missing)
volume = NetworkVolume("training-vol", size=100)
base_model = Model("meta-llama/Llama-3.1-8B-Instruct")

# 1. Ephemeral Training Pod (@app.task provisions a Pod, runs training, and auto-terminates)
@app.task(
    gpu="H100",
    gpu_count=2,
    dependencies=["torch", "transformers", "accelerate"],
    mounts={"/workspace": volume},
    env={"HF_TOKEN": Secret("hf-token")},
)
def train_model(epochs: int = 3, lr: float = 2e-5):
    import torch
    ckpt_dir = f"{volume.path}/checkpoints"
    # Execute training loop and save checkpoints to volume.path
    return {"status": "completed", "gpus": torch.cuda.device_count(), "ckpt_dir": ckpt_dir}

# 2. Autoscaling Queue Endpoint (@app.queue scales 0 to 3 workers)
@app.queue(
    gpu="H100",
    workers=(0, 3),
    dependencies=["vllm"],
    mounts={"/runpod-volume": volume},
    model=base_model,
    env={"HF_TOKEN": Secret("hf-token")},
)
def generate(prompt: str):
    import vllm
    llm = vllm.LLM(model=str(base_model.path))
    return llm.generate(prompt)

@runpod.local_entrypoint
def main():
    # Spawn training asynchronously and get a Job handle, or call .remote() to block
    job = train_model.spawn(epochs=3)
    print("Training output:", job.wait())
    print("Inference test:", generate.remote("Explain gradient checkpointing."))
```

Run live development sessions with `rp flash dev main.py` (which creates temporary endpoints and cleans them up on exit) or deploy permanently with `rp flash deploy` ([Runpod Python SDK](https://docs.runpod.io/sdk/overview)).

#### Calling Serverless Endpoints

```python
# Python Serverless Endpoint Client
import os
import runpod

runpod.api_key = os.environ["RUNPOD_API_KEY"]
endpoint = runpod.Endpoint(os.environ["ENDPOINT_ID"])

# Synchronous call (blocks up to timeout seconds)
sync_res = endpoint.run_sync({"prompt": "Hello GPU"}, timeout=60)

# Asynchronous call with polling and cancellation guard
job = endpoint.run({"prompt": "Long batch job"})
print("Status:", job.status())       # IN_QUEUE, IN_PROGRESS, COMPLETED, FAILED
result = job.output(timeout=300)     # Polls until completion

# Streaming incremental output
for chunk in endpoint.run({"prompt": "Stream tokens"}).stream():
    print(chunk)
```

For JavaScript (`npm install runpod-sdk`), initialize with `const runpod = runpodSdk(process.env.RUNPOD_API_KEY); const ep = runpod.endpoint(ENDPOINT_ID);` and call `await ep.runSync({ input: {...}, timeout: 60000 })`, `await ep.run({ input: {...} })`, `await ep.status(id)`, `ep.stream(id)`, `await ep.cancel(id)`, or `await ep.health()` ([Runpod Operation Reference](https://docs.runpod.io/serverless/endpoints/operation-reference)). Go is supported via `go get github.com/runpod/go-sdk` ([Runpod Serverless SDKs](https://docs.runpod.io/serverless/sdks.md)).

### Runpod REST API Reference

Runpod separates its REST architecture into two planes:
1. **Control Plane REST API v2**: `https://api.runpod.io/v2` (OpenAPI spec at `https://api.runpod.io/v2/openapi.json`), authenticated with `Authorization: Bearer $RUNPOD_API_KEY` ([Runpod API v2](https://docs.runpod.io/api-reference-v2/overview)).
2. **Serverless Data Plane API**: `https://api.runpod.ai/v2/{endpoint_id}` for submitting jobs (`/run`, `/runsync`, `/status/{job_id}`, `/stream/{job_id}`, `/cancel/{job_id}`, `/retry/{job_id}`, `/purge-queue`, `/health`) ([Runpod Operation Reference](https://docs.runpod.io/serverless/endpoints/operation-reference)).

#### REST API Version Mapping

Agents maintaining or writing HTTP integrations must use the v2 paths, wrapped list responses (`{"pods": [...]}` instead of bare arrays), nested create payloads, and RFC 9457 error objects (`{"title", "status", "detail", "errors"}`) ([Runpod Migrate from API v1](https://docs.runpod.io/api-reference-v2/migrate-from-v1)):

| Resource / Operation | Legacy v1 (`https://rest.runpod.io/v1`) | Current v2 (`https://api.runpod.io/v2`) |
| :--- | :--- | :--- |
| **List / Create Pods** | `GET /pods`, `POST /pods` | `GET /v2/pods`, `POST /v2/pods` ([Runpod Migrate from API v1](https://docs.runpod.io/api-reference-v2/migrate-from-v1)) |
| **Get / Update / Delete Pod** | `GET /pods/{podId}`, `POST /pods/{podId}/update`, `DELETE /pods/{podId}` | `GET /v2/pods/{id}`, `PATCH /v2/pods/{id}`, `DELETE /v2/pods/{id}` ([Runpod Migrate from API v1](https://docs.runpod.io/api-reference-v2/migrate-from-v1)) |
| **Pod State Transitions** | `POST /pods/{podId}/start`, `/stop`, `/restart`, `/reset` | `POST /v2/pods/{id}/action` with body `{"action": "start\|stop\|restart\|terminate"}` ([Runpod Migrate from API v1](https://docs.runpod.io/api-reference-v2/migrate-from-v1)) |
| **Stream Pod Logs** | Not available in v1 | `GET /v2/pods/{id}/logs` ([Runpod Migrate from API v1](https://docs.runpod.io/api-reference-v2/migrate-from-v1)) |
| **Serverless Endpoints** | `/endpoints` | `/v2/serverless` (`GET`, `POST`, `PATCH /v2/serverless/{id}`, `GET /v2/serverless/{id}/workers`, `/workers/{workerId}/logs`) ([Runpod Migrate from API v1](https://docs.runpod.io/api-reference-v2/migrate-from-v1)) |
| **Network Volumes** | `/networkvolumes` | `/v2/network-volumes` (`dataCenter` field, `type: "STANDARD" \| "HIGH_PERFORMANCE"`) ([Runpod Migrate from API v1](https://docs.runpod.io/api-reference-v2/migrate-from-v1)) |
| **Catalog Discovery** | Not available in v1 | `GET /v2/catalog/gpus`, `GET /v2/catalog/cpus`, `GET /v2/catalog/datacenters?include=GPU_AVAILABILITY` ([Runpod Migrate from API v1](https://docs.runpod.io/api-reference-v2/migrate-from-v1), [Runpod Create Pod API](https://docs.runpod.io/api-reference-v2/pods/create-a-pod)) |
| **Instant Clusters & Billing** | `/billing/pods`, `/billing/endpoints` | `/v2/clusters`, `/v2/billing`, `/v2/billing/pods`, `/v2/billing/serverless` ([Runpod Migrate from API v1](https://docs.runpod.io/api-reference-v2/migrate-from-v1)) |

#### REST API Pod Examples

```bash
# 1. Create a GPU Pod with SSH and Persistent Volume (REST API v2)
curl --request POST \
  --url https://api.runpod.io/v2/pods \
  --header "Authorization: Bearer $RUNPOD_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{
    "name": "pytorch-training-v2",
    "image": "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
    "cloud": "SECURE",
    "gpu": {
      "id": "NVIDIA GeForce RTX 4090",
      "count": 1,
      "minRamPerGpu": 32,
      "minVcpuCountPerGpu": 8
    },
    "disk": 50,
    "mounts": {
      "persistent": {
        "size": 100,
        "path": "/workspace"
      }
    },
    "ports": ["8888/http", "22/tcp"],
    "env": {
      "MODEL_NAME": "Qwen/Qwen2.5-7B"
    },
    "startSsh": true
  }'

# 2. Stop or Terminate a Pod via Consolidated Action Endpoint
curl --request POST \
  --url https://api.runpod.io/v2/pods/7h9k2m4n6p/action \
  --header "Authorization: Bearer $RUNPOD_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{"action": "stop"}'

# 3. Permanently Delete a Pod
curl --request DELETE \
  --url https://api.runpod.io/v2/pods/7h9k2m4n6p \
  --header "Authorization: Bearer $RUNPOD_API_KEY"
```

---

## Modal Implementation Guide

Modal is a serverless cloud where container images, GPU hardware requests, distributed volumes, secrets, web endpoints, and isolated sandboxes are defined directly in code without Dockerfiles or YAML ([Modal Python SDK](https://modal.com/docs/sdk/py/latest), [Modal Sandboxes](https://modal.com/docs/guide/sandboxes.md)).

### Modal Agent Skills Onboarding

Modal includes a built-in CLI subcommand (`modal skills`) to install and update official Modal agent skills and documentation references directly into `.claude/` or `.agents/` ([Modal CLI Reference](https://modal.com/docs/cli/latest), [Modal Skills CLI](https://modal.com/docs/cli/latest/skills)):

```bash
# Install Modal agent skills globally for Claude Code
modal skills install --claude -g -y

# Install Modal agent skills for general agents (.agents/ directory)
modal skills install -g -y

# Inspect or update installed skills
modal skills show
modal skills update --claude -g -y
```

### Modal CLI Reference

The `modal` CLI is installed alongside the Python package (`pip install modal` or `uv add modal`) ([Modal CLI Reference](https://modal.com/docs/cli/latest)).

#### Headless Agent Authentication

```bash
# Interactive browser bootstrap
modal setup
# Or create a token with an explicit expiration window
modal token new --expires-in 90d

# Non-interactive / Headless Agent Authentication (writes to ~/.modal.toml or reads env vars)
export MODAL_TOKEN_ID="ak-..."
export MODAL_TOKEN_SECRET="as-..."
modal token set --token-id "$MODAL_TOKEN_ID" --token-secret "$MODAL_TOKEN_SECRET" --verify
modal token info
```

#### Core `modal` CLI Commands

| Command | Purpose & Agent Usage |
| :--- | :--- |
| `modal run script.py` | Executes a Modal `@app.local_entrypoint()` or specific function (`modal run script.py::train --epochs 5`) in an ephemeral App ([Modal CLI Reference](https://modal.com/docs/cli/latest)). |
| `modal run --detach script.py` | Runs the ephemeral App in the cloud so it continues executing even if the local agent shell disconnects. |
| `modal serve script.py` | Runs Web Functions (`@modal.fastapi_endpoint`, `@modal.asgi_app`) with live hot-reloading ([Modal Web Functions](https://modal.com/docs/guide/webhooks.md)). |
| `modal deploy --name my-app script.py` | Persistently deploys an App so its Functions and Web Endpoints can be invoked anytime ([Modal Deploy CLI](https://modal.com/docs/cli/latest/deploy)). |
| `modal app list` / `modal app stop <app>` | Lists active or deployed Apps and stops them to halt execution ([Modal CLI Reference](https://modal.com/docs/cli/latest)). |
| `modal container list` / `exec` / `stop` | Lists running containers (`ta-*`) and executes diagnostic commands inside them ([Modal CLI Reference](https://modal.com/docs/cli/latest)). |
| `modal shell --volume my-vol` | Opens an interactive or command shell inside a Modal container with volumes mounted at `/mnt` ([Modal Volumes Guide](https://modal.com/docs/guide/volumes.md)). |
| `modal volume create [--version=2] <name>` | Creates a persistent distributed `modal.Volume` (v1 or high-scale v2) ([Modal Volumes Guide](https://modal.com/docs/guide/volumes.md)). |
| `modal volume put / get / ls / cp / rm` | Uploads local datasets/code (`modal volume put my-vol ./data /data`) or downloads checkpoints (`modal volume get my-vol /ckpt ./ckpt`) ([Modal Volumes Guide](https://modal.com/docs/guide/volumes.md)). |
| `modal endpoint create / info / list / logs / stats / stop` | Deploys and manages dedicated LLM inference endpoints from Hugging Face or Modal Volumes ([Modal Endpoint CLI](https://modal.com/docs/cli/latest/endpoint)). |
| `modal curl <url>` | Sends an authenticated HTTP request using Modal Proxy Auth tokens ([Modal CLI Reference](https://modal.com/docs/cli/latest)). |
| `modal billing` | Inspects workspace billing usage ([Modal CLI Reference](https://modal.com/docs/cli/latest)). |

#### Dedicated LLM Endpoints CLI

```bash
# Deploy a dedicated LLM endpoint from Hugging Face or custom weights in a Modal Volume
modal endpoint create --name qwen-chat --model Qwen/Qwen3.6-27B-FP8
modal endpoint create --name my-ft --model Qwen/Qwen3.6-27B-FP8 \
  --custom-volume-name qwen-ft --custom-volume-path /models/qwen

# Inspect endpoint URL, status, metrics, and logs in machine-readable JSON
modal endpoint info qwen-chat --json
modal endpoint stats qwen-chat --since 2h --json
modal endpoint logs qwen-chat --tail 200 --timestamps

# Tear down the endpoint without confirmation prompts
modal endpoint stop qwen-chat -y
```

### Modal SDK Reference

Modal provides an official Python SDK (`pip install modal`) for defining and invoking apps, plus official **JavaScript/TypeScript** (`npm install modal`) and **Go** (`github.com/modal-labs/modal-client/go`) SDKs for invoking deployed Functions and managing **Modal Sandboxes** ([Modal Python SDK](https://modal.com/docs/sdk/py/latest), [Modal Sandboxes](https://modal.com/docs/guide/sandboxes.md), [Modal Invoking Deployed Functions](https://modal.com/docs/guide/trigger-deployed-functions.md)).

#### Specifying GPUs and Multi-GPU Fallbacks

Modal supports `T4`, `L4`, `A10`, `L40S`, `RTX-PRO-6000`, `A100` (40GB default, auto-upgrades to 80GB when free), `A100-40GB`, `A100-80GB`, `H100` (SXM, auto-upgrades to H200 at no extra cost unless pinned with `H100!`), `H200`, `B200`, `B200+` (allows free upgrade to B300, requires CUDA 13.1+), and `B300` ([Modal GPU Guide](https://modal.com/docs/guide/gpu.md)). Append `:n` (up to `:8` on B300/B200/H200/H100/A100/L40S/L4/T4, `:4` on A10) for multi-GPU single-node containers, or pass an ordered list for automatic capacity fallback ([Modal GPU Guide](https://modal.com/docs/guide/gpu.md)):

```python
import modal

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch", "transformers", "accelerate", "datasets")
)
app = modal.App("gpu-training-app", image=image)
vol = modal.Volume.from_name("training-checkpoints", create_if_missing=True, version=2)

@app.function(
    gpu=["H100:2", "A100-80GB:2"],  # Tries 2x H100 first, falls back to 2x A100-80GB
    volumes={"/vol": vol},
    secrets=[modal.Secret.from_name("huggingface-secret")],
    timeout=4 * 3600,               # 4 hours
    retries=modal.Retries(max_retries=2, initial_delay=10.0),
)
def run_ddp_training(config_path: str):
    import subprocess
    import sys
    # Run multi-GPU training as a subprocess so torchrun / Lightning DDP spawns cleanly
    subprocess.run(
        ["torchrun", "--nproc_per_node=2", "train.py", "--output_dir", "/vol/model"],
        stdout=sys.stdout,
        stderr=sys.stderr,
        check=True,
    )
    vol.commit()  # Explicit commit (background commits also run periodically and on exit)
    return {"status": "saved", "path": "/vol/model"}
```

#### Dynamic Modal Sandboxes

Unlike `@app.function`, which requires predefined Python functions, `modal.Sandbox` spawns secure, isolated containers (using **gVisor** by default, or full kernel **VMs** with `runtime="vm"`, though GPU Sandboxes require `runtime="gvisor"`) on the fly via standard scripts (`python script.py` or Node.js/Go) ([Modal Sandboxes](https://modal.com/docs/guide/sandboxes.md)). Sandboxes support lifetimes up to 24 hours (`timeout=86400`), `idle_timeout`, TCP and Exec readiness probes (`modal.Probe.with_tcp`, `modal.Probe.with_exec`), and Volume mounts ([Modal Sandboxes](https://modal.com/docs/guide/sandboxes.md)).

```python
import modal

# Lookup or create an App namespace from any normal Python process (no `modal run` needed)
sb_app = modal.App.lookup("agent-gpu-sandbox", create_if_missing=True)
image = modal.Image.debian_slim().pip_install("torch", "numpy")
vol = modal.Volume.from_name("agent-workspace", create_if_missing=True, version=2)

sb = modal.Sandbox.create(
    app=sb_app,
    image=image,
    gpu="A100",
    volumes={"/workspace": vol},
    timeout=3600,          # Max lifetime in seconds (up to 24h)
    idle_timeout=600,      # Auto-terminate after 10 minutes of inactivity
    readiness_probe=modal.Probe.with_exec("python", "-c", "import torch; assert torch.cuda.is_available()"),
)

try:
    sb.wait_until_ready()  # Raises modal.exception.TimeoutError if probe fails after 5 min
    proc = sb.exec("python", "-c", "import torch; print(torch.cuda.get_device_name(0))", timeout=60)
    for line in proc.stdout:
        print(line, end="")
    proc.wait()
    print("Exit code:", proc.returncode)

    # Flush Volume v2 changes from inside the Sandbox
    sb.exec("sync", "/workspace").wait()
except modal.exception.TimeoutError:
    print("Sandbox readiness timed out")
finally:
    sb.terminate(wait=True)
```

In **JavaScript/TypeScript**, use `import { ModalClient, Probe } from "modal"; const modal = new ModalClient(); const app = await modal.apps.fromName("agent-gpu-sandbox", { createIfMissing: true }); const sb = await modal.sandboxes.create(app, image, { timeoutMs: 600000 });` ([Modal Sandboxes](https://modal.com/docs/guide/sandboxes.md)).

#### Invoking Deployed Modal Functions Remotely

Once an App is deployed (`modal deploy`), any external agent in Python, JS, or Go can look up and invoke its Functions without having the source code ([Modal Invoking Deployed Functions](https://modal.com/docs/guide/trigger-deployed-functions.md)):

```python
import modal

fn = modal.Function.from_name("gpu-training-app", "run_ddp_training")

# 1. Blocking call
# result = fn.remote("/vol/config.yaml")

# 2. Non-blocking background spawn + polling
call = fn.spawn("/vol/config.yaml")
try:
    result = call.get(timeout=0)  # Returns immediately if finished, raises TimeoutError if still running
except TimeoutError:
    print("Training still in progress, call ID:", call.object_id)
```

#### Modal Volumes Storage Rules

- **Volumes v1**: Up to 500,000 inodes (recommended `< 50,000` files); maximum ~5 concurrent writers; requires `vol.commit()` (or relies on periodic background commits) and `vol.reload()` to see external writes ([Modal Volumes Guide](https://modal.com/docs/guide/volumes.md)). Calling `vol.reload()` while a file on the volume is open raises a `"volume busy"` error ([Modal Volumes Guide](https://modal.com/docs/guide/volumes.md)).
- **Volumes v2 (`version=2`)**: Beta; unlimited total files (up to 262,144 files per single directory, max file size 1 TiB), supports hundreds of concurrent container writers, and allows shell processes inside Sandboxes to persist writes by running `sync /path/to/mountpoint` ([Modal Volumes Guide](https://modal.com/docs/guide/volumes.md)).
- **Local Batch Upload**: Agents outside Modal can upload files directly via the SDK using `with vol.batch_upload() as batch: batch.put_file("local.pt", "/remote.pt")` ([Modal Volumes Guide](https://modal.com/docs/guide/volumes.md)).

### Modal Web Endpoints

Modal does not use a traditional VM-provisioning REST API; instead, you expose GPU Functions as HTTP/REST endpoints (supporting up to 4 GiB request bodies and unlimited response bodies) using three decorators ([Modal Web Functions](https://modal.com/docs/guide/webhooks.md)):
1. **`@modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)`**: Wraps a single Python function into a public HTTPS endpoint (replaces the deprecated `@modal.web_endpoint` since v0.73.82) ([Modal fastapi_endpoint Reference](https://modal.com/docs/sdk/py/latest/fastapi_endpoint)). When `requires_proxy_auth=True` is set, callers must pass `Modal-Key` and `Modal-Secret` headers, which Modal validates at the proxy edge before waking a GPU container ([Modal Web Functions](https://modal.com/docs/guide/webhooks.md)).
2. **`@modal.asgi_app()` / `@modal.wsgi_app()`**: Serves full FastAPI, Starlette, FastHTML, Flask, or Django multi-route applications with WebSocket support ([Modal Web Functions](https://modal.com/docs/guide/webhooks.md)). Combine with `@modal.concurrent(max_inputs=100)` so a single GPU container can handle concurrent requests ([Modal Web Functions](https://modal.com/docs/guide/webhooks.md)).
3. **`@modal.web_server(port)`**: Exposes any non-ASGI HTTP subprocess (such as `vllm serve` or `text-generation-inference`) bound to `0.0.0.0:port` ([Modal Web Functions](https://modal.com/docs/guide/webhooks.md)).

### Modal MCP Integration Patterns

#### Managing Modal Sandboxes via MCP

To let an MCP client (Claude Code, Claude Desktop, Cursor) dynamically launch GPU Sandboxes, push/pull files, and execute commands on Modal, use the open-source **`mcp4modal_sandbox`** server ([MCP4Modal Sandbox](https://github.com/milkymap/mcp4modal_sandbox)):

```json
{
  "mcpServers": {
    "modal-sandbox": {
      "command": "uvx",
      "args": ["--from", "git+https://github.com/milkymap/mcp4modal_sandbox.git", "mcp4modal-sandbox"],
      "env": {
        "MODAL_TOKEN_ID": "ak-...",
        "MODAL_TOKEN_SECRET": "as-..."
      }
    }
  }
}
```

#### Hosting MCP Servers on Modal

Modal is also an execution host for stateless Streamable HTTP MCP servers that run GPU tools on demand and scale to zero ([Modal Enterprise MCP Blog](https://modal.com/resources/best-infrastructure-high-traffic-mcp-servers), [Modal Web Functions](https://modal.com/docs/guide/webhooks.md)):

```python
import modal

image = modal.Image.debian_slim().pip_install("mcp[cli]", "fastapi[standard]", "torch")
app = modal.App("gpu-mcp-server", image=image)

@app.function(gpu="L40S")
@modal.concurrent(max_inputs=20)
@modal.asgi_app()
def mcp_asgi():
    from mcp.server.fastmcp import FastMCP

    mcp = FastMCP("modal-gpu-tools", stateless_http=True)

    @mcp.tool()
    def gpu_matrix_benchmark(size: int = 4096) -> dict:
        import torch
        a = torch.randn(size, size, device="cuda")
        b = torch.matmul(a, a)
        torch.cuda.synchronize()
        return {"device": torch.cuda.get_device_name(0), "shape": list(b.shape)}

    return mcp.streamable_http_app()
```

---

## Vast.ai Implementation Guide

Vast.ai is an API-native GPU marketplace offering low-cost on-demand, interruptible (spot/bid), and reserved GPU instances (both Docker containers and full VMs), persistent volumes, and serverless endpoints ([Vast.ai API Reference](https://docs.vast.ai/api-reference/introduction), [Vast.ai Creating Instances](https://docs.vast.ai/api-reference/creating-instances-with-api)).

### Vast.ai Agent Skills Onboarding

Vast.ai maintains official agent skills in the `vast-ai/vast-cli` repository covering both the `vastai` CLI and the `vastai` Python SDK ([Vast.ai Search Offers API](https://docs.vast.ai/api-reference/search/search-offers.md)):

```bash
# Install official Vast.ai CLI and SDK skills for Claude Code, Cursor, Windsurf, Codex, etc.
npx skills add vast-ai/vast-cli
```

- Official CLI Skill source: [vastai/SKILL.md](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)
- Official SDK Skill source: [vastai_sdk/SKILL.md](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai_sdk/SKILL.md)

### Vast.ai CLI Reference

The `vastai` CLI and Python SDK are shipped together in a single package (`pip install vastai`); the older `vastai-sdk` PyPI package is deprecated and merged into `vastai` ([vastai PyPI](https://pypi.org/project/vastai/), [vastai-sdk PyPI](https://pypi.org/project/vastai-sdk/)).

#### Installation and Pre-Flight Setup

```bash
# Install via official standalone script (Linux/macOS) or pip
curl -fsSL https://vast.ai/install.sh | bash
# OR: pip install vastai

# 1. Set API key (stored in ~/.config/vastai/vast_api_key or ~/.vast_api_key)
vastai set api-key "$VAST_API_KEY"

# 2. Verify authentication and credit balance
vastai show user --raw

# 3. Register SSH public key BEFORE creating any instance
# (VM instances cannot have SSH keys attached post-creation; Docker instances can via `vastai attach ssh`)
vastai create ssh-key ~/.ssh/id_ed25519.pub
```

#### Global Flags for Autonomous Agents

Agents invoking `vastai` in bash must always use `--raw` for machine-readable JSON output and `-y` on `destroy instance` so the CLI never blocks on an interactive confirmation prompt ([Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)):
- `--raw`: Output raw JSON ([Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)).
- `--explain`: Print the exact underlying HTTP REST request and payload ([Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)).
- `--curl`: Output the equivalent `curl` command ([Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)).
- `--retry N`: Number of API retry attempts (default 3) ([Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)).
- `--api-key KEY`: Override the stored API key per call ([Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)).

#### Core `vastai` CLI Workflow

```bash
# 1. Search GPU Offers
# Note: In the CLI, gpu_ram is in GB (whereas in the REST API it is in MB)
vastai search offers \
  'gpu_name=RTX_4090 num_gpus=1 gpu_ram>=24 reliability>0.99 verified=true direct_port_count>=1 rentable=true' \
  -o 'dlperf_usd-' --limit 5 --raw

# For multi-GPU training with NVLink:
vastai search offers 'gpu_name=H100_SXM num_gpus>=4 bw_nvlink>100 reliability>0.99 verified=true' -o 'dph_total' --raw

# 2. Create an On-Demand Instance from Offer ID
# Use @vastai-automatic-tag to let Vast resolve the compatible CUDA/PyTorch tag for the host
vastai create instance <OFFER_ID> \
  --image vastai/pytorch:@vastai-automatic-tag \
  --disk 50 \
  --ssh --direct \
  --label "agent-train-01" \
  --env '-e WANDB_API_KEY=xxx -e HF_TOKEN=hf_xxx -p 8000:8000' \
  --onstart-cmd "env | grep _ >> /etc/environment; echo 'Instance booted'" \
  --cancel-unavail --raw
# Returns: {"success": true, "new_contract": 12345678} -> 12345678 is the INSTANCE_ID

# 3. Create an Interruptible (Spot/Bid) Instance
# CRITICAL: Searching with `--type bid` returns offers with `min_bid`, but `create instance` still rents
# at on-demand price UNLESS `--bid_price` is explicitly passed.
vastai search offers --type bid 'gpu_name=RTX_4090 num_gpus=1 verified=true' -o 'dph_total' --raw
vastai create instance <OFFER_ID> \
  --image vastai/pytorch:@vastai-automatic-tag \
  --disk 50 --ssh --direct --bid_price 0.22 --raw

# 4. Poll Instance Status with Terminal-State Trap Detection
vastai show instance <INSTANCE_ID> --raw
# Wait until actual_status == "running".
# Abort and destroy immediately if actual_status is "exited", "unknown", or "offline".

# 5. Execute Commands, Inspect Logs, and Get SSH URL
vastai execute <INSTANCE_ID> "nvidia-smi"
vastai logs <INSTANCE_ID> --tail 100
vastai ssh-url <INSTANCE_ID>   # Returns ssh://root@<host>:<port>

# 6. Copy Data (Local <-> Instance, Volume <-> Instance, Cloud <-> Instance)
# NEVER copy directly to `/root` or `/` as it overwrites SSH key permissions and breaks SSH access.
vastai copy local:./src/ <INSTANCE_ID>:/workspace/src/
vastai copy <INSTANCE_ID>:/workspace/checkpoints/ local:./checkpoints/

# 7. Teardown
vastai stop instance <INSTANCE_ID>          # Halts GPU billing; disk storage charges continue
vastai start instance <INSTANCE_ID>         # Resumes stopped instance
vastai destroy instance <INSTANCE_ID> -y    # Permanently deletes instance and stops all billing (-y required)
```

### Vast.ai Python SDK Reference

The `vastai` package (`pip install vastai` or `pip install "vastai[serverless]"`) provides four Python client classes ([Vast.ai Python SDK Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai_sdk/SKILL.md)):
1. **`VastAI`**: High-level client wrapping all CLI operations as typed Python methods ([Vast.ai Python SDK Quickstart](https://docs.vast.ai/sdk/python/quickstart), [Vast.ai Python SDK Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai_sdk/SKILL.md)).
2. **`SyncClient`**: Low-level synchronous client using structured `InstanceConfig` objects ([Vast.ai Python SDK Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai_sdk/SKILL.md)).
3. **`AsyncClient`**: Low-level `asyncio` context-manager client for concurrent agent orchestration ([Vast.ai Python SDK Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai_sdk/SKILL.md)).
4. **`Serverless`**: Async client for invoking Vast.ai autoscaling Serverless inference endpoints ([Vast.ai Python SDK Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai_sdk/SKILL.md)).

#### High-Level `VastAI` SDK Lifecycle

```python
import os
import time
from vastai import VastAI

vast = VastAI(api_key=os.environ.get("VAST_API_KEY"))  # Falls back to ~/.config/vastai/vast_api_key

# 1. Search for verified RTX 4090 offers with direct ports
offers = vast.search_offers(
    query="gpu_name=RTX_4090 num_gpus=1 verified=true reliability>0.99 direct_port_count>=1 rentable=true",
    order="dlperf_usd-",
    limit=5,
)
if not offers:
    raise RuntimeError("No matching Vast.ai offers available")

offer_id = offers[0]["id"]

# 2. Create the instance
res = vast.create_instance(
    id=offer_id,
    image="pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime",
    disk=40,
    ssh=True,
    direct=True,
    label="sdk-training-job",
    onstart_cmd="env | grep _ >> /etc/environment && mkdir -p /workspace/data /workspace/out",
)
instance_id = res["new_contract"]

# 3. Safe readiness polling (avoids infinite loop trap on dead hosts)
TERMINAL_BAD_STATES = {"exited", "unknown", "offline"}
deadline = time.time() + 600  # 10-minute boot timeout

try:
    while time.time() < deadline:
        info = vast.show_instance(id=instance_id)
        status = info.get("actual_status")
        if status == "running":
            break
        if status in TERMINAL_BAD_STATES:
            raise RuntimeError(f"Instance {instance_id} entered unrecoverable state: {status}")
        time.sleep(10)
    else:
        raise TimeoutError(f"Instance {instance_id} did not reach running state within 10 minutes")

    # 4. Upload data, get SSH details, and download results
    ssh_cmd = vast.ssh_url(id=instance_id)
    print("SSH Ready:", ssh_cmd)
    vast.copy(src="local:./train_data/", dst=f"C.{instance_id}:/workspace/data/")
finally:
    # 5. Always destroy in finally block when ephemeral job completes or fails
    vast.destroy_instance(id=instance_id)
```

#### Async and Serverless SDKs

```python
import asyncio
from vastai import AsyncClient, Serverless
from vastai.data.instance import InstanceConfig

async def orchestrate_async():
    async with AsyncClient() as client:
        offers = await client.search(num_gpus=1, gpu_name="A100_SXM4", min_reliability=0.99)
        instance = await client.create_instance(
            offer_id=offers[0].id,
            config=InstanceConfig(image="ubuntu:22.04", disk=50),
        )
        await client.destroy_instance(instance_or_id=instance.id)

async def call_serverless():
    sls = Serverless()
    ep = await sls.get_endpoint("my-vllm-endpoint")
    resp = await sls.request("/v1/completions", {
        "model": "Qwen/Qwen3-8B",
        "prompt": "Summarize LoRA fine-tuning.",
        "max_tokens": 128,
    })
    print(resp["response"]["choices"][0]["text"])
```

### Vast.ai REST API Reference

- **Base URL**: `https://console.vast.ai/api/v0` (also reachable at `https://cloud.vast.ai/api/v0`) ([Vast.ai API Reference](https://docs.vast.ai/api-reference/introduction), [Vast.ai Developers API](https://vast.ai/developers/api)).
- **Authentication**: Header `Authorization: Bearer $VAST_API_KEY` ([Vast.ai API Reference](https://docs.vast.ai/api-reference/introduction)).

#### Key REST API Endpoints

| HTTP Method & Path | Operation & Payload Details |
| :--- | :--- |
| `POST /api/v0/bundles/` | Searches available GPU offers using structured filter operators (`eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `in`, `notin`) ([Vast.ai Search Offers API](https://docs.vast.ai/api-reference/search/search-offers.md)). Note: `gpu_ram` and `cpu_ram` are in **MB** in the REST API ([Vast.ai Search Offers API](https://docs.vast.ai/api-reference/search/search-offers.md)). |
| `PUT /api/v0/asks/{offer_id}/` | Accepts an offer and creates an instance ([Vast.ai Creating Instances](https://docs.vast.ai/api-reference/creating-instances-with-api)). Returns `{"success": true, "new_contract": <instance_id>}` ([Vast.ai Creating Instances](https://docs.vast.ai/api-reference/creating-instances-with-api)). |
| `GET /api/v0/instances/` | Lists all instances belonging to the authenticated account ([Vast.ai Developers API](https://vast.ai/developers/api)). |
| `GET /api/v0/instances/{id}/` | Retrieves status (`actual_status`), SSH host/port, and metrics for a single instance ([Vast.ai Creating Instances](https://docs.vast.ai/api-reference/creating-instances-with-api)). |
| `PUT /api/v0/instances/{id}/` | Updates instance state (`{"state": "running" \| "stopped"}`), label, or spot bid price ([Vast.ai Developers API](https://vast.ai/developers/api)). |
| `DELETE /api/v0/instances/{id}/` | Permanently destroys the instance and halts all compute and storage billing ([Vast.ai Developers API](https://vast.ai/developers/api)). |
| `POST /api/v0/endptjobs` / `GET /api/v0/endptjobs` | Creates and lists Vast.ai Serverless endpoints ([Vast.ai Create Endpoint](https://docs.vast.ai/api-reference/serverless/create-endpoint), [Vast.ai Show Endpoints](https://docs.vast.ai/api-reference/serverless/show-endpoints)). |
| `GET /api/v0/auth/apikeys/` | Lists and manages scoped API keys ([Vast.ai Developers API](https://vast.ai/developers/api)). |

#### REST API Instance Examples

```bash
# Step 1: Search for verified on-demand RTX 4090 offers (>= 24,000 MB GPU RAM)
curl -s -X POST "https://console.vast.ai/api/v0/bundles/" \
  -H "Authorization: Bearer $VAST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "gpu_name": {"in": ["RTX 4090"]},
    "num_gpus": {"gte": 1},
    "gpu_ram": {"gte": 24000},
    "reliability": {"gte": 0.99},
    "verified": {"eq": true},
    "rentable": {"eq": true},
    "type": "ondemand",
    "order": [["dph_total", "asc"]],
    "limit": 3
  }'

# Step 2: Create an instance from offer ID 12345678
# Note: In REST API `PUT /api/v0/asks/{id}/`, `env` is a JSON dict where ports use `"-p 8000:8000": "1"`
curl -s -X PUT "https://console.vast.ai/api/v0/asks/12345678/" \
  -H "Authorization: Bearer $VAST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "image": "vllm/vllm-openai:latest",
    "label": "vllm-inference-server",
    "disk": 50,
    "runtype": "ssh_direct",
    "cancel_unavail": true,
    "env": {
      "MODEL_ID": "deepseek-ai/DeepSeek-R1-Distill-Llama-8B",
      "HF_TOKEN": "hf_xxx",
      "-p 8000:8000": "1"
    },
    "onstart": "env >> /etc/environment && vllm serve $MODEL_ID --port 8000",
    "volume_info": {
      "volume_id": 12345,
      "mount_path": "/workspace"
    }
  }'
```

#### Vast.ai REST API Quirks

1. **Runtype Entrypoint Behavior**: `jupyter_direct` (provisions ports 8080 and 22) and `ssh_direct` (provisions port 22) replace the Docker image's original `ENTRYPOINT` with Vast.ai's SSH/Jupyter bootstrap; use `onstart` to start your training or inference server ([Vast.ai Creating Instances](https://docs.vast.ai/api-reference/creating-instances-with-api)). Using `runtype: "args"` preserves the image's original `ENTRYPOINT` and passes `args_str` as `CMD`, but disables SSH and Jupyter ([Vast.ai Creating Instances](https://docs.vast.ai/api-reference/creating-instances-with-api)).
2. **Environment Variable Visibility in SSH**: Variables passed in `env` are injected into the container entrypoint environment, not into interactive `ssh` login shells ([Vast.ai Creating Instances](https://docs.vast.ai/api-reference/creating-instances-with-api)). Always prepend `env >> /etc/environment` (or `env | grep _ >> /etc/environment`) to your `onstart` script so SSH commands (`vastai execute` or Paramiko) see your variables ([Vast.ai Creating Instances](https://docs.vast.ai/api-reference/creating-instances-with-api), [Vast.ai CLI Create Instance](https://docs.vast.ai/cli/reference/create-instance)).
3. **`onstart` Length Limit**: The `onstart` script field is capped at **4,048 characters** ([Vast.ai Search Offers API](https://docs.vast.ai/api-reference/search/search-offers.md)). For longer startup scripts, gzip and base64-encode the payload (`echo "<b64>" | base64 -d | gunzip | bash`) or upload the script after boot via `vastai copy` ([Vast.ai Search Offers API](https://docs.vast.ai/api-reference/search/search-offers.md)).

### Vast.ai MCP Integration

While Vast.ai's official recommendation for coding agents is its `npx skills add vast-ai/vast-cli` skill package, agents that require an MCP server can use the open-source **`dam2452/vastai-mcp`** server, which wraps `https://console.vast.ai/api/v0` alongside Paramiko SSH command execution and SFTP file transfer ([Vast.ai Search Offers API](https://docs.vast.ai/api-reference/search/search-offers.md), [vastai-mcp GitHub](https://github.com/dam2452/vastai-mcp)):

```bash
# Register vastai-mcp in Claude Code using uvx
claude mcp add vastai-mcp \
  -e VASTAI_MCP_API_KEY="$VAST_API_KEY" \
  -e VASTAI_MCP_SSH_KEY_PATH="$HOME/.ssh/id_ed25519" \
  -- uvx --from git+https://github.com/dam2452/vastai-mcp.git vastai-mcp
```

`vastai-mcp` exposes 20 MCP tools: `search_offers`, `search_benchmarks`, `search_templates`, `get_gpu_metrics`, `get_gpu_trends`, `list_instances`, `get_instance`, `create_instance`, `manage_instance`, `destroy_instance`, `change_bid`, `show_instance_logs`, `execute_command`, `get_current_user`, `raw_request`, `register_ssh_key`, `list_ssh_keys`, `get_instance_ssh_info`, `ssh_exec`, and `ssh_transfer` ([vastai-mcp GitHub](https://github.com/dam2452/vastai-mcp)).

---

## Autonomous Agent Execution Playbook

When a Lead Agent (such as Claude Code) delegates remote GPU execution to worker agents (such as Codex or Antigravity CLI) or runs a training pipeline directly, it should enforce the following seven-stage operational protocol.

### Standard Seven-Stage Lifecycle

1. **Stage 1 — Pre-Flight Credential & Budget Check**:
   - Verify credentials and account balance before searching or launching (`runpodctl user`, `modal billing`, or `vastai show user --raw`) ([Runpod CLI Overview](https://docs.runpod.io/runpodctl/overview.md), [Modal CLI Reference](https://modal.com/docs/cli/latest), [Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)).
   - Ensure an SSH key is registered on the provider (`runpodctl ssh list-keys`, `vastai show ssh-keys`) before provisioning Pods or Instances ([Runpod CLI SSH Reference](https://docs.runpod.io/runpodctl/reference/runpodctl-ssh), [Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)).
2. **Stage 2 — Capacity Discovery with Ordered Fallbacks**:
   - Query live stock (`GET /v2/catalog/datacenters?include=GPU_AVAILABILITY` on Runpod, `gpu=["H100", "A100-80GB"]` on Modal, or `vastai search offers --raw` on Vast.ai) rather than hardcoding a single GPU ID or datacenter ([Runpod Create Pod API](https://docs.runpod.io/api-reference-v2/pods/create-a-pod), [Modal GPU Guide](https://modal.com/docs/guide/gpu.md), [Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)).
3. **Stage 3 — Tagged Provisioning & Persistent Storage Mount**:
   - Tag every Pod, Sandbox, or Instance with a deterministic agent run label (e.g., `agent-run-<task_id>`) so orphan sweeps can identify it ([Runpod CLI Pod Reference](https://docs.runpod.io/runpodctl/reference/runpodctl-pod), [Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)).
   - Attach a persistent volume (`/workspace` on Runpod/Vast.ai or `modal.Volume` at `/vol` on Modal) so model checkpoints survive container preemption or restarts ([Runpod Network Volumes](https://docs.runpod.io/storage/network-volumes), [Modal Volumes Guide](https://modal.com/docs/guide/volumes.md), [Vast.ai Creating Instances](https://docs.vast.ai/api-reference/creating-instances-with-api)).
4. **Stage 4 — Bounded Readiness Polling**:
   - Poll with a strict timeout (e.g., 10 minutes) and explicit terminal-error detection:
     - **Runpod**: Wait for `runtimeStatus == "running"`; abort immediately if `runtimeStatus == "error"` ([Runpod CLI Pod Reference](https://docs.runpod.io/runpodctl/reference/runpodctl-pod)).
     - **Modal**: Call `sb.wait_until_ready()` inside `try ... except modal.exception.TimeoutError:` and call `sb.terminate()` on timeout ([Modal Sandboxes](https://modal.com/docs/guide/sandboxes.md)).
     - **Vast.ai**: Wait for `actual_status == "running"`; abort and run `vastai destroy instance <id> -y` immediately if `actual_status` enters `exited`, `unknown`, or `offline` ([Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)).
5. **Stage 5 — Detached Execution & Periodic Checkpointing**:
   - On SSH-based Pods/Instances (Runpod, Vast.ai), launch long training runs inside `tmux`, `nohup`, or `setsid` logging to `/workspace/train.log` and writing exit status to `/workspace/exit_code` so transient SSH drops do not kill the training process.
   - Configure training frameworks (Hugging Face `Trainer`, PyTorch Lightning, custom loops) to save checkpoints to the mounted volume every N steps ([Modal Volumes Guide](https://modal.com/docs/guide/volumes.md)).
6. **Stage 6 — Log Streaming & Artifact Retrieval**:
   - Monitor progress via `GET /v2/pods/{id}/logs` (Runpod), `modal app logs` / `sb.exec` (Modal), or `vastai logs <id> --tail 100` (Vast.ai) ([Runpod Migrate from API v1](https://docs.runpod.io/api-reference-v2/migrate-from-v1), [Modal CLI Reference](https://modal.com/docs/cli/latest), [Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)).
   - Sync final weights/artifacts back using `rsync`, `modal volume get`, or `vastai copy <id>:/workspace/out/ local:./out/` ([Runpod Transfer Files](https://docs.runpod.io/runpodctl/transfer-files.md), [Modal Volumes Guide](https://modal.com/docs/guide/volumes.md), [Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)).
7. **Stage 7 — Guaranteed Teardown & Verification**:
   - Always execute teardown (`runpodctl pod delete <id>`, `sb.terminate()`, or `vastai destroy instance <id> -y`) inside a `finally` or `trap EXIT` handler ([Runpod CLI Pod Reference](https://docs.runpod.io/runpodctl/reference/runpodctl-pod), [Modal Sandboxes](https://modal.com/docs/guide/sandboxes.md), [Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)).
   - Confirm destruction by re-listing active instances (`runpodctl pod list`, `vastai show instances --raw`) to verify zero orphaned resources remain accruing compute or disk charges ([Runpod CLI Pod Reference](https://docs.runpod.io/runpodctl/reference/runpodctl-pod), [Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)).

### Critical Agent Pitfalls Checklist

| Provider | Pitfall / Trap | Mandatory Agent Mitigation |
| :--- | :--- | :--- |
| **Runpod** | Polling `desiredStatus == "RUNNING"` instead of `runtimeStatus == "running"` causes SSH/exec attempts to fail while the image is still pulling ([Runpod CLI Pod Reference](https://docs.runpod.io/runpodctl/reference/runpodctl-pod)). | Poll `runpodctl pod get <id> --output json \| jq -r '.runtimeStatus'` until it equals `"running"` ([Runpod CLI Pod Reference](https://docs.runpod.io/runpodctl/reference/runpodctl-pod)). |
| **Runpod** | Community Cloud Pods are not guaranteed a public IP, causing direct SSH to fail ([Runpod CLI Pod Reference](https://docs.runpod.io/runpodctl/reference/runpodctl-pod)). | Default to `--cloud-type SECURE` (or `cloud: "SECURE"` in API v2) when direct SSH is required ([Runpod CLI Pod Reference](https://docs.runpod.io/runpodctl/reference/runpodctl-pod)). |
| **Runpod** | Using deprecated REST API v1 (`https://rest.runpod.io/v1`), which retires November 15, 2026 ([Runpod Migrate from API v1](https://docs.runpod.io/api-reference-v2/migrate-from-v1)). | Target `https://api.runpod.io/v2` and use `/runpod:migrate` skill to upgrade legacy code ([Runpod Migrate from API v1](https://docs.runpod.io/api-reference-v2/migrate-from-v1)). |
| **Modal** | Catching Python builtin `TimeoutError` on `sb.wait_until_ready()`, which raises `modal.exception.TimeoutError` and leaves the Sandbox running ([Modal Sandboxes](https://modal.com/docs/guide/sandboxes.md)). | Catch `modal.exception.TimeoutError` explicitly and call `sb.terminate()` in the handler ([Modal Sandboxes](https://modal.com/docs/guide/sandboxes.md)). |
| **Modal** | Calling `volume.reload()` while a container still has an open file handle on that volume ([Modal Volumes Guide](https://modal.com/docs/guide/volumes.md)). | Close all file handles (`with open(...)`) before calling `volume.reload()` ([Modal Volumes Guide](https://modal.com/docs/guide/volumes.md)). |
| **Vast.ai** | Running `vastai destroy instance <id>` without `-y`, causing the agent's bash tool to hang indefinitely on a confirmation prompt ([Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)). | Always pass `-y`: `vastai destroy instance <id> -y` ([Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)). |
| **Vast.ai** | Searching with `--type bid` and calling `create instance` without `--bid_price`, which silently rents at the full on-demand price ([Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)). | Always pass `--bid_price <price>` (or `"price": <price>` in REST API) when launching interruptible instances ([Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)). |
| **Vast.ai** | Copying files via `vastai copy` to `<id>:/root` or `<id>:/`, which corrupts SSH `.ssh/authorized_keys` permissions and locks out the agent ([Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)). | Always target `/workspace/...` (`vastai copy local:./dir <id>:/workspace/dir`) ([Vast.ai CLI Skill](https://raw.githubusercontent.com/vast-ai/vast-cli/master/vastai/SKILL.md)). |
| **Vast.ai** | Stopping an instance (`stop instance`) instead of destroying it (`destroy instance`), which continues accruing disk storage charges indefinitely ([Vast.ai Python SDK Quickstart](https://docs.vast.ai/sdk/python/quickstart)). | Use `destroy instance` once checkpoints/artifacts are extracted ([Vast.ai Python SDK Quickstart](https://docs.vast.ai/sdk/python/quickstart)). |
