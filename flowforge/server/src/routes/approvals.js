// Human-in-the-loop approvals. The approval node runner files a pending
// execution_approvals row and polls it; these routes are the human half —
// an inbox of waiting requests across the caller's workspaces, and the
// respond endpoint that settles one. Missing and forbidden both read as 404
// so foreign resource ids are never confirmed, matching the rest of the API.

const express = require('express')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { logEvent } = require('../services/activityService')

const router = express.Router()

const STATUSES = ['pending', 'approved', 'rejected', 'timed-out', 'cancelled']

// GET /api/approvals?status=pending — the caller's approval inbox, newest
// first, across every workspace they belong to. Joined with the workflow for
// a displayable name (LEFT so a deleted workflow doesn't drop the row).
router.get('/approvals', auth, (req, res) => {
  try {
    const status = req.query.status || 'pending'
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` })
    }
    const approvals = db.prepare(
      `SELECT a.*, w.name AS workflow_name, u.display_name AS responded_by_name
         FROM execution_approvals a
         JOIN workspace_members wm ON wm.workspace_id = a.workspace_id AND wm.user_id = ?
         LEFT JOIN workflows w ON w.id = a.workflow_id
         LEFT JOIN users u ON u.id = a.responded_by
        WHERE a.status = ?
        ORDER BY a.requested_at DESC
        LIMIT 100`
    ).all(req.user.id, status)
    res.json({ approvals })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/approvals/:id/respond { decision: 'approve' | 'reject', note? } —
// settle a pending approval. The pending-only guard lives in the UPDATE itself
// so two concurrent responders (or a response racing the runner's timeout)
// can't both win; the loser gets a 409 with the settled status.
router.post('/approvals/:id/respond', auth, (req, res) => {
  try {
    const { decision, note } = req.body || {}
    if (decision !== 'approve' && decision !== 'reject') {
      return res.status(400).json({ error: 'decision must be "approve" or "reject"' })
    }

    const approval = db.prepare('SELECT * FROM execution_approvals WHERE id = ?').get(req.params.id)
    if (!approval) return res.status(404).json({ error: 'Approval not found' })
    const member = db.prepare(
      'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
    ).get(approval.workspace_id, req.user.id)
    if (!member) return res.status(404).json({ error: 'Approval not found' })

    const status = decision === 'approve' ? 'approved' : 'rejected'
    const trimmedNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 500) : null
    const result = db.prepare(
      `UPDATE execution_approvals
          SET status = ?, responded_at = ?, responded_by = ?, note = ?
        WHERE id = ? AND status = 'pending'`
    ).run(status, new Date().toISOString(), req.user.id, trimmedNote, approval.id)

    if (result.changes === 0) {
      const current = db.prepare('SELECT status FROM execution_approvals WHERE id = ?').get(approval.id)
      return res.status(409).json({ error: `Approval already ${current.status}` })
    }

    const workflow = db.prepare('SELECT name FROM workflows WHERE id = ?').get(approval.workflow_id)
    logEvent(approval.workspace_id, req.user.id, `approval.${status}`, {
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
    res.json({ approval: updated })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
