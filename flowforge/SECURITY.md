# Security

This document describes FlowForge's security posture as of the **Phase 7 —
Security Hardening** pass: the threat model, the controls that are implemented,
and the items that are deliberately deferred (with rationale).

It is a living document — update it whenever a control is added, changed, or a
deferred item is picked up.

---

## Threat model

FlowForge lets authenticated users build workflows from a palette of nodes and
trigger them manually or via public webhooks. Each workflow runs server-side in a
Bull worker. The notable trust boundaries and the threats against them:

| # | Threat | Vector | Disposition |
|---|--------|--------|-------------|
| T1 | **Code injection via workflow nodes** | A user crafts a `transform` template, `condition` operand, or `{{...}}` placeholder hoping it is `eval`'d server-side (e.g. `require('fs')`, `process.exit()`). | **Mitigated** — there is no code-evaluation path (see below). |
| T2 | **Credential brute-force / stuffing** | Automated guessing against `POST /api/auth/login`, or mass account creation against `/api/auth/register`. | **Mitigated** — bcrypt + strict rate limiting. |
| T3 | **Webhook abuse** | The public `POST /api/webhooks/:key` trigger is flooded, or fired by someone who obtained the key. | **Mitigated** — unguessable key + rate limiting + optional per-webhook HMAC signatures with timestamp-bound replay protection (see below). |
| T4 | **Cross-origin / browser attacks** | A malicious site calls the API with a victim's session, or injects content. | **Mitigated** — CORS allow-list, security headers, tokens in `Authorization` (not cookies). |
| T5 | **SQL injection** | User input reaches a SQL query. | **Mitigated** — all queries use `better-sqlite3` prepared statements. |
| T6 | **Resource exhaustion / DoS** | Oversized request bodies or enormous graphs. | **Mitigated** — body cap + per-field/array size limits. |
| T7 | **Server-Side Request Forgery (SSRF)** | The `action-http` / `action-slack` nodes fetch a user-supplied URL server-side, reaching internal services or cloud metadata. | **Mitigated** — scheme + private/reserved-IP egress guard on both nodes (DNS-rebinding residual noted in *Deferred*). |
| T8 | **Real-time data exposure / tampering** | An authenticated user joins another workspace's workflow room over Socket.io to read live execution data, comments, and edits, or to inject collaboration events. | **Mitigated** — workflow-room membership check + relay gating. |
| T9 | **Credential theft from stored workflows** | API keys pasted into node configs land in `graph_json`, execution step logs, and exports — one database leak exposes every integration. | **Mitigated** — encrypted workspace secrets + log redaction (see below). |
| T10 | **API token compromise** | A personal access token for the public `/api/v1` API leaks (CI logs, dotfiles) and is replayed. | **Mitigated** — hash-only storage, scopes, expiry, revocation, per-token rate limit. |
| T11 | **Operational-data disclosure via metrics** | `GET /metrics` (Prometheus) exposes traffic patterns and run volumes to anyone who can reach the port. | **Mitigated** — metric labels are route *patterns* (never resource ids or user data), and setting `METRICS_TOKEN` gates scrapes behind a bearer token; recommended whenever the server has a public domain. |
| T12 | **Status-badge surface** | `GET /api/workflows/:id/badge.svg` is unauthenticated (embedded by a caching image proxy), so it could leak run status or confirm which workflow ids exist. | **Mitigated** — opt-in per-workflow token compared in constant time; a missing/invalid token returns a neutral `unknown` badge with `200` (no existence oracle); output is XML-escaped; rate-limited; dry runs excluded. |
| T13 | **Governance controls silently disabled** | Workspace policies gate what may be deployed. An attacker (or a hurried teammate) disables a rule, ships something it would have blocked, and re-enables it. | **Mitigated** — policy management is owner-only; create/update/delete are appended to the tamper-evident audit log, with disabling called out explicitly in the entry's metadata; a policy that fails to evaluate **fails closed** rather than passing. |
| T14 | **Deliberate faults reaching production** | A chaos profile injects failures. Armed carelessly (or maliciously) against real traffic it is a self-inflicted outage that looks like a dependency problem. | **Mitigated** — profiles are scoped to test runs by default; widening one to real runs is owner-only, audited, and announced in the workspace feed; every profile carries a mandatory expiry capped at 7 days; injected failures are labelled `[chaos]` and counted separately on `/metrics`, so they are never mistaken for an incident. |
| T15 | **Release gate bypass via canary** | A canary sends real traffic to an undeployed definition, which would otherwise route around the deploy-time policy gate. | **Mitigated** — starting a canary and promoting one both run the same policy check a deploy does; a resumed run re-executes its original definition; dry runs never enter the experiment. |
| T16 | **Compensations as an attack surface** | Compensating actions fire *automatically* when a run fails, are irreversible (refunds, deletions), and run outside the DAG — so a graph edit that adds one is a way to make a side effect happen by simply breaking a workflow. The mirror risk is a compensation firing against work it does not own. | **Mitigated** — a compensation runs only for a step that **succeeded in this run**, which excludes `cached`/`reused` steps whose effects belong to an earlier execution (enforced by the same column that records completion order, so the rule cannot drift from the data). Its config is templated from the run's *persisted, redacted* outputs, so a secret an API echoed back cannot reach it. The manual endpoint requires a non-viewer with the `trigger` scope, refuses a run that is not settled, never re-runs a compensation that already succeeded, and is written to the tamper-evident audit log (`execution.rolled_back`). `rollback_policy: "off"` is an operator kill switch, and a partial unwind is announced in the workspace feed rather than left silent. |
| T17 | **Caller-controlled request destinations (SSRF by graph)** | T7 blocks private/reserved IPs at egress, but a workflow whose HTTP URL, email recipient, Slack webhook or sub-workflow target is built from `{{trigger.*}}` lets whoever POSTs the webhook choose where the server sends data — invisible on a canvas. | **Mitigated (detective)** — `services/lineage.js` traces every value to its origin and reports untrusted data reaching a high-sensitivity sink as a lint finding, in the Issues panel, `flowforge lint`, and `flowforge lineage --strict` as a CI gate. Detection, not prevention: the egress guard (T7) is the control, and a [workspace policy](docs/POLICIES.md) over approved hosts is what *refuses* the deploy. Deliberately precise — a pinned authority (`https://api.acme.com/{{trigger.id}}`) is not reported, because a check that fires on correct code is one people turn off. |
| T18 | **Merge as a definition-tampering vector** | `POST /api/v1/workflows/:id/merge` rewrites a workflow definition from outside the app, and a merge that silently resolved conflicts could slip a change past code review. | **Mitigated** — requires the `manage` scope *and* a non-viewer role; previews unless `apply` is set; a conflicted merge writes **nothing at all**, so a change can never be silently chosen; taking a side (`ours`/`theirs`) is explicit per request; the merged graph is linted before it lands; and every applied merge is appended to the audit log (`workflow.merged`) with its base version, strategy and summary. Merging updates the canvas only — going live still requires a deploy, which is where the policy gate runs. |
| T19 | **Prompt injection — the model as a confused deputy** | An AI node classifies or extracts from data an outsider wrote (a webhook body). Text in that data can read as instructions, so whoever POSTs the webhook can steer the model — and if the answer decides where a request goes or which branch runs, they have steered the workflow. | **Mitigated (detective + containment)** — `services/lineage.js` reports the *composition* that is actually dangerous: an untrusted origin reaching a prompt **and** the answer influencing a high-sensitivity sink or a routing node. Untrusted data in a prompt alone is not reported, because that is what an AI node is for. At the boundary, the AI service applies two containments to every AI node: untrusted text is fenced with a **per-call random delimiter** and declared to be data (a fixed `"""` fence is one a payload can close), and a classification resolves to one of the **declared labels or fails** — so an injection is confined to a choice the author already enumerated instead of emitting a value no condition was written for. Extraction is projected onto the declared fields for the same reason. Not prevention: an injection can still pick a different declared label, which is why the finding exists too. |
| T20 | **Definition tampering between review and import** | The promotion path is `export → git → review → CI → import`. A `manage` token can import **any** document, so a leaked token — or a commit pushed to the release branch after approval — lands a definition nobody reviewed. | **Mitigated** — a document may carry a detached **Ed25519 signature** over the graph's *semantics* (`services/artifactSigning.js`), and a workspace keeps the keys it trusts (`services/trustStore.js`, owner-only, revoked rather than deleted). An import records its verdict, the signing key's fingerprint and the graph's digest in the tamper-evident audit log. A signature that fails to verify is refused **regardless of configuration** — enforcement governs only whether *unsigned* imports are accepted. Signing is offline (`flowforge keygen` / `flowforge sign`) so a signing key never touches a server. Residual: a signature is transferable — it proves who approved a definition, not that they intended this import; the import still lands a draft, so deploying remains a separate act. |
| T21 | **Personal data accumulating in run history** | A webhook body carries an email, a name, an address. None of it is a credential, so none of it is encrypted — and all of it lands verbatim in `execution_steps`, in the run detail panel, in the `exec-update` every watching collaborator receives, and in that database's backups, for as long as history is kept. Nobody chose to store it there; it is a side effect of recording runs. | **Mitigated (opt-in)** — a workflow declares which trigger fields are personal (`services/redaction.js`) and their **values** join the same scrubber the decrypted secrets build, so a declared email is masked in the trigger's own step, in a request body that interpolated it, and in a response that echoed it back. Masking by *location* would scrub one of those. Values resolve from the trigger payload at run start; a declaration naming a node's output is a lint **error**, because a redaction rule that silently matches nothing is worse than none. Explicitly **not** a boundary control: the value still flows through the engine and a node that sends it to an API still sends it — this governs what FlowForge keeps and shows, and the panel says so. Retention (`EXECUTION_RETENTION_DAYS`) is the complementary control for what is already stored. |

