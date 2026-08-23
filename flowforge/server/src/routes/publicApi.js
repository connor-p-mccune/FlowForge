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
const { rollbackExecution } = require('../services/executionEngine')
const { describeLineage, analyzeLineage, traceProvenance, traceImpact } = require('../services/lineage')
const { verifyGuarantees, parseGuarantees } = require('../services/guarantees')
const { parseWorkflow, formatWorkflow, DslError } = require('../services/workflowDsl')
const { analyzeEffects } = require('../services/effects')

// Every endpoint that takes a workflow *document* accepts it in either form: as
// the JSON export, or as `.flow` text under `flow`. Resolving it in one place
// means the format is a first-class input to the whole toolchain rather than to
// import alone — a `.flow` file that could be promoted but not diffed, linted or
// merged would be a format nobody could adopt.
//
// The text is parsed into exactly the shape the JSON path produces, so
// everything downstream — the size caps, the signature check, the guarantees —
// stays one code path rather than two that have to be kept in agreement. A
// signature over a `.flow` file verifies for free, because the format's emit
// order *is* the signing canonical order.
//
// Returns the resolved body, or null after sending a 400 with the position the
// parser found — the whole reason the format is text.
function resolveDocument(req, res) {
  const body = req.body || {}
  if (typeof body.flow !== 'string') return body
  try {
    return { ...body, ...parseWorkflow(body.flow) }
  } catch (err) {
    if (err instanceof DslError) {
      res.status(400).json({
        error: `Line ${err.line}: ${err.message}`,
        line: err.line,
        column: err.column,
      })
      return null
    }
    throw err
  }
}
const { analyzePaths } = require('../services/pathConstraints')
const { analyzeRegressions } = require('../services/regressions')
const { previewDeploy } = require('../services/backtest')
const { verifyImport } = require('../services/trustStore')

