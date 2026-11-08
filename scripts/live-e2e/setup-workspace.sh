#!/usr/bin/env bash
# Prepare the throwaway workspace for the live end-to-end run. Usage: setup-workspace.sh <dir>
set -euo pipefail
W="${1:?usage: setup-workspace.sh <workspace-dir>}"
mkdir -p "$W/out"
printf 'print(1)\n' > "$W/eval.py"
cat > "$W/make_fig.py" <<'PY'
import json, struct, zlib, os
os.makedirs("out", exist_ok=True)
def chunk(tag, data):
    c = struct.pack(">I", len(data)) + tag + data
    return c + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
w = h = 8
raw = b"".join(b"\x00" + bytes([40, 90, 160] * w) for _ in range(h))
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
open("out/fig.png", "wb").write(png)
json.dump({"metrics": {"acc": 0.8123, "n": 120}}, open("out/metrics.json", "w"))
PY
echo "workspace ready: $W"
