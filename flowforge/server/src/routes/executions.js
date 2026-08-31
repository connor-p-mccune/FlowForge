const express = require('express')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { getExecutionQueue } = require('../config/queue')
const { requestCancel } = require('../services/executionControl')
const { admitRun } = require('../services/concurrencyGate')
const { computeCriticalPath } = require('../services/criticalPath')
const { buildTrace } = require('../services/tracing')
const { compareRuns } = require('../services/runComparison')
const { isValidPriority, resolvePriority, enqueueOpts } = require('../services/runPriority')
const { forbidViewer } = require('../services/workspaceRoles')
const { isPaused, PAUSED_ERROR } = require('../services/workflowPause')
const { rollbackExecution } = require('../services/executionEngine')
const { recordAudit } = require('../services/auditLog')
const { parseDebugRequest, resumeBreak, listBreaks } = require('../services/debugger')
const { listResponses: listApprovalResponses } = require('../services/approvals')
const runSchedule = require('../services/runSchedule')
const scheduleSim = require('../services/scheduleSim')
const nodePriority = require('../services/nodePriority')
const { queryRuns } = require('../services/runQuery')
const runAssertions = require('../services/runAssertions')
const { analyzeMutations } = require('../services/mutationCheck')

const router = express.Router()

// How far the counterfactual sweep goes when reporting what a run would have
// taken under a different cap. Bounded so a read endpoint stays a read endpoint.
const SCHEDULE_MAX_CAP = 12

// Where a finished run's time went: the measured split between work and waiting
// for an execution slot, plus what other caps would have produced. Shared by the
// session route and the public API. `null` when the run has nothing to analyse.
function scheduleAnalysisFor(execution, workflow) {
  let graph
  try {
    graph = JSON.parse(workflow.graph_json)
  } catch {
    return null
  }
  const steps = db.prepare(
    'SELECT node_id, status, started_at, finished_at FROM execution_steps WHERE execution_id = ?'
  ).all(execution.id)

  const cap = scheduleSim.configuredCap()
  const observed = runSchedule.analyzeRun(graph, steps, { cap })
  if (!observed.available) return null

  // The counterfactuals run over the *executed* subgraph, as the critical path
  // does: a dead branch was skipped, and simulating it as though it had run
  // would answer a question about a different execution.
  const durations = runSchedule.observedDurations(observed)
  const ran = new Set(Object.keys(durations))
  const subgraph = {
    nodes: [...ran].map((id) => ({ id })),
    edges: (graph.edges || []).filter((e) => ran.has(e.source) && ran.has(e.target)),
  }
  const durationOf = (id) => durations[id] ?? 0
  const { rankOf } = nodePriority.plan(subgraph, durations)
  const idealMs = scheduleSim.unboundedMakespan(subgraph, durationOf)
  const curve = scheduleSim.speedupCurve(subgraph, {
    durationOf,
    rankOf,
    maxCap: Math.min(SCHEDULE_MAX_CAP, Math.max(cap + 2, 4)),
  })

  return {
    cap,
    observed: {
      makespanMs: Math.round(observed.makespanMs),
      workMs: Math.round(observed.workMs),
      queuedMs: Math.round(observed.queuedMs),
      utilisation: observed.utilisation == null ? null : Number(observed.utilisation.toFixed(3)),
      chain: observed.chain,
    },
    // The floor this run could not have gone below at any capacity — so the gap
    // between it and the observed makespan is exactly what the cap cost.
    idealMakespanMs: idealMs == null ? null : Math.round(idealMs),
    atCap: curve ? curve.map((p) => ({ cap: p.cap, makespanMs: Math.round(p.makespanMs) })) : [],
    perNode: observed.perNode,
  }
}

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

