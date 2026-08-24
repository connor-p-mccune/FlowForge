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

## What it refuses to answer

- **Fewer than 30 runs in the window.** An arrival rate measured from a handful
  of runs is a rumour, not a rate.
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
