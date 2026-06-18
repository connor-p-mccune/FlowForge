const express = require('express')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { getExecutionQueue } = require('../config/queue')

const router = express.Router()

function getWorkflowForMember(workflowId, userId) {
  const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId)
  if (!workflow) return null
  const member = db.prepare(
    'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(workflow.workspace_id, userId)
  return member ? workflow : null
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
    res.json({ execution, steps })
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

module.exports = router
