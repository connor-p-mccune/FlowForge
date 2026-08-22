// Shared approval-response logic for the session route (routes/approvals.js)
// and the public API (routes/publicApi.js) — one place owns the membership
// gate, the eligibility rules, the pending-only UPDATE guard, and the activity
// logging, so the two surfaces can't drift apart on semantics.
//
// A response is now two writes rather than one: a **vote** (one row per person,
// kept forever) and, only when the votes settle the gate, the **verdict** on the
// approval row. Splitting them is what makes a quorum possible at all, and it is
// what makes the audit trail answer the question an incident review actually
// asks — the single `responded_by` column can only hold whoever happened to be
// last, which with four-eyes is the least interesting of the names.

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { logEvent } = require('./activityService')
const { canEdit, memberRole } = require('./workspaceRoles')
const { judgeResponder, verdict } = require('./approvalQuorum')

// The gate stored on the request when it was filed, rather than whatever the
// node's config says now — see the note in config/database.js about why the
// rules travel with the request.
function storedGate(approval) {
  return {
    quorum: Math.max(1, approval.quorum || 1),
    requiredRole: approval.required_role === 'owner' ? 'owner' : 'any',
    separationOfDuties: Boolean(approval.excluded_user_id),
  }
}

function responsesFor(approvalId) {
  return db
    .prepare(
      'SELECT user_id AS userId, decision, note FROM execution_approval_responses WHERE approval_id = ? ORDER BY created_at'
    )
    .all(approvalId)
}

// Settle (or advance) a pending approval as `userId`. Returns one of:
//   { outcome: 'not-found' }                       unknown id or not a member
//   { outcome: 'forbidden', reason, message }      viewer, wrong role, or SoD
//   { outcome: 'conflict', status }                already settled
//   { outcome: 'duplicate', progress }             this person already voted
//   { outcome: 'recorded', approval, progress }    counted, quorum not yet met
//   { outcome: 'responded', approval, progress }   settled
function respondToApproval(approvalId, userId, { decision, note } = {}) {
  const approval = db.prepare('SELECT * FROM execution_approvals WHERE id = ?').get(approvalId)
  if (!approval) return { outcome: 'not-found' }
  const member = db.prepare(
    'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(approval.workspace_id, userId)
  if (!member) return { outcome: 'not-found' }
  // Settling a gate routes a production run — a state change, so viewers may
  // see the inbox but not decide it. Checked here (not per route) so the
  // session API and the public API can't drift.
  if (!canEdit(approval.workspace_id, userId)) {
    return { outcome: 'forbidden', reason: 'viewer', message: 'Viewers have read-only access' }
  }

  // The declared gate: an owner-only requirement, and separation of duties.
  const gate = storedGate(approval)
  const judgement = judgeResponder(
    gate,
    { userId, role: memberRole(approval.workspace_id, userId) },
    approval.excluded_user_id
  )
  if (!judgement.allowed) {
    return { outcome: 'forbidden', reason: judgement.reason, message: judgement.message }
  }

  // Refuse early on an already-settled request, so a late responder gets the
  // verdict rather than a vote recorded against a decision that is over.
  if (approval.status !== 'pending') {
    return { outcome: 'conflict', status: approval.status }
  }

  const trimmedNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 500) : null

  // One person, one vote — enforced by the UNIQUE index rather than by a
  // check-then-insert, because two simultaneous clicks from the same account
  // would both pass a check. A quorum somebody can satisfy alone is not a
  // quorum, so this constraint *is* the feature.
  try {
    db.prepare(
      `INSERT INTO execution_approval_responses (id, approval_id, user_id, decision, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(uuidv4(), approval.id, userId, decision, trimmedNote, new Date().toISOString())
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return { outcome: 'duplicate', progress: verdict(gate, responsesFor(approval.id)) }
    }
    throw err
  }

  const progress = verdict(gate, responsesFor(approval.id))
  if (!progress.settled) {
    // Counted, but the gate is still open. Logged like a settlement, because
    // "who has signed off so far" is a governed fact even before the last one
    // arrives — and if the request then times out, this is the only record that
    // anybody approved it at all.
    logApprovalEvent(approval, userId, 'approval.recorded', trimmedNote, progress)
    return { outcome: 'recorded', approval: readApproval(approval.id), progress }
  }

  // The pending-only guard lives in the UPDATE itself so a response racing
  // another responder — or the runner's own timeout — resolves to exactly one
  // winner; the loser learns what the verdict was.
  const result = db.prepare(
    `UPDATE execution_approvals
        SET status = ?, responded_at = ?, responded_by = ?, note = ?
      WHERE id = ? AND status = 'pending'`
  ).run(progress.status, new Date().toISOString(), userId, trimmedNote, approval.id)

  if (result.changes === 0) {
    const current = db.prepare('SELECT status FROM execution_approvals WHERE id = ?').get(approval.id)
    return { outcome: 'conflict', status: current.status }
  }

  logApprovalEvent(approval, userId, `approval.${progress.status}`, trimmedNote, progress)
  return { outcome: 'responded', approval: readApproval(approval.id), progress }
}

function readApproval(id) {
  return db.prepare(
    `SELECT a.*, u.display_name AS responded_by_name
       FROM execution_approvals a LEFT JOIN users u ON u.id = a.responded_by
      WHERE a.id = ?`
  ).get(id)
}

function logApprovalEvent(approval, userId, eventType, note, progress) {
  const workflow = db.prepare('SELECT name FROM workflows WHERE id = ?').get(approval.workflow_id)
  logEvent(approval.workspace_id, userId, eventType, {
    type: 'execution',
    id: approval.execution_id,
    name: workflow?.name ?? null,
    metadata: {
      workflowId: approval.workflow_id,
      ...(approval.message ? { message: approval.message } : {}),
      ...(note ? { note } : {}),
      // Only when the gate asked for more than one, so an ordinary approval's
      // audit entry is exactly what it always was.
      ...(progress.needed > 1 ? { approvals: progress.approvals, quorum: progress.needed } : {}),
    },
  })
}

// Every vote cast on an approval, for the run detail and the audit trail.
function listResponses(approvalId) {
  return db
    .prepare(
      `SELECT r.decision, r.note, r.created_at, u.display_name AS responder_name, r.user_id
         FROM execution_approval_responses r LEFT JOIN users u ON u.id = r.user_id
        WHERE r.approval_id = ? ORDER BY r.created_at`
    )
    .all(approvalId)
}

module.exports = { respondToApproval, listResponses, storedGate }
