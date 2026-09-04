# Capacity: is the concurrency cap the right number?

`max_concurrent_runs` is a number somebody typed once. Everything downstream of
it — whether a run starts now or sits in the queue, whether a burst drains or
accumulates — follows from it, and nothing in the product ever said whether it
was a good number.

It is answerable in closed form. Three measurements decide it, and the database
already holds all three:

| | Column | |
|---|---|---|
| How often runs arrive | `created_at` | λ |
| How long each holds a slot | `finished_at − started_at` | 1/μ |
| How many slots there are | `max_concurrent_runs` | c |

The surfaces are `flowforge capacity <id>`,
`GET /api/v1/workflows/:id/capacity`, and the session route for the canvas.

This is a different question from [the forecast](./SCHEDULING.md), which is about
one run's makespan — how long the *work* takes once it starts. This is about the
queue in front of it.

---

## Two things the obvious implementation gets wrong

### 1. Utilisation is not wait

The usual dashboard divides running runs by the cap and alerts at 80%. Here is
what 80% actually means, at two pool sizes:

| ρ | c | A run waits |
|---|---|---|
| 0.8 | 1 | **4.00 ×** its own service time |
| 0.8 | 10 | **0.20 ×** its own service time |

Twenty times the experience at identical utilisation. One threshold across
differently-sized pools is not a conservative approximation of anything — it is
simultaneously paranoid about the large pool and blind to the small one.

This is the square-root staffing result in disguise: the headroom a pool needs
grows like √c, not like c. A ten-slot pool can safely run much hotter than a
one-slot pool, and a dashboard that treats them alike will page about the first
while the second quietly builds a backlog.

### 2. M/M/c is the textbook fix and it is still wrong here

Having decided to model the queue rather than eyeball the utilisation, the
obvious model is M/M/c: Poisson arrivals, exponential service, c servers,
Erlang C for the probability of waiting. It is the right shape and the wrong
assumption.

A workflow's service time is nothing like exponential:

- A run that waits on a **human approval** holds its slot for however long the
  human takes. Minutes or days, against a baseline of seconds.
- A run that **retries three times** holds it for four attempts and two
  backoffs.
- A run that hits a `delay` node holds it for exactly as long as the node says.

Squared coefficients of variation in the tens are ordinary here, not
pathological. And the wait scales with that variability, so an M/M/c-derived cap
under-provisions by however far off the assumption was.

---

## The model: Allen–Cunneen

The standard G/G/c approximation:

```
Wq(G/G/c)  ≈  (CV²ₐ + CV²ₛ) / 2  ×  Wq(M/M/c)
```

Two properties make this the right choice rather than merely a fancier one:

- **With both CV² = 1 the factor is exactly 1**, and it reduces to M/M/c. So it
  is safe to apply unconditionally: where the textbook assumptions hold, it
  changes nothing.
- **Both CV² are measured, not assumed.** A missing measurement returns `null`
  and the surfaces say so, rather than defaulting to the 1.0 that silently
  reasserts the exponential assumption this whole design exists to avoid.

`model.mmcWaitMeanMs` is in every payload: what M/M/c *would* have said. The
cost of the assumption is a number, not an argument.

### Erlang C by recurrence

```
B(0) = 1,   B(k) = a·B(k−1) / (k + a·B(k−1))
C(c, a) = B(c, a) / (1 − ρ(1 − B(c, a)))
```

Not the factorial form. `a^c / c!` overflows a double at c ≈ 170 and loses
precision well before that; the recurrence is bounded in [0, 1] at every step
and exact for any cap anybody will ever set. It is checked against published
Erlang tables *and* against direct summation of the series — a model that only
agrees with its own implementation is not one to size a production cap on.

---

## Peak, not mean

The first version of this measured one arrival rate: total runs over the
window. That is the wrong statistic for deciding a cap, and it is wrong in the
direction that matters.

