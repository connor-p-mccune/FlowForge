# Compensating transactions

Undo what a failed run already did.

```
Run 4f2a…  failed at Ship order

  ⚠ Rollback partial — 1 of 2 compensations still failing

  #0  failed     Refund charge   undoes Charge card     3×  ECONNREFUSED
  #1  succeeded  Release stock   undoes Reserve stock    1×

  → the charge is still standing. Fix the refund node and retry;
    the release is not repeated.
```

---

## The gap this closes

Every reliability control in FlowForge bounds **whether** something runs:

| Control | What it bounds |
|---|---|
| Retries | how many times a step attempts its work |
| Circuit breaker | whether a dead host is called at all |
| `onError: continue` / `branch` | where the run goes after a step fails |
| Error-handler workflows | who gets told |
| Concurrency, rate limit, budget, pause | whether a run starts |

None of them undoes what already happened. A run that reserves inventory at
step 2, charges a card at step 4 and fails at step 7 leaves the reservation and
the charge standing, and the platform's entire contribution is a red badge in
the history list.

That is the problem the **saga pattern** exists for: a long-lived transaction
that cannot hold a lock across its steps pairs each step with a *compensating
action* and unwinds by running them backwards. This is FlowForge's version of
it, expressed the way everything else here is — on the canvas.

---

## A compensation is a node

Drop any action node, set **This node undoes** to the node it reverses, and it
becomes that node's compensating action.

```
   Trigger → Reserve stock → Charge card → Ship order ✗
                  ↑               ↑
            Release stock    Refund charge      ← compensations, unconnected
```

It is a real node with real config, so it inherits the linter, the type
checker, the data picker, secrets, `{{…}}` templates and the test bench. There
is no new concept to learn and no second configuration language.

It is also **not part of the forward graph**. The engine strips compensation
nodes before it builds the DAG, exactly as it strips sticky notes: no step row,
no place in the topological order, never launched on the happy path. Any edges
you draw to one are ignored (the linter warns). That is why a compensation may
not be a trigger — it has no payload to emit — or a branching node: a rollback
follows no edges, so its handles would route nowhere.

### What it can read

A compensation runs *after* the run, so it is not bound by the upstream rule
that governs the forward pass. The whole run context is in scope:

| Reference | Resolves to |
|---|---|
| `{{charge-card.chargeId}}` | any node's output — the charge to refund, the reservation to release |
| `{{secrets.*}}`, `{{vars.*}}` | as everywhere else |
| `{{rollback.error}}` | the error that caused the unwind |
| `{{rollback.failedNode}}` / `{{rollback.failedNodeLabel}}` | which node failed |
| `{{rollback.reason}}` | `failed` or `cancelled` |
| `{{rollback.executionId}}` | the run being unwound |

Its **input** is the output of the step it undoes — the only input that is
always meaningful.

---

## What actually runs, and in what order

### Reverse completion order, not reverse topological order

A DAG says what *may* run in parallel. It does not say what actually finished
first, and with `EXEC_MAX_PARALLEL > 1` two independent branches genuinely
interleave. Undoing in an order the run never happened in is how you release a
resource a later step is still holding.

So the engine records the real completion sequence
(`execution_steps.completed_seq`) and the rollback walks it backwards.

### Sequential, always

The forward pass is parallel because throughput matters and the DAG proves
independence. A rollback runs one compensation at a time even where the graph
would permit otherwise, because the failure mode here is not slowness — it is a
half-undone state, and interleaving undos is the direct route to one. A rollback
is bounded by the number of steps that already succeeded, so the cost is small
and paid once.

### Only steps that did work, and only ones that succeeded

| Step status | Compensated? | Why |
|---|---|---|
| `succeeded` | **yes** | it did the work and it worked |
| `failed` | no | it did not succeed; there is nothing to reverse |
| `caught` | no | it did not succeed either — and its author already said what its failure means by choosing `continue` or `branch` |
| `cached`, `reused` | **no** | this run did no work; the effect belongs to an *earlier* run that still owns it |
| `skipped` | no | it never ran |

The `cached` / `reused` rule is the one worth stating twice. Compensating a
cached step would undo a side effect a different execution caused and is still
relying on — a data-loss bug wearing a safety feature's clothes. In the schema
this is not a separate rule at all: `completed_seq` is set exactly when *this
run performed the node's work*, so the column and the rule are the same fact.

---

## When a compensation itself fails

It does not stop the rollback.

The run has already failed — there is no worse status to reach — and stopping
would strand every compensation *further back*, which protect the earliest and
usually most expensive side effects. So a compensation that exhausts its retries
is recorded, the unwind continues, and the run settles **`partial`**.

`partial` is a distinct status because "some of the undo worked" is
operationally different from both success and failure: the state is inconsistent
in a **known, enumerated** way. The run detail names exactly which compensations
are outstanding, and a retry runs only those.

Compensations retry on the same ladder as forward steps. The stakes are higher,
not lower: a forward step that stays failed fails a run, while a compensation
that stays failed leaves the outside world inconsistent. The attempt count is
recorded — "the refund went through on the third try" is exactly what you want
in the record when reconciling.

---

## Retrying a rollback

The automatic unwind fires the moment a run fails. The manual one exists for the
case it cannot handle: **the compensation was itself broken.** The refund
endpoint was down, a credential had rotated, a `{{…}}` pointed at the wrong
field.

