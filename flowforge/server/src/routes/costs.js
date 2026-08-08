// Cost reporting and budget management.
//
// Reads are member-visible: knowing what the workflows you build cost is part
// of building them well, and hiding the number is how a team ends up surprised
// by an invoice. Writing the budget is **owner-only**, like secrets and the
// status page — a spend cap is a workspace-level commitment, and any member
// being able to raise it would make it decorative.

const express = require('express')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { memberRole } = require('../services/workspaceRoles')
const { budgetStatus, costBreakdown, DEFAULT_ALERT_PCT } = require('../services/budget')
const { formatMicroUsd } = require('../services/costModel')

const router = express.Router()

const GROUPINGS = new Set(['workflow', 'day', 'nodeType'])

// GET /api/workspaces/:id/costs?from&to&groupBy=workflow|day|nodeType
router.get('/workspaces/:id/costs', auth, (req, res) => {
  try {
    if (!memberRole(req.params.id, req.user.id)) {
      return res.status(404).json({ error: 'Workspace not found' })
    }
    const groupBy = GROUPINGS.has(req.query.groupBy) ? req.query.groupBy : 'workflow'
    const breakdown = costBreakdown(req.params.id, {
      from: req.query.from,
      to: req.query.to,
      groupBy,
    })
    const status = budgetStatus(req.params.id)
    res.json({
      groupBy,
      budget: status,
      // Pre-formatted alongside the raw integer: every consumer would otherwise
      // reimplement micro-USD rendering, and they would not all agree about how
      // many decimals a sub-cent figure needs.
      total: breakdown.reduce((sum, row) => sum + (row.microUsd || 0), 0),
      breakdown: breakdown.map((row) => ({ ...row, display: formatMicroUsd(row.microUsd) })),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/workspaces/:id/budget — the cap and this month's spend against it.
router.get('/workspaces/:id/budget', auth, (req, res) => {
  try {
    if (!memberRole(req.params.id, req.user.id)) {
      return res.status(404).json({ error: 'Workspace not found' })
    }
    res.json({ budget: budgetStatus(req.params.id) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/workspaces/:id/budget { capUsd, alertPct } — owner-only.
// capUsd is null to remove the budget entirely.
router.put('/workspaces/:id/budget', auth, (req, res) => {
  try {
    const role = memberRole(req.params.id, req.user.id)
    if (!role) return res.status(404).json({ error: 'Workspace not found' })
    if (role !== 'owner') {
      return res.status(403).json({ error: 'Only workspace owners can set the budget' })
    }

    const { capUsd, alertPct } = req.body || {}
    // Dollars in, micro-USD stored: a human reads a vendor's pricing page in
    // dollars, and the conversion belongs at the edge rather than in every
    // caller.
    let capMicroUsd = null
    if (capUsd !== null && capUsd !== undefined) {
      const cap = Number(capUsd)
      if (!Number.isFinite(cap) || cap <= 0) {
        return res.status(400).json({ error: 'capUsd must be a positive number, or null to remove the budget' })
      }
      capMicroUsd = Math.round(cap * 1_000_000)
    }

    let pct = null
    if (alertPct !== null && alertPct !== undefined) {
      const value = Number(alertPct)
      if (!Number.isFinite(value) || value <= 0 || value >= 1) {
        return res.status(400).json({ error: 'alertPct must be a number between 0 and 1 (exclusive)' })
      }
      pct = value
    }

    // Changing the cap clears the outstanding warning: the old alert answered
    // the old budget. Same reasoning as resetting the heartbeat alert when its
    // interval changes.
    db.prepare(
      'UPDATE workspaces SET budget_micro_usd = ?, budget_alert_pct = ?, budget_alerted_month = NULL WHERE id = ?'
    ).run(capMicroUsd, pct ?? (capMicroUsd ? DEFAULT_ALERT_PCT : null), req.params.id)

    res.json({ budget: budgetStatus(req.params.id) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
