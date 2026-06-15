#!/usr/bin/env sh
# Phase 9 load-test orchestrator. ONE script drives every run so the before/after
# comparison is identical by construction — only the server image differs.
#
#   ./load-testing/run.sh baseline            # pipeline throughput, rate limiting OFF
#   REBUILD=1 ./load-testing/run.sh after     # same, after a code change (rebuild server)
#   MODE=probe ./load-testing/run.sh limit    # webhook-limiter probe, limiter ON
#
# Run from the flowforge/ dir (or anywhere — it cd's there). Outputs land in
# load-testing/results/<label>_{k6.txt,k6.json,queue.csv,report.json}.
#
# What it captures:
#   k6.txt/json  — accepted 202s, 429s, HTTP req rate, enqueue (trigger) latency
#   queue.csv    — Bull queue depth + execution-status counts, 1 Hz, during the run
#   report.json  — real trigger->completion latency + completion throughput from SQLite
set -eu

cd "$(dirname "$0")/.."                      # -> flowforge/
LABEL="${1:-run}"
MODE="${MODE:-pipeline}"                      # pipeline | probe
OUT="load-testing/results"
mkdir -p "$OUT"

COMPOSE="docker compose -f docker-compose.yml -f load-testing/docker-compose.loadtest.yml"
NET="$(docker network ls --format '{{.Name}}' | grep -m1 -E 'flowforge[_-]default' || echo flowforge_default)"

# k6 shape per mode. Pipeline floods to saturate the worker; probe is a short,
# gentle run whose only job is to show where the 60/min webhook limiter starts 429ing.
if [ "$MODE" = "probe" ]; then
  VUS="${VUS:-20}"; RAMP="${RAMP:-10s}"; HOLD="${HOLD:-50s}"; SAMPLE_SECS="${SAMPLE_SECS:-75}"
  RL_ENV=""                                  # limiter ON (only AUTH limit is raised, in the override)
else
  VUS="${VUS:-80}"; RAMP="${RAMP:-120s}"; HOLD="${HOLD:-30s}"; SAMPLE_SECS="${SAMPLE_SECS:-200}"
  RL_ENV="LT_DISABLE_RATE_LIMIT=true"        # all limiters OFF (documented test-only exception)
fi
DELAY_MS="${DELAY_MS:-150}"

echo "== Phase 9 run: label=$LABEL mode=$MODE vus=$VUS ramp=$RAMP hold=$HOLD delayMs=$DELAY_MS net=$NET"

# --- bring the stack up in the right rate-limit mode ---
BUILD=""; [ "${REBUILD:-0}" = "1" ] && BUILD="--build"
# shellcheck disable=SC2086
env $RL_ENV $COMPOSE up -d $BUILD --no-deps redis server >/dev/null 2>&1

# wait for health WITHOUT sleep (read -t is a clean bounded pause)
i=0
until docker compose exec -T server wget -qO- http://localhost:3001/api/health >/dev/null 2>&1; do
  i=$((i+1)); [ "$i" -ge 90 ] && { echo "server never became healthy"; exit 1; }
  read -t 1 _ </dev/null 2>/dev/null || true
done
echo "server healthy"

# monitor.js must live in /app so its require('bull')/require('better-sqlite3')
# resolve against /app/node_modules (Node resolves from the file's dir, not cwd).
$COMPOSE cp load-testing/monitor.js server:/app/monitor.js

# --- start the server-side queue-depth sampler (bounded; no manual sleep) ---
START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
timeout "$SAMPLE_SECS" docker compose exec -T server node /app/monitor.js sample 1000 \
  > "$OUT/${LABEL}_queue.csv" 2>&1 &
SAMPLER=$!

# --- drive load with k6 on the compose network (reaches the server by name) ---
docker run --rm --network "$NET" -v "$PWD/load-testing":/scripts \
  -e BASE_URL=http://server:3001 -e VUS="$VUS" -e RAMP="$RAMP" -e HOLD="$HOLD" -e DELAY_MS="$DELAY_MS" \
  grafana/k6 run --summary-export="/scripts/results/${LABEL}_k6.json" /scripts/webhook_load.js \
  2>&1 | tee "$OUT/${LABEL}_k6.txt"

# stop the sampler
kill "$SAMPLER" 2>/dev/null || true
docker compose exec -T server pkill -f monitor.js 2>/dev/null || true

# --- pull the real trigger->completion latency for executions created this run ---
echo "== latency/throughput report (since $START) =="
docker compose exec -T server node /app/monitor.js report "$START" | tee "$OUT/${LABEL}_report.json"

echo "== queue depth (last 5 samples: iso,waiting,active,completed,failed,delayed,pend,run,done,fail) =="
tail -n 5 "$OUT/${LABEL}_queue.csv" || true
echo "== done: $LABEL =="
