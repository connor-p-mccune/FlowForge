# Repeats: what happens twice

Every static check in FlowForge asks whether **one run** of a workflow is right.

Three mechanisms in the engine make a step run a second time, and each is
correct on its own terms:

| | |
|---|---|
| **Node retries** | Every node but the four single-attempt types gets `EXEC_MAX_ATTEMPTS` attempts — three by default, on by default, on every run. |
| **Resume from failure** | Re-executes everything that did not succeed. |
| **Crash recovery** | Re-runs a step whose outcome nobody recorded ([DURABILITY.md](./DURABILITY.md)). |

The first one is the uncomfortable one. It needs no crash, no operator, and no
bad luck beyond a slow response — and a retry fires on a **timeout**, which is
precisely the case where the far side may already have done the work.

[`stepIdempotency.js`](./DURABILITY.md#the-escape-hatch-a-key-the-far-side-recognises)
gives an author the means to make a repeat safe.
[`recovery_policy`](./DURABILITY.md) gives them a setting saying how much
repetition they will tolerate. Nothing told them what their graph actually does
under either, which is what this report is for.

The surfaces are `flowforge repeats <id> [--strict]`,
`GET /api/v1/workflows/:id/repeats`, and `GET /api/workflows/:id/repeats`.

---

## What it reports

```console
$ flowforge repeats 6f0c…
What happens twice in Orders
REPEAT   NODE                      WHEN         WHY
unsafe   Charge card               retried ×3   a POST with no idempotency key — a repeat sends the request again
unsafe   Send receipt              retried ×3   there is nothing a recipient deduplicates on
unsafe   Fulfil order → Fulfilment on resume    the worst a repeat of Fulfilment does is unsafe
billed   Fraud score               retried ×3   a repeat produces another completion and is charged for it
guarded  Reserve stock             retried ×3   declares idempotent, so every attempt carries the same Idempotency-Key
safe     Fetch price               retried ×3   a GET reads

Recovery: recovery_policy is "safe": 3 step(s) would stop a crashed run and need a person

  6 step(s) a repeat would touch · 3 unsafe · 1 guarded · 1 billed twice
  2 step(s) the engine retries by itself would repeat their work: Charge card, Send receipt
  No crash needed — a timeout on a request that landed is enough.
```

---

## The verdicts

| | |
|---|---|
| `safe` | A repeat changes nothing outside. A read, or a method RFC 9110 defines as idempotent. |
| `guarded` | Not naturally safe, but the node declares `idempotent` **and its runner sends the key**. |
| `unsafe` | A repeat does the work again. |
| `billed` | A repeat changes nothing outside and costs money anyway. |
| `unknown` | The method is computed at run time, so the graph does not settle it. |
| `opaque` | A sub-workflow call whose callee could not be read. |

Three of those boundaries are decisions rather than lookups.

### PUT and DELETE are safe

That is a claim about the **protocol**, not about the server. RFC 9110 defines
both as idempotent: the state after *N* identical requests is the state after
one. A server that violates it is broken in a way FlowForge cannot see, and
treating every PUT as a hazard would bury the POST that actually is one.

The narrower failure — a second `DELETE` returning 404 and *failing the retry* —
is a different problem from doing the work twice, and this report is about the
second.

### `billed` is not `unsafe`

Repeating a model call produces another completion and another invoice. Nothing
outside changes. Folding that into `unsafe` would make every AI workflow look
broken and train somebody to stop reading the column, and then the POST goes
with it. It is a [budget](./ARCHITECTURE.md) decision, reported as one.

### An email is never `guarded`

There is no header a receiving mail server deduplicates on, which is why
`stepIdempotency.KEYED_TYPES` refuses the declaration there at all. A node that
declares it anyway is reported `unsafe` **and** flagged
`declaredButUnsendable` — the one finding in this report with a *wrong belief*
attached rather than a missing one. The linter warns about the same nodes.

### It errs toward saying less

A computed method (`{{trigger.verb}}`) is `unknown`, not `unsafe`. The asymmetry
runs the opposite way from the [effect report's](./EFFECTS.md#errs-toward-saying-less)
and for the same underlying reason: what matters is that the finding stays
believed. A report that flagged every node with a templated method is a report
somebody turns off.

---

## The number to gate on

`summary.retriedUnsafe` — steps the engine repeats **by itself** whose repeat is
not safe.

`--strict` fails on that and deliberately not on the rest of the report. A
workflow whose crash recovery would park for a person is the `safe` policy
*working*, and failing a build for it would teach somebody to stop running this
at all.

A sub-workflow call is `retried: false`: it is a single-attempt type, so a
nested charge repeats on a resume or a recovery and only there. Reporting it as
automatically retried would misplace the urgency by putting a rare event in the
column that means *today*.

---

## The recovery policy as a claim

This is the half that makes it an analysis rather than a checklist.

`recovery_policy: 'resume'` is documented as *"always continue — for a graph
whose steps are idempotent, which only its author can know"*. That is an
**assertion**: made once, in a dropdown, about a graph that has been edited
fifty times since. This is the only place it is checked against the graph.

| `recovery.verdict` | |
|---|---|
| `contradicted` | The policy says every step is safe to repeat, and some are not. |
| `unverified` | The graph does not settle some step either way — not the same as agreement. |
| `blocks-recovery` | Under `safe`, these are the steps that will park a crashed run for a person. Also the list of declarations worth making. |
| `consistent` | The graph supports what the policy claims. |

`unverified` exists because collapsing it into `consistent` would let a
templated method certify a policy, and collapsing it into `contradicted` would
fail every workflow with a computed URL. Neither is the truth.

Sub-workflow calls are followed, so a `resume` policy is contradicted by a
charge three boxes and one call away — which is the case an author is least
likely to have considered when they set it.

---

## What it does not do

- **It does not know whether the endpoint is really idempotent.** `guarded`
  means the key is sent, not that the far side honours it. FlowForge cannot make
  a third party idempotent; it can send the header the third party is waiting
  for, and report that it did.
- **It does not count how many times.** A `for-each` over 200 items calls its
  callee 200 times; that is one *step* here. The question is whether a repeat is
  safe, not how large the repeat is.
- **It does not watch.** This is a question you ask, and a gate you can put in a
  pipeline. The monitors that fire on their own are [SLA](./INSIGHTS.md),
  [drift](./DRIFT.md) and [assertions](./ASSERTIONS.md).
- **It restates the engine's retry shape rather than importing it.** A route
  that wants a verdict should not load the run loop to get one. The drift risk
  that creates is paid in the test suite, which imports both and asserts they
  agree — including that `guarded` is claimed for exactly the node types
  `stepIdempotency` will issue a key for.
