# server/

Node.js + Express backend on port 3001. Handles REST API, Socket.io real-time layer, and Bull worker for workflow execution.

---

## Commands

```bash
# Install deps
npm install

# Start dev server (nodemon)
npm run dev

# Run tests
npm test
```

---

## Folder structure

```
src/
├── index.js                        # Express app + Socket.io + Bull worker init
├── config/
│   ├── database.js                 # SQLite connection, runs schema.sql on startup
│   └── redis.js                    # Redis client for Bull
├── middleware/
│   ├── auth.js                     # JWT verification, attaches req.user
│   └── validate.js                 # Request body validation helpers
├── routes/
│   ├── auth.js                     # /api/auth/*
│   ├── workspaces.js               # /api/workspaces/*
│   ├── workflows.js                # /api/workflows/* and /api/workspaces/:id/workflows
│   ├── executions.js               # /api/executions/*
│   └── webhooks.js                 # /api/webhooks/:key (public)
├── services/
│   ├── dagParser.js                # Graph → adjacency list → topological sort
│   ├── executionEngine.js          # Runs sorted nodes, manages context, emits events
│   ├── scheduler.js                # node-cron jobs for schedule triggers (lock + enqueue)
│   └── nodeRunners/                # One file per node type
│       ├── httpRequest.js
│       ├── sendEmail.js
│       ├── sendSlack.js
│       ├── transform.js
│       ├── delay.js
│       ├── condition.js
│       ├── llmPrompt.js
│       ├── classify.js
│       └── extract.js
├── socket/
│   ├── index.js                    # Socket.io server init, JWT auth middleware
│   └── handlers.js                 # join, leave, node-change, edge-change, cursor-move
├── workers/
│   └── executionWorker.js          # Bull processor — calls executionEngine
└── db/
    ├── schema.sql                  # CREATE TABLE statements (run once on startup)
    └── seed.js                     # Optional test data
```

---

## Database access — `better-sqlite3` is synchronous

Import the db instance. All queries are synchronous — no async/await needed.

```javascript
// config/database.js
const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')

const DB_PATH = process.env.DATABASE_PATH || './data/flowforge.db'
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// Run schema on startup
const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8')
db.exec(schema)

module.exports = db
```

```javascript
// In any route file — import and use directly
const db = require('../config/database')

// SELECT one row
const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id)

// SELECT multiple rows
const workflows = db.prepare('SELECT * FROM workflows WHERE workspace_id = ?').all(workspaceId)

// INSERT
const result = db.prepare(
  'INSERT INTO workflows (id, workspace_id, name, created_by) VALUES (?, ?, ?, ?)'
).run(uuidv4(), workspaceId, name, req.user.id)

// UPDATE
db.prepare('UPDATE workflows SET name = ?, updated_at = ? WHERE id = ?')
  .run(name, new Date().toISOString(), id)

// DELETE
db.prepare('DELETE FROM workflows WHERE id = ?').run(id)
```

Always use prepared statements. Never interpolate user input into SQL strings.

---

## Route file pattern

Every route file follows this exact structure:

```javascript
// routes/workflows.js
const express = require('express')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')

const router = express.Router()

// GET /api/workspaces/:wsId/workflows
router.get('/workspaces/:wsId/workflows', auth, (req, res) => {
  try {
    const { wsId } = req.params
    const workflows = db.prepare(
      'SELECT * FROM workflows WHERE workspace_id = ? ORDER BY created_at DESC'
    ).all(wsId)
    res.json({ workflows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workspaces/:wsId/workflows
router.post('/workspaces/:wsId/workflows', auth, (req, res) => {
  try {
    const { wsId } = req.params
    const { name, description } = req.body
    if (!name) return res.status(400).json({ error: 'name is required' })

    const id = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO workflows (id, workspace_id, name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, wsId, name, description || null, req.user.id, now, now)

    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id)
    res.status(201).json({ workflow })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
```

Register all routers in `index.js`:
```javascript
app.use('/api', require('./routes/auth'))
app.use('/api', require('./routes/workflows'))
// etc.
```

---

## Auth middleware

```javascript
// middleware/auth.js
const jwt = require('jsonwebtoken')

module.exports = function auth(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' })
  }
  try {
    const token = header.split(' ')[1]
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    req.user = payload   // { id, email, displayName }
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}
```

Apply with `router.get('/path', auth, handler)`. Public routes (auth endpoints, webhook trigger) do not use this middleware.

JWTs are signed with a `7d` expiry (`signToken` in `routes/auth.js`). Token
revocation/refresh is out of scope for the MVP — see `SECURITY.md`.

---

## Rate limiting

