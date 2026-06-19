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
// Cap request bodies so a huge payload can't exhaust memory. Workflow graphs
// are the largest legitimate body, and 2mb covers very large graphs.
app.use(express.json({ limit: '2mb' }))

// Populate the built-in workflow templates on first run. Idempotent: only seeds
// when the templates table is empty, so admin edits/removals survive restarts.
require('./db/templates').seedTemplates(require('./config/database'))

app.use('/api', require('./routes/auth'))
app.use('/api', require('./routes/workspaces'))
app.use('/api', require('./routes/workflows'))
app.use('/api', require('./routes/templates'))
app.use('/api', require('./routes/executions'))
app.use('/api', require('./routes/webhooks'))
app.use('/api', require('./routes/ai'))
app.use('/api', require('./routes/analytics'))
app.use('/api', require('./routes/notifications'))
app.use('/api', require('./routes/activity'))

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
  require('./workers/executionWorker').startWorker()
  // Re-register cron jobs for already-deployed scheduled workflows after a restart.
  require('./services/scheduler').restoreSchedules()
}

app.get('/api/health', (req, res) => res.json({ status: 'ok' }))

// Unknown API routes get a JSON 404 (not Express's default HTML page).
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }))

// Final error handler — turns body-parser failures and any uncaught error
// into the same { error } shape every route uses. (`next` is required for
// Express to treat this as an error handler even though it's unused.)
app.use((err, req, res, _next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' })
  }
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Invalid JSON in request body' })
  }
  console.error(err)
  res.status(500).json({ error: 'Internal server error' })
})

if (process.env.NODE_ENV !== 'test') {
  const PORT = process.env.PORT || 3001
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`))
}

module.exports = { app, server }