A workflow taking 20 runs an hour on average and 200 every Monday at nine is
**unstable every Monday at nine**. Averaged over the week it reports 80%
utilised and looks fine. The queue does not experience the average.

So the report also measures the **busiest window** — directly, as a rolling
maximum over the actual arrivals:

| | Answers |
|---|---|
| Busiest **hour** | Does the queue absorb a *burst*? |
| Busiest **day** | Does it survive *sustained* load? |

Directly measured rather than modelled, and that choice is deliberate. An
hour-of-week decomposition would need several weeks of history before each of
its 168 buckets held more than one observation, and would then be asserting a
weekly seasonality the workflow may not have. A rolling window over the real
arrivals needs no calendar assumption, gives a week of history 168 candidate
positions instead of one sample per bucket, and answers the operational question
as somebody actually asks it: *what is the worst hour this has really had?*

One consequence worth stating, because it looks like a bug and is not: the
peak-hour rate is above the mean even for perfectly regular traffic, whenever
the spacing does not divide the window. Arrivals every 59.7 minutes really do
put two in some one-hour windows.

The peak is sized **separately**. `recommendation` covers the mean;
`peakRecommendation` covers the busiest hour. Provisioning for one hour a week
is a cost decision, and what this owes somebody is the number, not the choice.

---

## The report grades itself

Every capacity tool produces a model, and a model is a claim. This one is in the
unusual position of being able to check its own claim, because **the wait it
predicts is also recorded**: `started_at − created_at` is the queueing delay,
per run, already in the table.

So the report predicts the wait at the current cap, compares it against what
actually happened over the same window, and publishes the gap:

```console
$ flowforge capacity 6f0c… --target 5000
Capacity for Order processing  ·  cap 4
  336 runs over 7 days · 2.00/hour arriving · 30.0m mean service time

Model check: the model matches the measured wait (predicted 4.0s, saw 4.2s)

At 4 slot(s): 4.0s mean wait, 15.0s at p95, 50% utilised.
  Room for 2.00× today's traffic before the queue diverges.

At the busiest hour (60 runs from 2026-08-18 09:00, 60.0/hour)
  4 slot(s) cannot absorb that.
  The queue grows for the duration of the burst and drains afterwards.

What each cap buys
SLOTS    USED  MEAN WAIT  P95    HEADROOM
2        100%  unstable   —      —
4 (now)  50%   4.0s       15.0s  2.00×
6        33%   500ms      2.1s   3.00×

The current cap of 4 already meets 5.0s.
```

That check is the most valuable line in the output, and it leads for a reason: a
model that agrees with history has earned the counterfactual it is really being
asked for — *what would the wait be at a cap of 8?* — which is the one question
no amount of measurement can answer, because that cap was never run.

| `verdict` | Means |
|---|---|
| `agrees` | Prediction within 2× of measurement either way. Act on the rest. |
| `over-predicts` | Predicts more wait than happened. The safe direction: a cap sized on it is generous. |
| `under-predicts` | Predicts less. Something the model cannot see is holding runs up. |
| `no-queue-to-check` | Both near zero. An idle queue is not evidence either way. |
| `not-enough-history` | Too few recorded waits to compare. |

A failed check does not withhold the recommendation — it **downgrades** it.
`recommendation.confident: false`, and the CLI prints *"treat this as a
suggestion"*. Same number, weaker claim. Withholding it entirely would just send
somebody back to guessing, which is what they were doing before.

The asymmetry between `over-` and `under-predicts` is deliberate. Over-predicting
is the safe direction. Under-predicting is the one that under-provisions, so it
gets the sharper language.

---

## Headroom, and refusing to quote a number

`headroom` is the multiple of today's arrival rate at which the current cap
saturates — *"room for 2.00× today's traffic"*. It is the single most actionable
number in the report, because it is the one somebody can read before anything is
on fire, rather than after.

Below 1, the report **refuses to quote a wait at all**. `stable: false`, and the
wait fields are null. At ρ ≥ 1 the queue has no steady state: the backlog grows
without bound, and saying "the wait is 40 minutes" there would be describing a
transient on the way to infinity. The honest statement is that this cap cannot
keep up, and the curve then shows which one can.

