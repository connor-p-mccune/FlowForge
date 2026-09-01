# Exposure: which workflow should I look at first?

Every analysis in FlowForge answers a question about **one** workflow.

| | Answers |
|---|---|
| [Linter](./ARCHITECTURE.md#static-analysis-the-linter) | Is this node's config valid? |
| [Types](./TYPES.md) | Does this value have the shape the next node wants? |
| [Effects](./EFFECTS.md) | What can this workflow do, and what has to be true first? |
| [Paths](./PATHS.md) | Is there an input that takes this branch? |
| [Guarantees](./GUARANTEES.md) | Does this declared property hold over every execution? |
| [Mutation](./MUTATION.md) | Would this workflow's checks notice if it were wrong? |
| [Capacity](./CAPACITY.md) | Is this workflow's concurrency cap the right number? |

Each is complete, and each assumes the hardest part is already done — that
somebody knew which workflow to open.

Nobody has one workflow. A workspace that has been running for a year has forty,
most of them built by somebody who has left, and the honest state of a review is
*"where do I even start"*. That is the question an owner actually asks, and until
this report nothing here answered it.

The surfaces are `flowforge exposure [ws-id] [--unchecked]`,
`GET /api/v1/workspaces/:id/exposure`, and `GET /api/workspaces/:id/exposure`
for the app.

---

## What it reports

```console
$ flowforge exposure
Where a review should start
Outward actions per day over the last 30 days

PER DAY    WORKFLOW                    RUNS/DAY  REACHES              CHECKED BY
412        Order webhook                    412  1 effect             nothing
0 – 96     Refund approval                   24  4 effects · 2 off-canvas  2 scenarios
18         Nightly reconcile                  1  18 effects           1 guarantee, drift
0          Send alert (via Orders, Refunds)   —  1 effect             nothing

  526 outward actions a day at most, 430 of them guaranteed · 437 runs a day
  2 of those effects happen inside a workflow somebody called — no single canvas shows them.

78% of what this workspace does to the outside world sits on 1 workflow(s) nothing is checking:
  Order webhook — 412/day · 6f0c…
```

---

## The unit

The answer has to be a quantity, not a vibe, and there is one available made
entirely of things already measured:

```
outward actions per day  =  effects a run performs  ×  runs per day
```

The [transitive effect report](./EFFECTS.md#across-the-sub-workflow-boundary)
supplies the left side — every HTTP call, email, Slack post and model call a run
can reach, **including the ones several sub-workflow calls away** that nobody
reading the canvas would see. The `executions` table supplies the right.

Both halves are load-bearing and neither is sufficient on its own. A workflow
that charges cards and runs twice a year is not the fire. Neither is one that
runs ten thousand times a day and only writes to a log.

---

## Three decisions

### It reports an interval, not a number

Most effects are gated. `Charge card` happens when `Approve = true`, and nothing
here evaluates that — [deliberately](./EFFECTS.md#what-it-does-not-do), because
how often a branch is taken is a question about inputs, not graphs.

A single number would therefore have to guess. Instead there are two:

| | |
|---|---|
| **floor** | Effects nothing gates, times the rate. What this workflow *does*, every run, guaranteed by its shape. |
| **ceiling** | Every effect, times the rate. What it does if every gate goes the effectful way. |

**Workflows are ranked by the ceiling**, and that is the subject of the report
rather than a preference. This exists to find workflows nobody has checked, and
*a gate nobody has tested is not a gate, it is a hope*. The floor sits beside it
because a large floor means the worst case is also the ordinary one — which is
why two workflows with the same ceiling are separated by it.

### The rate counts direct runs only

A sub-workflow call creates its own `executions` row, so a shared utility's raw
run count includes every call made on somebody else's behalf.

Counting those would be wrong twice over. It would count the same charge in two
places — once in the caller's row, where the transitive walk already put it, and
again in the callee's — and it would rank the utility **above** the workflow that
decides to invoke it, which inverts the answer. The utility is a subroutine. The
thing to review is the caller that reaches it.

So the rate is `parent_execution_id IS NULL`: runs somebody or something
*started*. A workflow that is only ever called therefore scores zero, which would
be a lie by omission if left at that — so those rows are marked `attributed` and
name the callers their consequence went to:

```
0          Send alert (via Orders, Refunds)
```

They are also left out of the review queue, because acting on them means acting
on their callers, which are in the list already.

### Assurance is counted, never scored

The obvious next move is to subtract test coverage and publish one number. This
does not, and the reason is that it cannot honestly.

Four scenarios do not make a workflow four units safer — they might all assert
the same trivial thing. A single pinned [guarantee](./GUARANTEES.md) can be worth
more than a dozen of them, or nothing, depending on what it says, and nothing
here reads what it says. What *can* be counted is whether anybody has set
anything up at all, and the step from zero to one is the only one on that scale
this report can defend.

So the four kinds — scenarios, guarantees, run assertions, drift monitoring —
are reported unweighted and unsummed beside the exposure, and the queue is the
plainest possible filter over them: **consequence, and nothing watching it.**
That is a fact about the workspace rather than a judgement about a test suite.

---

## The rate's denominator

The window is 30 days, but the divisor is the **observed span**, floored at one
day:

> A workflow deployed four days ago that has run 400 times runs 100 times a day,
> not 13.

This is the same correction the [capacity report](./CAPACITY.md) makes for the
same reason — a rate divided by a window the workflow did not exist for is not a
rate. The span used is reported per row as `observedDays`, so the arithmetic is
checkable rather than trusted.

---

## As a CI gate

`--unchecked` exits non-zero when any workflow has consequence and no checks at
all.

Unlike [`effects --ungated`](./EFFECTS.md#as-a-ci-gate), this one is **not
ambiguous**, which is why it is offered without the same caveat. A workflow
reaching a payments API on every run may well be exactly what somebody meant. A
workflow with consequence and *no scenarios, no guarantees, no assertions and no
drift monitoring* is not a design decision anybody defends out loud.

---

## What it does not do

- **It does not know what an effect *is*.** An HTTP POST might charge a card or
  fetch a price. Weighting the kinds — "payments count triple" — would be a guess
  dressed as an analysis, so every effect counts one.
- **It does not count multiplicity.** A `for-each` node calling a sub-workflow
  over 200 items is one *action* here, not 200. The unit is distinct outward
  actions — *"this workflow charges a card"* is one fact whether it charges once
  or per line item. Neither bound is a bound on HTTP requests, and neither is
  claimed to be.
- **It does not rank by failures.** Failures already draw attention; a workflow
  that has never failed and that nothing checks is precisely the one nobody is
  looking at, and ranking on failure rate would bury it.
- **It does not judge a check.** See above — it counts them.
- **It reads deployed graphs, not the canvas.** The answer depends on graphs
  *other* workflows hold, so mixing an unsaved graph into it would describe a
  system that does not exist. This is the same reason the transitive effect
  endpoint is a `GET`.