// POST /api/workflows/:id/execute — enqueue a run. An optional body
// { priority: 'high' | 'normal' | 'low' } overrides the workflow's default
// lane for this run only.
router.post('/workflows/:id/execute', auth, async (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return

    const { nodes } = JSON.parse(workflow.graph_json)
    if (!nodes || nodes.length === 0) {
      return res.status(400).json({ error: 'Workflow has no nodes to execute' })
    }

    const requested = req.body?.priority
    if (requested != null && !isValidPriority(requested)) {
      return res.status(400).json({ error: 'priority must be "high", "normal", or "low"' })
    }

    // The kill switch beats capacity: a paused workflow refuses the run
    // before the concurrency gate is even consulted.
    if (isPaused(workflow)) return res.status(409).json({ error: PAUSED_ERROR })

    // 'reject' concurrency policy: refuse the submission at the cap so the
    // caller finds out now rather than watching a run sit queued.
    const admission = admitRun(workflow)
    if (!admission.ok) return res.status(409).json({ error: admission.error })

    // Breakpoints (services/debugger.js). Declared here, on the run, and
    // nowhere else — which is the whole safety story: there is no workflow-level
    // place to leave one, so a schedule tick or a webhook delivery can never
    // hit a breakpoint somebody forgot about. A debug run also takes the high
    // lane, because a person is sitting in front of it.
    const debug = parseDebugRequest(req.body?.debug, JSON.parse(workflow.graph_json))
    const priority = debug ? 'high' : resolvePriority(requested, workflow)
    const executionId = uuidv4()
    const now = new Date().toISOString()
    // Manual runs carry no trigger payload (trigger_data null); trigger_type marks
    // the source so a replay of this run starts from the same empty input.
    db.prepare(
      'INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, priority, debug_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      executionId, workflow.id, 'pending', req.user.id, 'manual', priority,
      debug ? JSON.stringify(debug) : null, now
    )

    await getExecutionQueue().add({ executionId, workflowId: workflow.id }, enqueueOpts(priority))

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
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return

    const { nodes } = JSON.parse(workflow.graph_json)
    if (!nodes || nodes.length === 0) {
      return res.status(400).json({ error: 'Workflow has no nodes to execute' })
    }

    const executionId = uuidv4()
    const now = new Date().toISOString()
    // triggered_by stays the user FK (who ran the test); trigger_type 'dry-run'
    // is the marker, mirroring how 'manual'/'webhook'/'replay' are recorded.
    // Dry runs always ride the high lane: someone is watching the canvas, and
    // an interactive test stuck behind a bulk backlog defeats its purpose.
    db.prepare(
      "INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, priority, created_at) VALUES (?, ?, ?, ?, ?, 'high', ?)"
    ).run(executionId, workflow.id, 'pending', req.user.id, 'dry-run', now)

    await getExecutionQueue().add(
      { executionId, workflowId: workflow.id, dryRun: true },
      enqueueOpts('high')
    )

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
// POST /api/workflows/:id/mutations — would any of this workflow's checks
// notice if it were subtly wrong? (services/mutationCheck.js)
//
// A POST rather than a GET despite writing nothing, because it *executes*:
// every surviving mutant costs a full pass of the scenario suite as dry runs.
// A GET invites a cache, a prefetch and a browser retry, none of which should
// silently launch a hundred and sixty runs.
router.post('/workflows/:id/mutations', auth, async (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    res.json(await analyzeMutations(workflow))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// — Run assertions (services/runAssertions.js) ————————————————————————
//
// A saved query that must never match. Guarantees prove properties of the
// graph; these check the properties of *runs* that no graph analysis reaches —
// the ones about data and outcomes.
//
// The predicate is the same FXL the query route above takes, deliberately: a
// predicate is developed with `query` against history and then pinned here, and
// it has to mean the same thing in both places.

// GET /api/workflows/:id/assertions — what this workflow forbids, and whether
// it is holding.
router.get('/workflows/:id/assertions', auth, (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    res.json({ workflowId: workflow.id, ...runAssertions.reportFor(workflow.id) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/assertions — pin one.
//
// A predicate that does not parse is refused rather than stored, because a
// stored one that cannot be evaluated is silently green forever.
router.post('/workflows/:id/assertions', auth, (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })

    const result = runAssertions.createAssertion(workflow.id, {
      name: req.body?.name,
      predicate: req.body?.predicate,
      createdBy: req.user.id,
    })
    if (!result.ok) return res.status(400).json({ error: result.error })
    res.status(201).json({ assertion: result.assertion })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// The workflow an assertion belongs to, checked for membership. Assertion ids
// are opaque, so the ownership has to be resolved through the workflow rather
// than trusted from the path.
function assertionForMember(assertionId, userId) {
  const assertion = db
    .prepare('SELECT * FROM workflow_assertions WHERE id = ?')
    .get(assertionId)
  if (!assertion) return null
  return getWorkflowForMember(assertion.workflow_id, userId) ? assertion : null
}

// PUT /api/assertions/:id — rename, re-word, enable or disable.
router.put('/assertions/:id', auth, (req, res) => {
  try {
    if (!assertionForMember(req.params.id, req.user.id)) {
      return res.status(404).json({ error: 'Assertion not found' })
    }
    const result = runAssertions.updateAssertion(req.params.id, {
      name: req.body?.name,
      predicate: req.body?.predicate,
      enabled: req.body?.enabled,
    })
    if (!result.ok) return res.status(400).json({ error: result.error })
    res.json({ assertion: result.assertion })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/assertions/:id
router.delete('/assertions/:id', auth, (req, res) => {
  try {
    if (!assertionForMember(req.params.id, req.user.id)) {
      return res.status(404).json({ error: 'Assertion not found' })
    }
    runAssertions.deleteAssertion(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/query — ask a question of this workflow's run history
// in FXL (services/runQuery.js).
//
// The list above is the fifty most recent runs, which is the right default for
// a history panel and the wrong one for a question. This reaches past it: the
// predicate decides which runs come back, not their recency.
router.post('/workflows/:id/query', auth, (req, res) => {
  try {
    const workflow = getWorkflowForMember(req.params.id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })

    const where = req.body?.where
    if (typeof where !== 'string' || where.trim() === '') {
      return res.status(400).json({ error: 'where is required and must be an FXL expression' })
    }
    if (where.length > 4000) {
      return res.status(400).json({ error: 'where must be at most 4000 characters' })
    }

    const result = queryRuns(workflow.id, where, { limit: req.body?.limit })
    if (!result.ok) {
      return res.status(400).json({ error: result.error, position: result.position })
    }
    res.json({ workflowId: workflow.id, ...result })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

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
    // Every vote rides along, not only whoever settled it: under a quorum the
    // `responded_by` column holds the *last* approver, which is the least
    // interesting of the names, and "who signed off on this" is the question
    // somebody opens a finished run to answer.
    const approvals = db.prepare(
      `SELECT a.*, u.display_name AS responded_by_name,
              (SELECT COUNT(*) FROM execution_approval_responses r
                WHERE r.approval_id = a.id AND r.decision = 'approve') AS approvals_count
         FROM execution_approvals a LEFT JOIN users u ON u.id = a.responded_by
        WHERE a.execution_id = ? ORDER BY a.requested_at`
    ).all(execution.id).map((a) => ({ ...a, responses: listApprovalResponses(a.id) }))

    // Critical path: the longest dependency-respecting chain of steps, computed
    // from the run's recorded timings against the workflow's current edges
    // (matching the timeline, which also works off current graph + recorded
    // steps). Best-effort — a malformed graph_json just yields an empty path.
    let criticalPath = { path: [], totalMs: 0, durationsMs: {} }
    try {
      criticalPath = computeCriticalPath(JSON.parse(workflow.graph_json), steps)
    } catch {
      /* unparseable graph — leave the empty critical path */
    }

    // Compensating transactions: what the rollback undid, in unwind order.
    // Empty for every run that succeeded and every workflow with no
    // compensations, which is why it rides the existing detail response rather
    // than a second round trip — the cost of "none" is one indexed lookup.
    const compensations = db.prepare(
      'SELECT * FROM execution_compensations WHERE execution_id = ? ORDER BY seq'
    ).all(execution.id)

    res.json({ execution, steps, childExecutions, approvals, criticalPath, compensations })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/executions/:id/schedule — work versus waiting.
//
// The critical path already says which chain of steps set the run's duration.
// It cannot say why a node that was ready at 1.2s started at 4.0s, because the
// answer is not in the graph: the node was waiting for a slot, and whoever was
// holding it may be on an unrelated branch. That is measured here from the
// recorded timestamps rather than modelled, and paired with what the same run
// would have taken at a different cap.
router.get('/executions/:id/schedule', auth, (req, res) => {
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

// GET /api/executions/:id/trace — the run as OTLP/JSON spans.
//
// The response body is exactly what an OpenTelemetry collector's OTLP/HTTP
// receiver accepts, so exporting a run is `curl … | curl -X POST
// $COLLECTOR/v1/traces -d @-` rather than a translation layer somebody has to
// maintain. Emitting the standard shape is also what makes the trace *joinable*:
// a webhook-triggered run carries the caller's trace id, and the services this
// run called carry the step's span id, so a viewer that already has those spans
// assembles the whole picture without knowing anything about FlowForge.
router.get('/executions/:id/trace', auth, (req, res) => {
  try {
    const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(req.params.id)
    if (!execution) return res.status(404).json({ error: 'Execution not found' })
    const workflow = getWorkflowForMember(execution.workflow_id, req.user.id)
    if (!workflow) return res.status(404).json({ error: 'Execution not found' })

    const steps = db
      .prepare('SELECT * FROM execution_steps WHERE execution_id = ? ORDER BY rowid')
      .all(execution.id)

    res.json(buildTrace(execution, steps, workflow))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/executions/:id/compare/:otherId — diff two runs of the same
// workflow node by node: status changes, per-step duration deltas, and output
// differences (over the persisted, secret-redacted rows). Both runs must
// belong to one workflow — comparing runs of different workflows would line
// up nothing — and one membership check covers both since they share it.
router.get('/executions/:id/compare/:otherId', auth, (req, res) => {
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

// POST /api/executions/:id/cancel — stop a queued or running execution. Queued
// runs are finalized immediately; running ones are wound down cooperatively by
// the engine at its next scheduling round (an in-flight node always finishes —
// cancellation never tears a node down mid-call). 409 once the run is over.
router.post('/executions/:id/cancel', auth, (req, res) => {
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
    const updated = db.prepare('SELECT * FROM executions WHERE id = ?').get(execution.id)
    res.status(202).json({ execution: updated })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/executions/:id/breaks — every pause this run took, with what the
// node was about to receive and about to do (services/debugger.js).
//
// A read, and it doubles as the recovery path for a panel that missed the live
// `exec-update`: the row is the source of truth, so a page refresh mid-pause
// finds the run still waiting rather than showing a run that appears stuck.
router.get('/executions/:id/breaks', auth, (req, res) => {
  try {
    const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(req.params.id)
    if (!execution) return res.status(404).json({ error: 'Execution not found' })
    if (!getWorkflowForMember(execution.workflow_id, req.user.id)) {
      return res.status(404).json({ error: 'Execution not found' })
    }
    res.json({ breaks: listBreaks(execution.id) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/executions/:id/breaks/:breakId/resume — let a paused node run.
//
// `action` is `continue` (run to the next breakpoint), `step` (stop again at
// the very next node), or `abort` (cancel the run from here). `override` is an
// optional `{ config, input }` patch applied to what the node was about to use,
// which is the part that makes this a debugger rather than a viewer: change the
// amount and watch the condition below it take the other branch.
//
// A write in the strongest sense — it decides whether a real HTTP call happens
// and with what — so viewers are refused, and the settled-guard lives inside the
// UPDATE so two people pressing Continue resolve to one winner.
router.post('/executions/:id/breaks/:breakId/resume', auth, (req, res) => {
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
      return res.status(409).json({
        error: `This break was already ${result.status}`,
        status: result.status,
        action: result.action,
      })
    }
    res.status(202).json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/executions/:id/rollback — run (or finish running) the compensating
// actions for a run that already settled badly.
//
// The automatic rollback fires the moment a run fails. This exists for the case
// it cannot handle: the compensation itself was broken. A refund endpoint that
// was down, a credential that had rotated, a `{{…}}` that pointed at the wrong
// field — the run lands `partial`, someone fixes the compensating node, and
// this replays only what is still outstanding.
//
// Three rules, each mirroring a decision made elsewhere:
//
//   * Only a settled, unsuccessful run. Unwinding a run that is still going
//     would race the engine for the same side effects, and unwinding a
//     *successful* one is not a rollback — it is a new workflow, and pretending
//     otherwise would give people a one-click undo with no audit story.
//   * Only what has not already succeeded. Compensations are supposed to be
//     idempotent and frequently are not; double-refunding a customer while
//     cleaning up after a failure is worse than the failure was.
//   * Viewers cannot. It fires real side effects, so it is a write.
router.post('/executions/:id/rollback', auth, async (req, res) => {
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
      type: 'execution',
      id: execution.id,
      name: workflow.name,
      metadata: {
        workflowId: workflow.id,
        outcome,
        compensated: results.length,
        failed: results.filter((r) => r.status === 'failed').length,
      },
    })

    res.json({
      executionId: execution.id,
      outcome,
      compensations: db.prepare(
        'SELECT * FROM execution_compensations WHERE execution_id = ? ORDER BY seq'
      ).all(execution.id),
    })
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
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return

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

    // Real replays start real runs, so the pause switch and the concurrency
    // cap both apply; a dry-run replay stays exempt from both, like any dry run.
    if (!isDryRun) {
      if (isPaused(workflow)) return res.status(409).json({ error: PAUSED_ERROR })
      const admission = admitRun(workflow)
      if (!admission.ok) return res.status(409).json({ error: admission.error })
    }

    // A replay takes the original run's lane (a dry-run replay stays high,
    // like any dry run); an original without a recorded lane falls back to
    // the workflow's current default.
    const priority = isDryRun ? 'high' : resolvePriority(original.priority, workflow)
    const executionId = uuidv4()
    const now = new Date().toISOString()
    // triggered_by is the user who clicked Replay; trigger_type marks it a replay
    // (or 'dry-run' when the original was a test).
    db.prepare(
      'INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, trigger_data, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(executionId, workflow.id, 'pending', req.user.id, isDryRun ? 'dry-run' : 'replay', original.trigger_data ?? null, priority, now)

    await getExecutionQueue().add({
      executionId,
      workflowId: workflow.id,
      payload,
      ...(isDryRun ? { dryRun: true } : {}),
    }, enqueueOpts(priority))

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

    // A resume starts a run; the pause switch and the concurrency cap both
    // apply like they do to any real run.
    if (!isDryRun) {
      if (isPaused(workflow)) return res.status(409).json({ error: PAUSED_ERROR })
      const admission = admitRun(workflow)
      if (!admission.ok) return res.status(409).json({ error: admission.error })
    }

    // Like replay: a resume continues the original run, so it keeps its lane.
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

    const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId)
    res.status(202).json({ execution })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
// Exported for the public API, which needs the same analysis behind a token
// rather than a session.
module.exports.scheduleAnalysisFor = scheduleAnalysisFor
