#!/usr/bin/env bash
# Start the scripted provider and an ISOLATED DSH (own DSH_HOME, own XDG dirs, random
# port). Never touches the user's DSH on :3080 or their PaperMemory store.
# Usage: start.sh [E]   (default E=$HOME/.cache/ah-live-e2e; profile e2e must exist)
set -euo pipefail
E="${1:-$HOME/.cache/ah-live-e2e}"; L="$(cd "$(dirname "$0")" && pwd)"
rm -f "$E/provider-port" "$E/receipt.json" "$E/boot.log" "$E/session.json"
mkdir -p "$E/xdg/data" "$E/xdg/config" "$E/xdg/cache"
rm -rf "$E/workspace" && bash "$L/setup-workspace.sh" "$E/workspace"
(cd "$E" && setsid nohup node "$L/provider.mjs" "$L/steps.mjs" "$E/provider-port" "$E/receipt.json" > "$E/provider.log" 2>&1 &)
for _ in $(seq 1 50); do [ -s "$E/provider-port" ] && break; sleep 0.1; done
PORT="$(cat "$E/provider-port")"
(cd "$E/home/profiles/e2e" && DSH_HOME="$E/home" XDG_DATA_HOME="$E/xdg/data" XDG_CONFIG_HOME="$E/xdg/config" XDG_CACHE_HOME="$E/xdg/cache" \
  DEEPSEEK_BASE_URL="http://127.0.0.1:$PORT" DEEPSEEK_API_KEY=local-e2e TEXTFOLD_SKIP_INSTALL=1 ZVEC_GREP_SKIP_INSTALL=1 \
  setsid nohup ./node_modules/.bin/dsh --profile e2e --no-open --port 0 > "$E/boot.log" 2>&1 &)
for _ in $(seq 1 90); do grep -q "dsh web:" "$E/boot.log" 2>/dev/null && break; sleep 2; done
grep -q "dsh web:" "$E/boot.log" || { echo "DSH did not come up"; tail -20 "$E/boot.log"; exit 1; }
sed -E 's|(dsh web: )http://[^ ]+|\1[bootstrap URL redacted]|' "$E/boot.log" | tail -8
