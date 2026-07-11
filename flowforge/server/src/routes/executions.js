const express = require('express')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { getExecutionQueue } = require('../config/queue')
const { requestCancel } = require('../services/executionControl')
const { admitRun } = require('../services/concurrencyGate')

const router = express.Router()

function getWorkflowForMember(workflowId, userId) {
  const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId)
  if (!workflow) return null
  const member = db.prepare(
    'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(workflow.workspace_id, userId)
  return member ? workflow : null
}

// Build the nested call tree for an execution: for every sub-workflow run it
// spawned (rows whose parent_execution_id points back here), a recursive
// { execution, steps, childExecutions } entry, ordered by when each was created.
// The tree is finite (the engine rejects cyclic references at run time) but a
// depth cap guards against a pathologically deep chain. No per-child membership
// check is needed: a sub-workflow always runs in its parent's workspace (enforced
// in the sub-workflow runner), so the caller's check on the root execution covers
// the whole tree.
function buildChildExecutions(parentExecutionId, depth = 0) {
  if (depth > 25) return []
  const children = db.prepare(
    'SELECT * FROM executions WHERE parent_execution_id = ? ORDER BY rowid'
  ).all(parentExecutionId)
  return children.map((execution) => ({
    execution,
    steps: db.prepare(
      'SELECT * FROM execution_steps WHERE execution_id = ? ORDER BY rowid'
    ).all(execution.id),
    childExecutions: buildChildExecutions(execution.id, depth + 1),
  }))
}

// POST /api/workflows/:id/execute — enqueue a run
router.post('/workflows/:id/execute', auth, async (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })

    const { nodes } = JSON.parse(workflow.graph_json)
    if (!nodes || nodes.length === 0) {
      return res.status(400).json({ error: 'Workflow has no nodes to execute' })
    }

    // 'reject' concurrency policy: refuse the submission at the cap so the
    // caller finds out now rather than watching a run sit queued.
    const admission = admitRun(workflow)
    if (!admission.ok) return res.status(409).json({ error: admission.error })

    const executionId = uuidv4()
    const now = new Date().toISOString()
    // Manual runs carry no trigger payload (trigger_data null); trigger_type marks
    // the source so a replay of this run starts from the same empty input.
    db.prepare(
      'INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(executionId, workflow.id, 'pending', req.user.id, 'manual', now)

    await getExecutionQueue().add({ executionId, workflowId: workflow.id })

    const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId)
    res.status(202).json({ execution })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/test — enqueue a dry run. Identical to /execute, but
// the job carries dryRun: true so side-effecting nodes (email/Slack/HTTP) report
// what they would have sent instead of firing. trigger_type 'dry-run' marks the
// run so history can flag it and a later replay stays a dry run (see below).
router.post('/workflows/:id/test', auth, async (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })

    const { nodes } = JSON.parse(workflow.graph_json)
    if (!nodes || nodes.length === 0) {
      return res.status(400).json({ error: 'Workflow has no nodes to execute' })
    }

    const executionId = uuidv4()
    const now = new Date().toISOString()
    // triggered_by stays the user FK (who ran the test); trigger_type 'dry-run'
    // is the marker, mirroring how 'manual'/'webhook'/'replay' are recorded.
    db.prepare(
      'INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(executionId, workflow.id, 'pending', req.user.id, 'dry-run', now)

    await getExecutionQueue().add({ executionId, workflowId: workflow.id, dryRun: true })

    const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId)
    res.status(202).json({ execution })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/workflows/:id/executions — past runs, newest first. workflowUpdatedAt
// lets the client flag runs whose workflow has been edited since (a replay runs
// the *current* definition), without a per-row query.
router.get('/workflows/:id/executions', auth, (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })

    const executions = db.prepare(
      'SELECT * FROM executions WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 50'
    ).all(workflow.id)
    res.json({ executions, workflowUpdatedAt: workflow.updated_at })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/executions/:id — one run with its steps
