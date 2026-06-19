// Workspace activity feed. Inserts an append-only activity_events row (the source
// of truth read by GET /api/workspaces/:id/activity) and pushes it live over
// Socket.io to the workspace room — workspace:<id>, which a client joins from the
// activity page (see socket/handlers.js). Callers: the workflow/workspace routes
// (create/deploy/delete/restore, member invite/remove) and the execution engine
// (run completed/failed). The canvas-comments feature (built in parallel) calls
// logEvent with 'comment.added' / 'comment.resolved' once its routes exist.

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')

// The Socket.io server, wired in once at startup (index.js) so we can emit from
// here without threading `io` through every caller. The worker and the routes all
// run in this same process, so a module-level ref is enough.
//
// NOTE (scaling): like notificationService, this emits directly from the instance
// that created the event. With a single instance (the current deployment) that's
// the same process the recipient's socket lives on. If the server is ever scaled
// horizontally, move this to the Redis pub/sub relay used for exec-update (publish
// here, re-emit to the local workspace:<id> room in socket/index.js). The DB write
// is unaffected.
let io = null

function init(socketIo) {
  io = socketIo
}

// Record a workspace activity event and deliver it live. Returns the stored row,
// shaped exactly like a GET row (actor display name joined in), so the live socket
// payload and the feed API stay identical.
//
//   workspaceId  the workspace the event belongs to
//   actorId      the user who did it (null for system/webhook/schedule actors)
//   eventType    e.g. 'workflow.deployed', 'execution.failed', 'member.invited'
//   entity       { type, id, name, metadata } — all optional; metadata is any
//                JSON-serialisable object, stored as a JSON string
//
// Best-effort and self-contained: any failure is logged and swallowed so activity
// logging can never break the action that triggered it.
function logEvent(workspaceId, actorId, eventType, entity = {}) {
  try {
    const id = uuidv4()
    const createdAt = new Date().toISOString()
    const metadataJson = entity.metadata != null ? JSON.stringify(entity.metadata) : null

    db.prepare(
      `INSERT INTO activity_events
         (id, workspace_id, actor_id, event_type, entity_type, entity_id, entity_name, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, workspaceId, actorId ?? null, eventType,
      entity.type ?? null, entity.id ?? null, entity.name ?? null, metadataJson, createdAt
    )

    const actor = actorId
      ? db.prepare('SELECT display_name FROM users WHERE id = ?').get(actorId)
      : null

    const event = {
      id,
      workspace_id: workspaceId,
      actor_id: actorId ?? null,
      actor_display_name: actor ? actor.display_name : null,
      event_type: eventType,
      entity_type: entity.type ?? null,
      entity_id: entity.id ?? null,
      entity_name: entity.name ?? null,
      metadata: entity.metadata ?? null,
      created_at: createdAt,
    }

    // Best-effort live push; the feed also self-heals on the next fetch.
    if (io) io.to(`workspace:${workspaceId}`).emit('activity-event', { event })

    return event
  } catch (err) {
    console.error('activityService.logEvent failed:', err.message)
    return null
  }
}

module.exports = { init, logEvent }
