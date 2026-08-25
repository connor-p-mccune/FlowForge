# Assertions: things that must never happen

FlowForge already proves properties of the **graph**.
[Guarantees](./GUARANTEES.md) answer *"can this ever charge a card without the
approval having run?"* over every execution the graph admits — statically, by
dominance, with a counterexample path when it fails. That is the strongest kind
of check there is.

It can only see what the graph's *shape* decides. And the properties that
actually break production are not about shape:

> - a run must never **complete** with the charge step returning 4xx
> - a refund must never be issued for more than the order total
> - a run must never take longer than the SLA it was sold under

None of those is a fact about the graph. Every one is a fact about **runs** —
and there are thousands of runs, already recorded, that would answer them.

The surfaces are `flowforge assertions <id>`,
`GET /api/v1/workflows/:id/assertions`, and session CRUD for authoring.

---

## An assertion is a saved query

The predicate describes **the shape of a run that must not exist**, in the same
[FXL the query engine takes](./QUERY.md):

```
status == "completed" and steps.charge.output.status >= 400
```

The polarity is the opposite of how an invariant is usually written, and that is
deliberate. Two reasons:

1. **FXL has no implication operator.** The invariant form — *completed implies
   charge succeeded* — becomes
   `not (status == "completed") or steps.charge.output.status < 400`, which
   nobody reads correctly at 3am.
2. **It makes the development loop real.** Write the query, run it against
   history with `flowforge query` until it finds exactly the runs you mean, then
   pin it. An assertion is a query you never want to match again, and it is
   *literally the same string* — the scope is identical, so a predicate cannot
   mean one thing while you develop it and another once it is live.

---

## Checked as runs settle, not on a sweep

Evaluation happens on the engine's terminal hook, against the run that just
finished.

That is not an optimisation. It removes a class of bug. A sweep needs a
**watermark** to know which runs it has already judged, and a watermark is a
thing that can be wrong in both directions:

- skip one — a violation is missed **forever**, because a sweep never looks back
- replay one — it alerts **twice**, for a single event

Checking the run in front of you is exact by construction: every run is judged
once, and the counters are the whole state. There is nothing to reconcile.

The cost lands on the completion path of every real run in the system, so it is
bounded — an indexed lookup that returns nothing for workflows with no
assertions, a cap of twenty per workflow, and a `try` around everything.

> **An assertion must never fail a run.**

A monitor that can break the thing it monitors is worse than no monitor. There
is a test that runs a workflow with a deliberately broken predicate and asserts
the run still completes.

Dry runs are excluded: they simulated the side-effecting steps an assertion
would be judging, so asserting about them would be judging a rehearsal.

---

## Broken is not holding

This is the part the design is really about.

An assertion whose predicate throws on every run — a misspelled field, a
function given the wrong shape, a node that was renamed — reports **zero
violations**. Report that as green and you have built exactly the failure the
[policy engine](./POLICIES.md) exists to avoid: a rule reading a field that does
not exist, pronouncing everything compliant forever.

So evaluations that **complete** are counted separately from ones that **throw**:

| `state` | Means |
|---|---|
| `holding` | Evaluated, did not match. |
| `violated` | Matched. `lastViolationExecutionId` is the counterexample. |
| `broken` | Has thrown and **never once evaluated successfully**. Claiming nothing. |
| `unchecked` | No run has reached it yet. |

`broken` never folds into `holding`, and `flowforge assertions` exits non-zero
on it. A build gated on violations alone would be passing on a check that has
never worked.

Two more places the same principle applies:

- **A predicate that does not parse is refused, not stored** — on create *and*
  on edit. A stored one that cannot be compiled is silently green forever.
- **Editing the predicate resets the counters.** They describe how a *different*
  predicate behaved, and carrying them over would let a rewritten assertion
  inherit a clean record it never earned. Renaming keeps them, because a rename
  changes nothing about what is being checked.

---

## Alerting

Edge-triggered on the transition into violation, exactly like
[drift](./DRIFT.md): a storm of matching runs is **one** alert, not one per run,
and `violation_count` records how many there were.

Every open gets a close. The alert clears when a run evaluates without matching,
so a downstream channel is never left holding an incident nobody resolved.

```console
$ flowforge assertions 6f0c…
What must never happen
STATE     ASSERTION            RUNS  VIOLATIONS
holding   no 5xx from charge   412   0
VIOLATED  refund ≤ order       412   3
broken    items non-empty      0     0

Counterexamples
  refund ≤ order
    predicate steps.refund.output.amount > trigger.order.total
    last matched e57a1234 at 2026-08-22 11:30:00

Never evaluated
  items non-empty — first: expected an array
  These have thrown on every run and never once completed, so they are reporting
  zero violations without checking anything.
```

---

## What it does not do

- **It does not check history.** An assertion pinned today judges runs from
  today. Whether it *would* have held last week is a question for
  `flowforge query`, which takes the same predicate — that is the point of them
  being the same string.
- **It cannot see what the graph forbids.** *Can this ever happen?* is
  [a guarantee](./GUARANTEES.md), proved over every execution the graph admits.
  This says *did it happen*, which is a weaker claim about a stronger set of
  properties. The two are complements: verify what you can prove, watch what you
  cannot.
- **It does not stop the run.** A violation is recorded and alerted after the
  fact. Blocking mid-run on a user-supplied predicate would put an arbitrary
  expression on the critical path of every step, and the control that *does*
  stop things before they happen is a [policy](./POLICIES.md).
- **It does not aggregate across runs.** "More than 5% of runs failed" is not
  expressible: each evaluation sees one run. That is
  [the SLA monitor's](./INSIGHTS.md) question, and it already answers it.
