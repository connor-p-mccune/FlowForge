// Schedule backfill routes: preview a window, submit it, watch it, stop it.
//
// The preview endpoint is not a convenience — it's the safety mechanism. A
// backfill is one of the few operations here that creates hundreds of runs from
// a single click, and the difference between `0 * * * *` and `* * * * *` over
// the same week is 168 runs versus 10,080. So the same planner that submits is
// exposed read-only first, and the UI makes you look at the count before the
// button does anything.

const express = require('express')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { getExecutionQueue } = require('../config/queue')
const { enqueueOpts } = require('../services/runPriority')
const { forbidViewer } = require('../services/workspaceRoles')
const { isPaused, PAUSED_ERROR } = require('../services/workflowPause')
const { planBackfill, submitBackfill, listBackfills, cancelBackfill } = require('../services/backfill')

const router = express.Router()

function getWorkflowForMember(workflowId, userId) {
  const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId)
  if (!workflow) return null
  const member = db
    .prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(workflow.workspace_id, userId)
  return member ? workflow : null
}

// Shared by the session and public API: everything from "is this allowed?" to
// "the jobs are on the queue". Returns { status, body } so each surface only
// has to own its own auth.
async function runBackfill(workflow, actorId, body) {
  if (isPaused(workflow)) {
    // Pause means stop everything, and bulk historical traffic is exactly what
    // an operator pausing a workflow is trying to prevent.
    return { status: 409, body: { error: PAUSED_ERROR } }
  }
  if (workflow.status !== 'deployed') {
    // A draft has no live cadence to reconstruct. Refusing here also stops a
    // backfill from being a back door around deploy.
    return { status: 400, body: { error: 'Only a deployed workflow can be backfilled' } }
  }

  const result = submitBackfill(workflow, actorId, {
    from: body?.from,
    to: body?.to,
    skipExisting: body?.skipExisting !== false,
    priority: body?.priority,
  })
  if (result.error) return { status: 400, body: { error: result.error } }

  // Enqueue after the rows are committed: Bull is not part of the transaction,
  // and a job pointing at a rolled-back row would be a job that fails on pickup.
  const queue = getExecutionQueue()
  for (const run of result.runs) {
    await queue.add(
      {
        executionId: run.executionId,
        workflowId: workflow.id,
        payload: run.payload,
      },
      enqueueOpts(result.priority)
    )
  }

  return {
    status: 202,
    body: {
      backfillId: result.backfillId,
      priority: result.priority,
      created: result.runs.length,
      skipped: result.plan.skipped,
      from: result.plan.from,
      to: result.plan.to,
      timeZone: result.plan.timeZone,
    },
  }
}

// POST /api/workflows/:id/backfill { from, to, skipExisting?, priority?, preview? }
// With preview:true it computes and returns the plan without creating anything.
router.post('/workflows/:id/backfill', auth, async (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return

    if (req.body?.preview) {
      const plan = planBackfill(workflow, {
        from: req.body.from,
        to: req.body.to,
        skipExisting: req.body.skipExisting !== false,
      })
      if (plan.error) return res.status(400).json({ error: plan.error })
      return res.json(plan)
    }

    const { status, body } = await runBackfill(workflow, req.user.id, req.body)
    res.status(status).json(body)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/workflows/:id/backfills — every batch and how far along it is.
router.get('/workflows/:id/backfills', auth, (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    res.json({ backfills: listBackfills(workflow.id, req.query.limit) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/backfills/:backfillId/cancel — stop the rest of a
// batch. Runs already finished stay finished; the point is to stop the queue,
// not to erase what happened.
router.post('/workflows/:id/backfills/:backfillId/cancel', auth, (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    res.json(cancelBackfill(workflow.id, req.params.backfillId))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
// Shared with the public API so /api/v1 exposes the same behaviour rather than
// a second implementation that could drift.
module.exports.runBackfill = runBackfill
module.exports.getWorkflowForMember = getWorkflowForMember
