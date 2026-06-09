const { Server } = require('socket.io')
const jwt = require('jsonwebtoken')

const CURSOR_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#6366f1', '#a855f7', '#ec4899',
]

let colorIndex = 0
function nextColor() {
  const color = CURSOR_COLORS[colorIndex % CURSOR_COLORS.length]
  colorIndex++
  return color
}

function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: '*' },
  })

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token
    if (!token) return next(new Error('No token'))
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET)
      socket.userId = payload.id
      socket.displayName = payload.displayName
      socket.color = nextColor()
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

module.exports = { initSocket }
