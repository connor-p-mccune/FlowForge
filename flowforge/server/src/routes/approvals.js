// Human-in-the-loop approvals. The approval node runner files a pending
// execution_approvals row and polls it; these routes are the human half —
// an inbox of waiting requests across the caller's workspaces, and the
// respond endpoint that settles one. Missing and forbidden both read as 404
// so foreign resource ids are never confirmed, matching the rest of the API.

const express = require('express')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { respondToApproval } = require('../services/approvals')

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
// settle a pending approval. Semantics live in services/approvals.js (shared
// with the public API): the pending-only guard means two concurrent
// responders can't both win, and the loser gets a 409 with the verdict.
router.post('/approvals/:id/respond', auth, (req, res) => {
  try {
    const { decision, note } = req.body || {}
    if (decision !== 'approve' && decision !== 'reject') {
      return res.status(400).json({ error: 'decision must be "approve" or "reject"' })
    }

    const result = respondToApproval(req.params.id, req.user.id, { decision, note })
    if (result.outcome === 'not-found') {
      return res.status(404).json({ error: 'Approval not found' })
    }
    if (result.outcome === 'conflict') {
      return res.status(409).json({ error: `Approval already ${result.status}` })
    }
    res.json({ approval: result.approval })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