---

## Implemented controls

### Expression safety — no server-side code execution (T1)

FlowForge has **no `eval`, no `new Function`, and no `vm`** anywhere in the
server. User-controlled expression surfaces are non-evaluating by design:

- **`transform` node** (`services/nodeRunners/transform.js`) — runs `JSON.parse`
  on the template. Unparseable input is wrapped as `{ value: <string> }` and
  returned as inert data. It is never executed.
- **`condition` node** (`services/nodeRunners/condition.js`) — a fixed switch over
  a known operator set (`equals`, `not_equals`, `contains`, `greater_than`,
  `less_than`). Unknown operators throw. Operands are only ever string/number
  compared.
- **`{{node-id.field}}` resolver** (`services/executionEngine.js`) — substitutes
  values looked up by a path grammar restricted to `[\w-.]`. Anything containing
  parentheses, quotes, or spaces is not a placeholder and is left verbatim; it is
  never interpreted.

Because no evaluator exists, **no sandbox library (vm2 / isolated-vm / expr-eval)
was introduced** — adding one would expand the attack surface for a capability we
do not offer (and `vm2` in particular is deprecated with known sandbox escapes).

Locked in by regression tests: `server/src/__tests__/sandbox.test.js` (proves
`require('fs')`, `process.exit()`, and `constructor.constructor(...)` payloads are
inert).

