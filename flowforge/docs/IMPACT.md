# Impact: what a change means, rather than what it is

FlowForge has four ways to look at a candidate definition before it ships, and
between them they answer everything except the question.

| | Answers |
|---|---|
| [`diff`](./API.md#detect-drift-against-an-exported-document) | The live workflow and your file have drifted, here. |
| [`lint`](./ARCHITECTURE.md#static-analysis-the-linter) | The candidate is valid. |
| [`contract`](./CONTRACTS.md) | It does or does not break the workflows that call it. |
| [`preview`](./PREVIEW.md) | Last week's traffic would have produced these outputs. |

None of them says **what the edit does to the properties somebody was relying
on**. And the change that matters most is the one that is structurally tiny:

> Delete one edge. Wire a trigger straight at the node behind it.

That is a one-line diff. Every node still lints. Every type still checks.
Nothing is unreachable. `preview` sees the same outputs, because the payloads
that reached the charge before still reach it. And an approval is no longer in
front of a payment.

The [effect report's](./EFFECTS.md) dominance analysis has known how to catch
that since the day it was written. The only thing missing was somebody running
it **twice** and subtracting.

The surfaces are `flowforge impact <id> <file> [--strict]`,
`POST /api/v1/workflows/:id/impact`, and `POST /api/workflows/:id/impact` for
the canvas.

---

## What it reports

```console
$ flowforge impact 6f0c… orders.flow
What this change does to Orders

  Charge card now runs on every run
    It was gated before this change; nothing in the graph gates it now.

! A declared guarantee no longer holds
    Charge card never runs unless Approve ran first — it is broken by this change.

  Send receipt is no longer safe to repeat
    a POST with no idempotency key — a repeat sends the request again

What it fixes
  ✓ Fetch price is now gated

  3 introduced · 1 resolved · 1 another gate already refuses
```

Six analyses run over both graphs and the **difference** in their verdicts is
the report: effects, [repeats](./REPEATS.md), [guarantees](./GUARANTEES.md),
lint, [path feasibility](./PATHS.md), [convergence](./CONVERGENCE.md).

---

## Only what changed

The discipline this lives or dies by.

> A property that was **already** broken is not a finding of this change.

A candidate whose predecessor already had an ungated charge reports nothing
about it. A review that relists every pre-existing problem on every edit is a
review nobody reads twice — and the one new line gets lost among the forty old
ones.

This is the same rule [mutation scoring](./MUTATION.md) applies when it credits
a mutant only with the errors its mutation *introduced*, and it is the same
reason: a score built on inherited failures measures the wrong thing.

The corollary is that `resolved` is reported too, and not out of politeness. An
edit that gates an effect, adds an idempotency key or fixes a lint error is
exactly as much a semantic change as one that removes them, and a reviewer told
only about the bad half cannot tell a refactor from a regression.

---

## The two tiers, and which one this is for

| `summary` | |
|---|---|
| `blocking` | A finding some **other** gate already refuses: a broken guarantee, an introduced lint error. |
| `review` | Legal, deployable, and nothing else in the product says it out loud. |

The ungated effect leads the list, above the broken guarantee, and the ordering
is the argument.

A broken guarantee is already refused at deploy — somebody declared the
property, so the gate exists and this is a second opinion. An effect that
quietly loses its gate is legal, nobody declared anything about it, and **this
is the only place it is ever going to be said**.

The exit code splits the same way. `blocking` findings fail the build on their
own, because a pipeline running `impact` and not `verify` should still stop.
`--strict` is how a pipeline says it wants to stop for the rest.

---

## Identity, and where it breaks

Two findings are "the same finding" when they share an area, a code, and a
subject — almost always a node id. That works because a node keeps its id across
an edit.

It stops working when somebody **deletes a node and draws a new one in its
place**. The ids differ, so one finding reads as resolved and another as
introduced, when a person would call it neither.

The report does not pretend otherwise. `nodes.added` and `nodes.removed` ride
along beside the findings, and the CLI prints a line when both are non-empty:

```
  1 node(s) added and 1 removed — a finding reported as both fixed and
  introduced may be one node redrawn.
```

Guessing at the correspondence — matching on label, or position, or shape —
would be inventing an identity the graph does not carry. Getting that wrong
silently is worse than the counting problem it fixes, because a reviewer would
then be told confidently that an ungating did not happen.

---

## Across the sub-workflow boundary

Both sides are expanded through the [transitive walk](./EFFECTS.md#across-the-sub-workflow-boundary)
when the caller can resolve callees, so adding a sub-workflow call reports
**what the call reaches** rather than that a call appeared:

```
  Charge card is new
    A http reached through Fulfilment, to api.acme.com.
```

Without a resolver it falls back to the graph in front of it and reports the
call itself, which is the honest answer when the callee cannot be read.

---

## What it does not do

- **It does not compare against the file you sent.** The *before* side is
  always the deployed graph, because the question is what this edit changes
  rather than what the workflow is.
- **It does not judge whether the change is right.** An ungated payment is
  sometimes exactly what somebody meant. The report's job is to make sure that
  is a decision rather than an accident, which is why the `review` tier does not
  fail a build by default.
- **It does not diff behaviour.** What last week's traffic would have done is
  [preview's](./PREVIEW.md) question, and the two compose: this says the
  approval left the payment path, that says which of last week's runs would have
  charged anyway.
- **It does not diff the graph.** [`graphDiff`](./MERGE.md) does that, and its
  output is the input to this one's subject rather than a substitute for it.
