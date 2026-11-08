#!/usr/bin/env bash
# Stop ONLY the processes listening on this run's two ports, by exact PID. Refuses
# port 3080 (the user's own DSH). Usage: stop.sh [E]
set -euo pipefail
E="${1:-$HOME/.cache/ah-live-e2e}"
DP="$(grep -o 'dsh web: http://[^/]*' "$E/boot.log" 2>/dev/null | sed -E 's/.*:([0-9]+)$/\1/' || true)"
PP="$(cat "$E/provider-port" 2>/dev/null || true)"
for port in $DP $PP; do
  [ "$port" = 3080 ] && { echo "refusing port 3080"; continue; }
  for pid in $(ss -ltnpH 2>/dev/null | awk -v p=":$port" '$4 ~ p"$"' | grep -o 'pid=[0-9]*' | cut -d= -f2); do
    echo "stopping pid $pid (port $port)"; kill "$pid" || true
  done
done
