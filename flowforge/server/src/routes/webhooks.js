const express = require('express')
const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { validate } = require('../middleware/validate')
const { webhookLimiter } = require('../middleware/rateLimit')
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

// --- Webhook management (authenticated) ---

// GET /api/workflows/:id/webhooks — list a workflow's webhooks
router.get('/workflows/:id/webhooks', auth, (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    const webhooks = db.prepare(
      'SELECT * FROM webhooks WHERE workflow_id = ? ORDER BY created_at DESC'
    ).all(workflow.id)
    res.json({ webhooks })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/webhooks — create a webhook trigger
router.post('/workflows/:id/webhooks', auth, validate({ name: { type: 'string', maxLength: 200 } }), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })

    const id = uuidv4()
    const key = crypto.randomBytes(24).toString('base64url')
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO webhooks (id, workflow_id, webhook_key, name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, workflow.id, key, req.body?.name || null, req.user.id, now)

    const webhook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id)
    res.status(201).json({ webhook })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/webhooks/:webhookId — remove a webhook
router.delete('/webhooks/:webhookId', auth, (req, res) => {
  try {
    const webhook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.webhookId)
    if (!webhook) return res.status(404).json({ error: 'Webhook not found' })
    if (!getWorkflowForMember(webhook.workflow_id, req.user.id)) {
      return res.status(404).json({ error: 'Webhook not found' })
    }
    db.prepare('DELETE FROM webhooks WHERE id = ?').run(req.params.webhookId)
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// --- Public trigger (no auth) ---

// POST /api/webhooks/:key — anyone with the key can fire the workflow.
// The request body becomes the trigger node's output for this run.
router.post('/webhooks/:key', webhookLimiter, async (req, res) => {
  try {
    const webhook = db.prepare('SELECT * FROM webhooks WHERE webhook_key = ?').get(req.params.key)
    if (!webhook) return res.status(404).json({ error: 'Webhook not found' })

    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(webhook.workflow_id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })

    const { nodes } = JSON.parse(workflow.graph_json)
    if (!nodes || nodes.length === 0) {
      return res.status(400).json({ error: 'Workflow has no nodes to execute' })
    }

    const executionId = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO executions (id, workflow_id, status, triggered_by, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(executionId, workflow.id, 'pending', null, now)
    db.prepare('UPDATE webhooks SET last_triggered_at = ? WHERE id = ?').run(now, webhook.id)

    await getExecutionQueue().add({
      executionId,
      workflowId: workflow.id,
      payload: req.body && typeof req.body === 'object' ? req.body : {},
    })

    res.status(202).json({ executionId, status: 'pending' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
