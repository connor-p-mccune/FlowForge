# Explain: why didn't it send the email?

That is the question. Every workflow tool ever built is asked it, and none of
them answers it.

The run says `completed`. The email step says `skipped`. Everything on the
dashboard is green, and the customer did not get their receipt. What the run
history gives you is the fact the person asking already has.

Answering it means holding three things together — and FlowForge had all three,
in the same database, and had never joined them up:

| | |
|---|---|
| **What the run did** | `execution_steps`, including the rows the engine settles as `skipped` for nodes a branch went past. |
| **What gates what** | Control dependence, which [the effect report](./EFFECTS.md) already computes to say *"Charge card requires Approve = true"*. |
| **Which way each gate went** | The decision node's own recorded output, in the same table. |

Put together, they turn a status into a sentence.

The surfaces are `flowforge explain <execution-id> [--node <id>]`,
`GET /api/v1/executions/:id/explain`, and `GET /api/executions/:id/explain` for
the run panel.

---

## What it reports

```console
$ flowforge explain e57a…
Why Orders did what it did  ·  completed

What each decision decided
  High risk? → true (closing false)
      total > 100 — total was 850

What did not run
  Charge card
    High risk? was true, and that branch does not reach it
      total > 100 — total was 850
  Send receipt
    High risk? was true, and that branch does not reach it
      total > 100 — total was 850

  3 ran · 2 skipped · 0 failed · 1 decision(s)
```

Decisions lead, because they are the causes and every skipped step below points
back at one of them.

`--node <id>` narrows to one node, which is how the question is actually asked.
Nobody wants a run explained; they want to know why *that* did not happen.

---

## This is the runtime counterpart to the effect report

| | Says |
|---|---|
| [`effects`](./EFFECTS.md) | What a run **could** do, and what would have to be true first. |
| `explain` | What one run **did**, and which of those conditions decided it. |

They are the same analysis read in two directions. `effects` computes the
control dependence statically and reports the precondition; `explain` takes the
same partition of a decision's outgoing edges — `executionGraph` already
produces it — and asks which group actually activated.

That shared machinery is why this works for a condition, a switch, a validate
gate, an approval, a wait-callback and a per-node error branch without knowing
what any of them are. A seventh kind of decision would work the day it is added.

---

## Three reasons a step does not run

A decision is only one of them, and reporting the other two as though they were
decisions would suggest somebody chose this.

| `because.kind` | |
|---|---|
| `decision` | A gate chose against it. The one this report was built for. |
| `upstream-failure` | Something above it failed and the run never got there. |
| `cancelled` | Somebody stopped the run — not a fact about the graph at all, which is exactly why it has to be said. |

The failure case uses **dominance, not reachability**. A node whose failure was
caught by an `onError` branch did not stop anything downstream of that branch,
and blaming it would send somebody to a step that was handled on purpose. Only a
failure that every path to this node goes through is a failure that stopped it.

A settled decision always wins over a failure elsewhere. A decision is a
*choice*; a failure on some other branch is not what closed this path, and
naming it would point at the wrong node.

---

## Naming the decision, not a decision

A node skipped in a run is usually excluded by exactly one decision, but the
graph can gate it behind several. Reporting all of them is an audit trail rather
than an answer.

So the report names the **deepest** gate that closed the path: the last one the
run passed before this node became unreachable. That is the one somebody would
point at. Everything upstream of it is why *that* gate was reached, which is the
next question and not this one.

A gate the run never settled is never blamed. If the trigger failed and nothing
downstream ran, no decision closed anything — the report says so rather than
picking the nearest one.

---

## Reading a condition out loud

A decision's outcome is recorded, so saying which way it went needs no
re-derivation. The interesting part is *why*, and for an FXL expression that is
answerable exactly:

- The expression is **pure** — [FXL has no side effects](./EXPRESSIONS.md).
- Its scope is the step's **recorded input**, already in the row.
- The identifiers it reads are in the **AST**.

So `total > 100` becomes `total > 100 — total was 850`, read out of the row the
engine already wrote rather than by running anything again.

Two details that matter more than they look:

**`not set` is not `false`.** A field the input did not have reports as `not
set`. The difference between "the value was falsy" and "the field was absent" is
most of what a 3am investigation is about, and FXL's
[string-comparison fallback](./QUERY.md) makes conflating them actively
dangerous.

**A dotted path is reported whole, and its base is not.** `order.total` yields
`order.total`, not `order.total` *and* `order` — the second is the entire object
printed next to the field somebody asked about. Computed indices are still
named, because `a.b[c].d` really does read `c`.

---

## A left/right comparison reports no operands

The condition node's other mode compares `left` against `right`, and both are
`{{…}}` templates resolved against a scope spanning **every prior node's
output** — which is not recorded per step.

Reconstructing it would mean re-resolving templates against a scope that no
longer exists, and printing the result as though it were what the run saw.
That is inventing a value and presenting it as a fact, which is the one thing an
explanation must never do. The outcome is reported; the operands are not.

---

## What it does not do

- **It does not invent a cause.** A run that simply stopped — nothing failed,
  nothing cancelled, no decision against it — leaves the step unattributed, and
  `summary.unexplained` counts those rather than hiding them. A report claiming
  to explain everything that quietly does not is worse than one that says which
  rows it could not.
- **It does not re-run anything.** Every value it prints came out of a row. A
  replay would be [preview's](./PREVIEW.md) job and would answer a different
  question, about a graph that may since have changed.
- **It does not cross the sub-workflow boundary.** A child run has its own
  execution id and its own explanation; the call site reports as one step. The
  call tree in the run panel is the route between them.
- **It does not say whether the decision was right.** Only what it was, and what
  it read. Whether `total > 100` is the correct rule is a question for the person
  who wrote it.
