# FlowForge architecture

A deep dive into the design decisions behind FlowForge. The
[README](../README.md) covers what the product does and how to run it; this
document covers **how it works and why it's built this way**. File paths are
relative to `flowforge/`.

- [The execution engine](#the-execution-engine)
- [Real-time collaboration](#real-time-collaboration)
- [Jobs and reliability](#jobs-and-reliability)
- [Outbound webhooks](#outbound-webhooks)
- [Run insights & SLA monitoring](#run-insights--sla-monitoring)
- [The expression language](#the-expression-language)
- [Static analysis (the linter)](#static-analysis-the-linter)
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

### Cooperative cancellation

`POST /api/executions/:id/cancel` flips a `cancel_requested` flag on the run
row. The scheduler polls the flag once per round — i.e. every time a node
settles — and winds down exactly like a failure, except the terminal status
is `cancelled`. Cancellation is deliberately **inter-node**: a node in
flight always finishes, because interrupting a half-sent email or HTTP call
would leave the outside world in an unknown state. A run cancelled while
still queued is finalized by the route itself, and the worker drops the job
when it sees the terminal status — so cancel wins the race against pickup.

### Templates, secrets, and redaction

Node configs reference upstream outputs as `{{node-id.field}}` and workspace
secrets as `{{secrets.NAME}}`. Three properties matter:

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

- **Edits are last-write-wins.** Every node/edge change carries a timestamp;
  a client drops remote changes older than its latest local edit to the same
  element. Cursor positions are throttled client-side (50ms) and stale
  cursors are garbage-collected.
- **Execution events ride Redis pub/sub.** The engine publishes
  `exec-update` events; the Socket.io layer relays them to the workflow's
  room. This decouples the worker from connected sockets — the run publishes
  identically whether zero or ten people are watching.
- **Undo/redo converges rather than forks.** History is snapshot-based
  (debounced, bounded at 50 entries). Applying a step diffs the target
  snapshot against the live graph and broadcasts each difference through the
  same channel as live edits — so peers apply the undo as ordinary changes
  under the same LWW rules. The trade-off is explicit: remote edits are part
  of local history, and undoing past them reverts them everywhere.
- **Self-healing state.** Comments, notifications, and activity events are
  written to SQLite first and emitted live second; a missed emit heals on
  the next fetch because the row is the source of truth.

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

All computation is in UTC so the result is deterministic and independent of the
server's timezone; the exposed endpoints (`/api/workflows/:id/schedule`, a
generic `/api/schedule/preview`, and the public `/api/v1/...` mirror) return
ISO-8601 `Z` instants, and an unreachable schedule is reported as
`reachable: false` rather than an error. The same parser backs `isValid`, so a
schedule that previews is a schedule that will run.

## Security architecture

[SECURITY.md](../SECURITY.md) is the authoritative threat model. The load-
bearing decisions:

- **No code evaluation path** for user input, anywhere.
- **Auth:** bcrypt + JWT with optional TOTP two-factor (backup codes
  bcrypt-hashed); session tokens and API tokens are deliberately
  non-interchangeable surfaces.
- **Personal access tokens** are stored hash-only (SHA-256), scoped,
  expiring, and revocable — revocation keeps the row as an audit trail.
- **Workspace secrets** are AES-256-GCM at rest and write-only through the
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
- **CLI (node:test):** commands run against a stub HTTP server, so the
  suite exercises the real wire format — auth headers, request bodies,
  status handling — rather than mocks of the CLI's own client. Zero
  dependencies means CI runs it with no install step.