// The provenance verdict as a caller sees it — the same shape the session import
// returns, so a promotion script reads one field whichever door it came through.
const presentProvenance = (verdict) => ({
  status: verdict.status,
  signedBy: verdict.key,
  required: verdict.required,
  digest: verdict.digest,
})
const { parseDebugRequest, resumeBreak, listBreaks } = require('../services/debugger')
const { mergeDocument, applyMerge } = require('../services/workflowMerge')
const { recordAudit } = require('../services/auditLog')
const { respondToApproval } = require('../services/approvals')
const { admitRun } = require('../services/concurrencyGate')
const { isValidPriority, resolvePriority, enqueueOpts } = require('../services/runPriority')
const { computeInsights, forecastFor, parseLimit } = require('./insights')
const { scheduleAnalysisFor } = require('./executions')
const { analyzeWorkflowDrift } = require('../services/driftMonitor')
const { scheduleConfigOf, previewFor, parseCount } = require('./schedule')
const { runSuite } = require('../services/workflowTester')
const { compareRuns } = require('../services/runComparison')
const { searchWorkflows } = require('../services/workflowSearch')
const { diffGraphs, presentDiff } = require('../services/graphDiff')
const { lintGraph } = require('../services/workflowLinter')
const { describeGraphTypes } = require('../services/typeInference')
const { graphResolver, approverCounts } = require('../services/graphLookup')
const { checkWorkflow, policyIssues } = require('../services/policyGate')
const canary = require('../services/canary')
const { snapshotVersion } = require('../services/canaryMonitor')
const { forbidViewer, memberRole } = require('../services/workspaceRoles')
const { isPaused, PAUSED_ERROR, pauseWorkflow, resumeWorkflow } = require('../services/workflowPause')
const { computeDependencies } = require('../services/workflowDependencies')
const { listAudit, verifyChain } = require('../services/auditLog')
const { planBackfill, listBackfills } = require('../services/backfill')
const { runBackfill } = require('./backfill')

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
      `SELECT wf.id, wf.name, wf.description, wf.status, wf.workspace_id, wf.updated_at, wf.paused_at
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

// GET /api/v1/workspaces/:id/audit — the tamper-evident governance trail, and
// GET .../audit/verify — its chain verification. `read` scope, and owner-only
// on top of it, mirroring the session route: a token acts as its owner, so a
// non-owner's token is refused here exactly as their session would be.
//
// The verify endpoint exists on the public API specifically so a *monitoring
// job* can hold the log to account on a schedule. An integrity check nobody
// runs is not a control, and the natural place to run one is the same CI box
// that already talks to this API — `flowforge audit --verify` exits non-zero on
// a broken chain, which is all a cron needs to page someone.
function auditWorkspaceOr404(req, res) {
  const role = memberRole(req.params.id, req.user.id)
  if (role === null) {
    res.status(404).json({ error: 'Workspace not found' })
    return false
  }
  if (role !== 'owner') {
    // 403 rather than 404: the token's owner can see this workspace, so
    // pretending it doesn't exist would be a confusing lie. The operation is
    // what's refused.
    res.status(403).json({ error: 'Only workspace owners can read the audit log' })
    return false
  }
  return true
}

router.get('/workspaces/:id/audit', tokenAuth('read'), (req, res) => {
  try {
    if (!auditWorkspaceOr404(req, res)) return
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200))
    const rows = listAudit(req.params.id, {
      limit: limit + 1,
      before: req.query.before,
      action: req.query.action,
    })
    const hasMore = rows.length > limit
    res.json({
      entries: rows.slice(0, limit).map((row) => ({
        id: row.id,
        seq: row.seq,
        action: row.action,
        actor: row.actor_label,
        targetType: row.target_type,
        targetId: row.target_id,
        targetName: row.target_name,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
        createdAt: row.created_at,
        prevHash: row.prev_hash,
        hash: row.hash,
      })),
      hasMore,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/workspaces/:id/audit/verify', tokenAuth('read'), (req, res) => {
  try {
    if (!auditWorkspaceOr404(req, res)) return
    // A broken chain is a 200 with ok:false, like the session route: a probe
    // must distinguish "the log is compromised" from "the endpoint is down".
    res.json({ ...verifyChain(req.params.id), verifiedAt: new Date().toISOString() })
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

    const body = resolveDocument(req, res)
    if (!body) return

    const { name, graph_data: graphData } = body
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

    // Provenance (services/trustStore.js). This is the path a promotion
    // pipeline actually takes, so it is the path where "is the graph that
    // arrived the graph that was reviewed?" matters most: a `manage` token can
    // import any document at all, and between the approval and this request the
    // file passed through a repository, a runner and an artifact store.
    //
    // A broken signature is refused regardless of configuration — it means the
    // document changed after it was signed — while whether an *unsigned* import
    // is acceptable is the workspace's own policy.
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id)
    const provenance = verifyImport(workspace, body)
    if (!provenance.allowed) {
      return res.status(403).json({
        error: provenance.reason,
        provenance: presentProvenance(provenance),
      })
    }

    const guarantees = parseGuarantees(body.guarantees)

    const id = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workflows (id, workspace_id, name, description, graph_json, guarantees_json, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)"
    ).run(id, req.params.id, name.trim(), null, graphJson, guarantees.length ? JSON.stringify(guarantees) : null, req.user.id, now, now)

    recordAudit(req.params.id, req.user.id, 'workflow.imported', {
      type: 'workflow',
      id,
      name: name.trim(),
      metadata: {
        nodes: graphData.nodes.length,
        signature: provenance.status,
        signedBy: provenance.key?.fingerprint ?? null,
        digest: provenance.digest,
        via: 'api',
      },
    })

    const workflow = db.prepare(
      'SELECT id, name, description, status, workspace_id, updated_at, graph_json FROM workflows WHERE id = ?'
    ).get(id)
    // Workspace policies are *reported* here, not enforced. The import lands as
    // a draft, so nothing the organisation runs has changed yet — and refusing
    // the import would prevent bringing a definition in to fix it. Deploy is
    // where "may this be live?" is answered; this exists so a promotion
    // pipeline learns about a blocking policy at the import step rather than
    // one command later. `blocked` is the flag a CI job keys on.
    const policy = checkWorkflow(workflow)
    const { graph_json: _graph, ...summary } = workflow
    res.status(201).json({
      workflow: summary,
      policyViolations: policy.violations,
      policyBlocked: policy.blocked,
      provenance: presentProvenance(provenance),
    })
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

    // ?breakAt=<node-id,…> or ?breakAt=all starts the run as a debug session
    // (services/debugger.js): it pauses before each named node runs, exposing
    // the *resolved* config and input. A query param for the same reason
    // priority is one — the body is the trigger payload, and a control knob
    // mixed into it would become data.
    //
    // The safety property survives intact: a breakpoint is attached to *this*
    // submission and stored on the run, so a schedule tick or a webhook
    // delivery of the same workflow still has nowhere to read one from.
    let debug = null
    if (req.query.breakAt !== undefined) {
      const raw = String(req.query.breakAt)
      const graph = JSON.parse(workflow.graph_json)
      const request = raw === 'all'
        ? { stepFromStart: true }
        : { breakpoints: raw.split(',').map((s) => s.trim()).filter(Boolean) }
      debug = parseDebugRequest(request, graph)
      if (!debug) {
        return res.status(400).json({
          error: 'breakAt must be "all" or a comma-separated list of node ids in this workflow',
        })
      }
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

    // The kill switch, then the cap — both checked after the idempotency
    // replay above on purpose: a retried request whose original landed before
    // the pause must still get its original run back, never a spurious 409.
    if (isPaused(workflow)) return res.status(409).json({ error: PAUSED_ERROR })

    // 'reject' concurrency policy: refuse at the cap so the caller learns now.
    const admission = admitRun(workflow)
    if (!admission.ok) return res.status(409).json({ error: admission.error })

    // A debug run always takes the high lane: something is waiting on each
    // pause, and an interactive session stuck behind a bulk backlog defeats
    // its purpose — the same rule dry runs follow.
    const priority = debug ? 'high' : resolvePriority(requestedPriority, workflow)
    const executionId = uuidv4()
    const now = new Date().toISOString()
    // trigger_type 'api' marks the source; trigger_data persists the payload so
    // the run is replayable like a webhook-triggered one.
    db.prepare(
      `INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, trigger_data, priority, debug_json, created_at)
       VALUES (?, ?, 'pending', ?, 'api', ?, ?, ?, ?)`
    ).run(
      executionId, workflow.id, req.user.id,
      Object.keys(payload).length ? JSON.stringify(payload) : null,
      priority, debug ? JSON.stringify(debug) : null, now
    )

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

// POST /api/v1/workflows/:id/pause — the operational kill switch from a
// script or chat-ops bot: while paused, no new real run starts at any entry
// point (in-flight runs settle normally, dry runs stay allowed). Requires the
// dedicated `manage` scope — pausing changes durable workflow lifecycle state,
// the same category as importing a definition, and deliberately not `trigger`,
// so an automation token that fires runs can't also disable the workflow.
// Idempotent, like the session route. `paused` reports the resulting state.
router.post('/workflows/:id/pause', tokenAuth('manage'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    const updated = pauseWorkflow(workflow, req.user.id)
    res.json({ workflowId: updated.id, paused: true, pausedAt: updated.paused_at })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/v1/workflows/:id/resume — release the kill switch. `manage` scope,
// idempotent, mirroring pause. Nothing skipped while paused is retroactively
// fired; the next natural trigger just works again.
router.post('/workflows/:id/resume', tokenAuth('manage'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    const updated = resumeWorkflow(workflow, req.user.id)
    res.json({ workflowId: updated.id, paused: false })
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

// GET /api/v1/workflows/:id/regressions — when this workflow's duration
// changed, by how much, which step moved, and which deploy landed in the gap.
//
// The CI shape is a release gate rather than a health check: `ok` is false only
// when a change *for the worse* was detected, so a pipeline that runs this
// after promoting a version fails on a regression its own deploy caused — and
// the response names the version, so the failure message is the answer rather
// than the start of an investigation. A history too short to analyse is `ok`,
// because failing every young workflow's build would get the check removed.
router.get('/workflows/:id/regressions', tokenAuth('read'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    res.json({
      workflowId: workflow.id,
      ...analyzeRegressions(workflow.id, { limit: req.query.limit }),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/v1/workflows/:id/forecast — a predictive estimate of the workflow's
// next-run duration (typical + p95) and its likely bottleneck, computed as the
// critical path over each node's historical step timing, plus what the engine's
// parallelism cap will do to it. Read-only; `read` scope. `?cap=N` overrides the
// server's EXEC_MAX_PARALLEL, so "what would six slots buy?" is a query rather
// than a config change.
router.get('/workflows/:id/forecast', tokenAuth('read'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    const cap = parseInt(req.query.cap, 10)
    res.json({
      workflowId: workflow.id,
      ...forecastFor(workflow.id, {
        cap: Number.isFinite(cap) && cap > 0 ? Math.min(cap, 64) : undefined,
      }),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/v1/workflows/:id/drift — has what this workflow's nodes *produce*
// changed? Compares the last N runs' recorded step outputs against the N before
// them, field by field. Read-only; `read` scope.
//
// A CI job can gate on it (`flowforge drift <id> --strict`), which is the point:
// every other check a pipeline can run here is about the graph or the run, and
// this is the only one that would notice an upstream API quietly changing what
// it sends while every run still completes.
router.get('/workflows/:id/drift', tokenAuth('read'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    res.json({
      workflowId: workflow.id,
      monitoring: Boolean(workflow.drift_monitoring),
      ...analyzeWorkflowDrift(workflow.id, {
        recentRuns: req.query.recent,
        baselineRuns: req.query.baseline,
      }),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/v1/workflows/:id/dependencies — cross-workflow impact analysis:
// what this workflow calls (sub-workflow / for-each nodes, error handler),
// what calls it, and any stale cross-workflow reference cycle it sits on. So a
// deploy pipeline can refuse to undeploy a workflow that others still call, or
// map the blast radius of a change. Read-only; `read` scope.
router.get('/workflows/:id/dependencies', tokenAuth('read'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    res.json({ workflowId: workflow.id, ...computeDependencies(workflow) })
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

    const schedule = scheduleConfigOf(workflow)
    if (!schedule) {
      return res.json({ workflowId: workflow.id, scheduled: false, nextRuns: [] })
    }
    res.json({
      workflowId: workflow.id,
      scheduled: true,
      active: workflow.status === 'deployed',
      ...previewFor(schedule.cron, parseCount(req.query.count), schedule.timeZone),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/v1/workflows/:id/backfill { from, to, skipExisting?, priority?, preview? }
//
// The programmatic half of backfill, and the one that matters most: a
// backfill is usually the tail of a recovery script — "redeploy the fixed
// workflow, then replay the window it was broken for" — which belongs in the
// same automation as the deploy, not in a browser tab someone has to remember.
//
// `trigger` scope, since it starts runs. `preview: true` returns the plan
// without creating anything, so a script can gate on the count (or print it
// for a human to approve) before committing.
router.post('/workflows/:id/backfill', tokenAuth('trigger'), async (req, res) => {
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

// GET /api/v1/workflows/:id/backfills — batches and their progress, so a
// script that submitted one can poll it to completion the same way it polls a
// single run. `read` scope.
router.get('/workflows/:id/backfills', tokenAuth('read'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    res.json({ backfills: listBackfills(workflow.id, req.query.limit) })
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
    const document = {
      exportVersion: '1.0',
      name: workflow.name,
      description: workflow.description,
      graph_data: graphData,
      // The declared path invariants ride along — see the session export route.
      // Without them a git-tracked definition would lose the assertions that
      // are the reason a reviewer approved it.
      guarantees: parseGuarantees(workflow.guarantees_json),
      exportedAt: new Date().toISOString(),
    }

    // `?format=flow` serves the reviewable text form instead of the JSON
    // (services/workflowDsl). Served as text/plain rather than wrapped in a
    // JSON field, because the entire point of the format is being a file in a
    // repository — `flowforge export <id> --flow > sync.flow` should produce
    // the file, not something that needs unwrapping first.
    if (req.query.format === 'flow') {
      res.type('text/plain').send(formatWorkflow(document))
      return
    }
    res.json(document)
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

    const body = resolveDocument(req, res)
    if (!body) return
    const graphData = body.graph_data
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

// POST /api/v1/workflows/:id/preview — replay the last N real runs against a
// candidate definition and report which of them would behave differently.
//
// `diff` says the definition changed; `lint`, `verify` and `paths` say the new
// one is well-formed, still keeps its promises, and has no dead branches. None
// of them says what the change *does*, which is the question a reviewer has and
// the one a promotion pipeline can now answer before merging:
//
//   flowforge preview $WORKFLOW_ID workflows/sync.json --strict
//
// `read` scope, deliberately, even though it executes graphs: every replay is a
// dry run against a definition the workflow does not hold — both of which the
// engine refuses outside dry-run mode — and each replay's execution row is
// deleted once its steps are read. Nothing survives the call, so nothing here
// is a change to the workspace.
router.post('/workflows/:id/preview', tokenAuth('read'), async (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })

    const body = resolveDocument(req, res)
    if (!body) return
    const graphData = body.graph_data
    if (!graphData || !Array.isArray(graphData.nodes) || !Array.isArray(graphData.edges)) {
      return res.status(400).json({ error: 'graph_data must include nodes and edges arrays' })
    }
    if (Buffer.byteLength(JSON.stringify(graphData), 'utf8') > MAX_IMPORT_GRAPH_BYTES) {
      return res.status(413).json({ error: 'Workflow graph is too large (max 500KB)' })
    }
    if (graphData.nodes.length === 0) {
      return res.status(400).json({ error: 'Nothing to preview — the document has no nodes' })
    }

    const report = await previewDeploy(
      workflow,
      { nodes: graphData.nodes, edges: graphData.edges },
      { runs: body.runs }
    )
    res.json({
      workflowId: workflow.id,
      // The CI gate: no run behaves differently. False is not a failure on its
      // own — most changes are meant to change something — which is why the
      // CLI only fails the build on it under --strict.
      ok: report.changed.length === 0,
      ...report,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/v1/workflows/:id/merge — three-way merge a document into the live
// workflow.
//
// `diff` detects that git and production have diverged; this is what resolves
// it. Detection alone leaves two bad options — import the file and lose the
// live edit, or re-export and lose the reviewed change — and both throw away
// work somebody did on purpose. A two-way comparison cannot do better, because
// it cannot distinguish *added here* from *deleted there*. Only a common
// ancestor can, and `services/workflowMerge.js` is what resolves one.
//
// Preview by default; `apply: true` writes. `manage` scope, like import — this
// changes a definition, and the scope split keeps a token that promotes
// definitions distinct from one that fires runs.
router.post('/workflows/:id/merge', tokenAuth('manage'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return

    const body = resolveDocument(req, res)
    if (!body) return
    const graphData = body.graph_data
    if (graphData && Buffer.byteLength(JSON.stringify(graphData), 'utf8') > MAX_IMPORT_GRAPH_BYTES) {
      return res.status(413).json({ error: 'Workflow graph is too large (max 500KB)' })
    }

    const strategy = body.strategy ?? 'manual'
    const merged = mergeDocument(workflow, graphData, {
      strategy,
      baseVersion: body.baseVersion,
    })
    if (merged.error) return res.status(400).json({ error: merged.error })

    if (!body.apply || !merged.graph) return res.json(merged.body)

    applyMerge(workflow, merged.graph)
    recordAudit(workflow.workspace_id, req.user.id, 'workflow.merged', {
      type: 'workflow',
      id: workflow.id,
      name: workflow.name,
      metadata: {
        baseVersion: merged.body.base?.version ?? null,
        strategy,
        ...merged.body.summary,
      },
    })
    res.json({ ...merged.body, applied: true })
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

    const body = resolveDocument(req, res)
    if (!body) return
    let graph
    const graphData = body.graph_data
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

    const issues = [
      ...lintGraph(graph, {
        secretNames,
        variableNames,
        workflowTargets,
        resolveWorkflow: graphResolver(workflow.workspace_id),
        rollbackPolicy: workflow.rollback_policy,
        // A `flowforge lint <id> file.json` in CI vets a candidate definition
        // against the *target* workspace, so the invariants it is checked
        // against are the ones live there — which is what catches a promotion
        // that would route around a gate production still declares.
        guarantees: workflow.guarantees_json,
        // Declared redactions, so a rule that could never match is reported
        // while it is still an edit rather than after a run stored the value.
        redact: workflow.redact_json,
        // Counted in the *target* workspace for the same reason the guarantees
        // are: a four-approval gate that is satisfiable where it was authored
        // and not where it is being promoted is exactly what this catches.
        approvers: approverCounts(workflow.workspace_id),
      }),
      // Policy findings ride the same report, so `flowforge lint` is one gate
      // for "will it run?" and "is it allowed here?" rather than two commands.
      ...policyIssues(workflow, { graphJson: JSON.stringify(graph) }),
    ]
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

// GET /api/v1/workflows/:id/types — the inferred data schema of the stored
// graph: every node's input and output shape, plus the flattened `{{…}}`
// references each one offers.
//
// A read, not a gate: the lint endpoint above already fails CI on a type
// error, and this is what you fetch when you want to *see* the contract — to
// diff a schema across a promotion, or to generate types for the code on the
// other side of a workflow's webhook. Cheap and side-effect-free, so the
// `read` scope is the whole authorisation story.
router.get('/workflows/:id/types', tokenAuth('read'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    let graph = { nodes: [], edges: [] }
    try {
      const parsed = JSON.parse(workflow.graph_json)
      graph = {
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
        edges: Array.isArray(parsed.edges) ? parsed.edges : [],
      }
    } catch {
      /* unparseable stored graph — describe the empty shape */
    }
    res.json({
      workflowId: workflow.id,
      ...describeGraphTypes(graph, { resolveWorkflow: graphResolver(workflow.workspace_id) }),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/v1/workflows/:id/guarantees — verify the workflow's declared path
// invariants against its stored graph (services/guarantees.js).
//
// The CI shape of this is a gate that means something different from `lint`:
// lint asks whether the workflow will run, and this asks whether it still does
// what its author swore it did. `ok` is false when any declaration is violated
// *or* can no longer be checked, because a guarantee that quietly stopped
// being verified is the failure this exists to prevent — a pipeline keying on
// `ok` should stop for both.
//
// Read-only and pure. `read` is the whole authorisation story; changing a
// declaration is a session-side write behind the workspace's own roles.
router.get('/workflows/:id/guarantees', tokenAuth('read'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    let graph = { nodes: [], edges: [] }
    try {
      const parsed = JSON.parse(workflow.graph_json)
      graph = {
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
        edges: Array.isArray(parsed.edges) ? parsed.edges : [],
      }
    } catch {
      /* unparseable stored graph — verify against the empty shape */
    }
    res.json({ workflowId: workflow.id, ...verifyGuarantees(graph, workflow.guarantees_json) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/v1/workflows/:id/paths — which branches an input can take, and what
// payload takes each one (services/pathConstraints.js).
//
// The CI shape of this is a coverage gate rather than a correctness one, and it
// is two numbers a pipeline can key on: `ok` is false when the analysis found a
// branch no input can reach — a dead branch is a defect, and the same one the
// linter reports — while `coverage` says how much of the workflow a generated
// suite could actually drive. A team that wants "every branch is tested" has
// somewhere to assert it.
//
// Read-only and pure; `read` is the whole authorisation story. Writing the
// generated scenarios into the suite is a session-side write behind the
// workspace's own roles.
router.get('/workflows/:id/paths', tokenAuth('read'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    let graph = { nodes: [], edges: [] }
    try {
      const parsed = JSON.parse(workflow.graph_json)
      graph = {
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
        edges: Array.isArray(parsed.edges) ? parsed.edges : [],
      }
    } catch {
      /* unparseable stored graph — analyse the empty shape */
    }
    const report = analyzePaths(graph)
    res.json({
      workflowId: workflow.id,
      ok: report.findings.every((f) => f.severity !== 'error'),
      ...report,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/v1/workflows/:id/lineage — the workflow's dataflow: where each
// node's data comes from, what reads it, and which config fields let data
// leave (services/lineage.js).
//
// `?node=<id>` narrows to one node's provenance and impact — the CI-shaped
// question being "we're about to change this node; what depends on it?".
// Read-only and pure, so `read` is the whole authorisation story.
router.get('/workflows/:id/lineage', tokenAuth('read'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    let graph = { nodes: [], edges: [] }
    try {
      const parsed = JSON.parse(workflow.graph_json)
      graph = {
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
        edges: Array.isArray(parsed.edges) ? parsed.edges : [],
      }
    } catch {
      /* unparseable stored graph — describe an empty dataflow */
    }

    if (req.query.node) {
      const lineage = analyzeLineage(graph)
      if (!lineage.ok) return res.json({ workflowId: workflow.id, ok: false, reason: lineage.reason })
      if (!lineage.nodes[req.query.node]) {
        return res.status(404).json({ error: 'Node not found in graph' })
      }
      return res.json({
        workflowId: workflow.id,
        ok: true,
        provenance: traceProvenance(lineage, req.query.node),
        impact: traceImpact(lineage, req.query.node),
      })
    }

    res.json({ workflowId: workflow.id, ...describeLineage(graph) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/v1/workflows/:id/effects — what a run can do to the outside world,
// and what has to be true first (services/effects.js).
//
// The CI-shaped question is a promotion review's: "this is going to production,
// what can it reach and which gates hold?" Every effect carries the decisions
// it is control-dependent on, so a gate that a second trigger routes around
// shows up as an effect with no conditions rather than as a gate somebody
// assumed was holding. Read-only and pure, so `read` is the whole
// authorisation story.
router.get('/workflows/:id/effects', tokenAuth('read'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    let graph = { nodes: [], edges: [] }
    try {
      const parsed = JSON.parse(workflow.graph_json)
      graph = {
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
        edges: Array.isArray(parsed.edges) ? parsed.edges : [],
      }
    } catch {
      /* unparseable stored graph — describe an empty effect set */
    }
    res.json({ workflowId: workflow.id, ...analyzeEffects(graph) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/v1/workflows/:id/canary — the running release and its statistical
// comparison. The CI-shaped question this answers is "is it safe to promote
// yet?", which is why `recommendation` is a top-level string a pipeline can
// branch on rather than something to be inferred from the numbers.
router.get('/workflows/:id/canary', tokenAuth('read'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    res.json({ workflowId: workflow.id, ...canary.analyze(workflow) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/v1/workflows/:id/canary/promote — ship it. Requires `manage`, the
// same scope importing a definition needs, because both make something live;
// `trigger` deliberately cannot, so a token that starts runs can never change
// what runs.
router.post('/workflows/:id/canary/promote', tokenAuth('manage'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
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
    res.json({ promoted: true, version: version.version })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/v1/workflows/:id/canary/rollback — stop sending traffic to the
// canary. Nothing is restored and nothing is overwritten.
router.post('/workflows/:id/canary/rollback', tokenAuth('manage'), (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    if (!canary.activeCanary(workflow)) {
      return res.status(404).json({ error: 'No canary is running for this workflow' })
    }
    const reason = req.body?.reason ? String(req.body.reason).slice(0, 500) : 'rolled back via API'
    canary.rollback(workflow.id, { reason })
    res.json({ rolledBack: true, reason })
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

// GET /api/v1/executions/:id/breaks — every pause a debug run has taken, with
// the *resolved* config and input each node was about to use
// (services/debugger.js).
//
// From a terminal this is the more useful half of the debugger. A pause that is
// polled, printed, and immediately resumed is a **trace point**: a run that
// reports exactly what each node was about to send, in order, with templates
// substituted and secrets redacted. "Why did the staging run post that body?"
// stops being a question you answer by adding log nodes.
//
// Read-only, so `read` is the whole authorisation story.
router.get('/executions/:id/breaks', tokenAuth('read'), (req, res) => {
  try {
    const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(req.params.id)
    if (!execution) return res.status(404).json({ error: 'Execution not found' })
    if (!getWorkflowForMember(execution.workflow_id, req.user.id)) {
      return res.status(404).json({ error: 'Execution not found' })
    }
    res.json({ executionId: execution.id, breaks: listBreaks(execution.id) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/v1/executions/:id/breaks/:breakId/resume — let a paused node run.
//
// `trigger` scope rather than `read`: resuming decides whether a real HTTP call
// happens and, with an override, with what — it is the same category of act as
// starting the run in the first place, and a read-only token must not be able
// to do it.
router.post('/executions/:id/breaks/:breakId/resume', tokenAuth('trigger'), (req, res) => {
  try {
    const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(req.params.id)
    if (!execution) return res.status(404).json({ error: 'Execution not found' })
    const workflow = getWorkflowForMember(execution.workflow_id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Execution not found' })
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return

    const result = resumeBreak(req.params.breakId, {
      executionId: execution.id,
      action: req.body?.action || 'continue',
      override: req.body?.override,
      userId: req.user.id,
    })
    if (result.error) return res.status(400).json({ error: result.error })
    if (result.notFound) return res.status(404).json({ error: 'Break not found' })
    if (result.alreadySettled) {
      return res.status(409).json({ error: `This break was already ${result.status}` })
    }
    res.status(202).json({ ok: true })
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
    // Compensating transactions, in unwind order. A CI job that triggered this
    // run needs to know not just that it failed but whether the cleanup took —
    // `rollbackStatus: "partial"` is the one that has to page someone.
    const compensations = db.prepare(
      'SELECT node_id, target_node_id, node_type, seq, status, error, attempts, started_at, finished_at FROM execution_compensations WHERE execution_id = ? ORDER BY seq'
    ).all(execution.id)
    res.json({
      execution: {
        id: execution.id,
        workflowId: execution.workflow_id,
        status: execution.status,
        triggerType: execution.trigger_type,
        rollbackStatus: execution.rollback_status,
        startedAt: execution.started_at,
        finishedAt: execution.finished_at,
      },
      steps,
      compensations,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/v1/executions/:id/schedule — where a finished run's time went: the
// measured split between work and waiting for an execution slot, the floor the
// cap kept it from, and what other caps would have produced. Read-only; `read`
// scope. Lets a pipeline gate on contention ("this run spent more than half its
// wall time queueing") rather than only on duration.
router.get('/executions/:id/schedule', tokenAuth('read'), (req, res) => {
  try {
    const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(req.params.id)
    if (!execution) return res.status(404).json({ error: 'Execution not found' })
    const workflow = getWorkflowForMember(execution.workflow_id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Execution not found' })

    const analysis = scheduleAnalysisFor(execution, workflow)
    if (!analysis) return res.json({ executionId: execution.id, available: false })
    res.json({ executionId: execution.id, available: true, ...analysis })
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
    // Present only when the gate asks for more than the historical default, so
    // an ordinary approval's payload is byte-for-byte what it always was.
    ...(row.quorum > 1 ? { quorum: row.quorum } : {}),
    ...(row.required_role ? { requiredRole: row.required_role } : {}),
    ...(row.excluded_user_id ? { separationOfDuties: true } : {}),
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
      return res.status(403).json({ error: result.message || 'Viewers have read-only access', reason: result.reason })
    }
    if (result.outcome === 'conflict') {
      return res.status(409).json({ error: `Approval already ${result.status}` })
    }
    if (result.outcome === 'duplicate') {
      return res.status(409).json({
        error: 'You have already responded to this approval',
        reason: 'already-responded',
        progress: result.progress,
      })
    }
    const row = db.prepare(
      `SELECT a.*, w.name AS workflow_name, u.display_name AS responded_by_name
         FROM execution_approvals a
         LEFT JOIN workflows w ON w.id = a.workflow_id
         LEFT JOIN users u ON u.id = a.responded_by
        WHERE a.id = ?`
    ).get(req.params.id)
    // 202 while the gate is still open, so a CI job that treats every 2xx as
    // "approved" cannot mistake a half-met quorum for a decision.
    const code = result.outcome === 'recorded' ? 202 : 200
    res.status(code).json({ approval: presentApproval(row), progress: result.progress })
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

// POST /api/v1/executions/:id/rollback — run (or finish running) a settled
// run's compensating actions.
//
// Requires the trigger scope rather than read: this fires real side effects at
// real systems — refunds, releases, deletions — and is if anything the most
// consequential thing a token can do. Only what has not already succeeded runs,
// so a retry loop in CI cannot double-undo.
router.post('/executions/:id/rollback', tokenAuth('trigger'), async (req, res) => {
  try {
    const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(req.params.id)
    if (!execution) return res.status(404).json({ error: 'Execution not found' })
    const workflow = getWorkflowForMember(execution.workflow_id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Execution not found' })
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return

    if (execution.status !== 'failed' && execution.status !== 'cancelled') {
      return res.status(409).json({
        error: `Only a failed or cancelled run can be rolled back — this one is ${execution.status}`,
      })
    }

    const { outcome, results } = await rollbackExecution(execution.id)
    if (outcome === null) {
      return res.status(409).json({
        error: 'Nothing to roll back — this run has no outstanding compensations',
      })
    }
    recordAudit(workflow.workspace_id, req.user.id, 'execution.rolled_back', {
      type: 'execution', id: execution.id, name: workflow.name,
      metadata: { workflowId: workflow.id, outcome, compensated: results.length },
    })
    res.json({ executionId: execution.id, outcome, compensations: results })
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

    // A resume starts a run; the pause switch and the concurrency cap both
    // apply like they do to any real run.
    if (!isDryRun) {
      if (isPaused(workflow)) return res.status(409).json({ error: PAUSED_ERROR })
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
