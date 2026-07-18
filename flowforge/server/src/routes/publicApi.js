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
const { isValidPriority, resolvePriority, enqueueOpts } = require('../services/runPriority')
const { computeInsights, forecastFor, parseLimit } = require('./insights')
const { scheduleExpressionOf, previewFor, parseCount } = require('./schedule')
const { runSuite } = require('../services/workflowTester')
const { compareRuns } = require('../services/runComparison')
const { searchWorkflows } = require('../services/workflowSearch')
const { diffGraphs, presentDiff } = require('../services/graphDiff')
const { lintGraph } = require('../services/workflowLinter')
const { forbidViewer } = require('../services/workspaceRoles')

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

// GET /api/v1/search?q=… — full-text search over the workflows the token's
// owner can see: names, descriptions, and what's inside the graphs (node
// labels, config strings, sticky notes). Same engine as the app's command
// palette (services/workflowSearch.js); `read` scope.
router.get('/search', tokenAuth('read'), (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (!q) return res.status(400).json({ error: 'q is required' })
    if (q.length > 200) return res.status(400).json({ error: 'q must be at most 200 characters' })

    const workspaceIds = db.prepare(
      'SELECT workspace_id FROM workspace_members WHERE user_id = ?'
    ).all(req.user.id).map((r) => r.workspace_id)

    const results = searchWorkflows(workspaceIds, q, { limit: req.query.limit })
    res.json({ results })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/v1/workspaces — the workspaces the token's owner belongs to, so an
// import script can name its target without a session. `read` scope.
router.get('/workspaces', tokenAuth('read'), (req, res) => {
  try {
    const workspaces = db.prepare(
      `SELECT w.id, w.name
         FROM workspaces w
         JOIN workspace_members wm ON wm.workspace_id = w.id
        WHERE wm.user_id = ?
        ORDER BY w.created_at`
    ).all(req.user.id)
    res.json({ workspaces })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Mirrors the session import's cap: one graph stays a sane size regardless of
// the global body limit.
const MAX_IMPORT_GRAPH_BYTES = 500 * 1024

// POST /api/v1/workspaces/:id/workflows/import — create a draft workflow from
// a portable export document ({ name, graph_data }): the write half of the
// workflows-as-code loop, so CI can promote a definition that lives in git
// into another environment. Requires the dedicated `manage` scope — a token
// that promotes definitions can't also fire runs, and vice versa. The new
// workflow lands as a draft: deploying (schedules, sub-workflow targets) stays
// a deliberate act in the app.
router.post('/workspaces/:id/workflows/import', tokenAuth('manage'), (req, res) => {
  try {
    const member = db.prepare(
      'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
    ).get(req.params.id, req.user.id)
    if (!member) return res.status(404).json({ error: 'Workspace not found' })
    // A token acts as its owner, so an owner who is only a viewer here stays
    // read-only through the API too — scopes bound what a token may try,
    // roles bound what its owner may do.
    if (forbidViewer(res, req.params.id, req.user.id)) return

    const { name, graph_data: graphData } = req.body || {}
    if (typeof name !== 'string' || name.trim() === '' || name.length > 200) {
      return res.status(400).json({ error: 'name is required (max 200 chars)' })
    }
    if (!graphData || !Array.isArray(graphData.nodes) || !Array.isArray(graphData.edges)) {
      return res.status(400).json({ error: 'graph_data must include nodes and edges arrays' })
    }
    // Persist only the { nodes, edges } the canvas understands — an import
    // can't smuggle extra top-level keys — then size-check the result.
    const graphJson = JSON.stringify({ nodes: graphData.nodes, edges: graphData.edges })
    if (Buffer.byteLength(graphJson, 'utf8') > MAX_IMPORT_GRAPH_BYTES) {
      return res.status(413).json({ error: 'Workflow graph is too large (max 500KB)' })
    }

    const id = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workflows (id, workspace_id, name, description, graph_json, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)"
    ).run(id, req.params.id, name.trim(), null, graphJson, req.user.id, now, now)

    const workflow = db.prepare(
      'SELECT id, name, description, status, workspace_id, updated_at FROM workflows WHERE id = ?'
    ).get(id)
    res.status(201).json({ workflow })
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
//
// ?priority=high|normal|low overrides the workflow's default lane for this
// run. A query param, not a body field, because the entire body is the
// trigger payload — mixing control knobs into it would make them data.
router.post('/workflows/:id/trigger', tokenAuth('trigger'), async (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return

    const { nodes } = JSON.parse(workflow.graph_json)
    if (!nodes || nodes.length === 0) {
      return res.status(400).json({ error: 'Workflow has no nodes to execute' })
    }

    const requestedPriority = req.query.priority
    if (requestedPriority !== undefined && !isValidPriority(requestedPriority)) {
      return res.status(400).json({ error: 'priority must be "high", "normal", or "low"' })
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

    const priority = resolvePriority(requestedPriority, workflow)
    const executionId = uuidv4()
    const now = new Date().toISOString()
    // trigger_type 'api' marks the source; trigger_data persists the payload so
    // the run is replayable like a webhook-triggered one.
    db.prepare(
      `INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, trigger_data, priority, created_at)
       VALUES (?, ?, 'pending', ?, 'api', ?, ?, ?)`
    ).run(executionId, workflow.id, req.user.id, Object.keys(payload).length ? JSON.stringify(payload) : null, priority, now)

    if (requestHash) {
      db.prepare(
        `INSERT INTO idempotency_keys (key, user_id, workflow_id, request_hash, execution_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(idempotencyKey, req.user.id, workflow.id, requestHash, executionId, now)
    }

    await getExecutionQueue().add(
      { executionId, workflowId: workflow.id, payload },
      enqueueOpts(priority)
    )

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
      `SELECT id, status, trigger_type, priority, started_at, finished_at, created_at
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
        priority: r.priority,
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

// GET /api/v1/workflows/:id/forecast — a predictive estimate of the workflow's
// next-run duration (typical + p95) and its likely bottleneck, computed as the
// critical path over each node's historical step timing. Read-only; `read` scope.
router.get('/workflows/:id/forecast', tokenAuth('read'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    res.json({ workflowId: workflow.id, ...forecastFor(workflow.id) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/v1/workflows/:id/schedule — the next fire times of the workflow's
// schedule trigger (UTC ISO-8601), so an external dashboard or bot can show
// "next run in 4h" without reimplementing cron. Read-only; `read` scope.
// ?count caps the number of upcoming runs (default 5, max 25).
router.get('/workflows/:id/schedule', tokenAuth('read'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })

    const expression = scheduleExpressionOf(workflow)
    if (!expression) {
      return res.json({ workflowId: workflow.id, scheduled: false, nextRuns: [] })
    }
    res.json({
      workflowId: workflow.id,
      scheduled: true,
      active: workflow.status === 'deployed',
      ...previewFor(expression, parseCount(req.query.count)),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/v1/workflows/:id/export — the workflow as the same portable,
// self-contained document the session export produces (no internal ids or
// ownership): pipe it to a file and check it into git, so workflow definitions
// get code review and history like everything else that matters. `read` scope.
router.get('/workflows/:id/export', tokenAuth('read'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })

    let graphData = { nodes: [], edges: [] }
    try {
      const parsed = JSON.parse(workflow.graph_json)
      graphData = {
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
        edges: Array.isArray(parsed.edges) ? parsed.edges : [],
      }
    } catch {
      /* unparseable graph — export the empty shape rather than fail */
    }
    res.json({
      exportVersion: '1.0',
      name: workflow.name,
      description: workflow.description,
      graph_data: graphData,
      exportedAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/v1/workflows/:id/diff — drift detection: diff the live workflow
// against a portable export document (the same { graph_data } shape export
// produces and import accepts). The response reads from the document's
// perspective — addedNodes exist live but not in the document — so
// "identical: false" means the deployed workflow is no longer what git says
// it is. Read-only (`read` scope): it changes nothing, it just answers
// whether a promotion is pending or someone edited production by hand.
router.post('/workflows/:id/diff', tokenAuth('read'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })

    const graphData = req.body?.graph_data
    if (!graphData || !Array.isArray(graphData.nodes) || !Array.isArray(graphData.edges)) {
      return res.status(400).json({ error: 'graph_data must include nodes and edges arrays' })
    }
    // Same cap as import: a diff request carries a whole graph too.
    if (Buffer.byteLength(JSON.stringify(graphData), 'utf8') > MAX_IMPORT_GRAPH_BYTES) {
      return res.status(413).json({ error: 'Workflow graph is too large (max 500KB)' })
    }

    let live = { nodes: [], edges: [] }
    try {
      const parsed = JSON.parse(workflow.graph_json)
      live = {
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
        edges: Array.isArray(parsed.edges) ? parsed.edges : [],
      }
    } catch {
      /* unparseable stored graph — diff against the empty shape */
    }

    const document = { nodes: graphData.nodes, edges: graphData.edges }
    const diff = diffGraphs(document, live)
    res.json({ workflowId: workflow.id, ...presentDiff(diff, document, live) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/v1/workflows/:id/lint — static analysis as a CI gate. With an
// empty body, lints the workflow as stored; with { graph_data }, lints that
// document instead — so a pipeline can vet an exported file against the
// *target* workspace's real context (secret names, variable names,
// sub-workflow targets) before importing it there. Same rules and severity
// contract as the canvas's 🔎 Issues panel, because it *is* the same linter.
// `ok` (no errors) is the gate; warnings ride along for --strict consumers.
// Read scope: analysis changes nothing.
router.post('/workflows/:id/lint', tokenAuth('read'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })

    let graph
    const graphData = req.body?.graph_data
    if (graphData !== undefined) {
      if (!graphData || !Array.isArray(graphData.nodes) || !Array.isArray(graphData.edges)) {
        return res.status(400).json({ error: 'graph_data must include nodes and edges arrays' })
      }
      if (graphData.nodes.length > 2000 || graphData.edges.length > 5000) {
        return res.status(400).json({ error: 'Graph too large to lint' })
      }
      graph = { nodes: graphData.nodes, edges: graphData.edges }
    } else {
      graph = { nodes: [], edges: [] }
      try {
        const parsed = JSON.parse(workflow.graph_json)
        graph = {
          nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
          edges: Array.isArray(parsed.edges) ? parsed.edges : [],
        }
      } catch {
        /* unparseable stored graph — lint the empty shape */
      }
    }

    // The same live workspace context the session lint route builds, so
    // {{secrets.*}} / {{vars.*}} references and call targets check for real.
    const secretNames = new Set(
      db.prepare('SELECT name FROM workspace_secrets WHERE workspace_id = ?')
        .all(workflow.workspace_id)
        .map((r) => r.name)
    )
    const variableNames = new Set(
      db.prepare('SELECT name FROM workspace_variables WHERE workspace_id = ?')
        .all(workflow.workspace_id)
        .map((r) => r.name)
    )
    const workflowTargets = new Map(
      db.prepare('SELECT id, name, status FROM workflows WHERE workspace_id = ?')
        .all(workflow.workspace_id)
        .map((r) => [r.id, { name: r.name, status: r.status }])
    )

    const issues = lintGraph(graph, { secretNames, variableNames, workflowTargets })
    const errors = issues.filter((i) => i.severity === 'error').length
    const warnings = issues.filter((i) => i.severity === 'warning').length
    res.json({
      workflowId: workflow.id,
      ok: errors === 0,
      issues,
      summary: { errors, warnings },
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/v1/workflows/:id/tests/run — run the workflow's test scenarios and
// return a pass/fail rollup. This is the CI gate: `ok: false` (or a non-2xx)
// fails the pipeline. Requires the `trigger` scope because it executes the
// workflow (in dry-run: side-effecting nodes don't fire, approvals auto-approve),
// like starting a run does.
router.post('/workflows/:id/tests/run', tokenAuth('trigger'), async (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    const summary = await runSuite(workflow, { triggeredBy: req.user.id })
    res.json(summary)
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

// GET /api/v1/executions/:id/compare/:otherId — diff two runs of the same
// workflow node by node. Mirrors the session route: status changes, duration
// deltas, output differences over the persisted (secret-redacted) rows.
router.get('/executions/:id/compare/:otherId', tokenAuth('read'), (req, res) => {
  try {
    const readExecution = db.prepare('SELECT * FROM executions WHERE id = ?')
    const base = readExecution.get(req.params.id)
    const other = readExecution.get(req.params.otherId)
    if (!base || !other) return res.status(404).json({ error: 'Execution not found' })
    if (!getWorkflowForMember(base.workflow_id, req.user.id)) {
      return res.status(404).json({ error: 'Execution not found' })
    }
    if (base.workflow_id !== other.workflow_id) {
      return res.status(400).json({ error: 'Executions belong to different workflows' })
    }

    const readSteps = db.prepare(
      'SELECT * FROM execution_steps WHERE execution_id = ? ORDER BY rowid'
    )
    const { nodes, summary } = compareRuns(readSteps.all(base.id), readSteps.all(other.id))
    const runOf = (e) => ({
      id: e.id,
      status: e.status,
      triggerType: e.trigger_type,
      startedAt: e.started_at,
      finishedAt: e.finished_at,
      durationMs:
        e.started_at && e.finished_at ? new Date(e.finished_at) - new Date(e.started_at) : null,
    })
    res.json({ base: runOf(base), other: runOf(other), nodes, summary })
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
    if (result.outcome === 'forbidden') {
      return res.status(403).json({ error: 'Viewers have read-only access' })
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
    const cancelWorkflow = getWorkflowForMember(execution.workflow_id, req.user.id)
    if (!cancelWorkflow) {
      return res.status(404).json({ error: 'Execution not found' })
    }
    if (forbidViewer(res, cancelWorkflow.workspace_id, req.user.id)) return

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
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return

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

    // A resume continues the original run, so it keeps the original's lane.
    const priority = isDryRun ? 'high' : resolvePriority(original.priority, workflow)
    const executionId = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO executions
         (id, workflow_id, status, triggered_by, trigger_type, trigger_data, resumed_from_execution_id, priority, created_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
    ).run(
      executionId, workflow.id, req.user.id, isDryRun ? 'dry-run' : 'resume',
      original.trigger_data ?? null, original.id, priority, now
    )

    await getExecutionQueue().add({
      executionId,
      workflowId: workflow.id,
      payload,
      ...(isDryRun ? { dryRun: true } : {}),
    }, enqueueOpts(priority))

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
