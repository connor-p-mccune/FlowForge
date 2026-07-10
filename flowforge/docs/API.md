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

A token acts as its owning user: it can only see workflows in workspaces the
owner belongs to. Tokens can be revoked at any time from Settings, and can be
created with an expiry (1–365 days).

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
workspace.

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
      "startedAt": "2026-07-09T09:00:01.000Z",
      "finishedAt": "2026-07-09T09:00:03.412Z",
      "createdAt": "2026-07-09T09:00:00.000Z"
    }
  ]
}
```

Requires the `read` scope.

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