IP-based limits via `express-rate-limit`, defined in `middleware/rateLimit.js`
and applied as per-route middleware. On exceed, the limiter responds `429` with
the app-wide `{ error }` JSON shape and emits `RateLimit-*` headers.

| Limiter          | Endpoint(s)                              | Default limit       | Purpose                       |
|------------------|------------------------------------------|---------------------|-------------------------------|
| `loginLimiter`   | `POST /api/auth/login`                   | 5 / 15 min / IP     | Brute-force / credential stuffing |
| `registerLimiter`| `POST /api/auth/register`                | 5 / 15 min / IP     | Signup spam                   |
| `webhookLimiter` | `POST /api/webhooks/:key` (public trigger)| 60 / min / IP      | Abuse / accidental floods     |

Login and register each have their own independent counter (not a shared pool).

**Tuning** — every limit is env-overridable:
`AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS`,
`WEBHOOK_RATE_LIMIT_MAX`, `WEBHOOK_RATE_LIMIT_WINDOW_MS`.

**Proxies** — `index.js` sets `trust proxy = 1` in production so limits key off
the real client IP behind Railway's proxy (scoped to one hop, so `X-Forwarded-For`
can't be spoofed).

**Tests** — limiting is skipped under `NODE_ENV=test` (suites fire many auth
requests) unless a suite sets `ENABLE_RATE_LIMIT=true`; `DISABLE_RATE_LIMIT=true`
turns it off anywhere. See `__tests__/rateLimit.test.js`.

---

## Socket.io handlers

```javascript
// socket/index.js
const { Server } = require('socket.io')
const jwt = require('jsonwebtoken')

function initSocket(httpServer) {
  const io = new Server(httpServer, { cors: { origin: '*' } })

  // Auth middleware — runs before every connection
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token
    if (!token) return next(new Error('No token'))
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET)
      socket.userId = payload.id
      socket.displayName = payload.displayName
      socket.color = randomColor()  // assign a cursor color
      next()
    } catch {
      next(new Error('Invalid token'))
    }
  })

  io.on('connection', (socket) => {
    require('./handlers')(socket, io)
  })

  return io
}
```

```javascript
// socket/handlers.js
module.exports = function registerHandlers(socket, io) {
  socket.on('join-workflow', ({ workflowId }) => {
    socket.join(`workflow:${workflowId}`)
    // Tell the new user who else is here
    socket.emit('presence', { users: getActiveUsers(io, workflowId) })
    // Tell everyone else a new user joined
    socket.to(`workflow:${workflowId}`).emit('user-joined', {
      userId: socket.userId,
      displayName: socket.displayName,
      color: socket.color,
    })
  })

  socket.on('node-change', ({ workflowId, action, node }) => {
    // Relay to everyone else in the room — not back to sender
    socket.to(`workflow:${workflowId}`).emit('remote-node', {
      userId: socket.userId,
      action,
      node,
    })
  })

  socket.on('cursor-move', ({ workflowId, x, y }) => {
    socket.to(`workflow:${workflowId}`).emit('remote-cursor', {
      userId: socket.userId,
      color: socket.color,
      x,
      y,
    })
  })

  socket.on('leave-workflow', ({ workflowId }) => {
    socket.leave(`workflow:${workflowId}`)
    socket.to(`workflow:${workflowId}`).emit('user-left', { userId: socket.userId })
  })
}
```

To emit from the execution worker (different process), use the Redis pub/sub adapter:
```javascript
// In executionWorker.js — publish event
redisClient.publish('exec-update', JSON.stringify({ executionId, stepId, status, data }))

// In socket/index.js — subscribe and re-emit to room
redisSub.subscribe('exec-update')
redisSub.on('message', (channel, message) => {
  const payload = JSON.parse(message)
  io.to(`execution:${payload.executionId}`).emit('exec-update', payload)
})
```

---

## Adding a new node runner

All node runners follow the same interface:

```javascript
// services/nodeRunners/myNode.js
module.exports = async function runMyNode(config, input) {
  // config — the node's saved configuration object
  // input  — output data from previous nodes, merged into one object
  // return — an object that becomes this node's output, available to downstream nodes
  // throw  — to fail this step (execution engine handles retry + logging)

  const result = await doSomething(config, input)
  return { result }
}
```

Register the runner in `executionEngine.js`:
```javascript
const runners = {
  'action-http':    require('./nodeRunners/httpRequest'),
  'action-delay':   require('./nodeRunners/delay'),
  'action-email':   require('./nodeRunners/sendEmail'),
  'condition':      require('./nodeRunners/condition'),
  'ai-prompt':      require('./nodeRunners/llmPrompt'),
  // add new runners here
}
```

---

## DAG parser and execution engine

