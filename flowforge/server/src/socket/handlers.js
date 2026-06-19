// Real-time collaboration handlers. Each open workflow is a Socket.io "room"
// (workflow:<id>). The server is a thin relay: it forwards node/edge/cursor
// changes to everyone else in the room but never mutates the graph itself —
// persistence is the REST layer's job, and conflict resolution is last-write-
// wins on the client using the `ts` (sender timestamp) carried on each change.

const db = require('../config/database')

// Snapshot of who is currently in a workflow's room, derived from connected
// sockets (presence is ephemeral — there is no DB table for it).
function getActiveUsers(io, workflowId) {
  const room = io.sockets.adapter.rooms.get(`workflow:${workflowId}`)
  if (!room) return []
  const users = []
  for (const socketId of room) {
    const s = io.sockets.sockets.get(socketId)
    if (s) {
      users.push({ userId: s.userId, displayName: s.displayName, color: s.color })
    }
  }
  return users
}

module.exports = function registerHandlers(socket, io) {
  // Every socket joins its own personal room so the server can push in-app
  // notifications to a specific user (notificationService emits to user:<id>),
  // in addition to the workflow rooms joined below.
  if (socket.userId) socket.join(`user:${socket.userId}`)

  socket.on('join-workflow', ({ workflowId }) => {
    socket.join(`workflow:${workflowId}`)
    socket.emit('presence', { users: getActiveUsers(io, workflowId) })
    socket.to(`workflow:${workflowId}`).emit('user-joined', {
      userId: socket.userId,
      displayName: socket.displayName,
      color: socket.color,
    })
  })

  socket.on('leave-workflow', ({ workflowId }) => {
    socket.leave(`workflow:${workflowId}`)
    socket.to(`workflow:${workflowId}`).emit('user-left', { userId: socket.userId })
  })

  // The workspace activity feed (workspace:<id> room) streams activity-event to
  // members viewing it. Membership is verified before joining so a socket can't
  // subscribe to a workspace the user isn't in. There's no presence/relay here —
  // the server only pushes (activityService emits); clients never emit into it.
  socket.on('join-workspace', ({ workspaceId }) => {
    if (!workspaceId || !socket.userId) return
    const member = db.prepare(
      'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
    ).get(workspaceId, socket.userId)
    if (member) socket.join(`workspace:${workspaceId}`)
  })

  socket.on('leave-workspace', ({ workspaceId }) => {
    socket.leave(`workspace:${workspaceId}`)
  })

  // socket.to(room) emits to everyone in the room EXCEPT the sender, so the
  // originating client keeps its own optimistic update and never echoes itself.
  socket.on('node-change', ({ workflowId, action, node, ts }) => {
    socket.to(`workflow:${workflowId}`).emit('remote-node', {
      userId: socket.userId,
      action,
      node,
      ts, // sender clock — clients use this for last-write-wins
    })
  })

  socket.on('edge-change', ({ workflowId, action, edge, ts }) => {
    socket.to(`workflow:${workflowId}`).emit('remote-edge', {
      userId: socket.userId,
      action,
      edge,
      ts,
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

  socket.on('disconnect', () => {
    for (const room of socket.rooms) {
      if (room.startsWith('workflow:')) {
        socket.to(room).emit('user-left', { userId: socket.userId })
      }
    }
  })
}
