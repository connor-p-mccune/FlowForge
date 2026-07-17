const express = require('express')
const http = require('http')
const cors = require('cors')
const helmet = require('helmet')
require('dotenv').config()

const { allowedOrigins } = require('./config/cors')

const app = express()
const server = http.createServer(app)

// Behind Railway's proxy in production, trust the first proxy hop so req.ip is
// the real client IP (used by rate limiting) rather than the proxy's address.
// Scoped to a single hop — not `true` — so clients can't spoof X-Forwarded-For.
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1)
}

// Security headers (sensible defaults for an API). contentSecurityPolicy is
// disabled on purpose: this service returns only JSON and hosts Socket.io — it
// serves no HTML/scripts, so a server-set CSP protects nothing here, and the
// restrictive default policy would interfere with the Socket.io transport and
// the cross-origin browser client. CSP belongs on the frontend host (nginx /
// Vercel), which serves the actual app shell.
app.use(helmet({ contentSecurityPolicy: false }))

// Restrict CORS to the production frontend origin(s) via FRONTEND_URL (comma-
// separated for multiple). Falls back to '*' for local dev / docker-compose.
const corsOrigins = allowedOrigins()
// Loud warning if a production deploy is left wide open (FRONTEND_URL unset).
if (process.env.NODE_ENV === 'production' && corsOrigins === '*') {
  console.warn('[security] CORS is open to "*" in production. Set FRONTEND_URL to restrict it.')
}
app.use(cors({ origin: corsOrigins, credentials: corsOrigins !== '*' }))

// Request correlation + structured request logs: every request gets an id
// (inbound X-Request-Id honored, echoed on the response, bound to req.log)
// and one JSON log line per response. Mounted before the body parser so even
// a request that fails to parse carries its id through the error handler.
app.use(require('./middleware/requestContext'))
// Cap request bodies so a huge payload can't exhaust memory. Workflow graphs
// are the largest legitimate body, and 2mb covers very large graphs.
// `verify` keeps a reference to the exact raw bytes: webhook HMAC signatures
// are computed over the wire payload, and re-serializing the parsed body
// would not round-trip key order or whitespace.
app.use(
  express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf
    },
  })
)

// Prometheus instrumentation: every response is counted and timed against its
// matched route pattern (bounded label cardinality). Scraped at GET /metrics.
const metrics = require('./services/metrics')
app.use(metrics.httpMetricsMiddleware)

// Populate the built-in workflow templates on first run. Idempotent: only seeds
// when the templates table is empty, so admin edits/removals survive restarts.
require('./db/templates').seedTemplates(require('./config/database'))

app.use('/api', require('./routes/auth'))
app.use('/api', require('./routes/workspaces'))
app.use('/api', require('./routes/workflows'))
app.use('/api', require('./routes/templates'))
app.use('/api', require('./routes/executions'))
app.use('/api', require('./routes/webhooks'))
app.use('/api', require('./routes/callbacks'))
app.use('/api', require('./routes/ai'))
app.use('/api', require('./routes/analytics'))
app.use('/api', require('./routes/insights'))
app.use('/api', require('./routes/schedule'))
app.use('/api', require('./routes/workflowTests'))
app.use('/api', require('./routes/notifications'))
app.use('/api', require('./routes/comments'))
app.use('/api', require('./routes/activity'))
app.use('/api', require('./routes/secrets'))
app.use('/api', require('./routes/tokens'))
app.use('/api', require('./routes/approvals'))
app.use('/api', require('./routes/subscriptions'))
app.use('/api', require('./routes/expressions'))
app.use('/api', require('./routes/search'))
app.use('/api', require('./routes/statusPage'))
// Public, token-authenticated REST API for external integrations. Mounted
// before the /api 404 catch-all below like everything else.
app.use('/api/v1', require('./routes/publicApi'))

const { initSocket } = require('./socket')
const io = initSocket(server)
app.set('io', io)
// Give the notification service the Socket.io server so it can push live
// notifications to a user's personal room (used by the worker + invite route).
require('./services/notificationService').init(io)
// Same for the activity service: it streams each logged event to the workspace's
// room (workspace:<id>) live (used by the routes + execution engine).
require('./services/activityService').init(io)

