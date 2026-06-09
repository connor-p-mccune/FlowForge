const express = require('express')
const http = require('http')
const cors = require('cors')
require('dotenv').config()

const app = express()
const server = http.createServer(app)

app.use(cors())
app.use(express.json())

app.use('/api', require('./routes/auth'))
app.use('/api', require('./routes/workspaces'))
app.use('/api', require('./routes/workflows'))
app.use('/api', require('./routes/executions'))
app.use('/api', require('./routes/webhooks'))

const { initSocket } = require('./socket')
const io = initSocket(server)
app.set('io', io)

app.get('/api/health', (req, res) => res.json({ status: 'ok' }))

if (process.env.NODE_ENV !== 'test') {
  const PORT = process.env.PORT || 3001
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`))
}

module.exports = { app, server }
