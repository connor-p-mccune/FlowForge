const express = require('express')
const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { webhookLimiter } = require('../middleware/rateLimit')
const { statusBadgeSvg } = require('../services/statusBadge')
const { validate } = require('../middleware/validate')
const scheduler = require('../services/scheduler')
const activityService = require('../services/activityService')
const { lintGraph } = require('../services/workflowLinter')
const { describeGraphTypes } = require('../services/typeInference')
const { graphResolver, approverCounts } = require('../services/graphLookup')
const { checkWorkflow, policyIssues } = require('../services/policyGate')
const stepCache = require('../services/stepCache')
const { isValidPriority } = require('../services/runPriority')
const { ROLLBACK_POLICIES } = require('../services/compensation')
const { POLICIES: RECOVERY_POLICIES, recoveryPolicy: recoveryPolicyOf } = require('../services/crashRecovery')
const { analyzeRepeats, MAX_ATTEMPTS } = require('../services/repeats')
const { describeLineage, analyzeLineage, traceProvenance, traceImpact } = require('../services/lineage')
const { verifyGuarantees, parseGuarantees } = require('../services/guarantees')
const { formatWorkflow, parseWorkflow, DslError } = require('../services/workflowDsl')
const { analyzeEffects } = require('../services/effects')
const { analyzeConvergence } = require('../services/convergence')
const { reachableEffects } = require('../services/reach')
const { subWorkflowGraphs } = require('../services/reachLookup')
const { analyzeContract } = require('../services/contractCheck')
const { analyzePaths } = require('../services/pathConstraints')
const { previewDeploy } = require('../services/backtest')
const { verifyImport } = require('../services/trustStore')
const { parseRedactions } = require('../services/redaction')

// The provenance verdict as a caller sees it. `digest` is the identity of the
// graph that landed — printable, comparable, and the same value the signer saw
// — and it is reported for an unsigned import too, because "which graph is this"
// is useful whether or not anybody vouched for it.
const presentProvenance = (verdict) => ({
  status: verdict.status,
  signedBy: verdict.key,
  required: verdict.required,
  digest: verdict.digest,
})
const collabSession = require('../services/collabSession')
const { mergeDocument, applyMerge } = require('../services/workflowMerge')
const { forbidViewer } = require('../services/workspaceRoles')
const { pauseWorkflow, resumeWorkflow } = require('../services/workflowPause')
const { computeDependencies } = require('../services/workflowDependencies')
const { recordAudit } = require('../services/auditLog')
const { isValid: isValidCron } = require('../services/cronExpression')
const { isValidTimeZone } = require('../services/timezone')
const {
  getRunner,
  loadWorkspaceSecrets,
  loadWorkspaceVariables,
  buildRedactor,
  redactDeep,
  resolveTemplates,
} = require('../services/executionEngine')

const router = express.Router()

// Workflow edits (rename + graph saves) collapse into a single "edited" activity
// entry per actor per workflow within this window, so a sustained editing session
// doesn't flood the feed. Env-tunable (ms) like the other limits; default 5 min.
const COALESCE_RAW = Number(process.env.ACTIVITY_EDIT_COALESCE_MS)
const EDIT_COALESCE_MS = Number.isFinite(COALESCE_RAW) ? COALESCE_RAW : 5 * 60 * 1000

// Pull a workflow's `trigger-schedule` node (if any) out of its stored graph, so
// deploy/archive can activate or clear its cron schedule. Tolerates bad JSON.
function findScheduleNode(workflow) {
  try {
    const { nodes } = JSON.parse(workflow.graph_json)
    return (nodes || []).find((n) => n.type === 'trigger-schedule') || null
  } catch {
    return null
  }
}

// Parse a stored graph_json into a normalized { nodes, edges } object with both
// guaranteed to be arrays, tolerating a corrupt/empty column.
function parseGraphData(graphJson) {
  try {
    const parsed = JSON.parse(graphJson)
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    }
  } catch {
    return { nodes: [], edges: [] }
  }
}

const workflowRule = {
  name: { required: true, type: 'string', maxLength: 200 },
  description: { type: 'string', maxLength: 2000 },
}
const graphRule = {
  nodes: { required: true, type: 'array', maxItems: 2000 },
  edges: { required: true, type: 'array', maxItems: 5000 },
}

// Import accepts the parsed contents of an exported file. graph_data is validated
// as an object here; its nodes/edges arrays are checked in the handler (the
// validate helper doesn't recurse into nested shapes).
const importRule = {
  name: { required: true, type: 'string', maxLength: 200 },
  graph_data: { required: true, type: 'object' },
}

// Reject an imported graph whose serialized form exceeds this. The global 2mb
// body cap (index.js) is the outer backstop; this keeps a single imported graph
// to a sane size regardless of the rest of the payload.
const MAX_IMPORT_GRAPH_BYTES = 500 * 1024 // 500KB

