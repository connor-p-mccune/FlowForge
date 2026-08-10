// Progressive delivery endpoints: start a canary, watch it, and end it.
//
// The verbs are deliberately four rather than two, because "stop the canary"
// means three genuinely different things and collapsing them would make the
// dangerous one the default:
//
//   promote   the live canvas becomes the deployed definition (an ordinary
//             deploy, with the canary cleared)
//   rollback  traffic goes to 0% and stays on the baseline; the canvas keeps
//             the edits so they can be fixed and retried
//   abandon   the experiment ends and the live canvas serves everything again,
//             which is how a workflow with no canary behaves
//   adjust    change the percentage without ending anything
//
// A canary's *analysis* is a read, available to any member; every transition
// is a write and goes through the same viewer check and policy gate as a
// deploy — promoting is deploying, so it must not be a way around either.

const express = require('express')
const db = require('../config/database')
const auth = require('../middleware/auth')
const canary = require('../services/canary')
const { snapshotVersion } = require('../services/canaryMonitor')
const activityService = require('../services/activityService')
const scheduler = require('../services/scheduler')
const { forbidViewer } = require('../services/workspaceRoles')
const { recordAudit } = require('../services/auditLog')
const { checkWorkflow } = require('../services/policyGate')

const router = express.Router()

function isMember(workspaceId, userId) {
  return Boolean(
    db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(workspaceId, userId)
  )
}

function visibleWorkflow(req, res) {
  const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
  if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
    res.status(404).json({ error: 'Workflow not found' })
    return null
  }
  return workflow
}

// Re-point the cron registration at whatever definition now serves the
// workflow. A promoted graph may carry a different schedule — or none — and a
// promotion that left a stale cron running would fire the old expression
// against the new definition.
function syncSchedule(workflow) {
  try {
    const graph = JSON.parse(workflow.graph_json)
    const scheduleNode = (graph.nodes || []).find((n) => n.type === 'trigger-schedule')
    if (scheduleNode && workflow.status === 'deployed') {
      scheduler.registerSchedule(
        workflow.id,
        scheduleNode.data?.config?.cron,
        scheduler.scheduleTimeZone(scheduleNode.data?.config)
      )
    } else {
      scheduler.unregisterSchedule(workflow.id)
    }
  } catch (err) {
    console.error(`Failed to sync schedule after promotion: ${err.message}`)
  }
}

// GET /api/workflows/:id/canary — status and the statistical comparison.
// Cheap (two counted queries) and side-effect-free, so it is safe to poll from
// a panel — which is the point: watching a release is the whole activity.
router.get('/workflows/:id/canary', auth, (req, res) => {
  try {
    const workflow = visibleWorkflow(req, res)
    if (!workflow) return
    res.json({ workflowId: workflow.id, ...canary.analyze(workflow) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/canary — start one.
router.post('/workflows/:id/canary', auth, (req, res) => {
  try {
    const workflow = visibleWorkflow(req, res)
    if (!workflow) return
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    if (canary.activeCanary(workflow)) {
      return res.status(409).json({ error: 'A canary is already running for this workflow' })
    }

    // The canary sends real traffic to the live canvas, so it is a publication
    // and gets the same policy check a deploy does. Skipping it here would make
    // "start a canary at 99%" a way around the gate.
    const policy = checkWorkflow(workflow)
    if (policy.blocked) {
      return res.status(422).json({
        error: 'Canary blocked by workspace policy',
        violations: policy.violations,
      })
    }

    const { versionId, percent, minRuns, auto } = req.body || {}
    const result = canary.start(workflow, { versionId, percent, minRuns, auto })
    if (result.error) return res.status(400).json({ error: result.error })

    activityService.logEvent(workflow.workspace_id, req.user.id, 'workflow.canary_started', {
      type: 'workflow', id: workflow.id, name: workflow.name,
      metadata: { percent: result.percent, baselineVersion: result.baselineVersion },
    })
    const updated = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflow.id)
    res.status(201).json({ workflowId: workflow.id, ...canary.analyze(updated) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/workflows/:id/canary — change the traffic share without ending it.
// Ramping (5% → 25% → 50%) is the normal way a release progresses, so it must
// not require tearing the experiment down and losing its accumulated sample.
router.put('/workflows/:id/canary', auth, (req, res) => {
  try {
    const workflow = visibleWorkflow(req, res)
    if (!workflow) return
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    const active = canary.activeCanary(workflow)
    if (!active) return res.status(404).json({ error: 'No canary is running for this workflow' })

    const percent = Number(req.body?.percent)
    if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) {
      return res.status(400).json({ error: 'percent must be between 1 and 99' })
    }
    // Ramping a rolled-back canary resumes it: the author fixed something and
    // wants to try again, and forcing them to recreate the experiment would
    // discard the baseline they were measuring against.
    db.prepare("UPDATE workflows SET canary_percent = ?, canary_state = 'running' WHERE id = ?")
      .run(Math.round(percent), workflow.id)
    const updated = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflow.id)
    res.json({ workflowId: workflow.id, ...canary.analyze(updated) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/canary/promote — the live canvas becomes the
// deployed definition. This *is* a deploy, so it snapshots a version, marks the
// workflow deployed, re-points the schedule, and passes the policy gate.
router.post('/workflows/:id/canary/promote', auth, (req, res) => {
  try {
    const workflow = visibleWorkflow(req, res)
    if (!workflow) return
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    if (!canary.activeCanary(workflow)) {
      return res.status(404).json({ error: 'No canary is running for this workflow' })
    }

    const policy = checkWorkflow(workflow)
    if (policy.blocked) {
      return res.status(422).json({
        error: 'Promotion blocked by workspace policy',
        violations: policy.violations,
      })
    }

    const { version } = canary.promote(workflow, { snapshot: () => snapshotVersion(workflow) })
    const updated = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflow.id)
    syncSchedule(updated)

    activityService.logEvent(workflow.workspace_id, req.user.id, 'workflow.canary_promoted', {
      type: 'workflow', id: workflow.id, name: workflow.name,
      metadata: { version: version.version },
    })
    recordAudit(workflow.workspace_id, req.user.id, 'workflow.deployed', {
      type: 'workflow', id: workflow.id, name: workflow.name,
      metadata: { version: version.version, via: 'canary-promotion' },
    })
    res.json({ promoted: true, version: version.version })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/canary/rollback — traffic to 0%, baseline serves
// everything. Nothing is restored and nothing is overwritten; the canvas keeps
// the edits so they can be fixed and the canary resumed.
router.post('/workflows/:id/canary/rollback', auth, (req, res) => {
  try {
    const workflow = visibleWorkflow(req, res)
    if (!workflow) return
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    if (!canary.activeCanary(workflow)) {
      return res.status(404).json({ error: 'No canary is running for this workflow' })
    }
    const reason = req.body?.reason ? String(req.body.reason).slice(0, 500) : 'rolled back manually'
    canary.rollback(workflow.id, { reason })
    activityService.logEvent(workflow.workspace_id, req.user.id, 'workflow.canary_rolled_back', {
      type: 'workflow', id: workflow.id, name: workflow.name,
      metadata: { reason },
    })
    res.json({ rolledBack: true, reason })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/workflows/:id/canary — end the experiment. The live canvas serves
// every run again, which is how a workflow with no canary behaves.
router.delete('/workflows/:id/canary', auth, (req, res) => {
  try {
    const workflow = visibleWorkflow(req, res)
    if (!workflow) return
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    if (!canary.activeCanary(workflow)) {
      return res.status(404).json({ error: 'No canary is running for this workflow' })
    }
    canary.abandon(workflow.id)
    res.json({ ended: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
