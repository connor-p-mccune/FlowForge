# Scheduled load: everything fires at midnight

Every timing analysis in FlowForge is about **one** thing.

| | Models |
|---|---|
| [`scheduleSim`](./SCHEDULING.md) | The parallelism cap inside a single run. |
| [`capacity`](./CAPACITY.md) | The queue in front of a single workflow. |
| [`criticalPath`](./SCHEDULING.md) | The longest chain in a single execution. |
| [`contention`](./SCHEDULING.md) | Where one finished run's time went. |

Nothing modelled the machine all of them land on.

And the load on that machine is **not random**, because cron is written by
people and people write round numbers. Nobody schedules a report for 03:47.
They pick midnight, or the top of the hour, and every workflow added over three
years picked it independently — so a workspace's scheduled load arrives in a
spike nobody designed, at a time nobody is awake to see, and the only symptom is
that the 00:00 runs are slower than the 00:05 ones.

That is a **max-overlap problem**, which is a sweep line, and every input is
already recorded: the cron expressions, the time zones the scheduler already
honours, and how long each workflow's runs actually take.

The surfaces are `flowforge schedule --workspace [ws-id] [--capacity N]`,
`GET /api/v1/workspaces/:id/schedule`, and `GET /api/workspaces/:id/schedule`.

---

## What it reports

```console
$ flowforge schedule --workspace --capacity 4
Scheduled load  6 workflow(s) · 84 runs over 7 days

At most 5 runs at once, Wed 2026-09-03 00:00 UTC
  Against a capacity of 4: over
WORKFLOW            CRON        ZONE          HOLDS A SLOT
Nightly reconcile   0 0 * * *   UTC           40.0m
Digest              0 0 * * *   Asia/Tokyo    20.0m
Cleanup             0 0 * * *   UTC            5.0m
Archive             0 0 * * *   UTC           12.0m
Index rebuild       0 0 * * *   UTC            8.0m

  86% of scheduled runs start on the hour, 42 of them at midnight.
  Moving Nightly reconcile 20 minutes later would drop the peak from 5 to 3.

  2 scheduled workflow(s) have never run, so this peak is a floor:
  Weekly report, Quarterly close
```

---

## Four decisions

### Colliding is not starting together

An occurrence occupies `[start, start + mean duration)`, so the 40-minute job
that begins at midnight is still holding a worker when the 00:30 job lands.
Counting *starts* would miss that entirely, and it is the commonest shape of the
problem — the long job is exactly the one somebody scheduled early to get it out
of the way.

Ends sort **before** starts at a tie, because a run that finishes at exactly
midnight has released its worker before the midnight run needs one. Two
back-to-back ten-minute jobs are one at a time, not two.

The mean duration rather than the p95, because the question is what this
occupies on an ordinary night. A p95 peak would describe the worst night of the
quarter, which is a different and much less actionable report.

### Time zones are not decoration

The scheduler evaluates each workflow's cron in its own zone
(`scheduler.scheduleTimeZone`), so **two workflows both set to "midnight" in
different zones do not collide**, and two set to different hours may.

Expanding everything in UTC would invent collisions and hide real ones, so each
expression goes through the same `cronExpression.nextRuns` the schedule preview
uses, with the same zone the scheduler would use. There is a test for exactly
that graph: Tokyo midnight and London midnight, peak of one.

### A missing duration makes the peak a floor

A scheduled workflow that has never run has no measured duration, so it is
**excluded** — named in `unmeasured`, counted in `summary.unmeasured`, and
`summary.lowerBound` set.

Substituting a nominal duration would produce a peak built partly out of a
number nobody measured, which is precisely the kind of figure that gets quoted
in a capacity conversation and never questioned again.

### No capacity, no verdict

`summary.overCapacity` is `null` until the caller passes `?capacity=N`.

The worker concurrency (`EXEC_CONCURRENCY`) is a deployment fact this process
may not share — the API server and the workers are separately configurable, and
in most deployments there is more than one worker. Reading this process's own
environment and calling it "the capacity" would be a guess dressed as a
measurement, and a verdict built on it is worse than no verdict.

---

## The suggestion

`suggestion` is the single move that flattens the peak most: one workflow,
shifted by a whole number of minutes, re-measured.

Two constraints, both about the answer being usable rather than optimal.

**Minutes inside the same hour.** A daily `0 0 * * *` job moved to `17 0 * * *`
still runs nightly; moved to `0 1 * * *` it is a different schedule than its
author asked for. The report does not get to change what somebody meant.

**One workflow, not six.** A report that suggested rescheduling five things at
once is one nobody acts on. Only workflows actually present at the peak are
considered, because only they can reduce it.

It is a suggestion and never an action: nothing here edits a cron.

---

## `clock`, and why it is in the payload

```json
"clock": { "occurrences": 84, "onTheHour": 72, "atMidnight": 42, "share": 0.857 }
```

This is the finding, not a curiosity. A peak that is an accident of everyone
independently picking midnight has a cheap fix — the suggestion above. A peak on
a workspace whose load is genuinely that high does not, and the two want
completely different responses. `share` is what tells them apart.

---

## What it does not do

- **It does not model the queue.** This is arrival overlap, not waiting time.
  What happens *when* the peak exceeds capacity — how long runs wait, whether
  the backlog drains — is [capacity's](./CAPACITY.md) question, and that one is
  per-workflow.
- **It does not count webhook or manual traffic.** Only schedules, because only
  schedules are predictable. Folding in an arrival rate measured from history
  would mix a forecast with a certainty and label the result as one thing.
- **It does not know about DST inside the horizon.** The expansion honours the
  zone, so a spring-forward is handled correctly by `nextRuns` — but the report
  does not *say* that a peak moved because the clocks did.
  [`flowforge schedule <id>`](../cli/README.md) does that for one workflow.
- **It caps the expansion.** A `* * * * *` schedule is 10,080 fires a week,
  which is a legitimate thing to have and not something to expand one row at a
  time. Past the cap the horizon is effectively shorter, which understates
  nothing about the peak — a minutely schedule collides with everything anyway.
