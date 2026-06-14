# Security

This document describes FlowForge's security posture as of the **Phase 7 —
Security Hardening** pass: the threat model, the controls that are implemented,
and the items that are deliberately deferred (with rationale).

It is a living document — update it whenever a control is added, changed, or a
deferred item is picked up. The Phase 7 checklist lives in the root `CLAUDE.md`.

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
| T7 | **Server-Side Request Forgery (SSRF)** | The `action-http` node fetches a user-supplied URL server-side, reaching internal services or cloud metadata. | **Known gap — deferred** (see T7 in *Deferred*). |

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

All limits are env-tunable (`AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS`,
`WEBHOOK_RATE_LIMIT_MAX`, `WEBHOOK_RATE_LIMIT_WINDOW_MS`). In production
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

### T7 — SSRF protection on the HTTP node *(known gap)*

The `action-http` node (`services/nodeRunners/httpRequest.js`) performs a
server-side `fetch` to a **user-supplied URL** with no allow/deny list. A user
can therefore make the server request internal-only addresses — cloud metadata
(`169.254.169.254`), `localhost`, or the internal `redis` / `ai-service` hosts.

- **Suggested mitigation:** resolve the hostname and reject private, loopback,
  and link-local IP ranges (with DNS-rebinding protection — re-validate the IP
  actually connected to), restrict to `http`/`https`, and consider an
  egress allowlist. Optionally route node HTTP through a locked-down proxy.
- **Interim:** deploy the worker with no network route to internal services it
  doesn't need.

### Password strength policy

Passwords are length-capped (≤ 200) but have **no minimum length or complexity
requirement**. Consider a minimum length (e.g. ≥ 8) and a breached-password check
before launch.

### Dependency advisories

`npm audit` currently reports 5 advisories, all in **transitive** dependencies.
Real exposure is low today, but they should be triaged:

| Package | Severity | Real exposure here | Fix |
|---------|----------|--------------------|-----|
| `nodemailer` | high/mod | Low — the `sendEmail` node is **simulated** (no SMTP wired). Address before enabling real email. | `nodemailer@8` (breaking) |
| `tar` → `@mapbox/node-pre-gyp` | high | Low — build-time only (better-sqlite3 native build), not a runtime path. | `npm audit fix` (non-breaking) |
| `uuid` (<11.1.1, via `bull` + direct) | moderate | Not exploitable — we use `uuidv4()` without the `buf` argument. | `uuid@14` (breaking) |

Do not run `npm audit fix --force` blindly — the breaking upgrades need testing.

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
