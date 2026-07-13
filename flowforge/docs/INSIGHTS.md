# Run insights & SLA monitoring

FlowForge records every run and every step; this feature turns that history into
answers — *how long does this workflow take, is it getting worse, which run was
abnormal, and did it hold its promises?* — and raises an alert when a workflow
misses an objective. The user-facing surface is the canvas's **📊 Insights**
panel, `flowforge insights` in the terminal, and
`GET /api/v1/workflows/:id/insights`; this document is the how-and-why.

- [What it computes](#what-it-computes)
- [Why a robust anomaly score](#why-a-robust-anomaly-score)
- [SLA targets and the monitor](#sla-targets-and-the-monitor)
- [Where the hook lives](#where-the-hook-lives-and-why)
- [Surfaces](#surfaces)

---

## What it computes

`services/runStats.js` is a pure, dependency-free statistics module — plain
functions of number arrays, no database, no engine — so it is exhaustively
unit-testable and every surface shares one implementation. The insights route
(`routes/insights.js`, `computeInsights`) is the SQL that feeds it:

- **Duration percentiles** (p50/p90/p95/p99) over the window's *completed* runs.
  A failed run's wall time includes retry backoff and stops at the failing node,
  so it answers "how long until it broke", not "how long a run takes" — it is
  excluded from the duration distribution but still counted everywhere else.
- **Success rate** over *settled* runs (`completed / (completed + failed)`).
  Cancellations are a human action, not a failure, so they're excluded from the
  denominator rather than counted against the workflow.
- **Throughput** over the actual time span the window covers — honest for a
  workflow that fires every minute and one that fires monthly alike.
- **Slowest steps**, grouped by node id and averaged over successful executions
  (skipped steps are ~0 ms; failed ones carry backoff), so "what should I
  optimise" has a standing answer beyond a single run's critical path.
- **Duration trend** — is the workflow getting *slower over time*? A
  Mann-Kendall trend test over the completed durations (below).
- **Per-run anomaly flags** — each recent run tagged normal / slow / severe by
  the modified z-score below.

Dry-runs (test mode) are excluded throughout, exactly like the status badge:
insights describe production behaviour, so a test run never skews a percentile or
trips an anomaly flag.

### Percentiles

Percentiles use **linear interpolation between order statistics** (the "R-7"
method — NumPy's default and Excel's `PERCENTILE.INC`), not a nearest-rank pick.
For the small samples a single workflow produces, interpolating avoids a p95 that
lurches between two raw observations as one run ages out of the window.

### Trend

The anomaly score answers "is *this run* abnormal?"; the trend answers "is the
*workflow* drifting?" — a slow creep no single run trips. It uses the
**Mann-Kendall test**, a non-parametric test for a monotonic trend:

```
S = Σ_{i<j} sign(xⱼ − xᵢ)
```

counts concordant minus discordant pairs across the time-ordered durations.
Non-parametric is the right call twice over: it assumes neither that the trend is
*linear* (a workflow degrades in steps, not straight lines) nor that the noise is
Gaussian (durations aren't), and it inherits the same rank-based robustness the
anomaly score has. Under the no-trend null, S is approximately normal with a
variance that includes a **tie correction** (durations repeat), a continuity
correction gives the z-statistic, and Kendall's τ = S / (n(n−1)/2) is the effect
size. A trend is reported only when |z| clears the 95% cut-off and there are at
least eight completed runs — an increasing duration series reads as *degrading*,
decreasing as *improving*, everything else as *flat*.

---

## Why a robust anomaly score

"Was this run abnormally slow?" is an outlier question, and the obvious answer —
a classic z-score, `(x − mean) / stdev` — is the wrong tool here. A workflow's
durations are **heavy-tailed**: a handful of runs that hit a cold cache or a slow
upstream sit far above the body of the distribution. The mean and standard
deviation a z-score needs are themselves dragged toward those very outliers, so
the outlier masks itself — the thing you want to detect inflates the yardstick
you'd measure it with.

FlowForge uses the **modified z-score** of Iglewicz & Hoaglin (1993), built on
the **median** and the **median absolute deviation** (MAD):

```
Mᵢ = 0.6745 · (xᵢ − median) / MAD          where MAD = median(|xᵢ − median|)
```

The median and MAD have a ~50% breakdown point — half the sample can be
pathological before the estimate moves — which is exactly what a "typical
duration" baseline wants. The constant `0.6745` (the 0.75 quantile of the
standard normal) rescales MAD so the score is comparable to an ordinary z-score,
and the recommended cut-off is `|Mᵢ| > 3.5`.

Three details make it hold up in practice:

- **The MAD = 0 fallback.** When more than half the runs share the median
  duration (common for a fast, near-constant step) the MAD is 0 and the formula
  is undefined. The monitor falls back to the mean-absolute-deviation form
  Iglewicz & Hoaglin give for exactly this case, `Mᵢ = (xᵢ − median) / (1.253314
  · meanAD)`.
- **One-sided.** Only *slower* than usual is actionable — a run that finishes
  unusually fast is good news, not an alert — so the outlier criterion is
  one-sided (`score > 3.5`), while the severity bucket (`normal` / `slow` /
  `severe`) keys off the magnitude for the UI.
- **A minimum baseline.** With too few points the MAD isn't a trustworthy scale
  estimate, so fewer than three runs score zero and the *alerting* path requires
  a larger baseline still (`SLA_ANOMALY_MIN_RUNS`, default 20) before it will
  fire. This keeps false positives near zero: by construction, outliers are rare.

---

## SLA targets and the monitor

A workflow can declare two optional, independent objectives (Run settings panel,
or `PUT /api/workflows/:id`):

| Target | Column | Meaning |
|---|---|---|
| Max run duration | `sla_max_duration_ms` | wall-time budget a completed run should stay under |
| Min success rate | `sla_min_success_rate` | floor the rolling success rate must hold (0–1) |

`services/slaMonitor.js` evaluates a finished run against them plus the anomaly
check. Three composable verdicts — a run can trip more than one:

1. **Duration budget** — a completed run whose wall time exceeds the budget.
2. **Statistical anomaly** — a completed run flagged by the modified z-score
   above. Needs no configuration; fires only with a real baseline.
3. **Success-rate floor** — the rolling rate over the last `N` settled runs
   (`SLA_SUCCESS_RATE_WINDOW`, default 20) dropping below the floor.

The success-rate check is **edge-triggered**: it alerts on the run that *crosses*
the floor, not on every run while the workflow stays degraded. It compares the
window ending at this run against the window ending just before it and fires only
on the transition — so a sustained outage is one alert, not a storm of them. This
is ordinary alerting hygiene (alert on state change, not on state), implemented
without any extra "already alerted" bookkeeping: the previous window *is* the
prior state.

A breach fans out to two surfaces that already exist rather than inventing a
third:

- an **`execution.sla_breached` activity event**, which the outbound-webhook
  dispatcher (`eventDispatcher.js`) already relays to any subscribed URL — so an
  SLA breach becomes a webhook to your incident tooling for free;
- an in-app **notification to the workflow owner**, the same channel a failed run
  uses.

---

## Where the hook lives (and why)

The monitor is called from the **execution worker**, once, right after the engine
records a top-level run's terminal status — deliberately *not* from inside the
engine's scheduling loop. The worker only ever processes top-level runs
(sub-workflow child runs execute inside their parent's engine loop and never pass
through the queue), so "top-level, settled, real run" — precisely the monitor's
contract — falls out of *where* the hook lives rather than needing a flag to
enforce it.

Every path is **best-effort**: `evaluateRun` swallows its own errors and the
worker wraps the call again, so a monitoring fault can never surface as a run
failure. Monitoring the run must never be able to break the run.

---

## Surfaces

Everything reads the one `computeInsights`, so the panel, the CLI, and the public
API can't drift:

- **Canvas** — the 📊 Insights panel: headline success rate / throughput /
  anomaly count, a hand-drawn duration sparkline with anomalous runs marked, the
  percentile grid, an SLA scorecard, and the slowest steps by node label.
- **CLI** — `flowforge insights <workflow-id> [--limit N]` prints the same
  rollup, so a chat-ops bot or a dashboard cron can surface it.
- **Public API** — `GET /api/v1/workflows/:id/insights` (`read` scope),
  documented in the [OpenAPI spec](./API.md#machine-readable-spec).

### Tuning

| Variable | Default | Effect |
|---|---|---|
| `SLA_SUCCESS_RATE_WINDOW` | 20 | Runs in the rolling success-rate window |
| `SLA_SUCCESS_RATE_MIN_RUNS` | 5 | Minimum settled runs before the floor check fires |
| `SLA_ANOMALY_MIN_RUNS` | 20 | Minimum completed-run baseline before an anomaly alert fires |

The statistics behind all of this live in `services/runStats.js`; the design
rationale for the rest of the engine is in [ARCHITECTURE.md](./ARCHITECTURE.md).