router.get('/executions/:id', auth, (req, res) => {
  try {
    const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(req.params.id)
    if (!execution) return res.status(404).json({ error: 'Execution not found' })

    const workflow = getWorkflowForMember(execution.workflow_id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Execution not found' })

    const steps = db.prepare(
      'SELECT * FROM execution_steps WHERE execution_id = ? ORDER BY rowid'
    ).all(execution.id)
    // Sub-workflow runs spawned by this execution, nested so the UI can trace the
    // full call tree. Empty for the common case (no sub-workflow nodes).
    const childExecutions = buildChildExecutions(execution.id)
    // Approval requests this run filed (approval nodes), so the run detail can
    // show who decided what — or offer approve/reject while one is pending.
    const approvals = db.prepare(
      `SELECT a.*, u.display_name AS responded_by_name
         FROM execution_approvals a LEFT JOIN users u ON u.id = a.responded_by
        WHERE a.execution_id = ? ORDER BY a.requested_at`
    ).all(execution.id)
    res.json({ execution, steps, childExecutions, approvals })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/executions/:id/cancel — stop a queued or running execution. Queued
// runs are finalized immediately; running ones are wound down cooperatively by
// the engine at its next scheduling round (an in-flight node always finishes —
// cancellation never tears a node down mid-call). 409 once the run is over.
router.post('/executions/:id/cancel', auth, (req, res) => {
  try {
    const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(req.params.id)
    if (!execution) return res.status(404).json({ error: 'Execution not found' })
    if (!getWorkflowForMember(execution.workflow_id, req.user.id)) {
      return res.status(404).json({ error: 'Execution not found' })
    }

    const { outcome } = requestCancel(execution)
    if (outcome === 'finished') {
      return res.status(409).json({ error: `Execution already ${execution.status}` })
    }
    const updated = db.prepare('SELECT * FROM executions WHERE id = ?').get(execution.id)
    res.status(202).json({ execution: updated })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/executions/:id/replay — re-run a past execution with its original
// trigger data. Runs the workflow's *current* definition (matching how a redeploy
// or graph edit affects future runs) against the original run's stored payload, so
// the output matches the original whenever the workflow is unchanged.
router.post('/executions/:id/replay', auth, async (req, res) => {
  try {
    const original = db.prepare('SELECT * FROM executions WHERE id = ?').get(req.params.id)
    if (!original) return res.status(404).json({ error: 'Execution not found' })

    // Reuse the same membership gate as the detail route — non-members get 404.
    const workflow = getWorkflowForMember(original.workflow_id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Execution not found' })

    const { nodes } = JSON.parse(workflow.graph_json)
    if (!nodes || nodes.length === 0) {
      return res.status(400).json({ error: 'Workflow has no nodes to execute' })
    }

    // Parse the stored trigger payload to enqueue (the engine also reads it off the
    // row, but passing it keeps replay identical to the live webhook path). A
    // malformed/empty value replays with an empty payload.
    let payload = {}
    if (original.trigger_data) {
      try {
        const parsed = JSON.parse(original.trigger_data)
        if (parsed && typeof parsed === 'object') payload = parsed
      } catch {
        /* malformed trigger_data — replay with empty payload */
      }
    }

    // Replaying a dry-run stays a dry-run, so re-running a test from history never
    // fires real actions; any other run replays for real as 'replay'.
    const isDryRun = original.trigger_type === 'dry-run'

    // Real replays count toward the workflow's concurrency cap like any run.
    if (!isDryRun) {
      const admission = admitRun(workflow)
      if (!admission.ok) return res.status(409).json({ error: admission.error })
    }

    const executionId = uuidv4()
    const now = new Date().toISOString()
    // triggered_by is the user who clicked Replay; trigger_type marks it a replay
    // (or 'dry-run' when the original was a test).
    db.prepare(
      'INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, trigger_data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(executionId, workflow.id, 'pending', req.user.id, isDryRun ? 'dry-run' : 'replay', original.trigger_data ?? null, now)

    await getExecutionQueue().add({
      executionId,
      workflowId: workflow.id,
      payload,
      ...(isDryRun ? { dryRun: true } : {}),
    })

    const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId)
    res.status(202).json({ execution })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/executions/:id/resume — continue a failed or cancelled run from
// where it stopped. Starts a fresh execution that points back at the original
// (resumed_from_execution_id); the engine adopts the original's succeeded step
// outputs (step status 'reused') and re-executes only the remainder — an
// approval gate that was already granted is not asked again. Like replay, the
// workflow's *current* definition runs: an edited node, and transitively
// everything downstream of any node that re-executes, runs fresh.
router.post('/executions/:id/resume', auth, async (req, res) => {
  try {
    const original = db.prepare('SELECT * FROM executions WHERE id = ?').get(req.params.id)
    if (!original) return res.status(404).json({ error: 'Execution not found' })

    const workflow = getWorkflowForMember(original.workflow_id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Execution not found' })

    if (original.status !== 'failed' && original.status !== 'cancelled') {
      return res.status(409).json({
        error: `Only a failed or cancelled run can be resumed (this one is ${original.status})`,
      })
    }

    const { nodes } = JSON.parse(workflow.graph_json)
    if (!nodes || nodes.length === 0) {
      return res.status(400).json({ error: 'Workflow has no nodes to execute' })
    }

    // Same payload handling as replay: the original trigger input carries over,
    // though reused trigger steps normally supersede it.
    let payload = {}
    if (original.trigger_data) {
      try {
        const parsed = JSON.parse(original.trigger_data)
        if (parsed && typeof parsed === 'object') payload = parsed
      } catch {
        /* malformed trigger_data — resume with empty payload */
      }
    }

    // Resuming a dry-run stays a dry-run, mirroring replay — continuing a test
    // must never fire real actions.
    const isDryRun = original.trigger_type === 'dry-run'

    // A resume starts a run; it counts toward the concurrency cap like any run.
    if (!isDryRun) {
      const admission = admitRun(workflow)
      if (!admission.ok) return res.status(409).json({ error: admission.error })
    }

    const executionId = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO executions
         (id, workflow_id, status, triggered_by, trigger_type, trigger_data, resumed_from_execution_id, created_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`
    ).run(
      executionId, workflow.id, req.user.id, isDryRun ? 'dry-run' : 'resume',
      original.trigger_data ?? null, original.id, now
    )

    await getExecutionQueue().add({
      executionId,
      workflowId: workflow.id,
      payload,
      ...(isDryRun ? { dryRun: true } : {}),
    })

    const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId)
    res.status(202).json({ execution })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