```bash
flowforge rollback <execution-id>          # shows the plan, changes nothing
flowforge rollback <execution-id> --yes    # runs the outstanding compensations
```

Two rules, both mirroring decisions made elsewhere in the product:

**It resumes; it never repeats.** Only compensations that have not already
succeeded are run. Compensations are supposed to be idempotent and frequently
are not — double-refunding a customer while cleaning up after a failure is a
worse outcome than the failure was. This is the same shape as
resume-from-failure, which reuses succeeded steps rather than re-executing them.

**It re-reads the graph.** A compensation node added or repaired after the
failure will run. That is the entire point: retrying the old, broken definition
would simply fail the same way. The data context, however, is the *persisted*
(secret-redacted) step output — so a secret an API echoed back during the run
does not survive into a compensation's config hours later.

`flowforge rollback` exits non-zero on a partial unwind, because the world is
inconsistent in a known way and a pipeline should stop.

---

## The policy

Run limits → **Rollback**:

| Policy | A run that… |
|---|---|
| `failure` (default) | failed → unwinds |
| `failure-or-cancel` | failed **or was cancelled** → unwinds |
| `off` | never unwinds |

The cancel question genuinely has a per-workflow answer, which is why this is a
policy rather than a boolean: abandoning a half-done deploy is not the same as
abandoning a half-done report you would rather keep.

`off` is the operator kill switch. Compensations stay drawn on the canvas and
stop executing — what you want at 3am when the compensating endpoint is the
broken thing. The linter warns when compensations exist under `off`, because
undo actions that silently cannot run are the exact confusion this feature
must avoid.

---

## What the linter checks

A compensation is *declared*, not connected, so nothing about it is structurally
visible — which makes it precisely the kind of thing static analysis has to
guard. The failure mode is a compensation that looks armed and never fires;
nobody notices until a run fails, and by then the effect it was meant to reverse
is standing in production.

| Code | Severity | Means |
|---|---|---|
| `dangling-compensation` | error | it undoes a node that doesn't exist |
| `invalid-compensation` | error | a trigger or branching node can never be one |
| `duplicate-compensation` | error | two compensations claim one node — "which refund runs?" has no defensible answer |
| `chained-compensation` | error | a compensation of a compensation; a rollback is not itself rolled back |
| `compensation-ref` | error | a forward node reads a compensation's output, which does not exist during the run |
| `rollback-scope-ref` | error | `{{rollback.*}}` outside a compensation, or an unknown key inside one |
| `wired-compensation` | warning | edges were drawn to it; they are ignored |
| `rollback-disabled` | warning | compensations exist, policy is `off` |

A compensation's `{{…}}` references are **type-checked** against the graph like
everything else — `{{charge-card.chrgId}}` is a lint error with a spelling
suggestion. It cannot be *inferred* (it has no upstream), but the nodes it reads
were just typed, so the check runs against that table. Being disconnected is a
compensation's defining property, so it is exempt from the unreachable-node and
non-upstream-reference rules — those would be wrong, not merely noisy.

---

## Testing one

This is where it composes with the rest of the product. A compensation is
normally impossible to test, because testing it means having the dependency
actually fail. Chaos profiles make the failure happen on purpose, and test
scenarios assert the result:

```json
{ "mode": "fail", "nodeId": "ship-order", "message": "carrier down" }
```

Run the workflow's test scenarios with that profile armed, and the run fails at
`ship-order` exactly as it would in production — the compensations fire (in
dry-run mode, so side-effecting nodes report what they *would* send), and the
rollback is visible on the run. "Does my undo actually work?" becomes an
assertion that runs in CI.

---

## Observability

| Signal | Where |
|---|---|
| `flowforge_compensations_total{status}` | `/metrics` — a rising `failed` means the compensating endpoint is broken, which is a page in its own right: it fires when everything else already went wrong |
| `flowforge_rollbacks_total{outcome}` | `/metrics` — how often runs unwind, and how often they only partly manage it |
| `execution.rollback_partial` | activity feed — a clean unwind is the machinery working and stays quiet; a partial one needs a person |
| `execution.rolled_back` | audit log — a manual rollback has a human behind it, and it fires irreversible effects |
| `rollbackStatus`, `compensations` | `GET /api/v1/executions/:id` |

---

## Limits, stated plainly

**Compensation is not transaction rollback.** There is no isolation and no
two-phase commit: between the charge and the refund, the charge was real and
anyone looking could see it. That is inherent to the saga pattern, and the
reason the pattern is *for* long-lived workflows across systems that cannot hold
a distributed lock.

**Your compensations must be idempotent** in the cases where the platform cannot
guarantee once-only delivery — a compensation that succeeds at the far end but
fails to report will be retried by a manual rollback.

**A compensation cannot compensate a partial step.** If an HTTP node times out
after the far side committed, the step is `failed` and is not compensated — the
engine cannot know the call landed. Model that with `onError: continue` and an
explicit reconciliation branch, which is a different tool for a genuinely
different problem.

**Nested runs unwind independently.** A sub-workflow child that fails runs its
own compensations; the parent then runs its own. That is how nested sagas are
supposed to compose, but it does mean the child's unwind happens first and
completes before the parent's begins.