// Bull worker runs in-process alongside the API server
if (process.env.NODE_ENV !== 'test') {
  const queue = require('./workers/executionWorker').startWorker()
  // Re-register cron jobs for already-deployed scheduled workflows after a restart.
  require('./services/scheduler').restoreSchedules()
  // Drain the outbound webhook delivery queue (event subscriptions). Durable in
  // SQLite, so deliveries queued before a restart pick back up here.
  require('./services/eventDispatcher').startDispatcher()
  // Age-based cleanup: settled webhook deliveries (default 30d) and — only
  // when EXECUTION_RETENTION_DAYS is set — old terminal runs.
  require('./services/retention').startRetention()

  // Graceful shutdown (services/shutdown.js): on SIGTERM/SIGINT, drain in
  // dependency order instead of dying mid-run. Sources of new work stop first
  // (HTTP intake, cron schedules), then the worker pause waits for in-flight
  // runs to settle, then the background timers and connections close.
  const { onShutdown, installSignalHandlers } = require('./services/shutdown')
  onShutdown('http-intake', () => {
    // Initiate close (stop accepting) and drop idle keep-alives, but don't
    // wait for every connection — open WebSockets close with Socket.io below,
    // and awaiting them here would deadlock the drain.
    server.close()
    server.closeIdleConnections?.()
  })
  onShutdown('schedules', () => require('./services/scheduler').stopAllSchedules())
  onShutdown('execution-worker', async () => {
    // Local pause resolves only once this worker's active jobs — in-flight
    // runs — have settled. New/queued jobs stay in Redis for the next boot.
    await queue.pause(true)
    await queue.close()
  })
  onShutdown('event-dispatcher', () => require('./services/eventDispatcher').stopDispatcher())
  onShutdown('retention', () => require('./services/retention').stopRetention())
  onShutdown('socket-io', () => new Promise((resolve) => io.close(() => resolve())))
  onShutdown('redis', () => require('./config/redis').quit().catch(() => {}))
  onShutdown('database', () => require('./config/database').close())
  installSignalHandlers()
}

app.get('/api/health', (req, res) => res.json({ status: 'ok' }))

// Readiness probe: verifies the process can actually serve traffic — SQLite
// reachable and Redis answering — and 503s otherwise, so an orchestrator can
// hold traffic (or restart the container) instead of routing into failures.
// The Redis ping is raced against a timeout because ioredis with
// maxRetriesPerRequest: null queues commands indefinitely while disconnected.
const withTimeout = (promise, ms) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })

app.get('/api/health/ready', async (req, res) => {
  // Draining: tell the orchestrator to route traffic elsewhere while in-flight
  // runs settle. Liveness (/api/health) stays green so it doesn't kill the
  // drain early.
  if (require('./services/shutdown').isShuttingDown()) {
    return res.status(503).json({ status: 'draining' })
  }
  const checks = { database: 'ok', redis: 'ok' }
  try {
    require('./config/database').prepare('SELECT 1').get()
  } catch {
    checks.database = 'error'
  }
  try {
    const pong = await withTimeout(require('./config/redis').ping(), 2000)
    if (pong !== 'PONG') checks.redis = 'error'
  } catch {
    checks.redis = 'error'
  }
  const ready = Object.values(checks).every((v) => v === 'ok')
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'degraded', checks })
})

// Prometheus scrape endpoint (text exposition format). Not under /api on
// purpose — it's infrastructure, not product surface. Optionally guarded by a
// bearer METRICS_TOKEN for deployments where the port is reachable publicly.
metrics.registerCollector(async () => {
  const counts = await require('./config/queue').getExecutionQueue().getJobCounts()
  for (const [state, n] of Object.entries(counts || {})) {
    metrics.queueJobs.set({ state }, n)
  }
})

// Outbound webhook backlog — a growing number means an unreachable receiver
// (or the dispatcher isn't running).
metrics.registerCollector(() => {
  const { n } = require('./config/database')
    .prepare("SELECT COUNT(*) AS n FROM event_deliveries WHERE status = 'pending'")
    .get()
  metrics.webhookPending.set({}, n)
})

app.get('/metrics', async (req, res) => {
  const token = process.env.METRICS_TOKEN
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  res.send(await metrics.renderPrometheus())
})

// Unknown API routes get a JSON 404 (not Express's default HTML page).
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }))

// Final error handler — body-parser failures and uncaught errors become the
// same { error } shape every route uses, with the request's correlation id in
// the 500 body and its log line. See middleware/errorHandler.js.
app.use(require('./middleware/errorHandler'))

if (process.env.NODE_ENV !== 'test') {
  const PORT = process.env.PORT || 3001
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`))
}

module.exports = { app, server }
