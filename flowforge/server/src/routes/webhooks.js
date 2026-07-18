const express = require('express')
const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { validate } = require('../middleware/validate')
const { webhookLimiter } = require('../middleware/rateLimit')
const { getExecutionQueue } = require('../config/queue')
const { generateSigningSecret, verifyWebhookSignature } = require('../services/webhookSignature')
const { admitRun } = require('../services/concurrencyGate')
const { resolvePriority, enqueueOpts } = require('../services/runPriority')
const { analyze, evaluateBoolean, ExpressionError } = require('../services/expression')
const { forbidViewer } = require('../services/workspaceRoles')

const router = express.Router()

// Validate an incoming filterExpression value. Returns { value } (null =
// no filter) or { error } — the same static checks the linter applies to any
// FXL field: it must parse, and every function it calls must exist.
function normalizeFilter(raw) {
  if (raw == null || String(raw).trim() === '') return { value: null }
  const source = String(raw)
  if (source.length > 1000) return { error: 'filterExpression must be at most 1000 characters' }
  const result = analyze(source)
  if (!result.ok) return { error: `filterExpression has a syntax error — ${result.error}` }
  if (result.unknownFunctions.length > 0) {
    return { error: `filterExpression calls unknown function "${result.unknownFunctions[0]}()"` }
  }
  return { value: source.trim() }
}

function getWorkflowForMember(workflowId, userId) {
  const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId)
  if (!workflow) return null
  const member = db.prepare(
    'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(workflow.workspace_id, userId)
  return member ? workflow : null
}

// Shape a row for API responses: the signing secret itself never leaves the
// server after creation — callers only learn *whether* a webhook is signed.
function presentWebhook(row) {
  const { signing_secret: signingSecret, ...rest } = row
  return { ...rest, signed: Boolean(signingSecret) }
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
    res.json({ webhooks: webhooks.map(presentWebhook) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/webhooks — create a webhook trigger. Pass
// { signed: true } to also mint a per-webhook HMAC signing secret; the secret
// appears exactly once, in this response — deliveries must then be signed
// (see the public trigger below). An optional filterExpression (FXL over the
// delivery body) makes the webhook fire selectively.
router.post('/workflows/:id/webhooks', auth, validate({ name: { type: 'string', maxLength: 200 } }), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return

    const filter = normalizeFilter(req.body?.filterExpression)
    if (filter.error) return res.status(400).json({ error: filter.error })

    const id = uuidv4()
    const key = crypto.randomBytes(24).toString('base64url')
    const signingSecret = req.body?.signed === true ? generateSigningSecret() : null
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO webhooks (id, workflow_id, webhook_key, name, signing_secret, filter_expression, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, workflow.id, key, req.body?.name || null, signingSecret, filter.value, req.user.id, now)

    const webhook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id)
    res.status(201).json({
      webhook: presentWebhook(webhook),
      // The only time the secret is ever returned.
      ...(signingSecret ? { signingSecret } : {}),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/webhooks/:webhookId — edit the name or the gate expression.
// A dedicated update route on purpose: changing the filter must not force a
// key rotation, because the URL is what external senders hold.
router.put('/webhooks/:webhookId', auth, validate({ name: { type: 'string', maxLength: 200 } }), (req, res) => {
  try {
    const webhook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.webhookId)
    const editWorkflow = webhook && getWorkflowForMember(webhook.workflow_id, req.user.id)
    if (!editWorkflow) {
      return res.status(404).json({ error: 'Webhook not found' })
    }
    if (forbidViewer(res, editWorkflow.workspace_id, req.user.id)) return

    const name = 'name' in (req.body || {}) ? (req.body.name || null) : webhook.name
    let filterValue = webhook.filter_expression
    if ('filterExpression' in (req.body || {})) {
      const filter = normalizeFilter(req.body.filterExpression)
      if (filter.error) return res.status(400).json({ error: filter.error })
      filterValue = filter.value
    }

    db.prepare('UPDATE webhooks SET name = ?, filter_expression = ? WHERE id = ?')
      .run(name, filterValue, req.params.webhookId)
    const updated = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.webhookId)
    res.json({ webhook: presentWebhook(updated) })
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
    const deleteWorkflow = getWorkflowForMember(webhook.workflow_id, req.user.id)
    if (!deleteWorkflow) {
      return res.status(404).json({ error: 'Webhook not found' })
    }
    if (forbidViewer(res, deleteWorkflow.workspace_id, req.user.id)) return
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
// Signed webhooks additionally require a timestamped HMAC over the raw body
// (X-FlowForge-Timestamp + X-FlowForge-Signature) — see webhookSignature.js.
router.post('/webhooks/:key', webhookLimiter, async (req, res) => {
  try {
    const webhook = db.prepare('SELECT * FROM webhooks WHERE webhook_key = ?').get(req.params.key)
    if (!webhook) return res.status(404).json({ error: 'Webhook not found' })

    if (webhook.signing_secret) {
      const result = verifyWebhookSignature({
        secret: webhook.signing_secret,
        timestampHeader: req.get('x-flowforge-timestamp'),
        signatureHeader: req.get('x-flowforge-signature'),
        rawBody: req.rawBody,
      })
      if (!result.ok) return res.status(401).json({ error: result.error })
    }

    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(webhook.workflow_id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })

    const { nodes } = JSON.parse(workflow.graph_json)
    if (!nodes || nodes.length === 0) {
      return res.status(400).json({ error: 'Workflow has no nodes to execute' })
    }

    // The request body is both the live run's trigger payload and the durable
    // record persisted on the execution row, so the run can later be replayed
    // with identical input.
    const triggerData = req.body && typeof req.body === 'object' ? req.body : {}

    // Gate expression: an FXL predicate over the delivery body decides
    // whether this delivery fires at all. Checked after signature
    // verification (an unsigned forgery must not learn anything, even "you
    // were filtered") and before concurrency admission (a filtered delivery
    // consumes nothing). Non-matching deliveries are *acknowledged* — 202
    // with accepted: false — because from the sender's side the delivery
    // succeeded; a 4xx would make well-behaved senders retry forever. A
    // filter that errors at runtime (e.g. type mismatch against this body)
    // also doesn't fire: deterministic, and the reason says why.
    if (webhook.filter_expression) {
      let matched = false
      let reason = 'filtered'
      try {
        matched = evaluateBoolean(webhook.filter_expression, {
          ...triggerData,
          payload: triggerData,
        })
      } catch (err) {
        if (!(err instanceof ExpressionError)) throw err
        reason = `filter error: ${err.message}`
      }
      if (!matched) {
        return res.status(202).json({ accepted: false, reason })
      }
    }

    // 'reject' concurrency policy: a 409 tells the sender to back off and
    // retry, rather than silently piling runs onto a saturated workflow.
    const admission = admitRun(workflow)
    if (!admission.ok) return res.status(409).json({ error: admission.error })
    // Webhook senders don't pick lanes — the workflow's default decides.
    const priority = resolvePriority(null, workflow)
    const executionId = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, trigger_data, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(executionId, workflow.id, 'pending', null, 'webhook', JSON.stringify(triggerData), priority, now)
    db.prepare('UPDATE webhooks SET last_triggered_at = ? WHERE id = ?').run(now, webhook.id)

    await getExecutionQueue().add({
      executionId,
      workflowId: workflow.id,
      payload: triggerData,
    }, enqueueOpts(priority))

    res.status(202).json({ executionId, status: 'pending' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
