# Load testing (Phase 9)

How to run the FlowForge load test. **Results and analysis live in
[`../LOAD_TESTING.md`](../LOAD_TESTING.md)** — this file is just the runbook.

## What it does

Drives the execution pipeline with a deliberately cheap workflow
(`trigger-webhook → action-delay → output-log`) so the test stresses the
**webhook → Bull queue → worker → SQLite** path rather than OpenAI/SMTP/Slack.

- `webhook_load.js` — k6 script. `setup()` registers a user, builds the workflow,
  and creates a webhook; the VU loop floods `POST /api/webhooks/:key` while k6
  ramps 1 → ~80 VUs.
- `monitor.js` — runs inside the server container; samples Bull queue depth and
  reports real trigger→completion latency from the `executions` table (k6 only
  sees enqueue time).
- `docker-compose.loadtest.yml` — test-only env overrides (rate-limit knobs).

## Prerequisites

Docker + Docker Compose. k6 runs from the `grafana/k6` image (no host install).

## 1. Bring up the stack (with load-test overrides)

```bash
cd flowforge
# Pipeline test: all rate limiting OFF (documented test-only exception)
LT_DISABLE_RATE_LIMIT=true \
  docker compose -f docker-compose.yml -f load-testing/docker-compose.loadtest.yml \
  up -d --build

# Confirm the compose network name (used below); usually flowforge_default
docker network ls | grep flow
```

## 2. Start the server-side monitor

```bash
SERVER=$(docker compose ps -q server)
docker cp load-testing/monitor.js "$SERVER":/tmp/monitor.js
# Poll queue depth + execution counts once a second into a log
docker compose exec -T server node /tmp/monitor.js sample 1000 | tee load-testing/last-run.csv
```

## 3. Run k6 on the compose network

```bash
NET=$(docker network ls --format '{{.Name}}' | grep -m1 flow)
docker run --rm --network "$NET" \
  -v "$PWD/load-testing":/scripts -e BASE_URL=http://server:3001 \
  grafana/k6 run /scripts/webhook_load.js
```

Tunables: `-e VUS=80 -e RAMP=120s -e HOLD=30s -e DELAY_MS=150 -e SLEEP_MS=0`.

## 4. Pull the latency report

```bash
# Use a timestamp from just before the run started
docker compose exec -T server node /tmp/monitor.js report 2026-06-15T00:00:00Z
```

## Two run modes

| Mode | Bring-up env | Measures |
|------|--------------|----------|
| Webhook-limit probe | *(omit `LT_DISABLE_RATE_LIMIT`)* | VU level where the 60/min/IP limiter starts returning 429 |
| Pipeline throughput | `LT_DISABLE_RATE_LIMIT=true` | accepted req/s, queue growth, trigger→completion latency, error rate |

## Teardown

```bash
docker compose -f docker-compose.yml -f load-testing/docker-compose.loadtest.yml down
```
