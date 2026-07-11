const express = require('express')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')
const { validate } = require('../middleware/validate')
const scheduler = require('../services/scheduler')
const activityService = require('../services/activityService')
const { lintGraph } = require('../services/workflowLinter')

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

    const id = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workflows (id, workspace_id, name, description, graph_json, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)"
    ).run(id, req.params.wsId, name, null, graphJson, req.user.id, now, now)

    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id)
    res.status(201).json({ workflow })
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
    res.json({
      exportVersion: '1.0',
      name: workflow.name,
      description: workflow.description,
      graph_data: parseGraphData(workflow.graph_json),
      exportedAt: new Date().toISOString(),
    })
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

router.put('/workflows/:id', auth, validate(workflowRule), (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    const { name, description } = req.body

    const concurrencyError = validateConcurrency(req.body)
    if (concurrencyError) return res.status(400).json({ error: concurrencyError })
    const maxConcurrent =
      'max_concurrent_runs' in req.body ? req.body.max_concurrent_runs : workflow.max_concurrent_runs
    const policy =
      'concurrency_policy' in req.body ? req.body.concurrency_policy : workflow.concurrency_policy

    const now = new Date().toISOString()
    db.prepare(
      'UPDATE workflows SET name = ?, description = ?, max_concurrent_runs = ?, concurrency_policy = ?, updated_at = ? WHERE id = ?'
    ).run(name, description ?? workflow.description, maxConcurrent, policy, now, req.params.id)

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

router.delete('/workflows/:id', auth, (req, res) => {
  try {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)
    if (!workflow || !isMember(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }
    db.prepare('DELETE FROM workflows WHERE id = ?').run(req.params.id)
    // Stop any active cron schedule for this (now-gone) workflow.
    scheduler.unregisterSchedule(req.params.id)
    activityService.logEvent(workflow.workspace_id, req.user.id, 'workflow.deleted', {
      type: 'workflow', id: workflow.id, name: workflow.name,
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
    const workflowTargets = new Map(
      db.prepare('SELECT id, name, status FROM workflows WHERE workspace_id = ?')
        .all(workflow.workspace_id)
        .map((r) => [r.id, { name: r.name, status: r.status }])
    )

    const issues = lintGraph(graph, { secretNames, workflowTargets })
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

    // Validate the schedule's cron up front so deploy fails cleanly instead of
    // leaving a deployed-but-unschedulable workflow.
    const scheduleNode = findScheduleNode(workflow)
    const cronExpr = scheduleNode?.data?.config?.cron
    if (scheduleNode && !scheduler.validateCron(cronExpr)) {
      return res.status(400).json({
        error: `Invalid cron expression: ${cronExpr ? String(cronExpr) : '(empty)'}`,
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
    if (scheduleNode) scheduler.registerSchedule(req.params.id, cronExpr)
    else scheduler.unregisterSchedule(req.params.id)

    activityService.logEvent(workflow.workspace_id, req.user.id, 'workflow.deployed', {
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
    const target = db.prepare(
      'SELECT * FROM workflow_versions WHERE id = ? AND workflow_id = ?'
    ).get(req.params.versionId, req.params.id)
    if (!target) return res.status(404).json({ error: 'Version not found' })

    const now = new Date().toISOString()
    db.transaction(() => {
      // 1. preserve the current live graph as a new version (makes restore reversible)
      snapshotVersion(workflow, req.user.id)
      // 2. copy the target version's graph onto the live workflow
      db.prepare('UPDATE workflows SET graph_json = ?, updated_at = ? WHERE id = ?')
        .run(target.graph_json, now, req.params.id)
    })()

    activityService.logEvent(workflow.workspace_id, req.user.id, 'workflow.restored', {
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
