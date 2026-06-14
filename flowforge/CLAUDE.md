# FlowForge

Visual workflow automation builder with real-time collaboration. Users drag nodes onto a canvas, connect them to define execution order, and deploy. When triggered, the backend parses the graph into a DAG, topologically sorts it, and executes each node in order with live progress streaming.

Full architecture reference: `flowforge-architecture.md` in the repo root.

---

## Architecture

Four Docker services communicating over a shared network:

| Service      | Port | Tech                          | Purpose                               |
|--------------|------|-------------------------------|---------------------------------------|
| `client`     | 5173 | React + Vite                  | Canvas UI, collaboration, auth        |
| `server`     | 3001 | Node.js + Express             | REST API, Socket.io, Bull workers     |
| `ai-service` | 5000 | Python + Flask                | LLM node suggestions                  |
| `redis`      | 6379 | Redis 7 (official image)      | Bull job queue + Socket.io pub/sub    |

SQLite database lives at `server/data/flowforge.db` (persisted via Docker volume).

---

## Dev environment

> `docker-compose` builds and runs **production** images (client served by nginx,
> AI service by gunicorn) — there is no hot reload. For hot-reload development,
> run each service directly with `npm run dev` / `python app.py` (see the README).

```bash
# Start all services
docker-compose up --build

# Start a single service (useful when iterating on one layer)
docker-compose up server

# Rebuild after package.json changes
docker-compose up --build server

# Open a shell in a running container
docker-compose exec server sh
docker-compose exec ai-service bash

# View logs for one service
docker-compose logs -f server

# Stop everything
docker-compose down

# Wipe database and volumes (fresh start)
docker-compose down -v
```

Access the app at `http://localhost:5173`.

---

## Environment variables

Copy `.env.example` to `.env` before running. Never commit `.env`.

```
JWT_SECRET=any-long-random-string-for-dev
OPENAI_API_KEY=sk-...
VITE_API_URL=http://localhost:3001
```

The `docker-compose.yml` passes these into each service automatically.

---

## Repo structure

```
flowforge/
├── CLAUDE.md                  ← you are here
├── flowforge-architecture.md  ← full spec reference
├── docker-compose.yml
├── .env.example
├── .github/workflows/ci.yml
├── client/                    ← React frontend (see client/CLAUDE.md)
├── server/                    ← Node.js backend (see server/CLAUDE.md)
├── ai-service/                ← Python Flask service (see ai-service/CLAUDE.md)
└── README.md
```

---

## Build phases

Track progress here. Update as phases complete.

- [x] **Phase 1** — Foundation: Docker setup, auth, blank canvas
- [x] **Phase 2** — Canvas & CRUD: Node types, save/load workflows
- [x] **Phase 3** — Execution engine: DAG parser, Bull queue, live step updates
- [x] **Phase 4** — Real-time collaboration: WebSocket sync, cursors, presence
- [x] **Phase 5** — AI suggestions & webhooks: Python service, external triggers
- [x] **Phase 6** — Polish & deploy: Error handling, README, production build

**Current phase: 7 — Security Hardening (complete)**

---

## Phase 7 — Security Hardening

A focused security pass on top of the completed MVP. This section tracks each
hardening item and its status. The full threat model and the disposition of any
deferred items live in `SECURITY.md`.

- [x] **1. Sandboxed expression evaluation** — Audited: no `eval`/`new Function`/`vm`
      exists. transform = `JSON.parse`, condition = fixed operator switch, the
      `{{...}}` resolver only substitutes values via a `[\w-.]`-restricted path
      grammar. No code-execution path to sandbox, so no evaluator lib was added
      (vm2 is deprecated/escapable; isolated-vm would add risk for no benefit).
      Locked in by `server/src/__tests__/sandbox.test.js`.
- [x] **2. Rate limiting** — `express-rate-limit` (`middleware/rateLimit.js`): 5/15min
      on `/api/auth/login` and `/api/auth/register`, 60/min on the public
      `/api/webhooks/:key` trigger. 429 → `{ error }`; env-tunable; `trust proxy`
      in prod. Tests: `__tests__/rateLimit.test.js`. Documented in server/CLAUDE.md.
- [x] **3. Security headers** — `helmet` in `index.js` with API defaults; CSP
      disabled (JSON API + Socket.io — see note in code). Tests:
      `__tests__/securityHeaders.test.js`.
- [x] **4. JWT review** — Confirmed: tokens already expire (`7d`). Decision: keep
      the 7-day access token; refresh-token flow deferred (documented in SECURITY.md).
- [x] **5. Input validation audit** — Confirmed comprehensive: name/workspace/webhook
      ≤200, description ≤2000, graph nodes/edges maxItems, 2mb body cap, auth fields
      capped. No gaps; observations (password min-length, SSRF) noted in SECURITY.md.
- [x] **6. CORS review** — Confirmed restricted to `FRONTEND_URL` (`*` only as dev
      fallback); added a production startup warning if left open. Shared by REST + Socket.io.
- [x] **7. Webhook signing** — Decision: deferred. Public trigger is protected by a
      192-bit random key + 60/min rate limit; HMAC signing documented in SECURITY.md.
- [x] **8. SECURITY.md** — Written at project root: threat model (T1–T7), implemented
      controls, and deferred items with rationale.

---

## Testing

Run each suite locally — the Docker images are production builds and don't
include dev/test tooling:

```bash
cd server && npm run lint && npm test              # ESLint + Jest
cd client && npm run lint && npm test              # ESLint + Vitest
cd ai-service && ruff check . && python -m pytest  # Ruff + pytest
```

Tests live in `server/src/__tests__/`, `client/src/__tests__/`, and `ai-service/tests/`.

---

## Key decisions and constraints

- SQLite only — no PostgreSQL. Use `better-sqlite3` (synchronous, no async/await needed for queries).
- No TypeScript — plain JavaScript throughout the client and server.
- No ORM — raw SQL with prepared statements via `better-sqlite3`.
- No CSS framework — plain CSS with CSS modules. No Tailwind, no Material UI.
- UUIDs for all primary keys — use the `uuid` npm package (`import { v4 as uuidv4 } from 'uuid'`).
- JWT is stateless — no session table. Invalidation is out of scope for MVP.
- Conflict resolution is last-write-wins with timestamps. No CRDTs.
- The AI service is called over HTTP from the backend. The frontend never calls it directly.
