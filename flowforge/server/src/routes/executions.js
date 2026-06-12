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
    db.prepare(
      'INSERT INTO executions (id, workflow_id, status, triggered_by, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(executionId, workflow.id, 'pending', req.user.id, now)

    await getExecutionQueue().add({ executionId, workflowId: workflow.id })

    const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId)
    res.status(202).json({ execution })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/workflows/:id/executions — past runs, newest first
router.get('/workflows/:id/executions', auth, (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })

    const executions = db.prepare(
      'SELECT * FROM executions WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 50'
    ).all(workflow.id)
    res.json({ executions })
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

module.exports = router
