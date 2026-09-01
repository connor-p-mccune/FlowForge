# FlowForge public API

FlowForge exposes a small, token-authenticated REST API at `/api/v1` for
integrating workflows into external systems — trigger a run from CI, a cron
box, or another service, then poll it to completion.

## Authentication

Create a **personal access token** in the app under **Settings → API tokens**.
The full value (`ffp_…`) is shown once at creation; only its SHA-256 hash is
stored, so copy it immediately.

Send it as a bearer token:

```
Authorization: Bearer ffp_your_token_here
```

Tokens carry **scopes** chosen at creation:

| Scope     | Grants                                          |
|-----------|-------------------------------------------------|
| `trigger` | Starting workflow runs                          |
| `read`    | Listing workflows and reading execution results |
| `approve` | Settling approval gates (approve/reject a paused run) |
| `manage`  | Importing workflow definitions and pausing/resuming workflows |

A token acts as its owning user: it can only see workflows in workspaces the
owner belongs to, and it inherits the owner's **workspace role** — a token
belonging to a workspace *viewer* is read-only there regardless of its
scopes (a `trigger`-scoped token still gets `403` on mutating endpoints).
Scopes bound what a token may try; roles bound what its owner may do. Tokens
can be revoked at any time from Settings, and can be created with an expiry
(1–365 days).

Session JWTs are **not** accepted on `/api/v1`, and API tokens are not
accepted on the session API — a leaked automation token never grants access to
account settings.

## Machine-readable spec

The full API is described by an OpenAPI 3.0 document at
`GET /api/v1/openapi.json` (no token required). Import it into Postman,
Insomnia, or a client generator:

```bash
curl -s https://your-flowforge-host/api/v1/openapi.json -o flowforge-openapi.json
```

## Rate limits

`/api/v1` is limited per token (default 120 requests/minute). A `429` response
carries a `RateLimit-*` header set describing the window.

## Endpoints

### List workflows

```bash
curl -s https://your-flowforge-host/api/v1/workflows \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

Response `200`:

```json
{
  "workflows": [
    {
      "id": "6f0c…",
      "name": "Nightly sync",
      "description": null,
      "status": "deployed",
      "workspace_id": "a1b2…",
      "updated_at": "2026-07-08T09:00:00.000Z"
    }
  ]
}
```

Requires the `read` scope.

### Search workflows

```bash
curl -s "https://your-flowforge-host/api/v1/search?q=stripe" \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

Full-text search over workflow **names, descriptions, and graph contents** —
node labels, config strings, sticky-note text — across every workspace the
token's owner belongs to. "Which workflow calls the Stripe API?" is exactly
the query it exists for. The final term prefix-matches (`stri` finds
stripe), and search-as-you-type is what the app's command palette does with
this same engine.

Response `200` — ranked matches, best first (name matches outrank config
mentions). `field` says where the best match landed; `snippet` wraps the
matched terms in `[brackets]`:

```json
{
  "results": [
    {
      "workflowId": "6f0c…",
      "name": "Payments sync",
      "status": "deployed",
      "workspaceId": "a1b2…",
      "field": "nodes",
      "snippet": "POST https://api.[stripe].com/v1/charges"
    }
  ]
}
```

`q` is required (≤ 200 chars); `limit` caps results (1–50, default 20).
Requires the `read` scope. From the CLI: `flowforge search stripe`.

### Export a workflow

```bash
curl -s https://your-flowforge-host/api/v1/workflows/6f0c…/export \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN" > workflows/nightly-sync.json
```

Returns the workflow as a **portable, self-contained document** — the same
shape the app's Export button downloads, with no internal ids or ownership —
so workflow definitions can live in version control and go through code
review. It round-trips through the app's import. `flowforge export <id>` on
the CLI prints exactly this to stdout.

```json
{
  "exportVersion": "1.0",
  "name": "Nightly sync",
  "description": null,
  "graph_data": { "nodes": [ … ], "edges": [ … ] },
  "guarantees": [
    { "kind": "requires", "node": "charge", "other": "approve" }
  ],
  "exportedAt": "2026-07-15T09:00:00.000Z"
}
```

