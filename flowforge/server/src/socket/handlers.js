// Real-time collaboration handlers. Each open workflow is a Socket.io "room"
// (workflow:<id>). The server is a thin relay: it forwards node/edge/cursor
// changes to everyone else in the room but never mutates the graph itself —
// persistence is the REST layer's job, and conflict resolution is last-write-
// wins on the client using the `ts` (sender timestamp) carried on each change.
//
// Authorization: the connection is already JWT-authenticated (socket/index.js),
// but that only proves *who* the socket is, not *what* it may see. A workflow
// room carries live execution outputs (HTTP bodies, AI results, webhook
// payloads), graph edits, comments, and presence — so joining one is gated on
// workspace membership here, mirroring the REST layer (which 404s a non-member on
// every workflow route). Without this an authenticated socket could join
// workflow:<any-id> and both read that traffic and inject node/edge/cursor
// events into a workflow it has no access to.

const db = require('../config/database')

// Is `userId` a member of the workspace that owns `workflowId`? Mirrors the
// isMember / getWorkflowForMember checks in the REST routes. Synchronous
// (better-sqlite3), so it runs inline in the event handlers.
function canAccessWorkflow(workflowId, userId) {
  if (!workflowId || typeof workflowId !== 'string' || !userId) return false
  const workflow = db.prepare('SELECT workspace_id FROM workflows WHERE id = ?').get(workflowId)
  if (!workflow) return false
  const member = db
    .prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(workflow.workspace_id, userId)
  return !!member
}

// A socket may only relay to a room it has actually joined. Because join-workflow
// gates the join on membership, "is in the room" implies "was authorized" — so
// this O(1) check guards the high-frequency relay events (node/edge/cursor)
// without a DB hit per event, and stops a socket emitting into a room it never
// joined (socket.to(room) broadcasts to that room regardless of whether the
// sender is in it).
function inRoom(socket, workflowId) {
  return typeof workflowId === 'string' && socket.rooms.has(`workflow:${workflowId}`)
}

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
  // in addition to the workflow rooms joined below. This room is derived from the
  // verified JWT, so a socket can only ever join its own.
  if (socket.userId) socket.join(`user:${socket.userId}`)

  socket.on('join-workflow', ({ workflowId }) => {
    // Refuse rooms the socket's user isn't a member of. Mirrors the REST
    // 404-for-non-members: the client learns access was denied, not whether the
    // workflow exists.
    if (!canAccessWorkflow(workflowId, socket.userId)) {
      socket.emit('workflow-access-denied', { workflowId })
      return
    }
    socket.join(`workflow:${workflowId}`)
    socket.emit('presence', { users: getActiveUsers(io, workflowId) })
    socket.to(`workflow:${workflowId}`).emit('user-joined', {
      userId: socket.userId,
      displayName: socket.displayName,
      color: socket.color,
    })
  })

  socket.on('leave-workflow', ({ workflowId }) => {
    if (!inRoom(socket, workflowId)) return
    socket.leave(`workflow:${workflowId}`)
    socket.to(`workflow:${workflowId}`).emit('user-left', { userId: socket.userId })
  })

  // socket.to(room) emits to everyone in the room EXCEPT the sender, so the
  // originating client keeps its own optimistic update and never echoes itself.
  // Each relay first confirms the sender is actually in the room (see inRoom).
  socket.on('node-change', ({ workflowId, action, node, ts }) => {
    if (!inRoom(socket, workflowId)) return
    socket.to(`workflow:${workflowId}`).emit('remote-node', {
      userId: socket.userId,
      action,
      node,
      ts, // sender clock — clients use this for last-write-wins
    })
  })

  socket.on('edge-change', ({ workflowId, action, edge, ts }) => {
    if (!inRoom(socket, workflowId)) return
    socket.to(`workflow:${workflowId}`).emit('remote-edge', {
      userId: socket.userId,
      action,
      edge,
      ts,
    })
  })

  socket.on('cursor-move', ({ workflowId, x, y }) => {
    if (!inRoom(socket, workflowId)) return
    socket.to(`workflow:${workflowId}`).emit('remote-cursor', {
      userId: socket.userId,
      color: socket.color,
      x,
      y,
    })
  })

  // Use `disconnecting`, not `disconnect`: Socket.io empties socket.rooms before
  // the `disconnect` event fires, so a `disconnect` handler would see no rooms and
  // never tell collaborators the user left. At `disconnecting` the rooms are still
  // joined, so we can broadcast user-left to each workflow room the socket is in.
  socket.on('disconnecting', () => {
    for (const room of socket.rooms) {
      if (room.startsWith('workflow:')) {
        socket.to(room).emit('user-left', { userId: socket.userId })
      }
    }
  })
}
