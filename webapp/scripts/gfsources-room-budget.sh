#!/usr/bin/env bash
# Measures every gfsources font against the room budgets, then reports.
# Usage: scripts/gfsources-room-budget.sh <gfsources/babelfont dir> <out dir> [--dump]
# Resumable: fonts already in <out dir>/rooms-*.jsonl are skipped. Each Jest
# run measures a batch, because one process cannot hold the whole library.
set -euo pipefail
cd "$(dirname "$0")/.."
FONTS="$(cd "$1" && pwd)"
OUT="$2"
SHARDS="${GF_SHARDS:-3}"
BATCH="${GF_BATCH:-60}"
mkdir -p "$OUT"
DUMP=""
if [[ "${3:-}" == "--dump" ]]; then DUMP="$OUT/dump"; fi

run_shard() {
  local shard="$1" file="$OUT/rooms-$1.jsonl"
  while :; do
    local before=0
    [[ -f "$file" ]] && before=$(wc -l <"$file")
    GFSOURCES_DIR="$FONTS" GF_OUT="$file" GF_DUMP_DIR="$DUMP" \
      GF_SHARD="$shard" GF_SHARDS="$SHARDS" GF_MAX="$BATCH" \
      NODE_OPTIONS="--max-old-space-size=12288" \
      npx jest tests/gfsources-room-budget.test.js >"$OUT/shard-$shard.log" 2>&1 || true
    local after=0
    [[ -f "$file" ]] && after=$(wc -l <"$file")
    [[ "$after" -eq "$before" ]] && break
  done
}

for ((s = 0; s < SHARDS; s++)); do run_shard "$s" & done
wait
node scripts/gfsources-room-budget-report.mjs "$OUT" "$FONTS"