`guarantees` carries the workflow's declared [path
invariants](#verify-the-path-invariants). They are statements *about* this graph
and reference its node ids, so a document without them would be the interesting
half missing — a promotion that dropped them would silently ship the workflow
without the assertions that were the reason it passed review. Import accepts
them back.

#### `?format=flow` — the reviewable text form

```bash
curl -s "https://your-flowforge-host/api/v1/workflows/6f0c…/export?format=flow" \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN" > workflows/nightly-sync.flow
```

Returns `text/plain` — the same definition as the JSON above, in the form a
human is actually going to read in a pull request:

```
workflow "Order pipeline"
  description: "Handles incoming orders"

guarantee requires charge approve

node charge: action-http @ 480,160
  label: "Charge card"
  method: "POST"
  url: "https://api.acme.com/v1/charges/{{hook.orderId}}"

node hook: trigger-webhook @ 100,200
  label: "Order webhook"

hook -> charge
```

Nodes are sorted by id with their config beneath them, connections are gathered
at the end, and there is **no `exportedAt`** — the field that makes `git diff` on
an unchanged workflow non-empty. The emit order is the same canonical order the
[signature](./PROVENANCE.md) uses, so re-formatting a file cannot break its
signature and two people who export the same workflow get byte-identical text.
See [docs/DSL.md](./DSL.md).

Requires the `read` scope.

### Import a workflow

The other half of export: create a **draft** workflow in a workspace from a
portable document — so CI can promote a definition that lives in git into
another environment.

```bash
# List target workspaces (read scope)
curl -s https://your-flowforge-host/api/v1/workspaces \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"

# Import (manage scope)
curl -s -X POST https://your-flowforge-host/api/v1/workspaces/a1b2…/workflows/import \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d @workflows/nightly-sync.json
```

Response `201` with the created workflow (`status: "draft"` — deploying stays
a deliberate act in the app). Returns `400` for a document without `name` and
`graph_data.nodes/edges`, `413` past the 500KB graph cap, `404` for a
workspace the token's owner isn't in.

Requires the dedicated **`manage` scope** — a token that promotes definitions
can't also fire runs, and vice versa. On the CLI:

```bash
flowforge export 6f0c… > workflows/sync.json      # on staging
flowforge import $PROD_WS workflows/sync.json     # on prod
```

#### Importing the text form

A `.flow` document is sent as a `flow` string and parsed server-side into the
same shape, so the size cap, the signature check and the guarantees are one code
path rather than two that have to be kept in agreement:

```bash
curl -s -X POST https://your-flowforge-host/api/v1/workspaces/a1b2…/workflows/import \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN" \
  -H "Content-Type: application/json" \
  --data-raw "$(jq -Rs '{flow: .}' workflows/nightly-sync.flow)"
```

A syntax error returns `400` with the position the parser found:

```json
{ "error": "Line 12: Value must be JSON — strings need quotes (\"POST\", not POST)",
  "line": 12, "column": 11 }
```

A signature made over the JSON export **verifies against the text**, because the
format's emit order is the signing canonical order. On the CLI,
`flowforge import <ws> sync.flow` detects the form by extension and then by
content. See [docs/DSL.md](./DSL.md).

> Every endpoint that takes a workflow **document** accepts `{ flow }` in place
> of `graph_data` — import, [diff](#detect-drift-against-an-exported-document),
> [lint](#lint-a-workflow), [merge](#merge-a-document-into-the-live-workflow)
> and preview. A `.flow` file that could be promoted but not diffed or linted
> would be a format nobody could adopt.

### Detect drift against an exported document

The check the export/import loop leaves open: is the deployed workflow still
what the file in git says it is?

```bash
curl -s -X POST https://your-flowforge-host/api/v1/workflows/6f0c…/diff \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d @workflows/nightly-sync.json
```

The body is an export document (only `graph_data` is read). The report reads
from the **document's perspective** — `addedNodes` exist live but not in the
file — and `identical` is the gate. Nodes match by id with canvas position
ignored (moving a node is not drift); edges match by their
(source, target, sourceHandle) triple, so a re-created but equivalent
connection isn't churn.

Response `200`:

```json
{
  "workflowId": "6f0c…",
  "identical": false,
  "addedNodes": [],
  "removedNodes": [{ "id": "o1", "type": "output-log", "label": "Log result" }],
  "changedNodes": [
    { "id": "h1", "type": "action-http", "label": "Fetch", "changes": ["config.url"] }
  ],
  "addedEdges": [],
  "removedEdges": [
    { "source": "h1", "target": "o1", "sourceHandle": null, "description": "Fetch → Log result" }
  ],
  "summary": { "addedNodes": 0, "removedNodes": 1, "changedNodes": 1, "addedEdges": 0, "removedEdges": 1 }
}
```

Returns `400` for a body without `graph_data.nodes/edges`, `413` past the
500KB cap. Requires the `read` scope — the diff changes nothing. From the
CLI, `flowforge diff <id> <file>` wraps this and exits non-zero on drift, so
CI can fail a pipeline that's about to run against a workflow nobody
re-exported.

### Merge a document into the live workflow

`diff` detects that git and production diverged; this resolves it, keeping both
sides' work instead of making you pick one to discard.

```bash
curl -s -X POST https://your-flowforge-host/api/v1/workflows/6f0c…/merge \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "graph_data": … , "apply": true }'
```

Merging is per **config field**, so two people editing different fields of the
same node combine cleanly — the case that justifies a three-way merge rather
than picking a side. Node position is ignored, and identical edits on both sides
are agreement rather than conflict.

The base defaults to the workflow's latest version snapshot (a deploy is where
the exported document came from). `baseVersion` names another; a workflow with
no snapshots merges against an empty base, which reads every node as added and
so can never conclude something was deleted.

Response `200`:

```json
{
  "workflowId": "6f0c…",
  "clean": false,
  "applied": false,
  "base": { "versionId": "9ab…", "version": 7 },
  "conflicts": [
    {
      "kind": "field",
      "nodeId": "h1",
      "label": "Charge card",
      "field": "config.url",
      "base": "https://pay.acme.com/v1",
      "ours": "https://pay.acme.com/v2",
      "theirs": "https://pay.acme.com/v1-legacy",
      "description": "Charge card · config.url: live \"https://pay.acme.com/v2\" vs document \"https://pay.acme.com/v1-legacy\""
    }
  ],
  "droppedEdges": [],
  "summary": { "added": 1, "removed": 0, "changed": 2, "unchanged": 4, "conflicts": 1 },
  "lint": null
}
```

A conflicted merge **produces no graph** and writes nothing, even with
`apply: true`: git can leave conflict markers in a file because a file with
markers is still a file, and a graph with markers is not a graph. Resolve on the
canvas or pass `strategy: "ours" | "theirs"` — deliberate per request, never a
default.

`lint` carries the linter's verdict on the **merged** graph, because two
individually valid graphs can merge into one that won't run, and after applying
is the worst time to learn that. `droppedEdges` lists connections orphaned by
the merge — debris rather than conflicts, but reported, since quietly deleting a
connection somebody drew is what a merge must never do.

Requires the `manage` scope (it writes a definition) and a non-viewer role.
Applying updates the canvas, not the deployment. `400` for a bad `graph_data`,
strategy or `baseVersion`; `413` past the 500KB cap. From the CLI,
`flowforge merge <id> <file>` wraps this and exits **2** on conflicts. See
[MERGE.md](./MERGE.md).

### Trace a workflow's dataflow

Where each node's data comes from, what reads it, and which config fields let
data leave the system.

```bash
curl -s "https://your-flowforge-host/api/v1/workflows/6f0c…/lineage?node=charge" \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

Without `?node`, the whole map: every node's **origins** and reads, the
**sinks** where data leaves with the origins reaching them, which nodes can read
each secret, and the findings. With `?node=<id>`, one node's **provenance**
(what feeds it, back to the trigger field or API response it started as) and
**impact** (what breaks if it changes).

Origins carry a trust level — `untrusted` (a webhook body or callback payload:
whoever holds the URL wrote it), `external` (an HTTP or model response: a third
party did), `internal` (config, variables, secrets) — and untrusted data
reaching a high-sensitivity sink is the `tainted-sink` finding that also appears
in `lint`.

Two asymmetries are deliberate and worth knowing when reading the output. Taint
**stops at an external boundary**: an HTTP node's body is the far side's answer,
not a function of the URL it was asked for. Impact **does not**: changing the URL
does change the response, so everything downstream really is affected. And a
pinned host (`https://api.acme.com/orders/{{trigger.id}}`) is recorded as a sink
but not reported — only a dynamic authority lets a caller choose the
destination.

Read-only and pure; requires the `read` scope. `flowforge lineage <id>
[--node <id>] [--strict]` wraps it. See [LINEAGE.md](./LINEAGE.md).

### Lint a workflow

The app's 🔎 Issues linter as a CI gate — same rules, same severity contract,
with the workspace's **real context** (secret names, variable names,
sub-workflow targets):

```bash
# Lint the workflow as deployed
curl -s -X POST https://your-flowforge-host/api/v1/workflows/6f0c…/lint \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"

# Lint an exported file against this workflow's workspace (pre-import vetting)
curl -s -X POST https://your-flowforge-host/api/v1/workflows/6f0c…/lint \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d @workflows/nightly-sync.json
```

Response `200` — **`ok` is the gate** (no error-severity issues); warnings
ride along for `--strict` consumers:

```json
{
  "workflowId": "6f0c…",
  "ok": false,
  "issues": [
    { "severity": "error", "code": "unknown-secret",
      "message": "Fetch: secret \"STRIPE_KEY\" does not exist in this workspace", "nodeId": "h1" },
    { "severity": "warning", "code": "unreachable-node",
      "message": "Log result is not connected to any trigger", "nodeId": "o1" }
  ],
  "summary": { "errors": 1, "warnings": 1 }
}
```

Requires the `read` scope — analysis changes nothing. From the CLI:
`flowforge lint <id> [file] [--strict]`.

### Verify the path invariants

`lint` asks *will this run?*. This asks *does it still do what its author swore
it did?* — by checking the workflow's declared invariants against **every
execution the graph admits**, not against the runs it has had.

```bash
curl -s https://your-flowforge-host/api/v1/workflows/6f0c…/guarantees \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

Response `200` — **`ok` is the gate**:

```json
{
  "workflowId": "6f0c…",
  "ok": false,
  "analysed": true,
  "results": [
    {
      "kind": "requires", "node": "charge", "other": "approve",
      "statement": "Charge card never runs unless Approve ran first",
      "status": "violated",
      "message": "Run by hand → Charge card reaches Charge card without Approve",
      "counterexample": ["manual", "charge"]
    },
    {
      "kind": "exclusive", "node": "ship", "other": "refund",
      "statement": "Ship and Refund never both run",
      "status": "holds", "evidence": "In stock? decides between them"
    }
  ],
  "facts": {
    "alwaysRuns": [{ "nodeId": "hook", "label": "Order webhook" }],
    "decisions": [{ "nodeId": "approve", "label": "Approve", "outcomes": ["true", "false"] }]
  },
  "suggestions": [ … ]
}
```

Three kinds, each read left to right: `requires` (*node* never runs unless
*other* ran first), `ensures` (if *node* runs, *other* runs too), and
`exclusive` (*node* and *other* never both run).

**`status: "unknown"` is not a pass.** It means the declaration could not be
checked — a node it names was deleted, or the graph has a cycle and admits no
execution at all — and `ok` is false for it exactly as for a violation. Delete
the approval node and every invariant about it stops failing; a pipeline that
treated that as green would guard nothing forever. `analysed` separately
reports whether the graph could be reasoned about, so a cyclic graph with no
declarations can't be confused with a broken invariant.

`facts` is what is true of the graph regardless of what anyone declared;
`suggestions` are invariants that hold today and look deliberate — a gate
standing in front of something consequential — which is the shortest path from
nothing declared to a useful set.

Declarations also ride the [export document](#export-a-workflow) and are
accepted on [import](#import-a-workflow), so a promotion carries its own
assertions.

Read-only and pure; requires the `read` scope. `flowforge verify <id> [--facts]
[--suggest]` wraps it. See [GUARANTEES.md](./GUARANTEES.md).

### Inferred data schema

What each node in the workflow receives and produces, derived from the runners'
output contracts and propagated across the graph. No run history is consulted,
so a workflow that has never executed still reports a full schema.

```bash
curl -s https://your-flowforge-host/api/v1/workflows/6f0c…/types \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

```json
{
  "workflowId": "6f0c…",
  "order": ["trigger-1", "http-1", "log-1"],
  "nodes": {
    "http-1": {
      "input":  { "described": "{ triggered: boolean, … }", "type": { "kind": "object" } },
      "output": {
        "described": "{ status: number, body: any }",
        "type": { "kind": "object" },
        "fields": [
          { "path": "status", "type": "number", "optional": false },
          { "path": "body",   "type": "any",    "optional": false }
        ]
      }
    }
  },
  "diagnostics": []
}
```

`described` is the human rendering, `type` is the machine-readable lattice value
(stable JSON, so two exports of the same graph are diffable), and `fields`
flattens the pickable `{{node.path}}` references one level past each object.
`diagnostics` carries the same `unknown-field` / `type-error` findings the lint
report includes.

Requires the `read` scope. From the CLI: `flowforge types <id> [--node <id>]
[--json]`. Full reference: [TYPES.md](./TYPES.md).

### Canary releases

Progressive delivery from a pipeline. `GET .../canary` reports the running
release; `recommendation` is `promote`, `rollback`, or `wait` — the value a job
branches on, rather than something to be inferred from a p-value.

```bash
curl -s https://your-flowforge-host/api/v1/workflows/6f0c…/canary \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

```json
{
  "workflowId": "6f0c…",
  "active": true,
  "state": "running",
  "percent": 10,
  "verdict": "healthy",
  "recommendation": "promote",
  "reason": "40 canary runs with no detectable regression",
  "canary": { "runs": 40, "failures": 0, "failureRate": 0,
              "failureRateInterval": { "point": 0, "lower": 0, "upper": 0.087 } },
  "stable": { "runs": 400, "failures": 8, "failureRate": 0.02,
              "failureRateInterval": { "point": 0.02, "lower": 0.01, "upper": 0.039 } },
  "successTest":  { "pValue": 0.83, "significant": false },
  "durationTest": { "pValue": 0.44, "significant": false }
}
```

`POST .../canary/promote` makes the canary definition the deployed one, and
`POST .../canary/rollback` sends every run back to the baseline without moving
or overwriting anything. Both need the **`manage`** scope — the same one
importing a definition needs — so a `trigger` token can start runs but can never
change what runs. A promotion a workspace policy blocks is refused with `422`.

Starting a canary and changing its traffic share are app-only: they are
authoring decisions, and the pipeline's job is to decide whether the release
that is already running is good. Full reference: [RELEASES.md](./RELEASES.md).
From the CLI: `flowforge release <id> [--promote] [--rollback] [--wait N]`,
which exits **0** promote, **1** roll back, **2** keep waiting.

### Trigger a workflow

```bash
curl -s -X POST https://your-flowforge-host/api/v1/workflows/6f0c…/trigger \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"orderId": 42, "amount": 19.99}'
```

The JSON body becomes the run's trigger payload, exactly like a webhook body:
downstream nodes read it as `{{trigger-node-id.orderId}}`.

Response `202`:

```json
{
  "execution": { "id": "e57a…", "workflowId": "6f0c…", "status": "pending" },
  "statusUrl": "/api/v1/executions/e57a…"
}
```

Requires the `trigger` scope. Returns `400` if the workflow has no nodes,
`404` if it doesn't exist or the token's owner isn't a member of its
workspace, and `409` if the run can't be admitted — the workflow is
**paused** (see below), is at its **rate limit** (too many runs started in
the rolling window), or caps concurrent runs with the **reject** policy and
is at its cap. In every `409` case the error message says which; back off and
retry, or (for concurrency) switch the workflow to the **queue** policy to
have runs wait instead.

**Idempotent retries.** Network timeouts make "did my trigger land?" a real
question for CI scripts. Send an `Idempotency-Key` header (any unique string
up to 255 chars — a UUID per logical request works well) and retries become
safe:

```bash
curl -s -X POST …/trigger \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN" \
  -H "Idempotency-Key: deploy-2026-07-09-42" \
  -d '{"orderId": 42}'
```

- A repeat of the same key + body within 24 hours returns the **original
  run** — same execution id, `"replayed": true` in the body, and an
  `Idempotent-Replay: true` header — without enqueuing anything.
- The key is pinned to its request body: the same key with a **different
  body** is rejected with `409`, never silently replayed against the wrong
  input.
- Keys are scoped to the token's owner and the workflow, so two clients (or
  two workflows) can't collide.

**Priority lanes.** Every run enters the queue as `high`, `normal`
(default), or `low`. Add `?priority=` to pick the lane for this run,
overriding the workflow's default (set in the app under Run limits):

```bash
curl -s -X POST "…/trigger?priority=high" \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN" \
  -d '{"orderId": 42}'
```

Priority orders **pickup** — a high run is dequeued before waiting normal
ones — and never preempts runs already executing; within one lane, runs
still execute in submission order. An invalid value is a `400`. From the
CLI: `flowforge trigger <id> --priority high`.

### Pause or resume a workflow

The operational kill switch. While a workflow is paused, **no new real run
starts** at any entry point — this endpoint, the app's Run button, webhook
deliveries, schedule ticks, and error-handler escalations are all held. Runs
already in flight settle normally (stopping mid-run is what cancellation is
for), and **dry runs stay allowed**, so an incident responder can keep testing
a fix. Wrap a deploy or maintenance window: pause before, resume after, and no
cron tick fires a run into a half-migrated system in between.

```bash
curl -s -X POST https://your-flowforge-host/api/v1/workflows/6f0c…/pause \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

Response `200`:

```json
{ "workflowId": "6f0c…", "paused": true, "pausedAt": "2026-07-18T12:00:00.000Z" }
```

Resume with the mirror endpoint:

```bash
curl -s -X POST https://your-flowforge-host/api/v1/workflows/6f0c…/resume \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

Both require the `manage` scope — pausing changes durable workflow state, like
importing a definition, and deliberately not the `trigger` scope, so an
automation token that fires runs can't also disable the workflow. Both are
**idempotent**: pausing an already-paused workflow is a safe no-op that keeps
the original pause, and nothing skipped while paused is retroactively fired on
resume. From the CLI: `flowforge pause <id>` / `flowforge unpause <id>`.

### List a workflow's runs

```bash
curl -s "https://your-flowforge-host/api/v1/workflows/6f0c…/executions?limit=5" \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

Response `200` — run summaries, newest first (no step payloads; poll a single
execution for those). `limit` is 1–100, default 20:

```json
{
  "executions": [
    {
      "id": "e57a…",
      "workflowId": "6f0c…",
      "status": "completed",
      "triggerType": "api",
      "priority": "normal",
      "startedAt": "2026-07-09T09:00:01.000Z",
      "finishedAt": "2026-07-09T09:00:03.412Z",
      "createdAt": "2026-07-09T09:00:00.000Z"
    }
  ]
}
```

Requires the `read` scope.

### Workflow run insights

```bash
curl -s "https://your-flowforge-host/api/v1/workflows/6f0c…/insights?limit=100" \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

Response `200` — a statistical rollup of the workflow's recent runs: duration
percentiles over completed runs, success rate over settled runs, throughput, the
slowest steps, per-run anomaly flags, and SLA compliance (when targets are set).
Dry-runs are excluded. `limit` is 1–500, default 50. See
[docs/INSIGHTS.md](./INSIGHTS.md) for what each field means.

```json
{
  "workflowId": "6f0c…",
  "window": { "limit": 100, "runs": 128, "since": "2026-07-01T…", "until": "2026-07-09T…" },
  "counts": { "total": 128, "completed": 121, "failed": 5, "cancelled": 2, "running": 0 },
  "successRate": 0.9603,
  "sla": {
    "maxDurationMs": 5000, "minSuccessRate": 0.95,
    "durationCompliant": true, "successRateCompliant": true
  },
  "throughput": { "runs": 128, "spanDays": 8.02, "perDay": 15.96 },
  "duration": { "count": 121, "min": 812, "max": 21044, "mean": 1180, "stdev": 640,
    "p50": 1010, "p90": 1450, "p95": 1820, "p99": 3110 },
  "anomalyCount": 1,
  "slowestSteps": [
    { "nodeId": "http-1", "nodeType": "action-http", "runs": 121, "avgDurationMs": 780, "maxDurationMs": 20110 }
  ],
  "recentRuns": [
    { "id": "e91a…", "status": "completed", "durationMs": 21044,
      "anomalyScore": 39.7, "severity": "severe", "isAnomaly": true }
  ]
}
```

Requires the `read` scope.

### Forecast the next run

```bash
curl -s "https://your-flowforge-host/api/v1/workflows/6f0c…/forecast" \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

Response `200` — a predictive estimate of the workflow's next-run duration,
computed as the critical path over each node's historical step timing. `coverage`
says how much of the graph has history. `available: false` (with `reason`) for an
empty or cyclic graph.

```json
{
  "workflowId": "6f0c…",
  "available": true,
  "criticalPath": ["trigger", "fetch", "transform", "notify"],
  "estimatedMs": 1840,
  "estimatedP95Ms": 3120,
  "bottleneck": { "nodeId": "fetch", "nodeType": "action-http", "p50": 1200, "p95": 2400 },
  "coverage": { "nodesWithHistory": 3, "workNodes": 3, "ratio": 1 },
  "concurrency": {
    "cap": 4,
    "makespanMs": 3680,
    "queuedMs": 5100,
    "contention": 2.0,
    "averageParallelism": 5.4,
    "knee": { "cap": 6, "makespanMs": 1900, "idealMakespanMs": 1840 },
    "curve": [{ "cap": 1, "makespanMs": 9200 }, { "cap": 4, "makespanMs": 3680 }],
    "chain": [{ "nodeId": "enrich", "waitedFor": "slot", "queuedMs": 1200, "durationMs": 800 }]
  }
}
```

`estimatedMs` is the critical path — the duration with an execution slot always
free. The engine runs at most `EXEC_MAX_PARALLEL` nodes at once, so `concurrency`
is what will actually happen: the simulated makespan under that cap, how much of
it is nodes **queueing** rather than working, the ceiling on any speedup
(`averageParallelism` — 1.2 means the workflow is mostly a chain and capacity
cannot help it), and the `knee` past which more slots buy nothing.

Add `?cap=N` to model a different cap. It changes nothing on the server — capacity
planning used to be a deploy, and this makes it a query. See
[docs/SCHEDULING.md](./SCHEDULING.md).

Requires the `read` scope.

### Detect drift in what a workflow produces

```bash
curl -s "https://your-flowforge-host/api/v1/workflows/6f0c…/drift" \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

**Output** drift, not definition drift — [`/diff`](#detect-drift-against-an-exported-document)
answers whether the graph still matches the document in git; this answers
whether the data still looks like the data.

Response `200` — the last N runs' recorded step outputs compared against the N
before them, field by field. `available: false` with
`reason: "insufficient-history"` until both windows have enough runs.

```json
{
  "workflowId": "6f0c…",
  "available": true,
  "monitoring": false,
  "window": {
    "recent":   { "runs": 50,  "from": "2026-03-01T…", "to": "2026-03-08T…" },
    "baseline": { "runs": 200, "from": "2026-02-01T…", "to": "2026-03-01T…" }
  },
  "summary": {
    "major": 1, "minor": 1,
    "nodesCompared": 2, "nodesSkipped": 0,
    "fieldsCompared": 14, "fieldsSkipped": 3
  },
  "nodes": [
    {
      "nodeId": "fetch", "nodeLabel": "Fetch orders", "nodeType": "action-http",
      "compared": 9,
      "findings": [
        {
          "nodeId": "fetch", "nodeLabel": "Fetch orders",
          "path": "customer.email",
          "kind": "null-rate", "severity": "major",
          "summary": "customer.email is null in 41.0% of records, was 0.2%",
          "detail": { "baselineRate": 0.002, "recentRate": 0.41, "pValue": 1.2e-14, "test": "two-proportion" }
        }
      ]
    }
  ]
}
```

`kind` is one of `field-missing`, `field-added`, `presence`, `null-rate`,
`type-changed`, `distribution` (two-sample Kolmogorov-Smirnov) or `categories`
(population stability index). `detail` carries the evidence, so a finding never
needs investigating before it can be acted on.

`fieldsSkipped` is reported rather than omitted: a field can be uncomparable
because it has too few samples, because it is an identifier rather than a
category, or because the engine redacted it. A report that hid those would be
claiming a coverage it does not have.

`?recent=N` and `?baseline=N` widen the windows. `flowforge drift <id> --strict`
gates a build on it. See [docs/DRIFT.md](./DRIFT.md).

Requires the `read` scope.

### What a run can do

```bash
curl -s https://your-flowforge-host/api/v1/workflows/6f0c…/effects \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

Every node that reaches outside FlowForge or costs money, with the **decisions
it is control-dependent on** — the question a promotion review opens with.

```json
{
  "workflowId": "6f0c…",
  "available": true,
  "effects": [
    { "nodeId": "score", "label": "Fraud score", "kind": "model",
      "target": "gpt-4o-mini", "always": true, "conditions": [] },
    { "nodeId": "charge", "label": "Charge card", "kind": "http",
      "target": "api.acme.com", "always": false,
      "conditions": [
        { "nodeId": "risky", "label": "High risk?", "type": "condition", "outcome": "false" },
        { "nodeId": "approve", "label": "Approve", "type": "approval", "outcome": "true" }
      ] }
  ],
  "decisions": [
    { "nodeId": "approve", "label": "Approve", "type": "approval",
      "outcomes": [ { "name": "true", "gates": ["charge"] }, { "name": "false", "gates": [] } ] }
  ],
  "summary": { "total": 2, "unconditional": 1, "gated": 1, "dynamicTargets": 0 }
}
```

An effect requires outcome `o` of decision `D` when `D` **dominates** it *and*
exactly one of `D`'s outcomes leads to it. Both halves matter: without the
first, a gate that a second trigger routes around would still be reported as a
gate. `always: true` means no decision gates it — which is a legitimate design
*and* what a routed-around gate looks like, so `flowforge effects --ungated` is
opt-in rather than a default.

`decisions` is the same analysis backwards: for each outcome, which effects it
gates — *if this approval rejects, what can still happen?* `target` is `null`
when the graph does not determine the destination (a templated *authority*,
not merely a templated path). See [docs/EFFECTS.md](./EFFECTS.md).

Requires the `read` scope.

### What a run can ultimately do

```bash
curl -s https://your-flowforge-host/api/v1/workflows/6f0c…/reach \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

The [effect report](#what-a-run-can-do) answers that over **one** graph. A
sub-workflow node breaks it: on the canvas it is one box, at run time it is an
entire other workflow, and *"calls workflow 4f2a"* is true and tells a reviewer
nothing — the workflow they are reviewing can charge a card, three boxes and one
call away.

```json
{
  "available": true,
  "workflowId": "6f0c…",
  "effects": [
    { "label": "Charge card", "kind": "http", "target": "api.acme.com",
      "workflowName": "Fulfilment", "always": false,
      "via": [{ "name": "Fulfilment", "nodeId": "call", "label": "Fulfil order" }],
      "conditions": [
        { "label": "Approve order", "outcome": "true", "workflowName": "Orders" },
        { "label": "In stock?", "outcome": "true", "workflowName": "Fulfilment" }
      ] }
  ],
  "unresolved": [],
  "summary": { "total": 4, "direct": 3, "inherited": 1,
               "unconditional": 1, "workflows": 1, "deepest": 1 }
}
```

**The preconditions are a conjunction.** An effect inside the callee is gated by
the callee's decisions; the call itself is gated by the caller's. Keeping only
the callee's would claim the charge happens whenever the callee decides it
should, ignoring that the caller may never invoke it; keeping only the caller's
would claim it happens on every call. Both are carried, in call order, each
attributed to the workflow it came from.

`summary.direct` is the number the per-graph report would have given, so the
difference is a fact rather than something to work out by counting. `unresolved`
says where the walk stopped — a cycle, the depth bound, or a callee this token
cannot see — and the unexpanded effect stays in the report, because "calls
something I cannot see" is more useful than silence.

`flowforge effects <id> --deep` renders the same thing. See
[docs/EFFECTS.md](./EFFECTS.md#across-the-sub-workflow-boundary).

Requires the `read` scope.

### Are this workflow's checks any good?

```bash
curl -s -X POST https://your-flowforge-host/api/v1/workflows/6f0c…/mutations \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

Every other check answers *does this workflow pass?* This answers the question
underneath: **if it were subtly wrong, would any of them notice?** A suite of
three scenarios that all assert `status == "completed"` passes on a workflow
with its approval gate deleted. Green is not the same as covered.

So a plausible bug is introduced and every check re-run. The operators are
mistakes somebody has actually made — a condition wired backwards, a threshold
off by one, a gate deleted and the graph rewired past it, a step removed — not
random perturbation, because a report full of mutants nobody would write is one
people stop reading.

```json
{
  "available": true,
  "workflowId": "6f0c…",
  "scenarios": 3,
  "guarantees": 1,
  "mutants": [
    { "id": "m1", "operator": "swap-branches", "nodeId": "check",
      "describe": "\"Large order?\" wired backwards — its true and false branches swapped",
      "killed": true, "by": "test", "detail": "a large order is tagged large" },
    { "id": "m2", "operator": "off-by-one", "nodeId": "check",
      "describe": "\"Large order?\" off by one — 100 became 101",
      "killed": false, "by": null, "detail": null }
  ],
  "summary": { "total": 6, "killed": 5, "survived": 1, "score": 83,
               "byLint": 1, "byGuarantee": 1, "byTest": 3 }
}
```

A mutant is killed by whichever check notices first, cheapest-first — `lint`
(free, and by something the author never wrote), `guarantee` (statically, over
every execution the graph admits), then `test` (empirically, on the declared
inputs). Anything still standing **survived**, and the survivors are the report:
not *"coverage is 61%"* but *"the approval gate can be deleted and every one of
your tests still passes."*

Findings are compared against a **baseline** of what the original already fails,
so a mutant is credited only with what its mutation broke — a workflow that
does not lint cannot score a perfect 100 on inherited errors.

**Nothing is written.** Mutants run through the engine's `graphOverride` in
dry-run mode, so no side-effecting node fires, and the dry-run rows are deleted
afterwards.

**The honest limit:** an *equivalent* mutant cannot be killed by anything,
because it does not change behaviour, and detecting those is undecidable in
general. A survivor is evidence of a gap rather than proof of one, which is why
`flowforge mutants` reports and exits 0 by default and `--strict` opts into
failing. See [docs/MUTATION.md](./MUTATION.md).

A POST despite writing nothing, because it *executes*: a surviving mutant costs
a full pass of the scenario suite. Requires the `read` scope.

### Things that must never happen

```bash
curl -s https://your-flowforge-host/api/v1/workflows/6f0c…/assertions \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

[Guarantees](./GUARANTEES.md) prove properties of the **graph**, statically, by
dominance. The properties that break production are about **data and outcomes**,
and no graph analysis reaches them — but thousands of recorded runs would answer
them.

An assertion is a **saved query**: the predicate describes the shape of a run
that must not exist, in the same FXL `POST /workflows/{id}/query` takes. Develop
it against history with `flowforge query`, then pin the same string. Each is
evaluated on the engine's terminal hook against the run that just settled, so
every run is judged exactly once — no watermark to skip a run or replay one.

```json
{
  "workflowId": "6f0c…",
  "assertions": [
    { "id": "as-1", "name": "no 5xx from charge", "enabled": true,
      "predicate": "steps.charge.output.status >= 500",
      "state": "holding", "checked": 412, "violations": 0, "errors": 0 },
    { "id": "as-2", "name": "items non-empty", "enabled": true,
      "predicate": "first(trigger.items) == \"\"",
      "state": "broken", "checked": 0, "violations": 0, "errors": 412,
      "lastError": "first: expected an array" }
  ],
  "summary": { "total": 2, "violated": 0, "broken": 1, "holding": 1, "unchecked": 0 }
}
```

**Gate on `violated + broken`, not on `violated` alone.** An assertion whose
predicate throws on every run reports zero violations, and treating that as
green is exactly the failure this design exists to avoid — so evaluations that
*complete* are counted separately from ones that *throw*, and one with errors
and no successes is `broken`. It has never once worked; it is a gap in the
monitoring rather than a clean bill of health, and it never folds into
`holding`.

`lastViolationExecutionId` is the counterexample — the run that matched.
Alerting is edge-triggered, so a storm of matching runs is one incident and
`violations` records how many there were. `flowforge assertions <id>` exits
non-zero on either state. Authoring is on the session API
(`POST /api/workflows/:id/assertions`, `PUT`/`DELETE /api/assertions/:id`); a
predicate that does not parse is refused rather than stored. See
[docs/ASSERTIONS.md](./ASSERTIONS.md).

Requires the `read` scope.

### Ask a question of run history

```bash
curl -s -X POST https://your-flowforge-host/api/v1/workflows/6f0c…/query \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"where": "status == \"failed\" and steps.charge.output.status >= 500"}'
```

`where` is an **FXL** expression — the same language condition nodes and the
Filter node use, so the whole stdlib is available and there is no second syntax
to learn. It is evaluated against a scope describing one run: `status`,
`triggerType`, `priority`, the three timestamps, computed `durationMs` and
`waitMs`, the recorded `trigger.…` payload, and
`steps.<nodeId>.{status,type,durationMs,error,input,output}`.

```json
{
  "workflowId": "6f0c…",
  "ok": true,
  "runs": [
    { "id": "e57a…", "status": "failed", "triggerType": "webhook",
      "createdAt": "2026-08-01T10:00:00.000Z", "durationMs": 5000, "waitMs": 2000 }
  ],
  "plan": {
    "pushedDown": ["status == \"failed\""],
    "loadedSteps": true,
    "scanned": 240, "matched": 1, "truncated": false, "evaluationErrors": 0
  }
}
```

Conjuncts that map onto execution columns are pushed into SQL — but **every
conjunct is also evaluated by FXL**, so the SQL only narrows the candidate set
and a pushdown bug can cost speed rather than change the answer. That matters
because FXL falls back to string comparison: `undefined >= 400` is *true* and
`null != "failed"` is *true*, while the corresponding SQL drops both rows. Every
clause is therefore widened with `OR <col> IS NULL`.

`plan` explains the answer. An empty `pushedDown` means a full scan — usually a
predicate under a `not` or an `or`, where narrowing the candidate set is not the
same as narrowing the result. `evaluationErrors` counts runs whose evaluation
threw, so "nothing matched" can be told from "the field name is wrong".

**One sharp edge, kept on purpose:** `steps.charge.output.status >= 500` also
matches runs with *no charge step*, because `"undefined" >= "500"`. That is what
a condition node does with the same expression, and a query dialect with
different rules would be worse. Guard with `in`, which on an object is a
`hasOwnProperty` test: `"charge" in steps and steps.charge.output.status >= 500`.

A POST because a predicate is a program, not a parameter. A predicate that does
not parse returns `400` with the character `position`. `flowforge query` exits 0
on matches, 1 on none and 2 on a bad predicate. See
[docs/QUERY.md](./QUERY.md).

Requires the `read` scope.

### Data subject requests

```bash
# Everything held about one person (Art. 15)
curl -s -X POST https://your-flowforge-host/api/v1/subjects/access \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"identifier": "alice@example.com"}'

# Erase it (Art. 17)
curl -s -X POST https://your-flowforge-host/api/v1/subjects/erasure \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"identifier": "alice@example.com", "reason": "Ticket 4821"}'
```

Runs are found through a **pseudonymous index**. A workflow names the trigger
field identifying its data subject (`subject_path`, e.g. `customer.email`) and
the engine stamps each run with `HMAC(pepper, workspace ‖ identifier)` — so the
database never holds the address, and an operator who holds it can still derive
the key. Both endpoints take the identifier in a **body, never a URL**: it is
personal data, and a URL ends up in query logs and proxy logs.

```json
{
  "workspaceId": "b21f…",
  "available": true,
  "certificate": "5f8c1e2a-0b3d-4c5e-8a9f-1b2c3d4e5f60",
  "subjectId": "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  "erasedAt": "2026-08-22T12:00:00.000Z",
  "runs": ["ex-1", "ex-2"],
  "commitments": [
    { "executionId": "ex-1", "digest": "a3f1c9e20b4d5768…" },
    { "executionId": "ex-2", "digest": "7b2e4d81f0a6c395…" }
  ],
  "summary": { "erased": 2, "alreadyErased": 0 }
}
```

Erasure has to coexist with an audit log that is a hash chain and append-only in
the schema. Deleting entries breaks the chain and leaves a `seq` gap — honouring
one request would destroy the evidentiary value of every unrelated entry;
rewriting it proves the chain *can* be rewritten, which is the property it exists
to deny. So erasure **never touches the log**. It empties the run data and
appends, and `GET /api/workspaces/{id}/audit/verify` still returns `ok: true`
afterwards.

The appended entry carries a SHA-256 `commitment` per run to what was removed,
not the content: a hash of data you have destroyed is a receipt, not personal
data. Execution rows survive with a tombstone rather than a `NULL`, because
deleting them would take the proof of the erasure with the thing erased — and
because every reader of those columns should be able to tell *erased on request*
from *never recorded*.

One transaction and idempotent. **Backups are out of scope** — this reaches the
live database, and a snapshot taken yesterday still holds the payload.
`flowforge subject <identifier>` previews; `--erase --yes` does it. See
[docs/PRIVACY.md](./PRIVACY.md).

Requires the `manage` scope.

### What this workflow promises its callers

```bash
# What is the promise, and who depends on it?
curl -s https://your-flowforge-host/api/v1/workflows/6f0c…/contract \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"

# Would importing this file break anybody?
curl -s -X POST https://your-flowforge-host/api/v1/workflows/6f0c…/contract \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @candidate.json
```

A workflow's return type is a promise to every workflow that calls it as a
sub-workflow — and the author who breaks it is not the author who finds out.

```json
{
  "available": true,
  "workflowId": "6f0c…",
  "name": "Fulfilment",
  "before": { "describe": "{ orderId: string, total: number }", "fields": ["orderId", "total"] },
  "after":  { "describe": "{ total: number }", "fields": ["total"] },
  "change": {
    "verdict": "breaking",
    "removed": [{ "path": "orderId", "was": "string" }],
    "widened": [], "weakened": [], "added": []
  },
  "callers": [
    { "workflowId": "a91e…", "name": "Orders", "status": "deployed",
      "breaks": [
        { "nodeId": "call", "label": "Fulfil order", "reference": "call.orderId",
          "missing": "orderId", "reason": "removed", "suggestion": "order_id" }
      ] }
  ],
  "summary": { "verdict": "breaking", "callers": 3, "broken": 1, "references": 1 }
}
```

The rule is **covariance of return types**: a change keeps the promise when
every value the workflow can now return is one its callers were already
prepared to handle. So **narrowing a type is safe and widening it is breaking**,
and a required field going optional is breaking while an optional one becoming
required is not — both the opposite of the intuition from function arguments,
because a return value is something the caller *consumes* rather than supplies.

**Gate on `summary.broken`, not on `change.verdict`.** The verdict describes the
shape; `broken` counts callers with a reference that *stops resolving*. A
contract can narrow with nobody relying on the part that went, and failing a
build for that is how a check earns its way out of a pipeline. `flowforge
contract <id> <file>` exits non-zero on `broken`; `--strict` also fails the
verdict.

The POST body is `graph_data` or a `flow` string, the same document contract as
lint and preview, judged against the **target** workspace so the callers named
are the real ones. A `for-each` caller is listed with no breaks — its output
wraps the contract in an array, which a template path cannot index, so no
specific reference can be named. See [docs/CONTRACTS.md](./CONTRACTS.md).

Requires the `read` scope.

### Is the concurrency cap the right number?

```bash
curl -s "https://your-flowforge-host/api/v1/workflows/6f0c…/capacity?target=5000" \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

Queueing analysis of `max_concurrent_runs`, from three measurements already in
the database: how often runs arrive (`created_at`), how long each holds a slot
(`finished_at − started_at`), and how many slots there are.

```json
{
  "available": true,
  "workflowId": "6f0c…",
  "name": "Order processing",
  "cap": 4,
  "measured": {
    "runs": 336, "windowDays": 7, "arrivalsPerHour": 2,
    "serviceMeanMs": 1800000, "cvSquaredService": 4.1, "cvSquaredArrival": 1.0,
    "observedWaitMeanMs": 4200, "observedWaitP95Ms": 16000,
    "sampled": { "service": 336, "wait": 336 }
  },
  "current": {
    "servers": 4, "stable": true, "utilisation": 0.5,
    "headroom": 2.0, "waitMeanMs": 4000, "waitP95Ms": 15000
  },
  "calibration": {
    "comparable": true, "ratio": 0.95, "verdict": "agrees",
    "observedMs": 4200, "predictedMs": 4000
  },
  "curve": [ { "servers": 2, "stable": false, "utilisation": 1.0, "waitMeanMs": null } ],
  "recommendation": { "targetWaitMs": 5000, "servers": 4, "change": 0, "confident": true },
  "model": {
    "name": "Allen–Cunneen G/G/c", "variabilityFactor": 2.55, "mmcWaitMeanMs": 1570
  }
}
```

The model is **Allen–Cunneen G/G/c**, not M/M/c. M/M/c assumes exponential
service times, and a run that waits on a human approval or retries three times
is nothing of the sort — service CV² in the tens is ordinary. Allen–Cunneen
scales the wait by `(CV²ₐ + CV²ₛ)/2`, which is exactly 1 under the M/M
assumptions and 2.55 in the example above. `model.mmcWaitMeanMs` is what M/M/c
would have said, so the cost of the assumption is a number rather than an
argument.

**Read `calibration` first.** The wait this model predicts is also *recorded* —
`started_at − created_at` is the queueing delay per run — so the report compares
its own prediction at the current cap against what actually happened, and
publishes the gap. A model that agrees with history has earned the
counterfactual it is really being asked for (*what would a cap of 8 buy?*),
which is the one question no measurement can answer. A model that disagrees
still answers, with `recommendation.confident: false`.

`peak` judges the same cap at the rates that actually happened rather than at
the average of them — the busiest hour (does the queue absorb a burst?) and the
busiest day (does it survive sustained load?), both measured directly as a
rolling maximum over the real arrivals. A cap can be comfortable on the mean and
diverging every Monday, and only one of those is worth being woken up about.
`peakRecommendation` sizes for the busiest hour separately from
`recommendation`, because provisioning for one hour a week is a cost decision
the caller gets to make.

`headroom` is the multiple of today's arrival rate at which the cap saturates —
the number to read before anything is on fire. Past saturation `stable` is
`false` and the waits are `null`: the backlog grows without bound, and a large
finite number there would be describing a transient on the way to infinity.

`?target=<ms>` sizes a recommendation, `?cap=N` prices a hypothetical cap
without changing the stored one, `?days=N` widens the window. Below 30 runs the
report refuses (`reason: "not-enough-runs"`) rather than measuring an arrival
rate from a handful of events. `flowforge capacity --target` gates a build on
it. See [docs/CAPACITY.md](./CAPACITY.md).

Requires the `read` scope.

### Where parallel branches collide

```bash
curl -s https://your-flowforge-host/api/v1/workflows/6f0c…/convergence \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

A node with several incoming edges gets its input from `Object.assign` over the
upstream outputs, so when two branches both produce a `status`, exactly one
survives.

```json
{
  "workflowId": "6f0c…",
  "available": true,
  "joins": [
    { "nodeId": "merge", "label": "Combine", "type": "output-log", "arity": 2,
      "mergeOrder": ["billing", "crm"],
      "collisions": [
        { "key": "status", "resolution": "tie-break", "decidedBy": "crm", "sameType": true,
          "contributors": [
            { "nodeId": "billing", "label": "Billing lookup", "handle": null, "depth": 1, "type": "number" },
            { "nodeId": "crm", "label": "CRM lookup", "handle": null, "depth": 1, "type": "number" }
          ] }
      ] }
  ],
  "summary": { "joins": 1, "collisions": 1, "tieBroken": 1, "dataflow": 0, "typeChanging": 0 }
}
```

Merge order is derived from the graph rather than from how it was stored:
contributors are ranked by **longest-path depth**, so a node downstream of
another overrides it — it ran later and saw that value — and no storage layer
can change the answer.

`resolution` is the whole report in one field. `dataflow` means the contributors
sit at different depths and the deeper one wins predictably, which a reader can
work out from the canvas. `tie-break` means they are at the same depth,
genuinely concurrent, the graph is silent, and the canonical edge sort decides —
alphabetically, which is deterministic and is not an opinion about the workflow.
Gate a pipeline on `summary.tieBroken` alone; `flowforge converge --strict` does.

Branches that can never both run — a condition's `true` and `false` handles
wired into one join — are not collisions and are never reported. `decidedBy` is
`null` when which contributor survives itself depends on which branch ran. See
[docs/CONVERGENCE.md](./CONVERGENCE.md).

Requires the `read` scope.

### Workflow dependencies (impact analysis)

```bash
curl -s "https://your-flowforge-host/api/v1/workflows/6f0c…/dependencies" \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

Response `200` — the workflows this one references (`dependsOn`), the workflows
that reference it (`dependedOnBy`), and any stale cross-workflow reference cycle
it sits on (`cycle`, else `null`). Each edge is labelled with how the reference
is made: `sub-workflow`, `for-each`, or `error-handler`. Use it to refuse a
promotion that would undeploy a workflow others still call, or to map a change's
blast radius.

```json
{
  "workflowId": "6f0c…",
  "dependsOn": [
    { "id": "a1b2…", "name": "Send alert", "status": "deployed", "via": ["error-handler", "sub-workflow"] }
  ],
  "dependedOnBy": [
    { "id": "c3d4…", "name": "Nightly rollup", "status": "deployed", "via": ["for-each"] }
  ],
  "cycle": null
}
```

Requires the `read` scope. From the CLI: `flowforge deps <id>` (exits non-zero
on a cycle).

### Preview the schedule

```bash
curl -s "https://your-flowforge-host/api/v1/workflows/6f0c…/schedule?count=3" \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

Response `200` — the next fire times of the workflow's schedule trigger, computed
from its cron expression (UTC, ISO-8601). `scheduled: false` when the workflow has
no schedule trigger; `active` reflects whether the schedule is live (the workflow
is deployed); `reachable: false` for a valid-but-impossible expression (e.g. Feb
30) that never fires. `?count` caps the number of upcoming runs (default 5, max 25).

```json
{
  "workflowId": "6f0c…",
  "scheduled": true,
  "active": true,
  "cron": "0 9 * * 1-5",
  "reachable": true,
  "nextRuns": [
    "2026-01-15T09:00:00.000Z",
    "2026-01-16T09:00:00.000Z",
    "2026-01-19T09:00:00.000Z"
  ]
}
```

Requires the `read` scope.

### Run the test scenarios (CI gate)

```bash
curl -s -X POST "https://your-flowforge-host/api/v1/workflows/6f0c…/tests/run" \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

Response `200` — runs every test scenario defined for the workflow (each a
trigger payload plus FXL assertions over the resulting run's output) through the
engine in dry-run mode, and returns a pass/fail rollup. **`ok` is the gate**:
fail the CI job when it is `false`. Each scenario reports its per-assertion
results so a failure says exactly what broke.

```json
{
  "workflowId": "6f0c…",
  "ok": false,
  "total": 2,
  "passed": 1,
  "failed": 1,
  "scenarios": [
    { "name": "happy path", "passed": true, "runStatus": "completed", "assertions": [
      { "expression": "output.status == \"ok\"", "passed": true }
    ] },
    { "name": "large order", "passed": false, "runStatus": "completed", "assertions": [
      { "expression": "output.total > 1000", "description": "should be big", "passed": false, "error": null }
    ] }
  ]
}
```

Requires the `trigger` scope (it executes the workflow). `flowforge test <id>`
wraps this and exits non-zero on `ok: false`.

### Debug a run (breakpoints as trace points)

Add `?breakAt=` to a trigger and the run pauses before each named node, exposing
the **resolved** config and input — templates substituted, secrets redacted —
at the only moment both exist: after the config was built and before the runner
fired.

```bash
# Start a run that stops before charge-card (or ?breakAt=all for every node)
curl -s -X POST "https://your-flowforge-host/api/v1/workflows/6f0c…/trigger?breakAt=charge-card" \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN" -H "Content-Type: application/json" \
  -d '{"orderId": "ord-8891"}'

# See what it stopped on
curl -s https://your-flowforge-host/api/v1/executions/4e9a…/breaks \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"

# Let it go — optionally with a different config
curl -s -X POST https://your-flowforge-host/api/v1/executions/4e9a…/breaks/b1/resume \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN" -H "Content-Type: application/json" \
  -d '{"action": "continue", "override": {"config": {"url": "https://staging.acme.com/charges"}}}'
```

```json
{
  "executionId": "4e9a…",
  "breaks": [
    {
      "id": "b1",
      "nodeId": "charge-card",
      "nodeLabel": "Charge card",
      "status": "paused",
      "input":  { "orderId": "ord-8891", "amount": 4500 },
      "config": { "url": "https://api.acme.com/v1/charges/ord-8891", "method": "POST" }
    }
  ]
}
```

Polled, printed and immediately resumed, a breakpoint becomes a **trace point**:
the run reports exactly what each node was about to send, in order, without
editing the graph to add logging — which would change the thing being
investigated. `flowforge debug <id> --break <node>` is that loop.

`action` is `continue`, `step` (stop again at the very next node), or `abort`.
An `override` of `{ config, input }` is **merged** over what the node was about
to use, and an overridden input rewrites the step's recorded input so the run's
history says what actually happened.

Three rules are worth knowing before you rely on it:

- **A breakpoint attaches to this submission, never to the workflow.** A
  schedule tick or a webhook delivery of the same workflow has nowhere to read
  one from, so there is no way to leave one running in production.
- **Reading a pause is `read`; resuming one is `trigger`.** Resuming decides
  whether a real call happens and with what — the same category of act as
  starting the run.
- **A pause nobody resumes fails the run.** The wait is bounded
  (`DEBUG_BREAK_TIMEOUT_MS`, default 15 minutes) and it fails rather than
  quietly continuing, because continuing would mean a node ran with nobody
  watching in a session whose whole purpose was that somebody was.

See [ARCHITECTURE.md](./ARCHITECTURE.md#breakpoints).

### Poll an execution

```bash
curl -s https://your-flowforge-host/api/v1/executions/e57a… \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

Response `200`:

```json
{
  "execution": {
    "id": "e57a…",
    "workflowId": "6f0c…",
    "status": "completed",
    "triggerType": "api",
    "startedAt": "2026-07-08T09:00:01.000Z",
    "finishedAt": "2026-07-08T09:00:03.412Z"
  },
  "steps": [
    {
      "id": "…", "node_id": "t", "node_type": "trigger-webhook",
      "status": "succeeded", "input_json": "…", "output_json": "…",
      "error": null, "started_at": "…", "finished_at": "…"
    }
  ]
}
```

`execution.status` progresses `pending → running → completed | failed |
cancelled`. Step inputs/outputs have workspace-secret values already redacted
by the execution engine before persistence.

Requires the `read` scope.

### Where a run's time went

```bash
curl -s https://your-flowforge-host/api/v1/executions/e57a…/schedule \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

Response `200` — the measured split between work and **waiting for an execution
slot**, plus what the same run would have taken at other caps. `available: false`
for a run with no recorded steps.

```json
{
  "executionId": "e57a…",
  "available": true,
  "cap": 4,
  "observed": {
    "makespanMs": 14200,
    "workMs": 38000,
    "queuedMs": 6100,
    "utilisation": 0.669,
    "chain": [
      { "nodeId": "fetch", "waitedFor": null, "queuedMs": 0, "durationMs": 900 },
      { "nodeId": "enrich", "waitedFor": "slot", "blockedBy": "score", "queuedMs": 2400, "durationMs": 3100 }
    ]
  },
  "idealMakespanMs": 8100,
  "atCap": [{ "cap": 1, "makespanMs": 38000 }, { "cap": 6, "makespanMs": 8600 }],
  "perNode": {
    "enrich": {
      "startMs": 3300, "finishMs": 6400, "readyMs": 900, "queuedMs": 2400,
      "durationMs": 3100, "occupiedSlot": true,
      "cause": { "nodeId": "score", "kind": "slot" }
    }
  }
}
```

The critical path already names the chain of steps that set a run's duration. It
cannot explain a node that was ready at 0.9s and started at 3.3s, because the
answer is not in the graph — the node was waiting for capacity, and the node
holding it (`score` here) has no edge to it. Every wait is therefore labelled
`data` (a predecessor had not finished) or `slot` (it had, and this is who was
in the way).

`idealMakespanMs` is the same work at unlimited capacity — the floor the cap kept
the run from. A pipeline can gate on the ratio; `flowforge contention <id> --max
1.5` does exactly that. See [docs/SCHEDULING.md](./SCHEDULING.md).

Requires the `read` scope.

### Compare two runs

```bash
curl -s https://your-flowforge-host/api/v1/executions/e57a…/compare/f81b… \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

Diffs two runs of the same workflow node by node. Response `200`:

```json
{
  "base":  { "id": "e57a…", "status": "completed", "durationMs": 2412 },
  "other": { "id": "f81b…", "status": "failed",    "durationMs": 9101 },
  "nodes": [
    {
      "nodeId": "http-1", "nodeType": "action-http",
      "base":  { "status": "succeeded", "durationMs": 800,  "output": { "status": 200 }, "error": null },
      "other": { "status": "failed",    "durationMs": 7500, "output": null, "error": "HTTP 500: …" },
      "statusChanged": true, "outputChanged": true, "durationDeltaMs": 6700
    }
  ],
  "summary": {
    "nodesCompared": 4, "onlyInBase": 0, "onlyInOther": 0,
    "statusChanges": 1, "outputChanges": 1, "slowestRegression": "http-1"
  }
}
```

Output equality is structural (key order ignored) over the persisted,
secret-redacted rows; `durationDeltaMs` is `other − base`, so positive means
the other run was slower there, and `summary.slowestRegression` is the node
with the largest positive delta. Returns `400` if the two executions belong
to different workflows. Requires the `read` scope.

### Cancel an execution

```bash
curl -s -X POST https://your-flowforge-host/api/v1/executions/e57a…/cancel \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

Response `202`:

```json
{
  "execution": { "id": "e57a…", "workflowId": "6f0c…", "status": "cancelled" },
  "cancelling": false
}
```

A run that is still queued is cancelled immediately. A run already executing is
stopped **cooperatively**: the node currently in flight finishes, everything
not yet started is skipped, and the run finalizes as `cancelled` (the response
then carries `"cancelling": true` while that happens — keep polling the
execution to observe the terminal status).

Requires the `trigger` scope. Returns `409` if the run has already finished.

### Resume an execution

```bash
curl -s -X POST https://your-flowforge-host/api/v1/executions/e57a…/resume \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

Continues a **failed or cancelled** run from where it stopped. A fresh
execution is started; steps that already succeeded in the source run are
**reused** (step status `reused`) rather than re-executed — an approval gate
that was already granted is not asked twice — and only the failed remainder
runs again.

Response `202`:

```json
{
  "execution": { "id": "f81c…", "workflowId": "6f0c…", "status": "pending" },
  "statusUrl": "/api/v1/executions/f81c…",
  "resumedFrom": "e57a…"
}
```

Poll `statusUrl` exactly like a triggered run. Requires the `trigger` scope.
Returns `409` if the source run is not failed or cancelled.

Like replay, a resume runs the workflow's **current** definition: an edited or
replaced node has no matching prior step, so it re-executes — and everything
downstream of any node that re-executes runs fresh instead of being reused.

### Roll back an execution

Resume re-runs what didn't finish; **rollback undoes what did**. A failed run
whose workflow declares compensations unwinds automatically — this endpoint
exists for the case that couldn't: the compensating endpoint was itself broken,
the run landed `partial`, and someone has since fixed it.

```bash
curl -s -X POST https://your-flowforge-host/api/v1/executions/e57a…/rollback \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

```json
{
  "executionId": "e57a…",
  "outcome": "completed",
  "compensations": [
    { "nodeId": "refund", "targetNodeId": "charge", "status": "succeeded", "attempts": 2 }
  ]
}
```

Only compensations that have **not already succeeded** are run, so retrying is
safe and never double-undoes — double-refunding a customer while cleaning up
after a failure is worse than the failure was. `outcome` is `completed` or
`partial`.

Requires the `trigger` scope, not `read`: this fires real, irreversible side
effects at real systems. Returns `409` if the run is still going, succeeded, or
has nothing outstanding. The run detail (`GET /executions/:id`) carries
`rollbackStatus` and the `compensations` list for polling. From the CLI,
`flowforge rollback <id> --yes` wraps it and exits non-zero on a partial unwind.
See [ROLLBACK.md](./ROLLBACK.md).

### List approval requests

```bash
curl -s "https://your-flowforge-host/api/v1/approvals?status=pending" \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN"
```

Approval-gate requests across every workspace the token owner belongs to,
newest first. `status` filters by `pending` (default), `approved`,
`rejected`, `timed-out`, or `cancelled`. Requires the `read` scope.

```json
{
  "approvals": [
    {
      "id": "a1b2…",
      "executionId": "e57a…",
      "workflowId": "6f0c…",
      "workflowName": "Production deploy",
      "status": "pending",
      "message": "Deploy v2.3.1 to production?",
      "requestedAt": "2026-07-09T12:00:00.000Z",
      "expiresAt": "2026-07-09T16:00:00.000Z"
    }
  ]
}
```

### Approve or reject a waiting run

```bash
curl -s -X POST https://your-flowforge-host/api/v1/approvals/a1b2…/respond \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"decision": "approve", "note": "LGTM"}'
```

Records a response on a pending gate. Requires the dedicated **`approve`
scope** — a token that can trigger runs cannot implicitly wave them through
its own gates. `404` for unknown ids or non-members.

**Do not infer the decision from a 2xx.** A gate that declares a quorum may
not settle on this response, so the outcome is in `progress`:

```json
{
  "approval": { "id": "a1b2…", "status": "pending", "quorum": 3 },
  "progress": { "settled": false, "status": "pending", "approvals": 1, "needed": 3 }
}
```

| Status | Meaning |
|---|---|
| `200` | The gate settled — `progress.status` is `approved` or `rejected`, and the run has continued down that branch. |
| `202` | The response was recorded and the gate is **still open**. A client treating every 2xx as "approved" would otherwise act on a half-met quorum. |
| `403` | Refused, with `reason`: `viewer`, `role` (the gate requires an owner), or `separation-of-duties` (you started this run). |
| `409` | Already settled (`reason` absent), or you have already responded (`reason: "already-responded"`, with the current `progress`). |

A single **rejection** settles the gate whatever the quorum, and one person
counts once. See [docs/APPROVALS.md](./APPROVALS.md).

### Deliver a callback to a waiting run

A run paused at a **Wait for Callback** node resumes when your system POSTs
to the node's one-time callback URL. The URL isn't under `/api/v1` and needs
**no token** — the 48-hex-char callback token in the path is the whole
credential, minted per run per node and dead once the run settles:

```bash
curl -s -X POST https://your-flowforge-host/api/callbacks/<token> \
  -H "Content-Type: application/json" \
  -d '{"jobId": "abc", "status": "done"}'
```

Your system learns the URL because the workflow sends it: an upstream node
(usually the HTTP request that kicks off your async job) includes
`{{callbacks.<node-id>}}` in its payload. The JSON body becomes the wait
node's `payload` output on the **received** branch.

Responses: `202` accepted (even if the reply arrives before the run reaches
the wait node — it's stored and adopted the moment the node starts waiting),
`409` if the callback was already delivered (first delivery wins; the
original payload is untouched), `410` if the wait timed out or the run
settled, `404` for an unknown token.

## Receiving events (outbound webhooks)

Instead of polling, a workspace can push its events to you: add a
subscription on the workspace's **Webhooks** page (endpoint URL + event
patterns like `execution.failed`, `workflow.*`, or `*`). FlowForge then POSTs
each matching event to your endpoint:

```json
{
  "id": "d3b0c44a-…",
  "type": "execution.failed",
  "createdAt": "2026-07-09T12:00:00.000Z",
  "data": {
    "event_type": "execution.failed",
    "entity_type": "execution",
    "entity_id": "…",
    "entity_name": "Nightly sync",
    "actor_display_name": null,
    "metadata": { "workflowId": "…", "error": "…" },
    "created_at": "2026-07-09T12:00:00.000Z"
  }
}
```

Delivery semantics:

- **At-least-once, in order of due time.** Failed deliveries retry with
  exponential backoff (30s, 2m, 8m, 32m) up to 5 attempts. The `id` is stable
  across retries and manual redeliveries — deduplicate on it.
- **Answer fast with a 2xx.** Anything else (including a timeout after 10s)
  counts as a failure and schedules a retry.
- **Every delivery is signed** with the subscription's `whsec_…` secret
  (shown once at creation), using the same scheme as inbound webhook
  triggers:

  ```
  X-FlowForge-Timestamp: <unix seconds>
  X-FlowForge-Signature: v1=<hex>
  X-FlowForge-Event:     <event type>
  X-FlowForge-Delivery:  <delivery id>
  ```

  where the signature is `HMAC-SHA256(secret, "<timestamp>.<raw body>")` over
  the exact raw request bytes. Verify with a constant-time comparison and
  reject timestamps outside your tolerance window (FlowForge uses 5 minutes)
  to block replays:

  ```js
  const crypto = require('crypto')

  function verify(req, rawBody, secret) {
    const ts = req.headers['x-flowforge-timestamp']
    const sig = req.headers['x-flowforge-signature']
    if (!ts || !sig || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false
    const expected = 'v1=' + crypto.createHmac('sha256', secret)
      .update(`${ts}.`).update(rawBody).digest('hex')
    return sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  }
  ```

Use the **Send test** button (or the delivery log's **Redeliver**) on the
Webhooks page to exercise your endpoint end to end.

## Errors

All errors use the same shape as the rest of the API:

```json
{ "error": "Human-readable message" }
```

| Status | Meaning                                                     |
|--------|-------------------------------------------------------------|
| 401    | Missing, malformed, revoked, or expired token               |
| 403    | Token is valid but missing the required scope               |
| 404    | Resource doesn't exist (or isn't visible to the token owner)|
| 429    | Rate limit exceeded                                         |

## A complete example: trigger and wait

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE=https://your-flowforge-host
EXEC_ID=$(curl -s -X POST "$BASE/api/v1/workflows/$WORKFLOW_ID/trigger" \
  -H "Authorization: Bearer $FLOWFORGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source": "ci"}' | python -c 'import json,sys; print(json.load(sys.stdin)["execution"]["id"])')

while :; do
  STATUS=$(curl -s "$BASE/api/v1/executions/$EXEC_ID" \
    -H "Authorization: Bearer $FLOWFORGE_TOKEN" | python -c 'import json,sys; print(json.load(sys.stdin)["execution"]["status"])')
  [ "$STATUS" = completed ] && echo "run succeeded" && exit 0
  [ "$STATUS" = failed ] && echo "run failed" && exit 1
  sleep 2
done
```
