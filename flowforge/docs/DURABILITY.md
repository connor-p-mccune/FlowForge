# Surviving the worker

What happens to a run when the process executing it stops existing.

```
✗ Order sync  #4812        failed · the worker running this execution stopped responding
    ├─ Fetch orders        succeeded
    ├─ Charge card         indeterminate — whether it completed is unknown
    └─ Send receipt        skipped

  not resumed: Charge card may already have taken effect — resuming would repeat it
```

---

## The gap this closes

Every reliability control in FlowForge bounds what a **running** system does.

| Control | Bounds |
|---|---|
| Node retries | a flaky call |
| [The circuit breaker](./ARCHITECTURE.md#the-outbound-circuit-breaker) | a dead host |
| [Compensations](./ROLLBACK.md) | side effects a failed run already caused |
| [Graceful shutdown](./ARCHITECTURE.md#graceful-shutdown) | a *planned* stop |

All of them assume the process survives the run. When it does not — an
out-of-memory kill, a node evicted mid-deploy, a `kill -9` — the execution row
says `running` forever. The timeline never finishes, the [status
badge](./ARCHITECTURE.md#status-badges) never flips, [insights](./INSIGHTS.md)
count the run as neither success nor failure, and the only cure is somebody
noticing.

There is a second failure in the same place, and it is the more dangerous one.
Bull re-delivers a job whose worker stopped reporting progress — which is
exactly what an at-least-once queue is supposed to do. Running the engine again
on that job would insert a fresh step row per node and execute the whole graph
a second time: re-sending the email, re-charging the card. Nothing on this side
made the second delivery a no-op.

---

## The lease

`services/executionLease.js`. Three columns on the execution row:

```
lease_owner       which worker believes it is running this
lease_token       a fresh random value per acquisition — the fencing token
lease_expires_at  when that belief stops being credible
```

### It is renewed by a timer, not by the scheduler

A run parked on an [approval
gate](./ARCHITECTURE.md#human-in-the-loop-approvals) makes no progress for hours
**by design**. If renewal rode on a node settling, the most legitimate wait in
the product would look exactly like a crash.

A timer separates *this process is alive* from *this run is advancing*, which
are genuinely different facts — and a dead process runs no timers, which is the
whole mechanism.

### It carries a token, not just an owner

An owner column alone cannot survive the case it exists for. A worker stalled
long enough to lose its lease **can come back** — a paused VM, a long GC, a
blocked event loop — still holding every in-memory variable it had.

So the token is compared inside every write that decides the run's outcome:

```sql
UPDATE executions SET status = ?, … WHERE id = ? AND lease_token = ?
```

This is Kleppmann's fencing argument, and the reason checking first is not
enough: a check is only true until it isn't. The engine *also* reads its own
token once per scheduling round and stops launching when it no longer holds it
— cooperative and inter-node, exactly like
[cancellation](./ARCHITECTURE.md#cooperative-cancellation), because tearing down
a half-sent HTTP call is worse than letting it finish into a run nobody is
watching.

### Acquisition requires the run not to have started

```sql
WHERE id = ? AND status = 'pending' AND (lease_token IS NULL OR lease_expires_at <= ?)
```

That single condition is what makes a duplicate delivery inert — whether the
first worker is alive (its lease is live) or dead (recovery owns that case, and
it *continues* rather than restarts). **Re-running a half-done graph is never
the right recovery.**

### What is not leased

Dry runs and sub-workflow children. A child executes inside its parent's engine
loop, so its parent's lease is the only one that means anything; and a dry run
has somebody watching it, which is a better liveness check than a column.

---

## Recovery

`services/crashRecovery.js` sweeps for lapsed leases, because nothing publishes
*"I have stopped existing"* — the same reason [heartbeat
monitoring](./ARCHITECTURE.md#heartbeat-monitoring) is a sweep. It runs once at
boot as well as on its interval, since the runs it exists for are precisely the
ones a restart left behind.

### `indeterminate` is a real status, and refusing to resolve it is the design

A step that was `running` when the process died is **not failed** — the request
may well have been received, the charge may well have gone through — and **not
succeeded** either, because nobody recorded a result.

It is the one status the engine never writes during a normal run, and inventing
either of the two it does write would be a lie with consequences:

| If it were recorded as | Then |
|---|---|
| `failed` | a retry double-charges |
| `succeeded` | a resume skips work that never happened |

So the recovery records exactly what is true, and everything below follows from
declining to guess.

### The continuation is resume-from-failure, unchanged

[Resume](./ARCHITECTURE.md#resume-from-failure) already adopts a source run's
succeeded steps and re-executes the rest, with the freshness rule that reuse
stops the moment any node re-runs. Reusing it rather than inventing a second
mechanism is what stops a recovered run and a hand-resumed one from drifting.

An indeterminate step is not succeeded, so it re-executes — correct for a
Transform, unacceptable for a charge. `workflows.recovery_policy` is where that
judgement lives, because it is a property of the **workflow**, not of the
platform:

| Policy | |
|---|---|
| `safe` *(default)* | continue, unless an indeterminate step could have reached outside FlowForge (HTTP, email, Slack, a sub-workflow, a gate somebody may already have answered) |
| `resume` | always continue — for a graph whose steps are idempotent, which only its author can know |
| `manual` | never; record the loss and let a person decide |

### The escape hatch: a key the far side recognises

`safe` as stated is blunt: it blocks on anything externally-effectful, which is
the wrong answer for most endpoints workflows actually call. Stripe, Adyen,
GitHub, Shopify and most payment and provisioning APIs deduplicate on an
**`Idempotency-Key`**. A workflow whose charge node calls one of those never
needed a person.

FlowForge cannot make a third party idempotent. It can send the header the third
party is waiting for, and an HTTP node that declares `idempotent` does
(`services/stepIdempotency.js`). `safe` then blocks on an indeterminate step
whose **repeat is unsafe**, rather than on anything that reaches outside — which
is the distinction that actually matters.

**Only where the key is actually sent.** The declaration is refused outright on
a node type whose runner cannot send it — an email has no header a receiving
mail server deduplicates on, a Slack webhook post has none either, and a
sub-workflow's effects belong to the callee, where a flag on the calling node
cannot reach them.

That restriction is the load-bearing half, because the recovery policy reads the
same flag. Without it, `idempotent: true` on an email node was granted the
exemption while its runner sent nothing — turning *stop and ask a person* into
*send the email again*. A declaration a runner cannot honour is not a weaker
guarantee than none; it is a false one, and it is believed. The keyed types are
asserted in the test suite rather than read from the code, so adding one without
teaching its runner to send the header fails there first.

The linter warns about such a declaration **from the raw flag**, deliberately
not through the predicate the runtime uses. Asking the runtime's predicate would
make the linter agree there is nothing to report, and the setting would sit in
the config doing silently nothing — which is how somebody goes on believing it.
The runtime ignoring a declaration and the author being told about it are two
different jobs.

**What the key is derived from is the whole design.** It must be the same for
every attempt at one logical step and different for a genuinely new request,
which rules out every obvious candidate:

| Candidate | Why not |
|---|---|
| the execution id alone | two HTTP nodes of one run collide |
| … plus the attempt number | a retry becomes a new request — the one thing this prevents |
| … plus a timestamp or random value | the same problem, more expensively |
| … plus a digest of the resolved config | a retry after a rotated secret changes the key |

What is left is `(logical run, node)`, and *logical* is the interesting half. A
resume or a recovery creates a **new** execution row pointing back at the one it
continues, so the key is derived from the **root** of that chain. A recovered run
presents the key its predecessor did — the only way the far side can recognise
the repeat. A fresh webhook delivery has itself as its root and gets a different
key, because it *is* a different request.

The value is a truncated SHA-256 rather than the ids themselves, for the reason
the step cache hashes rather than stores: it is sent to a third party, and an
internal execution id is not something to hand out.

Three details follow shapes the engine already has. The declaration is read from
the **raw** config, like `onError` and the cache policy, because whether a
request is safe to repeat is a static fact about the endpoint rather than
something a payload decides. The header is computed in the engine and handed to
the runner through `ctx`, exactly as `traceparent` is — and an explicitly
configured header always wins, for the same reason. And the linter guards the
declaration in both directions: on a node that cannot send the header it is
worse than untidy, because recovery *acts* on it; on a GET it is merely
redundant.

It is a claim FlowForge cannot verify, which is precisely why it is a per-node
declaration and not an inference.

### Four things it deliberately does not do

- **It does not recover an unleased run.** A `running` row with no lease is
  either a nested child — covered by its parent's recovery — or a run from
  before leases existed. Concluding that a wait-callback parked for six hours is
  a corpse would be far worse than the bug being fixed.
- **It does not restart.** The lost run is finalised `failed` and a *new* run
  continues it, so history keeps both: what was lost, and what was done about
  it.
- **It does not recover forever.** `recovery_depth` rides onto each
  continuation, so a run that reliably kills its worker stops after
  `EXEC_MAX_RECOVERIES` attempts — the same one-line guard [error-handler
  workflows](./ARCHITECTURE.md#error-handler-workflows) use against chains.
- **It does not overwrite a run that settled underneath it.** The finalising
  UPDATE is guarded on the row still being `running`, so a worker that came back
  and finished properly wins the race.

---

## What you see

| | |
|---|---|
| Run history | the lost run is `failed`, its open step `indeterminate` (striped in the timeline — every other status there is a fact, and this one is the absence of one) |
| Activity feed | `execution.recovered`, carrying the worker that vanished and the steps whose outcome is unknown |
| Live canvas | an `exec-update`, so a watching tab sees the run settle rather than spin |
| `/metrics` | `flowforge_executions_recovered_total{outcome}` — a rising total with the label mix unchanged is an infrastructure problem, a rising `failed` alone is a workflow problem |
| Run settings | the policy, with its consequence spelled out rather than left to the option's wording |

---

## Configuration

| Variable | Default | |
|---|---|---|
| `EXEC_LEASE_TTL_MS` | `45000` | how long a lease stays credible without renewal |
| `EXEC_RECOVERY_INTERVAL_MS` | `30000` | how often the sweep looks |
| `EXEC_MAX_RECOVERIES` | `2` | how many continuations one run may accumulate |

The TTL is the one worth thinking about: long enough that a stop-the-world
pause or a slow disk does not read as a death, short enough that a genuinely
dead worker's runs are recovered while somebody still cares. Renewal runs at a
third of it, so two consecutive renewals can be lost to a hiccup before anything
concludes the worker is gone.
