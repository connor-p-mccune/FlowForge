# Output drift: nothing here was watching the data

Every monitor in FlowForge watches one of two things.

**Time** — duration percentiles, the Mann-Kendall trend, Pettitt's change point,
the critical path, the SLA budget. **Outcome** — success rate, the SLO error
budget, the heartbeat, the canary's two-proportion test.

Neither of them ever looks at a value.

So consider a workflow whose upstream API quietly starts returning `null` for
`customer.email` in 40% of records. Every run completes. Every step succeeds.
The durations are unchanged. The success rate is 100%. The graph is well-typed,
every declared invariant holds, every branch is reachable, no policy is
violated, the heartbeat is fine and the error budget is untouched — and forty
percent of the emails are not being sent.

That is a production incident that **no existing check in this codebase can
express**, because none of them is about the data.

The user-facing surfaces are the **Output drift** section of the 📊 Insights
panel, `flowforge drift`, `GET /api/v1/workflows/:id/drift`, and an opt-in alert
in Run settings. This document is the how-and-why.

> **Not to be confused with definition drift.** `flowforge diff` reports when the
> live graph and the document in git have diverged. This reports when the *data*
> has. Different question, different failure, different command.

- [What it compares](#what-it-compares)
- [What counts as a record](#what-counts-as-a-record)
- [The tests, and why those tests](#the-tests-and-why-those-tests)
- [Precision is the design](#precision-is-the-design)
- [Alerting on a fingerprint, not a boolean](#alerting-on-a-fingerprint-not-a-boolean)
- [What it deliberately does not do](#what-it-deliberately-does-not-do)
- [Surfaces](#surfaces)

---

## What it compares

**The last N runs against the N before them**, from the workflow's own history.
Fifty against two hundred, by default.

There is no expected schema to declare. That is deliberate, and it is the same
argument the policy engine makes for type-checking its rules when they are
saved: a schema somebody has to maintain by hand is a schema that goes stale,
and a stale schema reports every workflow compliant forever. A workflow's own
recent past is a baseline that maintains itself.

The baseline is deliberately several times the recent window. It has to be a
stable description of "normal", and a baseline as jumpy as the thing being
compared against it produces a monitor that alerts on its own noise.

---

## What counts as a record

`services/dataProfile.js` walks each stored step output into per-path
observations — a type histogram, a null count, a numeric sample, category
counts, string lengths. Nested objects become dotted paths
(`customer.address.city`).

Arrays are **descended into as well as measured**, which is what makes the
common case work at all. A workflow that fetches a list is one record per run at
the top level and hundreds of records one level down, and the field that breaks
is almost always down there. So `orders` gets a length and a type, and
`orders[].amount` gets every element.

Three rules decide which steps contribute, and each excludes data that would
otherwise be quietly wrong:

| Excluded | Why |
|---|---|
| Failed steps | `output_json` is an error object. Profiling it reports "the shape changed" every time something breaks — a fact the success rate already covers. |
| `reused` / `cached` steps | They adopted an **earlier** run's output. Letting them into the recent window injects the baseline's own values into the thing being compared against the baseline, biasing every verdict toward *nothing changed* — the one direction a monitor must never fail in. |
| Dry runs | A dry run simulates its side-effecting nodes, so its outputs are previews, not data. |

Every dimension is bounded — paths, depth, array width, categories, numeric
sample — because this runs on a read path and one workflow returning a 40 MB
document must not be able to stall it. When a bound bites, the report says so
rather than quietly describing a fraction of the data.

---

## The tests, and why those tests

Three statistics, in `services/statistics.js` alongside the canary's.

### Rates → a two-sided proportion test

Presence and null rate are proportions, so the pooled two-proportion z applies
directly. It is **two-sided**, unlike the canary's: a null rate that fell from
40% to 2% has changed exactly as much as one that rose, and quite possibly for
the same reason.

### Numbers → two-sample Kolmogorov-Smirnov

D is the largest vertical gap between the two empirical CDFs, with the
asymptotic Kolmogorov distribution and the small-sample correction from
*Numerical Recipes* §14.3.

Two properties make it the right tool. It is **distribution-free** — nobody knows
what distribution a workflow's outputs follow, and the alternative is to assume
one. And it is sensitive to a change in **shape**, not only in centre: a field
whose mean is unchanged but which has become bimodal is a real event, and a
t-test would report nothing at all.

### Categories → the population stability index

PSI is the symmetrised Kullback-Leibler divergence over binned proportions, with
the conventional cut-offs — under 0.1 nothing happened, 0.1 to 0.25 is worth a
look, over 0.25 is a real shift.

It is used instead of a chi-square goodness-of-fit test for one reason: **it does
not grow with the sample.** A chi-square over ten thousand records will call a
0.3% shift significant, which is true and useless. PSI is an effect size, and
its thresholds have meant the same thing in model monitoring for twenty years.

A category present in one window and absent from the other makes the log
infinite, so empty bins are floored at `1/(4n)` rather than at a fixed epsilon —
a fixed one would score the same missing category differently depending on how
many records happened to be in the window.

---

## Precision is the design

The same argument as [LINEAGE.md](./LINEAGE.md): a checker nobody reads is worse
than no checker, and the second false alarm is the one that trains somebody to
close the tab. Five rules, each because the obvious implementation produces a
finding that is technically true and worthless.

**Both windows must clear a per-path sample floor.** A field seen six times is
not evidence of anything.

**Every test needs an effect size, not just significance.** Over five hundred
records a KS test will find a real, permanent, 2% shift in a timestamp field.
Reporting it is precisely how the report gets ignored. So a distribution finding
needs `D ≥ 0.2` *and* `p < 0.05`; a rate finding needs a 10-point move.

**A high-cardinality string is an identifier, not a category.** Order ids are
100% new values in every window; PSI over them is always large and never means
anything. A string field whose distinct-value ratio is above 0.8 — or which
overflowed the category cap — is skipped, with a reason.

**A redacted value is excluded.** Secrets and declared-redacted fields are masked
before persistence, so a masked field's "distribution" is the redaction config.
Without this rule, adding a field to `redact` would show up as data drift, which
is the single most confusing false positive available.

**What could not be compared is counted and returned.** Every surface prints
"14 fields compared, 3 skipped". A report that silently omits its skips is
claiming a coverage it does not have.

The load-bearing test in the suite is not that a change is found. It is that two
windows of the same data produce an **empty report**.

---

## Alerting on a fingerprint, not a boolean

Every other monitor here is edge-triggered on a boolean: `heartbeat_alerted_at`
is set while a workflow is overdue, and while it is set the sweep stays silent.
That works because "overdue" is one state.

Drift is not one state. A **second** field breaking while the first is still
broken is new information and must alert. The same field still broken tomorrow
is not, and must not.

So the trigger is a **fingerprint** — a hash of `(node, path, kind)` over the
major findings. An unchanged set stays silent; a changed set alerts again; an
empty set closes the incident. Three transitions: `detected`, `changed`,
`recovered`.

### Recovery is later than it looks

Immediately after somebody fixes a field, the baseline **is** the broken period
and the recent window is the healthy one. That is still a change, and still the
same field, so the fingerprint is unchanged and nothing fires — no spurious
"it drifted again" on the good news.

The incident closes only once the drifted period has aged out of the baseline as
well: when the data has genuinely been normal for a full baseline window. That
is the right moment to tell somebody it is over, and both halves of the
behaviour are pinned by tests.

### Why a sweep

It is the fifth background sweep in the process, and the only one whose trigger
could not have been a run settling. The comparison is between two *windows* of
history, so there is no single run whose completion is the event — and the
analysis parses hundreds of stored documents, which is not something to do on
every run. Monitored workflows are re-analysed on an interval; unmonitored ones
are never visited at all.

---

## What it deliberately does not do

- **It does not fail a run.** A drift finding is about a population of runs; the
  run in front of you may be perfectly fine. It notifies, it lands on `/metrics`,
  and `--strict` can fail a *build* — but the engine never sees it.
- **It does not compare against another workflow, or an upstream contract.** The
  only baseline it trusts is the workflow's own past.
- **It does not report a node that appeared or disappeared.** That is a change to
  the graph, already covered by version diffs, and duplicating it here would be
  noise.
- **It does not see values the engine did not store.** Redaction runs first —
  which is the correct order, and is why declared-redacted fields are skipped
  rather than compared.

---

## Surfaces

| Where | What |
|---|---|
| 📊 **Insights panel** | An **Output drift** section: findings grouped under the node that produced them, each with the field, what changed, and both sides of it. Says "no change" plainly rather than rendering an empty section, and shows how much history it still needs when there isn't enough. |
| **Run settings** | The opt-in alert. The report is always available; this only decides whether the sweep visits the workflow. |
| `flowforge drift <id> [--strict]` | The report with evidence inline (`D=0.62`, `PSI=0.14`, `p=1.2e-14`). Reporting by default; `--strict` fails the build on a major finding. A workflow too young to compare exits 0 and says how many runs it still needs — a check that fails every new workflow's build is a check somebody deletes. |
| `GET /api/v1/workflows/:id/drift` | The same report, `read` scope, `?recent` / `?baseline` to widen the windows. |
| Activity feed & webhooks | `workflow.data_drift` and `workflow.data_drift_recovered`. |
| `/metrics` | `flowforge_data_drift_detections_total{kind}`. A rising count beside a flat error rate is the exact shape this feature exists for. |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DRIFT_CHECK_INTERVAL_MS` | 60000 | How often the sweep looks for workflows due a re-analysis. |
| `DRIFT_REANALYSE_INTERVAL_MS` | 1800000 | How often any one monitored workflow is re-analysed. |