### Authentication & passwords (T2)

- Passwords hashed with **bcrypt** (cost factor 10) — `routes/auth.js`.
- Registration enforces a **minimum password length of 8** (the `validate` schema
  in `routes/auth.js`), in addition to the existing ≤ 200 cap.
- Auth via **JWT** (HS256) signed with `JWT_SECRET`, **`expiresIn: '7d'`**.
- Tokens are sent in the `Authorization: Bearer` header (not cookies), which
  sidesteps CSRF on the API.
- Login responses are uniform (`401 Invalid credentials`) for both unknown email
  and wrong password, avoiding user enumeration.
- Socket.io connections are authenticated in the handshake (`socket/index.js`):
  the JWT is verified before any event handler is registered; missing/invalid
  tokens are rejected.

### Workspace authorization (roles)

Authorization inside a workspace is role-based (`services/workspaceRoles.js`):
**owner** manages the workspace itself (members, secrets, variables,
subscriptions, status pages, deletion), **member** builds and runs workflows,
and **viewer** is read-only — full visibility (including live execution
streams) plus commenting, with every state-changing operation refused.

- **Two-layered responses, deliberately.** Non-members still get `404` on
  everything (a workspace's existence is never disclosed), while a member
  whose role is insufficient gets `403` — they can see the resource; the
  *operation* is what's forbidden.
- **Uniform across surfaces.** The same check guards the session API, the
  public API (a token acts as its owner, so scopes bound what a token may
  *try* and roles bound what its owner may *do* — a viewer's `trigger`-scoped
  token cannot start runs), and the Socket.io relay (a viewer's node/edge
  events are dropped server-side; presence still streams).
- **Ownership is never granted by invitation.** Invites top out at `member`;
  minting an owner is a separate owner-only role-change route with a
  last-owner guard, and every role change lands in the activity feed.
- Approval-gate authorization lives in the shared `services/approvals.js`, so
  the session and public respond endpoints cannot drift.

Tested in `__tests__/workspaceRoles.test.js` and the socket suite.

### Rate limiting (T2, T3)

IP-based limits via `express-rate-limit` (`middleware/rateLimit.js`). On exceed:
`429` with the standard `{ error }` JSON body and `RateLimit-*` headers.

| Endpoint | Limit (default) | Purpose |
|----------|-----------------|---------|
| `POST /api/auth/login` | 5 / 15 min / IP | Brute-force / credential stuffing |
| `POST /api/auth/register` | 5 / 15 min / IP | Signup spam |
| `POST /api/webhooks/:key` | 60 / min / IP | Webhook abuse / floods |
| `POST /api/ai/suggest`, `/api/ai/generate` | 30 / min / **user** | LLM cost abuse (keyed off the authenticated user, not IP) |
| `/api/v1/*` (public API) | 120 / min / **token** | Runaway integrations (keyed off the presented bearer credential) |

All limits are env-tunable (`AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS`,
`WEBHOOK_RATE_LIMIT_MAX`, `WEBHOOK_RATE_LIMIT_WINDOW_MS`, `AI_RATE_LIMIT_MAX`,
`AI_RATE_LIMIT_WINDOW_MS`). In production
`index.js` sets `trust proxy = 1` so limits key off the real client IP behind
Railway's proxy (one hop only — `X-Forwarded-For` cannot be spoofed). Tested in
`server/src/__tests__/rateLimit.test.js`.

### Security headers (T4)

`helmet()` is applied early in `index.js` with API-appropriate defaults
(`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, HSTS, etc.,
and removal of the `X-Powered-By` fingerprint).

**`contentSecurityPolicy` is intentionally disabled.** This service returns only
JSON and hosts Socket.io — it serves no HTML or scripts, so a server-set CSP
protects nothing here, and the restrictive default policy would interfere with
the Socket.io transport and the cross-origin browser client. CSP belongs on the
frontend host (nginx / Vercel), which serves the actual app shell. Verified in
`server/src/__tests__/securityHeaders.test.js`.

### Input validation & payload limits (T6)

- Global JSON body cap: **2 MB** (`express.json({ limit: '2mb' })`); oversize
  bodies return `413`.
- Schema validation middleware (`middleware/validate.js`) enforces type, length,
  pattern, and array-size rules per route. Current caps:

  | Field | Limit |
  |-------|-------|
  | workflow `name`, workspace `name`, webhook `name` | ≤ 200 chars |
  | workflow `description` | ≤ 2000 chars |
  | graph `nodes` / `edges` | ≤ 2000 / ≤ 5000 items |
  | `email` / `password` / `displayName` | ≤ 320 / ≤ 200 / ≤ 100 chars |
  | any unspecified string field | ≤ 10000 chars (default cap) |

  Every request body that persists user strings goes through `validate(...)`.

### CORS (T4)

The allowed origin is resolved from `FRONTEND_URL` (comma-separated list
supported) in `config/cors.js`, shared by both the REST layer and Socket.io. It
falls back to `*` only when `FRONTEND_URL` is unset (local dev / docker-compose).
In production with `FRONTEND_URL` set, the origin is restricted and `credentials`
is enabled. `index.js` logs a loud warning if it starts in production while CORS
is still `*`.

### SQL injection (T5)

All database access uses `better-sqlite3` **prepared statements** with bound
parameters. No user input is interpolated into SQL strings anywhere in the
codebase.

### Server-side request forgery (SSRF) egress guard (T7)

The two node runners that fetch a **user-supplied URL** — `action-http`
(`nodeRunners/httpRequest.js`) and `action-slack` (`nodeRunners/sendSlack.js`) —
route the request through `services/ssrfGuard.js`, which:

- restricts the scheme to `http`/`https`;
- resolves the hostname and **rejects any address in a private, loopback,
  link-local, CGNAT, or reserved range** (IPv4 and IPv6, including IPv4-mapped and
  NAT64 forms), so `169.254.169.254` (cloud metadata), `127.0.0.1`,
  `10/172.16/192.168`, and the internal `redis`/`ai-service` hosts are unreachable;
- re-runs the check on **every redirect hop**, so a public URL can't 30x-redirect
  the server onto an internal address.

Enforced in dev/prod; skipped under `NODE_ENV=test` unless `ENABLE_SSRF_GUARD=true`
(the runner suites hit `127.0.0.1` servers). Tested in `__tests__/ssrfGuard.test.js`.
A residual DNS-rebinding window remains — see *Deferred*.

**Outbound webhooks** (`services/eventDispatcher.js`) are the third
user-supplied-URL surface: a workspace owner points a subscription at an
external endpoint and the server POSTs events to it. Deliveries go through the
same `safeFetch` guard, and the subscription routes additionally reject
blocked URLs at creation time (`routes/subscriptions.js`). Every delivery is
HMAC-signed with a per-subscription secret (same timestamped scheme as T3's
inbound signatures, shown once at creation, never returned by the API), so
receivers can authenticate FlowForge and reject replays. Creating, editing,
redelivering, and test-pinging subscriptions is workspace-owner-only. Tested
in `__tests__/eventDispatcher.test.js` and `__tests__/eventSubscriptions.test.js`.

### Encrypted workspace secrets (T9)

Workspace secrets (`routes/secrets.js` + `services/secretVault.js`) give node
configs a safe place for credentials, referenced as `{{secrets.NAME}}`:

- **AES-256-GCM at rest, under envelope encryption** — each secret gets its own
  random 256-bit data key (DEK); the value is encrypted under the DEK, and the
  DEK is encrypted ("wrapped") under a key encryption key (KEK) from the ring.
  GCM's auth tag makes a tampered row — or a swapped wrapped key — fail closed
  instead of decrypting to garbage.
- **Key rotation without an outage.** The first version encrypted every value
  directly under one derived key, which meant changing that key made every
  stored credential undecryptable at the same instant: re-enter every secret by
  hand, from wherever it originally came from, while production is down. A vault
  that cannot rotate is a vault with an expiry date. `SECRETS_KEY_RING` now holds
  `id:material` entries and `SECRETS_ACTIVE_KEY` names the one new writes use;
  decryption looks the KEK up **by the id stored on the row**, so old and new
  keys coexist and there is no instant at which a read fails. Add the key, flip
  the active id, re-encrypt at leisure, retire the old one.
- **Rotation never touches a credential.** Re-keying unwraps a 32-byte data key
  and re-wraps it under the new KEK; the value's ciphertext is copied across
  byte-for-byte. The process that rotates keys therefore never holds an API
  token in memory, and a bug in it cannot log one. (A row still in the
  pre-envelope `v1` format is the exception — there is no data key to re-wrap, so
  it is decrypted and re-encrypted exactly once. That is the cost of the format
  that came before, paid on migration.)
- **The report says what is behind.** `GET .../secrets/keys` lists the key *id*
  each secret is stored under — read off the row with no key material involved —
  so "is anything still on the old key?" is a question with an answer rather
  than a manual read of a base64 column. A re-key is recorded in the
  tamper-evident audit log (`secret.rekeyed`), because *when did we last rotate
  the encryption key, and who did it* is a compliance question whose answer must
  not be editable — and nothing else in the record would show it happened, since
  no value changed.
- **Write-only API** — list endpoints return names + metadata; a value can be
  rotated or deleted but never read back. Writes are workspace-owner-only.
- **Run-log redaction** — the execution engine decrypts just-in-time, resolves
  templates through a scope that never enters the shared node context, and
  scrubs the plaintext (and its JSON-escaped form) from persisted step
  input/output, published Socket.io events, and error messages. Downstream
  nodes still receive real values in memory.

Tested in `__tests__/secretVault.test.js`, `__tests__/secretRotation.test.js`,
and `__tests__/secrets.test.js` (including an end-to-end engine leak check, and
a run that still resolves `{{secrets.NAME}}` to the original value after a
rotation).

**Workspace variables are deliberately not secrets.** `{{vars.NAME}}` values
(`routes/variables.js`) are plain configuration — readable through the API,
stored in cleartext, and visible in run logs. The boundary is the design:
giving non-sensitive config a first-class home keeps it *out* of secrets
(where write-only values can't be reviewed or diffed) and the split keeps the
secret guarantees sharp — everything in `workspace_secrets` gets encryption
and redaction, everything in `workspace_variables` gets visibility, and
nothing sits ambiguously between. The Variables UI and docs say explicitly
that credentials belong in Secrets.

### Personal access tokens & public API (T10)

The public `/api/v1` surface (`routes/publicApi.js`) authenticates with
personal access tokens (`services/apiTokens.js`, `middleware/tokenAuth.js`):

- **Hash-only storage** — only the SHA-256 of the token is persisted; the full
  value appears once, at mint time. A display prefix identifies tokens in the UI.
- **Scopes** (`trigger`, `read`, `approve`), optional **expiry** (1–365 days), and
  **revocation** (row kept as an audit trail, `last_used_at` stamped per use).
  `approve` is deliberately separate from `trigger`: a token that can start
  runs cannot implicitly settle the approval gates meant to check them.
- **Credential isolation** — session JWTs are rejected on `/api/v1` and API
  tokens on the session API, so an automation token can never reach account
  endpoints (password, 2FA), and vice versa.
- **Authorization parity** — a token acts as its owner; every route re-checks
  workspace membership, and missing/forbidden both read as 404.

Tested in `__tests__/apiTokens.test.js`.

### Tamper-evident audit log

`services/auditLog.js` records security-relevant changes — secrets, variables,
membership, API tokens, deploys/deletes/imports, manual pause/resume, status-page
publication — into a **per-workspace hash chain**:

```
hash(n) = SHA-256( canonical(entry n) || hash(n-1) )
```

The activity feed already answered "what happened here?" for people. This
answers a different question, and the difference is the security property:
**can the record be shown to be unedited?**

- **Editing any entry breaks every hash after it.** The digest covers the
  entry's own fields *and* the previous entry's hash.
- **Deleting an entry is visible twice over** — the chain fails to link, and
  `seq` (a contiguous per-workspace counter) has a hole. An attacker who
  recomputes hashes still has to explain the missing number.
- **Append-only is enforced by the schema**, not by convention: BEFORE UPDATE
  and BEFORE DELETE triggers on `audit_log` abort the statement. Tampering
  requires dropping the triggers with direct database access — and the chain
  catches it afterwards. The two controls are independent on purpose.
- **The trail outlives its subject.** There is deliberately no foreign key and
  no `ON DELETE CASCADE` to `workspaces`: a log that disappears when someone
  deletes the workspace is the log an attacker would target.

**Stated limits.** A hash chain proves *internal consistency*, not third-party
notarisation. An attacker with database write access who rewrites **every**
subsequent entry can produce a self-consistent forged chain — a case
`__tests__/auditLog.test.js` demonstrates rather than hides. What the chain
defeats is the realistic attack: a targeted edit or deletion of the few entries
that incriminate someone. The residual gap is closable by anchoring the head
hash outside the system, which is why `GET /workspaces/:id/audit/verify` returns
it, and why `flowforge audit --verify` exits non-zero on a broken chain so a
scheduled job can hold the log to account.

Reads are **owner-only** on both the session and public APIs: "who was granted
access recently" is precisely what an attacker holding a member's session would
want. Verification failures are reported as `200 { ok: false }` rather than a 5xx,
so a monitoring probe distinguishes a compromised log from an unreachable
endpoint — those page different people. Secret *values* never enter the log; only
that a secret changed.

### Real-time (Socket.io) authorization (T8)

The Socket.io connection is JWT-authenticated in the handshake, but that only
proves *who* a socket is. Joining a workflow room (`workflow:<id>`) — which carries
live execution outputs, graph edits, comments, and presence — is additionally
gated on **workspace membership** in `socket/handlers.js`, mirroring the REST layer
(which 404s a non-member on every workflow route). The relay events
(`node-change`/`edge-change`/`cursor-move`) only fire for a room the socket has
actually joined, so a socket cannot inject collaboration events into a workflow it
has no access to. The personal `user:<id>` room is derived from the verified token,
so a socket can only ever join its own. Tested in `__tests__/socketHandlers.test.js`.

### Status badges — unauthenticated public surface (T12)

`GET /api/workflows/:id/badge.svg` (`routes/workflows.js` +
`services/statusBadge.js`) is deliberately unauthenticated so a caching image
proxy (GitHub camo) can embed it. That makes it the one public read surface on
the session API, so it's built to leak nothing:

- **Opt-in token, constant-time compared.** A workflow has no badge until a
  member mints `badge_token`; the badge URL carries it as a query parameter,
  compared with `crypto.timingSafeEqual` (length-guarded).
- **No existence oracle.** A missing or wrong token — and a nonexistent
  workflow id — all render the same neutral `unknown` badge with `200`. The
  endpoint never `404`s, so it can't be used to probe which ids exist, and an
  embedded badge never shows a broken image.
- **Escaped output.** Every dynamic value is XML-escaped, so a status string
  can't inject markup into the SVG.
- **Dry runs excluded.** The badge reflects the latest *real* run, so a test
  run can't flip a public badge to failing.
- **Rate-limited** like the public webhook trigger, and served with a short
  `max-age` (fast refresh, CDN still absorbs bursts). Rotating or deleting the
  token revokes the URL immediately.

Tested in `server/src/__tests__/statusBadge.test.js`.

---

### Policy engine — fail-closed governance (T13)

`services/policyEngine.js` decides whether a workflow may be deployed. Three
properties keep it from becoming decorative:

- **Rules are validated when stored, not when they fire.** A rule must parse,
  call only stdlib functions, and **type-check against the policy document's
  schema**. A rule reading `httpHost` (singular) would evaluate to `undefined`
  and report every workflow compliant forever; it is refused at the door with a
  spelling suggestion instead.
- **Evaluation fails closed.** A rule that throws at admission time produces a
  violation at its declared severity rather than a pass. Given the validation
  above, reaching that state is an anomaly — and the safe reading of an anomaly
  in a security control is "no".
- **Management is owner-only and fully audited.** `policy.created`,
  `policy.updated`, and `policy.deleted` join the hash chain, and *disabling* is
  flagged in the entry metadata rather than buried in a field diff, because a
  control switched off the day before a bad deploy is precisely what an incident
  review is looking for.

The rules themselves are FXL, so they inherit the language's safety properties
in full: no `eval`, no host reach, bounded evaluation. See
[docs/POLICIES.md](./docs/POLICIES.md). Tested in
`server/src/__tests__/policyEngine.test.js` and `__tests__/policies.test.js`.

### Fault injection — a loaded gun with a safety (T14)

`services/faultInjection.js` deliberately breaks workflow steps, which makes it
the one feature in the system whose *purpose* is to cause failures. Four
constraints keep that contained:

- **Test runs only, by default.** A profile's scope is `dry-run` unless someone
  explicitly widens it. Authoring one cannot affect production by accident.
- **Widening is an owner decision.** `scope: "all"` requires the workspace owner
  role, is recorded in the audit log (`chaos.armed` / `chaos.disarmed`), and is
  announced in the workspace activity feed — a fault profile nobody can see is
  indistinguishable from an incident.
- **Mandatory expiry, capped at 7 days.** Chaos is an experiment, not a setting.
  A profile armed during an investigation disarms itself.
- **Never disguised.** Injected failures carry `[chaos]` in the message, record
  as ordinary failures on the step, and increment
  `flowforge_faults_injected_total` by mode — so a failure spike beside a fault
  spike is an experiment, and the same spike with the counter flat is an outage.

Triggers cannot be targeted, and a rule must name a `nodeId` or `nodeType`: a
profile that matched everything by omission is exactly the accident this
refuses. Tested in `server/src/__tests__/faultInjection.test.js`; the canary's
matching gate (T15) in `__tests__/canary.test.js`.

### Compensating transactions (T16)

`services/compensation.js` plus the engine's rollback pass fire real,
irreversible side effects — refunds, releases, deletions — *automatically*, when
a run fails. That combination (automatic, irreversible, triggered by breakage) is
unusual enough to state its boundaries explicitly.

- **Only work this run did is undone.** A compensation runs for a step that
  succeeded *in this execution*. `cached` and `reused` steps adopted an earlier
  run's output and are excluded, because undoing an effect another execution
  caused and still owns is data loss, not cleanup. This is not a separate check:
  `execution_steps.completed_seq` is written exactly when a runner returned, so
  the ordering data and the eligibility rule are the same fact and cannot drift.
- **A caught failure is not compensated.** `onError: continue`/`branch` means the
  author already decided what that failure means.
- **Nothing new reaches a compensation's config.** Templates resolve against the
  run's *persisted* outputs, which are secret-redacted — so a credential an API
  echoed back during the run cannot ride into a compensation, exactly as with
  resume-from-failure.
- **The manual path is authorised, bounded and audited.** `POST
  /executions/:id/rollback` needs a non-viewer and the `trigger` scope (it fires
  side effects, so `read` would be wrong), refuses a run that is still going or
  that succeeded, and re-runs **only compensations that have not already
  succeeded** — double-undoing while cleaning up after a failure is worse than
  the failure. Every invocation is appended to the audit log as
  `execution.rolled_back`.
- **Failure is visible, not silent.** A partial unwind is a distinct status
  naming which compensations are outstanding, is announced in the workspace
  activity feed, and lands on `/metrics` as
  `flowforge_compensations_total{status="failed"}` — a rising count there means
  the *cleanup* path is broken, which is worth paging on in its own right.
- **`rollback_policy: "off"`** is the operator kill switch for the case where the
  compensating endpoint is itself the broken thing.

Tested in `server/src/__tests__/compensation.test.js` and
`__tests__/rollbackApi.test.js`; see [docs/ROLLBACK.md](docs/ROLLBACK.md).

### Dataflow analysis — caller-controlled sinks (T17)

The egress guard (T7) answers "may the server connect to this address?". It
cannot answer "who *chose* this address?", and on a visual builder that second
question is invisible: a URL assembled from `{{trigger.host}}` looks exactly like
one an author typed.

`services/lineage.js` recovers the dataflow — every node's *origins* and its
`{{…}}` *reads* — and reports untrusted data reaching a high-sensitivity sink
(request URL, request headers, email recipient, Slack webhook, sub-workflow
target). Origins carry a trust level: a webhook body and a callback payload are
`untrusted`, an HTTP or model response is `external`, config/variables/secrets
are `internal`.

This is **detective, not preventive**, and the layering is deliberate:

| Layer | Question | Control |
|---|---|---|
| Lineage | who chose this value? | lint finding, CI gate |
| SSRF guard (T7) | may we connect there? | request refused at egress |
| Policy (T13) | is this workflow allowed here? | deploy refused |

Precision is a security property here rather than a nicety. A pinned authority
(`https://api.acme.com/orders/{{trigger.id}}`) is **not** reported — the
destination cannot be redirected, only a path segment varies — and taint does not
propagate through an HTTP response, because the far side wrote it regardless of
what the request contained. A checker that fired on both would flag most of every
graph, and a finding people have learned to ignore protects nothing.

It also reports **secret reach** (which nodes can read each secret), which turns
"who can see `STRIPE_KEY`?" from a manual grep into a query.

Tested in `server/src/__tests__/lineage.test.js`; see
[docs/LINEAGE.md](docs/LINEAGE.md).

---

### Prompt injection — the model as a confused deputy (T19)

An AI node in a real workflow classifies a webhook body: text written by whoever
holds the trigger URL. Text can read as instructions, so that party can steer the
model — and if the model's answer decides where a request goes or which branch
runs, they have steered the workflow. It is T17's shape with the model in the
middle.

**The finding is a composition, not a sink.** Untrusted data reaching a prompt is
what an AI node *is for*, and reporting it would fire on every one of them. So
`lineage.js` reports it only when the answer also influences a high-sensitivity
sink or a routing node — the same precision argument T17 rests on, applied one
step further along.

Three narrowings do the work:

- Only `untrusted` origins count. An HTTP response feeding a prompt is a third
  party's text, not an adversary's *choice* of text.
- The message names what an injection can actually reach, because the three cases
  differ: free text from a prompt node, one of the **declared labels** from a
  classifier, the extracted values from an extract node.
- A routing node counts through graph successors as well as `{{…}}` reads: a
  condition in expression mode reads `label` off its merged input and names
  nothing, so the read graph cannot see that edge. Bounded to *immediate*
  successors, because the engine merges only immediate predecessors.

**Containment at the boundary** (`ai-service/services/nodes.py`) applies to every
AI node without its author opting in:

| | |
|---|---|
| **Spotlighting** | untrusted text is fenced with a delimiter that is *random per call* and declared to be data whose apparent instructions must never be followed. The previous `"""` fence is one an injected payload can simply close; an unguessable one cannot be closed by text that cannot predict it. Per call rather than per process, so text that learned one fence cannot close another. |
| **A bounded answer** | classification resolves to one of the declared labels **or fails**. It previously fell through to the raw model text, so an injection could emit a value no condition was written for — and `label != "high_risk"` would read as safe. One bounded repair first (an unbounded repair loop is an unbounded bill), then a failure, which the node's own on-error policy can route. |
| **A bounded shape** | extraction is projected onto the declared fields, so the type the server infers for an extract node is a fact rather than a hope, and an invented key is not smuggled into the graph. |

Deliberately **not** presented as prevention: an injection can still choose a
*different declared label*, which is exactly why the finding exists as well.
Label matching is whole-word — substring containment would resolve the answer
"APPROVED" against a label set of `['a','b']`, and the bound would have bounded
nothing.

Tested in `ai-service/tests/test_nodes.py` (the prompt string *is* the
mitigation, so the tests assert on it) and
`server/src/__tests__/lineage.test.js`.

---

### Declared field redaction — personal data (T21)

Secret redaction (T9) already scrubs a decrypted credential out of everything the
engine persists or publishes. The mechanism is right for a second class of data
it was never pointed at: a webhook body's email address, customer name, or postal
address is not a credential, so nothing encrypts it, and it lands verbatim in
`execution_steps`, in the run panel, in the `exec-update` every watching
collaborator receives, and in that database's backups.

A workflow declares which trigger fields are personal
(`workflows.redact_json`), and those **values** join the run's redactor.

**By value, not by path**, and that is the whole reason it works. A declared
email is masked in the trigger's own step, in the request body a later node
interpolated it into, in the response a third party echoed it back in, and in an
error message that quoted it. Masking the declared *location* would scrub one of
those and leave the rest — the version of this feature that looks correct in a
demo.

Values resolve from the **trigger payload at run start**, because that is where
personal data enters and the only point its values are known before anything
executes. A declaration naming a *node's output* can therefore never resolve, and
is a lint **error**: a redaction rule that silently matches nothing is worse than
no rule, because the author believes the field is being scrubbed. A path today's
payload simply does not carry is *not* reported — an optional field is absent on
the runs that do not have it.

**Explicitly not a boundary control.** The value still flows through the engine
in memory, and a node that sends it to an API still sends it — that is what the
workflow is for. This governs what FlowForge *keeps and shows*, and the UI says
so, because the other reading is dangerous. `EXECUTION_RETENTION_DAYS` is the
complementary control for data already stored, and [lineage](docs/LINEAGE.md)
answers where a trigger field actually travels.

Tested in `server/src/__tests__/redaction.test.js` — including the case a
path-based implementation would fail: a Transform copying the declared value
into a field of another name.

---

### Signed workflow artifacts — provenance for promotions (T20)

Every other control here protects a definition that is already inside FlowForge.
This one is about the gap on the way in: `export → git → review → CI → import`
passes the document through a repository, a runner, an artifact store and an HTTP
call, and a `manage` token can import any document at all.

A document may carry a detached **Ed25519** signature; a workspace keeps the
public keys it trusts. What the signature covers is the design decision — the
graph's **semantics**, canonicalised with the rules the semantic diff uses
(positions excluded, config keys sorted, edges keyed by
`(source, target, sourceHandle)`, declared guarantees included) — so a re-export
after somebody tidies the canvas still verifies while any change to behaviour
does not.

The admission rule keeps the important line sharp:

```
trusted     always allowed
unsigned    allowed unless the workspace requires signatures
untrusted   refused, always
invalid     refused, always
```

Enforcement governs only the **unsigned** case. There is no configuration under
which the right response to a broken signature is to import it anyway, and
conflating the two is what makes signing decorative.

The trust store is owner-only (a list any member could append to is a
formality), keys are parsed before they are stored, and revocation keeps the row
— the question after an incident is what a key signed *while* it was trusted.
Every change is audited by **fingerprint, never key material**, and every import
records its verdict, the signing fingerprint and the digest of the graph that
landed.

Signing is **offline**: `flowforge keygen` and `flowforge sign` talk to no
server, because a key that has been near one is a key somebody has to reason
about, and an approval minted by the server it is presented to proves nothing.

**Residual, stated rather than glossed:** a signature is transferable. It proves
who approved a definition, not that they intended *this* import at *this* moment
into *this* workspace — the same limit the audit log's hash chain has. The
import still lands a draft, so deploying remains a separate act, and
`flowforge diff` still answers whether what is running is what git says.

Tested in `server/src/__tests__/artifactSigning.test.js`,
`trustStore.test.js`, and `cli/test/signing.test.js`; see
[docs/PROVENANCE.md](docs/PROVENANCE.md).

---

## Deferred / future work

These are known and accepted for the current stage. Each notes the decision and
rationale so the next person has context.

### T4-refresh — Refresh-token flow *(deferred — decision recorded)*

Access tokens currently live for **7 days** and are stateless (not individually
revocable). A full refresh-token flow (short-lived access token + hashed refresh
token in a new table + `POST /api/auth/refresh` + client-side transparent refresh
on `401`) was considered and **deferred** in favour of the simpler 7-day token
for the MVP.

- **Risk accepted:** a leaked token is valid until it expires (≤ 7 days); there
  is no server-side logout/invalidation.
- **When to revisit:** before handling sensitive data or supporting forced
  logout / session revocation. At that point also add a token version / denylist.

### T3 — Webhook signature verification *(implemented — was deferred)*

Previously deferred; now implemented as designed (`services/webhookSignature.js`):

- A webhook can be created with `{ signed: true }`, which mints a per-webhook
  secret (`whsec_<48 hex>`). The secret is returned **once** at creation and
  never again — list responses expose only a `signed` flag.
- Every delivery to a signed webhook must carry
  `X-FlowForge-Timestamp` (unix seconds) and
  `X-FlowForge-Signature: v1=<hex>`, where the signature is
  `HMAC-SHA256(secret, "<timestamp>.<raw body bytes>")`. The raw bytes are
  captured by the body parser (`verify` hook) so verification never depends on
  re-serialization round-tripping key order or whitespace.
- The timestamp is inside the signed payload and checked against a ±5-minute
  tolerance — a captured request cannot be replayed later.
- Comparison uses `crypto.timingSafeEqual`; failures return `401` without ever
  echoing the expected signature.
- The unguessable 192-bit webhook key remains the first factor; unsigned
  webhooks behave exactly as before.

### T7 — SSRF: DNS-rebinding residual + egress allowlist *(partial — decision recorded)*

`action-http` and `action-slack` are now guarded (see *Implemented controls →
SSRF egress guard*): scheme restriction + private/reserved-IP rejection on the
resolved address, re-checked per redirect hop. Two hardening steps remain:

- **DNS-rebinding window:** the guard resolves DNS, validates, then `fetch`
  resolves again — a narrow TOCTOU an attacker-controlled resolver could exploit.
  Closing it needs connection-level IP pinning (a custom `undici` dispatcher that
  validates the address actually connected to). `undici` isn't currently a
  dependency, so this was deferred to avoid adding one for the MVP.
- **Egress allowlist:** for defence in depth, also deploy the worker with no
  network route to internal services it doesn't need, and/or front node HTTP with
  an allowlist proxy.

### Password strength policy *(partial)*

Registration now enforces a **minimum length of 8** (alongside the ≤ 200 cap).
Still deferred: a complexity policy and a breached-password (k-anonymity / HIBP)
check before handling sensitive data.

### Dependency advisories

`npm audit fix` (non-breaking) has been applied to both `server` and `client`,
bumping the Socket.io transport's `ws` to a patched **8.21.0** — closing the
reachable memory-exhaustion DoS (GHSA-96hv-2xvq-fx4p). What remains needs
**breaking** major upgrades and is low real-exposure here:

| Package | Severity | Real exposure here | Fix |
|---------|----------|--------------------|-----|
| `nodemailer` | high | Low — the `sendEmail` node is **simulated** (no SMTP wired). Address before enabling real email. | `nodemailer@8` (breaking) |
| `tar` → `@mapbox/node-pre-gyp` | high | Low — build-time only (better-sqlite3 native build), not a runtime path. | breaking transitive bump |
| `uuid` (<11.1.1, via `bull` + `node-cron`) | moderate | Not exploitable — we use `uuidv4()` without the `buf` argument. | `uuid@14` (breaking) |
| `vitest` / `vite` chain (client) | critical/high | **Dev/test only** — not in the production bundle. | `vitest@3` (breaking) |

Do not run `npm audit fix --force` blindly — the breaking upgrades need testing. A
non-blocking `npm audit` step in CI would catch future drift.

---

## Operational security notes

- **`JWT_SECRET`** must be a long, random, secret value in production. Treat its
  rotation as invalidating all existing tokens.
- **`FRONTEND_URL`** must be set in production so CORS is not `*` (the server
  warns on startup if it isn't).
- **Never commit `.env`** — use `.env.example` as the template.
- The **Python AI service** is internal only; it must never be exposed publicly.
  The Node backend is the sole caller (`services/aiClient.js`).
- Webhook keys and JWTs are secrets — avoid logging request bodies/headers that
  may contain them.

---

## Reporting a vulnerability

This is a portfolio/MVP project. If you find a security issue, please open a
private report to the maintainer rather than a public issue, and allow time for a
fix before any disclosure.
