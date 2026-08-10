// Chaos profiles: arm a workflow with deliberate faults, read what is armed,
// and disarm it.
//
// Two things are enforced here rather than in the service, because both are
// about *who* may do it rather than what a valid profile looks like:
//
//   * Widening a profile to real runs (`scope: "all"`) is **owner-only**.
//     Breaking test runs is authoring; breaking production is an operational
//     decision with the same weight as pulling the pause switch, and it lands
//     in the audit log for the same reason.
//   * Every arm and disarm is audited. "Why did the 3am runs fail?" has a much
//     better answer when the record shows someone armed a fault profile at
//     2:50 — and a much worse one when nothing recorded it.

const express = require('express')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { forbidViewer, memberRole } = require('../services/workspaceRoles')
const { recordAudit } = require('../services/auditLog')
const activityService = require('../services/activityService')
const { parseProfile, loadProfile } = require('../services/faultInjection')

const router = express.Router()

function visibleWorkflow(req, res) {
  const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
  const member = workflow && memberRole(workflow.workspace_id, req.user.id)
  if (!workflow || !member) {
    res.status(404).json({ error: 'Workflow not found' })
    return null
  }
  return workflow
}

// GET /api/workflows/:id/chaos — what is armed, if anything.
//
// Reports the stored profile *and* whether it is currently in force, because
// those differ the moment it expires — and "I armed it, why is nothing
// failing?" is exactly the question a chaos tool has to answer directly.
router.get('/workflows/:id/chaos', auth, (req, res) => {
  try {
    const workflow = visibleWorkflow(req, res)
    if (!workflow) return
    let stored = null
    try {
      stored = workflow.chaos_config ? JSON.parse(workflow.chaos_config) : null
    } catch {
      /* unparseable stored profile reads as none */
    }
    res.json({
      workflowId: workflow.id,
      profile: stored,
      active: Boolean(loadProfile(workflow.chaos_config)),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/workflows/:id/chaos — arm (or replace) the profile.
router.put('/workflows/:id/chaos', auth, (req, res) => {
  try {
    const workflow = visibleWorkflow(req, res)
    if (!workflow) return
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return

    const { profile, error } = parseProfile(req.body)
    if (error) return res.status(400).json({ error })
    if (!profile) return res.status(400).json({ error: 'a profile is required' })

    if (profile.scope === 'all' && memberRole(workflow.workspace_id, req.user.id) !== 'owner') {
      return res.status(403).json({
        error: 'Only workspace owners can inject faults into real runs',
      })
    }

    db.prepare('UPDATE workflows SET chaos_config = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(profile), new Date().toISOString(), workflow.id)

    recordAudit(workflow.workspace_id, req.user.id, 'chaos.armed', {
      type: 'workflow',
      id: workflow.id,
      name: workflow.name,
      metadata: { scope: profile.scope, rules: profile.rules.length, expiresAt: profile.expiresAt },
    })
    // A profile that touches real runs is workspace-visible news, not a
    // private authoring detail — the feed is where someone debugging an
    // unexplained failure will look first.
    if (profile.scope === 'all') {
      activityService.logEvent(workflow.workspace_id, req.user.id, 'workflow.chaos_armed', {
        type: 'workflow', id: workflow.id, name: workflow.name,
        metadata: { rules: profile.rules.length, expiresAt: profile.expiresAt },
      })
    }

    res.json({ workflowId: workflow.id, profile, active: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/workflows/:id/chaos — disarm. Idempotent: disarming a workflow
// with no profile is a success, because the caller's intent is already true.
router.delete('/workflows/:id/chaos', auth, (req, res) => {
  try {
    const workflow = visibleWorkflow(req, res)
    if (!workflow) return
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    const had = Boolean(workflow.chaos_config)
    db.prepare('UPDATE workflows SET chaos_config = NULL, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), workflow.id)
    if (had) {
      recordAudit(workflow.workspace_id, req.user.id, 'chaos.disarmed', {
        type: 'workflow', id: workflow.id, name: workflow.name,
      })
    }
    res.json({ disarmed: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
