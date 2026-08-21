# Scheduling: a slot is a resource

The execution engine runs independent branches in parallel, bounded by
`EXEC_MAX_PARALLEL`. That cap is four lines of code and it had been treated,
everywhere else in the system, as though it did not exist.

Two consequences, and this document is about both:

1. **The engine chose arbitrarily.** When more nodes were ready than there were
   free slots, `scheduleRound()` launched whichever came first in the
   topological order — which is declaration order, which is the order somebody
   dropped nodes on a canvas.
2. **Every analysis assumed infinite capacity.** `computeCriticalPath` answers
   "which chain of steps set this run's duration", `computeForecast` runs the
   same longest-path search forward, and the Gantt timeline draws bars inside
   the run's window. All three describe a machine with a slot always free.

The user-facing surfaces are the **Concurrency** block in the 📊 Insights panel,
the queueing overlay on the run timeline, `flowforge forecast --cap`,
`flowforge contention`, and `GET /api/v1/executions/:id/schedule`. This document
is the how-and-why.

- [Why the launch order matters](#why-the-launch-order-matters)
- [The rule: upward rank](#the-rule-upward-rank)
- [Why it is safe](#why-it-is-safe)
- [Weights, and the node with no history](#weights-and-the-node-with-no-history)
- [Simulating the scheduler](#simulating-the-scheduler)
- [Naming a dependency that has no edge](#naming-a-dependency-that-has-no-edge)
- [Measuring a finished run](#measuring-a-finished-run)
- [What is reported, not applied](#what-is-reported-not-applied)
- [Surfaces](#surfaces)

---

## Why the launch order matters

A trigger fans out to five 100 ms nodes and one 600 ms node. `EXEC_MAX_PARALLEL`
is 2.

If the slow node starts first, the five quick ones fill the gaps behind it and
the run finishes in **600 ms** — its own duration, the floor. If it starts last,
the quick ones go two at a time, and it begins only once four of them have
finished: **800 ms**.

Same nodes, same work, same dependencies. A third more wall time, on every run,
because of where somebody happened to drag a node.

This is invisible until the ready set outgrows the free capacity, which is
exactly why it survived: a graph narrower than the cap never faces the choice,
so the behaviour is correct on every small workflow and quietly wasteful on
every large one.

---

## The rule: upward rank

Order the ready set by each node's **upward rank** — its *b-level*, the longest
weighted path from it to a sink:

```
rank(n) = w(n) + max over successors s of rank(s)
```

Read it as *how much work is still downstream of me*. Launch the node the end of
the run is waiting for; anything shorter can fill in behind it.

This is HLFET (Adam, Chandy & Dickson, 1974) — the priority rule HEFT
(Topcuoglu, Hariri & Wu, 2002) builds on. It is computed once per run by walking
the topological order backwards, so every successor is resolved before the node
that needs it: one pass, no recursion, no memo table
(`services/nodePriority.js`).

Ties break on topological index. That matters more than it looks: it makes the
order a **total** one, so a workflow schedules identically on every run and a
replay reproduces the original's interleaving. Chaos seeding and the rollback
sequence both key on what actually happened, and a scheduler that reordered
itself run to run would make both non-reproducible.

### A note on which number is being minimised

There is a natural-looking metric this rule makes *worse*, and the test suite
pins it deliberately. In the example above, longest-first leaves five nodes
queueing behind the long pole — 1000 ms of total waiting — while
declaration order accumulates only 600 ms. The good schedule has more waiting
in it and finishes sooner.

Both are correct, for different objectives: shortest-processing-time-first
minimises **mean flow time** (total waiting), longest-first minimises
**makespan** (when the last node finishes). Nobody is waiting on the sum; they
are waiting on the end.

---

## Why it is safe

Three properties, and they are what let this ship as the default rather than as
an opt-in experiment.

**It is semantically inert.** It changes the order ready nodes are launched in.
It does not change which nodes are ready, which edges are active, what any node
receives, or what any of them produce. Dominance, path feasibility, type
inference, lineage and the policy engine all describe the same graph afterwards.
A test asserts identical step statuses and outputs under both orderings.

**Any order is already within a bound.** Graham (1969) proves that *any* list
schedule — any order at all, provided no slot is left idle while a ready node
exists — finishes within `(2 − 1/m)` of the optimum. The engine has always been
a list scheduler; it just had a bad list. So ordering better can only help, and
cannot be pathological even if every timing estimate is wrong. The bound is
asserted as a property over 200 generated DAGs, against both a sensible and an
adversarial priority rule, on a fixed seed.

**List scheduling has anomalies, and the claim is scoped to match.** Graham's
own paper gives graphs where a *better* priority order produces a *worse*
makespan. So the tested claim is not "never worse on any graph". It is that the
rule wins across a population of generated DAGs, and that both orders stay
inside the bound — which is what is actually true.

`EXEC_SCHEDULER=topological` restores the previous behaviour exactly. It exists
so the improvement can be measured against the thing it replaced, and so the
escape hatch is a config change rather than a deploy.

---

## Weights, and the node with no history

The weights are the workflow's own recorded step times, from
`services/stepTimings.js`: succeeded steps of recent completed **real** runs, at
the **p50**.

Every clause is doing work. A failed step's wall time includes retry backoff and
stops at whatever broke, so it measures "how long until it broke". A dry run
simulates its side-effecting nodes, so an HTTP node that takes 900 ms in
production takes 0 ms in test mode — letting those into the sample would make
every workflow look fast in exactly the proportion somebody had been testing it.
And step durations are right-skewed, so a mean is dragged around by the retry
tail; the p50 is not.

The interesting case is a node with **no** history. Zero is the obvious weight
and it is the wrong one: it sorts the node **last**, and a node with no history
is disproportionately likely to be the one somebody just added — the newest,
least understood, most plausibly slow thing in the graph. So an unmeasured node
takes the **median of the measured ones**: a prior that says "assume typical",
which leaves the node's position in the graph as the dominant signal rather than
letting a missing measurement decide the order.

When nothing at all has history, every weight is equal, the median is 1, and the
rank degenerates to the node's **height in the DAG** — the deepest chain still
launches first, which is the right answer with no information.

Two cost controls: a graph that cannot fill the cap can never face the choice
and skips the timing query entirely, and the result is memoised briefly per
workflow. Staleness is harmless by construction — the weights only order a ready
set, and Graham's bound holds for any order — so a plan built from timings a
minute old is at worst slightly less good, never wrong.

---

## Simulating the scheduler

`services/scheduleSim.js` replays the engine's scheduling rule as a
discrete-event simulation over `(graph, durations, cap, priority)`. A node
becomes ready when all its predecessors have finished; ready nodes launch in
priority order while slots remain; time advances to the next completion.

It is pure — plain functions, no database, no engine — which is what lets one
routine serve three callers that would otherwise each approximate it:

- the **forecast**, with expected times over the current graph;
- a finished run's **counterfactuals** ("what would this have taken at a cap of
  eight?"), with observed times over the executed subgraph;
- the **tests** behind the launch order, which need to compare two orderings
  over the same graph without running anything.

From it fall the capacity questions that had no answer before:

| | |
|---|---|
| **Makespan under the cap** | What will actually happen, as opposed to the critical path. |
| **Contention** | Makespan ÷ critical path. 1.0 means the cap costs nothing. |
| **Average parallelism** | Total work ÷ critical path — the ceiling on *any* speedup. 1.2 means the workflow is mostly a chain and no amount of capacity will help it, which is the more useful answer when it is true. |
| **The knee** | The smallest cap within 5% of the unbounded floor: the point past which more slots buy nothing. |

---

## Naming a dependency that has no edge

The output worth the most is the one the graph cannot produce.

Under a cap, the thing that delayed a node is frequently **not one of its
predecessors**. It is a sibling on an unrelated branch that was holding the
slot. A dependency graph has no edge for "these two competed", so no analysis
over the DAG — not the critical path, not lineage, not the type checker — can
name it.

Both the simulation and the post-mortem track it explicitly. Each node's wait is
labelled:

- **`data`** — a predecessor had not finished yet. The edge exists; the graph
  explains it.
- **`slot`** — every predecessor had finished, and the node waited for capacity.
  The blocker is named, and it is whichever node released the slot this one took.

Walking those labels back from the last node to finish gives the
**resource-critical chain** — the real answer to "why did this run take as long
as it did", where the classical critical path only ever gave half of it.

---

## Measuring a finished run

For a run that already happened, none of this needs simulating. The step rows
contain it.

A node's **ready time** is the last of its predecessors to finish. Its **start
time** is recorded. The difference is queueing, and it is a fact about the run
rather than a model of it (`services/runSchedule.js`). The blocker is inferred
from the timeline: among the steps that occupied a slot and finished at or before
this node started, the latest one — because "the most recent completion before I
started" is what freed the slot.

Two distinctions are load-bearing, and both differ from `criticalPath.js`:

- A **`reused`** or **`cached`** step settles synchronously inside the scheduling
  round and never enters the in-flight set. It took no capacity, so counting it
  as work would inflate utilisation and invent contention that did not happen.
  It still satisfies a downstream node's readiness, because a downstream node
  waits for its predecessor to settle *however* it settles.
- A **`caught`** step *did* occupy a slot. The node ran and failed; only
  afterwards did its on-error policy decide what that meant.

And utilisation is reported as `null` rather than a number when the cap is
unknown. A ratio against an assumed denominator looks precise and is not.

---

## What is reported, not applied

`EXEC_MAX_PARALLEL` is process-wide and shared by every concurrent run. The knee
is therefore a number for an operator to act on, not something a single
workflow's forecast may set for the whole instance — one wide workflow wanting
twelve slots is not a reason to give every run twelve slots.

`?cap=N` on the forecast and `--cap` on the CLI exist for the same reason from
the other side: capacity planning used to be a deploy — change the variable,
restart, watch. It is now a query that changes nothing.

---

## Surfaces

| Where | What |
|---|---|
| 📊 **Insights panel** | A **Concurrency** section beside the forecast: makespan under the cap, contention, time spent queueing, the ceiling on speedup, the knee, and a curve of duration against slots with the current cap marked. Silent when the cap costs nothing — a section reading "1.0×" on every chain-shaped workflow is one people learn to skip. |
| **Run timeline** | Each row grows a hollow, hatched **queued** segment immediately before its bar, covering exactly the interval between when the node could have started and when it did. The tooltip names the node that was holding the slot. |
| `flowforge forecast <id> [--cap N]` | Both estimates, the knee, and the worst wait. |
| `flowforge contention <exec-id> [--max <ratio>]` | Where a run's time went, every node that waited on capacity worst-first, and what other caps would have produced. `--max` exits non-zero over a budget, so a build can distinguish "the work got slower" from "the box was busy". |
| `GET /api/v1/workflows/:id/forecast` | The `concurrency` block, and `?cap`. |
| `GET /api/v1/executions/:id/schedule` | The measured analysis, `read` scope. |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `EXEC_MAX_PARALLEL` | 4 | Concurrent nodes per run. Parsed in exactly one place (`scheduleSim.configuredCap`) so the scheduler and every analysis that models it cannot disagree about what it is. |
| `EXEC_SCHEDULER` | `critical-path` | `topological` restores declaration order exactly. |
| `STEP_TIMING_CACHE_MS` | 30000 | How long per-workflow step timings are memoised for the launch plan. |
