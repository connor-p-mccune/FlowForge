# FlowForge architecture

A deep dive into the design decisions behind FlowForge. The
[README](../README.md) covers what the product does and how to run it; this
document covers **how it works and why it's built this way**. File paths are
relative to `flowforge/`.

Companion references: [EXPRESSIONS.md](./EXPRESSIONS.md) (the expression
language), [TYPES.md](./TYPES.md) (static types over the canvas),
[POLICIES.md](./POLICIES.md) (policy as code), [LINEAGE.md](./LINEAGE.md) (data
lineage and taint), [GUARANTEES.md](./GUARANTEES.md) (path invariants),
[PATHS.md](./PATHS.md) (path feasibility and generated tests),
[DURABILITY.md](./DURABILITY.md) (leases and crash recovery),
[PREVIEW.md](./PREVIEW.md) (replaying a change against past runs),
[PROVENANCE.md](./PROVENANCE.md) (signed workflow artifacts),
[MERGE.md](./MERGE.md) (three-way merge),
[RELEASES.md](./RELEASES.md) (progressive delivery),
[ROLLBACK.md](./ROLLBACK.md) (compensating transactions),
[INSIGHTS.md](./INSIGHTS.md) (run statistics), and [API.md](./API.md) (the
public API).

- [The execution engine](#the-execution-engine)
  - [Compensating transactions](#compensating-transactions)
- [Real-time collaboration](#real-time-collaboration)
- [Jobs and reliability](#jobs-and-reliability)
  - [Surviving the worker](#surviving-the-worker)
- [Schedule backfill](#schedule-backfill)
- [Outbound webhooks](#outbound-webhooks)
- [Run insights & SLA monitoring](#run-insights--sla-monitoring)
- [Progressive delivery](#progressive-delivery)
- [The expression language](#the-expression-language)
- [The type system](#the-type-system)
- [Policy as code](#policy-as-code)
- [Static analysis (the linter)](#static-analysis-the-linter)
  - [Callback liveness](#callback-liveness)
  - [Path invariants (workflow guarantees)](#path-invariants-workflow-guarantees)
  - [Path feasibility (the branch nothing can reach)](#path-feasibility-the-branch-nothing-can-reach)
- [Run cost accounting and budgets](#run-cost-accounting-and-budgets)
- [The tamper-evident audit log](#the-tamper-evident-audit-log)
- [Security architecture](#security-architecture)
- [Observability](#observability)
- [Persistence](#persistence)
- [Testing strategy](#testing-strategy)

---

## The execution engine

`server/src/services/executionEngine.js` is the heart of the system: it turns
a canvas graph into a run.

### Ready-set scheduling, not a sequential walk

The graph is first validated with Kahn's algorithm (`dagParser.js`) — if a
topological order doesn't exist, the graph has a cycle and the run fails
before any node executes. But the engine does **not** execute that order
sequentially. Instead it runs a ready-set scheduler:

- A node becomes *ready* once **every** upstream node has settled
  (succeeded / failed / skipped).
- Ready nodes whose upstream edges are all inactive are **skipped
  immediately** — and because a skip settles the node, skips cascade through
  dead branches synchronously, without occupying an execution slot.
- The remaining ready nodes launch concurrently, bounded by
  `EXEC_MAX_PARALLEL` (default 4; `1` restores strictly sequential order).
- When nothing can launch, the scheduler awaits `Promise.race` over the
  in-flight set and re-runs the round when any node settles.

An edge is *active* when its source succeeded — and, for branching nodes,
when the edge's handle matches the branch the node took. That one rule covers
condition (`true`/`false`), approval (approved/rejected), the **switch** node
(the matched case's label, or `default`), and the **validate** node
(`valid`/`invalid`): each settles a `result` string and the engine activates the
outgoing edge whose `sourceHandle` equals it, so multi-way routing and a
schema gate needed no new scheduling concept — only their types added to the set
the activation check treats as branching. A join node's input is the merged
output of all of its active upstream edges, so a diamond's two branches
genuinely run in parallel and merge at the join.

### Failure semantics

On the first node failure the scheduler stops launching, lets in-flight
siblings **settle and record their results** (they are never torn down
mid-call — an HTTP request that was already sent should record what
happened), then marks everything unlaunched as skipped and fails the run
with the originating node's error. Node-level retries (exponential backoff,
`EXEC_MAX_ATTEMPTS`) happen inside the node's slot; sub-workflow and
for-each nodes get a single attempt because they run whole nested executions
that already retry their own nodes — retrying the wrapper would duplicate
side effects.

### Per-node error handling

That default — any failure fails the run — is right for a data pipeline and
wrong for a notification step, so each node can override it with an
`onError` policy applied **after** its retries are exhausted:

- **`fail`** (default): exactly the semantics above.
- **`continue`**: the node settles `{ failed: true, error: { message, nodeId,
  nodeType } }` as its output and the run proceeds down its normal edges —
  the failure becomes data a downstream condition can route on.
- **`branch`**: the node grows a dedicated `error` source handle, and a
  caught failure activates *only* the edge wired to it, while a success
  keeps it dark. This reuses the sourceHandle mechanism every branching node
  already routes through — no second routing system — but inverted: the
  handle is selected by *how the node settled* rather than by a result value.

Three details are load-bearing. The step records a distinct **`caught`**
status with both the error message and the error output: the node genuinely
failed, and a timeline that relabelled it "succeeded" would lie to whoever
debugs it later (caught steps also count as executed for critical-path
analysis — a handled failure consumed wall time). The policy is read from
the node's **raw config, not the templated one**, so upstream data can never
decide routing. And branching node types (condition, switch, validate,
approval) plus triggers are excluded — they already settle a routing result,
and a second mechanism on the same node would make an edge's meaning
ambiguous; the engine ignores a policy on them and the linter says so.

A policy/wiring mismatch is statically visible, so the linter closes the
loop: an `error` edge whose source policy isn't `branch` is an error (that
branch can never run — and the engine guarantees a stale error edge never
activates on success), while a `branch` policy with nothing wired to the
error handle warns that a caught failure silently ends the flow.

### Error-handler workflows

Per-node policies are the *recovery* path inside a run; for runs that still
die, `services/errorHandler.js` provides the *escalation* path — a workflow
can designate another workflow (`error_workflow_id`) to run whenever one of
its real, top-level runs fails, with the failure context as the trigger
payload. Escalation is thereby just another workflow: page someone, file a
ticket, roll something back — same canvas, same nodes, same run history.

The design leans on decisions already made elsewhere:

- **The hook sits in the execution worker**, beside the SLA monitor — the
  same "top-level, settled, real run" contract that falls out of *where* the
  call lives rather than needing flags. Both worker paths (a run the engine
  failed, and a run the worker itself crashed on) fire it, and it is
  best-effort throughout: a broken handler can never touch the failed run's
  own record.
- **The loop guard is one line.** Handler runs are recorded with
  `trigger_type: 'error-handler'`, and failures of such runs never fire a
  handler — any chain caps at depth one, even a workflow (via a stale
  reference) configured to handle itself. The settings route additionally
  refuses self and cross-workspace references because they're almost
  certainly mistakes.
- **Eligibility mirrors sub-workflow targets** (same workspace, deployed),
  checked again at fire time because settings age. The handler's own
  concurrency policy is respected — a reject-at-cap handler skips a firing
  exactly like a schedule tick at the cap.
- **The error payload is the failed step's persisted row** (`{ nodeId,
  nodeType, message }`) — the engine stores no run-level error column, and
  the step row is already secret-redacted, so the handler workflow can't
  learn anything the run detail wouldn't show.

### Compensating transactions

Per-node policies are the recovery path *inside* a run and error handlers are
the escalation path *after* it; neither reverses anything the run already did.
`services/compensation.js` plus the engine's rollback pass add the saga
pattern's unwind, and the whole design follows from refusing to invent a second
execution model for it.

A compensation is **a node with a field set** (`compensates: <node-id>`). The
engine strips those nodes before `buildAdjacency` — the same list that drops
sticky notes — so they never enter the topological order, never get a step row,
and never launch on the happy path. Everything an author already knows about
nodes (config, templates, secrets, the linter, the type checker, the test
bench) therefore applies to them unchanged.

Three engine details carry the semantics:

- **`execution_steps.completed_seq`** is stamped when a runner returns, for
  successes, caught failures and hard failures alike. It records the run's real
  completion sequence, which the DAG cannot: with `EXEC_MAX_PARALLEL > 1`,
  independent branches interleave, and unwinding in an order the run never
  happened in can release a resource a later step still holds. It also does
  double duty as a fact rather than a rule — the column is non-null exactly when
  *this run performed that node's work*, so `cached` and `reused` steps (whose
  effects belong to an earlier run that still owns them) are excluded from
  rollback by the same data that orders it.
- **The pass runs after the terminal status is written and published.** The run
  failed; that is not contingent on how well the cleanup goes, and a watcher
  should see `failed` → compensations → verdict in that order.
- **It is sequential and failure-tolerant.** One compensation at a time, because
  the failure mode is a half-undone state rather than slowness; and a
  compensation that exhausts its retries is recorded while the unwind continues,
  because stopping would strand the compensations *further back*, which guard
  the earliest and most expensive effects. The run settles `partial`.

`executeRollback` is a plain function over explicit inputs precisely because it
has two callers with different provenance for the same arguments: the engine
hands it the live in-memory context, and `rollbackExecution` (behind
`POST /executions/:id/rollback`) reconstructs an equivalent one from the
persisted steps hours later. Both go through one body, so the automatic and
manual paths cannot drift. The manual path re-reads the *graph* (a repaired
compensation is the reason it exists) but uses the *persisted, redacted* step
outputs as its data scope, exactly as resume-from-failure does — so a secret an
API echoed back during the run does not survive into a compensation's config.

See [ROLLBACK.md](./ROLLBACK.md).

### Cooperative cancellation

`POST /api/executions/:id/cancel` flips a `cancel_requested` flag on the run
row. The scheduler polls the flag once per round — i.e. every time a node
settles — and winds down exactly like a failure, except the terminal status
is `cancelled`. Cancellation is deliberately **inter-node**: a node in
flight always finishes, because interrupting a half-sent email or HTTP call
would leave the outside world in an unknown state. A run cancelled while
still queued is finalized by the route itself, and the worker drops the job
when it sees the terminal status — so cancel wins the race against pickup.

### Templates, secrets, variables, and redaction

Node configs reference upstream outputs as `{{node-id.field}}`, workspace
secrets as `{{secrets.NAME}}`, and workspace variables as `{{vars.NAME}}`.
Three properties matter:

1. **No evaluation.** Template resolution is a pure lookup — there is no
   `eval`, `new Function`, or `vm` anywhere in the server.
2. **Secrets never enter the context.** They are decrypted (AES-256-GCM,
   `secretVault.js`) into a map that exists only for the duration of config
   resolution — a secret can flow *into* a node's config but never rides
   node outputs into a later node's persisted input.
3. **Everything persisted is redacted.** A redactor built from the run's
   secret values (including their JSON-escaped forms) scrubs step
   inputs/outputs, published events, and error messages — so a secret echoed
   back by a third-party API still never lands in the database or the UI.

**Variables are the deliberate opposite of secrets.** `{{vars.NAME}}` values
resolve through the same scope (they ride beside `secrets` and `callbacks`,
never through node outputs), but they are plain configuration: readable
through the API, editable in a UI page beside Secrets, and *not* redacted —
a run log that showed `••••••` where the base URL should be would hide
exactly the data you're debugging with. The split keeps both guarantees
sharp: everything in secrets is encrypted and scrubbed, everything in
variables is visible and diffable, and the linter checks `{{vars.*}}` names
against the workspace just like `{{secrets.*}}`. Because the step cache
hashes the *resolved* config, editing a variable naturally invalidates any
cached step that used it — the same argument that makes secret rotation
safe.

### Human-in-the-loop approvals

An approval node pauses a run until a person decides, using the same
cooperative pattern as cancellation: state lives in a database row, and the
engine polls it. The runner inserts a pending `execution_approvals` row,
notifies every workspace member, and re-reads the row until someone responds
(`POST /api/approvals/:id/respond`), the run is cancelled, or the wait passes
its deadline. The verdict then routes the graph through the **same
sourceHandle mechanism condition nodes use** — approval outputs
`result: true/false`, so the engine needed one generalized check, not a
second branching system.

Three details are load-bearing:

- **The row is the only synchronization point.** Responder and runner never
  share memory; the pending→settled transition is guarded inside the UPDATE
  (`WHERE status = 'pending'`), so a response racing another responder — or
  racing the runner's own timeout — resolves to exactly one winner, and the
  loser is told what the verdict was.
- **Approval nodes get a single attempt** (like sub-workflow and for-each):
  a retry would file a duplicate approval request.
- **A cancelled run settles its gate.** The runner polls `cancel_requested`
  alongside the approval row and marks the request `cancelled`, so the inbox
  never accumulates orphaned entries; the engine's own cancel check then
  winds the run down before anything downstream launches.

Timeouts default to taking the rejected branch — "nobody approved" is
usually an answer, not an outage — with an opt-in `fail` mode for gates
where silence must stop the world. Dry runs auto-approve so test mode never
blocks on a human.

### Machine-in-the-loop callbacks

The wait-callback node is the same gate pattern pointed at a machine: the
run pauses until an external system POSTs to a one-time URL
(`/api/callbacks/:token`), then routes down the `received` or `timed-out`
branch with the delivered JSON as its output. It reuses everything approval
proved out — the database row as the only synchronization point, the
runner's poll loop, status-guarded UPDATEs so exactly one settle wins,
cancellation retiring the wait — with one problem approval doesn't have:
**the other side needs the URL before the node runs.**

An async job API wants the callback address *in the request that starts the
job*, which an upstream HTTP node sends — but the wait node hasn't executed
yet. So the engine arms every wait-callback row (and mints its token) **at
run start, before anything executes**, and exposes the URLs to template
resolution as `{{callbacks.<node-id>}}` — a reserved scope entry beside
`secrets`, never part of node output. Arming up front also closes the
inverse race: a reply that beats the runner to the node lands on the
`armed` row and is stored; the runner adopts it the instant it arrives at
the node instead of losing it. Delivery is first-wins (a duplicate gets
`409` and cannot overwrite the payload), an expired or retired token gets
`410`, and the engine closes out leftover `armed`/`waiting` rows at every
terminal path — a token dies with its run. The endpoint is deliberately
anonymous: the unguessable per-run token is the credential, exactly the
badge-token model, rate-limited like the public webhook trigger.

### Resume from failure

A failed or cancelled run can be **resumed**: a fresh execution points back at
the source run (`resumed_from_execution_id`), and the engine adopts the source
run's succeeded step outputs — those steps are marked `reused` and their
runners are never invoked — so only the failed remainder re-executes. An
approval gate that was already granted is not asked twice.

The interesting problem is deciding *when* a recorded output is still valid.
The rule is a freshness invariant enforced at schedule time: a node's prior
output is reused only while its inputs cannot have changed — every succeeded
upstream must itself have been reused, and skipped upstreams re-skip
identically because the condition/approval nodes that routed them are reused
with their original `result`. The moment any node actually re-executes
(including a node edited or replaced since the source run, which has no
matching prior step), everything downstream of it re-executes too. Reuse
therefore spreads exactly as far as the source run's healthy prefix and no
further, with no special cases per node type.

Two deliberate consequences:

- **Reused nodes settle synchronously, like skips** — they never occupy an
  execution slot, so the healthy prefix replays in one scheduling pass
  regardless of the parallelism cap.
- **The adopted output is the persisted (secret-redacted) value.** A secret
  echoed back by a third-party API in the source run was scrubbed before it
  ever reached the database, so it does not survive a resume — a downstream
  node that needs the raw value re-executes. Persisting secrets to make
  resumes byte-perfect would be the wrong trade.

Node identity (id + type) is what matches steps across runs; config edits
don't invalidate reuse on their own — like replay, a resume runs the current
definition, and the UI warns when the workflow changed since the source run.

### Step-level result caching

Resume reuses outputs *within a lineage of runs*; the step cache
(`services/stepCache.js`) generalizes the idea *across* runs: a node that
opts in (`config.cache.enabled`) memoises its output under a
**content-addressed key** — a SHA-256 over the node's type, its fully
resolved config (templates and secrets substituted, the cache block itself
excluded), and its merged input, scoped by workflow id. A later run whose
node would do byte-for-byte the same work adopts the recorded output (step
status `cached`) and never invokes its runner — settling **synchronously,
like a skip or a resume reuse**, so a hit never occupies an execution slot
and a fully-cached prefix replays in one scheduling pass.

Content addressing is the entire invalidation story. There is no "stale
cache" state to reason about: change the config, an upstream output, or a
referenced secret and the key changes with it, so the old entry simply stops
being found (and ages out via its TTL — bounded to [1s, 24h], default 300s,
with lazy delete-on-read plus a bulk prune in the retention sweep). Hashing
the *resolved* config is what makes secret rotation safe — a response
fetched with the old credential can never be served against the new one —
and a one-way hash means the key betrays nothing about the secret. The
serialisation is key-order-stable, so two configs that differ only in
property order hash identically.

The boundaries mirror decisions made elsewhere in the engine:

- **Only re-runnable types are cacheable** (HTTP, transform/filter/map/
  aggregate, the AI nodes). Side-effect actions are excluded — a cache hit
  on an email node would silently not send — as are branching/waiting nodes
  and sub-workflows. The policy is read from the **raw config, like
  `onError`**, so upstream data can't toggle it; the engine ignores cache
  config on ineligible types and the linter says so (including the nudge
  that a cached POST doesn't post).
- **The stored value is the persisted (redacted) serialisation** — the exact
  trade resume makes, for the same reason: a secret echoed back by an API
  must not outlive the run that saw it.
- **Only clean successes are memoised.** A `caught` failure is data, not a
  result worth replaying, and dry runs bypass the cache both ways —
  simulated outputs must not poison it.
- **Cache faults degrade to a miss.** A run that would have succeeded can
  never fail because memoisation hiccuped.

Effectiveness is observable: `flowforge_step_cache_events_total` counts
hits/misses/stores on `/metrics`, the run settings panel shows live entries
and their reuse count with a manual clear (`DELETE
/api/workflows/:id/cache`) for the one case content addressing can't see —
the upstream *data* changed behind an identical request.

### Sub-workflows and for-each

A sub-workflow node runs another workflow synchronously through the same
engine, linked to the parent via `parent_execution_id`/`parent_node_id` so
the run detail view can reconstruct the full call tree. Cycles are rejected
up front by carrying the workflow-id call stack through the engine context.
Workspace boundaries are enforced at the runner (a sub-workflow always runs
in its parent's workspace), which is what lets `GET /api/executions/:id`
authorize the whole tree with a single membership check. For-each fans a
workflow out over a list sequentially — deliberate, because iterations
usually hit the same external API — with a cap (`FOREACH_MAX_ITEMS`) and an
opt-in continue-on-error mode.

### Critical-path analysis

Because the scheduler runs independent branches in parallel, a run's
wall-clock time isn't the sum of its steps — it's the longest
dependency-respecting chain of them. `services/criticalPath.js` recovers that
chain with the classic **critical path method**: a longest-path search over the
run's *executed* subgraph, each node weighted by its step's recorded duration.
Kahn's algorithm gives a topological order, a single DP pass computes the
longest path to each node, and a back-pointer walk reconstructs it source →
sink. `GET /api/executions/:id` returns it and the timeline highlights it.

The subgraph is exactly the steps that ran — `succeeded`, `failed`, or `reused`
— and edges whose *both* endpoints ran. That framing makes the tricky cases
fall out for free: a condition's dead branch was skipped, so it's absent and
its edges drop; a failed run's path ends at the failing node because everything
downstream was skipped; a resumed run's reused prefix contributes zero-duration
links that keep the chain connected without inflating it. Like the timeline (and
like replay/resume), it reads the run's recorded steps against the workflow's
*current* edges, so a graph edited since the run simply contributes fewer edges
rather than lying — and a cycle introduced by such an edit yields an empty path
instead of a wrong one. The payoff is a direct answer to "what do I optimise?":
shortening a step that isn't on the path cannot make the run finish sooner.

---

## Real-time collaboration

Socket.io connections authenticate in the handshake (JWT verified before any
handler is registered) and join per-workflow rooms after a membership check.
Within a room:

- **Edits merge through a CRDT.** See below — the server is the convergence
  point rather than a relay. Cursor positions are the one thing still relayed:
  they are ephemeral, lossy by nature, and a dropped frame corrects itself on
  the next mouse move.
- **Execution events ride Redis pub/sub.** The engine publishes
  `exec-update` events; the Socket.io layer relays them to the workflow's
  room. This decouples the worker from connected sockets — the run publishes
  identically whether zero or ten people are watching.
- **Undo/redo converges rather than forks.** History is snapshot-based
  (debounced, bounded at 50 entries). Applying a step diffs the target
  snapshot against the live graph and broadcasts each difference through the
  same channel as live edits — so peers apply the undo as ordinary
  operations through the same merge. The trade-off is explicit: remote edits are part
  of local history, and undoing past them reverts them everywhere.
- **Self-healing state.** Comments, notifications, and activity events are
  written to SQLite first and emitted live second; a missed emit heals on
  the next fetch because the row is the source of truth.

### Why the relay was not enough

The original design was a thin relay with last-write-wins on a wall clock: each
client stamped `Date.now()` on every change and dropped anything older than its
own last edit to the same element. That converges when it converges, and the
three ways it doesn't are all ordinary rather than exotic.

**Clocks.** Two browsers disagree by seconds. Whose laptop is fast is not a
defensible tiebreak for whose edit survives.

**Granularity.** The comparison was per *element*. One person changing an HTTP
node's URL while another changed its retry count meant one of them silently lost
everything they typed — which is precisely the case [MERGE.md](./MERGE.md) argues
is the common one and merges cleanly per field. The offline three-way merge was
strictly better at this than the live editor, which is a strange thing for a
collaborative product to be true of.

**Repair.** A dropped connection produced permanent divergence. Rejoining the
room subscribed to *future* changes and reconciled none of the missed ones, so
two canvases stayed different until somebody pressed reload and never knew why.

### The data type

`services/graphCrdt.js` models a graph as two maps of elements, each element
being an **existence register** (present/absent) and a **field map** — one
register per `position`, `data.label`, `config.url`, and so on. Every register
is ordered by `(lamport, site)`: a Lamport clock, so causality rather than wall
time decides, with the site id breaking the ties Lamport clocks leave. Together
that is a *total* order over concurrent writes, which is what makes the merge
deterministic rather than merely usually-right.

Two properties follow, and they are the whole point:

- **Commutative.** `max` over a total order does not care what order it sees its
  arguments in, so applying the same operations in any permutation yields the
  same document. No causal delivery, no buffering, no vector clocks — an
  operation that arrives before the one it logically follows still lands
  correctly, because it wins or loses on its timestamp either way.
- **Idempotent.** Re-applying an operation changes nothing (a strict `>`
  comparison, never `>=`), so an at-least-once transport needs no dedupe layer.

Because a CRDT's claim is a property rather than an example, it is tested as
one: the convergence suite generates an operation set, applies **every**
ordering — or thirty random ones for the large set — and asserts a single
document comes out.

**It is deliberately not an OR-Set**, and the difference is visible to users: a
concurrent edit does not resurrect a node somebody deleted. On a canvas, a node
reappearing with half its config merged from an edit made against the version
that was deleted is worse than a lost edit, and undo exists while "why is this
node back" does not have an answer anybody can act on.

One thing fell out of testing rather than out of reading the code. `materialize`
followed Map insertion order, so two replicas holding *provably identical*
documents serialised into different arrays — the set converged and the artefact
did not. That artefact is what gets persisted and then compared by drift
detection and the three-way merge, so it is now sorted by id: the stored graph
is a pure function of the operation set, and "the file differs" can only mean
the graphs differ.

### The server is the convergence point

Clients send operations; the server merges them and broadcasts the **resulting
element**, not the operation. Every replica therefore converges on a value the
merge produced instead of each re-deriving one, and the client never needs the
merge algorithm at all.

That split is a judgement about what a replica is here. A browser tab is a view
that can be closed at any moment; the server is the durable replica. So the
authoritative document lives there, which buys two things a peer-to-peer
arrangement could not: a session's work survives every tab closing, and a
reconnecting client can be *told* what it missed.

What the client does keep is the clock, because a timestamp has to be assigned
when an edit is **made** — including while offline. Operations made during an
outage are queued, flushed on reconnect *before* the delta is requested (so the
reply already accounts for them), and merged at the position in the order they
actually occupy rather than at the back, where a naive resend would clobber
whatever happened meanwhile.

A losing writer gets a separate reply. It applied its operation optimistically,
so if the registers refused it, that client is the one replica holding a value
the merge rejected — diverged on precisely the edit it cared most about. The ack
carries the winning element back.

### Repair, and why it is a state delta

`services/collabSession.js` keeps a bounded log of **which elements changed at
which sequence**, not of the operations themselves. A reconnecting client
reports its position and receives the *current value* of everything touched
since.

A state delta is the weaker mechanism and the right one here: it is correct
however far behind the client is, it cannot double-apply, and its size is
bounded by the number of distinct elements edited rather than by how long the
client was away. A node dragged across the canvas produces hundreds of
operations and exactly one log entry. When the log no longer reaches back far
enough the answer is a snapshot rather than an error — the bias is deliberate,
because guessing wrong here does not produce an error, it produces two canvases
that disagree forever.

A **session epoch** makes a stale position explicit rather than plausible. A
restart, or a merge that invalidated the document, begins a new epoch, and a
client still holding "I was at 7" resyncs in full instead of being handed a
delta into state that no longer exists.

Sessions persist on a debounce, when the last collaborator leaves, and on
SIGTERM — so editing outlives the tab that produced it rather than depending on
the client's own debounced save having fired before it closed. A merge or a
version restore **invalidates** the session instead of flushing it: that
document describes the state *before* the write, and flushing it would undo the
merge.

---

## Jobs and reliability

Runs execute in a Bull worker (Redis-backed) running in-process with the
API. Two levels of concurrency compose: `EXEC_CONCURRENCY` (default 10) is
how many *runs* the worker processes at once; `EXEC_MAX_PARALLEL` is how
many *nodes* of one run execute concurrently. better-sqlite3's single
synchronous connection serializes writes, so concurrent runs interleave
safely at `await` points.

Replays re-run the workflow's **current** definition against the original
run's persisted trigger payload (`trigger_data`) — matching how a redeploy
affects future runs — and a replayed dry-run stays a dry-run, so re-running
a test can never fire real side effects.

### Surviving the worker

Everything else in this section bounds what a *running* system does. Retries
bound a flaky call, the circuit breaker bounds a dead host, compensations undo
what a failed run already caused, graceful shutdown drains a planned stop. All
of them assume the process survives the run, and when it does not — an OOM
kill, a node evicted mid-deploy — the execution row says `running` forever: the
timeline never finishes, the badge never flips, insights count the run as
neither success nor failure, and the only cure is somebody noticing.

`services/executionLease.js` and `services/crashRecovery.js` close that, plus a
second failure hiding in the same place. Bull re-delivers a job whose worker
stopped reporting progress — exactly what an at-least-once queue is supposed to
do — and running the engine again on that job would insert a fresh step row per
node and execute the whole graph a second time, re-sending the email and
re-charging the card. The full treatment is
[DURABILITY.md](./DURABILITY.md); the load-bearing decisions:

- **The lease is renewed by a timer, not by the scheduler.** A run parked on an
  approval gate makes no progress for hours by design, so renewal riding on a
  node settling would make the most legitimate wait in the product look exactly
  like a crash. A timer separates "this process is alive" from "this run is
  advancing", which are different facts — and a dead process runs no timers,
  which is the whole mechanism.

- **It carries a fencing token, not just an owner.** A worker stalled long
  enough to lose its lease can come back, still holding every in-memory
  variable it had, so the token is compared *inside* every write that decides
  the run's outcome. This is Kleppmann's argument, and the reason checking
  first is not enough: a check is only true until it isn't. The engine
  additionally reads its own token once per scheduling round and stops
  launching when it no longer holds it — cooperative and inter-node, like
  cancellation, because tearing down a half-sent HTTP call is worse than
  letting it finish into a run nobody is watching.

- **Acquisition requires the run not to have started**, which is the single
  condition that makes a duplicate delivery inert whether the first worker is
  alive (its lease is live) or dead (recovery owns that case). Restarting a
  half-done graph is never the right recovery; continuing it is.

- **`indeterminate` is a real step status, and refusing to resolve it is the
  design.** A step that was `running` when the process died is not failed — the
  request may well have been received — and not succeeded, because nobody
  recorded a result. Recording it as `failed` invites a retry that
  double-charges; recording it as `succeeded` invites a resume that skips work
  that never happened. It is the one status the engine never writes during a
  normal run.

- **The continuation is resume-from-failure, unchanged.** Reusing it rather
  than inventing a second mechanism is what stops a recovered run and a
  hand-resumed one from drifting, including the freshness rule that reuse stops
  at the first node which actually re-executes. An indeterminate step is not
  succeeded, so it re-executes — right for a Transform and unacceptable for a
  charge, which is why `workflows.recovery_policy` exists: the judgement is a
  property of the workflow, not of the platform.

- **Idempotency keys make that judgement precise rather than blunt**
  (`services/stepIdempotency.js`). An HTTP node whose author declares the
  endpoint deduplicates sends an `Idempotency-Key`, so `safe` blocks on a step
  whose *repeat* is unsafe instead of on anything that reaches outside. The key
  is derived from `(logical run, node)` and *logical* is the whole point: a
  resume or a recovery points back at the run it continues, so the key comes from
  the **root** of that chain and a recovered run presents the key its predecessor
  did — the only way the far side can recognise the repeat. Not the attempt
  number, not a timestamp, not a digest of the resolved config: each of those
  makes a retry a *new* request, which is the one thing this prevents. Read from
  the raw config like `onError`, handed to the runner through `ctx` like
  `traceparent`, and hashed rather than sent raw because an internal execution id
  is not something to hand a third party.

- **The boundaries mirror decisions made elsewhere.** A run with no lease is
  never recovered (a nested child is covered by its parent, and deciding a
  six-hour wait-callback is a corpse would be worse than the bug); the lost run
  is finalised rather than restarted, so history keeps both what was lost and
  what was done about it; `recovery_depth` bounds the chain exactly as the
  error-handler loop guard does; and the finalising UPDATE is guarded on the row
  still being `running`, so a worker that came back and finished properly wins
  the race.

### Per-workflow concurrency limits

A workflow can cap its active runs (`max_concurrent_runs`) and pick what
happens at the cap (`concurrency_policy`: `queue` parks the run, `reject`
refuses the submission with a 409). Enforcement is deliberately two-layered,
each layer where its data is accurate:

- **`reject` is checked at enqueue** (`services/concurrencyGate.js`), by
  counting pending + running rows — synchronous in better-sqlite3, so two
  submissions racing through one process can't both slip under the cap. The
  caller finds out immediately: API and webhook submissions get a 409, and a
  schedule tick at the cap is *skipped*, which for a cron workflow is exactly
  the "don't overlap the previous run" behavior the limit asks for.
- **The cap itself lives at worker pickup**, as an in-process counter. The
  worker runs in-process with the API, so the counter is exact and race-free
  — and unlike counting `running` rows, it can never be wedged by a stale
  row left behind by a crash. A run at the cap is re-parked with a short
  delay (`CONCURRENCY_RETRY_MS`) instead of holding a Bull slot hostage, and
  `flowforge_runs_deferred_total` counts every re-park so saturation is
  visible on the dashboard.

Two invariants: an **accepted run is never dropped** (a `reject` workflow's
run that slips past the enqueue check in a race simply waits like `queue`),
and **idempotent trigger retries keep working at the cap** — the replay
lookup runs before the admission check, so a retried request whose original
landed still gets its original run back instead of a spurious 409. Dry runs
are interactive and exempt throughout. Sub-workflow child runs execute
inside their parent's engine loop, not through the queue, so limits apply to
top-level runs — which also means a workflow calling itself through a gate
can't deadlock.

### Rate limiting

The concurrency cap answers "how many runs at once?"; the rate limit
(`rate_limit_max` over `rate_limit_window_seconds`) answers a different
question — "how often may runs *start*?" — and the two are genuinely
independent: a workflow whose runs each finish in 50ms never trips a
concurrency cap of 1, yet a schedule misconfigured to fire every second, or a
webhook sender that batches, can still bury a downstream API in requests. Rate
limiting is the knob for that.

The implementation is deliberately small because it lives at the same chokepoint
the concurrency reject already uses. `admitRun` now runs two checks in
sequence — concurrency, then rate — so every entry point (manual, public API,
webhook, schedule, replay, resume, error-handler escalation) is covered by one
function call, with no per-route logic. Three properties make the count honest:

- **The window slides by `created_at`.** The check counts a workflow's runs
  created within the trailing window — no buckets to reset, no window-edge
  spikes, just "how many in the last N seconds" evaluated continuously.
- **It counts exactly what was admitted.** A refused submission inserts no
  execution row, so the count reflects runs that actually started, never
  attempts. Dry runs carry `trigger_type = 'dry-run'` and are excluded, like
  they are from the concurrency count — an interactive test must not eat the
  production allowance.
- **The two fields travel together.** A max without a window (or vice versa) is
  meaningless, so the route enforces both-or-neither after resolving the update
  against the stored row, and the panel clears both when the max is emptied.

An over-limit submission is a `409` at the door (a webhook sender reads it as
"back off", exactly like the concurrency reject) and increments
`flowforge_runs_rate_limited_total`, so a workflow that's constantly bumping its
ceiling is visible on the dashboard rather than silently shedding load. A
dedicated `(workflow_id, created_at)` index keeps the window count cheap on a
busy instance.

### The pause kill switch

Concurrency limits shape *how many* runs overlap; pause
(`services/workflowPause.js`) answers a blunter operational question — *stop
everything now*. A `paused_at` column is the whole state: while it's set, no
new real run starts at any entry point. The design leans on structure rather
than a scatter of new checks:

- **One predicate, every door.** `isPaused(workflow)` is checked at each entry
  point right beside the concurrency admission it already runs — the manual and
  public-API triggers (a 409, the kill switch beating the cap because "stop"
  outranks "you're full"), replay and resume, the webhook trigger, the schedule
  tick, the error-handler escalation, and the **sub-workflow call**. The two
  silent, unattended paths (webhook, schedule) additionally record
  `flowforge_paused_skips_total` by source, because there the counter is the
  *only* witness that traffic hit a closed door; the interactive paths told
  their caller directly.
- **The door that is easiest to forget.** The sub-workflow call is not a route
  and has no request to refuse, so it was the one entry point the switch did
  not cover — and it is the one that matters most, because a *shared* workflow
  gets most of its traffic from callers rather than from its own trigger.
  Pausing the utility that is melting a downstream API stopped the trickle and
  left the flood, and reported `completed` while doing it. That is worse than
  having no switch: somebody believed they had pulled it.

  The call now fails the calling node, which is what the neighbouring
  not-deployed check already did. Skipping it instead would produce a run that
  omitted half its work and finished green — a lie the error branch never gets
  to handle. Dry runs stay exempt, the same exemption every other gate makes.
- **Two boundaries are deliberate, not incidental.** In-flight runs settle
  normally — tearing down a half-sent HTTP call is exactly what pause is *not*
  for; that's cancellation, and even that is cooperative and inter-node. And
  dry runs stay allowed at every gate, because pause is what you hit *during*
  an incident and the person who hit it needs to test the fix — blocking their
  test runs would make the switch fight its own use case. Test scenarios
  (which run dry) keep working for the same reason.
- **Idempotent by construction.** Pause and resume are safe to slam twice: the
  first pause wins the `paused_at`/`paused_by` audit trail (a repeat doesn't
  rewrite it), and resuming an active workflow is a no-op. Nothing skipped
  while paused is retroactively fired on resume — the next natural trigger just
  works — so a weekend-long pause doesn't unleash a thundering herd of
  backfilled runs when it lifts.
- **Idempotent triggers still win the race.** The public trigger's
  idempotency-replay lookup runs *before* the pause check, so a retried request
  whose original landed a moment before the pause still gets its original run
  back rather than a spurious "paused" 409 — the same ordering that protects
  retries at the concurrency cap.

The switch composes cleanly with the other admission controls, each answering a
different question and none needing to know about the others: **pause** holds
*all* runs, the **concurrency cap** bounds *simultaneous* runs, the **rate
limit** bounds *how often* runs start, and **priority lanes** order *pickup*
among the runs that are admitted.

### Scheduled maintenance windows

`services/maintenanceWindow.js` is the pause switch on a timer: a workflow with
a window (`maintenance_cron` marks each start, `maintenance_duration_minutes`
how long it stays open) is auto-paused while the window is open and resumed when
it closes. It's a monitor in the heartbeat mould — a background sweep, because
there's no event to hook: "a window opened" is the passage of time, not an
action. Each pass reconciles two booleans, *is now inside a window* and *is the
workflow paused*, and drives one from the other.

The interesting piece is "is now inside a window", and it falls out of the cron
engine for free. A window is the half-open interval `[start, start + duration)`.
`nextRun(cron, from)` returns the first fire *strictly after* `from`, so asking
it for the first fire after `now − duration` yields the candidate start `S` with
`now − duration < S`; the workflow is inside a window exactly when `S ≤ now`.
The strict-after boundary is precisely what makes the interval half-open — a
window that ended at exactly `now` (its start sat at `now − duration`) is not
re-reported, so it correctly reads as closed. All UTC, like the schedule
preview, so the answer doesn't depend on the server's clock zone.

Two rules keep the sweep from fighting an operator, and both hang off the
`paused_reason` column the pause switch now records:

- **It only resumes its own pauses.** Auto-resume fires only when
  `paused_reason = 'maintenance'`, so a person who pauses a workflow during a
  window still has it paused after the window lifts — the human decision
  outranks the schedule.
- **It never double-pauses.** Auto-pause fires only when the workflow isn't
  already paused, so a manual pause taken inside a window is left exactly as the
  operator set it, reason and all.

One loose end is closed explicitly: clearing a workflow's window while it still
holds a maintenance pause would strand it — the sweep no longer sees the row to
resume it — so the settings route releases a maintenance pause the moment its
window is removed. Transitions emit distinct `workflow.maintenance_started` /
`workflow.maintenance_ended` activity events (attributed to "the scheduler" in
the feed, like monitor events), and the monitor reconciles once at boot so a
window spanning a restart takes effect immediately instead of after a full
interval.

### Priority lanes

Every run enters the queue in one of three lanes — `high`, `normal`
(default), `low` — mapped to Bull priorities (`services/runPriority.js`).
Resolution is two knobs deep: an explicit per-trigger override (API body,
public-API `?priority=` query param — a query param because the entire body
is the trigger payload — or `flowforge trigger --priority`) beats the
workflow's `default_priority` column, which beats `normal`. Priority orders
**pickup only**: Bull dequeues high before normal before low and stays FIFO
within a lane, and nothing preempts a run already executing — lanes decide
who goes next, never who gets interrupted.

The edges hold the design together: dry runs always ride the high lane
(someone is watching the canvas — an interactive test stuck behind fifty
bulk imports defeats its purpose); replays and resumes inherit the original
run's recorded lane (`executions.priority`, also surfaced on run summaries)
rather than re-resolving it; webhook, schedule, and error-handler runs take
their workflow's default — escalation urgency is the handler author's call;
and a re-park at a concurrency cap carries the Bull priority forward, so
deferral never silently demotes a high-lane run. An invalid explicit lane is
a 400 at the door, while an invalid *stored* default quietly resolves to
`normal` — a corrupt row must not break runs.

### Fairness between workflows

Priority orders runs *between* lanes. Within a lane Bull is FIFO, and that is
a hole a single workflow can drive through: five thousand runs from one
webhook sender caught in a retry loop, or a for-each fan-out over a list that
grew, puts five thousand jobs at the head of the lane, and every other
workflow's **next** run waits behind all of them. Nothing is broken — the
concurrency cap, the rate limit and the priority are all respected. One tenant
simply has the queue.

`services/fairShare.js` answers the second question, and it is a different
question. The rule is **max-min fairness** — what deficit round robin
approximates — expressible in a sentence:

> You may start a run unless you are already more than `burst` runs ahead of
> the workflow that has had the fewest, in which case you wait for them.

- **Judged within a lane.** The load-bearing scoping decision: a high-priority
  run must never wait on a normal-priority one, because they are not competing
  for the same thing. The worker recovers the lane from the Bull priority the
  job was enqueued with (`runPriority.levelOf`), since by pickup time that is
  the only place it survives.
- **Free when uncontended.** The comparison is against workflows *actually
  deferred recently*. With one workflow running, that set is empty and the
  check passes trivially. A fairness control that taxed an idle system would
  be a latency regression sold as a feature — and a contender set that only
  grew would eventually make every workflow look starved by one that went
  home, so entries age out with the window.
- **Never drops work.** An unfair job is re-parked through exactly the
  mechanism the concurrency cap uses, carrying its lane forward.
- **Never becomes starvation.** A job deferred past `FAIR_SHARE_MAX_DEFERRALS`
  is admitted regardless. A queue that is perfectly fair and never runs your
  job is worse than one that is unfair; the bound makes the worst case a delay
  rather than a hang.

Two ordering details. The fairness check runs **before** the concurrency cap,
because it is the cheaper refusal and a job held for fairness has not taken a
slot it would then have to give back. And a start is recorded only once the
run is genuinely starting, so a run turned away by the cap does not spend its
workflow's share of a queue it never entered.

In-memory per process, like the metrics registry and the retry budget. A
fair-share counter that needed consensus between workers would be a
distributed systems problem bolted onto a scheduling heuristic; each worker is
fair about the traffic it is deciding. `DISABLE_FAIR_SHARE=true` turns it off.

---

## Outbound webhooks

Event subscriptions (`services/eventDispatcher.js`) push workspace activity
events to external URLs. The design piggybacks on two systems that already
existed rather than inventing new ones:

- **The event stream is the activity feed.** `activityService.logEvent` is
  already the single funnel every significant action flows through, so the
  dispatcher hooks there — one line — and subscriptions automatically cover
  every current and future event type, with patterns (`execution.failed`,
  `workflow.*`, `*`) mirroring the feed's own families. Coalesced feed
  bursts deliver once, because the coalesce path returns before the hook.
- **The queue is a SQLite table, not memory.** Each matching event inserts
  an `event_deliveries` row; a poller drains due rows and reschedules
  failures with exponential backoff (5 attempts). A restart loses nothing —
  pending deliveries and their retry schedule are just rows. Delivery is
  therefore at-least-once, and the delivery id is deliberately stable
  across retries and manual redeliveries so consumers can deduplicate.
- **Signing reuses `webhookSignature.js`.** Outbound deliveries carry the
  same timestamped HMAC scheme the inbound webhook trigger verifies, so one
  documented verification snippet serves both directions.
- **Subscription URLs are SSRF surface.** They are user-supplied addresses
  the server will POST to from inside the network, so delivery goes through
  the same `safeFetch` as HTTP nodes (scheme + private-range checks per
  redirect hop), and the routes reject blocked URLs at creation time for a
  friendlier failure than a delivery that can never succeed.

---

## The outbound circuit breaker

`services/circuitBreaker.js` wraps every server-side fetch of a
user-supplied URL. The problem it solves is amplification: when a host goes
down, each affected node retries three times, each retry waits out a
connect timeout inside an execution slot, and the webhook dispatcher burns
its five-attempt budget against the same dead receiver — the failure of one
external system degrades throughput for everything else. The breaker
converts that into a fast, honest failure.

- **State machine per host** (`hostname:port`): after N consecutive
  failures the circuit *opens* and calls fail immediately with an error
  naming the host and the retry horizon; after the cooldown, exactly one
  call becomes the *half-open probe* (concurrent callers keep fast-failing
  while it's in flight) — success closes the circuit, failure re-opens it
  for a fresh cooldown.
- **One integration point.** It wraps `safeFetch` (the SSRF guard), which
  is already the single egress path shared by the HTTP node, the Slack
  node, and outbound webhook deliveries — so every consumer is protected
  without any of them knowing the breaker exists. The breaker only
  observes: a 5xx response still reaches the caller; 4xx counts as a
  success because it says nothing about host health.
- **Interplay with the retry layers is the point.** Node-level retries
  against an open circuit fail in microseconds instead of holding a slot
  through three stacked timeouts, and the webhook dispatcher's exponential
  backoff reschedules on the fast failure — both layers keep their
  semantics, they just stop paying for a host that's already known-dead.
- **Bounded and observable.** The tracked-host set is capped (evicting the
  oldest entry — hosts are user-supplied input, so unbounded growth is the
  threat), `flowforge_circuit_trips_total` counts opens, and a scrape-time
  collector reports `flowforge_circuits_open`. Like the SSRF guard, it is
  skipped under `NODE_ENV=test` unless a suite opts in, because the test
  suites deliberately hammer failing local servers.

## The retry budget

`services/retryBudget.js` sits beside the breaker and answers the case the
breaker structurally cannot.

The breaker triggers on *N consecutive failures*. The failure mode that
actually takes services down never produces those. A host under strain fails
**some** requests — every failure is retried, retries are extra load on
something already struggling, more load means a higher failure rate, which
means more retries. A service at 90% success and recoverable ends at 40% and
not, and the circuit is closed for the entire descent, because the host kept
answering. The retries were the outage.

- **A ratio, over a window, per host.** Retries may be at most ~10% of the
  requests going to a host in the last minute. That bounds how much of a
  struggling dependency's load is FlowForge retrying it, which a count could
  not: ten retries against a thousand requests is nothing and ten against
  forty is a problem, and only the ratio distinguishes them — or stays
  meaningful as traffic grows.
- **One denominator, shared.** Requests are counted in `safeFetch`, the same
  single egress path the breaker wraps, so an HTTP node's calls, a Slack
  node's, and the webhook dispatcher's all land in one budget per host. The
  host experiences one total load; a budget per caller would be three budgets
  and no bound at all.
- **It suppresses the retry, never the request.** The first attempt always
  goes out — nothing is ever refused work it was asked to do. The run fails
  with the *real* error, a little sooner, and the suppression note is
  **appended** to that error rather than replacing it: "the API returned 503"
  is the cause and "we did not try again" is only why it stopped there.
- **A floor under the ratio.** 10% of three requests is 0.3 retries, i.e.
  none, forever — a workflow that fires once an hour would never retry
  anything. That is not a bound on cascading failure, it is a broken retry
  policy, so a constant allowance keeps the budget engaged only where there is
  enough traffic for a ratio to mean anything.
- **Narrow scope, deliberately.** Only node types whose purpose is to call a
  URL are budgeted. A Transform node's retry costs a millisecond of CPU and
  cannot cascade; a cascading-failure control in front of it would be theatre.
- **The dispatcher defers rather than discards.** A node retry has nowhere to
  wait — the run is in flight, and the alternative to retrying now is failing.
  A webhook delivery has a durable queue and an attempt budget of its own, so
  over-budget means "not yet": the next attempt is pushed out a full window,
  which costs the receiver nothing and loses no event.

Suppressions land on `flowforge_retries_suppressed_total`, and the enforcement
switch mirrors the breaker's for the same reason.

## Run insights & SLA monitoring

`services/runStats.js` turns recorded run history into statistics, and
`services/slaMonitor.js` acts on them. The full treatment is in
[INSIGHTS.md](./INSIGHTS.md); the load-bearing decisions:

- **Robust, not classical, outlier detection.** "Was this run abnormally slow?"
  is asked over a heavy-tailed distribution, where a classic z-score's mean and
  standard deviation are dragged toward the very outliers you're hunting — the
  outlier inflates its own yardstick. The monitor uses the **modified z-score**
  (Iglewicz & Hoaglin): median and median-absolute-deviation, whose ~50%
  breakdown point means half the sample can be pathological before the baseline
  moves. It carries the documented mean-absolute-deviation fallback for the
  MAD = 0 case and is one-sided (only *slower* is an alert). `runStats.js` is a
  pure function of number arrays, so the panel, the CLI, the public API, and the
  monitor all share exactly one implementation and can't drift.

- **The hook lives in the worker, not the engine.** SLA evaluation runs once,
  after a run settles, from the execution worker — which only ever processes
  top-level runs (sub-workflow child runs execute inside the parent's engine
  loop). So "top-level, settled, real run", precisely the monitor's contract,
  falls out of *where* the call sits rather than needing a flag, and the engine's
  hot scheduling loop stays untouched. Every path is best-effort: monitoring a
  run can never fail the run.

- **Edge-triggered success-rate alerts.** The rolling success-rate check alerts
  on the run that *crosses* the floor, not on every run while degraded — it
  compares the window ending at this run against the window ending just before
  it and fires only on the transition. The previous window *is* the prior state,
  so there's no "already alerted" flag to keep and reconcile.

- **Reuse the existing fan-out.** A breach is an `execution.sla_breached`
  activity event (which the outbound-webhook dispatcher already relays to
  subscribers) plus an owner notification — the same two surfaces a failed run
  uses. No third alerting channel was invented.

- **The forecast reuses the critical path method, run forward.**
  `runForecast.js` estimates a run's duration *before* it happens by weighting
  the current graph with each node's *expected* step time (p50/p95 from history)
  and taking the longest path — the same algorithm `criticalPath.js` runs over a
  finished run's observed times. It's a worst-case over branches (a static graph
  can't know which branch fires) with a coverage ratio as its confidence signal.
  Critical-path analysis is retrospective; the forecast is the same math pointed
  the other way.

### SLO error budgets and burn rates

The SLA monitor above alerts on a run being bad, or on a success rate crossing a
floor. Both share a blind spot: they treat every failure as equally urgent. A
workflow with a 99% objective is **allowed** to fail 1% of the time — that
allowance is precisely why one chooses 99% instead of 100% — so alerting on
every dip pages someone for failures the objective already budgeted for, and
alert fatigue finishes the job.

`services/sloBudget.js` makes the allowance explicit. Over a rolling window, a
99% objective across 1,000 runs permits 10 failures, and the interesting
question stops being "did a run fail?" and becomes **"how fast are we spending
the budget?"**:

```
burn rate = observed failure rate ÷ allowed failure rate
```

A burn rate of 1 exhausts the budget exactly at the end of the window, which is
what an objective *means*. A burn rate of 14.4 exhausts a 28-day budget in under
two days.

**Why two windows.** This follows the multi-window, multi-burn-rate approach
from Google's SRE Workbook, and the two-window part is the design rather than a
detail:

- A **short** window alone is jumpy. Ten failures in five minutes is an enormous
  burn rate and usually nothing — a deploy, a blip, a dependency that recovered
  on its own.
- A **long** window alone is slow. An outage burning 5% of the budget per hour
  runs for many hours before a 28-day average notices.

Requiring **both** to exceed the threshold gives fast detection with far fewer
false alarms: the short window supplies urgency, the long window supplies
confirmation that it is not noise. Two tiers then separate severity — 14.4× over
1h confirmed by 6h (page), 6× over 6h confirmed by 3d (ticket). The constants
are the Workbook's and they are derived, not chosen: `14.4 = 0.02 × (28 days ÷
1 hour)`, i.e. exactly the rate that consumes 2% of the window's budget within
the alerting period.

Five decisions carry the rest:

- **A target of 1 is refused at the door.** "Never fail" has no error budget,
  which makes every burn rate a division by zero. It is not an objective, it is
  a wish — and the validation says so rather than storing it and producing
  `Infinity` downstream.

- **Too few runs returns `null`, never `0`.** "We are healthy" and "we don't
  know" are different answers, and collapsing them into zero is how a dashboard
  ends up confidently green during an outage that hasn't accumulated a sample
  yet.

- **Cancelled runs count as neither good nor bad.** A person stopping a run is
  an intervention, not a service failure. Charging it to the budget would
  penalise exactly the response you want during an incident — the same reasoning
  the public status page uses for excluding them.

- **The exhaustion projection uses the sustained window, not the fastest.** An
  estimate built on the jumpiest measurement would swing between "fine" and "two
  hours left" from one run to the next, which is not a number anyone can act on.
  And an already-exhausted budget gets **no** projection: a number there invites
  reading it as time remaining.

- **Budget is reported in runs, not only as a percentage.** "10 failures left
  this window" is a quantity an operator can reason about and plan against; "4%
  consumed" is a number they have to convert first.

The objective is deliberately independent of `sla_min_success_rate`. That is a
floor that alerts the moment it is crossed; this budgets for failure and alerts
on the *rate of spend*. A workflow may sensibly declare either, both, or
neither, and clearing the target clears its window with it so a later objective
cannot inherit forgotten config — the rule the maintenance window and the rate
limit already follow.

### Heartbeat monitoring

`services/heartbeatMonitor.js` covers the failure mode everything above is
blind to: **runs that stop happening at all**. The SLA monitor hooks a run
settling — but a schedule that was silently unregistered, a webhook sender
that was decommissioned, or a dead upstream cron box produces no run to hook.
A workflow that declares `heartbeat_interval_minutes` promises "a real run of
me completes successfully at least this often", and the monitor alerts when
the promise is broken. Three decisions:

- **Absence can't hook a run, so this is the one monitor that sweeps.** A
  background timer (default every minute) walks the deployed workflows with
  an expectation set and compares last-success age against the interval —
  one indexed query per workflow, all best-effort.

- **Edge-triggered through a single column.** `heartbeat_alerted_at` records
  the outstanding alert; while set, sweeps stay silent — a weekend outage is
  one `workflow.heartbeat_missed` event, not one per minute. A success newer
  than the alert clears it and emits `workflow.heartbeat_recovered`, so a
  consumer (typically a Slack channel via outbound webhooks) sees a close
  for every open. There is no separate alert store to reconcile: the column
  *is* the state, it survives restarts, and changing the interval resets it
  — the old alert answered the old promise.

- **A never-run workflow measures silence from its latest deploy** — the
  moment its schedule went live is the moment the promise started, and
  `workflow_versions` already records it. Drafts have made no promise and
  are skipped; dry runs and failed runs don't count as heartbeats (a test
  is not production behaviour, and a failing workflow that runs on time is
  the *SLA monitor's* case, not this one's).

Alerts reuse the existing fan-out — activity feed (which outbound webhooks
relay) plus an owner notification — and `flowforge_heartbeats_missed_total`
counts crossings on `/metrics`.

## Progressive delivery

`services/canary.js` addresses a gap the rest of the system makes conspicuous.
Every control described above bounds a *deployed* workflow's behaviour —
concurrency, rate, spend, pause — and none of them bounds the risk of the
deploy itself. A deployed workflow executes its **live graph**, so editing the
canvas of something in production changes production immediately and
completely. There was no gradual anything.

The user-facing reference is [RELEASES.md](./RELEASES.md); the decisions:

- **The arms are chosen so that rollback costs nothing.** While a canary runs,
  stable traffic executes a **pinned version snapshot** and canary traffic
  executes the **live canvas**. That is the whole design: stable is already on
  the baseline, so rolling back is `percent = 0` — no graph moves, no canvas is
  overwritten under an author's cursor, and the edits survive for whoever has to
  fix them. The obvious alternative (canary = a snapshot, stable = the live
  graph) makes rollback a graph restore, which is destructive, racy against a
  concurrent edit, and much harder to make idempotent.

- **Promotion is an ordinary deploy**, snapshot and all, because the live canvas
  is exactly what the canary was proving. The canary module takes the deploy
  route's snapshot function as an argument rather than growing a second copy of
  it.

- **The engine change is one branch.** `runExecution` already read one graph per
  run; it now reads a *version's* graph when the execution row names one, and
  records which arm the run belonged to. Everything downstream — scheduling,
  retries, tracing, cost — is untouched.

- **The verdict is inferential, not threshold-based.** A canary is a small
  sample, and a threshold on a small sample is a coin flip with a UI. "3 failures
  out of 40 versus 20 out of 380" is a 42% higher rate and it is noise; a
  one-sided two-proportion test says so. Durations go through Mann-Whitney U
  rather than a mean comparison because run times are right-skewed with a long
  retry tail — precisely the shape that lets one bad afternoon claim
  significance. Rates are reported with a Wilson interval, because "0 failures in
  12 runs" is not "certainly 0%" and a canary panel is exactly where someone
  would act on that.

- **Both directions wait for evidence.** Auto-promoting on a rate that merely
  looks fine is the same error as auto-rolling-back on one that merely looks
  bad, so `wait` is a first-class verdict rather than a fallback. The one
  exception is deliberate: every canary run failing is not a subtle signal, and
  waiting for the twentieth costs twenty broken runs.

- **Four verbs, because "stop the canary" means three different things.**
  Promote, roll back (traffic to zero, edits preserved, resumable by ramping),
  and abandon (the canvas serves everything again) have genuinely different
  consequences; collapsing them would make the destructive one the default.
  Adjust is separate because ramping 5% → 25% → 50% is how a release normally
  progresses and must not discard the accumulated sample.

- **Assignment is random per run**, not hashed. A workflow's runs have no stable
  identity to hash — a schedule tick is not a user — and independent samples are
  exactly what the tests assume.

- **The boundaries mirror decisions made elsewhere.** Dry runs never enter the
  experiment (test mode exists to try the edits); a resumed run inherits its
  source's assignment, because adopting recorded step outputs into a different
  definition would be incoherent; a deleted baseline degrades to "no experiment"
  rather than failing runs; and both starting and promoting pass the policy gate,
  since 99% of traffic to the live canvas is a deploy.

One correctness detail is worth recording because it was found by a test rather
than by reasoning: durations are rounded to the millisecond before ranking.
`julianday()`'s subtraction leaves sub-microsecond floating-point dust that
varies with the absolute date, and the two arms necessarily occupy different
time ranges — so unrounded, a rank test could read that dust as a systematic
ordering and call a slowdown where the runs were identical.

---

## The expression language

`services/expression/` is FXL — a small language the engine evaluates against a
scope to power the condition node's expression operator and the Filter node's
predicate. A rules editor needs real logic (`amount > 1000 && status in
["pending", "review"]`), but the project's first security rule is that no user
input reaches `eval`, `new Function`, or `vm` anywhere in the server. FXL is how
those two demands coexist: it's a hand-written interpreter, not an escape hatch
into the host. The user-facing reference is
[EXPRESSIONS.md](./EXPRESSIONS.md); this is the how-and-why.

The pipeline is the textbook three stages, each a small file:

- **Lexer** (`lexer.js`) scans the source into tokens. Hand-rolled because the
  grammar is small enough that a scanner is a few `switch` statements, and it
  keeps the interpretation of user input off any regex-driven or generated path.
- **Parser** (`parser.js`) is a Pratt / precedence-climbing parser producing a
  plain-object AST. Pratt parsing puts operator precedence in one table instead
  of a cascade of grammar rules, which is why the whole language stays under a
  few hundred lines with no parser-generator dependency. The AST is JSON-able,
  so a compiled program can be cached or inspected.
- **Evaluator** (`evaluate.js`) walks the AST against a scope object.

Three decisions are load-bearing:

- **Explicit operator semantics.** `==`, the relational operators, and `+`
  don't defer to JavaScript's own coercions — they're defined in the evaluator
  (numbers compare numerically, objects/arrays structurally, `+` concatenates
  only when a side is a string, arithmetic throws on non-numeric input). A rule
  therefore behaves identically every run regardless of the JS engine under it,
  and none of JS `==`'s stranger corners leak into a user's mental model.
- **First-order, function-only.** There are no methods on values, no `this`, no
  globals, and no lambdas. Calls resolve only against a vetted stdlib
  (`functions.js`) of pure helpers; identifiers resolve only against the scope
  the caller passes in. That's the whole reason the evaluator can never reach a
  host method — `payload.constructor` or `"x".toUpperCase()` doesn't even parse
  (`Only named functions can be called`). The cost is no `map`/`filter` taking a
  callback; the Filter and Map nodes live *outside* the language for exactly
  that reason — each drives one FXL expression per item, so iteration stays in
  the engine (bounded, observable) and the language stays a pure expression.
- **Bounded and prototype-safe.** Member access refuses `__proto__` /
  `prototype` / `constructor`; a per-evaluation step counter and a
  recursion-depth cap stop a crafted expression from monopolising a worker; and
  the parser rejects a pathologically large AST up front.

Integration is deliberately thin. The condition runner and Filter runner both
`compile` once and evaluate against a per-call (or per-item) scope, so a Filter
predicate over a thousand-item list pays the parse cost a single time. Because
FXL reads live values from its scope rather than substituting `{{…}}`, the
engine's template resolver leaves an expression untouched (it contains no
placeholders), and the two reference styles coexist without either having to
know about the other. The same module also exposes `analyze()` — a parse plus an
AST walk for unknown function calls — which is what lets the linter flag a
broken expression statically (next section). And because the evaluator is a pure
function of `(ast, scope)` with no side effects, the authoring UI can expose it
directly: `POST /api/expressions/evaluate` runs the very same pipeline against
caller-supplied sample data, so the canvas's "Try this expression" playground
computes exactly what a node would — no separate interpreter to drift.

---

## The type system

The canvas is a dataflow graph, and every runner in `services/nodeRunners/`
returns a shape it guarantees. Nothing wrote that down, so the two most common
authoring mistakes were invisible until a run made them expensive: a reference
to a field that doesn't exist (`{{http-1.bdy}}`, which resolves to empty string
and quietly poisons whatever consumed it) and an expression that computes
nonsense against the data it will actually see (`amount * customer`).

Three modules answer that: `services/types.js` is the vocabulary,
`services/typeInference.js` recovers the graph's types, and
`services/expression/typecheck.js` checks FXL against them. The user-facing
reference is [TYPES.md](./TYPES.md); this is the how-and-why.

### The lattice, and why `unknown` is not `any`

Types are plain JSON objects — `unknown`, `any`, the four primitives,
`array<T>`, an object with per-field optionality and an `open` flag, and
normalised unions. Inspectable, cacheable, and sendable to the client, exactly
like the FXL AST.

The distinction that carries the design is between `unknown` ("the analysis has
nothing to say" — a sub-workflow's return value) and `any` ("dynamic by
contract" — a parsed HTTP body). Both silence every check, so they behave
identically to a rule; they differ to a *reader*, and a schema panel that
collapsed them would be lying about which one it knows.

`unknown` is additionally the **neutral element of the join**, so one opaque
branch doesn't erase what the other branches proved. What it does contribute is
uncertainty: joining it against an object opens the object, because the branch
we can't see may carry fields we haven't listed.

### Member access has two meanings, and conflating them would be wrong

The engine's `{{a.b}}` resolver walks with plain JavaScript property access, so
`items.length` is a number. FXL's `readMember` refuses every non-integer key on
an array, so `items.length` is silently `undefined`. Both are correct in their
own context, so `lookup()` takes a mode — and the FXL case is exactly the sort
of bug nothing else in the product would ever surface, since it neither throws
nor logs; it just compares `undefined` and takes the wrong branch forever.

### Inference mirrors the engine rather than approximating it

The output table is **transcribed** from the runners. A schema that drifts from
what a node really returns converts the checker into a generator of false
alarms, which is strictly worse than no checker — so where a runner has two
shapes (a real call and a dry-run preview) the preview's keys are recorded as
optional rather than pretended away.

A node's input is `Object.assign` over its active upstream outputs, and
`mergeAssign` models that specifically:

- **Certainty is conditional on the target running.** A node with a single
  incoming edge always got that edge — if it is executing, that is how it got
  there — so its fields stay required even off a branch. One of several is
  certain only when it can never be dark, which is decided by a
  topologically-computed "does this node always run?" that the edge check reads.
- **The on-error policy changes the payload.** `continue` settles the engine's
  `{ failed, error }` object as the node's output and proceeds down the normal
  edges, so downstream sees the union; `branch` sends that object down the error
  handle only, leaving the normal handles carrying the normal shape. Each is one
  line here because it is one line in the engine.
- **A Transform node's template is a schema**, and the only one a user writes by
  hand. It is parsed and read as one: a value that is exactly `{{ref}}` keeps the
  referenced type (matching `resolveTemplates`, which preserves the value), and
  an interpolated one is a string.
- **A Map node's element type is whatever its mapping expression computes**,
  which comes straight back from the FXL checker — the two directions of the
  analysis feeding each other.
- **A sub-workflow's output is resolved across graphs.** The analysis recurses
  into the target workflow and applies the engine's own return rule, through a
  `resolveWorkflow` callback rather than a database import — `typeInference.js`
  stays a pure function of graphs, exactly as the policy engine's document
  builder does. The resolver (`services/graphLookup.js`) accepts only what the
  sub-workflow runner would accept, same workspace and deployed, because typing
  a node from a target the runner would refuse reports a shape the run can never
  produce — and the checker would then flag *correct* references against it. A
  cycle, a chain deeper than three levels, and an unresolvable target all report
  `unknown`: the first would be fiction (the engine rejects it at run time and
  the dependency analyser reports it statically), the second is work not worth
  doing on every keystroke, and the third is already the linter's finding in its
  own words.

### The checker is a synthesis pass, not an inference engine

`typecheck.js` walks the AST bottom-up: each node's type comes from its
children's, is checked against what the operator or function requires, and is
handed back up. There are no inference variables and no unification, because FXL
has no lambdas and no let-bindings — every expression's type is fully determined
by its leaves, so synthesis is the whole algorithm. Function *arity* is read from
the stdlib registry rather than restated, and a test pins that every stdlib name
has a signature, so the two cannot come to disagree.

### Silence is the design

Every rule begins at `possibleKinds`, which returns null for a dynamic type, and
any rule facing a null stands down. There is no finding when a value is `any` or
`unknown`, when an object is open, when a union still has a viable option, when
a node isn't wired up yet, or when the graph has a cycle (the linter already
reports that, and inference over a cycle would be fiction).

That restraint is what makes the feature usable rather than annoying. A checker
that occasionally cries wolf gets switched off within a week and takes its true
findings with it — so the failure mode here is always silence, never a maybe,
and the severity contract matches the linter's exactly: **error** for something
that will misfire, **warning** for something legal that computes what nobody
wanted (ordering two objects stringifies both to `[object Object]`, so every
comparison reports equal).

### What it replaced

The config panel's "insert data from upstream" list used to be a hand-maintained
table in the React component mapping each node type to the keys it emits — a
second copy of a truth that lives in the runners, and one that had already
drifted past switch, validate, filter, map, and aggregate. It now asks
`POST /workflows/:id/types` with the *live* canvas, which is both correct and
strictly more capable: field types, nested paths, and shapes that depend on
config rather than on node type.

---

## Policy as code

`services/policyEngine.js` (pure) and `services/policyGate.js` (the database
half) answer a question the linter structurally cannot. Lint asks *will this
run?*; a policy asks *is this allowed here?* — and the second question appears
the moment more than one person builds workflows in the same place. The
user-facing reference is [POLICIES.md](./POLICIES.md); the decisions:

- **Policies are FXL, not a bespoke rule format.** The workspace already has a
  safe expression language with a parser, a static analyser, a type checker, and
  an inline playground. A second rules dialect would need all four again and be
  worse at each of them, and every author who already writes conditions would
  have to learn it.

- **The document is pre-aggregated, because FXL has no lambdas.** Handing a rule
  the raw graph with no way to traverse it would make every real policy
  impossible, and adding closures to fix that would undo the property that makes
  the evaluator safe. So `buildDocument` flattens a workflow into the facts
  policies are written about — node types, hosts called, secrets referenced,
  declared limits, what its workspace has configured — and six [set and glob
  helpers](./EXPRESSIONS.md#sets--patterns) express the collection rules:
  `len(notMatching(httpHosts, allowed)) == 0` reads closer to the policy than the
  loop would have. `buildDocument` is a pure function of a workflow row plus a
  context object, so it is testable without a database and the gate stays a thin
  layer over it.

- **A rule is type-checked against the document's schema when it is saved.**
  This is where the type system pays for itself twice: `len(httpHost) == 0`
  (singular) would evaluate to `undefined`, report every workflow compliant, and
  never say a word — a control that is silently off is worse than no control, so
  it is refused at the door with a spelling suggestion. The schema is written out
  by hand rather than derived from a sample, because a sample workflow with no
  HTTP nodes would type `httpHosts` as `unknown[]` and lose exactly that check; a
  test holds the two together.

- **Evaluation fails closed**, for the same reason. A rule that throws at
  admission time is an anomaly (it was validated when stored), and the safe
  reading of an anomaly in a security control is "no".

- **Violations name their evidence.** A policy may carry a second expression,
  evaluated only on failure, whose value rides with the violation. "blocked:
  evil.example.net" is a finding someone can act on; "a host is not allowed" is a
  finding someone has to investigate.

- **One enforcement point, chosen deliberately.** Deploy is where a workflow
  becomes something the organisation runs, so that is where a `deny` refuses —
  with `422`, not `403`, because the caller *is* permitted to deploy and it is
  the document that is unacceptable. Restoring a version onto a *deployed*
  workflow publishes a graph without touching that button, so the gate is
  repeated there; a draft restore is unchecked, because refusing to load the
  definition someone needs in order to fix it would be backwards. Import reports
  rather than blocks (it lands a draft, and refusing it would keep a
  non-compliant definition permanently out of the environment where it could be
  repaired). Runs are not gated at all: a policy governs what may be published,
  and blocking a deployed workflow's runs would turn a governance edit into an
  outage — the pause switch and the budget are the controls for stopping traffic.

- **The limit is stated rather than glossed.** Saving the canvas of a deployed
  workflow does change what runs, and that path is *not* gated, because blocking
  every save would make the canvas unusable. It is covered by the Issues panel
  instead — which is also why policy findings render as lint issues rather than
  as a separate surface: an author should meet a policy problem while editing,
  not at the deploy button.

- **The starter library ships as templates, not built-ins.** Adding one copies it
  into the workspace where it can be edited. Every workspace's allow-list is its
  own, and a rule nobody can change is a rule nobody trusts — they would write a
  second one beside it instead.

One template rests on a small credential scanner: provider-prefixed literals
(`sk-`, `ghp_`, `xoxb-`, `AKIA`, …) and credential-shaped keys holding long
literal values, skipping anything containing `{{` because a secret reference is
precisely the behaviour being asked for. It is named as a heuristic in its own
comment, because its job is to say "put that in secrets", not to prove what a
string is.

---

## Static analysis (the linter)

`services/workflowLinter.js` inspects a graph without running it. Severity
is a contract: **error** means the run will (almost certainly) fail or
misfire — cycles, dangling edges, missing required config, references that
can never resolve, unknown secret names, undeployed sub-workflow targets, an
FXL expression that doesn't parse or calls a function the stdlib doesn't
define; **warning** means legal but probably unintended — unreachable branches,
half-wired conditions, references to nodes that aren't ancestors (which
resolve to empty at runtime).

The ancestor check mirrors the engine exactly: ancestor sets are built with
a topological pass, so the linter's idea of "upstream" and the engine's idea
of "resolvable" cannot drift apart. The lint route accepts the canvas's
live, unsaved graph and enriches it with real workspace context (secret
names, sub-workflow target status).

### Callback liveness

Every check above asks whether the graph is *well formed*.
`services/callbackLiveness.js` asks whether a run of it can make **progress**.

A `wait-callback` node parks the run until an external system POSTs to a
one-time URL. The engine mints that URL at run start and exposes it as
`{{callbacks.<node-id>}}`, so some node has to send it — and, as the runner's
own comment says, an **upstream** node. Nothing checked the "upstream".

Three ways to get it wrong:

| | `code` | |
|---|---|---|
| Nothing sends the URL at all | `callback-never-sent` | error |
| Only a node *downstream* of the wait sends it | `callback-deadlock` | error |
| The URL is only ever logged | `callback-never-sent` | error |
| A sender exists but does not run on every path there | `callback-may-not-be-sent` | warning |

The wait times out eventually — an hour by default, up to a week — so this is
not a hang. It is worse than a hang in one specific way: **the graph becomes
indistinguishable at run time from a partner system that never replied.** The
investigation starts at the partner, and the answer was on the canvas.

Two things make it precise rather than noisy:

- **Sending is a dataflow question, not a string search.** The commonest
  *correct* shape is a `transform` that builds the request body and an HTTP node
  that references it — the URL goes out and no HTTP node mentions `callbacks`
  anywhere. So the URL is followed forward through references, and the question
  is whether anything that reaches outside FlowForge carries it. That is the
  same node-type set the [effect report](./EFFECTS.md) is built on, reused
  rather than re-listed, which is also why a node that merely *logs* the URL
  does not count.
- **The path check is not dominance.** Dominance asks whether every path to the
  wait goes through the sender, which is the right question for a sequential
  engine and the wrong one here: independent branches run in parallel, so
  `t1 → send` beside `t1 → wait` executes both, and a dominance test would send
  somebody to fix a correct graph. What decides it is whether a **decision** can
  route away from the sender while still arriving at the wait — the same outcome
  partition [guarantees](./GUARANTEES.md) and
  [convergence](./CONVERGENCE.md) use.

### Dataflow analysis

`services/lineage.js` is a third lens over the same graph, and the split
between the three is deliberate: the linter reasons about **structure and
config**, `typeInference` about the **shape** of what flows, and lineage about
its **path and provenance**. Each is additive, each stays silent about what it
cannot prove, and none re-reports what another owns.

The pass gives every node two things — the *origins* its output can carry, and
the specific `{{node.path}}` references its config makes. Together those form a
second graph over the first, and both directions of it are questions the canvas
could not previously answer: what feeds this value, and what breaks if it
changes.

Three decisions do the real work, and all three are about **precision**, because
a finding that fires everywhere is worse than no finding:

- **Taint stops at an external boundary.** A node whose output is written by
  something outside the graph — an HTTP response, a model, a callback payload —
  carries that one origin and *not* the origins of anything it read. An HTTP
  node's `body` is the far side's answer, not a function of the URL it was asked
  for. Propagating there would mark most of a typical graph.
- **A pinned host is not SSRF.** Only a dynamic *authority* — everything before
  the first `/`, `?` or `#` after the scheme — lets a caller choose what the
  server connects to. `https://api.acme.com/orders/{{trigger.id}}` is how
  requests are supposed to be built and drops to the medium band rather than
  being reported. (Slack's webhook URL is exempt from the softening: there, the
  path *is* the credential.)
- **Dead computation needs a leaf.** The engine merges every active upstream
  output into a node's input, so a node mid-chain whose output nothing
  *references* is still being used. Only a node with no outgoing edge and no
  reader provably computed something for nobody.

A fourth decision arrived with the AI nodes, and it is the same argument one step
further along. Untrusted data reaching an LLM prompt is **not** a finding — it is
what an AI node in a workflow is *for*, and reporting it would fire on every one
of them. What is reported is the composition: an outsider writes the instructions
*and* the model's answer influences a high-sensitivity sink or a routing node.
That is the confused-deputy shape, and it is the only version of the question
that names a real problem rather than a design. Only `untrusted` origins count
(an HTTP response feeding a prompt is a third party's text, not an adversary's
choice of text), and a routing node counts through graph successors as well as
`{{…}}` reads — a condition in expression mode reads `label` off its merged input
and names nothing, so the read graph cannot see that edge. Bounded to *immediate*
successors, because that is exactly how far the engine's merge carries a value.

The containments that bound it live at the boundary rather than in the analysis —
a per-call random fence around untrusted text, and a classification confined to
the labels the author declared — so every AI node gets them without opting in.
See [SECURITY.md](../SECURITY.md) T19.

Impact analysis deliberately **does** cross the boundary taint stops at, and the
asymmetry is the point: taint asks who controls a value's content, impact asks
what a value participates in deciding. Changing a webhook field doesn't make the
response untrusted in a new way, but it does change which URL is called.

See [LINEAGE.md](./LINEAGE.md).

### Path invariants (workflow guarantees)

`services/dominance.js` + `services/guarantees.js` add a fourth lens, and it
differs from the other three along an axis none of them vary on. The linter,
the type checker and the lineage pass all answer questions about a **place** —
this node's config, this value's shape, this value's provenance. The question
somebody actually asks before deploying a workflow they didn't write is about a
**path**: *can this ever charge a card without the approval having been
granted?*

Nothing in the product could answer it, and the way it breaks is unremarkable.
A workflow runs `webhook → approve → charge`; somebody adds a manual trigger to
test it without posting a webhook and wires it straight at the charge. Every
node lints, every type checks, nothing is unreachable, no policy is violated —
and the approval became optional.

**The engine's semantics make the question decidable.** A node runs iff at least
one incoming edge activated, and an edge activates iff its source succeeded with
a matching handle (`activeIncomingFor`, above). So a node executed exactly when
some chain of active edges reached it from a source node, and every such chain
is a path in the graph. "B cannot run unless A ran" and "**A dominates B**" are
therefore the same statement — which turns an open-ended product question into
a fifty-year-old compiler problem. `dominance.js` solves it with Cooper, Harvey
& Kennedy's iterative algorithm rather than Lengauer-Tarjan: on graphs a canvas
produces it converges in two or three passes, and its entire state is one
immediate-dominator array that a person can read in a debugger. Speed was never
the constraint; explaining the output was.

Three declarable kinds, each a different classical analysis: `requires`
(dominance), `ensures` (post-dominance — "if this runs, that runs too"), and
`exclusive` (a decision separates them, so no run reaches both).

One structural idea carries all three. Most nodes fan out to *every* successor
at once; a **decision** is a node whose outgoing edges are split into groups of
which exactly one activates. Modelling that as an *outcome partition* rather
than as per-type special cases is what lets one check cover a condition, a
nine-case switch, a validate gate, an approval, a callback — and the per-node
error branch, which is the same two-way shape wearing different clothes and is
invisible to anything built around node types. A failed HTTP call jumping its
error branch straight to the charge is a real bypass, and it is caught by the
same code that catches the manual trigger.

Three details carry the precision:

- **Every source node is fed by a virtual entry**, because the engine starts all
  of them. That is what makes the second trigger a finding rather than an
  oversight.
- **The virtual exit is fed from every unwired outcome**, not only from sinks. A
  decision whose `false` branch dangles ends the run right there — the run
  completes, having simply stopped — and post-dominance computed without those
  edges would certify "every run that charges also audits" about a graph where
  it demonstrably doesn't. This is the most load-bearing decision in the module.
- **Notes and compensations are stripped**, by the same rule the engine strips
  them. A compensating Refund wired at the Charge node is not a path to the
  charge, and reporting it as one would make an author "fix" a correct graph.

And one that carries the trust: **`unknown` is never a pass.** Delete the
approval node and every invariant naming it stops failing, because there is
nothing left to violate. So a declaration naming a node that is no longer in the
graph reports `unknown`, and `unknown` blocks the deploy, fails `flowforge
verify`, and sets `ok: false` exactly like a violation. A guarantee whose check
silently stopped running is worse than no guarantee, because somebody is relying
on it.

Enforcement mirrors [policies](#policy-as-code) — checked at deploy, reported in
the Issues panel while editing, never applied to a run — for the same reason: a
governance check that can take production down is worse than the bug it looks
for. It differs in *whose* rule it is, which is why a violation is an error
rather than a warning: a policy is the organisation's rule about this workflow,
a guarantee is the author's own statement about their design, so breaking one is
a regression rather than a permission problem. Declarations travel with the
export document, because they reference the graph's node ids and a promotion
that dropped them would ship the workflow without the assertions that were the
reason it passed review.

See [GUARANTEES.md](./GUARANTEES.md).

### Path feasibility (the branch nothing can reach)

`services/constraints.js` (the decision procedure) +
`services/pathConstraints.js` (the translation) add a fifth lens, and it varies
from the other four along the axis they share: all of them reason about the
**graph**, and this one reasons about the **data**.

The case that makes the difference concrete is a switch case sitting below a
condition that already ruled it out. It is wired, it type-checks, the graph
reaches it, dominance agrees it is on a path, no policy is violated — and no
run has ever taken it, because the two conditions cannot both hold. The
question that sees it is not about a place or a path but about an input:

> is the conjunction of the branch conditions along a path satisfiable, and if
> so, by what?

That is a solver question, so there is a solver. The user-facing reference is
[PATHS.md](./PATHS.md); the decisions:

- **The fragment is chosen for its decision procedure, not its
  expressiveness.** Difference logic over the numbers, because satisfiability
  is negative-cycle detection in a constraint graph — Bellman-Ford — and the
  shortest-path distances *are* a model, so one classical algorithm answers
  both halves of what the caller needs. Finite domains over everything else.
  Free propositions for anything outside both, which constrain nothing yet
  still keep a validate gate's `valid` and `invalid` outcomes mutually
  exclusive without the solver knowing what a JSON Schema is — the same
  mechanism covering an approval, a callback, and a node's caught-failure
  branch.

- **The search is DPLL(T)-shaped rather than a CNF conversion.** Negation
  normal form, then depth-first over the disjunctions with a theory check after
  every literal. Checking eagerly is what makes the `default` outcome of a
  sixteen-case switch — the conjunction of sixteen negations — tractable
  instead of 2¹⁶ cubes; the first contradictory literal prunes the subtree
  rather than every leaf under it being rejected separately.

- **Every approximation is on the satisfiable side**, and that direction is the
  whole safety argument. A spurious *sat* costs a missing finding; a spurious
  *unsat* reports a live branch as dead and sends somebody to fix a correct
  workflow. So a comparison outside the fragment, a variable used as two sorts,
  and an exhausted budget all report `unknown`, a truncated report never claims
  a branch is dead, and an undecided branch marks its subgraph `unknown` rather
  than leaving it unvisited and reading as unreachable.

- **Variable identity follows the engine's two reference styles, because they
  genuinely differ.** `{{node.field}}` reads the whole run context and names
  its producer exactly; a bare identifier in an expression reads the *merge*,
  which is `Object.assign` over the node's **immediate predecessors** — a
  condition emits `{ result }`, so `amount` is not in scope below one however
  far upstream it was produced. The latter resolves through the inferred output
  types, and a field several predecessors could have written gets a variable of
  its own. Merging two variables that are actually different can manufacture a
  contradiction; splitting one that is actually the same can only lose a
  finding, so the rule is to split unless the graph proves otherwise. The one
  exception is the trigger namespace, merged because the engine's `baseInput`
  makes every trigger node emit the run's single payload.

- **The solver returns a model, so the analysis returns a test.** A witness
  turned back into a trigger payload is an input that provably drives a branch,
  which is what makes generating a workflow's test suite possible at all —
  `POST /workflows/:id/tests/generate` writes one scenario per drivable branch,
  each asserting the branch it covers (`steps["route"].result == "refund"`), so
  it fails the moment an edit re-routes it. Idempotent through a
  `workflow_tests.generated_for` column, and it never touches a hand-written
  scenario.

- **What cannot be covered is named rather than omitted.** Scenarios run in
  dry-run mode, where approvals auto-approve and callbacks report `received`,
  so an approval's rejected side is a real branch no generated test can drive.
  A witness likewise separates its payload from its *assumptions* — an upstream
  response's `status`, say — and generation refuses the ones that rest on one,
  because a scenario failing for a reason nobody wrote down is worse than a
  missing scenario. The coverage figure means nothing without that list.

- **A lint error, and deliberately not a deploy gate.** A dead branch is a
  defect, but it is a defect that has by definition never affected a run, so
  refusing a deploy over one would block a fix for an unrelated outage in order
  to complain about code that cannot execute. [Policies](#policy-as-code) and
  [guarantees](#path-invariants-workflow-guarantees) gate the deploy because
  their findings are about what *will* run.

### Deploy preview (replaying a change against past runs)

`services/backtest.js`. Every gate on a deploy above is **static** — the linter
on form, the type checker on shape, a policy on permission, a guarantee on the
author's invariants, path feasibility on reachability. All five are worth having
and none of them answers what the person about to press Deploy is actually
asking: *what would this change have done to last week's traffic?* A canary
answers it eventually, with real traffic and real consequences; this answers it
beforehand against traffic that already happened, with none.

The user-facing reference is [PREVIEW.md](./PREVIEW.md); the decisions:

- **The replay is not a dry run of the candidate graph.** A plain dry run
  answers an HTTP call with a "would send" preview, so a condition branching on
  `status == 200` behaves differently for a reason that has nothing to do with
  the edit — the comparison would report a difference for every run. Every node
  whose work reaches outside FlowForge is therefore settled from **the original
  run's own recorded output**, and what executes is exactly the graph's decision
  logic. That is what makes a routing difference attributable to the change,
  which is the only claim the feature makes.

- **The scope is stated rather than hidden.** It answers what the graph does
  with the same data, not what a different API returns: point an HTTP node at a
  new URL and the preview keeps the old response, because nothing here can know
  the new one. A preview that invented one would be worse than none, since its
  findings would look exactly like the true ones.

- **Two narrow engine options, both refused outside dry-run.** A graph to
  execute that the workflow does not hold, and canned outputs for chosen nodes.
  Making the guard structural rather than a rule is the same trade the node test
  bench makes one node at a time — the unsafe state is unrepresentable rather
  than forbidden.

- **The replays leave no trace.** Each execution row is deleted once its steps
  have been read, because a preview is a question and leaving fifty rows in run
  history every time somebody asks one would make run history useless — the
  opposite of what this exists for.

- **Behaviour changing is not a failure.** Most changes are meant to change
  something, so the gate reports and passes by default; `--strict` is for the
  promotion that claims to be inert, which a refactor or a config-only edit
  does. A gate that failed on every real change would be switched off in a week
  — the same argument that keeps the type checker silent about what it cannot
  prove.

One implementation detail is recorded because a hang found it rather than
reasoning. The scheduler inserts a launched task into `inFlight` *after* starting
it, which is safe only because every runner is `async` and awaited: a task body
that completed without yielding would delete its own entry before the entry
existed and spin the round loop on a settled promise forever. The first
stubbing implementation short-circuited the runner call and did exactly that, so
a stub is now expressed as a synthetic `stub` fault and travels the same path
every other node does.

### Breakpoints

`services/debugger.js` plus one hook in the scheduler. Everything else that
helps somebody understand a run is a **record** — the timeline says where the
wall time went, run comparison says what changed since Tuesday, lineage says
where a value came from. All of them answer after the fact, and none is any use
for the question that actually stalls somebody:

> why is this node about to send *that*?

The answer is a value assembled from six upstream outputs, two workspace
variables and a secret, and by the time it reaches a step row the run has moved
on and the interesting intermediate is gone. So the run stops and waits.

**Where the pause sits is the feature.** It suspends the node after its config
is resolved and before its runner is called — the only moment where both facts
exist at once: what the node received, and what it is about to do with it. A
debugger that stopped anywhere else would show a value the node was never going
to use.

**Breakpoints belong to a run, not to a workflow**, and this is the decision the
whole feature rests on. They are declared when a run is *started* and live on
the execution row (`executions.debug_json`), so there is no path by which a
schedule tick, a webhook delivery, or an API trigger can hit one. Nobody can
leave a breakpoint in production the way they can leave a `console.log`, because
there is nowhere to leave it. That removes an entire category of rule — no
scoping, no expiry, no owner-only widening, none of the machinery a [chaos
profile](#deliberate-fault-injection) needs — by making the unsafe state
unrepresentable rather than forbidden.

**A break stops the run, not the branch.** An `openBreaks` counter is checked in
the scheduler's launch condition, so a parallel sibling does not race ahead
while somebody reads the node they stopped at — the state under inspection going
stale is precisely what a debugger exists to prevent. It is incremented
synchronously at launch, *before* the task starts awaiting, so the round loop
cannot observe zero in between, and released in the task's `finally` so a config
that fails to resolve cannot wedge the scheduler forever.

**Overrides are what make it a debugger rather than a viewer.** Resuming may
carry a `{ config, input }` patch that is applied to what the node was about to
use: change the amount and watch the condition below it take the other branch.
The patch *merges* rather than replaces — changing one header should not mean
retyping the URL — and an overridden input rewrites the step's recorded input,
because a run whose history showed the pre-override value would be a debugger
that lies about what it did.

Waiting is [the approval pattern](#human-in-the-loop-approvals) deliberately: a
database row the engine polls. A paused run therefore survives whatever the
process does in between, the resume is a plain HTTP request from anywhere, and
two people pressing Continue resolve to exactly one winner inside the UPDATE.
The resume is scoped by execution id in the `WHERE` clause rather than checked
afterwards — a break belonging to another run must never be resumed *and then*
rejected.

The wait is bounded, and the bound **fails** the run rather than quietly
continuing it. A paused node holds an execution slot and a worker, so somebody
who walks away from a debug session must not wedge a queue; and continuing would
mean a node ran with nobody watching, in a session whose entire purpose was that
somebody was watching. Failing names the node, says what happened, and leaves
the run resumable from where it stopped.

### The node test bench

`POST /workflows/:id/test-node` runs a single node in isolation — a sample
input, no execution row, dry-run by default. The design constraint is that a
bench run must behave *identically* to how the node runs inside a real
execution, or it would give false confidence. So the route doesn't
re-implement anything: it imports the engine's own `getRunner`,
`loadWorkspaceSecrets`, `buildRedactor`, `redactDeep`, and `resolveTemplates`
and drives the node through the same pipeline. Secrets resolve into the
node's config through the exact scope the engine uses, and the same redactor
scrubs their values from the response — so testing an HTTP node that sends
`Authorization: Bearer {{secrets.API_KEY}}` fires the real header but never
echoes the key back.

Two node classes are excluded. Side-effecting runners (email/Slack/HTTP)
honor the dry-run flag like they do in a real run, so they're safe to bench;
`live: true` opts into firing. Engine-only types (approval, sub-workflow,
for-each) are refused up front — they only mean anything inside a full run
(a human decision, a nested execution, a fan-out), so there's nothing
coherent to bench in isolation. A per-call timeout (`NODE_TEST_TIMEOUT_MS`)
bounds the request, since a node's own config (a delay set to minutes) could
otherwise hang it. A node that throws is reported as a *failed verdict* with
a 200 — a failing test is a successful bench run — so the client renders the
error inline rather than treating it as a request error.

### Workflow test scenarios

Where the node test bench checks one node, `services/workflowTester.js` checks a
whole workflow. A scenario is a named trigger payload plus a list of FXL
assertions; running it executes the workflow through the **real engine in
dry-run mode** and evaluates each assertion against the run. It's the same
testing discipline the codebase applies to itself (`docs/ARCHITECTURE.md` §
Testing strategy), turned on the workflows users build — so a graph edit that
breaks a contract is caught before deploy, not at 3am.

The design is almost entirely reuse:

- **The engine, unchanged.** `runScenario` drives `runExecution` — the same
  ready-set scheduler, `{{…}}` templating, secret decryption, and redaction a
  production run uses — so a passing scenario is the behaviour the workflow will
  actually produce. Dry-run mode is what makes it safe to run in CI on every
  push: side-effecting nodes (email/Slack/HTTP) return what they *would* send
  instead of firing, and approval gates auto-approve.

- **Dry-run identity, so nothing is polluted.** Scenario runs are recorded with
  `trigger_type = 'dry-run'`, which means every surface that already excludes
  test-mode runs — insights percentiles, the status badge, the SLA monitor —
  excludes these for free. A CI suite hammering the gate can't skew a p95 or
  flip a badge to failing. No new exclusion rule was needed anywhere.

- **FXL, not a second rules engine.** Assertions are the same expression
  language the condition, filter, and switch nodes evaluate, so the linter's
  static check validates them at authoring time (a broken assertion is a 400,
  not a mid-run surprise) and the inline playground already understands the
  syntax. They read from a scope of `{ output, steps, status }`: `output` is the
  run's return value, `steps` maps each node id to its (persisted, redacted)
  output — `steps["http-1"].status == 200` — and `status` lets a scenario assert
  a *failure* path (`status == "failed"`), not just a happy one.

- **The same suite, three surfaces.** The canvas Tests panel authors and runs
  scenarios; `flowforge test <id>` and the public
  `POST /api/v1/workflows/:id/tests/run` run the whole suite and key CI on its
  `ok` flag. Each scenario run is bounded by a timeout, so a workflow with a real
  delay node (which sleeps even in dry-run) reports *timed-out* rather than
  hanging the gate.

### Deliberate fault injection

`services/faultInjection.js` closes a gap the rest of this document makes
obvious. An unusual amount of the engine only runs when something breaks —
per-node retries, the `continue` and `branch` on-error policies, error-handler
workflows, the circuit breaker, SLA duration budgets, SLO burn rates, heartbeat
alerts — and none of it can be exercised without a real dependency actually
failing. So the error branch someone wired up eighteen months ago is a guess,
and the first anyone learns otherwise is the night it matters.

A chaos profile makes the failure happen on purpose: `fail` a node, `delay` it,
or `stub` its output. Combined with the test scenarios above, "does my error
branch work?" becomes an assertion that runs in CI.

Four decisions bound it:

- **Safe by default.** A profile's scope is `dry-run` unless someone explicitly
  widens it, so writing one cannot break production by accident — and dry-run is
  where the test scenarios already live, which is where most of the value is.
  `scope: 'all'` is genuine chaos engineering: owner-only, audited, and
  announced in the activity feed, because a fault profile nobody can see is
  indistinguishable from an incident.

- **A profile expires, and the expiry is mandatory.** Chaos is an experiment,
  not a setting. `expiresAt` is required and capped at seven days, so a profile
  armed during an investigation disarms itself rather than quietly haunting the
  workflow for a year. An expired profile reads as *absent* rather than as an
  error, because expiry is the feature — and the read endpoint reports "armed"
  and "in force" separately, since "I armed it, why is nothing failing?" needs a
  direct answer.

- **Randomness is seeded, not random.** A 30% failure probability makes a test
  flaky and a bug unreproducible. The draw is a hash of (execution id, node id,
  rule index), so the fault pattern is fixed for a run — and *replaying* that
  run reproduces exactly the same faults. That is the difference between a chaos
  failure you can debug and one you can only re-roll.

- **An injected failure is never disguised.** The message carries `[chaos]`, the
  step records it as the failure it is, and `flowforge_faults_injected_total`
  counts it by mode — so a spike in execution failures beside a spike in that
  counter is an experiment, and the same spike with it flat is an outage. A
  timeline that hid the cause would make the two indistinguishable, which is
  precisely backwards.

Two smaller rules follow the same reasoning as the engine's own. The fault is
resolved **once per node, not per attempt**, so a `fail` rule exercises the
retry ladder rather than re-rolling its luck between attempts. And a rule must
name a `nodeId` or a `nodeType`: a profile that matched everything by omission
is exactly the accident this refuses. Triggers are excluded outright — a trigger
has no work of its own, and making a run fail before it begins is what *not
triggering it* already does.

### Cross-workflow dependency analysis

The linter reasons about *one* graph; `services/workflowDependencies.js` reasons
about how a workspace's workflows reference *each other*. Three mechanisms make
one workflow depend on another — a **sub-workflow** node, a **for-each** node
(both `node.data.config.workflowId`), and an **error-handler** designation
(`workflows.error_workflow_id`) — and together they define a directed graph.
The service exists to answer the question that graph is *for*: what breaks if I
change, undeploy, or delete this?

- **Both directions, from one build.** A single pass builds
  `Map(source → Map(target → {via}))` for the workspace, keeping only edges
  whose target still exists there — a dangling reference is a lint error, not a
  dependency, so it's dropped rather than reported here. `dependsOn` is a
  workflow's out-edges; `dependedOnBy` is found by scanning for in-edges. Each
  edge carries *how* the reference is made, aggregated (a workflow that both
  calls another as a sub-workflow and escalates to it on failure shows
  `["error-handler", "sub-workflow"]`).
- **Cycle detection is the interesting part.** Sub-workflow recursion is blocked
  at run time by the engine's ancestor-id stack, but a *stale configuration* can
  still describe a cycle (A calls B, someone points B back at A) that only fails
  when a run actually reaches it. A DFS from the workflow's successors that finds
  its way back to the workflow reconstructs the offending path
  (`[A, B, A]`), so the loop is visible statically — in the panel, on the API,
  and as a non-zero exit from `flowforge deps` — before a run trips it.
- **Same workspace, same boundary as everything else.** References only resolve
  within a workspace because the sub-workflow runner and the error-handler
  settings both enforce that, so the analysis needs no cross-workspace joins and
  the read endpoint's single membership check covers the whole result.

---

## Status badges

`services/statusBadge.js` hand-renders shields.io-style flat SVG — the same
call as the metrics exporter: the app needs one badge shape, not an image
library, so the SVG is a template with per-character width estimation. The
interesting part is the security model, because a badge is fetched
**unauthenticated** by a caching image proxy (GitHub's camo) and embedded in
public pages:

- **Opt-in per-workflow token.** A workflow has no badge until a member mints
  one (`badge_token`). The badge URL carries the token as a query parameter,
  compared in **constant time**.
- **No existence oracle.** A missing or wrong token renders a neutral
  `unknown` badge with a `200` — never a `404`, both so a README never shows a
  broken image and so the endpoint can't be used to probe which workflow ids
  exist. Rotating the token (re-mint) invalidates the old URL immediately.
- **Escaped output.** Every dynamic value is XML-escaped, so a status string
  can never inject markup into the SVG.
- **Dry runs don't count.** The badge reflects the latest *real* run, so a test
  run never flips a workflow to failing on someone's README.

The endpoint is rate-limited like the public webhook trigger (it's an
unauthenticated, oft-fetched asset) and served with a short `max-age` so an
embedded badge refreshes within a minute while a CDN still absorbs bursts.

## Public status pages

The badge's big sibling (`services/statusPage.js`): a workspace owner mints
a token and `/status/:token` renders a read-only health rollup of the
workspace's **deployed** workflows — recent run outcomes as uptime bars,
success rate over settled runs, median duration, last-run age — for people
who shouldn't get accounts: the on-call channel, a client, a wall display.

What the payload *omits* is most of the design. No workflow or execution
ids (nothing on the page can be turned into an API call), no error messages
or step data (failure **rates** are shareable; failure **details** often
embed payloads), no drafts (unfinished work isn't status), no dry runs
(tests aren't service health), and cancelled runs count toward neither
success nor failure. Management is **owner-only** — publishing run health is
a workspace decision, not any member's — while the page itself needs no
account at all: the token is the whole credential, minted at 48 hex chars,
and rotating it severs every previously shared link. Unknown, malformed, and
disabled tokens all read as the same 404, and the endpoint shares the public
rate-limit profile with badges and webhook triggers.

## Schedule preview

`services/cronExpression.js` computes the next fire times of a cron expression.
The scheduler (`services/scheduler.js`) leans on node-cron to *validate* and
*fire* schedules, but node-cron can't answer "when does this run next?" — the
one thing a schedule preview needs. So this is a small, dependency-free cron
interpreter, hand-rolled in the same spirit as the metrics registry and the
logger: the app needs one narrow capability, not a datetime library.

Two details make it correct rather than a toy:

- **The day-of-month/day-of-week OR-rule.** In Vixie cron, when *both* the
  day-of-month and day-of-week fields are restricted (neither is `*`), a date
  fires if it matches *either* — `0 0 13 * FRI` means "the 13th, and also every
  Friday", not "Friday the 13th". When only one is restricted it ANDs with the
  rest of the fields normally. Getting this backwards is the classic cron bug;
  the matcher encodes the rule explicitly and a test pins it.

- **Field-stepping, not minute-ticking.** Rather than testing every minute until
  one matches (millions of iterations for a sparse schedule), the search jumps:
  a disallowed month skips to the first of the next allowed month, a disallowed
  day skips a whole day, and so on. It settles in a few hundred steps even for
  `0 0 29 2 *` (the next 29th of February, three-plus years out) and returns
  null for an impossible expression (Feb 30) instead of looping — bounded by a
  step budget that is a horizon of centuries.

Computation defaults to UTC so the result is deterministic and independent of
the server's timezone; the exposed endpoints (`/api/workflows/:id/schedule`, a
generic `/api/schedule/preview`, and the public `/api/v1/...` mirror) return
ISO-8601 `Z` instants, and an unreachable schedule is reported as
`reachable: false` rather than an error. The same parser backs `isValid`, so a
schedule that previews is a schedule that will run.

### Named time zones and the two days a year they matter

UTC is the right *default* and the wrong *only option*: "weekdays at 9am" means
9am in an office, and a UTC-only schedule silently drifts an hour twice a year
in every zone that observes DST. A schedule node (and a maintenance window) can
therefore name an IANA zone, and the expression is matched against that zone's
wall clock.

`services/timezone.js` supplies the zone arithmetic with **no dependency and no
tz database of its own** — offsets are read from the runtime's own data through
`Intl.DateTimeFormat#formatToParts`, so zone-rule changes (and governments
change them often) arrive with the platform rather than with a package bump.
It's the same call the metrics registry and the cron engine itself make: the app
needs one narrow capability, not a datetime library.

The matcher is untouched. The search runs over a **pseudo-UTC Date carrying the
zone's local fields**, so the Vixie day-of-month/day-of-week OR-rule and the
field-stepping search work in local space exactly as they did in UTC; only the
final conversion is new. That conversion is where the difficulty actually lives,
because twice a year a wall clock has no single answer:

- **Spring forward leaves a gap.** 02:30 does not exist on the day the clock
  jumps 02:00 → 03:00. A skipped wall clock resolves to the **transition
  instant**, so a daily 02:30 job still runs once that day, at 03:00 local. The
  alternative — skipping the day — loses a production run silently, once a year,
  which is precisely the class of bug nobody notices until it matters.
- **Fall back leaves an overlap.** 01:30 happens twice. An ambiguous wall clock
  resolves to the **first** occurrence, and the search's existing
  strictly-after-*in-UTC* contract is what stops the repeat from firing a
  duplicate — no new rule, just the old one applied in the right space.

Resolution is offset-driven rather than iterative. Only two offsets can
plausibly apply to a given wall clock (the one a day before it and the one a day
after), so each is tried and kept when the instant it implies really does read
back as the requested time. Zero survivors means a gap; two means an overlap;
one is an ordinary conversion. The gap case then binary-searches the transition
to **millisecond** precision — a fire time is persisted and compared, so an
answer a second off is a wrong answer.

Three integration decisions:

- **Two implementations, one contract.** node-cron fires the schedule (it takes
  a `timezone` option); `cronExpression.js` computes the preview. They are
  independent code paths, so the zoned-preview tests exist to pin that what a
  user is shown before deploying is what the runner will do.
- **Deploy refuses an unknown zone; the sweep doesn't.** Degrading to UTC is
  right for a schedule already running (a wrong offset beats a stopped
  schedule), and wrong at deploy time, where someone is watching and a schedule
  quietly firing five hours off is worse than a failed deploy.
- **A window's duration stays elapsed time, not wall time.** A two-hour
  maintenance freeze is two real hours even when the clocks go back inside it —
  which is what freezing deploys means. Only the window's *start* is a wall
  clock.

Tests pin real transitions in America/New_York, Europe/London,
Australia/Sydney (a southern-hemisphere overlap, so the seasons can't be
hard-coded backwards) and Asia/Kolkata (no DST, half-hour offset).

## Schedule backfill

`services/backfill.js` answers the question replay doesn't: replay re-runs a
*recorded* run, backfill runs the ones that never happened — a schedule
deployed late, a workflow paused through an incident, logic fixed after three
weeks of wrong output.

The idea that carries the feature is the **logical date**: the instant a run
represents, which is not the instant it executes. A backfill of last Tuesday
runs today but is *about* last Tuesday, and a workflow that fetches
"yesterday's orders" has to be told which yesterday it means or every
backfilled run recomputes today. Each generated run therefore carries its
scheduled instant into the graph as trigger data — `{{<trigger>.logicalDate}}`
and `{{<trigger>.backfill}}` — which is exactly the mechanism webhook payloads
already use. No new templating concept, no engine change, and a workflow
written for live traffic keeps working because an ordinary run simply has no
`logicalDate`. The `backfill` flag is there because skipping a notification
step while replaying history is a thing people legitimately want to branch on.

Occurrences come from the same cron engine, in the same zone, that the live
scheduler fires on — so a backfill across a DST change reproduces the *actual*
schedule rather than a naive UTC grid that would silently disagree with the
runs on either side of it.

The rest is guardrails, each aimed at a specific way this goes wrong:

- **Refuse, don't truncate.** A window over the occurrence cap is rejected with
  the count rather than trimmed. "I asked for a year and got the first 1000" is
  a worse failure than being told to narrow the range, because it's silent.

- **The preview is the safety mechanism, not a convenience.** The same planner
  that submits is exposed read-only, and every surface (API, CLI, panel) shows
  the count before anything can be created. The canvas panel additionally
  *invalidates* the plan whenever the window changes — a stale count sitting
  next to new dates is precisely how someone submits a range they never looked
  at.

- **Idempotent by default.** Occurrences whose logical date already has a run
  are skipped, so re-submitting an overlapping range — the normal thing to do
  after a partial backfill — is safe. The window is half-open at its start for
  the same reason: "from the last one I ran" must not repeat it.

- **Low lane.** Bulk work must never starve live traffic, and priority lanes
  already express exactly that.

- **Pause is honoured; the rate limit is not.** This is the one boundary worth
  arguing. Pause means *stop everything*, and bulk historical traffic is
  precisely what an operator pausing a workflow is trying to prevent. The rate
  limit, though, exists to bound **unattended** frequency — a runaway cron, a
  bursty webhook sender — and a backfill is neither: it is explicit, bounded,
  and human-initiated. Its load on the downstream system is governed by the
  **concurrency cap at worker pickup**, which is the control that actually
  applies here.

- **Rows in one transaction, then enqueue.** A submission produces its whole
  batch or none of it, so a failure halfway can't leave a partial backfill to
  reconcile by hand. Bull is not part of that transaction, so jobs are added
  only after it commits — a job pointing at a rolled-back row would fail on
  pickup.

Batch progress is *derived* from the runs (`GROUP BY backfill_id`) rather than
stored on a batch row: there is no second source of truth to drift, and a run
cancelled or replayed outside the panel is reflected for free. Cancelling a
batch goes through the ordinary cooperative cancel path, so a stopped backfill
leaves the same evidence as any other cancelled run — "we backfilled March and
stopped partway" is exactly the sort of thing someone has to reconstruct later.

## Full-text search

"Which workflow calls the Stripe API?" can't be answered from a name list —
the evidence lives inside node configs. `services/workflowSearch.js` makes
each workflow one **SQLite FTS5 document** (name, description, and
`node_text`: every node label, type, and string config value, sticky-note
text included, config *keys* excluded — indexing "url" would match every
HTTP node) and serves the app's command palette, `GET /api/search`, the
public `GET /api/v1/search`, and `flowforge search` from one engine.

The interesting decision is index maintenance: **lazily, at read time**. The
alternative — hooking every write path — is a list that only grows (create,
rename, graph save, import, restore, template clone…) and a stale-index bug
every time someone adds a path and forgets the hook. Instead,
`workflow_search_state` records the `updated_at` each document was built
from, and a search pass re-indexes exactly the searched workspaces' rows
whose `updated_at` moved. Writes stay oblivious to the index, and staleness
is repaired by the very query that would have observed it. Deletes need no
hook either: results join back to `workflows`, so a deleted workflow's
document just stops surfacing — and is swept when a search notices the
orphan.

Query handling is hardened by construction: user text is never spliced into
FTS5 syntax — each whitespace term becomes a quoted phrase token, the last
gets a `*` so search-as-you-type prefix-matches, and anything that looks
like an operator rides inside the quotes as literal text. Ranking is bm25
with the name column weighted well above node_text, so a workflow *named*
"stripe sync" beats one that merely mentions stripe in a config; each hit
reports which field matched and an FTS5 `snippet()` with the matched terms
bracketed, so the palette can show *why* a result surfaced.

## Run cost accounting and budgets

Every admission control in the previous sections bounds **load**: concurrency
bounds simultaneity, the rate limit bounds frequency, pause stops everything.
None of them bounds **money**. A workflow with an AI node inside a for-each over
a list that grew, running on a schedule nobody watches, sits comfortably inside
all three and still spends a fortune. `services/costModel.js` measures that;
`services/budget.js` acts on it.

### Measuring: what can honestly be priced

Token usage is reported by the AI service from the call that incurred it
(`llm.chat_with_usage`), because that is the only place the number is knowable
— reconstructing it later from the response text would be a guess dressed up as
a figure. The runners pass it through, and the engine prices it.

The load-bearing decision is what is **not** priced. An HTTP node calling a
third-party API costs money too, but FlowForge has no idea what that vendor
charges, and inventing a rate would produce a total that looks authoritative
and is fiction. External calls are therefore *counted*, never priced, unless
the workflow author declares `costPerCall` on the node — they are the only
party who could know it. That value is read from the **raw** config, like the
`onError` and cache policies, so upstream data can never move an accounting
figure.

The same honesty runs through model pricing. Rates are matched by **longest
prefix**, so a dated snapshot (`gpt-4o-mini-2024-07-18`) prices as its family
rather than falling off the table — and so `gpt-4o-mini` is never priced as
`gpt-4o`, a 16× error. An unknown model contributes **zero and carries
`priced: false`**, so every surface showing a total can say how much of it is
unknown. A visible gap beats a confident wrong number.

Money is stored as integer **micro-USD** (1e-6 USD). Floating-point dollars
accumulate rounding error across thousands of steps and then disagree with
themselves when the same rows are summed two different ways; an integer count of
millionths does not. Formatting happens once, at the edge, and keeps four
decimals below a dollar because a single AI call routinely costs less than a
cent and rounding every step to `$0.00` would make the per-step view useless
exactly where it is most needed.

**Metering is a side channel, not data.** A runner reports usage on a reserved
key that the engine reads and then *strips* before the value becomes node
output. Leaving it in would put token counts into the context every downstream
node reads, into the persisted step row, and into the run's return value —
three places it has no business being. Every call on this path is best-effort:
a run that would have succeeded must never fail because its invoice line
couldn't be computed.

### Enforcing: a budget beside the other admission controls

The check lives in `admitRun` — the chokepoint every entry point already calls —
so manual runs, the public API, webhooks, schedules, backfills, replays,
resumes, and error-handler escalations are covered with no per-route logic. It
runs **last** of the three checks: it is the most expensive (it sums the
month's runs) and the least likely to trip, and there is no point pricing a
submission a full queue was going to refuse anyway.

Four decisions mirror controls that already exist rather than inventing new
shapes:

- **Failed runs count toward the spend.** A run that died after its AI call
  still spent the money; a budget that counted only successes would be
  trivially defeated by a workflow that fails on its last step.
- **Dry runs are exempt**, as they are from the concurrency cap, the rate limit,
  and pause. An interactive test must not eat the production allowance — and the
  person diagnosing *why* the budget blew is the last person who should be
  blocked.
- **In-flight runs are never killed.** A budget refuses new work; tearing down
  half-finished work to save a fraction of a cent would leave the outside world
  in an unknown state for no benefit. That is cancellation's job, and it stays a
  human decision.
- **The warning is edge-triggered through one column**
  (`budget_alerted_month`), the same trick the heartbeat monitor uses: a month
  of overspend alerts once, the column *is* the state, it survives restarts, and
  changing the cap clears it because the old alert answered the old budget.

The month is a **calendar** boundary in UTC rather than a rolling 30 days,
because that is the boundary the invoice this mirrors uses — a rolling window
would make "how much have we spent this month?" unanswerable against a bill.

The spend query is slightly behind reality under heavy parallelism, since a
run's cost lands when it settles. That is the right way to be wrong: it can
briefly admit a run it would later refuse, but it can never refuse one it should
have admitted.

`/metrics` labels cost by **node type**, never by workspace or workflow — money
is interesting per kind of work, and a per-resource label would let ids explode
the series space, the same cardinality rule the HTTP metrics follow.
Per-workspace spend is a database question, answered by
`GET /workspaces/:id/costs`.

## Signed workflow artifacts

`services/artifactSigning.js` (pure) and `services/trustStore.js` (the database
half) answer a question the workflows-as-code loop leaves open. Drift detection
says git and production diverged, the three-way merge reconciles them, and
lint / verify / preview vet what a document says and does. None of them asks
whether the graph that arrived is the graph that was **reviewed** — and between
the approval and the import the document passes through a repository, a CI
runner, an artifact store and an HTTP call, with a `manage` token able to import
any document at all.

The user-facing reference is [PROVENANCE.md](./PROVENANCE.md); the decisions:

- **Ed25519, because Node's own `crypto` implements it.** No dependency, small
  keys, nothing to choose badly — the same argument behind the hand-rolled
  metrics registry and cron engine.

- **The signature covers the graph's *semantics*, not its bytes**, and this is
  the whole design. A signature over the serialised document would break whenever
  anything reserialised it — a key order, a re-export, a formatter — and one that
  breaks for cosmetic reasons is one people learn to skip. So the canonical
  payload uses exactly the rules [the semantic diff](./MERGE.md) uses to decide
  what "changed" means: positions excluded, nodes sorted by id with config keys
  sorted, edges keyed by `(source, target, sourceHandle)` so a redrawn connection
  still verifies, and the declared guarantees covered because they are the
  assertions that were the reason a reviewer approved it. The consequence is
  stated rather than discovered: a signature proves what the workflow *means*,
  not what the file *looks like*.

- **Three negative verdicts, kept apart because they call for different
  responses.** `unsigned` is no claim; `untrusted` is a well-formed signature by
  a key this workspace does not hold, which is what a rotated key looks like and
  is not tampering; `invalid` is a payload that does not match a signature made
  by a key we do trust, which is.

- **Enforcement governs only the unsigned case.** Whether an unsigned import is
  acceptable is a policy each workspace answers for itself. Whether a *broken*
  one is, is not — there is no configuration under which the right response to
  evidence of tampering is to import it anyway, and conflating the two is the
  mistake that makes signing decorative. Arming enforcement with no trusted keys
  is refused, because it would lock a workspace out of its own promotions.

- **The trust store mirrors controls that already exist.** Owner-managed like
  secrets and status-page tokens (a list any member could append to is a
  formality); keys parsed before they are stored, so a paste-o is a 400 rather
  than a key that silently never matches; revoked rather than deleted like an API
  token, because the question after an incident is what a key signed *while* it
  was trusted. Every change is audited by **fingerprint, never key material**,
  and every import records its verdict, the signing fingerprint and the digest of
  the graph — including unsigned imports, since "which graph is this" is useful
  either way.

- **Signing happens where the review happens.** `flowforge keygen` and
  `flowforge sign` talk to no server: a key that has been near one is a key
  somebody has to reason about, and an approval minted by the server it is later
  presented to proves nothing. The cost is a second implementation of the
  canonicalisation in the dependency-free CLI, which is the node-cron /
  `cronExpression.js` trade again — and it carries the same obligation, so the
  CLI suite requires both modules and asserts identical digests and cross-verified
  signatures. A divergence there would not fail loudly; it would produce a
  signature that verifies nowhere.

The limit is stated rather than oversold, exactly as the audit log's is. A
signature is **transferable**: it proves who approved a definition, not that they
intended this import, at this moment, into this workspace. The mitigations are
the same shape — the fingerprint is recorded, revocation is immediate, and the
import still lands a draft.

## The tamper-evident audit log

`services/auditLog.js` exists because FlowForge already had an activity feed and
the feed is the wrong artefact for one specific reader. The two answer different
questions:

| | `activity_events` | `audit_log` |
|---|---|---|
| Reader | a teammate, on a dashboard | an auditor, or an incident review |
| Question | "what's been happening here?" | "who changed security-relevant state — and is this record intact?" |
| Coalescing | yes (an editing burst is one row) | never |
| Mutability | rows can be bumped | append-only, enforced by trigger |
| Scope | everything notable | a fixed allow-list of governed actions |

Everything below follows from the second column's last clause. A log is only
evidence if altering it is detectable, so each workspace's entries form a hash
chain — `hash(n) = SHA-256(canonical(n) || hash(n-1))` — and `seq` is a
contiguous per-workspace counter. Editing an entry breaks every hash after it;
deleting one breaks the link *and* leaves a hole in the numbering.

Design decisions worth the words:

- **Canonicalisation is `JSON.stringify` over a fixed-order array.** It's
  deterministic (no key ordering to depend on) and its escaping means no field's
  contents can imitate a field boundary — a `target_name` of
  `","action":"secret.deleted` is a string with quotes in it, not a way to shift
  what the digest covers. The row `id` is deliberately *not* covered: it's a
  random surrogate that carries no claim.

- **Two independent defences, because they fail differently.** The BEFORE
  UPDATE/DELETE triggers make append-only a property of the database rather than
  a habit of the code, so an application bug cannot rewrite history. The chain
  catches an attacker who has enough access to drop the triggers. Neither
  subsumes the other.

- **The guarantee is stated with its limit.** A chain proves internal
  consistency, not notarisation: rewrite every subsequent entry and you get a
  self-consistent forgery. The tests demonstrate exactly that rather than
  pretending otherwise, and what betrays it is the **head hash** — which is why
  `verifyChain` returns it, the UI displays it, and the CLI prints it. Anchoring
  the head anywhere out of reach closes the gap.

- **Writes are best-effort at the boundary**, like `activityService`. Refusing
  to delete a secret because its audit entry couldn't be written would convert
  an observability fault into an outage. The resulting gap can't be forged shut
  later, because every subsequent hash already chains past where the missing
  entry would have gone.

- **Actions are an allow-list, and the list is short.** An unrecognised action
  is refused rather than stored, which is what lets a reader treat an *absent*
  entry as "it didn't happen" instead of "someone typo'd a call site". Ordinary
  authoring — renaming a workflow, dragging a node — stays in the activity feed;
  putting it here would bury the entries that matter.

- **Only decisions, not the scheduler.** A person halting production is audited;
  a maintenance window auto-pausing on its cron every night is not. The
  distinction hangs off the `paused_reason` column the pause switch already
  records, so it needed no new state.

- **Reads are owner-only**, matching secrets and status-page tokens: "who was
  granted access recently" is what an attacker with a member session would like
  to read. And a failed verification is a `200 { ok: false }`, never a 5xx — a
  probe must distinguish a compromised log from a dead endpoint.

The trail has no foreign key to `workspaces` and no cascade, which is the one
place this schema deliberately breaks the pattern every other table follows: an
audit log that vanishes when someone deletes the workspace is exactly the log an
attacker would target.

## Security architecture

[SECURITY.md](../SECURITY.md) is the authoritative threat model. The load-
bearing decisions:

- **No code evaluation path** for user input, anywhere.
- **Auth:** bcrypt + JWT with optional TOTP two-factor (backup codes
  bcrypt-hashed); session tokens and API tokens are deliberately
  non-interchangeable surfaces.
- **Personal access tokens** are stored hash-only (SHA-256), scoped,
  expiring, and revocable — revocation keeps the row as an audit trail.
- **Workspace secrets** are AES-256-GCM at rest under **envelope encryption**:
  each value has its own random data key, and that data key is wrapped by a key
  from a ring (`services/secretVault.js`). The point of the indirection is
  rotation. Encrypting every value directly under one derived key means changing
  that key makes every stored credential undecryptable at the same instant —
  a vault that cannot rotate is a vault with an expiry date. Decryption picks
  the wrapping key by the **id recorded on the row**, so old and new keys
  coexist and no read ever fails mid-rotation; and re-keying unwraps a 32-byte
  data key rather than a credential, so the process that rotates keys never
  holds an API token in memory. Secrets are also write-only through the
  API; the engine redacts them from everything it persists or publishes.
- **SSRF guard:** user-supplied URLs (HTTP/Slack nodes) resolve through a
  scheme + private/reserved-IP egress check, re-applied per redirect hop.
- **Webhook HMAC signing:** opt-in per webhook; deliveries carry a
  timestamped HMAC-SHA256 over the raw request bytes, verified in constant
  time with a replay-tolerance window. The raw bytes come from the body
  parser's `verify` hook — re-serializing parsed JSON would not round-trip
  key order or whitespace.

---

## Observability

`services/metrics.js` is a deliberately hand-rolled Prometheus registry
(~150 lines): the app needs a dozen series, not a client library, and the
text exposition format is three line shapes. Design constraints:

- **Bounded cardinality.** HTTP metrics label the *matched route pattern*
  (`/api/workflows/:id`), never raw URLs — resource ids can't explode the
  series space or leak into the metrics endpoint.
- **Scrape-time collectors** for values cheaper to read on demand (queue
  depth from Bull, process stats), each fault-isolated so a broken source
  skips its gauges instead of failing the scrape.
- **Engine outcomes** (`flowforge_executions_total`,
  `..._duration_seconds`) are recorded at the same terminal points that
  publish execution events, with a `nested` label separating sub-workflow
  child runs.
- **Outbound webhook health** is two series: an attempt counter by outcome
  (`delivered` / `retried` / `failed`) at the dispatcher's settle points,
  and a scrape-time backlog gauge — a growing
  `flowforge_webhook_deliveries_pending` means an unreachable receiver (or
  a dispatcher that isn't running).

Health is two endpoints with different jobs: `/api/health` answers "is the
process up" for liveness; `/api/health/ready` actually exercises SQLite and
Redis (the ping raced against a timeout, because ioredis queues commands
indefinitely while disconnected) and 503s with per-check detail so an
orchestrator holds traffic until the process can genuinely serve.

### Distributed tracing (W3C trace context + OTLP)

Correlation ids answer "what happened to request X?" *within* FlowForge. They
stop at the process boundary, and so did everything else: the timeline renders
every step, critical-path analysis names the chain that set the duration, and
both go blind the moment a step calls out. A workflow that calls a service that
calls two more shows "that HTTP step took 4 seconds", while the reason lives in
somebody else's tracing backend, in a trace this run has no connection to.

`services/tracing.js` closes that boundary in both directions.

- **Inbound**, a webhook delivery carrying `traceparent` has its trace adopted
  onto the execution row. That single act is what turns the run into a *child
  span of the request that triggered it* instead of a separate trace someone
  correlates by squinting at timestamps.
- **Outbound**, every step is given its own span id **at row-creation time**,
  before anything executes. That ordering is load-bearing: it lets a node
  reference its own span before it runs, which is what the HTTP node needs to
  inject a header naming *the step making the call*. The far side then hangs off
  that exact node rather than off the run as a whole — which is the difference
  between "this workflow was involved" and "this step, in this run, caused it".
- **Export**, `GET /api/executions/:id/trace` emits OTLP/JSON: one root span for
  the run, one child per executed step. It is the wire format an OpenTelemetry
  collector already accepts, so shipping a run to Jaeger, Tempo, or Honeycomb is
  a `curl … | curl -X POST $COLLECTOR/v1/traces -d @-` rather than a translation
  layer someone has to keep working.

**No OpenTelemetry SDK**, and the reason is the same one behind the metrics
registry, the logger, and the cron engine: what is actually needed here is a
55-character header with a strict grammar and a JSON shape with a published
schema. Adopting a tracing framework — with its instrumentation machinery, its
context propagation, its shutdown semantics — to produce those two artefacts
would be a far larger and more permanent commitment than writing them.

The decisions worth recording:

- **Parsing is strict, and refusal is the safe outcome.** A malformed
  `traceparent` means the *caller* is confused; adopting a half-understood
  context attaches runs to the wrong parent, which is worse than starting a
  fresh trace, because it corrupts someone else's data rather than merely
  lacking a link. All-zero ids (the spec's "no trace" sentinel) and unknown
  versions are refused, and null tells the engine to mint its own.

- **An explicitly configured `traceparent` on a node always wins.** A user
  hand-setting the header is deliberately joining a different trace; silently
  overwriting it would break precisely the case they went out of their way to
  build.

- **A `caught` step is an error span.** The node really did fail — it was only
  its *consequence* that was contained — and relabelling it would lie to whoever
  debugs it later. Exactly the argument the engine already makes for recording
  `caught` as its own step status rather than folding it into success.

- **Skipped steps produce no span at all.** A span asserts "this happened", and
  a dead branch didn't. Emitting zero-duration spans for skipped nodes would
  fill a trace viewer with things that never ran.

- **Timestamps are strings.** OTLP uses fixed64 nanoseconds; 1e18 exceeds
  `Number.MAX_SAFE_INTEGER`, so a JS number would silently lose precision.
  Recorded times have millisecond resolution, so the tail is zeros — honest
  about the source rather than inventing precision it doesn't have.

- **Historical runs still export coherently.** Rows written before tracing
  existed get ids derived deterministically (SHA-256 of the row id), so an old
  run is one connected trace rather than a root with orphaned children, and two
  exports of it agree — which is the entire point of an id you correlate on.

Cost rides the root span as an attribute, so a spend spike and a latency spike
can be examined in the same view. That is usually where the cause of both turns
out to be.

### Correlation ids and structured logs

Every request gets an id (`middleware/requestContext.js`): a valid inbound
`X-Request-Id` is honored — a gateway's id follows the request through
FlowForge's logs — anything else gets a fresh UUID. The id is echoed on the
response, bound onto `req.log` as a child logger, and returned in 500
bodies, so "what happened to request X?" is one grep. The middleware mounts
*before* the body parser on purpose: even a request that fails to parse
keeps its id through the error handler.

The logger itself (`services/logger.js`) is hand-rolled in the same spirit
as the metrics registry: the app needs leveled, field-structured JSON lines
with child loggers, not a logging framework. One line per response with the
*real* path — unlike metrics, logs are for debugging specific requests, so
raw paths are the point rather than a cardinality hazard. Health and
metrics probes log at debug so a 5-second scrape interval doesn't drown the
interesting lines, and serialization never throws (Errors flatten to their
message, circular references drop) because logging must never break the
request it describes.

### Graceful shutdown

On SIGTERM/SIGINT, `services/shutdown.js` drains the process instead of
letting it die mid-run. Closers registered by `index.js` run sequentially
in dependency order: sources of new work stop first (HTTP intake, cron
schedules), then the Bull worker's local pause waits for in-flight runs to
settle, then the background pollers, Socket.io, Redis, and SQLite close.
The readiness probe flips to `503 draining` the moment shutdown starts —
the orchestrator routes traffic elsewhere — while liveness stays green so
it doesn't kill the drain early.

Two escape hatches bound the drain: a hard deadline (`SHUTDOWN_TIMEOUT_MS`,
default 30s) force-exits if any closer hangs, and a second signal exits
immediately so an operator's ^C^C still works. The HTTP closer deliberately
initiates `server.close()` without awaiting every connection — open
WebSockets belong to the Socket.io closer, and awaiting them first would
deadlock the drain. Everything that stops is durable (delivery rows,
deployed schedules, queued jobs stay in Redis), so the next boot resumes it
— and a run that outlives the drain window is exactly what
resume-from-failure exists for.

---

## Persistence

SQLite (better-sqlite3) is a deliberate fit for the deployment shape: a
single server instance with a mounted volume, synchronous statements that
compose with the in-process worker, and zero operational surface. Schema
changes are **additive migrations** — `schema.sql` uses
`CREATE TABLE IF NOT EXISTS` and `config/database.js` applies
column-if-missing `ALTER`s at boot, so existing databases pick up new
fields without a wipe or a migration framework.

Two denormalizations are intentional: `execution_steps.node_type` is
captured at run time so per-type analytics survive later graph edits, and
`activity_events.entity_name` keeps feed rows readable after their entity
is deleted.

Growth is bounded by a retention sweep (`services/retention.js`, startup +
every 6h): settled webhook-delivery logs age out after 30 days by default,
while execution history is kept forever unless `EXECUTION_RETENTION_DAYS`
opts in — history is a feature, so pruning it is a deliberate choice. The
sweep only ever deletes terminal rows (a years-old run still marked
`running` is evidence of a bug, not garbage), and deletes are capped per
pass so a first sweep over an old database can't stall the synchronous
SQLite connection.

---

## Testing strategy

Every feature lands with tests; the suites run in CI on every push
(`.github/workflows/ci.yml`):

- **Server (Jest + supertest):** routes are tested through the real Express
  app against an in-memory SQLite database; Redis and the Bull queue are
  mocked at the module boundary (`jest.mock('../config/queue')`), so tests
  exercise real SQL and real HTTP handling without infrastructure. Engine
  tests drive `runExecution` directly — including timing-based assertions
  that parallel branches actually overlap and a local HTTP server that
  measures the concurrency cap.
- **Client (Vitest + Testing Library):** components are tested through
  their rendered behavior with `apiFetch` mocked; pure logic (graph diff,
  auto-layout, fuzzy matching, undo history) is extracted into utilities
  with focused unit tests.
- **Contract pinning:** the OpenAPI document has a test asserting its path
  list matches the mounted routes, so the spec cannot silently drift from
  the API.
- **Properties, where the claim is a property.** Two features assert something
  universal rather than exemplary, and are tested that way. The [collaboration
  CRDT](#real-time-collaboration) applies *every* permutation of an operation
  set and asserts one document comes out. The [type
  checker](#the-type-system) claims it never cries wolf, which is a statement
  about every expression rather than about the eleven somebody thought of — so
  a seeded random walk over the type lattice generates well-typed programs by
  construction, evaluates each against a scope inhabiting the environment it was
  checked against, and asserts precision (an expression that evaluates was not
  reported) and soundness modulo the one documented coercion (`number("abc")`
  type-checks because `number("42")` has to). A second, deliberately ill-typed
  corpus checks the other direction: over tens of thousands of nonsense
  programs, nothing crashes and no type-clean expression fails outside a named
  guard list. Both seed a reproducible PRNG rather than `Math.random`, for the
  reason the [chaos profile](#deliberate-fault-injection) does — a generative
  failure has to be reproducible to be a regression test.
- **CLI (node:test):** commands run against a stub HTTP server, so the
  suite exercises the real wire format — auth headers, request bodies,
  status handling — rather than mocks of the CLI's own client. Zero
  dependencies means CI runs it with no install step.
