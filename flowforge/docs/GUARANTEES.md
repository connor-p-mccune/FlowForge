# Workflow guarantees

Invariants verified over **every execution the graph admits** — not over the
one that happened to run.

```
✗ Charge card never runs unless Approve ran first
    Run by hand → Charge card reaches Charge card without Approve
    counterexample: manual → charge

✓ Ship and Refund never both run
    In stock? decides between them
```

---

## The gap this closes

Every static check FlowForge has asks a question about a **place**.

| Check | Question |
|---|---|
| [The linter](./ARCHITECTURE.md#static-analysis-the-linter) | is this node's config complete? |
| [Types](./TYPES.md) | what shape is the value flowing in here? |
| [Lineage](./LINEAGE.md) | where did this value come from, and where does it leave? |
| [Policies](./POLICIES.md) | is this workflow allowed to exist here? |

None of them can answer the question that actually worries somebody the moment
before they press Deploy, because it is not about a place. It is about a
**path**:

> can this ever charge a card without the approval having been granted?

Consider the way that breaks. A workflow runs `webhook → approve → charge`, has
done for a year, and somebody adds a manual trigger so they can test it without
posting a webhook — wired straight at the charge, because that is the part they
were testing. Every node lints. Every type checks. Nothing is unreachable,
nothing is dangling, no policy is violated, and no lineage finding fires. The
graph is *correct* by every check in the product, and the approval is now
optional.

Nobody notices until it matters, because the property that broke was never
written down.

---

## The insight: the engine's semantics make it decidable

A node runs iff at least one of its incoming edges activated, and an edge
activates iff its source succeeded and — for a node that routes — the edge's
handle matches the outcome it settled ([the execution
engine](./ARCHITECTURE.md#the-execution-engine), `activeIncomingFor`). A node
with no incoming edges always runs.

So a node executed **exactly when some chain of active edges reached it from a
source node**, and every such chain is a path in the graph. Which means:

> "B cannot run unless A ran" and "**A dominates B**" are the same statement.

Dominance — every path from the entry to B passes through A — is a solved
problem with a fifty-year-old literature. FlowForge computes it with Cooper,
Harvey & Kennedy's iterative algorithm rather than Lengauer-Tarjan: on graphs a
canvas produces the iterative version converges in two or three passes, and its
entire state is one immediate-dominator array a person can read in a debugger.
Speed was never the constraint; being able to explain the output was.

---

## Three kinds

Each maps to a different classical analysis, and each reads left to right.

### `requires` — B never runs unless A ran first

**A dominates B.** Sound by construction: B executes only if an active chain
reached it, every such chain is a path from the entry, and dominance says every
one of them contains A.

```
requires  charge  approve     "Charge card never runs unless Approve ran first"
```

This is the one people declare first, and the one the suggestions offer.

### `ensures` — if A runs, B runs too

**B post-dominates A**: every path from A to the exit passes through B.

Conditional on the run not failing, and stated rather than hidden. Any node can
fail, so a checker that refused to say anything without that caveat would be
correct, useless, and ignored.

### `exclusive` — A and B never both run

True when some **decision** separates them: a node that dominates both, whose
outcomes leading to A are disjoint from those leading to B. Exactly one outcome
activates per run, so no run reaches both.

Note the dominance requirement. Two nodes on opposite sides of a condition are
*not* exclusive if one of them is also wired straight from the trigger — the
condition no longer decides anything about it.

---

## The outcome partition

One structural idea carries the precision of all three checks.

Most nodes fan out to **every** successor at once: an action succeeds and all
its outgoing edges activate together. A *decision* is a node whose outgoing
edges are split into groups of which **exactly one** activates.

| Node | Outcomes |
|---|---|
| condition | `true` \| `false` |
| approval | `true` \| `false` |
| validate | `valid` \| `invalid` |
| wait-callback | `received` \| `timed-out` |
| switch | each case label \| `default` |
| any node with `onError: branch` | `error` \| everything else |
| everything else | one group — not a decision |

Modelling this as a partition rather than as per-type special cases is what
lets one check cover a condition, a nine-case switch, a validate gate, an
approval, a callback — **and the per-node error branch**, which is the same
two-way shape wearing different clothes and is invisible to any model built
around node types. A node whose failure routes to an error handle is a fork,
and a `requires` that ignores it will certify a graph where a failed HTTP call
jumps the queue straight to the charge.

---

## Precision, and where it comes from

A checker nobody trusts is worse than no checker, so three decisions exist
purely to avoid reporting something that cannot happen — and one exists to
avoid *failing* to report something that can.

**Notes and compensations are stripped**, exactly as the engine strips them
before building its adjacency. A compensating Refund node wired at the Charge
node is not a path to the charge; counting it as one would report a violation
that cannot occur, and the author would then "fix" a correct graph.

**Every source node is fed by a virtual entry.** The engine starts *all* of
them — a graph with two triggers runs both — so dominance is measured from a
single root that reflects it. This is what makes the manual-trigger bypass at
the top of this page a finding rather than an oversight.

**The virtual exit is fed from every unwired outcome**, not only from sinks.
A decision whose `false` branch has nothing wired to it ends the run right
there; the run completes, having simply stopped. Post-dominance computed
without those edges would cheerfully certify "every run that charges also
writes the audit log" about a graph where it demonstrably doesn't. This is the
single most load-bearing decision in the module, and it is the reason `ensures`
is worth having at all.

**A cycle reports `unknown`, not `holds`.** A cyclic graph never runs — the
engine refuses it before any node executes — so every invariant over it is
vacuously true, which is exactly the kind of true that gets somebody hurt.

---

## `unknown` is never a pass

The failure mode this feature exists to prevent has a quieter cousin.

Somebody deletes the approval node. Every guarantee naming it stops failing —
there is nothing left to violate — and a checker that reported those as passing
would go green forever while guarding nothing.

So a declaration naming a node that is no longer in the graph reports
**`unknown`**, and `unknown` blocks the deploy, fails `flowforge verify`, and
sets `ok: false` on the API exactly like a violation does. A guarantee whose
check silently stopped running is worse than no guarantee, because somebody is
relying on it.

---

## Where it is enforced

| Surface | Behaviour |
|---|---|
| 🛡 Guarantees panel | verdicts against the graph **on screen**, with counterexamples |
| 🔎 Issues panel | violations as **errors**, anchored to the node |
| 🚀 Deploy | refused with `422` and the counterexample |
| `flowforge verify <id>` | exits non-zero on a break *or* an uncheckable declaration |
| `GET /api/v1/workflows/:id/guarantees` | `ok` is the CI gate |
| export / import | declarations travel with the definition |

**Deploy, not runs.** A guarantee is checked where a workflow becomes something
the organisation runs, and never against a run in flight — the same rule
[policies](./POLICIES.md) follow, for the same reason: a governance check that
can take production down is worse than the bug it looks for.

**Errors, not warnings**, uniquely among the additive lint passes. A lineage
finding says "this pattern is often a mistake". A violated guarantee says "the
thing you told us must never happen can now happen". The author already decided
it mattered; the linter's job is to believe them.

**Declarations travel with the definition.** They are statements *about* this
graph and reference its node ids, so an export that dropped them would ship the
workflow without the assertions that were the reason it passed review. A
`flowforge lint <id> file.json` in CI vets a candidate against the target
workspace's live declarations — which is what catches a promotion that would
route around a gate production still requires.

---

## Suggestions: from zero to a useful set

Nobody sits down to write path invariants. They sit down to build a workflow,
and the invariant is the thing they were assuming all along without saying it.

So FlowForge reports the invariants that **hold today and look deliberate** — a
gate node (approval, validate, condition, switch, callback) standing in front of
something consequential (an HTTP call, an email, Slack, a sub-workflow, an AI
step), plus the pairs a branch already keeps apart. One click pins them.

Only the **nearest** gate is offered per node. Every gate further up dominates
it too, and a list of six true-but-redundant suggestions is a list nobody reads.

---

## Limits, stated plainly

**Structural, not semantic.** The analysis knows a condition has two outcomes;
it does not know that `amount > 1000` and `amount <= 1000` are complementary, or
that a switch's cases are exhaustive. A counterexample path is therefore a
*graph* path, and a sufficiently clever graph can contain one that no real run
would take. The report shows the path so the reader can judge it, which is the
honest interface for an over-approximation.

**`ensures` assumes the run does not fail.** Any node can fail and end the run,
so "if A runs, B runs" holds for runs that complete. A caught failure (`onError:
continue` or `branch`) is *not* a failure for this purpose — the run continues,
so the error branch is a real path and is modelled as one.

**Nothing crosses a sub-workflow boundary.** A sub-workflow node is one node
here. Whether the graph it calls has its own guarantees is that workflow's
question, checked at that workflow's deploy.

**Guarantees never inspect data.** "This never charges more than £500" is not
expressible, and deliberately so — that is a question about values, which is
what [policies](./POLICIES.md) and [FXL](./EXPRESSIONS.md) are for. Guarantees
are about control flow, and keeping the two apart is what keeps each of them
decidable.
