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

const crypto = require('crypto')
const express = require('express')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const tokenAuth = require('../middleware/tokenAuth')
const { publicApiLimiter } = require('../middleware/rateLimit')
const { getExecutionQueue } = require('../config/queue')
const { requestCancel } = require('../services/executionControl')
const { respondToApproval } = require('../services/approvals')
const { admitRun } = require('../services/concurrencyGate')
const { computeInsights, parseLimit } = require('./insights')

const router = express.Router()

// How long an Idempotency-Key guards its run. Long enough to outlive any
// sane retry policy; short enough that keys can be reused across days.
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

router.use(publicApiLimiter)

// Machine-readable description of this API. Unauthenticated on purpose — the
// spec documents shapes, not data — so tooling can fetch it without a token.
router.get('/openapi.json', (req, res) => {
  res.json(require('../docs/openapi'))
})

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
//
// Send an Idempotency-Key header to make retries safe: the same key (per
// token owner, per workflow) returns the original run instead of starting a
// duplicate, for 24 hours. The key is pinned to its payload — reusing it with
// a different body is a 409, never a silent replay of the wrong input.
router.post('/workflows/:id/trigger', tokenAuth('trigger'), async (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })

    const { nodes } = JSON.parse(workflow.graph_json)
    if (!nodes || nodes.length === 0) {
      return res.status(400).json({ error: 'Workflow has no nodes to execute' })
    }

    const payload = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}

    const idempotencyKey = req.headers['idempotency-key']
    let requestHash = null
    if (idempotencyKey !== undefined) {
      if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 255) {
        return res.status(400).json({ error: 'Idempotency-Key must be a non-empty string of at most 255 characters' })
      }
      requestHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')

      // Lazy sweep, then replay lookup. Everything from here to the INSERT is
      // synchronous (better-sqlite3), so two concurrent requests can't
      // interleave between the read and the write.
      const cutoff = new Date(Date.now() - IDEMPOTENCY_TTL_MS).toISOString()
      db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(cutoff)
      const existing = db.prepare(
        'SELECT * FROM idempotency_keys WHERE user_id = ? AND workflow_id = ? AND key = ?'
      ).get(req.user.id, workflow.id, idempotencyKey)
      if (existing) {
        if (existing.request_hash !== requestHash) {
          return res.status(409).json({
            error: 'Idempotency-Key was already used with a different request body',
          })
        }
        const original = db.prepare('SELECT status FROM executions WHERE id = ?').get(existing.execution_id)
        res.set('Idempotent-Replay', 'true')
        return res.status(202).json({
          execution: {
            id: existing.execution_id,
            workflowId: workflow.id,
            status: original?.status ?? 'pending',
          },
          statusUrl: `/api/v1/executions/${existing.execution_id}`,
          replayed: true,
        })
      }
    }

    // 'reject' concurrency policy: refuse at the cap so the caller learns now.
    // Checked after the idempotency replay above on purpose — a retried request
    // whose original landed must still get its original run back.
    const admission = admitRun(workflow)
    if (!admission.ok) return res.status(409).json({ error: admission.error })

    const executionId = uuidv4()
    const now = new Date().toISOString()
    // trigger_type 'api' marks the source; trigger_data persists the payload so
    // the run is replayable like a webhook-triggered one.
    db.prepare(
      `INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, trigger_data, created_at)
       VALUES (?, ?, 'pending', ?, 'api', ?, ?)`
    ).run(executionId, workflow.id, req.user.id, Object.keys(payload).length ? JSON.stringify(payload) : null, now)

    if (requestHash) {
      db.prepare(
        `INSERT INTO idempotency_keys (key, user_id, workflow_id, request_hash, execution_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(idempotencyKey, req.user.id, workflow.id, requestHash, executionId, now)
    }

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

// GET /api/v1/workflows/:id/executions — a workflow's recent runs, newest
// first, as summaries (no step payloads — poll GET /executions/:id for those).
// ?limit caps the page (default 20, max 100).
router.get('/workflows/:id/executions', tokenAuth('read'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })

    const requested = parseInt(req.query.limit, 10)
    const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 100) : 20

    const rows = db.prepare(
      `SELECT id, status, trigger_type, started_at, finished_at, created_at
         FROM executions
        WHERE workflow_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`
    ).all(workflow.id, limit)

    res.json({
      executions: rows.map((r) => ({
        id: r.id,
        workflowId: workflow.id,
        status: r.status,
        triggerType: r.trigger_type,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        createdAt: r.created_at,
      })),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/v1/workflows/:id/insights — the same reliability rollup the app's
// insights panel shows (duration percentiles, success rate, throughput, slowest
// steps, anomaly flags), so a dashboard or a chat-ops bot can surface it too.
// Read-only; requires the `read` scope. ?limit caps the run window (default 50,
// max 500).
router.get('/workflows/:id/insights', tokenAuth('read'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    const limit = parseLimit(req.query.limit)
    res.json({ workflowId: workflow.id, ...computeInsights(workflow.id, limit) })
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

// Public shape for an approval row (camelCase like the rest of /api/v1).
function presentApproval(row) {
  return {
    id: row.id,
    executionId: row.execution_id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name ?? null,
    nodeId: row.node_id,
    status: row.status,
    message: row.message,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    respondedAt: row.responded_at,
    respondedBy: row.responded_by_name ?? null,
    note: row.note,
  }
}

// GET /api/v1/approvals?status=pending — the token owner's approval inbox
// across every workspace they belong to. This is what lets a chat-ops bot or
// the CLI show "what's waiting on a human right now".
router.get('/approvals', tokenAuth('read'), (req, res) => {
  try {
    const status = req.query.status || 'pending'
    const valid = ['pending', 'approved', 'rejected', 'timed-out', 'cancelled']
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` })
    }
    const rows = db.prepare(
      `SELECT a.*, w.name AS workflow_name, u.display_name AS responded_by_name
         FROM execution_approvals a
         JOIN workspace_members wm ON wm.workspace_id = a.workspace_id AND wm.user_id = ?
         LEFT JOIN workflows w ON w.id = a.workflow_id
         LEFT JOIN users u ON u.id = a.responded_by
        WHERE a.status = ?
        ORDER BY a.requested_at DESC
        LIMIT 100`
    ).all(req.user.id, status)
    res.json({ approvals: rows.map(presentApproval) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/v1/approvals/:id/respond { decision, note? } — settle a waiting
// gate. Requires the dedicated `approve` scope: a token that can trigger runs
// should not implicitly be able to wave them through their approval gates.
// Semantics shared with the session route via services/approvals.js.
router.post('/approvals/:id/respond', tokenAuth('approve'), (req, res) => {
  try {
    const { decision, note } = req.body || {}
    if (decision !== 'approve' && decision !== 'reject') {
      return res.status(400).json({ error: 'decision must be "approve" or "reject"' })
    }
    const result = respondToApproval(req.params.id, req.user.id, { decision, note })
    if (result.outcome === 'not-found') {
      return res.status(404).json({ error: 'Approval not found' })
    }
    if (result.outcome === 'conflict') {
      return res.status(409).json({ error: `Approval already ${result.status}` })
    }
    const row = db.prepare(
      `SELECT a.*, w.name AS workflow_name, u.display_name AS responded_by_name
         FROM execution_approvals a
         LEFT JOIN workflows w ON w.id = a.workflow_id
         LEFT JOIN users u ON u.id = a.responded_by
        WHERE a.id = ?`
    ).get(req.params.id)
    res.json({ approval: presentApproval(row) })
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

// POST /api/v1/executions/:id/resume — continue a failed or cancelled run from
// where it stopped. Requires the trigger scope (it starts a run, like trigger
// does). The engine reuses the source run's succeeded step outputs and
// re-executes only the remainder; poll statusUrl for the outcome. 409 unless
// the source run is failed or cancelled.
router.post('/executions/:id/resume', tokenAuth('trigger'), async (req, res) => {
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

    let payload = {}
    if (original.trigger_data) {
      try {
        const parsed = JSON.parse(original.trigger_data)
        if (parsed && typeof parsed === 'object') payload = parsed
      } catch {
        /* malformed trigger_data — resume with empty payload */
      }
    }
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

    res.status(202).json({
      execution: { id: executionId, workflowId: workflow.id, status: 'pending' },
      statusUrl: `/api/v1/executions/${executionId}`,
      resumedFrom: original.id,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
