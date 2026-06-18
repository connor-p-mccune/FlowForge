// In-app notifications. Inserts a row (the source of truth read by
// GET /api/notifications) and pushes it live over Socket.io to the recipient's
// personal room — `user:<id>`, which every socket joins on connect (see
// socket/handlers.js). Callers: the execution worker (failed runs) and the
// workspace invite route.

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')

// The Socket.io server, wired in once at startup (index.js) so we can emit from
// here without threading `io` through every caller. The worker and the routes
// all run in this same process, so a module-level ref is enough.
//
// NOTE (scaling): this emits directly from whichever instance created the
// notification. With a single instance (the current deployment) that's the same
// process the user's socket lives on. If the server is ever scaled horizontally,
// move this to the Redis pub/sub relay used for exec-update (publish here,
// re-emit to the local `user:<id>` room in socket/index.js) so the event reaches
// a recipient connected to a different instance. The DB insert is unaffected.
let io = null

function init(socketIo) {
  io = socketIo
}

// Create a notification for `userId` and deliver it live. Returns the new row.
function createNotification(userId, { type, title, message, link } = {}) {
  const id = uuidv4()
  const createdAt = new Date().toISOString()

  db.prepare(
    `INSERT INTO notifications (id, user_id, type, title, message, link, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(id, userId, type ?? null, title ?? null, message ?? null, link ?? null, createdAt)

  const notification = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id)

  // Best-effort live push; the badge also refreshes on the next fetch/login.
  if (io) io.to(`user:${userId}`).emit('new-notification', { notification })

  return notification
}

module.exports = { init, createNotification }
