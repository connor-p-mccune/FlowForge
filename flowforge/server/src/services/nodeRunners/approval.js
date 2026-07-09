// Approval node: pauses the run until a workspace member responds, then routes
// down the approved or rejected branch (the same sourceHandle mechanism
// condition nodes use). The wait is cooperative, mirroring how cancellation
// works: the runner files an execution_approvals row, notifies the workspace,
// and polls the row until it settles — someone responds via
// POST /api/approvals/:id/respond, the run is cancelled, or the wait passes
// expires_at. Polling the database (rather than holding an in-memory promise)
// means a pending approval survives whatever the process does in between; the
// row is the source of truth exactly like comments and notifications.
//
// The engine gives approval nodes a single attempt (see runWithRetries) — a
// retry would file a duplicate approval request.

const { v4: uuidv4 } = require('uuid')
const db = require('../../config/database')

const DEFAULT_TIMEOUT_MINUTES = 60
const MAX_TIMEOUT_MINUTES = 7 * 24 * 60 // one week

// Read per call so a test can shrink the wait without re-requiring the module.
function pollIntervalMs() {
  const n = parseInt(process.env.APPROVAL_POLL_MS || '1500', 10)
  return Number.isFinite(n) && n >= 10 ? n : 1500
}

function timeoutMinutes(config) {
  const n = Number(config?.timeoutMinutes)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MINUTES
  return Math.min(n, MAX_TIMEOUT_MINUTES)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Tell every workspace member an approval is waiting. Best-effort (a
// notification problem must never fail the run) and lazy-required so engine
// unit tests don't pull the notification service in.
function notifyMembers(run, { message, executionId }) {
  try {
    const members = db
      .prepare('SELECT user_id FROM workspace_members WHERE workspace_id = ?')
      .all(run.workspace_id)
    const { createNotification } = require('../notificationService')
    for (const member of members) {
      createNotification(member.user_id, {
        type: 'approval-requested',
        title: 'Approval needed',
        message: `"${run.workflow_name}" is waiting for approval${message ? `: ${message}` : ''}`,
        link: `/workflow/${run.workflow_id}?execution=${executionId}`,
      })
    }
  } catch (err) {
    console.error('Failed to notify members of approval request:', err.message)
  }
}

module.exports = async function approval(config, input, isDryRun, ctx = {}) {
  // Test mode never blocks: like the other side-effecting runners, report what
  // would have happened (a wait) and take the approved branch so the rest of
  // the graph stays testable.
  if (isDryRun) return { result: true, outcome: 'approved', simulated: true }

  const executionId = ctx.parentExecutionId
  const nodeId = ctx.parentNodeId
  if (!executionId || !nodeId) throw new Error('Approval node requires an execution context')

  const run = db
    .prepare(
      `SELECT w.id AS workflow_id, w.workspace_id, w.name AS workflow_name
         FROM executions e JOIN workflows w ON w.id = e.workflow_id
        WHERE e.id = ?`
    )
    .get(executionId)
  if (!run) throw new Error('Approval node could not resolve its execution')

  const id = uuidv4()
  const requestedAt = new Date()
  const expiresAt = new Date(requestedAt.getTime() + timeoutMinutes(config) * 60_000)
  const message =
    typeof config?.message === 'string' && config.message.trim()
      ? config.message.trim().slice(0, 500)
      : null

  db.prepare(
    `INSERT INTO execution_approvals
       (id, execution_id, node_id, workflow_id, workspace_id, status, message, requested_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
  ).run(
    id, executionId, nodeId, run.workflow_id, run.workspace_id,
    message, requestedAt.toISOString(), expiresAt.toISOString()
  )

  notifyMembers(run, { message, executionId })

  // Ride the exec-update channel so an open canvas can render approve/reject
  // controls without polling. The response itself needs no counterpart event:
  // the step settling right after is the signal that clears the controls.
  if (ctx.publish) {
    ctx.publish({
      kind: 'approval',
      workflowId: run.workflow_id,
      executionId,
      nodeId,
      approvalId: id,
      status: 'pending',
      message,
      expiresAt: expiresAt.toISOString(),
    })
  }

  const readApproval = db.prepare('SELECT * FROM execution_approvals WHERE id = ?')
  const readCancel = db.prepare('SELECT cancel_requested FROM executions WHERE id = ?')
  // Every runner-side settle guards on status = 'pending' so a response that
  // lands in the same instant can't be overwritten — whoever's UPDATE ran
  // first wins, and a lost race just loops back to read the winner's verdict.
  const settle = db.prepare(
    "UPDATE execution_approvals SET status = ?, responded_at = ? WHERE id = ? AND status = 'pending'"
  )

  for (;;) {
    const row = readApproval.get(id)
    if (row.status === 'approved' || row.status === 'rejected') {
      const responder = row.responded_by
        ? db.prepare('SELECT display_name FROM users WHERE id = ?').get(row.responded_by)
        : null
      return {
        result: row.status === 'approved',
        outcome: row.status,
        respondedBy: responder?.display_name ?? null,
        note: row.note ?? null,
      }
    }

    // Run cancelled mid-wait: resolve the request so the inbox doesn't keep a
    // dead entry, then settle normally — the engine's own cancel check winds
    // the run down before anything downstream can launch.
    if (readCancel.get(executionId)?.cancel_requested) {
      settle.run('cancelled', new Date().toISOString(), id)
      return { result: false, outcome: 'cancelled' }
    }

    if (Date.now() >= expiresAt.getTime()) {
      const { changes } = settle.run('timed-out', new Date().toISOString(), id)
      // Lost the race to a response arriving this instant — re-read it.
      if (changes === 0) continue
      if ((config?.onTimeout || 'reject') === 'fail') {
        throw new Error(`Approval request timed out after ${timeoutMinutes(config)} minutes`)
      }
      return { result: false, outcome: 'timed-out' }
    }

    await sleep(pollIntervalMs())
  }
}
