#!/usr/bin/env bash
# Start Movie Buddy. Opens http://127.0.0.1:4174/ (or whatever server.port says).
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_root"

port="$(python3 - <<'PY'
import json, pathlib
def load(name):
    try:
        return json.loads(pathlib.Path(name).read_text(encoding="utf-8"))
    except Exception:
        return {}
config = {**load("config.example.json"), **load("config.json")}
print(config.get("server", {}).get("port", 4174))
PY
)"

if curl -fsS --max-time 1 "http://127.0.0.1:${port}/api/state" >/dev/null 2>&1; then
  echo "Movie Buddy is already running at http://127.0.0.1:${port}/"
  exit 0
fi

exec python3 server.py
