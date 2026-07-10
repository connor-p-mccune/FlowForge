// Shared approval-response logic for the session route (routes/approvals.js)
// and the public API (routes/publicApi.js) — one place owns the membership
// gate, the pending-only UPDATE guard, and the activity logging, so the two
// surfaces can't drift apart on semantics.

const db = require('../config/database')
const { logEvent } = require('./activityService')

// Settle a pending approval as `userId`. Returns one of:
//   { outcome: 'not-found' }                       unknown id or not a member
//   { outcome: 'conflict', status }                already settled
//   { outcome: 'responded', approval }             row incl. responded_by_name
function respondToApproval(approvalId, userId, { decision, note } = {}) {
  const approval = db.prepare('SELECT * FROM execution_approvals WHERE id = ?').get(approvalId)
  if (!approval) return { outcome: 'not-found' }
  const member = db.prepare(
    'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(approval.workspace_id, userId)
  if (!member) return { outcome: 'not-found' }

  const status = decision === 'approve' ? 'approved' : 'rejected'
  const trimmedNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 500) : null
  // The pending-only guard lives in the UPDATE itself so a response racing
  // another responder — or the runner's own timeout — resolves to exactly one
  // winner; the loser learns what the verdict was.
  const result = db.prepare(
    `UPDATE execution_approvals
        SET status = ?, responded_at = ?, responded_by = ?, note = ?
      WHERE id = ? AND status = 'pending'`
  ).run(status, new Date().toISOString(), userId, trimmedNote, approval.id)

  if (result.changes === 0) {
    const current = db.prepare('SELECT status FROM execution_approvals WHERE id = ?').get(approval.id)
    return { outcome: 'conflict', status: current.status }
  }

  const workflow = db.prepare('SELECT name FROM workflows WHERE id = ?').get(approval.workflow_id)
  logEvent(approval.workspace_id, userId, `approval.${status}`, {
    type: 'execution',
    id: approval.execution_id,
    name: workflow?.name ?? null,
    metadata: {
      workflowId: approval.workflow_id,
      ...(approval.message ? { message: approval.message } : {}),
      ...(trimmedNote ? { note: trimmedNote } : {}),
    },
  })

  const updated = db.prepare(
    `SELECT a.*, u.display_name AS responded_by_name
       FROM execution_approvals a LEFT JOIN users u ON u.id = a.responded_by
      WHERE a.id = ?`
  ).get(approval.id)
  return { outcome: 'responded', approval: updated }
}

module.exports = { respondToApproval }
