# FlowForge design records

Twenty-four documents is too many to read in order, so this is a map rather than
a table of contents. Each record covers one part that was hard, and each is
organised the same way: **what the obvious implementation gets wrong**, the
design that fixes it, and the limits stated rather than oversold.

If you're looking for one place to start, pick whichever problem below sounds
most familiar.

---

## Start here

| | |
|---|---|
| [**ARCHITECTURE.md**](./ARCHITECTURE.md) | The whole system: the execution engine, the scheduler, the collaboration model, the reliability controls, persistence, observability. Everything else is a chapter of this one. |
| [**API.md**](./API.md) | The public REST API — every endpoint with a worked `curl`, and the OpenAPI spec it is generated against. |

---

## Making a graph run

| | The question |
|---|---|
| [EXPRESSIONS.md](./EXPRESSIONS.md) | Users need real logic in a config field, and `eval` is not an option. A hand-written lexer → Pratt parser → tree-walking evaluator. |
| [TYPES.md](./TYPES.md) | A visual builder normally finds out its data doesn't line up by running it. A real type lattice over the canvas instead — where `any` and `unknown` are kept as different facts. |
| [SCHEDULING.md](./SCHEDULING.md) | The engine runs branches in parallel up to a cap, and every other analysis pretended the cap didn't exist. Ordering the ready set by upward rank, and measuring what the cap costs a run. |
| [CONVERGENCE.md](./CONVERGENCE.md) | Where parallel branches meet, their outputs are assigned over each other and one silently wins — decided, until recently, by the order the edges sat in the array. Which three parts of the product rewrite differently. |
| [DURABILITY.md](./DURABILITY.md) | Every reliability control assumes the process survives the run. What happens when it doesn't: leases, fencing tokens, and a step recorded as *indeterminate* rather than guessed at. |
| [ROLLBACK.md](./ROLLBACK.md) | Every other control bounds *whether* something runs. None undoes what already ran. Compensations, unwound in reverse completion order. |

---

## Knowing what a graph will do

| | The question |
|---|---|
| [GUARANTEES.md](./GUARANTEES.md) | *Can this ever charge a card without the approval having run?* — a question about a **path**, which makes it graph dominance, which is a solved problem. |
| [PATHS.md](./PATHS.md) | *Is there an input that reaches this branch?* — a solver question, so there is a solver: difference logic, finite domains, DPLL(T). Its models double as generated test scenarios. |
| [LINEAGE.md](./LINEAGE.md) | Where a value came from, what breaks if it changes, and whether anything reaching a URL is controlled by whoever sent the webhook. |
| [EFFECTS.md](./EFFECTS.md) | *What can this workflow do to the outside world, and what has to be true first?* — control dependence, and why a gate somebody routed around must report as no gate at all. |
| [PREVIEW.md](./PREVIEW.md) | Every deploy gate is static. None says what the change *does*. So replay last week's traffic against the candidate graph. |

---

## Governing it

| | The question |
|---|---|
| [POLICIES.md](./POLICIES.md) | The linter asks "will this run?"; a policy asks "is this *allowed* here?". Rules type-checked when saved, so one reading a misspelled field is refused rather than reporting every workflow compliant forever. |
| [APPROVALS.md](./APPROVALS.md) | "Until *a* member responds" is the right default and the wrong one for a refund. Quorum, owner-only gates, separation of duties — and a linter that refuses a gate the workspace can never satisfy. |
| [PRIVACY.md](./PRIVACY.md) | A right to erasure, over a hash-chained log built so nobody can quietly remove things from it. Delete the rows and the chain breaks; rewrite the chain and it proves nothing. |
| [PROVENANCE.md](./PROVENANCE.md) | `export → git → review → CI → import` passes a definition through four systems that can change it. An Ed25519 signature over the graph's *semantics*, not its bytes. |
| [CONTRACTS.md](./CONTRACTS.md) | A workflow's return type is a promise to the workflows that call it — and the author who breaks it is not the author who finds out. Covariance of return types, where narrowing is safe and widening breaks. |
| [MERGE.md](./MERGE.md) | Drift detection tells you git and production diverged, then makes you pick a side to throw away. A real three-way merge, per config field, that produces **no graph at all** on conflict. |
| [DSL.md](./DSL.md) | Every part of that loop is built around a document a human is supposed to *review*, and the document is a JSON blob. A line-oriented text format whose emit order is the signature's canonical order. |

---

## Watching it run

| | The question |
|---|---|
| [INSIGHTS.md](./INSIGHTS.md) | Duration percentiles, a robust anomaly score, a monotonic trend — and Pettitt's test to say *when* a workflow got slower and which deploy did it. |
| [RELEASES.md](./RELEASES.md) | A canary is a small sample, and a threshold on a small sample is a coin flip with a UI. Two-proportion z-test, Mann-Whitney U, Wilson intervals. |
| [DRIFT.md](./DRIFT.md) | Every monitor here watches *time* or *outcome*. None watches the **data** — so a field that starts arriving null is green on every dashboard. |
| [CAPACITY.md](./CAPACITY.md) | The concurrency cap is a number somebody typed once. Queueing theory says what it buys — and the model can be checked against the wait already recorded, so it grades itself. |

---

## A note on how these are written

Each record leads with the failure the obvious design produces, because that is
the part worth remembering. Several of them argue against a choice that looks
more principled than the one taken — a quorum of rejections, a chi-square
instead of PSI, a schema you declare instead of one derived from history — and
say why. Where a control has a boundary, the boundary is stated: separation of
duties is inert on unattended runs, a hash chain proves internal consistency
rather than notarisation, an effect report does not know what an effect *is*.

A design record that only lists what works is a brochure.
