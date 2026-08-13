// Real-time collaboration handlers. Each open workflow is a Socket.io "room"
// (workflow:<id>).
//
// The server used to be a thin relay: forward each change to everyone else and
// let the clients sort it out with last-write-wins on a wall clock. It is now
// the **convergence point**. Graph edits arrive as CRDT operations, are merged
// into a per-workflow document (services/collabSession.js), and the *resulting
// element* is broadcast — so every replica converges on a value the merge
// produced rather than each re-deriving one from a timestamp its own laptop
// generated. Three things follow that the relay could not offer: a tiebreak
// that does not depend on whose clock is fast, per-field granularity (two
// people editing different fields of one node both keep their edit), and a
// reconnecting client that can ask what it missed instead of silently
// diverging until somebody reloads.
//
// Cursors stay a pure relay. They are ephemeral, lossy by nature, and merging
// them would be inventing a problem.
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
const { memberRole } = require('../services/workspaceRoles')
const collab = require('../services/collabSession')
const { isValidOp } = require('../services/graphCrdt')

// Most edits arrive one at a time; a paste or an undo step arrives as a batch.
// The cap bounds what one message can cost the merge, since every operation in
// it is applied synchronously before the socket yields.
const MAX_OPS_PER_MESSAGE = 200

// The user's role in the workspace that owns `workflowId`, or null for a
// non-member (or unknown workflow). Mirrors the isMember /
// getWorkflowForMember checks in the REST routes, with the role riding along
// so the relay can distinguish viewers. Synchronous (better-sqlite3), so it
// runs inline in the event handlers.
function workflowRole(workflowId, userId) {
  if (!workflowId || typeof workflowId !== 'string' || !userId) return null
  const workflow = db.prepare('SELECT workspace_id FROM workflows WHERE id = ?').get(workflowId)
  if (!workflow) return null
  return memberRole(workflow.workspace_id, userId)
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
    const role = workflowRole(workflowId, socket.userId)
    if (!role) {
      socket.emit('workflow-access-denied', { workflowId })
      return
    }
    // Remembered per room for the relay guards below: a viewer may watch
    // everything the room carries, but their node/edge events are dropped —
    // the socket layer enforces read-only exactly like the REST layer does.
    // Captured at join (like membership itself); a role change takes effect
    // on the next join, mirroring how a REST session sees it per request.
    socket.workflowRoles = socket.workflowRoles || {}
    socket.workflowRoles[workflowId] = role
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
    releaseIfEmpty(io, workflowId)
  })

  // What a (re)joining client missed. `since` is the last sequence number it
  // saw; a client that has never synced sends 0 and gets a snapshot.
  //
  // This is the repair mechanism, and it is the reason a dropped connection is
  // no longer permanent divergence. The reply is a *state* delta — the current
  // value of everything touched since — rather than an operation replay, so it
  // is correct however far behind the client is and cannot double-apply.
  socket.on('graph-sync', ({ workflowId, epoch, since }) => {
    if (!inRoom(socket, workflowId)) return
    const state = collab.sync(workflowId, { epoch, since })
    if (state) socket.emit('graph-state', { workflowId, ...state })
  })

  // A batch of CRDT operations from one client.
  //
  // The reply is split because a losing writer needs different information from
  // everybody else: the rest of the room gets the elements that changed, while
  // the sender gets back any element whose registers *refused* its operation.
  // It applied that operation optimistically, so without the correction it is
  // the one replica holding a value the merge rejected — diverged on precisely
  // the edit it cared about.
  socket.on('graph-op', ({ workflowId, ops }) => {
    if (!inRoom(socket, workflowId)) return
    if (socket.workflowRoles?.[workflowId] === 'viewer') return
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPS_PER_MESSAGE) return

    // Validated at the boundary, not inside the merge: an operation from a
    // browser is untrusted input, and one malformed entry must not discard the
    // rest of a legitimate batch.
    const valid = ops.filter(isValidOp)
    if (valid.length === 0) return

    const result = collab.applyOps(workflowId, valid)
    if (!result) return

    if (result.effects.length > 0) {
      socket.to(`workflow:${workflowId}`).emit('graph-effects', {
        workflowId,
        userId: socket.userId,
        epoch: result.epoch,
        seq: result.seq,
        lamport: result.lamport,
        effects: result.effects,
      })
    }
    // Always acked, even with nothing to correct: the sender advances its own
    // epoch/sequence marker from this, which is what makes a later `graph-sync`
    // ask for the right window.
    socket.emit('graph-ack', {
      workflowId,
      epoch: result.epoch,
      seq: result.seq,
      lamport: result.lamport,
      corrections: result.corrections,
    })
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

  // Cursors are the one thing still relayed rather than merged: they are
  // ephemeral, lossy by nature, and a dropped cursor frame corrects itself on
  // the next mouse move. socket.to(room) emits to everyone EXCEPT the sender.
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
        // Deferred to the next tick: at `disconnecting` this socket is still
        // counted in the room, so an immediate check would never see it empty
        // and the last editor's work would wait for the debounce it may not
        // survive.
        const workflowId = room.slice('workflow:'.length)
        setImmediate(() => releaseIfEmpty(io, workflowId))
      }
    }
  })
}

// Persist and drop a session once the last collaborator leaves. Holding a
// document for an empty room would keep every workflow ever opened resident for
// the process's lifetime; flushing on the way out is what makes a session's
// work outlive the tab that produced it, rather than depending on the client's
// own debounced save having fired before it closed.
function releaseIfEmpty(io, workflowId) {
  const room = io.sockets.adapter.rooms.get(`workflow:${workflowId}`)
  if (!room || room.size === 0) collab.release(workflowId)
}
