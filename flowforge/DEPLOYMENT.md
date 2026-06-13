# Deploying FlowForge

This guide deploys FlowForge to two platforms:

| Piece | Platform | Why |
|-------|----------|-----|
| `server` (Node API + Socket.io + Bull worker) | **Railway** | Long-running process, WebSockets, persistent SQLite volume |
| `ai-service` (Python/Flask) | **Railway** | Private internal service, holds the OpenAI key |
| `redis` (Bull queue + Socket.io pub/sub) | **Railway** | Managed database plugin |
| `client` (React/Vite static build) | **Vercel** | Static assets on a CDN |

```
            ┌───────── Vercel ─────────┐        ┌──────────────── Railway project ────────────────┐
  Browser ─▶│  client (static, HTTPS)  │── REST/WSS ──▶  server (public HTTPS)                      │
            └──────────────────────────┘                 │  ├─ private ──▶ ai-service (no domain)   │
                                                          │  └─ private ──▶ redis                    │
                                                          │     volume   ──▶ /app/data (SQLite)      │
                                                          └──────────────────────────────────────────┘
```

The repo keeps the app in a `flowforge/` subdirectory, with each service one level
deeper. **Every platform below must be told the correct Root Directory** — this is
the most common first-deploy mistake.

| Service | Root Directory to set |
|---------|-----------------------|
| Railway · server | `flowforge/server` |
| Railway · ai-service | `flowforge/ai-service` |
| Vercel · client | `flowforge/client` |

---

## What's already wired in the code

You don't need to edit code to deploy — these are already done:

- **Dockerfiles** for `server` and `ai-service` are multi-stage and production-ready.
- **`ai-service` runs gunicorn** (not the Flask dev server) and binds `[::]:$PORT`.
- **PORT** is read from the environment by both services (Railway injects it).
- **`server` CORS + Socket.io** are restricted to `FRONTEND_URL` (falls back to `*`
  only when that var is unset, for local dev).
- **SQLite path** is `DATABASE_PATH` (point it at the mounted volume).
- **Redis clients** set `family: 0` so Railway's IPv6-only private network resolves.
- **`client`** reads every API/WebSocket URL from `VITE_API_URL` (one variable).
- **`client/vercel.json`** adds the SPA rewrite so deep links (`/workflow/:id`) work.
- **Health checks:** server `GET /api/health`, ai-service `GET /health`.
- **`railway.json`** in each service pins the Docker builder + health check.

Env var names are documented in [`.env.production.example`](./.env.production.example).

---

## Prerequisites