```javascript
// services/dagParser.js
function buildAdjacency(nodes, edges) {
  const adj = {}
  const inDegree = {}
  for (const node of nodes) {
    adj[node.id] = []
    inDegree[node.id] = 0
  }
  for (const edge of edges) {
    adj[edge.source].push({ target: edge.target, sourceHandle: edge.sourceHandle })
    inDegree[edge.target]++
  }
  return { adj, inDegree }
}

function topoSort(nodes, adj, inDegree) {
  const queue = nodes.filter(n => inDegree[n.id] === 0).map(n => n.id)
  const order = []
  while (queue.length) {
    const id = queue.shift()
    order.push(id)
    for (const { target } of adj[id]) {
      inDegree[target]--
      if (inDegree[target] === 0) queue.push(target)
    }
  }
  if (order.length !== nodes.length) throw new Error('Cycle detected in workflow graph')
  return order
}

module.exports = { buildAdjacency, topoSort }
```

The execution engine calls `topoSort`, iterates the result, runs each node's runner, stores output in a `context` map keyed by node ID, and emits `exec-update` events via Redis pub/sub after each step.

---

## Bull queue

```javascript
// config/redis.js
const Redis = require('ioredis')
const client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')
module.exports = client

// In routes/workflows.js — enqueue a job
const Queue = require('bull')
const executionQueue = new Queue('workflow-execution', { redis: { host: 'redis', port: 6379 } })

router.post('/workflows/:id/execute', auth, async (req, res) => {
  // ... create execution record in DB ...
  await executionQueue.add({ executionId, workflowId: id })
  res.status(202).json({ execution })
})

// In workers/executionWorker.js — process jobs
const Queue = require('bull')
const executionQueue = new Queue('workflow-execution', { redis: { host: 'redis', port: 6379 } })

executionQueue.process(async (job) => {
  const { executionId, workflowId } = job.data
  await runExecution(executionId, workflowId)  // calls executionEngine
})
```

---

## Schedule triggers

`trigger-schedule` nodes run a workflow on a cron schedule. `services/scheduler.js`
owns the active jobs (built on `node-cron`) and enqueues onto the same Bull queue
as webhook/manual runs, so scheduled runs flow through the existing worker +
execution engine unchanged (a `trigger-*` node is a pass-through in the engine).

- `registerSchedule(workflowId, cron)` — (re)create the cron job; throws on an
  invalid expression (`cron.validate`).
- `unregisterSchedule(workflowId)` — stop and forget the job.
- `restoreSchedules()` — re-register every deployed workflow that has a schedule
  node; called once on startup in `index.js` so schedules survive a restart.

Wiring (`routes/workflows.js`): `POST /workflows/:id/deploy` validates the schedule
node's cron, marks the workflow `status = 'deployed'`, and registers it — an invalid
cron is rejected `400` before anything is snapshotted. `POST /workflows/:id/archive`
(`status = 'archived'`) and `DELETE /workflows/:id` both unregister it.

Each cron tick takes a short-lived Redis lock (`SET lock:schedule:{id} NX EX`) and
releases it right after enqueuing, so across multiple server instances only one
enqueues per tick (`SCHEDULE_LOCK_TTL_SECONDS`, default 30, is a crash safety-net).
The workflow `status` column is added by an idempotent migration in
`config/database.js`. Tests: `__tests__/scheduler.test.js` (service: lock/enqueue,
validate, register/restore) and `__tests__/schedule.test.js` (route wiring).

---

## index.js skeleton

```javascript
const express = require('express')
const http = require('http')
const cors = require('cors')
require('dotenv').config()

const app = express()
const server = http.createServer(app)

app.use(cors())
app.use(express.json())

// Routes
app.use('/api', require('./routes/auth'))
app.use('/api', require('./routes/workspaces'))
app.use('/api', require('./routes/workflows'))
app.use('/api', require('./routes/executions'))
app.use('/api', require('./routes/webhooks'))

// Socket.io
const { initSocket } = require('./socket')
const io = initSocket(server)
app.set('io', io)

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }))

const PORT = process.env.PORT || 3001
server.listen(PORT, () => console.log(`Server running on ${PORT}`))
```

---

## package.json dependencies

```json
{
  "dependencies": {
    "better-sqlite3": "^9.0.0",
    "bcrypt": "^5.1.0",
    "bull": "^4.12.0",
    "cors": "^2.8.5",
    "dotenv": "^16.0.0",
    "express": "^4.18.0",
    "express-rate-limit": "^7.5.1",
    "helmet": "^8.2.0",
    "ioredis": "^5.3.0",
    "jsonwebtoken": "^9.0.0",
    "node-cron": "^3.0.3",
    "socket.io": "^4.7.0",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.0"
  }
}
```