function isMember(workspaceId, userId) {
  return db.prepare(
    'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(workspaceId, userId)
}

router.get('/workspaces/:wsId/workflows', auth, (req, res) => {
  try {
    if (!isMember(req.params.wsId, req.user.id)) {
      return res.status(404).json({ error: 'Workspace not found' })
    }
    const workflows = db.prepare(
      'SELECT * FROM workflows WHERE workspace_id = ? ORDER BY created_at DESC'
    ).all(req.params.wsId)
    res.json({ workflows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/workspaces/:wsId/workflows', auth, validate(workflowRule), (req, res) => {
  try {
    if (!isMember(req.params.wsId, req.user.id)) {
      return res.status(404).json({ error: 'Workspace not found' })
    }
    if (forbidViewer(res, req.params.wsId, req.user.id)) return
    const { name, description } = req.body

    const id = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO workflows (id, workspace_id, name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, req.params.wsId, name, description || null, req.user.id, now, now)

    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id)
    activityService.logEvent(req.params.wsId, req.user.id, 'workflow.created', {
      type: 'workflow', id, name: workflow.name,
    })
    res.status(201).json({ workflow })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workspaces/:wsId/workflows/import — create a new draft workflow from
// the parsed contents of an exported file ({ name, graph_data }). graph_data must
// be an object holding nodes[] and edges[]; the serialized graph is size-capped.
// (The /import segment keeps this distinct from POST /workspaces/:wsId/workflows.)
router.post('/workspaces/:wsId/workflows/import', auth, validate(importRule), (req, res) => {
  try {
    if (!isMember(req.params.wsId, req.user.id)) {
      return res.status(404).json({ error: 'Workspace not found' })
    }
    if (forbidViewer(res, req.params.wsId, req.user.id)) return
    const { name, graph_data } = req.body
    if (!Array.isArray(graph_data.nodes) || !Array.isArray(graph_data.edges)) {
      return res.status(400).json({ error: 'graph_data must include nodes and edges arrays' })
    }

    // Persist only the { nodes, edges } the canvas understands, dropping any other
    // top-level keys so an import can't smuggle in extra data, then size-check it.
    const graphJson = JSON.stringify({ nodes: graph_data.nodes, edges: graph_data.edges })
    if (Buffer.byteLength(graphJson, 'utf8') > MAX_IMPORT_GRAPH_BYTES) {
      return res.status(413).json({ error: 'Workflow graph is too large (max 500KB)' })
    }

    // Provenance (services/trustStore.js). An import is where a definition
    // crosses an environment boundary, and between the review and this call the
    // document passed through a repository, a runner and an HTTP request. A
    // trusted signature is what makes "the graph that arrived is the graph that
    // was reviewed" a fact rather than an assumption.
    //
    // A *broken* signature is refused whether or not this workspace requires
    // signing, because it means the document changed after it was signed. Only
    // the unsigned case is a matter of configuration.
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.wsId)
    const provenance = verifyImport(workspace, req.body)
    if (!provenance.allowed) {
      return res.status(403).json({ error: provenance.reason, provenance: presentProvenance(provenance) })
    }

    // Invariants declared in the source workspace come across with the graph.
    // Parsed rather than trusted: an import is an outside document, and one
    // naming nodes this graph doesn't have would be stored as a guarantee that
    // can never be checked — which is the exact state the feature refuses.
    const guarantees = parseGuarantees(req.body.guarantees)

    const id = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workflows (id, workspace_id, name, description, graph_json, guarantees_json, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)"
    ).run(id, req.params.wsId, name, null, graphJson, guarantees.length ? JSON.stringify(guarantees) : null, req.user.id, now, now)

    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id)
    // An import is how a definition crosses an environment boundary — the
    // question "where did this workflow in production come from?" is exactly
    // what a review asks, so it belongs in the audited record.
    recordAudit(req.params.wsId, req.user.id, 'workflow.imported', {
      type: 'workflow', id, name: workflow.name,
      // The provenance rides into the audit entry, because "who approved the
      // definition running in production" is the question this exists to answer
      // and the answer has to survive in the record rather than in a response
      // body nobody kept. The digest is included even for an unsigned import:
      // it identifies exactly which graph landed.
      metadata: {
        nodes: graph_data.nodes.length,
        signature: provenance.status,
        signedBy: provenance.key?.fingerprint ?? null,
        digest: provenance.digest,
      },
    })
    // Policy violations are *reported*, not enforced, on import. An import
    // lands as a draft — nothing the organisation runs yet — and refusing to
    // let a definition in would prevent bringing it here to fix it. The deploy
    // gate is where "may this be live?" is answered; this is so a promotion
    // pipeline finds out at the import step rather than one command later.
    res.status(201).json({
      workflow,
      policyViolations: checkWorkflow(workflow).violations,
      provenance: presentProvenance(provenance),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/workflows/:id', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    if (!isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    res.json({ workflow })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/workflows/:id/export — return the workflow in a portable, self-
// contained shape (no internal ids/ownership) that POST .../import can recreate.
// Not a file download: the client turns this JSON into a Blob and saves it.
router.get('/workflows/:id/export', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    const document = {
      exportVersion: '1.0',
      name: workflow.name,
      description: workflow.description,
      graph_data: parseGraphData(workflow.graph_json),
      // Declared path invariants travel with the definition. They are
      // statements *about* this graph and reference its node ids, so a document
      // that arrived without them would be the interesting half missing — and a
      // promotion pipeline that dropped them would silently ship the workflow
      // without the checks that were the reason it passed review.
      guarantees: parseGuarantees(workflow.guarantees_json),
      exportedAt: new Date().toISOString(),
    }
    // `?format=flow` serves the reviewable text form (services/workflowDsl),
    // so the app's Export can hand somebody the file they will actually put in
    // a pull request rather than the one they will have to translate.
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

// Optional per-workflow run-concurrency settings (services/concurrencyGate.js).
// Validated here rather than in workflowRule: both are optional and
// max_concurrent_runs is nullable (null clears the cap), which the shared
// validate helper doesn't express. Returns an error string or null.
function validateConcurrency(body) {
  if ('max_concurrent_runs' in body && body.max_concurrent_runs !== null) {
    const n = body.max_concurrent_runs
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      return 'max_concurrent_runs must be an integer between 1 and 100, or null for unlimited'
    }
  }
  if ('concurrency_policy' in body && !['queue', 'reject'].includes(body.concurrency_policy)) {
    return 'concurrency_policy must be "queue" or "reject"'
  }
  return null
}

// Optional per-workflow rate limit (services/concurrencyGate.js). The two
// fields travel together: both null = no limit, both set = at most
// rate_limit_max run starts per rate_limit_window_seconds. Validated here (not
// in workflowRule) because they're nullable and interdependent — the
// both-or-neither rule is enforced after value resolution in the handler.
// Returns an error string or null.
function validateRateLimit(body) {
  if ('rate_limit_max' in body && body.rate_limit_max !== null) {
    const n = body.rate_limit_max
    if (!Number.isInteger(n) || n < 1 || n > 100000) {
      return 'rate_limit_max must be an integer between 1 and 100000, or null to clear it'
    }
  }
  if ('rate_limit_window_seconds' in body && body.rate_limit_window_seconds !== null) {
    const n = body.rate_limit_window_seconds
    if (!Number.isInteger(n) || n < 1 || n > 86400) {
      return 'rate_limit_window_seconds must be an integer between 1 and 86400 (one day), or null to clear it'
    }
  }
  return null
}

// Optional scheduled maintenance window (services/maintenanceWindow.js). The
// two fields travel together: both null = no window, both set = auto-pause for
// maintenance_duration_minutes starting at each maintenance_cron fire time.
// The cron is validated by the same engine the schedule preview uses, so a
// window that saves is a window that computes. The both-or-neither rule is
// enforced after value resolution in the handler. Returns an error string or
// null.
function validateMaintenance(body) {
  if ('maintenance_cron' in body && body.maintenance_cron !== null) {
    if (typeof body.maintenance_cron !== 'string' || !isValidCron(body.maintenance_cron)) {
      return 'maintenance_cron must be a valid cron expression, or null to clear it'
    }
  }
  if ('maintenance_duration_minutes' in body && body.maintenance_duration_minutes !== null) {
    const n = body.maintenance_duration_minutes
    if (!Number.isInteger(n) || n < 1 || n > 10080) {
      return 'maintenance_duration_minutes must be an integer between 1 and 10080 (one week), or null to clear it'
    }
  }
  // The zone the window's cron is read in. Optional and independent of the
  // both-or-neither pair above — null simply means UTC, which is what every
  // window meant before zones existed.
  if ('maintenance_timezone' in body && body.maintenance_timezone !== null) {
    if (
      typeof body.maintenance_timezone !== 'string' ||
      !isValidTimeZone(body.maintenance_timezone)
    ) {
      return 'maintenance_timezone must be a valid IANA time zone name (e.g. "America/New_York"), or null for UTC'
    }
  }
  return null
}

// Optional per-workflow SLA targets (services/slaMonitor.js). Both are nullable
// (null clears the objective), so they're validated here rather than in the
// shared workflowRule. Returns an error string or null.
function validateSla(body) {
  if ('sla_max_duration_ms' in body && body.sla_max_duration_ms !== null) {
    const n = body.sla_max_duration_ms
    if (!Number.isInteger(n) || n < 1) {
      return 'sla_max_duration_ms must be a positive integer (milliseconds), or null to clear it'
    }
  }
  if ('sla_min_success_rate' in body && body.sla_min_success_rate !== null) {
    const r = body.sla_min_success_rate
    if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > 1) {
      return 'sla_min_success_rate must be a number between 0 and 1, or null to clear it'
    }
  }
  return null
}

// Optional SLO objective (services/sloBudget.js). Distinct from
// sla_min_success_rate: that is a floor that alerts when crossed, while an
// objective explicitly budgets for failure and alerts on how fast the budget is
// being spent. Both nullable and independent — a workflow may sensibly declare
// either, both, or neither. Returns an error string or null.
function validateSlo(body) {
  if ('slo_target' in body && body.slo_target !== null) {
    const t = body.slo_target
    // Strictly between 0 and 1: a target of 1 means "never fail", which has no
    // error budget at all and would make every burn rate infinite.
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t >= 1) {
      return 'slo_target must be a number strictly between 0 and 1 (e.g. 0.99), or null to clear it'
    }
  }
  if ('slo_window_days' in body && body.slo_window_days !== null) {
    const d = body.slo_window_days
    if (!Number.isInteger(d) || d < 1 || d > 90) {
      return 'slo_window_days must be an integer between 1 and 90, or null for the 28-day default'
    }
  }
  return null
}

// Optional heartbeat expectation (services/heartbeatMonitor.js). Nullable
// (null clears it — and clears any outstanding alert with it, so a retired
// expectation can't leave a stale "missed" state behind). Bounded to a week:
// anything longer is better served by looking at the dashboard.
function validateHeartbeat(body) {
  if ('heartbeat_interval_minutes' in body && body.heartbeat_interval_minutes !== null) {
    const n = body.heartbeat_interval_minutes
    if (!Number.isInteger(n) || n < 1 || n > 10080) {
      return 'heartbeat_interval_minutes must be an integer between 1 and 10080 (one week), or null to clear it'
    }
  }
  return null
}

// Optional error-handler workflow (services/errorHandler.js). Nullable (null
// clears the handler); a non-null id must name another workflow in the same
// workspace — self-handling is refused here because it's almost certainly a
// mistake, even though the runtime loop guard would cap it at one firing.
// Returns an error string or null.
function validateErrorHandler(body, workflow) {
  if (!('error_workflow_id' in body) || body.error_workflow_id === null) return null
  const id = body.error_workflow_id
  if (typeof id !== 'string' || id.trim() === '') {
    return 'error_workflow_id must be a workflow id, or null to clear it'
  }
  if (id === workflow.id) {
    return 'a workflow cannot be its own error handler'
  }
  const target = db.prepare('SELECT id, workspace_id FROM workflows WHERE id = ?').get(id)
  if (!target || target.workspace_id !== workflow.workspace_id) {
    return 'error_workflow_id must name a workflow in the same workspace'
  }
  return null
}

// Optional default run priority (services/runPriority.js). Not nullable — a
// workflow always has a lane, so "clearing" it means setting 'normal'.
function validatePriority(body) {
  if ('default_priority' in body && !isValidPriority(body.default_priority)) {
    return 'default_priority must be "high", "normal", or "low"'
  }
  return null
}

// Compensating transactions (services/compensation.js). Not nullable for the
// same reason the priority lane isn't: a workflow always has a policy, and
// "clearing" it means returning to the default of unwinding a failed run.
function validateRollbackPolicy(body) {
  if ('rollback_policy' in body && !ROLLBACK_POLICIES.includes(body.rollback_policy)) {
    return `rollback_policy must be one of ${ROLLBACK_POLICIES.join(', ')}`
  }
  if ('recovery_policy' in body && !RECOVERY_POLICIES.includes(body.recovery_policy)) {
    return `recovery_policy must be one of ${RECOVERY_POLICIES.join(', ')}`
  }
  return null
}

router.put('/workflows/:id', auth, validate(workflowRule), (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    const { name, description } = req.body

    const concurrencyError = validateConcurrency(req.body)
    if (concurrencyError) return res.status(400).json({ error: concurrencyError })
    const rateLimitError = validateRateLimit(req.body)
    if (rateLimitError) return res.status(400).json({ error: rateLimitError })
    const maintenanceError = validateMaintenance(req.body)
    if (maintenanceError) return res.status(400).json({ error: maintenanceError })
    const slaError = validateSla(req.body)
    if (slaError) return res.status(400).json({ error: slaError })
    const heartbeatError = validateHeartbeat(req.body)
    if (heartbeatError) return res.status(400).json({ error: heartbeatError })
    const sloError = validateSlo(req.body)
    if (sloError) return res.status(400).json({ error: sloError })
    const rollbackError = validateRollbackPolicy(req.body)
    if (rollbackError) return res.status(400).json({ error: rollbackError })
    const handlerError = validateErrorHandler(req.body, workflow)
    if (handlerError) return res.status(400).json({ error: handlerError })
    const priorityError = validatePriority(req.body)
    if (priorityError) return res.status(400).json({ error: priorityError })
    const maxConcurrent =
      'max_concurrent_runs' in req.body ? req.body.max_concurrent_runs : workflow.max_concurrent_runs
    const policy =
      'concurrency_policy' in req.body ? req.body.concurrency_policy : workflow.concurrency_policy
    const rateMax =
      'rate_limit_max' in req.body ? req.body.rate_limit_max : workflow.rate_limit_max
    const rateWindow =
      'rate_limit_window_seconds' in req.body
        ? req.body.rate_limit_window_seconds
        : workflow.rate_limit_window_seconds
    // Both-or-neither: a max without a window (or vice versa) is meaningless.
    if ((rateMax == null) !== (rateWindow == null)) {
      return res.status(400).json({
        error: 'rate_limit_max and rate_limit_window_seconds must be set together, or both cleared',
      })
    }
    // The trigger field naming whose data a run is about (services/subjectIndex.js).
    // Dotted path or null; validated for shape only, since whether the field is
    // present in a given payload is a per-run fact and a run with no subject is
    // the normal case rather than an error.
    let subjectPath =
      'subject_path' in req.body ? req.body.subject_path : workflow.subject_path
    if (subjectPath != null) {
      subjectPath = String(subjectPath).trim()
      if (subjectPath === '') subjectPath = null
      else if (!/^[\w-]+(\.[\w-]+)*$/.test(subjectPath)) {
        return res.status(400).json({
          error: 'subject_path must be a dotted field path, e.g. "customer.email"',
        })
      }
    }

    const maintenanceCron =
      'maintenance_cron' in req.body ? req.body.maintenance_cron : workflow.maintenance_cron
    const maintenanceDuration =
      'maintenance_duration_minutes' in req.body
        ? req.body.maintenance_duration_minutes
        : workflow.maintenance_duration_minutes
    if ((maintenanceCron == null) !== (maintenanceDuration == null)) {
      return res.status(400).json({
        error:
          'maintenance_cron and maintenance_duration_minutes must be set together, or both cleared',
      })
    }
    // A zone with no window to interpret is dead config; clearing the window
    // clears it too, so a later window can't inherit a forgotten zone.
    const maintenanceTimezone =
      maintenanceCron == null
        ? null
        : 'maintenance_timezone' in req.body
          ? req.body.maintenance_timezone
          : workflow.maintenance_timezone
    const slaMaxDuration =
      'sla_max_duration_ms' in req.body ? req.body.sla_max_duration_ms : workflow.sla_max_duration_ms
    const slaMinSuccess =
      'sla_min_success_rate' in req.body ? req.body.sla_min_success_rate : workflow.sla_min_success_rate
    const heartbeatInterval =
      'heartbeat_interval_minutes' in req.body
        ? req.body.heartbeat_interval_minutes
        : workflow.heartbeat_interval_minutes
    // Changing (or clearing) the expectation resets the edge-trigger state:
    // the old alert answered the old promise.
    const heartbeatAlertedAt =
      heartbeatInterval === workflow.heartbeat_interval_minutes ? workflow.heartbeat_alerted_at : null
    const sloTarget = 'slo_target' in req.body ? req.body.slo_target : workflow.slo_target
    // Clearing the target clears the window with it: a window with no objective
    // to measure is dead config the next objective would silently inherit.
    const sloWindowDays =
      sloTarget == null
        ? null
        : 'slo_window_days' in req.body
          ? req.body.slo_window_days
          : workflow.slo_window_days
    const errorWorkflowId =
      'error_workflow_id' in req.body ? req.body.error_workflow_id : workflow.error_workflow_id
    const defaultPriority =
      'default_priority' in req.body ? req.body.default_priority : workflow.default_priority
    const rollbackPolicyValue =
      'rollback_policy' in req.body ? req.body.rollback_policy : workflow.rollback_policy
    const recoveryPolicyValue =
      'recovery_policy' in req.body ? req.body.recovery_policy : workflow.recovery_policy
    // Parsed rather than rejected, like guarantees: a malformed entry is dropped
    // and the stored list echoed back, so a caller sees exactly what was kept
    // instead of assuming. An empty list stores NULL rather than "[]" — the two
    // mean the same thing and one of them is a value somebody has to explain.
    const redactions =
      'redact' in req.body ? parseRedactions(req.body.redact) : parseRedactions(workflow.redact_json)
    // Output-drift alerting. Switching it off clears the outstanding alert and
    // its fingerprint, so re-enabling later starts from a clean slate rather
    // than staying silent about a drift the first alert already reported.
    const driftMonitoring =
      'drift_monitoring' in req.body
        ? (req.body.drift_monitoring ? 1 : 0)
        : (workflow.drift_monitoring ?? 0)
    const driftAlertedAt = driftMonitoring ? workflow.drift_alerted_at : null
    const driftFingerprint = driftMonitoring ? workflow.drift_fingerprint : null

    const now = new Date().toISOString()
    db.prepare(
      `UPDATE workflows SET name = ?, description = ?, max_concurrent_runs = ?, concurrency_policy = ?,
         rate_limit_max = ?, rate_limit_window_seconds = ?,
         maintenance_cron = ?, maintenance_duration_minutes = ?, maintenance_timezone = ?,
         sla_max_duration_ms = ?, sla_min_success_rate = ?, heartbeat_interval_minutes = ?, heartbeat_alerted_at = ?,
         slo_target = ?, slo_window_days = ?,
         error_workflow_id = ?, default_priority = ?, rollback_policy = ?, recovery_policy = ?,
         drift_monitoring = ?, drift_alerted_at = ?, drift_fingerprint = ?,
         redact_json = ?, subject_path = ?, updated_at = ? WHERE id = ?`
    ).run(name, description ?? workflow.description, maxConcurrent, policy, rateMax, rateWindow, maintenanceCron, maintenanceDuration, maintenanceTimezone, slaMaxDuration, slaMinSuccess, heartbeatInterval, heartbeatAlertedAt, sloTarget, sloWindowDays, errorWorkflowId, defaultPriority, rollbackPolicyValue, recoveryPolicyValue, driftMonitoring, driftAlertedAt, driftFingerprint, redactions.length ? JSON.stringify(redactions) : null, subjectPath, now, req.params.id)

    // Clearing (or removing) the window while it still holds a maintenance
    // pause would strand the workflow paused — the sweep no longer sees it to
    // resume. So release a maintenance pause the moment its window is cleared.
    if (maintenanceCron == null && workflow.paused_reason === 'maintenance') {
      resumeWorkflow(
        db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id),
        req.user.id,
        { eventType: 'workflow.maintenance_ended' }
      )
    }

    const updated = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    activityService.logEvent(workflow.workspace_id, req.user.id, 'workflow.updated', {
      type: 'workflow', id: workflow.id, name: updated.name,
    }, { coalesceWindowMs: EDIT_COALESCE_MS })
    res.json({ workflow: updated })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/workflows/:id/graph', auth, validate(graphRule), (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    const { nodes, edges } = req.body

    const graphJson = JSON.stringify({ nodes, edges })
    const now = new Date().toISOString()
    db.prepare(
      'UPDATE workflows SET graph_json = ?, updated_at = ? WHERE id = ?'
    ).run(graphJson, now, req.params.id)

    activityService.logEvent(workflow.workspace_id, req.user.id, 'workflow.updated', {
      type: 'workflow', id: workflow.id, name: workflow.name,
    }, { coalesceWindowMs: EDIT_COALESCE_MS })
    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/workflows/:id/flow { flow } — replace the workflow from its text
// form (services/workflowDsl).
//
// The canvas is for drawing and text is for surgery. Renaming twelve nodes,
// repointing five HTTP nodes at a new host, or reordering a switch's cases are
// all one find-and-replace in a text editor and twelve dialogs on a canvas —
// and the second is why people give up and do it in the database.
//
// It writes the **whole document**, not just the graph: the name, the
// description and the declared guarantees are all lines in the file, so editing
// one there has to mean what it says. That is the same reason `--name` is
// refused for a `.flow` import.
//
// Server-side, like a merge or a version restore, and for the same reason: the
// canvas reloads the result rather than trying to reconcile a second time on
// the client, so the collaboration layer sees one external change instead of a
// storm of synthetic edits.
router.put('/workflows/:id/flow', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return

    if (typeof req.body?.flow !== 'string') {
      return res.status(400).json({ error: 'flow must be a string of .flow source' })
    }

    let document
    try {
      document = parseWorkflow(req.body.flow)
    } catch (err) {
      if (err instanceof DslError) {
        // The position is the product: a text editor can put the cursor on it.
        return res.status(400).json({
          error: err.message,
          line: err.line,
          column: err.column,
          frame: err.frame,
        })
      }
      throw err
    }

    const name = (document.name || '').trim()
    if (!name || name.length > 200) {
      return res.status(400).json({ error: 'The workflow needs a name (max 200 chars)' })
    }
    const graphJson = JSON.stringify(document.graph_data)
    if (Buffer.byteLength(graphJson, 'utf8') > 500 * 1024) {
      return res.status(413).json({ error: 'Workflow graph is too large (max 500KB)' })
    }

    const guarantees = parseGuarantees(document.guarantees)
    const now = new Date().toISOString()
    db.prepare(
      `UPDATE workflows SET name = ?, description = ?, graph_json = ?, guarantees_json = ?, updated_at = ?
        WHERE id = ?`
    ).run(
      name, document.description ?? null, graphJson,
      guarantees.length ? JSON.stringify(guarantees) : null, now, req.params.id
    )

    activityService.logEvent(workflow.workspace_id, req.user.id, 'workflow.updated', {
      type: 'workflow', id: workflow.id, name,
    }, { coalesceWindowMs: EDIT_COALESCE_MS })

    res.json({ workflow: db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/workflows/:id', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    db.prepare('DELETE FROM workflows WHERE id = ?').run(req.params.id)
    // Stop any active cron schedule for this (now-gone) workflow.
    scheduler.unregisterSchedule(req.params.id)
    activityService.logEvent(workflow.workspace_id, req.user.id, 'workflow.deleted', {
      type: 'workflow', id: workflow.id, name: workflow.name,
    })
    // The audit entry outlives the workflow it names — target_name is captured
    // here precisely because the row it refers to is gone a line above.
    recordAudit(workflow.workspace_id, req.user.id, 'workflow.deleted', {
      type: 'workflow', id: workflow.id, name: workflow.name,
      metadata: { status: workflow.status },
    })
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/archive — take a workflow out of service: mark it
// archived and stop its schedule so it no longer fires. (Re-deploying reactivates.)
router.post('/workflows/:id/archive', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    const now = new Date().toISOString()
    db.prepare("UPDATE workflows SET status = 'archived', updated_at = ? WHERE id = ?")
      .run(now, req.params.id)
    scheduler.unregisterSchedule(req.params.id)

    const updated = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    res.json({ workflow: updated })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/pause — the operational kill switch: while paused,
// no new real run starts anywhere (manual, public API, webhook, schedule,
// error-handler escalation). In-flight runs settle normally — interrupting
// half-done work is cancellation's job — and dry runs stay allowed, because
// whoever paused the workflow is usually the person debugging it. Idempotent:
// pausing twice is safe and keeps the first pause's audit trail.
router.post('/workflows/:id/pause', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    res.json({ workflow: pauseWorkflow(workflow, req.user.id) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/resume — release the kill switch. Idempotent, like
// pause. Queued runs that were admitted before the pause proceed unchanged;
// nothing skipped while paused is retroactively fired (a schedule's next tick
// and a webhook's next delivery just work again).
router.post('/workflows/:id/resume', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    res.json({ workflow: resumeWorkflow(workflow, req.user.id) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/workflows/:id/dependencies — cross-workflow impact analysis: which
// workflows this one calls (sub-workflow / for-each nodes, error handler),
// which workflows call it, and whether it sits on a stale cross-workflow
// reference cycle. Read-only; any workspace member (viewers included) can see
// it. Answers "what breaks if I undeploy or delete this?" before you find out
// the hard way.
router.get('/workflows/:id/dependencies', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    res.json({ workflowId: workflow.id, ...computeDependencies(workflow) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/workflows/:id/cache — what the step cache currently holds for this
// workflow: live entry count, total hits, and the next expiry. Enough for the
// UI to say "3 entries, 12 hits" next to the clear button without exposing
// cached payloads (which may embed upstream data the viewer shouldn't see
// re-surfaced outside a run).
router.get('/workflows/:id/cache', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    const stats = db.prepare(
      `SELECT COUNT(*) AS entries, COALESCE(SUM(hits), 0) AS hits, MIN(expires_at) AS nextExpiry
         FROM step_cache WHERE workflow_id = ? AND expires_at > ?`
    ).get(req.params.id, new Date().toISOString())
    res.json({ cache: stats })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/workflows/:id/cache — drop every cached step result for the
// workflow. The manual override for "the upstream data changed even though
// the request looks identical": the next run re-executes everything and
// repopulates the cache with fresh outputs.
router.delete('/workflows/:id/cache', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    const cleared = stepCache.clearWorkflow(req.params.id)
    res.json({ cleared })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/lint — static analysis of a workflow graph. Lints
// the posted { nodes, edges } when the body carries them (the canvas's live,
// possibly not-yet-saved state), else the stored graph. Workspace context —
// secret names and sub-workflow targets — comes from the workflow's workspace,
// so {{secrets.*}} references and call targets are checked for real.
router.post('/workflows/:id/lint', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }

    let graph
    if (req.body && Array.isArray(req.body.nodes) && Array.isArray(req.body.edges)) {
      if (req.body.nodes.length > 2000 || req.body.edges.length > 5000) {
        return res.status(400).json({ error: 'Graph too large to lint' })
      }
      graph = { nodes: req.body.nodes, edges: req.body.edges }
    } else {
      graph = parseGraphData(workflow.graph_json)
    }

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

    // Policy findings ride the same panel: an author should see "this workflow
    // isn't allowed here" while editing, not when the deploy button refuses.
    // Judged against the graph on screen, like every other rule above.
    const issues = [
      ...lintGraph(graph, {
        secretNames,
        variableNames,
        workflowTargets,
        resolveWorkflow: graphResolver(workflow.workspace_id),
        // So the panel can say "these compensations will never run" while the
        // author is drawing them, rather than after the failure they exist for.
        rollbackPolicy: workflow.rollback_policy,
        // Declared path invariants, checked against the graph on screen — the
        // edit that breaks one should be reported while it is still an edit.
        guarantees: workflow.guarantees_json,
        // Declared redactions, so a rule that could never match is reported
        // while it is still an edit rather than after a run stored the value.
        redact: workflow.redact_json,
        // Who could actually settle an approval gate here, so a quorum larger
        // than the workspace is an error now rather than a run stuck behind an
        // unsatisfiable gate at 3am.
        approvers: approverCounts(workflow.workspace_id),
      }),
      ...policyIssues(workflow, { graphJson: JSON.stringify(graph) }),
    ]
    res.json({
      issues,
      summary: {
        errors: issues.filter((i) => i.severity === 'error').length,
        warnings: issues.filter((i) => i.severity === 'warning').length,
      },
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/types — the inferred data schema of every node in
// the graph: what each one receives and what it produces
// (services/typeInference.js).
//
// The same body contract as lint, for the same reason: the canvas asks about
// the graph on screen, which may not be saved yet. It is the *authoring*
// surface — the config panel's "insert data from upstream" list is built from
// `output.fields`, so what a user can pick is exactly what the node will
// actually have, rather than a guess assembled from the last recorded run.
//
// Read-only and pure: no run, no writes, nothing touched.
router.post('/workflows/:id/types', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }

    let graph
    if (req.body && Array.isArray(req.body.nodes) && Array.isArray(req.body.edges)) {
      if (req.body.nodes.length > 2000 || req.body.edges.length > 5000) {
        return res.status(400).json({ error: 'Graph too large to analyse' })
      }
      graph = { nodes: req.body.nodes, edges: req.body.edges }
    } else {
      graph = parseGraphData(workflow.graph_json)
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

// POST /api/workflows/:id/merge — three-way merge an exported document into
// this workflow's canvas.
//
// The same service the public API uses, so the two surfaces cannot disagree
// about what a merge means. The session route exists because the reconciliation
// is not always a CI job: someone who exported a workflow, changed it in git,
// and then also fixed something live wants to bring the two together without
// dropping to a terminal — and this is the surface where they can *see* the
// conflict against the graph it belongs to.
router.post('/workflows/:id/merge', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return

    const graphData = req.body?.graph_data
    if (graphData && Buffer.byteLength(JSON.stringify(graphData), 'utf8') > MAX_IMPORT_GRAPH_BYTES) {
      return res.status(413).json({ error: 'Workflow graph is too large (max 500KB)' })
    }

    const strategy = req.body?.strategy ?? 'manual'
    const merged = mergeDocument(workflow, graphData, {
      strategy,
      baseVersion: req.body?.baseVersion,
    })
    if (merged.error) return res.status(400).json({ error: merged.error })
    if (!req.body?.apply || !merged.graph) return res.json(merged.body)

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
    activityService.logEvent(workflow.workspace_id, req.user.id, 'workflow.updated', {
      type: 'workflow', id: workflow.id, name: workflow.name,
    })
    res.json({ ...merged.body, applied: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/effects — what a run of this graph can do to the
// outside world, and what has to be true first (services/effects.js).
//
// Same body contract as lint, types and lineage, for the same reason: the
// canvas asks about the graph on screen, not the one that was last saved. The
// question this answers is the one a security review opens with, and the one
// none of its neighbours does — the linter is about a node's config, lineage
// about where a value came from, guarantees about a property somebody thought
// to declare.
router.post('/workflows/:id/effects', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }

    let graph
    if (req.body && Array.isArray(req.body.nodes) && Array.isArray(req.body.edges)) {
      if (req.body.nodes.length > 2000 || req.body.edges.length > 5000) {
        return res.status(400).json({ error: 'Graph too large to analyse' })
      }
      graph = { nodes: req.body.nodes, edges: req.body.edges }
    } else {
      graph = parseGraphData(workflow.graph_json)
    }

    res.json({ workflowId: workflow.id, ...analyzeEffects(graph) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/contract — whose workflows does this change break?
// (services/contractCheck.js)
//
// The one analysis here whose findings are about *other people's* graphs, and
// the one place the body contract matters most: the author who breaks a
// contract is not the author who finds out, so the answer has to arrive while
// the edit is still on the canvas rather than after it is saved and somebody
// else's run fails.
//
// With no body it compares the saved graph with itself, which is compatible by
// construction — useful only as a way to read the current contract.
router.post('/workflows/:id/contract', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }

    let candidate = null
    if (req.body && Array.isArray(req.body.nodes) && Array.isArray(req.body.edges)) {
      if (req.body.nodes.length > 2000 || req.body.edges.length > 5000) {
        return res.status(400).json({ error: 'Graph too large to analyse' })
      }
      candidate = { nodes: req.body.nodes, edges: req.body.edges }
    }

    res.json(analyzeContract(workflow.id, candidate))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/workflows/:id/reach — what a run of this workflow can ultimately do,
// following every sub-workflow call (services/reach.js).
//
// A GET rather than the body-taking POST its neighbours use, and for a reason
// specific to this one: the answer depends on graphs *other* workflows hold, so
// judging the canvas on screen would mix an unsaved graph with saved callees
// and describe a system that does not exist.
router.get('/workflows/:id/reach', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    const resolve = subWorkflowGraphs(workflow.workspace_id)
    const root = resolve(workflow.id)
    if (!root) return res.json({ available: false, reason: 'empty', workflowId: workflow.id })
    res.json(reachableEffects(root, resolve))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/workflows/:id/repeats — what a repeat of this workflow's steps would
// do, and whether its recovery policy describes the graph (services/repeats.js).
//
// A GET for the reason the reach walk is one: it follows sub-workflow calls, so
// the answer depends on graphs *other* workflows hold, and judging an unsaved
// canvas against saved callees would describe a system that does not exist. The
// recovery policy it checks is a stored column too — a claim already made,
// rather than one on screen.
router.get('/workflows/:id/repeats', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    const resolve = subWorkflowGraphs(workflow.workspace_id)
    const root = resolve(workflow.id)
    if (!root) return res.json({ available: false, reason: 'empty', workflowId: workflow.id })
    res.json({
      ...analyzeRepeats(root, resolve, {
        recoveryPolicy: recoveryPolicyOf(workflow),
        maxAttempts: MAX_ATTEMPTS,
      }),
      name: workflow.name,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/convergence — where parallel branches collide, and
// which of those collisions the graph itself resolves (services/convergence.js).
//
// Same body contract as its neighbours, and the same reason: the canvas asks
// about the graph on screen. This one has a particular claim on being asked
// live, because the answer changes the moment somebody draws a connection —
// wiring a third branch into a join is exactly the edit that creates a
// collision, and the author is more likely to accept the finding while their
// hand is still on the mouse than in a lint report a week later.
router.post('/workflows/:id/convergence', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }

    let graph
    if (req.body && Array.isArray(req.body.nodes) && Array.isArray(req.body.edges)) {
      if (req.body.nodes.length > 2000 || req.body.edges.length > 5000) {
        return res.status(400).json({ error: 'Graph too large to analyse' })
      }
      graph = { nodes: req.body.nodes, edges: req.body.edges }
    } else {
      graph = parseGraphData(workflow.graph_json)
    }

    res.json({
      workflowId: workflow.id,
      ...analyzeConvergence(graph, { resolveWorkflow: graphResolver(workflow.workspace_id) }),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/lineage — where every value came from and where it
// ends up (services/lineage.js).
//
// Same body contract as lint and types, for the same reason: the canvas asks
// about the graph on screen. `?node=<id>` narrows it to one node's provenance
// (what feeds this) and impact (what breaks if this changes), which is what the
// panel opens with when someone clicks a node — the whole-graph view is a map,
// but the question is almost always about one node.
router.post('/workflows/:id/lineage', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }

    let graph
    if (req.body && Array.isArray(req.body.nodes) && Array.isArray(req.body.edges)) {
      if (req.body.nodes.length > 2000 || req.body.edges.length > 5000) {
        return res.status(400).json({ error: 'Graph too large to analyse' })
      }
      graph = { nodes: req.body.nodes, edges: req.body.edges }
    } else {
      graph = parseGraphData(workflow.graph_json)
    }

    const nodeId = req.query.node
    if (nodeId) {
      const lineage = analyzeLineage(graph)
      if (!lineage.ok) return res.json({ workflowId: workflow.id, ok: false, reason: lineage.reason })
      if (!lineage.nodes[nodeId]) return res.status(404).json({ error: 'Node not found in graph' })
      return res.json({
        workflowId: workflow.id,
        ok: true,
        provenance: traceProvenance(lineage, nodeId),
        impact: traceImpact(lineage, nodeId),
      })
    }

    res.json({ workflowId: workflow.id, ...describeLineage(graph) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ---------------------------------------------------------------------------
// Deploy preview (services/backtest.js)
// ---------------------------------------------------------------------------

// POST /api/workflows/:id/preview — what this change would have done to the
// runs that already happened.
//
// Same body contract as lint, types, lineage, guarantees and paths, and for a
// sharper version of the same reason: the graph on screen is the one about to
// be deployed, and comparing anything else would answer a question nobody
// asked.
//
// A write in one narrow sense — it executes graphs — so viewers are refused
// even though nothing survives the call. Every replay is a dry run against a
// graph the workflow does not hold, both of which the engine refuses outside
// dry-run mode, so no side effect can escape; and the replays' execution rows
// are deleted once their steps are read, because a preview is a question and a
// question should not leave fifty rows in run history.
router.post('/workflows/:id/preview', auth, async (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return

    let graph
    if (req.body && Array.isArray(req.body.nodes) && Array.isArray(req.body.edges)) {
      if (req.body.nodes.length > 500 || req.body.edges.length > 1000) {
        return res.status(400).json({ error: 'Graph too large to preview' })
      }
      graph = { nodes: req.body.nodes, edges: req.body.edges }
    } else {
      graph = parseGraphData(workflow.graph_json)
    }
    if (graph.nodes.length === 0) {
      return res.status(400).json({ error: 'Nothing to preview — the graph has no nodes' })
    }

    const report = await previewDeploy(workflow, graph, { runs: req.body?.runs })
    res.json({ workflowId: workflow.id, ...report })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ---------------------------------------------------------------------------
// Path feasibility (services/pathConstraints.js)
// ---------------------------------------------------------------------------

// POST /api/workflows/:id/paths — which branches an input can actually take,
// and what payload takes each one.
//
// Same body contract as lint, types, lineage and guarantees: the canvas asks
// about the graph on screen, because that is where a branch stops being
// reachable. The response is deliberately three things rather than a verdict —
// `branches` is the per-outcome answer with a witness, `findings` is the subset
// the linter also reports, and `scenarios` is the generated test suite the
// Tests panel can adopt in one click.
router.post('/workflows/:id/paths', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }

    let graph
    if (req.body && Array.isArray(req.body.nodes) && Array.isArray(req.body.edges)) {
      if (req.body.nodes.length > 2000 || req.body.edges.length > 5000) {
        return res.status(400).json({ error: 'Graph too large to analyse' })
      }
      graph = { nodes: req.body.nodes, edges: req.body.edges }
    } else {
      graph = parseGraphData(workflow.graph_json)
    }

    res.json({ workflowId: workflow.id, ...analyzePaths(graph) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ---------------------------------------------------------------------------
// Workflow guarantees (services/guarantees.js)
// ---------------------------------------------------------------------------

// POST /api/workflows/:id/guarantees — verify the workflow's declared path
// invariants against a graph. Same body contract as lint, types and lineage,
// for the same reason: the canvas asks about the graph on screen, which is
// where an invariant gets broken, not about the last saved one.
//
// The response carries three things and they answer three different questions:
// `results` is the verdict per declaration, `facts` is what is true of the
// graph regardless of what anyone declared (which nodes every run executes,
// where the decisions are), and `suggestions` are invariants that hold today
// and look deliberate — the ones worth pinning before an edit quietly removes
// them.
router.post('/workflows/:id/guarantees', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }

    let graph
    if (req.body && Array.isArray(req.body.nodes) && Array.isArray(req.body.edges)) {
      if (req.body.nodes.length > 2000 || req.body.edges.length > 5000) {
        return res.status(400).json({ error: 'Graph too large to verify' })
      }
      graph = { nodes: req.body.nodes, edges: req.body.edges }
    } else {
      graph = parseGraphData(workflow.graph_json)
    }

    // A caller may verify a *proposed* set of declarations without saving them —
    // which is what the panel does while somebody edits one, so an invariant is
    // never stored in a state where it already fails.
    const declared = Array.isArray(req.body?.guarantees)
      ? req.body.guarantees
      : workflow.guarantees_json

    res.json({ workflowId: workflow.id, ...verifyGuarantees(graph, declared) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/workflows/:id/guarantees — replace the declared invariants.
//
// A whole-list replace rather than add/remove endpoints: the list is short,
// the canvas edits it as a unit, and a partial update API for a set of
// assertions invites the failure where a client thinks it removed one and
// didn't. Malformed entries are dropped by parseGuarantees rather than
// rejected, and the stored list is echoed back — so a caller can see exactly
// what was kept instead of assuming.
//
// Audited, because "who removed the invariant that stopped this workflow
// charging cards without approval" is a question with a right answer.
router.put('/workflows/:id/guarantees', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    if (!Array.isArray(req.body?.guarantees)) {
      return res.status(400).json({ error: 'guarantees must be an array' })
    }

    const guarantees = parseGuarantees(req.body.guarantees)
    const before = parseGuarantees(workflow.guarantees_json)
    db.prepare('UPDATE workflows SET guarantees_json = ?, updated_at = ? WHERE id = ?')
      .run(guarantees.length ? JSON.stringify(guarantees) : null, new Date().toISOString(), req.params.id)

    if (before.length !== guarantees.length) {
      recordAudit(workflow.workspace_id, req.user.id, 'workflow.guarantees_changed', {
        type: 'workflow', id: workflow.id, name: workflow.name,
        metadata: { before: before.length, after: guarantees.length },
      })
    }

    const graph = parseGraphData(workflow.graph_json)
    res.json({ guarantees, ...verifyGuarantees(graph, guarantees) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ---------------------------------------------------------------------------
// Node test bench
// ---------------------------------------------------------------------------

// Node types that only make sense inside a full engine run.
const BENCH_UNSUPPORTED = {
  approval: 'Approval nodes wait on a human decision — run the workflow to test the gate',
  'sub-workflow': 'Sub-workflow nodes run a whole other workflow — use a test run instead',
  'for-each': 'For-each nodes fan a workflow out over a list — use a test run instead',
  'wait-callback':
    'Wait-for-callback nodes pause a real run until an external system calls back — use a test run instead',
  note: 'Notes are canvas annotations — they never execute',
}

// A bench run must not hang the HTTP request it rides on (e.g. a delay node
// configured for minutes). Read per call so tests can shrink it.
function benchTimeoutMs() {
  const n = parseInt(process.env.NODE_TEST_TIMEOUT_MS || '30000', 10)
  return Number.isFinite(n) && n >= 100 ? n : 30000
}

const raceTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Node test timed out after ${ms}ms`)), ms).unref?.()
    ),
  ])

// POST /api/workflows/:id/test-node — run a single node in isolation with a
// sample input, without creating an execution. The body carries the node as
// the canvas currently has it (possibly unsaved), an optional `input` object
// handed to the runner, and an optional `context` object that stands in for
// upstream outputs when resolving {{node-id.field}} templates. Dry-run by
// default — side-effecting runners report what they *would* have sent —
// `live: true` opts into firing the real call.
//
// This reuses the engine's own pipeline (runner lookup, workspace-secret
// loading, redaction), so a bench run behaves exactly like the node would in
// a real run — and secret values are scrubbed from the response the same way
// they are scrubbed from persisted step rows.
router.post('/workflows/:id/test-node', auth, async (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return

    const { node, input, context, live } = req.body || {}
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') {
      return res.status(400).json({ error: 'A node with a type is required' })
    }
    if (BENCH_UNSUPPORTED[node.type]) {
      return res.status(400).json({ error: BENCH_UNSUPPORTED[node.type] })
    }
    let runner
    try {
      runner = getRunner(node.type)
    } catch {
      return res.status(400).json({ error: `Unknown node type "${node.type}"` })
    }

    const benchInput = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
    const benchContext =
      context && typeof context === 'object' && !Array.isArray(context) ? context : {}

    const secrets = loadWorkspaceSecrets(workflow.workspace_id)
    const vars = loadWorkspaceVariables(workflow.workspace_id)
    const redact = buildRedactor(Object.values(secrets))
    const config = resolveTemplates(node.data?.config || {}, { ...benchContext, secrets, vars })

    const dryRun = live !== true
    const startedAt = Date.now()
    try {
      // Single attempt, no engine ctx: runners that reach back into the engine
      // are excluded above, and a bench run should surface the first failure,
      // not retry through it.
      const output = await raceTimeout(
        Promise.resolve(runner(config, benchInput, dryRun, {})),
        benchTimeoutMs()
      )
      res.json({
        status: 'succeeded',
        dryRun,
        durationMs: Date.now() - startedAt,
        output: redactDeep(output ?? {}, redact),
      })
    } catch (err) {
      // A failing node is a *successful bench run* with a failed verdict.
      res.json({
        status: 'failed',
        dryRun,
        durationMs: Date.now() - startedAt,
        error: redact(err.message),
      })
    }
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ---------------------------------------------------------------------------
// Status badges
// ---------------------------------------------------------------------------

// Constant-time equality that tolerates length mismatches (timingSafeEqual
// throws on unequal-length buffers).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

// Render a never-cached-wrong SVG badge. Split out so both the valid and the
// unknown paths share the response shape.
function sendBadge(res, status) {
  res.set('Content-Type', 'image/svg+xml; charset=utf-8')
  // Short cache so an embedded badge refreshes within a minute, but a CDN /
  // GitHub camo still absorbs bursts. no-transform stops proxies mangling it.
  res.set('Cache-Control', 'public, max-age=60, no-transform')
  res.send(statusBadgeSvg(status))
}

// GET /api/workflows/:id/badge.svg?token=… — PUBLIC (no session), guarded by
// the per-workflow badge token so status can be embedded in a README or
// dashboard. An invalid/missing token renders a neutral 'unknown' badge with
// 200 (never a broken image, and never a confirmation that the id exists);
// a valid token renders the latest real run's status. Rate-limited like the
// public webhook trigger, since it's an unauthenticated, oft-fetched asset.
router.get('/workflows/:id/badge.svg', webhookLimiter, (req, res) => {
  try {
    const workflow = db
      .prepare('SELECT id, badge_token FROM workflows WHERE id = ?')
      .get(req.params.id)
    const token = typeof req.query.token === 'string' ? req.query.token : ''
    if (!workflow || !workflow.badge_token || !safeEqual(token, workflow.badge_token)) {
      return sendBadge(res, 'unknown')
    }
    // Latest run that a person actually cares about — dry runs (test mode)
    // don't move the badge.
    const run = db
      .prepare(
        `SELECT status FROM executions
          WHERE workflow_id = ? AND (trigger_type IS NULL OR trigger_type != 'dry-run')
          ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(workflow.id)
    sendBadge(res, run ? run.status : 'none')
  } catch (err) {
    console.error(err)
    // Even on error, hand back a badge rather than a broken image.
    sendBadge(res, 'unknown')
  }
})

// POST /api/workflows/:id/badge-token — mint (or rotate) the workflow's badge
// token. Any workspace member can; returns the token so the client can build
// the embed URL. Rotating invalidates the previous badge URL immediately.
router.post('/workflows/:id/badge-token', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    const token = crypto.randomBytes(24).toString('base64url')
    db.prepare('UPDATE workflows SET badge_token = ? WHERE id = ?').run(token, workflow.id)
    res.status(201).json({ badgeToken: token })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/workflows/:id/badge-token — turn the badge off. The badge URL
// then renders 'unknown' for everyone.
router.delete('/workflows/:id/badge-token', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    db.prepare('UPDATE workflows SET badge_token = NULL WHERE id = ?').run(workflow.id)
    res.status(204).end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ---------------------------------------------------------------------------
// Version history & rollback
//
// A "deploy" snapshots the workflow's current graph into workflow_versions under
// a per-workflow incrementing version number. Snapshots are immutable. Restoring
// a version copies its graph back onto the live workflow, but first snapshots the
// current live state as a new version — so a rollback is itself reversible.
// ---------------------------------------------------------------------------

// Snapshot a workflow's current graph_json as its next version and return the new
// version row (with the deploying user's display name). Synchronous so it can run
// inside a better-sqlite3 transaction (restore wraps it with the live-graph update).
function snapshotVersion(workflow, userId) {
  const { max } = db.prepare(
    'SELECT MAX(version) AS max FROM workflow_versions WHERE workflow_id = ?'
  ).get(workflow.id)
  const version = (max || 0) + 1
  const id = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO workflow_versions (id, workflow_id, version, graph_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, workflow.id, version, workflow.graph_json, userId, now)
  return db.prepare(
    `SELECT v.id, v.version, v.created_at, v.created_by, u.display_name AS created_by_name
       FROM workflow_versions v
       LEFT JOIN users u ON u.id = v.created_by
      WHERE v.id = ?`
  ).get(id)
}

// POST /api/workflows/:id/deploy — snapshot the current graph as a new version,
// mark the workflow deployed, and (if it has a schedule trigger) activate its
// cron schedule. An invalid cron is rejected before anything is snapshotted.
router.post('/workflows/:id/deploy', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return

    // Validate the schedule's cron up front so deploy fails cleanly instead of
    // leaving a deployed-but-unschedulable workflow.
    const scheduleNode = findScheduleNode(workflow)
    const cronExpr = scheduleNode?.data?.config?.cron
    if (scheduleNode && !scheduler.validateCron(cronExpr)) {
      return res.status(400).json({
        error: `Invalid cron expression: ${cronExpr ? String(cronExpr) : '(empty)'}`,
      })
    }
    // Same for its time zone: a typo'd zone would quietly fall back to UTC at
    // registration, which is a schedule firing hours from where it was meant
    // to. Deploy is the last point at which a person is watching, so refuse it
    // here rather than logging it later.
    const scheduleZone = scheduleNode?.data?.config?.timezone
    if (scheduleNode && scheduleZone && !isValidTimeZone(String(scheduleZone))) {
      return res.status(400).json({
        error: `Unknown time zone: ${String(scheduleZone)}`,
      })
    }

    // Workspace policies: deploy is the moment a workflow becomes something the
    // organisation runs, so it is the moment "is this allowed here?" is asked.
    // A `deny` refuses with 422 and the violations — 422 rather than 403,
    // because the caller *is* permitted to deploy; the document is what is
    // unacceptable. Warnings pass through and are visible in the Issues panel.
    const policy = checkWorkflow(workflow)
    if (policy.blocked) {
      activityService.logEvent(workflow.workspace_id, req.user.id, 'workflow.deploy_blocked', {
        type: 'workflow', id: workflow.id, name: workflow.name,
        metadata: { policies: policy.violations.filter((v) => v.severity === 'deny').map((v) => v.name) },
      })
      return res.status(422).json({
        error: 'Deploy blocked by workspace policy',
        violations: policy.violations,
      })
    }

    // Declared path invariants. Checked here for a different reason than the
    // policy above: a policy is the organisation's rule about this workflow,
    // while a guarantee is the author's own statement about their design — so a
    // violated one is not a permission problem, it is a regression, and the
    // deploy is the last moment somebody is looking. Same 422 shape, because
    // the caller is again permitted to deploy and it is the document that is
    // unacceptable.
    //
    // A guarantee that can no longer be *checked* blocks too. The failure mode
    // it guards against is precisely the quiet one: delete the approval node,
    // and every invariant about it stops failing.
    const guaranteeReport = verifyGuarantees(
      parseGraphData(workflow.graph_json),
      workflow.guarantees_json
    )
    const broken = guaranteeReport.results.filter((r) => r.status !== 'holds')
    if (broken.length > 0) {
      activityService.logEvent(workflow.workspace_id, req.user.id, 'workflow.deploy_blocked', {
        type: 'workflow', id: workflow.id, name: workflow.name,
        metadata: { guarantees: broken.map((r) => r.statement) },
      })
      return res.status(422).json({
        error: 'Deploy blocked by a workflow guarantee',
        guarantees: broken,
      })
    }

    const now = new Date().toISOString()
    const version = db.transaction(() => {
      const v = snapshotVersion(workflow, req.user.id)
      db.prepare("UPDATE workflows SET status = 'deployed', updated_at = ? WHERE id = ?")
        .run(now, req.params.id)
      return v
    })()

    // Activate the schedule to match the just-deployed graph (or clear a stale
    // one if the schedule node was removed before redeploying).
    if (scheduleNode) {
      scheduler.registerSchedule(
        req.params.id,
        cronExpr,
        scheduler.scheduleTimeZone(scheduleNode.data?.config)
      )
    } else {
      scheduler.unregisterSchedule(req.params.id)
    }

    activityService.logEvent(workflow.workspace_id, req.user.id, 'workflow.deployed', {
      type: 'workflow', id: workflow.id, name: workflow.name,
      metadata: { version: version.version },
    })
    // What is live, and who made it live. The version number makes the entry
    // resolvable to an exact graph in workflow_versions.
    recordAudit(workflow.workspace_id, req.user.id, 'workflow.deployed', {
      type: 'workflow', id: workflow.id, name: workflow.name,
      metadata: { version: version.version },
    })

    res.status(201).json({ version })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/workflows/:id/versions — all versions for a workflow, newest first
router.get('/workflows/:id/versions', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    const versions = db.prepare(
      `SELECT v.id, v.version, v.created_at, v.created_by, u.display_name AS created_by_name
         FROM workflow_versions v
         LEFT JOIN users u ON u.id = v.created_by
        WHERE v.workflow_id = ?
        ORDER BY v.version DESC`
    ).all(req.params.id)
    res.json({ versions })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/workflows/:id/versions/:versionId — full graph for a specific version
router.get('/workflows/:id/versions/:versionId', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    const version = db.prepare(
      'SELECT * FROM workflow_versions WHERE id = ? AND workflow_id = ?'
    ).get(req.params.versionId, req.params.id)
    if (!version) return res.status(404).json({ error: 'Version not found' })
    res.json({ version: version.version, graph_data: JSON.parse(version.graph_json) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/versions/:versionId/restore — roll the live workflow
// back to a version, snapshotting the current state first so it stays reversible
router.post('/workflows/:id/versions/:versionId/restore', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    if (forbidViewer(res, workflow.workspace_id, req.user.id)) return
    const target = db.prepare(
      'SELECT * FROM workflow_versions WHERE id = ? AND workflow_id = ?'
    ).get(req.params.versionId, req.params.id)
    if (!target) return res.status(404).json({ error: 'Version not found' })

    // Restoring onto a *deployed* workflow publishes a graph without passing
    // the deploy gate, so the gate is applied here too. A draft restore is
    // unchecked — nothing is running, and refusing to load a definition you
    // need to fix would be exactly backwards.
    if (workflow.status === 'deployed') {
      const policy = checkWorkflow(workflow, { graphJson: target.graph_json })
      if (policy.blocked) {
        return res.status(422).json({
          error: 'Restore blocked by workspace policy',
          violations: policy.violations,
        })
      }
    }

    const now = new Date().toISOString()
    db.transaction(() => {
      // 1. preserve the current live graph as a new version (makes restore reversible)
      snapshotVersion(workflow, req.user.id)
      // 2. copy the target version's graph onto the live workflow
      db.prepare('UPDATE workflows SET graph_json = ?, updated_at = ? WHERE id = ?')
        .run(target.graph_json, now, req.params.id)
    })()
    // Same reason a merge does it: a restore replaces the graph wholesale, so a
    // live collaboration session is holding a document that is now historical.
    collabSession.invalidate(req.params.id)

    activityService.logEvent(workflow.workspace_id, req.user.id, 'workflow.restored', {
      type: 'workflow', id: workflow.id, name: workflow.name,
      metadata: { version: target.version },
    })
    recordAudit(workflow.workspace_id, req.user.id, 'workflow.version_restored', {
      type: 'workflow', id: workflow.id, name: workflow.name,
      metadata: { version: target.version },
    })

    const updated = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    res.json({ workflow: updated })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
