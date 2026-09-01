# Effect reachability: what a run can do, and what has to be true first

FlowForge has a lot of static analysis, and each piece answers a different half
of one question without any of them answering it whole.

| | Answers | Doesn't answer |
|---|---|---|
| [Linter](./ARCHITECTURE.md#static-analysis-the-linter) | Is this node's config valid? | Whether the node runs at all. |
| [Lineage](./LINEAGE.md) | Where did this value come from, and where does it leave? | Which of those sinks a given run reaches. |
| [Guarantees](./GUARANTEES.md) | Does this declared property hold over every execution? | Anything nobody thought to declare. |
| [Path feasibility](./PATHS.md) | Is there an input that takes this branch? | What the branch then *does*. |
| [Policies](./POLICIES.md) | Is this workflow allowed here? | What it can do once it is. |

The question none of them answers is the one a security review opens with:

> **What can this workflow do to the outside world, and for each of those
> things, what has to have happened first?**

Today that is answered by a person reading the canvas and tracing backwards —
which is exactly the work a graph algorithm should be doing. And the answer is
a classical one: **an effect's preconditions are the decisions it is control-
dependent on.**

The surfaces are `flowforge effects <id> [--deep]`,
`GET /api/v1/workflows/:id/effects`, `GET /api/v1/workflows/:id/reach` for the
transitive form, and `POST /api/workflows/:id/effects` for the canvas.

---

## What it reports

```console
$ flowforge effects 6f0c…
What a run can do
KIND   NODE          REACHES        WHEN
model  Fraud score   gpt-4o-mini    always
http   Charge card   api.acme.com   High risk? = false and Approve = true
email  Send receipt  ops@acme.com   High risk? = false and Approve = true

What each decision rules out
  Approve ≠ true → Charge card, Send receipt cannot happen
  High risk? ≠ false → Charge card, Send receipt cannot happen

  3 effects · 2 gated · 1 on every run
```

Two readings of one analysis. Down the table: every effect with its
preconditions. Below it: the inverse, which is the sentence somebody actually
says out loud — *if this approval rejects, what can still happen?*

An **effect** is a node that reaches outside FlowForge or costs money: an HTTP
call, an email, a Slack post, a sub-workflow, a model call. A log node writes to
stdout and a transform rearranges an object; listing those would bury the ones
that matter.

---

## The rule

> Effect node `N` requires outcome `o` of decision `D` when
> **(1)** `D` **dominates** `N` — every path to `N` goes through `D` — and
> **(2)** `N` is reachable from exactly one of `D`'s outcome groups, namely `o`.

Both halves are load-bearing, and dropping either is how a report like this
starts claiming preconditions that are not real.

**Without (2)**, a decision that every path passes through would count as a
gate even when it leads to the effect whichever way it goes — telling a reviewer
to go and check a branch that does not matter.

**Without (1)**, the analysis misses the case the whole thing exists for. A
workflow runs `webhook → approve → charge`. Somebody adds a manual trigger so
they can test the charge without posting a webhook, and wires it straight at the
node they were testing. Every node still lints. Every type still checks. Nothing
is unreachable. And the approval is now **optional** — so `charge` must be
reported as running *always*, not as gated by a gate that is still on the canvas
and no longer holds. There is a test for exactly that graph.

Together the two are a proof, which is what lets the report be read as one.

### Errs toward saying less

Anything ambiguous produces **fewer** conditions rather than more. If an edge
belongs to no outcome group, or an effect is reachable from two of them, no
condition is recorded for that decision.

The asymmetry is deliberate. A missing condition makes the report *look worse*
than reality — an effect appears less gated than it is, and somebody
investigates. A condition claimed and not real is a review that concluded the
wrong thing and signed off. Only one of those failure modes is recoverable.

---

## Reused, not reinvented

The analysis is about forty lines of graph work on top of machinery that already
existed, which is the point:

- **`guarantees.executionGraph`** supplies the **outcome partition** — the
  structural idea that a condition, a nine-case switch, a validate gate, an
  approval, a wait-for-callback and a per-node error branch are all one thing: a
  node with several groups of outgoing edges, of which exactly one activates.
  `effects.js` therefore handles all six without knowing what any of them are,
  and a seventh would work the day it is added.
- **`dominance.js`** supplies the dominator tree, computed the same way the
  guarantees checks compute it.
- Sticky notes and compensations are stripped by the engine's own rule, because
  `executionGraph` does it. A compensation reaches a real host, but it is not
  something a *run* does — it happens only if the run ends badly, which is
  [the rollback report's](./ROLLBACK.md) subject rather than this one's.

The one thing it adds is a more precise host reader than the policy engine's.
`https://api.acme.com/orders/{{trigger.id}}` has a **fixed authority** and only
a templated path, so the destination is known — the same line
[lineage](./LINEAGE.md) draws when it decides an SSRF finding, since only a
dynamic authority lets a caller choose where a request goes. Calling that URL
"dynamic" would send a reviewer to investigate a pinned host.

Where the destination genuinely is not determined, the target is `null` and the
count is reported — `2 whose destination the graph does not determine` — rather
than a plausible guess.

---

## Across the sub-workflow boundary

Everything above is about **one graph**, and over one graph it is complete. A
sub-workflow node breaks that.

On the canvas it is one box. At run time it is an entire other workflow, with
its own HTTP calls, its own emails, its own gates — and the per-graph report
describes it honestly and uselessly:

```
workflow  Fulfil order   → 4f2a…       always
```

*"Calls workflow 4f2a"* is true and tells a reviewer nothing. The workflow they
are reviewing **can charge a card**; it just does it three boxes and one call
away, and nobody reading the canvas would know.

`flowforge effects --deep` and `GET /api/v1/workflows/:id/reach` expand the call
into what the callee actually does, and the same for its callees, to a bounded
depth.

### The preconditions are a conjunction

This is the part that has to be right.

An effect inside the callee is gated by the **callee's** decisions. The call
itself is gated by the **caller's**. So the honest precondition for *"this run
can charge a card"* is both:

```
Approve order = true      ← in Orders, gating the call
In stock?     = true      ← in Fulfilment, gating the charge
```

Dropping either half is wrong in a different direction. Keeping only the
callee's claims the charge happens whenever the callee decides it should,
ignoring that the caller may never invoke it. Keeping only the caller's claims
it happens on every call.

Both are carried, in call order, each attributed to the workflow it came from —
so a reviewer reads a chain rather than a set of unattributed clauses. There is
a test that an effect which *is* unconditional inside the callee is not reported
as `always` once it is reached through a gate, because that is precisely the
claim a review must not be given.

### Where the walk stops

Three things stop it, and each **keeps the unexpanded effect** rather than
dropping it — *"calls something I cannot see"* is more useful to a reviewer than
silence:

| | |
|---|---|
| A **cycle** | A workflow already on the call stack. The engine refuses one at run time; expanding it here would not terminate. |
| The **depth bound** | Reported as truncated rather than silently returning a prefix as though it were the whole answer. |
| A callee **this caller cannot see** | Deleted, or in another workspace. That is not a policy decided here — it is the boundary the sub-workflow runner already enforces, so a call across workspaces is not one to follow because it is not one the engine would make. |

`summary.direct` is deliberately the number the per-graph report would have
given, so the difference between *what this graph does* and *what a run of it
does* is a fact in the payload rather than something to work out by counting.

---

## As a CI gate

`--ungated` exits non-zero when any effect has no preconditions at all.

It is **opt-in per pipeline rather than a default**, because the finding is
genuinely ambiguous: a workflow that calls a payments API on every run is a
perfectly legitimate thing to build, and it is also exactly what a gate somebody
routed around looks like. Which one it is depends on what the workflow is for,
which the pipeline knows and this does not. A check that failed every
straight-line workflow's build is a check somebody deletes.

---

## What it does not do

- **It does not know what the effect *is*.** An HTTP POST to `api.acme.com`
  might charge a card or fetch a price; the graph does not say, and inventing a
  severity would be a guess dressed as an analysis.
- **It does not evaluate the conditions.** "Approve = true" is a precondition,
  not a probability. Whether an input exists that satisfies a conjunction of
  branch conditions is [path feasibility's](./PATHS.md) question, and the two
  compose: that analysis can tell you a gated effect is unreachable *for any
  input*, which this one reports as merely gated.
- **It does not replace a declared guarantee.** This says what is true of the
  graph today. A [guarantee](./GUARANTEES.md) says what must stay true, and is
  enforced at deploy. Reading this report is how you decide which ones to pin.
- **The inverse view stays per-graph.** *"If this approval rejects, what can
  still happen?"* is a question about one set of decisions. Composing it across
  a call chain — where a rejection in the caller and a rejection in the callee
  rule out overlapping but different things — is a different report rather than
  this one with more rows, so `--deep` does not attempt it.