---

## Traffic the cap does not govern

A cap is enforced by the **worker**, at pickup. The worker only ever sees
top-level runs.

A sub-workflow call does not go through it. It executes inside the caller's
engine loop, holding the **caller's** slot, and never asks for one of the
callee's — so a called run does not queue, does not wait, and is not subject to
the number this report is about. A workflow that is mostly invoked as a
subroutine therefore has a cap that governs almost nothing, and no amount of
correct queueing theory about it would be the useful thing to say.

Counting those runs was wrong in **both directions at once**:

| | |
|---|---|
| They inflated the **arrival rate** | The model predicted a wait for traffic that never entered the queue. |
| They filled the **observed wait sample with zeros** | A called run's `started_at` is effectively its `created_at`. |

And the two errors met in the calibration block, which compares exactly those
two numbers — so a mostly-called workflow could report `agrees` on the strength
of traffic neither number described. That is the worst possible failure for a
report whose whole argument is *"this model has been checked"*.

So called runs are excluded from every measured figure, and `governance` carries
the split:

```json
"governance": {
  "governed": 336,
  "called": 3000,
  "share": 0.101,
  "callers": [{ "workflowId": "…", "name": "Order webhook" }]
}
```

`callers` is read from the runs that actually happened rather than from the
[call graph](./ARCHITECTURE.md#cross-workflow-dependency-analysis), so a caller rewired
last week stops appearing once its runs age out of the window.

A workflow with plenty of traffic but too little **governed** traffic reports
`not-governed`, not `not-enough-runs`. Those two sentences send somebody to do
entirely different things, and conflating them tells them to wait for history
that is already arriving.

> The same fact is why the [exposure report](./EXPOSURE.md) attributes a called
> run's consequence to its caller: a run that exists because somebody else asked
> for it belongs to them in both reports.

---

## What it refuses to answer

- **Fewer than 30 runs in the window.** An arrival rate measured from a handful
  of runs is a rumour, not a rate.
- **A workflow whose traffic is mostly sub-workflow calls.** Not a shortage of
  history — a shortage of history this cap has any say over. See above.
- **A workflow with no cap.** It is not queueing. There is a global worker limit
  above it, but that is not this workflow's number and attributing somebody
  else's contention to this graph would be wrong.
- **No run that recorded both a start and a finish.** No service time, no model.

A run that has arrived but not started counts as an **arrival and not as a
wait**. Its wait is censored — still accruing — and recording a lower bound as a
measurement would be wrong in exactly the direction that hides a saturated
queue. Dropping it from arrivals would be wrong in the same direction.

---

## What it does not do

- **It does not model priority lanes.** [Priority](./ARCHITECTURE.md#priority-lanes)
  and [fair share](./ARCHITECTURE.md#fairness-between-workflows) reorder the
  queue; Allen–Cunneen assumes FCFS. The mean wait across all runs is unaffected
  by reordering (that is Little's Law), but the wait *for a given lane* is not,
  and this report does not split by lane.
- **The p95 is an approximation, and says so.** M/M/c has an exact wait tail;
  G/G/c does not. What the model does is keep the exponential shape and stretch
  it to the corrected mean. It is the weakest link, which is why the calibration
  block exists and why `observedWaitP95Ms` is reported beside it.
- **It does not watch.** This is a question you ask, not an alert that fires.
  The monitors that fire on their own are [SLA](./INSIGHTS.md) and
  [drift](./DRIFT.md).
- **It assumes the past predicts the future.** A cap sized on last week's
  traffic is sized for last week's traffic. `headroom` is the number that says
  how much slack that assumption has.
- **The peak is a maximum, not a forecast.** It reports the worst window that
  *has happened*, which is a fact. Whether a worse one is coming is a question
  about the business, and a seasonality model fitted to one week of history
  would be an opinion dressed as one.
