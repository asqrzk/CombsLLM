#!/usr/bin/env bash
# hive — wake the whole CombsLLM hive with one command:
#   1. combs serve (the engine, if not already healthy)
#   2. the Deno platform with the emoji host dylib wired in
#
#   deno task hive          reuse a healthy engine, refuse a busy platform port
#   deno task hive --new    KILL whatever holds the platform + engine ports,
#                           then boot everything fresh
#
# Overrides (all optional):
#   COMBS_BIN         engine binary      (default: sibling CombsEngine release build)
#   COMBS_MODEL       model dir          (default: ~/.cache/combs/models/smollm2-360m)
#   COMBS_ENGINE_URL  engine base URL    (default: http://127.0.0.1:8080)
#   COMBS_MESH_LIB    mesh FFI dylib     (default: sibling CombsEngine release build)
#   PORT/HOST         platform bind      (default: 8787 / 127.0.0.1, as server/main.ts)
set -euo pipefail

COMBS_BIN="${COMBS_BIN:-$HOME/Projects/CombsEngine/Engine/Core/target/release/combs}"
COMBS_MODEL="${COMBS_MODEL:-$HOME/.cache/combs/models/smollm2-360m}"
ENGINE_URL="${COMBS_ENGINE_URL:-http://127.0.0.1:8080}"
MESH_LIB="${COMBS_MESH_LIB:-$HOME/Projects/CombsEngine/Engine/Core/target/release/libcombsmesh_ffi.dylib}"
PLATFORM_PORT="${PORT:-8787}"
ENGINE_PORT="${ENGINE_URL##*:}"; ENGINE_PORT="${ENGINE_PORT%/}"

FRESH=0
for arg in "$@"; do
  case "$arg" in --new|--fresh) FRESH=1 ;; *) echo "[hive] unknown flag: $arg (only --new)" >&2; exit 2 ;; esac
done

killport() {
  local port="$1" pids
  pids=$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "[hive] killing listener(s) on :$port — pid $(echo $pids | tr '\n' ' ')"
    kill $pids 2>/dev/null || true
    for _ in $(seq 1 10); do
      lsof -nP -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || return 0
      sleep 0.5
    done
    echo "[hive] :$port still held — SIGKILL"
    kill -9 $pids 2>/dev/null || true
    sleep 0.5
  fi
}

if [ "$FRESH" = 1 ]; then
  killport "$PLATFORM_PORT"
  killport "$ENGINE_PORT"
elif lsof -nP -tiTCP:"$PLATFORM_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[hive] :$PLATFORM_PORT is already serving — a CombsLLM server is running." >&2
  echo "[hive] open http://localhost:$PLATFORM_PORT/ … or restart fresh:  deno task hive --new" >&2
  exit 1
fi

ENGINE_PID=""
cleanup() { [ -n "$ENGINE_PID" ] && kill "$ENGINE_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# ── 1. engine ───────────────────────────────────────────────────────
if curl -sf -m 2 "$ENGINE_URL/health" >/dev/null 2>&1; then
  echo "[hive] engine already healthy at $ENGINE_URL — reusing it (hive --new restarts it)"
else
  [ -x "$COMBS_BIN" ] || { echo "[hive] engine binary not found: $COMBS_BIN (set COMBS_BIN)" >&2; exit 1; }
  echo "[hive] starting engine: combs serve --model $COMBS_MODEL --port $ENGINE_PORT"
  "$COMBS_BIN" serve --model "$COMBS_MODEL" --port "$ENGINE_PORT" &
  ENGINE_PID=$!
  up=""
  for _ in $(seq 1 60); do
    curl -sf -m 2 "$ENGINE_URL/health" >/dev/null 2>&1 && { up=1; break; }
    sleep 1
  done
  [ -n "$up" ] || { echo "[hive] engine failed to start on $ENGINE_URL" >&2; exit 1; }
  echo "[hive] engine up at $ENGINE_URL"
fi

# ── 2. emoji host ───────────────────────────────────────────────────
if [ -f "$MESH_LIB" ]; then
  echo "[hive] emoji host: $MESH_LIB"
  export COMBS_MESH_LIB="$MESH_LIB"
else
  echo "[hive] warning: mesh dylib not found at $MESH_LIB — emoji host will boot DISABLED"
fi

# ── 3. platform (foreground — Ctrl-C stops the whole hive) ──────────
export COMBS_ENGINE_URL="$ENGINE_URL"
exec deno run --allow-net --allow-read --allow-write --allow-env --allow-ffi server/main.ts
