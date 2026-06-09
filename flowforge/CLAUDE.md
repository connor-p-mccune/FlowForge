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

- [ ] **Phase 1** — Foundation: Docker setup, auth, blank canvas
- [ ] **Phase 2** — Canvas & CRUD: Node types, save/load workflows
- [ ] **Phase 3** — Execution engine: DAG parser, Bull queue, live step updates
- [ ] **Phase 4** — Real-time collaboration: WebSocket sync, cursors, presence
- [ ] **Phase 5** — AI suggestions & webhooks: Python service, external triggers
- [ ] **Phase 6** — Polish & deploy: Error handling, README, production build

**Current phase: 1**

---

## Testing

```bash
# Run server tests
docker-compose exec server npm test

# Run client tests
docker-compose exec client npm test

# Run Python tests
docker-compose exec ai-service python -m pytest
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
