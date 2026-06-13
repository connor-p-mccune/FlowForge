const express = require('express')
const http = require('http')
const cors = require('cors')
require('dotenv').config()

const app = express()
const server = http.createServer(app)

app.use(cors())
// Cap request bodies so a huge payload can't exhaust memory. Workflow graphs
// are the largest legitimate body, and 2mb covers very large graphs.
app.use(express.json({ limit: '2mb' }))

app.use('/api', require('./routes/auth'))
app.use('/api', require('./routes/workspaces'))
app.use('/api', require('./routes/workflows'))
app.use('/api', require('./routes/executions'))
app.use('/api', require('./routes/webhooks'))
app.use('/api', require('./routes/ai'))

const { initSocket } = require('./socket')
const io = initSocket(server)
app.set('io', io)

// Bull worker runs in-process alongside the API server
if (process.env.NODE_ENV !== 'test') {
  require('./workers/executionWorker').startWorker()
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
