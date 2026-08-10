# Progressive delivery

Send a slice of a workflow's runs to your new definition, compare the two
statistically, and promote or roll back.

```
Canary release · 10% of runs

  Regression detected
  canary failure rate 50.0% vs 2.0% (p = 0.0001)

  Canary  your canvas          40 runs   50.0% failed (≤ 65.3%)   1.2s median
  Stable  deployed version    400 runs    2.0% failed (≤  3.9%)   1.1s median

  → rolled back automatically. Your canvas is unchanged.
```

---

## The idea

FlowForge has the no-gradual-anything problem in an unusually sharp form: a
deployed workflow executes its **live graph**, so editing the canvas of
something in production changes production immediately and completely.

A canary inverts that for as long as it runs:

| Arm | Executes |
|---|---|
| **stable** | a pinned **version snapshot** — the last known-good deploy |
| **canary** | the **live canvas** — the edits under test |

Three things fall out of that framing, and they are why it was chosen:

**Rollback is instant and destroys nothing.** Stable is already running the
baseline, so rolling back is setting the percentage to zero. No graph is moved,
no canvas is overwritten under someone's cursor, and the edits survive so
whoever wrote them can fix and retry.

**Promotion is an ordinary deploy.** The live canvas is what the canary was
proving, so promoting it snapshots a version and marks the workflow deployed —
exactly what the deploy button has always done.

**Nothing new decides what runs.** The engine already reads one graph per run.
It now reads a *version's* graph when the execution row names one. One column,
one branch.

---

## Running one

Deploy once (that snapshot becomes the baseline), edit the canvas, then open
**🐤 Canary** on the toolbar and pick a traffic share.

| Action | Effect |
|---|---|
| **Adjust** | Change the share — 5% → 25% → 50% — without losing the sample so far. |
| **Promote** | The canvas becomes the deployed definition; the canary clears. |
| **Roll back** | Traffic to 0%; everything runs the baseline. Your canvas is untouched, and raising the traffic again resumes the same experiment. |
| **End** | The experiment stops and the live canvas serves every run, as it does for a workflow that never had a canary. |

Four verbs rather than two, because "stop the canary" means three genuinely
different things and collapsing them would make the dangerous one the default.

```bash
curl -X POST  .../api/workflows/$ID/canary -d '{"percent": 10}'
curl -X PUT   .../api/workflows/$ID/canary -d '{"percent": 50}'
curl -X POST  .../api/workflows/$ID/canary/promote
curl -X POST  .../api/workflows/$ID/canary/rollback
curl -X DELETE .../api/workflows/$ID/canary
curl          .../api/workflows/$ID/canary        # status + comparison
```

---

## The verdict

Threshold rules do not work on a canary, because a canary is a small sample. "3
failures out of 40 versus 20 out of 380" is a 42% higher failure rate and it is
three coin flips. So both directions wait for evidence — auto-promoting on a
rate that merely *looks* fine is the same mistake pointed the other way.

| Test | Question | Why this one |
|---|---|---|
| **Two-proportion z** (one-sided) | Is the canary failing more? | Directional: a canary that fails *less* is good news, not a finding. |
| **Mann-Whitney U** (tie-corrected) | Is it slower? | Run durations are right-skewed with a long retry tail — exactly the shape that makes a t-test claim significance from one bad afternoon. Ranks care only about order. |
| **Wilson interval** | How uncertain is a rate? | "0 failures in 12 runs" is not "certainly 0%". Wilson never collapses to zero width and never leaves [0, 1]. |

The rules:

- **Below `minRuns` canary runs** (default 20), or fewer than 10 baseline runs
  → `wait`. Not "healthy" — there is nothing to say yet, and saying it green
  would be the worst possible time to be confidently wrong.
- **Every canary run failed** (≥ 3 runs) → immediate rollback. No test is needed
  to read that, and waiting for the twentieth run costs twenty broken runs.
- **Failure rate significantly worse** (p < 0.05) → rollback.
- **Significantly slower** (p < 0.05) → rollback.
- **Otherwise** → promote.

Cancelled runs count for neither arm, matching the [SLO
budget](./ARCHITECTURE.md#slo-error-budgets-and-burn-rates) and the status page:
someone stopping a run is an intervention, not a service failure, and charging
it to whichever arm was running would penalise exactly the response you want
during an incident.

Durations are rounded to the millisecond before ranking. `julianday()`'s
subtraction leaves sub-microsecond dust that varies with the absolute date, and
the two arms necessarily occupy different time ranges — unrounded, a rank test
could read that dust as a systematic ordering.

---

## Automation

`auto` (on by default) lets a background sweep act on the verdict, in the same
family as the heartbeat and maintenance-window monitors and for the same reason:
"enough runs have accumulated to judge this" is the passage of time, not an
event, so there is nothing to hook.

Every action is idempotent and terminal — the next pass no longer sees a running
canary — and the sweep is best-effort per workflow, so one bad analysis cannot
stop it for everyone else. Promotions and rollbacks emit
`workflow.canary_promoted` / `workflow.canary_rolled_back` activity events
(which outbound webhooks relay) plus an owner notification.

Turn `auto` off and the panel reports; a person decides.

---

## Boundaries

**Dry runs never enter the experiment.** Test mode exists to try the edits, so
it always executes the canvas. They carry no channel, which is also why the
analysis can select on the column without restating the rule.

**A resumed run inherits its source's assignment.** Resume adopts the source
run's recorded step outputs, so it must re-execute the same definition —
adopting outputs from one graph into another would be incoherent in a way no
error message could explain.

**A stale baseline degrades to the live graph.** If the pinned version was
deleted, the safe reading is "no experiment", not "fail the run".

**Starting and promoting both pass the [policy gate](./POLICIES.md).** Sending
99% of traffic to the live canvas is a deploy, so a canary must not be a way
around a control that blocks one.

**Assignment is random per run**, not hashed on a key. A workflow's runs have no
stable identity to hash — a schedule tick is not a user — and the comparison
wants independent samples, which is what a fair coin gives.