- The repo pushed to GitHub.
- A [Railway](https://railway.app) account and a [Vercel](https://vercel.com) account.
- An OpenAI API key.
- (Optional) the Railway CLI: `npm i -g @railway/cli`.

---

## Part A — Backend on Railway

### 1. Create the project

1. Railway dashboard → **New Project** → **Deploy from GitHub repo** → pick this repo.
2. Railway will create one service from the repo. You'll point it at the server next,
   then add ai-service and redis to the **same project** (so they share a private
   network).

### 2. Add Redis

1. In the project: **New** → **Database** → **Add Redis**.
2. That's it — Railway provisions Redis and exposes a `REDIS_URL` variable on it.
   Leave it private (no public domain needed).

### 3. Configure the `server` service

1. Open the service created in step 1 (rename it **server**).
2. **Settings → Source**: set **Root Directory** to `flowforge/server`.
   Railway auto-detects the Dockerfile (and reads `flowforge/server/railway.json`).
3. **Settings → Networking → Public Networking**: **Generate Domain**. Copy the URL
   (e.g. `https://server-production-xxxx.up.railway.app`) — the client needs it.
4. **Add a volume for SQLite** (without this the database is wiped on every deploy):
   **Settings → Volumes → New Volume**, mount path **`/app/data`**.
5. **Variables** tab — add:

   | Variable | Value |
   |----------|-------|
   | `JWT_SECRET` | a long random string — `openssl rand -hex 32` |
   | `DATABASE_PATH` | `/app/data/flowforge.db` |
   | `REDIS_URL` | **Add Reference** → Redis → `REDIS_URL` (use the private one) |
   | `AI_SERVICE_URL` | `http://ai-service.railway.internal:5000` (set after step 4) |
   | `FRONTEND_URL` | leave unset for now — set it in Part B after Vercel is live |

   `PORT` is injected by Railway; `NODE_ENV=production` is baked into the image.
   (Optional SMTP vars from `.env.production.example` enable real email sending.)

### 4. Configure the `ai-service` service

1. Project → **New** → **GitHub Repo** → same repo (adds a second service).
2. **Settings → Source**: **Root Directory** = `flowforge/ai-service`.
3. **Do NOT generate a public domain.** This service is internal-only; it holds the
   OpenAI key and has no auth of its own.
4. **Variables**:

   | Variable | Value |
   |----------|-------|
   | `OPENAI_API_KEY` | `sk-...` |
   | `PORT` | `5000` (pin it so the server's `AI_SERVICE_URL` stays stable) |
   | `OPENAI_MODEL` | *(optional, defaults to `gpt-4o-mini`)* |

5. Find its private host under **Settings → Networking → Private Networking**
   (e.g. `ai-service.railway.internal`). Back on the **server** service, set
   `AI_SERVICE_URL=http://ai-service.railway.internal:5000` to match.

### 5. Deploy + verify the backend

Railway deploys on push. Once both services are green:

```bash
# Server health (public):
curl https://<your-server-domain>/api/health
# -> {"status":"ok"}
```

The ai-service has no public URL by design — confirm it's healthy from its Railway
**Deployments → logs** (gunicorn listening on `[::]:5000`) and via the server: once
the app is up, the AI suggestions panel exercises the private call end-to-end.

---

## Part B — Frontend on Vercel

### 1. Import the project

1. Vercel → **Add New… → Project** → import this GitHub repo.
2. **Root Directory**: click **Edit** → select **`flowforge/client`**.
3. Framework preset auto-detects **Vite** (confirmed by `vercel.json`). Leave the
   build command (`npm run build`) and output (`dist`) as detected.

### 2. Set the build-time env var

**Settings → Environment Variables** (add for Production, and Preview if you use it):

| Variable | Value |
|----------|-------|
| `VITE_API_URL` | your Railway **server** domain, e.g. `https://<your-server-domain>` |

> ⚠️ **Must be `https://`.** The Vercel site is HTTPS; an `http://` value triggers
> browser mixed-content blocking and silently breaks both the API and the WebSocket.
> No trailing slash.

### 3. Deploy

Click **Deploy**. Copy the resulting URL (e.g. `https://flowforge.vercel.app`).

### 4. Close the loop — point the server at the client

Back on Railway → **server** → **Variables**:

- Set `FRONTEND_URL=https://flowforge.vercel.app` (exact origin, no trailing slash).
- If you also use a custom domain or want Vercel preview URLs to work, comma-separate
  them: `FRONTEND_URL=https://flowforge.vercel.app,https://app.example.com`.

The server redeploys automatically. This is what lets the browser's CORS and
WebSocket-handshake checks pass.

> **Chicken-and-egg, resolved by ordering:** deploy the server first (it allows `*`
> while `FRONTEND_URL` is unset), then the client (needs the server URL at build
> time), then set `FRONTEND_URL` and let the server redeploy. Don't leave it on `*`
> for a real deployment.

---

## Part C — End-to-end smoke test

1. Open the Vercel URL, register an account, log in.
2. Create a workspace + workflow; drag and connect a couple of nodes (the canvas uses
   the WebSocket — open it in two tabs to see live cursors/presence).
3. Add a trigger + an action, click **Run**, and watch the execution panel update live
   (this proves Redis + Bull + the Socket.io pub/sub relay all work).
4. Open the AI suggestions panel (proves the private server → ai-service call).
5. Create a webhook in the panel and `curl -X POST` the shown URL with a JSON body —
   the run should appear (proves the public webhook path + the baked-in `VITE_API_URL`
   that builds that URL).

---

## Deploy-time gotchas (read this if something breaks)

### CORS
- **Symptom:** browser console `No 'Access-Control-Allow-Origin' header` / requests
  blocked. **Cause:** `FRONTEND_URL` is missing or doesn't *exactly* match the
  browser's origin (scheme, host, no trailing slash). Fix it on the server service.
- **Vercel preview deployments** get unique origins (`flowforge-git-branch-team.vercel.app`)
  that won't match a single `FRONTEND_URL`. Add them comma-separated, or use only the
  production origin and test there.
- The fallback to `*` happens **only** when `FRONTEND_URL` is unset — fine for local
  dev, not what you want in production.

### WebSockets (WSS / HTTPS)
- Socket.io picks `ws://` vs `wss://` from the `VITE_API_URL` scheme. Because the
  Vercel page is HTTPS, `VITE_API_URL` **must** be `https://` or the upgrade is blocked
  as mixed content. Railway terminates TLS and proxies WebSockets fine — no extra config.
- The Socket.io handshake is also subject to CORS — the same `FRONTEND_URL` allow-list
  covers it (already wired). A working REST call but failing socket usually means the
  socket origin check; re-check `FRONTEND_URL`.

### Environment variables
- **`VITE_API_URL` is baked in at *build* time** (Vite inlines `import.meta.env.*`).
  Changing it in Vercel does nothing until you **redeploy** the client. This is the #1
  source of "I updated the URL but it still hits localhost."
- **`PORT` is provided by Railway** — both services already read it. Don't hardcode a
  different value. (We pin only the ai-service `PORT` so its *private* URL is stable.)
- **`JWT_SECRET` must be stable.** Rotating it logs everyone out (all tokens invalid).

### SQLite persistence
- Railway container filesystems are **ephemeral**. Without the volume mounted at
  `/app/data` and `DATABASE_PATH=/app/data/flowforge.db`, every redeploy starts with an
  empty database. The volume mount path and the `DATABASE_PATH` directory must match.
- SQLite is single-instance. Do **not** scale the server beyond one replica — multiple
  replicas would each open a separate database file on separate volumes.

### Redis on Railway's private network
- Railway's private network is **IPv6-only**; `*.railway.internal` hostnames resolve
  via AAAA records. The Redis clients set `family: 0` so DNS returns IPv6 — without it
  you'd see `ENOTFOUND redis.railway.internal` and executions would queue forever.
  (Already handled in `config/redis.js` and `config/queue.js`.)
- Use the Redis service's **private** `REDIS_URL`. The public proxy URL works too but
  adds latency and egress cost.

### ai-service reachability
- It must bind IPv6 to be reachable over the private network — the Dockerfile binds
  `[::]:$PORT` (dual-stack). If the server logs `AI service unavailable`, confirm the
  ai-service is up, `PORT` matches the port in `AI_SERVICE_URL` (both `5000`), and the
  private host in `AI_SERVICE_URL` matches Settings → Networking.
- Keep it **private** (no generated domain). It has no authentication and would call
  OpenAI on any inbound request if exposed.

### Native modules (`better-sqlite3`, `bcrypt`)
- They compile during the Docker **build** stage (the image installs `python3/make/g++`).
  Railway builds the Dockerfile, so this is automatic — just don't switch the builder
  away from `DOCKERFILE`.

---

## Environment variable reference

### server (Railway)
| Variable | Required | Example / notes |
|----------|----------|-----------------|
| `JWT_SECRET` | ✅ | `openssl rand -hex 32`; keep stable |
| `FRONTEND_URL` | ✅ (prod) | `https://flowforge.vercel.app` (comma-sep for multiple) |
| `REDIS_URL` | ✅ | reference Redis service's private `REDIS_URL` |
| `AI_SERVICE_URL` | ✅ | `http://ai-service.railway.internal:5000` |
| `DATABASE_PATH` | ✅ | `/app/data/flowforge.db` (inside the volume) |
| `PORT` | auto | injected by Railway |
| `NODE_ENV` | baked | `production` (in Dockerfile) |
| `SMTP_*`, `EMAIL_FROM` | optional | enables real email; otherwise sends are simulated |

### ai-service (Railway)
| Variable | Required | Example / notes |
|----------|----------|-----------------|
| `OPENAI_API_KEY` | ✅ | `sk-...` |
| `PORT` | ✅ (pin) | `5000` to match `AI_SERVICE_URL` |
| `OPENAI_MODEL` | optional | defaults to `gpt-4o-mini` |

### client (Vercel)
| Variable | Required | Example / notes |
|----------|----------|-----------------|
| `VITE_API_URL` | ✅ | `https://<server-domain>` — https only, baked at build time |

---

## CLI alternative (optional)

```bash
# Railway (run once per service, from the repo root):
railway login
railway link                       # select/create the project
# In the dashboard set each service's Root Directory; then:
railway up                         # build + deploy the linked service

# Vercel:
npm i -g vercel
cd flowforge/client
vercel                             # first run links + configures the project
vercel --prod                      # production deploy
```

Set the same environment variables shown above via `railway variables` /
`vercel env add` if you prefer the CLI over the dashboards.
