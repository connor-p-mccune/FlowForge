// Public REST API (mounted at /api/v1), authenticated with personal access
// tokens (middleware/tokenAuth.js). This is the programmatic surface for
// integrating FlowForge into external systems — trigger a workflow from a CI
// job or cron box, then poll the run to completion. Documented with curl
// examples in docs/API.md.
//
// Authorization model: a token acts as its owning user, so every route
// re-checks workspace membership exactly like the session API — a token can
// never see more than its owner could. Missing and forbidden both read as 404
// to avoid confirming foreign resource ids.

const express = require('express')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const tokenAuth = require('../middleware/tokenAuth')
const { publicApiLimiter } = require('../middleware/rateLimit')
const { getExecutionQueue } = require('../config/queue')
const { requestCancel } = require('../services/executionControl')

const router = express.Router()

router.use(publicApiLimiter)

function getWorkflowForMember(workflowId, userId) {
  const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId)
  if (!workflow) return null
  const member = db.prepare(
    'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(workflow.workspace_id, userId)
  return member ? workflow : null
}

// GET /api/v1/workflows — workflows across every workspace the token's owner
// belongs to. The id here is what /workflows/:id/trigger takes.
router.get('/workflows', tokenAuth('read'), (req, res) => {
  try {
    const workflows = db.prepare(
      `SELECT wf.id, wf.name, wf.description, wf.status, wf.workspace_id, wf.updated_at
         FROM workflows wf
         JOIN workspace_members wm ON wm.workspace_id = wf.workspace_id
        WHERE wm.user_id = ?
        ORDER BY wf.updated_at DESC`
    ).all(req.user.id)
    res.json({ workflows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/v1/workflows/:id/trigger — start a run. The JSON body (if any)
// becomes the trigger payload, flowing into the graph exactly like a webhook
// body ({{trigger-node-id.field}}). Responds 202 with the execution id to poll.
router.post('/workflows/:id/trigger', tokenAuth('trigger'), async (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })

    const { nodes } = JSON.parse(workflow.graph_json)
    if (!nodes || nodes.length === 0) {
      return res.status(400).json({ error: 'Workflow has no nodes to execute' })
    }

    const payload = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}

    const executionId = uuidv4()
    const now = new Date().toISOString()
    // trigger_type 'api' marks the source; trigger_data persists the payload so
    // the run is replayable like a webhook-triggered one.
    db.prepare(
      `INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, trigger_data, created_at)
       VALUES (?, ?, 'pending', ?, 'api', ?, ?)`
    ).run(executionId, workflow.id, req.user.id, Object.keys(payload).length ? JSON.stringify(payload) : null, now)

    await getExecutionQueue().add({ executionId, workflowId: workflow.id, payload })

    res.status(202).json({
      execution: { id: executionId, workflowId: workflow.id, status: 'pending' },
      // Where to poll for the result.
      statusUrl: `/api/v1/executions/${executionId}`,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/v1/executions/:id — a run's status and its steps (inputs/outputs
// already secret-redacted by the engine before they were persisted).
router.get('/executions/:id', tokenAuth('read'), (req, res) => {
  try {
    const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(req.params.id)
    if (!execution) return res.status(404).json({ error: 'Execution not found' })
    const workflow = getWorkflowForMember(execution.workflow_id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Execution not found' })

    const steps = db.prepare(
      'SELECT id, node_id, node_type, status, input_json, output_json, error, started_at, finished_at FROM execution_steps WHERE execution_id = ? ORDER BY rowid'
    ).all(execution.id)
    res.json({
      execution: {
        id: execution.id,
        workflowId: execution.workflow_id,
        status: execution.status,
        triggerType: execution.trigger_type,
        startedAt: execution.started_at,
        finishedAt: execution.finished_at,
      },
      steps,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/v1/executions/:id/cancel — stop a queued or running run. Requires
// the trigger scope (it changes run state, like starting one does). Queued runs
// finalize immediately; running ones wind down at the engine's next scheduling
// round. 409 once the run has already finished.
router.post('/executions/:id/cancel', tokenAuth('trigger'), (req, res) => {
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
    res.status(202).json({
      execution: { id: execution.id, workflowId: execution.workflow_id, status: outcome === 'cancelled' ? 'cancelled' : 'running' },
      cancelling: outcome === 'cancelling',
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
