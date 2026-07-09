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
| T3 | **Webhook abuse** | The public `POST /api/webhooks/:key` trigger is flooded, or fired by someone who obtained the key. | **Partially mitigated** — unguessable key + rate limiting. Signature verification deferred (see T3 in *Deferred*). |
| T4 | **Cross-origin / browser attacks** | A malicious site calls the API with a victim's session, or injects content. | **Mitigated** — CORS allow-list, security headers, tokens in `Authorization` (not cookies). |
| T5 | **SQL injection** | User input reaches a SQL query. | **Mitigated** — all queries use `better-sqlite3` prepared statements. |
| T6 | **Resource exhaustion / DoS** | Oversized request bodies or enormous graphs. | **Mitigated** — body cap + per-field/array size limits. |
| T7 | **Server-Side Request Forgery (SSRF)** | The `action-http` / `action-slack` nodes fetch a user-supplied URL server-side, reaching internal services or cloud metadata. | **Mitigated** — scheme + private/reserved-IP egress guard on both nodes (DNS-rebinding residual noted in *Deferred*). |
| T8 | **Real-time data exposure / tampering** | An authenticated user joins another workspace's workflow room over Socket.io to read live execution data, comments, and edits, or to inject collaboration events. | **Mitigated** — workflow-room membership check + relay gating. |
| T9 | **Credential theft from stored workflows** | API keys pasted into node configs land in `graph_json`, execution step logs, and exports — one database leak exposes every integration. | **Mitigated** — encrypted workspace secrets + log redaction (see below). |
| T10 | **API token compromise** | A personal access token for the public `/api/v1` API leaks (CI logs, dotfiles) and is replayed. | **Mitigated** — hash-only storage, scopes, expiry, revocation, per-token rate limit. |
| T11 | **Operational-data disclosure via metrics** | `GET /metrics` (Prometheus) exposes traffic patterns and run volumes to anyone who can reach the port. | **Mitigated** — metric labels are route *patterns* (never resource ids or user data), and setting `METRICS_TOKEN` gates scrapes behind a bearer token; recommended whenever the server has a public domain. |

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

### Encrypted workspace secrets (T9)

Workspace secrets (`routes/secrets.js` + `services/secretVault.js`) give node
configs a safe place for credentials, referenced as `{{secrets.NAME}}`:

- **AES-256-GCM at rest** — values are encrypted before insert (key derived via
  scrypt from `SECRETS_ENCRYPTION_KEY`, falling back to `JWT_SECRET`); GCM's
  auth tag makes tampered rows fail closed instead of decrypting to garbage.
- **Write-only API** — list endpoints return names + metadata; a value can be
  rotated or deleted but never read back. Writes are workspace-owner-only.
- **Run-log redaction** — the execution engine decrypts just-in-time, resolves
  templates through a scope that never enters the shared node context, and
  scrubs the plaintext (and its JSON-escaped form) from persisted step
  input/output, published Socket.io events, and error messages. Downstream
  nodes still receive real values in memory.

Tested in `__tests__/secretVault.test.js` and `__tests__/secrets.test.js`
(including an end-to-end engine leak check).

### Personal access tokens & public API (T10)

The public `/api/v1` surface (`routes/publicApi.js`) authenticates with
personal access tokens (`services/apiTokens.js`, `middleware/tokenAuth.js`):

- **Hash-only storage** — only the SHA-256 of the token is persisted; the full
  value appears once, at mint time. A display prefix identifies tokens in the UI.
- **Scopes** (`trigger`, `read`), optional **expiry** (1–365 days), and
  **revocation** (row kept as an audit trail, `last_used_at` stamped per use).
- **Credential isolation** — session JWTs are rejected on `/api/v1` and API
  tokens on the session API, so an automation token can never reach account
  endpoints (password, 2FA), and vice versa.
- **Authorization parity** — a token acts as its owner; every route re-checks
  workspace membership, and missing/forbidden both read as 404.

Tested in `__tests__/apiTokens.test.js`.

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

### T3 — Webhook signature verification *(deferred — decision recorded)*

The public webhook trigger is authenticated by an **unguessable 192-bit random
key** (`crypto.randomBytes(24).toString('base64url')`) and rate-limited at
60/min. HMAC signature verification (per-webhook shared secret + an
`X-Signature` header verified on each call) was considered and **deferred**.

- **Risk accepted:** anyone who obtains the key (e.g. via logs or a leaked
  config) can trigger the workflow; there is no replay protection.
- **When to revisit:** when integrating providers that sign payloads, or when
  webhook URLs may be exposed. Implementation note: add a `secret` column to the
  `webhooks` table, verify `HMAC-SHA256(body, secret)` in constant time, and keep
  the current key check as a first factor.

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
