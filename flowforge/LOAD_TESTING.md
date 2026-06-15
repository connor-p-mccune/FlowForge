# Load Testing & Scaling (Phase 9)

A measured performance pass on FlowForge's execution pipeline: establish a
baseline, find one bottleneck, make **one** targeted fix, and re-measure under an
identical load. The harness and runbook live in [`load-testing/`](load-testing/);
this document is the results + analysis.

> **TL;DR (the honest claim).** Under load testing, the webhook → Bull → worker
> pipeline *accepted* ~686 webhooks/sec but only *completed* **4.5 executions/sec**,
> because the Bull worker processed jobs **one at a time** (`queue.process()` with
> no concurrency argument). Setting worker concurrency to 10 raised completion
> throughput to **41 executions/sec — a ~9.2× improvement (near-linear)** from a
> one-line change, with **no increase in error rate**. It did **not** fix
> end-to-end latency under a flood that still exceeds capacity (see
> [Honest interpretation](#honest-interpretation)).

---

## Methodology

**Target path.** `POST /api/webhooks/:key` → insert `executions` row (`created_at`
stamped here) → enqueue Bull job → worker runs the DAG → write `execution_steps`
+ mark execution `completed`. To stress *that pipeline* and not external egress,
the test workflow is deliberately cheap — three nodes, no network calls:

```
trigger-webhook  →  action-delay (150 ms)  →  output-log
```

`action-delay` is a non-blocking `setTimeout`; `output-log` just `console.log`s.
No OpenAI / SendGrid / Slack nodes, so the worker is the only thing under test.

**Load generator.** [k6](https://k6.io) (`grafana/k6` image, run on the compose
network so it reaches the server by name). One `setup()` registers a user, builds
the workflow, and creates a webhook; the VU loop then floods `POST /api/webhooks/:key`
while k6 ramps **1 → 80 VUs over 120 s and holds 30 s**. Script:
[`load-testing/webhook_load.js`](load-testing/webhook_load.js).

**What's measured, and how.** k6 only sees the HTTP/enqueue layer, so a server-side
[`monitor.js`](load-testing/monitor.js) captures what happens *behind* the webhook:

| Source | Metric |
|--------|--------|
| k6 summary | accepted `202`/sec, `429` count, HTTP error rate, **enqueue** (trigger) latency |
| `monitor.js sample` (1 Hz) | Bull queue depth (`waiting`/`active`) + execution-status counts |
| `monitor.js report` | **real trigger→completion latency** (`finished_at − created_at`) + completion throughput, for executions created during the run (timestamp-filtered) |

**Environment.** Local `docker-compose` **production images** (`NODE_ENV=production`),
`server` + `redis` only (the cheap workflow never touches `client`/`ai-service`),
on a single GitHub Codespaces host. SQLite in **WAL** mode on a Docker volume.
**These are relative before/after numbers on identical hardware — not absolute
capacity claims.** Both runs were driven by the same script via
[`load-testing/run.sh`](load-testing/run.sh), so the *only* difference between
baseline and after is the server image (the one-line worker change). Between runs
the Bull queue was emptied (`redis-cli FLUSHALL`) and the worker restarted so each
run starts from an empty queue; latency/throughput are timestamp-filtered to the
run's own window.

**Rate-limit exception (documented, test-only).** Phase 7 caps the public webhook
trigger at **60/min/IP**. A single-source flood trips that in well under a second,
so the throughput runs set `DISABLE_RATE_LIMIT=true` via
[`docker-compose.loadtest.yml`](load-testing/docker-compose.loadtest.yml) — a
test-only override that never ships. A separate **probe run with the limiter ON**
measures exactly where it starts rejecting (below).

---

## Step 2 — Baseline (worker concurrency = 1)

80 VUs, ramp 120 s + hold 30 s, 150 ms delay node, rate limiting off.

| Metric | Result |
|--------|--------|
| Accepted enqueue rate | **686 req/s** (103,099 × `202`) |
| HTTP error rate | **0%** (0 / 103,104) |
| Enqueue (trigger) latency | avg 69 ms · p50 55 ms · p95 174 ms · max 532 ms |
| **Completion throughput** | **4.46 executions/s** |
| Bull queue `active` | **1** for the entire run |
| Bull queue `waiting` | 0 → **~102,400** (linear, ~680/s) |
| **End-to-end trigger→completion** | **p50 62.7 s · p95 140.9 s · p99 148.5 s** |
| Executions completed within the 150 s window | **674 of 103,099 (0.65%)** |

Queue depth over the run — backlog climbs linearly while exactly one job runs:

```
elapsed   q_waiting   q_active
  1 s            0         0
 31 s       19,543         1
 61 s       40,608         1
 91 s       61,938         1
121 s       82,124         1
151 s      102,431         1     ← accepts ~680/s, drains ~4.5/s, never catches up
```

The system accepts webhooks **~150× faster than it can execute them**. Enqueue is
cheap (one INSERT + a Redis push); the worker is the wall.

### Webhook rate-limit probe (limiter ON, 60/min/IP)

20 VUs, ~60 s, `DISABLE_RATE_LIMIT` unset (auth limit raised so `register` still works):

| Metric | Result |
|--------|--------|
| Accepted (`202`) | **74** |
| Rejected (`429`) | **94,254** (≈ **99.9%** of requests) |
| First `429` | within **~1 s** of the flood starting |

The 60/min/IP limit caps a single source at ~1 req/s — correct for abuse
protection, but it makes a single-IP load test impossible without the documented
test-only override. There is **no "safe" concurrency** under it: any sustained
rate above ~1 req/s from one IP starts returning `429` almost immediately.

---

## Step 3 — Bottleneck

**Bull worker concurrency = 1.** `server/src/workers/executionWorker.js` called
`queue.process(async (job) => …)` with **no concurrency argument**. Bull defaults
to **1**, so every execution runs strictly sequentially regardless of how fast
webhooks enqueue.

Evidence, not assumption:
- Bull `active` count pinned at **1** for the whole baseline.
- Accept rate (686/s) vs completion rate (4.46/s) — a ~150× gap.
- `waiting` grows linearly and without bound (102k in 150 s).

**Candidates ruled out (verified in code):**
- **SQLite write contention / WAL** — WAL is already enabled
  (`config/database.js`: `db.pragma('journal_mode = WAL')`). Not the limiter.
- **Missing indexes** — the hot write path (`executions` / `execution_steps`) is
  all primary-key-keyed; the analytics indexes from Phase 8 already exist. Writes
  are not the limiter at this scale.
- **Secondary factor:** the API and the worker share **one Node event loop**, so
  under enqueue pressure the worker drained at 4.46/s vs a ~6.6/s (1000/150 ms)
  uncontended ceiling. Real, but small next to the 150× concurrency gap.

---

## Step 4 — The fix (one change)

`server/src/workers/executionWorker.js` — let Bull process up to N jobs at once:

```diff
+// Process up to EXEC_CONCURRENCY jobs concurrently — runExecution keeps all
+// per-run state in locals and better-sqlite3 serialises writes on its single
+// synchronous connection, so concurrent runs interleave safely at await points.
+const CONCURRENCY = Math.max(1, Number(process.env.EXEC_CONCURRENCY || '10'))
 ...
-  queue.process(async (job) => {
+  queue.process(CONCURRENCY, async (job) => {
```

One line of behaviour change, env-tunable, default **10**. It is safe because
`runExecution` holds all per-run state in local variables and `better-sqlite3`
serialises writes on its single synchronous connection — concurrent runs interleave
at `await` points (the 150 ms delay) with no shared-state races. Nothing else was
touched, so the before/after is clean.

---

## Step 5 — After (worker concurrency = 10)

Identical run — same `run.sh`, same 80 VUs / 120 s + 30 s, only the server image
differs.

| Metric | Result |
|--------|--------|
| Accepted enqueue rate | 527 req/s (79,300 × `202`) |
| HTTP error rate | **0%** (0 / 79,305) |
| Enqueue (trigger) latency | avg 91 ms · p50 70 ms · p95 213 ms · max 614 ms |
| **Completion throughput** | **41.14 executions/s** |
| Bull queue `active` | **10** for the entire run |
| Bull queue `waiting` | 0 → **~73,000** (~480/s) |
| End-to-end trigger→completion | p50 59.8 s · p95 127.5 s · p99 133.3 s |
| Executions completed within the 150 s window | **6,237 of 79,300** |

```
elapsed   q_waiting   q_active
  1 s            0         0
 41 s       15,560        10
 81 s       35,978        10
121 s       57,128        10
141 s       67,393        10     ← 10 jobs in flight; backlog grows ~9× slower
```

---

## Before / after

| Metric | Baseline (concurrency 1) | After (concurrency 10) | Change |
|--------|--------------------------|------------------------|--------|
| Worker `active` jobs | 1 | 10 | the fix |
| **Completion throughput** | **4.46 exec/s** | **41.14 exec/s** | **+822% (9.2×)** |
| Executions completed in 150 s | 674 | 6,237 | **9.3×** |
| `waiting` growth rate | ~680/s | ~480/s | backlog builds ~9× slower per completed job |
| HTTP error rate | 0% | 0% | unchanged |
| Accepted enqueue rate | 686 req/s | 527 req/s | −23% (see below) |
| Enqueue latency p95 | 174 ms | 213 ms | +23% |
| E2E latency p50 / p95 | 62.7 s / 140.9 s | 59.8 s / 127.5 s | −5% / −9% |

**Headline:** one line (worker concurrency 1 → 10) increased execution throughput
**~9.2×** — near-linear with the concurrency increase (~92% efficiency), because the
per-job cost is dominated by the non-blocking 150 ms delay, so 10 jobs overlap
their waits cheaply. No error-rate regression.

---

## Honest interpretation

This is a real number for a résumé, so the caveats matter:

- **What improved: throughput.** ~9× more executions complete per second. That is
  the defensible claim: *"identified a sequential-execution bottleneck via k6 load
  testing and lifted execution throughput ~9× (4.5 → 41 exec/s) with a one-line
  worker-concurrency change, no error-rate regression."*
- **What did *not* improve: end-to-end latency under sustained overload.** Both
  runs flood the system far past its capacity (527–686 req/s offered vs 4.5–41/s
  drained), so a backlog still forms and per-execution queue wait still dominates
  (p95 stayed ~2 minutes). The fix multiplies *capacity*, it does not make an
  over-saturated queue drain in real time. Latency only stays bounded when offered
  load ≤ capacity.
- **Accepted enqueue rate dropped 23% (686 → 527 req/s).** Expected: the single
  Node process now spends more event-loop time executing jobs, leaving less for the
  API. A real trade-off of co-locating the API and the worker in one process.
- **41/s is not a hard ceiling.** With concurrency 10 and a 150 ms delay the
  per-job CPU is tiny, so throughput scaled almost linearly; higher concurrency
  would push further until the single Node event loop / single SQLite writer
  saturates. 10 was chosen as a safe, demonstrative value (`EXEC_CONCURRENCY` is
  env-tunable).

### Recommended next steps (not done here — one change at a time)

1. **More worker capacity** — raise `EXEC_CONCURRENCY`, and/or run the worker in
   its own process(es) separate from the API so execution and request handling stop
   competing for one event loop (Bull supports multiple processors on the queue).
2. **Back-pressure** — cap queue depth / shed or 429 new triggers when the backlog
   is beyond a threshold, so latency degrades gracefully instead of unbounded.
3. **Re-measure the next bottleneck** — at high concurrency the single SQLite
   writer (one synchronous connection) becomes the likely next wall; that's the
   point where "SQLite only" would need revisiting.

---

## Reproduce

```bash
cd flowforge
# baseline (rate limiting OFF; test-only)
./load-testing/run.sh baseline
# apply the one-line fix in server/src/workers/executionWorker.js, then:
docker compose exec redis redis-cli FLUSHALL
REBUILD=1 ./load-testing/run.sh after
# webhook-limiter probe (limiter ON)
MODE=probe ./load-testing/run.sh limit
```

Raw outputs for the runs in this document are under
`load-testing/results/{baseline,after,limit}_{k6.txt,k6.json,queue.csv,report.json}`.
See [`load-testing/README.md`](load-testing/README.md) for the manual step-by-step.
